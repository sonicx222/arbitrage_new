/**
 * Flash Loan Strategy Tests
 *
 * Tests for the FlashLoanStrategy that integrates with FlashLoanArbitrage.sol
 * Task 3.1.2: Contract Integration
 *
 * @see implementation_plan_v2.md Task 3.1.2
 */

// Mock the @arbitrage/config module before importing the strategy
jest.mock('@arbitrage/config', () => ({
  ...jest.requireActual('@arbitrage/config'),
  getNativeTokenPrice: jest.fn().mockReturnValue(2000), // Mock ETH price at $2000
}));

import { ethers } from 'ethers';
import { getNativeTokenPrice } from '@arbitrage/config';
import { FlashLoanStrategy, FlashLoanStrategyConfig } from './flash-loan.strategy';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type { StrategyContext, Logger, ExecutionStats, ProviderHealth } from '../types';
import { createInitialStats } from '../types';

// =============================================================================
// Mocks
// =============================================================================

const createMockLogger = (): Logger => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
});

const createMockProvider = (): jest.Mocked<ethers.JsonRpcProvider> => {
  const provider = {
    getFeeData: jest.fn().mockResolvedValue({
      gasPrice: ethers.parseUnits('30', 'gwei'),
      maxFeePerGas: ethers.parseUnits('35', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('1.5', 'gwei'),
    }),
    getNetwork: jest.fn().mockResolvedValue({ chainId: 1n }),
    estimateGas: jest.fn().mockResolvedValue(300000n),
    getTransactionReceipt: jest.fn().mockResolvedValue({
      hash: '0xmocktxhash',
      status: 1,
      gasUsed: 250000n,
      gasPrice: ethers.parseUnits('30', 'gwei'),
    }),
    call: jest.fn(),
  } as unknown as jest.Mocked<ethers.JsonRpcProvider>;
  return provider;
};

const createMockWallet = (provider?: ethers.JsonRpcProvider): jest.Mocked<ethers.Wallet> => {
  const wallet = {
    getAddress: jest.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
    sendTransaction: jest.fn().mockResolvedValue({
      hash: '0xmocktxhash',
      wait: jest.fn().mockResolvedValue({
        hash: '0xmocktxhash',
        status: 1,
        gasUsed: 250000n,
        gasPrice: ethers.parseUnits('30', 'gwei'),
      }),
    }),
    provider: provider,
  } as unknown as jest.Mocked<ethers.Wallet>;
  return wallet;
};

const createMockOpportunity = (overrides?: Partial<ArbitrageOpportunity>): ArbitrageOpportunity => ({
  id: 'test-opp-001',
  type: 'cross-dex',
  tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
  tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
  amountIn: ethers.parseEther('10').toString(),
  expectedProfit: 100, // $100 profit
  timestamp: Date.now(),
  buyChain: 'ethereum',
  sellChain: 'ethereum',
  buyDex: 'uniswap',
  sellDex: 'sushiswap',
  confidence: 0.95,
  buyPrice: 2000,
  sellPrice: 2010,
  ...overrides,
});

const createMockContext = (overrides?: Partial<StrategyContext>): StrategyContext => {
  const mockProvider = createMockProvider();
  const mockWallet = createMockWallet(mockProvider);

  return {
    logger: createMockLogger(),
    perfLogger: {
      start: jest.fn().mockReturnValue({ stop: jest.fn() }),
      measure: jest.fn(),
    } as any,
    providers: new Map([['ethereum', mockProvider]]),
    wallets: new Map([['ethereum', mockWallet]]),
    providerHealth: new Map<string, ProviderHealth>([
      ['ethereum', { healthy: true, lastCheck: Date.now(), consecutiveFailures: 0 }]
    ]),
    nonceManager: null,
    mevProviderFactory: null,
    bridgeRouterFactory: null,
    stateManager: {
      isRunning: jest.fn().mockReturnValue(true),
    } as any,
    gasBaselines: new Map(),
    stats: createInitialStats(),
    ...overrides,
  };
};

// =============================================================================
// Test Constants
// =============================================================================

const MOCK_FLASH_LOAN_CONTRACT_ADDRESS = '0x1234567890123456789012345678901234567890';
const MOCK_AAVE_POOL_ADDRESS = '0x87870BcD2C4C2e84a8c3C3a3fcACc94666C0d6CF';
const MOCK_ROUTER_ADDRESS = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';

// =============================================================================
// Tests
// =============================================================================

describe('FlashLoanStrategy', () => {
  let strategy: FlashLoanStrategy;
  let mockLogger: Logger;
  let defaultConfig: FlashLoanStrategyConfig;

  beforeEach(() => {
    // Reset the getNativeTokenPrice mock before each test
    (getNativeTokenPrice as jest.Mock).mockReturnValue(2000);

    mockLogger = createMockLogger();
    // Note: aavePoolAddresses removed - now uses FLASH_LOAN_PROVIDERS from @arbitrage/config
    defaultConfig = {
      contractAddresses: {
        ethereum: MOCK_FLASH_LOAN_CONTRACT_ADDRESS,
      },
      approvedRouters: {
        ethereum: [MOCK_ROUTER_ADDRESS],
      },
    };
    strategy = new FlashLoanStrategy(mockLogger, defaultConfig);
  });

  // ===========================================================================
  // Constructor & Configuration
  // ===========================================================================

  describe('constructor', () => {
    it('should create strategy with valid config', () => {
      expect(strategy).toBeDefined();
      expect(strategy).toBeInstanceOf(FlashLoanStrategy);
    });

    it('should throw if no contract addresses provided', () => {
      expect(() => new FlashLoanStrategy(mockLogger, {
        contractAddresses: {},
        approvedRouters: { ethereum: [MOCK_ROUTER_ADDRESS] },
      })).toThrow('At least one contract address must be configured');
    });
  });

  // ===========================================================================
  // Flash Loan Fee Calculation
  // ===========================================================================

  describe('calculateFlashLoanFee', () => {
    it('should calculate Aave V3 fee correctly (0.09%)', () => {
      const amount = ethers.parseEther('100');
      const fee = strategy.calculateFlashLoanFee(amount, 'ethereum');

      // 100 ETH * 0.09% = 0.09 ETH = 9e16 wei
      const expectedFee = amount * 9n / 10000n;
      expect(fee).toBe(expectedFee);
    });

    it('should use default fee for unknown chains', () => {
      const amount = ethers.parseEther('100');
      const fee = strategy.calculateFlashLoanFee(amount, 'unknown-chain');

      // Default is Aave V3 fee (0.09%)
      const expectedFee = amount * 9n / 10000n;
      expect(fee).toBe(expectedFee);
    });

    it('should handle small amounts correctly', () => {
      const amount = ethers.parseUnits('1', 6); // 1 USDC (6 decimals)
      const fee = strategy.calculateFlashLoanFee(amount, 'ethereum');

      // 1 USDC * 0.09% = 0.0009 USDC = 900 units
      const expectedFee = amount * 9n / 10000n;
      expect(fee).toBe(expectedFee);
    });

    it('should handle large amounts without overflow', () => {
      const amount = ethers.parseEther('1000000'); // 1M ETH
      const fee = strategy.calculateFlashLoanFee(amount, 'ethereum');

      // 1M ETH * 0.09% = 900 ETH
      const expectedFee = amount * 9n / 10000n;
      expect(fee).toBe(expectedFee);
    });
  });

  // ===========================================================================
  // Profitability Analysis
  // ===========================================================================

  describe('analyzeProfitability', () => {
    it('should return profitable when expected profit > fees + gas', () => {
      const analysis = strategy.analyzeProfitability({
        expectedProfitUsd: 100,
        flashLoanAmountWei: ethers.parseEther('10'),
        estimatedGasUnits: 300000n,
        gasPriceWei: ethers.parseUnits('30', 'gwei'),
        chain: 'ethereum',
        ethPriceUsd: 2000,
      });

      expect(analysis.isProfitable).toBe(true);
      expect(analysis.netProfitUsd).toBeGreaterThan(0);
      expect(analysis.flashLoanFeeUsd).toBeGreaterThan(0);
      expect(analysis.gasCostUsd).toBeGreaterThan(0);
    });

    it('should return unprofitable when fees exceed expected profit', () => {
      const analysis = strategy.analyzeProfitability({
        expectedProfitUsd: 5, // Very small profit
        flashLoanAmountWei: ethers.parseEther('1000'), // Large loan = large fee
        estimatedGasUnits: 500000n, // High gas
        gasPriceWei: ethers.parseUnits('100', 'gwei'), // High gas price
        chain: 'ethereum',
        ethPriceUsd: 2000,
      });

      expect(analysis.isProfitable).toBe(false);
      expect(analysis.netProfitUsd).toBeLessThan(0);
    });

    it('should correctly calculate flash loan fee in USD', () => {
      const analysis = strategy.analyzeProfitability({
        expectedProfitUsd: 100,
        flashLoanAmountWei: ethers.parseEther('10'), // 10 ETH
        estimatedGasUnits: 300000n,
        gasPriceWei: ethers.parseUnits('30', 'gwei'),
        chain: 'ethereum',
        ethPriceUsd: 2000,
      });

      // 10 ETH * 0.09% = 0.009 ETH = $18 at $2000/ETH
      expect(analysis.flashLoanFeeUsd).toBeCloseTo(18, 1);
    });

    it('should compare flash loan vs direct execution profitability', () => {
      const analysis = strategy.analyzeProfitability({
        expectedProfitUsd: 100,
        flashLoanAmountWei: ethers.parseEther('10'),
        estimatedGasUnits: 300000n,
        gasPriceWei: ethers.parseUnits('30', 'gwei'),
        chain: 'ethereum',
        ethPriceUsd: 2000,
      });

      // Flash loan execution includes flash loan fee
      // Direct execution does not
      expect(analysis.flashLoanNetProfit).toBeLessThan(analysis.directExecutionNetProfit);
    });

    it('should recommend flash loan when user has insufficient capital', () => {
      // Use smaller loan amount so fees don't make it unprofitable
      // 10 ETH * 0.09% = 0.009 ETH = $18 fee at $2000/ETH
      // Gas: 300000 * 30 gwei = 0.009 ETH = $18
      // Total costs: ~$36, profit $100, net ~$64
      const analysis = strategy.analyzeProfitability({
        expectedProfitUsd: 100,
        flashLoanAmountWei: ethers.parseEther('10'), // Moderate amount
        estimatedGasUnits: 300000n,
        gasPriceWei: ethers.parseUnits('30', 'gwei'),
        chain: 'ethereum',
        ethPriceUsd: 2000,
        userCapitalWei: ethers.parseEther('1'), // Small capital - insufficient
      });

      expect(analysis.isProfitable).toBe(true);
      expect(analysis.recommendation).toBe('flash-loan');
    });

    it('should recommend direct when user has capital and better profit', () => {
      const analysis = strategy.analyzeProfitability({
        expectedProfitUsd: 100,
        flashLoanAmountWei: ethers.parseEther('10'),
        estimatedGasUnits: 300000n,
        gasPriceWei: ethers.parseUnits('30', 'gwei'),
        chain: 'ethereum',
        ethPriceUsd: 2000,
        userCapitalWei: ethers.parseEther('100'), // Sufficient capital
      });

      expect(analysis.recommendation).toBe('direct');
    });
  });

  // ===========================================================================
  // Swap Path Building
  // ===========================================================================

  describe('buildSwapSteps', () => {
    it('should build 2-hop swap path correctly', () => {
      const opportunity = createMockOpportunity();
      const swapSteps = strategy.buildSwapSteps(opportunity, {
        buyRouter: MOCK_ROUTER_ADDRESS,
        sellRouter: MOCK_ROUTER_ADDRESS,
        intermediateToken: opportunity.tokenOut!, // USDC
        chain: 'ethereum', // Fix 10.1: Required chain parameter for decimals lookup
      });

      expect(swapSteps).toHaveLength(2);

      // First swap: tokenIn -> intermediate (buy)
      expect(swapSteps[0].router).toBe(MOCK_ROUTER_ADDRESS);
      expect(swapSteps[0].tokenIn).toBe(opportunity.tokenIn);
      expect(swapSteps[0].tokenOut).toBe(opportunity.tokenOut);

      // Second swap: intermediate -> tokenIn (sell back)
      expect(swapSteps[1].router).toBe(MOCK_ROUTER_ADDRESS);
      expect(swapSteps[1].tokenIn).toBe(opportunity.tokenOut);
      expect(swapSteps[1].tokenOut).toBe(opportunity.tokenIn);
    });

    it('should include minimum output amounts with slippage', () => {
      const opportunity = createMockOpportunity({
        amountIn: ethers.parseEther('10').toString(),
        expectedProfit: 100,
      });

      const swapSteps = strategy.buildSwapSteps(opportunity, {
        buyRouter: MOCK_ROUTER_ADDRESS,
        sellRouter: MOCK_ROUTER_ADDRESS,
        intermediateToken: opportunity.tokenOut!,
        slippageBps: 50, // 0.5% slippage
        chain: 'ethereum', // Fix 10.1: Required chain parameter
      });

      // amountOutMin should be set with slippage protection
      expect(swapSteps[0].amountOutMin).toBeGreaterThan(0n);
      expect(swapSteps[1].amountOutMin).toBeGreaterThan(0n);
    });
  });

  // ===========================================================================
  // Calldata Building
  // ===========================================================================

  describe('buildExecuteArbitrageCalldata', () => {
    it('should encode calldata correctly for executeArbitrage', () => {
      const opportunity = createMockOpportunity();
      const swapSteps = strategy.buildSwapSteps(opportunity, {
        buyRouter: MOCK_ROUTER_ADDRESS,
        sellRouter: MOCK_ROUTER_ADDRESS,
        intermediateToken: opportunity.tokenOut!,
        chain: 'ethereum', // Fix 10.1: Required chain parameter
      });

      const calldata = strategy.buildExecuteArbitrageCalldata({
        asset: opportunity.tokenIn!,
        amount: BigInt(opportunity.amountIn!),
        swapPath: swapSteps,
        minProfit: ethers.parseEther('0.01'), // 0.01 ETH min profit
      });

      // Should be valid hex string
      expect(calldata).toMatch(/^0x[a-fA-F0-9]+$/);

      // Should start with executeArbitrage function selector
      // executeArbitrage(address,uint256,(address,address,address,uint256)[],uint256)
      expect(calldata.slice(0, 10)).toBeDefined();
    });

    it('should include correct function signature', () => {
      const opportunity = createMockOpportunity();
      const swapSteps = strategy.buildSwapSteps(opportunity, {
        buyRouter: MOCK_ROUTER_ADDRESS,
        sellRouter: MOCK_ROUTER_ADDRESS,
        intermediateToken: opportunity.tokenOut!,
        chain: 'ethereum', // Fix 10.1: Required chain parameter
      });

      const calldata = strategy.buildExecuteArbitrageCalldata({
        asset: opportunity.tokenIn!,
        amount: BigInt(opportunity.amountIn!),
        swapPath: swapSteps,
        minProfit: ethers.parseEther('0.01'),
      });

      // Function selector for executeArbitrage
      const iface = new ethers.Interface([
        'function executeArbitrage(address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath, uint256 minProfit)'
      ]);
      const expectedSelector = iface.getFunction('executeArbitrage')!.selector;

      expect(calldata.slice(0, 10)).toBe(expectedSelector);
    });
  });

  // ===========================================================================
  // Transaction Preparation
  // ===========================================================================

  describe('prepareFlashLoanContractTransaction', () => {
    it('should prepare transaction with correct parameters', async () => {
      const opportunity = createMockOpportunity();
      const ctx = createMockContext();

      const tx = await strategy.prepareFlashLoanContractTransaction(
        opportunity,
        'ethereum',
        ctx
      );

      expect(tx.to).toBe(MOCK_FLASH_LOAN_CONTRACT_ADDRESS);
      expect(tx.data).toBeDefined();
      expect(tx.data).toMatch(/^0x/);
    });

    it('should throw if no contract address for chain', async () => {
      const opportunity = createMockOpportunity({ buyChain: 'unsupported-chain' });
      const ctx = createMockContext();
      ctx.providers.set('unsupported-chain', createMockProvider());
      ctx.wallets.set('unsupported-chain', createMockWallet());

      await expect(
        strategy.prepareFlashLoanContractTransaction(opportunity, 'unsupported-chain', ctx)
      ).rejects.toThrow('No FlashLoanArbitrage contract configured for chain');
    });

    it('should throw if opportunity missing required fields', async () => {
      const opportunity = createMockOpportunity({ tokenIn: undefined });
      const ctx = createMockContext();

      await expect(
        strategy.prepareFlashLoanContractTransaction(opportunity, 'ethereum', ctx)
      ).rejects.toThrow('Invalid opportunity: missing required fields');
    });
  });

  // ===========================================================================
  // Execution
  // ===========================================================================

  describe('execute', () => {
    it('should execute flash loan arbitrage successfully', async () => {
      const opportunity = createMockOpportunity();
      const ctx = createMockContext();

      const result = await strategy.execute(opportunity, ctx);

      expect(result.success).toBe(true);
      expect(result.transactionHash).toBeDefined();
      expect(result.opportunityId).toBe(opportunity.id);
      expect(result.chain).toBe('ethereum');
    });

    it('should return error result if no wallet for chain', async () => {
      const opportunity = createMockOpportunity();
      const ctx = createMockContext();
      ctx.wallets.clear();

      const result = await strategy.execute(opportunity, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No wallet');
    });

    it('should return error result if no provider for chain', async () => {
      const opportunity = createMockOpportunity();
      const ctx = createMockContext();
      ctx.providers.clear();

      const result = await strategy.execute(opportunity, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No provider');
    });

    it('should return error result if price verification fails', async () => {
      const opportunity = createMockOpportunity({
        timestamp: Date.now() - 60000, // 1 minute old
        expectedProfit: 1, // Below threshold
      });
      const ctx = createMockContext();

      const result = await strategy.execute(opportunity, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('verification failed');
    });

    it('should apply MEV protection before submission', async () => {
      const opportunity = createMockOpportunity();
      const ctx = createMockContext();

      // Add MEV provider mock
      const mockMevProvider = {
        isEnabled: jest.fn().mockReturnValue(true),
        strategy: 'flashbots',
        sendProtectedTransaction: jest.fn().mockResolvedValue({
          success: true,
          transactionHash: '0xmevtxhash',
          strategy: 'flashbots',
          usedFallback: false,
          latencyMs: 100,
        }),
      };

      ctx.mevProviderFactory = {
        getProvider: jest.fn().mockReturnValue(mockMevProvider),
      } as any;

      await strategy.execute(opportunity, ctx);

      expect(mockMevProvider.sendProtectedTransaction).toHaveBeenCalled();
    });

    it('should skip unprofitable opportunities after fee calculation', async () => {
      // expectedProfit needs to pass verification (>= minProfitThreshold * 1.2)
      // but be low enough that fees make it unprofitable
      // Large loan (1000 ETH) = 0.9 ETH fee = $1800 at $2000/ETH
      // High gas: 500000 * 200 gwei = 0.1 ETH = $200
      // Total costs: ~$2000, profit $50, net -$1950
      const opportunity = createMockOpportunity({
        expectedProfit: 50, // Passes verification but unprofitable after fees
        amountIn: ethers.parseEther('1000').toString(), // Very large loan = large fee
      });
      const ctx = createMockContext();

      // Mock high gas price
      const provider = ctx.providers.get('ethereum')!;
      (provider.getFeeData as jest.Mock).mockResolvedValue({
        gasPrice: ethers.parseUnits('200', 'gwei'),
        maxFeePerGas: ethers.parseUnits('250', 'gwei'),
        maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
      });

      const result = await strategy.execute(opportunity, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('unprofitable');
    });

    it('should use simulation when available', async () => {
      const opportunity = createMockOpportunity({ expectedProfit: 100 });
      const ctx = createMockContext();

      const mockSimulationService = {
        shouldSimulate: jest.fn().mockReturnValue(true),
        simulate: jest.fn().mockResolvedValue({
          success: true,
          wouldRevert: false,
          gasUsed: 250000n,
          provider: 'tenderly',
          latencyMs: 100,
        }),
        getAggregatedMetrics: jest.fn(),
        getProvidersHealth: jest.fn(),
        initialize: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn(),
      };
      ctx.simulationService = mockSimulationService as any;

      await strategy.execute(opportunity, ctx);

      expect(mockSimulationService.simulate).toHaveBeenCalled();
    });

    it('should abort if simulation predicts revert', async () => {
      const opportunity = createMockOpportunity({ expectedProfit: 100 });
      const ctx = createMockContext();

      const mockSimulationService = {
        shouldSimulate: jest.fn().mockReturnValue(true),
        simulate: jest.fn().mockResolvedValue({
          success: true,
          wouldRevert: true,
          revertReason: 'InsufficientProfit',
          provider: 'tenderly',
          latencyMs: 100,
        }),
        getAggregatedMetrics: jest.fn(),
        getProvidersHealth: jest.fn(),
        initialize: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn(),
      };
      ctx.simulationService = mockSimulationService as any;

      const result = await strategy.execute(opportunity, ctx);

      expect(result.success).toBe(false);
      // Fix 6.1: Error format changed to use ExecutionErrorCode
      expect(result.error).toContain('ERR_SIMULATION_REVERT');
      expect(ctx.stats.simulationPredictedReverts).toBe(1);
    });

    it('should track nonce via NonceManager', async () => {
      const opportunity = createMockOpportunity();
      const ctx = createMockContext();

      const mockNonceManager = {
        getNextNonce: jest.fn().mockResolvedValue(5),
        confirmTransaction: jest.fn(),
        failTransaction: jest.fn(),
      };
      ctx.nonceManager = mockNonceManager as any;

      await strategy.execute(opportunity, ctx);

      expect(mockNonceManager.getNextNonce).toHaveBeenCalledWith('ethereum');
      expect(mockNonceManager.confirmTransaction).toHaveBeenCalled();
    });

    it('should fail nonce on error', async () => {
      const opportunity = createMockOpportunity();
      const ctx = createMockContext();

      const mockNonceManager = {
        getNextNonce: jest.fn().mockResolvedValue(5),
        confirmTransaction: jest.fn(),
        failTransaction: jest.fn(),
      };
      ctx.nonceManager = mockNonceManager as any;

      // Make wallet throw error
      const wallet = ctx.wallets.get('ethereum')!;
      (wallet.sendTransaction as jest.Mock).mockRejectedValue(new Error('Transaction failed'));

      const result = await strategy.execute(opportunity, ctx);

      expect(result.success).toBe(false);
      expect(mockNonceManager.failTransaction).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Gas Estimation
  // ===========================================================================

  // Deprecated 7.3 Fix: estimateGasLegacy method has been removed.
  // All gas estimation should use estimateGasFromTransaction (public method).
  describe('estimateGasFromTransaction', () => {
    it('should estimate gas for prepared transaction', async () => {
      const opportunity = createMockOpportunity();
      const ctx = createMockContext();

      // First prepare the transaction, then estimate gas from it
      const tx = await strategy.prepareFlashLoanContractTransaction(opportunity, 'ethereum', ctx);
      const estimatedGas = await strategy.estimateGasFromTransaction(tx, 'ethereum', ctx);

      expect(estimatedGas).toBeGreaterThan(0n);
    });

    it('should return default estimate on error', async () => {
      const opportunity = createMockOpportunity();
      const ctx = createMockContext();

      const provider = ctx.providers.get('ethereum')!;
      (provider.estimateGas as jest.Mock).mockRejectedValue(new Error('Estimation failed'));

      // Use a simple prepared transaction
      const tx = await strategy.prepareFlashLoanContractTransaction(opportunity, 'ethereum', ctx);
      const estimatedGas = await strategy.estimateGasFromTransaction(tx, 'ethereum', ctx);

      // Should return default estimate (500000n)
      expect(estimatedGas).toBe(500000n);
    });
  });

  // ===========================================================================
  // Router Validation
  // ===========================================================================

  describe('validateRouters', () => {
    it('should validate approved routers', () => {
      expect(strategy.isRouterApproved('ethereum', MOCK_ROUTER_ADDRESS)).toBe(true);
    });

    it('should reject unapproved routers', () => {
      expect(strategy.isRouterApproved('ethereum', '0x0000000000000000000000000000000000000001')).toBe(false);
    });

    it('should return false for unknown chains', () => {
      expect(strategy.isRouterApproved('unknown-chain', MOCK_ROUTER_ADDRESS)).toBe(false);
    });
  });

  // ===========================================================================
  // Chain Support
  // ===========================================================================

  describe('chain support', () => {
    it('should report supported chains', () => {
      const supportedChains = strategy.getSupportedChains();

      expect(supportedChains).toContain('ethereum');
      expect(supportedChains.length).toBeGreaterThan(0);
    });

    it('should check if chain is supported', () => {
      expect(strategy.isChainSupported('ethereum')).toBe(true);
      expect(strategy.isChainSupported('unsupported-chain')).toBe(false);
    });
  });

  // ===========================================================================
  // Protocol Support (Issue 4.1)
  // ===========================================================================

  describe('protocol support', () => {
    it('should support Aave V3 chains', () => {
      // Aave V3 supported chains
      expect(strategy.isProtocolSupported('ethereum')).toBe(true);
      expect(strategy.isProtocolSupported('polygon')).toBe(true);
      expect(strategy.isProtocolSupported('arbitrum')).toBe(true);
      expect(strategy.isProtocolSupported('optimism')).toBe(true);
      expect(strategy.isProtocolSupported('base')).toBe(true);
      expect(strategy.isProtocolSupported('avalanche')).toBe(true);
    });

    it('should not support non-Aave V3 chains', () => {
      // These chains use different flash loan protocols
      expect(strategy.isProtocolSupported('bsc')).toBe(false); // PancakeSwap
      expect(strategy.isProtocolSupported('fantom')).toBe(false); // SpookySwap
      expect(strategy.isProtocolSupported('zksync')).toBe(false); // SyncSwap
      expect(strategy.isProtocolSupported('linea')).toBe(false); // SyncSwap
    });

    it('should return false for unknown chains', () => {
      expect(strategy.isProtocolSupported('unknown-chain')).toBe(false);
    });

    it('should return error for unsupported protocol chain execution', async () => {
      const opportunity = createMockOpportunity({ buyChain: 'bsc' });
      const ctx = createMockContext();
      ctx.providers.set('bsc', createMockProvider());
      ctx.wallets.set('bsc', createMockWallet());

      const result = await strategy.execute(opportunity, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not supported');
      expect(result.error).toContain('pancakeswap_v3');
    });

    it('should get protocol for chain', () => {
      expect(strategy.getProtocolForChain('ethereum')).toBe('aave_v3');
      expect(strategy.getProtocolForChain('bsc')).toBe('pancakeswap_v3');
      expect(strategy.getProtocolForChain('fantom')).toBe('spookyswap');
      expect(strategy.getProtocolForChain('zksync')).toBe('syncswap');
    });

    it('should get supported protocol chains', () => {
      const supported = strategy.getSupportedProtocolChains();
      expect(supported).toContain('ethereum');
      expect(supported).toContain('polygon');
      expect(supported).not.toContain('bsc');
      expect(supported).not.toContain('fantom');
    });
  });

  // ===========================================================================
  // Calculate Expected Profit On-Chain (Finding 8.2)
  // ===========================================================================

  describe('calculateExpectedProfitOnChain', () => {
    it('should call contract and return expected profit and fee', async () => {
      const opportunity = createMockOpportunity();
      const ctx = createMockContext();

      // Mock the provider.call to return encoded result
      const provider = ctx.providers.get('ethereum')!;
      const expectedProfit = ethers.parseEther('0.5'); // 0.5 ETH profit
      const flashLoanFee = ethers.parseEther('0.009'); // 0.009 ETH fee (0.09% of 10 ETH)

      // Encode the expected return value
      const iface = new ethers.Interface([
        'function calculateExpectedProfit(address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath) external view returns (uint256 expectedProfit, uint256 flashLoanFee)',
      ]);
      const encodedResult = iface.encodeFunctionResult('calculateExpectedProfit', [
        expectedProfit,
        flashLoanFee,
      ]);

      (provider.call as jest.Mock).mockResolvedValue(encodedResult);

      const result = await strategy.calculateExpectedProfitOnChain(opportunity, 'ethereum', ctx);

      expect(result).not.toBeNull();
      expect(result!.expectedProfit).toBe(expectedProfit);
      expect(result!.flashLoanFee).toBe(flashLoanFee);
    });

    it('should return null if opportunity missing required fields', async () => {
      const opportunity = createMockOpportunity({ tokenIn: undefined });
      const ctx = createMockContext();

      const result = await strategy.calculateExpectedProfitOnChain(opportunity, 'ethereum', ctx);

      expect(result).toBeNull();
    });

    it('should return null if no provider for chain', async () => {
      const opportunity = createMockOpportunity();
      const ctx = createMockContext();
      ctx.providers.clear();

      const result = await strategy.calculateExpectedProfitOnChain(opportunity, 'ethereum', ctx);

      expect(result).toBeNull();
    });

    it('should return null if no contract for chain', async () => {
      const opportunity = createMockOpportunity({ buyChain: 'polygon' });
      const ctx = createMockContext();
      ctx.providers.set('polygon', createMockProvider());

      const result = await strategy.calculateExpectedProfitOnChain(opportunity, 'polygon', ctx);

      expect(result).toBeNull();
    });

    it('should return null and log warning on contract call error', async () => {
      const opportunity = createMockOpportunity();
      const ctx = createMockContext();

      const provider = ctx.providers.get('ethereum')!;
      (provider.call as jest.Mock).mockRejectedValue(new Error('Contract call failed'));

      const result = await strategy.calculateExpectedProfitOnChain(opportunity, 'ethereum', ctx);

      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to calculate on-chain profit',
        expect.objectContaining({ chain: 'ethereum' })
      );
    });

    it('should handle zero profit result', async () => {
      const opportunity = createMockOpportunity();
      const ctx = createMockContext();

      const provider = ctx.providers.get('ethereum')!;
      const expectedProfit = 0n;
      const flashLoanFee = ethers.parseEther('0.009');

      const iface = new ethers.Interface([
        'function calculateExpectedProfit(address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath) external view returns (uint256 expectedProfit, uint256 flashLoanFee)',
      ]);
      const encodedResult = iface.encodeFunctionResult('calculateExpectedProfit', [
        expectedProfit,
        flashLoanFee,
      ]);

      (provider.call as jest.Mock).mockResolvedValue(encodedResult);

      const result = await strategy.calculateExpectedProfitOnChain(opportunity, 'ethereum', ctx);

      expect(result).not.toBeNull();
      expect(result!.expectedProfit).toBe(0n);
      expect(result!.flashLoanFee).toBe(flashLoanFee);
    });

    // Fix 8.1: Test for malformed return data
    it('should handle malformed return data gracefully', async () => {
      const opportunity = createMockOpportunity();
      const ctx = createMockContext();

      const provider = ctx.providers.get('ethereum')!;
      // Return malformed data (too short)
      (provider.call as jest.Mock).mockResolvedValue('0x1234');

      const result = await strategy.calculateExpectedProfitOnChain(opportunity, 'ethereum', ctx);

      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to calculate on-chain profit',
        expect.objectContaining({ chain: 'ethereum' })
      );
    });

    // Fix 8.1: Test for revert with custom error
    it('should handle revert with custom error gracefully', async () => {
      const opportunity = createMockOpportunity();
      const ctx = createMockContext();

      const provider = ctx.providers.get('ethereum')!;
      // Simulate contract revert with custom error data
      const revertError = new Error('Execution reverted');
      (revertError as Error & { data: string }).data = '0x5a052b32'; // InvalidSwapPath selector
      (provider.call as jest.Mock).mockRejectedValue(revertError);

      const result = await strategy.calculateExpectedProfitOnChain(opportunity, 'ethereum', ctx);

      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to calculate on-chain profit',
        expect.objectContaining({ chain: 'ethereum' })
      );
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle zero amount gracefully', async () => {
      const opportunity = createMockOpportunity({ amountIn: '0' });
      const ctx = createMockContext();

      const result = await strategy.execute(opportunity, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid');
    });

    it('should handle missing sellDex by using buyDex', async () => {
      const opportunity = createMockOpportunity({
        buyDex: 'uniswap',
        sellDex: undefined,
      });
      const ctx = createMockContext();

      // Should not throw
      const result = await strategy.execute(opportunity, ctx);
      expect(result).toBeDefined();
    });

    it('should handle gas spike by aborting', async () => {
      const opportunity = createMockOpportunity();
      const ctx = createMockContext();

      // Set up gas baseline
      ctx.gasBaselines.set('ethereum', [
        { price: ethers.parseUnits('30', 'gwei'), timestamp: Date.now() - 1000 },
        { price: ethers.parseUnits('30', 'gwei'), timestamp: Date.now() - 2000 },
        { price: ethers.parseUnits('30', 'gwei'), timestamp: Date.now() - 3000 },
      ]);

      // Mock high gas price (spike)
      const provider = ctx.providers.get('ethereum')!;
      (provider.getFeeData as jest.Mock).mockResolvedValue({
        gasPrice: ethers.parseUnits('150', 'gwei'), // 5x spike
        maxFeePerGas: ethers.parseUnits('150', 'gwei'),
        maxPriorityFeePerGas: ethers.parseUnits('3', 'gwei'),
      });

      const result = await strategy.execute(opportunity, ctx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Gas price spike');
    });
  });
});

// =============================================================================
// Fix 8.1: Tests for buildNHopSwapSteps
// =============================================================================

describe('FlashLoanStrategy - buildNHopSwapSteps', () => {
  let strategy: FlashLoanStrategy;
  let mockLogger: Logger;

  const MOCK_ROUTER_A = '0xA000000000000000000000000000000000000001';
  const MOCK_ROUTER_B = '0xB000000000000000000000000000000000000002';
  const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  const DAI = '0x6B175474E89094C44Da98b954EesdeCD73dF8141D';

  beforeEach(() => {
    mockLogger = createMockLogger();
    strategy = new FlashLoanStrategy(mockLogger, {
      contractAddresses: { ethereum: '0x1234567890123456789012345678901234567890' },
      approvedRouters: { ethereum: [MOCK_ROUTER_A, MOCK_ROUTER_B] },
    });
  });

  it('should build 3-hop triangular arbitrage path', () => {
    const opportunity = createMockOpportunity({
      tokenIn: WETH,
      amountIn: ethers.parseEther('10').toString(),
    });

    // Triangular: WETH -> USDC -> DAI -> WETH
    const steps = strategy.buildNHopSwapSteps(opportunity, {
      hops: [
        { router: MOCK_ROUTER_A, tokenOut: USDC, expectedOutput: ethers.parseUnits('20000', 6) },
        { router: MOCK_ROUTER_B, tokenOut: DAI, expectedOutput: ethers.parseEther('20000') },
        { router: MOCK_ROUTER_A, tokenOut: WETH, expectedOutput: ethers.parseEther('10.5') },
      ],
      slippageBps: 50, // 0.5%
      chain: 'ethereum',
    });

    expect(steps).toHaveLength(3);

    // First swap: WETH -> USDC
    expect(steps[0].router).toBe(MOCK_ROUTER_A);
    expect(steps[0].tokenIn).toBe(WETH);
    expect(steps[0].tokenOut).toBe(USDC);
    expect(steps[0].amountOutMin).toBeGreaterThan(0n);

    // Second swap: USDC -> DAI
    expect(steps[1].router).toBe(MOCK_ROUTER_B);
    expect(steps[1].tokenIn).toBe(USDC);
    expect(steps[1].tokenOut).toBe(DAI);

    // Third swap: DAI -> WETH (back to starting token)
    expect(steps[2].router).toBe(MOCK_ROUTER_A);
    expect(steps[2].tokenIn).toBe(DAI);
    expect(steps[2].tokenOut).toBe(WETH);
  });

  it('should throw if tokenIn is missing', () => {
    const opportunity = createMockOpportunity({ tokenIn: undefined });

    expect(() =>
      strategy.buildNHopSwapSteps(opportunity, {
        hops: [{ router: MOCK_ROUTER_A, tokenOut: USDC }],
        chain: 'ethereum',
      })
    ).toThrow('[ERR_INVALID_OPPORTUNITY]');
  });

  it('should throw if hops array is empty', () => {
    const opportunity = createMockOpportunity({ tokenIn: WETH });

    expect(() =>
      strategy.buildNHopSwapSteps(opportunity, {
        hops: [],
        chain: 'ethereum',
      })
    ).toThrow('[ERR_EMPTY_HOPS]');
  });

  it('should throw if path does not end with starting token', () => {
    const opportunity = createMockOpportunity({ tokenIn: WETH });

    // Invalid path: WETH -> USDC (does not return to WETH)
    expect(() =>
      strategy.buildNHopSwapSteps(opportunity, {
        hops: [{ router: MOCK_ROUTER_A, tokenOut: USDC }],
        chain: 'ethereum',
      })
    ).toThrow('[ERR_INVALID_PATH]');
  });

  it('should apply slippage protection to amountOutMin', () => {
    const opportunity = createMockOpportunity({ tokenIn: WETH });
    const expectedOutput = ethers.parseEther('10');
    const slippageBps = 100; // 1%

    const steps = strategy.buildNHopSwapSteps(opportunity, {
      hops: [{ router: MOCK_ROUTER_A, tokenOut: WETH, expectedOutput }],
      slippageBps,
      chain: 'ethereum',
    });

    // 1% slippage on 10 ETH = 0.1 ETH reduction
    const expectedMin = expectedOutput - (expectedOutput * BigInt(slippageBps) / 10000n);
    expect(steps[0].amountOutMin).toBe(expectedMin);
  });

  it('should use 1 wei minimum if expectedOutput not provided', () => {
    const opportunity = createMockOpportunity({ tokenIn: WETH });

    const steps = strategy.buildNHopSwapSteps(opportunity, {
      hops: [{ router: MOCK_ROUTER_A, tokenOut: WETH }], // No expectedOutput
      chain: 'ethereum',
    });

    expect(steps[0].amountOutMin).toBe(1n);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[WARN_SLIPPAGE]'),
      expect.any(Object)
    );
  });

  it('should build 4-hop quadrilateral path', () => {
    const opportunity = createMockOpportunity({ tokenIn: WETH });
    const WBTC = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599';

    // Quadrilateral: WETH -> USDC -> WBTC -> DAI -> WETH
    const steps = strategy.buildNHopSwapSteps(opportunity, {
      hops: [
        { router: MOCK_ROUTER_A, tokenOut: USDC, expectedOutput: ethers.parseUnits('20000', 6) },
        { router: MOCK_ROUTER_B, tokenOut: WBTC, expectedOutput: ethers.parseUnits('0.5', 8) },
        { router: MOCK_ROUTER_A, tokenOut: DAI, expectedOutput: ethers.parseEther('20000') },
        { router: MOCK_ROUTER_B, tokenOut: WETH, expectedOutput: ethers.parseEther('10.5') },
      ],
      slippageBps: 50,
      chain: 'ethereum',
    });

    expect(steps).toHaveLength(4);
    expect(steps[0].tokenIn).toBe(WETH);
    expect(steps[0].tokenOut).toBe(USDC);
    expect(steps[1].tokenIn).toBe(USDC);
    expect(steps[1].tokenOut).toBe(WBTC);
    expect(steps[2].tokenIn).toBe(WBTC);
    expect(steps[2].tokenOut).toBe(DAI);
    expect(steps[3].tokenIn).toBe(DAI);
    expect(steps[3].tokenOut).toBe(WETH);
  });
});
