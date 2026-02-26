/**
 * Intra-Chain Strategy Tests
 *
 * Tests for simulation integration (Phase 1.1.2):
 * - Call simulation before transaction submission
 * - Parse simulation result for success/failure/revert reason
 * - Add configurable simulation threshold (e.g., only simulate >$50 trades)
 * - Add simulation bypass for time-critical opportunities
 */

import { ethers } from 'ethers';
import { IntraChainStrategy } from '../../../src/strategies/intra-chain.strategy';
import type { StrategyContext, ExecutionResult, Logger } from '../../../src/types';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type {
  ISimulationService,
  SimulationResult,
  SimulationRequest,
  SimulationMetrics,
  SimulationProviderHealth,
  SimulationProviderType,
} from '../../../src/services/simulation/types';
import {
  createMockStrategyLogger,
  createMockStrategyProvider,
  createMockStrategyWallet,
  createMockStrategyOpportunity,
} from '@arbitrage/test-utils';

// =============================================================================
// Mock Implementations (shared factories with local aliases)
// =============================================================================

const createMockLogger = createMockStrategyLogger;

const createMockSimulationService = (
  overrides: Partial<ISimulationService> = {}
): ISimulationService => ({
  initialize: jest.fn().mockResolvedValue(undefined),
  simulate: jest.fn().mockResolvedValue({
    success: true,
    wouldRevert: false,
    provider: 'tenderly' as SimulationProviderType,
    latencyMs: 100,
    gasUsed: BigInt(200000),
  } as SimulationResult),
  shouldSimulate: jest.fn().mockReturnValue(true),
  getSimulationTier: jest.fn().mockReturnValue('full' as const) as any,
  getAggregatedMetrics: jest.fn().mockReturnValue({
    totalSimulations: 0,
    successfulSimulations: 0,
    failedSimulations: 0,
    predictedReverts: 0,
    averageLatencyMs: 0,
    fallbackUsed: 0,
    cacheHits: 0,
    lastUpdated: Date.now(),
  } as SimulationMetrics),
  getProvidersHealth: jest.fn().mockReturnValue(new Map()),
  stop: jest.fn(),
  ...overrides,
});

const createMockOpportunity = createMockStrategyOpportunity;

const createMockProvider = createMockStrategyProvider;
const createMockWallet = createMockStrategyWallet;

const createMockContext = (
  overrides: Partial<StrategyContext> = {}
): StrategyContext => {
  const providers = new Map<string, ethers.JsonRpcProvider>();
  providers.set('ethereum', createMockProvider());

  const wallets = new Map<string, ethers.Wallet>();
  wallets.set('ethereum', createMockWallet());

  return {
    logger: createMockLogger(),
    perfLogger: { track: jest.fn(), getMetrics: jest.fn() } as any,
    providers,
    wallets,
    providerHealth: new Map(),
    nonceManager: {
      getNextNonce: jest.fn().mockResolvedValue(42),
      confirmTransaction: jest.fn(),
      failTransaction: jest.fn(),
    } as any,
    mevProviderFactory: null,
    bridgeRouterFactory: null,
    stateManager: {
      isRunning: jest.fn().mockReturnValue(true),
    } as any,
    gasBaselines: new Map(),
    stats: {
      opportunitiesReceived: 0,
      executionAttempts: 0,
      opportunitiesRejected: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      queueRejects: 0,
      lockConflicts: 0,
      executionTimeouts: 0,
      validationErrors: 0,
      providerReconnections: 0,
      providerHealthCheckFailures: 0,
      // Simulation metrics (Phase 1.1.3)
      simulationsPerformed: 0,
      simulationsSkipped: 0,
      simulationPredictedReverts: 0,
      simulationErrors: 0,
    },
    simulationService: undefined,
    ...overrides,
  } as StrategyContext;
};

// =============================================================================
// Test Suite: Simulation Integration
// =============================================================================

