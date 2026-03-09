/**
 * Exchange Rate Configuration Helpers
 *
 * Named rate constants and setup functions to replace magic BigInt values
 * scattered across test files. MockDexRouter calculates:
 *   amountOut = (amountIn * rate) / 1e18
 *
 * ## Decimal Convention (H-04)
 *
 * Rate values encode the OUTPUT AMOUNT per 1e18 INPUT in raw token units:
 *
 * | Pair         | Rate Value          | Meaning                            |
 * |-------------|--------------------|------------------------------------|
 * | WETH→USDC   | 2000e6 (2000000000) | 1e18 WETH in → 2000e6 USDC out    |
 * | USDC→WETH   | 5e14 (500000000000000) | 1e18 "USDC units" in → 0.0005 WETH out |
 * | WETH→DAI    | 2000e18             | 1e18 WETH in → 2000e18 DAI out    |
 *
 * **Key insight**: The rate denominator is ALWAYS 1e18 regardless of token decimals.
 * This means cross-decimal pairs (WETH 18d → USDC 6d) need rates scaled to the
 * OUTPUT token's decimals. Use `ethers.parseUnits(value, outputDecimals)` for clarity.
 *
 * **When feeBps > 0** (M-05): Output is further reduced:
 *   finalOutput = (amountOut * (10000 - feeBps)) / 10000
 *
 * **When ammMode is enabled** (H-03): Static rates are ignored in favor of
 * constant-product formula using configured reserves.
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

/**
 * Standard forward rate: 1 USDC = 1.01 DAI (cross-decimal: 6d → 18d)
 *
 * MockDexRouter formula: amountOut = (amountIn * rate) / 1e18
 * For 1 USDC (1e6 raw): amountOut = (1e6 * 1.01e30) / 1e18 = 1.01e18 = 1.01 DAI ✓
 *
 * @see UniswapV3Adapter.test.ts for matching local constant
 */
export const RATE_USDC_TO_DAI = BigInt('1010000000000000000000000000000'); // 1.01e30

/** Standard forward rate: 1 DAI = 0.000505 WETH (profitable return leg) */
export const RATE_DAI_TO_WETH_PROFIT = BigInt('505000000000000');

/**
 * Rate constant for USDC -> WETH that yields ~20% profit on round trip.
 * With forward rate 1 WETH = 2000 USDC:
 *   2000 USDC -> (2000e6 * 6e26) / 1e18 = 1.2 WETH (~20% profit)
 *
 * Used by SyncSwap and Balancer tests where large profit margins are needed
 * to cover flash loan fees and still produce a meaningful profit.
 */
export const RATE_USDC_TO_WETH_20PCT_PROFIT = BigInt('600000000000000000000000000');

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

