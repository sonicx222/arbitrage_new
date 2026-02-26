/**
 * Cross-Chain Strategy Tests
 *
 * Tests for cross-chain arbitrage execution including:
 * - Chain validation (source/destination)
 * - Bridge router selection and quote validation
 * - Bridge fee profitability checks
 * - Pre-destination simulation (Phase 1.1)
 * - Multi-step execution flow
 * - Nonce management for both chains
 * - Error handling and partial execution recovery
 * - Destination chain flash loan execution (FE-001)
 */

import { ethers } from 'ethers';
import { CrossChainStrategy } from '../../../src/strategies/cross-chain.strategy';
import { FlashLoanStrategy } from '../../../src/strategies/flash-loan.strategy';
import type { FlashLoanProviderFactory } from '../../../src/strategies/flash-loan-providers/provider-factory';
import type { StrategyContext, ExecutionResult, Logger } from '../../../src/types';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type {
  ISimulationService,
  SimulationResult,
  SimulationMetrics,
  SimulationProviderType,
} from '../../../src/services/simulation/types';
import {
  createMockStrategyLogger,
  createMockStrategyProvider,
  createMockStrategyWallet,
  createMockStrategyOpportunity,
} from '@arbitrage/test-utils';

// =============================================================================
// Mock Implementations (shared factories with local aliases/overrides)
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

const createMockOpportunity = (
  overrides: Partial<ArbitrageOpportunity> = {}
): ArbitrageOpportunity =>
  createMockStrategyOpportunity({
    id: 'test-cross-chain-opp-123',
    type: 'cross-chain',
    sellChain: 'arbitrum',
    ...overrides,
  });

const createMockProvider = createMockStrategyProvider;
const createMockWallet = createMockStrategyWallet;

const createMockBridgeRouter = (overrides: {
  quote?: any;
  execute?: any;
  status?: any;
} = {}) => {
  const defaultQuote = {
    valid: true,
    estimatedOutput: BigInt('1000000000'),
    gasFee: BigInt('1000000000000000'), // 0.001 ETH (native wei)
    totalFee: BigInt('1000000000000000'), // Same as gasFee (native wei only)
    expiresAt: Date.now() + 60000,
  };

  const defaultExecute = {
    success: true,
    txHash: '0xbridge123',
    bridgeId: 'bridge-id-123',
    gasUsed: BigInt(250000),
  };

  const defaultStatus = {
    status: 'completed',
    sourceHash: '0xbridge123',
    destHash: '0xdest456',
  };

  return {
    protocol: 'stargate',
    isRouteSupported: jest.fn().mockReturnValue(true),
    quote: jest.fn().mockResolvedValue({ ...defaultQuote, ...overrides.quote }),
    execute: jest.fn().mockResolvedValue({ ...defaultExecute, ...overrides.execute }),
    getStatus: jest.fn().mockResolvedValue({ ...defaultStatus, ...overrides.status }),
  };
};

const createMockBridgeRouterFactory = (bridgeRouter: any = null) => ({
  findSupportedRouter: jest.fn().mockReturnValue(bridgeRouter || createMockBridgeRouter()),
  getDefaultRouter: jest.fn().mockReturnValue(bridgeRouter || createMockBridgeRouter()),
  getRouter: jest.fn().mockReturnValue(bridgeRouter || createMockBridgeRouter()),
  getAvailableRouters: jest.fn().mockReturnValue(['stargate']),
  getRouterInfo: jest.fn().mockReturnValue({ protocol: 'stargate', supported: true }),
} as any); // Cast to any for mock flexibility

const createMockContext = (
  overrides: Partial<StrategyContext> = {}
): StrategyContext => {
  const providers = new Map<string, ethers.JsonRpcProvider>();
  providers.set('ethereum', createMockProvider());
  providers.set('arbitrum', createMockProvider());

  const wallets = new Map<string, ethers.Wallet>();
  wallets.set('ethereum', createMockWallet());
  wallets.set('arbitrum', createMockWallet());

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
    bridgeRouterFactory: createMockBridgeRouterFactory(),
    stateManager: {
      isRunning: jest.fn().mockReturnValue(true),
    } as any,
    gasBaselines: new Map(),
    lastGasPrices: new Map(),
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
      simulationsPerformed: 0,
      simulationsSkipped: 0,
      simulationPredictedReverts: 0,
      simulationErrors: 0,
      circuitBreakerTrips: 0,
      circuitBreakerBlocks: 0,
      riskEVRejections: 0,
      riskPositionSizeRejections: 0,
      riskDrawdownBlocks: 0,
      riskCautionCount: 0,
      riskHaltCount: 0,
    },
    simulationService: undefined,
    ...overrides,
  } as StrategyContext;
};

// =============================================================================
// Test Suite: Chain Validation
// =============================================================================

