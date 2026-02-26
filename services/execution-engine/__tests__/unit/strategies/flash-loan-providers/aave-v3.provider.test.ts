/**
 * Unit Tests for AaveV3FlashLoanProvider
 *
 * Uses the shared flash-loan-provider harness for common tests,
 * plus Aave V3-specific tests for fee precision edge cases.
 *
 * @see aave-v3.provider.ts
 * @see contracts/src/FlashLoanArbitrage.sol
 */

import { ethers } from 'ethers';
import { AaveV3FlashLoanProvider } from '../../../../src/strategies/flash-loan-providers/aave-v3.provider';
import {
  testFlashLoanProvider,
  FLASH_LOAN_TEST_ADDRESSES,
} from '@arbitrage/test-utils/harnesses/flash-loan-provider.harness';

// Mock @arbitrage/config — must be inline literal (hoisted above const)
jest.mock('@arbitrage/config', () => ({
  __esModule: true,
  AAVE_V3_FEE_BPS: 9,
  getBpsDenominatorBigInt: () => BigInt(10000),
  FLASH_LOAN_ARBITRAGE_ABI: [
    'function executeArbitrage(address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath, uint256 minProfit, uint256 deadline) external',
    'function calculateExpectedProfit(address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath) external view returns (uint256 expectedProfit, uint256 flashLoanFee)',
    'function isApprovedRouter(address router) external view returns (bool)',
    'function POOL() external view returns (address)',
  ],
}));

jest.mock('../../../../src/strategies/base.strategy', () => ({
  getSwapDeadline: () => Math.floor(Date.now() / 1000) + 300,
}));

// =============================================================================
// Aave V3 Config
// =============================================================================

const AAVE_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';

const createConfig = (overrides?: Record<string, any>) => ({
  chain: 'ethereum',
  poolAddress: AAVE_POOL,
  contractAddress: FLASH_LOAN_TEST_ADDRESSES.CONTRACT,
  approvedRouters: [FLASH_LOAN_TEST_ADDRESSES.ROUTER_UNISWAP, FLASH_LOAN_TEST_ADDRESSES.ROUTER_SUSHISWAP],
  ...overrides,
});

// =============================================================================
// Shared Tests (constructor, fee, validation, calldata, gas, integration)
// =============================================================================

testFlashLoanProvider({
  name: 'AaveV3FlashLoanProvider',
  protocol: 'aave_v3',
  ProviderClass: AaveV3FlashLoanProvider,
  defaultFeeBps: 9,
  defaultGasEstimate: 500000n,
  poolAddress: AAVE_POOL,
  createConfig,
});

// =============================================================================
// Aave V3-Specific Tests
// =============================================================================

describe('AaveV3FlashLoanProvider — fee precision edge cases', () => {
  it('should calculate correct fee using integer division (rounds down)', () => {
    const provider = new AaveV3FlashLoanProvider(createConfig());
    // 9999 * 9 / 10000 = 89991 / 10000 = 8 (integer division)
    expect(provider.calculateFee(9999n).feeAmount).toBe(8n);
  });

  it('should lose fee to rounding for amounts below ~1112 wei', () => {
    const provider = new AaveV3FlashLoanProvider(createConfig());
    // 1111 * 9 / 10000 = 9999 / 10000 = 0
    expect(provider.calculateFee(1111n).feeAmount).toBe(0n);
  });

  it('should return exactly 9 for 10000 wei', () => {
    const provider = new AaveV3FlashLoanProvider(createConfig());
    expect(provider.calculateFee(10000n).feeAmount).toBe(9n);
  });
});

describe('AaveV3FlashLoanProvider — supported chains', () => {
  const SUPPORTED_CHAINS = ['ethereum', 'polygon', 'arbitrum', 'base', 'optimism', 'avalanche'];

  it.each(SUPPORTED_CHAINS)('should create provider for %s', (chain) => {
    const provider = new AaveV3FlashLoanProvider(createConfig({ chain }));
    expect(provider.chain).toBe(chain);
    expect(provider.protocol).toBe('aave_v3');
    expect(provider.isAvailable()).toBe(true);
  });
});
