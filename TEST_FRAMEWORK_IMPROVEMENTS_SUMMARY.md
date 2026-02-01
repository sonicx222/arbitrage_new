# Test Framework Improvements - Quick Reference

**Full Report**: `docs/reports/TEST_FRAMEWORK_ENHANCEMENT_RESEARCH.md`

---

## Quick Stats

- **Test Files**: 100+ (unit, integration, e2e, performance, smoke)
- **Current Issues**: 91 failed test suites, 5 Jest config warnings, significant flakiness
- **Estimated Fix Time**: 3 weeks (120 hours)
- **Expected Speedup**: 50%+ (from ~10-15min to <3min)
- **Code Reduction**: ~3,500 lines of duplicate test code

---

## Critical Issues Found

### P0 - Blocking (Must Fix)
1. **Jest Config Warnings** - Invalid `testTimeout` in projects array (5 warnings per run)
2. **91 Failing Test Suites** - Health check config mismatches, missing files, assertion failures
3. **6 Duplicate Test Files** - Same tests in both `__tests__/` and `src/` (co-located legacy)

### P1 - High Priority (Flakiness)
1. **Timing-Dependent Tests** - No fake timers, exact timing expectations
2. **Singleton State Leakage** - Redis clients, loggers persist between tests
3. **Race Conditions** - Async operations without proper synchronization
4. **External Dependencies** - Tests fail if documentation files missing

### P2 - Medium Priority (Performance & Structure)
1. **Slow Execution** - Integration tests 15-20s each, full suite 10-15min
2. **Mixed Test Organization** - Some in `__tests__/`, some co-located with source
3. **Test Duplication** - Multiple tests covering same functionality
4. **Heavy Initialization** - Full service startup for every test case

---

## Quick Wins (Week 1)

### Fix Jest Configuration (2 hours)
```javascript
// ❌ WRONG - causes warnings
projects: [
  {
    displayName: 'unit',
    testTimeout: 10000,  // Not valid in project config!
    ...
  }
]

// ✅ CORRECT - use setup files
projects: [
  {
    displayName: 'unit',
    setupFilesAfterEnv: ['<rootDir>/jest.unit.setup.ts'],
    ...
  }
]

// jest.unit.setup.ts
jest.setTimeout(10000);
```

### Remove Duplicate Tests (4 hours)
Delete these files (tests exist in `__tests__/unit/`):
- `shared/security/src/rate-limiter.test.ts`
- `shared/security/src/auth.test.ts`
- `shared/security/src/validation.test.ts`

### Fix Failing Tests (4 hours)
1. Fix health check interval config: `shared/config/src/partitions.ts` (P1 should be 15000ms)
2. Create stub: `docs/IMPLEMENTATION_PLAN.md` or skip test if file missing
3. Fix comment pattern tests or remove documentation validation tests

---

## Implementation Roadmap

### Phase 1: Critical Fixes (Week 1)
- ✅ Fix Jest configuration warnings
- ✅ Fix 91 failing test suites
- ✅ Remove 6 duplicate test files
- **Outcome**: All tests pass, no warnings

### Phase 2: Structure & Organization (Week 2)
- ✅ Move all tests to `__tests__/` directories
- ✅ Create test helper library
- ✅ Consolidate integration tests
- ✅ Improve test naming
- **Outcome**: 2,000+ lines of test code removed, better structure

### Phase 3: Performance Optimization (Week 3)
- ✅ Optimize test initialization (beforeAll vs beforeEach)
- ✅ Create in-memory test doubles (Redis, worker threads)
- ✅ Configure test parallelization
- ✅ Add performance monitoring
- **Outcome**: Test execution 50% faster (<3 minutes total)

### Phase 4: Excellence (Month 2+)
- ⬜ Test tagging system (@slow, @requires-redis, @flaky)
- ⬜ Increase coverage to 80%+
- ⬜ Contract testing for microservices
- ⬜ Mutation testing (Stryker)
- **Outcome**: Testing excellence, high confidence

---

## Common Flaky Test Patterns & Fixes

### Pattern 1: Timing Assumptions
```typescript
// ❌ FLAKY
it('should timeout after 5s', async () => {
  const start = Date.now();
  await operation();
  const duration = Date.now() - start;
  expect(duration).toBeCloseTo(5000, -2);  // Flaky on slow CI
});

// ✅ RELIABLE
it('should timeout after 5s', async () => {
  await withFakeTimers(async () => {
    const promise = operation();
    jest.advanceTimersByTime(5000);
    await expect(promise).rejects.toThrow('timeout');
  });
});
```

### Pattern 2: Singleton State
```typescript
// ❌ FLAKY
it('test 1', async () => {
  const client = await getRedisClient();  // Global singleton
  await client.set('key', 'value');
  // State persists to next test!
});

// ✅ RELIABLE
afterEach(async () => {
  await resetAllSingletons();  // Already in jest-setup.ts ✅
});

// Or use DI pattern:
beforeEach(() => {
  mockRedis = createMockRedisInstance();
  client = new RedisClient({ redis: mockRedis });  // Inject mock
});
```

