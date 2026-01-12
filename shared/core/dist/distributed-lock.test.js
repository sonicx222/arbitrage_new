"use strict";
/**
 * Distributed Lock Manager Tests
 *
 * Tests for atomic distributed locking with Redis SETNX.
 * Covers race conditions, TTL expiration, and error handling.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const globals_1 = require("@jest/globals");
const distributed_lock_1 = require("./distributed-lock");
// Mock Redis client - created as a factory to avoid hoisting issues
const createMockRedisClient = () => ({
    setNx: globals_1.jest.fn(),
    get: globals_1.jest.fn(),
    del: globals_1.jest.fn(),
    expire: globals_1.jest.fn(),
    eval: globals_1.jest.fn(),
    exists: globals_1.jest.fn(),
    ping: globals_1.jest.fn().mockResolvedValue(true)
});
// Shared mock reference
let mockRedisClient;
// Mock the redis module
globals_1.jest.mock('./redis', () => ({
    getRedisClient: globals_1.jest.fn().mockImplementation(() => Promise.resolve(mockRedisClient)),
    RedisClient: globals_1.jest.fn()
}));
// Mock logger
globals_1.jest.mock('./logger', () => ({
    createLogger: globals_1.jest.fn(() => ({
        info: globals_1.jest.fn(),
        error: globals_1.jest.fn(),
        warn: globals_1.jest.fn(),
        debug: globals_1.jest.fn()
    }))
}));
(0, globals_1.describe)('DistributedLockManager', () => {
    let lockManager;
    (0, globals_1.beforeEach)(async () => {
        globals_1.jest.clearAllMocks();
        await (0, distributed_lock_1.resetDistributedLockManager)();
        // Create fresh mock for each test
        mockRedisClient = createMockRedisClient();
        // Default mock implementations
        mockRedisClient.setNx.mockResolvedValue(true);
        mockRedisClient.get.mockResolvedValue(null);
        mockRedisClient.del.mockResolvedValue(1);
        mockRedisClient.expire.mockResolvedValue(1);
        mockRedisClient.exists.mockResolvedValue(false);
        lockManager = new distributed_lock_1.DistributedLockManager();
        await lockManager.initialize(mockRedisClient);
    });
    (0, globals_1.afterEach)(async () => {
        await lockManager.shutdown();
    });
    // ===========================================================================
    // Basic Lock Operations
    // ===========================================================================
    (0, globals_1.describe)('basic lock operations', () => {
        (0, globals_1.it)('should acquire lock when available', async () => {
            mockRedisClient.setNx.mockResolvedValue(true);
            const handle = await lockManager.acquireLock('test-resource');
            (0, globals_1.expect)(handle.acquired).toBe(true);
            (0, globals_1.expect)(handle.key).toBe('lock:test-resource');
            (0, globals_1.expect)(mockRedisClient.setNx).toHaveBeenCalledWith('lock:test-resource', globals_1.expect.any(String), 30 // default TTL in seconds
            );
        });
        (0, globals_1.it)('should fail to acquire lock when already held', async () => {
            mockRedisClient.setNx.mockResolvedValue(false);
            const handle = await lockManager.acquireLock('test-resource');
            (0, globals_1.expect)(handle.acquired).toBe(false);
            (0, globals_1.expect)(handle.key).toBeUndefined();
        });
        (0, globals_1.it)('should release lock successfully', async () => {
            mockRedisClient.setNx.mockResolvedValue(true);
            const handle = await lockManager.acquireLock('test-resource');
            (0, globals_1.expect)(handle.acquired).toBe(true);
            // Mock eval to return 1 (lock deleted)
            mockRedisClient.eval.mockResolvedValue(1);
            // Get the lock value that was set
            const lockValue = mockRedisClient.setNx.mock.calls[0][1];
            await handle.release();
            // Should use atomic Lua script via eval instead of del
            (0, globals_1.expect)(mockRedisClient.eval).toHaveBeenCalledWith(globals_1.expect.stringContaining('redis.call("get"'), ['lock:test-resource'], [lockValue]);
        });
        (0, globals_1.it)('should not release lock if not owner', async () => {
            mockRedisClient.setNx.mockResolvedValue(true);
            const handle = await lockManager.acquireLock('test-resource');
            (0, globals_1.expect)(handle.acquired).toBe(true);
            // Mock eval to return 0 (lock not deleted - someone else owns it)
            // The atomic Lua script checks ownership internally
            mockRedisClient.eval.mockResolvedValue(0);
            await handle.release();
            // Should still call eval (which atomically checks ownership and skips delete)
            (0, globals_1.expect)(mockRedisClient.eval).toHaveBeenCalled();
        });
        (0, globals_1.it)('should use custom TTL when provided', async () => {
            mockRedisClient.setNx.mockResolvedValue(true);
            await lockManager.acquireLock('test-resource', { ttlMs: 60000 });
            (0, globals_1.expect)(mockRedisClient.setNx).toHaveBeenCalledWith('lock:test-resource', globals_1.expect.any(String), 60 // 60000ms = 60s
            );
        });
        (0, globals_1.it)('should use custom key prefix', async () => {
            const customManager = new distributed_lock_1.DistributedLockManager({ keyPrefix: 'myapp:locks:' });
            await customManager.initialize(mockRedisClient);
            mockRedisClient.setNx.mockResolvedValue(true);
            await customManager.acquireLock('test-resource');
            (0, globals_1.expect)(mockRedisClient.setNx).toHaveBeenCalledWith('myapp:locks:test-resource', globals_1.expect.any(String), globals_1.expect.any(Number));
            await customManager.shutdown();
        });
    });
    // ===========================================================================
    // Retry Behavior
    // ===========================================================================
    (0, globals_1.describe)('retry behavior', () => {
        (0, globals_1.it)('should retry acquisition when configured', async () => {
            // First two attempts fail, third succeeds
            mockRedisClient.setNx
                .mockResolvedValueOnce(false)
                .mockResolvedValueOnce(false)
                .mockResolvedValueOnce(true);
            const handle = await lockManager.acquireLock('test-resource', {
                retries: 3,
                retryDelayMs: 10
            });
            (0, globals_1.expect)(handle.acquired).toBe(true);
            (0, globals_1.expect)(mockRedisClient.setNx).toHaveBeenCalledTimes(3);
        });
        (0, globals_1.it)('should fail after exhausting retries', async () => {
            mockRedisClient.setNx.mockResolvedValue(false);
            const handle = await lockManager.acquireLock('test-resource', {
                retries: 2,
                retryDelayMs: 10
            });
            (0, globals_1.expect)(handle.acquired).toBe(false);
            (0, globals_1.expect)(mockRedisClient.setNx).toHaveBeenCalledTimes(3); // initial + 2 retries
        });
        (0, globals_1.it)('should use exponential backoff when configured', async () => {
            mockRedisClient.setNx.mockResolvedValue(false);
            const startTime = Date.now();
            await lockManager.acquireLock('test-resource', {
                retries: 3,
                retryDelayMs: 50,
                exponentialBackoff: true
            });
            const elapsed = Date.now() - startTime;
            // With exponential backoff: 50 + 100 + 200 = 350ms minimum
            (0, globals_1.expect)(elapsed).toBeGreaterThanOrEqual(300); // Some tolerance
        });
        (0, globals_1.it)('should respect maxRetryDelayMs with exponential backoff', async () => {
            mockRedisClient.setNx.mockResolvedValue(false);
            const startTime = Date.now();
            await lockManager.acquireLock('test-resource', {
                retries: 5,
                retryDelayMs: 100,
                exponentialBackoff: true,
                maxRetryDelayMs: 150
            });
            const elapsed = Date.now() - startTime;
            // Delays should be: 100, 150, 150, 150, 150 = 700ms max
            // Without cap would be: 100, 200, 400, 800, 1600 = 3100ms
            (0, globals_1.expect)(elapsed).toBeLessThan(1000);
        });
    });
    // ===========================================================================
    // Lock Extension
    // ===========================================================================
    (0, globals_1.describe)('lock extension', () => {
        (0, globals_1.it)('should extend lock TTL when owner', async () => {
            mockRedisClient.setNx.mockResolvedValue(true);
            const handle = await lockManager.acquireLock('test-resource');
            (0, globals_1.expect)(handle.acquired).toBe(true);
            // Get the lock value that was set
            const lockValue = mockRedisClient.setNx.mock.calls[0][1];
            // Mock eval to return 1 (successfully extended)
            mockRedisClient.eval.mockResolvedValue(1);
            const extended = await handle.extend(60000);
            (0, globals_1.expect)(extended).toBe(true);
            // Should use atomic Lua script via eval instead of expire
            (0, globals_1.expect)(mockRedisClient.eval).toHaveBeenCalledWith(globals_1.expect.stringContaining('redis.call("expire"'), ['lock:test-resource'], [lockValue, '60']);
        });
        (0, globals_1.it)('should fail to extend lock when not owner', async () => {
            mockRedisClient.setNx.mockResolvedValue(true);
            const handle = await lockManager.acquireLock('test-resource');
            (0, globals_1.expect)(handle.acquired).toBe(true);
            // Mock eval to return 0 (not owner - extend failed)
            mockRedisClient.eval.mockResolvedValue(0);
            const extended = await handle.extend(60000);
            (0, globals_1.expect)(extended).toBe(false);
            // Eval is still called, but returns 0 to indicate failure
            (0, globals_1.expect)(mockRedisClient.eval).toHaveBeenCalled();
        });
    });
    // ===========================================================================
    // withLock Convenience Method
    // ===========================================================================
    (0, globals_1.describe)('withLock', () => {
        (0, globals_1.it)('should execute function while holding lock', async () => {
            mockRedisClient.setNx.mockResolvedValue(true);
            const lockValue = 'test-lock-value';
            mockRedisClient.get.mockResolvedValue(lockValue);
            let executed = false;
            const result = await lockManager.withLock('test-resource', async () => {
                executed = true;
                return 'success';
            });
            (0, globals_1.expect)(result.success).toBe(true);
            if (result.success) {
                (0, globals_1.expect)(result.result).toBe('success');
            }
            (0, globals_1.expect)(executed).toBe(true);
        });
        (0, globals_1.it)('should return failure when lock not acquired', async () => {
            mockRedisClient.setNx.mockResolvedValue(false);
            let executed = false;
            const result = await lockManager.withLock('test-resource', async () => {
                executed = true;
                return 'success';
            });
            (0, globals_1.expect)(result.success).toBe(false);
            if (!result.success) {
                (0, globals_1.expect)(result.reason).toBe('lock_not_acquired');
            }
            (0, globals_1.expect)(executed).toBe(false);
        });
        (0, globals_1.it)('should release lock even on function error', async () => {
            mockRedisClient.setNx.mockResolvedValue(true);
            // Need to capture the actual lock value used
            let capturedLockValue;
            mockRedisClient.setNx.mockImplementation(async (_key, value, _ttl) => {
                capturedLockValue = value;
                return true;
            });
            // Mock eval to return 1 (lock released successfully)
            mockRedisClient.eval.mockResolvedValue(1);
            const result = await lockManager.withLock('test-resource', async () => {
                throw new Error('Test error');
            });
            (0, globals_1.expect)(result.success).toBe(false);
            if (!result.success) {
                (0, globals_1.expect)(result.reason).toBe('execution_error');
                (0, globals_1.expect)(result.error?.message).toBe('Test error');
            }
            // Lock should still be released via atomic Lua script
            (0, globals_1.expect)(mockRedisClient.eval).toHaveBeenCalled();
        });
        (0, globals_1.it)('should pass through acquisition options', async () => {
            mockRedisClient.setNx.mockResolvedValue(true);
            await lockManager.withLock('test-resource', async () => 'result', {
                ttlMs: 60000,
                retries: 3
            });
            (0, globals_1.expect)(mockRedisClient.setNx).toHaveBeenCalledWith('lock:test-resource', globals_1.expect.any(String), 60);
        });
    });
    // ===========================================================================
    // Concurrent Lock Acquisition (Race Condition Prevention)
    // ===========================================================================
    (0, globals_1.describe)('concurrent lock acquisition', () => {
        (0, globals_1.it)('should only allow one acquisition when racing', async () => {
            // Simulate race condition: first call wins, second fails
            let firstAcquisition = true;
            mockRedisClient.setNx.mockImplementation(async () => {
                if (firstAcquisition) {
                    firstAcquisition = false;
                    return true;
                }
                return false;
            });
            // Start two acquisitions "simultaneously"
            const [handle1, handle2] = await Promise.all([
                lockManager.acquireLock('shared-resource'),
                lockManager.acquireLock('shared-resource')
            ]);
            // Only one should succeed
            const acquiredCount = [handle1.acquired, handle2.acquired].filter(Boolean).length;
            (0, globals_1.expect)(acquiredCount).toBe(1);
        });
        (0, globals_1.it)('should track concurrent lock statistics', async () => {
            mockRedisClient.setNx
                .mockResolvedValueOnce(true)
                .mockResolvedValueOnce(false)
                .mockResolvedValueOnce(true);
            const lockValue = 'test-value';
            mockRedisClient.get.mockResolvedValue(lockValue);
            await lockManager.acquireLock('resource1');
            await lockManager.acquireLock('resource2'); // fails
            await lockManager.acquireLock('resource3');
            const stats = lockManager.getStats();
            (0, globals_1.expect)(stats.acquisitionAttempts).toBe(3);
            (0, globals_1.expect)(stats.successfulAcquisitions).toBe(2);
            (0, globals_1.expect)(stats.failedAcquisitions).toBe(1);
        });
    });
    // ===========================================================================
    // isLocked Helper
    // ===========================================================================
    (0, globals_1.describe)('isLocked', () => {
        (0, globals_1.it)('should return true when lock exists', async () => {
            mockRedisClient.exists.mockResolvedValue(true);
            const locked = await lockManager.isLocked('test-resource');
            (0, globals_1.expect)(locked).toBe(true);
            (0, globals_1.expect)(mockRedisClient.exists).toHaveBeenCalledWith('lock:test-resource');
        });
        (0, globals_1.it)('should return false when lock does not exist', async () => {
            mockRedisClient.exists.mockResolvedValue(false);
            const locked = await lockManager.isLocked('test-resource');
            (0, globals_1.expect)(locked).toBe(false);
        });
    });
    // ===========================================================================
    // Force Release
    // ===========================================================================
    (0, globals_1.describe)('forceRelease', () => {
        (0, globals_1.it)('should force release lock regardless of owner', async () => {
            mockRedisClient.del.mockResolvedValue(1);
            const released = await lockManager.forceRelease('test-resource');
            (0, globals_1.expect)(released).toBe(true);
            (0, globals_1.expect)(mockRedisClient.del).toHaveBeenCalledWith('lock:test-resource');
        });
        (0, globals_1.it)('should return false if lock did not exist', async () => {
            mockRedisClient.del.mockResolvedValue(0);
            const released = await lockManager.forceRelease('test-resource');
            (0, globals_1.expect)(released).toBe(false);
        });
    });
    // ===========================================================================
    // Input Validation
    // ===========================================================================
    (0, globals_1.describe)('input validation', () => {
        (0, globals_1.it)('should reject empty resourceId', async () => {
            await (0, globals_1.expect)(lockManager.acquireLock('')).rejects.toThrow('Invalid resourceId');
        });
        (0, globals_1.it)('should reject resourceId with unsafe characters', async () => {
            await (0, globals_1.expect)(lockManager.acquireLock('test/resource')).rejects.toThrow('Invalid resourceId');
            await (0, globals_1.expect)(lockManager.acquireLock('test<script>')).rejects.toThrow('Invalid resourceId');
            await (0, globals_1.expect)(lockManager.acquireLock('test resource')).rejects.toThrow('Invalid resourceId');
        });
        (0, globals_1.it)('should accept valid resourceId characters', async () => {
            mockRedisClient.setNx.mockResolvedValue(true);
            // These should all be valid
            await (0, globals_1.expect)(lockManager.acquireLock('test-resource')).resolves.not.toThrow();
            await (0, globals_1.expect)(lockManager.acquireLock('test_resource')).resolves.not.toThrow();
            await (0, globals_1.expect)(lockManager.acquireLock('test:resource:123')).resolves.not.toThrow();
            await (0, globals_1.expect)(lockManager.acquireLock('TestResource123')).resolves.not.toThrow();
        });
        (0, globals_1.it)('should reject resourceId that is too long', async () => {
            const longId = 'a'.repeat(300);
            await (0, globals_1.expect)(lockManager.acquireLock(longId)).rejects.toThrow('Invalid resourceId');
        });
    });
    // ===========================================================================
    // Error Handling
    // ===========================================================================
    (0, globals_1.describe)('error handling', () => {
        (0, globals_1.it)('should throw if not initialized', async () => {
            const uninitializedManager = new distributed_lock_1.DistributedLockManager();
            await (0, globals_1.expect)(uninitializedManager.acquireLock('test')).rejects.toThrow('not initialized');
        });
        (0, globals_1.it)('should handle Redis errors during acquisition', async () => {
            mockRedisClient.setNx.mockRejectedValue(new Error('Redis connection failed'));
            await (0, globals_1.expect)(lockManager.acquireLock('test-resource')).rejects.toThrow('Redis connection failed');
        });
        (0, globals_1.it)('should handle Redis errors during release gracefully', async () => {
            mockRedisClient.setNx.mockResolvedValue(true);
            mockRedisClient.get.mockRejectedValue(new Error('Redis error'));
            const handle = await lockManager.acquireLock('test-resource');
            // Should not throw, just log error
            await (0, globals_1.expect)(handle.release()).resolves.not.toThrow();
        });
    });
    // ===========================================================================
    // Shutdown & Cleanup
    // ===========================================================================
    (0, globals_1.describe)('shutdown', () => {
        (0, globals_1.it)('should release all held locks on shutdown', async () => {
            mockRedisClient.setNx.mockResolvedValue(true);
            // Acquire multiple locks
            await lockManager.acquireLock('resource1');
            await lockManager.acquireLock('resource2');
            await lockManager.acquireLock('resource3');
            // Setup get to return correct values for release
            mockRedisClient.get.mockResolvedValue(null); // Simplified - any value triggers del attempt
            const heldKeys = lockManager.getHeldLockKeys();
            (0, globals_1.expect)(heldKeys).toHaveLength(3);
            await lockManager.shutdown();
            // All locks should be cleaned up from internal tracking
            (0, globals_1.expect)(lockManager.getHeldLockKeys()).toHaveLength(0);
        });
        (0, globals_1.it)('should clear auto-extend intervals on shutdown', async () => {
            const autoExtendManager = new distributed_lock_1.DistributedLockManager({
                autoExtend: true,
                autoExtendIntervalMs: 100
            });
            await autoExtendManager.initialize(mockRedisClient);
            mockRedisClient.setNx.mockResolvedValue(true);
            await autoExtendManager.acquireLock('test-resource');
            // Give it a moment to set up the interval
            await new Promise(resolve => setTimeout(resolve, 50));
            await autoExtendManager.shutdown();
            // Intervals should be cleared (no way to directly test, but no errors = success)
            (0, globals_1.expect)(autoExtendManager.getHeldLockKeys()).toHaveLength(0);
        });
    });
    // ===========================================================================
    // Singleton Factory
    // ===========================================================================
    (0, globals_1.describe)('singleton factory', () => {
        (0, globals_1.it)('should return same instance on multiple calls', async () => {
            const instance1 = await (0, distributed_lock_1.getDistributedLockManager)();
            const instance2 = await (0, distributed_lock_1.getDistributedLockManager)();
            (0, globals_1.expect)(instance1).toBe(instance2);
        });
        (0, globals_1.it)('should reset singleton properly', async () => {
            const instance1 = await (0, distributed_lock_1.getDistributedLockManager)();
            await (0, distributed_lock_1.resetDistributedLockManager)();
            const instance2 = await (0, distributed_lock_1.getDistributedLockManager)();
            (0, globals_1.expect)(instance1).not.toBe(instance2);
        });
    });
});
//# sourceMappingURL=distributed-lock.test.js.map