# Test Architecture

**Date**: February 1, 2026
**Status**: Active
**Related**: ADR-009: Test Architecture

---

## Overview

This document describes the test architecture for the arbitrage project, including test organization, configuration best practices, and testing guidelines.

---

## Jest Configuration Best Practices

### Timeout Configuration

**❌ INCORRECT - Do not use `testTimeout` in project configurations:**

```javascript
projects: [
  {
    displayName: 'unit',
    testTimeout: 10000,  // ❌ Invalid - causes Jest warning
  }
]
```

**✅ CORRECT - Use setup files to configure timeouts:**

```javascript
projects: [
  {
    displayName: 'unit',
    setupFilesAfterEnv: [
      '<rootDir>/shared/test-utils/src/setup/jest-setup.ts',
      '<rootDir>/shared/test-utils/src/setup/jest.unit.setup.ts'  // Sets timeout
    ],
  }
]
```

Setup file example (`jest.unit.setup.ts`):
```typescript
jest.setTimeout(10000);  // 10 seconds for unit tests
```

### Timeout Guidelines

| Test Type | Timeout | Rationale |
|-----------|---------|-----------|
| Unit | 10s | Unit tests should be fast (<100ms ideal) |
| Integration | 60s | Allows for Redis/service startup |
| E2E | 120s | Full workflow execution |
| Performance | 300s | Benchmarking can be slow |
| Smoke | 30s | Quick validation checks |

Individual tests can override if needed:
```typescript
it('should handle long operation', async () => {
  jest.setTimeout(30000);  // 30s for this test only
  // test code
}, 30000);  // Also set in test signature
```

---

## Test File Naming Conventions

All test files MUST use the `.test.ts` extension (not `.spec.ts`).

**Naming pattern**: `[feature].[type].test.ts`

| Test Type | File Pattern | Example |
|-----------|--------------|---------|
| Unit | `[feature].test.ts` | `price-calculator.test.ts` |
| Integration | `[feature].integration.test.ts` | `redis-streams.integration.test.ts` |
| E2E | `[feature].e2e.test.ts` | `arbitrage-flow.e2e.test.ts` |
| Performance | `[feature].perf.test.ts` | `detector-throughput.perf.test.ts` |
| Smoke | `[feature].smoke.test.ts` | `service-startup.smoke.test.ts` |

**Rationale**: Single standard reduces cognitive load and simplifies configuration. The `.test.ts` extension is more common in the codebase and easier to remember than maintaining two patterns (`.test.ts` and `.spec.ts`).

**Integration test naming**: Integration tests MUST include `.integration` in the filename to clearly distinguish them from unit tests when both live in `__tests__/` directories.

---

## Test Organization

### Directory Structure

Tests are organized following ADR-009:

```
module-name/
├── __tests__/
│   ├── unit/          ← Unit tests
│   ├── integration/   ← Integration tests
│   └── helpers/       ← Test utilities
└── src/               ← Source code (no test files here)
```

### Test Categories

#### Unit Tests
- **Location**: `**/__tests__/unit/**/*.test.ts`
- **Purpose**: Test individual functions/classes in isolation
- **Characteristics**: Fast (<100ms), no external dependencies
- **Example**: `price-calculator.test.ts`

#### Integration Tests
- **Location**: `**/__tests__/integration/**/*.test.ts` or `tests/integration/**/*.test.ts`
- **Purpose**: Test component interactions
- **Characteristics**: Slower (<5s), may use Redis/test databases
- **Example**: `redis-streams.integration.test.ts`

#### E2E Tests
- **Location**: `tests/e2e/**/*.test.ts`
- **Purpose**: Test complete workflows end-to-end
- **Characteristics**: Slow (<2min), full system integration
- **Example**: `arbitrage-execution-flow.e2e.test.ts`

#### Performance Tests
- **Location**: `tests/performance/**/*.perf.ts`
- **Purpose**: Benchmark critical code paths
- **Characteristics**: Very slow (<5min), measures latency/throughput
- **Example**: `detector-throughput.perf.test.ts`

#### Smoke Tests
- **Location**: `tests/smoke/**/*.smoke.ts`
- **Purpose**: Quick validation of core functionality
- **Characteristics**: Fast (<30s), verifies system is operational
- **Example**: `service-startup.smoke.test.ts`

---

## Running Tests

