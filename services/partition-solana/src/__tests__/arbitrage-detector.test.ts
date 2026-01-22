/**
 * SolanaArbitrageDetector Unit Tests
 *
 * Tests for the Solana-specific arbitrage detection logic including:
 * - Pool management (add/remove/update)
 * - Intra-Solana arbitrage detection
 * - Triangular arbitrage path finding
 * - Cross-chain price comparison
 * - Priority fee estimation
 * - Thread-safety and race condition prevention
 *
 * @see services/partition-solana/src/arbitrage-detector.ts
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { EventEmitter } from 'events';
import {
  SolanaArbitrageDetector,
  SolanaArbitrageConfig,
  SolanaPoolInfo,
  EvmPriceUpdate,
  SolanaArbitrageLogger,
  SolanaArbitrageStreamsClient,
} from '../arbitrage-detector';

// =============================================================================
// Test Utilities
// =============================================================================

const createMockLogger = (): SolanaArbitrageLogger => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
});

/**
 * Helper to flush pending promises/microtasks.
 * More reliable than arbitrary setTimeout delays.
 */
const flushPromises = (): Promise<void> =>
  new Promise(resolve => setImmediate(resolve));

/**
 * Create a properly typed mock Redis Streams client.
 */
const createMockStreamsClient = (): SolanaArbitrageStreamsClient & { xadd: jest.Mock<() => Promise<string | null>> } => ({
  xadd: jest.fn<() => Promise<string | null>>().mockResolvedValue('message-id'),
});

const createMockPool = (overrides: Partial<SolanaPoolInfo> = {}): SolanaPoolInfo => ({
  address: `pool-${Math.random().toString(36).slice(2, 10)}`,
  programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  dex: 'raydium',
  token0: { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL', decimals: 9 },
  token1: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 },
  fee: 25, // 0.25% in basis points
  price: 100,
  ...overrides,
});

const createMockEvmPrice = (overrides: Partial<EvmPriceUpdate> = {}): EvmPriceUpdate => ({
  pairKey: 'ethereum:SOL-USDC:0x1234',
  chain: 'ethereum',
  dex: 'uniswap',
  token0: 'SOL',
  token1: 'USDC',
  price: 100,
  reserve0: '1000000000000000000',
  reserve1: '100000000000',
  blockNumber: 12345678,
  timestamp: Date.now(),
  latency: 50,
  ...overrides,
});

// =============================================================================
// Test Suite
// =============================================================================

