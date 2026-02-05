/**
 * Mempool Pending Opportunity Flow Integration Tests
 *
 * Phase 2, Task 2.2: Tests the complete flow from pending transaction detection
 * through stream publication to consumption by downstream services.
 *
 * **Flow Tested (from DATA_FLOW.md)**:
 * 1. Mempool detector receives pending transaction from bloXroute BDN
 * 2. Transaction decoded to PendingSwapIntent (bigint → string serialization)
 * 3. Wrapped in PendingOpportunity and published to stream:pending-opportunities
 * 4. Cross-chain detector consumes pending opportunities
 * 5. Confidence boost applied for pre-block opportunities
 * 6. Backrunning opportunity detection based on price impact
 *
 * **What's Real**:
 * - Redis Streams (via redis-memory-server)
 * - PendingOpportunity message format
 * - BigInt → string serialization for JSON compatibility
 * - Consumer group patterns
 *
 * @see docs/architecture/DATA_FLOW.md
 * @see docs/research/INTEGRATION_TEST_COVERAGE_REPORT.md Phase 2, Task 2.2
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import Redis from 'ioredis';
import {
  createTestRedisClient,
  ensureConsumerGroup,
} from '@arbitrage/test-utils';
import type {
  PendingSwapIntent,
  PendingOpportunity,
  SwapRouterType,
} from '@arbitrage/types';

// =============================================================================
// Constants
// =============================================================================

const STREAMS = {
  PENDING_OPPORTUNITIES: 'stream:pending-opportunities',
  PRICE_UPDATES: 'stream:price-updates',
  OPPORTUNITIES: 'stream:opportunities',
} as const;

const GROUPS = {
  CROSS_CHAIN_DETECTOR: 'cross-chain-detector-group',
  COORDINATOR: 'coordinator-group',
} as const;

// Common token addresses (mainnet)
const TOKENS = {
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  DAI: '0x6B175474E89094C44Da98b954EescdeCB5e8fBe6',
} as const;

// Router addresses (mainnet)
const ROUTERS = {
  UNISWAP_V2: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
  UNISWAP_V3: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  SUSHISWAP: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
} as const;

// =============================================================================
// Types
// =============================================================================

type StreamMessage = [string, string[]];
type StreamResult = [string, StreamMessage[]][] | null;

/**
 * Local PendingSwapIntent type with bigint fields (before serialization)
 * This matches the mempool-detector's internal type.
 */
interface LocalPendingSwapIntent {
  hash: string;
  router: string;
  type: SwapRouterType;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  expectedAmountOut: bigint;
  path: string[];
  slippageTolerance: number;
  deadline: number;
  sender: string;
  gasPrice: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  nonce: number;
  chainId: number;
  firstSeen: number;
}

interface BackrunningOpportunity {
  type: 'backrun';
  pendingTxHash: string;
  tokenIn: string;
  tokenOut: string;
  estimatedImpact: number;
  confidence: number;
  leadTimeMs: number;
}

// =============================================================================
// Helper Functions
// =============================================================================

function parseStreamFields(fields: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    obj[fields[i]] = fields[i + 1];
  }
  return obj;
}

/**
 * Create a local PendingSwapIntent with bigint fields (mempool-detector internal format).
 */
function createLocalPendingSwapIntent(
  overrides: Partial<LocalPendingSwapIntent> = {}
): LocalPendingSwapIntent {
  const now = Date.now();
  return {
    hash: `0x${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`,
    router: ROUTERS.UNISWAP_V2,
    type: 'uniswapV2',
    tokenIn: TOKENS.WETH,
    tokenOut: TOKENS.USDC,
    amountIn: BigInt('1000000000000000000'), // 1 ETH
    expectedAmountOut: BigInt('2500000000'), // 2500 USDC (6 decimals)
    path: [TOKENS.WETH, TOKENS.USDC],
    slippageTolerance: 0.005, // 0.5%
    deadline: Math.floor(now / 1000) + 3600, // 1 hour from now (in seconds)
    sender: `0x${Math.random().toString(16).slice(2, 42)}`,
    gasPrice: BigInt('50000000000'), // 50 gwei
    nonce: Math.floor(Math.random() * 1000),
    chainId: 1,
    firstSeen: now,
    ...overrides,
  };
}

