/**
 * Tests for V3 Price Utilities
 *
 * Validates sqrtPriceX96 → price and virtual reserve calculations
 * used by the V3 Swap event handler in the detection pipeline.
 */

import {
  calculatePriceFromSqrtPriceX96,
  calculateVirtualReservesFromSqrtPriceX96,
} from '../../../src/utils/v3-price-utils';

describe('V3 Price Utilities', () => {
  describe('calculatePriceFromSqrtPriceX96', () => {
    it('should compute correct price for ETH/USDC at ~$2000', () => {
      // sqrtPriceX96 for ETH/USDC at $2000:
      // price = token1/token0 = USDC/ETH = 2000 (in decimal-adjusted terms)
      // ETH has 18 decimals, USDC has 6 decimals
      // Raw price (token1_raw / token0_raw) = 2000 * 10^6 / 10^18 = 2000 * 10^-12
      // sqrtPriceX96 = sqrt(raw_price) * 2^96 = sqrt(2000 * 10^-12) * 2^96
      // ≈ 1.4142135e-6 * 2^96 ≈ 3.5435731e+22
      const sqrtPriceX96 = 3543573148810890644897792n; // ~$2000 ETH/USDC

      const price = calculatePriceFromSqrtPriceX96(sqrtPriceX96, 18, 6);
      expect(price).not.toBeNull();
      // Should be approximately 2000 (allow 5% tolerance for fixed-point rounding)
      expect(price!).toBeGreaterThan(1900);
      expect(price!).toBeLessThan(2100);
    });

    it('should compute correct price for same-decimal token pair', () => {
      // For tokens with equal decimals (e.g., WETH/DAI both 18 decimals),
      // price = (sqrtPriceX96 / 2^96)^2
      // At 1:1 price ratio: sqrtPriceX96 = 2^96
      const Q96 = 1n << 96n;

      const price = calculatePriceFromSqrtPriceX96(Q96, 18, 18);
      expect(price).not.toBeNull();
      expect(price!).toBeCloseTo(1.0, 6);
    });

    it('should compute correct price for 2:1 ratio same-decimal pair', () => {
      // price = 2.0 → sqrtPrice = sqrt(2) ≈ 1.4142135
      // sqrtPriceX96 = 1.4142135 * 2^96
      const Q96 = 1n << 96n;
      // sqrt(2) * 2^96 ≈ 1.4142135623730951 * 79228162514264337593543950336
      const sqrtPriceX96 = 112045541949572279837463876454n; // sqrt(2) * 2^96

      const price = calculatePriceFromSqrtPriceX96(sqrtPriceX96, 18, 18);
      expect(price).not.toBeNull();
      expect(price!).toBeCloseTo(2.0, 2);
    });

    it('should return null for zero sqrtPriceX96', () => {
      const price = calculatePriceFromSqrtPriceX96(0n, 18, 18);
      expect(price).toBeNull();
    });

    it('should return null for negative sqrtPriceX96', () => {
      const price = calculatePriceFromSqrtPriceX96(-1n, 18, 18);
      expect(price).toBeNull();
    });

    it('should handle extreme high price', () => {
      // Very large sqrtPriceX96 (price of ~1e12)
      const Q96 = 1n << 96n;
      const sqrtPriceX96 = Q96 * 1000000n; // sqrt(1e12) = 1e6

      const price = calculatePriceFromSqrtPriceX96(sqrtPriceX96, 18, 18);
      expect(price).not.toBeNull();
      expect(price!).toBeGreaterThan(0);
    });

    it('should handle very small price', () => {
      // Very small sqrtPriceX96 (price near 0)
      const sqrtPriceX96 = 1n << 48n; // Very small relative to 2^96

      const price = calculatePriceFromSqrtPriceX96(sqrtPriceX96, 18, 18);
      // Could be null or very small — both are acceptable
      if (price !== null) {
        expect(price).toBeGreaterThan(0);
        expect(price).toBeLessThan(1);
      }
    });
  });

  describe('calculateVirtualReservesFromSqrtPriceX96', () => {
    it('should compute virtual reserves at 1:1 price', () => {
      const Q96 = 1n << 96n;
      const sqrtPriceX96 = Q96; // Price = 1.0
      const liquidity = 10n ** 18n; // 1e18 liquidity

      const result = calculateVirtualReservesFromSqrtPriceX96(sqrtPriceX96, liquidity);
      expect(result).not.toBeNull();

      // At price 1:1, reserve0 = L and reserve1 = L
      expect(result!.reserve0).toBe(liquidity);
      expect(result!.reserve1).toBe(liquidity);
    });

    it('should compute asymmetric reserves at 4:1 price', () => {
      const Q96 = 1n << 96n;
      // Price = 4, sqrtPrice = 2
      const sqrtPriceX96 = Q96 * 2n;
      const liquidity = 10n ** 18n;

      const result = calculateVirtualReservesFromSqrtPriceX96(sqrtPriceX96, liquidity);
      expect(result).not.toBeNull();

      // reserve0 = L * Q96 / (2 * Q96) = L / 2
      // reserve1 = L * (2 * Q96) / Q96 = 2L
      expect(result!.reserve0).toBe(liquidity / 2n);
      expect(result!.reserve1).toBe(liquidity * 2n);
    });

    it('should return null for zero liquidity', () => {
      const Q96 = 1n << 96n;
      const result = calculateVirtualReservesFromSqrtPriceX96(Q96, 0n);
      expect(result).toBeNull();
    });

    it('should return null for zero sqrtPriceX96', () => {
      const result = calculateVirtualReservesFromSqrtPriceX96(0n, 10n ** 18n);
      expect(result).toBeNull();
    });

    it('should return null for negative inputs', () => {
      const Q96 = 1n << 96n;
      expect(calculateVirtualReservesFromSqrtPriceX96(-1n, 10n ** 18n)).toBeNull();
      expect(calculateVirtualReservesFromSqrtPriceX96(Q96, -1n)).toBeNull();
    });

    it('should maintain constant product invariant', () => {
      const Q96 = 1n << 96n;
      const sqrtPriceX96 = Q96 * 3n; // Price = 9
      const liquidity = 10n ** 18n;

      const result = calculateVirtualReservesFromSqrtPriceX96(sqrtPriceX96, liquidity);
      expect(result).not.toBeNull();

      // Constant product: reserve0 * reserve1 ≈ L^2
      // (within integer rounding tolerance)
      const product = result!.reserve0 * result!.reserve1;
      const expected = liquidity * liquidity;

      // Allow small rounding error (integer division truncation)
      const diff = product > expected ? product - expected : expected - product;
      const tolerance = expected / 100n; // 1% tolerance
      expect(diff).toBeLessThanOrEqual(tolerance);
    });
  });
});
