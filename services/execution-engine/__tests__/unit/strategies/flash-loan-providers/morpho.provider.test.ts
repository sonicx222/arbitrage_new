/**
 * Unit Tests for MorphoFlashLoanProvider
 *
 * Tests the Morpho Blue flash loan provider implementation for Ethereum and Base.
 * Covers initialization, validation, fee calculation, calldata building,
 * gas estimation, and Morpho-specific constraints (zero-fee, multi-chain).
 *
 * @see morpho.provider.ts
 * @see https://docs.morpho.org/morpho/contracts/addresses
 */

import { ethers } from 'ethers';
import { MorphoFlashLoanProvider } from '../../../../src/strategies/flash-loan-providers/morpho.provider';
import type {
  FlashLoanRequest,
  FlashLoanSwapStep,
} from '../../../../src/strategies/flash-loan-providers/types';

// Mock @arbitrage/config to prevent deep import chain
jest.mock('@arbitrage/config', () => ({
  __esModule: true,
  getBpsDenominatorBigInt: () => BigInt(10000),
  ARBITRAGE_CONFIG: {
    gasPriceSpikeMultiplier: 2,
    maxGasPrice: '500',
    minProfitThreshold: '0.001',
    maxTradeSize: '10',
    defaultSlippageBps: 50,
    slippageTolerance: 0.05,
  },
}));

// Mock base.strategy to prevent deep import chain
jest.mock('../../../../src/strategies/base.strategy', () => ({
  getSwapDeadline: () => Math.floor(Date.now() / 1000) + 300,
}));

// =============================================================================
// Test Utilities
// =============================================================================

const TEST_ADDRESSES = {
  MORPHO_BLUE: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
  CONTRACT: '0x1234567890123456789012345678901234567890',
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
  ROUTER_UNISWAP: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
  ROUTER_SUSHI: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
  INITIATOR: '0xabcdef0123456789abcdef0123456789abcdef01',
  ZERO_ADDRESS: '0x0000000000000000000000000000000000000000',
};

const createValidRequest = (overrides?: Partial<FlashLoanRequest>): FlashLoanRequest => ({
  asset: TEST_ADDRESSES.WETH,
  amount: ethers.parseEther('10'),
  chain: 'ethereum',
  swapPath: [
    {
      router: TEST_ADDRESSES.ROUTER_UNISWAP,
      tokenIn: TEST_ADDRESSES.WETH,
      tokenOut: TEST_ADDRESSES.USDC,
      amountOutMin: 19000000000n, // ~$19000 USDC (6 decimals)
    },
    {
      router: TEST_ADDRESSES.ROUTER_UNISWAP,
      tokenIn: TEST_ADDRESSES.USDC,
      tokenOut: TEST_ADDRESSES.WETH,
      amountOutMin: ethers.parseEther('9.95'),
    },
  ] as FlashLoanSwapStep[],
  minProfit: ethers.parseEther('0.05'),
  initiator: TEST_ADDRESSES.INITIATOR,
  ...overrides,
});

const createValidConfig = (overrides?: {
  chain?: string;
  poolAddress?: string;
  contractAddress?: string;
  approvedRouters?: string[];
  feeOverride?: number;
}) => ({
  chain: 'ethereum',
  poolAddress: TEST_ADDRESSES.MORPHO_BLUE,
  contractAddress: TEST_ADDRESSES.CONTRACT,
  approvedRouters: [TEST_ADDRESSES.ROUTER_UNISWAP, TEST_ADDRESSES.ROUTER_SUSHI],
  ...overrides,
});

const createMockProvider = (estimateGasResult?: bigint, shouldThrow = false) => {
  return {
    estimateGas: jest.fn().mockImplementation(async () => {
      if (shouldThrow) {
        throw new Error('Gas estimation failed');
      }
      return estimateGasResult ?? 400000n;
    }),
  } as unknown as ethers.JsonRpcProvider;
};

// =============================================================================
// Constructor and Initialization Tests
// =============================================================================

