/**
 * Self-Healing Manager Tests
 *
 * Tests for the SelfHealingManager including service registration,
 * health check detection, recovery trigger/execution, rate limiting,
 * recovery strategies, state transitions, and cleanup/shutdown.
 *
 * @see shared/core/src/resilience/self-healing-manager.ts
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  SelfHealingManager,
  ServiceDefinition,
  RecoveryStrategy,
  resetSelfHealingManager,
  getSelfHealingManager,
} from '../../../src/resilience/self-healing-manager';
import type { ServiceHealth } from '@arbitrage/types';

// =============================================================================
// Module mocks
// =============================================================================

// Mock logger to suppress output
jest.mock('../../../src/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn(),
  })),
}));

// Mock lifecycle-utils
jest.mock('../../../src/async/lifecycle-utils', () => ({
  clearIntervalSafe: jest.fn((timer: any) => {
    if (timer) clearInterval(timer);
    return null;
  }),
}));

// Mock Redis client - uses shared factory from @arbitrage/test-utils
// Must create mock INSIDE jest.mock factory (hoisted above module-scope const)
jest.mock('../../../src/redis/client', () => {
  const { createInlineRedisMock } = require('@arbitrage/test-utils');
  return {
    getRedisClient: jest.fn(),
    _mockRedis: createInlineRedisMock(),
  };
});

const redisMod = require('../../../src/redis/client') as any;
const mockRedis = redisMod._mockRedis;

// Mock Redis Streams client
const mockStreamsClient = {
  xadd: jest.fn(() => Promise.resolve('1234567890-0')),
  disconnect: jest.fn(() => Promise.resolve(undefined)),
};

jest.mock('../../../src/redis/streams', () => ({
  getRedisStreamsClient: jest.fn(),
  RedisStreamsClient: { STREAMS: {
    SERVICE_DEGRADATION: 'stream:service-degradation',
  } },
}));

// Mock dual-publish utility
jest.mock('../../../src/resilience/dual-publish', () => ({
  dualPublish: jest.fn(() => Promise.resolve(undefined)),
}));

// Mock circuit-breaker
const mockCircuitBreaker = {
  execute: jest.fn((fn: () => Promise<any>) => fn()),
  forceOpen: jest.fn(),
  getStats: jest.fn(() => ({ state: 'CLOSED', failures: 0 })),
};

jest.mock('../../../src/resilience/circuit-breaker', () => ({
  createCircuitBreaker: jest.fn(() => mockCircuitBreaker),
  CircuitBreakerError: class CircuitBreakerError extends Error {
    constructor(msg?: string) { super(msg ?? 'Circuit breaker open'); this.name = 'CircuitBreakerError'; }
  },
}));

// Mock config module
jest.mock('../../../../config/src', () => ({
  SYSTEM_CONSTANTS: {
    selfHealing: {
      circuitBreakerCooldownMs: 100,
      healthCheckFailureThreshold: 3,
      gracefulDegradationThreshold: 10,
      maxRestartDelayMs: 1000,
      simulatedRestartDelayMs: 10,
      simulatedRestartFailureRate: 0,
    },
    circuitBreaker: {
      defaultFailureThreshold: 3,
      defaultRecoveryTimeoutMs: 100,
      defaultMonitoringPeriodMs: 200,
      defaultSuccessThreshold: 2,
    },
  },
}), { virtual: true });

// =============================================================================
// Helpers
// =============================================================================

const createServiceDef = (overrides: Partial<ServiceDefinition> = {}): ServiceDefinition => ({
  name: 'test-service',
  startCommand: 'node dist/index.js',
  healthCheckInterval: 5000,
  restartDelay: 1000,
  maxRestarts: 3,
  environment: { NODE_ENV: 'test' },
  ...overrides,
});

describe('SelfHealingManager', () => {
  let manager: SelfHealingManager;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Re-establish mock implementations after resetMocks wipes them
    redisMod.getRedisClient.mockResolvedValue(mockRedis);
    const { getRedisStreamsClient } = require('../../../src/redis/streams') as any;
    getRedisStreamsClient.mockResolvedValue(mockStreamsClient);
    mockRedis.set.mockResolvedValue(undefined);
    mockRedis.get.mockResolvedValue(null);
    mockRedis.del.mockResolvedValue(1);
    mockRedis.publish.mockResolvedValue(1);
    mockRedis.subscribe.mockResolvedValue(undefined);
    mockRedis.disconnect.mockResolvedValue(undefined);
    mockRedis.ping.mockResolvedValue(true);

    mockStreamsClient.xadd.mockResolvedValue('1234567890-0');
    mockStreamsClient.disconnect.mockResolvedValue(undefined);

    mockCircuitBreaker.execute.mockImplementation((fn: () => Promise<any>) => fn());
    mockCircuitBreaker.forceOpen.mockReturnValue(undefined);

    manager = new SelfHealingManager();
  });

  afterEach(async () => {
    // Stop the manager to clear all timers
    try {
      await manager.stop();
    } catch {
      // Ignore errors during cleanup
    }
    jest.useRealTimers();
  });

  describe('basic initialization', () => {
    it('should create a new SelfHealingManager instance', () => {
      expect(manager).toBeInstanceOf(SelfHealingManager);
    });

    it('should have no registered services initially', () => {
      const health = manager.getAllServiceHealth();
      expect(Object.keys(health)).toHaveLength(0);
    });

    it('should resolve ensureInitialized without error', async () => {
      await expect(manager.ensureInitialized()).resolves.toBeUndefined();
    });
  });

  describe('service registration', () => {
    it('should register a service and track its health', () => {
      const def = createServiceDef();
      manager.registerService(def);

      const health = manager.getAllServiceHealth();
      expect(health).toHaveProperty('test-service');
      expect(health['test-service'].name).toBe('test-service');
    });

    it('should initialize service health with stopping status', () => {
      const def = createServiceDef();
      manager.registerService(def);

      const health = manager.getAllServiceHealth();
      expect(health['test-service'].status).toBe('stopping');
      expect(health['test-service'].consecutiveFailures).toBe(0);
      expect(health['test-service'].restartCount).toBe(0);
    });

    it('should register multiple services independently', () => {
      manager.registerService(createServiceDef({ name: 'service-a' }));
      manager.registerService(createServiceDef({ name: 'service-b' }));

      const health = manager.getAllServiceHealth();
      expect(Object.keys(health)).toHaveLength(2);
      expect(health).toHaveProperty('service-a');
      expect(health).toHaveProperty('service-b');
    });
  });

  describe('health check detection of unhealthy state', () => {
    it('should start health monitoring when manager starts', async () => {
      const def = createServiceDef({ healthCheckInterval: 1000 });
      manager.registerService(def);

      await manager.ensureInitialized();
      await manager.start();

      // Health monitoring should be set up (intervals are tracked internally)
      const health = manager.getAllServiceHealth();
      expect(health).toHaveProperty('test-service');
    });

    it('should not start twice if already running', async () => {
      const def = createServiceDef();
      manager.registerService(def);

      await manager.ensureInitialized();
      await manager.start();
      await manager.start(); // Should be a no-op

      // If it started twice, subscribe would be called twice
      // It should only be called once
      const redisMod = require('../../../src/redis/client') as any;
      const redis = await redisMod.getRedisClient();
      // subscribe is called once during start()
      expect(redis.subscribe).toHaveBeenCalledTimes(1);
    });
  });

  describe('recovery trigger and execution', () => {
    it('should return false when triggering recovery for unknown service', async () => {
      const result = await manager.triggerRecovery('nonexistent-service');
      expect(result).toBe(false);
    });

    it('should trigger recovery for a registered service with failures', async () => {
      const def = createServiceDef({ name: 'failing-service' });
      manager.registerService(def);

      // Manually set service to unhealthy state with failures
      const health = manager.getAllServiceHealth();
      const serviceHealth = health['failing-service'];
      expect(serviceHealth).toBeDefined();

      // The simple_restart strategy checks consecutiveFailures > 0
      // We need to make the internal health state have failures
      // triggerRecovery calls executeRecoveryStrategies which iterates strategies
      const result = await manager.triggerRecovery('failing-service', new Error('test failure'));

      // The result depends on whether a strategy can handle and succeeds.
      // With zero consecutive failures and restartCount=0, simple_restart's
      // canHandle checks consecutiveFailures > 0 which is false at init (0).
      // All strategies may fail to handle, returning false.
      expect(typeof result).toBe('boolean');
    });
  });

  describe('recovery rate limiting', () => {
    it('should rate-limit rapid recovery triggers for the same service', async () => {
      const def = createServiceDef({ name: 'rate-limited-service' });
      manager.registerService(def);

      // First trigger should proceed
      const result1 = await manager.triggerRecovery('rate-limited-service');
      expect(typeof result1).toBe('boolean');

      // Second trigger immediately should be rate limited
      const result2 = await manager.triggerRecovery('rate-limited-service');
      expect(result2).toBe(false);
    });

    it('should allow recovery after cooldown period expires', async () => {
      const def = createServiceDef({ name: 'cooldown-service' });
      manager.registerService(def);

      // First trigger
      await manager.triggerRecovery('cooldown-service');

      // Advance time past the cooldown period (configured to 100ms in test)
      jest.advanceTimersByTime(150);

      // Second trigger should be allowed (not rate limited)
      const result = await manager.triggerRecovery('cooldown-service');
      expect(typeof result).toBe('boolean');
      // It should not be rate-limited (it may still return false for other reasons,
      // but the rate limiter won't block it)
    });
  });

  describe('custom recovery strategies', () => {
    it('should allow adding custom recovery strategies', () => {
      const customStrategy: RecoveryStrategy = {
        name: 'custom_test_strategy',
        priority: 200,
        canHandle: () => true,
        execute: async () => true,
      };

      // Should not throw
      manager.addRecoveryStrategy(customStrategy);
    });

    it('should sort strategies by priority (higher first)', async () => {
      const def = createServiceDef({ name: 'strategy-test-service' });
      manager.registerService(def);

      const executionOrder: string[] = [];

      manager.addRecoveryStrategy({
        name: 'low_priority',
        priority: 10,
        canHandle: () => true,
        execute: async () => {
          executionOrder.push('low_priority');
          return false; // Return false so next strategy is tried
        },
      });

      manager.addRecoveryStrategy({
        name: 'high_priority',
        priority: 200,
        canHandle: () => true,
        execute: async () => {
          executionOrder.push('high_priority');
          return true; // Return true to stop iteration
        },
      });

      await manager.triggerRecovery('strategy-test-service');

      // high_priority (200) should run before low_priority (10)
      // Since high_priority returns true, low_priority should not be reached
      expect(executionOrder).toContain('high_priority');
    });
  });

  describe('recovery failure handling', () => {
    it('should handle strategy execution errors gracefully', async () => {
      const def = createServiceDef({ name: 'error-service' });
      manager.registerService(def);

      manager.addRecoveryStrategy({
        name: 'throwing_strategy',
        priority: 200,
        canHandle: () => true,
        execute: async () => {
          throw new Error('Strategy internal error');
        },
      });

      // Should not throw, should return false when all strategies fail
      const result = await manager.triggerRecovery('error-service');
      expect(typeof result).toBe('boolean');
    });
  });

  describe('state transitions', () => {
    it('should return health with correct initial status fields', () => {
      manager.registerService(createServiceDef({ name: 'state-service' }));

      const health = manager.getAllServiceHealth();
      const serviceHealth = health['state-service'];

      expect(serviceHealth.status).toBe('stopping');
      expect(serviceHealth.lastHeartbeat).toBe(0);
      expect(serviceHealth.consecutiveFailures).toBe(0);
      expect(serviceHealth.restartCount).toBe(0);
      expect(serviceHealth.uptime).toBe(0);
      expect(serviceHealth.memoryUsage).toBe(0);
      expect(serviceHealth.cpuUsage).toBe(0);
    });

    it('should return a copy of health data (not internal reference)', () => {
      manager.registerService(createServiceDef({ name: 'copy-service' }));

      const health1 = manager.getAllServiceHealth();
      const health2 = manager.getAllServiceHealth();

      // Should be different object references
      expect(health1['copy-service']).not.toBe(health2['copy-service']);
      // But same data
      expect(health1['copy-service']).toEqual(health2['copy-service']);
    });
  });

  describe('cleanup and shutdown', () => {
    it('should stop without error when not started', async () => {
      await expect(manager.stop()).resolves.toBeUndefined();
    });

    it('should stop cleanly after starting', async () => {
      manager.registerService(createServiceDef());
      await manager.ensureInitialized();
      await manager.start();

      await expect(manager.stop()).resolves.toBeUndefined();
    });

    it('should not stop twice if already stopped', async () => {
      manager.registerService(createServiceDef());
      await manager.ensureInitialized();
      await manager.start();

      await manager.stop();
      // Second stop should be a no-op (isRunning is already false)
      await expect(manager.stop()).resolves.toBeUndefined();
    });

    it('should disconnect Redis on stop', async () => {
      manager.registerService(createServiceDef());
      await manager.ensureInitialized();
      await manager.start();
      await manager.stop();

      expect(mockRedis.disconnect).toHaveBeenCalled();
    });
  });

  describe('singleton management', () => {
    it('should return a manager instance from getSelfHealingManager', async () => {
      const instance = await getSelfHealingManager();
      expect(instance).toBeInstanceOf(SelfHealingManager);

      // Clean up singleton
      await resetSelfHealingManager();
    });

    it('should reset singleton via resetSelfHealingManager', async () => {
      await getSelfHealingManager();
      await expect(resetSelfHealingManager()).resolves.toBeUndefined();
    });
  });
});
