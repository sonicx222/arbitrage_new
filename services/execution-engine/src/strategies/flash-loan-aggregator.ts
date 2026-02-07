/**
 * Flash Loan Protocol Aggregator
 *
 * Selects the optimal flash loan provider based on fees, liquidity, reliability, and latency.
 *
 * Selection Process:
 * 1. Get all available providers for chain (via factory)
 * 2. Rank providers using weighted scoring:
 *    - Fees (50%): Lower fees = higher score
 *    - Liquidity (30%): Sufficient + margin = higher score
 *    - Reliability (15%): Success rate from metrics
 *    - Latency (5%): Faster execution preferred
 * 3. Check liquidity for large amounts (>$100K threshold)
 * 4. Select top-ranked provider that passes validation
 * 5. Track metrics for monitoring
 *
 * Caching Strategy:
 * - Rankings cached per chain for 30 seconds (configurable)
 * - Recalculated on cache miss or large amount changes
 * - Liquidity checks cached separately (5 minutes)
 *
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 2 Task 2.3
 * @see flash-loan-aggregator-types.ts
 */

import type { Logger, StrategyContext } from '../types';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type { IFlashLoanProvider, FlashLoanProtocol } from './flash-loan-providers/types';
import type { FlashLoanProviderFactory } from './flash-loan-providers/provider-factory';
import {
  type RankedProvider,
  type ProviderSelectionResult,
  type CachedRanking,
  type FallbackContext,
  type FallbackDecision,
  type FlashLoanAggregatorConfig,
  type ResolvedAggregatorConfig,
  FlashLoanErrorType,
  DEFAULT_AGGREGATOR_CONFIG,
  resolveAggregatorConfig,
  validateWeights,
  classifyError,
} from './flash-loan-aggregator-types';
import { getTokenDecimals } from '@arbitrage/config';

// Forward declaration - will be implemented in Day 2
import type { FlashLoanLiquidityValidator } from './flash-loan-liquidity-validator';
// Forward declaration - will be implemented in Day 3
import type { FlashLoanAggregatorMetrics } from './flash-loan-aggregator-metrics';

// =============================================================================
// Flash Loan Aggregator
// =============================================================================

/**
 * Flash Loan Protocol Aggregator
 *
 * Main orchestrator for provider selection with caching, fallback, and metrics.
 *
 * Usage:
 * ```typescript
 * const aggregator = new FlashLoanAggregator(factory, liquidityValidator, metrics, logger, config);
 *
 * // Select provider for opportunity
 * const selection = await aggregator.selectProvider(opportunity, ctx);
 *
 * if (selection.provider) {
 *   // Use selected provider for execution
 *   const tx = selection.provider.buildTransaction(request, from);
 * }
 * ```
 */
export class FlashLoanAggregator {
  private readonly config: ResolvedAggregatorConfig;
  private readonly rankingCache = new Map<string, CachedRanking>();

  constructor(
    private readonly providerFactory: FlashLoanProviderFactory,
    private readonly liquidityValidator: FlashLoanLiquidityValidator | null,
    private readonly metrics: FlashLoanAggregatorMetrics | null,
    private readonly logger: Logger,
    config?: FlashLoanAggregatorConfig
  ) {
    this.config = resolveAggregatorConfig(config);

    // Validate configuration
    validateWeights(this.config.weights);

    this.logger.info('[FlashLoanAggregator] Initialized', {
      liquidityCheckThresholdUsd: this.config.liquidityCheckThresholdUsd,
      rankingCacheTtlMs: this.config.rankingCacheTtlMs,
      weights: this.config.weights,
    });
  }

