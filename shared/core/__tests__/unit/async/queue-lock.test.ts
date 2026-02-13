/**
 * QueueLock Unit Tests
 *
 * Tests for QueueLock class, withLock, and tryWithLock utilities
 * that provide queue-based mutual exclusion.
 *
 * @see shared/core/src/async/queue-lock.ts
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { QueueLock, withLock, tryWithLock } from '../../../src/async/queue-lock';

/**
 * Helper to flush setImmediate callbacks used by QueueLock.release().
 */
function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// =============================================================================
// QueueLock
// =============================================================================

describe('QueueLock', () => {
  let lock: QueueLock;

  beforeEach(() => {
    lock = new QueueLock();
  });

  it('acquire() grants lock when free', async () => {
    await lock.acquire();

    expect(lock.isLocked()).toBe(true);

    lock.release();
  });

  it('acquire() waits when lock is held, resolves when released', async () => {
    await lock.acquire();

    let secondAcquired = false;
    const secondPromise = lock.acquire().then(() => {
      secondAcquired = true;
    });

    // Second caller should be waiting
    expect(secondAcquired).toBe(false);

    lock.release();
    await flushImmediate();
    await secondPromise;

    expect(secondAcquired).toBe(true);
    expect(lock.isLocked()).toBe(true);

    lock.release();
  });

  it('tryAcquire() returns true when free', () => {
    const acquired = lock.tryAcquire();

    expect(acquired).toBe(true);
    expect(lock.isLocked()).toBe(true);

    lock.release();
  });

  it('tryAcquire() returns false when held', async () => {
    await lock.acquire();

    const acquired = lock.tryAcquire();

    expect(acquired).toBe(false);

    lock.release();
  });

  it('release() wakes next waiter in queue', async () => {
    await lock.acquire();

    const order: number[] = [];
    const p1 = lock.acquire().then(() => { order.push(1); });

    lock.release();
    await flushImmediate();
    await p1;

    expect(order).toEqual([1]);
    expect(lock.isLocked()).toBe(true);

    lock.release();
  });

  it('multiple waiters are served in FIFO order', async () => {
    await lock.acquire();

    const order: number[] = [];
    const p1 = lock.acquire().then(() => {
      order.push(1);
      lock.release();
    });
    const p2 = lock.acquire().then(() => {
      order.push(2);
      lock.release();
    });
    const p3 = lock.acquire().then(() => {
      order.push(3);
      lock.release();
    });

    // Release the initial lock, let the chain proceed
    lock.release();

    await Promise.all([p1, p2, p3]);

    expect(order).toEqual([1, 2, 3]);
  });

  it('isLocked() reflects current state', async () => {
    expect(lock.isLocked()).toBe(false);

    await lock.acquire();
    expect(lock.isLocked()).toBe(true);

    lock.release();
    expect(lock.isLocked()).toBe(false);
  });

  it('getWaitingCount() reflects queue length', async () => {
    expect(lock.getWaitingCount()).toBe(0);

    await lock.acquire();

    const p1 = lock.acquire();
    const p2 = lock.acquire();

    expect(lock.getWaitingCount()).toBe(2);

    // Release to drain queue
    lock.release();
    await flushImmediate();
    await p1;
    expect(lock.getWaitingCount()).toBe(1);

    lock.release();
    await flushImmediate();
    await p2;
    expect(lock.getWaitingCount()).toBe(0);

    lock.release();
  });

  it('getStats() tracks acquireCount and contentionCount', async () => {
    // First acquire - no contention
    await lock.acquire();
    let stats = lock.getStats();
    expect(stats.acquireCount).toBe(1);
    expect(stats.contentionCount).toBe(0);

    // Second acquirer must wait - contention
    const p1 = lock.acquire();
    stats = lock.getStats();
    expect(stats.contentionCount).toBe(1);

    lock.release();
    await flushImmediate();
    await p1;

    stats = lock.getStats();
    expect(stats.acquireCount).toBe(2);

    lock.release();
  });

  it('resetStats() clears statistics but preserves lock state', async () => {
    await lock.acquire();

    const p1 = lock.acquire();
    expect(lock.getStats().contentionCount).toBe(1);

    lock.resetStats();

    const stats = lock.getStats();
    expect(stats.acquireCount).toBe(0);
    expect(stats.contentionCount).toBe(0);
    expect(stats.isLocked).toBe(true);
    // The waiter is still in queue
    expect(stats.waitingCount).toBe(1);

    // Clean up
    lock.release();
    await flushImmediate();
    await p1;
    lock.release();
  });

  it('tryAcquire() returns false when waiters are queued', async () => {
    await lock.acquire();
    const p1 = lock.acquire(); // queued waiter

    // Even though lock.release() hasn't been called yet, tryAcquire should fail
    // because there are waiters in the queue
    const acquired = lock.tryAcquire();
    expect(acquired).toBe(false);

    // Clean up
    lock.release();
    await flushImmediate();
    await p1;
    lock.release();
  });

  it('release() on unlocked lock with no waiters sets locked to false', () => {
    // Acquire and release
    lock.tryAcquire();
    lock.release();

    expect(lock.isLocked()).toBe(false);
  });
});

