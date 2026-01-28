/**
 * FIX 9.1: Queue-Based Lock Pattern
 *
 * Extracted from AsyncMutex and NonceManager for code reuse.
 * Provides a simple, race-condition-free lock implementation using a queue.
 *
 * The key insight is the "always queue first" pattern:
 * 1. All callers add themselves to the queue immediately
 * 2. The first caller acquires the lock
 * 3. On release, the lock is handed directly to the next waiter
 * 4. This prevents TOCTOU race conditions between checking and acquiring
 *
 * @see shared/core/src/async/async-mutex.ts - Uses this pattern
 * @see shared/core/src/nonce-manager.ts - Uses this pattern
 */

/**
 * Statistics for queue lock monitoring.
 */
export interface QueueLockStats {
  /** Number of times the lock was acquired */
  acquireCount: number;
  /** Number of times callers had to wait (contention) */
  contentionCount: number;
  /** Total time spent waiting in milliseconds */
  totalWaitTimeMs: number;
  /** Whether the lock is currently held */
  isLocked: boolean;
  /** Number of callers currently waiting */
  waitingCount: number;
}

/**
 * Simple queue-based lock for mutual exclusion.
 *
 * This is a lower-level building block used by AsyncMutex.
 * For most use cases, prefer AsyncMutex directly.
 *
 * Usage:
 * ```typescript
 * const lock = new QueueLock();
 *
 * async function criticalSection() {
 *   await lock.acquire();
 *   try {
 *     // Only one caller can be here at a time
 *     await doSomething();
 *   } finally {
 *     lock.release();
 *   }
 * }
 * ```
 */
export class QueueLock {
  private locked = false;
  private waitQueue: Array<() => void> = [];
  private stats: QueueLockStats = {
    acquireCount: 0,
    contentionCount: 0,
    totalWaitTimeMs: 0,
    isLocked: false,
    waitingCount: 0
  };

  /**
   * Acquire the lock.
   * If the lock is already held, this will wait until it's released.
   *
   * IMPORTANT: You MUST call release() when done, preferably in a finally block.
   */
  async acquire(): Promise<void> {
    const startTime = Date.now();

    // Always queue first - this is the key to preventing race conditions
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);

      // If we're the only one in queue and lock is free, acquire immediately
      if (this.waitQueue.length === 1 && !this.locked) {
        this.locked = true;
        this.stats.isLocked = true;
        this.stats.acquireCount++;
        this.waitQueue.shift();
        resolve();
      } else {
        // We have to wait - track contention
        if (this.locked) {
          this.stats.contentionCount++;
          this.stats.waitingCount++;
        }
      }
    }).then(() => {
      // Track wait time if we had to wait
      const waitTime = Date.now() - startTime;
      if (waitTime > 0) {
        this.stats.totalWaitTimeMs += waitTime;
        this.stats.waitingCount = Math.max(0, this.stats.waitingCount - 1);
      }
    });
  }

  /**
   * Try to acquire the lock without waiting.
   *
   * @returns true if lock was acquired, false if it was already held
   */
  tryAcquire(): boolean {
    if (this.locked || this.waitQueue.length > 0) {
      return false;
    }

    this.locked = true;
    this.stats.isLocked = true;
    this.stats.acquireCount++;
    return true;
  }

  /**
   * Release the lock.
   *
   * Uses the direct handoff pattern: if there are waiters, the lock is
   * handed directly to the next waiter (lock stays held during handoff).
   */
  release(): void {
    // Wake up next waiter if any
    const nextWaiter = this.waitQueue.shift();
    if (nextWaiter) {
      // Hand off lock directly to next waiter (lock stays held)
      // Use setImmediate to prevent stack overflow with many waiters
      this.stats.acquireCount++;
      setImmediate(() => nextWaiter());
    } else {
      // No waiters, release the lock
      this.locked = false;
      this.stats.isLocked = false;
    }
  }

  /**
   * Check if the lock is currently held.
   */
  isLocked(): boolean {
    return this.locked;
  }

  /**
   * Get the number of callers waiting for the lock.
   */
  getWaitingCount(): number {
    return this.waitQueue.length;
  }

  /**
   * Get lock statistics.
   */
  getStats(): QueueLockStats {
    return {
      ...this.stats,
      waitingCount: this.waitQueue.length
    };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.stats = {
      acquireCount: 0,
      contentionCount: 0,
      totalWaitTimeMs: 0,
      isLocked: this.locked,
      waitingCount: this.waitQueue.length
    };
  }
}

/**
 * Run an async function with the lock held.
 * The lock is automatically released when the function completes (success or error).
 *
 * This is a convenience wrapper that's safer than manual acquire/release.
 *
 * @param lock - The QueueLock instance
 * @param fn - The async function to run exclusively
 * @returns The return value of fn
 */
export async function withLock<T>(lock: QueueLock, fn: () => Promise<T>): Promise<T> {
  await lock.acquire();
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

/**
 * Try to run a function with the lock held, returning null if lock is busy.
 *
 * @param lock - The QueueLock instance
 * @param fn - The async function to run exclusively
 * @returns The return value of fn, or null if lock was busy
 */
export async function tryWithLock<T>(lock: QueueLock, fn: () => Promise<T>): Promise<T | null> {
  if (!lock.tryAcquire()) {
    return null;
  }
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
