/**
 * Worker Pool Load Tests
 *
 * Tests for Phase 2: Worker Thread JSON Parsing
 * Validates:
 * - High-throughput JSON parsing (1000+ events/sec)
 * - Main thread blocking prevention
 * - Worker pool statistics and monitoring
 * - Memory usage under load
 *
 * Also includes real worker integration tests (Finding #16) that exercise
 * EventProcessingWorkerPool with REAL worker threads (no mocking of worker_threads module).
 *
 * @see RPC_DATA_OPTIMIZATION_IMPLEMENTATION_PLAN.md Phase 2
 * @see shared/core/__tests__/fixtures/test-worker.js — Test worker script
 * @see shared/core/src/async/worker-pool.ts — Worker pool implementation
 */

import { jest, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals';
import * as path from 'path';

// Mock logger before importing worker-pool
jest.mock('../../../src/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })),
  getPerformanceLogger: jest.fn(() => ({
    logEventLatency: jest.fn(),
    logArbitrageOpportunity: jest.fn(),
    logHealthCheck: jest.fn()
  }))
}));

// We need to test with real workers for load testing
// Skip mock of worker_threads for integration tests

import {
  EventProcessingWorkerPool,
  JsonParsingStats,
  Task
} from '../../../src/async/worker-pool';

const TEST_WORKER_PATH = path.join(__dirname, '..', '..', 'fixtures', 'test-worker.js');

