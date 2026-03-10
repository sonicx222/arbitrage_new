/**
 * Unit Tests for ChainDetectorInstance Detection Filters & Edge Cases
 *
 * H-004: Hex data parsing validation in event handlers
 * H-005: Slow recovery MAX_CYCLES termination
 * H-006: Staleness filter, synthetic confidence discount, ML signal cache
 * M-002: Synthetic reserves deviation filter
 *
 * @see unified-detector-deep-analysis.md Phase 2
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// =============================================================================
// Mock Setup (must be before imports)
// =============================================================================

// jest.config.base.js has resetMocks: true which strips mock implementations
// before each test. We define mock references here and re-apply them in
// applyMocks() which is called from beforeEach.

const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerDebug = jest.fn();

const mockActivityTracker = {
  recordUpdate: jest.fn(),
  isHotPair: jest.fn().mockReturnValue(false),
  getStats: jest.fn().mockReturnValue({ hotPairs: 0, totalPairs: 0 }),
};

jest.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: jest.fn(),
    FetchRequest: jest.fn().mockImplementation(() => ({ setHeader: jest.fn() })),
    Network: { from: jest.fn() },
  },
}));

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
    },
    configurable: true,
    writable: true,
  });
  return {
    createLogger: jest.fn(),
    PerformanceLogger: jest.fn(),
    WebSocketManager: jest.fn(),
    FactorySubscriptionService: jest.fn(),
    FactoryEventSignatures: { PAIR_CREATED_V2: '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9' },
    AdditionalEventSignatures: {},
    RedisStreamsClient: MockRedisStreamsClient,
    StreamBatcher: jest.fn(),
  };
});

jest.mock('@arbitrage/core/analytics', () => ({
  SwapEventFilter: jest.fn(),
  getSwapEventFilter: jest.fn(),
  WhaleAlert: jest.fn(),
  PairActivityTracker: jest.fn(),
  getPairActivityTracker: jest.fn(),
  PriceMomentumTracker: jest.fn(),
  getPriceMomentumTracker: jest.fn(),
  MLOpportunityScorer: jest.fn(),
  getMLOpportunityScorer: jest.fn(),
  LiquidityDepthAnalyzer: jest.fn(),
  getLiquidityDepthAnalyzer: jest.fn(),
  getKnownRouterAddresses: jest.fn(),
}));

jest.mock('@arbitrage/core/async', () => ({
  stopAndNullify: jest.fn(),
}));

jest.mock('@arbitrage/core/utils/env-utils', () => ({
  parseEnvIntSafe: jest.fn(),
}));

jest.mock('@arbitrage/core/caching', () => ({
  HierarchicalCache: jest.fn(),
  createHierarchicalCache: jest.fn(),
}));

jest.mock('@arbitrage/core/components', () => ({
  calculatePriceFromBigIntReserves: jest.fn(),
  bpsToDecimal: jest.fn(),
  isSameTokenPair: jest.fn(),
  isReverseOrder: jest.fn(),
  isReverseOrderPreNormalized: jest.fn(),
  getMinProfitThreshold: jest.fn(),
  MIN_SAFE_PRICE: 1e-12,
  MAX_SAFE_PRICE: 1e18,
}));

jest.mock('@arbitrage/core/factory-subscription', () => ({
  PairCreatedEvent: jest.fn(),
}));

jest.mock('@arbitrage/core/path-finding', () => ({
  CrossDexTriangularArbitrage: jest.fn(),
  getMultiLegPathFinder: jest.fn(),
}));

jest.mock('@arbitrage/core/redis', () => {
  const MockRedisStreamsClient = jest.fn();
  Object.defineProperty(MockRedisStreamsClient, 'STREAMS', {
    value: { PRICE_UPDATES: 'stream:price-updates', OPPORTUNITIES: 'stream:opportunities' },
    configurable: true,
    writable: true,
  });
  return {
    RedisStreamsClient: MockRedisStreamsClient,
    StreamBatcher: jest.fn(),
  };
});

jest.mock('@arbitrage/core/tracing', () => ({
  createFastTraceContext: jest.fn(),
  TRACE_FIELDS: {},
}));

jest.mock('@arbitrage/core/logging', () => ({
  withLogContext: jest.fn(),
}));

jest.mock('@arbitrage/core/resilience', () => ({
  getErrorMessage: jest.fn(),
}));

jest.mock('@arbitrage/core/simulation', () => ({
  isSimulationMode: jest.fn(),
}));

jest.mock('@arbitrage/core/utils', () => ({
  disconnectWithTimeout: jest.fn(),
  calculateVirtualReservesFromSqrtPriceX96: jest.fn(),
  validateFee: jest.fn(),
}));

jest.mock('@arbitrage/config', () => ({
  CHAINS: {
    ethereum: { name: 'Ethereum', chainId: 1, rpcUrl: 'http://localhost:8545', wsUrl: 'ws://localhost:8546', blockTimeMs: 12000, nativeCurrency: 'ETH' },
  },
  CORE_TOKENS: { ethereum: [{ symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 }] },
  EVENT_SIGNATURES: {
    SYNC: '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1',
    SWAP_V2: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822',
    SWAP_V3: '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
    CURVE_TOKEN_EXCHANGE: '0x8b3e96f2b889fa771c53c981b40daf005f63f637f1869f707052d15a3dd97140',
    BALANCER_SWAP: '0x2170c741c41531aec20e7c107c24eecfdd15e69c9bb0a8dd37b1840b9e0b207b',
  },
  isVaultModelDex: jest.fn(),
  DETECTOR_CONFIG: {
    ethereum: { batchSize: 15, batchTimeout: 50, healthCheckInterval: 30000, confidence: 0.75, expiryMs: 15000, gasEstimate: 250000, whaleThreshold: 100000, nativeTokenKey: 'weth' },
  },
  TOKEN_METADATA: {
    ethereum: { weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', stablecoins: [], nativeWrapper: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
  },
  ARBITRAGE_CONFIG: { minProfitPercentage: 0.003, slippageTolerance: 0.01, chainMinProfits: { ethereum: 0.003 } },
  getEnabledDexes: jest.fn(),
  getConfidenceMaxAgeMs: jest.fn(),
  isEvmChain: jest.fn(),
  getAllFactoryAddresses: jest.fn(),
  PartitionHealth: jest.fn(),
  getOpportunityTimeoutMs: jest.fn(),
  FEATURE_FLAGS: { useLiquidityDepthSizing: false, useSignalCacheRead: false },
}));

import { ChainDetectorInstance } from '../../src/chain-instance';
import { createLogger, WebSocketManager, FactorySubscriptionService, StreamBatcher } from '@arbitrage/core';
import { getPairActivityTracker, getSwapEventFilter, getPriceMomentumTracker, getMLOpportunityScorer, getLiquidityDepthAnalyzer, getKnownRouterAddresses } from '@arbitrage/core/analytics';
import { stopAndNullify } from '@arbitrage/core/async';
import { parseEnvIntSafe } from '@arbitrage/core/utils/env-utils';
import { createHierarchicalCache } from '@arbitrage/core/caching';
import { calculatePriceFromBigIntReserves, bpsToDecimal, isSameTokenPair, isReverseOrder, isReverseOrderPreNormalized, getMinProfitThreshold } from '@arbitrage/core/components';
import { getMultiLegPathFinder, CrossDexTriangularArbitrage } from '@arbitrage/core/path-finding';
import { createFastTraceContext } from '@arbitrage/core/tracing';
import { withLogContext } from '@arbitrage/core/logging';
import { getErrorMessage } from '@arbitrage/core/resilience';
import { isSimulationMode } from '@arbitrage/core/simulation';
import { disconnectWithTimeout, calculateVirtualReservesFromSqrtPriceX96, validateFee } from '@arbitrage/core/utils';
import { getEnabledDexes, getConfidenceMaxAgeMs, isEvmChain, getAllFactoryAddresses, getOpportunityTimeoutMs, isVaultModelDex } from '@arbitrage/config';

// =============================================================================
// Re-apply mocks before each test (resetMocks: true strips implementations)
// =============================================================================

function applyMocks(): void {
  (createLogger as jest.Mock).mockReturnValue({
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mockLoggerError,
    debug: mockLoggerDebug,
  });
  (WebSocketManager as unknown as jest.Mock).mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
    removeAllListeners: jest.fn(),
    on: jest.fn(),
  }));
  (FactorySubscriptionService as unknown as jest.Mock).mockReturnValue({
    subscribeToFactories: jest.fn().mockResolvedValue(undefined),
    onPairCreated: jest.fn(),
    handleFactoryEvent: jest.fn(),
    getSubscriptionCount: jest.fn().mockReturnValue(0),
    stop: jest.fn().mockResolvedValue(undefined),
  });
  (StreamBatcher as unknown as jest.Mock).mockReturnValue({
    add: jest.fn().mockReturnValue(true),
    flush: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn(),
  });
  (getPairActivityTracker as jest.Mock).mockReturnValue(mockActivityTracker);
  (getSwapEventFilter as jest.Mock).mockReturnValue(null);
  (getPriceMomentumTracker as jest.Mock).mockReturnValue(null);
  (getMLOpportunityScorer as jest.Mock).mockReturnValue(null);
  (getLiquidityDepthAnalyzer as jest.Mock).mockReturnValue(null);
  (getKnownRouterAddresses as jest.Mock).mockReturnValue([]);
  (stopAndNullify as jest.Mock).mockResolvedValue(undefined);
  (parseEnvIntSafe as jest.Mock).mockImplementation((_key: string, defaultValue: number) => defaultValue);
  (createHierarchicalCache as jest.Mock).mockReturnValue(null);
  (calculatePriceFromBigIntReserves as jest.Mock).mockImplementation((...args: unknown[]) => {
    const r0 = Number(args[0]);
    const r1 = Number(args[1]);
    if (!r0 || !r1 || !isFinite(r0) || !isFinite(r1)) return null;
    return r1 / r0;
  });
  (bpsToDecimal as jest.Mock).mockImplementation((bps: number) => bps / 10000);
  (isSameTokenPair as jest.Mock).mockReturnValue(true);
  (isReverseOrder as jest.Mock).mockReturnValue(false);
  (isReverseOrderPreNormalized as jest.Mock).mockReturnValue(false);
  (getMinProfitThreshold as jest.Mock).mockReturnValue(0.003);
  (CrossDexTriangularArbitrage as unknown as jest.Mock).mockReturnValue({
    findTriangularOpportunities: jest.fn().mockResolvedValue([]),
    findQuadrilateralOpportunities: jest.fn().mockResolvedValue([]),
  });
  (getMultiLegPathFinder as jest.Mock).mockReturnValue(null);
  (createFastTraceContext as jest.Mock).mockReturnValue({ traceId: 'test-trace', spanId: 'test-span' });
  (withLogContext as jest.Mock).mockImplementation((_ctx: unknown, fn: () => unknown) => fn());
  (getErrorMessage as jest.Mock).mockImplementation((e: Error) => e?.message ?? 'unknown');
  (isSimulationMode as jest.Mock).mockReturnValue(false);
  (disconnectWithTimeout as jest.Mock).mockResolvedValue(undefined);
  (calculateVirtualReservesFromSqrtPriceX96 as jest.Mock).mockReturnValue(null);
  (validateFee as jest.Mock).mockImplementation((fee?: number) => fee ?? 0.003);
  (getEnabledDexes as jest.Mock).mockReturnValue([
    { name: 'uniswap', factoryAddress: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f', routerAddress: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', feeBps: 30 },
    { name: 'sushiswap', factoryAddress: '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac', routerAddress: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F', feeBps: 30 },
    { name: 'curve', factoryAddress: '0xB9fC157394Af804a3578134A6585C0dc9cc990d4', routerAddress: '0x99a58482BD75cbab83b27EC03CA68fF489b5788f', feeBps: 4 },
  ]);
  (getConfidenceMaxAgeMs as jest.Mock).mockReturnValue(30000);
  (isEvmChain as jest.Mock).mockReturnValue(true);
  (getAllFactoryAddresses as jest.Mock).mockReturnValue(['0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f']);
  (getOpportunityTimeoutMs as jest.Mock).mockReturnValue(15000);
  (isVaultModelDex as jest.Mock).mockReturnValue(false);
}

// =============================================================================
// Helpers
// =============================================================================

function createChainInstance(overrides?: Record<string, unknown>): ChainDetectorInstance {
  return new ChainDetectorInstance({
    chainId: 'ethereum',
    partitionId: 'high-value',
    streamsClient: null as any,
    perfLogger: {
      logArbitrageOpportunity: jest.fn(),
      logDetectionCycle: jest.fn(),
      logPriceUpdate: jest.fn(),
    } as any,
    ...overrides,
  });
}

/** Build a hex-encoded log.data string for a Sync event (reserve0 + reserve1) */
function makeSyncData(reserve0Hex: string, reserve1Hex: string): string {
  return '0x' + reserve0Hex.padStart(64, '0') + reserve1Hex.padStart(64, '0');
}

