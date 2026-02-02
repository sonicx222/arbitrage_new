/**
 * Unit Tests for Mempool Detector Service
 *
 * Tests the service entry point, configuration, and lifecycle management.
 * The JEST_WORKER_ID guard in index.ts prevents auto-start during import.
 *
 * @see Phase 1: Mempool Detection Service (Implementation Plan v3.0)
 */

import { EventEmitter } from 'events';

// =============================================================================
// Helper: Load service with mocked dependencies
// =============================================================================

interface MockLogger {
  info: jest.Mock;
  error: jest.Mock;
  warn: jest.Mock;
  debug: jest.Mock;
  child: jest.Mock;
}

const createMockLogger = (): MockLogger => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
});

let mockLogger: MockLogger;

// Store result from isolated module
let isolatedModule: {
  createMempoolDetectorService: typeof import('../index').createMempoolDetectorService;
  MempoolDetectorService: typeof import('../index').MempoolDetectorService;
  DEFAULT_CONFIG: typeof import('../index').DEFAULT_CONFIG;
} | null = null;

const loadServiceWithMocks = async () => {
  mockLogger = createMockLogger();
  mockLogger.child.mockReturnValue(mockLogger);

  await jest.isolateModulesAsync(async () => {
    // Mock @arbitrage/core
    // FIX: Add CircularBuffer mock and StreamBatcher for new functionality
    const MockCircularBuffer = class {
      private buffer: any[] = [];
      private _size = 0;
      constructor(private capacity: number) {}
      get size() { return this._size; }
      get isEmpty() { return this._size === 0; }
      push(item: any) { this.buffer.push(item); this._size++; return true; }
      pushOverwrite(item: any) { this.buffer.push(item); if (this._size < this.capacity) this._size++; }
      toArray() { return [...this.buffer]; }
      getStats() { return { size: this._size, capacity: this.capacity, fillRatio: 0, isFull: false, isEmpty: this._size === 0 }; }
    };

    const mockBatcher = {
      add: jest.fn(),
      flush: jest.fn().mockResolvedValue(undefined),
      destroy: jest.fn().mockResolvedValue(undefined),
      getStats: jest.fn().mockReturnValue({ currentQueueSize: 0, totalMessagesQueued: 0, batchesSent: 0, totalMessagesSent: 0, compressionRatio: 1, averageBatchSize: 0 }),
    };

    jest.doMock('@arbitrage/core', () => ({
      createLogger: jest.fn(() => mockLogger),
      CircularBuffer: MockCircularBuffer,
      getRedisClient: jest.fn().mockResolvedValue({ disconnect: jest.fn().mockResolvedValue(undefined) }),
      getRedisStreamsClient: jest.fn().mockResolvedValue({
        xadd: jest.fn().mockResolvedValue('stream-id'),
        createConsumerGroup: jest.fn().mockResolvedValue(undefined),
        createBatcher: jest.fn().mockReturnValue(mockBatcher),
        disconnect: jest.fn().mockResolvedValue(undefined),
      }),
      resetRedisInstance: jest.fn().mockResolvedValue(undefined),
      resetRedisStreamsInstance: jest.fn().mockResolvedValue(undefined),
      RecordingLogger: jest.fn(() => mockLogger),
    }));

    // Mock @arbitrage/config
    jest.doMock('@arbitrage/config', () => ({
      MEMPOOL_CONFIG: {
        enabled: true,
        bloxroute: {
          enabled: true,
          authHeader: 'test-auth',
          wsEndpoint: 'wss://test.blxrbdn.com/ws',
          bscWsEndpoint: 'wss://bsc-test.blxrbdn.com/ws',
          connectionTimeout: 10000,
          heartbeatInterval: 30000,
          reconnect: {
            interval: 1000,
            maxAttempts: 5,
            backoffMultiplier: 2.0,
            maxDelay: 60000,
          },
        },
        service: {
          port: 3007,
          instanceId: 'test-mempool-detector',
          maxBufferSize: 10000,
          batchSize: 100,
          batchTimeoutMs: 50,
        },
        filters: {
          minSwapSizeUsd: 1000,
          includeTraders: [],
          includeRouters: [],
        },
        streams: {
          pendingOpportunities: 'stream:pending-opportunities',
          consumerGroup: 'mempool-detector-group',
          maxStreamLength: 100000,
        },
        chainSettings: {
          ethereum: { enabled: true, feedType: 'bloxroute' },
          bsc: { enabled: true, feedType: 'bloxroute' },
        },
      },
      // FIX: Add KNOWN_ROUTERS mock for swap decoder
      KNOWN_ROUTERS: {
        ethereum: {
          '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': { name: 'Uniswap V2', type: 'uniswapV2' },
          '0xe592427a0aece92de3edee1f18e0157c05861564': { name: 'Uniswap V3', type: 'uniswapV3' },
        },
        bsc: {
          '0x10ed43c718714eb63d5aa57b78b54704e256024e': { name: 'PancakeSwap', type: 'pancakeswap' },
        },
      },
      // FIX: Add chain ID mappings required by DecoderRegistry
      CHAIN_NAME_TO_ID: {
        ethereum: 1,
        bsc: 56,
        polygon: 137,
        arbitrum: 42161,
        optimism: 10,
        base: 8453,
      },
      CHAIN_ID_TO_NAME: {
        1: 'ethereum',
        56: 'bsc',
        137: 'polygon',
        42161: 'arbitrum',
        10: 'optimism',
        8453: 'base',
      },
      NATIVE_TOKENS: {
        ethereum: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        bsc: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
        polygon: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
        arbitrum: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
        optimism: '0x4200000000000000000000000000000000000006',
        base: '0x4200000000000000000000000000000000000006',
      },
      getEnabledMempoolChains: jest.fn().mockReturnValue(['ethereum', 'bsc']),
      isMempoolEnabledForChain: jest.fn().mockReturnValue(true),
      getChainMempoolConfig: jest.fn().mockReturnValue({
        enabled: true,
        feedType: 'bloxroute',
        endpoint: 'wss://test.blxrbdn.com/ws',
        pollIntervalMs: 100,
        expectedLatencyMs: 10,
      }),
    }));

    // Mock bloxroute-feed
    jest.doMock('../bloxroute-feed', () => {
      const { EventEmitter } = require('events');

      class MockBloXrouteFeed extends EventEmitter {
        private _connected = false;

        constructor() {
          super();
          // FIX 4.3: Set maxListeners like the real implementation
          this.setMaxListeners(15);
        }

        async connect(): Promise<void> {
          this._connected = true;
          this.emit('connected');
        }

        disconnect(): void {
          this._connected = false;
          this.emit('disconnected');
        }

        subscribePendingTxs(): void {
          // Mock subscription
        }

        getHealth() {
          return {
            connectionState: this._connected ? 'connected' : 'disconnected',
            lastMessageTime: Date.now(),
            messagesReceived: 0,
            transactionsProcessed: 0,
            decodeSuccesses: 0,
            decodeFailures: 0,
            reconnectCount: 0,
            uptime: 0,
            avgLatencyMs: 0,
          };
        }

        getConfig() {
          return {
            authHeader: 'test-auth',
            endpoint: 'wss://test.blxrbdn.com/ws',
            chains: ['ethereum'],
          };
        }
      }

      return {
        BloXrouteFeed: MockBloXrouteFeed,
        createBloXrouteFeed: jest.fn().mockImplementation(() => new MockBloXrouteFeed()),
      };
    });

    // FIX: Mock decoders module (now using DecoderRegistry directly for hot-path performance)
    jest.doMock('../decoders', () => {
      const mockDecoderRegistry = {
        decode: jest.fn().mockReturnValue(null), // By default, return null (no swap)
        getDecoderForSelector: jest.fn().mockReturnValue(undefined),
        getStats: jest.fn().mockReturnValue({ decoderCount: 4, routerCount: 3, selectorCount: 20, chainCount: 2 }),
      };

      return {
        DecoderRegistry: jest.fn().mockImplementation(() => mockDecoderRegistry),
        createDecoderRegistry: jest.fn().mockReturnValue(mockDecoderRegistry),
        SWAP_FUNCTION_SELECTORS: {},
      };
    });

    // Import after mocking
    const module = await import('../index');
    isolatedModule = {
      createMempoolDetectorService: module.createMempoolDetectorService,
      MempoolDetectorService: module.MempoolDetectorService,
      DEFAULT_CONFIG: module.DEFAULT_CONFIG,
    };
  });

  return isolatedModule!;
};

