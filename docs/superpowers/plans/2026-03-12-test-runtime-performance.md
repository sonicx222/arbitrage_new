# Research Summary: Test Runtime Performance Optimization

## 1. Current State Analysis

### Measured Baseline (2026-03-12)
| Metric | Value |
|--------|-------|
| Unit test suites | 451 |
| Unit test cases | ~15,400 |
| Wall time (unit tests, 75% workers) | **108-119s** |
| Sum of all suite durations (CPU) | 687.6s |
| Effective parallelism | 5.8x |
| Median suite duration | 1.0s |
| Mean suite duration | 1.52s |
| Suites >10s | 9 (137.2s CPU = 20%) |
| Suites >5s | 14 (172.3s CPU = 25%) |
| Suites <1s | 227 (50%) |
| Integration test suites | 15 (serial, maxWorkers=1) |
| Transform engine | ts-jest (via `preset: 'ts-jest'`) |
| Transform cache size | 128MB (warm) |
| Worker model | child_process.fork() (default) |

### Top 9 Slowest Unit Suites (>10s each)
| # | Suite | Duration | Tests | ms/test |
|---|-------|----------|-------|---------|
| 1 | coordinator/sse.routes.test.ts | **30.2s** | 38 | 795 |
| 2 | core/mev-share-provider.test.ts | **21.0s** | 21 | 1000 |
| 3 | coordinator/dlq-handler.test.ts | **15.2s** | 14 | 1086 |
| 4 | core/warming-flow.test.ts | **12.7s** | 22 | 577 |
| 5 | coordinator/batch-handlers.test.ts | **12.4s** | 15 | 827 |
| 6 | core/pair-services.test.ts | **11.9s** | 62 | 192 |
| 7 | config/schemas.test.ts | **11.5s** | ~50 | 230 |
| 8 | config/token-staleness.test.ts | **11.2s** | ~20 | 560 |
| 9 | ee/opportunity.consumer.recovery.test.ts | **11.1s** | ~15 | 740 |

### How It Works
- **Root config**: `jest.config.js` defines 6 projects (unit, integration, e2e, performance, smoke, ml)
- **Transform**: ts-jest compiles `.ts` → JS per-worker with a persistent disk cache (`node_modules/.cache/jest/jest-transform-cache-*`)
- **Workers**: Jest forks N child processes (default 75% of CPU cores for unit tests), each loading the full module graph independently
- **Setup overhead per worker**: BigInt polyfill, env setup, singleton reset initialization (dynamic import of `@arbitrage/core`), factory resets
- **Per-test overhead**: `clearMocks + resetMocks + restoreMocks` (3 operations), plus `resetAllSingletons()` in `afterEach` (skipped 82% of the time via dirty-tracking)
- **Module graph**: Deep — `@arbitrage/core` re-exports ~20 submodules, each test file transitively compiles its full import tree

### Root Cause: Where Time Goes
1. **Worker startup + module loading** (~3-5s per new worker): Each child process bootstraps Node.js, loads Jest, compiles the test file + all imports via ts-jest
2. **ts-jest compilation** (cold: ~500ms-2s per file, warm cache: <50ms): First run after code changes recompiles affected files
3. **IPC serialization** (child_process fork model): Test results serialized between parent/child via JSON over stdout pipes
4. **Long-tail suites** (top 9 >10s): Heavy module mocking, large import graphs, or real timer waits blocking other work from being scheduled
5. **Integration tests serial** (maxWorkers=1): Redis key collisions force sequential execution

### Known Blockers (documented in `jest.config.base.js`)
- **@swc/jest blocked**: SWC doesn't hoist `jest.mock()` when `jest` is destructured from `@jest/globals` (affects all **214** files that import from it; 101 of those also call `jest.mock()`). Additionally, **55 files** have TDZ issues where hoisted mock factories reference `let`/`const` variables declared at module scope (the `jest.config.base.js` comment says "~29" but that only counted files where the declaration appears after the mock in source order — SWC hoists ALL factories above ALL `let`/`const` initializations)
- **`isolatedModules` tsconfig**: Code-ready but blocked by pre-commit hook reverting the tsconfig change

## 2. Industry Best Practices

