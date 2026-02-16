# Deep Analysis Report: `shared/ml`

**Date**: 2026-02-16
**Package**: `@arbitrage/ml` - Machine Learning engine for price prediction and pattern recognition
**Scope**: 10 source files (~3,200 LOC), 9 test files (~4,500 LOC), ~240 test cases
**Analysis Method**: 6 parallel specialized agents + team lead cross-verification
**Agents**: architecture-auditor, bug-hunter, security-auditor, test-quality-analyst, mock-fidelity-validator, performance-refactor-reviewer

---

## Executive Summary

- **Total findings**: 31 (3 Critical, 8 High, 12 Medium, 8 Low)
- **Top 3 highest-impact issues**:
  1. **P0-1**: `extractFeatures()` returns shared pre-allocated array — all `PredictionResult.features` point to same mutable buffer (silent data corruption)
  2. **P0-2**: `predictBatch()` uses raw model output as confidence instead of softmax normalization — inconsistent behavior between batch/single paths
  3. **P0-3**: 2 of 9 test suites (`predictor.test.ts`, `orderflow-predictor.test.ts`) are **conditionally skipped in CI** — the most complex ML code has ZERO regression protection
- **Overall health grade**: **B-** (solid architecture, good defensive math, but shared-buffer bugs, CI coverage gaps, and security issues are serious)
- **Agent agreement map**: 4 areas of multi-agent consensus (see Cross-Agent Insights)

---

## Critical Findings (P0 - Security/Correctness/Financial Impact)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| P0-1 | Bug | `predictor.ts:664-739` | `extractFeatures()` returns `this.preallocatedFeatures` (shared mutable array). Every `PredictionResult.features` field points to the SAME array — subsequent calls overwrite previous results. Any code inspecting historical prediction features sees only the LATEST features. | Bug-hunter, Security, Perf-reviewer | HIGH | 4.6 |
| P0-2 | Bug | `orderflow-predictor.ts:897 vs :417-419` | `predictBatch()` sets `confidence = maxScore` (raw output, unbounded) while `predict()` uses softmax normalization (bounded 0-1). Same model produces different confidence values depending on call path. Downstream threshold filtering (default 0.6) behaves inconsistently. | Bug-hunter, Security | HIGH | 4.4 |
| P0-3 | Test Coverage | `predictor.test.ts`, `orderflow-predictor.test.ts` | Both suites use `describeOrSkip = process.env.RUN_SLOW_TESTS ? describe : describe.skip` — **1,850+ lines of tests** covering LSTM training, neural network prediction, online learning, and race conditions are SKIPPED in standard CI runs. | Test-quality, Mock-fidelity | HIGH | 4.4 |

### P0-1 Detailed Analysis

**6-Step Reasoning Chain**:
1. **Intent**: `extractFeatures()` extracts a feature vector for LSTM prediction. `Perf 10.2` pre-allocates the array to reduce GC pressure.
2. **Data Flow**: `preallocatedFeatures` (line 169) is allocated once in constructor. `extractFeatures()` resets it (line 669-671), fills it (lines 691-737), and returns the same reference (line 739).
3. **Assumption Violated**: Callers assume the returned array is owned by them. It's aliased to the class instance.
4. **Violation**: At `predictPrice():447`, the return includes `features` pointing to `this.preallocatedFeatures`. Next `predictPrice()` call overwrites it.
5. **Pattern**: Same issue in `orderflow-features.ts:314,400` — `toFeatureVector()` and `normalizeToBuffer()` return internal `Float64Array` directly.
6. **Impact**: Corrupted feature data in prediction results. Financial impact is indirect but affects model monitoring, accuracy tracking, and retraining decisions.

**Suggested Fix**: `return features.slice()` at `predictor.ts:739`. For orderflow: `return new Float64Array(this.featureBuffer)` at lines 314 and 400, or document that callers must copy.

### P0-2 Detailed Analysis

