// @ts-nocheck
/**
 * ExecutionPipeline Unit Tests
 *
 * Tests for the hot-path execution pipeline extracted from engine.ts.
 * All dependencies are injected via PipelineDeps — fully mocked here.
 *
 * @see execution-pipeline.ts
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ExecutionPipeline, type PipelineDeps } from '../../src/execution-pipeline';

// H1 FIX: Mock prometheus metrics (now called from pipeline after W1-42 extraction)
jest.mock('../../src/services/prometheus-metrics', () => ({
  recordExecutionAttempt: jest.fn(),
  recordExecutionSuccess: jest.fn(),
  recordVolume: jest.fn(),
}));

// Make this file a module to avoid TS2451 redeclaration errors
export {};

// =============================================================================
// Helpers
// =============================================================================

/** Flush microtasks so fire-and-forget promises in processQueueItems settle. */
const flushMicrotasks = () => new Promise<void>((r) => setImmediate(r));

/** Flush microtasks multiple times to handle chained async work. */
const flushMultiple = async (times = 3) => {
  for (let i = 0; i < times; i++) {
    await flushMicrotasks();
  }
};

const createMockOpportunity = (overrides = {}) => ({
  id: 'opp-1',
  type: 'intra-chain',
  buyChain: 'ethereum',
  buyDex: 'uniswap_v3',
  sellDex: 'sushiswap',
  expectedProfit: 100,
  path: ['WETH', 'USDC'],
  ...overrides,
});

const createMockDeps = (overrides = {}): PipelineDeps => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  perfLogger: {
    logExecutionResult: jest.fn(),
    logEventLatency: jest.fn(),
  },
  stateManager: {
    isRunning: jest.fn().mockReturnValue(true),
  },
  stats: {
    executionAttempts: 0,
    successfulExecutions: 0,
    failedExecutions: 0,
    lockConflicts: 0,
    staleLockRecoveries: 0,
    executionTimeouts: 0,
    circuitBreakerBlocks: 0,
  },
  queueService: {
    size: jest.fn().mockReturnValue(0),
    dequeue: jest.fn(),
    enqueue: jest.fn(),
  },
  maxConcurrentExecutions: 5,
  lockManager: {
    withLock: jest.fn().mockImplementation(async (_resource, fn) => {
      await fn();
      return { success: true };
    }),
    forceRelease: jest.fn().mockResolvedValue(true),
  },
  lockConflictTracker: {
    recordConflict: jest.fn().mockReturnValue(false),
    getConflictInfo: jest.fn(),
    clear: jest.fn(),
  },
  opportunityConsumer: {
    ackMessageAfterExecution: jest.fn().mockResolvedValue(undefined),
    markActive: jest.fn(),
    markComplete: jest.fn(),
  },
  strategyFactory: {
    execute: jest.fn().mockResolvedValue({
      success: true,
      actualProfit: 50,
      gasCost: 10,
    }),
  },
  cbManager: null,
  riskOrchestrator: null,
  abTestingFramework: null,
  getIsSimulationMode: jest.fn().mockReturnValue(false),
  getRiskManagementEnabled: jest.fn().mockReturnValue(false),
  buildStrategyContext: jest.fn().mockReturnValue({}),
  publishExecutionResult: jest.fn().mockResolvedValue(undefined),
  getLastGasPrice: jest.fn().mockReturnValue(20000000000n),
  ...overrides,
});

// =============================================================================
// Tests
// =============================================================================

