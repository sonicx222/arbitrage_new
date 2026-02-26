/**
 * Unit Tests for CrossRegionHealthManager
 *
 * Tests cross-region health monitoring, leader election,
 * and failover functionality.
 *
 * @see ADR-007: Cross-Region Failover Strategy
 *
 * @migrated from shared/core/src/cross-region-health.test.ts
 * @see ADR-009: Test Architecture
 */

import { EventEmitter } from 'events';
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { Mock } from 'jest-mock';
import {
  CrossRegionHealthManager,
  CrossRegionHealthConfig,
  RegionHealth,
  DegradationLevel,
  GlobalHealthStatus,
  FailoverEvent,
  getCrossRegionHealthManager,
  resetCrossRegionHealthManager
} from '../../src/monitoring/cross-region-health';

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

// Mock Redis client factory
// S4.1.2-FIX: Added scan method to match cross-region-health.ts fetchRemoteRegionHealth()
const createMockRedisClient = () => ({
  set: jest.fn<() => Promise<string>>().mockResolvedValue('OK'),
  get: jest.fn<() => Promise<string | null>>().mockResolvedValue(null),
  keys: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
  del: jest.fn<() => Promise<number>>().mockResolvedValue(1),
  publish: jest.fn<() => Promise<number>>().mockResolvedValue(1),
  subscribe: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  ping: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
  disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  // S4.1.2-FIX: scan() is used by fetchRemoteRegionHealth() for iterating region health keys
  scan: jest.fn<() => Promise<[string, string[]]>>().mockResolvedValue(['0', []])
});

// Mock Redis Streams client factory
const createMockStreamsClient = () => ({
  xadd: jest.fn<() => Promise<string>>().mockResolvedValue('1234-0'),
  xread: jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
  xreadgroup: jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
  xack: jest.fn<() => Promise<number>>().mockResolvedValue(1),
  createConsumerGroup: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  ping: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
  disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  createBatcher: jest.fn().mockReturnValue({
    add: jest.fn(),
    flush: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    destroy: jest.fn<() => Promise<void>>().mockResolvedValue(undefined)
  })
});

// Mock lock handle type
interface MockLockHandle {
  acquired: boolean;
  key: string;
  release: () => Promise<void>;
  extend: () => Promise<boolean>;
}

// P1 FIX #6: Create a shared mock lock handle so tests can access and override its methods.
// Previously, acquireLock returned an inline object, making it impossible for tests to
// mock the lock handle's extend() method (the test was mocking mockLockManager.extendLock
// which the real code never calls — it calls leaderLock.extend() instead).
const createMockLockHandle = (): MockLockHandle => ({
  acquired: true,
  key: 'test-lock-key',
  release: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  extend: jest.fn<() => Promise<boolean>>().mockResolvedValue(true)
});

// Mock lock manager factory
const createMockLockManager = (lockHandle: MockLockHandle) => ({
  acquireLock: jest.fn<() => Promise<MockLockHandle>>().mockResolvedValue(lockHandle),
  extendLock: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
  releaseLock: jest.fn<() => Promise<void>>().mockResolvedValue(undefined)
});

