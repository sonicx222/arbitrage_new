# Test Framework P2 (Performance Optimization) - Detailed Implementation Specifications

**Status**: Ready for execution
**Date**: February 1, 2026
**Phase**: 3 - Performance Optimization
**Goal**: Reduce test execution time by 50%
**Estimated Effort**: 24 hours (3 days)

---

## Overview

This document provides detailed, actionable specifications for all P2 (Performance Optimization) issues identified in the test framework enhancement research. Each issue follows the same rigorous format as P0/P1 issues.

**Current Test Suite Metrics** (Baseline):
- Total test suites: 146
- Total tests: 6,294
- Execution time: ~4,500 seconds (75 minutes)
- beforeEach usage: 585 instances
- beforeAll usage: 90 instances (6.5:1 ratio)
- Redis-dependent integration tests: 29 files (392 references)
- Current maxWorkers: 50% (local), 2 (CI)

**Target Metrics** (After P2 completion):
- Execution time: <2,250 seconds (37.5 minutes) - 50% reduction
- Integration test time: <2 minutes - 30% reduction via beforeAll optimization
- Unit test time: <10 seconds
- CI test time: 60% reduction via parallelization

---

# Phase 3: Performance Optimization Issues

## Issue P2-1.1: Identify Tests with Heavy Initialization in beforeEach

**Priority**: P2 - Performance
**Effort**: 2 hours
**Type**: Analysis + Documentation
**Dependencies**: None

### Problem Statement

Many integration tests create heavy objects (Detectors, Services, Managers) in `beforeEach` hooks, causing repeated expensive initialization for every test. This is the primary performance bottleneck in the integration test suite.

**Current Impact**:
- 585 `beforeEach` hooks across test suite
- Heavy services recreated for every test
- Integration tests taking 10-30 seconds each
- Detectors, Redis clients, WebSocket connections recreated repeatedly

### Root Cause

Tests default to `beforeEach` for safety (ensuring clean state), but many tests don't actually mutate the objects being created, making the repeated initialization wasteful.

### Discovery Task

Create an audit document identifying candidates for `beforeEach` → `beforeAll` conversion.

**Analysis Steps**:

1. **Find Heavy Initialization Patterns**:
   ```bash
   # Find tests creating Detectors in beforeEach
   grep -B 5 "new.*Detector" --include="*.integration.test.ts" -r services/ tests/ | grep -A 5 "beforeEach"

   # Find tests creating Services in beforeEach
   grep -B 5 "new.*Service" --include="*.integration.test.ts" -r services/ tests/ | grep -A 5 "beforeEach"

   # Find tests creating Managers in beforeEach
   grep -B 5 "new.*Manager" --include="*.integration.test.ts" -r services/ tests/ | grep -A 5 "beforeEach"
   ```

2. **Categorize by Mutation Pattern**:
   - **Safe for beforeAll**: Tests that only read from the object (call getters, query state)
   - **Needs beforeEach**: Tests that mutate state (call setters, modify internal state)
   - **Hybrid**: Tests that mutate but could use `resetState()` method

3. **Estimate Impact**:
   - Count tests per file
   - Estimate initialization cost (based on test duration)
   - Calculate potential savings (initialization_cost * (num_tests - 1))

### Deliverable

Create: `.claude/plans/BEFOREEACH_TO_BEFOREALL_AUDIT.md`

**Expected Format**:
```markdown
# beforeEach to beforeAll Conversion Audit

## Summary
- Total candidates identified: X files
- Estimated time savings: Y seconds
- Conversion priority: [list ordered by impact]

## Conversion Candidates

### High Priority (>5 second savings)

#### File: tests/integration/s3.3.1-solana-detector.integration.test.ts
- **Object**: SolanaDetector
- **Current**: Created in beforeEach (3 times per describe block)
- **Tests per describe**: 15 tests
- **Initialization time**: ~2 seconds
- **Current waste**: 2s * 14 = 28 seconds
- **Mutation analysis**: Read-only tests (no state mutation)
- **Conversion approach**: Move to beforeAll, no resetState() needed
- **Estimated savings**: 28 seconds

[... more candidates]

### Medium Priority (1-5 second savings)
[...]

### Low Priority (<1 second savings)
[...]

## Tests That Must Stay beforeEach

### File: services/coordinator/src/__tests__/coordinator.integration.test.ts
- **Reason**: Tests mutate coordinator state (leadership, failover)
- **Cannot convert**: State mutation is core to test scenarios

[... more]
```

### Acceptance Criteria
- [ ] Audit document created with all heavy initialization patterns identified
- [ ] Each candidate categorized by safety (safe/hybrid/must-stay-beforeEach)
- [ ] Estimated time savings calculated for each candidate
- [ ] Prioritized list of conversions by impact
- [ ] Clear reasoning for tests that must stay `beforeEach`

### Testing
```bash
# Verify all heavy patterns found
grep -r "new.*Detector\|new.*Service\|new.*Manager" --include="*.integration.test.ts" services/ tests/ | wc -l

# Should match the audit document count
```

### Notes
- This is a **discovery issue** - no code changes yet
- Creates input for P2-1.2 (actual conversion)
- Focus on integration tests (biggest impact)

---

## Issue P2-1.2: Convert beforeEach to beforeAll with State Reset

**Priority**: P2 - Performance
**Effort**: 6 hours
**Type**: Refactoring - Performance
**Dependencies**: P2-1.1 complete (audit document created)

### Problem Statement

Based on the audit from P2-1.1, convert high-priority `beforeEach` hooks to `beforeAll` with proper state reset mechanisms to reduce test execution time.

### Root Cause

Tests using `beforeEach` for heavy initialization even when the initialized objects aren't mutated, causing unnecessary repeated setup.

### Conversion Pattern

**For read-only tests** (most common):

```typescript
// Before (beforeEach)
describe('SolanaDetector', () => {
  let detector: SolanaDetector;

  beforeEach(() => {
    detector = new SolanaDetector(config); // Expensive: 2 seconds
  });

  it('test 1', () => { /* read-only */ });
  it('test 2', () => { /* read-only */ });
  it('test 3', () => { /* read-only */ });
  // 3 tests * 2s = 6 seconds total initialization
});

// After (beforeAll)
describe('SolanaDetector', () => {
  let detector: SolanaDetector;

  beforeAll(() => {
    detector = new SolanaDetector(config); // Expensive: 2 seconds ONCE
  });

  afterAll(async () => {
    await detector?.cleanup(); // Important: cleanup resources
  });

  it('test 1', () => { /* read-only */ });
  it('test 2', () => { /* read-only */ });
  it('test 3', () => { /* read-only */ });
  // 1 * 2s = 2 seconds total initialization (4s savings!)
});
```

**For tests that need state reset** (hybrid):

```typescript
// Before (beforeEach)
describe('PriceMatrix', () => {
  let matrix: PriceMatrix;

  beforeEach(() => {
    matrix = new PriceMatrix(); // Creates SharedArrayBuffer, etc.
    matrix.initialize();
  });

  it('test 1', () => { matrix.updatePrice(/*...*/); });
  it('test 2', () => { matrix.updatePrice(/*...*/); });
});

// After (beforeAll + resetState)
describe('PriceMatrix', () => {
  let matrix: PriceMatrix;

  beforeAll(() => {
    matrix = new PriceMatrix(); // Create ONCE
    matrix.initialize();
  });

  beforeEach(() => {
    matrix.resetState(); // Fast: just clears data, keeps buffers
  });

  afterAll(() => {
    matrix.cleanup();
  });

  it('test 1', () => { matrix.updatePrice(/*...*/); });
  it('test 2', () => { matrix.updatePrice(/*...*/); });
});
```

