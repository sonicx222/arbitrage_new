# Deep Analysis: `shared/core/src/rpc/`

**Date:** 2026-02-16
**Module:** RPC Batch Provider & Rate Limiter
**Files:** `batch-provider.ts` (699 lines), `rate-limiter.ts` (314 lines), `index.ts` (41 lines)
**Tests:** `batch-provider.test.ts` (507 lines), `rpc/rate-limiter.test.ts` (577 lines)
**Agents:** 6 parallel specialists (architecture, bugs, security, test quality, mock fidelity, performance)

---

## Executive Summary

- **Total findings:** 19 (deduplicated from 40+ raw agent findings)
- **By severity:** 1 Critical (P0), 3 High (P1), 7 Medium (P2), 8 Low (P3)
- **Overall grade: C+** — The rate limiter is solid, but the BatchProvider has a critical deduplication bug that makes the default configuration broken, plus significant test coverage gaps and documentation drift.

**Top 3 highest-impact issues:**
1. **Deduplicated request promises never resolve** — default `enableDeduplication: true` causes permanent Promise hangs (6/6 agents flagged this)
2. **Batch fetch drops provider auth headers** — raw `fetch()` bypasses ethers' configured authentication for batches of 2+ requests
3. **Zero test coverage for rate limiting in BatchProvider** — the `enableRateLimiting` code path has no tests at all

**Agent agreement map:**
| Area | Agents Agreeing |
|------|----------------|
| Dedup promise leak | All 6 (architecture, bug-hunter, security, test-quality, mock-fidelity, performance) |
| Auth headers dropped | security, performance, mock-fidelity |
| Rate limit test gap | test-quality, security |
| Docs don't exist | architecture (verified with glob) |
| Private API `_getConnection` | security, mock-fidelity |
| Skipped tests hiding bugs | test-quality, performance, bug-hunter |

---

## Critical Findings (P0)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix |
|---|----------|-----------|-------------|----------|------------|---------------|
| 1 | **Bug / Promise Leak** | `batch-provider.ts:292-304, 337-349` | **Deduplicated requests never resolve.** When dedup is enabled (default: `true`), duplicate requests are added to `deduplicationMap` but NOT to `pendingBatch`. `flushBatch()` only resolves `pendingBatch` items, then `.clear()`s the dedup map — discarding all duplicate request promises forever. Callers using `await` hang indefinitely. Memory leak is unbounded since `maxQueueSize` only checks `pendingBatch.length`. The only dedup test is `it.skip`'d. | All 6 | HIGH (95%) | Save dedup map reference before clearing. After `resolveResponses()`, iterate saved map and resolve/reject all secondary entries with the same result as the primary. |

**Score:** Impact=5, Effort=2, Risk=2 → **4.6/5**

---

## High Findings (P1)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix |
|---|----------|-----------|-------------|----------|------------|---------------|
| 2 | **Auth Bypass** | `batch-provider.ts:596-611` | **Batch fetch drops provider auth headers.** `sendBatchRequest()` uses raw `fetch()` with only `Content-Type`. Single requests (batch=1) go through `provider.send()` which retains auth. Batches of 2+ lose any header-based authentication (Bearer tokens). URL-embedded API keys still work. | security, performance, mock-fidelity | HIGH | Extract headers from `provider._getConnection()` or add `headers` config option to `BatchProviderConfig`. |
| 3 | **Test Gap** | `batch-provider.ts:260-264` | **Zero tests for rate limiting integration.** The `enableRateLimiting: true` code path in `queueRequest()` (rate limit check, `totalRateLimited` stat, throw on throttle) has no tests. The test fixture explicitly disables dedup but doesn't test rate limiting at all. | test-quality, security | HIGH | Add test suite for `enableRateLimiting: true` covering: allow, throttle (throw), exempt method bypass, stats tracking. |
| 4 | **Doc Mismatch** | `index.ts:8-9`, `batch-provider.ts:16,86,155`, `rate-limiter.ts:12,203` | **8+ `@see` references point to nonexistent docs.** `RPC_DATA_OPTIMIZATION_IMPLEMENTATION_PLAN.md` and `docs/reports/RPC_PREDICTION_OPTIMIZATION_RESEARCH.md` don't exist. The "Phase 3", "R1/R3/R4 Optimization" labels throughout the code have no reference context. | architecture | HIGH (100%) | Either create the referenced docs or update `@see` references to point to ADR-024 which covers the same ground. |

