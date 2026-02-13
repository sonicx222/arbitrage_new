/**
 * Cross-Chain Detector Service - Lifecycle & Core Method Tests (FIX #3/#4)
 *
 * Tests the actual CrossChainDetectorService class:
 * - start() / stop() lifecycle management
 * - findArbitrageInPrices() core detection algorithm
 * - detectWhaleInducedOpportunities() whale-triggered detection
 *
 * These tests instantiate the real class with mocked dependencies,
 * unlike detector.test.ts which tests inline logic copies.
 *
 * @see Finding #3/#4 in cross-chain-detector-deep-analysis.md
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Set required environment variables BEFORE any config imports
process.env.NODE_ENV = 'test';
process.env.ETHEREUM_RPC_URL = 'https://eth.llamarpc.com';
process.env.ETHEREUM_WS_URL = 'wss://eth.llamarpc.com';
process.env.BSC_RPC_URL = 'https://bsc-dataseed.binance.org';
process.env.BSC_WS_URL = 'wss://bsc-dataseed.binance.org';
process.env.POLYGON_RPC_URL = 'https://polygon-rpc.com';
process.env.POLYGON_WS_URL = 'wss://polygon-rpc.com';
process.env.ARBITRUM_RPC_URL = 'https://arb1.arbitrum.io/rpc';
process.env.ARBITRUM_WS_URL = 'wss://arb1.arbitrum.io/rpc';
process.env.OPTIMISM_RPC_URL = 'https://mainnet.optimism.io';
process.env.OPTIMISM_WS_URL = 'wss://mainnet.optimism.io';
process.env.BASE_RPC_URL = 'https://mainnet.base.org';
process.env.BASE_WS_URL = 'wss://mainnet.base.org';
process.env.REDIS_URL = 'redis://localhost:6379';

// =============================================================================
// Mock Setup
// =============================================================================

// Factory functions for mock objects that are reset in beforeEach.
// jest.clearAllMocks() wipes mockReturnValue/mockResolvedValue on all jest.fn()
// instances, so these must be re-created each test.

const createMockRedisClient = () => ({
  disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  updateServiceHealth: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  get: jest.fn<() => Promise<string | null>>().mockResolvedValue(null),
  set: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
});

const createMockStreamsClient = () => ({
  disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  xreadgroup: jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
  xack: jest.fn<() => Promise<number>>().mockResolvedValue(1),
  xaddWithLimit: jest.fn<() => Promise<string>>().mockResolvedValue('stream-id'),
  createConsumerGroup: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
});

const createMockPriceOracle = () => ({
  getPrice: jest.fn<any>().mockResolvedValue({ price: 3000, isStale: false, source: 'mock' }),
});

const createMockWhaleTracker = () => ({
  recordTransaction: jest.fn(),
  getActivitySummary: jest.fn().mockReturnValue({
    dominantDirection: 'neutral',
    buyVolumeUsd: 0,
    sellVolumeUsd: 0,
    superWhaleCount: 0,
    netFlowUsd: 0,
    transactionCount: 0,
    recentTransactions: [],
  }),
});

// Mock ServiceStateManager that actually tracks state
const createMockStateManager = () => {
  let state = 'STOPPED';
  return {
    getState: jest.fn(() => state),
    isRunning: jest.fn(() => state === 'RUNNING'),
    executeStart: jest.fn(async (fn: () => Promise<void>) => {
      if (state !== 'STOPPED') {
        return { success: false, error: new Error(`Cannot start from state ${state}`) };
      }
      state = 'STARTING';
      try {
        await fn();
        state = 'RUNNING';
        return { success: true };
      } catch (error) {
        state = 'ERROR';
        return { success: false, error };
      }
    }),
    executeStop: jest.fn(async (fn: () => Promise<void>) => {
      if (state !== 'RUNNING' && state !== 'ERROR') {
        return { success: false, error: new Error(`Cannot stop from state ${state}`) };
      }
      state = 'STOPPING';
      try {
        await fn();
        state = 'STOPPED';
        return { success: true };
      } catch (error) {
        state = 'ERROR';
        return { success: false, error };
      }
    }),
  };
};

// Mock StreamConsumer (EventEmitter-like)
const createMockStreamConsumer = () => ({
  createConsumerGroups: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  start: jest.fn(),
  stop: jest.fn(),
  on: jest.fn(),
  removeAllListeners: jest.fn(),
  emit: jest.fn(),
});

// Mock PriceDataManager
const createMockPriceDataManager = () => ({
  handlePriceUpdate: jest.fn(),
  getPairCount: jest.fn().mockReturnValue(0),
  getChains: jest.fn().mockReturnValue([]),
  createIndexedSnapshot: jest.fn().mockReturnValue({
    tokenPairs: [],
    byToken: new Map(),
    byChain: new Map(),
    timestamp: Date.now(),
  }),
  createSnapshot: jest.fn().mockReturnValue([]),
  clear: jest.fn(),
});

// Mock OpportunityPublisher
const createMockOpportunityPublisher = () => ({
  publish: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  getCacheSize: jest.fn().mockReturnValue(0),
  cleanup: jest.fn(),
  clear: jest.fn(),
});

// Mock BridgeCostEstimator
const createMockBridgeCostEstimator = () => ({
  estimateBridgeCost: jest.fn().mockReturnValue(0.001),
  getDetailedEstimate: jest.fn().mockReturnValue({
    costEth: 0.001,
    costUsd: 3,
    predictedLatency: 120,
    reliability: 0.95,
  }),
  extractTokenAmount: jest.fn().mockReturnValue(1000),
  updateEthPrice: jest.fn(),
  getEthPrice: jest.fn().mockReturnValue(3000),
});

// Mock MLPredictionManager
// initialize() returns boolean (true=success, false=failure)
const createMockMLPredictionManager = () => ({
  initialize: jest.fn<any>().mockResolvedValue(true),
  isReady: jest.fn().mockReturnValue(false),
  trackPriceUpdate: jest.fn(),
  prefetchPredictions: jest.fn<() => Promise<Map<string, any>>>().mockResolvedValue(new Map()),
  getCachedPrediction: jest.fn().mockReturnValue(null),
  cleanup: jest.fn(),
  clear: jest.fn(),
});

let mockRedisClient = createMockRedisClient();
let mockStreamsClient = createMockStreamsClient();
let mockPriceOracle = createMockPriceOracle();
let mockWhaleTracker = createMockWhaleTracker();
let mockStreamConsumer = createMockStreamConsumer();
let mockPriceDataManager = createMockPriceDataManager();
let mockOpportunityPublisher = createMockOpportunityPublisher();
let mockBridgeCostEstimator = createMockBridgeCostEstimator();
let mockMLPredictionManager = createMockMLPredictionManager();
let mockStateManager = createMockStateManager();

// Mock @arbitrage/core
// The createLogger mock must return a working logger immediately because
// it's called during class field initialization (before any test code runs).
// We create a shared logger/perfLogger object that tests can spy on.
const sharedMockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};
const sharedMockPerfLogger = {
  startTimer: jest.fn().mockReturnValue({ stop: jest.fn() }),
  recordMetric: jest.fn(),
  getMetrics: jest.fn().mockReturnValue({}),
};

jest.mock('@arbitrage/core', () => ({
  getRedisClient: jest.fn<any>(),
  getRedisStreamsClient: jest.fn<any>(),
  getPriceOracle: jest.fn<any>(),
  getWhaleActivityTracker: jest.fn<any>(),
  createLogger: jest.fn(() => sharedMockLogger),
  getPerformanceLogger: jest.fn(() => sharedMockPerfLogger),
  createServiceState: jest.fn<any>(),
  disconnectWithTimeout: jest.fn<any>().mockResolvedValue(undefined),
  clearIntervalSafe: jest.fn((interval: any) => {
    if (interval) clearInterval(interval);
    return null;
  }),
  OperationGuard: jest.fn().mockImplementation(() => ({
    tryAcquire: jest.fn().mockReturnValue(true),
    release: jest.fn(),
    forceRelease: jest.fn(),
  })),
  RedisStreamsClient: {
    STREAMS: {
      PRICE_UPDATES: 'stream:price-updates',
      SWAP_EVENTS: 'stream:swap-events',
      OPPORTUNITIES: 'stream:opportunities',
      WHALE_ALERTS: 'stream:whale-alerts',
      PENDING_OPPORTUNITIES: 'stream:pending-opportunities',
    },
  },
  RecordingLogger: jest.fn(),
}));

// Mock @arbitrage/ml
jest.mock('@arbitrage/ml', () => ({
  getLSTMPredictor: jest.fn(() => ({
    isReady: jest.fn().mockReturnValue(false),
    predictPrice: jest.fn<any>().mockResolvedValue(null),
  })),
}));

// Mock internal modules
jest.mock('../../stream-consumer', () => ({
  createStreamConsumer: jest.fn(() => mockStreamConsumer),
}));

jest.mock('../../price-data-manager', () => ({
  createPriceDataManager: jest.fn(() => mockPriceDataManager),
}));

jest.mock('../../opportunity-publisher', () => ({
  createOpportunityPublisher: jest.fn(() => mockOpportunityPublisher),
}));

jest.mock('../../bridge-cost-estimator', () => ({
  createBridgeCostEstimator: jest.fn(() => mockBridgeCostEstimator),
}));

jest.mock('../../ml-prediction-manager', () => ({
  createMLPredictionManager: jest.fn(() => mockMLPredictionManager),
}));

// Import after mocks are set up
import { CrossChainDetectorService } from '../../detector';
import { getRedisClient, getRedisStreamsClient, getPriceOracle, disconnectWithTimeout } from '@arbitrage/core';
import { ARBITRAGE_CONFIG } from '@arbitrage/config';
import { createStreamConsumer } from '../../stream-consumer';
import { createPriceDataManager } from '../../price-data-manager';
import { createOpportunityPublisher } from '../../opportunity-publisher';
import { createBridgeCostEstimator } from '../../bridge-cost-estimator';
import { createMLPredictionManager } from '../../ml-prediction-manager';

// =============================================================================
// Tests
// =============================================================================

describe('CrossChainDetectorService', () => {
  let service: CrossChainDetectorService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Restore shared mock functions after clearAllMocks
    sharedMockLogger.info = jest.fn();
    sharedMockLogger.warn = jest.fn();
    sharedMockLogger.error = jest.fn();
    sharedMockLogger.debug = jest.fn();
    sharedMockPerfLogger.startTimer = jest.fn().mockReturnValue({ stop: jest.fn() });
    sharedMockPerfLogger.recordMetric = jest.fn();
    sharedMockPerfLogger.getMetrics = jest.fn().mockReturnValue({});

    // Re-create ALL mock objects (clearAllMocks wipes their implementations)
    mockRedisClient = createMockRedisClient();
    mockStreamsClient = createMockStreamsClient();
    mockPriceOracle = createMockPriceOracle();
    mockWhaleTracker = createMockWhaleTracker();
    mockStreamConsumer = createMockStreamConsumer();
    mockPriceDataManager = createMockPriceDataManager();
    mockOpportunityPublisher = createMockOpportunityPublisher();
    mockBridgeCostEstimator = createMockBridgeCostEstimator();
    mockMLPredictionManager = createMockMLPredictionManager();
    mockStateManager = createMockStateManager();

    // Wire up @arbitrage/core mocks that need to return specific values
    // NOTE: setupTests.ts calls jest.resetAllMocks() in afterEach, which clears
    // all mockImplementation/mockReturnValue. We must re-wire EVERYTHING here.
    const core = jest.requireMock('@arbitrage/core') as any;
    core.getRedisClient.mockResolvedValue(mockRedisClient);
    core.getRedisStreamsClient.mockResolvedValue(mockStreamsClient);
    core.getPriceOracle.mockResolvedValue(mockPriceOracle);
    core.getWhaleActivityTracker.mockReturnValue(mockWhaleTracker);
    core.createServiceState.mockReturnValue(mockStateManager);
    core.createLogger.mockReturnValue(sharedMockLogger);
    core.getPerformanceLogger.mockReturnValue(sharedMockPerfLogger);
    core.disconnectWithTimeout.mockResolvedValue(undefined);
    core.clearIntervalSafe.mockImplementation((interval: any) => {
      if (interval) clearInterval(interval);
      return null;
    });
    core.OperationGuard.mockImplementation(() => ({
      tryAcquire: jest.fn().mockReturnValue(true),
      release: jest.fn(),
      forceRelease: jest.fn(),
    }));

    // Wire factory mocks
    (createStreamConsumer as jest.Mock).mockReturnValue(mockStreamConsumer);
    (createPriceDataManager as jest.Mock).mockReturnValue(mockPriceDataManager);
    (createOpportunityPublisher as jest.Mock).mockReturnValue(mockOpportunityPublisher);
    (createBridgeCostEstimator as jest.Mock).mockReturnValue(mockBridgeCostEstimator);
    (createMLPredictionManager as jest.Mock).mockReturnValue(mockMLPredictionManager);

    service = new CrossChainDetectorService();
  });

  afterEach(async () => {
    jest.useRealTimers();
  });

  // ===========================================================================
  // start() Lifecycle Tests (FIX #3)
  // ===========================================================================

  describe('start()', () => {
    it('should initialize Redis clients and start all modules', async () => {
      await service.start();

      // Redis clients initialized
      expect(getRedisClient).toHaveBeenCalledTimes(1);
      expect(getRedisStreamsClient).toHaveBeenCalledTimes(1);
      expect(getPriceOracle).toHaveBeenCalledTimes(1);

      // Modules created
      expect(createStreamConsumer).toHaveBeenCalledTimes(1);
      expect(createPriceDataManager).toHaveBeenCalledTimes(1);
      expect(createOpportunityPublisher).toHaveBeenCalledTimes(1);
      expect(createBridgeCostEstimator).toHaveBeenCalledTimes(1);
      expect(createMLPredictionManager).toHaveBeenCalledTimes(1);

      // Stream consumer started
      expect(mockStreamConsumer.createConsumerGroups).toHaveBeenCalledTimes(1);
      expect(mockStreamConsumer.start).toHaveBeenCalledTimes(1);

      // ML predictor initialized
      expect(mockMLPredictionManager.initialize).toHaveBeenCalledTimes(1);

      // Success logged
      expect(sharedMockLogger.info).toHaveBeenCalledWith(
        'Cross-Chain Detector Service started successfully',
        expect.objectContaining({
          crossChainEnabled: expect.any(Boolean),
          mlPredictorActive: expect.any(Boolean),
          whaleTrackerActive: expect.any(Boolean),
        })
      );
    });

    it('should throw when Redis client returns null', async () => {
      const core = jest.requireMock('@arbitrage/core') as any;
      core.getRedisClient.mockResolvedValue(null);

      await expect(service.start()).rejects.toThrow(
        'Failed to initialize Redis client - returned null'
      );
    });

    it('should throw when Redis Streams client returns null', async () => {
      const core = jest.requireMock('@arbitrage/core') as any;
      core.getRedisStreamsClient.mockResolvedValue(null);

      await expect(service.start()).rejects.toThrow(
        'Failed to initialize Redis Streams client - returned null'
      );
    });

    it('should throw when Price Oracle returns null', async () => {
      const core = jest.requireMock('@arbitrage/core') as any;
      core.getPriceOracle.mockResolvedValue(null);

      await expect(service.start()).rejects.toThrow(
        'Failed to initialize Price Oracle - returned null'
      );
    });

    it('should warn when cross-chain arbitrage is disabled', async () => {
      // Save original and override
      const original = ARBITRAGE_CONFIG.crossChainEnabled;
      (ARBITRAGE_CONFIG as any).crossChainEnabled = false;

      try {
        await service.start();
        expect(sharedMockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining('Cross-chain arbitrage is DISABLED'),
        );
      } finally {
        (ARBITRAGE_CONFIG as any).crossChainEnabled = original;
      }
    });

    it('should gracefully handle ML predictor returning false', async () => {
      // MLPredictionManager.initialize() returns false on failure (graceful degradation)
      mockMLPredictionManager.initialize.mockResolvedValue(false);

      // Should NOT throw — ML failure is non-fatal
      await service.start();

      // Service should still be started
      expect(mockStreamConsumer.start).toHaveBeenCalledTimes(1);

      // ML predictor should show as inactive
      expect(sharedMockLogger.info).toHaveBeenCalledWith(
        'Cross-Chain Detector Service started successfully',
        expect.objectContaining({
          mlPredictorActive: false,
        })
      );
    });

    it('should not allow double start', async () => {
      await service.start();

      // Second start should fail (state is RUNNING, not STOPPED)
      await expect(service.start()).rejects.toThrow();
    });

    it('should wire StreamConsumer event handlers', async () => {
      await service.start();

      // Verify on() was called for all expected events
      const onCalls = mockStreamConsumer.on.mock.calls.map(
        (call: any[]) => call[0]
      );
      expect(onCalls).toContain('priceUpdate');
      expect(onCalls).toContain('whaleTransaction');
      expect(onCalls).toContain('pendingOpportunity');
      expect(onCalls).toContain('error');
    });
  });

  // ===========================================================================
  // stop() Lifecycle Tests (FIX #3)
  // ===========================================================================

  describe('stop()', () => {
    beforeEach(async () => {
      await service.start();
    });

    it('should disconnect Redis clients with timeout', async () => {
      await service.stop();

      expect(disconnectWithTimeout).toHaveBeenCalledTimes(2);
      expect(disconnectWithTimeout).toHaveBeenCalledWith(
        mockStreamsClient,
        'Streams client',
        5000,
        sharedMockLogger
      );
      expect(disconnectWithTimeout).toHaveBeenCalledWith(
        mockRedisClient,
        'Redis',
        5000,
        sharedMockLogger
      );
    });

    it('should stop stream consumer and clear all intervals', async () => {
      await service.stop();

      expect(mockStreamConsumer.stop).toHaveBeenCalledTimes(1);
    });

    it('should clear all modular components', async () => {
      await service.stop();

      expect(mockPriceDataManager.clear).toHaveBeenCalledTimes(1);
      expect(mockOpportunityPublisher.clear).toHaveBeenCalledTimes(1);
      expect(mockMLPredictionManager.clear).toHaveBeenCalledTimes(1);
      expect(mockStreamConsumer.removeAllListeners).toHaveBeenCalledTimes(1);
    });

    it('should log stop messages', async () => {
      await service.stop();

      expect(sharedMockLogger.info).toHaveBeenCalledWith('Stopping Cross-Chain Detector Service');
      expect(sharedMockLogger.info).toHaveBeenCalledWith('Cross-Chain Detector Service stopped');
    });

    it('should allow restart after stop', async () => {
      await service.stop();

      // Re-wire core mocks for second start (stop() nulled the service's internal refs)
      const core = jest.requireMock('@arbitrage/core') as any;
      core.getRedisClient.mockResolvedValue(mockRedisClient);
      core.getRedisStreamsClient.mockResolvedValue(mockStreamsClient);
      core.getPriceOracle.mockResolvedValue(mockPriceOracle);
      core.getWhaleActivityTracker.mockReturnValue(mockWhaleTracker);

      // Re-create module mocks for second initialization
      mockStreamConsumer = createMockStreamConsumer();
      mockPriceDataManager = createMockPriceDataManager();
      mockOpportunityPublisher = createMockOpportunityPublisher();
      mockBridgeCostEstimator = createMockBridgeCostEstimator();
      mockMLPredictionManager = createMockMLPredictionManager();
      (createStreamConsumer as jest.Mock).mockReturnValue(mockStreamConsumer);
      (createPriceDataManager as jest.Mock).mockReturnValue(mockPriceDataManager);
      (createOpportunityPublisher as jest.Mock).mockReturnValue(mockOpportunityPublisher);
      (createBridgeCostEstimator as jest.Mock).mockReturnValue(mockBridgeCostEstimator);
      (createMLPredictionManager as jest.Mock).mockReturnValue(mockMLPredictionManager);

      // Should succeed — state is STOPPED again
      await service.start();

      expect(mockStreamConsumer.start).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // findArbitrageInPrices() Tests (FIX #4)
  // ===========================================================================

  describe('findArbitrageInPrices()', () => {
    // Access private method for testing
    const callFindArbitrage = (
      svc: any,
      chainPrices: any[],
      whaleData?: any,
      whaleTx?: any,
      mlPredictions?: Map<string, any>
    ) => svc.findArbitrageInPrices(chainPrices, whaleData, whaleTx, mlPredictions);

    const now = Date.now();

    const createPricePoint = (overrides: Partial<{
      chain: string;
      dex: string;
      pairKey: string;
      price: number;
      timestamp: number;
    }> = {}) => ({
      chain: overrides.chain ?? 'ethereum',
      dex: overrides.dex ?? 'uniswap',
      pairKey: overrides.pairKey ?? 'WETH_USDC',
      price: overrides.price ?? 2500,
      update: {
        chain: overrides.chain ?? 'ethereum',
        dex: overrides.dex ?? 'uniswap',
        pairKey: overrides.pairKey ?? 'WETH_USDC',
        pairAddress: '0x1234',
        token0: 'WETH',
        token1: 'USDC',
        reserve0: '1000000000000000000',
        reserve1: '2500000000',
        price: overrides.price ?? 2500,
        timestamp: overrides.timestamp ?? now,
        blockNumber: 12345,
        latency: 50,
      },
    });

    beforeEach(async () => {
      // Start service to initialize internal modules
      await service.start();
    });

    it('should return empty array when fewer than 2 chain prices', () => {
      const result = callFindArbitrage(service, []);
      expect(result).toEqual([]);

      const result2 = callFindArbitrage(service, [createPricePoint()]);
      expect(result2).toEqual([]);
    });

    it('should return empty array when lowest price is zero or invalid', () => {
      const prices = [
        createPricePoint({ chain: 'ethereum', price: 0 }),
        createPricePoint({ chain: 'bsc', price: 2500 }),
      ];
      const result = callFindArbitrage(service, prices);
      expect(result).toEqual([]);
    });

    it('should return empty array when prices are stale', () => {
      const staleTimestamp = now - 60000; // 60s old, maxPriceAgeMs defaults to 30s
      const prices = [
        createPricePoint({ chain: 'ethereum', price: 2500, timestamp: staleTimestamp }),
        createPricePoint({ chain: 'bsc', price: 2750, timestamp: staleTimestamp }),
      ];
      const result = callFindArbitrage(service, prices);
      expect(result).toEqual([]);
    });

    it('should return empty array when bridge cost is invalid', () => {
      mockBridgeCostEstimator.getDetailedEstimate.mockReturnValue({
        costEth: NaN,
        costUsd: NaN,
        predictedLatency: 0,
        reliability: 0,
      });
      mockBridgeCostEstimator.extractTokenAmount.mockReturnValue(1000);

      const prices = [
        createPricePoint({ chain: 'ethereum', price: 2500 }),
        createPricePoint({ chain: 'bsc', price: 2750 }),
      ];
      const result = callFindArbitrage(service, prices);
      expect(result).toEqual([]);
    });

    it('should return empty array when not profitable after costs', () => {
      // Tiny price diff, no profit after bridge + gas + swap fees
      const prices = [
        createPricePoint({ chain: 'ethereum', price: 2500 }),
        createPricePoint({ chain: 'bsc', price: 2500.01 }),
      ];
      const result = callFindArbitrage(service, prices);
      expect(result).toEqual([]);
    });

    it('should detect profitable cross-chain opportunity', () => {
      // Large price diff — should be profitable
      mockBridgeCostEstimator.getDetailedEstimate.mockReturnValue({
        costEth: 0.0001,
        costUsd: 0.3,
        predictedLatency: 120,
        reliability: 0.95,
      });
      mockBridgeCostEstimator.extractTokenAmount.mockReturnValue(100000);

      const prices = [
        createPricePoint({ chain: 'ethereum', price: 2500 }),
        createPricePoint({ chain: 'bsc', price: 2750 }),
      ];
      const result = callFindArbitrage(service, prices);

      expect(result.length).toBe(1);
      const opp = result[0];
      expect(opp.sourceChain).toBe('ethereum');
      expect(opp.targetChain).toBe('bsc');
      expect(opp.sourcePrice).toBe(2500);
      expect(opp.targetPrice).toBe(2750);
      expect(opp.priceDiff).toBe(250);
      expect(opp.estimatedProfit).toBe(250); // priceDiff (gross)
      expect(opp.confidence).toBeGreaterThan(0);
      expect(opp.confidence).toBeLessThanOrEqual(0.95);
    });

    it('should include whale fields when whale data provided', () => {
      mockBridgeCostEstimator.getDetailedEstimate.mockReturnValue({
        costEth: 0.0001,
        costUsd: 0.3,
        predictedLatency: 120,
        reliability: 0.95,
      });
      mockBridgeCostEstimator.extractTokenAmount.mockReturnValue(100000);

      const whaleData = {
        dominantDirection: 'bullish' as const,
        buyVolumeUsd: 600000,
        sellVolumeUsd: 0,
        superWhaleCount: 1,
        netFlowUsd: 600000,
        transactionCount: 1,
        recentTransactions: [],
      };
      const whaleTx = {
        transactionHash: '0xabc',
        token: 'WETH',
        usdValue: 600000,
        type: 'buy' as const,
        chain: 'ethereum',
        timestamp: now,
      };

      const prices = [
        createPricePoint({ chain: 'ethereum', price: 2500 }),
        createPricePoint({ chain: 'bsc', price: 2750 }),
      ];
      const result = callFindArbitrage(service, prices, whaleData, whaleTx);

      expect(result.length).toBe(1);
      expect(result[0].whaleTriggered).toBe(true);
      expect(result[0].whaleTxHash).toBe('0xabc');
      expect(result[0].whaleDirection).toBe('bullish');
    });

    it('should include ML fields when predictions provided', () => {
      mockBridgeCostEstimator.getDetailedEstimate.mockReturnValue({
        costEth: 0.0001,
        costUsd: 0.3,
        predictedLatency: 120,
        reliability: 0.95,
      });
      mockBridgeCostEstimator.extractTokenAmount.mockReturnValue(100000);

      const mlPredictions = new Map<string, any>([
        ['ethereum:WETH_USDC', { direction: 'up', confidence: 0.8 }],
        ['bsc:WETH_USDC', { direction: 'sideways', confidence: 0.7 }],
      ]);

      const prices = [
        createPricePoint({ chain: 'ethereum', price: 2500 }),
        createPricePoint({ chain: 'bsc', price: 2750 }),
      ];
      const result = callFindArbitrage(service, prices, undefined, undefined, mlPredictions);

      expect(result.length).toBe(1);
      expect(result[0].mlSupported).toBe(true);
      expect(result[0].mlSourceDirection).toBe('up');
      expect(result[0].mlConfidenceBoost).toBeGreaterThan(1);
    });
  });

  // ===========================================================================
  // detectWhaleInducedOpportunities() Tests (FIX #4)
  // ===========================================================================

  describe('detectWhaleInducedOpportunities()', () => {
    // Access private method
    const callDetectWhale = (
      svc: any,
      whaleTx: any,
      summary: any
    ) => svc.detectWhaleInducedOpportunities(whaleTx, summary);

    const now = Date.now();

    beforeEach(async () => {
      await service.start();
    });

    it('should return early when priceDataManager is null', async () => {
      // Access internal state to null out priceDataManager
      (service as any).priceDataManager = null;

      await callDetectWhale(service, { token: 'WETH' }, {});

      // No snapshot call should have been made
      expect(mockPriceDataManager.createIndexedSnapshot).not.toHaveBeenCalled();
    });

    it('should return early when crossChainEnabled is false', async () => {
      const original = ARBITRAGE_CONFIG.crossChainEnabled;
      (ARBITRAGE_CONFIG as any).crossChainEnabled = false;

      try {
        await callDetectWhale(service, { token: 'WETH' }, {});
        expect(mockPriceDataManager.createIndexedSnapshot).not.toHaveBeenCalled();
      } finally {
        (ARBITRAGE_CONFIG as any).crossChainEnabled = original;
      }
    });

    it('should return early when whale token is invalid', async () => {
      await callDetectWhale(service, { token: '', transactionHash: '0x1' }, {});
      expect(mockPriceDataManager.createIndexedSnapshot).not.toHaveBeenCalled();

      await callDetectWhale(service, { token: null, transactionHash: '0x2' }, {});
      expect(mockPriceDataManager.createIndexedSnapshot).not.toHaveBeenCalled();
    });

    it('should return early when no matching pairs found', async () => {
      mockPriceDataManager.createIndexedSnapshot.mockReturnValue({
        tokenPairs: ['DAI_USDC', 'LINK_ETH'],
        byToken: new Map(),
        timestamp: now,
      });

      const whaleTx = {
        token: 'WBTC',
        transactionHash: '0xabc',
        usdValue: 600000,
        type: 'buy',
        chain: 'ethereum',
        timestamp: now,
      };
      const summary = {
        dominantDirection: 'bullish',
        buyVolumeUsd: 600000,
        sellVolumeUsd: 0,
        superWhaleCount: 1,
        netFlowUsd: 600000,
        transactionCount: 1,
        recentTransactions: [],
      };

      await callDetectWhale(service, whaleTx, summary);

      // Debug log for no matching pairs
      expect(sharedMockLogger.debug).toHaveBeenCalledWith(
        'No pairs found for whale token',
        expect.objectContaining({ token: 'WBTC' })
      );
    });

    it('should call findArbitrageInPrices for matching whale token pairs', async () => {
      // Set up snapshot with matching pair for WETH
      const chainPrices = [
        {
          chain: 'ethereum',
          dex: 'uniswap',
          pairKey: 'WETH_USDC',
          price: 2500,
          update: {
            chain: 'ethereum',
            dex: 'uniswap',
            pairKey: 'WETH_USDC',
            pairAddress: '0x1',
            token0: 'WETH',
            token1: 'USDC',
            reserve0: '1000000000000000000',
            reserve1: '2500000000',
            price: 2500,
            timestamp: now,
            blockNumber: 12345,
            latency: 50,
          },
        },
        {
          chain: 'bsc',
          dex: 'pancakeswap',
          pairKey: 'WETH_USDC',
          price: 2750,
          update: {
            chain: 'bsc',
            dex: 'pancakeswap',
            pairKey: 'WETH_USDC',
            pairAddress: '0x2',
            token0: 'WETH',
            token1: 'USDC',
            reserve0: '500000000000000000',
            reserve1: '1375000000',
            price: 2750,
            timestamp: now,
            blockNumber: 67890,
            latency: 50,
          },
        },
      ];

      mockPriceDataManager.createIndexedSnapshot.mockReturnValue({
        tokenPairs: ['WETH_USDC'],
        byToken: new Map([['WETH_USDC', chainPrices]]),
        timestamp: now,
      });

      // Make bridge cost cheap so opportunity is profitable
      mockBridgeCostEstimator.getDetailedEstimate.mockReturnValue({
        costEth: 0.0001,
        costUsd: 0.3,
        predictedLatency: 120,
        reliability: 0.95,
      });
      mockBridgeCostEstimator.extractTokenAmount.mockReturnValue(100000);

      const whaleTx = {
        token: 'WETH',
        transactionHash: '0xabc',
        usdValue: 600000,
        type: 'buy',
        chain: 'ethereum',
        timestamp: now,
      };
      const summary = {
        dominantDirection: 'bullish',
        buyVolumeUsd: 600000,
        sellVolumeUsd: 0,
        superWhaleCount: 1,
        netFlowUsd: 600000,
        transactionCount: 1,
        recentTransactions: [],
      };

      await callDetectWhale(service, whaleTx, summary);

      // Should have processed the matching pair (called createIndexedSnapshot)
      expect(mockPriceDataManager.createIndexedSnapshot).toHaveBeenCalledTimes(1);

      // The "No pairs found" debug message should NOT have been logged
      const debugCalls = sharedMockLogger.debug.mock.calls
        .filter((call: any[]) => call[0] === 'No pairs found for whale token');
      expect(debugCalls.length).toBe(0);
    });

    it('should use exact token matching (not substring)', async () => {
      // "LINK" should NOT match "WETH_USDC" — exact part matching
      // Note: "ETH" normalizes to "WETH" via normalizeTokenForCrossChain,
      // which would match WETH_USDC. We use LINK which has no alias.
      mockPriceDataManager.createIndexedSnapshot.mockReturnValue({
        tokenPairs: ['WETH_USDC'],
        byToken: new Map(),
        timestamp: now,
      });

      const whaleTx = {
        token: 'LINK',
        transactionHash: '0xdef',
        usdValue: 500000,
        type: 'buy',
        chain: 'ethereum',
        timestamp: now,
      };
      const summary = {
        dominantDirection: 'bullish',
        buyVolumeUsd: 500000,
        sellVolumeUsd: 0,
        superWhaleCount: 0,
        netFlowUsd: 500000,
        transactionCount: 1,
        recentTransactions: [],
      };

      await callDetectWhale(service, whaleTx, summary);

      // LINK should not match WETH_USDC via exact part matching
      expect(sharedMockLogger.debug).toHaveBeenCalledWith(
        'No pairs found for whale token',
        expect.objectContaining({ token: 'LINK' })
      );
    });

    it('should handle errors gracefully', async () => {
      mockPriceDataManager.createIndexedSnapshot.mockImplementation(() => {
        throw new Error('Snapshot creation failed');
      });

      const whaleTx = {
        token: 'WETH',
        transactionHash: '0xabc',
        usdValue: 600000,
        type: 'buy',
        chain: 'ethereum',
        timestamp: now,
      };

      // Should NOT throw
      await callDetectWhale(service, whaleTx, {});

      expect(sharedMockLogger.error).toHaveBeenCalledWith(
        'Failed to detect whale-induced opportunities',
        expect.objectContaining({ token: 'WETH' })
      );
    });
  });
});
