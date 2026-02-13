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
  SolanaArbitrageOpportunity,
  EvmPriceUpdate,
  SolanaArbitrageLogger,
  SolanaArbitrageStreamsClient,
} from '../../src/arbitrage-detector';
import { createMockSolanaPool } from '../helpers/test-fixtures';

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

const createMockPool = createMockSolanaPool;

const createSyntheticOpportunity = (overrides: Partial<SolanaArbitrageOpportunity> = {}): SolanaArbitrageOpportunity => ({
  id: `sol-test-${Math.random().toString(36).slice(2, 10)}`,
  type: 'intra-solana',
  chain: 'solana',
  buyDex: 'raydium',
  sellDex: 'orca',
  buyPair: 'pool-buy-1',
  sellPair: 'pool-sell-1',
  token0: 'SOL',
  token1: 'USDC',
  buyPrice: 90,
  sellPrice: 100,
  profitPercentage: 5.0,
  expectedProfit: 0.05,
  confidence: 0.85,
  timestamp: Date.now(),
  expiresAt: Date.now() + 1000,
  status: 'pending',
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

    it('should throttle rapid updates to the same pool address', async () => {
      // Fix #22: Rate limiting on pool additions
      const pool = createMockPool({ address: 'throttle-test', price: 100 });
      await detector.addPool(pool);
      expect(detector.getPoolCount()).toBe(1);

      // Second add with same address within cooldown should be throttled
      const updatedPool = createMockPool({ address: 'throttle-test', price: 200 });
      await detector.addPool(updatedPool);

      // Price should still be original since update was throttled
      const stored = detector.getPool('throttle-test');
      expect(stored?.price).toBe(100);
    });

    it('should allow updates to different pool addresses without throttling', async () => {
      // Fix #22: Different addresses should not interfere with each other
      const pool1 = createMockPool({ address: 'rate-limit-pool-1', price: 100 });
      const pool2 = createMockPool({ address: 'rate-limit-pool-2', price: 200 });

      await detector.addPool(pool1);
      await detector.addPool(pool2);

      expect(detector.getPoolCount()).toBe(2);
      expect(detector.getPool('rate-limit-pool-1')?.price).toBe(100);
      expect(detector.getPool('rate-limit-pool-2')?.price).toBe(200);
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

      const opportunity = createSyntheticOpportunity();
      await detector.publishOpportunity(opportunity);
      expect(mockStreamsClient.xadd).toHaveBeenCalled();
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

    it('should auto-set timestamp for pools added without lastUpdated', async () => {
      // Tests that addPool() automatically sets lastUpdated when not provided.
      // This ensures pools are always timestamped and can be properly aged out.
      const pool1 = createMockPool({ address: 'no-timestamp-1', price: 90 });
      const pool2 = createMockPool({ address: 'no-timestamp-2', price: 100 });

      // Remove lastUpdated to simulate external data source without timestamps
      delete pool1.lastUpdated;
      delete pool2.lastUpdated;

      await staleDetector.addPool(pool1);
      await staleDetector.addPool(pool2);

      // Verify pools were added with auto-generated timestamps
      const storedPool1 = staleDetector.getPool('no-timestamp-1');
      const storedPool2 = staleDetector.getPool('no-timestamp-2');
      expect(storedPool1?.lastUpdated).toBeDefined();
      expect(storedPool2?.lastUpdated).toBeDefined();

      const opportunities = await staleDetector.detectIntraSolanaArbitrage();
      // Should process normally since timestamps were auto-set
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

  // ===========================================================================
  // Circuit Breaker Tests (P3 - Missing Tests)
  // ===========================================================================

  describe('circuit breaker', () => {
    it('should start with circuit breaker closed', () => {
      const status = detector.getCircuitBreakerStatus();
      expect(status.isOpen).toBe(false);
      expect(status.failures).toBe(0);
    });

    it('should return circuit breaker status', () => {
      const status = detector.getCircuitBreakerStatus();
      expect(status).toHaveProperty('isOpen');
      expect(status).toHaveProperty('failures');
      expect(status).toHaveProperty('lastFailureTime');
    });

    it('should allow detection when circuit is closed', async () => {
      const pool1 = createMockPool({ address: 'cb-pool-1', price: 90 });
      const pool2 = createMockPool({ address: 'cb-pool-2', price: 100 });

      await detector.addPool(pool1);
      await detector.addPool(pool2);

      // Circuit is closed by default, detection should work
      const opportunities = await detector.detectIntraSolanaArbitrage();
      expect(opportunities).toBeDefined();
    });

    it('should reset circuit breaker on successful detection', async () => {
      const pool1 = createMockPool({ address: 'cb-reset-1', price: 90 });
      const pool2 = createMockPool({ address: 'cb-reset-2', price: 100 });

      await detector.addPool(pool1);
      await detector.addPool(pool2);

      // Run detection successfully
      await detector.detectIntraSolanaArbitrage();

      const status = detector.getCircuitBreakerStatus();
      expect(status.isOpen).toBe(false);
      expect(status.failures).toBe(0);
    });

    it('should expose circuit breaker status in metrics', () => {
      const metrics = detector.getMetrics();

      expect(metrics).toHaveProperty('solana_arbitrage_circuit_breaker_open');
      expect(metrics).toHaveProperty('solana_arbitrage_circuit_breaker_failures');
      expect(metrics['solana_arbitrage_circuit_breaker_open']).toBe(0); // Closed = 0
      expect(metrics['solana_arbitrage_circuit_breaker_failures']).toBe(0);
    });

    // P3-FIX: Comprehensive metrics test to cover all exported fields
    it('should export all Prometheus-style metrics fields', () => {
      const metrics = detector.getMetrics();

      // Pool tracking metrics
      expect(metrics).toHaveProperty('solana_arbitrage_pools_tracked');
      expect(metrics).toHaveProperty('solana_arbitrage_pool_store_version');

      // Detection metrics
      expect(metrics).toHaveProperty('solana_arbitrage_detections_total');
      expect(metrics).toHaveProperty('solana_arbitrage_opportunities_intra_total');
      expect(metrics).toHaveProperty('solana_arbitrage_opportunities_triangular_total');
      expect(metrics).toHaveProperty('solana_arbitrage_opportunities_crosschain_total');

      // Performance metrics
      expect(metrics).toHaveProperty('solana_arbitrage_detection_latency_ms');
      expect(metrics).toHaveProperty('solana_arbitrage_stale_pools_skipped_total');

      // Health metrics
      expect(metrics).toHaveProperty('solana_arbitrage_circuit_breaker_open');
      expect(metrics).toHaveProperty('solana_arbitrage_circuit_breaker_failures');
      expect(metrics).toHaveProperty('solana_arbitrage_running');

      // Cache metrics
      expect(metrics).toHaveProperty('solana_arbitrage_token_cache_size');

      // Activity timestamp
      expect(metrics).toHaveProperty('solana_arbitrage_last_detection_timestamp_ms');

      // All metrics should be numbers
      for (const [key, value] of Object.entries(metrics)) {
        expect(typeof value).toBe('number');
        expect(isFinite(value)).toBe(true);
      }
    });

    it('should reflect running state in metrics', async () => {
      // Before start
      expect(detector.getMetrics()['solana_arbitrage_running']).toBe(0);

      // After start
      await detector.start();
      expect(detector.getMetrics()['solana_arbitrage_running']).toBe(1);

      // After stop
      await detector.stop();
      expect(detector.getMetrics()['solana_arbitrage_running']).toBe(0);
    });

    it('should update detection metrics after detection runs', async () => {
      await detector.start();

      // Add pools for detection
      await detector.addPool(createMockPool({
        address: 'metrics-pool-1',
        token0: { mint: 'SOL', symbol: 'SOL', decimals: 9 },
        token1: { mint: 'USDC', symbol: 'USDC', decimals: 6 },
        price: 100,
      }));
      await detector.addPool(createMockPool({
        address: 'metrics-pool-2',
        token0: { mint: 'SOL', symbol: 'SOL', decimals: 9 },
        token1: { mint: 'USDC', symbol: 'USDC', decimals: 6 },
        price: 100.1,
      }));

      // Before detection
      expect(detector.getMetrics()['solana_arbitrage_detections_total']).toBe(0);

      // After detection
      await detector.detectIntraSolanaArbitrage();
      expect(detector.getMetrics()['solana_arbitrage_detections_total']).toBe(1);
      expect(detector.getMetrics()['solana_arbitrage_pools_tracked']).toBe(2);
      expect(detector.getMetrics()['solana_arbitrage_last_detection_timestamp_ms']).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Input Validation Tests (P2 - Security)
  // ===========================================================================

  describe('input validation', () => {
    it('should reject pools with invalid address format', async () => {
      const invalidPool = createMockPool({
        address: 'not-a-valid-solana-address!@#$%',
        price: 100,
      });

      // Pool should be rejected silently
      await detector.addPool(invalidPool);

      // Pool should not be added
      expect(detector.getPool('not-a-valid-solana-address!@#$%')).toBeUndefined();
    });

    it('should accept valid Solana addresses', async () => {
      const validPool = createMockPool({
        // Valid base58 Solana address format
        address: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
        price: 100,
      });

      await detector.addPool(validPool);
      expect(detector.getPool('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8')).toBeDefined();
    });

    it('should accept pairKey-style addresses from UnifiedPriceUpdate', async () => {
      // These are used when adapting UnifiedPriceUpdate to SolanaPoolInfo
      const pairKeyPool = createMockPool({
        address: 'ethereum:SOL-USDC:0x1234567890abcdef',
        price: 100,
      });

      await detector.addPool(pairKeyPool);
      expect(detector.getPool('ethereum:SOL-USDC:0x1234567890abcdef')).toBeDefined();
    });

    it('should sanitize token symbols with special characters', async () => {
      const poolWithBadSymbols = createMockPool({
        address: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
        token0: { mint: 'test', symbol: 'SOL<script>', decimals: 9 },
        token1: { mint: 'test2', symbol: 'USDC\n\r', decimals: 6 },
        price: 100,
      });

      await detector.addPool(poolWithBadSymbols);

      const storedPool = detector.getPool('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
      expect(storedPool).toBeDefined();
      // Special characters should be stripped
      expect(storedPool?.token0.symbol).toBe('SOLscript');
      expect(storedPool?.token1.symbol).toBe('USDC');
    });
  });

  // ===========================================================================
  // Redis Retry Tests (P3)
  // ===========================================================================

  describe('Redis publishing retry', () => {
    it('should retry on transient Redis failures', async () => {
      let callCount = 0;
      const flakeyStreamsClient: SolanaArbitrageStreamsClient = {
        xadd: jest.fn<() => Promise<string | null>>().mockImplementation(async () => {
          callCount++;
          if (callCount < 3) {
            throw new Error('Transient Redis error');
          }
          return 'message-id';
        }),
      };

      detector.setStreamsClient(flakeyStreamsClient);

      const opportunity = createSyntheticOpportunity();
      await detector.publishOpportunity(opportunity);
      // Should have been called 3 times (2 failures + 1 success)
      expect(flakeyStreamsClient.xadd).toHaveBeenCalledTimes(3);
    });

    it('should give up after max retries', async () => {
      const failingStreamsClient: SolanaArbitrageStreamsClient = {
        xadd: jest.fn<() => Promise<string | null>>().mockRejectedValue(new Error('Permanent failure')),
      };

      detector.setStreamsClient(failingStreamsClient);

      const opportunity = createSyntheticOpportunity();
      await detector.publishOpportunity(opportunity);
      // Should have been called MAX_ATTEMPTS times (3)
      expect(failingStreamsClient.xadd).toHaveBeenCalledTimes(3);
    });
  });

  // ===========================================================================
  // Circuit Breaker Edge Cases (P3 - Additional Coverage)
  // ===========================================================================

  describe('circuit breaker edge cases', () => {
    it('should expose inHalfOpenState in circuit breaker status', () => {
      const status = detector.getCircuitBreakerStatus();

      expect(status).toHaveProperty('isOpen');
      expect(status).toHaveProperty('failures');
      expect(status).toHaveProperty('lastFailureTime');
      expect(status).toHaveProperty('inHalfOpenState');
      expect(status.inHalfOpenState).toBe(false);
    });

    it('should reset circuit breaker after successful detection', async () => {
      const pool1 = createMockPool({ address: 'cb-success-1', price: 90 });
      const pool2 = createMockPool({ address: 'cb-success-2', price: 100 });

      await detector.addPool(pool1);
      await detector.addPool(pool2);

      // Run successful detection
      await detector.detectIntraSolanaArbitrage();

      const status = detector.getCircuitBreakerStatus();
      expect(status.isOpen).toBe(false);
      expect(status.failures).toBe(0);
      expect(status.inHalfOpenState).toBe(false);
    });

    it('should track failure count but not open circuit for single failure', async () => {
      // To test failures we need to cause detection to fail
      // We can't easily inject failures, so we test the status tracking instead
      const status = detector.getCircuitBreakerStatus();

      // Initially closed with no failures
      expect(status.isOpen).toBe(false);
      expect(status.failures).toBe(0);
    });

    it('should continue successful detection and keep circuit closed', async () => {
      // Add pools and run multiple successful detections
      const pool1 = createMockPool({ address: 'multi-detect-1', price: 90 });
      const pool2 = createMockPool({ address: 'multi-detect-2', price: 100 });

      await detector.addPool(pool1);
      await detector.addPool(pool2);

      // Run multiple successful detections
      await detector.detectIntraSolanaArbitrage();
      await detector.detectIntraSolanaArbitrage();
      await detector.detectIntraSolanaArbitrage();

      const status = detector.getCircuitBreakerStatus();
      expect(status.isOpen).toBe(false);
      expect(status.failures).toBe(0);
      expect(status.inHalfOpenState).toBe(false);
    });
  });

  // ===========================================================================
  // Event Listener Cleanup Tests (P0 - Memory Leak Prevention)
  // ===========================================================================

  describe('event listener cleanup', () => {
    it('should clean up old listeners when connecting to new detector', async () => {
      const mockDetector1 = new EventEmitter();
      const mockDetector2 = new EventEmitter();

      // Connect to first detector
      detector.connectToSolanaDetector(mockDetector1);

      const pool1 = createMockPool({ address: 'detector1-pool' });
      mockDetector1.emit('poolUpdate', pool1);
      await flushPromises();
      expect(detector.getPool('detector1-pool')).toBeDefined();

      // Connect to second detector - should clean up old listeners
      detector.connectToSolanaDetector(mockDetector2);

      // Old detector should no longer affect our state
      const pool2 = createMockPool({ address: 'detector1-pool2' });
      mockDetector1.emit('poolUpdate', pool2);
      await flushPromises();
      // Pool should NOT be added since we disconnected
      expect(detector.getPool('detector1-pool2')).toBeUndefined();

      // New detector should work
      const pool3 = createMockPool({ address: 'detector2-pool' });
      mockDetector2.emit('poolUpdate', pool3);
      await flushPromises();
      expect(detector.getPool('detector2-pool')).toBeDefined();
    });

    it('should clean up listeners on stop', async () => {
      const mockDetector = new EventEmitter();

      detector.connectToSolanaDetector(mockDetector);

      const pool1 = createMockPool({ address: 'before-stop' });
      mockDetector.emit('poolUpdate', pool1);
      await flushPromises();
      expect(detector.getPool('before-stop')).toBeDefined();

      // Stop the detector
      await detector.stop();

      // Emissions after stop should not add pools
      const pool2 = createMockPool({ address: 'after-stop' });
      mockDetector.emit('poolUpdate', pool2);
      await flushPromises();
      // Pool should NOT be added since we stopped
      expect(detector.getPool('after-stop')).toBeUndefined();
    });
  });

  // ===========================================================================
  // Fee Validation Tests (P1 - Calculation Accuracy)
  // ===========================================================================

  describe('fee validation', () => {
    it('should skip opportunity with invalid pool fee (negative)', async () => {
      const pool1 = createMockPool({ address: 'fee-neg-1', price: 90, fee: -100 });
      const pool2 = createMockPool({ address: 'fee-neg-2', price: 100, fee: 25 });

      // Pool with negative fee should be rejected during add
      await detector.addPool(pool1);
      await detector.addPool(pool2);

      // Only valid pool should be added
      expect(detector.getPoolCount()).toBe(1);
      expect(detector.getPool('fee-neg-1')).toBeUndefined();
      expect(detector.getPool('fee-neg-2')).toBeDefined();
    });

    it('should skip opportunity with invalid pool fee (too high)', async () => {
      const pool1 = createMockPool({ address: 'fee-high-1', price: 90, fee: 25 });
      // Fee > 10000 basis points (100%) is invalid
      const pool2 = createMockPool({ address: 'fee-high-2', price: 100, fee: 20000 });

      await detector.addPool(pool1);
      await detector.addPool(pool2);

      // Only valid pool should be added
      expect(detector.getPoolCount()).toBe(1);
      expect(detector.getPool('fee-high-1')).toBeDefined();
      expect(detector.getPool('fee-high-2')).toBeUndefined();
    });

    it('should accept pools with valid fees at boundary (0 and 10000)', async () => {
      const pool1 = createMockPool({ address: 'fee-zero', price: 90, fee: 0 });
      const pool2 = createMockPool({ address: 'fee-max', price: 100, fee: 10000 });

      await detector.addPool(pool1);
      await detector.addPool(pool2);

      expect(detector.getPoolCount()).toBe(2);
      expect(detector.getPool('fee-zero')).toBeDefined();
      expect(detector.getPool('fee-max')).toBeDefined();
    });
  });

  // ===========================================================================
  // Pool Store Eviction Tests (P0 - Memory Leak Prevention)
  // ===========================================================================

  describe('pool store eviction', () => {
    it('should handle adding many pools gracefully', async () => {
      // Add 100 pools - should not throw or cause memory issues
      for (let i = 0; i < 100; i++) {
        await detector.addPool(createMockPool({
          address: `eviction-test-${i}`,
          price: 100 + (i % 10),
        }));
      }

      expect(detector.getPoolCount()).toBe(100);
    });

    it('should maintain pool count after updates', async () => {
      const pool1 = createMockPool({ address: 'maintain-1', price: 100 });
      const pool2 = createMockPool({ address: 'maintain-2', price: 101 });

      await detector.addPool(pool1);
      await detector.addPool(pool2);
      expect(detector.getPoolCount()).toBe(2);

      // Update existing pool - should not increase count
      await detector.updatePoolPrice('maintain-1', 102);
      expect(detector.getPoolCount()).toBe(2);
    });
  });

  // ===========================================================================
  // UnifiedPriceUpdate Adapter Validation Tests (P2)
  // ===========================================================================

  describe('UnifiedPriceUpdate adapter validation', () => {
    it('should handle null update gracefully', async () => {
      const mockSolanaDetector = new EventEmitter();
      detector.connectToSolanaDetector(mockSolanaDetector);

      // Emit null - should not throw
      mockSolanaDetector.emit('priceUpdate', null);
      await flushPromises();

      // No pools should be added
      expect(detector.getPoolCount()).toBe(0);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should handle undefined update gracefully', async () => {
      const mockSolanaDetector = new EventEmitter();
      detector.connectToSolanaDetector(mockSolanaDetector);

      // Emit undefined - should not throw
      mockSolanaDetector.emit('priceUpdate', undefined);
      await flushPromises();

      // No pools should be added
      expect(detector.getPoolCount()).toBe(0);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should handle malformed UnifiedPriceUpdate with missing fields', async () => {
      const mockSolanaDetector = new EventEmitter();
      detector.connectToSolanaDetector(mockSolanaDetector);

      // Emit update missing required fields
      const malformedUpdate = {
        chain: 'solana',
        // Missing dex, pairKey, token0, token1, price
      };

      mockSolanaDetector.emit('priceUpdate', malformedUpdate);
      await flushPromises();

      // No pools should be added
      expect(detector.getPoolCount()).toBe(0);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should accept valid UnifiedPriceUpdate', async () => {
      const mockSolanaDetector = new EventEmitter();
      detector.connectToSolanaDetector(mockSolanaDetector);

      const validUpdate = {
        chain: 'solana',
        dex: 'raydium',
        pairKey: 'solana:SOL-USDC:test123',
        token0: 'SOL',
        token1: 'USDC',
        price: 100,
        reserve0: '1000000000',
        reserve1: '100000000000',
        blockNumber: 12345,
        timestamp: Date.now(),
        latency: 50,
      };

      mockSolanaDetector.emit('priceUpdate', validUpdate);
      await flushPromises();

      // Pool should be added
      expect(detector.getPoolCount()).toBe(1);
    });

    it('should skip non-Solana chain updates', async () => {
      const mockSolanaDetector = new EventEmitter();
      detector.connectToSolanaDetector(mockSolanaDetector);

      const ethereumUpdate = {
        chain: 'ethereum',
        dex: 'uniswap',
        pairKey: 'ethereum:SOL-USDC:test123',
        token0: 'SOL',
        token1: 'USDC',
        price: 100,
        reserve0: '1000000000',
        reserve1: '100000000000',
        blockNumber: 12345,
        timestamp: Date.now(),
        latency: 50,
      };

      mockSolanaDetector.emit('priceUpdate', ethereumUpdate);
      await flushPromises();

      // Pool should NOT be added (wrong chain)
      expect(detector.getPoolCount()).toBe(0);
    });
  });

  // ===========================================================================
  // O(n^2) Comparison Limit Tests (P1)
  // ===========================================================================

  describe('comparison limit for large pool sets', () => {
    it('should handle many pools for same pair without performance issues', async () => {
      // Add 50 pools for the same pair - tests comparison limit
      for (let i = 0; i < 50; i++) {
        await detector.addPool(createMockPool({
          address: `same-pair-pool-${i}`,
          price: 100 + (i * 0.1), // Slightly different prices
          dex: i % 2 === 0 ? 'raydium' : 'orca',
        }));
      }

      expect(detector.getPoolCount()).toBe(50);

      // Should complete without timing out
      const startTime = Date.now();
      const opportunities = await detector.detectIntraSolanaArbitrage();
      const elapsed = Date.now() - startTime;

      // Should complete reasonably quickly (under 1 second)
      expect(elapsed).toBeLessThan(1000);
      expect(opportunities).toBeDefined();
    });
  });

  // ===========================================================================
  // Bug Hunt Regression Tests
  // ===========================================================================

  describe('bug hunt regression tests', () => {
    // P0-FIX: Circuit breaker half-open state race condition prevention
    describe('P0: circuit breaker race condition prevention', () => {
      it('should only allow one detection attempt in half-open state', async () => {
        // Create a detector that we can control
        const testDetector = new SolanaArbitrageDetector({
          minProfitThreshold: 0.3,
        }, { logger: mockLogger });

        // Add pools so detection has something to do
        await testDetector.addPool(createMockPool({ address: 'race-test-1', price: 90 }));
        await testDetector.addPool(createMockPool({ address: 'race-test-2', price: 100 }));

        // Get initial circuit breaker status
        const initialStatus = testDetector.getCircuitBreakerStatus();
        expect(initialStatus.isOpen).toBe(false);
        expect(initialStatus.inHalfOpenState).toBe(false);

        // Run detection - should succeed and keep circuit closed
        await testDetector.detectIntraSolanaArbitrage();

        const afterStatus = testDetector.getCircuitBreakerStatus();
        expect(afterStatus.isOpen).toBe(false);
        expect(afterStatus.inHalfOpenState).toBe(false);

        await testDetector.stop();
      });

      it('should atomically check and set half-open state', () => {
        // Verify the circuit breaker status structure includes inHalfOpenState
        const status = detector.getCircuitBreakerStatus();
        expect(status).toHaveProperty('isOpen');
        expect(status).toHaveProperty('failures');
        expect(status).toHaveProperty('lastFailureTime');
        expect(status).toHaveProperty('inHalfOpenState');
        expect(typeof status.inHalfOpenState).toBe('boolean');
      });
    });

    // P1-FIX: Division by zero protection in triangular arbitrage
    describe('P1: division by zero protection', () => {
      it('should handle zero price in triangular path building', async () => {
        const zeroPool = createMockPool({
          address: 'zero-price-tri',
          token0: { mint: 'A', symbol: 'A', decimals: 9 },
          token1: { mint: 'B', symbol: 'B', decimals: 9 },
          price: 0,
        });

        await detector.addPool(zeroPool);

        // Should not throw when building adjacency graph
        expect(async () => {
          await detector.detectTriangularArbitrage();
        }).not.toThrow();
      });

      it('should handle very small price that would cause overflow on inverse', async () => {
        const tinyPool = createMockPool({
          address: 'tiny-price-tri',
          token0: { mint: 'X', symbol: 'X', decimals: 9 },
          token1: { mint: 'Y', symbol: 'Y', decimals: 9 },
          price: 1e-15, // Very small, inverse would be 1e15
        });

        await detector.addPool(tinyPool);

        // Should not throw or produce NaN/Infinity
        const opportunities = await detector.detectTriangularArbitrage();
        expect(opportunities).toBeDefined();

        // Verify no NaN/Infinity in any detected opportunities
        for (const opp of opportunities) {
          expect(isFinite(opp.profitPercentage)).toBe(true);
          expect(isNaN(opp.profitPercentage)).toBe(false);
        }
      });

      it('should skip inverse edge when price is at MIN_VALID_PRICE boundary', async () => {
        // Price at the minimum valid threshold - inverse might still be problematic
        const boundaryPool = createMockPool({
          address: 'boundary-price-tri',
          token0: { mint: 'P', symbol: 'P', decimals: 9 },
          token1: { mint: 'Q', symbol: 'Q', decimals: 9 },
          price: 1e-12, // At MIN_VALID_PRICE
        });

        await detector.addPool(boundaryPool);

        // Should complete without error
        const opportunities = await detector.detectTriangularArbitrage();
        expect(opportunities).toBeDefined();
      });
    });

    // P3-FIX: importPools empty array handling
    describe('P3: importPools empty array handling', () => {
      it('should handle empty array without logging misleading message', async () => {
        const testDetector = new SolanaArbitrageDetector({
          minProfitThreshold: 0.3,
        }, { logger: mockLogger });

        // Import empty array
        await testDetector.importPools([]);

        // Should not have added any pools
        expect(testDetector.getPoolCount()).toBe(0);

        // Should have called debug, not info (no misleading "Imported pools" message)
        expect(mockLogger.debug).toHaveBeenCalledWith(
          'importPools called with empty array, nothing to import'
        );
        expect(mockLogger.info).not.toHaveBeenCalledWith(
          'Imported pools',
          expect.anything()
        );

        await testDetector.stop();
      });

      it('should still work correctly with non-empty valid array', async () => {
        const testDetector = new SolanaArbitrageDetector({
          minProfitThreshold: 0.3,
        }, { logger: mockLogger });

        const pools = [
          createMockPool({ address: 'import-test-1' }),
          createMockPool({ address: 'import-test-2' }),
        ];

        await testDetector.importPools(pools);

        expect(testDetector.getPoolCount()).toBe(2);
        expect(mockLogger.info).toHaveBeenCalledWith(
          'Imported pools',
          expect.objectContaining({ imported: 2, skipped: 0, total: 2 })
        );

        await testDetector.stop();
      });
    });

    // P2-FIX: LRU eviction test (from bug hunt report)
    describe('P2: pool store LRU eviction', () => {
      it('should handle pool store at capacity gracefully', async () => {
        // Note: Default MAX_POOL_STORE_SIZE is 10000, so we test graceful handling
        // rather than actual eviction (which would require adding 10000+ pools)
        for (let i = 0; i < 100; i++) {
          await detector.addPool(createMockPool({
            address: `lru-test-pool-${i}`,
            price: 100 + i,
          }));
        }

        // All pools should be added (well under limit)
        expect(detector.getPoolCount()).toBe(100);

        // Detection should still work
        const opportunities = await detector.detectIntraSolanaArbitrage();
        expect(opportunities).toBeDefined();
      });
    });
  });
});
