"use strict";
/**
 * Redis Streams Client Tests
 *
 * TDD Test Suite for Redis Streams implementation
 * Tests: XADD, XREAD, XREADGROUP, XACK, Consumer Groups, Batching
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 */
Object.defineProperty(exports, "__esModule", { value: true });
const globals_1 = require("@jest/globals");
const redis_streams_1 = require("./redis-streams");
// Mock ioredis
globals_1.jest.mock('ioredis', () => {
    const mockRedis = {
        xadd: globals_1.jest.fn(),
        xread: globals_1.jest.fn(),
        xreadgroup: globals_1.jest.fn(),
        xack: globals_1.jest.fn(),
        xgroup: globals_1.jest.fn(),
        xinfo: globals_1.jest.fn(),
        xlen: globals_1.jest.fn(),
        xtrim: globals_1.jest.fn(),
        xpending: globals_1.jest.fn(),
        xclaim: globals_1.jest.fn(),
        ping: globals_1.jest.fn().mockResolvedValue('PONG'),
        disconnect: globals_1.jest.fn().mockResolvedValue(undefined),
        on: globals_1.jest.fn(),
        removeAllListeners: globals_1.jest.fn(),
    };
    return globals_1.jest.fn(() => mockRedis);
});
(0, globals_1.describe)('RedisStreamsClient', () => {
    let client;
    let mockRedis;
    (0, globals_1.beforeEach)(() => {
        globals_1.jest.clearAllMocks();
        client = new redis_streams_1.RedisStreamsClient('redis://localhost:6379');
        // Get the mock instance
        const Redis = require('ioredis');
        mockRedis = new Redis();
    });
    (0, globals_1.afterEach)(async () => {
        await client.disconnect();
    });
    (0, globals_1.describe)('XADD - Adding messages to stream', () => {
        (0, globals_1.it)('should add a message to a stream and return message ID', async () => {
            const streamName = 'stream:price-updates';
            const message = { type: 'price', chain: 'bsc', price: '100.5' };
            const expectedId = '1234567890-0';
            mockRedis.xadd.mockResolvedValue(expectedId);
            const messageId = await client.xadd(streamName, message);
            (0, globals_1.expect)(messageId).toBe(expectedId);
            (0, globals_1.expect)(mockRedis.xadd).toHaveBeenCalledWith(streamName, '*', globals_1.expect.any(String), globals_1.expect.any(String));
        });
        (0, globals_1.it)('should add message with custom ID', async () => {
            const streamName = 'stream:test';
            const message = { data: 'test' };
            const customId = '1234567890-5';
            mockRedis.xadd.mockResolvedValue(customId);
            const messageId = await client.xadd(streamName, message, customId);
            (0, globals_1.expect)(messageId).toBe(customId);
        });
        (0, globals_1.it)('should validate stream name', async () => {
            const invalidStreamName = 'invalid stream name!@#';
            const message = { data: 'test' };
            await (0, globals_1.expect)(client.xadd(invalidStreamName, message))
                .rejects
                .toThrow('Invalid stream name');
        });
        (0, globals_1.it)('should serialize complex objects', async () => {
            const streamName = 'stream:test';
            const message = {
                type: 'price_update',
                data: {
                    chain: 'bsc',
                    dex: 'pancake',
                    pair: 'WBNB_USDT',
                    price: 300.5,
                    timestamp: Date.now()
                }
            };
            mockRedis.xadd.mockResolvedValue('1234-0');
            await client.xadd(streamName, message);
            (0, globals_1.expect)(mockRedis.xadd).toHaveBeenCalled();
        });
    });
    (0, globals_1.describe)('XREAD - Reading from stream', () => {
        (0, globals_1.it)('should read messages from stream starting from ID', async () => {
            const streamName = 'stream:test';
            const messages = [
                { id: '1234-0', data: { type: 'test', value: 1 } },
                { id: '1234-1', data: { type: 'test', value: 2 } }
            ];
            mockRedis.xread.mockResolvedValue([
                [streamName, [
                        ['1234-0', ['data', JSON.stringify({ type: 'test', value: 1 })]],
                        ['1234-1', ['data', JSON.stringify({ type: 'test', value: 2 })]]
                    ]]
            ]);
            const result = await client.xread(streamName, '0');
            (0, globals_1.expect)(result).toHaveLength(2);
            (0, globals_1.expect)(result[0].id).toBe('1234-0');
            (0, globals_1.expect)(result[1].id).toBe('1234-1');
        });
        (0, globals_1.it)('should return empty array when no messages', async () => {
            mockRedis.xread.mockResolvedValue(null);
            const result = await client.xread('stream:test', '0');
            (0, globals_1.expect)(result).toEqual([]);
        });
        (0, globals_1.it)('should support COUNT option', async () => {
            const streamName = 'stream:test';
            mockRedis.xread.mockResolvedValue(null);
            await client.xread(streamName, '0', { count: 10 });
            (0, globals_1.expect)(mockRedis.xread).toHaveBeenCalledWith('COUNT', 10, 'STREAMS', streamName, '0');
        });
        (0, globals_1.it)('should support BLOCK option for blocking read', async () => {
            const streamName = 'stream:test';
            mockRedis.xread.mockResolvedValue(null);
            await client.xread(streamName, '$', { block: 1000 });
            (0, globals_1.expect)(mockRedis.xread).toHaveBeenCalledWith('BLOCK', 1000, 'STREAMS', streamName, '$');
        });
    });
    (0, globals_1.describe)('Consumer Groups', () => {
        (0, globals_1.it)('should create a consumer group', async () => {
            const config = {
                streamName: 'stream:test',
                groupName: 'arbitrage-detectors',
                consumerName: 'detector-1'
            };
            mockRedis.xgroup.mockResolvedValue('OK');
            await client.createConsumerGroup(config);
            (0, globals_1.expect)(mockRedis.xgroup).toHaveBeenCalledWith('CREATE', config.streamName, config.groupName, '$', 'MKSTREAM');
        });
        (0, globals_1.it)('should handle group already exists error gracefully', async () => {
            const config = {
                streamName: 'stream:test',
                groupName: 'existing-group',
                consumerName: 'consumer-1'
            };
            mockRedis.xgroup.mockRejectedValue(new Error('BUSYGROUP Consumer Group name already exists'));
            // Should not throw
            await (0, globals_1.expect)(client.createConsumerGroup(config)).resolves.not.toThrow();
        });
        (0, globals_1.it)('should create group starting from specific ID', async () => {
            const config = {
                streamName: 'stream:test',
                groupName: 'group-1',
                consumerName: 'consumer-1',
                startId: '0' // Start from beginning
            };
            mockRedis.xgroup.mockResolvedValue('OK');
            await client.createConsumerGroup(config);
            (0, globals_1.expect)(mockRedis.xgroup).toHaveBeenCalledWith('CREATE', config.streamName, config.groupName, '0', 'MKSTREAM');
        });
    });
    (0, globals_1.describe)('XREADGROUP - Consumer group reads', () => {
        (0, globals_1.it)('should read new messages for consumer group', async () => {
            const config = {
                streamName: 'stream:test',
                groupName: 'group-1',
                consumerName: 'consumer-1'
            };
            mockRedis.xreadgroup.mockResolvedValue([
                ['stream:test', [
                        ['1234-0', ['data', JSON.stringify({ value: 'test' })]]
                    ]]
            ]);
            const messages = await client.xreadgroup(config);
            (0, globals_1.expect)(messages).toHaveLength(1);
            (0, globals_1.expect)(messages[0].id).toBe('1234-0');
            (0, globals_1.expect)(mockRedis.xreadgroup).toHaveBeenCalledWith('GROUP', config.groupName, config.consumerName, 'STREAMS', config.streamName, '>');
        });
        (0, globals_1.it)('should support COUNT option in XREADGROUP', async () => {
            const config = {
                streamName: 'stream:test',
                groupName: 'group-1',
                consumerName: 'consumer-1'
            };
            mockRedis.xreadgroup.mockResolvedValue(null);
            await client.xreadgroup(config, { count: 50 });
            (0, globals_1.expect)(mockRedis.xreadgroup).toHaveBeenCalledWith('GROUP', config.groupName, config.consumerName, 'COUNT', 50, 'STREAMS', config.streamName, '>');
        });
        (0, globals_1.it)('should support BLOCK option for blocking group read', async () => {
            const config = {
                streamName: 'stream:test',
                groupName: 'group-1',
                consumerName: 'consumer-1'
            };
            mockRedis.xreadgroup.mockResolvedValue(null);
            await client.xreadgroup(config, { block: 5000 });
            (0, globals_1.expect)(mockRedis.xreadgroup).toHaveBeenCalledWith('GROUP', config.groupName, config.consumerName, 'BLOCK', 5000, 'STREAMS', config.streamName, '>');
        });
        (0, globals_1.it)('should read pending messages when specifying ID', async () => {
            const config = {
                streamName: 'stream:test',
                groupName: 'group-1',
                consumerName: 'consumer-1'
            };
            mockRedis.xreadgroup.mockResolvedValue(null);
            await client.xreadgroup(config, { startId: '0' }); // Read pending from beginning
            (0, globals_1.expect)(mockRedis.xreadgroup).toHaveBeenCalledWith('GROUP', config.groupName, config.consumerName, 'STREAMS', config.streamName, '0');
        });
    });
    (0, globals_1.describe)('XACK - Acknowledging messages', () => {
        (0, globals_1.it)('should acknowledge single message', async () => {
            const streamName = 'stream:test';
            const groupName = 'group-1';
            const messageId = '1234-0';
            mockRedis.xack.mockResolvedValue(1);
            const acknowledged = await client.xack(streamName, groupName, messageId);
            (0, globals_1.expect)(acknowledged).toBe(1);
            (0, globals_1.expect)(mockRedis.xack).toHaveBeenCalledWith(streamName, groupName, messageId);
        });
        (0, globals_1.it)('should acknowledge multiple messages', async () => {
            const streamName = 'stream:test';
            const groupName = 'group-1';
            const messageIds = ['1234-0', '1234-1', '1234-2'];
            mockRedis.xack.mockResolvedValue(3);
            const acknowledged = await client.xack(streamName, groupName, ...messageIds);
            (0, globals_1.expect)(acknowledged).toBe(3);
            (0, globals_1.expect)(mockRedis.xack).toHaveBeenCalledWith(streamName, groupName, ...messageIds);
        });
        (0, globals_1.it)('should return 0 when acknowledging non-existent message', async () => {
            mockRedis.xack.mockResolvedValue(0);
            const acknowledged = await client.xack('stream:test', 'group-1', 'nonexistent-id');
            (0, globals_1.expect)(acknowledged).toBe(0);
        });
    });
    (0, globals_1.describe)('Stream Information', () => {
        (0, globals_1.it)('should get stream length', async () => {
            mockRedis.xlen.mockResolvedValue(100);
            const length = await client.xlen('stream:test');
            (0, globals_1.expect)(length).toBe(100);
        });
        (0, globals_1.it)('should get stream info', async () => {
            mockRedis.xinfo.mockResolvedValue([
                'length', 100,
                'radix-tree-keys', 1,
                'radix-tree-nodes', 2,
                'last-generated-id', '1234-0',
                'groups', 2
            ]);
            const info = await client.xinfo('stream:test');
            (0, globals_1.expect)(info.length).toBe(100);
            (0, globals_1.expect)(info.lastGeneratedId).toBe('1234-0');
            (0, globals_1.expect)(info.groups).toBe(2);
        });
        (0, globals_1.it)('should get pending messages info', async () => {
            mockRedis.xpending.mockResolvedValue([
                5, // Total pending
                '1234-0', // Smallest ID
                '1234-4', // Largest ID
                [['consumer-1', '3'], ['consumer-2', '2']] // Consumer pending counts
            ]);
            const pending = await client.xpending('stream:test', 'group-1');
            (0, globals_1.expect)(pending.total).toBe(5);
            (0, globals_1.expect)(pending.smallestId).toBe('1234-0');
            (0, globals_1.expect)(pending.largestId).toBe('1234-4');
        });
    });
    (0, globals_1.describe)('Stream Trimming', () => {
        (0, globals_1.it)('should trim stream by max length', async () => {
            mockRedis.xtrim.mockResolvedValue(50);
            const trimmed = await client.xtrim('stream:test', { maxLen: 1000 });
            (0, globals_1.expect)(trimmed).toBe(50);
            (0, globals_1.expect)(mockRedis.xtrim).toHaveBeenCalledWith('stream:test', 'MAXLEN', '~', 1000);
        });
        (0, globals_1.it)('should trim stream by min ID', async () => {
            mockRedis.xtrim.mockResolvedValue(100);
            const trimmed = await client.xtrim('stream:test', { minId: '1234-0' });
            (0, globals_1.expect)(trimmed).toBe(100);
            (0, globals_1.expect)(mockRedis.xtrim).toHaveBeenCalledWith('stream:test', 'MINID', '~', '1234-0');
        });
    });
    (0, globals_1.describe)('Batching', () => {
        (0, globals_1.it)('should batch multiple messages before sending', async () => {
            mockRedis.xadd.mockResolvedValue('1234-0');
            const batcher = client.createBatcher('stream:test', {
                maxBatchSize: 3,
                maxWaitMs: 1000
            });
            // Add messages without immediately sending
            batcher.add({ type: 'price', value: 1 });
            batcher.add({ type: 'price', value: 2 });
            // Should not have sent yet (batch size not reached)
            (0, globals_1.expect)(mockRedis.xadd).not.toHaveBeenCalled();
            // Add third message to trigger batch
            batcher.add({ type: 'price', value: 3 });
            // Wait for batch to be processed
            await new Promise(resolve => setTimeout(resolve, 10));
            // Should have sent one batched message
            (0, globals_1.expect)(mockRedis.xadd).toHaveBeenCalledTimes(1);
            batcher.destroy();
        });
        (0, globals_1.it)('should flush batch on timeout', async () => {
            mockRedis.xadd.mockResolvedValue('1234-0');
            const batcher = client.createBatcher('stream:test', {
                maxBatchSize: 100,
                maxWaitMs: 50
            });
            batcher.add({ type: 'price', value: 1 });
            // Wait for timeout
            await new Promise(resolve => setTimeout(resolve, 100));
            (0, globals_1.expect)(mockRedis.xadd).toHaveBeenCalled();
            batcher.destroy();
        });
        (0, globals_1.it)('should provide batch statistics', async () => {
            mockRedis.xadd.mockResolvedValue('1234-0');
            const batcher = client.createBatcher('stream:test', {
                maxBatchSize: 2,
                maxWaitMs: 1000
            });
            batcher.add({ value: 1 });
            batcher.add({ value: 2 });
            await new Promise(resolve => setTimeout(resolve, 10));
            const stats = batcher.getStats();
            (0, globals_1.expect)(stats.totalMessagesQueued).toBeDefined();
            (0, globals_1.expect)(stats.currentQueueSize).toBeDefined();
            (0, globals_1.expect)(stats.batchesSent).toBeGreaterThanOrEqual(1);
            (0, globals_1.expect)(stats.compressionRatio).toBeDefined();
            batcher.destroy();
        });
    });
    (0, globals_1.describe)('Error Handling', () => {
        (0, globals_1.it)('should handle connection errors gracefully', async () => {
            mockRedis.xadd.mockRejectedValue(new Error('Connection refused'));
            await (0, globals_1.expect)(client.xadd('stream:test', { data: 'test' }))
                .rejects
                .toThrow('Connection refused');
        });
        (0, globals_1.it)('should retry on transient failures', async () => {
            // First call fails, second succeeds
            mockRedis.xadd
                .mockRejectedValueOnce(new Error('BUSY'))
                .mockResolvedValueOnce('1234-0');
            const messageId = await client.xadd('stream:test', { data: 'test' }, undefined, { retry: true });
            (0, globals_1.expect)(messageId).toBe('1234-0');
            (0, globals_1.expect)(mockRedis.xadd).toHaveBeenCalledTimes(2);
        });
    });
    (0, globals_1.describe)('Health Check', () => {
        (0, globals_1.it)('should return true when Redis is healthy', async () => {
            mockRedis.ping.mockResolvedValue('PONG');
            const isHealthy = await client.ping();
            (0, globals_1.expect)(isHealthy).toBe(true);
        });
        (0, globals_1.it)('should return false when Redis is unhealthy', async () => {
            mockRedis.ping.mockRejectedValue(new Error('Connection lost'));
            const isHealthy = await client.ping();
            (0, globals_1.expect)(isHealthy).toBe(false);
        });
    });
    (0, globals_1.describe)('Stream Constants', () => {
        (0, globals_1.it)('should export standard stream names', () => {
            (0, globals_1.expect)(redis_streams_1.RedisStreamsClient.STREAMS.PRICE_UPDATES).toBe('stream:price-updates');
            (0, globals_1.expect)(redis_streams_1.RedisStreamsClient.STREAMS.SWAP_EVENTS).toBe('stream:swap-events');
            (0, globals_1.expect)(redis_streams_1.RedisStreamsClient.STREAMS.OPPORTUNITIES).toBe('stream:opportunities');
            (0, globals_1.expect)(redis_streams_1.RedisStreamsClient.STREAMS.WHALE_ALERTS).toBe('stream:whale-alerts');
            (0, globals_1.expect)(redis_streams_1.RedisStreamsClient.STREAMS.VOLUME_AGGREGATES).toBe('stream:volume-aggregates');
            (0, globals_1.expect)(redis_streams_1.RedisStreamsClient.STREAMS.HEALTH).toBe('stream:health');
        });
    });
});
//# sourceMappingURL=redis-streams.test.js.map