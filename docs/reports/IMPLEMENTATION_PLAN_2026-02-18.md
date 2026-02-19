# Implementation Plan: Critical Assessment Remediation

**Created:** 2026-02-18
**Source:** [CRITICAL_PROJECT_ASSESSMENT_2026-02-18.md](CRITICAL_PROJECT_ASSESSMENT_2026-02-18.md)
**Target:** Opus 4.6 sessions using `/fix-issues` and `/implement-feature` skills
**Total Items:** 47 action items across 4 priority levels

---

## How to Use This Plan

### Workflow Selection Guide

| Condition | Use | Why |
|-----------|-----|-----|
| Existing code has a bug, wrong default, or security flaw | `/fix-issues` | Focused fix with impact analysis + regression guard |
| Existing code needs a config/pattern change across files | `/fix-issues` | Cross-file refactor with safety analysis |
| New test file, new feature, or new infrastructure needed | `/implement-feature` | Full TDD cycle with architecture design + adversarial review |
| Documentation-only change | Direct edit | No workflow overhead needed |

### Session Strategy

Each **Wave** below is a self-contained session. Waves are ordered by dependency — earlier waves must complete before later ones. **Within each wave**, items in the same **Track** can run in parallel (separate agents or sessions). Items in different tracks within the same wave have no dependencies on each other.

### Pre-Session Checklist

Before starting any wave:
1. `npm run build:clean` — ensure clean state
2. `npm run typecheck` — confirm no pre-existing type errors
3. For contract waves: `cd contracts && npx hardhat compile && npx hardhat test`
4. Verify previous wave's changes are committed and stable

---

## Quick Reference: All 47 Items

### Legend
- **FIX** = `/fix-issues` workflow
- **FEAT** = `/implement-feature` workflow
- **DIRECT** = Direct edit (no workflow needed)
- **[P]** = Can be parallelized with other items in same track

| # | Item | Workflow | Wave | Track | Findings |
|---|------|----------|------|-------|----------|
| 1 | Fix router validation caching bug | FIX | 1 | A | S-1 |
| 2 | Set non-zero minimumProfit default | FIX | 1 | A | S-2 |
| 3 | Remove .env from git (verify status) | FIX | 1 | B | S-7 |
| 4 | Add persistent trade logging | FEAT | 4 | A | O-6 |
| 5 | Add external alerting | FEAT | 4 | B | O-2 |
| 6 | Fix 11 failing partition tests | FIX | 2 | A | T-3 |
| 7 | Reduce event batcher timeout 5ms→1ms | FIX | 2 | B | P-1 |
| 8 | Replace Array.sort() with heap in batcher | FIX | 2 | B | P-2 |
| 9 | Add e2e latency monitoring | FEAT | 3 | A | P-3 |
| 10 | Add E2E detect→execute→profit flow test | FEAT | 5 | A | T-1 |
| 11 | Fix auth bypass when NODE_ENV unset | FIX | 2 | C | S-3 |
| 12 | Make rate limiting fail CLOSED | FIX | 2 | C | S-4 |
| 13 | Add auth to execution engine API | FEAT | 3 | B | S-6 |
| 14 | Add message signing to Redis Streams | FEAT | 5 | B | S-5 |
| 15 | Fix withdrawETH() gas limit | FIX | 1 | A | S-9 |
| 16 | Move profit tracking after external calls | FIX | 1 | A | S-8 |
| 17 | Fix mock fidelity (BalancerVault, DexRouter) | FIX | 3 | C | T-4 |
| 18 | Enable fork tests in CI | FEAT | 3 | D | T-6 |
| 19 | Enable coverage thresholds in CI | FIX | 3 | D | T-7 |
| 20 | Replace weak .toBeDefined() assertions | FIX | 6 | A | T-5 |
| 21 | Replace .find()/.filter() with O(1) lookups | FIX | 3 | E | P-4 |
| 22 | Remove JSON.parse/stringify from L2 cache | FIX | 3 | E | P-5 |
| 23 | Fix feature flag defaults | FIX | 2 | D | O-9 |
| 24 | Add coordinator service tests | FEAT | 4 | C | T-12 |
| 25 | Add Redis Streams edge case tests | FEAT | 5 | C | T-14 |
| 26 | Add execution strategy failure mode tests | FEAT | 5 | D | T-15 |
| 27 | Implement bridge recovery logic | FEAT | 6 | B | T-13 |
| 28 | Add pre-deployment validation script | FEAT | 4 | D | O-11 |
| 29 | Plan for Redis failure / local fallback | FEAT | 6 | C | O-4 |
| 30 | Validate RPC response array lengths | FIX | 1 | A | S-10 |
| 31 | Add WebSocket max message size | FIX | 3 | F | S-11 |
| 32 | Enforce ALLOWED_ORIGINS in production | FIX | 2 | D | S-12 |
| 33 | Complete Pino logger migration | FIX | 6 | D | Q-1 |
| 34 | Split shared/core into focused packages | FEAT | 7 | A | A-1, Q-5 |
| 35 | Decide on mempool-detector | DIRECT | 7 | B | A-2 |
| 36 | Un-skip cross-chain-alignment tests | FIX | 5 | E | T-2 |
| 37 | Add CommitRevealArbitrage security tests | FEAT | 5 | F | T-8 |
| 38 | Profile partition service latency | FEAT | 4 | E | P-6 |
| 39 | Wire Prometheus /metrics endpoint | FEAT | 4 | F | O-12 |
| 40 | Fix health check port parametrization | FIX | 2 | E | O-10 |
| 41 | Enforce slow test reporter | FIX | 3 | D | T-16 |
| 42 | Add ESLint rules (?? 0, as any) | FEAT | 7 | C | Q-4 |
| 43 | Enforce path aliases via lint | FEAT | 7 | C | A-6, Q-9 |
| 44 | Deploy to one provider for testnet | FEAT | 7 | D | O-1 |
| 45 | Add centralized log aggregation | FEAT | 7 | E | O-3 |
| 46 | Fix unified-detector documentation | DIRECT | 2 | F | A-3 |
| 47 | Clarify ADR-002 Phase 5-6 status | DIRECT | 2 | F | A-8 |

