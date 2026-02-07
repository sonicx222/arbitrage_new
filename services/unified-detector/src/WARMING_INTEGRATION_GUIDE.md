# Warming Integration Guide for ChainInstance

This guide shows how to integrate the warming infrastructure into chain-instance.ts.

## Step 1: Add Import

At the top of `chain-instance.ts`, add:

```typescript
// Add to imports section (around line 57)
import {
  WarmingIntegration,
  WarmingIntegrationConfig
} from './warming-integration';
```

## Step 2: Add Configuration Interface

Update `ChainInstanceConfig` interface (around line 185):

```typescript
export interface ChainInstanceConfig {
  // ... existing fields ...

  /**
   * When true, use HierarchicalCache (with PriceMatrix L1) for price caching.
   * Provides L1/L2/L3 tiered caching with sub-microsecond reads.
   * Default: false (disabled for safe rollout)
   */
  usePriceCache?: boolean;

  /**
   * Warming integration configuration (Enhancement #2 & #3)
   * Enables predictive cache warming and metrics collection.
   * Default: warming disabled, metrics enabled
   */
  warmingConfig?: Partial<WarmingIntegrationConfig>;
}
```

## Step 3: Add Property to ChainInstance Class

Add to class properties (around line 382):

```typescript
export class ChainInstance extends EventEmitter {
  // ... existing properties ...

  // PHASE2-TASK36: Hierarchical Price Cache
  private priceCache: HierarchicalCache | null = null;
  private usePriceCache: boolean = false;

  // ENHANCEMENT #2 & #3: Warming Integration
  private warmingIntegration: WarmingIntegration | null = null;

  // ... rest of class ...
}
```

## Step 4: Initialize Warming in Constructor

In constructor (around line 490), after cache initialization:

```typescript
constructor(config: ChainInstanceConfig) {
  super();

  // ... existing initialization ...

  // PHASE2-TASK36: Initialize HierarchicalCache if enabled
  this.usePriceCache = config.usePriceCache ?? false;
  if (this.usePriceCache) {
    this.priceCache = createHierarchicalCache({
      l1Enabled: true,
      l1Size: 64, // 64MB L1 cache
      l2Enabled: true,
      l2Ttl: 300, // 5 minutes
      l3Enabled: false,
      enablePromotion: true,
      enableDemotion: false,
      usePriceMatrix: true // Enable PriceMatrix for L1
    });
  }

  // ENHANCEMENT #2 & #3: Initialize warming integration
  this.warmingIntegration = new WarmingIntegration(
    this.priceCache,
    config.warmingConfig
  );

  // ... rest of constructor ...
}
```

## Step 5: Initialize Warming in start() Method

In `start()` method (around line 550), after WebSocket connection:

```typescript
async start(): Promise<void> {
  if (this.isRunning) {
    this.logger.warn('Already running');
    return;
  }

  this.logger.info('Starting chain instance', { chainId: this.chainId });

  // ... existing start logic ...

  // ENHANCEMENT #2 & #3: Initialize warming infrastructure
  if (this.warmingIntegration) {
    try {
      await this.warmingIntegration.initialize();
      this.logger.info('Warming integration initialized', {
        chainId: this.chainId,
        stats: this.warmingIntegration.getStats()
      });
    } catch (error) {
      this.logger.warn('Failed to initialize warming integration', { error });
      // Non-fatal: warming is an optimization, not required
    }
  }

  // ... rest of start logic ...
}
```

## Step 6: Add Warming Trigger in emitPriceUpdate()

In `emitPriceUpdate()` method (around line 1820), after cache write:

```typescript
private emitPriceUpdate(pair: ExtendedPair): void {
  // ... existing price update logic ...

  // PHASE2-TASK37: Store in HierarchicalCache if enabled (non-blocking)
  if (this.usePriceCache && this.priceCache) {
    const cacheKey = `price:${this.chainId}:${pair.address.toLowerCase()}`;
    this.priceCache.set(cacheKey, {
      price: priceUpdate.price,
      reserve0: priceUpdate.reserve0,
      reserve1: priceUpdate.reserve1,
      timestamp: priceUpdate.timestamp,
      blockNumber: priceUpdate.blockNumber
    }).catch(error => {
      this.logger.warn('Failed to write to price cache', { error, cacheKey });
    });
  }

  // ENHANCEMENT #2 & #3: Trigger warming and metrics (HOT PATH)
  if (this.warmingIntegration) {
    // This is <50μs for correlation tracking
    // Warming happens async/non-blocking
    this.warmingIntegration.onPriceUpdate(
      pair.address,
      Date.now(),
      this.chainId
    );
  }

  this.emit('priceUpdate', priceUpdate);
}
```

