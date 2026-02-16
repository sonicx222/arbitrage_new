/**
 * Circuit Breaker Manager
 *
 * Extracted from engine.ts to reduce file complexity.
 * Manages circuit breaker lifecycle:
 * - Initialization from config
 * - State change event handling and Redis Stream publishing
 * - Public API for status queries and manual overrides
 *
 * Hot-path note:
 * - Initialization is NOT on hot path (called once during start())
 * - State change handler is NOT on hot path (async, rare events)
 * - getCircuitBreaker() returns direct reference for O(1) hot-path usage
 *   in processQueueItems() and executeOpportunity()
 *
 * @see engine.ts (consumer)
 * @see services/circuit-breaker.ts (implementation)
 */

import {
  getErrorMessage,
  RedisStreamsClient,
} from '@arbitrage/core';
import {
  createCircuitBreaker,
  type CircuitBreaker,
  type CircuitBreakerEvent,
  type CircuitBreakerStatus,
} from './circuit-breaker';
import type { CircuitBreakerConfig, ExecutionStats, Logger } from '../types';

/**
 * Dependencies for CircuitBreakerManager construction.
 */
export interface CircuitBreakerManagerDeps {
  config: Required<CircuitBreakerConfig>;
  logger: Logger;
  stats: ExecutionStats;
  instanceId: string;
  /** Getter for nullable streams client (may disconnect during shutdown) */
  getStreamsClient: () => RedisStreamsClient | null;
}

/**
 * Manages circuit breaker lifecycle and event handling.
 *
 * Performance Note:
 * - getCircuitBreaker() returns direct reference for O(1) hot-path access
 * - No allocations, no blocking operations in hot-path calls
 * - Event publishing is async and non-blocking
 */
export class CircuitBreakerManager {
  private circuitBreaker: CircuitBreaker | null = null;

  private readonly config: Required<CircuitBreakerConfig>;
  private readonly logger: Logger;
  private readonly stats: ExecutionStats;
  private readonly instanceId: string;
  private readonly getStreamsClient: () => RedisStreamsClient | null;

  constructor(deps: CircuitBreakerManagerDeps) {
    this.config = deps.config;
    this.logger = deps.logger;
    this.stats = deps.stats;
    this.instanceId = deps.instanceId;
    this.getStreamsClient = deps.getStreamsClient;
  }

  /**
   * Initialize circuit breaker for execution protection.
   *
   * Creates a circuit breaker that:
   * - Halts execution after consecutive failures (prevents capital drain)
   * - Emits state change events to Redis Stream for monitoring
   * - Uses configurable threshold and cooldown period
   *
   * @see services/circuit-breaker.ts for implementation details
   */
  initialize(): void {
    if (!this.config.enabled) {
      this.logger.info('Circuit breaker disabled by configuration');
      return;
    }

    this.circuitBreaker = createCircuitBreaker({
      logger: this.logger,
      failureThreshold: this.config.failureThreshold,
      cooldownPeriodMs: this.config.cooldownPeriodMs,
      halfOpenMaxAttempts: this.config.halfOpenMaxAttempts,
      enabled: this.config.enabled,
      onStateChange: (event: CircuitBreakerEvent) => {
        this.handleStateChange(event);
      },
    });

    this.logger.info('Circuit breaker initialized', {
      failureThreshold: this.config.failureThreshold,
      cooldownPeriodMs: this.config.cooldownPeriodMs,
      halfOpenMaxAttempts: this.config.halfOpenMaxAttempts,
    });
  }

  /**
   * Get the circuit breaker instance for direct hot-path usage.
   *
   * Engine's processQueueItems() and executeOpportunity() use this
   * for O(1) canExecute()/recordSuccess()/recordFailure() calls.
   */
  getCircuitBreaker(): CircuitBreaker | null {
    return this.circuitBreaker;
  }

  // ===========================================================================
  // Public API (delegated from engine getters)
  // ===========================================================================

  /** Get circuit breaker status snapshot. Returns null if disabled. */
  getStatus(): CircuitBreakerStatus | null {
    return this.circuitBreaker?.getStatus() ?? null;
  }

  /** Check if circuit breaker is currently open (blocking executions). */
  isOpen(): boolean {
    return this.circuitBreaker?.isOpen() ?? false;
  }

  /** Get circuit breaker configuration. */
  getConfig(): Readonly<Required<CircuitBreakerConfig>> {
    return this.config;
  }

  /**
   * Force close the circuit breaker (manual override).
   * Use with caution — this bypasses the protection mechanism.
   */
  forceClose(): void {
    if (this.circuitBreaker) {
      this.logger.warn('Manually force-closing circuit breaker');
      this.circuitBreaker.forceClose();
    }
  }

  /**
   * Force open the circuit breaker (manual override).
   * Useful for emergency stops or maintenance.
   */
  forceOpen(reason = 'manual override'): void {
    if (this.circuitBreaker) {
      this.logger.warn('Manually force-opening circuit breaker', { reason });
      this.circuitBreaker.forceOpen(reason);
    }
  }

  // ===========================================================================
  // Event Handling (NOT on hot path — async, rare events)
  // ===========================================================================

  /**
   * Handle circuit breaker state change events.
   * Publishes events to Redis Stream for monitoring and alerting.
   */
  private handleStateChange(event: CircuitBreakerEvent): void {
    // Log state change
    if (event.newState === 'OPEN') {
      this.logger.warn('Circuit breaker OPENED - halting executions', {
        reason: event.reason,
        consecutiveFailures: event.consecutiveFailures,
        cooldownRemainingMs: event.cooldownRemainingMs,
      });
      this.stats.circuitBreakerTrips++;
    } else if (event.newState === 'CLOSED') {
      this.logger.info('Circuit breaker CLOSED - resuming executions', {
        reason: event.reason,
      });
    } else if (event.newState === 'HALF_OPEN') {
      this.logger.info('Circuit breaker HALF_OPEN - testing recovery', {
        reason: event.reason,
      });
    }

    // Publish event to Redis Stream for monitoring (fire-and-forget, internally error-handled)
    void this.publishEvent(event);
  }

  /**
   * Publish circuit breaker event to Redis Stream.
   *
   * Events are published to stream:circuit-breaker for:
   * - Monitoring dashboards
   * - Alerting systems
   * - Audit trail
   */
  private async publishEvent(event: CircuitBreakerEvent): Promise<void> {
    const streamsClient = this.getStreamsClient();
    if (!streamsClient) return;

    try {
      await streamsClient.xadd(RedisStreamsClient.STREAMS.CIRCUIT_BREAKER, {
        service: 'execution-engine',
        instanceId: this.instanceId,
        previousState: event.previousState,
        newState: event.newState,
        reason: event.reason,
        timestamp: event.timestamp,
        consecutiveFailures: event.consecutiveFailures,
        cooldownRemainingMs: event.cooldownRemainingMs,
      });
    } catch (error) {
      this.logger.error('Failed to publish circuit breaker event', {
        error: getErrorMessage(error),
        event,
      });
    }
  }
}

/**
 * Factory function for CircuitBreakerManager.
 * Follows codebase convention of factory functions for DI.
 */
export function createCircuitBreakerManager(
  deps: CircuitBreakerManagerDeps,
): CircuitBreakerManager {
  return new CircuitBreakerManager(deps);
}
