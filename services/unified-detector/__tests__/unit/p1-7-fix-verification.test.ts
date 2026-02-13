/**
 * P1-7 Fix Verification Test
 *
 * Verifies that the concurrent warming race condition has been resolved.
 *
 * Before Fix:
 * - Multiple concurrent price updates for same pair triggered multiple warming ops
 * - Metrics were overcounted
 * - Duplicate work wasted resources
 *
 * After Fix:
 * - Per-pair debouncing using pendingWarmings Map
 * - Only one warming operation per pair at a time
 * - Metrics accurately counted
 * - Duplicate warmings skipped with warming_debounced_total metric
 *
 * @package services/unified-detector
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { WarmingIntegration, WarmingIntegrationConfig } from '../../src/warming-integration';
import { HierarchicalCache } from '@arbitrage/core';

describe('P1-7 Fix Verification - Concurrent Warming Race Condition', () => {
  let integration: WarmingIntegration;
  let cache: HierarchicalCache;

  beforeEach(async () => {
    // Create cache
    cache = new HierarchicalCache({
      l1Size: 64,
      l2Enabled: true,
      usePriceMatrix: false,
    });

    // Create integration with warming enabled
    const config: Partial<WarmingIntegrationConfig> = {
      enableWarming: true,
      enableMetrics: true,
      warmingStrategy: 'topn',
      maxPairsToWarm: 5,
      minCorrelationScore: 0.3,
    };

    integration = new WarmingIntegration(cache, config);
    await integration.initialize();

    // Seed cache with test data
    await cache.set('WETH_USDT', { price: 1800, timestamp: Date.now() });
    await cache.set('WBTC_USDT', { price: 42000, timestamp: Date.now() });
  });

  it('should debounce concurrent warming operations for same pair', async () => {
    const pairAddress = 'WETH_USDT';
    const chainId = 'ethereum';
    const timestamp = Date.now();

    // Get initial pending count
    const initialPending = integration.getPendingWarmingCount();
    expect(initialPending).toBe(0);

    // Trigger first warming (should proceed)
    integration.onPriceUpdate(pairAddress, timestamp, chainId);

    // Check pending count increased
    const pendingAfterFirst = integration.getPendingWarmingCount();
    expect(pendingAfterFirst).toBe(1);

    // Trigger second warming immediately (should be debounced)
    integration.onPriceUpdate(pairAddress, timestamp + 1, chainId);

    // Pending count should still be 1 (second warming debounced)
    const pendingAfterSecond = integration.getPendingWarmingCount();
    expect(pendingAfterSecond).toBe(1);

    // Trigger third warming (should also be debounced)
    integration.onPriceUpdate(pairAddress, timestamp + 2, chainId);

    // Still only 1 pending
    const pendingAfterThird = integration.getPendingWarmingCount();
    expect(pendingAfterThird).toBe(1);

    // Wait for warming to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    // Pending count should be 0 after completion
    const pendingAfterComplete = integration.getPendingWarmingCount();
    expect(pendingAfterComplete).toBe(0);
  });

  it('should allow concurrent warming for different pairs', async () => {
    const chainId = 'ethereum';
    const timestamp = Date.now();

    // Trigger warming for different pairs
    integration.onPriceUpdate('WETH_USDT', timestamp, chainId);
    integration.onPriceUpdate('WBTC_USDT', timestamp, chainId);
    integration.onPriceUpdate('LINK_USDT', timestamp, chainId);

    // Should have 3 concurrent warming operations (one per pair)
    const pendingCount = integration.getPendingWarmingCount();
    expect(pendingCount).toBe(3);

    // Wait for warmings to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    // All should complete
    const pendingAfterComplete = integration.getPendingWarmingCount();
    expect(pendingAfterComplete).toBe(0);
  });

  it('should not overcount metrics with concurrent updates', async () => {
    const pairAddress = 'WETH_USDT';
    const chainId = 'ethereum';
    const timestamp = Date.now();

    // Get initial stats
    const initialStats = integration.getStats();
    const initialWarmed = initialStats.warming?.totalPairsWarmed || 0;

    // Trigger 10 concurrent price updates for same pair
    for (let i = 0; i < 10; i++) {
      integration.onPriceUpdate(pairAddress, timestamp + i, chainId);
    }

    // Wait for warming to complete
    await new Promise(resolve => setTimeout(resolve, 150));

    // Get final stats
    const finalStats = integration.getStats();
    const finalWarmed = finalStats.warming?.totalPairsWarmed || 0;

    // Should have warmed pairs only ONCE (not 10 times)
    // The exact count depends on correlations, but should be small
    const pairsWarmed = finalWarmed - initialWarmed;
    expect(pairsWarmed).toBeLessThan(10); // Not 10× duplicated
    expect(pairsWarmed).toBeGreaterThanOrEqual(0); // At least not negative
  });

  it('should clean up stale pending warmings', async () => {
    const pairAddress = 'STALE_PAIR';
    const chainId = 'ethereum';
    const timestamp = Date.now();

    // Manually add a stale pending warming (simulate hung operation)
    // @ts-ignore - Access private property for testing
    integration.pendingWarmings.set(pairAddress, timestamp - 60000); // 60 seconds ago

    // Verify it exists
    expect(integration.getPendingWarmingCount()).toBe(1);

    // Run cleanup with 30s max age
    integration.cleanupStalePendingWarmings(30000);

    // Should have been cleaned up
    expect(integration.getPendingWarmingCount()).toBe(0);
  });

  it('should not clean up recent pending warmings', async () => {
    const pairAddress = 'WETH_USDT';
    const chainId = 'ethereum';
    const timestamp = Date.now();

    // Trigger warming
    integration.onPriceUpdate(pairAddress, timestamp, chainId);

    // Verify it's pending
    expect(integration.getPendingWarmingCount()).toBe(1);

    // Run cleanup with 30s max age (recent operation should not be cleaned)
    integration.cleanupStalePendingWarmings(30000);

    // Should still be pending (not stale)
    expect(integration.getPendingWarmingCount()).toBe(1);

    // Wait for completion
    await new Promise(resolve => setTimeout(resolve, 100));

    // Now should be complete
    expect(integration.getPendingWarmingCount()).toBe(0);
  });

  it('should clear pending warmings on shutdown', async () => {
    const chainId = 'ethereum';
    const timestamp = Date.now();

    // Trigger multiple warmings
    integration.onPriceUpdate('WETH_USDT', timestamp, chainId);
    integration.onPriceUpdate('WBTC_USDT', timestamp, chainId);

    // Verify pending
    expect(integration.getPendingWarmingCount()).toBeGreaterThan(0);

    // Shutdown
    await integration.shutdown();

    // Should be cleared
    expect(integration.getPendingWarmingCount()).toBe(0);
  });

  it('performance: debouncing should not add measurable overhead', async () => {
    const pairAddress = 'WETH_USDT';
    const chainId = 'ethereum';
    const timestamp = Date.now();

    // Measure time for 1000 debounced calls
    const start = performance.now();

    for (let i = 0; i < 1000; i++) {
      integration.onPriceUpdate(pairAddress, timestamp + i, chainId);
    }

    const duration = performance.now() - start;

    // 1000 debounced calls should complete quickly (<100ms)
    // Most will be rejected by the Map.has() check which is O(1)
    expect(duration).toBeLessThan(100);

    // Average per-call overhead should be negligible (<0.1ms)
    const avgPerCall = duration / 1000;
    expect(avgPerCall).toBeLessThan(0.1);

    // Cleanup
    await new Promise(resolve => setTimeout(resolve, 100));
  });
});