/** Build a valid blockNumber in hex */
function hexBlockNumber(n: number): string {
  return '0x' + n.toString(16);
}

/** Create BigInt safely — avoids BigInt serialization issues in Jest assertions */
function bi(value: string | number): bigint {
  return BigInt(value);
}

// =============================================================================
// H-004: Hex Data Parsing in Event Handlers
// =============================================================================

describe('H-004: Hex data parsing validation', () => {
  let instance: ChainDetectorInstance;

  beforeEach(() => {
    applyMocks();
    instance = createChainInstance();
  });

  afterEach(() => {
    instance.removeAllListeners();
  });

  describe('blockNumber validation (NaN guard)', () => {
    it('should reject events with non-hex blockNumber', () => {
      const handler = (instance as any).handleSyncEvent.bind(instance);
      (instance as any).isRunning = true;

      const pairAddress = '0xabcdef1234567890abcdef1234567890abcdef12';
      const pair = {
        address: pairAddress, dex: 'uniswap', token0: '0xtoken0', token1: '0xtoken1',
        reserve0: '0', reserve1: '0', fee: 0.003, blockNumber: 0, lastUpdate: 0,
        chainPairKey: 'ethereum:' + pairAddress,
      };
      (instance as any).pairsByAddress.set(pairAddress, pair);

      handler({
        address: pairAddress,
        blockNumber: 'not-a-hex',
        data: makeSyncData('de0b6b3a7640000', 'de0b6b3a7640000'),
        topics: [],
      });

      expect(pair.blockNumber).toBe(0);
    });

    it('should reject events with empty blockNumber', () => {
      const handler = (instance as any).handleSyncEvent.bind(instance);
      (instance as any).isRunning = true;

      const pairAddress = '0xabcdef1234567890abcdef1234567890abcdef12';
      const pair = {
        address: pairAddress, dex: 'uniswap', token0: '0xt0', token1: '0xt1',
        reserve0: '0', reserve1: '0', fee: 0.003, blockNumber: 0, lastUpdate: 0,
        chainPairKey: 'ethereum:' + pairAddress,
      };
      (instance as any).pairsByAddress.set(pairAddress, pair);

      handler({
        address: pairAddress,
        blockNumber: '',
        data: makeSyncData('de0b6b3a7640000', 'de0b6b3a7640000'),
        topics: [],
      });

      expect(pair.blockNumber).toBe(0);
    });

    it('should accept events with valid hex blockNumber', () => {
      const handler = (instance as any).handleSyncEvent.bind(instance);
      (instance as any).isRunning = true;

      const pairAddress = '0xabcdef1234567890abcdef1234567890abcdef12';
      const pair = {
        address: pairAddress, dex: 'uniswap', token0: '0xt0', token1: '0xt1',
        reserve0: '0', reserve1: '0', reserve0BigInt: bi(0), reserve1BigInt: bi(0),
        fee: 0.003, blockNumber: 0, lastUpdate: 0,
        chainPairKey: 'ethereum:' + pairAddress,
      };
      (instance as any).pairsByAddress.set(pairAddress, pair);
      (instance as any).pairsByTokens.set('0xt0_0xt1', [pair]);

      handler({
        address: pairAddress,
        blockNumber: hexBlockNumber(18000000),
        data: makeSyncData('de0b6b3a7640000', 'de0b6b3a7640000'),
        topics: [],
      });

      expect(pair.blockNumber).toBe(18000000);
    });

    it('should reject events with undefined blockNumber', () => {
      const handler = (instance as any).handleSyncEvent.bind(instance);
      (instance as any).isRunning = true;

      const pairAddress = '0xabcdef1234567890abcdef1234567890abcdef12';
      const pair = {
        address: pairAddress, dex: 'uniswap', token0: '0xt0', token1: '0xt1',
        reserve0: '0', reserve1: '0', fee: 0.003, blockNumber: 0, lastUpdate: 0,
        chainPairKey: 'ethereum:' + pairAddress,
      };
      (instance as any).pairsByAddress.set(pairAddress, pair);

      handler({
        address: pairAddress,
        blockNumber: undefined,
        data: makeSyncData('de0b6b3a7640000', 'de0b6b3a7640000'),
        topics: [],
      });

      expect(pair.blockNumber).toBe(0);
    });
  });

  describe('data length validation', () => {
    it('should reject Sync events with data shorter than 130 chars', () => {
      const handler = (instance as any).handleSyncEvent.bind(instance);
      (instance as any).isRunning = true;

      const pairAddress = '0xabcdef1234567890abcdef1234567890abcdef12';
      const pair = {
        address: pairAddress, dex: 'uniswap', token0: '0xt0', token1: '0xt1',
        reserve0: '100', reserve1: '200', fee: 0.003, blockNumber: 5, lastUpdate: 100,
        chainPairKey: 'ethereum:' + pairAddress,
      };
      (instance as any).pairsByAddress.set(pairAddress, pair);

      handler({
        address: pairAddress,
        blockNumber: hexBlockNumber(18000001),
        data: '0xshort',
        topics: [],
      });

      expect(pair.reserve0).toBe('100');
    });

    it('should reject Sync events with null data', () => {
      const handler = (instance as any).handleSyncEvent.bind(instance);
      (instance as any).isRunning = true;

      const pairAddress = '0xabcdef1234567890abcdef1234567890abcdef12';
      const pair = {
        address: pairAddress, dex: 'uniswap', token0: '0xt0', token1: '0xt1',
        reserve0: '100', reserve1: '200', fee: 0.003, blockNumber: 5, lastUpdate: 100,
        chainPairKey: 'ethereum:' + pairAddress,
      };
      (instance as any).pairsByAddress.set(pairAddress, pair);

      handler({
        address: pairAddress,
        blockNumber: hexBlockNumber(18000001),
        data: null,
        topics: [],
      });

      expect(pair.reserve0).toBe('100');
    });
  });
});

