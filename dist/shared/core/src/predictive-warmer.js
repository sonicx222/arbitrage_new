"use strict";
// Predictive Cache Warmer
// Intelligent pre-loading of price data based on correlation analysis
Object.defineProperty(exports, "__esModule", { value: true });
exports.PredictiveCacheWarmer = void 0;
exports.getPredictiveCacheWarmer = getPredictiveCacheWarmer;
const matrix_cache_1 = require("./matrix-cache");
const logger_1 = require("./logger");
const logger = (0, logger_1.createLogger)('predictive-warmer');
class PredictiveCacheWarmer {
    constructor(cache) {
        this.correlationGraph = {};
        this.warmupQueue = [];
        this.accessHistory = new Map(); // pairKey -> timestamps
        this.correlationCache = new Map();
        this.cache = cache || (0, matrix_cache_1.getMatrixPriceCache)();
    }
    // Called when a price update occurs
    async onPriceUpdate(pairKey, dexName) {
        // Record access
        this.recordAccess(pairKey);
        // Get correlated pairs
        const correlated = this.getCorrelatedPairs(pairKey, {
            minScore: 0.6,
            limit: 10,
            includeHistorical: true
        });
        // Queue for warming
        for (const corr of correlated) {
            this.warmupQueue.push({
                pairKey: corr.pairKey,
                priority: corr.score * 100,
                expectedAccessTime: Date.now() + 100, // Predict access within 100ms
                reason: `correlated_with_${pairKey}`
            });
        }
        // Process warmup queue
        await this.processWarmupQueue();
    }
    // Called when an arbitrage opportunity is detected
    async onArbitrageDetected(opportunity) {
        // Extract pairs involved in the opportunity
        const pairs = this.extractPairsFromOpportunity(opportunity);
        for (const pairKey of pairs) {
            // High priority warmup for opportunity pairs
            this.warmupQueue.unshift({
                pairKey,
                priority: 1000, // Highest priority
                expectedAccessTime: Date.now() + 10, // Immediate access expected
                reason: 'arbitrage_opportunity'
            });
        }
        await this.processWarmupQueue();
    }
    // Called during periodic maintenance
    async warmupBasedOnPatterns() {
        // Analyze access patterns and warm up frequently accessed pairs
        const hotPairs = this.identifyHotPairs();
        for (const pairKey of hotPairs) {
            this.warmupQueue.push({
                pairKey,
                priority: 200,
                expectedAccessTime: Date.now() + 1000, // Expect access within 1 second
                reason: 'access_pattern'
            });
        }
        await this.processWarmupQueue();
    }
    async processWarmupQueue() {
        const toWarm = [];
        const now = Date.now();
        // Collect items ready for warming (up to 5 at a time)
        while (toWarm.length < 5 && this.warmupQueue.length > 0) {
            const item = this.warmupQueue[0];
            if (now >= item.expectedAccessTime - 10) { // 10ms lead time
                const dequeued = this.warmupQueue.shift();
                if (dequeued) {
                    toWarm.push({
                        pairKey: dequeued.pairKey,
                        reason: dequeued.reason
                    });
                }
            }
            else {
                break; // Queue is sorted by priority, remaining items not ready
            }
        }
        if (toWarm.length > 0) {
            await this.batchWarmPrices(toWarm);
        }
    }
    async batchWarmPrices(items) {
        // In a real implementation, this would load data from Redis
        // For now, we just log the warmup actions
        for (const item of items) {
            logger.debug(`Cache warmup: ${item.pairKey} (reason: ${item.reason})`);
            // Simulate loading correlated data
            // In production: await this.loadPriceDataFromRedis(item.pairKey);
        }
    }
    recordAccess(pairKey) {
        const now = Date.now();
        if (!this.accessHistory.has(pairKey)) {
            this.accessHistory.set(pairKey, []);
        }
        const history = this.accessHistory.get(pairKey);
        history.push(now);
        // Keep only last 100 accesses to prevent memory bloat
        if (history.length > 100) {
            history.shift();
        }
    }
    getCorrelatedPairs(pairKey, options = {}) {
        const { minScore = 0.5, limit = 5, includeHistorical = true } = options;
        // Check cache first
        const cached = this.correlationCache.get(pairKey);
        if (cached) {
            return cached.filter(c => c.score >= minScore).slice(0, limit);
        }
        // Calculate correlations
        const correlated = [];
        // Simple correlation calculation based on co-access patterns
        for (const [otherPairKey, history] of this.accessHistory) {
            if (otherPairKey === pairKey)
                continue;
            const correlation = this.calculateCorrelation(pairKey, otherPairKey);
            if (correlation >= minScore) {
                correlated.push({
                    pairKey: otherPairKey,
                    score: correlation,
                    strength: correlation > 0.8 ? 'strong' : correlation > 0.6 ? 'medium' : 'weak'
                });
            }
        }
        // Sort by correlation score (highest first)
        correlated.sort((a, b) => b.score - a.score);
        // Cache result
        this.correlationCache.set(pairKey, correlated);
        return correlated.slice(0, limit);
    }
    calculateCorrelation(pairKey1, pairKey2) {
        const history1 = this.accessHistory.get(pairKey1) || [];
        const history2 = this.accessHistory.get(pairKey2) || [];
        if (history1.length === 0 || history2.length === 0) {
            return 0;
        }
        // Simple co-occurrence correlation
        // In production, this would use more sophisticated correlation analysis
        const coOccurrences = this.countCoOccurrences(history1, history2);
        const totalPossible = Math.min(history1.length, history2.length);
        return coOccurrences / totalPossible;
    }
    countCoOccurrences(history1, history2) {
        let count = 0;
        const timeWindow = 5000; // 5 second window
        for (const time1 of history1) {
            for (const time2 of history2) {
                if (Math.abs(time1 - time2) <= timeWindow) {
                    count++;
                    break; // Count each time1 only once
                }
            }
        }
        return count;
    }
    identifyHotPairs() {
        const now = Date.now();
        const oneMinuteAgo = now - 60000;
        const fiveMinutesAgo = now - 300000;
        const hotPairs = [];
        for (const [pairKey, history] of this.accessHistory) {
            const recentAccesses = history.filter(time => time >= oneMinuteAgo).length;
            const olderAccesses = history.filter(time => time >= fiveMinutesAgo && time < oneMinuteAgo).length;
            if (recentAccesses > 0) {
                hotPairs.push({
                    pairKey,
                    recentAccesses,
                    olderAccesses
                });
            }
        }
        // Sort by recent activity
        hotPairs.sort((a, b) => b.recentAccesses - a.recentAccesses);
        return hotPairs.slice(0, 10).map(p => p.pairKey);
    }
    extractPairsFromOpportunity(opportunity) {
        const pairs = [];
        // Extract pair keys from opportunity
        if (opportunity.pairKey) {
            pairs.push(opportunity.pairKey);
        }
        // For cross-chain opportunities, extract multiple pairs
        if (opportunity.type === 'cross-chain') {
            // Extract pairs from cross-chain opportunity
            // This would depend on the opportunity structure
        }
        return [...new Set(pairs)]; // Remove duplicates
    }
    // Public API for correlation analysis
    getCorrelationGraph() {
        return { ...this.correlationGraph };
    }
    getAccessStats() {
        const stats = {};
        for (const [pairKey, history] of this.accessHistory) {
            stats[pairKey] = {
                accessCount: history.length,
                lastAccess: history[history.length - 1] || 0
            };
        }
        return stats;
    }
    getWarmupQueueStats() {
        return {
            queueLength: this.warmupQueue.length,
            processedToday: 0 // Would track daily stats in production
        };
    }
    // Maintenance methods
    clearOldHistory(maxAgeMs = 3600000) {
        const cutoff = Date.now() - maxAgeMs;
        let cleared = 0;
        for (const [pairKey, history] of this.accessHistory) {
            const newHistory = history.filter(time => time >= cutoff);
            if (newHistory.length !== history.length) {
                cleared += history.length - newHistory.length;
                if (newHistory.length === 0) {
                    this.accessHistory.delete(pairKey);
                }
                else {
                    this.accessHistory.set(pairKey, newHistory);
                }
            }
        }
        if (cleared > 0) {
            logger.debug(`Cleared ${cleared} old access history entries`);
        }
        return cleared;
    }
    updateCorrelations() {
        // Recalculate correlation cache
        this.correlationCache.clear();
        logger.debug('Updated correlation analysis');
    }
}
exports.PredictiveCacheWarmer = PredictiveCacheWarmer;
// Singleton instance
let predictiveWarmer = null;
function getPredictiveCacheWarmer() {
    if (!predictiveWarmer) {
        predictiveWarmer = new PredictiveCacheWarmer();
    }
    return predictiveWarmer;
}
//# sourceMappingURL=predictive-warmer.js.map