### Implementation Steps

**Step 1**: Add `resetState()` methods to classes that need them

**Classes needing resetState()** (identify during P2-1.1):
- `PriceMatrix` - Clear price data, keep SharedArrayBuffer
- `PartitionedDetector` - Reset opportunities, keep chain instances
- `UnifiedChainDetector` - Clear state, keep WebSocket connections
- `CoordinatorService` - Reset leadership state, keep connections

**Example**: Add `resetState()` to PriceMatrix

**File**: `shared/core/src/price-matrix.ts`

```typescript
// Add this method
export class PriceMatrix {
  // ... existing code ...

  /**
   * Reset state for test isolation while keeping allocated buffers
   * @internal For testing only
   */
  public resetState(): void {
    // Clear price data
    if (this.buffer) {
      this.buffer.fill(0);
    }

    // Clear caches
    this.pairCache.clear();
    this.priceCache.clear();

    // Reset counters
    this.updateCount = 0;
    this.lastUpdate = 0;

    // Don't recreate SharedArrayBuffer - that's the expensive part
  }
}
```

**Step 2**: Convert high-priority tests (from P2-1.1 audit)

Work through the prioritized list, converting each file:

1. Change `beforeEach` to `beforeAll`
2. Add `beforeEach(() => { obj.resetState(); })` if needed
3. Add `afterAll` for cleanup
4. Run tests to verify no failures
5. Measure time improvement

**Example Conversion**: `tests/integration/s3.3.1-solana-detector.integration.test.ts`

```typescript
// Before
describe('SolanaDetector Arbitrage Detection', () => {
  let detector: SolanaDetector;

  beforeEach(() => {
    detector = new SolanaDetector(createTestConfig(), {
      logger: mockLogger
    });
  });

  it('should detect simple arbitrage', async () => { /*...*/ });
  it('should detect triangular arbitrage', async () => { /*...*/ });
  // ... 15 more tests
});

// After
describe('SolanaDetector Arbitrage Detection', () => {
  let detector: SolanaDetector;

  beforeAll(() => {
    detector = new SolanaDetector(createTestConfig(), {
      logger: mockLogger
    });
  });

  afterAll(async () => {
    await detector?.stop();
    await detector?.cleanup();
  });

  it('should detect simple arbitrage', async () => { /*...*/ });
  it('should detect triangular arbitrage', async () => { /*...*/ });
  // ... 15 more tests
  // Savings: ~28 seconds (2s init * 14 avoided recreations)
});
```

### Affected Files

Based on audit (P2-1.1 will identify exact list), estimated candidates:

**High Priority** (>5 second savings each):
- `tests/integration/s3.3.1-solana-detector.integration.test.ts` (~28s savings)
- `tests/integration/s3.1.1-partitioned-detector.integration.test.ts` (~20s savings)
- `tests/integration/s2.2.5-pair-services.integration.test.ts` (~15s savings)
- `tests/integration/s3.2.1-avalanche-configuration.integration.test.ts` (~12s savings)
- `tests/integration/s3.2.2-fantom-configuration.integration.test.ts` (~12s savings)

**Classes needing resetState()** (estimated 4-6 classes):
- `shared/core/src/price-matrix.ts`
- `shared/core/src/partitioned-detector.ts`
- `services/unified-detector/src/unified-detector.ts`
- `services/coordinator/src/coordinator.ts` (maybe - depends on tests)

### Acceptance Criteria
- [ ] `resetState()` methods added to all classes identified in audit
- [ ] High-priority tests converted from `beforeEach` to `beforeAll`
- [ ] All converted tests still pass
- [ ] `afterAll` cleanup added for resource disposal
- [ ] Integration test suite time reduced by at least 25% (measured)
- [ ] No test flakiness introduced (run suite 3 times to verify)

### Testing Commands
```bash
# Measure before conversion
time npm test -- --selectProjects integration

# After each conversion, verify tests pass
npm test -- tests/integration/s3.3.1-solana-detector.integration.test.ts

# Measure after all conversions
time npm test -- --selectProjects integration

# Verify no flakiness (run 3 times)
for i in {1..3}; do npm test -- --selectProjects integration; done
```

### Performance Validation
```bash
# Before P2-1.2
# Integration tests: ~300 seconds

# After P2-1.2 (target)
# Integration tests: <210 seconds (30% reduction)
# Savings: ~90 seconds
```

### Regression Risk
**MEDIUM** - Shared state between tests could cause flakiness if:
- Tests mutate state but don't call resetState()
- Cleanup in afterAll is incomplete
- Tests depend on specific initialization order

**Mitigation**:
- Run test suite 3 times after each conversion to catch flakiness
- Ensure resetState() is thorough
- Add integration test to verify state isolation:
  ```typescript
  it('should have clean state between tests', () => {
    expect(detector.getOpportunitiesCount()).toBe(0);
    expect(detector.getActiveChains()).toEqual([]);
  });
  ```

### Notes
- Convert incrementally - one file at a time, verify, then move to next
- If a conversion causes flakiness, revert and mark as "must stay beforeEach"
- Biggest wins are integration tests with many tests per describe block
- Unit tests likely already fast enough - focus on integration tests

---

## Issue P2-2.1: Design and Implement InMemoryRedis

**Priority**: P2 - Performance
**Effort**: 4 hours
**Type**: Enhancement - Test Infrastructure
**Dependencies**: None

### Problem Statement

Integration tests use real Redis via Docker, causing:
- Slow test execution (network I/O, serialization overhead)
- CI complexity (Redis container management)
- Test flakiness (Redis connection issues)
- Unnecessary overhead for tests that don't need Redis-specific behavior

**Current Impact**:
- 29 integration test files use Redis (392 references)
- Real Redis adds ~50-100ms per operation
- Many tests only need simple key-value storage, not Redis-specific features

### Root Cause

Tests use real Redis even when they only need:
- Simple get/set operations
- Basic pub/sub (no Redis-specific features)
- Stream append/read (simple FIFO, not complex Redis Streams features)

### Solution

Create `InMemoryRedis` implementation that:
- Implements common Redis operations in-memory (no network)
- Compatible with existing `ioredis` or `redis` client interface
- Fast: <1ms per operation (vs 50-100ms for real Redis)
- Use real Redis only for tests verifying Redis-specific behavior

### Design

**File**: `shared/test-utils/src/doubles/in-memory-redis.ts`