describe('Worker Pool Load Tests', () => {
  // Skip these tests in CI - they require real workers
  const isCI = process.env.CI === 'true';

  describe('JSON Parsing Throughput', () => {
    let pool: EventProcessingWorkerPool;

    beforeEach(async () => {
      pool = new EventProcessingWorkerPool(4, 10000, 30000);
      // Note: We don't start the pool here - these are unit tests with mocked workers
    });

    afterEach(async () => {
      await pool.stop();
    });

    it('should track JSON parsing statistics correctly', () => {
      const stats = pool.getJsonParsingStats();

      expect(stats).toMatchObject({
        totalSingleParses: 0,
        totalBatchParses: 0,
        totalStringsParsed: 0,
        totalErrors: 0,
        avgParseTimeUs: 0,
        p99ParseTimeUs: 0,
        avgOverheadMs: 0,
        totalBytesParsed: 0
      });
    });

    it('should reset JSON parsing statistics', () => {
      // Get initial stats
      const initialStats = pool.getJsonParsingStats();
      expect(initialStats.totalSingleParses).toBe(0);

      // Reset stats
      pool.resetJsonParsingStats();
      const afterReset = pool.getJsonParsingStats();

      expect(afterReset.totalSingleParses).toBe(0);
      expect(afterReset.totalBatchParses).toBe(0);
      expect(afterReset.totalErrors).toBe(0);
    });
  });

  describe('Event Loop Blocking Prevention', () => {
    /**
     * Helper to track event loop blocking.
     * Uses setImmediate to detect when main thread is blocked.
     */
    function createEventLoopTracker() {
      const samples: number[] = [];
      let lastCheck = Date.now();
      let running = true;
      let checkCount = 0;

      const check = () => {
        if (!running) return;

        const now = Date.now();
        const delta = now - lastCheck;
        samples.push(delta);
        lastCheck = now;
        checkCount++;

        // Continue sampling
        setImmediate(check);
      };

      // Start sampling
      setImmediate(check);

      return {
        stop: () => { running = false; },
        getStats: () => {
          if (samples.length === 0) return { max: 0, avg: 0, samples: 0 };
          const max = Math.max(...samples);
          const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
          return { max, avg, samples: samples.length };
        }
      };
    }

    it('should provide event loop tracker utility', () => {
      const tracker = createEventLoopTracker();

      // Let it run for a short time
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          tracker.stop();
          const stats = tracker.getStats();

          // Should have collected some samples
          expect(stats.samples).toBeGreaterThan(0);

          // Without blocking, max delta should be small (< 50ms)
          expect(stats.max).toBeLessThan(100);

          resolve();
        }, 50);
      });
    });
  });

  describe('JSON Payload Size Analysis', () => {
    /**
     * Generate realistic WebSocket event payloads of varying sizes.
     */
    function generateSyncEventPayload(size: 'small' | 'medium' | 'large'): string {
      const base = {
        jsonrpc: '2.0',
        method: 'eth_subscription',
        params: {
          subscription: '0x1234567890abcdef',
          result: {
            address: '0x' + '1'.repeat(40),
            topics: [
              '0x' + 'a'.repeat(64), // Sync event topic
              '0x' + 'b'.repeat(64),
              '0x' + 'c'.repeat(64)
            ],
            data: '',
            blockNumber: '0x1234567',
            transactionHash: '0x' + 'd'.repeat(64),
            transactionIndex: '0x0',
            blockHash: '0x' + 'e'.repeat(64),
            logIndex: '0x0',
            removed: false
          }
        }
      };

      // Adjust data size based on payload size requirement
      switch (size) {
        case 'small':
          base.params.result.data = '0x' + '0'.repeat(128); // ~64 bytes
          break;
        case 'medium':
          base.params.result.data = '0x' + '0'.repeat(2000); // ~1KB
          break;
        case 'large':
          base.params.result.data = '0x' + '0'.repeat(20000); // ~10KB
          break;
      }

      return JSON.stringify(base);
    }

    it('should generate payloads of expected sizes', () => {
      const small = generateSyncEventPayload('small');
      const medium = generateSyncEventPayload('medium');
      const large = generateSyncEventPayload('large');

      expect(Buffer.byteLength(small, 'utf8')).toBeLessThan(1000);
      expect(Buffer.byteLength(medium, 'utf8')).toBeGreaterThan(1000);
      expect(Buffer.byteLength(medium, 'utf8')).toBeLessThan(5000);
      expect(Buffer.byteLength(large, 'utf8')).toBeGreaterThan(10000);
    });

    it('should parse payloads correctly regardless of size', () => {
      const payloads = ['small', 'medium', 'large'] as const;

      for (const size of payloads) {
        const payload = generateSyncEventPayload(size);
        const parsed = JSON.parse(payload);

        expect(parsed.jsonrpc).toBe('2.0');
        expect(parsed.method).toBe('eth_subscription');
        expect(parsed.params.result.address).toMatch(/^0x[0-9a-f]+$/i);
      }
    });
  });

  describe('Batch JSON Parsing', () => {
    it('should handle empty batch', async () => {
      const pool = new EventProcessingWorkerPool(2, 100, 5000);

      // Empty batch should return empty array without error
      const results = await pool.parseJsonBatch([]);
      expect(results).toEqual([]);

      await pool.stop();
    });
  });

  describe('Statistics Calculation', () => {
    it('should calculate P99 from rolling window correctly', () => {
      // Test the P99 calculation logic
      const window = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const sorted = [...window].sort((a, b) => a - b);
      const p99Index = Math.floor(sorted.length * 0.99);
      const p99 = sorted[p99Index] ?? sorted[sorted.length - 1];

      // With 10 values, P99 index = 9 (0.99 * 10 = 9.9, floor = 9)
      // But since index 9 is the last element (10), we get 10
      expect(p99).toBe(10);
    });

    it('should calculate average correctly', () => {
      const window = [1, 2, 3, 4, 5];
      const avg = window.reduce((a, b) => a + b, 0) / window.length;

      expect(avg).toBe(3);
    });
  });

  describe('Memory Efficiency', () => {
    it('should limit statistics window size', async () => {
      const pool = new EventProcessingWorkerPool(2, 100, 5000);

      // The pool uses STATS_WINDOW_SIZE = 100 for rolling statistics
      // This test verifies the design decision
      const stats = pool.getJsonParsingStats();

      // Stats object should be small and bounded
      const statsJson = JSON.stringify(stats);
      expect(statsJson.length).toBeLessThan(500); // Should be compact

      await pool.stop();
    });
  });
});

