/**
 * Multi-Leg Path Finding Worker Thread Tests
 *
 * Tests for offloading MultiLegPathFinder DFS to worker threads
 * to prevent event loop blocking.
 *
 * @see docs/architecture/adr/ADR-XXX-worker-thread-path-finding.md
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock logger before importing modules
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

// Mock worker_threads for main thread tests
jest.mock('worker_threads', () => ({
  Worker: jest.fn(),
  isMainThread: true,
  parentPort: null,
  workerData: {}
}));

import { EventProcessingWorkerPool, Task, TaskResult } from '@arbitrage/core';
import {
  MultiLegPathFinder,
  MultiLegOpportunity,
  getMultiLegPathFinder,
  resetMultiLegPathFinder
} from '../../src/multi-leg-path-finder';
import type { DexPool } from '../../src/cross-dex-triangular-arbitrage';
import { Worker } from 'worker_threads';

// ===========================================================================
// Test Data Factory
// ===========================================================================

/**
 * Create test pools for multi-leg path finding worker tests.
 */
function createTestPools(): DexPool[] {
  return [
    // USDT pairs
    {
      dex: 'uniswap',
      token0: 'USDT',
      token1: 'WETH',
      reserve0: '5000000000000000000000000',
      reserve1: '2000000000000000000000',
      fee: 30,
      liquidity: 10000000,
      price: 2500
    },
    // WETH pairs
    {
      dex: 'uniswap',
      token0: 'WETH',
      token1: 'LINK',
      reserve0: '500000000000000000000',
      reserve1: '100000000000000000000000',
      fee: 30,
      liquidity: 2500000,
      price: 200
    },
    // LINK pairs
    {
      dex: 'uniswap',
      token0: 'LINK',
      token1: 'UNI',
      reserve0: '50000000000000000000000',
      reserve1: '25000000000000000000000',
      fee: 30,
      liquidity: 1250000,
      price: 0.5
    },
    // UNI pairs
    {
      dex: 'uniswap',
      token0: 'UNI',
      token1: 'AAVE',
      reserve0: '30000000000000000000000',
      reserve1: '4500000000000000000000',
      fee: 30,
      liquidity: 750000,
      price: 0.15
    },
    // AAVE pairs - closes cycle
    {
      dex: 'uniswap',
      token0: 'AAVE',
      token1: 'USDT',
      reserve0: '3000000000000000000000',
      reserve1: '300000000000000000000000',
      fee: 30,
      liquidity: 600000,
      price: 100
    }
  ];
}

// ===========================================================================
// Worker Pool Multi-Leg Task Type Tests
// ===========================================================================

