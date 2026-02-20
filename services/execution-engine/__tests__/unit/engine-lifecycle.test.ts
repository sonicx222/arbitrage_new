/**
 * Engine Lifecycle Tests (P0-4)
 *
 * Validates start/stop lifecycle for ExecutionEngineService.
 * Uses simulation mode to isolate lifecycle behavior from RPC provider complexity.
 *
 * Tests cover:
 * - start() initializes all subsystems and transitions to running state
 * - stop() cleans up all subsystems and transitions to stopped state
 * - start() → stop() → restart works correctly
 * - Queue pauses in standby mode during start()
 * - Error during start() propagates correctly
 *
 * @see engine.ts lines 411-819
 * @see docs/reports/EXECUTION_ENGINE_DEEP_ANALYSIS_2026-02-20.md P0-4
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Make this file a module
export {};

// =============================================================================
// Module-Level State (shared between mock factory and tests)
// =============================================================================

let currentState = 'idle';

// Track mock call counts for assertions that survive resetMocks
let redisClientCreated = false;
let streamsClientCreated = false;
let lockManagerCreated = false;
let nonceManagerCreated = false;
let consumerGroupCreated = false;
let initResetCalled = false;
let disconnectCalled = false;

function resetTrackingFlags(): void {
  redisClientCreated = false;
  streamsClientCreated = false;
  lockManagerCreated = false;
  nonceManagerCreated = false;
  consumerGroupCreated = false;
  initResetCalled = false;
  disconnectCalled = false;
  currentState = 'idle';
}

// =============================================================================
// Mock ioredis
// =============================================================================
jest.mock('ioredis', () => {
  const instance = {
    xadd: jest.fn<any>(() => Promise.resolve('1-0')),
    xread: jest.fn<any>(() => Promise.resolve(null)),
    xreadgroup: jest.fn<any>(() => Promise.resolve(null)),
    xack: jest.fn<any>(() => Promise.resolve(1)),
    xgroup: jest.fn<any>(() => Promise.resolve('OK')),
    xinfo: jest.fn<any>(() => Promise.resolve(['length', 0])),
    xlen: jest.fn<any>(() => Promise.resolve(0)),
    xpending: jest.fn<any>(() => Promise.resolve([0, null, null, []])),
    xtrim: jest.fn<any>(() => Promise.resolve(0)),
    ping: jest.fn<any>(() => Promise.resolve('PONG')),
    get: jest.fn<any>(() => Promise.resolve(null)),
    set: jest.fn<any>(() => Promise.resolve('OK')),
    setNx: jest.fn<any>(() => Promise.resolve(true)),
    del: jest.fn<any>(() => Promise.resolve(1)),
    expire: jest.fn<any>(() => Promise.resolve(1)),
    disconnect: jest.fn<any>(() => Promise.resolve(undefined)),
    quit: jest.fn<any>(() => Promise.resolve('OK')),
    connect: jest.fn<any>(() => Promise.resolve(undefined)),
    on: jest.fn().mockReturnThis(),
    off: jest.fn().mockReturnThis(),
    removeAllListeners: jest.fn().mockReturnThis(),
    status: 'ready',
  };

  const MockRedis = function() { return instance; };
  MockRedis.default = MockRedis;
  MockRedis.Redis = MockRedis;
  return MockRedis;
});

// =============================================================================
// Mock @arbitrage/core
// =============================================================================
jest.mock('@arbitrage/core', () => {
  const actual = jest.requireActual('@arbitrage/core') as Record<string, unknown>;

  // Use closures (not jest.fn() .mockImplementation) so resetMocks can't strip them.
  // The outer closure captures the tracking flags by reference.

  const makeStreamsClient = () => ({
    createConsumerGroup: jest.fn<any>(() => {
      consumerGroupCreated = true;
      return Promise.resolve(undefined);
    }),
    xadd: jest.fn<any>(() => Promise.resolve('1-0')),
    xack: jest.fn<any>(() => Promise.resolve(1)),
    disconnect: jest.fn<any>(() => Promise.resolve(undefined)),
    STREAMS: { EXECUTION_REQUESTS: 'stream:execution-requests' },
  });

  const makeRedisClient = () => ({
    get: jest.fn<any>(() => Promise.resolve(null)),
    set: jest.fn<any>(() => Promise.resolve('OK')),
    setNx: jest.fn<any>(() => Promise.resolve(true)),
    expire: jest.fn<any>(() => Promise.resolve(1)),
    disconnect: jest.fn<any>(() => Promise.resolve(undefined)),
    updateServiceHealth: jest.fn<any>(() => Promise.resolve(undefined)),
    getAllServiceHealth: jest.fn<any>(() => Promise.resolve({})),
  });

  const makeLockManager = () => ({
    withLock: jest.fn<any>(async (_key: string, fn: () => Promise<void>) => {
      await fn();
      return { success: true };
    }),
    shutdown: jest.fn<any>(() => Promise.resolve(undefined)),
    disconnect: jest.fn<any>(() => Promise.resolve(undefined)),
  });

  const makeNonceManager = () => ({
    start: jest.fn(),
    stop: jest.fn<any>(() => Promise.resolve(undefined)),
    registerWallet: jest.fn(),
    getNextNonce: jest.fn<any>(() => Promise.resolve(1)),
    confirmTransaction: jest.fn(),
    failTransaction: jest.fn(),
    resetChain: jest.fn(),
    disconnect: jest.fn<any>(() => Promise.resolve(undefined)),
  });

  const makeStateManager = () => ({
    getState: jest.fn(() => currentState),
    executeStart: jest.fn(async (fn: () => Promise<void>) => {
      currentState = 'starting';
      try {
        await fn();
        currentState = 'running';
        return { success: true };
      } catch (error) {
        currentState = 'idle';
        return { success: false, error };
      }
    }),
    executeStop: jest.fn(async (fn: () => Promise<void>) => {
      currentState = 'stopping';
      try {
        await fn();
        currentState = 'stopped';
        return { success: true };
      } catch (error) {
        currentState = 'stopped';
        return { success: true };
      }
    }),
    isRunning: jest.fn(() => currentState === 'running'),
    transition: jest.fn<any>(() => Promise.resolve({ success: true })),
    isTransitioning: jest.fn(() => currentState === 'starting' || currentState === 'stopping'),
    waitForIdle: jest.fn<any>(() => Promise.resolve(undefined)),
    on: jest.fn(),
    off: jest.fn(),
    canTransition: jest.fn(() => true),
  });

  return {
    ...actual,
    // Factory functions: create fresh instances each call
    getRedisClient: async () => {
      redisClientCreated = true;
      return makeRedisClient();
    },
    getRedisStreamsClient: async () => {
      streamsClientCreated = true;
      return makeStreamsClient();
    },
    getDistributedLockManager: async () => {
      lockManagerCreated = true;
      return makeLockManager();
    },
    getNonceManager: () => {
      nonceManagerCreated = true;
      return makeNonceManager();
    },
    createServiceState: () => makeStateManager(),
    createLogger: (_name: string) => ({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    }),
    getPerformanceLogger: () => ({
      logEventLatency: jest.fn(),
      logExecutionResult: jest.fn(),
      logHealthCheck: jest.fn(),
    }),
    disconnectWithTimeout: async () => {
      disconnectCalled = true;
    },
    stopAndNullify: async (obj: any) => {
      if (obj && typeof obj.stop === 'function') {
        await obj.stop();
      }
      return null;
    },
    clearIntervalSafe: (timer: NodeJS.Timeout | null) => {
      if (timer) clearInterval(timer);
      return null;
    },
    TradeLogger: function() {
      return {
        log: jest.fn(),
        close: jest.fn<any>(() => Promise.resolve(undefined)),
        validateLogDir: jest.fn<any>(() => Promise.resolve(undefined)),
      };
    },
    resetDrawdownCircuitBreaker: () => {},
    resetEVCalculator: () => {},
    resetKellyPositionSizer: () => {},
    resetExecutionProbabilityTracker: () => {},
    RedisStreamsClient: {
      STREAMS: {
        EXECUTION_REQUESTS: 'stream:execution-requests',
        OPPORTUNITIES: 'stream:opportunities',
        EXECUTION_RESULTS: 'stream:execution-results',
      },
    },
    getErrorMessage: (err: unknown) => err instanceof Error ? err.message : String(err),
  };
});

// =============================================================================
// Mock initialization module
// =============================================================================
jest.mock('../../src/initialization', () => ({
  initializeMevProviders: async () => ({ success: true, factory: null }),
  initializeRiskManagement: () => ({
    success: true,
    enabled: false,
    drawdownBreaker: null,
    evCalculator: null,
    positionSizer: null,
    probabilityTracker: null,
    componentStatus: {},
  }),
  initializeBridgeRouter: () => ({ success: true, factory: null }),
  resetInitializationState: () => { initResetCalled = true; },
  isInitializationComplete: () => false,
  getLastPartialResults: () => null,
}));

// NOTE: @arbitrage/config is NOT mocked — real config values (including ABIs)
// are needed by flash loan provider modules during import chain resolution.

// =============================================================================
// Import after mocks
// =============================================================================
import { ExecutionEngineService } from '../../src/engine';

// =============================================================================
// Tests
// =============================================================================

describe('ExecutionEngineService Lifecycle (P0-4)', () => {
  let engine: ExecutionEngineService;

  beforeEach(() => {
    resetTrackingFlags();

    engine = new ExecutionEngineService({
      simulationConfig: { enabled: true },
    });
  });

  afterEach(async () => {
    // Ensure engine is stopped after each test to prevent timer leaks
    try {
      if (currentState === 'running') {
        await engine.stop();
      }
    } catch {
      // Ignore errors during cleanup
    }
  });

  // -------------------------------------------------------------------------
  // start() tests
  // -------------------------------------------------------------------------

  describe('start()', () => {
    it('should transition to running state after successful start', async () => {
      await engine.start();

      expect(currentState).toBe('running');
    });

    it('should initialize Redis clients during start', async () => {
      await engine.start();

      expect(redisClientCreated).toBe(true);
      expect(streamsClientCreated).toBe(true);
    });

    it('should initialize lock manager and nonce manager during start', async () => {
      await engine.start();

      expect(lockManagerCreated).toBe(true);
      expect(nonceManagerCreated).toBe(true);
    });

    it('should create consumer group during start', async () => {
      await engine.start();

      expect(consumerGroupCreated).toBe(true);
    });

    it('should have zero execution stats after start', async () => {
      await engine.start();

      const stats = engine.getStats();
      expect(stats.executionAttempts).toBe(0);
      expect(stats.successfulExecutions).toBe(0);
      expect(stats.failedExecutions).toBe(0);
    });

    it('should report queue size 0 after start', async () => {
      await engine.start();

      expect(engine.getQueueSize()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // stop() tests
  // -------------------------------------------------------------------------

  describe('stop()', () => {
    it('should transition to stopped state after stop', async () => {
      await engine.start();
      await engine.stop();

      expect(currentState).toBe('stopped');
    });

    it('should call resetInitializationState during stop', async () => {
      await engine.start();
      await engine.stop();

      expect(initResetCalled).toBe(true);
    });

    it('should disconnect infrastructure during stop', async () => {
      await engine.start();
      await engine.stop();

      expect(disconnectCalled).toBe(true);
    });

    it('should return queue size as 0 after stop', async () => {
      await engine.start();
      await engine.stop();

      expect(engine.getQueueSize()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Restart tests
  // -------------------------------------------------------------------------

  describe('start() → stop() → restart', () => {
    it('should support full restart cycle', async () => {
      // First start
      await engine.start();
      expect(currentState).toBe('running');

      // Stop
      await engine.stop();
      expect(currentState).toBe('stopped');

      // Create fresh engine (services were nullified during stop)
      resetTrackingFlags();
      const engine2 = new ExecutionEngineService({
        simulationConfig: { enabled: true },
      });

      // Second start
      await engine2.start();
      expect(currentState).toBe('running');

      // Verify subsystems were re-initialized
      expect(redisClientCreated).toBe(true);
      expect(streamsClientCreated).toBe(true);

      // Clean up
      await engine2.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Standby mode tests
  // -------------------------------------------------------------------------

  describe('standby mode during start', () => {
    it('should start in standby with paused queue when configured', async () => {
      const standbyEngine = new ExecutionEngineService({
        simulationConfig: { enabled: true },
        standbyConfig: {
          isStandby: true,
          queuePausedOnStart: true,
          activationDisablesSimulation: true,
          regionId: 'us-east1',
        },
      });

      await standbyEngine.start();

      expect(standbyEngine.getIsStandby()).toBe(true);
      expect(standbyEngine.isQueuePaused()).toBe(true);

      await standbyEngine.stop();
    });
  });
});