// =============================================================================
// withLock
// =============================================================================

describe('withLock', () => {
  let lock: QueueLock;

  beforeEach(() => {
    lock = new QueueLock();
  });

  it('acquires lock, runs fn, releases lock', async () => {
    let lockWasHeld = false;

    await withLock(lock, async () => {
      lockWasHeld = lock.isLocked();
    });

    expect(lockWasHeld).toBe(true);
    expect(lock.isLocked()).toBe(false);
  });

  it('releases lock even if fn throws', async () => {
    await expect(
      withLock(lock, async () => {
        throw new Error('fn failed');
      })
    ).rejects.toThrow('fn failed');

    expect(lock.isLocked()).toBe(false);
  });

  it('returns fn return value', async () => {
    const result = await withLock(lock, async () => {
      return 'computed-value';
    });

    expect(result).toBe('computed-value');
  });

  it('ensures mutual exclusion between concurrent withLock calls', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const task = async () => {
      await withLock(lock, async () => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        // Yield to allow other tasks to attempt entry
        await flushImmediate();
        concurrentCount--;
      });
    };

    await Promise.all([task(), task(), task()]);

    expect(maxConcurrent).toBe(1);
  });
});

// =============================================================================
// tryWithLock
// =============================================================================

describe('tryWithLock', () => {
  let lock: QueueLock;

  beforeEach(() => {
    lock = new QueueLock();
  });

  it('returns fn result when lock is free', async () => {
    const result = await tryWithLock(lock, async () => {
      return 'success';
    });

    expect(result).toBe('success');
    expect(lock.isLocked()).toBe(false);
  });

  it('returns null when lock is held (does not wait)', async () => {
    await lock.acquire();

    const result = await tryWithLock(lock, async () => {
      return 'should-not-run';
    });

    expect(result).toBeNull();

    lock.release();
  });

  it('releases lock after fn completes', async () => {
    await tryWithLock(lock, async () => {
      expect(lock.isLocked()).toBe(true);
      return 'done';
    });

    expect(lock.isLocked()).toBe(false);
  });

  it('releases lock even if fn throws', async () => {
    await expect(
      tryWithLock(lock, async () => {
        throw new Error('task failed');
      })
    ).rejects.toThrow('task failed');

    expect(lock.isLocked()).toBe(false);
  });

  it('does not execute fn when lock is busy', async () => {
    let fnCalled = false;
    await lock.acquire();

    await tryWithLock(lock, async () => {
      fnCalled = true;
      return 'x';
    });

    expect(fnCalled).toBe(false);

    lock.release();
  });
});
