/**
 * Unit Tests for UnifiedChainDetector
 *
 * Tests the multi-chain detector service including:
 * - Lifecycle management
 * - Chain instance management
 * - Health reporting
 * - Event emission
 *
 * @see ADR-003: Partitioned Chain Detectors
 */

import { EventEmitter } from 'events';
import {
  UnifiedChainDetector,
  UnifiedDetectorConfig,
  UnifiedDetectorStats
} from './unified-detector';
import { ServiceState } from '../../../shared/core/src';

// Mock shared/core modules
jest.mock('../../../shared/core/src', () => ({
  createLogger: jest.fn().mockReturnValue({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }),
  getPerformanceLogger: jest.fn().mockReturnValue({
    logHealthCheck: jest.fn(),
    logArbitrageOpportunity: jest.fn(),
    logEventLatency: jest.fn()
  }),
  createServiceState: jest.fn().mockReturnValue({
    getState: jest.fn().mockReturnValue('running'),
    isRunning: jest.fn().mockReturnValue(true),
    isStopped: jest.fn().mockReturnValue(false),
    executeStart: jest.fn().mockImplementation(async (fn) => {
      await fn();
      return { success: true };
    }),
    executeStop: jest.fn().mockImplementation(async (fn) => {
      await fn();
      return { success: true };
    })
  }),
  ServiceState: {
    STOPPED: 'stopped',
    STARTING: 'starting',
    RUNNING: 'running',
    STOPPING: 'stopping',
    ERROR: 'error'
  },
  getRedisClient: jest.fn().mockResolvedValue({
    disconnect: jest.fn().mockResolvedValue(undefined),
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null)
  }),
  getRedisStreamsClient: jest.fn().mockResolvedValue({
    disconnect: jest.fn().mockResolvedValue(undefined),
    xadd: jest.fn().mockResolvedValue('1-0'),
    STREAMS: {
      HEALTH: 'health-stream',
      PRICE_UPDATES: 'price-updates',
      OPPORTUNITIES: 'opportunities'
    }
  }),
  RedisStreamsClient: {
    STREAMS: {
      HEALTH: 'health-stream',
      PRICE_UPDATES: 'price-updates',
      OPPORTUNITIES: 'opportunities'
    }
  },
  getCrossRegionHealthManager: jest.fn().mockReturnValue({
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    removeAllListeners: jest.fn()
  }),
  getGracefulDegradationManager: jest.fn().mockReturnValue({
    triggerDegradation: jest.fn().mockResolvedValue(true)
  })
}));

// Mock shared/config modules
jest.mock('../../../shared/config/src', () => ({
  getPartitionFromEnv: jest.fn().mockReturnValue({
    partitionId: 'asia-fast',
    name: 'Asia Fast',
    chains: ['bsc', 'polygon'],
    region: 'asia-southeast1',
    provider: 'oracle',
    resourceProfile: 'heavy',
    priority: 1,
    maxMemoryMB: 512,
    enabled: true,
    healthCheckIntervalMs: 15000,
    failoverTimeoutMs: 60000
  }),
  getChainsFromEnv: jest.fn().mockReturnValue(['bsc', 'polygon']),
  getPartition: jest.fn().mockReturnValue({
    partitionId: 'asia-fast',
    chains: ['bsc', 'polygon'],
    region: 'asia-southeast1',
    healthCheckIntervalMs: 15000,
    failoverTimeoutMs: 60000
  }),
  CHAINS: {
    bsc: { id: 56, name: 'BSC', rpcUrl: 'http://localhost:8545', wsUrl: 'ws://localhost:8546', blockTime: 3, nativeToken: 'BNB' },
    polygon: { id: 137, name: 'Polygon', rpcUrl: 'http://localhost:8545', wsUrl: 'ws://localhost:8546', blockTime: 2, nativeToken: 'MATIC' }
  },
  DEXES: {
    bsc: [{ name: 'pancakeswap', factoryAddress: '0x...', routerAddress: '0x...', fee: 25 }],
    polygon: [{ name: 'quickswap', factoryAddress: '0x...', routerAddress: '0x...', fee: 30 }]
  },
  CORE_TOKENS: {
    bsc: [{ address: '0x...', symbol: 'WBNB', decimals: 18, chainId: 56 }],
    polygon: [{ address: '0x...', symbol: 'WMATIC', decimals: 18, chainId: 137 }]
  }
}));

// Mock ChainDetectorInstance
jest.mock('./chain-instance', () => ({
  ChainDetectorInstance: jest.fn().mockImplementation((config) => {
    const emitter = new EventEmitter();
    return {
      ...emitter,
      on: emitter.on.bind(emitter),
      emit: emitter.emit.bind(emitter),
      removeAllListeners: emitter.removeAllListeners.bind(emitter),
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      isConnected: jest.fn().mockReturnValue(true),
      getChainId: jest.fn().mockReturnValue(config.chainId),
      getStats: jest.fn().mockReturnValue({
        chainId: config.chainId,
        status: 'connected',
        eventsProcessed: 100,
        opportunitiesFound: 5,
        lastBlockNumber: 12345,
        avgBlockLatencyMs: 50,
        pairsMonitored: 20
      })
    };
  })
}));