```typescript
/**
 * In-Memory Redis Implementation for Testing
 *
 * Provides fast, in-memory implementation of common Redis operations
 * for tests that don't require actual Redis-specific behavior.
 *
 * @example
 * ```typescript
 * const redis = new InMemoryRedis();
 * await redis.set('key', 'value');
 * const value = await redis.get('key'); // 'value'
 * ```
 */

import { EventEmitter } from 'events';

export class InMemoryRedis extends EventEmitter {
  private store: Map<string, string> = new Map();
  private expirations: Map<string, NodeJS.Timeout> = new Map();
  private streams: Map<string, Array<{ id: string; data: Record<string, string> }>> = new Map();
  private pubSubChannels: Map<string, Set<(message: string) => void>> = new Map();

  // ============================================================================
  // Basic Key-Value Operations
  // ============================================================================

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, mode?: 'EX', duration?: number): Promise<'OK'> {
    this.store.set(key, value);

    // Handle expiration
    if (mode === 'EX' && duration) {
      this.clearExpiration(key);
      const timeout = setTimeout(() => {
        this.store.delete(key);
        this.expirations.delete(key);
      }, duration * 1000);
      this.expirations.set(key, timeout);
    }

    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.store.delete(key)) {
        deleted++;
        this.clearExpiration(key);
      }
    }
    return deleted;
  }

  async exists(...keys: string[]): Promise<number> {
    return keys.filter(key => this.store.has(key)).length;
  }

  async expire(key: string, seconds: number): Promise<0 | 1> {
    if (!this.store.has(key)) return 0;

    this.clearExpiration(key);
    const timeout = setTimeout(() => {
      this.store.delete(key);
      this.expirations.delete(key);
    }, seconds * 1000);
    this.expirations.set(key, timeout);

    return 1;
  }

  async ttl(key: string): Promise<number> {
    if (!this.store.has(key)) return -2; // Key doesn't exist
    if (!this.expirations.has(key)) return -1; // No expiration

    // Note: This is approximate - real Redis tracks exact remaining time
    // For testing purposes, returning -1 (no expiration) is usually fine
    return -1;
  }

  // ============================================================================
  // Hash Operations
  // ============================================================================

  async hset(key: string, field: string, value: string): Promise<0 | 1> {
    const hash = this.store.get(key);
    const hashData = hash ? JSON.parse(hash) : {};
    const isNew = !(field in hashData);
    hashData[field] = value;
    this.store.set(key, JSON.stringify(hashData));
    return isNew ? 1 : 0;
  }

  async hget(key: string, field: string): Promise<string | null> {
    const hash = this.store.get(key);
    if (!hash) return null;
    const hashData = JSON.parse(hash);
    return hashData[field] ?? null;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const hash = this.store.get(key);
    return hash ? JSON.parse(hash) : {};
  }

  // ============================================================================
  // List Operations
  // ============================================================================

  async lpush(key: string, ...values: string[]): Promise<number> {
    const list = this.store.get(key);
    const listData = list ? JSON.parse(list) : [];
    listData.unshift(...values.reverse());
    this.store.set(key, JSON.stringify(listData));
    return listData.length;
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    const list = this.store.get(key);
    const listData = list ? JSON.parse(list) : [];
    listData.push(...values);
    this.store.set(key, JSON.stringify(listData));
    return listData.length;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.store.get(key);
    if (!list) return [];
    const listData = JSON.parse(list);
    const end = stop === -1 ? undefined : stop + 1;
    return listData.slice(start, end);
  }

  // ============================================================================
  // Pub/Sub Operations
  // ============================================================================

  async subscribe(...channels: string[]): Promise<void> {
    for (const channel of channels) {
      if (!this.pubSubChannels.has(channel)) {
        this.pubSubChannels.set(channel, new Set());
      }
    }
  }

  async publish(channel: string, message: string): Promise<number> {
    const subscribers = this.pubSubChannels.get(channel);
    if (!subscribers) return 0;

    subscribers.forEach(callback => callback(message));
    return subscribers.size;
  }

  on(event: 'message', callback: (channel: string, message: string) => void): this {
    // Simplified pub/sub - in real usage, would need proper event handling
    super.on(event, callback);
    return this;
  }

  // ============================================================================
  // Stream Operations (Simplified)
  // ============================================================================

  async xadd(
    key: string,
    id: string,
    ...fieldValues: string[]
  ): Promise<string> {
    const stream = this.streams.get(key) ?? [];

    // Parse field-value pairs
    const data: Record<string, string> = {};
    for (let i = 0; i < fieldValues.length; i += 2) {
      data[fieldValues[i]] = fieldValues[i + 1];
    }

    // Generate ID if '*'
    const entryId = id === '*' ? `${Date.now()}-${stream.length}` : id;

    stream.push({ id: entryId, data });
    this.streams.set(key, stream);

    return entryId;
  }

  async xread(
    ...args: any[]
  ): Promise<Array<[string, Array<[string, string[]]>]> | null> {
    // Simplified XREAD implementation
    // Real Redis Streams are complex - this handles basic cases

    // Parse args: ['STREAMS', stream1, stream2, ..., id1, id2, ...]
    const streamsIdx = args.indexOf('STREAMS');
    if (streamsIdx === -1) return null;

    const streamNames = args.slice(streamsIdx + 1, streamsIdx + 1 + (args.length - streamsIdx - 1) / 2);
    const ids = args.slice(streamsIdx + 1 + streamNames.length);

    const results: Array<[string, Array<[string, string[]]>]> = [];

    for (let i = 0; i < streamNames.length; i++) {
      const streamName = streamNames[i];
      const afterId = ids[i];
      const stream = this.streams.get(streamName) ?? [];

      // Get entries after the specified ID
      const entries = stream
        .filter(entry => entry.id > afterId)
        .map(entry => {
          const fieldValues: string[] = [];
          for (const [field, value] of Object.entries(entry.data)) {
            fieldValues.push(field, value);
          }
          return [entry.id, fieldValues] as [string, string[]];
        });

      if (entries.length > 0) {
        results.push([streamName, entries]);
      }
    }

    return results.length > 0 ? results : null;
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  async flushall(): Promise<'OK'> {
    this.store.clear();
    this.clearAllExpirations();
    this.streams.clear();
    this.pubSubChannels.clear();
    return 'OK';
  }

  async quit(): Promise<'OK'> {
    this.clearAllExpirations();
    return 'OK';
  }

  private clearExpiration(key: string): void {
    const timeout = this.expirations.get(key);
    if (timeout) {
      clearTimeout(timeout);
      this.expirations.delete(key);
    }
  }

  private clearAllExpirations(): void {
    for (const timeout of this.expirations.values()) {
      clearTimeout(timeout);
    }
    this.expirations.clear();
  }

  /**
   * Create a duplicate instance (for testing multi-client scenarios)
   */
  duplicate(): InMemoryRedis {
    const clone = new InMemoryRedis();
    clone.store = new Map(this.store);
    clone.streams = new Map(this.streams);
    return clone;
  }
}

/**
 * Factory for creating InMemoryRedis instances
 * Compatible with ioredis-style configuration
 */
export function createInMemoryRedis(config?: any): InMemoryRedis {
  return new InMemoryRedis();
}
```

### Acceptance Criteria
- [ ] `InMemoryRedis` class implemented with core operations:
  - [x] Basic key-value (get, set, del, exists, expire, ttl)
  - [x] Hash operations (hset, hget, hgetall)
  - [x] List operations (lpush, rpush, lrange)
  - [x] Pub/Sub (subscribe, publish)
  - [x] Streams (xadd, xread - simplified)
  - [x] Utility (flushall, quit, duplicate)
- [ ] TypeScript types compatible with ioredis
- [ ] Unit tests for InMemoryRedis implementation
- [ ] Performance verified: <1ms per operation

