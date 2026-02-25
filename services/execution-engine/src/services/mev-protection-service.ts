/**
 * MEV Protection Service
 *
 * Provides MEV (Maximal Extractable Value) protection for arbitrage transactions.
 * Extracted from base.strategy.ts as part of R4 refactoring.
 *
 * Features:
 * - MEV eligibility checking based on chain, profit threshold, and provider availability
 * - EIP-1559 transaction formatting with priority fee capping
 * - Flashbots-style private transaction support
 *
 * @see base.strategy.ts (consumer)
 * @see REFACTORING_ROADMAP.md R4
 */

import { ethers } from 'ethers';
import { MEV_CONFIG } from '@arbitrage/config';
import type { MevProviderFactory } from '@arbitrage/core/mev-protection';
import { getErrorMessage } from '@arbitrage/core/resilience';
import type { Logger, StrategyContext } from '../types';
import { GasPriceOptimizer, type GasBaselineEntry } from './gas-price-optimizer';

// =============================================================================
// Types
// =============================================================================

/**
 * Result of MEV eligibility check.
 */
export interface MevEligibilityResult {
  /** Whether MEV protection should be used */
  shouldUseMev: boolean;
  /** MEV provider instance if eligible */
  mevProvider?: ReturnType<MevProviderFactory['getProvider']>;
  /** Chain-specific MEV settings */
  chainSettings?: typeof MEV_CONFIG.chainSettings[string];
}

/**
 * Phase 4: Result of MEV fallback chain request.
 * Returns ordered list of providers to try for MEV protection.
 */
export interface MevFallbackChainResult {
  /** Whether any MEV protection is available */
  hasProtection: boolean;
  /** Ordered list of MEV providers to try (primary first, then fallbacks) */
  providers: ReturnType<MevProviderFactory['getProvider']>[];
  /** Chain-specific MEV settings */
  chainSettings?: typeof MEV_CONFIG.chainSettings[string];
}

/**
 * Configuration for the MevProtectionService.
 */
export interface MevProtectionServiceConfig {
  /** Maximum priority fee in gwei (default: 3 gwei) */
  maxPriorityFeeGwei?: number;
}

// =============================================================================
// MevProtectionService Class
// =============================================================================

/**
 * MevProtectionService - Handles MEV protection for arbitrage transactions.
 *
 * This service encapsulates all MEV protection logic previously in BaseExecutionStrategy.
 * It provides eligibility checking and transaction protection.
 *
 * MEV Protection Criteria:
 * 1. MEV provider must be available for the chain
 * 2. MEV provider must be enabled
 * 3. Chain-specific MEV settings must allow it (enabled !== false)
 * 4. Expected profit must meet minimum threshold for MEV protection
 *
 * Usage:
 * ```typescript
 * const service = new MevProtectionService(logger, gasPriceOptimizer);
 * const eligibility = service.checkEligibility(chain, ctx, expectedProfit);
 * if (eligibility.shouldUseMev) {
 *   const protectedTx = await service.applyProtection(tx, chain, ctx);
 * }
 * ```
 */
export class MevProtectionService {
  private readonly logger: Logger;
  private readonly gasPriceOptimizer: GasPriceOptimizer;
  private readonly maxPriorityFeeGwei: number;
  private readonly maxPriorityFeeWei: bigint;

  constructor(
    logger: Logger,
    gasPriceOptimizer: GasPriceOptimizer,
    config?: MevProtectionServiceConfig
  ) {
    this.logger = logger;
    this.gasPriceOptimizer = gasPriceOptimizer;
    this.maxPriorityFeeGwei = config?.maxPriorityFeeGwei ?? 3;
    this.maxPriorityFeeWei = ethers.parseUnits(this.maxPriorityFeeGwei.toString(), 'gwei');
  }

