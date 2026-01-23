// Execution Engine Service Unit Tests
import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { ExecutionEngineService, ExecutionEngineConfig } from './engine';

// ============================================================================
// Mock Factories (using dependency injection instead of module mocks)
// ============================================================================

// Mock logger factory
const createMockLogger = () => ({
  info: jest.fn<(msg: string, meta?: object) => void>(),
  error: jest.fn<(msg: string, meta?: object) => void>(),
  warn: jest.fn<(msg: string, meta?: object) => void>(),
  debug: jest.fn<(msg: string, meta?: object) => void>()
});

// Mock perf logger factory
const createMockPerfLogger = () => ({
  logEventLatency: jest.fn(),
  logExecutionResult: jest.fn(),
  logHealthCheck: jest.fn()
});

// Mock state manager factory
const createMockStateManager = () => ({
  getState: jest.fn(() => 'idle'),
  executeStart: jest.fn((fn: () => Promise<void>) => fn()),
  executeStop: jest.fn((fn: () => Promise<void>) => fn()),
  transition: jest.fn(() => Promise.resolve({ success: true })),
  isTransitioning: jest.fn(() => false),
  waitForIdle: jest.fn(() => Promise.resolve()),
  on: jest.fn(),
  off: jest.fn(),
  canTransition: jest.fn(() => true)
});

describe('ExecutionEngineService', () => {
  let engine: ExecutionEngineService;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockPerfLogger: ReturnType<typeof createMockPerfLogger>;
  let mockStateManager: ReturnType<typeof createMockStateManager>;

  // Create test config with injected mocks
  const createTestConfig = (overrides: Partial<ExecutionEngineConfig> = {}): ExecutionEngineConfig => ({
    logger: mockLogger,
    perfLogger: mockPerfLogger as any,
    stateManager: mockStateManager as any,
    ...overrides
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockPerfLogger = createMockPerfLogger();
    mockStateManager = createMockStateManager();

    engine = new ExecutionEngineService(createTestConfig());
  });

  test('should initialize correctly', () => {
    expect(engine).toBeDefined();
  });

  // PHASE-3.2: validateOpportunity was moved to OpportunityConsumer
  // buildSwapPath is in BaseExecutionStrategy
  // See consumers/opportunity.consumer.test.ts for consumer-specific tests

  test('should provide stats correctly', () => {
    const stats = engine.getStats();
    expect(stats).toBeDefined();
    expect(stats.opportunitiesReceived).toBe(0);
    expect(stats.executionAttempts).toBe(0);
    expect(stats.successfulExecutions).toBe(0);
    expect(stats.failedExecutions).toBe(0);
  });
});

// =============================================================================
// Precision Fix Regression Tests (PRECISION-FIX)
// =============================================================================

import { ethers } from 'ethers';

describe('Precision Fix Regression Tests', () => {
  test('should correctly convert small expectedProfit values without precision loss', () => {
    // This tests the fix for PRECISION-FIX in prepareFlashLoanTransaction
    // Previously: BigInt(Math.floor(0.000000123456789 * 1e18)) would lose precision
    // Now: ethers.parseUnits(value.toFixed(18), 18) preserves precision

    const smallProfit = 0.000000123456789;

    // Old buggy implementation (loses precision):
    const buggyResult = BigInt(Math.floor(smallProfit * 1e18));

    // New correct implementation:
    const correctResult = ethers.parseUnits(smallProfit.toFixed(18), 18);

    // The correct result should be 123456789000000000n (approximately)
    // But due to float representation, toFixed(18) gives us a precise string
    expect(correctResult).toBeDefined();
    expect(typeof correctResult).toBe('bigint');

    // Verify the new implementation doesn't lose significant digits
    // The buggy version loses precision, the correct version maintains it
    expect(correctResult.toString().length).toBeGreaterThanOrEqual(buggyResult.toString().length);
  });

  test('should handle typical profit values correctly', () => {
    // Test typical profit value (e.g., 0.01 ETH = 10000000000000000 wei)
    const typicalProfit = 0.01;
    const result = ethers.parseUnits(typicalProfit.toFixed(18), 18);

    expect(result).toBe(10000000000000000n);
  });

  test('should handle very small profit values (micro arbitrage)', () => {
    // Test very small profit (e.g., 0.000001 ETH = 1000000000000 wei)
    const microProfit = 0.000001;
    const result = ethers.parseUnits(microProfit.toFixed(18), 18);

    expect(result).toBe(1000000000000n);
  });

  test('should handle zero profit correctly', () => {
    const zeroProfit = 0;
    const result = ethers.parseUnits(zeroProfit.toFixed(18), 18);

    expect(result).toBe(0n);
  });

  test('should handle maximum safe integer-like profits', () => {
    // Test large profit value (e.g., 1000 ETH)
    const largeProfit = 1000;
    const result = ethers.parseUnits(largeProfit.toFixed(18), 18);

    expect(result).toBe(1000000000000000000000n);
  });
});