  /**
   * Select best flash loan provider for an opportunity
   *
   * Process:
   * 1. Get or refresh provider rankings for chain
   * 2. Filter by validation (isAvailable, validate)
   * 3. Check liquidity for large amounts
   * 4. Return top provider + metadata
   *
   * @param opportunity - Arbitrage opportunity
   * @param ctx - Strategy context with providers/wallets
   * @returns Selection result with provider and metadata
   */
  async selectProvider(
    opportunity: ArbitrageOpportunity,
    ctx: StrategyContext
  ): Promise<ProviderSelectionResult> {
    const startTime = Date.now();
    const chain = opportunity.buyChain;

    if (!chain) {
      return this.createEmptyResult('No chain specified', startTime);
    }

    this.logger.debug('[FlashLoanAggregator] Selecting provider', {
      opportunityId: opportunity.id,
      chain,
      amountIn: opportunity.amountIn,
    });

    // Get ranked providers (cached or fresh)
    const rankedProviders = await this.getRankedProviders(chain, opportunity, ctx);

    if (rankedProviders.length === 0) {
      this.metrics?.recordSelection(null, 'no_providers_available', startTime);
      return this.createEmptyResult('No providers available for chain', startTime);
    }

    // Fast path: Single provider available
    if (rankedProviders.length === 1) {
      const provider = rankedProviders[0].provider;

      if (!provider.isAvailable()) {
        this.metrics?.recordSelection(null, 'only_provider_unavailable', startTime);
        return this.createEmptyResult('Only provider is unavailable', startTime);
      }

      this.metrics?.recordSelection(provider, 'only_provider', startTime);
      return {
        provider,
        rankedProviders,
        selectionReason: 'Only provider available',
        liquidityCheckPerformed: false,
        selectionLatencyMs: Date.now() - startTime,
      };
    }

    // Check if liquidity validation needed (large amount)
    const needsLiquidityCheck = this.shouldCheckLiquidity(opportunity);

    // Find first provider that passes all checks
    for (const ranked of rankedProviders) {
      const provider = ranked.provider;

      // Check 1: Provider available
      if (!provider.isAvailable()) {
        this.logger.debug('[FlashLoanAggregator] Provider unavailable', {
          protocol: provider.protocol,
        });
        continue;
      }

      // Check 2: Liquidity check (if needed)
      if (needsLiquidityCheck && this.liquidityValidator) {
        const hasLiquidity = await this.liquidityValidator.checkLiquidity(
          provider,
          opportunity.tokenIn!,
          BigInt(opportunity.amountIn!),
          ctx
        );

        if (!hasLiquidity) {
          this.logger.debug('[FlashLoanAggregator] Insufficient liquidity', {
            protocol: provider.protocol,
            asset: opportunity.tokenIn,
            amount: opportunity.amountIn,
          });
          continue;
        }
      }

      // Provider passed all checks
      this.metrics?.recordSelection(provider, 'best_ranked', startTime);

      return {
        provider,
        rankedProviders,
        selectionReason: this.buildSelectionReason(ranked, needsLiquidityCheck),
        liquidityCheckPerformed: needsLiquidityCheck,
        selectionLatencyMs: Date.now() - startTime,
      };
    }

    // No provider passed all checks
    this.metrics?.recordSelection(null, 'all_failed_validation', startTime);
    return this.createEmptyResult('All providers failed validation or liquidity checks', startTime);
  }

  /**
   * Handle fallback when provider execution fails
   *
   * Decision Tree:
   * - INSUFFICIENT_LIQUIDITY → Try next provider
   * - HIGH_FEES → Try next provider
   * - TRANSIENT → Can retry same provider (but not implemented yet)
   * - PERMANENT → Abort (no retry)
   * - UNKNOWN → Try next provider
   *
   * @param context - Fallback context with error and remaining providers
   * @returns Fallback decision with next provider (if any)
   */
  decideFallback(context: FallbackContext): FallbackDecision {
    const errorType = classifyError(context.lastError);
    const maxAttempts = 3;

    this.logger.debug('[FlashLoanAggregator] Fallback decision', {
      attemptNumber: context.attemptNumber,
      errorType,
      failedProtocol: context.failedProvider.protocol,
      remainingProviders: context.remainingProviders.length,
    });

    // Check max attempts
    if (context.attemptNumber >= maxAttempts) {
      return {
        shouldRetry: false,
        nextProvider: null,
        reason: `Max attempts (${maxAttempts}) exceeded`,
        errorType,
      };
    }

    // Check remaining providers
    if (context.remainingProviders.length === 0) {
      return {
        shouldRetry: false,
        nextProvider: null,
        reason: 'No remaining providers to try',
        errorType,
      };
    }

    // Decide based on error type
    switch (errorType) {
      case FlashLoanErrorType.INSUFFICIENT_LIQUIDITY:
        return {
          shouldRetry: true,
          nextProvider: context.remainingProviders[0].provider,
          reason: 'Insufficient liquidity, trying next provider',
          errorType,
        };

      case FlashLoanErrorType.HIGH_FEES:
        return {
          shouldRetry: true,
          nextProvider: context.remainingProviders[0].provider,
          reason: 'Fees too high, trying cheaper provider',
          errorType,
        };

      case FlashLoanErrorType.TRANSIENT:
        // Could retry same provider, but for simplicity try next
        return {
          shouldRetry: true,
          nextProvider: context.remainingProviders[0].provider,
          reason: 'Transient error, trying next provider',
          errorType,
        };

      case FlashLoanErrorType.PERMANENT:
        return {
          shouldRetry: false,
          nextProvider: null,
          reason: 'Permanent error (validation/path issue), aborting',
          errorType,
        };

      case FlashLoanErrorType.UNKNOWN:
      default:
        return {
          shouldRetry: true,
          nextProvider: context.remainingProviders[0].provider,
          reason: 'Unknown error, trying next provider',
          errorType,
        };
    }
  }

