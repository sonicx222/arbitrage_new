/**
 * P2-2 FIX: Reusable AsyncMutex Utility
 *
 * Provides thread-safe mutual exclusion for async operations in JavaScript.
 * Prevents race conditions when multiple async operations need exclusive access
 * to a shared resource.
 *
 * Use cases in this codebase:
 * - Connection establishment (websocket-manager.ts connectMutex)
 * - Batch flushing (redis-streams.ts flushLock)
 * - Singleton initialization (async-singleton.ts)
 * - Lock acquisition (distributed-lock.ts)
 *
 * @example
 * ```ts
 * const mutex = new AsyncMutex();
 *
 * // Basic usage
 * await mutex.runExclusive(async () => {
 *   // Only one caller can be here at a time
 *   await doSomethingExclusive();
 * });
 *
 * // Manual acquire/release
 * const release = await mutex.acquire();
 * try {
 *   await doSomething();
 * } finally {
 *   release();
 * }
 * ```
 */

export interface MutexStats {
  /** Number of times the mutex was acquired */
  acquireCount: number;
  /** Number of times callers had to wait (contention) */
  contentionCount: number;
  /** Total time spent waiting in milliseconds */
  totalWaitTimeMs: number;
  /** Whether the mutex is currently held */
  isLocked: boolean;
  /** Number of callers currently waiting */
  waitingCount: number;
}

/**
 * Async mutex for mutual exclusion in async operations.
 */
export class AsyncMutex {
  private locked = false;
  private waitQueue: Array<() => void> = [];
  private stats: MutexStats = {
    acquireCount: 0,
    contentionCount: 0,
    totalWaitTimeMs: 0,
    isLocked: false,
    waitingCount: 0
  };

  /**
   * Acquire the mutex.
   * If the mutex is already held, this will wait until it's released.
   *
   * @returns A release function that MUST be called when done
   */
  async acquire(): Promise<() => void> {
    const startTime = Date.now();

    if (this.locked) {
      this.stats.contentionCount++;
      this.stats.waitingCount++;

      // Wait for our turn
      await new Promise<void>(resolve => {
        this.waitQueue.push(resolve);
      });

      this.stats.waitingCount--;
      this.stats.totalWaitTimeMs += Date.now() - startTime;
    }

    this.locked = true;
    this.stats.isLocked = true;
    this.stats.acquireCount++;

    // Return release function
    let released = false;
    return () => {
      if (released) return; // Prevent double-release
      released = true;

      this.locked = false;
      this.stats.isLocked = false;

      // Wake up next waiter if any
      const next = this.waitQueue.shift();
      if (next) {
        // Use setImmediate to prevent stack overflow with many waiters
        setImmediate(() => next());
      }
    };
  }

  /**
   * Try to acquire the mutex without waiting.
   *
   * @returns Release function if acquired, null if mutex is already held
   */
  tryAcquire(): (() => void) | null {
    if (this.locked) {
      return null;
    }

    this.locked = true;
    this.stats.isLocked = true;
    this.stats.acquireCount++;

    let released = false;
    return () => {
      if (released) return;
      released = true;

      this.locked = false;
      this.stats.isLocked = false;

      const next = this.waitQueue.shift();
      if (next) {
        setImmediate(() => next());
      }
    };
  }

  /**
   * Run an async function with exclusive access.
   * The mutex is automatically released when the function completes (success or error).
   *
   * @param fn The async function to run exclusively
   * @returns The return value of fn
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Run an async function with exclusive access, but return null if the mutex is busy.
   *
   * @param fn The async function to run exclusively
   * @returns The return value of fn, or null if mutex was busy
   */
  async tryRunExclusive<T>(fn: () => Promise<T>): Promise<T | null> {
    const release = this.tryAcquire();
    if (!release) {
      return null;
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Check if the mutex is currently locked.
   */
  isLocked(): boolean {
    return this.locked;
  }

  /**
   * Get mutex statistics.
   */
  getStats(): MutexStats {
    return { ...this.stats };
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
 * Named mutex registry for coordinating access across different parts of the codebase.
 * Useful when multiple components need to coordinate on the same resource.
 *
 * @example
 * ```ts
 * // In component A
 * await namedMutex('db-migration').runExclusive(async () => {
 *   await runMigrations();
 * });
 *
 * // In component B (will wait for A to finish)
 * await namedMutex('db-migration').runExclusive(async () => {
 *   await checkMigrations();
 * });
 * ```
 */
const namedMutexes = new Map<string, AsyncMutex>();

export function namedMutex(name: string): AsyncMutex {
  let mutex = namedMutexes.get(name);
  if (!mutex) {
    mutex = new AsyncMutex();
    namedMutexes.set(name, mutex);
  }
  return mutex;
}

/**
 * Clear a named mutex (useful for testing).
 */
export function clearNamedMutex(name: string): void {
  namedMutexes.delete(name);
}

/**
 * Clear all named mutexes (useful for testing).
 */
export function clearAllNamedMutexes(): void {
  namedMutexes.clear();
}
