/**
 * Flash Loan Aggregator Implementation
 *
 * Main orchestrator implementing IFlashLoanAggregator.
 * Coordinates provider ranking, liquidity validation, and caching.
 *
 * Performance Target: <10ms selection (with cache <1ms)
 *
 * @see docs/CLEAN_ARCHITECTURE_DAY1_SUMMARY.md Infrastructure Layer
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
import type { FlashLoanProtocol } from '../../../../../services/execution-engine/src/strategies/flash-loan-providers/types';

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
 * Flash Loan Aggregator Implementation
 *
 * Orchestrates provider selection with ranking, validation, and caching.
 */
export class FlashLoanAggregatorImpl implements IFlashLoanAggregator {
  private readonly rankingCache = new Map<string, CachedRanking>();

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

      // Single provider - no ranking needed
      const selection = ProviderSelectionImpl.success(
        provider.protocol,
        { totalScore: 1.0, feeScore: 1.0, liquidityScore: 1.0, reliabilityScore: 1.0, latencyScore: 1.0 } as any,
        null,
        'Only provider available',
        Date.now() - startTime
      );

      this.metrics?.recordSelection(provider, 'only_provider', startTime);
      return selection;
    }

    // Get ranked providers (cached or fresh)
    const ranked = await this.getRankedProviders(
      chain,
      BigInt(opportunity.amountIn || 0),
      context
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

      // Check availability
      if (!provider.isAvailable) {
        continue;
      }

      // Check liquidity (if needed)
      if (needsLiquidityCheck && this.liquidityValidator && opportunity.tokenIn) {
        const liquidityCheck = await this.liquidityValidator.checkLiquidity(
          provider,
          opportunity.tokenIn,
          BigInt(opportunity.amountIn || 0),
          {
            chain,
            rpcProvider: context.rpcProviders?.get(chain),
          }
        );

        if (!liquidityCheck.hasSufficientLiquidity) {
          continue;
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
    failedProtocol: string,
    error: Error,
    remainingProviders: ReadonlyArray<{ protocol: string; score: number }>
  ): Promise<{
    shouldRetry: boolean;
    nextProtocol: string | null;
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
    this.liquidityValidator?.clearCache();
  }

  /**
   * Get ranked providers (cached or fresh)
   */
  private async getRankedProviders(
    chain: string,
    amount: bigint,
    context: IOpportunityContext
  ): Promise<ReadonlyArray<{ provider: IProviderInfo; score: any }>> {
    // Check cache
    const cached = this.rankingCache.get(chain);
    if (cached && Date.now() - cached.timestamp < this.config.rankingCacheTtlMs) {
      return cached.providers;
    }

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

    // Build ranking context
    const rankingContext: IRankingContext = {
      chain,
      reliabilityScores,
      latencyHistory: new Map(),
      liquidityEstimates: new Map(),
    };

    // Rank providers
    const ranked = await this.ranker.rankProviders(providers, amount, rankingContext);

    // Transform to cache format (add protocol for faster lookups)
    const cacheProviders = ranked.map(r => ({
      protocol: r.provider.protocol,
      score: r.score,
      provider: r.provider,
    }));

    // Cache results
    this.rankingCache.set(chain, {
      providers: cacheProviders,
      timestamp: Date.now(),
      chain,
    });

    return ranked;
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
   * Classify error type
   */
  private classifyError(error: Error): 'insufficient_liquidity' | 'high_fees' | 'transient' | 'permanent' | 'unknown' {
    const message = error.message.toLowerCase();

    if (message.includes('insufficient liquidity') || message.includes('reserve too low')) {
      return 'insufficient_liquidity';
    }

    if (message.includes('fee too high') || message.includes('slippage exceeded')) {
      return 'high_fees';
    }

    if (message.includes('timeout') || message.includes('network error') || message.includes('503')) {
      return 'transient';
    }

    if (message.includes('invalid') || message.includes('not supported') || message.includes('validation failed')) {
      return 'permanent';
    }

    return 'unknown';
  }
}

/**
 * Factory function to create aggregator
 */
export function createFlashLoanAggregator(
  config: AggregatorConfig,
  ranker: IProviderRanker,
  liquidityValidator: ILiquidityValidator | null,
  metrics: IAggregatorMetrics | null,
  availableProviders: ReadonlyMap<string, IProviderInfo[]>
): FlashLoanAggregatorImpl {
  return new FlashLoanAggregatorImpl(
    config,
    ranker,
    liquidityValidator,
    metrics,
    availableProviders
  );
}
