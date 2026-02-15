# Deep Analysis: `shared/core/src/data-structures/`

**Date:** 2026-02-15
**Agents:** 6 (architecture-auditor, bug-hunter, security-auditor, test-quality-analyst, mock-fidelity-validator, performance-refactor-reviewer)
**Files Analyzed:** 4 source files + 1 index + 4 test files + all consumers across codebase

---

## Executive Summary

- **Total findings:** 22 (0 Critical, 4 High, 11 Medium, 7 Low)
- **Top 3 highest-impact issues:**
  1. NaN input permanently poisons NumericRollingWindow sum, silently disabling circuit breakers (3 agents)
  2. LRUCache.get() treats stored `undefined` values as cache misses — correctness bug confirmed by 5 agents
  3. 4 analytics modules duplicate `findOldestN` with O(N*k) instead of using existing `findKSmallest` O(N log k)
- **Overall health grade: B+** — Well-implemented core data structures with clean code, correct algorithms, and good test coverage. Main gaps are defensive input validation, floating-point robustness, and test parameter realism vs production usage.
- **Agent agreement map:** LRUCache `undefined` bug found by 5/6 agents; FP drift found by 4/6; min()/max() correctness independently verified NOT a bug by 4 agents.

---

## Critical Findings (P0 — Security/Correctness/Financial Impact)

*None.* All initially-suspected P0 issues (min/max iteration after wraparound) were independently verified as correct by 4 agents.

---

## High Findings (P1 — Reliability/Coverage Impact)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 1 | Data Integrity | `numeric-rolling-window.ts:99-113` | **NaN permanently poisons running sum.** A single `NaN` push (e.g., `Date.now() - undefined`) makes `sum` permanently NaN. All subsequent `average()` calls return NaN. Circuit breakers checking `if (avg > threshold)` silently fail since `NaN > x` is always false. | security, bug-hunter, perf-reviewer | HIGH | Guard in `push()`: `if (Number.isNaN(value)) return;` or recompute sum on NaN detection | 3.8 |
| 2 | Bug | `lru-cache.ts:89-100` | **LRUCache.get() treats stored `undefined` values as cache misses.** `value !== undefined` check fails when `undefined` is the stored value. Entry occupies capacity but can never be retrieved via `get()`. LRU reordering is skipped. | bug-hunter, security, test-quality, mock-fidelity, perf-reviewer | HIGH | Use `this.cache.has(key)` instead of checking value: `if (this.cache.has(key)) { const value = this.cache.get(key)!; ... }` | 3.5 |
| 3 | Architecture | 4 analytics files | **Duplicated `findOldestN()` with O(N*k) selection sort** in whale-activity-tracker, price-momentum, liquidity-depth-analyzer, pair-activity-tracker. Existing `findKSmallest()` does the same in O(N log k). For N=10000, k=100: ~1M ops vs ~66K ops. | architecture | HIGH | Replace private `findOldestN` with `import { findKSmallest } from '@arbitrage/core'` | 3.8 |
| 4 | Performance | `hot-fork-synchronizer.ts:508` | **`toArray()` allocation in sync calculation.** `this.blockTimestamps.toArray()` creates a new array on every call. Can be replaced with `forEach()` for zero allocation. | perf-reviewer | HIGH | Use `forEach()` with running computation instead of `toArray()` + loop | 3.5 |

---

