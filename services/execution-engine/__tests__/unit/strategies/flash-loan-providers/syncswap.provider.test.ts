/**
 * Unit Tests for SyncSwapFlashLoanProvider
 *
 * Uses the shared flash-loan-provider harness for common tests,
 * plus SyncSwap-specific tests for zkSync chain and vault address.
 *
 * @see syncswap.provider.ts
 * @see contracts/src/SyncSwapFlashArbitrage.sol
 */

import { ethers } from 'ethers';
import { SyncSwapFlashLoanProvider } from '../../../../src/strategies/flash-loan-providers/syncswap.provider';
import type { FlashLoanSwapStep } from '../../../../src/strategies/flash-loan-providers/types';
import {
  testFlashLoanProvider,
  FLASH_LOAN_TEST_ADDRESSES,
} from '@arbitrage/test-utils/harnesses/flash-loan-provider.harness';

// Mock @arbitrage/config — must be inline literal (hoisted above const)
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

jest.mock('../../../../src/strategies/base.strategy', () => ({
  getSwapDeadline: () => Math.floor(Date.now() / 1000) + 300,
}));

// =============================================================================
// SyncSwap Config
// =============================================================================

const SYNCSWAP_VAULT = '0x621425a1Ef6abE91058E9712575dcc4258F8d091';

const createConfig = (overrides?: Record<string, any>) => ({
  chain: 'zksync',
  poolAddress: SYNCSWAP_VAULT,
  contractAddress: FLASH_LOAN_TEST_ADDRESSES.CONTRACT,
  approvedRouters: [FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP, FLASH_LOAN_TEST_ADDRESSES.ROUTER_SUSHISWAP],
  ...overrides,
});

// =============================================================================
// Shared Tests (constructor, fee, validation, calldata, gas, integration)
// =============================================================================

testFlashLoanProvider({
  name: 'SyncSwapFlashLoanProvider',
  protocol: 'syncswap',
  ProviderClass: SyncSwapFlashLoanProvider,
  defaultFeeBps: 30,
  defaultGasEstimate: 520000n,
  poolAddress: SYNCSWAP_VAULT,
  defaultChain: 'zksync',
  createConfig,
});

// =============================================================================
// SyncSwap-Specific Tests
// =============================================================================

describe('SyncSwapFlashLoanProvider — vault address', () => {
  it('should return vault address from getVaultAddress() matching poolAddress', () => {
    const provider = new SyncSwapFlashLoanProvider(createConfig());
    expect(provider.getVaultAddress()).toBe(SYNCSWAP_VAULT);
    expect(provider.getVaultAddress()).toBe(provider.poolAddress);
  });
});

describe('SyncSwapFlashLoanProvider — case-insensitive validation', () => {
  const WETH_ZKSYNC = '0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91';
  const USDC_ZKSYNC = '0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf4';
  const SYNCSWAP_ROUTER = '0x2da10A1e27bF85cEdD8FFb1AbBe97e53391C0295';

  it('should accept valid cycle with case-insensitive token matching', () => {
    const provider = new SyncSwapFlashLoanProvider(createConfig({ approvedRouters: [SYNCSWAP_ROUTER] }));

    const result = provider.validate({
      asset: WETH_ZKSYNC.toLowerCase(),
      amount: ethers.parseEther('10'),
      chain: 'zksync',
      swapPath: [
        { router: SYNCSWAP_ROUTER, tokenIn: '0x' + WETH_ZKSYNC.slice(2).toUpperCase(), tokenOut: USDC_ZKSYNC, amountOutMin: ethers.parseUnits('24875', 6) },
        { router: SYNCSWAP_ROUTER, tokenIn: USDC_ZKSYNC, tokenOut: WETH_ZKSYNC.toLowerCase(), amountOutMin: ethers.parseEther('9.95') },
      ] as FlashLoanSwapStep[],
      minProfit: ethers.parseEther('0.1'),
      initiator: FLASH_LOAN_TEST_ADDRESSES.INITIATOR,
    });

    expect(result.valid).toBe(true);
  });

  it('should accept case-insensitive asset match', () => {
    const provider = new SyncSwapFlashLoanProvider(createConfig({ approvedRouters: [SYNCSWAP_ROUTER] }));

    const result = provider.validate({
      asset: WETH_ZKSYNC.toLowerCase(),
      amount: ethers.parseEther('10'),
      chain: 'zksync',
      swapPath: [
        { router: SYNCSWAP_ROUTER, tokenIn: WETH_ZKSYNC.toUpperCase(), tokenOut: USDC_ZKSYNC, amountOutMin: ethers.parseUnits('24875', 6) },
        { router: SYNCSWAP_ROUTER, tokenIn: USDC_ZKSYNC, tokenOut: WETH_ZKSYNC, amountOutMin: ethers.parseEther('9.95') },
      ] as FlashLoanSwapStep[],
      minProfit: ethers.parseEther('0.1'),
      initiator: FLASH_LOAN_TEST_ADDRESSES.INITIATOR,
    });

    expect(result.valid).toBe(true);
  });
});
