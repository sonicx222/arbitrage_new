/**
 * Shared Arbitrage Calculator Module
 *
 * REF-1/ARCH-1 FIX: Centralized arbitrage calculation logic used by:
 * - unified-detector/chain-instance.ts (intra-chain arbitrage)
 * - cross-chain-detector/detector.ts (cross-chain arbitrage)
 *
 * This eliminates code duplication and ensures consistent calculation
 * across all arbitrage detection services.
 *
 * @see ARCHITECTURE_V2.md Section 4.3 (Arbitrage Detection)
 */

import { ARBITRAGE_CONFIG } from '../../config/src';
import type { ArbitrageOpportunity } from '../../types/src';

// =============================================================================
// Types
// =============================================================================

/**
 * Snapshot of a trading pair for arbitrage calculation.
 * Immutable to prevent race conditions during calculation.
 */
export interface PairSnapshot {
  address: string;
  dex: string;
  token0: string;
  token1: string;
  reserve0: string;
  reserve1: string;
  fee: number;
  blockNumber: number;
}

/**
 * Price data for cross-chain arbitrage.
 */
export interface ChainPriceData {
  chain: string;
  dex: string;
  price: number;
  fee?: number;
  timestamp: number;
  pairKey?: string;
}

/**
 * Result of price comparison between two sources.
 */
export interface PriceComparisonResult {
  priceDiff: number;
  percentageDiff: number;
  totalFees: number;
  netProfitPct: number;
  buyPrice: number;
  sellPrice: number;
  buySource: string;
  sellSource: string;
}

/**
 * Configuration for arbitrage calculation.
 */
export interface ArbitrageCalcConfig {
  chainId: string;
  gasEstimate?: number;
  confidence?: number;
  expiryMs?: number;
}

// =============================================================================
// Precision Constants (P0-1 FIX)
// =============================================================================

/**
 * Precision scale for BigInt arithmetic to avoid floating point precision loss.
 * Using 10^18 (same as ETH wei) provides excellent precision for price calculations.
 *
 * The JavaScript Number type can safely represent integers up to 2^53 - 1.
 * By scaling to 10^18 and then dividing, we preserve precision for reserve
 * values up to approximately 10^15 tokens (in wei, that's 10^33).
 */
const PRICE_PRECISION = 10n ** 18n;
const PRICE_PRECISION_NUMBER = 1e18;

// =============================================================================
// Price Calculation Utilities (ARCH-3)
// =============================================================================

/**
 * Safely convert BigInt to Number with precision scaling.
 * This prevents precision loss for large BigInt values.
 *
 * P0-1 FIX: Uses scaled division to preserve precision.
 *
 * @param value - The BigInt value
 * @param divisor - The divisor BigInt (must be > 0)
 * @returns The result as a Number with preserved precision
 */
export function safeBigIntDivision(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) {
    return 0;
  }

  // Scale up the numerator before division to preserve decimal places
  const scaledResult = (numerator * PRICE_PRECISION) / denominator;

  // Convert scaled result to number and divide by scale
  return Number(scaledResult) / PRICE_PRECISION_NUMBER;
}

/**
 * Calculate price from reserves with full BigInt precision.
 * Price = reserve0 / reserve1 (price of token1 in terms of token0)
 *
 * P0-1 FIX: Uses scaled BigInt arithmetic to prevent precision loss
 * that occurs when converting large BigInt values directly to Number.
 *
 * Example: For reserves of 1e27 (1 billion tokens in wei), direct Number
 * conversion would lose precision, but scaled division preserves it.
 */
export function calculatePriceFromReserves(reserve0: string, reserve1: string): number | null {
  try {
    const r0 = BigInt(reserve0);
    const r1 = BigInt(reserve1);

    if (r0 === 0n || r1 === 0n) {
      return null;
    }

    return safeBigIntDivision(r0, r1);
  } catch {
    // Handle invalid BigInt strings gracefully
    return null;
  }
}