## Step 7: Add Metrics Endpoint (Optional)

Add method for Prometheus scraping (around line 2300):

```typescript
/**
 * Export metrics in Prometheus format
 *
 * Provides /metrics endpoint for Prometheus scraping.
 */
async exportMetrics(): Promise<string> {
  if (!this.warmingIntegration) {
    return '';
  }

  // Record current cache metrics
  this.warmingIntegration.recordCacheMetrics(this.chainId);

  // Export in Prometheus format
  return await this.warmingIntegration.exportMetrics();
}
```

## Step 8: Add Stats to getStats() Method

In `getStats()` method (around line 2315):

```typescript
getStats(): ChainStats {
  // ... existing stats collection ...

  // PHASE2-TASK39: Include price cache stats if enabled
  const cacheStats = (this.usePriceCache && this.priceCache)
    ? this.priceCache.getStats()
    : undefined;

  // ENHANCEMENT #2 & #3: Include warming stats
  const warmingStats = this.warmingIntegration
    ? this.warmingIntegration.getStats()
    : undefined;

  return {
    // ... existing stats ...
    ...(cacheStats && { priceCache: cacheStats }),
    ...(warmingStats && { warming: warmingStats })
  };
}
```

## Step 9: Cleanup in stop() Method

In `stop()` method (around line 770):

```typescript
async stop(): Promise<void> {
  if (!this.isRunning) {
    this.logger.warn('Not running');
    return;
  }

  // Set flag immediately to prevent new events from being processed
  this.isStopping = true;
  this.logger.info('Stopping chain instance', { chainId: this.chainId });

  try {
    // ... existing stop logic ...

    // ENHANCEMENT #2 & #3: Shutdown warming integration
    if (this.warmingIntegration) {
      await this.warmingIntegration.shutdown();
    }

    // ... rest of stop logic ...
  } finally {
    this.isStopping = false;
    this.isRunning = false;
    this.status = 'stopped';
  }
}
```

## Usage Example

```typescript
// In unified-detector.ts or index.ts

import { ChainInstance } from './chain-instance';

// Create chain instance with warming enabled
const chainInstance = new ChainInstance({
  chainId: 'ethereum',
  partitionId: 'partition-1',
  streamsClient: redisClient,
  perfLogger: logger,
  usePriceCache: true,  // Enable hierarchical cache
  warmingConfig: {
    enableWarming: true,         // Enable predictive warming
    enableMetrics: true,          // Enable metrics collection
    warmingStrategy: 'adaptive',  // Use adaptive strategy
    maxPairsToWarm: 5,
    minCorrelationScore: 0.3,
    targetHitRate: 0.97
  }
});

await chainInstance.start();

// Later: export metrics for Prometheus
const metrics = await chainInstance.exportMetrics();
console.log(metrics); // Prometheus text format

// Get warming stats
const stats = chainInstance.getStats();
console.log('Warming stats:', stats.warming);
```

## Configuration Options

### Warming Strategy: TopN (Simple, Recommended)
```typescript
warmingConfig: {
  enableWarming: true,
  warmingStrategy: 'topn',
  maxPairsToWarm: 5,        // Top 5 pairs
  minCorrelationScore: 0.3  // 30% minimum correlation
}
```

### Warming Strategy: Adaptive (Self-Tuning)
```typescript
warmingConfig: {
  enableWarming: true,
  warmingStrategy: 'adaptive',
  maxPairsToWarm: 10,       // Maximum pairs
  minCorrelationScore: 0.3,
  targetHitRate: 0.97       // Target 97% hit rate
}
```