// =============================================================================
// Standby Configuration Tests (ADR-007)
// =============================================================================

describe('ExecutionEngineService Standby Configuration (ADR-007)', () => {
  // Mock logger factory
  const createMockLogger = () => ({
    info: jest.fn<(msg: string, meta?: object) => void>(),
    error: jest.fn<(msg: string, meta?: object) => void>(),
    warn: jest.fn<(msg: string, meta?: object) => void>(),
    debug: jest.fn<(msg: string, meta?: object) => void>()
  });

  // Mock perf logger factory
  const createMockPerfLogger = () => ({
    logEventLatency: jest.fn(),
    logExecutionResult: jest.fn(),
    logHealthCheck: jest.fn()
  });

  // Mock state manager factory
  const createMockStateManager = () => ({
    getState: jest.fn(() => 'idle'),
    executeStart: jest.fn((fn: () => Promise<void>) => fn()),
    executeStop: jest.fn((fn: () => Promise<void>) => fn()),
    transition: jest.fn(() => Promise.resolve({ success: true })),
    isTransitioning: jest.fn(() => false),
    isRunning: jest.fn(() => true),
    waitForIdle: jest.fn(() => Promise.resolve()),
    on: jest.fn(),
    off: jest.fn(),
    canTransition: jest.fn(() => true)
  });

  test('should initialize with default standby config when not provided', () => {
    const mockLogger = createMockLogger();
    const mockPerfLogger = createMockPerfLogger();
    const mockStateManager = createMockStateManager();

    const engine = new ExecutionEngineService({
      logger: mockLogger,
      perfLogger: mockPerfLogger as any,
      stateManager: mockStateManager as any
    });

    expect(engine.getIsStandby()).toBe(false);
    expect(engine.getIsActivated()).toBe(false);
    expect(engine.getStandbyConfig()).toEqual({
      isStandby: false,
      queuePausedOnStart: false,
      activationDisablesSimulation: true,
      regionId: undefined
    });
  });

  test('should initialize with provided standby config', () => {
    const mockLogger = createMockLogger();
    const mockPerfLogger = createMockPerfLogger();
    const mockStateManager = createMockStateManager();

    const engine = new ExecutionEngineService({
      logger: mockLogger,
      perfLogger: mockPerfLogger as any,
      stateManager: mockStateManager as any,
      standbyConfig: {
        isStandby: true,
        queuePausedOnStart: true,
        activationDisablesSimulation: true,
        regionId: 'us-east1'
      }
    });

    expect(engine.getIsStandby()).toBe(true);
    expect(engine.getIsActivated()).toBe(false);
    expect(engine.getStandbyConfig()).toEqual({
      isStandby: true,
      queuePausedOnStart: true,
      activationDisablesSimulation: true,
      regionId: 'us-east1'
    });
  });

  test('should start with simulation mode when configured', () => {
    const mockLogger = createMockLogger();
    const mockPerfLogger = createMockPerfLogger();
    const mockStateManager = createMockStateManager();

    const engine = new ExecutionEngineService({
      logger: mockLogger,
      perfLogger: mockPerfLogger as any,
      stateManager: mockStateManager as any,
      simulationConfig: {
        enabled: true,
        successRate: 0.9
      },
      standbyConfig: {
        isStandby: true,
        queuePausedOnStart: true,
        activationDisablesSimulation: true,
        regionId: 'us-east1'
      }
    });

    expect(engine.getIsSimulationMode()).toBe(true);
    expect(engine.getIsStandby()).toBe(true);
  });
});

