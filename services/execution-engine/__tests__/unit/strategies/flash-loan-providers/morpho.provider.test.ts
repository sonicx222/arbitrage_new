/**
 * Unit Tests for MorphoFlashLoanProvider
 *
 * Uses the shared flash-loan-provider harness for common tests,
 * plus Morpho-specific tests for multi-chain support, zero-fee behavior,
 * Morpho Blue calldata structure, and Morpho-specific getters.
 *
 * @see morpho.provider.ts
 * @see https://docs.morpho.org/morpho/contracts/addresses
 */

import { ethers } from 'ethers';
import { MorphoFlashLoanProvider } from '../../../../src/strategies/flash-loan-providers/morpho.provider';
import type { FlashLoanSwapStep } from '../../../../src/strategies/flash-loan-providers/types';
import {
  testFlashLoanProvider,
  FLASH_LOAN_TEST_ADDRESSES,
} from '@arbitrage/test-utils/harnesses/flash-loan-provider.harness';

// Mock @arbitrage/config — must be inline literal (hoisted above const)
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

jest.mock('../../../../src/strategies/base.strategy', () => ({
  getSwapDeadline: () => Math.floor(Date.now() / 1000) + 300,
}));

// =============================================================================
// Morpho Config
// =============================================================================

const MORPHO_BLUE = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';

const createConfig = (overrides?: Record<string, any>) => ({
  chain: 'ethereum',
  poolAddress: MORPHO_BLUE,
  contractAddress: FLASH_LOAN_TEST_ADDRESSES.CONTRACT,
  approvedRouters: [FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP, FLASH_LOAN_TEST_ADDRESSES.ROUTER_SUSHISWAP],
  ...overrides,
});

// =============================================================================
// Shared Tests (constructor, fee, validation, calldata, gas, integration)
// =============================================================================

testFlashLoanProvider({
  name: 'MorphoFlashLoanProvider',
  protocol: 'morpho',
  ProviderClass: MorphoFlashLoanProvider,
  defaultFeeBps: 0,
  defaultGasEstimate: 400000n,
  poolAddress: MORPHO_BLUE,
  createConfig,
  // Morpho-specific overrides:
  expectedTxTarget: MORPHO_BLUE,                     // tx goes to Morpho Blue, not contract
  skipCalldataDecodeTest: true,                      // uses Morpho flashLoan ABI, not executeArbitrage
  wrongChainErrorCode: '[ERR_CHAIN_NOT_SUPPORTED]',  // Morpho has custom chain validation
});

// =============================================================================
// Morpho-Specific: Multi-chain support (Ethereum + Base)
// =============================================================================

