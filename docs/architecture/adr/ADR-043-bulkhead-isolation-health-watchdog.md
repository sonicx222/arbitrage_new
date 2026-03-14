# ADR-043: Bulkhead Isolation & Health Watchdog for Service Resilience

## Status
**Accepted**

## Date
2026-03-14

## Context

The arbitrage system runs multiple blockchain chains within a single OS process per partition (ADR-003). Each partition monitors 3-7 chains via WebSocket connections. While ADR-010 addressed connection-level resilience (reconnection, backoff, provider rotation), several cascading crash paths remained where a single chain's WebSocket failure could kill the entire partition process:

### Identified Crash Vectors

1. **`process.exit(1)` on partial startup failure**: If any chain failed during partition startup, the runner called `process.exit(1)`, killing all chains in the partition — even if 6 out of 7 chains started successfully.

2. **Unhandled EventEmitter 'error' events**: The `CexPriceFeedService` (ADR-036) extends `EventEmitter` but had no default `'error'` listener. Node.js throws unhandled `'error'` events as `uncaughtException`, crashing the process.

3. **CEX feed initialization blocking coordinator startup**: `initializeCexFeed()` was awaited directly in the coordinator's `start()` chain. A Binance WebSocket failure (common on corporate networks) would abort the entire coordinator.

4. **Event handler error propagation**: `ChainInstanceManager` forwarded chain events (priceUpdate, opportunity, error, statusChange) to parent emitters without try/catch. An error in any listener for one chain's event would propagate as an uncaughtException.

5. **Duplicate listener accumulation**: On Redis reconnect, the partition runner's retry loop registered a new `'opportunity'` listener on every successful reconnect without removing the old one, causing duplicate publishes that multiplied with each reconnect.

6. **Service-wide unhandledRejection threshold**: The 5-rejection-in-60s shutdown threshold was process-wide. A single flaky WebSocket on one chain could generate 5 rejections and trigger shutdown of all chains.

7. **No automatic recovery for dead chains**: Once a chain's WebSocket died and exhausted reconnection attempts, it stayed dead permanently. No mechanism existed to periodically check and restart failed chains.

### Design Principles

- **Partition architecture (ADR-003)** co-locates chains in a single process for SharedArrayBuffer PriceMatrix (ADR-005) performance
- **Hot-path latency target: <50ms** — recovery mechanisms must not affect the detection pipeline
- **Graceful degradation (ADR-007)** — partial operation is better than total failure
- **Zero-cost when healthy** — watchdog and error boundaries add no overhead to the normal path

## Decision

Implement a two-layer resilience strategy: **Bulkhead Isolation** (prevent cascading failures) + **Health Watchdog** (auto-recover failed chains).

### Layer 1: Bulkhead Isolation (Phase 1 — Crash Prevention)

#### 1.1 Conditional `process.exit(1)`
Replace unconditional `process.exit(1)` in partition runner with a healthy-chain check. Only exit if zero chains are healthy; continue in degraded mode if some chains started successfully.

```typescript
// Before: Always exit
process.exit(1);

// After: Only exit if no healthy chains remain
const healthyChains = detector.getHealthyChains?.() ?? [];
if (healthyChains.length > 0) {
  logger.warn('Partition startup partially failed but has healthy chains, continuing in degraded mode');
} else {
  process.exit(1);
}
```

#### 1.2 CEX Feed Isolation
Wrap `initializeCexFeed()` in try/catch so CEX WebSocket failure doesn't abort coordinator startup. The CEX feed (ADR-036) is an enhancement — the coordinator can operate without it, just without CEX-DEX spread validation in scoring.

#### 1.3 Default 'error' Listener
Register a default `'error'` listener on `CexPriceFeedService` in the constructor. This prevents Node.js from throwing unhandled `'error'` events as `uncaughtException`.

#### 1.4 Per-Chain Error Boundaries
Wrap all event handler forwards in `ChainInstanceManager` with try/catch. Errors in one chain's event processing cannot propagate to other chains or crash the process.

#### 1.5 Duplicate Listener Guard
Add an `opportunityListenerWired` flag to prevent the Redis reconnect retry loop from registering duplicate `'opportunity'` listeners.

### Layer 2: Health Watchdog & Error Budgets (Phase 2 — Auto-Recovery)

#### 2.1 Configurable Rejection Threshold
Raise the `unhandledRejection` shutdown threshold from 5 to 15 (configurable via `UNHANDLED_REJECTION_THRESHOLD` env var). With Phase 1's error boundaries catching most WebSocket errors, the old threshold of 5 was too aggressive.

