"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisClient = void 0;
exports.getRedisClient = getRedisClient;
exports.getRedisClientSync = getRedisClientSync;
exports.checkRedisHealth = checkRedisHealth;
exports.resetRedisInstance = resetRedisInstance;
// Redis client for message queue and caching
const ioredis_1 = require("ioredis");
const logger_1 = require("./logger");
class RedisClient {
    constructor(url, password) {
        // Message subscription with cleanup tracking
        this.subscriptions = new Map();
        this.logger = (0, logger_1.createLogger)('redis-client');
        const options = {
            host: this.parseHost(url),
            port: this.parsePort(url),
            password,
            retryDelayOnFailover: 100,
            enableReadyCheck: false,
            maxRetriesPerRequest: 3,
            lazyConnect: true
        };
        this.client = new ioredis_1.Redis(url, options);
        this.pubClient = new ioredis_1.Redis(url, options);
        this.subClient = new ioredis_1.Redis(url, options);
        this.setupEventHandlers();
    }
    parseHost(url) {
        const match = url.match(/redis:\/\/(?:[^:]+:[^@]+@)?([^:]+):/);
        return match ? match[1] : 'localhost';
    }
    parsePort(url) {
        const match = url.match(/:(\d+)/);
        return match ? parseInt(match[1]) : 6379;
    }
    setupEventHandlers() {
        // Clean up existing listeners to prevent memory leaks
        this.client.removeAllListeners('error');
        this.client.removeAllListeners('connect');
        this.client.removeAllListeners('ready');
        this.client.removeAllListeners('close');
        this.client.on('error', (err) => {
            this.logger?.error('Redis main client error', { error: err });
        });
        this.client.on('connect', () => {
            this.logger?.info('Redis main client connected');
        });
        this.client.on('ready', () => {
            this.logger?.debug('Redis main client ready');
        });
        this.client.on('close', () => {
            this.logger?.info('Redis main client closed');
        });
        // Setup pubClient event handlers
        this.pubClient.removeAllListeners('error');
        this.pubClient.on('error', (err) => {
            this.logger?.error('Redis pub client error', { error: err });
        });
        // Setup subClient event handlers
        this.subClient.removeAllListeners('error');
        this.subClient.removeAllListeners('message');
        this.subClient.on('error', (err) => {
            this.logger?.error('Redis sub client error', { error: err });
        });
    }
    // Message publishing
    async publish(channel, message) {
        try {
            const serializedMessage = JSON.stringify({
                ...message,
                timestamp: Date.now()
            });
            return await this.pubClient.publish(channel, serializedMessage);
        }
        catch (error) {
            this.logger.error('Error publishing message', { error });
            throw error;
        }
    }
    async subscribe(channel, callback) {
        try {
            // Check if already subscribed to prevent duplicate listeners
            if (this.subscriptions.has(channel)) {
                this.logger.warn(`Already subscribed to channel ${channel}, replacing callback`);
                await this.unsubscribe(channel);
            }
            await this.subClient.subscribe(channel);
            // Create and store the listener for cleanup
            const listener = (receivedChannel, message) => {
                if (receivedChannel === channel) {
                    try {
                        const parsedMessage = JSON.parse(message);
                        callback(parsedMessage);
                    }
                    catch (error) {
                        this.logger.error('Error parsing message', { error, channel });
                    }
                }
            };
            this.subClient.on('message', listener);
            this.subscriptions.set(channel, { callback, listener });
            this.logger.debug(`Subscribed to channel: ${channel}`);
        }
        catch (error) {
            this.logger.error('Error subscribing to channel', { error, channel });
            throw error;
        }
    }
    async unsubscribe(channel) {
        try {
            const subscription = this.subscriptions.get(channel);
            if (subscription) {
                // Remove the specific listener
                this.subClient.removeListener('message', subscription.listener);
                this.subscriptions.delete(channel);
                await this.subClient.unsubscribe(channel);
                this.logger.debug(`Unsubscribed from channel: ${channel}`);
            }
        }
        catch (error) {
            this.logger.error('Error unsubscribing from channel', { error, channel });
        }
    }
    // Caching operations
    async set(key, value, ttl) {
        try {
            const serializedValue = JSON.stringify(value);
            if (ttl) {
                await this.client.setex(key, ttl, serializedValue);
            }
            else {
                await this.client.set(key, serializedValue);
            }
        }
        catch (error) {
            this.logger.error('Error setting cache', { error });
            throw error;
        }
    }
    async get(key) {
        try {
            const value = await this.client.get(key);
            return value ? JSON.parse(value) : null;
        }
        catch (error) {
            this.logger.error('Error getting cache', { error });
            return null;
        }
    }
    async del(key) {
        try {
            return await this.client.del(key);
        }
        catch (error) {
            this.logger.error('Error deleting cache', { error });
            return 0;
        }
    }
    async exists(key) {
        try {
            const result = await this.client.exists(key);
            return result === 1;
        }
        catch (error) {
            this.logger.error('Error checking existence', { error });
            return false;
        }
    }
    // Hash operations for complex data
    async hset(key, field, value) {
        try {
            const serializedValue = JSON.stringify(value);
            return await this.client.hset(key, field, serializedValue);
        }
        catch (error) {
            this.logger.error('Error setting hash field', { error });
            return 0;
        }
    }
    async hget(key, field) {
        try {
            const value = await this.client.hget(key, field);
            return value ? JSON.parse(value) : null;
        }
        catch (error) {
            this.logger.error('Error getting hash field', { error });
            return null;
        }
    }
    async hgetall(key) {
        try {
            const result = await this.client.hgetall(key);
            if (!result || Object.keys(result).length === 0)
                return null;
            const parsed = {};
            for (const [field, value] of Object.entries(result)) {
                parsed[field] = JSON.parse(value);
            }
            return parsed;
        }
        catch (error) {
            this.logger.error('Error getting all hash fields', { error });
            return null;
        }
    }
    // Service health tracking
    async updateServiceHealth(serviceName, health) {
        const key = `health:${serviceName}`;
        await this.set(key, health, 300); // 5 minute TTL
    }
    async getServiceHealth(serviceName) {
        const key = `health:${serviceName}`;
        return await this.get(key);
    }
    async getAllServiceHealth() {
        try {
            const keys = await this.client.keys('health:*');
            const health = {};
            for (const key of keys) {
                const serviceName = key.replace('health:', '');
                const serviceHealth = await this.get(key);
                if (serviceHealth) {
                    health[serviceName] = serviceHealth;
                }
            }
            return health;
        }
        catch (error) {
            this.logger.error('Error getting all service health', { error });
            return {};
        }
    }
    // Performance metrics
    async recordMetrics(serviceName, metrics) {
        // Use time-bucketed keys instead of millisecond precision to prevent memory leaks
        const timeBucket = Math.floor(Date.now() / (5 * 60 * 1000)); // 5-minute buckets
        const key = `metrics:${serviceName}:${timeBucket}`;
        // Store metrics in a hash to aggregate within the time bucket
        const field = Date.now().toString();
        await this.hset(key, field, metrics);
        // Set TTL on the hash key (24 hours)
        await this.client.expire(key, 86400);
        // Also maintain a rolling window of recent metrics (limit to prevent unbounded growth)
        const rollingKey = `metrics:${serviceName}:recent`;
        const serialized = JSON.stringify(metrics);
        // Check current list length before adding
        const currentLength = await this.client.llen(rollingKey);
        if (currentLength >= 100) {
            // Remove oldest entry before adding new one
            await this.client.rpop(rollingKey);
        }
        await this.client.lpush(rollingKey, serialized);
        // Set TTL on rolling key as well
        await this.client.expire(rollingKey, 86400);
    }
    async getRecentMetrics(serviceName, count = 10) {
        try {
            const rollingKey = `metrics:${serviceName}:recent`;
            const metrics = await this.client.lrange(rollingKey, 0, count - 1);
            return metrics.map((m) => JSON.parse(m)).reverse(); // Most recent first
        }
        catch (error) {
            this.logger.error('Error getting recent metrics', { error });
            return [];
        }
    }
    // Cleanup and maintenance
    async disconnect() {
        try {
            this.logger.info('Disconnecting Redis clients');
            // Clean up subscriptions to prevent memory leaks
            for (const [channel, subscription] of this.subscriptions) {
                try {
                    this.subClient.removeListener('message', subscription.listener);
                    await this.subClient.unsubscribe(channel);
                }
                catch (error) {
                    this.logger.warn(`Error cleaning up subscription for ${channel}`, { error });
                }
            }
            this.subscriptions.clear();
            // Remove all remaining event listeners to prevent memory leaks
            this.client.removeAllListeners();
            this.pubClient.removeAllListeners();
            this.subClient.removeAllListeners();
            // Disconnect all clients with timeout to prevent hanging
            const disconnectPromises = [
                this.client.disconnect(),
                this.pubClient.disconnect(),
                this.subClient.disconnect()
            ];
            // Add timeout to prevent indefinite waiting
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Redis disconnect timeout')), 5000);
            });
            await Promise.race([Promise.all(disconnectPromises), timeoutPromise]);
            this.logger.info('Redis clients disconnected successfully');
        }
        catch (error) {
            this.logger.error('Error during Redis disconnect', { error });
            // Force disconnect even if there were errors
            try {
                this.client.disconnect();
                this.pubClient.disconnect();
                this.subClient.disconnect();
            }
            catch (forceError) {
                this.logger.error('Force disconnect also failed', { error: forceError });
            }
        }
    }
    // Health check
    async ping() {
        try {
            const result = await this.client.ping();
            return result === 'PONG';
        }
        catch (error) {
            return false;
        }
    }
}
exports.RedisClient = RedisClient;
// Thread-safe singleton with proper async initialization
let redisInstance = null;
let redisInstancePromise = null;
let initializationError = null;
async function getRedisClient(url, password) {
    // If already initialized successfully, return immediately
    if (redisInstance) {
        return redisInstance;
    }
    // If there's a cached error, throw it
    if (initializationError) {
        throw initializationError;
    }
    // If initialization is already in progress, wait for it
    if (redisInstancePromise) {
        try {
            redisInstance = await redisInstancePromise;
            return redisInstance;
        }
        catch (error) {
            initializationError = error;
            throw error;
        }
    }
    // Start new initialization
    redisInstancePromise = (async () => {
        try {
            const redisUrl = url || process.env.REDIS_URL || 'redis://localhost:6379';
            const redisPassword = password || process.env.REDIS_PASSWORD;
            const instance = new RedisClient(redisUrl, redisPassword);
            // Wait for initial connection to ensure the client is ready
            await instance.ping();
            redisInstance = instance;
            return instance;
        }
        catch (error) {
            initializationError = error;
            throw error;
        }
    })();
    try {
        redisInstance = await redisInstancePromise;
        return redisInstance;
    }
    catch (error) {
        throw error;
    }
}
// Synchronous version - only use after async initialization
function getRedisClientSync() {
    if (initializationError) {
        throw initializationError;
    }
    return redisInstance;
}
// Health check for Redis connectivity
async function checkRedisHealth(url, password) {
    try {
        const client = new RedisClient(url || process.env.REDIS_URL || 'redis://localhost:6379', password || process.env.REDIS_PASSWORD);
        const isHealthy = await client.ping();
        await client.disconnect(); // Clean up test client
        return isHealthy;
    }
    catch (error) {
        return false;
    }
}
// Reset singleton for testing purposes
function resetRedisInstance() {
    if (redisInstance) {
        redisInstance.disconnect().catch(() => { }); // Best effort cleanup
    }
    redisInstance = null;
    redisInstancePromise = null;
    initializationError = null;
}
//# sourceMappingURL=redis.js.map