// =============================================================================
// Queue Service Pause/Resume Tests (ADR-007)
// =============================================================================

import { QueueServiceImpl } from './services/queue.service';

describe('QueueService Pause/Resume (ADR-007)', () => {
  // Mock logger factory
  const createMockLogger = () => ({
    info: jest.fn<(msg: string, meta?: object) => void>(),
    error: jest.fn<(msg: string, meta?: object) => void>(),
    warn: jest.fn<(msg: string, meta?: object) => void>(),
    debug: jest.fn<(msg: string, meta?: object) => void>()
  });

  test('should pause queue manually for standby mode', () => {
    const mockLogger = createMockLogger();
    const queueService = new QueueServiceImpl({
      logger: mockLogger
    });

    expect(queueService.isPaused()).toBe(false);
    expect(queueService.isManuallyPaused()).toBe(false);

    queueService.pause();

    expect(queueService.isPaused()).toBe(true);
    expect(queueService.isManuallyPaused()).toBe(true);
    expect(mockLogger.info).toHaveBeenCalledWith('Queue manually paused (standby mode)');
  });

  test('should resume manually paused queue on activation', () => {
    const mockLogger = createMockLogger();
    const queueService = new QueueServiceImpl({
      logger: mockLogger
    });

    queueService.pause();
    expect(queueService.isPaused()).toBe(true);

    queueService.resume();

    expect(queueService.isPaused()).toBe(false);
    expect(queueService.isManuallyPaused()).toBe(false);
    expect(mockLogger.info).toHaveBeenCalledWith('Queue manually resumed (activated)');
  });

  test('should not enqueue when manually paused', () => {
    const mockLogger = createMockLogger();
    const queueService = new QueueServiceImpl({
      logger: mockLogger
    });

    queueService.pause();

    const result = queueService.canEnqueue();
    expect(result).toBe(false);
  });

  test('should allow enqueue after resume', () => {
    const mockLogger = createMockLogger();
    const queueService = new QueueServiceImpl({
      logger: mockLogger
    });

    queueService.pause();
    expect(queueService.canEnqueue()).toBe(false);

    queueService.resume();
    expect(queueService.canEnqueue()).toBe(true);
  });

  test('should notify callback on pause state change', () => {
    const mockLogger = createMockLogger();
    const mockCallback = jest.fn();
    const queueService = new QueueServiceImpl({
      logger: mockLogger
    });

    queueService.onPauseStateChange(mockCallback);

    queueService.pause();
    expect(mockCallback).toHaveBeenCalledWith(true);

    queueService.resume();
    expect(mockCallback).toHaveBeenCalledWith(false);
  });

  test('should not double-pause or double-resume', () => {
    const mockLogger = createMockLogger();
    const queueService = new QueueServiceImpl({
      logger: mockLogger
    });

    queueService.pause();
    const callCount = (mockLogger.info as jest.Mock).mock.calls.length;

    queueService.pause(); // Should not log again
    expect((mockLogger.info as jest.Mock).mock.calls.length).toBe(callCount);

    queueService.resume();
    const resumeCallCount = (mockLogger.info as jest.Mock).mock.calls.length;

    queueService.resume(); // Should not log again
    expect((mockLogger.info as jest.Mock).mock.calls.length).toBe(resumeCallCount);
  });

  test('clear should reset manual pause state', () => {
    const mockLogger = createMockLogger();
    const queueService = new QueueServiceImpl({
      logger: mockLogger
    });

    queueService.pause();
    expect(queueService.isManuallyPaused()).toBe(true);

    queueService.clear();
    expect(queueService.isManuallyPaused()).toBe(false);
    expect(queueService.isPaused()).toBe(false);
  });
});