In `predict()` (line 417-419), raw direction scores go through softmax: `Math.exp(s)` -> normalize by sum. In `predictBatch()` (line 897), confidence is just `maxScore` (raw model output). Raw outputs can be any real number — negative, >1, etc. Batch predictions break `confidenceThreshold` (default 0.6) filtering. Additionally, `predictBatch` unconditionally stores all pending predictions (line 914) while `predict` only stores those above the confidence threshold (lines 437-439).

**Suggested Fix**: Apply identical softmax normalization in `predictBatch()`. Add the same confidence threshold check for pending prediction storage.

---

## High Findings (P1 - Security/Reliability/Coverage)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| P1-1 | Security | `model-persistence.ts:371-372` | **Path traversal**: `getModelDir()` joins `baseDir + modelId` without sanitization. `modelId` like `../../etc` allows file operations outside model directory. `deleteModel()` at line 329 uses `fs.rmSync({ recursive: true })` — could delete arbitrary directories. | Security | HIGH | 4.2 |
| P1-2 | Security | `model-persistence.ts:224-278`, `predictor.ts:295-351` | **No model integrity verification on load**: No hash/checksum on saved models. Tampered model weights produce manipulated predictions. Metadata (`JSON.parse` at line 396) has no runtime validation — future timestamps bypass staleness checks. | Security | HIGH | 4.0 |
| P1-3 | Test Coverage | `model-persistence.test.ts:175,227` | `loadModel()` happy path and `modelExists()` are **SKIPPED** (Windows path issue). Core model loading is untested. If loading breaks, every restart incurs 100-200s cold start. | Test-quality, Mock-fidelity | HIGH | 4.0 |
| P1-4 | Test Coverage | `orderflow-predictor.ts:838` | `predictBatch()` (~100 lines) is **completely untested** — zero test coverage for batch tensor creation, processing, and disposal. | Test-quality | HIGH | 3.8 |
| P1-5 | Bug | `predictor.ts:775-840` | **Duplicated math with behavioral differences**: Private methods `calculateVolatility`, `calculateTrend`, etc. duplicate `feature-math.ts` but differ subtly. `predictor.ts:806-818` doesn't check `prices[i] > 0` like `feature-math.ts:75`, allowing `Math.log(0)` = `-Infinity` to propagate. | Architecture, Bug-hunter | HIGH | 3.6 |
| P1-6 | Security | `predictor.ts:432` | **Unbounded predictedPrice**: LSTM model output `result[0]` used directly as `predictedPrice` without bounds/NaN check. Extreme values cascade through ensemble combiner to trading decisions. Compare: `fallbackPrediction` at line 872 checks `Number.isFinite()`, but ML path does not. | Security | HIGH | 3.4 |
| P1-7 | Performance | `model-persistence.ts:379-397` | **Sync I/O in async functions**: `ensureDir`, `writeJsonFile`, `readJsonFile` use `fs.existsSync`, `fs.mkdirSync`, `fs.writeFileSync`, `fs.readFileSync` despite being `async`. Blocks event loop during model save/load. | Architecture, Performance | HIGH | 3.4 |
| P1-8 | Bug | `feature-math.ts:321-322`, `predictor.ts:1173-1174` | **Stack overflow risk**: `Math.min(...sequence)` and `Math.max(...sequence)` throw RangeError for arrays >~100k elements. Exported functions may receive large inputs. | Bug-hunter | MEDIUM | 3.2 |

### P1-1 Suggested Fix
```typescript
private getModelDir(modelId: string): string {
  const sanitized = modelId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (sanitized !== modelId || sanitized.length === 0) {
    throw new Error(`Invalid modelId: ${modelId}`);
  }
  return path.join(this.config.baseDir, sanitized);
}
```

---

