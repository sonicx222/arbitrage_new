/**
 * Event Processor Tests
 *
 * Tests for pure event decoding and object construction functions.
 * These are the easiest tests to write - no mocking, no setup, just input → output!
 *
 * Migrated from base-detector.test.ts as part of Phase 2 test migration.
 */

import {
  decodeSyncEventData,
  decodeSwapEventData,
  parseBlockNumber,
  buildExtendedPair,
  buildPriceUpdate,
  buildSwapEvent,
  generatePairKey,
} from '../event-processor';
import type { Pair } from '@arbitrage/types';

describe('EventProcessor', () => {
  // =============================================================================
  // decodeSyncEventData (Pure Function - Trivial to Test!)
  // =============================================================================

  describe('decodeSyncEventData', () => {
    it('should decode reserve values from Sync event', () => {
      // Real Sync event data (hex-encoded ABI)
      const logData = '0x0000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000001bc16d674ec80000';

      const result = decodeSyncEventData(logData);

      expect(result.reserve0).toBe('1000000000000000000'); // 1 ETH
      expect(result.reserve1).toBe('2000000000000000000'); // 2 ETH
    });

    it('should decode zero reserves', () => {
      const logData = '0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';

      const result = decodeSyncEventData(logData);

      expect(result.reserve0).toBe('0');
      expect(result.reserve1).toBe('0');
    });

    it('should throw on malformed data', () => {
      const malformedData = '0xinvalid';

      expect(() => decodeSyncEventData(malformedData)).toThrow();
    });

    it('should handle large reserve values', () => {
      // Max uint112 value
      const maxUint112 = '0x000000000000000000000000000000000000000000000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

      expect(() => decodeSyncEventData(maxUint112)).not.toThrow();
    });
  });

  // =============================================================================
  // decodeSwapEventData (Pure Function)
  // =============================================================================

  describe('decodeSwapEventData', () => {
    it('should decode swap amounts', () => {
      const logData = '0x0000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001bc16d674ec80000';
      const topics = [
        '0xSwapEventSignature',
        '0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // sender
        '0x000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // recipient
      ];

      const result = decodeSwapEventData(logData, topics);

      expect(result.amount0In).toBe('1000000000000000000');
      expect(result.amount1In).toBe('0');
      expect(result.amount0Out).toBe('0');
      expect(result.amount1Out).toBe('2000000000000000000');
      expect(result.sender).toMatch(/^0x/);
      expect(result.recipient).toMatch(/^0x/);
    });

    it('should handle missing topics', () => {
      const logData = '0x0000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001bc16d674ec80000';

      const result = decodeSwapEventData(logData);

      expect(result.sender).toBe('0x0');
      expect(result.recipient).toBe('0x0');
    });
  });

  // =============================================================================
  // parseBlockNumber (Pure Function)
  // =============================================================================

  describe('parseBlockNumber', () => {
    it('should parse hex string to number', () => {
      expect(parseBlockNumber('0x12345')).toBe(74565);
    });

    it('should pass through numeric input', () => {
      expect(parseBlockNumber(12345)).toBe(12345);
    });

    it('should handle zero', () => {
      expect(parseBlockNumber('0x0')).toBe(0);
      expect(parseBlockNumber(0)).toBe(0);
    });
  });

  // =============================================================================
  // buildExtendedPair (Immutability Test - Critical!)
  // =============================================================================

  describe('buildExtendedPair', () => {
    const basePair: Pair = {
      name: 'WETH/USDC',
      address: '0x123',
      token0: '0xaaa',
      token1: '0xbbb',
      dex: 'uniswap_v2',
      fee: 0.003,
    };

    it('should create new immutable ExtendedPair', () => {
      const syncData = {
        reserve0: '1000000000000000000',
        reserve1: '2000000000000000000',
      };
      const blockNumber = 12345;

      const result = buildExtendedPair(basePair, syncData, blockNumber);

      // New object created (immutability)
      expect(result).not.toBe(basePair);

      // Original properties preserved
      expect(result.name).toBe('WETH/USDC');
      expect(result.address).toBe('0x123');
      expect(result.token0).toBe('0xaaa');
      expect(result.token1).toBe('0xbbb');
      expect(result.dex).toBe('uniswap_v2');
      expect(result.fee).toBe(0.003);

      // New properties added
      expect(result.reserve0).toBe('1000000000000000000');
      expect(result.reserve1).toBe('2000000000000000000');
      expect(result.blockNumber).toBe(12345);
      expect(result.lastUpdate).toBeGreaterThan(Date.now() - 1000);
    });

    it('should not mutate original pair object', () => {
      const syncData = {
        reserve0: '999',
        reserve1: '888',
      };

      buildExtendedPair(basePair, syncData, 67890);

      // Original unchanged
      expect(basePair).not.toHaveProperty('reserve0');
      expect(basePair).not.toHaveProperty('reserve1');
      expect(basePair).not.toHaveProperty('blockNumber');
    });

    it('should create independent objects on multiple calls', () => {
      const syncData1 = { reserve0: '100', reserve1: '200' };
      const syncData2 = { reserve0: '300', reserve1: '400' };

      const pair1 = buildExtendedPair(basePair, syncData1, 100);
      const pair2 = buildExtendedPair(basePair, syncData2, 200);

      // Different objects
      expect(pair1).not.toBe(pair2);
      expect(pair1.reserve0).toBe('100');
      expect(pair2.reserve0).toBe('300');
    });
  });

  // =============================================================================
  // buildPriceUpdate (Pure Function)
  // =============================================================================

  describe('buildPriceUpdate', () => {
    const pair: Pair = {
      name: 'WETH/USDC',
      address: '0x123',
      token0: '0xaaa',
      token1: '0xbbb',
      dex: 'uniswap_v2',
      fee: 0.003,
    };

    const syncData = {
      reserve0: '1000000000000000000',
      reserve1: '2000000000000000',
    };

    it('should build PriceUpdate object', () => {
      const result = buildPriceUpdate(pair, syncData, 2000.5, 12345, 'ethereum');

      expect(result.pairKey).toBe('uniswap_v2_0xaaa_0xbbb');
      expect(result.dex).toBe('uniswap_v2');
      expect(result.chain).toBe('ethereum');
      expect(result.token0).toBe('0xaaa');
      expect(result.token1).toBe('0xbbb');
      expect(result.price).toBe(2000.5);
      expect(result.reserve0).toBe('1000000000000000000');
      expect(result.reserve1).toBe('2000000000000000');
      expect(result.blockNumber).toBe(12345);
      expect(result.fee).toBe(0.003);
      expect(result.latency).toBe(0);
      expect(result.timestamp).toBeGreaterThan(Date.now() - 1000);
    });

    it('should include DEX fee in price update', () => {
      const pancakePair = { ...pair, dex: 'pancakeswap', fee: 0.0025 };

      const result = buildPriceUpdate(pancakePair, syncData, 2000, 100, 'bsc');

      expect(result.fee).toBe(0.0025);
    });
  });

  // =============================================================================
  // buildSwapEvent (Pure Function)
  // =============================================================================

  describe('buildSwapEvent', () => {
    const pair: Pair = {
      name: 'WETH/USDC',
      address: '0x123',
      token0: '0xaaa',
      token1: '0xbbb',
      dex: 'uniswap_v2',
      fee: 0.003,
    };

    const swapData = {
      amount0In: '1000000000000000000',
      amount1In: '0',
      amount0Out: '0',
      amount1Out: '2000000000',
      sender: '0xsender',
      recipient: '0xrecipient',
    };

    const log = {
      data: '0xdata',
      blockNumber: 12345,
      transactionHash: '0xtxhash',
    };

    it('should build SwapEvent object', () => {
      const result = buildSwapEvent(pair, swapData, log, 'ethereum', 5000);

      expect(result.pairAddress).toBe('0x123');
      expect(result.sender).toBe('0xsender');
      expect(result.recipient).toBe('0xrecipient');
      expect(result.amount0In).toBe('1000000000000000000');
      expect(result.amount1In).toBe('0');
      expect(result.amount0Out).toBe('0');
      expect(result.amount1Out).toBe('2000000000');
      expect(result.to).toBe('0xrecipient');
      expect(result.blockNumber).toBe(12345);
      expect(result.transactionHash).toBe('0xtxhash');
      expect(result.dex).toBe('uniswap_v2');
      expect(result.chain).toBe('ethereum');
      expect(result.usdValue).toBe(5000);
    });

    it('should handle hex block number', () => {
      const logWithHexBlock = {
        ...log,
        blockNumber: '0x3039',
      };

      const result = buildSwapEvent(pair, swapData, logWithHexBlock, 'ethereum', 0);

      expect(result.blockNumber).toBe(12345); // 0x3039 in decimal
    });

    it('should handle missing transaction hash', () => {
      const logWithoutTx = {
        data: '0xdata',
        blockNumber: 100,
      };

      const result = buildSwapEvent(pair, swapData, logWithoutTx, 'ethereum', 0);

      expect(result.transactionHash).toBe('0x0');
    });
  });

  // =============================================================================
  // generatePairKey (Pure Function)
  // =============================================================================

  describe('generatePairKey', () => {
    it('should generate consistent pair key', () => {
      const key = generatePairKey('uniswap_v2', '0xaaa', '0xbbb');

      expect(key).toBe('uniswap_v2_0xaaa_0xbbb');
    });

    it('should be case-sensitive', () => {
      const key1 = generatePairKey('uniswap_v2', '0xAAA', '0xBBB');
      const key2 = generatePairKey('uniswap_v2', '0xaaa', '0xbbb');

      expect(key1).not.toBe(key2);
    });
  });
});