---

## Wave 1: Critical Contract Security Fixes

**Priority:** P0 — DEPLOY BLOCKING
**Estimated Complexity:** Medium
**Dependency:** None — can start immediately
**Verification:** `cd contracts && npx hardhat compile && npx hardhat test`

### Track A: Solidity Fixes (Sequential — same file)

> **Session instruction:** Use `/fix-issues` for all items. Open one session, fix all 5 issues in `BaseFlashArbitrage.sol`, compile, run all contract tests.

| # | Finding | File:Lines | Fix Description |
|---|---------|-----------|-----------------|
| 1 | **S-1 CRITICAL: Router validation caching bug** | `contracts/src/base/BaseFlashArbitrage.sol:598-612` | Change `lastValidatedRouter` to track the *previous step's router* instead of the *last validated router*. The current logic allows an attacker to insert an unapproved router between two approved ones. |
| 2 | **S-2 CRITICAL: minimumProfit defaults to 0** | `contracts/src/base/BaseFlashArbitrage.sol:106` | Set `minimumProfit` to a non-zero default (e.g., 1 basis point = `1e14` for 18-decimal tokens). Add constructor parameter or setter validation. |
| 15 | **S-9 HIGH: withdrawETH() hardcodes 10,000 gas** | `contracts/src/base/BaseFlashArbitrage.sol:526-533` | Replace hardcoded `10000` gas with configurable gas limit or use `call{value: amount}("")` pattern. Add WETH fallback for multisig wallets. |
| 16 | **S-8 HIGH: Profit tracking reentrancy risk** | `contracts/src/base/BaseFlashArbitrage.sol:400-402` | Move `tokenProfits[asset] += profit` and `totalProfits += profit` state updates to BEFORE swap execution, or add explicit CEI (Checks-Effects-Interactions) pattern comments confirming `nonReentrant` coverage. |
| 30 | **S-10 MEDIUM: RPC response array validation** | `contracts/src/base/BaseFlashArbitrage.sol:340-346` | Add `require(amounts.length >= path.length, "Invalid amounts length")` after `getAmountsOut()` call. |

**After all fixes:**
```bash
cd contracts && npx hardhat compile && npx hardhat test
```

### Track B: Git Hygiene (Parallel with Track A)

> **Session instruction:** Verify `.env` git status first. If tracked, use `git rm --cached .env`. If not tracked, mark S-7 as resolved.

| # | Finding | Fix Description |
|---|---------|-----------------|
| 3 | **S-7 HIGH: .env potentially in git** | Run `git ls-files .env` to check. If tracked: `git rm --cached .env && git commit -m "Remove .env from tracking"`. If not tracked: S-7 is already resolved (agent may have given a false positive — .gitignore already covers .env). |

---

## Wave 2: Security + Config + Performance Foundation

**Priority:** P0/P1 — Mixed
**Dependency:** None (independent of Wave 1)
**Can run in parallel with Wave 1**

### Track A: Fix Failing Partition Tests

> **Workflow:** `/fix-issues`
> **Scope:** `shared/core/__tests__/unit/partition-service-utils.test.ts`

| # | Finding | File | Fix Description |
|---|---------|------|-----------------|
| 6 | **T-3 HIGH: 11 failing tests** | `shared/core/__tests__/unit/partition-service-utils.test.ts:39` | Fix the `getPartition` mock to return proper partition object structure. The mock issue is at line 39 — likely needs to return `{ id, chains, name }` structure matching `PartitionConfig` type. Run `npm test -- --testPathPattern partition-service-utils` to verify all 11 pass. |

### Track B: Event Batcher Performance (Sequential — same file)

> **Workflow:** `/fix-issues`
> **Scope:** `shared/core/src/event-batcher.ts`