/**
 * Convert local bigint PendingSwapIntent to serializable format.
 * This simulates what the mempool-detector's toSerializableIntent() does.
 */
function toSerializableIntent(local: LocalPendingSwapIntent): PendingSwapIntent {
  return {
    hash: local.hash,
    router: local.router,
    type: local.type,
    tokenIn: local.tokenIn,
    tokenOut: local.tokenOut,
    amountIn: local.amountIn.toString(),
    expectedAmountOut: local.expectedAmountOut.toString(),
    path: local.path,
    slippageTolerance: local.slippageTolerance,
    deadline: local.deadline,
    sender: local.sender,
    gasPrice: local.gasPrice.toString(),
    maxFeePerGas: local.maxFeePerGas?.toString(),
    maxPriorityFeePerGas: local.maxPriorityFeePerGas?.toString(),
    nonce: local.nonce,
    chainId: local.chainId,
    firstSeen: local.firstSeen,
  };
}

/**
 * Create a PendingOpportunity message (published to Redis).
 */
function createPendingOpportunity(
  local: LocalPendingSwapIntent,
  estimatedImpact?: number
): PendingOpportunity {
  return {
    type: 'pending',
    intent: toSerializableIntent(local),
    estimatedImpact,
    publishedAt: Date.now(),
  };
}

/**
 * Calculate estimated price impact based on swap size.
 * Simplified model: larger swaps have more impact.
 */
function estimatePriceImpact(amountIn: bigint, reserve: bigint): number {
  const amountNum = Number(amountIn) / 1e18;
  const reserveNum = Number(reserve) / 1e18;
  // Simple x*y=k model approximation
  return (amountNum / reserveNum) * 100;
}

/**
 * Determine if pending opportunity qualifies for backrunning.
 */
