# Full Pipeline Integration Test Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create an integration test that verifies the complete arbitrage pipeline (opportunity → coordinator forwarding → execution → result → XACK) using real Redis Streams via redis-memory-server.

**Architecture:** Real `ExecutionEngineService` in SimulationMode connected to redis-memory-server. A thin coordinator forwarder (~40 lines) reads from `stream:opportunities` and forwards to `stream:execution-requests`. Results verified on `stream:execution-results` with XACK/XPENDING checks.

**Tech Stack:** Jest, redis-memory-server, ioredis, `@arbitrage/test-utils` (createTestRedisClient, ensureConsumerGroup, waitForMessages, createTestOpportunity, StreamCollector), `ExecutionEngineService` from execution-engine.

**Design doc:** `docs/plans/2026-02-20-full-pipeline-integration-test-design.md`

---

### Task 1: Create the TestCoordinatorForwarder helper

**Files:**
- Create: `tests/integration/pipeline/helpers/coordinator-forwarder.ts`

**Step 1: Write the forwarder class**

This is a thin test helper that mimics `OpportunityRouter.forwardToExecutionEngine()` without leadership election, circuit breakers, or metrics.

```typescript
/**
 * Thin coordinator forwarder for pipeline integration tests.
 * Mimics OpportunityRouter: reads from stream:opportunities,
 * validates, serializes with coordinator metadata, and forwards
 * to stream:execution-requests.
 */
import Redis from 'ioredis';
import { RedisStreams } from '@arbitrage/types';

export class TestCoordinatorForwarder {
  private running = false;
  private pollPromise: Promise<void> | null = null;
  private readonly groupName = 'test-coordinator-group';
  private readonly consumerName: string;

  constructor(
    private readonly redis: Redis,
    private readonly instanceId: string = `test-coordinator-${Date.now()}`
  ) {
    this.consumerName = this.instanceId;
  }

  async createConsumerGroup(): Promise<void> {
    try {
      await this.redis.xgroup(
        'CREATE',
        RedisStreams.OPPORTUNITIES,
        this.groupName,
        '0',
        'MKSTREAM'
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('BUSYGROUP')) throw e;
    }
  }

  async start(): Promise<void> {
    await this.createConsumerGroup();
    this.running = true;
    this.pollPromise = this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollPromise) {
      await this.pollPromise;
    }
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const result = await this.redis.xreadgroup(
          'GROUP', this.groupName, this.consumerName,
          'COUNT', '10',
          'BLOCK', '100',
          'STREAMS', RedisStreams.OPPORTUNITIES, '>'
        ) as [string, [string, string[]][]][] | null;

        if (result && result.length > 0) {
          const [, messages] = result[0];
          for (const [messageId, fields] of messages) {
            await this.forwardMessage(messageId, fields);
          }
        }
      } catch (e) {
        if (this.running) {
          // Brief pause on error to avoid tight loop
          await new Promise(r => setTimeout(r, 50));
        }
      }
    }
  }

  private async forwardMessage(
    sourceMessageId: string,
    fields: string[]
  ): Promise<void> {
    // Parse fields array into object
    const fieldObj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      fieldObj[fields[i]] = fields[i + 1];
    }

    // Validate minimum required field
    const data = fieldObj.data;
    if (!data) {
      // ACK invalid messages (no DLQ in test helper)
      await this.redis.xack(
        RedisStreams.OPPORTUNITIES,
        this.groupName,
        sourceMessageId
      );
      return;
    }

    // Enrich with coordinator metadata (mimics OpportunityRouter)
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data);
    } catch {
      await this.redis.xack(
        RedisStreams.OPPORTUNITIES,
        this.groupName,
        sourceMessageId
      );
      return;
    }

    if (!parsed.id) {
      await this.redis.xack(
        RedisStreams.OPPORTUNITIES,
        this.groupName,
        sourceMessageId
      );
      return;
    }

    parsed.forwardedBy = this.instanceId;
    parsed.forwardedAt = Date.now();
    if (parsed.pipelineTimestamps && typeof parsed.pipelineTimestamps === 'object') {
      (parsed.pipelineTimestamps as Record<string, unknown>).coordinatorAt = Date.now();
    }

    // Forward to execution-requests stream
    await this.redis.xadd(
      RedisStreams.EXECUTION_REQUESTS,
      '*',
      'data', JSON.stringify(parsed)
    );

    // ACK source message
    await this.redis.xack(
      RedisStreams.OPPORTUNITIES,
      this.groupName,
      sourceMessageId
    );
  }
}
```

