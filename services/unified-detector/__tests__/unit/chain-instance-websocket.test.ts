/**
 * Unit Tests for ChainDetectorInstance WebSocket & Subscription Management
 *
 * Tests WebSocket initialization, subscription mode selection (factory vs legacy),
 * factory event handling, connection error recovery, and message routing.
 *
 * Finding #7 from unified-detector deep analysis: ~400 lines of untested runtime code.
 */

import { EventEmitter } from 'events';
import { ChainDetectorInstance } from '../../src/chain-instance';

// =============================================================================
// Mock Setup
// =============================================================================

const mockWsConnect = jest.fn().mockResolvedValue(undefined);
const mockWsSubscribe = jest.fn().mockResolvedValue(undefined);
const mockWsDisconnect = jest.fn().mockResolvedValue(undefined);
const mockWsOn = jest.fn();
const mockWsRemoveAllListeners = jest.fn();

class MockWebSocketManager extends EventEmitter {
  connect = mockWsConnect;
  subscribe = mockWsSubscribe;
  disconnect = mockWsDisconnect;
  removeAllListeners = mockWsRemoveAllListeners;
}

const mockSubscribeToFactories = jest.fn().mockResolvedValue(undefined);
const mockOnPairCreated = jest.fn();
const mockHandleFactoryEvent = jest.fn();
const mockGetSubscriptionCount = jest.fn().mockReturnValue(3);
const mockFactoryStop = jest.fn().mockResolvedValue(undefined);

// Mock @arbitrage/core
jest.mock('@arbitrage/core', () => {
  const MockRedisStreamsClient = jest.fn();
  Object.defineProperty(MockRedisStreamsClient, 'STREAMS', {
    value: {
      PRICE_UPDATES: 'stream:price-updates',
      SWAP_EVENTS: 'stream:swap-events',
      OPPORTUNITIES: 'stream:opportunities',
      WHALE_ALERTS: 'stream:whale-alerts',
      SERVICE_HEALTH: 'stream:service-health',
      SERVICE_EVENTS: 'stream:service-events',
      COORDINATOR_EVENTS: 'stream:coordinator-events',
      HEALTH: 'stream:health',
      HEALTH_ALERTS: 'stream:health-alerts',
      EXECUTION_REQUESTS: 'stream:execution-requests',
      EXECUTION_RESULTS: 'stream:execution-results',
      PENDING_OPPORTUNITIES: 'stream:pending-opportunities',
      VOLUME_AGGREGATES: 'stream:volume-aggregates',
      CIRCUIT_BREAKER: 'stream:circuit-breaker',
      SYSTEM_FAILOVER: 'stream:system-failover',
      SYSTEM_COMMANDS: 'stream:system-commands',
      DEAD_LETTER_QUEUE: 'stream:dead-letter-queue',
      DLQ_ALERTS: 'stream:dlq-alerts',
      FORWARDING_DLQ: 'stream:forwarding-dlq',
    },
    writable: false,
    enumerable: true,
  });
  return {
  createLogger: jest.fn().mockReturnValue({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }),
  PerformanceLogger: jest.fn(),
  RedisStreamsClient: MockRedisStreamsClient,
  WebSocketManager: jest.fn().mockImplementation(() => new MockWebSocketManager()),
  WebSocketConfig: {},
  calculatePriceFromBigIntReserves: jest.fn().mockReturnValue(1500.5),
  isSimulationMode: jest.fn().mockReturnValue(false),
  CrossDexTriangularArbitrage: jest.fn().mockImplementation(() => ({
    findOpportunities: jest.fn().mockReturnValue([]),
  })),
  DexPool: jest.fn(),
  getMultiLegPathFinder: jest.fn().mockReturnValue({
    findPaths: jest.fn().mockReturnValue([]),
  }),
  SwapEventFilter: jest.fn(),
  getSwapEventFilter: jest.fn().mockReturnValue({
    onWhaleAlert: jest.fn().mockReturnValue(jest.fn()),
    processEvent: jest.fn().mockReturnValue({ passed: true }),
  }),
  WhaleAlert: jest.fn(),
  PairActivityTracker: jest.fn(),
  getPairActivityTracker: jest.fn().mockReturnValue({
    recordUpdate: jest.fn(),
    isHotPair: jest.fn().mockReturnValue(false),
    getStats: jest.fn().mockReturnValue({ hotPairs: 0, totalPairs: 0 }),
  }),
  FactorySubscriptionService: jest.fn().mockImplementation(() => ({
    subscribeToFactories: mockSubscribeToFactories,
    onPairCreated: mockOnPairCreated,
    handleFactoryEvent: mockHandleFactoryEvent,
    getSubscriptionCount: mockGetSubscriptionCount,
    stop: mockFactoryStop,
  })),
  FactoryEventSignatures: {
    PAIR_CREATED: '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9',
  },
  AdditionalEventSignatures: {
    POOL_CREATED: '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118',
  },
  FactoryWebSocketManager: jest.fn(),
  ReserveCache: jest.fn(),
  getReserveCache: jest.fn().mockReturnValue({
    onSyncEvent: jest.fn(),
    getStats: jest.fn().mockReturnValue({ hits: 0, misses: 0 }),
  }),
  HierarchicalCache: jest.fn(),
  createHierarchicalCache: jest.fn().mockReturnValue({
    get: jest.fn(),
    set: jest.fn(),
    getStats: jest.fn().mockReturnValue({ l1: { hits: 0, misses: 0, size: 0 }, l2: { hits: 0, misses: 0 } }),
  }),
  bpsToDecimal: jest.fn().mockImplementation((bps: number) => bps / 10000),
  disconnectWithTimeout: jest.fn().mockResolvedValue(undefined),
  stopAndNullify: jest.fn().mockResolvedValue(null),
  LiquidityDepthAnalyzer: jest.fn(),
  getLiquidityDepthAnalyzer: jest.fn().mockReturnValue({
    updatePoolLiquidity: jest.fn(),
    analyzeDepth: jest.fn().mockReturnValue(null),
  }),
};
});

