/**
 * Unit Tests for BalancerV2FlashLoanProvider
 *
 * Tests the Balancer V2 flash loan provider implementation.
 * Covers initialization, validation, fee calculation (0% fee), calldata building,
 * gas estimation, and integration with Balancer V2 Vault.
 *
 * Testing patterns follow CLAUDE.md:
 * - Constructor pattern for DI (allows proper mock injection)
 * - Mocks set up in beforeEach()
 * - Direct imports from source files (not barrel exports)
 * - Local createMockDeps() helper for consistent dependency injection
 *
 * @see balancer-v2.provider.ts
 * @see contracts/src/BalancerV2FlashArbitrage.sol
 */

import { ethers } from 'ethers';
import { BalancerV2FlashLoanProvider } from '../../../../src/strategies/flash-loan-providers/balancer-v2.provider';
import type {
  FlashLoanRequest,
  FlashLoanSwapStep,
} from '../../../../src/strategies/flash-loan-providers/types';

// Mock @arbitrage/config to prevent deep import chain
// IMPORTANT: Use inline literal (not const variable) because jest.mock() is hoisted
// above const declarations, causing temporal dead zone errors when the provider
// module calls getBpsDenominatorBigInt() at import time.
jest.mock('@arbitrage/config', () => ({
  __esModule: true,
  BALANCER_V2_FEE_BPS: 0,
  getBpsDenominatorBigInt: () => BigInt(10000),
  BALANCER_V2_FLASH_ARBITRAGE_ABI: [
    'function executeArbitrage(address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath, uint256 minProfit, uint256 deadline) external',
    'function calculateExpectedProfit(address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath) external view returns (uint256 expectedProfit, uint256 flashLoanFee)',
    'function isApprovedRouter(address router) external view returns (bool)',
    'function VAULT() external view returns (address)',
  ],
}));

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
  VAULT: '0xBA12222222228d8Ba445958a75a0704d566BF2C8', // Balancer V2 Vault
  CONTRACT: '0x1234567890123456789012345678901234567890', // Flash arbitrage contract
  ROUTER_UNISWAP: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', // Uniswap V3 Router
  ROUTER_SUSHISWAP: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F', // SushiSwap Router
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH on Ethereum
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC on Ethereum
  DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F', // DAI on Ethereum
  INITIATOR: '0xabcdef0123456789abcdef0123456789abcdef01', // User address
  ZERO_ADDRESS: '0x0000000000000000000000000000000000000000',
};

/**
 * Create a valid flash loan request for testing
 */
// W1-19 FIX: Uses realistic amountOutMin values (0.5% slippage) instead of 0n.
const createValidRequest = (overrides?: Partial<FlashLoanRequest>): FlashLoanRequest => ({
  asset: TEST_ADDRESSES.WETH,
  amount: ethers.parseEther('10'), // 10 ETH
  chain: 'ethereum',
  swapPath: [
    {
      router: TEST_ADDRESSES.ROUTER_UNISWAP,
      tokenIn: TEST_ADDRESSES.WETH,
      tokenOut: TEST_ADDRESSES.USDC,
      amountOutMin: ethers.parseUnits('24875', 6), // ~$2500/ETH * 10 * 0.995 (USDC 6 decimals)
    },
    {
      router: TEST_ADDRESSES.ROUTER_UNISWAP,
      tokenIn: TEST_ADDRESSES.USDC,
      tokenOut: TEST_ADDRESSES.WETH,
      amountOutMin: ethers.parseEther('9.95'), // 10 ETH * 0.995 slippage
    },
  ] as FlashLoanSwapStep[],
  minProfit: ethers.parseEther('0.1'), // 0.1 ETH minimum profit
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
  poolAddress: TEST_ADDRESSES.VAULT,
  contractAddress: TEST_ADDRESSES.CONTRACT,
  approvedRouters: [TEST_ADDRESSES.ROUTER_UNISWAP, TEST_ADDRESSES.ROUTER_SUSHISWAP],
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
      return estimateGasResult ?? 550000n;
    }),
  } as unknown as ethers.JsonRpcProvider;
};

// =============================================================================
// Constructor and Initialization Tests
// =============================================================================

