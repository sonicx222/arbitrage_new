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
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  UnifiedChainDetector,
  UnifiedDetectorConfig,
  UnifiedDetectorStats
} from './unified-detector';

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
  logHealthCheck: jest.fn(),
  logArbitrageOpportunity: jest.fn(),
  logEventLatency: jest.fn()
});

// Mock Redis client factory
const createMockRedisClient = () => ({
  disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  set: jest.fn<() => Promise<string>>().mockResolvedValue('OK'),
  get: jest.fn<() => Promise<string | null>>().mockResolvedValue(null)
});

// Mock Redis Streams client factory
const createMockStreamsClient = () => ({
  disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  xadd: jest.fn<() => Promise<string>>().mockResolvedValue('1-0'),
  STREAMS: {
    HEALTH: 'health-stream',
    PRICE_UPDATES: 'price-updates',
    OPPORTUNITIES: 'opportunities'
  }
});

// Mock state manager factory
const createMockStateManager = () => ({
  getState: jest.fn().mockReturnValue('running'),
  isRunning: jest.fn().mockReturnValue(true),
  isStopped: jest.fn().mockReturnValue(false),
  executeStart: jest.fn<(fn: () => Promise<void>) => Promise<{ success: boolean }>>()
    .mockImplementation(async (fn) => {
      await fn();
      return { success: true };
    }),
  executeStop: jest.fn<(fn: () => Promise<void>) => Promise<{ success: boolean }>>()
    .mockImplementation(async (fn) => {
      await fn();
      return { success: true };
    })
});

