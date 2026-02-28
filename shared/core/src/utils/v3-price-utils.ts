/**
 * Uniswap V3 Price Utilities
 *
 * Converts V3 sqrtPriceX96 values into human-readable prices and
 * virtual reserves compatible with the existing reserve-based detection system.
 *
 * V3 pools store price as sqrt(price) in Q64.96 fixed-point format:
 *   sqrtPriceX96 = sqrt(token1/token0) * 2^96
 *
 * Virtual reserve formulas (within a single tick, V3 behaves as constant-product):
 *   reserve0 = liquidity * Q96 / sqrtPriceX96
 *   reserve1 = liquidity * sqrtPriceX96 / Q96
 *
 * @see liquidity-depth-analyzer.ts for the same formulas used in trade sizing
 * @see ADR-022 for hot-path performance requirements
 */

const Q96 = 1n << 96n;
const Q192 = 1n << 192n;

/**
 * Convert sqrtPriceX96 to a human-readable price (token1 per token0),
 * adjusted for token decimal differences.
 *
 * @param sqrtPriceX96 - sqrt(price) in Q64.96 format from V3 Swap event
 * @param token0Decimals - Decimals of token0
 * @param token1Decimals - Decimals of token1
 * @returns Human-readable price (token1 per token0), or null if input is invalid
 */
export function calculatePriceFromSqrtPriceX96(
  sqrtPriceX96: bigint,
  token0Decimals: number,
  token1Decimals: number,
): number | null {
  if (sqrtPriceX96 <= 0n) return null;

  // price = (sqrtPriceX96 / 2^96)^2 = sqrtPriceX96^2 / 2^192
  // To preserve precision, compute as: (sqrtPriceX96^2 * 10^18) / 2^192
  // then divide by 10^18 in floating point
  const PRECISION = 10n ** 18n;
  const numerator = sqrtPriceX96 * sqrtPriceX96 * PRECISION;
  const rawPrice = numerator / Q192;

  if (rawPrice === 0n) return null;

  // Convert to float and adjust for decimal difference
  const price = Number(rawPrice) / 1e18;
  const decimalAdjustment = 10 ** (token0Decimals - token1Decimals);
  const adjustedPrice = price * decimalAdjustment;

  if (!Number.isFinite(adjustedPrice) || adjustedPrice <= 0) return null;

  return adjustedPrice;
}

/**
 * Compute virtual reserves from V3 sqrtPriceX96 and liquidity values.
 *
 * These virtual reserves can be fed directly into the existing reserve-based
 * detection system (checkArbitrageOpportunity, emitPriceUpdate) so that V3
 * pools appear as standard AMM pairs to downstream consumers.
 *
 * @param sqrtPriceX96 - sqrt(price) in Q64.96 format
 * @param liquidity - Active liquidity (uint128) at the current tick
 * @returns Virtual reserves { reserve0, reserve1 }, or null if inputs are invalid
 */
export function calculateVirtualReservesFromSqrtPriceX96(
  sqrtPriceX96: bigint,
  liquidity: bigint,
): { reserve0: bigint; reserve1: bigint } | null {
  if (sqrtPriceX96 <= 0n || liquidity <= 0n) return null;

  const reserve0 = (liquidity * Q96) / sqrtPriceX96;
  const reserve1 = (liquidity * sqrtPriceX96) / Q96;

  // Guard against degenerate reserves (zero means pool is at price boundary)
  if (reserve0 === 0n || reserve1 === 0n) return null;

  return { reserve0, reserve1 };
}
