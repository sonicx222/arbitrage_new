/**
 * Risk Management Types
 *
 * Phase 3: Capital & Risk Controls (P0)
 * Task 3.4.1: Execution Probability Tracker Types
 *
 * @see docs/reports/implementation_plan_v3.md Section 3.4
 */

/**
 * Configuration for ExecutionProbabilityTracker
 */
export interface ExecutionProbabilityConfig {
  /** Minimum samples required before returning non-default probability */
  minSamples: number;

  /** Default win probability when insufficient data (0-1) */
  defaultWinProbability: number;

  /** Maximum outcomes to store per key before pruning old data */
  maxOutcomesPerKey: number;

  /** Cleanup interval in milliseconds */
  cleanupIntervalMs: number;

  /** Time window for outcome relevance in milliseconds (e.g., 7 days) */
  outcomeRelevanceWindowMs: number;

  /** Redis key prefix for persistence */
  redisKeyPrefix: string;

  /** Whether to persist outcomes to Redis */
  persistToRedis: boolean;
}

/**
 * Represents a single execution outcome for tracking win/loss probability
 */
export interface ExecutionOutcome {
  /** Chain identifier (e.g., 'ethereum', 'arbitrum', 'bsc') */
  chain: string;

  /** DEX identifier (e.g., 'uniswap_v2', 'sushiswap', 'pancakeswap') */
  dex: string;

  /** Number of hops in the arbitrage path */
  pathLength: number;

  /** Hour of day when execution occurred (0-23 UTC) */
  hourOfDay: number;

  /** Gas price at time of execution (in wei) */
  gasPrice: bigint;

  /** Whether the execution was successful (profitable) */
  success: boolean;

  /** Profit amount if successful (in wei) */
  profit?: bigint;

  /** Gas cost for the transaction (in wei) */
  gasCost: bigint;

  /** Timestamp of execution (Unix ms) */
  timestamp: number;
}

/**
 * Parameters for querying win probability
 */
export interface ProbabilityQueryParams {
  chain: string;
  dex: string;
  pathLength: number;
}

/**
 * Result of a probability query
 */
export interface ProbabilityResult {
  /** Win probability (0-1) */
  winProbability: number;

  /** Number of samples used to compute probability */
  sampleCount: number;

  /** Whether this is based on actual data or default */
  isDefault: boolean;

  /** Total wins in the sample */
  wins: number;

  /** Total losses in the sample */
  losses: number;
}

/**
 * Parameters for querying average profit
 */
export interface ProfitQueryParams {
  chain: string;
  dex: string;
}

/**
 * Result of an average profit query
 */
export interface ProfitResult {
  /** Average profit (in wei) */
  averageProfit: bigint;

  /** Sample count used */
  sampleCount: number;

  /** Total profit across all samples (in wei) */
  totalProfit: bigint;
}

/**
 * Parameters for querying average gas cost
 */
export interface GasCostQueryParams {
  chain: string;
}

/**
 * Result of an average gas cost query
 */
export interface GasCostResult {
  /** Average gas cost (in wei) */
  averageGasCost: bigint;

  /** Sample count used */
  sampleCount: number;

  /** Total gas cost across all samples (in wei) */
  totalGasCost: bigint;
}

/**
 * Aggregated statistics from ExecutionProbabilityTracker
 */
export interface ExecutionTrackerStats {
  /** Total outcomes recorded */
  totalOutcomes: number;

  /** Total successful outcomes */
  totalSuccesses: number;

  /** Total failed outcomes */
  totalFailures: number;

  /** Overall win rate (0-1) */
  overallWinRate: number;

  /** Number of unique (chain, dex, pathLength) combinations tracked */
  uniqueKeys: number;

  /** Timestamp of first recorded outcome */
  firstOutcomeTimestamp: number | null;

  /** Timestamp of most recent outcome */
  lastOutcomeTimestamp: number | null;

  /** Memory usage estimate in bytes */
  estimatedMemoryBytes: number;
}

/**
 * Serialized outcome for Redis persistence
 */
export interface SerializedOutcome {
  chain: string;
  dex: string;
  pathLength: number;
  hourOfDay: number;
  gasPrice: string; // BigInt serialized as string
  success: boolean;
  profit?: string; // BigInt serialized as string
  gasCost: string; // BigInt serialized as string
  timestamp: number;
}

/**
 * Aggregated hourly statistics for time-of-day analysis
 */
export interface HourlyStats {
  /** Hour of day (0-23) */
  hour: number;

  /** Win rate for this hour */
  winRate: number;

  /** Sample count for this hour */
  sampleCount: number;
}
