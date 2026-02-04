/**
 * S1.2 Smart Swap Event Filter Extended Unit Tests
 *
 * Unit tests for Smart Swap Event Filtering implementation with mocked Redis.
 * Validates the hypothesis: 99% event reduction with 100% signal retention
 *
 * NOTE: Relabeled from integration test - uses fully mocked ioredis
 * so this is actually a unit test, not an integration test.
 *
 * @see IMPLEMENTATION_PLAN.md S1.2: Smart Swap Event Filtering
 * @see S1.2.1-S1.2.5: Filter Implementation Tasks
 */

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';

// Mock ioredis before importing modules that use it
const mockRedisData = new Map<string, any>();
const mockStreams = new Map<string, any[]>();
const mockConsumerGroups = new Map<string, Map<string, any>>();
const mockPubSubChannels = new Map<string, any[]>();

const mockRedis = {
  xadd: jest.fn<any>().mockImplementation(async (stream: string, id: string, ...args: string[]) => {
    const streamData = mockStreams.get(stream) || [];
    const messageId = id === '*' ? `${Date.now()}-${streamData.length}` : id;
    const fields: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 2) {
      fields[args[i]] = args[i + 1];
    }
    streamData.push({ id: messageId, fields });
    mockStreams.set(stream, streamData);
    return messageId;
  }),
  xread: jest.fn<any>().mockImplementation(async (...args: any[]) => {
    const streamsIdx = args.indexOf('STREAMS');
    if (streamsIdx === -1) return null;
    const streamName = args[streamsIdx + 1];
    const streamData = mockStreams.get(streamName) || [];
    if (streamData.length === 0) return null;
    return [[streamName, streamData.map((m: any) => [m.id, Object.entries(m.fields).flat()])]];
  }),
  xreadgroup: jest.fn<any>().mockResolvedValue(null),
  xack: jest.fn<any>().mockResolvedValue(1),
  xgroup: jest.fn<any>().mockImplementation(async (command: string, stream: string, group: string) => {
    if (command === 'CREATE') {
      const groups = mockConsumerGroups.get(stream) || new Map();
      if (groups.has(group)) {
        throw new Error('BUSYGROUP Consumer Group name already exists');
      }
      groups.set(group, { lastDeliveredId: '0-0', consumers: new Map() });
      mockConsumerGroups.set(stream, groups);
    }
    return 'OK';
  }),
  xinfo: jest.fn<any>().mockImplementation(async (command: string, stream: string) => {
    const streamData = mockStreams.get(stream) || [];
    return [
      'length', streamData.length,
      'radix-tree-keys', 1,
      'radix-tree-nodes', 2,
      'last-generated-id', streamData.length > 0 ? streamData[streamData.length - 1].id : '0-0',
      'groups', mockConsumerGroups.get(stream)?.size || 0
    ];
  }),
  xlen: jest.fn<any>().mockImplementation(async (stream: string) => {
    return (mockStreams.get(stream) || []).length;
  }),
  xpending: jest.fn<any>().mockResolvedValue([0, null, null, []]),
  xtrim: jest.fn<any>().mockResolvedValue(0),
  publish: jest.fn<any>().mockImplementation(async (channel: string, message: any) => {
    const channelData = mockPubSubChannels.get(channel) || [];
    channelData.push(message);
    mockPubSubChannels.set(channel, channelData);
    return 1;
  }),
  ping: jest.fn<any>().mockResolvedValue('PONG'),
  disconnect: jest.fn<any>().mockResolvedValue(undefined),
  on: jest.fn<any>(),
  removeAllListeners: jest.fn<any>()
};

jest.mock('ioredis', () => {
  return jest.fn(() => mockRedis);
});

// Now import the modules
import {
  SwapEventFilter,
  getSwapEventFilter,
  resetSwapEventFilter,
  resetRedisStreamsInstance,
} from '@arbitrage/core';

import type {
  SwapEventFilterConfig,
  FilterResult,
  VolumeAggregate,
  WhaleAlert,
  FilterStats
} from '@arbitrage/core';

import { delay, measurePerformance, generateRandomHash, generateRandomAddress } from '@arbitrage/test-utils';

