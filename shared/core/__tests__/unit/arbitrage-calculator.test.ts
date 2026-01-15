/**
 * Arbitrage Calculator Unit Tests
 *
 * Tests for the shared arbitrage calculation module (REF-1/ARCH-1).
 * Validates calculation logic used by:
 * - unified-detector/chain-instance.ts (intra-chain)
 * - cross-chain-detector/detector.ts (cross-chain)
 *
 * @migrated from shared/core/src/arbitrage-calculator.test.ts
 * @see ADR-009: Test Architecture
 */

import { describe, it, expect } from '@jest/globals';
import {
  PairSnapshot,
  ChainPriceData,
  safeBigIntDivision,
  calculatePriceFromReserves,
  calculatePriceFromBigIntReserves,
  invertPrice,
  calculatePriceDifferencePercent,
  isSameTokenPair,
  isReverseOrder,
  getMinProfitThreshold,
  getDefaultFee,
  calculateIntraChainArbitrage,
  calculateCrossChainArbitrage,
  validatePairSnapshot,
  createPairSnapshot
} from '@arbitrage/core';

// =============================================================================
// Test Data
// =============================================================================

const createTestPair = (overrides: Partial<PairSnapshot> = {}): PairSnapshot => ({
  address: '0x1234567890123456789012345678901234567890',
  dex: 'uniswap_v3',
  token0: '0xTokenA',
  token1: '0xTokenB',
  reserve0: '1000000000000000000000', // 1000 tokens
  reserve1: '2000000000000000000000', // 2000 tokens (price = 2)
  fee: 0.003, // 0.3%
  blockNumber: 12345678,
  ...overrides
});

// =============================================================================
// P0-1 FIX: BigInt Precision Regression Tests
// =============================================================================

describe('P0-1: BigInt Precision (safeBigIntDivision)', () => {
  it('should handle simple division correctly', () => {
    expect(safeBigIntDivision(10n, 2n)).toBe(5);
    expect(safeBigIntDivision(100n, 4n)).toBe(25);
  });

  it('should handle division resulting in decimals', () => {
    expect(safeBigIntDivision(1n, 2n)).toBe(0.5);
    expect(safeBigIntDivision(1n, 3n)).toBeCloseTo(0.333333, 5);
    expect(safeBigIntDivision(2n, 3n)).toBeCloseTo(0.666666, 5);
  });

  it('should return 0 for zero denominator', () => {
    expect(safeBigIntDivision(100n, 0n)).toBe(0);
  });

  it('should handle very large BigInt values (> 2^53) without precision loss', () => {
    // This is the key regression test for P0-1
    // JavaScript Number can only safely represent integers up to 2^53 - 1 (9007199254740991)
    // Reserve values in wei can easily exceed this (e.g., 1 billion tokens = 10^27 wei)

    // Test with values that would lose precision if converted to Number directly
    const reserve0 = BigInt('1000000000000000000000000000'); // 10^27 (1 billion tokens in wei)
    const reserve1 = BigInt('500000000000000000000000000');  // 5e26

    const result = safeBigIntDivision(reserve0, reserve1);

    // Should be exactly 2, not some imprecise value
    expect(result).toBe(2);
  });

  it('should preserve precision for realistic DeFi reserve values', () => {
    // Uniswap V3 pool reserves can be very large
    // ETH/USDC pool might have:
    // - 10,000 ETH (10^22 wei)
    // - 30,000,000 USDC (3*10^13 with 6 decimals)

    const ethReserve = BigInt('10000000000000000000000'); // 10,000 ETH in wei
    const usdcReserve = BigInt('30000000000000');         // 30,000,000 USDC (6 decimals)

    const price = safeBigIntDivision(ethReserve, usdcReserve);

    // Price = ethReserve / usdcReserve = 10^22 / (3*10^13) = 10^9 / 3 ≈ 333,333,333
    // This represents the raw ratio without decimal adjustment
    expect(price).toBeCloseTo(333333333.333, 0);
  });

  it('should handle small ratios accurately', () => {
    // Test small price ratios (like stablecoin pairs)
    const reserve0 = BigInt('1000000000000000000000000'); // 1M tokens
    const reserve1 = BigInt('1001000000000000000000000'); // 1.001M tokens (0.1% difference)

    const price = safeBigIntDivision(reserve0, reserve1);

    // Should be approximately 0.999001 (very close to 1)
    expect(price).toBeCloseTo(0.999001, 5);
  });

  it('should handle extreme ratios without overflow', () => {
    // Very large ratio
    const bigReserve = BigInt('1000000000000000000000000000000'); // 10^30
    const smallReserve = BigInt('1000000000000000000');           // 10^18

    const largeRatio = safeBigIntDivision(bigReserve, smallReserve);
    expect(largeRatio).toBe(1e12);

    // Very small ratio
    const smallRatio = safeBigIntDivision(smallReserve, bigReserve);
    expect(smallRatio).toBe(1e-12);
  });
});