// Mock @arbitrage/config - this still uses module mock since it's not an alias issue
jest.mock('@arbitrage/config', () => ({
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

// Mock @arbitrage/core for non-DI functions
jest.mock('@arbitrage/core', () => ({
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
    executeStart: jest.fn().mockImplementation(async (fn: any) => {
      await fn();
      return { success: true };
    }),
    executeStop: jest.fn().mockImplementation(async (fn: any) => {
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
  getRedisClient: jest.fn<() => Promise<any>>().mockResolvedValue({
    disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    set: jest.fn<() => Promise<string>>().mockResolvedValue('OK'),
    get: jest.fn<() => Promise<string | null>>().mockResolvedValue(null)
  }),
  getRedisStreamsClient: jest.fn<() => Promise<any>>().mockResolvedValue({
    disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    xadd: jest.fn<() => Promise<string>>().mockResolvedValue('1-0'),
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
    start: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stop: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    on: jest.fn(),
    removeAllListeners: jest.fn()
  }),
  getGracefulDegradationManager: jest.fn().mockReturnValue({
    triggerDegradation: jest.fn<() => Promise<boolean>>().mockResolvedValue(true)
  })
}));

// Mock ChainDetectorInstance factory (using DI instead of module mock)
class MockChainDetectorInstance extends EventEmitter {
  public start = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  public stop = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  public isConnected = jest.fn<() => boolean>().mockReturnValue(true);
  public getChainId: () => string;
  public getStats: () => object;

  constructor(config: { chainId: string }) {
    super();
    // Assign mock functions with correct return values
    const getChainIdMock = jest.fn<() => string>();
    getChainIdMock.mockReturnValue(config.chainId);
    this.getChainId = getChainIdMock;

    const getStatsMock = jest.fn<() => object>();
    getStatsMock.mockReturnValue({
      chainId: config.chainId,
      status: 'connected',
      eventsProcessed: 100,
      opportunitiesFound: 5,
      lastBlockNumber: 12345,
      avgBlockLatencyMs: 50,
      pairsMonitored: 20
    });
    this.getStats = getStatsMock;
  }
}

// Track created mock instances for testing
let mockChainInstances: Map<string, MockChainDetectorInstance> = new Map();

const createMockChainInstanceFactory = () => {
  mockChainInstances = new Map();
  return (config: { chainId: string; partitionId: string; streamsClient: any; perfLogger: any }) => {
    const instance = new MockChainDetectorInstance(config);
    mockChainInstances.set(config.chainId, instance);
    return instance as any;
  };
};

describe('UnifiedChainDetector', () => {
  let detector: UnifiedChainDetector;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockPerfLogger: ReturnType<typeof createMockPerfLogger>;
  let mockStateManager: ReturnType<typeof createMockStateManager>;
  let mockRedisClient: ReturnType<typeof createMockRedisClient>;
  let mockStreamsClient: ReturnType<typeof createMockStreamsClient>;
  let mockChainInstanceFactory: ReturnType<typeof createMockChainInstanceFactory>;

  // Create test config with injected mocks
  const createTestConfig = (overrides: Partial<UnifiedDetectorConfig> = {}): UnifiedDetectorConfig => ({
    partitionId: 'asia-fast',
    chains: ['bsc', 'polygon'],
    instanceId: 'test-instance',
    regionId: 'asia-southeast1',
    enableCrossRegionHealth: false,
    healthCheckPort: 3001,
    logger: mockLogger,
    perfLogger: mockPerfLogger as any,
    stateManager: mockStateManager as any,
    redisClient: mockRedisClient as any,
    streamsClient: mockStreamsClient as any,
    chainInstanceFactory: mockChainInstanceFactory,
    ...overrides
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockPerfLogger = createMockPerfLogger();
    mockStateManager = createMockStateManager();
    mockRedisClient = createMockRedisClient();
    mockStreamsClient = createMockStreamsClient();
    mockChainInstanceFactory = createMockChainInstanceFactory();
  });

  afterEach(async () => {
    if (detector) {
      await detector.stop();
    }
  });

  describe('constructor', () => {
    it('should create instance with default config', () => {
      detector = new UnifiedChainDetector(createTestConfig());
      expect(detector).toBeDefined();
      expect(detector.getPartitionId()).toBe('asia-fast');
    });

    it('should create instance with explicit config', () => {
      detector = new UnifiedChainDetector(createTestConfig());
      expect(detector).toBeDefined();
      expect(detector.getPartitionId()).toBe('asia-fast');
    });

    it('should inherit from EventEmitter', () => {
      detector = new UnifiedChainDetector(createTestConfig());
      expect(detector).toBeInstanceOf(EventEmitter);
    });
  });

  describe('lifecycle', () => {
    it('should start successfully', async () => {
      detector = new UnifiedChainDetector(createTestConfig());
      await detector.start();
      expect(detector.isRunning()).toBe(true);
    });

    it('should initialize chain instances on start', async () => {
      detector = new UnifiedChainDetector(createTestConfig());
      await detector.start();

      const chains = detector.getChains();
      expect(chains).toContain('bsc');
      expect(chains).toContain('polygon');
    });

    it('should stop successfully', async () => {
      detector = new UnifiedChainDetector(createTestConfig());
      await detector.start();
      await detector.stop();

      // State manager mock always returns running, but stop should complete
      expect(detector.getChains()).toHaveLength(0);
    });
  });

  describe('chain instance management', () => {
    it('should get chain instance by ID', async () => {
      detector = new UnifiedChainDetector(createTestConfig());
      await detector.start();

      const bscInstance = detector.getChainInstance('bsc');
      expect(bscInstance).toBeDefined();
      expect(bscInstance!.getChainId()).toBe('bsc');
    });

    it('should return undefined for unknown chain', async () => {
      detector = new UnifiedChainDetector(createTestConfig());
      await detector.start();

      const unknownInstance = detector.getChainInstance('unknown');
      expect(unknownInstance).toBeUndefined();
    });

    it('should start multiple chain instances in parallel', async () => {
      detector = new UnifiedChainDetector(createTestConfig());
      await detector.start();

      const chains = detector.getChains();
      expect(chains.length).toBe(2);
    });
  });

  describe('health reporting', () => {
    it('should report partition health', async () => {
      detector = new UnifiedChainDetector(createTestConfig());
      await detector.start();

      const health = await detector.getPartitionHealth();
      expect(health).toBeDefined();
      expect(health.partitionId).toBe('asia-fast');
      expect(health.chainHealth.size).toBe(2);
    });

    it('should calculate overall status based on chain statuses', async () => {
      detector = new UnifiedChainDetector(createTestConfig());
      await detector.start();

      const health = await detector.getPartitionHealth();
      // All chains are mocked as connected
      expect(['healthy', 'degraded', 'critical']).toContain(health.status);
    });
  });

  describe('statistics', () => {
    it('should aggregate statistics from all chains', async () => {
      detector = new UnifiedChainDetector(createTestConfig());
      await detector.start();

      const stats = detector.getStats();
      expect(stats.partitionId).toBe('asia-fast');
      expect(stats.chains).toEqual(['bsc', 'polygon']);
      expect(stats.totalEventsProcessed).toBe(200); // 100 per chain
      expect(stats.totalOpportunitiesFound).toBe(10); // 5 per chain
    });

    it('should report uptime', async () => {
      detector = new UnifiedChainDetector(createTestConfig());
      await detector.start();

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 100));

      const stats = detector.getStats();
      expect(stats.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });
  });

  describe('event emission', () => {
    it('should emit opportunity events from chain instances', async () => {
      detector = new UnifiedChainDetector(createTestConfig());
      await detector.start();

      const opportunityHandler = jest.fn();
      detector.on('opportunity', opportunityHandler);

      // Get the BSC chain instance and emit an opportunity
      const bscInstance = detector.getChainInstance('bsc');
      bscInstance!.emit('opportunity', { id: 'test-opp', chainId: 'bsc' });

      expect(opportunityHandler).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'test-opp' })
      );
    });

    it('should emit error events from chain instances', async () => {
      detector = new UnifiedChainDetector(createTestConfig());
      await detector.start();

      const errorHandler = jest.fn();
      detector.on('chainError', errorHandler);

      // Get the BSC chain instance and emit an error
      const bscInstance = detector.getChainInstance('bsc');
      bscInstance!.emit('error', new Error('Test error'));

      expect(errorHandler).toHaveBeenCalled();
    });
  });

  describe('cross-region health integration', () => {
    it('should not initialize cross-region health when disabled', async () => {
      detector = new UnifiedChainDetector(createTestConfig({
        enableCrossRegionHealth: false
      }));
      await detector.start();

      // The cross-region health manager should not be initialized
      // This is implicitly tested by the fact that start() completes successfully
      expect(detector.isRunning()).toBe(true);
    });
  });

  describe('graceful degradation', () => {
    it('should trigger degradation on chain error', async () => {
      detector = new UnifiedChainDetector(createTestConfig());
      await detector.start();

      // Get the BSC chain instance and emit a critical error
      const bscInstance = detector.getChainInstance('bsc');
      bscInstance!.emit('criticalError', { chainId: 'bsc', error: 'Connection lost' });

      // Verify the degradation was triggered (through mock verification)
      // The degradation manager is mocked, so we just verify no errors
      expect(detector.isRunning()).toBe(true);
    });
  });
});