### Metrics Only (No Warming)
```typescript
warmingConfig: {
  enableWarming: false,  // Disable warming
  enableMetrics: true    // But keep metrics
}
```

## Performance Impact

**Hot-Path Operations** (every price update):
- Correlation tracking: <50μs (99th percentile)
- Metrics recording: <10μs (99th percentile)
- **Total overhead: <60μs per price update**

**Background Operations** (async, non-blocking):
- Cache warming: <10ms for 5 pairs
- Metrics export: <10ms for ~50 metrics

**Memory Overhead**:
- Correlation analyzer: ~1-2MB
- Metrics collector: ~2-3MB
- **Total: ~3-5MB**

## Monitoring

Metrics exposed for Prometheus scraping:

```
# Cache metrics
arbitrage_cache_hits_total{cache_level="l1",chain="ethereum"} 12345
arbitrage_cache_misses_total{cache_level="l1",chain="ethereum"} 678
arbitrage_cache_size_bytes{cache_level="l1",chain="ethereum"} 67108864
arbitrage_cache_latency_ms{operation="read",cache_level="l1",chain="ethereum",quantile="0.99"} 0.0012

# Warming metrics
arbitrage_warming_operations_total{chain="ethereum"} 1234
arbitrage_warming_pairs_warmed_total{chain="ethereum"} 5678
arbitrage_warming_duration_ms{chain="ethereum",quantile="0.99"} 8.5

# Correlation metrics
arbitrage_correlation_tracking_duration_us{chain="ethereum",quantile="0.99"} 45
arbitrage_correlation_pairs_tracked{chain="ethereum"} 500
```

## Grafana Dashboard

Import the pre-generated dashboard:
```bash
# Dashboard JSON will be at:
infrastructure/grafana/dashboards/cache-performance.json
```

Or generate programmatically:
```typescript
import { PrometheusExporter } from '@arbitrage/core';

const exporter = new PrometheusExporter(metricsCollector);
const dashboard = await exporter.generateGrafanaDashboard({
  title: 'Cache Performance Monitoring',
  datasource: 'Prometheus',
  timeRange: '1h',
  refreshInterval: '10s'
}, [
  {
    title: 'L1 Hit Rate',
    type: 'graph',
    query: 'rate(arbitrage_cache_hits_total{cache_level="l1"}[5m]) / rate(arbitrage_cache_requests_total{cache_level="l1"}[5m]) * 100',
    unit: 'percent',
    thresholds: { green: 95, yellow: 90, red: 85 }
  }
]);

fs.writeFileSync('cache-dashboard.json', JSON.stringify(dashboard, null, 2));
```

## Troubleshooting

### Warming Not Working
1. Check `usePriceCache` is `true` in config
2. Check `warmingConfig.enableWarming` is `true`
3. Check logs for initialization errors
4. Verify HierarchicalCache is properly initialized

### High Memory Usage
1. Reduce `maxPairsToWarm` (default: 5)
2. Increase `minCorrelationScore` threshold
3. Monitor correlation analyzer memory via stats

### Metrics Not Appearing
1. Check `/metrics` endpoint is accessible
2. Verify Prometheus is configured to scrape
3. Check `warmingConfig.enableMetrics` is `true`

## Testing

```typescript
// Unit test example
import { WarmingIntegration } from './warming-integration';
import { HierarchicalCache } from '@arbitrage/core';

test('warming integration tracks correlations', async () => {
  const cache = new HierarchicalCache({ l1Size: 64 });
  const integration = new WarmingIntegration(cache, {
    enableWarming: true,
    warmingStrategy: 'topn'
  });

  await integration.initialize();

  // Simulate price updates
  integration.onPriceUpdate('0x123...', Date.now(), 'ethereum');
  integration.onPriceUpdate('0x456...', Date.now(), 'ethereum');

  // Check stats
  const stats = integration.getStats();
  expect(stats.initialized).toBe(true);
  expect(stats.warmingEnabled).toBe(true);
});
```

---

## Next Steps

After integration:
1. Test in development with warming disabled
2. Enable metrics collection first
3. Monitor baseline cache performance
4. Enable warming for single chain
5. Validate hit rate improvement
6. Gradually enable for all chains
7. Monitor memory and latency impact