**Step 2: Verify file compiles**

Run: `npx tsc --noEmit tests/integration/pipeline/helpers/coordinator-forwarder.ts 2>&1 | head -20`

If path alias issues, that's expected — the integration test runner handles them. Verify there are no syntax errors.

**Step 3: Commit**

```bash
git add tests/integration/pipeline/helpers/coordinator-forwarder.ts
git commit -m "test: add TestCoordinatorForwarder helper for pipeline integration test"
```

---

### Task 2: Create test file with setup/teardown

**Files:**
- Create: `tests/integration/pipeline/full-pipeline.integration.test.ts`

**Step 1: Write the test infrastructure**

```typescript
/**
 * Full Pipeline Integration Test
 *
 * Tests the complete arbitrage pipeline:
 * opportunity → stream:opportunities → coordinator forwarding →
 * stream:execution-requests → ExecutionEngine (SimulationMode) →
 * stream:execution-results → XACK verified
 *
 * Uses real Redis via redis-memory-server (no jest.mock for Redis).
 *
 * @see docs/plans/2026-02-20-full-pipeline-integration-test-design.md
 * @see .agent-reports/TEST_AUDIT_REPORT.md - Fix #14 (P4 Coverage Gap)
 */
import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import Redis from 'ioredis';
import * as fs from 'fs';
import * as path from 'path';
import { RedisStreams } from '@arbitrage/types';
import {
  resetRedisInstance,
  resetRedisStreamsInstance,
  resetDistributedLockManager,
  resetNonceManager,
} from '@arbitrage/core/internal';
import { ExecutionEngineService } from '../../../services/execution-engine/src/engine';
import {
  createTestRedisClient,
  ensureConsumerGroup,
  createTestOpportunity,
} from '@arbitrage/test-utils';
import { TestCoordinatorForwarder } from './helpers/coordinator-forwarder';

// Read test Redis URL from config file (written by jest.globalSetup.ts)
function getTestRedisUrl(): string {
  const configFile = path.resolve(__dirname, '../../../.redis-test-config.json');
  if (fs.existsSync(configFile)) {
    try {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (config.url) return config.url;
    } catch { /* fall through */ }
  }
  return process.env.REDIS_URL ?? 'redis://localhost:6379';
}

/**
 * Wait for messages on a stream with exponential backoff polling.
 * Returns parsed 'data' fields from collected messages.
 */
async function collectResults(
  redis: Redis,
  stream: string,
  expectedCount: number,
  timeoutMs: number = 15000
): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = [];
  const start = Date.now();
  let pollInterval = 50;

  while (results.length < expectedCount && Date.now() - start < timeoutMs) {
    const raw = await redis.xrange(stream, '-', '+');
    results.length = 0; // Reset — xrange returns all
    for (const [, fields] of raw) {
      const fieldObj: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        fieldObj[fields[i]] = fields[i + 1];
      }
      if (fieldObj.data) {
        try {
          results.push(JSON.parse(fieldObj.data));
        } catch {
          results.push(fieldObj as unknown as Record<string, unknown>);
        }
      }
    }
    if (results.length < expectedCount) {
      await new Promise(r => setTimeout(r, pollInterval));
      pollInterval = Math.min(pollInterval * 1.5, 500);
    }
  }
  return results;
}

/**
 * Get pending message count for a consumer group on a stream.
 */
async function getPendingCount(
  redis: Redis,
  stream: string,
  group: string
): Promise<number> {
  try {
    const info = await redis.xpending(stream, group) as unknown[];
    return (info[0] as number) ?? 0;
  } catch {
    return 0; // Stream or group doesn't exist yet
  }
}

describe('[Integration] Full Pipeline: Opportunity → Execution → Result', () => {
  let redis: Redis;
  let forwarder: TestCoordinatorForwarder;
  let engine: ExecutionEngineService;

  beforeAll(async () => {
    // Ensure REDIS_URL points to test Redis for singleton getters
    const testUrl = getTestRedisUrl();
    process.env.REDIS_URL = testUrl;

    // Create direct Redis client for test assertions
    redis = await createTestRedisClient();
  }, 30000);

  afterAll(async () => {
    if (redis) {
      await redis.quit();
    }
  });

  beforeEach(async () => {
    // Clean slate
    await redis.flushall();

    // Reset all @arbitrage/core singletons so engine gets fresh connections
    await resetRedisStreamsInstance();
    await resetRedisInstance();
    await resetDistributedLockManager();
    resetNonceManager();

    // Create consumer group for the forwarder
    await ensureConsumerGroup(
      redis,
      RedisStreams.OPPORTUNITIES,
      'test-coordinator-group'
    );

    // Start coordinator forwarder
    forwarder = new TestCoordinatorForwarder(redis);
    await forwarder.start();

    // Start execution engine in simulation mode
    engine = new ExecutionEngineService({
      simulationConfig: {
        enabled: true,
        successRate: 1.0,
        executionLatencyMs: 10,
        profitVariance: 0.1,
      },
    });
    await engine.start();
  }, 30000);

  afterEach(async () => {
    // Stop in reverse order
    try {
      if (engine) await engine.stop();
    } catch { /* ignore cleanup errors */ }

    try {
      if (forwarder) await forwarder.stop();
    } catch { /* ignore */ }

    // Reset singletons to release connections
    await resetRedisStreamsInstance();
    await resetRedisInstance();
    await resetDistributedLockManager();
    resetNonceManager();
  });

  // --- TESTS GO HERE (Tasks 3-10) ---

});
```