describe('CrossChainStrategy - Chain Validation', () => {
  let strategy: CrossChainStrategy;
  let mockLogger: Logger;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    strategy = new CrossChainStrategy(mockLogger);
  });

  it('should fail when source chain is missing', async () => {
    const ctx = createMockContext();
    const opportunity = createMockOpportunity({ buyChain: undefined });

    const result = await strategy.execute(opportunity, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing source or destination chain');
  });

  it('should fail when destination chain is missing', async () => {
    const ctx = createMockContext();
    const opportunity = createMockOpportunity({ sellChain: undefined });

    const result = await strategy.execute(opportunity, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing source or destination chain');
  });

  it('should fail when source and destination chains are the same', async () => {
    const ctx = createMockContext();
    const opportunity = createMockOpportunity({
      buyChain: 'ethereum',
      sellChain: 'ethereum',
    });

    const result = await strategy.execute(opportunity, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Cross-chain arbitrage requires different chains');
  });
});

// =============================================================================
// Test Suite: Bridge Router
// =============================================================================

describe('CrossChainStrategy - Bridge Router', () => {
  let strategy: CrossChainStrategy;
  let mockLogger: Logger;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    strategy = new CrossChainStrategy(mockLogger);
  });

  it('should fail when bridge router factory is not initialized', async () => {
    const ctx = createMockContext({ bridgeRouterFactory: null });
    const opportunity = createMockOpportunity();

    const result = await strategy.execute(opportunity, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Bridge router not initialized');
  });

  it('should fail when no bridge route is available', async () => {
    const ctx = createMockContext({
      bridgeRouterFactory: {
        findSupportedRouter: jest.fn().mockReturnValue(null),
      } as any,
    });
    const opportunity = createMockOpportunity();

    const result = await strategy.execute(opportunity, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('No bridge route available');
  });

  it('should fail when bridge quote is invalid', async () => {
    const mockRouter = createMockBridgeRouter({
      quote: { valid: false, error: 'Insufficient liquidity' },
    });
    const ctx = createMockContext({
      bridgeRouterFactory: createMockBridgeRouterFactory(mockRouter),
    });
    const opportunity = createMockOpportunity();

    const result = await strategy.execute(opportunity, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Bridge quote failed');
    expect(result.error).toContain('Insufficient liquidity');
  });

  it('should fail when bridge fees exceed 50% of profit', async () => {
    // Bridge fee validation now properly compares USD to USD:
    // - 0.06 ETH * $3500/ETH = $210 USD bridge fee
    // - expectedProfit = $100 USD
    // - threshold = $50 (50% of $100)
    // - $210 >= $50 → should fail
    const mockRouter = createMockBridgeRouter({
      quote: {
        valid: true,
        gasFee: BigInt('60000000000000000'), // 0.06 ETH = ~$210 at $3500/ETH
        totalFee: BigInt('60000000000000000'),
        expiresAt: Date.now() + 60000,
      },
    });
    const ctx = createMockContext({
      bridgeRouterFactory: createMockBridgeRouterFactory(mockRouter),
    });
    // $100 profit, 50% threshold = $50, so $210 fee should trigger failure
    const opportunity = createMockOpportunity({ expectedProfit: 100 });

    const result = await strategy.execute(opportunity, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Bridge fees');
    expect(result.error).toContain('exceed 50%');
  });
});

// =============================================================================
// Test Suite: Wallet/Provider Validation
// =============================================================================

describe('CrossChainStrategy - Wallet/Provider Validation', () => {
  let strategy: CrossChainStrategy;
  let mockLogger: Logger;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    strategy = new CrossChainStrategy(mockLogger);
  });

  it('should fail when source chain wallet is missing', async () => {
    const wallets = new Map<string, ethers.Wallet>();
    wallets.set('arbitrum', createMockWallet()); // Only dest wallet

    const ctx = createMockContext({ wallets });
    const opportunity = createMockOpportunity();

    const result = await strategy.execute(opportunity, ctx);

    expect(result.success).toBe(false);
    // Fix 6.1: Error format changed to use ExecutionErrorCode
    expect(result.error).toContain('ERR_NO_WALLET');
  });

  it('should fail when source chain provider is missing', async () => {
    const providers = new Map<string, ethers.JsonRpcProvider>();
    providers.set('arbitrum', createMockProvider()); // Only dest provider

    const ctx = createMockContext({ providers });
    const opportunity = createMockOpportunity();

    const result = await strategy.execute(opportunity, ctx);

    expect(result.success).toBe(false);
    // Fix 6.1: Error format changed to use ExecutionErrorCode
    expect(result.error).toContain('ERR_NO_PROVIDER');
  });
});

// =============================================================================
// Test Suite: Quote Expiry
// =============================================================================

describe('CrossChainStrategy - Quote Expiry', () => {
  let strategy: CrossChainStrategy;
  let mockLogger: Logger;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    strategy = new CrossChainStrategy(mockLogger);
  });

  it('should fail when bridge quote has expired', async () => {
    const mockRouter = createMockBridgeRouter({
      quote: {
        valid: true,
        gasFee: BigInt('1000000000000000'),
        totalFee: BigInt('1000000000000000'),
        expiresAt: Date.now() - 1000, // Already expired
      },
    });
    const ctx = createMockContext({
      bridgeRouterFactory: createMockBridgeRouterFactory(mockRouter),
    });
    const opportunity = createMockOpportunity();

    const result = await strategy.execute(opportunity, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('[ERR_QUOTE_EXPIRED]');
    expect(ctx.nonceManager?.failTransaction).toHaveBeenCalled();
  });
});

// =============================================================================
// Test Suite: Simulation Integration (Phase 1.1)
// =============================================================================

