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

### Assertion Messages

Add explanatory messages to non-obvious assertions:

```typescript
// ❌ BAD - No context
expect(breaker.isOpen()).toBe(true);

// ✅ GOOD - Clear reason
expect(breaker.isOpen()).toBe(true,
  'Circuit should block executions after threshold to prevent cascade');
```

**When to add messages**:
- Business logic assertions
- State transition assertions
- Threshold/boundary checks
- Security-critical assertions

**When NOT to add messages** (already obvious):
- `expect(result).toBeDefined()`
- `expect(array).toHaveLength(3)`
- `expect(response.status).toBe(200)`

### Mock Factory Documentation

Document mock factories to help developers understand what's mocked and how to use them:

```typescript
/**
 * Creates a mock [component] for testing [feature].
 *
 * **Mock Configuration:**
 * - [List what's mocked and default behaviors]
 * - [Explain what's NOT mocked (if relevant)]
 *
 * **Purpose:**
 * [Why this mock exists / what scenarios it supports]
 *
 * **Usage:**
 * ```typescript
 * const mock = createMock();
 * expect(mock.method).toHaveBeenCalled();
 * ```
 *
 * **Customization:**
 * ```typescript
 * mock.method.mockReturnValue(customValue);
 * ```
 */
const createMockComponent = () => ({
  method: jest.fn(),
  // ...
});
```

**Benefits**:
- Future developers know what each mock provides
- Usage examples show common patterns
- Customization section explains flexibility

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

## Three-Level Integration Testing Strategy

**Date Added**: February 4, 2026
**Status**: Active - Replaces mock-heavy integration tests

### Overview

Integration tests in this project follow a **three-level strategy** that balances speed with realism. **All levels use real in-memory Redis** (via `redis-memory-server`) instead of mocks.

**Key Principle**: ❌ **No MockRedisClient** - Use `createIsolatedRedisClient()` for all Redis testing.

### Why This Approach?

**Previous Problem**:
- Many "integration" tests used elaborate MockRedisClient implementations (180+ lines)
- Mocks don't test real Redis behavior (serialization, atomicity, TTL, race conditions)
- High maintenance burden (update mocks when Redis behavior changes)

**Solution**:
- Eliminate all Redis mocks
- Use real in-memory Redis (fast, ~50-100ms overhead)
- Define three clear levels based on scope and dependencies

---

### Level 1: Component Integration

**Purpose**: Test internal component orchestration with real Redis, mock external APIs

**When to Use**:
- Testing multiple internal classes working together
- Business logic spanning multiple components
- Data flow transformations
- Redis operations (streams, locks, caching)

**What to Mock**: External APIs (blockchain RPCs, price feeds, third-party services)
**What NOT to Mock**: Redis, internal services

**File Pattern**: `**/__tests__/integration/**/*.test.ts` or `**/__tests__/integration/level1/**/*.test.ts`

**Speed Target**: <30s per suite

**Example**:
```typescript
import { createIsolatedRedisClient, cleanupTestRedis } from '@arbitrage/test-utils';
import { createMockProvider } from '@arbitrage/test-utils/mocks';

describe('[Level 1] CrossChainDetector Component Integration', () => {
  let redis: IsolatedRedisClient;
  let detector: CrossChainDetector;

  beforeAll(async () => {
    // Real in-memory Redis (NOT mocked)
    redis = await createIsolatedRedisClient('cross-chain-detector-component');

    detector = new CrossChainDetector({
      redis, // Real Redis
      provider: createMockProvider() // Mock external blockchain API
    });
  });

  afterAll(async () => {
    await cleanupTestRedis(redis);
  });

  it('should detect opportunity and store in real Redis', async () => {
    await detector.detectOpportunity(priceUpdate);

    // Read from REAL Redis to verify serialization
    const opportunities = await redis.xRead(
      'STREAMS', 'stream:opportunities', '0'
    );

    expect(opportunities).toHaveLength(1);
    expect(JSON.parse(opportunities[0].data)).toMatchObject({
      token: 'WETH/USDC',
      profitPercentage: expect.any(Number)
    });
  });

  it('should handle concurrent operations with real Redis atomicity', async () => {
    // Test that was IMPOSSIBLE with mocks - real concurrent access
    const results = await Promise.all([
      detector.detectOpportunity(opp1),
      detector.detectOpportunity(opp2),
      detector.detectOpportunity(opp3)
    ]);

    // Real Redis ensures atomic operations
    const count = await redis.get('opportunity:count');
    expect(count).toBe('3');
  });
});
```