describe('P0-1: calculatePriceFromBigIntReserves()', () => {
  it('should calculate price from BigInt reserves', () => {
    const result = calculatePriceFromBigIntReserves(
      BigInt('1000000000000000000000'),
      BigInt('2000000000000000000000')
    );
    expect(result).toBe(0.5);
  });

  it('should return null for zero reserves', () => {
    expect(calculatePriceFromBigIntReserves(0n, 100n)).toBeNull();
    expect(calculatePriceFromBigIntReserves(100n, 0n)).toBeNull();
    expect(calculatePriceFromBigIntReserves(0n, 0n)).toBeNull();
  });

  it('should handle large reserves that would overflow Number', () => {
    // Values larger than Number.MAX_SAFE_INTEGER
    const reserve0 = BigInt('9007199254740992000000000000'); // > 2^53
    const reserve1 = BigInt('4503599627370496000000000000'); // > 2^52

    const result = calculatePriceFromBigIntReserves(reserve0, reserve1);

    // Should be exactly 2
    expect(result).toBe(2);
  });
});

// =============================================================================
// Price Calculation Tests
// =============================================================================

describe('Price Calculation Utilities', () => {
  describe('calculatePriceFromReserves()', () => {
    it('should calculate price correctly', () => {
      const price = calculatePriceFromReserves(
        '1000000000000000000000',
        '2000000000000000000000'
      );
      expect(price).toBe(0.5); // 1000/2000
    });

    it('should return null for zero reserve0', () => {
      const price = calculatePriceFromReserves('0', '2000000000000000000000');
      expect(price).toBeNull();
    });

    it('should return null for zero reserve1', () => {
      const price = calculatePriceFromReserves('1000000000000000000000', '0');
      expect(price).toBeNull();
    });

    it('should handle large numbers', () => {
      const price = calculatePriceFromReserves(
        '1000000000000000000000000000000', // 1e30
        '500000000000000000000000000000'   // 5e29
      );
      expect(price).toBe(2);
    });
  });

  describe('invertPrice()', () => {
    it('should invert positive price', () => {
      expect(invertPrice(2)).toBe(0.5);
      expect(invertPrice(0.5)).toBe(2);
    });

    it('should return 0 for zero price', () => {
      expect(invertPrice(0)).toBe(0);
    });

    it('should handle very small prices', () => {
      const result = invertPrice(0.0001);
      expect(result).toBe(10000);
    });
  });

  describe('calculatePriceDifferencePercent()', () => {
    it('should calculate positive difference', () => {
      const diff = calculatePriceDifferencePercent(100, 110);
      expect(diff).toBeCloseTo(0.1, 5); // 10%
    });

    it('should calculate same result regardless of order', () => {
      const diff1 = calculatePriceDifferencePercent(100, 110);
      const diff2 = calculatePriceDifferencePercent(110, 100);
      expect(diff1).toBe(diff2);
    });

    it('should return 0 for zero prices', () => {
      expect(calculatePriceDifferencePercent(0, 100)).toBe(0);
      expect(calculatePriceDifferencePercent(100, 0)).toBe(0);
    });

    it('should calculate small differences accurately', () => {
      const diff = calculatePriceDifferencePercent(1000, 1001);
      expect(diff).toBeCloseTo(0.001, 5); // 0.1%
    });
  });
});