#### 2.2 Health Watchdog Timer
Add a periodic health check timer to `ChainInstanceManager` that:
- Runs every 30 seconds (configurable via `CHAIN_WATCHDOG_INTERVAL_MS`)
- Checks each chain instance's status
- Attempts stop-then-restart for chains in `'error'` or `'disconnected'` state
- Enforces per-chain restart limits (default 5, via `CHAIN_WATCHDOG_MAX_RESTARTS`)
- Enforces cooldown between attempts (default 120s, via `CHAIN_WATCHDOG_COOLDOWN_MS`)
- Emits events: `chainRestarted`, `chainRestartFailed`, `chainRestartExhausted`
- Uses `timer.unref()` to not prevent process exit

#### 2.3 Per-Chain Degradation Tracking
Track per-chain degradation state and integrate with the existing `GracefulDegradationManager` (ADR-007):
- Mark chains as degraded on error via `chainDegradedState` Set
- Auto-recover when chain status changes to `'connected'` — clear degradation state and reset restart counter
- Call `degradationManager.forceRecovery()` on chain recovery
- Expose `getChainHealthSummary()` API returning per-chain health status, restart attempts, and degradation state

## Rationale

### Why Bulkhead Isolation + Health Watchdog?

Five approaches were evaluated:

| Approach | Pros | Cons | Verdict |
|----------|------|------|---------|
| **A. Bulkhead Isolation** | Minimal code change, per-chain error boundaries | Doesn't auto-recover dead chains | **Selected** (combined) |
| **B. Process-per-chain** | True OS-level isolation | Breaks SharedArrayBuffer PriceMatrix (ADR-005), 14x memory overhead | Rejected |
| **C. Worker threads per chain** | Good isolation, shared memory possible | Massive refactoring, IPC overhead on hot path | Rejected |
| **D. Supervision tree (Erlang-style)** | Auto-restart, battle-tested pattern | Over-engineered for Node.js EventEmitter model | Rejected |
| **E. Health Watchdog** | Auto-detects and restarts dead chains | Reactive only, doesn't prevent initial crash | **Selected** (combined) |

**Process-per-chain** was rejected primarily because it breaks ADR-005's SharedArrayBuffer PriceMatrix — the L1 cache requires shared memory across chains for O(1) cross-chain price lookups on the hot path.

**Worker threads** were rejected because the ChainDetectorInstance uses EventEmitter extensively and the refactoring scope (2-3 weeks) was disproportionate to the risk.

The combination of A+E provides comprehensive protection: bulkheads prevent cascading crashes (proactive), and the watchdog restarts dead chains (reactive).

### Why Not Per-Chain Rejection Tracking?

The `unhandledRejection` handler receives a `reason` (Error) that doesn't reliably contain chain context. Attempting to parse chain IDs from error messages or stack traces would be fragile. Instead:
1. Phase 1's error boundaries prevent most chain-specific rejections from becoming unhandled
2. The raised threshold (15) provides sufficient buffer for transient issues
3. The watchdog handles actual chain failures at a higher level

### Why Watchdog Cooldown?

Without a cooldown, a chain that fails immediately on restart would be retried every 30 seconds, wasting resources and spamming logs. The 120-second cooldown with max 5 attempts means a permanently broken chain stops retrying after ~10 minutes, at which point the `chainRestartExhausted` event signals operators.

## Consequences

### Positive
- **Single chain failure cannot crash a partition** — error boundaries contain all propagation paths
- **Automatic recovery** — dead chains are automatically restarted without operator intervention
- **Observable degradation** — per-chain health summary exposes restart attempts and degradation state
- **Zero hot-path impact** — all changes are in error paths or periodic timers, not the detection pipeline
- **Backward compatible** — no API changes, no architecture changes, existing tests pass unchanged
- **Configurable** — all thresholds configurable via env vars for production tuning

### Negative
- **Delayed failure detection** — chains may be dead for up to 30 seconds before watchdog detects them (configurable)
- **Restart may fail** — some failures (e.g., revoked API key) cannot be fixed by restart; the max-attempts limit prevents infinite loops
- **Added complexity** — ~200 lines of watchdog logic in ChainInstanceManager

### Neutral
- **Degraded mode operation** — a partition running with 4/7 chains is strictly less capable than 7/7, but better than 0/7
- **Log volume** — watchdog restart attempts generate info/warn logs; operators should monitor `chainRestartExhausted` events

## Implementation

### Files Modified