### By Category
```bash
npm test -- --selectProjects unit          # Unit tests only
npm test -- --selectProjects integration   # Integration tests only
npm test -- --selectProjects e2e           # E2E tests only
npm test -- --selectProjects performance   # Performance tests only
npm test -- --selectProjects smoke         # Smoke tests only
```

### By Pattern
```bash
npm test -- --testNamePattern="price"      # Tests with "price" in name
npm test -- --testPathPattern="detector"   # Tests in files with "detector"
```

### With Coverage
```bash
npm test -- --coverage                     # All tests with coverage
npm test -- --coverage --selectProjects unit  # Unit tests with coverage
```

---

## Test Writing Guidelines

### Test Naming

- Use descriptive test names that explain **what** and **why**, not **how**
- Follow pattern: `should [expected behavior] when [condition]`

```typescript
// ❌ BAD
it('test calculatePrice', () => { /* ... */ });

// ✅ GOOD
it('should return null when reserves are zero', () => { /* ... */ });
```

### Test Structure

Use Given-When-Then pattern for clarity:

```typescript
it('should detect arbitrage when price difference exceeds threshold', () => {
  // Given: Two pairs with 5% price difference
  const pair1 = createPair({ price: 1.00 });
  const pair2 = createPair({ price: 1.05 });

  // When: Calculating arbitrage
  const opportunity = detectArbitrage(pair1, pair2);

  // Then: Should detect profitable opportunity
  expect(opportunity).not.toBeNull();
  expect(opportunity.profitPercentage).toBeGreaterThan(3);
});
```

### Test Isolation

- Each test should be independent
- Use `beforeEach` for setup, `afterEach` for cleanup
- Avoid shared state between tests
- Reset singletons after each test (handled automatically in `jest-setup.ts`)

### Redis Test Isolation

Use isolated Redis databases for integration tests to prevent conflicts:

```typescript
import { createIsolatedRedisClient, cleanupTestRedis } from '@arbitrage/test-utils';

describe('MyService Integration', () => {
  let redis;

  beforeAll(async () => {
    // Each test suite gets its own Redis database (0-15)
    redis = await createIsolatedRedisClient('my-service-tests');
  });

  afterAll(async () => {
    // Cleanup: flush database and disconnect
    await cleanupTestRedis(redis);
  });

  it('should store data in Redis', async () => {
    await redis.client.set('test-key', 'test-value');
    const value = await redis.client.get('test-key');
    expect(value).toBe('test-value');
  });
});
```

**Benefits**:
- Each test suite gets isolated database (0-15)
- No conflicts between parallel tests
- Automatic cleanup on teardown
- Works with real Redis instance
- Database assignment based on test suite name (deterministic)

**Alternative: Scoped helper**:
```typescript
import { createRedisTestSetup } from '@arbitrage/test-utils';

describe('MyService', () => {
  const { getClient, cleanup } = createRedisTestSetup('my-service');

  beforeAll(() => getClient());
  afterAll(cleanup);

  it('test with Redis', async () => {
    const redis = getClient();
    await redis.client.set('key', 'value');
  });
});
```

---

## Test Utilities

### Test Data Builders

Use builders from `@arbitrage/test-utils/builders` for creating test data:

```typescript
import { pairSnapshot, opportunity } from '@arbitrage/test-utils/builders';

const pair = pairSnapshot()
  .withDex('uniswap-v2')
  .withPrice(1.05)
  .build();

const opp = opportunity()
  .withProfitPercentage(5.0)
  .build();
```

### Custom Matchers

Available custom matchers:
- `toBeWithinRange(floor, ceiling)` - Check if number is in range
- `toBeValidAddress()` - Check if valid Ethereum address
- `toBeValidTxHash()` - Check if valid transaction hash
- `toCompleteWithin(ms)` - Check if async function completes within time
- `toBeApproximately(expected, precision)` - Floating point comparison

### Fake Timers

Use `withFakeTimers` for deterministic time-dependent tests:

```typescript
import { withFakeTimers } from '@arbitrage/test-utils';

it('should timeout after 5 seconds', async () => {
  await withFakeTimers(async () => {
    const promise = operationWithTimeout(5000);
    jest.advanceTimersByTime(5000);
    await expect(promise).rejects.toThrow('timeout');
  });
});
```

### Performance Monitoring

Track test performance over time using the slow test reporter:

```bash
# Run tests with performance tracking
npm test

# Analyze performance (run after tests)
npm run test:perf

# View slow test report
cat slow-tests.json
```