  /**
   * Get ranked providers for a chain (cached or fresh)
   *
   * Caching Strategy:
   * - Cache rankings per chain for configured TTL (default 30s)
   * - Refresh on cache miss or expiry
   * - Cache key: chain name
   *
   * @param chain - Chain identifier
   * @param opportunity - Opportunity (for amount-based decisions)
   * @param ctx - Strategy context
   * @returns Ranked providers sorted by score (descending)
   */
  private async getRankedProviders(
    chain: string,
    opportunity: ArbitrageOpportunity,
    ctx: StrategyContext
  ): Promise<RankedProvider[]> {
    // Check cache
    const cached = this.rankingCache.get(chain);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < this.config.rankingCacheTtlMs) {
      this.logger.debug('[FlashLoanAggregator] Using cached rankings', {
        chain,
        age: now - cached.timestamp,
      });
      return cached.rankings;
    }

    // Cache miss or expired - calculate fresh rankings
    this.logger.debug('[FlashLoanAggregator] Calculating fresh rankings', { chain });

    const rankings = await this.rankProviders(chain, opportunity, ctx);

    // Update cache
    this.rankingCache.set(chain, {
      rankings,
      timestamp: now,
      chain,
    });

    // Cleanup stale cache entries (simple approach)
    if (this.rankingCache.size > 20) {
      this.cleanupStaleCache();
    }