## Medium Findings (P2 - Maintainability/Performance/Correctness)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| P2-1 | Architecture | `ensemble-combiner.ts:349-360` | Manual direction mapping duplicates `DirectionMapper` from `direction-types.ts` which was created specifically for this (Fix 6.1/9.1). | Architecture, Performance | HIGH | 3.0 |
| P2-2 | Bug | `tf-backend.ts:415-446,458-479` | `withTensorCleanupAsync()` and `withTrackedTensorCleanup()` are documented as cleanup functions but explicitly state in comments they CANNOT clean up. They're monitoring wrappers. Misleading API. | Bug-hunter, Mock-fidelity | HIGH | 3.0 |
| P2-3 | Architecture | `orderflow-predictor.ts` vs ADR-025 | ADR-025 shows both `lstm-predictor/` and `orderflow-predictor/` model directories, but `OrderflowPredictor` has zero persistence code. Doc/implementation mismatch. | Architecture | HIGH | 3.0 |
| P2-4 | Code Quality | `ensemble-combiner.ts:129-130` | Weight normalization mutates `this.config` which is typed `readonly`. Violates intent. | Architecture | MEDIUM | 2.6 |
| P2-5 | Architecture | `predictor.ts:1105-1127` | `PatternRecognizer` reimplements `calculateReturns()`, `calculateVolumeChanges()`, `normalizeSequence()`, `cosineSimilarity()`, `trendSimilarity()` — all in `feature-math.ts`. | Architecture, Performance | HIGH | 2.6 |
| P2-6 | Performance | `orderflow-predictor.ts:401` | `Array.from(this.inputBuffer)` in `predict()` creates new array from pre-allocated buffer each call. Defeats pre-allocation purpose. Comment acknowledges this. | Performance | HIGH | 2.4 |
| P2-7 | Bug | `orderflow-predictor.ts:914` | Pending prediction keys use `prediction.timestamp + idx`. Artificial offset creates inaccurate time differences for validation. Collision risk if two batch calls happen within 1ms. | Bug-hunter | HIGH | 2.4 |
| P2-8 | Architecture | `predictor.ts` (LSTMPredictor) | Uses plain `predictionHistory` array for stats while `OrderflowPredictor` uses `SynchronizedStats` (Fix 4.1/5.2). Inconsistent pattern for the same concern. | Architecture | HIGH | 2.2 |
| P2-9 | Convention | `tf-backend.ts:138` | `process.env.NODE_ENV || 'development'` uses `||` instead of `??`. Empty string is a valid env value per CLAUDE.md conventions. | Architecture | HIGH | 2.0 |
| P2-10 | Convention | `ensemble-combiner.ts:189`, `predictor.ts:1065` | `this.stats.totalCombinations || 1` and `(volumeChanges[i] || 0)` use `||` instead of `??` per project conventions. | Bug-hunter | HIGH | 2.0 |
| P2-11 | Test Coverage | `model-persistence.ts` | `archiveVersion()`, `cleanOldVersions()` never tested. `atomicMove()` EXDEV fallback untested. Version management feature has zero coverage. | Test-quality | MEDIUM | 2.0 |
| P2-12 | Documentation | `feature-math.ts:64-83` | JSDoc says "Annualized volatility" but implementation returns standard deviation of log returns WITHOUT annualization factor. | Architecture | HIGH | 1.8 |

---

## Low Findings (P3 - Style/Minor Improvements)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| P3-1 | Refactoring | `predictor.ts` (1264 lines) | Largest file — contains both `LSTMPredictor` and `PatternRecognizer`. Could be split. | Performance | MEDIUM | 1.6 |
| P3-2 | Performance | `orderflow-features.ts:extractFeatures` | Creates `Date` object every call for time extraction. Could cache or accept pre-parsed time. | Performance | MEDIUM | 1.4 |
| P3-3 | Refactoring | Multiple test files | Mock whale activity summary and `createDefaultInput()` helper duplicated across `orderflow-predictor.test.ts` and `orderflow-features.test.ts` (~50 lines). | Performance | LOW | 1.4 |
| P3-4 | Refactoring | 5 test files | `@arbitrage/core` mock pattern (createLogger stub) is identical across 5 files. Could be a shared helper. | Performance | LOW | 1.2 |
| P3-5 | Test Quality | Multiple test files | TF.js mocking doesn't track tensor lifecycle — tensor leak bugs can't be caught in tests. | Mock-fidelity, Test-quality | MEDIUM | 1.0 |
| P3-6 | Refactoring | Multiple files | 6 singleton factories follow identical pattern. Could use generic `createConfigurableSingleton<T, C>()`. Low priority — current pattern is explicit and clear. | Performance | LOW | 1.0 |
| P3-7 | Config | `.env.example` | No ML-related config entries. `TF_FORCE_BACKEND` and `TF_ENABLE_NATIVE` only discoverable by reading source. | Architecture | HIGH | 1.0 |
| P3-8 | Test Perf | `orderflow-predictor.test.ts` | Training tests use `beforeEach` (creates+trains model per test) instead of `beforeAll`. ~24s wasted across 4 tests. | Performance | MEDIUM | 1.0 |