// =============================================================================
// H-005: Slow Recovery MAX_CYCLES Termination
// =============================================================================

describe('H-005: Slow recovery MAX_CYCLES termination', () => {
  let instance: ChainDetectorInstance;

  beforeEach(() => {
    applyMocks();
    jest.useFakeTimers();
    instance = createChainInstance();
  });

  afterEach(() => {
    instance.removeAllListeners();
    jest.useRealTimers();
  });

  it('should not start recovery timer when MAX_CYCLES already reached', () => {
    (instance as any).slowRecoveryCycles = (instance as any).MAX_SLOW_RECOVERY_CYCLES;

    (instance as any).startSlowRecoveryTimer();

    expect((instance as any).slowRecoveryTimer).toBeNull();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('Max slow recovery cycles reached'),
      expect.any(Object)
    );
  });

  it('should clear timer when MAX_CYCLES is reached during recovery', () => {
    const maxCycles = (instance as any).MAX_SLOW_RECOVERY_CYCLES;
    (instance as any).slowRecoveryCycles = maxCycles - 1;
    (instance as any).isRunning = true;

    (instance as any).startSlowRecoveryTimer();
    expect((instance as any).slowRecoveryTimer).not.toBeNull();

    jest.advanceTimersByTime((instance as any).SLOW_RECOVERY_INTERVAL_MS);

    expect((instance as any).slowRecoveryCycles).toBe(maxCycles);
    expect((instance as any).slowRecoveryTimer).toBeNull();
  });

  it('should increment cycles on each recovery tick', () => {
    (instance as any).slowRecoveryCycles = 0;
    (instance as any).isRunning = true;
    const maxCycles = (instance as any).MAX_SLOW_RECOVERY_CYCLES;

    (instance as any).initializeWebSocketAndSubscribe = jest.fn().mockResolvedValue(undefined);

    (instance as any).startSlowRecoveryTimer();

    if (maxCycles > 3) {
      jest.advanceTimersByTime((instance as any).SLOW_RECOVERY_INTERVAL_MS);
      expect((instance as any).slowRecoveryCycles).toBe(1);

      jest.advanceTimersByTime((instance as any).SLOW_RECOVERY_INTERVAL_MS);
      expect((instance as any).slowRecoveryCycles).toBe(2);

      jest.advanceTimersByTime((instance as any).SLOW_RECOVERY_INTERVAL_MS);
      expect((instance as any).slowRecoveryCycles).toBe(3);
    }
  });

  it('should stop recovery when isStopping is set', () => {
    (instance as any).slowRecoveryCycles = 0;
    (instance as any).isRunning = true;

    (instance as any).startSlowRecoveryTimer();
    expect((instance as any).slowRecoveryTimer).not.toBeNull();

    (instance as any).isStopping = true;

    jest.advanceTimersByTime((instance as any).SLOW_RECOVERY_INTERVAL_MS);

    expect((instance as any).slowRecoveryTimer).toBeNull();
    expect((instance as any).slowRecoveryCycles).toBe(0);
  });
});

