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
// P2-2-FIX: Import config with fallback for test environment
let SYSTEM_CONSTANTS;
try {
    SYSTEM_CONSTANTS = require('../../config/src').SYSTEM_CONSTANTS;
}
catch {
    // Config not available, will use defaults
}
// P2-2-FIX: Default values for when config is not available
const REDIS_DEFAULTS = {
    maxMessageSize: SYSTEM_CONSTANTS?.redis?.maxMessageSize ?? 1024 * 1024, // 1MB
    maxChannelNameLength: SYSTEM_CONSTANTS?.redis?.maxChannelNameLength ?? 128,
};
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
    // Message publishing with security validation
    async publish(channel, message) {
        // SECURITY: Validate and sanitize inputs
        this.validateChannelName(channel);
        this.validateMessage(message);
        try {
            const serializedMessage = JSON.stringify({
                ...message,
                timestamp: Date.now()
            });
            // SECURITY: Limit message size to prevent DoS
            // P2-2-FIX: Use configured constant instead of magic number
            if (serializedMessage.length > REDIS_DEFAULTS.maxMessageSize) {
                throw new Error('Message too large');
            }
            return await this.pubClient.publish(channel, serializedMessage);
        }
        catch (error) {
            this.logger.error('Error publishing message', { error, channel });
            throw error;
        }
    }
    validateChannelName(channel) {
        // SECURITY: Only allow safe characters in channel names
        if (!channel || typeof channel !== 'string') {
            throw new Error('Invalid channel name: must be non-empty string');
        }
        // P2-2-FIX: Use configured constant instead of magic number
        if (channel.length > REDIS_DEFAULTS.maxChannelNameLength) {
            throw new Error('Channel name too long');
        }
        // Allow only alphanumeric, dash, underscore, and colon
        if (!/^[a-zA-Z0-9\-_:]+$/.test(channel)) {
            throw new Error('Invalid channel name: contains unsafe characters');
        }
    }
    validateMessage(message) {
        // SECURITY: Validate MessageEvent structure
        if (!message || typeof message !== 'object') {
            throw new Error('Invalid message: must be object');
        }
        if (!message.type || typeof message.type !== 'string') {
            throw new Error('Invalid message: missing or invalid type');
        }
        if (message.timestamp && (typeof message.timestamp !== 'number' || message.timestamp < 0)) {
            throw new Error('Invalid message: invalid timestamp');
        }
        if (message.correlationId && typeof message.correlationId !== 'string') {
            throw new Error('Invalid message: invalid correlationId');
        }
        // SECURITY: Sanitize string fields
        if (message.source && typeof message.source === 'string') {
            message.source = message.source.replace(/[^a-zA-Z0-9\-_\.]/g, '');
        }
        if (message.correlationId && typeof message.correlationId === 'string') {
            message.correlationId = message.correlationId.replace(/[^a-zA-Z0-9\-_]/g, '');
        }
    }
    async subscribe(channel, callback) {
        try {
            // Check if already subscribed to prevent duplicate listeners
            if (this.subscriptions.has(channel)) {
                this.logger.warn(`Already subscribed to channel ${channel}, replacing callback`);
                // Remove old listener first, then delete from map
                const oldSubscription = this.subscriptions.get(channel);
                this.subClient.removeListener('message', oldSubscription.listener);
                this.subscriptions.delete(channel);
                // Note: We don't call subClient.unsubscribe() here because we're immediately resubscribing
            }
            // Create the listener BEFORE subscribing to prevent missing messages
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
            // Add listener first, then subscribe to channel
            this.subClient.on('message', listener);
            this.subscriptions.set(channel, { callback, listener });
            try {
                await this.subClient.subscribe(channel);
                this.logger.debug(`Subscribed to channel: ${channel}`);
            }
            catch (subscribeError) {
                // Rollback: remove listener if subscribe fails
                this.subClient.removeListener('message', listener);
                this.subscriptions.delete(channel);
                throw subscribeError;
            }
        }
        catch (error) {
            this.logger.error('Error subscribing to channel', { error, channel });
            throw error;
        }
    }
    async unsubscribe(channel) {
        const subscription = this.subscriptions.get(channel);
        if (!subscription) {
            return; // Nothing to unsubscribe
        }
        // Delete from map first to prevent race conditions
        this.subscriptions.delete(channel);
        try {
            // Remove listener
            this.subClient.removeListener('message', subscription.listener);
            // Unsubscribe from channel
            await this.subClient.unsubscribe(channel);
            this.logger.debug(`Unsubscribed from channel: ${channel}`);
        }
        catch (error) {
            this.logger.error('Error unsubscribing from channel', { error, channel });
            // Don't re-add to map - channel is considered unsubscribed even if cleanup failed
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
    async del(...keys) {
        try {
            if (keys.length === 0)
                return 0;
            return await this.client.del(...keys);
        }
        catch (error) {
            this.logger.error('Error deleting cache', { error });
            return 0;
        }
    }
    async expire(key, seconds) {
        try {
            return await this.client.expire(key, seconds);
        }
        catch (error) {
            this.logger.error('Error setting expire', { error });
            return 0;
        }
    }
    /**
     * Set key only if it doesn't exist (for leader election)
     * Returns true if the key was set, false if it already exists
     */
    async setNx(key, value, ttlSeconds) {
        try {
            let result;
            if (ttlSeconds) {
                // SET key value NX EX seconds
                result = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
            }
            else {
                // SET key value NX
                result = await this.client.set(key, value, 'NX');
            }
            return result === 'OK';
        }
        catch (error) {
            this.logger.error('Error setting NX', { error, key });
            return false;
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
    /**
     * Execute a Lua script atomically.
     * Used for atomic operations like conditional delete (check-and-delete).
     *
     * @param script - Lua script to execute
     * @param keys - Array of keys to pass to the script (KEYS[1], KEYS[2], etc.)
     * @param args - Array of arguments to pass to the script (ARGV[1], ARGV[2], etc.)
     * @returns Script result
     */
    async eval(script, keys, args) {
        try {
            const result = await this.client.eval(script, keys.length, ...keys, ...args);
            return result;
        }
        catch (error) {
            this.logger.error('Error executing Lua script', { error });
            throw error;
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
    // Set operations
    async sadd(key, ...members) {
        try {
            return await this.client.sadd(key, ...members);
        }
        catch (error) {
            this.logger.error('Error sadd', { error });
            return 0;
        }
    }
    async srem(key, ...members) {
        try {
            return await this.client.srem(key, ...members);
        }
        catch (error) {
            this.logger.error('Error srem', { error });
            return 0;
        }
    }
    async smembers(key) {
        try {
            return await this.client.smembers(key);
        }
        catch (error) {
            this.logger.error('Error smembers', { error });
            return [];
        }
    }
    // Sorted Set operations
    async zadd(key, score, member) {
        try {
            return await this.client.zadd(key, score, member);
        }
        catch (error) {
            this.logger.error('Error zadd', { error });
            return 0;
        }
    }
    async zrange(key, start, stop, withScores = '') {
        try {
            if (withScores === 'WITHSCORES') {
                return await this.client.zrange(key, start, stop, 'WITHSCORES');
            }
            return await this.client.zrange(key, start, stop);
        }
        catch (error) {
            this.logger.error('Error zrange', { error });
            return [];
        }
    }
    async zrem(key, ...members) {
        try {
            return await this.client.zrem(key, ...members);
        }
        catch (error) {
            this.logger.error('Error zrem', { error });
            return 0;
        }
    }
    async zcard(key) {
        try {
            return await this.client.zcard(key);
        }
        catch (error) {
            this.logger.error('Error zcard', { error });
            return 0;
        }
    }
    async zscore(key, member) {
        try {
            return await this.client.zscore(key, member);
        }
        catch (error) {
            this.logger.error('Error zscore', { error });
            return null;
        }
    }
    // Key operations
    async keys(pattern) {
        try {
            return await this.client.keys(pattern);
        }
        catch (error) {
            this.logger.error('Error keys', { error });
            return [];
        }
    }
    async llen(key) {
        try {
            return await this.client.llen(key);
        }
        catch (error) {
            this.logger.error('Error llen', { error });
            return 0;
        }
    }
    async lpush(key, ...values) {
        try {
            return await this.client.lpush(key, ...values);
        }
        catch (error) {
            this.logger.error('Error lpush', { error });
            return 0;
        }
    }
    async rpop(key) {
        try {
            return await this.client.rpop(key);
        }
        catch (error) {
            this.logger.error('Error rpop', { error });
            return null;
        }
    }
    async lrange(key, start, stop) {
        try {
            return await this.client.lrange(key, start, stop);
        }
        catch (error) {
            this.logger.error('Error lrange', { error });
            return [];
        }
    }
    async ltrim(key, start, stop) {
        try {
            return await this.client.ltrim(key, start, stop);
        }
        catch (error) {
            this.logger.error('Error ltrim', { error });
            return 'OK';
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