---

### Level 2: Service Integration

**Purpose**: Test complete service behavior with real infrastructure, minimal mocking

**When to Use**:
- Testing full service lifecycle (start, process, stop)
- Redis Streams consumption patterns
- Distributed locking behavior
- State persistence and recovery
- Service-to-service communication

**What to Mock**: External APIs where necessary (blockchain forks are expensive)
**What NOT to Mock**: Redis, internal message passing, state management

**File Pattern**: `**/__tests__/integration/**/*.service.integration.test.ts` or `**/__tests__/integration/level2/**/*.test.ts`

**Speed Target**: <2min per suite

**Example**:
```typescript
import { createIsolatedRedisClient, cleanupTestRedis } from '@arbitrage/test-utils';

describe('[Level 2] Coordinator Service Integration', () => {
  let redis: IsolatedRedisClient;
  let coordinator1: CoordinatorService;
  let coordinator2: CoordinatorService;

  beforeAll(async () => {
    redis = await createIsolatedRedisClient('coordinator-service');
  });

  afterAll(async () => {
    await coordinator1?.stop();
    await coordinator2?.stop();
    await cleanupTestRedis(redis);
  });

  it('should elect leader using real Redis distributed locks', async () => {
    // Test REAL distributed locking (impossible with mocks)
    coordinator1 = new CoordinatorService({ redis });
    coordinator2 = new CoordinatorService({ redis });

    await Promise.all([
      coordinator1.start(),
      coordinator2.start()
    ]);

    // Real Redis lock atomicity ensures only one leader
    expect(coordinator1.isLeader !== coordinator2.isLeader).toBe(true);

    const leaders = [coordinator1, coordinator2].filter(c => c.isLeader);
    expect(leaders).toHaveLength(1);
  });

  it('should consume Redis Streams with real XREADGROUP', async () => {
    coordinator1 = new CoordinatorService({ redis });
    await coordinator1.start();

    // Publish to REAL Redis Stream
    await redis.xAdd('stream:opportunities', '*', {
      data: JSON.stringify({ token: 'WETH', profit: 100 })
    });

    // Wait for REAL stream consumption
    await waitFor(() => coordinator1.getProcessedCount() > 0, 5000);

    expect(coordinator1.getProcessedCount()).toBe(1);
  });

  it('should handle TTL expiration correctly', async () => {
    // Test that was difficult with mocks - real TTL behavior
    await redis.set('temp:key', 'value', { EX: 1 }); // 1 second TTL

    expect(await redis.get('temp:key')).toBe('value');

    await new Promise(resolve => setTimeout(resolve, 1500));

    expect(await redis.get('temp:key')).toBeNull(); // Real expiration
  });
});
```

---

### Level 3: System E2E Integration

**Purpose**: Test complete user journeys with all real dependencies

**When to Use**:
- Critical end-to-end workflows
- Deployment validation
- Production readiness verification
- Cross-service integration flows

**What to Mock**: Minimize mocking - use Anvil forks for blockchain, real Redis
**What NOT to Mock**: Redis, internal services, core infrastructure

**File Pattern**: `tests/e2e/**/*.e2e.test.ts` or `**/__tests__/integration/level3/**/*.test.ts`

**Speed Target**: <5min per suite

**Example**:
```typescript
import { startTestSystem, stopTestSystem } from '@arbitrage/test-utils/e2e';

describe('[Level 3] Arbitrage Execution Flow E2E', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    // Start full system: Redis + Anvil fork + all services
    testEnv = await startTestSystem({
      redis: 'memory', // Real in-memory Redis
      fork: 'ethereum',
      services: ['coordinator', 'detector', 'execution-engine']
    });
  }, 60000);

  afterAll(async () => {
    await stopTestSystem(testEnv);
  });

  it('should detect and execute arbitrage end-to-end', async () => {
    // Set up price discrepancy on real fork
    await testEnv.anvil.setPrice('UNISWAP_WETH_USDC', 2500);
    await testEnv.anvil.setPrice('SUSHISWAP_WETH_USDC', 2550);

    // Wait for real detection
    const opportunity = await testEnv.detector.waitForOpportunity({
      timeout: 30000
    });

    expect(opportunity.profitPercentage).toBeGreaterThan(1);

    // Wait for real execution
    const execution = await testEnv.executionEngine.waitForExecution({
      opportunityId: opportunity.id,
      timeout: 60000
    });

    // Verify real on-chain result
    const receipt = await testEnv.anvil.getTransactionReceipt(execution.txHash);
    expect(receipt.status).toBe(1);
  });
});
```