---

## Medium Findings (P2)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix |
|---|----------|-----------|-------------|----------|------------|---------------|
| 5 | **Dead State** | `batch-provider.ts:223, 232-234` | **`this.config.rateLimitConfig` diverges from actual limiter config.** The stored default `{tokensPerSecond:20, maxBurst:40}` is never read. The actual limiter uses `getRateLimitConfig(chainOrProvider)` which could return 40 RPS for dRPC, 100 for PublicNode, etc. Any inspection of `config` shows wrong values. | bug-hunter | HIGH | Use `this.config.rateLimitConfig` at line 233 instead of re-reading `config?`, OR set `this.config.rateLimitConfig` to the resolved config. |
| 6 | **Doc Mismatch** | `ADR-024:258-260` | **ADR-024 documents `batchProvider.getRateLimiterStats()` which doesn't exist.** `BatchProvider` has `getStats()` returning `BatchProviderStats`, not rate limiter stats. | architecture | HIGH (95%) | Update ADR-024 example code to use the actual API. |
| 7 | **Doc Mismatch** | `batch-provider.ts:72, 79` | **JSDoc defaults are wrong.** `maxBatchSize` JSDoc says "default: 10" but actual is 20. `enableDeduplication` JSDoc says "default: false" but actual is `true`. Both were changed by R1/R4 optimizations but JSDoc wasn't updated. | architecture | HIGH (95%) | Update JSDoc to match actual defaults. |
| 8 | **Import Pattern** | `shared/core/src/index.ts:1470-1483` | **Rate limiter exports missing from main barrel.** `TokenBucketRateLimiter`, `RateLimiterManager`, `getRateLimiterManager`, etc. are exported from `./rpc/index.ts` but NOT re-exported through `shared/core/src/index.ts`. Consumers must use `@arbitrage/core/rpc` sub-entry point. | architecture | HIGH (95%) | Add rate limiter exports to main barrel, or document the sub-entry pattern. |
| 9 | **Test Gap** | `batch-provider.test.ts:233,276,472` | **3 skipped tests leave critical gaps.** HTTP error (line 233), queue-full (276), and dedup (472) tests are all `it.skip`. The dedup skip masks Finding #1. The HTTP error skip means batch-level failures have zero coverage. Dedup is the default behavior. | test-quality, performance, bug-hunter | HIGH | Unskip and fix: use `await jest.runAllTimersAsync()` consistently, mock `provider.send` to never resolve for queue-full test. |
| 10 | **Stability** | `batch-provider.ts:601` | **Relies on private `_getConnection()` API.** The `_` prefix indicates internal/unstable ethers v6 API. An ethers update could rename or change this method, breaking batch requests silently (single requests would still work). | security, mock-fidelity | HIGH | Cache URL at construction time, or use public API. |
| 11 | **Mock Gap** | `batch-provider.test.ts:67, 120-137` | **No test for out-of-order batch responses.** JSON-RPC 2.0 spec states responses "MAY be returned in any order." Source code correctly uses `responseMap` ID-based lookup (line 636), but all tests return responses in request order. A regression to array-index matching would pass all tests. | mock-fidelity | MEDIUM | Add test with shuffled response IDs (e.g., `[{id:2,...}, {id:1,...}]`). |

---

