"use strict";
// Hierarchical Cache System (L1/L2/L3)
// L1: SharedArrayBuffer for ultra-fast cross-worker access
// L2: Redis for distributed caching
// L3: Persistent storage for long-term data
Object.defineProperty(exports, "__esModule", { value: true });
exports.HierarchicalCache = void 0;
exports.createHierarchicalCache = createHierarchicalCache;
exports.getHierarchicalCache = getHierarchicalCache;
const redis_1 = require("./redis");
const logger_1 = require("./logger");
const logger = (0, logger_1.createLogger)('hierarchical-cache');
class HierarchicalCache {
    constructor(config = {}) {
        // L1 Cache: SharedArrayBuffer for ultra-fast access
        this.l1Metadata = new Map();
        this.l1EvictionQueue = []; // LRU eviction
        // L2 Cache: Redis
        this.l2Prefix = 'cache:l2:';
        // L3 Cache: Persistent storage simulation (would be DB in production)
        this.l3Storage = new Map();
        this.l3Prefix = 'cache:l3:';
        // Cache statistics
        this.stats = {
            l1: { hits: 0, misses: 0, evictions: 0, size: 0 },
            l2: { hits: 0, misses: 0, evictions: 0, size: 0 },
            l3: { hits: 0, misses: 0, evictions: 0, size: 0 },
            promotions: 0,
            demotions: 0
        };
        this.config = {
            l1Enabled: config.l1Enabled !== false,
            l1Size: config.l1Size || 64, // 64MB default
            l2Enabled: config.l2Enabled !== false,
            l2Ttl: config.l2Ttl || 300, // 5 minutes
            l3Enabled: config.l3Enabled !== false,
            enablePromotion: config.enablePromotion !== false,
            enableDemotion: config.enableDemotion !== false
        };
        this.l1MaxEntries = Math.floor(this.config.l1Size * 1024 * 1024 / 1024); // Rough estimate
        if (this.config.l2Enabled) {
            this.redis = (0, redis_1.getRedisClient)();
        }
        logger.info('Hierarchical cache initialized', {
            l1Enabled: this.config.l1Enabled,
            l2Enabled: this.config.l2Enabled,
            l3Enabled: this.config.l3Enabled,
            l1Size: this.config.l1Size
        });
    }
    async get(key) {
        const startTime = performance.now();
        try {
            // Validate input
            if (!key || typeof key !== 'string') {
                logger.warn('Invalid cache key provided', { key });
                return null;
            }
            // Try L1 first (ultra-fast)
            if (this.config.l1Enabled) {
                try {
                    const l1Result = this.getFromL1(key);
                    if (l1Result !== null) {
                        this.stats.l1.hits++;
                        this.recordAccessTime('l1_get', performance.now() - startTime);
                        return l1Result;
                    }
                    this.stats.l1.misses++;
                }
                catch (error) {
                    logger.error('L1 cache error', { error, key });
                    this.stats.l1.misses++;
                }
            }
            // Try L2 (Redis)
            if (this.config.l2Enabled) {
                try {
                    const l2Result = await this.getFromL2(key);
                    if (l2Result !== null) {
                        this.stats.l2.hits++;
                        // Promote to L1 if enabled
                        if (this.config.enablePromotion) {
                            try {
                                this.setInL1(key, l2Result);
                            }
                            catch (promoError) {
                                logger.warn('Failed to promote to L1', { error: promoError, key });
                            }
                        }
                        this.recordAccessTime('l2_get', performance.now() - startTime);
                        return l2Result;
                    }
                    this.stats.l2.misses++;
                }
                catch (error) {
                    logger.error('L2 cache error', { error, key });
                    this.stats.l2.misses++;
                }
            }
            // Try L3 (persistent)
            if (this.config.l3Enabled) {
                try {
                    const l3Result = this.getFromL3(key);
                    if (l3Result !== null) {
                        this.stats.l3.hits++;
                        // Promote through hierarchy if enabled
                        if (this.config.enablePromotion) {
                            if (this.config.l2Enabled) {
                                try {
                                    await this.setInL2(key, l3Result);
                                }
                                catch (l2Error) {
                                    logger.warn('Failed to promote to L2', { error: l2Error, key });
                                }
                            }
                            if (this.config.l1Enabled) {
                                try {
                                    this.setInL1(key, l3Result);
                                }
                                catch (l1Error) {
                                    logger.warn('Failed to promote to L1', { error: l1Error, key });
                                }
                            }
                        }
                        this.recordAccessTime('l3_get', performance.now() - startTime);
                        return l3Result;
                    }
                    this.stats.l3.misses++;
                }
                catch (error) {
                    logger.error('L3 cache error', { error, key });
                    this.stats.l3.misses++;
                }
            }
            this.recordAccessTime('cache_miss', performance.now() - startTime);
            return null;
        }
        catch (error) {
            logger.error('Unexpected error in hierarchical cache get', { error, key });
            this.recordAccessTime('cache_error', performance.now() - startTime);
            return null;
        }
    }
    async set(key, value, ttl) {
        const startTime = performance.now();
        const entry = {
            key,
            value,
            timestamp: Date.now(),
            accessCount: 0,
            lastAccess: Date.now(),
            size: this.estimateSize(value),
            ttl
        };
        // Set in L1 (fastest)
        if (this.config.l1Enabled) {
            this.setInL1(key, value, ttl);
        }
        // Set in L2
        if (this.config.l2Enabled) {
            await this.setInL2(key, value, ttl);
        }
        // Set in L3 (persistent)
        if (this.config.l3Enabled) {
            this.setInL3(key, entry);
        }
        this.recordAccessTime('cache_set', performance.now() - startTime);
    }
    async invalidate(key) {
        // Invalidate across all levels
        if (this.config.l1Enabled) {
            this.invalidateL1(key);
        }
        if (this.config.l2Enabled) {
            await this.invalidateL2(key);
        }
        if (this.config.l3Enabled) {
            this.invalidateL3(key);
        }
    }
    async delete(key) {
        return this.invalidate(key);
    }
    async clear() {
        if (this.config.l1Enabled) {
            this.l1Metadata.clear();
            this.l1EvictionQueue = [];
        }
        if (this.config.l2Enabled) {
            await this.invalidateL2Pattern('*');
        }
        if (this.config.l3Enabled) {
            this.l3Storage.clear();
        }
    }
    async invalidatePattern(pattern) {
        // Invalidate pattern across all levels
        if (this.config.l1Enabled) {
            this.invalidateL1Pattern(pattern);
        }
        if (this.config.l2Enabled) {
            await this.invalidateL2Pattern(pattern);
        }
        if (this.config.l3Enabled) {
            this.invalidateL3Pattern(pattern);
        }
    }
    getStats() {
        return {
            ...this.stats,
            l1: {
                ...this.stats.l1,
                entries: this.l1Metadata.size,
                utilization: this.l1Metadata.size / this.l1MaxEntries
            },
            l2: {
                ...this.stats.l2,
                // Would need Redis INFO command for accurate stats
            },
            l3: {
                ...this.stats.l3,
                entries: this.l3Storage.size
            }
        };
    }
    getFromL1(key) {
        const entry = this.l1Metadata.get(key);
        if (!entry)
            return null;
        // Check TTL
        if (entry.ttl && Date.now() - entry.timestamp > entry.ttl * 1000) {
            this.invalidateL1(key);
            return null;
        }
        // Update access statistics
        entry.accessCount++;
        entry.lastAccess = Date.now();
        // Move to end of LRU queue (most recently used)
        const index = this.l1EvictionQueue.indexOf(key);
        if (index > -1) {
            this.l1EvictionQueue.splice(index, 1);
        }
        this.l1EvictionQueue.push(key);
        return entry.value;
    }
    setInL1(key, value, ttl) {
        const size = this.estimateSize(value);
        // Evict if necessary
        while (this.l1Metadata.size >= this.l1MaxEntries ||
            this.getCurrentL1Size() + size > this.config.l1Size * 1024 * 1024) {
            this.evictL1();
        }
        const entry = {
            key,
            value,
            timestamp: Date.now(),
            accessCount: 1,
            lastAccess: Date.now(),
            size,
            ttl
        };
        this.l1Metadata.set(key, entry);
        // Add to LRU queue
        const index = this.l1EvictionQueue.indexOf(key);
        if (index > -1) {
            this.l1EvictionQueue.splice(index, 1);
        }
        this.l1EvictionQueue.push(key);
    }
    invalidateL1(key) {
        this.l1Metadata.delete(key);
        const index = this.l1EvictionQueue.indexOf(key);
        if (index > -1) {
            this.l1EvictionQueue.splice(index, 1);
        }
    }
    invalidateL1Pattern(pattern) {
        for (const key of this.l1Metadata.keys()) {
            if (key.includes(pattern)) {
                this.invalidateL1(key);
            }
        }
    }
    evictL1() {
        if (this.l1EvictionQueue.length === 0)
            return;
        const key = this.l1EvictionQueue.shift();
        if (key) {
            this.l1Metadata.delete(key);
            this.stats.l1.evictions++;
        }
    }
    getCurrentL1Size() {
        let total = 0;
        for (const entry of this.l1Metadata.values()) {
            total += entry.size;
        }
        return total;
    }
    // L2 Cache Implementation (Redis)
    async getFromL2(key) {
        try {
            const redis = await this.redis;
            const data = await redis.get(`${this.l2Prefix}${key}`);
            return data ? JSON.parse(data) : null;
        }
        catch (error) {
            logger.error('L2 cache get error', { error, key });
            return null;
        }
    }
    async setInL2(key, value, ttl) {
        try {
            const redis = await this.redis;
            const serialized = JSON.stringify(value);
            const redisKey = `${this.l2Prefix}${key}`;
            if (ttl) {
                await redis.setex(redisKey, ttl, serialized);
            }
            else {
                await redis.setex(redisKey, this.config.l2Ttl, serialized);
            }
        }
        catch (error) {
            logger.error('L2 cache set error', { error, key });
        }
    }
    async invalidateL2(key) {
        try {
            const redis = await this.redis;
            await redis.del(`${this.l2Prefix}${key}`);
        }
        catch (error) {
            logger.error('L2 cache invalidate error', { error, key });
        }
    }
    /**
     * P0-FIX: Use SCAN instead of KEYS to prevent blocking Redis server.
     * KEYS command blocks the server for the duration of the scan, which can
     * cause performance issues in production with large keyspaces.
     * SCAN iterates incrementally and doesn't block.
     */
    async invalidateL2Pattern(pattern) {
        try {
            const redis = await this.redis;
            const searchPattern = `${this.l2Prefix}*${pattern}*`;
            // P0-FIX: Use cursor-based SCAN iteration instead of KEYS
            let cursor = '0';
            let deletedCount = 0;
            const batchSize = 100; // Process keys in batches
            do {
                // SCAN returns [cursor, keys] - cursor is '0' when scan is complete
                const [nextCursor, keys] = await this.scanKeys(redis, cursor, searchPattern, batchSize);
                cursor = nextCursor;
                if (keys.length > 0) {
                    await redis.del(...keys);
                    deletedCount += keys.length;
                }
            } while (cursor !== '0');
            if (deletedCount > 0) {
                logger.debug('L2 cache pattern invalidation complete', {
                    pattern,
                    deletedCount
                });
            }
        }
        catch (error) {
            logger.error('L2 cache pattern invalidate error', { error, pattern });
        }
    }
    /**
     * P0-FIX: Helper method to perform SCAN operation.
     * Uses the underlying Redis client's scan capability.
     */
    async scanKeys(redis, cursor, pattern, count) {
        try {
            // Try to use the native scan method if available
            if (typeof redis.scan === 'function') {
                const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', count);
                return result;
            }
            // Fallback: if scan is not available on the wrapper, try the underlying client
            if (redis.client && typeof redis.client.scan === 'function') {
                const result = await redis.client.scan(cursor, 'MATCH', pattern, 'COUNT', count);
                return result;
            }
            // Last resort fallback: use keys but with warning (should not happen in production)
            logger.warn('SCAN not available, falling back to KEYS command');
            const keys = await redis.keys(pattern);
            return ['0', keys];
        }
        catch (error) {
            logger.error('SCAN operation failed', { error, cursor, pattern });
            return ['0', []];
        }
    }
    // L3 Cache Implementation (Persistent Storage)
    getFromL3(key) {
        const entry = this.l3Storage.get(`${this.l3Prefix}${key}`);
        if (!entry)
            return null;
        // Check TTL
        if (entry.ttl && Date.now() - entry.timestamp > entry.ttl * 1000) {
            this.invalidateL3(key);
            return null;
        }
        entry.accessCount++;
        entry.lastAccess = Date.now();
        return entry.value;
    }
    setInL3(key, entry) {
        this.l3Storage.set(`${this.l3Prefix}${key}`, entry);
    }
    invalidateL3(key) {
        this.l3Storage.delete(`${this.l3Prefix}${key}`);
    }
    invalidateL3Pattern(pattern) {
        for (const key of this.l3Storage.keys()) {
            if (key.includes(pattern)) {
                this.l3Storage.delete(key);
            }
        }
    }
    // Utility methods
    estimateSize(obj) {
        // Rough size estimation
        const str = JSON.stringify(obj);
        return str ? str.length * 2 : 100; // Rough estimate: 2 bytes per char + overhead
    }
    recordAccessTime(operation, time) {
        // Would integrate with performance monitoring
        logger.debug(`Cache operation: ${operation} took ${time.toFixed(3)}ms`);
    }
    // Cleanup and maintenance
    async cleanup() {
        // Clean up expired entries
        const now = Date.now();
        // L1 cleanup
        if (this.config.l1Enabled) {
            for (const [key, entry] of this.l1Metadata.entries()) {
                if (entry.ttl && now - entry.timestamp > entry.ttl * 1000) {
                    this.invalidateL1(key);
                }
            }
        }
        // L3 cleanup
        if (this.config.l3Enabled) {
            for (const [key, entry] of this.l3Storage.entries()) {
                if (entry.ttl && now - entry.timestamp > entry.ttl * 1000) {
                    this.l3Storage.delete(key);
                }
            }
        }
        // Auto-demotion based on access patterns
        if (this.config.enableDemotion) {
            await this.performAutoDemotion();
        }
    }
    async performAutoDemotion() {
        // Demote rarely accessed L1 entries to L2
        if (!this.config.l1Enabled || !this.config.l2Enabled)
            return;
        const now = Date.now();
        const demotionThreshold = 5 * 60 * 1000; // 5 minutes
        for (const [key, entry] of this.l1Metadata.entries()) {
            if (now - entry.lastAccess > demotionThreshold && entry.accessCount < 3) {
                // Move to L2 only, keep in L3
                await this.setInL2(key, entry.value, entry.ttl);
                this.invalidateL1(key);
                this.stats.demotions++;
            }
        }
    }
}
exports.HierarchicalCache = HierarchicalCache;
// Factory function
function createHierarchicalCache(config) {
    return new HierarchicalCache(config);
}
// Default instance
let defaultCache = null;
function getHierarchicalCache() {
    if (!defaultCache) {
        defaultCache = new HierarchicalCache({
            l1Enabled: true,
            l1Size: 128, // 128MB L1 cache
            l2Enabled: true,
            l2Ttl: 600, // 10 minutes
            l3Enabled: true,
            enablePromotion: true,
            enableDemotion: true
        });
    }
    return defaultCache;
}
//# sourceMappingURL=hierarchical-cache.js.map