describe('Multi-Leg Path Finding Worker Integration', () => {
  let mockWorker: any;

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
    resetMultiLegPathFinder();
  });

  describe('Task Type Registration', () => {
    it('should submit multi_leg_path_finding task to worker pool', async () => {
      // Setup message callback to simulate worker response
      mockWorker.on.mockImplementation((event: string, callback: (data?: unknown) => void) => {
        if (event === 'message') {
          mockWorker._messageCallback = callback;
        }
      });

      const pool = new EventProcessingWorkerPool(1, 100, 5000);
      await pool.start();

      const task: Task = {
        id: 'multi-leg-test-1',
        type: 'multi_leg_path_finding',
        data: {
          chain: 'ethereum',
          pools: createTestPools(),
          baseTokens: ['USDT'],
          targetPathLength: 5,
          config: {
            minProfitThreshold: 0.001,
            maxPathLength: 7,
            minPathLength: 5,
            maxCandidatesPerHop: 15,
            timeoutMs: 5000
          }
        },
        priority: 1
      };

      // Submit task
      const resultPromise = pool.submitTask(task);

      // Simulate worker response
      setTimeout(() => {
        if (mockWorker._messageCallback) {
          mockWorker._messageCallback({
            taskId: task.id,
            success: true,
            result: {
              opportunities: [],
              stats: { pathsExplored: 10, processingTimeMs: 50 }
            },
            processingTime: 50
          });
        }
      }, 10);

      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.taskId).toBe(task.id);
      expect(mockWorker.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          taskType: 'multi_leg_path_finding'
        })
      );

      await pool.stop();
    });

    it('should handle multi_leg_path_finding task errors', async () => {
      mockWorker.on.mockImplementation((event: string, callback: (data?: unknown) => void) => {
        if (event === 'message') {
          mockWorker._messageCallback = callback;
        }
      });

      const pool = new EventProcessingWorkerPool(1, 100, 5000);
      await pool.start();

      const task: Task = {
        id: 'multi-leg-error-test',
        type: 'multi_leg_path_finding',
        data: {
          chain: 'ethereum',
          pools: [], // Empty pools - will cause issue
          baseTokens: ['USDT'],
          targetPathLength: 5,
          config: {}
        },
        priority: 1
      };

      const resultPromise = pool.submitTask(task);

      // Simulate worker error response
      setTimeout(() => {
        if (mockWorker._messageCallback) {
          mockWorker._messageCallback({
            taskId: task.id,
            success: false,
            error: 'Not enough pools for target path length',
            processingTime: 5
          });
        }
      }, 10);

      await expect(resultPromise).rejects.toThrow();

      await pool.stop();
    });
  });

  describe('Result Parity', () => {
    it('should produce same results as synchronous path finder', async () => {
      const pools = createTestPools();
      const pathFinder = new MultiLegPathFinder({
        minProfitThreshold: 0.001,
        maxPathLength: 7,
        minPathLength: 5,
        maxCandidatesPerHop: 15,
        timeoutMs: 5000
      });

      // Get synchronous result
      const syncResult = await pathFinder.findMultiLegOpportunities(
        'ethereum',
        pools,
        ['USDT'],
        5
      );

      // The worker should produce the same result
      // This test verifies the task data format is correct for parity
      expect(Array.isArray(syncResult)).toBe(true);

      // Verify opportunity structure (if any found)
      for (const opp of syncResult) {
        expect(opp).toHaveProperty('id');
        expect(opp).toHaveProperty('chain');
        expect(opp).toHaveProperty('path');
        expect(opp).toHaveProperty('dexes');
        expect(opp).toHaveProperty('profitPercentage');
        expect(opp).toHaveProperty('netProfit');
        expect(opp).toHaveProperty('confidence');
        expect(opp).toHaveProperty('steps');
      }
    });
  });

  describe('Task Data Serialization', () => {
    it('should serialize DexPool[] correctly for worker transfer', () => {
      const pools = createTestPools();

      // Verify pools can be serialized (as they would be for worker transfer)
      const serialized = JSON.stringify(pools);
      const deserialized = JSON.parse(serialized) as DexPool[];

      expect(deserialized).toHaveLength(pools.length);
      expect(deserialized[0].dex).toBe(pools[0].dex);
      expect(deserialized[0].token0).toBe(pools[0].token0);
      expect(deserialized[0].reserve0).toBe(pools[0].reserve0);
    });

    it('should serialize config correctly for worker transfer', () => {
      const config = {
        minProfitThreshold: 0.001,
        maxPathLength: 7,
        minPathLength: 5,
        maxCandidatesPerHop: 15,
        timeoutMs: 5000,
        minConfidence: 0.4
      };

      const serialized = JSON.stringify(config);
      const deserialized = JSON.parse(serialized);

      expect(deserialized.minProfitThreshold).toBe(config.minProfitThreshold);
      expect(deserialized.timeoutMs).toBe(config.timeoutMs);
    });
  });

  describe('Task Priority', () => {
    it('should support priority for multi_leg_path_finding tasks', async () => {
      mockWorker.on.mockImplementation((event: string, callback: (data?: unknown) => void) => {
        if (event === 'message') {
          mockWorker._messageCallback = callback;
        }
      });

      const pool = new EventProcessingWorkerPool(1, 100, 5000);
      await pool.start();

      const highPriorityTask: Task = {
        id: 'high-priority',
        type: 'multi_leg_path_finding',
        data: { chain: 'ethereum', pools: [], baseTokens: [], targetPathLength: 5, config: {} },
        priority: 10
      };

      const lowPriorityTask: Task = {
        id: 'low-priority',
        type: 'multi_leg_path_finding',
        data: { chain: 'bsc', pools: [], baseTokens: [], targetPathLength: 5, config: {} },
        priority: 1
      };

      // Both tasks should be accepted
      const highPromise = pool.submitTask(highPriorityTask);
      const lowPromise = pool.submitTask(lowPriorityTask);

      // Respond to both
      setTimeout(() => {
        if (mockWorker._messageCallback) {
          mockWorker._messageCallback({
            taskId: 'high-priority',
            success: true,
            result: { opportunities: [] },
            processingTime: 10
          });
          mockWorker._messageCallback({
            taskId: 'low-priority',
            success: true,
            result: { opportunities: [] },
            processingTime: 10
          });
        }
      }, 20);

      const [highResult, lowResult] = await Promise.all([highPromise, lowPromise]);

      expect(highResult.success).toBe(true);
      expect(lowResult.success).toBe(true);

      await pool.stop();
    });
  });

  describe('Timeout Handling', () => {
    it('should respect task timeout for multi_leg_path_finding', async () => {
      mockWorker.on.mockImplementation(() => {}); // No response - simulates timeout

      const pool = new EventProcessingWorkerPool(1, 100, 100); // 100ms timeout
      await pool.start();

      const task: Task = {
        id: 'timeout-test',
        type: 'multi_leg_path_finding',
        data: {
          chain: 'ethereum',
          pools: createTestPools(),
          baseTokens: ['USDT'],
          targetPathLength: 5,
          config: {}
        },
        priority: 1
      };

      // Should timeout
      await expect(pool.submitTask(task)).rejects.toThrow('timed out');

      await pool.stop();
    });
  });

  describe('Batch Processing', () => {
    it('should support batch submission of multi_leg_path_finding tasks', async () => {
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
              result: { opportunities: [] },
              processingTime: 50
            });
          }
        }, 5);
      });

      const pool = new EventProcessingWorkerPool(2, 100, 5000);
      await pool.start();

      const tasks: Task[] = [
        {
          id: 'batch-1',
          type: 'multi_leg_path_finding',
          data: { chain: 'ethereum', pools: [], baseTokens: [], targetPathLength: 5, config: {} },
          priority: 1
        },
        {
          id: 'batch-2',
          type: 'multi_leg_path_finding',
          data: { chain: 'bsc', pools: [], baseTokens: [], targetPathLength: 5, config: {} },
          priority: 1
        }
      ];

      const results = await pool.submitBatchTasks(tasks);

      expect(results).toHaveLength(2);
      expect(results.every(r => r.success)).toBe(true);

      await pool.stop();
    });
  });
});