// Mock @arbitrage/config
jest.mock('@arbitrage/config', () => ({
  CHAINS: {
    ethereum: {
      name: 'Ethereum',
      wsUrl: 'wss://eth-mainnet.test/ws',
      rpcUrl: 'https://eth-mainnet.test/rpc',
      chainId: 1,
    },
    bsc: {
      name: 'BSC',
      wsUrl: 'wss://bsc-mainnet.test/ws',
      rpcUrl: 'https://bsc-mainnet.test/rpc',
      chainId: 56,
    },
    polygon: {
      name: 'Polygon',
      wsUrl: 'wss://polygon-mainnet.test/ws',
      rpcUrl: 'https://polygon-mainnet.test/rpc',
      chainId: 137,
    },
  },
  CORE_TOKENS: {
    ethereum: [
      { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
      { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
      { symbol: 'DAI', address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },
    ],
    bsc: [
      { symbol: 'WBNB', address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18 },
      { symbol: 'BUSD', address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', decimals: 18 },
    ],
    polygon: [],
  },
  EVENT_SIGNATURES: {
    SYNC: '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1',
    SWAP_V2: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
  },
  DETECTOR_CONFIG: {
    ethereum: { minProfitPercentage: 0.003 },
    bsc: { minProfitPercentage: 0.005 },
    polygon: { minProfitPercentage: 0.003 },
  },
  TOKEN_METADATA: {
    ethereum: {
      weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      stablecoins: [],
      nativeWrapper: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    },
  },
  ARBITRAGE_CONFIG: {
    minProfitPercentage: 0.003,
    slippageTolerance: 0.10,
  },
  getEnabledDexes: jest.fn().mockReturnValue([
    {
      name: 'uniswap',
      factoryAddress: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
      routerAddress: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
      feeBps: 30,
    },
  ]),
  isEvmChain: jest.fn().mockReturnValue(true),
  getAllFactoryAddresses: jest.fn().mockReturnValue([
    '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
  ]),
  PartitionHealth: jest.fn(),
  ChainHealth: jest.fn(),
  FEATURE_FLAGS: {
    useBatchedQuoter: false,
    useFlashLoanAggregator: false,
    useCommitReveal: false,
    useCommitRevealRedis: false,
    useDestChainFlashLoan: false,
    useMomentumTracking: false,
    useMLSignalScoring: false,
    useSignalCacheRead: false,
    useLiquidityDepthSizing: false,
  },
}));

// Mock internal modules
jest.mock('../../src/detection', () => ({
  SimpleArbitrageDetector: jest.fn(),
  createSimpleArbitrageDetector: jest.fn().mockReturnValue({
    detect: jest.fn().mockReturnValue([]),
  }),
  SnapshotManager: jest.fn(),
  createSnapshotManager: jest.fn().mockReturnValue({
    invalidateCache: jest.fn(),
    clear: jest.fn(),
    createPairsSnapshot: jest.fn().mockReturnValue([]),
    getDexPoolsForPair: jest.fn().mockReturnValue([]),
  }),
}));

jest.mock('../../src/simulation', () => ({
  ChainSimulationHandler: jest.fn(),
  PairForSimulation: jest.fn(),
  SimulationCallbacks: jest.fn(),
}));

jest.mock('../../src/publishers', () => ({
  WhaleAlertPublisher: jest.fn().mockImplementation(() => ({
    publishWhaleAlert: jest.fn().mockResolvedValue(undefined),
    publishSwapEvent: jest.fn(),
  })),
  ExtendedPairInfo: jest.fn(),
}));

jest.mock('../../src/types', () => ({
  ...jest.requireActual('../../src/types'),
  toWebSocketUrl: jest.fn().mockImplementation((url: string) => ({
    url: url.startsWith('wss://') ? url : url.replace('https://', 'wss://'),
    converted: !url.startsWith('wss://'),
    originalUrl: url,
  })),
  isUnstableChain: jest.fn().mockReturnValue(false),
  validateFee: jest.fn().mockImplementation((fee?: number) => fee ?? 0.003),
  parseIntEnvVar: jest.fn().mockImplementation((_val: any, def: number) => def),
  parseFloatEnvVar: jest.fn().mockImplementation((_val: any, def: number) => def),
}));

jest.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: jest.fn().mockImplementation(() => ({})),
    keccak256: jest.fn().mockReturnValue('0x' + 'ab'.repeat(32)),
    solidityPacked: jest.fn().mockReturnValue('0x1234'),
  },
}));

