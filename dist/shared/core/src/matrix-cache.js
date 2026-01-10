"use strict";
// Matrix-Based Price Cache with Predictive Warming
// Ultra-fast price storage and retrieval for arbitrage detection
Object.defineProperty(exports, "__esModule", { value: true });
exports.MatrixPriceCache = void 0;
exports.getMatrixPriceCache = getMatrixPriceCache;
const logger_1 = require("./logger");
const logger = (0, logger_1.createLogger)('matrix-cache');
class MatrixPriceCache {
    constructor(maxPairs = 1000, maxDexes = 10, ttlSeconds = 300) {
        this.hitCount = 0;
        this.missCount = 0;
        this.warmupQueue = [];
        this.maxPairs = maxPairs;
        this.maxDexes = maxDexes;
        this.ttlSeconds = ttlSeconds;
        // Pre-allocated typed arrays for maximum performance
        this.prices = new Float64Array(maxPairs * maxDexes);
        this.timestamps = new Uint32Array(maxPairs * maxDexes);
        this.liquidity = new Float64Array(maxPairs * maxDexes);
        // Pre-computed mappings (no string operations at runtime)
        this.pairToIndex = new Map();
        this.dexToIndex = new Map();
        this.indexToPair = new Array(maxPairs);
        this.indexToDex = new Array(maxDexes);
        // Initialize with empty values
        this.prices.fill(0);
        this.timestamps.fill(0);
        this.liquidity.fill(0);
        logger.info(`MatrixPriceCache initialized: ${maxPairs} pairs x ${maxDexes} DEXes = ${maxPairs * maxDexes} slots`);
    }
    setPrice(pairKey, dexName, price, liquidity = 0) {
        const pairIndex = this.getOrCreatePairIndex(pairKey);
        const dexIndex = this.getOrCreateDexIndex(dexName);
        if (pairIndex === -1 || dexIndex === -1) {
            logger.warn(`Failed to set price for ${pairKey}/${dexName}: index allocation failed`);
            return false;
        }
        const matrixIndex = pairIndex * this.maxDexes + dexIndex;
        this.prices[matrixIndex] = price;
        this.timestamps[matrixIndex] = Date.now() / 1000; // Unix timestamp in seconds
        this.liquidity[matrixIndex] = liquidity;
        return true;
    }
    getPrice(pairKey, dexName) {
        const pairIndex = this.pairToIndex.get(pairKey);
        const dexIndex = this.dexToIndex.get(dexName);
        if (pairIndex === undefined || dexIndex === undefined) {
            this.missCount++;
            return null;
        }
        const matrixIndex = pairIndex * this.maxDexes + dexIndex;
        const timestamp = this.timestamps[matrixIndex];
        const now = Date.now() / 1000;
        // Check TTL
        if (timestamp === 0 || (now - timestamp) > this.ttlSeconds) {
            this.missCount++;
            return null;
        }
        const price = this.prices[matrixIndex];
        const age = now - timestamp;
        this.hitCount++;
        return {
            price,
            timestamp: timestamp * 1000, // Convert back to milliseconds
            age
        };
    }
    getAllPricesForPair(pairKey) {
        const result = {};
        const pairIndex = this.pairToIndex.get(pairKey);
        if (pairIndex === undefined) {
            return result;
        }
        const now = Date.now() / 1000;
        for (let dexIndex = 0; dexIndex < this.maxDexes; dexIndex++) {
            const dexName = this.indexToDex[dexIndex];
            if (!dexName)
                continue;
            const matrixIndex = pairIndex * this.maxDexes + dexIndex;
            const timestamp = this.timestamps[matrixIndex];
            if (timestamp > 0 && (now - timestamp) <= this.ttlSeconds) {
                const price = this.prices[matrixIndex];
                const age = now - timestamp;
                result[dexName] = {
                    price,
                    timestamp: timestamp * 1000,
                    age
                };
            }
        }
        return result;
    }
    getAllPricesForDex(dexName) {
        const result = {};
        const dexIndex = this.dexToIndex.get(dexName);
        if (dexIndex === undefined) {
            return result;
        }
        const now = Date.now() / 1000;
        for (let pairIndex = 0; pairIndex < this.maxPairs; pairIndex++) {
            const pairKey = this.indexToPair[pairIndex];
            if (!pairKey)
                continue;
            const matrixIndex = pairIndex * this.maxDexes + dexIndex;
            const timestamp = this.timestamps[matrixIndex];
            if (timestamp > 0 && (now - timestamp) <= this.ttlSeconds) {
                const price = this.prices[matrixIndex];
                const age = now - timestamp;
                result[pairKey] = {
                    price,
                    timestamp: timestamp * 1000,
                    age
                };
            }
        }
        return result;
    }
    batchSetPrices(updates) {
        let successCount = 0;
        for (const update of updates) {
            if (this.setPrice(update.pairKey, update.dexName, update.price, update.liquidity)) {
                successCount++;
            }
        }
        logger.debug(`Batch set ${successCount}/${updates.length} prices`);
        return successCount;
    }
    batchGetPrices(requests) {
        return requests.map(req => this.getPrice(req.pairKey, req.dexName));
    }
    invalidatePair(pairKey) {
        const pairIndex = this.pairToIndex.get(pairKey);
        if (pairIndex === undefined)
            return;
        // Set timestamps to 0 to invalidate all prices for this pair
        for (let dexIndex = 0; dexIndex < this.maxDexes; dexIndex++) {
            const matrixIndex = pairIndex * this.maxDexes + dexIndex;
            this.timestamps[matrixIndex] = 0;
        }
        logger.debug(`Invalidated all prices for pair: ${pairKey}`);
    }
    invalidateDex(dexName) {
        const dexIndex = this.dexToIndex.get(dexName);
        if (dexIndex === undefined)
            return;
        // Set timestamps to 0 to invalidate all prices for this DEX
        for (let pairIndex = 0; pairIndex < this.maxPairs; pairIndex++) {
            const matrixIndex = pairIndex * this.maxDexes + dexIndex;
            this.timestamps[matrixIndex] = 0;
        }
        logger.debug(`Invalidated all prices for DEX: ${dexName}`);
    }
    clearExpired() {
        const now = Date.now() / 1000;
        let cleared = 0;
        for (let i = 0; i < this.timestamps.length; i++) {
            if (this.timestamps[i] > 0 && (now - this.timestamps[i]) > this.ttlSeconds) {
                this.timestamps[i] = 0;
                this.prices[i] = 0;
                this.liquidity[i] = 0;
                cleared++;
            }
        }
        if (cleared > 0) {
            logger.debug(`Cleared ${cleared} expired cache entries`);
        }
        return cleared;
    }
    getCacheStats() {
        const totalRequests = this.hitCount + this.missCount;
        const hitRate = totalRequests > 0 ? this.hitCount / totalRequests : 0;
        let activeEntries = 0;
        const now = Date.now() / 1000;
        for (let i = 0; i < this.timestamps.length; i++) {
            if (this.timestamps[i] > 0 && (now - this.timestamps[i]) <= this.ttlSeconds) {
                activeEntries++;
            }
        }
        // Calculate memory usage (approximate)
        const arraySize = (this.prices.length * 8) + (this.timestamps.length * 4) + (this.liquidity.length * 8);
        const mapSize = (this.pairToIndex.size + this.dexToIndex.size) * 50; // Rough estimate
        const memoryUsage = arraySize + mapSize;
        return {
            hitRate,
            totalRequests,
            activeEntries,
            memoryUsage
        };
    }
    // Predictive cache warming
    queueWarmup(pairKey, priority, expectedAccessTime) {
        this.warmupQueue.push({
            pairKey,
            priority,
            expectedAccessTime
        });
        // Keep queue sorted by priority (highest first)
        this.warmupQueue.sort((a, b) => b.priority - a.priority);
    }
    processWarmupQueue(maxItems = 5) {
        const now = Date.now();
        let processed = 0;
        // Process items that are ready (expected access time is near or past)
        while (processed < maxItems && this.warmupQueue.length > 0) {
            const item = this.warmupQueue[0];
            if (now >= item.expectedAccessTime - 100) { // 100ms lead time
                this.warmupQueue.shift();
                // Perform warmup (e.g., pre-load from Redis if not in cache)
                this.performWarmup(item.pairKey);
                processed++;
            }
            else {
                break; // Queue is sorted, so remaining items are not ready
            }
        }
        return processed;
    }
    async performWarmup(pairKey) {
        // Implementation would load data from Redis if not in memory cache
        // For now, just log the warmup action
        logger.debug(`Performing cache warmup for: ${pairKey}`);
    }
    getOrCreatePairIndex(pairKey) {
        let index = this.pairToIndex.get(pairKey);
        if (index === undefined) {
            // Find first available slot
            for (let i = 0; i < this.maxPairs; i++) {
                if (!this.indexToPair[i]) {
                    index = i;
                    this.pairToIndex.set(pairKey, index);
                    this.indexToPair[index] = pairKey;
                    break;
                }
            }
            if (index === undefined) {
                logger.warn(`No available slots for pair: ${pairKey}`);
                return -1;
            }
        }
        return index;
    }
    getOrCreateDexIndex(dexName) {
        let index = this.dexToIndex.get(dexName);
        if (index === undefined) {
            // Find first available slot
            for (let i = 0; i < this.maxDexes; i++) {
                if (!this.indexToDex[i]) {
                    index = i;
                    this.dexToIndex.set(dexName, index);
                    this.indexToDex[index] = dexName;
                    break;
                }
            }
            if (index === undefined) {
                logger.warn(`No available slots for DEX: ${dexName}`);
                return -1;
            }
        }
        return index;
    }
    // Memory optimization methods
    compact() {
        // Rebuild indexes to remove gaps (advanced optimization)
        // This would be called periodically to optimize memory usage
        logger.debug('Performing cache compaction');
    }
    resize(newMaxPairs, newMaxDexes) {
        if (newMaxPairs <= this.maxPairs && newMaxDexes <= this.maxDexes) {
            return; // No need to resize
        }
        logger.info(`Resizing cache from ${this.maxPairs}x${this.maxDexes} to ${newMaxPairs}x${newMaxDexes}`);
        const newPrices = new Float64Array(newMaxPairs * newMaxDexes);
        const newTimestamps = new Uint32Array(newMaxPairs * newMaxDexes);
        const newLiquidity = new Float64Array(newMaxPairs * newMaxDexes);
        // Copy existing data
        const copyPairs = Math.min(this.maxPairs, newMaxPairs);
        const copyDexes = Math.min(this.maxDexes, newMaxDexes);
        for (let pairIndex = 0; pairIndex < copyPairs; pairIndex++) {
            for (let dexIndex = 0; dexIndex < copyDexes; dexIndex++) {
                const oldIndex = pairIndex * this.maxDexes + dexIndex;
                const newIndex = pairIndex * newMaxDexes + dexIndex;
                newPrices[newIndex] = this.prices[oldIndex];
                newTimestamps[newIndex] = this.timestamps[oldIndex];
                newLiquidity[newIndex] = this.liquidity[oldIndex];
            }
        }
        // Update arrays and dimensions
        this.prices = newPrices;
        this.timestamps = newTimestamps;
        this.liquidity = newLiquidity;
        this.maxPairs = newMaxPairs;
        this.maxDexes = newMaxDexes;
    }
}
exports.MatrixPriceCache = MatrixPriceCache;
// Singleton instance
let matrixCache = null;
function getMatrixPriceCache() {
    if (!matrixCache) {
        matrixCache = new MatrixPriceCache();
    }
    return matrixCache;
}
//# sourceMappingURL=matrix-cache.js.map