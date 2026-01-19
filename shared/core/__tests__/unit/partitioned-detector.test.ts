/**
 * PartitionedDetector Tests
 *
 * TDD-first tests for the PartitionedDetector base class.
 * Tests multi-chain management, lifecycle, health aggregation, and failover.
 *
 * @see ADR-003: Partitioned Chain Detectors
 * @see S3.1.1: Create PartitionedDetector base class
 *
 * @migrated from shared/core/src/partitioned-detector.test.ts
 * @see ADR-009: Test Architecture
 */

import { EventEmitter } from 'events';

// RecordingLogger will be imported dynamically to avoid hoisting issues
// The instance is created and exported for use in tests
let recordingLogger: any;

const mockPerfLogger = {
  logEventLatency: jest.fn(),
  logHealthCheck: jest.fn(),
  logArbitrageOpportunity: jest.fn()
};

const mockRedisClient = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  disconnect: jest.fn(),
  updateServiceHealth: jest.fn(),
  subscribe: jest.fn(),
  publish: jest.fn()
};

const mockStreamsClient = {
  xadd: jest.fn(() => Promise.resolve('0-0')),
  xread: jest.fn(() => Promise.resolve([])),
  disconnect: jest.fn(() => Promise.resolve()),
  createBatcher: jest.fn(() => ({
    add: jest.fn(),
    flush: jest.fn(() => Promise.resolve()),
    destroy: jest.fn(() => Promise.resolve()),
    getStats: jest.fn(() => ({ pending: 0, flushed: 0 }))
  })),
  STREAMS: {
    PRICE_UPDATES: 'stream:price-updates',
    OPPORTUNITIES: 'stream:opportunities',
    SWAP_EVENTS: 'stream:swap-events',
    WHALE_ALERTS: 'stream:whale-alerts'
  }
};

// Mock WebSocket manager
class MockWebSocketManager extends EventEmitter {
  public url: string;
  public connected = false;

  constructor(config: { url: string }) {
    super();
    this.url = config.url;
  }

  async connect(): Promise<void> {
    this.connected = true;
    this.emit('connected');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.emit('disconnected');
  }

  subscribe(subscription: any): void {
    // Mock subscription
  }

  onMessage(callback: (msg: any) => void): void {
    this.on('message', callback);
  }

  getConnectionStats() {
    return { connected: this.connected, reconnects: 0 };
  }
}

jest.mock('../../src/logger', () => ({
  createLogger: jest.fn(() => {
    // Return the recording logger at call time, not at mock setup time
    return recordingLogger;
  }),
  getPerformanceLogger: jest.fn(() => mockPerfLogger)
}));

jest.mock('../../src/redis', () => ({
  getRedisClient: jest.fn(() => Promise.resolve(mockRedisClient)),
  RedisClient: jest.fn()
}));

jest.mock('../../src/redis-streams', () => ({
  getRedisStreamsClient: jest.fn(() => Promise.resolve(mockStreamsClient)),
  RedisStreamsClient: {
    STREAMS: mockStreamsClient.STREAMS
  }
}));

jest.mock('../../src/websocket-manager', () => ({
  WebSocketManager: MockWebSocketManager
}));