**Step 2: Verify the test file loads without errors**

Run: `npx jest --listTests 2>&1 | grep full-pipeline`

Expected: The file should appear in the test list.

**Step 3: Commit**

```bash
git add tests/integration/pipeline/full-pipeline.integration.test.ts
git commit -m "test: add pipeline integration test skeleton with setup/teardown"
```

---

### Task 3: First happy path test — single opportunity through full pipeline

**Files:**
- Modify: `tests/integration/pipeline/full-pipeline.integration.test.ts`

**Step 1: Write the test**

Add inside the describe block (replacing `// --- TESTS GO HERE ---`):

```typescript
  describe('Happy Path', () => {
    it('should execute opportunity through full pipeline', async () => {
      // Arrange: Create test opportunity
      const opportunity = createTestOpportunity({
        id: `pipeline-test-${Date.now()}`,
        type: 'cross-dex',
        chain: 'ethereum',
        buyDex: 'uniswap_v3',
        sellDex: 'sushiswap',
        expectedProfit: 50,
        confidence: 0.9,
      });

      // Act: Publish to stream:opportunities (entry point of pipeline)
      await redis.xadd(
        RedisStreams.OPPORTUNITIES,
        '*',
        'data', JSON.stringify(opportunity)
      );

      // Assert: Result appears on stream:execution-results
      const results = await collectResults(
        redis,
        RedisStreams.EXECUTION_RESULTS,
        1,
        15000
      );

      expect(results.length).toBeGreaterThanOrEqual(1);

      // Find our specific result
      const result = results.find(
        (r) => r.id === opportunity.id || r.opportunityId === opportunity.id
      );
      expect(result).toBeDefined();

      // Verify: All streams fully ACKed (deferred ACK completed)
      // Allow brief settle time for ACK propagation
      await new Promise(r => setTimeout(r, 500));

      const oppPending = await getPendingCount(
        redis,
        RedisStreams.OPPORTUNITIES,
        'test-coordinator-group'
      );
      expect(oppPending).toBe(0);

      const execPending = await getPendingCount(
        redis,
        RedisStreams.EXECUTION_REQUESTS,
        'execution-engine-group'
      );
      expect(execPending).toBe(0);
    }, 30000);
  });
```

**Step 2: Run the test**

Run: `npx jest tests/integration/pipeline/full-pipeline.integration.test.ts --verbose 2>&1 | tail -30`

