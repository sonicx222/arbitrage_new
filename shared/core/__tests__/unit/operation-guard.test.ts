/**
 * P1-5 FIX: OperationGuard Tests
 *
 * Tests for the OperationGuard utility that provides skip-if-busy
 * and rate limiting patterns for async operations.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  OperationGuard,
  tryWithGuard,
  tryWithGuardSync
} from '../../src/async/operation-guard';

describe('OperationGuard', () => {
  describe('skip-if-busy pattern', () => {
    let guard: OperationGuard;

    beforeEach(() => {
      guard = new OperationGuard('test');
    });

    it('should acquire successfully when not locked', () => {
      const release = guard.tryAcquire();
      expect(release).not.toBeNull();
      expect(guard.isLocked()).toBe(true);
    });

    it('should reject when already locked', () => {
      const release1 = guard.tryAcquire();
      expect(release1).not.toBeNull();

      const release2 = guard.tryAcquire();
      expect(release2).toBeNull();
    });

    it('should unlock after release', () => {
      const release = guard.tryAcquire();
      expect(release).not.toBeNull();
      expect(guard.isLocked()).toBe(true);

      release!();
      expect(guard.isLocked()).toBe(false);

      // Should be able to acquire again
      const release2 = guard.tryAcquire();
      expect(release2).not.toBeNull();
    });

    it('should prevent double-release', () => {
      const release = guard.tryAcquire();
      release!();
      release!(); // Should be safe to call again

      expect(guard.isLocked()).toBe(false);
    });

    it('should track stats correctly', () => {
      const release1 = guard.tryAcquire();
      guard.tryAcquire(); // Rejected
      release1!();
      guard.tryAcquire();
      guard.tryAcquire(); // Rejected

      const stats = guard.getStats();
      expect(stats.acquireCount).toBe(2);
      expect(stats.rejectionCount).toBe(2);
      expect(stats.busyRejections).toBe(2);
    });
  });

  describe('rate limiting pattern', () => {
    let guard: OperationGuard;

    beforeEach(() => {
      guard = new OperationGuard('rate-limited', { cooldownMs: 100 });
    });

    it('should apply cooldown between acquisitions', async () => {
      const release1 = guard.tryAcquire();
      expect(release1).not.toBeNull();
      release1!();

      // Immediately try again - should fail due to cooldown
      const release2 = guard.tryAcquire();
      expect(release2).toBeNull();
      expect(guard.isRateLimited()).toBe(true);

      // Wait for cooldown
      await new Promise(resolve => setTimeout(resolve, 110));

      // Now should work
      const release3 = guard.tryAcquire();
      expect(release3).not.toBeNull();
    });

    it('should track rate limit rejections', async () => {
      const release1 = guard.tryAcquire();
      release1!();

      guard.tryAcquire(); // Rate limited

      const stats = guard.getStats();
      expect(stats.rateLimitRejections).toBe(1);
    });

    it('should report remaining cooldown time', async () => {
      guard.tryAcquire()!();

      const remaining = guard.getRemainingCooldownMs();
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(100);
    });
  });

  describe('forceRelease', () => {
    it('should release even when locked', () => {
      const guard = new OperationGuard('test');
      guard.tryAcquire();
      expect(guard.isLocked()).toBe(true);

      guard.forceRelease();
      expect(guard.isLocked()).toBe(false);
    });
  });

  describe('tryWithGuard helper', () => {
    it('should execute function when guard available', async () => {
      const guard = new OperationGuard('test');
      let executed = false;

      const result = await tryWithGuard(guard, async () => {
        executed = true;
        return 42;
      });

      expect(executed).toBe(true);
      expect(result).toBe(42);
      expect(guard.isLocked()).toBe(false);
    });

    it('should return null when guard busy', async () => {
      const guard = new OperationGuard('test');
      guard.tryAcquire(); // Lock the guard

      const result = await tryWithGuard(guard, async () => {
        return 42;
      });

      expect(result).toBeNull();
    });

    it('should release guard on error', async () => {
      const guard = new OperationGuard('test');

      await expect(tryWithGuard(guard, async () => {
        throw new Error('test error');
      })).rejects.toThrow('test error');

      expect(guard.isLocked()).toBe(false);
    });
  });

  describe('tryWithGuardSync helper', () => {
    it('should execute sync function when guard available', () => {
      const guard = new OperationGuard('test');

      const result = tryWithGuardSync(guard, () => 42);

      expect(result).toBe(42);
      expect(guard.isLocked()).toBe(false);
    });

    it('should return null when guard busy', () => {
      const guard = new OperationGuard('test');
      guard.tryAcquire();

      const result = tryWithGuardSync(guard, () => 42);

      expect(result).toBeNull();
    });

    it('should release guard on sync error', () => {
      const guard = new OperationGuard('test');

      expect(() => tryWithGuardSync(guard, () => {
        throw new Error('sync error');
      })).toThrow('sync error');

      expect(guard.isLocked()).toBe(false);
    });
  });

  describe('getName', () => {
    it('should return guard name', () => {
      const guard = new OperationGuard('my-operation');
      expect(guard.getName()).toBe('my-operation');
    });
  });

  describe('resetStats', () => {
    it('should reset statistics', () => {
      const guard = new OperationGuard('test');
      guard.tryAcquire()!();
      guard.tryAcquire();
      guard.tryAcquire(); // Rejected

      guard.resetStats();

      const stats = guard.getStats();
      expect(stats.acquireCount).toBe(0);
      expect(stats.rejectionCount).toBe(0);
    });
  });
});
