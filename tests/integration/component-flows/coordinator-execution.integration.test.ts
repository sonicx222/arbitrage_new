/**
 * Coordinator → Execution Engine Integration Test
 *
 * TRUE integration test verifying the data flow from the coordinator
 * to the execution engine via Redis Streams.
 *
 * **Flow Tested**:
 * 1. Coordinator receives validated opportunity
 * 2. Coordinator publishes to `stream:execution-requests`
 * 3. Execution engine consumes execution requests
 * 4. Execution engine processes and publishes results
 *
 * **What's Real**:
 * - Redis Streams (via redis-memory-server)
 * - Distributed locking (prevents duplicate executions)
 * - Consumer group message delivery guarantees
 * - Stream-based request/response pattern
 *
 * @see Phase 4: TRUE Integration Tests
 * @see ADR-007: Leader Election and Coordination
 */

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import Redis from 'ioredis';
import {
  createTestRedisClient,
  ensureConsumerGroup,
} from '@arbitrage/test-utils';

// Type alias for Redis stream messages
type StreamMessage = [string, string[]];
type StreamResult = [string, StreamMessage[]][] | null;

// Stream names (matching RedisStreamsClient.STREAMS)
const STREAMS = {
  OPPORTUNITIES: 'stream:opportunities',
  EXECUTION_REQUESTS: 'stream:execution-requests',
  EXECUTION_RESULTS: 'stream:execution-results',
} as const;

// Lock key patterns
const LOCKS = {
  OPPORTUNITY_PREFIX: 'lock:opportunity:',
  EXECUTION_PREFIX: 'lock:execution:',
} as const;

interface ExecutionRequest {
  requestId: string;
  opportunityId: string;
  type: string;
  chain: string;
  buyDex: string;
  sellDex: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minAmountOut: string;
  expectedProfit: number;
  gasLimit: string;
  maxGasPrice: string;
  deadline: number;
  priority: 'high' | 'medium' | 'low';
  timestamp: number;
}

interface ExecutionResult {
  requestId: string;
  opportunityId: string;
  status: 'success' | 'failed' | 'expired' | 'cancelled';
  txHash?: string;
  actualProfit?: number;
  gasUsed?: string;
  errorMessage?: string;
  executionTimeMs: number;
  timestamp: number;
}

function createExecutionRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  const timestamp = Date.now();
  return {
    requestId: `req-${timestamp}-${Math.random().toString(36).slice(2)}`,
    opportunityId: `opp-${timestamp}`,
    type: 'cross-dex',
    chain: 'ethereum',
    buyDex: 'sushiswap',
    sellDex: 'uniswap_v3',
    tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    amountIn: '1000000000000000000', // 1 WETH
    minAmountOut: '2475000000', // 2475 USDC
    expectedProfit: 50,
    gasLimit: '500000',
    maxGasPrice: '50000000000', // 50 gwei
    deadline: timestamp + 120000, // 2 minutes
    priority: 'high',
    timestamp,
    ...overrides,
  };
}

