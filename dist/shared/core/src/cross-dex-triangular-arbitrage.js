"use strict";
// Cross-DEX Triangular Arbitrage Engine
// Finds arbitrage opportunities across multiple DEXes on the same blockchain
// P0-FIX: Uses BigInt for precise wei calculations to prevent precision loss
Object.defineProperty(exports, "__esModule", { value: true });
exports.CrossDexTriangularArbitrage = void 0;
const logger_1 = require("./logger");
const hierarchical_cache_1 = require("./hierarchical-cache");
const logger = (0, logger_1.createLogger)('cross-dex-triangular-arbitrage');
// P0-FIX: Constants for BigInt calculations
const PRECISION_MULTIPLIER = 10n ** 18n; // 18 decimal places for wei precision
const BASIS_POINTS_DIVISOR = 10000n;
const ONE_ETH_WEI = 10n ** 18n; // 1 ETH in wei
class CrossDexTriangularArbitrage {
    constructor(options) {
        this.cache = (0, hierarchical_cache_1.getHierarchicalCache)();
        this.minProfitThreshold = 0.005; // 0.5% minimum profit
        this.maxSlippage = 0.02; // 2% maximum slippage
        this.maxExecutionTime = 5000; // 5 seconds max execution time
        if (options) {
            this.minProfitThreshold = options.minProfitThreshold || this.minProfitThreshold;
            this.maxSlippage = options.maxSlippage || this.maxSlippage;
            this.maxExecutionTime = options.maxExecutionTime || this.maxExecutionTime;
        }
    }
    // Find triangular arbitrage opportunities across DEXes
    async findTriangularOpportunities(chain, pools, baseTokens = ['USDT', 'USDC', 'WETH', 'WBTC']) {
        const startTime = Date.now();
        const opportunities = [];
        // Group pools by token pairs for efficient lookup
        const tokenPairs = this.groupPoolsByPairs(pools);
        // Find all possible triangles starting from base tokens
        for (const baseToken of baseTokens) {
            const triangles = await this.findTrianglesFromBaseToken(baseToken, tokenPairs, pools, chain);
            opportunities.push(...triangles);
        }
        // Filter and rank opportunities
        const validOpportunities = this.filterAndRankOpportunities(opportunities);
        const processingTime = Date.now() - startTime;
        logger.info(`Found ${validOpportunities.length} triangular arbitrage opportunities`, {
            chain,
            totalPools: pools.length,
            processingTime,
            profitRange: validOpportunities.length > 0 ?
                `${Math.min(...validOpportunities.map(o => o.profitPercentage)).toFixed(3)}% - ${Math.max(...validOpportunities.map(o => o.profitPercentage)).toFixed(3)}%` :
                'N/A'
        });
        return validOpportunities;
    }
    // Find triangles starting from a specific base token
    async findTrianglesFromBaseToken(baseToken, tokenPairs, allPools, chain) {
        const opportunities = [];
        // Get all tokens that can be reached from base token
        const reachableTokens = this.findReachableTokens(baseToken, tokenPairs);
        // Try all possible triangles: baseToken -> tokenA -> tokenB -> baseToken
        for (const tokenA of reachableTokens) {
            if (tokenA === baseToken)
                continue;
            for (const tokenB of reachableTokens) {
                if (tokenB === baseToken || tokenB === tokenA)
                    continue;
                // Check if we can close the triangle back to base token
                const triangle = await this.evaluateTriangle([baseToken, tokenA, tokenB, baseToken], tokenPairs, allPools, chain);
                if (triangle && triangle.netProfit > 0) {
                    opportunities.push(triangle);
                }
            }
        }
        return opportunities;
    }
    // Evaluate a potential triangular arbitrage
    async evaluateTriangle(tokens, // [start, middle1, middle2, end]
    tokenPairs, allPools, chain) {
        const [token0, token1, token2, token3] = tokens;
        if (token3 !== token0)
            return null; // Must close the triangle
        // Find best DEXes for each leg
        const leg1Pools = this.findBestPoolsForPair(tokenPairs, token0, token1);
        const leg2Pools = this.findBestPoolsForPair(tokenPairs, token1, token2);
        const leg3Pools = this.findBestPoolsForPair(tokenPairs, token2, token0);
        if (leg1Pools.length === 0 || leg2Pools.length === 0 || leg3Pools.length === 0) {
            return null;
        }
        // Try different combinations of DEXes
        const opportunities = [];
        for (const pool1 of leg1Pools.slice(0, 3)) { // Top 3 pools per leg
            for (const pool2 of leg2Pools.slice(0, 3)) {
                for (const pool3 of leg3Pools.slice(0, 3)) {
                    const opportunity = await this.simulateTriangle([token0, token1, token2, token0], [pool1, pool2, pool3], chain);
                    if (opportunity && opportunity.netProfit > 0) {
                        opportunities.push(opportunity);
                    }
                }
            }
        }
        // Return the best opportunity
        return opportunities.sort((a, b) => b.netProfit - a.netProfit)[0] || null;
    }
    // Simulate a triangular arbitrage execution
    // P0-FIX: Uses BigInt for precise wei calculations
    async simulateTriangle(tokens, pools, chain) {
        const [token0, token1, token2, token3] = tokens;
        const [pool1, pool2, pool3] = pools;
        // P0-FIX: Use BigInt for wei amounts to prevent precision loss
        // Start with 1 unit of token0 (1 ETH = 10^18 wei)
        let amountBigInt = ONE_ETH_WEI;
        const initialAmountBigInt = ONE_ETH_WEI;
        let steps = [];
        try {
            // Leg 1: token0 -> token1
            const step1 = this.simulateSwapBigInt(token0, token1, amountBigInt, pool1);
            amountBigInt = step1.amountOutBigInt;
            steps.push(step1.step);
            // Leg 2: token1 -> token2
            const step2 = this.simulateSwapBigInt(token1, token2, amountBigInt, pool2);
            amountBigInt = step2.amountOutBigInt;
            steps.push(step2.step);
            // Leg 3: token2 -> token0 (close triangle)
            const step3 = this.simulateSwapBigInt(token2, token0, amountBigInt, pool3);
            amountBigInt = step3.amountOutBigInt;
            steps.push(step3.step);
            // P0-FIX: Calculate profit using BigInt then convert to decimal
            // grossProfit = (finalAmount - initialAmount) / initialAmount
            // To avoid precision loss: multiply by PRECISION_MULTIPLIER first
            const profitBigInt = amountBigInt - initialAmountBigInt;
            const grossProfitScaled = (profitBigInt * PRECISION_MULTIPLIER) / initialAmountBigInt;
            const grossProfit = Number(grossProfitScaled) / Number(PRECISION_MULTIPLIER);
            // Estimate gas costs (simplified)
            const gasCost = this.estimateGasCost(chain, steps.length);
            // Calculate net profit after fees and gas
            const totalFees = steps.reduce((sum, step) => sum + step.fee, 0);
            const netProfit = grossProfit - totalFees - gasCost;
            if (netProfit < this.minProfitThreshold) {
                return null;
            }
            // Estimate execution time
            const executionTime = this.estimateExecutionTime(chain, steps);
            // Calculate confidence based on liquidity and slippage
            const confidence = this.calculateConfidence(steps, pools);
            const opportunity = {
                id: `tri_${chain}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                chain,
                path: [token0, token1, token2],
                dexes: [pool1.dex, pool2.dex, pool3.dex],
                profitPercentage: netProfit,
                profitUSD: netProfit * 2000, // Rough ETH to USD conversion
                gasCost,
                netProfit,
                confidence,
                steps,
                timestamp: Date.now(),
                executionTime
            };
            return opportunity;
        }
        catch (error) {
            logger.debug('Triangle simulation failed', {
                tokens,
                dexes: pools.map(p => p.dex),
                error: error.message
            });
            return null;
        }
    }
    // P0-FIX: BigInt version of swap simulation for precise calculations
    simulateSwapBigInt(fromToken, toToken, amountInBigInt, pool) {
        // Use AMM formula with BigInt: amountOut = (amountIn * reserveOut * (10000 - fee)) / (reserveIn * 10000 + amountIn * (10000 - fee))
        let reserveInStr, reserveOutStr;
        if (pool.token0 === fromToken && pool.token1 === toToken) {
            reserveInStr = pool.reserve0;
            reserveOutStr = pool.reserve1;
        }
        else if (pool.token0 === toToken && pool.token1 === fromToken) {
            reserveInStr = pool.reserve1;
            reserveOutStr = pool.reserve0;
        }
        else {
            throw new Error(`Pool does not contain token pair ${fromToken}/${toToken}`);
        }
        // P0-FIX: Parse reserves as BigInt (they're stored as strings in wei)
        const reserveInBigInt = BigInt(reserveInStr);
        const reserveOutBigInt = BigInt(reserveOutStr);
        const feeBigInt = BigInt(pool.fee);
        // P0-FIX: Apply fee using BigInt arithmetic
        // feeMultiplier = (10000 - fee) / 10000
        const feeMultiplierNumerator = BASIS_POINTS_DIVISOR - feeBigInt;
        // amountInWithFee = amountIn * (10000 - fee) / 10000
        const amountInWithFee = (amountInBigInt * feeMultiplierNumerator) / BASIS_POINTS_DIVISOR;
        // P0-FIX: Constant product formula with BigInt
        // amountOut = (amountInWithFee * reserveOut) / (reserveIn + amountInWithFee)
        const numerator = amountInWithFee * reserveOutBigInt;
        const denominator = reserveInBigInt + amountInWithFee;
        const amountOutBigInt = numerator / denominator;
        // Calculate slippage (convert to number for ratio calculation - safe as it's a small ratio)
        const reserveInNumber = Number(reserveInBigInt / (10n ** 12n)) / 1e6; // Scale down for safe number conversion
        const amountInNumber = Number(amountInBigInt / (10n ** 12n)) / 1e6;
        const priceImpact = amountInNumber / (reserveInNumber + amountInNumber);
        const slippage = Math.min(priceImpact, this.maxSlippage);
        // Convert BigInt to number for step (for display purposes only)
        const amountInDisplay = Number(amountInBigInt) / 1e18;
        const amountOutDisplay = Number(amountOutBigInt) / 1e18;
        const step = {
            fromToken,
            toToken,
            dex: pool.dex,
            amountIn: amountInDisplay,
            amountOut: amountOutDisplay,
            price: pool.price,
            fee: pool.fee / 10000, // Convert to decimal
            slippage
        };
        return { amountOutBigInt, step };
    }
    // Group pools by token pairs for efficient lookup
    groupPoolsByPairs(pools) {
        const pairs = new Map();
        for (const pool of pools) {
            const pairKey = `${pool.token0}_${pool.token1}`;
            const reverseKey = `${pool.token1}_${pool.token0}`;
            // Store both directions for easier lookup
            if (!pairs.has(pairKey))
                pairs.set(pairKey, []);
            if (!pairs.has(reverseKey))
                pairs.set(reverseKey, []);
            pairs.get(pairKey).push(pool);
            pairs.get(reverseKey).push(pool);
        }
        // Sort pools by liquidity (higher liquidity first)
        for (const poolList of pairs.values()) {
            poolList.sort((a, b) => b.liquidity - a.liquidity);
        }
        return pairs;
    }
    // Find tokens reachable from a base token
    findReachableTokens(baseToken, tokenPairs) {
        const visited = new Set();
        const queue = [baseToken];
        const reachable = new Set();
        while (queue.length > 0) {
            const currentToken = queue.shift();
            if (visited.has(currentToken))
                continue;
            visited.add(currentToken);
            reachable.add(currentToken);
            // Find all tokens directly connected to current token
            for (const [pairKey, pools] of tokenPairs) {
                const [tokenA, tokenB] = pairKey.split('_');
                if (tokenA === currentToken && !visited.has(tokenB)) {
                    queue.push(tokenB);
                }
                else if (tokenB === currentToken && !visited.has(tokenA)) {
                    queue.push(tokenA);
                }
            }
        }
        return Array.from(reachable);
    }
    // Find best pools for a token pair
    findBestPoolsForPair(tokenPairs, tokenA, tokenB) {
        const pairKey = `${tokenA}_${tokenB}`;
        return tokenPairs.get(pairKey) || [];
    }
    // Filter and rank opportunities
    filterAndRankOpportunities(opportunities) {
        return opportunities
            .filter(opp => {
            // Filter by minimum profit
            if (opp.netProfit < this.minProfitThreshold)
                return false;
            // Filter by maximum slippage
            const maxStepSlippage = Math.max(...opp.steps.map(s => s.slippage));
            if (maxStepSlippage > this.maxSlippage)
                return false;
            // Filter by execution time
            if (opp.executionTime > this.maxExecutionTime)
                return false;
            // Filter by confidence
            if (opp.confidence < 0.6)
                return false; // Minimum 60% confidence
            return true;
        })
            .sort((a, b) => {
            // Rank by net profit, then by confidence, then by execution time
            if (Math.abs(a.netProfit - b.netProfit) > 0.001) {
                return b.netProfit - a.netProfit;
            }
            if (Math.abs(a.confidence - b.confidence) > 0.1) {
                return b.confidence - a.confidence;
            }
            return a.executionTime - b.executionTime;
        })
            .slice(0, 10); // Return top 10 opportunities
    }
    // Estimate gas cost for triangular arbitrage
    estimateGasCost(chain, steps) {
        // Base gas costs for different chains (in ETH)
        const baseGasCosts = {
            ethereum: 0.005, // ~$10 at $2000/ETH
            bsc: 0.0001, // ~$0.02 at $200/BNB
            arbitrum: 0.00005, // Very low L2 fees
            base: 0.00001, // Coinbase L2
            polygon: 0.0001 // Polygon fees
        };
        const baseCost = baseGasCosts[chain] || 0.001;
        // Each step adds complexity
        return baseCost * (1 + steps * 0.2);
    }
    // Estimate execution time
    estimateExecutionTime(chain, steps) {
        // Base execution times for different chains (in ms)
        const baseExecutionTimes = {
            ethereum: 15000, // 15 seconds average
            bsc: 3000, // 3 seconds
            arbitrum: 1000, // 1 second (fast L2)
            base: 2000, // 2 seconds
            polygon: 2000 // 2 seconds
        };
        const baseTime = baseExecutionTimes[chain] || 5000;
        // Add time for each step and account for sequential execution
        const stepTime = 500; // 500ms per swap
        return baseTime + (steps.length * stepTime);
    }
    // Calculate confidence score
    calculateConfidence(steps, pools) {
        let totalConfidence = 0;
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            const pool = pools[i];
            // Liquidity confidence (higher liquidity = higher confidence)
            const liquidityConfidence = Math.min(1, pool.liquidity / 1000000); // $1M liquidity = 100% confidence
            // Slippage confidence (lower slippage = higher confidence)
            const slippageConfidence = Math.max(0, 1 - step.slippage / this.maxSlippage);
            // Fee confidence (lower fees = higher confidence)
            const feeConfidence = Math.max(0, 1 - pool.fee / 100); // 1% fee = 0 confidence
            const stepConfidence = (liquidityConfidence + slippageConfidence + feeConfidence) / 3;
            totalConfidence += stepConfidence;
        }
        return totalConfidence / steps.length;
    }
    // Get arbitrage statistics
    getStatistics() {
        return {
            minProfitThreshold: this.minProfitThreshold,
            maxSlippage: this.maxSlippage,
            maxExecutionTime: this.maxExecutionTime,
            supportedChains: ['ethereum', 'bsc', 'arbitrum', 'base', 'polygon']
        };
    }
    // Update configuration
    updateConfig(config) {
        if (config.minProfitThreshold !== undefined) {
            this.minProfitThreshold = config.minProfitThreshold;
        }
        if (config.maxSlippage !== undefined) {
            this.maxSlippage = config.maxSlippage;
        }
        if (config.maxExecutionTime !== undefined) {
            this.maxExecutionTime = config.maxExecutionTime;
        }
        logger.info('Cross-DEX triangular arbitrage config updated', config);
    }
}
exports.CrossDexTriangularArbitrage = CrossDexTriangularArbitrage;
//# sourceMappingURL=cross-dex-triangular-arbitrage.js.map