    return rankings;
  }

  /**
   * Rank all providers for a chain
   *
   * Ranking Algorithm:
   * 1. Get all providers from factory
   * 2. Calculate scores in parallel:
   *    - Fee score (lower fees = higher score)
   *    - Liquidity score (cached estimate or default)
   *    - Reliability score (from metrics or default)
   *    - Latency score (protocol-specific or default)
   * 3. Combine with weights: score = Σ(component_score * weight)
   * 4. Sort by total score descending
   *
   * @param chain - Chain identifier
   * @param opportunity - Opportunity for context
   * @param ctx - Strategy context
   * @returns Ranked providers
   */
  private async rankProviders(
    chain: string,
    opportunity: ArbitrageOpportunity,
    ctx: StrategyContext
  ): Promise<RankedProvider[]> {
    // Get provider from factory (currently returns single provider per chain)
    const provider = this.providerFactory.getProvider(chain);

    if (!provider) {
      return [];
    }

    // For now, factory returns single provider
    // When multiple providers per chain exist, this will rank them all
    const amount = BigInt(opportunity.amountIn || 0);

    const rankings: RankedProvider[] = [];

    try {
      const ranked = await this.rankSingleProvider(provider, amount, chain);
      rankings.push(ranked);
    } catch (error) {
      this.logger.warn('[FlashLoanAggregator] Failed to rank provider', {
        protocol: provider.protocol,
        chain,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Sort by score (descending)
    rankings.sort((a, b) => b.score - a.score);

    // Limit to maxProvidersToRank
    return rankings.slice(0, this.config.maxProvidersToRank);
  }

  /**
   * Rank a single provider
   *
   * @param provider - Provider to rank
   * @param amount - Flash loan amount
   * @param chain - Chain identifier
   * @returns Ranked provider with score
   */
  private async rankSingleProvider(
    provider: IFlashLoanProvider,
    amount: bigint,
    chain: string
  ): Promise<RankedProvider> {
    // Calculate fee score
    const fees = provider.calculateFee(amount);
    const feeScore = this.calculateFeeScore(fees, amount);

    // Liquidity score (use cached estimate or default to 1.0)
    const liquidityScore = this.liquidityValidator
      ? await this.estimateLiquidityScore(provider, amount)
      : 1.0; // Default: assume sufficient liquidity

    // Reliability score (from metrics or default to 1.0)
    const reliabilityScore = this.metrics
      ? await this.metrics.getReliabilityScore(provider)
      : 1.0; // Default: assume fully reliable

    // Latency score (protocol-specific defaults)
    const latencyScore = this.estimateLatencyScore(provider.protocol);

    // Combine scores with weights
    const score =
      feeScore * this.config.weights.fees +
      liquidityScore * this.config.weights.liquidity +
      reliabilityScore * this.config.weights.reliability +
      latencyScore * this.config.weights.latency;

    return {
      provider,
      score,
      fees,
      breakdown: {
        feeScore,
        liquidityScore,
        reliabilityScore,
        latencyScore,
      },
    };
  }

  /**
   * Calculate fee score (0-1, lower fees = higher score)
   *
   * Formula: score = 1 - (feeBps / 100)
   * - 0 bps = 1.0 score (perfect)
   * - 9 bps = 0.91 score (Aave V3)
   * - 25 bps = 0.75 score (PancakeSwap V3)
   * - 30 bps = 0.70 score (SpookySwap)
   *
   * @param fees - Fee information
   * @param amount - Loan amount (unused, for future normalization)
   * @returns Fee score (0-1)
   */
  private calculateFeeScore(fees: { feeBps: number }, _amount: bigint): number {
    // Simple linear scoring: lower fees = higher score
    // Maximum reasonable fee: 100 bps (1%)
    const maxFeeBps = 100;
    const normalizedFee = Math.min(fees.feeBps, maxFeeBps);

    return 1.0 - (normalizedFee / maxFeeBps);
  }

  /**
   * Estimate liquidity score from cached data
   *
   * @param provider - Provider to check
   * @param amount - Requested amount
   * @returns Liquidity score (0-1)
   */
  private async estimateLiquidityScore(
    provider: IFlashLoanProvider,
    amount: bigint
  ): Promise<number> {
    if (!this.liquidityValidator) {
      return 1.0; // No validator, assume sufficient
    }

    // For now, return default score
    // liquidityValidator will be implemented in Day 2
    return 1.0;
  }

  /**
   * Estimate latency score based on protocol
   *
   * Protocol latency characteristics:
   * - Aave V3: Fast (single pool call) → 0.95
   * - PancakeSwap V3: Medium (quoter + pool) → 0.85
   * - Others: Unknown → 0.80
   *
   * @param protocol - Flash loan protocol
   * @returns Latency score (0-1)
   */
  private estimateLatencyScore(protocol: FlashLoanProtocol): number {
    switch (protocol) {
      case 'aave_v3':
        return 0.95; // Fast
      case 'pancakeswap_v3':
        return 0.85; // Medium
      case 'spookyswap':
      case 'syncswap':
        return 0.80; // Unknown, conservative
      default:
        return 0.75; // Very conservative
    }
  }

  /**
   * Determine if liquidity check is needed
   *
   * Check if:
   * - Amount > threshold (default $100K)
   * - LiquidityValidator is available
   *
   * @param opportunity - Opportunity to check
   * @returns True if liquidity check should be performed
   */
  private shouldCheckLiquidity(opportunity: ArbitrageOpportunity): boolean {
    if (!this.liquidityValidator) {
      return false; // No validator available
    }

    // Calculate loan value in USD from amountIn * tokenPrice
    const amountIn = BigInt(opportunity.amountIn || 0);
    const tokenPriceUsd = opportunity.buyPrice;

    // If we have both amount and price, calculate actual loan value
    if (amountIn > 0n && tokenPriceUsd && tokenPriceUsd > 0) {
      try {
        // Get token decimals for accurate conversion (USDC=6, WETH=18, etc.)
        const decimals = getTokenDecimals(
          opportunity.buyChain || opportunity.chain || 'ethereum',
          opportunity.tokenIn!
        );

        // Convert wei to token units, then to USD
        // Example: 500000e6 (500K USDC in smallest units) / 1e6 * $1.00 = $500K
        const tokenAmount = Number(amountIn) / (10 ** decimals);
        const loanValueUsd = tokenAmount * tokenPriceUsd;

        return loanValueUsd >= this.config.liquidityCheckThresholdUsd;
      } catch (error) {
        // If token decimals lookup fails, fall back to profit-based check
        this.logger.warn('[FlashLoanAggregator] Failed to calculate loan value', {
          error: error instanceof Error ? error.message : String(error),
          tokenIn: opportunity.tokenIn,
          chain: opportunity.buyChain || opportunity.chain,
        });
      }
    }

    // Fallback: Use profit-based check if we can't calculate loan value
    // This maintains backward compatibility and handles edge cases
    const estimatedValueUsd = opportunity.expectedProfit || 0;
    return estimatedValueUsd >= this.config.liquidityCheckThresholdUsd;
  }

  /**
   * Build human-readable selection reason
   *
   * @param ranked - Ranked provider
   * @param liquidityChecked - Whether liquidity was checked
   * @returns Selection reason string
   */
  private buildSelectionReason(ranked: RankedProvider, liquidityChecked: boolean): string {
    const parts: string[] = [];

    // Highlight strong scores
    if (ranked.breakdown.feeScore > 0.9) {
      parts.push(`lowest fees (${ranked.fees.feeBps} bps)`);
    }

    if (ranked.breakdown.liquidityScore > 0.9) {
      parts.push('sufficient liquidity');
    }

    if (ranked.breakdown.reliabilityScore > 0.9) {
      parts.push('high reliability');
    }

    if (liquidityChecked) {
      parts.push('liquidity verified on-chain');
    }

    if (parts.length === 0) {
      return `best overall score (${ranked.score.toFixed(2)})`;
    }

    return parts.join(', ');
  }

  /**
   * Create empty selection result
   *
   * @param reason - Reason for no selection
   * @param startTime - Selection start time
   * @returns Empty selection result
   */
  private createEmptyResult(reason: string, startTime: number): ProviderSelectionResult {
    return {
      provider: null,
      rankedProviders: [],
      selectionReason: reason,
      liquidityCheckPerformed: false,
      selectionLatencyMs: Date.now() - startTime,
    };
  }

  /**
   * Cleanup stale cache entries
   */
  private cleanupStaleCache(): void {
    const now = Date.now();
    const ttl = this.config.rankingCacheTtlMs;

    for (const [chain, cached] of this.rankingCache.entries()) {
      if (now - cached.timestamp > ttl) {
        this.rankingCache.delete(chain);
      }
    }
  }

  /**
   * Clear all caches (for testing)
   */
  clearCaches(): void {
    this.rankingCache.clear();
    this.logger.debug('[FlashLoanAggregator] Caches cleared');
  }

  /**
   * Get current configuration
   */
  getConfig(): ResolvedAggregatorConfig {
    return { ...this.config };
  }
}

/**
 * Factory function to create FlashLoanAggregator
 *
 * @param providerFactory - Flash loan provider factory
 * @param liquidityValidator - Liquidity validator (optional)
 * @param metrics - Metrics tracker (optional)
 * @param logger - Logger instance
 * @param config - Aggregator configuration (optional)
 * @returns FlashLoanAggregator instance
 */
export function createFlashLoanAggregator(
  providerFactory: FlashLoanProviderFactory,
  liquidityValidator: FlashLoanLiquidityValidator | null,
  metrics: FlashLoanAggregatorMetrics | null,
  logger: Logger,
  config?: FlashLoanAggregatorConfig
): FlashLoanAggregator {
  return new FlashLoanAggregator(providerFactory, liquidityValidator, metrics, logger, config);
}
