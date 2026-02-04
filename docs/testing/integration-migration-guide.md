# Integration Test Migration Guide

**Date**: February 4, 2026
**Status**: Active
**Related**: docs/architecture/TEST_ARCHITECTURE.md - Three-Level Integration Testing

---

## Overview

This guide shows how to migrate integration tests from MockRedisClient to real in-memory Redis using the three-level testing strategy.

**Goal**: Eliminate all Redis mocks and use `createIsolatedRedisClient()` for all integration tests.

---

## Why Migrate?

### Problems with MockRedisClient

❌ **High Maintenance** (180+ lines of mock code per test)
❌ **Doesn't Test Real Behavior** (serialization, atomicity, TTL, race conditions)
❌ **Misses Bugs** (JSON serialization issues, concurrent access bugs)
❌ **Complex to Update** (must update mocks when Redis behavior changes)

### Benefits of Real In-Memory Redis

✅ **Zero Mock Code** (3 lines of setup vs 180 lines of mocks)
✅ **Tests Real Behavior** (catches serialization bugs, race conditions, TTL issues)
✅ **Fast** (~50-100ms overhead vs ~10ms with mocks - acceptable)
✅ **No Maintenance** (use real Redis, no mock updates needed)
✅ **Better Coverage** (can test concurrency, atomicity, real streams)

---

## Migration Process

### Step 1: Identify Tests Using MockRedisClient

```bash
# Find tests with Redis mocks
grep -r "MockRedisClient\|createMockRedis\|class.*Redis.*Mock" \
  --include="*.test.ts" services/ shared/ | grep integration
```

### Step 2: Choose the Right Level

For each test, determine the appropriate level:

| Test Type | Level | Indicators |
|-----------|-------|----------|
| **Component logic with Redis** | Level 1 | Tests multiple internal classes, mock external APIs |
| **Service lifecycle with Redis** | Level 2 | Tests start/stop, streams, locks, full service behavior |
| **End-to-end flows** | Level 3 | Tests complete user journeys, all services running |

### Step 3: Apply Migration Pattern

See examples below for your test's level.

---

## Migration Examples

### Example 1: Level 1 Migration (Component Integration)

**Before** (Mock-heavy, 220 lines):

```typescript
// ❌ BAD: 180 lines of MockRedisClient + 40 lines of test
class MockRedisClient {
  private store: Map<string, any> = new Map();
  private locks: Map<string, { value: string; ttl: number }> = new Map();

  async set(key: string, value: string, options?: { NX?: boolean; PX?: number }): Promise<string | null> {
    if (options?.NX && this.store.has(key)) {
      return null; // Key exists, NX failed
    }
    this.store.set(key, value);
    if (options?.PX) {
      // Mock TTL logic... 40 more lines
    }
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    // Check TTL expiration... 20 lines
    return this.store.get(key) || null;
  }

  // ... 120 more lines of mock methods
}

describe('DistributedLockManager Integration', () => {
  let mockRedis: MockRedisClient;
  let lockManager: DistributedLockManager;

  beforeEach(() => {
    mockRedis = new MockRedisClient();
    lockManager = new DistributedLockManager();
    await lockManager.initialize(mockRedis as any);
  });

  it('should acquire lock', async () => {
    const result = await lockManager.acquireLock('test:lock', 'owner-1', 5000);
    expect(result.acquired).toBe(true);
  });
});
```

**After** (Real Redis, 40 lines):

