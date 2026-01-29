/**
 * Simple Circuit Breaker
 *
 * A lightweight circuit breaker implementation for basic failure tracking.
 * Use this for simple use cases that don't need the full state machine
 * (CLOSED/OPEN/HALF_OPEN) of the execution-engine's CircuitBreaker.
 *
 * This replaces inline circuit breaker patterns found in:
 * - services/coordinator/src/coordinator.ts (executionCircuitBreaker)
 * - services/partition-solana/src/arbitrage-detector.ts (circuitBreaker)
 *
 * For more sophisticated needs (half-open state, metrics, events), use:
 * - services/execution-engine/src/services/circuit-breaker.ts
 *
 * @example
 * ```typescript
 * const breaker = new SimpleCircuitBreaker(5, 60000); // 5 failures, 1 min cooldown
 *
 * if (breaker.isCurrentlyOpen()) {
 *   return; // Skip operation
 * }
 *
 * try {
 *   await performOperation();
 *   breaker.recordSuccess();
 * } catch (error) {
 *   if (breaker.recordFailure()) {
 *     logger.warn('Circuit breaker opened', { failures: breaker.getFailures() });
 *   }
 * }
 * ```
 */

export interface SimpleCircuitBreakerOptions {
  /** Number of consecutive failures before opening the circuit (default: 5) */
  threshold?: number;
  /** Time in ms before attempting recovery (default: 60000) */
  resetTimeoutMs?: number;
}

export interface SimpleCircuitBreakerStatus {
  /** Current failure count */
  failures: number;
  /** Whether the circuit is open (blocking operations) */
  isOpen: boolean;
  /** Timestamp of last failure (0 if none) */
  lastFailure: number;
  /** Configured failure threshold */
  threshold: number;
  /** Configured reset timeout in ms */
  resetTimeoutMs: number;
}

/**
 * Lightweight circuit breaker for simple failure tracking.
 *
 * States:
 * - Closed (isOpen=false): Operations allowed
 * - Open (isOpen=true): Operations blocked until cooldown expires
 *
 * Unlike the full CircuitBreaker, this doesn't have a HALF_OPEN state.
 * After cooldown, it automatically allows one attempt and resets if successful.
 */
export class SimpleCircuitBreaker {
  private failures = 0;
  private isOpen = false;
  private lastFailure = 0;
  private readonly threshold: number;
  private readonly resetTimeoutMs: number;

  constructor(threshold = 5, resetTimeoutMs = 60000) {
    if (threshold < 1) {
      throw new Error('Circuit breaker threshold must be at least 1');
    }
    if (resetTimeoutMs < 0) {
      throw new Error('Circuit breaker resetTimeoutMs must be non-negative');
    }
    this.threshold = threshold;
    this.resetTimeoutMs = resetTimeoutMs;
  }

  /**
   * Check if the circuit is currently open (blocking operations).
   *
   * If the circuit is open but cooldown has expired, it's considered
   * "half-open" and will allow one attempt (returns false).
   */
  isCurrentlyOpen(): boolean {
    if (!this.isOpen) {
      return false;
    }

    // Check if cooldown has expired - allow one attempt
    const now = Date.now();
    if (now - this.lastFailure >= this.resetTimeoutMs) {
      // Cooldown expired - allow attempt (caller must call recordSuccess on success)
      return false;
    }

    return true;
  }

  /**
   * Record a failure. Returns true if this failure opened the circuit.
   *
   * @returns true if the circuit was just opened (newly tripped)
   */
  recordFailure(): boolean {
    this.failures++;
    this.lastFailure = Date.now();

    const justOpened = this.failures >= this.threshold && !this.isOpen;

    if (justOpened) {
      this.isOpen = true;
      return true;
    }

    // Keep circuit open if already open
    if (this.failures >= this.threshold) {
      this.isOpen = true;
    }

    return false;
  }

  /**
   * Record a success. Resets the circuit to closed state.
   *
   * @returns true if the circuit was just closed (recovered from open)
   */
  recordSuccess(): boolean {
    const wasOpen = this.isOpen;
    this.failures = 0;
    this.isOpen = false;
    return wasOpen;
  }

  /**
   * Reset the circuit breaker to initial state.
   */
  reset(): void {
    this.failures = 0;
    this.isOpen = false;
    this.lastFailure = 0;
  }

  /**
   * Get current failure count.
   */
  getFailures(): number {
    return this.failures;
  }

  /**
   * Get complete status snapshot.
   */
  getStatus(): SimpleCircuitBreakerStatus {
    return {
      failures: this.failures,
      isOpen: this.isOpen,
      lastFailure: this.lastFailure,
      threshold: this.threshold,
      resetTimeoutMs: this.resetTimeoutMs,
    };
  }

  /**
   * Get remaining cooldown time in ms (0 if not open or cooldown expired).
   */
  getCooldownRemaining(): number {
    if (!this.isOpen || this.lastFailure === 0) {
      return 0;
    }
    const elapsed = Date.now() - this.lastFailure;
    return Math.max(0, this.resetTimeoutMs - elapsed);
  }
}

/**
 * Factory function to create a SimpleCircuitBreaker.
 */
export function createSimpleCircuitBreaker(
  options: SimpleCircuitBreakerOptions = {}
): SimpleCircuitBreaker {
  const { threshold = 5, resetTimeoutMs = 60000 } = options;
  return new SimpleCircuitBreaker(threshold, resetTimeoutMs);
}