// =============================================================================
// Helpers
// =============================================================================

function createMockStreamsClient() {
  return {
    xadd: jest.fn().mockResolvedValue('stream-id'),
    xaddWithLimit: jest.fn().mockResolvedValue('stream-id'),
    createBatcher: jest.fn().mockReturnValue({
      add: jest.fn(),
      flush: jest.fn().mockResolvedValue(undefined),
      destroy: jest.fn().mockResolvedValue(undefined),
      getStats: jest.fn().mockReturnValue({
        currentQueueSize: 0,
        totalMessagesQueued: 0,
        batchesSent: 0,
        totalMessagesSent: 0,
        compressionRatio: 1,
        averageBatchSize: 0,
        totalBatchFlushes: 0,
      }),
    }),
    STREAMS: { OPPORTUNITIES: 'stream:opportunities' },
  } as any;
}

function createMockPerfLogger() {
  return {
    logHealthCheck: jest.fn(),
    logPerformance: jest.fn(),
  } as any;
}

function createInstance(overrides: Partial<ConstructorParameters<typeof ChainDetectorInstance>[0]> = {}) {
  return new ChainDetectorInstance({
    chainId: 'ethereum',
    partitionId: 'test-partition',
    streamsClient: createMockStreamsClient(),
    perfLogger: createMockPerfLogger(),
    ...overrides,
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('ChainDetectorInstance - WebSocket & Subscription Management', () => {
  beforeEach(() => {
    // Global setupTests.ts calls jest.resetAllMocks() in afterEach,
    // which wipes all mock implementations. Re-establish them here.

    // Top-level mock functions
    mockWsConnect.mockResolvedValue(undefined);
    mockWsSubscribe.mockResolvedValue(undefined);
    mockWsDisconnect.mockResolvedValue(undefined);
    mockSubscribeToFactories.mockResolvedValue(undefined);
    mockGetSubscriptionCount.mockReturnValue(3);
    mockFactoryStop.mockResolvedValue(undefined);

    // Re-establish @arbitrage/core mock implementations
    const core = require('@arbitrage/core');
    core.createLogger.mockReturnValue({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    });
    core.WebSocketManager.mockImplementation(() => new MockWebSocketManager());
    core.calculatePriceFromBigIntReserves.mockReturnValue(1500.5);
    core.isSimulationMode.mockReturnValue(false);
    core.CrossDexTriangularArbitrage.mockImplementation(() => ({
      findOpportunities: jest.fn().mockReturnValue([]),
    }));
    core.getMultiLegPathFinder.mockReturnValue({
      findPaths: jest.fn().mockReturnValue([]),
    });
    core.getSwapEventFilter.mockReturnValue({
      onWhaleAlert: jest.fn().mockReturnValue(jest.fn()),
      processEvent: jest.fn().mockReturnValue({ passed: true }),
    });
    core.getPairActivityTracker.mockReturnValue({
      recordUpdate: jest.fn(),
      isHotPair: jest.fn().mockReturnValue(false),
      getStats: jest.fn().mockReturnValue({ hotPairs: 0, totalPairs: 0 }),
    });
    core.FactorySubscriptionService.mockImplementation(() => ({
      subscribeToFactories: mockSubscribeToFactories,
      onPairCreated: mockOnPairCreated,
      handleFactoryEvent: mockHandleFactoryEvent,
      getSubscriptionCount: mockGetSubscriptionCount,
      stop: mockFactoryStop,
    }));
    core.getReserveCache.mockReturnValue({
      onSyncEvent: jest.fn(),
      getStats: jest.fn().mockReturnValue({ hits: 0, misses: 0 }),
    });
    core.createHierarchicalCache.mockReturnValue({
      get: jest.fn(),
      set: jest.fn(),
      getStats: jest.fn().mockReturnValue({
        l1: { hits: 0, misses: 0, size: 0 },
        l2: { hits: 0, misses: 0 },
      }),
    });
    core.bpsToDecimal.mockImplementation((bps: number) => bps / 10000);
    core.disconnectWithTimeout.mockResolvedValue(undefined);
    core.stopAndNullify.mockResolvedValue(null);
    core.getCorrelationAnalyzer?.mockReturnValue?.({});
    core.getLiquidityDepthAnalyzer.mockReturnValue({
      updatePoolLiquidity: jest.fn(),
      analyzeDepth: jest.fn().mockReturnValue(null),
    });

    // Re-establish @arbitrage/config mock implementations
    const config = require('@arbitrage/config');
    config.getEnabledDexes.mockReturnValue([
      {
        name: 'uniswap',
        factoryAddress: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
        routerAddress: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
        feeBps: 30,
      },
    ]);
    config.isEvmChain.mockReturnValue(true);
    config.getAllFactoryAddresses.mockReturnValue([
      '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
    ]);

    // Re-establish ../../detection mock implementations
    const detection = require('../../src/detection');
    detection.createSimpleArbitrageDetector.mockReturnValue({
      detect: jest.fn().mockReturnValue([]),
    });
    detection.createSnapshotManager.mockReturnValue({
      invalidateCache: jest.fn(),
      clear: jest.fn(),
      createPairsSnapshot: jest.fn().mockReturnValue([]),
      getDexPoolsForPair: jest.fn().mockReturnValue([]),
    });

    // Re-establish ../../publishers mock implementations
    const publishers = require('../../src/publishers');
    publishers.WhaleAlertPublisher.mockImplementation(() => ({
      publishWhaleAlert: jest.fn().mockResolvedValue(undefined),
      publishSwapEvent: jest.fn(),
    }));

    // Re-establish ../../types mock implementations
    const types = require('../../src/types');
    types.toWebSocketUrl.mockImplementation((url: string) => ({
      url: url.startsWith('wss://') ? url : url.replace('https://', 'wss://'),
      converted: !url.startsWith('wss://'),
      originalUrl: url,
    }));
    types.isUnstableChain.mockReturnValue(false);
    types.validateFee.mockImplementation((fee?: number) => fee ?? 0.003);
    types.parseIntEnvVar.mockImplementation((_val: any, def: number) => def);
    types.parseFloatEnvVar.mockImplementation((_val: any, def: number) => def);

    // Re-establish ethers mock implementations
    const { ethers } = require('ethers');
    ethers.JsonRpcProvider.mockImplementation(() => ({}));
    ethers.keccak256.mockReturnValue('0x' + 'ab'.repeat(32));
    ethers.solidityPacked.mockReturnValue('0x1234');
  });

  // ===========================================================================
  // shouldUseReserveCache (private, accessed via any)
  // Note: shouldUseFactorySubscriptions tests moved to subscription-manager.test.ts
  // ===========================================================================

  describe('shouldUseReserveCache', () => {
    it('should return false when useReserveCache is disabled', () => {
      const instance = createInstance({ useReserveCache: false });
      expect((instance as any).shouldUseReserveCache()).toBe(false);
    });

    it('should return true when chain is in enabled list', () => {
      const instance = createInstance({
        chainId: 'ethereum',
        useReserveCache: true,
        reserveCacheEnabledChains: ['ethereum'],
      });
      expect((instance as any).shouldUseReserveCache()).toBe(true);
    });

    it('should return false when chain is not in enabled list', () => {
      const instance = createInstance({
        chainId: 'ethereum',
        useReserveCache: true,
        reserveCacheEnabledChains: ['polygon'],
      });
      expect((instance as any).shouldUseReserveCache()).toBe(false);
    });

    it('should use rollout percentage when no explicit chain list', () => {
      const instance = createInstance({
        useReserveCache: true,
        reserveCacheEnabledChains: [],
        reserveCacheRolloutPercent: 100,
      });
      expect((instance as any).shouldUseReserveCache()).toBe(true);
    });
  });

  // ===========================================================================
  // handleConnectionError (private, accessed via any)
  // Note: hashChainName tests moved to subscription-manager.test.ts
  // ===========================================================================

  describe('handleConnectionError', () => {
    it('should increment reconnect attempts', () => {
      const instance = createInstance();
      const initialAttempts = (instance as any).reconnectAttempts;

      (instance as any).handleConnectionError(new Error('Connection lost'));

      expect((instance as any).reconnectAttempts).toBe(initialAttempts + 1);
    });

    it('should emit error when max reconnect attempts reached', () => {
      const instance = createInstance();
      const errorHandler = jest.fn();
      instance.on('error', errorHandler);

      // Set reconnect attempts to just below max
      (instance as any).reconnectAttempts = (instance as any).MAX_RECONNECT_ATTEMPTS - 1;

      (instance as any).handleConnectionError(new Error('Connection lost'));

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Max reconnect attempts reached'),
        })
      );
    });

    it('should set status to error when max attempts reached', () => {
      const instance = createInstance();
      (instance as any).reconnectAttempts = (instance as any).MAX_RECONNECT_ATTEMPTS - 1;
      const statusHandler = jest.fn();
      instance.on('statusChange', statusHandler);
      // Must listen for 'error' to prevent Node.js EventEmitter from throwing
      instance.on('error', jest.fn());

      (instance as any).handleConnectionError(new Error('Connection lost'));

      expect((instance as any).status).toBe('error');
      expect(statusHandler).toHaveBeenCalledWith('error');
    });

    it('should not emit error before max attempts', () => {
      const instance = createInstance();
      const errorHandler = jest.fn();
      instance.on('error', errorHandler);

      (instance as any).handleConnectionError(new Error('Connection lost'));

      expect(errorHandler).not.toHaveBeenCalled();
      expect((instance as any).status).not.toBe('error');
    });

    it('should clean up old wsManager before slow recovery reconnection', () => {
      jest.useFakeTimers();
      try {
        const instance = createInstance();
        instance.on('error', jest.fn()); // Prevent unhandled error throw

        // Simulate an old wsManager with listeners attached
        const oldWsManager = new MockWebSocketManager();
        (instance as any).wsManager = oldWsManager;
        (instance as any).factorySubscriptionService = { stop: jest.fn() };

        // Trigger max reconnect attempts to start slow recovery timer
        (instance as any).reconnectAttempts = (instance as any).MAX_RECONNECT_ATTEMPTS - 1;
        (instance as any).handleConnectionError(new Error('Connection lost'));

        // Slow recovery timer should now be set
        expect((instance as any).slowRecoveryTimer).not.toBeNull();

        // Advance timer to trigger slow recovery tick
        jest.advanceTimersByTime((instance as any).SLOW_RECOVERY_INTERVAL_MS);

        // Old wsManager should have had removeAllListeners called
        expect(oldWsManager.removeAllListeners).toHaveBeenCalled();
        // Old references should be nulled before re-initialization
        expect((instance as any).factorySubscriptionService).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // ===========================================================================
  // handleWebSocketMessage (private, accessed via any)
  // ===========================================================================

  describe('handleWebSocketMessage', () => {
    it('should skip processing when stopping', () => {
      const instance = createInstance();
      (instance as any).isStopping = true;
      (instance as any).isRunning = true;

      // Should not throw
      expect(() => {
        (instance as any).handleWebSocketMessage({
          method: 'eth_subscription',
          params: {
            result: {
              topics: ['0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1'],
              address: '0xtest',
              data: '0x' + '00'.repeat(64).repeat(2),
              blockNumber: '0x1',
            },
          },
        });
      }).not.toThrow();
    });

    it('should skip processing when not running', () => {
      const instance = createInstance();
      (instance as any).isRunning = false;

      expect(() => {
        (instance as any).handleWebSocketMessage({
          method: 'eth_subscription',
          params: {
            result: {
              topics: ['0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1'],
              address: '0xtest',
              data: '0x' + '00'.repeat(64).repeat(2),
              blockNumber: '0x1',
            },
          },
        });
      }).not.toThrow();
    });

    it('should route Sync events to handleSyncEvent', () => {
      const instance = createInstance();
      (instance as any).isRunning = true;
      (instance as any).isStopping = false;

      const mockHandleSync = jest.fn();
      (instance as any).handleSyncEvent = mockHandleSync;

      const syncLog = {
        topics: ['0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1'],
        address: '0xtest',
        data: '0x' + '00'.repeat(128),
        blockNumber: '0x1',
      };

      (instance as any).handleWebSocketMessage({
        method: 'eth_subscription',
        params: { result: syncLog },
      });

      expect(mockHandleSync).toHaveBeenCalledWith(syncLog);
    });

    it('should route Swap events to handleSwapEvent', () => {
      const instance = createInstance();
      (instance as any).isRunning = true;
      (instance as any).isStopping = false;

      const mockHandleSwap = jest.fn();
      (instance as any).handleSwapEvent = mockHandleSwap;

      const swapLog = {
        topics: ['0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'],
        address: '0xtest',
        data: '0x' + '00'.repeat(256),
        blockNumber: '0x1',
      };

      (instance as any).handleWebSocketMessage({
        method: 'eth_subscription',
        params: { result: swapLog },
      });

      expect(mockHandleSwap).toHaveBeenCalledWith(swapLog);
    });

    it('should route block headers to handleNewBlock', () => {
      const instance = createInstance();
      (instance as any).isRunning = true;
      (instance as any).isStopping = false;

      const mockHandleBlock = jest.fn();
      (instance as any).handleNewBlock = mockHandleBlock;

      const blockHeader = {
        number: '0xf4240',
        timestamp: '0x5f5e100',
        hash: '0xabc',
      };

      (instance as any).handleWebSocketMessage({
        method: 'eth_subscription',
        params: { result: blockHeader },
      });

      expect(mockHandleBlock).toHaveBeenCalledWith(blockHeader);
    });

    it('should ignore non-subscription messages', () => {
      const instance = createInstance();
      (instance as any).isRunning = true;
      (instance as any).isStopping = false;

      const mockHandleSync = jest.fn();
      (instance as any).handleSyncEvent = mockHandleSync;

      (instance as any).handleWebSocketMessage({
        method: 'eth_getBalance',
        params: {},
      });

      expect(mockHandleSync).not.toHaveBeenCalled();
    });

    it('should catch and log errors in message processing', () => {
      const instance = createInstance();
      (instance as any).isRunning = true;
      (instance as any).isStopping = false;

      // Make handleSyncEvent throw
      (instance as any).handleSyncEvent = jest.fn().mockImplementation(() => {
        throw new Error('Handler error');
      });

      // Should not throw
      expect(() => {
        (instance as any).handleWebSocketMessage({
          method: 'eth_subscription',
          params: {
            result: {
              topics: ['0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1'],
              address: '0xtest',
              data: '0x' + '00'.repeat(128),
              blockNumber: '0x1',
            },
          },
        });
      }).not.toThrow();
    });

    it('should route factory events when factory mode is enabled', () => {
      const instance = createInstance();
      (instance as any).isRunning = true;
      (instance as any).isStopping = false;
      (instance as any).useFactoryMode = true;

      // Set up a mock factory service
      (instance as any).factorySubscriptionService = {
        handleFactoryEvent: mockHandleFactoryEvent,
      };

      const factoryLog = {
        topics: ['0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9'],
        address: '0xfactory',
        data: '0x' + '00'.repeat(128),
        blockNumber: '0x1',
      };

      (instance as any).handleWebSocketMessage({
        method: 'eth_subscription',
        params: { result: factoryLog },
      });

      expect(mockHandleFactoryEvent).toHaveBeenCalledWith(factoryLog);
    });

    it('should catch errors from factory event handling', () => {
      const instance = createInstance();
      (instance as any).isRunning = true;
      (instance as any).isStopping = false;
      (instance as any).useFactoryMode = true;

      // Set up factory service that throws
      (instance as any).factorySubscriptionService = {
        handleFactoryEvent: jest.fn().mockImplementation(() => {
          throw new Error('Factory error');
        }),
      };

      const factoryLog = {
        topics: ['0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9'],
        address: '0xfactory',
        data: '0x' + '00'.repeat(128),
        blockNumber: '0x1',
      };

      // Should not throw
      expect(() => {
        (instance as any).handleWebSocketMessage({
          method: 'eth_subscription',
          params: { result: factoryLog },
        });
      }).not.toThrow();
    });
  });

  // ===========================================================================
  // handlePairCreatedEvent (private, accessed via any)
  // ===========================================================================

  describe('handlePairCreatedEvent', () => {
    it('should skip events with missing token0', () => {
      const instance = createInstance();

      (instance as any).handlePairCreatedEvent({
        pairAddress: '0xnewpair',
        token0: '',
        token1: '0xtoken1',
        dexName: 'uniswap',
        blockNumber: 100,
      });

      expect((instance as any).pairsByAddress.has('0xnewpair')).toBe(false);
    });

    it('should skip events with zero address token0', () => {
      const instance = createInstance();

      (instance as any).handlePairCreatedEvent({
        pairAddress: '0xnewpair',
        token0: '0x0000000000000000000000000000000000000000',
        token1: '0xtoken1',
        dexName: 'uniswap',
        blockNumber: 100,
      });

      expect((instance as any).pairsByAddress.has('0xnewpair')).toBe(false);
    });

    it('should skip events with missing token1', () => {
      const instance = createInstance();

      (instance as any).handlePairCreatedEvent({
        pairAddress: '0xnewpair',
        token0: '0xtoken0',
        token1: '',
        dexName: 'uniswap',
        blockNumber: 100,
      });

      expect((instance as any).pairsByAddress.has('0xnewpair')).toBe(false);
    });

    it('should skip already-existing pairs', async () => {
      const instance = createInstance();

      // Initialize pairs to populate pairsByAddress
      await (instance as any).initializePairs();

      const existingPair = (instance as any).pairsByAddress.keys().next().value;
      if (!existingPair) return; // Skip if no pairs initialized

      const initialSize = (instance as any).pairsByAddress.size;

      (instance as any).handlePairCreatedEvent({
        pairAddress: existingPair,
        token0: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        token1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        dexName: 'uniswap',
        blockNumber: 100,
      });

      expect((instance as any).pairsByAddress.size).toBe(initialSize);
    });

    it('should add pairs with unknown tokens using address prefix as symbol', () => {
      // getTokenSymbol() falls back to address.slice(0, 8) for unknown tokens,
      // so unknown token pairs are still added with address-prefix symbols.
      const instance = createInstance();

      (instance as any).handlePairCreatedEvent({
        pairAddress: '0xNewPairUnknown12345678901234567890123456',
        token0: '0xunknownToken000000000000000000000000000001',
        token1: '0xunknownToken000000000000000000000000000002',
        dexName: 'uniswap',
        blockNumber: 100,
      });

      expect((instance as any).pairsByAddress.has(
        '0xnewpairunknown12345678901234567890123456'
      )).toBe(true);
    });

    it('should add valid new pair to all tracking maps', () => {
      const instance = createInstance();

      // Use actual token addresses from CORE_TOKENS.ethereum
      (instance as any).handlePairCreatedEvent({
        pairAddress: '0xNewPairAddress123456789012345678901234567890',
        token0: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        token1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        dexName: 'sushiswap',
        fee: 30,
        blockNumber: 100,
      });

      const pairAddress = '0xnewpairaddress123456789012345678901234567890';

      // Should be in pairsByAddress
      expect((instance as any).pairsByAddress.has(pairAddress)).toBe(true);

      // Should be in pairs Map
      const pair = (instance as any).pairsByAddress.get(pairAddress);
      expect(pair).toBeDefined();
      expect(pair.dex).toBe('sushiswap');
      expect(pair.token0).toBe('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
      expect(pair.token1).toBe('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    });

    it('should add pair to pairAddressesCache', () => {
      const instance = createInstance();
      const initialCacheLength = (instance as any).pairAddressesCache.length;

      (instance as any).handlePairCreatedEvent({
        pairAddress: '0xNewPairAddress123456789012345678901234567890',
        token0: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        token1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        dexName: 'sushiswap',
        fee: 30,
        blockNumber: 100,
      });

      expect((instance as any).pairAddressesCache.length).toBe(initialCacheLength + 1);
    });

    it('should add pair to pairsByTokens index', () => {
      const instance = createInstance();

      (instance as any).handlePairCreatedEvent({
        pairAddress: '0xNewPairAddress123456789012345678901234567890',
        token0: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        token1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        dexName: 'sushiswap',
        fee: 30,
        blockNumber: 100,
      });

      // pairsByTokens should have an entry for this token pair
      expect((instance as any).pairsByTokens.size).toBeGreaterThan(0);
    });

    it('should emit pairDiscovered event', () => {
      const instance = createInstance();
      const handler = jest.fn();
      instance.on('pairDiscovered', handler);

      (instance as any).handlePairCreatedEvent({
        pairAddress: '0xNewPairAddress123456789012345678901234567890',
        token0: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        token1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        dexName: 'sushiswap',
        fee: 30,
        blockNumber: 100,
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          dex: 'sushiswap',
          blockNumber: 100,
        })
      );
    });

    it('should normalize pair address to lowercase', () => {
      const instance = createInstance();

      (instance as any).handlePairCreatedEvent({
        pairAddress: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
        token0: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        token1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        dexName: 'sushiswap',
        fee: 30,
        blockNumber: 100,
      });

      const pairAddress = '0xabcdef1234567890abcdef1234567890abcdef12';
      expect((instance as any).pairsByAddress.has(pairAddress)).toBe(true);
    });

    it('should set default fee when no fee provided', () => {
      const instance = createInstance();

      (instance as any).handlePairCreatedEvent({
        pairAddress: '0xNewPairAddress123456789012345678901234567890',
        token0: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        token1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        dexName: 'sushiswap',
        blockNumber: 100,
        // No fee provided
      });

      const pair = (instance as any).pairsByAddress.get(
        '0xnewpairaddress123456789012345678901234567890'
      );
      expect(pair).toBeDefined();
      expect(pair.fee).toBeDefined();
    });
  });

  // ===========================================================================
  // isFactoryEventSignature (private, accessed via any)
  // Note: subscribeToEvents, subscribeViaLegacyMode, subscribeViaFactoryMode
  // tests moved to subscription-manager.test.ts
  // ===========================================================================

  describe('isFactoryEventSignature', () => {
    it('should recognize PairCreated signature', () => {
      const instance = createInstance();

      expect(
        (instance as any).isFactoryEventSignature(
          '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9'
        )
      ).toBe(true);
    });

    it('should recognize PoolCreated signature', () => {
      const instance = createInstance();

      expect(
        (instance as any).isFactoryEventSignature(
          '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118'
        )
      ).toBe(true);
    });

    it('should reject unknown signatures', () => {
      const instance = createInstance();

      expect(
        (instance as any).isFactoryEventSignature('0x1234567890abcdef')
      ).toBe(false);
    });

    it('should be case-insensitive', () => {
      const instance = createInstance();

      expect(
        (instance as any).isFactoryEventSignature(
          '0x0D3648BD0F6BA80134A33BA9275AC585D9D315F0AD8355CDDEFDE31AFA28D0E9'
        )
      ).toBe(true);
    });
  });

  // ===========================================================================
  // getStats (public)
  // ===========================================================================

  describe('getStats', () => {
    it('should include subscription stats', () => {
      const instance = createInstance();
      const stats = instance.getStats();

      expect(stats).toBeDefined();
      expect(stats.chainId).toBe('ethereum');
      expect(stats.status).toBe('disconnected');
      expect(stats.pairsMonitored).toBe(0);
    });
  });

  // ===========================================================================
  // Lifecycle integration: start/stop with WebSocket
  // ===========================================================================

  describe('lifecycle integration', () => {
    it('should handle stop when not started', async () => {
      const instance = createInstance();
      // Should not throw
      await instance.stop();
    });

    it('should prevent double start', async () => {
      const instance = createInstance();

      // Start twice concurrently
      const [result1, result2] = await Promise.all([
        instance.start(),
        instance.start(),
      ]);

      // Both should resolve without error
      expect(result1).toBeUndefined();
      expect(result2).toBeUndefined();
    });
  });
});
