/**
 * Backrunning Strategy
 *
 * Detects large pending swaps in the mempool or via MEV-Share events
 * and constructs backrun transactions that capture the price impact.
 *
 * ## How Backrunning Works
 *
 * 1. A large swap moves the price on a DEX pool (e.g., big WETH→USDC sell)
 * 2. The price impact creates a temporary mispricing vs other DEXes
 * 3. We immediately trade in the opposite direction to capture the reversion
 * 4. Profit = price impact captured minus gas costs minus MEV-Share refund
 *
 * ## Strategy Flow
 *
 * 1. Receive opportunity from MEV-Share event listener or mempool monitor
 * 2. Estimate the price impact of the target transaction
 * 3. Calculate profitability after gas + refund costs
 * 4. Build a backrun transaction (reverse swap on same or different DEX)
 * 5. Submit as MEV-Share backrun bundle (or standard Flashbots bundle)
 *
 * ## Integration
 *
 * This strategy is registered in the strategy factory as a special handler
 * for opportunities marked with `backrunTarget` metadata. It extends
 * BaseExecutionStrategy for gas management, MEV protection, and RBF retry.
 *
 * @see shared/core/src/mev-protection/mev-share-event-listener.ts
 * @see shared/core/src/mev-protection/backrun-bundle-builder.ts
 * @see Phase 2 Item #26: Backrunning strategy
 */

import { ethers } from 'ethers';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import { getErrorMessage } from '@arbitrage/core/resilience';
import { generateTraceId } from '@arbitrage/core/tracing';
import { BaseExecutionStrategy, getSwapDeadline } from './base.strategy';
import type {
  ExecutionResult,
  StrategyContext,
  Logger,
} from '../types';

// =============================================================================
// Types
// =============================================================================

/**
 * Metadata for a backrun target (attached to the opportunity).
 */
export interface BackrunTarget {
  /** Target transaction hash to backrun */
  txHash: string;
  /** Target DEX router address */
  routerAddress: string;
  /** Estimated swap size in token units */
  estimatedSwapSize?: string;
  /** Direction of target swap: 'buy' or 'sell' */
  swapDirection: 'buy' | 'sell';
  /** Target pool address (if known) */
  poolAddress?: string;
  /** Source: 'mev-share' | 'mempool' | 'block-event' */
  source: string;
  /** Fix #42: Trace ID propagated from MEV-Share event listener */
  traceId?: string;
}

/**
 * Configuration for the backrunning strategy.
 */
export interface BackrunStrategyConfig {
  /** Minimum expected profit in USD to attempt backrun (default: 0.50) */
  minProfitUsd?: number;
  /** Maximum gas price in gwei for backrun attempts (default: 80) */
  maxGasPriceGwei?: number;
  /** Maximum age of backrun opportunity in ms (default: 2000) */
  maxOpportunityAgeMs?: number;
  /** Slippage tolerance for backrun swap in basis points (default: 100 = 1%) */
  slippageBps?: number;
  /** Whether to use MEV-Share backrun bundles (default: true) */
  useMevShareBundles?: boolean;
  /** Percentage of MEV-Share reward retained by the searcher (default: 90, i.e., 10% refunded to user) */
  mevShareRefundPercent?: number;
}

// Fix #8: Removed dead SWAP_ROUTER_ABI constant.
// buildBackrunTransaction() calls this.getRouterContract() from BaseExecutionStrategy
// which uses UNISWAP_V2_ROUTER_ABI defined in base.strategy.ts.
// The local ABI was never referenced and is dead code.
// NOTE: Current router ABI is V2-only (swapExactTokensForTokens). V3 routers
// use different function signatures (exactInputSingle, multicall) and would
// need a separate code path if V3 backrunning is added.

// =============================================================================
// Strategy Implementation
// =============================================================================

/**
 * Backrunning execution strategy.
 *
 * Captures price impact from large pending swaps by executing a
 * reverse trade immediately after the target transaction.
 */
export class BackrunStrategy extends BaseExecutionStrategy {
  /**
   * P0 Fix #38: MEV-Share backrunning is only supported on Ethereum.
   * On other chains, there is no Flashbots relay, and submissions would
   * go to the public mempool, exposing trades to sandwich attacks.
   */
  private static readonly BACKRUN_SUPPORTED_CHAINS = new Set(['ethereum']);

