/**
 * Distributed Lock Manager
 *
 * Provides atomic distributed locking using Redis SETNX for preventing
 * race conditions in distributed systems (e.g., duplicate trade execution).
 *
 * Features:
 * - Atomic lock acquisition using Redis SET NX EX
 * - Automatic TTL-based lock expiration (prevents deadlocks)
 * - Safe lock release (only owner can release)
 * - Convenience wrapper for lock-protected operations
 * - Configurable retry with exponential backoff
 *
 * @see ADR-007: Failover Strategy (uses same pattern as leader election)
 */

import { RedisClient, getRedisClient } from './client';
import { createLogger } from '../logger';
import type { ILogger } from '@arbitrage/types';

// =============================================================================
// Types
// =============================================================================


export interface LockConfig {
  /** Lock key prefix (default: 'lock:') */
  keyPrefix?: string;
  /** Default TTL in milliseconds (default: 30000) */
  defaultTtlMs?: number;
  /** Whether to auto-extend lock while operation is running */
  autoExtend?: boolean;
  /** Auto-extend interval in ms (should be < TTL/2) */
  autoExtendIntervalMs?: number;
  /** Optional logger for testing (defaults to createLogger) */
  logger?: ILogger;
}

export interface AcquireOptions {
  /** TTL for this specific lock acquisition (overrides default) */
  ttlMs?: number;
  /** Number of retry attempts (default: 0 = no retry) */
  retries?: number;
  /** Delay between retries in ms (default: 100) */
  retryDelayMs?: number;
  /** Whether to use exponential backoff for retries */
  exponentialBackoff?: boolean;
  /** Maximum delay between retries (for exponential backoff) */
  maxRetryDelayMs?: number;
}

export interface LockHandle {
  /** Whether lock was successfully acquired */
  acquired: boolean;
  /** The lock key (if acquired) */
  key?: string;
  /** Function to release the lock */
  release: () => Promise<void>;
  /** Function to extend lock TTL */
  extend: (additionalMs?: number) => Promise<boolean>;
}

export interface QueueOptions {
  /** TTL for this specific lock acquisition (overrides default) */
  ttlMs?: number;
  /** Maximum time to wait in queue in ms (default: 30000) */
  waitTimeoutMs?: number;
  /** Maximum queue size per resource (default: 100) */
  maxQueueSize?: number;
}

export interface LockStats {
  /** Total lock acquisition attempts */
  acquisitionAttempts: number;
  /** Successful lock acquisitions */
  successfulAcquisitions: number;
  /** Failed lock acquisitions */
  failedAcquisitions: number;
  /** Lock releases */
  releases: number;
  /** Lock extensions */
  extensions: number;
  /** Currently held locks */
  currentlyHeld: number;
  /** Total callers currently waiting in queues */
  queuedWaiters: number;
  /** Number of resources with active queues */
  activeQueues: number;
}

/** Internal type for queued lock waiters. Not exported. */
interface QueuedWaiter {
  resolve: (handle: LockHandle) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
}

// =============================================================================
// Lua Scripts for Atomic Operations
// =============================================================================

/**
 * Atomic release: only delete if we own the lock.
 * KEYS[1] = lock key
 * ARGV[1] = expected lock value
 * Returns 1 if released, 0 if not owner
 */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

/**
 * Atomic extend: only extend TTL if we own the lock.
 * KEYS[1] = lock key
 * ARGV[1] = expected lock value
 * ARGV[2] = new TTL in seconds
 * Returns 1 if extended, 0 if not owner or key missing
 */
const EXTEND_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("expire", KEYS[1], ARGV[2])
else
  return 0
