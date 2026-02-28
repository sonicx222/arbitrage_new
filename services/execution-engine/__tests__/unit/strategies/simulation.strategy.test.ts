/**
 * Simulation Strategy Tests
 *
 * Tests for the SimulationStrategy which is used for:
 * - Local development and testing
 * - Integration testing with full pipeline
 * - Performance testing and benchmarking
 * - Demo/presentation purposes
 *
 * ## Fix 8.1: Added tests for:
 * - Fix 1.1: Context validation logging
 * - Fix 4.3: Stats tracking (simulationsSkipped, successfulExecutions, failedExecutions)
 */

import { SimulationStrategy } from '../../../src/strategies/simulation.strategy';
import type { StrategyContext, Logger, ResolvedSimulationConfig } from '../../../src/types';
import { ExecutionErrorCode } from '../../../src/types';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import {
  createMockStrategyLogger,
  createMockStrategyOpportunity,
} from '@arbitrage/test-utils';

// =============================================================================
// Mock Implementations (shared factories with local aliases)
// =============================================================================

const createMockLogger = createMockStrategyLogger;
const createMockOpportunity = createMockStrategyOpportunity;

const createMockContext = (): StrategyContext => ({
  providers: new Map(),
  wallets: new Map(),
  providerHealth: new Map(),
  gasBaselines: new Map(),
  stats: {
    opportunitiesReceived: 0,
    executionAttempts: 0,
    opportunitiesRejected: 0,
    successfulExecutions: 0,
    failedExecutions: 0,
    lockConflicts: 0,
    staleLockRecoveries: 0,
    executionTimeouts: 0,
    queueRejects: 0,
    validationErrors: 0,
    providerHealthCheckFailures: 0,
    providerReconnections: 0,
    simulationsPerformed: 0,
    simulationsSkipped: 0,
    simulationPredictedReverts: 0,
    simulationProfitabilityRejections: 0,
    simulationErrors: 0,
    circuitBreakerTrips: 0,
    circuitBreakerBlocks: 0,
    // Fix 8.2: Add missing risk management stats
    riskEVRejections: 0,
    riskPositionSizeRejections: 0,
    riskDrawdownBlocks: 0,
    riskCautionCount: 0,
    riskHaltCount: 0,
  },
  stateManager: {
    isRunning: jest.fn().mockReturnValue(true),
  } as any, // Partial mock - only isRunning is used in simulation strategy
  logger: createMockLogger(),
  perfLogger: {
    logOperation: jest.fn(),
    logMetric: jest.fn(),
    start: jest.fn(),
    end: jest.fn(),
  } as any, // Partial mock
  simulationService: undefined,
  nonceManager: undefined as any,
  mevProviderFactory: undefined as any,
  bridgeRouterFactory: undefined as any,
});

const createDefaultConfig = (
  overrides: Partial<ResolvedSimulationConfig> = {}
): ResolvedSimulationConfig => ({
  enabled: true,
  successRate: 0.9,
  executionLatencyMs: 10, // Low latency for tests
  gasUsed: 200000,
  gasCostMultiplier: 0.1,
  profitVariance: 0.2,
  logSimulatedExecutions: false,
  ...overrides,
});

// =============================================================================
// Tests
// =============================================================================

