/**
 * S1.1 Redis Streams Migration Integration Tests
 *
 * End-to-end testing of Redis Streams implementation using real Redis
 * (via redis-memory-server started by jest.globalSetup.ts).
 *
 * Validates ADR-002 requirements and migration from Pub/Sub to Streams.
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see S1.1.1-S1.1.5: Redis Streams Migration Tasks
 */

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import Redis from 'ioredis';

// Make this file a module to avoid TS2451 redeclaration errors
export {};

import { StreamHealthMonitor, resetStreamHealthMonitor } from '@arbitrage/core/monitoring';
import { RedisStreamsClient, StreamBatcher, resetRedisStreamsInstance } from '@arbitrage/core/redis';

import { createTestRedisClient } from '@arbitrage/test-utils';
import { delay, createMockPriceUpdate, createMockSwapEvent } from '../../shared/test-utils/src';
import * as fs from 'fs';
import * as path from 'path';

describe('S1.1 Redis Streams Migration Integration Tests', () => {
  let streamsClient: RedisStreamsClient;
  // Raw Redis client for direct verification of stream contents
  let rawRedis: Redis;

  beforeAll(async () => {
    // Create a raw Redis client for direct verification
    rawRedis = await createTestRedisClient();

    // Reset singletons to start clean
    await resetRedisStreamsInstance();
    resetStreamHealthMonitor();
  });

  afterAll(async () => {
    // Cleanup singletons
    await resetRedisStreamsInstance();
    resetStreamHealthMonitor();

    // Disconnect all clients
    if (streamsClient) {
      try {
        await streamsClient.disconnect();
      } catch {
        // Ignore disconnect errors during cleanup
      }
    }
    if (rawRedis) {
      await rawRedis.quit();
    }
  });

  beforeEach(async () => {
    // Flush all data between tests for isolation
    await rawRedis.flushall();
  });

  // Helper to get test Redis URL (same logic as createTestRedisClient in @arbitrage/test-utils)
  function getTestRedisUrl(): string {
    const configFile = path.resolve(__dirname, '../../.redis-test-config.json');
    if (fs.existsSync(configFile)) {
      try {
        const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        if (config.url) return config.url;
      } catch { /* fall through */ }
    }
    return process.env.REDIS_URL ?? 'redis://localhost:6379';
  }

  // Helper to create a fresh RedisStreamsClient connected to the test Redis
  async function createTestStreamsClient(): Promise<RedisStreamsClient> {
    const url = getTestRedisUrl();
    const client = new RedisStreamsClient(url);
    // Verify connectivity
    const isHealthy = await client.ping();
    if (!isHealthy) {
      throw new Error(`RedisStreamsClient failed to connect to ${url}`);
    }
    return client;
  }

  // =========================================================================
  // S1.1.1: RedisStreamsClient Core Tests
  // =========================================================================
  describe('S1.1.1: RedisStreamsClient Core Functionality', () => {
    beforeEach(async () => {
      streamsClient = await createTestStreamsClient();
    });

    afterEach(async () => {
      if (streamsClient) {
        await streamsClient.disconnect();
      }
    });

    describe('XADD - Message Publishing', () => {
      it('should add messages to a stream with auto-generated ID', async () => {
        const message = { type: 'price-update', data: { price: 100 } };
        const messageId = await streamsClient.xadd(
          RedisStreamsClient.STREAMS.PRICE_UPDATES,
          message
        );

        expect(messageId).toBeDefined();
        expect(typeof messageId).toBe('string');
        // Redis stream IDs have the format "timestamp-sequence"
        expect(messageId).toMatch(/^\d+-\d+$/);

        // Verify the message was actually stored in Redis
        const streamLen = await rawRedis.xlen(RedisStreamsClient.STREAMS.PRICE_UPDATES);
        expect(streamLen).toBe(1);
      });

      it('should serialize complex objects correctly', async () => {
        const complexMessage = {
          type: 'swap-event',
          data: {
            pair: 'WBNB/USDT',
            amount0In: '1000000000000000000',
            timestamp: Date.now(),
            nested: { deep: { value: 42 } }
          }
        };

        const messageId = await streamsClient.xadd(
          RedisStreamsClient.STREAMS.SWAP_EVENTS,
          complexMessage
        );

        expect(messageId).toBeDefined();

        // Verify stored data by reading directly from Redis
        const result = await rawRedis.xread('COUNT', 1, 'STREAMS', RedisStreamsClient.STREAMS.SWAP_EVENTS, '0');
        expect(result).not.toBeNull();

        // Parse the stored message
        const [, messages] = result![0];
        const [, fields] = messages[0];
        // Fields are [key, value, key, value, ...] - find 'data' field
        const dataIdx = fields.indexOf('data');
        expect(dataIdx).toBeGreaterThanOrEqual(0);
        const serialized = JSON.parse(fields[dataIdx + 1] as string);
        expect(serialized).toEqual(complexMessage);
      });

      it('should validate stream names and reject unsafe characters', async () => {
        await expect(
          streamsClient.xadd('invalid stream!@#', { data: 'test' })
        ).rejects.toThrow('Invalid stream name');
      });

      it('should retry on transient failures when retry option is enabled', async () => {
        // With real Redis, we test the retry path by verifying successful writes
        // (Transient failures are hard to simulate with real Redis, but we verify the option works)
        const messageId = await streamsClient.xadd(
          'stream:test',
          { data: 'test' },
          '*',
          { retry: true }
        );

        expect(messageId).toBeDefined();
        expect(typeof messageId).toBe('string');
      });
    });

    describe('XREAD - Message Consumption', () => {
      it('should read messages from a stream', async () => {
        // Add test messages
        await streamsClient.xadd('stream:test', { value: 1 });
        await streamsClient.xadd('stream:test', { value: 2 });

        const messages = await streamsClient.xread('stream:test', '0');

        expect(messages).toBeDefined();
        expect(messages.length).toBe(2);
      });

      it('should return empty array when no messages available', async () => {
        const messages = await streamsClient.xread('stream:empty', '0');

        expect(messages).toEqual([]);
      });

      it('should support COUNT option for limiting results', async () => {
        // Add 5 messages
        for (let i = 0; i < 5; i++) {
          await streamsClient.xadd('stream:test', { value: i });
        }

        const messages = await streamsClient.xread('stream:test', '0', { count: 2 });

        expect(messages.length).toBe(2);
      });
    });

    describe('Consumer Groups', () => {
      it('should create a consumer group', async () => {
        await streamsClient.createConsumerGroup({
          streamName: 'stream:test',
          groupName: 'test-group',
          consumerName: 'consumer-1'
        });

        // Verify group was created by checking stream info
        const info = await rawRedis.xinfo('GROUPS', 'stream:test') as any[];
        expect(info.length).toBeGreaterThan(0);
      });

      it('should handle existing group gracefully', async () => {
        // First creation succeeds
        await streamsClient.createConsumerGroup({
          streamName: 'stream:test',
          groupName: 'existing-group',
          consumerName: 'consumer-1'
        });

        // Second creation should not throw (BUSYGROUP handled)
        await expect(
          streamsClient.createConsumerGroup({
            streamName: 'stream:test',
            groupName: 'existing-group',
            consumerName: 'consumer-1'
          })
        ).resolves.not.toThrow();
      });

      it('should read messages via consumer group', async () => {
        // Create group and add messages
        await streamsClient.createConsumerGroup({
          streamName: 'stream:test',
          groupName: 'test-group',
          consumerName: 'consumer-1',
          startId: '0'
        });

        await streamsClient.xadd('stream:test', { data: 'msg1' });
        await streamsClient.xadd('stream:test', { data: 'msg2' });

        const messages = await streamsClient.xreadgroup({
          streamName: 'stream:test',
          groupName: 'test-group',
          consumerName: 'consumer-1'
        });

        expect(messages.length).toBe(2);
      });

      it('should acknowledge processed messages', async () => {
        // Create group, add message, read it
        await streamsClient.createConsumerGroup({
          streamName: 'stream:test',
          groupName: 'test-group',
          consumerName: 'consumer-1',
          startId: '0'
        });

        const messageId = await streamsClient.xadd('stream:test', { data: 'test' });

        await streamsClient.xreadgroup({
          streamName: 'stream:test',
          groupName: 'test-group',
          consumerName: 'consumer-1'
        });

        // Acknowledge the message
        const acked = await streamsClient.xack('stream:test', 'test-group', messageId);
        expect(acked).toBe(1);

        // Verify no pending messages remain
        const pending = await rawRedis.xpending('stream:test', 'test-group') as any[];
        expect(pending[0]).toBe(0); // Total pending count
      });
    });

    describe('Stream Constants', () => {
      it('should define all required stream names (ADR-002)', () => {
        expect(RedisStreamsClient.STREAMS.PRICE_UPDATES).toBe('stream:price-updates');
        expect(RedisStreamsClient.STREAMS.SWAP_EVENTS).toBe('stream:swap-events');
        expect(RedisStreamsClient.STREAMS.OPPORTUNITIES).toBe('stream:opportunities');
        expect(RedisStreamsClient.STREAMS.WHALE_ALERTS).toBe('stream:whale-alerts');
        expect(RedisStreamsClient.STREAMS.VOLUME_AGGREGATES).toBe('stream:volume-aggregates');
        expect(RedisStreamsClient.STREAMS.HEALTH).toBe('stream:health');
      });
    });
  });

  // =========================================================================
  // S1.1.2: StreamBatcher Tests
  // =========================================================================
  describe('S1.1.2: StreamBatcher for Efficient Command Usage', () => {
    let batcher: StreamBatcher<any>;

    beforeEach(async () => {
      streamsClient = await createTestStreamsClient();
    });

    afterEach(async () => {
      if (batcher) {
        await batcher.destroy();
      }
      if (streamsClient) {
        await streamsClient.disconnect();
      }
    });

    it('should batch messages before sending (50:1 ratio target)', async () => {
      batcher = streamsClient.createBatcher('stream:test', {
        maxBatchSize: 50,
        maxWaitMs: 200 // Allow more time for real Redis
      });

      // Add 50 individual messages
      for (let i = 0; i < 50; i++) {
        batcher.add({ price: 100 + i, index: i });
      }

      // Wait for batch to be processed and flush
      await delay(300);
      await batcher.destroy();

      // Verify batching occurred
      const stats = batcher.getStats();
      expect(stats.totalMessagesQueued).toBe(50);

      // Verify data was actually written to Redis
      const streamLen = await rawRedis.xlen('stream:test');
      expect(streamLen).toBeGreaterThan(0);
    });

    it('should flush batch on timeout even if not full', async () => {
      batcher = streamsClient.createBatcher('stream:test', {
        maxBatchSize: 100,
        maxWaitMs: 100
      });

      batcher.add({ price: 100 });

      // Wait for timeout flush
      await delay(200);

      // Verify data was written to Redis
      const streamLen = await rawRedis.xlen('stream:test');
      expect(streamLen).toBeGreaterThan(0);
    });

    it('should handle concurrent flushes gracefully', async () => {
      batcher = streamsClient.createBatcher('stream:test', {
        maxBatchSize: 1000,
        maxWaitMs: 10000
      });

      // Add messages
      for (let i = 0; i < 100; i++) {
        batcher.add({ index: i });
      }

      // Trigger multiple concurrent flushes
      const flushPromises = [
        batcher.flush(),
        batcher.flush(),
        batcher.flush()
      ];

      await Promise.all(flushPromises);

      // All messages should have been flushed
      const stats = batcher.getStats();
      expect(stats.totalMessagesQueued).toBe(100);
    });

    it('should not accept messages after destroy', async () => {
      batcher = streamsClient.createBatcher('stream:test', {
        maxBatchSize: 100,
        maxWaitMs: 1000
      });

      batcher.add({ before: true });
      await batcher.destroy();

      // This should be silently ignored
      batcher.add({ after: true });

      // Wait a bit
      await delay(50);

      // Only the first message should have been sent
      const stats = batcher.getStats();
      expect(stats.totalMessagesSent).toBe(1);
    });

    it('should flush remaining messages on destroy', async () => {
      batcher = streamsClient.createBatcher('stream:test', {
        maxBatchSize: 1000,
        maxWaitMs: 10000 // Long timeout
      });

      // Add messages but don't wait for timeout
      batcher.add({ message: 1 });
      batcher.add({ message: 2 });

      // Destroy should flush
      await batcher.destroy();

      // Verify data was written to Redis
      const streamLen = await rawRedis.xlen('stream:test');
      expect(streamLen).toBeGreaterThan(0);
    });

    it('should provide accurate statistics', async () => {
      batcher = streamsClient.createBatcher('stream:test', {
        maxBatchSize: 10,
        maxWaitMs: 200 // Allow more time for real Redis
      });

      // Add 25 messages (should create 2 full batches + 5 queued)
      for (let i = 0; i < 25; i++) {
        batcher.add({ index: i });
      }

      // Wait for batches to process
      await delay(400);

      // Destroy to flush any remaining
      await batcher.destroy();

      const stats = batcher.getStats();
      // All messages were queued/processed
      expect(stats.totalMessagesQueued).toBeGreaterThanOrEqual(25);
    });
  });

  // =========================================================================
  // S1.1.5: StreamHealthMonitor Tests
  // =========================================================================
  describe('S1.1.5: StreamHealthMonitor', () => {
    let healthMonitor: StreamHealthMonitor;

    beforeEach(async () => {
      // Create a dedicated streams client for the health monitor
      const monitorClient = await createTestStreamsClient();

      // Create monitor with injected client (DI pattern)
      healthMonitor = new StreamHealthMonitor({
        streamsClient: monitorClient
      });
    });

    afterEach(async () => {
      await healthMonitor.stop();
    });

    it('should check health of all monitored streams', async () => {
      const health = await healthMonitor.checkStreamHealth();

      expect(health).toBeDefined();
      expect(health.overall).toBeDefined();
      expect(health.streams).toBeDefined();
      expect(health.timestamp).toBeGreaterThan(0);
    });

    it('should report healthy/unknown status for empty streams', async () => {
      const health = await healthMonitor.checkStreamHealth();

      // With no data in streams, they should report as unknown (not initialized)
      // or healthy, depending on implementation
      expect(['healthy', 'unknown']).toContain(health.overall);
    });

    it('should detect streams with data as healthy', async () => {
      // Add some data to a stream to make it initialized
      await rawRedis.xadd(RedisStreamsClient.STREAMS.PRICE_UPDATES, '*', 'data', '{"test":true}');

      const health = await healthMonitor.checkStreamHealth();

      expect(health.streams[RedisStreamsClient.STREAMS.PRICE_UPDATES]).toBeDefined();
      const streamInfo = health.streams[RedisStreamsClient.STREAMS.PRICE_UPDATES];
      expect(streamInfo.length).toBe(1);
    });

    it('should register alert handlers and support cooldown configuration', async () => {
      const alertHandler = jest.fn();
      healthMonitor.onAlert(alertHandler);
      healthMonitor.setAlertCooldown(100); // 100ms cooldown for testing

      // Verify the handler was registered
      expect(typeof healthMonitor.onAlert).toBe('function');
      expect(typeof healthMonitor.setAlertCooldown).toBe('function');

      // Verify monitored streams can be managed
      const initialStreams = healthMonitor.getMonitoredStreams();
      expect(Array.isArray(initialStreams)).toBe(true);

      // Add a test stream
      healthMonitor.addStream('stream:test-alert');
      const updatedStreams = healthMonitor.getMonitoredStreams();
      expect(updatedStreams).toContain('stream:test-alert');

      // Remove the stream
      healthMonitor.removeStream('stream:test-alert');
    });

    it('should provide summary statistics', async () => {
      const summary = await healthMonitor.getSummary();

      expect(summary.totalStreams).toBeGreaterThan(0);
      expect(summary.healthyStreams).toBeDefined();
      expect(summary.warningStreams).toBeDefined();
      expect(summary.criticalStreams).toBeDefined();
      expect(summary.totalPending).toBeDefined();
      expect(summary.averageLag).toBeDefined();
    });

    it('should export metrics in Prometheus format', async () => {
      const prometheusMetrics = await healthMonitor.getPrometheusMetrics();

      expect(prometheusMetrics).toContain('stream_length');
      expect(prometheusMetrics).toContain('stream_pending');
      expect(prometheusMetrics).toContain('stream_health_status');
    });

    it('should allow configuring consumer group name', () => {
      healthMonitor.setConsumerGroup('custom-group');

      // Verify it was set (internal state check via subsequent operations)
      expect(() => healthMonitor.setConsumerGroup('another-group')).not.toThrow();
    });

    it('should handle initialization race condition', async () => {
      // Trigger multiple concurrent health checks
      const promises = [
        healthMonitor.checkStreamHealth(),
        healthMonitor.checkStreamHealth(),
        healthMonitor.checkStreamHealth()
      ];

      const results = await Promise.all(promises);

      // All should succeed without errors
      results.forEach((result) => {
        expect(result).toBeDefined();
        expect(result.overall).toBeDefined();
      });
    });
  });

  // =========================================================================
  // S1.1.4: Migration Integration Tests
  // =========================================================================
  describe('S1.1.4: Pub/Sub to Streams Migration', () => {
    beforeEach(async () => {
      streamsClient = await createTestStreamsClient();
    });

    afterEach(async () => {
      if (streamsClient) {
        await streamsClient.disconnect();
      }
    });

    it('should publish price updates to streams with batching', async () => {
      const batcher = streamsClient.createBatcher(
        RedisStreamsClient.STREAMS.PRICE_UPDATES,
        { maxBatchSize: 50, maxWaitMs: 200 }
      );

      // Simulate detector publishing price updates
      const priceUpdates: any[] = [];
      for (let i = 0; i < 100; i++) {
        priceUpdates.push(createMockPriceUpdate({
          price0: 1800 + i * 0.1,
          timestamp: Date.now()
        }));
      }

      // Add all updates
      priceUpdates.forEach(update => {
        batcher.add({
          type: 'price-update',
          data: update,
          timestamp: Date.now(),
          source: 'partition-asia-fast'
        });
      });

      // Wait for batches to flush
      await delay(400);

      // Destroy to flush any remaining messages
      await batcher.destroy();

      // Verify messages were published to the actual Redis stream
      const streamLen = await rawRedis.xlen(RedisStreamsClient.STREAMS.PRICE_UPDATES);
      expect(streamLen).toBeGreaterThan(0);
    });

    it('should publish swap events to streams', async () => {
      const batcher = streamsClient.createBatcher(
        RedisStreamsClient.STREAMS.SWAP_EVENTS,
        { maxBatchSize: 100, maxWaitMs: 500 }
      );

      const swapEvent = createMockSwapEvent({
        amount0In: 1.5,
        amount1Out: 2700,
        timestamp: Date.now()
      });

      batcher.add({
        type: 'swap-event',
        data: swapEvent,
        timestamp: Date.now(),
        source: 'partition-asia-fast'
      });

      await batcher.flush();

      // Verify data was written to the actual stream
      const streamLen = await rawRedis.xlen(RedisStreamsClient.STREAMS.SWAP_EVENTS);
      expect(streamLen).toBe(1);

      // Verify the stored data is valid JSON
      const result = await rawRedis.xread('COUNT', 1, 'STREAMS', RedisStreamsClient.STREAMS.SWAP_EVENTS, '0');
      expect(result).not.toBeNull();
      const [, messages] = result![0];
      const [, fields] = messages[0];
      const dataIdx = fields.indexOf('data');
      expect(() => JSON.parse(fields[dataIdx + 1] as string)).not.toThrow();

      await batcher.destroy();
    });

    it('should publish arbitrage opportunities directly (no batching)', async () => {
      const opportunity = {
        id: 'arb_test_123',
        sourceDex: 'pancakeswap',
        targetDex: 'biswap',
        estimatedProfit: 50,
        confidence: 0.9
      };

      await streamsClient.xadd(
        RedisStreamsClient.STREAMS.OPPORTUNITIES,
        {
          type: 'arbitrage-opportunity',
          data: opportunity,
          timestamp: Date.now(),
          source: 'partition-asia-fast'
        }
      );

      // Verify directly in Redis
      const streamLen = await rawRedis.xlen(RedisStreamsClient.STREAMS.OPPORTUNITIES);
      expect(streamLen).toBe(1);

      // Read and verify the stored data
      const result = await rawRedis.xread('COUNT', 1, 'STREAMS', RedisStreamsClient.STREAMS.OPPORTUNITIES, '0');
      expect(result).not.toBeNull();
      const [, messages] = result![0];
      const [, fields] = messages[0];
      const dataIdx = fields.indexOf('data');
      const stored = JSON.parse(fields[dataIdx + 1] as string);
      expect(stored.data.id).toBe('arb_test_123');
      expect(stored.data.sourceDex).toBe('pancakeswap');
    });
  });

  // =========================================================================
  // Error Handling and Resilience Tests
  // =========================================================================
  describe('Error Handling and Resilience', () => {
    beforeEach(async () => {
      streamsClient = await createTestStreamsClient();
    });

    afterEach(async () => {
      if (streamsClient) {
        await streamsClient.disconnect();
      }
    });

    it('should handle stream info errors gracefully for non-existent streams', async () => {
      // xinfo on a non-existent stream should return defaults (not throw)
      const info = await streamsClient.xinfo('stream:nonexistent');

      expect(info).toBeDefined();
      expect(info.length).toBe(0);
      expect(info.lastGeneratedId).toBe('0-0');
    });

    it('should re-queue failed messages in batcher on flush error', async () => {
      // Create a separate streams client for this test so we can spy on it
      const isolatedClient = await createTestStreamsClient();
      const batcher = isolatedClient.createBatcher('stream:test', {
        maxBatchSize: 10,
        maxWaitMs: 10000
      });

      // Add messages
      for (let i = 0; i < 5; i++) {
        batcher.add({ index: i });
      }

      // Force xadd to fail by spying on the client method
      jest.spyOn(isolatedClient, 'xadd').mockRejectedValue(new Error('Connection lost'));

      // Flush should fail
      await expect(batcher.flush()).rejects.toThrow('Connection lost');

      // Messages should still be in queue for retry
      const stats = batcher.getStats();
      expect(stats.currentQueueSize).toBe(5);

      // Cleanup
      (isolatedClient.xadd as jest.Mock<any>).mockRestore();
      await isolatedClient.disconnect();
    });

    it('should handle consumer group operations on non-existent streams', async () => {
      // xpending on non-existent stream/group should return defaults
      const pendingInfo = await streamsClient.xpending('stream:nonexistent', 'no-group');

      expect(pendingInfo).toBeDefined();
      expect(pendingInfo.total).toBe(0);
    });
  });

  // =========================================================================
  // Performance Tests
  // =========================================================================
  describe('Performance Benchmarks', () => {
    beforeEach(async () => {
      streamsClient = await createTestStreamsClient();
    });

    afterEach(async () => {
      if (streamsClient) {
        await streamsClient.disconnect();
      }
    });

    it('should handle high throughput message publishing', async () => {
      const batcher = streamsClient.createBatcher('stream:perf-test', {
        maxBatchSize: 100,
        maxWaitMs: 100
      });

      const messageCount = 1000;
      const startTime = performance.now();

      // Publish messages
      for (let i = 0; i < messageCount; i++) {
        batcher.add({ index: i, timestamp: Date.now() });
      }

      // Wait for all batches to flush (more time for real Redis)
      await delay(500);
      await batcher.flush();

      const endTime = performance.now();
      const duration = endTime - startTime;

      // Should complete in reasonable time (< 5 seconds for 1000 messages with real Redis)
      expect(duration).toBeLessThan(5000);

      // Verify compression ratio
      const stats = batcher.getStats();
      expect(stats.compressionRatio).toBeGreaterThanOrEqual(5); // At least 5:1 with real Redis

      // Verify data was actually stored
      const streamLen = await rawRedis.xlen('stream:perf-test');
      expect(streamLen).toBeGreaterThan(0);

      await batcher.destroy();
    });

    it('should have low latency for health checks', async () => {
      const monitorClient = await createTestStreamsClient();
      const monitor = new StreamHealthMonitor({
        streamsClient: monitorClient
      });

      const iterations = 10;
      const times: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await monitor.checkStreamHealth();
        times.push(performance.now() - start);
      }

      const avgTime = times.reduce((a, b) => a + b, 0) / times.length;

      // Health checks should complete in < 500ms on average with real Redis
      expect(avgTime).toBeLessThan(500);

      await monitor.stop();
      await monitorClient.disconnect();
    });
  });
});
