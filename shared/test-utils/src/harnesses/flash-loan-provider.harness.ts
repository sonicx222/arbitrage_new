/**
 * Flash Loan Provider Test Harness
 *
 * Provides shared test suites for all flash loan providers.
 * Each provider shares ~85% identical tests for constructor, fee calculation,
 * request validation, calldata building, gas estimation, and integration.
 *
 * Usage:
 *   import { testFlashLoanProvider } from '@arbitrage/test-utils/harnesses/flash-loan-provider.harness';
 *   testFlashLoanProvider({ name: 'AaveV3', ProviderClass, ... });
 *
 * @see services/execution-engine/src/strategies/flash-loan-providers/
 */

import { ethers } from 'ethers';
import type {
  FlashLoanRequest,
  FlashLoanSwapStep,
  IFlashLoanProvider,
} from '../../../../services/execution-engine/src/strategies/flash-loan-providers/types';

// =============================================================================
// Shared Test Addresses
// =============================================================================

export const FLASH_LOAN_TEST_ADDRESSES = {
  CONTRACT: '0x1234567890123456789012345678901234567890',
  ROUTER_UNISWAP: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  ROUTER_SUSHISWAP: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
  INITIATOR: '0xabcdef0123456789abcdef0123456789abcdef01',
  ZERO_ADDRESS: '0x0000000000000000000000000000000000000000',
} as const;

// =============================================================================
// Shared Factory Functions
// =============================================================================

export function createStandardRequest(overrides?: Partial<FlashLoanRequest>): FlashLoanRequest {
  return {
    asset: FLASH_LOAN_TEST_ADDRESSES.WETH,
    amount: ethers.parseEther('10'),
    chain: 'ethereum',
    swapPath: [
      {
        router: FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP,
        tokenIn: FLASH_LOAN_TEST_ADDRESSES.WETH,
        tokenOut: FLASH_LOAN_TEST_ADDRESSES.USDC,
        amountOutMin: ethers.parseUnits('24875', 6),
      },
      {
        router: FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP,
        tokenIn: FLASH_LOAN_TEST_ADDRESSES.USDC,
        tokenOut: FLASH_LOAN_TEST_ADDRESSES.WETH,
        amountOutMin: ethers.parseEther('9.95'),
      },
    ] as FlashLoanSwapStep[],
    minProfit: ethers.parseEther('0.1'),
    initiator: FLASH_LOAN_TEST_ADDRESSES.INITIATOR,
    ...overrides,
  };
}

export function createStandardMockProvider(defaultGas: bigint, estimateGasResult?: bigint, shouldThrow = false) {
  return {
    estimateGas: jest.fn().mockImplementation(async () => {
      if (shouldThrow) throw new Error('Gas estimation failed');
      return estimateGasResult ?? defaultGas;
    }),
  } as unknown as ethers.JsonRpcProvider;
}

// =============================================================================
// Harness Config
// =============================================================================

export interface FlashLoanProviderTestConfig {
  /** Display name for describe blocks (e.g. 'AaveV3FlashLoanProvider') */
  name: string;
  /** Protocol identifier (e.g. 'aave_v3') */
  protocol: string;
  /** Provider class constructor */
  ProviderClass: new (config: any) => IFlashLoanProvider;
  /** Default fee in basis points */
  defaultFeeBps: number;
  /** Default gas estimate returned on fallback */
  defaultGasEstimate: bigint;
  /** Pool/Vault address for this protocol */
  poolAddress: string;
  /** Create a valid config object (provider-specific) */
  createConfig: (overrides?: Record<string, any>) => Record<string, any>;
  /** Create a valid request (defaults to createStandardRequest) */
  createRequest?: (overrides?: Partial<FlashLoanRequest>) => FlashLoanRequest;
  /** Default chain for this provider (defaults to 'ethereum') */
  defaultChain?: string;
}

// =============================================================================
// Test Suites
// =============================================================================

/**
 * Run all shared flash loan provider tests.
 * Call this from each provider's test file after setting up jest.mock().
 */
