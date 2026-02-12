/**
 * Exchange Rate Configuration Helpers
 *
 * Named rate constants and setup functions to replace magic BigInt values
 * scattered across test files. MockDexRouter calculates:
 *   amountOut = (amountIn * rate) / 1e18
 *
 * @see contracts/src/mocks/MockDexRouter.sol
 * @see performance-refactor.md Refactoring #2: Extract Exchange Rate Helper
 */
import { ethers } from 'hardhat';
import { MockDexRouter } from '../../typechain-types';

// =============================================================================
// Named Rate Constants
// =============================================================================

/**
 * Rate constant for USDC -> WETH that yields ~1% profit on round trip.
 * With forward rate 1 WETH = 2000 USDC:
 *   2000 USDC -> (2000e6 * 5.05e26) / 1e18 = 1.01 WETH (~1% profit)
 */
export const RATE_USDC_TO_WETH_1PCT_PROFIT = BigInt('505000000000000000000000000');

/**
 * Rate constant for USDC -> WETH that yields ~2% profit on round trip.
 * With forward rate 1 WETH = 2000 USDC:
 *   2000 USDC -> (2000e6 * 5.1e26) / 1e18 = 1.02 WETH (~2% profit)
 */
export const RATE_USDC_TO_WETH_2PCT_PROFIT = BigInt('510000000000000000000000000');

/** Standard forward rate: 1 WETH = 2000 USDC */
export const RATE_WETH_TO_USDC = ethers.parseUnits('2000', 6);

/** Standard forward rate: 1 USDC = 1.01 DAI */
export const RATE_USDC_TO_DAI = ethers.parseEther('1.01');

/** Standard forward rate: 1 DAI = 0.000505 WETH (profitable return leg) */
export const RATE_DAI_TO_WETH_PROFIT = BigInt('505000000000000');

// =============================================================================
// Rate Setup Functions
// =============================================================================

/**
 * Set up a profitable WETH -> USDC -> WETH round-trip on a single router.
 *
 * Forward: 1 WETH = 2000 USDC
 * Reverse: 2000 USDC = (1 + profit%) WETH
 *
 * @param router - MockDexRouter to configure
 * @param wethAddr - WETH token address
 * @param usdcAddr - USDC token address
 * @param reverseRate - USDC->WETH rate (default: ~1% profit)
 */
export async function setupProfitableWethUsdcRates(
  router: MockDexRouter,
  wethAddr: string,
  usdcAddr: string,
  reverseRate: bigint = RATE_USDC_TO_WETH_1PCT_PROFIT,
): Promise<void> {
  await router.setExchangeRate(wethAddr, usdcAddr, RATE_WETH_TO_USDC);
  await router.setExchangeRate(usdcAddr, wethAddr, reverseRate);
}

/**
 * Set up triangular arbitrage rates: WETH -> USDC -> DAI -> WETH
 * on two routers, with a profitable return on the final leg.
 */
export async function setupTriangularRates(
  router1: MockDexRouter,
  router2: MockDexRouter,
  wethAddr: string,
  usdcAddr: string,
  daiAddr: string,
): Promise<void> {
  // Leg 1: WETH -> USDC on router1
  await router1.setExchangeRate(wethAddr, usdcAddr, RATE_WETH_TO_USDC);
  // Leg 2: USDC -> DAI on router1
  await router1.setExchangeRate(usdcAddr, daiAddr, RATE_USDC_TO_DAI);
  // Leg 3: DAI -> WETH on router2 (profitable)
  await router2.setExchangeRate(daiAddr, wethAddr, RATE_DAI_TO_WETH_PROFIT);
}
