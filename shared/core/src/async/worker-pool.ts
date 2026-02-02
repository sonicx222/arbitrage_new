// Worker Thread Pool for Parallel Event Processing
// High-performance parallel processing of arbitrage detection events

import { Worker } from 'worker_threads';
import { EventEmitter } from 'events';
import * as path from 'path';
import { createLogger } from '../logger';

const logger = createLogger('worker-pool');

export interface Task {
  id: string;
  type: string;
  data: any;
  priority: number;
  timeout?: number;
}

export interface TaskResult {
  taskId: string;
  success: boolean;
  result?: any;
  error?: string;
  processingTime: number;
}

export interface WorkerStats {
  workerId: number;
  activeTasks: number;
  completedTasks: number;
  failedTasks: number;
  averageProcessingTime: number;
  uptime: number;
}

export class PriorityQueue<T> {
  private items: Array<{item: T, priority: number}> = [];

  enqueue(item: T, priority: number): void {
    this.items.push({ item, priority });
    this.items.sort((a, b) => b.priority - a.priority); // Higher priority first
  }

  dequeue(): T | undefined {
    return this.items.shift()?.item;
  }

  peek(): T | undefined {
    return this.items[0]?.item;
  }

  size(): number {
    return this.items.length;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  clear(): void {
    this.items = [];
  }
}

export class EventProcessingWorkerPool extends EventEmitter {
  private workers: Worker[] = [];
  private availableWorkers: Set<number> = new Set();
  private activeTasks: Map<string, {resolve: Function, reject: Function, timeout: NodeJS.Timeout, startTime: number}> = new Map();
  private taskQueue: PriorityQueue<Task> = new PriorityQueue();
  private workerStats: Map<number, WorkerStats> = new Map();
  private isRunning = false;
  private poolSize: number;
  private maxQueueSize: number;
  private taskTimeout: number;

  constructor(
    poolSize = 4,
    maxQueueSize = 1000,
    taskTimeout = 30000 // 30 seconds
  ) {
    super();
    this.poolSize = poolSize;
    this.maxQueueSize = maxQueueSize;
    this.taskTimeout = taskTimeout;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    logger.info(`Starting worker pool with ${this.poolSize} workers`);

    this.isRunning = true;
    this.initializeWorkers();
    this.startTaskDispatcher();

    logger.info('Worker pool started successfully');
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

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
    const terminationPromises: Promise<void>[] = [];

    for (let i = 0; i < this.workers.length; i++) {
      const worker = this.workers[i];
      if (worker) {
        const terminationPromise = new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            logger.warn(`Worker ${i} termination timeout, forcing termination`);
            try {
              worker.terminate();
            } catch (error) {
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

  async submitTask(task: Task): Promise<TaskResult> {
    if (!this.isRunning) {
      throw new Error('Worker pool is not running');
    }

    if (this.taskQueue.size() >= this.maxQueueSize) {
      throw new Error('Task queue is full');
    }

    return new Promise<TaskResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.activeTasks.delete(task.id);
        reject(new Error(`Task ${task.id} timed out after ${this.taskTimeout}ms`) as any);
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

  async submitBatchTasks(tasks: Task[]): Promise<TaskResult[]> {
    const promises = tasks.map(task => this.submitTask(task));
    return Promise.all(promises);
  }

  getPoolStats(): {
    poolSize: number;
    availableWorkers: number;
    activeWorkers: number;
    queuedTasks: number;
    activeTasks: number;
    workerStats: WorkerStats[];
  } {
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

  private initializeWorkers(): void {
    const workerPath = path.join(__dirname, 'event-processor-worker.js');

    for (let i = 0; i < this.poolSize; i++) {
      const worker = new Worker(workerPath, {
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

  private isDispatching = false;
  private dispatchTimer: NodeJS.Timeout | null = null;

  private startTaskDispatcher(): void {
    if (this.dispatchTimer) {
      clearTimeout(this.dispatchTimer);
    }

    const dispatch = async () => {
      if (!this.isRunning) return;

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
          if (this.taskQueue.isEmpty()) break;
          if (tasksAssigned >= availableWorkerIds.length) break; // One task per available worker

          const task = this.taskQueue.dequeue();
          if (task) {
            this.assignTaskToWorker(workerId, task);
            tasksAssigned++;
          }
        }
      } catch (error) {
        logger.error('Error in task dispatcher', { error });
      } finally {
        this.isDispatching = false;
      }

      // Schedule next dispatch if there are still tasks or workers become available
      this.scheduleNextDispatch();
    };

    dispatch();
  }

  private scheduleNextDispatch(): void {
    if (!this.isRunning) return;

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

  private assignTaskToWorker(workerId: number, task: Task): void {
    const worker = this.workers[workerId];
    if (!worker) return;

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

  private handleWorkerMessage(message: any, workerId: number): void {
    const { taskId, success, result, error, processingTime } = message;

    // Update worker stats
    const stats = this.workerStats.get(workerId);
    if (stats) {
      stats.activeTasks = Math.max(0, stats.activeTasks - 1);

      if (success) {
        stats.completedTasks++;
      } else {
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

      const taskResult: TaskResult = {
        taskId,
        success,
        result,
        error,
        processingTime
      };

      if (success) {
        taskPromise.resolve(taskResult);
      } else {
        taskPromise.reject(new Error(error || 'Task failed') as any);
      }

      this.emit('taskCompleted', { workerId, taskResult });
    }

    // Make worker available again
    this.availableWorkers.add(workerId);
  }

  private handleWorkerError(error: Error, workerId: number): void {
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

  private handleWorkerExit(code: number, workerId: number): void {
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

  private cleanupWorker(workerId: number): void {
    const worker = this.workers[workerId];
    if (worker) {
      // P1-6 FIX: Wrap removeAllListeners in try/catch to handle worker errors gracefully
      // Without this, a worker in inconsistent state could throw and leak listeners
      try {
        worker.removeAllListeners('message');
        worker.removeAllListeners('error');
        worker.removeAllListeners('exit');
      } catch (error) {
        logger.warn(`Failed to remove listeners from worker ${workerId}:`, error);
      }
    }

    // Mark worker as dead
    this.workers[workerId] = null as any;
    this.availableWorkers.delete(workerId);
  }

  private async restartWorker(workerId: number): Promise<void> {
    try {
      const workerPath = path.join(__dirname, 'event-processor-worker.js');
      const worker = new Worker(workerPath, {
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

    } catch (error) {
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
  getHealthStatus(): {
    healthy: boolean;
    poolSize: number;
    availableWorkers: number;
    activeTasks: number;
    queuedTasks: number;
    averageProcessingTime: number;
  } {
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

// =============================================================================
// Architecture Note:
// Worker thread processing is implemented in event-processor-worker.ts
// This file only contains the pool manager (main thread) implementation.
// See: shared/core/src/event-processor-worker.ts for task handlers.
// =============================================================================

// Singleton instance
let workerPool: EventProcessingWorkerPool | null = null;

export function getWorkerPool(): EventProcessingWorkerPool {
  if (!workerPool) {
    workerPool = new EventProcessingWorkerPool();
  }
  return workerPool;
}