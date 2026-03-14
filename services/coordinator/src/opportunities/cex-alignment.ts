/**
 * CEX Alignment Calculator
 *
 * Computes a CEX-DEX alignment factor for opportunity scoring.
 * Uses the spread between CEX (Binance) and DEX prices to determine
 * whether an arbitrage opportunity is aligned with or contradicts
 * the "true" market price.
 *
 * Spread convention (from CexDexSpreadCalculator):
 *   spreadPct = ((dexPrice - cexPrice) / cexPrice) * 100
 *   Positive = DEX more expensive than CEX
 *   Negative = DEX cheaper than CEX
 *
 * Alignment logic:
 *   If we're BUYING on a DEX where price < CEX (spread negative) -> aligned (boost)
 *   If we're BUYING on a DEX where price > CEX (spread positive) -> contradicted (penalize)
 *   If spread is within noise band (±0.1%) -> neutral
 *
 * @see ADR-036: CEX Price Signals
 * @see docs/plans/2026-03-11-cex-price-signal-integration.md -- Batch 3
 * @module opportunities
 */

import type { CexPriceFeedService } from '@arbitrage/core/feeds';

// =============================================================================
// Constants (M-09 FIX: configurable via env vars for tuning without redeploy)
// =============================================================================

/** Parse a float env var with bounds and default. */
function parseEnvFloat(key: string, defaultValue: number, min?: number, max?: number): number {
  const raw = process.env[key];
  if (raw === undefined) return defaultValue;
  const parsed = parseFloat(raw);
  if (isNaN(parsed)) return defaultValue;
  let value = parsed;
  if (min !== undefined) value = Math.max(min, value);
  if (max !== undefined) value = Math.min(max, value);
  return value;
}

/** Spread noise band (%). Spreads within this range are considered neutral. */
const NOISE_BAND_PCT = parseEnvFloat('CEX_NOISE_BAND_PCT', 0.1, 0, 5);

/** Boost factor when DEX arb direction aligns with CEX-DEX spread. */
const ALIGNED_FACTOR = parseEnvFloat('CEX_ALIGNED_FACTOR', 1.15, 1, 2);

/** Penalty factor when DEX arb direction contradicts CEX-DEX spread. */
const CONTRADICTED_FACTOR = parseEnvFloat('CEX_CONTRADICTED_FACTOR', 0.8, 0.1, 1);

/** Neutral factor (no CEX data or within noise band). */
const NEUTRAL_FACTOR = 1.0;

// =============================================================================
// Alignment Computation
// =============================================================================

/**
 * Compute CEX alignment factor for an opportunity.
 *
 * Uses the buy-side spread as the primary signal:
 * - If the DEX where we're buying is underpriced vs CEX -> the arb is aligned
 *   with where the market "should" converge -> boost score
 * - If the DEX where we're buying is overpriced vs CEX -> the arb contradicts
 *   the fair value -> penalize score
 *
 * For cross-chain opportunities, also considers the sell-side spread for
 * additional confirmation.
 *
 * @param baseToken - Token ID (e.g., 'WETH', 'WBTC') for CEX lookup
 * @param buyChain - Chain where the opportunity buys the token
 * @param sellChain - Chain where the opportunity sells the token
 * @param cexFeed - CexPriceFeedService instance for spread lookup
 * @returns Alignment factor: 1.15 (aligned), 0.8 (contradicted), 1.0 (neutral/no data)
 */
export function computeCexAlignment(
  baseToken: string,
  buyChain: string,
  sellChain: string,
  cexFeed: CexPriceFeedService,
): number {
  const buySpread = cexFeed.getSpread(baseToken, buyChain);

  // No CEX data for buy side -> neutral
  if (buySpread === undefined) return NEUTRAL_FACTOR;

  // Buy-side logic:
  // spreadPct > 0 means DEX overpriced vs CEX. Buying there = contradicted.
  // spreadPct < 0 means DEX underpriced vs CEX. Buying there = aligned.
  if (buySpread < -NOISE_BAND_PCT) return ALIGNED_FACTOR;
  if (buySpread > NOISE_BAND_PCT) return CONTRADICTED_FACTOR;

  // Within noise band on buy side — check sell side for cross-chain
  if (buyChain !== sellChain) {
    const sellSpread = cexFeed.getSpread(baseToken, sellChain);
    if (sellSpread !== undefined) {
      // If sell DEX is overpriced vs CEX, selling there is aligned
      if (sellSpread > NOISE_BAND_PCT) return ALIGNED_FACTOR;
      // If sell DEX is underpriced vs CEX, selling there is contradicted
      if (sellSpread < -NOISE_BAND_PCT) return CONTRADICTED_FACTOR;
    }
  }

  return NEUTRAL_FACTOR;
}

// =============================================================================
// Degraded Mode Adaptive Threshold
// =============================================================================

const DEFAULT_DEGRADED_MULTIPLIER = 1.2;
const MIN_DEGRADED_MULTIPLIER = 1.0;
const MAX_DEGRADED_MULTIPLIER = 3.0;

/**
 * Get the profit threshold multiplier for CEX-degraded mode.
 *
 * When CEX feed is degraded, the system loses its ability to penalize
 * opportunities that contradict the CEX-DEX spread. To compensate, we raise
 * the minimum profit threshold by this multiplier.
 *
 * @param isDegraded - Whether the CEX feed is in DEGRADED state
 * @returns Multiplier to apply to minProfitPercentage (1.0 = no change)
 */
export function getCexDegradedProfitMultiplier(isDegraded: boolean): number {
  if (!isDegraded) return 1.0;

  const envVal = process.env.CEX_DEGRADED_PROFIT_MULTIPLIER;
  if (envVal === undefined) return DEFAULT_DEGRADED_MULTIPLIER;

  const parsed = parseFloat(envVal);
  if (isNaN(parsed)) return DEFAULT_DEGRADED_MULTIPLIER;

  return Math.max(MIN_DEGRADED_MULTIPLIER, Math.min(MAX_DEGRADED_MULTIPLIER, parsed));
}