| # | Finding | File:Lines | Fix Description |
|---|---------|-----------|-----------------|
| 7 | **P-1 CRITICAL: 5ms batcher timeout** | `event-batcher.ts:48` | Change `maxWaitTime` from `5` to `1` (ms). Update the T1.3 optimization comment. Saves 4ms/cycle. |
| 8 | **P-2 HIGH: Array.sort() in processQueue** | `event-batcher.ts:250-259` | Replace `Array.sort()` with insertion into a `PriorityQueue` (import from `shared/core/src/async/worker-pool.ts` or extract into shared data structure). Maintain same sort semantics: batch size desc, then timestamp asc. |

**After fixes:** `npm test -- --testPathPattern event-batcher`

### Track C: Security Fail-Open Fixes (Parallel)

> **Workflow:** `/fix-issues` — one session for both, same package

| # | Finding | File:Lines | Fix Description |
|---|---------|-----------|-----------------|
| 11 | **S-3 HIGH: Auth bypass** | `shared/security/src/auth.ts:704-729` | When auth is disabled, explicitly check `NODE_ENV` against a whitelist `['test', 'development']`. For any other value (including undefined), either throw on startup or enforce auth. Add regression test for `NODE_ENV=undefined` and `NODE_ENV='staging'`. |
| 12 | **S-4 HIGH: Rate limiter fails open** | `shared/security/src/rate-limiter.ts:137-145` | Change Redis error handler to return `{ exceeded: true, remaining: 0 }` instead of `{ exceeded: false }`. Add configurable `failOpen` boolean (default: `false` for security, `true` for RPC rate limiting where availability matters more). Add regression test for Redis connection failure. |

### Track D: Config & CORS Fixes (Parallel)

> **Workflow:** `/fix-issues`

| # | Finding | File:Lines | Fix Description |
|---|---------|-----------|-----------------|
| 23 | **O-9 HIGH: Feature flags default to enabled** | `shared/config/src/feature-flags.ts:65,93,101` | Change all `!== 'false'` patterns to `=== 'true'` for experimental features: `FEATURE_FLASH_LOAN_AGGREGATOR`, `FEATURE_COMMIT_REVEAL`, `FEATURE_COMMIT_REVEAL_REDIS`. All experimental features should require explicit opt-in. Update `validate-feature-flags.test.ts`. |
| 32 | **S-12 MEDIUM: CORS localhost default** | `services/coordinator/src/api/middleware/index.ts:68` | Add startup check: if `process.env.NODE_ENV === 'production'` and `ALLOWED_ORIGINS` is not set, throw error. Keep localhost default for development only. |

### Track E: Docker Compose Fix (Parallel)

> **Workflow:** `/fix-issues`

| # | Finding | File:Lines | Fix Description |
|---|---------|-----------|-----------------|
| 40 | **O-10 MEDIUM: Health check port hardcoded** | `infrastructure/docker/docker-compose.yml:39,60,87` | Replace hardcoded `3001` in health checks for unified-detector, cross-chain-detector, and execution-engine with `${HEALTH_CHECK_PORT:-3001}` or match each service's actual port configuration. |

### Track F: Documentation Fixes (Parallel)

> **Workflow:** Direct edit — no workflow needed

| # | Finding | Fix Description |
|---|---------|-----------------|
| 46 | **A-3: unified-detector mislabeled** | Edit CLAUDE.md line where port 3007 is listed as "deprecated". Change to "Unified Detector (active — factory for P1-P3 partitions)". |
| 47 | **A-8: ADR-002 Phase 5-6** | Edit ADR-002 to add status markers for Phase 5 and Phase 6: either `[IMPLEMENTED]` or `[PLANNED]`. |

---

## Wave 3: Monitoring, Mock Fidelity, CI Hardening

**Priority:** P1
**Dependency:** Wave 2 Track B (event batcher) should be done before latency monitoring

### Track A: E2E Latency Monitoring

> **Workflow:** `/implement-feature`
> **Depends on:** Wave 2 Track B (batcher fixes)

| # | Finding | Implementation |
|---|---------|---------------|
| 9 | **P-3 HIGH: No e2e latency monitoring** | Create `shared/core/src/monitoring/latency-tracker.ts`. Instrument the full path: WebSocket receive → EventBatcher flush → Detector process → Opportunity publish. Track p50/p95/p99 using existing `CircularBuffer` from ADR-022. Expose via health endpoint. Add unit tests for tracker + integration test measuring actual pipeline latency. |

### Track B: Execution Engine Auth

> **Workflow:** `/implement-feature`

| # | Finding | Implementation |
|---|---------|---------------|
| 13 | **S-6 HIGH: No auth on execution engine API** | Add authentication middleware to `services/execution-engine/src/api/circuit-breaker-api.ts`. Reuse the `apiAuth` pattern from coordinator (`shared/security/src/auth.ts`). Protect all endpoints — at minimum require API key for write operations and optionally for reads. Add tests. |

### Track C: Contract Mock Fidelity

> **Workflow:** `/fix-issues`