/**
 * Calculate price from BigInt reserves directly (avoids string parsing overhead).
 * P0-1 FIX: Optimized version for when reserves are already BigInt.
 */
export function calculatePriceFromBigIntReserves(reserve0: bigint, reserve1: bigint): number | null {
  if (reserve0 === 0n || reserve1 === 0n) {
    return null;
  }

  return safeBigIntDivision(reserve0, reserve1);
}

/**
 * Invert price for reverse token order comparison.
 */
export function invertPrice(price: number): number {
  if (price === 0) return 0;
  return 1 / price;
}

/**
 * Calculate price difference as percentage of lower price.
 */
export function calculatePriceDifferencePercent(price1: number, price2: number): number {
  const minPrice = Math.min(price1, price2);
  if (minPrice === 0) return 0;
  return Math.abs(price1 - price2) / minPrice;
}

// =============================================================================
// Token Pair Utilities
// =============================================================================

/**
 * Check if two pairs represent the same token pair (in either order).
 * Uses case-insensitive comparison for addresses.
 */
export function isSameTokenPair(pair1: PairSnapshot, pair2: PairSnapshot): boolean {
  const token1_0 = pair1.token0.toLowerCase();
  const token1_1 = pair1.token1.toLowerCase();
  const token2_0 = pair2.token0.toLowerCase();
  const token2_1 = pair2.token1.toLowerCase();

  return (
    (token1_0 === token2_0 && token1_1 === token2_1) ||
    (token1_0 === token2_1 && token1_1 === token2_0)
  );
}

/**
 * Check if token order is reversed between two pairs.
 */
export function isReverseOrder(pair1: PairSnapshot, pair2: PairSnapshot): boolean {
  const token1_0 = pair1.token0.toLowerCase();
  const token1_1 = pair1.token1.toLowerCase();
  const token2_0 = pair2.token0.toLowerCase();
  const token2_1 = pair2.token1.toLowerCase();

  return token1_0 === token2_1 && token1_1 === token2_0;
}

// =============================================================================
// Profit Threshold Utilities
// =============================================================================

/**
 * Get minimum profit threshold for a specific chain from config.
 * Uses ARBITRAGE_CONFIG.chainMinProfits with fallback to default.
 */
export function getMinProfitThreshold(chainId: string): number {
  const chainMinProfits = ARBITRAGE_CONFIG.chainMinProfits as Record<string, number>;
  // Use ?? instead of || to correctly handle 0 min profit
  return chainMinProfits[chainId] ?? 0.003; // Default 0.3%
}

/**
 * Get default fee for a DEX if not specified.
 * Most DEXes use 0.3% (0.003) as default.
 */
export function getDefaultFee(dex?: string): number {
  // Some DEXes have lower default fees
  const lowFeeDexes = ['curve', 'balancer'];
  if (dex && lowFeeDexes.includes(dex.toLowerCase())) {
    return 0.0004; // 0.04% for low-fee DEXes
  }
  return 0.003; // 0.3% default
}

// =============================================================================
// Intra-Chain Arbitrage Calculator
// =============================================================================

/**
 * Calculate intra-chain arbitrage opportunity between two pairs.
 * Used by unified-detector/chain-instance.ts.
 *
 * @param pair1 First trading pair snapshot
 * @param pair2 Second trading pair snapshot
 * @param config Calculation configuration
 * @returns ArbitrageOpportunity or null if not profitable
 */