// =============================================================================
// Token Pair Utilities Tests
// =============================================================================

describe('Token Pair Utilities', () => {
  describe('isSameTokenPair()', () => {
    it('should detect same token pair in same order', () => {
      const pair1 = createTestPair({ token0: '0xWETH', token1: '0xUSDC' });
      const pair2 = createTestPair({
        token0: '0xWETH',
        token1: '0xUSDC',
        dex: 'sushiswap'
      });
      expect(isSameTokenPair(pair1, pair2)).toBe(true);
    });

    it('should detect same token pair in reverse order', () => {
      const pair1 = createTestPair({ token0: '0xWETH', token1: '0xUSDC' });
      const pair2 = createTestPair({
        token0: '0xUSDC',
        token1: '0xWETH',
        dex: 'sushiswap'
      });
      expect(isSameTokenPair(pair1, pair2)).toBe(true);
    });

    it('should detect different token pairs', () => {
      const pair1 = createTestPair({ token0: '0xWETH', token1: '0xUSDC' });
      const pair2 = createTestPair({
        token0: '0xWETH',
        token1: '0xDAI',
        dex: 'sushiswap'
      });
      expect(isSameTokenPair(pair1, pair2)).toBe(false);
    });

    it('should handle case-insensitive comparison', () => {
      const pair1 = createTestPair({
        token0: '0xABCDEF1234567890',
        token1: '0x1234567890ABCDEF'
      });
      const pair2 = createTestPair({
        token0: '0xabcdef1234567890',
        token1: '0x1234567890abcdef',
        dex: 'sushiswap'
      });
      expect(isSameTokenPair(pair1, pair2)).toBe(true);
    });
  });

  describe('isReverseOrder()', () => {
    it('should return false for same order', () => {
      const pair1 = createTestPair({ token0: '0xWETH', token1: '0xUSDC' });
      const pair2 = createTestPair({
        token0: '0xWETH',
        token1: '0xUSDC',
        dex: 'sushiswap'
      });
      expect(isReverseOrder(pair1, pair2)).toBe(false);
    });

    it('should return true for reverse order', () => {
      const pair1 = createTestPair({ token0: '0xWETH', token1: '0xUSDC' });
      const pair2 = createTestPair({
        token0: '0xUSDC',
        token1: '0xWETH',
        dex: 'sushiswap'
      });
      expect(isReverseOrder(pair1, pair2)).toBe(true);
    });

    it('should handle case-insensitive comparison', () => {
      const pair1 = createTestPair({ token0: '0xAAAA', token1: '0xBBBB' });
      const pair2 = createTestPair({
        token0: '0xbbbb',
        token1: '0xaaaa',
        dex: 'sushiswap'
      });
      expect(isReverseOrder(pair1, pair2)).toBe(true);
    });
  });
});

// =============================================================================
// Profit Threshold Utilities Tests
// =============================================================================

describe('Profit Threshold Utilities', () => {
  describe('getMinProfitThreshold()', () => {
    it('should return Ethereum threshold (0.5%)', () => {
      expect(getMinProfitThreshold('ethereum')).toBe(0.005);
    });

    it('should return Arbitrum threshold (0.2%)', () => {
      expect(getMinProfitThreshold('arbitrum')).toBe(0.002);
    });

    it('should return Optimism threshold (0.2%)', () => {
      expect(getMinProfitThreshold('optimism')).toBe(0.002);
    });

    it('should return BSC threshold (0.3%)', () => {
      expect(getMinProfitThreshold('bsc')).toBe(0.003);
    });

    it('should return default threshold for unknown chain', () => {
      expect(getMinProfitThreshold('unknown_chain')).toBe(0.003);
    });
  });

  describe('getDefaultFee()', () => {
    it('should return 0.3% for standard DEXes', () => {
      expect(getDefaultFee('uniswap_v3')).toBe(0.003);
      expect(getDefaultFee('sushiswap')).toBe(0.003);
    });

    it('should return 0.04% for Curve', () => {
      expect(getDefaultFee('curve')).toBe(0.0004);
    });

    it('should return 0.04% for Balancer', () => {
      expect(getDefaultFee('balancer')).toBe(0.0004);
    });

    it('should return default for undefined', () => {
      expect(getDefaultFee(undefined)).toBe(0.003);
    });
  });
});

