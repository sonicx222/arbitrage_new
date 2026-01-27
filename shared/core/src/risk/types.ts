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

// =============================================================================
// EV Calculator Types (Task 3.4.2)
// =============================================================================

/**
 * Configuration for EVCalculator
 */
export interface EVConfig {
  /**
   * Minimum expected value threshold in wei for execution.
   * Default: 5000000000000000 (0.005 ETH, ~$10 at $2000/ETH)
   * Adjust based on gas costs and desired profitability margin.
   */
  minEVThreshold: bigint;

  /** Minimum win probability to consider (0-1, filters out highly uncertain trades) */
  minWinProbability: number;

  /** Maximum allowed loss in wei per trade (for risk capping) */
  maxLossPerTrade: bigint;

  /** Whether to use historical gas costs when estimatedGas is not provided */
  useHistoricalGasCost: boolean;

  /** Default gas cost in wei when no data available */
  defaultGasCost: bigint;

  /** Default profit estimate in wei when no historical data available */
  defaultProfitEstimate: bigint;
}

/**
 * Input for EV calculation
 * Accepts opportunity-like objects with flexible field names
 */
export interface EVInput {
  /** Chain identifier (e.g., 'ethereum', 'arbitrum') */
  chain: string;

  /** DEX identifier (e.g., 'uniswap_v2', 'sushiswap') */
  dex: string;

  /** Number of hops in the arbitrage path (defaults to 2) */
  pathLength?: number;

  /** Path array for triangular/multi-leg arbitrage */
  path?: string[];

  /** Estimated profit from the opportunity (in wei) */
  estimatedProfit?: bigint;

  /** Expected profit (alternative field name for estimatedProfit) */
  expectedProfit?: bigint;

  /** Estimated gas cost (in wei) */
  estimatedGas?: bigint;

  /** Gas estimate (alternative field name) */
  gasEstimate?: bigint;
}

/**
 * Result of EV calculation
 */
export interface EVCalculation {
  /** Calculated expected value in wei */
  expectedValue: bigint;

  /** Win probability used in calculation (0-1) */
  winProbability: number;

  /** Expected profit weighted by win probability (in wei) */
  expectedProfit: bigint;

  /** Expected gas cost weighted by loss probability (in wei) */
  expectedGasCost: bigint;

  /** Whether the opportunity should be executed based on EV threshold */
  shouldExecute: boolean;

  /** Reason for not executing (when shouldExecute is false) */
  reason?: string;

  /** Source of probability data */
  probabilitySource: 'historical' | 'default';

  /** Number of historical samples used */
  sampleCount: number;

  /** Raw profit estimate used (before probability weighting) */
  rawProfitEstimate: bigint;

  /** Raw gas cost estimate used (before probability weighting) */
  rawGasCost: bigint;
}

/**
 * Statistics from EVCalculator
 */
export interface EVCalculatorStats {
  /** Total calculations performed */
  totalCalculations: number;

  /** Number of opportunities that passed EV threshold */
  approvedCount: number;

  /** Number of opportunities rejected due to low EV */
  rejectedLowEV: number;

  /** Number of opportunities rejected due to low win probability */
  rejectedLowProbability: number;

  /** Number of opportunities rejected due to exceeding max loss per trade */
  rejectedMaxLoss: number;

  /** Average EV of approved opportunities */
  averageApprovedEV: bigint;

  /** Average EV of all calculated opportunities */
  averageEV: bigint;
}