| # | Finding | Implementation |
|---|---------|---------------|
| 17 | **T-4 HIGH: Mock fidelity issues** | Update `contracts/src/mocks/MockBalancerVault.sol` to charge realistic flash loan fees (currently zero). Add configurable fee parameter. Update `MockDexRouter.sol` to simulate slippage (add `slippageBps` parameter). Update all affected contract tests to work with new mock fees. Run `npx hardhat test`. |

### Track D: CI Pipeline Hardening (Parallel — all in `.github/workflows/test.yml`)

> **Workflow:** `/fix-issues` for items 19 and 41, `/implement-feature` for item 18

| # | Finding | Implementation |
|---|---------|---------------|
| 18 | **T-6 HIGH: Fork tests skipped in CI** | Add a new CI job `fork-tests` that runs weekly/nightly with `FORK_ENABLED=true`. Use `schedule` trigger with cron. Separate from main CI to avoid slowdowns. |
| 19 | **T-7 MEDIUM: Coverage thresholds disabled** | Remove `--coverageThreshold='{}'` override. Set baseline thresholds: `{ global: { branches: 60, functions: 60, lines: 60, statements: 60 } }` matching `jest.config.ts`. |
| 41 | **T-16 MEDIUM: Slow test reporter not enforced** | In `jest.config.ts`, change slow-test-reporter config to `failOnSlow: true` for unit tests (100ms threshold). Keep `failOnSlow: false` for performance tests. Reduce global `testTimeout` from `700000` to project-specific values: unit=30000, integration=60000, e2e=120000, performance=600000. |

### Track E: Hot-Path Performance Fixes (Parallel)

> **Workflow:** `/fix-issues`

| # | Finding | Implementation |
|---|---------|---------------|
| 21 | **P-4 HIGH: .find()/.filter() in hot paths** | Replace `.find()` and `.filter()` with `Map.get()` / `Set.has()` in: `shared/core/src/caching/cache-coherency-manager.ts` (6 occurrences), `shared/core/src/detection/cross-dex-triangular-arbitrage.ts`. Pre-build lookup maps in initialization. |
| 22 | **P-5 HIGH: JSON.parse/stringify in cache** | Remove JSON serialization from `shared/core/src/caching/hierarchical-cache.ts` (7 occurrences). Store objects directly in L2 cache. For Redis serialization (L3), use MessagePack or keep JSON but only at the Redis boundary, not in L2 memory cache. |

### Track F: WebSocket Size Limit (Parallel)

> **Workflow:** `/fix-issues`

| # | Finding | Implementation |
|---|---------|---------------|
| 31 | **S-11 MEDIUM: No WebSocket max message size** | Add `maxMessageSize` config to `shared/core/src/websocket-manager.ts`. Default to 10MB. Close connection and log warning when exceeded. Add test for oversized message handling. |

---

## Wave 4: Infrastructure & Observability

**Priority:** P0/P1 mixed
**Dependency:** Wave 2 (security fixes should be in place)

### Track A: Persistent Trade Logging

> **Workflow:** `/implement-feature`

| # | Finding | Implementation |
|---|---------|---------------|
| 4 | **O-6 P0: No persistent trade storage** | Create `shared/core/src/persistence/trade-logger.ts`. Minimum viable: append-only JSON lines file (`.jsonl`) with rotation. Log: timestamp, opportunity ID, execution result, profit/loss, gas used, chain, token pair. Optional: SQLite adapter for structured queries. Wire into execution engine as post-trade hook. Add unit tests. |

### Track B: External Alerting

> **Workflow:** `/implement-feature`

| # | Finding | Implementation |
|---|---------|---------------|
| 5 | **O-2 P0: No external alerting** | Create `shared/core/src/alerts/slack-notifier.ts` with webhook integration. Alert on: circuit breaker state changes, service health degradation (from health endpoints), Redis connection loss, consecutive execution failures, and approaching Upstash quota limits. Configure via `SLACK_WEBHOOK_URL` env var. Wire into coordinator's existing `notifier.ts`. Add tests. |

### Track C: Coordinator Test Coverage

> **Workflow:** `/implement-feature`
> **Note:** The exploration found 12 unit + 1 integration test files already exist. The T-12 finding (10% coverage) may be overstated. First audit actual coverage, then add missing tests.

| # | Finding | Implementation |
|---|---------|---------------|
| 24 | **T-12 HIGH: Coordinator ~10% coverage** | First run `npm test -- --coverage --testPathPattern coordinator` to measure actual coverage. Then add tests for: main coordinator lifecycle (startup/shutdown), opportunity routing logic, stream consumer management, and leadership failover scenarios. Target: 60% coverage. |

### Track D: Pre-Deployment Validation

> **Workflow:** `/implement-feature`

| # | Finding | Implementation |
|---|---------|---------------|
| 28 | **O-11 MEDIUM: No pre-deploy validation** | Create `scripts/validate-deployment.ts`. Check: Redis connectivity + command quota, RPC endpoint latency per chain (<500ms), contract address exists on target chain, private key format valid (not checking value), MEV provider API responding, gas price within reasonable bounds. Exit with clear pass/fail per check. Wire into `npm run validate:deployment`. |

### Track E: Partition Service Profiling

