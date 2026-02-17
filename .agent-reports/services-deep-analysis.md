# Deep Analysis Report: `/services`

**Date**: 2026-02-17
**Analysis Team**: 6 specialized agents (architecture, bugs, security, test quality, mock fidelity, performance)
**Scope**: All 9 services (coordinator, cross-chain-detector, execution-engine, mempool-detector, partition-asia-fast, partition-high-value, partition-l2-turbo, partition-solana, unified-detector)

---

## Executive Summary

- **Total findings by severity**: Critical: 2 | High: 6 | Medium: 9 | Low: 7
- **Top 3 highest-impact issues**:
  1. Cross-chain strategy missing trade size USD derivation for bridge scoring — degrades bridge route selection quality
  2. `|| 0` pattern in subscription-manager.ts source and several env var defaults using `||` instead of `??` — could silently replace valid zero/empty values
  3. `as any` casts in mempool-detector integration tests (20+ instances) — mask type safety, could hide regressions
- **Overall health assessment**: **B+** — Well-architected system with comprehensive input validation, proper use of circuit breakers, DLQ patterns, and deferred ACK. Main gaps are in cross-chain bridge scoring completeness and test type safety.
- **Agent agreement map**: Architecture + Bug Hunter agreed on env var `||` vs `??` patterns; Security + Bug Hunter agreed on input validation quality; Test Quality + Mock Fidelity agreed on `as any` cast prevalence in tests.

---

## Critical Findings (P0 - Security/Correctness/Financial Impact)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 1 | Financial Logic | `services/execution-engine/src/strategies/cross-chain.strategy.ts:261` | Bridge route scoring uses default trade size ($1000/medium) instead of actual trade size. The TODO acknowledges this: "Derive tradeSizeUsd from opportunity.amountIn + token price for better bridge scoring." Without accurate trade size, the bridge router may select suboptimal routes for large trades, leading to higher fees or failed bridges. Same issue at line 1561 for recovery. | Bug Hunter, Architecture | HIGH (90%) | Add price oracle lookup to convert amountIn (wei) to USD using the existing price data available via context. At minimum, use a rough heuristic: `amountIn * lastKnownPrice / 10^decimals`. | 3.8 |
| 2 | Correctness | `services/cross-chain-detector/src/stream-consumer.ts:354` | `consumerGroups.find()` performs O(n) linear search on every stream consumption call. While n is small (3 groups), this is called in the hot poll loop (100ms intervals) and violates the ADR-022 principle of O(1) lookups in hot paths. | Performance, Architecture | MEDIUM (75%) | Pre-build a `Map<string, ConsumerGroupConfig>` at construction time and use `.get()` for O(1) lookup. The array is only 3 elements so performance impact is negligible, but it sets a bad pattern. | 2.6 |

---