describe('MorphoFlashLoanProvider - Constructor and Initialization', () => {
  describe('constructor', () => {
    it('should create provider with valid configuration', () => {
      const config = createValidConfig();
      const provider = new MorphoFlashLoanProvider(config);

      expect(provider).toBeDefined();
      expect(provider.protocol).toBe('morpho');
      expect(provider.chain).toBe('ethereum');
      expect(provider.poolAddress).toBe(TEST_ADDRESSES.MORPHO_BLUE);
    });

    it('should accept empty approved routers list', () => {
      const config = createValidConfig({ approvedRouters: [] });
      const provider = new MorphoFlashLoanProvider(config);

      expect(provider).toBeDefined();
      expect(provider.getApprovedRouters()).toEqual([]);
    });

    it('should accept fee override', () => {
      const config = createValidConfig({ feeOverride: 5 });
      const provider = new MorphoFlashLoanProvider(config);

      const feeInfo = provider.calculateFee(ethers.parseEther('10000'));
      expect(feeInfo.feeBps).toBe(5);
    });

    it('should throw error for invalid contract address', () => {
      const config = createValidConfig({ contractAddress: 'invalid-address' });

      expect(() => new MorphoFlashLoanProvider(config)).toThrow(
        '[ERR_CONFIG] Invalid contract address for Morpho provider on ethereum'
      );
    });

    it('should throw error for invalid Morpho Blue address', () => {
      const config = createValidConfig({ poolAddress: 'invalid-pool' });

      expect(() => new MorphoFlashLoanProvider(config)).toThrow(
        '[ERR_CONFIG] Invalid Morpho Blue address for provider on ethereum'
      );
    });
  });

  describe('isAvailable', () => {
    it('should return true for ethereum chain', () => {
      const config = createValidConfig({ chain: 'ethereum' });
      const provider = new MorphoFlashLoanProvider(config);

      expect(provider.isAvailable()).toBe(true);
    });

    it('should return true for base chain', () => {
      const config = createValidConfig({ chain: 'base' });
      const provider = new MorphoFlashLoanProvider(config);

      expect(provider.isAvailable()).toBe(true);
    });

    it('should return false for unsupported chain', () => {
      const config = createValidConfig({ chain: 'arbitrum' });
      const provider = new MorphoFlashLoanProvider(config);

      expect(provider.isAvailable()).toBe(false);
    });

    it('should return false for zero contract address', () => {
      const config = createValidConfig({ contractAddress: TEST_ADDRESSES.ZERO_ADDRESS });
      const provider = new MorphoFlashLoanProvider(config);

      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe('getCapabilities', () => {
    it('should return correct capabilities', () => {
      const config = createValidConfig();
      const provider = new MorphoFlashLoanProvider(config);

      const capabilities = provider.getCapabilities();

      expect(capabilities.supportsMultiHop).toBe(true);
      expect(capabilities.supportsMultiAsset).toBe(false);
      expect(capabilities.maxLoanAmount).toBe(0n);
      expect(capabilities.supportedTokens).toEqual([]); // Any token with market liquidity
      expect(capabilities.status).toBe('fully_supported');
    });
  });

  describe('getter methods', () => {
    it('should return contract address', () => {
      const config = createValidConfig();
      const provider = new MorphoFlashLoanProvider(config);

      expect(provider.getContractAddress()).toBe(TEST_ADDRESSES.CONTRACT);
    });

    it('should return copy of approved routers', () => {
      const config = createValidConfig();
      const provider = new MorphoFlashLoanProvider(config);

      const routers1 = provider.getApprovedRouters();
      const routers2 = provider.getApprovedRouters();

      expect(routers1).toEqual(routers2);
      expect(routers1).not.toBe(routers2);
    });

    it('should return Morpho Blue address', () => {
      const config = createValidConfig();
      const provider = new MorphoFlashLoanProvider(config);

      expect(provider.getMorphoBlueAddress()).toBe(TEST_ADDRESSES.MORPHO_BLUE);
    });
  });
});

// =============================================================================
// Fee Calculation Tests
// =============================================================================

describe('MorphoFlashLoanProvider - Fee Calculation', () => {
  let provider: MorphoFlashLoanProvider;

  beforeEach(() => {
    const config = createValidConfig();
    provider = new MorphoFlashLoanProvider(config);
  });

  describe('calculateFee', () => {
    it('should return zero fee (0 bps)', () => {
      const amount = ethers.parseEther('10000');

      const feeInfo = provider.calculateFee(amount);

      expect(feeInfo.feeBps).toBe(0);
      expect(feeInfo.feeAmount).toBe(0n);
      expect(feeInfo.protocol).toBe('morpho');
    });

    it('should return zero fee for any amount', () => {
      const amounts = [
        1n,
        ethers.parseEther('1'),
        ethers.parseEther('1000000'),
        ethers.parseEther('1000000000'),
      ];

      for (const amount of amounts) {
        const feeInfo = provider.calculateFee(amount);
        expect(feeInfo.feeAmount).toBe(0n);
      }
    });

    it('should handle zero amount', () => {
      const feeInfo = provider.calculateFee(0n);

      expect(feeInfo.feeAmount).toBe(0n);
    });

    it('should use fee override when provided', () => {
      const config = createValidConfig({ feeOverride: 10 });
      const overrideProvider = new MorphoFlashLoanProvider(config);
      const amount = ethers.parseEther('10000');

      const feeInfo = overrideProvider.calculateFee(amount);

      expect(feeInfo.feeBps).toBe(10);
      expect(feeInfo.feeAmount).toBe(ethers.parseEther('10'));
    });
  });
});

// =============================================================================
// Validation Tests
// =============================================================================

describe('MorphoFlashLoanProvider - Request Validation', () => {
  let provider: MorphoFlashLoanProvider;

  beforeEach(() => {
    const config = createValidConfig();
    provider = new MorphoFlashLoanProvider(config);
  });

  describe('validate - success cases', () => {
    it('should validate a correct ethereum request', () => {
      const request = createValidRequest();

      const result = provider.validate(request);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should validate a correct base request', () => {
      const request = createValidRequest({ chain: 'base' });
      const baseConfig = createValidConfig({ chain: 'base' });
      const baseProvider = new MorphoFlashLoanProvider(baseConfig);

      const result = baseProvider.validate(request);

      expect(result.valid).toBe(true);
    });
  });

  describe('validate - chain-specific rejections', () => {
    it('should reject unsupported chain', () => {
      const request = createValidRequest({ chain: 'arbitrum' });

      const result = provider.validate(request);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_CHAIN_NOT_SUPPORTED]');
      expect(result.error).toContain('arbitrum');
    });

    it('should reject bsc chain', () => {
      const request = createValidRequest({ chain: 'bsc' });

      const result = provider.validate(request);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_CHAIN_NOT_SUPPORTED]');
    });
  });

  describe('validate - standard validation', () => {
    it('should reject zero loan amount', () => {
      const request = createValidRequest({ amount: 0n });

      const result = provider.validate(request);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_ZERO_AMOUNT]');
    });

    it('should reject empty swap path', () => {
      const request = createValidRequest({ swapPath: [] });

      const result = provider.validate(request);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_EMPTY_PATH]');
    });

    it('should reject unapproved router', () => {
      const request = createValidRequest({
        swapPath: [
          {
            router: '0x9999999999999999999999999999999999999999',
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: 1n,
          },
          {
            router: TEST_ADDRESSES.ROUTER_UNISWAP,
            tokenIn: TEST_ADDRESSES.USDC,
            tokenOut: TEST_ADDRESSES.WETH,
            amountOutMin: 1n,
          },
        ] as FlashLoanSwapStep[],
      });

      const result = provider.validate(request);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_UNAPPROVED_ROUTER]');
    });
  });
});

