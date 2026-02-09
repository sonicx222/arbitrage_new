# Warming Container Usage Guide

The `WarmingContainer` provides dependency injection for all warming infrastructure components. It simplifies setup, reduces boilerplate, and ensures proper wiring of dependencies.

## Table of Contents

1. [Quick Start](#quick-start)
2. [Configuration Options](#configuration-options)
3. [Usage Patterns](#usage-patterns)
4. [Testing](#testing)
5. [Advanced Scenarios](#advanced-scenarios)

---

## Quick Start

### Basic Usage (TopN Strategy)

```typescript
import {
  HierarchicalCache,
  createTopNWarming
} from '@arbitrage/core';

// Create cache
const cache = new HierarchicalCache({ l1Size: 64 });

// Create all warming components with defaults
const { tracker, warmer, strategy } = createTopNWarming(cache);

// Use in your service
tracker.recordPriceUpdate('WETH_USDT', Date.now());
await warmer.warmForPair('WETH_USDT');
```

### With Custom Configuration

```typescript
import {
  HierarchicalCache,
  WarmingContainer
} from '@arbitrage/core';

const cache = new HierarchicalCache({ l1Size: 64 });

// Create container with custom config
const container = WarmingContainer.create(cache, {
  strategy: 'adaptive',
  strategyConfig: {
    targetHitRate: 0.97,
    minPairs: 3,
    maxPairs: 10,
    minScore: 0.3,
    adjustmentFactor: 0.1
  },
  enableMetrics: true
});

// Build all components
const components = container.build();

// Access individual components
const { tracker, warmer, strategy, metricsCollector, metricsExporter } = components;
```

---

## Configuration Options

### WarmingContainerConfig

```typescript
interface WarmingContainerConfig {
  // Strategy type: 'topn', 'threshold', 'adaptive', 'timebased'
  strategy: WarmingStrategyType;

  // Strategy-specific configuration
  strategyConfig: TopNStrategyConfig | ThresholdStrategyConfig |
                  AdaptiveStrategyConfig | TimeBasedStrategyConfig;

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

### Strategy Configurations

#### TopN Strategy (Simple, Recommended)
```typescript
const config = {
  strategy: 'topn' as const,
  strategyConfig: {
    topN: 5,           // Warm top 5 pairs
    minScore: 0.3      // Minimum 30% correlation
  }
};
```

#### Threshold Strategy (Aggressive)
```typescript
const config = {
  strategy: 'threshold' as const,
  strategyConfig: {
    minScore: 0.5,     // Minimum 50% correlation
    maxPairs: 10       // Cap at 10 pairs
  }
};
```

#### Adaptive Strategy (Self-Tuning)
```typescript
const config = {
  strategy: 'adaptive' as const,
  strategyConfig: {
    targetHitRate: 0.97,      // Target 97% hit rate
    minPairs: 3,              // Minimum 3 pairs
    maxPairs: 10,             // Maximum 10 pairs
    minScore: 0.3,            // Minimum 30% correlation
    adjustmentFactor: 0.1     // 10% adjustment rate
  }
};
```

#### TimeBased Strategy (Context-Aware)
```typescript
const config = {
  strategy: 'timebased' as const,
  strategyConfig: {
    recencyWeight: 0.3,       // 30% weight for recency
    correlationWeight: 0.7,   // 70% weight for correlation
    recencyWindowMs: 60000,   // 1 minute window
    topN: 5,
    minScore: 0.3
  }
};
```

---

## Usage Patterns

### Pattern 1: Service Integration

```typescript
import {
  HierarchicalCache,
  createHierarchicalCache,
  WarmingContainer
} from '@arbitrage/core';

export class DetectorService {
  private cache: HierarchicalCache;
  private warmingComponents: WarmingComponents;

  constructor(config: ServiceConfig) {
    // 1. Create cache
    this.cache = createHierarchicalCache({
      l1Size: config.cacheSize,
      l2Enabled: true,
      usePriceMatrix: true
    });

    // 2. Create warming components
    this.warmingComponents = WarmingContainer.create(this.cache, {
      strategy: config.warmingStrategy,
      strategyConfig: config.strategyConfig,
      enableMetrics: true
    }).build();
  }

  async onPriceUpdate(pairAddress: string, timestamp: number) {
    // Track correlation (hot-path: <50μs)
    this.warmingComponents.tracker.recordPriceUpdate(pairAddress, timestamp);

    // Trigger warming (async, non-blocking)
    await this.warmingComponents.warmer.warmForPair(pairAddress);

    // Record metrics
    if (this.warmingComponents.metricsCollector) {
      this.warmingComponents.metricsCollector.incrementCounter(
        'price_updates_total',
        { chain: 'ethereum' }
      );
    }
  }

  async getMetrics(): Promise<string> {
    if (!this.warmingComponents.metricsExporter) {
      return '';
    }

    const result = await this.warmingComponents.metricsExporter.export();
    return result.data as string;
  }
}
```

### Pattern 2: Factory Functions

```typescript
import {
  createTopNWarming,
  createAdaptiveWarming,
  createTestWarming
} from '@arbitrage/core';

// Simple TopN
const topN = createTopNWarming(cache, 5, 0.3);

// Self-tuning Adaptive
const adaptive = createAdaptiveWarming(cache, 0.97, 10);

// Testing (no singleton, no metrics)
const test = createTestWarming(cache, 'topn');
```

### Pattern 3: Configuration-Driven

```typescript
import { WarmingContainer } from '@arbitrage/core';

// Load config from environment/file
const config = loadWarmingConfig();

// Create container from config
const container = WarmingContainer.create(cache, {
  strategy: config.WARMING_STRATEGY,
  strategyConfig: config.STRATEGY_CONFIG,
  enableMetrics: config.ENABLE_METRICS
});

// Build components
const components = container.build();

// Use components
export const tracker = components.tracker;
export const warmer = components.warmer;
export const metrics = components.metricsCollector;
```

### Pattern 4: Lazy Initialization

```typescript
import { WarmingContainer } from '@arbitrage/core';

export class WarmingService {
  private container: WarmingContainer;
  private components?: WarmingComponents;

  constructor(cache: HierarchicalCache, config: WarmingContainerConfig) {
    // Create container but don't build yet
    this.container = WarmingContainer.create(cache, config);
  }

  async initialize() {
    // Build components on demand
    if (!this.components) {
      this.components = this.container.build();
    }
  }

  getTracker() {
    if (!this.components) {
      throw new Error('Not initialized');
    }
    return this.components.tracker;
  }

  getWarmer() {
    if (!this.components) {
      throw new Error('Not initialized');
    }
    return this.components.warmer;
  }
}
```

---

## Testing

### Unit Testing with Mock Dependencies

```typescript
import {
  WarmingContainer,
  createTestWarming,
  ICorrelationTracker,
  ICacheWarmer
} from '@arbitrage/core';

describe('WarmingService', () => {
  let cache: HierarchicalCache;
  let components: WarmingComponents;

  beforeEach(() => {
    // Create cache
    cache = new HierarchicalCache({ l1Size: 64 });

    // Create test components (no singleton, no metrics)
    components = createTestWarming(cache, 'topn');
  });

  it('should track correlations', () => {
    const result = components.tracker.recordPriceUpdate('WETH_USDT', Date.now());

    expect(result.success).toBe(true);
    expect(result.durationUs).toBeLessThan(50);
  });

  it('should warm correlated pairs', async () => {
    // Record some updates to build correlations
    components.tracker.recordPriceUpdate('WETH_USDT', Date.now());
    components.tracker.recordPriceUpdate('WBTC_USDT', Date.now());

    // Trigger warming
    const result = await components.warmer.warmForPair('WETH_USDT');

    expect(result.success).toBe(true);
    expect(result.pairsAttempted).toBeGreaterThanOrEqual(0);
  });

  it('should return stats', () => {
    const trackerStats = components.tracker.getStats();
    const warmerStats = components.warmer.getStats();

    expect(trackerStats.totalPairs).toBeGreaterThanOrEqual(0);
    expect(warmerStats.totalWarmingOps).toBeGreaterThanOrEqual(0);
  });
});
```

### Integration Testing

```typescript
import {
  HierarchicalCache,
  WarmingContainer
} from '@arbitrage/core';

describe('Warming Integration', () => {
  let cache: HierarchicalCache;
  let container: WarmingContainer;
  let components: WarmingComponents;

  beforeEach(async () => {
    // Create real cache
    cache = new HierarchicalCache({
      l1Size: 64,
      l2Enabled: true,
      usePriceMatrix: true
    });

    // Create container with real dependencies
    container = WarmingContainer.create(cache, {
      strategy: 'topn',
      strategyConfig: { topN: 5, minScore: 0.3 },
      useSharedAnalyzer: false, // Use new instance
      enableMetrics: true
    });

    components = container.build();

    // Populate cache with test data
    await cache.set('price:ethereum:0x123', { price: 1.5, reserve0: '1000', reserve1: '1500' });
    await cache.set('price:ethereum:0x456', { price: 2.0, reserve0: '1000', reserve1: '2000' });
  });

  afterEach(async () => {
    await cache.clear();
  });

  it('should perform end-to-end warming', async () => {
    // 1. Track correlations
    components.tracker.recordPriceUpdate('0x123', Date.now());
    components.tracker.recordPriceUpdate('0x456', Date.now());
    components.tracker.recordPriceUpdate('0x123', Date.now() + 100);
    components.tracker.recordPriceUpdate('0x456', Date.now() + 100);

    // 2. Trigger warming
    const result = await components.warmer.warmForPair('0x123');

    expect(result.success).toBe(true);
    expect(result.durationMs).toBeLessThan(10);

    // 3. Check metrics
    if (components.metricsCollector) {
      const snapshot = components.metricsCollector.getSnapshot();
      expect(snapshot.length).toBeGreaterThan(0);
    }
  });
});
```

---

## Advanced Scenarios

### Scenario 1: Dynamic Strategy Switching

```typescript
import { WarmingContainer } from '@arbitrage/core';

class AdaptiveWarmingService {
  private container: WarmingContainer;
  private currentComponents: WarmingComponents;

  constructor(cache: HierarchicalCache) {
    this.container = WarmingContainer.create(cache, {
      strategy: 'topn',
      strategyConfig: { topN: 5, minScore: 0.3 }
    });
    this.currentComponents = this.container.build();
  }

  switchToAdaptive(targetHitRate: number) {
    // Update configuration
    this.container.updateConfig({
      strategy: 'adaptive',
      strategyConfig: {
        targetHitRate,
        minPairs: 3,
        maxPairs: 10,
        minScore: 0.3,
        adjustmentFactor: 0.1
      }
    });

    // Rebuild components
    this.currentComponents = this.container.build();
  }

  getComponents() {
    return this.currentComponents;
  }
}
```

### Scenario 2: Multiple Chains with Shared Analyzer

```typescript
import { WarmingContainer } from '@arbitrage/core';

class MultiChainWarmingService {
  private chains: Map<string, WarmingComponents> = new Map();

  addChain(chainId: string, cache: HierarchicalCache) {
    // All chains share the same correlation analyzer
    const components = WarmingContainer.create(cache, {
      strategy: 'topn',
      strategyConfig: { topN: 5, minScore: 0.3 },
      useSharedAnalyzer: true // IMPORTANT: Share analyzer
    }).build();

    this.chains.set(chainId, components);
  }

  onPriceUpdate(chainId: string, pairAddress: string, timestamp: number) {
    const components = this.chains.get(chainId);
    if (!components) return;

    // Correlation data is shared across all chains
    components.tracker.recordPriceUpdate(pairAddress, timestamp);
  }

  async warmAll(chainId: string, pairAddress: string) {
    // Warm on specific chain
    const components = this.chains.get(chainId);
    if (!components) return;

    await components.warmer.warmForPair(pairAddress);
  }
}
```

### Scenario 3: Metrics Aggregation

```typescript
import { WarmingContainer } from '@arbitrage/core';

class AggregatedMetricsService {
  private services: Map<string, WarmingComponents> = new Map();

  addService(serviceId: string, cache: HierarchicalCache) {
    const components = WarmingContainer.create(cache, {
      strategy: 'topn',
      strategyConfig: { topN: 5, minScore: 0.3 },
      enableMetrics: true
    }).build();

    this.services.set(serviceId, components);
  }

  async exportAggregatedMetrics(): Promise<string> {
    const allMetrics: string[] = [];

    for (const [serviceId, components] of this.services) {
      if (components.metricsExporter) {
        const result = await components.metricsExporter.export();
        allMetrics.push(`# Service: ${serviceId}\n${result.data}`);
      }
    }

    return allMetrics.join('\n\n');
  }
}
```

### Scenario 4: Custom Metrics Integration

```typescript
import { WarmingContainer, MetricType } from '@arbitrage/core';

class CustomMetricsService {
  private components: WarmingComponents;

  constructor(cache: HierarchicalCache) {
    this.components = WarmingContainer.create(cache, {
      strategy: 'topn',
      strategyConfig: { topN: 5, minScore: 0.3 },
      enableMetrics: true
    }).build();

    // Add custom metrics
    this.defineCustomMetrics();
  }

  private defineCustomMetrics() {
    if (!this.components.metricsCollector) return;

    // Custom business metrics
    this.components.metricsCollector.defineMetric({
      name: 'arbitrage_opportunities_found',
      type: MetricType.COUNTER,
      description: 'Arbitrage opportunities detected',
      labels: ['chain', 'dex']
    });

    this.components.metricsCollector.defineMetric({
      name: 'trade_execution_duration_ms',
      type: MetricType.HISTOGRAM,
      description: 'Trade execution latency',
      labels: ['chain', 'strategy']
    });
  }

  recordOpportunity(chain: string, dex: string) {
    if (!this.components.metricsCollector) return;

    this.components.metricsCollector.incrementCounter(
      'arbitrage_opportunities_found',
      { chain, dex }
    );
  }

  recordTradeLatency(chain: string, strategy: string, durationMs: number) {
    if (!this.components.metricsCollector) return;

    this.components.metricsCollector.recordHistogram(
      'trade_execution_duration_ms',
      durationMs,
      { chain, strategy }
    );
  }
}
```

---

## Best Practices

### 1. Use Factory Functions for Simple Cases
```typescript
// Good: Simple and readable
const { warmer, tracker } = createTopNWarming(cache, 5, 0.3);

// Avoid: Over-engineering simple cases
const container = WarmingContainer.create(cache, {
  strategy: 'topn',
  strategyConfig: { topN: 5, minScore: 0.3 }
});
const { warmer, tracker } = container.build();
```

### 2. Share Correlation Analyzer in Production
```typescript
// Good: Share analyzer across services (default)
const components = WarmingContainer.create(cache, {
  useSharedAnalyzer: true // Default
}).build();

// Avoid: Creating multiple analyzers wastes memory
const components = WarmingContainer.create(cache, {
  useSharedAnalyzer: false // Only for testing
}).build();
```

### 3. Enable Metrics in Production
```typescript
// Good: Always collect metrics in production
const components = WarmingContainer.create(cache, {
  enableMetrics: true // Default
}).build();

// Avoid: Disabling metrics in production
const components = WarmingContainer.create(cache, {
  enableMetrics: false // Only for testing
}).build();
```

### 4. Use Configuration Objects
```typescript
// Good: Configuration-driven
const config = loadConfig();
const components = WarmingContainer.create(cache, config).build();

// Avoid: Hard-coded configuration
const components = WarmingContainer.create(cache, {
  strategy: 'topn',
  strategyConfig: { topN: 5, minScore: 0.3 }
}).build();
```

---

## Troubleshooting

### Problem: Container build fails with "unknown strategy"
**Solution**: Ensure strategy type matches one of: 'topn', 'threshold', 'adaptive', 'timebased'

### Problem: Metrics not appearing
**Solution**: Check `enableMetrics: true` in config

### Problem: High memory usage
**Solution**: Use `useSharedAnalyzer: true` (default) to share correlation analyzer

### Problem: Tests failing with singleton state
**Solution**: Use `createTestWarming()` which creates new analyzer instances

---

## Performance Tips

1. **Hot-Path**: Correlation tracking is <50μs, safe for hot-path
2. **Background**: Warming is async/non-blocking, doesn't impact latency
3. **Metrics**: Recording is <10μs, minimal overhead
4. **Shared Analyzer**: Saves ~1-2MB per service instance
5. **Strategy Selection**: TopN is fastest, Adaptive adds ~100μs overhead

---

## Summary

The `WarmingContainer` simplifies warming infrastructure setup by:

✅ **Reducing Boilerplate**: No manual wiring of dependencies
✅ **Ensuring Correctness**: Proper dependency injection
✅ **Supporting Testing**: Easy mocking and isolation
✅ **Configuration-Driven**: Runtime configuration changes
✅ **Factory Functions**: Convenient shortcuts for common cases
✅ **Type-Safe**: Full TypeScript support

For most use cases, start with `createTopNWarming()` and upgrade to custom configuration as needed.