  private readonly backrunConfig: Required<
    Pick<
      BackrunStrategyConfig,
      'minProfitUsd' | 'maxGasPriceGwei' | 'maxOpportunityAgeMs' |
      'slippageBps' | 'useMevShareBundles' | 'mevShareRefundPercent'
    >
  >;

  /** Strategy metrics */
  private metrics = {
    backrunsAttempted: 0,
    backrunsSucceeded: 0,
    backrunsFailed: 0,
    backrunsSkipped: 0,
    totalProfitUsd: 0,
  };

  constructor(logger: Logger, config?: BackrunStrategyConfig) {
    super(logger);
    this.backrunConfig = {
      minProfitUsd: config?.minProfitUsd ?? 0.50,
      maxGasPriceGwei: config?.maxGasPriceGwei ?? 80,
      maxOpportunityAgeMs: config?.maxOpportunityAgeMs ?? 2000,
      slippageBps: config?.slippageBps ?? 100,
      useMevShareBundles: config?.useMevShareBundles ?? true,
      mevShareRefundPercent: config?.mevShareRefundPercent ?? 90,
    };
  }

  /**
   * Execute a backrun opportunity.
   *
   * The opportunity must include `backrunTarget` metadata identifying
   * the target transaction and its characteristics.
   */
  async execute(
    opportunity: ArbitrageOpportunity,
    ctx: StrategyContext
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    const chain = opportunity.chain ?? 'ethereum';

    // Fix #42: Include traceId from backrun target for correlation
    const traceId = opportunity.backrunTarget?.traceId ?? generateTraceId();

    // Fix #64: Downgrade to debug — this fires on every opportunity evaluation, creating log noise
    this.logger.debug('Backrun strategy: evaluating opportunity', {
      opportunityId: opportunity.id,
      chain,
      expectedProfit: opportunity.expectedProfit,
      traceId,
    });

    // P0 Fix #38: Backrun only supported on Ethereum (MEV-Share is Ethereum-only)
    if (!BackrunStrategy.BACKRUN_SUPPORTED_CHAINS.has(chain)) {
      this.logger.debug('Backrun skipped: unsupported chain', { opportunityId: opportunity.id, chain });
      return this.createFailureResult(
        opportunity,
        startTime,
        `Backrun strategy only supported on Ethereum, got '${chain}'`
      );
    }

    // Validate chain (base strategy check for execution support)
    this.validateChain(chain, opportunity.id);

    // Validate context
    const contextCheck = this.validateContext(chain, ctx);
    if (!contextCheck.valid) {
      return this.createFailureResult(opportunity, startTime, contextCheck.error);
    }

    const { wallet, provider } = contextCheck;

    this.metrics.backrunsAttempted++;

    // Extract backrun target metadata
    const target = this.extractBackrunTarget(opportunity);
    if (!target) {
      this.metrics.backrunsSkipped++;
      this.logger.debug('Backrun skipped: no target data', { opportunityId: opportunity.id });
      return this.createFailureResult(
        opportunity,
        startTime,
        'No backrun target data found in opportunity'
      );
    }

    // Check opportunity age (backruns are very time-sensitive)
    const age = Date.now() - opportunity.timestamp;
    if (age > this.backrunConfig.maxOpportunityAgeMs) {
      this.metrics.backrunsSkipped++;
      this.logger.debug('Backrun skipped: opportunity too old', { opportunityId: opportunity.id, ageMs: age, maxMs: this.backrunConfig.maxOpportunityAgeMs });
      return this.createFailureResult(
        opportunity,
        startTime,
        `Backrun opportunity too old: ${age}ms > ${this.backrunConfig.maxOpportunityAgeMs}ms`
      );
    }

    // Check profitability
    const expectedProfit = opportunity.expectedProfit ?? 0;
    if (expectedProfit < this.backrunConfig.minProfitUsd) {
      this.metrics.backrunsSkipped++;
      this.logger.debug('Backrun skipped: profit below minimum', { opportunityId: opportunity.id, expectedProfit, minProfitUsd: this.backrunConfig.minProfitUsd });
      return this.createFailureResult(
        opportunity,
        startTime,
        `Profit ${expectedProfit} below min ${this.backrunConfig.minProfitUsd}`
      );
    }

    // Check gas price
    const gasPrice = await this.getOptimalGasPrice(chain, ctx);
    // Fix #31: Use floating-point division to avoid BigInt truncation.
    // Integer division truncated 80.9 gwei to 80, passing an 80 gwei check.
    const gasPriceGwei = Number(gasPrice) / 1_000_000_000;
    if (gasPriceGwei > this.backrunConfig.maxGasPriceGwei) {
      this.metrics.backrunsSkipped++;
      this.logger.debug('Backrun skipped: gas price too high', { opportunityId: opportunity.id, gasPriceGwei, maxGasPriceGwei: this.backrunConfig.maxGasPriceGwei });
      return this.createFailureResult(
        opportunity,
        startTime,
        `Gas price ${gasPriceGwei} gwei exceeds max ${this.backrunConfig.maxGasPriceGwei} gwei`
      );
    }

    try {
      // Build the backrun swap transaction
      const backrunTx = await this.buildBackrunTransaction(
        opportunity,
        target,
        chain,
        provider,
        wallet
      );

      if (!backrunTx) {
        this.metrics.backrunsFailed++;
        return this.createFailureResult(
          opportunity,
          startTime,
          'Failed to build backrun transaction'
        );
      }

      // Apply MEV protection
      const protectedTx = await this.applyMEVProtection(backrunTx, chain, ctx);

      // Hybrid mode support
      if (this.isHybridMode()) {
        const hybridResult = await this.createHybridModeResult(
          protectedTx,
          chain,
          {
            opportunityId: opportunity.id,
            expectedProfit,
            initialGasPrice: gasPrice,
          }
        );

        if (hybridResult.success) {
          this.metrics.backrunsSucceeded++;
          // Fix #5: Deduct MEV-Share refund share from profit metrics.
          // Searcher retains mevShareRefundPercent% of profit.
          this.metrics.totalProfitUsd += expectedProfit * (this.backrunConfig.mevShareRefundPercent / 100);
        } else {
          this.metrics.backrunsFailed++;
        }

        return this.createResultFromSubmission(
          opportunity,
          startTime,
          hybridResult,
          chain
        );
      }

      // Submit the backrun transaction
      const submission = await this.submitTransaction(
        protectedTx,
        chain,
        ctx,
        {
          opportunityId: opportunity.id,
          expectedProfit,
          initialGasPrice: gasPrice,
        }
      );

      if (submission.success) {
        this.metrics.backrunsSucceeded++;
        // Fix #5: Deduct MEV-Share refund share from profit metrics.
        // Searcher retains mevShareRefundPercent% of profit.
        this.metrics.totalProfitUsd += expectedProfit * (this.backrunConfig.mevShareRefundPercent / 100);

        this.logger.info('Backrun succeeded', {
          opportunityId: opportunity.id,
          txHash: submission.txHash,
          targetTxHash: target.txHash,
          profit: expectedProfit,
          source: target.source,
          traceId,
        });
      } else {
        this.metrics.backrunsFailed++;

        this.logger.warn('Backrun failed', {
          opportunityId: opportunity.id,
          targetTxHash: target.txHash,
          error: submission.error,
          traceId,
        });
      }

      return this.createResultFromSubmission(
        opportunity,
        startTime,
        submission,
        chain
      );
    } catch (error) {
      this.metrics.backrunsFailed++;
      const errorMessage = getErrorMessage(error);

      this.logger.error('Backrun execution error', {
        opportunityId: opportunity.id,
        targetTxHash: target.txHash,
        error: errorMessage,
        traceId,
      });

      return this.createFailureResult(opportunity, startTime, errorMessage);
    }
  }

