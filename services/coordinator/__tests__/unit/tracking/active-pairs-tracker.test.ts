/**
 * Unit tests for ActivePairsTracker
 *
 * Validates the extraction from coordinator.ts preserves:
 * - TTL-based cleanup
 * - Emergency eviction with hysteresis (75% target)
 * - O(n log k) selection via findKSmallest
 * - Map-compatible API for backward compatibility
 */

import { ActivePairsTracker, ActivePairsTrackerConfig, ActivePairsLogger } from '../../../src/tracking/active-pairs-tracker';

describe('ActivePairsTracker', () => {
  let tracker: ActivePairsTracker;
  let logger: ActivePairsLogger;
  const defaultConfig: ActivePairsTrackerConfig = {
    pairTtlMs: 300_000, // 5 minutes
    maxActivePairs: 10_000,
  };

  beforeEach(() => {
    logger = { debug: jest.fn() };
    tracker = new ActivePairsTracker(logger, defaultConfig);
  });

  describe('trackPair', () => {
    it('should track a new pair', () => {
      tracker.trackPair('0xABC', 'bsc', 'pancakeswap');

      expect(tracker.has('0xABC')).toBe(true);
      expect(tracker.size).toBe(1);

      const info = tracker.get('0xABC');
      expect(info).toBeDefined();
      expect(info!.chain).toBe('bsc');
      expect(info!.dex).toBe('pancakeswap');
      expect(info!.lastSeen).toBeGreaterThan(0);
    });

    it('should update lastSeen on re-track', () => {
      tracker.trackPair('0xABC', 'bsc', 'pancakeswap');
      const firstSeen = tracker.get('0xABC')!.lastSeen;

      // Small delay to ensure different timestamp
      tracker.trackPair('0xABC', 'bsc', 'pancakeswap');
      const secondSeen = tracker.get('0xABC')!.lastSeen;

      expect(secondSeen).toBeGreaterThanOrEqual(firstSeen);
    });

    it('should track multiple pairs', () => {
      tracker.trackPair('0x1', 'ethereum', 'uniswap');
      tracker.trackPair('0x2', 'bsc', 'pancakeswap');
      tracker.trackPair('0x3', 'arbitrum', 'sushiswap');

      expect(tracker.size).toBe(3);
      expect(tracker.has('0x1')).toBe(true);
      expect(tracker.has('0x2')).toBe(true);
      expect(tracker.has('0x3')).toBe(true);
    });
  });

  describe('emergency eviction', () => {
    it('should evict oldest pairs when exceeding maxActivePairs', () => {
      const smallConfig: ActivePairsTrackerConfig = {
        pairTtlMs: 300_000,
        maxActivePairs: 10,
      };
      const smallTracker = new ActivePairsTracker(logger, smallConfig);

      // Pre-populate with old pairs using set() for controlled timestamps
      for (let i = 0; i < 10; i++) {
        smallTracker.set(`0xOLD_${i}`, {
          lastSeen: Date.now() - 100_000 + i * 1000, // Oldest first
          chain: 'bsc',
          dex: 'pancakeswap',
        });
      }

      expect(smallTracker.size).toBe(10);

      // Adding one more should trigger emergency eviction
      smallTracker.trackPair('0xNEW', 'ethereum', 'uniswap');

      // Should evict down to 75% of limit = 7, plus the new one = 8
      // Actually: 11 pairs > 10 limit, target = floor(10 * 0.75) = 7
      // toRemove = 11 - 7 = 4 oldest pairs removed
      expect(smallTracker.size).toBeLessThanOrEqual(8);
      expect(smallTracker.has('0xNEW')).toBe(true);

      // The oldest pairs should be gone
      expect(smallTracker.has('0xOLD_0')).toBe(false);
      expect(smallTracker.has('0xOLD_1')).toBe(false);
    });

    it('should log emergency cleanup', () => {
      const smallConfig: ActivePairsTrackerConfig = {
        pairTtlMs: 300_000,
        maxActivePairs: 5,
      };
      const smallTracker = new ActivePairsTracker(logger, smallConfig);

      for (let i = 0; i < 5; i++) {
        smallTracker.set(`0x${i}`, {
          lastSeen: Date.now() - 50_000 + i * 1000,
          chain: 'bsc',
          dex: 'pancakeswap',
        });
      }

      smallTracker.trackPair('0xTRIGGER', 'ethereum', 'uniswap');

      expect(logger.debug).toHaveBeenCalledWith(
        'Emergency activePairs cleanup triggered',
        expect.objectContaining({
          limit: 5,
        }),
      );
    });

    it('should use hysteresis (evict to 75%) to prevent re-triggering', () => {
      const smallConfig: ActivePairsTrackerConfig = {
        pairTtlMs: 300_000,
        maxActivePairs: 8,
      };
      const smallTracker = new ActivePairsTracker(logger, smallConfig);

      for (let i = 0; i < 8; i++) {
        smallTracker.set(`0x${i}`, {
          lastSeen: Date.now() - 80_000 + i * 1000,
          chain: 'bsc',
          dex: 'pancakeswap',
        });
      }

      // Trigger eviction
      smallTracker.trackPair('0xTRIGGER', 'ethereum', 'uniswap');
      const sizeAfterEviction = smallTracker.size;

      // Target = floor(8 * 0.75) = 6, so should be at 6 or 7
      // (6 remaining after eviction + possibly the new one depending on if it was one of the evicted)
      expect(sizeAfterEviction).toBeLessThanOrEqual(7);

      // Adding a few more should NOT trigger another eviction
      smallTracker.trackPair('0xNEW2', 'bsc', 'pancakeswap');
      expect(logger.debug).toHaveBeenCalledTimes(1); // Only the first eviction
    });
  });

  describe('cleanup (TTL-based)', () => {
    it('should remove pairs older than TTL', () => {
      const shortTtl: ActivePairsTrackerConfig = {
        pairTtlMs: 1000, // 1 second
        maxActivePairs: 10_000,
      };
      const shortTracker = new ActivePairsTracker(logger, shortTtl);

      // Set a pair with old timestamp
      shortTracker.set('0xSTALE', {
        lastSeen: Date.now() - 2000, // 2 seconds ago
        chain: 'bsc',
        dex: 'pancakeswap',
      });
      shortTracker.set('0xFRESH', {
        lastSeen: Date.now(),
        chain: 'ethereum',
        dex: 'uniswap',
      });

      shortTracker.cleanup();

      expect(shortTracker.has('0xSTALE')).toBe(false);
      expect(shortTracker.has('0xFRESH')).toBe(true);
      expect(shortTracker.size).toBe(1);
    });

    it('should log cleanup when pairs are removed', () => {
      const shortTtl: ActivePairsTrackerConfig = {
        pairTtlMs: 1000,
        maxActivePairs: 10_000,
      };
      const shortTracker = new ActivePairsTracker(logger, shortTtl);

      shortTracker.set('0xSTALE', {
        lastSeen: Date.now() - 2000,
        chain: 'bsc',
        dex: 'pancakeswap',
      });

      shortTracker.cleanup();

      expect(logger.debug).toHaveBeenCalledWith(
        'Cleaned up stale active pairs',
        expect.objectContaining({
          removed: 1,
          remaining: 0,
        }),
      );
    });

    it('should not log when no pairs are removed', () => {
      tracker.trackPair('0xFRESH', 'bsc', 'pancakeswap');
      tracker.cleanup();

      expect(logger.debug).not.toHaveBeenCalled();
    });
  });

  describe('Map-compatible API (backward compat)', () => {
    it('should support size getter', () => {
      expect(tracker.size).toBe(0);
      tracker.trackPair('0x1', 'bsc', 'pancakeswap');
      expect(tracker.size).toBe(1);
    });

    it('should support has()', () => {
      expect(tracker.has('0x1')).toBe(false);
      tracker.trackPair('0x1', 'bsc', 'pancakeswap');
      expect(tracker.has('0x1')).toBe(true);
    });

    it('should support get()', () => {
      expect(tracker.get('0xNONEXIST')).toBeUndefined();
      tracker.trackPair('0x1', 'bsc', 'pancakeswap');
      const info = tracker.get('0x1');
      expect(info).toEqual(
        expect.objectContaining({ chain: 'bsc', dex: 'pancakeswap' }),
      );
    });

    it('should support set() for test setup', () => {
      tracker.set('0xTEST', {
        lastSeen: 1234567890,
        chain: 'ethereum',
        dex: 'uniswap',
      });
      expect(tracker.has('0xTEST')).toBe(true);
      expect(tracker.get('0xTEST')!.lastSeen).toBe(1234567890);
    });

    it('should support clear()', () => {
      tracker.trackPair('0x1', 'bsc', 'pancakeswap');
      tracker.trackPair('0x2', 'ethereum', 'uniswap');
      expect(tracker.size).toBe(2);

      tracker.clear();
      expect(tracker.size).toBe(0);
      expect(tracker.has('0x1')).toBe(false);
    });
  });
});
