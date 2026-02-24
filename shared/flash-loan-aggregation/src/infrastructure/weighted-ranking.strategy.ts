/**
 * Weighted Ranking Strategy
 *
 * Default provider ranking strategy using weighted scores.
 * Implements IProviderRanker following Strategy Pattern.
 *
 * Weights (configurable):
 * - Fees: 50%
 * - Liquidity: 30%
 * - Reliability: 15%
 * - Latency: 5%
 *
 * Performance Target: <2ms for up to 5 providers
 *
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 2 Task 2.3
 */

import type {
  IProviderRanker,
  IProviderInfo,
  IRankedProvider,
  IRankingContext,
  AggregatorConfig,
  ProviderScore,
} from '../domain';
import { ProviderScore as ProviderScoreImpl } from '../domain';
import { calculateLiquidityScore, DEFAULT_LIQUIDITY_SCORE } from './liquidity-scoring';
import { withTimeout } from './with-timeout';

/**
 * Weighted Ranking Strategy
 *
 * Calculates provider scores using weighted components:
 * 1. Fee Score: Lower fees = higher score (linear: 1.0 at 0 bps, 0.0 at 100 bps)
 * 2. Liquidity Score: From cached estimates or validator (0.3 to 1.0)
 * 3. Reliability Score: Historical success rate from metrics (0.0 to 1.0)
 * 4. Latency Score: Protocol-specific estimates (0.75 to 0.95)
 *
 * Total Score = Σ(component_score × weight)
 */
export class WeightedRankingStrategy implements IProviderRanker {
  constructor(
    private readonly config: AggregatorConfig
  ) {}

  /**
   * Rank providers using weighted scoring
   *
   * Calculates scores in parallel for optimal performance.
   * Performance: ~2ms for 5 providers (vs ~10ms sequential)
   *
   * M6 Fix: Timeout protection (10s) to prevent indefinite blocking
   */
  async rankProviders(
    providers: ReadonlyArray<IProviderInfo>,
    requestedAmount: bigint,
    context: IRankingContext
  ): Promise<ReadonlyArray<IRankedProvider>> {
    // Filter available providers first (synchronous operation)
    const availableProviders = providers.filter(p => p.isAvailable);

    // Calculate scores in parallel for all available providers
    const scoringPromises = availableProviders.map(async (provider): Promise<IRankedProvider | null> => {
      try {
        const score = await this.calculateScore(provider, requestedAmount, context);
        const estimatedLiquidity = context.liquidityEstimates.get(provider.protocol);

        return {
          provider,
          score,
          estimatedLiquidity,
        };
      } catch (error) {
        // Return null for failed scoring (will be filtered out)
        return null;
      }
    });

    // M6 Fix: Wait for all scoring with timeout protection (10s)
    // If timeout, returns partial results (graceful degradation)
    // R1: Uses shared withTimeout utility for consistent cleanup
    const timeoutMs = 10000;

    let results: Array<IRankedProvider | null>;
    try {
      results = await withTimeout(
        Promise.all(scoringPromises),
        timeoutMs,
        'Ranking timeout'
      );
    } catch (timeoutError) {
      // Timeout occurred - collect partial results (settled promises only)
      // Use Promise.allSettled to get whatever completed before timeout
      const settled = await Promise.allSettled(scoringPromises);
      results = settled
        .filter((r): r is PromiseFulfilledResult<IRankedProvider | null> => r.status === 'fulfilled')
        .map(r => r.value);
    }

    // Filter out failed scores and sort by total score (descending)
    const ranked = results
      .filter((r): r is IRankedProvider => r !== null)
      .sort((a, b) => b.score.totalScore - a.score.totalScore);

    // Limit to configured maximum
    return ranked.slice(0, this.config.maxProvidersToRank);
  }

  /**
   * Get strategy name
   */
  getStrategyName(): string {
    return 'weighted';
  }

  /**
   * Get current weights
   */
  getWeights(): {
    readonly fees: number;
    readonly liquidity: number;
    readonly reliability: number;
    readonly latency: number;
  } {
    return { ...this.config.weights };
  }

