// Circuit Breaker Pattern Implementation for Resilience
//
// P0-1 FIX: Added mutex lock for thread-safe state transitions
// P0-2 FIX: Replaced console.log with structured logger
// P2-2 FIX: Added monitoring period window for failure tracking
// P0-3 FIX: Use AsyncMutex for truly atomic HALF_OPEN state transition

import { createLogger } from '../logger';
import { AsyncMutex } from '../async/async-mutex';
import type { ServiceLogger } from '../logging';

// =============================================================================
// Dependency Injection Interfaces
// =============================================================================

/**
 * Dependencies for CircuitBreaker (DI pattern).
 * Enables proper testing without Jest mock hoisting issues.
 *
 * Note: CircuitBreakerLogger type alias was removed. Use ServiceLogger directly.
 */
export interface CircuitBreakerDeps {
  logger?: ServiceLogger;
}

// Default logger (used when deps not provided)
const defaultLogger = createLogger('circuit-breaker');

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN'
}

export interface CircuitBreakerConfig {
  failureThreshold: number;      // Number of failures before opening
  recoveryTimeout: number;       // Time in ms before attempting recovery
  monitoringPeriod: number;      // Time window for failure counting
  successThreshold: number;      // Number of successes needed in HALF_OPEN
  name: string;                  // Identifier for logging
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime: number;
  lastSuccessTime: number;
  totalRequests: number;
  totalFailures: number;
  totalSuccesses: number;
  /** P2-2 FIX: Failures within current monitoring window */
  windowFailures: number;
}

export class CircuitBreakerError extends Error {
  constructor(
    message: string,
    public readonly circuitName: string,
    public readonly state: CircuitState
  ) {
    super(message);
    this.name = 'CircuitBreakerError';
  }
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures = 0;
  private successes = 0;
  private lastFailureTime = 0;
  private lastSuccessTime = 0;
  private totalRequests = 0;
  private totalFailures = 0;
  private totalSuccesses = 0;
  private nextAttemptTime = 0;
  private logger: ServiceLogger;

  // P0-3 FIX: AsyncMutex for truly atomic HALF_OPEN state transition
  // Prevents race condition where multiple concurrent callers could both
  // pass the state check and transition to HALF_OPEN simultaneously
  private halfOpenMutex = new AsyncMutex();
  private halfOpenInProgress = false;

  // P2-2 FIX: Track failure timestamps for monitoring window
  private failureTimestamps: number[] = [];

  constructor(private config: CircuitBreakerConfig, deps?: CircuitBreakerDeps) {
    // DI: Use provided logger or default
    this.logger = deps?.logger ?? defaultLogger;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    this.totalRequests++;

    // P0-1 FIX: Thread-safe state check and transition
    if (this.state === CircuitState.OPEN) {
      if (Date.now() < this.nextAttemptTime) {
        throw new CircuitBreakerError(
          `Circuit breaker is OPEN for ${this.config.name}`,
          this.config.name,
          this.state
        );
      }

      // P0-3 FIX: Use AsyncMutex.tryAcquire for truly atomic state transition
      // This prevents the race condition where multiple callers could both read
      // halfOpenInProgress === false before either sets it to true
      const release = this.halfOpenMutex.tryAcquire();

      if (!release) {
        // Another request is already transitioning to HALF_OPEN
        throw new CircuitBreakerError(
          `Circuit breaker is testing recovery for ${this.config.name}`,
          this.config.name,
          CircuitState.HALF_OPEN
        );
      }

      // We acquired the mutex - we're the one to transition
      // Check again in case another caller completed while we waited
      if (this.halfOpenInProgress) {
        release();
        throw new CircuitBreakerError(
          `Circuit breaker is testing recovery for ${this.config.name}`,
          this.config.name,
          CircuitState.HALF_OPEN
        );
      }

      // Atomically set flag and transition state while holding mutex
      this.halfOpenInProgress = true;
      this.state = CircuitState.HALF_OPEN;
      this.successes = 0; // Reset success counter for HALF_OPEN
      release(); // Release mutex after state is set

      // P0-2 FIX: Use structured logger
      this.logger.info('Circuit breaker transitioning to HALF_OPEN', {
        name: this.config.name,
        recoveryTimeout: this.config.recoveryTimeout
      });
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.successes++;
    this.lastSuccessTime = Date.now();
    this.totalSuccesses++;

    if (this.state === CircuitState.HALF_OPEN) {
      if (this.successes >= this.config.successThreshold) {
        // Circuit is healthy again
        this.state = CircuitState.CLOSED;
        this.failures = 0;
        this.successes = 0;
        this.halfOpenInProgress = false; // P0-1 FIX: Reset flag
        this.failureTimestamps = []; // P2-2 FIX: Clear failure history

        // P0-2 FIX: Use structured logger
        this.logger.info('Circuit breaker transitioned to CLOSED', {
          name: this.config.name,
          successThreshold: this.config.successThreshold
        });
      }
    }
  }

  private onFailure(): void {
    const now = Date.now();
    this.failures++;
    this.lastFailureTime = now;
    this.totalFailures++;

    // P2-2 FIX: Track failure within monitoring window
    this.failureTimestamps.push(now);
    this.pruneOldFailures();

    if (this.state === CircuitState.HALF_OPEN) {
      // Back to OPEN on any failure in HALF_OPEN
      this.state = CircuitState.OPEN;
      this.nextAttemptTime = now + this.config.recoveryTimeout;
      this.successes = 0;
      this.halfOpenInProgress = false; // P0-1 FIX: Reset flag

      // P0-2 FIX: Use structured logger
      this.logger.warn('Circuit breaker back to OPEN after failure in HALF_OPEN', {
        name: this.config.name,
        recoveryTimeout: this.config.recoveryTimeout
      });
    } else if (this.state === CircuitState.CLOSED) {
      // P2-2 FIX: Check failures within monitoring window, not total
      const windowFailures = this.getWindowFailureCount();

      if (windowFailures >= this.config.failureThreshold) {
        this.state = CircuitState.OPEN;
        this.nextAttemptTime = now + this.config.recoveryTimeout;

        // P0-2 FIX: Use structured logger
        this.logger.warn('Circuit breaker opened due to failures', {
          name: this.config.name,
          windowFailures,
          failureThreshold: this.config.failureThreshold,
          monitoringPeriod: this.config.monitoringPeriod
        });
      }
    }
  }

  /**
   * P2-2 FIX: Remove failures older than monitoring period.
   * Timestamps are appended in order, so oldest are always at the front.
   * Uses a single splice to remove all expired entries in O(n) instead of
   * per-element shift() which is O(k*n) when k entries are pruned.
   */
  private pruneOldFailures(): void {
    const cutoff = Date.now() - this.config.monitoringPeriod;
    // Binary-style scan from front: find first entry that's still valid
    let firstValid = 0;
    while (firstValid < this.failureTimestamps.length && this.failureTimestamps[firstValid] <= cutoff) {
      firstValid++;
    }
    if (firstValid > 0) {
      this.failureTimestamps.splice(0, firstValid);
    }
  }

  /**
   * P2-2 FIX: Get failure count within monitoring window
   */
  private getWindowFailureCount(): number {
    this.pruneOldFailures();
    return this.failureTimestamps.length;
  }

  getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
      windowFailures: this.getWindowFailureCount() // P2-2 FIX: Include window failures
    };
  }

  getState(): CircuitState {
    return this.state;
  }

  // Manual state control for testing/administration
  forceOpen(reason?: string): void {
    const previousState = this.state;
    this.state = CircuitState.OPEN;
    this.nextAttemptTime = Date.now() + this.config.recoveryTimeout;
    this.halfOpenInProgress = false;

    // P2-25 FIX: Audit logging with previous state and reason for manual override
    this.logger.warn('Circuit breaker manually opened', {
      name: this.config.name,
      previousState,
      reason: reason ?? 'manual_override',
      failures: this.failures,
      windowFailures: this.failureTimestamps.length
    });
  }

  forceClose(reason?: string): void {
    const previousState = this.state;
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.halfOpenInProgress = false;
    this.failureTimestamps = [];

    // P2-25 FIX: Audit logging with previous state and reason for manual override
    this.logger.info('Circuit breaker manually closed', {
      name: this.config.name,
      previousState,
      reason: reason ?? 'manual_override'
    });
  }

  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = 0;
    this.lastSuccessTime = 0;
    this.totalRequests = 0;
    this.totalFailures = 0;
    this.totalSuccesses = 0;
    this.nextAttemptTime = 0;
    this.halfOpenInProgress = false;
    this.failureTimestamps = [];

    // P0-2 FIX: Use structured logger
    this.logger.info('Circuit breaker reset', {
      name: this.config.name
    });
  }
}

