/**
 * Feature Math Tests
 *
 * FIX 8.1: Add missing test coverage for feature-math.ts
 */

import { describe, it, expect } from '@jest/globals';
import {
  calculateSMA,
  calculateMean,
  calculateVariance,
  calculateStdDev,
  calculateVolatility,
  calculateMomentum,
  calculateMomentumPercent,
  calculateTrend,
  calculateTrendStrength,
  calculateReturns,
  calculateLogReturns,
  calculateVolumeFeatures,
  calculateVolumeChanges,
  normalize,
  normalizeSymmetric,
  normalizeSequence,
  cosineSimilarity,
  cosineSimilarityNormalized,
  trendSimilarity,
  safeDivide,
  clamp,
  isFiniteNumber,
  finiteOrDefault
} from '../../src/feature-math';

describe('feature-math', () => {
  describe('Statistical Functions', () => {
    describe('calculateSMA', () => {
      it('should calculate simple moving average', () => {
        expect(calculateSMA([1, 2, 3, 4, 5])).toBe(3);
        expect(calculateSMA([10, 20, 30])).toBe(20);
      });

      it('should return 0 for empty array', () => {
        expect(calculateSMA([])).toBe(0);
      });

      it('should handle single element', () => {
        expect(calculateSMA([42])).toBe(42);
      });
    });

    describe('calculateMean', () => {
      it('should be alias for calculateSMA', () => {
        const values = [1, 2, 3, 4, 5];
        expect(calculateMean(values)).toBe(calculateSMA(values));
      });
    });

    describe('calculateVariance', () => {
      it('should calculate variance', () => {
        const variance = calculateVariance([2, 4, 4, 4, 5, 5, 7, 9]);
        expect(variance).toBeCloseTo(4, 5);
      });

      it('should return 0 for less than 2 elements', () => {
        expect(calculateVariance([])).toBe(0);
        expect(calculateVariance([1])).toBe(0);
      });
    });

    describe('calculateStdDev', () => {
      it('should calculate standard deviation', () => {
        const stdDev = calculateStdDev([2, 4, 4, 4, 5, 5, 7, 9]);
        expect(stdDev).toBeCloseTo(2, 5);
      });

      it('should return 0 for less than 2 elements', () => {
        expect(calculateStdDev([])).toBe(0);
        expect(calculateStdDev([1])).toBe(0);
      });
    });

    describe('calculateVolatility', () => {
      it('should calculate volatility from log returns', () => {
        const prices = [100, 102, 101, 103, 105];
        const vol = calculateVolatility(prices);
        expect(vol).toBeGreaterThan(0);
        expect(Number.isFinite(vol)).toBe(true);
      });

      it('should return 0 for less than 2 prices', () => {
        expect(calculateVolatility([])).toBe(0);
        expect(calculateVolatility([100])).toBe(0);
      });

      it('should return 0 for invalid prices', () => {
        expect(calculateVolatility([0, 100])).toBe(0);
        expect(calculateVolatility([-1, 100])).toBe(0);
      });
    });

    describe('calculateMomentum', () => {
      it('should calculate price momentum', () => {
        expect(calculateMomentum([100, 105, 110])).toBe(10);
        expect(calculateMomentum([100, 95, 90])).toBe(-10);
      });

      it('should return 0 for less than 2 prices', () => {
        expect(calculateMomentum([])).toBe(0);
        expect(calculateMomentum([100])).toBe(0);
      });
    });

    describe('calculateMomentumPercent', () => {
      it('should calculate percentage momentum', () => {
        expect(calculateMomentumPercent([100, 110])).toBeCloseTo(0.1, 5);
        expect(calculateMomentumPercent([100, 90])).toBeCloseTo(-0.1, 5);
      });

      it('should return 0 for zero start price', () => {
        expect(calculateMomentumPercent([0, 100])).toBe(0);
      });
    });
  });

  describe('Trend Analysis', () => {
    describe('calculateTrend', () => {
      it('should calculate positive trend', () => {
        const trend = calculateTrend([1, 2, 3, 4, 5]);
        expect(trend).toBeCloseTo(1, 5);
      });

      it('should calculate negative trend', () => {
        const trend = calculateTrend([5, 4, 3, 2, 1]);
        expect(trend).toBeCloseTo(-1, 5);
      });

      it('should return 0 for flat data', () => {
        const trend = calculateTrend([5, 5, 5, 5, 5]);
        expect(trend).toBeCloseTo(0, 5);
      });

      it('should return 0 for less than 2 values', () => {
        expect(calculateTrend([])).toBe(0);
        expect(calculateTrend([1])).toBe(0);
      });
    });

    describe('calculateTrendStrength', () => {
      it('should return ~1 for perfect linear trend', () => {
        const strength = calculateTrendStrength([1, 2, 3, 4, 5]);
        expect(strength).toBeCloseTo(1, 5);
      });

      it('should return low value for noisy data', () => {
        const strength = calculateTrendStrength([1, 5, 2, 4, 3]);
        expect(strength).toBeLessThan(0.5);
      });

      it('should return 0 for less than 2 values', () => {
        expect(calculateTrendStrength([])).toBe(0);
        expect(calculateTrendStrength([1])).toBe(0);
      });
    });
  });

  describe('Return Calculations', () => {
    describe('calculateReturns', () => {
      it('should calculate simple returns', () => {
        const returns = calculateReturns([100, 110, 99]);
        expect(returns[0]).toBeCloseTo(0.1, 5);
        expect(returns[1]).toBeCloseTo(-0.1, 5);
      });

      it('should handle zero prices', () => {
        const returns = calculateReturns([0, 100]);
        expect(returns[0]).toBe(0);
      });
    });

    describe('calculateLogReturns', () => {
      it('should calculate log returns', () => {
        const returns = calculateLogReturns([100, 110]);
        expect(returns[0]).toBeCloseTo(Math.log(1.1), 5);
      });

      it('should handle invalid prices', () => {
        const returns = calculateLogReturns([0, 100]);
        expect(returns[0]).toBe(0);
      });
    });
  });

  describe('Volume Analysis', () => {
    describe('calculateVolumeFeatures', () => {
      it('should return mean and ratio', () => {
        const [mean, ratio] = calculateVolumeFeatures([100, 100, 200]);
        expect(mean).toBeCloseTo(133.33, 1);
        expect(ratio).toBeCloseTo(1.5, 2);
      });

      it('should return defaults for empty array', () => {
        const [mean, ratio] = calculateVolumeFeatures([]);
        expect(mean).toBe(0);
        expect(ratio).toBe(1);
      });

      it('should handle zero mean', () => {
        const [mean, ratio] = calculateVolumeFeatures([0, 0, 0]);
        expect(mean).toBe(0);
        expect(ratio).toBe(1);
      });
    });

    describe('calculateVolumeChanges', () => {
      it('should calculate volume changes', () => {
        const changes = calculateVolumeChanges([100, 150, 120]);
        expect(changes[0]).toBeCloseTo(0.5, 5);
        expect(changes[1]).toBeCloseTo(-0.2, 5);
      });
    });
  });

  describe('Normalization Functions', () => {
    describe('normalize', () => {
      it('should normalize to 0-1 range', () => {
        expect(normalize(50, 0, 100)).toBe(0.5);
        expect(normalize(0, 0, 100)).toBe(0);
        expect(normalize(100, 0, 100)).toBe(1);
      });

      it('should clamp out-of-range values', () => {
        expect(normalize(-10, 0, 100)).toBe(0);
        expect(normalize(110, 0, 100)).toBe(1);
      });

      it('should return 0.5 for equal min/max', () => {
        expect(normalize(50, 50, 50)).toBe(0.5);
      });
    });

    describe('normalizeSymmetric', () => {
      it('should normalize symmetric range to 0-1', () => {
        expect(normalizeSymmetric(0)).toBe(0.5);
        expect(normalizeSymmetric(1)).toBe(1);
        expect(normalizeSymmetric(-1)).toBe(0);
      });

      it('should handle custom range', () => {
        expect(normalizeSymmetric(0, 2)).toBe(0.5);
        expect(normalizeSymmetric(2, 2)).toBe(1);
      });
    });

    describe('normalizeSequence', () => {
      it('should normalize sequence to 0-1 range', () => {
        const normalized = normalizeSequence([0, 50, 100]);
        expect(normalized[0]).toBe(0);
        expect(normalized[1]).toBe(0.5);
        expect(normalized[2]).toBe(1);
      });

      it('should return 0.5 for constant sequence', () => {
        const normalized = normalizeSequence([5, 5, 5]);
        expect(normalized).toEqual([0.5, 0.5, 0.5]);
      });

      it('should return empty array for empty input', () => {
        expect(normalizeSequence([])).toEqual([]);
      });
    });
  });

  describe('Similarity Functions', () => {
    describe('cosineSimilarity', () => {
      it('should return 1 for identical vectors', () => {
        expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 5);
      });

      it('should return -1 for opposite vectors', () => {
        expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
      });

      it('should return 0 for orthogonal vectors', () => {
        expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
      });

      it('should return 0 for different length vectors', () => {
        expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
      });

      it('should return 0 for empty vectors', () => {
        expect(cosineSimilarity([], [])).toBe(0);
      });
    });

    describe('cosineSimilarityNormalized', () => {
      it('should return 0.5-1 range for similar vectors', () => {
        const sim = cosineSimilarityNormalized([1, 2, 3], [1, 2, 3]);
        expect(sim).toBeCloseTo(1, 5);
      });

      it('should return 0-0.5 range for opposite vectors', () => {
        const sim = cosineSimilarityNormalized([1, 0], [-1, 0]);
        expect(sim).toBeCloseTo(0, 5);
      });
    });

    describe('trendSimilarity', () => {
      it('should return 1 for matching trends', () => {
        expect(trendSimilarity([1, 1, 1], [2, 2, 2])).toBe(1);
        expect(trendSimilarity([-1, -1], [-2, -2])).toBe(1);
      });

      it('should return 0 for opposite trends', () => {
        expect(trendSimilarity([1, 1], [-1, -1])).toBe(0);
      });

      it('should return 0 for different lengths', () => {
        expect(trendSimilarity([1, 2], [1, 2, 3])).toBe(0);
      });
    });
  });

  describe('Safe Math Operations', () => {
    describe('safeDivide', () => {
      it('should perform normal division', () => {
        expect(safeDivide(10, 2)).toBe(5);
      });

      it('should return default for division by zero', () => {
        expect(safeDivide(10, 0)).toBe(0);
        expect(safeDivide(10, 0, -1)).toBe(-1);
      });

      it('should handle Infinity denominator', () => {
        expect(safeDivide(10, Infinity)).toBe(0);
      });
    });

    describe('clamp', () => {
      it('should clamp values to range', () => {
        expect(clamp(5, 0, 10)).toBe(5);
        expect(clamp(-5, 0, 10)).toBe(0);
        expect(clamp(15, 0, 10)).toBe(10);
      });
    });

    describe('isFiniteNumber', () => {
      it('should return true for finite numbers', () => {
        expect(isFiniteNumber(0)).toBe(true);
        expect(isFiniteNumber(42)).toBe(true);
        expect(isFiniteNumber(-1.5)).toBe(true);
      });

      it('should return false for non-finite values', () => {
        expect(isFiniteNumber(NaN)).toBe(false);
        expect(isFiniteNumber(Infinity)).toBe(false);
        expect(isFiniteNumber(-Infinity)).toBe(false);
      });
    });

    describe('finiteOrDefault', () => {
      it('should return value if finite', () => {
        expect(finiteOrDefault(42, 0)).toBe(42);
      });

      it('should return default if not finite', () => {
        expect(finiteOrDefault(NaN, 0)).toBe(0);
        expect(finiteOrDefault(Infinity, -1)).toBe(-1);
      });
    });
  });
});