| Approach | Used By | Pros | Cons | Effort |
|----------|---------|------|------|--------|
| **A. `--workerThreads`** | Jest 29+ default path | + Zero code changes, + 25% measured speedup, + No IPC overhead | - Slightly different isolation model | 0.5 days |
| **B. @swc/jest migration** | Vercel, Next.js, Turborepo | + 10-20x faster cold compile, + 30-50% faster warm runs | - 216 files need `@jest/globals` fix, - 29 TDZ variable fixes | 2-3 days |
| **C. Outlier suite optimization** | Standard practice | + Targets 20% of CPU in 2% of suites | - Manual per-suite investigation | 1-2 days |
| **D. `resetMocks` → `clearMocks` only** | Facebook, Meta | + Reduces per-test overhead | - Risk of mock state leaking between tests | 0.5 days |
| **E. Vitest migration** | Vite ecosystem | + 2-5x faster than Jest, + Native ESM | - 496 files to migrate, - Different API (minor) | 5-10 days |
| **F. Integration test parallelism** | Stripe, Shopify | + Unlocks parallel integration tests | - Requires per-suite Redis key prefixing | 2-3 days |
| **G. Test sharding (CI only)** | GitHub Actions, GitLab CI | + Near-linear scaling with runners | - Infrastructure cost | 0.5 days |

## 3. Recommended Solution

### Phased Approach: A → B → C (3 phases, cumulative)

**Phase 1 — `--workerThreads` (immediate, zero risk)**
- **Confidence**: HIGH (measured: 108s → 81-87s)
- **Justification**: Biggest impact-to-effort ratio. Zero code changes. Worker threads share the same V8 heap layout, eliminating IPC serialization overhead. Jest 29.7 supports this natively.
- **Expected Impact**: **108s → 83s (23% faster)**

**Phase 2 — @swc/jest migration (high impact, moderate effort)**
- **Confidence**: MEDIUM-HIGH (measured 32% cold improvement; warm improvement estimated 15-25%)
- **Justification**: @swc/core and @swc/jest are already installed in devDependencies. The fix is mechanical: remove `jest` from `@jest/globals` destructuring in 214 files (use global `jest` from `@types/jest` which is already a dependency). Fix 55 files with TDZ variables by converting `let`/`const` → `var` in mock factory closures.
- **Expected Impact**: **83s → 55-65s (20-35% further reduction)**
- **Why over Vitest**: Same magnitude of improvement, 1/5 the effort. Vitest requires rewriting every `jest.mock()` call to `vi.mock()`, changing matchers, and updating the entire CI pipeline.

**Phase 3 — Outlier suite optimization (targeted)**
- **Confidence**: MEDIUM (requires per-suite investigation)
- **Justification**: 9 suites >10s consume 137s CPU. The top outlier (sse.routes.test.ts, 30.2s) uses `@jest/globals` import + heavy module re-registration per test. Splitting into smaller files and reducing mock scope could halve their runtime.
- **Expected Impact**: **55-65s → 45-55s (10-15% further reduction)**

### Combined Projected Impact
| Phase | Wall Time | Reduction |
|-------|-----------|-----------|
| Current | 108-119s | — |
| Phase 1 (workerThreads) | 83-87s | -23% |
| Phase 2 (+@swc/jest) | 55-65s | -48% cumulative |
| Phase 3 (+outlier fixes) | 45-55s | -54% cumulative |

### Why NOT Each Alternative

- **D. `resetMocks` removal**: Saves ~2-5% but introduces subtle mock leakage risk. Not worth the debugging cost when Phases 1-3 provide 50%+ improvement.
- **E. Vitest**: Better long-term but 5-10 days of effort for a migration that can't be done incrementally. @swc/jest gives 80% of the benefit in 20% of the time.
- **F. Integration parallelism**: Only 15 test files, already fast at ~60s. Not the bottleneck.
- **G. Sharding**: Already configured (5 shards for unit). Useful in CI but doesn't help local dev.

### ADR Compatibility
- **ADR-009 (Test Architecture)**: Fully compatible — all changes are in Jest configuration and import patterns, not test structure
- **No ADR conflicts**: workerThreads and @swc/jest are drop-in replacements within Jest's supported configuration

## 4. Implementation Tasks

| # | Task | Effort | Confidence | Dependencies | Test Strategy |
|---|------|--------|------------|--------------|---------------|
| 1 | Enable `--workerThreads` in jest.config.js and run-tests.js | 0.5 days | 95% | None | Run full test suite 3x, compare pass/fail counts |
| 2 | Remove `jest` from `@jest/globals` imports in 214 test files | 1 day | 90% | None | Automated codemod + full suite verification |
| 3 | Fix 55 TDZ variable declarations in mock factories | 1 day | 85% | Task 2 | Run @swc/jest on affected files individually |
| 4 | Switch transform from ts-jest to @swc/jest in jest.config.base.js | 0.5 days | 85% | Tasks 2, 3 | Full suite: same pass/fail count as ts-jest baseline |
| 5 | Investigate and optimize top 5 outlier suites (>15s each) | 1-2 days | 70% | None (independent) | Per-suite before/after timing |
| 6 | Update run-tests.js, package.json scripts for new defaults | 0.25 days | 95% | Tasks 1, 4 | Verify all npm test scripts work |