// Circuit Breaker Registry for managing multiple breakers
export class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();

  createBreaker(name: string, config: Omit<CircuitBreakerConfig, 'name'>): CircuitBreaker {
    if (this.breakers.has(name)) {
      throw new Error(`Circuit breaker ${name} already exists`);
    }

    const breaker = new CircuitBreaker({ ...config, name });
    this.breakers.set(name, breaker);
    return breaker;
  }

  getBreaker(name: string): CircuitBreaker | undefined {
    return this.breakers.get(name);
  }

  /**
   * Get or create a breaker with specified config.
   * If breaker exists, returns existing instance (ignores config).
   */
  getOrCreateBreaker(name: string, config: Omit<CircuitBreakerConfig, 'name'>): CircuitBreaker {
    const existing = this.breakers.get(name);
    if (existing) {
      return existing;
    }
    return this.createBreaker(name, config);
  }

  getAllStats(): Record<string, CircuitBreakerStats> {
    const stats: Record<string, CircuitBreakerStats> = {};
    for (const [name, breaker] of this.breakers) {
      stats[name] = breaker.getStats();
    }
    return stats;
  }

  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }

  /**
   * Remove a breaker from the registry.
   */
  removeBreaker(name: string): boolean {
    return this.breakers.delete(name);
  }

  /**
   * Clear all breakers from the registry.
   */
  clearAll(): void {
    this.breakers.clear();
  }
}

// Global registry instance
let globalRegistry: CircuitBreakerRegistry | null = null;

export function getCircuitBreakerRegistry(): CircuitBreakerRegistry {
  if (!globalRegistry) {
    globalRegistry = new CircuitBreakerRegistry();
  }
  return globalRegistry;
}

/**
 * Reset the global registry (for testing).
 */
export function resetCircuitBreakerRegistry(): void {
  if (globalRegistry) {
    globalRegistry.clearAll();
  }
  globalRegistry = null;
}

// Convenience functions
export function createCircuitBreaker(name: string, config: Omit<CircuitBreakerConfig, 'name'>): CircuitBreaker {
  return getCircuitBreakerRegistry().createBreaker(name, config);
}

export async function withCircuitBreaker<T>(
  operation: () => Promise<T>,
  breakerName: string,
  config?: Partial<CircuitBreakerConfig>
): Promise<T> {
  const registry = getCircuitBreakerRegistry();

  // Use getOrCreateBreaker to avoid "already exists" error
  const breaker = registry.getOrCreateBreaker(breakerName, {
    failureThreshold: 5,
    recoveryTimeout: 60000,
    monitoringPeriod: 60000,
    successThreshold: 3,
    ...config
  });

  return breaker.execute(operation);
}