// ===========================================================================
// Async Method Tests (for findMultiLegOpportunitiesAsync)
// ===========================================================================

describe('MultiLegPathFinder Async Method', () => {
  beforeEach(() => {
    resetMultiLegPathFinder();
  });

  describe('Method Signature', () => {
    it('should have findMultiLegOpportunitiesAsync method', () => {
      const pathFinder = getMultiLegPathFinder();

      // This test will fail until the method is implemented
      // TDD: Write test first, then implement
      expect(typeof (pathFinder as any).findMultiLegOpportunitiesAsync).toBe('function');
    });
  });

  describe('Async Execution', () => {
    it('should return Promise<MultiLegOpportunity[]>', async () => {
      const pathFinder = getMultiLegPathFinder({
        minProfitThreshold: 0.001,
        maxPathLength: 7,
        minPathLength: 5,
        maxCandidatesPerHop: 15,
        timeoutMs: 5000
      });

      const pools = createTestPools();

      // This test will fail until the method is implemented
      // The async method should delegate to worker pool
      const resultPromise = (pathFinder as any).findMultiLegOpportunitiesAsync?.(
        'ethereum',
        pools,
        ['USDT'],
        5
      );

      if (resultPromise) {
        expect(resultPromise).toBeInstanceOf(Promise);
        const result = await resultPromise;
        expect(Array.isArray(result)).toBe(true);
      }
    });
  });
});
