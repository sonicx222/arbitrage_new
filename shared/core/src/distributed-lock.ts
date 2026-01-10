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

import { RedisClient, getRedisClient } from './redis';
import { createLogger } from './logger';

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
}

// =============================================================================
// Distributed Lock Manager
// =============================================================================

export class DistributedLockManager {
  private redis: RedisClient | null = null;
  private logger = createLogger('distributed-lock');
  private instanceId: string;
  private config: Required<LockConfig>;
  private heldLocks: Map<string, { value: string; extendInterval?: NodeJS.Timeout }> = new Map();
  private stats: LockStats = {
    acquisitionAttempts: 0,
    successfulAcquisitions: 0,
    failedAcquisitions: 0,
    releases: 0,
    extensions: 0,
    currentlyHeld: 0
  };

  constructor(config: LockConfig = {}) {
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
                await this.extendLock(key, lockValue, ttlMs);
              } catch (error) {
                this.logger.error('Auto-extend failed', { key, error });
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
  // Lock Release
  // ===========================================================================

  /**
   * Release a held lock.
   * Only releases if the lock is still owned by this instance.
   */
  private async releaseLock(key: string, lockValue: string): Promise<void> {
    if (!this.redis) {
      return;
    }

    try {
      // Verify we still own the lock before releasing
      const currentValue = await this.redis.get<string>(key);

      if (currentValue === lockValue) {
        await this.redis.del(key);
        this.stats.releases++;
        this.stats.currentlyHeld = Math.max(0, this.stats.currentlyHeld - 1);
        this.logger.debug('Lock released', { key });
      } else {
        this.logger.warn('Lock release skipped - not owner', {
          key,
          expectedValue: lockValue,
          actualValue: currentValue
        });
      }

      // Clean up tracking
      const lockInfo = this.heldLocks.get(key);
      if (lockInfo?.extendInterval) {
        clearInterval(lockInfo.extendInterval);
      }
      this.heldLocks.delete(key);

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
   */
  private async extendLock(key: string, lockValue: string, additionalMs: number): Promise<boolean> {
    if (!this.redis) {
      return false;
    }

    try {
      // Verify we still own the lock
      const currentValue = await this.redis.get<string>(key);

      if (currentValue !== lockValue) {
        this.logger.warn('Lock extension failed - not owner', { key });
        return false;
      }

      // Extend TTL
      const ttlSeconds = Math.ceil(additionalMs / 1000);
      const result = await this.redis.expire(key, ttlSeconds);

      if (result === 1) {
        this.stats.extensions++;
        this.logger.debug('Lock extended', { key, additionalMs });
        return true;
      }

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
   * @param resourceId - Unique identifier for the resource to lock
   * @param fn - Function to execute while holding the lock
   * @param options - Lock acquisition options
   * @returns Function result, or null if lock could not be acquired
   */
  async withLock<T>(
    resourceId: string,
    fn: () => Promise<T>,
    options: AcquireOptions = {}
  ): Promise<{ success: true; result: T } | { success: false; reason: 'lock_not_acquired' | 'execution_error'; error?: Error }> {

    const handle = await this.acquireLock(resourceId, options);

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
}

// =============================================================================
// Singleton Factory
// =============================================================================

let lockManagerInstance: DistributedLockManager | null = null;

/**
 * Get the singleton DistributedLockManager instance.
 * Creates and initializes on first call.
 */
export async function getDistributedLockManager(config?: LockConfig): Promise<DistributedLockManager> {
  if (!lockManagerInstance) {
    lockManagerInstance = new DistributedLockManager(config);
    await lockManagerInstance.initialize();
  }
  return lockManagerInstance;
}

/**
 * Reset the singleton instance (for testing).
 */
export async function resetDistributedLockManager(): Promise<void> {
  if (lockManagerInstance) {
    await lockManagerInstance.shutdown();
    lockManagerInstance = null;
  }
}
