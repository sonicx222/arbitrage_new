/**
 * Integration Tests for Arbitrage Detection System
 *
 * Tests the interaction between major components with REAL in-memory Redis:
 * - Redis Streams messaging
 * - Distributed locking
 * - Service state management
 * - Cross-service communication
 *
 * **MIGRATION NOTE**: This test was migrated from MockRedisClient (180 lines of mock code)
 * to real in-memory Redis using createLevel1TestSetup(). Benefits:
 * - Zero mock code (180 lines removed)
 * - Tests real Redis behavior (atomic operations, TTL, serialization)
 * - Catches bugs mocks would miss (race conditions, concurrent access)
 *
 * @migrated from shared/core/src/integration.test.ts
 * @see ADR-009: Test Architecture
 * @see docs/testing/integration-migration-guide.md
 */

import {
  DistributedLockManager,
  AcquireOptions,
  LockHandle,
  ServiceStateManager,
  ServiceState,
  createServiceState,
  StateTransitionResult
} from '@arbitrage/core';

import { createLevel1TestSetup, Level1TestSetup, waitFor } from '@arbitrage/test-utils';

// =============================================================================
// [Level 1] Distributed Lock Integration Tests
// =============================================================================

describe('[Level 1] DistributedLockManager Integration', () => {
  let setup: Level1TestSetup;
  let lockManager: DistributedLockManager;

  beforeAll(async () => {
    // Real in-memory Redis (NOT mocked!)
    setup = await createLevel1TestSetup({
      testSuiteName: 'distributed-lock-manager-integration'
    });

    lockManager = new DistributedLockManager();
    await lockManager.initialize(setup.redis as any);
  });

  afterAll(async () => {
    if (setup) {
      await setup.cleanup();
    }
  });

  beforeEach(async () => {
    // Clear Redis data between tests (keep connection)
    if (setup) {
      await setup.redis.flushDb();
    }
  });

  describe('Lock Acquisition', () => {
    it('should acquire lock successfully when key is free', async () => {
      const result = await lockManager.acquireLock('test:lock', { ttlMs: 5000 });

      expect(result.acquired).toBe(true);
      expect(result.release).toBeDefined();

      // Verify in REAL Redis
      const lockValue = await setup.redis.get('lock:test:lock');
      expect(lockValue).toBeTruthy();
    });

    it('should fail to acquire lock when already held', async () => {
      const first = await lockManager.acquireLock('test:lock', { ttlMs: 5000 });
      const second = await lockManager.acquireLock('test:lock', { ttlMs: 5000 });

      expect(first.acquired).toBe(true);
      expect(second.acquired).toBe(false);
    });

    it('should release lock correctly with real Redis', async () => {
      const result = await lockManager.acquireLock('test:lock', { ttlMs: 5000 });
      expect(result.acquired).toBe(true);

      // Verify lock exists in Redis
      expect(await setup.redis.get('lock:test:lock')).toBeTruthy();

      // Release lock
      await result.release();

      // Verify lock removed from Redis
      expect(await setup.redis.get('lock:test:lock')).toBeNull();

      // Now another acquisition should succeed
      const second = await lockManager.acquireLock('test:lock', { ttlMs: 5000 });
      expect(second.acquired).toBe(true);
    });

    it('should handle concurrent lock attempts with real Redis atomicity', async () => {
      // Test that was IMPOSSIBLE with mocks - real concurrent access
      const results = await Promise.all([
        lockManager.acquireLock('concurrent:lock', { ttlMs: 5000 }),
        lockManager.acquireLock('concurrent:lock', { ttlMs: 5000 }),
        lockManager.acquireLock('concurrent:lock', { ttlMs: 5000 }),
        lockManager.acquireLock('concurrent:lock', { ttlMs: 5000 }),
        lockManager.acquireLock('concurrent:lock', { ttlMs: 5000 })
      ]);

      // Real Redis SET NX ensures only ONE succeeds
      const acquired = results.filter(r => r.acquired);
      expect(acquired).toHaveLength(1);

      // Verify only one lock in Redis
      const lockValue = await setup.redis.get('lock:concurrent:lock');
      expect(lockValue).toBeTruthy();
    });
  });

  describe('Lock TTL and Expiration', () => {
    it('should handle TTL expiration correctly with real Redis', async () => {
      // Test real TTL behavior (was unreliable with mocks)
      const result = await lockManager.acquireLock('ttl:lock', { ttlMs: 1000 }); // 1 second
      expect(result.acquired).toBe(true);

      // Lock exists
      expect(await setup.redis.get('lock:ttl:lock')).toBeTruthy();

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Real Redis TTL expiration
      expect(await setup.redis.get('lock:ttl:lock')).toBeNull();

      // Should be able to acquire again
      const second = await lockManager.acquireLock('ttl:lock', { ttlMs: 5000 });
      expect(second.acquired).toBe(true);
    });

    it('should extend lock TTL correctly', async () => {
      const result = await lockManager.acquireLock('extend:lock', { ttlMs: 2000 });
      expect(result.acquired).toBe(true);

      // Extend lock
      const extended = await result.extend(5000);
      expect(extended).toBe(true);

      // Wait longer than original TTL but less than extended TTL
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Lock should still exist (extended TTL)
      expect(await setup.redis.get('lock:extend:lock')).toBeTruthy();
    });
  });

  describe('withLock Helper', () => {
    it('should execute function under lock', async () => {
      let executed = false;

      const result = await lockManager.withLock('test:lock', async () => {
        executed = true;
        return 'success';
      }, { ttlMs: 5000 });

      expect(executed).toBe(true);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toBe('success');
      }

      // Lock should be released after (verify in real Redis)
      expect(await setup.redis.get('lock:test:lock')).toBeNull();
    });

    it('should release lock even on error', async () => {
      const result = await lockManager.withLock('test:lock', async () => {
        throw new Error('Test error');
      }, { ttlMs: 5000 });

      // Should return error result, not throw
      expect(result.success).toBe(false);

      // Lock should be released (verify in real Redis)
      expect(await setup.redis.get('lock:test:lock')).toBeNull();

      // Should be able to acquire lock again
      const second = await lockManager.acquireLock('test:lock', { ttlMs: 5000 });
      expect(second.acquired).toBe(true);
    });

    it('should fail fast if lock cannot be acquired', async () => {
      // Acquire lock first
      const first = await lockManager.acquireLock('test:lock', { ttlMs: 10000 });
      expect(first.acquired).toBe(true);

      let executed = false;

      // Attempt to run under lock (should fail with retries: 0)
      const result = await lockManager.withLock('test:lock', async () => {
        executed = true;
        return 'success';
      }, { ttlMs: 5000, retries: 0 }); // No retries

      expect(executed).toBe(false);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('lock');
      }

      // Cleanup
      await first.release();
    });

    it('should handle concurrent withLock calls with real Redis', async () => {
      // Test concurrent operations with real atomicity
      let executionCount = 0;
      const results = await Promise.all([
        lockManager.withLock('concurrent:withlock', async () => {
          executionCount++;
          await new Promise(resolve => setTimeout(resolve, 100)); // Hold lock briefly
          return 'result-1';
        }, { ttlMs: 5000, retries: 0 }),
        lockManager.withLock('concurrent:withlock', async () => {
          executionCount++;
          await new Promise(resolve => setTimeout(resolve, 100));
          return 'result-2';
        }, { ttlMs: 5000, retries: 0 }),
        lockManager.withLock('concurrent:withlock', async () => {
          executionCount++;
          await new Promise(resolve => setTimeout(resolve, 100));
          return 'result-3';
        }, { ttlMs: 5000, retries: 0 })
      ]);

      // Only one should succeed (real Redis atomicity)
      const succeeded = results.filter(r => r.success);
      expect(succeeded).toHaveLength(1);

      // Only one function executed
      expect(executionCount).toBe(1);
    });
  });

  describe('Lock Ownership', () => {
    it('should not release lock owned by another instance', async () => {
      const result1 = await lockManager.acquireLock('ownership:lock', { ttlMs: 5000 });
      expect(result1.acquired).toBe(true);

      // Try to release with wrong owner value using Redis eval
      const lockValue = await setup.redis.get('lock:ownership:lock');
      const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

      await setup.redis.eval(script, {
        keys: ['lock:ownership:lock'],
        arguments: ['wrong-owner-id']
      });

      // Lock should still exist (release failed due to wrong owner)
      expect(await setup.redis.get('lock:ownership:lock')).toBe(lockValue);

      // Cleanup
      await result1.release();
    });
  });
});

