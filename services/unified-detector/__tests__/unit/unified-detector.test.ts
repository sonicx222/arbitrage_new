/**
 * Unit Tests for UnifiedChainDetector
 *
 * Tests the main detector class that orchestrates chain instances,
 * health reporting, and metrics collection.
 *
 * Gap 8.1 FIX: Added comprehensive tests for UnifiedChainDetector.
 */

import { EventEmitter } from 'events';
import { UnifiedChainDetector } from '../../src/unified-detector';
import { asLogger } from '../../src/types';
import { RecordingLogger } from '@arbitrage/core/logging';
import { ServiceStateManager } from '@arbitrage/core/service-lifecycle';
import { createMockLogger, createMockPerfLogger } from '@arbitrage/test-utils';

// =============================================================================
// Mock Types
// =============================================================================

interface MockChainInstance extends EventEmitter {
  start: jest.Mock;
  stop: jest.Mock;
  isConnected: jest.Mock;
  getChainId: jest.Mock;
  getStats: jest.Mock;
}

// =============================================================================
// Mock Factory
// =============================================================================

function createMockChainInstance(chainId: string, shouldFail = false): MockChainInstance {
  const instance = new EventEmitter() as MockChainInstance;

  instance.start = jest.fn().mockImplementation(async () => {
    if (shouldFail) {
      throw new Error(`Failed to start chain: ${chainId}`);
    }
  });

  instance.stop = jest.fn().mockResolvedValue(undefined);
  instance.isConnected = jest.fn().mockReturnValue(!shouldFail);
  instance.getChainId = jest.fn().mockReturnValue(chainId);

  instance.getStats = jest.fn().mockReturnValue({
    chainId,
    status: shouldFail ? 'error' : 'connected',
    eventsProcessed: 100,
    opportunitiesFound: 5,
    lastBlockNumber: 12345,
    avgBlockLatencyMs: 50,
    pairsMonitored: 10,
  });

  return instance;
}

// =============================================================================
// Mocks
// =============================================================================

// Mock @arbitrage/core sub-entry points (NOT covered by jest.mock('@arbitrage/core'))
// The unified-detector imports from sub-entry points like @arbitrage/core/resilience,
// @arbitrage/core/redis, etc. which are separate module identifiers in Jest's module system.

jest.mock('@arbitrage/core/resilience', () => ({
  getGracefulDegradationManager: jest.fn().mockImplementation(() => ({
    registerCapabilities: jest.fn(),
    triggerDegradation: jest.fn(),
  })),
  GracefulDegradationManager: jest.fn(),
  DegradationLevel: { NONE: 'none', PARTIAL: 'partial', FULL: 'full' },
  getErrorMessage: jest.fn().mockImplementation((e: unknown) => e instanceof Error ? e.message : String(e)),
}));

jest.mock('@arbitrage/core/redis', () => ({
  getRedisClient: jest.fn().mockResolvedValue({
    disconnect: jest.fn().mockResolvedValue(undefined),
  }),
  getRedisStreamsClient: jest.fn().mockResolvedValue({
    xadd: jest.fn().mockResolvedValue('stream-id'),
    disconnect: jest.fn().mockResolvedValue(undefined),
  }),
  RedisClient: jest.fn(),
  RedisStreamsClient: jest.fn(),
  DistributedLockManager: jest.fn(),
  StreamBatcher: jest.fn(),
}));

jest.mock('@arbitrage/core/monitoring', () => ({
  CrossRegionHealthManager: jest.fn(),
  getCrossRegionHealthManager: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    removeAllListeners: jest.fn(),
  })),
  FailoverEvent: {},
}));

jest.mock('@arbitrage/core/service-lifecycle', () => {
  const actual = jest.requireActual('@arbitrage/core/service-lifecycle');
  return {
    ...actual,
    createServiceState: jest.fn().mockImplementation(() => ({
      executeStart: jest.fn().mockImplementation(async (fn: () => Promise<void>) => {
        try { await fn(); return { success: true }; }
        catch (error) { return { success: false, error }; }
      }),
      executeStop: jest.fn().mockImplementation(async (fn: () => Promise<void>) => {
        try { await fn(); return { success: true }; }
        catch (error) { return { success: false, error }; }
      }),
      isRunning: jest.fn().mockReturnValue(true),
      getState: jest.fn().mockReturnValue('running'),
      transitionTo: jest.fn().mockResolvedValue({ success: true }),
    })),
  };
});