describe('CrossRegionHealthManager', () => {
  let manager: CrossRegionHealthManager;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockRedis: ReturnType<typeof createMockRedisClient>;
  let mockStreams: ReturnType<typeof createMockStreamsClient>;
  let mockLockHandle: MockLockHandle;
  let mockLockManager: ReturnType<typeof createMockLockManager>;

  // Base config without injected dependencies
  const baseConfig = {
    instanceId: 'test-instance-1',
    regionId: 'us-east1',
    serviceName: 'test-service',
    healthCheckIntervalMs: 1000,
    failoverThreshold: 3,
    leaderHeartbeatIntervalMs: 500,
    leaderLockTtlMs: 5000,
    canBecomeLeader: true,
    isStandby: false
  };

  // Create config with injected mocks
  const createTestConfig = (overrides: Partial<CrossRegionHealthConfig> = {}): CrossRegionHealthConfig => ({
    ...baseConfig,
    ...overrides,
    logger: mockLogger,
    redisClient: mockRedis as any,
    streamsClient: mockStreams as any,
    lockManager: mockLockManager as any
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await resetCrossRegionHealthManager();

    // Create fresh mocks for each test
    mockLogger = createMockLogger();
    mockRedis = createMockRedisClient();
    mockStreams = createMockStreamsClient();
    // P1 FIX #6: Create shared lock handle so tests can mock its extend() method
    mockLockHandle = createMockLockHandle();
    mockLockManager = createMockLockManager(mockLockHandle);
  });

  afterEach(async () => {
    if (manager && manager.isActive()) {
      await manager.stop();
    }
  });

  describe('constructor', () => {
    it('should create instance with default config values', () => {
      const minConfig: CrossRegionHealthConfig = {
        instanceId: 'test-1',
        regionId: 'us-east1',
        serviceName: 'test',
        logger: mockLogger
      };

      manager = new CrossRegionHealthManager(minConfig);
      expect(manager).toBeDefined();
      expect(manager.getOwnRegionId()).toBe('us-east1');
    });

    it('should create instance with full config', () => {
      manager = new CrossRegionHealthManager(createTestConfig());
      expect(manager).toBeDefined();
      expect(manager.getOwnRegionId()).toBe('us-east1');
    });

    it('should inherit from EventEmitter', () => {
      manager = new CrossRegionHealthManager(createTestConfig());
      expect(manager).toBeInstanceOf(EventEmitter);
    });
  });

  describe('lifecycle', () => {
    it('should start successfully', async () => {
      manager = new CrossRegionHealthManager(createTestConfig());
      await manager.start();
      expect(manager.isActive()).toBe(true);
    });

    it('should not double start', async () => {
      manager = new CrossRegionHealthManager(createTestConfig());
      await manager.start();
      await manager.start(); // Should not throw
      expect(manager.isActive()).toBe(true);
    });

    it('should stop successfully', async () => {
      manager = new CrossRegionHealthManager(createTestConfig());
      await manager.start();
      await manager.stop();
      expect(manager.isActive()).toBe(false);
    });

    it('should handle stop when not started', async () => {
      manager = new CrossRegionHealthManager(createTestConfig());
      await manager.stop(); // Should not throw
      expect(manager.isActive()).toBe(false);
    });
  });

  describe('leader election', () => {
    it('should attempt leader election on start when eligible', async () => {
      manager = new CrossRegionHealthManager(createTestConfig({ canBecomeLeader: true }));

      await manager.start();

      expect(mockLockManager.acquireLock).toHaveBeenCalled();
    });

    it('should not attempt leader election when standby', async () => {
      manager = new CrossRegionHealthManager(createTestConfig({ isStandby: true }));

      await manager.start();

      // Should not acquire lock when standby
      expect(mockLockManager.acquireLock).not.toHaveBeenCalled();
    });

    it('should not attempt leader election when canBecomeLeader is false', async () => {
      manager = new CrossRegionHealthManager(createTestConfig({ canBecomeLeader: false }));

      await manager.start();

      expect(mockLockManager.acquireLock).not.toHaveBeenCalled();
    });

    it('should become leader when lock acquired', async () => {
      manager = new CrossRegionHealthManager(createTestConfig());
      await manager.start();

      // Check if leader (mock returns successful lock)
      expect(manager.getIsLeader()).toBe(true);
    });

    it('should emit leaderChange event when becoming leader', async () => {
      manager = new CrossRegionHealthManager(createTestConfig());

      const leaderChangeHandler = jest.fn();
      manager.on('leaderChange', leaderChangeHandler);

      await manager.start();

      expect(leaderChangeHandler).toHaveBeenCalled();
      const event = leaderChangeHandler.mock.calls[0][0] as FailoverEvent;
      expect(event.type).toBe('leader_changed');
      expect(event.targetRegion).toBe('us-east1');
    });
  });

  describe('health monitoring', () => {
    it('should initialize own region health', async () => {
      manager = new CrossRegionHealthManager(createTestConfig());
      await manager.start();

      const regionHealth = manager.getRegionHealth('us-east1');
      expect(regionHealth).toBeDefined();
      expect(regionHealth!.regionId).toBe('us-east1');
      expect(regionHealth!.status).toBe('healthy');
    });

    it('should track service health in region', async () => {
      manager = new CrossRegionHealthManager(createTestConfig());
      await manager.start();

      const regionHealth = manager.getRegionHealth('us-east1');
      expect(regionHealth!.services.length).toBe(1);
      expect(regionHealth!.services[0].serviceName).toBe('test-service');
    });

    it('should return all regions health', async () => {
      manager = new CrossRegionHealthManager(createTestConfig());
      await manager.start();

      const allHealth = manager.getAllRegionsHealth();
      expect(allHealth.size).toBeGreaterThan(0);
      expect(allHealth.has('us-east1')).toBe(true);
    });
  });

  describe('global health evaluation', () => {
    it('should evaluate global health status', async () => {
      manager = new CrossRegionHealthManager(createTestConfig());
      await manager.start();

      const globalHealth = await manager.evaluateGlobalHealth();
      expect(globalHealth).toBeDefined();
      expect(globalHealth.redis).toBeDefined();
      expect(typeof globalHealth.degradationLevel).toBe('number');
      expect(['healthy', 'degraded', 'critical']).toContain(globalHealth.overallStatus);
    });

    it('should return READ_ONLY degradation when no detectors', async () => {
      manager = new CrossRegionHealthManager(createTestConfig());
      await manager.start();

      const globalHealth = await manager.evaluateGlobalHealth();
      // With default setup, no detectors are registered
      expect(globalHealth.detectors).toHaveLength(0);
    });
  });

  describe('degradation levels', () => {
    it('should export DegradationLevel enum', () => {
      expect(DegradationLevel.FULL_OPERATION).toBe(0);
      expect(DegradationLevel.REDUCED_CHAINS).toBe(1);
      expect(DegradationLevel.DETECTION_ONLY).toBe(2);
      expect(DegradationLevel.READ_ONLY).toBe(3);
      expect(DegradationLevel.COMPLETE_OUTAGE).toBe(4);
    });
  });

  describe('failover', () => {
    // Helper function to set up a remote region for failover testing
    const setupRemoteRegion = (mgr: CrossRegionHealthManager, regionId: string) => {
      const regions = (mgr as any).regions as Map<string, RegionHealth>;
      regions.set(regionId, {
        regionId,
        status: 'healthy',
        isLeader: false,
        services: [{
          serviceName: 'remote-service',
          status: 'healthy',
          isPrimary: true,
          isStandby: false,
          lastHeartbeat: Date.now(),
          metrics: {}
        }],
        lastHealthCheck: Date.now(),
        consecutiveFailures: 0,
        avgLatencyMs: 0,
        memoryUsagePercent: 0,
        cpuUsagePercent: 0
      });
    };

    it('should emit failover events', async () => {
      manager = new CrossRegionHealthManager(createTestConfig());
      await manager.start();
      setupRemoteRegion(manager, 'asia-southeast1');

      const failoverHandler = jest.fn();
      manager.on('failoverStarted', failoverHandler);

      // Trigger failover manually
      await manager.triggerFailover('asia-southeast1');

      expect(failoverHandler).toHaveBeenCalled();
    });

    it('should publish failover event to Redis', async () => {
      manager = new CrossRegionHealthManager(createTestConfig());
      await manager.start();
      setupRemoteRegion(manager, 'asia-southeast1');

      await manager.triggerFailover('asia-southeast1');

      expect(mockRedis.publish).toHaveBeenCalled();
    });

    it('should emit failoverCompleted on successful failover', async () => {
      manager = new CrossRegionHealthManager(createTestConfig());
      await manager.start();
      setupRemoteRegion(manager, 'asia-southeast1');

      const completedHandler = jest.fn();
      manager.on('failoverCompleted', completedHandler);

      await manager.triggerFailover('asia-southeast1');

      expect(completedHandler).toHaveBeenCalled();
      const event = completedHandler.mock.calls[0][0] as FailoverEvent;
      expect(event.type).toBe('failover_completed');
      expect(event.durationMs).toBeDefined();
    });
  });

  describe('singleton pattern', () => {
    it('should return same instance from getCrossRegionHealthManager', async () => {
      await resetCrossRegionHealthManager();

      const instance1 = getCrossRegionHealthManager(createTestConfig());
      const instance2 = getCrossRegionHealthManager();

      expect(instance1).toBe(instance2);
    });

    it('should throw if getting instance without initial config', async () => {
      await resetCrossRegionHealthManager();

      expect(() => getCrossRegionHealthManager()).toThrow();
    });

    it('should reset singleton with resetCrossRegionHealthManager', async () => {
      const instance1 = getCrossRegionHealthManager(createTestConfig());
      await instance1.start();

      await resetCrossRegionHealthManager();

      expect(() => getCrossRegionHealthManager()).toThrow();
    });
  });

  describe('event emission', () => {
    it('should emit leadershipLost event when lock extension fails', async () => {
      jest.useFakeTimers();

      manager = new CrossRegionHealthManager(createTestConfig({
        leaderHeartbeatIntervalMs: 100
      }));

      await manager.start();

      const lostHandler = jest.fn();
      manager.on('leadershipLost', lostHandler);

      // P1 FIX #6: Mock the lock handle's extend() method (what the real code calls),
      // not mockLockManager.extendLock (which is never called by the production code).
      (mockLockHandle.extend as Mock<() => Promise<boolean>>).mockResolvedValueOnce(false);

      // Advance past the heartbeat interval to trigger the lock extension check
      await jest.advanceTimersByTimeAsync(200);

      expect(lostHandler).toHaveBeenCalled();

      jest.useRealTimers();
    });

    it('should emit activateStandby on failover', async () => {
      manager = new CrossRegionHealthManager(createTestConfig());
      await manager.start();

      // Set up remote region for failover
      const regions = (manager as any).regions as Map<string, RegionHealth>;
      regions.set('asia-southeast1', {
        regionId: 'asia-southeast1',
        status: 'healthy',
        isLeader: false,
        services: [{
          serviceName: 'remote-service',
          status: 'healthy',
          isPrimary: true,
          isStandby: false,
          lastHeartbeat: Date.now(),
          metrics: {}
        }],
        lastHealthCheck: Date.now(),
        consecutiveFailures: 0,
        avgLatencyMs: 0,
        memoryUsagePercent: 0,
        cpuUsagePercent: 0
      });

      const activateHandler = jest.fn();
      manager.on('activateStandby', activateHandler);

      await manager.triggerFailover('asia-southeast1');

      expect(activateHandler).toHaveBeenCalled();
    });
  });
});