## Medium Findings (P2 — Maintainability/Performance)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 5 | Data Integrity | `numeric-rolling-window.ts:99-113` | **Floating-point drift in running sum** over millions of push() calls. After 10M pushes of fractional values, sum can drift measurably. Current usage (latency tracking with integer-ish ms) is low risk but drift becomes significant for financial calculations. | bug-hunter, security, perf-reviewer, mock-fidelity | HIGH | Periodic recalibration: recompute sum from buffer every `capacity * 100` pushes, or use Kahan summation | 3.2 |
| 6 | Input Validation | `circular-buffer.ts:83`, `lru-cache.ts:75`, `numeric-rolling-window.ts:85` | **NaN/Infinity/float capacity not validated.** Constructors check `<= 0` but NaN passes through (`NaN <= 0` is false). `CircularBuffer(NaN)` silently creates a zero-capacity buffer. `NumericRollingWindow(NaN)` creates permanently broken instance. | security | HIGH | Add: `if (!Number.isInteger(capacity) \|\| capacity <= 0) throw new Error(...)` | 3.0 |
| 7 | Bug | `lru-cache.ts:134-146` | **LRUCache.set() eviction fails when first key is `undefined`.** `firstKey !== undefined` guard prevents evicting an entry with `undefined` key, causing cache to exceed maxSize. Extremely unlikely in practice (K is always `string`). | bug-hunter | HIGH | Use iterator `.done` check: `const first = iter.next(); if (!first.done) this.cache.delete(first.value)` | 2.5 |
| 8 | Test Gap | `lru-cache.test.ts` | **LRUCache `delete()` and `clear()` have zero test coverage.** Basic CRUD operations untested. `delete()` return value, `clear()` + reuse, size after clear — all uncovered. | test-quality | HIGH | Add tests for delete(existing), delete(missing), clear() + reuse | 3.0 |
| 9 | Documentation | All 5 data-structure files | **`@see ARCHITECTURE_V2.md Section 4.2 (Data Structures)` references non-existent section.** Actual Section 4.2 is "Layer 4 Extracted Services" — nothing about data structures. | architecture | HIGH | Add a data structures section to ARCHITECTURE_V2.md or remove the `@see` tags | 2.5 |
| 10 | Consumer Gap | `min-heap.test.ts:242-301` | **`findKSmallest` not tested with `Map.entries()` tuple comparator** — the universal production pattern. All 4 production consumers use `findKSmallest(map.entries(), k, ([, a], [, b]) => a.timestamp - b.timestamp)`. Tests only use arrays and Sets with numbers. | mock-fidelity | HIGH | Add test with `Map.entries()` iterable and tuple destructuring comparator | 3.2 |
| 11 | Consumer Gap | `circular-buffer.test.ts` | **`pushOverwrite` + `countWhere` combined pattern not tested.** BaseSimulationProvider uses `pushOverwrite(true/false)` + `countWhere((r) => r)` for success rate calculation. Tests exercise each independently but never in combination. | mock-fidelity | HIGH | Add test: pushOverwrite booleans then countWhere to verify rolling success rate | 3.0 |
| 12 | Performance | `circular-buffer.ts:87` | **`new Array(config.capacity)` creates holey array** in V8 (HOLEY_ELEMENTS). Slower indexed access than PACKED_ELEMENTS. Used in QueueService hot path. | perf-reviewer | MEDIUM | `new Array(config.capacity).fill(undefined)` for packed representation | 2.5 |
| 13 | Refactoring | All 4 source files | **Inconsistent API surface.** MinHeap uses methods (`size()`, `isEmpty()`) while others use getters (`get size`, `get isEmpty`). CircularBuffer has redundant `length` and `size`. LRUCache lacks `isEmpty`. | perf-reviewer | HIGH | Standardize on getters across all 4 structures | 3.0 |
| 14 | Missing Benchmark | N/A | **No dedicated benchmarks** for data structures. No regression test that O(1) operations stay O(1) at scale. Only one inline perf assertion (LRUCache peek < 10ms). | perf-reviewer | HIGH | Create benchmark suite: 1M ops for CircularBuffer, LRUCache, NumericRollingWindow, MinHeap | 2.8 |
| 15 | Memory Safety | `min-heap.ts:72-75` | **MinHeap has no capacity bound.** Unlike other structures, push() always appends with unbounded growth. Mitigated by current usage (all consumers use findKSmallest which bounds to k). Risk is future direct usage. | security | MEDIUM | Document limitation or add optional maxCapacity parameter | 2.0 |

---

## Low Findings (P3 — Style/Minor Improvements)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 16 | Architecture | ADR-022 vs module | ADR-022 explicitly calls class-based ring buffers and full LRU "overkill" for hot paths. Module exists for non-hot-path consumers. No documentation clarifying this distinction. | architecture | HIGH | Add JSDoc note: "For hot-path code per ADR-022, use inline implementations" | 2.0 |
| 17 | Architecture | 2 analytics files | Price-momentum and pair-activity-tracker implement inline circular buffers within shared/core instead of using the data-structures module. | architecture | MEDIUM | Consider refactoring or adding explanatory comments | 1.8 |
| 18 | Documentation | circular-buffer.ts, lru-cache.ts headers | **Inaccurate "Used by:" comments.** CircularBuffer missing 3 consumers (hot-fork-synchronizer, bridge-predictor, mempool-detector). LRUCache missing cross-chain-price-tracker. | architecture | HIGH | Update header comments with complete consumer lists | 1.5 |
| 19 | Convention | `active-pairs-tracker.ts:16` | **Deep import path** `@arbitrage/core/data-structures/min-heap` instead of barrel export `@arbitrage/core`. | architecture | HIGH | Change to `import { findKSmallest } from '@arbitrage/core'` | 1.5 |
| 20 | Info Leakage | `circular-buffer.ts:157` | `clearOnRemove: false` (createRollingWindow) retains object references after logical removal. Non-sensitive operational data only. | security | HIGH | Document that `clearOnRemove: false` retains references | 1.0 |
| 21 | Performance | `min-heap.ts:113` | `Math.floor((index - 1) / 2)` could use bitwise `(index - 1) >> 1`. Negligible impact since MinHeap is not on hot path. | perf-reviewer | HIGH | Optional micro-optimization | 1.0 |
| 22 | Test Gap | `lru-cache.test.ts`, `min-heap.test.ts` | Minor test gaps: LRUCache `entries()`/`forEach()` not tested. findKSmallest/findKLargest with k=n not tested. | test-quality | HIGH | Add targeted tests | 1.5 |