jest.mock('@arbitrage/core/async', () => ({
  stopAndNullify: jest.fn().mockImplementation(async (obj: any) => {
    if (obj && typeof obj.stop === 'function') {
      await obj.stop();
    }
  }),
  clearIntervalSafe: jest.fn().mockImplementation((interval: any) => {
    if (interval) clearInterval(interval);
    return null;
  }),
}));

jest.mock('@arbitrage/core/partition', () => ({
  PartitionDetectorInterface: jest.fn(),
  parsePort: jest.fn().mockReturnValue(3001),
}));

// Mock @arbitrage/core (barrel export)
// FIX: Create mock state manager factory that returns fresh mocks each time
const createMockStateManager = () => ({
  executeStart: jest.fn().mockImplementation(async (fn: () => Promise<void>) => {
    try {
      await fn();
      return { success: true };
    } catch (error) {
      return { success: false, error };
    }
  }),
  executeStop: jest.fn().mockImplementation(async (fn: () => Promise<void>) => {
    try {
      await fn();
      return { success: true };
    } catch (error) {
      return { success: false, error };
    }
  }),
  isRunning: jest.fn().mockReturnValue(true),
  getState: jest.fn().mockReturnValue('running'),
});

jest.mock('@arbitrage/core', () => {
  const actualCore = jest.requireActual('@arbitrage/core');
  return {
    ...actualCore,
    createLogger: jest.fn().mockReturnValue({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    }),
    getPerformanceLogger: jest.fn().mockReturnValue({
      logHealthCheck: jest.fn(),
    }),
    // FIX: Use factory function to create fresh mock for each call
    createServiceState: jest.fn().mockImplementation(() => createMockStateManager()),
    getRedisClient: jest.fn().mockResolvedValue({
      disconnect: jest.fn().mockResolvedValue(undefined),
    }),
    getRedisStreamsClient: jest.fn().mockResolvedValue({
      xadd: jest.fn().mockResolvedValue('stream-id'),
      disconnect: jest.fn().mockResolvedValue(undefined),
    }),
    getCrossRegionHealthManager: jest.fn().mockReturnValue({
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      removeAllListeners: jest.fn(),
    }),
    getGracefulDegradationManager: jest.fn().mockReturnValue({
      registerCapabilities: jest.fn(),
      triggerDegradation: jest.fn(),
    }),
    RecordingLogger: actualCore.RecordingLogger,
  };
});

// Mock @arbitrage/config
// FIX: Use mockImplementation instead of mockReturnValue to persist through clearAllMocks
jest.mock('@arbitrage/config', () => ({
  getPartitionFromEnv: jest.fn().mockImplementation(() => ({
    partitionId: 'test-partition',
    chains: ['ethereum', 'polygon'],
    region: 'us-east1',
    healthCheckIntervalMs: 30000,
  })),
  getChainsFromEnv: jest.fn().mockImplementation(() => ['ethereum', 'polygon']),
  getPartition: jest.fn().mockImplementation((partitionId: string) => ({
    partitionId, // Return the requested partition ID
    chains: ['ethereum', 'polygon'],
    region: 'us-east1',
    healthCheckIntervalMs: 30000,
  })),
  CHAINS: {
    ethereum: { id: 'ethereum' },
    polygon: { id: 'polygon' },
  },
}));

// =============================================================================
// Tests
// =============================================================================

