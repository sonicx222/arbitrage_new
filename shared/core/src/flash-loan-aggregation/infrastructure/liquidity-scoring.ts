/**
 * Shared Liquidity Scoring
 *
 * Centralized liquidity score calculation used by both
 * WeightedRankingStrategy and OnChainLiquidityValidator.
 *
 * Scoring thresholds:
 * - Available >= 2x required: 1.0 (plenty)
 * - Available >= 1.1x required: 0.9 (adequate with margin)
 * - Available >= 1x required: 0.7 (just enough)
 * - Available < 1x required: 0.3 (insufficient)
 * - No data available: 0.7 (conservative default)
 */

/** Default score when no liquidity data is available */
export const DEFAULT_LIQUIDITY_SCORE = 0.7;

/**
 * Calculate liquidity score based on available vs required amount.
 *
 * @param available - Available liquidity (bigint)
 * @param requiredWithMargin - Required amount with safety margin applied (bigint)
 * @param rawRequired - Raw required amount without margin (bigint)
 * @returns Score from 0.3 to 1.0
 */
export function calculateLiquidityScore(
  available: bigint,
  requiredWithMargin: bigint,
  rawRequired: bigint
): number {
  if (available >= requiredWithMargin * 2n) {
    return 1.0; // Plenty of liquidity (2x required)
  } else if (available >= requiredWithMargin) {
    return 0.9; // Adequate liquidity with margin
  } else if (available >= rawRequired) {
    return 0.7; // Just enough (no safety margin)
  } else {
    return 0.3; // Insufficient
  }
}