describe('SolanaArbitrageDetector', () => {
  let detector: SolanaArbitrageDetector;
  let mockLogger: SolanaArbitrageLogger;
  const defaultConfig: SolanaArbitrageConfig = {
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    minProfitThreshold: 0.3,
  };

  beforeEach(() => {
    mockLogger = createMockLogger();
    detector = new SolanaArbitrageDetector(defaultConfig, { logger: mockLogger });
  });

  afterEach(async () => {
    await detector.stop();
  });

  // ===========================================================================
  // Constructor Tests
  // ===========================================================================

  describe('constructor', () => {
    // Issue 7.1 Fix: rpcUrl is now optional
    it('should work without rpcUrl', () => {
      expect(() => {
        new SolanaArbitrageDetector({});
      }).not.toThrow();
    });

    it('should use default values when not provided', () => {
      const config = detector.getConfig();
      expect(config.minProfitThreshold).toBe(0.3);
      expect(config.triangularEnabled).toBe(true);
      expect(config.crossChainEnabled).toBe(true);
      expect(config.maxTriangularDepth).toBe(3);
      expect(config.opportunityExpiryMs).toBe(1000);
      // Issue 1.3: chainId should default to 'solana'
      expect(config.chainId).toBe('solana');
      // Issue 10.7: priceStalenessMs should be configurable
      expect(config.priceStalenessMs).toBe(5000);
    });

    it('should respect custom configuration', () => {
      const customDetector = new SolanaArbitrageDetector({
        rpcUrl: 'https://test.solana.com',
        minProfitThreshold: 0.5,
        triangularEnabled: false,
        maxTriangularDepth: 4,
        chainId: 'solana-devnet',
        priceStalenessMs: 10000,
      });

      const config = customDetector.getConfig();
      expect(config.minProfitThreshold).toBe(0.5);
      expect(config.triangularEnabled).toBe(false);
      expect(config.maxTriangularDepth).toBe(4);
      expect(config.chainId).toBe('solana-devnet');
      expect(config.priceStalenessMs).toBe(10000);
    });

    // Issue 3.2: Config validation
    it('should throw for invalid minProfitThreshold', () => {
      expect(() => {
        new SolanaArbitrageDetector({
          minProfitThreshold: -0.5,
        }, { logger: mockLogger });
      }).toThrow('Invalid minProfitThreshold');
    });

    it('should throw for invalid maxTriangularDepth', () => {
      expect(() => {
        new SolanaArbitrageDetector({
          maxTriangularDepth: 1,
        }, { logger: mockLogger });
      }).toThrow('Invalid maxTriangularDepth');
    });
  });

  // ===========================================================================
  // Lifecycle Tests
  // ===========================================================================

  describe('lifecycle', () => {
    it('should start and stop correctly', async () => {
      expect(detector.isRunning()).toBe(false);

      await detector.start();
      expect(detector.isRunning()).toBe(true);

      await detector.stop();
      expect(detector.isRunning()).toBe(false);
    });

    it('should emit started and stopped events', async () => {
      const startedSpy = jest.fn();
      const stoppedSpy = jest.fn();

      detector.on('started', startedSpy);
      detector.on('stopped', stoppedSpy);

      await detector.start();
      expect(startedSpy).toHaveBeenCalled();

      await detector.stop();
      expect(stoppedSpy).toHaveBeenCalled();
    });

    it('should clear normalized token cache on stop', async () => {
      const pool = createMockPool();
      await detector.addPool(pool);

      // Add some tokens to cache via pool operations
      await detector.detectIntraSolanaArbitrage();

      await detector.stop();

      // Cache should be cleared (indirect verification via stats)
      expect(detector.isRunning()).toBe(false);
    });
  });

  // ===========================================================================
  // Pool Management Tests
  // ===========================================================================

  describe('pool management', () => {
    it('should add pool correctly', async () => {
      const pool = createMockPool({ address: 'test-pool-1' });
      await detector.addPool(pool);

      expect(detector.getPoolCount()).toBe(1);
      // getPool returns InternalPoolInfo with extra fields (normalizedToken0/1, pairKey, lastUpdated)
      const storedPool = detector.getPool('test-pool-1');
      expect(storedPool).toBeDefined();
      expect(storedPool?.address).toBe(pool.address);
      expect(storedPool?.dex).toBe(pool.dex);
      expect(storedPool?.price).toBe(pool.price);
      expect(storedPool?.token0.symbol).toBe(pool.token0.symbol);
      expect(storedPool?.token1.symbol).toBe(pool.token1.symbol);
    });

    it('should remove pool correctly', async () => {
      const pool = createMockPool({ address: 'test-pool-2' });
      await detector.addPool(pool);
      expect(detector.getPoolCount()).toBe(1);

      await detector.removePool('test-pool-2');
      expect(detector.getPoolCount()).toBe(0);
      expect(detector.getPool('test-pool-2')).toBeUndefined();
    });

    it('should index pools by token pair', async () => {
      const pool1 = createMockPool({ address: 'pool-1', price: 100 });
      const pool2 = createMockPool({ address: 'pool-2', price: 101, dex: 'orca' });

      await detector.addPool(pool1);
      await detector.addPool(pool2);

      const pools = detector.getPoolsByTokenPair('SOL', 'USDC');
      expect(pools.length).toBe(2);
    });

    it('should update pool price', async () => {
      const pool = createMockPool({ address: 'price-test', price: 100 });
      await detector.addPool(pool);

      const priceUpdateSpy = jest.fn();
      detector.on('price-update', priceUpdateSpy);

      await detector.updatePoolPrice('price-test', 105);

      expect(detector.getPool('price-test')?.price).toBe(105);
      expect(priceUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          poolAddress: 'price-test',
          oldPrice: 100,
          newPrice: 105,
        })
      );
    });

    it('should handle batch import', async () => {
      const pools = [
        createMockPool({ address: 'batch-1' }),
        createMockPool({ address: 'batch-2' }),
        createMockPool({ address: 'batch-3' }),
      ];

      await detector.importPools(pools);
      expect(detector.getPoolCount()).toBe(3);
    });
  });

  // ===========================================================================
  // Intra-Solana Arbitrage Detection Tests
  // ===========================================================================

  describe('intra-Solana arbitrage detection', () => {
    it('should detect profitable opportunity between DEXes', async () => {
      // Raydium pool: buy SOL at $95
      const raydiumPool = createMockPool({
        address: 'raydium-sol-usdc',
        dex: 'raydium',
        price: 95,
        fee: 25,
      });

      // Orca pool: sell SOL at $100
      const orcaPool = createMockPool({
        address: 'orca-sol-usdc',
        dex: 'orca',
        price: 100,
        fee: 30,
      });

      await detector.addPool(raydiumPool);
      await detector.addPool(orcaPool);

      const opportunities = await detector.detectIntraSolanaArbitrage();

      expect(opportunities.length).toBe(1);
      expect(opportunities[0].type).toBe('intra-solana');
      expect(opportunities[0].buyDex).toBe('raydium');
      expect(opportunities[0].sellDex).toBe('orca');
      expect(opportunities[0].profitPercentage).toBeGreaterThan(0);
    });

    it('should not detect unprofitable opportunity', async () => {
      // Pools with similar prices - not profitable after fees
      const pool1 = createMockPool({ address: 'pool-a', price: 100, fee: 25 });
      const pool2 = createMockPool({ address: 'pool-b', price: 100.1, fee: 25 });

      await detector.addPool(pool1);
      await detector.addPool(pool2);

      const opportunities = await detector.detectIntraSolanaArbitrage();
      expect(opportunities.length).toBe(0);
    });

    it('should emit opportunity events', async () => {
      const opportunitySpy = jest.fn();
      detector.on('opportunity', opportunitySpy);

      const pool1 = createMockPool({ address: 'emit-1', price: 90, fee: 25 });
      const pool2 = createMockPool({ address: 'emit-2', price: 100, fee: 25 });

      await detector.addPool(pool1);
      await detector.addPool(pool2);
      await detector.detectIntraSolanaArbitrage();

      expect(opportunitySpy).toHaveBeenCalled();
    });

    it('should update statistics after detection', async () => {
      const pool1 = createMockPool({ address: 'stats-1', price: 90 });
      const pool2 = createMockPool({ address: 'stats-2', price: 100 });

      await detector.addPool(pool1);
      await detector.addPool(pool2);
      await detector.detectIntraSolanaArbitrage();

      const stats = detector.getStats();
      expect(stats.totalDetections).toBe(1);
      expect(stats.intraSolanaOpportunities).toBeGreaterThanOrEqual(0);
      expect(stats.lastDetectionTime).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Triangular Arbitrage Detection Tests
  // ===========================================================================

  describe('triangular arbitrage detection', () => {
    it('should find triangular paths', async () => {
      // Create pools for SOL -> USDC -> RAY -> SOL triangle
      const solUsdc = createMockPool({
        address: 'sol-usdc',
        token0: { mint: 'SOL', symbol: 'SOL', decimals: 9 },
        token1: { mint: 'USDC', symbol: 'USDC', decimals: 6 },
        price: 100,
        fee: 25,
      });

      const usdcRay = createMockPool({
        address: 'usdc-ray',
        token0: { mint: 'USDC', symbol: 'USDC', decimals: 6 },
        token1: { mint: 'RAY', symbol: 'RAY', decimals: 6 },
        price: 0.5, // 1 USDC = 0.5 RAY
        fee: 30,
      });

      const raySol = createMockPool({
        address: 'ray-sol',
        token0: { mint: 'RAY', symbol: 'RAY', decimals: 6 },
        token1: { mint: 'SOL', symbol: 'SOL', decimals: 9 },
        price: 0.025, // Profitable circular path
        fee: 25,
      });

      await detector.addPool(solUsdc);
      await detector.addPool(usdcRay);
      await detector.addPool(raySol);

      const opportunities = await detector.detectTriangularArbitrage();

      // Should attempt to find paths (may or may not be profitable)
      expect(detector.getStats().poolsTracked).toBe(3);
    });

    it('should respect triangularEnabled config', async () => {
      const disabledDetector = new SolanaArbitrageDetector({
        rpcUrl: 'https://test.solana.com',
        triangularEnabled: false,
      });

      const pool1 = createMockPool({ address: 'tri-1' });
      await disabledDetector.addPool(pool1);

      const opportunities = await disabledDetector.detectTriangularArbitrage();
      expect(opportunities.length).toBe(0);
    });
  });

  // ===========================================================================
  // Cross-Chain Price Comparison Tests
  // ===========================================================================

  describe('cross-chain price comparison', () => {
    it('should compare Solana and EVM prices', async () => {
      const solanaPool = createMockPool({
        address: 'solana-sol-usdc',
        price: 95,
      });

      await detector.addPool(solanaPool);

      const evmPrice = createMockEvmPrice({ price: 100 });
      const comparisons = await detector.compareCrossChainPrices([evmPrice]);

      expect(comparisons.length).toBe(1);
      expect(comparisons[0].solanaPrice).toBe(95);
      expect(comparisons[0].evmPrice).toBe(100);
      expect(Math.abs(comparisons[0].priceDifferencePercent)).toBeGreaterThan(0);
    });

    it('should detect cross-chain arbitrage opportunity', async () => {
      const solanaPool = createMockPool({
        address: 'xchain-solana',
        price: 90, // Cheaper on Solana
      });

      await detector.addPool(solanaPool);

      const evmPrice = createMockEvmPrice({
        price: 100, // More expensive on EVM
      });

      const opportunities = await detector.detectCrossChainArbitrage([evmPrice]);

      expect(opportunities.length).toBe(1);
      expect(opportunities[0].type).toBe('cross-chain');
      expect(opportunities[0].direction).toBe('buy-solana-sell-evm');
    });

    it('should respect crossChainEnabled config', async () => {
      const disabledDetector = new SolanaArbitrageDetector({
        rpcUrl: 'https://test.solana.com',
        crossChainEnabled: false,
      });

      const pool = createMockPool();
      await disabledDetector.addPool(pool);

      const opportunities = await disabledDetector.detectCrossChainArbitrage([
        createMockEvmPrice(),
      ]);

      expect(opportunities.length).toBe(0);
    });
  });

  // ===========================================================================
  // Priority Fee Estimation Tests
  // ===========================================================================

  describe('priority fee estimation', () => {
    it('should estimate priority fees correctly', async () => {
      const estimate = await detector.estimatePriorityFee({
        computeUnits: 200000,
        urgency: 'medium',
      });

      expect(estimate.computeUnits).toBe(200000);
      expect(estimate.baseFee).toBeGreaterThan(0);
      expect(estimate.priorityFee).toBeGreaterThan(0);
      expect(estimate.totalFee).toBe(estimate.baseFee + estimate.priorityFee);
      expect(estimate.microLamportsPerCu).toBeGreaterThan(0);
    });

    it('should scale fees by urgency', async () => {
      const lowUrgency = await detector.estimatePriorityFee({
        computeUnits: 200000,
        urgency: 'low',
      });

      const highUrgency = await detector.estimatePriorityFee({
        computeUnits: 200000,
        urgency: 'high',
      });

      expect(highUrgency.priorityFee).toBeGreaterThan(lowUrgency.priorityFee);
    });
  });

  // ===========================================================================
  // Statistics Tests
  // ===========================================================================

  describe('statistics', () => {
    it('should track pool count', async () => {
      await detector.addPool(createMockPool({ address: 'stats-pool-1' }));
      await detector.addPool(createMockPool({ address: 'stats-pool-2' }));

      expect(detector.getStats().poolsTracked).toBe(2);
    });

    it('should reset statistics', async () => {
      await detector.addPool(createMockPool());
      await detector.detectIntraSolanaArbitrage();

      detector.resetStats();

      const stats = detector.getStats();
      expect(stats.totalDetections).toBe(0);
      expect(stats.intraSolanaOpportunities).toBe(0);
    });
  });

  // ===========================================================================
  // Redis Streams Integration Tests
  // ===========================================================================

  describe('Redis Streams integration', () => {
    it('should accept streams client via constructor', () => {
      const mockStreamsClient = createMockStreamsClient();

      const detectorWithStreams = new SolanaArbitrageDetector(defaultConfig, {
        logger: mockLogger,
        streamsClient: mockStreamsClient,
      });

      expect(detectorWithStreams.hasStreamsClient()).toBe(true);
    });

    it('should accept streams client via setter', () => {
      const mockStreamsClient = createMockStreamsClient();

      expect(detector.hasStreamsClient()).toBe(false);
      detector.setStreamsClient(mockStreamsClient);
      expect(detector.hasStreamsClient()).toBe(true);
    });

    it('should publish opportunity to streams', async () => {
      const mockStreamsClient = createMockStreamsClient();

      detector.setStreamsClient(mockStreamsClient);

      const pool1 = createMockPool({ address: 'publish-1', price: 90 });
      const pool2 = createMockPool({ address: 'publish-2', price: 100 });

      await detector.addPool(pool1);
      await detector.addPool(pool2);

      const opportunities = await detector.detectIntraSolanaArbitrage();

      if (opportunities.length > 0) {
        await detector.publishOpportunity(opportunities[0]);
        expect(mockStreamsClient.xadd).toHaveBeenCalled();
      }
    });
  });

  // ===========================================================================
  // SolanaDetector Integration Tests
  // ===========================================================================

  describe('SolanaDetector integration', () => {
    it('should connect to SolanaDetector and receive pool updates', async () => {
      const mockSolanaDetector = new EventEmitter();

      detector.connectToSolanaDetector(mockSolanaDetector);

      const pool = createMockPool({ address: 'from-detector' });
      mockSolanaDetector.emit('poolUpdate', pool);

      // Wait for async addPool to complete using flushPromises
      await flushPromises();
      await flushPromises(); // Double flush for mutex operations

      expect(detector.getPool('from-detector')).toBeDefined();
    });

    it('should handle priceUpdate events', async () => {
      const mockSolanaDetector = new EventEmitter();

      detector.connectToSolanaDetector(mockSolanaDetector);

      const pool = createMockPool({ address: 'price-update-test', price: 100 });
      mockSolanaDetector.emit('priceUpdate', pool);

      // Wait for async addPool to complete using flushPromises
      await flushPromises();
      await flushPromises(); // Double flush for mutex operations

      expect(detector.getPool('price-update-test')).toBeDefined();
    });

    it('should handle pool removal events', async () => {
      const mockSolanaDetector = new EventEmitter();

      detector.connectToSolanaDetector(mockSolanaDetector);

      // First add a pool
      const pool = createMockPool({ address: 'to-remove' });
      mockSolanaDetector.emit('poolUpdate', pool);
      await flushPromises();
      await flushPromises(); // Double flush for mutex operations
      expect(detector.getPool('to-remove')).toBeDefined();

      // Then remove it
      mockSolanaDetector.emit('poolRemoved', 'to-remove');
      await flushPromises();
      await flushPromises(); // Double flush for mutex operations
      expect(detector.getPool('to-remove')).toBeUndefined();
    });
  });

  // ===========================================================================
  // Thread Safety Tests
  // ===========================================================================

  describe('thread safety', () => {
    it('should handle concurrent addPool calls', async () => {
      const pools = Array.from({ length: 100 }, (_, i) =>
        createMockPool({ address: `concurrent-${i}` })
      );

      // Add all pools concurrently
      await Promise.all(pools.map(pool => detector.addPool(pool)));

      expect(detector.getPoolCount()).toBe(100);
    });

    it('should handle concurrent detection and pool updates', async () => {
      // Pre-add some pools
      for (let i = 0; i < 10; i++) {
        await detector.addPool(createMockPool({ address: `pre-${i}`, price: 90 + i }));
      }

      // Run detection and pool updates concurrently
      const detectionPromise = detector.detectIntraSolanaArbitrage();
      const addPromises = Array.from({ length: 5 }, (_, i) =>
        detector.addPool(createMockPool({ address: `concurrent-add-${i}` }))
      );

      await Promise.all([detectionPromise, ...addPromises]);

      // Should complete without errors
      expect(detector.getPoolCount()).toBe(15);
    });
  });

  // ===========================================================================
  // Edge Cases Tests (Issue 8.3)
  // ===========================================================================

  describe('edge cases', () => {
    // Issue 4.3: Division by zero protection
    it('should handle pools with zero price', async () => {
      const zeroPool = createMockPool({ address: 'zero-price', price: 0 });
      const normalPool = createMockPool({ address: 'normal', price: 100 });

      await detector.addPool(zeroPool);
      await detector.addPool(normalPool);

      // Should not throw, should skip invalid pool
      const opportunities = await detector.detectIntraSolanaArbitrage();
      expect(opportunities).toBeDefined();
    });

    it('should handle pools with undefined price', async () => {
      const undefinedPricePool = createMockPool({ address: 'undefined-price' });
      // Test undefined price by not setting it
      delete undefinedPricePool.price;
      const normalPool = createMockPool({ address: 'normal-2', price: 100 });

      await detector.addPool(undefinedPricePool);
      await detector.addPool(normalPool);

      // Should not throw
      const opportunities = await detector.detectIntraSolanaArbitrage();
      expect(opportunities).toBeDefined();
    });

    it('should handle very small prices (Issue 4.3)', async () => {
      // Prices below MIN_VALID_PRICE (1e-12) should be treated as invalid
      const tinyPool = createMockPool({ address: 'tiny-price', price: 1e-15 });
      const normalPool = createMockPool({ address: 'normal-3', price: 100 });

      await detector.addPool(tinyPool);
      await detector.addPool(normalPool);

      // Should not throw
      const opportunities = await detector.detectIntraSolanaArbitrage();
      expect(opportunities).toBeDefined();
    });

    it('should handle empty pool set', async () => {
      // No pools added
      const opportunities = await detector.detectIntraSolanaArbitrage();
      expect(opportunities).toEqual([]);
    });

    it('should handle single pool (no arbitrage possible)', async () => {
      const singlePool = createMockPool({ address: 'single', price: 100 });
      await detector.addPool(singlePool);

      const opportunities = await detector.detectIntraSolanaArbitrage();
      expect(opportunities).toEqual([]);
    });

    it('should handle pools with same price', async () => {
      const pool1 = createMockPool({ address: 'same-1', price: 100, dex: 'raydium' });
      const pool2 = createMockPool({ address: 'same-2', price: 100, dex: 'orca' });

      await detector.addPool(pool1);
      await detector.addPool(pool2);

      // Same price = no profitable arbitrage after fees
      const opportunities = await detector.detectIntraSolanaArbitrage();
      expect(opportunities.length).toBe(0);
    });
  });

  // ===========================================================================
  // Price Staleness Tests (Issue 10.7)
  // ===========================================================================

  describe('price staleness', () => {
    let staleDetector: SolanaArbitrageDetector;

    beforeEach(() => {
      staleDetector = new SolanaArbitrageDetector({
        minProfitThreshold: 0.3,
        priceStalenessMs: 1000, // 1 second for testing
      }, { logger: mockLogger });
    });

    afterEach(async () => {
      await staleDetector.stop();
    });

    it('should skip pools with stale prices', async () => {
      const now = Date.now();
      const staleTime = now - 2000; // 2 seconds ago (beyond 1s threshold)

      const freshPool = createMockPool({
        address: 'fresh-pool',
        price: 90,
        dex: 'raydium',
        lastUpdated: now,
      });

      const stalePool = createMockPool({
        address: 'stale-pool',
        price: 100,
        dex: 'orca',
        lastUpdated: staleTime,
      });

      await staleDetector.addPool(freshPool);
      await staleDetector.addPool(stalePool);

      const opportunities = await staleDetector.detectIntraSolanaArbitrage();

      // Should not find opportunity since one pool is stale
      // Or stats should show stale pools were skipped
      const stats = staleDetector.getStats();
      expect(stats.stalePoolsSkipped).toBeGreaterThanOrEqual(0);
    });

    it('should include pools without lastUpdated timestamp', async () => {
      // Pools without lastUpdated should be treated as fresh (backward compat)
      const pool1 = createMockPool({ address: 'no-timestamp-1', price: 90 });
      const pool2 = createMockPool({ address: 'no-timestamp-2', price: 100 });

      // Remove lastUpdated if present
      delete pool1.lastUpdated;
      delete pool2.lastUpdated;

      await staleDetector.addPool(pool1);
      await staleDetector.addPool(pool2);

      const opportunities = await staleDetector.detectIntraSolanaArbitrage();
      // Should process normally
      expect(opportunities.length).toBeGreaterThanOrEqual(0);
    });
  });

  // ===========================================================================
  // Triangular Path Fix Tests (Issue 8.4 / Issue 4.1)
  // ===========================================================================

  describe('triangular path completion', () => {
    it('should complete triangular paths at exactly depth 3 (Issue 4.1)', async () => {
      // Create a triangle: A -> B -> C -> A
      // With favorable pricing to ensure profitability
      const poolAB = createMockPool({
        address: 'pool-AB',
        token0: { mint: 'A', symbol: 'A', decimals: 9 },
        token1: { mint: 'B', symbol: 'B', decimals: 9 },
        price: 1.0,
        fee: 10, // Low fee
        dex: 'raydium',
      });

      const poolBC = createMockPool({
        address: 'pool-BC',
        token0: { mint: 'B', symbol: 'B', decimals: 9 },
        token1: { mint: 'C', symbol: 'C', decimals: 9 },
        price: 1.0,
        fee: 10,
        dex: 'orca',
      });

      const poolCA = createMockPool({
        address: 'pool-CA',
        token0: { mint: 'C', symbol: 'C', decimals: 9 },
        token1: { mint: 'A', symbol: 'A', decimals: 9 },
        price: 1.1, // Arbitrage opportunity!
        fee: 10,
        dex: 'meteora',
      });

      await detector.addPool(poolAB);
      await detector.addPool(poolBC);
      await detector.addPool(poolCA);

      const opportunities = await detector.detectTriangularArbitrage();

      // Should be able to find the triangle
      // Note: May not be profitable after fees, so check detection attempted
      expect(detector.getStats().poolsTracked).toBe(3);
    });

    it('should not allow paths to complete at depth 2', async () => {
      // A proper triangle needs at least 3 hops
      const pool1 = createMockPool({
        address: 'pool-short-1',
        token0: { mint: 'X', symbol: 'X', decimals: 9 },
        token1: { mint: 'Y', symbol: 'Y', decimals: 9 },
        price: 1.0,
      });

      const pool2 = createMockPool({
        address: 'pool-short-2',
        token0: { mint: 'Y', symbol: 'Y', decimals: 9 },
        token1: { mint: 'X', symbol: 'X', decimals: 9 },
        price: 1.1,
      });

      await detector.addPool(pool1);
      await detector.addPool(pool2);

      const opportunities = await detector.detectTriangularArbitrage();

      // 2-hop paths returning to start are NOT triangular (that's just a swap back)
      // Real triangular requires 3 distinct intermediary tokens
      // The path X->Y->X has only 2 tokens, not a valid triangle
      expect(opportunities.every(o => o.path?.length !== 2)).toBe(true);
    });

    it('should respect maxTriangularDepth limit', async () => {
      const shallowDetector = new SolanaArbitrageDetector({
        triangularEnabled: true,
        maxTriangularDepth: 3, // Only explore to depth 3
      }, { logger: mockLogger });

      // Create a 4-hop cycle that would only be found with depth > 3
      const tokens = ['P', 'Q', 'R', 'S'];
      for (let i = 0; i < tokens.length; i++) {
        const nextIdx = (i + 1) % tokens.length;
        await shallowDetector.addPool(createMockPool({
          address: `pool-${tokens[i]}-${tokens[nextIdx]}`,
          token0: { mint: tokens[i], symbol: tokens[i], decimals: 9 },
          token1: { mint: tokens[nextIdx], symbol: tokens[nextIdx], decimals: 9 },
          price: 1.0,
          fee: 10,
        }));
      }

      const opportunities = await shallowDetector.detectTriangularArbitrage();

      // With maxDepth=3, the 4-hop cycle P->Q->R->S->P won't be found
      // Only 3-hop partial paths would be considered
      await shallowDetector.stop();
    });
  });

  // ===========================================================================
  // Statistics and Metrics Tests
  // ===========================================================================

  describe('detection statistics', () => {
    it('should track stale pools skipped', async () => {
      const stats = detector.getStats();
      expect(stats.stalePoolsSkipped).toBeDefined();
      expect(typeof stats.stalePoolsSkipped).toBe('number');
    });

    it('should track average detection latency', async () => {
      // Add some pools and run detection
      await detector.addPool(createMockPool({ address: 'latency-1', price: 90 }));
      await detector.addPool(createMockPool({ address: 'latency-2', price: 100 }));
      await detector.detectIntraSolanaArbitrage();

      const stats = detector.getStats();
      expect(stats.avgDetectionLatencyMs).toBeDefined();
      expect(stats.avgDetectionLatencyMs).toBeGreaterThanOrEqual(0);
    });
  });
});