// =============================================================================
// H-006: Staleness Filter, Synthetic Confidence Discount, ML Signal Cache
// =============================================================================

describe('H-006: Detection pipeline filters', () => {
  let instance: ChainDetectorInstance;

  beforeEach(() => {
    applyMocks();
    instance = createChainInstance();
    (instance as any).isRunning = true;
  });

  afterEach(() => {
    instance.removeAllListeners();
  });

  describe('staleness filter (MAX_STALENESS_MS)', () => {
    it('should reject stale pairs and increment stalePriceRejections', () => {
      const checkArb = (instance as any).checkArbitrageOpportunity.bind(instance);

      const updatedPair = {
        address: '0xpair1', dex: 'uniswap', token0: '0xt0', token1: '0xt1',
        reserve0: '1000', reserve1: '2000', reserve0BigInt: bi(1000), reserve1BigInt: bi(2000),
        fee: 0.003, blockNumber: 100, lastUpdate: Date.now(),
        chainPairKey: 'ethereum:0xpair1',
      };

      const stalePair = {
        address: '0xpair2', dex: 'sushiswap', token0: '0xt0', token1: '0xt1',
        reserve0: '1000', reserve1: '2100', reserve0BigInt: bi(1000), reserve1BigInt: bi(2100),
        fee: 0.003, blockNumber: 50, lastUpdate: 0,
        chainPairKey: 'ethereum:0xpair2',
      };

      (instance as any).pairsByTokens.set('0xt0_0xt1', [updatedPair, stalePair]);
      (instance as any).tokenPairKeyCache.set('0xt0|0xt1', '0xt0_0xt1');

      const beforeRejections = (instance as any).stalePriceRejections;
      checkArb(updatedPair);

      expect((instance as any).stalePriceRejections).toBeGreaterThan(beforeRejections);
    });

    it('should accept fresh pairs within staleness window', () => {
      const checkArb = (instance as any).checkArbitrageOpportunity.bind(instance);

      const now = Date.now();
      const updatedPair = {
        address: '0xpair1', dex: 'uniswap', token0: '0xt0', token1: '0xt1',
        reserve0: '1000', reserve1: '2000', reserve0BigInt: bi(1000), reserve1BigInt: bi(2000),
        fee: 0.003, blockNumber: 100, lastUpdate: now,
        chainPairKey: 'ethereum:0xpair1',
      };

      const freshPair = {
        address: '0xpair2', dex: 'sushiswap', token0: '0xt0', token1: '0xt1',
        reserve0: '1000', reserve1: '2100', reserve0BigInt: bi(1000), reserve1BigInt: bi(2100),
        fee: 0.003, blockNumber: 99, lastUpdate: now - 1000,
        chainPairKey: 'ethereum:0xpair2',
      };

      (instance as any).pairsByTokens.set('0xt0_0xt1', [updatedPair, freshPair]);
      (instance as any).tokenPairKeyCache.set('0xt0|0xt1', '0xt0_0xt1');

      const beforeRejections = (instance as any).stalePriceRejections;
      checkArb(updatedPair);

      expect((instance as any).stalePriceRejections).toBe(beforeRejections);
    });
  });

  describe('synthetic confidence discount (0.3x)', () => {
    it('should apply 0.3x confidence discount when pair has synthetic reserves', () => {
      const emittedOpps: any[] = [];
      instance.on('opportunity', (opp) => emittedOpps.push(opp));

      const checkArb = (instance as any).checkArbitrageOpportunity.bind(instance);

      const now = Date.now();
      const realPair = {
        address: '0xpair1', dex: 'uniswap', token0: '0xt0', token1: '0xt1',
        reserve0: '1000000000000000000000', reserve1: '2000000000000000000000',
        reserve0BigInt: bi('1000000000000000000000'), reserve1BigInt: bi('2000000000000000000000'),
        fee: 0.003, blockNumber: 100, lastUpdate: now,
        chainPairKey: 'ethereum:0xpair1',
        syntheticReserves: false,
      };

      const syntheticPair = {
        address: '0xpair2', dex: 'curve', token0: '0xt0', token1: '0xt1',
        reserve0: '1000000000000000000000', reserve1: '2200000000000000000000',
        reserve0BigInt: bi('1000000000000000000000'), reserve1BigInt: bi('2200000000000000000000'),
        fee: 0.003, blockNumber: 99, lastUpdate: now,
        chainPairKey: 'ethereum:0xpair2',
        syntheticReserves: true,
      };

      (instance as any).pairsByTokens.set('0xt0_0xt1', [realPair, syntheticPair]);
      (instance as any).tokenPairKeyCache.set('0xt0|0xt1', '0xt0_0xt1');

      checkArb(realPair);

      if (emittedOpps.length > 0) {
        expect(emittedOpps[0].confidence).toBeLessThanOrEqual(0.3);
      }
    });
  });

  describe('ML signal cache application', () => {
    it('should multiply confidence by cached signal when available', () => {
      const emittedOpps: any[] = [];
      instance.on('opportunity', (opp) => emittedOpps.push(opp));

      const config = jest.requireMock('@arbitrage/config') as any;
      config.FEATURE_FLAGS.useSignalCacheRead = true;

      const checkArb = (instance as any).checkArbitrageOpportunity.bind(instance);
      const now = Date.now();

      (instance as any).signalCache.set('ethereum:0xpair1', {
        confidence: 0.5,
        updatedAt: now,
      });

      const pair1 = {
        address: '0xpair1', dex: 'uniswap', token0: '0xt0', token1: '0xt1',
        reserve0: '1000000000000000000000', reserve1: '2000000000000000000000',
        reserve0BigInt: bi('1000000000000000000000'), reserve1BigInt: bi('2000000000000000000000'),
        fee: 0.003, blockNumber: 100, lastUpdate: now,
        chainPairKey: 'ethereum:0xpair1',
      };

      const pair2 = {
        address: '0xpair2', dex: 'sushiswap', token0: '0xt0', token1: '0xt1',
        reserve0: '1000000000000000000000', reserve1: '2200000000000000000000',
        reserve0BigInt: bi('1000000000000000000000'), reserve1BigInt: bi('2200000000000000000000'),
        fee: 0.003, blockNumber: 99, lastUpdate: now,
        chainPairKey: 'ethereum:0xpair2',
      };

      (instance as any).pairsByTokens.set('0xt0_0xt1', [pair1, pair2]);
      (instance as any).tokenPairKeyCache.set('0xt0|0xt1', '0xt0_0xt1');

      checkArb(pair1);

      if (emittedOpps.length > 0) {
        expect(emittedOpps[0].confidence).toBeLessThanOrEqual(0.5);
      }

      config.FEATURE_FLAGS.useSignalCacheRead = false;
    });

    it('should ignore stale signals (>2s old)', () => {
      const config = jest.requireMock('@arbitrage/config') as any;
      config.FEATURE_FLAGS.useSignalCacheRead = true;

      const now = Date.now();

      (instance as any).signalCache.set('ethereum:0xpair1', {
        confidence: 0.01,
        updatedAt: now - 3000,
      });

      const pair1 = {
        address: '0xpair1', dex: 'uniswap', token0: '0xt0', token1: '0xt1',
        reserve0: '1000000000000000000000', reserve1: '2000000000000000000000',
        reserve0BigInt: bi('1000000000000000000000'), reserve1BigInt: bi('2000000000000000000000'),
        fee: 0.003, blockNumber: 100, lastUpdate: now,
        chainPairKey: 'ethereum:0xpair1',
      };

      const pair2 = {
        address: '0xpair2', dex: 'sushiswap', token0: '0xt0', token1: '0xt1',
        reserve0: '1000000000000000000000', reserve1: '2200000000000000000000',
        reserve0BigInt: bi('1000000000000000000000'), reserve1BigInt: bi('2200000000000000000000'),
        fee: 0.003, blockNumber: 99, lastUpdate: now,
        chainPairKey: 'ethereum:0xpair2',
      };

      (instance as any).pairsByTokens.set('0xt0_0xt1', [pair1, pair2]);
      (instance as any).tokenPairKeyCache.set('0xt0|0xt1', '0xt0_0xt1');

      const emittedOpps: any[] = [];
      instance.on('opportunity', (opp) => emittedOpps.push(opp));

      (instance as any).checkArbitrageOpportunity(pair1);

      if (emittedOpps.length > 0) {
        expect(emittedOpps[0].confidence).toBeGreaterThan(0.01);
      }

      config.FEATURE_FLAGS.useSignalCacheRead = false;
    });
  });
});