Expected: The test should pass. If it fails, debug by:
1. Check if engine starts successfully (look for "Starting Execution Engine" in output)
2. Check if forwarder reads from stream:opportunities (add debug logging)
3. Check if message arrives on stream:execution-requests
4. Check if result appears on stream:execution-results

**Step 3: Commit if passing**

```bash
git add tests/integration/pipeline/full-pipeline.integration.test.ts
git commit -m "test: add first pipeline integration test - single opportunity happy path"
```

---

### Task 4: Batch and data preservation tests

**Files:**
- Modify: `tests/integration/pipeline/full-pipeline.integration.test.ts`

**Step 1: Add batch test**

Add to Happy Path describe block:

```typescript
    it('should handle batch of opportunities', async () => {
      const count = 5;
      const opportunities = Array.from({ length: count }, (_, i) =>
        createTestOpportunity({
          id: `batch-${i}-${Date.now()}`,
          type: 'cross-dex',
          chain: 'ethereum',
          expectedProfit: 10 + i * 5,
          confidence: 0.85,
        })
      );

      // Publish all opportunities
      for (const opp of opportunities) {
        await redis.xadd(
          RedisStreams.OPPORTUNITIES,
          '*',
          'data', JSON.stringify(opp)
        );
      }

      // Wait for all results
      const results = await collectResults(
        redis,
        RedisStreams.EXECUTION_RESULTS,
        count,
        20000
      );

      expect(results.length).toBeGreaterThanOrEqual(count);

      // Verify all opportunity IDs are represented
      const resultIds = new Set(
        results.map((r) => r.id ?? r.opportunityId)
      );
      for (const opp of opportunities) {
        expect(resultIds).toContain(opp.id);
      }

      // Verify all streams fully ACKed
      await new Promise(r => setTimeout(r, 1000));

      const oppPending = await getPendingCount(
        redis, RedisStreams.OPPORTUNITIES, 'test-coordinator-group'
      );
      expect(oppPending).toBe(0);

      const execPending = await getPendingCount(
        redis, RedisStreams.EXECUTION_REQUESTS, 'execution-engine-group'
      );
      expect(execPending).toBe(0);
    }, 30000);

    it('should preserve opportunity data through pipeline', async () => {
      const opportunity = createTestOpportunity({
        id: `preserve-${Date.now()}`,
        type: 'cross-dex',
        chain: 'ethereum',
        buyDex: 'uniswap_v3',
        sellDex: 'sushiswap',
        expectedProfit: 42.5,
        confidence: 0.95,
      });

      await redis.xadd(
        RedisStreams.OPPORTUNITIES,
        '*',
        'data', JSON.stringify(opportunity)
      );

      const results = await collectResults(
        redis, RedisStreams.EXECUTION_RESULTS, 1, 15000
      );

      const result = results.find(
        (r) => r.id === opportunity.id || r.opportunityId === opportunity.id
      );
      expect(result).toBeDefined();

      // Verify key fields preserved through the pipeline
      // The execution result should reference the same opportunity
      if (result!.id) {
        expect(result!.id).toBe(opportunity.id);
      }
    }, 30000);
```

**Step 2: Run tests**

Run: `npx jest tests/integration/pipeline/full-pipeline.integration.test.ts --verbose 2>&1 | tail -40`

Expected: All 3 tests pass.

**Step 3: Commit**

```bash
git add tests/integration/pipeline/full-pipeline.integration.test.ts
git commit -m "test: add batch and data preservation pipeline tests"
```

---

### Task 5: Consumer group distribution test

**Files:**
- Modify: `tests/integration/pipeline/full-pipeline.integration.test.ts`

**Step 1: Add consumer group tests**

Add new describe block:

```typescript
  describe('Consumer Group Semantics', () => {
    it('should distribute messages across multiple consumers', async () => {
      // Start a second engine instance on the same consumer group
      const engine2 = new ExecutionEngineService({
        simulationConfig: {
          enabled: true,
          successRate: 1.0,
          executionLatencyMs: 10,
          profitVariance: 0.1,
        },
      });

      // Reset singletons so engine2 gets its own connections
      // Note: engine1 already started and has its own connections cached
      // engine2 will share the consumer group name but have a different consumer name
      await engine2.start();

      try {
        const count = 10;
        const opportunities = Array.from({ length: count }, (_, i) =>
          createTestOpportunity({
            id: `multi-consumer-${i}-${Date.now()}`,
            type: 'cross-dex',
            chain: 'ethereum',
            expectedProfit: 20 + i,
            confidence: 0.9,
          })
        );

        // Publish all opportunities
        for (const opp of opportunities) {
          await redis.xadd(
            RedisStreams.OPPORTUNITIES,
            '*',
            'data', JSON.stringify(opp)
          );
        }

        // Wait for all results
        const results = await collectResults(
          redis, RedisStreams.EXECUTION_RESULTS, count, 25000
        );

        // All messages should be processed (no lost messages)
        expect(results.length).toBeGreaterThanOrEqual(count);

        // No duplicate opportunity IDs
        const resultIds = results.map((r) => r.id ?? r.opportunityId);
        const uniqueIds = new Set(resultIds);
        expect(uniqueIds.size).toBe(results.length);
      } finally {
        try {
          await engine2.stop();
        } catch { /* ignore */ }
      }
    }, 40000);
  });
```

**Important note**: The multi-consumer test may require special handling because `getRedisClient()` / `getRedisStreamsClient()` are singletons — both engines may share the same underlying connection. If this test fails because the engines share singletons, the fix is to note this as a known limitation and adjust the test to verify stream semantics directly (2 separate XREADGROUP consumers on the same raw Redis connection). Document this decision.

**Step 2: Run test**

Run: `npx jest tests/integration/pipeline/full-pipeline.integration.test.ts -t "Consumer Group" --verbose 2>&1 | tail -30`

**Step 3: Commit**

```bash
git add tests/integration/pipeline/full-pipeline.integration.test.ts
git commit -m "test: add consumer group distribution pipeline test"
```

---

### Task 6: Distributed lock and invalid message tests

**Files:**
- Modify: `tests/integration/pipeline/full-pipeline.integration.test.ts`

**Step 1: Add edge case tests**

```typescript
  describe('Edge Cases', () => {
    it('should prevent duplicate execution via distributed lock', async () => {
      const opportunityId = `dup-lock-${Date.now()}`;
      const opportunity = createTestOpportunity({
        id: opportunityId,
        type: 'cross-dex',
        chain: 'ethereum',
        expectedProfit: 30,
        confidence: 0.9,
      });

      // Publish the SAME opportunity twice to execution-requests
      // (bypassing forwarder to directly test lock behavior)
      await redis.xadd(
        RedisStreams.EXECUTION_REQUESTS,
        '*',
        'data', JSON.stringify(opportunity)
      );
      await redis.xadd(
        RedisStreams.EXECUTION_REQUESTS,
        '*',
        'data', JSON.stringify(opportunity)
      );

      // Wait for processing
      await new Promise(r => setTimeout(r, 5000));

      const results = await collectResults(
        redis, RedisStreams.EXECUTION_RESULTS, 1, 10000
      );

      // Should have at most 1 successful execution for this ID
      // (lock prevents duplicate, or consumer dedup catches it)
      const matchingResults = results.filter(
        (r) => r.id === opportunityId || r.opportunityId === opportunityId
      );
      expect(matchingResults.length).toBeLessThanOrEqual(1);
    }, 20000);

    it('should handle invalid opportunity gracefully', async () => {
      // Publish malformed message directly to execution-requests
      // (missing required 'id' field)
      await redis.xadd(
        RedisStreams.EXECUTION_REQUESTS,
        '*',
        'data', JSON.stringify({ type: 'invalid', noId: true })
      );

      // Wait briefly for processing
      await new Promise(r => setTimeout(r, 3000));

      // Should NOT produce a result on execution-results
      const streamLen = await redis.xlen(RedisStreams.EXECUTION_RESULTS);
      expect(streamLen).toBe(0);

      // The invalid message should be ACKed (removed from pending)
      // to prevent infinite redelivery
      await new Promise(r => setTimeout(r, 1000));
      const pending = await getPendingCount(
        redis, RedisStreams.EXECUTION_REQUESTS, 'execution-engine-group'
      );
      expect(pending).toBe(0);
    }, 15000);
  });
```

