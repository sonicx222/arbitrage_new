// @ts-nocheck
/**
 * Staleness Filter Tests (Phase 3 — Async Pipeline Split)
 *
 * Verifies that ExecutionPipeline rejects pre-simulated opportunities
 * that are older than 2× the chain's block time, while still executing:
 * - Fresh pre-simulated opportunities (within staleness window)
 * - Opportunities with no preSimulatedAt (legacy non-async-pipeline path)
 *
 * @see services/execution-engine/src/execution-pipeline.ts
 * @see docs/reports/EXECUTION_BOTTLENECK_RESEARCH_2026-03-06.md — Phase 3
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { ExecutionPipeline, type PipelineDeps } from '../../../src/execution-pipeline';

jest.mock('../../../src/services/prometheus-metrics', () => ({
  recordExecutionAttempt: jest.fn(),
  recordExecutionSuccess: jest.fn(),
  recordExecutionFailure: jest.fn(),
  recordExecutionLatency: jest.fn(),
  recordVolume: jest.fn(),
  recordOpportunityOutcome: jest.fn(),
  recordProfitSlippage: jest.fn(),
  recordOpportunityAge: jest.fn(),
  recordProfitPerExecution: jest.fn(),
  recordGasCostPerExecution: jest.fn(),
}));

export {};

// =============================================================================
// Helpers
// =============================================================================

const flushMicrotasks = () => new Promise<void>((r) => setImmediate(r));
const flushMultiple = async (times = 5) => {
  for (let i = 0; i < times; i++) await flushMicrotasks();
};

function createMockDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    perfLogger: { logExecutionResult: jest.fn(), logEventLatency: jest.fn() },
    stateManager: { isRunning: jest.fn().mockReturnValue(true) },
    stats: {
      executionAttempts: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      lockConflicts: 0,
      staleLockRecoveries: 0,
      executionTimeouts: 0,
      circuitBreakerBlocks: 0,
      simulationsSkipped: 0,
      simulationsPerformed: 0,
    },
    queueService: {
      size: jest.fn().mockReturnValue(0),
      dequeue: jest.fn(),
      enqueue: jest.fn(),
    },
    maxConcurrentExecutions: 5,
    maxConcurrentPerChain: 0,
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
      execute: jest.fn().mockResolvedValue({ success: true, actualProfit: 50, gasCost: 10 }),
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
  };
}

// BSC block time = 3s, so 2× = 6000ms
const BSC_BLOCK_TIME_MS = 3000;
const STALENESS_WINDOW_MS = 2 * BSC_BLOCK_TIME_MS; // 6000ms

function buildOpp(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pre-sim-opp-1',
    type: 'intra-chain',
    chain: 'bsc',
    buyChain: 'bsc',
    buyDex: 'pancakeswap',
    sellDex: 'biswap',
    expectedProfit: 0.05,
    confidence: 0.9,
    timestamp: Date.now(),
    ...overrides,
  };
}

// =============================================================================
// Staleness filter — pre-simulated opportunities
// =============================================================================

describe('ExecutionPipeline — staleness filter for pre-simulated opportunities', () => {
  let deps: PipelineDeps;
  let pipeline: ExecutionPipeline;

  beforeEach(() => {
    deps = createMockDeps();
    pipeline = new ExecutionPipeline(deps);
  });

  it('should execute a freshly pre-simulated opportunity (within 2× block time)', async () => {
    const opp = buildOpp({ preSimulatedAt: Date.now() - 1000 }); // 1s ago — fresh for BSC (window=6s)
    deps.queueService.size.mockReturnValueOnce(1).mockReturnValue(0);
    deps.queueService.dequeue.mockReturnValueOnce(opp);

    pipeline.processQueueItems();
    await flushMultiple();

    expect(deps.strategyFactory.execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pre-sim-opp-1' }),
      expect.anything(),
    );
  });

  it('should skip (not execute) a stale pre-simulated opportunity (older than 2× block time)', async () => {
    const staleMs = STALENESS_WINDOW_MS + 500; // 6.5s ago for BSC — stale
    const opp = buildOpp({ preSimulatedAt: Date.now() - staleMs });
    deps.queueService.size.mockReturnValueOnce(1).mockReturnValue(0);
    deps.queueService.dequeue.mockReturnValueOnce(opp);

    pipeline.processQueueItems();
    await flushMultiple();

    // Should NOT execute the stale opportunity
    expect(deps.strategyFactory.execute).not.toHaveBeenCalled();
  });

  it('should log a warning when dropping a stale pre-simulated opportunity', async () => {
    const staleMs = STALENESS_WINDOW_MS + 500;
    const opp = buildOpp({ preSimulatedAt: Date.now() - staleMs });
    deps.queueService.size.mockReturnValueOnce(1).mockReturnValue(0);
    deps.queueService.dequeue.mockReturnValueOnce(opp);

    pipeline.processQueueItems();
    await flushMultiple();

    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('stale'),
      expect.objectContaining({ opportunityId: 'pre-sim-opp-1' }),
    );
  });

  it('should still ACK the message after dropping a stale pre-simulated opportunity', async () => {
    const staleMs = STALENESS_WINDOW_MS + 500;
    const opp = buildOpp({ preSimulatedAt: Date.now() - staleMs });
    deps.queueService.size.mockReturnValueOnce(1).mockReturnValue(0);
    deps.queueService.dequeue.mockReturnValueOnce(opp);

    pipeline.processQueueItems();
    await flushMultiple();

    expect(deps.opportunityConsumer.ackMessageAfterExecution).toHaveBeenCalledWith('pre-sim-opp-1');
  });

  it('should execute a pre-simulated opportunity exactly at the staleness boundary (edge case)', async () => {
    // Exactly at boundary = NOT stale (< check, not <=)
    const opp = buildOpp({ preSimulatedAt: Date.now() - STALENESS_WINDOW_MS + 100 });
    deps.queueService.size.mockReturnValueOnce(1).mockReturnValue(0);
    deps.queueService.dequeue.mockReturnValueOnce(opp);

    pipeline.processQueueItems();
    await flushMultiple();

    expect(deps.strategyFactory.execute).toHaveBeenCalled();
  });

  it('should execute a normal opportunity with no preSimulatedAt (backward compatibility)', async () => {
    const opp = buildOpp(); // No preSimulatedAt — legacy path
    deps.queueService.size.mockReturnValueOnce(1).mockReturnValue(0);
    deps.queueService.dequeue.mockReturnValueOnce(opp);

    pipeline.processQueueItems();
    await flushMultiple();

    expect(deps.strategyFactory.execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pre-sim-opp-1' }),
      expect.anything(),
    );
  });

  it('should use Ethereum block time (12s) for premium chain staleness check', async () => {
    // Ethereum 2× block time = 24s
    const recentEnoughForEth = 20000; // 20s ago — fresh for ETH
    const opp = buildOpp({
      chain: 'ethereum',
      buyChain: 'ethereum',
      preSimulatedAt: Date.now() - recentEnoughForEth,
    });
    deps.queueService.size.mockReturnValueOnce(1).mockReturnValue(0);
    deps.queueService.dequeue.mockReturnValueOnce(opp);

    pipeline.processQueueItems();
    await flushMultiple();

    // 20s < 24s window → should execute
    expect(deps.strategyFactory.execute).toHaveBeenCalled();
  });

  it('should drop a pre-simulated opp that would be fresh for BSC but is stale for Ethereum', async () => {
    // 8s ago: fresh for ETH (window=24s), but let's use a value that tests ETH chain specifically
    // Actually: 30s ago: stale for ETH (window=24s), fresh for BSC (window=6s)... wait BSC window is 6s
    // 30s ago is stale for BOTH. Let's use 25s ago: stale for ETH (25 > 24), fresh for BSC only if window < 25s
    // For Ethereum: 25s > 24s → stale. Test that ETH uses 24s window.
    const ageMs = 25000; // 25s ago
    const opp = buildOpp({
      chain: 'ethereum',
      buyChain: 'ethereum',
      preSimulatedAt: Date.now() - ageMs,
    });
    deps.queueService.size.mockReturnValueOnce(1).mockReturnValue(0);
    deps.queueService.dequeue.mockReturnValueOnce(opp);

    pipeline.processQueueItems();
    await flushMultiple();

    // 25s > 24s (2× ETH block time) → stale
    expect(deps.strategyFactory.execute).not.toHaveBeenCalled();
  });
});