  /**
   * Build a backrun swap transaction.
   *
   * The backrun trades in the opposite direction of the target swap
   * to capture the price impact reversal.
   *
   * If the target was a large sell (tokenA → tokenB), we buy tokenA
   * with tokenB on the same or different DEX at the discounted price.
   */
  private async buildBackrunTransaction(
    opportunity: ArbitrageOpportunity,
    target: BackrunTarget,
    chain: string,
    provider: ethers.JsonRpcProvider,
    wallet: ethers.Wallet
  ): Promise<ethers.TransactionRequest | null> {
    if (!opportunity.tokenIn || !opportunity.tokenOut || !opportunity.amountIn) {
      this.logger.warn('Backrun: missing token/amount fields', {
        opportunityId: opportunity.id,
      });
      return null;
    }

    // Use the opportunity's buy DEX router, or fall back to target's router.
    // Fix H-2: The target.routerAddress fallback is validated via dexLookup to
    // ensure it's a known DEX router. Unvalidated router addresses from backrun
    // targets could drain token approvals if attacker-controlled.
    const dexName = opportunity.buyDex ?? opportunity.sellDex;
    let routerAddress: string | undefined;
    if (dexName) {
      routerAddress = this.dexLookup.getDexByName(chain, dexName)?.routerAddress;
    } else if (target.routerAddress) {
      // Validate target router is a known DEX router before using it
      const knownDex = this.dexLookup.findDexByRouter(chain, target.routerAddress);
      if (knownDex) {
        routerAddress = knownDex.routerAddress;
      } else {
        this.logger.warn('Backrun: target router not in known DEX registry, rejecting', {
          chain,
          targetRouter: target.routerAddress,
          opportunityId: opportunity.id,
        });
        return null;
      }
    }

    if (!routerAddress) {
      this.logger.warn('Backrun: no router address found', {
        chain,
        dexName,
        targetRouter: target.routerAddress,
      });
      return null;
    }

    const amountIn = BigInt(opportunity.amountIn);

    // Calculate minimum output with slippage tolerance
    const slippageBps = BigInt(this.backrunConfig.slippageBps);

    // Get expected output via router
    const routerContract = this.getRouterContract(routerAddress, provider, chain);
    const path = [opportunity.tokenIn, opportunity.tokenOut];

    let expectedAmountOut: bigint;
    try {
      const amounts: bigint[] = await routerContract.getAmountsOut(amountIn, path);
      expectedAmountOut = amounts[amounts.length - 1];
    } catch {
      // P0 Fix #6: Abort backrun when getAmountsOut fails instead of using a nonsensical
      // USD-to-wei conversion that produces impossible minAmountOut values.
      this.logger.warn('Backrun: getAmountsOut RPC failed, aborting backrun', {
        opportunityId: opportunity.id,
        router: routerAddress,
      });
      return null;
    }

    const minAmountOut = expectedAmountOut - (expectedAmountOut * slippageBps / 10000n);
    const deadline = getSwapDeadline();
    const walletAddress = await this.getWalletAddress(wallet);

    // Build the swap transaction
    const tx = await routerContract.swapExactTokensForTokens.populateTransaction(
      amountIn,
      minAmountOut,
      path,
      walletAddress,
      deadline
    );

    this.logger.debug('Built backrun transaction', {
      opportunityId: opportunity.id,
      router: routerAddress,
      amountIn: amountIn.toString(),
      minAmountOut: minAmountOut.toString(),
      path,
      targetTxHash: target.txHash,
    });

    return tx;
  }

