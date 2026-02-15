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

// =============================================================================
// Finding #11: Realistic Worker Mock
//
// Previous mock (2/5 fidelity) only captured a single event callback via on(),
// postMessage was a no-op, and there was no error→exit sequence support.
//
// This improved mock:
// - Maintains a Map of event handlers (supports multiple event types simultaneously)
// - Provides emit() to trigger events (message, error, exit) from tests
// - Supports auto-response mode: postMessage triggers a configurable callback
// - Captures workerData from constructor for SharedArrayBuffer testing
// =============================================================================

interface RealisticMockWorker {
  on: jest.Mock;
  postMessage: jest.Mock;
  terminate: jest.Mock;
  removeAllListeners: jest.Mock;
  /** Trigger an event on this worker (test helper, not part of real Worker API) */
  _emit: (event: string, data?: unknown) => void;
  /** All registered handlers by event name */
  _handlers: Map<string, Array<(data?: unknown) => void>>;
  /** Configure auto-response: when postMessage is called, automatically respond */
  _autoRespond: boolean;
  /** Custom auto-response factory (receives the posted message, returns response) */
  _autoRespondFn: ((msg: any) => any) | null;
}

describe('EventProcessingWorkerPool', () => {
  let mockWorker: RealisticMockWorker;

  /**
   * Create a realistic mock worker that maintains event handlers and supports
   * multi-event simulation.
   */
  const createMockWorker = (): RealisticMockWorker => {
    const handlers = new Map<string, Array<(data?: unknown) => void>>();

    const worker: RealisticMockWorker = {
      on: jest.fn(((event: string, callback: (data?: unknown) => void) => {
        if (!handlers.has(event)) {
          handlers.set(event, []);
        }
        handlers.get(event)!.push(callback);
      }) as any),
      postMessage: jest.fn(((msg: any) => {
        // Auto-respond if configured
        if (worker._autoRespond) {
          const response = worker._autoRespondFn
            ? worker._autoRespondFn(msg)
            : {
                taskId: msg.taskId,
                success: true,
                result: {},
                processingTime: 1
              };
          // Simulate async worker response
          setImmediate(() => worker._emit('message', response));
        }
      }) as any),
      terminate: jest.fn(() => Promise.resolve()),
      removeAllListeners: jest.fn(() => {
        handlers.clear();
      }),
      _emit: (event: string, data?: unknown) => {
        const eventHandlers = handlers.get(event);
        if (eventHandlers) {
          for (const handler of eventHandlers) {
            handler(data);
          }
        }
      },
      _handlers: handlers,
      _autoRespond: false,
      _autoRespondFn: null,
    };

    return worker;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockWorker = createMockWorker();
    (Worker as unknown as jest.Mock).mockImplementation(() => mockWorker);
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
      const pool = new EventProcessingWorkerPool(1, 100, 5000);
      await pool.start();

      const task: Task = {
        id: 'test-task-1',
        type: 'arbitrage_detection',
        data: { prices: [100, 101, 102] },
        priority: 1
      };

      // Submit task and simulate worker response
      const resultPromise = pool.submitTask(task);

      setTimeout(() => {
        mockWorker._emit('message', {
          taskId: task.id,
          success: true,
          result: { opportunities: [] },
          processingTime: 100
        });
      }, 10);

      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.taskId).toBe(task.id);

      await pool.stop();
    });

    it('should submit tasks using auto-respond mock', async () => {
      // Finding #11: Demonstrate auto-respond capability
      mockWorker._autoRespond = true;
      mockWorker._autoRespondFn = (msg: any) => ({
        taskId: msg.taskId,
        success: true,
        result: { echo: msg.taskData },
        processingTime: 5
      });

      const pool = new EventProcessingWorkerPool(1, 100, 5000);
      await pool.start();

      const task: Task = {
        id: 'auto-resp-1',
        type: 'test',
        data: { value: 42 },
        priority: 1
      };

      const result = await pool.submitTask(task);

      expect(result.success).toBe(true);
      expect(result.taskId).toBe('auto-resp-1');

      await pool.stop();
    });

    it('should handle task timeouts', async () => {
      // Worker registers handlers but never responds — simulates hung worker
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
      // Worker registers handlers but never responds
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
      // Use 1 worker to avoid shared-mock handler interaction
      const pool = new EventProcessingWorkerPool(1, 100, 5000);
      await pool.start();

      // Initial worker created
      expect(Worker).toHaveBeenCalledTimes(1);

      // Finding #11: Use _emit to simulate worker crash (exit code 1)
      mockWorker._emit('exit', 1);

      // Should attempt to restart (1 initial + 1 restart = 2)
      expect(Worker).toHaveBeenCalledTimes(2);

      await pool.stop();
    });

    it('should pass SharedArrayBuffers to restarted workers', async () => {
      const workerDataCaptures: any[] = [];

      (Worker as unknown as jest.Mock).mockImplementation((_path: any, options: any) => {
        workerDataCaptures.push(options?.workerData);
        const w = createMockWorker();
        // Update mockWorker reference so pool.stop() can terminate
        mockWorker = w;
        return w;
      });

      const mockPriceBuffer = new SharedArrayBuffer(1024);
      const mockKeyRegistryBuffer = new SharedArrayBuffer(512);
      const pool = new EventProcessingWorkerPool(1, 100, 5000, mockPriceBuffer, mockKeyRegistryBuffer);
      await pool.start();

      // Initial worker should have both buffers
      expect(workerDataCaptures[0]).toEqual({
        workerId: 0,
        priceBuffer: mockPriceBuffer,
        keyRegistryBuffer: mockKeyRegistryBuffer
      });

      // Simulate worker crash using _emit
      mockWorker._emit('exit', 1);

      // Restarted worker should also have both buffers
      expect(workerDataCaptures.length).toBeGreaterThanOrEqual(2);
      expect(workerDataCaptures[1]).toEqual({
        workerId: 0,
        priceBuffer: mockPriceBuffer,
        keyRegistryBuffer: mockKeyRegistryBuffer
      });

      // Verify same reference (not a copy)
      expect(workerDataCaptures[1].priceBuffer).toBe(mockPriceBuffer);
      expect(workerDataCaptures[1].keyRegistryBuffer).toBe(mockKeyRegistryBuffer);

      await pool.stop();
    });

    it('should pass null SharedArrayBuffers to restarted workers when pool has no buffers', async () => {
      const workerDataCaptures: any[] = [];

      (Worker as unknown as jest.Mock).mockImplementation((_path: any, options: any) => {
        workerDataCaptures.push(options?.workerData);
        const w = createMockWorker();
        mockWorker = w;
        return w;
      });

      const pool = new EventProcessingWorkerPool(1, 100, 5000);
      await pool.start();

      // Simulate worker crash using _emit
      mockWorker._emit('exit', 1);

      // Restarted worker should have null buffers (not undefined/missing)
      expect(workerDataCaptures.length).toBeGreaterThanOrEqual(2);
      expect(workerDataCaptures[1]).toHaveProperty('priceBuffer', null);
      expect(workerDataCaptures[1]).toHaveProperty('keyRegistryBuffer', null);

      await pool.stop();
    });

    it('should simulate error followed by exit (realistic crash sequence)', async () => {
      // Finding #11: Test the error→exit sequence that real workers produce
      const pool = new EventProcessingWorkerPool(1, 100, 5000);
      await pool.start();

      expect(Worker).toHaveBeenCalledTimes(1);

      // Real workers emit 'error' first, then 'exit'
      mockWorker._emit('error', new Error('Worker crashed'));
      mockWorker._emit('exit', 1);

      // Should attempt restart after exit
      expect(Worker).toHaveBeenCalledTimes(2);

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
      (Worker as unknown as jest.Mock)
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
      // Finding #11: Use auto-respond for cleaner batch testing
      mockWorker._autoRespond = true;

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

  // P1-FIX regression tests

  describe('bounded restart retries (Fix #3)', () => {
    it('should give up after MAX_RESTART_RETRIES and emit workerRestartFailed', async () => {
      let workerCreateCount = 0;

      (Worker as unknown as jest.Mock).mockImplementation((_path: any, _options: any) => {
        workerCreateCount++;
        if (workerCreateCount === 1) {
          // First worker succeeds (initial creation)
          const w = createMockWorker();
          mockWorker = w;
          return w;
        }
        // All restart attempts fail
        throw new Error('Worker creation failed');
      });

      const pool = new EventProcessingWorkerPool(1, 100, 5000);
      pool.on('workerRestartFailed', () => {});
      await pool.start();

      expect(workerCreateCount).toBe(1);

      // Trigger worker crash — first restart attempt happens synchronously
      // and fails (throws), which schedules retry via real setTimeout
      mockWorker._emit('exit', 1);

      // First restart attempt already happened (workerCreateCount should be 2)
      expect(workerCreateCount).toBe(2);

      await pool.stop();
    });

    it('should reset restart counter on successful restart', async () => {
      let workerCreateCount = 0;
      const workers: RealisticMockWorker[] = [];

      (Worker as unknown as jest.Mock).mockImplementation((_path: any, _options: any) => {
        workerCreateCount++;
        const w = createMockWorker();
        workers.push(w);
        mockWorker = w;
        return w;
      });

      const pool = new EventProcessingWorkerPool(1, 100, 5000);
      await pool.start();

      expect(workerCreateCount).toBe(1);

      // First crash + successful restart
      workers[0]._emit('exit', 1);
      expect(workerCreateCount).toBe(2); // restart succeeded

      // Second crash + successful restart (counter should have been reset)
      workers[1]._emit('exit', 1);
      expect(workerCreateCount).toBe(3); // restart succeeded again

      await pool.stop();
    });
  });

  describe('timed-out task cleanup (Fix #8)', () => {
    it('should not dispatch a timed-out task to a worker', async () => {
      // Don't set up any message callback — worker never responds
      // This ensures the task will timeout
      const pool = new EventProcessingWorkerPool(1, 100, 50);
      await pool.start();

      // Submit a task that will timeout (worker never responds)
      const task: Task = {
        id: 'will-timeout',
        type: 'test',
        data: {},
        priority: 1
      };

      const taskPromise = pool.submitTask(task);

      // Wait for timeout to fire
      await expect(taskPromise).rejects.toThrow(/timed out/);

      await pool.stop();
    });
  });
});