// Mock chain config - mock both package alias and relative path
// Since PartitionedDetector imports from '../../config/src', we need to mock that path too
const mockConfig = {
  CHAINS: {
    ethereum: {
      id: 1,
      name: 'Ethereum',
      rpcUrl: 'https://eth.example.com',
      wsUrl: 'wss://eth.example.com',
      blockTime: 12,
      nativeToken: 'ETH'
    },
    bsc: {
      id: 56,
      name: 'BSC',
      rpcUrl: 'https://bsc.example.com',
      wsUrl: 'wss://bsc.example.com',
      blockTime: 3,
      nativeToken: 'BNB'
    },
    polygon: {
      id: 137,
      name: 'Polygon',
      rpcUrl: 'https://polygon.example.com',
      wsUrl: 'wss://polygon.example.com',
      blockTime: 2,
      nativeToken: 'MATIC'
    }
  },
  CORE_TOKENS: {
    ethereum: [{ symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' }],
    bsc: [{ symbol: 'WBNB', address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' }],
    polygon: [{ symbol: 'WMATIC', address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270' }]
  },
  getEnabledDexes: jest.fn((chain: string) => [
    { name: `${chain}-dex`, factoryAddress: '0x123', enabled: true, fee: 30 }
  ]),
  DETECTOR_CONFIG: {
    ethereum: { confidence: 0.9, expiryMs: 5000, gasEstimate: 200000 },
    bsc: { confidence: 0.85, expiryMs: 3000, gasEstimate: 150000 },
    polygon: { confidence: 0.85, expiryMs: 3000, gasEstimate: 100000 }
  },
  EVENT_SIGNATURES: {
    SYNC: '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1',
    SWAP_V2: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'
  },
  ARBITRAGE_CONFIG: {
    minProfitPercentage: 0.003,
    chainMinProfits: { ethereum: 0.005, bsc: 0.003, polygon: 0.003 }
  },
  TOKEN_METADATA: {},
  // S3.2.4-FIX: Add normalizeTokenForCrossChain to mock for cross-chain detection tests
  normalizeTokenForCrossChain: jest.fn((symbol: string) => {
    const upper = symbol.toUpperCase().trim();
    const aliases: Record<string, string> = {
      'FUSDT': 'USDT', 'WFTM': 'FTM', 'WAVAX': 'AVAX',
      'WETH.E': 'WETH', 'WBTC.E': 'WBTC', 'USDT.E': 'USDT',
      'WBNB': 'BNB', 'BTCB': 'WBTC', 'ETH': 'WETH',
      'WMATIC': 'MATIC', 'WETH': 'WETH', 'WBTC': 'WBTC'
    };
    return aliases[upper] || upper;
  })
};

// Mock both package alias and relative path used by PartitionedDetector
jest.mock('@arbitrage/config', () => mockConfig);
jest.mock('../../../config/src', () => mockConfig);

// Import after mocks
import { PartitionedDetector, PartitionedDetectorConfig, ChainHealth, PartitionHealth, PartitionedDetectorDeps, PartitionedDetectorLogger, TokenNormalizeFn, RecordingLogger } from '@arbitrage/core';

// Initialize the recording logger after imports
recordingLogger = new RecordingLogger();

// =============================================================================
// DI Helper (P16 pattern - uses DI instead of Jest mock hoisting)
// =============================================================================

/**
 * Mock token normalizer for cross-chain matching tests.
 * Maps chain-specific token symbols to their canonical form.
 */
const mockNormalizeToken: TokenNormalizeFn = (symbol: string) => {
  const upper = symbol.toUpperCase().trim();
  const aliases: Record<string, string> = {
    'FUSDT': 'USDT', 'WFTM': 'FTM', 'WAVAX': 'AVAX',
    'WETH.E': 'WETH', 'WBTC.E': 'WBTC', 'USDT.E': 'USDT',
    'WBNB': 'BNB', 'BTCB': 'WBTC', 'ETH': 'WETH',
    'WMATIC': 'MATIC', 'WETH': 'WETH', 'WBTC': 'WBTC',
    'USDC': 'USDC', 'USDT': 'USDT', 'DAI': 'DAI'
  };
  return aliases[upper] || upper;
};

/**
 * Creates mock dependencies for PartitionedDetector tests.
 * This uses the DI pattern to inject mocks instead of relying on Jest mock hoisting.
 */
const createMockDetectorDeps = (): PartitionedDetectorDeps => ({
  logger: recordingLogger as unknown as PartitionedDetectorLogger,
  perfLogger: mockPerfLogger as any,
  normalizeToken: mockNormalizeToken
});

describe('PartitionedDetector', () => {
  let detector: PartitionedDetector;
  let defaultConfig: PartitionedDetectorConfig;

  beforeEach(() => {
    jest.clearAllMocks();
    recordingLogger.clear();

    defaultConfig = {
      partitionId: 'test-partition',
      chains: ['ethereum', 'bsc'],
      region: 'asia-southeast1',
      healthCheckIntervalMs: 10000,
      failoverTimeoutMs: 30000
    };

    detector = new PartitionedDetector(defaultConfig, createMockDetectorDeps());
  });

  afterEach(async () => {
    if (detector) {
      await detector.stop();
    }
  });

  // ===========================================================================
  // Constructor Tests
  // ===========================================================================

  describe('constructor', () => {
    it('should initialize with partition configuration', () => {
      expect(detector.getPartitionId()).toBe('test-partition');
      expect(detector.getChains()).toEqual(['ethereum', 'bsc']);
      expect(detector.getRegion()).toBe('asia-southeast1');
    });

    it('should throw if no chains provided', () => {
      expect(() => new PartitionedDetector({
        ...defaultConfig,
        chains: []
      }, createMockDetectorDeps())).toThrow('At least one chain must be specified');
    });

    it('should throw if invalid chain provided', () => {
      expect(() => new PartitionedDetector({
        ...defaultConfig,
        chains: ['ethereum', 'invalid-chain']
      }, createMockDetectorDeps())).toThrow('Invalid chain: invalid-chain');
    });

    it('should set default health check interval if not provided', () => {
      const config = { ...defaultConfig };
      delete config.healthCheckIntervalMs;
      const det = new PartitionedDetector(config, createMockDetectorDeps());
      expect(det['config'].healthCheckIntervalMs).toBe(15000);
    });

    it('should set default failover timeout if not provided', () => {
      const config = { ...defaultConfig };
      delete config.failoverTimeoutMs;
      const det = new PartitionedDetector(config, createMockDetectorDeps());
      expect(det['config'].failoverTimeoutMs).toBe(60000);
    });
  });

  // ===========================================================================
  // Lifecycle Tests
  // ===========================================================================

  describe('start', () => {
    it('should start all chain connections', async () => {
      await detector.start();

      expect(detector.isRunning()).toBe(true);
      expect(recordingLogger.hasLogMatching('info', /Starting PartitionedDetector/)).toBe(true);
    });

    it('should initialize Redis and Streams clients', async () => {
      const { getRedisClient } = require('../../src/redis');
      const { getRedisStreamsClient } = require('../../src/redis-streams');

      await detector.start();

      expect(getRedisClient).toHaveBeenCalled();
      expect(getRedisStreamsClient).toHaveBeenCalled();
    });

    it('should create WebSocket manager for each chain', async () => {
      await detector.start();

      const chainManagers = detector.getChainManagers();
      expect(chainManagers.size).toBe(2);
      expect(chainManagers.has('ethereum')).toBe(true);
      expect(chainManagers.has('bsc')).toBe(true);
    });

    it('should not start if already running', async () => {
      await detector.start();
      await detector.start();

      expect(recordingLogger.hasLogMatching('warn', 'PartitionedDetector already running')).toBe(true);
    });

    it('should wait for pending stop before starting', async () => {
      await detector.start();

      // Start stop and immediately try to start again
      const stopPromise = detector.stop();
      const startPromise = detector.start();

      await stopPromise;
      await startPromise;

      expect(detector.isRunning()).toBe(true);
    });

    it('should emit started event', async () => {
      const startedHandler = jest.fn();
      detector.on('started', startedHandler);

      await detector.start();

      expect(startedHandler).toHaveBeenCalledWith({
        partitionId: 'test-partition',
        chains: ['ethereum', 'bsc']
      });
    });
  });

  describe('stop', () => {
    it('should stop all chain connections', async () => {
      await detector.start();
      await detector.stop();

      expect(detector.isRunning()).toBe(false);
      expect(recordingLogger.hasLogMatching('info', /Stopping PartitionedDetector/)).toBe(true);
    });

    it('should disconnect all WebSocket managers', async () => {
      await detector.start();
      const chainManagers = detector.getChainManagers();

      await detector.stop();

      // Verify all managers disconnected
      expect(detector.getChainManagers().size).toBe(0);
    });

    it('should not stop if not running', async () => {
      await detector.stop();

      expect(recordingLogger.hasLogMatching('debug', 'PartitionedDetector not running')).toBe(true);
    });

    it('should return existing promise if stop already in progress', async () => {
      await detector.start();

      // Both stop calls should complete successfully without errors
      // The second call should wait for the first one
      const stop1 = detector.stop();
      const stop2 = detector.stop();

      // Both should resolve to void (no error)
      await expect(Promise.all([stop1, stop2])).resolves.not.toThrow();

      // Detector should be stopped
      expect(detector.isRunning()).toBe(false);
    });

    it('should emit stopped event', async () => {
      const stoppedHandler = jest.fn();
      detector.on('stopped', stoppedHandler);

      await detector.start();
      await detector.stop();

      expect(stoppedHandler).toHaveBeenCalledWith({
        partitionId: 'test-partition'
      });
    });

    it('should cleanup health monitoring interval', async () => {
      await detector.start();

      // Health monitoring should be active
      expect(detector['healthMonitoringInterval']).not.toBeNull();

      await detector.stop();

      expect(detector['healthMonitoringInterval']).toBeNull();
    });
  });

  // ===========================================================================
  // Multi-Chain Management Tests
  // ===========================================================================

  describe('multi-chain management', () => {
    it('should handle chain connection failure gracefully', async () => {
      // Make bsc connection fail
      const { WebSocketManager } = require('../../src/websocket-manager');
      const originalConnect = MockWebSocketManager.prototype.connect;

      let connectionAttempts = 0;
      MockWebSocketManager.prototype.connect = async function() {
        connectionAttempts++;
        if (this.url.includes('bsc')) {
          throw new Error('Connection failed');
        }
        return originalConnect.call(this);
      };

      await detector.start();

      // Ethereum should still be connected
      const health = detector.getPartitionHealth();
      expect(health.chainHealth.get('ethereum')?.status).toBe('healthy');
      expect(health.chainHealth.get('bsc')?.status).toBe('unhealthy');

      // Restore
      MockWebSocketManager.prototype.connect = originalConnect;
    });

    it('should track events per chain', async () => {
      await detector.start();

      // Simulate events
      detector['chainStats'].set('ethereum', {
        eventsProcessed: 100,
        lastBlockNumber: 12345,
        lastBlockTimestamp: Date.now()
      });
      detector['chainStats'].set('bsc', {
        eventsProcessed: 200,
        lastBlockNumber: 67890,
        lastBlockTimestamp: Date.now()
      });

      const health = detector.getPartitionHealth();
      expect(health.totalEventsProcessed).toBe(300);
    });

    it('should support adding chain at runtime', async () => {
      await detector.start();

      await detector.addChain('polygon');

      expect(detector.getChains()).toContain('polygon');
      expect(detector.getChainManagers().has('polygon')).toBe(true);
    });

    it('should support removing chain at runtime', async () => {
      await detector.start();

      await detector.removeChain('bsc');

      expect(detector.getChains()).not.toContain('bsc');
      expect(detector.getChainManagers().has('bsc')).toBe(false);
    });

    it('should not allow removing last chain', async () => {
      const singleChainDetector = new PartitionedDetector({
        ...defaultConfig,
        chains: ['ethereum']
      }, createMockDetectorDeps());

      await singleChainDetector.start();

      await expect(singleChainDetector.removeChain('ethereum'))
        .rejects.toThrow('Cannot remove last chain from partition');

      await singleChainDetector.stop();
    });
  });

  // ===========================================================================
  // Health Aggregation Tests
  // ===========================================================================

  describe('health aggregation', () => {
    it('should aggregate health from all chains', async () => {
      await detector.start();

      const health = detector.getPartitionHealth();

      expect(health.partitionId).toBe('test-partition');
      expect(health.chainHealth.size).toBe(2);
      expect(health.chainHealth.has('ethereum')).toBe(true);
      expect(health.chainHealth.has('bsc')).toBe(true);
    });

    it('should report healthy when all chains healthy', async () => {
      await detector.start();

      // Both chains connected
      const health = detector.getPartitionHealth();
      expect(health.status).toBe('healthy');
    });

    it('should report degraded when some chains unhealthy', async () => {
      await detector.start();

      // Mark one chain as unhealthy
      detector['chainHealth'].set('bsc', {
        chainId: 'bsc',
        status: 'unhealthy',
        wsConnected: false,
        blocksBehind: 100,
        lastBlockTime: Date.now() - 60000,
        eventsPerSecond: 0,
        errorCount: 5
      });

      const health = detector.getPartitionHealth();
      expect(health.status).toBe('degraded');
    });

    it('should report unhealthy when all chains unhealthy', async () => {
      await detector.start();

      // Mark all chains as unhealthy
      for (const chainId of detector.getChains()) {
        detector['chainHealth'].set(chainId, {
          chainId,
          status: 'unhealthy',
          wsConnected: false,
          blocksBehind: 100,
          lastBlockTime: Date.now() - 60000,
          eventsPerSecond: 0,
          errorCount: 5
        });
      }

      const health = detector.getPartitionHealth();
      expect(health.status).toBe('unhealthy');
    });

    it('should calculate average event latency', async () => {
      await detector.start();

      // Set latency stats
      detector['eventLatencies'] = [10, 20, 30, 40, 50];

      const health = detector.getPartitionHealth();
      expect(health.avgEventLatencyMs).toBe(30);
    });

    it('should track memory usage', async () => {
      await detector.start();

      const health = detector.getPartitionHealth();
      expect(health.memoryUsage).toBeGreaterThan(0);
    });

    it('should track uptime', async () => {
      await detector.start();

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 100));

      const health = detector.getPartitionHealth();
      expect(health.uptimeSeconds).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Event Handling Tests
  // ===========================================================================

  describe('event handling', () => {
    it('should emit chainConnected when chain connects', async () => {
      const handler = jest.fn();
      detector.on('chainConnected', handler);

      await detector.start();

      expect(handler).toHaveBeenCalledWith({ chainId: 'ethereum' });
      expect(handler).toHaveBeenCalledWith({ chainId: 'bsc' });
    });

    it('should emit chainDisconnected when chain disconnects', async () => {
      const handler = jest.fn();
      detector.on('chainDisconnected', handler);

      await detector.start();

      // Simulate disconnect using EventEmitter cast
      const wsManager = detector.getChainManagers().get('ethereum') as unknown as EventEmitter;
      wsManager?.emit('disconnected');

      expect(handler).toHaveBeenCalledWith({ chainId: 'ethereum' });
    });

    it('should emit chainError when chain has error', async () => {
      const handler = jest.fn();
      detector.on('chainError', handler);

      await detector.start();

      // Simulate error using EventEmitter cast
      const wsManager = detector.getChainManagers().get('ethereum') as unknown as EventEmitter;
      wsManager?.emit('error', new Error('Test error'));

      expect(handler).toHaveBeenCalledWith({
        chainId: 'ethereum',
        error: expect.any(Error)
      });
    });

    it('should emit healthUpdate periodically', async () => {
      const handler = jest.fn();
      detector.on('healthUpdate', handler);

      // Short health check interval for testing
      detector['config'].healthCheckIntervalMs = 50;

      await detector.start();

      // Wait for health check
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(handler).toHaveBeenCalled();

      await detector.stop();
    });
  });

  // ===========================================================================
  // Cross-Chain Arbitrage Tests
  // ===========================================================================

  describe('cross-chain price tracking', () => {
    it('should aggregate prices across chains', async () => {
      await detector.start();

      // Simulate price updates
      detector['chainPrices'].set('ethereum', new Map([
        ['WETH_USDC', { price: 2500, timestamp: Date.now() }]
      ]));
      detector['chainPrices'].set('bsc', new Map([
        ['WETH_USDC', { price: 2510, timestamp: Date.now() }]
      ]));

      const prices = detector.getCrossChainPrices('WETH_USDC');
      expect(prices.size).toBe(2);
      expect(prices.get('ethereum')?.price).toBe(2500);
      expect(prices.get('bsc')?.price).toBe(2510);
    });

    it('should identify cross-chain price discrepancies', async () => {
      await detector.start();

      // Set up price discrepancy
      detector['chainPrices'].set('ethereum', new Map([
        ['WETH_USDC', { price: 2500, timestamp: Date.now() }]
      ]));
      detector['chainPrices'].set('bsc', new Map([
        ['WETH_USDC', { price: 2600, timestamp: Date.now() }] // 4% difference
      ]));

      const discrepancies = detector.findCrossChainDiscrepancies(0.01); // 1% threshold
      expect(discrepancies.length).toBeGreaterThan(0);
      expect(discrepancies[0].pairKey).toBe('WETH_USDC');
      expect(discrepancies[0].chains).toContain('ethereum');
      expect(discrepancies[0].chains).toContain('bsc');
    });
  });

  // ===========================================================================
  // Graceful Degradation Tests
  // ===========================================================================

  describe('graceful degradation', () => {
    it('should continue operating with partial chain failures', async () => {
      await detector.start();

      // Simulate ethereum failing
      detector['chainHealth'].set('ethereum', {
        chainId: 'ethereum',
        status: 'unhealthy',
        wsConnected: false,
        blocksBehind: 100,
        lastBlockTime: Date.now() - 60000,
        eventsPerSecond: 0,
        errorCount: 5
      });

      // Should still be running
      expect(detector.isRunning()).toBe(true);
      expect(detector.getHealthyChains()).toContain('bsc');
      expect(detector.getHealthyChains()).not.toContain('ethereum');
    });

    it('should attempt reconnection for failed chains', async () => {
      await detector.start();

      // Simulate disconnect using EventEmitter cast
      const wsManager = detector.getChainManagers().get('ethereum') as unknown as EventEmitter;
      wsManager?.emit('disconnected');

      // Should trigger reconnection logic
      expect(recordingLogger.getLogs('warn').length).toBeGreaterThan(0);
    });
  });
});

describe('PartitionedDetector - Edge Cases', () => {
  let detector: PartitionedDetector;

  afterEach(async () => {
    if (detector) {
      await detector.stop();
    }
  });

  it('should handle rapid start/stop cycles', async () => {
    detector = new PartitionedDetector({
      partitionId: 'test',
      chains: ['ethereum'],
      region: 'asia-southeast1'
    }, createMockDetectorDeps());

    // Rapid cycles
    for (let i = 0; i < 5; i++) {
      await detector.start();
      await detector.stop();
    }

    expect(detector.isRunning()).toBe(false);
  });

  it('should handle concurrent start calls', async () => {
    detector = new PartitionedDetector({
      partitionId: 'test',
      chains: ['ethereum'],
      region: 'asia-southeast1'
    }, createMockDetectorDeps());

    // Concurrent starts
    const starts = await Promise.all([
      detector.start(),
      detector.start(),
      detector.start()
    ]);

    expect(detector.isRunning()).toBe(true);
  });

  it('should handle concurrent stop calls', async () => {
    detector = new PartitionedDetector({
      partitionId: 'test',
      chains: ['ethereum'],
      region: 'asia-southeast1'
    }, createMockDetectorDeps());

    await detector.start();

    // Concurrent stops
    await Promise.all([
      detector.stop(),
      detector.stop(),
      detector.stop()
    ]);

    expect(detector.isRunning()).toBe(false);
  });

  it('should cleanup resources on error during start', async () => {
    const { getRedisClient } = require('../../src/redis');
    getRedisClient.mockRejectedValueOnce(new Error('Redis connection failed'));

    detector = new PartitionedDetector({
      partitionId: 'test',
      chains: ['ethereum'],
      region: 'asia-southeast1'
    }, createMockDetectorDeps());

    await expect(detector.start()).rejects.toThrow('Redis connection failed');
    expect(detector.isRunning()).toBe(false);
  });
});