describe('ExecutionPipeline', () => {
  let deps: PipelineDeps;
  let pipeline: ExecutionPipeline;

  beforeEach(() => {
    deps = createMockDeps();
    pipeline = new ExecutionPipeline(deps);
  });

  // ===========================================================================
  // processQueueItems — basic flow
  // ===========================================================================

  describe('processQueueItems — basic flow', () => {
    it('should not process when stateManager.isRunning() is false', () => {
      deps.stateManager.isRunning.mockReturnValue(false);
      deps.queueService.size.mockReturnValue(3);

      pipeline.processQueueItems();

      expect(deps.queueService.dequeue).not.toHaveBeenCalled();
    });

    it('should not process when queue is empty', () => {
      deps.queueService.size.mockReturnValue(0);

      pipeline.processQueueItems();

      expect(deps.queueService.dequeue).not.toHaveBeenCalled();
    });

    it('should dequeue and execute a single opportunity', async () => {
      const opp = createMockOpportunity();
      deps.queueService.size
        .mockReturnValueOnce(1)   // loop guard
        .mockReturnValueOnce(0);  // next iteration exits
      deps.queueService.dequeue.mockReturnValueOnce(opp);

      pipeline.processQueueItems();

      // The fire-and-forget async execution needs microtask flushing
      await flushMultiple();

      expect(deps.queueService.dequeue).toHaveBeenCalledTimes(1);
      expect(deps.lockManager.withLock).toHaveBeenCalledTimes(1);
      expect(deps.strategyFactory.execute).toHaveBeenCalledWith(opp, expect.anything());
      expect(deps.publishExecutionResult).toHaveBeenCalled();
      expect(deps.opportunityConsumer.ackMessageAfterExecution).toHaveBeenCalledWith('opp-1');
    });

    it('should respect maxConcurrentExecutions limit', async () => {
      // Create a slow-resolving strategy so executions stay "active"
      let resolvers: Array<() => void> = [];
      deps.lockManager.withLock.mockImplementation(async (_resource, fn) => {
        const p = new Promise<void>((resolve) => {
          resolvers.push(resolve);
        });
        await p;
        return { success: true };
      });
      deps.maxConcurrentExecutions = 2;

      // Queue has 5 items, but only 2 should be dequeued
      let sizeCallCount = 0;
      deps.queueService.size.mockImplementation(() => {
        return 5; // always has items
      });
      deps.queueService.dequeue
        .mockReturnValueOnce(createMockOpportunity({ id: 'opp-1' }))
        .mockReturnValueOnce(createMockOpportunity({ id: 'opp-2' }))
        .mockReturnValueOnce(createMockOpportunity({ id: 'opp-3' }));

      pipeline.processQueueItems();

      // Only 2 should be dequeued (maxConcurrentExecutions = 2)
      expect(deps.queueService.dequeue).toHaveBeenCalledTimes(2);
      expect(pipeline.getActiveExecutionCount()).toBe(2);

      // Resolve all pending locks to clean up
      resolvers.forEach((r) => r());
      await flushMultiple();
    });

    it('should guard against concurrent entry (isProcessingQueue)', () => {
      // Make the queue size always report items so the loop would spin
      // but dequeue returns undefined to terminate the inner while loop.
      deps.queueService.size.mockReturnValue(1);
      deps.queueService.dequeue.mockReturnValue(undefined);

      // First call should enter and exit normally
      pipeline.processQueueItems();

      // Simulate a scenario: set isProcessingQueue = true externally
      // by calling processQueueItems from within itself.
      // In practice, we can test that a second synchronous call
      // while the first is still "in the try block" is a no-op.
      // Since the first call completed, isProcessingQueue is false again.
      // We verify it resets by calling again successfully:
      deps.queueService.dequeue.mockClear();
      deps.queueService.size.mockReturnValue(1);
      deps.queueService.dequeue.mockReturnValue(undefined);

      pipeline.processQueueItems();
      // The fact that dequeue was called proves the guard was reset
      expect(deps.queueService.dequeue).toHaveBeenCalled();
    });

    it('should handle dequeue returning undefined gracefully', () => {
      deps.queueService.size.mockReturnValue(1);
      deps.queueService.dequeue.mockReturnValue(undefined);

      pipeline.processQueueItems();

      // Should break out of the loop without errors
      expect(deps.lockManager.withLock).not.toHaveBeenCalled();
    });

    it('should decrement activeExecutionCount after execution completes', async () => {
      const opp = createMockOpportunity();
      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0)
        .mockReturnValue(0); // for the .finally() re-check
      deps.queueService.dequeue.mockReturnValueOnce(opp);

      pipeline.processQueueItems();
      expect(pipeline.getActiveExecutionCount()).toBe(1);

      await flushMultiple();

      expect(pipeline.getActiveExecutionCount()).toBe(0);
    });
  });

  // ===========================================================================
  // processQueueItems — circuit breaker
  // ===========================================================================

  describe('processQueueItems — circuit breaker', () => {
    let mockCbManager;

    beforeEach(() => {
      mockCbManager = {
        canExecute: jest.fn().mockReturnValue(false), // CB blocks by default
        recordSuccess: jest.fn(),
        recordFailure: jest.fn(),
      };
      deps.cbManager = mockCbManager;
    });

    it('should re-enqueue opportunity when circuit breaker blocks execution', () => {
      const opp = createMockOpportunity();
      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp);

      pipeline.processQueueItems();

      expect(mockCbManager.canExecute).toHaveBeenCalledWith('ethereum');
      expect(deps.queueService.enqueue).toHaveBeenCalledWith(opp);
      expect(deps.stats.circuitBreakerBlocks).toBe(1);
      // Should NOT have attempted lock acquisition
      expect(deps.lockManager.withLock).not.toHaveBeenCalled();
    });

    it('should drop opportunity after MAX_CB_REENQUEUE_ATTEMPTS (3)', () => {
      const opp = createMockOpportunity({ id: 'cb-opp' });

      // Simulate 3 consecutive CB blocks for the same opportunity
      for (let attempt = 0; attempt < 3; attempt++) {
        deps.queueService.size
          .mockReturnValueOnce(1)
          .mockReturnValueOnce(0);
        deps.queueService.dequeue.mockReturnValueOnce(opp);

        pipeline.processQueueItems();
      }

      // First 2 calls re-enqueue, 3rd drops
      expect(deps.queueService.enqueue).toHaveBeenCalledTimes(2);
      expect(deps.stats.circuitBreakerBlocks).toBe(3);
      expect(deps.logger.warn).toHaveBeenCalledWith(
        'Dropping opportunity after max CB re-enqueue attempts',
        expect.objectContaining({
          opportunityId: 'cb-opp',
          attempts: 3,
        })
      );
    });

    it('should increment circuitBreakerBlocks stat on each CB block', () => {
      const opp1 = createMockOpportunity({ id: 'opp-a' });
      const opp2 = createMockOpportunity({ id: 'opp-b' });

      // Two different opportunities blocked once each
      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp1);
      pipeline.processQueueItems();

      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp2);
      pipeline.processQueueItems();

      expect(deps.stats.circuitBreakerBlocks).toBe(2);
    });

    it('should clear re-enqueue tracking when proceeding past CB', async () => {
      const opp = createMockOpportunity({ id: 'tracked-opp' });

      // First call: CB blocks, re-enqueue count goes to 1
      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp);
      pipeline.processQueueItems();
      expect(deps.queueService.enqueue).toHaveBeenCalledTimes(1);

      // Second call: CB allows — should clear tracking and execute
      mockCbManager.canExecute.mockReturnValue(true);
      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0)
        .mockReturnValue(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp);
      pipeline.processQueueItems();

      await flushMultiple();

      expect(deps.lockManager.withLock).toHaveBeenCalled();
      expect(deps.strategyFactory.execute).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // getActiveExecutionCount
  // ===========================================================================

  describe('getActiveExecutionCount', () => {
    it('should return 0 initially', () => {
      expect(pipeline.getActiveExecutionCount()).toBe(0);
    });

    it('should reflect active executions in progress', async () => {
      let resolver: () => void;
      deps.lockManager.withLock.mockImplementation(async (_resource, fn) => {
        await new Promise<void>((r) => { resolver = r; });
        return { success: true };
      });

      const opp = createMockOpportunity();
      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0)
        .mockReturnValue(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp);

      pipeline.processQueueItems();

      // Execution is in flight
      expect(pipeline.getActiveExecutionCount()).toBe(1);

      // Resolve the pending lock
      resolver!();
      await flushMultiple();

      expect(pipeline.getActiveExecutionCount()).toBe(0);
    });
  });

  // ===========================================================================
  // executeOpportunityWithLock (tested through processQueueItems)
  // ===========================================================================

  describe('executeOpportunityWithLock (via processQueueItems)', () => {
    it('should acquire lock and execute (success path)', async () => {
      const opp = createMockOpportunity();
      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0)
        .mockReturnValue(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp);

      pipeline.processQueueItems();
      await flushMultiple();

      expect(deps.lockManager.withLock).toHaveBeenCalledWith(
        'opportunity:opp-1',
        expect.any(Function),
        expect.objectContaining({ ttlMs: expect.any(Number), retries: 0 })
      );
      expect(deps.opportunityConsumer.ackMessageAfterExecution).toHaveBeenCalledWith('opp-1');
      expect(deps.lockConflictTracker.clear).toHaveBeenCalledWith('opp-1');
    });

    it('should handle lock_not_acquired — increments lockConflicts', async () => {
      deps.lockManager.withLock.mockResolvedValue({
        success: false,
        reason: 'lock_not_acquired',
      });

      const opp = createMockOpportunity();
      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0)
        .mockReturnValue(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp);

      pipeline.processQueueItems();
      await flushMultiple();

      expect(deps.stats.lockConflicts).toBe(1);
      expect(deps.lockConflictTracker.recordConflict).toHaveBeenCalledWith('opp-1');
      expect(deps.logger.debug).toHaveBeenCalledWith(
        'Opportunity skipped - already being executed by another instance',
        expect.objectContaining({ id: 'opp-1' })
      );
    });

    it('should handle crash recovery: force release + retry on repeated conflicts', async () => {
      // First withLock returns lock_not_acquired
      // recordConflict returns true (threshold reached — force release)
      // forceRelease returns true
      // Second withLock (retry) succeeds
      deps.lockConflictTracker.recordConflict.mockReturnValue(true);
      deps.lockConflictTracker.getConflictInfo.mockReturnValue({ count: 3 });

      deps.lockManager.withLock
        .mockResolvedValueOnce({ success: false, reason: 'lock_not_acquired' })
        .mockImplementationOnce(async (_resource, fn) => {
          await fn();
          return { success: true };
        });

      const opp = createMockOpportunity();
      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0)
        .mockReturnValue(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp);

      pipeline.processQueueItems();
      await flushMultiple();

      expect(deps.lockManager.forceRelease).toHaveBeenCalledWith('opportunity:opp-1');
      expect(deps.stats.staleLockRecoveries).toBe(1);
      expect(deps.lockConflictTracker.clear).toHaveBeenCalledWith('opp-1');
      expect(deps.opportunityConsumer.ackMessageAfterExecution).toHaveBeenCalledWith('opp-1');
    });

    it('should handle crash recovery with execution_error on retry', async () => {
      deps.lockConflictTracker.recordConflict.mockReturnValue(true);
      deps.lockConflictTracker.getConflictInfo.mockReturnValue({ count: 3 });

      deps.lockManager.withLock
        .mockResolvedValueOnce({ success: false, reason: 'lock_not_acquired' })
        .mockResolvedValueOnce({
          success: false,
          reason: 'execution_error',
          error: 'Strategy threw',
        });

      const opp = createMockOpportunity();
      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0)
        .mockReturnValue(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp);

      pipeline.processQueueItems();
      await flushMultiple();

      expect(deps.stats.staleLockRecoveries).toBe(1);
      expect(deps.logger.error).toHaveBeenCalledWith(
        'Opportunity execution failed after crash recovery',
        expect.objectContaining({ id: 'opp-1', error: 'Strategy threw' })
      );
      expect(deps.opportunityConsumer.ackMessageAfterExecution).toHaveBeenCalledWith('opp-1');
    });

    it('should handle redis_error — logs and returns', async () => {
      deps.lockManager.withLock.mockResolvedValue({
        success: false,
        reason: 'redis_error',
        error: { message: 'Connection refused' },
      });

      const opp = createMockOpportunity();
      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0)
        .mockReturnValue(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp);

      pipeline.processQueueItems();
      await flushMultiple();

      expect(deps.logger.error).toHaveBeenCalledWith(
        'Opportunity skipped - Redis unavailable',
        expect.objectContaining({
          id: 'opp-1',
          error: 'Connection refused',
        })
      );
      // Should NOT ack — returns before the ack at the end
      expect(deps.opportunityConsumer.ackMessageAfterExecution).not.toHaveBeenCalled();
    });

    it('should handle execution_error — logs and acks', async () => {
      deps.lockManager.withLock.mockResolvedValue({
        success: false,
        reason: 'execution_error',
        error: 'Strategy reverted',
      });

      const opp = createMockOpportunity();
      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0)
        .mockReturnValue(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp);

      pipeline.processQueueItems();
      await flushMultiple();

      expect(deps.logger.error).toHaveBeenCalledWith(
        'Opportunity execution failed',
        expect.objectContaining({ id: 'opp-1', error: 'Strategy reverted' })
      );
      expect(deps.opportunityConsumer.ackMessageAfterExecution).toHaveBeenCalledWith('opp-1');
    });
  });

  // ===========================================================================
  // executeOpportunity (tested through processQueueItems)
  // ===========================================================================

  describe('executeOpportunity (via processQueueItems)', () => {
    it('should reject opportunity missing buyChain', async () => {
      const opp = createMockOpportunity({ buyChain: undefined });
      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0)
        .mockReturnValue(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp);

      pipeline.processQueueItems();
      await flushMultiple();

      expect(deps.publishExecutionResult).toHaveBeenCalledWith(
        expect.objectContaining({
          opportunityId: 'opp-1',
          success: false,
          error: 'Missing required buyChain field',
        }),
        opp
      );
      expect(deps.opportunityConsumer.markComplete).toHaveBeenCalledWith('opp-1');
      // Should NOT call strategyFactory when buyChain is missing
      expect(deps.strategyFactory.execute).not.toHaveBeenCalled();
    });

    it('should execute via strategyFactory and publish result', async () => {
      const opp = createMockOpportunity();
      const mockResult = { success: true, actualProfit: 75, gasCost: 5 };
      deps.strategyFactory.execute.mockResolvedValue(mockResult);

      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0)
        .mockReturnValue(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp);

      pipeline.processQueueItems();
      await flushMultiple();

      expect(deps.buildStrategyContext).toHaveBeenCalled();
      expect(deps.strategyFactory.execute).toHaveBeenCalledWith(opp, expect.anything());
      expect(deps.publishExecutionResult).toHaveBeenCalledWith(mockResult, opp);
      expect(deps.perfLogger.logExecutionResult).toHaveBeenCalledWith(mockResult);
    });

    it('should increment stats on success', async () => {
      deps.strategyFactory.execute.mockResolvedValue({
        success: true,
        actualProfit: 50,
        gasCost: 10,
      });

      const opp = createMockOpportunity();
      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0)
        .mockReturnValue(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp);

      pipeline.processQueueItems();
      await flushMultiple();

      expect(deps.stats.executionAttempts).toBe(1);
      expect(deps.stats.successfulExecutions).toBe(1);
      expect(deps.stats.failedExecutions).toBe(0);
    });

    it('should increment stats on failure', async () => {
      deps.strategyFactory.execute.mockResolvedValue({
        success: false,
        error: 'Slippage exceeded',
      });

      const opp = createMockOpportunity();
      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0)
        .mockReturnValue(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp);

      pipeline.processQueueItems();
      await flushMultiple();

      expect(deps.stats.executionAttempts).toBe(1);
      expect(deps.stats.failedExecutions).toBe(1);
      expect(deps.stats.successfulExecutions).toBe(0);
    });

    it('should record circuit breaker success on successful execution', async () => {
      const mockCbManager = {
        canExecute: jest.fn().mockReturnValue(true),
        recordSuccess: jest.fn(),
        recordFailure: jest.fn(),
      };
      deps.cbManager = mockCbManager;

      deps.strategyFactory.execute.mockResolvedValue({
        success: true,
        actualProfit: 50,
        gasCost: 10,
      });

      const opp = createMockOpportunity();
      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0)
        .mockReturnValue(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp);

      pipeline.processQueueItems();
      await flushMultiple();

      expect(mockCbManager.recordSuccess).toHaveBeenCalledWith('ethereum');
      expect(mockCbManager.recordFailure).not.toHaveBeenCalled();
    });

    it('should record circuit breaker failure on failed execution', async () => {
      const mockCbManager = {
        canExecute: jest.fn().mockReturnValue(true),
        recordSuccess: jest.fn(),
        recordFailure: jest.fn(),
      };
      deps.cbManager = mockCbManager;

      deps.strategyFactory.execute.mockResolvedValue({
        success: false,
        error: 'Reverted',
      });

      const opp = createMockOpportunity();
      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0)
        .mockReturnValue(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp);

      pipeline.processQueueItems();
      await flushMultiple();

      expect(mockCbManager.recordFailure).toHaveBeenCalledWith('ethereum');
      expect(mockCbManager.recordSuccess).not.toHaveBeenCalled();
    });

    it('should increment failedExecutions and record CB failure when executeOpportunity throws', async () => {
      const mockCbManager = {
        canExecute: jest.fn().mockReturnValue(true),
        recordSuccess: jest.fn(),
        recordFailure: jest.fn(),
      };
      deps.cbManager = mockCbManager;

      deps.strategyFactory.execute.mockRejectedValue(new Error('Unexpected crash'));

      const opp = createMockOpportunity();
      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0)
        .mockReturnValue(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp);

      pipeline.processQueueItems();
      await flushMultiple();

      expect(deps.stats.failedExecutions).toBe(1);
      expect(mockCbManager.recordFailure).toHaveBeenCalledWith('ethereum');
      expect(deps.publishExecutionResult).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('Unexpected crash'),
        }),
        opp
      );
    });

    it('should mark active and complete on the opportunityConsumer', async () => {
      const opp = createMockOpportunity();
      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0)
        .mockReturnValue(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp);

      pipeline.processQueueItems();
      await flushMultiple();

      expect(deps.opportunityConsumer.markActive).toHaveBeenCalledWith('opp-1');
      expect(deps.opportunityConsumer.markComplete).toHaveBeenCalledWith('opp-1');
    });
  });

  // ===========================================================================
  // Risk management
  // ===========================================================================

  describe('Risk management', () => {
    it('should skip risk checks in simulation mode', async () => {
      const mockRiskOrchestrator = {
        assess: jest.fn(),
        recordOutcome: jest.fn(),
      };
      deps.riskOrchestrator = mockRiskOrchestrator;
      (deps.getRiskManagementEnabled as jest.Mock).mockReturnValue(true);
      (deps.getIsSimulationMode as jest.Mock).mockReturnValue(true); // <-- simulation mode ON

      const opp = createMockOpportunity();
      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0)
        .mockReturnValue(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp);

      pipeline = new ExecutionPipeline(deps);
      pipeline.processQueueItems();
      await flushMultiple();

      // Risk orchestrator should NOT be called
      expect(mockRiskOrchestrator.assess).not.toHaveBeenCalled();
      // But execution should still proceed
      expect(deps.strategyFactory.execute).toHaveBeenCalled();
    });

    it('should skip risk checks when riskManagementEnabled is false', async () => {
      const mockRiskOrchestrator = {
        assess: jest.fn(),
        recordOutcome: jest.fn(),
      };
      deps.riskOrchestrator = mockRiskOrchestrator;
      (deps.getRiskManagementEnabled as jest.Mock).mockReturnValue(false);
      (deps.getIsSimulationMode as jest.Mock).mockReturnValue(false);

      const opp = createMockOpportunity();
      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0)
        .mockReturnValue(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp);

      pipeline = new ExecutionPipeline(deps);
      pipeline.processQueueItems();
      await flushMultiple();

      expect(mockRiskOrchestrator.assess).not.toHaveBeenCalled();
      expect(deps.strategyFactory.execute).toHaveBeenCalled();
    });

    it('should reject opportunity when risk assessment says not allowed (DRAWDOWN_HALT)', async () => {
      const mockRiskOrchestrator = {
        assess: jest.fn().mockReturnValue({
          allowed: false,
          rejectionCode: 'DRAWDOWN_HALT',
          rejectionReason: 'Max drawdown exceeded',
          drawdownCheck: { state: 'HALT', sizeMultiplier: 0 },
        }),
        recordOutcome: jest.fn(),
      };
      deps.riskOrchestrator = mockRiskOrchestrator;
      (deps.getRiskManagementEnabled as jest.Mock).mockReturnValue(true);
      (deps.getIsSimulationMode as jest.Mock).mockReturnValue(false);

      const opp = createMockOpportunity();
      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0)
        .mockReturnValue(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp);

      pipeline = new ExecutionPipeline(deps);
      pipeline.processQueueItems();
      await flushMultiple();

      // Should NOT execute via strategy
      expect(deps.strategyFactory.execute).not.toHaveBeenCalled();
      // Should publish a skipped result
      expect(deps.publishExecutionResult).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('DRAWDOWN_HALT'),
        }),
        opp
      );
      expect(deps.logger.warn).toHaveBeenCalledWith(
        'Trade blocked by drawdown circuit breaker',
        expect.objectContaining({ id: 'opp-1', state: 'HALT' })
      );
    });

    it('should reject opportunity with LOW_EV rejection code', async () => {
      const mockRiskOrchestrator = {
        assess: jest.fn().mockReturnValue({
          allowed: false,
          rejectionCode: 'LOW_EV',
          rejectionReason: 'Expected value below threshold',
        }),
        recordOutcome: jest.fn(),
      };
      deps.riskOrchestrator = mockRiskOrchestrator;
      (deps.getRiskManagementEnabled as jest.Mock).mockReturnValue(true);
      (deps.getIsSimulationMode as jest.Mock).mockReturnValue(false);

      const opp = createMockOpportunity();
      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0)
        .mockReturnValue(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp);

      pipeline = new ExecutionPipeline(deps);
      pipeline.processQueueItems();
      await flushMultiple();

      expect(deps.strategyFactory.execute).not.toHaveBeenCalled();
      expect(deps.publishExecutionResult).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('LOW_EV'),
        }),
        opp
      );
    });

    it('should record risk outcome on successful execution', async () => {
      const mockRiskOrchestrator = {
        assess: jest.fn().mockReturnValue({
          allowed: true,
          evCalculation: { ev: 10 },
          positionSize: { fractionOfCapital: 0.05 },
          drawdownCheck: { state: 'NORMAL', sizeMultiplier: 1.0 },
        }),
        recordOutcome: jest.fn(),
      };
      deps.riskOrchestrator = mockRiskOrchestrator;
      (deps.getRiskManagementEnabled as jest.Mock).mockReturnValue(true);
      (deps.getIsSimulationMode as jest.Mock).mockReturnValue(false);

      deps.strategyFactory.execute.mockResolvedValue({
        success: true,
        actualProfit: 50,
        gasCost: 10,
      });

      const opp = createMockOpportunity();
      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0)
        .mockReturnValue(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp);

      pipeline = new ExecutionPipeline(deps);
      pipeline.processQueueItems();
      await flushMultiple();

      expect(mockRiskOrchestrator.recordOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          chain: 'ethereum',
          dex: 'uniswap_v3',
          success: true,
          actualProfit: 50,
          gasCost: 10,
        })
      );
    });
  });

  // ===========================================================================
  // A/B Testing
  // ===========================================================================

  describe('A/B testing', () => {
    it('should assign and record A/B testing variants', async () => {
      const mockVariants = new Map([
        ['exp-1', { variant: 'treatment', experimentId: 'exp-1' }],
      ]);
      const mockAbFramework = {
        assignAllVariants: jest.fn().mockReturnValue(mockVariants),
        recordResult: jest.fn().mockResolvedValue(undefined),
      };
      deps.abTestingFramework = mockAbFramework;

      const mockResult = { success: true, actualProfit: 50, gasCost: 10 };
      deps.strategyFactory.execute.mockResolvedValue(mockResult);

      const opp = createMockOpportunity();
      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0)
        .mockReturnValue(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp);

      pipeline = new ExecutionPipeline(deps);
      pipeline.processQueueItems();
      await flushMultiple();

      expect(mockAbFramework.assignAllVariants).toHaveBeenCalledWith(
        'opp-1',
        'ethereum',
        'uniswap_v3'
      );
      expect(mockAbFramework.recordResult).toHaveBeenCalledWith(
        'exp-1',
        expect.objectContaining({ variant: 'treatment' }),
        mockResult,
        expect.any(Number),
        false
      );
    });
  });

  // ===========================================================================
  // Timeout handling
  // ===========================================================================

  describe('Timeout handling', () => {
    beforeEach(() => {
      // Do not fake setImmediate — it is used by flushMicrotasks and
      // the .finally() handler in processQueueItems.
      jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should timeout execution after EXECUTION_TIMEOUT_MS', async () => {
      // Make lockManager.withLock pass through to executeWithTimeout,
      // and re-throw so the error propagates as execution_error in the lock result.
      deps.lockManager.withLock.mockImplementation(async (_resource, fn) => {
        try {
          await fn();
          return { success: true };
        } catch (error) {
          return { success: false, reason: 'execution_error', error };
        }
      });

      // Strategy never resolves — simulates a hung execution
      deps.strategyFactory.execute.mockImplementation(
        () => new Promise(() => {
          // never resolves
        })
      );

      const opp = createMockOpportunity();
      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0)
        .mockReturnValue(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp);

      pipeline.processQueueItems();

      // Advance past the execution timeout (55000ms default)
      await jest.advanceTimersByTimeAsync(60000);
      await flushMultiple();

      expect(deps.stats.executionTimeouts).toBe(1);
      expect(deps.logger.error).toHaveBeenCalledWith(
        'Execution timed out',
        expect.objectContaining({ opportunityId: 'opp-1' })
      );
    });

    it('should not timeout when execution completes before deadline', async () => {
      // Strategy resolves quickly
      deps.strategyFactory.execute.mockResolvedValue({
        success: true,
        actualProfit: 50,
        gasCost: 5,
      });

      const opp = createMockOpportunity();
      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0)
        .mockReturnValue(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp);

      pipeline.processQueueItems();

      // Let the quick execution complete — advance a small amount
      await jest.advanceTimersByTimeAsync(100);
      await flushMultiple();

      expect(deps.stats.executionTimeouts).toBe(0);
      expect(deps.stats.successfulExecutions).toBe(1);
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================

  describe('Edge cases', () => {
    it('should handle opportunity with empty buyChain string', async () => {
      const opp = createMockOpportunity({ buyChain: '' });
      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0)
        .mockReturnValue(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp);

      pipeline.processQueueItems();
      await flushMultiple();

      // Empty string is falsy, so should trigger the missing buyChain path
      expect(deps.publishExecutionResult).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Missing required buyChain field',
        }),
        opp
      );
      expect(deps.strategyFactory.execute).not.toHaveBeenCalled();
    });

    it('should process multiple opportunities in one processQueueItems call', async () => {
      const opp1 = createMockOpportunity({ id: 'opp-1' });
      const opp2 = createMockOpportunity({ id: 'opp-2' });

      deps.queueService.size
        .mockReturnValueOnce(2)   // first iteration
        .mockReturnValueOnce(1)   // second iteration (one dequeued)
        .mockReturnValueOnce(0)   // third iteration exits
        .mockReturnValue(0);      // .finally() checks
      deps.queueService.dequeue
        .mockReturnValueOnce(opp1)
        .mockReturnValueOnce(opp2);

      pipeline.processQueueItems();
      await flushMultiple(5);

      expect(deps.queueService.dequeue).toHaveBeenCalledTimes(2);
      expect(deps.strategyFactory.execute).toHaveBeenCalledTimes(2);
    });

    it('should log execution latency via perfLogger', async () => {
      const opp = createMockOpportunity();
      deps.strategyFactory.execute.mockResolvedValue({
        success: true,
        actualProfit: 50,
        gasCost: 5,
      });

      deps.queueService.size
        .mockReturnValueOnce(1)
        .mockReturnValueOnce(0)
        .mockReturnValue(0);
      deps.queueService.dequeue.mockReturnValueOnce(opp);

      pipeline.processQueueItems();
      await flushMultiple();

      expect(deps.perfLogger.logEventLatency).toHaveBeenCalledWith(
        'opportunity_execution',
        expect.any(Number),
        expect.objectContaining({ success: true, profit: 50 })
      );
    });
  });
});