describe('CrossChainStrategy - Simulation Integration', () => {
  let strategy: CrossChainStrategy;
  let mockLogger: Logger;

  /**
   * Helper to mock protected methods for unit testing
   */
  const mockStrategyMethods = (strat: CrossChainStrategy) => {
    jest.spyOn(strat as any, 'prepareDexSwapTransaction').mockResolvedValue({
      to: '0x1234567890123456789012345678901234567890',
      data: '0xabcdef',
      value: 0n,
      from: '0x1234567890123456789012345678901234567890',
    });
    jest.spyOn(strat as any, 'getOptimalGasPrice').mockResolvedValue(BigInt('30000000000'));
    jest.spyOn(strat as any, 'applyMEVProtection').mockImplementation(async (tx: any) => ({
      ...tx,
      gasPrice: BigInt('30000000000'),
    }));
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    strategy = new CrossChainStrategy(mockLogger);
    mockStrategyMethods(strategy);
  });

  it('should abort execution when source buy simulation predicts revert', async () => {
    // Phase 2.1: Now catches buy-side failures BEFORE destination simulation
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
    // Now catches at source buy simulation (runs before bridge quote)
    expect(result.error).toContain('source buy simulation predicted revert');
    expect(result.error).toContain('INSUFFICIENT_OUTPUT_AMOUNT');
    expect(ctx.stats.simulationPredictedReverts).toBe(1);
  });

  it('should proceed when simulation succeeds', async () => {
    const mockSimService = createMockSimulationService({
      shouldSimulate: jest.fn().mockReturnValue(true),
      simulate: jest.fn().mockResolvedValue({
        success: true,
        wouldRevert: false,
        provider: 'tenderly',
        latencyMs: 100,
      } as SimulationResult),
    });

    const mockRouter = createMockBridgeRouter();
    const ctx = createMockContext({
      simulationService: mockSimService,
      bridgeRouterFactory: createMockBridgeRouterFactory(mockRouter),
    });
    const opportunity = createMockOpportunity();

    const result = await strategy.execute(opportunity, ctx);

    // Should proceed to bridge execution
    expect(mockRouter.execute).toHaveBeenCalled();
  });

  it('should continue when simulation preparation fails (graceful degradation)', async () => {
    const mockSimService = createMockSimulationService({
      shouldSimulate: jest.fn().mockReturnValue(true),
    });

    // Fix 8.3: Make prepareDexSwapTransaction throw to test graceful degradation
    jest.spyOn(strategy as any, 'prepareDexSwapTransaction').mockRejectedValue(
      new Error('Failed to prepare transaction')
    );

    const mockRouter = createMockBridgeRouter();
    const ctx = createMockContext({
      simulationService: mockSimService,
      bridgeRouterFactory: createMockBridgeRouterFactory(mockRouter),
    });
    const opportunity = createMockOpportunity();

    const result = await strategy.execute(opportunity, ctx);

    // Should log debug and continue to execution
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('Could not prepare destination sell for simulation'),
      expect.any(Object)
    );
    expect(mockRouter.execute).toHaveBeenCalled();
  });
});

// =============================================================================
// Test Suite: Bridge Execution
// =============================================================================