---

### Comparison Table

| Aspect | Level 1 (Component) | Level 2 (Service) | Level 3 (System E2E) |
|--------|---------------------|-------------------|----------------------|
| **Redis** | Real (in-memory) | Real (in-memory) | Real (in-memory or dedicated) |
| **External APIs** | Mocked | Mostly mocked | Real (Anvil fork) |
| **Services** | Individual components | Full service | All services |
| **Speed** | <30s | <2min | <5min |
| **Parallelization** | High (75% workers) | Medium (50% workers) | Serial (1 worker) |
| **When to Use** | Component logic | Service behavior | End-to-end flows |

---

### Migration from MockRedisClient

**Before (Bad - 180 lines of mock code)**:
```typescript
class MockRedisClient {
  private store: Map<string, string> = new Map();

  async set(key: string, value: string, options?: any) {
    // ... 40 lines of mock logic
  }

  async get(key: string): Promise<string | null> {
    // ... 20 lines of mock logic
  }

  // ... 120 more lines of mock methods
}

describe('Integration Test', () => {
  let mockRedis: MockRedisClient;

  beforeEach(() => {
    mockRedis = new MockRedisClient();
  });

  it('test with mock Redis', async () => {
    await mockRedis.set('key', 'value');
    // Doesn't test real serialization, TTL, atomicity, etc.
  });
});
```

**After (Good - 0 lines of mock code, real Redis)**:
```typescript
import { createIsolatedRedisClient, cleanupTestRedis } from '@arbitrage/test-utils';

describe('Integration Test', () => {
  let redis: IsolatedRedisClient;

  beforeAll(async () => {
    redis = await createIsolatedRedisClient('integration-test');
  });

  afterAll(async () => {
    await cleanupTestRedis(redis);
  });

  it('test with real Redis', async () => {
    await redis.set('key', 'value');
    // Tests REAL Redis behavior: serialization, TTL, atomicity, race conditions
  });
});
```

**Benefits**:
- ✅ 180 lines of mock code → 0 lines
- ✅ Tests real Redis behavior (catches serialization bugs, race conditions)
- ✅ No mock maintenance burden
- ✅ Still fast (~50-100ms overhead vs ~10ms with mocks)
- ✅ Catches bugs that mocks would miss

---

### Best Practices

**DO**:
- ✅ Always use `createIsolatedRedisClient()` for Redis in integration tests
- ✅ Clean up with `cleanupTestRedis()` in `afterAll()`
- ✅ Test serialization round-trips (write → read → verify)
- ✅ Test concurrent operations where relevant
- ✅ Use `beforeAll()` for Redis setup (faster than `beforeEach()`)
- ✅ Choose the simplest level that validates the behavior

**DON'T**:
- ❌ Never create MockRedisClient or similar mock implementations
- ❌ Don't use `beforeEach()` for Redis setup (slow, unnecessary)
- ❌ Don't mock Redis for "speed" - in-memory Redis is fast enough
- ❌ Don't skip testing race conditions because mocks made it hard
- ❌ Don't test everything in Level 3 - use Level 1-2 for component logic

---

### Troubleshooting

**Test flakiness with real Redis**:
- Ensure proper database isolation (each suite gets unique DB 0-15)
- Use unique key prefixes if sharing databases
- Always clean up in `afterAll()`, not `afterEach()`
- Check for leaked connections (use `redis.isOpen` before operations)

**Slow tests**:
- Move expensive operations to `beforeAll()` instead of `beforeEach()`
- Use Level 1 instead of Level 2 where possible
- Parallelize test suites (Jest runs suites in parallel)
- Consider if test belongs in unit tests instead

**CI failures**:
- Verify `redis-memory-server` starts correctly in CI
- Check `jest.globalSetup.ts` and `jest.globalTeardown.ts` are running
- Ensure adequate timeout (60s for integration tests)
- Check for port conflicts if running parallel CI jobs

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
