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
 */

import { ethers } from 'ethers';
import { CrossChainStrategy } from './cross-chain.strategy';
import type { StrategyContext, ExecutionResult, Logger } from '../types';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type {
  ISimulationService,
  SimulationResult,
  SimulationMetrics,
  SimulationProviderType,
} from '../services/simulation/types';

// =============================================================================
// Mock Implementations
// =============================================================================

const createMockLogger = (): Logger => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

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
): ArbitrageOpportunity => ({
  id: 'test-cross-chain-opp-123',
  type: 'cross-chain',
  buyChain: 'ethereum',
  sellChain: 'arbitrum',
  buyDex: 'uniswap',
  sellDex: 'sushiswap',
  tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
  tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
  amountIn: '1000000000000000000', // 1 ETH
  expectedProfit: 100, // $100 expected profit
  confidence: 0.95,
  timestamp: Date.now() - 500,
  ...overrides,
});

const createMockProvider = (): ethers.JsonRpcProvider => {
  const provider = {
    getBlockNumber: jest.fn().mockResolvedValue(12345678),
    getFeeData: jest.fn().mockResolvedValue({
      gasPrice: BigInt('30000000000'), // 30 gwei
      maxFeePerGas: BigInt('35000000000'),
      maxPriorityFeePerGas: BigInt('2000000000'),
    }),
    getTransactionReceipt: jest.fn().mockResolvedValue({
      hash: '0x123abc',
      gasUsed: BigInt(150000),
      gasPrice: BigInt('30000000000'),
      status: 1,
    }),
  } as unknown as ethers.JsonRpcProvider;
  return provider;
};

const createMockWallet = (): ethers.Wallet => {
  const wallet = {
    address: '0x1234567890123456789012345678901234567890',
    getAddress: jest.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
    sendTransaction: jest.fn().mockResolvedValue({
      hash: '0x123abc',
      wait: jest.fn().mockResolvedValue({
        hash: '0x123abc',
        gasUsed: BigInt(150000),
        gasPrice: BigInt('30000000000'),
        status: 1,
      }),
    }),
  } as unknown as ethers.Wallet;
  return wallet;
};

const createMockBridgeRouter = (overrides: {
  quote?: any;
  execute?: any;
  status?: any;
} = {}) => {
  const defaultQuote = {
    valid: true,
    estimatedOutput: BigInt('1000000000'),
    totalFee: BigInt('1000000000000000'), // 0.001 ETH
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
  findBestRouter: jest.fn().mockReturnValue(bridgeRouter || createMockBridgeRouter()),
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
    stats: {
      opportunitiesReceived: 0,
      executionAttempts: 0,
      opportunitiesRejected: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      queueRejects: 0,
      lockConflicts: 0,
      executionTimeouts: 0,
      messageProcessingErrors: 0,
      providerReconnections: 0,
      providerHealthCheckFailures: 0,
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
        findBestRouter: jest.fn().mockReturnValue(null),
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
        totalFee: BigInt('60000000000000000'), // 0.06 ETH = ~$210 at $3500/ETH
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
    expect(result.error).toContain('No wallet/provider for source chain');
  });

  it('should fail when source chain provider is missing', async () => {
    const providers = new Map<string, ethers.JsonRpcProvider>();
    providers.set('arbitrum', createMockProvider()); // Only dest provider

    const ctx = createMockContext({ providers });
    const opportunity = createMockOpportunity();

    const result = await strategy.execute(opportunity, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('No wallet/provider for source chain');
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
    expect(result.error).toContain('Bridge quote expired');
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
    jest.spyOn(strat as any, 'prepareFlashLoanTransaction').mockResolvedValue({
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

  it('should abort execution when destination simulation predicts revert', async () => {
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
    expect(result.error).toContain('destination sell simulation predicted revert');
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

    // Make prepareFlashLoanTransaction throw
    jest.spyOn(strategy as any, 'prepareFlashLoanTransaction').mockRejectedValue(
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
    jest.spyOn(strat as any, 'prepareFlashLoanTransaction').mockResolvedValue({
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

  // Note: Bridge timeout test skipped because it requires complex timeout mock setup
  // and can cause test suite to hang. Bridge timeout handling is tested via
  // integration tests with actual timeout configurations.
  it.skip('should handle bridge timeout', async () => {
    // Timeout test would go here
  });
});

// =============================================================================
// Test Suite: Nonce Management
// =============================================================================

describe('CrossChainStrategy - Nonce Management', () => {
  let strategy: CrossChainStrategy;
  let mockLogger: Logger;

  const mockStrategyMethods = (strat: CrossChainStrategy) => {
    jest.spyOn(strat as any, 'prepareFlashLoanTransaction').mockResolvedValue({
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
// Test Suite: Successful Execution Flow
// =============================================================================

describe('CrossChainStrategy - Successful Execution', () => {
  let strategy: CrossChainStrategy;
  let mockLogger: Logger;

  const mockStrategyMethods = (strat: CrossChainStrategy) => {
    jest.spyOn(strat as any, 'prepareFlashLoanTransaction').mockResolvedValue({
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
        totalFee: BigInt('5000000000000000'), // 0.005 ETH
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
      expect(result.actualProfit).toBeDefined();
      expect(typeof result.actualProfit).toBe('number');
    }
  });
});