// =============================================================================
// Intra-Chain Arbitrage Calculator Tests
// =============================================================================

describe('calculateIntraChainArbitrage()', () => {
  it('should detect profitable arbitrage opportunity', () => {
    // 5% price difference, 0.6% total fees = 4.4% net profit
    const pair1 = createTestPair({
      reserve0: '1000000000000000000000',
      reserve1: '2000000000000000000000',
      fee: 0.003
    });
    const pair2 = createTestPair({
      reserve0: '1000000000000000000000',
      reserve1: '2100000000000000000000', // 5% higher price
      dex: 'sushiswap',
      fee: 0.003
    });

    const result = calculateIntraChainArbitrage(pair1, pair2, { chainId: 'arbitrum' });

    expect(result).not.toBeNull();
    expect(result!.type).toBe('simple');
    expect(result!.chain).toBe('arbitrum');
    expect(result!.profitPercentage).toBeGreaterThan(0);
    expect(result!.buyDex).toBeDefined();
    expect(result!.sellDex).toBeDefined();
  });

  it('should return null for non-profitable opportunity', () => {
    // 0.3% price difference, 0.6% total fees = negative net profit
    const pair1 = createTestPair({
      reserve0: '1000000000000000000000',
      reserve1: '2000000000000000000000',
      fee: 0.003
    });
    const pair2 = createTestPair({
      reserve0: '1000000000000000000000',
      reserve1: '2006000000000000000000', // 0.3% higher
      dex: 'sushiswap',
      fee: 0.003
    });

    const result = calculateIntraChainArbitrage(pair1, pair2, { chainId: 'arbitrum' });
    expect(result).toBeNull();
  });

  it('should handle reverse order pairs', () => {
    const pair1 = createTestPair({
      token0: '0xWETH',
      token1: '0xUSDC',
      reserve0: '1000000000000000000',
      reserve1: '2000000000',
      fee: 0.001
    });
    const pair2 = createTestPair({
      token0: '0xUSDC',
      token1: '0xWETH',
      reserve0: '2100000000', // Reversed with 5% price diff
      reserve1: '1000000000000000000',
      dex: 'curve',
      fee: 0.0004
    });

    const result = calculateIntraChainArbitrage(pair1, pair2, { chainId: 'ethereum' });
    // Should not crash and should handle the inversion
    expect(result).toBeDefined();
  });

  it('should return null for zero reserves', () => {
    const pair1 = createTestPair();
    const pair2 = createTestPair({
      reserve0: '0',
      dex: 'sushiswap'
    });

    const result = calculateIntraChainArbitrage(pair1, pair2, { chainId: 'arbitrum' });
    expect(result).toBeNull();
  });

  it('should include all required fields in opportunity', () => {
    const pair1 = createTestPair({
      reserve0: '1000000000000000000000',
      reserve1: '2000000000000000000000',
      fee: 0.001
    });
    const pair2 = createTestPair({
      reserve0: '1000000000000000000000',
      reserve1: '2200000000000000000000', // 10% higher
      dex: 'sushiswap',
      fee: 0.001
    });

    const result = calculateIntraChainArbitrage(pair1, pair2, {
      chainId: 'ethereum',
      gasEstimate: 200000,
      confidence: 0.9,
      expiryMs: 10000
    });

    expect(result).not.toBeNull();
    expect(result!.id).toMatch(/^ethereum-/);
    expect(result!.type).toBe('simple');
    expect(result!.chain).toBe('ethereum');
    expect(result!.buyDex).toBeDefined();
    expect(result!.sellDex).toBeDefined();
    expect(result!.buyPair).toBeDefined();
    expect(result!.sellPair).toBeDefined();
    expect(result!.token0).toBe(pair1.token0);
    expect(result!.token1).toBe(pair1.token1);
    expect(result!.buyPrice).toBeDefined();
    expect(result!.sellPrice).toBeDefined();
    expect(result!.buyPrice!).toBeLessThan(result!.sellPrice!);
    expect(result!.gasEstimate).toBe('200000'); // String for BigInt compatibility
    expect(result!.confidence).toBe(0.9);
    expect(result!.timestamp).toBeDefined();
    expect(result!.expiresAt).toBeGreaterThan(result!.timestamp!);
    expect(result!.status).toBe('pending');
  });

  it('should use default config values', () => {
    const pair1 = createTestPair({
      reserve0: '1000000000000000000000',
      reserve1: '2000000000000000000000',
      fee: 0.001
    });
    const pair2 = createTestPair({
      reserve0: '1000000000000000000000',
      reserve1: '2200000000000000000000',
      dex: 'sushiswap',
      fee: 0.001
    });

    const result = calculateIntraChainArbitrage(pair1, pair2, { chainId: 'arbitrum' });

    expect(result).not.toBeNull();
    expect(result!.gasEstimate).toBe('150000'); // Default (string for BigInt compatibility)
    expect(result!.confidence).toBe(0.8); // Default
    expect(result!.expiresAt! - result!.timestamp!).toBe(5000); // Default 5s expiry
  });
});

