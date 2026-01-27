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

// =============================================================================
// Position Sizer Types (Task 3.4.3)
// =============================================================================

/**
 * Configuration for KellyPositionSizer
 */
export interface PositionSizerConfig {
  /**
   * Kelly multiplier for fractional Kelly sizing (0-1).
   * Default: 0.5 (half Kelly - safer than full Kelly)
   *
   * Full Kelly (1.0) maximizes long-term growth but has high variance.
   * Half Kelly (0.5) provides ~75% of growth with ~50% of variance.
   */
  kellyMultiplier: number;

  /**
   * Maximum fraction of capital for a single trade (0-1).
   * Default: 0.02 (2% max per trade)
   *
   * This is a hard cap regardless of Kelly calculation.
   */
  maxSingleTradeFraction: number;

  /**
   * Minimum fraction of capital for a trade to be worth executing (0-1).
   * Default: 0.001 (0.1% minimum)
   *
   * Trades sized below this are not worth the gas/effort.
   */
  minTradeFraction: number;

  /**
   * Total capital available for trading (in wei).
   * This should be updated when capital changes.
   */
  totalCapital: bigint;

  /**
   * Whether to enable position sizing (can be disabled for testing).
   * When disabled, returns maxSingleTrade as recommended size.
   */
  enabled: boolean;
}

/**
 * Result of position size calculation
 */
export interface PositionSize {
  /**
   * Recommended position size in wei.
   * This is the capital amount to use for the trade.
   */
  recommendedSize: bigint;

  /**
   * Recommended size as fraction of total capital (0-1).
   */
  fractionOfCapital: number;

  /**
   * Raw Kelly fraction before any adjustments (can be >1 or <0).
   * f* = (p * b - q) / b
   */
  kellyFraction: number;

  /**
   * Adjusted Kelly fraction after applying multiplier.
   * = kellyFraction * kellyMultiplier, clamped to [0, 1]
   */
  adjustedKelly: number;

  /**
   * Final fraction after applying max/min caps.
   */
  cappedFraction: number;

  /**
   * Maximum allowed size based on config (in wei).
   */
  maxAllowed: bigint;

  /**
   * Whether the trade should be executed based on sizing.
   * False if Kelly suggests negative sizing or below minimum.
   */
  shouldTrade: boolean;

  /**
   * Reason for not trading (when shouldTrade is false).
   */
  reason?: string;
}

/**
 * Input for position sizing calculation
 */
export interface PositionSizeInput {
  /**
   * Win probability from EV calculator (0-1).
   */
  winProbability: number;

  /**
   * Expected profit if trade succeeds (in wei).
   */
  expectedProfit: bigint;

  /**
   * Expected loss if trade fails (in wei).
   * Typically the gas cost.
   */
  expectedLoss: bigint;
}

/**
 * Statistics from KellyPositionSizer
 */
export interface PositionSizerStats {
  /** Total sizing calculations performed */
  totalCalculations: number;

  /** Number of trades that should be executed */
  tradesApproved: number;

  /** Number of trades rejected due to negative Kelly */
  rejectedNegativeKelly: number;

  /** Number of trades rejected due to below minimum size */
  rejectedBelowMinimum: number;

  /** Number of trades capped at maximum size */
  cappedAtMaximum: number;

  /** Average recommended fraction (for approved trades) */
  averageFraction: number;

  /** Total capital value used in calculations */
  totalCapitalUsed: bigint;
}

// =============================================================================
// Drawdown Circuit Breaker Types (Task 3.4.4)
// =============================================================================

/**
 * Drawdown state machine states.
 * Controls trading behavior based on capital performance.
 */
export type DrawdownStateType = 'NORMAL' | 'CAUTION' | 'HALT' | 'RECOVERY';

/**
 * Configuration for DrawdownCircuitBreaker
 */
export interface DrawdownConfig {
  /**
   * Maximum daily loss as fraction of capital (0-1).
   * When exceeded, state transitions to HALT.
   * Default: 0.05 (5%)
   */
  maxDailyLoss: number;

