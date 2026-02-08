/**
 * Flash Loan Aggregation - Domain Models
 *
 * Value Objects and Domain Entities following DDD principles.
 * All value objects are immutable (Object.freeze) to prevent accidental mutations.
 *
 * Performance Targets:
 * - Value object creation: <1μs
 * - Property access: O(1), <10ns
 *
 * @see docs/CLEAN_ARCHITECTURE_DAY1_SUMMARY.md
 */

import type { FlashLoanProtocol } from '../../../../../services/execution-engine/src/strategies/flash-loan-providers/types';

// =============================================================================
// Value Objects (Immutable Domain Concepts)
// =============================================================================

/**
 * Provider Score Breakdown
 *
 * Immutable representation of how a provider was scored.
 * Used for debugging and selection transparency.
 */
export class ProviderScore {
  constructor(
    public readonly feeScore: number,
    public readonly liquidityScore: number,
    public readonly reliabilityScore: number,
    public readonly latencyScore: number,
    public readonly totalScore: number
  ) {
    // Validate scores are in valid range [0, 1]
    const scores = [feeScore, liquidityScore, reliabilityScore, latencyScore, totalScore];
    for (const score of scores) {
      if (score < 0 || score > 1 || !Number.isFinite(score)) {
        throw new Error(`Invalid score value: ${score}. Must be in range [0, 1]`);
      }
    }

    Object.freeze(this);
  }

  /**
   * Create score from breakdown components and weights
   */
  static fromComponents(
    feeScore: number,
    liquidityScore: number,
    reliabilityScore: number,
    latencyScore: number,
    weights: { fees: number; liquidity: number; reliability: number; latency: number }
  ): ProviderScore {
    const totalScore =
      feeScore * weights.fees +
      liquidityScore * weights.liquidity +
      reliabilityScore * weights.reliability +
      latencyScore * weights.latency;

    return new ProviderScore(
      feeScore,
      liquidityScore,
      reliabilityScore,
      latencyScore,
      totalScore
    );
  }

  /**
   * Get human-readable explanation of score
   */
  explain(): string {
    const parts: string[] = [];

    if (this.feeScore > 0.9) parts.push(`excellent fees (${(this.feeScore * 100).toFixed(0)}%)`);
    if (this.liquidityScore > 0.9) parts.push(`high liquidity (${(this.liquidityScore * 100).toFixed(0)}%)`);
    if (this.reliabilityScore > 0.9) parts.push(`very reliable (${(this.reliabilityScore * 100).toFixed(0)}%)`);
    if (this.latencyScore > 0.9) parts.push(`fast (${(this.latencyScore * 100).toFixed(0)}%)`);

    return parts.length > 0
      ? parts.join(', ')
      : `total score: ${(this.totalScore * 100).toFixed(0)}%`;
  }
}

/**
 * Liquidity Check Result
 *
 * Immutable result of on-chain liquidity validation.
 */
export class LiquidityCheck {
  constructor(
    public readonly hasSufficientLiquidity: boolean,
    public readonly availableLiquidity: bigint,
    public readonly requiredLiquidity: bigint,
    public readonly checkPerformed: boolean,
    public readonly checkLatencyMs: number,
    public readonly error?: string
  ) {
    // Validate amounts
    if (availableLiquidity < 0n) {
      throw new Error(`Invalid available liquidity: ${availableLiquidity}`);
    }
    if (requiredLiquidity < 0n) {
      throw new Error(`Invalid required liquidity: ${requiredLiquidity}`);
    }
    if (checkLatencyMs < 0) {
      throw new Error(`Invalid check latency: ${checkLatencyMs}ms`);
    }

    Object.freeze(this);
  }

  /**
   * Create successful check result
   */
  static success(
    available: bigint,
    required: bigint,
    latencyMs: number
  ): LiquidityCheck {
    return new LiquidityCheck(
      available >= required,
      available,
      required,
      true,
      latencyMs
    );
  }

  /**
   * Create failed check result (e.g., RPC error)
   *
   * I1 Fix: Set hasSufficientLiquidity = false for semantic consistency.
   * When checkPerformed = false, we cannot verify liquidity, so conservatively
   * assume insufficient. This prevents accidental use without checking checkPerformed.
   */
  static failure(error: string, latencyMs: number): LiquidityCheck {
    return new LiquidityCheck(
      false, // Cannot verify - conservatively assume insufficient
      0n,
      0n,
      false, // Check was not performed
      latencyMs,
      error
    );
  }