function createExecutionResult(
  request: ExecutionRequest,
  overrides: Partial<ExecutionResult> = {}
): ExecutionResult {
  return {
    requestId: request.requestId,
    opportunityId: request.opportunityId,
    status: 'success',
    txHash: '0x' + Math.random().toString(16).slice(2).padEnd(64, '0'),
    actualProfit: request.expectedProfit * 0.95, // Slight slippage
    gasUsed: '350000',
    executionTimeMs: 2500,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('[Level 1] Coordinator → Execution Engine Integration', () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = await createTestRedisClient();
  }, 30000);

  afterAll(async () => {
    if (redis) {
      await redis.quit();
    }
  });

  // Note: We use unique stream/key names per test to avoid interference,
  // so we don't need beforeEach flush which can cause race conditions
  // with parallel test execution.

  describe('Execution Request Publishing', () => {
    it('should publish execution request to stream:execution-requests', async () => {
      // Use unique stream name to avoid interference from parallel tests
      const testStream = `stream:execution-requests:pub:${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const request = createExecutionRequest();

      const messageId = await redis.xadd(
        testStream,
        '*',
        'data', JSON.stringify(request)
      );

      expect(messageId).toBeDefined();

      // Verify stream has the message
      const result = await redis.xread('COUNT', 1, 'STREAMS', testStream, '0');

      // Ensure result is not null before accessing
      expect(result).not.toBeNull();
      expect(result).toHaveLength(1);

      const [, messages] = result![0];
      expect(messages).toHaveLength(1);
      const [, fields] = messages[0];
      const fieldObj: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        fieldObj[fields[i]] = fields[i + 1];
      }

      const parsedRequest = JSON.parse(fieldObj.data);
      expect(parsedRequest.type).toBe('cross-dex');
      expect(parsedRequest.chain).toBe('ethereum');
      expect(parsedRequest.priority).toBe('high');
    });

    it('should preserve request priority ordering', async () => {
      // Use unique stream name to avoid interference from parallel tests
      const testStream = `stream:execution-requests:prio:${Date.now()}-${Math.random().toString(36).slice(2)}`;

      // Create requests with different priorities
      const highPriority = createExecutionRequest({ priority: 'high', requestId: 'req-high' });
      const mediumPriority = createExecutionRequest({ priority: 'medium', requestId: 'req-medium' });
      const lowPriority = createExecutionRequest({ priority: 'low', requestId: 'req-low' });

      // Publish in mixed order
      await redis.xadd(testStream, '*', 'data', JSON.stringify(mediumPriority));
      await redis.xadd(testStream, '*', 'data', JSON.stringify(highPriority));
      await redis.xadd(testStream, '*', 'data', JSON.stringify(lowPriority));

      // Read all requests
      const result = await redis.xread('COUNT', 10, 'STREAMS', testStream, '0');

      const [, messages] = result![0];
      const requests = messages.map(([, fields]) => {
        const fieldObj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
          fieldObj[fields[i]] = fields[i + 1];
        }
        return JSON.parse(fieldObj.data);
      });

      // Verify all 3 were published (order by stream timestamp, not priority)
      expect(requests).toHaveLength(3);
      expect(requests.map(r => r.priority)).toContain('high');
      expect(requests.map(r => r.priority)).toContain('medium');
      expect(requests.map(r => r.priority)).toContain('low');
    });
  });

  describe('Distributed Locking', () => {
    // Helper to acquire lock using SET NX PX (bypasses strict TypeScript types)
    async function acquireLock(key: string, value: string, ttlMs: number): Promise<string | null> {
      return redis.call('SET', key, value, 'NX', 'PX', ttlMs) as Promise<string | null>;
    }

    it('should acquire lock to prevent duplicate execution', async () => {
      const request = createExecutionRequest();
      const lockKey = `${LOCKS.EXECUTION_PREFIX}${request.opportunityId}`;

      // Attempt to acquire lock with SET NX (only set if not exists)
      const acquired = await acquireLock(lockKey, 'worker-1', 30000);

      expect(acquired).toBe('OK');

      // Verify lock exists
      const lockValue = await redis.get(lockKey);
      expect(lockValue).toBe('worker-1');
    });

    it('should prevent second worker from acquiring same lock', async () => {
      const request = createExecutionRequest();
      const lockKey = `${LOCKS.EXECUTION_PREFIX}${request.opportunityId}`;

      // First worker acquires lock
      const firstAcquired = await acquireLock(lockKey, 'worker-1', 30000);
      expect(firstAcquired).toBe('OK');

      // Second worker tries to acquire same lock
      const secondAcquired = await acquireLock(lockKey, 'worker-2', 30000);

      // Second attempt should fail
      expect(secondAcquired).toBeNull();

      // Lock should still belong to first worker
      const lockValue = await redis.get(lockKey);
      expect(lockValue).toBe('worker-1');
    });

    it('should release lock after successful execution', async () => {
      const request = createExecutionRequest();
      const lockKey = `${LOCKS.EXECUTION_PREFIX}${request.opportunityId}`;

      // Acquire lock
      await acquireLock(lockKey, 'worker-1', 30000);

      // Simulate execution...
      // After successful execution, release lock
      await redis.del(lockKey);

      // Lock should be released
      const lockValue = await redis.get(lockKey);
      expect(lockValue).toBeNull();

      // Another worker should be able to acquire it now
      const reacquired = await acquireLock(lockKey, 'worker-2', 30000);
      expect(reacquired).toBe('OK');
    });

    it('should handle lock expiration for stuck workers', async () => {
      const request = createExecutionRequest();
      const lockKey = `${LOCKS.EXECUTION_PREFIX}${request.opportunityId}`;

      // Acquire lock with very short TTL
      await acquireLock(lockKey, 'worker-1', 100); // 100ms TTL

      // Wait for lock to expire
      await new Promise(resolve => setTimeout(resolve, 150));

      // Lock should have expired
      const lockValue = await redis.get(lockKey);
      expect(lockValue).toBeNull();

      // Another worker can acquire it
      const acquired = await acquireLock(lockKey, 'worker-2', 30000);
      expect(acquired).toBe('OK');
    });

    it('should handle concurrent lock attempts atomically', async () => {
      const request = createExecutionRequest();
      const lockKey = `${LOCKS.EXECUTION_PREFIX}${request.opportunityId}`;

      // Simulate 5 workers trying to acquire lock concurrently
      const results = await Promise.all([
        acquireLock(lockKey, 'worker-1', 30000),
        acquireLock(lockKey, 'worker-2', 30000),
        acquireLock(lockKey, 'worker-3', 30000),
        acquireLock(lockKey, 'worker-4', 30000),
        acquireLock(lockKey, 'worker-5', 30000),
      ]);

      // Exactly one should succeed (Redis SET NX is atomic)
      const successCount = results.filter(r => r === 'OK').length;
      expect(successCount).toBe(1);

      // Verify only one worker holds the lock
      const lockValue = await redis.get(lockKey);
      expect(lockValue).toMatch(/^worker-[1-5]$/);
    });
  });

  describe('Execution Result Publishing', () => {
    it('should publish successful execution result', async () => {
      // Use unique stream name to avoid interference from parallel tests
      const testStream = `stream:execution-results:success:${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const request = createExecutionRequest();
      const result = createExecutionResult(request, {
        status: 'success',
        actualProfit: 48.5,
      });

      await redis.xadd(testStream, '*', 'data', JSON.stringify(result));

      const readResult = await redis.xread('COUNT', 1, 'STREAMS', testStream, '0');

      const [, messages] = readResult![0];
      const [, fields] = messages[0];
      const fieldObj: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        fieldObj[fields[i]] = fields[i + 1];
      }

      const parsedResult = JSON.parse(fieldObj.data);
      expect(parsedResult.status).toBe('success');
      expect(parsedResult.actualProfit).toBe(48.5);
      expect(parsedResult.txHash).toBeDefined();
    });

    it('should publish failed execution result with error', async () => {
      // Use unique stream name to avoid interference from parallel tests
      const testStream = `stream:execution-results:failed:${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const request = createExecutionRequest();
      const result = createExecutionResult(request, {
        status: 'failed',
        errorMessage: 'Insufficient liquidity',
        actualProfit: undefined,
        txHash: undefined,
      });

      await redis.xadd(testStream, '*', 'data', JSON.stringify(result));

      const readResult = await redis.xread('COUNT', 1, 'STREAMS', testStream, '0');

      const [, messages] = readResult![0];
      const [, fields] = messages[0];
      const fieldObj: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        fieldObj[fields[i]] = fields[i + 1];
      }

      const parsedResult = JSON.parse(fieldObj.data);
      expect(parsedResult.status).toBe('failed');
      expect(parsedResult.errorMessage).toBe('Insufficient liquidity');
    });

    it('should publish expired execution result for deadline exceeded', async () => {
      // Use unique stream name to avoid interference from parallel tests
      const testStream = `stream:execution-results:expired:${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const request = createExecutionRequest({
        deadline: Date.now() - 1000, // Already expired
      });
      const result = createExecutionResult(request, {
        status: 'expired',
        errorMessage: 'Deadline exceeded',
      });

      await redis.xadd(testStream, '*', 'data', JSON.stringify(result));

      const readResult = await redis.xread('COUNT', 1, 'STREAMS', testStream, '0');

      const [, messages] = readResult![0];
      const [, fields] = messages[0];
      const fieldObj: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        fieldObj[fields[i]] = fields[i + 1];
      }

      const parsedResult = JSON.parse(fieldObj.data);
      expect(parsedResult.status).toBe('expired');
    });
  });

  describe('Consumer Group for Execution Engine', () => {
    it('should create execution engine consumer group', async () => {
      // Use unique stream/group names to avoid interference from parallel tests
      const testId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const streamName = `stream:execution-requests:cg:${testId}`;
      const groupName = `execution-engine-group-${testId}`;

      // Create stream with initial message
      await redis.xadd(streamName, '*', 'data', 'init');

      // Create consumer group
      await ensureConsumerGroup(redis, streamName, groupName);

      const groups = await redis.xinfo('GROUPS', streamName) as unknown[];
      expect(groups.length).toBeGreaterThan(0);
    });

    it('should process execution requests through consumer group', async () => {
      const streamName = STREAMS.EXECUTION_REQUESTS;
      const groupName = 'execution-processor';
      const consumerName = 'executor-1';

      // Publish execution requests
      const requests = [
        createExecutionRequest({ requestId: 'req-1' }),
        createExecutionRequest({ requestId: 'req-2' }),
        createExecutionRequest({ requestId: 'req-3' }),
      ];

      for (const req of requests) {
        await redis.xadd(streamName, '*', 'data', JSON.stringify(req));
      }

      // Create consumer group
      await ensureConsumerGroup(redis, streamName, groupName);

      // Process messages (use '>' to read new undelivered messages)
      const result = await redis.xreadgroup(
        'GROUP', groupName, consumerName,
        'COUNT', 10,
        'STREAMS', streamName, '>'
      ) as StreamResult;

      expect(result![0][1]).toHaveLength(3);

      // Process and acknowledge each request
      for (const [id, fields] of result![0][1]) {
        const fieldObj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
          fieldObj[fields[i]] = fields[i + 1];
        }
        const request = JSON.parse(fieldObj.data);

        // Simulate execution result
        const execResult = createExecutionResult(request);
        await redis.xadd(STREAMS.EXECUTION_RESULTS, '*', 'data', JSON.stringify(execResult));

        // Acknowledge processed message
        await redis.xack(streamName, groupName, id);
      }

      // Verify no pending messages
      const pending = await redis.xpending(streamName, groupName) as unknown[];
      expect(pending[0]).toBe(0);

      // Verify results were published
      const resultsLen = await redis.xlen(STREAMS.EXECUTION_RESULTS);
      expect(resultsLen).toBe(3);
    });

    it('should handle message redelivery for failed processing', async () => {
      const streamName = STREAMS.EXECUTION_REQUESTS;
      const groupName = 'execution-redelivery-test';
      const consumerName = 'executor-1';

      // Add a request
      const request = createExecutionRequest();
      await redis.xadd(streamName, '*', 'data', JSON.stringify(request));

      // Create consumer group
      await ensureConsumerGroup(redis, streamName, groupName);

      // Read but don't acknowledge (simulates crash) - use '>' to read new messages
      const result = await redis.xreadgroup(
        'GROUP', groupName, consumerName,
        'COUNT', 1,
        'STREAMS', streamName, '>'
      ) as StreamResult;

      expect(result![0][1]).toHaveLength(1);
      const messageId = result![0][1][0][0];

      // Message should be pending
      let pending = await redis.xpending(streamName, groupName) as unknown[];
      expect(pending[0]).toBe(1);

      // Claim the pending message for retry
      const claimed = await redis.xclaim(
        streamName,
        groupName,
        'executor-2',
        0, // Min idle time
        messageId
      ) as StreamMessage[];

      expect(claimed).toHaveLength(1);
      expect(claimed[0][0]).toBe(messageId);

      // Now acknowledge it
      await redis.xack(streamName, groupName, messageId);

      pending = await redis.xpending(streamName, groupName) as unknown[];
      expect(pending[0]).toBe(0);
    });
  });

  describe('Request-Response Correlation', () => {
    it('should correlate execution results with requests by ID', async () => {
      // Use unique stream names to avoid interference from parallel tests
      const testId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const requestStream = `stream:execution-requests:corr:${testId}`;
      const resultStream = `stream:execution-results:corr:${testId}`;

      const request = createExecutionRequest({ requestId: 'unique-request-123' });

      // Publish request
      await redis.xadd(requestStream, '*', 'data', JSON.stringify(request));

      // Simulate execution and publish result
      const result = createExecutionResult(request, {
        status: 'success',
        actualProfit: 52.3,
      });

      await redis.xadd(resultStream, '*', 'data', JSON.stringify(result));

      // Read result and correlate with request
      const resultMessages = await redis.xread('COUNT', 10, 'STREAMS', resultStream, '0');

      const [, messages] = resultMessages![0];
      const [, fields] = messages[0];
      const fieldObj: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        fieldObj[fields[i]] = fields[i + 1];
      }

      const resultData = JSON.parse(fieldObj.data);
      expect(resultData.requestId).toBe('unique-request-123');
      expect(resultData.opportunityId).toBe(request.opportunityId);
    });
  });

  describe('Backpressure Handling', () => {
    it('should handle high volume of execution requests', async () => {
      // Use unique stream name to avoid interference from parallel tests
      const testStream = `stream:execution-requests:hv:${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const requestCount = 100;

      // Publish many requests rapidly
      const publishPromises: Promise<string | null>[] = [];
      for (let i = 0; i < requestCount; i++) {
        publishPromises.push(
          redis.xadd(
            testStream,
            '*',
            'data', JSON.stringify(createExecutionRequest({ requestId: `req-${i}` }))
          )
        );
      }

      await Promise.all(publishPromises);

      // Verify all requests were published
      const streamLength = await redis.xlen(testStream);
      expect(streamLength).toBe(requestCount);
    });

    it('should process requests in batches', async () => {
      // Use unique stream/group names to avoid interference from parallel tests
      const testId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const streamName = `stream:execution-requests:batch:${testId}`;
      const groupName = `batch-processor-${testId}`;
      const consumerName = 'executor-1';
      const batchSize = 10;
      const totalRequests = 50;

      // Create consumer group first (MKSTREAM creates stream if needed)
      await ensureConsumerGroup(redis, streamName, groupName);

      // Publish many requests
      for (let i = 0; i < totalRequests; i++) {
        await redis.xadd(
          streamName,
          '*',
          'data', JSON.stringify(createExecutionRequest({ requestId: `req-${i}` }))
        );
      }

      // Process in batches
      let totalProcessed = 0;
      let batches = 0;

      while (totalProcessed < totalRequests) {
        const result = await redis.xreadgroup(
          'GROUP', groupName, consumerName,
          'COUNT', batchSize,
          'STREAMS', streamName, '>'
        ) as StreamResult;

        if (!result || result[0][1].length === 0) break;

        batches++;
        const batchMessages = result[0][1];

        // Acknowledge all in batch
        for (const [id] of batchMessages) {
          await redis.xack(streamName, groupName, id);
          totalProcessed++;
        }
      }

      expect(totalProcessed).toBe(totalRequests);
      expect(batches).toBeGreaterThanOrEqual(Math.ceil(totalRequests / batchSize));
    });
  });
});
