"use strict";
/**
 * T3.15: Liquidity Depth Analysis
 *
 * Professional-grade liquidity analysis for optimal trade execution:
 * - Order book depth tracking (simulated from AMM reserves)
 * - Slippage prediction based on trade size
 * - Multi-level price impact calculation
 * - Optimal trade size recommendation
 *
 * Note: DEX AMMs don't have traditional order books, so we simulate
 * depth levels using the constant product formula (x * y = k).
 *
 * @see docs/DETECTOR_OPTIMIZATION_ANALYSIS.md - Finding T3.15
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LiquidityDepthAnalyzer = void 0;
exports.getLiquidityDepthAnalyzer = getLiquidityDepthAnalyzer;
exports.resetLiquidityDepthAnalyzer = resetLiquidityDepthAnalyzer;
const logger_1 = require("./logger");
const logger = (0, logger_1.createLogger)('liquidity-depth-analyzer');
// BigInt precision for calculations
const PRECISION = 10n ** 18n;
// =============================================================================
// Default Configuration
// =============================================================================
const DEFAULT_CONFIG = {
    depthLevels: 10,
    tradeSizeStepUsd: 1000,
    maxTradeSizeUsd: 1000000,
    maxTrackedPools: 1000,
    cacheTtlMs: 30000
};
// =============================================================================
// Liquidity Depth Analyzer
// =============================================================================
/**
 * T3.15: Liquidity Depth Analyzer
 *
 * Analyzes AMM pool liquidity to predict slippage and optimize trade sizes.
 */