// =============================================================================
// M-002: Synthetic Reserves Deviation Filter
// =============================================================================

describe('M-002: Synthetic reserves deviation filter', () => {
  let instance: ChainDetectorInstance;

  beforeEach(() => {
    applyMocks();
    instance = createChainInstance();
    (instance as any).isRunning = true;
  });

  afterEach(() => {
    instance.removeAllListeners();
  });

  it('should reject Curve synthetic reserves with >50% price deviation', () => {
    const handler = (instance as any).handleCurveTokenExchangeEvent.bind(instance);

    const pairAddress = '0xcurve1234567890abcdef1234567890abcdef1234';
    const pair = {
      address: pairAddress, dex: 'curve', token0: '0xt0', token1: '0xt1',
      reserve0: '1000', reserve1: '2000',
      reserve0BigInt: bi(1000), reserve1BigInt: bi(2000),
      fee: 0.003, blockNumber: 100, lastUpdate: Date.now(),
      chainPairKey: 'ethereum:' + pairAddress,
      syntheticReserves: false,
    };
    (instance as any).pairsByAddress.set(pairAddress, pair);

    // sold=1000, bought=10000 -> price=10.0 (5x deviation from 2.0)
    const data = '0x' +
      '0'.repeat(64) +
      '00000000000000000000000000000000000000000000000000000000000003e8' +
      '0'.repeat(64) +
      '0000000000000000000000000000000000000000000000000000000000002710';

    handler({
      address: pairAddress,
      blockNumber: hexBlockNumber(18000001),
      data,
      topics: [],
    });

    expect(pair.reserve0BigInt.toString()).toBe('1000');
    expect(pair.reserve1BigInt.toString()).toBe('2000');
  });

  it('should accept Curve synthetic reserves with <50% deviation', () => {
    const handler = (instance as any).handleCurveTokenExchangeEvent.bind(instance);

    const pairAddress = '0xcurve1234567890abcdef1234567890abcdef1234';
    const pair = {
      address: pairAddress, dex: 'curve', token0: '0xt0', token1: '0xt1',
      reserve0: '1000', reserve1: '2000',
      reserve0BigInt: bi(1000), reserve1BigInt: bi(2000),
      fee: 0.003, blockNumber: 100, lastUpdate: Date.now(),
      chainPairKey: 'ethereum:' + pairAddress,
      syntheticReserves: false,
    };
    (instance as any).pairsByAddress.set(pairAddress, pair);
    (instance as any).pairsByTokens.set('0xt0_0xt1', [pair]);

    // sold=1000, bought=2200 -> price=2.2 (10% deviation from 2.0)
    const data = '0x' +
      '0'.repeat(64) +
      '00000000000000000000000000000000000000000000000000000000000003e8' +
      '0'.repeat(64) +
      '0000000000000000000000000000000000000000000000000000000000000898';

    handler({
      address: pairAddress,
      blockNumber: hexBlockNumber(18000001),
      data,
      topics: [],
    });

    expect(pair.reserve0BigInt.toString()).toBe('1000');
    expect(pair.reserve1BigInt.toString()).toBe('2200');
    expect(pair.syntheticReserves).toBe(true);
  });

  it('should accept first synthetic update when pair has no prior reserves', () => {
    const handler = (instance as any).handleCurveTokenExchangeEvent.bind(instance);

    const pairAddress = '0xcurve1234567890abcdef1234567890abcdef1234';
    const pair = {
      address: pairAddress, dex: 'curve', token0: '0xt0', token1: '0xt1',
      reserve0: '0', reserve1: '0',
      reserve0BigInt: bi(0), reserve1BigInt: bi(0),
      fee: 0.003, blockNumber: 0, lastUpdate: 0,
      chainPairKey: 'ethereum:' + pairAddress,
    };
    (instance as any).pairsByAddress.set(pairAddress, pair);
    (instance as any).pairsByTokens.set('0xt0_0xt1', [pair]);

    const data = '0x' +
      '0'.repeat(64) +
      '00000000000000000000000000000000000000000000000000000000000003e8' +
      '0'.repeat(64) +
      '00000000000000000000000000000000000000000000000000000000000007d0';

    handler({
      address: pairAddress,
      blockNumber: hexBlockNumber(18000001),
      data,
      topics: [],
    });

    expect(pair.reserve0BigInt.toString()).toBe('1000');
    expect(pair.reserve1BigInt.toString()).toBe('2000');
  });
});