describe('SimulationStrategy', () => {
  let logger: Logger;
  let ctx: StrategyContext;
  let originalMathRandom: () => number;

  beforeEach(() => {
    logger = createMockLogger();
    ctx = createMockContext();
    originalMathRandom = Math.random;
    jest.useFakeTimers();
  });

  afterEach(() => {
    Math.random = originalMathRandom;
    jest.useRealTimers();
  });

  describe('constructor', () => {
    it('should initialize with provided config', () => {
      const config = createDefaultConfig();
      const strategy = new SimulationStrategy(logger, config);
      expect(strategy).toBeInstanceOf(SimulationStrategy);
    });
  });

  describe('execute', () => {
    describe('successful execution', () => {
      it('should return success result when random < successRate', async () => {
        // Mock Math.random to return 0.5 for all calls (success with 0.9 successRate)
        // Order: latency variance, successRate check, profit variance, then 32 calls for tx hash
        Math.random = jest.fn().mockReturnValue(0.5);

        const config = createDefaultConfig({ successRate: 0.9 });
        const strategy = new SimulationStrategy(logger, config);
        const opportunity = createMockOpportunity();

        // Execute and advance timers
        const executePromise = strategy.execute(opportunity, ctx);
        jest.advanceTimersByTime(100);
        const result = await executePromise;

        expect(result.success).toBe(true);
        expect(result.opportunityId).toBe(opportunity.id);
        expect(result.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
        expect(typeof result.actualProfit).toBe('number');
        expect(result.gasUsed).toBe(config.gasUsed);
        expect(result.gasCost).toBe(opportunity.expectedProfit! * config.gasCostMultiplier);
        expect(result.error).toBeUndefined();
        expect(result.chain).toBe(opportunity.buyChain);
        expect(result.dex).toBe(opportunity.buyDex);
      });

      it('should apply profit variance correctly', async () => {
        // Looking at the code: variance multiplier = 1 + (Math.random() * 2 - 1) * variance
        // With random = 1.0, multiplier = 1 + (1.0 * 2 - 1) * 0.2 = 1 + 0.2 = 1.2
        let callCount = 0;
        Math.random = jest.fn(() => {
          callCount++;
          // First call: latency variance (0.5 = neutral)
          // Second call: success check (0.5 = success with 1.0 rate)
          // Third call: profit variance (1.0 = max)
          // Rest: tx hash generation (0.5 = 0x80808080...)
          if (callCount === 3) return 1.0; // profit variance
          return 0.5;
        });

        const config = createDefaultConfig({
          successRate: 1.0,
          profitVariance: 0.2,
          gasCostMultiplier: 0,
        });
        const strategy = new SimulationStrategy(logger, config);
        const opportunity = createMockOpportunity({ expectedProfit: 100 });

        const executePromise = strategy.execute(opportunity, ctx);
        jest.advanceTimersByTime(100);
        const result = await executePromise;

        // With variance = 0.2 and random = 1.0, profitMultiplier = 1 + (1.0 * 2 - 1) * 0.2 = 1.2
        // Expected profit = 100 * 1.2 = 120
        expect(result.actualProfit).toBeCloseTo(120, 1);
      });
    });

    describe('failed execution', () => {
      it('should return failure result when random >= successRate', async () => {
        // Looking at the code order:
        // 1. simulateLatency calls Math.random for variance
        // 2. successRate check: Math.random() < successRate
        // So we need latency first (any value), then 0.95 for the success check
        let callCount = 0;
        Math.random = jest.fn(() => {
          callCount++;
          // First call: latency variance
          if (callCount === 1) return 0.5;
          // Second call: success check - return 0.95 to fail (>= 0.9)
          return 0.95;
        });

        const config = createDefaultConfig({ successRate: 0.9 });
        const strategy = new SimulationStrategy(logger, config);
        const opportunity = createMockOpportunity();

        const executePromise = strategy.execute(opportunity, ctx);
        jest.advanceTimersByTime(100);
        const result = await executePromise;

        expect(result.success).toBe(false);
        expect(result.opportunityId).toBe(opportunity.id);
        expect(result.transactionHash).toBeUndefined();
        expect(result.actualProfit).toBeUndefined();
        expect(result.gasUsed).toBeUndefined();
        expect(result.gasCost).toBeUndefined();
        expect(result.error).toBe('Simulated execution failure (random)');
        expect(result.chain).toBe(opportunity.buyChain);
        expect(result.dex).toBe(opportunity.buyDex);
      });

      it('should always fail when successRate is 0', async () => {
        Math.random = jest.fn()
          .mockReturnValueOnce(0) // Even 0 should fail with 0% success rate
          .mockReturnValueOnce(0.5);

        const config = createDefaultConfig({ successRate: 0 });
        const strategy = new SimulationStrategy(logger, config);
        const opportunity = createMockOpportunity();

        const executePromise = strategy.execute(opportunity, ctx);
        jest.advanceTimersByTime(100);
        const result = await executePromise;

        expect(result.success).toBe(false);
      });

      // Fix 8.2: Test for successRate = 1 (always succeed)
      it('should always succeed when successRate is 1', async () => {
        Math.random = jest.fn()
          .mockReturnValueOnce(0.99999) // Even near 1 should succeed with 100% success rate
          .mockReturnValueOnce(0.5);

        const config = createDefaultConfig({ successRate: 1 });
        const strategy = new SimulationStrategy(logger, config);
        const opportunity = createMockOpportunity();

        const executePromise = strategy.execute(opportunity, ctx);
        jest.advanceTimersByTime(100);
        const result = await executePromise;

        expect(result.success).toBe(true);
        expect(result.error).toBeUndefined();
      });

      // Fix 8.2: Test for extremely large profitVariance
      it('should handle extremely large profitVariance', async () => {
        Math.random = jest.fn()
          .mockReturnValueOnce(0.5) // success check
          .mockReturnValueOnce(0.99); // variance should produce large value

        const config = createDefaultConfig({
          successRate: 1,
          profitVariance: 100, // 10000% variance
        });
        const strategy = new SimulationStrategy(logger, config);
        const opportunity = createMockOpportunity({ expectedProfit: 100 });

        const executePromise = strategy.execute(opportunity, ctx);
        jest.advanceTimersByTime(100);
        const result = await executePromise;

        expect(result.success).toBe(true);
        // With 100x variance and 0.99 random, profit could be very high
        // The formula is: expectedProfit * (1 + (random * 2 - 1) * variance)
        // = 100 * (1 + (0.99 * 2 - 1) * 100) = 100 * (1 + 0.98 * 100) = 9900
        expect(typeof result.actualProfit).toBe('number');
      });

      // Fix 8.2: Test for zero profitVariance handling
      it('should handle zero profitVariance (exact expected profit)', async () => {
        // Mock Math.random: first for latency variance, then successRate, then profitVariance
        Math.random = jest.fn()
          .mockReturnValueOnce(0.5) // latency variance
          .mockReturnValueOnce(0.5) // success check (0.5 < 1.0 = success)
          .mockReturnValueOnce(0.123) // profit variance (ignored when profitVariance=0)
          .mockReturnValue(0.5); // for tx hash generation

        const config = createDefaultConfig({
          successRate: 1,
          profitVariance: 0, // No variance
        });
        const strategy = new SimulationStrategy(logger, config);
        const opportunity = createMockOpportunity({ expectedProfit: 50 });

        const executePromise = strategy.execute(opportunity, ctx);
        jest.advanceTimersByTime(100);
        const result = await executePromise;

        expect(result.success).toBe(true);
        // With 0 variance, actual profit = expected - gas cost
        // Gas cost = expectedProfit * gasCostMultiplier = 50 * 0.1 = 5
        // Actual profit = 50 - 5 = 45
        expect(result.actualProfit).toBeCloseTo(45, 1);
      });
    });

    describe('default values', () => {
      it('should use default chain when buyChain is not specified', async () => {
        Math.random = jest.fn().mockReturnValue(0.5);

        const config = createDefaultConfig();
        const strategy = new SimulationStrategy(logger, config);
        const opportunity = createMockOpportunity({ buyChain: undefined });

        const executePromise = strategy.execute(opportunity, ctx);
        jest.advanceTimersByTime(100);
        const result = await executePromise;

        expect(result.chain).toBe('ethereum');
      });

      it('should use default dex when buyDex is not specified', async () => {
        Math.random = jest.fn().mockReturnValue(0.5);

        const config = createDefaultConfig();
        const strategy = new SimulationStrategy(logger, config);
        const opportunity = createMockOpportunity({ buyDex: undefined });

        const executePromise = strategy.execute(opportunity, ctx);
        jest.advanceTimersByTime(100);
        const result = await executePromise;

        expect(result.dex).toBe('unknown');
      });

      it('should handle zero expectedProfit', async () => {
        Math.random = jest.fn().mockReturnValue(0.5);

        const config = createDefaultConfig();
        const strategy = new SimulationStrategy(logger, config);
        const opportunity = createMockOpportunity({ expectedProfit: 0 });

        const executePromise = strategy.execute(opportunity, ctx);
        jest.advanceTimersByTime(100);
        const result = await executePromise;

        expect(result.success).toBe(true);
        expect(result.gasCost).toBe(0);
        expect(result.actualProfit).toBe(0);
      });
    });

    describe('logging', () => {
      it('should log execution when logSimulatedExecutions is true', async () => {
        Math.random = jest.fn().mockReturnValue(0.5);

        const config = createDefaultConfig({ logSimulatedExecutions: true });
        const strategy = new SimulationStrategy(logger, config);
        const opportunity = createMockOpportunity();

        const executePromise = strategy.execute(opportunity, ctx);
        jest.advanceTimersByTime(100);
        await executePromise;

        // Finding 6.2 Fix: Removed emoji from log message
        expect(logger.info).toHaveBeenCalledWith(
          'SIMULATED execution completed',
          expect.objectContaining({
            opportunityId: opportunity.id,
            success: true,
          })
        );
      });

      it('should not log execution when logSimulatedExecutions is false', async () => {
        Math.random = jest.fn().mockReturnValue(0.5);

        const config = createDefaultConfig({ logSimulatedExecutions: false });
        const strategy = new SimulationStrategy(logger, config);
        const opportunity = createMockOpportunity();

        const executePromise = strategy.execute(opportunity, ctx);
        jest.advanceTimersByTime(100);
        await executePromise;

        expect(logger.info).not.toHaveBeenCalledWith(
          '📊 SIMULATED execution completed',
          expect.anything()
        );
      });
    });

    describe('latency simulation', () => {
      it('should respect executionLatencyMs config', async () => {
        // Mock random to return 0.5 (no variance in latency)
        Math.random = jest.fn().mockReturnValue(0.5);

        const config = createDefaultConfig({ executionLatencyMs: 500 });
        const strategy = new SimulationStrategy(logger, config);
        const opportunity = createMockOpportunity();

        let resolved = false;
        const executePromise = strategy.execute(opportunity, ctx).then((r) => {
          resolved = true;
          return r;
        });

        // Should not resolve immediately
        jest.advanceTimersByTime(100);
        expect(resolved).toBe(false);

        // Should resolve after latency period
        jest.advanceTimersByTime(500);
        await executePromise;
        expect(resolved).toBe(true);
      });
    });

    describe('transaction hash generation', () => {
      it('should generate valid 32-byte hex transaction hash', async () => {
        Math.random = jest.fn().mockReturnValue(0.5);

        const config = createDefaultConfig({ successRate: 1.0 });
        const strategy = new SimulationStrategy(logger, config);
        const opportunity = createMockOpportunity();

        const executePromise = strategy.execute(opportunity, ctx);
        jest.advanceTimersByTime(100);
        const result = await executePromise;

        expect(result.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
      });

      it('should generate unique transaction hashes', async () => {
        // Use real Math.random for uniqueness test
        Math.random = originalMathRandom;
        jest.useRealTimers();

        const config = createDefaultConfig({
          successRate: 1.0,
          executionLatencyMs: 1
        });
        const strategy = new SimulationStrategy(logger, config);

        const hashes = new Set<string>();
        for (let i = 0; i < 10; i++) {
          const opportunity = createMockOpportunity({ id: `test-${i}` });
          const result = await strategy.execute(opportunity, ctx);
          if (result.transactionHash) {
            hashes.add(result.transactionHash);
          }
        }

        // All 10 should be unique
        expect(hashes.size).toBe(10);
      });
    });
  });

  describe('gas calculations', () => {
    it('should calculate gas cost as expectedProfit * gasCostMultiplier', async () => {
      Math.random = jest.fn().mockReturnValue(0.5);

      const config = createDefaultConfig({
        successRate: 1.0,
        gasCostMultiplier: 0.15,
      });
      const strategy = new SimulationStrategy(logger, config);
      const opportunity = createMockOpportunity({ expectedProfit: 200 });

      const executePromise = strategy.execute(opportunity, ctx);
      jest.advanceTimersByTime(100);
      const result = await executePromise;

      expect(result.gasCost).toBe(30); // 200 * 0.15 = 30
    });

    it('should return configured gasUsed value', async () => {
      Math.random = jest.fn().mockReturnValue(0.5);

      const config = createDefaultConfig({
        successRate: 1.0,
        gasUsed: 500000,
      });
      const strategy = new SimulationStrategy(logger, config);
      const opportunity = createMockOpportunity();

      const executePromise = strategy.execute(opportunity, ctx);
      jest.advanceTimersByTime(100);
      const result = await executePromise;

      expect(result.gasUsed).toBe(500000);
    });
  });

  // ===========================================================================
  // Fix 1.1: Context Validation Logging Tests
  // ===========================================================================

  describe('context validation (Fix 1.1)', () => {
    it('should log debug when wallet is missing for chain', async () => {
      Math.random = jest.fn().mockReturnValue(0.5);

      const config = createDefaultConfig();
      const strategy = new SimulationStrategy(logger, config);
      // Use a chain that doesn't exist in the default context
      const opportunity = createMockOpportunity({ buyChain: 'polygon' });

      const executePromise = strategy.execute(opportunity, ctx);
      jest.advanceTimersByTime(100);
      await executePromise;

      expect(logger.debug).toHaveBeenCalledWith(
        'SimulationStrategy: No wallet for chain (expected in simulation mode)',
        expect.objectContaining({
          chain: 'polygon',
          opportunityId: opportunity.id,
        })
      );
    });

    it('should log debug when provider is missing for chain', async () => {
      Math.random = jest.fn().mockReturnValue(0.5);

      const config = createDefaultConfig();
      const strategy = new SimulationStrategy(logger, config);
      // Use a chain that doesn't exist in the default context
      const opportunity = createMockOpportunity({ buyChain: 'bsc' });

      const executePromise = strategy.execute(opportunity, ctx);
      jest.advanceTimersByTime(100);
      await executePromise;

      expect(logger.debug).toHaveBeenCalledWith(
        'SimulationStrategy: No provider for chain (expected in simulation mode)',
        expect.objectContaining({
          chain: 'bsc',
          opportunityId: opportunity.id,
        })
      );
    });

    it('should return error for opportunity without id', async () => {
      const config = createDefaultConfig();
      const strategy = new SimulationStrategy(logger, config);
      const opportunity = createMockOpportunity({ id: '' });

      // Note: No timer advancement needed for validation failure (returns immediately)
      const result = await strategy.execute(opportunity, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toBe(ExecutionErrorCode.INVALID_OPPORTUNITY);
    });
  });

  // ===========================================================================
  // Fix 4.3: Stats Tracking Tests
  // ===========================================================================

  describe('stats tracking (Fix 4.3)', () => {
    it('should increment simulationsSkipped counter', async () => {
      Math.random = jest.fn().mockReturnValue(0.5);

      const config = createDefaultConfig();
      const strategy = new SimulationStrategy(logger, config);
      const opportunity = createMockOpportunity();
      const initialSkipped = ctx.stats.simulationsSkipped;

      const executePromise = strategy.execute(opportunity, ctx);
      jest.advanceTimersByTime(100);
      await executePromise;

      expect(ctx.stats.simulationsSkipped).toBe(initialSkipped + 1);
    });

    it('should increment successfulExecutions on success', async () => {
      // Mock to always succeed
      Math.random = jest.fn().mockReturnValue(0.5);

      const config = createDefaultConfig({ successRate: 1.0 });
      const strategy = new SimulationStrategy(logger, config);
      const opportunity = createMockOpportunity();
      const initialSuccessful = ctx.stats.successfulExecutions;

      const executePromise = strategy.execute(opportunity, ctx);
      jest.advanceTimersByTime(100);
      await executePromise;

      expect(ctx.stats.successfulExecutions).toBe(initialSuccessful + 1);
    });

    it('should increment failedExecutions on failure', async () => {
      // Mock to always fail
      let callCount = 0;
      Math.random = jest.fn(() => {
        callCount++;
        if (callCount === 1) return 0.5; // latency
        return 0.95; // fail with successRate 0.9
      });

      const config = createDefaultConfig({ successRate: 0.9 });
      const strategy = new SimulationStrategy(logger, config);
      const opportunity = createMockOpportunity();
      const initialFailed = ctx.stats.failedExecutions;

      const executePromise = strategy.execute(opportunity, ctx);
      jest.advanceTimersByTime(100);
      await executePromise;

      expect(ctx.stats.failedExecutions).toBe(initialFailed + 1);
    });

    it('should track stats across multiple executions', async () => {
      Math.random = jest.fn().mockReturnValue(0.5);

      const config = createDefaultConfig({ successRate: 1.0 });
      const strategy = new SimulationStrategy(logger, config);

      // Execute 3 times
      for (let i = 0; i < 3; i++) {
        const opportunity = createMockOpportunity({ id: `opp-${i}` });
        const executePromise = strategy.execute(opportunity, ctx);
        jest.advanceTimersByTime(100);
        await executePromise;
      }

      expect(ctx.stats.simulationsSkipped).toBe(3);
      expect(ctx.stats.successfulExecutions).toBe(3);
    });
  });
});