// =============================================================================
// Tests
// =============================================================================

describe('MempoolDetectorService', () => {
  describe('Module Exports', () => {
    it('should export createMempoolDetectorService', async () => {
      const { createMempoolDetectorService } = await loadServiceWithMocks();
      expect(createMempoolDetectorService).toBeDefined();
      expect(typeof createMempoolDetectorService).toBe('function');
    });

    it('should export MempoolDetectorService class', async () => {
      const { MempoolDetectorService } = await loadServiceWithMocks();
      expect(MempoolDetectorService).toBeDefined();
    });

    it('should export default config', async () => {
      const { DEFAULT_CONFIG } = await loadServiceWithMocks();
      expect(DEFAULT_CONFIG).toBeDefined();
      expect(DEFAULT_CONFIG.healthCheckPort).toBe(3007);
    });
  });

  describe('Service Creation', () => {
    it('should create service with default config', async () => {
      const { createMempoolDetectorService } = await loadServiceWithMocks();
      const service = createMempoolDetectorService();

      expect(service).toBeDefined();
      expect(typeof service.start).toBe('function');
      expect(typeof service.stop).toBe('function');
      expect(typeof service.getHealth).toBe('function');
    });

    it('should create service with custom config', async () => {
      const { createMempoolDetectorService } = await loadServiceWithMocks();
      const service = createMempoolDetectorService({
        instanceId: 'custom-instance',
        chains: ['ethereum'],
        healthCheckPort: 4007,
      });

      expect(service).toBeDefined();
    });

    it('should be an EventEmitter', async () => {
      const { createMempoolDetectorService } = await loadServiceWithMocks();
      const service = createMempoolDetectorService();

      expect(service).toBeInstanceOf(EventEmitter);
      expect(typeof service.on).toBe('function');
      expect(typeof service.emit).toBe('function');
    });
  });

  describe('Service Lifecycle', () => {
    it('should start successfully', async () => {
      const { createMempoolDetectorService } = await loadServiceWithMocks();
      const service = createMempoolDetectorService();
      await service.start();

      const health = service.getHealth();
      expect(health.status).toBe('healthy');
    });

    it('should stop successfully', async () => {
      const { createMempoolDetectorService } = await loadServiceWithMocks();
      const service = createMempoolDetectorService();
      await service.start();
      await service.stop();

      const health = service.getHealth();
      expect(health.status).toBe('unhealthy');
    });

    it('should emit started event on start', async () => {
      const { createMempoolDetectorService } = await loadServiceWithMocks();
      const service = createMempoolDetectorService();
      const startedHandler = jest.fn();
      service.on('started', startedHandler);

      await service.start();

      expect(startedHandler).toHaveBeenCalled();
    });

    it('should emit stopped event on stop', async () => {
      const { createMempoolDetectorService } = await loadServiceWithMocks();
      const service = createMempoolDetectorService();
      const stoppedHandler = jest.fn();
      service.on('stopped', stoppedHandler);

      await service.start();
      await service.stop();

      expect(stoppedHandler).toHaveBeenCalled();
    });

    it('should handle start when already started', async () => {
      const { createMempoolDetectorService } = await loadServiceWithMocks();
      const service = createMempoolDetectorService();
      await service.start();
      await service.start(); // Should not throw

      const health = service.getHealth();
      expect(health.status).toBe('healthy');
    });

    it('should handle stop when not started', async () => {
      const { createMempoolDetectorService } = await loadServiceWithMocks();
      const service = createMempoolDetectorService();

      // Should not throw
      await expect(service.stop()).resolves.not.toThrow();
    });
  });

  describe('Health Reporting', () => {
    it('should return health metrics', async () => {
      const { createMempoolDetectorService } = await loadServiceWithMocks();
      const service = createMempoolDetectorService();
      const health = service.getHealth();

      expect(health).toHaveProperty('instanceId');
      expect(health).toHaveProperty('status');
      expect(health).toHaveProperty('feeds');
      expect(health).toHaveProperty('bufferSize');
      expect(health).toHaveProperty('stats');
      expect(health).toHaveProperty('uptime');
      expect(health).toHaveProperty('timestamp');
    });

    it('should report unhealthy when not started', async () => {
      const { createMempoolDetectorService } = await loadServiceWithMocks();
      const service = createMempoolDetectorService();
      const health = service.getHealth();

      expect(health.status).toBe('unhealthy');
    });

    it('should report healthy when running', async () => {
      const { createMempoolDetectorService } = await loadServiceWithMocks();
      const service = createMempoolDetectorService();
      await service.start();
      const health = service.getHealth();

      expect(health.status).toBe('healthy');
    });

    it('should track statistics', async () => {
      const { createMempoolDetectorService } = await loadServiceWithMocks();
      const service = createMempoolDetectorService();
      await service.start();
      const health = service.getHealth();

      expect(health.stats).toHaveProperty('txReceived');
      expect(health.stats).toHaveProperty('txDecoded');
      expect(health.stats).toHaveProperty('opportunitiesPublished');
      expect(health.stats).toHaveProperty('latencyP50');
      expect(health.stats).toHaveProperty('latencyP99');
    });
  });

  describe('Error Handling', () => {
    it('should emit error events on feed errors', async () => {
      const { createMempoolDetectorService } = await loadServiceWithMocks();
      const service = createMempoolDetectorService();
      const errorHandler = jest.fn();
      service.on('error', errorHandler);

      await service.start();

      // Simulate feed error
      service.simulateFeedError(new Error('Feed connection lost'));

      expect(errorHandler).toHaveBeenCalled();
    });

    it('should log errors without crashing', async () => {
      const { createMempoolDetectorService } = await loadServiceWithMocks();
      const service = createMempoolDetectorService();

      // Add error handler to prevent unhandled error
      service.on('error', jest.fn());

      await service.start();

      // Simulate various errors
      service.simulateFeedError(new Error('Connection error'));

      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('JEST_WORKER_ID Guard', () => {
    it('should not auto-start when JEST_WORKER_ID is set', async () => {
      expect(process.env.JEST_WORKER_ID).toBeDefined();
      const { createMempoolDetectorService } = await loadServiceWithMocks();
      expect(createMempoolDetectorService).toBeDefined();
    });
  });
});

describe('Environment Variable Handling', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, JEST_WORKER_ID: 'test', NODE_ENV: 'test' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should handle MEMPOOL_DETECTOR_PORT env var', async () => {
    process.env.MEMPOOL_DETECTOR_PORT = '4007';
    const { createMempoolDetectorService } = await loadServiceWithMocks();

    const service = createMempoolDetectorService();
    const health = service.getHealth();

    expect(health.instanceId).toBeDefined();
  });

  it('should handle MEMPOOL_INSTANCE_ID env var', async () => {
    process.env.MEMPOOL_INSTANCE_ID = 'custom-mempool-instance';
    const { createMempoolDetectorService } = await loadServiceWithMocks();

    const service = createMempoolDetectorService();
    const health = service.getHealth();

    expect(health.instanceId).toBeDefined();
  });
});