  /**
   * Check if MEV protection should be used for a transaction.
   *
   * MEV Protection Flow by Strategy:
   *
   * IntraChainStrategy (same-chain DEX arbitrage):
   * 1. applyProtection() - Adjusts gas prices for MEV resistance
   * 2. submitTransaction() internally calls checkEligibility()
   * 3. If eligible: Uses mevProvider.sendProtectedTransaction() (Flashbots/Protect)
   * 4. If not eligible: Uses wallet.sendTransaction() directly
   *
   * FlashLoanStrategy (flash loan arbitrage):
   * 1. applyProtection() - Adjusts gas prices for MEV resistance
   * 2. Calls checkEligibility() directly in execute()
   * 3. If eligible: Uses mevProvider.sendProtectedTransaction()
   * 4. If not eligible: Uses wallet.sendTransaction() directly
   *
   * CrossChainStrategy (cross-chain bridge arbitrage):
   * 1. applyProtection() - Adjusts gas prices for source chain transactions
   * 2. Calls checkEligibility() for both source and destination chains
   * 3. MEV protection on SOURCE chain: Protects initial swap
   * 4. Bridge transaction: Not MEV-protected (handled by bridge protocol)
   * 5. MEV protection on DESTINATION chain: Protects final sell
   *
   * @param chain - Chain identifier
   * @param ctx - Strategy context with mevProviderFactory
   * @param expectedProfit - Expected profit in USD
   * @returns Object with eligibility status and provider if eligible
   */
  checkEligibility(
    chain: string,
    ctx: StrategyContext,
    expectedProfit?: number
  ): MevEligibilityResult {
    const mevProvider = ctx.mevProviderFactory?.getProvider(chain);
    const chainSettings = MEV_CONFIG.chainSettings[chain];

    const shouldUseMev = !!(
      mevProvider?.isEnabled() &&
      chainSettings?.enabled !== false &&
      (expectedProfit ?? 0) >= (chainSettings?.minProfitForProtection ?? 0)
    );

    return {
      shouldUseMev,
      mevProvider: shouldUseMev ? mevProvider : undefined,
      chainSettings,
    };
  }

  /**
   * Phase 4: Get MEV provider fallback chain for retry logic.
   *
   * Returns an ordered list of MEV providers to try:
   * 1. Primary provider (chain's default MEV strategy)
   * 2. Fallback providers (if configured and enabled)
   *
   * Use this when implementing retry logic with provider fallback.
   * Research impact: +2-3% execution success rate through redundancy.
   *
   * Usage:
   * ```typescript
   * const { providers, hasProtection } = service.getProviderFallbackChain(chain, ctx, expectedProfit);
   * for (const provider of providers) {
   *   try {
   *     const result = await provider.sendProtectedTransaction(tx);
   *     if (result.success) return result;
   *   } catch (error) {
   *     continue; // Try next fallback
   *   }
   * }
   * // All MEV providers failed, fall back to public mempool
   * ```
   *
   * @param chain - Chain identifier
   * @param ctx - Strategy context with mevProviderFactory
   * @param expectedProfit - Expected profit in USD (for eligibility check)
   * @returns Object with fallback chain info and providers list
   */
  getProviderFallbackChain(
    chain: string,
    ctx: StrategyContext,
    expectedProfit?: number
  ): MevFallbackChainResult {
    const chainSettings = MEV_CONFIG.chainSettings[chain];
    const meetsThreshold = (expectedProfit ?? 0) >= (chainSettings?.minProfitForProtection ?? 0);

    // If MEV protection is disabled or profit doesn't meet threshold, return empty chain
    if (!ctx.mevProviderFactory || chainSettings?.enabled === false || !meetsThreshold) {
      return {
        hasProtection: false,
        providers: [],
        chainSettings,
      };
    }

    // Get the provider and wallet config from context
    const ethersProvider = ctx.providers.get(chain);
    const wallet = ctx.wallets?.get(chain);

    // If we don't have provider/wallet, fall back to single provider check
    if (!ethersProvider || !wallet) {
      const primaryProvider = ctx.mevProviderFactory.getProvider(chain);
      return {
        hasProtection: !!(primaryProvider?.isEnabled()),
        providers: primaryProvider?.isEnabled() ? [primaryProvider] : [],
        chainSettings,
      };
    }

    // Get the full fallback chain from factory
    const providers = ctx.mevProviderFactory.getProviderFallbackChain({
      chain,
      provider: ethersProvider,
      wallet,
    });

    // Filter to only enabled providers
    const enabledProviders = providers.filter(p => p.isEnabled());

    return {
      hasProtection: enabledProviders.length > 0,
      providers: enabledProviders,
      chainSettings,
    };
  }