  /**
   * Create skipped check result (below threshold)
   */
  static skipped(): LiquidityCheck {
    return new LiquidityCheck(
      true, // Assume sufficient when not checked
      0n,
      0n,
      false,
      0
    );
  }

  /**
   * Get margin as percentage (how much extra liquidity vs required)
   */
  getMarginPercent(): number {
    if (this.requiredLiquidity === 0n) return 100;

    const margin = this.availableLiquidity - this.requiredLiquidity;
    return Number((margin * 10000n) / this.requiredLiquidity) / 100;
  }
}

/**
 * Provider Selection Result
 *
 * Immutable result of provider selection process.
 * Contains selected provider and metadata for debugging/monitoring.
 */
export class ProviderSelection {
  constructor(
    public readonly protocol: FlashLoanProtocol | null,
    public readonly score: ProviderScore | null,
    public readonly liquidityCheck: LiquidityCheck | null,
    public readonly selectionReason: string,
    public readonly selectionLatencyMs: number,
    public readonly rankedAlternatives: ReadonlyArray<{
      protocol: FlashLoanProtocol;
      score: ProviderScore;
    }>
  ) {
    // Validate latency
    if (selectionLatencyMs < 0) {
      throw new Error(`Invalid selection latency: ${selectionLatencyMs}ms`);
    }

    // If protocol selected, must have score
    if (protocol !== null && score === null) {
      throw new Error('Selected protocol must have associated score');
    }

    Object.freeze(this);
    Object.freeze(this.rankedAlternatives);
  }

  /**
   * Create successful selection
   */
  static success(
    protocol: FlashLoanProtocol,
    score: ProviderScore,
    liquidityCheck: LiquidityCheck | null,
    reason: string,
    latencyMs: number,
    alternatives: Array<{ protocol: FlashLoanProtocol; score: ProviderScore }> = []
  ): ProviderSelection {
    return new ProviderSelection(
      protocol,
      score,
      liquidityCheck,
      reason,
      latencyMs,
      alternatives
    );
  }

  /**
   * Create failed selection (no provider available)
   */
  static failure(
    reason: string,
    latencyMs: number,
    alternatives: Array<{ protocol: FlashLoanProtocol; score: ProviderScore }> = []
  ): ProviderSelection {
    return new ProviderSelection(
      null,
      null,
      null,
      reason,
      latencyMs,
      alternatives
    );
  }

  /**
   * Check if selection was successful
   */
  get isSuccess(): boolean {
    return this.protocol !== null;
  }

  /**
   * Get selection summary for logging
   */
  getSummary(): string {
    if (!this.isSuccess) {
      return `Selection failed: ${this.selectionReason}`;
    }

    const parts = [
      `Selected: ${this.protocol}`,
      this.score ? this.score.explain() : '',
      this.liquidityCheck?.checkPerformed
        ? `liquidity verified (${this.liquidityCheck.checkLatencyMs}ms)`
        : '',
      `latency: ${this.selectionLatencyMs}ms`,
    ];

    return parts.filter(Boolean).join(' | ');
  }
}

/**
 * Aggregator Configuration
 *
 * Immutable configuration for flash loan aggregation.
 */
export class AggregatorConfig {
  constructor(
    public readonly liquidityCheckThresholdUsd: number,
    public readonly rankingCacheTtlMs: number,
    public readonly liquidityCacheTtlMs: number,
    public readonly weights: {
      readonly fees: number;
      readonly liquidity: number;
      readonly reliability: number;
      readonly latency: number;
    },
    public readonly maxProvidersToRank: number,
    public readonly protocolLatencyDefaults?: Readonly<Record<string, number>>
  ) {
    // Validate thresholds
    if (liquidityCheckThresholdUsd < 0) {
      throw new Error(`Invalid liquidity threshold: ${liquidityCheckThresholdUsd}`);
    }
    if (rankingCacheTtlMs <= 0) {
      throw new Error(`Invalid ranking cache TTL: ${rankingCacheTtlMs}ms`);
    }
    if (liquidityCacheTtlMs <= 0) {
      throw new Error(`Invalid liquidity cache TTL: ${liquidityCacheTtlMs}ms`);
    }
    if (maxProvidersToRank < 1) {
      throw new Error(`Invalid max providers: ${maxProvidersToRank}`);
    }

    // Validate weights sum to 1.0
    const sum = weights.fees + weights.liquidity + weights.reliability + weights.latency;
    const tolerance = 0.01;
    if (Math.abs(sum - 1.0) > tolerance) {
      throw new Error(
        `Weights must sum to 1.0 (got ${sum.toFixed(3)}). ` +
        `fees=${weights.fees}, liquidity=${weights.liquidity}, ` +
        `reliability=${weights.reliability}, latency=${weights.latency}`
      );
    }

    Object.freeze(this);
    Object.freeze(this.weights);
  }

