/**
 * Batch Quote Manager
 *
 * Extracted from flash-loan.strategy.ts as part of Finding #7 refactoring
 * to reduce file size. Handles batched quoting for flash loan profitability:
 * - BatchQuoterService lifecycle management (caching per chain)
 * - Batched profit calculation with sequential fallback
 * - Quote request building from opportunities (2-hop and N-hop)
 *
 * Performance Note (Constraint Compliance):
 * - calculateExpectedProfitWithBatching is WARM path (pre-execution, not per-event)
 * - getBatchQuoterService uses single Map.get() for O(1) cache lookup
 * - buildQuoteRequestsFromOpportunity is synchronous, no allocations in loops
 *
 * @see flash-loan.strategy.ts (consumer)
 * @see Finding #7 in services-deep-analysis.md
 * @see ADR-029 for batched quoting architecture
 */

import {
  getErrorMessage,
} from '@arbitrage/core';
import {
  FEATURE_FLAGS,
  hasMultiPathQuoter,
  getAaveV3FeeBpsBigInt,
} from '@arbitrage/config';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type { StrategyContext, Logger, NHopArbitrageOpportunity } from '../types';
import { isNHopOpportunity } from '../types';
import {
  createBatchQuoterForChain,
  type BatchQuoterService,
  type QuoteRequest,
} from '../services/simulation/batch-quoter.service';

// =============================================================================
// Types
// =============================================================================

/** Interface for DEX router address resolution */
export interface DexLookup {
  getRouterAddress(chain: string, dex: string): string | undefined;
}

/**
 * Dependencies for BatchQuoteManager.
 *
 * Design: Uses constructor injection matching the existing extraction pattern.
 * - Direct references for immutable objects (logger, dexLookup)
 * - Callbacks for parent strategy methods
 */
export interface BatchQuoteManagerDeps {
  /** Logger instance */
  logger: Logger;
  /** DEX router address resolver */
  dexLookup: DexLookup;
  /** Calculate flash loan fee for a given amount and chain */
  calculateFlashLoanFee: (amount: bigint, chain: string) => bigint;
  /** Fallback: sequential on-chain profit calculation */
  calculateExpectedProfitOnChain: (
    opportunity: ArbitrageOpportunity,
    chain: string,
    ctx: StrategyContext,
  ) => Promise<{ expectedProfit: bigint; flashLoanFee: bigint } | null>;
}

// =============================================================================
// BatchQuoteManager
// =============================================================================

/**
 * Manages batched quoting for flash loan profitability analysis.
 *
 * Responsibilities:
 * 1. Cache BatchQuoterService instances per chain
 * 2. Calculate expected profit using batched or sequential quoting
 * 3. Build quote requests from opportunity swap paths
 *
 * Hot-path note:
 * - Not on the critical detection path
 * - Called during pre-execution profitability analysis (WARM path)
 * - getBatchQuoterService uses O(1) Map lookup for cached instances
 */
export class BatchQuoteManager {
  private readonly logger: Logger;
  private readonly dexLookup: DexLookup;
  private readonly calculateFlashLoanFee: BatchQuoteManagerDeps['calculateFlashLoanFee'];
  private readonly calculateExpectedProfitOnChain: BatchQuoteManagerDeps['calculateExpectedProfitOnChain'];

  /** Cache BatchQuoterService instances per chain (O(1) lookup) */
  private readonly batchedQuoters: Map<string, BatchQuoterService>;

  constructor(deps: BatchQuoteManagerDeps, batchedQuoters: Map<string, BatchQuoterService>) {
    this.logger = deps.logger;
    this.dexLookup = deps.dexLookup;
    this.calculateFlashLoanFee = deps.calculateFlashLoanFee;
    this.calculateExpectedProfitOnChain = deps.calculateExpectedProfitOnChain;
    this.batchedQuoters = batchedQuoters;
  }