| File | Change |
|------|--------|
| `shared/core/src/partition/runner.ts` | Conditional `process.exit(1)`, duplicate listener guard |
| `services/coordinator/src/coordinator.ts` | try/catch around `initializeCexFeed()` with alert |
| `shared/core/src/feeds/cex-price-feed-service.ts` | Default `'error'` listener in constructor |
| `services/unified-detector/src/chain-instance-manager.ts` | Error boundaries, health watchdog, per-chain degradation, `getChainHealthSummary()` |
| `shared/core/src/partition/handlers.ts` | Configurable rejection threshold (5 -> 15) |

### Configuration

| Env Var | Default | Min | Description |
|---------|---------|-----|-------------|
| `UNHANDLED_REJECTION_THRESHOLD` | 15 | 1 | Max unhandled rejections in 60s window before shutdown |
| `CHAIN_WATCHDOG_INTERVAL_MS` | 30000 | 5000 | Health watchdog check interval |
| `CHAIN_WATCHDOG_MAX_RESTARTS` | 5 | 1 | Max restart attempts per chain |
| `CHAIN_WATCHDOG_COOLDOWN_MS` | 120000 | 10000 | Cooldown between restart attempts for same chain |

### Events Emitted (ChainInstanceManager)

| Event | Payload | When |
|-------|---------|------|
| `chainRecovered` | `{ chainId }` | Chain status changes from error/disconnected to connected |
| `chainRestarted` | `{ chainId, attempt }` | Watchdog successfully restarted a chain |
| `chainRestartFailed` | `{ chainId, attempt, reason }` | Watchdog restart attempt failed |
| `chainRestartExhausted` | `{ chainId, attempts }` | Chain exhausted all restart attempts |

### New API

```typescript
interface ChainHealthSummary {
  chainId: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  restartAttempts: number;
  lastRestartAttempt: number | null;
  isDegraded: boolean;
}

// On ChainInstanceManager
getChainHealthSummary(): ChainHealthSummary[];
```

## Alternatives Considered

### 1. Kubernetes Liveness Probes Only
- **Rejected**: K8s restarts the entire pod, killing all healthy chains. Our approach restarts only the failed chain.

### 2. External Process Manager (PM2, systemd)
- **Rejected**: Same problem as K8s — restarts the entire process. Also adds operational dependency outside the application.

### 3. Watchdog-Only (No Bulkheads)
- **Rejected**: Without error boundaries, a chain error can still crash the process before the watchdog runs. Both layers are needed.

### 4. Per-Chain Circuit Breakers
- **Considered for future**: Per-chain circuit breakers (ADR-018 pattern) could rate-limit restart attempts more intelligently. The current max-attempts + cooldown approach is simpler and sufficient.

## Testing

- **313 tests pass** (Phase 1) + **261 tests pass** (Phase 2), 0 regressions
- Existing test suites validated: partition-service-parameterized (67), partition-service (P1/P2/P3: 92), chain-instance-manager (16), cex-price-feed-service (29), partition-service-utils (86), chain-group-routing (23)
- Watchdog integration testing requires multi-chain E2E setup (deferred to Phase 3)

## Related ADRs

| ADR | Relationship |
|-----|-------------|
| [ADR-003](./ADR-003-partitioned-detectors.md) | Partition architecture that co-locates chains — the source of cascading risk |
| [ADR-005](./ADR-005-hierarchical-cache.md) | SharedArrayBuffer PriceMatrix — reason process-per-chain was rejected |
| [ADR-007](./ADR-007-failover-strategy.md) | Graceful degradation levels — integrated for per-chain recovery |
| [ADR-010](./ADR-010-websocket-resilience.md) | Connection-level resilience — this ADR adds process-level resilience on top |
| [ADR-018](./ADR-018-circuit-breaker.md) | Circuit breaker for external calls — complementary to bulkhead isolation |
| [ADR-036](./ADR-036-cex-price-signals.md) | CEX feed whose failure is now isolated from coordinator startup |

## Confidence Level

92% — High confidence based on:
- All 7 identified crash vectors addressed with targeted fixes
- Industry-standard bulkhead isolation pattern (Netflix Hystrix, Resilience4j)
- Health watchdog is a proven pattern in distributed systems (Consul, Kubernetes kubelet)
- Zero regressions across 574 existing tests
- All changes are in error/recovery paths, not hot path (<50ms target unaffected)

Risk factors:
- Watchdog restart may not help for persistent infrastructure issues (e.g., blocked ports)
- Degraded partitions running at reduced chain coverage need monitoring
- Per-chain restart resubscribes to WebSocket events — brief data gap during restart window
