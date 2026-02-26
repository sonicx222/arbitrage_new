/**
 * Unit Tests for BalancerV2FlashLoanProvider
 *
 * Uses the shared flash-loan-provider harness for common tests,
 * plus Balancer V2-specific tests for zero-fee advantage and vault address.
 *
 * @see balancer-v2.provider.ts
 * @see contracts/src/BalancerV2FlashArbitrage.sol
 */

import { ethers } from 'ethers';
import { BalancerV2FlashLoanProvider } from '../../../../src/strategies/flash-loan-providers/balancer-v2.provider';
import {
  testFlashLoanProvider,
  FLASH_LOAN_TEST_ADDRESSES,
} from '@arbitrage/test-utils/harnesses/flash-loan-provider.harness';

// Mock @arbitrage/config — must be inline literal (hoisted above const)
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
// Balancer V2 Config
// =============================================================================

const BALANCER_VAULT = '0xBA12222222228d8Ba445958a75a0704d566BF2C8';

const createConfig = (overrides?: Record<string, any>) => ({
  chain: 'ethereum',
  poolAddress: BALANCER_VAULT,
  contractAddress: FLASH_LOAN_TEST_ADDRESSES.CONTRACT,
  approvedRouters: [FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP, FLASH_LOAN_TEST_ADDRESSES.ROUTER_SUSHISWAP],
  ...overrides,
});

// =============================================================================
// Shared Tests (constructor, fee, validation, calldata, gas, integration)
// =============================================================================

testFlashLoanProvider({
  name: 'BalancerV2FlashLoanProvider',
  protocol: 'balancer_v2',
  ProviderClass: BalancerV2FlashLoanProvider,
  defaultFeeBps: 0,
  defaultGasEstimate: 550000n,
  poolAddress: BALANCER_VAULT,
  createConfig,
});

// =============================================================================
// Balancer V2-Specific Tests
// =============================================================================

describe('BalancerV2FlashLoanProvider — zero-fee advantage', () => {
  it('should always return zero fee regardless of amount', () => {
    const provider = new BalancerV2FlashLoanProvider(createConfig());
    const amounts = [1n, 1000n, ethers.parseEther('1'), ethers.parseEther('1000'), ethers.parseEther('1000000')];

    for (const amount of amounts) {
      const feeInfo = provider.calculateFee(amount);
      expect(feeInfo.feeAmount).toBe(0n);
      expect(feeInfo.feeBps).toBe(0);
    }
  });

  it('should return vault address from getVaultAddress() matching poolAddress', () => {
    const provider = new BalancerV2FlashLoanProvider(createConfig());
    expect(provider.getVaultAddress()).toBe(BALANCER_VAULT);
    expect(provider.getVaultAddress()).toBe(provider.poolAddress);
  });
});

describe('BalancerV2FlashLoanProvider — supported chains', () => {
  const SUPPORTED_CHAINS = ['ethereum', 'polygon', 'arbitrum', 'optimism', 'base', 'fantom'];

  it.each(SUPPORTED_CHAINS)('should create provider for %s', (chain) => {
    const provider = new BalancerV2FlashLoanProvider(createConfig({ chain }));
    expect(provider.chain).toBe(chain);
    expect(provider.protocol).toBe('balancer_v2');
    expect(provider.isAvailable()).toBe(true);
  });

  it('should create provider for any chain string', () => {
    const provider = new BalancerV2FlashLoanProvider(createConfig({ chain: 'custom-chain' }));
    expect(provider.chain).toBe('custom-chain');
  });
});