  /**
   * Calculate expected profit using BatchQuoterService if available and enabled.
   *
   * Falls back to existing calculateExpectedProfitOnChain() if:
   * - Feature flag disabled
   * - BatchQuoterService not available for chain
   * - BatchQuoterService call fails
   *
   * Performance comparison:
   * - Batched: ~30-50ms (single RPC call for entire path)
   * - Fallback: ~100-200ms (N sequential RPC calls)
   *
   * @param opportunity - Arbitrage opportunity
   * @param chain - Chain identifier
   * @param ctx - Strategy context
   * @returns Object with expectedProfit and flashLoanFee (both in wei), or null if
   *          both batched and fallback methods fail
   *
   * @see ADR-029 for architecture and rollout strategy
   */
  async calculateExpectedProfitWithBatching(
    opportunity: ArbitrageOpportunity,
    chain: string,
    ctx: StrategyContext
  ): Promise<{ expectedProfit: bigint; flashLoanFee: bigint } | null> {
    // Check feature flag - if disabled, use existing sequential path
    if (!FEATURE_FLAGS.useBatchedQuoter) {
      return await this.calculateExpectedProfitOnChain(opportunity, chain, ctx);
    }

    // Get or create BatchQuoterService for this chain
    const batchQuoter = this.getBatchQuoterService(chain, ctx);
    if (!batchQuoter) {
      // Batched quoting not available (contract not deployed or provider missing)
      return await this.calculateExpectedProfitOnChain(opportunity, chain, ctx);
    }

    try {
      // Build quote requests from opportunity
      const requests = this.buildQuoteRequestsFromOpportunity(opportunity, chain);

      // Use batched simulation
      const result = await batchQuoter.simulateArbitragePath(
        requests,
        BigInt(opportunity.amountIn!),
        Number(getAaveV3FeeBpsBigInt()) // Convert bigint to number for service
      );

      if (!result.allSuccess) {
        this.logger.warn('Batched simulation failed, using fallback', {
          opportunityId: opportunity.id,
          chain,
        });
        return await this.calculateExpectedProfitOnChain(opportunity, chain, ctx);
      }

      // Calculate flash loan fee same way as existing code
      const flashLoanFee = this.calculateFlashLoanFee(BigInt(opportunity.amountIn!), chain);

      this.logger.debug('Batched quote simulation succeeded', {
        opportunityId: opportunity.id,
        chain,
        expectedProfit: result.expectedProfit.toString(),
        latencyMs: result.latencyMs,
      });

      return {
        expectedProfit: result.expectedProfit,
        flashLoanFee,
      };
    } catch (error) {
      this.logger.warn('BatchQuoter error, using fallback', {
        opportunityId: opportunity.id,
        chain,
        error: getErrorMessage(error),
      });
      // Fallback to sequential
      return await this.calculateExpectedProfitOnChain(opportunity, chain, ctx);
    }
  }

  /**
   * Get or create a BatchQuoterService for a specific chain.
   *
   * Uses double-checked pattern to prevent race conditions where multiple
   * concurrent calls could create duplicate quoter instances.
   *
   * Performance notes:
   * - Single Map.get() lookup (not .has() then .get())
   * - Fast path returns immediately if cached
   * - Slow path creates once, subsequent calls use cached instance
   *
   * Returns undefined if:
   * - Provider not available for chain
   * - MultiPathQuoter contract not deployed on chain
   * - Contract deployed but batching disabled
   *
   * @param chain - Chain identifier
   * @param ctx - Strategy context
   * @returns BatchQuoterService instance or undefined
   */
  getBatchQuoterService(
    chain: string,
    ctx: StrategyContext
  ): BatchQuoterService | undefined {
    // Fast path: Check cache with single lookup (Perf 10.2 optimization)
    // Use .get() instead of .has()/.get() to avoid double hash lookup
    let quoter = this.batchedQuoters.get(chain);
    if (quoter) {
      return quoter;
    }

    // Slow path: Create new quoter (with race condition protection)
    // Node.js is single-threaded for sync code, but async operations can
    // interleave. Double-check after async operations complete.

    // Get provider for chain
    const provider = ctx.providers.get(chain);
    if (!provider) {
      return undefined;
    }

    // Check if MultiPathQuoter deployed for this chain
    if (!hasMultiPathQuoter(chain)) {
      return undefined;
    }

    // Double-check: Another call might have created quoter while we were checking
    quoter = this.batchedQuoters.get(chain);
    if (quoter) {
      return quoter;
    }

    // Create service (will auto-resolve address from registry)
    quoter = createBatchQuoterForChain(
      provider as import('ethers').JsonRpcProvider,
      chain,
      { logger: this.logger }
    );

    // Only cache if batching is actually enabled (contract deployed and valid)
    if (quoter.isBatchingEnabled()) {
      this.batchedQuoters.set(chain, quoter);
      this.logger.info('Batched quoting enabled for chain', { chain });
      return quoter;
    }

    // Contract exists but batching not enabled (shouldn't happen, but defensive)
    return undefined;
  }

