/**
 * Drawdown Circuit Breaker
 *
 * Task 3.4.4: Capital protection through drawdown-based trading controls.
 *
 * Implements a state machine that monitors trading performance and
 * restricts or halts trading when drawdown thresholds are exceeded.
 *
 * State Machine:
 * - NORMAL: Full trading allowed (100% position sizing)
 * - CAUTION: Reduced trading (configurable multiplier, default 75%)
 * - HALT: Trading stopped (cooldown required)
 * - RECOVERY: Gradual return to normal (reduced sizing until wins achieved)
 *
 * Transitions:
 * - NORMAL -> CAUTION: Daily loss exceeds cautionThreshold
 * - CAUTION -> HALT: Daily loss exceeds maxDailyLoss OR consecutive losses exceeded
 * - HALT -> RECOVERY: Manual reset after cooldown period
 * - RECOVERY -> NORMAL: Required consecutive wins achieved
 * - Any -> NORMAL: New trading day (daily reset at UTC midnight)
 *
 * @see docs/reports/implementation_plan_v3.md Section 3.4.4
 */

import { createLogger } from '../logger';
import type {
  DrawdownConfig,
  DrawdownState,
  DrawdownStateType,
  DrawdownStats,
  TradingAllowedResult,
  TradeResult,
} from './types';

const logger = createLogger('drawdown-circuit-breaker');

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: DrawdownConfig = {
  maxDailyLoss: 0.05, // 5% of capital
  cautionThreshold: 0.03, // 3% triggers caution
  maxConsecutiveLosses: 5,
  recoveryMultiplier: 0.5, // 50% sizing in recovery
  cautionMultiplier: 0.75, // FIX 2.1/4.1: 75% sizing in caution (was hardcoded)
  recoveryWinsRequired: 3,
  haltCooldownMs: 3600000, // 1 hour
  totalCapital: 0n, // Must be set by caller
  enabled: true,
};

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get current UTC date string (YYYY-MM-DD)
 */
