// @ts-nocheck
/**
 * Phase 3 Business Intelligence Metrics Tests
 *
 * Verifies that the execution pipeline correctly records Phase 3 metrics:
 * - A3: Profit slippage (expected vs actual profit)
 * - A4: Opportunity age at execution
 * - F4: Profit per execution histogram
 * - F5: Gas cost per execution histogram
 *
 * Tests exercise the ExecutionPipeline with mocked prometheus-metrics to verify
 * the recording calls happen with the correct values and at the correct times.
 *
 * @see execution-pipeline.ts
 * @see services/prometheus-metrics.ts
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { ExecutionPipeline, type PipelineDeps } from '../../src/execution-pipeline';

// Mock all prometheus metric functions
jest.mock('../../src/services/prometheus-metrics', () => ({
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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const promMetrics = require('../../src/services/prometheus-metrics') as {
  recordProfitSlippage: jest.Mock;
  recordOpportunityAge: jest.Mock;
  recordProfitPerExecution: jest.Mock;
  recordGasCostPerExecution: jest.Mock;
};

export {};

// =============================================================================
// Helpers
// =============================================================================

const flushMicrotasks = () => new Promise<void>((r) => setImmediate(r));
const flushMultiple = async (times = 3) => {
  for (let i = 0; i < times; i++) {
    await flushMicrotasks();
  }
};

const createMockOpportunity = (overrides = {}) => ({
  id: 'opp-1',
  type: 'intra-chain',
  buyChain: 'bsc',
  buyDex: 'pancakeswap_v3',
  sellDex: 'biswap',
  expectedProfit: 0.05, // $0.05 USD expected
  path: ['WETH', 'USDC'],
  pipelineTimestamps: {
    detectedAt: Date.now() - 200, // detected 200ms ago
  },
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
    execute: jest.fn().mockResolvedValue({
      success: true,
      // H-001 FIX: actualProfit is in human-readable USD units (not wei).
      // Strategies return USD via calculateActualProfit().
      actualProfit: 0.05, // $0.05 USD
      gasCost: 0.0025, // $0.0025 USD
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

/** Run a single opportunity through the pipeline and wait for completion. */
async function executeSingleOpportunity(
  pipeline: ExecutionPipeline,
  deps: PipelineDeps,
  opportunity: ReturnType<typeof createMockOpportunity>
): Promise<void> {
  deps.queueService.size
    .mockReturnValueOnce(1)
    .mockReturnValueOnce(0)
    .mockReturnValue(0);
  deps.queueService.dequeue.mockReturnValueOnce(opportunity);

  pipeline.processQueueItems();
  await flushMultiple();
}

// =============================================================================
// Tests
// =============================================================================

