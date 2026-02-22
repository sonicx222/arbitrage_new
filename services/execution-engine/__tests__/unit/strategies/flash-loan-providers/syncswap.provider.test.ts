/**
 * Unit Tests for SyncSwapFlashLoanProvider
 *
 * Tests the SyncSwap flash loan provider implementation for zkSync Era.
 * Covers initialization, validation, fee calculation, calldata building,
 * gas estimation, and integration with SyncSwap Vault.
 *
 * Testing patterns follow CLAUDE.md:
 * - Constructor pattern for DI (allows proper mock injection)
 * - Mocks set up in beforeEach()
 * - Direct imports from source files (not barrel exports)
 * - Local createMockDeps() helper for consistent dependency injection
 *
 * @see syncswap.provider.ts
 * @see contracts/src/SyncSwapFlashArbitrage.sol
 */

import { ethers } from 'ethers';
import { SyncSwapFlashLoanProvider } from '../../../../src/strategies/flash-loan-providers/syncswap.provider';
import type {
  FlashLoanRequest,
  FlashLoanSwapStep,
} from '../../../../src/strategies/flash-loan-providers/types';

// Mock @arbitrage/config to prevent deep import chain (service-config -> PANCAKESWAP_V3_FACTORIES)
// IMPORTANT: Use number-based denominator with BigInt conversion at call time to avoid
// Jest worker serialization error ("Do not know how to serialize a BigInt").
const MOCK_BPS_DENOMINATOR_NUM = 10000;

jest.mock('@arbitrage/config', () => ({
  __esModule: true,
  SYNCSWAP_FEE_BPS: 30,
  getBpsDenominatorBigInt: () => BigInt(MOCK_BPS_DENOMINATOR_NUM),
  SYNCSWAP_FLASH_ARBITRAGE_ABI: [
    'function executeArbitrage(address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath, uint256 minProfit, uint256 deadline) external',
    'function calculateExpectedProfit(address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath) external view returns (uint256 expectedProfit, uint256 flashLoanFee)',
    'function isApprovedRouter(address router) external view returns (bool)',
    'function VAULT() external view returns (address)',
  ],
  ARBITRAGE_CONFIG: {
    gasPriceSpikeMultiplier: 2,
    maxGasPrice: '500',
    minProfitThreshold: '0.001',
    maxTradeSize: '10',
    defaultSlippageBps: 50,
    slippageTolerance: 0.05,
  },
}));

// Mock base.strategy to prevent deep import chain (ARBITRAGE_CONFIG, DEXES, CHAINS, etc.)
// Only getSwapDeadline is needed by the syncswap provider
jest.mock('../../../../src/strategies/base.strategy', () => ({
  getSwapDeadline: () => Math.floor(Date.now() / 1000) + 300,
}));

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Valid test addresses for zkSync Era
 */
const TEST_ADDRESSES = {
  VAULT: '0x621425a1Ef6abE91058E9712575dcc4258F8d091', // SyncSwap Vault
  CONTRACT: '0x1234567890123456789012345678901234567890', // Flash arbitrage contract
  ROUTER_SYNCSWAP: '0x2da10A1e27bF85cEdD8FFb1AbBe97e53391C0295', // SyncSwap Router
  ROUTER_MUTE: '0x8B791913eB07C32779a16750e3868aA8495F5964', // Mute.io Router
  WETH: '0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91', // WETH on zkSync Era
  USDC: '0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf4', // USDC on zkSync Era
  DAI: '0x4B9eb6c0b6ea15176BBF62841C6B2A8a398cb656', // DAI on zkSync Era
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
  chain: 'zksync',
  swapPath: [
    {
      router: TEST_ADDRESSES.ROUTER_SYNCSWAP,
      tokenIn: TEST_ADDRESSES.WETH,
      tokenOut: TEST_ADDRESSES.USDC,
      amountOutMin: ethers.parseUnits('24875', 6), // ~$2500/ETH * 10 * 0.995 (USDC 6 decimals)
    },
    {
      router: TEST_ADDRESSES.ROUTER_SYNCSWAP,
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
  chain: 'zksync',
  poolAddress: TEST_ADDRESSES.VAULT,
  contractAddress: TEST_ADDRESSES.CONTRACT,
  approvedRouters: [TEST_ADDRESSES.ROUTER_SYNCSWAP, TEST_ADDRESSES.ROUTER_MUTE],
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
      return estimateGasResult ?? 520000n;
    }),
  } as unknown as ethers.JsonRpcProvider;
};