describe('BalancerV2FlashLoanProvider - Constructor and Initialization', () => {
  describe('constructor', () => {
    it('should create provider with valid configuration', () => {
      const config = createValidConfig();
      const provider = new BalancerV2FlashLoanProvider(config);

      expect(provider).toBeDefined();
      expect(provider.protocol).toBe('balancer_v2');
      expect(provider.chain).toBe('ethereum');
      expect(provider.poolAddress).toBe(TEST_ADDRESSES.VAULT);
    });

    it('should accept empty approved routers list', () => {
      const config = createValidConfig({ approvedRouters: [] });
      const provider = new BalancerV2FlashLoanProvider(config);

      expect(provider).toBeDefined();
      expect(provider.getApprovedRouters()).toEqual([]);
    });

    it('should accept fee override', () => {
      const config = createValidConfig({ feeOverride: 10 }); // 0.1%
      const provider = new BalancerV2FlashLoanProvider(config);

      const feeInfo = provider.calculateFee(ethers.parseEther('1000'));
      expect(feeInfo.feeBps).toBe(10);
    });

    it('should throw error for invalid contract address', () => {
      const config = createValidConfig({ contractAddress: 'invalid-address' });

      expect(() => new BalancerV2FlashLoanProvider(config)).toThrow(
        '[ERR_CONFIG] Invalid contract address for Balancer V2 provider on ethereum'
      );
    });

    it('should throw error for invalid vault address', () => {
      const config = createValidConfig({ poolAddress: 'invalid-vault' });

      expect(() => new BalancerV2FlashLoanProvider(config)).toThrow(
        '[ERR_CONFIG] Invalid vault address for Balancer V2 provider on ethereum'
      );
    });

    it('should validate both contract and vault addresses', () => {
      const config = createValidConfig({
        contractAddress: 'bad-contract',
        poolAddress: 'bad-vault',
      });

      // Should throw on first invalid address (contract)
      expect(() => new BalancerV2FlashLoanProvider(config)).toThrow('[ERR_CONFIG]');
    });
  });

  describe('isAvailable', () => {
    it('should return true for valid contract address', () => {
      const config = createValidConfig();
      const provider = new BalancerV2FlashLoanProvider(config);

      expect(provider.isAvailable()).toBe(true);
    });

    it('should return false for zero address', () => {
      const config = createValidConfig({ contractAddress: TEST_ADDRESSES.ZERO_ADDRESS });
      const provider = new BalancerV2FlashLoanProvider(config);

      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe('getCapabilities', () => {
    it('should return correct capabilities', () => {
      const config = createValidConfig();
      const provider = new BalancerV2FlashLoanProvider(config);

      const capabilities = provider.getCapabilities();

      expect(capabilities.supportsMultiHop).toBe(true);
      expect(capabilities.supportsMultiAsset).toBe(false);
      expect(capabilities.maxLoanAmount).toBe(0n);
      expect(capabilities.supportedTokens).toEqual([]);
      expect(capabilities.status).toBe('fully_supported');
    });
  });

  describe('protocol and chain properties', () => {
    it('should expose protocol as readonly', () => {
      const config = createValidConfig();
      const provider = new BalancerV2FlashLoanProvider(config);

      expect(provider.protocol).toBe('balancer_v2');
    });

    it('should expose chain as readonly', () => {
      const config = createValidConfig();
      const provider = new BalancerV2FlashLoanProvider(config);

      expect(provider.chain).toBe('ethereum');
    });

    it('should expose poolAddress (vault) as readonly', () => {
      const config = createValidConfig();
      const provider = new BalancerV2FlashLoanProvider(config);

      expect(provider.poolAddress).toBe(TEST_ADDRESSES.VAULT);
    });
  });

  describe('getter methods', () => {
    it('should return contract address', () => {
      const config = createValidConfig();
      const provider = new BalancerV2FlashLoanProvider(config);

      expect(provider.getContractAddress()).toBe(TEST_ADDRESSES.CONTRACT);
    });

    it('should return copy of approved routers (not reference)', () => {
      const config = createValidConfig();
      const provider = new BalancerV2FlashLoanProvider(config);

      const routers1 = provider.getApprovedRouters();
      const routers2 = provider.getApprovedRouters();

      expect(routers1).toEqual(routers2);
      expect(routers1).not.toBe(routers2); // Different array instances
    });

    it('should return vault address', () => {
      const config = createValidConfig();
      const provider = new BalancerV2FlashLoanProvider(config);

      expect(provider.getVaultAddress()).toBe(TEST_ADDRESSES.VAULT);
    });
  });
});

// =============================================================================
// Fee Calculation Tests
// =============================================================================

describe('BalancerV2FlashLoanProvider - Fee Calculation', () => {
  let provider: BalancerV2FlashLoanProvider;

  beforeEach(() => {
    const config = createValidConfig();
    provider = new BalancerV2FlashLoanProvider(config);
  });

  describe('calculateFee', () => {
    it('should calculate zero fee for standard amount (0 bps = 0%)', () => {
      const amount = ethers.parseEther('1000'); // 1000 ETH

      const feeInfo = provider.calculateFee(amount);

      expect(feeInfo.feeBps).toBe(0);
      expect(feeInfo.feeAmount).toBe(0n); // 0% fee
      expect(feeInfo.protocol).toBe('balancer_v2');
    });

    it('should calculate zero fee for 1 ETH', () => {
      const amount = ethers.parseEther('1');

      const feeInfo = provider.calculateFee(amount);

      expect(feeInfo.feeAmount).toBe(0n);
    });

    it('should calculate zero fee for 10 ETH', () => {
      const amount = ethers.parseEther('10');

      const feeInfo = provider.calculateFee(amount);

      expect(feeInfo.feeAmount).toBe(0n);
    });

    it('should handle very small amounts with zero fee', () => {
      const amount = 1000n; // 1000 wei

      const feeInfo = provider.calculateFee(amount);

      expect(feeInfo.feeAmount).toBe(0n);
    });

    it('should handle very large amounts with zero fee', () => {
      const amount = ethers.parseEther('1000000'); // 1 million ETH

      const feeInfo = provider.calculateFee(amount);

      expect(feeInfo.feeAmount).toBe(0n);
    });

    it('should handle zero amount', () => {
      const amount = 0n;

      const feeInfo = provider.calculateFee(amount);

      expect(feeInfo.feeAmount).toBe(0n);
    });

    it('should use fee override when provided', () => {
      const config = createValidConfig({ feeOverride: 10 }); // 0.1%
      const overrideProvider = new BalancerV2FlashLoanProvider(config);
      const amount = ethers.parseEther('1000');

      const feeInfo = overrideProvider.calculateFee(amount);

      expect(feeInfo.feeBps).toBe(10);
      expect(feeInfo.feeAmount).toBe(ethers.parseEther('1')); // 0.1% of 1000 = 1 ETH
    });

    it('should allow zero fee override (matches default)', () => {
      const config = createValidConfig({ feeOverride: 0 });
      const overrideProvider = new BalancerV2FlashLoanProvider(config);
      const amount = ethers.parseEther('1000');

      const feeInfo = overrideProvider.calculateFee(amount);

      expect(feeInfo.feeBps).toBe(0);
      expect(feeInfo.feeAmount).toBe(0n);
    });
  });
});

// =============================================================================
// Validation Tests
// =============================================================================

describe('BalancerV2FlashLoanProvider - Request Validation', () => {
  let provider: BalancerV2FlashLoanProvider;

  beforeEach(() => {
    const config = createValidConfig();
    provider = new BalancerV2FlashLoanProvider(config);
  });

  describe('validate - success cases', () => {
    it('should validate a correct request', () => {
      const request = createValidRequest();

      const result = provider.validate(request);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should validate multi-hop swap path', () => {
      const request = createValidRequest({
        swapPath: [
          {
            router: TEST_ADDRESSES.ROUTER_UNISWAP,
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: ethers.parseUnits('24875', 6),
          },
          {
            router: TEST_ADDRESSES.ROUTER_SUSHISWAP,
            tokenIn: TEST_ADDRESSES.USDC,
            tokenOut: TEST_ADDRESSES.DAI,
            amountOutMin: ethers.parseEther('24875'),
          },
          {
            router: TEST_ADDRESSES.ROUTER_UNISWAP,
            tokenIn: TEST_ADDRESSES.DAI,
            tokenOut: TEST_ADDRESSES.WETH,
            amountOutMin: ethers.parseEther('9.95'),
          },
        ] as FlashLoanSwapStep[],
      });

      const result = provider.validate(request);

      expect(result.valid).toBe(true);
    });

    it('should validate with empty approved routers list (allows all routers)', () => {
      const config = createValidConfig({ approvedRouters: [] });
      const permissiveProvider = new BalancerV2FlashLoanProvider(config);
      const request = createValidRequest({
        swapPath: [
          {
            router: '0x9999999999999999999999999999999999999999',
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: ethers.parseUnits('24875', 6),
          },
          {
            router: '0x8888888888888888888888888888888888888888',
            tokenIn: TEST_ADDRESSES.USDC,
            tokenOut: TEST_ADDRESSES.WETH,
            amountOutMin: ethers.parseEther('9.95'),
          },
        ] as FlashLoanSwapStep[],
      });

      const result = permissiveProvider.validate(request);

      expect(result.valid).toBe(true);
    });
  });

  describe('validate - chain mismatch', () => {
    it('should reject request with wrong chain', () => {
      const request = createValidRequest({ chain: 'arbitrum' });

      const result = provider.validate(request);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_CHAIN_MISMATCH]');
      expect(result.error).toContain('arbitrum');
      expect(result.error).toContain('ethereum');
    });
  });

  describe('validate - invalid asset', () => {
    it('should reject invalid asset address', () => {
      const request = createValidRequest({ asset: 'not-an-address' });

      const result = provider.validate(request);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_INVALID_ASSET]');
    });

    it('should reject empty asset address', () => {
      const request = createValidRequest({ asset: '' });

      const result = provider.validate(request);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_INVALID_ASSET]');
    });
  });

  describe('validate - zero amount', () => {
    it('should reject zero loan amount', () => {
      const request = createValidRequest({ amount: 0n });

      const result = provider.validate(request);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_ZERO_AMOUNT]');
    });
  });

  describe('validate - empty swap path', () => {
    it('should reject empty swap path', () => {
      const request = createValidRequest({ swapPath: [] });

      const result = provider.validate(request);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_EMPTY_PATH]');
    });
  });

  describe('validate - invalid routers', () => {
    it('should reject swap path with invalid router address', () => {
      const request = createValidRequest({
        swapPath: [
          {
            router: 'invalid-router',
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: 1n,
          },
          {
            router: TEST_ADDRESSES.ROUTER_UNISWAP,
            tokenIn: TEST_ADDRESSES.USDC,
            tokenOut: TEST_ADDRESSES.WETH,
            amountOutMin: ethers.parseEther('9.95'),
          },
        ] as FlashLoanSwapStep[],
      });

      const result = provider.validate(request);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_INVALID_ROUTER]');
      expect(result.error).toContain('invalid-router');
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
            amountOutMin: ethers.parseEther('9.95'),
          },
        ] as FlashLoanSwapStep[],
      });

      const result = provider.validate(request);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_UNAPPROVED_ROUTER]');
      expect(result.error).toContain('0x9999999999999999999999999999999999999999');
    });

    it('should accept approved routers (case-insensitive)', () => {
      const request = createValidRequest({
        swapPath: [
          {
            router: '0x' + TEST_ADDRESSES.ROUTER_UNISWAP.slice(2).toUpperCase(),
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: ethers.parseUnits('24875', 6),
          },
          {
            router: TEST_ADDRESSES.ROUTER_SUSHISWAP.toLowerCase(),
            tokenIn: TEST_ADDRESSES.USDC,
            tokenOut: TEST_ADDRESSES.WETH,
            amountOutMin: ethers.parseEther('9.95'),
          },
        ] as FlashLoanSwapStep[],
      });

      const result = provider.validate(request);

      expect(result.valid).toBe(true);
    });
  });

  describe('validate - invalid cycle', () => {
    it('should reject path that does not end with starting token', () => {
      const request = createValidRequest({
        swapPath: [
          {
            router: TEST_ADDRESSES.ROUTER_UNISWAP,
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: ethers.parseUnits('24875', 6),
          },
          {
            router: TEST_ADDRESSES.ROUTER_UNISWAP,
            tokenIn: TEST_ADDRESSES.USDC,
            tokenOut: TEST_ADDRESSES.DAI, // Ends with DAI, not WETH
            amountOutMin: ethers.parseEther('24875'),
          },
        ] as FlashLoanSwapStep[],
      });

      const result = provider.validate(request);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_INVALID_CYCLE]');
    });
  });

  describe('validate - asset mismatch', () => {
    it('should reject when first swap token does not match asset', () => {
      const request = createValidRequest({
        asset: TEST_ADDRESSES.WETH,
        swapPath: [
          {
            router: TEST_ADDRESSES.ROUTER_UNISWAP,
            tokenIn: TEST_ADDRESSES.USDC,
            tokenOut: TEST_ADDRESSES.DAI,
            amountOutMin: 1n,
          },
          {
            router: TEST_ADDRESSES.ROUTER_UNISWAP,
            tokenIn: TEST_ADDRESSES.DAI,
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: 1n,
          },
        ] as FlashLoanSwapStep[],
      });

      const result = provider.validate(request);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_ASSET_MISMATCH]');
    });
  });
});