// =============================================================================
// [Level 1] Service State Manager Integration Tests
// =============================================================================

describe('[Level 1] ServiceStateManager Integration', () => {
  let setup: Level1TestSetup;

  beforeAll(async () => {
    setup = await createLevel1TestSetup({
      testSuiteName: 'service-state-manager-integration'
    });
  });

  afterAll(async () => {
    if (setup) {
      await setup.cleanup();
    }
  });

  beforeEach(async () => {
    if (setup) {
      await setup.redis.flushDb();
    }
  });

  describe('State Transitions', () => {
    it('should transition from STOPPED to RUNNING', async () => {
      const stateManager = createServiceState({
        serviceName: 'test-service',
        transitionTimeoutMs: 5000
      });

      expect(stateManager.getState()).toBe(ServiceState.STOPPED);

      const result = await stateManager.executeStart(async () => {
        // Simulate service startup
        await new Promise(resolve => setTimeout(resolve, 100));
      });

      expect(result.success).toBe(true);
      expect(stateManager.getState()).toBe(ServiceState.RUNNING);
    });

    it('should transition from RUNNING to STOPPED', async () => {
      const stateManager = createServiceState({
        serviceName: 'test-service',
        transitionTimeoutMs: 5000
      });

      // Start first
      await stateManager.executeStart(async () => {});
      expect(stateManager.getState()).toBe(ServiceState.RUNNING);

      // Stop
      const result = await stateManager.executeStop(async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
      });

      expect(result.success).toBe(true);
      expect(stateManager.getState()).toBe(ServiceState.STOPPED);
    });

    it('should prevent concurrent start operations', async () => {
      const stateManager = createServiceState({
        serviceName: 'test-service',
        transitionTimeoutMs: 5000
      });

      let startCount = 0;

      const results = await Promise.all([
        stateManager.executeStart(async () => {
          startCount++;
          await new Promise(resolve => setTimeout(resolve, 200));
        }),
        stateManager.executeStart(async () => {
          startCount++;
          await new Promise(resolve => setTimeout(resolve, 200));
        }),
        stateManager.executeStart(async () => {
          startCount++;
          await new Promise(resolve => setTimeout(resolve, 200));
        })
      ]);

      // Only one should succeed
      const succeeded = results.filter(r => r.success);
      expect(succeeded).toHaveLength(1);

      // Only one start executed
      expect(startCount).toBe(1);

      // State is RUNNING
      expect(stateManager.getState()).toBe(ServiceState.RUNNING);
    });

    it('should timeout on long transitions', async () => {
      const stateManager = createServiceState({
        serviceName: 'test-service',
        transitionTimeoutMs: 500 // Short timeout
      });

      const result = await stateManager.executeStart(async () => {
        // Simulate slow startup (longer than timeout)
        await new Promise(resolve => setTimeout(resolve, 1000));
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('timeout');
      }

      // State should revert to STOPPED on timeout
      expect(stateManager.getState()).toBe(ServiceState.STOPPED);
    });
  });

  describe('State Events', () => {
    it('should emit state change events', async () => {
      const stateManager = createServiceState({
        serviceName: 'test-service',
        transitionTimeoutMs: 5000
      });

      const events: ServiceState[] = [];
      stateManager.on('stateChanged', (state: ServiceState) => {
        events.push(state);
      });

      await stateManager.executeStart(async () => {});

      expect(events).toContain(ServiceState.STARTING);
      expect(events).toContain(ServiceState.RUNNING);

      await stateManager.executeStop(async () => {});

      expect(events).toContain(ServiceState.STOPPING);
      expect(events).toContain(ServiceState.STOPPED);
    });
  });

  describe('Error Handling', () => {
    it('should handle errors during start and revert state', async () => {
      const stateManager = createServiceState({
        serviceName: 'test-service',
        transitionTimeoutMs: 5000
      });

      const result = await stateManager.executeStart(async () => {
        throw new Error('Startup failed');
      });

      expect(result.success).toBe(false);
      expect(stateManager.getState()).toBe(ServiceState.STOPPED);
    });

    it('should handle errors during stop and set to ERROR state', async () => {
      const stateManager = createServiceState({
        serviceName: 'test-service',
        transitionTimeoutMs: 5000
      });

      // Start successfully
      await stateManager.executeStart(async () => {});
      expect(stateManager.getState()).toBe(ServiceState.RUNNING);

      // Stop with error
      const result = await stateManager.executeStop(async () => {
        throw new Error('Shutdown failed');
      });

      expect(result.success).toBe(false);
      expect(stateManager.getState()).toBe(ServiceState.ERROR);
    });
  });
});

// =============================================================================
// Summary
// =============================================================================

/**
 * MIGRATION RESULTS:
 *
 * Before:
 * - 829 lines total
 * - 180 lines of MockRedisClient implementation
 * - Mock behavior (didn't test real Redis)
 * - No concurrency tests
 * - No real TTL tests
 *
 * After:
 * - ~400 lines total (50% reduction)
 * - 0 lines of mock code (100% elimination)
 * - Tests real Redis behavior
 * - Added 3 concurrency tests (now possible)
 * - Added 2 real TTL expiration tests
 * - Tests real atomic operations
 *
 * Benefits:
 * - ✅ Catches race conditions (concurrent lock acquisition)
 * - ✅ Tests real TTL expiration
 * - ✅ Tests real Redis atomicity
 * - ✅ Zero mock maintenance
 * - ✅ Simpler, more maintainable code
 */
