/**
 * Price Momentum Tracker Unit Tests
 *
 * Tests for EMA calculations, momentum signals, z-score detection,
 * trend identification, and LRU eviction.
 *
 * @see shared/core/src/analytics/price-momentum.ts
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  PriceMomentumTracker,
  getPriceMomentumTracker,
  resetPriceMomentumTracker
} from '../../src/analytics/price-momentum';

describe('PriceMomentumTracker', () => {
  let tracker: PriceMomentumTracker;

  beforeEach(() => {
    resetPriceMomentumTracker();
    tracker = new PriceMomentumTracker({
      windowSize: 20,
      emaShortPeriod: 3,
      emaMediumPeriod: 7,
      emaLongPeriod: 15,
      zScoreThreshold: 2.0,
      volumeSpikeThreshold: 2.5,
      maxPairs: 50
    });
  });

  afterEach(() => {
    tracker.resetAll();
  });

  // ===========================================================================
  // addPriceUpdate
  // ===========================================================================

  describe('addPriceUpdate', () => {
    it('should track a new pair after first update', () => {
      tracker.addPriceUpdate('ETH/USDT', 2000, 100);

      expect(tracker.getTrackedPairsCount()).toBe(1);
      expect(tracker.getTrackedPairs()).toContain('ETH/USDT');
    });

    it('should accumulate samples up to windowSize', () => {
      for (let i = 0; i < 10; i++) {
        tracker.addPriceUpdate('ETH/USDT', 2000 + i, 100, Date.now() + i * 1000);
      }

      const stats = tracker.getStats('ETH/USDT');
      expect(stats).not.toBeNull();
      expect(stats!.sampleCount).toBe(10);
    });

    it('should not exceed windowSize samples (circular buffer)', () => {
      for (let i = 0; i < 30; i++) {
        tracker.addPriceUpdate('ETH/USDT', 2000 + i, 100, Date.now() + i * 1000);
      }

      const stats = tracker.getStats('ETH/USDT');
      expect(stats!.sampleCount).toBe(20); // windowSize is 20
    });

    it('should update EMA values with each price update', () => {
      tracker.addPriceUpdate('ETH/USDT', 2000, 100);
      const stats1 = tracker.getStats('ETH/USDT');

      tracker.addPriceUpdate('ETH/USDT', 2100, 100);
      const stats2 = tracker.getStats('ETH/USDT');

      // EMAs should move towards the new price
      expect(stats2!.emaShort).toBeGreaterThan(stats1!.emaShort);
      expect(stats2!.emaMedium).toBeGreaterThan(stats1!.emaMedium);
    });

    it('should track multiple pairs independently', () => {
      tracker.addPriceUpdate('ETH/USDT', 2000, 100);
      tracker.addPriceUpdate('BTC/USDT', 40000, 50);

      expect(tracker.getTrackedPairsCount()).toBe(2);
      expect(tracker.getStats('ETH/USDT')!.currentPrice).toBe(2000);
      expect(tracker.getStats('BTC/USDT')!.currentPrice).toBe(40000);
    });
  });

  // ===========================================================================
  // getStats
  // ===========================================================================

  describe('getStats', () => {
    it('should return null for unknown pair', () => {
      expect(tracker.getStats('UNKNOWN/PAIR')).toBeNull();
    });

    it('should return correct current price', () => {
      tracker.addPriceUpdate('ETH/USDT', 2000, 100);
      tracker.addPriceUpdate('ETH/USDT', 2100, 100);

      const stats = tracker.getStats('ETH/USDT');
      expect(stats!.currentPrice).toBe(2100);
    });

    it('should calculate correct average price', () => {
      tracker.addPriceUpdate('ETH/USDT', 2000, 100, 1000);
      tracker.addPriceUpdate('ETH/USDT', 2200, 100, 2000);

      const stats = tracker.getStats('ETH/USDT');
      expect(stats!.averagePrice).toBe(2100);
    });

    it('should calculate correct min and max prices', () => {
      const prices = [2000, 1800, 2200, 1900, 2100];
      prices.forEach((p, i) => {
        tracker.addPriceUpdate('ETH/USDT', p, 100, Date.now() + i * 1000);
      });

      const stats = tracker.getStats('ETH/USDT');
      expect(stats!.minPrice).toBe(1800);
      expect(stats!.maxPrice).toBe(2200);
    });

    it('should calculate standard deviation', () => {
      // Constant prices => zero stddev
      for (let i = 0; i < 5; i++) {
        tracker.addPriceUpdate('STABLE', 100, 50, Date.now() + i * 1000);
      }

      const stats = tracker.getStats('STABLE');
      expect(stats!.priceStdDev).toBe(0);
    });

    it('should calculate nonzero standard deviation for varying prices', () => {
      tracker.addPriceUpdate('ETH/USDT', 100, 50, 1000);
      tracker.addPriceUpdate('ETH/USDT', 200, 50, 2000);

      const stats = tracker.getStats('ETH/USDT');
      expect(stats!.priceStdDev).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // getMomentumSignal
  // ===========================================================================

  describe('getMomentumSignal', () => {
    it('should return null with fewer than 2 samples', () => {
      tracker.addPriceUpdate('ETH/USDT', 2000, 100);
      expect(tracker.getMomentumSignal('ETH/USDT')).toBeNull();
    });

    it('should return null for unknown pair', () => {
      expect(tracker.getMomentumSignal('UNKNOWN')).toBeNull();
    });

    it('should calculate positive velocity for rising prices', () => {
      tracker.addPriceUpdate('ETH/USDT', 2000, 100, 1000);
      tracker.addPriceUpdate('ETH/USDT', 2100, 100, 2000);

      const signal = tracker.getMomentumSignal('ETH/USDT');
      expect(signal).not.toBeNull();
      expect(signal!.velocity).toBeGreaterThan(0);
      expect(signal!.currentPrice).toBe(2100);
    });

    it('should calculate negative velocity for falling prices', () => {
      tracker.addPriceUpdate('ETH/USDT', 2000, 100, 1000);
      tracker.addPriceUpdate('ETH/USDT', 1900, 100, 2000);

      const signal = tracker.getMomentumSignal('ETH/USDT');
      expect(signal!.velocity).toBeLessThan(0);
    });

    it('should calculate acceleration with 3+ samples', () => {
      tracker.addPriceUpdate('ETH/USDT', 2000, 100, 1000);
      tracker.addPriceUpdate('ETH/USDT', 2100, 100, 2000);
      tracker.addPriceUpdate('ETH/USDT', 2300, 100, 3000); // Accelerating

      const signal = tracker.getMomentumSignal('ETH/USDT');
      expect(signal!.acceleration).toBeGreaterThan(0);
    });

    it('should detect mean reversion signal when z-score exceeds threshold', () => {
      // Add baseline prices around 2000
      for (let i = 0; i < 15; i++) {
        tracker.addPriceUpdate('ETH/USDT', 2000 + (Math.random() - 0.5) * 10, 100, Date.now() + i * 1000);
      }
      // Spike the price far from mean
      tracker.addPriceUpdate('ETH/USDT', 2500, 100, Date.now() + 20000);

      const signal = tracker.getMomentumSignal('ETH/USDT');
      expect(signal!.meanReversionSignal).toBe(true);
      expect(Math.abs(signal!.zScore)).toBeGreaterThan(2.0);
    });

    it('should detect volume spike', () => {
      // Add baseline with low volume
      for (let i = 0; i < 10; i++) {
        tracker.addPriceUpdate('ETH/USDT', 2000, 100, Date.now() + i * 1000);
      }
      // Add high volume update (3x = above 2.5x threshold)
      tracker.addPriceUpdate('ETH/USDT', 2010, 300, Date.now() + 15000);

      const signal = tracker.getMomentumSignal('ETH/USDT');
      expect(signal!.volumeSpike).toBe(true);
      expect(signal!.volumeRatio).toBeGreaterThan(2.5);
    });

    it('should detect bullish trend when price above all EMAs', () => {
      // Steadily rising prices to push all EMAs below current
      for (let i = 0; i < 20; i++) {
        tracker.addPriceUpdate('ETH/USDT', 2000 + i * 50, 100, Date.now() + i * 1000);
      }

      const signal = tracker.getMomentumSignal('ETH/USDT');
      expect(signal!.trend).toBe('bullish');
    });

    it('should detect bearish trend when price below all EMAs', () => {
      // Steadily falling prices to push all EMAs above current
      for (let i = 0; i < 20; i++) {
        tracker.addPriceUpdate('ETH/USDT', 3000 - i * 50, 100, Date.now() + i * 1000);
      }

      const signal = tracker.getMomentumSignal('ETH/USDT');
      expect(signal!.trend).toBe('bearish');
    });

    it('should handle zero previous price without division error', () => {
      tracker.addPriceUpdate('ETH/USDT', 0, 100, 1000);
      tracker.addPriceUpdate('ETH/USDT', 100, 100, 2000);

      const signal = tracker.getMomentumSignal('ETH/USDT');
      expect(signal).not.toBeNull();
      // velocity should be 0 since previous price was 0 (guarded)
      expect(signal!.velocity).toBe(0);
    });

    it('should include EMA values in signal', () => {
      for (let i = 0; i < 5; i++) {
        tracker.addPriceUpdate('ETH/USDT', 2000 + i * 10, 100, Date.now() + i * 1000);
      }

      const signal = tracker.getMomentumSignal('ETH/USDT');
      expect(signal!.emaShort).toBeGreaterThan(0);
      expect(signal!.emaMedium).toBeGreaterThan(0);
      expect(signal!.emaLong).toBeGreaterThan(0);
    });

    it('should have confidence between 0 and 1', () => {
      for (let i = 0; i < 10; i++) {
        tracker.addPriceUpdate('ETH/USDT', 2000 + i * 10, 100, Date.now() + i * 1000);
      }

      const signal = tracker.getMomentumSignal('ETH/USDT');
      expect(signal!.confidence).toBeGreaterThanOrEqual(0);
      expect(signal!.confidence).toBeLessThanOrEqual(1);
    });
  });

  // ===========================================================================
  // Confidence calculation
  // ===========================================================================

  describe('confidence calculation', () => {
    it('should penalize confidence with few samples', () => {
      tracker.addPriceUpdate('ETH/USDT', 2000, 100, 1000);
      tracker.addPriceUpdate('ETH/USDT', 2100, 100, 2000);

      const signal = tracker.getMomentumSignal('ETH/USDT');
      // With only 2 samples (< 5), confidence gets multiplied by 0.5
      expect(signal!.confidence).toBeLessThanOrEqual(0.5);
    });

    it('should increase confidence with more samples', () => {
      const trackerSmall = new PriceMomentumTracker({ windowSize: 100 });
      const trackerLarge = new PriceMomentumTracker({ windowSize: 100 });

      // 3 samples
      for (let i = 0; i < 3; i++) {
        trackerSmall.addPriceUpdate('ETH/USDT', 2000 + i * 10, 100, Date.now() + i * 1000);
      }
      // 20 samples
      for (let i = 0; i < 20; i++) {
        trackerLarge.addPriceUpdate('ETH/USDT', 2000 + i * 10, 100, Date.now() + i * 1000);
      }

      const sigSmall = trackerSmall.getMomentumSignal('ETH/USDT');
      const sigLarge = trackerLarge.getMomentumSignal('ETH/USDT');

      expect(sigLarge!.confidence).toBeGreaterThan(sigSmall!.confidence);

      trackerSmall.resetAll();
      trackerLarge.resetAll();
    });
  });

  // ===========================================================================
  // LRU eviction
  // ===========================================================================

  describe('LRU eviction', () => {
    it('should evict oldest pairs when maxPairs exceeded', () => {
      const smallTracker = new PriceMomentumTracker({
        windowSize: 10,
        maxPairs: 5
      });

      // Add 6 pairs — should trigger eviction
      for (let i = 0; i < 6; i++) {
        smallTracker.addPriceUpdate(`pair_${i}`, 100, 50, Date.now() + i * 1000);
      }

      // First pair should have been evicted
      expect(smallTracker.getTrackedPairsCount()).toBeLessThanOrEqual(5);
      expect(smallTracker.getStats('pair_0')).toBeNull();
      // Latest pair should exist
      expect(smallTracker.getStats('pair_5')).not.toBeNull();

      smallTracker.resetAll();
    });
  });

  // ===========================================================================
  // resetPair / resetAll
  // ===========================================================================

  describe('reset', () => {
    it('should reset a specific pair', () => {
      tracker.addPriceUpdate('ETH/USDT', 2000, 100);
      tracker.addPriceUpdate('BTC/USDT', 40000, 50);

      tracker.resetPair('ETH/USDT');

      expect(tracker.getStats('ETH/USDT')).toBeNull();
      expect(tracker.getStats('BTC/USDT')).not.toBeNull();
    });

    it('should reset all pairs', () => {
      tracker.addPriceUpdate('ETH/USDT', 2000, 100);
      tracker.addPriceUpdate('BTC/USDT', 40000, 50);

      tracker.resetAll();

      expect(tracker.getTrackedPairsCount()).toBe(0);
    });
  });

  // ===========================================================================
  // Regression: Fix #30 - Sample stddev (N-1) instead of population stddev (N)
  // ===========================================================================

  describe('sample stddev regression (Fix #30)', () => {
    it('should use Bessel correction (N-1) for 2 values', () => {
      // With values [100, 200], mean = 150
      // Population stddev (÷N): sqrt(((100-150)^2 + (200-150)^2) / 2) = sqrt(2500) = 50
      // Sample stddev (÷(N-1)): sqrt(((100-150)^2 + (200-150)^2) / 1) = sqrt(5000) ≈ 70.71
      tracker.addPriceUpdate('STDDEV_PAIR', 100, 50, 1000);
      tracker.addPriceUpdate('STDDEV_PAIR', 200, 50, 2000);

      const stats = tracker.getStats('STDDEV_PAIR');
      // Sample stddev should be ~70.71, NOT 50
      expect(stats!.priceStdDev).toBeCloseTo(70.7107, 3);
    });

    it('should return 0 stddev for a single value (N < 2 guard)', () => {
      tracker.addPriceUpdate('SINGLE', 100, 50, 1000);

      const stats = tracker.getStats('SINGLE');
      expect(stats!.priceStdDev).toBe(0);
    });
  });

  // ===========================================================================
  // Regression: Fix #14 - LRU eviction uses findOldestN instead of full sort
  // ===========================================================================

  describe('LRU findOldestN eviction regression (Fix #14)', () => {
    it('should evict the correct oldest entries when n >= map.size', () => {
      // maxPairs = 3, add 3 then trigger eviction (evicts 10% = at least 1)
      const small = new PriceMomentumTracker({ windowSize: 5, maxPairs: 3 });

      small.addPriceUpdate('A', 100, 50, 1000);
      small.addPriceUpdate('B', 100, 50, 2000);
      small.addPriceUpdate('C', 100, 50, 3000);
      // Adding 4th triggers eviction of oldest 10% = 1 entry (A)
      small.addPriceUpdate('D', 100, 50, 4000);

      expect(small.getStats('A')).toBeNull();
      expect(small.getStats('D')).not.toBeNull();
      expect(small.getTrackedPairsCount()).toBeLessThanOrEqual(3);

      small.resetAll();
    });

    it('should keep newest entries after multiple eviction rounds', () => {
      const small = new PriceMomentumTracker({ windowSize: 5, maxPairs: 3 });

      // Add 5 pairs sequentially
      for (let i = 0; i < 5; i++) {
        small.addPriceUpdate(`pair_${i}`, 100, 50, 1000 + i * 1000);
      }

      // After evictions, the most recent pairs should survive
      expect(small.getStats('pair_4')).not.toBeNull();
      expect(small.getStats('pair_3')).not.toBeNull();
      // Earlier pairs should have been evicted
      expect(small.getStats('pair_0')).toBeNull();

      small.resetAll();
    });
  });

  // ===========================================================================
  // Singleton factory
  // ===========================================================================

  describe('singleton', () => {
    it('should return the same instance on multiple calls', () => {
      const a = getPriceMomentumTracker();
      const b = getPriceMomentumTracker();
      expect(a).toBe(b);
      resetPriceMomentumTracker();
    });

    it('should return a new instance after reset', () => {
      const a = getPriceMomentumTracker();
      resetPriceMomentumTracker();
      const b = getPriceMomentumTracker();
      expect(a).not.toBe(b);
      resetPriceMomentumTracker();
    });
  });
});