// =============================================================================
// Calldata and Transaction Building Tests
// =============================================================================

describe('MorphoFlashLoanProvider - Calldata and Transaction Building', () => {
  let provider: MorphoFlashLoanProvider;

  beforeEach(() => {
    const config = createValidConfig();
    provider = new MorphoFlashLoanProvider(config);
  });

  describe('buildCalldata', () => {
    it('should build non-empty hex calldata', () => {
      const request = createValidRequest();

      const calldata = provider.buildCalldata(request);

      expect(calldata).toBeDefined();
      expect(typeof calldata).toBe('string');
      expect(calldata.startsWith('0x')).toBe(true);
      expect(calldata.length).toBeGreaterThan(10);
    });

    it('should build calldata with correct flashLoan function selector', () => {
      const request = createValidRequest();

      const calldata = provider.buildCalldata(request);

      // Morpho flashLoan(address,uint256,bytes) selector
      const iface = new ethers.Interface([
        'function flashLoan(address token, uint256 assets, bytes calldata data) external',
      ]);
      const expectedSelector = iface.getFunction('flashLoan')!.selector;

      expect(calldata.substring(0, 10)).toBe(expectedSelector);
    });

    it('should encode the token address', () => {
      const request = createValidRequest();

      const calldata = provider.buildCalldata(request);

      const iface = new ethers.Interface([
        'function flashLoan(address token, uint256 assets, bytes calldata data) external',
      ]);
      const decoded = iface.decodeFunctionData('flashLoan', calldata);

      expect(decoded[0]).toBe(TEST_ADDRESSES.WETH); // token
    });

    it('should encode the correct amount', () => {
      const request = createValidRequest();

      const calldata = provider.buildCalldata(request);

      const iface = new ethers.Interface([
        'function flashLoan(address token, uint256 assets, bytes calldata data) external',
      ]);
      const decoded = iface.decodeFunctionData('flashLoan', calldata);

      expect(decoded[1]).toBe(request.amount); // assets
    });

    it('should encode inner data with swap path, minProfit, and deadline', () => {
      const request = createValidRequest();

      const calldata = provider.buildCalldata(request);

      const iface = new ethers.Interface([
        'function flashLoan(address token, uint256 assets, bytes calldata data) external',
      ]);
      const decoded = iface.decodeFunctionData('flashLoan', calldata);

      const innerData = decoded[2];
      expect(innerData).toBeDefined();
      expect(innerData.length).toBeGreaterThan(0);

      const innerDecoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ['tuple(address,address,address,uint256)[]', 'uint256', 'uint256'],
        innerData
      );

      expect(innerDecoded[0].length).toBe(2);
      expect(innerDecoded[1]).toBe(request.minProfit);
      expect(Number(innerDecoded[2])).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });
  });

  describe('buildTransaction', () => {
    it('should build transaction with correct structure', () => {
      const request = createValidRequest();
      const from = TEST_ADDRESSES.INITIATOR;

      const tx = provider.buildTransaction(request, from);

      expect(tx.to).toBe(TEST_ADDRESSES.MORPHO_BLUE);
      expect(tx.from).toBe(from);
      expect(tx.data).toBeDefined();
    });

    it('should set `to` field to Morpho Blue address', () => {
      const request = createValidRequest();
      const from = TEST_ADDRESSES.INITIATOR;

      const tx = provider.buildTransaction(request, from);

      expect(tx.to).toBe(TEST_ADDRESSES.MORPHO_BLUE);
    });
  });
});