// Define SwapEvent interface locally to avoid import issues
interface SwapEvent {
  pairAddress: string;
  sender: string;
  recipient: string;
  amount0In: string;
  amount1In: string;
  amount0Out: string;
  amount1Out: string;
  to: string;
  blockNumber: number;
  transactionHash: string;
  timestamp: number;
  dex: string;
  chain: string;
  usdValue?: number;
}

// Helper to create mock swap events with realistic data
function createMockSwapEvent(overrides: Partial<SwapEvent> = {}): SwapEvent {
  return {
    pairAddress: overrides.pairAddress || generateRandomAddress(),
    sender: overrides.sender || generateRandomAddress(),
    recipient: overrides.recipient || generateRandomAddress(),
    amount0In: overrides.amount0In || '1000000000000000000', // 1 ETH in wei
    amount1In: overrides.amount1In || '0',
    amount0Out: overrides.amount0Out || '0',
    amount1Out: overrides.amount1Out || '2000000000', // 2000 USDC (6 decimals)
    to: overrides.to || generateRandomAddress(),
    blockNumber: overrides.blockNumber || 12345678,
    transactionHash: overrides.transactionHash || generateRandomHash(),
    timestamp: overrides.timestamp || Date.now(),
    dex: overrides.dex || 'uniswap_v3',
    chain: overrides.chain || 'ethereum',
    usdValue: overrides.usdValue ?? 2000,
    ...overrides
  } as SwapEvent;
}

