# Warming Infrastructure API Reference

**Version**: 1.0
**Last Updated**: 2026-02-06

---

## Table of Contents

1. [Container API](#container-api)
2. [Factory Functions](#factory-functions)
3. [Domain Interfaces](#domain-interfaces)
4. [Configuration Types](#configuration-types)
5. [Metrics](#metrics)
6. [Error Handling](#error-handling)

---

## Container API

### WarmingContainer

Dependency injection container for warming infrastructure.

#### `WarmingContainer.create(cache, config?)`

Creates a new warming container instance.

**Parameters**:
- `cache: HierarchicalCache` - Cache instance to use
- `config?: Partial<WarmingContainerConfig>` - Optional configuration

**Returns**: `WarmingContainer`

**Example**:
```typescript
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
```

#### `container.build()`

Builds all warming components with proper dependency injection.

**Returns**: `WarmingComponents`

**Example**:
```typescript
const components = container.build();
const { tracker, warmer, strategy, metricsCollector } = components;
```

#### `container.updateConfig(config)`

Updates container configuration. Requires rebuild to apply changes.

**Parameters**:
- `config: Partial<WarmingContainerConfig>` - Configuration updates

**Returns**: `void`

**Example**:
```typescript
container.updateConfig({
  strategy: 'topn',
  strategyConfig: { topN: 8, minScore: 0.4 },
});

// Rebuild to apply changes
const newComponents = container.build();
```

#### `container.getConfig()`

Gets current configuration (immutable copy).

**Returns**: `WarmingContainerConfig`

**Example**:
```typescript
const config = container.getConfig();
console.log('Current strategy:', config.strategy);
```

---

## Factory Functions

### createTopNWarming()

Creates warming components with TopN strategy (simplest option).

**Signature**:
```typescript
function createTopNWarming(
  cache: HierarchicalCache,
  topN: number = 5,
  minScore: number = 0.3
): WarmingComponents
```

**Parameters**:
- `cache: HierarchicalCache` - Cache instance
- `topN?: number` - Number of top correlated pairs to warm (default: 5)
- `minScore?: number` - Minimum correlation score (default: 0.3)

**Returns**: `WarmingComponents`

**Example**:
```typescript
const { tracker, warmer } = createTopNWarming(cache, 5, 0.3);

tracker.recordPriceUpdate('WETH_USDT', Date.now());
await warmer.warmForPair('WETH_USDT');
```

**When to use**: Simple use cases with fixed number of pairs to warm.

---

### createAdaptiveWarming()

Creates warming components with Adaptive strategy (self-tuning).

**Signature**:
```typescript
function createAdaptiveWarming(
  cache: HierarchicalCache,
  targetHitRate: number = 0.97,
  maxPairs: number = 10
): WarmingComponents
```

**Parameters**:
- `cache: HierarchicalCache` - Cache instance
- `targetHitRate?: number` - Target cache hit rate (default: 0.97)
- `maxPairs?: number` - Maximum pairs to warm (default: 10)

**Returns**: `WarmingComponents`

**Example**:
```typescript
const { tracker, warmer, strategy } = createAdaptiveWarming(cache, 0.97, 10);

// Strategy adjusts pairs warmed based on hit rate feedback
tracker.recordPriceUpdate('WETH_USDT', Date.now());
await warmer.warmForPair('WETH_USDT');
```

**When to use**: Production use cases where optimal pair count varies with traffic patterns.

---

### createTestWarming()

Creates warming components for testing (isolated, no metrics).

**Signature**:
```typescript
function createTestWarming(
  cache: HierarchicalCache,
  strategy: WarmingStrategyType = 'topn'
): WarmingComponents
```

**Parameters**:
- `cache: HierarchicalCache` - Cache instance
- `strategy?: WarmingStrategyType` - Strategy type (default: 'topn')

**Returns**: `WarmingComponents`

**Example**:
```typescript
const components = createTestWarming(cache, 'topn');

// Isolated from production state, no metrics overhead
components.tracker.recordPriceUpdate('TEST_PAIR', Date.now());
const stats = components.tracker.getStats();
```

**When to use**: Unit tests, integration tests, development.

---

## Domain Interfaces

### ICorrelationTracker

Tracks price update correlations for predictive warming.

#### `recordPriceUpdate(pairAddress, timestamp)`

Records a price update for correlation analysis.

**Signature**:
```typescript
recordPriceUpdate(
  pairAddress: string,
  timestamp: number
): OperationResult
```

**Parameters**:
- `pairAddress: string` - Pair contract address
- `timestamp: number` - Update timestamp (milliseconds)

**Returns**: `OperationResult`
```typescript
{
  success: boolean;
  durationUs?: number;  // Operation duration in microseconds
  error?: string;
}
```

**Performance**: <50μs (hot-path safe)

**Example**:
```typescript
const result = tracker.recordPriceUpdate('0x123...', Date.now());
console.log('Tracking duration:', result.durationUs, 'μs');
```

---

#### `getPairsToWarm(sourcePair, timestamp, maxPairs, minScore)`

Gets correlated pairs to warm.

**Signature**:
```typescript
getPairsToWarm(
  sourcePair: string,
  timestamp: number,
  maxPairs: number,
  minScore: number
): CorrelationResult
```

**Parameters**:
- `sourcePair: string` - Source pair address
- `timestamp: number` - Current timestamp
- `maxPairs: number` - Maximum pairs to return
- `minScore: number` - Minimum correlation score (0-1)

**Returns**: `CorrelationResult`
```typescript
{
  success: boolean;
  correlations: Array<{
    pair: string;
    score: number;
    coOccurrences: number;
    lastUpdate: number;
  }>;
  durationUs?: number;
  error?: string;
}
```

**Example**:
```typescript
const result = tracker.getPairsToWarm('0x123...', Date.now(), 5, 0.3);
result.correlations.forEach(corr => {
  console.log(`${corr.pair}: score=${corr.score}`);
});
```

---

#### `getStats()`

Gets tracker statistics.

**Signature**:
```typescript
getStats(): TrackerStats
```

**Returns**: `TrackerStats`
```typescript
{
  totalPairs: number;
  totalUpdates: number;
  avgUpdatesPerPair: number;
}
```

**Example**:
```typescript
const stats = tracker.getStats();
console.log(`Tracking ${stats.totalPairs} pairs`);
```

---

### ICacheWarmer

Performs predictive cache warming based on correlations.

#### `warmForPair(sourcePair)`

Warms correlated pairs for a source pair.

**Signature**:
```typescript
warmForPair(sourcePair: string): Promise<WarmingResult>
```

**Parameters**:
- `sourcePair: string` - Source pair address

**Returns**: `Promise<WarmingResult>`
```typescript
{
  success: boolean;
  pairsAttempted: number;
  pairsWarmed: number;
  errors: number;
  durationMs: number;
  error?: string;
}
```

**Performance**: <10ms (background operation)

**Example**:
```typescript
const result = await warmer.warmForPair('0x123...');
console.log(`Warmed ${result.pairsWarmed}/${result.pairsAttempted} pairs in ${result.durationMs}ms`);
```

---

#### `warmBatch(sourcePairs)`

Warms multiple source pairs in batch.

**Signature**:
```typescript
warmBatch(sourcePairs: string[]): Promise<WarmingResult>
```

**Parameters**:
- `sourcePairs: string[]` - Array of source pair addresses

**Returns**: `Promise<WarmingResult>`

**Example**:
```typescript
const result = await warmer.warmBatch(['0x123...', '0x456...']);
console.log(`Batch warming: ${result.pairsWarmed} pairs in ${result.durationMs}ms`);
```

---

#### `getStats()`

Gets warmer statistics.

**Signature**:
```typescript
getStats(): WarmerStats
```

**Returns**: `WarmerStats`
```typescript
{
  totalWarmingOps: number;
  totalPairsWarmed: number;
  totalErrors: number;
  avgDurationMs: number;
}
```

**Example**:
```typescript
const stats = warmer.getStats();
const successRate = (stats.totalPairsWarmed / stats.totalWarmingOps).toFixed(2);
console.log(`Success rate: ${successRate} pairs/op`);
```

---

### IWarmingStrategy

Selects which pairs to warm based on strategy logic.

#### `selectPairs(context)`

Selects pairs to warm from correlation context.

**Signature**:
```typescript
selectPairs(context: WarmingContext): WarmingSelection
```

**Parameters**:
- `context: WarmingContext` - Context with correlations and cache state

**Returns**: `WarmingSelection`
```typescript
{
  selectedPairs: string[];
  reason: string;
  metadata?: Record<string, any>;
}
```

**Example**:
```typescript
const context = {
  sourcePair: '0x123...',
  correlations: [...],
  currentHitRate: 0.92,
  timestamp: Date.now(),
};

const selection = strategy.selectPairs(context);
console.log(`Selected ${selection.selectedPairs.length} pairs: ${selection.reason}`);
```

---

### IMetricsCollector

Collects metrics for monitoring and observability.

#### `incrementCounter(name, labels?, delta?)`

Increments a counter metric.

**Signature**:
```typescript
incrementCounter(
  name: string,
  labels?: MetricLabels,
  delta: number = 1
): void
```

**Parameters**:
- `name: string` - Metric name
- `labels?: Record<string, string>` - Optional labels
- `delta?: number` - Increment amount (default: 1)

**Performance**: <10μs

**Example**:
```typescript
metricsCollector.incrementCounter(
  'price_updates_total',
  { chain: 'ethereum', dex: 'uniswap' }
);
```

---

#### `setGauge(name, value, labels?)`

Sets a gauge metric value.

**Signature**:
```typescript
setGauge(
  name: string,
  value: number,
  labels?: MetricLabels
): void
```

**Example**:
```typescript
metricsCollector.setGauge(
  'correlation_pairs_tracked',
  trackerStats.totalPairs,
  { chain: 'ethereum' }
);
```

---

#### `recordHistogram(name, value, labels?)`

Records a histogram observation.

**Signature**:
```typescript
recordHistogram(
  name: string,
  value: number,
  labels?: MetricLabels
): void
```

**Example**:
```typescript
metricsCollector.recordHistogram(
  'warming_duration_ms',
  result.durationMs,
  { chain: 'ethereum' }
);
```

---

### IMetricsExporter

Exports metrics in various formats.

#### `export()`

Exports all metrics in configured format.

**Signature**:
```typescript
export(): Promise<ExportResult>
```

**Returns**: `Promise<ExportResult>`
```typescript
{
  success: boolean;
  format: ExportFormat;
  data: string | object;
  metadata?: {
    timestamp: number;
    metricsCount: number;
  };
  error?: string;
}
```

**Example**:
```typescript
const result = await metricsExporter.export();
console.log(result.data); // Prometheus format text
```

---

## Configuration Types

### WarmingContainerConfig

Main container configuration.

```typescript
interface WarmingContainerConfig {
  // Strategy type
  strategy: 'topn' | 'threshold' | 'adaptive' | 'timebased';

  // Strategy-specific configuration
  strategyConfig:
    | TopNStrategyConfig
    | ThresholdStrategyConfig
    | AdaptiveStrategyConfig
    | TimeBasedStrategyConfig;

  // Cache warmer configuration
  warmerConfig?: Partial<WarmingConfig>;

  // Metrics export configuration
  metricsConfig?: Partial<ExportConfig>;

  // Use shared correlation analyzer (default: true)
  useSharedAnalyzer?: boolean;

  // Enable metrics collection (default: true)
  enableMetrics?: boolean;
}
```

---

### TopNStrategyConfig

Configuration for TopN strategy (simplest).

```typescript
interface TopNStrategyConfig {
  // Number of top correlated pairs to warm
  topN: number;

  // Minimum correlation score (0-1)
  minScore: number;
}
```

**Example**:
```typescript
{
  topN: 5,
  minScore: 0.3
}
```

**When to use**: Fixed number of pairs to warm, simple and predictable.

---

### ThresholdStrategyConfig

Configuration for Threshold strategy (aggressive).

```typescript
interface ThresholdStrategyConfig {
  // Minimum correlation score (0-1)
  minScore: number;

  // Maximum pairs to warm (cap)
  maxPairs: number;
}
```

**Example**:
```typescript
{
  minScore: 0.5,  // Only strong correlations
  maxPairs: 10
}
```

**When to use**: Want all pairs above threshold, but with safety cap.

---

### AdaptiveStrategyConfig

Configuration for Adaptive strategy (self-tuning).

```typescript
interface AdaptiveStrategyConfig {
  // Target cache hit rate (0-1)
  targetHitRate: number;

  // Minimum pairs to warm
  minPairs: number;

  // Maximum pairs to warm
  maxPairs: number;

  // Minimum correlation score (0-1)
  minScore: number;

  // Adjustment rate (0-1)
  adjustmentFactor: number;
}
```

**Example**:
```typescript
{
  targetHitRate: 0.97,    // Target 97% hit rate
  minPairs: 3,            // Always warm at least 3
  maxPairs: 10,           // Never warm more than 10
  minScore: 0.3,          // Quality threshold
  adjustmentFactor: 0.1   // Adjust by 10% each iteration
}
```

**When to use**: Production with varying traffic, want optimal pair count to adjust automatically.

---

### TimeBasedStrategyConfig

Configuration for TimeBased strategy (recency-aware).

```typescript
interface TimeBasedStrategyConfig {
  // Weight for recency (0-1)
  recencyWeight: number;

  // Weight for correlation (0-1)
  correlationWeight: number;

  // Recency window in milliseconds
  recencyWindowMs: number;

  // Number of pairs to select
  topN: number;

  // Minimum correlation score
  minScore: number;
}
```

**Example**:
```typescript
{
  recencyWeight: 0.3,       // 30% weight on recency
  correlationWeight: 0.7,   // 70% weight on correlation
  recencyWindowMs: 60000,   // Consider last 1 minute
  topN: 5,
  minScore: 0.3
}
```

**When to use**: Time-sensitive patterns, recent correlations more important.

---

### WarmingConfig

Configuration for cache warmer behavior.

```typescript
interface WarmingConfig {
  // Maximum pairs to warm per operation
  maxPairsPerWarm: number;

  // Minimum correlation score to consider
  minCorrelationScore: number;

  // Async warming (non-blocking)
  asyncWarming: boolean;

  // Timeout in milliseconds
  timeoutMs: number;

  // Enable warming
  enabled: boolean;
}
```

**Defaults**:
```typescript
{
  maxPairsPerWarm: 5,
  minCorrelationScore: 0.3,
  asyncWarming: true,
  timeoutMs: 50,
  enabled: true
}
```

---

### ExportConfig

Configuration for metrics export.

```typescript
interface ExportConfig {
  // Export format
  format: ExportFormat;

  // Include timestamps
  includeTimestamps: boolean;

  // Include metadata
  includeMetadata: boolean;

  // Metric name prefix
  metricPrefix: string;
}
```

**Example**:
```typescript
{
  format: ExportFormat.PROMETHEUS,
  includeTimestamps: false,
  includeMetadata: true,
  metricPrefix: 'arbitrage_'
}
```

---

## Metrics

### Standard Metrics

All metrics are automatically defined when metrics are enabled.

#### Cache Metrics

```
# Cache hits by level
arbitrage_cache_hits_total{cache_level="L1|L2|L3",chain="ethereum"}

# Cache misses by level
arbitrage_cache_misses_total{cache_level="L1|L2|L3",chain="ethereum"}

# Cache size in bytes
arbitrage_cache_size_bytes{cache_level="L1|L2|L3",chain="ethereum"}

# Cache operation latency
arbitrage_cache_latency_ms{operation="get|set",cache_level="L1|L2|L3",chain="ethereum"}
```

#### Warming Metrics

```
# Total warming operations
arbitrage_warming_operations_total{chain="ethereum"}

# Total pairs warmed
arbitrage_warming_pairs_warmed_total{chain="ethereum"}

# Warming operation duration
arbitrage_warming_duration_ms{chain="ethereum"}
```

#### Correlation Metrics

```
# Correlation tracking duration (hot-path)
arbitrage_correlation_tracking_duration_us{chain="ethereum"}

# Number of pairs tracked
arbitrage_correlation_pairs_tracked{chain="ethereum"}
```

### Custom Metrics

Add custom business metrics:

```typescript
metricsCollector.defineMetric({
  name: 'arbitrage_opportunities_found',
  type: MetricType.COUNTER,
  description: 'Arbitrage opportunities detected',
  labels: ['chain', 'dex', 'strategy'],
});

// Record custom metric
metricsCollector.incrementCounter(
  'arbitrage_opportunities_found',
  { chain: 'ethereum', dex: 'uniswap', strategy: 'triangular' }
);
```

---

## Error Handling

### Error Types

#### OperationResult

All operations return structured results:

```typescript
interface OperationResult {
  success: boolean;
  error?: string;
  durationUs?: number;
  durationMs?: number;
}
```

**Example**:
```typescript
const result = tracker.recordPriceUpdate(pair, timestamp);

if (!result.success) {
  console.error('Tracking failed:', result.error);
  // Handle error, but don't crash
}
```

### Error Handling Best Practices

#### 1. Never Throw in Hot-Path

```typescript
// ✅ Good: Return error result
function recordPriceUpdate(pair: string, timestamp: number): OperationResult {
  try {
    // ... operation
    return { success: true, durationUs: 30 };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      durationUs: 0,
    };
  }
}
```

#### 2. Graceful Degradation

```typescript
// ✅ Good: Continue if warming fails
async function onPriceUpdate(pair: string) {
  tracker.recordPriceUpdate(pair, Date.now()); // Always track

  try {
    await warmer.warmForPair(pair);
  } catch (error) {
    // Log but don't crash
    console.error('Warming failed:', error);
  }
}
```

#### 3. Retry with Backoff

```typescript
// ✅ Good: Retry transient failures
async function warmWithRetry(pair: string, maxRetries = 3): Promise<WarmingResult> {
  for (let i = 0; i < maxRetries; i++) {
    const result = await warmer.warmForPair(pair);

    if (result.success || i === maxRetries - 1) {
      return result;
    }

    await new Promise(resolve => setTimeout(resolve, 2 ** i * 100));
  }
}
```

---

## Type Exports

### Main Exports

```typescript
import {
  // Container
  WarmingContainer,
  WarmingComponents,
  WarmingContainerConfig,
  WarmingStrategyType,

  // Factory functions
  createTopNWarming,
  createAdaptiveWarming,
  createTestWarming,

  // Domain interfaces
  ICorrelationTracker,
  ICacheWarmer,
  IWarmingStrategy,
  IMetricsCollector,
  IMetricsExporter,

  // Configuration types
  TopNStrategyConfig,
  ThresholdStrategyConfig,
  AdaptiveStrategyConfig,
  TimeBasedStrategyConfig,
  WarmingConfig,
  ExportConfig,

  // Result types
  OperationResult,
  CorrelationResult,
  WarmingResult,
  ExportResult,

  // Stats types
  TrackerStats,
  WarmerStats,

  // Infrastructure
  HierarchicalCache,
  CorrelationAnalyzer,

  // Metrics
  MetricType,
  ExportFormat,
} from '@arbitrage/core';
```

---

## Version History

### v1.0 (2026-02-06)

Initial release with:
- WarmingContainer with DI
- 3 factory functions
- 4 warming strategies
- Prometheus metrics
- Complete TypeScript types

---

## See Also

- [Deployment Guide](DEPLOYMENT_GUIDE.md)
- [Configuration Guide](CONFIGURATION_GUIDE.md)
- [Migration Guide](MIGRATION_GUIDE.md)
- [Troubleshooting](DEPLOYMENT_GUIDE.md#troubleshooting)
