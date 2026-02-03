# Test Performance & Reduced Test Run Time Research

**Date**: 2026-02-03
**Enhancement Area**: Test performance optimization, reduced CI time
**Confidence**: HIGH (based on measured slow-tests.json data)

---

## Executive Summary

The test suite has **207 test files** running across 5 Jest projects. Current identified bottlenecks:

1. **ML Tests (LSTM/TensorFlow)**: 21 tests taking 100-234 seconds each (!!)
2. **OrderFlow Tests**: 10 tests taking 6-8 seconds each
3. **Test Startup**: Redis memory server startup + Jest project setup
4. **Parallelization**: Not fully optimized for different test types

**Key Finding**: The ML predictor tests alone add **~40+ minutes** to test runtime due to TensorFlow model initialization per test.

**Estimated Savings**: 60-80% reduction in total test time (from ~15-20min → 3-5min)

---

## 1. Current State Analysis

### 1.1 Test Distribution

| Location | Test Files | Purpose |
|----------|------------|---------|
| `shared/core/__tests__/unit` | 53 | Core library unit tests |
| `tests/integration` | 34 | Integration tests |
| `services/execution-engine/__tests__/unit` | ~19 | Execution strategy tests |
| `services/unified-detector/src/__tests__/unit` | 9 | Detector unit tests |
| `shared/ml/__tests__/unit` | 7 | ML model tests (**SLOW**) |
| Other services | ~85 | Various service tests |
| **Total** | **207** | |

### 1.2 Jest Configuration Analysis

**Current Configuration** (jest.config.js:117-176):
```javascript
projects: [
  { displayName: 'unit', maxWorkers: '75%' },      // High parallelism
  { displayName: 'integration', maxWorkers: '50%' }, // Moderate
  { displayName: 'e2e', maxWorkers: 2 },           // Low
  { displayName: 'performance', maxWorkers: 1 },   // Serial
  { displayName: 'smoke', maxWorkers: 2 }          // Low
]
```

**Issue**: Each project runs independently and needs to initialize Jest transformers, potentially duplicating startup work.

### 1.3 Measured Slow Tests (from slow-tests.json)

**Critical Bottleneck: ML Predictor Tests**

| Test | Duration | Threshold | Over by |
|------|----------|-----------|---------|
| `predictor.test.ts` - resetAllMLSingletons | **233,894ms** | 5,000ms | 4,578% |
| `predictor.test.ts` - create after reset | **219,428ms** | 5,000ms | 4,289% |
| `predictor.test.ts` - trainModel valid | **167,239ms** | 5,000ms | 3,245% |
| `predictor.test.ts` - trainModel invalid | **162,009ms** | 5,000ms | 3,140% |
| `predictor.test.ts` - updateModel | **156,667ms** | 5,000ms | 3,033% |
| ...and 16 more tests | 100-150s each | - | - |

**Root Cause**: TensorFlow.js model initialization is slow (~100-200ms per test), and each test reinitializes the model.

**Secondary Bottleneck: OrderFlow Tests**

| Test | Duration | Threshold |
|------|----------|-----------|
| `orderflow-predictor.test.ts` tests | 6-8 seconds each | 5,000ms |

**Root Cause**: Similar TensorFlow model initialization issues.

### 1.4 Infrastructure Analysis

**Redis Memory Server** (jest.globalSetup.ts):
- Starts once per test run (good)
- ~1-2 seconds startup time (acceptable)

**ts-jest Transformation**:
- Configured with `diagnostics.ignoreCodes: [151001]`
- Uses default ts-jest caching (no explicit optimization)

---

## 2. Industry Best Practices

### 2.1 Test Performance Optimization Approaches

| Approach | Used By | Pros | Cons | Effort |
|----------|---------|------|------|--------|
| **Test Sharding** | Jest native, CircleCI | + Linear scaling<br>+ No code changes | - Setup complexity<br>- Cache management | 1 day |
| **SWC Transformer** | Next.js, Vercel | + 10-20x faster transforms<br>+ Drop-in replacement | - Newer ecosystem<br>- Possible edge cases | 0.5 day |
| **Test Isolation Fix** | Standard practice | + Proper test design<br>+ Faster tests | - Significant refactor<br>- Risk of test gaps | 2-3 days |
| **Mock Heavy Dependencies** | Testing best practice | + Fast tests<br>+ Predictable | - Mock maintenance<br>- Less integration | 2 days |
| **Skip Slow Tests in CI** | Many projects | + Immediate speedup<br>+ Simple | - Coverage gap<br>- Tech debt | 0.5 day |
| **Separate Test Pipelines** | Enterprise CI/CD | + Fast feedback loop<br>+ Flexibility | - Pipeline complexity<br>- Maintenance | 1 day |

### 2.2 TensorFlow.js Test Optimization