## High Findings (P1 - Reliability/Coverage Impact)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 3 | Type Safety | `services/mempool-detector/src/__tests__/integration/success-criteria.integration.test.ts:93-215` | 20+ `(metadata as any)` casts to access test metadata fields. These bypass TypeScript's type system and could mask type changes in the underlying metadata interface. | Test Quality, Mock Fidelity | HIGH (95%) | Define a typed `TestMetadata` interface with `expectedTokenIn`, `expectedTokenOut`, `expectedAmountIn` fields. Cast once at the top of each test block. | 3.4 |
| 4 | Bug Pattern | `services/unified-detector/src/subscription/subscription-manager.ts:243` | Uses `|| 0` instead of `?? 0` for `chainConfig.wsFallbackUrls?.length`. While `length` won't be 0 in practice (optional chaining returns undefined for missing property), this violates the project convention of using `??` for numeric values. | Bug Hunter | MEDIUM (70%) | Change to `chainConfig.wsFallbackUrls?.length ?? 0` for consistency with project conventions. | 2.8 |
| 5 | Configuration | `services/execution-engine/src/engine.ts:328-421` | Multiple `parseInt(process.env.X \|\| 'default')` patterns where `\|\|` is used instead of `??`. If an env var is set to empty string (`X=""`), `\|\|` treats it as falsy and uses the default — but `??` would preserve the empty string, which then causes `parseInt` to return NaN. Both approaches have trade-offs, but the codebase convention should be consistent. The execution-engine types.ts correctly uses `parseEnvTimeout()` with proper NaN/bounds checking, but engine.ts does raw `parseInt` without validation. | Bug Hunter, Architecture | HIGH (85%) | Use `parseEnvTimeout()` (from types.ts) consistently across all services, or at minimum add `Number.isNaN()` guard after each `parseInt`. | 3.2 |
| 6 | Test Coverage | `services/execution-engine/src/strategies/cross-chain.strategy.ts` | Bridge recovery flow (`recoverPendingBridges`) lacks dedicated unit tests for: (a) recovery when bridge router factory is null, (b) recovery state timeout (>24h), (c) partial recovery (some bridges succeed, some fail). This is a funds-at-risk code path. | Test Quality, Security | HIGH (85%) | Add unit tests covering each recovery scenario with mocked Redis state and bridge router responses. | 3.6 |
| 7 | Documentation | `services/coordinator/src/coordinator.ts:1444` | Comment references "FIX: Implemented actual stream publishing (was TODO stub)" but the original TODO context is no longer visible. The coordinator now has 5 consumer groups (OPPORTUNITIES, WHALE_ALERTS, SWAP_EVENTS, VOLUME_AGGREGATES, PRICE_UPDATES) but `docs/architecture/ARCHITECTURE_V2.md` may not document all 5 stream subscriptions. | Architecture | MEDIUM (70%) | Verify ARCHITECTURE_V2.md Section 5.3 lists all 5 streams the coordinator subscribes to. Update if missing. | 2.4 |
| 8 | Resilience | `services/coordinator/src/opportunities/opportunity-router.ts:337` | Retry backoff uses `setTimeout` inside an async loop: `await new Promise(resolve => setTimeout(resolve, delay))`. During shutdown, if the coordinator's stop() method is called while a retry is sleeping, the retry timer is not cancelled — the forwardToExecutionEngine() call will complete after shutdown. | Bug Hunter | MEDIUM (75%) | Use `createCancellableTimeout` (already imported in opportunity.consumer.ts) to allow shutdown cancellation of retry delays. Or check a `shuttingDown` flag before each retry attempt. | 3.0 |

---