  /**
   * Build quote requests from arbitrage opportunity.
   * Converts opportunity swap path into QuoteRequest[] format for BatchQuoterService.
   *
   * Supports both:
   * - Standard 2-hop paths (buy → sell)
   * - N-hop paths (triangular+ arbitrage) via NHopArbitrageOpportunity
   *
   * @param opportunity - Arbitrage opportunity (standard or N-hop)
   * @param chain - Chain identifier
   * @returns Array of quote requests
   */
  buildQuoteRequestsFromOpportunity(
    opportunity: ArbitrageOpportunity,
    chain: string
  ): QuoteRequest[] {
    // Check if N-hop opportunity (triangular+ arbitrage)
    if (isNHopOpportunity(opportunity)) {
      // Build requests from hop array
      const requests: QuoteRequest[] = [];
      let currentTokenIn = opportunity.tokenIn!;

      for (let i = 0; i < opportunity.hops.length; i++) {
        const hop = opportunity.hops[i];

        // Resolve router: use hop.router if provided, else resolve from hop.dex
        let router: string | undefined;
        if (hop.router) {
          router = hop.router;
        } else if (hop.dex) {
          router = this.dexLookup.getRouterAddress(chain, hop.dex);
        }

        if (!router) {
          throw new Error(
            `No router found for hop ${i} on chain: ${chain}. ` +
            `Hop dex: ${hop.dex || 'undefined'}, router: ${hop.router || 'undefined'}`
          );
        }

        requests.push({
          router,
          tokenIn: currentTokenIn,
          tokenOut: hop.tokenOut,
          // First hop uses opportunity.amountIn, subsequent hops chain from previous
          amountIn: i === 0 ? BigInt(opportunity.amountIn!) : 0n,
        });

        // Next hop's input is this hop's output
        currentTokenIn = hop.tokenOut;
      }

      // Validate: Path must end with starting token (flash loan requirement)
      const lastToken = requests[requests.length - 1]?.tokenOut;
      if (lastToken?.toLowerCase() !== opportunity.tokenIn!.toLowerCase()) {
        throw new Error(
          `N-hop path must end with starting token. ` +
          `Expected ${opportunity.tokenIn}, got ${lastToken}`
        );
      }

      return requests;
    }

    // Standard 2-hop path (buy → sell)
    const dexForSell = opportunity.sellDex || opportunity.buyDex;
    const buyRouter = opportunity.buyDex ? this.dexLookup.getRouterAddress(chain, opportunity.buyDex) : undefined;
    const sellRouter = dexForSell ? this.dexLookup.getRouterAddress(chain, dexForSell) : undefined;

    if (!buyRouter) {
      throw new Error(
        `No router found for buyDex '${opportunity.buyDex}' on chain: ${chain}`
      );
    }

    if (!sellRouter) {
      throw new Error(
        `No router found for sellDex '${dexForSell}' on chain: ${chain}`
      );
    }

    // Build 2-hop path: tokenIn → tokenOut → tokenIn
    return [
      {
        router: buyRouter,
        tokenIn: opportunity.tokenIn!,
        tokenOut: opportunity.tokenOut!,
        amountIn: BigInt(opportunity.amountIn!),
      },
      {
        router: sellRouter,
        tokenIn: opportunity.tokenOut!,
        tokenOut: opportunity.tokenIn!,
        amountIn: 0n, // Chain from previous output
      },
    ];
  }
}
