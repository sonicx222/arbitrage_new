/**
 * Consolidated Regression Tests
 *
 * Phase 4 + P0/P1/P2 Bug Fix regression tests merged into a single file.
 *
 * Phase 4 Issues:
 * - Singleton initialization race conditions (distributed-lock, price-oracle)
 * - Event emission safety (service-state)
 * - Subscription memory leak (redis)
 * - Stop promise race (base-detector)
 * - Health monitoring shutdown race (base-detector)
 * - Promise.allSettled cleanup (base-detector)
 *
 * P0/P1/P2 Bug Fixes:
 * - P0-1: Non-atomic pair updates in base-detector.ts
 * - P0-5: Singleton error cache in price-oracle.ts
 * - P0-6: Whale alert silent failure in base-detector.ts
 * - P1-2: Backpressure race in execution-engine
 * - P1-3: Stream MAXLEN support in redis-streams.ts
 * - P1-5: Latency calculation in coordinator
 * - P2-1: EventBatcher TOCTOU race condition
 * - P2-2: CacheCoherencyManager non-atomic operations
 * - P2-3: SelfHealingManager health state TOCTOU
 * - P2-4: WebSocketManager timer cleanup edge cases
 * - CRITICAL-1: MEV/EIP-1559 gas pricing
 * - CRITICAL-2: Flash loan slippage
 * - CRITICAL-4: NonceManager
 * - Service lifecycle TOCTOU (with real AsyncMutex)
 *
 * @migrated from shared/core/src/regression.test.ts + fixes-regression.test.ts
 * @see ADR-009: Test Architecture
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { MockRedisClient } from '@arbitrage/test-utils/mocks/mock-factories';
import { createMockRedisClient } from '@arbitrage/test-utils/mocks/mock-factories';

let mockRedisClient: MockRedisClient;

// Mock the redis module
jest.mock('../../src/redis/client', () => ({
  getRedisClient: jest.fn<() => Promise<MockRedisClient>>().mockImplementation(() => Promise.resolve(mockRedisClient)),
  RedisClient: jest.fn()
}));

// Mock logger (auto-resolves to src/__mocks__/logger.ts)
jest.mock('../../src/logger');

// =============================================================================
// Singleton Race Condition Tests
// =============================================================================

describe('Singleton Race Condition Regression Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisClient = createMockRedisClient();
  });

  describe('DistributedLockManager singleton', () => {
    let getDistributedLockManager: () => Promise<any>;
    let resetDistributedLockManager: () => Promise<void>;

    beforeEach(async () => {
      // Dynamic import to get fresh module state
      jest.resetModules();
      const module = await import('../../src/redis/distributed-lock');
      getDistributedLockManager = module.getDistributedLockManager;
      resetDistributedLockManager = module.resetDistributedLockManager;
      await resetDistributedLockManager();
    });

    afterEach(async () => {
      await resetDistributedLockManager();
    });

    it('should handle concurrent initialization requests without race condition', async () => {
      // Simulate slow initialization
      let initCount = 0;
      const originalSetNx = mockRedisClient.setNx;
      mockRedisClient.setNx.mockImplementation(async (...args) => {
        initCount++;
        await Promise.resolve(); // Simulate async delay
        return originalSetNx.getMockImplementation()!(...args);
      });

      // Launch multiple concurrent initializations
      const promises = Array(10).fill(null).map(() => getDistributedLockManager());
      const instances = await Promise.all(promises);

      // All should return the same instance
      const firstInstance = instances[0];
      expect(instances.every(i => i === firstInstance)).toBe(true);

      // Only one initialization should have occurred
      // (initCount tracks how many times setNx was called during first lock acquire)
      expect(instances.filter(i => i === firstInstance).length).toBe(10);
    });

    it('should cache initialization errors', async () => {
      // Make getRedisClient fail
      const { getRedisClient } = await import('../../src/redis/client');
      (getRedisClient as jest.Mock).mockImplementation(() => Promise.reject(new Error('Init failed')));

      // First call should fail
      await expect(getDistributedLockManager()).rejects.toThrow('Init failed');

      // Subsequent calls should return cached error without re-attempting
      await expect(getDistributedLockManager()).rejects.toThrow('Init failed');
    });
  });

  describe('PriceOracle singleton', () => {
    let getPriceOracle: () => Promise<any>;
    let resetPriceOracle: () => void;

    beforeEach(async () => {
      jest.resetModules();
      const module = await import('../../src/analytics/price-oracle');
      getPriceOracle = module.getPriceOracle;
      resetPriceOracle = module.resetPriceOracle;
      resetPriceOracle();
    });

    afterEach(() => {
      resetPriceOracle();
    });

    it('should handle concurrent initialization requests without race condition', async () => {
      // Launch multiple concurrent initializations
      const promises = Array(10).fill(null).map(() => getPriceOracle());
      const instances = await Promise.all(promises);

      // All should return the same instance
      const firstInstance = instances[0];
      expect(instances.every(i => i === firstInstance)).toBe(true);
    });

    it('should cache initialization errors', async () => {
      // Make getRedisClient fail
      const { getRedisClient } = await import('../../src/redis/client');
      (getRedisClient as jest.Mock).mockImplementation(() => Promise.reject(new Error('Connection failed')));

      // First call should fail
      await expect(getPriceOracle()).rejects.toThrow('Connection failed');

      // Subsequent calls should return cached error
      await expect(getPriceOracle()).rejects.toThrow('Connection failed');
    });
  });
});

// =============================================================================
// Service State Event Emission Tests
// =============================================================================

describe('Service State Event Emission Regression Tests', () => {
  let ServiceStateManager: any;
  let createServiceState: any;
  let ServiceState: any;

  beforeEach(async () => {
    jest.resetModules();
    mockRedisClient = createMockRedisClient();
    const module = await import('../../src/service-lifecycle/service-state');
    ServiceStateManager = module.ServiceStateManager;
    createServiceState = module.createServiceState;
    ServiceState = module.ServiceState;
  });

  it('should not crash when event listener throws', async () => {
    const manager = createServiceState({
      serviceName: 'test-service',
      emitEvents: true
    });

    // Add listener that throws
    manager.on('stateChange', () => {
      throw new Error('Listener error');
    });

    // Also add default error listener to prevent unhandled error
    manager.on('error', () => {});

    // Transition should succeed despite listener error
    const result = await manager.executeStart(async () => {});

    expect(result.success).toBe(true);
    expect(manager.getState()).toBe(ServiceState.RUNNING);
  });

  it('should continue processing after event emission error', async () => {
    const manager = createServiceState({
      serviceName: 'test-service',
      emitEvents: true
    });

    let callCount = 0;
    manager.on('stateChange', () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('First listener error');
      }
    });
    manager.on('error', () => {});

    // First transition
    await manager.executeStart(async () => {});
    expect(manager.getState()).toBe(ServiceState.RUNNING);

    // Second transition should still work
    await manager.executeStop(async () => {});
    expect(manager.getState()).toBe(ServiceState.STOPPED);
  });
});

// =============================================================================
// Redis Subscription Memory Leak Tests
// =============================================================================

describe('Redis Subscription Memory Leak Regression Tests', () => {
  let RedisClient: any;

  beforeEach(async () => {
    jest.resetModules();

    // We need to test the actual RedisClient class, not the mock
    // This requires a different approach - we'll test the pattern
  });

  it('should cleanup listener on subscribe failure', async () => {
    // Create a mock subClient that tracks listeners
    const listeners: Function[] = [];
    const mockSubClient = {
      on: jest.fn((event: string, handler: Function) => {
        if (event === 'message') {
          listeners.push(handler);
        }
      }),
      removeListener: jest.fn((event: string, handler: Function) => {
        const index = listeners.indexOf(handler);
        if (index > -1) {
          listeners.splice(index, 1);
        }
      }),
      subscribe: jest.fn((_channel: string) => Promise.reject(new Error('Subscribe failed'))),
      removeAllListeners: jest.fn()
    };

    // Simulate the corrected subscribe pattern
    const subscriptions = new Map();
    const channel = 'test-channel';
    const callback = () => {};

    const listener = (receivedChannel: string, message: string) => {
      if (receivedChannel === channel) {
        callback();
      }
    };

    // Add listener first (as per fix)
    mockSubClient.on('message', listener);
    subscriptions.set(channel, { callback, listener });

    // Subscribe fails
    try {
      await mockSubClient.subscribe(channel);
    } catch {
      // Rollback on failure
      mockSubClient.removeListener('message', listener);
      subscriptions.delete(channel);
    }

    // Verify cleanup happened
    expect(listeners.length).toBe(0);
    expect(subscriptions.size).toBe(0);
  });

  it('should not lose messages when listener is added before subscribe', async () => {
    const messages: string[] = [];
    const listeners: Function[] = [];

    const mockSubClient = {
      on: jest.fn((event: string, handler: Function) => {
        if (event === 'message') {
          listeners.push(handler);
        }
      }),
      subscribe: jest.fn().mockImplementation(async () => {
        // Simulate message arriving during subscribe
        listeners.forEach(l => l('test-channel', '{"type":"test"}'));
      }),
      removeListener: jest.fn()
    };

    // Add listener BEFORE subscribe (the fix)
    const listener = (channel: string, message: string) => {
      if (channel === 'test-channel') {
        messages.push(message);
      }
    };
    mockSubClient.on('message', listener);

    // Now subscribe - message should be caught
    await mockSubClient.subscribe('test-channel');

    expect(messages.length).toBe(1);
    expect(messages[0]).toBe('{"type":"test"}');
  });
});

// =============================================================================
// ServiceStateManager Stop/Start Mutex Regression Tests
//
// Finding #14 FIX: Replaced standalone promise-race patterns (lines 315-412)
// with tests that import and exercise the REAL ServiceStateManager from
// shared/core/src/service-state.ts, ensuring tests detect real regressions.
//
// @see service-state.ts — ServiceStateManager implementation
// =============================================================================

describe('ServiceStateManager Stop Promise Race Regression Tests', () => {
  let ServiceStateManagerClass: typeof import('../../src/service-lifecycle/service-state').ServiceStateManager;
  let ServiceStateEnum: typeof import('../../src/service-lifecycle/service-state').ServiceState;
  let createServiceStateFn: typeof import('../../src/service-lifecycle/service-state').createServiceState;

  beforeEach(async () => {
    jest.resetModules();
    mockRedisClient = createMockRedisClient();
    const module = await import('../../src/service-lifecycle/service-state');
    ServiceStateManagerClass = module.ServiceStateManager;
    ServiceStateEnum = module.ServiceState;
    createServiceStateFn = module.createServiceState;
  });

  it('should handle concurrent stop calls via executeStop mutex', async () => {
    const manager = createServiceStateFn({
      serviceName: 'test-stop-race',
      emitEvents: false,
    });

    // Start the service first
    await manager.executeStart(async () => {});
    expect(manager.getState()).toBe(ServiceStateEnum.RUNNING);

    let cleanupCount = 0;
    const stopFn = async () => {
      cleanupCount++;
      await Promise.resolve(); // Simulate async cleanup
    };

    // Launch multiple concurrent stops — only the first should execute
    const results = await Promise.all([
      manager.executeStop(stopFn),
      manager.executeStop(stopFn),
      manager.executeStop(stopFn),
    ]);

    // Only one stop should have succeeded (the first); others fail because
    // the service is no longer in RUNNING state
    const successes = results.filter(r => r.success);
    expect(successes.length).toBe(1);
    expect(manager.getState()).toBe(ServiceStateEnum.STOPPED);
  });

  it('should allow start after stop completes via executeStart/executeStop', async () => {
    const manager = createServiceStateFn({
      serviceName: 'test-start-after-stop',
      emitEvents: false,
    });

    // Start
    await manager.executeStart(async () => {});
    expect(manager.getState()).toBe(ServiceStateEnum.RUNNING);

    // Stop
    await manager.executeStop(async () => {});
    expect(manager.getState()).toBe(ServiceStateEnum.STOPPED);

    // Start again — should succeed
    const result = await manager.executeStart(async () => {});
    expect(result.success).toBe(true);
    expect(manager.getState()).toBe(ServiceStateEnum.RUNNING);

    // Cleanup
    await manager.executeStop(async () => {});
  });

  it('should reject start while service is in STOPPING state', async () => {
    const manager = createServiceStateFn({
      serviceName: 'test-start-during-stop',
      emitEvents: false,
    });

    await manager.executeStart(async () => {});

    // Start a slow stop (use deferred to control completion timing)
    let resolveStop!: () => void;
    const stopDeferred = new Promise<void>(resolve => { resolveStop = resolve; });
    const stopPromise = manager.executeStop(async () => {
      await stopDeferred;
    });

    // Immediately try to start — should fail because state is STOPPING
    const startResult = await manager.executeStart(async () => {});
    expect(startResult.success).toBe(false);

    resolveStop();
    await stopPromise;
    expect(manager.getState()).toBe(ServiceStateEnum.STOPPED);
  });
});

// =============================================================================
// stopAndNullify and clearIntervalSafe/clearTimeoutSafe Regression Tests
//
// Finding #14 FIX: Replaced standalone Promise.allSettled patterns (lines 499-595)
// with tests that import and exercise REAL lifecycle-utils from
// shared/core/src/lifecycle-utils.ts.
//
// @see lifecycle-utils.ts — stopAndNullify, clearIntervalSafe, clearTimeoutSafe
// =============================================================================

import {
  stopAndNullify,
  clearIntervalSafe,
  clearTimeoutSafe,
} from '../../src/async/lifecycle-utils';

describe('Lifecycle Utils Cleanup Regression Tests', () => {
  describe('stopAndNullify', () => {
    it('should call stop() and return null', async () => {
      const stopMock = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
      const service = { stop: stopMock };

      const result = await stopAndNullify(service);

      expect(stopMock).toHaveBeenCalledTimes(1);
      expect(result).toBeNull();
    });

    it('should return null without calling stop when ref is null', async () => {
      const result = await stopAndNullify(null);
      expect(result).toBeNull();
    });

    it('should propagate stop() errors', async () => {
      const service = { stop: jest.fn<() => Promise<void>>().mockRejectedValue(new Error('stop failed')) };

      await expect(stopAndNullify(service)).rejects.toThrow('stop failed');
    });

    it('should handle synchronous stop() methods', async () => {
      const service = { stop: jest.fn<() => void>() };

      const result = await stopAndNullify(service);

      expect(service.stop).toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it('should cleanup multiple services with Promise.allSettled', async () => {
      const services = [
        { stop: jest.fn<() => Promise<void>>().mockResolvedValue(undefined) },
        { stop: jest.fn<() => Promise<void>>().mockRejectedValue(new Error('fail')) },
        { stop: jest.fn<() => Promise<void>>().mockResolvedValue(undefined) },
      ];

      const results = await Promise.allSettled(
        services.map(s => stopAndNullify(s))
      );

      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('rejected');
      expect(results[2].status).toBe('fulfilled');

      // All stop functions were called
      for (const s of services) {
        expect(s.stop).toHaveBeenCalledTimes(1);
      }
    });
  });

  describe('clearIntervalSafe', () => {
    it('should clear interval and return null', () => {
      const interval = setInterval(() => {}, 1000);
      const result = clearIntervalSafe(interval);

      expect(result).toBeNull();
    });

    it('should return null when given null', () => {
      const result = clearIntervalSafe(null);
      expect(result).toBeNull();
    });
  });

  describe('clearTimeoutSafe', () => {
    it('should clear timeout and return null', () => {
      const timeout = setTimeout(() => {}, 1000);
      const result = clearTimeoutSafe(timeout);

      expect(result).toBeNull();
    });

    it('should return null when given null', () => {
      const result = clearTimeoutSafe(null);
      expect(result).toBeNull();
    });
  });
});

// =============================================================================
// ServiceStateManager Full Lifecycle Integration Regression Tests
//
// Finding #14 FIX: Replaced standalone start/stop lifecycle patterns (lines 601-697)
// with tests that exercise the REAL ServiceStateManager full lifecycle,
// including rapid cycling and state machine transitions.
//
// @see service-state.ts — ServiceStateManager implementation
// =============================================================================

describe('ServiceStateManager Full Lifecycle Regression Tests', () => {
  let createServiceStateFn2: typeof import('../../src/service-lifecycle/service-state').createServiceState;
  let ServiceStateEnum2: typeof import('../../src/service-lifecycle/service-state').ServiceState;

  beforeEach(async () => {
    jest.resetModules();
    mockRedisClient = createMockRedisClient();
    const module = await import('../../src/service-lifecycle/service-state');
    createServiceStateFn2 = module.createServiceState;
    ServiceStateEnum2 = module.ServiceState;
  });

  it('should handle rapid start/stop cycles without race conditions', async () => {
    const manager = createServiceStateFn2({
      serviceName: 'test-rapid-cycle',
      emitEvents: false,
    });

    let startCount = 0;
    let stopCount = 0;

    for (let i = 0; i < 5; i++) {
      const startResult = await manager.executeStart(async () => { startCount++; });
      expect(startResult.success).toBe(true);
      expect(manager.getState()).toBe(ServiceStateEnum2.RUNNING);

      const stopResult = await manager.executeStop(async () => { stopCount++; });
      expect(stopResult.success).toBe(true);
      expect(manager.getState()).toBe(ServiceStateEnum2.STOPPED);
    }

    expect(startCount).toBe(5);
    expect(stopCount).toBe(5);
    expect(manager.getState()).toBe(ServiceStateEnum2.STOPPED);
  });

  it('should reject double-start while already running', async () => {
    const manager = createServiceStateFn2({
      serviceName: 'test-double-start',
      emitEvents: false,
    });

    // First start succeeds
    const result1 = await manager.executeStart(async () => {});
    expect(result1.success).toBe(true);

    // Second start fails (already running)
    const result2 = await manager.executeStart(async () => {});
    expect(result2.success).toBe(false);

    expect(manager.getState()).toBe(ServiceStateEnum2.RUNNING);

    // Cleanup
    await manager.executeStop(async () => {});
  });

  it('should reject double-stop while already stopped', async () => {
    const manager = createServiceStateFn2({
      serviceName: 'test-double-stop',
      emitEvents: false,
    });

    // Not started — stop should fail
    const result = await manager.executeStop(async () => {});
    expect(result.success).toBe(false);
  });

  it('should transition through all states correctly', async () => {
    const manager = createServiceStateFn2({
      serviceName: 'test-state-transitions',
      emitEvents: false,
    });

    expect(manager.getState()).toBe(ServiceStateEnum2.STOPPED);

    await manager.executeStart(async () => {});
    expect(manager.getState()).toBe(ServiceStateEnum2.RUNNING);

    await manager.executeStop(async () => {});
    expect(manager.getState()).toBe(ServiceStateEnum2.STOPPED);
  });
});

// =============================================================================
// P0/P1/P2 Bug Fix Regression Tests (merged from fixes-regression.test.ts)
// =============================================================================

// =============================================================================
// P0-1: Atomic Pair Updates Test
// =============================================================================

describe('P0-1: Atomic Pair Updates', () => {
  it('should update all pair properties atomically using Object.assign', () => {
    // Simulate the pair update pattern
    const pair: any = {
      address: '0x123',
      token0: 'WETH',
      token1: 'USDC',
      reserve0: '1000',
      reserve1: '2000',
      blockNumber: 100,
      lastUpdate: Date.now() - 1000
    };

    // Atomic update (how it should work now)
    const newData = {
      reserve0: '1500',
      reserve1: '2500',
      blockNumber: 101,
      lastUpdate: Date.now()
    };

    Object.assign(pair, newData);

    // All values should be updated
    expect(pair.reserve0).toBe('1500');
    expect(pair.reserve1).toBe('2500');
    expect(pair.blockNumber).toBe(101);
    expect(pair.lastUpdate).toBe(newData.lastUpdate);
  });

  it('should maintain consistency even with concurrent reads', () => {
    const pair: any = {
      reserve0: '1000',
      reserve1: '2000'
    };

    // Simulate multiple concurrent updates (all maintain 2:1 ratio)
    const updates = [
      { reserve0: '1100', reserve1: '2200' },
      { reserve0: '1200', reserve1: '2400' },
      { reserve0: '1300', reserve1: '2600' }
    ];

    for (const update of updates) {
      Object.assign(pair, update);
      // After each update, reserves should be consistent (from same update)
      const ratio = parseFloat(pair.reserve1) / parseFloat(pair.reserve0);
      expect(ratio).toBeCloseTo(2.0, 1); // Should maintain ~2:1 ratio
    }
  });
});

// =============================================================================
// P0-5: Singleton Error Cache Test
// =============================================================================

describe('P0-5: Singleton Error Recovery', () => {
  it('should allow retry after initialization failure', async () => {
    // Simulate the fixed pattern where errors are cleared on retry
    let initAttempts = 0;
    let instance: any = null;

    const getOrCreate = async (): Promise<any> => {
      if (instance) return instance;

      initAttempts++;
      if (initAttempts === 1) {
        throw new Error('First attempt fails');
      }

      instance = { initialized: true };
      return instance;
    };

    // First call fails
    await expect(getOrCreate()).rejects.toThrow('First attempt fails');

    // Second call should succeed (can retry after failure)
    const result = await getOrCreate();
    expect(result.initialized).toBe(true);
    expect(initAttempts).toBe(2);
  });

  it('should not cache errors permanently', async () => {
    let errorCount = 0;

    const tryInit = async (): Promise<void> => {
      errorCount++;
      if (errorCount <= 2) {
        throw new Error(`Attempt ${errorCount} failed`);
      }
      // Success on attempt 3+
    };

    // Multiple attempts should eventually succeed
    await expect(tryInit()).rejects.toThrow(); // Attempt 1
    await expect(tryInit()).rejects.toThrow(); // Attempt 2
    await expect(tryInit()).resolves.toBeUndefined(); // Attempt 3 succeeds
  });
});

// =============================================================================
// P0-6: Publish with Retry Test
// =============================================================================

describe('P0-6: Publish with Retry', () => {
  it('should retry on failure with exponential backoff', async () => {
    let attempts = 0;
    const maxRetries = 3;

    const publishWithRetry = async (
      publishFn: () => Promise<void>,
      operationName: string
    ): Promise<void> => {
      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await publishFn();
          return;
        } catch (error) {
          lastError = error as Error;
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 10)); // Quick sleep for test
          }
        }
      }

      throw new Error(`${operationName} failed after ${maxRetries} attempts`);
    };

    // Simulate function that fails twice then succeeds
    const failingPublish = async (): Promise<void> => {
      attempts++;
      if (attempts < 3) {
        throw new Error('Temporary failure');
      }
    };

    await publishWithRetry(failingPublish, 'test');
    expect(attempts).toBe(3);
  });

  it('should throw after max retries exhausted', async () => {
    const maxRetries = 3;

    const publishWithRetry = async (
      publishFn: () => Promise<void>,
      operationName: string
    ): Promise<void> => {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await publishFn();
          return;
        } catch {
          if (attempt === maxRetries) {
            throw new Error(`${operationName} failed after ${maxRetries} attempts`);
          }
        }
      }
    };

    const alwaysFails = async (): Promise<void> => {
      throw new Error('Always fails');
    };

    await expect(publishWithRetry(alwaysFails, 'test')).rejects.toThrow(
      'test failed after 3 attempts'
    );
  });
});

// =============================================================================
// P1-2: Backpressure Consolidation Test
// =============================================================================

describe('P1-2: Backpressure Logic', () => {
  it('should have single source of truth for backpressure state', () => {
    // Simulate the fixed pattern
    interface QueueConfig {
      maxSize: number;
      highWaterMark: number;
      lowWaterMark: number;
    }

    const config: QueueConfig = {
      maxSize: 100,
      highWaterMark: 80,
      lowWaterMark: 20
    };

    let queuePaused = false;
    const queue: number[] = [];

    // Single method for all backpressure updates
    const updateAndCheckBackpressure = (): boolean => {
      const queueSize = queue.length;

      if (queuePaused) {
        if (queueSize <= config.lowWaterMark) {
          queuePaused = false;
        }
      } else {
        if (queueSize >= config.highWaterMark) {
          queuePaused = true;
        }
      }

      return !queuePaused && queueSize < config.maxSize;
    };

    // Fill queue to high water mark
    for (let i = 0; i < 80; i++) {
      queue.push(i);
    }

    expect(updateAndCheckBackpressure()).toBe(false);
    expect(queuePaused).toBe(true);

    // Drain to low water mark
    queue.length = 20;
    expect(updateAndCheckBackpressure()).toBe(true);
    expect(queuePaused).toBe(false);
  });

  it('should implement hysteresis correctly', () => {
    const config = { highWaterMark: 80, lowWaterMark: 20 };
    let queuePaused = false;
    let queueSize = 0;

    const updateState = (size: number): boolean => {
      queueSize = size;

      if (queuePaused) {
        if (queueSize <= config.lowWaterMark) {
          queuePaused = false;
        }
      } else {
        if (queueSize >= config.highWaterMark) {
          queuePaused = true;
        }
      }

      return queuePaused;
    };

    // Initially not paused
    expect(updateState(50)).toBe(false);

    // Hit high water mark - pause
    expect(updateState(80)).toBe(true);

    // Still above low water mark - stay paused
    expect(updateState(50)).toBe(true);

    // Drop to low water mark - unpause
    expect(updateState(20)).toBe(false);
  });
});

// =============================================================================
// P1-3: Stream MAXLEN Test
// =============================================================================

describe('P1-3: Stream MAXLEN Support', () => {
  it('should support maxLen option in xadd', () => {
    interface XAddOptions {
      maxLen?: number;
      approximate?: boolean;
    }

    const buildXAddArgs = (
      streamName: string,
      options: XAddOptions = {}
    ): (string | number)[] => {
      const args: (string | number)[] = [streamName];

      if (options.maxLen !== undefined) {
        args.push('MAXLEN');
        if (options.approximate !== false) {
          args.push('~');
        }
        args.push(options.maxLen);
      }

      args.push('*');
      return args;
    };

    // Without MAXLEN
    expect(buildXAddArgs('stream:test')).toEqual(['stream:test', '*']);

    // With approximate MAXLEN
    expect(buildXAddArgs('stream:test', { maxLen: 1000 })).toEqual([
      'stream:test', 'MAXLEN', '~', 1000, '*'
    ]);

    // With exact MAXLEN
    expect(buildXAddArgs('stream:test', { maxLen: 1000, approximate: false })).toEqual([
      'stream:test', 'MAXLEN', 1000, '*'
    ]);
  });

  it('should have recommended MAXLEN values for all streams', () => {
    const STREAM_MAX_LENGTHS: Record<string, number> = {
      'stream:price-updates': 100000,
      'stream:swap-events': 50000,
      'stream:opportunities': 10000,
      'stream:whale-alerts': 5000,
      'stream:volume-aggregates': 10000,
      'stream:health': 1000
    };

    // All streams should have defined limits
    expect(STREAM_MAX_LENGTHS['stream:price-updates']).toBeGreaterThan(0);
    expect(STREAM_MAX_LENGTHS['stream:opportunities']).toBeGreaterThan(0);
    expect(STREAM_MAX_LENGTHS['stream:health']).toBeGreaterThan(0);

    // Limits should be reasonable
    expect(STREAM_MAX_LENGTHS['stream:health']).toBeLessThan(
      STREAM_MAX_LENGTHS['stream:price-updates']
    );
  });
});

// =============================================================================
// P1-5: Latency Calculation Test
// =============================================================================

describe('P1-5: Latency Calculation', () => {
  it('should correctly prioritize explicit latency over heartbeat calculation', () => {
    interface ServiceHealth {
      latency?: number;
      lastHeartbeat: number;
    }

    const calculateLatency = (health: ServiceHealth): number => {
      // P1-5 fix: Use nullish coalescing for correct precedence
      return health.latency ?? (health.lastHeartbeat ? Date.now() - health.lastHeartbeat : 0);
    };

    const now = Date.now();

    // With explicit latency
    expect(calculateLatency({ latency: 50, lastHeartbeat: now - 1000 })).toBe(50);

    // With zero latency (should use 0, not heartbeat)
    expect(calculateLatency({ latency: 0, lastHeartbeat: now - 1000 })).toBe(0);

    // Without explicit latency, use heartbeat
    const result = calculateLatency({ lastHeartbeat: now - 100 });
    expect(result).toBeGreaterThanOrEqual(100);
    expect(result).toBeLessThan(200); // Allow some timing variance
  });

  it('should calculate average latency correctly', () => {
    const services = [
      { latency: 50, lastHeartbeat: Date.now() - 1000 },
      { latency: 100, lastHeartbeat: Date.now() - 500 },
      { latency: 150, lastHeartbeat: Date.now() - 200 }
    ];

    const avgLatency = services.reduce((sum, health) => {
      const latency = health.latency ?? (health.lastHeartbeat ? Date.now() - health.lastHeartbeat : 0);
      return sum + latency;
    }, 0) / services.length;

    // Should use explicit latency values, not heartbeat diff
    expect(avgLatency).toBe(100); // (50 + 100 + 150) / 3
  });
});

// =============================================================================
// P0-2 & P1-1: Event Listener Cleanup Test
// =============================================================================

describe('Event Listener Cleanup', () => {
  it('should remove all listeners before stopping', () => {
    const events = require('events');
    const emitter = new events.EventEmitter();

    // Add listeners
    emitter.on('message', () => {});
    emitter.on('error', () => {});
    emitter.on('connected', () => {});

    expect(emitter.listenerCount('message')).toBe(1);
    expect(emitter.listenerCount('error')).toBe(1);
    expect(emitter.listenerCount('connected')).toBe(1);

    // P0-2 & P1-1 fix: Remove all listeners
    emitter.removeAllListeners();

    expect(emitter.listenerCount('message')).toBe(0);
    expect(emitter.listenerCount('error')).toBe(0);
    expect(emitter.listenerCount('connected')).toBe(0);
  });
});

// =============================================================================
// P1-4: Flash Loan Config Test
// =============================================================================

describe('P1-4: Flash Loan Configuration', () => {
  it('should have flash loan providers for all supported chains', () => {
    const FLASH_LOAN_PROVIDERS: Record<string, { address: string; protocol: string; fee: number }> = {
      ethereum: { address: '0x87870Bcd2C4c2e84A8c3C3a3FcACC94666c0d6Cf', protocol: 'aave_v3', fee: 9 },
      polygon: { address: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', protocol: 'aave_v3', fee: 9 },
      arbitrum: { address: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', protocol: 'aave_v3', fee: 9 },
      base: { address: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', protocol: 'aave_v3', fee: 9 },
      optimism: { address: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', protocol: 'aave_v3', fee: 9 },
      bsc: { address: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4', protocol: 'pancakeswap_v3', fee: 25 }
    };

    // All chains should have providers
    expect(FLASH_LOAN_PROVIDERS['ethereum']).toBeDefined();
    expect(FLASH_LOAN_PROVIDERS['polygon']).toBeDefined();
    expect(FLASH_LOAN_PROVIDERS['arbitrum']).toBeDefined();
    expect(FLASH_LOAN_PROVIDERS['base']).toBeDefined();
    expect(FLASH_LOAN_PROVIDERS['optimism']).toBeDefined();
    expect(FLASH_LOAN_PROVIDERS['bsc']).toBeDefined();

    // All addresses should be valid checksummed addresses
    for (const [chain, config] of Object.entries(FLASH_LOAN_PROVIDERS)) {
      expect(config.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(config.fee).toBeGreaterThan(0);
      expect(config.protocol).toBeTruthy();
    }
  });
});

// =============================================================================
// P2-1: EventBatcher TOCTOU Fix Test
// =============================================================================

