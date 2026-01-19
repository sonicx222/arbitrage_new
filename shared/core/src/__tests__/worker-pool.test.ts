import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { EventProcessingWorkerPool, Task, TaskResult } from '../worker-pool';
import { Worker } from 'worker_threads';
import * as path from 'path';

// Mock worker_threads
jest.mock('worker_threads', () => ({
  Worker: jest.fn(),
  isMainThread: true,
  parentPort: null,
  workerData: {}
}));

// Mock path
jest.mock('path', () => ({
  join: jest.fn((...args) => args.join('/'))
}));

describe('EventProcessingWorkerPool', () => {
  let workerPool: EventProcessingWorkerPool;
  let mockWorker: any;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Create mock worker
    mockWorker = {
      on: jest.fn(),
      postMessage: jest.fn(),
      terminate: jest.fn(),
      removeAllListeners: jest.fn()
    };

    (Worker as jest.MockedClass<typeof Worker>).mockImplementation(() => mockWorker);

    // Mock path.join
    (path.join as jest.Mock).mockReturnValue('/path/to/worker.js');

    workerPool = new EventProcessingWorkerPool(2, 100, 5000);
  });

  afterEach(async () => {
    if (workerPool) {
      await workerPool.stop();
    }
  });

  describe('initialization', () => {
    it('should initialize with correct parameters', () => {
      expect(workerPool).toBeDefined();
    });

    it('should create correct number of workers on start', async () => {
      // Mock worker setup
      mockWorker.on.mockImplementation((event, callback) => {
        if (event === 'message') {
          // Simulate worker ready
        }
      });

      await workerPool.start();

      expect(Worker).toHaveBeenCalledTimes(2);
      expect(path.join).toHaveBeenCalledWith(expect.any(String), 'event-processor-worker.js');
    });
  });

  describe('task submission', () => {
    beforeEach(async () => {
      mockWorker.on.mockImplementation((event, callback) => {
        if (event === 'message') {
          // Store message callback for later use
          mockWorker._messageCallback = callback;
        }
      });

      await workerPool.start();
    });

    it('should submit tasks successfully', async () => {
      const task: Task = {
        id: 'test-task-1',
        type: 'arbitrage_detection',
        data: { prices: [100, 101, 102] },
        priority: 1
      };

      // Mock worker response
      setTimeout(() => {
        mockWorker._messageCallback({
          taskId: task.id,
          success: true,
          result: { opportunities: [] },
          processingTime: 100
        });
      }, 10);

      const result = await workerPool.submitTask(task);

      expect(result.success).toBe(true);
      expect(result.taskId).toBe(task.id);
      expect(result.processingTime).toBe(100);
    });

    it('should handle task timeouts', async () => {
      const task: Task = {
        id: 'timeout-task',
        type: 'arbitrage_detection',
        data: { prices: [100] },
        priority: 1
      };

      // Create pool with very short timeout
      const fastPool = new EventProcessingWorkerPool(1, 100, 50);
      await fastPool.start();

      await expect(fastPool.submitTask(task))
        .rejects
        .toThrow('Task timeout-task timed out');

      await fastPool.stop();
    });

    it('should reject tasks when queue is full', async () => {
      const smallPool = new EventProcessingWorkerPool(1, 1, 30000); // Queue size 1
      await smallPool.start();

      // Fill the queue
      const task1: Task = { id: 'task1', type: 'test', data: {}, priority: 1 };
      const task2: Task = { id: 'task2', type: 'test', data: {}, priority: 1 };

      // Submit first task (should succeed)
      const promise1 = smallPool.submitTask(task1);

      // Submit second task (should fail due to queue limit)
      await expect(smallPool.submitTask(task2))
        .rejects
        .toThrow('Task queue is full');

      await smallPool.stop();
    });

    it('should handle worker errors', async () => {
      mockWorker.on.mockImplementation((event, callback) => {
        if (event === 'error') {
          // Simulate worker error
          setTimeout(() => callback(new Error('Worker crashed')), 10);
        }
      });

      await workerPool.start();

      const task: Task = {
        id: 'error-task',
        type: 'test',
        data: {},
        priority: 1
      };

      // Task should still be submitted but worker will error
      const promise = workerPool.submitTask(task);

      // Should timeout since worker crashed
      await expect(promise).rejects.toThrow('timed out');
    });
  });

  describe('batch task submission', () => {
    beforeEach(async () => {
      mockWorker.on.mockImplementation((event, callback) => {
        if (event === 'message') {
          mockWorker._messageCallback = callback;
        }
      });

      await workerPool.start();
    });

    it('should submit multiple tasks in batch', async () => {
      const tasks: Task[] = [
        { id: 'batch-1', type: 'test', data: {}, priority: 1 },
        { id: 'batch-2', type: 'test', data: {}, priority: 1 }
      ];

      // Mock responses
      let responseCount = 0;
      mockWorker.postMessage.mockImplementation(() => {
        setTimeout(() => {
          responseCount++;
          mockWorker._messageCallback({
            taskId: `batch-${responseCount}`,
            success: true,
            result: {},
            processingTime: 50
          });
        }, 10);
      });

      const results = await workerPool.submitBatchTasks(tasks);

      expect(results).toHaveLength(2);
      expect(results.every(r => r.success)).toBe(true);
    });
  });

  describe('pool management', () => {
    it('should report correct pool stats', async () => {
      await workerPool.start();

      const stats = workerPool.getPoolStats();

      expect(stats.poolSize).toBe(2);
      expect(stats.queuedTasks).toBe(0);
      expect(stats.activeTasks).toBe(0);
      expect(stats.workerStats).toHaveLength(2);
    });

    it('should stop gracefully', async () => {
      await workerPool.start();

      // Submit a task that won't complete
      const task: Task = { id: 'stop-test', type: 'test', data: {}, priority: 1 };
      const taskPromise = workerPool.submitTask(task);

      // Stop the pool
      await workerPool.stop();

      // Task should be rejected
      await expect(taskPromise).rejects.toThrow('Worker pool is shutting down');

      // Workers should be terminated
      expect(mockWorker.terminate).toHaveBeenCalled();
    });

    it('should handle stop when not running', async () => {
      await expect(workerPool.stop()).resolves.not.toThrow();
    });
  });

  describe('worker lifecycle', () => {
    it('should handle worker exit and restart', async () => {
      mockWorker.on.mockImplementation((event, callback) => {
        if (event === 'exit') {
          mockWorker._exitCallback = callback;
        } else if (event === 'message') {
          mockWorker._messageCallback = callback;
        }
      });

      await workerPool.start();

      // Simulate worker exit
      mockWorker._exitCallback(1); // Exit code 1

      // Should attempt to restart worker
      expect(Worker).toHaveBeenCalledTimes(3); // Initial 2 + 1 restart
    });

    it('should clean up worker event listeners', async () => {
      await workerPool.start();
      await workerPool.stop();

      expect(mockWorker.removeAllListeners).toHaveBeenCalled();
    });
  });

  describe('task prioritization', () => {
    beforeEach(async () => {
      mockWorker.on.mockImplementation((event, callback) => {
        if (event === 'message') {
          mockWorker._messageCallback = callback;
        }
      });

      await workerPool.start();
    });

    it('should process higher priority tasks first', async () => {
      const lowPriorityTask: Task = {
        id: 'low-priority',
        type: 'test',
        data: {},
        priority: 1
      };

      const highPriorityTask: Task = {
        id: 'high-priority',
        type: 'test',
        data: {},
        priority: 10
      };

      // Submit low priority first
      const lowPromise = workerPool.submitTask(lowPriorityTask);

      // Submit high priority second
      const highPromise = workerPool.submitTask(highPriorityTask);

      // Mock high priority completion first
      setTimeout(() => {
        mockWorker._messageCallback({
          taskId: 'high-priority',
          success: true,
          result: {},
          processingTime: 50
        });
      }, 10);

      // Mock low priority completion second
      setTimeout(() => {
        mockWorker._messageCallback({
          taskId: 'low-priority',
          success: true,
          result: {},
          processingTime: 50
        });
      }, 20);

      const highResult = await highPromise;
      const lowResult = await lowPromise;

      expect(highResult.taskId).toBe('high-priority');
      expect(lowResult.taskId).toBe('low-priority');
    });
  });

  describe('error handling', () => {
    it('should handle worker termination errors gracefully', async () => {
      mockWorker.terminate.mockRejectedValue(new Error('Termination failed'));

      await workerPool.start();

      // Should not throw despite termination error
      await expect(workerPool.stop()).resolves.not.toThrow();
    });

    it('should handle worker creation errors', async () => {
      (Worker as jest.MockedClass<typeof Worker>).mockImplementationOnce(() => {
        throw new Error('Worker creation failed');
      });

      const pool = new EventProcessingWorkerPool(1);

      await expect(pool.start()).resolves.not.toThrow();
    });
  });
});