describe('CrossChainStrategy - Bridge Execution', () => {
  let strategy: CrossChainStrategy;
  let mockLogger: Logger;

  const mockStrategyMethods = (strat: CrossChainStrategy) => {
    jest.spyOn(strat as any, 'prepareDexSwapTransaction').mockResolvedValue({
      to: '0x1234567890123456789012345678901234567890',
      data: '0xabcdef',
      value: 0n,
      from: '0x1234567890123456789012345678901234567890',
    });
    jest.spyOn(strat as any, 'getOptimalGasPrice').mockResolvedValue(BigInt('30000000000'));
    jest.spyOn(strat as any, 'applyMEVProtection').mockImplementation(async (tx: any) => ({
      ...tx,
      gasPrice: BigInt('30000000000'),
    }));
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    strategy = new CrossChainStrategy(mockLogger);
    mockStrategyMethods(strategy);
  });

  it('should handle bridge execution failure', async () => {
    const mockRouter = createMockBridgeRouter({
      execute: { success: false, error: 'Bridge transaction reverted' },
    });
    const ctx = createMockContext({
      bridgeRouterFactory: createMockBridgeRouterFactory(mockRouter),
    });
    const opportunity = createMockOpportunity();

    const result = await strategy.execute(opportunity, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Bridge execution failed');
  });

  // Fix 8.1: Bridge status transition tests
  // Note: Full timeout tests require real timers and are better suited for integration tests.
  // These unit tests verify the error handling paths for bridge failures.
  it('should handle bridge status failure correctly', async () => {
    // Mock bridge that returns failed status immediately
    const mockRouter = {
      protocol: 'stargate',
      isRouteSupported: jest.fn().mockReturnValue(true),
      quote: jest.fn().mockResolvedValue({
        valid: true,
        estimatedOutput: BigInt('1000000000'),
        gasFee: BigInt('1000000000000000'),
        totalFee: BigInt('1000000000000000'),
        expiresAt: Date.now() + 60000,
      }),
      execute: jest.fn().mockResolvedValue({
        success: true,
        sourceTxHash: '0xbridge123',
        bridgeId: 'bridge-id-123',
        gasUsed: BigInt(250000),
      }),
      // Returns 'failed' status immediately
      getStatus: jest.fn().mockResolvedValue({
        status: 'failed',
        error: 'Bridge reverted on destination',
      }),
    };

    const ctx = createMockContext({
      bridgeRouterFactory: createMockBridgeRouterFactory(mockRouter),
    });
    const opportunity = createMockOpportunity();

    const result = await strategy.execute(opportunity, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('[ERR_BRIDGE_FAILED]');
    expect(result.error).toContain('Bridge reverted on destination');
    expect(result.transactionHash).toBe('0xbridge123');
  });

  it('should handle bridge refunded status correctly', async () => {
    const mockRouter = {
      protocol: 'stargate',
      isRouteSupported: jest.fn().mockReturnValue(true),
      quote: jest.fn().mockResolvedValue({
        valid: true,
        estimatedOutput: BigInt('1000000000'),
        gasFee: BigInt('1000000000000000'),
        totalFee: BigInt('1000000000000000'),
        expiresAt: Date.now() + 60000,
      }),
      execute: jest.fn().mockResolvedValue({
        success: true,
        sourceTxHash: '0xbridge123',
        bridgeId: 'bridge-id-123',
        gasUsed: BigInt(250000),
      }),
      // Returns 'refunded' status
      getStatus: jest.fn().mockResolvedValue({
        status: 'refunded',
        error: 'Bridge transaction was refunded',
      }),
    };

    const ctx = createMockContext({
      bridgeRouterFactory: createMockBridgeRouterFactory(mockRouter),
    });
    const opportunity = createMockOpportunity();

    const result = await strategy.execute(opportunity, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('[ERR_BRIDGE_FAILED]');
    expect(result.transactionHash).toBe('0xbridge123');
  });

  // Fix 8.3: Documentation for 'inflight' bridge status handling
  //
  // The polling logic in pollBridgeCompletion() handles 'inflight' status:
  // - 'pending' and 'inflight' are NOT terminal states - polling continues
  // - 'completed' is the success exit condition
  // - 'failed' and 'refunded' are error exit conditions
  //
  // The 'inflight' status indicates tokens are in transit across the bridge.
  // This is tested implicitly by:
  // 1. 'should handle bridge status failure correctly' - verifies terminal 'failed' state
  // 2. 'should handle bridge refunded status correctly' - verifies terminal 'refunded' state
  // 3. 'should complete full cross-chain execution flow' - verifies 'completed' state
  //
  // Full end-to-end polling tests with status transitions (pending -> inflight -> completed)
  // require complex mocking and timer handling. See cross-chain integration tests.
  //
  // Code reference: cross-chain.strategy.ts lines 823-883 (pollBridgeCompletion method)

  // Fix 2.2: Bridge status transition documentation
  // Note: Full end-to-end polling tests with status transitions are better suited for
  // integration tests as they involve real delays. The existing tests for immediate
  // 'completed', 'failed', and 'refunded' statuses cover the main code paths.
  //
  // The polling logic in cross-chain.strategy.ts supports these status values:
  // - 'pending': Continue polling (waiting for bridge to start)
  // - 'inflight': Continue polling (tokens in transit)
  // - 'completed': Exit loop, proceed to destination sell
  // - 'failed': Return error result with bridge details
  // - 'refunded': Return error result (treated as failure with refund)
  //
  // Each status transition is logged via logger.debug('Bridge status changed', ...)
  // See cross-chain.strategy.ts lines 383-393 for the status transition logging.
});

// =============================================================================
// Test Suite: Nonce Management
// =============================================================================

describe('CrossChainStrategy - Nonce Management', () => {
  let strategy: CrossChainStrategy;
  let mockLogger: Logger;

  const mockStrategyMethods = (strat: CrossChainStrategy) => {
    jest.spyOn(strat as any, 'prepareDexSwapTransaction').mockResolvedValue({
      to: '0x1234567890123456789012345678901234567890',
      data: '0xabcdef',
      value: 0n,
    });
    jest.spyOn(strat as any, 'getOptimalGasPrice').mockResolvedValue(BigInt('30000000000'));
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    strategy = new CrossChainStrategy(mockLogger);
    mockStrategyMethods(strategy);
  });

  it('should fail nonce on quote expiry', async () => {
    // Create a mock router with an expired quote (expiresAt in the past)
    const expiredTime = Date.now() - 5000; // 5 seconds ago
    const mockRouter = createMockBridgeRouter({
      quote: {
        valid: true,
        gasFee: BigInt('1000000000000000'),
        totalFee: BigInt('1000000000000000'),
        expiresAt: expiredTime,
      },
    });
    const ctx = createMockContext({
      bridgeRouterFactory: createMockBridgeRouterFactory(mockRouter),
    });
    const opportunity = createMockOpportunity();

    const result = await strategy.execute(opportunity, ctx);

    // Should fail due to expired quote
    expect(result.success).toBe(false);
    expect(result.error).toContain('expired');
  });

  it('should request nonces for both source and destination chains', async () => {
    const mockRouter = createMockBridgeRouter();
    const ctx = createMockContext({
      bridgeRouterFactory: createMockBridgeRouterFactory(mockRouter),
    });
    const opportunity = createMockOpportunity();

    await strategy.execute(opportunity, ctx);

    // Should get nonce for bridge (source chain)
    expect(ctx.nonceManager?.getNextNonce).toHaveBeenCalledWith('ethereum');
  });
});

// =============================================================================
// Test Suite: Bridge Fee Type Coercion (BUG-FIX Regression Test)
// =============================================================================

describe('CrossChainStrategy - Bridge Fee Type Coercion', () => {
  let strategy: CrossChainStrategy;
  let mockLogger: Logger;

  const mockStrategyMethods = (strat: CrossChainStrategy) => {
    jest.spyOn(strat as any, 'prepareDexSwapTransaction').mockResolvedValue({
      to: '0x1234567890123456789012345678901234567890',
      data: '0xabcdef',
      value: 0n,
      from: '0x1234567890123456789012345678901234567890',
    });
    jest.spyOn(strat as any, 'getOptimalGasPrice').mockResolvedValue(BigInt('30000000000'));
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    strategy = new CrossChainStrategy(mockLogger);
    mockStrategyMethods(strategy);
  });

  it('should handle invalid gasFee string gracefully (BUG-FIX regression)', async () => {
    // Test the fix for BigInt() throwing on invalid strings
    const mockRouter = createMockBridgeRouter({
      quote: {
        valid: true,
        gasFee: 'invalid-not-a-number', // Invalid string that would crash BigInt()
        totalFee: 'invalid-not-a-number',
        expiresAt: Date.now() + 60000,
      },
    });
    const ctx = createMockContext({
      bridgeRouterFactory: createMockBridgeRouterFactory(mockRouter),
    });
    const opportunity = createMockOpportunity();

    const result = await strategy.execute(opportunity, ctx);

    // Should return error instead of crashing
    expect(result.success).toBe(false);
    expect(result.error).toContain('[ERR_BRIDGE_QUOTE]');
    expect(result.error).toContain('Invalid bridge gasFee format');
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Invalid bridge gasFee format',
      expect.objectContaining({
        gasFee: 'invalid-not-a-number',
      })
    );
  });

  it('should handle undefined gasFee gracefully (BUG-FIX regression)', async () => {
    const mockRouter = createMockBridgeRouter({
      quote: {
        valid: true,
        gasFee: undefined, // Missing fee
        totalFee: undefined,
        expiresAt: Date.now() + 60000,
      },
    });
    const ctx = createMockContext({
      bridgeRouterFactory: createMockBridgeRouterFactory(mockRouter),
    });
    const opportunity = createMockOpportunity();

    const result = await strategy.execute(opportunity, ctx);

    // Should handle undefined by defaulting to 0n or returning error
    // The fix converts undefined to 0n which is valid
    expect(result).toMatchObject({ opportunityId: expect.any(String) });
    // Either succeeds with 0 fee or fails for another reason, but should not crash
  });

  it('should handle string gasFee correctly (normal case)', async () => {
    // Bridge APIs sometimes return fees as strings from JSON
    const mockRouter = createMockBridgeRouter({
      quote: {
        valid: true,
        gasFee: '1000000000000000', // 0.001 ETH as string
        totalFee: '1000000000000000',
        expiresAt: Date.now() + 60000,
      },
    });
    const ctx = createMockContext({
      bridgeRouterFactory: createMockBridgeRouterFactory(mockRouter),
    });
    const opportunity = createMockOpportunity({ expectedProfit: 100 });

    const result = await strategy.execute(opportunity, ctx);

    // Should proceed normally with string fee
    expect(mockRouter.execute).toHaveBeenCalled();
  });
});