  /**
   * Extract backrun target metadata from an opportunity.
   *
   * P0 Fix #2: Reads from the typed `backrunTarget` field on ArbitrageOpportunity
   * instead of casting to an extended type.
   */
  private extractBackrunTarget(opportunity: ArbitrageOpportunity): BackrunTarget | null {
    if (opportunity.backrunTarget) {
      return opportunity.backrunTarget;
    }

    return null;
  }

  /**
   * Fix #29: Delegate to base class createBaseResultFromSubmission with
   * MEV-Share profitMultiplier (searcher retains mevShareRefundPercent%).
   */
  private createResultFromSubmission(
    opportunity: ArbitrageOpportunity,
    startTime: number,
    submission: {
      success: boolean;
      receipt?: ethers.TransactionReceipt;
      txHash?: string;
      error?: string;
      nonce?: number;
      usedMevProtection?: boolean;
    },
    chain: string
  ): ExecutionResult {
    return this.createBaseResultFromSubmission(
      opportunity,
      startTime,
      submission,
      chain,
      { profitMultiplier: this.backrunConfig.mevShareRefundPercent / 100 }
    );
  }

  /**
   * Fix #29: Delegate to base class createBaseFailureResult.
   */
  private createFailureResult(
    opportunity: ArbitrageOpportunity,
    startTime: number,
    error: string
  ): ExecutionResult {
    return this.createBaseFailureResult(opportunity, startTime, error);
  }

  /**
   * Get backrun strategy metrics.
   */
  getBackrunMetrics(): typeof this.metrics {
    return { ...this.metrics };
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a backrunning strategy.
 */
export function createBackrunStrategy(
  logger: Logger,
  config?: BackrunStrategyConfig
): BackrunStrategy {
  return new BackrunStrategy(logger, config);
}
