# Refactoring Implementation Plan

**Created:** 2026-02-12
**Source:** `.agent-reports/REFACTORING_ANALYSIS_2026-02-12.md`
**Total LOC removable:** ~6,500+ | **Total proposals:** 17

---

## How to Use This Plan

Each phase is a separate PR (or set of PRs). Phases are sequential but tasks within each phase can be parallelized using agent teams.

**Parallelization key:**
- `[PARALLEL]` — Can run simultaneously with other parallel tasks in the same wave
- `[SEQUENTIAL]` — Must complete before the next task starts
- `[AGENT-SAFE]` — Task is self-contained, safe to delegate to a subagent
- `[NEEDS-REVIEW]` — Requires human review of specific behavior before/after

---

## Phase 1: Dead Code + Performance Fix

**Risk:** ZERO | **Gate:** `npm run build:clean && npm run typecheck && npm test`

### Wave 1 (3 parallel agents)

```
Agent 1 [PARALLEL] [AGENT-SAFE]: HP-1 Fix token-utils eviction
  File: shared/core/src/components/token-utils.ts:165
  Action: Replace Array.from(TOKEN_PAIR_KEY_CACHE.keys()).slice(0, 1000)
          with iterator-based deletion (for...of + break)
  Test: npm test -- --testPathPattern="token-utils"

Agent 2 [PARALLEL] [AGENT-SAFE]: Delete dead code files (8 files)
  Delete:
    - shared/core/src/enterprise-testing.ts (838 LOC)
    - shared/core/src/enterprise-config.ts (820 LOC)
    - shared/core/src/risk-management.ts (650 LOC)
    - shared/core/src/ab-testing.ts (572 LOC)
    - shared/core/src/advanced-statistical-arbitrage.ts (465 LOC)
    - shared/core/src/repositories.ts (288 LOC)
    - shared/core/src/domain-models.ts (420 LOC)
    - shared/core/src/arbitrage-service.ts (374 LOC)
  Then: Remove corresponding exports from:
    - shared/core/src/index.ts
    - shared/core/src/internal/index.ts (if referenced)
    - shared/core/src/deprecated/index.ts (if referenced)
  Test: npm run build:clean && npm run typecheck && npm test

Agent 3 [PARALLEL] [AGENT-SAFE]: Clean up test references to deleted code
  Check: grep for imports of deleted modules in test files
  Fix: Remove or update test files that import dead modules
  Test: npm run test:unit
```

**Expected result:** -4,427+ LOC removed, 1 hot-path performance fix

---

## Phase 2A: Deduplication Wave 1

**Risk:** LOW | **Gate:** `npm run typecheck && npm run test:unit && npm run test:integration`

### Wave 2A (4 parallel agents)

```
Agent 1 [PARALLEL] [AGENT-SAFE]: S-3 Consolidate IntervalManager
  Action:
    1. Compare APIs: shared/core/src/interval-manager.ts vs services/coordinator/src/interval-manager.ts
    2. Migrate coordinator to use @arbitrage/core's version
    3. Delete services/coordinator/src/interval-manager.ts
    4. Update coordinator/src/index.ts exports
  Test: npm test -- --testPathPattern="coordinator"

Agent 2 [PARALLEL] [AGENT-SAFE]: S-6 Consolidate env parsing
  Action:
    1. Create shared parseEnvInt(name, defaultVal, min?, max?) in @arbitrage/config or @arbitrage/core
    2. Create shared getStandbyConfig() for ADR-007 failover config
    3. Replace implementations in:
       - services/coordinator/src/index.ts (parseEnvInt + getStandbyConfigFromEnv)
       - services/mempool-detector/src/index.ts (validateNumericConfig)
       - shared/config/src/risk-config.ts (parseEnvInt)
       - services/execution-engine/src/index.ts (getStandbyConfigFromEnv)
       - shared/core/src/partition-service-utils.ts (parsePort - evaluate if consolidatable)
  Test: npm test -- --testPathPattern="(coordinator|mempool|execution|config)"

Agent 3 [PARALLEL] [AGENT-SAFE]: C-6 Consolidate ABI string literals
  Action:
    1. Extract shared ABI fragments in shared/config/src/service-config.ts
    2. const SHARED_ARBITRAGE_ABI = [executeArbitrage, calculateExpectedProfit, isApprovedRouter]
    3. Compose per-provider: [...SHARED_ARBITRAGE_ABI, specific_function]
  Test: npm test -- --testPathPattern="service-config"

Agent 4 [PARALLEL] [AGENT-SAFE]: S-2 Fix @shared/security
  Action:
    1. Add "@arbitrage/core": "*" to shared/security/package.json dependencies
    2. Rename package from @shared/security to @arbitrage/security (package.json name field)
    3. Update tsconfig path aliases if applicable
    4. Update 3 import sites in services/coordinator/
    5. Update services/coordinator/package.json dependency name
  Test: npm run build:deps && npm test -- --testPathPattern="(security|coordinator)"
```

