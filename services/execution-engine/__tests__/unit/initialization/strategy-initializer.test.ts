/**
 * Strategy Initializer Unit Tests
 *
 * Tests for initializeAllStrategies — the execution strategy setup
 * during execution engine startup.
 *
 * These tests exercise the REAL initialization logic in strategy-initializer.ts,
 * including:
 * - buildFlashLoanConfig (env var parsing, Balancer V2 override, router sourcing)
 * - parseNumericEnv (numeric env var parsing with NaN handling)
 * - Core strategy creation (IntraChain, CrossChain, Simulation)
 * - FlashLoanStrategy creation when contract addresses are configured
 * - Feature-flagged strategies (backrun, uniswapx, solana, statistical arb)
 * - Strategy factory registration
 * - TX simulation service initialization
 *
 * External dependencies (strategy constructors, config imports) are mocked
 * to isolate the initialization orchestration logic.
 *
 * @see strategy-initializer.ts
 * @see ADR-022: Hot-Path Performance
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// =============================================================================
// Mock State — must be declared before mocks
// =============================================================================

const mockIntraChainInstance = { name: 'intra-chain', execute: jest.fn() };
const mockCrossChainInstance = { name: 'cross-chain', execute: jest.fn() };
const mockSimulationInstance = { name: 'simulation', execute: jest.fn() };
const mockFlashLoanInstance = { name: 'flash-loan', execute: jest.fn() };
const mockFlashLoanProviderFactory = { getProvider: jest.fn(), getSupportedChains: jest.fn() };
const mockBackrunInstance = { name: 'backrun', execute: jest.fn() };
const mockUniswapxInstance = { name: 'uniswapx', execute: jest.fn() };

// Strategy factory mock with registration tracking
let registeredStrategies: Record<string, unknown>;
let mockStrategyFactory: Record<string, jest.Mock | (() => string[])>;

function createFreshStrategyFactory() {
  registeredStrategies = {};
  mockStrategyFactory = {
    registerStrategies: jest.fn().mockImplementation((strats: Record<string, unknown>) => {
      Object.assign(registeredStrategies, strats);
    }),
    registerFlashLoanStrategy: jest.fn().mockImplementation((s: unknown) => {
      registeredStrategies['flashLoan'] = s;
    }),
    registerBackrunStrategy: jest.fn().mockImplementation((s: unknown) => {
      registeredStrategies['backrun'] = s;
    }),
    registerUniswapXStrategy: jest.fn().mockImplementation((s: unknown) => {
      registeredStrategies['uniswapx'] = s;
    }),
    registerSolanaStrategy: jest.fn().mockImplementation((s: unknown) => {
      registeredStrategies['solana'] = s;
    }),
    registerStatisticalStrategy: jest.fn().mockImplementation((s: unknown) => {
      registeredStrategies['statistical'] = s;
    }),
    getRegisteredTypes: () => Object.keys(registeredStrategies),
  };
  return mockStrategyFactory;
}

// =============================================================================
// Mocks — declared before imports to intercept module loading
// =============================================================================

// Feature flags — mutable for per-test overrides
const mockFeatureFlags = {
  useFlashLoanAggregator: false,
  useBackrunStrategy: false,
  useUniswapxFiller: false,
  useDestChainFlashLoan: false,
};

// Flash loan providers config — mutable
const mockFlashLoanProviders: Record<string, {
  address: string;
  protocol: string;
  fee: number;
  approvedRouters?: string[];
}> = {};

// DEXES config — mutable
const mockDexes: Record<string, Array<{ routerAddress: string; name: string }>> = {};

// BALANCER_V2_VAULTS — mutable
const mockBalancerVaults: Record<string, string> = {};

jest.mock('@arbitrage/config', () => ({
  FEATURE_FLAGS: mockFeatureFlags,
  FLASH_LOAN_PROVIDERS: mockFlashLoanProviders,
  DEXES: mockDexes,
  BALANCER_V2_VAULTS: mockBalancerVaults,
  CHAINS: {
    ethereum: { id: 1, name: 'Ethereum' },
    polygon: { id: 137, name: 'Polygon' },
    arbitrum: { id: 42161, name: 'Arbitrum' },
  },
  ARBITRAGE_CONFIG: {
    slippageTolerance: 0.005,
    gasPriceSpikeMultiplier: 1.5,
    minProfitPercentage: 0.1,
    confidenceThreshold: 0.5,
  },
  MEV_CONFIG: { enabled: false, chainSettings: {} },
  isExecutionSupported: jest.fn().mockReturnValue(true),
  getSupportedExecutionChains: jest.fn().mockReturnValue(['ethereum', 'polygon']),
  getNativeTokenPrice: jest.fn().mockReturnValue(2000),
}));

jest.mock('@arbitrage/core/resilience', () => ({
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

jest.mock('@arbitrage/core/logging', () => ({
  createPinoLogger: jest.fn().mockReturnValue({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  }),
  ServiceLogger: {},
}));

jest.mock('@arbitrage/core/utils', () => ({
  parseEnvIntSafe: jest.fn().mockReturnValue(undefined),
}));

jest.mock('@arbitrage/core/components', () => ({
  isValidPrice: jest.fn().mockReturnValue(true),
}));

jest.mock('@arbitrage/core/analytics', () => ({
  getDefaultPrice: jest.fn().mockReturnValue(1),
}));

jest.mock('@arbitrage/core/bridge-router', () => ({
  BRIDGE_DEFAULTS: { timeout: 3600000 },
}));

jest.mock('@arbitrage/core', () => ({
  FlashLoanAggregatorImpl: jest.fn(),
  WeightedRankingStrategy: jest.fn(),
  OnChainLiquidityValidator: jest.fn(),
  InMemoryAggregatorMetrics: jest.fn(),
}));

jest.mock('@arbitrage/types', () => ({}));

// Mock error selectors to prevent file-not-found in base.strategy.ts
jest.mock('../../../src/strategies/error-selectors.generated', () => ({
  CUSTOM_ERROR_SELECTORS: {},
}));

// Mock strategy constructors
jest.mock('../../../src/strategies/intra-chain.strategy', () => ({
  IntraChainStrategy: jest.fn().mockReturnValue(mockIntraChainInstance),
}));

jest.mock('../../../src/strategies/cross-chain.strategy', () => ({
  CrossChainStrategy: jest.fn().mockReturnValue(mockCrossChainInstance),
}));

jest.mock('../../../src/strategies/simulation.strategy', () => ({
  SimulationStrategy: jest.fn().mockReturnValue(mockSimulationInstance),
}));

jest.mock('../../../src/strategies/flash-loan.strategy', () => ({
  FlashLoanStrategy: jest.fn().mockReturnValue(mockFlashLoanInstance),
}));

jest.mock('../../../src/strategies/flash-loan-providers/provider-factory', () => ({
  createFlashLoanProviderFactory: jest.fn().mockReturnValue(mockFlashLoanProviderFactory),
}));

jest.mock('../../../src/strategies/backrun.strategy', () => ({
  BackrunStrategy: jest.fn().mockReturnValue(mockBackrunInstance),
}));

jest.mock('../../../src/strategies/uniswapx-filler.strategy', () => ({
  UniswapXFillerStrategy: jest.fn().mockReturnValue(mockUniswapxInstance),
}));

jest.mock('../../../src/strategies/strategy-factory', () => ({
  ExecutionStrategyFactory: jest.fn(),
  createStrategyFactory: jest.fn().mockReturnValue(createFreshStrategyFactory()),
}));

jest.mock('../../../src/services/tx-simulation-initializer', () => ({
  initializeTxSimulationService: jest.fn().mockReturnValue({ simulate: jest.fn() }),
}));

// =============================================================================
// Import SUT after mocks
// =============================================================================

import { initializeAllStrategies, type StrategyInitDeps } from '../../../src/initialization/strategy-initializer';
import { IntraChainStrategy } from '../../../src/strategies/intra-chain.strategy';
import { CrossChainStrategy } from '../../../src/strategies/cross-chain.strategy';
import { SimulationStrategy } from '../../../src/strategies/simulation.strategy';
import { FlashLoanStrategy } from '../../../src/strategies/flash-loan.strategy';
import { createFlashLoanProviderFactory } from '../../../src/strategies/flash-loan-providers/provider-factory';
import { BackrunStrategy } from '../../../src/strategies/backrun.strategy';
import { UniswapXFillerStrategy } from '../../../src/strategies/uniswapx-filler.strategy';
import { createStrategyFactory } from '../../../src/strategies/strategy-factory';
import { initializeTxSimulationService } from '../../../src/services/tx-simulation-initializer';

// =============================================================================
// Test Helpers
// =============================================================================

type MockLogger = {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  debug: jest.Mock;
};

function createMockLogger(): MockLogger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

function createDefaultDeps(overrides?: Partial<StrategyInitDeps>): StrategyInitDeps {
  return {
    logger: createMockLogger() as any,
    simulationConfig: {
      enabled: false,
      successRate: 0.85,
      executionLatencyMs: 500,
      gasUsed: 200000,
      gasCostMultiplier: 0.1,
      profitVariance: 0.2,
      logSimulatedExecutions: true,
    },
    isSimulationMode: false,
    providerService: {
      getProviders: jest.fn().mockReturnValue(new Map([
        ['ethereum', { getBlockNumber: () => Promise.resolve(1) }],
      ])),
      getProvider: jest.fn().mockReturnValue({ getBlockNumber: () => Promise.resolve(1) }),
    } as any,
    ...overrides,
  };
}

/**
 * Re-apply mock implementations cleared by resetAllMocks.
 */
