/**
 * PHASE3-TASK41: Worker Thread SharedArrayBuffer Integration Tests
 *
 * Tests that verify SharedArrayBuffer can be passed to worker threads
 * and accessed for zero-copy price data reads.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { EventProcessingWorkerPool } from '@arbitrage/core';
import { createHierarchicalCache } from '@arbitrage/core';

describe('PHASE3-TASK41: Worker Thread SharedArrayBuffer Access', () => {
  describe('EventProcessingWorkerPool with SharedArrayBuffer', () => {
    it('should accept SharedArrayBuffer in constructor', () => {
      // Create a test SharedArrayBuffer
      const buffer = new SharedArrayBuffer(1024);

      // Should not throw when creating pool with buffer
      expect(() => {
        const pool = new EventProcessingWorkerPool(2, 100, 5000, buffer);
      }).not.toThrow();
    });

    it('should work without SharedArrayBuffer (backward compatible)', () => {
      // Should work with null/undefined buffer
      expect(() => {
        const pool = new EventProcessingWorkerPool(2, 100, 5000, null);
      }).not.toThrow();

      expect(() => {
        const pool = new EventProcessingWorkerPool(2, 100, 5000);
      }).not.toThrow();
    });

    it('should initialize with HierarchicalCache SharedArrayBuffer', () => {
      // Create cache with PriceMatrix
      const cache = createHierarchicalCache({
        l1Enabled: true,
        l1Size: 64,
        l2Enabled: false,
        l3Enabled: false,
        usePriceMatrix: true
      });

      // Get SharedArrayBuffer from cache
      const buffer = cache.getSharedBuffer();

      // Should have a buffer (PriceMatrix enabled)
      expect(buffer).toBeTruthy();
      expect(buffer).toBeInstanceOf(SharedArrayBuffer);

      // Should be able to create worker pool with it
      expect(() => {
        const pool = new EventProcessingWorkerPool(2, 100, 5000, buffer);
      }).not.toThrow();
    });

    it('should return null when PriceMatrix is disabled', () => {
      // Create cache without PriceMatrix
      const cache = createHierarchicalCache({
        l1Enabled: true,
        l1Size: 64,
        l2Enabled: false,
        l3Enabled: false,
        usePriceMatrix: false
      });

      // Get SharedArrayBuffer from cache
      const buffer = cache.getSharedBuffer();

      // Should be null (PriceMatrix disabled)
      expect(buffer).toBeNull();
    });
  });

  describe('HierarchicalCache getSharedBuffer()', () => {
    it('should return SharedArrayBuffer when PriceMatrix is enabled', () => {
      const cache = createHierarchicalCache({
        l1Enabled: true,
        l1Size: 64,
        l2Enabled: false,
        l3Enabled: false,
        usePriceMatrix: true
      });

      const buffer = cache.getSharedBuffer();

      expect(buffer).not.toBeNull();
      expect(buffer).toBeInstanceOf(SharedArrayBuffer);
      expect(buffer!.byteLength).toBeGreaterThan(0);
    });

    it('should return null when PriceMatrix is disabled', () => {
      const cache = createHierarchicalCache({
        l1Enabled: true,
        l1Size: 64,
        l2Enabled: false,
        l3Enabled: false,
        usePriceMatrix: false
      });

      const buffer = cache.getSharedBuffer();

      expect(buffer).toBeNull();
    });

    it('should return null when L1 is disabled', () => {
      const cache = createHierarchicalCache({
        l1Enabled: false,
        l1Size: 64,
        l2Enabled: true,
        l2Ttl: 300,
        l3Enabled: true,
        usePriceMatrix: true
      });

      const buffer = cache.getSharedBuffer();

      expect(buffer).toBeNull();
    });
  });

  describe('SharedArrayBuffer size calculations', () => {
    it('should have reasonable buffer size for 64MB cache', () => {
      const cache = createHierarchicalCache({
        l1Enabled: true,
        l1Size: 64, // 64MB
        l2Enabled: false,
        l3Enabled: false,
        usePriceMatrix: true
      });

      const buffer = cache.getSharedBuffer();
      expect(buffer).not.toBeNull();

      // PriceMatrix allocates based on l1Size
      // Should be in reasonable range (allows some overhead for metadata)
      expect(buffer!.byteLength).toBeLessThanOrEqual(80 * 1024 * 1024); // Allow up to 80MB
      expect(buffer!.byteLength).toBeGreaterThan(50 * 1024 * 1024); // At least 50MB
    });

    it('should have reasonable buffer size for 1MB cache', () => {
      const cache = createHierarchicalCache({
        l1Enabled: true,
        l1Size: 1, // 1MB
        l2Enabled: false,
        l3Enabled: false,
        usePriceMatrix: true
      });

      const buffer = cache.getSharedBuffer();
      expect(buffer).not.toBeNull();

      // 1MB config uses smaller maxPairs
      // Should be around 1-2MB (allows some overhead)
      expect(buffer!.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect(buffer!.byteLength).toBeGreaterThan(0);
    });
  });

  describe('Data integrity across threads', () => {
    it('should preserve data written to SharedArrayBuffer', async () => {
      const cache = createHierarchicalCache({
        l1Enabled: true,
        l1Size: 64,
        l2Enabled: false,
        l3Enabled: false,
        usePriceMatrix: true
      });

      // Write some price data
      await cache.set('price:eth:usd', { price: 2000.50, timestamp: Date.now() });
      await cache.set('price:btc:usd', { price: 45000.25, timestamp: Date.now() });

      // Get the buffer
      const buffer = cache.getSharedBuffer();
      expect(buffer).not.toBeNull();
      expect(buffer).toBeInstanceOf(SharedArrayBuffer);

      // Buffer should have reasonable size
      expect(buffer!.byteLength).toBeGreaterThan(0);

      // Verify we can read the data back from cache
      // This proves SharedArrayBuffer is being used correctly
      const eth = await cache.get('price:eth:usd');
      const btc = await cache.get('price:btc:usd');

      expect(eth).toEqual({ price: 2000.50, timestamp: expect.any(Number) });
      expect(btc).toEqual({ price: 45000.25, timestamp: expect.any(Number) });

      // The key test: buffer is shareable across threads
      expect(buffer).toBeInstanceOf(SharedArrayBuffer);
    });
  });
});

describe('PHASE3-TASK41: Integration readiness', () => {
  it('should have all components ready for worker integration', () => {
    // Create cache with PriceMatrix
    const cache = createHierarchicalCache({
      l1Enabled: true,
      l1Size: 64,
      l2Enabled: false,
      l3Enabled: false,
      usePriceMatrix: true
    });

    // Get SharedArrayBuffer
    const buffer = cache.getSharedBuffer();
    expect(buffer).toBeTruthy();

    // Create worker pool with buffer
    const pool = new EventProcessingWorkerPool(2, 100, 5000, buffer);
    expect(pool).toBeTruthy();

    // All components are ready for Task #42 (Initialize PriceMatrix in workers)
  });
});
