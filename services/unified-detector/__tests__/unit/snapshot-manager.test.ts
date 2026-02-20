/**
 * SnapshotManager Unit Tests
 *
 * FIX 2.3: Test coverage for the pair snapshot management module.
 * Validates BigInt parsing, cache invalidation, and DexPool conversion.
 *
 * @see snapshot-manager.ts
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  SnapshotManager,
  createSnapshotManager,
  ExtendedPair,
} from '../../src/detection/snapshot-manager';

// =============================================================================
// Test Fixtures
// =============================================================================

// HOT-PATH OPT (Perf-3): Addresses are pre-normalized to lowercase at pair creation
// time in chain-instance.ts. Test fixtures reflect production behavior.
function createMockPair(overrides?: Partial<ExtendedPair>): ExtendedPair {
  return {
    address: '0xpair1',
    dex: 'uniswap',
    token0: '0xtoken0',
    token1: '0xtoken1',
    reserve0: '1000000000000000000000', // 1000 tokens
    reserve1: '2000000000000000000000', // 2000 tokens
    fee: 0.003,
    blockNumber: 12345678,
    lastUpdate: Date.now(),
    ...overrides,
  };
}

// =============================================================================
// Basic Functionality Tests
// =============================================================================

describe('SnapshotManager', () => {
  let manager: SnapshotManager;

  beforeEach(() => {
    manager = createSnapshotManager({ cacheTtlMs: 100 });
  });

  afterEach(() => {
    manager.clear();
  });

  describe('Constructor and Factory', () => {
    it('should create manager with default config', () => {
      const m = new SnapshotManager();
      expect(m).toBeDefined();
      m.clear();
    });

    it('should create manager with custom TTL', () => {
      const m = createSnapshotManager({ cacheTtlMs: 500 });
      expect(m).toBeDefined();
      m.clear();
    });
  });

  describe('createPairSnapshot', () => {
    it('should create valid snapshot from pair', () => {
      const pair = createMockPair();
      const snapshot = manager.createPairSnapshot(pair);

      expect(snapshot).not.toBeNull();
      expect(snapshot!.address).toBe(pair.address);
      expect(snapshot!.dex).toBe(pair.dex);
      expect(snapshot!.token0).toBe(pair.token0);
      expect(snapshot!.token1).toBe(pair.token1);
      expect(snapshot!.reserve0).toBe(pair.reserve0);
      expect(snapshot!.reserve1).toBe(pair.reserve1);
      expect(snapshot!.blockNumber).toBe(pair.blockNumber);
    });

    it('should pre-compute BigInt values for hot-path', () => {
      const pair = createMockPair();
      const snapshot = manager.createPairSnapshot(pair);

      expect(snapshot!.reserve0BigInt).toBeDefined();
      expect(snapshot!.reserve1BigInt).toBeDefined();
      expect(typeof snapshot!.reserve0BigInt).toBe('bigint');
      expect(typeof snapshot!.reserve1BigInt).toBe('bigint');
      expect(snapshot!.reserve0BigInt).toBe(BigInt(pair.reserve0));
      expect(snapshot!.reserve1BigInt).toBe(BigInt(pair.reserve1));
    });

    it('should return null for missing reserve0', () => {
      const pair = createMockPair({ reserve0: '' });
      const snapshot = manager.createPairSnapshot(pair);
      expect(snapshot).toBeNull();
    });

    it('should return null for missing reserve1', () => {
      const pair = createMockPair({ reserve1: '' });
      const snapshot = manager.createPairSnapshot(pair);
      expect(snapshot).toBeNull();
    });

    it('should return null for zero reserves', () => {
      const pair = createMockPair({ reserve0: '0', reserve1: '0' });
      const snapshot = manager.createPairSnapshot(pair);
      expect(snapshot).toBeNull();
    });

    it('should return null for invalid BigInt string', () => {
      const pair = createMockPair({ reserve0: 'not-a-number' });
      const snapshot = manager.createPairSnapshot(pair);
      expect(snapshot).toBeNull();
    });

    it('should validate and default fee to 0.003', () => {
      const pair = createMockPair({ fee: undefined });
      const snapshot = manager.createPairSnapshot(pair);
      expect(snapshot!.fee).toBe(0.003); // Default fee
    });

    it('should use provided valid fee', () => {
      const pair = createMockPair({ fee: 0.001 });
      const snapshot = manager.createPairSnapshot(pair);
      expect(snapshot!.fee).toBe(0.001);
    });

    it('should reject invalid negative fee and use default', () => {
      const pair = createMockPair({ fee: -0.5 });
      const snapshot = manager.createPairSnapshot(pair);
      expect(snapshot!.fee).toBe(0.003); // Default
    });

    it('should reject fee > 1 and use default', () => {
      const pair = createMockPair({ fee: 1.5 });
      const snapshot = manager.createPairSnapshot(pair);
      expect(snapshot!.fee).toBe(0.003); // Default
    });
  });

  // ===========================================================================
  // Batch Snapshot Creation with Caching
  // ===========================================================================

  describe('createPairsSnapshot (batch with caching)', () => {
    it('should create snapshots for all valid pairs', () => {
      const pairs = new Map<string, ExtendedPair>();
      pairs.set('pair1', createMockPair({ address: '0xpair1' }));
      pairs.set('pair2', createMockPair({ address: '0xpair2' }));
      pairs.set('pair3', createMockPair({ address: '0xpair3' }));

      const snapshots = manager.createPairsSnapshot(pairs);

      expect(snapshots.size).toBe(3);
      expect(snapshots.has('0xpair1')).toBe(true);
      expect(snapshots.has('0xpair2')).toBe(true);
      expect(snapshots.has('0xpair3')).toBe(true);
    });

    it('should filter out invalid pairs', () => {
      const pairs = new Map<string, ExtendedPair>();
      pairs.set('valid', createMockPair({ address: '0xvalid' }));
      pairs.set('invalid', createMockPair({ address: '0xinvalid', reserve0: '0' }));

      const snapshots = manager.createPairsSnapshot(pairs);

      expect(snapshots.size).toBe(1);
      expect(snapshots.has('0xvalid')).toBe(true);
      expect(snapshots.has('0xinvalid')).toBe(false);
    });

    it('should return cached result within TTL', () => {
      const pairs = new Map<string, ExtendedPair>();
      pairs.set('pair1', createMockPair({ address: '0xpair1' }));

      const first = manager.createPairsSnapshot(pairs);
      const second = manager.createPairsSnapshot(pairs);

      expect(first).toBe(second); // Same reference (cached)
    });

    it('should refresh cache after TTL expires', async () => {
      const shortTtlManager = createSnapshotManager({ cacheTtlMs: 10 });

      const pairs = new Map<string, ExtendedPair>();
      pairs.set('pair1', createMockPair({ address: '0xpair1' }));

      const first = shortTtlManager.createPairsSnapshot(pairs);

      // Advance Date.now() past TTL to expire cache
      const originalDateNow = Date.now;
      Date.now = () => originalDateNow() + 20;

      const second = shortTtlManager.createPairsSnapshot(pairs);

      Date.now = originalDateNow;

      expect(first).not.toBe(second); // Different reference (refreshed)

      shortTtlManager.clear();
    });

    it('should force refresh when forceRefresh is true', () => {
      const pairs = new Map<string, ExtendedPair>();
      pairs.set('pair1', createMockPair({ address: '0xpair1' }));

      const first = manager.createPairsSnapshot(pairs);
      const second = manager.createPairsSnapshot(pairs, true); // Force refresh

      expect(first).not.toBe(second); // Different reference
    });
  });

  // ===========================================================================
  // Cache Invalidation
  // ===========================================================================

  describe('Cache Invalidation', () => {
    it('should invalidate cache', () => {
      const pairs = new Map<string, ExtendedPair>();
      pairs.set('pair1', createMockPair({ address: '0xpair1' }));

      const first = manager.createPairsSnapshot(pairs);
      manager.invalidateCache();
      const second = manager.createPairsSnapshot(pairs);

      expect(first).not.toBe(second);
    });

    it('should increment version on invalidation', () => {
      const version1 = manager.getSnapshotVersion();
      manager.invalidateCache();
      const version2 = manager.getSnapshotVersion();

      expect(version2).toBeGreaterThan(version1);
    });

    it('should clear all caches on clear()', () => {
      const pairs = new Map<string, ExtendedPair>();
      pairs.set('pair1', createMockPair({ address: '0xpair1' }));

      manager.createPairsSnapshot(pairs);
      manager.clear();

      // After clear, version should reset
      expect(manager.getSnapshotVersion()).toBe(0);
    });
  });

  // ===========================================================================
  // DexPool Conversion
  // ===========================================================================

  describe('getDexPools', () => {
    it('should convert snapshots to DexPool format', () => {
      const pairs = new Map<string, ExtendedPair>();
      pairs.set('pair1', createMockPair({
        address: '0xpair1',
        dex: 'uniswap',
        token0: '0xtoken0',
        token1: '0xtoken1',
        fee: 0.003,
      }));

      const snapshots = manager.createPairsSnapshot(pairs);
      const pools = manager.getDexPools(snapshots);

      expect(pools.length).toBe(1);
      expect(pools[0].dex).toBe('uniswap');
      expect(pools[0].token0).toBe('0xtoken0');
      expect(pools[0].token1).toBe('0xtoken1');
      expect(pools[0].fee).toBe(30); // 0.003 → 30 basis points
    });

    it('should use version-based caching for pools', () => {
      const pairs = new Map<string, ExtendedPair>();
      pairs.set('pair1', createMockPair({ address: '0xpair1' }));

      const snapshots = manager.createPairsSnapshot(pairs);
      const pools1 = manager.getDexPools(snapshots);
      const pools2 = manager.getDexPools(snapshots);

      expect(pools1).toBe(pools2); // Same reference (cached)
    });

    it('should recalculate pools when version changes', () => {
      const pairs = new Map<string, ExtendedPair>();
      pairs.set('pair1', createMockPair({ address: '0xpair1' }));

      const snapshots1 = manager.createPairsSnapshot(pairs);
      const pools1 = manager.getDexPools(snapshots1);

      manager.invalidateCache(); // Increment version

      const snapshots2 = manager.createPairsSnapshot(pairs);
      const pools2 = manager.getDexPools(snapshots2);

      expect(pools1).not.toBe(pools2); // Different reference
    });

    it('should calculate price from reserves', () => {
      const pairs = new Map<string, ExtendedPair>();
      pairs.set('pair1', createMockPair({
        address: '0xpair1',
        reserve0: '1000000000000000000', // 1 token0
        reserve1: '2000000000000000000', // 2 token1
      }));

      const snapshots = manager.createPairsSnapshot(pairs);
      const pools = manager.getDexPools(snapshots);

      // Price should be reserve1/reserve0 = 2
      expect(pools[0].price).toBeCloseTo(2, 5);
    });

    it('should calculate liquidity from reserves', () => {
      const pairs = new Map<string, ExtendedPair>();
      pairs.set('pair1', createMockPair({
        address: '0xpair1',
        reserve0: '1000000000000000000', // 1 token0
        reserve1: '2000000000000000000', // 2 token1
      }));

      const snapshots = manager.createPairsSnapshot(pairs);
      const pools = manager.getDexPools(snapshots);

      // Liquidity = reserve0 * price * 2 = 1 * 2 * 2 = 4
      expect(pools[0].liquidity).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should handle empty pairs map', () => {
      const pairs = new Map<string, ExtendedPair>();
      const snapshots = manager.createPairsSnapshot(pairs);
      expect(snapshots.size).toBe(0);
    });

    it('should handle very large reserves', () => {
      const pair = createMockPair({
        reserve0: '999999999999999999999999999999999999', // Very large
        reserve1: '888888888888888888888888888888888888',
      });

      const snapshot = manager.createPairSnapshot(pair);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.reserve0BigInt).toBe(BigInt(pair.reserve0));
    });

    it('should handle reserves with leading zeros', () => {
      const pair = createMockPair({
        reserve0: '0001000000000000000000',
        reserve1: '0002000000000000000000',
      });

      const snapshot = manager.createPairSnapshot(pair);
      expect(snapshot).not.toBeNull();
    });

    it('should pass through pre-normalized addresses as-is', () => {
      // HOT-PATH OPT (Perf-3): Addresses are pre-normalized at pair creation time.
      // createPairSnapshot no longer lowercases defensively for hot-path performance.
      const pair = createMockPair({
        address: '0xabcdef',
        token0: '0xtoken0addr',
        token1: '0xtoken1addr',
      });

      const snapshot = manager.createPairSnapshot(pair);

      expect(snapshot!.address).toBe('0xabcdef');
      expect(snapshot!.token0).toBe('0xtoken0addr');
      expect(snapshot!.token1).toBe('0xtoken1addr');
    });
  });

  // ===========================================================================
  // Concurrent Access (Race Condition Tests)
  // ===========================================================================

  describe('Concurrent Access (Race 5.2)', () => {
    it('should handle concurrent createPairsSnapshot calls', async () => {
      const pairs = new Map<string, ExtendedPair>();
      for (let i = 0; i < 100; i++) {
        pairs.set(`pair${i}`, createMockPair({ address: `0xpair${i}` }));
      }

      // Multiple concurrent calls
      const results = await Promise.all([
        Promise.resolve(manager.createPairsSnapshot(pairs)),
        Promise.resolve(manager.createPairsSnapshot(pairs)),
        Promise.resolve(manager.createPairsSnapshot(pairs)),
      ]);

      // All should complete successfully with same size
      expect(results[0].size).toBe(100);
      expect(results[1].size).toBe(100);
      expect(results[2].size).toBe(100);
    });

    it('should handle concurrent invalidation and snapshot creation', async () => {
      const pairs = new Map<string, ExtendedPair>();
      pairs.set('pair1', createMockPair({ address: '0xpair1' }));

      // Interleaved operations
      const operations = [];
      for (let i = 0; i < 10; i++) {
        operations.push(Promise.resolve(manager.createPairsSnapshot(pairs)));
        if (i % 2 === 0) {
          manager.invalidateCache();
        }
      }

      const results = await Promise.all(operations);

      // All operations should complete successfully
      results.forEach(result => {
        expect(result.size).toBe(1);
      });
    });
  });
});