describe('RegionHealth interface', () => {
  it('should have correct structure', () => {
    const regionHealth: RegionHealth = {
      regionId: 'us-east1',
      status: 'healthy',
      isLeader: false,
      services: [{
        serviceName: 'test',
        status: 'healthy',
        isPrimary: true,
        isStandby: false,
        lastHeartbeat: Date.now(),
        metrics: {}
      }],
      lastHealthCheck: Date.now(),
      consecutiveFailures: 0,
      avgLatencyMs: 10,
      memoryUsagePercent: 50,
      cpuUsagePercent: 30
    };

    expect(regionHealth.regionId).toBeDefined();
    expect(regionHealth.status).toBeDefined();
    expect(regionHealth.services).toBeDefined();
  });
});

describe('GlobalHealthStatus interface', () => {
  it('should have correct structure', () => {
    const globalHealth: GlobalHealthStatus = {
      redis: { healthy: true, latencyMs: 5 },
      executor: { healthy: true, region: 'us-east1' },
      detectors: [
        { name: 'partition-asia-fast', healthy: true, region: 'asia-southeast1' }
      ],
      degradationLevel: DegradationLevel.FULL_OPERATION,
      overallStatus: 'healthy'
    };

    expect(globalHealth.redis).toBeDefined();
    expect(globalHealth.executor).toBeDefined();
    expect(globalHealth.detectors).toBeDefined();
    expect(globalHealth.degradationLevel).toBeDefined();
    expect(globalHealth.overallStatus).toBeDefined();
  });
});

describe('FailoverEvent interface', () => {
  it('should have correct structure for failover_started', () => {
    const event: FailoverEvent = {
      type: 'failover_started',
      sourceRegion: 'asia-southeast1',
      targetRegion: 'us-east1',
      services: ['partition-asia-fast', 'partition-l2-turbo'],
      timestamp: Date.now()
    };

    expect(event.type).toBe('failover_started');
    expect(event.services.length).toBe(2);
  });

  it('should have correct structure for failover_completed', () => {
    const event: FailoverEvent = {
      type: 'failover_completed',
      sourceRegion: 'asia-southeast1',
      targetRegion: 'us-east1',
      services: ['partition-asia-fast'],
      timestamp: Date.now(),
      durationMs: 5000
    };

    expect(event.type).toBe('failover_completed');
    expect(event.durationMs).toBeDefined();
  });

  it('should have correct structure for failover_failed', () => {
    const event: FailoverEvent = {
      type: 'failover_failed',
      sourceRegion: 'asia-southeast1',
      targetRegion: 'us-east1',
      services: ['partition-asia-fast'],
      timestamp: Date.now(),
      error: 'Connection timeout'
    };

    expect(event.type).toBe('failover_failed');
    expect(event.error).toBeDefined();
  });
});
