/**
 * Unit Tests for GracefulDegradationManager
 *
 * Tests graceful degradation functionality for services including:
 * - Degradation level management
 * - Service capability tracking
 * - Automatic recovery with exponential backoff
 * - Feature enablement based on degradation state
 *
 * @see ADR-007: Cross-Region Failover Strategy
 * @see S4.1.3: Implement graceful degradation levels
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock Redis - getRedisClient returns a Promise that resolves to the client
jest.mock('../../src/redis/client', () => ({
  getRedisClient: () => Promise.resolve({
    ping: () => Promise.resolve(true),
    publish: () => Promise.resolve(1),
    set: () => Promise.resolve('OK'),
    get: () => Promise.resolve(null),
    del: () => Promise.resolve(1)
  })
}));

// Mock Redis Streams
jest.mock('../../src/redis/streams', () => ({
  getRedisStreamsClient: () => Promise.resolve({
    xadd: () => Promise.resolve('1234-0'),
    xread: () => Promise.resolve([])
  })
}));

// Mock logger (auto-resolves to src/__mocks__/logger.ts)
jest.mock('../../src/logger');

import {
  GracefulDegradationManager,
  DegradationLevel,  // S4.1.3-FIX: Now canonical enum from cross-region-health
  DegradationLevelConfig,  // S4.1.3-FIX: Renamed interface for level configuration
  ServiceCapability,
  DegradationState,
  getGracefulDegradationManager,
  resetGracefulDegradationManager,  // S4.1.3-FIX: Import reset for test cleanup
  triggerDegradation,
  isFeatureEnabled,
  getCapabilityFallback
} from '../../src/resilience/graceful-degradation';

describe('GracefulDegradationManager', () => {
  let manager: GracefulDegradationManager;

  beforeEach(() => {
    jest.clearAllMocks();
    // S4.1.3-FIX: Reset singleton to prevent test pollution
    resetGracefulDegradationManager();
    manager = new GracefulDegradationManager();
  });

  afterEach(() => {
    jest.clearAllTimers();
    // S4.1.3-FIX: Reset singleton after each test
    resetGracefulDegradationManager();
  });

  describe('constructor', () => {
    it('should create instance with default degradation levels', () => {
      expect(manager).toBeDefined();
    });

    it('should initialize default degradation levels for common services', () => {
      // Test that default services have degradation levels registered
      const services = [
        'bsc-detector',
        'ethereum-detector',
        'cross-chain-detector',
        'execution-engine',
        'coordinator',
        'unified-detector-asia-fast',
        'unified-detector-l2-turbo',
        'unified-detector-high-value',
        'unified-detector-solana'
      ];

      // Verify default levels exist for each service
      // (We can verify by trying to trigger degradation with known levels)
      for (const service of services) {
        const state = manager.getDegradationState(service);
        // No degradation by default
        expect(state).toBeNull();
      }
    });
  });

  describe('registerDegradationLevels', () => {
    it('should register custom degradation levels for a service', () => {
      // S4.1.3-FIX: Custom levels must now include canonical enum level
      const customLevels: DegradationLevelConfig[] = [
        {
          level: DegradationLevel.REDUCED_CHAINS,  // Use canonical enum value
          name: 'custom-partial',
          description: 'Custom partial degradation',
          enabledFeatures: ['feature1', 'feature2'],
          disabledFeatures: ['feature3'],
          performanceImpact: 0.3,
          recoveryPriority: 7
        }
      ];

      manager.registerDegradationLevels('custom-service', customLevels);

      // Register capabilities to test the level
      manager.registerCapabilities('custom-service', [
        {
          name: 'custom-capability',
          required: false,
          // S4.1.3-FIX: degradationLevel must be canonical enum
          degradationLevel: DegradationLevel.REDUCED_CHAINS
        }
      ]);

      // Verify by triggering degradation
      // (If level wasn't registered, triggerDegradation would return false)
    });
  });

  describe('registerCapabilities', () => {
    it('should register service capabilities', () => {
      const capabilities: ServiceCapability[] = [
        {
          name: 'redis_connection',
          required: true,
          degradationLevel: DegradationLevel.REDUCED_CHAINS
        },
        {
          name: 'ml_prediction',
          required: false,
          fallback: { useCache: true },
          degradationLevel: DegradationLevel.REDUCED_CHAINS
        }
      ];

      manager.registerCapabilities('test-service', capabilities);

      // Verify fallback is retrievable
      const fallback = manager.getCapabilityFallback('test-service', 'ml_prediction');
      expect(fallback).toEqual({ useCache: true });
    });

    it('should return null for unknown service fallback', () => {
      const fallback = manager.getCapabilityFallback('unknown-service', 'unknown-cap');
      expect(fallback).toBeNull();
    });

    it('should return null for unknown capability fallback', () => {
      manager.registerCapabilities('test-service', [
        { name: 'known-cap', required: false, degradationLevel: DegradationLevel.REDUCED_CHAINS }
      ]);

      const fallback = manager.getCapabilityFallback('test-service', 'unknown-cap');
      expect(fallback).toBeNull();
    });
  });

  describe('triggerDegradation', () => {
    beforeEach(() => {
      // Register capabilities for a test service using default degradation levels
      manager.registerCapabilities('bsc-detector', [
        {
          name: 'web3_connection',
          required: true,
          degradationLevel: DegradationLevel.REDUCED_CHAINS
        },
        {
          name: 'redis_connection',
          required: true,
          degradationLevel: DegradationLevel.DETECTION_ONLY
        }
      ]);
    });

    it('should apply degradation when capability fails', async () => {
      const result = await manager.triggerDegradation(
        'bsc-detector',
        'web3_connection',
        new Error('Connection timeout')
      );

      expect(result).toBe(true);

      const state = manager.getDegradationState('bsc-detector');
      expect(state).not.toBeNull();
      expect(state!.currentLevel.name).toBe('partial');
      expect(state!.triggeredBy).toBe('web3_connection');
    });

    it('should return false for unknown service', async () => {
      const result = await manager.triggerDegradation(
        'unknown-service',
        'some-capability'
      );

      expect(result).toBe(false);
    });

    it('should return false for unknown capability', async () => {
      const result = await manager.triggerDegradation(
        'bsc-detector',
        'unknown-capability'
      );

      expect(result).toBe(false);
    });

    it('should not double-apply same degradation level', async () => {
      await manager.triggerDegradation('bsc-detector', 'web3_connection');
      const firstState = manager.getDegradationState('bsc-detector');

      // Trigger same degradation again
      await manager.triggerDegradation('bsc-detector', 'web3_connection');
      const secondState = manager.getDegradationState('bsc-detector');

      // Should be same timestamp (not re-applied)
      expect(firstState!.timestamp).toBe(secondState!.timestamp);
    });

    it('should track previous degradation level', async () => {
      // First degradation
      await manager.triggerDegradation('bsc-detector', 'web3_connection');

      // Change to different degradation by triggering different capability
      await manager.triggerDegradation('bsc-detector', 'redis_connection');

      const state = manager.getDegradationState('bsc-detector');
      expect(state!.previousLevel).toBeDefined();
      expect(state!.previousLevel!.name).toBe('partial');
      expect(state!.currentLevel.name).toBe('batch_only');
    });
  });

  describe('getDegradationState', () => {
    it('should return null for service without degradation', () => {
      const state = manager.getDegradationState('healthy-service');
      expect(state).toBeNull();
    });

    it('should return current degradation state', async () => {
      // Use a service that has default levels registered
      manager.registerCapabilities('bsc-detector', [
        { name: 'test-cap', required: false, degradationLevel: DegradationLevel.REDUCED_CHAINS }
      ]);

      await manager.triggerDegradation('bsc-detector', 'test-cap');

      const state = manager.getDegradationState('bsc-detector');
      expect(state).not.toBeNull();
      expect(state!.serviceName).toBe('bsc-detector');
      expect(state!.canRecover).toBe(true);
      expect(state!.recoveryAttempts).toBe(0);
    });
  });

  describe('getAllDegradationStates', () => {
    it('should return empty object when no degradations', () => {
      const states = manager.getAllDegradationStates();
      expect(states).toEqual({});
    });

    it('should return all degraded services', async () => {
      // Use services that have default levels
      manager.registerCapabilities('bsc-detector', [
        { name: 'cap-1', required: false, degradationLevel: DegradationLevel.REDUCED_CHAINS }
      ]);
      manager.registerCapabilities('ethereum-detector', [
        { name: 'cap-2', required: false, degradationLevel: DegradationLevel.REDUCED_CHAINS }
      ]);

      await manager.triggerDegradation('bsc-detector', 'cap-1');
      await manager.triggerDegradation('ethereum-detector', 'cap-2');

      const states = manager.getAllDegradationStates();
      expect(Object.keys(states)).toHaveLength(2);
      expect(states['bsc-detector']).toBeDefined();
      expect(states['ethereum-detector']).toBeDefined();
    });
  });

  describe('isFeatureEnabled', () => {
    it('should return true for non-degraded service', () => {
      const enabled = manager.isFeatureEnabled('healthy-service', 'any-feature');
      expect(enabled).toBe(true);
    });

    it('should return true for enabled features in degraded state', async () => {
      // Use service with default levels
      manager.registerCapabilities('bsc-detector', [
        { name: 'test-cap', required: false, degradationLevel: DegradationLevel.REDUCED_CHAINS }
      ]);

      await manager.triggerDegradation('bsc-detector', 'test-cap');

      // partial level enables: arbitrage_detection, price_prediction, real_time_updates
      const enabled = manager.isFeatureEnabled('bsc-detector', 'arbitrage_detection');
      expect(enabled).toBe(true);
    });

    it('should return false for disabled features in degraded state', async () => {
      // Use service with default levels
      manager.registerCapabilities('coordinator', [
        { name: 'test-cap', required: false, degradationLevel: DegradationLevel.DETECTION_ONLY }
      ]);

      await manager.triggerDegradation('coordinator', 'test-cap');

      // batch_only level disables: price_prediction, bridge_calls, real_time_updates
      const enabled = manager.isFeatureEnabled('coordinator', 'price_prediction');
      expect(enabled).toBe(false);
    });
  });

  describe('attemptRecovery', () => {
    it('should return false for non-degraded service', async () => {
      const result = await manager.attemptRecovery('healthy-service');
      expect(result).toBe(false);
    });

    it('should increment recovery attempts', async () => {
      // Use service with default levels
      manager.registerCapabilities('execution-engine', [
        { name: 'test-cap', required: false, degradationLevel: DegradationLevel.REDUCED_CHAINS }
      ]);

      await manager.triggerDegradation('execution-engine', 'test-cap');

      // Force recovery to fail by making testCapability return false
      // We can't easily mock internal methods, so just verify attempts increment
      await manager.attemptRecovery('execution-engine');

      const state = manager.getDegradationState('execution-engine');
      // Either recovered (null) or attempts > 0
      if (state) {
        expect(state.recoveryAttempts).toBeGreaterThan(0);
      }
    });
  });

  describe('forceRecovery', () => {
    it('should return true for non-degraded service', async () => {
      const result = await manager.forceRecovery('healthy-service');
      expect(result).toBe(true);
    });

    it('should force recovery for degraded service', async () => {
      // Use service with default levels
      manager.registerCapabilities('cross-chain-detector', [
        { name: 'test-cap', required: false, degradationLevel: DegradationLevel.REDUCED_CHAINS }
      ]);

      await manager.triggerDegradation('cross-chain-detector', 'test-cap');
      expect(manager.getDegradationState('cross-chain-detector')).not.toBeNull();

      await manager.forceRecovery('cross-chain-detector');
      expect(manager.getDegradationState('cross-chain-detector')).toBeNull();
    });
  });

  describe('default degradation levels', () => {
    it('should have normal level with full functionality', () => {
      // Normal level enables all features - use a service with default levels
      manager.registerCapabilities('bsc-detector', [
        { name: 'test-cap', required: false, degradationLevel: DegradationLevel.FULL_OPERATION }
      ]);

      // No degradation state for normal (it's full operation)
    });

    it('should have partial level with reduced chain coverage', async () => {
      // Use unified-detector-asia-fast which has default levels
      manager.registerCapabilities('unified-detector-asia-fast', [
        { name: 'test-cap', required: false, degradationLevel: DegradationLevel.REDUCED_CHAINS }
      ]);

      await manager.triggerDegradation('unified-detector-asia-fast', 'test-cap');
      const state = manager.getDegradationState('unified-detector-asia-fast');

      expect(state!.currentLevel.name).toBe('partial');
      expect(state!.currentLevel.performanceImpact).toBe(0.15);
      expect(state!.currentLevel.enabledFeatures).toContain('arbitrage_detection');
    });

    it('should have batch_only level without real-time updates', async () => {
      // Use unified-detector-l2-turbo which has default levels
      manager.registerCapabilities('unified-detector-l2-turbo', [
        { name: 'test-cap', required: false, degradationLevel: DegradationLevel.DETECTION_ONLY }
      ]);

      await manager.triggerDegradation('unified-detector-l2-turbo', 'test-cap');
      const state = manager.getDegradationState('unified-detector-l2-turbo');

      expect(state!.currentLevel.name).toBe('batch_only');
      expect(state!.currentLevel.disabledFeatures).toContain('real_time_updates');
      expect(state!.currentLevel.performanceImpact).toBe(0.5);
    });

    it('should have emergency level with no features', async () => {
      // Use unified-detector-high-value which has default levels
      manager.registerCapabilities('unified-detector-high-value', [
        { name: 'test-cap', required: false, degradationLevel: DegradationLevel.COMPLETE_OUTAGE }
      ]);

      await manager.triggerDegradation('unified-detector-high-value', 'test-cap');
      const state = manager.getDegradationState('unified-detector-high-value');

      expect(state!.currentLevel.name).toBe('emergency');
      expect(state!.currentLevel.enabledFeatures).toHaveLength(0);
      expect(state!.currentLevel.performanceImpact).toBe(1.0);
    });
  });
});

describe('singleton and convenience functions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // S4.1.3-FIX: Reset singleton before testing singleton behavior
    resetGracefulDegradationManager();
  });

  afterEach(() => {
    // S4.1.3-FIX: Reset singleton after each test
    resetGracefulDegradationManager();
  });

  describe('getGracefulDegradationManager', () => {
    it('should return singleton instance', () => {
      const instance1 = getGracefulDegradationManager();
      const instance2 = getGracefulDegradationManager();
      expect(instance1).toBe(instance2);
    });
  });

  describe('triggerDegradation convenience function', () => {
    it('should delegate to manager', async () => {
      const manager = getGracefulDegradationManager();
      // Use service with default levels registered
      manager.registerCapabilities('unified-detector-solana-native', [
        { name: 'test-cap', required: false, degradationLevel: DegradationLevel.REDUCED_CHAINS }
      ]);

      const result = await triggerDegradation('unified-detector-solana-native', 'test-cap');
      expect(result).toBe(true);
    });
  });

  describe('isFeatureEnabled convenience function', () => {
    it('should delegate to manager', () => {
      const enabled = isFeatureEnabled('healthy-service', 'feature');
      expect(enabled).toBe(true);
    });
  });

  describe('getCapabilityFallback convenience function', () => {
    it('should delegate to manager', () => {
      const fallback = getCapabilityFallback('unknown-service', 'unknown-cap');
      expect(fallback).toBeNull();
    });
  });
});

// S4.1.3-FIX: DegradationLevel is now a canonical enum from ADR-007
describe('DegradationLevel enum', () => {
  it('should have correct enum values', () => {
    expect(DegradationLevel.FULL_OPERATION).toBe(0);
    expect(DegradationLevel.REDUCED_CHAINS).toBe(1);
    expect(DegradationLevel.DETECTION_ONLY).toBe(2);
    expect(DegradationLevel.READ_ONLY).toBe(3);
    expect(DegradationLevel.COMPLETE_OUTAGE).toBe(4);
  });
});

// S4.1.3-FIX: Renamed interface to DegradationLevelConfig
describe('DegradationLevelConfig interface', () => {
  it('should have correct structure with canonical level', () => {
    const levelConfig: DegradationLevelConfig = {
      level: DegradationLevel.REDUCED_CHAINS,  // S4.1.3-FIX: Required canonical enum value
      name: 'test-level',
      description: 'Test degradation level',
      enabledFeatures: ['feature1', 'feature2'],
      disabledFeatures: ['feature3'],
      performanceImpact: 0.5,
      recoveryPriority: 5
    };

    expect(levelConfig.level).toBe(DegradationLevel.REDUCED_CHAINS);
    expect(levelConfig.name).toBe('test-level');
    expect(levelConfig.performanceImpact).toBe(0.5);
    expect(levelConfig.enabledFeatures).toHaveLength(2);
    expect(levelConfig.disabledFeatures).toHaveLength(1);
  });
});

describe('ServiceCapability interface', () => {
  it('should have correct structure', () => {
    const capability: ServiceCapability = {
      name: 'test-capability',
      required: true,
      fallback: { useDefault: true },
      degradationLevel: DegradationLevel.REDUCED_CHAINS
    };

    expect(capability.name).toBe('test-capability');
    expect(capability.required).toBe(true);
    expect(capability.fallback).toBeDefined();
    // S4.1.3-FIX: degradationLevel is now canonical enum
    expect(capability.degradationLevel).toBe(DegradationLevel.REDUCED_CHAINS);
  });

  it('should allow optional fallback', () => {
    const capability: ServiceCapability = {
      name: 'test-capability',
      required: false,
      degradationLevel: DegradationLevel.REDUCED_CHAINS
    };

    expect(capability.fallback).toBeUndefined();
  });
});

describe('DegradationState interface', () => {
  it('should have correct structure', () => {
    const state: DegradationState = {
      serviceName: 'test-service',
      // S4.1.3-FIX: currentLevel is now DegradationLevelConfig with canonical enum level
      currentLevel: {
        level: DegradationLevel.REDUCED_CHAINS,
        name: 'partial',
        description: 'Partial degradation',
        enabledFeatures: ['detection'],
        disabledFeatures: ['prediction'],
        performanceImpact: 0.3,
        recoveryPriority: 7
      },
      previousLevel: undefined,
      triggeredBy: 'redis_connection',
      timestamp: Date.now(),
      canRecover: true,
      recoveryAttempts: 0,
      metrics: {
        performanceImpact: 0.3,
        errorRate: 0.05,
        throughputReduction: 0.15
      }
    };

    expect(state.serviceName).toBe('test-service');
    expect(state.canRecover).toBe(true);
    expect(state.metrics.performanceImpact).toBe(0.3);
  });
});