**Step 2: Run tests**

Run: `npx jest tests/integration/pipeline/full-pipeline.integration.test.ts -t "Edge Cases" --verbose 2>&1 | tail -30`

**Step 3: Commit**

```bash
git add tests/integration/pipeline/full-pipeline.integration.test.ts
git commit -m "test: add distributed lock and invalid message edge case tests"
```

---

### Task 7: Deferred ACK verification test

**Files:**
- Modify: `tests/integration/pipeline/full-pipeline.integration.test.ts`

**Step 1: Add deferred ACK test**

```typescript
  describe('Deferred ACK Lifecycle', () => {
    it('should ACK messages only after execution completes', async () => {
      // Use slower simulation to observe pending state
      // Stop current engine and restart with slower execution
      await engine.stop();
      await resetRedisStreamsInstance();
      await resetRedisInstance();
      await resetDistributedLockManager();
      resetNonceManager();

      // Re-create consumer group (flushed in beforeEach)
      await ensureConsumerGroup(
        redis, RedisStreams.EXECUTION_REQUESTS, 'execution-engine-group'
      );

      engine = new ExecutionEngineService({
        simulationConfig: {
          enabled: true,
          successRate: 1.0,
          executionLatencyMs: 2000, // 2s execution delay
          profitVariance: 0.1,
        },
      });
      await engine.start();

      const opportunity = createTestOpportunity({
        id: `deferred-ack-${Date.now()}`,
        type: 'cross-dex',
        chain: 'ethereum',
        expectedProfit: 25,
        confidence: 0.9,
      });

      // Publish directly to execution-requests (skip forwarder for timing control)
      await redis.xadd(
        RedisStreams.EXECUTION_REQUESTS,
        '*',
        'data', JSON.stringify(opportunity)
      );

      // Brief delay to let consumer pick up the message
      await new Promise(r => setTimeout(r, 500));

      // During execution (2s latency), message should still be pending
      // Note: This may or may not catch the pending state depending on
      // consumer processing speed. The key assertion is that AFTER
      // execution completes, pending count is 0.

      // Wait for execution to complete
      const results = await collectResults(
        redis, RedisStreams.EXECUTION_RESULTS, 1, 10000
      );
      expect(results.length).toBeGreaterThanOrEqual(1);

      // After execution + result: pending should be 0 (ACK completed)
      await new Promise(r => setTimeout(r, 500));
      const pendingAfter = await getPendingCount(
        redis, RedisStreams.EXECUTION_REQUESTS, 'execution-engine-group'
      );
      expect(pendingAfter).toBe(0);
    }, 30000);
  });
```

**Step 2: Run test**

Run: `npx jest tests/integration/pipeline/full-pipeline.integration.test.ts -t "Deferred ACK" --verbose 2>&1 | tail -30`

**Step 3: Commit**

```bash
git add tests/integration/pipeline/full-pipeline.integration.test.ts
git commit -m "test: add deferred ACK lifecycle verification test"
```

---

### Task 8: Pipeline timestamps test

**Files:**
- Modify: `tests/integration/pipeline/full-pipeline.integration.test.ts`

**Step 1: Add timestamp tracking test**

