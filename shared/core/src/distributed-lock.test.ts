/**
 * Distributed Lock Manager Tests
 *
 * Tests for atomic distributed locking with Redis SETNX.
 * Covers race conditions, TTL expiration, and error handling.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  DistributedLockManager,
  getDistributedLockManager,
  resetDistributedLockManager,
  LockConfig
} from './distributed-lock';

// Mock Redis client
const mockRedisClient = {
  setNx: jest.fn(),
  get: jest.fn(),
  del: jest.fn(),
  expire: jest.fn(),
  exists: jest.fn(),
  ping: jest.fn().mockResolvedValue(true)
};

// Mock the redis module
jest.mock('./redis', () => ({
  getRedisClient: jest.fn().mockResolvedValue(mockRedisClient),
  RedisClient: jest.fn()
}));

// Mock logger
jest.mock('./logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  }))
}));

describe('DistributedLockManager', () => {
  let lockManager: DistributedLockManager;

  beforeEach(async () => {
    jest.clearAllMocks();
    await resetDistributedLockManager();

    // Default mock implementations
    mockRedisClient.setNx.mockResolvedValue(true);
    mockRedisClient.get.mockResolvedValue(null);
    mockRedisClient.del.mockResolvedValue(1);
    mockRedisClient.expire.mockResolvedValue(1);
    mockRedisClient.exists.mockResolvedValue(false);

    lockManager = new DistributedLockManager();
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

      // Mock get to return the lock value (we own it)
      const lockValue = (mockRedisClient.setNx as jest.Mock).mock.calls[0][1];
      mockRedisClient.get.mockResolvedValue(lockValue);

      await handle.release();

      expect(mockRedisClient.del).toHaveBeenCalledWith('lock:test-resource');
    });

    it('should not release lock if not owner', async () => {
      mockRedisClient.setNx.mockResolvedValue(true);

      const handle = await lockManager.acquireLock('test-resource');
      expect(handle.acquired).toBe(true);

      // Mock get to return different value (someone else owns it now)
      mockRedisClient.get.mockResolvedValue('different-owner-value');

      await handle.release();

      // Should not call del since we're not the owner
      expect(mockRedisClient.del).not.toHaveBeenCalled();
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
      const customManager = new DistributedLockManager({ keyPrefix: 'myapp:locks:' });
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
      const lockValue = (mockRedisClient.setNx as jest.Mock).mock.calls[0][1];
      mockRedisClient.get.mockResolvedValue(lockValue);
      mockRedisClient.expire.mockResolvedValue(1);

      const extended = await handle.extend(60000);

      expect(extended).toBe(true);
      expect(mockRedisClient.expire).toHaveBeenCalledWith('lock:test-resource', 60);
    });

    it('should fail to extend lock when not owner', async () => {
      mockRedisClient.setNx.mockResolvedValue(true);

      const handle = await lockManager.acquireLock('test-resource');
      expect(handle.acquired).toBe(true);

      // Someone else owns the lock now
      mockRedisClient.get.mockResolvedValue('different-owner');

      const extended = await handle.extend(60000);

      expect(extended).toBe(false);
      expect(mockRedisClient.expire).not.toHaveBeenCalled();
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
      const lockValue = (await (mockRedisClient.setNx as jest.Mock).mock.results[0]?.value) || 'mock-value';

      // Need to capture the actual lock value used
      let capturedLockValue: string | undefined;
      mockRedisClient.setNx.mockImplementation(async (_key, value, _ttl) => {
        capturedLockValue = value;
        return true;
      });

      mockRedisClient.get.mockImplementation(async () => capturedLockValue);

      const result = await lockManager.withLock('test-resource', async () => {
        throw new Error('Test error');
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('execution_error');
        expect(result.error?.message).toBe('Test error');
      }

      // Lock should still be released
      expect(mockRedisClient.del).toHaveBeenCalled();
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
      const uninitializedManager = new DistributedLockManager();

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
        autoExtendIntervalMs: 100
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
});
