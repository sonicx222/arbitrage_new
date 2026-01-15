/**
 * Distributed Lock Manager Tests
 *
 * Tests for atomic distributed locking with Redis SETNX.
 * Covers race conditions, TTL expiration, and error handling.
 *
 * @migrated from shared/core/src/distributed-lock.test.ts
 * @see ADR-009: Test Architecture
 */

import { jest, describe, it, expect, beforeEach, afterEach, beforeAll } from '@jest/globals';
import type { Mock } from 'jest-mock';

// Mock Redis client interface
interface MockRedisClient {
  setNx: Mock<(key: string, value: string, ttl: number) => Promise<boolean>>;
  get: Mock<(key: string) => Promise<string | null>>;
  del: Mock<(key: string) => Promise<number>>;
  expire: Mock<(key: string, ttl: number) => Promise<number>>;
  eval: Mock<(script: string, keys: string[], args: string[]) => Promise<number>>;
  exists: Mock<(key: string) => Promise<boolean>>;
  ping: Mock<() => Promise<boolean>>;
}

// Mock Redis client - created as a factory to avoid hoisting issues
const createMockRedisClient = (): MockRedisClient => ({
  setNx: jest.fn<(key: string, value: string, ttl: number) => Promise<boolean>>(),
  get: jest.fn<(key: string) => Promise<string | null>>(),
  del: jest.fn<(key: string) => Promise<number>>(),
  expire: jest.fn<(key: string, ttl: number) => Promise<number>>(),
  eval: jest.fn<(script: string, keys: string[], args: string[]) => Promise<number>>(),
  exists: jest.fn<(key: string) => Promise<boolean>>(),
  ping: jest.fn<() => Promise<boolean>>().mockResolvedValue(true)
});

// Shared mock reference - initialized in beforeEach
let mockRedisClient: MockRedisClient;

// Create mock logger factory
const createMockLogger = () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
});

// Import directly from source
import {
  DistributedLockManager,
  getDistributedLockManager,
  resetDistributedLockManager
} from '../../src/distributed-lock';
import type { LockConfig } from '../../src/distributed-lock';