// =============================================================================
// Constructor and Initialization Tests
// =============================================================================

describe('SyncSwapFlashLoanProvider - Constructor and Initialization', () => {
  describe('constructor', () => {
    it('should create provider with valid configuration', () => {
      const config = createValidConfig();
      const provider = new SyncSwapFlashLoanProvider(config);

      expect(provider).toBeDefined();
      expect(provider.protocol).toBe('syncswap');
      expect(provider.chain).toBe('zksync');
      expect(provider.poolAddress).toBe(TEST_ADDRESSES.VAULT);
    });

    it('should accept empty approved routers list', () => {
      const config = createValidConfig({ approvedRouters: [] });
      const provider = new SyncSwapFlashLoanProvider(config);

      expect(provider).toBeDefined();
      expect(provider.getApprovedRouters()).toEqual([]);
    });

    it('should accept fee override', () => {
      const config = createValidConfig({ feeOverride: 50 }); // 0.5%
      const provider = new SyncSwapFlashLoanProvider(config);

      const feeInfo = provider.calculateFee(ethers.parseEther('1000'));
      expect(feeInfo.feeBps).toBe(50);
    });

    it('should throw error for invalid contract address', () => {
      const config = createValidConfig({ contractAddress: 'invalid-address' });

      expect(() => new SyncSwapFlashLoanProvider(config)).toThrow(
        '[ERR_CONFIG] Invalid contract address for SyncSwap provider on zksync'
      );
    });

    it('should throw error for invalid vault address', () => {
      const config = createValidConfig({ poolAddress: 'invalid-vault' });

      expect(() => new SyncSwapFlashLoanProvider(config)).toThrow(
        '[ERR_CONFIG] Invalid vault address for SyncSwap provider on zksync'
      );
    });

    it('should validate both contract and vault addresses', () => {
      const config = createValidConfig({
        contractAddress: 'bad-contract',
        poolAddress: 'bad-vault',
      });

      // Should throw on first invalid address (contract)
      expect(() => new SyncSwapFlashLoanProvider(config)).toThrow('[ERR_CONFIG]');
    });
  });

  describe('isAvailable', () => {
    it('should return true for valid contract address', () => {
      const config = createValidConfig();
      const provider = new SyncSwapFlashLoanProvider(config);

      expect(provider.isAvailable()).toBe(true);
    });

    it('should return false for zero address', () => {
      const config = createValidConfig({ contractAddress: TEST_ADDRESSES.ZERO_ADDRESS });
      const provider = new SyncSwapFlashLoanProvider(config);

      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe('getCapabilities', () => {
    it('should return correct capabilities', () => {
      const config = createValidConfig();
      const provider = new SyncSwapFlashLoanProvider(config);

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
      const provider = new SyncSwapFlashLoanProvider(config);

      expect(provider.protocol).toBe('syncswap');
    });

    it('should expose chain as readonly', () => {
      const config = createValidConfig();
      const provider = new SyncSwapFlashLoanProvider(config);

      expect(provider.chain).toBe('zksync');
    });

    it('should expose poolAddress (vault) as readonly', () => {
      const config = createValidConfig();
      const provider = new SyncSwapFlashLoanProvider(config);

      expect(provider.poolAddress).toBe(TEST_ADDRESSES.VAULT);
    });
  });

  describe('getter methods', () => {
    it('should return contract address', () => {
      const config = createValidConfig();
      const provider = new SyncSwapFlashLoanProvider(config);

      expect(provider.getContractAddress()).toBe(TEST_ADDRESSES.CONTRACT);
    });

    it('should return copy of approved routers (not reference)', () => {
      const config = createValidConfig();
      const provider = new SyncSwapFlashLoanProvider(config);

      const routers1 = provider.getApprovedRouters();
      const routers2 = provider.getApprovedRouters();

      expect(routers1).toEqual(routers2);
      expect(routers1).not.toBe(routers2); // Different array instances
    });

    it('should return vault address', () => {
      const config = createValidConfig();
      const provider = new SyncSwapFlashLoanProvider(config);

      expect(provider.getVaultAddress()).toBe(TEST_ADDRESSES.VAULT);
    });
  });
});

// =============================================================================
// Fee Calculation Tests
// =============================================================================

describe('SyncSwapFlashLoanProvider - Fee Calculation', () => {
  let provider: SyncSwapFlashLoanProvider;

  beforeEach(() => {
    const config = createValidConfig();
    provider = new SyncSwapFlashLoanProvider(config);
  });

  describe('calculateFee', () => {
    it('should calculate correct fee for standard amount (30 bps = 0.3%)', () => {
      const amount = ethers.parseEther('1000'); // 1000 ETH

      const feeInfo = provider.calculateFee(amount);

      expect(feeInfo.feeBps).toBe(30);
      expect(feeInfo.feeAmount).toBe(ethers.parseEther('3')); // 0.3% of 1000 = 3 ETH
      expect(feeInfo.protocol).toBe('syncswap');
    });

    it('should calculate fee for 1 ETH', () => {
      const amount = ethers.parseEther('1');

      const feeInfo = provider.calculateFee(amount);

      expect(feeInfo.feeAmount).toBe(3000000000000000n); // 0.003 ETH
    });

    it('should calculate fee for 10 ETH', () => {
      const amount = ethers.parseEther('10');

      const feeInfo = provider.calculateFee(amount);

      expect(feeInfo.feeAmount).toBe(ethers.parseEther('0.03')); // 0.03 ETH
    });

    it('should handle very small amounts', () => {
      const amount = 1000n; // 1000 wei

      const feeInfo = provider.calculateFee(amount);

      expect(feeInfo.feeAmount).toBe(3n); // (1000 * 30) / 10000 = 3
    });

    it('should handle very large amounts without overflow', () => {
      const amount = ethers.parseEther('1000000'); // 1 million ETH

      const feeInfo = provider.calculateFee(amount);

      expect(feeInfo.feeAmount).toBe(ethers.parseEther('3000')); // 3000 ETH
    });

    it('should handle zero amount', () => {
      const amount = 0n;

      const feeInfo = provider.calculateFee(amount);

      expect(feeInfo.feeAmount).toBe(0n);
    });

    it('should use fee override when provided', () => {
      const config = createValidConfig({ feeOverride: 50 }); // 0.5%
      const overrideProvider = new SyncSwapFlashLoanProvider(config);
      const amount = ethers.parseEther('1000');

      const feeInfo = overrideProvider.calculateFee(amount);

      expect(feeInfo.feeBps).toBe(50);
      expect(feeInfo.feeAmount).toBe(ethers.parseEther('5')); // 0.5% of 1000 = 5 ETH
    });

    it('should allow zero fee override (for testing)', () => {
      const config = createValidConfig({ feeOverride: 0 });
      const overrideProvider = new SyncSwapFlashLoanProvider(config);
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

describe('SyncSwapFlashLoanProvider - Request Validation', () => {
  let provider: SyncSwapFlashLoanProvider;

  beforeEach(() => {
    const config = createValidConfig();
    provider = new SyncSwapFlashLoanProvider(config);
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
            router: TEST_ADDRESSES.ROUTER_SYNCSWAP,
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: ethers.parseUnits('24875', 6),
          },
          {
            router: TEST_ADDRESSES.ROUTER_MUTE,
            tokenIn: TEST_ADDRESSES.USDC,
            tokenOut: TEST_ADDRESSES.DAI,
            amountOutMin: ethers.parseEther('24875'),
          },
          {
            router: TEST_ADDRESSES.ROUTER_SYNCSWAP,
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
      const permissiveProvider = new SyncSwapFlashLoanProvider(config);
      const request = createValidRequest({
        swapPath: [
          {
            router: '0x9999999999999999999999999999999999999999', // Random router
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: ethers.parseUnits('24875', 6),
          },
          {
            router: '0x8888888888888888888888888888888888888888', // Another random router
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
      const request = createValidRequest({ chain: 'ethereum' });

      const result = provider.validate(request);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_CHAIN_MISMATCH]');
      expect(result.error).toContain('ethereum');
      expect(result.error).toContain('zksync');
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
            router: TEST_ADDRESSES.ROUTER_SYNCSWAP,
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
            router: '0x9999999999999999999999999999999999999999', // Not in approved list
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: 1n,
          },
          {
            router: TEST_ADDRESSES.ROUTER_SYNCSWAP,
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
      // Only uppercase hex chars, keep 0x prefix (ethers.isAddress rejects 0X)
      const request = createValidRequest({
        swapPath: [
          {
            router: '0x' + TEST_ADDRESSES.ROUTER_SYNCSWAP.slice(2).toUpperCase(),
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: ethers.parseUnits('24875', 6),
          },
          {
            router: TEST_ADDRESSES.ROUTER_MUTE.toLowerCase(), // Lowercase
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
            router: TEST_ADDRESSES.ROUTER_SYNCSWAP,
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: ethers.parseUnits('24875', 6),
          },
          {
            router: TEST_ADDRESSES.ROUTER_SYNCSWAP,
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

    it('should accept valid cycle (case-insensitive)', () => {
      // Only uppercase hex chars, keep 0x prefix (ethers.isAddress rejects 0X)
      const request = createValidRequest({
        asset: TEST_ADDRESSES.WETH.toLowerCase(),
        swapPath: [
          {
            router: TEST_ADDRESSES.ROUTER_SYNCSWAP,
            tokenIn: '0x' + TEST_ADDRESSES.WETH.slice(2).toUpperCase(),
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: ethers.parseUnits('24875', 6),
          },
          {
            router: TEST_ADDRESSES.ROUTER_SYNCSWAP,
            tokenIn: TEST_ADDRESSES.USDC,
            tokenOut: TEST_ADDRESSES.WETH.toLowerCase(),
            amountOutMin: ethers.parseEther('9.95'),
          },
        ] as FlashLoanSwapStep[],
      });

      const result = provider.validate(request);

      expect(result.valid).toBe(true);
    });
  });

  describe('validate - asset mismatch', () => {
    it('should reject when first swap token does not match asset', () => {
      const request = createValidRequest({
        asset: TEST_ADDRESSES.WETH,
        swapPath: [
          {
            router: TEST_ADDRESSES.ROUTER_SYNCSWAP,
            tokenIn: TEST_ADDRESSES.USDC, // Starts with USDC, not WETH
            tokenOut: TEST_ADDRESSES.DAI,
            amountOutMin: 1n,
          },
          {
            router: TEST_ADDRESSES.ROUTER_SYNCSWAP,
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

    it('should accept when asset matches first token (case-insensitive)', () => {
      const request = createValidRequest({
        asset: TEST_ADDRESSES.WETH.toLowerCase(),
        swapPath: [
          {
            router: TEST_ADDRESSES.ROUTER_SYNCSWAP,
            tokenIn: TEST_ADDRESSES.WETH.toUpperCase(),
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: ethers.parseUnits('24875', 6),
          },
          {
            router: TEST_ADDRESSES.ROUTER_SYNCSWAP,
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
});

// =============================================================================
// Calldata and Transaction Building Tests
// =============================================================================

describe('SyncSwapFlashLoanProvider - Calldata and Transaction Building', () => {
  let provider: SyncSwapFlashLoanProvider;

  beforeEach(() => {
    const config = createValidConfig();
    provider = new SyncSwapFlashLoanProvider(config);
  });

  describe('buildCalldata', () => {
    it('should build correct calldata for simple swap path', () => {
      const request = createValidRequest();

      const calldata = provider.buildCalldata(request);

      expect(calldata).toBeDefined();
      expect(typeof calldata).toBe('string');
      expect(calldata.startsWith('0x')).toBe(true);
      expect(calldata.length).toBeGreaterThan(10); // Has substantial data
    });

    it('should build calldata with deadline parameter', () => {
      const request = createValidRequest();

      const calldata = provider.buildCalldata(request);

      // Decode to verify structure
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
      expect(swapPath[0][0]).toBe(TEST_ADDRESSES.ROUTER_SYNCSWAP); // First step router
      expect(swapPath[0][1]).toBe(TEST_ADDRESSES.WETH); // First step tokenIn
      expect(swapPath[0][2]).toBe(TEST_ADDRESSES.USDC); // First step tokenOut
      expect(swapPath[1][0]).toBe(TEST_ADDRESSES.ROUTER_SYNCSWAP); // Second step router
      expect(swapPath[1][1]).toBe(TEST_ADDRESSES.USDC); // Second step tokenIn
      expect(swapPath[1][2]).toBe(TEST_ADDRESSES.WETH); // Second step tokenOut
    });

    it('should handle multi-hop swap path', () => {
      const request = createValidRequest({
        swapPath: [
          {
            router: TEST_ADDRESSES.ROUTER_SYNCSWAP,
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: ethers.parseUnits('10000', 6), // 10k USDC
          },
          {
            router: TEST_ADDRESSES.ROUTER_MUTE,
            tokenIn: TEST_ADDRESSES.USDC,
            tokenOut: TEST_ADDRESSES.DAI,
            amountOutMin: ethers.parseEther('9900'), // 9900 DAI
          },
          {
            router: TEST_ADDRESSES.ROUTER_SYNCSWAP,
            tokenIn: TEST_ADDRESSES.DAI,
            tokenOut: TEST_ADDRESSES.WETH,
            amountOutMin: ethers.parseEther('10.1'), // 10.1 ETH
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
      expect(swapPath[0][3]).toBe(ethers.parseUnits('10000', 6)); // amountOutMin
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

      // Deadline should be ~300 seconds (5 minutes) in the future
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

describe('SyncSwapFlashLoanProvider - Gas Estimation', () => {
  let provider: SyncSwapFlashLoanProvider;

  beforeEach(() => {
    const config = createValidConfig();
    provider = new SyncSwapFlashLoanProvider(config);
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

    it('should return default estimate (520k) on estimation failure', async () => {
      const request = createValidRequest();
      const mockProvider = createMockProvider(undefined, true); // Will throw

      const gasEstimate = await provider.estimateGas(request, mockProvider);

      expect(gasEstimate).toBe(520000n);
    });

    it('should handle network errors gracefully', async () => {
      const request = createValidRequest();
      const mockProvider = {
        estimateGas: jest.fn().mockRejectedValue(new Error('Network timeout')),
      } as unknown as ethers.JsonRpcProvider;

      const gasEstimate = await provider.estimateGas(request, mockProvider);

      expect(gasEstimate).toBe(520000n); // Default fallback
    });

    it('should return different estimates for different requests', async () => {
      const request1 = createValidRequest();
      const request2 = createValidRequest({
        amount: ethers.parseEther('100'), // Larger amount
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

describe('SyncSwapFlashLoanProvider - Integration Scenarios', () => {
  describe('complete arbitrage flow', () => {
    it('should validate, build calldata, and estimate gas for valid request', async () => {
      const config = createValidConfig();
      const provider = new SyncSwapFlashLoanProvider(config);
      const request = createValidRequest();
      const mockProvider = createMockProvider(550000n);

      // Step 1: Validate
      const validation = provider.validate(request);
      expect(validation.valid).toBe(true);

      // Step 2: Calculate fee
      const feeInfo = provider.calculateFee(request.amount);
      expect(feeInfo.feeAmount).toBeGreaterThan(0n);

      // Step 3: Build transaction
      const tx = provider.buildTransaction(request, request.initiator);
      expect(tx.to).toBe(config.contractAddress);

      // Step 4: Estimate gas
      const gasEstimate = await provider.estimateGas(request, mockProvider);
      expect(gasEstimate).toBe(550000n);
    });

    it('should handle validation failure before building transaction', () => {
      const config = createValidConfig();
      const provider = new SyncSwapFlashLoanProvider(config);
      const invalidRequest = createValidRequest({ chain: 'ethereum' }); // Wrong chain

      // Validate first
      const validation = provider.validate(invalidRequest);
      expect(validation.valid).toBe(false);

      // Should not proceed to build transaction if validation fails
      // (but technically it would still work since validation is separate)
      const tx = provider.buildTransaction(invalidRequest, invalidRequest.initiator);
      expect(tx).toBeDefined(); // Provider doesn't enforce validation in build methods
    });
  });

  describe('multi-chain configuration', () => {
    it('should create separate providers for different chains', () => {
      const zkSyncConfig = createValidConfig({ chain: 'zksync' });
      const lineaConfig = createValidConfig({ chain: 'linea' }); // Future support

      const zkSyncProvider = new SyncSwapFlashLoanProvider(zkSyncConfig);
      const lineaProvider = new SyncSwapFlashLoanProvider(lineaConfig);

      expect(zkSyncProvider.chain).toBe('zksync');
      expect(lineaProvider.chain).toBe('linea');
      expect(zkSyncProvider).not.toBe(lineaProvider);
    });
  });

  describe('edge cases and boundaries', () => {
    it('should handle maximum uint256 loan amount', () => {
      const config = createValidConfig();
      const provider = new SyncSwapFlashLoanProvider(config);
      const maxUint256 = 2n ** 256n - 1n;

      const feeInfo = provider.calculateFee(maxUint256);

      // Fee should not overflow
      expect(feeInfo.feeAmount).toBeLessThanOrEqual(maxUint256);
    });

    it('should handle single-step swap path (direct arbitrage)', () => {
      const config = createValidConfig();
      const provider = new SyncSwapFlashLoanProvider(config);
      const request = createValidRequest({
        swapPath: [
          {
            router: TEST_ADDRESSES.ROUTER_SYNCSWAP,
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.WETH, // Same token (artificial case)
            amountOutMin: ethers.parseEther('10.1'),
          },
        ] as FlashLoanSwapStep[],
      });

      const validation = provider.validate(request);
      expect(validation.valid).toBe(true); // Valid cycle

      const calldata = provider.buildCalldata(request);
      expect(calldata).toBeDefined();
    });

    it('should handle very long swap path', () => {
      const config = createValidConfig();
      const provider = new SyncSwapFlashLoanProvider(config);

      // Create 10-step path
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
        TEST_ADDRESSES.WETH, // Back to start
      ];

      for (let i = 0; i < tokens.length - 1; i++) {
        longPath.push({
          router: TEST_ADDRESSES.ROUTER_SYNCSWAP,
          tokenIn: tokens[i],
          tokenOut: tokens[i + 1],
          amountOutMin: 1n,
        });
      }

      const request = createValidRequest({ swapPath: longPath });

      const validation = provider.validate(request);
      expect(validation.valid).toBe(true);

      const calldata = provider.buildCalldata(request);
      expect(calldata.length).toBeGreaterThan(1000); // Should be quite large
    });
  });
});
