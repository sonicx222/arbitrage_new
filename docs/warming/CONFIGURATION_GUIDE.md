# Warming Infrastructure Configuration Guide

**Version**: 1.0
**Last Updated**: 2026-02-06

---

## Table of Contents

1. [Configuration Overview](#configuration-overview)
2. [Environment Variables](#environment-variables)
3. [Strategy Configuration](#strategy-configuration)
4. [Warmer Configuration](#warmer-configuration)
5. [Metrics Configuration](#metrics-configuration)
6. [Configuration Profiles](#configuration-profiles)
7. [Dynamic Configuration](#dynamic-configuration)
8. [Configuration Validation](#configuration-validation)

---

## Configuration Overview

The warming infrastructure uses a hierarchical configuration system:

```
Environment Variables
        ↓
Configuration Profiles (dev/staging/prod)
        ↓
WarmingContainerConfig
        ↓
Runtime Components
```

### Configuration Layers

1. **Defaults**: Sensible defaults for all settings
2. **Environment**: Override via environment variables
3. **Profile**: Environment-specific profiles
4. **Runtime**: Dynamic updates during execution

---

## Environment Variables

### Core Settings

```bash
# Strategy Selection
WARMING_STRATEGY=topn|threshold|adaptive|timebased
# Default: topn

# Feature Flags
FEATURE_CACHE_WARMING_ENABLED=true|false
# Default: true

# Metrics
WARMING_METRICS_ENABLED=true|false
# Default: true

METRICS_PREFIX=arbitrage_
# Default: arbitrage_

METRICS_PORT=9090
# Default: 9090
```

### Strategy Configuration (JSON)

```bash
# TopN Strategy
WARMING_STRATEGY_CONFIG='{"topN":5,"minScore":0.3}'

# Threshold Strategy
WARMING_STRATEGY_CONFIG='{"minScore":0.5,"maxPairs":10}'

# Adaptive Strategy
WARMING_STRATEGY_CONFIG='{
  "targetHitRate":0.97,
  "minPairs":3,
  "maxPairs":10,
  "minScore":0.3,
  "adjustmentFactor":0.1
}'

# TimeBased Strategy
WARMING_STRATEGY_CONFIG='{
  "recencyWeight":0.3,
  "correlationWeight":0.7,
  "recencyWindowMs":60000,
  "topN":5,
  "minScore":0.3
}'
```

### Cache Configuration

```bash
# L1 Cache Size (number of entries)
CACHE_L1_SIZE=128
# Default: 64

# Enable L2 (Redis) cache
CACHE_L2_ENABLED=true
# Default: true

# Use PriceMatrix for L1
CACHE_USE_PRICE_MATRIX=true
# Default: true
```

### Warmer Configuration

```bash
# Maximum pairs to warm per operation
WARMING_MAX_PAIRS_PER_WARM=5
# Default: 5

# Minimum correlation score
WARMING_MIN_CORRELATION_SCORE=0.3
# Default: 0.3

# Async warming (non-blocking)
WARMING_ASYNC=true
# Default: true

# Operation timeout (ms)
WARMING_TIMEOUT_MS=50
# Default: 50
```

### Analyzer Configuration

```bash
# Co-occurrence window (ms)
ANALYZER_CO_OCCURRENCE_WINDOW_MS=1000
# Default: 1000

# Maximum tracked pairs
ANALYZER_MAX_TRACKED_PAIRS=5000
# Default: 5000

# Use shared analyzer
ANALYZER_USE_SHARED=true
# Default: true
```

---

## Strategy Configuration

### TopN Strategy

Warms a fixed number of top correlated pairs.

```typescript
interface TopNStrategyConfig {
  topN: number;        // Number of pairs to warm
  minScore: number;    // Minimum correlation score (0-1)
}
```

**Configuration**:
```typescript
{
  topN: 5,           // Warm top 5 pairs
  minScore: 0.3      // Only if correlation ≥ 30%
}
```

**Tuning Guidelines**:
- **Low topN** (3-5): Conservative, lower overhead
- **Medium topN** (5-8): Balanced approach
- **High topN** (8-15): Aggressive warming, higher coverage

**When to use**:
- ✅ Simple use cases
- ✅ Predictable traffic patterns
- ✅ Fixed warming budget
- ❌ Variable traffic patterns
- ❌ Need automatic tuning

**Example Configurations**:

```typescript
// Conservative (low overhead)
{
  topN: 3,
  minScore: 0.5
}

// Balanced (recommended default)
{
  topN: 5,
  minScore: 0.3
}

// Aggressive (maximum coverage)
{
  topN: 10,
  minScore: 0.2
}
```

---

### Threshold Strategy

Warms all pairs above a correlation threshold.

```typescript
interface ThresholdStrategyConfig {
  minScore: number;    // Minimum correlation score (0-1)
  maxPairs: number;    // Safety cap
}
```

**Configuration**:
```typescript
{
  minScore: 0.5,     // Only strong correlations
  maxPairs: 10       // Cap at 10 pairs
}
```

**Tuning Guidelines**:
- **High minScore** (0.5-0.7): Only strong correlations
- **Medium minScore** (0.3-0.5): Balanced quality/coverage
- **Low minScore** (0.2-0.3): Maximum coverage

**When to use**:
- ✅ Want all strong correlations
- ✅ Correlation quality more important than count
- ✅ Variable number of correlated pairs
- ❌ Need strict pair count limit
- ❌ Many weak correlations

**Example Configurations**:

```typescript
// High quality only
{
  minScore: 0.7,
  maxPairs: 5
}

// Balanced
{
  minScore: 0.5,
  maxPairs: 10
}

// Maximum coverage
{
  minScore: 0.3,
  maxPairs: 15
}
```

---

### Adaptive Strategy

Self-tuning strategy that adjusts based on cache hit rate.

```typescript
interface AdaptiveStrategyConfig {
  targetHitRate: number;      // Target cache hit rate (0-1)
  minPairs: number;           // Minimum pairs to warm
  maxPairs: number;           // Maximum pairs to warm
  minScore: number;           // Minimum correlation score
  adjustmentFactor: number;   // Adjustment rate (0-1)
}
```

**Configuration**:
```typescript
{
  targetHitRate: 0.97,      // Target 97% hit rate
  minPairs: 3,              // Always warm at least 3
  maxPairs: 10,             // Never warm more than 10
  minScore: 0.3,            // Quality threshold
  adjustmentFactor: 0.1     // Adjust by 10% each time
}
```

**Tuning Guidelines**:

**targetHitRate**:
- **High** (0.95-0.99): Aggressive warming, higher overhead
- **Medium** (0.90-0.95): Balanced approach
- **Low** (0.85-0.90): Conservative, lower overhead

**adjustmentFactor**:
- **Slow** (0.05-0.1): Gradual adaptation, stable
- **Medium** (0.1-0.2): Balanced response
- **Fast** (0.2-0.5): Rapid adaptation, less stable

**When to use**:
- ✅ Production with variable traffic
- ✅ Want automatic optimization
- ✅ Cache hit rate is primary metric
- ✅ Traffic patterns change over time
- ❌ Need predictable behavior
- ❌ Development/testing

**Example Configurations**:

```typescript
// Conservative (slow adaptation)
{
  targetHitRate: 0.92,
  minPairs: 2,
  maxPairs: 8,
  minScore: 0.4,
  adjustmentFactor: 0.05
}

// Balanced (recommended for production)
{
  targetHitRate: 0.97,
  minPairs: 3,
  maxPairs: 10,
  minScore: 0.3,
  adjustmentFactor: 0.1
}

// Aggressive (maximum hit rate)
{
  targetHitRate: 0.99,
  minPairs: 5,
  maxPairs: 15,
  minScore: 0.2,
  adjustmentFactor: 0.15
}
```

**How it works**:
1. Measures current cache hit rate
2. Compares to target hit rate
3. If below target: increases pairs warmed by adjustmentFactor
4. If above target: decreases pairs warmed by adjustmentFactor
5. Always stays within [minPairs, maxPairs] bounds

---

### TimeBased Strategy

Combines correlation strength with recency.

```typescript
interface TimeBasedStrategyConfig {
  recencyWeight: number;        // Weight for recency (0-1)
  correlationWeight: number;    // Weight for correlation (0-1)
  recencyWindowMs: number;      // Recency window (ms)
  topN: number;                 // Number of pairs to select
  minScore: number;             // Minimum combined score
}
```

**Configuration**:
```typescript
{
  recencyWeight: 0.3,           // 30% weight on recency
  correlationWeight: 0.7,       // 70% weight on correlation
  recencyWindowMs: 60000,       // Last 1 minute
  topN: 5,
  minScore: 0.3
}
```

**Tuning Guidelines**:

**recencyWeight / correlationWeight**:
- **Correlation-focused** (0.2/0.8): Historical patterns dominate
- **Balanced** (0.3/0.7): Mix of recent and historical
- **Recency-focused** (0.5/0.5): Recent activity dominates

**recencyWindowMs**:
- **Short** (30s-1min): Only very recent activity
- **Medium** (1-5min): Recent activity
- **Long** (5-15min): Broader recent activity

**When to use**:
- ✅ Time-sensitive correlations
- ✅ Intraday trading patterns
- ✅ Flash crashes / sudden activity
- ❌ Stable correlation patterns
- ❌ Long-term correlations

**Example Configurations**:

```typescript
// Recency-focused (react to current activity)
{
  recencyWeight: 0.5,
  correlationWeight: 0.5,
  recencyWindowMs: 30000,      // 30 seconds
  topN: 5,
  minScore: 0.3
}

// Balanced
{
  recencyWeight: 0.3,
  correlationWeight: 0.7,
  recencyWindowMs: 60000,      // 1 minute
  topN: 5,
  minScore: 0.3
}

// Correlation-focused (stable patterns)
{
  recencyWeight: 0.2,
  correlationWeight: 0.8,
  recencyWindowMs: 300000,     // 5 minutes
  topN: 8,
  minScore: 0.3
}
```

---

## Warmer Configuration

Controls cache warmer behavior.

```typescript
interface WarmingConfig {
  maxPairsPerWarm: number;      // Max pairs per warming operation
  minCorrelationScore: number;  // Min score to consider
  asyncWarming: boolean;        // Async (non-blocking)
  timeoutMs: number;            // Operation timeout
  enabled: boolean;             // Enable/disable warming
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

**Configuration**:

```typescript
// Low overhead (minimal warming)
{
  maxPairsPerWarm: 3,
  minCorrelationScore: 0.5,
  asyncWarming: true,
  timeoutMs: 30,
  enabled: true
}

// Balanced (recommended)
{
  maxPairsPerWarm: 5,
  minCorrelationScore: 0.3,
  asyncWarming: true,
  timeoutMs: 50,
  enabled: true
}

// Aggressive (maximum warming)
{
  maxPairsPerWarm: 10,
  minCorrelationScore: 0.2,
  asyncWarming: true,
  timeoutMs: 100,
  enabled: true
}
```

**Field Guidelines**:

- **maxPairsPerWarm**: Hard limit on pairs per operation
  - Overrides strategy selection if strategy selects more
  - Use to control worst-case warming time

- **minCorrelationScore**: Quality filter before strategy
  - Pre-filters correlations before strategy sees them
  - Use to reduce noise in strategy input

- **asyncWarming**: Controls blocking behavior
  - `true`: Non-blocking, better for hot-path
  - `false`: Blocking, easier debugging

- **timeoutMs**: Maximum time for warming operation
  - Should be 5-10x expected duration
  - Prevents hung operations

---

## Metrics Configuration

Controls metrics collection and export.

```typescript
interface ExportConfig {
  format: ExportFormat;            // Export format
  includeTimestamps: boolean;      // Include timestamps
  includeMetadata: boolean;        // Include metadata
  metricPrefix: string;            // Metric name prefix
}
```

**Defaults**:
```typescript
{
  format: ExportFormat.PROMETHEUS,
  includeTimestamps: false,
  includeMetadata: true,
  metricPrefix: 'arbitrage_'
}
```

**Export Formats**:

```typescript
enum ExportFormat {
  PROMETHEUS = 'prometheus',  // Prometheus text format
  JSON = 'json',              // JSON format
  OTLP = 'otlp',             // OpenTelemetry format
  GRAFANA = 'grafana'         // Grafana dashboard JSON
}
```

**Configuration Examples**:

```typescript
// Prometheus (recommended)
{
  format: ExportFormat.PROMETHEUS,
  includeTimestamps: false,
  includeMetadata: true,
  metricPrefix: 'arbitrage_'
}

// JSON (for APIs)
{
  format: ExportFormat.JSON,
  includeTimestamps: true,
  includeMetadata: true,
  metricPrefix: ''
}

// OpenTelemetry
{
  format: ExportFormat.OTLP,
  includeTimestamps: true,
  includeMetadata: true,
  metricPrefix: 'arbitrage_'
}
```

---

## Configuration Profiles

### Development Profile

```typescript
const developmentConfig: WarmingContainerConfig = {
  strategy: 'topn',
  strategyConfig: {
    topN: 3,
    minScore: 0.3,
  },
  warmerConfig: {
    maxPairsPerWarm: 3,
    asyncWarming: false,    // Synchronous for debugging
    timeoutMs: 100,
  },
  enableMetrics: false,     // Faster tests
  useSharedAnalyzer: false, // Isolated
};
```

**Characteristics**:
- ✅ Fast tests
- ✅ Easy debugging
- ✅ Isolated state
- ❌ Not production-like

---

### Staging Profile

```typescript
const stagingConfig: WarmingContainerConfig = {
  strategy: 'topn',
  strategyConfig: {
    topN: 5,
    minScore: 0.3,
  },
  warmerConfig: {
    maxPairsPerWarm: 5,
    asyncWarming: true,
    timeoutMs: 50,
  },
  metricsConfig: {
    format: ExportFormat.PROMETHEUS,
    metricPrefix: 'staging_arbitrage_',
  },
  enableMetrics: true,
  useSharedAnalyzer: true,
};
```

**Characteristics**:
- ✅ Production-like
- ✅ Metrics enabled
- ✅ Shared state
- ✅ Safe for testing

---

### Production Profile

```typescript
const productionConfig: WarmingContainerConfig = {
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
    minCorrelationScore: 0.3,
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

**Characteristics**:
- ✅ Self-tuning
- ✅ Full metrics
- ✅ Optimized for hit rate
- ✅ Production-ready

---

## Dynamic Configuration

### Loading from Environment

```typescript
function loadConfig(): WarmingContainerConfig {
  const strategy = process.env.WARMING_STRATEGY as WarmingStrategyType || 'topn';
  const strategyConfig = JSON.parse(
    process.env.WARMING_STRATEGY_CONFIG ||
    '{"topN":5,"minScore":0.3}'
  );

  return {
    strategy,
    strategyConfig,
    warmerConfig: {
      maxPairsPerWarm: parseInt(process.env.WARMING_MAX_PAIRS_PER_WARM || '5'),
      minCorrelationScore: parseFloat(process.env.WARMING_MIN_CORRELATION_SCORE || '0.3'),
      asyncWarming: process.env.WARMING_ASYNC !== 'false',
      timeoutMs: parseInt(process.env.WARMING_TIMEOUT_MS || '50'),
      enabled: process.env.FEATURE_CACHE_WARMING_ENABLED !== 'false',
    },
    enableMetrics: process.env.WARMING_METRICS_ENABLED !== 'false',
    useSharedAnalyzer: process.env.ANALYZER_USE_SHARED !== 'false',
  };
}

const config = loadConfig();
const container = WarmingContainer.create(cache, config);
```

---

### Runtime Updates

```typescript
class ConfigurableWarmingService {
  private container: WarmingContainer;
  private components: WarmingComponents;

  constructor(cache: HierarchicalCache, initialConfig: WarmingContainerConfig) {
    this.container = WarmingContainer.create(cache, initialConfig);
    this.components = this.container.build();
  }

  updateStrategy(newStrategy: WarmingStrategyType, newConfig: any) {
    this.container.updateConfig({
      strategy: newStrategy,
      strategyConfig: newConfig,
    });

    // Rebuild components with new config
    this.components = this.container.build();
  }

  getCurrentConfig(): WarmingContainerConfig {
    return this.container.getConfig();
  }
}

// Usage
const service = new ConfigurableWarmingService(cache, productionConfig);

// Later: Switch to TopN strategy
service.updateStrategy('topn', { topN: 8, minScore: 0.4 });
```

---

## Configuration Validation

### Validation Function

```typescript
function validateConfig(config: WarmingContainerConfig): string[] {
  const errors: string[] = [];

  // Validate strategy
  const validStrategies = ['topn', 'threshold', 'adaptive', 'timebased'];
  if (!validStrategies.includes(config.strategy)) {
    errors.push(`Invalid strategy: ${config.strategy}`);
  }

  // Validate strategy config
  if (config.strategy === 'topn') {
    const cfg = config.strategyConfig as TopNStrategyConfig;
    if (cfg.topN < 1 || cfg.topN > 20) {
      errors.push('topN must be between 1 and 20');
    }
    if (cfg.minScore < 0 || cfg.minScore > 1) {
      errors.push('minScore must be between 0 and 1');
    }
  }

  if (config.strategy === 'adaptive') {
    const cfg = config.strategyConfig as AdaptiveStrategyConfig;
    if (cfg.targetHitRate < 0.5 || cfg.targetHitRate > 1) {
      errors.push('targetHitRate must be between 0.5 and 1');
    }
    if (cfg.minPairs >= cfg.maxPairs) {
      errors.push('minPairs must be less than maxPairs');
    }
  }

  // Validate warmer config
  if (config.warmerConfig) {
    if (config.warmerConfig.maxPairsPerWarm && config.warmerConfig.maxPairsPerWarm < 1) {
      errors.push('maxPairsPerWarm must be at least 1');
    }
    if (config.warmerConfig.timeoutMs && config.warmerConfig.timeoutMs < 10) {
      errors.push('timeoutMs must be at least 10ms');
    }
  }

  return errors;
}

// Usage
const config = loadConfig();
const errors = validateConfig(config);

if (errors.length > 0) {
  console.error('Configuration errors:', errors);
  process.exit(1);
}
```

---

## Configuration Best Practices

### 1. Start Conservative

```typescript
// ✅ Good: Start with conservative settings
const initialConfig = {
  strategy: 'topn',
  strategyConfig: { topN: 3, minScore: 0.5 },
};

// Gradually increase as confidence grows
```

### 2. Use Environment Variables

```typescript
// ✅ Good: Configuration from environment
const config = loadConfig();

// ❌ Bad: Hard-coded configuration
const config = { strategy: 'topn', strategyConfig: { topN: 5, minScore: 0.3 } };
```

### 3. Validate Configuration

```typescript
// ✅ Good: Validate before use
const errors = validateConfig(config);
if (errors.length > 0) {
  throw new Error(`Invalid config: ${errors.join(', ')}`);
}
```

### 4. Document Configuration Rationale

```typescript
// ✅ Good: Explain why
const config = {
  strategy: 'adaptive',
  strategyConfig: {
    targetHitRate: 0.97,  // Reason: Based on 95th percentile in prod
    maxPairs: 10,         // Reason: Keeps warming under 10ms
  },
};
```

### 5. Monitor Configuration Impact

```typescript
// ✅ Good: Log config changes
console.log('Warming config updated:', {
  strategy: newConfig.strategy,
  timestamp: new Date().toISOString(),
});

// Record metric
metricsCollector.incrementCounter('config_updates_total', {
  strategy: newConfig.strategy,
});
```

---

## See Also

- [API Reference](API_REFERENCE.md)
- [Deployment Guide](DEPLOYMENT_GUIDE.md)
- [Migration Guide](MIGRATION_GUIDE.md)