**Expected result:** -270+ LOC, consistent utilities

---

## Phase 2B: Deduplication Wave 2

**Risk:** LOW | **Gate:** Same as 2A
**Dependencies:** S-5 depends on S-6 (env parsing). C-4 depends on S-3 (IntervalManager).

### Wave 2B (4 parallel agents)

```
Agent 1 [PARALLEL] [AGENT-SAFE]: C-2 Deduplicate timeout-guarded disconnect
  Action:
    1. Create disconnectWithTimeout(client, name, timeoutMs, logger) in @arbitrage/core
    2. Replace 8 instances in:
       - services/execution-engine/src/engine.ts (3x)
       - services/cross-chain-detector/src/detector.ts (2x)
       - services/coordinator/src/coordinator.ts (2x)
       - services/unified-detector/src/chain-instance.ts (1x)
  Test: npm test -- --testPathPattern="(engine|detector|coordinator|chain-instance)"

Agent 2 [PARALLEL] [AGENT-SAFE]: C-3 Consolidate null-check-stop-nullify
  Action:
    1. Evaluate Disposable[] array pattern OR accept as idiomatic
    2. If adopting pattern: create stopAndClear utility or Disposable interface
    3. Migrate 25+ instances across service stop() methods
  Test: npm test -- --testPathPattern="(engine|detector|coordinator|unified)"

Agent 3 [PARALLEL] [AGENT-SAFE]: C-4 Use IntervalManager for clearInterval
  Depends on: S-3 (IntervalManager consolidated)
  Action:
    1. In each service, register intervals via IntervalManager
    2. Replace 15+ clearInterval boilerplate with intervalManager.clearAll()
  Test: npm test -- --testPathPattern="(engine|detector|coordinator|unified|cross-chain)"

Agent 4 [PARALLEL] [AGENT-SAFE]: S-5 Partition-Solana factory alignment
  Depends on: S-6 (env parsing consolidated)
  Action:
    1. Use createPartitionEntry for base lifecycle in partition-solana
    2. Extract Solana RPC selection into helper module
    3. Keep Solana-specific detector initialization
  Test: npm test -- --testPathPattern="partition-solana"
```

**Expected result:** -420+ LOC, consistent service patterns

---

## Phase 3: Structural Improvements

**Risk:** MEDIUM | **Gate:** Full test suite + performance tests for Track A

### Track A [SEQUENTIAL] (1 agent, 3 steps):

```
Step 1 [AGENT-SAFE]: S-4 Service bootstrap deduplication
  Action:
    1. Create createServiceBootstrap(config, serviceFactory) in @arbitrage/core
    2. Migrate partition-asia-fast first (smallest, lowest risk)
    3. Verify tests pass
    4. Migrate remaining: coordinator, execution-engine, cross-chain, mempool, unified-detector
  Test per service: npm test -- --testPathPattern="<service-name>"
  Final: npm run test:integration

Step 2 [NEEDS-REVIEW]: C-8 BaseDetector removal (1,937 LOC)
  Action:
    1. Audit 3 test files: base-detector.test.ts, detector-integration.test.ts, cross-chain-alignment.test.ts
    2. Migrate unique test coverage to component-level tests
    3. Delete shared/core/src/base-detector.ts
    4. Remove export from index.ts
  Test: npm run test:unit && npm run test:integration

Step 3 [NEEDS-REVIEW]: C-1 (Modified) ChainDetectorInstance cold-path extraction
  CRITICAL: Only extract cold-path methods. DO NOT touch hot-path methods.
  Action:
    1. Extract to PairInitializationService (~400 LOC):
       - initializePairs()
       - generatePairAddress()
       - subscribeToEvents()
       - subscribeViaFactoryMode()
       - subscribeViaLegacyMode()
       - handlePairCreatedEvent()
    2. Extract simulation wrappers (~200 LOC) if not already extracted
    3. KEEP on class: handleSyncEvent, handleSwapEvent, emitPriceUpdate,
       checkArbitrageOpportunity, checkTriangularOpportunities, checkMultiLegOpportunities,
       createPairSnapshot, isSameTokenPair, isReverseOrder, getTokenPairKey
  Test: npm test -- --testPathPattern="chain-instance"
  Performance: npm run test:performance (verify no regression)
```