describe('S1.2 Smart Swap Event Filter Extended Unit Tests', () => {
  let filter: SwapEventFilter;

  beforeAll(async () => {
    // Clear any previous state
    mockStreams.clear();
    mockConsumerGroups.clear();
    mockRedisData.clear();
    mockPubSubChannels.clear();
    resetSwapEventFilter();
    resetRedisStreamsInstance();
  });

  afterAll(async () => {
    resetSwapEventFilter();
    resetRedisStreamsInstance();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockStreams.clear();
    mockConsumerGroups.clear();
    mockPubSubChannels.clear();
    resetSwapEventFilter();
  });

  afterEach(() => {
    if (filter) {
      filter.destroy();
    }
  });

  // =========================================================================
  // S1.2.1: SwapEventFilter Core Functionality
  // =========================================================================
  describe('S1.2.1: SwapEventFilter Core Functionality', () => {
    beforeEach(() => {
      filter = new SwapEventFilter();
    });

    describe('Edge Filter - Zero Amount Detection', () => {
      it('should filter out swap events with all zero amounts', () => {
        const zeroAmountSwap = createMockSwapEvent({
          amount0In: '0',
          amount1In: '0',
          amount0Out: '0',
          amount1Out: '0',
          usdValue: 0
        });

        const result = filter.processEvent(zeroAmountSwap);

        expect(result.passed).toBe(false);
        expect(result.filterReason).toBe('zero_amount');
      });

      it('should pass swap events with non-zero amounts', () => {
        const validSwap = createMockSwapEvent({
          amount0In: '1000000000000000000',
          usdValue: 1000
        });

        const result = filter.processEvent(validSwap);

        expect(result.passed).toBe(true);
      });

      it('should handle invalid BigInt strings gracefully', () => {
        const invalidSwap = createMockSwapEvent({
          amount0In: 'invalid-bigint',
          amount1In: 'not-a-number',
          amount0Out: '',
          amount1Out: 'xyz',
          usdValue: 100
        });

        // Should not throw
        expect(() => filter.processEvent(invalidSwap)).not.toThrow();

        const result = filter.processEvent(invalidSwap);
        expect(result.passed).toBe(false);
        expect(result.filterReason).toBe('zero_amount');
      });
    });

    describe('Value Filter - Minimum USD Threshold', () => {
      it('should filter dust transactions below minimum USD value', () => {
        const dustSwap = createMockSwapEvent({
          usdValue: 5 // Below default $10 threshold
        });

        const result = filter.processEvent(dustSwap);

        expect(result.passed).toBe(false);
        expect(result.filterReason).toBe('below_min_value');
      });

      it('should pass transactions above minimum USD value', () => {
        const validSwap = createMockSwapEvent({
          usdValue: 100 // Above $10 threshold
        });

        const result = filter.processEvent(validSwap);

        expect(result.passed).toBe(true);
      });

      it('should respect custom minimum USD value configuration', () => {
        const customFilter = new SwapEventFilter({ minUsdValue: 100 });

        const lowSwap = createMockSwapEvent({ usdValue: 50 });
        const highSwap = createMockSwapEvent({ usdValue: 150 });

        expect(customFilter.processEvent(lowSwap).passed).toBe(false);
        expect(customFilter.processEvent(highSwap).passed).toBe(true);

        customFilter.destroy();
      });

      it('should filter negative USD values as invalid', () => {
        const negativeSwap = createMockSwapEvent({
          usdValue: -1000
        });

        const result = filter.processEvent(negativeSwap);

        expect(result.passed).toBe(false);
        expect(result.filterReason).toBe('invalid_value');
      });
    });

    describe('Dedup Filter - Duplicate Detection', () => {
      it('should filter duplicate transactions with same hash and pair', () => {
        const txHash = generateRandomHash();
        const pairAddress = generateRandomAddress();

        const swap1 = createMockSwapEvent({
          transactionHash: txHash,
          pairAddress: pairAddress,
          usdValue: 1000
        });

        const swap2 = createMockSwapEvent({
          transactionHash: txHash,
          pairAddress: pairAddress,
          usdValue: 1000
        });

        const result1 = filter.processEvent(swap1);
        const result2 = filter.processEvent(swap2);

        expect(result1.passed).toBe(true);
        expect(result2.passed).toBe(false);
        expect(result2.filterReason).toBe('duplicate');
      });

      it('should allow same transaction hash for different pairs', () => {
        const txHash = generateRandomHash();

        const swap1 = createMockSwapEvent({
          transactionHash: txHash,
          pairAddress: '0xpair1111111111111111111111111111111111111',
          usdValue: 1000
        });

        const swap2 = createMockSwapEvent({
          transactionHash: txHash,
          pairAddress: '0xpair2222222222222222222222222222222222222',
          usdValue: 1000
        });

        expect(filter.processEvent(swap1).passed).toBe(true);
        expect(filter.processEvent(swap2).passed).toBe(true);
      });

      it('should expire duplicates after window passes', async () => {
        const shortWindowFilter = new SwapEventFilter({ dedupWindowMs: 100 });

        const swap = createMockSwapEvent({
          transactionHash: '0xexpirable',
          usdValue: 1000
        });

        expect(shortWindowFilter.processEvent(swap).passed).toBe(true);
        expect(shortWindowFilter.processEvent(swap).passed).toBe(false);

        // Wait for dedup window to expire
        await delay(150);

        // Should pass again after expiry
        expect(shortWindowFilter.processEvent(swap).passed).toBe(true);

        shortWindowFilter.destroy();
      });
    });
  });

  // =========================================================================
  // S1.2.2: Whale Detection
  // =========================================================================
  describe('S1.2.2: Whale Detection', () => {
    beforeEach(() => {
      filter = new SwapEventFilter({
        whaleThreshold: 50000 // $50K threshold
      });
    });

    it('should detect whale transactions above threshold', () => {
      const whaleSwap = createMockSwapEvent({
        usdValue: 60000 // Above $50K
      });

      const result = filter.processEvent(whaleSwap);

      expect(result.passed).toBe(true);
      expect(result.isWhale).toBe(true);
    });

    it('should not flag normal transactions as whale', () => {
      const normalSwap = createMockSwapEvent({
        usdValue: 5000 // Below $50K
      });

      const result = filter.processEvent(normalSwap);

      expect(result.passed).toBe(true);
      expect(result.isWhale).toBe(false);
    });

    it('should emit whale alert via callback', (done) => {
      filter.onWhaleAlert((alert: WhaleAlert) => {
        expect(alert.event).toBeDefined();
        expect(alert.usdValue).toBeGreaterThanOrEqual(50000);
        expect(alert.timestamp).toBeDefined();
        expect(alert.chain).toBe('ethereum');
        expect(alert.dex).toBe('uniswap_v3');
        done();
      });

      filter.processEvent(createMockSwapEvent({
        usdValue: 75000,
        chain: 'ethereum',
        dex: 'uniswap_v3'
      }));
    });

    it('should support unsubscribing from whale alerts', () => {
      let alertCount = 0;

      const unsubscribe = filter.onWhaleAlert(() => {
        alertCount++;
      });

      // First whale - should trigger
      filter.processEvent(createMockSwapEvent({
        usdValue: 60000,
        transactionHash: '0xtx1'
      }));
      expect(alertCount).toBe(1);

      // Unsubscribe
      unsubscribe();

      // Second whale - should NOT trigger
      filter.processEvent(createMockSwapEvent({
        usdValue: 70000,
        transactionHash: '0xtx2'
      }));
      expect(alertCount).toBe(1); // Still 1, not 2
    });

    it('should include whale alerts in batch processing results', () => {
      const events = [
        createMockSwapEvent({ usdValue: 1000, transactionHash: '0xtx1' }),
        createMockSwapEvent({ usdValue: 60000, transactionHash: '0xtx2' }), // Whale
        createMockSwapEvent({ usdValue: 2000, transactionHash: '0xtx3' }),
        createMockSwapEvent({ usdValue: 100000, transactionHash: '0xtx4' }) // Whale
      ];

      const results = filter.processBatch(events);

      expect(results.whaleAlerts.length).toBe(2);
      expect(results.whaleAlerts[0].usdValue).toBe(60000);
      expect(results.whaleAlerts[1].usdValue).toBe(100000);
    });
  });

  // =========================================================================
  // S1.2.3: Volume Aggregation
  // =========================================================================
  describe('S1.2.3: Volume Aggregation', () => {
    it('should aggregate volume within time window', async () => {
      const shortWindowFilter = new SwapEventFilter({
        aggregationWindowMs: 100
      });

      let aggregateEmitted: VolumeAggregate | null = null;
      shortWindowFilter.onVolumeAggregate((agg: VolumeAggregate) => {
        aggregateEmitted = agg;
      });

      const pairAddress = generateRandomAddress();

      // Add multiple swaps for same pair
      for (let i = 0; i < 5; i++) {
        shortWindowFilter.processEvent(createMockSwapEvent({
          pairAddress,
          usdValue: 1000,
          transactionHash: `0xtx${i}`
        }));
      }

      // Wait for aggregation window to flush
      await delay(150);

      expect(aggregateEmitted).not.toBeNull();
      expect(aggregateEmitted!.swapCount).toBe(5);
      expect(aggregateEmitted!.totalUsdVolume).toBe(5000);
      expect(aggregateEmitted!.pairAddress).toBe(pairAddress);

      shortWindowFilter.destroy();
    });

    it('should aggregate separately by pair address', async () => {
      const shortWindowFilter = new SwapEventFilter({
        aggregationWindowMs: 100
      });

      const aggregates: VolumeAggregate[] = [];
      shortWindowFilter.onVolumeAggregate((agg: VolumeAggregate) => {
        aggregates.push(agg);
      });

      const pair1 = '0xpair1111111111111111111111111111111111111';
      const pair2 = '0xpair2222222222222222222222222222222222222';

      shortWindowFilter.processEvent(createMockSwapEvent({
        pairAddress: pair1,
        usdValue: 1000,
        transactionHash: '0xtx1'
      }));
      shortWindowFilter.processEvent(createMockSwapEvent({
        pairAddress: pair1,
        usdValue: 2000,
        transactionHash: '0xtx2'
      }));
      shortWindowFilter.processEvent(createMockSwapEvent({
        pairAddress: pair2,
        usdValue: 3000,
        transactionHash: '0xtx3'
      }));

      await delay(150);

      expect(aggregates.length).toBe(2);

      const pair1Agg = aggregates.find(a => a.pairAddress === pair1);
      const pair2Agg = aggregates.find(a => a.pairAddress === pair2);

      expect(pair1Agg).toBeDefined();
      expect(pair1Agg!.swapCount).toBe(2);
      expect(pair1Agg!.totalUsdVolume).toBe(3000);

      expect(pair2Agg).toBeDefined();
      expect(pair2Agg!.swapCount).toBe(1);
      expect(pair2Agg!.totalUsdVolume).toBe(3000);

      shortWindowFilter.destroy();
    });

    it('should calculate min/max/avg price in aggregates', async () => {
      const shortWindowFilter = new SwapEventFilter({
        aggregationWindowMs: 100
      });

      let aggregateEmitted: VolumeAggregate | null = null;
      shortWindowFilter.onVolumeAggregate((agg: VolumeAggregate) => {
        aggregateEmitted = agg;
      });

      const pairAddress = generateRandomAddress();

      // Add swaps with different effective prices
      shortWindowFilter.processEvent(createMockSwapEvent({
        pairAddress,
        amount0In: '1000000000000000000', // 1 ETH
        amount1Out: '1800000000', // 1800 USDC
        usdValue: 1800,
        transactionHash: '0xtx1'
      }));
      shortWindowFilter.processEvent(createMockSwapEvent({
        pairAddress,
        amount0In: '1000000000000000000',
        amount1Out: '2000000000',
        usdValue: 2000,
        transactionHash: '0xtx2'
      }));
      shortWindowFilter.processEvent(createMockSwapEvent({
        pairAddress,
        amount0In: '1000000000000000000',
        amount1Out: '2200000000',
        usdValue: 2200,
        transactionHash: '0xtx3'
      }));

      await delay(150);

      expect(aggregateEmitted).not.toBeNull();
      expect(aggregateEmitted!.minPrice).toBeDefined();
      expect(aggregateEmitted!.maxPrice).toBeDefined();
      expect(aggregateEmitted!.avgPrice).toBeDefined();

      shortWindowFilter.destroy();
    });

    it('should support unsubscribing from volume aggregates', async () => {
      const shortWindowFilter = new SwapEventFilter({
        aggregationWindowMs: 50
      });

      let aggregateCount = 0;
      const unsubscribe = shortWindowFilter.onVolumeAggregate(() => {
        aggregateCount++;
      });

      shortWindowFilter.processEvent(createMockSwapEvent({
        usdValue: 1000,
        transactionHash: '0xtx1'
      }));

      await delay(80);
      expect(aggregateCount).toBe(1);

      // Unsubscribe
      unsubscribe();

      shortWindowFilter.processEvent(createMockSwapEvent({
        usdValue: 2000,
        transactionHash: '0xtx2'
      }));

      await delay(80);
      expect(aggregateCount).toBe(1); // Still 1, not 2

      shortWindowFilter.destroy();
    });
  });

  // =========================================================================
  // S1.2.4: Filter Statistics and Metrics
  // =========================================================================
  describe('S1.2.4: Filter Statistics and Metrics', () => {
    beforeEach(() => {
      filter = new SwapEventFilter();
    });

    it('should track comprehensive filter statistics', () => {
      // Process mix of events
      filter.processEvent(createMockSwapEvent({ usdValue: 5, transactionHash: '0xtx1' })); // Filtered (low value)
      filter.processEvent(createMockSwapEvent({ usdValue: 1000, transactionHash: '0xtx2' })); // Pass
      filter.processEvent(createMockSwapEvent({ usdValue: 60000, transactionHash: '0xtx3' })); // Pass + Whale

      const stats = filter.getStats();

      expect(stats.totalProcessed).toBe(3);
      expect(stats.totalPassed).toBe(2);
      expect(stats.totalFiltered).toBe(1);
      expect(stats.whaleAlerts).toBe(1);
      expect(stats.filterRate).toBeCloseTo(33.33, 0);
    });

    it('should track filter reasons breakdown', () => {
      filter.processEvent(createMockSwapEvent({
        amount0In: '0',
        amount1In: '0',
        amount0Out: '0',
        amount1Out: '0',
        usdValue: 0,
        transactionHash: '0xtx1'
      })); // zero_amount

      filter.processEvent(createMockSwapEvent({
        usdValue: 5,
        transactionHash: '0xtx2'
      })); // below_min_value

      const samePairAddress = '0xsamepair1111111111111111111111111111111';
      filter.processEvent(createMockSwapEvent({
        usdValue: 100,
        transactionHash: '0xtx3',
        pairAddress: samePairAddress
      })); // pass

      filter.processEvent(createMockSwapEvent({
        usdValue: 100,
        transactionHash: '0xtx3',
        pairAddress: samePairAddress
      })); // duplicate

      const stats = filter.getStats();

      expect(stats.filterReasons['zero_amount']).toBe(1);
      expect(stats.filterReasons['below_min_value']).toBe(1);
      expect(stats.filterReasons['duplicate']).toBe(1);
    });

    it('should calculate average processing time', () => {
      for (let i = 0; i < 10; i++) {
        filter.processEvent(createMockSwapEvent({
          usdValue: 1000,
          transactionHash: `0xtx${i}`
        }));
      }

      const stats = filter.getStats();

      expect(stats.avgProcessingTimeMs).toBeDefined();
      expect(stats.avgProcessingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should reset statistics correctly', () => {
      filter.processEvent(createMockSwapEvent({ usdValue: 1000, transactionHash: '0xtx1' }));
      filter.processEvent(createMockSwapEvent({ usdValue: 60000, transactionHash: '0xtx2' }));

      filter.resetStats();
      const stats = filter.getStats();

      expect(stats.totalProcessed).toBe(0);
      expect(stats.totalPassed).toBe(0);
      expect(stats.totalFiltered).toBe(0);
      expect(stats.whaleAlerts).toBe(0);
    });

    it('should return deep copy of stats to prevent external mutation', () => {
      filter.processEvent(createMockSwapEvent({ usdValue: 5, transactionHash: '0xtx1' }));

      const stats1 = filter.getStats();
      stats1.filterReasons['below_min_value'] = 999; // Attempt to mutate

      const stats2 = filter.getStats();
      expect(stats2.filterReasons['below_min_value']).toBe(1); // Should be unchanged
    });
  });

  // =========================================================================
  // S1.2.5: Prometheus Metrics Export
  // =========================================================================
  describe('S1.2.5: Prometheus Metrics Export', () => {
    beforeEach(() => {
      filter = new SwapEventFilter();
    });

    it('should export Prometheus-format metrics', () => {
      filter.processEvent(createMockSwapEvent({ usdValue: 1000, transactionHash: '0xtx1' }));
      filter.processEvent(createMockSwapEvent({ usdValue: 60000, transactionHash: '0xtx2' }));

      const metrics = filter.getPrometheusMetrics();

      expect(metrics).toContain('swap_filter_total_processed');
      expect(metrics).toContain('swap_filter_total_passed');
      expect(metrics).toContain('swap_filter_total_filtered');
      expect(metrics).toContain('swap_filter_whale_alerts');
      expect(metrics).toContain('swap_filter_rate');
      expect(metrics).toContain('swap_filter_avg_processing_time_ms');
      expect(metrics).toContain('swap_filter_dedup_cache_size');
      expect(metrics).toContain('swap_filter_reason_count');
    });

    it('should include correct metric types (counter vs gauge)', () => {
      const metrics = filter.getPrometheusMetrics();

      expect(metrics).toContain('# TYPE swap_filter_total_processed counter');
      expect(metrics).toContain('# TYPE swap_filter_rate gauge');
    });
  });

  // =========================================================================
  // Integration: Batch Processing
  // =========================================================================
  describe('Integration: Batch Processing', () => {
    beforeEach(() => {
      filter = new SwapEventFilter();
    });

    it('should efficiently process large batches', async () => {
      const events = Array.from({ length: 1000 }, (_, i) =>
        createMockSwapEvent({
          usdValue: i * 10,
          transactionHash: `0xtx${i}`
        })
      );

      const startTime = Date.now();
      const results = filter.processBatch(events);
      const endTime = Date.now();

      expect(results.passed.length + results.filtered.length).toBe(1000);
      expect(endTime - startTime).toBeLessThan(500); // Should complete in <500ms

      const stats = filter.getStats();
      expect(stats.totalProcessed).toBe(1000);
    });

    it('should categorize batch results correctly', () => {
      const samePairAddress = '0xsamepair1111111111111111111111111111111';
      const events = [
        createMockSwapEvent({ usdValue: 5, transactionHash: '0xtx1' }), // Filtered (low value)
        createMockSwapEvent({ usdValue: 1000, transactionHash: '0xtx2', pairAddress: samePairAddress }), // Pass
        createMockSwapEvent({ usdValue: 1000, transactionHash: '0xtx2', pairAddress: samePairAddress }), // Filtered (duplicate)
        createMockSwapEvent({ usdValue: 60000, transactionHash: '0xtx3' }) // Pass + Whale
      ];

      const results = filter.processBatch(events);

      expect(results.passed.length).toBe(2);
      expect(results.filtered.length).toBe(2);
      expect(results.whaleAlerts.length).toBe(1);
    });
  });

  // =========================================================================
  // Integration: Memory Management
  // =========================================================================
  describe('Integration: Memory Management', () => {
    it('should cleanup dedup cache to prevent unbounded growth', async () => {
      const memoryFilter = new SwapEventFilter({
        dedupWindowMs: 50,
        maxDedupCacheSize: 100
      });

      // Add more events than max cache size
      for (let i = 0; i < 200; i++) {
        memoryFilter.processEvent(createMockSwapEvent({
          transactionHash: `0xtx${i}`,
          usdValue: 100
        }));
      }

      // Wait for cleanup
      await delay(100);

      const cacheSize = memoryFilter.getDedupCacheSize();
      expect(cacheSize).toBeLessThanOrEqual(100);

      memoryFilter.destroy();
    });

    it('should cleanup aggregation buckets after flush', async () => {
      const memoryFilter = new SwapEventFilter({
        aggregationWindowMs: 50
      });

      // Add events
      for (let i = 0; i < 10; i++) {
        memoryFilter.processEvent(createMockSwapEvent({
          transactionHash: `0xtx${i}`,
          usdValue: 100
        }));
      }

      // Wait for aggregation flush
      await delay(100);

      const bucketCount = memoryFilter.getAggregationBucketCount();
      expect(bucketCount).toBe(0);

      memoryFilter.destroy();
    });
  });

  // =========================================================================
  // Integration: Singleton Pattern
  // =========================================================================
  describe('Integration: Singleton Pattern', () => {
    afterEach(() => {
      resetSwapEventFilter();
    });

    it('should return same instance from getSwapEventFilter', () => {
      const instance1 = getSwapEventFilter();
      const instance2 = getSwapEventFilter();

      expect(instance1).toBe(instance2);

      instance1.destroy();
    });

    it('should reset singleton instance correctly', () => {
      const instance1 = getSwapEventFilter();
      resetSwapEventFilter();
      const instance2 = getSwapEventFilter();

      expect(instance1).not.toBe(instance2);

      instance2.destroy();
    });
  });

  // =========================================================================
  // Integration: Edge Cases and Error Handling
  // =========================================================================
  describe('Integration: Edge Cases and Error Handling', () => {
    beforeEach(() => {
      filter = new SwapEventFilter();
    });

    it('should handle malformed swap events gracefully', () => {
      const malformedSwap = {
        pairAddress: '0x123'
        // Missing many required fields
      } as SwapEvent;

      expect(() => filter.processEvent(malformedSwap)).not.toThrow();

      const result = filter.processEvent(malformedSwap);
      expect(result.passed).toBe(false);
      expect(result.filterReason).toBe('invalid_event');
    });

    it('should handle very large USD values', () => {
      const hugeSwap = createMockSwapEvent({
        usdValue: 1_000_000_000 // $1 billion
      });

      const result = filter.processEvent(hugeSwap);

      expect(result.passed).toBe(true);
      expect(result.isWhale).toBe(true);
    });

    it('should return filtered result after destroy', () => {
      const tempFilter = new SwapEventFilter();
      tempFilter.destroy();

      const result = tempFilter.processEvent(createMockSwapEvent({ usdValue: 1000 }));

      expect(result.passed).toBe(false);
      expect(result.filterReason).toBe('invalid_event');
    });

    it('should handle concurrent-like processing', async () => {
      const events = Array.from({ length: 100 }, (_, i) =>
        createMockSwapEvent({
          usdValue: 1000,
          transactionHash: `0xtx${i}`
        })
      );

      // Process concurrently
      const results = await Promise.all(
        events.map(event => Promise.resolve(filter.processEvent(event)))
      );

      expect(results.length).toBe(100);
      expect(results.filter((r: FilterResult) => r.passed).length).toBe(100);
    });
  });

  // =========================================================================
  // Performance Benchmarks
  // =========================================================================
  describe('Performance Benchmarks', () => {
    beforeEach(() => {
      filter = new SwapEventFilter();
    });

    it('should process single event in <1ms average', async () => {
      const swap = createMockSwapEvent({ usdValue: 1000 });

      const { averageTime } = await measurePerformance(
        () => Promise.resolve(filter.processEvent(
          createMockSwapEvent({
            usdValue: 1000,
            transactionHash: generateRandomHash()
          })
        )),
        1000
      );

      expect(averageTime).toBeLessThan(1); // <1ms average
    });

    it('should maintain consistent performance under load', async () => {
      // Warmup
      for (let i = 0; i < 100; i++) {
        filter.processEvent(createMockSwapEvent({
          usdValue: 1000,
          transactionHash: `0xwarmup${i}`
        }));
      }

      filter.resetStats();

      // Measure under load
      const { averageTime, maxTime } = await measurePerformance(
        () => Promise.resolve(filter.processEvent(
          createMockSwapEvent({
            usdValue: 1000,
            transactionHash: generateRandomHash()
          })
        )),
        500
      );

      expect(averageTime).toBeLessThan(1);
      expect(maxTime).toBeLessThan(10); // No major spikes
    });
  });

  // =========================================================================
  // Hypothesis Validation: 99% Event Reduction with 100% Signal Retention
  // =========================================================================
  describe('Hypothesis Validation: Event Reduction with Signal Retention', () => {
    beforeEach(() => {
      filter = new SwapEventFilter({
        minUsdValue: 10,
        whaleThreshold: 50000
      });
    });

    it('should achieve high event reduction while retaining actionable signals', () => {
      // Simulate realistic distribution of swap events
      // 80% dust (<$10), 19% normal ($10-$50K), 1% whale (>$50K)
      const events: SwapEvent[] = [];

      // 800 dust transactions
      for (let i = 0; i < 800; i++) {
        events.push(createMockSwapEvent({
          usdValue: Math.random() * 9, // $0-$9
          transactionHash: `0xdust${i}`
        }));
      }

      // 190 normal transactions
      for (let i = 0; i < 190; i++) {
        events.push(createMockSwapEvent({
          usdValue: 10 + Math.random() * 49990, // $10-$50K
          transactionHash: `0xnormal${i}`
        }));
      }

      // 10 whale transactions
      for (let i = 0; i < 10; i++) {
        events.push(createMockSwapEvent({
          usdValue: 50000 + Math.random() * 950000, // $50K-$1M
          transactionHash: `0xwhale${i}`
        }));
      }

      const results = filter.processBatch(events);
      const stats = filter.getStats();

      // Verify event reduction
      const reductionRate = (stats.totalFiltered / stats.totalProcessed) * 100;
      expect(reductionRate).toBeGreaterThan(70); // At least 70% reduction

      // Verify signal retention - all whales should be detected
      expect(results.whaleAlerts.length).toBe(10);

      // Verify all actionable transactions passed
      expect(results.passed.length).toBe(200); // 190 normal + 10 whale
    });

    it('should detect 100% of whale transactions', () => {
      const whaleSwaps = Array.from({ length: 100 }, (_, i) =>
        createMockSwapEvent({
          usdValue: 60000 + Math.random() * 940000,
          transactionHash: `0xwhale${i}`
        })
      );

      const results = filter.processBatch(whaleSwaps);

      expect(results.whaleAlerts.length).toBe(100);
      expect(results.passed.length).toBe(100);
    });
  });
});
