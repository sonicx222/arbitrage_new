# Deep Analysis: Detection → Data Flow → Execution Pipeline

**Date**: 2026-03-06
**Scope**: `services/unified-detector/`, `services/coordinator/`, `services/execution-engine/`, `shared/core/src/redis/`
**Method**: 6-agent parallel analysis + team lead direct audit
**Grade**: **B+** (0 Critical, 3 High, 4 Medium, 6 Low — 13 total findings)

---

## Executive Summary

The detection-to-execution pipeline is architecturally sound with strong fundamentals: 4-layer dedup, HMAC-signed streams, O(1) queue operations, backpressure coupling, and comprehensive validation. However, three HIGH findings affect operational correctness:

1. **Infinite loop in per-chain concurrency gating** — blocks event loop permanently when enabled
2. **Chain resolution mismatch** — circuit breaker and per-chain limits bypass for same-chain arbs
3. **Profit slippage metric unit mismatch** — slippage always reads ~100% due to wei/ETH confusion

All 3 are in the execution pipeline, the most performance-critical path in the system.

---

## Critical Findings (P0)

*None found.*

---

## High Findings (P1)

### H-001: Infinite loop in per-chain concurrency gating

| Field | Value |
|-------|-------|
| **File** | `services/execution-engine/src/execution-pipeline.ts:206-214` |
| **Agent(s)** | Team Lead |
| **Confidence** | HIGH (100%) — synchronous loop, deterministic |
| **Score** | 4.6 (Impact: 5, Effort: 1, Risk: 1) |

**Bug**: When `MAX_CONCURRENT_PER_CHAIN > 0` (env-controlled, default 0) and all queued items are for chains at per-chain capacity, `processQueueItems()` enters an infinite synchronous loop:

```typescript
// Line 206-214
const maxPerChain = this.deps.maxConcurrentPerChain ?? 0;
if (maxPerChain > 0) {
  const chainCount = this.perChainExecutionCount.get(oppChain) ?? 0;
  if (chainCount >= maxPerChain) {
    this.deps.queueService.enqueue(opportunity);  // put it back
    continue;  // loop forever
  }
```

The while loop dequeues items, re-enqueues them (FIFO), and continues. Since `activeExecutionCount` never changes (no execution launched) and `size() > 0` (items re-enqueued), the loop condition remains true forever. The `.finally()` callbacks that would decrement per-chain counts are microtasks that can **never** execute because the synchronous loop never yields.

**Impact**: Complete event loop blockage. No executions complete. Process must be killed. Only triggers when `MAX_CONCURRENT_PER_CHAIN > 0` AND all queued items are for capacity-limited chains.

**Suggested Fix**: Track consecutive re-enqueues and break when all items were skipped:
```typescript
let skippedThisPass = 0;
const initialSize = this.deps.queueService.size();
// ... in the per-chain check:
if (chainCount >= maxPerChain) {
  this.deps.queueService.enqueue(opportunity);
  skippedThisPass++;
  if (skippedThisPass >= initialSize) break; // all items at capacity
  continue;
}
skippedThisPass = 0; // reset on successful dispatch
```

---

### H-002: Chain resolution inconsistency between queue processing and execution

| Field | Value |
|-------|-------|
| **File** | `services/execution-engine/src/execution-pipeline.ts:174` vs `:404` |
| **Agent(s)** | Team Lead |
| **Confidence** | HIGH (95%) — code paths verified |
| **Score** | 4.0 (Impact: 4, Effort: 1, Risk: 1) |

**Bug**: Two different chain resolution strategies in the same class:

```typescript
// Line 174 (processQueueItems — CB check, per-chain tracking):
const oppChain = opportunity.buyChain || 'unknown';

// Line 404 (executeOpportunity — metrics, risk, CB recording):
const resolvedBuyChain = opportunity.buyChain ?? opportunity.chain;
```

For same-chain arbitrage (the majority), `buyChain` is `undefined` and `chain` is set (e.g., `'arbitrum'`):
- **Line 174**: `oppChain = undefined || 'unknown'` → `'unknown'`
- **Line 404**: `resolvedBuyChain = undefined ?? 'arbitrum'` → `'arbitrum'`

**Impact**:
1. **Circuit breaker bypass**: `canExecute('unknown')` is always true because `recordFailure('arbitrum')` stores under the real chain. Same-chain arbs are never blocked by CB.
2. **Per-chain limits ineffective**: All same-chain arbs pool under `'unknown'` instead of their actual chain. A single busy chain can still starve others.
3. **Stats divergence**: CB records success/failure under real chain but checks under `'unknown'`.

**Suggested Fix**: Align line 174 to use the same resolution:
```typescript
const oppChain = opportunity.buyChain ?? opportunity.chain ?? 'unknown';
```

---

### H-003: Profit slippage metric unit mismatch