### Pattern 3: Async Race Conditions
```typescript
// ❌ FLAKY
it('should handle message', async () => {
  const promise = handler.waitForMessage();
  handler.onMessage({ data: 'test' });  // Race condition!
  await expect(promise).resolves.toBe('test');
});

// ✅ RELIABLE
it('should handle message', async () => {
  const promise = handler.waitForMessage();
  await new Promise(resolve => setImmediate(resolve));  // Flush queue
  handler.onMessage({ data: 'test' });
  await expect(promise).resolves.toBe('test');
});
```

---

## Test Organization Best Practices

### Directory Structure
```
shared/core/
  __tests__/
    unit/              ← Unit tests here
    integration/       ← Integration tests here
    helpers/           ← Test helpers here
  src/                 ← NO test files here!
```

### Test Naming
```typescript
// ❌ BAD: Technical, unclear why
it('should call calculatePriceFromReserves', () => { /* ... */ });

// ✅ GOOD: Behavior-focused, clear expectation
it('should return null when reserves are zero', () => { /* ... */ });
```

### Test Structure
```typescript
// ✅ GOOD: Given-When-Then structure
it('should detect arbitrage when price difference exceeds threshold', () => {
  // Given: Two pairs with 5% price difference
  const pair1 = builder().withPrice(1.00).build();
  const pair2 = builder().withPrice(1.05).build();

  // When: Calculating arbitrage
  const opportunity = calculateArbitrage(pair1, pair2);

  // Then: Should detect profitable opportunity
  expect(opportunity).toBeDefined();
  expect(opportunity.profitPercentage).toBeGreaterThan(3);
});
```

---

## Performance Optimization Checklist

- [ ] Replace `beforeEach` with `beforeAll` where possible (30% speedup)
- [ ] Use in-memory Redis for integration tests (50% speedup)
- [ ] Configure appropriate `maxWorkers` per project type (20% speedup)
- [ ] Mock heavy dependencies (workers, network calls) (40% speedup)
- [ ] Add test sharding for CI (75% speedup in CI)

---

## Test Quality Checklist

For every new feature, ensure:
- [ ] Unit tests for all public functions (100% coverage goal)
- [ ] Integration tests for key flows
- [ ] Edge case tests (null, undefined, empty, negative)
- [ ] No flaky tests (deterministic, no timing assumptions)
- [ ] No external dependencies in unit tests
- [ ] Clear test names (what/why, not how)
- [ ] Fast execution (<100ms unit, <5s integration)
- [ ] Uses test helpers/builders (minimal boilerplate)

---

## Success Metrics

| Metric | Current | Target (Phase 3) |
|--------|---------|------------------|
| Unit tests | ~30s | <10s |
| Integration tests | ~5-8min | <2min |
| Full suite | ~10-15min | <3min |
| Failed test suites | 91 | 0 |
| Config warnings | 5 | 0 |
| Duplicate tests | 6 files | 0 |
| Coverage | Unknown | 70%+ |

---

## Next Steps

1. **Immediate** (Week 1): Fix Jest config, fix failing tests, remove duplicates
2. **Short-term** (Week 2-3): Reorganize structure, optimize performance
3. **Long-term** (Month 2+): Increase coverage, add contract/mutation testing

**Start Here**: Use the `/fix-issues` workflow with the implementation plan

---

## 🚀 Using the /fix-issues Workflow

### Quick Start
```bash
# Fix all critical issues (Week 1)
/fix-issues "Fix all P0 issues from TEST_FRAMEWORK_FIXES_IMPLEMENTATION_PLAN.md"

# Fix by phase
/fix-issues "Fix Phase 1 issues from test framework plan"

# Fix individual issue
/fix-issues "Issue P0-1.1: Remove invalid testTimeout from Jest projects"
```

### Implementation Plan
📋 **Detailed Plan**: `.claude/plans/TEST_FRAMEWORK_FIXES_IMPLEMENTATION_PLAN.md`
- 28 discrete, actionable issues
- Organized by priority (P0, P1, P2, P3)
- Complete fix instructions for each issue
- Acceptance criteria and testing commands
- Dependencies mapped

🚀 **Quick Start Guide**: `.claude/plans/TEST_FIXES_QUICK_START.md`
- Commands for common workflows
- Success metrics per phase
- Troubleshooting guide
- Example usage session

---

## Related Documentation

- **Implementation Plan**: `.claude/plans/TEST_FRAMEWORK_FIXES_IMPLEMENTATION_PLAN.md` (28 issues)
- **Quick Start Guide**: `.claude/plans/TEST_FIXES_QUICK_START.md`
- **Full Research Report**: `docs/reports/TEST_FRAMEWORK_ENHANCEMENT_RESEARCH.md` (30+ pages)
- **Critical Fixes Checklist**: `CRITICAL_FIXES_CHECKLIST.md` (P0-3: Jest Config)

**Date**: February 1, 2026
