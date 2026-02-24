/**
 * Flash Loan Aggregator Implementation
 *
 * Main orchestrator implementing IFlashLoanAggregator.
 * Coordinates provider ranking, liquidity validation, and caching.
 *
 * Performance Target: <10ms selection (with cache <1ms)
 *
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 2 Task 2.3
 */

import type {
  IFlashLoanAggregator,
  IProviderRanker,
  ILiquidityValidator,
  IAggregatorMetrics,
  IOpportunityContext,
  IProviderInfo,
  IRankingContext,
  ProviderSelection,
  AggregatorConfig,
} from '../domain';
import { ProviderSelection as ProviderSelectionImpl, ProviderScore } from '../domain';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type { FlashLoanProtocol } from '../domain/models';
import { CoalescingMap } from './coalescing-map';

/**
 * Cached ranking entry
 */
interface CachedRanking {
  providers: ReadonlyArray<{
    protocol: FlashLoanProtocol;
    score: ProviderScore;
    provider: IProviderInfo;
  }>;
  timestamp: number;
  chain: string;
}

/**
 * Bucket an amount by order of magnitude for cache/coalescing key stability.
 *
 * Buckets:
 * - < 1e15 (< 0.001 ETH)  → "dust"
 * - < 1e18 (< 1 ETH)      → "small"
 * - < 1e20 (< 100 ETH)    → "medium"
 * - < 1e22 (< 10K ETH)    → "large"
 * - >= 1e22                → "whale"
 *
 * ~5 buckets per chain keeps cache bounded.
 */
function getAmountBucket(amount: bigint): string {
  if (amount < 1000000000000000n) return 'dust';       // < 1e15
  if (amount < 1000000000000000000n) return 'small';    // < 1e18
  if (amount < 100000000000000000000n) return 'medium';  // < 1e20
  if (amount < 10000000000000000000000n) return 'large'; // < 1e22
  return 'whale';
}

/**
 * Build a compound ranking key from chain and amount bucket.
 * Used by both ranking cache and request coalescing for consistency.
 */
function makeRankingKey(chain: string, amount: bigint): string {
  return `${chain}:${getAmountBucket(amount)}`;
}

/**
 * Flash Loan Aggregator Implementation
 *
 * Orchestrates provider selection with ranking, validation, and caching.
 */
export class FlashLoanAggregatorImpl implements IFlashLoanAggregator {
  private readonly rankingCache = new Map<string, CachedRanking>();
  /**
   * Pending ranking operations to prevent race condition (C2 fix).
   * R2: Uses CoalescingMap to deduplicate concurrent requests for same key.
   */
  private readonly pendingRankings = new CoalescingMap<string, ReadonlyArray<{ provider: IProviderInfo; score: ProviderScore }>>();

  constructor(
    private readonly config: AggregatorConfig,
    private readonly ranker: IProviderRanker,
    private readonly liquidityValidator: ILiquidityValidator | null,
    private readonly metrics: IAggregatorMetrics | null,
    private readonly availableProviders: ReadonlyMap<string, IProviderInfo[]>
  ) {}