### Task 1 Detail: `--workerThreads`
```js
// jest.config.js — add at root level:
workerThreads: true,

// scripts/run-tests.js — add flag:
'--workerThreads',
```

### Task 2 Detail: @jest/globals Fix (Codemod)
```bash
# Before (214 files):
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

# After:
import { describe, it, expect, beforeEach } from '@jest/globals';
# jest is now the global from @types/jest (already available)
```
This is safe because `@types/jest` declares `jest` as a global. The `@jest/globals` export is identical — it's the same object. The only difference is SWC can hoist `jest.mock()` when `jest` is global but not when it's an ES import binding.

### Task 3 Detail: TDZ Fix (55 files)
The background research agent identified all 55 files with module-scope `let`/`const` variables referenced inside `jest.mock()` factories. Key clusters:
- `services/execution-engine/` — 12 files (heaviest: `strategy-initializer.test.ts` with 11 variables)
- `shared/core/` — 16 files
- `services/unified-detector/` — 5 files
- `services/coordinator/` — 3 files
- `services/partition-*/` — 4 files
- `shared/ml/` — 3 files, `shared/security/` — 1 file, `services/cross-chain-detector/` — 2 files, `services/monolith/` — 1 file, `services/partition-solana/` — 3 files

Full file list preserved in agent transcript.

### Task 3 Detail: TDZ Variable Fix
```typescript
// Before (TDZ error under SWC):
const mockLogger = { info: jest.fn(), error: jest.fn() };
jest.mock('./logger', () => ({ getLogger: () => mockLogger }));

// After (works with SWC hoisting):
var mockLogger: any;
beforeEach(() => { mockLogger = { info: jest.fn(), error: jest.fn() }; });
jest.mock('./logger', () => ({ getLogger: () => mockLogger }));
```

## 5. Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| workerThreads breaks SharedArrayBuffer tests | LOW | MEDIUM | Those tests already use worker_threads internally; Jest workerThreads is a different concern (test runner isolation). Run full suite to verify |
| @swc/jest mock hoisting differs subtly | MEDIUM | MEDIUM | Run full test suite with @swc/jest and compare pass/fail counts. SWC mock hoisting is battle-tested in Next.js ecosystem |
| TDZ fix scope larger than expected (55 files, not 29) | MEDIUM | LOW | `var` hoisting only affects the mock factory closure timing. The actual mock values are set in `beforeEach` regardless. Mechanical change, each file individually verifiable |
| Windows worker thread stability | LOW | MEDIUM | Jest 29.7 workerThreads is stable on Windows. Monitor for EMFILE or exitCode=143 crashes in CI |
| Outlier optimization breaks test isolation | MEDIUM | LOW | Each suite optimization is independent. Run affected suite before/after |

## 6. Success Metrics

- [ ] **Unit test wall time**: 108s → <60s (measured on same machine, 75% workers)
- [ ] **Cold start time** (no cache): ~200s → <90s (measured with `--no-cache`)
- [ ] **Test pass/fail parity**: Same number of passing/failing tests before and after
- [ ] **CI pipeline time**: Measure `test:unit` step before/after in GitHub Actions
- [ ] **No new test flakiness**: Run suite 10x, confirm same failure set

## 7. ADR Recommendation

**New ADR Needed?** No — these are configuration/tooling changes within the existing test architecture (ADR-009). A brief note in ADR-009 about the @swc/jest migration rationale would be appropriate.

---

## Appendix: Raw Benchmarks

### workerThreads Benchmark (measured 2026-03-12)
```
Without --workerThreads (child_process fork):
  Run 1: 107.998s  |  Run 2: 119.424s  (variance due to Windows scheduler)

With --workerThreads:
  75% workers: 81.098s, 87.473s
  100% workers: 83.954s

Speedup: 23-25%
```

### @swc/jest vs ts-jest Benchmark (single file, no cache)
```
ts-jest (no cache):  12.434s Jest time / 22.5s wall
@swc/jest (no cache): 0.628s Jest time /  7.0s wall

Speedup: 19.8x (Jest time), 3.2x (wall)
```

### @swc/jest vs ts-jest Benchmark (41 files, no cache, workerThreads)
```
ts-jest (no cache, workerThreads):  17.314s Jest time / 23.2s wall
@swc/jest (no cache, workerThreads): 11.749s Jest time / 16.9s wall

Speedup: 1.47x (Jest time), 1.37x (wall)
```

### Suite Duration Distribution
```
<1s:    227 suites (50%)
1-2s:   179 suites (40%)
2-5s:    31 suites (7%)
5-10s:    5 suites (1%)
>10s:     9 suites (2%) — accounts for 20% of total CPU time
```
