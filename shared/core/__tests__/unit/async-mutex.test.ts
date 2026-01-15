/**
 * AsyncMutex Unit Tests
 *
 * P1-FIX-5: Tests for the AsyncMutex utility class that provides
 * mutual exclusion for async operations.
 *
 * @migrated from shared/core/src/async-mutex.test.ts
 * @see ADR-009: Test Architecture
 */

import { describe, it, expect, beforeEach } from '@jest/globals';

// Import from package alias (new pattern per ADR-009)
import {
  AsyncMutex,
  namedMutex,
  clearNamedMutex,
  clearAllNamedMutexes
} from '@arbitrage/core';

describe('AsyncMutex', () => {
  let mutex: AsyncMutex;

  beforeEach(() => {
    mutex = new AsyncMutex();
    clearAllNamedMutexes();
  });

  // ===========================================================================
  // Basic Functionality
  // ===========================================================================

  describe('basic functionality', () => {
    it('should acquire and release lock', async () => {
      const release = await mutex.acquire();
      expect(mutex.isLocked()).toBe(true);
      release();
      expect(mutex.isLocked()).toBe(false);
    });

    it('should allow re-acquisition after release', async () => {
      const release1 = await mutex.acquire();
      release1();

      const release2 = await mutex.acquire();
      expect(mutex.isLocked()).toBe(true);
      release2();
      expect(mutex.isLocked()).toBe(false);
    });

    it('should prevent double-release', async () => {
      const release = await mutex.acquire();
      release();
      release(); // Second release should be no-op
      expect(mutex.isLocked()).toBe(false);
    });
  });

  // ===========================================================================
  // tryAcquire
  // ===========================================================================

  describe('tryAcquire', () => {
    it('should acquire immediately if unlocked', () => {
      const release = mutex.tryAcquire();
      expect(release).not.toBeNull();
      expect(mutex.isLocked()).toBe(true);
      release!();
    });

    it('should return null if already locked', async () => {
      const release = await mutex.acquire();
      const tryResult = mutex.tryAcquire();
      expect(tryResult).toBeNull();
      release();
    });
  });

  // ===========================================================================
  // runExclusive
  // ===========================================================================

  describe('runExclusive', () => {
    it('should run function with exclusive access', async () => {
      let executed = false;
      await mutex.runExclusive(async () => {
        executed = true;
      });
      expect(executed).toBe(true);
      expect(mutex.isLocked()).toBe(false);
    });

    it('should return function result', async () => {
      const result = await mutex.runExclusive(async () => {
        return 42;
      });
      expect(result).toBe(42);
    });

    it('should release lock even on error', async () => {
      await expect(
        mutex.runExclusive(async () => {
          throw new Error('Test error');
        })
      ).rejects.toThrow('Test error');

      expect(mutex.isLocked()).toBe(false);
    });
  });

  // ===========================================================================
  // tryRunExclusive
  // ===========================================================================

  describe('tryRunExclusive', () => {
    it('should run function if unlocked', async () => {
      const result = await mutex.tryRunExclusive(async () => 42);
      expect(result).toBe(42);
    });

    it('should return null if locked', async () => {
      const release = await mutex.acquire();
      const result = await mutex.tryRunExclusive(async () => 42);
      expect(result).toBeNull();
      release();
    });
  });

  // ===========================================================================
  // Concurrent Access
  // ===========================================================================

  describe('concurrent access', () => {
    it('should serialize concurrent operations', async () => {
      const order: number[] = [];

      const task1 = mutex.runExclusive(async () => {
        order.push(1);
        await new Promise(resolve => setTimeout(resolve, 10));
        order.push(2);
      });

      const task2 = mutex.runExclusive(async () => {
        order.push(3);
        await new Promise(resolve => setTimeout(resolve, 10));
        order.push(4);
      });

      await Promise.all([task1, task2]);

      // Either [1,2,3,4] or [3,4,1,2] depending on which starts first
      // But never interleaved like [1,3,2,4]
      expect(
        (order[0] === 1 && order[1] === 2) ||
        (order[0] === 3 && order[1] === 4)
      ).toBe(true);
    });

    it('should handle many concurrent callers', async () => {
      const results: number[] = [];
      const numCallers = 20;

      const promises = Array.from({ length: numCallers }, (_, i) =>
        mutex.runExclusive(async () => {
          results.push(i);
          return i;
        })
      );

      await Promise.all(promises);

      // All should complete
      expect(results.length).toBe(numCallers);
      // All unique values
      expect(new Set(results).size).toBe(numCallers);
    });
  });

  // ===========================================================================
  // Statistics
  // ===========================================================================

  describe('statistics', () => {
    it('should track acquire count', async () => {
      const release1 = await mutex.acquire();
      release1();

      const release2 = await mutex.acquire();
      release2();

      const stats = mutex.getStats();
      expect(stats.acquireCount).toBe(2);
    });

    it('should track contention', async () => {
      // Create contention
      const release = await mutex.acquire();

      // Start waiting
      const waitPromise = mutex.acquire();

      // Give it time to register as waiting
      await new Promise(resolve => setTimeout(resolve, 5));

      const statsWhileWaiting = mutex.getStats();
      expect(statsWhileWaiting.waitingCount).toBe(1);

      release();
      const release2 = await waitPromise;
      release2();

      const statsAfter = mutex.getStats();
      expect(statsAfter.contentionCount).toBeGreaterThanOrEqual(1);
    });

    it('should reset statistics', async () => {
      await mutex.runExclusive(async () => {});
      expect(mutex.getStats().acquireCount).toBe(1);

      mutex.resetStats();
      expect(mutex.getStats().acquireCount).toBe(0);
    });
  });

  // ===========================================================================
  // Named Mutex
  // ===========================================================================

  describe('named mutex', () => {
    it('should return same mutex for same name', () => {
      const mutex1 = namedMutex('test');
      const mutex2 = namedMutex('test');
      expect(mutex1).toBe(mutex2);
    });

    it('should return different mutex for different names', () => {
      const mutex1 = namedMutex('test1');
      const mutex2 = namedMutex('test2');
      expect(mutex1).not.toBe(mutex2);
    });

    it('should clear named mutex', async () => {
      const mutex1 = namedMutex('test');
      await mutex1.acquire();

      clearNamedMutex('test');

      const mutex2 = namedMutex('test');
      expect(mutex2).not.toBe(mutex1);
      expect(mutex2.isLocked()).toBe(false);
    });

    it('should clear all named mutexes', () => {
      namedMutex('test1');
      namedMutex('test2');

      clearAllNamedMutexes();

      // Should create new instances
      const newMutex1 = namedMutex('test1');
      const newMutex2 = namedMutex('test2');
      expect(newMutex1.isLocked()).toBe(false);
      expect(newMutex2.isLocked()).toBe(false);
    });
  });
});
