"use strict";
// Worker Thread Pool for Parallel Event Processing
// High-performance parallel processing of arbitrage detection events
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventProcessingWorkerPool = exports.PriorityQueue = void 0;
exports.getWorkerPool = getWorkerPool;
const worker_threads_1 = require("worker_threads");
const events_1 = require("events");
const path = __importStar(require("path"));
const logger_1 = require("./logger");
const logger = (0, logger_1.createLogger)('worker-pool');
class PriorityQueue {
    constructor() {
        this.items = [];
    }
    enqueue(item, priority) {
        this.items.push({ item, priority });
        this.items.sort((a, b) => b.priority - a.priority); // Higher priority first
    }
    dequeue() {
        return this.items.shift()?.item;
    }
    peek() {
        return this.items[0]?.item;
    }
    size() {
        return this.items.length;
    }
    isEmpty() {
        return this.items.length === 0;
    }
    clear() {
        this.items = [];
    }
}
exports.PriorityQueue = PriorityQueue;
class EventProcessingWorkerPool extends events_1.EventEmitter {
    constructor(poolSize = 4, maxQueueSize = 1000, taskTimeout = 30000 // 30 seconds
    ) {
        super();
        this.workers = [];
        this.availableWorkers = new Set();
        this.activeTasks = new Map();
        this.taskQueue = new PriorityQueue();
        this.workerStats = new Map();
        this.isRunning = false;
        this.isDispatching = false;
        this.dispatchTimer = null;
        this.poolSize = poolSize;
        this.maxQueueSize = maxQueueSize;
        this.taskTimeout = taskTimeout;
    }
    async start() {
        if (this.isRunning)
            return;
        logger.info(`Starting worker pool with ${this.poolSize} workers`);
        this.isRunning = true;
        this.initializeWorkers();
        this.startTaskDispatcher();
        logger.info('Worker pool started successfully');
    }
    async stop() {
        if (!this.isRunning)
            return;
        logger.info('Stopping worker pool');
        this.isRunning = false;
        // Clear dispatch timer to prevent new dispatches
        if (this.dispatchTimer) {
            clearTimeout(this.dispatchTimer);
            this.dispatchTimer = null;
        }
        // Reject all pending tasks and clear their timeouts
        for (const [taskId, taskPromise] of this.activeTasks) {
            if (taskPromise.timeout) {
                clearTimeout(taskPromise.timeout);
            }
            taskPromise.reject(new Error('Worker pool is shutting down'));
        }
        this.activeTasks.clear();
        // Clear any remaining tasks in the queue
        this.taskQueue.clear();
        // Terminate all active workers
        const terminationPromises = [];
        for (let i = 0; i < this.workers.length; i++) {
            const worker = this.workers[i];
            if (worker) {
                const terminationPromise = new Promise((resolve) => {
                    const timeout = setTimeout(() => {
                        logger.warn(`Worker ${i} termination timeout, forcing termination`);
                        try {
                            worker.terminate();
                        }
                        catch (error) {
                            logger.error(`Force termination failed for worker ${i}`, { error });
                        }
                        resolve();
                    }, 5000); // 5 second timeout for graceful shutdown
                    worker.terminate().then(() => {
                        clearTimeout(timeout);
                        logger.debug(`Worker ${i} terminated gracefully`);
                        resolve();
                    }).catch((error) => {
                        clearTimeout(timeout);
                        logger.warn(`Error terminating worker ${i}:`, error);
                        resolve();
                    });
                });
                terminationPromises.push(terminationPromise);
            }
        }
        await Promise.all(terminationPromises);
        this.workers = [];
        this.availableWorkers.clear();
        // Clear worker stats
        this.workerStats.clear();
        logger.info('Worker pool stopped successfully');
    }
    async submitTask(task) {
        if (!this.isRunning) {
            throw new Error('Worker pool is not running');
        }
        if (this.taskQueue.size() >= this.maxQueueSize) {
            throw new Error('Task queue is full');
        }
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.activeTasks.delete(task.id);
                reject(new Error(`Task ${task.id} timed out after ${this.taskTimeout}ms`));
            }, this.taskTimeout);
            this.activeTasks.set(task.id, {
                resolve,
                reject,
                timeout,
                startTime: Date.now()
            });
            this.taskQueue.enqueue(task, task.priority);
            this.emit('taskQueued', task);
        });
    }
    async submitBatchTasks(tasks) {
        const promises = tasks.map(task => this.submitTask(task));
        return Promise.all(promises);
    }
    getPoolStats() {
        const activeWorkers = this.poolSize - this.availableWorkers.size;
        return {
            poolSize: this.poolSize,
            availableWorkers: this.availableWorkers.size,
            activeWorkers,
            queuedTasks: this.taskQueue.size(),
            activeTasks: this.activeTasks.size,
            workerStats: Array.from(this.workerStats.values())
        };
    }
    initializeWorkers() {
        const workerPath = path.join(__dirname, 'event-processor-worker.js');
        for (let i = 0; i < this.poolSize; i++) {
            const worker = new worker_threads_1.Worker(workerPath, {
                workerData: { workerId: i }
            });
            worker.on('message', (message) => this.handleWorkerMessage(message, i));
            worker.on('error', (error) => this.handleWorkerError(error, i));
            worker.on('exit', (code) => this.handleWorkerExit(code, i));
            this.workers.push(worker);
            this.availableWorkers.add(i);
            // Initialize worker stats
            this.workerStats.set(i, {
                workerId: i,
                activeTasks: 0,
                completedTasks: 0,
                failedTasks: 0,
                averageProcessingTime: 0,
                uptime: Date.now()
            });
            logger.debug(`Worker ${i} initialized`);
        }
    }
    startTaskDispatcher() {
        if (this.dispatchTimer) {
            clearTimeout(this.dispatchTimer);
        }
        const dispatch = async () => {
            if (!this.isRunning)
                return;
            // Prevent concurrent dispatching
            if (this.isDispatching) {
                this.scheduleNextDispatch();
                return;
            }
            this.isDispatching = true;
            try {
                // Assign tasks to available workers
                const availableWorkerIds = Array.from(this.availableWorkers);
                let tasksAssigned = 0;
                for (const workerId of availableWorkerIds) {
                    if (this.taskQueue.isEmpty())
                        break;
                    if (tasksAssigned >= availableWorkerIds.length)
                        break; // One task per available worker
                    const task = this.taskQueue.dequeue();
                    if (task) {
                        this.assignTaskToWorker(workerId, task);
                        tasksAssigned++;
                    }
                }
            }
            catch (error) {
                logger.error('Error in task dispatcher', { error });
            }
            finally {
                this.isDispatching = false;
            }
            // Schedule next dispatch if there are still tasks or workers become available
            this.scheduleNextDispatch();
        };
        dispatch();
    }
    scheduleNextDispatch() {
        if (!this.isRunning)
            return;
        // Clear any existing timer
        if (this.dispatchTimer) {
            clearTimeout(this.dispatchTimer);
            this.dispatchTimer = null;
        }
        // Schedule next dispatch with minimal delay
        this.dispatchTimer = setTimeout(() => {
            this.dispatchTimer = null;
            this.startTaskDispatcher();
        }, 1);
    }
    assignTaskToWorker(workerId, task) {
        const worker = this.workers[workerId];
        if (!worker)
            return;
        this.availableWorkers.delete(workerId);
        // Update worker stats
        const stats = this.workerStats.get(workerId);
        if (stats) {
            stats.activeTasks++;
        }
        // Send task to worker
        worker.postMessage({
            type: 'process_task',
            taskId: task.id,
            taskType: task.type,
            taskData: task.data
        });
        this.emit('taskAssigned', { workerId, task });
    }
    handleWorkerMessage(message, workerId) {
        const { taskId, success, result, error, processingTime } = message;
        // Update worker stats
        const stats = this.workerStats.get(workerId);
        if (stats) {
            stats.activeTasks = Math.max(0, stats.activeTasks - 1);
            if (success) {
                stats.completedTasks++;
            }
            else {
                stats.failedTasks++;
            }
            // Update average processing time
            const totalTasks = stats.completedTasks + stats.failedTasks;
            stats.averageProcessingTime =
                (stats.averageProcessingTime * (totalTasks - 1) + processingTime) / totalTasks;
        }
        // Resolve/reject the task promise
        const taskPromise = this.activeTasks.get(taskId);
        if (taskPromise) {
            clearTimeout(taskPromise.timeout);
            this.activeTasks.delete(taskId);
            const taskResult = {
                taskId,
                success,
                result,
                error,
                processingTime
            };
            if (success) {
                taskPromise.resolve(taskResult);
            }
            else {
                taskPromise.reject(new Error(error || 'Task failed'));
            }
            this.emit('taskCompleted', { workerId, taskResult });
        }
        // Make worker available again
        this.availableWorkers.add(workerId);
    }
    handleWorkerError(error, workerId) {
        logger.error(`Worker ${workerId} error:`, error);
        // Update worker stats
        const stats = this.workerStats.get(workerId);
        if (stats) {
            stats.failedTasks++;
        }
        // Remove from available workers
        this.availableWorkers.delete(workerId);
        // Emit error event
        this.emit('workerError', { workerId, error });
    }
    handleWorkerExit(code, workerId) {
        logger.warn(`Worker ${workerId} exited with code ${code}`);
        // Clean up the dead worker
        this.cleanupWorker(workerId);
        // If pool is still running, try to restart worker
        if (this.isRunning) {
            logger.info(`Attempting to restart worker ${workerId}`);
            this.restartWorker(workerId);
        }
        this.emit('workerExit', { workerId, code });
    }
    cleanupWorker(workerId) {
        const worker = this.workers[workerId];
        if (worker) {
            // Remove all event listeners to prevent memory leaks
            worker.removeAllListeners('message');
            worker.removeAllListeners('error');
            worker.removeAllListeners('exit');
        }
        // Mark worker as dead
        this.workers[workerId] = null;
        this.availableWorkers.delete(workerId);
    }
    async restartWorker(workerId) {
        try {
            const workerPath = path.join(__dirname, 'event-processor-worker.js');
            const worker = new worker_threads_1.Worker(workerPath, {
                workerData: { workerId }
            });
            // Set up event handlers
            worker.on('message', (message) => this.handleWorkerMessage(message, workerId));
            worker.on('error', (error) => this.handleWorkerError(error, workerId));
            worker.on('exit', (code) => this.handleWorkerExit(code, workerId));
            // Replace the dead worker
            this.workers[workerId] = worker;
            this.availableWorkers.add(workerId);
            // Reset worker stats
            this.workerStats.set(workerId, {
                workerId,
                activeTasks: 0,
                completedTasks: 0,
                failedTasks: 0,
                averageProcessingTime: 0,
                uptime: Date.now()
            });
            logger.info(`Worker ${workerId} restarted successfully`);
        }
        catch (error) {
            logger.error(`Failed to restart worker ${workerId}:`, error);
            // If restart fails, schedule another attempt with backoff
            setTimeout(() => {
                if (this.isRunning) {
                    logger.info(`Retrying restart for worker ${workerId}`);
                    this.restartWorker(workerId);
                }
            }, 10000); // 10 second backoff
        }
    }
    // Health monitoring
    getHealthStatus() {
        const stats = this.getPoolStats();
        const averageProcessingTime = Array.from(this.workerStats.values())
            .reduce((sum, stat) => sum + stat.averageProcessingTime, 0) / this.workerStats.size;
        return {
            healthy: this.isRunning && stats.availableWorkers > 0,
            poolSize: stats.poolSize,
            availableWorkers: stats.availableWorkers,
            activeTasks: stats.activeTasks,
            queuedTasks: stats.queuedTasks,
            averageProcessingTime
        };
    }
}
exports.EventProcessingWorkerPool = EventProcessingWorkerPool;
// =============================================================================
// Architecture Note:
// Worker thread processing is implemented in event-processor-worker.ts
// This file only contains the pool manager (main thread) implementation.
// See: shared/core/src/event-processor-worker.ts for task handlers.
// =============================================================================
// Singleton instance
let workerPool = null;
function getWorkerPool() {
    if (!workerPool) {
        workerPool = new EventProcessingWorkerPool();
    }
    return workerPool;
}
//# sourceMappingURL=worker-pool.js.map