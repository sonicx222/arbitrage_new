# Test Performance Optimization Research (2026-02-26)

## Problem
CI test suite takes ~15-20 min. Local runs also slow. 438 files, ~13,355 tests.

## Root Causes Identified

### 1. detector-lifecycle.test.ts — 27 tests x 10s timeout = 4.5 min wasted
- File: `services/cross-chain-detector/__tests__/unit/detector-lifecycle.test.ts`
- `jest.useFakeTimers()` active in beforeEach, but `service.stop()` in afterEach uses real timer-based `disconnectWithTimeout()`
- Every test hangs until 10s Jest timeout (from `services/cross-chain-detector/jest.config.js`)
- Fix: call `jest.useRealTimers()` BEFORE `service.stop()` in afterEach

### 2. ts-jest without `isolatedModules` — 5-10x slower transform
- `jest.config.base.js` line 24: no `isolatedModules` option
- tsconfig.json has `declaration: true`, `declarationMap: true`, `sourceMap: true` — all unnecessary for tests
- Fix: add `isolatedModules: true` to ts-jest config + create `tsconfig.test.json` with declarations/sourcemaps disabled

### 3. Massive test duplication
- 7 flash loan provider test files (~6,000 lines) — near-identical patterns
- 7 contract test files (~8,000 lines) — repeated deployment/access/router/emergency tests
- 8 simulation provider test files (~5,500 lines) — same structure
- 8 factory parser test files (~2,400 lines) — identical patterns
- Fix: parameterized test harnesses

### 4. CI sharding suboptimal
- Only 3 unit test shards for 377 files
- No `--onlyChanged` for PR runs
- No Jest cache in GitHub Actions

## Recommended Phases

### Phase 1: Quick Wins (1-2 days, saves 40-50%)
1. Fix detector-lifecycle fake timers → -4.5 min
2. Enable `isolatedModules: true` → -3-5 min (5-10x faster transform)
3. Create `tsconfig.test.json` (no declarations/sourcemaps) → -20-30% transform
4. Increase unit shards 3→5

**Target: CI 15-20 min → 7-10 min**

### Phase 2: Test Consolidation (5-8 days, saves 15-25%)
1. Flash loan provider test harness (7 files → 1 parameterized + 7 minimal overrides)
2. Contract test base harness (shared Hardhat fixture)
3. Parameterize factory parser tests (8→1)
4. Consolidate simulation provider tests

**Target: ~12,700 fewer lines, ~80 fewer files**

### Phase 3: CI Architecture (1-2 days, saves 30-50% on PRs)
1. `--onlyChanged` for PR runs (full suite on main merge only)
2. Cache Jest transform in GitHub Actions
3. Fix slow-test-reporter Windows path detection

**Target: PR runs 3-5 min**

## Rejected Approaches
- **Vitest migration**: 6-8 weeks, 330 `jest.mock()` rewrites, ADR-009 rejected it
- **SWC for all tests**: 129 files use `jest.mock()` factories incompatible with SWC
- **Reducing test count**: Coverage at 60% threshold, financial system needs thorough tests

## Slow Tests (from slow-tests.json)
- 27 tests in detector-lifecycle.test.ts: all exactly ~10,000ms (timeout)
- factory-functions.test.ts: 5-9s (complex warming component creation)
- hierarchical-cache.test.ts: 5-6s (cache hierarchy operations)
- mev-share-provider.test.ts: 7.6s
- tier2/tier3-optimizations.test.ts: 5-5.4s

## Key Numbers
- jest.mock() calls: 330 across 129 files
- jest.fn() calls: 3,223 across 229 files
- jest.spyOn() calls: 204 across 44 files
- jest.useFakeTimers() calls: 79 across 52 files
- jest.requireActual/requireMock: 61 across 28 files
- Slow tests (>5s): 37 detected in slow-tests.json

## Implementation Details

### 1.1: Fix detector-lifecycle.test.ts

```typescript
// BEFORE (hangs for 10s per test):
afterEach(async () => {
  try {
    if (service) await service.stop();
  } catch (e) { /* ignore */ }
  jest.useRealTimers();
});

// AFTER (completes instantly):
afterEach(async () => {
  jest.useRealTimers(); // Must restore BEFORE async stop
  try {
    if (service) await service.stop();
  } catch (e) { /* ignore */ }
});
```

### 1.2: Enable isolatedModules

