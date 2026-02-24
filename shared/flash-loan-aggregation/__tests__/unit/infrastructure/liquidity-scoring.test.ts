/**
 * Liquidity Scoring Tests
 *
 * Boundary value tests for calculateLiquidityScore().
 * Verifies all 4 scoring tiers and edge cases.
 *
 * Scoring tiers:
 * - available >= 2x requiredWithMargin  -> 1.0
 * - available >= requiredWithMargin      -> 0.9
 * - available >= rawRequired             -> 0.7
 * - available < rawRequired              -> 0.3
 */

import { describe, it, expect } from '@jest/globals';
import {
  calculateLiquidityScore,
  DEFAULT_LIQUIDITY_SCORE,
} from '../../../src/infrastructure/liquidity-scoring';

describe('calculateLiquidityScore', () => {
  // Use concrete values: rawRequired = 1000, requiredWithMargin = 1100 (10% margin)
  const rawRequired = 1000n;
  const requiredWithMargin = 1100n;

  describe('tier 1: score 1.0 (available >= 2x requiredWithMargin)', () => {
    it('should return 1.0 when available is exactly 2x requiredWithMargin', () => {
      const available = requiredWithMargin * 2n; // 2200
      expect(calculateLiquidityScore(available, requiredWithMargin, rawRequired)).toBe(1.0);
    });

    it('should return 1.0 when available is well above 2x', () => {
      const available = requiredWithMargin * 10n;
      expect(calculateLiquidityScore(available, requiredWithMargin, rawRequired)).toBe(1.0);
    });
  });

  describe('tier 2: score 0.9 (available >= requiredWithMargin but < 2x)', () => {
    it('should return 0.9 when available is exactly requiredWithMargin', () => {
      expect(calculateLiquidityScore(requiredWithMargin, requiredWithMargin, rawRequired)).toBe(0.9);
    });

    it('should return 0.9 when available is just below 2x requiredWithMargin', () => {
      const available = requiredWithMargin * 2n - 1n; // 2199
      expect(calculateLiquidityScore(available, requiredWithMargin, rawRequired)).toBe(0.9);
    });

    it('should return 0.9 when available is between 1x and 2x requiredWithMargin', () => {
      const available = requiredWithMargin + (requiredWithMargin / 2n); // 1650
      expect(calculateLiquidityScore(available, requiredWithMargin, rawRequired)).toBe(0.9);
    });
  });

  describe('tier 3: score 0.7 (available >= rawRequired but < requiredWithMargin)', () => {
    it('should return 0.7 when available is exactly rawRequired', () => {
      expect(calculateLiquidityScore(rawRequired, requiredWithMargin, rawRequired)).toBe(0.7);
    });

    it('should return 0.7 when available is just below requiredWithMargin', () => {
      const available = requiredWithMargin - 1n; // 1099
      expect(calculateLiquidityScore(available, requiredWithMargin, rawRequired)).toBe(0.7);
    });

    it('should return 0.7 when available is between rawRequired and requiredWithMargin', () => {
      const available = rawRequired + 50n; // 1050
      expect(calculateLiquidityScore(available, requiredWithMargin, rawRequired)).toBe(0.7);
    });
  });

  describe('tier 4: score 0.3 (available < rawRequired)', () => {
    it('should return 0.3 when available is just below rawRequired', () => {
      const available = rawRequired - 1n; // 999
      expect(calculateLiquidityScore(available, requiredWithMargin, rawRequired)).toBe(0.3);
    });

    it('should return 0.3 when available is zero', () => {
      expect(calculateLiquidityScore(0n, requiredWithMargin, rawRequired)).toBe(0.3);
    });

    it('should return 0.3 when available is very small', () => {
      expect(calculateLiquidityScore(1n, requiredWithMargin, rawRequired)).toBe(0.3);
    });
  });

  describe('edge cases', () => {
    it('should handle zero required amounts', () => {
      // 0 >= 0 * 2 is true, so score = 1.0
      expect(calculateLiquidityScore(0n, 0n, 0n)).toBe(1.0);
    });

    it('should handle very large amounts', () => {
      const large = 10n ** 30n; // 1e30 wei
      const largeMargin = large + large / 10n;
      expect(calculateLiquidityScore(large * 3n, largeMargin, large)).toBe(1.0);
    });

    it('should handle equal rawRequired and requiredWithMargin', () => {
      // When margin is 0, tier 2 and tier 3 collapse
      const amount = 1000n;
      // available = amount -> >= requiredWithMargin -> 0.9
      expect(calculateLiquidityScore(amount, amount, amount)).toBe(0.9);
      // available < amount -> < rawRequired -> 0.3
      expect(calculateLiquidityScore(amount - 1n, amount, amount)).toBe(0.3);
    });
  });

  describe('DEFAULT_LIQUIDITY_SCORE', () => {
    it('should be 0.7', () => {
      expect(DEFAULT_LIQUIDITY_SCORE).toBe(0.7);
    });
  });
});
