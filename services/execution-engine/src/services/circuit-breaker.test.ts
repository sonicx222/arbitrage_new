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
} from './circuit-breaker';
import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from '../types';

// =============================================================================
// Test Helpers
// =============================================================================

function createMockLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

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

// Helper to advance time in tests
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
    it('should initialize with CLOSED state', () => {
      circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
      });

      expect(circuitBreaker.getState()).toBe('CLOSED');
      expect(circuitBreaker.isOpen()).toBe(false);
      expect(circuitBreaker.canExecute()).toBe(true);
    });

    it('should use default config values', () => {
      circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
      });

      const config = circuitBreaker.getConfig();
      expect(config.failureThreshold).toBe(DEFAULT_CIRCUIT_BREAKER_CONFIG.failureThreshold);
      expect(config.cooldownPeriodMs).toBe(DEFAULT_CIRCUIT_BREAKER_CONFIG.cooldownPeriodMs);
      expect(config.halfOpenMaxAttempts).toBe(DEFAULT_CIRCUIT_BREAKER_CONFIG.halfOpenMaxAttempts);
    });

    it('should accept custom config values', () => {
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

    it('should allow starting disabled via config', () => {
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

    it('should track consecutive failures', () => {
      circuitBreaker.recordFailure();
      expect(circuitBreaker.getConsecutiveFailures()).toBe(1);

      circuitBreaker.recordFailure();
      expect(circuitBreaker.getConsecutiveFailures()).toBe(2);
    });

    it('should reset failure count on success', () => {
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      expect(circuitBreaker.getConsecutiveFailures()).toBe(2);

      circuitBreaker.recordSuccess();
      expect(circuitBreaker.getConsecutiveFailures()).toBe(0);
    });

    it('should trip circuit after reaching threshold', () => {
      // Record failures up to threshold
      for (let i = 0; i < 5; i++) {
        circuitBreaker.recordFailure();
      }

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

    it('should not trip before reaching threshold', () => {
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

    it('should remain OPEN during cooldown period', () => {
      // Trip the circuit
      for (let i = 0; i < 3; i++) {
        circuitBreaker.recordFailure();
      }
      expect(circuitBreaker.getState()).toBe('OPEN');

      // Advance time but not past cooldown
      advanceTime(30000); // 30 seconds

      expect(circuitBreaker.getState()).toBe('OPEN');
      expect(circuitBreaker.canExecute()).toBe(false);
    });

    it('should transition to HALF_OPEN after cooldown expires', () => {
      // Trip the circuit
      for (let i = 0; i < 3; i++) {
        circuitBreaker.recordFailure();
      }

      // Advance past cooldown
      advanceTime(60001);

      // Attempt to execute should transition to HALF_OPEN
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

    it('should report remaining cooldown time', () => {
      // Trip the circuit
      for (let i = 0; i < 3; i++) {
        circuitBreaker.recordFailure();
      }

      // Check cooldown remaining
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

    it('should allow limited executions in HALF_OPEN state', () => {
      expect(circuitBreaker.getState()).toBe('HALF_OPEN');
      // First call should return true (attempt 1 of 2)
      expect(circuitBreaker.canExecute()).toBe(true);
    });

    it('should enforce halfOpenMaxAttempts limit', () => {
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

    it('should close circuit after successful execution in HALF_OPEN', () => {
      circuitBreaker.recordSuccess();

      expect(circuitBreaker.getState()).toBe('CLOSED');
      expect(circuitBreaker.getConsecutiveFailures()).toBe(0);
    });

    it('should re-open circuit after failure in HALF_OPEN', () => {
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

    it('should allow manual force-close', () => {
      // Trip the circuit
      for (let i = 0; i < 3; i++) {
        circuitBreaker.recordFailure();
      }
      expect(circuitBreaker.getState()).toBe('OPEN');

      // Force close
      circuitBreaker.forceClose();

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

    it('should allow manual force-open', () => {
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

    it('should always allow execution when disabled', () => {
      // Trip the circuit first
      for (let i = 0; i < 3; i++) {
        circuitBreaker.recordFailure();
      }
      expect(circuitBreaker.canExecute()).toBe(false);

      // Disable
      circuitBreaker.disable();

      // Should now allow execution even though OPEN
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
