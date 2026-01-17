"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DistributedLockManager = void 0;
exports.getDistributedLockManager = getDistributedLockManager;
exports.resetDistributedLockManager = resetDistributedLockManager;
const redis_1 = require("./redis");
const logger_1 = require("./logger");
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
class DistributedLockManager {
    constructor(config = {}) {
        this.redis = null;
        this.heldLocks = new Map();
        this.stats = {
            acquisitionAttempts: 0,
            successfulAcquisitions: 0,
            failedAcquisitions: 0,
            releases: 0,
            extensions: 0,
            currentlyHeld: 0
        };
        // Use injected logger or create default
        this.logger = config.logger ?? (0, logger_1.createLogger)('distributed-lock');
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
    async initialize(redis) {
        this.redis = redis ?? await (0, redis_1.getRedisClient)();
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
    async acquireLock(resourceId, options = {}) {
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
                    const lockInfo = { value: lockValue };
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
                            }
                            catch (error) {
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
                        extend: (additionalMs) => this.extendLock(key, lockValue, additionalMs ?? ttlMs)
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
            }
            catch (error) {
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
            release: async () => { },
            extend: async () => false
        };
    }
    // ===========================================================================
    // Lock Release
    // ===========================================================================
    /**
     * Release a held lock.
     * Only releases if the lock is still owned by this instance.
     * Uses atomic Lua script to prevent TOCTOU race conditions.
     */
    async releaseLock(key, lockValue) {
        if (!this.redis) {
            return;
        }
        try {
            // Atomic check-and-delete using Lua script
            const released = await this.redis.eval(RELEASE_SCRIPT, [key], [lockValue]);
            if (released === 1) {
                this.stats.releases++;
                this.stats.currentlyHeld = Math.max(0, this.stats.currentlyHeld - 1);
                this.logger.debug('Lock released', { key });
            }
            else {
                this.logger.warn('Lock release skipped - not owner or already released', { key });
            }
            // Clean up tracking
            const lockInfo = this.heldLocks.get(key);
            if (lockInfo?.extendInterval) {
                clearInterval(lockInfo.extendInterval);
            }
            this.heldLocks.delete(key);
        }
        catch (error) {
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
    async extendLock(key, lockValue, additionalMs) {
        if (!this.redis) {
            return false;
        }
        try {
            // Atomic check-and-extend using Lua script
            const ttlSeconds = Math.ceil(additionalMs / 1000);
            const result = await this.redis.eval(EXTEND_SCRIPT, [key], [lockValue, ttlSeconds.toString()]);
            if (result === 1) {
                this.stats.extensions++;
                this.logger.debug('Lock extended', { key, additionalMs });
                return true;
            }
            this.logger.warn('Lock extension failed - not owner or key missing', { key });
            return false;
        }
        catch (error) {
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
    async withLock(resourceId, fn, options = {}) {
        let handle;
        try {
            handle = await this.acquireLock(resourceId, options);
        }
        catch (error) {
            // P0-3 FIX: Redis errors are now thrown, not swallowed
            this.logger.error('Redis error during lock acquisition', {
                resourceId,
                error: error.message
            });
            return { success: false, reason: 'redis_error', error: error };
        }
        if (!handle.acquired) {
            return { success: false, reason: 'lock_not_acquired' };
        }
        try {
            const result = await fn();
            return { success: true, result };
        }
        catch (error) {
            return { success: false, reason: 'execution_error', error: error };
        }
        finally {
            await handle.release();
        }
    }
    /**
     * Check if a lock is currently held (by anyone).
     */
    async isLocked(resourceId) {
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
    async forceRelease(resourceId) {
        if (!this.redis) {
            throw new Error('DistributedLockManager not initialized');
        }
        const key = this.buildLockKey(resourceId);
        try {
            const deleted = await this.redis.del(key);
            this.logger.warn('Force released lock', { key, deleted });
            return deleted > 0;
        }
        catch (error) {
            this.logger.error('Error force releasing lock', { key, error });
            return false;
        }
    }
    // ===========================================================================
    // Statistics & Monitoring
    // ===========================================================================
    getStats() {
        return { ...this.stats };
    }
    getHeldLockKeys() {
        return Array.from(this.heldLocks.keys());
    }
    getInstanceId() {
        return this.instanceId;
    }
    // ===========================================================================
    // Cleanup
    // ===========================================================================
    /**
     * Release all held locks and cleanup resources.
     */
    async shutdown() {
        this.logger.info('Shutting down DistributedLockManager');
        // Release all held locks
        const releasePromises = [];
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
    buildLockKey(resourceId) {
        return `${this.config.keyPrefix}${resourceId}`;
    }
    generateLockValue() {
        // Include instanceId and timestamp for debugging
        return `${this.instanceId}:${Date.now()}:${Math.random().toString(36).substring(2, 10)}`;
    }
    validateResourceId(resourceId) {
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
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
exports.DistributedLockManager = DistributedLockManager;
// =============================================================================
// Singleton Factory
// =============================================================================
let lockManagerInstance = null;
let lockManagerPromise = null;
let lockManagerInitError = null;
/**
 * Get the singleton DistributedLockManager instance.
 * Thread-safe: concurrent calls will wait for the same initialization.
 */
async function getDistributedLockManager(config) {
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
    lockManagerPromise = (async () => {
        try {
            const instance = new DistributedLockManager(config);
            await instance.initialize();
            lockManagerInstance = instance;
            return instance;
        }
        catch (error) {
            lockManagerInitError = error;
            throw error;
        }
    })();
    return lockManagerPromise;
}
/**
 * Reset the singleton instance (for testing).
 * P2-4 FIX: Wait for pending initialization before resetting
 */
async function resetDistributedLockManager() {
    // P2-4 FIX: If initialization is in progress, wait for it to complete
    // This prevents race conditions during test cleanup
    if (lockManagerPromise && !lockManagerInstance) {
        try {
            await lockManagerPromise;
        }
        catch {
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
//# sourceMappingURL=distributed-lock.js.map