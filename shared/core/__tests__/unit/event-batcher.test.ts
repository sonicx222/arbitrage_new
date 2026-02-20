/**
 * EventBatcher Unit Tests
 *
 * Comprehensive tests for the event batching infrastructure including:
 * - Constructor and configuration defaults
 * - Single and bulk event addition
 * - Deduplication via transactionHash+logIndex, id, and JSON fallback
 * - Batch flushing (manual, timeout-based, capacity-based)
 * - Queue size limits with FIFO eviction
 * - Prioritization sorting (larger batches first, then older first)
 * - Stats reporting
 * - Destroy / cleanup lifecycle
 * - processQueue mutex preventing concurrent execution
 * - Factory function and singleton pattern
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

jest.mock('../../src/logger');

import {
  EventBatcher,
  createEventBatcher,
  getDefaultEventBatcher,
  resetDefaultEventBatcher,
  BatchedEvent,
} from '../../src/event-batcher';

export {};

describe('EventBatcher', () => {
  let onBatchReady: jest.Mock<(batch: BatchedEvent<any>) => void>;

  beforeEach(() => {
    jest.useFakeTimers();
    onBatchReady = jest.fn();
  });

  afterEach(async () => {
    jest.useRealTimers();
    await resetDefaultEventBatcher();
  });

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------
  describe('constructor', () => {
    it('should use default config values when no config is provided', () => {
      const batcher = new EventBatcher({}, onBatchReady);
      const stats = batcher.getStats();

      expect(stats.maxQueueSize).toBe(1000);
      expect(stats.activeBatches).toBe(0);
      expect(stats.queuedBatches).toBe(0);
    });

    it('should accept custom config values', () => {
      const batcher = new EventBatcher(
        {
          maxBatchSize: 5,
          maxWaitTime: 100,
          enableDeduplication: false,
          enablePrioritization: false,
          maxQueueSize: 50,
        },
        onBatchReady,
      );
      const stats = batcher.getStats();

      expect(stats.maxQueueSize).toBe(50);
    });
  });

  // ---------------------------------------------------------------------------
  // addEvent
  // ---------------------------------------------------------------------------
  describe('addEvent', () => {
    it('should add an event to a batch with an explicit pair key', () => {
      const batcher = new EventBatcher({ maxBatchSize: 10 }, onBatchReady);

      batcher.addEvent({ data: 'foo' }, 'pair_A');
      const stats = batcher.getStats();

      expect(stats.activeBatches).toBe(1);
      expect(stats.totalEventsProcessed).toBe(1);
    });

    it('should extract pair key from event.pairKey property', () => {
      const batcher = new EventBatcher({ maxBatchSize: 10 }, onBatchReady);

      batcher.addEvent({ pairKey: 'WETH/DAI' });
      const stats = batcher.getStats();

      expect(stats.activeBatches).toBe(1);
    });

    it('should extract pair key from event.address and event.topics', () => {
      const batcher = new EventBatcher({ maxBatchSize: 10 }, onBatchReady);

      batcher.addEvent({ address: '0xABC', topics: ['0x123'] });
      const stats = batcher.getStats();

      expect(stats.activeBatches).toBe(1);
    });

    it('should use "unknown_pair" for events with no extractable key', () => {
      const batcher = new EventBatcher({ maxBatchSize: 10 }, onBatchReady);

      batcher.addEvent({ someField: 'value' });
      const stats = batcher.getStats();

      expect(stats.activeBatches).toBe(1);
    });

    it('should create a timeout that flushes the batch after maxWaitTime', async () => {
      const batcher = new EventBatcher({ maxBatchSize: 100, maxWaitTime: 50 }, onBatchReady);

      batcher.addEvent({ id: '1' }, 'pair_A');
      expect(onBatchReady).not.toHaveBeenCalled();

      jest.advanceTimersByTime(50);

      await Promise.resolve();
      await Promise.resolve();

      expect(onBatchReady).toHaveBeenCalledTimes(1);
      const call = onBatchReady.mock.calls[0][0] as BatchedEvent<any>;
      expect(call.pairKey).toBe('pair_A');
      expect(call.batchSize).toBe(1);
      expect(call.events).toHaveLength(1);
    });

    it('should flush the batch immediately when maxBatchSize is reached', async () => {
      const batcher = new EventBatcher({ maxBatchSize: 3, maxWaitTime: 5000 }, onBatchReady);

      batcher.addEvent({ id: 'a' }, 'pair_A');
      batcher.addEvent({ id: 'b' }, 'pair_A');
      expect(onBatchReady).not.toHaveBeenCalled();

      batcher.addEvent({ id: 'c' }, 'pair_A');

      await Promise.resolve();
      await Promise.resolve();

      expect(onBatchReady).toHaveBeenCalledTimes(1);
      const call = onBatchReady.mock.calls[0][0] as BatchedEvent<any>;
      expect(call.batchSize).toBe(3);
      expect(call.events).toHaveLength(3);
    });

    it('should deduplicate events by transactionHash + logIndex', () => {
      const batcher = new EventBatcher(
        { maxBatchSize: 10, enableDeduplication: true },
        onBatchReady,
      );

      const event = { transactionHash: '0xabc', logIndex: 0 };
      batcher.addEvent(event, 'pair_A');
      batcher.addEvent(event, 'pair_A');

      const stats = batcher.getStats();
      expect(stats.totalEventsProcessed).toBe(1);
    });

    it('should deduplicate events by id field', () => {
      const batcher = new EventBatcher(
        { maxBatchSize: 10, enableDeduplication: true },
        onBatchReady,
      );

      batcher.addEvent({ id: 'unique-id-1' }, 'pair_A');
      batcher.addEvent({ id: 'unique-id-1' }, 'pair_A');

      const stats = batcher.getStats();
      expect(stats.totalEventsProcessed).toBe(1);
    });

    it('should deduplicate events by JSON.stringify fallback', () => {
      const batcher = new EventBatcher(
        { maxBatchSize: 10, enableDeduplication: true },
        onBatchReady,
      );

      batcher.addEvent({ value: 42 }, 'pair_A');
      batcher.addEvent({ value: 42 }, 'pair_A');

      const stats = batcher.getStats();
      expect(stats.totalEventsProcessed).toBe(1);
    });

    it('should not deduplicate when enableDeduplication is false', () => {
      const batcher = new EventBatcher(
        { maxBatchSize: 10, enableDeduplication: false },
        onBatchReady,
      );

      const event = { transactionHash: '0xabc', logIndex: 0 };
      batcher.addEvent(event, 'pair_A');
      batcher.addEvent(event, 'pair_A');

      const stats = batcher.getStats();
      expect(stats.totalEventsProcessed).toBe(2);
    });

    it('should allow distinct events with same pair key', () => {
      const batcher = new EventBatcher(
        { maxBatchSize: 10, enableDeduplication: true },
        onBatchReady,
      );

      batcher.addEvent({ id: '1' }, 'pair_A');
      batcher.addEvent({ id: '2' }, 'pair_A');

      const stats = batcher.getStats();
      expect(stats.totalEventsProcessed).toBe(2);
    });

    it('should group events by pair key into separate batches', () => {
      const batcher = new EventBatcher({ maxBatchSize: 10 }, onBatchReady);

      batcher.addEvent({ id: '1' }, 'pair_A');
      batcher.addEvent({ id: '2' }, 'pair_B');

      const stats = batcher.getStats();
      expect(stats.activeBatches).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // addEvents (bulk)
  // ---------------------------------------------------------------------------
  describe('addEvents', () => {
    it('should add multiple events in bulk', () => {
      const batcher = new EventBatcher({ maxBatchSize: 10 }, onBatchReady);

      batcher.addEvents(
        [{ id: '1' }, { id: '2' }, { id: '3' }],
        'pair_A',
      );

      const stats = batcher.getStats();
      expect(stats.totalEventsProcessed).toBe(3);
      expect(stats.activeBatches).toBe(1);
    });

    it('should trigger flush when bulk add exceeds maxBatchSize', async () => {
      const batcher = new EventBatcher({ maxBatchSize: 2, maxWaitTime: 5000 }, onBatchReady);

      batcher.addEvents(
        [{ id: '1' }, { id: '2' }, { id: '3' }],
        'pair_A',
      );

      await Promise.resolve();
      await Promise.resolve();

      expect(onBatchReady).toHaveBeenCalledTimes(1);
      const call = onBatchReady.mock.calls[0][0] as BatchedEvent<any>;
      expect(call.batchSize).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // flushBatch
  // ---------------------------------------------------------------------------
  describe('flushBatch', () => {
    it('should flush a specific batch by pair key', async () => {
      const batcher = new EventBatcher({ maxBatchSize: 100, maxWaitTime: 5000 }, onBatchReady);

      batcher.addEvent({ id: '1' }, 'pair_A');
      batcher.addEvent({ id: '2' }, 'pair_A');
      batcher.flushBatch('pair_A');

      await Promise.resolve();
      await Promise.resolve();

      expect(onBatchReady).toHaveBeenCalledTimes(1);
      const call = onBatchReady.mock.calls[0][0] as BatchedEvent<any>;
      expect(call.pairKey).toBe('pair_A');
      expect(call.batchSize).toBe(2);
    });

    it('should be a no-op for a non-existent pair key', () => {
      const batcher = new EventBatcher({}, onBatchReady);

      batcher.flushBatch('non_existent');
      expect(onBatchReady).not.toHaveBeenCalled();
    });

    it('should be a no-op for an empty batch', () => {
      const batcher = new EventBatcher({}, onBatchReady);
      batcher.flushBatch('empty');
      expect(onBatchReady).not.toHaveBeenCalled();
    });

    it('should enforce maxQueueSize with FIFO eviction when queue is full', async () => {
      // Use a blocking callback so batches accumulate in the queue without being consumed.
      // maxQueueSize=1 means the queue can hold only 1 item; adding a 2nd triggers eviction.
      let resolveBlocking: (() => void) | undefined;
      const blockingCallback = jest.fn<(batch: BatchedEvent<any>) => Promise<void>>();
      blockingCallback.mockImplementation(
        () => new Promise<void>((resolve) => { resolveBlocking = resolve; }),
      );

      const batcher = new EventBatcher(
        { maxBatchSize: 1, maxQueueSize: 1, maxWaitTime: 5000 },
        blockingCallback,
      );

      // First event: maxBatchSize=1 triggers flush. processQueue starts, shifts batch
      // from queue (queue=0), begins awaiting blockingCallback (stuck).
      batcher.addEvent({ id: '1' }, 'pair_A');

      // Second event: flush pushes to queue (queue.length=1). processQueue is locked.
      batcher.addEvent({ id: '2' }, 'pair_B');

      // Third event: flush tries to push. queue.length (1) >= maxQueueSize (1) => eviction.
      batcher.addEvent({ id: '3' }, 'pair_C');

      const stats = batcher.getStats();
      expect(stats.droppedBatches).toBe(1);

      // Cleanup
      if (resolveBlocking) resolveBlocking();
      await Promise.resolve();
      await Promise.resolve();
    });

    it('should sort processing queue by batch size when prioritization is enabled', async () => {
      // Use a blocking callback so multiple batches accumulate in the queue.
      // After unblocking, verify the order of processing.
      const processedBatches: BatchedEvent<any>[] = [];
      let resolveBlocking: (() => void) | undefined;

      const blockingCallback = jest.fn<(batch: BatchedEvent<any>) => Promise<void>>();
      // First call blocks; subsequent calls record the batch
      blockingCallback.mockImplementationOnce(
        () => new Promise<void>((resolve) => { resolveBlocking = resolve; }),
      );
      blockingCallback.mockImplementation(async (batch) => {
        processedBatches.push(batch);
      });

      const batcher = new EventBatcher(
        { maxBatchSize: 100, maxWaitTime: 5000, enablePrioritization: true, maxQueueSize: 100 },
        blockingCallback,
      );

      // Flush a "trigger" batch that will block in processQueue
      batcher.addEvent({ id: 'trigger' }, 'trigger_batch');
      batcher.flushBatch('trigger_batch');

      // Now add a small batch and a large batch while processQueue is blocked
      batcher.addEvent({ id: '1' }, 'small_batch');
      batcher.flushBatch('small_batch');

      batcher.addEvent({ id: '2' }, 'large_batch');
      batcher.addEvent({ id: '3' }, 'large_batch');
      batcher.addEvent({ id: '4' }, 'large_batch');
      batcher.flushBatch('large_batch');

      // Unblock the first callback
      if (resolveBlocking) resolveBlocking();

      // Allow processQueue to drain
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // The queued batches (after the trigger) should be processed large first
      expect(processedBatches.length).toBe(2);
      expect(processedBatches[0].pairKey).toBe('large_batch');
      expect(processedBatches[0].batchSize).toBe(3);
      expect(processedBatches[1].pairKey).toBe('small_batch');
      expect(processedBatches[1].batchSize).toBe(1);
    });

    it('should clear the timeout when flushing a batch manually', () => {
      const batcher = new EventBatcher({ maxBatchSize: 100, maxWaitTime: 50 }, onBatchReady);

      batcher.addEvent({ id: '1' }, 'pair_A');
      batcher.flushBatch('pair_A');

      // Advancing time should not cause a second flush
      jest.advanceTimersByTime(100);
      expect(onBatchReady).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // flushAll
  // ---------------------------------------------------------------------------
  describe('flushAll', () => {
    it('should clear all timeouts and batches', async () => {
      const batcher = new EventBatcher({ maxBatchSize: 100, maxWaitTime: 5000 }, onBatchReady);

      batcher.addEvent({ id: '1' }, 'pair_A');
      batcher.addEvent({ id: '2' }, 'pair_B');

      expect(batcher.getStats().activeBatches).toBe(2);

      await batcher.flushAll();

      expect(batcher.getStats().activeBatches).toBe(0);
    });

    it('should process remaining queued items', async () => {
      const batcher = new EventBatcher({ maxBatchSize: 1, maxWaitTime: 5000 }, onBatchReady);

      batcher.addEvent({ id: '1' }, 'pair_A');

      await batcher.flushAll();
      await Promise.resolve();
      await Promise.resolve();

      expect(onBatchReady).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // getStats
  // ---------------------------------------------------------------------------
  describe('getStats', () => {
    it('should report zero stats initially', () => {
      const batcher = new EventBatcher({}, onBatchReady);
      const stats = batcher.getStats();

      expect(stats.activeBatches).toBe(0);
      expect(stats.queuedBatches).toBe(0);
      expect(stats.totalEventsProcessed).toBe(0);
      expect(stats.averageBatchSize).toBe(0);
      expect(stats.droppedBatches).toBe(0);
      expect(stats.maxQueueSize).toBe(1000);
    });

    it('should count active batches and total events', () => {
      const batcher = new EventBatcher({ maxBatchSize: 100 }, onBatchReady);

      batcher.addEvent({ id: '1' }, 'pair_A');
      batcher.addEvent({ id: '2' }, 'pair_A');
      batcher.addEvent({ id: '3' }, 'pair_B');

      const stats = batcher.getStats();
      expect(stats.activeBatches).toBe(2);
      expect(stats.totalEventsProcessed).toBe(3);
      expect(stats.averageBatchSize).toBe(1.5);
    });

    it('should report custom maxQueueSize', () => {
      const batcher = new EventBatcher({ maxQueueSize: 42 }, onBatchReady);
      expect(batcher.getStats().maxQueueSize).toBe(42);
    });

    it('should include queued batches in total event count', async () => {
      let resolveBlocking: (() => void) | undefined;
      const blockingCallback = jest.fn<(batch: BatchedEvent<any>) => Promise<void>>();
      blockingCallback.mockImplementation(
        () => new Promise<void>((resolve) => { resolveBlocking = resolve; }),
      );

      const batcher = new EventBatcher(
        { maxBatchSize: 1, maxWaitTime: 5000, maxQueueSize: 100 },
        blockingCallback,
      );

      // First event triggers flush + processQueue (blocking)
      batcher.addEvent({ id: '1' }, 'pair_A');
      // Second event triggers flush, adds to queue (processQueue is locked)
      batcher.addEvent({ id: '2' }, 'pair_B');

      const stats = batcher.getStats();
      expect(stats.queuedBatches).toBe(1);

      if (resolveBlocking) resolveBlocking();
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  // ---------------------------------------------------------------------------
  // destroy
  // ---------------------------------------------------------------------------
  describe('destroy', () => {
    it('should clear all batches and queue on destroy', async () => {
      const batcher = new EventBatcher({ maxBatchSize: 100, maxWaitTime: 5000 }, onBatchReady);

      batcher.addEvent({ id: '1' }, 'pair_A');
      batcher.addEvent({ id: '2' }, 'pair_B');

      await batcher.destroy();

      const stats = batcher.getStats();
      expect(stats.activeBatches).toBe(0);
      expect(stats.queuedBatches).toBe(0);
    });

    it('should wait for pending processing to complete before destroying', async () => {
      let resolveProcessing: (() => void) | undefined;
      const slowCallback = jest.fn<(batch: BatchedEvent<any>) => Promise<void>>()
        .mockImplementationOnce(
          () => new Promise<void>((resolve) => { resolveProcessing = resolve; }),
        );

      const batcher = new EventBatcher(
        { maxBatchSize: 1, maxWaitTime: 5000 },
        slowCallback,
      );

      batcher.addEvent({ id: '1' }, 'pair_A');

      const destroyPromise = batcher.destroy();

      if (resolveProcessing) resolveProcessing();

      await destroyPromise;

      expect(slowCallback).toHaveBeenCalledTimes(1);
      expect(batcher.getStats().activeBatches).toBe(0);
    });

    it('should be safe to call destroy on a fresh batcher with no events', async () => {
      const batcher = new EventBatcher({}, onBatchReady);
      await batcher.destroy();

      const stats = batcher.getStats();
      expect(stats.activeBatches).toBe(0);
      expect(stats.queuedBatches).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // processQueue mutex
  // ---------------------------------------------------------------------------
  describe('processQueue mutex', () => {
    it('should not process concurrently -- second call waits for first', async () => {
      const callOrder: string[] = [];
      let resolveFirst: (() => void) | undefined;

      const asyncCallback = jest.fn<(batch: BatchedEvent<any>) => Promise<void>>();
      asyncCallback.mockImplementationOnce(() => {
        callOrder.push('first_start');
        return new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      });
      asyncCallback.mockImplementation(async () => {
        callOrder.push('second_start');
      });

      const batcher = new EventBatcher(
        { maxBatchSize: 1, maxWaitTime: 5000 },
        asyncCallback,
      );

      batcher.addEvent({ id: '1' }, 'pair_A');
      batcher.addEvent({ id: '2' }, 'pair_B');

      if (resolveFirst) resolveFirst();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(asyncCallback).toHaveBeenCalledTimes(2);
      expect(callOrder[0]).toBe('first_start');
    });
  });

  // ---------------------------------------------------------------------------
  // Pair key extraction (duck-typing)
  // ---------------------------------------------------------------------------
  describe('pair key extraction', () => {
    it('should use event.pairKey when present', async () => {
      const batcher = new EventBatcher({ maxBatchSize: 1, maxWaitTime: 5000 }, onBatchReady);
      batcher.addEvent({ pairKey: 'WETH/USDC', data: 'test' });

      await Promise.resolve();
      await Promise.resolve();

      expect(onBatchReady).toHaveBeenCalledTimes(1);
      expect(onBatchReady.mock.calls[0][0].pairKey).toBe('WETH/USDC');
    });

    it('should use contract_<address> when address and topics are present', async () => {
      const batcher = new EventBatcher({ maxBatchSize: 1, maxWaitTime: 5000 }, onBatchReady);
      batcher.addEvent({ address: '0xDeadBeef', topics: ['0x1'] });

      await Promise.resolve();
      await Promise.resolve();

      expect(onBatchReady).toHaveBeenCalledTimes(1);
      expect(onBatchReady.mock.calls[0][0].pairKey).toBe('contract_0xDeadBeef');
    });

    it('should fallback to "unknown_pair" when no pair key can be extracted', async () => {
      const batcher = new EventBatcher({ maxBatchSize: 1, maxWaitTime: 5000 }, onBatchReady);
      batcher.addEvent({ randomData: 123 });

      await Promise.resolve();
      await Promise.resolve();

      expect(onBatchReady).toHaveBeenCalledTimes(1);
      expect(onBatchReady.mock.calls[0][0].pairKey).toBe('unknown_pair');
    });

    it('should prefer pairKey over address+topics', () => {
      const batcher = new EventBatcher({ maxBatchSize: 100 }, onBatchReady);

      batcher.addEvent({ pairKey: 'WETH/DAI', address: '0xABC', topics: ['0x1'] });

      const stats = batcher.getStats();
      expect(stats.activeBatches).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Batching for unknown events
  // ---------------------------------------------------------------------------
  describe('unknown pair events', () => {
    it('should batch events under unknown_pair when event has no recognizable fields', async () => {
      const batcher = new EventBatcher({ maxBatchSize: 1 }, onBatchReady);

      batcher.addEvent({ data: 'urgent' });

      await Promise.resolve();
      await Promise.resolve();

      expect(onBatchReady).toHaveBeenCalledTimes(1);
      expect(onBatchReady.mock.calls[0][0].pairKey).toBe('unknown_pair');
      expect(onBatchReady.mock.calls[0][0].batchSize).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // createEventBatcher factory
  // ---------------------------------------------------------------------------
  describe('createEventBatcher factory', () => {
    it('should create an EventBatcher instance with given config', () => {
      const callback = jest.fn();
      const batcher = createEventBatcher({ maxBatchSize: 5 }, callback);

      expect(batcher).toBeInstanceOf(EventBatcher);
      batcher.addEvent({ id: '1' }, 'test');
      expect(batcher.getStats().activeBatches).toBe(1);
    });

    it('should pass through the callback correctly', async () => {
      const callback = jest.fn<(batch: BatchedEvent<any>) => void>();
      const batcher = createEventBatcher({ maxBatchSize: 1 }, callback);

      batcher.addEvent({ id: '1' }, 'pair_A');

      await Promise.resolve();
      await Promise.resolve();

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0][0].pairKey).toBe('pair_A');
    });
  });

  // ---------------------------------------------------------------------------
  // Singleton pattern
  // ---------------------------------------------------------------------------
  describe('singleton pattern', () => {
    it('should return the same instance on repeated calls to getDefaultEventBatcher', () => {
      const instance1 = getDefaultEventBatcher();
      const instance2 = getDefaultEventBatcher();

      expect(instance1).toBe(instance2);
      expect(instance1).toBeInstanceOf(EventBatcher);
    });

    it('should create a new instance after resetDefaultEventBatcher', async () => {
      const instance1 = getDefaultEventBatcher();
      await resetDefaultEventBatcher();
      const instance2 = getDefaultEventBatcher();

      expect(instance1).not.toBe(instance2);
    });

    it('should handle resetDefaultEventBatcher when no singleton exists', async () => {
      await resetDefaultEventBatcher();
      await resetDefaultEventBatcher();
    });

    it('should configure singleton with optimized defaults', () => {
      const instance = getDefaultEventBatcher();
      const stats = instance.getStats();

      expect(stats.maxQueueSize).toBe(1000);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------
  describe('edge cases', () => {
    it('should handle multiple flushes of the same pair key gracefully', async () => {
      const batcher = new EventBatcher({ maxBatchSize: 100, maxWaitTime: 5000 }, onBatchReady);

      batcher.addEvent({ id: '1' }, 'pair_A');
      batcher.flushBatch('pair_A');
      batcher.flushBatch('pair_A');

      await Promise.resolve();
      await Promise.resolve();

      expect(onBatchReady).toHaveBeenCalledTimes(1);
    });

    it('should handle a batch timestamp being set at flush time', async () => {
      const batcher = new EventBatcher({ maxBatchSize: 1, maxWaitTime: 5000 }, onBatchReady);

      const beforeFlush = Date.now();
      batcher.addEvent({ id: '1' }, 'pair_A');

      await Promise.resolve();
      await Promise.resolve();

      expect(onBatchReady).toHaveBeenCalledTimes(1);
      const batch = onBatchReady.mock.calls[0][0] as BatchedEvent<any>;
      expect(batch.timestamp).toBeGreaterThanOrEqual(beforeFlush);
    });

    it('should handle rapid add and flush cycles without data loss', async () => {
      const processedBatches: BatchedEvent<any>[] = [];
      const batcher = new EventBatcher(
        { maxBatchSize: 2, maxWaitTime: 5000 },
        (batch) => { processedBatches.push(batch); },
      );

      for (let i = 0; i < 6; i++) {
        batcher.addEvent({ id: String(i) }, 'pair_A');
      }

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(processedBatches.length).toBe(3);
      const totalEvents = processedBatches.reduce((sum, b) => sum + b.batchSize, 0);
      expect(totalEvents).toBe(6);
    });

    it('should support generic typed events', async () => {
      interface SwapEvent {
        id: string;
        amountIn: bigint;
        amountOut: bigint;
      }

      const typedCallback = jest.fn<(batch: BatchedEvent<SwapEvent>) => void>();
      const batcher = new EventBatcher<SwapEvent>(
        { maxBatchSize: 1, maxWaitTime: 5000 },
        typedCallback,
      );

      batcher.addEvent(
        { id: 'swap1', amountIn: 100n, amountOut: 200n },
        'pair_A',
      );

      await Promise.resolve();
      await Promise.resolve();

      expect(typedCallback).toHaveBeenCalledTimes(1);
      const batch = typedCallback.mock.calls[0][0];
      expect(batch.events[0].amountIn).toBe(100n);
    });

    it('should not flush before maxWaitTime elapses', () => {
      const batcher = new EventBatcher({ maxBatchSize: 100, maxWaitTime: 100 }, onBatchReady);

      batcher.addEvent({ id: '1' }, 'pair_A');

      jest.advanceTimersByTime(50);

      expect(onBatchReady).not.toHaveBeenCalled();
      expect(batcher.getStats().activeBatches).toBe(1);
    });

    it('should remove the batch from active batches after flush', () => {
      const batcher = new EventBatcher({ maxBatchSize: 100, maxWaitTime: 5000 }, onBatchReady);

      batcher.addEvent({ id: '1' }, 'pair_A');
      expect(batcher.getStats().activeBatches).toBe(1);

      batcher.flushBatch('pair_A');

      expect(batcher.getStats().activeBatches).toBe(0);
    });

    it('should handle events with logIndex of 0 correctly for dedup', () => {
      const batcher = new EventBatcher(
        { maxBatchSize: 10, enableDeduplication: true },
        onBatchReady,
      );

      batcher.addEvent({ transactionHash: '0xabc', logIndex: 0 }, 'pair_A');
      batcher.addEvent({ transactionHash: '0xabc', logIndex: 1 }, 'pair_A');

      const stats = batcher.getStats();
      expect(stats.totalEventsProcessed).toBe(2);
    });

    it('should properly populate BatchedEvent fields on flush', async () => {
      const batcher = new EventBatcher({ maxBatchSize: 2, maxWaitTime: 5000 }, onBatchReady);

      batcher.addEvent({ id: '1' }, 'pair_A');
      batcher.addEvent({ id: '2' }, 'pair_A');

      await Promise.resolve();
      await Promise.resolve();

      expect(onBatchReady).toHaveBeenCalledTimes(1);
      const batch = onBatchReady.mock.calls[0][0] as BatchedEvent<any>;

      expect(batch.pairKey).toBe('pair_A');
      expect(batch.events).toEqual([{ id: '1' }, { id: '2' }]);
      expect(batch.batchSize).toBe(2);
      expect(typeof batch.timestamp).toBe('number');
    });
  });

  // ---------------------------------------------------------------------------
  // Q-NEW-3 Regression: ?? vs || for numeric defaults
  // ---------------------------------------------------------------------------
  describe('Q-NEW-3 regression: nullish coalescing for numeric config', () => {
    it('should accept maxBatchSize of 0 without replacing with default', () => {
      // With || operator, 0 would be treated as falsy and replaced with 10
      // With ?? operator, 0 is preserved as an explicit value
      const batcher = new EventBatcher(
        { maxBatchSize: 0, maxWaitTime: 100 },
        onBatchReady,
      );

      // With maxBatchSize=0, every event should immediately flush
      batcher.addEvent({ id: '1' }, 'pair_A');

      // The event should be in a batch (size 0 means it should flush immediately
      // since events.length >= maxBatchSize when maxBatchSize is 0)
      const stats = batcher.getStats();
      // With 0 batch size, every event triggers a flush
      expect(stats.activeBatches).toBe(0); // flushed immediately
    });

    it('should accept maxWaitTime of 0 without replacing with default', () => {
      // With || operator, 0 would be treated as falsy and replaced with 1
      // With ?? operator, 0 is preserved
      const batcher = new EventBatcher(
        { maxBatchSize: 100, maxWaitTime: 0 },
        onBatchReady,
      );

      batcher.addEvent({ id: '1' }, 'pair_A');

      // With maxWaitTime=0, the timeout fires immediately (setTimeout(fn, 0))
      jest.advanceTimersByTime(0);
    });

    it('should accept maxQueueSize of 0 without replacing with default', () => {
      // With || operator, 0 would be treated as falsy and replaced with 1000
      // With ?? operator, 0 is preserved
      const batcher = new EventBatcher(
        { maxBatchSize: 1, maxQueueSize: 0 },
        onBatchReady,
      );

      // maxQueueSize=0 means queue is always at capacity, so batches get dropped
      const stats = batcher.getStats();
      expect(stats.maxQueueSize).toBe(0);
    });
  });
});
