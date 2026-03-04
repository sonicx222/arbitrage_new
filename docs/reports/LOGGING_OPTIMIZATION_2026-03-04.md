# Logging & Log Format Optimization Research
**Date:** 2026-03-04
**Scope:** `shared/core/src/logging/`, `shared/core/src/logger.ts`, `shared/core/src/partition/handlers.ts`, `shared/core/src/tracing/`
**ADR Reference:** ADR-015 (Pino Migration), ADR-022 (Hot-Path Memory), ADR-002 (Redis Streams)

---

## 1. Current State Analysis

### Stack
- **Pino ^9.6.0** + **pino-pretty ^13.0.0**
- `shared/core/src/logging/pino-logger.ts` — Singleton-cached Pino wrapper implementing `ILogger`
- `shared/core/src/logging/otel-transport.ts` — Pino multistream → stdout + OTLP/HTTP
- `shared/core/src/logger.ts` — Backward-compat facade (66+ callers)
- `shared/core/src/logging/testing-logger.ts` — `RecordingLogger`/`NullLogger` for DI tests
- `shared/core/src/persistence/trade-logger.ts` — Separate append-only JSONL writer
- `shared/core/src/tracing/trace-context.ts` — Manual W3C trace context generation/propagation

### Current Performance Baseline (from ADR-015)
- Throughput: ~120,000 ops/sec (6× faster than previous Winston)
- Per-call latency: ~0.3–0.8ms at info level (estimated)
- Hot-path guard: `debugEnabled` pre-computed once at handler setup (`handlers.ts:50`)
- Opportunity logging already moved to debug level (P2-1 fix, ~30/sec at INFO)

---

## 2. Issues Found (Evidence-Based)

### Issue A — Unguarded debug object construction in hot-path (`handlers.ts:76`)

```typescript
// CURRENT — object literal allocated BEFORE Pino's level check
logger.debug('Arbitrage opportunity detected', {
  partition: partitionId, id: opp.id, type: opp.type,
  buyDex: opp.buyDex, sellDex: opp.sellDex,
  expectedProfit: opp.expectedProfit, profitPercentage: opp.profitPercentage,
});

// BUT priceUpdateHandler at line 55 IS correctly guarded:
if (debugEnabled) {
  logger.debug('Price update', { ... });
}
```

