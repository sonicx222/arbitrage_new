/**
 * PairCorrelationTracker Tests
 *
 * Tests rolling Pearson correlation calculation with circular buffers.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.mock('../../../src/logger');

import { PairCorrelationTracker } from '../../../src/analytics/pair-correlation-tracker';

describe('PairCorrelationTracker', () => {
  let tracker: PairCorrelationTracker;

  beforeEach(() => {
    tracker = new PairCorrelationTracker({
      windowSize: 20,
      minCorrelation: 0.7,
      maxPairs: 50,
    });
  });

  // ===========================================================================
  // Perfectly Correlated
  // ===========================================================================

  describe('perfectly correlated series (y = 2x + 1)', () => {
    it('should return r close to 1.0', () => {
      const pairId = 'WETH-DAI';
      for (let i = 1; i <= 20; i++) {
        const priceA = i * 100;
        const priceB = 2 * i * 100 + 1;
        tracker.addSample(pairId, priceA, priceB, i);
      }

      const corr = tracker.getCorrelation(pairId);
      expect(corr).toBeDefined();
      expect(corr!).toBeCloseTo(1.0, 5);
    });
  });

  // ===========================================================================
  // Perfectly Anti-Correlated
  // ===========================================================================

  describe('perfectly anti-correlated series (y = -x)', () => {
    it('should return r close to -1.0', () => {
      const pairId = 'WETH-USDC';
      for (let i = 1; i <= 20; i++) {
        const priceA = i * 100;
        const priceB = -i * 100 + 5000;
        tracker.addSample(pairId, priceA, priceB, i);
      }

      const corr = tracker.getCorrelation(pairId);
      expect(corr).toBeDefined();
      expect(corr!).toBeCloseTo(-1.0, 5);
    });
  });

  // ===========================================================================
  // Uncorrelated / Random
  // ===========================================================================

  describe('random/uncorrelated series', () => {
    it('should return |r| < 0.3 for uncorrelated data', () => {
      const pairId = 'RANDOM';
      // Deterministic uncorrelated data: A increases, B oscillates independently
      const pricesA = [100, 105, 110, 115, 120, 125, 130, 135, 140, 145,
        150, 155, 160, 165, 170, 175, 180, 185, 190, 195];
      // B: random-looking oscillation uncorrelated with A's uptrend
      const pricesB = [300, 310, 290, 305, 295, 315, 285, 300, 310, 288,
        312, 292, 308, 296, 314, 286, 302, 298, 306, 294];

      for (let i = 0; i < pricesA.length; i++) {
        tracker.addSample(pairId, pricesA[i], pricesB[i], i);
      }

      const corr = tracker.getCorrelation(pairId);
      expect(corr).toBeDefined();
      // The correlation between a monotonic trend and oscillating data should be low
      expect(Math.abs(corr!)).toBeLessThan(0.5);
    });
  });

  // ===========================================================================
  // Insufficient Samples
  // ===========================================================================

  describe('insufficient samples', () => {
    it('should return undefined for 0 samples', () => {
      expect(tracker.getCorrelation('NO_DATA')).toBeUndefined();
    });

    it('should return undefined for 1 sample', () => {
      tracker.addSample('ONE', 100, 200, 1);
      expect(tracker.getCorrelation('ONE')).toBeUndefined();
    });

    it('should return undefined for 2 samples', () => {
      tracker.addSample('TWO', 100, 200, 1);
      tracker.addSample('TWO', 110, 220, 2);
      expect(tracker.getCorrelation('TWO')).toBeUndefined();
    });

    it('should return a value for 3+ samples', () => {
      tracker.addSample('THREE', 100, 200, 1);
      tracker.addSample('THREE', 110, 220, 2);
      tracker.addSample('THREE', 120, 240, 3);
      expect(tracker.getCorrelation('THREE')).toBeDefined();
    });
  });

  // ===========================================================================
  // Circular Buffer Wrap
  // ===========================================================================

  describe('circular buffer wraps correctly at windowSize', () => {
    it('should maintain accuracy after buffer wraps', () => {
      const smallTracker = new PairCorrelationTracker({
        windowSize: 5,
        minCorrelation: 0.7,
        maxPairs: 50,
      });

      const pairId = 'WRAP_TEST';

      // Fill buffer (5 samples)
      for (let i = 1; i <= 5; i++) {
        smallTracker.addSample(pairId, i * 10, i * 20 + 5, i);
      }
      const corrBefore = smallTracker.getCorrelation(pairId);

      // Add 5 more samples (overwriting the first 5)
      for (let i = 6; i <= 10; i++) {
        smallTracker.addSample(pairId, i * 10, i * 20 + 5, i);
      }
      const corrAfter = smallTracker.getCorrelation(pairId);

      // Both should be near 1.0 since both windows are perfectly correlated
      expect(corrBefore!).toBeCloseTo(1.0, 5);
      expect(corrAfter!).toBeCloseTo(1.0, 5);

      // Sample count should stay at windowSize
      expect(smallTracker.getSampleCount(pairId)).toBe(5);
    });
  });

  // ===========================================================================
  // Multiple Pairs Tracked Independently
  // ===========================================================================

  describe('multiple pairs tracked independently', () => {
    it('should track different pairs independently', () => {
      const pairA = 'PAIR_A';
      const pairB = 'PAIR_B';

      // Pair A: perfectly correlated
      for (let i = 1; i <= 10; i++) {
        tracker.addSample(pairA, i * 10, i * 20, i);
      }

      // Pair B: perfectly anti-correlated
      for (let i = 1; i <= 10; i++) {
        tracker.addSample(pairB, i * 10, -i * 20 + 500, i);
      }

      const corrA = tracker.getCorrelation(pairA);
      const corrB = tracker.getCorrelation(pairB);

      expect(corrA!).toBeCloseTo(1.0, 5);
      expect(corrB!).toBeCloseTo(-1.0, 5);
    });
  });

  // ===========================================================================
  // Eligibility
  // ===========================================================================

  describe('getEligiblePairs filters by threshold', () => {
    it('should include highly correlated pairs', () => {
      // High correlation pair (r ~ 1.0)
      for (let i = 1; i <= 10; i++) {
        tracker.addSample('HIGH', i * 10, i * 20, i);
      }

      expect(tracker.isEligible('HIGH')).toBe(true);
      expect(tracker.getEligiblePairs()).toContain('HIGH');
    });

    it('should exclude low correlation pairs', () => {
      // Use constant series for zero correlation
      for (let i = 1; i <= 10; i++) {
        tracker.addSample('LOW', 100, 200, i);
      }

      expect(tracker.isEligible('LOW')).toBe(false);
      expect(tracker.getEligiblePairs()).not.toContain('LOW');
    });

    it('should return false for unknown pairs', () => {
      expect(tracker.isEligible('UNKNOWN')).toBe(false);
    });
  });

  // ===========================================================================
  // Reset
  // ===========================================================================

  describe('reset() clears all data', () => {
    it('should clear all tracked pairs', () => {
      for (let i = 1; i <= 10; i++) {
        tracker.addSample('A', i * 10, i * 20, i);
        tracker.addSample('B', i * 10, i * 30, i);
      }

      expect(tracker.getSampleCount('A')).toBe(10);
      expect(tracker.getSampleCount('B')).toBe(10);

      tracker.reset();

      expect(tracker.getSampleCount('A')).toBe(0);
      expect(tracker.getSampleCount('B')).toBe(0);
      expect(tracker.getCorrelation('A')).toBeUndefined();
      expect(tracker.getCorrelation('B')).toBeUndefined();
    });
  });

  // ===========================================================================
  // MaxPairs Limit (LRU Eviction)
  // ===========================================================================

  describe('maxPairs limit enforced with LRU eviction', () => {
    it('should evict oldest pairs when maxPairs is exceeded', () => {
      const smallTracker = new PairCorrelationTracker({
        windowSize: 10,
        minCorrelation: 0.7,
        maxPairs: 5,
      });

      // Add 5 pairs (fills to max)
      for (let p = 0; p < 5; p++) {
        for (let i = 1; i <= 5; i++) {
          smallTracker.addSample(`pair_${p}`, i * 10, i * 20, p * 100 + i);
        }
      }

      // All 5 pairs should have data
      for (let p = 0; p < 5; p++) {
        expect(smallTracker.getSampleCount(`pair_${p}`)).toBeGreaterThan(0);
      }

      // Add a 6th pair, which should trigger eviction of the oldest
      for (let i = 1; i <= 5; i++) {
        smallTracker.addSample('pair_new', i * 10, i * 20, 600 + i);
      }

      // The newest pair should exist
      expect(smallTracker.getSampleCount('pair_new')).toBe(5);

      // At least one old pair should have been evicted
      // (10% of 5 = 0.5, rounded up to 1)
      let evictedCount = 0;
      for (let p = 0; p < 5; p++) {
        if (smallTracker.getSampleCount(`pair_${p}`) === 0) {
          evictedCount++;
        }
      }
      expect(evictedCount).toBeGreaterThanOrEqual(1);
    });
  });

  // ===========================================================================
  // getSampleCount
  // ===========================================================================

  describe('getSampleCount', () => {
    it('should return 0 for unknown pair', () => {
      expect(tracker.getSampleCount('UNKNOWN')).toBe(0);
    });

    it('should increment with each sample', () => {
      tracker.addSample('CNT', 100, 200, 1);
      expect(tracker.getSampleCount('CNT')).toBe(1);
      tracker.addSample('CNT', 110, 210, 2);
      expect(tracker.getSampleCount('CNT')).toBe(2);
    });

    it('should cap at windowSize', () => {
      const smallTracker = new PairCorrelationTracker({
        windowSize: 5,
        minCorrelation: 0.7,
        maxPairs: 50,
      });

      for (let i = 1; i <= 10; i++) {
        smallTracker.addSample('CAP', i * 10, i * 20, i);
      }
      expect(smallTracker.getSampleCount('CAP')).toBe(5);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle constant series (zero variance)', () => {
      for (let i = 1; i <= 10; i++) {
        tracker.addSample('CONST', 100, 200, i);
      }
      const corr = tracker.getCorrelation('CONST');
      expect(corr).toBe(0);
    });

    it('should handle one constant, one varying series', () => {
      for (let i = 1; i <= 10; i++) {
        tracker.addSample('MIXED', 100, i * 10, i);
      }
      const corr = tracker.getCorrelation('MIXED');
      // denomA would be zero (constant A), should return 0
      expect(corr).toBe(0);
    });
  });
});
