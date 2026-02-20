// Circuit Breaker Integration Tests (Phase 1.3.3)
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ExecutionEngineService } from '../../src/engine';
import {
  createCircuitBreaker,
  CircuitBreaker,
  CircuitBreakerEvent,
} from '../../src/services/circuit-breaker';
import { createMockLogger, createMockPerfLogger, createMockExecutionStateManager } from '@arbitrage/test-utils';

describe('Circuit Breaker Integration Tests (Phase 1.3.3)', () => {
  const createMockEventEmitter = () => {
    const events: CircuitBreakerEvent[] = [];
    return {
      emit: jest.fn((event: CircuitBreakerEvent) => {
        events.push(event);
      }),
      getEvents: () => events,
      clear: () => (events.length = 0),
    };
  };

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Failure Cascade Scenario', () => {
    /**
     * Test: Simulates a failure cascade where consecutive failures
     * trigger the circuit breaker to open, blocking further executions.
     *
     * This is the core integration scenario from Task 1.3.3.
     */
    it('should trip circuit breaker after consecutive failures and block executions', () => {
      const mockLogger = createMockLogger();
      const mockEventEmitter = createMockEventEmitter();

      // Create circuit breaker with low threshold for testing
      const circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
        failureThreshold: 3,
        cooldownPeriodMs: 60000, // 1 minute
        halfOpenMaxAttempts: 1,
      });

      // Simulate execution loop with failure cascade
      let executionsAttempted = 0;
      let executionsBlocked = 0;

      // Simulate 10 consecutive execution attempts that all fail
      for (let i = 0; i < 10; i++) {
        if (circuitBreaker.canExecute()) {
          executionsAttempted++;
          // Simulate execution failure
          circuitBreaker.recordFailure();
        } else {
          executionsBlocked++;
        }
      }

      // After 3 failures, circuit should open and block remaining 7
      expect(executionsAttempted).toBe(3);
      expect(executionsBlocked).toBe(7);
      expect(circuitBreaker.getState()).toBe('OPEN');
      expect(circuitBreaker.isOpen()).toBe(true);

      // Verify state change event was emitted
      const events = mockEventEmitter.getEvents();
      expect(events.length).toBe(1);
      expect(events[0].previousState).toBe('CLOSED');
      expect(events[0].newState).toBe('OPEN');
      expect(events[0].consecutiveFailures).toBe(3);

      circuitBreaker.stop();
    });

    /**
     * Test: After cooldown period expires, circuit transitions to HALF_OPEN
     * and allows one test execution.
     */
    it('should transition to HALF_OPEN after cooldown and allow test execution', () => {
      const mockLogger = createMockLogger();
      const mockEventEmitter = createMockEventEmitter();

      const circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
        failureThreshold: 3,
        cooldownPeriodMs: 60000,
        halfOpenMaxAttempts: 1,
      });

      // Trip the circuit
      for (let i = 0; i < 3; i++) {
        circuitBreaker.canExecute();
        circuitBreaker.recordFailure();
      }
      expect(circuitBreaker.getState()).toBe('OPEN');

      // Should not allow execution during cooldown
      expect(circuitBreaker.canExecute()).toBe(false);

      // Advance time past cooldown
      jest.advanceTimersByTime(60001);

      // Should now transition to HALF_OPEN and allow one execution
      expect(circuitBreaker.canExecute()).toBe(true);
      expect(circuitBreaker.getState()).toBe('HALF_OPEN');

      // Verify transition event
      const events = mockEventEmitter.getEvents();
      const halfOpenEvent = events.find(e => e.newState === 'HALF_OPEN');
      expect(halfOpenEvent).not.toBeUndefined();
      expect(halfOpenEvent!.previousState).toBe('OPEN');

      circuitBreaker.stop();
    });

    /**
     * Test: Successful execution in HALF_OPEN closes the circuit,
     * allowing normal operation to resume.
     */
    it('should close circuit after successful execution in HALF_OPEN', () => {
      const mockLogger = createMockLogger();
      const mockEventEmitter = createMockEventEmitter();

      const circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
        failureThreshold: 3,
        cooldownPeriodMs: 60000,
        halfOpenMaxAttempts: 1,
      });

      // Trip the circuit
      for (let i = 0; i < 3; i++) {
        circuitBreaker.canExecute();
        circuitBreaker.recordFailure();
      }

      // Advance past cooldown
      jest.advanceTimersByTime(60001);
      circuitBreaker.canExecute(); // Transition to HALF_OPEN

      // Simulate successful execution
      circuitBreaker.recordSuccess();

      // Circuit should be closed
      expect(circuitBreaker.getState()).toBe('CLOSED');
      expect(circuitBreaker.isOpen()).toBe(false);
      expect(circuitBreaker.getConsecutiveFailures()).toBe(0);

      // Verify closure event
      const events = mockEventEmitter.getEvents();
      const closeEvent = events.find(
        e => e.previousState === 'HALF_OPEN' && e.newState === 'CLOSED'
      );
      expect(closeEvent).not.toBeUndefined();
      expect(closeEvent!.reason).toContain('recovered');

      circuitBreaker.stop();
    });

    /**
     * Test: Failed execution in HALF_OPEN re-opens the circuit,
     * requiring another cooldown before retry.
     */
    it('should re-open circuit after failed execution in HALF_OPEN', () => {
      const mockLogger = createMockLogger();
      const mockEventEmitter = createMockEventEmitter();

      const circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
        failureThreshold: 3,
        cooldownPeriodMs: 60000,
        halfOpenMaxAttempts: 1,
      });

      // Trip the circuit
      for (let i = 0; i < 3; i++) {
        circuitBreaker.canExecute();
        circuitBreaker.recordFailure();
      }

      // Advance past cooldown
      jest.advanceTimersByTime(60001);
      circuitBreaker.canExecute(); // Transition to HALF_OPEN
      expect(circuitBreaker.getState()).toBe('HALF_OPEN');

      // Simulate failed execution in HALF_OPEN
      circuitBreaker.recordFailure();

      // Circuit should be back to OPEN
      expect(circuitBreaker.getState()).toBe('OPEN');
      expect(circuitBreaker.isOpen()).toBe(true);

      // Should not allow execution (cooldown restarted)
      expect(circuitBreaker.canExecute()).toBe(false);

      // Verify re-open event
      const events = mockEventEmitter.getEvents();
      const reopenEvent = events.find(
        e => e.previousState === 'HALF_OPEN' && e.newState === 'OPEN'
      );
      expect(reopenEvent).not.toBeUndefined();
      expect(reopenEvent!.reason).toContain('HALF_OPEN');

      circuitBreaker.stop();
    });

    /**
     * Test: Metrics correctly track circuit breaker trips.
     */
    it('should track metrics through multiple trip cycles', () => {
      const mockLogger = createMockLogger();
      const mockEventEmitter = createMockEventEmitter();

      const circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
        failureThreshold: 2,
        cooldownPeriodMs: 1000,
        halfOpenMaxAttempts: 1,
      });

      // First trip
      circuitBreaker.canExecute();
      circuitBreaker.recordFailure();
      circuitBreaker.canExecute();
      circuitBreaker.recordFailure();
      expect(circuitBreaker.getState()).toBe('OPEN');

      // Recover
      jest.advanceTimersByTime(1001);
      circuitBreaker.canExecute();
      circuitBreaker.recordSuccess();
      expect(circuitBreaker.getState()).toBe('CLOSED');

      // Second trip
      circuitBreaker.canExecute();
      circuitBreaker.recordFailure();
      circuitBreaker.canExecute();
      circuitBreaker.recordFailure();
      expect(circuitBreaker.getState()).toBe('OPEN');

      // Check metrics
      const metrics = circuitBreaker.getMetrics();
      expect(metrics.timesTripped).toBe(2);
      expect(metrics.totalFailures).toBe(4);
      expect(metrics.totalSuccesses).toBe(1);
      expect(metrics.totalOpenTimeMs).toBeGreaterThan(0);

      circuitBreaker.stop();
    });
  });

  describe('Engine Integration with Circuit Breaker', () => {
    /**
     * Test: ExecutionEngineService initializes circuit breaker correctly.
     */
    it('should initialize engine with circuit breaker configuration', () => {
      const mockLogger = createMockLogger();
      const mockPerfLogger = createMockPerfLogger();
      const mockStateManager = createMockExecutionStateManager();

      const engine = new ExecutionEngineService({
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        stateManager: mockStateManager as any,
        circuitBreakerConfig: {
          enabled: true,
          failureThreshold: 10,
          cooldownPeriodMs: 120000,
          halfOpenMaxAttempts: 2,
        },
      });

      const config = engine.getCircuitBreakerConfig();
      expect(config.enabled).toBe(true);
      expect(config.failureThreshold).toBe(10);
      expect(config.cooldownPeriodMs).toBe(120000);
      expect(config.halfOpenMaxAttempts).toBe(2);

      // Status is null before start (circuit breaker not initialized yet)
      expect(engine.getCircuitBreakerStatus()).toBeNull();
    });

    /**
     * Test: Engine exposes circuit breaker status.
     */
    it('should expose circuit breaker status methods', () => {
      const mockLogger = createMockLogger();
      const mockPerfLogger = createMockPerfLogger();
      const mockStateManager = createMockExecutionStateManager();

      const engine = new ExecutionEngineService({
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        stateManager: mockStateManager as any,
        circuitBreakerConfig: {
          enabled: true,
          failureThreshold: 5,
          cooldownPeriodMs: 60000,
        },
      });

      // Test public methods exist and return expected types
      expect(typeof engine.isCircuitBreakerOpen).toBe('function');
      expect(typeof engine.getCircuitBreakerStatus).toBe('function');
      expect(typeof engine.getCircuitBreakerConfig).toBe('function');
      expect(typeof engine.forceCloseCircuitBreaker).toBe('function');
      expect(typeof engine.forceOpenCircuitBreaker).toBe('function');

      // Before initialization, these should return safe defaults
      expect(engine.isCircuitBreakerOpen()).toBe(false);
    });

    /**
     * Test: Engine stats track circuit breaker metrics.
     */
    it('should track circuit breaker metrics in execution stats', () => {
      const mockLogger = createMockLogger();
      const mockPerfLogger = createMockPerfLogger();
      const mockStateManager = createMockExecutionStateManager();

      const engine = new ExecutionEngineService({
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        stateManager: mockStateManager as any,
      });

      const stats = engine.getStats();

      // Verify circuit breaker stats fields exist
      expect(stats.circuitBreakerTrips).toBe(0);
      expect(stats.circuitBreakerBlocks).toBe(0);
    });

    /**
     * Test: Engine with disabled circuit breaker.
     */
    it('should handle disabled circuit breaker configuration', () => {
      const mockLogger = createMockLogger();
      const mockPerfLogger = createMockPerfLogger();
      const mockStateManager = createMockExecutionStateManager();

      const engine = new ExecutionEngineService({
        logger: mockLogger,
        perfLogger: mockPerfLogger as any,
        stateManager: mockStateManager as any,
        circuitBreakerConfig: {
          enabled: false,
        },
      });

      const config = engine.getCircuitBreakerConfig();
      expect(config.enabled).toBe(false);

      // Circuit breaker is not open when disabled
      expect(engine.isCircuitBreakerOpen()).toBe(false);
    });
  });

  describe('Concurrent Execution with Circuit Breaker', () => {
    /**
     * Test: Circuit breaker limits attempts in HALF_OPEN state.
     *
     * This tests the critical behavior where only N attempts are allowed
     * in HALF_OPEN before blocking, preventing stampede on recovery.
     */
    it('should limit concurrent attempts in HALF_OPEN state', () => {
      const mockLogger = createMockLogger();
      const mockEventEmitter = createMockEventEmitter();

      const circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
        failureThreshold: 3,
        cooldownPeriodMs: 1000,
        halfOpenMaxAttempts: 2, // Allow 2 test executions
      });

      // Trip the circuit
      for (let i = 0; i < 3; i++) {
        circuitBreaker.canExecute();
        circuitBreaker.recordFailure();
      }

      // Advance past cooldown
      jest.advanceTimersByTime(1001);

      // First call transitions to HALF_OPEN and counts as attempt 1
      expect(circuitBreaker.canExecute()).toBe(true);
      expect(circuitBreaker.getState()).toBe('HALF_OPEN');

      // Second call allowed (attempt 2)
      expect(circuitBreaker.canExecute()).toBe(true);

      // Third call blocked (exceeded halfOpenMaxAttempts)
      expect(circuitBreaker.canExecute()).toBe(false);

      // Fourth call still blocked
      expect(circuitBreaker.canExecute()).toBe(false);

      circuitBreaker.stop();
    });

    /**
     * Test: Recovery after multiple trip cycles.
     */
    it('should recover correctly after multiple trip-recover cycles', () => {
      const mockLogger = createMockLogger();
      const mockEventEmitter = createMockEventEmitter();

      const circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
        failureThreshold: 2,
        cooldownPeriodMs: 500,
        halfOpenMaxAttempts: 1,
      });

      // Cycle 1: Trip and recover
      circuitBreaker.canExecute();
      circuitBreaker.recordFailure();
      circuitBreaker.canExecute();
      circuitBreaker.recordFailure();
      expect(circuitBreaker.getState()).toBe('OPEN');

      jest.advanceTimersByTime(501);
      circuitBreaker.canExecute();
      circuitBreaker.recordSuccess();
      expect(circuitBreaker.getState()).toBe('CLOSED');

      // Normal operation
      expect(circuitBreaker.canExecute()).toBe(true);
      circuitBreaker.recordSuccess();
      expect(circuitBreaker.canExecute()).toBe(true);
      circuitBreaker.recordSuccess();

      // Cycle 2: Trip again
      circuitBreaker.canExecute();
      circuitBreaker.recordFailure();
      circuitBreaker.canExecute();
      circuitBreaker.recordFailure();
      expect(circuitBreaker.getState()).toBe('OPEN');

      // Cycle 2: Recover
      jest.advanceTimersByTime(501);
      circuitBreaker.canExecute();
      circuitBreaker.recordSuccess();
      expect(circuitBreaker.getState()).toBe('CLOSED');

      // Verify metrics
      const metrics = circuitBreaker.getMetrics();
      expect(metrics.timesTripped).toBe(2);
      expect(metrics.totalSuccesses).toBe(4);

      circuitBreaker.stop();
    });
  });

  describe('Manual Override Scenarios', () => {
    /**
     * Test: Force close allows emergency bypass of circuit breaker.
     */
    it('should allow force close for emergency recovery', () => {
      const mockLogger = createMockLogger();
      const mockEventEmitter = createMockEventEmitter();

      const circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
        failureThreshold: 3,
        cooldownPeriodMs: 300000, // 5 minutes
      });

      // Trip the circuit
      for (let i = 0; i < 3; i++) {
        circuitBreaker.canExecute();
        circuitBreaker.recordFailure();
      }
      expect(circuitBreaker.getState()).toBe('OPEN');

      // Manual override to close
      circuitBreaker.forceClose();

      expect(circuitBreaker.getState()).toBe('CLOSED');
      expect(circuitBreaker.canExecute()).toBe(true);
      expect(circuitBreaker.getConsecutiveFailures()).toBe(0);

      // Verify event emitted
      const events = mockEventEmitter.getEvents();
      const forceCloseEvent = events.find(
        e => e.newState === 'CLOSED' && e.reason.includes('Manual')
      );
      expect(forceCloseEvent).not.toBeUndefined();

      circuitBreaker.stop();
    });

    /**
     * Test: Force open allows emergency stop of executions.
     */
    it('should allow force open for emergency stop', () => {
      const mockLogger = createMockLogger();
      const mockEventEmitter = createMockEventEmitter();

      const circuitBreaker = createCircuitBreaker({
        logger: mockLogger,
        onStateChange: mockEventEmitter.emit,
        failureThreshold: 100, // High threshold - won't trip naturally
      });

      expect(circuitBreaker.getState()).toBe('CLOSED');

      // Force open for emergency
      circuitBreaker.forceOpen('liquidity_crisis');

      expect(circuitBreaker.getState()).toBe('OPEN');
      expect(circuitBreaker.canExecute()).toBe(false);

      // Verify event emitted with reason
      const events = mockEventEmitter.getEvents();
      expect(events.length).toBe(1);
      expect(events[0].newState).toBe('OPEN');
      expect(events[0].reason).toContain('liquidity_crisis');

      circuitBreaker.stop();
    });
  });
});