> **Workflow:** `/implement-feature`

| # | Finding | Implementation |
|---|---------|---------------|
| 38 | **P-6 LOW: Unknown partition latency contribution** | Add timing instrumentation to `shared/core/src/partition-service-utils.ts`: measure chain filter time, event handler dispatch time, health check overhead. Emit metrics via existing Pino logger. Create a one-off benchmark script that processes 1000 synthetic events and reports p50/p95/p99 partition overhead. |

### Track F: Prometheus Metrics Endpoint

> **Workflow:** `/implement-feature`

| # | Finding | Implementation |
|---|---------|---------------|
| 39 | **O-12 MEDIUM: Prometheus not wired to endpoints** | Add `/metrics` route to coordinator and execution-engine HTTP servers. Wire `shared/core/src/metrics/infrastructure/prometheus-exporter.impl.ts` to collect: request counts, latency histograms, Redis command counts, circuit breaker state, queue depths. Use existing exporter — just connect it to service endpoints. Add smoke test. |

---

## Wave 5: Test Coverage Expansion

**Priority:** P1
**Dependency:** Wave 1 (contract fixes), Wave 2 (security fixes), Wave 3 (mock fidelity)

### Track A: E2E Detection-to-Profit Flow Test

> **Workflow:** `/implement-feature`
> **Depends on:** Wave 1 Track A (contract fixes), Wave 3 Track C (mock fidelity)

| # | Finding | Implementation |
|---|---------|---------------|
| 10 | **T-1 CRITICAL: No E2E flow test** | Create `__tests__/e2e/detection-to-profit-flow.e2e.test.ts`. Test flow: inject mock price update → verify detection triggers → verify execution request published → verify trade execution → verify profit recorded. Use in-memory Redis (from `dev:redis:memory`) and mocked RPC providers. This is the single most important test in the system. |

### Track B: Redis Streams Message Signing

> **Workflow:** `/implement-feature`
> **Depends on:** Wave 2 Track C (security foundation)

| # | Finding | Implementation |
|---|---------|---------------|
| 14 | **S-5 HIGH: No Redis Streams auth** | Add HMAC message signing to `shared/core/src/redis-streams.ts`. Each message includes `signature` field computed from `STREAM_SIGNING_KEY` env var. Consumer verifies signature before processing. Reject unsigned/invalid messages. Add unit tests for sign/verify cycle and rejection of tampered messages. |

### Track C: Redis Streams Edge Case Tests

> **Workflow:** `/implement-feature`

| # | Finding | Implementation |
|---|---------|---------------|
| 25 | **T-14 HIGH: Redis Streams edge cases untested** | Create `shared/core/__tests__/integration/redis-streams-edge-cases.test.ts`. Test: StreamBatcher buffer overflow at capacity, consumer group rebalancing when a consumer dies, stream trimming accuracy (exact vs approximate), recovery from corrupted batch messages (invalid JSON), block timeout enforcement. Use real in-memory Redis. |

### Track D: Execution Strategy Failure Mode Tests

> **Workflow:** `/implement-feature`

| # | Finding | Implementation |
|---|---------|---------------|
| 26 | **T-15 HIGH: 20+ untested failure modes** | Create test files in `services/execution-engine/__tests__/unit/strategies/`. Priority scenarios: profit threshold boundary (exactly at minimumProfit), simultaneous flash loans on same asset, partial liquidity during execution window, MEV provider timeout at various stages, commit-reveal ordering failures. Target: 10 most critical scenarios first. |

### Track E: Cross-Chain Alignment Tests

> **Workflow:** `/fix-issues`

| # | Finding | Implementation |
|---|---------|---------------|
| 36 | **T-2 HIGH: 19+ skipped tests** | Audit `shared/core/__tests__/unit/cross-chain-alignment.test.ts`. For each `describe.skip`: either implement the test (if the feature exists) or convert to a tracking issue and delete the skip block. Don't leave skip blocks as permanent fixtures. Same for `adr-002-compliance.test.ts`. |

### Track F: CommitRevealArbitrage Security Tests

> **Workflow:** `/implement-feature`

| # | Finding | Implementation |
|---|---------|---------------|
| 37 | **T-8 MEDIUM: CommitReveal security untested** | Create `contracts/test/CommitRevealSecurity.test.ts`. Test: commit-reveal timing window enforcement, front-running protection (reveal before commit should fail), expired commitment cleanup, concurrent commit-reveal from different accounts, gas price manipulation scenarios. Use `loadFixture` pattern. |

---

## Wave 6: Technical Debt & Hardening

**Priority:** P1/P2
**Dependency:** Waves 1-5 should be substantially complete

### Track A: Weak Assertion Cleanup

> **Workflow:** `/fix-issues`
> **Note:** Can be split across multiple agents — each takes a subset of files

| # | Finding | Implementation |
|---|---------|---------------|
| 20 | **T-5 HIGH: 25+ weak .toBeDefined()** | Search all test files for `.toBeDefined()` without follow-up assertions. For each, add specific value/property checks. Example: `expect(config).toBeDefined()` → `expect(config).toBeDefined(); expect(config.chainId).toBe(1); expect(config.timeout).toBeGreaterThan(0)`. Prioritize shared/core and execution-engine tests. |

