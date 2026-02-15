# ADR-032: Flash Loan Provider Aggregation

## Status
**Accepted**

## Date
2026-02-15

## Context

ADR-020 introduced Aave V3 flash loans, and ADR-030 expanded to PancakeSwap V3 and multi-protocol contract architecture. With 5 flash loan protocols (Aave V3, Balancer V2, PancakeSwap V3, SyncSwap, SpookySwap) across 10+ EVM chains, each with different fees, liquidity pools, and execution latencies, the system needs an intelligent provider selection layer.

Problems with static protocol assignment:

1. **Fee variation**: Balancer V2 charges 0% while Aave V3 charges 0.09% — choosing wrong costs profit
2. **Liquidity fragmentation**: A protocol may have deep liquidity on one chain but not another
3. **Reliability drift**: Provider success rates change over time due to congestion, upgrades, or outages
4. **No fallback**: If the assigned provider fails, the opportunity is lost without retry logic

The execution engine needs a single entry point that selects the optimal provider per opportunity, validates liquidity for large trades, and handles fallback routing.

## Decision

Implement a flash loan provider aggregation layer using Clean Architecture with Domain-Driven Design principles, located at `shared/core/src/flash-loan-aggregation/`.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    FLASH LOAN PROVIDER AGGREGATION                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Application Layer                                                          │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  SelectProviderUseCase                                                │  │
│  │    - DTO conversion (ArbitrageOpportunity → domain types)            │  │
│  │    - Input validation (NaN, Infinity, negative values)               │  │
│  │    - Orchestrates domain interfaces                                   │  │
│  └───────────────────────────┬───────────────────────────────────────────┘  │
│                              │                                              │
│  Domain Layer (Pure Logic)   ▼                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  IFlashLoanAggregator                                                 │  │
│  │    selectProvider(opportunity, context) → ProviderSelection           │  │
│  │    decideFallback(failed, error, remaining) → FallbackDecision       │  │
│  │         │                        │                                    │  │
│  │         ▼                        ▼                                    │  │
│  │  IProviderRanker           ILiquidityValidator                       │  │
│  │  (Strategy Pattern)        (On-chain RPC)                            │  │
│  │    rankProviders()           checkLiquidity()                        │  │
│  │         │                                                             │  │
│  │         ▼                                                             │  │
│  │  IAggregatorMetrics                                                   │  │
│  │  (Observer Pattern)                                                   │  │
│  │    recordSelection(), recordOutcome()                                │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  Domain Value Objects (Immutable, Object.freeze)                           │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐  │
│  │ProviderScore │ │LiquidityCheck│ │ProviderSelect│ │AggregatorConfig  │  │
│  │ feeScore     │ │ available    │ │ protocol     │ │ weights          │  │
│  │ liqScore     │ │ required     │ │ score        │ │ thresholds       │  │
│  │ relScore     │ │ sufficient?  │ │ alternatives │ │ cacheTTLs        │  │
│  │ latScore     │ │ margin%      │ │ reason       │ │ latencyDefaults  │  │
│  │ totalScore   │ │ latency      │ │ latency      │ │ maxProviders     │  │
│  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────────┘  │
│                                                                             │
│  Infrastructure Layer                                                       │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  FlashLoanAggregatorImpl  →  implements IFlashLoanAggregator         │  │
│  │  WeightedRankingStrategy  →  implements IProviderRanker              │  │
│  │  OnChainLiquidityValidator → implements ILiquidityValidator          │  │
│  │  InMemoryAggregatorMetrics → implements IAggregatorMetrics           │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Provider Selection Algorithm

The default `WeightedRankingStrategy` scores each provider on four dimensions:

| Dimension | Weight | Calculation |
|-----------|--------|-------------|
| Fees | 50% | `1 - (feeBps / maxFeeBps)` — lower fees = higher score |
| Liquidity | 30% | Ratio-based: 2x required → 1.0, 1.1x → 0.9, 1x → 0.7, <1x → 0.3 |
| Reliability | 15% | Historical success rate from `IAggregatorMetrics` |
| Latency | 5% | Protocol-specific defaults or measured execution latency |

```
totalScore = clamp(0, 1,
  feeScore * 0.50 +
  liquidityScore * 0.30 +
  reliabilityScore * 0.15 +
  latencyScore * 0.05
)
```