### Testing Commands
```typescript
// Unit tests for InMemoryRedis
describe('InMemoryRedis', () => {
  let redis: InMemoryRedis;

  beforeEach(() => {
    redis = new InMemoryRedis();
  });

  describe('Basic Operations', () => {
    it('should set and get values', async () => {
      await redis.set('key', 'value');
      expect(await redis.get('key')).toBe('value');
    });

    it('should handle expiration', async () => {
      await redis.set('key', 'value', 'EX', 1);
      expect(await redis.get('key')).toBe('value');
      await new Promise(resolve => setTimeout(resolve, 1100));
      expect(await redis.get('key')).toBeNull();
    });

    it('should delete keys', async () => {
      await redis.set('key1', 'value1');
      await redis.set('key2', 'value2');
      const deleted = await redis.del('key1', 'key2');
      expect(deleted).toBe(2);
      expect(await redis.get('key1')).toBeNull();
    });
  });

  describe('Performance', () => {
    it('should complete 1000 operations in <100ms', async () => {
      const start = Date.now();
      for (let i = 0; i < 1000; i++) {
        await redis.set(`key${i}`, `value${i}`);
      }
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(100); // <0.1ms per operation
    });
  });

  // ... more tests for other operations
});
```

### Notes
- This is **not** a full Redis replacement - only common operations for testing
- Tests needing Redis-specific features (Lua scripts, complex transactions) should still use real Redis
- Performance gain: ~50-100x faster than real Redis for simple operations

---

## Issue P2-2.2: Replace Real Redis with InMemoryRedis in Tests

**Priority**: P2 - Performance
**Effort**: 4 hours
**Type**: Refactoring - Test Infrastructure
**Dependencies**: P2-2.1 complete (InMemoryRedis implemented)

### Problem Statement

Now that `InMemoryRedis` is implemented, replace real Redis with in-memory version in integration tests that don't need Redis-specific behavior.

**Target**: 29 integration test files use Redis - convert ~20 to InMemoryRedis, keep ~9 with real Redis

### Classification Criteria

**Use InMemoryRedis for**:
- Tests that only use basic get/set/del operations
- Tests that use simple pub/sub (no complex patterns)
- Tests that use streams in basic append/read pattern
- Tests verifying application logic, not Redis behavior

**Keep Real Redis for**:
- Tests verifying Redis connection handling
- Tests using Redis-specific features (Lua scripts, transactions)
- Tests verifying Redis Streams complex features (consumer groups, pending entries)
- Tests in `shared/redis/` that specifically test Redis wrapper code

### Conversion Pattern

**Before** (Real Redis):
```typescript
// tests/integration/s2.2.5-pair-services.integration.test.ts
import Redis from 'ioredis';

describe('PairDiscoveryService', () => {
  let redis: Redis;
  let service: PairDiscoveryService;

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL); // Real Redis
    await redis.flushall();
  });

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    await redis.flushall();
    service = new PairDiscoveryService({ redis });
  });

  it('should discover pairs', async () => {
    await service.discoverPairs('uniswap-v2', 'arbitrum');
    const pairs = await redis.lrange('pairs:uniswap-v2:arbitrum', 0, -1);
    expect(pairs.length).toBeGreaterThan(0);
  });
});
```

**After** (InMemoryRedis):
```typescript
// tests/integration/s2.2.5-pair-services.integration.test.ts
import { InMemoryRedis } from '@arbitrage/test-utils/doubles';

describe('PairDiscoveryService', () => {
  let redis: InMemoryRedis;
  let service: PairDiscoveryService;

  beforeAll(() => {
    redis = new InMemoryRedis(); // In-memory, fast
  });

  beforeEach(async () => {
    await redis.flushall();
    service = new PairDiscoveryService({ redis });
  });

  it('should discover pairs', async () => {
    await service.discoverPairs('uniswap-v2', 'arbitrum');
    const pairs = await redis.lrange('pairs:uniswap-v2:arbitrum', 0, -1);
    expect(pairs.length).toBeGreaterThan(0);
  });
  // Same test, ~50x faster (no network I/O)
});
```

### Affected Files

**High Priority Conversions** (simple Redis usage):
- `tests/integration/s2.2.5-pair-services.integration.test.ts` - Basic list operations
- `tests/integration/s2.2-dex-expansion.integration.test.ts` - Basic key-value
- `tests/integration/s2.2.2-base-dex-expansion.integration.test.ts` - Basic key-value
- `tests/integration/s2.2.3-bsc-dex-expansion.integration.test.ts` - Basic key-value
- `tests/integration/s3.2.1-avalanche-configuration.integration.test.ts` - Basic key-value
- `tests/integration/s3.2.2-fantom-configuration.integration.test.ts` - Basic key-value
- [... more from audit of 29 Redis test files]

**Keep Real Redis** (Redis-specific tests):
- `tests/integration/s1.1-redis-streams.integration.test.ts` - Tests Redis Streams specifically
- `shared/redis/__tests__/integration/redis-client.integration.test.ts` - Tests Redis client wrapper
- `shared/redis/__tests__/integration/redis-streams.integration.test.ts` - Tests Streams API
- [... any tests in shared/redis/]

### Implementation Steps

**Step 1**: Update package exports

**File**: `shared/test-utils/package.json`

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./builders": "./src/builders/index.ts",
    "./helpers": "./src/helpers/index.ts",
    "./doubles": "./src/doubles/index.ts"  // Add this
  }
}
```

**File**: `shared/test-utils/src/doubles/index.ts` (create)

```typescript
export * from './in-memory-redis';
export { InMemoryRedis, createInMemoryRedis } from './in-memory-redis';
```

**Step 2**: Convert tests one by one

For each file in the "High Priority Conversions" list:

1. Change import:
   ```typescript
   // Before
   import Redis from 'ioredis';

   // After
   import { InMemoryRedis } from '@arbitrage/test-utils/doubles';
   ```

2. Change type:
   ```typescript
   // Before
   let redis: Redis;

   // After
   let redis: InMemoryRedis;
   ```

3. Change initialization:
   ```typescript
   // Before
   redis = new Redis(process.env.REDIS_URL);

   // After
   redis = new InMemoryRedis();
   ```

4. Remove async from beforeAll (no longer needed):
   ```typescript
   // Before
   beforeAll(async () => { /* ... */ });

   // After
   beforeAll(() => { /* ... */ });
   ```

5. Run tests to verify they still pass

6. Measure time improvement

**Step 3**: Update test documentation

**File**: `docs/TEST_ARCHITECTURE.md`

Add section on test doubles:

```markdown
## Test Doubles

### InMemoryRedis

For integration tests that don't need actual Redis-specific behavior, use `InMemoryRedis`:

```typescript
import { InMemoryRedis } from '@arbitrage/test-utils/doubles';

let redis: InMemoryRedis;

beforeAll(() => {
  redis = new InMemoryRedis(); // Fast, no network
});

// Use like normal Redis client
await redis.set('key', 'value');
const value = await redis.get('key');
```

**When to use**:
- Tests verifying application logic (not Redis behavior)
- Tests using basic Redis operations (get/set/del/lists/streams)
- Tests that need fast execution