describe('Phase 3 Business Intelligence Metrics', () => {
  let deps: PipelineDeps;
  let pipeline: ExecutionPipeline;

  beforeEach(() => {
    deps = createMockDeps();
    pipeline = new ExecutionPipeline(deps);
    promMetrics.recordProfitSlippage.mockClear();
    promMetrics.recordOpportunityAge.mockClear();
    promMetrics.recordProfitPerExecution.mockClear();
    promMetrics.recordGasCostPerExecution.mockClear();
  });

  // ===========================================================================
  // A4: Opportunity age at execution
  // ===========================================================================

  describe('A4: Opportunity age at execution', () => {
    it('should record opportunity age when detectedAt is present', async () => {
      const now = Date.now();
      const opp = createMockOpportunity({
        pipelineTimestamps: { detectedAt: now - 150 },
      });

      await executeSingleOpportunity(pipeline, deps, opp);

      expect(promMetrics.recordOpportunityAge).toHaveBeenCalledTimes(1);
      const [chain, ageMs] = promMetrics.recordOpportunityAge.mock.calls[0];
      expect(chain).toBe('bsc');
      expect(ageMs).toBeGreaterThanOrEqual(150);
      expect(ageMs).toBeLessThan(5000); // Sanity check
    });

    it('should not record opportunity age when detectedAt is missing', async () => {
      const opp = createMockOpportunity({
        pipelineTimestamps: {},
      });

      await executeSingleOpportunity(pipeline, deps, opp);

      expect(promMetrics.recordOpportunityAge).not.toHaveBeenCalled();
    });

    it('should not record opportunity age when pipelineTimestamps is missing', async () => {
      const opp = createMockOpportunity({
        pipelineTimestamps: undefined,
      });

      await executeSingleOpportunity(pipeline, deps, opp);

      expect(promMetrics.recordOpportunityAge).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // A3: Profit slippage
  // ===========================================================================

  describe('A3: Profit slippage (expected vs actual)', () => {
    it('should record profit slippage on successful execution with both values', async () => {
      const opp = createMockOpportunity({
        expectedProfit: 0.05, // $0.05 USD expected
      });

      // H-001 FIX: actualProfit is in human-readable USD (not wei)
      deps.strategyFactory.execute.mockResolvedValue({
        success: true,
        actualProfit: 0.05, // $0.05 USD
        gasCost: 0.0025,
      });

      await executeSingleOpportunity(pipeline, deps, opp);

      expect(promMetrics.recordProfitSlippage).toHaveBeenCalledTimes(1);
      const [chain, strategy, slippagePct] = promMetrics.recordProfitSlippage.mock.calls[0];
      expect(chain).toBe('bsc');
      expect(strategy).toBe('intra-chain');
      // (0.05 - 0.05) / |0.05| * 100 = 0%
      expect(slippagePct).toBeCloseTo(0, 1);
    });

    it('should record positive slippage when expected > actual (overestimate)', async () => {
      const opp = createMockOpportunity({
        expectedProfit: 0.10, // $0.10 USD expected
      });

      // H-001 FIX: actualProfit is in human-readable USD (not wei)
      deps.strategyFactory.execute.mockResolvedValue({
        success: true,
        actualProfit: 0.05, // $0.05 USD actual (only half)
        gasCost: 0.0025,
      });

      await executeSingleOpportunity(pipeline, deps, opp);

      expect(promMetrics.recordProfitSlippage).toHaveBeenCalledTimes(1);
      const [, , slippagePct] = promMetrics.recordProfitSlippage.mock.calls[0];
      // (0.10 - 0.05) / |0.10| * 100 = 50%
      expect(slippagePct).toBeCloseTo(50, 1);
    });

    it('should record negative slippage when actual > expected (underestimate)', async () => {
      const opp = createMockOpportunity({
        expectedProfit: 0.05, // $0.05 USD expected
      });

      // H-001 FIX: actualProfit is in human-readable USD (not wei)
      deps.strategyFactory.execute.mockResolvedValue({
        success: true,
        actualProfit: 0.10, // $0.10 USD actual (double)
        gasCost: 0.0025,
      });

      await executeSingleOpportunity(pipeline, deps, opp);

      expect(promMetrics.recordProfitSlippage).toHaveBeenCalledTimes(1);
      const [, , slippagePct] = promMetrics.recordProfitSlippage.mock.calls[0];
      // (0.05 - 0.10) / |0.05| * 100 = -100%
      expect(slippagePct).toBeCloseTo(-100, 1);
    });

    it('should not record slippage when expectedProfit is 0', async () => {
      const opp = createMockOpportunity({
        expectedProfit: 0,
      });

      await executeSingleOpportunity(pipeline, deps, opp);

      expect(promMetrics.recordProfitSlippage).not.toHaveBeenCalled();
    });

    it('should not record slippage when expectedProfit is null/undefined', async () => {
      const opp = createMockOpportunity({
        expectedProfit: undefined,
      });

      await executeSingleOpportunity(pipeline, deps, opp);

      expect(promMetrics.recordProfitSlippage).not.toHaveBeenCalled();
    });

    it('should not record slippage on failed execution', async () => {
      const opp = createMockOpportunity({ expectedProfit: 0.05 }); // $0.05 USD
      deps.strategyFactory.execute.mockResolvedValue({
        success: false,
        error: 'Reverted',
      });

      await executeSingleOpportunity(pipeline, deps, opp);

      expect(promMetrics.recordProfitSlippage).not.toHaveBeenCalled();
    });

    it('should not record slippage when actualProfit is null', async () => {
      const opp = createMockOpportunity({ expectedProfit: 0.05 }); // $0.05 USD
      deps.strategyFactory.execute.mockResolvedValue({
        success: true,
        actualProfit: undefined,
      });

      await executeSingleOpportunity(pipeline, deps, opp);

      expect(promMetrics.recordProfitSlippage).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // F4: Profit per execution
  // ===========================================================================

  describe('F4: Profit per execution histogram', () => {
    it('should record profit per execution in USD (human-readable)', async () => {
      const opp = createMockOpportunity();
      // H-001 FIX: actualProfit is in human-readable USD (not wei)
      deps.strategyFactory.execute.mockResolvedValue({
        success: true,
        actualProfit: 0.05, // $0.05 USD
        gasCost: 0.0025,
      });

      await executeSingleOpportunity(pipeline, deps, opp);

      expect(promMetrics.recordProfitPerExecution).toHaveBeenCalledTimes(1);
      const [chain, strategy, profit] = promMetrics.recordProfitPerExecution.mock.calls[0];
      expect(chain).toBe('bsc');
      expect(strategy).toBe('intra-chain');
      expect(profit).toBeCloseTo(0.05, 10);
    });

    it('should not record profit when actualProfit is null/undefined', async () => {
      const opp = createMockOpportunity();
      deps.strategyFactory.execute.mockResolvedValue({
        success: true,
        actualProfit: undefined,
      });

      await executeSingleOpportunity(pipeline, deps, opp);

      expect(promMetrics.recordProfitPerExecution).not.toHaveBeenCalled();
    });

    it('should not record profit on failed execution (no actualProfit)', async () => {
      const opp = createMockOpportunity();
      deps.strategyFactory.execute.mockResolvedValue({
        success: false,
        error: 'timeout',
      });

      await executeSingleOpportunity(pipeline, deps, opp);

      expect(promMetrics.recordProfitPerExecution).not.toHaveBeenCalled();
    });

    it('should record zero profit correctly', async () => {
      const opp = createMockOpportunity();
      deps.strategyFactory.execute.mockResolvedValue({
        success: true,
        actualProfit: 0,
        gasCost: 0.0005,
      });

      await executeSingleOpportunity(pipeline, deps, opp);

      expect(promMetrics.recordProfitPerExecution).toHaveBeenCalledTimes(1);
      const [, , profit] = promMetrics.recordProfitPerExecution.mock.calls[0];
      expect(profit).toBe(0);
    });
  });

  // ===========================================================================
  // F5: Gas cost per execution
  // ===========================================================================

  describe('F5: Gas cost per execution', () => {
    it('should record gas cost on successful execution', async () => {
      const opp = createMockOpportunity();
      // H-001 FIX: All values in human-readable units
      deps.strategyFactory.execute.mockResolvedValue({
        success: true,
        actualProfit: 0.05,
        gasCost: 0.0025, // gas cost in USD
      });

      await executeSingleOpportunity(pipeline, deps, opp);

      expect(promMetrics.recordGasCostPerExecution).toHaveBeenCalledTimes(1);
      const [chain, gasCost] = promMetrics.recordGasCostPerExecution.mock.calls[0];
      expect(chain).toBe('bsc');
      expect(gasCost).toBe(0.0025);
    });

    it('should record gas cost on failed execution', async () => {
      const opp = createMockOpportunity();
      deps.strategyFactory.execute.mockResolvedValue({
        success: false,
        error: 'Slippage exceeded',
        gasCost: 0.0015, // gas cost in USD
      });

      await executeSingleOpportunity(pipeline, deps, opp);

      expect(promMetrics.recordGasCostPerExecution).toHaveBeenCalledTimes(1);
      const [, gasCost] = promMetrics.recordGasCostPerExecution.mock.calls[0];
      expect(gasCost).toBe(0.0015);
    });

    it('should not record gas cost when gasCost is null/undefined', async () => {
      const opp = createMockOpportunity();
      deps.strategyFactory.execute.mockResolvedValue({
        success: true,
        actualProfit: 0.05,
        gasCost: undefined,
      });

      await executeSingleOpportunity(pipeline, deps, opp);

      expect(promMetrics.recordGasCostPerExecution).not.toHaveBeenCalled();
    });

    it('should not record gas cost when gasCost is NaN', async () => {
      const opp = createMockOpportunity();
      deps.strategyFactory.execute.mockResolvedValue({
        success: true,
        actualProfit: 0.05,
        gasCost: NaN,
      });

      await executeSingleOpportunity(pipeline, deps, opp);

      expect(promMetrics.recordGasCostPerExecution).not.toHaveBeenCalled();
    });

    it('should record zero gas cost correctly', async () => {
      const opp = createMockOpportunity();
      deps.strategyFactory.execute.mockResolvedValue({
        success: true,
        actualProfit: 0.05,
        gasCost: 0,
      });

      await executeSingleOpportunity(pipeline, deps, opp);

      expect(promMetrics.recordGasCostPerExecution).toHaveBeenCalledTimes(1);
      const [, gasCost] = promMetrics.recordGasCostPerExecution.mock.calls[0];
      expect(gasCost).toBe(0);
    });
  });

  // ===========================================================================
  // Exception path
  // ===========================================================================

  describe('Exception path', () => {
    it('should not record Phase 3 metrics when strategy throws', async () => {
      const opp = createMockOpportunity();
      deps.strategyFactory.execute.mockRejectedValue(new Error('Network error'));

      await executeSingleOpportunity(pipeline, deps, opp);

      // None of the Phase 3 metrics should be recorded on exception
      // (A4 age is recorded before execution, so it IS recorded)
      expect(promMetrics.recordOpportunityAge).toHaveBeenCalledTimes(1);
      // But profit/slippage/gas metrics are NOT recorded
      expect(promMetrics.recordProfitSlippage).not.toHaveBeenCalled();
      expect(promMetrics.recordProfitPerExecution).not.toHaveBeenCalled();
      expect(promMetrics.recordGasCostPerExecution).not.toHaveBeenCalled();
    });
  });
});