  /**
   * Create default configuration
   */
  static default(): AggregatorConfig {
    return new AggregatorConfig(
      100000, // $100K threshold
      30000, // 30 second ranking cache
      300000, // 5 minute liquidity cache
      {
        fees: 0.5,
        liquidity: 0.3,
        reliability: 0.15,
        latency: 0.05,
      },
      5, // Max 5 providers
      {
        // Protocol-specific latency defaults (0-1 score)
        // Based on typical execution characteristics
        aave_v3: 0.95,        // Fast (single pool call)
        pancakeswap_v3: 0.85, // Medium (quoter + pool)
        spookyswap: 0.80,     // Conservative (less data)
        syncswap: 0.80,       // Conservative (less data)
        default: 0.75,        // Very conservative for unknown protocols
      }
    );
  }

  /**
   * Create custom configuration with validation
   *
   * M2 Fix: Validates partial weights - must provide all or none.
   * Prevents confusing errors from partial weight specifications.
   */
  static create(partial: {
    liquidityCheckThresholdUsd?: number;
    rankingCacheTtlMs?: number;
    liquidityCacheTtlMs?: number;
    weights?: {
      fees?: number;
      liquidity?: number;
      reliability?: number;
      latency?: number;
    };
    maxProvidersToRank?: number;
    protocolLatencyDefaults?: Record<string, number>;
  }): AggregatorConfig {
    const defaults = AggregatorConfig.default();

    // M2 Fix: Validate partial weights specification
    if (partial.weights) {
      const providedWeights = {
        fees: partial.weights.fees,
        liquidity: partial.weights.liquidity,
        reliability: partial.weights.reliability,
        latency: partial.weights.latency,
      };

      const definedCount = Object.values(providedWeights).filter(w => w !== undefined).length;

      // Either all 4 weights must be provided, or none (use defaults)
      if (definedCount !== 0 && definedCount !== 4) {
        throw new Error(
          `[ERR_PARTIAL_WEIGHTS] When providing weights, must specify all 4 values (fees, liquidity, reliability, latency). ` +
          `Provided ${definedCount}/4. Either provide all weights or omit to use defaults.`
        );
      }
    }

    return new AggregatorConfig(
      partial.liquidityCheckThresholdUsd ?? defaults.liquidityCheckThresholdUsd,
      partial.rankingCacheTtlMs ?? defaults.rankingCacheTtlMs,
      partial.liquidityCacheTtlMs ?? defaults.liquidityCacheTtlMs,
      {
        fees: partial.weights?.fees ?? defaults.weights.fees,
        liquidity: partial.weights?.liquidity ?? defaults.weights.liquidity,
        reliability: partial.weights?.reliability ?? defaults.weights.reliability,
        latency: partial.weights?.latency ?? defaults.weights.latency,
      },
      partial.maxProvidersToRank ?? defaults.maxProvidersToRank,
      partial.protocolLatencyDefaults ?? defaults.protocolLatencyDefaults
    );
  }
}

/**
 * Provider Execution Outcome
 *
 * Immutable record of provider execution result.
 * Used for reliability scoring and metrics.
 */
export class ProviderOutcome {
  constructor(
    public readonly protocol: FlashLoanProtocol,
    public readonly success: boolean,
    public readonly executionLatencyMs: number,
    public readonly error?: string,
    public readonly errorType?: 'insufficient_liquidity' | 'high_fees' | 'transient' | 'permanent' | 'unknown'
  ) {
    if (executionLatencyMs < 0) {
      throw new Error(`Invalid execution latency: ${executionLatencyMs}ms`);
    }

    Object.freeze(this);
  }

  /**
   * Create successful outcome
   */
  static success(protocol: FlashLoanProtocol, latencyMs: number): ProviderOutcome {
    return new ProviderOutcome(protocol, true, latencyMs);
  }

  /**
   * Create failed outcome
   */
  static failure(
    protocol: FlashLoanProtocol,
    latencyMs: number,
    error: string,
    errorType: ProviderOutcome['errorType'] = 'unknown'
  ): ProviderOutcome {
    return new ProviderOutcome(protocol, false, latencyMs, error, errorType);
  }
}