describe('MorphoFlashLoanProvider — multi-chain support', () => {
  it('should be available on ethereum', () => {
    const provider = new MorphoFlashLoanProvider(createConfig({ chain: 'ethereum' }));
    expect(provider.isAvailable()).toBe(true);
  });

  it('should be available on base', () => {
    const provider = new MorphoFlashLoanProvider(createConfig({ chain: 'base' }));
    expect(provider.isAvailable()).toBe(true);
  });

  it.each(['arbitrum', 'bsc', 'polygon', 'optimism'])('should NOT be available on %s', (chain) => {
    const provider = new MorphoFlashLoanProvider(createConfig({ chain }));
    expect(provider.isAvailable()).toBe(false);
  });

  it('should validate a request on base chain', () => {
    const baseProvider = new MorphoFlashLoanProvider(createConfig({ chain: 'base' }));
    const result = baseProvider.validate({
      asset: FLASH_LOAN_TEST_ADDRESSES.WETH,
      amount: ethers.parseEther('10'),
      chain: 'base',
      swapPath: [
        { router: FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP, tokenIn: FLASH_LOAN_TEST_ADDRESSES.WETH, tokenOut: FLASH_LOAN_TEST_ADDRESSES.USDC, amountOutMin: 1n },
        { router: FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP, tokenIn: FLASH_LOAN_TEST_ADDRESSES.USDC, tokenOut: FLASH_LOAN_TEST_ADDRESSES.WETH, amountOutMin: 1n },
      ] as FlashLoanSwapStep[],
      minProfit: ethers.parseEther('0.05'),
      initiator: FLASH_LOAN_TEST_ADDRESSES.INITIATOR,
    });

    expect(result.valid).toBe(true);
  });

  it('should reject unsupported chain in validation', () => {
    const provider = new MorphoFlashLoanProvider(createConfig());
    const result = provider.validate({
      asset: FLASH_LOAN_TEST_ADDRESSES.WETH,
      amount: ethers.parseEther('10'),
      chain: 'bsc',
      swapPath: [
        { router: FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP, tokenIn: FLASH_LOAN_TEST_ADDRESSES.WETH, tokenOut: FLASH_LOAN_TEST_ADDRESSES.USDC, amountOutMin: 1n },
        { router: FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP, tokenIn: FLASH_LOAN_TEST_ADDRESSES.USDC, tokenOut: FLASH_LOAN_TEST_ADDRESSES.WETH, amountOutMin: 1n },
      ] as FlashLoanSwapStep[],
      minProfit: ethers.parseEther('0.05'),
      initiator: FLASH_LOAN_TEST_ADDRESSES.INITIATOR,
    });

    expect(result.valid).toBe(false);
    expect(result.error).toContain('[ERR_CHAIN_NOT_SUPPORTED]');
  });
});

// =============================================================================
// Morpho-Specific: Calldata Structure
// =============================================================================

