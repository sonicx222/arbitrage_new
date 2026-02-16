/**
 * Capital Risk Management Configuration
 *
 * Phase 3: Capital & Risk Controls (P0)
 * Centralizes all risk-related configuration for the arbitrage system.
 *
 * Used by:
 * - ExecutionProbabilityTracker (Task 3.4.1)
 * - EVCalculator (Task 3.4.2)
 * - KellyPositionSizer (Task 3.4.3)
 * - DrawdownCircuitBreaker (Task 3.4.4)
 * - ExecutionEngineService (Task 3.4.5)
 *
 * @see ADR-021: Capital Risk Management
 * @see docs/reports/implementation_plan_v3.md Section 3.4
 */

// =============================================================================
// HELPER: Env Parsing with Validation (FIX 3.2)
// =============================================================================

// S-6: Use shared parseEnvIntSafe for integer parsing
// NOTE: Cannot import from @arbitrage/core here because config builds before core.
// The shared parseEnvIntSafe in core has identical semantics. If the build order
// changes in the future, this local copy can be replaced with an import.

/**
 * FIX 3.2: Parse environment variable to BigInt with validation.
 * Prevents SyntaxError from invalid BigInt strings like "abc".
 *
 * @param envVar - Environment variable name
 * @param defaultValue - Default value as string (for logging)
 * @returns Parsed BigInt value
 */
function parseEnvBigInt(envVar: string, defaultValue: string): bigint {
  const raw = process.env[envVar];
  if (!raw) {
    return BigInt(defaultValue);
  }
  try {
    // Validate the string only contains valid BigInt characters
    if (!/^-?\d+$/.test(raw.trim())) {
      console.warn(`[RISK_CONFIG] Invalid BigInt value for ${envVar}: "${raw}" - using default`);
      return BigInt(defaultValue);
    }
    return BigInt(raw.trim());
  } catch (error) {
    console.warn(`[RISK_CONFIG] Failed to parse BigInt for ${envVar}: "${raw}" - using default`);
    return BigInt(defaultValue);
  }
}

/**
 * FIX 3.2: Parse environment variable to float with validation.
 * Prevents NaN from invalid float strings.
 *
 * @param envVar - Environment variable name
 * @param defaultValue - Default value
 * @param min - Minimum allowed value
 * @param max - Maximum allowed value
 * @returns Validated float value
 */
function parseEnvFloat(envVar: string, defaultValue: number, min = 0, max = 1): number {
  const raw = process.env[envVar];
  if (!raw) {
    return defaultValue;
  }
  const parsed = parseFloat(raw);
  if (Number.isNaN(parsed)) {
    console.warn(`[RISK_CONFIG] Invalid float value for ${envVar}: "${raw}" - using default`);
    return defaultValue;
  }
  if (parsed < min || parsed > max) {
    console.warn(`[RISK_CONFIG] Value for ${envVar} (${parsed}) out of range [${min}, ${max}] - using default`);
    return defaultValue;
  }
  return parsed;
}

/**
 * FIX 3.2: Parse environment variable to integer with validation (safe mode).
 * Prevents NaN from invalid integer strings. Returns default/min on invalid input.
 *
 * NOTE: This is functionally identical to parseEnvIntSafe in @arbitrage/core/env-utils.
 * It remains local because shared/config builds before shared/core in the dependency chain.
 * See S-6 consolidation notes.
 *
 * @param envVar - Environment variable name
 * @param defaultValue - Default value
 * @param min - Minimum allowed value
 * @returns Validated integer value
 */
function parseEnvInt(envVar: string, defaultValue: number, min = 1): number {
  const raw = process.env[envVar];
  if (!raw) {
    return defaultValue;
  }
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    console.warn(`[RISK_CONFIG] Invalid integer value for ${envVar}: "${raw}" - using default`);
    return defaultValue;
  }
  if (parsed < min) {
    console.warn(`[RISK_CONFIG] Value for ${envVar} (${parsed}) below minimum ${min} - using minimum`);
    return min;
  }
  return parsed;
}