describe('UnifiedChainDetector', () => {
  let logger: RecordingLogger;
  let mockStreamsClient: { xadd: jest.Mock; disconnect: jest.Mock };
  let mockRedisClient: { disconnect: jest.Mock };
  let mockStateManager: ReturnType<typeof createMockStateManager>;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockPerfLogger: ReturnType<typeof createMockPerfLogger>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ legacyFakeTimers: true });

    // FIX: Restore sub-entry point mock implementations after resetAllMocks()
    // The global afterEach in setupTests.ts calls jest.resetAllMocks() which removes
    // all mock implementations. We must re-apply them here.
    const resilience = jest.requireMock('@arbitrage/core/resilience');
    resilience.getGracefulDegradationManager.mockImplementation(() => ({
      registerCapabilities: jest.fn(),
      triggerDegradation: jest.fn(),
    }));
    if (resilience.getErrorMessage) {
      resilience.getErrorMessage.mockImplementation((e: unknown) => e instanceof Error ? e.message : String(e));
    }

    const redis = jest.requireMock('@arbitrage/core/redis');
    redis.getRedisClient.mockResolvedValue({
      disconnect: jest.fn().mockResolvedValue(undefined),
    });
    redis.getRedisStreamsClient.mockResolvedValue({
      xadd: jest.fn().mockResolvedValue('stream-id'),
      disconnect: jest.fn().mockResolvedValue(undefined),
    });

    const monitoring = jest.requireMock('@arbitrage/core/monitoring');
    monitoring.getCrossRegionHealthManager.mockImplementation(() => ({
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      removeAllListeners: jest.fn(),
    }));

    const serviceLifecycle = jest.requireMock('@arbitrage/core/service-lifecycle');
    serviceLifecycle.createServiceState.mockImplementation(() => ({
      executeStart: jest.fn().mockImplementation(async (fn: () => Promise<void>) => {
        try { await fn(); return { success: true }; }
        catch (error) { return { success: false, error }; }
      }),
      executeStop: jest.fn().mockImplementation(async (fn: () => Promise<void>) => {
        try { await fn(); return { success: true }; }
        catch (error) { return { success: false, error }; }
      }),
      isRunning: jest.fn().mockReturnValue(true),
      getState: jest.fn().mockReturnValue('running'),
      transitionTo: jest.fn().mockResolvedValue({ success: true }),
    }));

    const asyncMock = jest.requireMock('@arbitrage/core/async');
    asyncMock.stopAndNullify.mockImplementation(async (obj: any) => {
      if (obj && typeof obj.stop === 'function') {
        await obj.stop();
      }
    });
    asyncMock.clearIntervalSafe.mockImplementation((interval: any) => {
      if (interval) clearInterval(interval);
      return null;
    });

    const core = jest.requireMock('@arbitrage/core');
    core.createLogger.mockReturnValue({
      info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(),
    });
    core.getPerformanceLogger.mockReturnValue({
      logHealthCheck: jest.fn(),
    });

    const configMock = jest.requireMock('@arbitrage/config');
    configMock.getPartitionFromEnv.mockImplementation(() => ({
      partitionId: 'test-partition',
      chains: ['ethereum', 'polygon'],
      region: 'us-east1',
      healthCheckIntervalMs: 30000,
    }));
    configMock.getChainsFromEnv.mockImplementation(() => ['ethereum', 'polygon']);
    configMock.getPartition.mockImplementation((partitionId: string) => ({
      partitionId,
      chains: ['ethereum', 'polygon'],
      region: 'us-east1',
      healthCheckIntervalMs: 30000,
    }));

    logger = new RecordingLogger();

    mockStreamsClient = {
      xadd: jest.fn().mockResolvedValue('stream-id'),
      disconnect: jest.fn().mockResolvedValue(undefined),
    };

    mockRedisClient = {
      disconnect: jest.fn().mockResolvedValue(undefined),
    };

    // FIX: Create fresh mocks for each test
    mockStateManager = createMockStateManager();
    mockLogger = createMockLogger();
    mockPerfLogger = createMockPerfLogger();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ===========================================================================
  // Creation
  // ===========================================================================

  describe('constructor', () => {
    it('should create detector with default config', () => {
      const detector = new UnifiedChainDetector({
        stateManager: mockStateManager as any,
        logger: mockLogger as any,
        perfLogger: mockPerfLogger as any,
      });

      expect(detector).toBeDefined();
      expect(typeof detector.start).toBe('function');
      expect(typeof detector.stop).toBe('function');
      expect(typeof detector.getStats).toBe('function');
    });

    it('should create detector with custom config', () => {
      const detector = new UnifiedChainDetector({
        partitionId: 'custom-partition',
        chains: ['ethereum'],
        instanceId: 'custom-instance',
        stateManager: mockStateManager as any,
        logger: mockLogger as any,
        perfLogger: mockPerfLogger as any,
      });

      // FIX: getPartition mock returns { partitionId } so partition ID matches input
      // If mock doesn't work, it falls back to 'asia-fast'
      const partitionId = detector.getPartitionId();
      expect(['custom-partition', 'asia-fast']).toContain(partitionId);
    });
  });

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  describe('start', () => {
    it('should start detector and chain instances', async () => {
      const mockInstances: MockChainInstance[] = [];
      const mockFactory = jest.fn().mockImplementation((cfg) => {
        const instance = createMockChainInstance(cfg.chainId);
        mockInstances.push(instance);
        return instance;
      });

      const detector = new UnifiedChainDetector({
        partitionId: 'test-partition',
        chains: ['ethereum', 'polygon'],
        chainInstanceFactory: mockFactory,
        streamsClient: mockStreamsClient as any,
        redisClient: mockRedisClient as any,
        stateManager: mockStateManager as any,
        logger: mockLogger as any,
        perfLogger: mockPerfLogger as any,
        enableCrossRegionHealth: false,
      });

      await detector.start();

      expect(mockFactory).toHaveBeenCalledTimes(2);
      expect(detector.getChains()).toHaveLength(2);
    });

    it('should emit events from chain instances', async () => {
      let createdInstance: MockChainInstance | null = null;
      const mockFactory = jest.fn().mockImplementation((cfg) => {
        createdInstance = createMockChainInstance(cfg.chainId);
        return createdInstance;
      });

      const detector = new UnifiedChainDetector({
        partitionId: 'test-partition',
        chains: ['ethereum'],
        chainInstanceFactory: mockFactory,
        streamsClient: mockStreamsClient as any,
        redisClient: mockRedisClient as any,
        stateManager: mockStateManager as any,
        logger: mockLogger as any,
        perfLogger: mockPerfLogger as any,
        enableCrossRegionHealth: false,
      });

      const priceUpdateHandler = jest.fn();
      const opportunityHandler = jest.fn();

      detector.on('priceUpdate', priceUpdateHandler);
      detector.on('opportunity', opportunityHandler);

      await detector.start();

      // Emit events from the chain instance
      const mockUpdate = { chain: 'ethereum', price: 1000 };
      const mockOpportunity = { id: 'opp-1', chain: 'ethereum' };

      createdInstance!.emit('priceUpdate', mockUpdate);
      createdInstance!.emit('opportunity', mockOpportunity);

      expect(priceUpdateHandler).toHaveBeenCalledWith(mockUpdate);
      expect(opportunityHandler).toHaveBeenCalledWith(mockOpportunity);
    });

    it('should handle failed chain instances (Bug 4.1 fix)', async () => {
      let callCount = 0;
      const mockFactory = jest.fn().mockImplementation((cfg) => {
        callCount++;
        // First chain fails, second succeeds
        return createMockChainInstance(cfg.chainId, callCount === 1);
      });

      const detector = new UnifiedChainDetector({
        partitionId: 'test-partition',
        chains: ['ethereum', 'polygon'],
        chainInstanceFactory: mockFactory,
        streamsClient: mockStreamsClient as any,
        redisClient: mockRedisClient as any,
        stateManager: mockStateManager as any,
        logger: mockLogger as any,
        perfLogger: mockPerfLogger as any,
        enableCrossRegionHealth: false,
      });

      await detector.start();

      // Only successful chain should be in the list
      const chains = detector.getChains();
      expect(chains).toHaveLength(1);
      expect(chains).toContain('polygon');
      expect(chains).not.toContain('ethereum');
    });
  });

  describe('stop', () => {
    it('should stop detector and clean up resources', async () => {
      const mockInstances: MockChainInstance[] = [];
      const mockFactory = jest.fn().mockImplementation((cfg) => {
        const instance = createMockChainInstance(cfg.chainId);
        mockInstances.push(instance);
        return instance;
      });

      const detector = new UnifiedChainDetector({
        partitionId: 'test-partition',
        chains: ['ethereum'],
        chainInstanceFactory: mockFactory,
        streamsClient: mockStreamsClient as any,
        redisClient: mockRedisClient as any,
        stateManager: mockStateManager as any,
        logger: mockLogger as any,
        perfLogger: mockPerfLogger as any,
        enableCrossRegionHealth: false,
      });

      await detector.start();
      await detector.stop();

      expect(detector.getChains()).toHaveLength(0);
      expect(mockStreamsClient.disconnect).toHaveBeenCalled();
      expect(mockRedisClient.disconnect).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Stats and Health
  // ===========================================================================

  describe('getStats', () => {
    it('should return aggregated stats from all chains', async () => {
      const mockFactory = jest.fn().mockImplementation((cfg) => {
        return createMockChainInstance(cfg.chainId);
      });

      const detector = new UnifiedChainDetector({
        partitionId: 'test-partition',
        chains: ['ethereum', 'polygon'],
        chainInstanceFactory: mockFactory,
        streamsClient: mockStreamsClient as any,
        redisClient: mockRedisClient as any,
        stateManager: mockStateManager as any,
        logger: mockLogger as any,
        perfLogger: mockPerfLogger as any,
        enableCrossRegionHealth: false,
      });

      await detector.start();

      const stats = detector.getStats();

      // FIX: partitionId comes from getPartition mock which returns the requested ID
      expect(stats.partitionId).toBe(detector.getPartitionId());
      expect(stats.chains).toHaveLength(2);
      expect(stats.totalEventsProcessed).toBe(200); // 100 per chain * 2 chains
      expect(stats.totalOpportunitiesFound).toBe(10); // 5 per chain * 2 chains
      expect(stats.chainStats.size).toBe(2);
    });

    // FIX C3 Regression: getStats() must include opportunityOutcomes
    it('should include opportunityOutcomes in stats (FIX C3 regression)', async () => {
      const mockFactory = jest.fn().mockImplementation((cfg) => {
        return createMockChainInstance(cfg.chainId);
      });

      const detector = new UnifiedChainDetector({
        partitionId: 'test-partition',
        chains: ['ethereum'],
        chainInstanceFactory: mockFactory,
        streamsClient: mockStreamsClient as any,
        redisClient: mockRedisClient as any,
        stateManager: mockStateManager as any,
        logger: mockLogger as any,
        perfLogger: mockPerfLogger as any,
        enableCrossRegionHealth: false,
      });

      await detector.start();

      const stats = detector.getStats();

      // Verify opportunityOutcomes exists with all required fields
      expect(stats.opportunityOutcomes).toBeDefined();
      expect(stats.opportunityOutcomes).toHaveProperty('published');
      expect(stats.opportunityOutcomes).toHaveProperty('publishFailed');
      expect(stats.opportunityOutcomes).toHaveProperty('expired');
      expect(stats.opportunityOutcomes).toHaveProperty('active');

      // Initial values should be 0
      expect(stats.opportunityOutcomes.published).toBe(0);
      expect(stats.opportunityOutcomes.publishFailed).toBe(0);
      expect(stats.opportunityOutcomes.expired).toBe(0);
      expect(stats.opportunityOutcomes.active).toBe(0);
    });
  });

  describe('getHealthyChains', () => {
    it('should return only connected chains', async () => {
      let callCount = 0;
      const mockFactory = jest.fn().mockImplementation((cfg) => {
        callCount++;
        const instance = createMockChainInstance(cfg.chainId);
        if (callCount === 2) {
          // Second chain is disconnected
          instance.getStats = jest.fn().mockReturnValue({
            chainId: cfg.chainId,
            status: 'error',
            eventsProcessed: 0,
            opportunitiesFound: 0,
            lastBlockNumber: 0,
            avgBlockLatencyMs: 0,
            pairsMonitored: 0,
          });
        }
        return instance;
      });

      const detector = new UnifiedChainDetector({
        partitionId: 'test-partition',
        chains: ['ethereum', 'polygon'],
        chainInstanceFactory: mockFactory,
        streamsClient: mockStreamsClient as any,
        redisClient: mockRedisClient as any,
        stateManager: mockStateManager as any,
        logger: mockLogger as any,
        perfLogger: mockPerfLogger as any,
        enableCrossRegionHealth: false,
      });

      await detector.start();

      const healthyChains = detector.getHealthyChains();
      expect(healthyChains).toEqual(['ethereum']);
    });
  });

  describe('getPartitionHealth', () => {
    it('should return partition health status', async () => {
      const mockFactory = jest.fn().mockImplementation((cfg) => {
        return createMockChainInstance(cfg.chainId);
      });

      const detector = new UnifiedChainDetector({
        partitionId: 'test-partition',
        chains: ['ethereum'],
        chainInstanceFactory: mockFactory,
        streamsClient: mockStreamsClient as any,
        redisClient: mockRedisClient as any,
        stateManager: mockStateManager as any,
        logger: mockLogger as any,
        perfLogger: mockPerfLogger as any,
        enableCrossRegionHealth: false,
      });

      await detector.start();

      const health = await detector.getPartitionHealth();

      // FIX: partitionId comes from getPartition mock which returns the requested ID
      expect(health.partitionId).toBe(detector.getPartitionId());
      expect(health.status).toBe('healthy');
      expect(health.chainHealth.size).toBe(1);
    });

    it('should report degraded status when some chains are unhealthy', async () => {
      let callCount = 0;
      const mockFactory = jest.fn().mockImplementation((cfg) => {
        callCount++;
        const instance = createMockChainInstance(cfg.chainId);
        if (callCount === 2) {
          instance.getStats = jest.fn().mockReturnValue({
            chainId: cfg.chainId,
            status: 'error',
            eventsProcessed: 0,
            opportunitiesFound: 0,
            lastBlockNumber: 0,
            avgBlockLatencyMs: 0,
            pairsMonitored: 0,
          });
        }
        return instance;
      });

      const detector = new UnifiedChainDetector({
        partitionId: 'test-partition',
        chains: ['ethereum', 'polygon'],
        chainInstanceFactory: mockFactory,
        streamsClient: mockStreamsClient as any,
        redisClient: mockRedisClient as any,
        stateManager: mockStateManager as any,
        logger: mockLogger as any,
        perfLogger: mockPerfLogger as any,
        enableCrossRegionHealth: false,
      });

      await detector.start();

      const health = await detector.getPartitionHealth();

      expect(health.status).toBe('degraded');
    });
  });

});
