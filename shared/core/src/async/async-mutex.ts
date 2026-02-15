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
  private waitQueue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
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
      await new Promise<void>((resolve, reject) => {
        this.waitQueue.push({ resolve, reject });
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

      // RACE-CONDITION-FIX: Use direct handoff pattern from NonceManager
      // Wake up next waiter FIRST, keeping lock held during handoff.
      // Only release lock if no waiters, preventing race where new caller
      // grabs lock between release and waiter wake-up.
      const next = this.waitQueue.shift();
      if (next) {
        // Hand off lock directly to next waiter (lock stays held)
        // Use setImmediate to prevent stack overflow with many waiters
        setImmediate(() => next.resolve());
      } else {
        // No waiters, safe to release the lock
        this.locked = false;
        this.stats.isLocked = false;
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

      // RACE-CONDITION-FIX: Use direct handoff pattern (same as acquire release)
      const next = this.waitQueue.shift();
      if (next) {
        // Hand off lock directly to next waiter (lock stays held)
        setImmediate(() => next.resolve());
      } else {
        // No waiters, safe to release the lock
        this.locked = false;
        this.stats.isLocked = false;
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
   * Cancel all waiters, rejecting their promises with the given error.
   * Used by clearNamedMutex() to prevent stranded waiters.
   *
   * @param reason - Error to reject waiters with
   * @returns The number of waiters that were cancelled
   */
  cancelWaiters(reason: Error): number {
    const count = this.waitQueue.length;
    const waiters = this.waitQueue.splice(0);
    this.locked = false;
    this.stats.isLocked = false;
    this.stats.waitingCount = 0;
    for (const waiter of waiters) {
      waiter.reject(reason);
    }
    return count;
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
 * P0-FIX (Memory Leak): Added TTL tracking and automatic cleanup for unused mutexes.
 * Mutexes are automatically removed after being idle for the cleanup interval (default 5 min).
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

interface MutexEntry {
  mutex: AsyncMutex;
  lastUsed: number;
}

const namedMutexes = new Map<string, MutexEntry>();

/** Cleanup interval in milliseconds (default: 5 minutes). Override via MUTEX_CLEANUP_INTERVAL_MS env var. */
const MUTEX_CLEANUP_INTERVAL_MS = parseInt(process.env.MUTEX_CLEANUP_INTERVAL_MS ?? '', 10) || 5 * 60 * 1000;

/** TTL for unused mutexes in milliseconds (default: 10 minutes). Override via MUTEX_IDLE_TTL_MS env var. */
const MUTEX_IDLE_TTL_MS = parseInt(process.env.MUTEX_IDLE_TTL_MS ?? '', 10) || 10 * 60 * 1000;

let cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Start the automatic cleanup interval if not already running.
 */
function ensureCleanupRunning(): void {
  if (cleanupIntervalId !== null) return;

  cleanupIntervalId = setInterval(() => {
    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [name, entry] of namedMutexes.entries()) {
      // Don't delete mutexes that are currently locked or have waiters
      if (entry.mutex.isLocked()) continue;
      if (entry.mutex.getStats().waitingCount > 0) continue;

      // Delete if idle for too long
      if (now - entry.lastUsed > MUTEX_IDLE_TTL_MS) {
        keysToDelete.push(name);
      }
    }

    for (const key of keysToDelete) {
      namedMutexes.delete(key);
    }

    // Stop cleanup interval if no mutexes remain
    if (namedMutexes.size === 0 && cleanupIntervalId !== null) {
      clearInterval(cleanupIntervalId);
      cleanupIntervalId = null;
    }
  }, MUTEX_CLEANUP_INTERVAL_MS);

  // Ensure interval doesn't prevent process exit
  if (cleanupIntervalId.unref) {
    cleanupIntervalId.unref();
  }
}

export function namedMutex(name: string): AsyncMutex {
  let entry = namedMutexes.get(name);
  if (!entry) {
    entry = {
      mutex: new AsyncMutex(),
      lastUsed: Date.now()
    };
    namedMutexes.set(name, entry);
    ensureCleanupRunning();
  } else {
    // Update last used timestamp
    entry.lastUsed = Date.now();
  }
  return entry.mutex;
}

/**
 * Clear a named mutex (useful for testing).
 * Rejects any stranded waiters with an error to prevent hanging promises.
 */
export function clearNamedMutex(name: string): void {
  const entry = namedMutexes.get(name);
  if (entry) {
    entry.mutex.cancelWaiters(new Error(`Named mutex '${name}' was cleared while waiting`));
    namedMutexes.delete(name);
  }
}

/**
 * Clear all named mutexes (useful for testing).
 * Rejects any stranded waiters with an error to prevent hanging promises.
 */
export function clearAllNamedMutexes(): void {
  for (const [name, entry] of namedMutexes.entries()) {
    entry.mutex.cancelWaiters(new Error(`Named mutex '${name}' was cleared during clearAll`));
  }
  namedMutexes.clear();
  if (cleanupIntervalId !== null) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }
}

/**
 * Get the current count of named mutexes (useful for monitoring/testing).
 */
export function getNamedMutexCount(): number {
  return namedMutexes.size;
}
