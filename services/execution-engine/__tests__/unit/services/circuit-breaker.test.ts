/**
 * Circuit Breaker Service Tests
 *
 * Phase 1.3.1: Add Circuit Breaker to Execution Engine
 *
 * Tests for the execution circuit breaker that halts processing
 * after consecutive failures to prevent capital drain.
 *
 * @see implementation_plan_v2.md Task 1.3.1
 */

import {
  CircuitBreaker,
  CircuitBreakerOptions,
  CircuitBreakerState,
  CircuitBreakerEvent,
  createCircuitBreaker,
} from '../../../src/services/circuit-breaker';
import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from '../../../src/types';
import { createMockLogger } from '@arbitrage/test-utils';

/**
 * Creates a mock event emitter that captures CircuitBreakerEvent emissions.
 *
 * **Mock Configuration:**
 * - `emit` is a Jest spy that captures all events
 * - `getEvents()` returns array of all emitted events
 * - `clear()` resets the events array for test isolation
 *
 * **Purpose:**
 * Allows tests to verify circuit breaker state transitions by inspecting
 * the emitted events (e.g., CLOSED → OPEN when threshold is reached).
 *
 * **Usage:**
 * ```typescript
 * const mockEventEmitter = createMockEventEmitter();
 * const cb = createCircuitBreaker({ onStateChange: mockEventEmitter.emit });
 *
 * // Trip the circuit
 * for (let i = 0; i < 5; i++) cb.recordFailure();
 *
 * // Verify state change event was emitted
 * expect(mockEventEmitter.emit).toHaveBeenCalledWith(
 *   expect.objectContaining({
 *     previousState: 'CLOSED',
 *     newState: 'OPEN'
 *   })
 * );
 * ```
 *
 * @returns Mock event emitter with event capture and inspection methods
 */
function createMockEventEmitter() {
  const events: CircuitBreakerEvent[] = [];
  return {
    emit: jest.fn((event: CircuitBreakerEvent) => {
      events.push(event);
    }),
    getEvents: () => events,
    clear: () => events.length = 0,
  };
}

/**
 * Advances Jest fake timers for testing time-dependent circuit breaker behavior.
 *
 * **Purpose:**
 * Circuit breaker uses cooldown periods and timestamps. This helper advances
 * Jest's fake timers to test cooldown expiry, HALF_OPEN transitions, etc.
 *
 * **Usage:**
 * ```typescript
 * // Trip circuit (enters OPEN state with 60s cooldown)
 * for (let i = 0; i < 5; i++) cb.recordFailure();
 *
 * // Wait for cooldown to expire
 * advanceTime(60001);
 *
 * // Should now transition to HALF_OPEN
 * expect(cb.canExecute()).toBe(true);
 * expect(cb.getState()).toBe('HALF_OPEN');
 * ```
 *
 * @param ms - Milliseconds to advance timers
 */
function advanceTime(ms: number): void {
  jest.advanceTimersByTime(ms);
}

// =============================================================================
// Test Suite
// =============================================================================

