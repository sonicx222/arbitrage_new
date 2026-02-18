/**
 * Performance Benchmark: Execution Engine Latency
 *
 * Measures opportunity-to-execution latency against the <50ms ADR-022 target.
 * All external I/O (Redis, blockchain) is mocked to measure ONLY internal
 * processing time: strategy selection, validation, and execution pipeline.
 *
 * Metrics measured:
 * - Strategy factory resolution latency
 * - Full executeOpportunity cycle (with mocked blockchain calls)
 * - Engine initialization overhead
 *
 * @see ADR-022: Hot-Path Performance (<50ms target)
 * @see engine.ts — ExecutionEngineService
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ExecutionEngineService, ExecutionEngineConfig } from '../../src/engine';
import {
  ExecutionStrategyFactory,
  createStrategyFactory,
} from '../../src/strategies/strategy-factory';
import {
  createMockLogger,
  createMockPerfLogger,
  createMockExecutionStateManager,
} from '@arbitrage/test-utils';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type { ExecutionStrategy, StrategyContext, ExecutionResult, Logger } from '../../src/types';

// =============================================================================
// Performance Test Configuration
// =============================================================================

const PERFORMANCE_TIMEOUT = 30000; // 30s max for all benchmarks
const LATENCY_TARGET_MS = 50; // ADR-022 hot-path target
const WARMUP_ITERATIONS = 10; // Warmup before measuring
const MEASUREMENT_ITERATIONS = 100; // Iterations for stable measurement
const P95_MULTIPLIER = 1.5; // Allow 1.5x for p95

// =============================================================================
// Mock Strategy for Benchmarking
// =============================================================================

function createMockStrategy(name: string): ExecutionStrategy {
  return {
    execute: jest.fn<(opp: ArbitrageOpportunity, ctx: StrategyContext) => Promise<ExecutionResult>>()
      .mockResolvedValue({
        opportunityId: 'test-opp',
        success: true,
        transactionHash: '0x' + '0'.repeat(64),
        actualProfit: 0.01,
        gasUsed: 21000,
      } as ExecutionResult),
  };
}

function createTestOpportunity(overrides: Partial<ArbitrageOpportunity> = {}): ArbitrageOpportunity {
  return {
    id: `perf-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: 'cross-dex',
    chain: 'ethereum',
    buyDex: 'uniswap_v3',
    sellDex: 'sushiswap',
    buyChain: 'ethereum',
    sellChain: 'ethereum',
    tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    amountIn: '1000000000000000000',
    buyPrice: 1.0,
    sellPrice: 1.01,
    expectedProfit: 0.01,
    gasEstimate: '500000',
    timestamp: Date.now(),
    confidence: 0.9,
    path: [
      '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    ],
    ...overrides,
  } as ArbitrageOpportunity;
}

// =============================================================================
// Helper: Measure latency statistics
// =============================================================================

interface LatencyStats {
  mean: number;
  median: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
}

function calculateStats(measurements: number[]): LatencyStats {
  const sorted = [...measurements].sort((a, b) => a - b);
  const len = sorted.length;

  return {
    mean: sorted.reduce((a, b) => a + b, 0) / len,
    median: sorted[Math.floor(len / 2)],
    p95: sorted[Math.floor(len * 0.95)],
    p99: sorted[Math.floor(len * 0.99)],
    min: sorted[0],
    max: sorted[len - 1],
  };
}

// =============================================================================
// Performance Tests
// =============================================================================

describe('Execution Engine Latency Performance', () => {
  describe('Strategy Factory Resolution', () => {
    let factory: ExecutionStrategyFactory;
    let mockLogger: Logger;

    beforeEach(() => {
      mockLogger = createMockLogger() as unknown as Logger;

      factory = createStrategyFactory({
        logger: mockLogger,
        isSimulationMode: true,
        isHybridMode: false,
      });

      // Register all strategies
      factory.registerSimulationStrategy(createMockStrategy('simulation'));
      factory.registerIntraChainStrategy(createMockStrategy('intra-chain'));
      factory.registerCrossChainStrategy(createMockStrategy('cross-chain'));
      factory.registerFlashLoanStrategy(createMockStrategy('flash-loan'));
    });

    it('should resolve strategy in <1ms (simulation mode)', () => {
      const opportunity = createTestOpportunity();
      const measurements: number[] = [];

      // Warmup
      for (let i = 0; i < WARMUP_ITERATIONS; i++) {
        factory.resolve(opportunity);
      }

      // Measure
      for (let i = 0; i < MEASUREMENT_ITERATIONS; i++) {
        const start = performance.now();
        factory.resolve(createTestOpportunity());
        const end = performance.now();
        measurements.push(end - start);
      }

      const stats = calculateStats(measurements);

      // Strategy resolution should be sub-millisecond
      expect(stats.median).toBeLessThan(1);
      expect(stats.p95).toBeLessThan(2);
    }, PERFORMANCE_TIMEOUT);

    it('should resolve intra-chain strategy in <1ms (non-simulation)', () => {
      // Create factory in non-simulation mode
      const nonSimFactory = createStrategyFactory({
        logger: mockLogger,
        isSimulationMode: false,
        isHybridMode: false,
      });
      nonSimFactory.registerIntraChainStrategy(createMockStrategy('intra-chain'));
      nonSimFactory.registerCrossChainStrategy(createMockStrategy('cross-chain'));
      nonSimFactory.registerFlashLoanStrategy(createMockStrategy('flash-loan'));

      const measurements: number[] = [];
      const opportunity = createTestOpportunity({ buyChain: 'ethereum', sellChain: 'ethereum' });

      // Warmup
      for (let i = 0; i < WARMUP_ITERATIONS; i++) {
        nonSimFactory.resolve(opportunity);
      }

      // Measure
      for (let i = 0; i < MEASUREMENT_ITERATIONS; i++) {
        const start = performance.now();
        nonSimFactory.resolve(createTestOpportunity({ buyChain: 'ethereum', sellChain: 'ethereum' }));
        const end = performance.now();
        measurements.push(end - start);
      }

      const stats = calculateStats(measurements);
      expect(stats.median).toBeLessThan(1);
    }, PERFORMANCE_TIMEOUT);

    it('should resolve cross-chain strategy in <1ms', () => {
      const nonSimFactory = createStrategyFactory({
        logger: mockLogger,
        isSimulationMode: false,
        isHybridMode: false,
      });
      nonSimFactory.registerIntraChainStrategy(createMockStrategy('intra-chain'));
      nonSimFactory.registerCrossChainStrategy(createMockStrategy('cross-chain'));
      nonSimFactory.registerFlashLoanStrategy(createMockStrategy('flash-loan'));

      const measurements: number[] = [];
      const opportunity = createTestOpportunity({ buyChain: 'ethereum', sellChain: 'arbitrum' });

      // Warmup
      for (let i = 0; i < WARMUP_ITERATIONS; i++) {
        nonSimFactory.resolve(opportunity);
      }

      // Measure
      for (let i = 0; i < MEASUREMENT_ITERATIONS; i++) {
        const start = performance.now();
        nonSimFactory.resolve(createTestOpportunity({ buyChain: 'ethereum', sellChain: 'arbitrum' }));
        const end = performance.now();
        measurements.push(end - start);
      }

      const stats = calculateStats(measurements);
      expect(stats.median).toBeLessThan(1);
    }, PERFORMANCE_TIMEOUT);
  });

  describe('Strategy Execution Latency (mocked I/O)', () => {
    let factory: ExecutionStrategyFactory;
    let mockContext: StrategyContext;
    let mockLogger: Logger;

    beforeEach(() => {
      mockLogger = createMockLogger() as unknown as Logger;

      factory = createStrategyFactory({
        logger: mockLogger,
        isSimulationMode: true,
        isHybridMode: false,
      });

      factory.registerSimulationStrategy(createMockStrategy('simulation'));

      mockContext = {
        logger: mockLogger,
        providers: new Map(),
        wallets: new Map(),
        providerHealth: new Map(),
        nonceManager: null,
        mevProviderFactory: null,
        bridgeRouterFactory: null,
        stateManager: createMockExecutionStateManager() as any,
        gasBaselines: new Map(),
        stats: {
          opportunitiesReceived: 0,
          executionAttempts: 0,
          successfulExecutions: 0,
          failedExecutions: 0,
          skippedOpportunities: 0,
          totalProfit: 0,
          totalGasSpent: 0,
          lockConflicts: 0,
        },
      } as unknown as StrategyContext;
    });

    it(`should complete full strategy.execute() in <${LATENCY_TARGET_MS}ms`, async () => {
      const measurements: number[] = [];

      // Warmup
      for (let i = 0; i < WARMUP_ITERATIONS; i++) {
        await factory.execute(createTestOpportunity(), mockContext);
      }

      // Measure
      for (let i = 0; i < MEASUREMENT_ITERATIONS; i++) {
        const opportunity = createTestOpportunity();
        const start = performance.now();
        await factory.execute(opportunity, mockContext);
        const end = performance.now();
        measurements.push(end - start);
      }

      const stats = calculateStats(measurements);

      // Full execute cycle with mocked I/O should be well under 50ms
      expect(stats.median).toBeLessThan(LATENCY_TARGET_MS);
      expect(stats.p95).toBeLessThan(LATENCY_TARGET_MS * P95_MULTIPLIER);
    }, PERFORMANCE_TIMEOUT);
  });

  describe('Engine Creation Overhead', () => {
    it('should create engine instance in <10ms', () => {
      const mockLog = createMockLogger();
      const mockPerf = createMockPerfLogger();
      const mockState = createMockExecutionStateManager();
      const measurements: number[] = [];

      // Warmup
      for (let i = 0; i < 5; i++) {
        new ExecutionEngineService({
          logger: mockLog,
          perfLogger: mockPerf as any,
          stateManager: mockState as any,
          simulationConfig: { enabled: true },
        });
      }

      // Measure
      for (let i = 0; i < 50; i++) {
        const start = performance.now();
        new ExecutionEngineService({
          logger: mockLog,
          perfLogger: mockPerf as any,
          stateManager: mockState as any,
          simulationConfig: { enabled: true },
        });
        const end = performance.now();
        measurements.push(end - start);
      }

      const stats = calculateStats(measurements);
      expect(stats.median).toBeLessThan(10);
    }, PERFORMANCE_TIMEOUT);
  });
});
