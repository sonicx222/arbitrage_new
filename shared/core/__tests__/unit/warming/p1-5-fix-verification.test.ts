/**
 * P1-5 Fix Verification Test
 *
 * Verifies that the double fetch performance issue has been resolved.
 *
 * Before Fix:
 * - checkL1() called cache.get()
 * - fetchFromL2() called cache.get() again
 * - Result: 2 cache fetches per pair not in L1
 *
 * After Fix:
 * - checkL1WithValue() calls cache.get() once
 * - Returns both L1 status and value
 * - Result: 1 cache fetch per pair
 *
 * @package @arbitrage/core
 * @module warming/infrastructure
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { HierarchicalCache } from '../../../src/caching/hierarchical-cache';
import { HierarchicalCacheWarmer } from '../../../src/warming/infrastructure/hierarchical-cache-warmer.impl';
import { CorrelationTrackerImpl } from '../../../src/warming/infrastructure/correlation-tracker.impl';
import { TopNStrategy } from '../../../src/warming/application/strategies/topn-strategy';
import { CorrelationAnalyzer } from '../../../src/caching/correlation-analyzer';

describe('P1-5 Fix Verification - Double Fetch Eliminated', () => {
  let cache: HierarchicalCache;
  let warmer: HierarchicalCacheWarmer;
  let cacheGetSpy: jest.SpiedFunction<typeof cache.get>;

  beforeEach(async () => {
    // Create cache with L2 enabled (in-memory mode)
    cache = new HierarchicalCache({
      l1Size: 64,
      l2Enabled: true,
      usePriceMatrix: false, // Use regular Map for easier testing
    });

    // Spy on cache.get() to count calls
    cacheGetSpy = jest.spyOn(cache, 'get');

    // Create correlation tracker
    const analyzer = new CorrelationAnalyzer({
      coOccurrenceWindowMs: 1000,
      topCorrelatedLimit: 5,
    });
    const tracker = new CorrelationTrackerImpl(analyzer);

    // Create warming strategy
    const strategy = new TopNStrategy({
      topN: 5,
      minScore: 0.3,
    });

    // Create warmer
    warmer = new HierarchicalCacheWarmer(cache, tracker, strategy, {
      maxPairsPerWarm: 5,
      minCorrelationScore: 0.3,
      asyncWarming: true,
      timeoutMs: 50,
      enabled: true,
    });

    // Seed cache with test data
    // Put some pairs in L2 (but not L1)
    await cache.set('WETH_USDT', { price: 1800, timestamp: Date.now() });
    await cache.set('WBTC_USDT', { price: 42000, timestamp: Date.now() });
    await cache.set('LINK_USDT', { price: 15, timestamp: Date.now() });

    // Clear L1 to simulate cache misses
    // @ts-ignore - Access private method for test setup
    cache.l1Metadata.clear();

    // Reset spy after setup
    cacheGetSpy.mockClear();
  });

  it('should fetch each pair only once when warming from L2 to L1', async () => {
    // Setup: Record correlations to trigger warming
    const analyzer = new CorrelationAnalyzer({
      coOccurrenceWindowMs: 1000,
      topCorrelatedLimit: 5,
    });
    const tracker = new CorrelationTrackerImpl(analyzer);

    // Record price updates to establish correlations
    tracker.recordPriceUpdate('WETH_USDT', Date.now());
    tracker.recordPriceUpdate('WBTC_USDT', Date.now());
    tracker.recordPriceUpdate('WETH_USDT', Date.now() + 100);
    tracker.recordPriceUpdate('LINK_USDT', Date.now() + 100);

    // Recreate warmer with tracker that has correlations
    const strategy = new TopNStrategy({
      topN: 3,
      minScore: 0.0, // Low threshold to ensure pairs are selected
    });

    warmer = new HierarchicalCacheWarmer(cache, tracker, strategy, {
      maxPairsPerWarm: 3,
      minCorrelationScore: 0.0,
      asyncWarming: true,
      timeoutMs: 50,
      enabled: true,
    });

    // Clear spy again after recreating warmer
    cacheGetSpy.mockClear();

    // Act: Trigger warming for WETH_USDT
    const result = await warmer.warmForPair('WETH_USDT');

    // Assert: Each pair should only be fetched ONCE
    // Before fix: Would be 2× per pair (checkL1 + fetchFromL2)
    // After fix: Should be 1× per pair (checkL1WithValue only)

    const totalCalls = cacheGetSpy.mock.calls.length;
    const pairsProcessed = result.pairsAttempted;

    // Each pair should be fetched exactly once
    expect(totalCalls).toBeLessThanOrEqual(pairsProcessed);

    // More specific: should be exactly equal (1 fetch per pair)
    expect(totalCalls).toBe(pairsProcessed);
  });

  it('should return both L1 status and value from single fetch', async () => {
    // This tests the internal implementation detail
    // Access private method for testing (TypeScript will complain but test will work)
    const warmerWithPrivate = warmer as any;

    // Clear spy
    cacheGetSpy.mockClear();

    // Call checkL1WithValue
    const result = await warmerWithPrivate.checkL1WithValue('WETH_USDT');

    // Should return both inL1 flag and value
    expect(result).toHaveProperty('inL1');
    expect(result).toHaveProperty('value');
    expect(typeof result.inL1).toBe('boolean');

    // Should have made exactly ONE cache.get() call
    expect(cacheGetSpy).toHaveBeenCalledTimes(1);
    expect(cacheGetSpy).toHaveBeenCalledWith('WETH_USDT');
  });

  it('performance: warming latency should stay under 10ms', async () => {
    // Setup correlations
    const analyzer = new CorrelationAnalyzer({
      coOccurrenceWindowMs: 1000,
      topCorrelatedLimit: 5,
    });
    const tracker = new CorrelationTrackerImpl(analyzer);

    // Record correlations for 5 pairs
    for (let i = 0; i < 5; i++) {
      tracker.recordPriceUpdate('WETH_USDT', Date.now() + i * 100);
      tracker.recordPriceUpdate(`PAIR_${i}`, Date.now() + i * 100 + 10);
    }

    // Seed cache with pairs
    for (let i = 0; i < 5; i++) {
      await cache.set(`PAIR_${i}`, { price: 100 + i, timestamp: Date.now() });
    }

    // Clear L1
    // @ts-ignore
    cache.l1Metadata.clear();

    // Recreate warmer
    const strategy = new TopNStrategy({ topN: 5, minScore: 0.0 });
    warmer = new HierarchicalCacheWarmer(cache, tracker, strategy, {
      maxPairsPerWarm: 5,
      minCorrelationScore: 0.0,
      asyncWarming: true,
      timeoutMs: 50,
      enabled: true,
    });

    // Act: Warm for pair
    const result = await warmer.warmForPair('WETH_USDT');

    // Assert: Should complete in <10ms (P1-5 fix target)
    expect(result.durationMs).toBeLessThan(10);

    // With double fetch fix, should be significantly faster
    // Target: <5ms for 5 pairs (was 8.7ms before fix)
    expect(result.durationMs).toBeLessThan(5);
  });
});