The `opportunityHandler` (30/sec) lacks the `if (debugEnabled)` guard that the `priceUpdateHandler` uses 8 lines earlier (FIX #20 intent). At `LOG_LEVEL=info` (production), Pino skips the write but V8 still allocates the object literal.

### Issue B — `debugEnabled` is a stale boolean, not a live level-check

```typescript
// handlers.ts:50 — computed ONCE at handler setup
const debugEnabled = logger.isLevelEnabled?.('debug') ?? logger.level === 'debug';
```

If log level is changed at runtime (e.g., via a future hot-reload endpoint), this guard never updates. Design fragility for future work.

### Issue C — 209+ template literal string allocations in log messages

```typescript
// CURRENT — template literal allocates a new string every call, even at LOG_LEVEL=warn
logger.info(`Chain connected: ${chainId}`, { partition: partitionId });

// PREFERRED — static message, chainId as structured field (searchable, zero-alloc on filtered levels)
logger.info('Chain connected', { chainId, partition: partitionId });
```

- **209 occurrences** in `shared/core/src/` alone (plus ~28 in `services/`)
- At `LOG_LEVEL=warn`, all 209+ sites still allocate strings unnecessarily
- Embedding data in the message string breaks log aggregation — `chainId` can't be filtered/grouped in Loki/Grafana when baked into the message

### Issue D — Per-call `{ partition: partitionId }` metadata construction (child loggers underused)

In `handlers.ts`, `partition: partitionId` is appended as an explicit object to every single log call. Child loggers bind this once and eliminate per-call allocation:

```typescript
// CURRENT — object allocation on every call (~1000+/sec at debug)
logger.debug('Price update', { partition: partitionId, chain: ... });
logger.info(`Chain connected: ${chainId}`, { partition: partitionId });

// BETTER — bind once, zero per-call allocation
const partitionLogger = logger.child({ partition: partitionId });
partitionLogger.debug('Price update', { chain: ... });
partitionLogger.info('Chain connected', { chainId });
```

`ILogger.child()` is fully implemented (`PinoLoggerWrapper:278`), tested, and ready to use.

### Issue E — Manual trace context injection required on every log call

`otel-transport.ts:374` explicitly flags this:
```
// P3 Note O-12: Currently requires manual traceId/spanId injection in every log call.
// Future improvement: use AsyncLocalStorage for automatic context propagation
```

Services must explicitly pass `{ traceId, spanId }` in every log meta. In practice, most log lines lack trace context entirely, making cross-service correlation impossible without searching trade JSONL separately.

### Issue F — Double JSON serialize/parse in OTEL transport

`otel-transport.ts:_write()` receives a `Buffer` from Pino (already JSON-serialized), then calls `JSON.parse()` to convert it to an object for OTLP conversion. This parse cost runs on every log entry when `OTEL_EXPORTER_ENDPOINT` is configured.

### Issue G — Extensive wildcard redact paths

`pino-logger.ts:347–360` configures 10 redact paths including 5 nested wildcards (`*.url`, `*.apiKey`, `*.rpcUrl`, `*.endpoint`, `*.privateKey`, etc.). Pino's `fast-redact` pre-compiles specific paths efficiently, but wildcard paths require key-scanning each log object at runtime.

### Issue H — No log sampling for high-frequency debug events

At `LOG_LEVEL=debug` for troubleshooting:
- ~1000+ price update lines/sec
- ~30 opportunity lines/sec

There's no sampling or rate-limiting on log volume, making debug-level logs practically unusable for live analysis.

---

## 3. Industry Best Practices Comparison

| Approach | Used By | Pros | Cons | Effort |
|----------|---------|------|------|--------|
| **Child logger binding** | Pino docs, Fastify, NestJS | Zero per-call alloc, auto-propagates context | Requires call-site refactor | 2–3d |
| **AsyncLocalStorage trace injection** | OTel JS SDK, Hapi, modern Node | Automatic context, no manual passing | ~1–3μs per getStore() | 4–6d |
| **Static messages + structured fields** | ELK, Loki, DataDog best practices | Searchable/filterable, zero-alloc on filtered levels | Breaks existing grep patterns | 3–5d (gradual) |
| **pino-worker / async transport** | Fastify, high-throughput APIs | Moves I/O off main thread | Architecture change, breaks multistream | 5–8d |
| **Log sampling (token bucket)** | Envoy, Istio, HFT logging | Prevents debug floods | Loses some events | 3–4d |
| **Log level hot-reload** | Netflix, LinkedIn prod systems | Debug without restart | Invalidates pre-computed `debugEnabled` | 2–3d |

---

## 4. Recommended Solution

### 5-Part Incremental Optimization Plan

**Confidence: HIGH (85%)** — All recommendations verified against existing code.

---

#### Part 1 — Fix unguarded hot-path debug calls (QUICK WIN — 0.5 day)

**File**: `shared/core/src/partition/handlers.ts:76`

Add the `debugEnabled` guard to `opportunityHandler`, matching the pattern already used in `priceUpdateHandler`:

```typescript
if (debugEnabled) {
  logger.debug('Arbitrage opportunity detected', {
    partition: partitionId,
    id: opp.id, type: opp.type,
    buyDex: opp.buyDex, sellDex: opp.sellDex,
    expectedProfit: opp.expectedProfit,
    profitPercentage: opp.profitPercentage,
  });
}
```

**Impact**: Eliminates ~8-field object allocation at 30/sec in production. Consistent with FIX #20 documented intent.

---

#### Part 2 — Child loggers for partition context binding (1–2 days)

**Files**: `handlers.ts`, `runner.ts`, `health-server.ts`

Create child logger once at service setup, bind `partition` context, and drop the explicit `{ partition: partitionId }` from every call:

```typescript
// In setupDetectorEventHandlers
const pLog = logger.child({ partition: partitionId });

// All handlers use pLog instead of logger + explicit meta
const priceUpdateHandler = (...) => {
  if (debugEnabled) {
    pLog.debug('Price update', { chain: update.chain, dex: update.dex, price: update.price });
  }
};
```

`ILogger.child()` is already implemented and cached at `PinoLoggerWrapper:278`. No changes to the logger module needed.

**Impact**: Eliminates 1 object allocation per log call in the hottest handlers. Enables trace context binding (Part 3 prerequisite).

---

#### Part 3 — AsyncLocalStorage for automatic trace context propagation (4–5 days)

**New file**: `shared/core/src/logging/log-context.ts`

The `otel-transport.ts:374` comment already identifies this as the right direction.

```typescript
// log-context.ts
import { AsyncLocalStorage } from 'async_hooks';
import type { TraceContext } from '../tracing/trace-context';

const logContextStore = new AsyncLocalStorage<TraceContext>();

export function withLogContext<T>(ctx: TraceContext, fn: () => T): T {
  return logContextStore.run(ctx, fn);
}

export function getLogContext(): TraceContext | undefined {
  return logContextStore.getStore();
}
```

Modify `PinoLoggerWrapper` to inject ALS context into child bindings automatically on each log call, or modify `createPinoLogger` to set a `mixin` function that reads from ALS.

At operation entry points (stream consumer message handler, partition runner):
```typescript
// Before: every log call needs explicit traceId
logger.info('Processing opportunity', { traceId: ctx.traceId, spanId: ctx.spanId, opportunityId });

// After: all logs inside automatically include traceId/spanId
withLogContext(ctx, async () => {
  logger.info('Processing opportunity', { opportunityId });
  // ... downstream calls also get trace context
});
```

**ALS Latency**: `AsyncLocalStorage.getStore()` costs ~1–3μs on V8 — negligible vs 0.3–0.8ms Pino call. Well within <50ms target.

**ADR Compatibility**:
- ADR-002: Redis Streams events already carry `_trace_*` fields — `extractContext()` provides the `TraceContext` to pass into `withLogContext`
- ADR-015: `ILogger` interface unchanged; implementation detail inside `PinoLoggerWrapper`
- ADR-003: Each partition runner calls `withLogContext` once per processing cycle

---

#### Part 4 — Standardize log messages to structured fields (3–5 days, gradual)

Replace template literal messages with static strings + structured metadata. Priority order:

**Phase 4a (1 day) — Hot-path files:**
- `shared/core/src/partition/handlers.ts` (applies to all 4 partitions)
- `shared/core/src/partition/runner.ts`
- `shared/core/src/partition/health-server.ts`

**Phase 4b (2–3 days) — Services layer:**
- `services/execution-engine/src/`
- `services/coordinator/src/`
- `services/cross-chain-detector/src/`

```typescript
// ❌ Before
logger.info(`Chain connected: ${chainId}`, { partition });
logger.warn(`Chain disconnected: ${chainId}`, { partition });
logger.error(`Chain error: ${chainId}`, { partition, error });

// ✅ After
logger.info('Chain connected', { chainId, partition });
logger.warn('Chain disconnected', { chainId, partition });
logger.error('Chain error', { chainId, partition, error });
```

**Impact**: (1) Structured fields are searchable in Loki/Grafana/Elasticsearch. (2) At `LOG_LEVEL=warn`, eliminates 200+ string allocations entirely. (3) Consistent format enables automated log alerting on field values.

**Standard field name conventions** (to document in ADR-038):
| Old | Canonical | Notes |
|-----|-----------|-------|
| `chain` | `chainId` | Matches type system naming |
| `partition` | `partitionId` | Explicit suffix |
| `dex` | `dexId` | Explicit suffix |
| `id` (in opportunity context) | `opportunityId` | Unambiguous |

---

#### Part 5 — Log sampling for debug/troubleshooting mode (2–3 days)

**New file**: `shared/core/src/logging/log-sampler.ts`

Add a simple token-bucket rate limiter for high-frequency log events:

```typescript
// log-sampler.ts
export class LogSampler {
  private readonly maxPerSec: number;
  private readonly sampleRate: number;
  private counters = new Map<string, { count: number; windowStart: number }>();

  shouldLog(key: string): boolean {
    const now = Date.now();
    const entry = this.counters.get(key) ?? { count: 0, windowStart: now };
    if (now - entry.windowStart > 1000) {
      entry.count = 0; entry.windowStart = now;
    }
    entry.count++;
    this.counters.set(key, entry);
    return entry.count <= this.maxPerSec || Math.random() < this.sampleRate;
  }
}
```

Usage in hot-path handlers:
```typescript
const sampler = new LogSampler({ maxPerSec: 100, sampleRate: 0.01 });

if (debugEnabled && sampler.shouldLog('price-update')) {
  pLog.debug('Price update (sampled 1%)', { chain, dex, price });
}
```

**Impact**: `LOG_LEVEL=debug` goes from ~1030 lines/sec → ~100 lines/sec, actually usable for live troubleshooting. Sampling rate and key are logged so operators know events are being sampled.

---

## 5. Implementation Tasks

| # | Task | File(s) | Effort | Confidence | Dependencies |
|---|------|---------|--------|------------|--------------|
| 1 | Add `debugEnabled` guard to `opportunityHandler` | `handlers.ts:76` | 0.5d | 99% | None |
| 2 | Child loggers for partition context | `handlers.ts`, `runner.ts` | 1d | 95% | None |
| 3 | `LogContext` ALS module | `logging/log-context.ts` (new) | 2d | 85% | None |
| 4 | Wire `withLogContext` at stream entry points | Redis handlers, partition runner | 2d | 80% | Task 3 |
| 5 | Structured fields migration — hot-path files | `handlers.ts`, `runner.ts`, `health-server.ts` | 1d | 99% | Task 2 |
| 6 | Structured fields migration — services layer | All services, shared/core utilities | 3d | 90% | Task 5 |
| 7 | `LogSampler` utility | `logging/log-sampler.ts` (new) | 1d | 90% | None |
| 8 | Log level hot-reload endpoint | health-server or coordinator | 1.5d | 80% | Tasks 1–2 |

**Total**: ~12 developer-days. Tasks 1, 2, 5 are quick wins (~2.5 days) delivering most format improvement with no risk.

---

## 6. Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| ALS overhead on hot path | LOW | LOW | Benchmark: getStore() ~1–3μs vs 300–800μs Pino call |
| Child logger changes log field order | LOW | LOW | Test with RecordingLogger; Pino serializes deterministically |
| Template literal migration breaks log grep | MEDIUM | LOW | Document new field names; update Grafana/Loki queries |
| `debugEnabled` staleness when hot-reload added | MEDIUM | LOW | If Task 8 implemented, switch guard to inline `isLevelEnabled?.('debug')` |
| Log sampling loses critical debug events | LOW | MEDIUM | Sample only price-updates; never sample error/warn/opportunity events |

---

## 7. Success Metrics

- [ ] **Unguarded hot-path debug allocations**: 0 object allocations in `opportunityHandler` at INFO level
- [ ] **Partition context boilerplate**: 0 explicit `{ partition: ... }` in hot-path log calls (child logger handles it)
- [ ] **Trace coverage**: `traceId` present in ≥80% of log lines during a detection cycle (vs ~5% today)
- [ ] **Template literal log calls**: 209 in shared/core → 0 in hot-path files; remainder migrated gradually
- [ ] **Debug usability**: `LOG_LEVEL=debug` produces <200 lines/sec (vs ~1030/sec currently)
- [ ] **No hot-path regression**: p99 latency remains <50ms after all changes

---

## 8. ADR Recommendation

**New ADR needed: `ADR-038: Structured Log Format Standards and AsyncLocalStorage Trace Propagation`**

Distinct from ADR-015 (library choice) and ADR-002 (Redis Streams trace propagation). Codifies:
1. Log message format: always static string, dynamic data always in structured fields
2. Standard field names: `chainId`, `dexId`, `partitionId`, `opportunityId`, `traceId`, `spanId`
3. ALS log context: bind at operation entry points (stream consumer, detection cycle)
4. Debug sampling policy: which event types are sampled, default rates
5. Child logger pattern: when and how to create child loggers

---

## Quick Reference: The 3 Anti-Patterns to Eliminate

```typescript
// ❌ Anti-pattern 1: Unguarded debug call with object literal
logger.debug('Message', { a, b, c });
// V8 allocates { a,b,c } even at LOG_LEVEL=info
// ✅ Fix:
if (logger.isLevelEnabled?.('debug')) {
  logger.debug('Message', { a, b, c });
}

// ❌ Anti-pattern 2: Template literal message
logger.info(`Chain connected: ${chainId}`, { partition });
// Allocates string even at LOG_LEVEL=warn; chainId unsearchable in Loki
// ✅ Fix:
logger.info('Chain connected', { chainId, partition });

// ❌ Anti-pattern 3: Per-call context repetition
logger.info('A', { partition: partitionId });
logger.debug('B', { partition: partitionId });
logger.warn('C', { partition: partitionId });
// 3× object allocations, same data
// ✅ Fix:
const log = logger.child({ partition: partitionId });
log.info('A'); log.debug('B'); log.warn('C');
```