Selection flow:
1. Get ranked providers (from 30s ranking cache or fresh calculation)
2. Filter by availability
3. For amounts > $100K: validate on-chain liquidity via RPC (5min cache with request coalescing)
4. Return top provider that passes all checks, with ranked alternatives

### Fallback Decision Tree

When a provider fails during execution:

```
Error Type           → Action
─────────────────────────────────────
insufficient_liquidity → Try next ranked provider
high_fees              → Try next ranked provider
transient              → Retry same (future enhancement)
permanent              → Abort (validation error)
unknown                → Try next ranked provider
```

### Pluggable Ranking Strategies

The `IProviderRanker` Strategy Pattern supports swappable algorithms:

| Strategy | Use Case | Weight Distribution |
|----------|----------|---------------------|
| WeightedRankingStrategy (default) | General use | fees 50%, liq 30%, rel 15%, lat 5% |
| FeeOptimizedStrategy | High-value trades | fees 80%, others 20% |
| ReliabilityFirstStrategy | Volatile markets | rel 60%, fees 30%, others 10% |
| AdaptiveStrategy | MEV-active periods | Adjusts based on volatility/MEV signals |

### Immutable Value Objects

All domain objects are frozen via `Object.freeze` (including nested objects) to prevent accidental mutation in shared state:

- `ProviderScore` — Score breakdown with `[0, 1]` range validation per component
- `LiquidityCheck` — On-chain validation result with conservative failure semantics (assume insufficient on RPC error)
- `ProviderSelection` — Selection result with ranked alternatives
- `AggregatorConfig` — Frozen configuration with weight sum validation (tolerance 0.01)
- `ProviderOutcome` — Execution result for reliability tracking

### Protocol Coverage

| Protocol | Fee | Chains | Latency Default |
|----------|-----|--------|-----------------|
| Aave V3 | 9 bps (0.09%) | Ethereum, Polygon, Arbitrum, Optimism, Base, Avalanche | 0.95 |
| Balancer V2 | 0 bps (free) | Ethereum, Polygon, Arbitrum | 0.90 |
| PancakeSwap V3 | Pool-dependent (1-100 bps) | BSC, Ethereum, Arbitrum, zkSync, Linea, Base, opBNB | 0.85 |
| SyncSwap | 30 bps (0.30%) | zkSync, Linea | 0.80 |
| SpookySwap | 30 bps (0.30%) | Fantom | 0.80 |

## Rationale

### Why Clean Architecture?

1. **Testability**: Domain logic is pure (no I/O), infrastructure is isolated behind interfaces
2. **Extensibility**: New protocols or ranking strategies don't touch existing code
3. **Independence**: Domain layer has zero imports from infrastructure or services

### Why Immutable Value Objects?

1. **Thread safety**: Frozen objects prevent shared-state mutations across async flows
2. **Predictability**: Callers cannot corrupt selection results after construction
3. **Debug transparency**: Score breakdowns are preserved exactly as computed

### Why Strategy Pattern for Ranking?

1. **Market adaptability**: Switch from fee-optimized to reliability-first during outages
2. **A/B testing**: Run different strategies per chain partition
3. **No aggregator modification**: New strategies implement `IProviderRanker`, plug in via constructor DI

### Why Not a Simpler Approach?

Static protocol mapping (chain → protocol) was the initial design but failed because:
- Balancer V2 is free but has lower liquidity on some chains
- Aave V3 reliability varies by chain congestion
- PancakeSwap V3 fees differ by pool tier
- No single protocol dominates across all dimensions

## Consequences

### Positive

- **Optimal provider per-opportunity**: Each trade gets the best provider for its specific chain, amount, and market conditions
- **Automatic fallback**: Failed executions try the next best provider instead of dropping the opportunity
- **Reliability learning**: Metrics feedback loop improves selection accuracy over time
- **Protocol-agnostic**: Execution engine calls `selectProvider()` without knowing protocol details

### Negative

- **Cold-path overhead**: First selection per chain adds ~10ms for ranking computation
- **Additional abstraction**: Three-layer architecture adds indirection compared to direct protocol calls
- **Cache staleness**: 30s ranking cache and 5min liquidity cache may serve stale data during rapid market moves

### Neutral

- **No hot-path impact**: Aggregation runs during strategy selection, not in the detection hot path (<50ms target unaffected)
- **Backward compatible**: Existing direct protocol usage in execution-engine is unaffected

## Alternatives Considered