describe('UnifiedChainDetector', () => {
  let detector: UnifiedChainDetector;
  const defaultConfig: UnifiedDetectorConfig = {
    partitionId: 'asia-fast',
    chains: ['bsc', 'polygon'],
    instanceId: 'test-instance',
    regionId: 'asia-southeast1',
    enableCrossRegionHealth: false,
    healthCheckPort: 3001
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(async () => {
    if (detector) {
      await detector.stop();
    }
  });

  describe('constructor', () => {
    it('should create instance with default config', () => {
      detector = new UnifiedChainDetector();
      expect(detector).toBeDefined();
      expect(detector.getPartitionId()).toBe('asia-fast');
    });

    it('should create instance with explicit config', () => {
      detector = new UnifiedChainDetector(defaultConfig);
      expect(detector).toBeDefined();
      expect(detector.getPartitionId()).toBe('asia-fast');
    });

    it('should inherit from EventEmitter', () => {
      detector = new UnifiedChainDetector(defaultConfig);
      expect(detector).toBeInstanceOf(EventEmitter);
    });
  });

  describe('lifecycle', () => {
    it('should start successfully', async () => {
      detector = new UnifiedChainDetector(defaultConfig);
      await detector.start();
      expect(detector.isRunning()).toBe(true);
    });

    it('should initialize chain instances on start', async () => {
      detector = new UnifiedChainDetector(defaultConfig);
      await detector.start();

      const chains = detector.getChains();
      expect(chains).toContain('bsc');
      expect(chains).toContain('polygon');
    });

    it('should stop successfully', async () => {
      detector = new UnifiedChainDetector(defaultConfig);
      await detector.start();
      await detector.stop();

      // State manager mock always returns running, but stop should complete
      expect(detector.getChains()).toHaveLength(0);
    });
  });

  describe('chain instance management', () => {
    it('should get chain instance by ID', async () => {
      detector = new UnifiedChainDetector(defaultConfig);
      await detector.start();

      const bscInstance = detector.getChainInstance('bsc');
      expect(bscInstance).toBeDefined();
      expect(bscInstance!.getChainId()).toBe('bsc');
    });

    it('should return undefined for unknown chain', async () => {
      detector = new UnifiedChainDetector(defaultConfig);
      await detector.start();

      const unknownInstance = detector.getChainInstance('unknown');
      expect(unknownInstance).toBeUndefined();
    });

    it('should start multiple chain instances in parallel', async () => {
      detector = new UnifiedChainDetector(defaultConfig);
      await detector.start();

      const chains = detector.getChains();
      expect(chains.length).toBe(2);
    });
  });

  describe('statistics', () => {
    it('should return detector stats', async () => {
      detector = new UnifiedChainDetector(defaultConfig);
      await detector.start();

      const stats = detector.getStats();
      expect(stats).toBeDefined();
      expect(stats.partitionId).toBe('asia-fast');
      expect(stats.chains).toContain('bsc');
      expect(stats.chains).toContain('polygon');
    });

    it('should aggregate events from all chains', async () => {
      detector = new UnifiedChainDetector(defaultConfig);
      await detector.start();

      const stats = detector.getStats();
      // Each mock chain returns 100 events
      expect(stats.totalEventsProcessed).toBe(200);
    });

    it('should aggregate opportunities from all chains', async () => {
      detector = new UnifiedChainDetector(defaultConfig);
      await detector.start();

      const stats = detector.getStats();
      // Each mock chain returns 5 opportunities
      expect(stats.totalOpportunitiesFound).toBe(10);
    });

    it('should track uptime', async () => {
      detector = new UnifiedChainDetector(defaultConfig);
      await detector.start();

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 100));

      const stats = detector.getStats();
      expect(stats.uptimeSeconds).toBeGreaterThan(0);
    });

    it('should track memory usage', async () => {
      detector = new UnifiedChainDetector(defaultConfig);
      await detector.start();

      const stats = detector.getStats();
      expect(stats.memoryUsageMB).toBeGreaterThan(0);
    });

    it('should include per-chain stats', async () => {
      detector = new UnifiedChainDetector(defaultConfig);
      await detector.start();

      const stats = detector.getStats();
      expect(stats.chainStats.size).toBe(2);
      expect(stats.chainStats.has('bsc')).toBe(true);
      expect(stats.chainStats.has('polygon')).toBe(true);
    });
  });

  describe('health reporting', () => {
    it('should return partition health', async () => {
      detector = new UnifiedChainDetector(defaultConfig);
      await detector.start();

      const health = await detector.getPartitionHealth();
      expect(health).toBeDefined();
      expect(health.partitionId).toBe('asia-fast');
      expect(health.status).toBe('healthy');
    });

    it('should include chain health in partition health', async () => {
      detector = new UnifiedChainDetector(defaultConfig);
      await detector.start();

      const health = await detector.getPartitionHealth();
      expect(health.chainHealth.size).toBe(2);
      expect(health.chainHealth.has('bsc')).toBe(true);
      expect(health.chainHealth.has('polygon')).toBe(true);
    });

    it('should calculate overall status based on chain health', async () => {
      detector = new UnifiedChainDetector(defaultConfig);
      await detector.start();

      const health = await detector.getPartitionHealth();
      // All chains are healthy in mock
      expect(health.status).toBe('healthy');
    });

    it('should track events processed in health', async () => {
      detector = new UnifiedChainDetector(defaultConfig);
      await detector.start();

      const health = await detector.getPartitionHealth();
      expect(health.totalEventsProcessed).toBeGreaterThan(0);
    });
  });

  describe('event emission', () => {
    it('should emit priceUpdate events from chain instances', async () => {
      detector = new UnifiedChainDetector(defaultConfig);

      const priceHandler = jest.fn();
      detector.on('priceUpdate', priceHandler);

      await detector.start();

      // Simulate price update from chain instance
      const bscInstance = detector.getChainInstance('bsc');
      bscInstance!.emit('priceUpdate', { chain: 'bsc', price: 100 });

      expect(priceHandler).toHaveBeenCalledWith({ chain: 'bsc', price: 100 });
    });

    it('should emit opportunity events from chain instances', async () => {
      detector = new UnifiedChainDetector(defaultConfig);

      const oppHandler = jest.fn();
      detector.on('opportunity', oppHandler);

      await detector.start();

      // Simulate opportunity from chain instance
      const bscInstance = detector.getChainInstance('bsc');
      bscInstance!.emit('opportunity', { id: 'opp-1', profit: 0.01 });

      expect(oppHandler).toHaveBeenCalledWith({ id: 'opp-1', profit: 0.01 });
    });

    it('should emit chainError events', async () => {
      detector = new UnifiedChainDetector(defaultConfig);

      const errorHandler = jest.fn();
      detector.on('chainError', errorHandler);

      await detector.start();

      // Simulate error from chain instance
      const bscInstance = detector.getChainInstance('bsc');
      bscInstance!.emit('error', new Error('Connection failed'));

      expect(errorHandler).toHaveBeenCalled();
    });
  });

  describe('getters', () => {
    it('should return isRunning state', async () => {
      detector = new UnifiedChainDetector(defaultConfig);
      expect(detector.isRunning()).toBe(true); // Mock always returns true

      await detector.start();
      expect(detector.isRunning()).toBe(true);
    });

    it('should return current state', async () => {
      detector = new UnifiedChainDetector(defaultConfig);
      await detector.start();

      const state = detector.getState();
      expect(state).toBe('running');
    });

    it('should return partition ID', () => {
      detector = new UnifiedChainDetector(defaultConfig);
      expect(detector.getPartitionId()).toBe('asia-fast');
    });

    it('should return chains array', async () => {
      detector = new UnifiedChainDetector(defaultConfig);
      await detector.start();

      const chains = detector.getChains();
      expect(Array.isArray(chains)).toBe(true);
      expect(chains.length).toBe(2);
    });
  });

  describe('cross-region health integration', () => {
    it('should initialize cross-region health when enabled', async () => {
      const { getCrossRegionHealthManager } = require('../../../shared/core/src');

      detector = new UnifiedChainDetector({
        ...defaultConfig,
        enableCrossRegionHealth: true
      });

      await detector.start();

      expect(getCrossRegionHealthManager).toHaveBeenCalled();
    });

    it('should not initialize cross-region health when disabled', async () => {
      const { getCrossRegionHealthManager } = require('../../../shared/core/src');
      getCrossRegionHealthManager.mockClear();

      detector = new UnifiedChainDetector({
        ...defaultConfig,
        enableCrossRegionHealth: false
      });

      await detector.start();

      expect(getCrossRegionHealthManager).not.toHaveBeenCalled();
    });
  });

  describe('graceful degradation', () => {
    it('should trigger degradation on chain error', async () => {
      const { getGracefulDegradationManager } = require('../../../shared/core/src');
      const mockDegradationManager = getGracefulDegradationManager();

      detector = new UnifiedChainDetector(defaultConfig);
      await detector.start();

      // Simulate error from chain instance
      const bscInstance = detector.getChainInstance('bsc');
      bscInstance!.emit('error', new Error('Connection failed'));

      expect(mockDegradationManager.triggerDegradation).toHaveBeenCalled();
    });
  });
});

describe('UnifiedDetectorStats interface', () => {
  it('should have correct structure', () => {
    const stats: UnifiedDetectorStats = {
      partitionId: 'asia-fast',
      chains: ['bsc', 'polygon'],
      totalEventsProcessed: 1000,
      totalOpportunitiesFound: 50,
      uptimeSeconds: 3600,
      memoryUsageMB: 256,
      chainStats: new Map([
        ['bsc', {
          chainId: 'bsc',
          status: 'connected',
          eventsProcessed: 500,
          opportunitiesFound: 25,
          lastBlockNumber: 12345,
          avgBlockLatencyMs: 50,
          pairsMonitored: 100
        }]
      ])
    };

    expect(stats.partitionId).toBeDefined();
    expect(stats.chains).toBeDefined();
    expect(stats.chainStats).toBeDefined();
    expect(stats.chainStats.size).toBe(1);
  });
});