  /**
   * Select optimal provider for opportunity
   */
  async selectProvider(
    opportunity: ArbitrageOpportunity,
    context: IOpportunityContext
  ): Promise<ProviderSelection> {
    const startTime = Date.now();
    const chain = context.chain;

    // Get available providers for chain
    const providers = this.availableProviders.get(chain);
    if (!providers || providers.length === 0) {
      const selection = ProviderSelectionImpl.failure(
        'No providers available for chain',
        Date.now() - startTime
      );

      this.metrics?.recordSelection(null, selection.selectionReason, startTime);
      return selection;
    }

    // Fast path: Single provider
    if (providers.length === 1) {
      const provider = providers[0];
      if (!provider.isAvailable) {
        const selection = ProviderSelectionImpl.failure(
          'Only provider is unavailable',
          Date.now() - startTime
        );
        this.metrics?.recordSelection(null, selection.selectionReason, startTime);
        return selection;
      }

      // Single provider - no ranking needed, use proper ProviderScore instance
      const selection = ProviderSelectionImpl.success(
        provider.protocol,
        new ProviderScore(1.0, 1.0, 1.0, 1.0, 1.0),
        null,
        'Only provider available',
        Date.now() - startTime
      );

      this.metrics?.recordSelection(provider, 'only_provider', startTime);
      return selection;
    }

    // Get ranked providers (cached or fresh)
    // F1: Thread asset (tokenIn) for liquidity estimate population
    const ranked = await this.getRankedProviders(
      chain,
      BigInt(opportunity.amountIn ?? '0'),
      context,
      opportunity.tokenIn
    );

    if (ranked.length === 0) {
      const selection = ProviderSelectionImpl.failure(
        'All providers failed ranking',
        Date.now() - startTime
      );
      this.metrics?.recordSelection(null, selection.selectionReason, startTime);
      return selection;
    }

    // Check if liquidity validation needed
    const needsLiquidityCheck = this.shouldCheckLiquidity(context);

    // Find first provider that passes all checks
    for (const rankedProvider of ranked) {
      const provider = rankedProvider.provider;

      // F6: Re-check provider availability against live state (defensive).
      // Cached rankings may be up to 30s old; provider availability could change.
      const liveProviders = this.availableProviders.get(chain);
      const liveProvider = liveProviders?.find(p => p.protocol === provider.protocol);
      if (!liveProvider?.isAvailable) {
        continue;
      }

      // Check liquidity (if needed)
      if (needsLiquidityCheck && this.liquidityValidator && opportunity.tokenIn) {
        const liquidityCheck = await this.liquidityValidator.checkLiquidity(
          provider,
          opportunity.tokenIn,
          BigInt(opportunity.amountIn ?? '0'),
          {
            chain,
            rpcProvider: context.rpcProviders?.get(chain),
          }
        );

        // C4/I1 Fix: Skip provider if liquidity check failed OR insufficient liquidity
        // Defense in depth: Check both conditions to handle all cases
        // - checkPerformed = false: RPC call failed, no verified data
        // - hasSufficientLiquidity = false: Verified but insufficient
        if (!liquidityCheck.checkPerformed || !liquidityCheck.hasSufficientLiquidity) {
          continue; // Skip this provider
        }

        // Provider passed all checks
        const selection = ProviderSelectionImpl.success(
          provider.protocol,
          rankedProvider.score,
          liquidityCheck,
          rankedProvider.score.explain(),
          Date.now() - startTime,
          ranked.slice(1, 3).map(r => ({ protocol: r.provider.protocol, score: r.score }))
        );

        this.metrics?.recordSelection(provider, 'best_ranked_with_liquidity', startTime);
        return selection;
      }

      // Provider passed checks (no liquidity check needed)
      const selection = ProviderSelectionImpl.success(
        provider.protocol,
        rankedProvider.score,
        null,
        rankedProvider.score.explain(),
        Date.now() - startTime,
        ranked.slice(1, 3).map(r => ({ protocol: r.provider.protocol, score: r.score }))
      );

      this.metrics?.recordSelection(provider, 'best_ranked', startTime);
      return selection;
    }

    // No provider passed all checks
    const selection = ProviderSelectionImpl.failure(
      'All providers failed validation',
      Date.now() - startTime,
      ranked.slice(0, 3).map(r => ({ protocol: r.provider.protocol, score: r.score }))
    );

    this.metrics?.recordSelection(null, selection.selectionReason, startTime);
    return selection;
  }

  /**
   * Decide fallback when provider fails
   */
  async decideFallback(
    failedProtocol: FlashLoanProtocol,
    error: Error,
    remainingProviders: ReadonlyArray<{ protocol: FlashLoanProtocol; score: number }>
  ): Promise<{
    shouldRetry: boolean;
    nextProtocol: FlashLoanProtocol | null;
    reason: string;
    errorType: 'insufficient_liquidity' | 'high_fees' | 'transient' | 'permanent' | 'unknown';
  }> {
    const errorType = this.classifyError(error);

    // No remaining providers
    if (remainingProviders.length === 0) {
      return {
        shouldRetry: false,
        nextProtocol: null,
        reason: 'No remaining providers',
        errorType,
      };
    }

    // Decide based on error type
    switch (errorType) {
      case 'insufficient_liquidity':
      case 'high_fees':
      case 'transient':
      case 'unknown':
        return {
          shouldRetry: true,
          nextProtocol: remainingProviders[0].protocol,
          reason: `${errorType} - trying next provider`,
          errorType,
        };

      case 'permanent':
        return {
          shouldRetry: false,
          nextProtocol: null,
          reason: 'Permanent error - aborting',
          errorType,
        };
    }
  }

