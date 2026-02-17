/**
 * Redis Streams Batch Unwrap Tests
 *
 * Phase 1 regression tests for the unwrapBatchMessages helper.
 * Verifies batch envelope detection and transparent unwrapping
 * for both batched and non-batched messages.
 *
 * @see ADR-002: Redis Streams batch pattern (50:1 target)
 * @see StreamBatcher flush format: { type: 'batch', count: N, messages: T[], timestamp: number }
 */

import { describe, it, expect } from '@jest/globals';
import { unwrapBatchMessages } from '@arbitrage/core';

interface MockPriceUpdate {
  chain: string;
  dex: string;
  pairKey: string;
  price: number;
  timestamp: number;
}

describe('unwrapBatchMessages', () => {
  describe('batch envelope detection', () => {
    it('should unwrap a valid batch envelope into individual messages', () => {
      const messages: MockPriceUpdate[] = [
        { chain: 'bsc', dex: 'pancakeswap', pairKey: 'pair1', price: 1.5, timestamp: 1700000000000 },
        { chain: 'bsc', dex: 'biswap', pairKey: 'pair2', price: 2.3, timestamp: 1700000000001 },
      ];

      const batchEnvelope = {
        type: 'batch',
        count: 2,
        messages,
        timestamp: Date.now(),
      };

      const result = unwrapBatchMessages<MockPriceUpdate>(batchEnvelope);

      expect(result).toHaveLength(2);
      expect(result[0].chain).toBe('bsc');
      expect(result[0].dex).toBe('pancakeswap');
      expect(result[1].dex).toBe('biswap');
    });

    it('should handle batch with 50 messages (ADR-002 target)', () => {
      const messages = Array.from({ length: 50 }, (_, i) => ({
        chain: 'ethereum',
        dex: 'uniswap',
        pairKey: `pair-${i}`,
        price: 1.0 + i * 0.01,
        timestamp: Date.now(),
      }));

      const batchEnvelope = {
        type: 'batch',
        count: 50,
        messages,
        timestamp: Date.now(),
      };

      const result = unwrapBatchMessages<MockPriceUpdate>(batchEnvelope);

      expect(result).toHaveLength(50);
      expect(result[0].pairKey).toBe('pair-0');
      expect(result[49].pairKey).toBe('pair-49');
    });

    it('should handle batch with single message', () => {
      const batchEnvelope = {
        type: 'batch',
        count: 1,
        messages: [{ chain: 'bsc', dex: 'pancakeswap', pairKey: 'pair1', price: 1.0, timestamp: Date.now() }],
        timestamp: Date.now(),
      };

      const result = unwrapBatchMessages<MockPriceUpdate>(batchEnvelope);

      expect(result).toHaveLength(1);
      expect(result[0].chain).toBe('bsc');
    });

    it('should handle batch with empty messages array', () => {
      const batchEnvelope = {
        type: 'batch',
        count: 0,
        messages: [],
        timestamp: Date.now(),
      };

      const result = unwrapBatchMessages<MockPriceUpdate>(batchEnvelope);

      expect(result).toHaveLength(0);
    });
  });

  describe('non-batch passthrough (backward compatibility)', () => {
    it('should wrap a non-batched PriceUpdate in single-element array', () => {
      const singleUpdate: MockPriceUpdate = {
        chain: 'bsc',
        dex: 'pancakeswap',
        pairKey: 'pair1',
        price: 1.5,
        timestamp: Date.now(),
      };

      const result = unwrapBatchMessages<MockPriceUpdate>(singleUpdate);

      expect(result).toHaveLength(1);
      expect(result[0]).toBe(singleUpdate); // Same reference, no copy
      expect(result[0].chain).toBe('bsc');
    });

    it('should not treat objects with type but no messages as batch', () => {
      // This could happen with MessageEvent envelopes: { type: 'price:update', data: {...} }
      const messageEvent = {
        type: 'price:update',
        data: { chain: 'bsc', dex: 'pancakeswap', pairKey: 'pair1', price: 1.5 },
      };

      const result = unwrapBatchMessages<typeof messageEvent>(messageEvent);

      expect(result).toHaveLength(1);
      expect(result[0]).toBe(messageEvent);
    });

    it('should not treat objects with messages but wrong type as batch', () => {
      const notABatch = {
        type: 'something-else',
        messages: [{ data: 'test' }],
      };

      // This has messages array but type !== 'batch', so NOT a batch
      const result = unwrapBatchMessages<typeof notABatch>(notABatch);

      expect(result).toHaveLength(1);
      expect(result[0]).toBe(notABatch);
    });
  });

  describe('edge cases', () => {
    it('should handle null data', () => {
      const result = unwrapBatchMessages<MockPriceUpdate>(null);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeNull();
    });

    it('should handle undefined data', () => {
      const result = unwrapBatchMessages<MockPriceUpdate>(undefined);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeUndefined();
    });

    it('should handle string data', () => {
      const result = unwrapBatchMessages<string>('raw-string');
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('raw-string');
    });

    it('should handle number data', () => {
      const result = unwrapBatchMessages<number>(42);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(42);
    });
  });
});