```typescript
// ✅ GOOD: 0 lines of mock code, real Redis behavior
import { createLevel1TestSetup } from '@arbitrage/test-utils';

describe('[Level 1] DistributedLockManager Integration', () => {
  let setup: Level1TestSetup;
  let lockManager: DistributedLockManager;

  beforeAll(async () => {
    // Real in-memory Redis (NOT mocked)
    setup = await createLevel1TestSetup({
      testSuiteName: 'distributed-lock-integration'
    });

    lockManager = new DistributedLockManager();
    await lockManager.initialize(setup.redis);
  });

  afterAll(async () => {
    await setup.cleanup();
  });

  it('should acquire lock with real Redis', async () => {
    const result = await lockManager.acquireLock('test:lock', 'owner-1', 5000);

    expect(result.acquired).toBe(true);

    // Verify in REAL Redis
    const lockValue = await setup.redis.get('lock:test:lock');
    expect(lockValue).toBe('owner-1');
  });

  it('should handle concurrent lock attempts with real atomicity', async () => {
    // Test that was IMPOSSIBLE with mocks - real concurrent access
    const [r1, r2, r3] = await Promise.all([
      lockManager.acquireLock('concurrent:lock', 'owner-1', 5000),
      lockManager.acquireLock('concurrent:lock', 'owner-2', 5000),
      lockManager.acquireLock('concurrent:lock', 'owner-3', 5000)
    ]);

    // Real Redis ensures only ONE succeeds (atomic SET NX)
    const acquired = [r1, r2, r3].filter(r => r.acquired);
    expect(acquired).toHaveLength(1);
  });

  it('should handle TTL expiration correctly', async () => {
    // Test real TTL behavior (impossible with mocks)
    await lockManager.acquireLock('ttl:lock', 'owner-1', 1000); // 1 second TTL

    expect(await setup.redis.get('lock:ttl:lock')).toBeTruthy();

    await new Promise(resolve => setTimeout(resolve, 1500));

    expect(await setup.redis.get('lock:ttl:lock')).toBeNull(); // Real expiration
  });
});
```

**Benefits**:
- 📉 **180 lines removed** (220 → 40 lines, 82% reduction)
- ✅ **Tests real Redis atomicity** (concurrent lock acquisition)
- ✅ **Tests real TTL behavior** (expiration)
- ✅ **Catches serialization bugs** (JSON → Redis → JSON)

---

### Example 2: Level 2 Migration (Service Integration)

**Before** (Mock Redis + Mock Streams, 150 lines):

```typescript
// ❌ BAD: Mocks don't test real Redis Streams behavior
describe('Coordinator Integration', () => {
  let mockRedis: MockRedisClient;
  let mockStreamsClient: MockStreamsClient;
  let coordinator: CoordinatorService;

  beforeEach(() => {
    mockRedis = createMockRedis();
    mockStreamsClient = createMockStreamsClient();

    coordinator = new CoordinatorService({
      redis: mockRedis,
      streams: mockStreamsClient
    });
  });

  it('should consume Redis Streams', async () => {
    mockStreamsClient.xreadgroup.mockResolvedValue([
      { id: '1234-0', data: { type: 'opportunity' } }
    ]);

    await coordinator.start();

    // Mock behavior, doesn't test real XREADGROUP
    expect(mockStreamsClient.xreadgroup).toHaveBeenCalled();
  });
});
```

**After** (Real Redis Streams, 80 lines):

```typescript
// ✅ GOOD: Tests real Redis Streams consumption
import { createLevel2TestSetup, waitFor } from '@arbitrage/test-utils';

describe('[Level 2] Coordinator Service Integration', () => {
  let setup: Level2TestSetup;
  let coordinator: CoordinatorService;

  beforeAll(async () => {
    setup = await createLevel2TestSetup({
      testSuiteName: 'coordinator-service'
    });
  });

  afterAll(async () => {
    await coordinator?.stop();
    await setup.cleanup();
  });

  it('should consume real Redis Streams with XREADGROUP', async () => {
    coordinator = new CoordinatorService({ redis: setup.redis });
    await coordinator.start();

    // Publish to REAL Redis Stream
    await setup.redis.xAdd('stream:opportunities', '*', {
      data: JSON.stringify({ token: 'WETH', profit: 100 })
    });

    // Wait for REAL consumption
    await waitFor(() => coordinator.getProcessedCount() > 0, 5000);

    expect(coordinator.getProcessedCount()).toBe(1);
  });

  it('should elect leader using real distributed locks', async () => {
    const coord1 = new CoordinatorService({ redis: setup.redis });
    const coord2 = new CoordinatorService({ redis: setup.redis });

    await Promise.all([coord1.start(), coord2.start()]);

    // Real Redis lock atomicity ensures only one leader
    expect(coord1.isLeader !== coord2.isLeader).toBe(true);

    await coord1.stop();
    await coord2.stop();
  });
});
```