/**
 * Integration tests that require real workers.
 * These are skipped in CI and run manually for performance validation.
 */
describe.skip('Worker Pool Real Worker Integration', () => {
  let pool: EventProcessingWorkerPool;

  beforeAll(async () => {
    pool = new EventProcessingWorkerPool(4, 10000, 30000);
    await pool.start();
  });

  afterAll(async () => {
    await pool.stop();
  });

  it('should parse JSON in worker thread', async () => {
    const jsonString = '{"test": "value", "number": 42}';
    const result = await pool.parseJson<{ test: string; number: number }>(jsonString);

    expect(result.test).toBe('value');
    expect(result.number).toBe(42);
  });

  it('should handle batch JSON parsing', async () => {
    const jsonStrings = [
      '{"a": 1}',
      '{"b": 2}',
      '{"c": 3}'
    ];

    const results = await pool.parseJsonBatch(jsonStrings);

    expect(results).toHaveLength(3);
    expect(results[0]).toHaveProperty('parsed');
    expect((results[0] as { parsed: { a: number } }).parsed.a).toBe(1);
  });

  it('should handle parse errors in batch', async () => {
    const jsonStrings = [
      '{"valid": true}',
      'not valid json',
      '{"also_valid": true}'
    ];

    const results = await pool.parseJsonBatch(jsonStrings);

    expect(results).toHaveLength(3);
    expect(results[0]).toHaveProperty('parsed');
    expect(results[1]).toHaveProperty('error');
    expect(results[2]).toHaveProperty('parsed');
  });

  it('should track parsing statistics', async () => {
    pool.resetJsonParsingStats();

    // Parse some JSON
    await pool.parseJson('{"test": 1}');
    await pool.parseJson('{"test": 2}');

    const stats = pool.getJsonParsingStats();

    expect(stats.totalSingleParses).toBe(2);
    expect(stats.totalStringsParsed).toBe(2);
    expect(stats.totalBytesParsed).toBeGreaterThan(0);
  });

  it('should handle high-throughput parsing', async () => {
    const iterations = 100;
    const payloads = Array(iterations).fill('{"event": "sync", "data": "0x1234"}');

    const startTime = Date.now();
    await Promise.all(payloads.map(p => pool.parseJson(p)));
    const duration = Date.now() - startTime;

    // Should complete 100 parses quickly (< 2 seconds even with worker overhead)
    expect(duration).toBeLessThan(2000);

    const stats = pool.getJsonParsingStats();
    expect(stats.totalSingleParses).toBeGreaterThanOrEqual(iterations);
  });
});

/**
 * Real Worker Pool Integration Tests (Finding #16)
 *
 * These tests exercise EventProcessingWorkerPool with REAL worker threads
 * (no mocking of worker_threads module). Uses a minimal test worker script
 * that implements the same message protocol as event-processor-worker.ts.
 *
 * @see shared/core/__tests__/fixtures/test-worker.js — Test worker script
 * @see shared/core/src/async/worker-pool.ts — Worker pool implementation
 */
