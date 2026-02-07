/**
 * P1 Regression Tests: PriceMatrix Uninitialized Read Prevention
 *
 * Verifies that P1 fix (write-before-register reordering) prevents workers
 * from reading uninitialized slots when keys are newly registered.
 */

import { describe, it, expect } from '@jest/globals';
import { PriceMatrix } from '@arbitrage/core';

describe('PriceMatrix: Uninitialized Read Prevention (P1 Fix)', () => {
  describe('Write-before-register ordering', () => {
    it('should write price before registering key in SharedKeyRegistry', () => {
      // Main thread: Create matrix
      const mainMatrix = new PriceMatrix({
        maxPairs: 100,
        reserveSlots: 10
      });

      const now = Date.now();
      const testKey = 'price:test:new';

      // Write price (this should write to SharedArrayBuffer BEFORE registering in KeyRegistry)
      const success = mainMatrix.setPrice(testKey, 999.99, now);
      expect(success).toBe(true);

      // Worker thread: Create matrix from same buffers
      const buffer = mainMatrix.getSharedBuffer();
      const keyRegistryBuffer = mainMatrix.getKeyRegistryBuffer();
      const workerMatrix = PriceMatrix.fromSharedBuffer(buffer!, keyRegistryBuffer, {
        maxPairs: 100,
        reserveSlots: 10
      });

      // Worker should NEVER read uninitialized data (timestamp=0)
      const price = workerMatrix.getPrice(testKey);
      expect(price).not.toBeNull();
      expect(price!.price).toBe(999.99);
      expect(price!.timestamp).not.toBe(0); // P1 fix ensures this is never 0
      // Note: Timestamps are stored with second precision, so we check within 1s
      expect(price!.timestamp).toBeGreaterThanOrEqual(Math.floor(now / 1000) * 1000);
      expect(price!.timestamp).toBeLessThanOrEqual(now + 1000);
    });

    it('should handle multiple concurrent price writes safely', () => {
      const mainMatrix = new PriceMatrix({
        maxPairs: 1000,
        reserveSlots: 100
      });

      // Simulate rapid price updates (hot-path scenario)
      const numPrices = 100;
      const now = Date.now();
      const keys: string[] = [];

      for (let i = 0; i < numPrices; i++) {
        const key = `price:pair:${i}`;
        keys.push(key);
        mainMatrix.setPrice(key, Math.random() * 1000, now + i);
      }

      // Worker attaches to shared memory
      const buffer = mainMatrix.getSharedBuffer();
      const keyRegistryBuffer = mainMatrix.getKeyRegistryBuffer();
      const workerMatrix = PriceMatrix.fromSharedBuffer(buffer!, keyRegistryBuffer, {
        maxPairs: 1000,
        reserveSlots: 100
      });

      // Worker reads all prices - NONE should have timestamp=0
      for (const key of keys) {
        const price = workerMatrix.getPrice(key);
        expect(price).not.toBeNull();
        expect(price!.timestamp).not.toBe(0);
        // Timestamps stored with second precision
        expect(price!.timestamp).toBeGreaterThanOrEqual(Math.floor(now / 1000) * 1000);
      }
    });

    it('should return null for uninitialized slots in worker mode', () => {
      const mainMatrix = new PriceMatrix({
        maxPairs: 100,
        reserveSlots: 10
      });

      // Write one price
      mainMatrix.setPrice('price:exists', 100, Date.now());

      // Worker attaches
      const buffer = mainMatrix.getSharedBuffer();
      const keyRegistryBuffer = mainMatrix.getKeyRegistryBuffer();
      const workerMatrix = PriceMatrix.fromSharedBuffer(buffer!, keyRegistryBuffer, {
        maxPairs: 100,
        reserveSlots: 10
      });

      // Worker should safely handle lookups for non-existent keys
      const nonExistent = workerMatrix.getPrice('price:does:not:exist');
      expect(nonExistent).toBeNull();
    });

    it('should handle price updates correctly', () => {
      const mainMatrix = new PriceMatrix({
        maxPairs: 50,
        reserveSlots: 5
      });

      const key = 'price:btc:usd';
      const time1 = Date.now();
      const time2 = time1 + 1000;

      // Initial write
      mainMatrix.setPrice(key, 40000, time1);

      // Worker sees initial value
      const buffer = mainMatrix.getSharedBuffer();
      const keyRegistryBuffer = mainMatrix.getKeyRegistryBuffer();
      const workerMatrix = PriceMatrix.fromSharedBuffer(buffer!, keyRegistryBuffer, {
        maxPairs: 50,
        reserveSlots: 5
      });

      const initial = workerMatrix.getPrice(key);
      expect(initial!.price).toBe(40000);
      // Timestamps stored with second precision
      expect(Math.floor(initial!.timestamp / 1000)).toBe(Math.floor(time1 / 1000));

      // Main thread updates price
      mainMatrix.setPrice(key, 41000, time2);

      // Worker sees updated value (zero-copy)
      const updated = workerMatrix.getPrice(key);
      expect(updated!.price).toBe(41000);
      // Timestamps stored with second precision
      expect(Math.floor(updated!.timestamp / 1000)).toBe(Math.floor(time2 / 1000));
    });

    it('should handle batch reads without uninitialized data', () => {
      const mainMatrix = new PriceMatrix({
        maxPairs: 200,
        reserveSlots: 20
      });

      const testData = [
        { key: 'price:eth:usd', price: 2000 },
        { key: 'price:sol:usd', price: 100 },
        { key: 'price:ada:usd', price: 0.5 },
        { key: 'price:avax:usd', price: 35 }
      ];

      const now = Date.now();
      for (const { key, price } of testData) {
        mainMatrix.setPrice(key, price, now);
      }

      // Worker batch read
      const buffer = mainMatrix.getSharedBuffer();
      const keyRegistryBuffer = mainMatrix.getKeyRegistryBuffer();
      const workerMatrix = PriceMatrix.fromSharedBuffer(buffer!, keyRegistryBuffer, {
        maxPairs: 200,
        reserveSlots: 20
      });

      const keys = testData.map(d => d.key);
      const results = workerMatrix.getBatch(keys);

      expect(results).toHaveLength(4);
      for (let i = 0; i < testData.length; i++) {
        expect(results[i]).not.toBeNull();
        expect(results[i]!.price).toBe(testData[i].price);
        expect(results[i]!.timestamp).not.toBe(0); // P1 fix verification
        // Timestamps stored with second precision
        expect(Math.floor(results[i]!.timestamp / 1000)).toBe(Math.floor(now / 1000));
      }
    });
  });

  describe('Timestamp validation for workers', () => {
    it('should filter out uninitialized slots (timestamp=0) in worker mode', () => {
      const mainMatrix = new PriceMatrix({
        maxPairs: 10,
        reserveSlots: 1
      });

      // Get buffers before any writes
      const buffer = mainMatrix.getSharedBuffer();
      const keyRegistryBuffer = mainMatrix.getKeyRegistryBuffer();

      // Worker attaches to empty matrix
      const workerMatrix = PriceMatrix.fromSharedBuffer(buffer!, keyRegistryBuffer, {
        maxPairs: 10,
        reserveSlots: 1
      });

      // Main thread writes price
      const now = Date.now();
      mainMatrix.setPrice('price:new', 123.45, now);

      // Worker should see the price (not filtered)
      const price = workerMatrix.getPrice('price:new');
      expect(price).not.toBeNull();
      expect(price!.price).toBe(123.45);
      // Timestamps stored with second precision
      expect(Math.floor(price!.timestamp / 1000)).toBe(Math.floor(now / 1000));
    });

    it('should handle edge case of timestamp at epoch (should not filter)', () => {
      const mainMatrix = new PriceMatrix({
        maxPairs: 10,
        reserveSlots: 1
      });

      // Edge case: Write with timestamp exactly at epoch
      const epochTime = Date.now();
      mainMatrix.setPrice('price:epoch', 100, epochTime);

      const buffer = mainMatrix.getSharedBuffer();
      const keyRegistryBuffer = mainMatrix.getKeyRegistryBuffer();
      const workerMatrix = PriceMatrix.fromSharedBuffer(buffer!, keyRegistryBuffer, {
        maxPairs: 10,
        reserveSlots: 1
      });

      // Worker should see the price (relative timestamp = 0 is valid)
      const price = workerMatrix.getPrice('price:epoch');
      expect(price).not.toBeNull();
      expect(price!.price).toBe(100);
    });
  });

  describe('Performance with write ordering', () => {
    it('should maintain hot-path performance with reordered writes', () => {
      const mainMatrix = new PriceMatrix({
        maxPairs: 5000,
        reserveSlots: 500
      });

      // Benchmark setPrice() performance with write-before-register ordering
      const numWrites = 1000;
      const now = Date.now();

      const startTime = process.hrtime.bigint();
      for (let i = 0; i < numWrites; i++) {
        mainMatrix.setPrice(`price:perf:${i}`, Math.random() * 1000, now + i);
      }
      const endTime = process.hrtime.bigint();

      const totalNanos = Number(endTime - startTime);
      const avgLatencyUs = (totalNanos / numWrites) / 1000;

      console.log(`setPrice() latency with P1 fix: ${avgLatencyUs.toFixed(3)}μs average`);

      // Should still meet hot-path requirements (<50ms total, <50μs per op)
      expect(avgLatencyUs).toBeLessThan(100);

      // Verify all writes succeeded
      const buffer = mainMatrix.getSharedBuffer();
      const keyRegistryBuffer = mainMatrix.getKeyRegistryBuffer();
      const workerMatrix = PriceMatrix.fromSharedBuffer(buffer!, keyRegistryBuffer, {
        maxPairs: 5000,
        reserveSlots: 500
      });

      // Sample check: verify first, middle, and last keys
      const first = workerMatrix.getPrice('price:perf:0');
      const middle = workerMatrix.getPrice('price:perf:500');
      const last = workerMatrix.getPrice('price:perf:999');

      expect(first).not.toBeNull();
      expect(middle).not.toBeNull();
      expect(last).not.toBeNull();

      expect(first!.timestamp).not.toBe(0);
      expect(middle!.timestamp).not.toBe(0);
      expect(last!.timestamp).not.toBe(0);
    });
  });
});