**Benefits**:
- ✅ **Tests real XREADGROUP behavior** (stream consumption)
- ✅ **Tests real distributed locking** (leader election)
- ✅ **Tests real message serialization** (JSON → Redis → JSON)

---

## Common Migration Patterns

### Pattern 1: Replace MockRedisClient Creation

**Before**:
```typescript
beforeEach(() => {
  mockRedis = new MockRedisClient();
  service = new MyService({ redis: mockRedis });
});
```

**After**:
```typescript
beforeAll(async () => {
  setup = await createLevel1TestSetup({ testSuiteName: 'my-service' });
  service = new MyService({ redis: setup.redis });
});

afterAll(async () => {
  await setup.cleanup();
});
```

**Key Changes**:
- `beforeEach` → `beforeAll` (faster, setup once)
- `new MockRedisClient()` → `createLevel1TestSetup()`
- Add `afterAll` for cleanup

---

### Pattern 2: Remove Mock Method Implementations

**Before**:
```typescript
class MockRedisClient {
  async set(key: string, value: string) { /* 40 lines */ }
  async get(key: string) { /* 20 lines */ }
  async del(key: string) { /* 10 lines */ }
  // ... 120 more lines
}
```

**After**:
```typescript
// DELETE ENTIRE MOCK CLASS
// Use setup.redis (real client) instead
```

**Result**: 180 lines → 0 lines

---

### Pattern 3: Add Concurrency Tests (Previously Impossible)

**Before**:
```typescript
// Can't test concurrency with mocks - mock is single-threaded
it('should handle concurrent operations', async () => {
  // Mock doesn't simulate real concurrency
  await service.operation1();
  await service.operation2();
  // Sequential, not concurrent
});
```

**After**:
```typescript
// Test REAL concurrent access with real Redis atomicity
it('should handle concurrent operations with real atomicity', async () => {
  const results = await Promise.all([
    service.operation1(),
    service.operation2(),
    service.operation3()
  ]);

  // Real Redis ensures atomic operations
  const count = await setup.redis.get('operation:count');
  expect(count).toBe('3'); // All operations succeeded atomically
});
```

---

### Pattern 4: Add TTL Tests (Previously Difficult)

**Before**:
```typescript
// Mock TTL is complex and unreliable
it('should expire keys', async () => {
  // Mock timers, fake TTL logic... unreliable
});
```

**After**:
```typescript
// Test REAL TTL expiration
it('should expire keys after TTL', async () => {
  await setup.redis.set('temp:key', 'value', { EX: 1 }); // 1 second

  expect(await setup.redis.get('temp:key')).toBe('value');

  await new Promise(resolve => setTimeout(resolve, 1500));

  expect(await setup.redis.get('temp:key')).toBeNull(); // Real expiration
});
```

---

### Pattern 5: Add Serialization Tests (Catch JSON Bugs)

**Before**:
```typescript
// Mock doesn't serialize/deserialize - just stores objects
it('should store data', async () => {
  await mockRedis.set('key', { foo: 'bar' } as any);
  const result = await mockRedis.get('key');
  expect(result.foo).toBe('bar'); // Object reference, not serialized
});
```

**After**:
```typescript
// Test REAL serialization round-trip
it('should serialize/deserialize correctly', async () => {
  const data = { foo: 'bar', num: 123, nested: { baz: 'qux' } };

  // Real Redis serializes to string
  await setup.redis.set('key', JSON.stringify(data));

  // Real deserialization
  const result = JSON.parse(await setup.redis.get('key') as string);

  expect(result).toEqual(data);
  expect(result).not.toBe(data); // New object, not reference
});
```

---

## Troubleshooting

### Issue: Test is slow after migration

**Cause**: Using `beforeEach()` instead of `beforeAll()`

**Solution**:
```typescript
// ❌ SLOW: Creates Redis client before EACH test
beforeEach(async () => {
  setup = await createLevel1TestSetup({ testSuiteName: 'test' });
});

// ✅ FAST: Creates Redis client ONCE before all tests
beforeAll(async () => {
  setup = await createLevel1TestSetup({ testSuiteName: 'test' });
});
```

---

### Issue: Tests are flaky (intermittent failures)