---

## Test Coverage Matrix

| Source File | Public Functions | Tested in CI? | Happy Path | Error Path | Edge Cases | Critical Gaps |
|-------------|-----------------|:---:|:---:|:---:|:---:|-------|
| `tf-backend.ts` | 11 | YES | Good | Good | Good | `withTensorCleanupAsync` minimal |
| `direction-types.ts` | 18 | YES | Excellent | Good | Excellent | None |
| `feature-math.ts` | 24 | YES | Excellent | Good | Excellent | None |
| `synchronized-stats.ts` | ~22 | YES | Excellent | Good | Excellent | None |
| `model-persistence.ts` | 7+class | YES | Partial | Good | Partial | `loadModel` SKIPPED, version mgmt untested |
| `predictor.ts` | 10+2 classes | **NO** (CI skip) | Good* | Good* | Good* | *All skipped in CI. Persistence untested. |
| `orderflow-features.ts` | 4+class | YES | Good | Good | Partial | `normalizeToBuffer` not directly tested |
| `orderflow-predictor.ts` | 6+class | **NO** (CI skip) | Good* | Good* | Good* | *All skipped in CI. `predictBatch` untested. |
| `ensemble-combiner.ts` | 4+class | YES | Good | Partial | Good | None significant |

## Mock Fidelity Matrix

| Mock Target | Files Using Mock | Fidelity | Notes |
|-------------|-----------------|----------|-------|
| `@tensorflow/tfjs` (persistence) | model-persistence.test.ts | Medium | Only `save`/`loadLayersModel` mocked. Adequate for persistence scope. |
| `@tensorflow/tfjs` (prediction) | predictor.test.ts, orderflow-predictor.test.ts | **Perfect** | Uses REAL TF.js — but tests are skipped in CI. |
| `@arbitrage/core` (logger) | 5 test files | Good | Consistent mock, matches real API. |
| `@arbitrage/core` (AsyncMutex) | predictor.test.ts, orderflow-predictor.test.ts | Excellent | Full mock with FIFO queue, double-release guard. |
| `@arbitrage/core` (WhaleTracker) | orderflow-features.test.ts, orderflow-predictor.test.ts | Good | Matches real `getActivitySummary()` interface. |
| `fs`/`path` | model-persistence.test.ts | **Real** | Uses real filesystem with temp directories. Correct approach. |

---

## Cross-Agent Insights

1. **Bug-hunter + Security-auditor + Performance-reviewer** (3-agent agreement on P0-1): All independently identified the shared buffer aliasing bugs as the highest-risk issue. Bug-hunter traced data flow, Security identified potential for prediction manipulation, Performance identified it originated from Perf 10.2 optimization.

