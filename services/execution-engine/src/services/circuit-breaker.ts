/**
 * Circuit Breaker Service
 *
 * Phase 1.3.1: Add Circuit Breaker to Execution Engine
 *
 * Implements the circuit breaker pattern to halt execution after
 * consecutive failures, preventing capital drain during systemic issues.
 *
 * States:
 * - CLOSED: Normal operation, allowing executions
 * - OPEN: Blocking executions (after threshold consecutive failures)
 * - HALF_OPEN: Testing if system recovered (after cooldown period)
 *
 * @see implementation_plan_v2.md Task 1.3.1
 * @see https://martinfowler.com/bliki/CircuitBreaker.html
 */

import type { Logger } from '../types';
import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from '../types';
import { getErrorMessage } from '@arbitrage/core/resilience';

// =============================================================================
// Types
// =============================================================================

/**
 * Circuit breaker states
 */
export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Event emitted when circuit breaker state changes
 */
export interface CircuitBreakerEvent {
  /** Previous state before transition */
  previousState: CircuitBreakerState;
  /** New state after transition */
  newState: CircuitBreakerState;
  /** Reason for state change */
  reason: string;
  /** Timestamp of state change */
  timestamp: number;
  /** Current consecutive failure count */
  consecutiveFailures: number;
  /** Cooldown remaining in ms (if OPEN) */
  cooldownRemainingMs: number;
}

/**
 * Circuit breaker metrics
 */
export interface CircuitBreakerMetrics {
  /** Total failures recorded */
  totalFailures: number;
  /** Total successes recorded */
  totalSuccesses: number;
  /** Number of times the circuit has tripped */
  timesTripped: number;
  /** Time spent in OPEN state (ms) */
  totalOpenTimeMs: number;
  /** Last time the circuit tripped */
  lastTrippedAt: number | null;
}

/**
 * Circuit breaker status snapshot
 */
export interface CircuitBreakerStatus {
  /** Current state */
  state: CircuitBreakerState;
  /** Whether circuit breaker is enabled */
  enabled: boolean;
  /** Current consecutive failure count */
  consecutiveFailures: number;
  /** Cooldown remaining in ms (0 if not in OPEN state) */
  cooldownRemaining: number;
  /** Timestamp of last state change */
  lastStateChange: number;
  /** Current metrics */
  metrics: CircuitBreakerMetrics;
}

/**
 * Options for creating a circuit breaker instance.
 *
 * Note: This extends the public CircuitBreakerConfig from types.ts
 * with additional required fields for the factory function.
 */
export interface CircuitBreakerOptions {
  /** Logger instance */
  logger: Logger;
  /** Callback for state changes (used for Redis Stream events) */
  onStateChange: (event: CircuitBreakerEvent) => void;
  /** Number of consecutive failures before tripping (default: 5) */
  failureThreshold?: number;
  /** Cooldown period in ms before attempting recovery (default: 5 minutes) */
  cooldownPeriodMs?: number;
  /** Max attempts in HALF_OPEN state before fully closing (default: 1) */
  halfOpenMaxAttempts?: number;
  /** Whether circuit breaker is enabled (default: true) */
  enabled?: boolean;
}

/**
 * Resolved config with defaults applied
 */
export interface ResolvedCircuitBreakerConfig {
  failureThreshold: number;
  cooldownPeriodMs: number;
  halfOpenMaxAttempts: number;
  enabled: boolean;
}

/**
 * Circuit breaker public interface
 */
export interface CircuitBreaker {
  // State queries
  getState(): CircuitBreakerState;
  isOpen(): boolean;
  canExecute(): boolean;
  isEnabled(): boolean;

  // Recording outcomes
  recordFailure(): void;
  recordSuccess(): void;

  // Metrics
  getConsecutiveFailures(): number;
  getCooldownRemaining(): number;
  getMetrics(): CircuitBreakerMetrics;
  getStatus(): CircuitBreakerStatus;
  getConfig(): ResolvedCircuitBreakerConfig;

  // Manual overrides
  forceClose(): void;
  forceOpen(reason?: string): void;
  enable(): void;
  disable(): void;