  /**
   * Calculate total score for provider
   */
  private calculateScore(
    provider: IProviderInfo,
    requestedAmount: bigint,
    context: IRankingContext
  ): ProviderScore {
    // Calculate component scores
    const feeScore = this.calculateFeeScore(provider);
    const liquidityScore = this.calculateLiquidityScoreForProvider(provider, requestedAmount, context);
    const reliabilityScore = this.calculateReliabilityScore(provider, context);
    const latencyScore = this.calculateLatencyScore(provider, context);

    // Combine with weights
    return ProviderScoreImpl.fromComponents(
      feeScore,
      liquidityScore,
      reliabilityScore,
      latencyScore,
      this.config.weights
    );
  }

  /**
   * Calculate fee score (0-1, lower fees = higher score)
   *
   * Formula: score = 1 - (feeBps / maxFeeBps)
   * - 0 bps = 1.0 score (perfect)
   * - 9 bps = 0.91 score (Aave V3)
   * - 25 bps = 0.75 score (PancakeSwap V3)
   * - 100 bps = 0.0 score (worst)
   */
  private calculateFeeScore(provider: IProviderInfo): number {
    const maxFeeBps = 100; // 1%
    const normalizedFee = Math.min(Math.max(0, provider.feeBps), maxFeeBps);
    return 1.0 - (normalizedFee / maxFeeBps);
  }

  /**
   * Calculate liquidity score (0-1)
   *
   * Uses cached estimates if available, else uses conservative default.
   * Delegates to shared calculateLiquidityScore() for consistent thresholds.
   */
  private calculateLiquidityScoreForProvider(
    provider: IProviderInfo,
    requestedAmount: bigint,
    context: IRankingContext
  ): number {
    const estimate = context.liquidityEstimates.get(provider.protocol);

    if (!estimate) {
      return DEFAULT_LIQUIDITY_SCORE;
    }

    // Apply safety margin (10%) with ceiling division to round up (conservative)
    const requiredWithMargin = (requestedAmount * 110n + 99n) / 100n;

    return calculateLiquidityScore(estimate, requiredWithMargin, requestedAmount);
  }

  /**
   * Calculate reliability score (0-1)
   *
   * Uses historical success rate from metrics.
   * Defaults to 1.0 if no data available.
   */
  private calculateReliabilityScore(
    provider: IProviderInfo,
    context: IRankingContext
  ): number {
    const score = context.reliabilityScores.get(provider.protocol);
    return score ?? 1.0; // Default to perfect reliability if no data
  }

  /**
   * Calculate latency score (0-1)
   *
   * Uses protocol-specific estimates or historical data.
   *
   * Protocol latency characteristics:
   * - Aave V3: Fast (single pool call) → 0.95
   * - PancakeSwap V3: Medium (quoter + pool) → 0.85
   * - Others: Conservative → 0.80
   *
   * Can be overridden by historical latency data.
   */
  private calculateLatencyScore(
    provider: IProviderInfo,
    context: IRankingContext
  ): number {
    // Check if we have historical latency data
    const latencies = context.latencyHistory.get(provider.protocol);

    if (latencies && latencies.length > 0) {
      // Calculate P95 latency from historical data
      const sorted = [...latencies].sort((a, b) => a - b);
      const p95Index = Math.min(Math.ceil(sorted.length * 0.95) - 1, sorted.length - 1);
      const p95Latency = sorted[p95Index] ?? sorted[sorted.length - 1];

      // Score based on P95 latency
      // <100ms = 1.0, 100-200ms = 0.9, 200-500ms = 0.8, >500ms = 0.7
      if (p95Latency < 100) return 1.0;
      if (p95Latency < 200) return 0.9;
      if (p95Latency < 500) return 0.8;
      return 0.7;
    }

    // Fallback to protocol-specific defaults from config
    const defaults = this.config.protocolLatencyDefaults ?? {};
    return defaults[provider.protocol] ?? defaults['default'] ?? 0.75;
  }
}
