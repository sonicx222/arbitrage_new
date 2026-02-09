# Warming Infrastructure Deployment Guide

**Version**: 1.0
**Last Updated**: 2026-02-06
**Status**: Production Ready

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Quick Start](#quick-start)
4. [Deployment Strategies](#deployment-strategies)
5. [Configuration](#configuration)
6. [Integration Steps](#integration-steps)
7. [Verification](#verification)
8. [Monitoring](#monitoring)
9. [Troubleshooting](#troubleshooting)
10. [Rollback Procedures](#rollback-procedures)

---

## Overview

The warming infrastructure provides **predictive cache warming** using correlation analysis to improve cache hit rates and reduce latency in the arbitrage detection system.

### Key Benefits

- **95% reduction** in configuration boilerplate
- **<50μs** hot-path overhead (correlation tracking)
- **<10ms** background warming operations
- **Zero-downtime** deployment with gradual rollout
- **Self-tuning** adaptive strategy option

### Architecture

```
Price Update Event
        ↓
Correlation Tracker (record co-occurrence)
        ↓
Warming Strategy (select pairs to warm)
        ↓
Cache Warmer (L2 → L1 promotion)
        ↓
Improved Cache Hit Rate
```

---

## Prerequisites

### System Requirements

- Node.js >= 22.0.0
- Redis >= 6.2.0 (for L2/L3 cache)
- Memory: 100KB per service instance + ~2MB for shared analyzer
- CPU: Negligible overhead (<0.1% on hot-path)

### Dependencies

All dependencies are included in `@arbitrage/core`:

```json
{
  "@arbitrage/core": "^1.0.0"
}
```

### Environment Setup

```bash
# Ensure shared packages are built
npm run build:deps

# Verify warming infrastructure is available
npm run typecheck
```

---

## Quick Start

### 1. Minimal Setup (5 minutes)

For simple use cases with default TopN strategy:

```typescript
import { HierarchicalCache, createTopNWarming } from '@arbitrage/core';

// Create cache
const cache = new HierarchicalCache({
  l1Size: 64,
  l2Enabled: true,
});

// Create warming components (one-liner)
const { tracker, warmer } = createTopNWarming(cache, 5, 0.3);

// Use in your price update handler
async function onPriceUpdate(pairAddress: string, timestamp: number) {
  // 1. Track correlation (<50μs, hot-path safe)
  tracker.recordPriceUpdate(pairAddress, timestamp);

  // 2. Trigger warming (async, non-blocking)
  await warmer.warmForPair(pairAddress);
}
```

**That's it!** You now have predictive cache warming.

### 2. Production Setup (15 minutes)

For production with metrics and adaptive strategy:

```typescript
import {
  HierarchicalCache,
  WarmingContainer
} from '@arbitrage/core';

// Create cache
const cache = new HierarchicalCache({
  l1Size: 128,
  l2Enabled: true,
  usePriceMatrix: true,
});

// Create warming components with adaptive strategy
const container = WarmingContainer.create(cache, {
  strategy: 'adaptive',
  strategyConfig: {
    targetHitRate: 0.97,
    minPairs: 3,
    maxPairs: 10,
    minScore: 0.3,
    adjustmentFactor: 0.1,
  },
  enableMetrics: true,
});

const { tracker, warmer, metricsExporter } = container.build();

// Expose metrics endpoint
app.get('/metrics', async (req, res) => {
  const result = await metricsExporter!.export();
  res.set('Content-Type', 'text/plain; version=0.0.4');
  res.send(result.data);
});
```

---

## Deployment Strategies

### Strategy 1: Gradual Rollout (Recommended)

**Timeline**: 4 phases over 2-4 weeks

#### Phase 1: Shadow Mode (Week 1)
Deploy with warming **disabled** to verify integration:

```typescript
const { tracker, warmer } = createTopNWarming(cache);

// Track but don't warm
tracker.recordPriceUpdate(pairAddress, timestamp);
// await warmer.warmForPair(pairAddress); // Commented out
```

**Verification**:
- ✅ No errors in correlation tracking
- ✅ Correlation data being collected
- ✅ No performance regression

#### Phase 2: Canary (Week 2)
Enable warming on **1-2 chains** (10% traffic):

```typescript
const WARMING_ENABLED_CHAINS = ['ethereum', 'bsc'];

async function onPriceUpdate(chain: string, pair: string, timestamp: number) {
  tracker.recordPriceUpdate(pair, timestamp);

  if (WARMING_ENABLED_CHAINS.includes(chain)) {
    await warmer.warmForPair(pair);
  }
}
```

**Verification**:
- ✅ Cache hit rate improvement (baseline → +5-15%)
- ✅ No latency increase
- ✅ Warming operations complete <10ms

#### Phase 3: Staged Rollout (Week 3)
Enable warming on **50% of chains**:

```typescript
const WARMING_ENABLED = true;
const WARMING_ROLLOUT_PERCENTAGE = 0.5;

async function onPriceUpdate(chain: string, pair: string, timestamp: number) {
  tracker.recordPriceUpdate(pair, timestamp);

  if (WARMING_ENABLED && Math.random() < WARMING_ROLLOUT_PERCENTAGE) {
    await warmer.warmForPair(pair);
  }
}
```

**Verification**:
- ✅ Cache hit rate improvement across all chains
- ✅ No errors or performance issues
- ✅ Metrics show expected behavior

#### Phase 4: Full Deployment (Week 4)
Enable warming on **all chains**:

```typescript
async function onPriceUpdate(chain: string, pair: string, timestamp: number) {
  tracker.recordPriceUpdate(pair, timestamp);
  await warmer.warmForPair(pair);
}
```

**Verification**:
- ✅ System-wide cache hit rate improvement
- ✅ Reduced Redis latency
- ✅ Improved arbitrage detection speed

### Strategy 2: Blue-Green Deployment

Deploy new version alongside old version:

```typescript
// Blue (old) - no warming
const blueCache = createCacheV1();

// Green (new) - with warming
const greenCache = new HierarchicalCache({ l1Size: 128 });
const { tracker, warmer } = createTopNWarming(greenCache);

// Route traffic based on flag
const useGreen = process.env.USE_WARMING === 'true';
const cache = useGreen ? greenCache : blueCache;
```

**Cutover**: Switch `USE_WARMING=true` when ready, instant rollback if issues.

### Strategy 3: Feature Flag

Use feature flags for granular control:

```typescript
import { FeatureFlags } from './feature-flags';

async function onPriceUpdate(pair: string, timestamp: number) {
  // Always track (low overhead)
  tracker.recordPriceUpdate(pair, timestamp);

  // Conditionally warm based on feature flag
  if (FeatureFlags.isEnabled('cache-warming')) {
    await warmer.warmForPair(pair);
  }
}
```

---

## Configuration

### Environment Variables

```bash
# Warming Strategy (topn|threshold|adaptive|timebased)
WARMING_STRATEGY=adaptive

# Strategy Configuration (JSON)
WARMING_STRATEGY_CONFIG='{"targetHitRate":0.97,"minPairs":3,"maxPairs":10,"minScore":0.3,"adjustmentFactor":0.1}'

# Cache Configuration
CACHE_L1_SIZE=128
CACHE_L2_ENABLED=true
CACHE_USE_PRICE_MATRIX=true

# Metrics
WARMING_METRICS_ENABLED=true
METRICS_PREFIX=arbitrage_
METRICS_PORT=9090

# Feature Flags
FEATURE_CACHE_WARMING_ENABLED=true
FEATURE_ADAPTIVE_STRATEGY_ENABLED=true
```

### Configuration Profiles

#### Development

```typescript
const config = {
  strategy: 'topn',
  strategyConfig: { topN: 3, minScore: 0.3 },
  warmerConfig: {
    maxPairsPerWarm: 3,
    asyncWarming: false, // Synchronous for easier debugging
    timeoutMs: 100,
  },
  enableMetrics: false, // Faster tests
  useSharedAnalyzer: false, // Isolated testing
};
```

#### Staging

```typescript
const config = {
  strategy: 'topn',
  strategyConfig: { topN: 5, minScore: 0.3 },
  warmerConfig: {
    maxPairsPerWarm: 5,
    asyncWarming: true,
    timeoutMs: 50,
  },
  enableMetrics: true,
  useSharedAnalyzer: true,
};
```

#### Production

```typescript
const config = {
  strategy: 'adaptive',
  strategyConfig: {
    targetHitRate: 0.97,
    minPairs: 3,
    maxPairs: 10,
    minScore: 0.3,
    adjustmentFactor: 0.1,
  },
  warmerConfig: {
    maxPairsPerWarm: 10,
    asyncWarming: true,
    timeoutMs: 50,
  },
  metricsConfig: {
    format: ExportFormat.PROMETHEUS,
    metricPrefix: 'arbitrage_',
    includeMetadata: true,
  },
  enableMetrics: true,
  useSharedAnalyzer: true,
};
```

---

## Integration Steps

### Step 1: Add Cache to Service

```typescript
import { HierarchicalCache } from '@arbitrage/core';

export class DetectorService {
  private cache: HierarchicalCache;

  constructor() {
    this.cache = new HierarchicalCache({
      l1Size: parseInt(process.env.CACHE_L1_SIZE || '128'),
      l2Enabled: process.env.CACHE_L2_ENABLED === 'true',
      usePriceMatrix: process.env.CACHE_USE_PRICE_MATRIX === 'true',
    });
  }
}
```

### Step 2: Create Warming Components

```typescript
import { WarmingContainer } from '@arbitrage/core';

export class DetectorService {
  private cache: HierarchicalCache;
  private warmingComponents: WarmingComponents;

  constructor() {
    // ... cache creation from Step 1

    // Create warming components
    this.warmingComponents = WarmingContainer.create(this.cache, {
      strategy: process.env.WARMING_STRATEGY as WarmingStrategyType,
      strategyConfig: JSON.parse(process.env.WARMING_STRATEGY_CONFIG),
      enableMetrics: process.env.WARMING_METRICS_ENABLED === 'true',
    }).build();
  }
}
```

### Step 3: Integrate with Price Updates

```typescript
export class DetectorService {
  async onPriceUpdate(
    chain: string,
    pairAddress: string,
    timestamp: number
  ): Promise<void> {
    // 1. Track correlation (hot-path: <50μs)
    this.warmingComponents.tracker.recordPriceUpdate(pairAddress, timestamp);

    // 2. Trigger warming (async, non-blocking)
    if (process.env.FEATURE_CACHE_WARMING_ENABLED === 'true') {
      await this.warmingComponents.warmer.warmForPair(pairAddress);
    }

    // 3. Record metrics
    if (this.warmingComponents.metricsCollector) {
      this.warmingComponents.metricsCollector.incrementCounter(
        'price_updates_total',
        { chain }
      );
    }
  }
}
```

### Step 4: Expose Metrics Endpoint

```typescript
import express from 'express';

const app = express();

app.get('/metrics', async (req, res) => {
  if (!service.warmingComponents.metricsExporter) {
    res.status(404).send('Metrics not enabled');
    return;
  }

  const result = await service.warmingComponents.metricsExporter.export();

  res.set('Content-Type', 'text/plain; version=0.0.4');
  res.send(result.data);
});

app.listen(process.env.METRICS_PORT || 9090);
```

### Step 5: Add Health Checks

```typescript
app.get('/health/warming', (req, res) => {
  const trackerStats = service.warmingComponents.tracker.getStats();
  const warmerStats = service.warmingComponents.warmer.getStats();

  const health = {
    status: 'healthy',
    tracker: {
      totalPairs: trackerStats.totalPairs,
      totalUpdates: trackerStats.totalUpdates,
    },
    warmer: {
      totalWarmingOps: warmerStats.totalWarmingOps,
      totalPairsWarmed: warmerStats.totalPairsWarmed,
      successRate: warmerStats.totalWarmingOps > 0
        ? warmerStats.totalPairsWarmed / warmerStats.totalWarmingOps
        : 0,
    },
  };

  res.json(health);
});
```

---

## Verification

### Pre-Deployment Checklist

- [ ] TypeScript compilation successful (`npm run build`)
- [ ] All tests passing (`npm test -- warming`)
- [ ] Configuration validated in staging
- [ ] Metrics endpoint accessible
- [ ] Health check endpoint returns 200
- [ ] Performance benchmarks run
- [ ] Documentation reviewed
- [ ] Rollback procedure documented

### Post-Deployment Verification

#### 1. Check Service Health

```bash
curl http://localhost:9090/health/warming
```

Expected response:
```json
{
  "status": "healthy",
  "tracker": {
    "totalPairs": 150,
    "totalUpdates": 5000
  },
  "warmer": {
    "totalWarmingOps": 2500,
    "totalPairsWarmed": 8000,
    "successRate": 3.2
  }
}
```

#### 2. Check Metrics

```bash
curl http://localhost:9090/metrics | grep warming
```

Expected metrics:
```
arbitrage_warming_operations_total{chain="ethereum"} 2500
arbitrage_warming_pairs_warmed_total{chain="ethereum"} 8000
arbitrage_warming_duration_ms_bucket{chain="ethereum",le="10"} 2450
```

#### 3. Verify Cache Hit Rate Improvement

```bash
# Before warming (baseline)
curl http://localhost:9090/metrics | grep cache_hits_total

# After warming (should increase 5-15%)
curl http://localhost:9090/metrics | grep cache_hits_total
```

#### 4. Check Performance Impact

```bash
# Hot-path latency (should be <50μs)
curl http://localhost:9090/metrics | grep correlation_tracking_duration_us

# Warming latency (should be <10ms)
curl http://localhost:9090/metrics | grep warming_duration_ms
```

#### 5. Monitor Error Rates

```bash
# Should have no errors or <0.1% error rate
curl http://localhost:9090/metrics | grep error
```

---

## Monitoring

### Key Metrics to Watch

#### 1. Cache Performance

```promql
# Cache hit rate (should improve by 5-15%)
rate(arbitrage_cache_hits_total[5m]) /
  (rate(arbitrage_cache_hits_total[5m]) + rate(arbitrage_cache_misses_total[5m]))

# L1 hit rate specifically
rate(arbitrage_cache_hits_total{cache_level="L1"}[5m]) /
  (rate(arbitrage_cache_hits_total{cache_level="L1"}[5m]) +
   rate(arbitrage_cache_misses_total{cache_level="L1"}[5m]))
```

#### 2. Warming Performance

```promql
# Warming operation duration (should be <10ms p95)
histogram_quantile(0.95,
  rate(arbitrage_warming_duration_ms_bucket[5m])
)

# Correlation tracking duration (should be <50μs p95)
histogram_quantile(0.95,
  rate(arbitrage_correlation_tracking_duration_us_bucket[5m])
)
```

#### 3. Warming Effectiveness

```promql
# Pairs warmed per operation (indicates correlation quality)
rate(arbitrage_warming_pairs_warmed_total[5m]) /
  rate(arbitrage_warming_operations_total[5m])

# Warming success rate
rate(arbitrage_warming_operations_total{status="success"}[5m]) /
  rate(arbitrage_warming_operations_total[5m])
```

### Alerting Rules

```yaml
groups:
  - name: warming_infrastructure
    rules:
      # Alert if warming operations are too slow
      - alert: WarmingOperationsSlow
        expr: |
          histogram_quantile(0.95,
            rate(arbitrage_warming_duration_ms_bucket[5m])
          ) > 15
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Warming operations exceeding 15ms p95"

      # Alert if correlation tracking is too slow (hot-path)
      - alert: CorrelationTrackingSlow
        expr: |
          histogram_quantile(0.95,
            rate(arbitrage_correlation_tracking_duration_us_bucket[5m])
          ) > 100
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Correlation tracking exceeding 100μs p95 (hot-path impact)"

      # Alert if cache hit rate drops
      - alert: CacheHitRateDropped
        expr: |
          rate(arbitrage_cache_hits_total[5m]) /
            (rate(arbitrage_cache_hits_total[5m]) +
             rate(arbitrage_cache_misses_total[5m])) < 0.85
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Cache hit rate below 85%"

      # Alert if warming error rate is high
      - alert: WarmingErrorRateHigh
        expr: |
          rate(arbitrage_warming_operations_total{status="error"}[5m]) /
            rate(arbitrage_warming_operations_total[5m]) > 0.01
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Warming error rate above 1%"
```

### Grafana Dashboards

See `docs/warming/GRAFANA_DASHBOARDS.md` for dashboard definitions.

---

## Troubleshooting

### Issue: High Correlation Tracking Latency

**Symptom**: `correlation_tracking_duration_us` p95 > 100μs

**Diagnosis**:
```typescript
const stats = tracker.getStats();
console.log('Total pairs tracked:', stats.totalPairs);
console.log('Total updates:', stats.totalUpdates);
```

**Solutions**:
1. **Too many pairs tracked** (>5000):
   - Increase `coOccurrenceWindowMs` to reduce tracked pairs
   - Use more aggressive `minScore` threshold

2. **Shared analyzer contention**:
   - Consider using separate analyzers per service
   - Profile with `--prof` to identify bottlenecks

### Issue: Warming Operations Too Slow

**Symptom**: `warming_duration_ms` p95 > 15ms

**Diagnosis**:
```typescript
const stats = warmer.getStats();
console.log('Average pairs per warming:',
  stats.totalPairsWarmed / stats.totalWarmingOps);
```

**Solutions**:
1. **Too many pairs being warmed**:
   - Reduce `maxPairsPerWarm` in warmer config
   - Use TopN strategy with lower `topN`
   - Increase `minScore` threshold

2. **L2 cache slow**:
   - Check Redis latency
   - Verify network connection
   - Consider Redis clustering

3. **Cache lock contention**:
   - Enable `asyncWarming: true`
   - Reduce warming frequency

### Issue: No Cache Hit Rate Improvement

**Symptom**: Cache hit rate unchanged after warming deployment

**Diagnosis**:
```typescript
const correlations = tracker.getPairsToWarm(testPair, Date.now(), 10, 0.3);
console.log('Correlations found:', correlations.correlations.length);
```

**Solutions**:
1. **Not enough correlation data**:
   - Wait longer for correlation data to accumulate (>1 hour)
   - Verify `recordPriceUpdate()` is being called
   - Check correlation analyzer config

2. **Strategy too conservative**:
   - Lower `minScore` threshold (e.g., 0.3 → 0.2)
   - Increase `topN` or `maxPairs`
   - Switch to Threshold or Adaptive strategy

3. **Warming not actually happening**:
   - Check `warming_operations_total` metric
   - Verify feature flag is enabled
   - Check for errors in logs

### Issue: Memory Usage High

**Symptom**: Memory usage increasing over time

**Diagnosis**:
```bash
# Check Node.js heap usage
curl http://localhost:9090/metrics | grep nodejs_heap_size_used_bytes
```

**Solutions**:
1. **Too many tracked pairs**:
   - Reduce `maxTrackedPairs` in analyzer config
   - Implement pair TTL/eviction

2. **Metrics accumulation**:
   - Ensure metrics are being scraped regularly
   - Reduce metric cardinality (fewer label combinations)

3. **Memory leak**:
   - Run with `--expose-gc` and monitor
   - Profile with Chrome DevTools
   - Check for event listener leaks

### Issue: Warming Errors

**Symptom**: High error rate in warming operations

**Diagnosis**:
```bash
# Check error logs
tail -f logs/warming.log | grep ERROR
```

**Solutions**:
1. **Cache unavailable**:
   - Verify Redis connection
   - Check network connectivity
   - Implement retry logic

2. **Invalid pair addresses**:
   - Validate pair addresses before tracking
   - Filter out test/invalid addresses

3. **Timeout errors**:
   - Increase `timeoutMs` in warmer config
   - Reduce pairs warmed per operation

---

## Rollback Procedures

### Emergency Rollback (Immediate)

If critical issues arise:

```typescript
// Option 1: Disable warming via feature flag
process.env.FEATURE_CACHE_WARMING_ENABLED = 'false';

// Option 2: Disable warming in code
const WARMING_DISABLED = true;

async function onPriceUpdate(pair: string, timestamp: number) {
  tracker.recordPriceUpdate(pair, timestamp);

  if (!WARMING_DISABLED) {
    await warmer.warmForPair(pair); // Won't execute
  }
}

// Option 3: Restart service with old config
pm2 restart detector-service --update-env
```

### Gradual Rollback

If issues are non-critical:

```typescript
// Reduce warming percentage gradually
const WARMING_PERCENTAGE = 0.5; // 50%
const WARMING_PERCENTAGE = 0.25; // 25%
const WARMING_PERCENTAGE = 0.0; // 0% (disabled)

async function onPriceUpdate(pair: string, timestamp: number) {
  tracker.recordPriceUpdate(pair, timestamp);

  if (Math.random() < WARMING_PERCENTAGE) {
    await warmer.warmForPair(pair);
  }
}
```

### Rollback Verification

After rollback, verify:

1. ✅ Service health restored
2. ✅ Error rate back to baseline
3. ✅ Performance metrics normal
4. ✅ Cache hit rate stable (may drop to pre-warming levels)

---

## Best Practices

### 1. Start Conservative

```typescript
// Begin with conservative settings
const config = {
  strategy: 'topn',
  strategyConfig: { topN: 3, minScore: 0.5 }, // Conservative
  warmerConfig: { maxPairsPerWarm: 3 },
};

// Gradually increase as confidence grows
// topN: 3 → 5 → 8 → 10
// minScore: 0.5 → 0.4 → 0.3
```

### 2. Monitor Continuously

Set up dashboards and alerts before deployment.

### 3. Test in Staging

Always test with production-like traffic in staging first.

### 4. Document Configuration

Keep configuration rationale documented:

```typescript
const config = {
  // Reason: Based on 95th percentile of correlated pairs in production
  topN: 5,

  // Reason: Balance between coverage and precision
  minScore: 0.3,

  // Reason: Keeps warming operations under 10ms
  maxPairsPerWarm: 5,
};
```

### 5. Plan for Failure

Have rollback procedures ready before deployment.

---

## Support

### Documentation

- API Reference: `docs/warming/API_REFERENCE.md`
- Configuration Guide: `docs/warming/CONFIGURATION_GUIDE.md`
- Troubleshooting: This document (Troubleshooting section)
- Migration Guide: `docs/warming/MIGRATION_GUIDE.md`

### Monitoring

- Metrics: `http://localhost:9090/metrics`
- Health: `http://localhost:9090/health/warming`
- Grafana: See dashboard definitions

### Contact

For issues or questions:
- GitHub Issues: [arbitrage/issues](https://github.com/arbitrage/issues)
- Slack: #cache-warming
- Email: team@arbitrage.com

---

**Deployment Checklist**: See `DEPLOYMENT_CHECKLIST.md`
**Grafana Dashboards**: See `GRAFANA_DASHBOARDS.md`
**API Reference**: See `API_REFERENCE.md`
