/**
 * Worker Thread Test Fixtures
 *
 * Provides test data and configurations for worker thread integration tests.
 * Supports various workload patterns: read-heavy, write-heavy, mixed, concurrent.
 */

export interface WorkerConfig {
  workers: number;
  sharedBufferSizeMB: number;
  maxQueueSize?: number;
  timeout?: number;
}

export interface WorkloadPattern {
  reads: number;
  writes: number;
  concurrent?: boolean;
  durationMs?: number;
}

export interface WorkerMessage {
  taskId: string;
  type: string;
  data: any;
}

/**
 * Worker Thread Fixtures
 */
export const WorkerFixtures = {
  /**
   * Single worker configuration (minimal)
   */
  singleWorker: (): WorkerConfig => ({
    workers: 1,
    sharedBufferSizeMB: 16,
    maxQueueSize: 100,
    timeout: 5000,
  }),

  /**
   * Dual workers configuration
   */
  dualWorkers: (): WorkerConfig => ({
    workers: 2,
    sharedBufferSizeMB: 32,
    maxQueueSize: 500,
    timeout: 10000,
  }),

  /**
   * Worker pool configuration (production-like)
   */
  workerPool: (): WorkerConfig => ({
    workers: 4,
    sharedBufferSizeMB: 64,
    maxQueueSize: 1000,
    timeout: 30000,
  }),

  /**
   * Large worker pool (stress testing)
   */
  largeWorkerPool: (): WorkerConfig => ({
    workers: 8,
    sharedBufferSizeMB: 128,
    maxQueueSize: 5000,
    timeout: 60000,
  }),

  /**
   * Read-heavy workload (typical for price lookups)
   */
  readHeavyWorkload: (): WorkloadPattern => ({
    reads: 1000,
    writes: 10,
    concurrent: true,
  }),

  /**
   * Write-heavy workload (cache population)
   */
  writeHeavyWorkload: (): WorkloadPattern => ({
    reads: 10,
    writes: 1000,
    concurrent: false, // Sequential writes
  }),

  /**
   * Mixed workload (realistic production)
   */
  mixedWorkload: (): WorkloadPattern => ({
    reads: 500,
    writes: 500,
    concurrent: true,
  }),

  /**
   * Concurrent read workload (thread-safety testing)
   */
  concurrentReads: (readCount: number = 1000): WorkloadPattern => ({
    reads: readCount,
    writes: 0,
    concurrent: true,
  }),

  /**
   * Burst workload (spike testing)
   */
  burstWorkload: (): WorkloadPattern => ({
    reads: 5000,
    writes: 500,
    concurrent: true,
    durationMs: 1000, // All in 1 second
  }),

  /**
   * Generate worker messages for testing
   */
  generateMessages: (count: number, type: string = 'json_parsing'): WorkerMessage[] => {
    const messages: WorkerMessage[] = [];

    for (let i = 0; i < count; i++) {
      messages.push({
        taskId: `task-${i}`,
        type,
        data: generateTestData(type, i),
      });
    }

    return messages;
  },

  /**
   * Generate price lookup messages
   */
  priceLookupMessages: (keys: string[]): WorkerMessage[] => {
    return keys.map((key, i) => ({
      taskId: `price-lookup-${i}`,
      type: 'price_lookup',
      data: { key },
    }));
  },

  /**
   * Generate batch price lookup messages
   */
  batchPriceLookupMessages: (keyBatches: string[][]): WorkerMessage[] => {
    return keyBatches.map((keys, i) => ({
      taskId: `batch-price-lookup-${i}`,
      type: 'batch_price_lookup',
      data: { keys },
    }));
  },

  /**
   * SharedArrayBuffer test data
   */
  sharedBufferData: {
    /**
     * Small buffer (testing)
     */
    small: (): SharedArrayBuffer => new SharedArrayBuffer(1024), // 1KB

    /**
     * Medium buffer (typical)
     */
    medium: (): SharedArrayBuffer => new SharedArrayBuffer(16 * 1024 * 1024), // 16MB

    /**
     * Large buffer (production)
     */
    large: (): SharedArrayBuffer => new SharedArrayBuffer(64 * 1024 * 1024), // 64MB

    /**
     * Custom size buffer
     */
    custom: (sizeMB: number): SharedArrayBuffer => new SharedArrayBuffer(sizeMB * 1024 * 1024),
  },
};

/**
 * Helper: Generate test data based on message type
 */
function generateTestData(type: string, index: number): any {
  switch (type) {
    case 'json_parsing':
      return { jsonString: JSON.stringify({ index, data: 'test', timestamp: Date.now() }) };

    case 'price_calculation':
      return {
        reserve0: (BigInt(1000000) * BigInt(index + 1)).toString(),
        reserve1: (BigInt(2000000) * BigInt(index + 1)).toString(),
        fee: 30, // 0.3% fee
      };

    case 'arbitrage_detection':
      return {
        pairs: [
          { token0: 'USDT', token1: 'ETH', reserve0: '1000000', reserve1: '500' },
          { token0: 'ETH', token1: 'WBTC', reserve0: '500', reserve1: '25' },
          { token0: 'WBTC', token1: 'USDT', reserve0: '25', reserve1: '1000000' },
        ],
      };

    default:
      return { index, timestamp: Date.now() };
  }
}

/**
 * Helper: Create mock worker responses
 */
export function createMockWorkerResponse(taskId: string, success: boolean = true, processingTime: number = 10): any {
  return {
    taskId,
    success,
    result: success ? { processed: true } : null,
    error: success ? null : 'Mock error',
    processingTime,
  };
}

/**
 * Helper: Generate concurrent task submissions
 */
export function generateConcurrentTasks(count: number, type: string = 'json_parsing'): Array<() => Promise<any>> {
  const tasks: Array<() => Promise<any>> = [];

  for (let i = 0; i < count; i++) {
    tasks.push(async () => {
      // Simulate async work
      await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
      return { taskId: `task-${i}`, result: 'completed' };
    });
  }

  return tasks;
}