| Field | Value |
|-------|-------|
| **File** | `services/execution-engine/src/execution-pipeline.ts:594` |
| **Agent(s)** | Team Lead |
| **Confidence** | HIGH (90%) — traced from detector to pipeline |
| **Score** | 3.4 (Impact: 3, Effort: 1, Risk: 1) |

**Bug**: The slippage calculation mixes raw token units with ETH:

```typescript
// Line 594
const slippagePct = ((opportunity.expectedProfit - result.actualProfit / 1e18)
  / Math.abs(opportunity.expectedProfit)) * 100;
```

- `opportunity.expectedProfit` = `Number(amountIn) * netProfitPct` (from detector line 264) = raw units × decimal = raw units (e.g., 3e12 for 0.003 ETH profit)
- `result.actualProfit / 1e18` = wei → ETH conversion = e.g., 0.0025

Subtraction: `3e12 - 0.0025 ≈ 3e12`. Slippage: `(3e12 / 3e12) × 100 = 100%` always.

**Impact**: The `arbitrage_profit_slippage_percent` metric is useless — always shows ~100%. Any dashboards or alerts based on it produce false data.

**Suggested Fix**: Use consistent units (both in raw, since they cancel in the ratio):
```typescript
const slippagePct = opportunity.expectedProfit !== 0
  ? ((opportunity.expectedProfit - result.actualProfit) / Math.abs(opportunity.expectedProfit)) * 100
  : 0;
```
Or if `actualProfit` is confirmed to be in a different unit than `expectedProfit`, normalize both.

---

## Medium Findings (P2)

### M-001: CB re-enqueue loop can block event loop for extended periods

| Field | Value |
|-------|-------|
| **File** | `services/execution-engine/src/execution-pipeline.ts:175-199` |
| **Confidence** | MEDIUM (80%) |

The circuit breaker re-enqueue path has a bounded loop (MAX_CB_REENQUEUE_ATTEMPTS = 3), but with a large queue (e.g., 5000 items all for CB-tripped chains), the loop processes `5000 × 3 = 15000` iterations synchronously before dropping all items. Each iteration involves Map lookups, size checks, and queue operations. On commodity hardware, this could take 50-200ms, blocking the event loop.

**Suggested Fix**: Add a `maxSynchronousProcessing` counter that breaks after N items and uses `setImmediate` to yield:
```typescript
if (++itemsProcessedThisPass >= MAX_SYNC_BATCH) {
  setImmediate(() => this.processQueueItems());
  break;
}
```

### M-002: Simulation strategy defaults to 'ethereum' for all chains

| Field | Value |
|-------|-------|
| **File** | `services/execution-engine/src/strategies/simulation.strategy.ts:48` |
| **Confidence** | MEDIUM (75%) |

```typescript
const chain = opportunity.buyChain || 'ethereum';
```

For Solana or other non-EVM opportunities in simulation mode, this defaults to `'ethereum'`. Simulation metrics, wallet lookups, and provider checks are done against the wrong chain.

**Suggested Fix**: `opportunity.buyChain ?? opportunity.chain ?? 'unknown'`

### M-003: Static `warnedSchemaVersions` Set in StreamConsumer is never cleared

| Field | Value |
|-------|-------|
| **File** | `shared/core/src/redis/stream-consumer.ts:144` |
| **Confidence** | MEDIUM (70%) |

```typescript
private static readonly warnedSchemaVersions = new Set<string>();
```

This is a `static` Set shared across all StreamConsumer instances. It grows monotonically and is never cleared, even across service restarts (within the same process). In long-running processes, if schema versions change frequently, this Set grows without bound.

**Impact**: Minor memory leak. Practically limited since schema versions are rare.

**Suggested Fix**: Add a `static reset()` method or bound the Set size.

### M-004: DLQ consumer auto-recovery replays to EXECUTION_REQUESTS without re-validating TTL

| Field | Value |
|-------|-------|
| **File** | `services/execution-engine/src/consumers/dlq-consumer.ts:89-93` |
| **Confidence** | MEDIUM (70%) |

When `autoRecoveryEnabled = true`, the DLQ consumer replays messages back to the main stream. However, the replayed opportunity may have expired since being DLQ'd. The execution engine will re-validate and re-reject it, creating a DLQ → replay → DLQ loop until the 5-minute cooldown expires.

**Suggested Fix**: Check `expiresAt` before replaying. Skip expired messages during auto-recovery.

---

## Low Findings (P3)

### L-001: `buyChain || 'unknown'` uses `||` instead of `??` (code convention violation)

| File | Lines |
|------|-------|
| `execution-pipeline.ts` | 174, 418 |
| `flash-loan.strategy.ts` | 720 |
| `simulation.strategy.ts` | 48, 49 |

Multiple occurrences of `|| 'unknown'` or `|| 'ethereum'` for string fields. While empty strings aren't valid chain IDs (so behavior is correct), the code convention mandates `??` for consistency.