## Medium Findings (P2 - Maintainability/Performance)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 9 | Duplication | `services/cross-chain-detector/src/stream-consumer.ts` vs `services/coordinator/src/streaming/stream-consumer-manager.ts` | Both services implement custom stream consumer patterns instead of using `@arbitrage/core`'s `StreamConsumer`. The cross-chain-detector documents this as intentional (multi-stream consumption needs), but the coordinator's stream-consumer-manager duplicates similar functionality. | Architecture, Performance | MEDIUM (70%) | Consider extracting a `MultiStreamConsumer` into `@arbitrage/core` that supports multiple stream consumption with per-stream validation, reducing duplication between coordinator and cross-chain-detector. | 2.6 |
| 10 | Code Smell | `services/unified-detector/src/chain-instance.ts:1-100` | This file imports 30+ symbols from `@arbitrage/core` in a single import statement. While this works, it suggests the module has too many responsibilities. The file header says "lightweight wrapper" but the actual file is significantly larger. | Performance | LOW (60%) | Consider splitting chain-instance.ts into focused sub-modules (already partially done with `./detection`, `./simulation-initializer`, `./subscription`, `./pair-initializer`). | 2.0 |
| 11 | Security | `services/cross-chain-detector/src/stream-consumer.ts:180-185` | Price validation bounds (MIN_VALID_PRICE=1e-12, MAX_VALID_PRICE=1e12) are hardcoded. While reasonable defaults, these should be configurable to adapt to new tokens with extreme price ranges. | Security | LOW (55%) | Extract to configuration constants with env var overrides. The current bounds are generous enough for known tokens. | 2.0 |
| 12 | Consistency | `services/coordinator/src/coordinator.ts:371` | Alert cooldown uses `process.env.ALERT_COOLDOWN_MS || ...` while execution-engine types.ts has a well-structured `parseEnvTimeout()` function. Inconsistent env var parsing across services. | Architecture, Bug Hunter | MEDIUM (80%) | Standardize on a shared `parseEnvInt()` utility in `@arbitrage/core` (similar to execution-engine's `parseEnvTimeout()`) and use it across all services. | 2.4 |
| 13 | Test Realism | `services/coordinator/__tests__/unit/coordinator.test.ts:466,496` | Alert cooldown tests use `|| 0` pattern for Map lookups, masking potential zero-cooldown scenarios. | Mock Fidelity | LOW (60%) | Use `?? 0` for consistency, though the test logic is correct since Map.get() returns undefined for missing keys, not 0. | 1.8 |
| 14 | Documentation | `services/execution-engine/src/types.ts:16-21` | Extensive Phase notes (Phase 1, Phase 2, Phase 3) create maintenance burden. The types.ts file is 1237 lines — a significant portion is documentation about historical changes. | Architecture | LOW (55%) | Move historical phase notes to a CHANGELOG.md or ADR; keep only the current API documentation in the types file. | 1.6 |
| 15 | Error Handling | `services/cross-chain-detector/src/stream-consumer.ts:384` | Error message check `!(error as Error).message?.includes('timeout')` is fragile — if the error message format changes, legitimate timeout errors will be logged as errors instead of being silently ignored. | Bug Hunter | LOW (55%) | Check for specific error codes or error types rather than string matching on error messages. | 2.0 |
| 16 | Performance | `services/execution-engine/src/types.ts:180-236` | `const enum ExecutionErrorCode` has 30+ values. While `const enum` is correct for hot-path optimization, any code importing from this module via `import type` won't inline the values — they need to use a direct `import` (non-type). | Performance | LOW (50%) | Verify all consumers use `import { ExecutionErrorCode }` (not `import type`) to ensure inlining. | 1.8 |
| 17 | Memory | `services/execution-engine/src/types.ts:544` | `loggerCache` (Map of cached loggers) grows unboundedly. Each unique name creates a permanent entry. In practice, the number of unique logger names is small and fixed, so this is not a real leak. | Bug Hunter | LOW (50%) | Add a comment documenting that the cache is intentionally unbounded because logger names are a fixed set. No code change needed. | 1.4 |

---

## Low Findings (P3 - Style/Minor Improvements)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 18 | Style | `services/cross-chain-detector/src/__tests__/unit/detector-lifecycle.test.ts:187,263` | Uses `jest.requireMock('@arbitrage/core') as any` — could use typed mock helpers. | Test Quality | HIGH (90%) | Define typed mock interface or use `jest.mocked()` utility. | 1.6 |
| 19 | Convention | `services/coordinator/src/utils/stream-serialization.ts:36-37` | Intentionally uses `||` for `type` and `chain` fields (documented in header comment). This is correct but could confuse developers who see `??` used elsewhere. | Architecture | HIGH (95%) | Already documented — no change needed. Pattern is correct: empty string should also trigger the default. | 1.0 |
| 20 | Cleanup | `services/execution-engine/src/types.ts:62-63` | Re-exports for "backward compatibility" (`export type { ExecutionResult }`, `export { createErrorResult, ... }`). If all consumers have been migrated to import from `@arbitrage/types`, these can be removed. | Architecture | MEDIUM (70%) | Audit imports across codebase; if no consumer still imports these from `./types`, remove the re-exports. | 1.6 |
| 21 | TODO | `services/execution-engine/src/strategies/cross-chain.strategy.ts:261,1561` | Two active TODOs about `tradeSizeUsd` derivation. Already captured as Finding #1. | Test Quality | HIGH (95%) | See Finding #1. | N/A |
| 22 | Convention | `services/unified-detector/src/__tests__/performance/chain-instance-hot-path.performance.test.ts:113-117` | Multiple `|| 0` patterns in performance test — acceptable in tests for array indexing fallbacks. | Bug Hunter | HIGH (90%) | Acceptable — array access returning undefined falls back to 0 which is sensible for timing data. | 1.0 |
| 23 | Infrastructure | `services/*/Dockerfile` | All Dockerfiles consistently use `node:22-alpine`. The CLAUDE.md gotcha about "older Node versions (18/20)" appears to have been resolved. | Architecture | HIGH (95%) | Update CLAUDE.md to remove the outdated Dockerfile node version warning if all Dockerfiles now use 22. | 1.4 |
| 24 | Sync I/O | `services/coordinator/__tests__/integration/coordinator.integration.test.ts:108` | `fs.readFileSync` in integration test setup. Acceptable in test context — not production code. | Bug Hunter | HIGH (95%) | No change needed. Test setup uses sync I/O for config loading, which is fine in test context. | 1.0 |

---

## Test Coverage Matrix (Key Services)

| Service | Source Files | Test Files | Coverage Status | Critical Gaps |
|---------|-------------|------------|-----------------|---------------|
| coordinator | coordinator.ts, opportunity-router.ts, stream-consumer-manager.ts, stream-serialization.ts | coordinator.test.ts, opportunity-router.test.ts, stream-consumer-manager.test.ts | Good | Cleanup timer cancellation during shutdown |
| execution-engine | opportunity.consumer.ts, engine.ts, types.ts, 6 strategies | opportunity.consumer.test.ts, execution-flow.test.ts | Good | Bridge recovery unit tests (Finding #6) |
| cross-chain-detector | detector.ts, stream-consumer.ts, price-data-manager.ts, opportunity-publisher.ts | stream-consumer.test.ts, price-data-manager.test.ts, detector-lifecycle.test.ts | Good | Cross-chain detection accuracy under high latency |
| unified-detector | chain-instance.ts, chain-instance-manager.ts, unified-detector.ts | chain-instance-*.test.ts, chain-instance-manager.test.ts | Good | Performance regression tests for hot-path |
| partition-asia-fast | index.ts (thin wrapper) | N/A (logic tested in shared/core) | Adequate | N/A |
| partition-solana | index.ts (503 lines, manual) | N/A | Gap | Solana-specific RPC handling not unit tested |
| mempool-detector | index.ts, bloxroute-feed.ts | success-criteria.integration.test.ts | Moderate | 20+ `as any` casts weaken test assertions |

---

## Mock Fidelity Matrix

| Mock Pattern | Service(s) | Fidelity | Issues |
|-------------|-----------|----------|--------|
| Redis Streams (jest.fn()) | coordinator, execution-engine | HIGH | Mocks match interface; deferred ACK pattern properly tested |
| WebSocket (EventEmitter) | unified-detector | HIGH | Connection lifecycle well-mocked |
| ethers.JsonRpcProvider | execution-engine | MEDIUM | Provider health mocked but reconnection flow simplified |
| Bridge Router Factory | execution-engine | MEDIUM | findSupportedRouter mocked but trade size scoring not exercised |
| StreamBatcher | cross-chain-detector | HIGH | unwrapBatchMessages properly handled in tests |
| Partition Factory | partition-asia-fast, partition-l2-turbo, partition-high-value | HIGH | Thin wrappers delegate to shared/core tested separately |

---

## Cross-Agent Insights

1. **Finding #1 (Bridge Scoring) + Finding #6 (Bridge Recovery Tests)**: The bridge scoring TODO and missing recovery tests are related — without accurate trade size, recovery may also select wrong bridge routes. Both should be fixed together.
2. **Finding #5 (Env Var Parsing) + Finding #12 (Alert Cooldown)**: Both point to inconsistent env var parsing across services. The execution-engine has a good `parseEnvTimeout()` pattern that should be extracted to `@arbitrage/core` and reused.
3. **Finding #4 (`|| 0`) + Finding #22 (Test `|| 0`)**: The `|| 0` pattern appears in exactly 1 source file and ~15 test files. Source usage is low severity but the test patterns could mask edge cases.
4. **Finding #23 (Dockerfiles)**: All agents confirmed Dockerfiles now use `node:22-alpine` consistently, resolving the previously documented gotcha.

---

## Recommended Action Plan

### Phase 1: Immediate (P0/P1 - Fix before deployment)
- [ ] **Fix #1**: Add trade size USD derivation to cross-chain strategy bridge scoring (cross-chain.strategy.ts:261,1561)
- [ ] **Fix #6**: Add bridge recovery unit tests (cross-chain.strategy.ts recoverPendingBridges)
- [ ] **Fix #5**: Standardize env var parsing using `parseEnvTimeout()` or shared utility across all services
- [ ] **Fix #3**: Replace `as any` casts in mempool-detector tests with typed interface

### Phase 2: Next Sprint (P1/P2 - Reliability improvements)
- [ ] **Fix #8**: Add shutdown cancellation for retry timeouts in opportunity-router.ts
- [ ] **Fix #12**: Extract shared `parseEnvInt()` utility to `@arbitrage/core`
- [ ] **Fix #9**: Evaluate extracting `MultiStreamConsumer` to reduce stream consumer duplication
- [ ] **Fix #7**: Verify ARCHITECTURE_V2.md documents all 5 coordinator stream subscriptions

### Phase 3: Backlog (P2/P3 - Maintenance)
- [ ] **Fix #23**: Update CLAUDE.md to remove outdated Dockerfile node version warning
- [ ] **Fix #20**: Audit and remove backward-compatibility re-exports in execution-engine types.ts
- [ ] **Fix #14**: Move Phase history notes from types.ts to CHANGELOG
- [ ] **Fix #15**: Replace string-based error message matching with error type checks in stream-consumer.ts

---

## Methodology Notes

- All 6 agents completed their analysis (38 sub-tasks tracked and completed)
- Findings were deduplicated across agents and cross-referenced for consistency
- Each finding traces to specific file:line evidence from current codebase
- Confidence levels reflect actual certainty — NEEDS VERIFICATION items excluded from report
- Known correct patterns (ADR-022 performance patterns, ADR-002 stream patterns) were not flagged