---

## Test Coverage Matrix

### CircularBuffer — Grade: A

| Method | Happy | Error | Edge | State Transition |
|--------|:-----:|:-----:|:----:|:----------------:|
| constructor | YES | YES (0, neg) | — | — |
| push() | YES | — | — | YES (full=false) |
| pushOverwrite() | YES | — | YES (wraparound) | YES (not-full->full) |
| shift() | YES | — | YES (empty) | — |
| peek()/peekLast() | YES | — | YES (empty) | — |
| toArray() | YES | — | YES (empty, wrap) | — |
| countWhere/filter/find | YES | — | YES (no match) | — |
| some/every/forEach/reduce | YES | — | YES | — |
| clear() | YES | — | YES (clearOnRemove) | YES (reuse) |
| getStats() | YES | — | YES (empty/full) | — |
| Symbol.iterator | YES | — | YES (empty) | — |
| Factories | YES | — | — | — |

### LRUCache — Grade: B-

| Method | Happy | Error | Edge | State Transition |
|--------|:-----:|:-----:|:----:|:----------------:|
| constructor | YES | YES (0, neg) | — | — |
| get() | YES | — | **NO (undefined val)** | YES (LRU update) |
| set() | YES | — | — | YES (eviction) |
| peek() | YES | YES (missing) | — | YES (no LRU) |
| has() | YES | — | — | — |
| **delete()** | **NO** | **NO** | **NO** | **NO** |
| **clear()** | **NO** | **NO** | **NO** | **NO** |
| resetStats() | YES | — | — | — |
| getStats() | YES | — | YES (NaN ratio) | — |
| keys()/values() | YES | — | — | — |
| **entries()/forEach()** | **NO** | — | — | — |
| Symbol.iterator | YES | — | — | — |

### MinHeap — Grade: A-

| Method | Happy | Error | Edge | State Transition |
|--------|:-----:|:-----:|:----:|:----------------:|
| push()/pop() | YES | — | YES (empty, single) | YES (heap property) |
| peek() | YES | — | YES (empty) | — |
| extractAll() | YES | — | YES (empty) | YES (empties heap) |
| clear() | YES | — | — | — |
| findKSmallest | YES | — | YES (k=0, k>n) | — |
| findKLargest | YES | — | YES (k=0, k>n) | — |
| Duplicates/negative/sorted | — | — | YES | — |

### NumericRollingWindow — Grade: B+

| Method | Happy | Error | Edge | State Transition |
|--------|:-----:|:-----:|:----:|:----------------:|
| constructor | YES | YES (0, neg) | — | — |
| push() | YES | — | — | YES (overwrite) |
| average() | YES | — | YES (empty=0) | YES (after overwrite) |
| min()/max() | YES | — | YES (empty) | **NO (after wraparound)** |
| toArray() | YES | — | YES (empty, wrap) | — |
| clear() | YES | — | — | YES (reuse) |
| getStats() | YES | — | — | — |
| NaN/large values | — | — | YES | — |

---

## Consumer Usage Matrix

