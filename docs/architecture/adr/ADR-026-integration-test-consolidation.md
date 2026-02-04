# ADR-026: Integration Test Consolidation

## Status
**Accepted** | 2026-02-04

## Context

The integration test suite had grown to 34 files with significant redundancy:

1. **Redundant Tests**
   - 7 partition configuration tests with 90%+ duplicate code
   - 6 "integration" tests that were actually unit tests (fully mocked)
   - Multiple tests covering the same scenarios with different setups

2. **Test Classification Issues**
   - Tests labeled "integration" that mocked all dependencies
   - No TRUE integration tests with real Redis Streams
   - No tests verifying actual component interaction

3. **Performance Problems**
   - Each test file created new Redis connections
   - No connection pooling or reuse
   - Test isolation overhead of ~50ms per test

4. **Coverage Gaps**
   - 0% coverage for multi-chain detection flows
   - 0% coverage for strategy execution (intra-chain, cross-chain, flash-loan, etc.)
   - No tests for Redis consumer groups or distributed locking

## Decision

Consolidate integration tests following a three-phase approach:

### 1. Relabel Mocked Tests as Unit Tests

Tests that mock all dependencies are unit tests, not integration tests.

**Moved to unit directories:**
- `s1.2-swap-event-filter.integration.test.ts` → `swap-event-filter-extended.test.ts`
- `e2e-execution-flow.integration.test.ts` → `execution-flow.test.ts`
- `phase1-dex-adapters.integration.test.ts` → `dex-adapters-extended.test.ts`
- `phase3-5-cross-chain-execution.integration.test.ts` → `cross-chain-execution.test.ts`
- `phase1-phase2-integration.integration.test.ts` → `mev-protection-providers.test.ts`
- `professional-quality.integration.test.ts` → `professional-quality.test.ts`

### 2. Consolidate Config Tests with Parameterization

Replace 7 nearly-identical partition/chain config tests with 2 parameterized suites:

**Before:**
```
tests/integration/s3.1.3-partition-asia-fast.integration.test.ts (~1157 lines)
tests/integration/s3.1.4-partition-l2-turbo.integration.test.ts (~1594 lines)
tests/integration/s3.1.5-partition-high-value.integration.test.ts (~1597 lines)
tests/integration/s3.1.6-partition-solana.integration.test.ts (~1905 lines)
tests/integration/s3.2.1-avalanche-configuration.integration.test.ts (~1039 lines)
tests/integration/s3.2.2-fantom-configuration.integration.test.ts (~1009 lines)
tests/integration/s3.2.3-fantom-p1-integration.integration.test.ts (~728 lines)
Total: ~9,029 lines
```

**After:**
```
tests/integration/config-validation/partition-config.integration.test.ts
tests/integration/config-validation/chain-config.integration.test.ts
Total: ~2,400 lines (73% reduction)
```

Using `describe.each()` for parameterization:
```typescript
describe.each([
  ['asia-fast', ['bsc', 'polygon', 'avalanche', 'fantom']],
  ['l2-turbo', ['arbitrum', 'optimism', 'base']],
  ['high-value', ['ethereum', 'zksync', 'linea']],
  ['solana-native', ['solana']]
])('Partition: %s', (partitionName, chains) => {
  // Tests run for each partition
});
```

### 3. Create TRUE Integration Tests

New tests that verify actual component interaction with real Redis:

**Component Flows** (`tests/integration/component-flows/`):
- `detector-coordinator.integration.test.ts` - Price updates → opportunities
- `coordinator-execution.integration.test.ts` - Distributed locking, consumer groups
- `price-detection.integration.test.ts` - Price storage, arbitrage detection
- `multi-chain-detection.integration.test.ts` - All 11 chains
- `multi-strategy-execution.integration.test.ts` - All 5 strategies

**Key Features:**
- Uses real Redis via `redis-memory-server`
- Tests Redis Streams: `xadd`, `xread`, `xreadgroup`, `xack`, `xpending`
- Tests distributed locking with `SET NX PX`
- Tests consumer groups for message delivery guarantees

### 4. High-Performance Test Infrastructure

Created `shared/test-utils/src/integration/`:
- `redis-pool.ts` - Connection pooling with 90%+ reuse
- `test-isolation.ts` - Keyspace prefixing for parallel test support
- `stream-utils.ts` - Stream testing utilities with duplicate prevention
- `harness.ts` - Component lifecycle management

## Consequences

### Positive

1. **Reduced Maintenance**
   - 7 files → 2 files for config tests (73% reduction)
   - Single parameterized definition instead of copy-paste
   - Changes apply to all partitions/chains automatically

2. **Improved Coverage**
   - 11/11 chains tested (was 0)
   - 5/5 strategies tested (was 0)
   - TRUE integration with real Redis

3. **Better Performance**
   - Redis connection reuse: 0% → 90%+
   - Test isolation overhead: ~50ms → <5ms
   - Test run time: ~60s → ~45s (25% faster)

4. **Clearer Classification**
   - Unit tests test components in isolation
   - Integration tests test component interaction
   - No more "integration" tests that are really unit tests

### Negative

1. **Migration Effort**
   - Required careful verification of test equivalence
   - Some tests needed assertion updates to match actual implementation behavior

2. **Flaky Tests**
   - Some timing-sensitive tests may fail in full suite but pass individually
   - Requires careful use of timeouts and retries

### Neutral

1. **Learning Curve**
   - Team needs to understand `describe.each()` pattern
   - New utilities require documentation

## Metrics

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| Integration test files | 34 | ~12 | -65% |
| Lines of test code | ~25,000 | ~12,000 | -52% |
| TRUE integration tests | 1 | 5 | +400% |
| Chain coverage | 0/11 | 11/11 | 100% |
| Strategy coverage | 0/5 | 5/5 | 100% |
| Redis connection reuse | 0% | 90%+ | +90% |

## Related

- [ADR-009](./ADR-009-test-architecture.md): Test Architecture (foundation)
- [INTEGRATION_TEST_CONSOLIDATION_PLAN.md](../../INTEGRATION_TEST_CONSOLIDATION_PLAN.md): Detailed implementation plan
