/**
 * Unit Tests for DaiFlashMintProvider
 *
 * Tests the DAI Flash Mint provider implementation for Ethereum mainnet.
 * Covers initialization, validation, fee calculation, calldata building,
 * gas estimation, and DAI-specific constraints.
 *
 * Testing patterns follow CLAUDE.md:
 * - Constructor pattern for DI (allows proper mock injection)
 * - Mocks set up in beforeEach()
 * - Direct imports from source files (not barrel exports)
 * - Local createMockDeps() helper for consistent dependency injection
 *
 * @see dai-flash-mint.provider.ts
 * @see contracts/src/DaiFlashMintArbitrage.sol
 */

import { ethers } from 'ethers';
import { DaiFlashMintProvider } from '../../../../src/strategies/flash-loan-providers/dai-flash-mint.provider';
import type {
  FlashLoanRequest,
  FlashLoanSwapStep,
} from '../../../../src/strategies/flash-loan-providers/types';

// Mock @arbitrage/config to prevent deep import chain
const MOCK_BPS_DENOMINATOR_NUM = 10000;

jest.mock('@arbitrage/config', () => ({
  __esModule: true,
  getBpsDenominatorBigInt: () => BigInt(MOCK_BPS_DENOMINATOR_NUM),
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

/**
 * Valid test addresses for Ethereum mainnet
 */
const TEST_ADDRESSES = {
  DSS_FLASH: '0x1EB4CF3A948E7D72A198fe073cCb8C7a948cD853', // DssFlash on Ethereum
  CONTRACT: '0x1234567890123456789012345678901234567890', // Flash arbitrage contract
  DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F', // DAI on Ethereum
  ROUTER_UNISWAP: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', // UniswapV2 Router
  ROUTER_SUSHI: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F', // SushiSwap Router
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH on Ethereum
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC on Ethereum
  INITIATOR: '0xabcdef0123456789abcdef0123456789abcdef01', // User address
  ZERO_ADDRESS: '0x0000000000000000000000000000000000000000',
};

/**
 * Create a valid flash loan request for testing
 */
const createValidRequest = (overrides?: Partial<FlashLoanRequest>): FlashLoanRequest => ({
  asset: TEST_ADDRESSES.DAI,
  amount: ethers.parseEther('10000'), // 10000 DAI
  chain: 'ethereum',
  swapPath: [
    {
      router: TEST_ADDRESSES.ROUTER_UNISWAP,
      tokenIn: TEST_ADDRESSES.DAI,
      tokenOut: TEST_ADDRESSES.WETH,
      amountOutMin: ethers.parseEther('4.95'), // ~$2000/ETH * 5 * 0.99
    },
    {
      router: TEST_ADDRESSES.ROUTER_UNISWAP,
      tokenIn: TEST_ADDRESSES.WETH,
      tokenOut: TEST_ADDRESSES.DAI,
      amountOutMin: ethers.parseEther('9950'), // 10000 * 0.995 slippage
    },
  ] as FlashLoanSwapStep[],
  minProfit: ethers.parseEther('10'), // 10 DAI minimum profit
  initiator: TEST_ADDRESSES.INITIATOR,
  ...overrides,
});

/**
 * Create a valid provider configuration
 */
const createValidConfig = (overrides?: {
  chain?: string;
  poolAddress?: string;
  contractAddress?: string;
  approvedRouters?: string[];
  feeOverride?: number;
}) => ({
  chain: 'ethereum',
  poolAddress: TEST_ADDRESSES.DSS_FLASH,
  contractAddress: TEST_ADDRESSES.CONTRACT,
  approvedRouters: [TEST_ADDRESSES.ROUTER_UNISWAP, TEST_ADDRESSES.ROUTER_SUSHI],
  ...overrides,
});

/**
 * Create a mock JSON-RPC provider for gas estimation tests
 */
const createMockProvider = (estimateGasResult?: bigint, shouldThrow = false) => {
  return {
    estimateGas: jest.fn().mockImplementation(async () => {
      if (shouldThrow) {
        throw new Error('Gas estimation failed');
      }
      return estimateGasResult ?? 450000n;
    }),
  } as unknown as ethers.JsonRpcProvider;
};

// =============================================================================
// Constructor and Initialization Tests
// =============================================================================

describe('DaiFlashMintProvider - Constructor and Initialization', () => {
  describe('constructor', () => {
    it('should create provider with valid configuration', () => {
      const config = createValidConfig();
      const provider = new DaiFlashMintProvider(config);

      expect(provider).toBeDefined();
      expect(provider.protocol).toBe('dai_flash_mint');
      expect(provider.chain).toBe('ethereum');
      expect(provider.poolAddress).toBe(TEST_ADDRESSES.DSS_FLASH);
    });

    it('should accept empty approved routers list', () => {
      const config = createValidConfig({ approvedRouters: [] });
      const provider = new DaiFlashMintProvider(config);

      expect(provider).toBeDefined();
      expect(provider.getApprovedRouters()).toEqual([]);
    });

    it('should accept fee override', () => {
      const config = createValidConfig({ feeOverride: 5 }); // 0.05%
      const provider = new DaiFlashMintProvider(config);

      const feeInfo = provider.calculateFee(ethers.parseEther('10000'));
      expect(feeInfo.feeBps).toBe(5);
    });

    it('should throw error for invalid contract address', () => {
      const config = createValidConfig({ contractAddress: 'invalid-address' });

      expect(() => new DaiFlashMintProvider(config)).toThrow(
        '[ERR_CONFIG] Invalid contract address for DAI Flash Mint provider on ethereum'
      );
    });

    it('should throw error for invalid DssFlash address', () => {
      const config = createValidConfig({ poolAddress: 'invalid-pool' });

      expect(() => new DaiFlashMintProvider(config)).toThrow(
        '[ERR_CONFIG] Invalid DssFlash address for DAI Flash Mint provider on ethereum'
      );
    });

    it('should validate both contract and pool addresses', () => {
      const config = createValidConfig({
        contractAddress: 'bad-contract',
        poolAddress: 'bad-pool',
      });

      // Should throw on first invalid address (contract)
      expect(() => new DaiFlashMintProvider(config)).toThrow('[ERR_CONFIG]');
    });
  });

  describe('isAvailable', () => {
    it('should return true for ethereum chain', () => {
      const config = createValidConfig();
      const provider = new DaiFlashMintProvider(config);

      expect(provider.isAvailable()).toBe(true);
    });

    it('should return false for non-ethereum chain', () => {
      const config = createValidConfig({ chain: 'arbitrum' });
      const provider = new DaiFlashMintProvider(config);

      expect(provider.isAvailable()).toBe(false);
    });

    it('should return false for bsc chain', () => {
      const config = createValidConfig({ chain: 'bsc' });
      const provider = new DaiFlashMintProvider(config);

      expect(provider.isAvailable()).toBe(false);
    });

    it('should return false for polygon chain', () => {
      const config = createValidConfig({ chain: 'polygon' });
      const provider = new DaiFlashMintProvider(config);

      expect(provider.isAvailable()).toBe(false);
    });

    it('should return false for zero contract address', () => {
      const config = createValidConfig({ contractAddress: TEST_ADDRESSES.ZERO_ADDRESS });
      const provider = new DaiFlashMintProvider(config);

      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe('getCapabilities', () => {
    it('should return correct capabilities', () => {
      const config = createValidConfig();
      const provider = new DaiFlashMintProvider(config);

      const capabilities = provider.getCapabilities();

      expect(capabilities.supportsMultiHop).toBe(true);
      expect(capabilities.supportsMultiAsset).toBe(false);
      expect(capabilities.maxLoanAmount).toBe(0n);
      expect(capabilities.supportedTokens).toEqual([TEST_ADDRESSES.DAI]);
      expect(capabilities.status).toBe('fully_supported');
    });

    it('should include DAI in supported tokens', () => {
      const config = createValidConfig();
      const provider = new DaiFlashMintProvider(config);

      const capabilities = provider.getCapabilities();

      expect(capabilities.supportedTokens).toHaveLength(1);
      expect(capabilities.supportedTokens[0]).toBe(TEST_ADDRESSES.DAI);
    });
  });

  describe('protocol and chain properties', () => {
    it('should expose protocol as readonly', () => {
      const config = createValidConfig();
      const provider = new DaiFlashMintProvider(config);

      expect(provider.protocol).toBe('dai_flash_mint');
    });

    it('should expose chain as readonly', () => {
      const config = createValidConfig();
      const provider = new DaiFlashMintProvider(config);

      expect(provider.chain).toBe('ethereum');
    });

    it('should expose poolAddress (DssFlash) as readonly', () => {
      const config = createValidConfig();
      const provider = new DaiFlashMintProvider(config);

      expect(provider.poolAddress).toBe(TEST_ADDRESSES.DSS_FLASH);
    });
  });

  describe('getter methods', () => {
    it('should return contract address', () => {
      const config = createValidConfig();
      const provider = new DaiFlashMintProvider(config);

      expect(provider.getContractAddress()).toBe(TEST_ADDRESSES.CONTRACT);
    });

    it('should return copy of approved routers (not reference)', () => {
      const config = createValidConfig();
      const provider = new DaiFlashMintProvider(config);

      const routers1 = provider.getApprovedRouters();
      const routers2 = provider.getApprovedRouters();

      expect(routers1).toEqual(routers2);
      expect(routers1).not.toBe(routers2); // Different array instances
    });

    it('should return DssFlash address', () => {
      const config = createValidConfig();
      const provider = new DaiFlashMintProvider(config);

      expect(provider.getDssFlashAddress()).toBe(TEST_ADDRESSES.DSS_FLASH);
    });
  });
});

// =============================================================================
// Fee Calculation Tests
// =============================================================================

describe('DaiFlashMintProvider - Fee Calculation', () => {
  let provider: DaiFlashMintProvider;

  beforeEach(() => {
    const config = createValidConfig();
    provider = new DaiFlashMintProvider(config);
  });

  describe('calculateFee', () => {
    it('should calculate correct fee for standard amount (1 bps = 0.01%)', () => {
      const amount = ethers.parseEther('10000'); // 10000 DAI

      const feeInfo = provider.calculateFee(amount);

      expect(feeInfo.feeBps).toBe(1);
      expect(feeInfo.feeAmount).toBe(ethers.parseEther('1')); // 0.01% of 10000 = 1 DAI
      expect(feeInfo.protocol).toBe('dai_flash_mint');
    });

    it('should calculate fee for 1 DAI', () => {
      const amount = ethers.parseEther('1');

      const feeInfo = provider.calculateFee(amount);

      // 1 DAI * 1 / 10000 = 0.0001 DAI = 1e14 wei
      expect(feeInfo.feeAmount).toBe(100000000000000n);
    });

    it('should calculate fee for 1 million DAI', () => {
      const amount = ethers.parseEther('1000000');

      const feeInfo = provider.calculateFee(amount);

      expect(feeInfo.feeAmount).toBe(ethers.parseEther('100')); // 100 DAI
    });

    it('should handle very small amounts', () => {
      const amount = 10000n; // 10000 wei

      const feeInfo = provider.calculateFee(amount);

      expect(feeInfo.feeAmount).toBe(1n); // (10000 * 1) / 10000 = 1
    });

    it('should handle very large amounts without overflow', () => {
      const amount = ethers.parseEther('1000000000'); // 1 billion DAI

      const feeInfo = provider.calculateFee(amount);

      expect(feeInfo.feeAmount).toBe(ethers.parseEther('100000')); // 100000 DAI
    });

    it('should handle zero amount', () => {
      const amount = 0n;

      const feeInfo = provider.calculateFee(amount);

      expect(feeInfo.feeAmount).toBe(0n);
    });

    it('should use fee override when provided', () => {
      const config = createValidConfig({ feeOverride: 10 }); // 0.1%
      const overrideProvider = new DaiFlashMintProvider(config);
      const amount = ethers.parseEther('10000');

      const feeInfo = overrideProvider.calculateFee(amount);

      expect(feeInfo.feeBps).toBe(10);
      expect(feeInfo.feeAmount).toBe(ethers.parseEther('10')); // 0.1% of 10000 = 10 DAI
    });

    it('should allow zero fee override (for testing)', () => {
      const config = createValidConfig({ feeOverride: 0 });
      const overrideProvider = new DaiFlashMintProvider(config);
      const amount = ethers.parseEther('10000');

      const feeInfo = overrideProvider.calculateFee(amount);

      expect(feeInfo.feeBps).toBe(0);
      expect(feeInfo.feeAmount).toBe(0n);
    });
  });
});

// =============================================================================
// Validation Tests
// =============================================================================

describe('DaiFlashMintProvider - Request Validation', () => {
  let provider: DaiFlashMintProvider;

  beforeEach(() => {
    const config = createValidConfig();
    provider = new DaiFlashMintProvider(config);
  });

  describe('validate - success cases', () => {
    it('should validate a correct DAI+ethereum request', () => {
      const request = createValidRequest();

      const result = provider.validate(request);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe('validate - DAI-specific: rejects non-DAI assets', () => {
    it('should reject WETH as asset', () => {
      const request = createValidRequest({
        asset: TEST_ADDRESSES.WETH,
        swapPath: [
          {
            router: TEST_ADDRESSES.ROUTER_UNISWAP,
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.DAI,
            amountOutMin: 1n,
          },
          {
            router: TEST_ADDRESSES.ROUTER_UNISWAP,
            tokenIn: TEST_ADDRESSES.DAI,
            tokenOut: TEST_ADDRESSES.WETH,
            amountOutMin: 1n,
          },
        ] as FlashLoanSwapStep[],
      });

      const result = provider.validate(request);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_ASSET_NOT_DAI]');
      expect(result.error).toContain(TEST_ADDRESSES.DAI);
    });

    it('should reject USDC as asset', () => {
      const request = createValidRequest({
        asset: TEST_ADDRESSES.USDC,
      });

      const result = provider.validate(request);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_ASSET_NOT_DAI]');
    });
  });

  describe('validate - DAI-specific: rejects non-ethereum chains', () => {
    it('should reject arbitrum chain', () => {
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

    it('should reject polygon chain', () => {
      const request = createValidRequest({ chain: 'polygon' });

      const result = provider.validate(request);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_CHAIN_NOT_SUPPORTED]');
    });
  });

  describe('validate - standard validation (delegated to validateFlashLoanRequest)', () => {
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
            router: '0x9999999999999999999999999999999999999999', // Not approved
            tokenIn: TEST_ADDRESSES.DAI,
            tokenOut: TEST_ADDRESSES.WETH,
            amountOutMin: 1n,
          },
          {
            router: TEST_ADDRESSES.ROUTER_UNISWAP,
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.DAI,
            amountOutMin: 1n,
          },
        ] as FlashLoanSwapStep[],
      });

      const result = provider.validate(request);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_UNAPPROVED_ROUTER]');
    });

    it('should reject path that does not form a valid cycle', () => {
      const request = createValidRequest({
        swapPath: [
          {
            router: TEST_ADDRESSES.ROUTER_UNISWAP,
            tokenIn: TEST_ADDRESSES.DAI,
            tokenOut: TEST_ADDRESSES.WETH,
            amountOutMin: 1n,
          },
          {
            router: TEST_ADDRESSES.ROUTER_UNISWAP,
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.USDC, // Ends with USDC, not DAI
            amountOutMin: 1n,
          },
        ] as FlashLoanSwapStep[],
      });

      const result = provider.validate(request);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_INVALID_CYCLE]');
    });

    it('should reject when first swap token does not match asset', () => {
      const request = createValidRequest({
        swapPath: [
          {
            router: TEST_ADDRESSES.ROUTER_UNISWAP,
            tokenIn: TEST_ADDRESSES.WETH, // Starts with WETH, not DAI
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
      // Could be ERR_ASSET_MISMATCH or ERR_INVALID_CYCLE depending on the last tokenOut
      expect(result.error).toBeDefined();
    });

    it('should accept request with empty approved routers list (allows all)', () => {
      const config = createValidConfig({ approvedRouters: [] });
      const permissiveProvider = new DaiFlashMintProvider(config);
      const request = createValidRequest({
        swapPath: [
          {
            router: '0x9999999999999999999999999999999999999999',
            tokenIn: TEST_ADDRESSES.DAI,
            tokenOut: TEST_ADDRESSES.WETH,
            amountOutMin: 1n,
          },
          {
            router: '0x8888888888888888888888888888888888888888',
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.DAI,
            amountOutMin: 1n,
          },
        ] as FlashLoanSwapStep[],
      });

      const result = permissiveProvider.validate(request);

      expect(result.valid).toBe(true);
    });
  });
});

// =============================================================================
// Calldata and Transaction Building Tests
// =============================================================================

describe('DaiFlashMintProvider - Calldata and Transaction Building', () => {
  let provider: DaiFlashMintProvider;

  beforeEach(() => {
    const config = createValidConfig();
    provider = new DaiFlashMintProvider(config);
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

      // EIP-3156 flashLoan(address,address,uint256,bytes) selector
      const iface = new ethers.Interface([
        'function flashLoan(address receiver, address token, uint256 amount, bytes calldata data) external returns (bool)',
      ]);
      const expectedSelector = iface.getFunction('flashLoan')!.selector;

      expect(calldata.substring(0, 10)).toBe(expectedSelector);
    });

    it('should encode the receiver as the contract address', () => {
      const request = createValidRequest();

      const calldata = provider.buildCalldata(request);

      const iface = new ethers.Interface([
        'function flashLoan(address receiver, address token, uint256 amount, bytes calldata data) external returns (bool)',
      ]);
      const decoded = iface.decodeFunctionData('flashLoan', calldata);

      expect(decoded[0]).toBe(TEST_ADDRESSES.CONTRACT); // receiver
    });

    it('should encode DAI as the token', () => {
      const request = createValidRequest();

      const calldata = provider.buildCalldata(request);

      const iface = new ethers.Interface([
        'function flashLoan(address receiver, address token, uint256 amount, bytes calldata data) external returns (bool)',
      ]);
      const decoded = iface.decodeFunctionData('flashLoan', calldata);

      expect(decoded[1]).toBe(TEST_ADDRESSES.DAI); // token
    });

    it('should encode the correct amount', () => {
      const request = createValidRequest();

      const calldata = provider.buildCalldata(request);

      const iface = new ethers.Interface([
        'function flashLoan(address receiver, address token, uint256 amount, bytes calldata data) external returns (bool)',
      ]);
      const decoded = iface.decodeFunctionData('flashLoan', calldata);

      expect(decoded[2]).toBe(request.amount); // amount
    });

    it('should encode inner data with swap path, minProfit, and deadline', () => {
      const request = createValidRequest();

      const calldata = provider.buildCalldata(request);

      const iface = new ethers.Interface([
        'function flashLoan(address receiver, address token, uint256 amount, bytes calldata data) external returns (bool)',
      ]);
      const decoded = iface.decodeFunctionData('flashLoan', calldata);

      // The data field (decoded[3]) should be non-empty bytes
      const innerData = decoded[3];
      expect(innerData).toBeDefined();
      expect(innerData.length).toBeGreaterThan(0);

      // Decode inner data: tuple(address,address,address,uint256)[], uint256, uint256
      const innerDecoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ['tuple(address,address,address,uint256)[]', 'uint256', 'uint256'],
        innerData
      );

      // Verify swap path
      expect(innerDecoded[0].length).toBe(2);
      expect(innerDecoded[0][0][0]).toBe(TEST_ADDRESSES.ROUTER_UNISWAP); // router
      expect(innerDecoded[0][0][1]).toBe(TEST_ADDRESSES.DAI); // tokenIn

      // Verify minProfit
      expect(innerDecoded[1]).toBe(request.minProfit);

      // Verify deadline is in the future
      expect(Number(innerDecoded[2])).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });
  });

  describe('buildTransaction', () => {
    it('should build transaction with correct structure', () => {
      const request = createValidRequest();
      const from = TEST_ADDRESSES.INITIATOR;

      const tx = provider.buildTransaction(request, from);

      expect(tx.to).toBe(TEST_ADDRESSES.DSS_FLASH); // Goes to DssFlash, not contract
      expect(tx.from).toBe(from);
      expect(tx.data).toBeDefined();
      expect(typeof tx.data).toBe('string');
    });

    it('should use buildCalldata for transaction data', () => {
      const request = createValidRequest();
      const from = TEST_ADDRESSES.INITIATOR;

      const calldata = provider.buildCalldata(request);
      const tx = provider.buildTransaction(request, from);

      expect(tx.data).toBe(calldata);
    });

    it('should set `to` field to DssFlash address (not contract)', () => {
      const request = createValidRequest();
      const from = TEST_ADDRESSES.INITIATOR;

      const tx = provider.buildTransaction(request, from);

      // DAI flash mint calls DssFlash directly
      expect(tx.to).toBe(TEST_ADDRESSES.DSS_FLASH);
    });

    it('should build transaction for different initiator', () => {
      const request = createValidRequest();
      const alternateFrom = '0x9999999999999999999999999999999999999999';

      const tx = provider.buildTransaction(request, alternateFrom);

      expect(tx.from).toBe(alternateFrom);
      expect(tx.to).toBe(TEST_ADDRESSES.DSS_FLASH);
    });
  });
});

// =============================================================================
// Gas Estimation Tests
// =============================================================================

describe('DaiFlashMintProvider - Gas Estimation', () => {
  let provider: DaiFlashMintProvider;

  beforeEach(() => {
    const config = createValidConfig();
    provider = new DaiFlashMintProvider(config);
  });

  describe('estimateGas', () => {
    it('should return gas estimate from provider', async () => {
      const request = createValidRequest();
      const mockProvider = createMockProvider(500000n);

      const gasEstimate = await provider.estimateGas(request, mockProvider);

      expect(gasEstimate).toBe(500000n);
      expect(mockProvider.estimateGas).toHaveBeenCalledTimes(1);
    });

    it('should return default estimate (450k) on estimation failure', async () => {
      const request = createValidRequest();
      const mockProvider = createMockProvider(undefined, true); // Will throw

      const gasEstimate = await provider.estimateGas(request, mockProvider);

      expect(gasEstimate).toBe(450000n);
    });

    it('should handle network errors gracefully', async () => {
      const request = createValidRequest();
      const mockProvider = {
        estimateGas: jest.fn().mockRejectedValue(new Error('Network timeout')),
      } as unknown as ethers.JsonRpcProvider;

      const gasEstimate = await provider.estimateGas(request, mockProvider);

      expect(gasEstimate).toBe(450000n); // Default fallback
    });
  });
});

// =============================================================================
// Integration Tests
// =============================================================================

describe('DaiFlashMintProvider - Integration Scenarios', () => {
  describe('complete arbitrage flow', () => {
    it('should validate, build calldata, and estimate gas for valid request', async () => {
      const config = createValidConfig();
      const provider = new DaiFlashMintProvider(config);
      const request = createValidRequest();
      const mockProvider = createMockProvider(480000n);

      // Step 1: Validate
      const validation = provider.validate(request);
      expect(validation.valid).toBe(true);

      // Step 2: Calculate fee
      const feeInfo = provider.calculateFee(request.amount);
      expect(feeInfo.feeAmount).toBeGreaterThan(0n);
      expect(feeInfo.feeBps).toBe(1); // 1 bps

      // Step 3: Build transaction
      const tx = provider.buildTransaction(request, request.initiator);
      expect(tx.to).toBe(config.poolAddress);

      // Step 4: Estimate gas
      const gasEstimate = await provider.estimateGas(request, mockProvider);
      expect(gasEstimate).toBe(480000n);
    });

    it('should handle validation failure before building transaction', () => {
      const config = createValidConfig();
      const provider = new DaiFlashMintProvider(config);
      const invalidRequest = createValidRequest({ asset: TEST_ADDRESSES.WETH }); // Wrong asset

      // Validate first
      const validation = provider.validate(invalidRequest);
      expect(validation.valid).toBe(false);
      expect(validation.error).toContain('[ERR_ASSET_NOT_DAI]');
    });
  });

  describe('DAI-specific characteristics', () => {
    it('should have the lowest fee of all flash loan providers (1 bps)', () => {
      const config = createValidConfig();
      const provider = new DaiFlashMintProvider(config);

      const feeInfo = provider.calculateFee(ethers.parseEther('100000'));

      // 1 bps is the lowest fee available
      expect(feeInfo.feeBps).toBe(1);
      expect(feeInfo.feeAmount).toBe(ethers.parseEther('10')); // 0.01% of 100000
    });

    it('should only support DAI in capabilities', () => {
      const config = createValidConfig();
      const provider = new DaiFlashMintProvider(config);

      const capabilities = provider.getCapabilities();

      expect(capabilities.supportsMultiAsset).toBe(false);
      expect(capabilities.supportedTokens).toEqual([TEST_ADDRESSES.DAI]);
    });

    it('should only be available on ethereum', () => {
      const ethereumProvider = new DaiFlashMintProvider(createValidConfig({ chain: 'ethereum' }));
      const arbitrumProvider = new DaiFlashMintProvider(createValidConfig({ chain: 'arbitrum' }));
      const bscProvider = new DaiFlashMintProvider(createValidConfig({ chain: 'bsc' }));

      expect(ethereumProvider.isAvailable()).toBe(true);
      expect(arbitrumProvider.isAvailable()).toBe(false);
      expect(bscProvider.isAvailable()).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle maximum uint256 loan amount', () => {
      const config = createValidConfig();
      const provider = new DaiFlashMintProvider(config);
      const maxUint256 = 2n ** 256n - 1n;

      const feeInfo = provider.calculateFee(maxUint256);

      // Fee should not overflow
      expect(feeInfo.feeAmount).toBeLessThanOrEqual(maxUint256);
    });

    it('should handle single-step swap path', () => {
      const config = createValidConfig();
      const provider = new DaiFlashMintProvider(config);
      const request = createValidRequest({
        swapPath: [
          {
            router: TEST_ADDRESSES.ROUTER_UNISWAP,
            tokenIn: TEST_ADDRESSES.DAI,
            tokenOut: TEST_ADDRESSES.DAI, // Same token (artificial case)
            amountOutMin: ethers.parseEther('10100'),
          },
        ] as FlashLoanSwapStep[],
      });

      const validation = provider.validate(request);
      expect(validation.valid).toBe(true);

      const calldata = provider.buildCalldata(request);
      expect(calldata).toBeDefined();
    });
  });
});