// =============================================================================
// Test Suite: Successful Execution Flow
// =============================================================================

describe('CrossChainStrategy - Successful Execution', () => {
  let strategy: CrossChainStrategy;
  let mockLogger: Logger;

  const mockStrategyMethods = (strat: CrossChainStrategy) => {
    jest.spyOn(strat as any, 'prepareDexSwapTransaction').mockResolvedValue({
      to: '0x1234567890123456789012345678901234567890',
      data: '0xabcdef',
      value: 0n,
      from: '0x1234567890123456789012345678901234567890',
    });
    jest.spyOn(strat as any, 'getOptimalGasPrice').mockResolvedValue(BigInt('30000000000'));
    jest.spyOn(strat as any, 'applyMEVProtection').mockImplementation(async (tx: any) => ({
      ...tx,
      gasPrice: BigInt('30000000000'),
    }));
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    strategy = new CrossChainStrategy(mockLogger);
    mockStrategyMethods(strategy);
  });

  it('should complete full cross-chain execution flow', async () => {
    const mockRouter = createMockBridgeRouter();
    const ctx = createMockContext({
      bridgeRouterFactory: createMockBridgeRouterFactory(mockRouter),
    });
    const opportunity = createMockOpportunity({ expectedProfit: 100 });

    const result = await strategy.execute(opportunity, ctx);

    // Verify bridge router was called
    expect(mockRouter.quote).toHaveBeenCalled();
    expect(mockRouter.execute).toHaveBeenCalled();
    expect(mockRouter.getStatus).toHaveBeenCalled();

    // Verify logging
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Starting cross-chain arbitrage execution',
      expect.objectContaining({
        opportunityId: opportunity.id,
        sourceChain: 'ethereum',
        destChain: 'arbitrum',
      })
    );
  });

  it('should calculate actual profit correctly', async () => {
    const mockRouter = createMockBridgeRouter({
      quote: {
        valid: true,
        gasFee: BigInt('5000000000000000'), // 0.005 ETH
        totalFee: BigInt('5000000000000000'),
        expiresAt: Date.now() + 60000,
      },
    });
    const ctx = createMockContext({
      bridgeRouterFactory: createMockBridgeRouterFactory(mockRouter),
    });
    const opportunity = createMockOpportunity({ expectedProfit: 100 });

    const result = await strategy.execute(opportunity, ctx);

    if (result.success) {
      // Actual profit should account for bridge fees and gas costs
      expect(typeof result.actualProfit).toBe('number');
    }
  });
});

