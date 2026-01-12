"use strict";
/**
 * SwapEventFilter Tests (TDD - Red Phase)
 *
 * Tests for S1.2: Smart Swap Event Filtering
 * Hypothesis: 99% event reduction with 100% signal retention through smart filtering
 *
 * @see IMPLEMENTATION_PLAN.md S1.2
 */
Object.defineProperty(exports, "__esModule", { value: true });
const globals_1 = require("@jest/globals");
// These imports will fail initially (TDD Red phase)
const swap_event_filter_1 = require("./swap-event-filter");
// Helper to create mock swap events
function createMockSwapEvent(overrides = {}) {
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
(0, globals_1.describe)('SwapEventFilter', () => {
    let filter;
    (0, globals_1.beforeEach)(() => {
        (0, swap_event_filter_1.resetSwapEventFilter)();
        filter = new swap_event_filter_1.SwapEventFilter();
    });
    (0, globals_1.afterEach)(() => {
        filter.destroy();
    });
    (0, globals_1.describe)('Constructor and Configuration', () => {
        (0, globals_1.it)('should create filter with default configuration', () => {
            (0, globals_1.expect)(filter).toBeDefined();
            const config = filter.getConfig();
            (0, globals_1.expect)(config.minUsdValue).toBeDefined();
            (0, globals_1.expect)(config.whaleThreshold).toBeDefined();
            (0, globals_1.expect)(config.dedupWindowMs).toBeDefined();
            (0, globals_1.expect)(config.aggregationWindowMs).toBeDefined();
        });
        (0, globals_1.it)('should accept custom configuration', () => {
            const customConfig = {
                minUsdValue: 100,
                whaleThreshold: 100000,
                dedupWindowMs: 10000,
                aggregationWindowMs: 10000
            };
            const customFilter = new swap_event_filter_1.SwapEventFilter(customConfig);
            const config = customFilter.getConfig();
            (0, globals_1.expect)(config.minUsdValue).toBe(100);
            (0, globals_1.expect)(config.whaleThreshold).toBe(100000);
            (0, globals_1.expect)(config.dedupWindowMs).toBe(10000);
            (0, globals_1.expect)(config.aggregationWindowMs).toBe(10000);
            customFilter.destroy();
        });
        (0, globals_1.it)('should update configuration at runtime', () => {
            filter.updateConfig({ minUsdValue: 500 });
            (0, globals_1.expect)(filter.getConfig().minUsdValue).toBe(500);
        });
    });
    (0, globals_1.describe)('Edge Filter (Dust Filter)', () => {
        (0, globals_1.it)('should filter out swaps with zero amounts', () => {
            const zeroSwap = createMockSwapEvent({
                amount0In: '0',
                amount1In: '0',
                amount0Out: '0',
                amount1Out: '0',
                usdValue: 0
            });
            const result = filter.processEvent(zeroSwap);
            (0, globals_1.expect)(result.passed).toBe(false);
            (0, globals_1.expect)(result.filterReason).toBe('zero_amount');
        });
        (0, globals_1.it)('should filter out swaps below minimum USD value', () => {
            const dustSwap = createMockSwapEvent({
                usdValue: 5 // Below default threshold
            });
            const result = filter.processEvent(dustSwap);
            (0, globals_1.expect)(result.passed).toBe(false);
            (0, globals_1.expect)(result.filterReason).toBe('below_min_value');
        });
        (0, globals_1.it)('should pass swaps above minimum USD value', () => {
            const validSwap = createMockSwapEvent({
                usdValue: 100 // Above default threshold
            });
            const result = filter.processEvent(validSwap);
            (0, globals_1.expect)(result.passed).toBe(true);
        });
        (0, globals_1.it)('should handle swaps without usdValue by using amount estimation', () => {
            const swapNoUsd = createMockSwapEvent({
                amount0In: '1000000000000000000', // 1 token
                usdValue: undefined
            });
            // Should not throw and should make a reasonable decision
            const result = filter.processEvent(swapNoUsd);
            (0, globals_1.expect)(result).toBeDefined();
            (0, globals_1.expect)(typeof result.passed).toBe('boolean');
        });
    });
    (0, globals_1.describe)('Deduplication Filter', () => {
        (0, globals_1.it)('should filter duplicate swaps with same transaction hash', () => {
            const swap1 = createMockSwapEvent({
                transactionHash: '0xsametxhash123'
            });
            const swap2 = createMockSwapEvent({
                transactionHash: '0xsametxhash123'
            });
            const result1 = filter.processEvent(swap1);
            const result2 = filter.processEvent(swap2);
            (0, globals_1.expect)(result1.passed).toBe(true);
            (0, globals_1.expect)(result2.passed).toBe(false);
            (0, globals_1.expect)(result2.filterReason).toBe('duplicate');
        });
        (0, globals_1.it)('should allow different swaps in same transaction (different pairs)', () => {
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
            (0, globals_1.expect)(result1.passed).toBe(true);
            (0, globals_1.expect)(result2.passed).toBe(true);
        });
        (0, globals_1.it)('should expire dedup cache after window passes', async () => {
            const customFilter = new swap_event_filter_1.SwapEventFilter({ dedupWindowMs: 100 });
            const swap = createMockSwapEvent({
                transactionHash: '0xexpirableHash'
            });
            const result1 = customFilter.processEvent(swap);
            (0, globals_1.expect)(result1.passed).toBe(true);
            // Wait for dedup window to expire
            await new Promise(resolve => setTimeout(resolve, 150));
            // Same swap should pass again after expiry
            const result2 = customFilter.processEvent(swap);
            (0, globals_1.expect)(result2.passed).toBe(true);
            customFilter.destroy();
        });
    });
    (0, globals_1.describe)('Whale Detection', () => {
        (0, globals_1.it)('should detect whale transactions above threshold', () => {
            const whaleSwap = createMockSwapEvent({
                usdValue: 60000 // Above $50K threshold
            });
            const result = filter.processEvent(whaleSwap);
            (0, globals_1.expect)(result.passed).toBe(true);
            (0, globals_1.expect)(result.isWhale).toBe(true);
        });
        (0, globals_1.it)('should not flag normal transactions as whale', () => {
            const normalSwap = createMockSwapEvent({
                usdValue: 5000 // Below $50K threshold
            });
            const result = filter.processEvent(normalSwap);
            (0, globals_1.expect)(result.isWhale).toBe(false);
        });
        (0, globals_1.it)('should emit whale alert event', (done) => {
            filter.onWhaleAlert((alert) => {
                (0, globals_1.expect)(alert.event).toBeDefined();
                (0, globals_1.expect)(alert.usdValue).toBeGreaterThanOrEqual(50000);
                (0, globals_1.expect)(alert.timestamp).toBeDefined();
                done();
            });
            const whaleSwap = createMockSwapEvent({
                usdValue: 75000
            });
            filter.processEvent(whaleSwap);
        });
        (0, globals_1.it)('should include whale alerts in batch processing results', () => {
            const events = [
                createMockSwapEvent({ usdValue: 1000 }),
                createMockSwapEvent({ usdValue: 60000 }), // Whale
                createMockSwapEvent({ usdValue: 2000 }),
                createMockSwapEvent({ usdValue: 100000 }) // Whale
            ];
            const results = filter.processBatch(events);
            const whaleAlerts = results.whaleAlerts;
            (0, globals_1.expect)(whaleAlerts.length).toBe(2);
            (0, globals_1.expect)(whaleAlerts[0].usdValue).toBe(60000);
            (0, globals_1.expect)(whaleAlerts[1].usdValue).toBe(100000);
        });
    });
    (0, globals_1.describe)('Volume Aggregation', () => {
        (0, globals_1.it)('should aggregate volume within time window', async () => {
            const customFilter = new swap_event_filter_1.SwapEventFilter({ aggregationWindowMs: 100 });
            let aggregateEmitted = null;
            customFilter.onVolumeAggregate((aggregate) => {
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
            // Wait for aggregation window
            await new Promise(resolve => setTimeout(resolve, 150));
            (0, globals_1.expect)(aggregateEmitted).not.toBeNull();
            (0, globals_1.expect)(aggregateEmitted.swapCount).toBe(5);
            (0, globals_1.expect)(aggregateEmitted.totalUsdVolume).toBe(5000);
            customFilter.destroy();
        });
        (0, globals_1.it)('should aggregate by pair address', async () => {
            const customFilter = new swap_event_filter_1.SwapEventFilter({ aggregationWindowMs: 100 });
            const aggregates = [];
            customFilter.onVolumeAggregate((aggregate) => {
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
            // Wait for aggregation window
            await new Promise(resolve => setTimeout(resolve, 150));
            (0, globals_1.expect)(aggregates.length).toBe(2); // Two different pairs
            const pair1Agg = aggregates.find(a => a.pairAddress === '0xpair1');
            const pair2Agg = aggregates.find(a => a.pairAddress === '0xpair2');
            (0, globals_1.expect)(pair1Agg).toBeDefined();
            (0, globals_1.expect)(pair1Agg.swapCount).toBe(2);
            (0, globals_1.expect)(pair1Agg.totalUsdVolume).toBe(3000);
            (0, globals_1.expect)(pair2Agg).toBeDefined();
            (0, globals_1.expect)(pair2Agg.swapCount).toBe(1);
            (0, globals_1.expect)(pair2Agg.totalUsdVolume).toBe(3000);
            customFilter.destroy();
        });
        (0, globals_1.it)('should include min/max/avg price in aggregates', async () => {
            const customFilter = new swap_event_filter_1.SwapEventFilter({ aggregationWindowMs: 100 });
            let aggregateEmitted = null;
            customFilter.onVolumeAggregate((aggregate) => {
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
            await new Promise(resolve => setTimeout(resolve, 150));
            (0, globals_1.expect)(aggregateEmitted).not.toBeNull();
            (0, globals_1.expect)(aggregateEmitted.minPrice).toBeDefined();
            (0, globals_1.expect)(aggregateEmitted.maxPrice).toBeDefined();
            (0, globals_1.expect)(aggregateEmitted.avgPrice).toBeDefined();
            customFilter.destroy();
        });
    });
    (0, globals_1.describe)('Batch Processing', () => {
        (0, globals_1.it)('should process multiple events efficiently', () => {
            const events = Array.from({ length: 100 }, (_, i) => createMockSwapEvent({
                usdValue: i * 100,
                transactionHash: `0xtx${i}`
            }));
            const startTime = Date.now();
            const results = filter.processBatch(events);
            const endTime = Date.now();
            (0, globals_1.expect)(results.passed.length).toBeGreaterThan(0);
            (0, globals_1.expect)(results.filtered.length).toBeGreaterThan(0);
            (0, globals_1.expect)(results.passed.length + results.filtered.length).toBe(100);
            (0, globals_1.expect)(endTime - startTime).toBeLessThan(100); // Should be fast
        });
        (0, globals_1.it)('should return categorized results', () => {
            const events = [
                createMockSwapEvent({ usdValue: 5, transactionHash: '0xtx1' }), // Filtered (low value)
                createMockSwapEvent({ usdValue: 1000, transactionHash: '0xtx2' }), // Pass
                createMockSwapEvent({ usdValue: 1000, transactionHash: '0xtx2' }), // Filtered (duplicate)
                createMockSwapEvent({ usdValue: 60000, transactionHash: '0xtx3' }) // Pass + Whale
            ];
            const results = filter.processBatch(events);
            (0, globals_1.expect)(results.passed.length).toBe(2);
            (0, globals_1.expect)(results.filtered.length).toBe(2);
            (0, globals_1.expect)(results.whaleAlerts.length).toBe(1);
        });
    });
    (0, globals_1.describe)('Filter Statistics', () => {
        (0, globals_1.it)('should track filter statistics', () => {
            // Process some events
            filter.processEvent(createMockSwapEvent({ usdValue: 5, transactionHash: '0xtx1' })); // Filtered
            filter.processEvent(createMockSwapEvent({ usdValue: 1000, transactionHash: '0xtx2' })); // Pass
            filter.processEvent(createMockSwapEvent({ usdValue: 60000, transactionHash: '0xtx3' })); // Whale
            const stats = filter.getStats();
            (0, globals_1.expect)(stats.totalProcessed).toBe(3);
            (0, globals_1.expect)(stats.totalPassed).toBe(2);
            (0, globals_1.expect)(stats.totalFiltered).toBe(1);
            (0, globals_1.expect)(stats.whaleAlerts).toBe(1);
            (0, globals_1.expect)(stats.filterRate).toBeCloseTo(33.33, 0); // ~33% filtered
        });
        (0, globals_1.it)('should track filter reasons breakdown', () => {
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
            (0, globals_1.expect)(stats.filterReasons['zero_amount']).toBe(1);
            (0, globals_1.expect)(stats.filterReasons['below_min_value']).toBe(1);
            (0, globals_1.expect)(stats.filterReasons['duplicate']).toBe(1);
        });
        (0, globals_1.it)('should reset statistics', () => {
            filter.processEvent(createMockSwapEvent({ usdValue: 1000, transactionHash: '0xtx1' }));
            filter.processEvent(createMockSwapEvent({ usdValue: 60000, transactionHash: '0xtx2' }));
            filter.resetStats();
            const stats = filter.getStats();
            (0, globals_1.expect)(stats.totalProcessed).toBe(0);
            (0, globals_1.expect)(stats.totalPassed).toBe(0);
            (0, globals_1.expect)(stats.totalFiltered).toBe(0);
            (0, globals_1.expect)(stats.whaleAlerts).toBe(0);
        });
        (0, globals_1.it)('should calculate average processing time', () => {
            // Process multiple events
            for (let i = 0; i < 10; i++) {
                filter.processEvent(createMockSwapEvent({
                    usdValue: 1000,
                    transactionHash: `0xtx${i}`
                }));
            }
            const stats = filter.getStats();
            (0, globals_1.expect)(stats.avgProcessingTimeMs).toBeDefined();
            (0, globals_1.expect)(stats.avgProcessingTimeMs).toBeGreaterThanOrEqual(0);
        });
    });
    (0, globals_1.describe)('Singleton Pattern', () => {
        (0, globals_1.it)('should return same instance from getSwapEventFilter', () => {
            const instance1 = (0, swap_event_filter_1.getSwapEventFilter)();
            const instance2 = (0, swap_event_filter_1.getSwapEventFilter)();
            (0, globals_1.expect)(instance1).toBe(instance2);
        });
        (0, globals_1.it)('should reset singleton instance', () => {
            const instance1 = (0, swap_event_filter_1.getSwapEventFilter)();
            (0, swap_event_filter_1.resetSwapEventFilter)();
            const instance2 = (0, swap_event_filter_1.getSwapEventFilter)();
            (0, globals_1.expect)(instance1).not.toBe(instance2);
        });
    });
    (0, globals_1.describe)('Memory Management', () => {
        (0, globals_1.it)('should cleanup dedup cache periodically', async () => {
            const customFilter = new swap_event_filter_1.SwapEventFilter({
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
            // Wait for cleanup
            await new Promise(resolve => setTimeout(resolve, 100));
            // Internal cache should be cleaned up
            const cacheSize = customFilter.getDedupCacheSize();
            (0, globals_1.expect)(cacheSize).toBeLessThan(200);
            customFilter.destroy();
        });
        (0, globals_1.it)('should cleanup aggregation buckets after flush', async () => {
            const customFilter = new swap_event_filter_1.SwapEventFilter({
                aggregationWindowMs: 50
            });
            // Add events
            for (let i = 0; i < 10; i++) {
                customFilter.processEvent(createMockSwapEvent({
                    transactionHash: `0xtx${i}`,
                    usdValue: 100
                }));
            }
            // Wait for aggregation flush
            await new Promise(resolve => setTimeout(resolve, 100));
            const bucketCount = customFilter.getAggregationBucketCount();
            (0, globals_1.expect)(bucketCount).toBe(0);
            customFilter.destroy();
        });
    });
    (0, globals_1.describe)('Edge Cases', () => {
        (0, globals_1.it)('should handle malformed swap events gracefully', () => {
            const malformedSwap = {
                pairAddress: '0x123',
                // Missing many required fields
            };
            (0, globals_1.expect)(() => filter.processEvent(malformedSwap)).not.toThrow();
            const result = filter.processEvent(malformedSwap);
            (0, globals_1.expect)(result.passed).toBe(false);
            (0, globals_1.expect)(result.filterReason).toBe('invalid_event');
        });
        (0, globals_1.it)('should handle very large USD values', () => {
            const hugeSwap = createMockSwapEvent({
                usdValue: 1000000000 // $1 billion
            });
            const result = filter.processEvent(hugeSwap);
            (0, globals_1.expect)(result.passed).toBe(true);
            (0, globals_1.expect)(result.isWhale).toBe(true);
        });
        (0, globals_1.it)('should handle negative USD values', () => {
            const negativeSwap = createMockSwapEvent({
                usdValue: -1000
            });
            const result = filter.processEvent(negativeSwap);
            (0, globals_1.expect)(result.passed).toBe(false);
            (0, globals_1.expect)(result.filterReason).toBe('invalid_value');
        });
        (0, globals_1.it)('should handle concurrent processing', async () => {
            const events = Array.from({ length: 100 }, (_, i) => createMockSwapEvent({
                usdValue: 1000,
                transactionHash: `0xtx${i}`
            }));
            // Process concurrently
            const results = await Promise.all(events.map(event => Promise.resolve(filter.processEvent(event))));
            (0, globals_1.expect)(results.length).toBe(100);
            (0, globals_1.expect)(results.filter(r => r.passed).length).toBe(100);
        });
        (0, globals_1.it)('should handle invalid BigInt amount strings gracefully', () => {
            const invalidAmountSwap = createMockSwapEvent({
                amount0In: 'invalid',
                amount1In: 'not-a-number',
                amount0Out: '',
                amount1Out: 'abc123',
                usdValue: 100,
                transactionHash: '0xtx-invalid'
            });
            // Should not throw, should filter as zero amount
            (0, globals_1.expect)(() => filter.processEvent(invalidAmountSwap)).not.toThrow();
            const result = filter.processEvent(invalidAmountSwap);
            (0, globals_1.expect)(result.passed).toBe(false);
            (0, globals_1.expect)(result.filterReason).toBe('zero_amount');
        });
        (0, globals_1.it)('should return filtered result after destroy', () => {
            const tempFilter = new swap_event_filter_1.SwapEventFilter();
            tempFilter.destroy();
            const result = tempFilter.processEvent(createMockSwapEvent({ usdValue: 1000 }));
            (0, globals_1.expect)(result.passed).toBe(false);
            (0, globals_1.expect)(result.filterReason).toBe('invalid_event');
        });
        (0, globals_1.it)('should support unsubscribing from whale alerts', () => {
            const tempFilter = new swap_event_filter_1.SwapEventFilter();
            let alertCount = 0;
            const unsubscribe = tempFilter.onWhaleAlert(() => {
                alertCount++;
            });
            // First whale - should trigger
            tempFilter.processEvent(createMockSwapEvent({ usdValue: 60000, transactionHash: '0xtx1' }));
            (0, globals_1.expect)(alertCount).toBe(1);
            // Unsubscribe
            unsubscribe();
            // Second whale - should NOT trigger handler
            tempFilter.processEvent(createMockSwapEvent({ usdValue: 70000, transactionHash: '0xtx2' }));
            (0, globals_1.expect)(alertCount).toBe(1); // Still 1, not 2
            tempFilter.destroy();
        });
        (0, globals_1.it)('should support unsubscribing from volume aggregates', async () => {
            const tempFilter = new swap_event_filter_1.SwapEventFilter({ aggregationWindowMs: 50 });
            let aggregateCount = 0;
            const unsubscribe = tempFilter.onVolumeAggregate(() => {
                aggregateCount++;
            });
            // Add event
            tempFilter.processEvent(createMockSwapEvent({ usdValue: 1000, transactionHash: '0xtx1' }));
            // Wait for aggregation
            await new Promise(resolve => setTimeout(resolve, 80));
            (0, globals_1.expect)(aggregateCount).toBe(1);
            // Unsubscribe
            unsubscribe();
            // Add another event
            tempFilter.processEvent(createMockSwapEvent({ usdValue: 2000, transactionHash: '0xtx2' }));
            // Wait for aggregation
            await new Promise(resolve => setTimeout(resolve, 80));
            (0, globals_1.expect)(aggregateCount).toBe(1); // Still 1, not 2
            tempFilter.destroy();
        });
    });
    (0, globals_1.describe)('Integration with Metrics', () => {
        (0, globals_1.it)('should export Prometheus metrics', () => {
            filter.processEvent(createMockSwapEvent({ usdValue: 1000, transactionHash: '0xtx1' }));
            filter.processEvent(createMockSwapEvent({ usdValue: 60000, transactionHash: '0xtx2' }));
            const metrics = filter.getPrometheusMetrics();
            (0, globals_1.expect)(metrics).toContain('swap_filter_total_processed');
            (0, globals_1.expect)(metrics).toContain('swap_filter_total_passed');
            (0, globals_1.expect)(metrics).toContain('swap_filter_total_filtered');
            (0, globals_1.expect)(metrics).toContain('swap_filter_whale_alerts');
            (0, globals_1.expect)(metrics).toContain('swap_filter_rate');
        });
    });
});
(0, globals_1.describe)('FilterResult Interface', () => {
    (0, globals_1.it)('should have correct shape', () => {
        const filter = new swap_event_filter_1.SwapEventFilter();
        const result = filter.processEvent(createMockSwapEvent({ usdValue: 1000 }));
        (0, globals_1.expect)(result).toHaveProperty('passed');
        (0, globals_1.expect)(result).toHaveProperty('event');
        (0, globals_1.expect)(result).toHaveProperty('isWhale');
        (0, globals_1.expect)(result).toHaveProperty('processingTimeMs');
        if (!result.passed) {
            (0, globals_1.expect)(result).toHaveProperty('filterReason');
        }
        filter.destroy();
    });
});
(0, globals_1.describe)('VolumeAggregate Interface', () => {
    (0, globals_1.it)('should have correct shape when emitted', async () => {
        const filter = new swap_event_filter_1.SwapEventFilter({ aggregationWindowMs: 50 });
        let aggregate = null;
        filter.onVolumeAggregate((agg) => {
            aggregate = agg;
        });
        filter.processEvent(createMockSwapEvent({
            usdValue: 1000,
            transactionHash: '0xtx1'
        }));
        await new Promise(resolve => setTimeout(resolve, 100));
        (0, globals_1.expect)(aggregate).not.toBeNull();
        (0, globals_1.expect)(aggregate).toHaveProperty('pairAddress');
        (0, globals_1.expect)(aggregate).toHaveProperty('chain');
        (0, globals_1.expect)(aggregate).toHaveProperty('dex');
        (0, globals_1.expect)(aggregate).toHaveProperty('swapCount');
        (0, globals_1.expect)(aggregate).toHaveProperty('totalUsdVolume');
        (0, globals_1.expect)(aggregate).toHaveProperty('minPrice');
        (0, globals_1.expect)(aggregate).toHaveProperty('maxPrice');
        (0, globals_1.expect)(aggregate).toHaveProperty('avgPrice');
        (0, globals_1.expect)(aggregate).toHaveProperty('windowStartMs');
        (0, globals_1.expect)(aggregate).toHaveProperty('windowEndMs');
        filter.destroy();
    });
});
(0, globals_1.describe)('WhaleAlert Interface', () => {
    (0, globals_1.it)('should have correct shape when emitted', (done) => {
        const filter = new swap_event_filter_1.SwapEventFilter();
        filter.onWhaleAlert((alert) => {
            (0, globals_1.expect)(alert).toHaveProperty('event');
            (0, globals_1.expect)(alert).toHaveProperty('usdValue');
            (0, globals_1.expect)(alert).toHaveProperty('timestamp');
            (0, globals_1.expect)(alert).toHaveProperty('chain');
            (0, globals_1.expect)(alert).toHaveProperty('dex');
            (0, globals_1.expect)(alert).toHaveProperty('pairAddress');
            filter.destroy();
            done();
        });
        filter.processEvent(createMockSwapEvent({ usdValue: 100000 }));
    });
});
//# sourceMappingURL=swap-event-filter.test.js.map