In `jest.config.base.js`:
```javascript
transform: {
  '^.+\\.tsx?$': ['ts-jest', {
    tsconfig: 'tsconfig.test.json',
    isolatedModules: true,
    diagnostics: { ignoreCodes: [151001] }
  }]
}
```

### 1.3: Create tsconfig.test.json

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "declaration": false,
    "declarationMap": false,
    "sourceMap": false,
    "isolatedModules": true
  },
  "include": [
    "services/**/*.ts",
    "shared/**/*.ts",
    "tests/**/*.ts"
  ]
}
```

### 2.1: Flash Loan Provider Test Harness Pattern

```typescript
// shared/test-utils/src/harnesses/flash-loan-provider.harness.ts
export function testFlashLoanProvider(config: {
  name: string;
  ProviderClass: new (...args: any[]) => IFlashLoanProvider;
  poolAddress: string;
  feeBps: number;
  abiName: string;
  callbackName: string;
}) {
  describe(`${config.name} Flash Loan Provider`, () => {
    // 40+ shared tests: validation, fee calculation,
    // calldata building, gas estimation, error handling
  });
}

// Individual provider files become ~30 lines:
testFlashLoanProvider({
  name: 'AaveV3',
  ProviderClass: AaveV3FlashLoanProvider,
  poolAddress: AAVE_POOL,
  feeBps: 9,
  abiName: 'IPool',
  callbackName: 'executeOperation',
});
```

## Phase 2 Implementation Results

### 2.1: Factory Parser Test Harness (Task 6) — COMPLETE
Created `shared/test-utils/src/harnesses/factory-parser.harness.ts` (~250 lines).
Consolidated 7 parser test files into parameterized harness + minimal overrides.

| Parser Test File | Before | After | Saved |
|------------------|--------|-------|-------|
| v2-pair-parser.test.ts | 418 | 68 | 350 |
| v3-pool-parser.test.ts | 418 | 80 | 338 |
| algebra-parser.test.ts | 366 | 63 | 303 |
| solidly-parser.test.ts | 333 | 67 | 266 |
| trader-joe-parser.test.ts | 333 | 63 | 270 |
| balancer-v2-parser.test.ts | 340 | 72 | 268 |
| curve-parser.test.ts | 338 | 71 | 267 |
| **Totals** | **2,546** | **484 + 250 harness** | **1,812 net** |

### 2.2: Flash Loan Provider Test Harness (Task 7) — COMPLETE
Created `shared/test-utils/src/harnesses/flash-loan-provider.harness.ts` (~350 lines).
Consolidated 3 of 5 provider files (Aave V3 was already done; DAI Flash Mint and Morpho too different).

| Provider Test File | Before | After | Saved |
|--------------------|--------|-------|-------|
| aave-v3.provider.test.ts | 506 | 96 | 410 |
| balancer-v2.provider.test.ts | 1,109 | 100 | 1,009 |
| syncswap.provider.test.ts | 1,030 | 126 | 904 |
| **Totals** | **2,645** | **322 + 350 harness** | **1,973 net** |

Skipped: dai-flash-mint.provider.test.ts (EIP-3156 calldata too different), morpho.provider.test.ts (Morpho Blue calldata too different).

### 2.3: Simulation Provider Harness (Task 8) — SKIPPED
ROI too low: ~30-40% structural overlap but fundamentally different mock mechanisms (global.fetch, provider.call, Solana). Estimated ~300-400 lines savings not worth harness complexity.

### 2.4: Contract Test Shared Admin Helpers (Task 9) — COMPLETE
Created `contracts/test/helpers/shared-admin-tests.ts` (~455 lines).
Provides 6 reusable test functions: `testRouterManagement`, `testMinimumProfitConfig`, `testSwapDeadlineConfig`, `testPauseUnpause`, `testWithdrawToken`, `testWithdrawETH`.

| Contract Test File | Before | After | Saved |
|--------------------|--------|-------|-------|
| SyncSwapFlashArbitrage.test.ts | 1,929 | 1,536 | 393 |
| CommitRevealArbitrage.execution.test.ts | 1,345 | 1,161 | 184 |
| BalancerV2FlashArbitrage.callback-admin.test.ts | 1,306 | 1,072 | 234 |
| DaiFlashMintArbitrage.test.ts | 1,179 | 958 | 221 |
| **Totals** | **5,759** | **4,727 + 455 harness** | **577 net** |

Skipped: FlashLoanArbitrage.test.ts (admin tests mixed with unique logic), PancakeSwapFlashArbitrage.test.ts (non-standard Pause tests), BalancerV2FlashArbitrage.test.ts (too many extra granular router tests).

### Phase 2 Summary

| Harness | Files Changed | Net Lines Saved | Tests Added |
|---------|--------------|-----------------|-------------|
| Factory Parser | 7 | 1,812 | +7 (harness coverage) |
| Flash Loan Provider | 3 | 1,973 | +6 (harness coverage) |
| Contract Admin | 4 | 577 | +20 (harness coverage) |
| **Total** | **14** | **4,362** | **+33** |

All 616 contract tests pass. All 359 flash loan provider tests pass. All parser tests pass.

## Phase 3 Implementation Results

### 3.1: Fix slow-test-reporter Windows Path Detection (Task 10) — COMPLETE
File: `shared/test-utils/src/reporters/slow-test-reporter.ts`

**Problem**: `detectProject()` matched forward-slash patterns (`/__tests__/unit/`) but Jest on Windows provides backslash paths (`\__tests__\unit\`). All tests were classified as "unknown" project, making slow test thresholds meaningless on Windows dev machines.

**Fix**: Added path normalization: `const normalized = testPath.replace(/\\/g, '/');` before pattern matching. Also added missing `/__tests__/performance/` detection pattern.

**Verification**: `slow-tests.json` now correctly reports `{"byProject": {"unit": 2}}` instead of `{"byProject": {"unknown": 2}}`.

### 3.2: Add --changedSince for PR Runs (Task 11) — COMPLETE
File: `.github/workflows/test.yml`

**Changes to unit-tests and integration-tests jobs:**
- `fetch-depth: 100` for PRs (was `1`), keeps `1` for push/schedule
- Added "Fetch base branch for PR diff" step: `git fetch origin ${{ github.base_ref }} --depth=1`
- Conditional test command: PRs use `--changedSince=origin/${base_ref} --passWithNoTests`, push/schedule runs full suite

**Expected Impact**: PR runs skip unaffected tests, saving 30-50% execution time. `--passWithNoTests` prevents shard failures when no tests are affected.

### 3.3: Cache Jest Transform in GitHub Actions (Task 12) — COMPLETE
Files: `jest.config.base.js`, `.github/workflows/test.yml`

**Problem**: Jest's default `cacheDirectory` is `/tmp/jest_<hash>` on Linux, which is ephemeral in CI. The ts-jest transform cache (compiled TypeScript) was rebuilt from scratch on every CI run.

**Fix**:
1. Added `cacheDirectory: '<rootDir>/node_modules/.cache/jest'` to `projectConfig` in `jest.config.base.js` — all 6 project configs inherit this deterministic path
2. Added `actions/cache@v4` step to all 5 test jobs (unit, integration, e2e, performance, smoke)
3. Cache key: `jest-{project}-{shard}-{os}-{hashFiles('tsconfig.test.json', 'jest.config.base.js')}` — invalidates on config changes
4. Restore keys allow partial cache hits across shards

**Verification**: `npx jest --showConfig` confirms all 5 projects use `node_modules/.cache/jest`. Transform cache files (`jest-transform-cache-*`, `haste-map-*`) confirmed written to that directory.

**Expected Impact**: First CI run populates cache. Subsequent runs skip ts-jest compilation for unchanged files, saving 1-3 minutes per job.

### Phase 3 Summary

| Task | File(s) Changed | Impact |
|------|-----------------|--------|
| 3.1: Windows path fix | slow-test-reporter.ts | Correct project classification on Windows |
| 3.2: PR --changedSince | test.yml | 30-50% faster PR test runs |
| 3.3: Jest transform cache | jest.config.base.js, test.yml | 1-3 min savings per CI job |
| **Combined PR target** | | **PR runs: 3-5 min (from 15-20 min)** |

## Test Distribution by Service/Package

| Service/Package | Files | Test Cases |
|-----------------|-------|------------|
| shared/core | 191 | ~5,978 |
| services/execution-engine | 81 | ~2,035 |
| shared/config | 31 | ~1,205 |
| contracts | 18 | ~753 |
| services/unified-detector | 23 | ~477 |
| services/coordinator | 15 | ~486 |
| services/partition-solana | 10 | ~442 |
| services/cross-chain-detector | 13 | ~427 |
| tests (integration/e2e) | 17 | ~321 |
| shared/ml | 9 | ~331 |
| Other (mempool, infra, security, types) | 30 | ~900 |
