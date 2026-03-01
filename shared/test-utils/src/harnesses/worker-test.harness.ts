/**
 * Worker Test Harness
 *
 * Manages Worker thread lifecycle for integration tests.
 * Handles SharedArrayBuffer setup, message passing, thread safety validation.
 *
 * @example
 * const harness = new WorkerTestHarness();
 * await harness.spawnWorkers(4);
 *
 * const stats = await harness.testConcurrentReads(keys, 4);
 * harness.assertThreadSafe(stats);
 *
 * await harness.terminateAll();
 */

import { Worker } from 'worker_threads';
import { join } from 'path';
import { PriceMatrix } from '@arbitrage/core/caching';
import { WorkerStats } from '../types/cache-types';

export interface WorkerTestConfig {
  workerCount: number;
  sharedBufferSizeMB?: number;
  maxQueueSize?: number;
  timeout?: number;
}

export interface ZeroCopyTestResult {
  latencyUs: number;
  memoryAddressMatch: boolean;
  dataCopied: boolean;
}

export interface ConcurrentReadStats {
  totalReads: number;
  successfulReads: number;
  failedReads: number;
  avgLatencyUs: number;
  p99LatencyUs: number;
  conflicts: number;
}

export interface ThreadSafetyResult {
  totalOperations: number;
  successfulOperations: number;
  conflicts: number;
  dataCorruption: boolean;
  passed: boolean;
}

export class WorkerTestHarness {
  private workers: Worker[] = [];
  private priceMatrix: PriceMatrix | null = null;
  private sharedBuffer: SharedArrayBuffer | null = null;
  private keyRegistryBuffer: SharedArrayBuffer | null = null;
  private config: WorkerTestConfig = {
    workerCount: 4,
    sharedBufferSizeMB: 64,
    maxQueueSize: 1000,
    timeout: 30000,
  };

  /**
   * Setup worker test environment with SharedArrayBuffer
   */
  async setup(config?: Partial<WorkerTestConfig>): Promise<void> {
    this.config = { ...this.config, ...config };

    // Create PriceMatrix with SharedArrayBuffer
    this.priceMatrix = new PriceMatrix({
      maxPairs: 1000,
      reserveSlots: 100,
    });

    // Get SharedArrayBuffers
    this.sharedBuffer = this.priceMatrix.getSharedBuffer();
    this.keyRegistryBuffer = this.priceMatrix.getKeyRegistryBuffer();

    if (!this.sharedBuffer) {
      throw new Error('Failed to create SharedArrayBuffer');
    }
  }

  /**
   * Spawn worker threads
   */
  async spawnWorkers(count?: number): Promise<void> {
    const workerCount = count ?? this.config.workerCount;
    // Use compiled JS for worker threads since Node's worker_threads
    // doesn't support .ts files directly (no ts-jest transform)
    const workerPath = join(__dirname, '../../../core/dist/async/event-processor-worker.js');

    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(workerPath, {
        workerData: {
          workerId: i,
          priceBuffer: this.sharedBuffer,
          keyRegistryBuffer: this.keyRegistryBuffer,
        },
      });

      this.workers.push(worker);
    }

    // Wait for workers to initialize
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  /**
   * Terminate all workers
   */
  async terminateAll(): Promise<void> {
    await Promise.all(
      this.workers.map(worker => worker.terminate())
    );
    this.workers = [];
  }

  /**
   * Get PriceMatrix instance
   */
  getPriceMatrix(): PriceMatrix {
    if (!this.priceMatrix) {
      throw new Error('PriceMatrix not initialized. Call setup() first.');
    }
    return this.priceMatrix;
  }

  /**
   * Test zero-copy read performance
   */
  async testZeroCopyRead(key: string): Promise<ZeroCopyTestResult> {
    if (!this.priceMatrix || this.workers.length === 0) {
      throw new Error('Workers not initialized. Call setup() and spawnWorkers() first.');
    }

    // Write price in main thread
    const testPrice = 123.45;
    const timestamp = Date.now();
    this.priceMatrix.setPrice(key, testPrice, timestamp);

    // Measure worker read latency
    const startTime = process.hrtime.bigint();

    // Send message to worker to read price
    const worker = this.workers[0];
    const result = await this.sendTaskToWorker(worker, {
      type: 'get_price',
      key,
    });

    const endTime = process.hrtime.bigint();
    const latencyNs = Number(endTime - startTime);
    const latencyUs = latencyNs / 1000;

    // Verify worker got correct value
    const memoryAddressMatch = result.price === testPrice;
    const dataCopied = latencyUs > 10; // If >10μs, likely copied data

    return {
      latencyUs,
      memoryAddressMatch,
      dataCopied: !dataCopied, // Inverted logic
    };
  }