### L-002: `as unknown as Record<string, unknown>` cast for trace context

| File | `execution-pipeline.ts:268-269` |
|------|------|

```typescript
const traceId = (opportunity as unknown as Record<string, unknown>)._traceId as string | undefined;
```

This double-cast bypasses type safety. The `_traceId` and `_spanId` fields should be declared in the `ArbitrageOpportunity` type (or a pipeline-internal extended type) for proper typing.

### L-003: `opportunityId` vs `id` inconsistency in log metadata

| File | `execution-pipeline.ts` |
|------|------|

Some log calls use `{ opportunityId: opportunity.id }` (lines 179, 380, 641) while others use `{ id: opportunity.id }` (lines 295, 299, 480). Inconsistent field names make log querying harder.

### L-004: `VALID_OPPORTUNITY_TYPES` allows types without dedicated strategies

| File | `consumers/validation.ts:149-172` |
|------|------|

Types like `'intra-solana'`, `'intra-chain'`, `'predictive'` pass validation but have no dedicated strategy — they fall through to IntraChainStrategy as default. While documented as intentional, this means the validation doesn't catch genuinely invalid types that happen to match legacy names.

### L-005: `getDefaultPrice()` fallback in cross-chain strategy

| File | `cross-chain.strategy.ts:177` |
|------|------|

```typescript
const priceUsd = getDefaultPrice(tokenSymbol);
```

For tokens not in the default price list, this returns 0 or a hardcoded value. The function is used for token value estimation in bridge cost calculations. Incorrect prices would lead to incorrect profitability assessments.

### L-006: Opportunity object mutation in executeOpportunity

| File | `execution-pipeline.ts:398-400, 656-658` |
|------|------|

```typescript
const ts = opportunity.pipelineTimestamps ?? {};
ts.executionStartedAt = Date.now();
opportunity.pipelineTimestamps = ts;
```

The opportunity object is mutated in-place during execution. While this works for single-threaded execution, it makes the code harder to reason about and test. If the same opportunity object were shared (e.g., during parallel execution or test reuse), mutations would leak.

---

## Test Coverage Gaps (Notable)

| Source File | Method | Coverage Status |
|------------|--------|----------------|
| `execution-pipeline.ts` | `processQueueItems()` per-chain gating | **Not tested** with `maxConcurrentPerChain > 0` |
| `execution-pipeline.ts` | Infinite loop scenario (H-001) | **Not tested** |
| `execution-pipeline.ts` | Profit slippage calculation | **Not tested** for unit correctness |
| `fast-lane.consumer.ts` | DLQ routing on handler failure | Limited coverage |
| `dlq-consumer.ts` | Auto-recovery replay loop | Limited coverage |
| `stream-consumer.ts` | NOGROUP recovery path | Tested (regression test exists) |
| `opportunity-router.ts` | simulationTtlMultiplier logic | Limited coverage |

---

## Architecture Assessment

### Strengths
- **4-layer dedup**: Content hash (consumer) → ID-based (consumer) → Redis lock (pipeline) → opportunity map (router)
- **Backpressure coupling**: Queue high/low water marks → stream consumer pause/resume → prevents memory exhaustion
- **O(1) operations**: CircularBuffer queue, Map-based tracking, Set-based type validation
- **Comprehensive validation**: Structural + business rules + cross-chain field validation in separate module
- **Clean strategy pattern**: Factory with type-safe resolution, easy to extend

### Areas for Improvement
- Per-chain concurrency feature (H-001) needs loop-breaking safety
- Chain resolution should be unified in a single helper function (H-002)
- Profit/slippage metrics need unit normalization pass (H-003)
- Consider adding `maxSynchronousItems` safety to the queue processing loop (M-001)

---

## Recommended Action Plan

### Phase 1: Immediate (3 HIGH findings — fix before enabling per-chain feature)
- [ ] **H-001**: Add loop-breaking safety to per-chain concurrency gating
- [ ] **H-002**: Unify chain resolution: `opportunity.buyChain ?? opportunity.chain ?? 'unknown'`
- [ ] **H-003**: Fix slippage calc: `(expected - actual) / |expected|` without asymmetric conversion

### Phase 2: Next Sprint (4 MEDIUM findings)
- [ ] **M-001**: Add synchronous batch limit to CB re-enqueue loop
- [ ] **M-002**: Fix simulation strategy chain default
- [ ] **M-003**: Bound static `warnedSchemaVersions` Set
- [ ] **M-004**: Add TTL check before DLQ auto-recovery replay

### Phase 3: Backlog (6 LOW findings)
- [ ] **L-001** through **L-006**: Code convention cleanups and minor improvements

---

*Report generated by 6-agent deep analysis team + team lead direct audit.*
*Analysis covered 90+ source files across 4 services and 1 shared package.*
