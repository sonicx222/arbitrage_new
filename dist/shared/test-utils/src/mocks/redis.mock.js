"use strict";
/**
 * Unified Redis Mock Implementation
 *
 * Single source of truth for Redis mocking across all tests.
 * Supports both regular Redis operations and Redis Streams.
 *
 * @see docs/TEST_ARCHITECTURE.md
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisMock = void 0;
exports.createRedisMock = createRedisMock;
exports.createIoredisMockModule = createIoredisMockModule;
exports.setupRedisMock = setupRedisMock;
const globals_1 = require("@jest/globals");
/**
 * Comprehensive Redis mock that supports:
 * - Basic key-value operations (get, set, del, etc.)
 * - Hash operations (hset, hget, hgetall)
 * - List operations (lpush, lrange, ltrim)
 * - Stream operations (xadd, xread, xreadgroup, xack)
 * - Pub/Sub operations (publish, subscribe)
 * - Connection lifecycle (ping, disconnect)
 */
class RedisMock {
    constructor(options = {}) {
        this.data = new Map();
        this.streams = new Map();
        this.consumerGroups = new Map();
        this.pubSubChannels = new Map();
        this.operations = [];
        this.connected = true;
        this.options = options;
        if (options.initialData) {
            this.data = new Map(options.initialData);
        }
    }
    // =========================================================================
    // Basic Key-Value Operations
    // =========================================================================
    async get(key) {
        await this.simulateLatency();
        this.trackOperation('get', [key]);
        this.checkFailure('get');
        const value = this.data.get(key);
        return value !== undefined ? String(value) : null;
    }
    async set(key, value, ...args) {
        await this.simulateLatency();
        this.trackOperation('set', [key, value, ...args]);
        this.checkFailure('set');
        this.data.set(key, value);
        return 'OK';
    }
    async setex(key, ttl, value) {
        await this.simulateLatency();
        this.trackOperation('setex', [key, ttl, value]);
        this.checkFailure('setex');
        this.data.set(key, value);
        // Note: TTL not simulated in mock
        return 'OK';
    }
    async del(...keys) {
        await this.simulateLatency();
        this.trackOperation('del', keys);
        this.checkFailure('del');
        let deleted = 0;
        for (const key of keys) {
            if (this.data.delete(key))
                deleted++;
        }
        return deleted;
    }
    async exists(key) {
        await this.simulateLatency();
        this.trackOperation('exists', [key]);
        this.checkFailure('exists');
        return this.data.has(key) ? 1 : 0;
    }
    async keys(pattern) {
        await this.simulateLatency();
        this.trackOperation('keys', [pattern]);
        this.checkFailure('keys');
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        return Array.from(this.data.keys()).filter(key => regex.test(key));
    }
    async expire(key, ttl) {
        await this.simulateLatency();
        this.trackOperation('expire', [key, ttl]);
        return this.data.has(key) ? 1 : 0;
    }
    // =========================================================================
    // Hash Operations
    // =========================================================================
    async hset(key, field, value) {
        await this.simulateLatency();
        this.trackOperation('hset', [key, field, value]);
        this.checkFailure('hset');
        const hash = this.data.get(key) || {};
        const isNew = !(field in hash);
        hash[field] = value;
        this.data.set(key, hash);
        return isNew ? 1 : 0;
    }
    async hget(key, field) {
        await this.simulateLatency();
        this.trackOperation('hget', [key, field]);
        this.checkFailure('hget');
        const hash = this.data.get(key);
        return hash?.[field] ?? null;
    }
    async hgetall(key) {
        await this.simulateLatency();
        this.trackOperation('hgetall', [key]);
        this.checkFailure('hgetall');
        return this.data.get(key) || {};
    }
    async hdel(key, ...fields) {
        await this.simulateLatency();
        this.trackOperation('hdel', [key, ...fields]);
        this.checkFailure('hdel');
        const hash = this.data.get(key);
        if (!hash)
            return 0;
        let deleted = 0;
        for (const field of fields) {
            if (field in hash) {
                delete hash[field];
                deleted++;
            }
        }
        return deleted;
    }
    // =========================================================================
    // List Operations
    // =========================================================================
    async lpush(key, ...values) {
        await this.simulateLatency();
        this.trackOperation('lpush', [key, ...values]);
        this.checkFailure('lpush');
        const list = this.data.get(key) || [];
        list.unshift(...values);
        this.data.set(key, list);
        return list.length;
    }
    async rpush(key, ...values) {
        await this.simulateLatency();
        this.trackOperation('rpush', [key, ...values]);
        this.checkFailure('rpush');
        const list = this.data.get(key) || [];
        list.push(...values);
        this.data.set(key, list);
        return list.length;
    }
    async lrange(key, start, stop) {
        await this.simulateLatency();
        this.trackOperation('lrange', [key, start, stop]);
        this.checkFailure('lrange');
        const list = this.data.get(key) || [];
        const end = stop < 0 ? list.length + stop + 1 : stop + 1;
        return list.slice(start, end);
    }
    async ltrim(key, start, stop) {
        await this.simulateLatency();
        this.trackOperation('ltrim', [key, start, stop]);
        this.checkFailure('ltrim');
        const list = this.data.get(key) || [];
        const end = stop < 0 ? list.length + stop + 1 : stop + 1;
        this.data.set(key, list.slice(start, end));
        return 'OK';
    }
    async llen(key) {
        await this.simulateLatency();
        this.trackOperation('llen', [key]);
        const list = this.data.get(key) || [];
        return list.length;
    }
    async rpop(key) {
        await this.simulateLatency();
        this.trackOperation('rpop', [key]);
        const list = this.data.get(key) || [];
        return list.pop() ?? null;
    }
    // =========================================================================
    // Stream Operations (Redis Streams)
    // =========================================================================
    async xadd(stream, id, ...fieldValues) {
        await this.simulateLatency();
        this.trackOperation('xadd', [stream, id, ...fieldValues]);
        this.checkFailure('xadd');
        const streamData = this.streams.get(stream) || [];
        const messageId = id === '*' ? `${Date.now()}-${streamData.length}` : id;
        const fields = {};
        for (let i = 0; i < fieldValues.length; i += 2) {
            fields[fieldValues[i]] = fieldValues[i + 1];
        }
        streamData.push({ id: messageId, fields });
        this.streams.set(stream, streamData);
        return messageId;
    }
    async xread(...args) {
        await this.simulateLatency();
        this.trackOperation('xread', args);
        this.checkFailure('xread');
        const streamsIdx = args.indexOf('STREAMS');
        if (streamsIdx === -1)
            return null;
        const streamName = args[streamsIdx + 1];
        const startId = args[streamsIdx + 2];
        const streamData = this.streams.get(streamName) || [];
        if (streamData.length === 0)
            return null;
        const messages = streamData
            .filter(msg => {
            if (startId === '0' || startId === '0-0')
                return true;
            if (startId === '$')
                return false;
            return msg.id > startId;
        })
            .map(msg => [msg.id, Object.entries(msg.fields).flat()]);
        if (messages.length === 0)
            return null;
        return [[streamName, messages]];
    }
    async xreadgroup(...args) {
        await this.simulateLatency();
        this.trackOperation('xreadgroup', args);
        this.checkFailure('xreadgroup');
        // Parse GROUP name consumer STREAMS stream id
        const groupIdx = args.indexOf('GROUP');
        if (groupIdx === -1)
            return null;
        const groupName = args[groupIdx + 1];
        const consumerName = args[groupIdx + 2];
        const streamsIdx = args.indexOf('STREAMS');
        const streamName = args[streamsIdx + 1];
        const startId = args[streamsIdx + 2];
        const streamData = this.streams.get(streamName) || [];
        if (streamData.length === 0)
            return null;
        const groups = this.consumerGroups.get(streamName);
        const group = groups?.get(groupName);
        const lastId = group?.lastDeliveredId || '0-0';
        const messages = streamData
            .filter(msg => {
            if (startId === '>')
                return msg.id > lastId;
            return msg.id >= startId;
        })
            .slice(0, 10) // Limit for mock
            .map(msg => [msg.id, Object.entries(msg.fields).flat()]);
        if (messages.length === 0)
            return null;
        // Update last delivered
        if (group && messages.length > 0) {
            group.lastDeliveredId = messages[messages.length - 1][0];
        }
        return [[streamName, messages]];
    }
    async xack(stream, group, ...ids) {
        await this.simulateLatency();
        this.trackOperation('xack', [stream, group, ...ids]);
        this.checkFailure('xack');
        return ids.length;
    }
    async xgroup(...args) {
        await this.simulateLatency();
        this.trackOperation('xgroup', args);
        this.checkFailure('xgroup');
        const command = args[0];
        const stream = args[1];
        const group = args[2];
        if (command === 'CREATE') {
            const groups = this.consumerGroups.get(stream) || new Map();
            if (groups.has(group)) {
                throw new Error('BUSYGROUP Consumer Group name already exists');
            }
            groups.set(group, { lastDeliveredId: '0-0' });
            this.consumerGroups.set(stream, groups);
        }
        return 'OK';
    }
    async xlen(stream) {
        await this.simulateLatency();
        this.trackOperation('xlen', [stream]);
        return (this.streams.get(stream) || []).length;
    }
    async xinfo(...args) {
        await this.simulateLatency();
        this.trackOperation('xinfo', args);
        const command = args[0];
        const stream = args[1];
        if (command === 'STREAM') {
            const streamData = this.streams.get(stream) || [];
            return [
                'length', streamData.length,
                'radix-tree-keys', 1,
                'radix-tree-nodes', 2,
                'last-generated-id', streamData.length > 0 ? streamData[streamData.length - 1].id : '0-0',
                'groups', this.consumerGroups.get(stream)?.size || 0
            ];
        }
        return [];
    }
    async xtrim(stream, ...args) {
        await this.simulateLatency();
        this.trackOperation('xtrim', [stream, ...args]);
        return 0;
    }
    async xpending(stream, group) {
        await this.simulateLatency();
        this.trackOperation('xpending', [stream, group]);
        return [0, null, null, []];
    }
    // =========================================================================
    // Pub/Sub Operations
    // =========================================================================
    async publish(channel, message) {
        await this.simulateLatency();
        this.trackOperation('publish', [channel, message]);
        this.checkFailure('publish');
        const subscribers = this.pubSubChannels.get(channel);
        if (subscribers) {
            subscribers.forEach(cb => {
                try {
                    cb(channel, message);
                }
                catch {
                    // Ignore callback errors in mock
                }
            });
            return subscribers.size;
        }
        return 0;
    }
    async subscribe(channel, callback) {
        await this.simulateLatency();
        this.trackOperation('subscribe', [channel]);
        if (!this.pubSubChannels.has(channel)) {
            this.pubSubChannels.set(channel, new Set());
        }
        this.pubSubChannels.get(channel).add(callback);
    }
    async unsubscribe(channel) {
        await this.simulateLatency();
        this.trackOperation('unsubscribe', [channel]);
        this.pubSubChannels.delete(channel);
    }
    // =========================================================================
    // Connection Lifecycle
    // =========================================================================
    async ping() {
        await this.simulateLatency();
        this.trackOperation('ping', []);
        this.checkFailure('ping');
        return 'PONG';
    }
    async disconnect() {
        await this.simulateLatency();
        this.trackOperation('disconnect', []);
        this.connected = false;
        this.data.clear();
        this.streams.clear();
        this.consumerGroups.clear();
        this.pubSubChannels.clear();
    }
    async quit() {
        await this.disconnect();
        return 'OK';
    }
    // Event emitter interface (for compatibility)
    on(event, callback) {
        return this;
    }
    removeAllListeners() {
        return this;
    }
    // =========================================================================
    // Test Utilities
    // =========================================================================
    /** Get copy of all stored data */
    getData() {
        return new Map(this.data);
    }
    /** Get copy of all stream data */
    getStreams() {
        return new Map(this.streams);
    }
    /** Get stream messages for a specific stream */
    getStreamMessages(stream) {
        return [...(this.streams.get(stream) || [])];
    }
    /** Get all recorded operations */
    getOperations() {
        return [...this.operations];
    }
    /** Get operations for a specific command */
    getOperationsForCommand(command) {
        return this.operations.filter(op => op.command === command);
    }
    /** Check if mock is connected */
    isConnected() {
        return this.connected;
    }
    /** Clear all data and reset mock state */
    clear() {
        this.data.clear();
        this.streams.clear();
        this.consumerGroups.clear();
        this.pubSubChannels.clear();
        this.operations = [];
        this.connected = true;
    }
    /** Simulate failure for next operation */
    setFailure(enabled) {
        this.options.simulateFailures = enabled;
    }
    /** Set latency for operations */
    setLatency(ms) {
        this.options.latencyMs = ms;
    }
    // =========================================================================
    // Private Helpers
    // =========================================================================
    async simulateLatency() {
        if (this.options.latencyMs && this.options.latencyMs > 0) {
            await new Promise(resolve => setTimeout(resolve, this.options.latencyMs));
        }
    }
    checkFailure(operation) {
        if (this.options.simulateFailures) {
            throw new Error(`Simulated Redis failure on ${operation}`);
        }
        if (!this.connected) {
            throw new Error('Redis client is not connected');
        }
    }
    trackOperation(command, args) {
        if (this.options.trackOperations) {
            this.operations.push({
                command,
                args,
                timestamp: Date.now()
            });
        }
    }
}
exports.RedisMock = RedisMock;
// =========================================================================
// Factory Functions
// =========================================================================
/** Create a new Redis mock instance */
function createRedisMock(options) {
    return new RedisMock(options);
}
/** Create Jest mock module for ioredis */
function createIoredisMockModule(mock) {
    const instance = mock ?? createRedisMock();
    return globals_1.jest.fn(() => instance);
}
/** Setup ioredis mock - call at top of test file */
function setupRedisMock(mock) {
    const instance = mock ?? createRedisMock({ trackOperations: true });
    const MockRedis = globals_1.jest.fn(() => instance);
    // Note: Jest mock must be called before importing modules that use Redis
    // This function returns the mock for manual setup in jest.mock()
    return { mock: instance, MockRedis };
}
//# sourceMappingURL=redis.mock.js.map