  /**
   * Get aggregator configuration
   */
  getConfig(): AggregatorConfig {
    return this.config;
  }

  /**
   * Clear all caches
   */
  clearCaches(): void {
    this.rankingCache.clear();
    this.pendingRankings.clear(); // C2 fix: Clear pending coalescing map too
    this.liquidityValidator?.clearCache();
  }

  /**
   * Get ranked providers (cached or fresh, with request coalescing)
   *
   * C2 Fix: Implements request coalescing to prevent race condition.
   * Multiple concurrent calls for same chain will share one ranking operation.
   */
  private async getRankedProviders(
    chain: string,
    amount: bigint,
    context: IOpportunityContext,
    asset?: string
  ): Promise<ReadonlyArray<{ provider: IProviderInfo; score: ProviderScore }>> {
    // F3+F4: Use compound key (chain + amount bucket) for cache and coalescing
    const key = makeRankingKey(chain, amount);

    // Check cache first (F3: compound key includes amount bucket)
    const cached = this.rankingCache.get(key);
    if (cached && Date.now() - cached.timestamp < this.config.rankingCacheTtlMs) {
      return cached.providers;
    }

    // R2: Request coalescing via CoalescingMap - deduplicates concurrent requests
    // F4: compound key prevents different-amount requests from coalescing
    return this.pendingRankings.getOrCreate(key, () =>
      this.performRanking(chain, amount, context, asset)
    );
  }

  /**
   * Perform actual ranking operation (extracted for request coalescing)
   *
   * F1: Accepts optional asset to populate liquidityEstimates via validator.
   */
  private async performRanking(
    chain: string,
    amount: bigint,
    context: IOpportunityContext,
    asset?: string
  ): Promise<ReadonlyArray<{ provider: IProviderInfo; score: ProviderScore }>> {
    // Get providers for chain
    const providers = this.availableProviders.get(chain) || [];

    // Build reliability scores map
    const reliabilityScores = new Map<FlashLoanProtocol, number>();
    if (this.metrics) {
      for (const provider of providers) {
        const score = await this.metrics.getReliabilityScore(provider);
        reliabilityScores.set(provider.protocol, score);
      }
    }

    // F1: Populate liquidity estimates when validator and asset are available.
    // estimateLiquidityScore returns a 0-1 score; convert to a synthetic bigint
    // that will reproduce the same score tier when the ranker processes it.
    const liquidityEstimates = new Map<FlashLoanProtocol, bigint>();
    if (this.liquidityValidator && asset && amount > 0n) {
      for (const provider of providers) {
        const score = await this.liquidityValidator.estimateLiquidityScore(
          provider,
          asset,
          amount
        );
        // Convert score → synthetic liquidity bigint that preserves the tier.
        // The ranker applies a 10% safety margin, so we derive values that
        // land in the correct bracket of calculateLiquidityScore:
        //   score >= 1.0 → 3x amount   → tier 1.0 (>= 2x requiredWithMargin)
        //   score >= 0.9 → 1.5x amount → tier 0.9 (>= requiredWithMargin)
        //   score >= 0.7 → 1x amount   → tier 0.7 (>= rawRequired)
        //   score <  0.7 → amount / 2  → tier 0.3 (insufficient)
        let syntheticLiquidity: bigint;
        if (score >= 1.0) {
          syntheticLiquidity = amount * 3n;
        } else if (score >= 0.9) {
          syntheticLiquidity = (amount * 3n) / 2n;
        } else if (score >= 0.7) {
          syntheticLiquidity = amount;
        } else {
          syntheticLiquidity = amount / 2n;
        }
        liquidityEstimates.set(provider.protocol, syntheticLiquidity);
      }
    }

    // F12: Populate latencyHistory from metrics data
    // Only aggregated metrics (avgLatencyMs) are available via IAggregatorMetrics,
    // so create a synthetic array. latencyHistory has only 5% weight, so this is sufficient.
    const latencyHistory = new Map<FlashLoanProtocol, number[]>();
    if (this.metrics) {
      for (const provider of providers) {
        const health = this.metrics.getProviderHealth(provider);
        if (health && health.avgLatencyMs > 0) {
          // Create a synthetic sample array from the average latency
          // Use a small array to give the ranker data to calculate P95 from
          latencyHistory.set(provider.protocol, [health.avgLatencyMs]);
        }
      }
    }

    // Build ranking context
    const rankingContext: IRankingContext = {
      chain,
      reliabilityScores,
      latencyHistory,
      liquidityEstimates,
    };

    // Rank providers
    const ranked = await this.ranker.rankProviders(providers, amount, rankingContext);

    // Transform to cache format (add protocol for faster lookups)
    const cacheProviders = ranked.map(r => ({
      protocol: r.provider.protocol,
      score: r.score,
      provider: r.provider,
    }));

    // F3: Cache results with compound key (chain + amount bucket)
    const key = makeRankingKey(chain, amount);
    this.rankingCache.set(key, {
      providers: cacheProviders,
      timestamp: Date.now(),
      chain,
    });

    // Evict oldest entries if cache exceeds reasonable size
    this.cleanupRankingCacheIfNeeded();

    return ranked;
  }