### Track B [PARALLEL with Track A] (1 agent):

```
Agent [AGENT-SAFE]: C-9 (Modified) Token pair pre-normalized variants
  Action:
    1. Add to shared/core/src/components/token-utils.ts:
       - isSameTokenPairPreNormalized(t0a, t1a, t0b, t1b): direct === comparison
       - isReverseOrderPreNormalized(pair1Token0, pair2Token0): return t0a !== t0b
    2. Have chain-instance.ts import pre-normalized variants
    3. Have simple-arbitrage-detector.ts import pre-normalized variants
    4. Remove private re-implementations from chain-instance.ts
    5. Keep private getTokenPairKey cache (different caching by design)
  Test: npm test -- --testPathPattern="(token-utils|chain-instance|simple-arbitrage)"
```

**Expected result:** -3,500+ LOC, cleaner architecture, hot-path preserved

---

## Phase 4: Conditional (Requires Benchmarking)

**Risk:** MEDIUM | **Gate:** Performance benchmarks must show <5% regression

### Step 1 [SEQUENTIAL] [NEEDS-REVIEW]: S-1/C-10 Barrel export migration

```
Migrate consumers to sub-entry points in 9 batches:
  Batch 1: Test files only (~50 files) — safest
  Batch 2: shared/ml consumers (4 files)
  Batch 3: shared/security consumers (3 files)
  Batch 4: partition services (4 services, ~8 files each)
  Batch 5: cross-chain-detector (10 files)
  Batch 6: mempool-detector (8 files)
  Batch 7: coordinator (8 files)
  Batch 8: unified-detector (15 files) — BENCHMARK before/after
  Batch 9: execution-engine (20 files) — BENCHMARK before/after

Gate per batch: npm run build:clean && npm run typecheck
Gate batches 8-9: npm run test:performance
```

### Step 2 [SEQUENTIAL]: S-8 Wildcard re-export cleanup

```
After S-1/C-10 migration progress:
  1. Replace export * from './internal' with explicit named exports
  2. Replace export * from './deprecated' with explicit named exports
  Gate: npm run build:clean && npm run typecheck && npm test
```

### Step 3 [SEQUENTIAL] [NEEDS-REVIEW]: C-7 ExecutionEngineService decomposition

```
  1. Profile executeOpportunity baseline latency
  2. Extract non-hot-path: health monitoring, AB testing init, Redis setup, API routes
  3. Keep executeOpportunity + strategy dispatch on main class
  4. Group nullable fields: SimulationState, InfraState
  Gate: executeOpportunity latency must stay within 15ms budget
```

---

## Summary: Agent Parallelization Map

```
PHASE 1:  [Agent 1] [Agent 2] [Agent 3]     ← 3 parallel
          ─────────────────────────────────
PHASE 2A: [Agent 1] [Agent 2] [Agent 3] [Agent 4]  ← 4 parallel
          ─────────────────────────────────────────
PHASE 2B: [Agent 1] [Agent 2] [Agent 3] [Agent 4]  ← 4 parallel (after 2A)
          ─────────────────────────────────────────
PHASE 3:  [Track A: S-4 → C-8 → C-1mod]            ← sequential
          [Track B: C-9mod]                          ← parallel with Track A
          ─────────────────────────────────
PHASE 4:  [S-1/C-10 → S-8 → C-7]                   ← sequential + benchmarks
```

**Max agents per wave:** 4 (Phase 2A/2B)
**Total distinct tasks:** 17
**Agent-safe tasks:** 14 (can be fully delegated)
**Needs-review tasks:** 3 (C-8, C-1mod, C-7 — require human judgment on hot-path boundaries)

---

## Quick Reference: Fix Commands

| Task | Skill/Command | Notes |
|------|---------------|-------|
| Phase 1 | `/fix-issues` with dead code list | Delete files + update barrel |
| Phase 2 | `/fix-issues` per dedup finding | Mechanical refactoring |
| Phase 3 | `/fix-issues` with MODIFIED proposals | Cold-path extraction only |
| Phase 4 | Manual + `/fix-issues` | Benchmark gates required |
| All | `npm run build:clean && npm run typecheck` | Run after every change |
| All | `npm run test:unit && npm run test:integration` | Regression check |
| Hot-path | `npm run test:performance` | Required for C-1mod, C-9mod, Phase 4 |
