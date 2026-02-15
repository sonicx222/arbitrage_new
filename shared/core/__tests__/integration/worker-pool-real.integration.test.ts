/**
 * Real Worker Pool Integration Tests
 *
 * Finding #16: These tests exercise EventProcessingWorkerPool with
 * REAL worker threads (no mocking of worker_threads module).
 * Uses a minimal test worker script that implements the same message
 * protocol as event-processor-worker.ts.
 *
 * @see shared/core/__tests__/fixtures/test-worker.js — Test worker script
 * @see shared/core/src/async/worker-pool.ts — Worker pool implementation
 */

import { describe, it, expect, afterEach } from '@jest/globals';
import * as path from 'path';

// Do NOT mock worker_threads — we want real workers
// Do NOT mock logger — it's fine for integration tests

import { EventProcessingWorkerPool, Task } from '../../src/async/worker-pool';

const TEST_WORKER_PATH = path.join(__dirname, '..', 'fixtures', 'test-worker.js');

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
    expect(result.result.parsed).toEqual(jsonData);
    expect(result.result.byteLength).toBeGreaterThan(0);
    expect(result.result.parseTimeUs).toBeGreaterThanOrEqual(0);
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
    expect(result.result.successCount).toBe(2);
    expect(result.result.errorCount).toBe(1);
    expect(result.result.results).toHaveLength(3);
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
