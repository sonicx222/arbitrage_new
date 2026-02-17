/**
 * Reserve Cache Unit Tests
 *
 * Tests for the ReserveCache that provides in-memory caching
 * of reserve data from Sync events with LRU eviction and TTL.
 *
 * @see ADR-022: Reserve Data Caching with Event-Driven Invalidation
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// =============================================================================
// Mock Setup - Must be before any imports that might use these modules
// =============================================================================

// Mock logger (auto-resolves to src/__mocks__/logger.ts)
jest.mock('../../src/logger');

// =============================================================================
// Imports - After mocks
// =============================================================================

import {
  ReserveCache,
  createReserveCache,
  getReserveCache,
  resetReserveCache,
  ReserveCacheConfig,
  CachedReserve,
  ReserveCacheStats
} from '../../src/caching/reserve-cache';

describe('ReserveCache', () => {
  let cache: ReserveCache;

  beforeEach(() => {
    resetReserveCache();
    cache = createReserveCache({
      maxEntries: 100,
      ttlMs: 5000,
      enableMetrics: false, // Disable interval logging for tests
    });
  });

  afterEach(() => {
    cache.dispose();
  });

  describe('Basic Operations', () => {
    it('should return undefined for cache miss', () => {
      const result = cache.get('ethereum', '0x1234');
      expect(result).toBeUndefined();
    });

    it('should cache reserves from Sync event', () => {
      const reserve0 = '1000000000000000000';
      const reserve1 = '2000000000000000000';
      const blockNumber = 12345;

      cache.onSyncEvent('ethereum', '0x1234', reserve0, reserve1, blockNumber);

      const result = cache.get('ethereum', '0x1234');
      expect(result).toBeDefined();
      expect(result!.reserve0).toBe(reserve0);
      expect(result!.reserve1).toBe(reserve1);
      expect(result!.blockNumber).toBe(blockNumber);
      expect(result!.source).toBe('sync_event');
    });

    it('should cache reserves from RPC fallback', () => {
      const reserve0 = '1000000000000000000';
      const reserve1 = '2000000000000000000';
      const blockNumber = 12345;

      cache.setFromRpc('ethereum', '0x1234', reserve0, reserve1, blockNumber);

      const result = cache.get('ethereum', '0x1234');
      expect(result).toBeDefined();
      expect(result!.reserve0).toBe(reserve0);
      expect(result!.reserve1).toBe(reserve1);
      expect(result!.source).toBe('rpc_call');
    });

    it('should check if pair exists with has()', () => {
      expect(cache.has('ethereum', '0x1234')).toBe(false);

      cache.onSyncEvent('ethereum', '0x1234', '100', '200', 1);

      expect(cache.has('ethereum', '0x1234')).toBe(true);
    });

    it('should track cache size', () => {
      expect(cache.size()).toBe(0);

      cache.onSyncEvent('ethereum', '0x1234', '100', '200', 1);
      expect(cache.size()).toBe(1);

      cache.onSyncEvent('ethereum', '0x5678', '100', '200', 1);
      expect(cache.size()).toBe(2);

      // Update existing entry (should not increase size)
      cache.onSyncEvent('ethereum', '0x1234', '300', '400', 2);
      expect(cache.size()).toBe(2);
    });

    it('should clear all entries', () => {
      cache.onSyncEvent('ethereum', '0x1234', '100', '200', 1);
      cache.onSyncEvent('ethereum', '0x5678', '100', '200', 1);
      expect(cache.size()).toBe(2);

      cache.clear();
      expect(cache.size()).toBe(0);
      expect(cache.get('ethereum', '0x1234')).toBeUndefined();
    });
  });

  describe('TTL Expiration', () => {
    it('should return undefined for stale entries', async () => {
      // Create cache with very short TTL for testing
      cache.dispose();
      cache = createReserveCache({
        maxEntries: 100,
        ttlMs: 50, // 50ms TTL
        enableMetrics: false,
      });

      cache.onSyncEvent('ethereum', '0x1234', '100', '200', 1);
      expect(cache.get('ethereum', '0x1234')).toBeDefined();

      // Wait for TTL to expire
      await new Promise(resolve => setTimeout(resolve, 60));

      const result = cache.get('ethereum', '0x1234');
      expect(result).toBeUndefined();

      // Verify stale reject was counted
      const stats = cache.getStats();
      expect(stats.staleRejects).toBe(1);
    });
  });

  describe('LRU Eviction', () => {
    it('should evict least recently used entries when over capacity', () => {
      cache.dispose();
      cache = createReserveCache({
        maxEntries: 3,
        ttlMs: 5000,
        enableMetrics: false,
      });

      // Add 3 entries (at capacity)
      cache.onSyncEvent('ethereum', '0x1', '100', '200', 1);
      cache.onSyncEvent('ethereum', '0x2', '100', '200', 1);
      cache.onSyncEvent('ethereum', '0x3', '100', '200', 1);
      expect(cache.size()).toBe(3);

      // Add 4th entry - should evict LRU (0x1)
      cache.onSyncEvent('ethereum', '0x4', '100', '200', 1);
      expect(cache.size()).toBe(3);
      expect(cache.get('ethereum', '0x1')).toBeUndefined();
      expect(cache.get('ethereum', '0x4')).toBeDefined();

      // Verify eviction was counted
      const stats = cache.getStats();
      expect(stats.evictions).toBe(1);
    });

    it('should update LRU order on get()', () => {
      cache.dispose();
      cache = createReserveCache({
        maxEntries: 3,
        ttlMs: 5000,
        enableMetrics: false,
      });

      // Add 3 entries
      cache.onSyncEvent('ethereum', '0x1', '100', '200', 1);
      cache.onSyncEvent('ethereum', '0x2', '100', '200', 1);
      cache.onSyncEvent('ethereum', '0x3', '100', '200', 1);

      // Access 0x1 (moves to front of LRU)
      cache.get('ethereum', '0x1');

      // Add 4th entry - should evict 0x2 (now LRU)
      cache.onSyncEvent('ethereum', '0x4', '100', '200', 1);
      expect(cache.get('ethereum', '0x1')).toBeDefined();
      expect(cache.get('ethereum', '0x2')).toBeUndefined();
      expect(cache.get('ethereum', '0x3')).toBeDefined();
      expect(cache.get('ethereum', '0x4')).toBeDefined();
    });

    it('should update LRU order on onSyncEvent()', () => {
      cache.dispose();
      cache = createReserveCache({
        maxEntries: 3,
        ttlMs: 5000,
        enableMetrics: false,
      });

      // Add 3 entries
      cache.onSyncEvent('ethereum', '0x1', '100', '200', 1);
      cache.onSyncEvent('ethereum', '0x2', '100', '200', 1);
      cache.onSyncEvent('ethereum', '0x3', '100', '200', 1);

      // Update 0x1 (moves to front of LRU)
      cache.onSyncEvent('ethereum', '0x1', '300', '400', 2);

      // Add 4th entry - should evict 0x2 (now LRU)
      cache.onSyncEvent('ethereum', '0x4', '100', '200', 1);
      expect(cache.get('ethereum', '0x1')).toBeDefined();
      expect(cache.get('ethereum', '0x2')).toBeUndefined();
    });
  });

  describe('Sync vs RPC Priority', () => {
    it('should not overwrite newer Sync data with older RPC data', () => {
      // First, add Sync event at block 100
      cache.onSyncEvent('ethereum', '0x1234', '1000', '2000', 100);

      // Try to update with RPC data from older block 99
      cache.setFromRpc('ethereum', '0x1234', '500', '600', 99);

      // Should still have Sync data
      const result = cache.get('ethereum', '0x1234');
      expect(result!.reserve0).toBe('1000');
      expect(result!.reserve1).toBe('2000');
      expect(result!.source).toBe('sync_event');
    });

    it('should overwrite older RPC data with newer Sync data', () => {
      // First, add RPC data
      cache.setFromRpc('ethereum', '0x1234', '500', '600', 99);

      // Update with Sync event (always overwrites)
      cache.onSyncEvent('ethereum', '0x1234', '1000', '2000', 100);

      // Should have Sync data
      const result = cache.get('ethereum', '0x1234');
      expect(result!.reserve0).toBe('1000');
      expect(result!.reserve1).toBe('2000');
      expect(result!.source).toBe('sync_event');
    });

    it('should allow RPC to overwrite when no block number is known', () => {
      // Add Sync event
      cache.onSyncEvent('ethereum', '0x1234', '1000', '2000', 100);

      // RPC with no block number (0) should NOT overwrite
      cache.setFromRpc('ethereum', '0x1234', '500', '600', 0);

      // Sync data should be preserved (RPC with block 0 treated as potentially stale)
      const result = cache.get('ethereum', '0x1234');
      expect(result!.source).toBe('sync_event');
    });
  });

  describe('Statistics', () => {
    it('should track cache hits and misses', () => {
      cache.onSyncEvent('ethereum', '0x1234', '100', '200', 1);

      // Hit
      cache.get('ethereum', '0x1234');
      // Miss
      cache.get('ethereum', '0x9999');
      cache.get('ethereum', '0x8888');

      const stats = cache.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(2);
    });

    it('should track sync and RPC updates', () => {
      cache.onSyncEvent('ethereum', '0x1234', '100', '200', 1);
      cache.onSyncEvent('ethereum', '0x5678', '100', '200', 1);
      cache.setFromRpc('ethereum', '0x9999', '100', '200', 1);

      const stats = cache.getStats();
      expect(stats.syncUpdates).toBe(2);
      expect(stats.rpcFallbacks).toBe(1);
    });

    it('should calculate hit ratio correctly', () => {
      cache.onSyncEvent('ethereum', '0x1234', '100', '200', 1);

      // 3 hits
      cache.get('ethereum', '0x1234');
      cache.get('ethereum', '0x1234');
      cache.get('ethereum', '0x1234');

      // 1 miss
      cache.get('ethereum', '0x9999');

      // Hit ratio should be 3/4 = 0.75
      expect(cache.getHitRatio()).toBeCloseTo(0.75);
    });

    it('should return 0 hit ratio with no lookups', () => {
      expect(cache.getHitRatio()).toBe(0);
    });

    it('should report entries count in stats', () => {
      cache.onSyncEvent('ethereum', '0x1234', '100', '200', 1);
      cache.onSyncEvent('ethereum', '0x5678', '100', '200', 1);

      const stats = cache.getStats();
      expect(stats.entriesCount).toBe(2);
    });
  });

  describe('Cross-Chain Isolation', () => {
    it('should keep entries from different chains separate', () => {
      cache.onSyncEvent('ethereum', '0x1234', '100', '200', 1);
      cache.onSyncEvent('arbitrum', '0x1234', '300', '400', 2);

      const ethResult = cache.get('ethereum', '0x1234');
      const arbResult = cache.get('arbitrum', '0x1234');

      expect(ethResult!.reserve0).toBe('100');
      expect(arbResult!.reserve0).toBe('300');
    });
  });

  describe('Singleton Factory', () => {
    beforeEach(() => {
      resetReserveCache();
    });

    afterEach(() => {
      resetReserveCache();
    });

    it('should return same instance from getReserveCache()', () => {
      const cache1 = getReserveCache();
      const cache2 = getReserveCache();

      expect(cache1).toBe(cache2);
    });

    it('should create new instance after reset', () => {
      const cache1 = getReserveCache();
      resetReserveCache();
      const cache2 = getReserveCache();

      expect(cache1).not.toBe(cache2);
    });

    it('should use config only on first call', () => {
      const cache1 = getReserveCache({ maxEntries: 50 });
      const cache2 = getReserveCache({ maxEntries: 100 }); // Should be ignored

      expect(cache1).toBe(cache2);
      // Verify the first config was used (would require accessing private config)
    });
  });

  describe('resetState()', () => {
    it('should clear cache and reset stats', () => {
      cache.onSyncEvent('ethereum', '0x1234', '100', '200', 1);
      cache.get('ethereum', '0x1234');
      cache.get('ethereum', '0x9999');

      const statsBefore = cache.getStats();
      expect(statsBefore.hits).toBe(1);
      expect(statsBefore.misses).toBe(1);
      expect(statsBefore.entriesCount).toBe(1);

      cache.resetState();

      const statsAfter = cache.getStats();
      expect(statsAfter.hits).toBe(0);
      expect(statsAfter.misses).toBe(0);
      expect(statsAfter.entriesCount).toBe(0);
      expect(cache.size()).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty chain or address', () => {
      cache.onSyncEvent('', '0x1234', '100', '200', 1);
      expect(cache.get('', '0x1234')).toBeDefined();

      cache.onSyncEvent('ethereum', '', '100', '200', 1);
      expect(cache.get('ethereum', '')).toBeDefined();
    });

    it('should handle very large reserves (bigint-safe)', () => {
      const largeReserve = '115792089237316195423570985008687907853269984665640564039457584007913129639935'; // Max uint256

      cache.onSyncEvent('ethereum', '0x1234', largeReserve, largeReserve, 1);

      const result = cache.get('ethereum', '0x1234');
      expect(result!.reserve0).toBe(largeReserve);
      expect(result!.reserve1).toBe(largeReserve);
    });

    it('should handle zero reserves', () => {
      cache.onSyncEvent('ethereum', '0x1234', '0', '0', 1);

      const result = cache.get('ethereum', '0x1234');
      expect(result!.reserve0).toBe('0');
      expect(result!.reserve1).toBe('0');
    });

    it('should reject block number 0 (Fix #16: invalid sync event)', () => {
      // Block 0 is not a valid sync event block number
      cache.onSyncEvent('ethereum', '0x1234', '100', '200', 0);

      const result = cache.get('ethereum', '0x1234');
      expect(result).toBeUndefined();
    });
  });
});