  /** Maximum ranking cache entries (one per chain, generous limit) */
  private static readonly MAX_RANKING_CACHE_SIZE = 50;

  /**
   * Evict oldest ranking cache entries if size exceeds limit
   */
  private cleanupRankingCacheIfNeeded(): void {
    if (this.rankingCache.size > FlashLoanAggregatorImpl.MAX_RANKING_CACHE_SIZE) {
      // Remove oldest 20% of entries
      const entries = Array.from(this.rankingCache.entries());
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toRemove = entries.slice(0, Math.floor(FlashLoanAggregatorImpl.MAX_RANKING_CACHE_SIZE * 0.2));
      for (const [key] of toRemove) {
        this.rankingCache.delete(key);
      }
    }
  }

  /**
   * Check if liquidity validation is needed
   */
  private shouldCheckLiquidity(context: IOpportunityContext): boolean {
    if (!this.liquidityValidator) {
      return false;
    }

    return context.estimatedValueUsd >= this.config.liquidityCheckThresholdUsd;
  }

  /**
   * Classify error type for fallback decisions
   *
   * M7 Fix: Expanded error patterns for better classification.
   * Distinguishes transient errors (can retry) from permanent (should abort).
   */
  private classifyError(error: Error): 'insufficient_liquidity' | 'high_fees' | 'transient' | 'permanent' | 'unknown' {
    const message = error.message.toLowerCase();

    // Liquidity issues (try next provider with more liquidity)
    if (
      message.includes('insufficient liquidity') ||
      message.includes('reserve too low') ||
      message.includes('insufficient reserves') ||
      message.includes('liquidity unavailable')
    ) {
      return 'insufficient_liquidity';
    }

    // Fee/slippage issues (try next provider with better pricing)
    if (
      message.includes('fee too high') ||
      message.includes('slippage exceeded') ||
      message.includes('price impact too high') ||
      message.includes('min return not met')
    ) {
      return 'high_fees';
    }

    // Transient errors (temporary, can retry same or different provider)
    if (
      // Network/RPC errors
      message.includes('timeout') ||
      message.includes('network error') ||
      message.includes('econnrefused') ||
      message.includes('econnreset') ||
      message.includes('etimedout') ||
      message.includes('enetunreach') ||
      message.includes('socket hang up') ||
      // HTTP error codes
      message.includes('502') ||
      message.includes('503') ||
      message.includes('504') ||
      message.includes('429') || // Rate limit
      // Transaction errors (can retry with adjusted parameters)
      message.includes('nonce too low') ||
      message.includes('nonce has already been used') ||
      message.includes('replacement transaction underpriced') ||
      message.includes('gas price too low') ||
      message.includes('transaction underpriced') ||
      message.includes('already known') // Transaction already in mempool
    ) {
      return 'transient';
    }

    // Permanent errors (configuration/validation issues, don't retry)
    if (
      message.includes('invalid') ||
      message.includes('not supported') ||
      message.includes('validation failed') ||
      // Contract state errors
      message.includes('paused') ||
      message.includes('contract paused') ||
      message.includes('emergency mode') ||
      // Permission/approval errors
      message.includes('router not approved') ||
      message.includes('not whitelisted') ||
      message.includes('pool not whitelisted') ||
      message.includes('unauthorized') ||
      message.includes('access denied') ||
      // Path validation errors
      message.includes('invalid swap path') ||
      message.includes('invalid pool') ||
      message.includes('token mismatch') ||
      message.includes('path validation failed')
    ) {
      return 'permanent';
    }

    return 'unknown';
  }
}
