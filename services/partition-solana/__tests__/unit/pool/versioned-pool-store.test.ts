/**
 * Versioned Pool Store Tests
 *
 * Tests for the high-performance pool storage with versioning.
 * Covers CRUD operations, pair indexing, version tracking, LRU eviction, and iteration.
 *
 * @see services/partition-solana/src/pool/versioned-pool-store.ts
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { VersionedPoolStore } from '../../../src/pool/versioned-pool-store';
import type { InternalPoolInfo } from '../../../src/types';
import { createMockInternalPool } from '../../helpers/test-fixtures';

// =============================================================================
// Helpers
// =============================================================================

const createMockPool = createMockInternalPool;

// =============================================================================
// Tests
// =============================================================================

describe('VersionedPoolStore', () => {
  let store: VersionedPoolStore;

  beforeEach(() => {
    store = new VersionedPoolStore();
  });

  describe('constructor', () => {
    it('should initialize with default max size', () => {
      const s = new VersionedPoolStore();
      expect(s.size).toBe(0);
      expect(s.getVersion()).toBe(0);
    });

    it('should accept custom max size', () => {
      const s = new VersionedPoolStore(100);
      expect(s.size).toBe(0);
    });
  });

  describe('set', () => {
    it('should add a pool to the store', () => {
      const pool = createMockPool();
      store.set(pool);

      expect(store.size).toBe(1);
      expect(store.get(pool.address)).toBe(pool);
    });

    it('should increment version on each set', () => {
      const initialVersion = store.getVersion();
      store.set(createMockPool({ address: 'pool-1' }));
      expect(store.getVersion()).toBe(initialVersion + 1);

      store.set(createMockPool({ address: 'pool-2' }));
      expect(store.getVersion()).toBe(initialVersion + 2);
    });

    it('should update existing pool', () => {
      const pool = createMockPool({ address: 'pool-1', price: 100 });
      store.set(pool);

      const updated = createMockPool({ address: 'pool-1', price: 200 });
      store.set(updated);

      expect(store.size).toBe(1);
      expect(store.get('pool-1')!.price).toBe(200);
    });

    it('should update pair index on set', () => {
      const pool = createMockPool({ address: 'pool-1', pairKey: 'SOL-USDC' });
      store.set(pool);

      const pools = store.getPoolsForPair('SOL-USDC');
      expect(pools).toHaveLength(1);
      expect(pools[0].address).toBe('pool-1');
    });

    it('should handle pair key change on update', () => {
      const pool = createMockPool({ address: 'pool-1', pairKey: 'SOL-USDC' });
      store.set(pool);

      const updated = createMockPool({ address: 'pool-1', pairKey: 'ETH-USDC' });
      store.set(updated);

      expect(store.getPoolsForPair('SOL-USDC')).toHaveLength(0);
      expect(store.getPoolsForPair('ETH-USDC')).toHaveLength(1);
    });
  });

  describe('get', () => {
    it('should return pool by address', () => {
      const pool = createMockPool({ address: 'pool-1' });
      store.set(pool);

      expect(store.get('pool-1')).toBe(pool);
    });

    it('should return undefined for non-existent address', () => {
      expect(store.get('non-existent')).toBeUndefined();
    });
  });

  describe('has', () => {
    it('should return true for existing pool', () => {
      store.set(createMockPool({ address: 'pool-1' }));

      expect(store.has('pool-1')).toBe(true);
    });

    it('should return false for non-existent pool', () => {
      expect(store.has('non-existent')).toBe(false);
    });
  });

  describe('delete', () => {
    it('should remove pool from store', () => {
      store.set(createMockPool({ address: 'pool-1' }));
      const result = store.delete('pool-1');

      expect(result).toBe(true);
      expect(store.size).toBe(0);
      expect(store.get('pool-1')).toBeUndefined();
    });

    it('should return false when deleting non-existent pool', () => {
      const result = store.delete('non-existent');

      expect(result).toBe(false);
    });

    it('should increment version on delete', () => {
      store.set(createMockPool({ address: 'pool-1' }));
      const versionAfterSet = store.getVersion();

      store.delete('pool-1');
      expect(store.getVersion()).toBe(versionAfterSet + 1);
    });

    it('should remove from pair index on delete', () => {
      store.set(createMockPool({ address: 'pool-1', pairKey: 'SOL-USDC' }));
      store.delete('pool-1');

      expect(store.getPoolsForPair('SOL-USDC')).toHaveLength(0);
    });
  });

  describe('getPoolsForPair', () => {
    it('should return empty array for non-existent pair', () => {
      expect(store.getPoolsForPair('UNKNOWN-PAIR')).toHaveLength(0);
    });

    it('should return all pools for a pair', () => {
      store.set(createMockPool({ address: 'pool-1', pairKey: 'SOL-USDC', dex: 'raydium' }));
      store.set(createMockPool({ address: 'pool-2', pairKey: 'SOL-USDC', dex: 'orca' }));
      store.set(createMockPool({ address: 'pool-3', pairKey: 'ETH-USDC' }));

      const solUsdcPools = store.getPoolsForPair('SOL-USDC');
      expect(solUsdcPools).toHaveLength(2);
    });
  });

  describe('getPairKeys', () => {
    it('should return empty array when store is empty', () => {
      expect(store.getPairKeys()).toHaveLength(0);
    });

    it('should return all unique pair keys', () => {
      store.set(createMockPool({ address: 'pool-1', pairKey: 'SOL-USDC' }));
      store.set(createMockPool({ address: 'pool-2', pairKey: 'SOL-USDC' }));
      store.set(createMockPool({ address: 'pool-3', pairKey: 'ETH-USDC' }));

      const keys = store.getPairKeys();
      expect(keys).toHaveLength(2);
      expect(keys).toContain('SOL-USDC');
      expect(keys).toContain('ETH-USDC');
    });
  });

  describe('getAllPools', () => {
    it('should return empty array when store is empty', () => {
      expect(store.getAllPools()).toHaveLength(0);
    });

    it('should return all pools', () => {
      store.set(createMockPool({ address: 'pool-1' }));
      store.set(createMockPool({ address: 'pool-2' }));

      expect(store.getAllPools()).toHaveLength(2);
    });
  });

  describe('poolsIterator', () => {
    it('should return iterable of all pools', () => {
      store.set(createMockPool({ address: 'pool-1' }));
      store.set(createMockPool({ address: 'pool-2' }));

      const pools: InternalPoolInfo[] = [];
      for (const pool of store.poolsIterator()) {
        pools.push(pool);
      }

      expect(pools).toHaveLength(2);
    });

    it('should return empty iterator for empty store', () => {
      const pools: InternalPoolInfo[] = [];
      for (const pool of store.poolsIterator()) {
        pools.push(pool);
      }

      expect(pools).toHaveLength(0);
    });
  });

  describe('clear', () => {
    it('should remove all pools', () => {
      store.set(createMockPool({ address: 'pool-1' }));
      store.set(createMockPool({ address: 'pool-2' }));

      store.clear();

      expect(store.size).toBe(0);
      expect(store.getAllPools()).toHaveLength(0);
      expect(store.getPairKeys()).toHaveLength(0);
    });

    it('should increment version on clear', () => {
      store.set(createMockPool({ address: 'pool-1' }));
      const versionBeforeClear = store.getVersion();

      store.clear();

      expect(store.getVersion()).toBe(versionBeforeClear + 1);
    });
  });

  describe('LRU eviction', () => {
    it('should evict oldest pool when at max capacity', () => {
      const smallStore = new VersionedPoolStore(3);

      smallStore.set(createMockPool({ address: 'oldest', pairKey: 'A-B' }));
      smallStore.set(createMockPool({ address: 'middle', pairKey: 'C-D' }));
      smallStore.set(createMockPool({ address: 'newest', pairKey: 'E-F' }));

      // Adding 4th pool should evict 'oldest'
      smallStore.set(createMockPool({ address: 'extra', pairKey: 'G-H' }));

      expect(smallStore.size).toBe(3);
      expect(smallStore.has('oldest')).toBe(false);
      expect(smallStore.has('middle')).toBe(true);
      expect(smallStore.has('newest')).toBe(true);
      expect(smallStore.has('extra')).toBe(true);
    });

    it('should not evict when updating existing pool', () => {
      const smallStore = new VersionedPoolStore(3);

      smallStore.set(createMockPool({ address: 'pool-1', pairKey: 'A-B' }));
      smallStore.set(createMockPool({ address: 'pool-2', pairKey: 'C-D' }));
      smallStore.set(createMockPool({ address: 'pool-3', pairKey: 'E-F' }));

      // Update existing pool (should not trigger eviction)
      smallStore.set(createMockPool({ address: 'pool-1', pairKey: 'A-B', price: 999 }));

      expect(smallStore.size).toBe(3);
      expect(smallStore.has('pool-1')).toBe(true);
      expect(smallStore.has('pool-2')).toBe(true);
      expect(smallStore.has('pool-3')).toBe(true);
    });

    it('should move updated pool to end of LRU order', () => {
      const smallStore = new VersionedPoolStore(3);

      smallStore.set(createMockPool({ address: 'pool-1', pairKey: 'A-B' }));
      smallStore.set(createMockPool({ address: 'pool-2', pairKey: 'C-D' }));
      smallStore.set(createMockPool({ address: 'pool-3', pairKey: 'E-F' }));

      // Update pool-1 (moves it to end of LRU)
      smallStore.set(createMockPool({ address: 'pool-1', pairKey: 'A-B', price: 999 }));

      // Adding pool-4 should evict pool-2 (now the oldest)
      smallStore.set(createMockPool({ address: 'pool-4', pairKey: 'G-H' }));

      expect(smallStore.has('pool-1')).toBe(true);
      expect(smallStore.has('pool-2')).toBe(false); // evicted
      expect(smallStore.has('pool-3')).toBe(true);
      expect(smallStore.has('pool-4')).toBe(true);
    });

    it('should clean up pair index during eviction', () => {
      const smallStore = new VersionedPoolStore(2);

      smallStore.set(createMockPool({ address: 'pool-1', pairKey: 'A-B' }));
      smallStore.set(createMockPool({ address: 'pool-2', pairKey: 'C-D' }));

      // pool-1 will be evicted
      smallStore.set(createMockPool({ address: 'pool-3', pairKey: 'E-F' }));

      expect(smallStore.getPoolsForPair('A-B')).toHaveLength(0);
    });
  });

  describe('version tracking', () => {
    it('should start at version 0', () => {
      expect(store.getVersion()).toBe(0);
    });

    it('should increment on set', () => {
      store.set(createMockPool({ address: 'pool-1' }));
      expect(store.getVersion()).toBe(1);
    });

    it('should increment on delete', () => {
      store.set(createMockPool({ address: 'pool-1' }));
      store.delete('pool-1');
      expect(store.getVersion()).toBe(2); // 1 for set + 1 for delete
    });

    it('should increment on clear', () => {
      store.set(createMockPool({ address: 'pool-1' }));
      store.clear();
      expect(store.getVersion()).toBe(2); // 1 for set + 1 for clear
    });

    it('should not increment on failed delete', () => {
      store.set(createMockPool({ address: 'pool-1' }));
      const versionBefore = store.getVersion();

      store.delete('non-existent');

      expect(store.getVersion()).toBe(versionBefore);
    });
  });

  describe('size property', () => {
    it('should return 0 for empty store', () => {
      expect(store.size).toBe(0);
    });

    it('should reflect current pool count', () => {
      store.set(createMockPool({ address: 'pool-1' }));
      expect(store.size).toBe(1);

      store.set(createMockPool({ address: 'pool-2' }));
      expect(store.size).toBe(2);

      store.delete('pool-1');
      expect(store.size).toBe(1);
    });
  });
});