describe('CircuitBreaker', () => {
  let circuitBreaker: CircuitBreaker;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockEventEmitter: ReturnType<typeof createMockEventEmitter>;

  beforeEach(() => {
    jest.useFakeTimers();
    mockLogger = createMockLogger();
    mockEventEmitter = createMockEventEmitter();
  });

  afterEach(() => {
    circuitBreaker?.stop();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  // ===========================================================================
  // Constructor and Default Values
  // ===========================================================================

  describe('constructor and defaults', () => {
    /**
     * GIVEN: A new circuit breaker instance with no configuration
     * WHEN: The circuit breaker is created
     * THEN: It should be ready to protect executions (CLOSED state allows execution)
     *
     * **Business Value**: Ensures the circuit breaker starts in a safe state,
     * allowing executions to proceed normally until failures occur.
     */
    it('should be ready to protect executions when first created', () => {
      circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
      });

      expect(circuitBreaker.getState()).toBe('CLOSED');
      expect(circuitBreaker.isOpen()).toBe(false);
      expect(circuitBreaker.canExecute()).toBe(true);
    });

    /**
     * GIVEN: No explicit configuration is provided
     * WHEN: Creating a circuit breaker
     * THEN: Sensible defaults should be applied (5 failures, 5min cooldown, 2 attempts)
     *
     * **Business Value**: Developers can use circuit breaker with reasonable
     * protection without needing to research optimal thresholds.
     */
    it('should use sensible defaults when no configuration is provided', () => {
      circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
      });

      const config = circuitBreaker.getConfig();
      expect(config.failureThreshold).toBe(DEFAULT_CIRCUIT_BREAKER_CONFIG.failureThreshold);
      expect(config.cooldownPeriodMs).toBe(DEFAULT_CIRCUIT_BREAKER_CONFIG.cooldownPeriodMs);
      expect(config.halfOpenMaxAttempts).toBe(DEFAULT_CIRCUIT_BREAKER_CONFIG.halfOpenMaxAttempts);
    });

    /**
     * GIVEN: Custom thresholds and cooldown periods
     * WHEN: Creating a circuit breaker with explicit configuration
     * THEN: Configuration should be respected for tuning risk tolerance
     *
     * **Business Value**: Different execution contexts (e.g., testnet vs mainnet,
     * low-value vs high-value opportunities) can use appropriate risk thresholds.
     */
    it('should allow tuning failure thresholds for different risk tolerances', () => {
      circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
        failureThreshold: 10,
        cooldownPeriodMs: 60000,
        halfOpenMaxAttempts: 3,
      });

      const config = circuitBreaker.getConfig();
      expect(config.failureThreshold).toBe(10);
      expect(config.cooldownPeriodMs).toBe(60000);
      expect(config.halfOpenMaxAttempts).toBe(3);
    });

    it('should start in enabled state by default', () => {
      circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
      });

      expect(circuitBreaker.isEnabled()).toBe(true);
    });

    /**
     * GIVEN: Configuration with enabled=false
     * WHEN: Creating a circuit breaker
     * THEN: Circuit breaker should always allow execution (bypass mode for testing)
     *
     * **Business Value**: Allows testing execution logic without circuit breaker
     * interference, useful for debugging specific failures.
     */
    it('should allow creating a bypassed circuit breaker for testing', () => {
      circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
        enabled: false,
      });

      expect(circuitBreaker.isEnabled()).toBe(false);
      // Disabled circuit breaker always allows execution
      expect(circuitBreaker.canExecute()).toBe(true);
    });
  });

  // ===========================================================================
  // Failure Tracking
  // ===========================================================================

  describe('failure tracking', () => {
    beforeEach(() => {
      circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
        failureThreshold: 5,
        cooldownPeriodMs: 300000, // 5 minutes
      });
    });

    /**
     * GIVEN: Circuit breaker is recording execution failures
     * WHEN: Multiple failures occur in sequence
     * THEN: Consecutive failure count should increment to detect threshold approach
     *
     * **Business Value**: Tracks failure progression to determine when to halt
     * executions and prevent capital drain.
     */
    it('should count failures to detect when threshold is approaching', () => {
      circuitBreaker.recordFailure();
      expect(circuitBreaker.getConsecutiveFailures()).toBe(1);

      circuitBreaker.recordFailure();
      expect(circuitBreaker.getConsecutiveFailures()).toBe(2);
    });

    /**
     * GIVEN: Circuit breaker has tracked some failures
     * WHEN: A successful execution is recorded
     * THEN: Failure history should be cleared (problem is resolved)
     *
     * **Business Value**: Allows system to recover naturally when executions
     * succeed, without manual intervention. One success indicates the underlying
     * issue (e.g., network instability, gas price spike) has resolved.
     */
    it('should clear failure history when execution succeeds', () => {
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      expect(circuitBreaker.getConsecutiveFailures()).toBe(2);

      circuitBreaker.recordSuccess();
      expect(circuitBreaker.getConsecutiveFailures()).toBe(0);
    });

    /**
     * GIVEN: Circuit breaker has recorded consecutive failures
     * WHEN: Failure count reaches the configured threshold (5)
     * THEN: Circuit should trip (OPEN state) and block all new executions
     *
     * **Business Value**: Prevents continued capital loss when executions are
     * consistently failing. Stops the bleeding by halting all new executions
     * until the issue can be investigated.
     */
    it('should stop all executions after consecutive failures exceed threshold', () => {
      // Given: Recording failures up to threshold
      for (let i = 0; i < 5; i++) {
        circuitBreaker.recordFailure();
      }

      // Then: Circuit trips and blocks executions
      expect(circuitBreaker.getState()).toBe('OPEN');
      expect(circuitBreaker.isOpen()).toBe(true);
      expect(circuitBreaker.canExecute()).toBe(false);
    });

    it('should emit state change event when tripping', () => {
      // Record failures up to threshold
      for (let i = 0; i < 5; i++) {
        circuitBreaker.recordFailure();
      }

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          previousState: 'CLOSED',
          newState: 'OPEN',
          reason: expect.stringContaining('threshold'),
        })
      );
    });

    /**
     * GIVEN: Circuit breaker is tracking failures below threshold
     * WHEN: Failure count has not reached threshold (4 of 5)
     * THEN: Executions should continue to be allowed
     *
     * **Business Value**: Allows tolerance for occasional failures without
     * prematurely halting executions. Only trips when pattern of consecutive
     * failures indicates systemic issue.
     */
    it('should continue allowing executions until failure threshold is reached', () => {
      for (let i = 0; i < 4; i++) {
        circuitBreaker.recordFailure();
      }

      expect(circuitBreaker.getState()).toBe('CLOSED');
      expect(circuitBreaker.canExecute()).toBe(true);
    });
  });

  // ===========================================================================
  // Cooldown Period
  // ===========================================================================

  describe('cooldown period', () => {
    beforeEach(() => {
      circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
        failureThreshold: 3,
        cooldownPeriodMs: 60000, // 1 minute
      });
    });

    /**
     * GIVEN: Circuit has tripped and entered OPEN state
     * WHEN: Cooldown period has not yet expired
     * THEN: Circuit should continue blocking all executions
     *
     * **Business Value**: Provides time for underlying issues (network problems,
     * gas price spikes, RPC failures) to resolve before attempting recovery.
     * Prevents premature retry attempts that would waste gas.
     */
    it('should continue blocking executions during cooldown period', () => {
      // Given: Trip the circuit
      for (let i = 0; i < 3; i++) {
        circuitBreaker.recordFailure();
      }
      expect(circuitBreaker.getState()).toBe('OPEN');

      // When: Advance time but not past cooldown (30 of 60 seconds)
      advanceTime(30000);

      // Then: Continue blocking executions
      expect(circuitBreaker.getState()).toBe('OPEN');
      expect(circuitBreaker.canExecute()).toBe(false);
    });

    /**
     * GIVEN: Circuit has completed cooldown period
     * WHEN: First execution is attempted after cooldown
     * THEN: Circuit should allow limited test executions (HALF_OPEN state)
     *
     * **Business Value**: Enables cautious recovery by allowing a few test
     * executions to verify the underlying issue has resolved before fully
     * reopening and risking capital on potentially still-failing executions.
     */
    it('should allow limited test executions after cooldown expires', () => {
      // Given: Trip the circuit
      for (let i = 0; i < 3; i++) {
        circuitBreaker.recordFailure();
      }

      // When: Advance past cooldown (60 seconds + 1ms)
      advanceTime(60001);

      // Then: Attempt to execute should transition to HALF_OPEN
      expect(circuitBreaker.canExecute()).toBe(true);
      expect(circuitBreaker.getState()).toBe('HALF_OPEN');
    });

    it('should emit event when transitioning to HALF_OPEN', () => {
      // Trip the circuit
      for (let i = 0; i < 3; i++) {
        circuitBreaker.recordFailure();
      }
      mockEventEmitter.emit.mockClear();

      // Advance past cooldown and trigger transition
      advanceTime(60001);
      circuitBreaker.canExecute();

      expect(mockEventEmitter.emit).toHaveBeenLastCalledWith(
        expect.objectContaining({
          previousState: 'OPEN',
          newState: 'HALF_OPEN',
          reason: expect.stringContaining('Cooldown'),
        })
      );
    });

    /**
     * GIVEN: Circuit is in cooldown period
     * WHEN: Querying remaining cooldown time
     * THEN: Should provide accurate time remaining until recovery attempts
     *
     * **Business Value**: Allows operators to monitor when the circuit will
     * attempt recovery, aiding in incident response and coordination.
     */
    it('should provide visibility into when recovery attempts can begin', () => {
      // Given: Trip the circuit
      for (let i = 0; i < 3; i++) {
        circuitBreaker.recordFailure();
      }

      // When: Check cooldown remaining
      const remaining = circuitBreaker.getCooldownRemaining();
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(60000);

      // Advance time
      advanceTime(30000);
      expect(circuitBreaker.getCooldownRemaining()).toBeLessThanOrEqual(30000);
    });
  });

  // ===========================================================================
  // Half-Open State
  // ===========================================================================

  describe('half-open state', () => {
    beforeEach(() => {
      circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
        failureThreshold: 3,
        cooldownPeriodMs: 1000,
        halfOpenMaxAttempts: 2,
      });

      // Trip and wait for cooldown
      for (let i = 0; i < 3; i++) {
        circuitBreaker.recordFailure();
      }
      advanceTime(1001);
      circuitBreaker.canExecute(); // Trigger HALF_OPEN
    });

    /**
     * GIVEN: Circuit has entered HALF_OPEN state after cooldown
     * WHEN: Attempting to check if execution is allowed
     * THEN: Limited test executions should be permitted
     *
     * **Business Value**: Enables cautious testing of whether the underlying
     * issue has resolved, without fully reopening and risking capital on
     * potentially still-failing executions.
     */
    it('should enable cautious testing of whether issue is resolved', () => {
      expect(circuitBreaker.getState()).toBe('HALF_OPEN');
      // First call should return true (attempt 1 of 2)
      expect(circuitBreaker.canExecute()).toBe(true);
    });

    /**
     * GIVEN: Circuit is in HALF_OPEN state with max attempts configured (2)
     * WHEN: Execution attempts exceed the configured limit
     * THEN: Further attempts should be blocked to prevent excessive testing
     *
     * **Business Value**: Prevents too many test executions during recovery,
     * limiting potential capital loss if the issue is not yet resolved.
     * Forces another cooldown period for more recovery time.
     */
    it('should prevent too many test executions during recovery', () => {
      // Reset to create fresh circuit breaker with maxAttempts = 2
      circuitBreaker.stop();
      circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
        failureThreshold: 3,
        cooldownPeriodMs: 1000,
        halfOpenMaxAttempts: 2,
      });

      // Trip and wait for cooldown
      for (let i = 0; i < 3; i++) {
        circuitBreaker.recordFailure();
      }
      advanceTime(1001);

      // First canExecute triggers HALF_OPEN and allows (attempt 1)
      expect(circuitBreaker.canExecute()).toBe(true);
      expect(circuitBreaker.getState()).toBe('HALF_OPEN');

      // Second call should allow (attempt 2 of 2)
      expect(circuitBreaker.canExecute()).toBe(true);

      // Third call should NOT allow (exceeded max attempts)
      expect(circuitBreaker.canExecute()).toBe(false);
    });

    /**
     * GIVEN: Circuit is in HALF_OPEN state (testing recovery)
     * WHEN: A test execution succeeds
     * THEN: Circuit should fully reopen to normal operations (CLOSED state)
     *
     * **Business Value**: Enables automatic recovery when the underlying issue
     * (network instability, gas spike, etc.) has resolved. Resumes normal
     * execution flow without manual intervention.
     */
    it('should resume normal operations after successful test execution', () => {
      circuitBreaker.recordSuccess();

      expect(circuitBreaker.getState()).toBe('CLOSED');
      expect(circuitBreaker.getConsecutiveFailures()).toBe(0);
    });

    /**
     * GIVEN: Circuit is in HALF_OPEN state (testing recovery)
     * WHEN: A test execution fails
     * THEN: Circuit should immediately trip back to OPEN (issue not resolved)
     *
     * **Business Value**: Quickly halts recovery attempts if the underlying
     * issue persists, preventing further capital loss. Restarts cooldown
     * period for more recovery time.
     */
    it('should immediately halt recovery if test execution fails', () => {
      mockEventEmitter.emit.mockClear();
      circuitBreaker.recordFailure();

      expect(circuitBreaker.getState()).toBe('OPEN');
      expect(mockEventEmitter.emit).toHaveBeenLastCalledWith(
        expect.objectContaining({
          previousState: 'HALF_OPEN',
          newState: 'OPEN',
          reason: expect.stringContaining('HALF_OPEN'),
        })
      );
    });

    it('should emit event when closing from HALF_OPEN', () => {
      mockEventEmitter.emit.mockClear();
      circuitBreaker.recordSuccess();

      expect(mockEventEmitter.emit).toHaveBeenLastCalledWith(
        expect.objectContaining({
          previousState: 'HALF_OPEN',
          newState: 'CLOSED',
          reason: expect.stringContaining('Successful'),
        })
      );
    });
  });

  // ===========================================================================
  // Manual Override
  // ===========================================================================

  describe('manual override', () => {
    beforeEach(() => {
      circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
        failureThreshold: 3,
      });
    });

    /**
     * GIVEN: Circuit has tripped and is blocking executions
     * WHEN: Operator manually force-closes the circuit
     * THEN: Executions should resume immediately (bypassing cooldown)
     *
     * **Business Value**: Enables operators to manually resume operations during
     * incidents when they've identified and fixed the underlying issue (e.g.,
     * restarted failing RPC, adjusted gas prices, fixed contract bug).
     * Prevents unnecessary downtime when issue is confirmed resolved.
     */
    it('should allow operators to manually resume operations during incidents', () => {
      // Given: Trip the circuit
      for (let i = 0; i < 3; i++) {
        circuitBreaker.recordFailure();
      }
      expect(circuitBreaker.getState()).toBe('OPEN');

      // When: Force close
      circuitBreaker.forceClose();

      // Then: Resume operations
      expect(circuitBreaker.getState()).toBe('CLOSED');
      expect(circuitBreaker.canExecute()).toBe(true);
      expect(circuitBreaker.getConsecutiveFailures()).toBe(0);
    });

    it('should emit event when force-closing', () => {
      for (let i = 0; i < 3; i++) {
        circuitBreaker.recordFailure();
      }
      mockEventEmitter.emit.mockClear();

      circuitBreaker.forceClose();

      expect(mockEventEmitter.emit).toHaveBeenLastCalledWith(
        expect.objectContaining({
          previousState: 'OPEN',
          newState: 'CLOSED',
          reason: expect.stringContaining('Manual'),
        })
      );
    });

    it('should log warning when force-closing', () => {
      for (let i = 0; i < 3; i++) {
        circuitBreaker.recordFailure();
      }

      circuitBreaker.forceClose();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('force'),
        expect.any(Object)
      );
    });

    /**
     * GIVEN: Circuit is operating normally (CLOSED)
     * WHEN: Operator manually force-opens the circuit
     * THEN: All executions should be blocked immediately
     *
     * **Business Value**: Enables emergency shutdowns during critical incidents
     * (e.g., contract vulnerability discovered, exchange API compromised,
     * regulatory issues). Provides immediate capital protection without
     * waiting for failures to accumulate.
     */
    it('should allow operators to halt executions during emergencies', () => {
      expect(circuitBreaker.getState()).toBe('CLOSED');

      circuitBreaker.forceOpen('manual_test');

      expect(circuitBreaker.getState()).toBe('OPEN');
      expect(circuitBreaker.canExecute()).toBe(false);
    });

    it('should emit event when force-opening', () => {
      circuitBreaker.forceOpen('emergency_stop');

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          previousState: 'CLOSED',
          newState: 'OPEN',
          reason: expect.stringContaining('emergency_stop'),
        })
      );
    });
  });

  // ===========================================================================
  // Enable/Disable
  // ===========================================================================

  describe('enable/disable', () => {
    beforeEach(() => {
      circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
        failureThreshold: 3,
      });
    });

    it('should allow disabling the circuit breaker', () => {
      circuitBreaker.disable();

      expect(circuitBreaker.isEnabled()).toBe(false);
    });

    /**
     * GIVEN: Circuit breaker is disabled (bypass mode)
     * WHEN: Checking if execution is allowed (even if circuit has tripped)
     * THEN: Execution should always be allowed regardless of state
     *
     * **Business Value**: Enables debugging and testing of execution logic
     * without circuit breaker interference. Useful for investigating specific
     * failures or testing in controlled environments (testnet, staging).
     */
    it('should bypass all protection when disabled for testing', () => {
      // Given: Trip the circuit first
      for (let i = 0; i < 3; i++) {
        circuitBreaker.recordFailure();
      }
      expect(circuitBreaker.canExecute()).toBe(false);

      // When: Disable
      circuitBreaker.disable();

      // Then: Should now allow execution even though OPEN
      expect(circuitBreaker.canExecute()).toBe(true);
    });

    it('should allow re-enabling the circuit breaker', () => {
      circuitBreaker.disable();
      circuitBreaker.enable();

      expect(circuitBreaker.isEnabled()).toBe(true);
    });

    it('should log when enabling/disabling', () => {
      circuitBreaker.disable();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('disabled'),
        expect.any(Object)
      );

      circuitBreaker.enable();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('enabled'),
        expect.any(Object)
      );
    });
  });

  // ===========================================================================
  // Metrics and Status
  // ===========================================================================

  describe('metrics and status', () => {
    beforeEach(() => {
      circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
        failureThreshold: 5,
        cooldownPeriodMs: 60000,
      });
    });

    it('should track total failures', () => {
      circuitBreaker.recordFailure();
      circuitBreaker.recordSuccess();
      circuitBreaker.recordFailure();

      const metrics = circuitBreaker.getMetrics();
      expect(metrics.totalFailures).toBe(2);
    });

    it('should track total successes', () => {
      circuitBreaker.recordSuccess();
      circuitBreaker.recordSuccess();

      const metrics = circuitBreaker.getMetrics();
      expect(metrics.totalSuccesses).toBe(2);
    });

    it('should track number of times tripped', () => {
      // Trip once
      for (let i = 0; i < 5; i++) {
        circuitBreaker.recordFailure();
      }

      // Force close and trip again
      circuitBreaker.forceClose();
      for (let i = 0; i < 5; i++) {
        circuitBreaker.recordFailure();
      }

      const metrics = circuitBreaker.getMetrics();
      expect(metrics.timesTripped).toBe(2);
    });

    it('should return complete status object', () => {
      const status = circuitBreaker.getStatus();

      expect(status).toMatchObject({
        state: 'CLOSED',
        enabled: true,
        consecutiveFailures: 0,
        cooldownRemaining: 0,
        lastStateChange: expect.any(Number),
      });
    });

    it('should return last state change timestamp', () => {
      const beforeTrip = Date.now();

      for (let i = 0; i < 5; i++) {
        circuitBreaker.recordFailure();
      }

      const status = circuitBreaker.getStatus();
      expect(status.lastStateChange).toBeGreaterThanOrEqual(beforeTrip);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle recording success in OPEN state (no-op)', () => {
      circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
        failureThreshold: 3,
      });

      // Trip the circuit
      for (let i = 0; i < 3; i++) {
        circuitBreaker.recordFailure();
      }

      // Recording success while OPEN should not change state
      circuitBreaker.recordSuccess();

      expect(circuitBreaker.getState()).toBe('OPEN');
    });

    it('should handle rapid failure/success cycles', () => {
      circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
        failureThreshold: 3,
      });

      // Rapid cycle
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      circuitBreaker.recordSuccess();
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure(); // Should trip here (3 consecutive)

      expect(circuitBreaker.getState()).toBe('OPEN');
    });

    it('should handle force-close when already CLOSED', () => {
      circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
      });

      circuitBreaker.forceClose();

      expect(circuitBreaker.getState()).toBe('CLOSED');
      // Should not emit event if already in target state
    });

    it('should handle threshold of 1', () => {
      circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
        failureThreshold: 1,
      });

      circuitBreaker.recordFailure();

      expect(circuitBreaker.getState()).toBe('OPEN');
    });
  });

  // ===========================================================================
  // Concurrent Access Tests (FIX-8.1)
  // ===========================================================================

  describe('concurrent access patterns', () => {
    /**
     * FIX-8.1: Tests to verify behavior under concurrent-like scenarios.
     *
     * Note: In Node.js single-threaded model, true concurrency doesn't occur
     * within synchronous code. These tests verify behavior when multiple
     * operations are queued or called in quick succession.
     */

    it('should handle multiple canExecute calls in HALF_OPEN correctly', () => {
      circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
        failureThreshold: 3,
        cooldownPeriodMs: 1000,
        halfOpenMaxAttempts: 2,
      });

      // Trip the circuit
      for (let i = 0; i < 3; i++) {
        circuitBreaker.recordFailure();
      }
      advanceTime(1001);

      // Multiple calls in sequence (simulating concurrent-like access)
      const results = [
        circuitBreaker.canExecute(), // Should allow (triggers HALF_OPEN, attempt 1)
        circuitBreaker.canExecute(), // Should allow (attempt 2)
        circuitBreaker.canExecute(), // Should NOT allow (exceeded max)
        circuitBreaker.canExecute(), // Should NOT allow
      ];

      expect(results).toEqual([true, true, false, false]);
      expect(circuitBreaker.getState()).toBe('HALF_OPEN');
    });

    it('should handle interleaved canExecute and recordFailure calls', () => {
      circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
        failureThreshold: 3,
        cooldownPeriodMs: 1000,
        halfOpenMaxAttempts: 2,
      });

      // Trip the circuit
      for (let i = 0; i < 3; i++) {
        circuitBreaker.recordFailure();
      }
      advanceTime(1001);

      // canExecute triggers HALF_OPEN
      expect(circuitBreaker.canExecute()).toBe(true);
      expect(circuitBreaker.getState()).toBe('HALF_OPEN');

      // recordFailure should re-OPEN
      circuitBreaker.recordFailure();
      expect(circuitBreaker.getState()).toBe('OPEN');

      // Further canExecute should fail (back in OPEN, cooldown restarted)
      expect(circuitBreaker.canExecute()).toBe(false);
    });

    it('should handle Promise.all-like parallel calls correctly', async () => {
      circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
        failureThreshold: 3,
        cooldownPeriodMs: 1000,
        halfOpenMaxAttempts: 1,
      });

      // Trip the circuit
      for (let i = 0; i < 3; i++) {
        circuitBreaker.recordFailure();
      }
      advanceTime(1001);

      // Simulate multiple async checks (all synchronous in reality)
      const checkResults = await Promise.all([
        Promise.resolve(circuitBreaker.canExecute()),
        Promise.resolve(circuitBreaker.canExecute()),
        Promise.resolve(circuitBreaker.canExecute()),
      ]);

      // Only the first should succeed (halfOpenMaxAttempts = 1)
      expect(checkResults[0]).toBe(true);
      expect(checkResults[1]).toBe(false);
      expect(checkResults[2]).toBe(false);
    });

    it('should maintain consistent state across rapid record operations', () => {
      circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
        failureThreshold: 5,
        cooldownPeriodMs: 1000,
      });

      // Simulate rapid-fire operations
      const operations = [
        () => circuitBreaker.recordFailure(),
        () => circuitBreaker.recordFailure(),
        () => circuitBreaker.recordSuccess(),
        () => circuitBreaker.recordFailure(),
        () => circuitBreaker.recordFailure(),
        () => circuitBreaker.recordSuccess(),
        () => circuitBreaker.recordFailure(),
        () => circuitBreaker.recordFailure(),
        () => circuitBreaker.recordFailure(),
        () => circuitBreaker.recordFailure(),
        () => circuitBreaker.recordFailure(), // Should trip here (5 consecutive)
      ];

      operations.forEach(op => op());

      expect(circuitBreaker.getState()).toBe('OPEN');
      expect(circuitBreaker.getConsecutiveFailures()).toBe(5);
    });

    it('should handle state transition during cooldown check edge case', () => {
      circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
        failureThreshold: 3,
        cooldownPeriodMs: 1000,
        halfOpenMaxAttempts: 1,
      });

      // Trip the circuit
      for (let i = 0; i < 3; i++) {
        circuitBreaker.recordFailure();
      }

      // Advance to just before cooldown expiry
      advanceTime(999);
      expect(circuitBreaker.canExecute()).toBe(false);

      // Advance to just after cooldown expiry
      advanceTime(2);

      // First call should transition to HALF_OPEN and allow
      expect(circuitBreaker.canExecute()).toBe(true);
      expect(circuitBreaker.getState()).toBe('HALF_OPEN');

      // Force-open during HALF_OPEN should work
      circuitBreaker.forceOpen('manual override');
      expect(circuitBreaker.getState()).toBe('OPEN');
    });
  });

  // ===========================================================================
  // Factory Function
  // ===========================================================================

  describe('createCircuitBreaker factory', () => {
    it('should create a functional circuit breaker', () => {
      const cb = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
      });

      expect(cb.getState()).toBe('CLOSED');
      expect(cb.canExecute()).toBe(true);
    });

    it('should validate configuration', () => {
      expect(() => {
        createCircuitBreaker({
          logger: mockLogger,
          onStateChange: mockEventEmitter.emit,
          failureThreshold: 0, // Invalid
        });
      }).toThrow();

      expect(() => {
        createCircuitBreaker({
          logger: mockLogger,
          onStateChange: mockEventEmitter.emit,
          cooldownPeriodMs: -1, // Invalid
        });
      }).toThrow();
    });
  });
});