describe('MorphoFlashLoanProvider — Morpho Blue calldata', () => {
  const MORPHO_IFACE = new ethers.Interface([
    'function flashLoan(address token, uint256 assets, bytes calldata data) external',
  ]);

  it('should encode using Morpho flashLoan selector', () => {
    const provider = new MorphoFlashLoanProvider(createConfig());
    const calldata = provider.buildCalldata({
      asset: FLASH_LOAN_TEST_ADDRESSES.WETH,
      amount: ethers.parseEther('10'),
      chain: 'ethereum',
      swapPath: [
        { router: FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP, tokenIn: FLASH_LOAN_TEST_ADDRESSES.WETH, tokenOut: FLASH_LOAN_TEST_ADDRESSES.USDC, amountOutMin: 1n },
        { router: FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP, tokenIn: FLASH_LOAN_TEST_ADDRESSES.USDC, tokenOut: FLASH_LOAN_TEST_ADDRESSES.WETH, amountOutMin: 1n },
      ] as FlashLoanSwapStep[],
      minProfit: ethers.parseEther('0.05'),
      initiator: FLASH_LOAN_TEST_ADDRESSES.INITIATOR,
    });

    const expectedSelector = MORPHO_IFACE.getFunction('flashLoan')!.selector;
    expect(calldata.substring(0, 10)).toBe(expectedSelector);
  });

  it('should encode the token address', () => {
    const provider = new MorphoFlashLoanProvider(createConfig());
    const request = {
      asset: FLASH_LOAN_TEST_ADDRESSES.WETH,
      amount: ethers.parseEther('10'),
      chain: 'ethereum',
      swapPath: [
        { router: FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP, tokenIn: FLASH_LOAN_TEST_ADDRESSES.WETH, tokenOut: FLASH_LOAN_TEST_ADDRESSES.USDC, amountOutMin: 1n },
        { router: FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP, tokenIn: FLASH_LOAN_TEST_ADDRESSES.USDC, tokenOut: FLASH_LOAN_TEST_ADDRESSES.WETH, amountOutMin: 1n },
      ] as FlashLoanSwapStep[],
      minProfit: ethers.parseEther('0.05'),
      initiator: FLASH_LOAN_TEST_ADDRESSES.INITIATOR,
    };
    const calldata = provider.buildCalldata(request);
    const decoded = MORPHO_IFACE.decodeFunctionData('flashLoan', calldata);

    expect(decoded[0]).toBe(FLASH_LOAN_TEST_ADDRESSES.WETH);
  });

  it('should encode the correct amount', () => {
    const provider = new MorphoFlashLoanProvider(createConfig());
    const amount = ethers.parseEther('10');
    const request = {
      asset: FLASH_LOAN_TEST_ADDRESSES.WETH,
      amount,
      chain: 'ethereum',
      swapPath: [
        { router: FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP, tokenIn: FLASH_LOAN_TEST_ADDRESSES.WETH, tokenOut: FLASH_LOAN_TEST_ADDRESSES.USDC, amountOutMin: 1n },
        { router: FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP, tokenIn: FLASH_LOAN_TEST_ADDRESSES.USDC, tokenOut: FLASH_LOAN_TEST_ADDRESSES.WETH, amountOutMin: 1n },
      ] as FlashLoanSwapStep[],
      minProfit: ethers.parseEther('0.05'),
      initiator: FLASH_LOAN_TEST_ADDRESSES.INITIATOR,
    };
    const calldata = provider.buildCalldata(request);
    const decoded = MORPHO_IFACE.decodeFunctionData('flashLoan', calldata);

    expect(decoded[1]).toBe(amount);
  });

  it('should encode inner data with swap path, minProfit, and deadline', () => {
    const provider = new MorphoFlashLoanProvider(createConfig());
    const request = {
      asset: FLASH_LOAN_TEST_ADDRESSES.WETH,
      amount: ethers.parseEther('10'),
      chain: 'ethereum',
      swapPath: [
        { router: FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP, tokenIn: FLASH_LOAN_TEST_ADDRESSES.WETH, tokenOut: FLASH_LOAN_TEST_ADDRESSES.USDC, amountOutMin: 1n },
        { router: FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP, tokenIn: FLASH_LOAN_TEST_ADDRESSES.USDC, tokenOut: FLASH_LOAN_TEST_ADDRESSES.WETH, amountOutMin: 1n },
      ] as FlashLoanSwapStep[],
      minProfit: ethers.parseEther('0.05'),
      initiator: FLASH_LOAN_TEST_ADDRESSES.INITIATOR,
    };
    const calldata = provider.buildCalldata(request);
    const decoded = MORPHO_IFACE.decodeFunctionData('flashLoan', calldata);

    const innerData = decoded[2];
    const innerDecoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ['tuple(address,address,address,uint256)[]', 'uint256', 'uint256'],
      innerData
    );

    expect(innerDecoded[0].length).toBe(2);
    expect(innerDecoded[1]).toBe(request.minProfit);
    expect(Number(innerDecoded[2])).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});

// =============================================================================
// Morpho-Specific: Morpho Blue getter
// =============================================================================

describe('MorphoFlashLoanProvider — Morpho Blue getter', () => {
  it('should return Morpho Blue address matching poolAddress', () => {
    const provider = new MorphoFlashLoanProvider(createConfig());
    expect(provider.getMorphoBlueAddress()).toBe(MORPHO_BLUE);
    expect(provider.getMorphoBlueAddress()).toBe(provider.poolAddress);
  });
});

// =============================================================================
// Morpho-Specific: Zero-fee characteristics
// =============================================================================

describe('MorphoFlashLoanProvider — zero-fee characteristics', () => {
  it('should have zero fee for any amount', () => {
    const provider = new MorphoFlashLoanProvider(createConfig());
    const amounts = [1n, ethers.parseEther('1'), ethers.parseEther('1000000')];

    for (const amount of amounts) {
      const feeInfo = provider.calculateFee(amount);
      expect(feeInfo.feeBps).toBe(0);
      expect(feeInfo.feeAmount).toBe(0n);
    }
  });

  it('should support any token (empty supportedTokens)', () => {
    const provider = new MorphoFlashLoanProvider(createConfig());
    const capabilities = provider.getCapabilities();
    expect(capabilities.supportedTokens).toEqual([]);
  });
});
