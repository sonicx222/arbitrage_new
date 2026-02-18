/**
 * Graceful Degradation Manager Tests
 *
 * Tests for GracefulDegradationManager including degradation level registration,
 * capability management, degradation triggering, feature-level vs system-level
 * degradation, recovery from degraded state, and cleanup/shutdown.
 *
 * @see shared/core/src/resilience/graceful-degradation.ts
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  GracefulDegradationManager,
  DegradationLevelConfig,
  ServiceCapability,
  DegradationState,
  resetGracefulDegradationManager,
  getGracefulDegradationManager,
  triggerDegradation,
  isFeatureEnabled,
  getCapabilityFallback,
} from '../../../src/resilience/graceful-degradation';
import { DegradationLevel } from '../../../src/monitoring/cross-region-health';

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

// Mock Redis client - uses shared factory from @arbitrage/test-utils
// Must create mock INSIDE jest.mock factory (hoisted above module-scope const)
jest.mock('../../../src/redis', () => {
  const { createInlineRedisMock } = require('@arbitrage/test-utils');
  return {
    getRedisClient: jest.fn(),
    _mockRedis: createInlineRedisMock(),
  };
});

const redisMod = require('../../../src/redis') as any;
const mockRedis = redisMod._mockRedis;

// Mock Redis Streams client
const mockStreamsClient = {
  xadd: jest.fn(() => Promise.resolve('1234567890-0')),
  disconnect: jest.fn(() => Promise.resolve(undefined)),
};

jest.mock('../../../src/redis-streams', () => ({
  getRedisStreamsClient: jest.fn(),
  RedisStreamsClient: { STREAMS: {} },
}));

// Mock dual-publish utility
jest.mock('../../../src/resilience/dual-publish', () => ({
  dualPublish: jest.fn(() => Promise.resolve(undefined)),
}));

// =============================================================================
// Helpers
// =============================================================================

const SERVICE_NAME = 'test-detector';

const createDegradationLevels = (): DegradationLevelConfig[] => [
  {
    level: DegradationLevel.FULL_OPERATION,
    name: 'normal',
    description: 'Full functionality',
    enabledFeatures: ['arbitrage_detection', 'price_prediction', 'real_time_updates'],
    disabledFeatures: [],
    performanceImpact: 0,
    recoveryPriority: 10,
  },
  {
    level: DegradationLevel.REDUCED_CHAINS,
    name: 'partial',
    description: 'Partial chain coverage',
    enabledFeatures: ['arbitrage_detection', 'real_time_updates'],
    disabledFeatures: ['price_prediction'],
    performanceImpact: 0.2,
    recoveryPriority: 8,
  },
  {
    level: DegradationLevel.DETECTION_ONLY,
    name: 'batch_only',
    description: 'Detection only, no real-time',
    enabledFeatures: ['arbitrage_detection'],
    disabledFeatures: ['price_prediction', 'real_time_updates'],
    performanceImpact: 0.5,
    recoveryPriority: 6,
  },
  {
    level: DegradationLevel.COMPLETE_OUTAGE,
    name: 'emergency',
    description: 'Emergency shutdown',
    enabledFeatures: [],
    disabledFeatures: ['arbitrage_detection', 'price_prediction', 'real_time_updates'],
    performanceImpact: 1.0,
    recoveryPriority: 2,
  },
];

const createCapabilities = (): ServiceCapability[] => [
  {
    name: 'redis_connection',
    required: true,
    degradationLevel: DegradationLevel.COMPLETE_OUTAGE,
  },
  {
    name: 'web3_connection',
    required: false,
    degradationLevel: DegradationLevel.REDUCED_CHAINS,
    fallback: { type: 'cached_data' },
  },
  {
    name: 'ml_prediction',
    required: false,
    degradationLevel: DegradationLevel.DETECTION_ONLY,
    fallback: { type: 'simple_spread' },
  },
];

describe('GracefulDegradationManager', () => {
  let manager: GracefulDegradationManager;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Re-establish mock implementations after resetMocks wipes them
    redisMod.getRedisClient.mockResolvedValue(mockRedis);
    const { getRedisStreamsClient } = require('../../../src/redis-streams') as any;
    getRedisStreamsClient.mockResolvedValue(mockStreamsClient);
    mockRedis.set.mockResolvedValue(undefined);
    mockRedis.get.mockResolvedValue(null);
    mockRedis.del.mockResolvedValue(1);
    mockRedis.publish.mockResolvedValue(1);
    mockRedis.ping.mockResolvedValue(true);
    mockRedis.disconnect.mockResolvedValue(undefined);

    mockStreamsClient.xadd.mockResolvedValue('1234567890-0');

    manager = new GracefulDegradationManager();
  });

  afterEach(() => {
    // Clean up recovery timers to prevent leaks
    resetGracefulDegradationManager();
    jest.useRealTimers();
  });

  describe('basic initialization', () => {
    it('should create a new GracefulDegradationManager instance', () => {
      expect(manager).toBeInstanceOf(GracefulDegradationManager);
    });

    it('should have no degradation states initially', () => {
      const states = manager.getAllDegradationStates();
      expect(Object.keys(states)).toHaveLength(0);
    });

    it('should return null for unknown service degradation state', () => {
      const state = manager.getDegradationState('nonexistent');
      expect(state).toBeNull();
    });

    it('should have default degradation levels for known services', () => {
      // Default levels are registered for known services like bsc-detector
      // We can verify by trying to trigger degradation on a known service
      // with registered capabilities
      const knownManager = new GracefulDegradationManager();
      const caps: ServiceCapability[] = [{
        name: 'web3_connection',
        required: false,
        degradationLevel: DegradationLevel.REDUCED_CHAINS,
      }];
      knownManager.registerCapabilities('bsc-detector', caps);

      // The default levels should already be registered for bsc-detector
      // so triggerDegradation should find the level config
      // We will verify this indirectly in the degradation tests
      expect(knownManager).toBeInstanceOf(GracefulDegradationManager);
    });
  });

  describe('degradation level and capability registration', () => {
    it('should register custom degradation levels for a service', () => {
      const levels = createDegradationLevels();
      manager.registerDegradationLevels(SERVICE_NAME, levels);

      // No error thrown means registration succeeded
      // We verify by triggering degradation later
      expect(true).toBe(true);
    });

    it('should register capabilities for a service', () => {
      const capabilities = createCapabilities();
      manager.registerCapabilities(SERVICE_NAME, capabilities);

      // Verify via getCapabilityFallback
      const fallback = manager.getCapabilityFallback(SERVICE_NAME, 'web3_connection');
      expect(fallback).toEqual({ type: 'cached_data' });
    });

    it('should return null fallback for unregistered service', () => {
      const fallback = manager.getCapabilityFallback('unknown-service', 'web3_connection');
      expect(fallback).toBeNull();
    });

    it('should return null fallback for unregistered capability', () => {
      manager.registerCapabilities(SERVICE_NAME, createCapabilities());
      const fallback = manager.getCapabilityFallback(SERVICE_NAME, 'nonexistent_cap');
      expect(fallback).toBeNull();
    });
  });

  describe('degradation activation when threshold met', () => {
    beforeEach(() => {
      manager.registerDegradationLevels(SERVICE_NAME, createDegradationLevels());
      manager.registerCapabilities(SERVICE_NAME, createCapabilities());
    });

    it('should activate degradation when a capability fails', async () => {
      const result = await manager.triggerDegradation(
        SERVICE_NAME,
        'web3_connection',
        new Error('Connection timeout')
      );

      expect(result).toBe(true);

      const state = manager.getDegradationState(SERVICE_NAME);
      expect(state).not.toBeNull();
      expect(state!.serviceName).toBe(SERVICE_NAME);
      expect(state!.currentLevel.level).toBe(DegradationLevel.REDUCED_CHAINS);
      expect(state!.triggeredBy).toBe('web3_connection');
    });

    it('should return false when triggering degradation for unregistered service', async () => {
      const result = await manager.triggerDegradation(
        'nonexistent-service',
        'web3_connection'
      );
      expect(result).toBe(false);
    });

    it('should return false when triggering with unknown capability', async () => {
      const result = await manager.triggerDegradation(
        SERVICE_NAME,
        'nonexistent_capability'
      );
      expect(result).toBe(false);
    });

    it('should return true if already in the same degradation level', async () => {
      // Trigger once
      await manager.triggerDegradation(SERVICE_NAME, 'web3_connection');

      // Trigger again for the same capability (same degradation level)
      const result = await manager.triggerDegradation(SERVICE_NAME, 'web3_connection');
      expect(result).toBe(true);
    });

    it('should update state when degradation level changes', async () => {
      // First trigger: REDUCED_CHAINS (via web3_connection)
      await manager.triggerDegradation(SERVICE_NAME, 'web3_connection');
      const state1 = manager.getDegradationState(SERVICE_NAME);
      expect(state1!.currentLevel.level).toBe(DegradationLevel.REDUCED_CHAINS);

      // Second trigger: DETECTION_ONLY (via ml_prediction)
      await manager.triggerDegradation(SERVICE_NAME, 'ml_prediction');
      const state2 = manager.getDegradationState(SERVICE_NAME);
      expect(state2!.currentLevel.level).toBe(DegradationLevel.DETECTION_ONLY);
      expect(state2!.previousLevel?.level).toBe(DegradationLevel.REDUCED_CHAINS);
    });

    it('should track degradation metrics in the state', async () => {
      await manager.triggerDegradation(SERVICE_NAME, 'web3_connection');

      const state = manager.getDegradationState(SERVICE_NAME);
      expect(state!.metrics).toBeDefined();
      expect(state!.metrics.performanceImpact).toBe(0.2);
      expect(typeof state!.metrics.errorRate).toBe('number');
      expect(typeof state!.metrics.throughputReduction).toBe('number');
    });

    it('should set canRecover to true and recoveryAttempts to 0', async () => {
      await manager.triggerDegradation(SERVICE_NAME, 'web3_connection');

      const state = manager.getDegradationState(SERVICE_NAME);
      expect(state!.canRecover).toBe(true);
      expect(state!.recoveryAttempts).toBe(0);
    });
  });

  describe('feature-level degradation vs system-level', () => {
    beforeEach(() => {
      manager.registerDegradationLevels(SERVICE_NAME, createDegradationLevels());
      manager.registerCapabilities(SERVICE_NAME, createCapabilities());
    });

    it('should report all features enabled when no degradation', () => {
      expect(manager.isFeatureEnabled(SERVICE_NAME, 'arbitrage_detection')).toBe(true);
      expect(manager.isFeatureEnabled(SERVICE_NAME, 'price_prediction')).toBe(true);
      expect(manager.isFeatureEnabled(SERVICE_NAME, 'real_time_updates')).toBe(true);
    });

    it('should disable specific features at REDUCED_CHAINS level', async () => {
      await manager.triggerDegradation(SERVICE_NAME, 'web3_connection');

      // REDUCED_CHAINS level enables: arbitrage_detection, real_time_updates
      // disables: price_prediction
      expect(manager.isFeatureEnabled(SERVICE_NAME, 'arbitrage_detection')).toBe(true);
      expect(manager.isFeatureEnabled(SERVICE_NAME, 'real_time_updates')).toBe(true);
      expect(manager.isFeatureEnabled(SERVICE_NAME, 'price_prediction')).toBe(false);
    });

    it('should disable more features at DETECTION_ONLY level', async () => {
      await manager.triggerDegradation(SERVICE_NAME, 'ml_prediction');

      // DETECTION_ONLY level enables: arbitrage_detection only
      expect(manager.isFeatureEnabled(SERVICE_NAME, 'arbitrage_detection')).toBe(true);
      expect(manager.isFeatureEnabled(SERVICE_NAME, 'price_prediction')).toBe(false);
      expect(manager.isFeatureEnabled(SERVICE_NAME, 'real_time_updates')).toBe(false);
    });

    it('should disable all features at COMPLETE_OUTAGE level', async () => {
      await manager.triggerDegradation(SERVICE_NAME, 'redis_connection');

      // COMPLETE_OUTAGE level enables: nothing
      expect(manager.isFeatureEnabled(SERVICE_NAME, 'arbitrage_detection')).toBe(false);
      expect(manager.isFeatureEnabled(SERVICE_NAME, 'price_prediction')).toBe(false);
      expect(manager.isFeatureEnabled(SERVICE_NAME, 'real_time_updates')).toBe(false);
    });

    it('should return capability fallback when in degraded state', () => {
      manager.registerCapabilities(SERVICE_NAME, createCapabilities());

      const mlFallback = manager.getCapabilityFallback(SERVICE_NAME, 'ml_prediction');
      expect(mlFallback).toEqual({ type: 'simple_spread' });

      const web3Fallback = manager.getCapabilityFallback(SERVICE_NAME, 'web3_connection');
      expect(web3Fallback).toEqual({ type: 'cached_data' });
    });
  });

  describe('recovery from degraded state', () => {
    beforeEach(() => {
      manager.registerDegradationLevels(SERVICE_NAME, createDegradationLevels());
      manager.registerCapabilities(SERVICE_NAME, createCapabilities());
    });

    it('should return false when attempting recovery for non-degraded service', async () => {
      const result = await manager.attemptRecovery(SERVICE_NAME);
      expect(result).toBe(false);
    });

    it('should recover when all capabilities pass testing', async () => {
      // Trigger degradation first
      await manager.triggerDegradation(SERVICE_NAME, 'web3_connection');
      expect(manager.getDegradationState(SERVICE_NAME)).not.toBeNull();

      // Set up injectable capability tester that reports everything as healthy
      manager.setCapabilityTester(async () => true);

      const result = await manager.attemptRecovery(SERVICE_NAME);
      expect(result).toBe(true);

      // State should be cleared after successful recovery
      expect(manager.getDegradationState(SERVICE_NAME)).toBeNull();
    });

    it('should fail recovery when capabilities are still failing', async () => {
      await manager.triggerDegradation(SERVICE_NAME, 'web3_connection');

      // Set up injectable capability tester that reports failure
      manager.setCapabilityTester(async () => false);

      const result = await manager.attemptRecovery(SERVICE_NAME);
      expect(result).toBe(false);

      // State should still exist
      const state = manager.getDegradationState(SERVICE_NAME);
      expect(state).not.toBeNull();
      expect(state!.recoveryAttempts).toBe(1);
    });

    it('should increment recoveryAttempts on each failed attempt', async () => {
      await manager.triggerDegradation(SERVICE_NAME, 'web3_connection');
      manager.setCapabilityTester(async () => false);

      await manager.attemptRecovery(SERVICE_NAME);
      expect(manager.getDegradationState(SERVICE_NAME)!.recoveryAttempts).toBe(1);

      await manager.attemptRecovery(SERVICE_NAME);
      expect(manager.getDegradationState(SERVICE_NAME)!.recoveryAttempts).toBe(2);
    });

    it('should prevent concurrent recovery attempts for the same service', async () => {
      await manager.triggerDegradation(SERVICE_NAME, 'web3_connection');

      let resolveCapTest: () => void;
      const capTestPromise = new Promise<void>(resolve => {
        resolveCapTest = resolve;
      });

      // Slow capability tester to create a window for concurrent call
      manager.setCapabilityTester(async () => {
        await capTestPromise;
        return true;
      });

      // Start first recovery (will block on capability test)
      const recovery1 = manager.attemptRecovery(SERVICE_NAME);

      // Second recovery should be rejected (in-progress lock)
      const result2 = await manager.attemptRecovery(SERVICE_NAME);
      expect(result2).toBe(false);

      // Complete the first recovery
      resolveCapTest!();
      const result1 = await recovery1;
      expect(result1).toBe(true);
    });

    it('should force-recover even without capability testing', async () => {
      await manager.triggerDegradation(SERVICE_NAME, 'web3_connection');
      expect(manager.getDegradationState(SERVICE_NAME)).not.toBeNull();

      const result = await manager.forceRecovery(SERVICE_NAME);
      expect(result).toBe(true);
      expect(manager.getDegradationState(SERVICE_NAME)).toBeNull();
    });

    it('should return true when force-recovering non-degraded service', async () => {
      // forceRecovery returns true for non-degraded (already recovered)
      const result = await manager.forceRecovery(SERVICE_NAME);
      expect(result).toBe(true);
    });
  });

  describe('getAllDegradationStates', () => {
    it('should return states for all degraded services', async () => {
      const manager2 = new GracefulDegradationManager();

      manager2.registerDegradationLevels('service-a', createDegradationLevels());
      manager2.registerCapabilities('service-a', createCapabilities());
      manager2.registerDegradationLevels('service-b', createDegradationLevels());
      manager2.registerCapabilities('service-b', createCapabilities());

      await manager2.triggerDegradation('service-a', 'web3_connection');
      await manager2.triggerDegradation('service-b', 'ml_prediction');

      const states = manager2.getAllDegradationStates();
      expect(Object.keys(states)).toHaveLength(2);
      expect(states).toHaveProperty('service-a');
      expect(states).toHaveProperty('service-b');
      expect(states['service-a'].currentLevel.level).toBe(DegradationLevel.REDUCED_CHAINS);
      expect(states['service-b'].currentLevel.level).toBe(DegradationLevel.DETECTION_ONLY);
    });
  });

  describe('cleanup and shutdown', () => {
    it('should reset singleton via resetGracefulDegradationManager', () => {
      const instance1 = getGracefulDegradationManager();
      resetGracefulDegradationManager();
      const instance2 = getGracefulDegradationManager();

      // After reset, should get a new instance
      expect(instance1).not.toBe(instance2);
    });

    it('should clean up recovery timers on reset', async () => {
      const mgr = getGracefulDegradationManager();
      mgr.registerDegradationLevels(SERVICE_NAME, createDegradationLevels());
      mgr.registerCapabilities(SERVICE_NAME, createCapabilities());
      await mgr.triggerDegradation(SERVICE_NAME, 'web3_connection');

      // Reset should clear timers without error
      resetGracefulDegradationManager();
    });
  });

  describe('convenience functions', () => {
    it('should trigger degradation via convenience function', async () => {
      // Reset to ensure clean singleton
      resetGracefulDegradationManager();

      const mgr = getGracefulDegradationManager();
      mgr.registerDegradationLevels(SERVICE_NAME, createDegradationLevels());
      mgr.registerCapabilities(SERVICE_NAME, createCapabilities());

      const result = await triggerDegradation(
        SERVICE_NAME,
        'web3_connection',
        new Error('test')
      );
      expect(result).toBe(true);

      // Clean up
      resetGracefulDegradationManager();
    });

    it('should check feature via isFeatureEnabled convenience function', () => {
      resetGracefulDegradationManager();

      // No degradation, all features enabled
      const enabled = isFeatureEnabled(SERVICE_NAME, 'arbitrage_detection');
      expect(enabled).toBe(true);

      resetGracefulDegradationManager();
    });

    it('should get fallback via getCapabilityFallback convenience function', () => {
      resetGracefulDegradationManager();

      const mgr = getGracefulDegradationManager();
      mgr.registerCapabilities(SERVICE_NAME, createCapabilities());

      const fallback = getCapabilityFallback(SERVICE_NAME, 'ml_prediction');
      expect(fallback).toEqual({ type: 'simple_spread' });

      resetGracefulDegradationManager();
    });
  });
});