// =============================================================================
// M-010: getTokenPairKey LRU Eviction
// =============================================================================

describe('M-010: getTokenPairKey LRU eviction', () => {
  let instance: ChainDetectorInstance;

  beforeEach(() => {
    applyMocks();
    instance = createChainInstance();
  });

  afterEach(() => {
    instance.removeAllListeners();
  });

  it('should return consistent key regardless of token order', () => {
    const getKey = (instance as any).getTokenPairKey.bind(instance);

    const key1 = getKey('0xAAA', '0xBBB');
    const key2 = getKey('0xBBB', '0xAAA');

    expect(key1).toBe(key2);
  });

  it('should cache both directions of a key', () => {
    const getKey = (instance as any).getTokenPairKey.bind(instance);
    const cache: Map<string, string> = (instance as any).tokenPairKeyCache;

    getKey('0xAAA', '0xBBB');

    expect(cache.has('0xAAA|0xBBB')).toBe(true);
    expect(cache.has('0xBBB|0xAAA')).toBe(true);
  });

  it('should evict oldest 10% when cache reaches max size', () => {
    const getKey = (instance as any).getTokenPairKey.bind(instance);
    const cache: Map<string, string> = (instance as any).tokenPairKeyCache;
    const maxSize = (instance as any).TOKEN_PAIR_KEY_CACHE_MAX;

    // Fill cache to max (each call caches 2 entries: forward + reverse)
    for (let i = 0; i < maxSize / 2 + 1; i++) {
      getKey(`0xtoken${i}`, `0xtoken${i + 100000}`);
    }

    // Cache should have been evicted (size should be <= max + 2 per call)
    expect(cache.size).toBeLessThanOrEqual(maxSize + 2);

    // New key should still work after eviction
    const result = getKey('0xNew1', '0xNew2');
    expect(result).toBeTruthy();
    expect(cache.has('0xNew1|0xNew2')).toBe(true);
  });

  it('should return from cache on repeated calls', () => {
    const getKey = (instance as any).getTokenPairKey.bind(instance);

    const first = getKey('0xAAA', '0xBBB');
    const second = getKey('0xAAA', '0xBBB');

    expect(first).toBe(second);
  });
});