**Performance Thresholds**:
- **Unit tests**: <100ms (individual test)
- **Integration tests**: <5s (individual test)
- **E2E tests**: <30s (individual test)

Tests exceeding thresholds are reported in `slow-tests.json` and printed to console.

**Tracking Changes**:
The `analyze-performance.js` script compares current run with previous run:
- ✅ Performance improvement: Fewer slow tests
- ⚠️ Performance regression: More slow tests
- ➡️ No change: Same number of slow tests

Use this to catch performance regressions in CI/CD or during development.

---

## Test Initialization Best Practices

### When to Use `beforeEach` vs `beforeAll`

Choosing the right initialization pattern affects test performance and reliability.

**Use `beforeEach` when:**
- Tests mutate shared state
- Tests have side effects that affect other tests
- Object initialization is fast (<1ms)
- Uncertainty about test independence

**Use `beforeAll` when:**
- Tests are read-only (only call getters, query state)
- Object creation is expensive (>10ms)
- Tests are truly independent
- Adding `beforeEach` reset if needed

### Migration Pattern

**Before: `beforeEach` (safe but slow)**
```typescript
describe('MyService', () => {
  let service: MyService;

  beforeEach(() => {
    service = new MyService(); // Created 10 times for 10 tests
  });

  it('test 1', () => { /* read-only */ });
  it('test 2', () => { /* read-only */ });
  // ... 8 more tests
});
```

**After: `beforeAll + resetState` (fast)**
```typescript
import { createResetHook, Resettable } from '@arbitrage/test-utils';

describe('MyService', () => {
  let service: MyService;

  beforeAll(() => {
    service = new MyService(); // Created ONCE
  });

  beforeEach(createResetHook(() => service)); // Fast: just clear data

  afterAll(() => {
    service.cleanup?.(); // Important: cleanup resources
  });

  it('test 1', () => { /* read-only */ });
  it('test 2', () => { /* read-only */ });
  // ... 8 more tests
});
```

### Implementing `resetState()`

Classes should implement the `Resettable` interface for use with `beforeAll`:

```typescript
import { Resettable } from '@arbitrage/test-utils';

export class MyService implements Resettable {
  private cache = new Map<string, any>();
  private stats = { queriesExecuted: 0, errors: 0 };
  private client: RedisClient; // Expensive - don't recreate

  /**
   * Reset service state for test isolation
   * @internal For testing only
   */
  public resetState(): void {
    // Clear cached data
    this.cache.clear();

    // Reset counters
    this.stats = { queriesExecuted: 0, errors: 0 };

    // Don't recreate connections - that's the expensive part
    // Don't reset configuration - tests shouldn't change config
  }
}
```

**Guidelines**:
1. Only convert if initialization is measurably slow (>10ms)
2. Add `resetState()` method that clears data structures
3. Always add `afterAll` cleanup
4. Run tests 3 times to verify no flakiness
5. Don't recreate expensive resources (connections, clients)
6. Don't reset configuration (should be constant)

### Helper Utilities

The test-utils package provides helpers for managing state:

```typescript
import {
  Resettable,           // Interface for resettable classes
  verifyResettable,     // Assert object has resetState
  createResetHook,      // Create beforeEach reset hook
  resetStateHelper      // Helper for common reset patterns
} from '@arbitrage/test-utils';

// Manual reset for multiple instances
beforeEach(() => {
  serviceA.resetState();
  serviceB.resetState();
});

// Or use helper for single instance
beforeEach(createResetHook(() => service));

// Helper for implementing resetState
class MyService implements Resettable {
  private cache = new Map();
  private items: string[] = [];

  resetState(): void {
    resetStateHelper.clearCollections(this.cache, this.items);
  }
}
```

**When NOT to convert:**
- Individual test initialization is already fast (<1ms)
- Tests mutate shared state in complex ways
- Tests have external side effects (network, files, database)
- Adding resetState() would be complex or error-prone

**Goal**: Reduce total suite execution time and memory usage, not individual test time.

---

## Coverage Requirements

- **Target**: 80% line coverage, 70% branch coverage
- **Minimum**: 60% (enforced by jest.config.js)
- **Critical modules** (price calculation, arbitrage detection): 90%+ required

---

## References

- ADR-009: Test Architecture
- `jest.config.js` - Main configuration
- `jest.config.base.js` - Shared configuration
- `shared/test-utils/` - Test utilities and helpers