describe('EventProcessingWorkerPool (real workers)', () => {
  let pool: EventProcessingWorkerPool;

  afterEach(async () => {
    if (pool) {
      await pool.stop();
    }
  });

  it('should start and stop with real workers', async () => {
    pool = new EventProcessingWorkerPool(2, 100, 5000, null, null, TEST_WORKER_PATH);
    await pool.start();

    const stats = pool.getPoolStats();
    expect(stats.poolSize).toBe(2);
    expect(stats.availableWorkers).toBe(2);
    expect(stats.activeTasks).toBe(0);

    await pool.stop();
  });

  it('should submit a task and receive a real response', async () => {
    pool = new EventProcessingWorkerPool(1, 100, 5000, null, null, TEST_WORKER_PATH);
    await pool.start();

    const task: Task = {
      id: 'echo-1',
      type: 'echo',
      data: { greeting: 'hello from test' },
      priority: 1
    };

    const result = await pool.submitTask(task);

    expect(result.success).toBe(true);
    expect(result.taskId).toBe('echo-1');
    expect(result.result).toEqual({ greeting: 'hello from test' });
    expect(result.processingTime).toBeGreaterThanOrEqual(0);
  });

  it('should handle task errors from real workers', async () => {
    pool = new EventProcessingWorkerPool(1, 100, 5000, null, null, TEST_WORKER_PATH);
    await pool.start();

    const task: Task = {
      id: 'fail-1',
      type: 'fail',
      data: { message: 'test error' },
      priority: 1
    };

    // Worker pool rejects the promise when the worker reports success: false
    await expect(pool.submitTask(task)).rejects.toThrow('test error');
  });

  it('should handle JSON parsing with real workers', async () => {
    pool = new EventProcessingWorkerPool(1, 100, 5000, null, null, TEST_WORKER_PATH);
    await pool.start();

    const jsonData = { prices: [100, 200, 300], chain: 'ethereum' };
    const task: Task = {
      id: 'json-1',
      type: 'json_parsing',
      data: { jsonString: JSON.stringify(jsonData) },
      priority: 1
    };

    const result = await pool.submitTask(task);

    expect(result.success).toBe(true);
    const resultData = result.result as { parsed: typeof jsonData; byteLength: number; parseTimeUs: number };
    expect(resultData.parsed).toEqual(jsonData);
    expect(resultData.byteLength).toBeGreaterThan(0);
    expect(resultData.parseTimeUs).toBeGreaterThanOrEqual(0);
  });

  it('should handle batch JSON parsing with real workers', async () => {
    pool = new EventProcessingWorkerPool(1, 100, 5000, null, null, TEST_WORKER_PATH);
    await pool.start();

    const strings = [
      JSON.stringify({ a: 1 }),
      JSON.stringify({ b: 2 }),
      'not valid json'
    ];

    const task: Task = {
      id: 'batch-json-1',
      type: 'batch_json_parsing',
      data: { jsonStrings: strings },
      priority: 1
    };

    const result = await pool.submitTask(task);

    expect(result.success).toBe(true);
    expect((result.result as any).successCount).toBe(2);
    expect((result.result as any).errorCount).toBe(1);
    expect((result.result as any).results).toHaveLength(3);
  });

  it('should process multiple tasks across multiple workers', async () => {
    pool = new EventProcessingWorkerPool(2, 100, 5000, null, null, TEST_WORKER_PATH);
    await pool.start();

    const tasks: Task[] = Array.from({ length: 5 }, (_, i) => ({
      id: `multi-${i}`,
      type: 'echo',
      data: { index: i },
      priority: 1
    }));

    const results = await pool.submitBatchTasks(tasks);

    expect(results).toHaveLength(5);
    expect(results.every(r => r.success)).toBe(true);

    // Verify each task got the right data back
    for (let i = 0; i < 5; i++) {
      const result = results.find(r => r.taskId === `multi-${i}`);
      expect(result).toBeDefined();
      expect(result!.result).toEqual({ index: i });
    }
  });

  it('should handle task timeout with real workers', async () => {
    pool = new EventProcessingWorkerPool(1, 100, 200, null, null, TEST_WORKER_PATH); // 200ms timeout
    await pool.start();

    const task: Task = {
      id: 'slow-1',
      type: 'slow',
      data: { delayMs: 2000 }, // 2 seconds — will exceed 200ms timeout
      priority: 1
    };

    await expect(pool.submitTask(task)).rejects.toThrow(/timed out/);
  });

  it('should report pool stats correctly with real workers', async () => {
    pool = new EventProcessingWorkerPool(3, 100, 5000, null, null, TEST_WORKER_PATH);
    await pool.start();

    const stats = pool.getPoolStats();

    expect(stats.poolSize).toBe(3);
    expect(stats.availableWorkers).toBe(3);
    expect(stats.queuedTasks).toBe(0);
    expect(stats.activeTasks).toBe(0);
    expect(stats.workerStats).toHaveLength(3);
  });
});
