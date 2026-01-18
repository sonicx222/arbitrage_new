/**
 * Unit Tests for PairRepository
 *
 * Tests the in-memory pair storage with O(1) lookups.
 */

import {
  PairRepository,
  createPairRepository,
  PairSnapshot,
} from '../../../src/components/pair-repository';
import type { Pair } from '../../../../types/src';

describe('PairRepository', () => {
  let repository: PairRepository;

  // Test fixtures
  const pair1: Pair = {
    address: '0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc',
    token0: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    token1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
    dex: 'uniswapv2',
    fee: 0.003,
    reserve0: '1000000000000000000000', // 1000 ETH
    reserve1: '3500000000000', // 3500000 USDC
    blockNumber: 12345678,
  };

  const pair2: Pair = {
    address: '0x397FF1542f962076d0BFE58eA045FfA2d347ACa0',
    token0: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    token1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
    dex: 'sushiswap',
    fee: 0.003,
    reserve0: '500000000000000000000', // 500 ETH
    reserve1: '1750000000000', // 1750000 USDC
    blockNumber: 12345679,
  };

  const pair3: Pair = {
    address: '0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852',
    token0: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    token1: '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
    dex: 'uniswapv2',
    fee: 0.003,
    reserve0: '800000000000000000000', // 800 ETH
    reserve1: '2800000000000', // 2800000 USDT
    blockNumber: 12345680,
  };

  beforeEach(() => {
    repository = createPairRepository();
  });

  // ===========================================================================
  // Core CRUD Operations
  // ===========================================================================
  describe('Core CRUD Operations', () => {
    describe('set / get', () => {
      it('should add a new pair', () => {
        const isNew = repository.set('uniswapv2_WETH_USDC', pair1);
        expect(isNew).toBe(true);
        expect(repository.get('uniswapv2_WETH_USDC')).toBe(pair1);
      });

      it('should return false when updating existing pair', () => {
        repository.set('uniswapv2_WETH_USDC', pair1);
        const updatedPair = { ...pair1, reserve0: '2000000000000000000000' };
        const isNew = repository.set('uniswapv2_WETH_USDC', updatedPair);
        expect(isNew).toBe(false);
        expect(repository.get('uniswapv2_WETH_USDC')).toBe(updatedPair);
      });

      it('should return undefined for non-existent key', () => {
        expect(repository.get('non_existent')).toBeUndefined();
      });
    });

    describe('getByAddress', () => {
      it('should get pair by address (O(1) lookup)', () => {
        repository.set('uniswapv2_WETH_USDC', pair1);
        const found = repository.getByAddress(pair1.address);
        expect(found).toBe(pair1);
      });

      it('should be case-insensitive', () => {
        repository.set('uniswapv2_WETH_USDC', pair1);
        const found = repository.getByAddress(pair1.address.toLowerCase());
        expect(found).toBe(pair1);
      });

      it('should return undefined for non-existent address', () => {
        expect(repository.getByAddress('0x0000000000000000000000000000000000000000')).toBeUndefined();
      });
    });

    describe('getByTokens', () => {
      it('should get pairs by token combination (O(1) lookup)', () => {
        repository.set('uniswapv2_WETH_USDC', pair1);
        repository.set('sushiswap_WETH_USDC', pair2);

        const pairs = repository.getByTokens(pair1.token0, pair1.token1);
        expect(pairs).toHaveLength(2);
        expect(pairs).toContain(pair1);
        expect(pairs).toContain(pair2);
      });

      it('should work regardless of token order', () => {
        repository.set('uniswapv2_WETH_USDC', pair1);

        const pairs1 = repository.getByTokens(pair1.token0, pair1.token1);
        const pairs2 = repository.getByTokens(pair1.token1, pair1.token0);

        expect(pairs1).toHaveLength(1);
        expect(pairs2).toHaveLength(1);
        expect(pairs1[0]).toBe(pairs2[0]);
      });

      it('should return empty array for non-existent token pair', () => {
        const pairs = repository.getByTokens('0x0000', '0x0001');
        expect(pairs).toEqual([]);
      });

      it('should not include pairs with different tokens', () => {
        repository.set('uniswapv2_WETH_USDC', pair1);
        repository.set('uniswapv2_WETH_USDT', pair3);

        const usdcPairs = repository.getByTokens(pair1.token0, pair1.token1);
        expect(usdcPairs).toHaveLength(1);
        expect(usdcPairs[0]).toBe(pair1);
      });
    });

    describe('has / hasAddress', () => {
      it('should return true for existing key', () => {
        repository.set('uniswapv2_WETH_USDC', pair1);
        expect(repository.has('uniswapv2_WETH_USDC')).toBe(true);
      });

      it('should return false for non-existent key', () => {
        expect(repository.has('non_existent')).toBe(false);
      });

      it('should return true for existing address', () => {
        repository.set('uniswapv2_WETH_USDC', pair1);
        expect(repository.hasAddress(pair1.address)).toBe(true);
      });

      it('should return false for non-existent address', () => {
        expect(repository.hasAddress('0x0000')).toBe(false);
      });
    });

    describe('delete', () => {
      it('should delete pair by key', () => {
        repository.set('uniswapv2_WETH_USDC', pair1);
        const deleted = repository.delete('uniswapv2_WETH_USDC');

        expect(deleted).toBe(true);
        expect(repository.get('uniswapv2_WETH_USDC')).toBeUndefined();
        expect(repository.getByAddress(pair1.address)).toBeUndefined();
        expect(repository.getByTokens(pair1.token0, pair1.token1)).toEqual([]);
      });

      it('should return false for non-existent key', () => {
        expect(repository.delete('non_existent')).toBe(false);
      });

      it('should only remove the specific pair from token index', () => {
        repository.set('uniswapv2_WETH_USDC', pair1);
        repository.set('sushiswap_WETH_USDC', pair2);

        repository.delete('uniswapv2_WETH_USDC');

        const pairs = repository.getByTokens(pair1.token0, pair1.token1);
        expect(pairs).toHaveLength(1);
        expect(pairs[0]).toBe(pair2);
      });
    });

    describe('deleteByAddress', () => {
      it('should delete pair by address', () => {
        repository.set('uniswapv2_WETH_USDC', pair1);
        const deleted = repository.deleteByAddress(pair1.address);

        expect(deleted).toBe(true);
        expect(repository.get('uniswapv2_WETH_USDC')).toBeUndefined();
      });

      it('should return false for non-existent address', () => {
        expect(repository.deleteByAddress('0x0000')).toBe(false);
      });
    });

    describe('clear', () => {
      it('should clear all pairs', () => {
        repository.set('uniswapv2_WETH_USDC', pair1);
        repository.set('sushiswap_WETH_USDC', pair2);
        repository.set('uniswapv2_WETH_USDT', pair3);

        repository.clear();

        expect(repository.size).toBe(0);
        expect(repository.get('uniswapv2_WETH_USDC')).toBeUndefined();
        expect(repository.getByAddress(pair1.address)).toBeUndefined();
        expect(repository.getByTokens(pair1.token0, pair1.token1)).toEqual([]);
      });
    });
  });

  // ===========================================================================
  // Snapshot Operations
  // ===========================================================================
  describe('Snapshot Operations', () => {
    describe('createSnapshot', () => {
      it('should create snapshot with all fields', () => {
        const snapshot = repository.createSnapshot(pair1);

        expect(snapshot).not.toBeNull();
        expect(snapshot!.address).toBe(pair1.address);
        expect(snapshot!.dex).toBe(pair1.dex);
        expect(snapshot!.token0).toBe(pair1.token0);
        expect(snapshot!.token1).toBe(pair1.token1);
        expect(snapshot!.reserve0).toBe(pair1.reserve0);
        expect(snapshot!.reserve1).toBe(pair1.reserve1);
        expect(snapshot!.fee).toBe(pair1.fee);
        expect(snapshot!.blockNumber).toBe(pair1.blockNumber);
      });

      it('should return null for pair without reserves', () => {
        const pairNoReserves: Pair = {
          address: '0x1234',
          token0: '0x0000',
          token1: '0x0001',
          dex: 'test',
        };
        expect(repository.createSnapshot(pairNoReserves)).toBeNull();
      });

      it('should return null for pair with zero reserves', () => {
        const pairZeroReserves: Pair = {
          ...pair1,
          reserve0: '0',
          reserve1: '100',
        };
        expect(repository.createSnapshot(pairZeroReserves)).toBeNull();
      });

      it('should use default fee if pair.fee is undefined', () => {
        const pairNoFee: Pair = {
          ...pair1,
          fee: undefined,
        };
        const snapshot = repository.createSnapshot(pairNoFee);
        expect(snapshot!.fee).toBe(0.003); // Default fee
      });

      it('should use custom default fee from options', () => {
        const pairNoFee: Pair = {
          ...pair1,
          fee: undefined,
        };
        const snapshot = repository.createSnapshot(pairNoFee, { defaultFee: 0.001 });
        expect(snapshot!.fee).toBe(0.001);
      });

      it('should handle fee: 0 correctly (not use default)', () => {
        const pairZeroFee: Pair = {
          ...pair1,
          fee: 0,
        };
        const snapshot = repository.createSnapshot(pairZeroFee);
        expect(snapshot!.fee).toBe(0);
      });
    });

    describe('createAllSnapshots', () => {
      it('should create snapshots for all pairs with reserves', () => {
        repository.set('uniswapv2_WETH_USDC', pair1);
        repository.set('sushiswap_WETH_USDC', pair2);

        const snapshots = repository.createAllSnapshots();

        expect(snapshots.size).toBe(2);
        expect(snapshots.get('uniswapv2_WETH_USDC')).toBeDefined();
        expect(snapshots.get('sushiswap_WETH_USDC')).toBeDefined();
      });

      it('should skip pairs without reserves', () => {
        repository.set('uniswapv2_WETH_USDC', pair1);
        repository.set('incomplete', { ...pair1, address: '0x9999', reserve0: undefined });

        const snapshots = repository.createAllSnapshots();

        expect(snapshots.size).toBe(1);
        expect(snapshots.has('incomplete')).toBe(false);
      });
    });

    describe('createSnapshotsForTokens', () => {
      it('should create snapshots for specific token pair', () => {
        repository.set('uniswapv2_WETH_USDC', pair1);
        repository.set('sushiswap_WETH_USDC', pair2);
        repository.set('uniswapv2_WETH_USDT', pair3);

        const snapshots = repository.createSnapshotsForTokens(pair1.token0, pair1.token1);

        expect(snapshots).toHaveLength(2);
        expect(snapshots.map(s => s.dex)).toContain('uniswapv2');
        expect(snapshots.map(s => s.dex)).toContain('sushiswap');
      });

      it('should return empty array if no pairs exist', () => {
        const snapshots = repository.createSnapshotsForTokens('0x0000', '0x0001');
        expect(snapshots).toEqual([]);
      });
    });
  });

  // ===========================================================================
  // Iteration
  // ===========================================================================
  describe('Iteration', () => {
    beforeEach(() => {
      repository.set('uniswapv2_WETH_USDC', pair1);
      repository.set('sushiswap_WETH_USDC', pair2);
      repository.set('uniswapv2_WETH_USDT', pair3);
    });

    it('should return correct size', () => {
      expect(repository.size).toBe(3);
    });

    it('should iterate over values', () => {
      const values = Array.from(repository.values());
      expect(values).toHaveLength(3);
      expect(values).toContain(pair1);
      expect(values).toContain(pair2);
      expect(values).toContain(pair3);
    });

    it('should iterate over entries', () => {
      const entries = Array.from(repository.entries());
      expect(entries).toHaveLength(3);
    });

    it('should iterate over keys', () => {
      const keys = Array.from(repository.keys());
      expect(keys).toHaveLength(3);
      expect(keys).toContain('uniswapv2_WETH_USDC');
      expect(keys).toContain('sushiswap_WETH_USDC');
      expect(keys).toContain('uniswapv2_WETH_USDT');
    });

    it('should iterate over token pair keys', () => {
      const tokenPairKeys = Array.from(repository.tokenPairKeys());
      // 2 unique token pairs: WETH/USDC and WETH/USDT
      expect(tokenPairKeys).toHaveLength(2);
    });

    it('should execute forEach callback', () => {
      const callback = jest.fn();
      repository.forEach(callback);
      expect(callback).toHaveBeenCalledTimes(3);
    });
  });

  // ===========================================================================
  // Statistics
  // ===========================================================================
  describe('Statistics', () => {
    it('should return correct stats', () => {
      repository.set('uniswapv2_WETH_USDC', pair1);
      repository.set('sushiswap_WETH_USDC', pair2);
      repository.set('incomplete', { ...pair1, address: '0x9999', reserve0: undefined });

      const stats = repository.getStats();

      expect(stats.totalPairs).toBe(3);
      expect(stats.pairsWithReserves).toBe(2);
      // All 3 pairs have the same tokens (WETH/USDC)
      expect(stats.uniqueTokenPairs).toBe(1);
      // 3 pairs in the token index / 1 unique token pair = 3
      expect(stats.avgPairsPerTokenPair).toBe(3);
    });

    it('should handle empty repository', () => {
      const stats = repository.getStats();

      expect(stats.totalPairs).toBe(0);
      expect(stats.pairsWithReserves).toBe(0);
      expect(stats.uniqueTokenPairs).toBe(0);
      expect(stats.avgPairsPerTokenPair).toBe(0);
    });
  });

  // ===========================================================================
  // Change Notifications
  // ===========================================================================
  describe('Change Notifications', () => {
    it('should notify on add', () => {
      const callback = jest.fn();
      repository.setChangeCallback(callback);

      repository.set('uniswapv2_WETH_USDC', pair1);

      expect(callback).toHaveBeenCalledWith(pair1, 'add');
    });

    it('should notify on update', () => {
      repository.set('uniswapv2_WETH_USDC', pair1);

      const callback = jest.fn();
      repository.setChangeCallback(callback);

      const updatedPair = { ...pair1, reserve0: '2000000000000000000000' };
      repository.set('uniswapv2_WETH_USDC', updatedPair);

      expect(callback).toHaveBeenCalledWith(updatedPair, 'update');
    });

    it('should notify on remove', () => {
      repository.set('uniswapv2_WETH_USDC', pair1);

      const callback = jest.fn();
      repository.setChangeCallback(callback);

      repository.delete('uniswapv2_WETH_USDC');

      expect(callback).toHaveBeenCalledWith(pair1, 'remove');
    });

    it('should not notify after clearing callback', () => {
      const callback = jest.fn();
      repository.setChangeCallback(callback);
      repository.setChangeCallback(null);

      repository.set('uniswapv2_WETH_USDC', pair1);

      expect(callback).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Edge Cases and Regression Tests
  // ===========================================================================
  describe('Edge Cases', () => {
    it('should handle updating pair with different address', () => {
      repository.set('test', pair1);

      // Update with different address (unusual but should work)
      const updatedPair = { ...pair1, address: '0xDIFFERENT' };
      repository.set('test', updatedPair);

      // Old address should not be indexed
      expect(repository.getByAddress(pair1.address)).toBeUndefined();
      // New address should be indexed
      expect(repository.getByAddress('0xDIFFERENT')).toBe(updatedPair);
    });

    it('should prevent duplicate pairs in token index', () => {
      repository.set('uniswapv2_WETH_USDC', pair1);
      repository.set('uniswapv2_WETH_USDC', pair1); // Re-add same pair

      const pairs = repository.getByTokens(pair1.token0, pair1.token1);
      expect(pairs).toHaveLength(1);
    });

    it('should handle case-insensitive token addresses in key generation', () => {
      repository.set('test', pair1);

      // Should find regardless of case
      const lower = repository.getByTokens(
        pair1.token0.toLowerCase(),
        pair1.token1.toLowerCase()
      );
      const upper = repository.getByTokens(
        pair1.token0.toUpperCase(),
        pair1.token1.toUpperCase()
      );

      expect(lower).toHaveLength(1);
      expect(upper).toHaveLength(1);
      expect(lower[0]).toBe(upper[0]);
    });
  });

  // ===========================================================================
  // Factory Function
  // ===========================================================================
  describe('Factory Function', () => {
    it('should create new instance', () => {
      const repo = createPairRepository();
      expect(repo).toBeInstanceOf(PairRepository);
    });
  });
});
