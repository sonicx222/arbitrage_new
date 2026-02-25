/**
 * SwapEventFilter Tests (TDD - Red Phase)
 *
 * Tests for S1.2: Smart Swap Event Filtering
 * Hypothesis: 99% event reduction with 100% signal retention through smart filtering
 *
 * @migrated from shared/core/src/swap-event-filter.test.ts
 * @see IMPLEMENTATION_PLAN.md S1.2
 * @see ADR-009: Test Architecture
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Import from package alias (new pattern per ADR-009)
import { SwapEventFilter, getSwapEventFilter, resetSwapEventFilter } from '@arbitrage/core/analytics';

import type { SwapEvent } from '@arbitrage/types';
import type {
  SwapEventFilterConfig,
  FilterResult,
  VolumeAggregate,
  WhaleAlert,
} from '@arbitrage/core/analytics';

// Helper to create mock swap events
function createMockSwapEvent(overrides: Partial<SwapEvent> = {}): SwapEvent {
  return {
    pairAddress: '0x1234567890123456789012345678901234567890',
    sender: '0xsender123',
    recipient: '0xrecipient456',
    amount0In: '1000000000000000000', // 1 ETH in wei
    amount1In: '0',
    amount0Out: '0',
    amount1Out: '2000000000', // 2000 USDC (6 decimals)
    to: '0xto789',
    blockNumber: 12345678,
    transactionHash: '0xtxhash' + Math.random().toString(16).slice(2, 10),
    timestamp: Date.now(),
    dex: 'uniswap_v3',
    chain: 'ethereum',
    usdValue: 2000,
    ...overrides
  };
}

describe('SwapEventFilter', () => {
  let filter: SwapEventFilter;

  beforeEach(() => {
    jest.useFakeTimers();
    resetSwapEventFilter();
    filter = new SwapEventFilter();
  });

  afterEach(() => {
    filter.destroy();
    jest.useRealTimers();
  });

  describe('Constructor and Configuration', () => {
    it('should create filter with default configuration', () => {
      expect(filter).toBeDefined();
      const config = filter.getConfig();
      expect(config.minUsdValue).toBeDefined();
      expect(config.whaleThreshold).toBeDefined();
      expect(config.dedupWindowMs).toBeDefined();
      expect(config.aggregationWindowMs).toBeDefined();
    });

    it('should accept custom configuration', () => {
      const customConfig: Partial<SwapEventFilterConfig> = {
        minUsdValue: 100,
        whaleThreshold: 100000,
        dedupWindowMs: 10000,
        aggregationWindowMs: 10000
      };
      const customFilter = new SwapEventFilter(customConfig);
      const config = customFilter.getConfig();

      expect(config.minUsdValue).toBe(100);
      expect(config.whaleThreshold).toBe(100000);
      expect(config.dedupWindowMs).toBe(10000);
      expect(config.aggregationWindowMs).toBe(10000);

      customFilter.destroy();
    });

    it('should update configuration at runtime', () => {
      filter.updateConfig({ minUsdValue: 500 });
      expect(filter.getConfig().minUsdValue).toBe(500);
    });
  });

  describe('Edge Filter (Dust Filter)', () => {
    it('should filter out swaps with zero amounts', () => {
      const zeroSwap = createMockSwapEvent({
        amount0In: '0',
        amount1In: '0',
        amount0Out: '0',
        amount1Out: '0',
        usdValue: 0
      });

      const result = filter.processEvent(zeroSwap);
      expect(result.passed).toBe(false);
      expect(result.filterReason).toBe('zero_amount');
    });

    it('should filter out swaps below minimum USD value', () => {
      const dustSwap = createMockSwapEvent({
        usdValue: 5 // Below default threshold
      });

      const result = filter.processEvent(dustSwap);
      expect(result.passed).toBe(false);
      expect(result.filterReason).toBe('below_min_value');
    });

    it('should pass swaps above minimum USD value', () => {
      const validSwap = createMockSwapEvent({
        usdValue: 100 // Above default threshold
      });

      const result = filter.processEvent(validSwap);
      expect(result.passed).toBe(true);
    });

    it('should handle swaps without usdValue by using amount estimation', () => {
      const swapNoUsd = createMockSwapEvent({
        amount0In: '1000000000000000000', // 1 token
        usdValue: undefined
      });

      // Should not throw and should make a reasonable decision
      const result = filter.processEvent(swapNoUsd);
      expect(result).toBeDefined();
      expect(typeof result.passed).toBe('boolean');
    });
  });

  describe('Deduplication Filter', () => {
    it('should filter duplicate swaps with same transaction hash', () => {
      const swap1 = createMockSwapEvent({
        transactionHash: '0xsametxhash123'
      });
      const swap2 = createMockSwapEvent({
        transactionHash: '0xsametxhash123'
      });

      const result1 = filter.processEvent(swap1);
      const result2 = filter.processEvent(swap2);

      expect(result1.passed).toBe(true);
      expect(result2.passed).toBe(false);
      expect(result2.filterReason).toBe('duplicate');
    });

    it('should allow different swaps in same transaction (different pairs)', () => {
      const swap1 = createMockSwapEvent({
        transactionHash: '0xsametxhash123',
        pairAddress: '0xpair1'
      });
      const swap2 = createMockSwapEvent({
        transactionHash: '0xsametxhash123',
        pairAddress: '0xpair2'
      });

      const result1 = filter.processEvent(swap1);
      const result2 = filter.processEvent(swap2);

      expect(result1.passed).toBe(true);
      expect(result2.passed).toBe(true);
    });

    it('should expire dedup cache after window passes', async () => {
      const customFilter = new SwapEventFilter({ dedupWindowMs: 100 });
      const swap = createMockSwapEvent({
        transactionHash: '0xexpirableHash'
      });

      const result1 = customFilter.processEvent(swap);
      expect(result1.passed).toBe(true);

      // Advance past dedup window to expire
      jest.advanceTimersByTime(150);

      // Same swap should pass again after expiry
      const result2 = customFilter.processEvent(swap);
      expect(result2.passed).toBe(true);

      customFilter.destroy();
    });
  });

  describe('Whale Detection', () => {
    it('should detect whale transactions above threshold', () => {
      const whaleSwap = createMockSwapEvent({
        usdValue: 60000 // Above $50K threshold
      });

      const result = filter.processEvent(whaleSwap);
      expect(result.passed).toBe(true);
      expect(result.isWhale).toBe(true);
    });

    it('should not flag normal transactions as whale', () => {
      const normalSwap = createMockSwapEvent({
        usdValue: 5000 // Below $50K threshold
      });

      const result = filter.processEvent(normalSwap);
      expect(result.isWhale).toBe(false);
    });

    it('should emit whale alert event', (done) => {
      filter.onWhaleAlert((alert: WhaleAlert) => {
        expect(alert.event).toBeDefined();
        expect(alert.usdValue).toBeGreaterThanOrEqual(50000);
        expect(alert.timestamp).toBeDefined();
        done();
      });

      const whaleSwap = createMockSwapEvent({
        usdValue: 75000
      });

      filter.processEvent(whaleSwap);
    });

    it('should include whale alerts in batch processing results', () => {
      const events = [
        createMockSwapEvent({ usdValue: 1000 }),
        createMockSwapEvent({ usdValue: 60000 }), // Whale
        createMockSwapEvent({ usdValue: 2000 }),
        createMockSwapEvent({ usdValue: 100000 }) // Whale
      ];

      const results = filter.processBatch(events);
      const whaleAlerts = results.whaleAlerts;

      expect(whaleAlerts.length).toBe(2);
      expect(whaleAlerts[0].usdValue).toBe(60000);
      expect(whaleAlerts[1].usdValue).toBe(100000);
    });
  });

  describe('Volume Aggregation', () => {
    it('should aggregate volume within time window', async () => {
      const customFilter = new SwapEventFilter({ aggregationWindowMs: 100 });
      let aggregateEmitted: VolumeAggregate | null = null;

      customFilter.onVolumeAggregate((aggregate: VolumeAggregate) => {
        aggregateEmitted = aggregate;
      });

      // Add multiple swaps
      for (let i = 0; i < 5; i++) {
        customFilter.processEvent(createMockSwapEvent({
          usdValue: 1000,
          pairAddress: '0xsamepair',
          transactionHash: `0xtx${i}`
        }));
      }

      // Advance past aggregation window
      jest.advanceTimersByTime(150);

      expect(aggregateEmitted).not.toBeNull();
      expect(aggregateEmitted!.swapCount).toBe(5);
      expect(aggregateEmitted!.totalUsdVolume).toBe(5000);

      customFilter.destroy();
    });

    it('should aggregate by pair address', async () => {
      const customFilter = new SwapEventFilter({ aggregationWindowMs: 100 });
      const aggregates: VolumeAggregate[] = [];

      customFilter.onVolumeAggregate((aggregate: VolumeAggregate) => {
        aggregates.push(aggregate);
      });

      // Add swaps for different pairs
      customFilter.processEvent(createMockSwapEvent({
        pairAddress: '0xpair1',
        usdValue: 1000,
        transactionHash: '0xtx1'
      }));
      customFilter.processEvent(createMockSwapEvent({
        pairAddress: '0xpair1',
        usdValue: 2000,
        transactionHash: '0xtx2'
      }));
      customFilter.processEvent(createMockSwapEvent({
        pairAddress: '0xpair2',
        usdValue: 3000,
        transactionHash: '0xtx3'
      }));

      // Advance past aggregation window
      jest.advanceTimersByTime(150);

      expect(aggregates.length).toBe(2); // Two different pairs

      const pair1Agg = aggregates.find(a => a.pairAddress === '0xpair1');
      const pair2Agg = aggregates.find(a => a.pairAddress === '0xpair2');

      expect(pair1Agg).toBeDefined();
      expect(pair1Agg!.swapCount).toBe(2);
      expect(pair1Agg!.totalUsdVolume).toBe(3000);

      expect(pair2Agg).toBeDefined();
      expect(pair2Agg!.swapCount).toBe(1);
      expect(pair2Agg!.totalUsdVolume).toBe(3000);

      customFilter.destroy();
    });

    it('should include min/max/avg price in aggregates', async () => {
      const customFilter = new SwapEventFilter({ aggregationWindowMs: 100 });
      let aggregateEmitted: VolumeAggregate | null = null;

      customFilter.onVolumeAggregate((aggregate: VolumeAggregate) => {
        aggregateEmitted = aggregate;
      });

      // Add swaps with different effective prices
      customFilter.processEvent(createMockSwapEvent({
        amount0In: '1000000000000000000', // 1 ETH
        amount1Out: '1800000000', // 1800 USDC = $1800/ETH
        usdValue: 1800,
        transactionHash: '0xtx1'
      }));
      customFilter.processEvent(createMockSwapEvent({
        amount0In: '1000000000000000000', // 1 ETH
        amount1Out: '2000000000', // 2000 USDC = $2000/ETH
        usdValue: 2000,
        transactionHash: '0xtx2'
      }));
      customFilter.processEvent(createMockSwapEvent({
        amount0In: '1000000000000000000', // 1 ETH
        amount1Out: '2200000000', // 2200 USDC = $2200/ETH
        usdValue: 2200,
        transactionHash: '0xtx3'
      }));

      jest.advanceTimersByTime(150);

      expect(aggregateEmitted).not.toBeNull();
      expect(aggregateEmitted!.minPrice).toBeDefined();
      expect(aggregateEmitted!.maxPrice).toBeDefined();
      expect(aggregateEmitted!.avgPrice).toBeDefined();

      customFilter.destroy();
    });
  });

  describe('Batch Processing', () => {
    it('should process multiple events efficiently', () => {
      const events = Array.from({ length: 100 }, (_, i) =>
        createMockSwapEvent({
          usdValue: i * 100,
          transactionHash: `0xtx${i}`
        })
      );

      const startTime = Date.now();
      const results = filter.processBatch(events);
      const endTime = Date.now();

      expect(results.passed.length).toBeGreaterThan(0);
      expect(results.filtered.length).toBeGreaterThan(0);
      expect(results.passed.length + results.filtered.length).toBe(100);
      expect(endTime - startTime).toBeLessThan(100); // Should be fast
    });

    it('should return categorized results', () => {
      const events = [
        createMockSwapEvent({ usdValue: 5, transactionHash: '0xtx1' }), // Filtered (low value)
        createMockSwapEvent({ usdValue: 1000, transactionHash: '0xtx2' }), // Pass
        createMockSwapEvent({ usdValue: 1000, transactionHash: '0xtx2' }), // Filtered (duplicate)
        createMockSwapEvent({ usdValue: 60000, transactionHash: '0xtx3' }) // Pass + Whale
      ];

      const results = filter.processBatch(events);

      expect(results.passed.length).toBe(2);
      expect(results.filtered.length).toBe(2);
      expect(results.whaleAlerts.length).toBe(1);
    });
  });

  describe('Filter Statistics', () => {
    it('should track filter statistics', () => {
      // Process some events
      filter.processEvent(createMockSwapEvent({ usdValue: 5, transactionHash: '0xtx1' })); // Filtered
      filter.processEvent(createMockSwapEvent({ usdValue: 1000, transactionHash: '0xtx2' })); // Pass
      filter.processEvent(createMockSwapEvent({ usdValue: 60000, transactionHash: '0xtx3' })); // Whale

      const stats = filter.getStats();

      expect(stats.totalProcessed).toBe(3);
      expect(stats.totalPassed).toBe(2);
      expect(stats.totalFiltered).toBe(1);
      expect(stats.whaleAlerts).toBe(1);
      expect(stats.filterRate).toBeCloseTo(33.33, 0); // ~33% filtered
    });

    it('should track filter reasons breakdown', () => {
      // zero_amount requires all amount fields to be zero
      filter.processEvent(createMockSwapEvent({
        amount0In: '0',
        amount1In: '0',
        amount0Out: '0',
        amount1Out: '0',
        usdValue: 0,
        transactionHash: '0xtx1'
      })); // zero_amount
      filter.processEvent(createMockSwapEvent({ usdValue: 5, transactionHash: '0xtx2' })); // below_min_value
      filter.processEvent(createMockSwapEvent({ usdValue: 100, transactionHash: '0xtx3' })); // pass
      filter.processEvent(createMockSwapEvent({ usdValue: 100, transactionHash: '0xtx3' })); // duplicate

      const stats = filter.getStats();

      expect(stats.filterReasons['zero_amount']).toBe(1);
      expect(stats.filterReasons['below_min_value']).toBe(1);
      expect(stats.filterReasons['duplicate']).toBe(1);
    });

    it('should reset statistics', () => {
      filter.processEvent(createMockSwapEvent({ usdValue: 1000, transactionHash: '0xtx1' }));
      filter.processEvent(createMockSwapEvent({ usdValue: 60000, transactionHash: '0xtx2' }));

      filter.resetStats();
      const stats = filter.getStats();

      expect(stats.totalProcessed).toBe(0);
      expect(stats.totalPassed).toBe(0);
      expect(stats.totalFiltered).toBe(0);
      expect(stats.whaleAlerts).toBe(0);
    });

    it('should calculate average processing time', () => {
      // Process multiple events
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
  });

  describe('Singleton Pattern', () => {
    it('should return same instance from getSwapEventFilter', () => {
      const instance1 = getSwapEventFilter();
      const instance2 = getSwapEventFilter();

      expect(instance1).toBe(instance2);
    });

    it('should reset singleton instance', () => {
      const instance1 = getSwapEventFilter();
      resetSwapEventFilter();
      const instance2 = getSwapEventFilter();

      expect(instance1).not.toBe(instance2);
    });
  });

  describe('Memory Management', () => {
    it('should cleanup dedup cache periodically', async () => {
      const customFilter = new SwapEventFilter({
        dedupWindowMs: 50,
        maxDedupCacheSize: 100
      });

      // Add many events
      for (let i = 0; i < 200; i++) {
        customFilter.processEvent(createMockSwapEvent({
          transactionHash: `0xtx${i}`,
          usdValue: 100
        }));
      }

      // Advance past cleanup interval
      jest.advanceTimersByTime(100);

      // Internal cache should be cleaned up
      const cacheSize = customFilter.getDedupCacheSize();
      expect(cacheSize).toBeLessThan(200);

      customFilter.destroy();
    });

    it('should cleanup aggregation buckets after flush', async () => {
      const customFilter = new SwapEventFilter({
        aggregationWindowMs: 50
      });

      // Add events
      for (let i = 0; i < 10; i++) {
        customFilter.processEvent(createMockSwapEvent({
          transactionHash: `0xtx${i}`,
          usdValue: 100
        }));
      }

      // Advance past aggregation flush interval
      jest.advanceTimersByTime(100);

      const bucketCount = customFilter.getAggregationBucketCount();
      expect(bucketCount).toBe(0);

      customFilter.destroy();
    });
  });

  describe('Edge Cases', () => {
    it('should handle malformed swap events gracefully', () => {
      const malformedSwap = {
        pairAddress: '0x123',
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

    it('should handle negative USD values', () => {
      const negativeSwap = createMockSwapEvent({
        usdValue: -1000
      });

      const result = filter.processEvent(negativeSwap);
      expect(result.passed).toBe(false);
      expect(result.filterReason).toBe('invalid_value');
    });

    it('should handle concurrent processing', async () => {
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
      expect(results.filter(r => r.passed).length).toBe(100);
    });

    it('should handle invalid BigInt amount strings gracefully', () => {
      const invalidAmountSwap = createMockSwapEvent({
        amount0In: 'invalid',
        amount1In: 'not-a-number',
        amount0Out: '',
        amount1Out: 'abc123',
        usdValue: 100,
        transactionHash: '0xtx-invalid'
      });

      // Should not throw, should filter as zero amount
      expect(() => filter.processEvent(invalidAmountSwap)).not.toThrow();
      const result = filter.processEvent(invalidAmountSwap);
      expect(result.passed).toBe(false);
      expect(result.filterReason).toBe('zero_amount');
    });

    it('should return filtered result after destroy', () => {
      const tempFilter = new SwapEventFilter();
      tempFilter.destroy();

      const result = tempFilter.processEvent(createMockSwapEvent({ usdValue: 1000 }));
      expect(result.passed).toBe(false);
      expect(result.filterReason).toBe('invalid_event');
    });

    it('should support unsubscribing from whale alerts', () => {
      const tempFilter = new SwapEventFilter();
      let alertCount = 0;

      const unsubscribe = tempFilter.onWhaleAlert(() => {
        alertCount++;
      });

      // First whale - should trigger
      tempFilter.processEvent(createMockSwapEvent({ usdValue: 60000, transactionHash: '0xtx1' }));
      expect(alertCount).toBe(1);

      // Unsubscribe
      unsubscribe();

      // Second whale - should NOT trigger handler
      tempFilter.processEvent(createMockSwapEvent({ usdValue: 70000, transactionHash: '0xtx2' }));
      expect(alertCount).toBe(1); // Still 1, not 2

      tempFilter.destroy();
    });

    it('should support unsubscribing from volume aggregates', async () => {
      const tempFilter = new SwapEventFilter({ aggregationWindowMs: 50 });
      let aggregateCount = 0;

      const unsubscribe = tempFilter.onVolumeAggregate(() => {
        aggregateCount++;
      });

      // Add event
      tempFilter.processEvent(createMockSwapEvent({ usdValue: 1000, transactionHash: '0xtx1' }));

      // Advance past aggregation window
      jest.advanceTimersByTime(80);
      expect(aggregateCount).toBe(1);

      // Unsubscribe
      unsubscribe();

      // Add another event
      tempFilter.processEvent(createMockSwapEvent({ usdValue: 2000, transactionHash: '0xtx2' }));

      // Advance past aggregation window
      jest.advanceTimersByTime(80);
      expect(aggregateCount).toBe(1); // Still 1, not 2

      tempFilter.destroy();
    });
  });

  describe('Integration with Metrics', () => {
    it('should export Prometheus metrics', () => {
      filter.processEvent(createMockSwapEvent({ usdValue: 1000, transactionHash: '0xtx1' }));
      filter.processEvent(createMockSwapEvent({ usdValue: 60000, transactionHash: '0xtx2' }));

      const metrics = filter.getPrometheusMetrics();

      expect(metrics).toContain('swap_filter_total_processed');
      expect(metrics).toContain('swap_filter_total_passed');
      expect(metrics).toContain('swap_filter_total_filtered');
      expect(metrics).toContain('swap_filter_whale_alerts');
      expect(metrics).toContain('swap_filter_rate');
    });
  });
});

describe('FilterResult Interface', () => {
  it('should have correct shape', () => {
    const filter = new SwapEventFilter();
    const result = filter.processEvent(createMockSwapEvent({ usdValue: 1000 }));

    expect(result).toHaveProperty('passed');
    expect(result).toHaveProperty('event');
    expect(result).toHaveProperty('isWhale');
    expect(result).toHaveProperty('processingTimeMs');

    if (!result.passed) {
      expect(result).toHaveProperty('filterReason');
    }

    filter.destroy();
  });
});

describe('VolumeAggregate Interface', () => {
  it('should have correct shape when emitted', async () => {
    const filter = new SwapEventFilter({ aggregationWindowMs: 50 });
    let aggregate: VolumeAggregate | null = null;

    filter.onVolumeAggregate((agg) => {
      aggregate = agg;
    });

    filter.processEvent(createMockSwapEvent({
      usdValue: 1000,
      transactionHash: '0xtx1'
    }));

    await new Promise(resolve => setTimeout(resolve, 100));

    expect(aggregate).not.toBeNull();
    expect(aggregate).toHaveProperty('pairAddress');
    expect(aggregate).toHaveProperty('chain');
    expect(aggregate).toHaveProperty('dex');
    expect(aggregate).toHaveProperty('swapCount');
    expect(aggregate).toHaveProperty('totalUsdVolume');
    expect(aggregate).toHaveProperty('minPrice');
    expect(aggregate).toHaveProperty('maxPrice');
    expect(aggregate).toHaveProperty('avgPrice');
    expect(aggregate).toHaveProperty('windowStartMs');
    expect(aggregate).toHaveProperty('windowEndMs');

    filter.destroy();
  });
});

describe('WhaleAlert Interface', () => {
  it('should have correct shape when emitted', (done) => {
    const filter = new SwapEventFilter();

    filter.onWhaleAlert((alert) => {
      expect(alert).toHaveProperty('event');
      expect(alert).toHaveProperty('usdValue');
      expect(alert).toHaveProperty('timestamp');
      expect(alert).toHaveProperty('chain');
      expect(alert).toHaveProperty('dex');
      expect(alert).toHaveProperty('pairAddress');

      filter.destroy();
      done();
    });

    filter.processEvent(createMockSwapEvent({ usdValue: 100000 }));
  });
});

// =============================================================================
// S1.2.5: Prometheus Metrics Export (merged from swap-event-filter-extended)
// =============================================================================

describe('S1.2.5: Prometheus Metrics Export', () => {
  let filter: SwapEventFilter;

  beforeEach(() => {
    resetSwapEventFilter();
    filter = new SwapEventFilter();
  });

  afterEach(() => {
    filter.destroy();
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

// =============================================================================
// Hypothesis Validation (merged from swap-event-filter-extended)
// =============================================================================

describe('Hypothesis Validation: Event Reduction with Signal Retention', () => {
  let filter: SwapEventFilter;

  beforeEach(() => {
    resetSwapEventFilter();
    filter = new SwapEventFilter({
      minUsdValue: 10,
      whaleThreshold: 50000
    });
  });

  afterEach(() => {
    filter.destroy();
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
