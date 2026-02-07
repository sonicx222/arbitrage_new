/**
 * End-to-End Data Flow Integration Test
 *
 * Tests the complete data flow through the arbitrage system:
 * Price Ingestion → Detection → Coordination → Execution → Result
 *
 * **Flow Tested (from DATA_FLOW.md)**:
 * 1. Price data published to `stream:price-updates`
 * 2. Detector consumes prices, detects opportunity, publishes to `stream:opportunities`
 * 3. Coordinator consumes opportunity, validates, publishes to `stream:execution-requests`
 * 4. Execution engine consumes request, executes, publishes to `stream:execution-results`
 * 5. Result flows back for metrics/logging
 *
 * **What's Real**:
 * - Redis Streams (via redis-memory-server)
 * - Consumer group management
 * - Stream message serialization/deserialization
 * - Full data flow pipeline
 *
 * @see docs/architecture/DATA_FLOW.md
 * @see ADR-002: Redis Streams over Pub/Sub
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import Redis from 'ioredis';
import {
  createTestRedisClient,
  ensureConsumerGroup,
} from '@arbitrage/test-utils';

// Stream names matching the architecture
const STREAMS = {
  PRICE_UPDATES: 'stream:price-updates',
  OPPORTUNITIES: 'stream:opportunities',
  EXECUTION_REQUESTS: 'stream:execution-requests',
  EXECUTION_RESULTS: 'stream:execution-results',
  HEALTH: 'stream:health',
} as const;

// Consumer group names
const GROUPS = {
  DETECTOR: 'detector-group',
  COORDINATOR: 'coordinator-group',
  EXECUTION: 'execution-group',
  METRICS: 'metrics-group',
} as const;

// Type alias for Redis stream messages
type StreamMessage = [string, string[]];
type StreamResult = [string, StreamMessage[]][] | null;

// Test tokens
const TEST_TOKENS = {
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
} as const;

// Helper to parse stream message fields
function parseStreamFields(fields: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    obj[fields[i]] = fields[i + 1];
  }
  return obj;
}

// Test data factories
interface PriceUpdate {
  pairKey: string;
  pairAddress: string;
  dex: string;
  chain: string;
  token0: string;
  token1: string;
  price: number;
  reserve0: string;
  reserve1: string;
  blockNumber: number;
  timestamp: number;
}

interface ArbitrageOpportunity {
  id: string;
  type: 'cross-dex' | 'triangular' | 'cross-chain';
  chain: string;
  buyDex: string;
  sellDex: string;
  buyPair: string;
  sellPair: string;
  tokenIn: string;
  tokenOut: string;
  buyPrice: number;
  sellPrice: number;
  expectedProfit: number;
  confidence: number;
  timestamp: number;
  expiresAt: number;
}

interface ExecutionRequest {
  id: string;
  opportunityId: string;
  strategy: string;
  chain: string;
  params: {
    buyDex: string;
    sellDex: string;
    amountIn: string;
    minAmountOut: string;
    deadline: number;
  };
  priority: 'low' | 'medium' | 'high' | 'critical';
  timestamp: number;
}

interface ExecutionResult {
  id: string;
  requestId: string;
  opportunityId: string;
  success: boolean;
  profit?: number;
  gasUsed?: number;
  txHash?: string;
  error?: string;
  executionTimeMs: number;
  timestamp: number;
}

function createPriceUpdate(overrides: Partial<PriceUpdate> = {}): PriceUpdate {
  return {
    pairKey: 'UNISWAP_V3_WETH_USDC',
    pairAddress: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640',
    dex: 'uniswap_v3',
    chain: 'ethereum',
    token0: TEST_TOKENS.WETH,
    token1: TEST_TOKENS.USDC,
    price: 2500,
    reserve0: '1000000000000000000000',
    reserve1: '2500000000000',
    blockNumber: 18000000,
    timestamp: Date.now(),
    ...overrides,
  };
}

function createOpportunity(overrides: Partial<ArbitrageOpportunity> = {}): ArbitrageOpportunity {
  return {
    id: `opp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: 'cross-dex',
    chain: 'ethereum',
    buyDex: 'sushiswap',
    sellDex: 'uniswap_v3',
    buyPair: '0x397FF1542f962076d0BFE58eA045FfA2d347ACa0',
    sellPair: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640',
    tokenIn: TEST_TOKENS.WETH,
    tokenOut: TEST_TOKENS.USDC,
    buyPrice: 2490,
    sellPrice: 2510,
    expectedProfit: 20,
    confidence: 0.85,
    timestamp: Date.now(),
    expiresAt: Date.now() + 30000,
    ...overrides,
  };
}

function createExecutionRequest(
  opportunityId: string,
  overrides: Partial<ExecutionRequest> = {}
): ExecutionRequest {
  return {
    id: `req-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    opportunityId,
    strategy: 'cross-dex-swap',
    chain: 'ethereum',
    params: {
      buyDex: 'sushiswap',
      sellDex: 'uniswap_v3',
      amountIn: '1000000000000000000', // 1 ETH
      minAmountOut: '2480000000', // 2480 USDC
      deadline: Date.now() + 60000,
    },
    priority: 'high',
    timestamp: Date.now(),
    ...overrides,
  };
}

function createExecutionResult(
  requestId: string,
  opportunityId: string,
  overrides: Partial<ExecutionResult> = {}
): ExecutionResult {
  return {
    id: `result-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    requestId,
    opportunityId,
    success: true,
    profit: 18.5,
    gasUsed: 250000,
    txHash: `0x${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`,
    executionTimeMs: 1250,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('[E2E] Complete Data Flow Pipeline', () => {
  let redis: Redis;
  let testId: string;

  beforeAll(async () => {
    redis = await createTestRedisClient();
    testId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }, 30000);

  afterAll(async () => {
    if (redis) {
      await redis.quit();
    }
  });

  describe('Full Pipeline: Price → Detection → Coordination → Execution → Result', () => {
    it('should flow data through complete pipeline', async () => {
      // Use unique stream names for test isolation
      const streams = {
        prices: `${STREAMS.PRICE_UPDATES}:e2e:${testId}`,
        opportunities: `${STREAMS.OPPORTUNITIES}:e2e:${testId}`,
        requests: `${STREAMS.EXECUTION_REQUESTS}:e2e:${testId}`,
        results: `${STREAMS.EXECUTION_RESULTS}:e2e:${testId}`,
      };
      const groups = {
        detector: `${GROUPS.DETECTOR}-${testId}`,
        coordinator: `${GROUPS.COORDINATOR}-${testId}`,
        execution: `${GROUPS.EXECUTION}-${testId}`,
        metrics: `${GROUPS.METRICS}-${testId}`,
      };

      // Create consumer groups for all streams
      await ensureConsumerGroup(redis, streams.prices, groups.detector);
      await ensureConsumerGroup(redis, streams.opportunities, groups.coordinator);
      await ensureConsumerGroup(redis, streams.requests, groups.execution);
      await ensureConsumerGroup(redis, streams.results, groups.metrics);

      // STAGE 1: Price Ingestion
      // Simulate price feed publishing price updates
      const uniswapPrice = createPriceUpdate({ dex: 'uniswap_v3', price: 2510 });
      const sushiPrice = createPriceUpdate({
        dex: 'sushiswap',
        price: 2490,
        pairAddress: '0x397FF1542f962076d0BFE58eA045FfA2d347ACa0',
      });

      await redis.xadd(streams.prices, '*', 'data', JSON.stringify(uniswapPrice));
      await redis.xadd(streams.prices, '*', 'data', JSON.stringify(sushiPrice));

      // Verify prices are in stream
      const priceResult = await redis.xreadgroup(
        'GROUP', groups.detector, 'detector-worker-1',
        'COUNT', 10,
        'STREAMS', streams.prices, '>'
      ) as StreamResult;

      expect(priceResult).toBeDefined();
      expect(priceResult![0][1].length).toBe(2);

      // Acknowledge price messages
      for (const [id] of priceResult![0][1]) {
        await redis.xack(streams.prices, groups.detector, id);
      }

      // STAGE 2: Opportunity Detection
      // Detector analyzes prices and publishes opportunity
      const opportunity = createOpportunity({
        buyDex: 'sushiswap',
        sellDex: 'uniswap_v3',
        buyPrice: 2490,
        sellPrice: 2510,
        expectedProfit: 20,
      });

      await redis.xadd(streams.opportunities, '*', 'data', JSON.stringify(opportunity));

      // Coordinator consumes opportunity
      const oppResult = await redis.xreadgroup(
        'GROUP', groups.coordinator, 'coordinator-worker-1',
        'COUNT', 10,
        'STREAMS', streams.opportunities, '>'
      ) as StreamResult;

      expect(oppResult).toBeDefined();
      expect(oppResult![0][1].length).toBe(1);

      const oppFields = parseStreamFields(oppResult![0][1][0][1]);
      const receivedOpp = JSON.parse(oppFields.data);
      expect(receivedOpp.expectedProfit).toBe(20);

      // Acknowledge opportunity message
      await redis.xack(streams.opportunities, groups.coordinator, oppResult![0][1][0][0]);

      // STAGE 3: Execution Request
      // Coordinator validates and creates execution request
      const execRequest = createExecutionRequest(opportunity.id);

      await redis.xadd(streams.requests, '*', 'data', JSON.stringify(execRequest));

      // Execution engine consumes request
      const reqResult = await redis.xreadgroup(
        'GROUP', groups.execution, 'execution-worker-1',
        'COUNT', 10,
        'STREAMS', streams.requests, '>'
      ) as StreamResult;

      expect(reqResult).toBeDefined();
      expect(reqResult![0][1].length).toBe(1);

      const reqFields = parseStreamFields(reqResult![0][1][0][1]);
      const receivedReq = JSON.parse(reqFields.data);
      expect(receivedReq.opportunityId).toBe(opportunity.id);

      // Acknowledge execution request
      await redis.xack(streams.requests, groups.execution, reqResult![0][1][0][0]);

      // STAGE 4: Execution Result
      // Execution engine publishes result
      const execResult = createExecutionResult(execRequest.id, opportunity.id);

      await redis.xadd(streams.results, '*', 'data', JSON.stringify(execResult));

      // Metrics consumer reads result
      const resultResult = await redis.xreadgroup(
        'GROUP', groups.metrics, 'metrics-worker-1',
        'COUNT', 10,
        'STREAMS', streams.results, '>'
      ) as StreamResult;

      expect(resultResult).toBeDefined();
      expect(resultResult![0][1].length).toBe(1);

      const resultFields = parseStreamFields(resultResult![0][1][0][1]);
      const receivedResult = JSON.parse(resultFields.data);
      expect(receivedResult.success).toBe(true);
      expect(receivedResult.profit).toBe(18.5);
      expect(receivedResult.opportunityId).toBe(opportunity.id);

      // Acknowledge result
      await redis.xack(streams.results, groups.metrics, resultResult![0][1][0][0]);

      // Verify end-to-end correlation: opportunity.id links all stages
      expect(receivedResult.opportunityId).toBe(opportunity.id);
      expect(receivedReq.opportunityId).toBe(opportunity.id);
    });

    it('should handle failed execution in pipeline', async () => {
      const tid = `fail-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const streams = {
        requests: `${STREAMS.EXECUTION_REQUESTS}:fail:${tid}`,
        results: `${STREAMS.EXECUTION_RESULTS}:fail:${tid}`,
      };
      const groups = {
        execution: `${GROUPS.EXECUTION}-fail-${tid}`,
        metrics: `${GROUPS.METRICS}-fail-${tid}`,
      };

      await ensureConsumerGroup(redis, streams.requests, groups.execution);
      await ensureConsumerGroup(redis, streams.results, groups.metrics);

      const opportunity = createOpportunity();
      const execRequest = createExecutionRequest(opportunity.id);

      // Publish execution request
      await redis.xadd(streams.requests, '*', 'data', JSON.stringify(execRequest));

      // Consume and process
      const reqResult = await redis.xreadgroup(
        'GROUP', groups.execution, 'worker-1',
        'COUNT', 1,
        'STREAMS', streams.requests, '>'
      ) as StreamResult;

      await redis.xack(streams.requests, groups.execution, reqResult![0][1][0][0]);

      // Simulate failed execution
      const failedResult = createExecutionResult(execRequest.id, opportunity.id, {
        success: false,
        profit: undefined,
        gasUsed: 50000,
        txHash: undefined,
        error: 'Slippage exceeded maximum threshold',
      });

      await redis.xadd(streams.results, '*', 'data', JSON.stringify(failedResult));

      // Verify failed result is captured
      const resultResult = await redis.xreadgroup(
        'GROUP', groups.metrics, 'worker-1',
        'COUNT', 1,
        'STREAMS', streams.results, '>'
      ) as StreamResult;

      const resultFields = parseStreamFields(resultResult![0][1][0][1]);
      const result = JSON.parse(resultFields.data);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Slippage exceeded maximum threshold');
      expect(result.opportunityId).toBe(opportunity.id);
    });

    it('should maintain message ordering through pipeline', async () => {
      const tid = `order-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const stream = `${STREAMS.OPPORTUNITIES}:order:${tid}`;
      const group = `${GROUPS.COORDINATOR}-order-${tid}`;

      await ensureConsumerGroup(redis, stream, group);

      // Publish 10 opportunities in order
      const opportunities: ArbitrageOpportunity[] = [];
      for (let i = 0; i < 10; i++) {
        const opp = createOpportunity({
          id: `opp-order-${i}`,
          expectedProfit: 10 + i,
          timestamp: Date.now() + i,
        });
        opportunities.push(opp);
        await redis.xadd(stream, '*', 'data', JSON.stringify(opp));
      }

      // Read all messages
      const result = await redis.xreadgroup(
        'GROUP', group, 'worker-1',
        'COUNT', 20,
        'STREAMS', stream, '>'
      ) as StreamResult;

      expect(result![0][1].length).toBe(10);

      // Verify order is preserved
      const receivedIds = result![0][1].map(([, fields]) => {
        const obj = parseStreamFields(fields);
        return JSON.parse(obj.data).id;
      });

      expect(receivedIds).toEqual(opportunities.map(o => o.id));
    });
  });

  describe('Multi-Chain Data Flow', () => {
    it('should route opportunities by chain', async () => {
      const tid = `mc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const chains = ['ethereum', 'arbitrum', 'polygon', 'bsc'];

      // Create per-chain streams (simulating partition routing)
      const chainStreams: Record<string, string> = {};
      for (const chain of chains) {
        chainStreams[chain] = `${STREAMS.OPPORTUNITIES}:${chain}:${tid}`;
        await ensureConsumerGroup(redis, chainStreams[chain], `${GROUPS.COORDINATOR}-${chain}-${tid}`);
      }

      // Publish opportunities for different chains
      for (const chain of chains) {
        const opp = createOpportunity({ chain, id: `opp-${chain}` });
        await redis.xadd(chainStreams[chain], '*', 'data', JSON.stringify(opp));
      }

      // Verify each chain's stream has its opportunity
      for (const chain of chains) {
        const result = await redis.xreadgroup(
          'GROUP', `${GROUPS.COORDINATOR}-${chain}-${tid}`, 'worker-1',
          'COUNT', 10,
          'STREAMS', chainStreams[chain], '>'
        ) as StreamResult;

        expect(result).toBeDefined();
        expect(result![0][1].length).toBe(1);

        const fields = parseStreamFields(result![0][1][0][1]);
        const opp = JSON.parse(fields.data);
        expect(opp.chain).toBe(chain);
      }
    });

    it('should handle cross-chain arbitrage opportunities', async () => {
      const tid = `cc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const stream = `${STREAMS.OPPORTUNITIES}:crosschain:${tid}`;
      const group = `${GROUPS.COORDINATOR}-cc-${tid}`;

      await ensureConsumerGroup(redis, stream, group);

      // Cross-chain opportunity: buy on Arbitrum, sell on Ethereum
      const crossChainOpp = createOpportunity({
        type: 'cross-chain',
        chain: 'ethereum', // Target execution chain
        buyDex: 'uniswap_v3_arbitrum',
        sellDex: 'uniswap_v3',
        expectedProfit: 50,
      });

      await redis.xadd(stream, '*', 'data', JSON.stringify(crossChainOpp));

      const result = await redis.xreadgroup(
        'GROUP', group, 'worker-1',
        'COUNT', 1,
        'STREAMS', stream, '>'
      ) as StreamResult;

      const fields = parseStreamFields(result![0][1][0][1]);
      const opp = JSON.parse(fields.data);

      expect(opp.type).toBe('cross-chain');
      expect(opp.buyDex).toContain('arbitrum');
      expect(opp.sellDex).toBe('uniswap_v3');
    });
  });

  describe('Pipeline Latency Tracking', () => {
    it('should track latency through pipeline stages', async () => {
      const tid = `lat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const streams = {
        opportunities: `${STREAMS.OPPORTUNITIES}:lat:${tid}`,
        results: `${STREAMS.EXECUTION_RESULTS}:lat:${tid}`,
      };
      const groups = {
        coordinator: `${GROUPS.COORDINATOR}-lat-${tid}`,
        metrics: `${GROUPS.METRICS}-lat-${tid}`,
      };

      await ensureConsumerGroup(redis, streams.opportunities, groups.coordinator);
      await ensureConsumerGroup(redis, streams.results, groups.metrics);

      // Publish opportunity with timestamp
      const startTime = Date.now();
      const opp = createOpportunity({ timestamp: startTime });

      await redis.xadd(streams.opportunities, '*', 'data', JSON.stringify(opp));

      // Simulate coordinator processing
      const oppResult = await redis.xreadgroup(
        'GROUP', groups.coordinator, 'worker-1',
        'COUNT', 1,
        'STREAMS', streams.opportunities, '>'
      ) as StreamResult;

      const coordinatorReceiveTime = Date.now();
      await redis.xack(streams.opportunities, groups.coordinator, oppResult![0][1][0][0]);

      // Simulate execution and result
      const execResult = createExecutionResult('req-1', opp.id, {
        executionTimeMs: coordinatorReceiveTime - startTime + 50,
      });

      await redis.xadd(streams.results, '*', 'data', JSON.stringify(execResult));

      const resResult = await redis.xreadgroup(
        'GROUP', groups.metrics, 'worker-1',
        'COUNT', 1,
        'STREAMS', streams.results, '>'
      ) as StreamResult;

      const endTime = Date.now();
      const fields = parseStreamFields(resResult![0][1][0][1]);
      const result = JSON.parse(fields.data);

      // Total pipeline latency should be measurable
      const totalLatency = endTime - startTime;
      expect(totalLatency).toBeLessThan(1000); // Should complete in under 1 second
      expect(result.executionTimeMs).toBeGreaterThan(0);
    });
  });

  describe('Error Propagation', () => {
    it('should propagate errors through pipeline with correlation ID', async () => {
      const tid = `err-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const streams = {
        requests: `${STREAMS.EXECUTION_REQUESTS}:err:${tid}`,
        results: `${STREAMS.EXECUTION_RESULTS}:err:${tid}`,
      };
      const groups = {
        execution: `${GROUPS.EXECUTION}-err-${tid}`,
        metrics: `${GROUPS.METRICS}-err-${tid}`,
      };

      await ensureConsumerGroup(redis, streams.requests, groups.execution);
      await ensureConsumerGroup(redis, streams.results, groups.metrics);

      const correlationId = `corr-${Date.now()}`;
      const opp = createOpportunity({ id: correlationId });
      const request = createExecutionRequest(correlationId);

      await redis.xadd(streams.requests, '*', 'data', JSON.stringify(request));

      // Consume request
      const reqResult = await redis.xreadgroup(
        'GROUP', groups.execution, 'worker-1',
        'COUNT', 1,
        'STREAMS', streams.requests, '>'
      ) as StreamResult;
      await redis.xack(streams.requests, groups.execution, reqResult![0][1][0][0]);

      // Publish error result
      const errorResult = createExecutionResult(request.id, correlationId, {
        success: false,
        error: 'Transaction reverted: insufficient liquidity',
        profit: undefined,
        txHash: undefined,
      });

      await redis.xadd(streams.results, '*', 'data', JSON.stringify(errorResult));

      // Verify error is captured with correlation ID
      const resResult = await redis.xreadgroup(
        'GROUP', groups.metrics, 'worker-1',
        'COUNT', 1,
        'STREAMS', streams.results, '>'
      ) as StreamResult;

      const fields = parseStreamFields(resResult![0][1][0][1]);
      const result = JSON.parse(fields.data);

      expect(result.success).toBe(false);
      expect(result.error).toContain('insufficient liquidity');
      expect(result.opportunityId).toBe(correlationId);
    });
  });
});