function getCurrentDateUTC(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Create initial state
 */
function createInitialState(totalCapital: bigint): DrawdownState {
  return {
    state: 'NORMAL',
    dailyPnL: 0n,
    consecutiveLosses: 0,
    consecutiveWins: 0,
    lastStateChange: Date.now(),
    haltStartTime: null,
    currentDateUTC: getCurrentDateUTC(),
    totalPnL: 0n,
    peakCapital: totalCapital,
    currentDrawdown: 0,
    maxDrawdown: 0,
  };
}

// =============================================================================
// DrawdownCircuitBreaker Class
// =============================================================================

export class DrawdownCircuitBreaker {
  private config: DrawdownConfig;
  private state: DrawdownState;
  private stats: {
    totalTrades: number;
    totalWins: number;
    totalLosses: number;
    haltCount: number;
    cautionCount: number;
    totalHaltTimeMs: number;
    lastHaltEndTime: number | null;
  };
  // FIX 10.4: Cache daily reset check to avoid expensive ISO string creation on every call
  private cachedDateExpiry = 0;
  private static readonly DATE_CACHE_TTL_MS = 60000; // Check every 60s max

  constructor(config: Partial<DrawdownConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Validate configuration
    this.validateConfig();

    this.state = createInitialState(this.config.totalCapital);
    this.stats = {
      totalTrades: 0,
      totalWins: 0,
      totalLosses: 0,
      haltCount: 0,
      cautionCount: 0,
      totalHaltTimeMs: 0,
      lastHaltEndTime: null,
    };

    logger.info('DrawdownCircuitBreaker initialized', {
      maxDailyLoss: `${this.config.maxDailyLoss * 100}%`,
      cautionThreshold: `${this.config.cautionThreshold * 100}%`,
      cautionMultiplier: `${this.config.cautionMultiplier * 100}%`,
      maxConsecutiveLosses: this.config.maxConsecutiveLosses,
      enabled: this.config.enabled,
    });
  }

  /**
   * Validate configuration values
   */
  private validateConfig(): void {
    if (this.config.maxDailyLoss <= 0 || this.config.maxDailyLoss > 1) {
      throw new Error('maxDailyLoss must be between 0 and 1');
    }
    if (this.config.cautionThreshold <= 0 || this.config.cautionThreshold >= this.config.maxDailyLoss) {
      throw new Error('cautionThreshold must be between 0 and maxDailyLoss');
    }
    if (this.config.maxConsecutiveLosses < 1) {
      throw new Error('maxConsecutiveLosses must be at least 1');
    }
    if (this.config.recoveryMultiplier <= 0 || this.config.recoveryMultiplier > 1) {
      throw new Error('recoveryMultiplier must be between 0 and 1');
    }
    // FIX 2.1/4.1: Validate cautionMultiplier
    if (this.config.cautionMultiplier <= 0 || this.config.cautionMultiplier > 1) {
      throw new Error('cautionMultiplier must be between 0 and 1');
    }
    if (this.config.recoveryWinsRequired < 1) {
      throw new Error('recoveryWinsRequired must be at least 1');
    }
    // Note: totalCapital of 0 is allowed but will log a warning
    if (this.config.totalCapital === 0n && this.config.enabled) {
      logger.warn('DrawdownCircuitBreaker: totalCapital is 0, drawdown calculations will be disabled');
    }
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Check if trading is allowed based on current state.
   * Call this before executing any trade.
   */
  isTradingAllowed(): TradingAllowedResult {
    // Check for daily reset first
    this.checkDailyReset();

    // If disabled, always allow with full sizing
    if (!this.config.enabled) {
      return {
        allowed: true,
        state: this.state.state,
        sizeMultiplier: 1.0,
      };
    }

    switch (this.state.state) {
      case 'NORMAL':
        return {
          allowed: true,
          state: 'NORMAL',
          sizeMultiplier: 1.0,
        };

      case 'CAUTION':
        // FIX 2.1/4.1: Use configured cautionMultiplier instead of hardcoded 0.75
        return {
          allowed: true,
          state: 'CAUTION',
          sizeMultiplier: this.config.cautionMultiplier,
          reason: 'Daily loss approaching threshold - reduced position sizing',
        };

      case 'HALT': {
        const cooldownRemaining = this.getHaltCooldownRemaining();
        return {
          allowed: false,
          state: 'HALT',
          sizeMultiplier: 0,
          reason: `Trading halted due to excessive drawdown. Cooldown: ${Math.ceil(cooldownRemaining / 1000)}s remaining`,
          haltCooldownRemaining: cooldownRemaining,
        };
      }

      case 'RECOVERY':
        return {
          allowed: true,
          state: 'RECOVERY',
          sizeMultiplier: this.config.recoveryMultiplier,
          reason: `Recovery mode - ${this.config.recoveryWinsRequired - this.state.consecutiveWins} wins needed to exit`,
        };

      default:
        // Should never happen, but defensive
        return {
          allowed: false,
          state: this.state.state,
          sizeMultiplier: 0,
          reason: 'Unknown state',
        };
    }
  }

  /**
   * Record a trade result and update state machine.
   * Call this after every trade completes.
   */
  recordTradeResult(result: TradeResult): void {
    // Check for daily reset first
    this.checkDailyReset();

    // Update stats
    this.stats.totalTrades++;
    if (result.success) {
      this.stats.totalWins++;
    } else {
      this.stats.totalLosses++;
    }

    // Update state
    this.state.dailyPnL += result.pnl;
    this.state.totalPnL += result.pnl;

    // Update consecutive counters
    if (result.success) {
      this.state.consecutiveWins++;
      this.state.consecutiveLosses = 0;
    } else {
      this.state.consecutiveLosses++;
      this.state.consecutiveWins = 0;
    }

    // Update drawdown tracking
    this.updateDrawdownTracking();

    // Evaluate state transitions
    this.evaluateStateTransition();

    logger.debug('Trade result recorded', {
      success: result.success,
      pnl: result.pnl.toString(),
      dailyPnL: this.state.dailyPnL.toString(),
      state: this.state.state,
      consecutiveLosses: this.state.consecutiveLosses,
    });
  }

  /**
   * Manually reset from HALT state after cooldown.
   * Returns true if reset was successful.
   */
  manualReset(): boolean {
    if (this.state.state !== 'HALT') {
      logger.warn('Manual reset attempted but not in HALT state', {
        currentState: this.state.state,
      });
      return false;
    }

    const cooldownRemaining = this.getHaltCooldownRemaining();
    if (cooldownRemaining > 0) {
      logger.warn('Manual reset attempted but cooldown not expired', {
        cooldownRemainingMs: cooldownRemaining,
      });
      return false;
    }

    // Transition to RECOVERY
    this.transitionTo('RECOVERY');

    // Track halt duration
    if (this.state.haltStartTime) {
      this.stats.totalHaltTimeMs += Date.now() - this.state.haltStartTime;
      this.stats.lastHaltEndTime = Date.now();
    }
    this.state.haltStartTime = null;

    logger.info('Manual reset successful - entering RECOVERY state');
    return true;
  }

  /**
   * Force reset to NORMAL state (for testing or emergency).
   * WARNING: This bypasses all safety checks.
   */
  forceReset(): void {
    logger.warn('Force reset triggered - bypassing all safety checks');

    if (this.state.state === 'HALT' && this.state.haltStartTime) {
      this.stats.totalHaltTimeMs += Date.now() - this.state.haltStartTime;
    }

    this.state = createInitialState(this.config.totalCapital);
    // FIX 10.4: Clear the date cache on reset to ensure fresh check
    this.cachedDateExpiry = 0;
  }

  /**
   * Update total capital (e.g., after deposit/withdrawal).
   */
  updateCapital(newCapital: bigint): void {
    this.config.totalCapital = newCapital;

    // Update peak if new capital is higher
    if (newCapital > this.state.peakCapital) {
      this.state.peakCapital = newCapital;
    }

    // Recalculate drawdown
    this.updateDrawdownTracking();

    logger.info('Capital updated', {
      newCapital: newCapital.toString(),
      peakCapital: this.state.peakCapital.toString(),
    });
  }

  /**
   * Get current state (read-only copy)
   */
  getState(): Readonly<DrawdownState> {
    this.checkDailyReset();
    return { ...this.state };
  }

  /**
   * Get statistics
   */
  getStats(): DrawdownStats {
    const capital = this.config.totalCapital;
    const dailyPnLFraction = capital > 0n
      ? Number(this.state.dailyPnL * 10000n / capital) / 10000
      : 0;

    return {
      currentState: this.state.state,
      dailyPnL: this.state.dailyPnL,
      dailyPnLFraction,
      totalPnL: this.state.totalPnL,
      currentDrawdown: this.state.currentDrawdown,
      maxDrawdown: this.state.maxDrawdown,
      totalTrades: this.stats.totalTrades,
      totalWins: this.stats.totalWins,
      totalLosses: this.stats.totalLosses,
      haltCount: this.stats.haltCount,
      cautionCount: this.stats.cautionCount,
      totalHaltTimeMs: this.stats.totalHaltTimeMs,
    };
  }

  /**
   * Get configuration (read-only copy)
   */
  getConfig(): Readonly<DrawdownConfig> {
    return { ...this.config };
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Check if we've crossed into a new UTC day and reset if so.
   * FIX 10.4: Uses caching to avoid expensive ISO string creation on every call.
   */
  private checkDailyReset(): void {
    const now = Date.now();
    // Skip expensive date check if we recently checked (within TTL)
    if (now < this.cachedDateExpiry) {
      return;
    }
    // Update cache expiry for next check
    this.cachedDateExpiry = now + DrawdownCircuitBreaker.DATE_CACHE_TTL_MS;

    const currentDate = getCurrentDateUTC();
    if (currentDate !== this.state.currentDateUTC) {
      logger.info('Daily reset triggered', {
        previousDate: this.state.currentDateUTC,
        newDate: currentDate,
        previousDailyPnL: this.state.dailyPnL.toString(),
      });

      this.state.currentDateUTC = currentDate;
      this.state.dailyPnL = 0n;

      // If we were in CAUTION, return to NORMAL on new day
      if (this.state.state === 'CAUTION') {
        this.transitionTo('NORMAL');
      }
      // Note: HALT and RECOVERY persist across days
    }
  }

  /**
   * Update drawdown tracking based on current capital + PnL
   */
  private updateDrawdownTracking(): void {
    if (this.config.totalCapital === 0n) {
      return; // Cannot calculate drawdown without capital
    }

    const currentCapital = this.config.totalCapital + this.state.totalPnL;

    // Update peak if current is higher
    if (currentCapital > this.state.peakCapital) {
      this.state.peakCapital = currentCapital;
      this.state.currentDrawdown = 0;
    } else if (this.state.peakCapital > 0n) {
      // Calculate drawdown from peak
      const drawdownWei = this.state.peakCapital - currentCapital;
      this.state.currentDrawdown = Number(drawdownWei * 10000n / this.state.peakCapital) / 10000;
    }

    // Update max drawdown
    if (this.state.currentDrawdown > this.state.maxDrawdown) {
      this.state.maxDrawdown = this.state.currentDrawdown;
    }
  }

  /**
   * Evaluate and perform state transitions based on current conditions.
   */
  private evaluateStateTransition(): void {
    if (!this.config.enabled || this.config.totalCapital === 0n) {
      return; // Cannot evaluate without capital
    }

    const dailyLossFraction = this.state.dailyPnL < 0n
      ? Number(-this.state.dailyPnL * 10000n / this.config.totalCapital) / 10000
      : 0;

    switch (this.state.state) {
      case 'NORMAL':
        // Check for CAUTION transition
        if (dailyLossFraction >= this.config.cautionThreshold) {
          this.transitionTo('CAUTION');
          this.stats.cautionCount++;
        }
        break;

      case 'CAUTION':
        // Check for HALT transition
        if (dailyLossFraction >= this.config.maxDailyLoss) {
          this.transitionTo('HALT');
          this.stats.haltCount++;
          this.state.haltStartTime = Date.now();
        } else if (this.state.consecutiveLosses >= this.config.maxConsecutiveLosses) {
          this.transitionTo('HALT');
          this.stats.haltCount++;
          this.state.haltStartTime = Date.now();
          logger.warn('HALT triggered by consecutive losses', {
            consecutiveLosses: this.state.consecutiveLosses,
            maxAllowed: this.config.maxConsecutiveLosses,
          });
        }
        break;

      case 'RECOVERY':
        // Check for return to NORMAL
        if (this.state.consecutiveWins >= this.config.recoveryWinsRequired) {
          this.transitionTo('NORMAL');
          logger.info('Recovery complete - returning to NORMAL trading');
        }
        break;

      case 'HALT':
        // HALT can only be exited via manual reset
        break;
    }
  }

  /**
   * Transition to a new state with logging.
   */
  private transitionTo(newState: DrawdownStateType): void {
    const previousState = this.state.state;
    this.state.state = newState;
    this.state.lastStateChange = Date.now();

    logger.info('State transition', {
      from: previousState,
      to: newState,
      dailyPnL: this.state.dailyPnL.toString(),
      consecutiveLosses: this.state.consecutiveLosses,
      currentDrawdown: `${(this.state.currentDrawdown * 100).toFixed(2)}%`,
    });
  }

  /**
   * Get remaining cooldown time for HALT state.
   */
  private getHaltCooldownRemaining(): number {
    if (this.state.state !== 'HALT' || !this.state.haltStartTime) {
      return 0;
    }

    const elapsed = Date.now() - this.state.haltStartTime;
    return Math.max(0, this.config.haltCooldownMs - elapsed);
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let breakerInstance: DrawdownCircuitBreaker | null = null;
let initializingBreaker = false;

/**
 * Get singleton DrawdownCircuitBreaker instance.
 *
 * @param config - Configuration (only used on first call)
 * @throws Error if called during initialization (race condition prevention)
 */
export function getDrawdownCircuitBreaker(config?: Partial<DrawdownConfig>): DrawdownCircuitBreaker {
  if (breakerInstance) {
    if (config) {
      logger.warn('getDrawdownCircuitBreaker called with config but instance exists; config ignored');
    }
    return breakerInstance;
  }

  if (initializingBreaker) {
    throw new Error('DrawdownCircuitBreaker is being initialized by another caller');
  }

  initializingBreaker = true;
  try {
    if (!breakerInstance) {
      breakerInstance = new DrawdownCircuitBreaker(config);
    }
    return breakerInstance;
  } finally {
    initializingBreaker = false;
  }
}

/**
 * Reset singleton instance (for testing).
 */
export function resetDrawdownCircuitBreaker(): void {
  initializingBreaker = false;
  breakerInstance = null;
}