// =============================================================================
// Gas Estimation Tests
// =============================================================================

describe('MorphoFlashLoanProvider - Gas Estimation', () => {
  let provider: MorphoFlashLoanProvider;

  beforeEach(() => {
    const config = createValidConfig();
    provider = new MorphoFlashLoanProvider(config);
  });

  describe('estimateGas', () => {
    it('should return gas estimate from provider', async () => {
      const request = createValidRequest();
      const mockProvider = createMockProvider(500000n);

      const gasEstimate = await provider.estimateGas(request, mockProvider);

      expect(gasEstimate).toBe(500000n);
      expect(mockProvider.estimateGas).toHaveBeenCalledTimes(1);
    });

    it('should return default estimate (400k) on estimation failure', async () => {
      const request = createValidRequest();
      const mockProvider = createMockProvider(undefined, true);

      const gasEstimate = await provider.estimateGas(request, mockProvider);

      expect(gasEstimate).toBe(400000n);
    });
  });
});

// =============================================================================
// Integration Tests
// =============================================================================

describe('MorphoFlashLoanProvider - Integration Scenarios', () => {
  describe('complete arbitrage flow', () => {
    it('should validate, build calldata, and estimate gas for valid request', async () => {
      const config = createValidConfig();
      const provider = new MorphoFlashLoanProvider(config);
      const request = createValidRequest();
      const mockProvider = createMockProvider(380000n);

      const validation = provider.validate(request);
      expect(validation.valid).toBe(true);

      const feeInfo = provider.calculateFee(request.amount);
      expect(feeInfo.feeAmount).toBe(0n); // Zero fee!
      expect(feeInfo.feeBps).toBe(0);

      const tx = provider.buildTransaction(request, request.initiator);
      expect(tx.to).toBe(config.poolAddress);

      const gasEstimate = await provider.estimateGas(request, mockProvider);
      expect(gasEstimate).toBe(380000n);
    });
  });

  describe('Morpho-specific characteristics', () => {
    it('should have zero fee — lowest of all providers', () => {
      const config = createValidConfig();
      const provider = new MorphoFlashLoanProvider(config);

      const feeInfo = provider.calculateFee(ethers.parseEther('100000'));

      expect(feeInfo.feeBps).toBe(0);
      expect(feeInfo.feeAmount).toBe(0n);
    });

    it('should be available on both ethereum and base', () => {
      const ethProvider = new MorphoFlashLoanProvider(createValidConfig({ chain: 'ethereum' }));
      const baseProvider = new MorphoFlashLoanProvider(createValidConfig({ chain: 'base' }));
      const arbProvider = new MorphoFlashLoanProvider(createValidConfig({ chain: 'arbitrum' }));

      expect(ethProvider.isAvailable()).toBe(true);
      expect(baseProvider.isAvailable()).toBe(true);
      expect(arbProvider.isAvailable()).toBe(false);
    });

    it('should support any token (empty supportedTokens)', () => {
      const config = createValidConfig();
      const provider = new MorphoFlashLoanProvider(config);

      const capabilities = provider.getCapabilities();

      expect(capabilities.supportedTokens).toEqual([]);
    });
  });
});