  /**
   * Test concurrent reads from multiple workers
   */
  async testConcurrentReads(keys: string[], workerCount?: number): Promise<ConcurrentReadStats> {
    const workers = workerCount ? this.workers.slice(0, workerCount) : this.workers;

    if (workers.length === 0) {
      throw new Error('No workers available. Call spawnWorkers() first.');
    }

    // Pre-populate cache with test data
    for (const key of keys) {
      this.priceMatrix!.setPrice(key, Math.random() * 1000, Date.now());
    }

    // Launch concurrent reads
    const latencies: number[] = [];
    const results: Array<Promise<any>> = [];
    let conflicts = 0;

    for (let i = 0; i < keys.length; i++) {
      const worker = workers[i % workers.length];
      const key = keys[i];

      const startTime = process.hrtime.bigint();
      const resultPromise = this.sendTaskToWorker(worker, {
        type: 'get_price',
        key,
      }).then(result => {
        const endTime = process.hrtime.bigint();
        const latencyUs = Number(endTime - startTime) / 1000;
        latencies.push(latencyUs);

        if (!result || result.price === null) {
          conflicts++;
        }

        return result;
      });

      results.push(resultPromise);
    }

    // Wait for all reads to complete
    const allResults = await Promise.all(results);

    // Calculate statistics
    latencies.sort((a, b) => a - b);
    const avgLatencyUs = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const p99Index = Math.floor(latencies.length * 0.99);
    const p99LatencyUs = latencies[p99Index] || latencies[latencies.length - 1];

    return {
      totalReads: keys.length,
      successfulReads: allResults.filter(r => r && r.price !== null).length,
      failedReads: allResults.filter(r => !r || r.price === null).length,
      avgLatencyUs,
      p99LatencyUs,
      conflicts,
    };
  }

  /**
   * Test thread safety with concurrent writes and reads
   */
  async testThreadSafety(writes: number, reads: number): Promise<ThreadSafetyResult> {
    if (!this.priceMatrix || this.workers.length === 0) {
      throw new Error('Workers not initialized.');
    }

    const testKey = 'price:test:threadsafety';
    let dataCorruption = false;
    let conflicts = 0;

    // Main thread writes
    const writePromises = [];
    for (let i = 0; i < writes; i++) {
      const promise = Promise.resolve().then(() => {
        this.priceMatrix!.setPrice(testKey, i, Date.now());
      });
      writePromises.push(promise);
    }

    // Workers read concurrently
    const readPromises = [];
    for (let i = 0; i < reads; i++) {
      const worker = this.workers[i % this.workers.length];
      const promise = this.sendTaskToWorker(worker, {
        type: 'get_price',
        key: testKey,
      }).then(result => {
        // Check if we got valid data
        if (!result || result.price === null || result.price < 0 || result.price >= writes) {
          conflicts++;
        }
        return result;
      }).catch(() => {
        conflicts++;
      });
      readPromises.push(promise);
    }

    // Wait for all operations
    await Promise.all([...writePromises, ...readPromises]);

    // Verify final state
    const finalValue = this.priceMatrix.getPrice(testKey);
    if (!finalValue || finalValue.price < 0 || finalValue.price >= writes) {
      dataCorruption = true;
    }

    return {
      totalOperations: writes + reads,
      successfulOperations: writes + reads - conflicts,
      conflicts,
      dataCorruption,
      passed: conflicts === 0 && !dataCorruption,
    };
  }

  /**
   * Test race conditions with atomic operations
   */
  async testAtomicOperations(operations: number): Promise<{ failures: number }> {
    if (!this.priceMatrix) {
      throw new Error('PriceMatrix not initialized.');
    }

    let failures = 0;
    const testKey = 'price:test:atomic';

    // Initialize with known value
    this.priceMatrix.setPrice(testKey, 0, Date.now());

    // Concurrent increments
    const promises = [];
    for (let i = 0; i < operations; i++) {
      const promise = Promise.resolve().then(() => {
        const current = this.priceMatrix!.getPrice(testKey);
        if (current) {
          this.priceMatrix!.setPrice(testKey, current.price + 1, Date.now());
        } else {
          failures++;
        }
      });
      promises.push(promise);
    }

    await Promise.all(promises);

    // Check final value (should be operations count if truly atomic)
    const final = this.priceMatrix.getPrice(testKey);
    if (!final || final.price !== operations) {
      failures = Math.abs(operations - (final?.price ?? 0));
    }

    return { failures };
  }

  /**
   * Assert zero-copy access (no memory copy occurred)
   */
  assertNoMemoryCopy(result: ZeroCopyTestResult): void {
    if (result.dataCopied) {
      throw new Error('Data was copied instead of zero-copy access');
    }

    if (!result.memoryAddressMatch) {
      throw new Error('Worker did not read from shared memory');
    }

    if (result.latencyUs > 10) {
      throw new Error(`Read latency ${result.latencyUs.toFixed(2)}μs too high for zero-copy (expected <10μs)`);
    }
  }

  /**
   * Assert thread safety (no conflicts or corruption)
   */
  assertThreadSafe(result: ThreadSafetyResult): void {
    if (!result.passed) {
      const errors: string[] = [];

      if (result.conflicts > 0) {
        errors.push(`${result.conflicts} read conflicts detected`);
      }

      if (result.dataCorruption) {
        errors.push('Data corruption detected');
      }

      throw new Error(`Thread safety violations: ${errors.join(', ')}`);
    }
  }

  /**
   * Get worker stats
   */
  getWorkerStats(): WorkerStats {
    return {
      totalTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
      avgLatencyMs: 0,
      p99LatencyMs: 0,
      utilization: 0,
    };
  }

  /**
   * Helper: Send task to worker and wait for response
   */
  private async sendTaskToWorker(worker: Worker, task: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Worker task timeout'));
      }, this.config.timeout);

      worker.once('message', (message) => {
        clearTimeout(timeout);
        // Unwrap worker response: { taskId, success, result, processingTime }
        // Callers expect the inner result directly (e.g., { price, timestamp })
        if (message.success && message.result !== undefined) {
          resolve(message.result);
        } else {
          resolve(message);
        }
      });

      worker.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      worker.postMessage({
        type: 'process_task',
        taskId: `test-${Date.now()}`,
        taskType: task.type,
        taskData: task,
      });
    });
  }
}