**When NOT to use**:
- Tests in `shared/redis/` (testing Redis wrapper itself)
- Tests using Redis-specific features (Lua, transactions)
- Tests verifying Redis connection handling
```

### Acceptance Criteria
- [ ] `InMemoryRedis` exported from `@arbitrage/test-utils/doubles`
- [ ] 15-20 integration tests converted to use InMemoryRedis
- [ ] All converted tests still pass
- [ ] Tests using Redis-specific features still use real Redis
- [ ] Documentation updated with usage guidelines
- [ ] Integration test suite time reduced by at least 30% (measured)

### Testing Commands
```bash
# Test specific converted file
npm test -- tests/integration/s2.2.5-pair-services.integration.test.ts

# Measure before conversion
time npm test -- --selectProjects integration

# Measure after conversion
time npm test -- --selectProjects integration

# Verify tests using real Redis still work
npm test -- tests/integration/s1.1-redis-streams.integration.test.ts
```

### Performance Validation
```bash
# Before P2-2.2
# Integration tests with Redis: ~180 seconds

# After P2-2.2 (target)
# Integration tests with InMemoryRedis: <126 seconds (30% reduction)
# Savings: ~54 seconds
```

### Regression Risk
**LOW** - InMemoryRedis implements same interface as real Redis

**Potential Issues**:
- Timing differences (InMemoryRedis is synchronous, real Redis is async)
- Missing Redis features (if tests accidentally rely on them)

**Mitigation**:
- Convert incrementally, one test file at a time
- Run full test suite after each conversion
- Keep tests that specifically test Redis behavior using real Redis

### Notes
- Don't convert ALL Redis tests - keep real Redis tests for Redis-specific behavior
- Focus on tests that are slow due to Redis I/O, not compute-bound tests
- InMemoryRedis is a test double, not a production Redis replacement

---

## Issue P2-3.1: Configure Project-Specific Parallelization

**Priority**: P2 - Performance
**Effort**: 2 hours
**Type**: Configuration - Performance
**Dependencies**: None

### Problem Statement

Jest currently uses same `maxWorkers` setting for all project types:
- Current: 50% of CPU cores (local), 2 workers (CI)
- Issue: Unit tests could run with more parallelism (they're fast, CPU-bound)
- Issue: Integration tests might benefit from less parallelism (I/O-bound, Redis contention)

**Observation**: Unit tests (6000+ tests) take ~30 seconds but could be faster with more parallelization.

### Root Cause

One-size-fits-all `maxWorkers` configuration doesn't account for different test characteristics:
- **Unit tests**: CPU-bound, no shared resources, benefit from high parallelism
- **Integration tests**: I/O-bound, shared Redis, may have contention with high parallelism
- **Performance tests**: Must run serially to avoid interference

### Solution

Configure `maxWorkers` per project in Jest configuration based on test characteristics.

### Implementation

**File**: `jest.config.js`

**Current Code**:
```javascript
module.exports = {
  // ... other config ...

  // Global setting - applies to all projects
  maxWorkers: process.env.CI ? 2 : '50%',

  projects: [
    {
      displayName: 'unit',
      testMatch: ['**/__tests__/unit/**/*.test.ts'],
      // Inherits global maxWorkers
    },
    {
      displayName: 'integration',
      testMatch: ['**/__tests__/integration/**/*.test.ts'],
      // Inherits global maxWorkers
    },
    // ...
  ]
};
```

**Fixed Code**:
```javascript
module.exports = {
  // ... other config ...

  // Remove global maxWorkers (will be per-project)
  // maxWorkers: process.env.CI ? 2 : '50%',  // REMOVE THIS

  projects: [
    {
      displayName: 'unit',
      testMatch: ['**/__tests__/unit/**/*.test.ts'],
      setupFilesAfterEnv: [
        '<rootDir>/shared/test-utils/src/setup/jest-setup.ts',
        '<rootDir>/shared/test-utils/src/setup/jest.unit.setup.ts'
      ],
      // Unit tests: High parallelism (CPU-bound, no shared resources)
      maxWorkers: process.env.CI ? 4 : '75%',  // More aggressive
      ...projectConfig
    },
    {
      displayName: 'integration',
      testMatch: [
        '**/__tests__/integration/**/*.test.ts',
        '**/tests/integration/**/*.test.ts'
      ],
      setupFilesAfterEnv: [
        '<rootDir>/shared/test-utils/src/setup/jest-setup.ts',
        '<rootDir>/shared/test-utils/src/setup/jest.integration.setup.ts'
      ],
      // Integration tests: Moderate parallelism (I/O-bound, shared Redis)
      maxWorkers: process.env.CI ? 2 : '50%',  // Keep current
      ...projectConfig
    },
    {
      displayName: 'e2e',
      testMatch: ['**/tests/e2e/**/*.test.ts'],
      setupFilesAfterEnv: [
        '<rootDir>/shared/test-utils/src/setup/jest-setup.ts',
        '<rootDir>/shared/test-utils/src/setup/jest.e2e.setup.ts'
      ],
      // E2E tests: Low parallelism (full system tests, potential conflicts)
      maxWorkers: process.env.CI ? 1 : 2,  // Serial in CI, minimal locally
      ...projectConfig
    },
    {
      displayName: 'performance',
      testMatch: ['**/tests/performance/**/*.test.ts', '**/tests/performance/**/*.perf.ts'],
      setupFilesAfterEnv: [
        '<rootDir>/shared/test-utils/src/setup/jest-setup.ts',
        '<rootDir>/shared/test-utils/src/setup/jest.performance.setup.ts'
      ],
      // Performance tests: MUST be serial (measuring performance)
      maxWorkers: 1,  // Always serial
      ...projectConfig
    },
    {
      displayName: 'smoke',
      testMatch: ['**/tests/smoke/**/*.test.ts', '**/tests/smoke/**/*.smoke.ts'],
      setupFilesAfterEnv: [
        '<rootDir>/shared/test-utils/src/setup/jest-setup.ts',
        '<rootDir>/shared/test-utils/src/setup/jest.smoke.setup.ts'
      ],
      // Smoke tests: Low parallelism (quick checks, may share resources)
      maxWorkers: process.env.CI ? 1 : 2,
      ...projectConfig
    }
  ]
};
```

### Rationale for Worker Counts

| Project | Local maxWorkers | CI maxWorkers | Reasoning |
|---------|------------------|---------------|-----------|
| Unit | 75% | 4 | CPU-bound, no shared resources, more parallelism = faster |
| Integration | 50% | 2 | I/O-bound, shared Redis, moderate parallelism avoids contention |
| E2E | 2 | 1 | Full system tests, serial execution avoids conflicts |
| Performance | 1 | 1 | Must be serial to measure accurate performance |
| Smoke | 2 | 1 | Quick checks, minimal parallelism for reliability |

### Acceptance Criteria
- [ ] Global `maxWorkers` removed from root config
- [ ] Per-project `maxWorkers` configured for all 5 projects
- [ ] Unit tests use 75% workers (local), 4 workers (CI)
- [ ] Performance tests always use 1 worker (serial)
- [ ] All tests still pass with new worker configuration
- [ ] Unit test execution time reduced by at least 30% (measured)

### Testing Commands
```bash
# Measure before change
time npm test -- --selectProjects unit

# After change
time npm test -- --selectProjects unit

# Verify performance tests run serially
npm test -- --selectProjects performance --verbose

# Run all projects to verify no conflicts
npm test
```

### Performance Validation
```bash
# Before P2-3.1
# Unit tests (6000+ tests): ~30 seconds with 50% workers