  /**
   * Caution threshold as fraction of capital (0-1).
   * When exceeded, state transitions to CAUTION.
   * Default: 0.03 (3%)
   */
  cautionThreshold: number;

  /**
   * Maximum consecutive losses before HALT.
   * Default: 5
   */
  maxConsecutiveLosses: number;

  /**
   * Position size multiplier during RECOVERY state (0-1).
   * Default: 0.5 (50% of normal sizing)
   */
  recoveryMultiplier: number;

  /**
   * Position size multiplier during CAUTION state (0-1).
   * FIX 2.1/4.1: Added configurable multiplier for CAUTION state.
   * Previously hardcoded to 0.75.
   * Default: 0.75 (75% of normal sizing)
   */
  cautionMultiplier: number;

  /**
   * Number of winning trades required to exit RECOVERY.
   * Default: 3
   */
  recoveryWinsRequired: number;

  /**
   * Time in ms before HALT state can be manually reset.
   * Default: 3600000 (1 hour)
   */
  haltCooldownMs: number;

  /**
   * Total capital for drawdown calculations (in wei).
   * Should be kept in sync with position sizer.
   */
  totalCapital: bigint;

  /**
   * Whether the circuit breaker is enabled.
   * Default: true
   */
  enabled: boolean;
}

/**
 * Current state of the drawdown circuit breaker
 */
export interface DrawdownState {
  /** Current state machine state */
  state: DrawdownStateType;

  /** Daily profit/loss in wei (resets at UTC midnight) */
  dailyPnL: bigint;

  /** Number of consecutive losing trades */
  consecutiveLosses: number;

  /** Number of consecutive winning trades (for recovery tracking) */
  consecutiveWins: number;

  /** Timestamp of last state transition */
  lastStateChange: number;

  /** Timestamp when HALT state started (for cooldown tracking) */
  haltStartTime: number | null;

  /** Current date string for daily reset tracking (YYYY-MM-DD) */
  currentDateUTC: string;

  /** Total realized PnL since tracker start (in wei) */
  totalPnL: bigint;

  /** Peak capital value for max drawdown calculation (in wei) */
  peakCapital: bigint;

  /** Current drawdown from peak as decimal (0-1) */
  currentDrawdown: number;

  /** Maximum drawdown observed as decimal (0-1) */
  maxDrawdown: number;
}

/**
 * Result of checking if trading is allowed
 */
export interface TradingAllowedResult {
  /** Whether trading is allowed */
  allowed: boolean;

  /** Current circuit breaker state */
  state: DrawdownStateType;

  /** Position size multiplier to apply (1.0 for normal, less for CAUTION/RECOVERY) */
  sizeMultiplier: number;

  /** Reason for restriction (if not allowed or reduced) */
  reason?: string;

  /** Time remaining in HALT cooldown (ms, if in HALT state) */
  haltCooldownRemaining?: number;
}

/**
 * Trade result for updating the circuit breaker
 */
export interface TradeResult {
  /** Whether the trade was profitable */
  success: boolean;

  /** Profit/loss amount in wei (negative for loss) */
  pnl: bigint;

  /** Timestamp of trade completion */
  timestamp: number;
}

/**
 * Statistics from DrawdownCircuitBreaker
 */
export interface DrawdownStats {
  /** Current state */
  currentState: DrawdownStateType;

  /** Daily PnL in wei */
  dailyPnL: bigint;

  /** Daily PnL as fraction of capital */
  dailyPnLFraction: number;

  /** Total PnL in wei */
  totalPnL: bigint;

  /** Current drawdown from peak (0-1) */
  currentDrawdown: number;

  /** Maximum drawdown observed (0-1) */
  maxDrawdown: number;

  /** Total trades recorded */
  totalTrades: number;

  /** Total winning trades */
  totalWins: number;

  /** Total losing trades */
  totalLosses: number;

  /** Number of times HALT was triggered */
  haltCount: number;

  /** Number of times CAUTION was triggered */
  cautionCount: number;

  /** Time spent in HALT state (ms) */
  totalHaltTimeMs: number;
}