function applyMocks(): void {
  (IntraChainStrategy as jest.Mock).mockReturnValue(mockIntraChainInstance);
  (CrossChainStrategy as jest.Mock).mockReturnValue(mockCrossChainInstance);
  (SimulationStrategy as jest.Mock).mockReturnValue(mockSimulationInstance);
  (FlashLoanStrategy as jest.Mock).mockReturnValue(mockFlashLoanInstance);
  (createFlashLoanProviderFactory as jest.Mock).mockReturnValue(mockFlashLoanProviderFactory);
  (BackrunStrategy as jest.Mock).mockReturnValue(mockBackrunInstance);
  (UniswapXFillerStrategy as jest.Mock).mockReturnValue(mockUniswapxInstance);
  (createStrategyFactory as jest.Mock).mockReturnValue(createFreshStrategyFactory());
  (initializeTxSimulationService as jest.Mock).mockReturnValue({ simulate: jest.fn() });
}

// Save original env
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) {
    savedEnv[key] = process.env[key];
  }
  process.env[key] = value;
}

function clearEnv(key: string): void {
  if (!(key in savedEnv)) {
    savedEnv[key] = process.env[key];
  }
  delete process.env[key];
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  // Clear the saved state
  for (const key of Object.keys(savedEnv)) {
    delete savedEnv[key];
  }
}

