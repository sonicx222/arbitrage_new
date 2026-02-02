/**
 * P1-5 FIX: Operation Guard Utility
 *
 * Provides reusable concurrency control patterns for async operations:
 * 1. Skip-if-busy guards: Prevent overlapping executions
 * 2. Rate limiting: Enforce minimum intervals between executions
 *
 * Use cases:
 * - Detection loops that should skip if previous cycle is still running
 * - Health monitors that shouldn't overlap
 * - Whale detection that needs rate limiting to prevent DoS
 *
 * @example
 * ```typescript
 * // Skip-if-busy pattern (for detection loops)
 * const detectionGuard = new OperationGuard('detection');
 *
 * setInterval(async () => {
 *   const release = detectionGuard.tryAcquire();
 *   if (!release) return; // Previous cycle still running
 *   try {
 *     await detectOpportunities();
 *   } finally {
 *     release();
 *   }
 * }, 100);
 *
 * // Rate-limited pattern (for whale detection)
 * const whaleGuard = new OperationGuard('whale-detection', { cooldownMs: 1000 });
 *
 * async function onWhaleTransaction() {
 *   const release = whaleGuard.tryAcquire();
 *   if (!release) return; // Busy or rate limited
 *   try {
 *     await processWhaleActivity();
 *   } finally {
 *     release();
 *   }
 * }
 * ```
 *
 * @see services/cross-chain-detector - Uses this for detection and health loops
 */

/**
 * Statistics for operation guard monitoring.
 */
export interface OperationGuardStats {
  /** Number of times the guard was successfully acquired */
  acquireCount: number;
  /** Number of times acquisition was rejected (busy or rate limited) */
  rejectionCount: number;
  /** Number of rejections due to busy state */
  busyRejections: number;
  /** Number of rejections due to rate limiting */
  rateLimitRejections: number;
  /** Whether the guard is currently held */
  isLocked: boolean;
  /** Time since last successful acquisition (ms) */
  timeSinceLastAcquireMs: number;
}

/**
 * Configuration for OperationGuard.
 */
export interface OperationGuardConfig {
  /** Minimum milliseconds between acquisitions (0 = no rate limiting) */
  cooldownMs?: number;
}

/**
 * Operation Guard - Skip-if-busy pattern with optional rate limiting.
 *
 * Unlike QueueLock/AsyncMutex which queue waiters, OperationGuard
 * immediately rejects concurrent requests - ideal for interval-based
 * operations that should skip when already running.
 */
export class OperationGuard {
  private readonly name: string;
  private readonly cooldownMs: number;
  private locked = false;
  private lastAcquireTime = 0;
  private stats = {
    acquireCount: 0,
    rejectionCount: 0,
    busyRejections: 0,
    rateLimitRejections: 0,
  };

  /**
   * Create a new OperationGuard.
   *
   * @param name - Name for debugging/logging
   * @param config - Optional configuration
   */
  constructor(name: string, config?: OperationGuardConfig) {
    this.name = name;
    this.cooldownMs = config?.cooldownMs ?? 0;
  }

  /**
   * Try to acquire the guard.
   *
   * Returns a release function if acquired successfully, null otherwise.
   * Rejected if:
   * - Already locked (busy)
   * - Within cooldown period (rate limited)
   *
   * @returns Release function, or null if rejected
   */
  tryAcquire(): (() => void) | null {
    const now = Date.now();

    // Check if busy
    if (this.locked) {
      this.stats.rejectionCount++;
      this.stats.busyRejections++;
      return null;
    }

    // Check rate limit
    if (this.cooldownMs > 0 && (now - this.lastAcquireTime) < this.cooldownMs) {
      this.stats.rejectionCount++;
      this.stats.rateLimitRejections++;
      return null;
    }

    // Acquire
    this.locked = true;
    this.lastAcquireTime = now;
    this.stats.acquireCount++;

    // Return release function
    let released = false;
    return () => {
      if (released) return; // Prevent double-release
      released = true;
      this.locked = false;
    };
  }

  /**
   * Check if currently locked (busy).
   */
  isLocked(): boolean {
    return this.locked;
  }

  /**
   * Check if currently rate limited.
   * Returns true if within cooldown period.
   */
  isRateLimited(): boolean {
    if (this.cooldownMs <= 0) return false;
    return (Date.now() - this.lastAcquireTime) < this.cooldownMs;
  }

  /**
   * Get time remaining in cooldown period (0 if not rate limited).
   */
  getRemainingCooldownMs(): number {
    if (this.cooldownMs <= 0) return 0;
    const elapsed = Date.now() - this.lastAcquireTime;
    return Math.max(0, this.cooldownMs - elapsed);
  }

  /**
   * Get guard name.
   */
  getName(): string {
    return this.name;
  }

  /**
   * Get guard statistics.
   */
  getStats(): OperationGuardStats {
    return {
      ...this.stats,
      isLocked: this.locked,
      timeSinceLastAcquireMs: this.lastAcquireTime > 0 ? Date.now() - this.lastAcquireTime : 0,
    };
  }

  /**
   * Reset statistics (for testing).
   */
  resetStats(): void {
    this.stats = {
      acquireCount: 0,
      rejectionCount: 0,
      busyRejections: 0,
      rateLimitRejections: 0,
    };
  }

  /**
   * Force release the guard (use with caution, mainly for cleanup/shutdown).
   */
  forceRelease(): void {
    this.locked = false;
  }
}

/**
 * Run an async function with the guard, returning null if rejected.
 *
 * @param guard - The OperationGuard instance
 * @param fn - The async function to run
 * @returns The return value of fn, or null if guard was busy/rate-limited
 */
export async function tryWithGuard<T>(
  guard: OperationGuard,
  fn: () => Promise<T>
): Promise<T | null> {
  const release = guard.tryAcquire();
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
 * Run a sync function with the guard, returning null if rejected.
 *
 * @param guard - The OperationGuard instance
 * @param fn - The sync function to run
 * @returns The return value of fn, or null if guard was busy/rate-limited
 */
export function tryWithGuardSync<T>(
  guard: OperationGuard,
  fn: () => T
): T | null {
  const release = guard.tryAcquire();
  if (!release) {
    return null;
  }
  try {
    return fn();
  } finally {
    release();
  }
}
