// Worker Thread Pool for Parallel Event Processing
// High-performance parallel processing of arbitrage detection events

import { Worker } from 'worker_threads';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';
import { createLogger } from '../logger';
import { clearTimeoutSafe } from '../lifecycle-utils';
import { WORKER_POOL_CONFIG, PLATFORM_NAME } from '@arbitrage/config';

const logger = createLogger('worker-pool');

/**
 * Resolve the worker script path across source (ts-node) and build (dist) layouts.
 *
 * Source runtime (__dirname = shared/core/src/async):
 * - worker script is expected at shared/core/dist/event-processor-worker.js (after build)
 *
 * Dist runtime (__dirname = shared/core/dist/async):
 * - worker script is expected at shared/core/dist/event-processor-worker.js
 */
function resolveWorkerScriptPath(): string {
  const candidates = [
    path.join(__dirname, 'event-processor-worker.js'),
    path.join(__dirname, '..', 'event-processor-worker.js'),
    path.join(__dirname, '..', '..', 'dist', 'event-processor-worker.js'),
    path.join(process.cwd(), 'shared', 'core', 'dist', 'event-processor-worker.js')
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Fall back to the historical default for compatibility; start() validates existence.
  logger.warn('Worker script not found in known locations', { candidates });
  return candidates[0];
}

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

// =============================================================================
// JSON Parsing Types (Phase 2: Worker Thread JSON Parsing)
// =============================================================================

/**
 * Result from JSON parsing task in worker thread.
 * @see RPC_DATA_OPTIMIZATION_RESEARCH.md Phase 2
 */
export interface JsonParseResult {
  /** The parsed JSON value */
  parsed: unknown;
  /** Size of the input string in bytes */
  byteLength: number;
  /** Time taken to parse in microseconds */
  parseTimeUs: number;
}

/**
 * Result from batch JSON parsing task.
 */
export interface BatchJsonParseResult {
  /** Individual results (either parsed or error) */
  results: Array<JsonParseResult | { error: string }>;
  /** Total parse time in microseconds */
  totalParseTimeUs: number;
  /** Number of successfully parsed strings */
  successCount: number;
  /** Number of parse errors */
  errorCount: number;
}

/**
 * JSON parsing statistics for monitoring.
 */
export interface JsonParsingStats {
  /** Total single parse requests */
  totalSingleParses: number;
  /** Total batch parse requests */
  totalBatchParses: number;
  /** Total strings parsed (includes batch) */
  totalStringsParsed: number;
  /** Total parse errors */
  totalErrors: number;
  /** Average parse time in microseconds */
  avgParseTimeUs: number;
  /** P99 parse time in microseconds (approximation from rolling window) */
  p99ParseTimeUs: number;
  /** Average message passing overhead in ms */
  avgOverheadMs: number;
  /** Total bytes parsed */
  totalBytesParsed: number;
}

export interface WorkerStats {
  workerId: number;
  activeTasks: number;
  completedTasks: number;
  failedTasks: number;
  averageProcessingTime: number;
  uptime: number;
}

/**
 * PERF-1 FIX: Binary Max-Heap based PriorityQueue
 *
 * Previous implementation used Array.sort() on every enqueue: O(n log n)
 * New implementation uses binary heap: O(log n) enqueue, O(log n) dequeue
 *
 * Performance improvement for hot-path task scheduling:
 * - Old: 1000 enqueues × O(n log n) = ~10,000,000 operations
 * - New: 1000 enqueues × O(log n) = ~10,000 operations (1000x improvement)
 *
 * Higher priority values are dequeued first (max-heap behavior).
 */
export class PriorityQueue<T> {
  private heap: Array<{ item: T; priority: number }> = [];

  /**
   * Add item with given priority. O(log n)
   * @param item - The item to enqueue
   * @param priority - Higher values = higher priority (dequeued first)
   */
  enqueue(item: T, priority: number): void {
    this.heap.push({ item, priority });
    this.bubbleUp(this.heap.length - 1);
  }

  /**
   * Remove and return highest-priority item. O(log n)
   * @returns The item with highest priority, or undefined if empty
   */
  dequeue(): T | undefined {
    if (this.heap.length === 0) return undefined;
    if (this.heap.length === 1) return this.heap.pop()!.item;

    const max = this.heap[0];
    this.heap[0] = this.heap.pop()!;
    this.bubbleDown(0);
    return max.item;
  }

  /**
   * Peek at highest-priority item without removing. O(1)
   */
  peek(): T | undefined {
    return this.heap[0]?.item;
  }

  /**
   * Number of items in the queue. O(1)
   */
  size(): number {
    return this.heap.length;
  }

  /**
   * Check if queue is empty. O(1)
   */
  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  /**
   * Remove all items. O(1)
   */
  clear(): void {
    this.heap = [];
  }

  /**
   * Bubble up element at index to maintain max-heap property.
   * Higher priority floats to top.
   */
  private bubbleUp(index: number): void {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      // Max-heap: parent should have HIGHER priority than child
      if (this.heap[parentIndex].priority >= this.heap[index].priority) break;
      this.swap(index, parentIndex);
      index = parentIndex;
    }
  }

  /**
   * Bubble down element at index to maintain max-heap property.
   */
  private bubbleDown(index: number): void {
    const length = this.heap.length;
    while (true) {
      const leftChild = 2 * index + 1;
      const rightChild = 2 * index + 2;
      let largest = index;

      // Max-heap: find child with HIGHER priority
      if (leftChild < length && this.heap[leftChild].priority > this.heap[largest].priority) {
        largest = leftChild;
      }
      if (rightChild < length && this.heap[rightChild].priority > this.heap[largest].priority) {
        largest = rightChild;
      }
      if (largest === index) break;

      this.swap(index, largest);
      index = largest;
    }
  }

  /**
   * Swap two elements in the heap array.
   */
  private swap(i: number, j: number): void {
    const temp = this.heap[i];
    this.heap[i] = this.heap[j];
    this.heap[j] = temp;
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

  // PHASE3-TASK41: SharedArrayBuffer for zero-copy price access in workers
  private priceBuffer: SharedArrayBuffer | null = null;

  // PHASE3-TASK43: SharedArrayBuffer for key registry (key-to-index mapping)
  private keyRegistryBuffer: SharedArrayBuffer | null = null;

  // Finding #16: Configurable worker script path for testability (DI principle)
  private readonly workerPath: string;

  // P1-FIX: Track cancelled/timed-out task IDs to skip during dispatch (O(1) lookup)
  private cancelledTaskIds: Set<string> = new Set();

  // P1-FIX: Track restart attempts per worker for bounded retry with exponential backoff
  private workerRestartCounts: Map<number, number> = new Map();
  private static readonly MAX_RESTART_RETRIES = 5;
  private static readonly BASE_RESTART_DELAY_MS = 10000;
  private static readonly MAX_RESTART_DELAY_MS = 300000; // 5 minutes

  // JSON parsing statistics (Phase 2)
  private jsonParsingStats: JsonParsingStats = {
    totalSingleParses: 0,
    totalBatchParses: 0,
    totalStringsParsed: 0,
    totalErrors: 0,
    avgParseTimeUs: 0,
    p99ParseTimeUs: 0,
    avgOverheadMs: 0,
    totalBytesParsed: 0
  };
  // Rolling window for P99 calculation (last 100 parse times)
  // Fix #27: Circular buffer avoids O(n) shift() on every update
  private parseTimeWindow: number[];
  private overheadWindow: number[];
  private readonly STATS_WINDOW_SIZE = 100;
  private statsWindowPos = 0;
  private statsWindowCount = 0;
  // Task ID counter for JSON parsing (atomic increment)
  private jsonTaskIdCounter = 0;

  constructor(
    poolSize = 4,
    maxQueueSize = 1000,
    taskTimeout = 30000, // 30 seconds
    priceBuffer: SharedArrayBuffer | null = null, // PHASE3-TASK41: Optional SharedArrayBuffer for price data
    keyRegistryBuffer: SharedArrayBuffer | null = null, // PHASE3-TASK43: Optional SharedArrayBuffer for key registry
    workerPath?: string // Finding #16: Optional custom worker script path for testing
  ) {
    super();
    this.poolSize = poolSize;
    this.maxQueueSize = maxQueueSize;
    this.taskTimeout = taskTimeout;
    this.priceBuffer = priceBuffer;
    this.keyRegistryBuffer = keyRegistryBuffer;
    this.workerPath = workerPath ?? resolveWorkerScriptPath();
    // Fix #27: Pre-allocate circular buffer arrays
    this.parseTimeWindow = new Array(this.STATS_WINDOW_SIZE).fill(0);
    this.overheadWindow = new Array(this.STATS_WINDOW_SIZE).fill(0);
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    if (!fs.existsSync(this.workerPath)) {
      throw new Error(
        `Worker script not found at ${this.workerPath}. ` +
        'Build shared/core first (npm run build) or provide a valid workerPath.'
      );
    }

    logger.info(`Starting worker pool with ${this.poolSize} workers`);

    this.isRunning = true;
    this.initializeWorkers();
    // P1-FIX: Initial dispatch (event-driven, replaces startTaskDispatcher polling)
    this.tryDispatch();

    logger.info('Worker pool started successfully');
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    logger.info('Stopping worker pool');

    this.isRunning = false;

    // Clear dispatch timer to prevent new dispatches
    this.dispatchTimer = clearTimeoutSafe(this.dispatchTimer);

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

    // P1-FIX: Clear restart counters and cancelled task tracking on stop
    this.workerRestartCounts.clear();
    this.cancelledTaskIds.clear();

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
        // P1-FIX: Mark task as cancelled so dispatch loop skips it in the priority queue
        this.cancelledTaskIds.add(task.id);
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

      // P1-FIX: Trigger event-driven dispatch when task is enqueued
      this.scheduleDispatch();
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
    for (let i = 0; i < this.poolSize; i++) {
      // PHASE3-TASK41: Pass SharedArrayBuffer to workers for zero-copy price access
      // PHASE3-TASK43: Pass key registry buffer for key-to-index mapping
      const worker = new Worker(this.workerPath, {
        workerData: {
          workerId: i,
          priceBuffer: this.priceBuffer, // SharedArrayBuffer is transferable
          keyRegistryBuffer: this.keyRegistryBuffer // SharedArrayBuffer for key lookups
        }
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

      const bufferInfo = this.priceBuffer && this.keyRegistryBuffer
        ? ' with SharedArrayBuffer + key registry'
        : this.priceBuffer
        ? ' with SharedArrayBuffer'
        : '';
      logger.debug(`Worker ${i} initialized${bufferInfo}`);
    }
  }

  private isDispatching = false;
  // P1-FIX: dispatchTimer retained for cleanup in stop(), but no longer used for polling
  private dispatchTimer: NodeJS.Timeout | null = null;
  private dispatchScheduled = false;

  /**
   * P1-FIX: Event-driven dispatch replaces 1ms polling.
   * Called from submitTask() and handleWorkerMessage() instead of continuous setTimeout.
   * Uses a while loop to drain all available work before returning.
   * HOT-PATH: Minimize allocations — no new objects per dispatch cycle.
   */
  private tryDispatch(): void {
    if (!this.isRunning) return;

    // Prevent concurrent dispatching — if already dispatching, schedule a follow-up
    if (this.isDispatching) {
      this.scheduleDispatch();
      return;
    }

    this.isDispatching = true;
    this.dispatchScheduled = false;

    try {
      // Drain loop: keep dispatching while there are both tasks and available workers
      while (!this.taskQueue.isEmpty() && this.availableWorkers.size > 0) {
        const task = this.taskQueue.dequeue();
        if (!task) break;

        // P1-FIX: Skip timed-out/cancelled tasks that are still in the priority queue
        if (this.cancelledTaskIds.has(task.id)) {
          this.cancelledTaskIds.delete(task.id);
          continue;
        }

        // Get next available worker (O(1) via Set iterator)
        const workerIdIter = this.availableWorkers.values().next();
        if (workerIdIter.done) {
          // No workers available — re-enqueue the task and break
          this.taskQueue.enqueue(task, task.priority);
          break;
        }
        const workerId = workerIdIter.value;

        this.assignTaskToWorker(workerId, task);
      }
    } catch (error) {
      logger.error('Error in task dispatcher', { error });
    } finally {
      this.isDispatching = false;
    }
  }

  /**
   * P1-FIX: Schedule a dispatch via setImmediate to avoid re-entrancy.
   * Coalesces multiple triggers into a single dispatch call.
   */
  private scheduleDispatch(): void {
    if (!this.isRunning) return;
    if (this.dispatchScheduled) return;

    this.dispatchScheduled = true;
    setImmediate(() => {
      this.dispatchScheduled = false;
      this.tryDispatch();
    });
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

    // P1-FIX: Trigger event-driven dispatch when worker becomes available
    this.scheduleDispatch();
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
    // P1-FIX: Bounded restart retries with exponential backoff
    const restartCount = (this.workerRestartCounts.get(workerId) ?? 0) + 1;
    this.workerRestartCounts.set(workerId, restartCount);

    if (restartCount > EventProcessingWorkerPool.MAX_RESTART_RETRIES) {
      logger.error(
        `Worker ${workerId} exceeded max restart retries (${EventProcessingWorkerPool.MAX_RESTART_RETRIES}). ` +
        `Giving up — manual intervention required.`
      );
      this.emit('workerRestartFailed', { workerId, attempts: restartCount - 1 });
      return;
    }

    try {
      // P0-FIX: Pass SharedArrayBuffers to restarted workers (matching initializeWorkers)
      // Without these, restarted workers cannot access L1 price matrix or key registry
      const worker = new Worker(this.workerPath, {
        workerData: {
          workerId,
          priceBuffer: this.priceBuffer,
          keyRegistryBuffer: this.keyRegistryBuffer
        }
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

      // P1-FIX: Reset restart counter on successful restart
      this.workerRestartCounts.set(workerId, 0);
      logger.info(`Worker ${workerId} restarted successfully`);

      // P1-FIX: Dispatch queued tasks to the restarted worker immediately
      this.scheduleDispatch();

    } catch (error) {
      logger.error(`Failed to restart worker ${workerId} (attempt ${restartCount}/${EventProcessingWorkerPool.MAX_RESTART_RETRIES}):`, error);

      // P1-FIX: Exponential backoff capped at MAX_RESTART_DELAY_MS
      const delay = Math.min(
        EventProcessingWorkerPool.BASE_RESTART_DELAY_MS * Math.pow(2, restartCount - 1),
        EventProcessingWorkerPool.MAX_RESTART_DELAY_MS
      );
      logger.info(`Scheduling restart retry for worker ${workerId} in ${delay}ms (attempt ${restartCount}/${EventProcessingWorkerPool.MAX_RESTART_RETRIES})`);

      setTimeout(() => {
        if (this.isRunning) {
          this.restartWorker(workerId);
        }
      }, delay);
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
    const runningWorkers = this.workers.filter(Boolean).length;

    return {
      // A saturated pool (availableWorkers=0) is still healthy if workers are running.
      healthy: this.isRunning && runningWorkers > 0,
      poolSize: stats.poolSize,
      availableWorkers: stats.availableWorkers,
      activeTasks: stats.activeTasks,
      queuedTasks: stats.queuedTasks,
      averageProcessingTime
    };
  }

  // ===========================================================================
  // JSON Parsing Methods (Phase 2: Worker Thread JSON Parsing)
  // ===========================================================================

  /**
   * Parse a JSON string in a worker thread.
   * Offloads JSON.parse from the main event loop for high-throughput scenarios.
   *
   * Trade-offs:
   * - Adds ~0.5-2ms overhead for message passing
   * - Best for large JSON payloads (>1KB) or high-frequency streams
   * - For small messages, consider using parseJsonSync() instead
   *
   * @param jsonString - The JSON string to parse
   * @param priority - Task priority (higher = processed sooner, default: 5)
   * @returns Promise resolving to the parsed JSON value
   * @throws Error if parsing fails or worker pool is not running
   *
   * @example
   * ```typescript
   * const workerPool = getWorkerPool();
   * await workerPool.start();
   *
   * const data = await workerPool.parseJson('{"key": "value"}');
   * console.log(data); // { key: 'value' }
   * ```
   */
  async parseJson<T = unknown>(jsonString: string, priority = 5): Promise<T> {
    const startTime = Date.now();
    const taskId = `json_${++this.jsonTaskIdCounter}_${Date.now()}`;

    const result = await this.submitTask({
      id: taskId,
      type: 'json_parsing',
      data: { jsonString },
      priority
    });

    // Validate task succeeded and result has expected shape
    if (!result.success) {
      throw new Error(`JSON parsing task failed: ${result.error ?? 'Unknown error'}`);
    }

    const jsonResult = result.result as JsonParseResult | undefined;
    if (!jsonResult || typeof jsonResult.parsed === 'undefined') {
      throw new Error('JSON parsing returned invalid result structure');
    }

    // Update statistics
    const overheadMs = Date.now() - startTime;
    this.updateJsonParsingStats(jsonResult, overheadMs);

    return jsonResult.parsed as T;
  }

  /**
   * Parse multiple JSON strings in a single worker task.
   * Amortizes message-passing overhead across multiple parses.
   *
   * Use this when you have multiple messages to parse at once (e.g., WebSocket batch).
   *
   * @param jsonStrings - Array of JSON strings to parse
   * @param priority - Task priority (default: 5)
   * @returns Promise resolving to array of parsed values (or errors)
   *
   * @example
   * ```typescript
   * const results = await workerPool.parseJsonBatch([
   *   '{"a": 1}',
   *   '{"b": 2}',
   *   'invalid json'
   * ]);
   * // [{ parsed: {a:1}, ... }, { parsed: {b:2}, ... }, { error: 'Unexpected token' }]
   * ```
   */
  async parseJsonBatch(
    jsonStrings: string[],
    priority = 5
  ): Promise<Array<{ parsed: unknown } | { error: string }>> {
    if (jsonStrings.length === 0) {
      return [];
    }

    const startTime = Date.now();
    const taskId = `batch_json_${++this.jsonTaskIdCounter}_${Date.now()}`;

    const result = await this.submitTask({
      id: taskId,
      type: 'batch_json_parsing',
      data: { jsonStrings },
      priority
    });

    // Validate task succeeded and result has expected shape
    if (!result.success) {
      throw new Error(`Batch JSON parsing task failed: ${result.error ?? 'Unknown error'}`);
    }

    const batchResult = result.result as BatchJsonParseResult | undefined;
    if (!batchResult || !Array.isArray(batchResult.results)) {
      throw new Error('Batch JSON parsing returned invalid result structure');
    }

    // Update statistics
    const overheadMs = Date.now() - startTime;
    this.updateBatchJsonParsingStats(batchResult, overheadMs);

    // Map to simplified return format
    return batchResult.results.map(r => {
      if ('error' in r) {
        return { error: r.error };
      }
      return { parsed: r.parsed };
    });
  }

  /**
   * Get JSON parsing statistics for monitoring.
   *
   * PERF-3 FIX: P99 is now calculated lazily (on-demand) instead of on every parse.
   * This avoids O(n log n) sort on every parse operation in the hot path.
   *
   * @returns Current JSON parsing statistics snapshot
   */
  getJsonParsingStats(): JsonParsingStats {
    // PERF-3 FIX: Calculate P99 lazily only when stats are requested
    // This moves the expensive sort from hot-path to monitoring code path
    const stats = { ...this.jsonParsingStats };

    if (this.statsWindowCount > 0) {
      // Calculate P99 on-demand (not on every parse)
      // Fix #27: Extract active elements from circular buffer for sorting
      const active = this.parseTimeWindow.slice(0, this.statsWindowCount);
      const sorted = active.sort((a, b) => a - b);
      const p99Index = Math.floor(sorted.length * 0.99);
      stats.p99ParseTimeUs = sorted[p99Index] ?? sorted[sorted.length - 1];
    }

    return stats;
  }

  /**
   * Reset JSON parsing statistics.
   * Useful for testing or after configuration changes.
   */
  resetJsonParsingStats(): void {
    this.jsonParsingStats = {
      totalSingleParses: 0,
      totalBatchParses: 0,
      totalStringsParsed: 0,
      totalErrors: 0,
      avgParseTimeUs: 0,
      p99ParseTimeUs: 0,
      avgOverheadMs: 0,
      totalBytesParsed: 0
    };
    this.parseTimeWindow = new Array(this.STATS_WINDOW_SIZE).fill(0);
    this.overheadWindow = new Array(this.STATS_WINDOW_SIZE).fill(0);
    this.statsWindowPos = 0;
    this.statsWindowCount = 0;
  }

  /**
   * Update statistics after a single JSON parse.
   */
  private updateJsonParsingStats(result: JsonParseResult, overheadMs: number): void {
    this.jsonParsingStats.totalSingleParses++;
    this.jsonParsingStats.totalStringsParsed++;
    this.jsonParsingStats.totalBytesParsed += result.byteLength;

    // Fix #27: Circular buffer write — O(1) instead of O(n) shift()
    this.parseTimeWindow[this.statsWindowPos] = result.parseTimeUs;
    this.overheadWindow[this.statsWindowPos] = overheadMs;
    this.statsWindowPos = (this.statsWindowPos + 1) % this.STATS_WINDOW_SIZE;
    if (this.statsWindowCount < this.STATS_WINDOW_SIZE) this.statsWindowCount++;

    // Recalculate averages
    this.recalculateJsonStats();
  }

  /**
   * Update statistics after a batch JSON parse.
   */
  private updateBatchJsonParsingStats(result: BatchJsonParseResult, overheadMs: number): void {
    this.jsonParsingStats.totalBatchParses++;
    this.jsonParsingStats.totalStringsParsed += result.successCount + result.errorCount;
    this.jsonParsingStats.totalErrors += result.errorCount;

    // Calculate average parse time per string in the batch
    const avgParseTimePerString = result.successCount > 0
      ? result.totalParseTimeUs / result.successCount
      : 0;

    // Sum up bytes from successful parses
    for (const r of result.results) {
      if ('byteLength' in r) {
        this.jsonParsingStats.totalBytesParsed += r.byteLength;
      }
    }

    // Fix #27: Circular buffer write — O(1) instead of O(n) shift()
    if (result.successCount > 0) {
      this.parseTimeWindow[this.statsWindowPos] = avgParseTimePerString;
    }
    this.overheadWindow[this.statsWindowPos] = overheadMs;
    this.statsWindowPos = (this.statsWindowPos + 1) % this.STATS_WINDOW_SIZE;
    if (this.statsWindowCount < this.STATS_WINDOW_SIZE) this.statsWindowCount++;

    this.recalculateJsonStats();
  }

  /**
   * Recalculate average statistics from rolling windows.
   *
   * PERF-3 FIX: P99 calculation removed from this hot-path method.
   * P99 is now calculated lazily in getJsonParsingStats().
   *
   * Previous: O(n log n) sort on every parse
   * New: O(n) reduce on every parse, O(n log n) sort only on stats request
   */
  private recalculateJsonStats(): void {
    // Fix #27: Calculate averages using manual loop over circular buffer (no allocation)
    if (this.statsWindowCount > 0) {
      let parseSum = 0;
      let overheadSum = 0;
      for (let i = 0; i < this.statsWindowCount; i++) {
        parseSum += this.parseTimeWindow[i];
        overheadSum += this.overheadWindow[i];
      }
      this.jsonParsingStats.avgParseTimeUs = parseSum / this.statsWindowCount;
      this.jsonParsingStats.avgOverheadMs = overheadSum / this.statsWindowCount;
      // PERF-3 FIX: P99 calculation moved to getJsonParsingStats() (lazy)
    }
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

/**
 * Get the singleton worker pool instance.
 * Creates a new instance if one doesn't exist.
 *
 * P2-FIX: Uses platform-aware defaults for memory-constrained hosts.
 * - Fly.io (256MB): 2 workers, 300 queue
 * - Other constrained: 3 workers, 300 queue
 * - Standard hosts: 4 workers, 1000 queue
 *
 * @see docs/reports/ENHANCEMENT_OPTIMIZATION_RESEARCH.md Section 5.3
 *
 * @param poolSize - Optional pool size (defaults to platform-aware value)
 * @param maxQueueSize - Optional max queue size (defaults to platform-aware value)
 * @param taskTimeout - Optional task timeout in ms (default: 30000)
 * @returns The singleton EventProcessingWorkerPool instance
 */
export function getWorkerPool(
  poolSize?: number,
  maxQueueSize?: number,
  taskTimeout?: number
): EventProcessingWorkerPool {
  if (!workerPool) {
    // P2-FIX: Use platform-aware defaults from @arbitrage/config when not explicitly specified
    const effectivePoolSize = poolSize ?? WORKER_POOL_CONFIG.poolSize;
    const effectiveQueueSize = maxQueueSize ?? WORKER_POOL_CONFIG.maxQueueSize;
    const effectiveTimeout = taskTimeout ?? WORKER_POOL_CONFIG.taskTimeout;

    logger.info('Creating worker pool with platform-aware configuration', {
      platform: PLATFORM_NAME,
      poolSize: effectivePoolSize,
      maxQueueSize: effectiveQueueSize,
      taskTimeout: effectiveTimeout,
    });

    workerPool = new EventProcessingWorkerPool(
      effectivePoolSize,
      effectiveQueueSize,
      effectiveTimeout
    );
  }
  return workerPool;
}

/**
 * BUG-1 FIX: Reset the singleton worker pool instance.
 *
 * Stops the current pool (if running) and clears the singleton reference.
 * Used for testing and when pool needs to be reconfigured.
 *
 * Pattern matches other singletons in this codebase:
 * - resetReserveCache() in reserve-cache.ts
 * - resetGasPriceCache() in gas-price-cache.ts
 *
 * @returns Promise that resolves when the pool is fully stopped
 */
export async function resetWorkerPool(): Promise<void> {
  if (workerPool) {
    await workerPool.stop();
    workerPool = null;
  }
}