// =============================================================================
// Circuit Breaker Integration Tests (Phase 1.3.3)
// =============================================================================

import {
  createCircuitBreaker,
  CircuitBreaker,
  CircuitBreakerEvent,
} from './services/circuit-breaker';

describe('Circuit Breaker Integration Tests (Phase 1.3.3)', () => {
  // Test helpers
  const createMockLogger = () => ({
    info: jest.fn<(msg: string, meta?: object) => void>(),
    error: jest.fn<(msg: string, meta?: object) => void>(),
    warn: jest.fn<(msg: string, meta?: object) => void>(),
    debug: jest.fn<(msg: string, meta?: object) => void>(),
  });

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
      expect(halfOpenEvent).toBeDefined();
      expect(halfOpenEvent?.previousState).toBe('OPEN');

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
      expect(closeEvent).toBeDefined();
      expect(closeEvent?.reason).toContain('recovered');

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
      expect(reopenEvent).toBeDefined();
      expect(reopenEvent?.reason).toContain('HALF_OPEN');

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
      const mockPerfLogger = {
        logEventLatency: jest.fn(),
        logExecutionResult: jest.fn(),
        logHealthCheck: jest.fn(),
      };
      const mockStateManager = {
        getState: jest.fn(() => 'idle'),
        executeStart: jest.fn((fn: () => Promise<void>) => fn()),
        executeStop: jest.fn((fn: () => Promise<void>) => fn()),
        transition: jest.fn(() => Promise.resolve({ success: true })),
        isTransitioning: jest.fn(() => false),
        isRunning: jest.fn(() => false),
        waitForIdle: jest.fn(() => Promise.resolve()),
        on: jest.fn(),
        off: jest.fn(),
        canTransition: jest.fn(() => true),
      };

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
      const mockPerfLogger = {
        logEventLatency: jest.fn(),
        logExecutionResult: jest.fn(),
        logHealthCheck: jest.fn(),
      };
      const mockStateManager = {
        getState: jest.fn(() => 'idle'),
        executeStart: jest.fn((fn: () => Promise<void>) => fn()),
        executeStop: jest.fn((fn: () => Promise<void>) => fn()),
        transition: jest.fn(() => Promise.resolve({ success: true })),
        isTransitioning: jest.fn(() => false),
        isRunning: jest.fn(() => false),
        waitForIdle: jest.fn(() => Promise.resolve()),
        on: jest.fn(),
        off: jest.fn(),
        canTransition: jest.fn(() => true),
      };

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
      const mockPerfLogger = {
        logEventLatency: jest.fn(),
        logExecutionResult: jest.fn(),
        logHealthCheck: jest.fn(),
      };
      const mockStateManager = {
        getState: jest.fn(() => 'idle'),
        executeStart: jest.fn((fn: () => Promise<void>) => fn()),
        executeStop: jest.fn((fn: () => Promise<void>) => fn()),
        transition: jest.fn(() => Promise.resolve({ success: true })),
        isTransitioning: jest.fn(() => false),
        isRunning: jest.fn(() => false),
        waitForIdle: jest.fn(() => Promise.resolve()),
        on: jest.fn(),
        off: jest.fn(),
        canTransition: jest.fn(() => true),
      };

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
      const mockPerfLogger = {
        logEventLatency: jest.fn(),
        logExecutionResult: jest.fn(),
        logHealthCheck: jest.fn(),
      };
      const mockStateManager = {
        getState: jest.fn(() => 'idle'),
        executeStart: jest.fn((fn: () => Promise<void>) => fn()),
        executeStop: jest.fn((fn: () => Promise<void>) => fn()),
        transition: jest.fn(() => Promise.resolve({ success: true })),
        isTransitioning: jest.fn(() => false),
        isRunning: jest.fn(() => false),
        waitForIdle: jest.fn(() => Promise.resolve()),
        on: jest.fn(),
        off: jest.fn(),
        canTransition: jest.fn(() => true),
      };

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
      expect(forceCloseEvent).toBeDefined();

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