// =============================================================================
// Cross-Chain Arbitrage Calculator Tests
// =============================================================================

describe('calculateCrossChainArbitrage()', () => {
  it('should detect cross-chain arbitrage opportunity', () => {
    const chainPrices: ChainPriceData[] = [
      { chain: 'ethereum', dex: 'uniswap_v3', price: 100, timestamp: Date.now(), pairKey: 'WETH-USDC' },
      { chain: 'arbitrum', dex: 'sushiswap', price: 105, timestamp: Date.now(), pairKey: 'WETH-USDC' }
    ];

    const result = calculateCrossChainArbitrage(chainPrices, 0.5);

    expect(result).not.toBeNull();
    expect(result!.sourceChain).toBe('ethereum');
    expect(result!.targetChain).toBe('arbitrum');
    expect(result!.priceDiff).toBe(5);
    expect(result!.netProfit).toBeGreaterThan(0);
  });

  it('should return null with insufficient chain prices', () => {
    const result = calculateCrossChainArbitrage([
      { chain: 'ethereum', dex: 'uniswap_v3', price: 100, timestamp: Date.now() }
    ], 0.5);

    expect(result).toBeNull();
  });

  it('should return null when bridge cost exceeds profit', () => {
    const chainPrices: ChainPriceData[] = [
      { chain: 'ethereum', dex: 'uniswap_v3', price: 100, timestamp: Date.now() },
      { chain: 'arbitrum', dex: 'sushiswap', price: 100.5, timestamp: Date.now() }
    ];

    const result = calculateCrossChainArbitrage(chainPrices, 1); // Bridge cost exceeds price diff

    expect(result).toBeNull();
  });

  it('should include confidence based on data freshness', () => {
    const now = Date.now();
    const chainPrices: ChainPriceData[] = [
      { chain: 'ethereum', dex: 'uniswap_v3', price: 100, timestamp: now, pairKey: 'TEST' },
      { chain: 'arbitrum', dex: 'sushiswap', price: 110, timestamp: now, pairKey: 'TEST' }
    ];

    const result = calculateCrossChainArbitrage(chainPrices, 0.1);

    expect(result).not.toBeNull();
    expect(result!.confidence).toBeGreaterThan(0);
    expect(result!.confidence).toBeLessThanOrEqual(0.95);
  });

  it('should find best buy/sell across multiple chains', () => {
    const chainPrices: ChainPriceData[] = [
      { chain: 'ethereum', dex: 'uniswap_v3', price: 102, timestamp: Date.now() },
      { chain: 'arbitrum', dex: 'sushiswap', price: 100, timestamp: Date.now() }, // Lowest
      { chain: 'optimism', dex: 'velodrome', price: 105, timestamp: Date.now() }  // Highest
    ];

    const result = calculateCrossChainArbitrage(chainPrices, 0.1);

    expect(result).not.toBeNull();
    expect(result!.sourceChain).toBe('arbitrum'); // Buy from lowest
    expect(result!.targetChain).toBe('optimism'); // Sell to highest
    expect(result!.priceDiff).toBe(5);
  });
});