2. **Architecture + Bug-hunter** (2-agent agreement on P1-5): Both flagged duplicated math functions. Architecture sees maintenance risk; Bug-hunter found the subtle behavioral difference (`prices[i] > 0` check missing in predictor's version) that makes this a real bug, not just a refactoring issue.

3. **Test-quality + Mock-fidelity** (2-agent agreement on P0-3): Both independently identified the CI test skip as the most impactful test quality issue. Mock-fidelity noted the tests use REAL TF.js (perfect fidelity) but this comes at the cost of being too slow for CI.

4. **Security + Bug-hunter** (2-agent agreement on P0-2): Both found the batch/single prediction inconsistency. Security framed it as a prediction integrity issue; Bug-hunter additionally found that `predictBatch` skips the confidence threshold check for pending prediction storage.

5. **Architecture finding explains Security finding**: The missing persistence in `OrderflowPredictor` (P2-3, Architecture) means SEC-02 (model integrity) only applies to LSTMPredictor currently. But if ADR-025 is implemented, the same vulnerability would apply to both predictors.

---

## Recommended Action Plan

### Phase 1: Immediate (P0 — fix before any production use)
- [ ] **P0-1**: Return `features.slice()` from `extractFeatures()` in `predictor.ts:739`. Return `new Float64Array(this.featureBuffer)` from `toFeatureVector()` and `normalizeToBuffer()` in `orderflow-features.ts:314,400`.
- [ ] **P0-2**: Apply softmax normalization in `predictBatch()` at `orderflow-predictor.ts:897`. Add confidence threshold check for pending prediction storage. Fix timestamp collision (use counter, not `timestamp + idx`).
- [ ] **P0-3**: Create lightweight TF.js mock for CI that enables running core prediction tests without real TF. Or use `@tensorflow/tfjs-core` CPU backend with shorter training (fewer epochs/samples) for CI.
- [ ] **P1-1**: Add `modelId` sanitization in `model-persistence.ts:371` to prevent path traversal.
- [ ] **P1-6**: Add `Number.isFinite()` check for `predictedPrice` in `predictor.ts:432`.

### Phase 2: Next Sprint (P1 — reliability and coverage)
- [ ] **P1-2**: Add SHA-256 hash of model files during save, verify on load. Add runtime metadata validation.
- [ ] **P1-3**: Fix Windows path normalization in model-persistence tests to un-skip `loadModel` and `modelExists` tests.
- [ ] **P1-4**: Add comprehensive test suite for `predictBatch()`.
- [ ] **P1-5**: Replace duplicate private math in `predictor.ts` with imports from `feature-math.ts`.
- [ ] **P1-7**: Replace sync I/O with `fs.promises` in `model-persistence.ts`.
- [ ] **P1-8**: Replace `Math.min(...seq)` with loop-based min/max in `feature-math.ts` and `predictor.ts`.

### Phase 3: Backlog (P2/P3 — maintenance, performance, consistency)
- [ ] **P2-1**: Use `DirectionMapper` from `direction-types.ts` in ensemble-combiner.
- [ ] **P2-2**: Rename `withTensorCleanupAsync`/`withTrackedTensorCleanup` to `monitorTensorCreation` or deprecate.
- [ ] **P2-3**: Implement persistence for OrderflowPredictor (per ADR-025) or update ADR.
- [ ] **P2-5**: Consolidate `PatternRecognizer` methods with `feature-math.ts`.
- [ ] **P2-6**: Investigate `tf.tensor` accepting `Float64Array` directly without `Array.from()`.
- [ ] **P2-8**: Migrate LSTMPredictor stats to `SynchronizedStats`.
- [ ] **P2-9/P2-10**: Replace `||` with `??` for numeric/env defaults in `tf-backend.ts:138`, `ensemble-combiner.ts:189`, `predictor.ts:1065`.
- [ ] **P2-11**: Add tests for version management and cross-device atomic move.
- [ ] **P2-12**: Fix `calculateVolatility()` JSDoc (say "std dev of log returns", not "annualized").
- [ ] **P3-1**: Split `predictor.ts` into `lstm-predictor.ts` and `pattern-recognizer.ts`.
- [ ] **P3-3/P3-4**: Extract shared test helpers for mock factories and `@arbitrage/core` mock.
- [ ] **P3-7**: Add `TF_FORCE_BACKEND`, `TF_ENABLE_NATIVE` to `.env.example`.
- [ ] **P3-8**: Change training tests from `beforeEach` to `beforeAll` where model can be shared.

---

## Confidence Calibration

- **P0 findings**: HIGH confidence — exact code traced, data flow verified, reproducible
- **P1-1** (path traversal): HIGH — `path.join()` with unsanitized input is a known vulnerability
- **P1-2** (model integrity): HIGH — no hash/signature code exists anywhere in the load path
- **P0-3** (CI skip): HIGH — grep confirms `describeOrSkip` pattern in both files
- **P2-12** (volatility doc): HIGH — read both JSDoc and implementation, no annualization
- **P3-2** (Date allocation): MEDIUM — V8 may optimize this; profile before fixing
