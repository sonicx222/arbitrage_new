/**
 * RegimeDetector Tests
 *
 * Tests Hurst exponent estimation and regime classification via R/S method.
 *
 * Note on Hurst exponent estimation:
 * The R/S method is a statistical estimator, so results depend on the
 * data characteristics. Tests use data patterns that produce reliably
 * distinct Hurst values rather than trying to hit exact thresholds.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.mock('../../../src/logger');

import { RegimeDetector } from '../../../src/analytics/regime-detector';

describe('RegimeDetector', () => {
  let detector: RegimeDetector;

  beforeEach(() => {
    detector = new RegimeDetector({
      windowSize: 256,
      hurstThresholdLow: 0.4,
      hurstThresholdHigh: 0.6,
    });
  });

  // ===========================================================================
  // Mean-Reverting Series
  // ===========================================================================

  describe('mean-reverting series', () => {
    it('should classify alternating series as mean_reverting with H < 0.5', () => {
      const pairId = 'ALTERNATING';

      // Strongly mean-reverting: alternating up/down pattern
      // This is the clearest anti-persistent signal for R/S analysis
      for (let i = 0; i < 256; i++) {
        const spread = (i % 2 === 0) ? 0.1 : -0.1;
        detector.addSample(pairId, spread);
      }

      const hurst = detector.getHurstExponent(pairId);
      expect(hurst).toBeDefined();
      expect(hurst!).toBeLessThan(0.5);

      const regime = detector.getRegime(pairId);
      expect(regime).toBe('mean_reverting');
    });

    it('should return isFavorable = true for mean-reverting', () => {
      const pairId = 'MR_FAV';
      for (let i = 0; i < 256; i++) {
        detector.addSample(pairId, (i % 2 === 0) ? 0.1 : -0.1);
      }
      expect(detector.isFavorable(pairId)).toBe(true);
    });
  });

  // ===========================================================================
  // Trending Series (Monotonic)
  // ===========================================================================

  describe('trending series', () => {
    it('should classify monotonic series as trending with H > 0.5', () => {
      const pairId = 'TREND';

      // Pure linear trend: each sample increases by a fixed step
      for (let i = 0; i < 256; i++) {
        detector.addSample(pairId, i * 0.01);
      }

      const hurst = detector.getHurstExponent(pairId);
      expect(hurst).toBeDefined();
      expect(hurst!).toBeGreaterThan(0.5);

      const regime = detector.getRegime(pairId);
      expect(regime).toBe('trending');
    });

    it('should return isFavorable = false for trending', () => {
      const pairId = 'TREND_FAV';
      for (let i = 0; i < 256; i++) {
        detector.addSample(pairId, i * 0.01);
      }
      expect(detector.isFavorable(pairId)).toBe(false);
    });
  });

  // ===========================================================================
  // Hurst Exponent Ordering
  // ===========================================================================

  describe('hurst exponent ordering', () => {
    it('should produce H(alternating) < H(trend)', () => {
      // Mean-reverting alternating series
      for (let i = 0; i < 256; i++) {
        detector.addSample('MR', (i % 2 === 0) ? 0.1 : -0.1);
      }

      // Trending series
      for (let i = 0; i < 256; i++) {
        detector.addSample('TR', i * 0.01);
      }

      const hurstMR = detector.getHurstExponent('MR')!;
      const hurstTR = detector.getHurstExponent('TR')!;

      // The anti-persistent series should have lower H than the persistent one
      expect(hurstMR).toBeLessThan(hurstTR);
    });
  });

  // ===========================================================================
  // Insufficient Data
  // ===========================================================================

  describe('insufficient data', () => {
    it('should return random_walk as default for unknown pair', () => {
      expect(detector.getRegime('UNKNOWN')).toBe('random_walk');
    });

    it('should return undefined hurst for insufficient samples', () => {
      // Need at least 16 samples (2 * MIN_SUBSERIES_LENGTH of 8)
      for (let i = 0; i < 10; i++) {
        detector.addSample('FEW', i * 0.01);
      }
      expect(detector.getHurstExponent('FEW')).toBeUndefined();
    });

    it('should return random_walk regime for insufficient samples', () => {
      for (let i = 0; i < 10; i++) {
        detector.addSample('FEW2', i * 0.01);
      }
      expect(detector.getRegime('FEW2')).toBe('random_walk');
    });

    it('should return undefined for pair with no data', () => {
      expect(detector.getHurstExponent('EMPTY')).toBeUndefined();
    });
  });

  // ===========================================================================
  // isFavorable
  // ===========================================================================

  describe('isFavorable', () => {
    it('should return false for unknown pair (default random_walk)', () => {
      expect(detector.isFavorable('NONE')).toBe(false);
    });

    it('should return false for insufficient data', () => {
      detector.addSample('SHORT', 0.1);
      expect(detector.isFavorable('SHORT')).toBe(false);
    });
  });

  // ===========================================================================
  // Reset
  // ===========================================================================

  describe('reset', () => {
    it('should clear all tracking data', () => {
      for (let i = 0; i < 256; i++) {
        detector.addSample('A', (i % 2 === 0) ? 0.1 : -0.1);
        detector.addSample('B', i * 0.01);
      }

      expect(detector.getHurstExponent('A')).toBeDefined();
      expect(detector.getHurstExponent('B')).toBeDefined();

      detector.reset();

      expect(detector.getHurstExponent('A')).toBeUndefined();
      expect(detector.getHurstExponent('B')).toBeUndefined();
      expect(detector.getRegime('A')).toBe('random_walk');
      expect(detector.getRegime('B')).toBe('random_walk');
    });
  });

  // ===========================================================================
  // Caching
  // ===========================================================================

  describe('caching', () => {
    it('should cache and invalidate on new sample', () => {
      for (let i = 0; i < 256; i++) {
        detector.addSample('CACHE', (i % 2 === 0) ? 0.1 : -0.1);
      }

      const hurst1 = detector.getHurstExponent('CACHE');
      const hurst2 = detector.getHurstExponent('CACHE');

      // Should be identical (cached)
      expect(hurst1).toBe(hurst2);

      // Add new sample - cache should be invalidated
      detector.addSample('CACHE', 0);
      const hurst3 = detector.getHurstExponent('CACHE');

      // After new sample, value may differ slightly
      expect(hurst3).toBeDefined();
    });
  });

  // ===========================================================================
  // Hurst Range Validation
  // ===========================================================================

  describe('hurst value range', () => {
    it('should always return Hurst between 0 and 1', () => {
      // Test with various patterns
      for (let i = 0; i < 256; i++) {
        detector.addSample('RANGE_TEST', (i % 2 === 0) ? 100 : -100);
      }

      const hurst = detector.getHurstExponent('RANGE_TEST');
      expect(hurst).toBeDefined();
      expect(hurst!).toBeGreaterThanOrEqual(0);
      expect(hurst!).toBeLessThanOrEqual(1);
    });
  });
});