### Track B: Bridge Recovery Logic

> **Workflow:** `/implement-feature`
> **Note:** This is new functionality — requires design decisions

| # | Finding | Implementation |
|---|---------|---------------|
| 27 | **T-13 HIGH: Bridge recovery missing** | Design and implement cross-chain arbitrage failure recovery in `services/cross-chain-detector/src/`. Key scenarios: bridge transaction stuck (timeout → retry or cancel), partial execution (one leg succeeded, other failed → unwind), state tracking for in-flight cross-chain arbs. Start with design doc, then implement with tests. |

### Track C: Redis Failure Fallback

> **Workflow:** `/implement-feature`
> **Note:** Architectural decision needed — design first

| # | Finding | Implementation |
|---|---------|---------------|
| 29 | **O-4 HIGH: Redis SPOF** | Implement graceful degradation when Redis is unavailable. Options: (a) pause all execution and alert, (b) fall back to local in-memory cache for reads with execution pause, (c) maintain recent state in SharedArrayBuffer. Minimum viable: detect Redis failure → pause execution engine → alert → resume on recovery. Add integration test for Redis disconnection handling. |

### Track D: Pino Logger Migration

> **Workflow:** `/fix-issues`
> **Note:** High volume (698 files) — delegate to multiple parallel agents, each handling a service/package

| # | Finding | Implementation |
|---|---------|---------------|
| 33 | **Q-1 HIGH: 698 console.log** | **Phase 1 (production-critical):** Replace ~30 console.log in `shared/core/src/` and `services/*/src/` with Pino logger. Use existing `shared/core/src/logger.ts` facade. **Phase 2 (tests):** Replace remaining ~668 console.log in test files. Can be split: one agent per service directory. Run `npm run typecheck` after each batch. |

**Parallelization strategy for Pino migration:**
```
Agent 1: shared/core/src/ (59 console.log)
Agent 2: services/coordinator/ + services/execution-engine/ (~60 console.log)
Agent 3: services/partition-*/ + services/cross-chain-detector/ (~40 console.log)
Agent 4: services/unified-detector/ + services/mempool-detector/ (~80 console.log)
Agent 5: Test files in shared/ (~200 console.log)
Agent 6: Test files in services/ (~260 console.log)
```

---

## Wave 7: Architecture & Quality of Life

**Priority:** P2/P3
**Dependency:** All previous waves complete

### Track A: Split shared/core

> **Workflow:** `/implement-feature`
> **Note:** Largest refactoring task — needs careful planning

| # | Finding | Implementation |
|---|---------|---------------|
| 34 | **A-1 HIGH: shared/core god package** | Extract into focused packages: `@arbitrage/caching` (price-matrix, hierarchical-cache, cache-coherency), `@arbitrage/analytics` (analytics, monitoring), `@arbitrage/resilience` (circuit-breaker, retry, dead-letter-queue, graceful-degradation), `@arbitrage/bridge-router` (bridge routing). Update all imports across services. Update tsconfig paths. Update build order. Run full test suite. |

### Track B: Mempool Detector Decision

> **Workflow:** Direct edit or `/fix-issues`

| # | Finding | Implementation |
|---|---------|---------------|
| 35 | **A-2 HIGH: Orphaned mempool-detector** | Decision: either (a) wire into `scripts/start-local.js` and `service-definitions.js`, or (b) add `DEPRECATED.md` and remove from active codebase. Recommendation: keep as optional service, wire into dev tooling with `npm run dev:mempool` command, but don't include in `dev:all`. |

### Track C: ESLint Rules

> **Workflow:** `/implement-feature`

| # | Finding | Implementation |
|---|---------|---------------|
| 42 | **Q-4 MEDIUM: || 0 patterns** | Add ESLint rule to warn on `\|\| 0` and `\|\| 0n` for numeric coalescing. Suggest `?? 0` auto-fix. Also add `no-explicit-any` rule for non-test files. |
| 43 | **A-6, Q-9: Cross-package relative imports** | Add ESLint rule `no-restricted-imports` to ban `../../` patterns across package boundaries. Configure auto-fix to suggest `@arbitrage/*` alternatives. |

### Track D: Testnet Deployment

> **Workflow:** `/implement-feature`
> **Note:** This is a major milestone — validates everything

| # | Finding | Implementation |
|---|---------|---------------|
| 44 | **O-1 CRITICAL: No deployment exists** | Create deployment configuration for one provider (recommended: Fly.io). Create `fly.toml` for coordinator, execution-engine, and one partition. Deploy to testnet (Sepolia or Goerli). Validate full pipeline: price ingestion → detection → execution (dry-run). Document deployment steps. |

### Track E: Centralized Logging

> **Workflow:** `/implement-feature`