  // Lifecycle
  stop(): void;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a circuit breaker instance.
 *
 * @param options - Circuit breaker options
 * @returns CircuitBreaker instance
 * @throws Error if configuration is invalid
 */
export function createCircuitBreaker(options: CircuitBreakerOptions): CircuitBreaker {
  const {
    logger,
    onStateChange,
    failureThreshold = DEFAULT_CIRCUIT_BREAKER_CONFIG.failureThreshold,
    cooldownPeriodMs = DEFAULT_CIRCUIT_BREAKER_CONFIG.cooldownPeriodMs,
    halfOpenMaxAttempts = DEFAULT_CIRCUIT_BREAKER_CONFIG.halfOpenMaxAttempts,
    enabled: initialEnabled = DEFAULT_CIRCUIT_BREAKER_CONFIG.enabled,
  } = options;

  // Validate configuration
  if (failureThreshold < 1) {
    throw new Error('Circuit breaker failureThreshold must be at least 1');
  }
  if (cooldownPeriodMs < 0) {
    throw new Error('Circuit breaker cooldownPeriodMs must be non-negative');
  }
  // Bug 4.1 Fix: Validate halfOpenMaxAttempts >= 1
  // Without this, setting halfOpenMaxAttempts = 0 would cause:
  // - canExecute() to always return false in HALF_OPEN state
  // - The circuit would never close (infinite HALF_OPEN)
  // - System would be stuck blocking all executions
  if (halfOpenMaxAttempts < 1) {
    throw new Error('Circuit breaker halfOpenMaxAttempts must be at least 1');
  }

  // Resolved config - frozen for performance (Perf 10.5)
  // Object.freeze() prevents accidental mutation and allows returning
  // the same reference from getConfig() instead of creating copies
  const resolvedConfig: Readonly<ResolvedCircuitBreakerConfig> = Object.freeze({
    failureThreshold,
    cooldownPeriodMs,
    halfOpenMaxAttempts,
    enabled: initialEnabled,
  });

  // State
  let state: CircuitBreakerState = 'CLOSED';
  let enabled = initialEnabled;
  let consecutiveFailures = 0;
  let lastStateChange = Date.now();
  let openedAt: number | null = null;
  let halfOpenAttempts = 0;

  // Metrics
  let totalFailures = 0;
  let totalSuccesses = 0;
  let timesTripped = 0;
  let totalOpenTimeMs = 0;
  let lastTrippedAt: number | null = null;

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Emit a state change event
   */
  function emitStateChange(
    previousState: CircuitBreakerState,
    newState: CircuitBreakerState,
    reason: string
  ): void {
    const event: CircuitBreakerEvent = {
      previousState,
      newState,
      reason,
      timestamp: Date.now(),
      consecutiveFailures,
      cooldownRemainingMs: getCooldownRemaining(),
    };

    try {
      onStateChange(event);
    } catch (error) {
      logger.error('Failed to emit circuit breaker event', {
        error: getErrorMessage(error),
        event,
      });
    }
  }

  /**
   * Transition to a new state
   *
   * Performance optimization: Cache Date.now() at start of function
   * to avoid multiple system calls (each Date.now() is a syscall).
   */
  function transitionTo(newState: CircuitBreakerState, reason: string): void {
    if (state === newState) return;

    // Performance: Cache timestamp once for all operations in this transition
    const now = Date.now();
    const previousState = state;

    // Track time in OPEN state
    if (previousState === 'OPEN' && openedAt !== null) {
      totalOpenTimeMs += now - openedAt;
      openedAt = null;
    }

    // Set new state
    state = newState;
    lastStateChange = now;

    // Handle state entry
    if (newState === 'OPEN') {
      openedAt = now;
      timesTripped++;
      lastTrippedAt = now;
    } else if (newState === 'HALF_OPEN') {
      halfOpenAttempts = 0;
    }

    logger.info('Circuit breaker state changed', {
      previousState,
      newState,
      reason,
      consecutiveFailures,
    });

    emitStateChange(previousState, newState, reason);
  }

  /**
   * Check if cooldown period has expired
   */
  function isCooldownExpired(): boolean {
    if (state !== 'OPEN' || openedAt === null) return true;
    return Date.now() - openedAt >= cooldownPeriodMs;
  }

  /**
   * Get remaining cooldown time in ms
   */
  function getCooldownRemaining(): number {
    if (state !== 'OPEN' || openedAt === null) return 0;
    const elapsed = Date.now() - openedAt;
    return Math.max(0, cooldownPeriodMs - elapsed);
  }

  // ===========================================================================
  // Public Methods
  // ===========================================================================

  /**
   * Get current circuit breaker state
   */
  function getState(): CircuitBreakerState {
    return state;
  }

  /**
   * Check if circuit is open (blocking executions)
   */
  function isOpen(): boolean {
    return state === 'OPEN';
  }

  /**
   * Check if execution is allowed.
   *
   * This also handles state transitions:
   * - OPEN -> HALF_OPEN after cooldown expires
   *
   * FIX-4.1: Thread-safety note
   * ===========================
   * This function is safe in Node.js single-threaded model because:
   * 1. JavaScript executes synchronously within an event loop tick
   * 2. There are no await points in this function
   * 3. The switch/case blocks execute atomically
   *
   * If this code were to be used in a multi-threaded environment (e.g., worker threads
   * sharing state), additional synchronization would be needed. For such cases,
   * consider using a mutex or converting to async with proper locking.
   *
   * The check-then-act pattern (check attempts < max, then increment) is safe here
   * because no interleaving can occur between the check and the increment.
   */
  function canExecute(): boolean {
    // Disabled circuit breaker always allows execution
    if (!enabled) return true;

    switch (state) {
      case 'CLOSED':
        return true;

      case 'OPEN':
        // Check if cooldown has expired
        if (isCooldownExpired()) {
          // FIX-4.1: Transition first, then check if we should allow this attempt
          // The transitionTo is idempotent (no-op if already HALF_OPEN)
          transitionTo('HALF_OPEN', 'Cooldown period expired - testing recovery');

          // FIX-4.1: After transition, verify we have attempt capacity
          // In Node.js single-threaded model, state is now guaranteed to be HALF_OPEN
          // (no concurrent modification possible during synchronous execution)
          if (halfOpenAttempts < halfOpenMaxAttempts) {
            halfOpenAttempts++;
            return true;
          }
          // No attempt capacity available - deny execution
          return false;
        }
        return false;

      case 'HALF_OPEN':
        // Allow limited attempts in HALF_OPEN
        // FIX-4.1: Check-then-increment is atomic in Node.js single-threaded model
        if (halfOpenAttempts < halfOpenMaxAttempts) {
          halfOpenAttempts++;
          return true;
        }
        return false;

      default:
        return false;
    }
  }

  /**
   * Check if circuit breaker is enabled
   */
  function isEnabled(): boolean {
    return enabled;
  }

  /**
   * Record a failed execution.
   *
   * Increments consecutive failure count and may trip the circuit.
   */
  function recordFailure(): void {
    totalFailures++;
    consecutiveFailures++;

    logger.debug('Circuit breaker recorded failure', {
      consecutiveFailures,
      threshold: failureThreshold,
      state,
    });

    switch (state) {
      case 'CLOSED':
        // Check if we should trip
        if (consecutiveFailures >= failureThreshold) {
          transitionTo(
            'OPEN',
            `Consecutive failures (${consecutiveFailures}) reached threshold (${failureThreshold})`
          );
        }
        break;

      case 'HALF_OPEN':
        // Failure in HALF_OPEN - go back to OPEN
        transitionTo(
          'OPEN',
          `Failure in HALF_OPEN state - system not yet recovered`
        );
        break;

      case 'OPEN':
        // Already open - just log
        logger.debug('Failure recorded while circuit OPEN', {
          consecutiveFailures,
        });
        break;
    }
  }

  /**
   * Record a successful execution.
   *
   * Resets consecutive failure count and may close the circuit.
   */
  function recordSuccess(): void {
    totalSuccesses++;

    switch (state) {
      case 'CLOSED':
        // Reset consecutive failures
        consecutiveFailures = 0;
        break;

      case 'HALF_OPEN':
        // Success in HALF_OPEN - close the circuit
        consecutiveFailures = 0;
        transitionTo('CLOSED', 'Successful execution in HALF_OPEN - system recovered');
        break;

      case 'OPEN':
        // Fix 4.3: Document edge case where success can be recorded while OPEN.
        //
        // This CAN happen legitimately in the following scenario:
        // 1. Thread A calls canExecute() → returns false (circuit OPEN)
        // 2. Cooldown expires, Thread B calls canExecute() → transitions to HALF_OPEN, returns true
        // 3. Thread A's stale execution (started before circuit opened) completes successfully
        // 4. Thread A calls recordSuccess() but circuit is now HALF_OPEN (not OPEN)
        //
        // However, if the circuit is truly in OPEN state when recordSuccess is called,
        // it means there's a logic error in the caller (executing when canExecute() was false).
        // We log and ignore rather than throw to avoid cascading failures.
        logger.debug('Success recorded while circuit OPEN (ignoring - possible stale execution)', {
          state,
          hint: 'This can occur when execution started before circuit opened',
        });
        break;
    }
  }

  /**
   * Get current consecutive failure count
   */
  function getConsecutiveFailures(): number {
    return consecutiveFailures;
  }

  /**
   * Get circuit breaker metrics
   */
  function getMetrics(): CircuitBreakerMetrics {
    // Include current OPEN time if currently open
    let currentOpenTime = totalOpenTimeMs;
    if (state === 'OPEN' && openedAt !== null) {
      currentOpenTime += Date.now() - openedAt;
    }

    return {
      totalFailures,
      totalSuccesses,
      timesTripped,
      totalOpenTimeMs: currentOpenTime,
      lastTrippedAt,
    };
  }

  /**
   * Get complete circuit breaker status
   */
  function getStatus(): CircuitBreakerStatus {
    return {
      state,
      enabled,
      consecutiveFailures,
      cooldownRemaining: getCooldownRemaining(),
      lastStateChange,
      metrics: getMetrics(),
    };
  }

  /**
   * Get resolved configuration.
   *
   * Perf 10.5: Returns the frozen config object directly instead of
   * creating a copy. This saves memory allocation on every call.
   * The object is frozen at initialization so callers cannot mutate it.
   */
  function getConfig(): Readonly<ResolvedCircuitBreakerConfig> {
    return resolvedConfig;
  }

  /**
   * Force close the circuit breaker (manual override)
   */
  function forceClose(): void {
    if (state === 'CLOSED') {
      logger.debug('forceClose called but circuit already CLOSED');
      return;
    }

    logger.warn('Circuit breaker force-closed by manual override', {
      previousState: state,
      consecutiveFailures,
    });

    consecutiveFailures = 0;
    transitionTo('CLOSED', 'Manual override: force-closed');
  }

  /**
   * Force open the circuit breaker (manual override)
   */
  function forceOpen(reason = 'manual'): void {
    if (state === 'OPEN') {
      logger.debug('forceOpen called but circuit already OPEN');
      return;
    }

    logger.warn('Circuit breaker force-opened by manual override', {
      previousState: state,
      reason,
    });

    transitionTo('OPEN', `Manual override: ${reason}`);
  }

  /**
   * Enable the circuit breaker
   */
  function enable(): void {
    if (enabled) return;

    enabled = true;
    logger.info('Circuit breaker enabled', { state });
  }

  /**
   * Disable the circuit breaker (always allows execution)
   */
  function disable(): void {
    if (!enabled) return;

    enabled = false;
    logger.warn('Circuit breaker disabled - all executions will be allowed', {
      state,
    });
  }

  /**
   * Stop the circuit breaker (cleanup)
   */
  function stop(): void {
    // Track final open time if currently open
    if (state === 'OPEN' && openedAt !== null) {
      totalOpenTimeMs += Date.now() - openedAt;
      openedAt = null;
    }

    logger.info('Circuit breaker stopped', {
      state,
      metrics: getMetrics(),
    });
  }

  // Log initialization
  logger.info('Circuit breaker initialized', {
    failureThreshold,
    cooldownPeriodMs,
    halfOpenMaxAttempts,
    enabled: initialEnabled,
  });

  return {
    // State queries
    getState,
    isOpen,
    canExecute,
    isEnabled,

    // Recording outcomes
    recordFailure,
    recordSuccess,

    // Metrics
    getConsecutiveFailures,
    getCooldownRemaining,
    getMetrics,
    getStatus,
    getConfig,

    // Manual overrides
    forceClose,
    forceOpen,
    enable,
    disable,

    // Lifecycle
    stop,
  };
}