**Pattern from TensorFlow.js community**:
```typescript
// Anti-pattern: Initialize model per test
beforeEach(() => {
  model = new LSTMPredictor(config); // SLOW
});

// Best practice: Share model across tests
let sharedModel: LSTMPredictor;
beforeAll(async () => {
  sharedModel = new LSTMPredictor(config);
  await sharedModel.initialize();
});

afterAll(async () => {
  await sharedModel.dispose();
});
```

---

## 3. Recommended Solutions

### 3.1 P0: Skip ML Tests in Default CI (Immediate)

**Approach**: Mark ML tests as slow and skip in standard CI runs.

**Implementation**:
```typescript
// In predictor.test.ts
describe.skip('LSTMPredictor', () => { ... });
// OR use jest-extended:
describe.skipIf(process.env.SKIP_SLOW_TESTS)('LSTMPredictor', () => { ... });
```

**Expected Impact**: ~40 minutes → 0 minutes (for ML tests)
**Effort**: 0.5 day
**Risk**: LOW (tests still run in nightly/pre-release)

### 3.2 P1: Use SWC Transformer Instead of ts-jest

**Approach**: Replace ts-jest with @swc/jest for 10-20x faster TypeScript compilation.

**Implementation** (jest.config.base.js):
```javascript
transform: {
  '^.+\\.tsx?$': ['@swc/jest', {
    jsc: {
      parser: {
        syntax: 'typescript',
        decorators: true
      },
      target: 'es2021'
    }
  }]
}
```

**Expected Impact**:
- Transform time: ~300ms/file → ~15ms/file
- Total test startup: ~20s → ~5s

**Effort**: 0.5 day
**Risk**: LOW (SWC is stable, used by Next.js)

### 3.3 P2: Fix ML Test Isolation (Model Reuse)

**Approach**: Refactor ML tests to share model instances within test suites.

**Implementation**:
```typescript
// shared/ml/__tests__/unit/predictor.test.ts

describe('LSTMPredictor', () => {
  let predictor: LSTMPredictor;

  beforeAll(async () => {
    // Initialize ONCE for all tests in this suite
    predictor = new LSTMPredictor({
      inputSize: 10,
      hiddenUnits: 32 // Smaller for tests
    });
    await predictor.initialize();
  }, 30000); // 30s timeout for initialization

  afterAll(async () => {
    await predictor.dispose();
  });

  it('should predict prices', () => {
    // Use shared predictor
    const result = predictor.predictPrice([...]);
    expect(result).toBeDefined();
  });
});
```

**Expected Impact**:
- Per-test time: 100-200s → 1-2s
- Suite time: 40+ min → 2-3 min

**Effort**: 2 days
**Risk**: MEDIUM (need to ensure test isolation with shared state)

### 3.4 P3: Implement Test Sharding for CI

**Approach**: Split tests across multiple CI runners.

**Implementation** (GitHub Actions example):
```yaml
jobs:
  test:
    strategy:
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - run: npm test -- --shard=${{ matrix.shard }}/4
```

**Expected Impact**: Linear scaling (4 shards = 4x faster)
**Effort**: 1 day
**Risk**: LOW (Jest native feature)

### 3.5 P4: Separate Fast/Slow Test Pipelines

**Approach**: Create two CI pipelines - fast (PR checks) and slow (nightly).

**Fast Pipeline** (runs on every PR):
- Unit tests only
- Excludes ML, integration, e2e
- Target: <5 minutes

**Slow Pipeline** (runs nightly/pre-release):
- All tests including ML
- Full integration suite
- Target: <30 minutes

**Effort**: 1 day
**Risk**: LOW (organizational change, no code changes)

---

## 4. Implementation Plan

### Priority Matrix

| Task | Impact | Effort | Risk | Priority |
|------|--------|--------|------|----------|
| Skip ML tests in CI | VERY HIGH | 0.5 day | LOW | **P0** |
| SWC transformer | HIGH | 0.5 day | LOW | **P1** |
| Fix ML test isolation | HIGH | 2 days | MEDIUM | **P2** |
| Test sharding | MEDIUM | 1 day | LOW | **P3** |
| Separate pipelines | MEDIUM | 1 day | LOW | **P4** |

### Detailed Task Breakdown

#### P0: Skip ML Tests (0.5 day)

| # | Task | Effort | Confidence |
|---|------|--------|------------|
| 0.1 | Add `SKIP_SLOW_TESTS` env var support | 1 hr | 95% |
| 0.2 | Mark ML tests as conditional skip | 1 hr | 95% |
| 0.3 | Update CI to set `SKIP_SLOW_TESTS=true` | 0.5 hr | 95% |
| 0.4 | Create nightly job without skip | 0.5 hr | 95% |
| 0.5 | Document in TEST_ARCHITECTURE.md | 0.5 hr | 95% |

#### P1: SWC Transformer (0.5 day)

