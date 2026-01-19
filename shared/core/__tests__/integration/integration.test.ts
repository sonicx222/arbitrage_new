/**
 * Integration Tests for Arbitrage Detection System
 *
 * Tests the interaction between major components:
 * - Redis Streams messaging
 * - Distributed locking
 * - Service state management
 * - Cross-service communication
 *
 * These tests use mocked Redis connections but verify the integration patterns.
 *
 * @migrated from shared/core/src/integration.test.ts
 * @see ADR-009: Test Architecture
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

// =============================================================================
// Mock Redis Client
// =============================================================================

class MockRedisClient {
  private store: Map<string, { value: string; ttl: number; createdAt: number }> = new Map();
  private streams: Map<string, any[]> = new Map();
  private consumerGroups: Map<string, Set<string>> = new Map();
  public commandCount = 0;

  async set(key: string, value: string, options?: { PX?: number; NX?: boolean }): Promise<string | null> {
    this.commandCount++;

    if (options?.NX && this.store.has(key)) {
      const entry = this.store.get(key)!;
      // Check if expired
      if (entry.ttl > 0 && Date.now() - entry.createdAt > entry.ttl) {
        this.store.delete(key);
      } else {
        return null; // Key exists, NX fails
      }
    }

    this.store.set(key, {
      value,
      ttl: options?.PX || 0,
      createdAt: Date.now()
    });
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    this.commandCount++;
    const entry = this.store.get(key);
    if (!entry) return null;

    // Check TTL
    if (entry.ttl > 0 && Date.now() - entry.createdAt > entry.ttl) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  async del(key: string): Promise<number> {
    this.commandCount++;
    return this.store.delete(key) ? 1 : 0;
  }

  async eval<T = number>(script: string, keys: string[], args: string[]): Promise<T> {
    this.commandCount++;
    // P1-1 FIX: Mock Lua script for lock release/extend
    // Signature matches redis.eval(script, keys[], args[])
    // For release: KEYS[1] = lock key, ARGV[1] = expected value
    const key = keys[0];
    const expectedValue = args[0];

    const entry = this.store.get(key);
    if (entry && entry.value === expectedValue) {
      // Handle both release (del) and extend (expire) scripts
      if (script.includes('del')) {
        this.store.delete(key);
      } else if (script.includes('expire')) {
        // Extend - reset the TTL
        const newTtl = parseInt(args[1]) * 1000;
        entry.ttl = newTtl;
        entry.createdAt = Date.now();
      }
      return 1 as T;
    }
    return 0 as T;
  }

  // setNx: Set key with value and TTL only if key doesn't exist
  async setNx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    this.commandCount++;

    // Check if key already exists and not expired
    if (this.store.has(key)) {
      const entry = this.store.get(key)!;
      if (entry.ttl > 0 && Date.now() - entry.createdAt > entry.ttl) {
        this.store.delete(key);
      } else {
        return false; // Key exists
      }
    }

    // Set key with TTL (convert seconds to ms)
    this.store.set(key, {
      value,
      ttl: ttlSeconds * 1000,
      createdAt: Date.now()
    });
    return true;
  }

  async xadd(stream: string, id: string, ...fields: string[]): Promise<string> {
    this.commandCount++;
    if (!this.streams.has(stream)) {
      this.streams.set(stream, []);
    }
    const messageId = `${Date.now()}-0`;
    this.streams.get(stream)!.push({ id: messageId, fields });
    return messageId;
  }

  async xreadgroup(
    groupOption: string,
    group: string,
    consumerOption: string,
    consumer: string,
    ...args: any[]
  ): Promise<any[]> {
    this.commandCount++;
    // Return mock messages
    return [];
  }

  async xgroup(command: string, stream: string, group: string, ...args: any[]): Promise<string> {
    this.commandCount++;
    const key = `${stream}:${group}`;
    if (!this.consumerGroups.has(key)) {
      this.consumerGroups.set(key, new Set());
    }
    return 'OK';
  }

  async xack(stream: string, group: string, ...ids: string[]): Promise<number> {
    this.commandCount++;
    return ids.length;
  }

  // Helper to check store state
  hasKey(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (entry.ttl > 0 && Date.now() - entry.createdAt > entry.ttl) {
      return false;
    }
    return true;
  }

  getStreamMessages(stream: string): any[] {
    return this.streams.get(stream) || [];
  }

  reset(): void {
    this.store.clear();
    this.streams.clear();
    this.consumerGroups.clear();
    this.commandCount = 0;
  }
}

// =============================================================================
// Distributed Lock Integration Tests
// =============================================================================

describe('DistributedLockManager Integration', () => {
  let mockRedis: MockRedisClient;
  let lockManager: DistributedLockManager;

  beforeEach(async () => {
    mockRedis = new MockRedisClient();
    lockManager = new DistributedLockManager();
    await lockManager.initialize(mockRedis as any);
  });

  describe('Lock Acquisition', () => {
    it('should acquire lock successfully when key is free', async () => {
      const result = await lockManager.acquireLock('test:lock', { ttlMs: 5000 });

      expect(result.acquired).toBe(true);
      expect(result.release).toBeDefined();
      expect(mockRedis.hasKey('lock:test:lock')).toBe(true);
    });

    it('should fail to acquire lock when already held', async () => {
      const first = await lockManager.acquireLock('test:lock', { ttlMs: 5000 });
      const second = await lockManager.acquireLock('test:lock', { ttlMs: 5000 });

      expect(first.acquired).toBe(true);
      expect(second.acquired).toBe(false);
    });

    // P1-1 FIX: Un-skipped - Mock properly simulates lock release via eval()
    it('should release lock correctly', async () => {
      const result = await lockManager.acquireLock('test:lock', { ttlMs: 5000 });
      expect(result.acquired).toBe(true);

      await result.release();

      // Now another acquisition should succeed
      const second = await lockManager.acquireLock('test:lock', { ttlMs: 5000 });
      expect(second.acquired).toBe(true);
    });
  });

  describe('withLock Helper', () => {
    // P1-1 FIX: Un-skipped - Verified withLock works with mock
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
      // Lock should be released after
      expect(mockRedis.hasKey('lock:test:lock')).toBe(false);
    });

    // P1-1 FIX: Un-skipped - Verified error handling releases lock
    it('should release lock even on error', async () => {
      const result = await lockManager.withLock('test:lock', async () => {
        throw new Error('Test error');
      }, { ttlMs: 5000 });

      // Should return error result, not throw
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('execution_error');
      }

      // Lock should still be released
      expect(mockRedis.hasKey('lock:test:lock')).toBe(false);
    });

    it('should return failure when lock cannot be acquired', async () => {
      // Acquire lock first
      await lockManager.acquireLock('test:lock', { ttlMs: 5000 });

      // Try withLock
      const result = await lockManager.withLock('test:lock', async () => {
        return 'should not execute';
      }, { ttlMs: 5000 });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('lock_not_acquired');
      }
    });
  });

  describe('Concurrent Access', () => {
    it('should only allow one concurrent execution', async () => {
      let executionCount = 0;
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      const execute = async () => {
        const result = await lockManager.acquireLock('concurrent:lock', { ttlMs: 5000 });
        if (!result.acquired) return;

        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        executionCount++;

        await new Promise(resolve => setTimeout(resolve, 10));

        currentConcurrent--;
        await result.release();
      };

      // Run 10 concurrent attempts
      await Promise.all(Array(10).fill(null).map(() => execute()));

      expect(maxConcurrent).toBe(1);
      expect(executionCount).toBe(1); // Only first one succeeds without retry
    });
  });
});

// =============================================================================
// Service State Machine Integration Tests
// =============================================================================

describe('ServiceStateManager Integration', () => {
  let stateManager: ServiceStateManager;

  beforeEach(() => {
    stateManager = createServiceState({
      serviceName: 'test-service',
      transitionTimeoutMs: 1000
    });
  });

  describe('State Transitions', () => {
    it('should start in STOPPED state', () => {
      expect(stateManager.getState()).toBe(ServiceState.STOPPED);
    });

    // P1-1 FIX: Un-skipped - Fixed to use StateTransitionResult.success
    it('should transition through valid lifecycle', async () => {
      // STOPPED -> STARTING
      const r1 = await stateManager.transitionTo(ServiceState.STARTING);
      expect(r1.success).toBe(true);
      expect(stateManager.getState()).toBe(ServiceState.STARTING);

      // STARTING -> RUNNING
      const r2 = await stateManager.transitionTo(ServiceState.RUNNING);
      expect(r2.success).toBe(true);
      expect(stateManager.getState()).toBe(ServiceState.RUNNING);

      // RUNNING -> STOPPING
      const r3 = await stateManager.transitionTo(ServiceState.STOPPING);
      expect(r3.success).toBe(true);
      expect(stateManager.getState()).toBe(ServiceState.STOPPING);

      // STOPPING -> STOPPED
      const r4 = await stateManager.transitionTo(ServiceState.STOPPED);
      expect(r4.success).toBe(true);
      expect(stateManager.getState()).toBe(ServiceState.STOPPED);
    });

    // P1-1 FIX: Un-skipped - Fixed to use StateTransitionResult.success
    it('should reject invalid transitions', async () => {
      // Cannot go from STOPPED to RUNNING directly
      const result = await stateManager.transitionTo(ServiceState.RUNNING);
      expect(result.success).toBe(false);
      expect(stateManager.getState()).toBe(ServiceState.STOPPED);
    });

    // P1-1 FIX: Un-skipped - Fixed to use StateTransitionResult.success
    it('should handle error state transitions', async () => {
      await stateManager.transitionTo(ServiceState.STARTING);

      // STARTING -> ERROR (valid)
      const r1 = await stateManager.transitionTo(ServiceState.ERROR);
      expect(r1.success).toBe(true);
      expect(stateManager.getState()).toBe(ServiceState.ERROR);

      // ERROR -> STOPPED (valid recovery)
      const r2 = await stateManager.transitionTo(ServiceState.STOPPED);
      expect(r2.success).toBe(true);
      expect(stateManager.getState()).toBe(ServiceState.STOPPED);
    });
  });

  describe('State Guards', () => {
    it('should report isRunning correctly', async () => {
      expect(stateManager.isRunning()).toBe(false);

      await stateManager.transitionTo(ServiceState.STARTING);
      expect(stateManager.isRunning()).toBe(false);

      await stateManager.transitionTo(ServiceState.RUNNING);
      expect(stateManager.isRunning()).toBe(true);
    });

    it('should report isStopped correctly', async () => {
      expect(stateManager.isStopped()).toBe(true);

      await stateManager.transitionTo(ServiceState.STARTING);
      expect(stateManager.isStopped()).toBe(false);
    });

    it('should allow start from stopped state', () => {
      // Can start from STOPPED state - assertCanStart should not throw
      expect(() => stateManager.assertCanStart()).not.toThrow();

      stateManager.transitionTo(ServiceState.STARTING);
      // Cannot start from STARTING state
      expect(() => stateManager.assertCanStart()).toThrow();
    });

    it('should allow stop from running state', async () => {
      // Cannot stop from STOPPED state
      expect(() => stateManager.assertCanStop()).toThrow();

      await stateManager.transitionTo(ServiceState.STARTING);
      await stateManager.transitionTo(ServiceState.RUNNING);
      // Can stop from RUNNING state
      expect(() => stateManager.assertCanStop()).not.toThrow();
    });
  });

  describe('Concurrent State Changes', () => {
    // P1-1 FIX: Un-skipped - Fixed to use StateTransitionResult.success
    it('should handle concurrent transition attempts safely', async () => {
      await stateManager.transitionTo(ServiceState.STARTING);
      await stateManager.transitionTo(ServiceState.RUNNING);

      // Try concurrent stops
      const results = await Promise.all([
        stateManager.transitionTo(ServiceState.STOPPING),
        stateManager.transitionTo(ServiceState.STOPPING),
        stateManager.transitionTo(ServiceState.STOPPING)
      ]);

      // Only one should succeed (others rejected due to invalid state)
      const successCount = results.filter(r => r.success).length;
      expect(successCount).toBe(1);

      // State should be STOPPING after first success
      expect(stateManager.getState()).toBe(ServiceState.STOPPING);
    });
  });
});

// =============================================================================
// Cross-Component Integration Tests
// =============================================================================

describe('Cross-Component Integration', () => {
  let mockRedis: MockRedisClient;
  let lockManager: DistributedLockManager;
  let stateManager: ServiceStateManager;

  beforeEach(async () => {
    mockRedis = new MockRedisClient();
    lockManager = new DistributedLockManager();
    await lockManager.initialize(mockRedis as any);
    stateManager = createServiceState({
      serviceName: 'integration-test',
      transitionTimeoutMs: 1000
    });
  });

  describe('Service Lifecycle with Distributed Locking', () => {
    // P1-1 FIX: Un-skipped - Fixed to use StateTransitionResult.success
    it('should coordinate service startup with lock', async () => {
      const startService = async () => {
        // Acquire startup lock
        const lock = await lockManager.acquireLock('service:startup', { ttlMs: 10000 });
        if (!lock.acquired) {
          return { started: false, reason: 'lock_failed' };
        }

        try {
          // Perform state transition
          const r1 = await stateManager.transitionTo(ServiceState.STARTING);
          if (!r1.success) {
            return { started: false, reason: 'transition_failed' };
          }

          // Simulate initialization
          await new Promise(resolve => setTimeout(resolve, 10));

          const r2 = await stateManager.transitionTo(ServiceState.RUNNING);
          if (!r2.success) {
            return { started: false, reason: 'running_failed' };
          }

          return { started: true };
        } finally {
          await lock.release();
        }
      };

      const result = await startService();

      expect(result.started).toBe(true);
      expect(stateManager.isRunning()).toBe(true);
      expect(mockRedis.hasKey('lock:service:startup')).toBe(false);
    });

    it('should prevent duplicate service startups', async () => {
      const startResults: any[] = [];

      const startService = async (id: number) => {
        const lock = await lockManager.acquireLock('service:startup', { ttlMs: 10000 });
        if (!lock.acquired) {
          startResults.push({ id, started: false, reason: 'lock_failed' });
          return;
        }

        try {
          if (stateManager.isRunning()) {
            startResults.push({ id, started: false, reason: 'already_running' });
            return;
          }

          await stateManager.transitionTo(ServiceState.STARTING);
          await new Promise(resolve => setTimeout(resolve, 50));
          await stateManager.transitionTo(ServiceState.RUNNING);
          startResults.push({ id, started: true });
        } finally {
          await lock.release();
        }
      };

      // Start multiple instances concurrently
      await Promise.all([
        startService(1),
        startService(2),
        startService(3)
      ]);

      // Only one should have started successfully
      const successfulStarts = startResults.filter(r => r.started);
      expect(successfulStarts.length).toBe(1);
    });
  });

  describe('Execution Coordination', () => {
    it('should prevent duplicate opportunity execution', async () => {
      const executionLog: string[] = [];

      const executeOpportunity = async (oppId: string) => {
        const lockKey = `opportunity:${oppId}`;

        return lockManager.withLock(lockKey, async () => {
          executionLog.push(`start:${oppId}`);
          await new Promise(resolve => setTimeout(resolve, 20));
          executionLog.push(`end:${oppId}`);
          return { executed: true, oppId };
        }, { ttlMs: 30000 });
      };

      // Try to execute same opportunity 3 times concurrently
      const results = await Promise.all([
        executeOpportunity('opp-123'),
        executeOpportunity('opp-123'),
        executeOpportunity('opp-123')
      ]);

      // Only one execution should succeed (returns { success: true, result: ... })
      const successfulExecutions = results.filter(r => r.success);
      expect(successfulExecutions.length).toBe(1);

      // Execution log should show only one start and end
      expect(executionLog.filter(l => l.startsWith('start:')).length).toBe(1);
      expect(executionLog.filter(l => l.startsWith('end:')).length).toBe(1);
    });

    it('should allow different opportunities to execute concurrently', async () => {
      const executionLog: string[] = [];

      const executeOpportunity = async (oppId: string) => {
        const lockKey = `opportunity:${oppId}`;

        return lockManager.withLock(lockKey, async () => {
          executionLog.push(`start:${oppId}`);
          await new Promise(resolve => setTimeout(resolve, 10));
          executionLog.push(`end:${oppId}`);
          return { executed: true, oppId };
        }, { ttlMs: 30000 });
      };

      // Execute different opportunities concurrently
      const results = await Promise.all([
        executeOpportunity('opp-1'),
        executeOpportunity('opp-2'),
        executeOpportunity('opp-3')
      ]);

      // All should succeed (all return { success: true, result: ... })
      expect(results.every(r => r.success)).toBe(true);
      expect(executionLog.filter(l => l.startsWith('start:')).length).toBe(3);
    });
  });
});

// =============================================================================
// Queue Backpressure Integration Tests
// =============================================================================

describe('Queue Backpressure Integration', () => {
  interface QueueConfig {
    maxSize: number;
    highWaterMark: number;
    lowWaterMark: number;
  }

  class MockQueue {
    private queue: any[] = [];
    private paused = false;

    constructor(private config: QueueConfig) {}

    add(item: any): { accepted: boolean; reason?: string } {
      if (this.queue.length >= this.config.maxSize) {
        return { accepted: false, reason: 'queue_full' };
      }

      if (this.queue.length >= this.config.highWaterMark) {
        this.paused = true;
        return { accepted: false, reason: 'backpressure' };
      }

      this.queue.push(item);
      return { accepted: true };
    }

    remove(): any | undefined {
      const item = this.queue.shift();

      if (this.paused && this.queue.length <= this.config.lowWaterMark) {
        this.paused = false;
      }

      return item;
    }

    size(): number {
      return this.queue.length;
    }

    isPaused(): boolean {
      return this.paused;
    }
  }

  it('should apply backpressure at high water mark', () => {
    const queue = new MockQueue({
      maxSize: 100,
      highWaterMark: 80,
      lowWaterMark: 20
    });

    // Fill to high water mark
    for (let i = 0; i < 80; i++) {
      const result = queue.add({ id: i });
      expect(result.accepted).toBe(true);
    }

    // Next item should trigger backpressure
    const result = queue.add({ id: 80 });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('backpressure');
    expect(queue.isPaused()).toBe(true);
  });

  it('should resume at low water mark', () => {
    const queue = new MockQueue({
      maxSize: 100,
      highWaterMark: 80,
      lowWaterMark: 20
    });

    // Fill and trigger backpressure
    for (let i = 0; i < 80; i++) {
      queue.add({ id: i });
    }
    queue.add({ id: 80 }); // Triggers backpressure
    expect(queue.isPaused()).toBe(true);

    // Drain to low water mark
    while (queue.size() > 20) {
      queue.remove();
    }

    // Should resume after draining below low water mark
    queue.remove();
    expect(queue.isPaused()).toBe(false);

    // Should accept new items
    const result = queue.add({ id: 'new' });
    expect(result.accepted).toBe(true);
  });

  it('should hard reject at max size', () => {
    const queue = new MockQueue({
      maxSize: 10,
      highWaterMark: 8,
      lowWaterMark: 2
    });

    // Fill to max
    for (let i = 0; i < 10; i++) {
      // Force add by checking size manually
      if (queue.size() < 10) {
        (queue as any).queue.push({ id: i });
      }
    }

    // Should hard reject
    const result = queue.add({ id: 'overflow' });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('queue_full');
  });
});

// =============================================================================
// Message Processing Integration Tests
// =============================================================================

describe('Message Processing Integration', () => {
  interface Message {
    id: string;
    type: string;
    data: any;
    timestamp: number;
  }

  class MockStreamProcessor {
    private processedMessages: Message[] = [];
    private errorMessages: Message[] = [];

    async processMessage(message: Message): Promise<boolean> {
      try {
        // Simulate processing
        if (message.type === 'error_trigger') {
          throw new Error('Processing failed');
        }

        this.processedMessages.push(message);
        return true;
      } catch (error) {
        this.errorMessages.push(message);
        return false;
      }
    }

    getProcessedCount(): number {
      return this.processedMessages.length;
    }

    getErrorCount(): number {
      return this.errorMessages.length;
    }
  }

  it('should process messages successfully', async () => {
    const processor = new MockStreamProcessor();

    const messages: Message[] = [
      { id: '1', type: 'price_update', data: {}, timestamp: Date.now() },
      { id: '2', type: 'swap_event', data: {}, timestamp: Date.now() },
      { id: '3', type: 'arbitrage', data: {}, timestamp: Date.now() }
    ];

    for (const msg of messages) {
      await processor.processMessage(msg);
    }

    expect(processor.getProcessedCount()).toBe(3);
    expect(processor.getErrorCount()).toBe(0);
  });

  it('should handle processing errors gracefully', async () => {
    const processor = new MockStreamProcessor();

    const messages: Message[] = [
      { id: '1', type: 'price_update', data: {}, timestamp: Date.now() },
      { id: '2', type: 'error_trigger', data: {}, timestamp: Date.now() },
      { id: '3', type: 'price_update', data: {}, timestamp: Date.now() }
    ];

    for (const msg of messages) {
      await processor.processMessage(msg);
    }

    expect(processor.getProcessedCount()).toBe(2);
    expect(processor.getErrorCount()).toBe(1);
  });
});

// =============================================================================
// Performance Integration Tests
// =============================================================================

describe('Performance Integration', () => {
  it('should handle high message throughput', async () => {
    const mockRedis = new MockRedisClient();
    const messageCount = 1000;
    const startTime = performance.now();

    // Simulate high-throughput message publishing
    for (let i = 0; i < messageCount; i++) {
      await mockRedis.xadd(
        'test:stream',
        '*',
        'type', 'price_update',
        'data', JSON.stringify({ price: Math.random() })
      );
    }

    const endTime = performance.now();
    const duration = endTime - startTime;
    const throughput = messageCount / (duration / 1000);

    expect(throughput).toBeGreaterThan(100); // At least 100 messages/second
    expect(mockRedis.getStreamMessages('test:stream').length).toBe(messageCount);
  });

  it('should maintain lock performance under load', async () => {
    const mockRedis = new MockRedisClient();
    const lockManager = new DistributedLockManager();
    await lockManager.initialize(mockRedis as any);
    const iterations = 100;
    const startTime = performance.now();

    for (let i = 0; i < iterations; i++) {
      const lock = await lockManager.acquireLock(`perf:lock:${i}`, { ttlMs: 1000 });
      if (lock.acquired) {
        await lock.release();
      }
    }

    const endTime = performance.now();
    const avgLatency = (endTime - startTime) / iterations;

    expect(avgLatency).toBeLessThan(10); // Less than 10ms per lock cycle
  });
});
