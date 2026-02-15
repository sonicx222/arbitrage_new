# ADR-031: Multi-Bridge Selection Strategy

## Status
**Accepted**

## Date
2026-02-15

## Context

The system originally supported a single bridge protocol (Stargate V1) for cross-chain arbitrage execution. As Stargate V2 launched and other bridge protocols (Across) became viable alternatives, we needed a strategy for:

1. **Multi-bridge support**: Different bridges have different strengths (latency, cost, reliability, chain coverage)
2. **Stargate V1 → V2 migration**: V2 offers lower fees and faster delivery, but V1 still has liquidity on some routes
3. **Graceful degradation**: If one bridge fails or has low liquidity, the system should fall back to alternatives
4. **Operational visibility**: Per-bridge metrics to understand which bridges perform best on which routes

Without a selection strategy, operators would need to manually switch bridges or hardcode protocol preferences, missing cost and speed optimizations.

## Decision

Implement a multi-bridge architecture with three layers:

### 1. BridgeRouterFactory — Protocol Registry

A factory manages all available bridge router implementations:

```
BridgeRouterFactory
├── StargateRouter (V1)
├── AcrossRouter
└── StargateV2Router
```

- Each router implements `IBridgeRouter` with a consistent interface for `quote()`, `execute()`, `getStatus()`, `healthCheck()`
- The factory provides `findSupportedRouter()` which collects all routers supporting a given route and selects the optimal one via `selectOptimalBridge()` scoring
- Protocols can be disabled at startup via `disabledProtocols` config to skip initialization entirely

### 2. selectOptimalBridge() — Route Scoring

When multiple bridges support the same route (e.g., Ethereum→Arbitrum USDC), the system scores each based on:

- **Latency**: Bridge delivery time (weight varies by urgency)
- **Cost**: Bridge fee as percentage of trade size
- **Reliability**: Historical success rate

Scoring weights adjust by urgency level:
- `low`: Heavily favors cost (60% cost, 20% latency, 20% reliability)
- `medium`: Balanced (33% each)
- `high`: Heavily favors latency (60% latency, 20% cost, 20% reliability)

Route configuration with per-bridge costs and latencies lives in `shared/config/src/bridge-config.ts`.

### 3. Operational Monitoring

Three monitoring mechanisms ensure operational visibility:

**a. Health Check Metrics** (`BridgeHealthMetrics`):
- Per-protocol success/failure counts from periodic health checks
- Per-router timeout isolation (10s) prevents one hanging router from blocking others

**b. Execution Metrics** (`BridgeExecutionMetrics`):
- Per-protocol tracking of quote/execute attempts, successes, failures, and cumulative latency
- Recorded by consumers via `factory.recordExecution()` after each bridge operation

**c. Pool Liquidity Alerting** (`PoolLiquidityAlert`):
- Monitors V1 Stargate USDC pool balance as a migration signal
- Warning at <$10,000, critical at <$1,000
- Optional `onPoolAlert` callback for integration with alerting systems

## Rationale

### Why factory pattern (not strategy pattern)?
The factory pattern allows multiple routers to coexist and be queried independently. A strategy pattern would only allow one active bridge at a time. With the factory, `findSupportedRouter()` can evaluate all options per-route while `getRouter()` allows direct access when the protocol is predetermined.

### Why callback-based alerting (not event emitter)?
The `onPoolAlert` callback is simpler than an EventEmitter for a single event type. It follows the existing pattern from circuit breaker's `onStateChange` callback (ADR-018). Callbacks are fire-and-forget with try-catch protection, so they never block the health check path.

### Why disable at construction (not runtime)?
Disabled protocols are skipped during factory construction rather than filtered at query time. This avoids creating router instances (with timers, cleanup intervals) that would never be used, and makes `getAvailableProtocols()` accurate without conditional filtering.

### Why consumer-driven metrics (not proxy-based)?
Execution metrics are recorded by the consumer calling `factory.recordExecution()` rather than the factory wrapping router calls. This avoids adding a proxy layer, keeps the factory simple, and lets consumers record metrics with accurate latency timing that includes their own overhead (serialization, validation).

## Alternatives Considered

### 1. Single bridge with runtime switching
Simpler but loses the ability to automatically select the best bridge per-route. Would require manual intervention to change bridges.

### 2. EventEmitter for monitoring
More flexible but over-engineered for the current single-event use case. Could be adopted later if monitoring grows to multiple event types.

### 3. Proxy-based metrics (wrap router calls)
Would automate metrics collection but adds complexity, makes the call chain harder to debug, and doesn't capture consumer-side latency accurately.

## Implementation Details

### Files Created
- `shared/core/src/bridge-router/across-router.ts` — Across Protocol implementation
- `shared/core/src/bridge-router/stargate-v2-router.ts` — Stargate V2 implementation

### Files Modified
- `shared/core/src/bridge-router/types.ts` — Added `BridgeExecutionMetrics`, `PoolLiquidityAlert`, `'stargate-v2'` and `'across'` to `BridgeProtocol`
- `shared/core/src/bridge-router/index.ts` — Extended factory with metrics, disabling, alerting, health check timeout
- `shared/core/src/bridge-router/stargate-router.ts` — Added `onPoolAlert` callback support
- `shared/config/src/bridge-config.ts` — Added route data for Across and Stargate V2

### Migration Path (V1 → V2)
1. Deploy with all three bridges enabled (default)
2. Monitor V1 pool liquidity via `onPoolAlert` callbacks
3. Compare execution metrics between V1 and V2 per route
4. When V2 is stable: add `'stargate'` to `disabledProtocols` to disable V1
5. Eventually remove V1 code when no longer needed

## Consequences

### Positive
- Cross-chain execution can use the cheapest/fastest bridge per route automatically
- V1 → V2 migration is gradual and data-driven, not a risky flag-day switch
- Per-bridge metrics enable informed decisions about bridge selection tuning
- Disabled protocols consume zero resources (no timers, no connections)

### Negative
- Three bridge implementations to maintain (until V1 is removed)
- Route scoring weights are heuristic-based and may need tuning per market conditions
- Consumer-driven metrics require discipline (callers must call `recordExecution()`)

## References

- [ADR-018: Execution Circuit Breaker](./ADR-018-circuit-breaker.md) — Callback pattern reference
- `shared/config/src/bridge-config.ts` — Route configuration and scoring logic
- `shared/core/src/bridge-router/` — All bridge router implementations
- [Stargate V2 Docs](https://stargateprotocol.gitbook.io/stargate/v2) — V2 protocol reference
- [Across Protocol Docs](https://docs.across.to/) — Across protocol reference