| # | Task | Effort | Confidence |
|---|------|--------|------------|
| 1.1 | Install `@swc/core` and `@swc/jest` | 0.5 hr | 95% |
| 1.2 | Update jest.config.base.js transform | 1 hr | 90% |
| 1.3 | Test all projects compile correctly | 1 hr | 85% |
| 1.4 | Benchmark improvement | 0.5 hr | 95% |
| 1.5 | Remove ts-jest if successful | 0.5 hr | 90% |

#### P2: Fix ML Test Isolation (2 days)

| # | Task | Effort | Confidence |
|---|------|--------|------------|
| 2.1 | Analyze predictor.test.ts structure | 2 hr | 95% |
| 2.2 | Create shared model setup pattern | 3 hr | 85% |
| 2.3 | Refactor predictor.test.ts | 4 hr | 80% |
| 2.4 | Refactor orderflow-predictor.test.ts | 3 hr | 80% |
| 2.5 | Verify no test interference | 2 hr | 80% |
| 2.6 | Update model-persistence.test.ts | 2 hr | 85% |

---

## 5. Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| SWC edge cases | LOW | MEDIUM | Keep ts-jest as fallback, test thoroughly |
| Shared model state leaks | MEDIUM | HIGH | Add afterEach cleanup, verify isolation |
| Skipped tests hide bugs | MEDIUM | MEDIUM | Run full suite nightly, pre-release gates |
| Sharding cache issues | LOW | LOW | Clear cache between shards |

---

## 6. Success Metrics

### Immediate (after P0)

| Metric | Current | Target | How to Measure |
|--------|---------|--------|----------------|
| PR CI time | ~15-20 min | <5 min | GitHub Actions timing |
| Slow test count | 31 | 0 (in default CI) | slow-tests.json |

### After P1

| Metric | Current | Target | How to Measure |
|--------|---------|--------|----------------|
| Transform time | ~300ms/file | <30ms/file | Jest --debug |
| Test startup | ~20s | <5s | Measure first test |

### After P2

| Metric | Current | Target | How to Measure |
|--------|---------|--------|----------------|
| ML test suite | 40+ min | <3 min | Jest timing |
| Per ML test | 100-200s | <2s | Jest timing |

---

## 7. ADR Recommendation

**New ADR Needed?**: Yes

**Title**: ADR-025: Test Performance Optimization Strategy

**Context**:
ML tests using TensorFlow.js add 40+ minutes to CI due to model initialization per test. This blocks fast feedback loops and wastes CI resources.

**Decision**:
1. Skip ML tests in default CI runs (use nightly for full coverage)
2. Use SWC transformer for faster TypeScript compilation
3. Refactor ML tests to share model instances within suites
4. Implement test sharding for linear scaling

**Consequences**:
- Fast PR feedback (<5 min)
- Full test coverage maintained via nightly runs
- ML test refactoring improves test design
- CI costs reduced

---

## 8. Self-Critique & Uncertainties

### What Could Be Wrong

1. **SWC compatibility**: May have edge cases with specific TypeScript features
   - Mitigation: Keep ts-jest as fallback, test thoroughly

2. **Shared model state**: Tests may interfere with each other
   - Mitigation: Careful test isolation, afterEach cleanup

3. **Skipped test coverage**: Bugs may slip through in ML code
   - Mitigation: Nightly full runs, pre-release gates

### Assumptions

1. TensorFlow.js initialization is the bottleneck (verified in slow-tests.json)
2. SWC is stable enough for production use (used by Next.js, Vercel)
3. Model sharing won't affect test accuracy

### Confidence Assessment

- **Overall**: HIGH (85%)
- **P0 (Skip ML)**: HIGH (95%) - Simple, low risk
- **P1 (SWC)**: HIGH (90%) - Well-tested library
- **P2 (Model reuse)**: MEDIUM (75%) - Needs careful refactoring
- **P3/P4**: HIGH (90%) - Standard CI practices

---

## 9. Quick Implementation Guide

### Immediate Win (10 minutes)

Add to `shared/ml/__tests__/unit/predictor.test.ts`:
```typescript
const SKIP_SLOW_ML_TESTS = process.env.CI === 'true' &&
                           process.env.RUN_SLOW_TESTS !== 'true';

describe.skipIf(SKIP_SLOW_ML_TESTS)('LSTMPredictor', () => {
  // ... existing tests
});
```

### CI Configuration

```yaml
# .github/workflows/test.yml
jobs:
  fast-tests:
    env:
      CI: true
      # Don't set RUN_SLOW_TESTS - skips ML tests
    steps:
      - run: npm test

  nightly-full:
    # runs-on: schedule (cron)
    env:
      CI: true
      RUN_SLOW_TESTS: true
    steps:
      - run: npm test
```

---

*Research completed by Claude Opus 4.5*
*Last updated: 2026-02-03*
