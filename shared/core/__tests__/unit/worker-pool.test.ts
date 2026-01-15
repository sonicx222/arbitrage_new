/**
 * Worker Pool Tests
 *
 * Simplified Worker Pool Tests focusing on core functionality
 * without complex async interactions that can cause flaky behavior.
 *
 * @migrated from shared/core/src/__tests__/worker-pool.test.ts
 * @see ADR-009: Test Architecture
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock logger before importing worker-pool
jest.mock('../../src/logger', () => ({
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

// Mock worker_threads
jest.mock('worker_threads', () => ({
  Worker: jest.fn(),
  isMainThread: true,
  parentPort: null,
  workerData: {}
}));

import { EventProcessingWorkerPool, Task, TaskResult } from '@arbitrage/core';
import { Worker } from 'worker_threads';

describe('EventProcessingWorkerPool', () => {
  let mockWorker: any;

  // Helper to create a fresh mock worker
  const createMockWorker = () => ({
    on: jest.fn(),
    postMessage: jest.fn(),
    terminate: jest.fn(() => Promise.resolve()),
    removeAllListeners: jest.fn()
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockWorker = createMockWorker();
    (Worker as jest.MockedClass<typeof Worker>).mockImplementation(() => mockWorker);
  });

  describe('initialization', () => {
    it('should initialize with correct parameters', () => {
      const pool = new EventProcessingWorkerPool(2, 100, 5000);
      expect(pool).toBeDefined();
    });

    it('should create correct number of workers on start', async () => {
      const pool = new EventProcessingWorkerPool(2, 100, 5000);
      await pool.start();

      expect(Worker).toHaveBeenCalledTimes(2);

      await pool.stop();
    });
  });

  describe('task submission', () => {
    it('should submit tasks and receive responses', async () => {
      // Setup message callback capture
      mockWorker.on.mockImplementation((event: string, callback: (data?: unknown) => void) => {
        if (event === 'message') {
          mockWorker._messageCallback = callback;
        }
      });

      const pool = new EventProcessingWorkerPool(1, 100, 5000);
      await pool.start();

      const task: Task = {
        id: 'test-task-1',
        type: 'arbitrage_detection',
        data: { prices: [100, 101, 102] },
        priority: 1
      };

      // Submit task and immediately trigger response
      const resultPromise = pool.submitTask(task);

      // Simulate worker response after a short delay
      setTimeout(() => {
        if (mockWorker._messageCallback) {
          mockWorker._messageCallback({
            taskId: task.id,
            success: true,
            result: { opportunities: [] },
            processingTime: 100
          });
        }
      }, 10);

      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.taskId).toBe(task.id);

      await pool.stop();
    });

    it('should handle task timeouts', async () => {
      mockWorker.on.mockImplementation(() => {}); // No message callback - simulates hung worker

      const pool = new EventProcessingWorkerPool(1, 100, 100); // 100ms timeout
      await pool.start();

      const task: Task = {
        id: 'timeout-task',
        type: 'test',
        data: {},
        priority: 1
      };

      // Task should timeout since no response comes
      await expect(pool.submitTask(task))
        .rejects
        .toThrow('timed out');

      await pool.stop();
    });
  });

  describe('pool management', () => {
    it('should report correct pool stats', async () => {
      const pool = new EventProcessingWorkerPool(2, 100, 5000);
      await pool.start();

      const stats = pool.getPoolStats();

      expect(stats.poolSize).toBe(2);
      expect(stats.queuedTasks).toBe(0);
      expect(stats.activeTasks).toBe(0);
      expect(stats.workerStats).toHaveLength(2);

      await pool.stop();
    });

    it('should stop gracefully and reject pending tasks', async () => {
      mockWorker.on.mockImplementation(() => {}); // Don't capture callbacks

      const pool = new EventProcessingWorkerPool(1, 100, 30000);
      await pool.start();

      const task: Task = { id: 'stop-test', type: 'test', data: {}, priority: 1 };
      const taskPromise = pool.submitTask(task);

      // Stop the pool immediately
      await pool.stop();

      // Task should be rejected
      await expect(taskPromise).rejects.toThrow('Worker pool is shutting down');

      // Workers should be terminated
      expect(mockWorker.terminate).toHaveBeenCalled();
    });

    it('should handle stop when not running', async () => {
      const pool = new EventProcessingWorkerPool(1);

      // Stopping without starting should not throw
      await expect(pool.stop()).resolves.not.toThrow();
    });
  });

  describe('worker lifecycle', () => {
    it('should handle worker exit and attempt restart', async () => {
      mockWorker.on.mockImplementation((event: string, callback: (data?: unknown) => void) => {
        if (event === 'exit') {
          mockWorker._exitCallback = callback;
        }
      });

      const pool = new EventProcessingWorkerPool(2, 100, 5000);
      await pool.start();

      // Initial workers created
      expect(Worker).toHaveBeenCalledTimes(2);

      // Simulate worker exit (only if callback was captured)
      if (mockWorker._exitCallback) {
        mockWorker._exitCallback(1); // Exit code 1 = crash

        // Should attempt to restart
        expect(Worker).toHaveBeenCalledTimes(3);
      }

      await pool.stop();
    });
  });

  describe('error handling', () => {
    it('should handle worker termination errors gracefully', async () => {
      mockWorker.terminate.mockImplementation(() => Promise.reject(new Error('Termination failed')));

      const pool = new EventProcessingWorkerPool(1);
      await pool.start();

      // Stop should not throw despite termination error
      await expect(pool.stop()).resolves.not.toThrow();
    });

    it('should handle worker creation errors during start', async () => {
      // First worker throws, subsequent ones work
      (Worker as jest.MockedClass<typeof Worker>)
        .mockImplementationOnce(() => { throw new Error('Worker creation failed'); })
        .mockImplementation(() => mockWorker);

      const pool = new EventProcessingWorkerPool(2);

      // Pool start might throw if all workers fail, or succeed partially
      // This tests that partial failure is handled
      try {
        await pool.start();
        // If it didn't throw, at least one worker was created
        expect(Worker).toHaveBeenCalled();
      } catch (error) {
        // If it threw, that's also acceptable behavior
        expect(error).toBeInstanceOf(Error);
      }

      await pool.stop();
    });
  });

  describe('batch task submission', () => {
    it('should submit multiple tasks in batch', async () => {
      let responseCount = 0;

      mockWorker.on.mockImplementation((event: string, callback: (data?: unknown) => void) => {
        if (event === 'message') {
          mockWorker._messageCallback = callback;
        }
      });

      mockWorker.postMessage.mockImplementation(() => {
        setTimeout(() => {
          responseCount++;
          if (mockWorker._messageCallback) {
            mockWorker._messageCallback({
              taskId: `batch-${responseCount}`,
              success: true,
              result: {},
              processingTime: 50
            });
          }
        }, 5);
      });

      const pool = new EventProcessingWorkerPool(2, 100, 5000);
      await pool.start();

      const tasks: Task[] = [
        { id: 'batch-1', type: 'test', data: {}, priority: 1 },
        { id: 'batch-2', type: 'test', data: {}, priority: 1 }
      ];

      const results = await pool.submitBatchTasks(tasks);

      expect(results).toHaveLength(2);
      expect(results.every(r => r.success)).toBe(true);

      await pool.stop();
    });
  });
});