**Cause**: Database isolation issue - tests sharing Redis database

**Solution**: Ensure unique test suite names
```typescript
// ❌ BAD: Same name used in multiple files
beforeAll(async () => {
  setup = await createLevel1TestSetup({ testSuiteName: 'integration-test' });
});

// ✅ GOOD: Unique name per test file
beforeAll(async () => {
  setup = await createLevel1TestSetup({
    testSuiteName: 'distributed-lock-manager-integration' // Unique!
  });
});
```

---

### Issue: "Redis client is not connected"

**Cause**: Missing `await` or calling Redis before `beforeAll()` completes

**Solution**:
```typescript
// ❌ BAD: Not awaiting setup
beforeAll(() => { // Missing async!
  setup = createLevel1TestSetup({ testSuiteName: 'test' }); // Missing await!
});

// ✅ GOOD: Properly await setup
beforeAll(async () => {
  setup = await createLevel1TestSetup({ testSuiteName: 'test' });
});
```

---

### Issue: Need to test with pre-populated Redis data

**Solution**: Use `beforeSetup` in Level 2
```typescript
beforeAll(async () => {
  setup = await createLevel2TestSetup({
    testSuiteName: 'my-service',
    beforeSetup: async (redis) => {
      // Populate Redis before service starts
      await redis.set('config:threshold', '100');
      await redis.xAdd('stream:prices', '*', { price: '2500' });
    }
  });
});
```

---

## Migration Checklist

For each test file being migrated:

- [ ] Remove `MockRedisClient` class (entire implementation)
- [ ] Remove `createMockRedis()` or similar mock factories
- [ ] Import `createLevel1TestSetup` or `createLevel2TestSetup`
- [ ] Change `beforeEach` → `beforeAll` for Redis setup
- [ ] Add `afterAll` with `setup.cleanup()`
- [ ] Replace `mockRedis` → `setup.redis` throughout test
- [ ] Add `[Level 1]` or `[Level 2]` prefix to describe block
- [ ] Run tests 3 times to verify no flakiness
- [ ] Add concurrency tests (now possible with real Redis)
- [ ] Add serialization round-trip tests
- [ ] Update test expectations if mock behavior was incorrect

---

## Quick Reference

### Before (Mock)
```typescript
class MockRedisClient { /* 180 lines */ }

describe('Integration Test', () => {
  let mockRedis: MockRedisClient;

  beforeEach(() => {
    mockRedis = new MockRedisClient();
  });

  it('test', async () => {
    await mockRedis.set('key', 'value');
  });
});
```

### After (Real)
```typescript
import { createLevel1TestSetup } from '@arbitrage/test-utils';

describe('[Level 1] Integration Test', () => {
  let setup: Level1TestSetup;

  beforeAll(async () => {
    setup = await createLevel1TestSetup({ testSuiteName: 'integration-test' });
  });

  afterAll(async () => {
    await setup.cleanup();
  });

  it('test', async () => {
    await setup.redis.set('key', 'value');
  });
});
```

---

## Expected Benefits After Migration

| Metric | Before (Mocks) | After (Real Redis) | Improvement |
|--------|----------------|-------------------|-------------|
| **Lines of mock code** | 180+ per test | 0 | -180 lines (100%) |
| **Maintenance burden** | High (update mocks) | None | Zero maintenance |
| **Bug detection** | Low (mocks miss bugs) | High (tests real behavior) | 10x better |
| **Test realism** | Low (fake behavior) | High (real Redis) | True integration |
| **Speed** | ~10ms overhead | ~50-100ms overhead | Acceptable |
| **Concurrency tests** | Impossible (mocks single-threaded) | Possible (real atomicity) | New capability |
| **TTL tests** | Unreliable (mock timers) | Reliable (real expiration) | New capability |

---

## Next Steps

1. **Identify tests to migrate**: Run grep command from Step 1
2. **Prioritize high-value tests**: Start with detector, coordinator, execution-engine
3. **Migrate incrementally**: One test file at a time, verify passes
4. **Add new tests**: Concurrency, TTL, serialization (now possible)
5. **Delete mock code**: Remove entire MockRedisClient classes

**Goal**: Zero MockRedisClient implementations in the codebase.