// =============================================================================
// Validation Utilities Tests
// =============================================================================

describe('Validation Utilities', () => {
  describe('validatePairSnapshot()', () => {
    it('should validate a correct PairSnapshot', () => {
      const pair = createTestPair();
      expect(validatePairSnapshot(pair)).toBe(true);
    });

    it('should reject null', () => {
      expect(validatePairSnapshot(null)).toBe(false);
    });

    it('should reject undefined', () => {
      expect(validatePairSnapshot(undefined)).toBe(false);
    });

    it('should reject missing address', () => {
      const pair = createTestPair();
      delete (pair as any).address;
      expect(validatePairSnapshot(pair)).toBe(false);
    });

    it('should reject empty address', () => {
      const pair = createTestPair({ address: '' });
      expect(validatePairSnapshot(pair)).toBe(false);
    });

    it('should reject zero reserve0', () => {
      const pair = createTestPair({ reserve0: '0' });
      expect(validatePairSnapshot(pair)).toBe(false);
    });

    it('should reject zero reserve1', () => {
      const pair = createTestPair({ reserve1: '0' });
      expect(validatePairSnapshot(pair)).toBe(false);
    });

    it('should reject negative fee', () => {
      const pair = createTestPair({ fee: -0.001 });
      expect(validatePairSnapshot(pair)).toBe(false);
    });

    it('should reject NaN fee', () => {
      const pair = createTestPair({ fee: NaN });
      expect(validatePairSnapshot(pair)).toBe(false);
    });

    it('should reject negative blockNumber', () => {
      const pair = createTestPair({ blockNumber: -1 });
      expect(validatePairSnapshot(pair)).toBe(false);
    });
  });

  describe('createPairSnapshot()', () => {
    it('should create valid PairSnapshot from extended pair', () => {
      const result = createPairSnapshot({
        address: '0x123',
        dex: 'uniswap_v3',
        token0: '0xA',
        token1: '0xB',
        reserve0: '1000',
        reserve1: '2000'
      });

      expect(result).not.toBeNull();
      expect(result!.address).toBe('0x123');
      expect(result!.fee).toBe(0.003); // Default fee
      expect(result!.blockNumber).toBe(0); // Default block
    });

    it('should return null for missing reserves', () => {
      const result = createPairSnapshot({
        address: '0x123',
        dex: 'uniswap_v3',
        token0: '0xA',
        token1: '0xB'
      });

      expect(result).toBeNull();
    });

    it('should return null for zero reserve0', () => {
      const result = createPairSnapshot({
        address: '0x123',
        dex: 'uniswap_v3',
        token0: '0xA',
        token1: '0xB',
        reserve0: '0',
        reserve1: '1000'
      });

      expect(result).toBeNull();
    });

    it('should preserve provided fee and blockNumber', () => {
      const result = createPairSnapshot({
        address: '0x123',
        dex: 'uniswap_v3',
        token0: '0xA',
        token1: '0xB',
        reserve0: '1000',
        reserve1: '2000',
        fee: 0.001,
        blockNumber: 12345
      });

      expect(result).not.toBeNull();
      expect(result!.fee).toBe(0.001);
      expect(result!.blockNumber).toBe(12345);
    });
  });
});