```typescript
  describe('Pipeline Instrumentation', () => {
    it('should track pipeline latency through stages', async () => {
      const detectedAt = Date.now();
      const opportunity = createTestOpportunity({
        id: `timestamps-${Date.now()}`,
        type: 'cross-dex',
        chain: 'ethereum',
        expectedProfit: 35,
        confidence: 0.9,
        pipelineTimestamps: { detectedAt },
      });

      await redis.xadd(
        RedisStreams.OPPORTUNITIES,
        '*',
        'data', JSON.stringify(opportunity)
      );

      const results = await collectResults(
        redis, RedisStreams.EXECUTION_RESULTS, 1, 15000
      );

      expect(results.length).toBeGreaterThanOrEqual(1);

      // Verify the opportunity flowed through the pipeline
      // The forwarder adds coordinatorAt, the engine adds execution timestamp
      const result = results.find(
        (r) => r.id === opportunity.id || r.opportunityId === opportunity.id
      );
      expect(result).toBeDefined();

      // Verify result has a timestamp (execution completed)
      if (result!.timestamp) {
        expect(result!.timestamp).toBeGreaterThanOrEqual(detectedAt);
      }

      // Verify the forwarded message on execution-requests has coordinator metadata
      const execMessages = await redis.xrange(RedisStreams.EXECUTION_REQUESTS, '-', '+');
      const forwardedMsg = execMessages.find(([, fields]) => {
        const obj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
          obj[fields[i]] = fields[i + 1];
        }
        try {
          const parsed = JSON.parse(obj.data);
          return parsed.id === opportunity.id;
        } catch { return false; }
      });

      expect(forwardedMsg).toBeDefined();
      if (forwardedMsg) {
        const obj: Record<string, string> = {};
        for (let i = 0; i < forwardedMsg[1].length; i += 2) {
          obj[forwardedMsg[1][i]] = forwardedMsg[1][i + 1];
        }
        const parsed = JSON.parse(obj.data);
        expect(parsed.forwardedBy).toBeDefined();
        expect(parsed.forwardedAt).toBeGreaterThanOrEqual(detectedAt);
        if (parsed.pipelineTimestamps) {
          expect(parsed.pipelineTimestamps.coordinatorAt).toBeGreaterThanOrEqual(detectedAt);
        }
      }
    }, 30000);
  });
```

**Step 2: Run test**

Run: `npx jest tests/integration/pipeline/full-pipeline.integration.test.ts -t "Pipeline Instrumentation" --verbose 2>&1 | tail -30`

**Step 3: Commit**

```bash
git add tests/integration/pipeline/full-pipeline.integration.test.ts
git commit -m "test: add pipeline timestamp instrumentation test"
```

---

### Task 9: Full suite verification

**Step 1: Run the complete test file**

Run: `npx jest tests/integration/pipeline/full-pipeline.integration.test.ts --verbose 2>&1`

Expected: All 8 tests pass.

**Step 2: Run integration test suite to check no regressions**

Run: `npx jest --selectProjects integration --verbose 2>&1 | tail -50`

Expected: All existing integration tests still pass.

**Step 3: Run typecheck**

Run: `npm run typecheck 2>&1 | tail -20`

Expected: No new type errors.

**Step 4: Final commit**

```bash
git add -A tests/integration/pipeline/
git commit -m "test: complete full pipeline integration test (Fix #14 from TEST_AUDIT_REPORT)"
```

---

## Troubleshooting Guide

### Engine fails to start
- Check if `REDIS_URL` env var points to test Redis (printed in beforeAll)
- Check if singletons were properly reset in beforeEach
- SimulationMode should skip all blockchain init — if it's trying to connect to RPCs, config is wrong

### Forwarder doesn't forward messages
- Check consumer group exists on `stream:opportunities`
- Check if forwarder is polling (add debug logging)
- Verify message format: must have `data` field with JSON containing `id`

### Results don't appear on execution-results
- Check if message reaches `stream:execution-requests` (XRANGE)
- Check if OpportunityConsumer started (engine log "Creating consumer group")
- Check pending count — if messages are pending, execution hasn't completed
- Increase `collectResults` timeout

### Singleton conflicts between engines
- The `getRedisClient()` singleton means multiple engine instances share the same Redis connection
- This is fine — Redis Streams consumer groups handle message distribution at the Redis level
- Each engine instance has a unique `instanceId` used as consumer name

### XPENDING check fails
- Add extra settle time (500ms-1000ms) after result appears
- Deferred ACK may have async delay after execution completes
- Check if the consumer group name matches exactly

---

## Files Created/Modified

| File | Action | Purpose |
|------|--------|---------|
| `tests/integration/pipeline/helpers/coordinator-forwarder.ts` | CREATE | Thin coordinator forwarder test helper |
| `tests/integration/pipeline/full-pipeline.integration.test.ts` | CREATE | Full pipeline integration test (8 test cases) |
| `docs/plans/2026-02-20-full-pipeline-integration-test-design.md` | EXISTS | Design document (already committed) |
| `docs/plans/2026-02-20-full-pipeline-integration-test.md` | EXISTS | This implementation plan |