# After P2-3.1 (target)
# Unit tests: <21 seconds with 75% workers (30% reduction)
# Savings: ~9 seconds
```

### Regression Risk
**LOW** - Only changes parallelization, not test logic

**Potential Issues**:
- Increased memory usage with more workers (unit tests)
- Possible race conditions if unit tests share state (rare)

**Mitigation**:
- Monitor memory usage in CI
- Run full suite 3 times to catch rare race conditions

### Notes
- Adjust worker counts based on actual hardware (these are starting points)
- Monitor CI performance - if memory issues arise, reduce unit test workers
- Performance tests MUST remain serial - don't change this

---

## Issue P2-3.2: Add CI Test Sharding Configuration

**Priority**: P2 - Performance
**Effort**: 2 hours
**Type**: Configuration - CI Optimization
**Dependencies**: P2-3.1 complete (project-specific workers configured)

### Problem Statement

CI runs entire test suite serially in one job, taking ~75 minutes. Could shard tests across multiple parallel CI jobs for faster feedback.

**Current**: 1 CI job running all tests sequentially
**Proposed**: 4 parallel CI jobs, each running 1/4 of tests

**Expected Improvement**: 75 minutes → <20 minutes (75% reduction)

### Root Cause

CI configuration doesn't leverage Jest's sharding capabilities or GitHub Actions matrix strategy.

### Solution

Configure Jest sharding and GitHub Actions matrix to run tests in parallel CI jobs.

### Implementation

This depends on your CI system. Here are examples for common CI providers:

#### GitHub Actions Configuration

**File**: `.github/workflows/test.yml` (or similar)

```yaml
name: Test Suite

on: [push, pull_request]

jobs:
  # Unit tests - shard across 3 jobs (fastest tests, most parallelism)
  unit-tests:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: [1, 2, 3]
    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run Unit Tests (Shard ${{ matrix.shard }}/3)
        run: npm test -- --selectProjects unit --shard=${{ matrix.shard }}/3

      - name: Upload Coverage
        uses: codecov/codecov-action@v3
        with:
          flags: unit-shard-${{ matrix.shard }}

  # Integration tests - shard across 2 jobs (slower tests, moderate parallelism)
  integration-tests:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: [1, 2]
    services:
      redis:
        image: redis:7-alpine
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 6379:6379
    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run Integration Tests (Shard ${{ matrix.shard }}/2)
        run: npm test -- --selectProjects integration --shard=${{ matrix.shard }}/2
        env:
          REDIS_URL: redis://localhost:6379

      - name: Upload Coverage
        uses: codecov/codecov-action@v3
        with:
          flags: integration-shard-${{ matrix.shard }}

  # E2E tests - no sharding (few tests, must be serial)
  e2e-tests:
    runs-on: ubuntu-latest
    services:
      redis:
        image: redis:7-alpine
        ports:
          - 6379:6379
    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run E2E Tests
        run: npm test -- --selectProjects e2e
        env:
          REDIS_URL: redis://localhost:6379

  # Performance tests - no sharding (must be serial)
  performance-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run Performance Tests
        run: npm test -- --selectProjects performance
```

#### Alternative: npm scripts for local testing of shards

**File**: `package.json`

```json
{
  "scripts": {
    "test": "jest",
    "test:unit": "jest --selectProjects unit",
    "test:unit:shard1": "jest --selectProjects unit --shard=1/3",
    "test:unit:shard2": "jest --selectProjects unit --shard=2/3",
    "test:unit:shard3": "jest --selectProjects unit --shard=3/3",
    "test:integration": "jest --selectProjects integration",
    "test:integration:shard1": "jest --selectProjects integration --shard=1/2",
    "test:integration:shard2": "jest --selectProjects integration --shard=2/2",
    "test:ci": "jest --ci --coverage --maxWorkers=2"
  }
}
```

### Sharding Strategy

**Unit Tests**: 3 shards
- ~2000 tests per shard
- Each shard runs in ~7 minutes (vs 21 minutes for all)
- Total CI time for unit tests: ~7 minutes (3 parallel jobs)

**Integration Tests**: 2 shards
- ~30-40 tests per shard
- Each shard runs in ~1 minute (vs 2 minutes for all)
- Total CI time for integration tests: ~1 minute (2 parallel jobs)

**E2E Tests**: No sharding
- Few tests, must be serial
- Runs in ~2 minutes

**Total CI Time**: ~10 minutes (vs 75 minutes sequential)

### Acceptance Criteria
- [ ] CI configuration updated with matrix strategy
- [ ] Unit tests sharded across 3 parallel jobs
- [ ] Integration tests sharded across 2 parallel jobs
- [ ] E2E and performance tests remain single jobs (serial)
- [ ] All shards complete successfully
- [ ] Coverage reports aggregated correctly
- [ ] CI total time reduced by at least 60% (measured)

### Testing Commands
```bash
# Test sharding locally
npm run test:unit:shard1
npm run test:unit:shard2
npm run test:unit:shard3

# Verify all shards together cover all tests
npm run test:unit

# Test in CI-like environment
CI=true npm test -- --ci --coverage
```

### Performance Validation
```bash
# Before P2-3.2
# CI total time: ~75 minutes (sequential)

# After P2-3.2 (target)
# CI total time: <30 minutes (parallel sharding)
# Savings: ~45 minutes (60% reduction)
```

### Regression Risk
**MEDIUM** - CI configuration changes can break deployment pipeline

**Potential Issues**:
- Coverage reports not aggregating correctly
- Shards not balanced (some finish much faster than others)
- Flaky tests appearing more frequently in parallel execution

**Mitigation**:
- Test CI configuration in a feature branch before merging
- Monitor shard execution times and rebalance if needed
- Run full suite locally before pushing to CI

### Notes
- Sharding is most beneficial for large test suites (6000+ tests)
- Monitor CI cost - more parallel jobs = higher cost (but faster feedback)
- Jest automatically balances shards based on test execution time
- Adjust shard counts based on actual CI execution times

---

## Issue P2-4.1: Implement Jest Reporter for Slow Tests

**Priority**: P2 - Performance
**Effort**: 3 hours
**Type**: Enhancement - Monitoring
**Dependencies**: None

### Problem Statement

No visibility into which specific tests are slow, making it hard to identify optimization targets.

**Need**:
- Identify tests taking >100ms (unit tests)
- Identify tests taking >5 seconds (integration tests)
- Report slow tests in CI for performance regression tracking

### Solution

Create custom Jest reporter that identifies and reports slow tests.

### Implementation

**File**: `shared/test-utils/src/reporters/slow-test-reporter.ts`

```typescript
/**
 * Jest Reporter for Slow Tests
 *
 * Reports tests that exceed performance budgets:
 * - Unit tests: >100ms (warning), >500ms (error)
 * - Integration tests: >5s (warning), >10s (error)
 * - E2E tests: >30s (warning), >60s (error)
 *
 * Usage in jest.config.js:
 * ```javascript
 * reporters: [
 *   'default',
 *   ['<rootDir>/shared/test-utils/src/reporters/slow-test-reporter.js', {
 *     unitThreshold: 100,
 *     integrationThreshold: 5000,
 *     e2eThreshold: 30000
 *   }]
 * ]
 * ```
 */