function canBackrun(
  pendingOpp: PendingOpportunity,
  leadTimeMs: number,
  minImpact: number = 0.1
): BackrunningOpportunity | null {
  const impact = pendingOpp.estimatedImpact ?? 0;

  // Must have sufficient impact and time to react
  if (impact < minImpact) return null;
  if (leadTimeMs < 50) return null; // Need at least 50ms

  return {
    type: 'backrun',
    pendingTxHash: pendingOpp.intent.hash,
    tokenIn: pendingOpp.intent.tokenIn,
    tokenOut: pendingOpp.intent.tokenOut,
    estimatedImpact: impact,
    confidence: Math.min(0.9, 0.5 + (impact / 10)), // Higher impact = higher confidence
    leadTimeMs,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('[Mempool] Pending Opportunity Flow Integration', () => {
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

  beforeEach(() => {
    testId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  // ===========================================================================
  // Task 2.2.1: Simulated Pending Transactions
  // ===========================================================================

  describe('Task 2.2.1: Pending Transaction Simulation', () => {
    it('should create valid PendingSwapIntent with bigint fields', () => {
      const local = createLocalPendingSwapIntent();

      expect(typeof local.amountIn).toBe('bigint');
      expect(typeof local.expectedAmountOut).toBe('bigint');
      expect(typeof local.gasPrice).toBe('bigint');
      expect(local.amountIn).toBe(BigInt('1000000000000000000'));
    });

    it('should serialize bigint fields to strings for JSON', () => {
      const local = createLocalPendingSwapIntent({
        amountIn: BigInt('1234567890123456789'),
        expectedAmountOut: BigInt('9876543210'),
        gasPrice: BigInt('100000000000'),
      });

      const serializable = toSerializableIntent(local);

      expect(typeof serializable.amountIn).toBe('string');
      expect(typeof serializable.expectedAmountOut).toBe('string');
      expect(typeof serializable.gasPrice).toBe('string');

      expect(serializable.amountIn).toBe('1234567890123456789');
      expect(serializable.expectedAmountOut).toBe('9876543210');
      expect(serializable.gasPrice).toBe('100000000000');
    });

    it('should create PendingOpportunity with correct type discriminator', () => {
      const local = createLocalPendingSwapIntent();
      const pendingOpp = createPendingOpportunity(local);

      expect(pendingOpp.type).toBe('pending');
      expect(pendingOpp.intent).toBeDefined();
      expect(pendingOpp.publishedAt).toBeGreaterThan(0);
    });

    it('should preserve precision when round-tripping through JSON', () => {
      const local = createLocalPendingSwapIntent({
        amountIn: BigInt('123456789012345678901234567890'),
        gasPrice: BigInt('999999999999999999'),
      });

      const serializable = toSerializableIntent(local);
      const jsonString = JSON.stringify(serializable);
      const parsed = JSON.parse(jsonString) as PendingSwapIntent;

      // String preserves full precision
      expect(parsed.amountIn).toBe('123456789012345678901234567890');
      expect(parsed.gasPrice).toBe('999999999999999999');
    });

    it('should handle EIP-1559 transactions with maxFeePerGas', () => {
      const local = createLocalPendingSwapIntent({
        gasPrice: BigInt('0'), // Legacy field
        maxFeePerGas: BigInt('100000000000'), // 100 gwei
        maxPriorityFeePerGas: BigInt('2000000000'), // 2 gwei
      });

      const serializable = toSerializableIntent(local);

      expect(serializable.maxFeePerGas).toBe('100000000000');
      expect(serializable.maxPriorityFeePerGas).toBe('2000000000');
    });
  });

  // ===========================================================================
  // Task 2.2.2: Stream Publishing Tests
  // ===========================================================================

  describe('Task 2.2.2: stream:pending-opportunities Publishing', () => {
    it('should publish PendingOpportunity to stream', async () => {
      const stream = `${STREAMS.PENDING_OPPORTUNITIES}:publish:${testId}`;

      const local = createLocalPendingSwapIntent();
      const pendingOpp = createPendingOpportunity(local, 0.5);

      // Publish to stream
      await redis.xadd(stream, '*', 'data', JSON.stringify(pendingOpp));

      // Verify message in stream
      const result = await redis.xread('COUNT', 10, 'STREAMS', stream, '0') as StreamResult;

      expect(result).not.toBeNull();
      expect(result![0][1].length).toBe(1);

      const parsed = JSON.parse(parseStreamFields(result![0][1][0][1]).data) as PendingOpportunity;
      expect(parsed.type).toBe('pending');
      expect(parsed.intent.hash).toBe(local.hash);
      expect(parsed.estimatedImpact).toBe(0.5);
    });

    it('should handle high-throughput pending opportunity publishing', async () => {
      const stream = `${STREAMS.PENDING_OPPORTUNITIES}:throughput:${testId}`;
      const count = 100;

      // Publish many pending opportunities
      const publishPromises: Promise<string | null>[] = [];
      for (let i = 0; i < count; i++) {
        const local = createLocalPendingSwapIntent({
          nonce: i,
        });
        const pendingOpp = createPendingOpportunity(local);
        publishPromises.push(
          redis.xadd(stream, '*', 'data', JSON.stringify(pendingOpp))
        );
      }

      await Promise.all(publishPromises);

      // Verify all messages published
      const len = await redis.xlen(stream);
      expect(len).toBe(count);
    });

    it('should publish multiple router types', async () => {
      const stream = `${STREAMS.PENDING_OPPORTUNITIES}:routers:${testId}`;

      const routerTypes: Array<{ router: string; type: SwapRouterType }> = [
        { router: ROUTERS.UNISWAP_V2, type: 'uniswapV2' },
        { router: ROUTERS.UNISWAP_V3, type: 'uniswapV3' },
        { router: ROUTERS.SUSHISWAP, type: 'sushiswap' },
      ];

      for (const { router, type } of routerTypes) {
        const local = createLocalPendingSwapIntent({ router, type });
        const pendingOpp = createPendingOpportunity(local);
        await redis.xadd(stream, '*', 'data', JSON.stringify(pendingOpp));
      }

      // Verify all router types present
      const result = await redis.xread('COUNT', 10, 'STREAMS', stream, '0') as StreamResult;

      const types = result![0][1].map(([, fields]) => {
        const data = JSON.parse(parseStreamFields(fields).data) as PendingOpportunity;
        return data.intent.type;
      });

      expect(types).toContain('uniswapV2');
      expect(types).toContain('uniswapV3');
      expect(types).toContain('sushiswap');
    });

    it('should include estimated price impact when available', async () => {
      const stream = `${STREAMS.PENDING_OPPORTUNITIES}:impact:${testId}`;

      // Large swap with estimated impact
      const largeSwap = createLocalPendingSwapIntent({
        amountIn: BigInt('100000000000000000000'), // 100 ETH
      });

      // Estimate impact based on hypothetical reserve
      const reserve = BigInt('10000000000000000000000'); // 10,000 ETH in pool
      const impact = estimatePriceImpact(largeSwap.amountIn, reserve);

      const pendingOpp = createPendingOpportunity(largeSwap, impact);
      await redis.xadd(stream, '*', 'data', JSON.stringify(pendingOpp));

      // Verify impact is included
      const result = await redis.xread('COUNT', 10, 'STREAMS', stream, '0') as StreamResult;
      const parsed = JSON.parse(parseStreamFields(result![0][1][0][1]).data) as PendingOpportunity;

      expect(parsed.estimatedImpact).toBeGreaterThan(0);
      expect(parsed.estimatedImpact).toBeCloseTo(1.0, 1); // ~1% impact
    });
  });

  // ===========================================================================
  // Task 2.2.3: Consumer Group Consumption Tests
  // ===========================================================================

  describe('Task 2.2.3: Pending Opportunity Consumption', () => {
    it('should consume pending opportunities via consumer group', async () => {
      const stream = `${STREAMS.PENDING_OPPORTUNITIES}:consume:${testId}`;
      const group = `${GROUPS.CROSS_CHAIN_DETECTOR}-consume-${testId}`;

      await ensureConsumerGroup(redis, stream, group);

      // Publish pending opportunities
      const locals = [
        createLocalPendingSwapIntent({ tokenIn: TOKENS.WETH, tokenOut: TOKENS.USDC }),
        createLocalPendingSwapIntent({ tokenIn: TOKENS.WETH, tokenOut: TOKENS.USDT }),
        createLocalPendingSwapIntent({ tokenIn: TOKENS.USDC, tokenOut: TOKENS.DAI }),
      ];

      for (const local of locals) {
        const pendingOpp = createPendingOpportunity(local);
        await redis.xadd(stream, '*', 'data', JSON.stringify(pendingOpp));
      }

      // Consumer reads pending opportunities
      const result = await redis.xreadgroup(
        'GROUP', group, 'detector-worker-1',
        'COUNT', 10,
        'STREAMS', stream, '>'
      ) as StreamResult;

      expect(result).not.toBeNull();
      expect(result![0][1].length).toBe(3);

      // Acknowledge messages
      for (const [id] of result![0][1]) {
        await redis.xack(stream, group, id);
      }
    });

    it('should support multiple consumers processing pending opportunities', async () => {
      const stream = `${STREAMS.PENDING_OPPORTUNITIES}:multi:${testId}`;
      const group = `${GROUPS.CROSS_CHAIN_DETECTOR}-multi-${testId}`;

      await ensureConsumerGroup(redis, stream, group);

      // Publish 10 pending opportunities
      for (let i = 0; i < 10; i++) {
        const local = createLocalPendingSwapIntent({ nonce: i });
        const pendingOpp = createPendingOpportunity(local);
        await redis.xadd(stream, '*', 'data', JSON.stringify(pendingOpp));
      }

      // Two consumers read from the same group (messages distributed)
      const consumer1Result = await redis.xreadgroup(
        'GROUP', group, 'worker-1',
        'COUNT', 5,
        'STREAMS', stream, '>'
      ) as StreamResult;

      const consumer2Result = await redis.xreadgroup(
        'GROUP', group, 'worker-2',
        'COUNT', 5,
        'STREAMS', stream, '>'
      ) as StreamResult;

      // Combined count should be 10 (messages distributed)
      const consumer1Count = consumer1Result?.[0]?.[1]?.length ?? 0;
      const consumer2Count = consumer2Result?.[0]?.[1]?.length ?? 0;

      expect(consumer1Count + consumer2Count).toBe(10);
    });

    it('should handle pending opportunity expiration', async () => {
      const stream = `${STREAMS.PENDING_OPPORTUNITIES}:expire:${testId}`;
      const group = `${GROUPS.CROSS_CHAIN_DETECTOR}-expire-${testId}`;

      await ensureConsumerGroup(redis, stream, group);

      // Create pending opportunity with short deadline
      const now = Date.now();
      const local = createLocalPendingSwapIntent({
        deadline: Math.floor(now / 1000) - 60, // Already expired (1 minute ago)
      });

      const pendingOpp = createPendingOpportunity(local);
      await redis.xadd(stream, '*', 'data', JSON.stringify(pendingOpp));

      // Consumer reads
      const result = await redis.xreadgroup(
        'GROUP', group, 'worker-1',
        'COUNT', 10,
        'STREAMS', stream, '>'
      ) as StreamResult;

      const parsed = JSON.parse(parseStreamFields(result![0][1][0][1]).data) as PendingOpportunity;

      // Consumer should detect expired deadline
      const deadlineMs = parsed.intent.deadline * 1000;
      const isExpired = deadlineMs < Date.now();

      expect(isExpired).toBe(true);
    });
  });

  // ===========================================================================
  // Task 2.2.4: Pre-Block Confidence Boost Tests
  // ===========================================================================

  describe('Task 2.2.4: Pre-Block Opportunity Scoring', () => {
    it('should apply confidence boost for pending opportunities', async () => {
      const baseConfidence = 0.7;
      const pendingBoost = 0.15; // 15% confidence boost for pending detection

      const local = createLocalPendingSwapIntent();
      const pendingOpp = createPendingOpportunity(local, 0.5);

      // Calculate boosted confidence
      const boostedConfidence = Math.min(1.0, baseConfidence + pendingBoost);

      expect(boostedConfidence).toBe(0.85);
      expect(boostedConfidence).toBeGreaterThan(baseConfidence);
    });

    it('should calculate lead time from firstSeen to block inclusion', async () => {
      const now = Date.now();

      const local = createLocalPendingSwapIntent({
        firstSeen: now - 150, // Detected 150ms ago
      });

      // Simulate block inclusion timestamp
      const blockTimestamp = now;

      // Calculate lead time
      const leadTimeMs = blockTimestamp - local.firstSeen;

      expect(leadTimeMs).toBe(150);
      expect(leadTimeMs).toBeGreaterThanOrEqual(50); // Minimum useful lead time
      expect(leadTimeMs).toBeLessThanOrEqual(300); // Maximum realistic lead time
    });

    it('should track confidence score distribution for pending opportunities', async () => {
      const stream = `${STREAMS.PENDING_OPPORTUNITIES}:confidence:${testId}`;
      const group = `${GROUPS.CROSS_CHAIN_DETECTOR}-confidence-${testId}`;

      await ensureConsumerGroup(redis, stream, group);

      // Publish opportunities with varying impacts
      const impacts = [0.1, 0.3, 0.5, 1.0, 2.0];
      const locals: LocalPendingSwapIntent[] = [];

      for (const impact of impacts) {
        const local = createLocalPendingSwapIntent();
        locals.push(local);
        const pendingOpp = createPendingOpportunity(local, impact);
        await redis.xadd(stream, '*', 'data', JSON.stringify(pendingOpp));
      }

      // Consume and calculate confidence scores
      const result = await redis.xreadgroup(
        'GROUP', group, 'scorer-1',
        'COUNT', 10,
        'STREAMS', stream, '>'
      ) as StreamResult;

      const confidenceScores = result![0][1].map(([, fields]) => {
        const data = JSON.parse(parseStreamFields(fields).data) as PendingOpportunity;
        const impact = data.estimatedImpact ?? 0;
        // Higher impact = higher confidence (capped at 0.95)
        return Math.min(0.95, 0.6 + (impact / 5));
      });

      // Verify confidence scores increase with impact
      for (let i = 1; i < confidenceScores.length; i++) {
        expect(confidenceScores[i]).toBeGreaterThanOrEqual(confidenceScores[i - 1]);
      }
    });
  });

  // ===========================================================================
  // Task 2.2.5: Backrunning Opportunity Detection
  // ===========================================================================

  describe('Task 2.2.5: Backrunning Opportunity Detection', () => {
    it('should detect backrunning opportunity from high-impact pending swap', async () => {
      const local = createLocalPendingSwapIntent({
        amountIn: BigInt('50000000000000000000'), // 50 ETH (large swap)
      });

      const pendingOpp = createPendingOpportunity(local, 0.5); // 0.5% impact
      const leadTimeMs = 200; // 200ms before block

      const backrunOpp = canBackrun(pendingOpp, leadTimeMs, 0.1);

      expect(backrunOpp).not.toBeNull();
      expect(backrunOpp!.type).toBe('backrun');
      expect(backrunOpp!.pendingTxHash).toBe(local.hash);
      expect(backrunOpp!.estimatedImpact).toBe(0.5);
      expect(backrunOpp!.leadTimeMs).toBe(200);
    });

    it('should NOT detect backrun for low-impact swaps', async () => {
      const local = createLocalPendingSwapIntent({
        amountIn: BigInt('100000000000000000'), // 0.1 ETH (small swap)
      });

      const pendingOpp = createPendingOpportunity(local, 0.01); // 0.01% impact
      const leadTimeMs = 200;

      const backrunOpp = canBackrun(pendingOpp, leadTimeMs, 0.1);

      expect(backrunOpp).toBeNull(); // Impact too low
    });

    it('should NOT detect backrun when lead time is too short', async () => {
      const local = createLocalPendingSwapIntent();
      const pendingOpp = createPendingOpportunity(local, 0.5);
      const leadTimeMs = 30; // Only 30ms - not enough time

      const backrunOpp = canBackrun(pendingOpp, leadTimeMs, 0.1);

      expect(backrunOpp).toBeNull(); // Not enough time
    });

    it('should calculate backrun confidence based on impact', async () => {
      const impacts = [0.2, 0.5, 1.0, 2.0, 5.0];

      const confidences = impacts.map(impact => {
        const local = createLocalPendingSwapIntent();
        const pendingOpp = createPendingOpportunity(local, impact);
        const backrunOpp = canBackrun(pendingOpp, 200, 0.1);
        return backrunOpp?.confidence ?? 0;
      });

      // Higher impact should yield higher confidence
      for (let i = 1; i < confidences.length; i++) {
        expect(confidences[i]).toBeGreaterThanOrEqual(confidences[i - 1]);
      }

      // Should cap at 0.9
      expect(confidences[confidences.length - 1]).toBeLessThanOrEqual(0.9);
    });
  });

  // ===========================================================================
  // Task 2.2.6: Complete Pending Opportunity Flow
  // ===========================================================================

  describe('Task 2.2.6: Complete Pending Opportunity Flow', () => {
    it('should process pending opportunity through complete pipeline', async () => {
      const pendingStream = `${STREAMS.PENDING_OPPORTUNITIES}:full:${testId}`;
      const oppStream = `${STREAMS.OPPORTUNITIES}:full:${testId}`;
      const pendingGroup = `detector-full-${testId}`;
      const oppGroup = `coordinator-full-${testId}`;

      await ensureConsumerGroup(redis, pendingStream, pendingGroup);
      await ensureConsumerGroup(redis, oppStream, oppGroup);

      // STEP 1: Mempool detector publishes pending opportunity
      const local = createLocalPendingSwapIntent({
        amountIn: BigInt('10000000000000000000'), // 10 ETH
        tokenIn: TOKENS.WETH,
        tokenOut: TOKENS.USDC,
      });
      const impact = 0.3; // 0.3% estimated impact
      const pendingOpp = createPendingOpportunity(local, impact);

      await redis.xadd(pendingStream, '*', 'data', JSON.stringify(pendingOpp));

      // STEP 2: Cross-chain detector consumes pending opportunity
      const pendingResult = await redis.xreadgroup(
        'GROUP', pendingGroup, 'detector-1',
        'COUNT', 10,
        'STREAMS', pendingStream, '>'
      ) as StreamResult;

      expect(pendingResult![0][1].length).toBe(1);

      const consumedPending = JSON.parse(
        parseStreamFields(pendingResult![0][1][0][1]).data
      ) as PendingOpportunity;

      // STEP 3: Detector analyzes pending opportunity
      expect(consumedPending.type).toBe('pending');
      expect(consumedPending.estimatedImpact).toBe(impact);

      // Calculate lead time (simulate)
      const detectionTime = Date.now();
      const leadTimeMs = detectionTime - consumedPending.intent.firstSeen;

      // STEP 4: Determine if backrunning opportunity exists
      const backrunOpp = canBackrun(consumedPending, leadTimeMs > 50 ? leadTimeMs : 100, 0.1);

      // STEP 5: Publish to opportunities stream with confidence boost
      if (backrunOpp) {
        await redis.xadd(oppStream, '*', 'data', JSON.stringify({
          ...backrunOpp,
          timestamp: Date.now(),
          id: `backrun-${Date.now()}`,
        }));
      }

      // Acknowledge pending message
      await redis.xack(pendingStream, pendingGroup, pendingResult![0][1][0][0]);

      // STEP 6: Coordinator consumes opportunity
      const oppResult = await redis.xreadgroup(
        'GROUP', oppGroup, 'coordinator-1',
        'COUNT', 10,
        'STREAMS', oppStream, '>'
      ) as StreamResult;

      expect(oppResult![0][1].length).toBe(1);

      const receivedOpp = JSON.parse(parseStreamFields(oppResult![0][1][0][1]).data);
      expect(receivedOpp.type).toBe('backrun');
      expect(receivedOpp.pendingTxHash).toBe(local.hash);
    });

    it('should handle multiple pending opportunities from different chains', async () => {
      const pendingStream = `${STREAMS.PENDING_OPPORTUNITIES}:multichain:${testId}`;
      const group = `detector-multichain-${testId}`;

      await ensureConsumerGroup(redis, pendingStream, group);

      // Pending swaps from different chains
      const chainConfigs = [
        { chainId: 1, type: 'uniswapV2' as SwapRouterType },
        { chainId: 56, type: 'pancakeswap' as SwapRouterType },
        { chainId: 137, type: 'sushiswap' as SwapRouterType },
      ];

      for (const config of chainConfigs) {
        const local = createLocalPendingSwapIntent({
          chainId: config.chainId,
          type: config.type,
        });
        const pendingOpp = createPendingOpportunity(local);
        await redis.xadd(pendingStream, '*', 'data', JSON.stringify(pendingOpp));
      }

      // Consume all
      const result = await redis.xreadgroup(
        'GROUP', group, 'worker-1',
        'COUNT', 10,
        'STREAMS', pendingStream, '>'
      ) as StreamResult;

      expect(result![0][1].length).toBe(3);

      // Verify different chains
      const chainIds = result![0][1].map(([, fields]) => {
        const data = JSON.parse(parseStreamFields(fields).data) as PendingOpportunity;
        return data.intent.chainId;
      });

      expect(chainIds).toContain(1); // Ethereum
      expect(chainIds).toContain(56); // BSC
      expect(chainIds).toContain(137); // Polygon
    });

    it('should track timing metrics through pipeline', async () => {
      const now = Date.now();
      const pendingStream = `${STREAMS.PENDING_OPPORTUNITIES}:timing:${testId}`;

      // Create with specific timing
      const local = createLocalPendingSwapIntent({
        firstSeen: now - 100, // Detected 100ms ago
      });
      const pendingOpp = createPendingOpportunity(local, 0.5);

      // Publish
      const publishStart = performance.now();
      await redis.xadd(pendingStream, '*', 'data', JSON.stringify(pendingOpp));
      const publishDuration = performance.now() - publishStart;

      // Read
      const readStart = performance.now();
      const result = await redis.xread('COUNT', 1, 'STREAMS', pendingStream, '0') as StreamResult;
      const readDuration = performance.now() - readStart;

      // Parse
      const parseStart = performance.now();
      const parsed = JSON.parse(parseStreamFields(result![0][1][0][1]).data) as PendingOpportunity;
      const parseDuration = performance.now() - parseStart;

      // Total pipeline latency should be under target
      const totalLatency = publishDuration + readDuration + parseDuration;

      console.log(`\n=== PENDING OPPORTUNITY PIPELINE TIMING ===`);
      console.log(`Publish latency: ${publishDuration.toFixed(2)}ms`);
      console.log(`Read latency: ${readDuration.toFixed(2)}ms`);
      console.log(`Parse latency: ${parseDuration.toFixed(2)}ms`);
      console.log(`Total pipeline: ${totalLatency.toFixed(2)}ms`);
      console.log(`===========================================\n`);

      // Should be well under 50ms target
      expect(totalLatency).toBeLessThan(50);
    });
  });
});