## Low Findings (P3)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix |
|---|----------|-----------|-------------|----------|------------|---------------|
| 12 | **Code Convention** | `batch-provider.ts:316, 325` | Uses `console.error` instead of structured logger. `rate-limiter.ts` in the same directory correctly uses `createLogger`. | architecture | MEDIUM (80%) | Import and use `createLogger('batch-provider')`. |
| 13 | **Stats Semantics** | `batch-provider.ts:269, 363` | `totalRequestsBypassed` double-counts: incremented for both NON_BATCHABLE bypasses (line 269) and single-request flushes (line 363). Conflates "non-batchable" with "batch-of-one". | performance | HIGH | Split into separate counters or only count at line 269. |
| 14 | **Config** | `rate-limiter.ts:205-218` | Rate limits hardcoded, not configurable via env/config. ADR-024 references `provider-config.ts` for limits but they're inlined in source. | architecture | MEDIUM (75%) | Acceptable as-is since provider limits are stable, but document the intentional decision. |
| 15 | **Fragile Match** | `rate-limiter.ts:230-231` | `getRateLimitConfig` uses `includes(key)` which matches "default" as a substring. A provider named "my-default-rpc" gets wrong limits. | architecture, bug-hunter | MEDIUM (70%) | Use exact match or prefix match, or move "default" out of the iteration loop. |
| 16 | **Test Quality** | `batch-provider.test.ts:315` | Assertion `toBeGreaterThan(0)` is too loose for 3-request test. Would pass even if only 1 request processed. | test-quality | HIGH | Use `toBe(3)` or `toBeGreaterThanOrEqual(3)`. |
| 17 | **Security** | `rate-limiter.ts:189-192` | `eth_sendRawTransaction` bypasses rate limiting entirely. No protection against internal hot-loop bugs flooding the provider. | security | MEDIUM | Add a separate higher-limit rate limiter for send methods. |
| 18 | **Dead Code** | Rate limiter singleton | `getRateLimiterManager()` / `RateLimiterManager` have zero production consumers. `BatchProvider` creates its own `TokenBucketRateLimiter` directly. | performance | HIGH | Either wire into production or document as future API. |
| 19 | **Mock Gap** | `batch-provider.test.ts:27-33, 67` | `MockFetchResponse` missing `headers` and most `Response` interface. `_getConnection()` returns plain `{url}` instead of `FetchRequest` class. Fragile against future changes. | mock-fidelity | HIGH | Add `headers: new Headers()` to mock. Consider caching URL in constructor to reduce mock surface. |

---

## Test Coverage Matrix

### batch-provider.ts

| Function/Method | Happy Path | Error Path | Edge Cases | Rate Limit | Notes |
|----------------|:----------:|:----------:|:----------:|:----------:|-------|
| `constructor` | YES | -- | YES | -- | 3 init tests |
| `queueRequest` | YES | YES (shutdown, RPC error) | PARTIAL | **NO** | Queue-full SKIPPED; rate-limit path untested |
| `flushBatch` | YES (implicit) | **SKIPPED** | YES (empty, single) | -- | HTTP error test skipped |
| `shutdown` | YES | -- | -- | -- | |
| `batchEstimateGas` | YES | YES | -- | -- | Missing: empty array |
| `batchCall` | YES | -- | -- | -- | Missing: error path, custom blockTag, empty |
| `batchGetTransactionReceipts` | YES | -- | YES (null) | -- | Missing: error path, empty |
| `batchGetBalances` | YES | -- | YES (zero) | -- | Missing: error path, custom blockTag, empty |
| `getStats` | YES | -- | -- | -- | |
| `resetStats` | YES | -- | -- | -- | Tests on fresh provider (no-op passes) |
| `getBatchEfficiency` | PARTIAL | -- | -- | -- | Only 0% case tested |
| `isEnabled` | YES | -- | -- | -- | |
| `getProvider` | YES | -- | -- | -- | |
| `createBatchProvider` | YES | -- | -- | -- | |
| **Deduplication** | **SKIPPED** | -- | -- | -- | **Default feature untested** |

### rate-limiter.ts

| Function/Method | Happy Path | Error Path | Edge Cases | Notes |
|----------------|:----------:|:----------:|:----------:|-------|
| `TokenBucketRateLimiter.constructor` | YES | -- | YES | 3 tests |
| `tryAcquire` | YES | YES | YES | Well covered |
| `acquire` | YES | YES (timeout) | YES | P2-001 fix regression test |
| `getAvailableTokens` | YES | -- | -- | |
| `getStats` | YES | -- | YES | 3 dedicated tests |
| `resetStats` | YES | -- | YES | |
| `isRateLimitExempt` | YES | -- | YES (empty string) | 6 tests |
| `DEFAULT_RATE_LIMITS` | YES | -- | -- | 4/7 entries checked |
| `getRateLimitConfig` | YES | -- | YES | 6 tests, case-insensitive |
| `RateLimiterManager.getLimiter` | YES | -- | YES | |
| `RateLimiterManager.tryAcquire` | YES | YES | YES | 5 tests |
| `RateLimiterManager.getAllStats` | YES | -- | YES | |
| `RateLimiterManager.clear` | YES | -- | YES | |
| `getRateLimiterManager` | YES | -- | -- | Singleton verified |
| `resetRateLimiterManager` | YES | -- | YES | |

---