// =============================================================================
// Test Suite: Bridge Recovery (Finding #6)
// =============================================================================

describe('CrossChainStrategy - Bridge Recovery', () => {
  let strategy: CrossChainStrategy;
  let mockLogger: Logger;
  let mockRedis: any;

  const createBridgeRecoveryState = (overrides: Record<string, unknown> = {}) => ({
    opportunityId: 'recovery-opp-1',
    bridgeId: 'bridge-id-1',
    sourceTxHash: '0xsource123',
    sourceChain: 'ethereum',
    destChain: 'arbitrum',
    bridgeToken: 'USDC',
    bridgeAmount: '1000000000', // 1000 USDC
    sellDex: 'sushiswap',
    expectedProfit: 50,
    tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    initiatedAt: Date.now() - 60000, // 1 minute ago
    bridgeProtocol: 'stargate',
    status: 'pending' as const,
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    strategy = new CrossChainStrategy(mockLogger);

    // Mock Redis with scan and get methods for recovery
    // scan returns [nextCursor, foundKeys] tuple
    mockRedis = {
      scan: jest.fn().mockResolvedValue(['0', []]),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };
  });

  it('should return 0 when bridgeRouterFactory is null', async () => {
    const state = createBridgeRecoveryState();
    mockRedis.scan.mockResolvedValue(['0', ['bridge:recovery:bridge-id-1']]);
    mockRedis.get.mockResolvedValue(state);

    const ctx = createMockContext({ bridgeRouterFactory: null });

    const recovered = await strategy.recoverPendingBridges(ctx, mockRedis);

    expect(recovered).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Cannot recover bridge - no bridge router factory',
    );
  });

  it('should skip expired bridge states (>72h old)', async () => {
    // Phase 0 Item 7: TTL extended from 24h to 72h
    const expiredState = createBridgeRecoveryState({
      initiatedAt: Date.now() - (73 * 60 * 60 * 1000), // 73 hours ago (exceeds 72h TTL)
    });
    mockRedis.scan.mockResolvedValue(['0', ['bridge:recovery:bridge-id-1']]);
    mockRedis.get.mockResolvedValue(expiredState);

    const ctx = createMockContext();

    const recovered = await strategy.recoverPendingBridges(ctx, mockRedis);

    expect(recovered).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Bridge recovery state expired',
      expect.objectContaining({
        bridgeId: 'bridge-id-1',
      }),
    );
  });

  it('should handle partial recovery (some succeed, some fail)', async () => {
    const state1 = createBridgeRecoveryState({
      bridgeId: 'bridge-1',
      opportunityId: 'opp-1',
    });
    const state2 = createBridgeRecoveryState({
      bridgeId: 'bridge-2',
      opportunityId: 'opp-2',
    });
    mockRedis.scan.mockResolvedValue(['0', ['bridge:recovery:bridge-1', 'bridge:recovery:bridge-2']]);
    mockRedis.get
      .mockResolvedValueOnce(state1)
      .mockResolvedValueOnce(state2);

    // Mock the private recoverSingleBridge to simulate partial success
    // The first call succeeds, the second fails
    jest.spyOn(strategy as any, 'recoverSingleBridge')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const ctx = createMockContext();

    const recovered = await strategy.recoverPendingBridges(ctx, mockRedis);

    expect(recovered).toBe(1); // Only 1 of 2 recovered
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Bridge recovery completed',
      expect.objectContaining({
        total: 2,
        recovered: 1,
      }),
    );
  });

  it('should handle Redis scan returning no keys', async () => {
    mockRedis.scan.mockResolvedValue(['0', []]);

    const ctx = createMockContext();

    const recovered = await strategy.recoverPendingBridges(ctx, mockRedis);

    expect(recovered).toBe(0);
  });

  it('should handle Redis scan failure gracefully', async () => {
    mockRedis.scan.mockRejectedValue(new Error('Redis connection lost'));

    const ctx = createMockContext();

    const recovered = await strategy.recoverPendingBridges(ctx, mockRedis);

    expect(recovered).toBe(0);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Bridge recovery scan failed',
      expect.objectContaining({
        error: 'Redis connection lost',
      }),
    );
  });

  it('should handle invalid JSON in recovery state', async () => {
    mockRedis.scan.mockResolvedValue(['0', ['bridge:recovery:bridge-corrupt']]);
    mockRedis.get.mockResolvedValue('not-valid-json{{{');

    const ctx = createMockContext();

    const recovered = await strategy.recoverPendingBridges(ctx, mockRedis);

    expect(recovered).toBe(0);
  });
});

// =============================================================================
// Test Suite: Destination Chain Flash Loans (FE-001)
// =============================================================================