import type {
  AggregatedResult,
  Test,
  TestResult,
  Reporter,
  ReporterOnStartOptions,
  TestContext
} from '@jest/reporters';
import * as fs from 'fs';
import * as path from 'path';

interface SlowTestConfig {
  unitThreshold?: number; // ms
  integrationThreshold?: number; // ms
  e2eThreshold?: number; // ms
  outputFile?: string; // Path to write slow tests JSON
  failOnSlow?: boolean; // Fail CI if slow tests exceed threshold
}

interface SlowTest {
  testPath: string;
  testName: string;
  duration: number;
  threshold: number;
  project: string;
}

export default class SlowTestReporter implements Reporter {
  private config: Required<SlowTestConfig>;
  private slowTests: SlowTest[] = [];

  constructor(
    _globalConfig: any,
    options: SlowTestConfig = {}
  ) {
    this.config = {
      unitThreshold: options.unitThreshold ?? 100,
      integrationThreshold: options.integrationThreshold ?? 5000,
      e2eThreshold: options.e2eThreshold ?? 30000,
      outputFile: options.outputFile ?? 'slow-tests.json',
      failOnSlow: options.failOnSlow ?? false
    };
  }

  onRunStart(
    _aggregatedResult: AggregatedResult,
    _options: ReporterOnStartOptions
  ): void {
    this.slowTests = [];
  }

  onTestResult(
    _test: Test,
    testResult: TestResult,
    _aggregatedResult: AggregatedResult
  ): void {
    const testPath = testResult.testFilePath;
    const project = this.detectProject(testPath);
    const threshold = this.getThreshold(project);

    // Check each test in the file
    testResult.testResults.forEach(test => {
      const duration = test.duration ?? 0;

      if (duration > threshold) {
        this.slowTests.push({
          testPath: testPath,
          testName: test.fullName,
          duration,
          threshold,
          project
        });
      }
    });
  }

  async onRunComplete(
    _contexts?: Set<TestContext>,
    aggregatedResult?: AggregatedResult
  ): Promise<void> {
    if (this.slowTests.length === 0) {
      console.log('\n✅ No slow tests detected!\n');
      return;
    }

    // Sort by duration (slowest first)
    this.slowTests.sort((a, b) => b.duration - a.duration);

    // Print to console
    console.log('\n⚠️  Slow Tests Detected:\n');
    console.log('━'.repeat(80));

    this.slowTests.forEach((test, index) => {
      const overageMs = test.duration - test.threshold;
      const overagePercent = ((test.duration / test.threshold - 1) * 100).toFixed(0);

      console.log(
        `${index + 1}. [${test.project}] ${test.duration}ms ` +
        `(${overagePercent}% over ${test.threshold}ms threshold)`
      );
      console.log(`   ${test.testName}`);
      console.log(`   ${test.testPath}`);
      console.log('');
    });

    console.log('━'.repeat(80));
    console.log(`Total slow tests: ${this.slowTests.length}\n`);

    // Write to JSON file
    const outputPath = path.resolve(this.config.outputFile);
    fs.writeFileSync(
      outputPath,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          slowTests: this.slowTests,
          summary: {
            total: this.slowTests.length,
            byProject: this.groupByProject()
          }
        },
        null,
        2
      )
    );

    console.log(`Slow test report written to: ${outputPath}\n`);

    // Optionally fail CI
    if (this.config.failOnSlow && this.slowTests.length > 0) {
      throw new Error(
        `${this.slowTests.length} tests exceeded performance thresholds. ` +
        `See ${outputPath} for details.`
      );
    }
  }

  private detectProject(testPath: string): string {
    if (testPath.includes('/__tests__/unit/')) return 'unit';
    if (testPath.includes('/__tests__/integration/')) return 'integration';
    if (testPath.includes('/tests/e2e/')) return 'e2e';
    if (testPath.includes('/tests/integration/')) return 'integration';
    if (testPath.includes('/tests/performance/')) return 'performance';
    return 'unknown';
  }

  private getThreshold(project: string): number {
    switch (project) {
      case 'unit':
        return this.config.unitThreshold;
      case 'integration':
        return this.config.integrationThreshold;
      case 'e2e':
        return this.config.e2eThreshold;
      default:
        return this.config.integrationThreshold; // Default to integration
    }
  }

  private groupByProject(): Record<string, number> {
    return this.slowTests.reduce((acc, test) => {
      acc[test.project] = (acc[test.project] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
  }
}
```

### Jest Configuration Update

**File**: `jest.config.js`

```javascript
module.exports = {
  // ... existing config ...

  // Add slow test reporter
  reporters: [
    'default', // Keep default reporter
    [
      '<rootDir>/shared/test-utils/src/reporters/slow-test-reporter.js',
      {
        unitThreshold: 100, // Unit tests should be <100ms
        integrationThreshold: 5000, // Integration tests should be <5s
        e2eThreshold: 30000, // E2E tests should be <30s
        outputFile: 'slow-tests.json',
        failOnSlow: process.env.CI === 'true' // Fail CI if slow tests detected
      }
    ]
  ],

  // ... rest of config ...
};
```

### Acceptance Criteria
- [ ] `SlowTestReporter` implemented with configurable thresholds
- [ ] Reporter added to `jest.config.js`
- [ ] Slow tests printed to console after test run
- [ ] Slow tests written to `slow-tests.json` file
- [ ] Reporter can optionally fail CI on slow tests
- [ ] Reporter distinguishes between unit/integration/e2e tests

### Testing Commands
```bash
# Run tests with slow test reporter
npm test

# Check slow-tests.json output
cat slow-tests.json

# Test with lower threshold (to force some slow tests)
npm test -- --reporters='<rootDir>/shared/test-utils/src/reporters/slow-test-reporter.js' --unitThreshold=10

# Test CI failure mode
CI=true npm test  # Should fail if slow tests detected
```

### Example Output
```
⚠️  Slow Tests Detected:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. [integration] 8234ms (65% over 5000ms threshold)
   S3.3.1 SolanaDetector › should detect arbitrage opportunities
   /arbitrage_new/tests/integration/s3.3.1-solana-detector.integration.test.ts

2. [unit] 247ms (147% over 100ms threshold)
   PriceCalculator › should calculate complex triangular arbitrage
   /arbitrage_new/shared/core/__tests__/unit/components/price-calculator.test.ts

3. [integration] 6100ms (22% over 5000ms threshold)
   PairDiscoveryService › should discover all pairs on BSC
   /arbitrage_new/tests/integration/s2.2.3-bsc-dex-expansion.integration.test.ts

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total slow tests: 3

Slow test report written to: slow-tests.json
```

### Regression Risk
**LOW** - Reporter is read-only, doesn't affect test execution

**Potential Issues**:
- Reporter might add small overhead to test execution (<1%)
- JSON file writes might fail in restricted environments

**Mitigation**:
- Make `failOnSlow` opt-in (only enable in CI if desired)
- Handle file write errors gracefully

### Notes
- Start with lenient thresholds, tighten over time as tests are optimized
- Use `slow-tests.json` to track performance regression over time
- Consider adding this to CI artifacts for historical tracking

---

## Issue P2-4.2: Set Up Performance Tracking in CI

**Priority**: P2 - Performance
**Effort**: 1 hour
**Type**: Enhancement - CI/CD
**Dependencies**: P2-4.1 complete (slow test reporter implemented)

### Problem Statement

No historical tracking of test performance, making it impossible to detect performance regressions over time.

### Solution

Configure CI to:
1. Upload `slow-tests.json` as artifact
2. Track test execution time over commits
3. Alert on performance regressions

### Implementation (GitHub Actions)

**File**: `.github/workflows/test.yml`

Add performance tracking job:

```yaml
# ... existing jobs ...

  # Performance tracking (runs after all tests)
  track-performance:
    runs-on: ubuntu-latest
    needs: [unit-tests, integration-tests, e2e-tests]
    if: always() # Run even if some tests failed
    steps:
      - uses: actions/checkout@v3

      - name: Download Slow Tests Report
        uses: actions/download-artifact@v3
        with:
          name: slow-tests-report

      - name: Track Performance Metrics
        run: |
          echo "## Test Performance Report" >> $GITHUB_STEP_SUMMARY
          echo "" >> $GITHUB_STEP_SUMMARY

          if [ -f slow-tests.json ]; then
            SLOW_TEST_COUNT=$(jq '.summary.total' slow-tests.json)
            echo "🐌 Slow tests detected: $SLOW_TEST_COUNT" >> $GITHUB_STEP_SUMMARY
            echo "" >> $GITHUB_STEP_SUMMARY

            # List top 5 slowest tests
            echo "### Top 5 Slowest Tests" >> $GITHUB_STEP_SUMMARY
            jq -r '.slowTests[:5] | .[] | "- [\(.project)] \(.duration)ms - \(.testName)"' slow-tests.json >> $GITHUB_STEP_SUMMARY
          else
            echo "✅ No slow tests detected!" >> $GITHUB_STEP_SUMMARY
          fi

      - name: Upload Performance Artifact
        uses: actions/upload-artifact@v3
        with:
          name: performance-report-${{ github.sha }}
          path: slow-tests.json
          retention-days: 90

      - name: Comment on PR (if applicable)
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v6
        with:
          script: |
            const fs = require('fs');

            if (!fs.existsSync('slow-tests.json')) {
              await github.rest.issues.createComment({
                issue_number: context.issue.number,
                owner: context.repo.owner,
                repo: context.repo.repo,
                body: '✅ No slow tests detected in this PR!'
              });
              return;
            }

            const report = JSON.parse(fs.readFileSync('slow-tests.json', 'utf8'));

            const body = `## ⚠️ Slow Tests Detected

This PR introduces or modifies ${report.summary.total} tests that exceed performance thresholds.

### Top 5 Slowest Tests
${report.slowTests.slice(0, 5).map((test, i) =>
  `${i + 1}. **[${test.project}]** ${test.duration}ms - \`${test.testName}\``
).join('\n')}