// =============================================================================
// Calldata and Transaction Building Tests
// =============================================================================

describe('BalancerV2FlashLoanProvider - Calldata and Transaction Building', () => {
  let provider: BalancerV2FlashLoanProvider;

  beforeEach(() => {
    const config = createValidConfig();
    provider = new BalancerV2FlashLoanProvider(config);
  });

  describe('buildCalldata', () => {
    it('should build correct calldata for simple swap path', () => {
      const request = createValidRequest();

      const calldata = provider.buildCalldata(request);

      expect(calldata).toBeDefined();
      expect(typeof calldata).toBe('string');
      expect(calldata.startsWith('0x')).toBe(true);
      expect(calldata.length).toBeGreaterThan(10);
    });

    it('should build calldata with deadline parameter', () => {
      const request = createValidRequest();

      const calldata = provider.buildCalldata(request);

      const iface = new ethers.Interface([
        'function executeArbitrage(address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath, uint256 minProfit, uint256 deadline) external',
      ]);

      const decoded = iface.decodeFunctionData('executeArbitrage', calldata);

      expect(decoded[0]).toBe(request.asset); // asset
      expect(decoded[1]).toBe(request.amount); // amount
      expect(decoded[3]).toBe(request.minProfit); // minProfit
      expect(Number(decoded[4])).toBeGreaterThan(Math.floor(Date.now() / 1000)); // deadline in future
    });

    it('should encode swap path correctly', () => {
      const request = createValidRequest();

      const calldata = provider.buildCalldata(request);

      const iface = new ethers.Interface([
        'function executeArbitrage(address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath, uint256 minProfit, uint256 deadline) external',
      ]);

      const decoded = iface.decodeFunctionData('executeArbitrage', calldata);
      const swapPath = decoded[2];

      expect(swapPath.length).toBe(2);
      expect(swapPath[0][0]).toBe(TEST_ADDRESSES.ROUTER_UNISWAP);
      expect(swapPath[0][1]).toBe(TEST_ADDRESSES.WETH);
      expect(swapPath[0][2]).toBe(TEST_ADDRESSES.USDC);
      expect(swapPath[1][0]).toBe(TEST_ADDRESSES.ROUTER_UNISWAP);
      expect(swapPath[1][1]).toBe(TEST_ADDRESSES.USDC);
      expect(swapPath[1][2]).toBe(TEST_ADDRESSES.WETH);
    });

    it('should handle multi-hop swap path', () => {
      const request = createValidRequest({
        swapPath: [
          {
            router: TEST_ADDRESSES.ROUTER_UNISWAP,
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: ethers.parseUnits('10000', 6),
          },
          {
            router: TEST_ADDRESSES.ROUTER_SUSHISWAP,
            tokenIn: TEST_ADDRESSES.USDC,
            tokenOut: TEST_ADDRESSES.DAI,
            amountOutMin: ethers.parseEther('9900'),
          },
          {
            router: TEST_ADDRESSES.ROUTER_UNISWAP,
            tokenIn: TEST_ADDRESSES.DAI,
            tokenOut: TEST_ADDRESSES.WETH,
            amountOutMin: ethers.parseEther('10.1'),
          },
        ] as FlashLoanSwapStep[],
      });

      const calldata = provider.buildCalldata(request);

      const iface = new ethers.Interface([
        'function executeArbitrage(address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath, uint256 minProfit, uint256 deadline) external',
      ]);

      const decoded = iface.decodeFunctionData('executeArbitrage', calldata);
      const swapPath = decoded[2];

      expect(swapPath.length).toBe(3);
      expect(swapPath[0][3]).toBe(ethers.parseUnits('10000', 6));
      expect(swapPath[1][3]).toBe(ethers.parseEther('9900'));
      expect(swapPath[2][3]).toBe(ethers.parseEther('10.1'));
    });

    it('should set deadline to 5 minutes in future', () => {
      const request = createValidRequest();
      const beforeTimestamp = Math.floor(Date.now() / 1000);

      const calldata = provider.buildCalldata(request);

      const iface = new ethers.Interface([
        'function executeArbitrage(address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath, uint256 minProfit, uint256 deadline) external',
      ]);

      const decoded = iface.decodeFunctionData('executeArbitrage', calldata);
      const deadline = Number(decoded[4]);
      const afterTimestamp = Math.floor(Date.now() / 1000);

      expect(deadline).toBeGreaterThanOrEqual(beforeTimestamp + 299);
      expect(deadline).toBeLessThanOrEqual(afterTimestamp + 301);
    });
  });

  describe('buildTransaction', () => {
    it('should build transaction with correct structure', () => {
      const request = createValidRequest();
      const from = TEST_ADDRESSES.INITIATOR;

      const tx = provider.buildTransaction(request, from);

      expect(tx.to).toBe(TEST_ADDRESSES.CONTRACT);
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

    it('should build transaction for different initiator', () => {
      const request = createValidRequest();
      const alternateFrom = '0x9999999999999999999999999999999999999999';

      const tx = provider.buildTransaction(request, alternateFrom);

      expect(tx.from).toBe(alternateFrom);
      expect(tx.to).toBe(TEST_ADDRESSES.CONTRACT);
    });
  });
});

// =============================================================================
// Gas Estimation Tests
// =============================================================================

describe('BalancerV2FlashLoanProvider - Gas Estimation', () => {
  let provider: BalancerV2FlashLoanProvider;

  beforeEach(() => {
    const config = createValidConfig();
    provider = new BalancerV2FlashLoanProvider(config);
  });

  describe('estimateGas', () => {
    it('should return gas estimate from provider', async () => {
      const request = createValidRequest();
      const mockProvider = createMockProvider(600000n);

      const gasEstimate = await provider.estimateGas(request, mockProvider);

      expect(gasEstimate).toBe(600000n);
      expect(mockProvider.estimateGas).toHaveBeenCalledTimes(1);
    });

    it('should call estimateGas with correct transaction', async () => {
      const request = createValidRequest();
      const mockProvider = createMockProvider();

      await provider.estimateGas(request, mockProvider);

      const expectedTx = provider.buildTransaction(request, request.initiator);
      expect(mockProvider.estimateGas).toHaveBeenCalledWith(expectedTx);
    });

    it('should return default estimate (550k) on estimation failure', async () => {
      const request = createValidRequest();
      const mockProvider = createMockProvider(undefined, true);

      const gasEstimate = await provider.estimateGas(request, mockProvider);

      expect(gasEstimate).toBe(550000n);
    });

    it('should handle network errors gracefully', async () => {
      const request = createValidRequest();
      const mockProvider = {
        estimateGas: jest.fn().mockRejectedValue(new Error('Network timeout')),
      } as unknown as ethers.JsonRpcProvider;

      const gasEstimate = await provider.estimateGas(request, mockProvider);

      expect(gasEstimate).toBe(550000n); // Default fallback
    });

    it('should return different estimates for different requests', async () => {
      const request1 = createValidRequest();
      const request2 = createValidRequest({
        amount: ethers.parseEther('100'),
      });

      const mockProvider1 = createMockProvider(500000n);
      const mockProvider2 = createMockProvider(700000n);

      const gas1 = await provider.estimateGas(request1, mockProvider1);
      const gas2 = await provider.estimateGas(request2, mockProvider2);

      expect(gas1).toBe(500000n);
      expect(gas2).toBe(700000n);
    });
  });
});

// =============================================================================
// Integration Tests
// =============================================================================

describe('BalancerV2FlashLoanProvider - Integration Scenarios', () => {
  describe('complete arbitrage flow', () => {
    it('should validate, build calldata, and estimate gas for valid request', async () => {
      const config = createValidConfig();
      const provider = new BalancerV2FlashLoanProvider(config);
      const request = createValidRequest();
      const mockProvider = createMockProvider(580000n);

      // Step 1: Validate
      const validation = provider.validate(request);
      expect(validation.valid).toBe(true);

      // Step 2: Calculate fee (should be 0 for Balancer V2)
      const feeInfo = provider.calculateFee(request.amount);
      expect(feeInfo.feeAmount).toBe(0n); // Zero fee!

      // Step 3: Build transaction
      const tx = provider.buildTransaction(request, request.initiator);
      expect(tx.to).toBe(config.contractAddress);

      // Step 4: Estimate gas
      const gasEstimate = await provider.estimateGas(request, mockProvider);
      expect(gasEstimate).toBe(580000n);
    });

    it('should handle validation failure before building transaction', () => {
      const config = createValidConfig();
      const provider = new BalancerV2FlashLoanProvider(config);
      const invalidRequest = createValidRequest({ chain: 'polygon' });

      const validation = provider.validate(invalidRequest);
      expect(validation.valid).toBe(false);

      // Provider doesn't enforce validation in build methods
      const tx = provider.buildTransaction(invalidRequest, invalidRequest.initiator);
      expect(tx).toBeDefined();
    });
  });

  describe('multi-chain configuration', () => {
    it('should create separate providers for different chains', () => {
      const ethConfig = createValidConfig({ chain: 'ethereum' });
      const polyConfig = createValidConfig({ chain: 'polygon' });

      const ethProvider = new BalancerV2FlashLoanProvider(ethConfig);
      const polyProvider = new BalancerV2FlashLoanProvider(polyConfig);

      expect(ethProvider.chain).toBe('ethereum');
      expect(polyProvider.chain).toBe('polygon');
      expect(ethProvider).not.toBe(polyProvider);
    });
  });

  describe('edge cases and boundaries', () => {
    it('should handle maximum uint256 loan amount with zero fee', () => {
      const config = createValidConfig();
      const provider = new BalancerV2FlashLoanProvider(config);
      const maxUint256 = 2n ** 256n - 1n;

      const feeInfo = provider.calculateFee(maxUint256);

      expect(feeInfo.feeAmount).toBe(0n); // Zero fee regardless of amount
    });

    it('should handle single-step swap path (direct arbitrage)', () => {
      const config = createValidConfig();
      const provider = new BalancerV2FlashLoanProvider(config);
      const request = createValidRequest({
        swapPath: [
          {
            router: TEST_ADDRESSES.ROUTER_UNISWAP,
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.WETH,
            amountOutMin: ethers.parseEther('10.1'),
          },
        ] as FlashLoanSwapStep[],
      });

      const validation = provider.validate(request);
      expect(validation.valid).toBe(true);

      const calldata = provider.buildCalldata(request);
      expect(calldata).toBeDefined();
    });

    it('should handle very long swap path', () => {
      const config = createValidConfig();
      const provider = new BalancerV2FlashLoanProvider(config);

      const longPath: FlashLoanSwapStep[] = [];
      const tokens = [
        TEST_ADDRESSES.WETH,
        TEST_ADDRESSES.USDC,
        TEST_ADDRESSES.DAI,
        TEST_ADDRESSES.USDC,
        TEST_ADDRESSES.DAI,
        TEST_ADDRESSES.USDC,
        TEST_ADDRESSES.DAI,
        TEST_ADDRESSES.USDC,
        TEST_ADDRESSES.DAI,
        TEST_ADDRESSES.USDC,
        TEST_ADDRESSES.WETH,
      ];

      for (let i = 0; i < tokens.length - 1; i++) {
        longPath.push({
          router: TEST_ADDRESSES.ROUTER_UNISWAP,
          tokenIn: tokens[i],
          tokenOut: tokens[i + 1],
          amountOutMin: 1n,
        });
      }

      const request = createValidRequest({ swapPath: longPath });

      const validation = provider.validate(request);
      expect(validation.valid).toBe(true);

      const calldata = provider.buildCalldata(request);
      expect(calldata.length).toBeGreaterThan(1000);
    });
  });

  describe('Balancer V2 specific behavior', () => {
    it('should always return zero fee regardless of amount', () => {
      const config = createValidConfig();
      const provider = new BalancerV2FlashLoanProvider(config);

      const amounts = [
        1n,
        1000n,
        ethers.parseEther('1'),
        ethers.parseEther('1000'),
        ethers.parseEther('1000000'),
      ];

      for (const amount of amounts) {
        const feeInfo = provider.calculateFee(amount);
        expect(feeInfo.feeAmount).toBe(0n);
        expect(feeInfo.feeBps).toBe(0);
      }
    });

    it('should return vault address from getVaultAddress() which equals poolAddress', () => {
      const config = createValidConfig();
      const provider = new BalancerV2FlashLoanProvider(config);

      expect(provider.getVaultAddress()).toBe(TEST_ADDRESSES.VAULT);
      expect(provider.getVaultAddress()).toBe(provider.poolAddress);
    });

    it('should have higher default gas fallback (550k) than Aave V3 (500k) due to Vault architecture', async () => {
      const config = createValidConfig();
      const provider = new BalancerV2FlashLoanProvider(config);
      const request = createValidRequest();
      const failingProvider = createMockProvider(undefined, true);

      const gasEstimate = await provider.estimateGas(request, failingProvider);

      // Balancer V2 default is 550k (vs 500k for Aave V3)
      expect(gasEstimate).toBe(550000n);
    });
  });

  describe('supported chains', () => {
    const SUPPORTED_CHAINS = ['ethereum', 'polygon', 'arbitrum', 'optimism', 'base', 'fantom'];

    it.each(SUPPORTED_CHAINS)('should create provider for %s', (chain) => {
      const config = createValidConfig({ chain });
      const provider = new BalancerV2FlashLoanProvider(config);

      expect(provider.chain).toBe(chain);
      expect(provider.protocol).toBe('balancer_v2');
      expect(provider.isAvailable()).toBe(true);
    });

    it('should create provider for any chain string (provider does not restrict chains)', () => {
      const config = createValidConfig({ chain: 'custom-chain' });
      const provider = new BalancerV2FlashLoanProvider(config);

      expect(provider.chain).toBe('custom-chain');
    });
  });

  describe('constructor router normalization', () => {
    it('should lowercase approved routers in internal set for O(1) lookup', () => {
      const mixedCaseRouters = [
        '0x68B3465833Fb72A70ecDF485E0e4C7bD8665Fc45',
        '0xD9E1CE17F2641F24Ae83637AB66A2CCA9C378B9F',
      ];
      const config = createValidConfig({ approvedRouters: mixedCaseRouters });
      const provider = new BalancerV2FlashLoanProvider(config);

      const request = createValidRequest({
        swapPath: [
          {
            router: mixedCaseRouters[0].toLowerCase(),
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: ethers.parseUnits('24875', 6),
          },
          {
            router: mixedCaseRouters[1].toLowerCase(),
            tokenIn: TEST_ADDRESSES.USDC,
            tokenOut: TEST_ADDRESSES.WETH,
            amountOutMin: ethers.parseEther('9.95'),
          },
        ] as FlashLoanSwapStep[],
      });

      const result = provider.validate(request);
      expect(result.valid).toBe(true);
    });

    it('should preserve original routers in getApprovedRouters()', () => {
      const originalRouters = [
        '0x68B3465833Fb72A70ecDF485E0e4C7bD8665Fc45',
        '0xD9E1CE17F2641F24Ae83637AB66A2CCA9C378B9F',
      ];
      const config = createValidConfig({ approvedRouters: originalRouters });
      const provider = new BalancerV2FlashLoanProvider(config);

      expect(provider.getApprovedRouters()).toEqual(originalRouters);
    });
  });

  describe('IFlashLoanProvider interface compliance', () => {
    it('should implement all required interface methods', () => {
      const config = createValidConfig();
      const provider = new BalancerV2FlashLoanProvider(config);

      expect(typeof provider.isAvailable).toBe('function');
      expect(typeof provider.getCapabilities).toBe('function');
      expect(typeof provider.calculateFee).toBe('function');
      expect(typeof provider.buildCalldata).toBe('function');
      expect(typeof provider.buildTransaction).toBe('function');
      expect(typeof provider.estimateGas).toBe('function');
      expect(typeof provider.validate).toBe('function');
    });

    it('should have readonly protocol property set to balancer_v2', () => {
      const config = createValidConfig();
      const provider = new BalancerV2FlashLoanProvider(config);

      expect(provider.protocol).toBe('balancer_v2');
    });
  });

  describe('fee comparison with other providers', () => {
    it('should have zero fee while Aave V3 would charge 9 bps on the same amount', () => {
      const config = createValidConfig();
      const provider = new BalancerV2FlashLoanProvider(config);
      const amount = ethers.parseEther('1000');

      const feeInfo = provider.calculateFee(amount);

      // Balancer V2: 0 fee
      expect(feeInfo.feeAmount).toBe(0n);
      expect(feeInfo.feeBps).toBe(0);

      // For comparison: Aave V3 would charge (1000 * 9) / 10000 = 0.9 ETH
      const aaveEquivalentFee = (amount * 9n) / 10000n;
      expect(aaveEquivalentFee).toBe(ethers.parseEther('0.9'));

      // Savings = 0.9 ETH when using Balancer V2 instead of Aave V3
      expect(feeInfo.feeAmount).toBeLessThan(aaveEquivalentFee);
    });
  });
});
