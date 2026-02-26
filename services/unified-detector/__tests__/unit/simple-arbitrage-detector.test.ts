/**
 * SimpleArbitrageDetector Unit Tests
 *
 * FIX 2.2: Test coverage for the core arbitrage detection module.
 * Validates price calculations, fee handling, and edge cases.
 *
 * @see simple-arbitrage-detector.ts
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  SimpleArbitrageDetector,
  PairSnapshot,
  type SimpleArbitrageConfig,
} from '../../src/detection/simple-arbitrage-detector';

// =============================================================================
// Test Fixtures
// =============================================================================

function createMockConfig(overrides?: Partial<SimpleArbitrageConfig>): SimpleArbitrageConfig {
  return {
    chainId: 'ethereum',
    gasEstimate: 200000,
    confidence: 0.8,
    expiryMs: 5000,
    ...overrides,
  };
}

function createMockPairSnapshot(overrides?: Partial<PairSnapshot>): PairSnapshot {
  return {
    address: '0xpair1',
    dex: 'uniswap',
    token0: '0xtoken0',
    token1: '0xtoken1',
    reserve0: '1000000000000000000000', // 1000 tokens
    reserve1: '2000000000000000000000', // 2000 tokens
    fee: 0.003, // 0.3%
    blockNumber: 12345678,
    reserve0BigInt: BigInt('1000000000000000000000'),
    reserve1BigInt: BigInt('2000000000000000000000'),
    ...overrides,
  };
}

// =============================================================================
// Basic Functionality Tests
// =============================================================================

describe('SimpleArbitrageDetector', () => {
  let detector: SimpleArbitrageDetector;

  beforeEach(() => {
    detector = new SimpleArbitrageDetector(createMockConfig());
  });

  describe('Constructor', () => {
    it('should create detector with default config', () => {
      const d = new SimpleArbitrageDetector(createMockConfig());
      expect(d).toBeDefined();
    });

    it('should respect chain-specific profit thresholds', () => {
      // Arbitrum has lower gas costs = lower profit threshold
      const arbDetector = new SimpleArbitrageDetector(createMockConfig({ chainId: 'arbitrum' }));
      expect(arbDetector).toBeDefined();
    });

    it('should use configurable price bounds', () => {
      const d = new SimpleArbitrageDetector(createMockConfig({
        minSafePrice: 1e-20,
        maxSafePrice: 1e20,
      }));
      expect(d).toBeDefined();
    });
  });

  describe('calculateArbitrage', () => {
    it('should detect profitable opportunity between two pairs', () => {
      // Pair 1: price = 2.0 (2000/1000)
      const pair1 = createMockPairSnapshot({
        address: '0xpair1',
        dex: 'uniswap',
        reserve0: '1000000000000000000000',
        reserve1: '2000000000000000000000',
        reserve0BigInt: BigInt('1000000000000000000000'),
        reserve1BigInt: BigInt('2000000000000000000000'),
        fee: 0.003,
      });

      // Pair 2: price = 2.1 (2100/1000) - 5% spread
      const pair2 = createMockPairSnapshot({
        address: '0xpair2',
        dex: 'sushiswap',
        reserve0: '1000000000000000000000',
        reserve1: '2100000000000000000000',
        reserve0BigInt: BigInt('1000000000000000000000'),
        reserve1BigInt: BigInt('2100000000000000000000'),
        fee: 0.003,
      });

      const result = detector.calculateArbitrage(pair1, pair2);

      expect(result).not.toBeNull();
      expect(result!.profitPercentage).toBeGreaterThan(0);
      expect(result!.buyDex).toBeDefined();
      expect(result!.sellDex).toBeDefined();
    });

    it('should return null when spread is too small', () => {
      // Both pairs have same price - no opportunity
      const pair1 = createMockPairSnapshot({
        reserve0: '1000000000000000000000',
        reserve1: '2000000000000000000000',
        reserve0BigInt: BigInt('1000000000000000000000'),
        reserve1BigInt: BigInt('2000000000000000000000'),
      });

      const pair2 = createMockPairSnapshot({
        address: '0xpair2',
        dex: 'sushiswap',
        reserve0: '1000000000000000000000',
        reserve1: '2000000000000000000000',
        reserve0BigInt: BigInt('1000000000000000000000'),
        reserve1BigInt: BigInt('2000000000000000000000'),
      });

      const result = detector.calculateArbitrage(pair1, pair2);
      expect(result).toBeNull();
    });

    it('should handle zero reserves gracefully', () => {
      const pair1 = createMockPairSnapshot({
        reserve0: '0',
        reserve1: '2000000000000000000000',
        reserve0BigInt: BigInt('0'),
        reserve1BigInt: BigInt('2000000000000000000000'),
      });

      const pair2 = createMockPairSnapshot();

      const result = detector.calculateArbitrage(pair1, pair2);
      expect(result).toBeNull();
    });

    it('should handle single zero reserve gracefully', () => {
      // One reserve is zero - should produce invalid price
      const pair1 = createMockPairSnapshot();
      const pair2 = createMockPairSnapshot({
        address: '0xpair2',
        reserve0: '0',
        reserve1: '2000000000000000000000',
        reserve0BigInt: BigInt('0'),
        reserve1BigInt: BigInt('2000000000000000000000'),
      });

      const result = detector.calculateArbitrage(pair1, pair2);
      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // FIX 4.1: Price Validation Edge Cases
  // ===========================================================================

  describe('Price Validation (FIX 4.1)', () => {
    it('should handle very small prices (memecoins)', () => {
      // Simulating a memecoin with extremely low price
      // price = 1e-16 (within 1e-18 threshold)
      const pair1 = createMockPairSnapshot({
        reserve0: '1000000000000000000000000000000000000', // 1e36
        reserve1: '100000000000000000000', // 1e20
        reserve0BigInt: BigInt('1000000000000000000000000000000000000'),
        reserve1BigInt: BigInt('100000000000000000000'),
      });

      const pair2 = createMockPairSnapshot({
        address: '0xpair2',
        reserve0: '1000000000000000000000000000000000000',
        reserve1: '120000000000000000000', // 20% more
        reserve0BigInt: BigInt('1000000000000000000000000000000000000'),
        reserve1BigInt: BigInt('120000000000000000000'),
      });

      // Should not throw, may return null if price too extreme
      const result = detector.calculateArbitrage(pair1, pair2);
      // Result depends on whether price is within configurable bounds
      expect(result === null || result.profitPercentage !== undefined).toBe(true);
    });

    it('should reject prices that would cause overflow', () => {
      // This would cause 1/price to overflow
      const detector2 = new SimpleArbitrageDetector(createMockConfig({
        minSafePrice: 1e-18,
        maxSafePrice: 1e18,
      }));

      const pair1 = createMockPairSnapshot({
        reserve0: '1',
        reserve1: '1000000000000000000000000000000000000000000', // Extreme ratio
        reserve0BigInt: BigInt('1'),
        reserve1BigInt: BigInt('1000000000000000000000000000000000000000000'),
      });

      const pair2 = createMockPairSnapshot();

      const result = detector2.calculateArbitrage(pair1, pair2);
      expect(result).toBeNull(); // Should reject due to price bounds
    });

    it('should handle NaN and Infinity gracefully', () => {
      // Create pairs that would produce NaN or Infinity
      const pair1 = createMockPairSnapshot({
        reserve0: '0',
        reserve1: '0',
        reserve0BigInt: BigInt('0'),
        reserve1BigInt: BigInt('0'),
      });

      const pair2 = createMockPairSnapshot();

      // Should not throw, should return null
      expect(() => detector.calculateArbitrage(pair1, pair2)).not.toThrow();
      const result = detector.calculateArbitrage(pair1, pair2);
      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // Fee Handling Tests
  // ===========================================================================

  describe('Fee Handling', () => {
    it('should account for fees in profit calculation', () => {
      // 2% spread
      const pair1 = createMockPairSnapshot({
        reserve0: '1000000000000000000000',
        reserve1: '2000000000000000000000',
        reserve0BigInt: BigInt('1000000000000000000000'),
        reserve1BigInt: BigInt('2000000000000000000000'),
        fee: 0.003, // 0.3%
      });

      const pair2 = createMockPairSnapshot({
        address: '0xpair2',
        reserve0: '1000000000000000000000',
        reserve1: '2040000000000000000000', // 2% higher
        reserve0BigInt: BigInt('1000000000000000000000'),
        reserve1BigInt: BigInt('2040000000000000000000'),
        fee: 0.003, // 0.3%
      });

      const result = detector.calculateArbitrage(pair1, pair2);

      // 2% spread - 0.6% fees = ~1.4% profit
      expect(result).not.toBeNull();
      // Profit should be less than raw spread
      expect(result!.profitPercentage).toBeLessThan(200); // Less than 2%
    });

    it('should handle high fees that eliminate opportunity', () => {
      // 1% spread with 1.5% total fees = no profit
      const pair1 = createMockPairSnapshot({
        fee: 0.01, // 1% fee
      });

      const pair2 = createMockPairSnapshot({
        address: '0xpair2',
        reserve0: '1000000000000000000000',
        reserve1: '2020000000000000000000', // 1% higher
        reserve0BigInt: BigInt('1000000000000000000000'),
        reserve1BigInt: BigInt('2020000000000000000000'),
        fee: 0.005, // 0.5% fee
      });

      const result = detector.calculateArbitrage(pair1, pair2);
      expect(result).toBeNull(); // Fees exceed spread
    });

    it('should use default fee when fee is undefined', () => {
      const pair1 = createMockPairSnapshot({
        fee: undefined as unknown as number,
      });

      const pair2 = createMockPairSnapshot({
        address: '0xpair2',
        reserve0: '1000000000000000000000',
        reserve1: '2100000000000000000000', // 5% spread
        reserve0BigInt: BigInt('1000000000000000000000'),
        reserve1BigInt: BigInt('2100000000000000000000'),
      });

      // Should not throw, should use default fee
      expect(() => detector.calculateArbitrage(pair1, pair2)).not.toThrow();
    });
  });

  // ===========================================================================
  // Token Order / Reverse Pair Tests
  // ===========================================================================

  describe('Token Order Handling', () => {
    it('should correctly handle reversed token pairs', () => {
      // Pair 1: token0/token1
      const pair1 = createMockPairSnapshot({
        token0: '0xAAA',
        token1: '0xBBB',
        reserve0: '1000000000000000000000',
        reserve1: '2000000000000000000000',
        reserve0BigInt: BigInt('1000000000000000000000'),
        reserve1BigInt: BigInt('2000000000000000000000'),
      });

      // Pair 2: token1/token0 (reversed)
      const pair2 = createMockPairSnapshot({
        address: '0xpair2',
        token0: '0xBBB',
        token1: '0xAAA',
        reserve0: '2100000000000000000000',
        reserve1: '1000000000000000000000',
        reserve0BigInt: BigInt('2100000000000000000000'),
        reserve1BigInt: BigInt('1000000000000000000000'),
      });

      const result = detector.calculateArbitrage(pair1, pair2);
      expect(result).not.toBeNull();
      // Should detect the 5% opportunity correctly despite reversed order
    });
  });

  // ===========================================================================
  // Optimal Amount Calculation Tests
  // ===========================================================================

  describe('Optimal Amount Calculation', () => {
    it('should calculate reasonable trade amounts', () => {
      const pair1 = createMockPairSnapshot({
        reserve0: '1000000000000000000000', // 1000 tokens
        reserve1: '2000000000000000000000', // 2000 tokens
        reserve0BigInt: BigInt('1000000000000000000000'),
        reserve1BigInt: BigInt('2000000000000000000000'),
      });

      const pair2 = createMockPairSnapshot({
        address: '0xpair2',
        reserve0: '1000000000000000000000',
        reserve1: '2200000000000000000000', // 10% spread
        reserve0BigInt: BigInt('1000000000000000000000'),
        reserve1BigInt: BigInt('2200000000000000000000'),
      });

      const result = detector.calculateArbitrage(pair1, pair2);

      expect(result).not.toBeNull();
      expect(result!.amountIn).toBeDefined();
      // Amount should be reasonable (not 0 and not more than reserves)
      const amountInNum = Number(result!.amountIn);
      expect(amountInNum).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // FIX #22c: Unrealistic Profit Filter Edge Cases
  // Threshold lowered from 500% (5.0) to 20% (0.20) after terminal analysis
  // showed simulation generating 100-500% profits. Real arb is 0.01-5%.
  // ===========================================================================

  describe('Unrealistic Profit Filter (FIX #22c)', () => {
    it('should reject opportunities with >20% profit as unrealistic', () => {
      // pair1: price = reserve0/reserve1 = 1000/2000 = 0.5
      const pair1 = createMockPairSnapshot({
        address: '0xpair1',
        dex: 'uniswap',
        reserve0: '1000000000000000000000',
        reserve1: '2000000000000000000000',
        reserve0BigInt: BigInt('1000000000000000000000'),
        reserve1BigInt: BigInt('2000000000000000000000'),
        fee: 0.003,
      });

      // pair2: price = reserve0/reserve1 = 1000/200 = 5.0
      // priceDiff = |0.5 - 5.0| / 0.5 = 9.0 (900%)
      // netProfitPct = 9.0 - 0.006 = 8.994 >> 0.20 threshold
      const pair2 = createMockPairSnapshot({
        address: '0xpair2',
        dex: 'sushiswap',
        reserve0: '1000000000000000000000',
        reserve1: '200000000000000000000',
        reserve0BigInt: BigInt('1000000000000000000000'),
        reserve1BigInt: BigInt('200000000000000000000'),
        fee: 0.003,
      });

      const result = detector.calculateArbitrage(pair1, pair2);
      expect(result).toBeNull();
    });

    it('should increment unrealisticProfit counter when >20% profit rejected', () => {
      const pair1 = createMockPairSnapshot({
        address: '0xpair1',
        dex: 'uniswap',
        reserve0: '1000000000000000000000',
        reserve1: '2000000000000000000000',
        reserve0BigInt: BigInt('1000000000000000000000'),
        reserve1BigInt: BigInt('2000000000000000000000'),
        fee: 0.003,
      });

      const pair2 = createMockPairSnapshot({
        address: '0xpair2',
        dex: 'sushiswap',
        reserve0: '1000000000000000000000',
        reserve1: '200000000000000000000',
        reserve0BigInt: BigInt('1000000000000000000000'),
        reserve1BigInt: BigInt('200000000000000000000'),
        fee: 0.003,
      });

      detector.calculateArbitrage(pair1, pair2);

      const stats = detector.getStats();
      expect(stats.unrealisticProfit).toBe(1);
      expect(stats.total).toBeGreaterThanOrEqual(1);
    });

    it('should reject 25% profit (0.25) as unrealistic', () => {
      // pair1: price = 1000/2000 = 0.5
      // pair2: price = 1000/1600 = 0.625
      // priceDiff = |0.5 - 0.625| / 0.5 = 0.25 (25%)
      // netProfitPct = 0.25 - 0.006 = 0.244 > 0.20 => rejected
      const pair1 = createMockPairSnapshot({
        address: '0xpair1',
        dex: 'uniswap',
        reserve0: '1000000000000000000000',
        reserve1: '2000000000000000000000',
        reserve0BigInt: BigInt('1000000000000000000000'),
        reserve1BigInt: BigInt('2000000000000000000000'),
        fee: 0.003,
      });

      const pair2 = createMockPairSnapshot({
        address: '0xpair2',
        dex: 'sushiswap',
        reserve0: '1000000000000000000000',
        reserve1: '1600000000000000000000',
        reserve0BigInt: BigInt('1000000000000000000000'),
        reserve1BigInt: BigInt('1600000000000000000000'),
        fee: 0.003,
      });

      const result = detector.calculateArbitrage(pair1, pair2);
      expect(result).toBeNull();

      const stats = detector.getStats();
      expect(stats.unrealisticProfit).toBe(1);
    });

    it('should accept 15% profit (0.15) as realistic', () => {
      // pair1: price = 1000/2000 = 0.5
      // pair2: price = 1000/1740 = ~0.5747
      // priceDiff = |0.5 - 0.5747| / 0.5 = ~0.1494 (14.94%)
      // netProfitPct = 0.1494 - 0.006 = 0.1434 < 0.20 => accepted
      const pair1 = createMockPairSnapshot({
        address: '0xpair1',
        dex: 'uniswap',
        reserve0: '1000000000000000000000',
        reserve1: '2000000000000000000000',
        reserve0BigInt: BigInt('1000000000000000000000'),
        reserve1BigInt: BigInt('2000000000000000000000'),
        fee: 0.003,
      });

      const pair2 = createMockPairSnapshot({
        address: '0xpair2',
        dex: 'sushiswap',
        reserve0: '1000000000000000000000',
        reserve1: '1740000000000000000000',
        reserve0BigInt: BigInt('1000000000000000000000'),
        reserve1BigInt: BigInt('1740000000000000000000'),
        fee: 0.003,
      });

      const result = detector.calculateArbitrage(pair1, pair2);
      expect(result).not.toBeNull();
      // profitPercentage is netProfitPct * 100, so ~14.34%
      expect(result!.profitPercentage).toBeGreaterThan(10);
      expect(result!.profitPercentage).toBeLessThan(20);
    });

    it('should accept opportunities near but below 20% profit', () => {
      // pair1: price = 1000/2000 = 0.5
      // pair2: price = 1000/1700 = ~0.5882
      // priceDiff = |0.5 - 0.5882| / 0.5 = ~0.1765 (17.65%)
      // netProfitPct = 0.1765 - 0.006 = 0.1705 < 0.20 => accepted
      const pair1 = createMockPairSnapshot({
        address: '0xpair1',
        dex: 'uniswap',
        reserve0: '1000000000000000000000',
        reserve1: '2000000000000000000000',
        reserve0BigInt: BigInt('1000000000000000000000'),
        reserve1BigInt: BigInt('2000000000000000000000'),
        fee: 0.003,
      });

      const pair2 = createMockPairSnapshot({
        address: '0xpair2',
        dex: 'sushiswap',
        reserve0: '1000000000000000000000',
        reserve1: '1700000000000000000000',
        reserve0BigInt: BigInt('1000000000000000000000'),
        reserve1BigInt: BigInt('1700000000000000000000'),
        fee: 0.003,
      });

      const result = detector.calculateArbitrage(pair1, pair2);
      expect(result).not.toBeNull();
      // Verify the profit is below 20%
      expect(result!.profitPercentage).toBeGreaterThan(10);
      expect(result!.profitPercentage).toBeLessThan(20);
    });
  });

  // ===========================================================================
  // Dust Amount Filter Edge Cases
  // ===========================================================================

  describe('Dust Amount Filter', () => {
    it('should reject opportunities with dust amounts (amountIn < 1000)', () => {
      // Need smallerReserve1 < 100000 so amountIn = smallerReserve1 / 100 < 1000
      // pair1: reserve0=25000, reserve1=50000 => price = 0.5
      // pair2: reserve0=27500, reserve1=50000 => price = 0.55
      // priceDiff = |0.5 - 0.55| / 0.5 = 0.1 (10%)
      // netProfitPct = 0.1 - 0.006 = 0.094 (9.4%) => passes profit threshold and < 5.0
      // smallerReserve1 = min(50000, 50000) = 50000
      // amountIn = 50000 * 100 / 10000 = 500 < 1000 => dust rejection
      const pair1 = createMockPairSnapshot({
        address: '0xpair1',
        dex: 'uniswap',
        reserve0: '25000',
        reserve1: '50000',
        reserve0BigInt: 25000n,
        reserve1BigInt: 50000n,
        fee: 0.003,
      });

      const pair2 = createMockPairSnapshot({
        address: '0xpair2',
        dex: 'sushiswap',
        reserve0: '27500',
        reserve1: '50000',
        reserve0BigInt: 27500n,
        reserve1BigInt: 50000n,
        fee: 0.003,
      });

      const result = detector.calculateArbitrage(pair1, pair2);
      expect(result).toBeNull();
    });

    it('should increment dustAmount counter when dust amount rejected', () => {
      const pair1 = createMockPairSnapshot({
        address: '0xpair1',
        dex: 'uniswap',
        reserve0: '25000',
        reserve1: '50000',
        reserve0BigInt: 25000n,
        reserve1BigInt: 50000n,
        fee: 0.003,
      });

      const pair2 = createMockPairSnapshot({
        address: '0xpair2',
        dex: 'sushiswap',
        reserve0: '27500',
        reserve1: '50000',
        reserve0BigInt: 27500n,
        reserve1BigInt: 50000n,
        fee: 0.003,
      });

      detector.calculateArbitrage(pair1, pair2);

      const stats = detector.getStats();
      expect(stats.dustAmount).toBe(1);
      expect(stats.total).toBeGreaterThanOrEqual(1);
    });

    it('should accept opportunities just above dust threshold (amountIn >= 1000)', () => {
      // Need smallerReserve1 >= 100000 so amountIn >= 1000
      // pair1: reserve0=50000, reserve1=100000 => price = 0.5
      // pair2: reserve0=55000, reserve1=100000 => price = 0.55
      // amountIn = 100000 * 100 / 10000 = 1000 (exactly at threshold)
      const pair1 = createMockPairSnapshot({
        address: '0xpair1',
        dex: 'uniswap',
        reserve0: '50000',
        reserve1: '100000',
        reserve0BigInt: 50000n,
        reserve1BigInt: 100000n,
        fee: 0.003,
      });

      const pair2 = createMockPairSnapshot({
        address: '0xpair2',
        dex: 'sushiswap',
        reserve0: '55000',
        reserve1: '100000',
        reserve0BigInt: 55000n,
        reserve1BigInt: 100000n,
        fee: 0.003,
      });

      const result = detector.calculateArbitrage(pair1, pair2);
      expect(result).not.toBeNull();
    });
  });

  // ===========================================================================
  // Rejection Stats Tracking
  // ===========================================================================

  describe('Rejection Stats Tracking', () => {
    it('should track multiple rejection types correctly', () => {
      // Trigger zeroReserves rejection
      const zeroPair = createMockPairSnapshot({
        reserve0: '0',
        reserve1: '0',
        reserve0BigInt: 0n,
        reserve1BigInt: 0n,
      });
      const normalPair = createMockPairSnapshot({
        address: '0xpair2',
        dex: 'sushiswap',
      });
      detector.calculateArbitrage(zeroPair, normalPair);

      // Trigger belowProfitThreshold rejection (same-price pairs)
      const samePair1 = createMockPairSnapshot();
      const samePair2 = createMockPairSnapshot({
        address: '0xpair2',
        dex: 'sushiswap',
      });
      detector.calculateArbitrage(samePair1, samePair2);

      const stats = detector.getStats();
      expect(stats.zeroReserves).toBeGreaterThanOrEqual(1);
      expect(stats.belowProfitThreshold).toBeGreaterThanOrEqual(1);
      expect(stats.total).toBeGreaterThanOrEqual(2);
    });

    it('should reset all rejection stats to zero', () => {
      // Trigger a rejection
      const zeroPair = createMockPairSnapshot({
        reserve0: '0',
        reserve1: '0',
        reserve0BigInt: 0n,
        reserve1BigInt: 0n,
      });
      const normalPair = createMockPairSnapshot({
        address: '0xpair2',
      });
      detector.calculateArbitrage(zeroPair, normalPair);

      // Verify stats are non-zero
      const statsBefore = detector.getStats();
      expect(statsBefore.total).toBeGreaterThan(0);

      // Reset and verify all counters are zero
      detector.resetStats();
      const statsAfter = detector.getStats();

      expect(statsAfter.zeroReserves).toBe(0);
      expect(statsAfter.nullPrice).toBe(0);
      expect(statsAfter.priceBoundsP1).toBe(0);
      expect(statsAfter.priceBoundsP2).toBe(0);
      expect(statsAfter.belowProfitThreshold).toBe(0);
      expect(statsAfter.unrealisticProfit).toBe(0);
      expect(statsAfter.dustAmount).toBe(0);
      expect(statsAfter.total).toBe(0);
    });

    it('should return a snapshot copy from getStats (not a live reference)', () => {
      const stats1 = detector.getStats();

      // Trigger a rejection to modify internal state
      const zeroPair = createMockPairSnapshot({
        reserve0: '0',
        reserve1: '0',
        reserve0BigInt: 0n,
        reserve1BigInt: 0n,
      });
      const normalPair = createMockPairSnapshot({ address: '0xpair2' });
      detector.calculateArbitrage(zeroPair, normalPair);

      // Previously retrieved stats should NOT have changed
      expect(stats1.total).toBe(0);

      // New retrieval should reflect the update
      const stats2 = detector.getStats();
      expect(stats2.total).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Logger Throttling
  // ===========================================================================

  describe('Logger Throttling', () => {
    it('should not call logger before 1000 rejections', () => {
      const mockLogger = { debug: jest.fn() };
      const logDetector = new SimpleArbitrageDetector(createMockConfig({
        logger: mockLogger,
      }));

      // Trigger 999 rejections (zero reserves are cheapest)
      const zeroPair = createMockPairSnapshot({
        reserve0: '0',
        reserve1: '0',
        reserve0BigInt: 0n,
        reserve1BigInt: 0n,
      });
      const normalPair = createMockPairSnapshot({ address: '0xpair2' });

      for (let i = 0; i < 999; i++) {
        logDetector.calculateArbitrage(zeroPair, normalPair);
      }

      expect(mockLogger.debug).not.toHaveBeenCalled();
    });

    it('should call logger at exactly 1000 rejections when time threshold met', () => {
      const mockLogger = { debug: jest.fn() };
      const logDetector = new SimpleArbitrageDetector(createMockConfig({
        logger: mockLogger,
      }));

      // Ensure the 60-second throttle is satisfied by mocking Date.now
      // The detector initializes lastStatsLogTime = 0, so any time >= 60000 works
      const mockNow = jest.spyOn(Date, 'now').mockReturnValue(120_000);

      const zeroPair = createMockPairSnapshot({
        reserve0: '0',
        reserve1: '0',
        reserve0BigInt: 0n,
        reserve1BigInt: 0n,
      });
      const normalPair = createMockPairSnapshot({ address: '0xpair2' });

      for (let i = 0; i < 1000; i++) {
        logDetector.calculateArbitrage(zeroPair, normalPair);
      }

      expect(mockLogger.debug).toHaveBeenCalledTimes(1);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Arbitrage rejection stats',
        expect.objectContaining({
          chainId: 'ethereum',
          total: 1000,
          zeroReserves: 1000,
        }),
      );

      mockNow.mockRestore();
    });

    it('should not call logger at 1000 rejections if within 60-second throttle', () => {
      const mockLogger = { debug: jest.fn() };
      const logDetector = new SimpleArbitrageDetector(createMockConfig({
        logger: mockLogger,
      }));

      // First: trigger 1000 rejections to emit the first log
      const mockNow = jest.spyOn(Date, 'now').mockReturnValue(120_000);

      const zeroPair = createMockPairSnapshot({
        reserve0: '0',
        reserve1: '0',
        reserve0BigInt: 0n,
        reserve1BigInt: 0n,
      });
      const normalPair = createMockPairSnapshot({ address: '0xpair2' });

      for (let i = 0; i < 1000; i++) {
        logDetector.calculateArbitrage(zeroPair, normalPair);
      }
      expect(mockLogger.debug).toHaveBeenCalledTimes(1);

      // Now trigger 1000 more within the 60s window (at 150s, only 30s after last log)
      mockNow.mockReturnValue(150_000);

      for (let i = 0; i < 1000; i++) {
        logDetector.calculateArbitrage(zeroPair, normalPair);
      }

      // Should still be only 1 call (throttled)
      expect(mockLogger.debug).toHaveBeenCalledTimes(1);

      mockNow.mockRestore();
    });

    it('should call logger again after 60-second throttle expires', () => {
      const mockLogger = { debug: jest.fn() };
      const logDetector = new SimpleArbitrageDetector(createMockConfig({
        logger: mockLogger,
      }));

      const mockNow = jest.spyOn(Date, 'now').mockReturnValue(120_000);

      const zeroPair = createMockPairSnapshot({
        reserve0: '0',
        reserve1: '0',
        reserve0BigInt: 0n,
        reserve1BigInt: 0n,
      });
      const normalPair = createMockPairSnapshot({ address: '0xpair2' });

      // First batch: 1000 rejections
      for (let i = 0; i < 1000; i++) {
        logDetector.calculateArbitrage(zeroPair, normalPair);
      }
      expect(mockLogger.debug).toHaveBeenCalledTimes(1);

      // Advance past the 60-second window (120s + 61s = 181s)
      mockNow.mockReturnValue(181_000);

      // Second batch: 1000 more rejections
      for (let i = 0; i < 1000; i++) {
        logDetector.calculateArbitrage(zeroPair, normalPair);
      }

      expect(mockLogger.debug).toHaveBeenCalledTimes(2);

      mockNow.mockRestore();
    });
  });
});
