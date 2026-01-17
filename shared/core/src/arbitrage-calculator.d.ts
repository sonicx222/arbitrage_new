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
import type { ArbitrageOpportunity } from '../../types/src';
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
export declare function safeBigIntDivision(numerator: bigint, denominator: bigint): number;
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
export declare function calculatePriceFromReserves(reserve0: string, reserve1: string): number | null;
/**
 * Calculate price from BigInt reserves directly (avoids string parsing overhead).
 * P0-1 FIX: Optimized version for when reserves are already BigInt.
 */
export declare function calculatePriceFromBigIntReserves(reserve0: bigint, reserve1: bigint): number | null;
/**
 * Invert price for reverse token order comparison.
 */
export declare function invertPrice(price: number): number;
/**
 * Calculate price difference as percentage of lower price.
 */
export declare function calculatePriceDifferencePercent(price1: number, price2: number): number;
/**
 * Check if two pairs represent the same token pair (in either order).
 * Uses case-insensitive comparison for addresses.
 */
export declare function isSameTokenPair(pair1: PairSnapshot, pair2: PairSnapshot): boolean;
/**
 * Check if token order is reversed between two pairs.
 */
export declare function isReverseOrder(pair1: PairSnapshot, pair2: PairSnapshot): boolean;
/**
 * Get minimum profit threshold for a specific chain from config.
 * Uses ARBITRAGE_CONFIG.chainMinProfits with fallback to default.
 */
export declare function getMinProfitThreshold(chainId: string): number;
/**
 * Get default fee for a DEX if not specified.
 * Most DEXes use 0.3% (0.003) as default.
 */
export declare function getDefaultFee(dex?: string): number;
/**
 * Calculate intra-chain arbitrage opportunity between two pairs.
 * Used by unified-detector/chain-instance.ts.
 *
 * @param pair1 First trading pair snapshot
 * @param pair2 Second trading pair snapshot
 * @param config Calculation configuration
 * @returns ArbitrageOpportunity or null if not profitable
 */
export declare function calculateIntraChainArbitrage(pair1: PairSnapshot, pair2: PairSnapshot, config: ArbitrageCalcConfig): ArbitrageOpportunity | null;
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
export declare function calculateCrossChainArbitrage(chainPrices: ChainPriceData[], bridgeCost: number): CrossChainOpportunityResult | null;
/**
 * Validate a PairSnapshot has all required fields.
 */
export declare function validatePairSnapshot(pair: Partial<PairSnapshot> | null | undefined): pair is PairSnapshot;
/**
 * Create a valid PairSnapshot from an extended pair object.
 * Returns null if the pair doesn't have valid reserves.
 */
export declare function createPairSnapshot(pair: {
    address: string;
    dex: string;
    token0: string;
    token1: string;
    reserve0?: string;
    reserve1?: string;
    fee?: number;
    blockNumber?: number;
}): PairSnapshot | null;
//# sourceMappingURL=arbitrage-calculator.d.ts.map