<details>
<summary>Performance Thresholds</summary>

- Unit tests: <100ms
- Integration tests: <5s
- E2E tests: <30s
</details>

Consider optimizing these tests or adjusting thresholds if the performance is acceptable.`;

            await github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body
            });
```

### Alternative: npm script for local performance tracking

**File**: `package.json`

```json
{
  "scripts": {
    "test:perf": "npm test && node scripts/analyze-performance.js"
  }
}
```

**File**: `scripts/analyze-performance.js`

```javascript
#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const reportPath = path.join(__dirname, '../slow-tests.json');

if (!fs.existsSync(reportPath)) {
  console.log('✅ No slow tests detected!');
  process.exit(0);
}

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

console.log('\n📊 Performance Analysis\n');
console.log('━'.repeat(80));
console.log(`Total slow tests: ${report.summary.total}`);
console.log(`By project: ${JSON.stringify(report.summary.byProject, null, 2)}`);
console.log('━'.repeat(80));

// Compare with previous run (if available)
const previousReportPath = path.join(__dirname, '../slow-tests.previous.json');
if (fs.existsSync(previousReportPath)) {
  const previousReport = JSON.parse(fs.readFileSync(previousReportPath, 'utf8'));
  const delta = report.summary.total - previousReport.summary.total;

  if (delta > 0) {
    console.log(`\n⚠️  Performance regression: +${delta} slow tests since last run`);
  } else if (delta < 0) {
    console.log(`\n✅ Performance improvement: ${-delta} fewer slow tests since last run`);
  } else {
    console.log(`\n➡️  No change in slow test count since last run`);
  }
}

// Save current report for next comparison
fs.copyFileSync(reportPath, previousReportPath);

console.log('\n');
```

### Acceptance Criteria
- [ ] CI uploads `slow-tests.json` as artifact
- [ ] Performance summary added to GitHub Actions summary
- [ ] Slow test comment added to PRs (if applicable)
- [ ] Historical performance data retained for 90 days
- [ ] Local script available for performance comparison

### Testing Commands
```bash
# Generate performance report locally
npm test
node scripts/analyze-performance.js

# Test CI workflow (in feature branch)
git push origin feature/performance-tracking
# Check GitHub Actions UI for performance summary
```

### Regression Risk
**LOW** - Monitoring only, doesn't affect test execution

### Notes
- Adjust artifact retention based on needs (90 days is a reasonable default)
- Consider integrating with external performance tracking tools (e.g., Datadog, Grafana)
- Start tracking now to establish baseline before P2 optimizations

---

## Summary: P2 Implementation Plan

**Total Issues**: 8 (P2-1.1, P2-1.2, P2-2.1, P2-2.2, P2-3.1, P2-3.2, P2-4.1, P2-4.2)
**Total Effort**: 24 hours (3 days)
**Expected Performance Improvement**: 50% reduction in test execution time

### Implementation Sequence

**Week 1 - Days 1-2 (8 hours)**:
1. P2-4.1: Implement slow test reporter (3h) - Get visibility first
2. P2-4.2: Set up performance tracking (1h) - Establish baseline
3. P2-1.1: Audit beforeEach usage (2h) - Identify optimization targets
4. P2-2.1: Implement InMemoryRedis (4h) - Build test infrastructure

**Week 1 - Day 3 (8 hours)**:
5. P2-1.2: Convert beforeEach to beforeAll (6h) - Biggest wins
6. P2-2.2: Replace Redis with InMemoryRedis (4h) - Second biggest wins

**Week 2 - Day 1 (8 hours)**:
7. P2-3.1: Configure project-specific parallelization (2h) - Quick win
8. P2-3.2: Add CI test sharding (2h) - CI speedup
9. Final validation and measurement (4h)

### Success Metrics

**Before P2** (Baseline):
- Total test time: ~4,500 seconds (75 minutes)
- Integration test time: ~300 seconds (5 minutes)
- Unit test time: ~30 seconds
- CI time: ~75 minutes

**After P2** (Target):
- Total test time: <2,250 seconds (37.5 minutes) - **50% reduction**
- Integration test time: <120 seconds (2 minutes) - **60% reduction**
- Unit test time: <21 seconds - **30% reduction**
- CI time: <30 minutes - **60% reduction**

### Validation

After completing all P2 issues:

```bash
# Measure final performance
time npm test

# Verify all tests still pass
npm test -- --coverage

# Check slow test report
cat slow-tests.json

# Compare with baseline (tracked in CI artifacts)
```

---

**Status**: Ready for implementation
**Next Step**: Begin with P2-4.1 (slow test reporter) to establish baseline metrics
