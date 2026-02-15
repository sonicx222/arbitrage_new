/**
 * Solana Pool Manager Unit Tests
 *
 * Tests for pool CRUD, indexing, mutex-protected writes,
 * and immutable pool objects on price updates.
 */

import { createSolanaPoolManager, type SolanaPoolManager } from '../../../src/solana/solana-pool-manager';
import { createMockLogger, createTestPool } from './solana-test-helpers';

describe('SolanaPoolManager', () => {
  let poolManager: SolanaPoolManager;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
    poolManager = createSolanaPoolManager({ logger });
  });

  // =========================================================================
  // addPool
  // =========================================================================

  describe('addPool', () => {
    it('should store pool and update all three indices', async () => {
      const pool = createTestPool();
      await poolManager.addPool(pool);

      expect(poolManager.getPool(pool.address)).toEqual(pool);
      expect(poolManager.getPoolsByDex('raydium')).toHaveLength(1);
      expect(poolManager.getPoolsByTokenPair(pool.token0.mint, pool.token1.mint)).toHaveLength(1);
    });

    it('should normalize token pair key alphabetically', async () => {
      const pool = createTestPool();
      await poolManager.addPool(pool);

      // Both orderings should find the pool
      const byForward = poolManager.getPoolsByTokenPair(pool.token0.mint, pool.token1.mint);
      const byReverse = poolManager.getPoolsByTokenPair(pool.token1.mint, pool.token0.mint);
      expect(byForward).toHaveLength(1);
      expect(byReverse).toHaveLength(1);
    });

    it('should warn for unknown program ID', async () => {
      const pool = createTestPool({ programId: 'UnknownProgramXYZ111111111111111111111111111' });
      await poolManager.addPool(pool);

      expect(logger.warn).toHaveBeenCalledWith(
        'Pool added with unknown program ID',
        expect.objectContaining({ programId: pool.programId })
      );
    });

    it('should handle multiple pools in same DEX', async () => {
      const pool1 = createTestPool({ address: 'Pool1Addr1111111111111111111111111111111111' });
      const pool2 = createTestPool({
        address: 'Pool2Addr1111111111111111111111111111111111',
        token0: { mint: 'TokenA1111111111111111111111111111111111111', symbol: 'A', decimals: 9 },
        token1: { mint: 'TokenB1111111111111111111111111111111111111', symbol: 'B', decimals: 6 },
      });

      await poolManager.addPool(pool1);
      await poolManager.addPool(pool2);

      expect(poolManager.getPoolsByDex('raydium')).toHaveLength(2);
    });

    it('should handle multiple pools for same token pair across DEXes', async () => {
      const pool1 = createTestPool({ address: 'RaydiumPool111111111111111111111111111111111', dex: 'raydium' });
      const pool2 = createTestPool({ address: 'OrcaPool1111111111111111111111111111111111111', dex: 'orca' });

      await poolManager.addPool(pool1);
      await poolManager.addPool(pool2);

      expect(poolManager.getPoolsByTokenPair(pool1.token0.mint, pool1.token1.mint)).toHaveLength(2);
    });

    it('should return correct pool count', async () => {
      await poolManager.addPool(createTestPool({ address: 'A1111111111111111111111111111111111111111111' }));
      await poolManager.addPool(createTestPool({ address: 'B1111111111111111111111111111111111111111111' }));
      await poolManager.addPool(createTestPool({ address: 'C1111111111111111111111111111111111111111111' }));

      expect(poolManager.getPoolCount()).toBe(3);
    });
  });

  // =========================================================================
  // removePool
  // =========================================================================

  describe('removePool', () => {
    it('should remove pool from all three indices', async () => {
      const pool = createTestPool();
      await poolManager.addPool(pool);
      await poolManager.removePool(pool.address);

      expect(poolManager.getPool(pool.address)).toBeUndefined();
      expect(poolManager.getPoolsByDex('raydium')).toHaveLength(0);
      expect(poolManager.getPoolsByTokenPair(pool.token0.mint, pool.token1.mint)).toHaveLength(0);
    });

    it('should clean up empty Set when removing last pool in a DEX', async () => {
      const pool = createTestPool();
      await poolManager.addPool(pool);
      await poolManager.removePool(pool.address);

      // After removing the only pool, the DEX key should be cleaned up
      expect(poolManager.getPoolsByDex('raydium')).toEqual([]);
    });

    it('should be a no-op for unknown address', async () => {
      await poolManager.removePool('nonexistent');
      expect(poolManager.getPoolCount()).toBe(0);
    });

    it('should not affect other pools in same DEX', async () => {
      const pool1 = createTestPool({ address: 'Pool1Addr1111111111111111111111111111111111' });
      const pool2 = createTestPool({ address: 'Pool2Addr1111111111111111111111111111111111' });

      await poolManager.addPool(pool1);
      await poolManager.addPool(pool2);
      await poolManager.removePool(pool1.address);

      expect(poolManager.getPool(pool2.address)).toBeDefined();
      expect(poolManager.getPoolsByDex('raydium')).toHaveLength(1);
    });
  });

  // =========================================================================
  // updatePoolPrice
  // =========================================================================

  describe('updatePoolPrice', () => {
    it('should create new pool object (immutable pattern)', async () => {
      const pool = createTestPool({ price: 100 });
      await poolManager.addPool(pool);
      const originalRef = poolManager.getPool(pool.address);

      await poolManager.updatePoolPrice(pool.address, {
        price: 110,
        reserve0: '1100000000',
        reserve1: '100000000',
        slot: 200000002
      });

      const updatedRef = poolManager.getPool(pool.address);
      expect(updatedRef).not.toBe(originalRef);
      expect(updatedRef?.price).toBe(110);
      expect(originalRef?.price).toBe(100); // Original unchanged
    });

    it('should update reserve0, reserve1, lastSlot fields', async () => {
      const pool = createTestPool({ reserve0: '1000', reserve1: '2000', lastSlot: 100 });
      await poolManager.addPool(pool);

      await poolManager.updatePoolPrice(pool.address, {
        price: 105,
        reserve0: '1100',
        reserve1: '1900',
        slot: 101
      });

      const updated = poolManager.getPool(pool.address);
      expect(updated?.reserve0).toBe('1100');
      expect(updated?.reserve1).toBe('1900');
      expect(updated?.lastSlot).toBe(101);
    });

    it('should warn and skip update for unknown pool', async () => {
      await poolManager.updatePoolPrice('unknown', { price: 100, reserve0: '1', reserve1: '1', slot: 1 });
      expect(logger.warn).toHaveBeenCalledWith('Pool not found for price update', { poolAddress: 'unknown' });
    });

    it('should preserve non-updated fields', async () => {
      const pool = createTestPool({ dex: 'raydium', fee: 25 });
      await poolManager.addPool(pool);

      await poolManager.updatePoolPrice(pool.address, { price: 110, reserve0: '1', reserve1: '1', slot: 1 });

      const updated = poolManager.getPool(pool.address);
      expect(updated?.dex).toBe('raydium');
      expect(updated?.fee).toBe(25);
    });
  });

  // =========================================================================
  // Query methods
  // =========================================================================

  describe('query methods', () => {
    it('should return undefined for unknown pool address', () => {
      expect(poolManager.getPool('nonexistent')).toBeUndefined();
    });

    it('should return empty array for unknown DEX', () => {
      expect(poolManager.getPoolsByDex('nonexistent')).toEqual([]);
    });

    it('should return empty array for unknown token pair', () => {
      expect(poolManager.getPoolsByTokenPair('tokenX', 'tokenY')).toEqual([]);
    });
  });

  // =========================================================================
  // getPoolsSnapshot
  // =========================================================================

  describe('getPoolsSnapshot', () => {
    it('should return a copy of pools map', async () => {
      const pool = createTestPool({ price: 100 });
      await poolManager.addPool(pool);

      const snapshot = poolManager.getPoolsSnapshot();
      expect(snapshot.pools.size).toBe(1);
      expect(snapshot.pools.get(pool.address)?.price).toBe(100);

      // Mutating snapshot should not affect the manager
      snapshot.pools.delete(pool.address);
      expect(poolManager.getPoolCount()).toBe(1);
    });

    it('should return pair entries', async () => {
      const pool = createTestPool();
      await poolManager.addPool(pool);

      const snapshot = poolManager.getPoolsSnapshot();
      expect(snapshot.pairEntries.length).toBe(1);
      expect(snapshot.pairEntries[0][1].size).toBe(1);
    });
  });

  // =========================================================================
  // cleanup
  // =========================================================================

  describe('cleanup', () => {
    it('should clear all pools and indices', async () => {
      await poolManager.addPool(createTestPool({ address: 'A11111111111111111111111111111111' }));
      await poolManager.addPool(createTestPool({ address: 'B11111111111111111111111111111111' }));

      poolManager.cleanup();

      expect(poolManager.getPoolCount()).toBe(0);
      expect(poolManager.getPoolsByDex('raydium')).toEqual([]);
    });
  });

  // =========================================================================
  // REGRESSION: Mutex consistency
  // =========================================================================

  describe('REGRESSION: Pool mutex consistency', () => {
    it('should keep all three maps consistent after concurrent operations', async () => {
      const pool = createTestPool();

      // Run add and remove concurrently
      await Promise.all([
        poolManager.addPool(pool),
        poolManager.removePool(pool.address),
      ]);

      // After both settle, pool should be either fully present or fully absent
      const inPools = poolManager.getPool(pool.address) !== undefined;
      const inDex = poolManager.getPoolsByDex('raydium').length > 0;
      const inPair = poolManager.getPoolsByTokenPair(pool.token0.mint, pool.token1.mint).length > 0;

      // All three should agree
      expect(inDex).toBe(inPools);
      expect(inPair).toBe(inPools);
    });

    it('should create new object reference on updatePoolPrice (immutable)', async () => {
      const pool = createTestPool({ price: 100 });
      await poolManager.addPool(pool);
      const before = poolManager.getPool(pool.address);

      await poolManager.updatePoolPrice(pool.address, { price: 110, reserve0: '1', reserve1: '1', slot: 1 });
      const after = poolManager.getPool(pool.address);

      expect(after).not.toBe(before);
      expect(before?.price).toBe(100);
      expect(after?.price).toBe(110);
    });
  });

  // =========================================================================
  // REGRESSION: Snapshot isolation (Fix #3)
  // =========================================================================

  describe('REGRESSION: getPoolsSnapshot Set isolation', () => {
    it('should return deep-copied Sets in pairEntries', async () => {
      const pool = createTestPool();
      await poolManager.addPool(pool);

      const snapshot = poolManager.getPoolsSnapshot();

      // Mutating the snapshot Set should NOT affect the manager's internal Set
      snapshot.pairEntries[0][1].add('FAKE_ADDRESS');

      // Take a new snapshot — should not contain the fake address
      const snapshot2 = poolManager.getPoolsSnapshot();
      expect(snapshot2.pairEntries[0][1].has('FAKE_ADDRESS')).toBe(false);
      expect(snapshot2.pairEntries[0][1].size).toBe(1);
    });

    it('should not be affected by pool additions after snapshot', async () => {
      const pool1 = createTestPool({ address: 'A11111111111111111111111111111111' });
      await poolManager.addPool(pool1);

      const snapshot = poolManager.getPoolsSnapshot();
      const initialSize = snapshot.pairEntries[0][1].size;

      // Add another pool to the same pair after snapshot
      const pool2 = createTestPool({ address: 'B11111111111111111111111111111111' });
      await poolManager.addPool(pool2);

      // Original snapshot should still have the original size
      expect(snapshot.pairEntries[0][1].size).toBe(initialSize);
    });
  });
});