export function testFlashLoanProvider(config: FlashLoanProviderTestConfig): void {
  const {
    name,
    protocol,
    ProviderClass,
    defaultFeeBps,
    defaultGasEstimate,
    poolAddress,
    createConfig,
  } = config;
  const defaultChain = config.defaultChain ?? 'ethereum';
  const baseCreateRequest = config.createRequest ?? createStandardRequest;
  const createRequest = (overrides?: Partial<FlashLoanRequest>) =>
    baseCreateRequest({ chain: defaultChain, ...overrides });

  // ---------------------------------------------------------------------------
  // Constructor and Initialization
  // ---------------------------------------------------------------------------
  describe(`${name} — Constructor and Initialization`, () => {
    describe('constructor', () => {
      it('should create provider with valid configuration', () => {
        const cfg = createConfig();
        const provider = new ProviderClass(cfg);

        expect(provider).toBeDefined();
        expect(provider.protocol).toBe(protocol);
        expect(provider.chain).toBe(defaultChain);
        expect(provider.poolAddress).toBe(poolAddress);
      });

      it('should accept empty approved routers list', () => {
        const cfg = createConfig({ approvedRouters: [] });
        const provider = new ProviderClass(cfg);

        expect(provider).toBeDefined();
        expect(provider.getApprovedRouters()).toEqual([]);
      });

      it('should accept fee override', () => {
        const cfg = createConfig({ feeOverride: 5 });
        const provider = new ProviderClass(cfg);

        const feeInfo = provider.calculateFee(ethers.parseEther('1000'));
        expect(feeInfo.feeBps).toBe(5);
      });

      it('should throw error for invalid contract address', () => {
        const cfg = createConfig({ contractAddress: 'invalid-address' });
        expect(() => new ProviderClass(cfg)).toThrow('[ERR_CONFIG]');
      });

      it('should throw error for invalid pool address', () => {
        const cfg = createConfig({ poolAddress: 'invalid-pool' });
        expect(() => new ProviderClass(cfg)).toThrow('[ERR_CONFIG]');
      });
    });

    describe('isAvailable', () => {
      it('should return true for valid contract address', () => {
        const cfg = createConfig();
        const provider = new ProviderClass(cfg);
        expect(provider.isAvailable()).toBe(true);
      });

      it('should return false for zero address', () => {
        const cfg = createConfig({ contractAddress: FLASH_LOAN_TEST_ADDRESSES.ZERO_ADDRESS });
        const provider = new ProviderClass(cfg);
        expect(provider.isAvailable()).toBe(false);
      });
    });

    describe('getCapabilities', () => {
      it('should return correct capabilities', () => {
        const cfg = createConfig();
        const provider = new ProviderClass(cfg);
        const capabilities = provider.getCapabilities();

        expect(capabilities.supportsMultiHop).toBe(true);
        expect(capabilities.supportsMultiAsset).toBe(false);
        expect(capabilities.maxLoanAmount).toBe(0n);
        expect(capabilities.status).toBe('fully_supported');
      });
    });

    describe('protocol and chain properties', () => {
      it('should expose protocol as readonly', () => {
        const provider = new ProviderClass(createConfig());
        expect(provider.protocol).toBe(protocol);
      });

      it('should expose chain as readonly', () => {
        const provider = new ProviderClass(createConfig());
        expect(provider.chain).toBe(defaultChain);
      });

      it('should expose poolAddress as readonly', () => {
        const provider = new ProviderClass(createConfig());
        expect(provider.poolAddress).toBe(poolAddress);
      });
    });

    describe('getter methods', () => {
      it('should return contract address', () => {
        const provider = new ProviderClass(createConfig());
        expect(provider.getContractAddress()).toBe(FLASH_LOAN_TEST_ADDRESSES.CONTRACT);
      });

      it('should return copy of approved routers (not reference)', () => {
        const provider = new ProviderClass(createConfig());
        const routers1 = provider.getApprovedRouters();
        const routers2 = provider.getApprovedRouters();
        expect(routers1).toEqual(routers2);
        expect(routers1).not.toBe(routers2);
      });

      it('should return pool address via poolAddress property', () => {
        const provider = new ProviderClass(createConfig());
        expect(provider.poolAddress).toBe(poolAddress);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Fee Calculation
  // ---------------------------------------------------------------------------
  describe(`${name} — Fee Calculation`, () => {
    let provider: IFlashLoanProvider;

    beforeEach(() => {
      provider = new ProviderClass(createConfig());
    });

    it('should calculate correct fee for standard amount', () => {
      const amount = ethers.parseEther('1000');
      const feeInfo = provider.calculateFee(amount);

      expect(feeInfo.feeBps).toBe(defaultFeeBps);
      expect(feeInfo.feeAmount).toBe((amount * BigInt(defaultFeeBps)) / 10000n);
      expect(feeInfo.protocol).toBe(protocol);
    });

    it('should calculate fee for 1 ETH', () => {
      const feeInfo = provider.calculateFee(ethers.parseEther('1'));
      expect(feeInfo.feeAmount).toBe((ethers.parseEther('1') * BigInt(defaultFeeBps)) / 10000n);
    });

    it('should handle zero amount', () => {
      const feeInfo = provider.calculateFee(0n);
      expect(feeInfo.feeAmount).toBe(0n);
    });

    it('should handle very large amounts without overflow', () => {
      const amount = ethers.parseEther('1000000');
      const feeInfo = provider.calculateFee(amount);
      expect(feeInfo.feeAmount).toBeLessThanOrEqual(amount);
    });

    it('should use fee override when provided', () => {
      const overrideProvider = new ProviderClass(createConfig({ feeOverride: 5 }));
      const amount = ethers.parseEther('1000');
      const feeInfo = overrideProvider.calculateFee(amount);

      expect(feeInfo.feeBps).toBe(5);
      expect(feeInfo.feeAmount).toBe(ethers.parseEther('0.5'));
    });

    it('should allow zero fee override', () => {
      const overrideProvider = new ProviderClass(createConfig({ feeOverride: 0 }));
      const feeInfo = overrideProvider.calculateFee(ethers.parseEther('1000'));

      expect(feeInfo.feeBps).toBe(0);
      expect(feeInfo.feeAmount).toBe(0n);
    });
  });

  // ---------------------------------------------------------------------------
  // Request Validation
  // ---------------------------------------------------------------------------
  describe(`${name} — Request Validation`, () => {
    let provider: IFlashLoanProvider;

    beforeEach(() => {
      provider = new ProviderClass(createConfig());
    });

    it('should validate a correct request', () => {
      const result = provider.validate(createRequest());
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should validate multi-hop swap path', () => {
      const request = createRequest({
        swapPath: [
          { router: FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP, tokenIn: FLASH_LOAN_TEST_ADDRESSES.WETH, tokenOut: FLASH_LOAN_TEST_ADDRESSES.USDC, amountOutMin: ethers.parseUnits('24875', 6) },
          { router: FLASH_LOAN_TEST_ADDRESSES.ROUTER_SUSHISWAP, tokenIn: FLASH_LOAN_TEST_ADDRESSES.USDC, tokenOut: FLASH_LOAN_TEST_ADDRESSES.DAI, amountOutMin: ethers.parseEther('24875') },
          { router: FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP, tokenIn: FLASH_LOAN_TEST_ADDRESSES.DAI, tokenOut: FLASH_LOAN_TEST_ADDRESSES.WETH, amountOutMin: ethers.parseEther('9.95') },
        ] as FlashLoanSwapStep[],
      });
      expect(provider.validate(request).valid).toBe(true);
    });

    it('should reject request with wrong chain', () => {
      const mismatchChain = defaultChain === 'polygon' ? 'arbitrum' : 'polygon';
      const result = provider.validate(createRequest({ chain: mismatchChain }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_CHAIN_MISMATCH]');
    });

    it('should reject invalid asset address', () => {
      const result = provider.validate(createRequest({ asset: 'not-an-address' }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_INVALID_ASSET]');
    });

    it('should reject zero loan amount', () => {
      const result = provider.validate(createRequest({ amount: 0n }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_ZERO_AMOUNT]');
    });

    it('should reject empty swap path', () => {
      const result = provider.validate(createRequest({ swapPath: [] }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_EMPTY_PATH]');
    });

    it('should reject swap path with invalid router address', () => {
      const result = provider.validate(createRequest({
        swapPath: [
          { router: 'invalid-router', tokenIn: FLASH_LOAN_TEST_ADDRESSES.WETH, tokenOut: FLASH_LOAN_TEST_ADDRESSES.USDC, amountOutMin: 1n },
          { router: FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP, tokenIn: FLASH_LOAN_TEST_ADDRESSES.USDC, tokenOut: FLASH_LOAN_TEST_ADDRESSES.WETH, amountOutMin: ethers.parseEther('9.95') },
        ] as FlashLoanSwapStep[],
      }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_INVALID_ROUTER]');
    });

    it('should reject unapproved router', () => {
      const result = provider.validate(createRequest({
        swapPath: [
          { router: '0x9999999999999999999999999999999999999999', tokenIn: FLASH_LOAN_TEST_ADDRESSES.WETH, tokenOut: FLASH_LOAN_TEST_ADDRESSES.USDC, amountOutMin: 1n },
          { router: FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP, tokenIn: FLASH_LOAN_TEST_ADDRESSES.USDC, tokenOut: FLASH_LOAN_TEST_ADDRESSES.WETH, amountOutMin: ethers.parseEther('9.95') },
        ] as FlashLoanSwapStep[],
      }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_UNAPPROVED_ROUTER]');
    });

    it('should accept approved routers case-insensitively', () => {
      const result = provider.validate(createRequest({
        swapPath: [
          { router: '0x' + FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP.slice(2).toUpperCase(), tokenIn: FLASH_LOAN_TEST_ADDRESSES.WETH, tokenOut: FLASH_LOAN_TEST_ADDRESSES.USDC, amountOutMin: ethers.parseUnits('24875', 6) },
          { router: FLASH_LOAN_TEST_ADDRESSES.ROUTER_SUSHISWAP.toLowerCase(), tokenIn: FLASH_LOAN_TEST_ADDRESSES.USDC, tokenOut: FLASH_LOAN_TEST_ADDRESSES.WETH, amountOutMin: ethers.parseEther('9.95') },
        ] as FlashLoanSwapStep[],
      }));
      expect(result.valid).toBe(true);
    });

    it('should reject path that does not end with starting token', () => {
      const result = provider.validate(createRequest({
        swapPath: [
          { router: FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP, tokenIn: FLASH_LOAN_TEST_ADDRESSES.WETH, tokenOut: FLASH_LOAN_TEST_ADDRESSES.USDC, amountOutMin: ethers.parseUnits('24875', 6) },
          { router: FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP, tokenIn: FLASH_LOAN_TEST_ADDRESSES.USDC, tokenOut: FLASH_LOAN_TEST_ADDRESSES.DAI, amountOutMin: ethers.parseEther('24875') },
        ] as FlashLoanSwapStep[],
      }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_INVALID_CYCLE]');
    });

    it('should reject when first swap token does not match asset', () => {
      const result = provider.validate(createRequest({
        asset: FLASH_LOAN_TEST_ADDRESSES.WETH,
        swapPath: [
          { router: FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP, tokenIn: FLASH_LOAN_TEST_ADDRESSES.USDC, tokenOut: FLASH_LOAN_TEST_ADDRESSES.DAI, amountOutMin: 1n },
          { router: FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP, tokenIn: FLASH_LOAN_TEST_ADDRESSES.DAI, tokenOut: FLASH_LOAN_TEST_ADDRESSES.USDC, amountOutMin: 1n },
        ] as FlashLoanSwapStep[],
      }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_ASSET_MISMATCH]');
    });
  });

  // ---------------------------------------------------------------------------
  // Calldata and Transaction Building
  // ---------------------------------------------------------------------------
  describe(`${name} — Calldata and Transaction Building`, () => {
    let provider: IFlashLoanProvider;

    beforeEach(() => {
      provider = new ProviderClass(createConfig());
    });

    describe('buildCalldata', () => {
      it('should build correct calldata for simple swap path', () => {
        const calldata = provider.buildCalldata(createRequest());

        expect(calldata).toBeDefined();
        expect(typeof calldata).toBe('string');
        expect(calldata.startsWith('0x')).toBe(true);
        expect(calldata.length).toBeGreaterThan(10);
      });

      it('should set deadline to approximately 5 minutes in future', () => {
        const beforeTimestamp = Math.floor(Date.now() / 1000);
        const calldata = provider.buildCalldata(createRequest());

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
        const request = createRequest();
        const tx = provider.buildTransaction(request, FLASH_LOAN_TEST_ADDRESSES.INITIATOR);

        expect(tx.to).toBe(FLASH_LOAN_TEST_ADDRESSES.CONTRACT);
        expect(tx.from).toBe(FLASH_LOAN_TEST_ADDRESSES.INITIATOR);
        expect(tx.data).toBeDefined();
      });

      it('should use buildCalldata for transaction data', () => {
        const request = createRequest();
        const calldata = provider.buildCalldata(request);
        const tx = provider.buildTransaction(request, FLASH_LOAN_TEST_ADDRESSES.INITIATOR);

        expect(tx.data).toBe(calldata);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Gas Estimation
  // ---------------------------------------------------------------------------
  describe(`${name} — Gas Estimation`, () => {
    let provider: IFlashLoanProvider;

    beforeEach(() => {
      provider = new ProviderClass(createConfig());
    });

    it('should return gas estimate from provider', async () => {
      const mockProvider = createStandardMockProvider(defaultGasEstimate, 600000n);
      const gasEstimate = await provider.estimateGas(createRequest(), mockProvider);
      expect(gasEstimate).toBe(600000n);
    });

    it('should return default estimate on estimation failure', async () => {
      const mockProvider = createStandardMockProvider(defaultGasEstimate, undefined, true);
      const gasEstimate = await provider.estimateGas(createRequest(), mockProvider);
      expect(gasEstimate).toBe(defaultGasEstimate);
    });

    it('should handle network errors gracefully', async () => {
      const mockProvider = {
        estimateGas: jest.fn().mockRejectedValue(new Error('Network timeout')),
      } as unknown as ethers.JsonRpcProvider;
      const gasEstimate = await provider.estimateGas(createRequest(), mockProvider);
      expect(gasEstimate).toBe(defaultGasEstimate);
    });
  });

  // ---------------------------------------------------------------------------
  // Integration Scenarios
  // ---------------------------------------------------------------------------
  describe(`${name} — Integration Scenarios`, () => {
    it('should validate, build calldata, and estimate gas for valid request', async () => {
      const provider = new ProviderClass(createConfig());
      const request = createRequest();
      const mockProvider = createStandardMockProvider(defaultGasEstimate, 550000n);

      const validation = provider.validate(request);
      expect(validation.valid).toBe(true);

      const feeInfo = provider.calculateFee(request.amount);
      expect(feeInfo.feeAmount).toBe((request.amount * BigInt(defaultFeeBps)) / 10000n);

      const tx = provider.buildTransaction(request, request.initiator);
      expect(tx.to).toBe(FLASH_LOAN_TEST_ADDRESSES.CONTRACT);

      const gasEstimate = await provider.estimateGas(request, mockProvider);
      expect(gasEstimate).toBe(550000n);
    });

    it('should handle maximum uint256 loan amount', () => {
      const provider = new ProviderClass(createConfig());
      const maxUint256 = 2n ** 256n - 1n;
      const feeInfo = provider.calculateFee(maxUint256);
      expect(feeInfo.feeAmount).toBeLessThanOrEqual(maxUint256);
    });

    it('should handle single-step swap path', () => {
      const provider = new ProviderClass(createConfig());
      const request = createRequest({
        swapPath: [{
          router: FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP,
          tokenIn: FLASH_LOAN_TEST_ADDRESSES.WETH,
          tokenOut: FLASH_LOAN_TEST_ADDRESSES.WETH,
          amountOutMin: ethers.parseEther('10.1'),
        }] as FlashLoanSwapStep[],
      });

      expect(provider.validate(request).valid).toBe(true);
      expect(provider.buildCalldata(request)).toBeDefined();
    });

    it('should create separate providers for different chains', () => {
      const ethProvider = new ProviderClass(createConfig({ chain: 'ethereum' }));
      const polyProvider = new ProviderClass(createConfig({ chain: 'polygon' }));

      expect(ethProvider.chain).toBe('ethereum');
      expect(polyProvider.chain).toBe('polygon');
    });

    it('should implement all IFlashLoanProvider interface methods', () => {
      const provider = new ProviderClass(createConfig());

      expect(typeof provider.isAvailable).toBe('function');
      expect(typeof provider.getCapabilities).toBe('function');
      expect(typeof provider.calculateFee).toBe('function');
      expect(typeof provider.buildCalldata).toBe('function');
      expect(typeof provider.buildTransaction).toBe('function');
      expect(typeof provider.estimateGas).toBe('function');
      expect(typeof provider.validate).toBe('function');
    });

    it('should lowercase approved routers internally for O(1) lookup', () => {
      const mixedCaseRouters = [
        '0x68B3465833Fb72A70ecDF485E0e4C7bD8665Fc45',
        '0xD9E1CE17F2641F24Ae83637AB66A2CCA9C378B9F',
      ];
      const provider = new ProviderClass(createConfig({ approvedRouters: mixedCaseRouters }));

      const request = createRequest({
        swapPath: [
          { router: mixedCaseRouters[0].toLowerCase(), tokenIn: FLASH_LOAN_TEST_ADDRESSES.WETH, tokenOut: FLASH_LOAN_TEST_ADDRESSES.USDC, amountOutMin: ethers.parseUnits('24875', 6) },
          { router: mixedCaseRouters[1].toLowerCase(), tokenIn: FLASH_LOAN_TEST_ADDRESSES.USDC, tokenOut: FLASH_LOAN_TEST_ADDRESSES.WETH, amountOutMin: ethers.parseEther('9.95') },
        ] as FlashLoanSwapStep[],
      });

      expect(provider.validate(request).valid).toBe(true);
    });
  });
}
