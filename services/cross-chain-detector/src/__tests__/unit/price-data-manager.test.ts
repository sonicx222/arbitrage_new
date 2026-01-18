/**
 * Unit Tests for PriceDataManager
 *
 * Tests the price data management module extracted from CrossChainDetectorService.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  createPriceDataManager,
  PriceDataManager,
} from '../../price-data-manager';
import { PriceUpdate } from '@arbitrage/types';

// =============================================================================
// Helper
// =============================================================================

function createPriceUpdate(overrides?: Partial<PriceUpdate>): PriceUpdate {
  return {
    chain: 'ethereum',
    dex: 'uniswap',
    pairKey: 'WETH-USDC',
    price: 2500,
    timestamp: Date.now(),
    token0: 'WETH',
    token1: 'USDC',
    reserve0: '1000000000000000000',
    reserve1: '2500000000',
    blockNumber: 12345,
    latency: 50,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('PriceDataManager', () => {
  let mockLogger: {
    info: jest.Mock;
    error: jest.Mock;
    warn: jest.Mock;
    debug: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    };
  });

  // ===========================================================================
  // Creation
  // ===========================================================================

  describe('createPriceDataManager', () => {
    it('should create manager with required config', () => {
      const manager = createPriceDataManager({
        logger: mockLogger,
      });

      expect(manager).toBeDefined();
      expect(typeof manager.handlePriceUpdate).toBe('function');
      expect(typeof manager.createSnapshot).toBe('function');
      expect(typeof manager.getChains).toBe('function');
      expect(typeof manager.getPairCount).toBe('function');
      expect(typeof manager.cleanup).toBe('function');
      expect(typeof manager.clear).toBe('function');
    });
  });

  // ===========================================================================
  // handlePriceUpdate
  // ===========================================================================

  describe('handlePriceUpdate', () => {
    it('should store price update in hierarchical structure', () => {
      const manager = createPriceDataManager({
        logger: mockLogger,
      });

      const update = createPriceUpdate();

      manager.handlePriceUpdate(update);

      const snapshot = manager.createSnapshot();
      expect(snapshot.ethereum).toBeDefined();
      expect(snapshot.ethereum.uniswap).toBeDefined();
      expect(snapshot.ethereum.uniswap['WETH-USDC']).toEqual(update);
    });

    it('should create nested structure for new chains', () => {
      const manager = createPriceDataManager({
        logger: mockLogger,
      });

      const update = createPriceUpdate({
        chain: 'arbitrum',
        dex: 'camelot',
        pairKey: 'ARB-USDC',
        price: 1.5,
        token0: 'ARB',
        token1: 'USDC',
        blockNumber: 5000,
      });

      manager.handlePriceUpdate(update);

      expect(manager.getChains()).toContain('arbitrum');
    });

    it('should update existing price data', () => {
      const manager = createPriceDataManager({
        logger: mockLogger,
      });

      const update1 = createPriceUpdate({ price: 2500 });
      const update2 = createPriceUpdate({ price: 2550, timestamp: Date.now() + 1000 });

      manager.handlePriceUpdate(update1);
      manager.handlePriceUpdate(update2);

      const snapshot = manager.createSnapshot();
      expect(snapshot.ethereum.uniswap['WETH-USDC'].price).toBe(2550);
    });

    it('should trigger cleanup at configured frequency', () => {
      const manager = createPriceDataManager({
        logger: mockLogger,
        cleanupFrequency: 3, // Cleanup every 3 updates
        maxPriceAgeMs: 1000,
      });

      const now = Date.now();

      // Add old price that should be cleaned up
      manager.handlePriceUpdate(createPriceUpdate({
        pairKey: 'OLD-PAIR',
        price: 100,
        timestamp: now - 5000, // 5 seconds old (> maxPriceAgeMs)
      }));

      // Add 2 more updates to trigger cleanup (total 3)
      manager.handlePriceUpdate(createPriceUpdate({
        pairKey: 'NEW-PAIR-1',
        price: 200,
        timestamp: now,
      }));

      manager.handlePriceUpdate(createPriceUpdate({
        pairKey: 'NEW-PAIR-2',
        price: 300,
        timestamp: now,
      }));

      const snapshot = manager.createSnapshot();
      expect(snapshot.ethereum?.uniswap?.['OLD-PAIR']).toBeUndefined();
      expect(snapshot.ethereum.uniswap['NEW-PAIR-1']).toBeDefined();
      expect(snapshot.ethereum.uniswap['NEW-PAIR-2']).toBeDefined();
    });

    it('should handle errors gracefully', () => {
      const manager = createPriceDataManager({
        logger: mockLogger,
      });

      // This should not throw
      manager.handlePriceUpdate(null as any);
      manager.handlePriceUpdate(undefined as any);

      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // createSnapshot
  // ===========================================================================

  describe('createSnapshot', () => {
    it('should create deep copy of price data', () => {
      const manager = createPriceDataManager({
        logger: mockLogger,
      });

      const update = createPriceUpdate();

      manager.handlePriceUpdate(update);

      const snapshot1 = manager.createSnapshot();
      const snapshot2 = manager.createSnapshot();

      // Modify snapshot1
      snapshot1.ethereum.uniswap['WETH-USDC'].price = 9999;

      // snapshot2 should not be affected
      expect(snapshot2.ethereum.uniswap['WETH-USDC'].price).toBe(2500);
    });

    it('should return empty object when no data', () => {
      const manager = createPriceDataManager({
        logger: mockLogger,
      });

      const snapshot = manager.createSnapshot();
      expect(snapshot).toEqual({});
    });
  });

  // ===========================================================================
  // getChains
  // ===========================================================================

  describe('getChains', () => {
    it('should return list of monitored chains', () => {
      const manager = createPriceDataManager({
        logger: mockLogger,
      });

      manager.handlePriceUpdate(createPriceUpdate({
        chain: 'ethereum',
        dex: 'uniswap',
      }));

      manager.handlePriceUpdate(createPriceUpdate({
        chain: 'arbitrum',
        dex: 'camelot',
        pairKey: 'ARB-USDC',
        token0: 'ARB',
      }));

      const chains = manager.getChains();
      expect(chains).toContain('ethereum');
      expect(chains).toContain('arbitrum');
      expect(chains.length).toBe(2);
    });

    it('should return empty array when no data', () => {
      const manager = createPriceDataManager({
        logger: mockLogger,
      });

      expect(manager.getChains()).toEqual([]);
    });
  });

  // ===========================================================================
  // getPairCount
  // ===========================================================================

  describe('getPairCount', () => {
    it('should return total pair count across all chains/dexes', () => {
      const manager = createPriceDataManager({
        logger: mockLogger,
      });

      // 3 pairs across 2 chains
      manager.handlePriceUpdate(createPriceUpdate({
        chain: 'ethereum',
        dex: 'uniswap',
        pairKey: 'WETH-USDC',
      }));

      manager.handlePriceUpdate(createPriceUpdate({
        chain: 'ethereum',
        dex: 'sushiswap',
        pairKey: 'WETH-USDC',
      }));

      manager.handlePriceUpdate(createPriceUpdate({
        chain: 'arbitrum',
        dex: 'camelot',
        pairKey: 'ARB-USDC',
        token0: 'ARB',
      }));

      expect(manager.getPairCount()).toBe(3);
    });

    it('should return 0 when no data', () => {
      const manager = createPriceDataManager({
        logger: mockLogger,
      });

      expect(manager.getPairCount()).toBe(0);
    });
  });

  // ===========================================================================
  // cleanup
  // ===========================================================================

  describe('cleanup', () => {
    it('should remove old price data', () => {
      const manager = createPriceDataManager({
        logger: mockLogger,
        maxPriceAgeMs: 1000, // 1 second
      });

      const now = Date.now();

      manager.handlePriceUpdate(createPriceUpdate({
        pairKey: 'OLD-PAIR',
        price: 100,
        timestamp: now - 5000, // 5 seconds old
      }));

      manager.handlePriceUpdate(createPriceUpdate({
        pairKey: 'NEW-PAIR',
        price: 200,
        timestamp: now,
      }));

      manager.cleanup();

      const snapshot = manager.createSnapshot();
      expect(snapshot.ethereum?.uniswap?.['OLD-PAIR']).toBeUndefined();
      expect(snapshot.ethereum.uniswap['NEW-PAIR']).toBeDefined();
    });

    it('should remove empty dex objects', () => {
      const manager = createPriceDataManager({
        logger: mockLogger,
        maxPriceAgeMs: 1000,
      });

      const now = Date.now();

      manager.handlePriceUpdate(createPriceUpdate({
        dex: 'empty-dex',
        pairKey: 'OLD-PAIR',
        price: 100,
        timestamp: now - 5000,
      }));

      manager.cleanup();

      const snapshot = manager.createSnapshot();
      expect(snapshot.ethereum?.['empty-dex']).toBeUndefined();
    });

    it('should remove empty chain objects', () => {
      const manager = createPriceDataManager({
        logger: mockLogger,
        maxPriceAgeMs: 1000,
      });

      const now = Date.now();

      manager.handlePriceUpdate(createPriceUpdate({
        chain: 'empty-chain',
        dex: 'empty-dex',
        pairKey: 'OLD-PAIR',
        price: 100,
        timestamp: now - 5000,
      }));

      manager.cleanup();

      const snapshot = manager.createSnapshot();
      expect(snapshot['empty-chain']).toBeUndefined();
    });
  });

  // ===========================================================================
  // clear
  // ===========================================================================

  describe('clear', () => {
    it('should remove all price data', () => {
      const manager = createPriceDataManager({
        logger: mockLogger,
      });

      manager.handlePriceUpdate(createPriceUpdate({
        chain: 'ethereum',
      }));

      manager.handlePriceUpdate(createPriceUpdate({
        chain: 'arbitrum',
        dex: 'camelot',
        pairKey: 'ARB-USDC',
        token0: 'ARB',
      }));

      manager.clear();

      expect(manager.getChains()).toEqual([]);
      expect(manager.getPairCount()).toBe(0);
      expect(manager.createSnapshot()).toEqual({});
    });

    it('should log clear operation', () => {
      const manager = createPriceDataManager({
        logger: mockLogger,
      });

      manager.clear();

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('cleared')
      );
    });
  });
});
