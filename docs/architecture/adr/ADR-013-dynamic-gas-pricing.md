# ADR-013: Dynamic Gas Price Cache for Arbitrage Detection

## Status

**Accepted** - 2026-01-16

## Context

The arbitrage detection system uses gas cost estimates in profit calculations to determine whether opportunities are profitable after execution costs. Prior to this change, gas costs were estimated using:

1. **Static values in config**: `ARBITRAGE_CONFIG.estimatedGasCost = $5 USD` (base-detector.ts)
2. **Hardcoded per-chain constants**: Fixed ETH amounts per chain (cross-dex-triangular-arbitrage.ts, multi-leg-path-finder.ts)

### Problems with Static Gas Estimates

1. **Accuracy Drift**: Ethereum gas prices vary significantly (10-500 gwei historically), making fixed estimates unreliable
2. **Chain Variation**: Different chains have vastly different gas costs (Ethereum mainnet vs L2s)
3. **False Positives**: Opportunities flagged as profitable might not cover actual gas costs
4. **False Negatives**: High static estimates might reject viable opportunities during low-gas periods

### Existing Dynamic Gas in Execution Layer

The execution engine already fetches real-time gas prices:
- [engine.ts:1466-1514](services/execution-engine/src/engine.ts#L1466-L1514): `getOptimalGasPrice()` uses `provider.getFeeData()`
- Gap: Detection layer uses static estimates while execution uses real-time data

## Decision

Implement a `GasPriceCache` singleton that provides dynamic gas pricing to the detection layer with:
- **60-second refresh interval** (conservative to avoid rate limit issues on free RPC tiers)
- **Graceful fallback** to static estimates on RPC failure
- **Per-chain gas prices** with EIP-1559 support
- **Native token price integration** for accurate USD conversion

### Implementation

#### 1. GasPriceCache Class

**File**: `shared/core/src/gas-price-cache.ts`

```typescript
export class GasPriceCache {
  private config: GasPriceCacheConfig;
  private gasPrices: Map<string, GasPriceData> = new Map();
  private nativePrices: Map<string, NativeTokenPrice> = new Map();
  private refreshTimer: NodeJS.Timeout | null = null;

  async start(): Promise<void>;
  async stop(): Promise<void>;
  getGasPrice(chain: string): GasPriceData;
  getNativeTokenPrice(chain: string): NativeTokenPrice;
  estimateGasCostUsd(chain: string, gasUnits: number): GasCostEstimate;
  estimateMultiLegGasCost(chain: string, numHops: number): number;
  estimateTriangularGasCost(chain: string): number;
}
```

#### 2. Gas Unit Constants

**File**: `shared/core/src/gas-price-cache.ts`

```typescript
export const GAS_UNITS = {
  simpleSwap: 150000,           // Uniswap V2 style
  complexSwap: 200000,          // Uniswap V3, Curve
  triangularArbitrage: 450000,  // 3 swaps
  quadrilateralArbitrage: 600000, // 4 swaps
  multiLegPerHop: 150000,       // Per additional hop
  multiLegBase: 100000          // Base overhead
};
```

#### 3. Integration Points

| File | Change |
|------|--------|
| [base-detector.ts:1160-1163](shared/core/src/base-detector.ts#L1160-L1163) | Uses `GasPriceCache.estimateGasCostUsd()` |
| [cross-dex-triangular-arbitrage.ts:818-832](shared/core/src/cross-dex-triangular-arbitrage.ts#L818-L832) | Updated `estimateGasCost()` to use cache |
| [multi-leg-path-finder.ts:726-740](shared/core/src/multi-leg-path-finder.ts#L726-L740) | Updated `estimateGasCost()` to use cache |

### Configuration

```typescript
interface GasPriceCacheConfig {
  refreshIntervalMs: number;  // Default: 60000 (60s)
  staleThresholdMs: number;   // Default: 120000 (2min)
  autoRefresh: boolean;       // Default: true
  chains?: string[];          // Default: all configured chains
}
```

### Fallback Values

Static fallback gas prices (gwei) used when RPC fails:
| Chain | Gas Price | Native Price |
|-------|-----------|--------------|
| Ethereum | 30 | $2500 |
| Arbitrum | 0.1 | $2500 |
| Optimism | 0.01 | $2500 |
| Base | 0.01 | $2500 |
| Polygon | 50 | $0.5 |
| BSC | 3 | $300 |

## Rationale

### Why 60-Second Refresh?

1. **Free Tier Compatibility**: Aligns with ADR-006 $0/month constraint
   - ~1440 RPC calls/day/chain for gas prices
   - Well within Alchemy/Infura free limits
2. **Sufficient Accuracy**: Gas prices rarely change dramatically within 60s
3. **Low Overhead**: Minimal impact on system resources

### Why Not Real-Time?

1. **Rate Limits**: Free RPC tiers have strict limits (Alchemy: 330 CU/s)
2. **Diminishing Returns**: Sub-minute accuracy adds complexity without proportional benefit
3. **Latency**: Each RPC call adds 50-200ms; detection must be fast

### Why Singleton Pattern?

1. **Consistency**: All detectors share same gas data
2. **Efficiency**: Single refresh timer, one set of RPC connections
3. **Testability**: Easy to mock/reset via `resetGasPriceCache()`

## Consequences

### Positive

- **Improved Accuracy**: Gas estimates reflect actual market conditions
- **Reduced False Positives**: High-gas periods correctly filter unprofitable opportunities
- **Reduced False Negatives**: Low-gas periods capture more valid opportunities
- **Chain-Specific Accuracy**: Each chain has appropriate gas cost estimates
- **Graceful Degradation**: Falls back to static estimates if RPC fails

### Negative

- **Additional RPC Calls**: ~1440 calls/day/chain (well within free limits)
- **Startup Latency**: Initial gas fetch adds ~500ms to startup
- **Stale Data Risk**: 60s cache could miss rapid gas spikes

### Mitigations

1. **RPC Calls**: Conservative 60s interval minimizes API usage
2. **Startup**: Cache initializes with fallback values immediately, refreshes async
3. **Stale Data**: 120s stale threshold marks data as fallback, conservative profit calculations

## Testing

### New Test File

`shared/core/__tests__/unit/gas-price-cache.test.ts` (26 tests)

Covers:
- Initialization and configuration
- Gas price fetching and caching
- Native token price management
- USD cost estimation
- Multi-leg and triangular cost calculations
- Refresh mechanisms
- Singleton behavior
- Lifecycle management

### Integration Tests

All existing detector tests continue to pass with the gas cache integration.

## Alternatives Considered

### Alternative 1: On-Demand Fetching

Fetch gas price on each opportunity calculation.

**Rejected because**:
- Adds 50-200ms latency per calculation
- Could exhaust rate limits during high detection activity
- Cache provides same accuracy with better performance

### Alternative 2: WebSocket Subscription

Subscribe to `newHeads` for real-time gas updates.

**Rejected because**:
- Requires persistent WebSocket connection
- More complex connection management
- Overkill for 60s accuracy requirement

### Alternative 3: External Gas Oracle

Use services like Gas Station Network or Blocknative.

**Rejected because**:
- Adds external dependency
- May require paid subscription for reliability
- Conflicts with $0/month constraint (ADR-006)

## References

- ADR-006: Free Hosting (constrains solution to $0/month)
- ADR-012: Worker Thread Path Finding (gas optimization phase)
- [docs/DETECTOR_OPTIMIZATION_ANALYSIS.md](docs/DETECTOR_OPTIMIZATION_ANALYSIS.md) - Phase 2 recommendations
- [detector_analysis.md.resolved](detector_analysis.md.resolved) - External analysis

## Confidence Level

**90%** - High confidence based on:
- Simple, well-understood caching pattern
- Conservative refresh interval avoids rate limits
- Comprehensive test coverage (26 tests)
- Graceful fallback ensures reliability
- All existing tests pass (61 tests total)
