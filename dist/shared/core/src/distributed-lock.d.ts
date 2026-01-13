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
import { RedisClient } from './redis';
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
export declare class DistributedLockManager {
    private redis;
    private logger;
    private instanceId;
    private config;
    private heldLocks;
    private stats;
    constructor(config?: LockConfig);
    initialize(redis?: RedisClient): Promise<void>;
    /**
     * Attempt to acquire a distributed lock.
     *
     * @param resourceId - Unique identifier for the resource to lock
     * @param options - Acquisition options
     * @returns LockHandle with acquired status and release function
     */
    acquireLock(resourceId: string, options?: AcquireOptions): Promise<LockHandle>;
    /**
     * Release a held lock.
     * Only releases if the lock is still owned by this instance.
     * Uses atomic Lua script to prevent TOCTOU race conditions.
     */
    private releaseLock;
    /**
     * Extend a held lock's TTL.
     * Only extends if the lock is still owned by this instance.
     * Uses atomic Lua script to prevent TOCTOU race conditions.
     */
    private extendLock;
    /**
     * Execute a function while holding a distributed lock.
     * Automatically acquires and releases the lock.
     *
     * @param resourceId - Unique identifier for the resource to lock
     * @param fn - Function to execute while holding the lock
     * @param options - Lock acquisition options
     * @returns Function result, or null if lock could not be acquired
     */
    withLock<T>(resourceId: string, fn: () => Promise<T>, options?: AcquireOptions): Promise<{
        success: true;
        result: T;
    } | {
        success: false;
        reason: 'lock_not_acquired' | 'execution_error';
        error?: Error;
    }>;
    /**
     * Check if a lock is currently held (by anyone).
     */
    isLocked(resourceId: string): Promise<boolean>;
    /**
     * Force release a lock regardless of owner.
     * Use with caution - only for administrative purposes.
     */
    forceRelease(resourceId: string): Promise<boolean>;
    getStats(): LockStats;
    getHeldLockKeys(): string[];
    getInstanceId(): string;
    /**
     * Release all held locks and cleanup resources.
     */
    shutdown(): Promise<void>;
    private buildLockKey;
    private generateLockValue;
    private validateResourceId;
    private sleep;
}
/**
 * Get the singleton DistributedLockManager instance.
 * Thread-safe: concurrent calls will wait for the same initialization.
 */
export declare function getDistributedLockManager(config?: LockConfig): Promise<DistributedLockManager>;
/**
 * Reset the singleton instance (for testing).
 * P2-4 FIX: Wait for pending initialization before resetting
 */
export declare function resetDistributedLockManager(): Promise<void>;
//# sourceMappingURL=distributed-lock.d.ts.map