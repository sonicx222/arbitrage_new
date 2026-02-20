# Full Pipeline Integration Test Design

**Date**: 2026-02-20
**Audit Reference**: TEST_AUDIT_REPORT.md - Fix #14 (P4 Coverage Gap - HIGH risk)
**Status**: Approved

## Problem

Individual pipeline components are unit-tested but the end-to-end data flow is untested:

```
detector → stream:opportunities → coordinator forwarding → stream:execution-requests
→ OpportunityConsumer → Queue → Distributed Lock → Strategy → stream:execution-results → XACK
```

This is a HIGH-risk coverage gap because integration failures (serialization mismatches, consumer group misconfiguration, deferred ACK race conditions) are invisible to unit tests.

## Approach

**Real Services with SimulationMode** — instantiate the actual `ExecutionEngineService` with `simulationConfig: { enabled: true }` connected to redis-memory-server. A thin coordinator forwarder mimics `OpportunityRouter.forwardToExecutionEngine()` for the detection-to-execution bridge.

### What Is Real
- Redis (via redis-memory-server, shared from jest.globalSetup)
- Redis Streams (XADD, XREADGROUP, XACK, consumer groups)
- `ExecutionEngineService` full lifecycle (start/stop)
- `OpportunityConsumer` with deferred ACK
- `QueueService` with backpressure
- Distributed lock manager (SET NX PX)
- `SimulationStrategy` for execution

### What Is Mocked
- Blockchain RPC providers (not needed — SimulationStrategy)
- Gas estimation (not needed)
- MEV providers (not needed)
- Wallet/signer (not needed)
- HMAC signing (no STREAM_SIGNING_KEY env var)

## File Location

```
tests/integration/pipeline/full-pipeline.integration.test.ts
```

- Root-level `tests/integration/` (all files here use real Redis per audit)
- New `pipeline/` subdirectory for this distinct test category
- `.integration.test.ts` suffix per ADR-009

## Architecture

```
TEST HARNESS (redis-memory-server from globalSetup)

  [Test publishes opportunity]
         |
         v
  stream:opportunities
         |
         v
  [Thin Coordinator Forwarder]     ~40 lines
  - XREADGROUP from stream:opportunities (group: test-coordinator-group)
  - Serialize with forwardedBy/forwardedAt metadata
  - XADD to stream:execution-requests
  - XACK on stream:opportunities
         |
         v
  stream:execution-requests
         |
         v
  [Real ExecutionEngineService]    SimulationMode
  - OpportunityConsumer reads via consumer group (execution-engine-group)
  - QueueService manages backpressure
  - Distributed lock prevents duplicates
  - SimulationStrategy executes (configurable success rate)
  - Result published to stream:execution-results
  - Deferred XACK on stream:execution-requests
         |
         v
  stream:execution-results
         |
         v
  [StreamCollector]                from @arbitrage/test-utils
  - Collects results for assertion
```

### Thin Coordinator Forwarder

A test helper (~40 lines), NOT the full `CoordinatorService`. It mimics only the forwarding path:

```typescript
class TestCoordinatorForwarder {
  // Reads from stream:opportunities via XREADGROUP
  // Validates minimum fields (id required)
  // Serializes with coordinator metadata (forwardedBy, forwardedAt)
  // Writes to stream:execution-requests via XADD
  // ACKs the source message
  // Polls every 100ms
}
```

This keeps the test focused on data flow, not coordinator leadership election, circuit breakers, or metrics.

## Test Lifecycle

```typescript
beforeAll(async () => {
  redis = await createTestRedisClient();
}, 30000);

beforeEach(async () => {
  await redis.flushall();
  // Create consumer groups for all streams
  // Initialize forwarder
  // Initialize ExecutionEngineService with SimulationStrategy
  // Start engine, forwarder, result collector
});

afterEach(async () => {
  // Stop forwarder, engine, collector (in reverse order)
});

afterAll(async () => {
  await redis.quit();
});
```

**Timeouts**: 60s per test (Jest integration default). `waitForMessages` uses 10s with exponential backoff polling.

## Test Cases

### Happy Path (3 tests)

**1. "should execute opportunity through full pipeline"**
- Publish 1 opportunity to `stream:opportunities`
- Wait for result on `stream:execution-results`
- Assert: result.success === true, result.id matches opportunity ID
- Assert: XPENDING count = 0 on both `stream:opportunities` and `stream:execution-requests`

**2. "should handle batch of opportunities"**
- Publish 5 distinct opportunities to `stream:opportunities`
- Wait for 5 results on `stream:execution-results`
- Assert: all 5 opportunity IDs represented in results
- Assert: all streams fully ACKed

**3. "should preserve opportunity data through pipeline"**
- Publish opportunity with specific fields: `{ id, chain: 'ethereum', buyDex: 'uniswap_v3', sellDex: 'sushiswap', expectedProfit: 42.5, confidence: 0.95 }`
- Wait for result
- Assert: result.id === opportunity.id
- Assert: result.chain === 'ethereum'

### Consumer Group Semantics (2 tests)

**4. "should distribute messages across multiple consumers"**
- Start 2 ExecutionEngineService instances on same consumer group
- Publish 10 opportunities
- Wait for 10 total results
- Assert: total results = 10 (no lost messages)
- Assert: no duplicate opportunity IDs in results

**5. "should prevent duplicate execution via distributed lock"**
- Publish opportunity to `stream:execution-requests` twice with same ID
- Wait for processing to complete
- Assert: only 1 execution result (lock blocked duplicate)

### Edge Cases (2 tests)

**6. "should handle invalid opportunity gracefully"**
- Publish malformed message (missing `id` field) to `stream:execution-requests`
- Wait briefly
- Assert: no result on `stream:execution-results`
- Assert: message ACKed (removed from pending) — invalid messages get immediate ACK after DLQ

**7. "should ACK messages after execution completes (deferred ACK)"**
- Publish opportunity
- Immediately check XPENDING — should be > 0 (not yet ACKed)
- Wait for result on `stream:execution-results`
- Check XPENDING again — should be 0 (ACKed after execution)

### Pipeline Instrumentation (1 test)

**8. "should track pipeline latency through all stages"**
- Publish opportunity with `pipelineTimestamps: { detectedAt: Date.now() }`
- Wait for result
- Assert: result metadata includes timestamp chain showing progression through stages

## Dependencies

### From @arbitrage/test-utils
- `createTestRedisClient()` — real Redis connection
- `createTestOpportunity()` — opportunity factory
- `ensureConsumerGroup()` — idempotent group creation
- `waitForMessages()` — poll stream with exponential backoff
- `StreamCollector` — continuous collection from consumer group

### From @arbitrage/core
- `RedisStreamsClient` — for the forwarder's stream operations
- `RedisStreams` (constants) — stream names

### From execution-engine
- `ExecutionEngineService` — the main service under test

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Engine init fails due to missing deps | SimulationMode skips blockchain deps; mock logger/perfLogger |
| Flaky timing in async assertions | Exponential backoff polling in waitForMessages (10ms → 100ms max) |
| Stream name collisions across parallel tests | Prefix all stream names with unique test ID |
| Redis-memory-server not available | Depends on jest.globalSetup.ts which starts it; 30s beforeAll timeout |
| Engine stop() hangs | 5s timeout on engine.stop() in afterEach |

## Success Criteria

- All 8 tests pass consistently (no flakiness on 10 consecutive runs)
- Test execution < 30s total
- Uses real Redis Streams throughout (zero jest.mock for Redis)
- Verifies actual XACK/XPENDING counts (not just message presence)
- Follows existing integration test patterns in `tests/integration/`