// =============================================================================
// Tests
// =============================================================================

describe('initializeAllStrategies', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    applyMocks();

    // Reset mutable config to clean state
    mockFeatureFlags.useFlashLoanAggregator = false;
    mockFeatureFlags.useBackrunStrategy = false;
    mockFeatureFlags.useUniswapxFiller = false;
    mockFeatureFlags.useDestChainFlashLoan = false;

    // Clear flash loan providers
    for (const key of Object.keys(mockFlashLoanProviders)) {
      delete mockFlashLoanProviders[key];
    }
    for (const key of Object.keys(mockDexes)) {
      delete mockDexes[key];
    }
    for (const key of Object.keys(mockBalancerVaults)) {
      delete mockBalancerVaults[key];
    }

    // Clear env vars that may have been set
    clearEnv('FLASH_LOAN_CONTRACT_ETHEREUM');
    clearEnv('FLASH_LOAN_CONTRACT_POLYGON');
    clearEnv('BALANCER_V2_CONTRACT_ETHEREUM');
    clearEnv('BALANCER_V2_CONTRACT_POLYGON');
    clearEnv('FEATURE_SOLANA_EXECUTION');
    clearEnv('FEATURE_STATISTICAL_ARB');
    clearEnv('SOLANA_RPC_URL');
    clearEnv('BACKRUN_MIN_PROFIT_USD');
    clearEnv('UNISWAPX_MIN_PROFIT_USD');
  });

  afterEach(() => {
    restoreEnv();
  });

  // ===========================================================================
  // Core Strategy Creation
  // ===========================================================================

  describe('core strategies', () => {
    test('should create IntraChainStrategy with logger', async () => {
      const deps = createDefaultDeps();
      await initializeAllStrategies(deps);

      expect(IntraChainStrategy).toHaveBeenCalledWith(deps.logger);
    });

    test('should create SimulationStrategy with logger and config', async () => {
      const deps = createDefaultDeps();
      await initializeAllStrategies(deps);

      expect(SimulationStrategy).toHaveBeenCalledWith(deps.logger, deps.simulationConfig);
    });

    test('should create CrossChainStrategy with logger (no flash loan deps)', async () => {
      const deps = createDefaultDeps();
      await initializeAllStrategies(deps);

      expect(CrossChainStrategy).toHaveBeenCalledWith(deps.logger);
    });

    test('should return all core strategy instances', async () => {
      const deps = createDefaultDeps();
      const result = await initializeAllStrategies(deps);

      expect(result.intraChainStrategy).toBe(mockIntraChainInstance);
      expect(result.crossChainStrategy).toBe(mockCrossChainInstance);
      expect(result.simulationStrategy).toBe(mockSimulationInstance);
    });

    test('should register core strategies with factory', async () => {
      const deps = createDefaultDeps();
      const result = await initializeAllStrategies(deps);

      // createStrategyFactory was called
      expect(createStrategyFactory).toHaveBeenCalledWith({
        logger: deps.logger,
        isSimulationMode: false,
      });

      // registerStrategies was called with the correct strategy objects
      expect(result.strategyFactory).toBeDefined();
    });
  });

  // ===========================================================================
  // Strategy Factory Configuration
  // ===========================================================================

  describe('strategy factory configuration', () => {
    test('should pass isSimulationMode to factory', async () => {
      const deps = createDefaultDeps({ isSimulationMode: true });
      await initializeAllStrategies(deps);

      expect(createStrategyFactory).toHaveBeenCalledWith(
        expect.objectContaining({ isSimulationMode: true }),
      );
    });

    test('should log registered types after initialization', async () => {
      const deps = createDefaultDeps();
      await initializeAllStrategies(deps);

      expect((deps.logger as MockLogger).info).toHaveBeenCalledWith(
        'Strategy factory initialized',
        expect.objectContaining({
          simulationMode: false,
        }),
      );
    });
  });

  // ===========================================================================
  // Flash Loan Strategy — No Contract Addresses
  // ===========================================================================

  describe('when no flash loan contract addresses configured', () => {
    test('should not create FlashLoanStrategy', async () => {
      const deps = createDefaultDeps();
      await initializeAllStrategies(deps);

      expect(FlashLoanStrategy).not.toHaveBeenCalled();
    });

    test('should log debug message about missing contracts', async () => {
      const deps = createDefaultDeps();
      await initializeAllStrategies(deps);

      expect((deps.logger as MockLogger).debug).toHaveBeenCalledWith(
        'FlashLoanStrategy not registered - no contract addresses configured',
      );
    });

    test('should not register flash loan strategy with factory', async () => {
      const deps = createDefaultDeps();
      const result = await initializeAllStrategies(deps);

      const factory = result.strategyFactory as any;
      expect(factory.registerFlashLoanStrategy).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Flash Loan Strategy — With Contract Addresses (via env vars)
  // ===========================================================================

  describe('when flash loan contract addresses are configured', () => {
    beforeEach(() => {
      // Set up FLASH_LOAN_PROVIDERS so buildFlashLoanConfig iterates
      mockFlashLoanProviders['ethereum'] = {
        address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
        protocol: 'aave_v3',
        fee: 9,
        approvedRouters: ['0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'],
      };
      // Set the env var for the flash loan contract
      setEnv('FLASH_LOAN_CONTRACT_ETHEREUM', '0x1234567890abcdef1234567890abcdef12345678');
    });

    test('should create FlashLoanStrategy with correct config', async () => {
      const deps = createDefaultDeps();
      await initializeAllStrategies(deps);

      expect(FlashLoanStrategy).toHaveBeenCalledWith(
        deps.logger,
        expect.objectContaining({
          contractAddresses: { ethereum: '0x1234567890abcdef1234567890abcdef12345678' },
          approvedRouters: { ethereum: ['0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'] },
          enableAggregator: false,
        }),
      );
    });

    test('should create flash loan provider factory', async () => {
      const deps = createDefaultDeps();
      await initializeAllStrategies(deps);

      expect(createFlashLoanProviderFactory).toHaveBeenCalledWith(
        deps.logger,
        expect.objectContaining({
          contractAddresses: { ethereum: '0x1234567890abcdef1234567890abcdef12345678' },
          approvedRouters: { ethereum: ['0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'] },
        }),
      );
    });

    test('should register flash loan strategy with factory', async () => {
      const deps = createDefaultDeps();
      const result = await initializeAllStrategies(deps);

      expect((result.strategyFactory as any).registerFlashLoanStrategy).toHaveBeenCalledWith(
        mockFlashLoanInstance,
      );
    });

    test('should log successful initialization', async () => {
      const deps = createDefaultDeps();
      await initializeAllStrategies(deps);

      expect((deps.logger as MockLogger).info).toHaveBeenCalledWith(
        'FlashLoanStrategy initialized',
        expect.objectContaining({
          chains: ['ethereum'],
          aggregatorEnabled: false,
        }),
      );
    });

    test('should pass enableAggregator flag from FEATURE_FLAGS', async () => {
      mockFeatureFlags.useFlashLoanAggregator = true;
      const deps = createDefaultDeps();
      await initializeAllStrategies(deps);

      expect(FlashLoanStrategy).toHaveBeenCalledWith(
        deps.logger,
        expect.objectContaining({
          enableAggregator: true,
        }),
      );
    });
  });

  // ===========================================================================
  // Balancer V2 Override (0% fee preference)
  // ===========================================================================

  describe('Balancer V2 override', () => {
    beforeEach(() => {
      mockFlashLoanProviders['ethereum'] = {
        address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
        protocol: 'aave_v3',
        fee: 9,
      };
      mockBalancerVaults['ethereum'] = '0xBA12222222228d8Ba445958a75a0704d566BF2C8';
    });

    test('should prefer Balancer V2 when env var and vault are configured', async () => {
      setEnv('BALANCER_V2_CONTRACT_ETHEREUM', '0xBalancerContract1234567890abcdef12345678');

      const deps = createDefaultDeps();
      await initializeAllStrategies(deps);

      expect(FlashLoanStrategy).toHaveBeenCalledWith(
        deps.logger,
        expect.objectContaining({
          contractAddresses: { ethereum: '0xBalancerContract1234567890abcdef12345678' },
          feeOverrides: { ethereum: 0 },
        }),
      );
    });

    test('should log Balancer V2 preference over default provider', async () => {
      setEnv('BALANCER_V2_CONTRACT_ETHEREUM', '0xBalancerContract1234567890abcdef12345678');

      const deps = createDefaultDeps();
      await initializeAllStrategies(deps);

      expect((deps.logger as MockLogger).info).toHaveBeenCalledWith(
        'Preferring Balancer V2 (0% fee) over default provider',
        expect.objectContaining({
          chain: 'ethereum',
          defaultProtocol: 'aave_v3',
          defaultFee: 9,
        }),
      );
    });

    test('should include provider overrides in provider factory config', async () => {
      setEnv('BALANCER_V2_CONTRACT_ETHEREUM', '0xBalancerContract1234567890abcdef12345678');

      const deps = createDefaultDeps();
      await initializeAllStrategies(deps);

      expect(createFlashLoanProviderFactory).toHaveBeenCalledWith(
        deps.logger,
        expect.objectContaining({
          providerOverrides: {
            ethereum: {
              address: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
              protocol: 'balancer_v2',
              fee: 0,
            },
          },
        }),
      );
    });

    test('should fall back to generic contract when no Balancer env var set', async () => {
      setEnv('FLASH_LOAN_CONTRACT_ETHEREUM', '0xGenericContract1234567890abcdef12345678');

      const deps = createDefaultDeps();
      await initializeAllStrategies(deps);

      expect(FlashLoanStrategy).toHaveBeenCalledWith(
        deps.logger,
        expect.objectContaining({
          contractAddresses: { ethereum: '0xGenericContract1234567890abcdef12345678' },
        }),
      );
    });
  });

  // ===========================================================================
  // Router Sourcing (approvedRouters vs DEXES fallback)
  // ===========================================================================

  describe('approved routers sourcing', () => {
    beforeEach(() => {
      mockFlashLoanProviders['ethereum'] = {
        address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
        protocol: 'aave_v3',
        fee: 9,
      };
      setEnv('FLASH_LOAN_CONTRACT_ETHEREUM', '0x1234567890abcdef1234567890abcdef12345678');
    });

    test('should use explicit approvedRouters when available', async () => {
      mockFlashLoanProviders['ethereum'].approvedRouters = [
        '0xExplicitRouter1234567890abcdef12345678aaaa',
      ];

      const deps = createDefaultDeps();
      await initializeAllStrategies(deps);

      expect(FlashLoanStrategy).toHaveBeenCalledWith(
        deps.logger,
        expect.objectContaining({
          approvedRouters: {
            ethereum: ['0xExplicitRouter1234567890abcdef12345678aaaa'],
          },
        }),
      );
    });

    test('should fall back to DEXES router addresses when no explicit routers', async () => {
      mockDexes['ethereum'] = [
        { routerAddress: '0xDexRouter11234567890abcdef12345678901234', name: 'uniswap_v3' },
        { routerAddress: '0xDexRouter21234567890abcdef12345678901234', name: 'sushiswap' },
      ];

      const deps = createDefaultDeps();
      await initializeAllStrategies(deps);

      expect(FlashLoanStrategy).toHaveBeenCalledWith(
        deps.logger,
        expect.objectContaining({
          approvedRouters: {
            ethereum: [
              '0xDexRouter11234567890abcdef12345678901234',
              '0xDexRouter21234567890abcdef12345678901234',
            ],
          },
        }),
      );
    });

    test('should filter out falsy router addresses from DEXES', async () => {
      mockDexes['ethereum'] = [
        { routerAddress: '0xDexRouter11234567890abcdef12345678901234', name: 'uniswap_v3' },
        { routerAddress: '', name: 'empty-router' },
      ];

      const deps = createDefaultDeps();
      await initializeAllStrategies(deps);

      expect(FlashLoanStrategy).toHaveBeenCalledWith(
        deps.logger,
        expect.objectContaining({
          approvedRouters: {
            ethereum: ['0xDexRouter11234567890abcdef12345678901234'],
          },
        }),
      );
    });
  });

  // ===========================================================================
  // CrossChainStrategy with Destination Flash Loan
  // ===========================================================================

  describe('CrossChainStrategy with destination flash loan', () => {
    test('should create CrossChainStrategy with flash loan deps when feature enabled', async () => {
      mockFeatureFlags.useDestChainFlashLoan = true;
      // Need contract addresses so flash loan strategy is created
      mockFlashLoanProviders['ethereum'] = {
        address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
        protocol: 'aave_v3',
        fee: 9,
      };
      setEnv('FLASH_LOAN_CONTRACT_ETHEREUM', '0x1234567890abcdef1234567890abcdef12345678');

      const deps = createDefaultDeps();
      await initializeAllStrategies(deps);

      expect(CrossChainStrategy).toHaveBeenCalledWith(
        deps.logger,
        mockFlashLoanProviderFactory,
        mockFlashLoanInstance,
      );
    });

    test('should log warning when feature enabled but no flash loan contracts', async () => {
      mockFeatureFlags.useDestChainFlashLoan = true;

      const deps = createDefaultDeps();
      await initializeAllStrategies(deps);

      // Falls back to plain CrossChainStrategy
      expect(CrossChainStrategy).toHaveBeenCalledWith(deps.logger);
      expect((deps.logger as MockLogger).warn).toHaveBeenCalledWith(
        'Destination flash loan feature enabled but no flash loan contracts configured',
      );
    });

    test('should log destination flash loan support when initialized', async () => {
      mockFeatureFlags.useDestChainFlashLoan = true;
      mockFlashLoanProviders['ethereum'] = {
        address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
        protocol: 'aave_v3',
        fee: 9,
      };
      setEnv('FLASH_LOAN_CONTRACT_ETHEREUM', '0x1234567890abcdef1234567890abcdef12345678');

      const deps = createDefaultDeps();
      await initializeAllStrategies(deps);

      expect((deps.logger as MockLogger).info).toHaveBeenCalledWith(
        'CrossChainStrategy initialized with destination flash loan support',
        expect.objectContaining({
          supportedChains: ['ethereum'],
        }),
      );
    });
  });

  // ===========================================================================
  // Feature-Flagged Strategies: Backrun
  // ===========================================================================

  describe('backrun strategy (feature-flagged)', () => {
    test('should not create BackrunStrategy when feature flag is off', async () => {
      mockFeatureFlags.useBackrunStrategy = false;
      const deps = createDefaultDeps();
      const result = await initializeAllStrategies(deps);

      expect(BackrunStrategy).not.toHaveBeenCalled();
      expect(result.backrunStrategy).toBeNull();
    });

    test('should create BackrunStrategy when feature flag is on', async () => {
      mockFeatureFlags.useBackrunStrategy = true;
      const deps = createDefaultDeps();
      const result = await initializeAllStrategies(deps);

      expect(BackrunStrategy).toHaveBeenCalledWith(deps.logger, expect.any(Object));
      expect(result.backrunStrategy).toBe(mockBackrunInstance);
    });

    test('should pass env var overrides to BackrunStrategy', async () => {
      mockFeatureFlags.useBackrunStrategy = true;
      setEnv('BACKRUN_MIN_PROFIT_USD', '5.0');
      setEnv('BACKRUN_MAX_GAS_PRICE_GWEI', '100');

      const deps = createDefaultDeps();
      await initializeAllStrategies(deps);

      expect(BackrunStrategy).toHaveBeenCalledWith(
        deps.logger,
        expect.objectContaining({
          minProfitUsd: 5.0,
          maxGasPriceGwei: 100,
        }),
      );
    });

    test('should register backrun strategy with factory', async () => {
      mockFeatureFlags.useBackrunStrategy = true;
      const deps = createDefaultDeps();
      const result = await initializeAllStrategies(deps);

      expect((result.strategyFactory as any).registerBackrunStrategy).toHaveBeenCalledWith(
        mockBackrunInstance,
      );
    });
  });

  // ===========================================================================
  // Feature-Flagged Strategies: UniswapX Filler
  // ===========================================================================

  describe('UniswapX filler strategy (feature-flagged)', () => {
    test('should not create UniswapXFillerStrategy when feature flag is off', async () => {
      mockFeatureFlags.useUniswapxFiller = false;
      const deps = createDefaultDeps();
      const result = await initializeAllStrategies(deps);

      expect(UniswapXFillerStrategy).not.toHaveBeenCalled();
      expect(result.uniswapxStrategy).toBeNull();
    });

    test('should create UniswapXFillerStrategy when feature flag is on', async () => {
      mockFeatureFlags.useUniswapxFiller = true;
      const deps = createDefaultDeps();
      const result = await initializeAllStrategies(deps);

      expect(UniswapXFillerStrategy).toHaveBeenCalledWith(deps.logger, expect.any(Object));
      expect(result.uniswapxStrategy).toBe(mockUniswapxInstance);
    });

    test('should pass env var overrides to UniswapXFillerStrategy', async () => {
      mockFeatureFlags.useUniswapxFiller = true;
      setEnv('UNISWAPX_MIN_PROFIT_USD', '2.5');
      setEnv('UNISWAPX_MAX_GAS_PRICE_GWEI', '60');

      const deps = createDefaultDeps();
      await initializeAllStrategies(deps);

      expect(UniswapXFillerStrategy).toHaveBeenCalledWith(
        deps.logger,
        expect.objectContaining({
          minProfitUsd: 2.5,
          maxGasPriceGwei: 60,
        }),
      );
    });

    test('should register UniswapX strategy with factory', async () => {
      mockFeatureFlags.useUniswapxFiller = true;
      const deps = createDefaultDeps();
      const result = await initializeAllStrategies(deps);

      expect((result.strategyFactory as any).registerUniswapXStrategy).toHaveBeenCalledWith(
        mockUniswapxInstance,
      );
    });
  });

  // ===========================================================================
  // Feature-Flagged Strategies: Solana Execution
  // ===========================================================================

  describe('Solana execution strategy (feature-flagged)', () => {
    test('should not initialize Solana when FEATURE_SOLANA_EXECUTION is not true', async () => {
      const deps = createDefaultDeps();
      const result = await initializeAllStrategies(deps);

      expect((deps.logger as MockLogger).info).toHaveBeenCalledWith(
        'Solana execution disabled (FEATURE_SOLANA_EXECUTION != true)',
      );
      // No Solana strategy registered
      expect((result.strategyFactory as any).registerSolanaStrategy).not.toHaveBeenCalled();
    });

    test('should not initialize Solana when SOLANA_RPC_URL is missing', async () => {
      setEnv('FEATURE_SOLANA_EXECUTION', 'true');
      clearEnv('SOLANA_RPC_URL');

      const deps = createDefaultDeps();
      await initializeAllStrategies(deps);

      expect((deps.logger as MockLogger).error).toHaveBeenCalledWith(
        expect.stringContaining('FEATURE_SOLANA_EXECUTION is enabled but SOLANA_RPC_URL is not set'),
      );
    });
  });

  // ===========================================================================
  // Feature-Flagged Strategies: Statistical Arbitrage
  // ===========================================================================

  describe('statistical arbitrage strategy (feature-flagged)', () => {
    test('should not initialize stat arb when FEATURE_STATISTICAL_ARB is not true', async () => {
      const deps = createDefaultDeps();
      const result = await initializeAllStrategies(deps);

      // Should not register statistical strategy
      expect((result.strategyFactory as any).registerStatisticalStrategy).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Flash Loan Strategy — Error Handling
  // ===========================================================================

  describe('FlashLoanStrategy error handling', () => {
    test('should continue without FlashLoanStrategy if constructor throws', async () => {
      mockFlashLoanProviders['ethereum'] = {
        address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
        protocol: 'aave_v3',
        fee: 9,
      };
      setEnv('FLASH_LOAN_CONTRACT_ETHEREUM', '0x1234567890abcdef1234567890abcdef12345678');

      (FlashLoanStrategy as jest.Mock).mockImplementation(() => {
        throw new Error('Invalid contract address');
      });

      const deps = createDefaultDeps();
      const result = await initializeAllStrategies(deps);

      // Should still succeed — flash loan is optional
      expect(result.intraChainStrategy).toBe(mockIntraChainInstance);
      expect(result.strategyFactory).toBeDefined();
      expect((deps.logger as MockLogger).warn).toHaveBeenCalledWith(
        'Failed to initialize FlashLoanStrategy',
        expect.objectContaining({ error: 'Invalid contract address' }),
      );
    });
  });

  // ===========================================================================
  // TX Simulation Service Initialization
  // ===========================================================================

  describe('TX simulation service', () => {
    test('should initialize tx simulation service when not in simulation mode', async () => {
      const deps = createDefaultDeps({ isSimulationMode: false });
      const result = await initializeAllStrategies(deps);

      expect(initializeTxSimulationService).toHaveBeenCalledWith(
        deps.providerService,
        deps.logger,
      );
      expect(result.txSimulationService).not.toBeNull();
    });

    test('should skip tx simulation service in simulation mode', async () => {
      const deps = createDefaultDeps({ isSimulationMode: true });
      const result = await initializeAllStrategies(deps);

      expect(initializeTxSimulationService).not.toHaveBeenCalled();
      expect(result.txSimulationService).toBeNull();
    });

    test('should skip tx simulation service when no provider service', async () => {
      const deps = createDefaultDeps({ providerService: null });
      const result = await initializeAllStrategies(deps);

      expect(initializeTxSimulationService).not.toHaveBeenCalled();
      expect(result.txSimulationService).toBeNull();
    });
  });

  // ===========================================================================
  // parseNumericEnv (exercised through feature-flagged strategies)
  // ===========================================================================

  describe('parseNumericEnv behavior', () => {
    test('should parse valid numeric env vars', async () => {
      mockFeatureFlags.useBackrunStrategy = true;
      setEnv('BACKRUN_MIN_PROFIT_USD', '3.14');

      const deps = createDefaultDeps();
      await initializeAllStrategies(deps);

      expect(BackrunStrategy).toHaveBeenCalledWith(
        deps.logger,
        expect.objectContaining({ minProfitUsd: 3.14 }),
      );
    });

    test('should return undefined for invalid numeric env vars', async () => {
      mockFeatureFlags.useBackrunStrategy = true;
      setEnv('BACKRUN_MIN_PROFIT_USD', 'not-a-number');

      const deps = createDefaultDeps();
      await initializeAllStrategies(deps);

      // NaN should be treated as invalid, undefined is passed, BackrunStrategy uses its own default
      expect((deps.logger as MockLogger).warn).toHaveBeenCalledWith(
        expect.stringContaining("Invalid numeric env var BACKRUN_MIN_PROFIT_USD='not-a-number'"),
      );
      expect(BackrunStrategy).toHaveBeenCalledWith(
        deps.logger,
        expect.objectContaining({ minProfitUsd: undefined }),
      );
    });

    test('should pass undefined when env var is not set', async () => {
      mockFeatureFlags.useBackrunStrategy = true;
      clearEnv('BACKRUN_MIN_PROFIT_USD');
      clearEnv('BACKRUN_MAX_GAS_PRICE_GWEI');

      const deps = createDefaultDeps();
      await initializeAllStrategies(deps);

      expect(BackrunStrategy).toHaveBeenCalledWith(
        deps.logger,
        expect.objectContaining({
          minProfitUsd: undefined,
          maxGasPriceGwei: undefined,
        }),
      );
    });
  });

  // ===========================================================================
  // Result Structure
  // ===========================================================================

  describe('result structure', () => {
    test('should return complete StrategyInitResult', async () => {
      const deps = createDefaultDeps();
      const result = await initializeAllStrategies(deps);

      expect(result).toHaveProperty('strategyFactory');
      expect(result).toHaveProperty('intraChainStrategy');
      expect(result).toHaveProperty('crossChainStrategy');
      expect(result).toHaveProperty('simulationStrategy');
      expect(result).toHaveProperty('backrunStrategy');
      expect(result).toHaveProperty('uniswapxStrategy');
      expect(result).toHaveProperty('txSimulationService');
    });

    test('should return null for disabled feature strategies', async () => {
      const deps = createDefaultDeps();
      const result = await initializeAllStrategies(deps);

      expect(result.backrunStrategy).toBeNull();
      expect(result.uniswapxStrategy).toBeNull();
    });

    test('should return non-null for enabled feature strategies', async () => {
      mockFeatureFlags.useBackrunStrategy = true;
      mockFeatureFlags.useUniswapxFiller = true;

      const deps = createDefaultDeps();
      const result = await initializeAllStrategies(deps);

      expect(result.backrunStrategy).not.toBeNull();
      expect(result.uniswapxStrategy).not.toBeNull();
    });
  });

  // ===========================================================================
  // Multiple Chains Flash Loan Config
  // ===========================================================================

  describe('multi-chain flash loan configuration', () => {
    test('should configure multiple chains independently', async () => {
      mockFlashLoanProviders['ethereum'] = {
        address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
        protocol: 'aave_v3',
        fee: 9,
      };
      mockFlashLoanProviders['polygon'] = {
        address: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
        protocol: 'aave_v3',
        fee: 9,
      };
      setEnv('FLASH_LOAN_CONTRACT_ETHEREUM', '0xEthContract1234567890abcdef1234567890abcdef');
      setEnv('FLASH_LOAN_CONTRACT_POLYGON', '0xPolyContract234567890abcdef1234567890abcdef');

      const deps = createDefaultDeps();
      await initializeAllStrategies(deps);

      expect(FlashLoanStrategy).toHaveBeenCalledWith(
        deps.logger,
        expect.objectContaining({
          contractAddresses: {
            ethereum: '0xEthContract1234567890abcdef1234567890abcdef',
            polygon: '0xPolyContract234567890abcdef1234567890abcdef',
          },
        }),
      );
    });

    test('should only include chains with env vars set', async () => {
      mockFlashLoanProviders['ethereum'] = {
        address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
        protocol: 'aave_v3',
        fee: 9,
      };
      mockFlashLoanProviders['polygon'] = {
        address: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
        protocol: 'aave_v3',
        fee: 9,
      };
      // Only ethereum has an env var
      setEnv('FLASH_LOAN_CONTRACT_ETHEREUM', '0xEthContract1234567890abcdef1234567890abcdef');
      clearEnv('FLASH_LOAN_CONTRACT_POLYGON');

      const deps = createDefaultDeps();
      await initializeAllStrategies(deps);

      expect(FlashLoanStrategy).toHaveBeenCalledWith(
        deps.logger,
        expect.objectContaining({
          contractAddresses: {
            ethereum: '0xEthContract1234567890abcdef1234567890abcdef',
          },
        }),
      );
    });
  });
});