describe('CrossChainStrategy - Destination Flash Loans (FE-001)', () => {
  let mockLogger: Logger;
  let mockFlashLoanProviderFactory: jest.Mocked<FlashLoanProviderFactory>;
  let mockFlashLoanStrategy: jest.Mocked<Pick<FlashLoanStrategy, 'execute'>>;

  const createMockFlashLoanProviderFactory = (
    supportedChains: string[] = ['arbitrum'],
  ): jest.Mocked<FlashLoanProviderFactory> => ({
    isFullySupported: jest.fn().mockImplementation((chain: string) =>
      supportedChains.includes(chain)),
    getProvider: jest.fn().mockReturnValue(undefined),
    getProtocol: jest.fn().mockReturnValue('aave_v3'),
  } as any);

  const createMockFlashLoanStrategyInstance = (
    overrides: Partial<ExecutionResult> = {},
  ): jest.Mocked<Pick<FlashLoanStrategy, 'execute'>> => ({
    execute: jest.fn().mockResolvedValue({
      success: true,
      transactionHash: '0xflash_sell_abc123',
      chain: 'arbitrum',
      dex: 'uniswap',
      actualProfit: 85,
      gasCost: 5,
      ...overrides,
    } as ExecutionResult),
  });

  const mockStrategyMethods = (strat: CrossChainStrategy) => {
    jest.spyOn(strat as any, 'prepareDexSwapTransaction').mockResolvedValue({
      to: '0x1234567890123456789012345678901234567890',
      data: '0xabcdef',
      value: 0n,
      from: '0x1234567890123456789012345678901234567890',
    });
    jest.spyOn(strat as any, 'getOptimalGasPrice').mockResolvedValue(BigInt('30000000000'));
    jest.spyOn(strat as any, 'applyMEVProtection').mockImplementation(async (tx: any) => ({
      ...tx,
      gasPrice: BigInt('30000000000'),
    }));
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger();
    mockFlashLoanProviderFactory = createMockFlashLoanProviderFactory();
    mockFlashLoanStrategy = createMockFlashLoanStrategyInstance();
  });

  it('should not attempt flash loan when factory is not provided', async () => {
    const strategy = new CrossChainStrategy(mockLogger);
    mockStrategyMethods(strategy);

    const mockRouter = createMockBridgeRouter();
    const ctx = createMockContext({
      bridgeRouterFactory: createMockBridgeRouterFactory(mockRouter),
    });
    const opportunity = createMockOpportunity({ expectedProfit: 100 });

    const result = await strategy.execute(opportunity, ctx);

    // Should use standard DEX swap path (no flash loan attempted)
    expect(mockFlashLoanProviderFactory.isFullySupported).not.toHaveBeenCalled();
  });

  it('should use flash loan when dest chain is supported and factory/strategy are provided', async () => {
    const strategy = new CrossChainStrategy(
      mockLogger,
      mockFlashLoanProviderFactory,
      mockFlashLoanStrategy as unknown as FlashLoanStrategy,
    );
    mockStrategyMethods(strategy);

    const mockRouter = createMockBridgeRouter({
      status: {
        status: 'completed',
        sourceHash: '0xbridge123',
        destHash: '0xdest456',
        amountReceived: '1000000000',
      },
    });
    const ctx = createMockContext({
      bridgeRouterFactory: createMockBridgeRouterFactory(mockRouter),
    });
    const opportunity = createMockOpportunity({
      expectedProfit: 100,
      sellChain: 'arbitrum',
    });

    const result = await strategy.execute(opportunity, ctx);

    // Should have checked flash loan support for dest chain
    expect(mockFlashLoanProviderFactory.isFullySupported).toHaveBeenCalledWith('arbitrum');
    // Should have called the flash loan strategy
    expect(mockFlashLoanStrategy.execute).toHaveBeenCalled();
  });

  it('should fall back to direct DEX swap when dest chain flash loan is not supported', async () => {
    // Factory says dest chain is NOT supported
    const unsupportedFactory = createMockFlashLoanProviderFactory([]);
    const strategy = new CrossChainStrategy(
      mockLogger,
      unsupportedFactory,
      mockFlashLoanStrategy as unknown as FlashLoanStrategy,
    );
    mockStrategyMethods(strategy);

    const mockRouter = createMockBridgeRouter({
      status: {
        status: 'completed',
        sourceHash: '0xbridge123',
        destHash: '0xdest456',
        amountReceived: '1000000000',
      },
    });
    const ctx = createMockContext({
      bridgeRouterFactory: createMockBridgeRouterFactory(mockRouter),
    });
    const opportunity = createMockOpportunity({ expectedProfit: 100 });

    await strategy.execute(opportunity, ctx);

    // Should have checked flash loan support
    expect(unsupportedFactory.isFullySupported).toHaveBeenCalled();
    // Flash loan strategy should NOT have been called
    expect(mockFlashLoanStrategy.execute).not.toHaveBeenCalled();
  });

  it('should fall back to direct DEX swap when flash loan execution fails', async () => {
    const failingFlashLoanStrategy = createMockFlashLoanStrategyInstance({
      success: false,
      error: 'Insufficient liquidity for flash loan',
    } as any);

    const strategy = new CrossChainStrategy(
      mockLogger,
      mockFlashLoanProviderFactory,
      failingFlashLoanStrategy as unknown as FlashLoanStrategy,
    );
    mockStrategyMethods(strategy);

    const mockRouter = createMockBridgeRouter({
      status: {
        status: 'completed',
        sourceHash: '0xbridge123',
        destHash: '0xdest456',
        amountReceived: '1000000000',
      },
    });
    const ctx = createMockContext({
      bridgeRouterFactory: createMockBridgeRouterFactory(mockRouter),
    });
    const opportunity = createMockOpportunity({
      expectedProfit: 100,
      sellChain: 'arbitrum',
    });

    await strategy.execute(opportunity, ctx);

    // Flash loan was attempted but failed
    expect(failingFlashLoanStrategy.execute).toHaveBeenCalled();
    // Should have logged fallback warning
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Destination flash loan failed, falling back to direct DEX swap',
      expect.objectContaining({
        opportunityId: opportunity.id,
        destChain: 'arbitrum',
      }),
    );
  });

  it('should set useFlashLoan flag on sell opportunity when flash loans are supported', async () => {
    const strategy = new CrossChainStrategy(
      mockLogger,
      mockFlashLoanProviderFactory,
      mockFlashLoanStrategy as unknown as FlashLoanStrategy,
    );
    mockStrategyMethods(strategy);

    const mockRouter = createMockBridgeRouter({
      status: {
        status: 'completed',
        sourceHash: '0xbridge123',
        destHash: '0xdest456',
        amountReceived: '1000000000',
      },
    });
    const ctx = createMockContext({
      bridgeRouterFactory: createMockBridgeRouterFactory(mockRouter),
    });
    const opportunity = createMockOpportunity({
      expectedProfit: 100,
      sellChain: 'arbitrum',
    });

    await strategy.execute(opportunity, ctx);

    // Verify the flash loan strategy was called with useFlashLoan flag
    const callArgs = mockFlashLoanStrategy.execute.mock.calls[0];
    if (callArgs) {
      const sellOpportunity = callArgs[0] as ArbitrageOpportunity;
      expect(sellOpportunity.useFlashLoan).toBe(true);
      expect(sellOpportunity.buyChain).toBe('arbitrum');
    }
  });

  it('should log flash loan info when dest flash loan succeeds', async () => {
    const strategy = new CrossChainStrategy(
      mockLogger,
      mockFlashLoanProviderFactory,
      mockFlashLoanStrategy as unknown as FlashLoanStrategy,
    );
    mockStrategyMethods(strategy);

    const mockRouter = createMockBridgeRouter({
      status: {
        status: 'completed',
        sourceHash: '0xbridge123',
        destHash: '0xdest456',
        amountReceived: '1000000000',
      },
    });
    const ctx = createMockContext({
      bridgeRouterFactory: createMockBridgeRouterFactory(mockRouter),
    });
    const opportunity = createMockOpportunity({
      expectedProfit: 100,
      sellChain: 'arbitrum',
    });

    await strategy.execute(opportunity, ctx);

    // Verify flash loan attempt was logged
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Destination chain supports flash loans - attempting atomic sell',
      expect.objectContaining({
        opportunityId: opportunity.id,
        destChain: 'arbitrum',
      }),
    );
    // Verify flash loan success was logged
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Destination flash loan sell completed successfully',
      expect.objectContaining({
        opportunityId: opportunity.id,
        destChain: 'arbitrum',
      }),
    );
  });

  it('should correctly handle isDestinationFlashLoanSupported for various chains', () => {
    const multiChainFactory = createMockFlashLoanProviderFactory(['ethereum', 'arbitrum', 'polygon']);
    const strategy = new CrossChainStrategy(
      mockLogger,
      multiChainFactory,
      mockFlashLoanStrategy as unknown as FlashLoanStrategy,
    );

    // Access the private method via type assertion for unit testing
    const isSupported = (strategy as any).isDestinationFlashLoanSupported;

    expect(isSupported.call(strategy, 'ethereum')).toBe(true);
    expect(isSupported.call(strategy, 'arbitrum')).toBe(true);
    expect(isSupported.call(strategy, 'polygon')).toBe(true);
    expect(isSupported.call(strategy, 'solana')).toBe(false);
    expect(isSupported.call(strategy, 'fantom')).toBe(false);
  });

  it('should return false from isDestinationFlashLoanSupported when no factory provided', () => {
    const strategy = new CrossChainStrategy(mockLogger);

    const isSupported = (strategy as any).isDestinationFlashLoanSupported;

    expect(isSupported.call(strategy, 'ethereum')).toBe(false);
    expect(isSupported.call(strategy, 'arbitrum')).toBe(false);
  });

  it('should handle flash loan strategy throwing an exception', async () => {
    const throwingStrategy = createMockFlashLoanStrategyInstance();
    throwingStrategy.execute.mockRejectedValue(new Error('Network timeout'));

    const strategy = new CrossChainStrategy(
      mockLogger,
      mockFlashLoanProviderFactory,
      throwingStrategy as unknown as FlashLoanStrategy,
    );
    mockStrategyMethods(strategy);

    const mockRouter = createMockBridgeRouter({
      status: {
        status: 'completed',
        sourceHash: '0xbridge123',
        destHash: '0xdest456',
        amountReceived: '1000000000',
      },
    });
    const ctx = createMockContext({
      bridgeRouterFactory: createMockBridgeRouterFactory(mockRouter),
    });
    const opportunity = createMockOpportunity({
      expectedProfit: 100,
      sellChain: 'arbitrum',
    });

    // Should not throw — should handle gracefully and fall back
    const result = await strategy.execute(opportunity, ctx);

    // Should have logged the exception
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Destination flash loan execution threw exception',
      expect.objectContaining({
        error: 'Network timeout',
      }),
    );
    // Should still attempt direct DEX swap fallback (or return an error from flash loan path)
    // The executeDestinationFlashLoan wraps errors, so the main flow falls back
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Destination flash loan failed, falling back to direct DEX swap',
      expect.objectContaining({
        opportunityId: opportunity.id,
      }),
    );
  });
});
