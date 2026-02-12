/**
 * Event Processor Tests (P1-1 Refactor)
 *
 * Tests for pure functions extracted from base-detector.ts.
 * These functions handle event decoding and object construction
 * without side effects.
 */

import { ethers } from 'ethers';
import {
  decodeSyncEventData,
  decodeSwapEventData,
  parseBlockNumber,
  buildExtendedPair,
  buildPriceUpdate,
  buildSwapEvent,
  generatePairKey,
  DecodedSyncEvent,
  DecodedSwapEvent,
  ExtendedPair,
} from '../../../src/detector/event-processor';
import type { Pair, PriceUpdate, SwapEvent } from '../../../../types/src';

describe('EventProcessor', () => {
  // ==========================================================================
  // Test Fixtures
  // ==========================================================================

  const mockPair: Pair = {
    name: 'WETH/USDC',
    address: '0x1234567890123456789012345678901234567890',
    token0: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    token1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
    dex: 'uniswap-v2',
    fee: 30, // 0.3%
  };

  // Encoded Sync event data (reserve0 = 1000000000000000000, reserve1 = 2000000000)
  // ABI: ['uint112', 'uint112']
  const encodedSyncData = ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint112', 'uint112'],
    [BigInt('1000000000000000000'), BigInt('2000000000')]
  );

  // Encoded Swap event data
  // ABI: ['uint256', 'uint256', 'uint256', 'uint256']
  const encodedSwapData = ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint256', 'uint256', 'uint256', 'uint256'],
    [
      BigInt('100000000000000000'), // amount0In = 0.1 ETH
      BigInt('0'),                  // amount1In = 0
      BigInt('0'),                  // amount0Out = 0
      BigInt('200000000'),          // amount1Out = 200 USDC
    ]
  );

  // Topic addresses (sender and recipient padded to 32 bytes)
  const senderTopic = '0x000000000000000000000000' + 'abcdef0123456789abcdef0123456789abcdef01';
  const recipientTopic = '0x000000000000000000000000' + 'fedcba9876543210fedcba9876543210fedcba98';

  // ==========================================================================
  // decodeSyncEventData Tests
  // ==========================================================================

  describe('decodeSyncEventData', () => {
    it('should decode Sync event data correctly', () => {
      const result = decodeSyncEventData(encodedSyncData);

      expect(result.reserve0).toBe('1000000000000000000');
      expect(result.reserve1).toBe('2000000000');
    });

    it('should return strings (not BigInt) for reserves', () => {
      const result = decodeSyncEventData(encodedSyncData);

      expect(typeof result.reserve0).toBe('string');
      expect(typeof result.reserve1).toBe('string');
    });

    it('should throw on invalid data', () => {
      expect(() => decodeSyncEventData('0xINVALID')).toThrow();
    });

    it('should handle zero reserves', () => {
      const zeroData = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint112', 'uint112'],
        [BigInt('0'), BigInt('0')]
      );

      const result = decodeSyncEventData(zeroData);

      expect(result.reserve0).toBe('0');
      expect(result.reserve1).toBe('0');
    });

    it('should handle large reserves (max uint112)', () => {
      const maxUint112 = BigInt('5192296858534827628530496329220095');
      const largeData = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint112', 'uint112'],
        [maxUint112, maxUint112]
      );

      const result = decodeSyncEventData(largeData);

      expect(result.reserve0).toBe(maxUint112.toString());
      expect(result.reserve1).toBe(maxUint112.toString());
    });
  });

  // ==========================================================================
  // decodeSwapEventData Tests
  // ==========================================================================

  describe('decodeSwapEventData', () => {
    it('should decode Swap event data correctly', () => {
      const result = decodeSwapEventData(encodedSwapData, [
        '0x0', // event signature (topic 0)
        senderTopic,
        recipientTopic,
      ]);

      expect(result.amount0In).toBe('100000000000000000');
      expect(result.amount1In).toBe('0');
      expect(result.amount0Out).toBe('0');
      expect(result.amount1Out).toBe('200000000');
      expect(result.sender).toBe('0xabcdef0123456789abcdef0123456789abcdef01');
      expect(result.recipient).toBe('0xfedcba9876543210fedcba9876543210fedcba98');
    });

    it('should handle missing topics gracefully', () => {
      const result = decodeSwapEventData(encodedSwapData, undefined);

      expect(result.sender).toBe('0x0');
      expect(result.recipient).toBe('0x0');
    });

    it('should handle empty topics array', () => {
      const result = decodeSwapEventData(encodedSwapData, []);

      expect(result.sender).toBe('0x0');
      expect(result.recipient).toBe('0x0');
    });

    it('should throw on invalid data', () => {
      expect(() => decodeSwapEventData('0xINVALID', [])).toThrow();
    });
  });

  // ==========================================================================
  // parseBlockNumber Tests
  // ==========================================================================

  describe('parseBlockNumber', () => {
    it('should parse hex string block number', () => {
      expect(parseBlockNumber('0x1234')).toBe(0x1234);
      expect(parseBlockNumber('0xF4240')).toBe(1000000);
    });

    it('should return number directly', () => {
      expect(parseBlockNumber(12345)).toBe(12345);
      expect(parseBlockNumber(1000000)).toBe(1000000);
    });

    it('should handle zero', () => {
      expect(parseBlockNumber('0x0')).toBe(0);
      expect(parseBlockNumber(0)).toBe(0);
    });
  });

  // ==========================================================================
  // buildExtendedPair Tests
  // ==========================================================================

  describe('buildExtendedPair', () => {
    it('should build ExtendedPair with all properties', () => {
      const syncData: DecodedSyncEvent = {
        reserve0: '1000000000000000000',
        reserve1: '2000000000',
      };

      const result = buildExtendedPair(mockPair, syncData, 12345);

      // Original properties preserved
      expect(result.name).toBe(mockPair.name);
      expect(result.address).toBe(mockPair.address);
      expect(result.token0).toBe(mockPair.token0);
      expect(result.token1).toBe(mockPair.token1);
      expect(result.dex).toBe(mockPair.dex);
      expect(result.fee).toBe(mockPair.fee);

      // New properties added
      expect(result.reserve0).toBe('1000000000000000000');
      expect(result.reserve1).toBe('2000000000');
      expect(result.blockNumber).toBe(12345);
      expect(typeof result.lastUpdate).toBe('number');
    });

    it('should create new object (not mutate original)', () => {
      const syncData: DecodedSyncEvent = {
        reserve0: '1000',
        reserve1: '2000',
      };

      const result = buildExtendedPair(mockPair, syncData, 100);

      // Verify original is unchanged
      expect((mockPair as any).reserve0).toBeUndefined();
      expect((mockPair as any).reserve1).toBeUndefined();

      // Verify result is different object
      expect(result).not.toBe(mockPair);
    });

    it('should preserve fee from original pair', () => {
      const pairWithCustomFee = { ...mockPair, fee: 1 }; // 0.01% (Maverick)
      const syncData: DecodedSyncEvent = {
        reserve0: '1000',
        reserve1: '2000',
      };

      const result = buildExtendedPair(pairWithCustomFee, syncData, 100);

      expect(result.fee).toBe(1);
    });
  });

  // ==========================================================================
  // buildPriceUpdate Tests
  // ==========================================================================

  describe('buildPriceUpdate', () => {
    it('should build PriceUpdate correctly', () => {
      const syncData: DecodedSyncEvent = {
        reserve0: '1000000000000000000',
        reserve1: '2000000000',
      };

      const result = buildPriceUpdate(mockPair, syncData, 2000.0, 12345, 'ethereum');

      expect(result.pairKey).toBe('uniswap-v2_0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2_0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
      expect(result.dex).toBe('uniswap-v2');
      expect(result.chain).toBe('ethereum');
      expect(result.token0).toBe(mockPair.token0);
      expect(result.token1).toBe(mockPair.token1);
      expect(result.price).toBe(2000.0);
      expect(result.reserve0).toBe('1000000000000000000');
      expect(result.reserve1).toBe('2000000000');
      expect(result.blockNumber).toBe(12345);
      expect(result.latency).toBe(0);
      expect(result.fee).toBe(30);
      expect(typeof result.timestamp).toBe('number');
    });

    it('should include custom fee in price update', () => {
      const pairWithCustomFee = { ...mockPair, fee: 4 }; // 0.04% (Curve)
      const syncData: DecodedSyncEvent = {
        reserve0: '1000',
        reserve1: '2000',
      };

      const result = buildPriceUpdate(pairWithCustomFee, syncData, 1.5, 100, 'ethereum');

      expect(result.fee).toBe(4);
    });
  });

  // ==========================================================================
  // buildSwapEvent Tests
  // ==========================================================================

  describe('buildSwapEvent', () => {
    it('should build SwapEvent correctly', () => {
      const swapData: DecodedSwapEvent = {
        amount0In: '100000000000000000',
        amount1In: '0',
        amount0Out: '0',
        amount1Out: '200000000',
        sender: '0xabcdef0123456789abcdef0123456789abcdef01',
        recipient: '0xfedcba9876543210fedcba9876543210fedcba98',
      };
      const log = {
        data: encodedSwapData,
        blockNumber: '0x1234',
        transactionHash: '0xtxhash123',
      };

      const result = buildSwapEvent(mockPair, swapData, log, 'ethereum', 500.0);

      expect(result.pairAddress).toBe(mockPair.address);
      expect(result.sender).toBe('0xabcdef0123456789abcdef0123456789abcdef01');
      expect(result.recipient).toBe('0xfedcba9876543210fedcba9876543210fedcba98');
      expect(result.to).toBe('0xfedcba9876543210fedcba9876543210fedcba98');
      expect(result.amount0In).toBe('100000000000000000');
      expect(result.amount1In).toBe('0');
      expect(result.amount0Out).toBe('0');
      expect(result.amount1Out).toBe('200000000');
      expect(result.blockNumber).toBe(0x1234);
      expect(result.transactionHash).toBe('0xtxhash123');
      expect(result.dex).toBe('uniswap-v2');
      expect(result.chain).toBe('ethereum');
      expect(result.usdValue).toBe(500.0);
      expect(typeof result.timestamp).toBe('number');
    });

    it('should handle missing transaction hash', () => {
      const swapData: DecodedSwapEvent = {
        amount0In: '100',
        amount1In: '0',
        amount0Out: '0',
        amount1Out: '200',
        sender: '0x0',
        recipient: '0x0',
      };
      const log = {
        data: encodedSwapData,
        blockNumber: 100,
        // no transactionHash
      };

      const result = buildSwapEvent(mockPair, swapData, log, 'ethereum', 10.0);

      expect(result.transactionHash).toBe('0x0');
    });

    it('should handle numeric block number', () => {
      const swapData: DecodedSwapEvent = {
        amount0In: '100',
        amount1In: '0',
        amount0Out: '0',
        amount1Out: '200',
        sender: '0x0',
        recipient: '0x0',
      };
      const log = {
        data: encodedSwapData,
        blockNumber: 12345,
        transactionHash: '0x123',
      };

      const result = buildSwapEvent(mockPair, swapData, log, 'polygon', 100.0);

      expect(result.blockNumber).toBe(12345);
      expect(result.chain).toBe('polygon');
    });
  });

  // ==========================================================================
  // generatePairKey Tests
  // ==========================================================================

  describe('generatePairKey', () => {
    it('should generate correct pair key', () => {
      const result = generatePairKey('uniswap-v2', '0xToken0', '0xToken1');

      expect(result).toBe('uniswap-v2_0xToken0_0xToken1');
    });

    it('should handle different DEXs', () => {
      expect(generatePairKey('sushiswap', '0xA', '0xB')).toBe('sushiswap_0xA_0xB');
      expect(generatePairKey('pancakeswap', '0xA', '0xB')).toBe('pancakeswap_0xA_0xB');
    });

    it('should be case-sensitive', () => {
      const key1 = generatePairKey('uniswap_v2', '0xAAA', '0xBBB');
      const key2 = generatePairKey('uniswap_v2', '0xaaa', '0xbbb');
      expect(key1).not.toBe(key2);
    });
  });

  // ==========================================================================
  // P0-1 FIX Regression Tests
  // ==========================================================================

  describe('P0-1 FIX: Immutable pair creation', () => {
    it('should create immutable pair objects that can be atomically swapped', () => {
      const syncData: DecodedSyncEvent = {
        reserve0: '1000',
        reserve1: '2000',
      };

      // Simulate the atomic swap pattern from base-detector
      const pairs = new Map<string, ExtendedPair>();

      // Build new pair (this is what buildExtendedPair does)
      const pair1 = buildExtendedPair(mockPair, syncData, 100);
      pairs.set('key1', pair1);

      // Second update
      const syncData2: DecodedSyncEvent = {
        reserve0: '1500',
        reserve1: '3000',
      };
      const pair2 = buildExtendedPair(mockPair, syncData2, 101);

      // Atomic swap - Map.set() replaces the entire reference
      pairs.set('key1', pair2);

      // Verify the old reference is untouched
      expect(pair1.reserve0).toBe('1000');
      expect(pair1.reserve1).toBe('2000');
      expect(pair1.blockNumber).toBe(100);

      // Verify new reference has new values
      const stored = pairs.get('key1');
      expect(stored?.reserve0).toBe('1500');
      expect(stored?.reserve1).toBe('3000');
      expect(stored?.blockNumber).toBe(101);
    });

    it('should never share references between consecutive builds', () => {
      const syncData: DecodedSyncEvent = {
        reserve0: '1000',
        reserve1: '2000',
      };

      const pair1 = buildExtendedPair(mockPair, syncData, 100);
      const pair2 = buildExtendedPair(mockPair, syncData, 101);

      // Different block numbers means different objects
      expect(pair1).not.toBe(pair2);
      expect(pair1.blockNumber).not.toBe(pair2.blockNumber);

      // Both should have correct values
      expect(pair1.blockNumber).toBe(100);
      expect(pair2.blockNumber).toBe(101);
    });
  });
});