end
`;

// =============================================================================
// Distributed Lock Manager
// =============================================================================

export class DistributedLockManager {
  private redis: RedisClient | null = null;
  private logger: ILogger;
  private instanceId: string;
  private config: Required<Omit<LockConfig, 'logger'>>;
  private heldLocks: Map<string, { value: string; extendInterval?: NodeJS.Timeout }> = new Map();
  private waitQueues: Map<string, QueuedWaiter[]> = new Map();
  private stats: LockStats = {
    acquisitionAttempts: 0,
    successfulAcquisitions: 0,
    failedAcquisitions: 0,
    releases: 0,
    extensions: 0,
    currentlyHeld: 0,
    queuedWaiters: 0,
    activeQueues: 0
  };

  constructor(config: LockConfig = {}) {
    // Use injected logger or create default
    this.logger = config.logger ?? createLogger('distributed-lock');

    // Generate unique instance ID for lock ownership
    this.instanceId = `lock-owner-${process.env.HOSTNAME || 'local'}-${process.pid}-${Date.now()}`;

    this.config = {
      keyPrefix: config.keyPrefix ?? 'lock:',
      defaultTtlMs: config.defaultTtlMs ?? 30000,
      autoExtend: config.autoExtend ?? false,
      autoExtendIntervalMs: config.autoExtendIntervalMs ?? 10000
    };

    this.logger.info('DistributedLockManager created', {
      instanceId: this.instanceId,
      config: this.config
    });
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  async initialize(redis?: RedisClient): Promise<void> {
    this.redis = redis ?? await getRedisClient();
    this.logger.info('DistributedLockManager initialized');
  }

  // ===========================================================================
  // Lock Acquisition
  // ===========================================================================

  /**
   * Attempt to acquire a distributed lock.
   *
   * @param resourceId - Unique identifier for the resource to lock
   * @param options - Acquisition options
   * @returns LockHandle with acquired status and release function
   */
  async acquireLock(resourceId: string, options: AcquireOptions = {}): Promise<LockHandle> {
    if (!this.redis) {
      throw new Error('DistributedLockManager not initialized. Call initialize() first.');
    }

    this.validateResourceId(resourceId);

    const key = this.buildLockKey(resourceId);
    const ttlMs = options.ttlMs ?? this.config.defaultTtlMs;
    const ttlSeconds = Math.ceil(ttlMs / 1000);
    const lockValue = this.generateLockValue();

    const retries = options.retries ?? 0;
    const retryDelayMs = options.retryDelayMs ?? 100;
    const exponentialBackoff = options.exponentialBackoff ?? false;
    const maxRetryDelayMs = options.maxRetryDelayMs ?? 5000;

    this.stats.acquisitionAttempts++;

    // Try to acquire with optional retries
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const acquired = await this.redis.setNx(key, lockValue, ttlSeconds);

        if (acquired) {
          this.stats.successfulAcquisitions++;
          this.stats.currentlyHeld++;

          // Track held lock
          const lockInfo: { value: string; extendInterval?: NodeJS.Timeout } = { value: lockValue };
          this.heldLocks.set(key, lockInfo);

          // Setup auto-extend if configured
          if (this.config.autoExtend) {
            lockInfo.extendInterval = setInterval(async () => {
              try {
                const extended = await this.extendLock(key, lockValue, ttlMs);
                // P1-2 FIX (2026-01-16): Stop interval if extension fails
                // This means lock was stolen/expired - continuing is wasteful
                if (!extended) {
                  this.logger.warn('Auto-extend failed: lock lost, stopping interval', { key });
                  if (lockInfo.extendInterval) {
                    clearInterval(lockInfo.extendInterval);
                    lockInfo.extendInterval = undefined;
                  }
                  // Clean up tracking since we no longer own the lock
                  this.heldLocks.delete(key);
                  this.stats.currentlyHeld = Math.max(0, this.stats.currentlyHeld - 1);
                }
              } catch (error) {
                this.logger.error('Auto-extend failed with error', { key, error });
                // P1-2 FIX: Also stop interval on error - lock state is unknown
                if (lockInfo.extendInterval) {
                  clearInterval(lockInfo.extendInterval);
                  lockInfo.extendInterval = undefined;
                }
                // Don't clean up tracking on error - let TTL expire naturally
              }
            }, this.config.autoExtendIntervalMs);
          }

          this.logger.debug('Lock acquired', { key, ttlMs, attempt });

          return {
            acquired: true,
            key,
            release: () => this.releaseLock(key, lockValue),
            extend: (additionalMs?: number) => this.extendLock(key, lockValue, additionalMs ?? ttlMs)
          };
        }

        // Lock not acquired, retry if attempts remaining
        if (attempt < retries) {
          const delay = exponentialBackoff
            ? Math.min(retryDelayMs * Math.pow(2, attempt), maxRetryDelayMs)
            : retryDelayMs;

          this.logger.debug('Lock acquisition failed, retrying', {
            key,
            attempt,
            nextDelay: delay
          });

          await this.sleep(delay);
        }

      } catch (error) {
        this.logger.error('Error during lock acquisition', { key, error, attempt });

        if (attempt === retries) {
          throw error;
        }
      }
    }

    // All attempts failed
    this.stats.failedAcquisitions++;
    this.logger.debug('Lock acquisition failed after all retries', { key, retries });

    return {
      acquired: false,
      release: async () => { /* no-op for failed acquisition */ },
      extend: async () => false
    };
  }

  // ===========================================================================
  // Queued Lock Acquisition
  // ===========================================================================

  /**
   * Attempt to acquire a lock, waiting in a FIFO queue if unavailable.
   *
   * When the lock is held by another caller, this method places the caller
   * in a per-resource queue. When the current holder releases the lock,
   * the next queued waiter is notified and attempts acquisition.
   *
   * @param resourceId - Unique identifier for the resource to lock
   * @param options - Queue and acquisition options
   * @returns LockHandle with acquired status and release function
   */
  async acquireLockWithQueue(resourceId: string, options: QueueOptions = {}): Promise<LockHandle> {
    if (!this.redis) {
      throw new Error('DistributedLockManager not initialized. Call initialize() first.');
    }

    this.validateResourceId(resourceId);

    const ttlMs = options.ttlMs ?? this.config.defaultTtlMs;
    const waitTimeoutMs = options.waitTimeoutMs ?? 30000;
    const maxQueueSize = options.maxQueueSize ?? 100;
    const key = this.buildLockKey(resourceId);

    // First, try immediate acquisition (no retries)
    const immediate = await this.acquireLock(resourceId, { ttlMs });
    if (immediate.acquired) {
      return immediate;
    }

    // Check queue backpressure
    const queue = this.waitQueues.get(key) ?? [];
    if (queue.length >= maxQueueSize) {
      this.logger.warn('Lock queue full, rejecting waiter', {
        key,
        queueSize: queue.length,
        maxQueueSize
      });
      return {
        acquired: false,
        release: async () => { /* no-op */ },
        extend: async () => false
      };
    }

    // Warn at 50% capacity
    if (queue.length >= Math.floor(maxQueueSize / 2)) {
      this.logger.warn('Lock queue exceeds 50% capacity', {
        key,
        queueSize: queue.length,
        maxQueueSize
      });
    }

    // Enqueue the caller and wait for notification
    return new Promise<LockHandle>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        // Remove this waiter from the queue on timeout
        this.removeWaiter(key, waiter);
        resolve({
          acquired: false,
          release: async () => { /* no-op */ },
          extend: async () => false
        });
      }, waitTimeoutMs);

      const waiter: QueuedWaiter = { resolve, reject, timeoutId };

      if (!this.waitQueues.has(key)) {
        this.waitQueues.set(key, []);
      }
      this.waitQueues.get(key)!.push(waiter);
      this.updateQueueStats();

      this.logger.debug('Caller enqueued for lock', {
        key,
        position: this.waitQueues.get(key)!.length,
        waitTimeoutMs
      });
    });
  }

  // ===========================================================================
  // Lock Release
  // ===========================================================================

  /**
   * Release a held lock.
   * Only releases if the lock is still owned by this instance.
   * Uses atomic Lua script to prevent TOCTOU race conditions.
   */
  private async releaseLock(key: string, lockValue: string): Promise<void> {
    if (!this.redis) {
      return;
    }

    try {
      // Atomic check-and-delete using Lua script
      const released = await this.redis.eval<number>(
        RELEASE_SCRIPT,
        [key],
        [lockValue]
      );

      if (released === 1) {
        this.stats.releases++;
        this.stats.currentlyHeld = Math.max(0, this.stats.currentlyHeld - 1);
        this.logger.debug('Lock released', { key });
      } else {
        this.logger.warn('Lock release skipped - not owner or already released', { key });
      }

      // Clean up tracking
      const lockInfo = this.heldLocks.get(key);
      if (lockInfo?.extendInterval) {
        clearInterval(lockInfo.extendInterval);
      }
      this.heldLocks.delete(key);

      // Notify next queued waiter (FIFO)
      this.notifyNextWaiter(key);

    } catch (error) {
      this.logger.error('Error releasing lock', { key, error });
      // Still clean up local tracking
      const lockInfo = this.heldLocks.get(key);
      if (lockInfo?.extendInterval) {
        clearInterval(lockInfo.extendInterval);
      }
      this.heldLocks.delete(key);
    }
  }

  // ===========================================================================
  // Lock Extension
  // ===========================================================================

  /**
   * Extend a held lock's TTL.
   * Only extends if the lock is still owned by this instance.
   * Uses atomic Lua script to prevent TOCTOU race conditions.
   */
  private async extendLock(key: string, lockValue: string, additionalMs: number): Promise<boolean> {
    if (!this.redis) {
      return false;
    }

    try {
      // Atomic check-and-extend using Lua script
      const ttlSeconds = Math.ceil(additionalMs / 1000);
      const result = await this.redis.eval<number>(
        EXTEND_SCRIPT,
        [key],
        [lockValue, ttlSeconds.toString()]
      );

      if (result === 1) {
        this.stats.extensions++;
        this.logger.debug('Lock extended', { key, additionalMs });
        return true;
      }

      this.logger.warn('Lock extension failed - not owner or key missing', { key });
      return false;

    } catch (error) {
      this.logger.error('Error extending lock', { key, error });
      return false;
    }
  }

  // ===========================================================================
  // Convenience Methods
  // ===========================================================================

  /**
   * Execute a function while holding a distributed lock.
   * Automatically acquires and releases the lock.
   *
   * P0-3 FIX: Now distinguishes between lock_not_acquired (lock held by another)
   * and redis_error (Redis unavailable). This prevents silent failures.
   *
   * @param resourceId - Unique identifier for the resource to lock
   * @param fn - Function to execute while holding the lock
   * @param options - Lock acquisition options
   * @returns Function result, or failure reason
   */
  async withLock<T>(
    resourceId: string,
    fn: () => Promise<T>,
    options: AcquireOptions = {}
  ): Promise<{ success: true; result: T } | { success: false; reason: 'lock_not_acquired' | 'execution_error' | 'redis_error'; error?: Error }> {

    let handle: LockHandle;
    try {
      handle = await this.acquireLock(resourceId, options);
    } catch (error) {
      // P0-3 FIX: Redis errors are now thrown, not swallowed
      this.logger.error('Redis error during lock acquisition', {
        resourceId,
        error: (error as Error).message
      });
      return { success: false, reason: 'redis_error', error: error as Error };
    }

    if (!handle.acquired) {
      return { success: false, reason: 'lock_not_acquired' };
    }

    try {
      const result = await fn();
      return { success: true, result };
    } catch (error) {
      return { success: false, reason: 'execution_error', error: error as Error };
    } finally {
      await handle.release();
    }
  }

  /**
   * Check if a lock is currently held (by anyone).
   */
  async isLocked(resourceId: string): Promise<boolean> {
    if (!this.redis) {
      throw new Error('DistributedLockManager not initialized');
    }

    const key = this.buildLockKey(resourceId);
    return await this.redis.exists(key);
  }

  /**
   * Force release a lock regardless of owner.
   * Use with caution - only for administrative purposes.
   */
  async forceRelease(resourceId: string): Promise<boolean> {
    if (!this.redis) {
      throw new Error('DistributedLockManager not initialized');
    }

    const key = this.buildLockKey(resourceId);

    try {
      const deleted = await this.redis.del(key);
      this.logger.warn('Force released lock', { key, deleted });
      return deleted > 0;
    } catch (error) {
      this.logger.error('Error force releasing lock', { key, error });
      return false;
    }
  }

  // ===========================================================================
  // Statistics & Monitoring
  // ===========================================================================

  getStats(): LockStats {
    return { ...this.stats };
  }

  getHeldLockKeys(): string[] {
    return Array.from(this.heldLocks.keys());
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  /**
   * Release all held locks and cleanup resources.
   */
  async shutdown(): Promise<void> {
    this.logger.info('Shutting down DistributedLockManager');

    // Reject all queued waiters
    for (const [key, queue] of this.waitQueues) {
      for (const waiter of queue) {
        clearTimeout(waiter.timeoutId);
        waiter.reject(new Error('DistributedLockManager is shutting down'));
      }
      this.logger.debug('Rejected queued waiters on shutdown', {
        key,
        count: queue.length
      });
    }
    this.waitQueues.clear();
    this.updateQueueStats();

    // Release all held locks
    const releasePromises: Promise<void>[] = [];

    for (const [key, lockInfo] of this.heldLocks) {
      // Clear auto-extend interval
      if (lockInfo.extendInterval) {
        clearInterval(lockInfo.extendInterval);
      }

      // Release the lock
      releasePromises.push(this.releaseLock(key, lockInfo.value));
    }

    await Promise.all(releasePromises);

    this.heldLocks.clear();
    this.logger.info('DistributedLockManager shutdown complete');
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  private buildLockKey(resourceId: string): string {
    return `${this.config.keyPrefix}${resourceId}`;
  }

  private generateLockValue(): string {
    // Include instanceId and timestamp for debugging
    return `${this.instanceId}:${Date.now()}:${Math.random().toString(36).substring(2, 10)}`;
  }

  private validateResourceId(resourceId: string): void {
    if (!resourceId || typeof resourceId !== 'string') {
      throw new Error('Invalid resourceId: must be non-empty string');
    }

    if (resourceId.length > 256) {
      throw new Error('Invalid resourceId: too long');
    }

    // Allow alphanumeric, dash, underscore, colon
    if (!/^[a-zA-Z0-9\-_:]+$/.test(resourceId)) {
      throw new Error('Invalid resourceId: contains unsafe characters');
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Notify the next queued waiter for a resource.
   * The woken waiter attempts to acquire the lock (may still fail
   * if a non-queued caller acquires it first).
   */
  private notifyNextWaiter(key: string): void {
    const queue = this.waitQueues.get(key);
    if (!queue || queue.length === 0) {
      return;
    }

    const waiter = queue.shift()!;
    clearTimeout(waiter.timeoutId);

    // Clean up empty queues
    if (queue.length === 0) {
      this.waitQueues.delete(key);
    }
    this.updateQueueStats();

    // Derive resourceId from key by stripping the prefix
    const resourceId = key.startsWith(this.config.keyPrefix)
      ? key.slice(this.config.keyPrefix.length)
      : key;

    this.logger.debug('Waking queued waiter', { key, remainingInQueue: queue.length });

    // Attempt lock acquisition for the woken waiter
    this.acquireLock(resourceId).then(
      (handle) => waiter.resolve(handle),
      (error) => waiter.reject(error)
    );
  }

  /**
   * Remove a specific waiter from a resource queue (used on timeout).
   */
  private removeWaiter(key: string, waiter: QueuedWaiter): void {
    const queue = this.waitQueues.get(key);
    if (!queue) {
      return;
    }

    const idx = queue.indexOf(waiter);
    if (idx !== -1) {
      queue.splice(idx, 1);
    }

    if (queue.length === 0) {
      this.waitQueues.delete(key);
    }
    this.updateQueueStats();
  }

  /**
   * Recalculate queue stats from current waitQueues state.
   */
  private updateQueueStats(): void {
    let totalWaiters = 0;
    for (const queue of this.waitQueues.values()) {
      totalWaiters += queue.length;
    }
    this.stats.queuedWaiters = totalWaiters;
    this.stats.activeQueues = this.waitQueues.size;
  }
}

// =============================================================================
// Singleton Factory
// =============================================================================

let lockManagerInstance: DistributedLockManager | null = null;
let lockManagerPromise: Promise<DistributedLockManager> | null = null;
let lockManagerInitError: Error | null = null;

/**
 * Get the singleton DistributedLockManager instance.
 * Thread-safe: concurrent calls will wait for the same initialization.
 */
export async function getDistributedLockManager(config?: LockConfig): Promise<DistributedLockManager> {
  // If already initialized successfully, return immediately
  if (lockManagerInstance) {
    return lockManagerInstance;
  }

  // If there's a cached error, throw it
  if (lockManagerInitError) {
    throw lockManagerInitError;
  }

  // If initialization is already in progress, wait for it
  if (lockManagerPromise) {
    return lockManagerPromise;
  }

  // Start new initialization (thread-safe: only first caller creates the promise)
  lockManagerPromise = (async (): Promise<DistributedLockManager> => {
    try {
      const instance = new DistributedLockManager(config);
      await instance.initialize();
      lockManagerInstance = instance;
      return instance;
    } catch (error) {
      lockManagerInitError = error as Error;
      throw error;
    }
  })();

  return lockManagerPromise;
}

/**
 * Reset the singleton instance (for testing).
 * P2-4 FIX: Wait for pending initialization before resetting
 */
export async function resetDistributedLockManager(): Promise<void> {
  // P2-4 FIX: If initialization is in progress, wait for it to complete
  // This prevents race conditions during test cleanup
  if (lockManagerPromise && !lockManagerInstance) {
    try {
      await lockManagerPromise;
    } catch {
      // Ignore init errors - we're resetting anyway
    }
  }

  if (lockManagerInstance) {
    await lockManagerInstance.shutdown();
  }
  lockManagerInstance = null;
  lockManagerPromise = null;
  lockManagerInitError = null;
}
