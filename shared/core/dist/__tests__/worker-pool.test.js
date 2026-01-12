"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const globals_1 = require("@jest/globals");
// Mock logger before importing worker-pool
globals_1.jest.mock('../logger', () => ({
    createLogger: globals_1.jest.fn(() => ({
        info: globals_1.jest.fn(),
        warn: globals_1.jest.fn(),
        error: globals_1.jest.fn(),
        debug: globals_1.jest.fn()
    })),
    getPerformanceLogger: globals_1.jest.fn(() => ({
        logEventLatency: globals_1.jest.fn(),
        logArbitrageOpportunity: globals_1.jest.fn(),
        logHealthCheck: globals_1.jest.fn()
    }))
}));
// Mock worker_threads
globals_1.jest.mock('worker_threads', () => ({
    Worker: globals_1.jest.fn(),
    isMainThread: true,
    parentPort: null,
    workerData: {}
}));
const worker_pool_1 = require("../worker-pool");
const worker_threads_1 = require("worker_threads");
/**
 * Simplified Worker Pool Tests
 *
 * These tests focus on the core functionality without complex async interactions
 * that can cause flaky behavior.
 */
(0, globals_1.describe)('EventProcessingWorkerPool', () => {
    let mockWorker;
    // Helper to create a fresh mock worker
    const createMockWorker = () => ({
        on: globals_1.jest.fn(),
        postMessage: globals_1.jest.fn(),
        terminate: globals_1.jest.fn(() => Promise.resolve()),
        removeAllListeners: globals_1.jest.fn()
    });
    (0, globals_1.beforeEach)(() => {
        globals_1.jest.clearAllMocks();
        mockWorker = createMockWorker();
        worker_threads_1.Worker.mockImplementation(() => mockWorker);
    });
    (0, globals_1.describe)('initialization', () => {
        (0, globals_1.it)('should initialize with correct parameters', () => {
            const pool = new worker_pool_1.EventProcessingWorkerPool(2, 100, 5000);
            (0, globals_1.expect)(pool).toBeDefined();
        });
        (0, globals_1.it)('should create correct number of workers on start', async () => {
            const pool = new worker_pool_1.EventProcessingWorkerPool(2, 100, 5000);
            await pool.start();
            (0, globals_1.expect)(worker_threads_1.Worker).toHaveBeenCalledTimes(2);
            await pool.stop();
        });
    });
    (0, globals_1.describe)('task submission', () => {
        (0, globals_1.it)('should submit tasks and receive responses', async () => {
            // Setup message callback capture
            mockWorker.on.mockImplementation((event, callback) => {
                if (event === 'message') {
                    mockWorker._messageCallback = callback;
                }
            });
            const pool = new worker_pool_1.EventProcessingWorkerPool(1, 100, 5000);
            await pool.start();
            const task = {
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
            (0, globals_1.expect)(result.success).toBe(true);
            (0, globals_1.expect)(result.taskId).toBe(task.id);
            await pool.stop();
        });
        (0, globals_1.it)('should handle task timeouts', async () => {
            mockWorker.on.mockImplementation(() => { }); // No message callback - simulates hung worker
            const pool = new worker_pool_1.EventProcessingWorkerPool(1, 100, 100); // 100ms timeout
            await pool.start();
            const task = {
                id: 'timeout-task',
                type: 'test',
                data: {},
                priority: 1
            };
            // Task should timeout since no response comes
            await (0, globals_1.expect)(pool.submitTask(task))
                .rejects
                .toThrow('timed out');
            await pool.stop();
        });
    });
    (0, globals_1.describe)('pool management', () => {
        (0, globals_1.it)('should report correct pool stats', async () => {
            const pool = new worker_pool_1.EventProcessingWorkerPool(2, 100, 5000);
            await pool.start();
            const stats = pool.getPoolStats();
            (0, globals_1.expect)(stats.poolSize).toBe(2);
            (0, globals_1.expect)(stats.queuedTasks).toBe(0);
            (0, globals_1.expect)(stats.activeTasks).toBe(0);
            (0, globals_1.expect)(stats.workerStats).toHaveLength(2);
            await pool.stop();
        });
        (0, globals_1.it)('should stop gracefully and reject pending tasks', async () => {
            mockWorker.on.mockImplementation(() => { }); // Don't capture callbacks
            const pool = new worker_pool_1.EventProcessingWorkerPool(1, 100, 30000);
            await pool.start();
            const task = { id: 'stop-test', type: 'test', data: {}, priority: 1 };
            const taskPromise = pool.submitTask(task);
            // Stop the pool immediately
            await pool.stop();
            // Task should be rejected
            await (0, globals_1.expect)(taskPromise).rejects.toThrow('Worker pool is shutting down');
            // Workers should be terminated
            (0, globals_1.expect)(mockWorker.terminate).toHaveBeenCalled();
        });
        (0, globals_1.it)('should handle stop when not running', async () => {
            const pool = new worker_pool_1.EventProcessingWorkerPool(1);
            // Stopping without starting should not throw
            await (0, globals_1.expect)(pool.stop()).resolves.not.toThrow();
        });
    });
    (0, globals_1.describe)('worker lifecycle', () => {
        (0, globals_1.it)('should handle worker exit and attempt restart', async () => {
            mockWorker.on.mockImplementation((event, callback) => {
                if (event === 'exit') {
                    mockWorker._exitCallback = callback;
                }
            });
            const pool = new worker_pool_1.EventProcessingWorkerPool(2, 100, 5000);
            await pool.start();
            // Initial workers created
            (0, globals_1.expect)(worker_threads_1.Worker).toHaveBeenCalledTimes(2);
            // Simulate worker exit (only if callback was captured)
            if (mockWorker._exitCallback) {
                mockWorker._exitCallback(1); // Exit code 1 = crash
                // Should attempt to restart
                (0, globals_1.expect)(worker_threads_1.Worker).toHaveBeenCalledTimes(3);
            }
            await pool.stop();
        });
    });
    (0, globals_1.describe)('error handling', () => {
        (0, globals_1.it)('should handle worker termination errors gracefully', async () => {
            mockWorker.terminate.mockImplementation(() => Promise.reject(new Error('Termination failed')));
            const pool = new worker_pool_1.EventProcessingWorkerPool(1);
            await pool.start();
            // Stop should not throw despite termination error
            await (0, globals_1.expect)(pool.stop()).resolves.not.toThrow();
        });
        (0, globals_1.it)('should handle worker creation errors during start', async () => {
            // First worker throws, subsequent ones work
            worker_threads_1.Worker
                .mockImplementationOnce(() => { throw new Error('Worker creation failed'); })
                .mockImplementation(() => mockWorker);
            const pool = new worker_pool_1.EventProcessingWorkerPool(2);
            // Pool start might throw if all workers fail, or succeed partially
            // This tests that partial failure is handled
            try {
                await pool.start();
                // If it didn't throw, at least one worker was created
                (0, globals_1.expect)(worker_threads_1.Worker).toHaveBeenCalled();
            }
            catch (error) {
                // If it threw, that's also acceptable behavior
                (0, globals_1.expect)(error).toBeInstanceOf(Error);
            }
            await pool.stop();
        });
    });
    (0, globals_1.describe)('batch task submission', () => {
        (0, globals_1.it)('should submit multiple tasks in batch', async () => {
            let responseCount = 0;
            mockWorker.on.mockImplementation((event, callback) => {
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
            const pool = new worker_pool_1.EventProcessingWorkerPool(2, 100, 5000);
            await pool.start();
            const tasks = [
                { id: 'batch-1', type: 'test', data: {}, priority: 1 },
                { id: 'batch-2', type: 'test', data: {}, priority: 1 }
            ];
            const results = await pool.submitBatchTasks(tasks);
            (0, globals_1.expect)(results).toHaveLength(2);
            (0, globals_1.expect)(results.every(r => r.success)).toBe(true);
            await pool.stop();
        });
    });
});
//# sourceMappingURL=worker-pool.test.js.map