describe('IntraChainStrategy - Simulation Integration', () => {
  let strategy: IntraChainStrategy;
  let mockLogger: Logger;

  /**
   * Helper to mock protected methods that require external dependencies.
   * This allows unit testing the simulation integration without needing
   * real blockchain providers or DEX contracts.
   *
   * Note: IntraChainStrategy now uses prepareDexSwapTransaction (not flash loans).
   * For flash loan execution, use FlashLoanStrategy instead.
   */
  const mockStrategyMethods = (strat: IntraChainStrategy) => {
    // Mock prepareDexSwapTransaction to return a valid transaction request
    // (Fix 10.1: Updated from prepareFlashLoanTransaction to match architecture change)
    jest.spyOn(strat as any, 'prepareDexSwapTransaction').mockResolvedValue({
      to: '0x1234567890123456789012345678901234567890',
      data: '0xabcdef',
      value: 0n,
      from: '0x1234567890123456789012345678901234567890',
    });

    // Mock ensureTokenAllowance to avoid approval transactions
    jest.spyOn(strat as any, 'ensureTokenAllowance').mockResolvedValue(true);

    // Mock verifyOpportunityPrices to always pass
    jest.spyOn(strat as any, 'verifyOpportunityPrices').mockResolvedValue({
      valid: true,
      currentProfit: 100,
    });

    // Mock getOptimalGasPrice to return a reasonable value
    jest.spyOn(strat as any, 'getOptimalGasPrice').mockResolvedValue(BigInt('30000000000'));

    // Mock applyMEVProtection to return the transaction as-is with gas settings
    jest.spyOn(strat as any, 'applyMEVProtection').mockImplementation(async (tx: any) => ({
      ...tx,
      gasPrice: BigInt('30000000000'),
    }));

    // Mock calculateActualProfit
    jest.spyOn(strat as any, 'calculateActualProfit').mockResolvedValue(95);

    // Fix 3.1/8.4: Mock isProviderHealthy to avoid Promise.race timing issues in tests
    // This is needed because submitTransaction now performs provider health checks
    jest.spyOn(strat as any, 'isProviderHealthy').mockResolvedValue(true);

    // Fix 3.1/8.4: Mock refreshGasPriceForSubmission to avoid real provider calls
    jest.spyOn(strat as any, 'refreshGasPriceForSubmission').mockResolvedValue(BigInt('30000000000'));
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    strategy = new IntraChainStrategy(mockLogger);
    mockStrategyMethods(strategy);
  });

  describe('simulation tier decision', () => {
    it('should call simulation service getSimulationTier method', async () => {
      const mockSimService = createMockSimulationService();
      const ctx = createMockContext({ simulationService: mockSimService });
      const opportunity = createMockOpportunity({ expectedProfit: 100 });

      // Execute will call getSimulationTier internally
      await strategy.execute(opportunity, ctx);

      expect(mockSimService.getSimulationTier).toHaveBeenCalled();
    });

    it('should skip simulation for opportunities below threshold (tier: none)', async () => {
      const mockSimService = createMockSimulationService({
        getSimulationTier: jest.fn().mockReturnValue('none'), // Below threshold
      });
      const ctx = createMockContext({ simulationService: mockSimService });
      const opportunity = createMockOpportunity({ expectedProfit: 25 }); // $25 - below threshold

      const result = await strategy.execute(opportunity, ctx);

      // Should NOT call simulate() when tier is 'none'
      expect(mockSimService.simulate).not.toHaveBeenCalled();
      // Execution should still proceed
      expect(result.success).toBe(true);
      expect(ctx.stats.simulationsSkipped).toBe(1);
    });

    it('should perform simulation for high-value opportunities (tier: full)', async () => {
      const mockSimService = createMockSimulationService({
        getSimulationTier: jest.fn().mockReturnValue('full'),
      });
      const ctx = createMockContext({ simulationService: mockSimService });
      const opportunity = createMockOpportunity({ expectedProfit: 200 }); // $200 - above threshold

      await strategy.execute(opportunity, ctx);

      // Should call simulate() when tier is 'full'
      expect(mockSimService.simulate).toHaveBeenCalled();
    });

    it('should use light simulation for time-critical opportunities (tier: light)', async () => {
      const mockSimService = createMockSimulationService({
        getSimulationTier: jest.fn().mockReturnValue('light'), // Light tier for time-critical
      });
      const ctx = createMockContext({ simulationService: mockSimService });
      // Opportunity is 3 seconds old (stale)
      const opportunity = createMockOpportunity({
        expectedProfit: 200,
        timestamp: Date.now() - 3000, // 3 seconds old
      });

      await strategy.execute(opportunity, ctx);

      // getSimulationTier should be called with profit and opportunity age
      expect(mockSimService.getSimulationTier).toHaveBeenCalledWith(
        200, // expectedProfit
        expect.any(Number) // opportunityAge
      );
      // Should still call simulate() but with light tier
      expect(mockSimService.simulate).toHaveBeenCalled();
    });
  });

  describe('simulation result handling', () => {
    it('should abort execution when simulation predicts revert', async () => {
      const mockSimService = createMockSimulationService({
        shouldSimulate: jest.fn().mockReturnValue(true),
        simulate: jest.fn().mockResolvedValue({
          success: true,
          wouldRevert: true,
          revertReason: 'INSUFFICIENT_OUTPUT_AMOUNT',
          provider: 'tenderly',
          latencyMs: 100,
        } as SimulationResult),
      });
      const ctx = createMockContext({ simulationService: mockSimService });
      const opportunity = createMockOpportunity();

      const result = await strategy.execute(opportunity, ctx);

      expect(result.success).toBe(false);
      // Fix 6.1: Error format changed to use ExecutionErrorCode
      expect(result.error).toContain('ERR_SIMULATION_REVERT');
      expect(result.error).toContain('INSUFFICIENT_OUTPUT_AMOUNT');
      // Should NOT send transaction
      const wallet = ctx.wallets.get('ethereum');
      expect(wallet?.sendTransaction).not.toHaveBeenCalled();
    });

    it('should proceed with execution when simulation succeeds', async () => {
      const mockSimService = createMockSimulationService({
        shouldSimulate: jest.fn().mockReturnValue(true),
        simulate: jest.fn().mockResolvedValue({
          success: true,
          wouldRevert: false,
          gasUsed: BigInt(180000),
          provider: 'tenderly',
          latencyMs: 100,
        } as SimulationResult),
      });
      const ctx = createMockContext({ simulationService: mockSimService });
      const opportunity = createMockOpportunity();

      const result = await strategy.execute(opportunity, ctx);

      // Should proceed to send transaction
      expect(result.success).toBe(true);
      expect(result.transactionHash).toMatch(/^0x[a-fA-F0-9]+$/);
    });

    it('should handle simulation service errors gracefully', async () => {
      const mockSimService = createMockSimulationService({
        shouldSimulate: jest.fn().mockReturnValue(true),
        simulate: jest.fn().mockResolvedValue({
          success: false,
          wouldRevert: false,
          error: 'Simulation provider unavailable',
          provider: 'tenderly',
          latencyMs: 0,
        } as SimulationResult),
      });
      const ctx = createMockContext({ simulationService: mockSimService });
      const opportunity = createMockOpportunity();

      const result = await strategy.execute(opportunity, ctx);

      // When simulation fails (service error), should log warning and proceed
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Simulation'), // Case-sensitive match
        expect.objectContaining({
          opportunityId: opportunity.id,
          error: 'Simulation provider unavailable',
        })
      );
      // Execution should still attempt (graceful degradation)
      expect(result.success).toBe(true);
    });

    it('should use simulated gas estimate when available', async () => {
      const simulatedGas = BigInt(250000);
      const mockSimService = createMockSimulationService({
        shouldSimulate: jest.fn().mockReturnValue(true),
        simulate: jest.fn().mockResolvedValue({
          success: true,
          wouldRevert: false,
          gasUsed: simulatedGas,
          provider: 'tenderly',
          latencyMs: 100,
        } as SimulationResult),
      });
      const ctx = createMockContext({ simulationService: mockSimService });
      const opportunity = createMockOpportunity();

      await strategy.execute(opportunity, ctx);

      // The simulated gas should be logged and potentially used
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Simulation'),
        expect.objectContaining({
          gasUsed: simulatedGas.toString(),
        })
      );
    });
  });

  describe('execution without simulation service', () => {
    it('should execute normally when simulation service is not configured', async () => {
      // No simulation service in context
      const ctx = createMockContext({ simulationService: undefined });
      const opportunity = createMockOpportunity();

      const result = await strategy.execute(opportunity, ctx);

      // Should proceed without simulation
      expect(result.success).toBe(true);
      expect(result.transactionHash).toMatch(/^0x[a-fA-F0-9]+$/);
    });
  });

  describe('metrics tracking', () => {
    it('should track simulation metrics in stats', async () => {
      const mockSimService = createMockSimulationService({
        shouldSimulate: jest.fn().mockReturnValue(true),
        simulate: jest.fn().mockResolvedValue({
          success: true,
          wouldRevert: true,
          revertReason: 'UniswapV2: K',
          provider: 'tenderly',
          latencyMs: 150,
        } as SimulationResult),
      });
      const ctx = createMockContext({ simulationService: mockSimService });
      const opportunity = createMockOpportunity();

      await strategy.execute(opportunity, ctx);

      // Verify simulation is logged with metrics
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Simulation'),
        expect.objectContaining({
          opportunityId: opportunity.id,
          success: true,
          wouldRevert: true,
          revertReason: 'UniswapV2: K',
          provider: 'tenderly',
          latencyMs: expect.any(Number),
        })
      );
    });

    it('should increment simulationsPerformed stat on successful simulation', async () => {
      const mockSimService = createMockSimulationService({
        shouldSimulate: jest.fn().mockReturnValue(true),
        simulate: jest.fn().mockResolvedValue({
          success: true,
          wouldRevert: false,
          provider: 'tenderly',
          latencyMs: 100,
        } as SimulationResult),
      });
      const ctx = createMockContext({ simulationService: mockSimService });
      const opportunity = createMockOpportunity();

      await strategy.execute(opportunity, ctx);

      expect(ctx.stats.simulationsPerformed).toBe(1);
    });

    it('should increment simulationsSkipped when simulation is skipped (tier: none)', async () => {
      const mockSimService = createMockSimulationService({
        getSimulationTier: jest.fn().mockReturnValue('none'),
      });
      const ctx = createMockContext({ simulationService: mockSimService });
      const opportunity = createMockOpportunity();

      await strategy.execute(opportunity, ctx);

      expect(ctx.stats.simulationsSkipped).toBe(1);
      expect(ctx.stats.simulationsPerformed).toBe(0);
    });

    it('should increment simulationPredictedReverts when simulation predicts revert', async () => {
      const mockSimService = createMockSimulationService({
        shouldSimulate: jest.fn().mockReturnValue(true),
        simulate: jest.fn().mockResolvedValue({
          success: true,
          wouldRevert: true,
          revertReason: 'INSUFFICIENT_LIQUIDITY',
          provider: 'tenderly',
          latencyMs: 100,
        } as SimulationResult),
      });
      const ctx = createMockContext({ simulationService: mockSimService });
      const opportunity = createMockOpportunity();

      await strategy.execute(opportunity, ctx);

      expect(ctx.stats.simulationsPerformed).toBe(1);
      expect(ctx.stats.simulationPredictedReverts).toBe(1);
    });

    it('should increment simulationErrors on simulation service error', async () => {
      const mockSimService = createMockSimulationService({
        shouldSimulate: jest.fn().mockReturnValue(true),
        simulate: jest.fn().mockResolvedValue({
          success: false,
          wouldRevert: false,
          error: 'Provider unavailable',
          provider: 'tenderly',
          latencyMs: 0,
        } as SimulationResult),
      });
      const ctx = createMockContext({ simulationService: mockSimService });
      const opportunity = createMockOpportunity();

      await strategy.execute(opportunity, ctx);

      expect(ctx.stats.simulationsPerformed).toBe(1);
      expect(ctx.stats.simulationErrors).toBe(1);
    });

    it('should increment simulationsSkipped when no simulation service', async () => {
      const ctx = createMockContext({ simulationService: undefined });
      const opportunity = createMockOpportunity();

      await strategy.execute(opportunity, ctx);

      expect(ctx.stats.simulationsSkipped).toBe(1);
    });
  });
});