export function calculateIntraChainArbitrage(
  pair1: PairSnapshot,
  pair2: PairSnapshot,
  config: ArbitrageCalcConfig
): ArbitrageOpportunity | null {
  // Validate reserves
  const price1 = calculatePriceFromReserves(pair1.reserve0, pair1.reserve1);
  const price2Raw = calculatePriceFromReserves(pair2.reserve0, pair2.reserve1);

  if (price1 === null || price2Raw === null) {
    return null;
  }

  // Adjust price for reverse order pairs
  let price2 = price2Raw;
  if (isReverseOrder(pair1, pair2) && price2 !== 0) {
    price2 = invertPrice(price2);
  }

  // Calculate price comparison
  const comparison = comparePrices(
    { price: price1, fee: pair1.fee, source: pair1.dex },
    { price: price2, fee: pair2.fee, source: pair2.dex },
    config.chainId
  );

  if (!comparison.isProfitable) {
    return null;
  }

  // Build opportunity object
  const isBuyFromPair1 = price1 < price2;

  return {
    id: `${config.chainId}-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
    type: 'simple',
    chain: config.chainId,
    buyDex: isBuyFromPair1 ? pair1.dex : pair2.dex,
    sellDex: isBuyFromPair1 ? pair2.dex : pair1.dex,
    buyPair: isBuyFromPair1 ? pair1.address : pair2.address,
    sellPair: isBuyFromPair1 ? pair2.address : pair1.address,
    token0: pair1.token0,
    token1: pair1.token1,
    buyPrice: comparison.buyPrice,
    sellPrice: comparison.sellPrice,
    profitPercentage: comparison.netProfitPct * 100,
    expectedProfit: comparison.netProfitPct,
    estimatedProfit: 0, // Calculated by execution engine
    gasEstimate: String(config.gasEstimate ?? 150000),
    confidence: config.confidence ?? 0.8,
    timestamp: Date.now(),
    expiresAt: Date.now() + (config.expiryMs ?? 5000),
    blockNumber: pair1.blockNumber,
    status: 'pending'
  };
}

// =============================================================================
// Cross-Chain Arbitrage Calculator
// =============================================================================

/**
 * Cross-chain arbitrage opportunity result.
 */
export interface CrossChainOpportunityResult {
  token: string;
  sourceChain: string;
  sourceDex: string;
  sourcePrice: number;
  targetChain: string;
  targetDex: string;
  targetPrice: number;
  priceDiff: number;
  percentageDiff: number;
  estimatedProfit: number;
  bridgeCost: number;
  netProfit: number;
  confidence: number;
}

/**
 * Calculate cross-chain arbitrage opportunity.
 * Used by cross-chain-detector/detector.ts.
 *
 * @param chainPrices Array of price data from different chains
 * @param bridgeCost Estimated bridge cost in USD
 * @returns CrossChainOpportunityResult or null if not profitable
 */
export function calculateCrossChainArbitrage(
  chainPrices: ChainPriceData[],
  bridgeCost: number
): CrossChainOpportunityResult | null {
  if (chainPrices.length < 2) {
    return null;
  }

  // Sort by price to find best buy/sell
  const sortedPrices = [...chainPrices].sort((a, b) => a.price - b.price);

  const lowestPrice = sortedPrices[0];
  const highestPrice = sortedPrices[sortedPrices.length - 1];

  const priceDiff = highestPrice.price - lowestPrice.price;
  const percentageDiff = calculatePriceDifferencePercent(lowestPrice.price, highestPrice.price) * 100;

  // Calculate net profit after bridge cost
  const netProfit = priceDiff - bridgeCost;

  // Check if profitable
  if (netProfit <= ARBITRAGE_CONFIG.minProfitPercentage * lowestPrice.price) {
    return null;
  }

  // Calculate confidence based on price difference and data freshness
  const confidence = calculateCrossChainConfidence(lowestPrice, highestPrice);

  return {
    token: lowestPrice.pairKey || 'UNKNOWN',
    sourceChain: lowestPrice.chain,
    sourceDex: lowestPrice.dex,
    sourcePrice: lowestPrice.price,
    targetChain: highestPrice.chain,
    targetDex: highestPrice.dex,
    targetPrice: highestPrice.price,
    priceDiff,
    percentageDiff,
    estimatedProfit: priceDiff,
    bridgeCost,
    netProfit,
    confidence
  };
}

/**
 * Calculate confidence for cross-chain opportunity.
 */
function calculateCrossChainConfidence(
  lowPrice: ChainPriceData,
  highPrice: ChainPriceData
): number {
  // Base confidence on price difference
  let confidence = Math.min(highPrice.price / lowPrice.price - 1, 0.5) * 2;

  // Reduce confidence for stale data (1 minute = 1.0 penalty)
  const agePenalty = Math.max(0, (Date.now() - lowPrice.timestamp) / 60000);
  confidence *= Math.max(0.1, 1 - agePenalty * 0.1);

  // Cap at 95%
  return Math.min(confidence, 0.95);
}

// =============================================================================
// Core Price Comparison Logic
// =============================================================================

interface PriceSource {
  price: number;
  fee?: number;
  source: string;
}

interface ComparisonResult extends PriceComparisonResult {
  isProfitable: boolean;
}

/**
 * Core price comparison logic used by both intra-chain and cross-chain calculators.
 */
function comparePrices(
  source1: PriceSource,
  source2: PriceSource,
  chainId: string
): ComparisonResult {
  const price1 = source1.price;
  const price2 = source2.price;

  // Calculate price difference
  const priceDiff = calculatePriceDifferencePercent(price1, price2);

  // Calculate total fees (use ?? to handle fee: 0)
  const fee1 = source1.fee ?? getDefaultFee(source1.source);
  const fee2 = source2.fee ?? getDefaultFee(source2.source);
  const totalFees = fee1 + fee2;

  // Net profit after fees
  const netProfitPct = priceDiff - totalFees;

  // Check against threshold
  const minProfitThreshold = getMinProfitThreshold(chainId);
  const isProfitable = netProfitPct >= minProfitThreshold;

  // Determine buy/sell
  const isBuyFrom1 = price1 < price2;

  return {
    priceDiff,
    percentageDiff: priceDiff * 100,
    totalFees,
    netProfitPct,
    buyPrice: Math.min(price1, price2),
    sellPrice: Math.max(price1, price2),
    buySource: isBuyFrom1 ? source1.source : source2.source,
    sellSource: isBuyFrom1 ? source2.source : source1.source,
    isProfitable
  };
}

// =============================================================================
// Validation Utilities
// =============================================================================

/**
 * Validate a PairSnapshot has all required fields.
 */
export function validatePairSnapshot(pair: Partial<PairSnapshot> | null | undefined): pair is PairSnapshot {
  if (!pair || typeof pair !== 'object') {
    return false;
  }

  if (typeof pair.address !== 'string' || !pair.address) return false;
  if (typeof pair.dex !== 'string' || !pair.dex) return false;
  if (typeof pair.token0 !== 'string' || !pair.token0) return false;
  if (typeof pair.token1 !== 'string' || !pair.token1) return false;
  if (typeof pair.reserve0 !== 'string' || !pair.reserve0 || pair.reserve0 === '0') return false;
  if (typeof pair.reserve1 !== 'string' || !pair.reserve1 || pair.reserve1 === '0') return false;
  if (typeof pair.fee !== 'number' || isNaN(pair.fee) || pair.fee < 0) return false;
  if (typeof pair.blockNumber !== 'number' || pair.blockNumber < 0) return false;

  return true;
}

/**
 * Create a valid PairSnapshot from an extended pair object.
 * Returns null if the pair doesn't have valid reserves.
 */
export function createPairSnapshot(
  pair: {
    address: string;
    dex: string;
    token0: string;
    token1: string;
    reserve0?: string;
    reserve1?: string;
    fee?: number;
    blockNumber?: number;
  }
): PairSnapshot | null {
  if (!pair.reserve0 || !pair.reserve1 || pair.reserve0 === '0' || pair.reserve1 === '0') {
    return null;
  }

  return {
    address: pair.address,
    dex: pair.dex,
    token0: pair.token0,
    token1: pair.token1,
    reserve0: pair.reserve0,
    reserve1: pair.reserve1,
    fee: pair.fee ?? 0.003,
    blockNumber: pair.blockNumber ?? 0
  };
}