class LiquidityDepthAnalyzer {
    constructor(config = {}) {
        this.pools = new Map();
        this.depthCache = new Map();
        this.stats = {
            analysisCount: 0,
            totalAnalysisTimeMs: 0,
            cacheHits: 0,
            cacheMisses: 0,
            poolEvictions: 0
        };
        this.config = { ...DEFAULT_CONFIG, ...config };
        logger.info('LiquidityDepthAnalyzer initialized', {
            depthLevels: this.config.depthLevels,
            maxTrackedPools: this.config.maxTrackedPools,
            cacheTtlMs: this.config.cacheTtlMs
        });
    }
    /**
     * Update pool liquidity snapshot.
     * Validates pool data before storing.
     */
    updatePoolLiquidity(pool) {
        // Input validation
        if (!pool.poolAddress) {
            logger.warn('Pool update skipped: missing poolAddress');
            return;
        }
        if (pool.reserve0 < 0n || pool.reserve1 < 0n) {
            logger.warn('Pool update skipped: negative reserves', { poolAddress: pool.poolAddress });
            return;
        }
        if (pool.price <= 0 || !Number.isFinite(pool.price)) {
            logger.warn('Pool update skipped: invalid price', { poolAddress: pool.poolAddress, price: pool.price });
            return;
        }
        if (pool.liquidityUsd < 0 || !Number.isFinite(pool.liquidityUsd)) {
            logger.warn('Pool update skipped: invalid liquidityUsd', { poolAddress: pool.poolAddress });
            return;
        }
        this.evictLRUPoolsIfNeeded();
        this.pools.set(pool.poolAddress, pool);
        // Invalidate depth cache for this pool
        this.depthCache.delete(pool.poolAddress);
    }
    /**
     * Get full depth analysis for a pool.
     */
    analyzeDepth(poolAddress) {
        const startTime = performance.now();
        // Check cache
        const cached = this.depthCache.get(poolAddress);
        if (cached && Date.now() - cached.timestamp < this.config.cacheTtlMs) {
            this.stats.cacheHits++;
            return cached.analysis;
        }
        this.stats.cacheMisses++;
        const pool = this.pools.get(poolAddress);
        if (!pool) {
            return null;
        }
        this.stats.analysisCount++;
        const buyLevels = this.calculateDepthLevels(pool, 'buy');
        const sellLevels = this.calculateDepthLevels(pool, 'sell');
        // Calculate optimal trade sizes
        const optimalTradeSizeUsd = this.findOptimalTradeSize(buyLevels);
        const maxTradeSizeFor1PercentSlippage = this.findMaxTradeSizeForSlippage(buyLevels, 1.0);
        const maxTradeSizeFor5PercentSlippage = this.findMaxTradeSizeForSlippage(buyLevels, 5.0);
        // Calculate liquidity score (0-1)
        const liquidityScore = this.calculateLiquidityScore(pool, buyLevels, sellLevels);
        const analysis = {
            poolAddress,
            chain: pool.chain,
            token0: pool.token0,
            token1: pool.token1,
            buyLevels,
            sellLevels,
            optimalTradeSizeUsd,
            maxTradeSizeFor1PercentSlippage,
            maxTradeSizeFor5PercentSlippage,
            liquidityScore,
            timestamp: Date.now()
        };
        // Cache the result
        this.depthCache.set(poolAddress, { analysis, timestamp: Date.now() });
        const analysisTime = performance.now() - startTime;
        this.stats.totalAnalysisTimeMs += analysisTime;
        return analysis;
    }
    /**
     * Estimate slippage for a specific trade.
     */
    estimateSlippage(poolAddress, inputAmountUsd, direction) {
        const pool = this.pools.get(poolAddress);
        if (!pool) {
            return null;
        }
        // Convert USD to token amount
        // price = token1 price in terms of token0 (e.g., WETH price in USDT)
        const price = pool.price;
        const inputToken = direction === 'buy' ? pool.token0 : pool.token1;
        const outputToken = direction === 'buy' ? pool.token1 : pool.token0;
        // For 'buy': input is token0 (stablecoin), so inputAmount = inputAmountUsd
        // For 'sell': input is token1 (priced asset), so convert USD to token1 units
        const inputAmount = direction === 'buy'
            ? inputAmountUsd
            : inputAmountUsd / price;
        // Calculate output using constant product formula
        const reserveIn = direction === 'buy' ? pool.reserve0 : pool.reserve1;
        const reserveOut = direction === 'buy' ? pool.reserve1 : pool.reserve0;
        const result = this.calculateSwapOutput(BigInt(Math.floor(inputAmount * 1e18)), reserveIn, reserveOut, pool.feeBps);
        const outputAmount = Number(result.amountOut) / 1e18;
        const effectivePrice = outputAmount / inputAmount;
        const priceImpactPercent = result.priceImpact * 100;
        const slippagePercent = priceImpactPercent + (pool.feeBps / 100);
        // Calculate output in USD
        const outputAmountUsd = direction === 'buy'
            ? outputAmount * price
            : outputAmount;
        // Confidence decreases with larger trades and higher slippage
        const sizeConfidence = Math.max(0.3, 1 - (inputAmountUsd / pool.liquidityUsd) * 2);
        const slippageConfidence = Math.max(0.5, 1 - slippagePercent / 10);
        const confidence = (sizeConfidence + slippageConfidence) / 2;
        return {
            poolAddress,
            tradeDirection: direction,
            inputAmount,
            inputAmountUsd,
            outputAmount,
            outputAmountUsd,
            priceImpactPercent,
            slippagePercent,
            effectivePrice,
            confidence
        };
    }
    /**
     * Find the best pool for a given trade size.
     */
    findBestPool(token0, token1, tradeSizeUsd, direction) {
        let bestPool = null;
        let bestSlippage = Infinity;
        for (const [address, pool] of this.pools) {
            // Check if pool has the right tokens
            const hasTokens = (pool.token0 === token0 && pool.token1 === token1) ||
                (pool.token0 === token1 && pool.token1 === token0);
            if (!hasTokens)
                continue;
            const estimate = this.estimateSlippage(address, tradeSizeUsd, direction);
            if (estimate && estimate.slippagePercent < bestSlippage) {
                bestSlippage = estimate.slippagePercent;
                bestPool = address;
            }
        }
        if (!bestPool)
            return null;
        return { poolAddress: bestPool, slippage: bestSlippage };
    }
    /**
     * Get pool liquidity.
     */
    getPoolLiquidity(poolAddress) {
        return this.pools.get(poolAddress);
    }
    /**
     * Get all tracked pools.
     */
    getTrackedPools() {
        return Array.from(this.pools.keys());
    }
    /**
     * Get analyzer statistics.
     */
    getStats() {
        const avgAnalysisTime = this.stats.analysisCount > 0
            ? this.stats.totalAnalysisTimeMs / this.stats.analysisCount
            : 0;
        return {
            poolsTracked: this.pools.size,
            analysisCount: this.stats.analysisCount,
            avgAnalysisTimeMs: avgAnalysisTime,
            cacheHits: this.stats.cacheHits,
            cacheMisses: this.stats.cacheMisses,
            poolEvictions: this.stats.poolEvictions
        };
    }
    /**
     * Reset all data.
     */
    reset() {
        this.pools.clear();
        this.depthCache.clear();
        this.stats = {
            analysisCount: 0,
            totalAnalysisTimeMs: 0,
            cacheHits: 0,
            cacheMisses: 0,
            poolEvictions: 0
        };
    }
    // ===========================================================================
    // Private Helpers
    // ===========================================================================
    calculateDepthLevels(pool, direction) {
        const levels = [];
        const stepUsd = this.config.tradeSizeStepUsd;
        const maxUsd = Math.min(this.config.maxTradeSizeUsd, pool.liquidityUsd * 0.5);
        const numLevels = Math.min(this.config.depthLevels, Math.floor(maxUsd / stepUsd));
        const reserveIn = direction === 'buy' ? pool.reserve0 : pool.reserve1;
        const reserveOut = direction === 'buy' ? pool.reserve1 : pool.reserve0;
        const basePrice = pool.price;
        for (let i = 1; i <= numLevels; i++) {
            const tradeSizeUsd = i * stepUsd;
            const tradeSize = tradeSizeUsd / basePrice;
            const tradeSizeBigInt = BigInt(Math.floor(tradeSize * 1e18));
            const result = this.calculateSwapOutput(tradeSizeBigInt, reserveIn, reserveOut, pool.feeBps);
            const outputAmount = Number(result.amountOut) / 1e18;
            const effectiveRate = outputAmount / tradeSize;
            const expectedPrice = basePrice * (1 - result.priceImpact);
            const slippagePercent = (result.priceImpact * 100) + (pool.feeBps / 100);
            levels.push({
                tradeSize,
                tradeSizeUsd,
                expectedPrice,
                priceImpactPercent: result.priceImpact * 100,
                slippagePercent,
                outputAmount,
                effectiveRate
            });
        }
        return levels;
    }
    calculateSwapOutput(amountIn, reserveIn, reserveOut, feeBps) {
        if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) {
            return { amountOut: 0n, priceImpact: 1 };
        }
        // Apply fee
        const feeMultiplier = BigInt(10000 - feeBps);
        const amountInWithFee = (amountIn * feeMultiplier) / 10000n;
        // Constant product formula: x * y = k
        // amountOut = (reserveOut * amountInWithFee) / (reserveIn + amountInWithFee)
        const numerator = reserveOut * amountInWithFee;
        const denominator = reserveIn + amountInWithFee;
        if (denominator === 0n) {
            return { amountOut: 0n, priceImpact: 1 };
        }
        const amountOut = numerator / denominator;
        // Calculate price impact
        // Price impact = 1 - (effective_price / initial_price)
        // Initial price = reserveOut / reserveIn
        // Effective price = amountOut / amountIn
        const initialPriceScaled = (reserveOut * PRECISION) / reserveIn;
        const effectivePriceScaled = (amountOut * PRECISION) / amountIn;
        const priceImpact = initialPriceScaled > 0n
            ? Number(PRECISION - (effectivePriceScaled * PRECISION) / initialPriceScaled) / Number(PRECISION)
            : 1;
        return { amountOut, priceImpact: Math.max(0, priceImpact) };
    }
    findOptimalTradeSize(levels) {
        // Optimal trade size is where marginal slippage cost equals marginal opportunity gain
        // Simplified: find the knee of the slippage curve
        if (levels.length < 2)
            return levels[0]?.tradeSizeUsd || 0;
        for (let i = 1; i < levels.length; i++) {
            const prevSlippage = levels[i - 1].slippagePercent;
            const currSlippage = levels[i].slippagePercent;
            const slippageIncrease = currSlippage - prevSlippage;
            // If slippage is increasing faster than linear, we've passed optimal
            if (slippageIncrease > 0.5) {
                return levels[i - 1].tradeSizeUsd;
            }
        }
        // If we didn't find a knee, return the largest size with < 1% slippage
        for (let i = levels.length - 1; i >= 0; i--) {
            if (levels[i].slippagePercent < 1.0) {
                return levels[i].tradeSizeUsd;
            }
        }
        return levels[0]?.tradeSizeUsd || 0;
    }
    findMaxTradeSizeForSlippage(levels, maxSlippage) {
        for (let i = levels.length - 1; i >= 0; i--) {
            if (levels[i].slippagePercent <= maxSlippage) {
                return levels[i].tradeSizeUsd;
            }
        }
        return 0;
    }
    calculateLiquidityScore(pool, buyLevels, sellLevels) {
        let score = 0;
        // Base score from total liquidity (max 0.4)
        const liquidityScore = Math.min(0.4, pool.liquidityUsd / 10000000 * 0.4);
        score += liquidityScore;
        // Score from depth (can trade $10K with < 0.5% slippage) (max 0.3)
        const trade10K = buyLevels.find(l => l.tradeSizeUsd >= 10000);
        if (trade10K && trade10K.slippagePercent < 0.5) {
            score += 0.3;
        }
        else if (trade10K && trade10K.slippagePercent < 1.0) {
            score += 0.2;
        }
        else if (trade10K && trade10K.slippagePercent < 2.0) {
            score += 0.1;
        }
        // Score from symmetry (buy/sell depth similar) (max 0.2)
        if (buyLevels.length > 0 && sellLevels.length > 0) {
            const buyDepth = buyLevels[buyLevels.length - 1]?.tradeSizeUsd || 0;
            const sellDepth = sellLevels[sellLevels.length - 1]?.tradeSizeUsd || 0;
            const minDepth = Math.min(buyDepth, sellDepth);
            const maxDepth = Math.max(buyDepth, sellDepth);
            const symmetry = maxDepth > 0 ? minDepth / maxDepth : 0;
            score += symmetry * 0.2;
        }
        // Score from low fees (max 0.1)
        const feeScore = Math.max(0, (100 - pool.feeBps) / 100) * 0.1;
        score += feeScore;
        return Math.min(1, score);
    }
    evictLRUPoolsIfNeeded() {
        if (this.pools.size < this.config.maxTrackedPools) {
            return;
        }
        // Find and remove the oldest 10% of pools by timestamp
        const toRemove = Math.max(1, Math.floor(this.config.maxTrackedPools * 0.1));
        const poolsByAge = Array.from(this.pools.entries())
            .sort((a, b) => a[1].timestamp - b[1].timestamp);
        for (let i = 0; i < toRemove && i < poolsByAge.length; i++) {
            this.pools.delete(poolsByAge[i][0]);
            this.depthCache.delete(poolsByAge[i][0]);
            this.stats.poolEvictions++;
        }
        logger.debug('Evicted LRU pools', {
            evicted: toRemove,
            remaining: this.pools.size
        });
    }
}
exports.LiquidityDepthAnalyzer = LiquidityDepthAnalyzer;
// =============================================================================
// Singleton Factory
// =============================================================================
/**
 * Singleton Pattern Note:
 * This uses a configurable singleton pattern rather than `createSingleton` from async-singleton.ts
 * because it requires configuration parameters on first initialization. The standard createSingleton
 * pattern uses a fixed factory function which doesn't support runtime configuration.
 *
 * Thread safety: JavaScript is single-threaded for synchronous code, so this pattern
 * is safe. The check-and-set is atomic in the JS event loop.
 */
let analyzerInstance = null;
/**
 * Get the singleton LiquidityDepthAnalyzer instance.
 * Configuration is only applied on first call; subsequent calls return the existing instance.
 *
 * @param config - Optional configuration (only used on first initialization)
 * @returns The singleton LiquidityDepthAnalyzer instance
 */
function getLiquidityDepthAnalyzer(config) {
    if (!analyzerInstance) {
        analyzerInstance = new LiquidityDepthAnalyzer(config);
    }
    return analyzerInstance;
}
/**
 * Reset the singleton instance.
 * Use for testing or when reconfiguration is needed.
 */
function resetLiquidityDepthAnalyzer() {
    if (analyzerInstance) {
        analyzerInstance.reset();
    }
    analyzerInstance = null;
}
//# sourceMappingURL=liquidity-depth-analyzer.js.map