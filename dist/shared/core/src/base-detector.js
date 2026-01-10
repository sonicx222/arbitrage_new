"use strict";
// Base Detector Class
// Provides common functionality for all blockchain detectors
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseDetector = void 0;
const ethers_1 = require("ethers");
const index_1 = require("./index");
const src_1 = require("../../config/src");
class BaseDetector {
    constructor(config) {
        this.wsProvider = null;
        this.redis = (0, index_1.getRedisClient)();
        this.pairs = new Map();
        this.monitoredPairs = new Set();
        this.isRunning = false;
        this.config = config;
        this.chain = config.chain;
        this.logger = (0, index_1.createLogger)(`${this.chain}-detector`);
        this.perfLogger = (0, index_1.getPerformanceLogger)(`${this.chain}-detector`);
        // Initialize chain-specific data
        this.dexes = src_1.DEXES[this.chain] || [];
        this.tokens = src_1.CORE_TOKENS[this.chain] || [];
        // Initialize provider
        const chainConfig = src_1.CHAINS[this.chain];
        if (!chainConfig) {
            throw new Error(`Unsupported chain: ${this.chain}`);
        }
        this.provider = new ethers_1.ethers.JsonRpcProvider(config.rpcUrl || chainConfig.rpcUrl);
        this.logger.info(`Initialized ${this.chain} detector`, {
            dexes: this.dexes.length,
            tokens: this.tokens.length,
            rpcUrl: config.rpcUrl || chainConfig.rpcUrl,
            wsUrl: config.wsUrl || chainConfig.wsUrl
        });
    }
    // Common functionality
    async initializePairs() {
        this.logger.info(`Initializing ${this.chain} trading pairs`);
        const pairsProcessed = new Set();
        for (const dex of this.dexes) {
            if (!dex.enabled)
                continue;
            for (let i = 0; i < this.tokens.length; i++) {
                for (let j = i + 1; j < this.tokens.length; j++) {
                    const token0 = this.tokens[i];
                    const token1 = this.tokens[j];
                    // Skip if pair already processed
                    const pairKey = `${token0.symbol}_${token1.symbol}`;
                    if (pairsProcessed.has(pairKey))
                        continue;
                    try {
                        const pairAddress = await this.getPairAddress(dex, token0, token1);
                        if (pairAddress && pairAddress !== ethers_1.ethers.ZeroAddress) {
                            const pair = {
                                name: `${token0.symbol}/${token1.symbol}`,
                                address: pairAddress,
                                token0: token0.address,
                                token1: token1.address,
                                dex: dex.name,
                                fee: dex.fee || 0.003 // Default 0.3% fee
                            };
                            const pairKey = `${dex.name}_${pair.name}`;
                            this.pairs.set(pairKey, pair);
                            this.monitoredPairs.add(pairKey);
                            pairsProcessed.add(pairKey);
                            this.logger.debug(`Added pair: ${pair.name} on ${dex.name}`, {
                                address: pairAddress,
                                pairKey
                            });
                        }
                    }
                    catch (error) {
                        this.logger.warn(`Failed to get pair address for ${token0.symbol}/${token1.symbol} on ${dex.name}`, {
                            error: error.message
                        });
                    }
                }
            }
        }
        this.logger.info(`Initialized ${this.pairs.size} trading pairs for ${this.chain}`);
    }
    async getPairAddress(dex, token0, token1) {
        try {
            // This is a placeholder - actual implementation depends on DEX factory contract
            // Each DEX has different factory contracts and methods
            if (dex.name === 'uniswap_v3' || dex.name === 'pancakeswap') {
                // Mock implementation - replace with actual contract calls
                return `0x${Math.random().toString(16).substr(2, 40)}`; // Mock address
            }
            return null;
        }
        catch (error) {
            this.logger.error(`Error getting pair address for ${dex.name}`, { error });
            return null;
        }
    }
    async publishPriceUpdate(update) {
        try {
            await this.redis.publish('price-update', update);
            this.logger.debug(`Published price update: ${update.pair} on ${update.dex}`);
        }
        catch (error) {
            this.logger.error('Failed to publish price update', { error, update });
        }
    }
    async publishArbitrageOpportunity(opportunity) {
        try {
            await this.redis.publish('arbitrage-opportunity', opportunity);
            this.logger.info(`Published arbitrage opportunity: ${opportunity.id}`, {
                profit: opportunity.estimatedProfit,
                confidence: opportunity.confidence
            });
        }
        catch (error) {
            this.logger.error('Failed to publish arbitrage opportunity', { error, opportunity });
        }
    }
    async publishSwapEvent(swapEvent) {
        try {
            await this.redis.publish('swap-event', swapEvent);
            this.logger.debug(`Published swap event: ${swapEvent.pair} on ${swapEvent.dex}`);
        }
        catch (error) {
            this.logger.error('Failed to publish swap event', { error, swapEvent });
        }
    }
    calculateArbitrageOpportunity(sourceUpdate, targetUpdate) {
        try {
            // Basic arbitrage calculation
            const priceDiff = Math.abs(sourceUpdate.price0 - targetUpdate.price0);
            const avgPrice = (sourceUpdate.price0 + targetUpdate.price0) / 2;
            const percentageDiff = (priceDiff / avgPrice) * 100;
            // Apply fees and slippage
            const totalFees = src_1.ARBITRAGE_CONFIG.feePercentage * 2; // Round trip
            const netPercentage = percentageDiff - totalFees;
            if (netPercentage < src_1.ARBITRAGE_CONFIG.minProfitPercentage) {
                return null;
            }
            // Calculate confidence based on data freshness and volume
            const agePenalty = Math.max(0, (Date.now() - sourceUpdate.timestamp) / 60000); // 1 minute penalty
            const confidence = Math.max(0.1, Math.min(1.0, 1.0 - (agePenalty * 0.1)));
            const opportunity = {
                id: `arb_${this.chain}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
                sourceChain: this.chain,
                targetChain: this.chain, // Same chain for now
                sourceDex: sourceUpdate.dex,
                targetDex: targetUpdate.dex,
                tokenAddress: sourceUpdate.token0,
                amount: src_1.ARBITRAGE_CONFIG.defaultAmount,
                priceDifference: priceDiff,
                percentageDifference: percentageDiff,
                estimatedProfit: (src_1.ARBITRAGE_CONFIG.defaultAmount * netPercentage) / 100,
                gasCost: src_1.ARBITRAGE_CONFIG.estimatedGasCost,
                netProfit: ((src_1.ARBITRAGE_CONFIG.defaultAmount * netPercentage) / 100) - src_1.ARBITRAGE_CONFIG.estimatedGasCost,
                confidence,
                timestamp: Date.now(),
                expiresAt: Date.now() + src_1.ARBITRAGE_CONFIG.opportunityTimeoutMs
            };
            return opportunity;
        }
        catch (error) {
            this.logger.error('Error calculating arbitrage opportunity', { error });
            return null;
        }
    }
    validateOpportunity(opportunity) {
        // Validate opportunity meets minimum requirements
        if (opportunity.netProfit < src_1.ARBITRAGE_CONFIG.minProfitThreshold) {
            return false;
        }
        if (opportunity.confidence < src_1.ARBITRAGE_CONFIG.minConfidenceThreshold) {
            return false;
        }
        if (opportunity.expiresAt < Date.now()) {
            return false;
        }
        return true;
    }
    getStats() {
        return {
            chain: this.chain,
            pairs: this.pairs.size,
            monitoredPairs: this.monitoredPairs.size,
            dexes: this.dexes.filter(d => d.enabled).length,
            tokens: this.tokens.length,
            isRunning: this.isRunning,
            config: this.config
        };
    }
    // Utility methods
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    formatError(error) {
        if (error instanceof Error) {
            return error.message;
        }
        return String(error);
    }
    isValidAddress(address) {
        return ethers_1.ethers.isAddress(address);
    }
    normalizeAddress(address) {
        return ethers_1.ethers.getAddress(address);
    }
}
exports.BaseDetector = BaseDetector;
//# sourceMappingURL=base-detector.js.map