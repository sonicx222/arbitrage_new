/**
 * Pair Activity Tracker Unit Tests
 *
 * Tests for volatility-based pair prioritization system.
 * Validates activity tracking, hot pair detection, and LRU eviction.
 *
 * @see shared/core/src/analytics/pair-activity-tracker.ts
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  PairActivityTracker,
  getPairActivityTracker,
  resetPairActivityTracker
} from '../../src/analytics/pair-activity-tracker';

describe('PairActivityTracker', () => {
  let tracker: PairActivityTracker;

  beforeEach(() => {
    // Reset singleton before each test
    resetPairActivityTracker();
    tracker = new PairActivityTracker({
      windowMs: 1000,                    // 1 second window for faster tests
      hotThresholdUpdatesPerSecond: 2,   // 2+ updates/sec = hot
      maxPairs: 100,
      cleanupIntervalMs: 60000           // Long interval to avoid interference
    });
  });

  afterEach(() => {
    tracker.destroy();
  });

  describe('recordUpdate', () => {
    it('should record updates for new pairs', () => {
      const pairAddress = '0x1234567890abcdef';
      tracker.recordUpdate(pairAddress);

      const metrics = tracker.getMetrics(pairAddress);
      expect(metrics).not.toBeNull();
      expect(metrics!.updatesInWindow).toBe(1);
    });

    it('should normalize addresses to lowercase', () => {
      tracker.recordUpdate('0xABCDEF1234567890');
      tracker.recordUpdate('0xabcdef1234567890');

      const metrics = tracker.getMetrics('0xABCDEF1234567890');
      expect(metrics).not.toBeNull();
      expect(metrics!.updatesInWindow).toBe(2);
    });

    it('should track multiple updates for the same pair', () => {
      const pairAddress = '0x1234567890abcdef';
      const now = Date.now();

      // Record 5 updates
      for (let i = 0; i < 5; i++) {
        tracker.recordUpdate(pairAddress, now + i * 10);
      }

      const metrics = tracker.getMetrics(pairAddress);
      expect(metrics).not.toBeNull();
      expect(metrics!.updatesInWindow).toBe(5);
    });
  });

  describe('isHotPair', () => {
    it('should return false for unknown pairs', () => {
      expect(tracker.isHotPair('0xunknown')).toBe(false);
    });

    it('should return false for pairs with low activity', () => {
      const pairAddress = '0x1234567890abcdef';
      tracker.recordUpdate(pairAddress);

      // 1 update is not enough to be hot (threshold is 2/sec)
      expect(tracker.isHotPair(pairAddress)).toBe(false);
    });

    it('should return true for pairs with high activity', () => {
      const pairAddress = '0x1234567890abcdef';
      const now = Date.now();

      // Record 5 updates in quick succession (within 1 second)
      for (let i = 0; i < 5; i++) {
        tracker.recordUpdate(pairAddress, now + i * 100);
      }

      // 5 updates in ~500ms = 10 updates/sec > threshold of 2
      expect(tracker.isHotPair(pairAddress)).toBe(true);
    });
  });

  describe('getHotPairs', () => {
    it('should return empty array when no pairs are hot', () => {
      tracker.recordUpdate('0xpair1');
      expect(tracker.getHotPairs()).toEqual([]);
    });

    it('should return all hot pairs', () => {
      const now = Date.now();

      // Make pair1 hot
      for (let i = 0; i < 5; i++) {
        tracker.recordUpdate('0xpair1', now + i * 100);
      }

      // Make pair2 not hot (only 1 update)
      tracker.recordUpdate('0xpair2');

      // Make pair3 hot
      for (let i = 0; i < 5; i++) {
        tracker.recordUpdate('0xpair3', now + i * 100);
      }

      const hotPairs = tracker.getHotPairs();
      expect(hotPairs).toContain('0xpair1');
      expect(hotPairs).toContain('0xpair3');
      expect(hotPairs).not.toContain('0xpair2');
    });
  });

  describe('getTopActivePairs', () => {
    it('should return pairs sorted by activity score', () => {
      const now = Date.now();

      // Low activity
      tracker.recordUpdate('0xlow', now);

      // Medium activity
      for (let i = 0; i < 3; i++) {
        tracker.recordUpdate('0xmedium', now + i * 100);
      }

      // High activity
      for (let i = 0; i < 10; i++) {
        tracker.recordUpdate('0xhigh', now + i * 50);
      }

      const top = tracker.getTopActivePairs(3);
      expect(top.length).toBe(3);
      expect(top[0].pairAddress).toBe('0xhigh');
      expect(top[1].pairAddress).toBe('0xmedium');
      expect(top[2].pairAddress).toBe('0xlow');
    });

    it('should respect the limit parameter', () => {
      const now = Date.now();

      for (let i = 0; i < 10; i++) {
        tracker.recordUpdate(`0xpair${i}`, now);
      }

      const top = tracker.getTopActivePairs(3);
      expect(top.length).toBe(3);
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', () => {
      const now = Date.now();

      // Add some pairs
      tracker.recordUpdate('0xpair1', now);

      for (let i = 0; i < 5; i++) {
        tracker.recordUpdate('0xpair2', now + i * 100);
      }

      const stats = tracker.getStats();
      expect(stats.trackedPairs).toBe(2);
      expect(stats.totalUpdates).toBe(6);
      expect(stats.hotPairs).toBeGreaterThanOrEqual(0);
      expect(stats.averageUpdatesPerSecond).toBeGreaterThanOrEqual(0);
    });
  });

  describe('resetPair', () => {
    it('should remove tracking data for a specific pair', () => {
      tracker.recordUpdate('0xpair1');
      tracker.recordUpdate('0xpair2');

      tracker.resetPair('0xpair1');

      expect(tracker.getMetrics('0xpair1')).toBeNull();
      expect(tracker.getMetrics('0xpair2')).not.toBeNull();
    });
  });

  describe('resetAll', () => {
    it('should remove all tracking data', () => {
      tracker.recordUpdate('0xpair1');
      tracker.recordUpdate('0xpair2');

      tracker.resetAll();

      expect(tracker.getMetrics('0xpair1')).toBeNull();
      expect(tracker.getMetrics('0xpair2')).toBeNull();
      expect(tracker.getStats().trackedPairs).toBe(0);
    });
  });

  describe('LRU eviction', () => {
    it('should evict oldest pairs when max limit is reached', () => {
      const smallTracker = new PairActivityTracker({
        windowMs: 1000,
        hotThresholdUpdatesPerSecond: 2,
        maxPairs: 10,
        cleanupIntervalMs: 60000
      });

      const now = Date.now();

      // Add 10 pairs at the limit
      for (let i = 0; i < 10; i++) {
        smallTracker.recordUpdate(`0xpair${i}`, now + i);
      }

      expect(smallTracker.getStats().trackedPairs).toBe(10);

      // Add one more pair - should trigger eviction
      smallTracker.recordUpdate('0xnewpair', now + 100);

      // Should have evicted oldest pairs (10% = 1 pair)
      const stats = smallTracker.getStats();
      expect(stats.trackedPairs).toBeLessThanOrEqual(10);

      smallTracker.destroy();
    });
  });

  describe('singleton factory', () => {
    it('should return the same instance', () => {
      resetPairActivityTracker();

      const instance1 = getPairActivityTracker();
      const instance2 = getPairActivityTracker();

      expect(instance1).toBe(instance2);

      resetPairActivityTracker();
    });

    it('should use config only on first call', () => {
      resetPairActivityTracker();

      const instance1 = getPairActivityTracker({ windowMs: 5000 });
      const instance2 = getPairActivityTracker({ windowMs: 10000 }); // Should be ignored

      expect(instance1).toBe(instance2);

      resetPairActivityTracker();
    });
  });
});
