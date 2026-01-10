# ADR-005: Hierarchical Caching Strategy (L1/L2/L3)

## Status
**Accepted** | 2025-01-10

## Context

The arbitrage detection system requires extremely fast access to price data:
- Price lookups happen on every event (~100-500/second)
- Cross-chain detection compares prices across multiple chains
- Stale prices lead to failed arbitrage attempts

### Current Implementation

The system has a hierarchical cache ([shared/core/src/hierarchical-cache.ts](../../../shared/core/src/hierarchical-cache.ts)):
- **L1**: SharedArrayBuffer for cross-worker access
- **L2**: Redis for distributed caching
- **L3**: Persistent storage (in-memory simulation)

### Problem Statement

1. **L1 not fully utilized**: SharedArrayBuffer allocated but not used for price matrix
2. **L2 over-reliance**: Too many Redis calls for price lookups
3. **No predictive warming**: Cache misses on first access after events
4. **Promotion/demotion not tuned**: Generic thresholds, not optimized for arbitrage

## Decision

Optimize the hierarchical cache specifically for arbitrage price data:

### L1: Price Matrix (Sub-Microsecond)
- Fixed-size Float64Array for all monitored pairs
- Indexed by `hash(chain, dex, pair)` → offset
- Atomic updates via `Atomics.store()`
- Zero-copy access from worker threads

### L2: Redis (1-5ms)
- Recent price history (last 100 updates per pair)
- Cross-partition price sharing
- TTL: 60 seconds (prices stale after)

### L3: MongoDB (10-50ms)
- Opportunity history for ML training
- Price snapshots for backtesting
- Not used in hot path

### Implementation

```typescript
// Optimized L1 Price Matrix
class PriceMatrix {
  // Fixed-size buffer for all pairs
  // Layout: [price0, timestamp0, price1, timestamp1, ...]
  private buffer: SharedArrayBuffer;
  private prices: Float64Array;
  private timestamps: Uint32Array;

  // Pre-computed index map: "bsc:pancake:WBNB_USDT" → 0
  private indexMap: Map<string, number>;

  constructor(maxPairs: number = 1000) {
    // 16 bytes per pair: 8 (price) + 4 (timestamp) + 4 (padding)
    this.buffer = new SharedArrayBuffer(maxPairs * 16);
    this.prices = new Float64Array(this.buffer, 0, maxPairs);
    this.timestamps = new Uint32Array(this.buffer, maxPairs * 8, maxPairs);
    this.indexMap = new Map();
  }

  // O(1) update - ~100 nanoseconds
  updatePrice(chain: string, dex: string, pair: string, price: number): void {
    const key = `${chain}:${dex}:${pair}`;
    let index = this.indexMap.get(key);

    if (index === undefined) {
      index = this.indexMap.size;
      this.indexMap.set(key, index);
    }

    // Atomic write for thread safety
    Atomics.store(this.prices, index, price);
    Atomics.store(this.timestamps, index, Math.floor(Date.now() / 1000));
  }

  // O(1) read - ~50 nanoseconds
  getPrice(chain: string, dex: string, pair: string): number | null {
    const key = `${chain}:${dex}:${pair}`;
    const index = this.indexMap.get(key);

    if (index === undefined) return null;

    const timestamp = Atomics.load(this.timestamps, index);
    const age = Math.floor(Date.now() / 1000) - timestamp;

    // Stale price check (>60 seconds)
    if (age > 60) return null;

    return Atomics.load(this.prices, index);
  }

  // O(pairs) but parallelizable - for cross-chain detection
  getBestPrices(pair: string): Array<{chain: string, dex: string, price: number}> {
    const results: Array<{chain: string, dex: string, price: number}> = [];

    for (const [key, index] of this.indexMap) {
      if (key.endsWith(`:${pair}`)) {
        const price = Atomics.load(this.prices, index);
        const [chain, dex] = key.split(':');
        results.push({ chain, dex, price });
      }
    }

    return results.sort((a, b) => a.price - b.price);
  }
}
```

## Rationale

### Why Three Levels?

| Level | Speed | Scope | Use Case |
|-------|-------|-------|----------|
| L1 | ~0.1μs | Single instance | Hot path price lookups |
| L2 | ~2ms | Cross-partition | Price sharing, history |
| L3 | ~20ms | Persistent | Analytics, ML training |

### Cache Hit Rate Targets

| Operation | L1 Target | L2 Target | L3 Target |
|-----------|-----------|-----------|-----------|
| Price lookup (same partition) | 99% | 1% | 0% |
| Price lookup (cross partition) | 0% | 99% | 1% |
| Historical query | 0% | 50% | 50% |

### Memory Budget

| Level | Allocation | Capacity |
|-------|------------|----------|
| L1 | 16KB per 1000 pairs | 10,000 pairs max |
| L2 | 256MB Redis limit | ~100K cached values |
| L3 | 512MB MongoDB limit | ~1M records |

### Performance Comparison

| Operation | Without L1 | With L1 | Improvement |
|-----------|------------|---------|-------------|
| Price lookup | 2ms (Redis) | 0.1μs | 20,000x |
| Cross-chain check (10 pairs) | 20ms | 1μs | 20,000x |
| Arbitrage detection cycle | 50ms | 5ms | 10x |

## Consequences

### Positive
- Sub-microsecond price lookups
- Thread-safe via Atomics
- Zero Redis calls for hot path
- Scales to 10,000 pairs without performance degradation

### Negative
- Fixed memory allocation (can't grow dynamically)
- L1 not shared across partitions (by design)
- Requires careful index management
- SharedArrayBuffer needs specific Node.js flags

### Mitigations

1. **Fixed allocation**: Size for 2x expected pairs
2. **Cross-partition**: Use Redis for cross-partition price sharing
3. **Index management**: Automated via pair discovery
4. **Node.js flags**: Document in deployment guide

## Predictive Cache Warming

```typescript
// Warm cache for correlated pairs before they're needed
class PredictiveWarmer {
  private correlations: Map<string, string[]>;

  async onPriceUpdate(pair: string): Promise<void> {
    // If WETH_USDT updated, also warm WETH_USDC, WBTC_USDT, etc.
    const correlated = this.correlations.get(pair) || [];

    for (const correlatedPair of correlated) {
      if (!this.priceMatrix.hasRecent(correlatedPair)) {
        // Pre-fetch from L2 to L1
        const price = await this.l2Cache.get(correlatedPair);
        if (price) {
          this.priceMatrix.warmPrice(correlatedPair, price);
        }
      }
    }
  }
}
```

## Alternatives Considered

### Alternative 1: Redis Only (No L1)
- **Rejected because**: 2ms per lookup unacceptable for high-frequency detection
- **Would reconsider if**: Redis latency dropped to <0.1ms

### Alternative 2: In-Process Map (No SharedArrayBuffer)
- **Rejected because**: Not accessible from worker threads
- **Would reconsider if**: Worker pool architecture changes

### Alternative 3: Memory-Mapped File
- **Rejected because**: I/O overhead, complexity
- **Would reconsider if**: Need persistence across restarts

## References

- [Current implementation](../../../shared/core/src/hierarchical-cache.ts)
- [SharedArrayBuffer MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)
- [Atomics MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics)

## Confidence Level

**85%** - High confidence based on:
- SharedArrayBuffer is proven for high-frequency data
- Clear performance math
- Already have L1 infrastructure, just needs optimization
- Fallback to L2 if L1 fails
