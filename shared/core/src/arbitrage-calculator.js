"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeBigIntDivision = safeBigIntDivision;
exports.calculatePriceFromReserves = calculatePriceFromReserves;
exports.calculatePriceFromBigIntReserves = calculatePriceFromBigIntReserves;
exports.invertPrice = invertPrice;
exports.calculatePriceDifferencePercent = calculatePriceDifferencePercent;
exports.isSameTokenPair = isSameTokenPair;
exports.isReverseOrder = isReverseOrder;
exports.getMinProfitThreshold = getMinProfitThreshold;
exports.getDefaultFee = getDefaultFee;
exports.calculateIntraChainArbitrage = calculateIntraChainArbitrage;
exports.calculateCrossChainArbitrage = calculateCrossChainArbitrage;
exports.validatePairSnapshot = validatePairSnapshot;
exports.createPairSnapshot = createPairSnapshot;
const src_1 = require("../../config/src");
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
function safeBigIntDivision(numerator, denominator) {
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
function calculatePriceFromReserves(reserve0, reserve1) {
    try {
        const r0 = BigInt(reserve0);
        const r1 = BigInt(reserve1);
        if (r0 === 0n || r1 === 0n) {
            return null;
        }
        return safeBigIntDivision(r0, r1);
    }
    catch {
        // Handle invalid BigInt strings gracefully
        return null;
    }
}
/**
 * Calculate price from BigInt reserves directly (avoids string parsing overhead).
 * P0-1 FIX: Optimized version for when reserves are already BigInt.
 */
function calculatePriceFromBigIntReserves(reserve0, reserve1) {
    if (reserve0 === 0n || reserve1 === 0n) {
        return null;
    }
    return safeBigIntDivision(reserve0, reserve1);
}
/**
 * Invert price for reverse token order comparison.
 */
function invertPrice(price) {
    if (price === 0)
        return 0;
    return 1 / price;
}
/**
 * Calculate price difference as percentage of lower price.
 */
function calculatePriceDifferencePercent(price1, price2) {
    const minPrice = Math.min(price1, price2);
    if (minPrice === 0)
        return 0;
    return Math.abs(price1 - price2) / minPrice;
}
// =============================================================================
// Token Pair Utilities
// =============================================================================
/**
 * Check if two pairs represent the same token pair (in either order).
 * Uses case-insensitive comparison for addresses.
 */
function isSameTokenPair(pair1, pair2) {
    const token1_0 = pair1.token0.toLowerCase();
    const token1_1 = pair1.token1.toLowerCase();
    const token2_0 = pair2.token0.toLowerCase();
    const token2_1 = pair2.token1.toLowerCase();
    return ((token1_0 === token2_0 && token1_1 === token2_1) ||
        (token1_0 === token2_1 && token1_1 === token2_0));
}
/**
 * Check if token order is reversed between two pairs.
 */
function isReverseOrder(pair1, pair2) {
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
function getMinProfitThreshold(chainId) {
    const chainMinProfits = src_1.ARBITRAGE_CONFIG.chainMinProfits;
    // Use ?? instead of || to correctly handle 0 min profit
    return chainMinProfits[chainId] ?? 0.003; // Default 0.3%
}
/**
 * Get default fee for a DEX if not specified.
 * Most DEXes use 0.3% (0.003) as default.
 */
function getDefaultFee(dex) {
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
function calculateIntraChainArbitrage(pair1, pair2, config) {
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
    const comparison = comparePrices({ price: price1, fee: pair1.fee, source: pair1.dex }, { price: price2, fee: pair2.fee, source: pair2.dex }, config.chainId);
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
/**
 * Calculate cross-chain arbitrage opportunity.
 * Used by cross-chain-detector/detector.ts.
 *
 * @param chainPrices Array of price data from different chains
 * @param bridgeCost Estimated bridge cost in USD
 * @returns CrossChainOpportunityResult or null if not profitable
 */
function calculateCrossChainArbitrage(chainPrices, bridgeCost) {
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
    if (netProfit <= src_1.ARBITRAGE_CONFIG.minProfitPercentage * lowestPrice.price) {
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
 * Phase 3: Uses consistent freshness scoring across all detectors.
 */
function calculateCrossChainConfidence(lowPrice, highPrice) {
    // Base confidence on price difference
    let confidence = Math.min(highPrice.price / lowPrice.price - 1, 0.5) * 2;
    // Phase 3: Freshness scoring - maxAgeMs = 10000 (10 seconds)
    // Formula: freshnessScore = max(0.5, 1.0 - (ageMs / maxAgeMs))
    const maxAgeMs = 10000;
    const ageMs = Date.now() - lowPrice.timestamp;
    const freshnessScore = Math.max(0.5, 1.0 - (ageMs / maxAgeMs));
    confidence *= freshnessScore;
    // Cap at 95%
    return Math.min(confidence, 0.95);
}
/**
 * Core price comparison logic used by both intra-chain and cross-chain calculators.
 */
function comparePrices(source1, source2, chainId) {
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
function validatePairSnapshot(pair) {
    if (!pair || typeof pair !== 'object') {
        return false;
    }
    if (typeof pair.address !== 'string' || !pair.address)
        return false;
    if (typeof pair.dex !== 'string' || !pair.dex)
        return false;
    if (typeof pair.token0 !== 'string' || !pair.token0)
        return false;
    if (typeof pair.token1 !== 'string' || !pair.token1)
        return false;
    if (typeof pair.reserve0 !== 'string' || !pair.reserve0 || pair.reserve0 === '0')
        return false;
    if (typeof pair.reserve1 !== 'string' || !pair.reserve1 || pair.reserve1 === '0')
        return false;
    if (typeof pair.fee !== 'number' || isNaN(pair.fee) || pair.fee < 0)
        return false;
    if (typeof pair.blockNumber !== 'number' || pair.blockNumber < 0)
        return false;
    return true;
}
/**
 * Create a valid PairSnapshot from an extended pair object.
 * Returns null if the pair doesn't have valid reserves.
 */
function createPairSnapshot(pair) {
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
//# sourceMappingURL=arbitrage-calculator.js.map