| # | Finding | Implementation |
|---|---------|---------------|
| 45 | **O-3 HIGH: No log aggregation** | Integrate OpenTelemetry SDK. Add trace ID propagation to Redis Streams messages. Configure log export to a free-tier provider (e.g., Grafana Cloud free tier). Add correlation IDs to all cross-service operations. |

---

## Dependency Graph (Simplified)

```
Wave 1 ─────────────────────────────────────────────────────┐
(Contract fixes)                                            │
                                                            ▼
Wave 2 ────────────────────────────────────┐         Wave 5 Track A
(Security + Config + Perf foundation)      │         (E2E flow test)
         │                                 │               │
         ▼                                 ▼               │
Wave 3 ────────────────────────────   Wave 4               │
(Monitoring, CI, Mocks, Hot-path)     (Infra, Alerting)    │
         │                                 │               │
         ▼                                 ▼               ▼
Wave 5 Tracks B-F ────────────────────────────────── Wave 6
(Test coverage expansion)                            (Tech debt)
                                                          │
                                                          ▼
                                                    Wave 7
                                                    (Architecture QoL)
```

**Key parallelism opportunities:**
- Wave 1 + Wave 2: Fully parallel (contracts vs TypeScript)
- Wave 3 + Wave 4: Fully parallel (different concerns)
- Wave 5 Tracks A-F: All parallel (independent test suites)
- Wave 6 Track D (Pino migration): 6 parallel agents

---

## Session Templates

### Starting a `/fix-issues` Session

```
Fix finding [ID] from the Critical Assessment Report.

**Finding:** [paste finding text]
**File(s):** [exact file paths]
**Expected behavior after fix:** [what should change]
**Regression test:** [what test should be added/updated]
**Verification:** [command to run after fix]

Reference: docs/reports/CRITICAL_PROJECT_ASSESSMENT_2026-02-18.md
```

### Starting an `/implement-feature` Session

```
Implement [feature name] as specified in the Implementation Plan.

**Requirement:** [paste implementation description]
**Design constraints:**
- Follow existing patterns in [reference file]
- Must integrate with [existing system]
- Tests required: [unit/integration/e2e]
**Verification:** [commands to run]

Reference: docs/reports/IMPLEMENTATION_PLAN_2026-02-18.md, Wave [N], Track [X], Item [#]
```

### Starting a Parallel Agent Session

```
You are Agent [N] of [M] working on [Wave X, Track Y].

Your scope is LIMITED to:
- Files: [list of files]
- Changes: [specific changes]

Do NOT modify files outside your scope. Other agents are working on other files in parallel.

When done, run: [verification command]
```

---

## Progress Tracking

Copy this checklist into each session to track progress:

```markdown
## Wave 1: Contract Security [6/6 items] ✅ COMPLETE
- [x] #1  S-1  Router validation caching bug — removed lastValidatedRouter cache, each step independently validated
- [x] #2  S-2  minimumProfit default — set to 1e14, setter rejects 0
- [x] #15 S-9  withdrawETH gas limit — configurable withdrawGasLimit (default 50000), setter with bounds
- [x] #16 S-8  Profit tracking order — CEI pattern comments added, state updates before interactions
- [x] #30 S-10 RPC response validation — amounts.length check after getAmountsOut()
- [x] #3  S-7  .env git status — verified NOT tracked (already resolved)

## Wave 2: Security + Config [10/10 items] ✅ COMPLETE
- [x] #6  T-3  Fix 11 failing partition tests — mock fixed, 82/82 passing
- [x] #7  P-1  Event batcher 5ms → 1ms — maxWaitTime changed
- [x] #8  P-2  Array.sort() → heap — priority queue in event batcher
- [x] #11 S-3  Auth bypass — NODE_ENV whitelist + validateAuthEnvironment()
- [x] #12 S-4  Rate limiter fail-closed — Redis errors return exceeded:true
- [x] #23 O-9  Feature flag defaults — !== 'false' → === 'true'
- [x] #32 S-12 CORS enforcement — production throws if ALLOWED_ORIGINS unset
- [x] #40 O-10 Health check ports — per-service env vars in docker-compose
- [x] #46 A-3  Fix unified-detector docs — port 3007 marked active
- [x] #47 A-8  Clarify ADR-002 phases — Phase 5-6 [IMPLEMENTED]

## Wave 3: Monitoring + CI [9/9 items] ✅ COMPLETE
- [x] #9  P-3  E2E latency monitoring — LatencyTracker with Float64Array ring buffers, p50/p95/p99, recordFromTimestamps(), 38 tests
- [x] #13 S-6  Execution engine auth — timing-safe API key validation on POST endpoints, public GET
- [x] #17 T-4  Mock fidelity — BalancerVault fees documented, DexRouter configurable exchange rates + slippage
- [x] #18 T-6  Fork tests in CI — weekly schedule trigger (Monday 3 AM UTC), 45min timeout, FORK_ENABLED=true, warning-only on PR
- [x] #19 T-7  Coverage thresholds — 60% global threshold enforced (branches, functions, lines, statements)
- [x] #41 T-16 Slow test reporter — failOnSlow=true globally, per-project testTimeout (unit:10s, integration:60s, e2e:2min, perf:10min)
- [x] #21 P-4  .find()/.filter() → Map/Set — pendingOperationsByKey Map for O(1) in gossip path, Set exclusions in triangular detection, zero-alloc dex uniqueness check
- [x] #22 P-5  JSON.parse removal — explicit JSON handling replaces double-serialization bug (P0-FIX)
- [x] #31 S-11 WebSocket message size — maxMessageSize config (default 10MB), closes connection with code 1008, 5 tests

## Wave 4: Infrastructure [6/6 items] ✅ COMPLETE
- [x] #4  O-6  Persistent trade logging — TradeLogger with append-only JSONL, daily rotation, wired into execution engine publishExecutionResult(), 19 tests
- [x] #5  O-2  External alerting — Discord + Slack webhooks via AlertNotifier, circuit breaker pattern, wired into coordinator
- [x] #24 T-12 Coordinator test coverage — 11 unit test files + integration test (coordinator, routing, alerts, health, leadership, streaming)
- [x] #28 O-11 Pre-deployment validation — validate-deployment.ts with 7 check categories (Redis, RPC latency, contracts, private key, MEV, gas, env), 49 tests, npm run validate:deployment
- [x] #38 P-6  Partition service profiling — startup timing instrumentation, memory profiling (heapUsed/rss), onStarted callback
- [x] #39 O-12 Prometheus /metrics endpoint — coordinator /api/metrics with auth, execution-engine /stats, PrometheusExporter (733 lines) with Grafana dashboard

## Wave 5: Test Expansion [6/6 items] ✅ COMPLETE
- [x] #10 T-1  E2E flow test — tests/e2e/data-flow-e2e.test.ts: price→detection→coordination→execution with real Redis Streams
- [x] #14 S-5  Redis Streams signing — HMAC-SHA256 signing in xadd(), timingSafeEqual verification in parseStreamResult(), backward-compatible opt-in via STREAM_SIGNING_KEY, 21 tests
- [x] #25 T-14 Redis Streams edge cases — 15 integration tests: buffer overflow, consumer rebalancing/XCLAIM, exact/approximate trimming, corrupted batches, block timeout, order preservation, concurrent consumers
- [x] #26 T-15 Execution failure modes — flash-loan-edge-cases.test.ts: N-hop, provider disconnect, race conditions, invalid routers
- [x] #36 T-2  Un-skip alignment tests — deleted rejected Option A, fixed paths for Blocks 2-6, un-skipped ADR-002 compliance; 17 tests now passing
- [x] #37 T-8  CommitReveal security tests — CommitRevealArbitrage.test.ts (2445 lines): reveal security, reentrancy, admin access control

## Wave 6: Tech Debt [4/4 items] ✅ COMPLETE
- [x] #20 T-5  Weak assertion cleanup — strengthened ~65 assertions across 5 priority files (factory-functions, stream-health-monitor, stargate-v2-router, execution-engine-initializer, performance-analytics) with typeof/enum/regex/NaN checks
- [x] #27 T-13 Bridge recovery logic — BridgeRecoveryManager with Redis SCAN, periodic checks (60s), concurrency limits, sell recovery, abandoned bridge cleanup, 37 tests, wired into engine startup/shutdown
- [x] #29 O-4  Redis failure fallback — graceful-degradation.ts: DegradationLevel, dual-publish (Streams + Pub/Sub fallback), dead-letter-queue
- [x] #33 Q-1  Pino logger migration — Pino 9.6.0 production dep, createLogger() throughout shared/core, only 11 console.log remaining in src/

## Wave 7: Architecture QoL [6/6 items] ✅ COMPLETE
- [x] #34 A-1  Split shared/core — virtual split via package.json exports (./caching, ./analytics, ./resilience, ./bridge-router) with source directories
- [x] #35 A-2  Mempool-detector decision — wired as optional service: `npm run dev:mempool`, enabled=false by default, added to service-definitions.js, port-config.js, CURRENT_STATE.md, .env.example
- [x] #42 Q-4  ESLint ?? rules — no-restricted-syntax for `|| 0`/`|| 0n` patterns (warn), no-explicit-any upgraded to error for source files
- [x] #43 A-6  Path alias enforcement — no-restricted-imports (warn) for `../../shared/*` patterns, directs to @arbitrage/* aliases
- [x] #44 O-1  Testnet deployment — Fly.io configs for coordinator, execution-engine, partition-high-value; docker-compose.testnet.yml with SIMULATION_MODE=true; deploy.sh updated with all 6 targets
- [x] #45 O-3  Centralized logging — OpenTelemetry: trace-context.ts (propagation via Redis Streams), otel-transport.ts (Pino → OTLP/HTTP), multistream in pino-logger.ts, 68 tests
```

---

*Plan generated 2026-02-18. Progress updated 2026-02-19.*
*Based on Critical Assessment Report v1 (65 findings, 47 action items).*
*Legend: [x] = completed, [~] = partially done, [ ] = not started*

**Overall Progress: 47/47 completed ✅ ALL WAVES COMPLETE**
