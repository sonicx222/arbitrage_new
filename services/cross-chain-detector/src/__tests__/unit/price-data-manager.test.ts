/**
 * Unit Tests for PriceDataManager
 *
 * Tests the price data management module extracted from CrossChainDetectorService.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  createPriceDataManager,
  PriceDataManager,
  Logger,
} from '../../price-data-manager';
import { PriceUpdate } from '@arbitrage/types';
import { RecordingLogger } from '@arbitrage/core';

// =============================================================================
// Helper
// =============================================================================

/** Helper function to cast RecordingLogger as Logger for type compatibility */
const asLogger = (recordingLogger: RecordingLogger): Logger =>
  recordingLogger as unknown as Logger;

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
  let logger: RecordingLogger;

  beforeEach(() => {
    logger = new RecordingLogger();
  });

  // ===========================================================================
  // Creation
  // ===========================================================================

  describe('createPriceDataManager', () => {
    it('should create manager with required config', () => {
      const manager = createPriceDataManager({
        logger: asLogger(logger),
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
        logger: asLogger(logger),
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
        logger: asLogger(logger),
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
        logger: asLogger(logger),
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
        logger: asLogger(logger),
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
        logger: asLogger(logger),
      });

      // This should not throw
      manager.handlePriceUpdate(null as any);
      manager.handlePriceUpdate(undefined as any);

      expect(logger.getLogs('error').length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // createSnapshot
  // ===========================================================================

  describe('createSnapshot', () => {
    it('should create deep copy of price data', () => {
      const manager = createPriceDataManager({
        logger: asLogger(logger),
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
        logger: asLogger(logger),
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
        logger: asLogger(logger),
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
        logger: asLogger(logger),
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
        logger: asLogger(logger),
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
        logger: asLogger(logger),
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
        logger: asLogger(logger),
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
        logger: asLogger(logger),
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
        logger: asLogger(logger),
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
  // createIndexedSnapshot
  // ===========================================================================

  describe('createIndexedSnapshot', () => {
    it('should create indexed snapshot with token pair map', () => {
      const manager = createPriceDataManager({
        logger: asLogger(logger),
      });

      // PERF 10.2: Need data from at least 2 chains for token pair to be included
      manager.handlePriceUpdate(createPriceUpdate({
        chain: 'ethereum',
        dex: 'uniswap',
        pairKey: 'uniswap_WETH_USDC',
        price: 2500,
        token0: 'WETH',
        token1: 'USDC',
      }));

      manager.handlePriceUpdate(createPriceUpdate({
        chain: 'arbitrum',
        dex: 'camelot',
        pairKey: 'camelot_WETH_USDC',
        price: 2510,
        token0: 'WETH',
        token1: 'USDC',
      }));

      const snapshot = manager.createIndexedSnapshot();

      expect(snapshot.byToken).toBeInstanceOf(Map);
      expect(snapshot.raw).toBeDefined();
      expect(snapshot.tokenPairs.length).toBeGreaterThan(0);
      expect(snapshot.timestamp).toBeDefined();
    });

    it('should index by normalized token pair', () => {
      const manager = createPriceDataManager({
        logger: asLogger(logger),
      });

      // Add same token pair on different chains/dexes
      manager.handlePriceUpdate(createPriceUpdate({
        chain: 'ethereum',
        dex: 'uniswap',
        pairKey: 'uniswap_WETH_USDC',
        price: 2500,
        token0: 'WETH',
        token1: 'USDC',
      }));

      manager.handlePriceUpdate(createPriceUpdate({
        chain: 'arbitrum',
        dex: 'camelot',
        pairKey: 'camelot_WETH_USDC',
        price: 2510,
        token0: 'WETH',
        token1: 'USDC',
      }));

      const snapshot = manager.createIndexedSnapshot();
      const wethPrices = snapshot.byToken.get('WETH_USDC');

      // Both should be indexed under normalized WETH_USDC (WETH stays as WETH)
      expect(wethPrices).toBeDefined();
      expect(wethPrices!.length).toBe(2);
    });

    // PERF-P4: Snapshot caching tests
    describe('caching (PERF-P4)', () => {
      it('should return cached snapshot when no updates', () => {
        const manager = createPriceDataManager({
          logger: asLogger(logger),
        });

        manager.handlePriceUpdate(createPriceUpdate({
          pairKey: 'uniswap_WETH_USDC',
        }));

        const snapshot1 = manager.createIndexedSnapshot();
        const snapshot2 = manager.createIndexedSnapshot();

        // Should be the exact same object reference (cached)
        expect(snapshot1).toBe(snapshot2);
      });

      it('should invalidate cache after handlePriceUpdate', () => {
        const manager = createPriceDataManager({
          logger: asLogger(logger),
        });

        // PERF 10.2: Need multi-chain data for token pairs to be included
        manager.handlePriceUpdate(createPriceUpdate({
          chain: 'ethereum',
          pairKey: 'uniswap_WETH_USDC',
          price: 2500,
        }));
        manager.handlePriceUpdate(createPriceUpdate({
          chain: 'arbitrum',
          pairKey: 'camelot_WETH_USDC',
          price: 2510,
        }));

        const snapshot1 = manager.createIndexedSnapshot();
        expect(snapshot1.tokenPairs.length).toBe(1); // 1 cross-chain pair

        // Add another token pair on multiple chains
        manager.handlePriceUpdate(createPriceUpdate({
          chain: 'ethereum',
          pairKey: 'uniswap_WETH_USDT',
          price: 2501,
        }));
        manager.handlePriceUpdate(createPriceUpdate({
          chain: 'polygon',
          pairKey: 'quickswap_WETH_USDT',
          price: 2502,
        }));

        const snapshot2 = manager.createIndexedSnapshot();

        // Should be different objects (cache invalidated)
        expect(snapshot1).not.toBe(snapshot2);
        // But should contain updated data (now 2 cross-chain pairs)
        expect(snapshot2.tokenPairs.length).toBeGreaterThan(snapshot1.tokenPairs.length);
      });

      it('should invalidate cache after cleanup removes data', () => {
        const manager = createPriceDataManager({
          logger: asLogger(logger),
          maxPriceAgeMs: 1000,
        });

        const now = Date.now();

        // PERF 10.2: Add cross-chain data for OLD token (will be cleaned up)
        manager.handlePriceUpdate(createPriceUpdate({
          chain: 'ethereum',
          pairKey: 'uniswap_OLD_TOKEN',
          timestamp: now - 5000,
        }));
        manager.handlePriceUpdate(createPriceUpdate({
          chain: 'arbitrum',
          pairKey: 'camelot_OLD_TOKEN',
          timestamp: now - 5000,
        }));

        // Add cross-chain fresh data (will remain)
        manager.handlePriceUpdate(createPriceUpdate({
          chain: 'ethereum',
          pairKey: 'uniswap_FRESH_TOKEN',
          timestamp: now,
        }));
        manager.handlePriceUpdate(createPriceUpdate({
          chain: 'polygon',
          pairKey: 'quickswap_FRESH_TOKEN',
          timestamp: now,
        }));

        const snapshot1 = manager.createIndexedSnapshot();
        expect(snapshot1.tokenPairs.length).toBe(2); // 2 cross-chain pairs

        // Cleanup should remove old data and invalidate cache
        manager.cleanup();

        const snapshot2 = manager.createIndexedSnapshot();

        // Should be different object
        expect(snapshot1).not.toBe(snapshot2);
        // Should have fewer token pairs (old data removed)
        expect(snapshot2.tokenPairs.length).toBe(1);
      });

      it('should NOT invalidate cache after cleanup removes no data', () => {
        const manager = createPriceDataManager({
          logger: asLogger(logger),
          maxPriceAgeMs: 60000, // 1 minute - data won't be old enough
        });

        manager.handlePriceUpdate(createPriceUpdate({
          pairKey: 'uniswap_WETH_USDC',
          timestamp: Date.now(),
        }));

        const snapshot1 = manager.createIndexedSnapshot();

        // Cleanup should not remove anything (data is fresh)
        manager.cleanup();

        const snapshot2 = manager.createIndexedSnapshot();

        // Should be the same object (cache still valid)
        expect(snapshot1).toBe(snapshot2);
      });

      it('should reset cache after clear', () => {
        const manager = createPriceDataManager({
          logger: asLogger(logger),
        });

        // PERF 10.2: Add cross-chain data
        manager.handlePriceUpdate(createPriceUpdate({
          chain: 'ethereum',
          pairKey: 'uniswap_WETH_USDC',
        }));
        manager.handlePriceUpdate(createPriceUpdate({
          chain: 'arbitrum',
          pairKey: 'camelot_WETH_USDC',
        }));

        const snapshot1 = manager.createIndexedSnapshot();
        expect(snapshot1.tokenPairs.length).toBe(1); // 1 cross-chain pair

        // Clear all data
        manager.clear();

        // Add new cross-chain data
        manager.handlePriceUpdate(createPriceUpdate({
          chain: 'ethereum',
          pairKey: 'uniswap_ARB_USDC',
          token0: 'ARB',
        }));
        manager.handlePriceUpdate(createPriceUpdate({
          chain: 'polygon',
          pairKey: 'quickswap_ARB_USDC',
          token0: 'ARB',
        }));

        const snapshot2 = manager.createIndexedSnapshot();

        // Should be different object
        expect(snapshot1).not.toBe(snapshot2);
        // New data should be reflected (1 cross-chain pair)
        expect(snapshot2.tokenPairs.length).toBe(1);
        expect(snapshot2.tokenPairs).toContain('ARB_USDC');
      });

      it('should log cache miss but not cache hit (performance optimization)', () => {
        const manager = createPriceDataManager({
          logger: asLogger(logger),
        });

        manager.handlePriceUpdate(createPriceUpdate({
          pairKey: 'uniswap_WETH_USDC',
        }));

        // First call - cache miss (builds new snapshot)
        manager.createIndexedSnapshot();
        expect(logger.hasLogMatching('debug', 'Built new indexed snapshot')).toBe(true);

        logger.clear();

        // Second call - cache hit
        // NOTE: Cache hit does NOT log (intentional for performance - see implementation)
        manager.createIndexedSnapshot();
        // Verify no debug log on cache hit (logging removed for high-frequency operations)
        expect(logger.getLogs('debug').length).toBe(0);
      });
    });
  });

  // ===========================================================================
  // clear
  // ===========================================================================

  describe('clear', () => {
    it('should remove all price data', () => {
      const manager = createPriceDataManager({
        logger: asLogger(logger),
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
        logger: asLogger(logger),
      });

      manager.clear();

      expect(logger.hasLogMatching('info', 'cleared')).toBe(true);
    });
  });
});
