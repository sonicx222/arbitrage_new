/**
 * Batch Provider Tests
 *
 * Validates:
 * - Request batching and auto-flush
 * - Batch size limits
 * - Timeout-based flushing
 * - Error handling per request
 * - Statistics tracking
 * - Deduplication
 * - Rate limiting integration
 *
 * @see docs/architecture/adr/ADR-024-rpc-rate-limiting.md
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ethers } from 'ethers';

import {
  BatchProvider,
  createBatchProvider,
  BATCHABLE_METHODS,
  NON_BATCHABLE_METHODS,
  BatchProviderConfig,
} from '../../src/rpc/batch-provider';

// Type for mock fetch response (mirrors globalThis.Response interface)
interface MockFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  json: () => Promise<unknown>;
}

// Helper to create mock fetch response
const createMockFetchResponse = (data: unknown, ok = true): MockFetchResponse => ({
  ok,
  status: ok ? 200 : 500,
  statusText: ok ? 'OK' : 'Internal Server Error',
  headers: { 'content-type': 'application/json' },
  json: async () => data,
});

// Mock fetch globally
const mockFetch = jest.fn<() => Promise<MockFetchResponse>>();
(global as unknown as { fetch: typeof mockFetch }).fetch = mockFetch;

describe('BatchProvider', () => {
  let mockProvider: ethers.JsonRpcProvider;
   
  let mockProviderSend: jest.Mock<any>;
   
  let mockProviderGetNetwork: jest.Mock<any>;
   
  let mockProviderGetConnection: jest.Mock<any>;
  let batchProvider: BatchProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Create mock functions
    mockProviderSend = jest.fn();
    mockProviderGetNetwork = jest.fn();
    mockProviderGetConnection = jest.fn();

    // Configure default return values
    mockProviderGetNetwork.mockResolvedValue({ chainId: 1n });
    mockProviderGetConnection.mockReturnValue({ url: 'http://localhost:8545' });

    // Create a mock provider object that looks like ethers.JsonRpcProvider
    mockProvider = {
      send: mockProviderSend,
      getNetwork: mockProviderGetNetwork,
      _getConnection: mockProviderGetConnection,
    } as unknown as ethers.JsonRpcProvider;

    // Reset and configure mock fetch
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(createMockFetchResponse([]));

    batchProvider = new BatchProvider(mockProvider, {
      maxBatchSize: 5,
      batchTimeoutMs: 100,
      enabled: true,
      enableDeduplication: false, // Disable for tests that rely on distinct request counting
    });
  });

  afterEach(async () => {
    await batchProvider.shutdown();
    jest.useRealTimers();
  });

  describe('initialization', () => {
    it('should create batch provider with default config', () => {
      const provider = new BatchProvider(mockProvider);
      expect(provider).toBeDefined();
      expect(provider.isEnabled()).toBe(true);
    });

    it('should create batch provider with custom config', () => {
      const config: BatchProviderConfig = {
        maxBatchSize: 20,
        batchTimeoutMs: 50,
        enabled: false,
        maxQueueSize: 200,
      };
      const provider = new BatchProvider(mockProvider, config);
      expect(provider.isEnabled()).toBe(false);
    });

    it('should create batch provider using factory function', () => {
      const provider = createBatchProvider(mockProvider);
      expect(provider).toBeInstanceOf(BatchProvider);
    });
  });

  describe('request queueing', () => {
    it('should queue batchable requests', async () => {
      // Setup mock response for 2 requests (single request goes through provider.send)
      mockFetch.mockResolvedValueOnce(createMockFetchResponse([
        { jsonrpc: '2.0', id: 1, result: '0x1234' },
        { jsonrpc: '2.0', id: 2, result: '0x5678' },
      ]));

      // Queue 2 requests so they go through batch path
      const promise1 = batchProvider.queueRequest('eth_call', [{ to: '0x123', data: '0x' }, 'latest']);
      const promise2 = batchProvider.queueRequest('eth_call', [{ to: '0x456', data: '0x' }, 'latest']);

      // Advance timer to trigger flush
      jest.advanceTimersByTime(100);

      // Wait for async operations
      await jest.runAllTimersAsync();

      await expect(promise1).resolves.toBe('0x1234');
      await expect(promise2).resolves.toBe('0x5678');
    });

    it('should bypass batching for non-batchable methods', async () => {
      mockProviderSend.mockResolvedValueOnce('0xtxhash');

      const result = await batchProvider.queueRequest('eth_sendRawTransaction', ['0xsignedtx']);

      expect(mockProviderSend).toHaveBeenCalledWith('eth_sendRawTransaction', ['0xsignedtx']);
      expect(result).toBe('0xtxhash');

      const stats = batchProvider.getStats();
      expect(stats.totalRequestsBypassed).toBe(1);
    });

    it('should bypass batching when disabled', async () => {
      const disabledProvider = new BatchProvider(mockProvider, { enabled: false });
      mockProviderSend.mockResolvedValueOnce('0xresult');

      const result = await disabledProvider.queueRequest('eth_call', [{ to: '0x123' }]);

      expect(mockProviderSend).toHaveBeenCalled();
      expect(result).toBe('0xresult');

      await disabledProvider.shutdown();
    });
  });

  describe('auto-flush behavior', () => {
    it('should flush on batch size limit', async () => {
      // Setup mock responses
      const responses = [
        { jsonrpc: '2.0', id: 1, result: 'r1' },
        { jsonrpc: '2.0', id: 2, result: 'r2' },
        { jsonrpc: '2.0', id: 3, result: 'r3' },
        { jsonrpc: '2.0', id: 4, result: 'r4' },
        { jsonrpc: '2.0', id: 5, result: 'r5' },
      ];
      mockFetch.mockResolvedValueOnce(createMockFetchResponse(responses));

      // Queue 5 requests (maxBatchSize)
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(batchProvider.queueRequest('eth_blockNumber', []));
      }

      // Auto-flush fires when batch size is reached, but the flush is async.
      // Run all pending timers and microtasks to ensure the flush completes.
      await jest.runAllTimersAsync();

      const results = await Promise.all(promises);
      expect(results).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const stats = batchProvider.getStats();
      expect(stats.totalBatchFlushes).toBe(1);
      expect(stats.totalRequestsBatched).toBe(5);
    });

    it('should flush on timeout', async () => {
      mockFetch.mockResolvedValueOnce(createMockFetchResponse([
        { jsonrpc: '2.0', id: 1, result: 'r1' },
        { jsonrpc: '2.0', id: 2, result: 'r2' },
      ]));

      const promises = [
        batchProvider.queueRequest('eth_blockNumber', []),
        batchProvider.queueRequest('eth_blockNumber', []),
      ];

      // Run all pending timers (including the batch timeout) and microtasks
      await jest.runAllTimersAsync();

      const results = await Promise.all(promises);
      expect(results).toEqual(['r1', 'r2']);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('error handling', () => {
    it('should handle individual request errors in batch', async () => {
      mockFetch.mockResolvedValueOnce(createMockFetchResponse([
        { jsonrpc: '2.0', id: 1, result: 'success' },
        { jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'execution reverted' } },
      ]));

      const promise1 = batchProvider.queueRequest('eth_call', [{ to: '0x123' }]);
      const promise2 = batchProvider.queueRequest('eth_call', [{ to: '0x456' }]);

      jest.advanceTimersByTime(100);
      await Promise.resolve();

      await expect(promise1).resolves.toBe('success');
      await expect(promise2).rejects.toThrow('RPC error -32000: execution reverted');
    });

    it('should handle batch-level HTTP error', async () => {
      mockFetch.mockResolvedValueOnce(createMockFetchResponse(null, false));

      // Queue 2 requests to go through batch path
      const promise1 = batchProvider.queueRequest('eth_call', [{ to: '0x123' }]);
      const promise2 = batchProvider.queueRequest('eth_call', [{ to: '0x456' }]);

      // Use allSettled to capture rejections before Jest's unhandled rejection handler
      const settledPromise = Promise.allSettled([promise1, promise2]);

      await jest.runAllTimersAsync();

      const results = await settledPromise;
      expect(results[0].status).toBe('rejected');
      expect((results[0] as PromiseRejectedResult).reason.message).toContain('HTTP error: 500');
      expect(results[1].status).toBe('rejected');
      expect((results[1] as PromiseRejectedResult).reason.message).toContain('HTTP error: 500');

      const stats = batchProvider.getStats();
      expect(stats.totalBatchErrors).toBe(1);
    });

    it('should handle missing response for request', async () => {
      mockFetch.mockResolvedValueOnce(createMockFetchResponse([
        { jsonrpc: '2.0', id: 1, result: 'r1' },
        // Missing response for id: 2
      ]));

      const promise1 = batchProvider.queueRequest('eth_call', [{ to: '0x123' }]);
      const promise2 = batchProvider.queueRequest('eth_call', [{ to: '0x456' }]);

      jest.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();

      await expect(promise1).resolves.toBe('r1');
      await expect(promise2).rejects.toThrow('No response for request ID');
    });

    it('should reject new requests when shutting down', async () => {
      await batchProvider.shutdown();

      await expect(
        batchProvider.queueRequest('eth_call', [{ to: '0x123' }])
      ).rejects.toThrow('BatchProvider is shutting down');
    });

    it('should reject when queue is full', async () => {
      const smallQueueProvider = new BatchProvider(mockProvider, {
        maxBatchSize: 100,
        batchTimeoutMs: 100000,
        maxQueueSize: 2,
      });

      // Mock flushBatch to be a no-op so the queue stays full after the
      // forced flush attempt inside queueRequest's queue-full handler.
      jest.spyOn(smallQueueProvider as any, 'flushBatch').mockResolvedValue(undefined);

      // Queue 2 requests (fills queue) — don't await them
      void smallQueueProvider.queueRequest('eth_call', [{ to: '0x1' }]);
      void smallQueueProvider.queueRequest('eth_call', [{ to: '0x2' }]);

      // Third request: queue full, flush is no-op, still full → throws
      await expect(
        smallQueueProvider.queueRequest('eth_call', [{ to: '0x3' }])
      ).rejects.toThrow('BatchProvider queue full');

      // Cleanup: restore flushBatch, clear pending to avoid shutdown errors
      (smallQueueProvider as any).flushBatch.mockRestore();
      (smallQueueProvider as any).pendingBatch = [];
      (smallQueueProvider as any).deduplicationMap?.clear();
      await smallQueueProvider.shutdown();
    });
  });

  describe('statistics', () => {
    it('should track basic statistics', async () => {
      mockFetch.mockResolvedValueOnce(createMockFetchResponse([
        { jsonrpc: '2.0', id: 1, result: 'r1' },
        { jsonrpc: '2.0', id: 2, result: 'r2' },
        { jsonrpc: '2.0', id: 3, result: 'r3' },
      ]));

      await Promise.all([
        batchProvider.queueRequest('eth_call', [{ to: '0x1' }]),
        batchProvider.queueRequest('eth_call', [{ to: '0x2' }]),
        batchProvider.queueRequest('eth_call', [{ to: '0x3' }]),
      ].map(async (p) => {
        jest.advanceTimersByTime(100);
        return p;
      }));

      const stats = batchProvider.getStats();
      expect(stats.totalRequestsProcessed).toBeGreaterThanOrEqual(3);
    });

    it('should reset statistics', () => {
      batchProvider.resetStats();
      const stats = batchProvider.getStats();

      expect(stats.totalBatchFlushes).toBe(0);
      expect(stats.totalRequestsProcessed).toBe(0);
      expect(stats.totalRequestsBatched).toBe(0);
      expect(stats.totalRequestsBypassed).toBe(0);
      expect(stats.totalBatchErrors).toBe(0);
    });

    it('should calculate batch efficiency', async () => {
      // Bypass one request
      mockProviderSend.mockResolvedValueOnce('0xtx');
      await batchProvider.queueRequest('eth_sendRawTransaction', ['0x123']);

      const efficiency = batchProvider.getBatchEfficiency();
      expect(efficiency).toBe(0); // Only bypassed requests so far
    });
  });

  describe('convenience methods', () => {
    it('should batch eth_estimateGas calls', async () => {
      mockFetch.mockResolvedValueOnce(createMockFetchResponse([
        { jsonrpc: '2.0', id: 1, result: '0x5208' }, // 21000
        { jsonrpc: '2.0', id: 2, result: '0x7530' }, // 30000
      ]));

      // Note: Can't use bigint in transaction object as it can't be serialized to JSON
      const resultsPromise = batchProvider.batchEstimateGas([
        { to: '0x123' },
        { to: '0x456', data: '0x' },
      ]);

      await jest.runAllTimersAsync();

      const results = await resultsPromise;
      expect(results).toHaveLength(2);
      expect(results[0]).toBe(21000n);
      expect(results[1]).toBe(30000n);
    });

    it('should batch eth_call requests', async () => {
      mockFetch.mockResolvedValueOnce(createMockFetchResponse([
        { jsonrpc: '2.0', id: 1, result: '0xdata1' },
        { jsonrpc: '2.0', id: 2, result: '0xdata2' },
      ]));

      const resultsPromise = batchProvider.batchCall([
        { to: '0x123', data: '0x' },
        { to: '0x456', data: '0x' },
      ]);

      jest.advanceTimersByTime(100);
      await Promise.resolve();

      const results = await resultsPromise;
      expect(results).toEqual(['0xdata1', '0xdata2']);
    });

    it('should batch eth_getTransactionReceipt calls', async () => {
      mockFetch.mockResolvedValueOnce(createMockFetchResponse([
        { jsonrpc: '2.0', id: 1, result: { status: '0x1', blockNumber: '0x1' } },
        { jsonrpc: '2.0', id: 2, result: null }, // Pending tx
      ]));

      const resultsPromise = batchProvider.batchGetTransactionReceipts([
        '0xtx1',
        '0xtx2',
      ]);

      jest.advanceTimersByTime(100);
      await Promise.resolve();

      const results = await resultsPromise;
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ status: '0x1', blockNumber: '0x1' });
      expect(results[1]).toBeNull();
    });

    it('should batch eth_getBalance calls', async () => {
      mockFetch.mockResolvedValueOnce(createMockFetchResponse([
        { jsonrpc: '2.0', id: 1, result: '0xde0b6b3a7640000' }, // 1 ETH
        { jsonrpc: '2.0', id: 2, result: '0x0' },
      ]));

      const resultsPromise = batchProvider.batchGetBalances([
        '0xaddr1',
        '0xaddr2',
      ]);

      jest.advanceTimersByTime(100);
      await Promise.resolve();

      const results = await resultsPromise;
      expect(results).toHaveLength(2);
      expect(results[0]).toBe(1000000000000000000n);
      expect(results[1]).toBe(0n);
    });

    it('should handle errors in batch convenience methods', async () => {
      mockFetch.mockResolvedValueOnce(createMockFetchResponse([
        { jsonrpc: '2.0', id: 1, result: '0x5208' },
        { jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'gas required exceeds allowance' } },
      ]));

      const resultsPromise = batchProvider.batchEstimateGas([
        { to: '0x123' },
        { to: '0x456' },
      ]);

      jest.advanceTimersByTime(100);
      await Promise.resolve();

      const results = await resultsPromise;
      expect(results[0]).toBe(21000n);
      expect(results[1]).toBeInstanceOf(Error);
      expect((results[1] as Error).message).toContain('gas required exceeds allowance');
    });
  });

  describe('out-of-order responses', () => {
    it('should handle out-of-order batch responses via responseMap lookup', async () => {
      // Responses arrive shuffled relative to request IDs
      mockFetch.mockResolvedValueOnce(createMockFetchResponse([
        { jsonrpc: '2.0', id: 3, result: 'r3' },
        { jsonrpc: '2.0', id: 1, result: 'r1' },
        { jsonrpc: '2.0', id: 2, result: 'r2' },
      ]));

      const promise1 = batchProvider.queueRequest('eth_call', [{ to: '0x1' }]);
      const promise2 = batchProvider.queueRequest('eth_call', [{ to: '0x2' }]);
      const promise3 = batchProvider.queueRequest('eth_call', [{ to: '0x3' }]);

      await jest.runAllTimersAsync();

      // Each request should get its correct response despite shuffled order
      await expect(promise1).resolves.toBe('r1');
      await expect(promise2).resolves.toBe('r2');
      await expect(promise3).resolves.toBe('r3');
    });
  });

  describe('single request optimization', () => {
    it('should send single request without batch format', async () => {
      mockProviderSend.mockResolvedValueOnce('0xresult');

      const promise = batchProvider.queueRequest('eth_call', [{ to: '0x123' }]);

      jest.advanceTimersByTime(100);
      await Promise.resolve();

      const result = await promise;
      expect(result).toBe('0xresult');
      // Single request should go through provider.send, not fetch
      expect(mockProviderSend).toHaveBeenCalledWith('eth_call', [{ to: '0x123' }]);
    });
  });

  describe('constants', () => {
    it('should define batchable methods', () => {
      expect(BATCHABLE_METHODS.has('eth_call')).toBe(true);
      expect(BATCHABLE_METHODS.has('eth_estimateGas')).toBe(true);
      expect(BATCHABLE_METHODS.has('eth_getTransactionReceipt')).toBe(true);
      expect(BATCHABLE_METHODS.has('eth_getBalance')).toBe(true);
    });

    it('should define non-batchable methods', () => {
      expect(NON_BATCHABLE_METHODS.has('eth_sendRawTransaction')).toBe(true);
      expect(NON_BATCHABLE_METHODS.has('eth_sendTransaction')).toBe(true);
      expect(NON_BATCHABLE_METHODS.has('eth_subscribe')).toBe(true);
    });
  });

  describe('deduplication', () => {
    it('should deduplicate identical requests when enabled', async () => {
      const dedupProvider = new BatchProvider(mockProvider, {
        enableDeduplication: true,
        batchTimeoutMs: 100,
      });

      // Single request goes through provider.send, so mock provider.send for single request
      mockProviderSend.mockResolvedValueOnce('0xbalance');

      // Queue identical requests
      const promise1 = dedupProvider.queueRequest('eth_getBalance', ['0xaddr', 'latest']);
      const promise2 = dedupProvider.queueRequest('eth_getBalance', ['0xaddr', 'latest']);
      const promise3 = dedupProvider.queueRequest('eth_getBalance', ['0xaddr', 'latest']);

      await jest.runAllTimersAsync();

      // All should resolve to same value
      const results = await Promise.all([promise1, promise2, promise3]);
      expect(results).toEqual(['0xbalance', '0xbalance', '0xbalance']);

      // Should only have sent one request
      const stats = dedupProvider.getStats();
      expect(stats.totalDeduplicated).toBe(2); // 2 deduplicated out of 3

      await dedupProvider.shutdown();
    });

    it('should propagate errors to all deduplicated requests', async () => {
      const dedupProvider = new BatchProvider(mockProvider, {
        enableDeduplication: true,
        batchTimeoutMs: 100,
        maxBatchSize: 10,
      });

      // Use 2 unique + 1 duplicate so the batch path (fetch) is used
      mockFetch.mockResolvedValueOnce(createMockFetchResponse([
        { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'execution reverted' } },
        { jsonrpc: '2.0', id: 2, result: '0xok' },
      ]));

      const promise1 = dedupProvider.queueRequest('eth_call', [{ to: '0xA' }, 'latest']);
      const promise2 = dedupProvider.queueRequest('eth_call', [{ to: '0xB' }, 'latest']);
      const promise3 = dedupProvider.queueRequest('eth_call', [{ to: '0xA' }, 'latest']); // dup of promise1

      // Use allSettled to capture rejections before Jest's unhandled rejection handler fires
      const settledPromise = Promise.allSettled([promise1, promise2, promise3]);

      await jest.runAllTimersAsync();

      const results = await settledPromise;

      // Primary (promise1) and duplicate (promise3) should both get the error
      expect(results[0].status).toBe('rejected');
      expect((results[0] as PromiseRejectedResult).reason.message).toContain('execution reverted');
      expect(results[2].status).toBe('rejected');
      expect((results[2] as PromiseRejectedResult).reason.message).toContain('execution reverted');
      // Non-duplicate (promise2) should succeed
      expect(results[1].status).toBe('fulfilled');
      expect((results[1] as PromiseFulfilledResult<string>).value).toBe('0xok');

      await dedupProvider.shutdown();
    });

    it('should deduplicate within batch and resolve via batch path', async () => {
      const dedupProvider = new BatchProvider(mockProvider, {
        enableDeduplication: true,
        batchTimeoutMs: 100,
        maxBatchSize: 10,
      });

      // Queue 2 unique requests + 1 duplicate of the first
      // pendingBatch gets 2 unique entries, sent as batch via fetch
      mockFetch.mockResolvedValueOnce(createMockFetchResponse([
        { jsonrpc: '2.0', id: 1, result: '0xbalance_a' },
        { jsonrpc: '2.0', id: 2, result: '0xbalance_b' },
      ]));

      const promise1 = dedupProvider.queueRequest('eth_getBalance', ['0xaddrA', 'latest']);
      const promise2 = dedupProvider.queueRequest('eth_getBalance', ['0xaddrB', 'latest']);
      const promise3 = dedupProvider.queueRequest('eth_getBalance', ['0xaddrA', 'latest']); // dup of promise1

      await jest.runAllTimersAsync();

      const results = await Promise.all([promise1, promise2, promise3]);
      expect(results).toEqual(['0xbalance_a', '0xbalance_b', '0xbalance_a']);

      const stats = dedupProvider.getStats();
      expect(stats.totalDeduplicated).toBe(1);
      expect(stats.totalRequestsBatched).toBe(2); // Only 2 unique sent

      await dedupProvider.shutdown();
    });

    it('should not deduplicate requests with different params', async () => {
      const dedupProvider = new BatchProvider(mockProvider, {
        enableDeduplication: true,
        batchTimeoutMs: 100,
        maxBatchSize: 10,
      });

      mockFetch.mockResolvedValueOnce(createMockFetchResponse([
        { jsonrpc: '2.0', id: 1, result: '0xbalance_a' },
        { jsonrpc: '2.0', id: 2, result: '0xbalance_b' },
      ]));

      const promise1 = dedupProvider.queueRequest('eth_getBalance', ['0xaddrA', 'latest']);
      const promise2 = dedupProvider.queueRequest('eth_getBalance', ['0xaddrB', 'latest']);

      await jest.runAllTimersAsync();

      const results = await Promise.all([promise1, promise2]);
      expect(results).toEqual(['0xbalance_a', '0xbalance_b']);

      const stats = dedupProvider.getStats();
      expect(stats.totalDeduplicated).toBe(0);

      await dedupProvider.shutdown();
    });
  });

  describe('rate limiting integration', () => {
    it('should allow requests when rate limiter has tokens', async () => {
      const rateLimitedProvider = new BatchProvider(mockProvider, {
        enableRateLimiting: true,
        rateLimitConfig: { tokensPerSecond: 100, maxBurst: 100 },
        batchTimeoutMs: 100,
      });

      mockProviderSend.mockResolvedValueOnce('0xresult');

      const promise = rateLimitedProvider.queueRequest('eth_blockNumber', []);
      await jest.runAllTimersAsync();

      await expect(promise).resolves.toBe('0xresult');

      await rateLimitedProvider.shutdown();
    });

    it('should throw when rate limited', async () => {
      const rateLimitedProvider = new BatchProvider(mockProvider, {
        enableRateLimiting: true,
        rateLimitConfig: { tokensPerSecond: 1, maxBurst: 1 },
        batchTimeoutMs: 100,
      });

      mockProviderSend.mockResolvedValue('0xresult');

      // First request consumes the only token, enters the batch queue
      const p1 = rateLimitedProvider.queueRequest('eth_blockNumber', []);

      // Second request: no tokens left → rate limited immediately
      await expect(
        rateLimitedProvider.queueRequest('eth_blockNumber', [])
      ).rejects.toThrow('Rate limited');

      // Flush and await first request
      await jest.runAllTimersAsync();
      await p1;

      const stats = rateLimitedProvider.getStats();
      expect(stats.totalRateLimited).toBe(1);

      await rateLimitedProvider.shutdown();
    });

    it('should bypass rate limiting for exempt methods', async () => {
      const rateLimitedProvider = new BatchProvider(mockProvider, {
        enableRateLimiting: true,
        rateLimitConfig: { tokensPerSecond: 1, maxBurst: 1 },
        batchTimeoutMs: 100,
      });

      mockProviderSend.mockResolvedValue('0xresult');

      // Exhaust the only token with a batchable method
      const p1 = rateLimitedProvider.queueRequest('eth_blockNumber', []);
      await jest.runAllTimersAsync();
      await p1;

      // Exempt method (eth_sendRawTransaction) bypasses rate limiter
      mockProviderSend.mockResolvedValueOnce('0xtxhash');
      const result = await rateLimitedProvider.queueRequest('eth_sendRawTransaction', ['0xsignedtx']);
      expect(result).toBe('0xtxhash');

      const stats = rateLimitedProvider.getStats();
      expect(stats.totalRateLimited).toBe(0);

      await rateLimitedProvider.shutdown();
    });

    it('should track totalRateLimited stat across multiple rejections', async () => {
      const rateLimitedProvider = new BatchProvider(mockProvider, {
        enableRateLimiting: true,
        rateLimitConfig: { tokensPerSecond: 1, maxBurst: 2 },
        batchTimeoutMs: 100,
      });

      mockProviderSend.mockResolvedValue('0xresult');

      // Use both tokens
      const p1 = rateLimitedProvider.queueRequest('eth_blockNumber', []);
      const p2 = rateLimitedProvider.queueRequest('eth_blockNumber', []);
      await jest.runAllTimersAsync();
      await Promise.all([p1, p2]);

      // Next 3 should be rate limited
      for (let i = 0; i < 3; i++) {
        await expect(
          rateLimitedProvider.queueRequest('eth_blockNumber', [])
        ).rejects.toThrow('Rate limited');
      }

      const stats = rateLimitedProvider.getStats();
      expect(stats.totalRateLimited).toBe(3);

      await rateLimitedProvider.shutdown();
    });
  });

  describe('getProvider', () => {
    it('should return underlying provider', () => {
      const underlying = batchProvider.getProvider();
      expect(underlying).toBe(mockProvider);
    });
  });
});
