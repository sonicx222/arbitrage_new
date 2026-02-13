/**
 * NonceAllocationManager Unit Tests
 *
 * Tests per-chain mutex locking for nonce allocation to prevent race conditions.
 * Covers: lock acquisition, lock release, timeout behavior, concurrent access
 * detection, deadline-based retry logic, reset, and singleton management.
 *
 * P1 FIX #6: This test file fills a critical coverage gap — the
 * NonceAllocationManager had zero tests despite managing critical
 * per-chain nonce locking for financial transactions.
 *
 * @see services/execution-engine/src/services/nonce-allocation-manager.ts
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  NonceAllocationManager,
  getDefaultNonceAllocationManager,
  resetDefaultNonceAllocationManager,
  type NonceAllocationManagerConfig,
} from '../../../src/services/nonce-allocation-manager';
import { createMockLogger } from '@arbitrage/test-utils';

describe('NonceAllocationManager', () => {
  let manager: NonceAllocationManager;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
    manager = new NonceAllocationManager(logger);
  });

  afterEach(() => {
    manager.reset();
    resetDefaultNonceAllocationManager();
    jest.clearAllMocks();
  });

  // ===========================================================================
  // Lock Acquisition
  // ===========================================================================

  describe('acquireLock', () => {
    it('should acquire lock immediately when no lock exists', async () => {
      await manager.acquireLock('ethereum', 'opp-1');

      expect(manager.hasLock('ethereum')).toBe(true);
      expect(logger.debug).toHaveBeenCalledWith(
        '[NONCE_LOCK] Lock acquired',
        expect.objectContaining({ chain: 'ethereum', opportunityId: 'opp-1' })
      );
    });

    it('should acquire locks independently per chain', async () => {
      await manager.acquireLock('ethereum', 'opp-1');
      await manager.acquireLock('arbitrum', 'opp-2');

      expect(manager.hasLock('ethereum')).toBe(true);
      expect(manager.hasLock('arbitrum')).toBe(true);
    });

    it('should wait for existing lock and acquire after release', async () => {
      // Acquire first lock
      await manager.acquireLock('ethereum', 'opp-1');

      // Start waiting for lock (will resolve after release)
      const acquirePromise = manager.acquireLock('ethereum', 'opp-2');

      // Allow microtask to process
      await new Promise(resolve => setTimeout(resolve, 10));

      // Release first lock
      manager.releaseLock('ethereum', 'opp-1');

      // Second acquisition should now succeed
      await acquirePromise;
      expect(manager.hasLock('ethereum')).toBe(true);
    });

    it('should throw on timeout when lock is not released', async () => {
      // Acquire lock and never release
      await manager.acquireLock('ethereum', 'opp-1');

      // Try to acquire with short timeout
      await expect(
        manager.acquireLock('ethereum', 'opp-2', 50)
      ).rejects.toThrow('[ERR_NONCE_LOCK_TIMEOUT]');

      expect(logger.warn).toHaveBeenCalledWith(
        '[WARN_NONCE_LOCK_TIMEOUT] Timeout waiting for nonce lock',
        expect.objectContaining({ chain: 'ethereum', opportunityId: 'opp-2' })
      );
    });

    it('should use default timeout from config', async () => {
      const config: NonceAllocationManagerConfig = { defaultLockTimeoutMs: 100 };
      const customManager = new NonceAllocationManager(logger, config);

      await customManager.acquireLock('ethereum', 'opp-1');

      // Should timeout using config default (100ms)
      await expect(
        customManager.acquireLock('ethereum', 'opp-2')
      ).rejects.toThrow('[ERR_NONCE_LOCK_TIMEOUT]');

      customManager.reset();
    });

    it('should respect absolute deadline across retries', async () => {
      // This test verifies the absolute deadline fix (Issue 1.4)
      // Total timeout should not accumulate across retry attempts
      await manager.acquireLock('ethereum', 'opp-1');

      const startTime = Date.now();
      const timeoutMs = 200;

      await expect(
        manager.acquireLock('ethereum', 'opp-2', timeoutMs)
      ).rejects.toThrow('[ERR_NONCE_LOCK_TIMEOUT]');

      const elapsed = Date.now() - startTime;
      // Should timeout within a reasonable bound of the specified timeout
      // (not 2x or 3x from accumulated retries)
      expect(elapsed).toBeLessThan(timeoutMs + 200); // Allow 200ms jitter
    });
  });

  // ===========================================================================
  // Lock Release
  // ===========================================================================

  describe('releaseLock', () => {
    it('should release an acquired lock', async () => {
      await manager.acquireLock('ethereum', 'opp-1');
      expect(manager.hasLock('ethereum')).toBe(true);

      manager.releaseLock('ethereum', 'opp-1');
      expect(manager.hasLock('ethereum')).toBe(false);

      expect(logger.debug).toHaveBeenCalledWith(
        '[NONCE_LOCK] Lock released',
        expect.objectContaining({ chain: 'ethereum', opportunityId: 'opp-1' })
      );
    });

    it('should be a no-op when releasing non-existent lock', () => {
      // Should not throw
      manager.releaseLock('ethereum', 'opp-1');
      expect(manager.hasLock('ethereum')).toBe(false);
    });

    it('should only release lock for the specified chain', async () => {
      await manager.acquireLock('ethereum', 'opp-1');
      await manager.acquireLock('arbitrum', 'opp-2');

      manager.releaseLock('ethereum', 'opp-1');

      expect(manager.hasLock('ethereum')).toBe(false);
      expect(manager.hasLock('arbitrum')).toBe(true);

      manager.releaseLock('arbitrum', 'opp-2');
    });
  });

  // ===========================================================================
  // Concurrent Access Detection
  // ===========================================================================

  describe('checkConcurrentAccess', () => {
    it('should return false on first access for a chain', () => {
      const result = manager.checkConcurrentAccess('ethereum', 'opp-1');
      expect(result).toBe(false);
    });

    it('should return true when concurrent access detected', () => {
      manager.checkConcurrentAccess('ethereum', 'opp-1');
      const result = manager.checkConcurrentAccess('ethereum', 'opp-2');

      expect(result).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        '[WARN_RACE_CONDITION] Concurrent nonce access detected despite locking',
        expect.objectContaining({
          chain: 'ethereum',
          opportunityId: 'opp-2',
          concurrentOpportunities: ['opp-1'],
        })
      );
    });

    it('should track multiple concurrent accesses', () => {
      manager.checkConcurrentAccess('ethereum', 'opp-1');
      manager.checkConcurrentAccess('ethereum', 'opp-2');
      const result = manager.checkConcurrentAccess('ethereum', 'opp-3');

      expect(result).toBe(true);
      expect(manager.getInProgressCount('ethereum')).toBe(3);
    });

    it('should track chains independently', () => {
      manager.checkConcurrentAccess('ethereum', 'opp-1');
      const ethResult = manager.checkConcurrentAccess('ethereum', 'opp-2');
      const arbResult = manager.checkConcurrentAccess('arbitrum', 'opp-3');

      expect(ethResult).toBe(true); // ethereum has concurrent
      expect(arbResult).toBe(false); // arbitrum is first
    });
  });

  // ===========================================================================
  // Clear Tracking
  // ===========================================================================

  describe('clearTracking', () => {
    it('should remove opportunity from in-progress set', () => {
      manager.checkConcurrentAccess('ethereum', 'opp-1');
      expect(manager.getInProgressCount('ethereum')).toBe(1);

      manager.clearTracking('ethereum', 'opp-1');
      expect(manager.getInProgressCount('ethereum')).toBe(0);
    });

    it('should clean up chain entry when set becomes empty', () => {
      manager.checkConcurrentAccess('ethereum', 'opp-1');
      manager.clearTracking('ethereum', 'opp-1');

      // After clearing, getInProgressCount should return 0 (from ?? 0 fallback)
      expect(manager.getInProgressCount('ethereum')).toBe(0);
    });

    it('should be a no-op for non-tracked chain', () => {
      // Should not throw
      manager.clearTracking('polygon', 'opp-1');
    });

    it('should not affect other opportunities on same chain', () => {
      manager.checkConcurrentAccess('ethereum', 'opp-1');
      manager.checkConcurrentAccess('ethereum', 'opp-2');

      manager.clearTracking('ethereum', 'opp-1');
      expect(manager.getInProgressCount('ethereum')).toBe(1);
    });
  });

  // ===========================================================================
  // hasLock & getInProgressCount
  // ===========================================================================

  describe('hasLock', () => {
    it('should return false for chain with no lock', () => {
      expect(manager.hasLock('ethereum')).toBe(false);
    });

    it('should return true after lock acquired', async () => {
      await manager.acquireLock('ethereum', 'opp-1');
      expect(manager.hasLock('ethereum')).toBe(true);
    });

    it('should return false after lock released', async () => {
      await manager.acquireLock('ethereum', 'opp-1');
      manager.releaseLock('ethereum', 'opp-1');
      expect(manager.hasLock('ethereum')).toBe(false);
    });
  });

  describe('getInProgressCount', () => {
    it('should return 0 for chain with no tracking', () => {
      expect(manager.getInProgressCount('ethereum')).toBe(0);
    });

    it('should return count of tracked opportunities', () => {
      manager.checkConcurrentAccess('ethereum', 'opp-1');
      manager.checkConcurrentAccess('ethereum', 'opp-2');
      expect(manager.getInProgressCount('ethereum')).toBe(2);
    });
  });

  // ===========================================================================
  // Reset
  // ===========================================================================

  describe('reset', () => {
    it('should clear all locks', async () => {
      await manager.acquireLock('ethereum', 'opp-1');
      await manager.acquireLock('arbitrum', 'opp-2');

      manager.reset();

      expect(manager.hasLock('ethereum')).toBe(false);
      expect(manager.hasLock('arbitrum')).toBe(false);
    });

    it('should clear all in-progress tracking', () => {
      manager.checkConcurrentAccess('ethereum', 'opp-1');
      manager.checkConcurrentAccess('arbitrum', 'opp-2');

      manager.reset();

      expect(manager.getInProgressCount('ethereum')).toBe(0);
      expect(manager.getInProgressCount('arbitrum')).toBe(0);
    });

    it('should resolve pending lock waiters on reset', async () => {
      await manager.acquireLock('ethereum', 'opp-1');

      // Start a waiter that will be resolved by reset
      const acquirePromise = manager.acquireLock('ethereum', 'opp-2', 5000);

      // Give time for waiter to register
      await new Promise(resolve => setTimeout(resolve, 10));

      // Reset resolves all pending lock promises
      manager.reset();

      // The waiter should resolve (lock promise resolved), then re-check
      // and find no lock exists, so it acquires the lock
      await acquirePromise;
    });
  });

  // ===========================================================================
  // Acquire-Release Lifecycle
  // ===========================================================================

  describe('acquire-release lifecycle', () => {
    it('should support sequential acquire-release cycles', async () => {
      for (let i = 0; i < 5; i++) {
        await manager.acquireLock('ethereum', `opp-${i}`);
        expect(manager.hasLock('ethereum')).toBe(true);
        manager.releaseLock('ethereum', `opp-${i}`);
        expect(manager.hasLock('ethereum')).toBe(false);
      }
    });

    it('should support rapid acquire-release across chains', async () => {
      const chains = ['ethereum', 'arbitrum', 'base', 'polygon'];

      // Acquire all
      for (const chain of chains) {
        await manager.acquireLock(chain, `opp-${chain}`);
      }

      // Verify all locked
      for (const chain of chains) {
        expect(manager.hasLock(chain)).toBe(true);
      }

      // Release all
      for (const chain of chains) {
        manager.releaseLock(chain, `opp-${chain}`);
      }

      // Verify all released
      for (const chain of chains) {
        expect(manager.hasLock(chain)).toBe(false);
      }
    });
  });

  // ===========================================================================
  // Singleton Management
  // ===========================================================================

  describe('getDefaultNonceAllocationManager', () => {
    afterEach(() => {
      resetDefaultNonceAllocationManager();
    });

    it('should create singleton on first call', () => {
      const instance = getDefaultNonceAllocationManager(logger);
      expect(instance).toBeInstanceOf(NonceAllocationManager);
    });

    it('should return same instance on repeated calls', () => {
      const instance1 = getDefaultNonceAllocationManager(logger);
      const instance2 = getDefaultNonceAllocationManager();
      expect(instance1).toBe(instance2);
    });

    it('should throw if logger not provided on first call', () => {
      expect(() => getDefaultNonceAllocationManager()).toThrow(
        'Logger required for first NonceAllocationManager initialization'
      );
    });

    it('should return new instance after reset', () => {
      const instance1 = getDefaultNonceAllocationManager(logger);
      resetDefaultNonceAllocationManager();
      const instance2 = getDefaultNonceAllocationManager(logger);
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('resetDefaultNonceAllocationManager', () => {
    it('should be a no-op when no singleton exists', () => {
      // Should not throw
      resetDefaultNonceAllocationManager();
    });

    it('should reset locks on the singleton', async () => {
      const instance = getDefaultNonceAllocationManager(logger);
      await instance.acquireLock('ethereum', 'opp-1');

      resetDefaultNonceAllocationManager();

      // New instance should have no locks
      const newInstance = getDefaultNonceAllocationManager(logger);
      expect(newInstance.hasLock('ethereum')).toBe(false);
    });
  });
});