  /**
   * Apply MEV protection to prevent sandwich attacks.
   *
   * Thread-Safety Considerations for MEV Provider:
   *
   * The ctx.mevProviderFactory is accessed without explicit synchronization because:
   *
   * 1. Read-Only Access: This method only reads from mevProviderFactory, it doesn't
   *    modify the factory or its providers.
   *
   * 2. Provider Immutability: Once created, MEV providers are stateless for sending
   *    transactions. Each sendProtectedTransaction() call is independent.
   *
   * 3. JavaScript Single-Threaded: Node.js runs on a single event loop. While multiple
   *    async operations may be in flight, they don't execute in parallel - they yield at
   *    await points. This means no true concurrent access during a single sync block.
   *
   * Potential Race: If mevProviderFactory is reconfigured (e.g., hot reload of
   * MEV settings) during an execution, a strategy might use a stale provider reference.
   *
   * Mitigation: MEV reconfiguration is rare (typically requires restart). If live
   * reconfiguration is needed, implement factory versioning or atomic swap patterns.
   *
   * Risk Level: Low - MEV config rarely changes at runtime in production.
   *
   * @param tx - Transaction request to protect
   * @param chain - Chain identifier
   * @param ctx - Strategy context
   * @param gasBaselines - Gas baseline history for optimal price calculation
   * @param lastGasPrices - Optional map for O(1) last price access
   * @returns Protected transaction request
   */
  async applyProtection(
    tx: ethers.TransactionRequest,
    chain: string,
    ctx: StrategyContext,
    gasBaselines: Map<string, GasBaselineEntry[]>,
    lastGasPrices?: Map<string, bigint>
  ): Promise<ethers.TransactionRequest> {
    const provider = ctx.providers.get(chain);
    if (!provider) {
      tx.gasPrice = await this.gasPriceOptimizer.getOptimalGasPrice(chain, undefined, gasBaselines, lastGasPrices);
      return tx;
    }

    try {
      const feeData = await provider.getFeeData();

      // Use EIP-1559 transaction format for better fee predictability
      if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
        tx.type = 2;
        tx.maxFeePerGas = feeData.maxFeePerGas;
        // Cap priority fee to prevent MEV extractors from frontrunning
        const maxPriorityFee = feeData.maxPriorityFeePerGas;
        const cappedPriorityFee = maxPriorityFee < this.maxPriorityFeeWei
          ? maxPriorityFee
          : this.maxPriorityFeeWei;
        tx.maxPriorityFeePerGas = cappedPriorityFee;
        delete tx.gasPrice;
      } else {
        tx.gasPrice = await this.gasPriceOptimizer.getOptimalGasPrice(chain, provider, gasBaselines, lastGasPrices);
      }

      if (chain === 'ethereum') {
        this.logger.info('MEV protection: Using Flashbots-style private transaction', {
          chain,
          hasEIP1559: !!feeData.maxFeePerGas
        });
      }

      this.logger.debug('MEV protection applied', {
        chain,
        type: tx.type,
        maxFeePerGas: tx.maxFeePerGas?.toString(),
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas?.toString(),
        gasPrice: tx.gasPrice?.toString()
      });

      return tx;
    } catch (error) {
      this.logger.warn('Failed to apply full MEV protection, using basic gas price', {
        chain,
        error: getErrorMessage(error)
      });
      tx.gasPrice = await this.gasPriceOptimizer.getOptimalGasPrice(chain, provider, gasBaselines, lastGasPrices);
      return tx;
    }
  }

  /**
   * Get the maximum priority fee in wei.
   * Useful for external callers that need to know the cap.
   */
  getMaxPriorityFeeWei(): bigint {
    return this.maxPriorityFeeWei;
  }

  /**
   * Get the maximum priority fee in gwei.
   */
  getMaxPriorityFeeGwei(): number {
    return this.maxPriorityFeeGwei;
  }
}

// P2 FIX #13: Removed deprecated standalone function checkMevEligibility()
// Zero production callers — strategies use MevProtectionService.checkEligibility() via class method.