// =============================================================================
// CAPITAL RISK CONFIGURATION
// =============================================================================

/**
 * Risk management configuration with environment variable overrides.
 * All thresholds are expressed as decimals (e.g., 0.05 = 5%).
 */
export const RISK_CONFIG = {
  /** Enable capital risk management globally */
  enabled: process.env.RISK_MANAGEMENT_ENABLED !== 'false', // Default true

  // ===========================================================================
  // Drawdown Circuit Breaker (Task 3.4.4)
  // ===========================================================================

  drawdown: {
    /** Enable drawdown-based circuit breaker */
    enabled: process.env.DRAWDOWN_BREAKER_ENABLED !== 'false', // Default true

    /**
     * Maximum daily loss as fraction of capital (0-1).
     * When exceeded, state transitions to HALT.
     * Default: 5%
     */
    maxDailyLoss: parseEnvFloat('RISK_MAX_DAILY_LOSS', 0.05, 0.001, 1),

    /**
     * Caution threshold as fraction of capital (0-1).
     * When exceeded, state transitions to CAUTION (reduced sizing).
     * Default: 3%
     */
    cautionThreshold: parseEnvFloat('RISK_CAUTION_THRESHOLD', 0.03, 0.001, 1),

    /**
     * Maximum consecutive losses before transitioning to HALT.
     * Default: 5
     */
    maxConsecutiveLosses: parseEnvInt('RISK_MAX_CONSECUTIVE_LOSSES', 5, 1),

    /**
     * Position size multiplier during RECOVERY state (0-1).
     * Default: 0.5 (50% of normal sizing)
     */
    recoveryMultiplier: parseEnvFloat('RISK_RECOVERY_MULTIPLIER', 0.5, 0.01, 1),

    /**
     * Number of consecutive winning trades required to exit RECOVERY.
     * Default: 3
     */
    recoveryWinsRequired: parseEnvInt('RISK_RECOVERY_WINS_REQUIRED', 3, 1),

    /**
     * Cooldown period in milliseconds before HALT can be manually reset.
     * Default: 1 hour (3600000ms)
     */
    haltCooldownMs: parseEnvInt('RISK_HALT_COOLDOWN_MS', 3600000, 60000),

    /**
     * Position size multiplier during CAUTION state (0-1).
     * Default: 0.75 (75% of normal sizing)
     */
    cautionMultiplier: parseEnvFloat('RISK_CAUTION_MULTIPLIER', 0.75, 0.01, 1),
  },

  // ===========================================================================
  // Expected Value Calculator (Task 3.4.2)
  // ===========================================================================

  ev: {
    /** Enable EV-based trade filtering */
    enabled: process.env.EV_CALCULATOR_ENABLED !== 'false', // Default true

    /**
     * Minimum expected value threshold in wei for execution.
     * Default: 0.005 ETH (5000000000000000 wei) ~$10 at $2000/ETH
     */
    minEVThreshold: parseEnvBigInt('RISK_MIN_EV_THRESHOLD', '5000000000000000'),

    /**
     * Minimum win probability to consider (0-1).
     * Filters out highly uncertain trades.
     * Default: 0.3 (30%)
     */
    minWinProbability: parseEnvFloat('RISK_MIN_WIN_PROBABILITY', 0.3, 0, 1),

    /**
     * Maximum allowed loss per trade in wei.
     * Default: 0.1 ETH (100000000000000000 wei)
     */
    maxLossPerTrade: parseEnvBigInt('RISK_MAX_LOSS_PER_TRADE', '100000000000000000'),

    /**
     * Use historical gas costs when estimatedGas is not provided.
     * Default: true
     */
    useHistoricalGasCost: process.env.RISK_USE_HISTORICAL_GAS !== 'false',

    /**
     * Default gas cost in wei when no historical data available.
     * Default: 0.01 ETH (10000000000000000 wei)
     */
    defaultGasCost: parseEnvBigInt('RISK_DEFAULT_GAS_COST', '10000000000000000'),

    /**
     * Default profit estimate in wei when no historical data available.
     * Default: 0.02 ETH (20000000000000000 wei)
     */
    defaultProfitEstimate: parseEnvBigInt('RISK_DEFAULT_PROFIT_ESTIMATE', '20000000000000000'),
  },

  // ===========================================================================
  // Position Sizer (Task 3.4.3)
  // ===========================================================================

  positionSizing: {
    /** Enable Kelly Criterion position sizing */
    enabled: process.env.POSITION_SIZING_ENABLED !== 'false', // Default true

    /**
     * Kelly multiplier for fractional Kelly sizing (0-1).
     * Full Kelly (1.0) maximizes growth but has high variance.
     * Half Kelly (0.5) provides ~75% of growth with ~50% of variance.
     * Default: 0.5
     */
    kellyMultiplier: parseEnvFloat('RISK_KELLY_MULTIPLIER', 0.5, 0.01, 1),

    /**
     * Maximum fraction of capital for a single trade (0-1).
     * Hard cap regardless of Kelly calculation.
     * Default: 2%
     */
    maxSingleTradeFraction: parseEnvFloat('RISK_MAX_SINGLE_TRADE', 0.02, 0.001, 1),

    /**
     * Minimum fraction of capital for a trade to be worth executing (0-1).
     * Trades below this are not worth the gas/effort.
     * Default: 0.1%
     */
    minTradeFraction: parseEnvFloat('RISK_MIN_TRADE_FRACTION', 0.001, 0, 1),
  },

  // ===========================================================================
  // Execution Probability Tracker (Task 3.4.1)
  // ===========================================================================

  probability: {
    /**
     * Minimum samples required before returning non-default probability.
     * Default: 10
     */
    minSamples: parseEnvInt('RISK_MIN_SAMPLES', 10, 1),

    /**
     * Default win probability when insufficient data (0-1).
     * Default: 0.5 (50%)
     */
    defaultWinProbability: parseEnvFloat('RISK_DEFAULT_WIN_PROBABILITY', 0.5, 0, 1),

    /**
     * Maximum outcomes to store per key before pruning old data.
     * Default: 1000
     */
    maxOutcomesPerKey: parseEnvInt('RISK_MAX_OUTCOMES_PER_KEY', 1000, 10),

    /**
     * Cleanup interval in milliseconds.
     * Default: 1 hour (3600000ms)
     */
    cleanupIntervalMs: parseEnvInt('RISK_CLEANUP_INTERVAL_MS', 3600000, 60000),

    /**
     * Time window for outcome relevance in milliseconds.
     * Outcomes older than this are pruned.
     * Default: 7 days (604800000ms)
     */
    outcomeRelevanceWindowMs: parseEnvInt('RISK_OUTCOME_RELEVANCE_MS', 604800000, 3600000),

    /**
     * Whether to persist outcomes to Redis.
     * Default: true
     */
    persistToRedis: process.env.RISK_PERSIST_TO_REDIS !== 'false',

    /**
     * Redis key prefix for persistence.
     * Default: 'risk:probabilities:'
     */
    redisKeyPrefix: process.env.RISK_REDIS_KEY_PREFIX || 'risk:probabilities:',
  },

  // ===========================================================================
  // Total Capital Configuration
  // ===========================================================================

  /**
   * Total capital available for trading in wei.
   * This should be updated when capital changes.
   *
   * FIX 3.3: REQUIRED in production environment.
   * Default: 10 ETH (for safety in development - MUST be explicitly set in production)
   */
  totalCapital: parseEnvBigInt('RISK_TOTAL_CAPITAL', '10000000000000000000'),
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get risk configuration with runtime capital override.
 * Use this to create component-specific configs with current capital.
 */
export function getRiskConfigWithCapital(capital: bigint) {
  return {
    ...RISK_CONFIG,
    totalCapital: capital,
  };
}

/**
 * Validate risk configuration values.
 * Throws on invalid configuration.
 */
export function validateRiskConfig(): void {
  const errors: string[] = [];

  // FIX 3.3: Require RISK_TOTAL_CAPITAL in production
  // Using default 10 ETH in production is dangerous - position sizing will be wrong
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction && !process.env.RISK_TOTAL_CAPITAL) {
    errors.push(
      'RISK_TOTAL_CAPITAL must be explicitly set in production environment. ' +
      'Default value of 10 ETH is not suitable for production trading.'
    );
  }

  // Validate drawdown config
  const { drawdown, ev, positionSizing, probability } = RISK_CONFIG;

  if (drawdown.maxDailyLoss <= 0 || drawdown.maxDailyLoss > 1) {
    errors.push('RISK_MAX_DAILY_LOSS must be between 0 and 1');
  }
  if (drawdown.cautionThreshold <= 0 || drawdown.cautionThreshold >= drawdown.maxDailyLoss) {
    errors.push('RISK_CAUTION_THRESHOLD must be between 0 and maxDailyLoss');
  }
  if (drawdown.maxConsecutiveLosses < 1) {
    errors.push('RISK_MAX_CONSECUTIVE_LOSSES must be at least 1');
  }
  if (drawdown.recoveryMultiplier <= 0 || drawdown.recoveryMultiplier > 1) {
    errors.push('RISK_RECOVERY_MULTIPLIER must be between 0 and 1');
  }
  // FIX 2.1/4.1: Validate cautionMultiplier
  if (drawdown.cautionMultiplier <= 0 || drawdown.cautionMultiplier > 1) {
    errors.push('RISK_CAUTION_MULTIPLIER must be between 0 and 1');
  }
  if (drawdown.recoveryWinsRequired < 1) {
    errors.push('RISK_RECOVERY_WINS_REQUIRED must be at least 1');
  }

  // Validate EV config
  if (ev.minWinProbability < 0 || ev.minWinProbability > 1) {
    errors.push('RISK_MIN_WIN_PROBABILITY must be between 0 and 1');
  }

  // Validate position sizing config
  if (positionSizing.kellyMultiplier <= 0 || positionSizing.kellyMultiplier > 1) {
    errors.push('RISK_KELLY_MULTIPLIER must be between 0 and 1');
  }
  if (positionSizing.maxSingleTradeFraction <= 0 || positionSizing.maxSingleTradeFraction > 1) {
    errors.push('RISK_MAX_SINGLE_TRADE must be between 0 and 1');
  }
  if (positionSizing.minTradeFraction < 0 || positionSizing.minTradeFraction >= positionSizing.maxSingleTradeFraction) {
    errors.push('RISK_MIN_TRADE_FRACTION must be between 0 and maxSingleTradeFraction');
  }

  // Validate probability config
  if (probability.defaultWinProbability < 0 || probability.defaultWinProbability > 1) {
    errors.push('RISK_DEFAULT_WIN_PROBABILITY must be between 0 and 1');
  }
  if (probability.minSamples < 1) {
    errors.push('RISK_MIN_SAMPLES must be at least 1');
  }

  // FIX P2-5: Cross-validate default probability against min win probability.
  // If defaultWinProbability < minWinProbability, all new chain/DEX combos
  // (and all combos after restart, since data is in-memory only) will be
  // rejected by the EV calculator's probability filter.
  if (probability.defaultWinProbability < ev.minWinProbability) {
    errors.push(
      `RISK_DEFAULT_WIN_PROBABILITY (${probability.defaultWinProbability}) must be >= ` +
      `RISK_MIN_WIN_PROBABILITY (${ev.minWinProbability}). Otherwise all trades using ` +
      `default probability (new chains, after restart) will be rejected.`
    );
  }

  if (errors.length > 0) {
    throw new Error(`Risk configuration validation failed:\n${errors.join('\n')}`);
  }
}

// Validate at import time (skip in test environment)
if (process.env.NODE_ENV !== 'test') {
  try {
    validateRiskConfig();
  } catch (error) {
    console.error('Risk configuration validation error:', error);
    // Don't throw - allow startup with warnings in development
    if (process.env.NODE_ENV === 'production') {
      throw error;
    }
  }
}