## Mock Fidelity Matrix

| Mock | Real Interface | Functions Covered | Behavior Fidelity | Overall Score |
|------|---------------|:-----------------:|:-----------------:|:-------------:|
| Provider mock (`send`, `getNetwork`, `_getConnection`) | `ethers.JsonRpcProvider` | 3/30+ | 3/5 | **3/5** |
| `_getConnection()` return `{url}` | `ethers.FetchRequest` class | 1/20+ properties | 2/5 | **2/5** |
| `MockFetchResponse` | `globalThis.Response` | 4/15+ methods | 2/5 | **2/5** |
| JSON-RPC response format | JSON-RPC 2.0 spec | Core fields | 4/5 | **4/5** |
| Logger mock | `winston.Logger` via `createLogger()` | 4/10+ methods | 3/5 | **3/5** |
| Fake timers | `Date.now()`, `setTimeout` | Both | 4/5 | **4/5** |

**Weighted average: 3.0/5 (B-)**

---

## Cross-Agent Insights

1. **Finding #1 (dedup bug) was found independently by all 6 agents** through different analytical lenses:
   - Architecture: contract violation (dedup groups not resolved per interface promise)
   - Bug Hunter: traced full data flow and found zero resolution code for secondary promises
   - Security: modeled as DoS/memory leak attack vector
   - Test Quality: identified the skipped test as masking the bug
   - Mock Fidelity: noted the skipped dedup test prevents fidelity validation
   - Performance: flagged as SMELL-1 then upgraded to BUG

2. **Finding #2 (auth headers) connects to Finding #10 (private API)**: The `_getConnection()` returns a `FetchRequest` which DOES contain auth headers. If the code extracted headers from it, both the auth bypass and the private API concern would be partially addressed.

3. **Finding #5 (dead state config) is invisible because of Finding #3 (no rate limit tests)**: The config divergence would be caught by tests that verify the actual limiter uses the expected chain-specific config. No such tests exist.

4. **Finding #18 (dead singleton)** combined with **Finding #8 (missing barrel exports)** suggests the `RateLimiterManager` was designed but never integrated. The `BatchProvider` creates its own limiter instances, making the manager redundant.

5. **The batch provider infrastructure is deployed but not wired into execution**: The `provider.service.ts` creates `BatchProvider` instances per chain but they are exposed without actually being used for batch operations. The execution engine still uses raw `provider.send()`.

---

## Recommended Action Plan

### Phase 1: Immediate (P0 — fix before any deployment)
- [ ] **Fix #1**: Resolve deduplicated request promises. Save dedup map before clearing, propagate results to all group members after resolving the primary request. Unskip the dedup test.
- [ ] **Fix #7**: Update JSDoc defaults (`maxBatchSize: 20`, `enableDeduplication: true`) to match actual values.

### Phase 2: Next Sprint (P1 — reliability and coverage)
- [ ] **Fix #2**: Forward auth headers from `_getConnection()` in `sendBatchRequest()`, or add `headers` config to `BatchProviderConfig`.
- [ ] **Fix #3**: Add test suite for `enableRateLimiting: true` in BatchProvider.
- [ ] **Fix #4**: Update or remove `@see` references to nonexistent docs.
- [ ] **Fix #5**: Resolve `config.rateLimitConfig` dead state — use stored config for limiter init.
- [ ] **Fix #9**: Unskip HTTP error and queue-full tests; fix async/timer patterns.

### Phase 3: Backlog (P2/P3 — quality, docs, refactoring)
- [ ] **Fix #6**: Update ADR-024 example code to use actual API.
- [ ] **Fix #8**: Add rate limiter exports to main barrel or document sub-entry pattern.
- [ ] **Fix #10**: Cache provider URL at construction to avoid `_getConnection()` per flush.
- [ ] **Fix #11**: Add test for out-of-order batch responses.
- [ ] **Fix #12**: Replace `console.error` with structured logger.
- [ ] **Fix #13**: Split `totalRequestsBypassed` into semantically distinct counters.
- [ ] **Fix #15**: Fix `getRateLimitConfig` substring matching for "default" key.
- [ ] **Fix #16**: Tighten loose test assertions.
- [ ] **Fix #17**: Add rate protection for exempt send methods (circuit breaker pattern).
- [ ] **Fix #19**: Improve mock fidelity (add Response headers, use FetchRequest shape).