// =============================================================================
// Test Suite: Edge Cases
// =============================================================================

describe('IntraChainStrategy - Edge Cases', () => {
  let strategy: IntraChainStrategy;
  let mockLogger: Logger;

  /**
   * Helper to mock protected methods that require external dependencies.
   * (Fix 10.1: Updated to use prepareDexSwapTransaction)
   */
  const mockStrategyMethods = (strat: IntraChainStrategy) => {
    jest.spyOn(strat as any, 'prepareDexSwapTransaction').mockResolvedValue({
      to: '0x1234567890123456789012345678901234567890',
      data: '0xabcdef',
      value: 0n,
      from: '0x1234567890123456789012345678901234567890',
    });
    jest.spyOn(strat as any, 'ensureTokenAllowance').mockResolvedValue(true);
    jest.spyOn(strat as any, 'verifyOpportunityPrices').mockResolvedValue({
      valid: true,
      currentProfit: 100,
    });
    jest.spyOn(strat as any, 'getOptimalGasPrice').mockResolvedValue(BigInt('30000000000'));
    jest.spyOn(strat as any, 'applyMEVProtection').mockImplementation(async (tx: any) => ({
      ...tx,
      gasPrice: BigInt('30000000000'),
    }));
    jest.spyOn(strat as any, 'calculateActualProfit').mockResolvedValue(95);

    // Fix 3.1/8.4: Mock isProviderHealthy to avoid Promise.race timing issues in tests
    jest.spyOn(strat as any, 'isProviderHealthy').mockResolvedValue(true);

    // Fix 3.1/8.4: Mock refreshGasPriceForSubmission to avoid real provider calls
    jest.spyOn(strat as any, 'refreshGasPriceForSubmission').mockResolvedValue(BigInt('30000000000'));
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    strategy = new IntraChainStrategy(mockLogger);
    mockStrategyMethods(strategy);
  });

  it('should handle simulation timeout gracefully', async () => {
    const mockSimService = createMockSimulationService({
      shouldSimulate: jest.fn().mockReturnValue(true),
      simulate: jest.fn().mockRejectedValue(new Error('Simulation timeout')),
    });
    const ctx = createMockContext({ simulationService: mockSimService });
    const opportunity = createMockOpportunity();

    const result = await strategy.execute(opportunity, ctx);

    // Should log warning and proceed (graceful degradation)
    expect(mockLogger.warn).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  // Test Gap 8.3 Fix: Test unhealthy provider scenario
  it('should fail gracefully when provider is unhealthy', async () => {
    const mockSimService = createMockSimulationService({
      shouldSimulate: jest.fn().mockReturnValue(true),
      simulate: jest.fn().mockResolvedValue({
        success: true,
        wouldRevert: false,
        provider: 'tenderly',
        latencyMs: 100,
      } as SimulationResult),
    });
    const ctx = createMockContext({ simulationService: mockSimService });
    const opportunity = createMockOpportunity();

    // Override isProviderHealthy to return false
    jest.spyOn(strategy as any, 'isProviderHealthy').mockResolvedValue(false);

    const result = await strategy.execute(opportunity, ctx);

    // Should fail because provider is unhealthy
    expect(result.success).toBe(false);
    // The actual error code is ERR_PROVIDER_UNHEALTHY (from submitTransaction health check)
    expect(result.error).toContain('ERR_PROVIDER_UNHEALTHY');
    // Transaction should NOT be attempted
    const wallet = ctx.wallets.get('ethereum');
    expect(wallet?.sendTransaction).not.toHaveBeenCalled();
  });

  it('should pass correct parameters to simulation service', async () => {
    const mockSimService = createMockSimulationService({
      getSimulationTier: jest.fn().mockReturnValue('full'),
    });

    // Create context with arbitrum provider and wallet
    const providers = new Map<string, ethers.JsonRpcProvider>();
    providers.set('arbitrum', createMockProvider());

    const wallets = new Map<string, ethers.Wallet>();
    wallets.set('arbitrum', createMockWallet());

    const ctx = createMockContext({
      simulationService: mockSimService,
      providers,
      wallets,
    });

    const opportunity = createMockOpportunity({
      buyChain: 'arbitrum',
      sellChain: 'arbitrum', // Fix: sellChain must match buyChain for intra-chain strategy
      expectedProfit: 150,
    });

    await strategy.execute(opportunity, ctx);

    // Verify getSimulationTier was called with correct params
    expect(mockSimService.getSimulationTier).toHaveBeenCalledWith(
      150, // expectedProfit
      expect.any(Number) // opportunityAge
    );

    // Verify simulate was called with correct chain
    expect(mockSimService.simulate).toHaveBeenCalledWith(
      expect.objectContaining({
        chain: 'arbitrum',
      })
    );
  });
});
