/**
 * LockConflictTracker Unit Tests
 *
 * Tests lock conflict tracking for crash recovery detection.
 * Covers: conflict recording, force-release thresholds, stale entry cleanup,
 * memory growth protection, and singleton management.
 *
 * @see services/execution-engine/src/services/lock-conflict-tracker.ts
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  LockConflictTracker,
  getLockConflictTracker,
  resetLockConflictTracker,
  type LockConflictTrackerConfig,
} from '../../../src/services/lock-conflict-tracker';

describe('LockConflictTracker', () => {
  let tracker: LockConflictTracker;

  beforeEach(() => {
    tracker = new LockConflictTracker();
  });

  describe('recordConflict', () => {
    it('should return false on first conflict (starts tracking)', () => {
      const result = tracker.recordConflict('opp-1');

      expect(result).toBe(false);
      expect(tracker.size).toBe(1);
    });

    it('should return false when below threshold', () => {
      // Default threshold is 3, so 2 conflicts should not trigger
      tracker.recordConflict('opp-1');
      const result = tracker.recordConflict('opp-1');

      expect(result).toBe(false);
    });

    it('should return true when threshold reached AND minAge exceeded', () => {
      const config: LockConflictTrackerConfig = {
        conflictThreshold: 2,
        minAgeMs: 0, // No minimum age for this test
        windowMs: 60000,
      };
      const customTracker = new LockConflictTracker(config);

      customTracker.recordConflict('opp-1');
      const result = customTracker.recordConflict('opp-1');

      expect(result).toBe(true);
    });

    it('should NOT trigger force-release when threshold reached but minAge not exceeded', () => {
      const config: LockConflictTrackerConfig = {
        conflictThreshold: 2,
        minAgeMs: 60000, // 60 seconds - won't be exceeded in test
        windowMs: 120000,
      };
      const customTracker = new LockConflictTracker(config);

      customTracker.recordConflict('opp-1');
      const result = customTracker.recordConflict('opp-1');

      // Threshold reached (2) but minAge (60s) not exceeded
      expect(result).toBe(false);
    });

    it('should track multiple opportunities independently', () => {
      tracker.recordConflict('opp-1');
      tracker.recordConflict('opp-2');
      tracker.recordConflict('opp-3');

      expect(tracker.size).toBe(3);
    });

    it('should reset tracking when conflict is outside window', async () => {
      const config: LockConflictTrackerConfig = {
        conflictThreshold: 3,
        windowMs: 10, // Very short window for testing
        minAgeMs: 0,
      };
      const customTracker = new LockConflictTracker(config);

      customTracker.recordConflict('opp-1');
      customTracker.recordConflict('opp-1');

      // Wait for the window to expire
      await new Promise(resolve => setTimeout(resolve, 20));

      // This should reset the tracking since it's outside the window
      const result = customTracker.recordConflict('opp-1');
      expect(result).toBe(false);

      // Conflict info should be reset to count: 1
      const info = customTracker.getConflictInfo('opp-1');
      expect(info?.count).toBe(1);
    });

    it('should increment count for successive conflicts within window', () => {
      tracker.recordConflict('opp-1');
      tracker.recordConflict('opp-1');
      tracker.recordConflict('opp-1');

      const info = tracker.getConflictInfo('opp-1');
      expect(info?.count).toBe(3);
    });
  });

  describe('getConflictInfo', () => {
    it('should return undefined for untracked opportunity', () => {
      expect(tracker.getConflictInfo('nonexistent')).toBeUndefined();
    });

    it('should return conflict info with firstSeen and count', () => {
      const beforeTime = Date.now();
      tracker.recordConflict('opp-1');
      tracker.recordConflict('opp-1');

      const info = tracker.getConflictInfo('opp-1');
      expect(info).toBeDefined();
      expect(info!.count).toBe(2);
      expect(info!.firstSeen).toBeGreaterThanOrEqual(beforeTime);
      expect(info!.firstSeen).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('clear', () => {
    it('should remove tracking for a specific opportunity', () => {
      tracker.recordConflict('opp-1');
      tracker.recordConflict('opp-2');

      tracker.clear('opp-1');

      expect(tracker.getConflictInfo('opp-1')).toBeUndefined();
      expect(tracker.getConflictInfo('opp-2')).toBeDefined();
      expect(tracker.size).toBe(1);
    });

    it('should not throw when clearing non-existent opportunity', () => {
      expect(() => tracker.clear('nonexistent')).not.toThrow();
    });
  });

  describe('size', () => {
    it('should return 0 for empty tracker', () => {
      expect(tracker.size).toBe(0);
    });

    it('should track the number of unique opportunities', () => {
      tracker.recordConflict('opp-1');
      tracker.recordConflict('opp-1'); // Same opp, shouldn't increase size
      tracker.recordConflict('opp-2');
      tracker.recordConflict('opp-3');

      expect(tracker.size).toBe(3);
    });
  });

  describe('cleanup', () => {
    it('should remove stale entries older than 2x window', async () => {
      const config: LockConflictTrackerConfig = {
        windowMs: 10, // Very short window
        minAgeMs: 0,
      };
      const customTracker = new LockConflictTracker(config);

      customTracker.recordConflict('opp-1');

      // Wait for entries to become stale (> 2x window = 20ms)
      await new Promise(resolve => setTimeout(resolve, 30));

      customTracker.cleanup();
      expect(customTracker.size).toBe(0);
    });

    it('should keep recent entries during cleanup', () => {
      tracker.recordConflict('opp-1');
      tracker.recordConflict('opp-2');

      tracker.cleanup(); // Should not remove anything - entries are fresh

      expect(tracker.size).toBe(2);
    });

    it('should enforce maxEntries limit', () => {
      const config: LockConflictTrackerConfig = {
        maxEntries: 3,
        windowMs: 60000, // Long window so nothing is stale
      };
      const customTracker = new LockConflictTracker(config);

      // Add more entries than maxEntries
      for (let i = 0; i < 10; i++) {
        customTracker.recordConflict(`opp-${i}`);
      }

      expect(customTracker.size).toBe(10); // Before cleanup

      customTracker.cleanup();

      expect(customTracker.size).toBe(3); // After cleanup, capped at maxEntries
    });

    it('should remove entries when enforcing size limit', () => {
      const config: LockConflictTrackerConfig = {
        maxEntries: 2,
        windowMs: 60000,
      };
      const customTracker = new LockConflictTracker(config);

      // Add 5 entries (all at ~same time since rapid)
      for (let i = 0; i < 5; i++) {
        customTracker.recordConflict(`opp-${i}`);
      }

      customTracker.cleanup();

      // Should be capped at maxEntries
      expect(customTracker.size).toBe(2);
    });
  });

  describe('reset', () => {
    it('should clear all tracking data', () => {
      tracker.recordConflict('opp-1');
      tracker.recordConflict('opp-2');
      tracker.recordConflict('opp-3');

      tracker.reset();

      expect(tracker.size).toBe(0);
      expect(tracker.getConflictInfo('opp-1')).toBeUndefined();
    });
  });

  describe('Default Config', () => {
    it('should use default threshold of 3', () => {
      const config: LockConflictTrackerConfig = { minAgeMs: 0, windowMs: 60000 };
      const customTracker = new LockConflictTracker(config);

      customTracker.recordConflict('opp-1'); // count=1
      expect(customTracker.recordConflict('opp-1')).toBe(false); // count=2
      expect(customTracker.recordConflict('opp-1')).toBe(true);  // count=3, triggers
    });

    it('should use default maxEntries of 1000', () => {
      // Just verify it doesn't throw with many entries
      for (let i = 0; i < 100; i++) {
        tracker.recordConflict(`opp-${i}`);
      }
      expect(tracker.size).toBe(100);
    });
  });

  describe('Singleton Management', () => {
    afterEach(() => {
      resetLockConflictTracker();
    });

    it('should return the same instance on repeated calls', () => {
      const tracker1 = getLockConflictTracker();
      const tracker2 = getLockConflictTracker();

      expect(tracker1).toBe(tracker2);
    });

    it('should return new instance after reset', () => {
      const tracker1 = getLockConflictTracker();
      resetLockConflictTracker();
      const tracker2 = getLockConflictTracker();

      expect(tracker1).not.toBe(tracker2);
    });

    it('should clear data on reset', () => {
      const instance = getLockConflictTracker();
      instance.recordConflict('opp-1');

      resetLockConflictTracker();

      const newInstance = getLockConflictTracker();
      expect(newInstance.size).toBe(0);
    });
  });
});