| Data Structure | Consumer | Stored Type | Capacity | API Pattern |
|---|---|---|---|---|
| CircularBuffer | queue.service.ts | ArbitrageOpportunity | 1000 | push/shift/length/clear |
| CircularBuffer | base-simulation-provider.ts | boolean | 100 | pushOverwrite/countWhere |
| CircularBuffer | bloxroute-feed.ts | number (latency) | 100 | pushOverwrite + reduce |
| CircularBuffer | hot-fork-synchronizer.ts | number (timestamps) | 10 | pushOverwrite/toArray/reduce |
| CircularBuffer | bridge-predictor.ts | BridgeLatencyData | 1000 | pushOverwrite/filter/toArray |
| CircularBuffer | mempool-detector | PendingTx | varies | pushOverwrite |
| LRUCache | arbitrage-detector.ts (Solana) | string -> string | 10000 | get/set/clear |
| LRUCache | cross-chain-price-tracker.ts | string -> PricePoint | 50000 | set/peek/size |
| MinHeap | coordinator.ts, opportunity-router.ts, active-pairs-tracker.ts, lock-conflict-tracker.ts | Map entries | varies | findKSmallest with timestamp comparator |
| NumericRollingWindow | arbitrage-detector.ts (Solana) | latency ms | 100 | push/average/clear |

---

## Cross-Agent Insights

1. **5-agent consensus on LRUCache undefined bug (#2):** All agents except architecture-auditor independently identified the `value !== undefined` issue. Bug-hunter and security-auditor both noted current consumers use `string`/`PricePoint` types so it's not an active production bug, but mock-fidelity-validator confirmed no type constraint prevents `V = undefined`.

2. **4-agent verification that min()/max() is NOT a bug:** Bug-hunter, security-auditor, test-quality-analyst, and perf-reviewer all initially investigated the iteration pattern `buffer[0..count-1]` and independently concluded it's correct because when not full, values are sequential from 0; when full, all slots are valid. This high-confidence cross-verification means we can confidently skip this as a non-issue.

3. **NaN poisoning (#1) explains a test coverage gap (#22):** The test at `numeric-rolling-window.test.ts:302-311` documents NaN propagation but doesn't test recovery — security-auditor identified that this means circuit breakers could be silently disabled in production with no test to catch it.

4. **Architecture finding (#3) validates mock-fidelity finding (#10):** The 4 analytics modules duplicating `findOldestN` instead of using `findKSmallest` explains why mock-fidelity-validator found that `findKSmallest` is not tested with Map.entries() tuple comparators — the actual pattern IS used in production (active-pairs-tracker, lock-conflict-tracker) but the duplicated modules don't use it.

5. **Performance finding (#12) connects to ADR-022 finding (#16):** The holey array in CircularBuffer is a V8 optimization concern, but architecture-auditor noted ADR-022 recommends inline implementations for hot paths anyway. The perf issue mainly affects non-hot-path consumers where it's less critical.

---

## Recommended Action Plan

### Phase 1: Immediate (P1 — fix before next deployment)
- [ ] **Fix #1:** Add NaN guard to `NumericRollingWindow.push()`: `if (Number.isNaN(value)) return;` (security-auditor, Score: 3.8)
- [ ] **Fix #2:** Fix `LRUCache.get()` to use `has()` check instead of `value !== undefined` (bug-hunter + 4 agents, Score: 3.5)
- [ ] **Fix #3:** Replace 4 duplicated `findOldestN` implementations with `findKSmallest` (architecture-auditor, Score: 3.8)
- [ ] **Fix #4:** Replace `toArray()` with `forEach()` in hot-fork-synchronizer (perf-reviewer, Score: 3.5)

### Phase 2: Next Sprint (P2 — coverage gaps and reliability)
- [ ] **Fix #5:** Add floating-point drift mitigation (periodic sum recalibration) to NumericRollingWindow (Score: 3.2)
- [ ] **Fix #6:** Validate constructor capacity is a positive integer (`Number.isInteger`) (Score: 3.0)
- [ ] **Fix #7:** Fix LRUCache.set() eviction to use iterator `.done` check (Score: 2.5)
- [ ] **Fix #8:** Add LRUCache delete()/clear() tests (Score: 3.0)
- [ ] **Fix #10:** Add findKSmallest test with Map.entries() and tuple comparator (Score: 3.2)
- [ ] **Fix #11:** Add pushOverwrite + countWhere combined test (Score: 3.0)
- [ ] **Fix #9:** Fix @see references in JSDoc headers (Score: 2.5)

### Phase 3: Backlog (P3 — refactoring, benchmarks, docs)
- [ ] **Fix #12:** Use `new Array(n).fill(undefined)` for packed V8 representation (Score: 2.5)
- [ ] **Fix #13:** Standardize getter/method API surface across all 4 data structures (Score: 3.0)
- [ ] **Fix #14:** Create dedicated benchmark suite for data structures (Score: 2.8)
- [ ] **Fix #16-20:** Documentation updates (ADR-022 note, Used by comments, deep imports) (Score: 1.0-2.0)