describe('DistributedLockManager', () => {
  let lockManager: DistributedLockManager;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(async () => {
    jest.clearAllMocks();
    await resetDistributedLockManager();

    // Create fresh mocks for each test
    mockRedisClient = createMockRedisClient();
    mockLogger = createMockLogger();

    // Default mock implementations
    mockRedisClient.setNx.mockResolvedValue(true);
    mockRedisClient.get.mockResolvedValue(null);
    mockRedisClient.del.mockResolvedValue(1);
    mockRedisClient.expire.mockResolvedValue(1);
    mockRedisClient.exists.mockResolvedValue(false);

    // Create lock manager with injected mock logger
    lockManager = new DistributedLockManager({ logger: mockLogger });
    await lockManager.initialize(mockRedisClient as any);
  });

  afterEach(async () => {
    await lockManager.shutdown();
  });

  // ===========================================================================
  // Basic Lock Operations
  // ===========================================================================

  describe('basic lock operations', () => {
    it('should acquire lock when available', async () => {
      mockRedisClient.setNx.mockResolvedValue(true);

      const handle = await lockManager.acquireLock('test-resource');

      expect(handle.acquired).toBe(true);
      expect(handle.key).toBe('lock:test-resource');
      expect(mockRedisClient.setNx).toHaveBeenCalledWith(
        'lock:test-resource',
        expect.any(String),
        30 // default TTL in seconds
      );
    });

    it('should fail to acquire lock when already held', async () => {
      mockRedisClient.setNx.mockResolvedValue(false);

      const handle = await lockManager.acquireLock('test-resource');

      expect(handle.acquired).toBe(false);
      expect(handle.key).toBeUndefined();
    });

    it('should release lock successfully', async () => {
      mockRedisClient.setNx.mockResolvedValue(true);

      const handle = await lockManager.acquireLock('test-resource');
      expect(handle.acquired).toBe(true);

      // Mock eval to return 1 (lock deleted)
      mockRedisClient.eval.mockResolvedValue(1);

      // Get the lock value that was set
      const lockValue = (mockRedisClient.setNx as jest.Mock).mock.calls[0][1] as string;

      await handle.release();

      // Should use atomic Lua script via eval instead of del
      expect(mockRedisClient.eval).toHaveBeenCalledWith(
        expect.stringContaining('redis.call("get"'),
        ['lock:test-resource'],
        [lockValue]
      );
    });

    it('should not release lock if not owner', async () => {
      mockRedisClient.setNx.mockResolvedValue(true);

      const handle = await lockManager.acquireLock('test-resource');
      expect(handle.acquired).toBe(true);

      // Mock eval to return 0 (lock not deleted - someone else owns it)
      // The atomic Lua script checks ownership internally
      mockRedisClient.eval.mockResolvedValue(0);

      await handle.release();

      // Should still call eval (which atomically checks ownership and skips delete)
      expect(mockRedisClient.eval).toHaveBeenCalled();
    });

    it('should use custom TTL when provided', async () => {
      mockRedisClient.setNx.mockResolvedValue(true);

      await lockManager.acquireLock('test-resource', { ttlMs: 60000 });

      expect(mockRedisClient.setNx).toHaveBeenCalledWith(
        'lock:test-resource',
        expect.any(String),
        60 // 60000ms = 60s
      );
    });

    it('should use custom key prefix', async () => {
      const customManager = new DistributedLockManager({ keyPrefix: 'myapp:locks:', logger: mockLogger });
      await customManager.initialize(mockRedisClient as any);
      mockRedisClient.setNx.mockResolvedValue(true);

      await customManager.acquireLock('test-resource');

      expect(mockRedisClient.setNx).toHaveBeenCalledWith(
        'myapp:locks:test-resource',
        expect.any(String),
        expect.any(Number)
      );

      await customManager.shutdown();
    });
  });

  // ===========================================================================
  // Retry Behavior
  // ===========================================================================

  describe('retry behavior', () => {
    it('should retry acquisition when configured', async () => {
      // First two attempts fail, third succeeds
      mockRedisClient.setNx
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      const handle = await lockManager.acquireLock('test-resource', {
        retries: 3,
        retryDelayMs: 10
      });

      expect(handle.acquired).toBe(true);
      expect(mockRedisClient.setNx).toHaveBeenCalledTimes(3);
    });

    it('should fail after exhausting retries', async () => {
      mockRedisClient.setNx.mockResolvedValue(false);

      const handle = await lockManager.acquireLock('test-resource', {
        retries: 2,
        retryDelayMs: 10
      });

      expect(handle.acquired).toBe(false);
      expect(mockRedisClient.setNx).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it('should use exponential backoff when configured', async () => {
      mockRedisClient.setNx.mockResolvedValue(false);

      const startTime = Date.now();
      await lockManager.acquireLock('test-resource', {
        retries: 3,
        retryDelayMs: 50,
        exponentialBackoff: true
      });
      const elapsed = Date.now() - startTime;

      // With exponential backoff: 50 + 100 + 200 = 350ms minimum
      expect(elapsed).toBeGreaterThanOrEqual(300); // Some tolerance
    });

    it('should respect maxRetryDelayMs with exponential backoff', async () => {
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
      expect(elapsed).toBeLessThan(1000);
    });
  });

  // ===========================================================================
  // Lock Extension
  // ===========================================================================

  describe('lock extension', () => {
    it('should extend lock TTL when owner', async () => {
      mockRedisClient.setNx.mockResolvedValue(true);

      const handle = await lockManager.acquireLock('test-resource');
      expect(handle.acquired).toBe(true);

      // Get the lock value that was set
      const lockValue = (mockRedisClient.setNx as jest.Mock).mock.calls[0][1] as string;
      // Mock eval to return 1 (successfully extended)
      mockRedisClient.eval.mockResolvedValue(1);

      const extended = await handle.extend(60000);

      expect(extended).toBe(true);
      // Should use atomic Lua script via eval instead of expire
      expect(mockRedisClient.eval).toHaveBeenCalledWith(
        expect.stringContaining('redis.call("expire"'),
        ['lock:test-resource'],
        [lockValue, '60']
      );
    });

    it('should fail to extend lock when not owner', async () => {
      mockRedisClient.setNx.mockResolvedValue(true);

      const handle = await lockManager.acquireLock('test-resource');
      expect(handle.acquired).toBe(true);

      // Mock eval to return 0 (not owner - extend failed)
      mockRedisClient.eval.mockResolvedValue(0);

      const extended = await handle.extend(60000);

      expect(extended).toBe(false);
      // Eval is still called, but returns 0 to indicate failure
      expect(mockRedisClient.eval).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // withLock Convenience Method
  // ===========================================================================

  describe('withLock', () => {
    it('should execute function while holding lock', async () => {
      mockRedisClient.setNx.mockResolvedValue(true);
      const lockValue = 'test-lock-value';
      mockRedisClient.get.mockResolvedValue(lockValue);

      let executed = false;
      const result = await lockManager.withLock('test-resource', async () => {
        executed = true;
        return 'success';
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toBe('success');
      }
      expect(executed).toBe(true);
    });

    it('should return failure when lock not acquired', async () => {
      mockRedisClient.setNx.mockResolvedValue(false);

      let executed = false;
      const result = await lockManager.withLock('test-resource', async () => {
        executed = true;
        return 'success';
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('lock_not_acquired');
      }
      expect(executed).toBe(false);
    });

    it('should release lock even on function error', async () => {
      mockRedisClient.setNx.mockResolvedValue(true);

      // Need to capture the actual lock value used
      let capturedLockValue: string | undefined;
      mockRedisClient.setNx.mockImplementation(async (_key: string, value: string, _ttl: number) => {
        capturedLockValue = value;
        return true;
      });

      // Mock eval to return 1 (lock released successfully)
      mockRedisClient.eval.mockResolvedValue(1);

      const result = await lockManager.withLock('test-resource', async () => {
        throw new Error('Test error');
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('execution_error');
        expect(result.error?.message).toBe('Test error');
      }

      // Lock should still be released via atomic Lua script
      expect(mockRedisClient.eval).toHaveBeenCalled();
    });

    it('should pass through acquisition options', async () => {
      mockRedisClient.setNx.mockResolvedValue(true);

      await lockManager.withLock('test-resource', async () => 'result', {
        ttlMs: 60000,
        retries: 3
      });

      expect(mockRedisClient.setNx).toHaveBeenCalledWith(
        'lock:test-resource',
        expect.any(String),
        60
      );
    });
  });

  // ===========================================================================
  // Concurrent Lock Acquisition (Race Condition Prevention)
  // ===========================================================================

  describe('concurrent lock acquisition', () => {
    it('should only allow one acquisition when racing', async () => {
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
      expect(acquiredCount).toBe(1);
    });

    it('should track concurrent lock statistics', async () => {
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
      expect(stats.acquisitionAttempts).toBe(3);
      expect(stats.successfulAcquisitions).toBe(2);
      expect(stats.failedAcquisitions).toBe(1);
    });
  });

  // ===========================================================================
  // isLocked Helper
  // ===========================================================================

  describe('isLocked', () => {
    it('should return true when lock exists', async () => {
      mockRedisClient.exists.mockResolvedValue(true);

      const locked = await lockManager.isLocked('test-resource');

      expect(locked).toBe(true);
      expect(mockRedisClient.exists).toHaveBeenCalledWith('lock:test-resource');
    });

    it('should return false when lock does not exist', async () => {
      mockRedisClient.exists.mockResolvedValue(false);

      const locked = await lockManager.isLocked('test-resource');

      expect(locked).toBe(false);
    });
  });

  // ===========================================================================
  // Force Release
  // ===========================================================================

  describe('forceRelease', () => {
    it('should force release lock regardless of owner', async () => {
      mockRedisClient.del.mockResolvedValue(1);

      const released = await lockManager.forceRelease('test-resource');

      expect(released).toBe(true);
      expect(mockRedisClient.del).toHaveBeenCalledWith('lock:test-resource');
    });

    it('should return false if lock did not exist', async () => {
      mockRedisClient.del.mockResolvedValue(0);

      const released = await lockManager.forceRelease('test-resource');

      expect(released).toBe(false);
    });
  });

  // ===========================================================================
  // Input Validation
  // ===========================================================================

  describe('input validation', () => {
    it('should reject empty resourceId', async () => {
      await expect(lockManager.acquireLock('')).rejects.toThrow('Invalid resourceId');
    });

    it('should reject resourceId with unsafe characters', async () => {
      await expect(lockManager.acquireLock('test/resource')).rejects.toThrow('Invalid resourceId');
      await expect(lockManager.acquireLock('test<script>')).rejects.toThrow('Invalid resourceId');
      await expect(lockManager.acquireLock('test resource')).rejects.toThrow('Invalid resourceId');
    });

    it('should accept valid resourceId characters', async () => {
      mockRedisClient.setNx.mockResolvedValue(true);

      // These should all be valid
      await expect(lockManager.acquireLock('test-resource')).resolves.not.toThrow();
      await expect(lockManager.acquireLock('test_resource')).resolves.not.toThrow();
      await expect(lockManager.acquireLock('test:resource:123')).resolves.not.toThrow();
      await expect(lockManager.acquireLock('TestResource123')).resolves.not.toThrow();
    });

    it('should reject resourceId that is too long', async () => {
      const longId = 'a'.repeat(300);
      await expect(lockManager.acquireLock(longId)).rejects.toThrow('Invalid resourceId');
    });
  });

  // ===========================================================================
  // Error Handling
  // ===========================================================================

  describe('error handling', () => {
    it('should throw if not initialized', async () => {
      const uninitializedManager = new DistributedLockManager({ logger: mockLogger });

      await expect(uninitializedManager.acquireLock('test')).rejects.toThrow('not initialized');
    });

    it('should handle Redis errors during acquisition', async () => {
      mockRedisClient.setNx.mockRejectedValue(new Error('Redis connection failed'));

      await expect(lockManager.acquireLock('test-resource')).rejects.toThrow('Redis connection failed');
    });

    it('should handle Redis errors during release gracefully', async () => {
      mockRedisClient.setNx.mockResolvedValue(true);
      mockRedisClient.get.mockRejectedValue(new Error('Redis error'));

      const handle = await lockManager.acquireLock('test-resource');

      // Should not throw, just log error
      await expect(handle.release()).resolves.not.toThrow();
    });
  });

  // ===========================================================================
  // Shutdown & Cleanup
  // ===========================================================================

  describe('shutdown', () => {
    it('should release all held locks on shutdown', async () => {
      mockRedisClient.setNx.mockResolvedValue(true);

      // Acquire multiple locks
      await lockManager.acquireLock('resource1');
      await lockManager.acquireLock('resource2');
      await lockManager.acquireLock('resource3');

      // Setup get to return correct values for release
      mockRedisClient.get.mockResolvedValue(null); // Simplified - any value triggers del attempt

      const heldKeys = lockManager.getHeldLockKeys();
      expect(heldKeys).toHaveLength(3);

      await lockManager.shutdown();

      // All locks should be cleaned up from internal tracking
      expect(lockManager.getHeldLockKeys()).toHaveLength(0);
    });

    it('should clear auto-extend intervals on shutdown', async () => {
      const autoExtendManager = new DistributedLockManager({
        autoExtend: true,
        autoExtendIntervalMs: 100,
        logger: mockLogger
      });
      await autoExtendManager.initialize(mockRedisClient as any);

      mockRedisClient.setNx.mockResolvedValue(true);
      await autoExtendManager.acquireLock('test-resource');

      // Give it a moment to set up the interval
      await new Promise(resolve => setTimeout(resolve, 50));

      await autoExtendManager.shutdown();

      // Intervals should be cleared (no way to directly test, but no errors = success)
      expect(autoExtendManager.getHeldLockKeys()).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Singleton Factory
  // ===========================================================================

  describe('singleton factory', () => {
    it('should return same instance on multiple calls', async () => {
      const instance1 = await getDistributedLockManager();
      const instance2 = await getDistributedLockManager();

      expect(instance1).toBe(instance2);
    });

    it('should reset singleton properly', async () => {
      const instance1 = await getDistributedLockManager();
      await resetDistributedLockManager();
      const instance2 = await getDistributedLockManager();

      expect(instance1).not.toBe(instance2);
    });
  });

  // ===========================================================================
  // P0-3: Redis Error vs Lock Not Acquired (Silent Failure Prevention)
  // ===========================================================================

  describe('P0-3: Redis error vs lock not acquired distinction', () => {
    it('should return redis_error reason when Redis throws during acquisition', async () => {
      // P0-3 FIX: setNx now throws on Redis errors instead of returning false
      mockRedisClient.setNx.mockRejectedValue(new Error('Redis connection failed'));

      const result = await lockManager.withLock('test-resource', async () => {
        return 'should not execute';
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('redis_error');
        expect(result.error?.message).toContain('Redis connection failed');
      }
    });

    it('should return lock_not_acquired when lock is held by another (not error)', async () => {
      // Lock is held by another process - setNx returns false, not throws
      mockRedisClient.setNx.mockResolvedValue(false);

      const result = await lockManager.withLock('test-resource', async () => {
        return 'should not execute';
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('lock_not_acquired');
        // No error object for this case - it's expected behavior
      }
    });

    it('should distinguish timeout errors from lock contention', async () => {
      // Network timeout is a Redis error, not lock contention
      mockRedisClient.setNx.mockRejectedValue(new Error('ETIMEDOUT: Connection timed out'));

      const result = await lockManager.withLock('test-resource', async () => {
        return 'should not execute';
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('redis_error');
        expect(result.error?.message).toContain('ETIMEDOUT');
      }
    });

    it('should still return execution_error for function failures', async () => {
      mockRedisClient.setNx.mockResolvedValue(true);
      mockRedisClient.eval.mockResolvedValue(1); // For release

      const result = await lockManager.withLock('test-resource', async () => {
        throw new Error('Business logic failed');
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('execution_error');
        expect(result.error?.message).toBe('Business logic failed');
      }
    });

    it('should propagate Redis errors during retry attempts', async () => {
      // First attempt: Redis error
      // Second attempt: Redis error
      // Both should be treated as errors, not as lock contention
      mockRedisClient.setNx
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockRejectedValueOnce(new Error('Connection refused'));

      await expect(lockManager.acquireLock('test-resource', {
        retries: 1,
        retryDelayMs: 10
      })).rejects.toThrow('Connection refused');
    });
  });
});
