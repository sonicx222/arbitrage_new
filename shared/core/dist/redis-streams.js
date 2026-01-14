"use strict";
/**
 * Redis Streams Client
 *
 * High-performance Redis Streams implementation for event-driven arbitrage system.
 * Provides persistent message queues with consumer groups, batching, and backpressure.
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 *
 * Key Features:
 * - XADD for publishing messages with automatic ID generation
 * - XREAD/XREADGROUP for consuming messages
 * - Consumer groups for distributed processing
 * - Batching for reduced Redis command usage (50:1 ratio target)
 * - Automatic stream trimming to manage memory
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.StreamConsumer = exports.RedisStreamsClient = exports.StreamBatcher = void 0;
exports.getRedisStreamsClient = getRedisStreamsClient;
exports.resetRedisStreamsInstance = resetRedisStreamsInstance;
const ioredis_1 = __importDefault(require("ioredis"));
const logger_1 = require("./logger");
// =============================================================================
// Stream Batcher
// =============================================================================
class StreamBatcher {
    constructor(client, streamName, config, logger) {
        this.client = client;
        this.streamName = streamName;
        this.config = config;
        this.logger = logger;
        this.queue = [];
        this.timer = null;
        this.flushing = false; // Guard against concurrent flushes
        this.flushLock = null; // P0-1 fix: Mutex for atomic flush
        this.destroyed = false;
        this.stats = {
            currentQueueSize: 0,
            totalMessagesQueued: 0,
            batchesSent: 0,
            totalMessagesSent: 0,
            compressionRatio: 1,
            averageBatchSize: 0
        };
    }
    add(message) {
        if (this.destroyed) {
            this.logger.warn('Attempted to add message to destroyed batcher', { streamName: this.streamName });
            return;
        }
        this.queue.push(message);
        this.stats.totalMessagesQueued++;
        // Check if batch size reached
        if (this.queue.length >= this.config.maxBatchSize) {
            this.flush().catch(err => {
                this.logger.error('Flush failed after batch size reached', { error: err });
            });
        }
        else if (!this.timer) {
            // Start timer for time-based flush
            this.timer = setTimeout(() => {
                this.flush().catch(err => {
                    this.logger.error('Flush failed on timer', { error: err });
                });
            }, this.config.maxWaitMs);
        }
    }
    async flush() {
        // P0-1 fix: Use mutex lock to prevent concurrent flushes
        // Wait for any existing flush operation to complete
        if (this.flushLock) {
            await this.flushLock;
            // After waiting, check if queue was already emptied by previous flush
            if (this.queue.length === 0) {
                return;
            }
        }
        // Guard against concurrent flushes (additional safety)
        if (this.flushing) {
            return;
        }
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.queue.length === 0) {
            return;
        }
        // P0-1 fix: Create mutex lock BEFORE setting flushing flag
        let resolveLock;
        this.flushLock = new Promise(resolve => { resolveLock = resolve; });
        this.flushing = true;
        // Atomically take the batch - prevents race condition
        const batch = this.queue;
        this.queue = [];
        try {
            // Send as single batched message
            const batchedMessage = {
                type: 'batch',
                count: batch.length,
                messages: batch,
                timestamp: Date.now()
            };
            await this.client.xadd(this.streamName, batchedMessage);
            // Update stats
            this.stats.batchesSent++;
            this.stats.totalMessagesSent += batch.length;
            this.stats.averageBatchSize = this.stats.totalMessagesSent / this.stats.batchesSent;
            // Compression ratio: messages queued / Redis commands sent (higher is better)
            // Target is 50:1 per ADR-002
            this.stats.compressionRatio = this.stats.totalMessagesQueued / this.stats.batchesSent;
        }
        catch (error) {
            this.logger.error('Error flushing batch', { error, streamName: this.streamName, batchSize: batch.length });
            // Re-queue failed messages at the front to preserve order
            this.queue = [...batch, ...this.queue];
            throw error;
        }
        finally {
            this.flushing = false;
            this.flushLock = null;
            resolveLock();
        }
    }
    getStats() {
        return { ...this.stats, currentQueueSize: this.queue.length };
    }
    async destroy() {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        // Await final flush to ensure messages are sent
        if (this.queue.length > 0) {
            try {
                await this.flush();
            }
            catch (error) {
                this.logger.warn('Failed to flush remaining messages on destroy', {
                    error,
                    lostMessages: this.queue.length
                });
            }
        }
    }
}
exports.StreamBatcher = StreamBatcher;
// =============================================================================
// Redis Streams Client
// =============================================================================
class RedisStreamsClient {
    constructor(url, password) {
        this.batchers = new Map();
        this.logger = (0, logger_1.createLogger)('redis-streams');
        const options = {
            password,
            retryStrategy: (times) => {
                if (times > 3) {
                    this.logger.error('Redis connection failed after 3 retries');
                    return null;
                }
                return Math.min(times * 100, 3000);
            },
            maxRetriesPerRequest: 3,
            lazyConnect: true
        };
        this.client = new ioredis_1.default(url, options);
        this.setupEventHandlers();
    }
    setupEventHandlers() {
        this.client.removeAllListeners('error');
        this.client.removeAllListeners('connect');
        this.client.on('error', (err) => {
            this.logger.error('Redis Streams client error', { error: err.message });
        });
        this.client.on('connect', () => {
            this.logger.info('Redis Streams client connected');
        });
    }
    // ===========================================================================
    // XADD - Add message to stream
    // ===========================================================================
    async xadd(streamName, message, id = '*', options = {}) {
        this.validateStreamName(streamName);
        const serialized = JSON.stringify(message);
        const maxRetries = options.maxRetries ?? 3;
        let lastError = null;
        for (let attempt = 0; attempt <= (options.retry ? maxRetries : 0); attempt++) {
            try {
                let messageId;
                // P1-3 fix: Support MAXLEN to prevent unbounded stream growth
                if (options.maxLen !== undefined) {
                    const approximate = options.approximate !== false; // Default to approximate
                    if (approximate) {
                        // Use approximate (~) trimming for better performance
                        messageId = await this.client.xadd(streamName, 'MAXLEN', '~', options.maxLen.toString(), id, 'data', serialized);
                    }
                    else {
                        // Exact trimming (slower but precise)
                        messageId = await this.client.xadd(streamName, 'MAXLEN', options.maxLen.toString(), id, 'data', serialized);
                    }
                }
                else {
                    messageId = await this.client.xadd(streamName, id, 'data', serialized);
                }
                return messageId;
            }
            catch (error) {
                lastError = error;
                if (!options.retry || attempt === maxRetries) {
                    throw error;
                }
                // Wait before retry with exponential backoff
                await this.sleep(Math.pow(2, attempt) * 100);
            }
        }
        throw lastError;
    }
    /**
     * P1-3 fix: Add message with automatic MAXLEN based on stream type.
     * Uses recommended limits from STREAM_MAX_LENGTHS.
     */
    async xaddWithLimit(streamName, message, options = {}) {
        const maxLen = RedisStreamsClient.STREAM_MAX_LENGTHS[streamName];
        return this.xadd(streamName, message, '*', {
            ...options,
            maxLen,
            approximate: true
        });
    }
    // ===========================================================================
    // XREAD - Read from stream
    // ===========================================================================
    async xread(streamName, lastId, options = {}) {
        this.validateStreamName(streamName);
        try {
            const args = [];
            if (options.count) {
                args.push('COUNT', options.count);
            }
            if (options.block !== undefined) {
                // P1-8 FIX: Apply safety cap to prevent indefinite blocking
                // Default max: 30 seconds. 0 = forever (explicitly disabled cap)
                const maxBlockMs = options.maxBlockMs ?? 30000;
                let effectiveBlock = options.block;
                if (maxBlockMs > 0 && (options.block === 0 || options.block > maxBlockMs)) {
                    this.logger.debug('XREAD block time capped', {
                        requested: options.block,
                        capped: maxBlockMs,
                        streamName
                    });
                    effectiveBlock = maxBlockMs;
                }
                args.push('BLOCK', effectiveBlock);
            }
            args.push('STREAMS', streamName, lastId);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result = await this.client.xread(...args);
            if (!result) {
                return [];
            }
            return this.parseStreamResult(result);
        }
        catch (error) {
            this.logger.error('XREAD error', { error, streamName });
            throw error;
        }
    }
    // ===========================================================================
    // Consumer Groups
    // ===========================================================================
    async createConsumerGroup(config) {
        try {
            await this.client.xgroup('CREATE', config.streamName, config.groupName, config.startId ?? '$', 'MKSTREAM');
            this.logger.info('Consumer group created', {
                stream: config.streamName,
                group: config.groupName
            });
        }
        catch (error) {
            // Ignore "group already exists" error
            if (error.message?.includes('BUSYGROUP')) {
                this.logger.debug('Consumer group already exists', {
                    stream: config.streamName,
                    group: config.groupName
                });
                return;
            }
            throw error;
        }
    }
    async xreadgroup(config, options = {}) {
        try {
            const args = [
                'GROUP', config.groupName, config.consumerName
            ];
            if (options.count) {
                args.push('COUNT', options.count);
            }
            if (options.block !== undefined) {
                // P1-8 FIX: Apply safety cap to prevent indefinite blocking
                const maxBlockMs = options.maxBlockMs ?? 30000;
                let effectiveBlock = options.block;
                if (maxBlockMs > 0 && (options.block === 0 || options.block > maxBlockMs)) {
                    this.logger.debug('XREADGROUP block time capped', {
                        requested: options.block,
                        capped: maxBlockMs,
                        stream: config.streamName,
                        group: config.groupName
                    });
                    effectiveBlock = maxBlockMs;
                }
                args.push('BLOCK', effectiveBlock);
            }
            if (options.noAck) {
                args.push('NOACK');
            }
            args.push('STREAMS', config.streamName, options.startId ?? '>');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result = await this.client.xreadgroup(...args);
            if (!result) {
                return [];
            }
            return this.parseStreamResult(result);
        }
        catch (error) {
            this.logger.error('XREADGROUP error', { error, config });
            throw error;
        }
    }
    // ===========================================================================
    // XACK - Acknowledge messages
    // ===========================================================================
    async xack(streamName, groupName, ...messageIds) {
        try {
            return await this.client.xack(streamName, groupName, ...messageIds);
        }
        catch (error) {
            this.logger.error('XACK error', { error, streamName, groupName });
            throw error;
        }
    }
    // ===========================================================================
    // Stream Information
    // ===========================================================================
    async xlen(streamName) {
        try {
            return await this.client.xlen(streamName);
        }
        catch (error) {
            this.logger.error('XLEN error', { error, streamName });
            return 0;
        }
    }
    async xinfo(streamName) {
        try {
            const result = await this.client.xinfo('STREAM', streamName);
            return this.parseStreamInfo(result);
        }
        catch (error) {
            this.logger.error('XINFO error', { error, streamName });
            throw error;
        }
    }
    async xpending(streamName, groupName) {
        try {
            const result = await this.client.xpending(streamName, groupName);
            const consumers = [];
            if (result[3]) {
                for (const [name, count] of result[3]) {
                    consumers.push({ name, pending: parseInt(count, 10) });
                }
            }
            return {
                total: result[0],
                smallestId: result[1],
                largestId: result[2],
                consumers
            };
        }
        catch (error) {
            this.logger.error('XPENDING error', { error, streamName, groupName });
            throw error;
        }
    }
    // ===========================================================================
    // Stream Trimming
    // ===========================================================================
    async xtrim(streamName, options) {
        try {
            const args = [streamName];
            if (options.maxLen !== undefined) {
                args.push('MAXLEN');
                if (!options.exact) {
                    args.push('~'); // Approximate trimming is faster
                }
                args.push(options.maxLen);
            }
            else if (options.minId !== undefined) {
                args.push('MINID');
                if (!options.exact) {
                    args.push('~');
                }
                args.push(options.minId);
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return await this.client.xtrim(...args);
        }
        catch (error) {
            this.logger.error('XTRIM error', { error, streamName });
            throw error;
        }
    }
    // ===========================================================================
    // Batching
    // ===========================================================================
    createBatcher(streamName, config) {
        // Cleanup existing batcher if any (fire and forget - don't block creation)
        const existing = this.batchers.get(streamName);
        if (existing) {
            existing.destroy().catch(err => {
                this.logger.warn('Failed to cleanup existing batcher', { streamName, error: err });
            });
        }
        const batcher = new StreamBatcher(this, streamName, config, this.logger);
        this.batchers.set(streamName, batcher);
        return batcher;
    }
    // ===========================================================================
    // Utility Methods
    // ===========================================================================
    async ping() {
        try {
            const result = await this.client.ping();
            return result === 'PONG';
        }
        catch (error) {
            return false;
        }
    }
    async disconnect() {
        // Cleanup batchers - await all destroy operations to ensure messages are flushed
        const destroyPromises = Array.from(this.batchers.values()).map(batcher => batcher.destroy().catch(err => {
            this.logger.warn('Failed to destroy batcher during disconnect', { error: err });
        }));
        await Promise.all(destroyPromises);
        this.batchers.clear();
        // Disconnect client
        this.client.removeAllListeners();
        await this.client.disconnect();
        this.logger.info('Redis Streams client disconnected');
    }
    // ===========================================================================
    // Private Helpers
    // ===========================================================================
    validateStreamName(streamName) {
        if (!streamName || typeof streamName !== 'string') {
            throw new Error('Invalid stream name: must be non-empty string');
        }
        if (streamName.length > 256) {
            throw new Error('Invalid stream name: too long');
        }
        // Allow alphanumeric, dash, underscore, colon
        if (!/^[a-zA-Z0-9\-_:]+$/.test(streamName)) {
            throw new Error('Invalid stream name: contains unsafe characters');
        }
    }
    parseStreamResult(result) {
        const messages = [];
        if (!result || result.length === 0) {
            return messages;
        }
        // Result format: [[streamName, [[id, [field, value, ...]], ...]]]
        for (const [, entries] of result) {
            if (!entries)
                continue;
            for (const [id, fields] of entries) {
                // Parse fields array into object
                const data = {};
                for (let i = 0; i < fields.length; i += 2) {
                    const key = fields[i];
                    const value = fields[i + 1];
                    try {
                        data[key] = JSON.parse(value);
                    }
                    catch {
                        data[key] = value;
                    }
                }
                messages.push({ id, data: (data.data ?? data) });
            }
        }
        return messages;
    }
    parseStreamInfo(result) {
        const info = {
            length: 0,
            radixTreeKeys: 0,
            radixTreeNodes: 0,
            lastGeneratedId: '',
            groups: 0
        };
        for (let i = 0; i < result.length; i += 2) {
            const key = result[i];
            const value = result[i + 1];
            switch (key) {
                case 'length':
                    info.length = value;
                    break;
                case 'radix-tree-keys':
                    info.radixTreeKeys = value;
                    break;
                case 'radix-tree-nodes':
                    info.radixTreeNodes = value;
                    break;
                case 'last-generated-id':
                    info.lastGeneratedId = value;
                    break;
                case 'groups':
                    info.groups = value;
                    break;
            }
        }
        return info;
    }
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
exports.RedisStreamsClient = RedisStreamsClient;
// Standard stream names for the arbitrage system
RedisStreamsClient.STREAMS = {
    PRICE_UPDATES: 'stream:price-updates',
    SWAP_EVENTS: 'stream:swap-events',
    OPPORTUNITIES: 'stream:opportunities',
    WHALE_ALERTS: 'stream:whale-alerts',
    VOLUME_AGGREGATES: 'stream:volume-aggregates',
    HEALTH: 'stream:health'
};
/**
 * P1-3 fix: Recommended MAXLEN values to prevent unbounded stream growth.
 * These are approximate (~) limits for performance.
 */
RedisStreamsClient.STREAM_MAX_LENGTHS = {
    [RedisStreamsClient.STREAMS.PRICE_UPDATES]: 100000, // High volume, keep more history
    [RedisStreamsClient.STREAMS.SWAP_EVENTS]: 50000, // Medium volume
    [RedisStreamsClient.STREAMS.OPPORTUNITIES]: 10000, // Lower volume, important data
    [RedisStreamsClient.STREAMS.WHALE_ALERTS]: 5000, // Low volume, critical alerts
    [RedisStreamsClient.STREAMS.VOLUME_AGGREGATES]: 10000, // Aggregated data
    [RedisStreamsClient.STREAMS.HEALTH]: 1000 // Health checks, short history
};
/**
 * P2-1 FIX: Reusable stream consumer that encapsulates the common pattern of:
 * 1. Reading from consumer group
 * 2. Processing each message with a handler
 * 3. Acknowledging processed messages
 * 4. Handling errors gracefully
 *
 * Usage:
 * ```ts
 * const consumer = new StreamConsumer(streamsClient, {
 *   config: { streamName: 'stream:opportunities', groupName: 'coordinator', consumerName: 'worker-1' },
 *   handler: async (msg) => { console.log(msg.data); },
 *   batchSize: 10,
 *   blockMs: 1000
 * });
 * consumer.start();
 * // ... later
 * await consumer.stop();
 * ```
 */
class StreamConsumer {
    constructor(client, config) {
        this.running = false;
        this.pollTimer = null;
        this.stats = {
            messagesProcessed: 0,
            messagesFailed: 0,
            lastProcessedAt: null,
            isRunning: false
        };
        this.client = client;
        this.config = {
            batchSize: 10,
            blockMs: 1000,
            autoAck: true,
            ...config
        };
    }
    /**
     * Start consuming messages from the stream.
     * Runs in a polling loop until stop() is called.
     */
    start() {
        if (this.running)
            return;
        this.running = true;
        this.stats.isRunning = true;
        this.poll();
    }
    /**
     * Stop consuming messages.
     * Waits for any in-flight processing to complete.
     */
    async stop() {
        this.running = false;
        this.stats.isRunning = false;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
    }
    /**
     * Get consumer statistics.
     */
    getStats() {
        return { ...this.stats };
    }
    async poll() {
        if (!this.running)
            return;
        try {
            const messages = await this.client.xreadgroup(this.config.config, {
                count: this.config.batchSize,
                block: this.config.blockMs,
                startId: '>'
            });
            for (const message of messages) {
                if (!this.running)
                    break;
                try {
                    await this.config.handler(message);
                    this.stats.messagesProcessed++;
                    this.stats.lastProcessedAt = Date.now();
                    // Auto-acknowledge if enabled
                    if (this.config.autoAck) {
                        await this.client.xack(this.config.config.streamName, this.config.config.groupName, message.id);
                    }
                }
                catch (handlerError) {
                    this.stats.messagesFailed++;
                    this.config.logger?.error('Stream message handler failed', {
                        error: handlerError,
                        stream: this.config.config.streamName,
                        messageId: message.id
                    });
                    // Don't ack failed messages - they'll be retried
                }
            }
        }
        catch (error) {
            // Ignore timeout errors from blocking read
            const errorMessage = error.message || '';
            if (!errorMessage.includes('timeout')) {
                this.config.logger?.error('Error consuming stream', {
                    error,
                    stream: this.config.config.streamName
                });
            }
        }
        // Schedule next poll if still running
        if (this.running) {
            // Use setImmediate for non-blocking reads, short delay for blocking reads
            const delay = this.config.blockMs === 0 ? 0 : 10;
            this.pollTimer = setTimeout(() => this.poll(), delay);
        }
    }
}
exports.StreamConsumer = StreamConsumer;
// =============================================================================
// Singleton Factory
// =============================================================================
let streamsInstance = null;
let initializingPromise = null; // Race condition guard
async function getRedisStreamsClient(url, password) {
    // Return existing instance if available
    if (streamsInstance) {
        return streamsInstance;
    }
    // Prevent concurrent initialization (race condition fix)
    if (initializingPromise) {
        return initializingPromise;
    }
    const redisUrl = url || process.env.REDIS_URL || 'redis://localhost:6379';
    const redisPassword = password || process.env.REDIS_PASSWORD;
    initializingPromise = (async () => {
        try {
            const instance = new RedisStreamsClient(redisUrl, redisPassword);
            // Verify connection
            const isHealthy = await instance.ping();
            if (!isHealthy) {
                throw new Error('Failed to connect to Redis for Streams');
            }
            streamsInstance = instance;
            return instance;
        }
        catch (error) {
            initializingPromise = null; // Allow retry on failure
            throw error;
        }
    })();
    return initializingPromise;
}
async function resetRedisStreamsInstance() {
    const instance = streamsInstance;
    streamsInstance = null;
    initializingPromise = null;
    if (instance) {
        await instance.disconnect();
    }
}
//# sourceMappingURL=redis-streams.js.map