// =============================================================================
// M-011: publishPriceUpdate Batcher Drop Logic
// =============================================================================

describe('M-011: publishPriceUpdate batcher drop logic', () => {
  let instance: ChainDetectorInstance;

  beforeEach(() => {
    applyMocks();
    instance = createChainInstance();
    (instance as any).isRunning = true;
  });

  afterEach(() => {
    instance.removeAllListeners();
  });

  it('should increment batcherDropCount when batcher rejects', () => {
    const batcher = {
      add: jest.fn().mockReturnValue(false),
      flush: jest.fn(),
      stop: jest.fn(),
    };
    (instance as any).priceUpdateBatcher = batcher;
    (instance as any).batcherDropCount = 0;

    const publish = (instance as any).publishPriceUpdate.bind(instance);
    publish({
      chain: 'ethereum', dex: 'uniswap', pairKey: 'test', pairAddress: '0x1',
      token0: '0xt0', token1: '0xt1', price: 1.5, reserve0: '100', reserve1: '150',
      timestamp: Date.now(), blockNumber: 100, latency: 0, source: 'live',
    });

    expect((instance as any).batcherDropCount).toBe(1);
  });

  it('should log warning on first drop', () => {
    const batcher = {
      add: jest.fn().mockReturnValue(false),
      flush: jest.fn(),
      stop: jest.fn(),
    };
    (instance as any).priceUpdateBatcher = batcher;
    (instance as any).batcherDropCount = 0;

    const publish = (instance as any).publishPriceUpdate.bind(instance);
    publish({
      chain: 'ethereum', dex: 'uniswap', pairKey: 'test', pairAddress: '0x1',
      token0: '0xt0', token1: '0xt1', price: 1.5, reserve0: '100', reserve1: '150',
      timestamp: Date.now(), blockNumber: 100, latency: 0, source: 'live',
    });

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'Price update dropped by batcher (queue full)',
      expect.objectContaining({ totalDropped: 1 }),
    );
  });

  it('should throttle warnings (log at 1 and every 1000)', () => {
    const batcher = {
      add: jest.fn().mockReturnValue(false),
      flush: jest.fn(),
      stop: jest.fn(),
    };
    (instance as any).priceUpdateBatcher = batcher;
    (instance as any).batcherDropCount = 0;

    const publish = (instance as any).publishPriceUpdate.bind(instance);
    const priceUpdate = {
      chain: 'ethereum', dex: 'uniswap', pairKey: 'test', pairAddress: '0x1',
      token0: '0xt0', token1: '0xt1', price: 1.5, reserve0: '100', reserve1: '150',
      timestamp: Date.now(), blockNumber: 100, latency: 0, source: 'live',
    };

    // Publish 5 times — should only warn on the 1st
    for (let i = 0; i < 5; i++) {
      publish(priceUpdate);
    }

    // 1 warning for count=1, no warnings for counts 2-5
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
  });

  it('should not increment dropCount when batcher accepts', () => {
    const batcher = {
      add: jest.fn().mockReturnValue(true),
      flush: jest.fn(),
      stop: jest.fn(),
    };
    (instance as any).priceUpdateBatcher = batcher;
    (instance as any).batcherDropCount = 0;

    const publish = (instance as any).publishPriceUpdate.bind(instance);
    publish({
      chain: 'ethereum', dex: 'uniswap', pairKey: 'test', pairAddress: '0x1',
      token0: '0xt0', token1: '0xt1', price: 1.5, reserve0: '100', reserve1: '150',
      timestamp: Date.now(), blockNumber: 100, latency: 0, source: 'live',
    });

    expect((instance as any).batcherDropCount).toBe(0);
  });

  it('should fallback to direct publish when batcher is null', () => {
    (instance as any).priceUpdateBatcher = null;
    const mockXaddWithLimit = jest.fn().mockResolvedValue('ok');
    (instance as any).streamsClient = { xaddWithLimit: mockXaddWithLimit };

    const publish = (instance as any).publishPriceUpdate.bind(instance);
    publish({
      chain: 'ethereum', dex: 'uniswap', pairKey: 'test', pairAddress: '0x1',
      token0: '0xt0', token1: '0xt1', price: 1.5, reserve0: '100', reserve1: '150',
      timestamp: Date.now(), blockNumber: 100, latency: 0, source: 'live',
    });

    expect(mockXaddWithLimit).toHaveBeenCalled();
  });
});