### 1. Static Chain-Protocol Mapping
**Rejected** because:
- Balancer V2 (free) isn't available on all chains — fallback needed
- Cannot adapt to liquidity changes or provider outages
- No reliability learning

### 2. Round-Robin Provider Selection
**Rejected** because:
- Ignores fee differences (0% vs 0.09% matters for profit margins)
- Doesn't account for liquidity sufficiency
- No quality-based adaptation

### 3. Monolithic Selection Function
**Rejected** because:
- Untestable without real RPC calls
- Cannot swap ranking algorithms
- Mixes concerns (scoring, validation, caching, metrics)

## Implementation Details

### Files

**Domain Layer** (`shared/core/src/flash-loan-aggregation/domain/`):
- `models.ts` — Value objects: ProviderScore, LiquidityCheck, ProviderSelection, AggregatorConfig, ProviderOutcome
- `aggregator.interface.ts` — IFlashLoanAggregator interface
- `provider-ranker.interface.ts` — IProviderRanker strategy interface, IRankingContext
- `liquidity-validator.interface.ts` — ILiquidityValidator interface
- `metrics-tracker.interface.ts` — IAggregatorMetrics observer interface

**Application Layer** (`shared/core/src/flash-loan-aggregation/application/`):
- `select-provider.usecase.ts` — SelectProviderUseCase orchestration
- `dtos.ts` — Data Transfer Objects for layer boundary

**Infrastructure Layer** (`shared/core/src/flash-loan-aggregation/infrastructure/`):
- `flashloan-aggregator.impl.ts` — Core aggregator implementation
- `weighted-ranking.strategy.ts` — Default weighted ranking strategy
- `onchain-liquidity.validator.ts` — RPC-based liquidity validation with circuit breaker
- `inmemory-aggregator.metrics.ts` — In-memory metrics collection

### Performance Targets

| Operation | Target | Cache Hit |
|-----------|--------|-----------|
| `selectProvider()` | <10ms | <1ms |
| `rankProviders()` | <2ms | N/A (always computed) |
| `checkLiquidity()` | <10ms (RPC) | <1ms |
| Metrics recording | <100μs | N/A |

### Caching Strategy

| Cache | TTL | Scope | Rationale |
|-------|-----|-------|-----------|
| Provider rankings | 30s | Per chain | Rankings stable within a few blocks |
| Liquidity checks | 5min | Per provider/asset | On-chain liquidity changes slowly |
| Request coalescing | Per-request | Per provider/asset | Deduplicates concurrent RPC calls |

### Test Coverage

| Test File | Tests |
|-----------|-------|
| models.test.ts | 59 |
| select-provider.usecase.test.ts | 21 |
| flashloan-aggregator.impl.test.ts | 46 |
| weighted-ranking.strategy.test.ts | 38 |
| onchain-liquidity.validator.test.ts | 18 |
| inmemory-aggregator.metrics.test.ts | 12 |
| **Total** | **194** |

## Success Criteria

- ✅ Domain layer has zero imports from infrastructure or services
- ✅ All value objects are immutable (Object.freeze with deep freeze on nested objects)
- ✅ 194 tests passing across 6 test suites
- ✅ Weighted scoring produces correct provider ordering across all protocol combinations
- ✅ Fallback routing selects next-best provider on failure
- ✅ Liquidity validation uses conservative defaults on RPC failure
- ✅ Configuration validates weights (finite, [0,1] range, sum to 1.0)

## References

- [ADR-020: Flash Loan Integration](./ADR-020-flash-loan.md) — Aave V3 foundation
- [ADR-030: PancakeSwap V3 Flash Loans](./ADR-030-pancakeswap-v3-flash-loans.md) — Multi-protocol contract architecture
- [ADR-022: Hot-Path Memory Optimization](./ADR-022-hot-path-memory-optimization.md) — Performance patterns (aggregation is cold-path)
- [FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md](../../research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md) Phase 2 Task 2.3
- [Deep Analysis Report](./../../../.agent-reports/flash-loan-aggregation-domain-deep-analysis.md)

## Confidence Level
92% - High confidence based on:
- Clean Architecture boundaries enforced by TypeScript compiler (no cross-layer imports)
- 194 tests covering happy paths, error paths, edge cases, and immutability
- Domain deep analysis (6-agent, 20 findings) completed and all P1/P2 fixes applied
- Remaining uncertainty: adaptive strategy and cross-chain liquidity aggregation are future work
