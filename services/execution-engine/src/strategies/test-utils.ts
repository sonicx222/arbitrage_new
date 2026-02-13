/**
 * Test Utilities for Execution Strategies
 *
 * Fix 9.3: Extracted shared test mocks to reduce duplication.
 * All strategy test files should import from this module.
 *
 * @see intra-chain.strategy.test.ts
 * @see flash-loan.strategy.test.ts
 * @see cross-chain.strategy.test.ts
 * @see simulation.strategy.test.ts
 * @see strategy-factory.test.ts
 */

import { ethers } from 'ethers';
import type { Logger, StrategyContext, ExecutionStats, ResolvedSimulationConfig } from '../types';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type { PerformanceLogger } from '@arbitrage/core';
import type {
  ISimulationService,
  SimulationResult,
  SimulationMetrics,
  SimulationProviderType,
} from '../services/simulation/types';

// =============================================================================
// Logger Mock
// =============================================================================

/**
 * Create a mock logger with jest spies.
 */
export function createMockLogger(): Logger {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

// =============================================================================
// Provider Mock
// =============================================================================

/**
 * Create a mock ethers provider.
 */
export function createMockProvider(
  overrides: Partial<{
    blockNumber: number;
    gasPrice: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  }> = {}
): ethers.JsonRpcProvider {
  const provider = {
    getBlockNumber: jest.fn().mockResolvedValue(overrides.blockNumber ?? 12345678),
    getFeeData: jest.fn().mockResolvedValue({
      gasPrice: overrides.gasPrice ?? BigInt('30000000000'),
      maxFeePerGas: overrides.maxFeePerGas ?? BigInt('35000000000'),
      maxPriorityFeePerGas: overrides.maxPriorityFeePerGas ?? BigInt('2000000000'),
    }),
    getTransactionReceipt: jest.fn().mockResolvedValue({
      hash: '0x123abc',
      gasUsed: BigInt(150000),
      gasPrice: BigInt('30000000000'),
      status: 1,
    }),
    getNetwork: jest.fn().mockResolvedValue({ chainId: 1n }),
  } as unknown as ethers.JsonRpcProvider;
  return provider;
}

// =============================================================================
// Test Address Constants
// =============================================================================

/**
 * Test 8.4 Fix: Use clearly fake test addresses to prevent accidental use of real addresses.
 * All addresses use the 0xDEAD or 0xBEEF pattern to make it obvious they're test-only.
 *
 * IMPORTANT: These addresses MUST NOT be used in production or mainnet configurations.
 * They are intentionally invalid/unused addresses for testing purposes only.
 */
export const TEST_ADDRESSES = {
  /** Test wallet address - clearly fake pattern */
  WALLET: '0xDEAD000000000000000000000000000000000001',
  /** Test token input (mock WETH) - clearly fake pattern */
  TOKEN_IN: '0xDEAD000000000000000000000000000000000002',
  /** Test token output (mock USDC) - clearly fake pattern */
  TOKEN_OUT: '0xDEAD000000000000000000000000000000000003',
  /** Test DEX router address - clearly fake pattern */
  ROUTER: '0xBEEF000000000000000000000000000000000001',
  /** Test flash loan contract - clearly fake pattern */
  FLASH_LOAN_CONTRACT: '0xBEEF000000000000000000000000000000000002',
  /** Test bridge contract - clearly fake pattern */
  BRIDGE: '0xBEEF000000000000000000000000000000000003',
} as const;

// =============================================================================
// Wallet Mock
// =============================================================================

/**
 * Create a mock ethers wallet.
 */
export function createMockWallet(address?: string): ethers.Wallet {
  const walletAddress = address ?? TEST_ADDRESSES.WALLET;
  const wallet = {
    address: walletAddress,
    getAddress: jest.fn().mockResolvedValue(walletAddress),
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
}

// =============================================================================
// Simulation Service Mock
// =============================================================================

/**
 * Create a mock simulation service.
 */
export function createMockSimulationService(
  overrides: Partial<ISimulationService> = {}
): ISimulationService {
  return {
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
  };
}

// =============================================================================
// Opportunity Mock
// =============================================================================

/**
 * Create a mock arbitrage opportunity.
 *
 * Test 8.4 Fix: Uses clearly fake test addresses (TEST_ADDRESSES) to prevent
 * accidental confusion with mainnet addresses.
 */
export function createMockOpportunity(
  overrides: Partial<ArbitrageOpportunity> = {}
): ArbitrageOpportunity {
  return {
    id: 'test-opp-123',
    type: 'simple',
    buyChain: 'ethereum',
    sellChain: 'ethereum',
    buyDex: 'uniswap',
    sellDex: 'sushiswap',
    tokenIn: TEST_ADDRESSES.TOKEN_IN,   // Mock WETH (clearly fake test address)
    tokenOut: TEST_ADDRESSES.TOKEN_OUT, // Mock USDC (clearly fake test address)
    amountIn: '1000000000000000000', // 1 ETH
    expectedProfit: 100,
    confidence: 0.95,
    buyPrice: 3000,
    sellPrice: 3050,
    timestamp: Date.now() - 500,
    ...overrides,
  };
}

// =============================================================================
// Execution Stats Mock
// =============================================================================

/**
 * Create initial execution stats.
 */
export function createMockStats(): ExecutionStats {
  return {
    opportunitiesReceived: 0,
    executionAttempts: 0,
    opportunitiesRejected: 0,
    successfulExecutions: 0,
    failedExecutions: 0,
    queueRejects: 0,
    lockConflicts: 0,
    staleLockRecoveries: 0,
    executionTimeouts: 0,
    validationErrors: 0,
    providerReconnections: 0,
    providerHealthCheckFailures: 0,
    simulationsPerformed: 0,
    simulationsSkipped: 0,
    simulationPredictedReverts: 0,
    simulationProfitabilityRejections: 0,
    simulationErrors: 0,
    circuitBreakerTrips: 0,
    circuitBreakerBlocks: 0,
    riskEVRejections: 0,
    riskPositionSizeRejections: 0,
    riskDrawdownBlocks: 0,
    riskCautionCount: 0,
    riskHaltCount: 0,
  };
}

// =============================================================================
// Strategy Context Mock
// =============================================================================

/**
 * Create a mock strategy context.
 */
export function createMockContext(
  overrides: Partial<StrategyContext> = {}
): StrategyContext {
  const providers = new Map<string, ethers.JsonRpcProvider>();
  providers.set('ethereum', createMockProvider());

  const wallets = new Map<string, ethers.Wallet>();
  wallets.set('ethereum', createMockWallet());

  return {
    logger: createMockLogger(),
    perfLogger: {
      startTimer: jest.fn(),
      endTimer: jest.fn().mockReturnValue(0),
      logEventLatency: jest.fn(),
      logArbitrageOpportunity: jest.fn(),
      logExecutionResult: jest.fn(),
      logError: jest.fn(),
      logHealthCheck: jest.fn(),
      logMetrics: jest.fn(),
    } as unknown as PerformanceLogger,
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
    stats: createMockStats(),
    simulationService: undefined,
    ...overrides,
  } as StrategyContext;
}

// =============================================================================
// Simulation Config Mock
// =============================================================================

/**
 * Create a resolved simulation config.
 */
export function createMockSimulationConfig(
  overrides: Partial<ResolvedSimulationConfig> = {}
): ResolvedSimulationConfig {
  return {
    enabled: true,
    successRate: 0.85,
    executionLatencyMs: 50, // Low for fast tests
    gasUsed: 200000,
    gasCostMultiplier: 0.1,
    profitVariance: 0.2,
    logSimulatedExecutions: false, // Quiet for tests
    ...overrides,
  };
}
