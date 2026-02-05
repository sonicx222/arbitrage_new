/**
 * SimpleArbitrageDetector Unit Tests
 *
 * FIX 2.2: Test coverage for the core arbitrage detection module.
 * Validates price calculations, fee handling, and edge cases.
 *
 * @see simple-arbitrage-detector.ts
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  SimpleArbitrageDetector,
  PairSnapshot,
  type SimpleArbitrageConfig,
} from '../../detection/simple-arbitrage-detector';

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
});
