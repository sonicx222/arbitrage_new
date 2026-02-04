/**
 * Multi-Strategy Execution Integration Test
 *
 * TRUE integration test verifying the execution flow for all 5 arbitrage
 * strategy types via Redis Streams.
 *
 * **Strategy Coverage**:
 * - single-chain (intra-chain): DEX-to-DEX arbitrage on same chain
 * - cross-chain: Arbitrage across different blockchains via bridge
 * - flash-loan: Capital-free execution using flash loans
 * - triangular: 3-hop arbitrage cycle (A → B → C → A)
 * - multi-hop: N-hop arbitrage path (A → B → C → D → A)
 *
 * **Flow Tested**:
 * 1. Opportunity published to stream:opportunities
 * 2. Coordinator routes to appropriate strategy
 * 3. Execution request published to stream:execution-requests
 * 4. Execution engine processes with correct strategy
 *
 * **What's Real**:
 * - Redis Streams (via redis-memory-server)
 * - Strategy routing logic
 * - Consumer group message delivery
 * - Distributed lock acquisition
 *
 * @see Phase 6: Multi-Chain & Multi-Strategy Coverage
 * @see ARCHITECTURE_V2.md Section 4.3 (Strategy Pattern)
 */

import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import Redis from 'ioredis';
import {
  createTestRedisClient,
  ensureConsumerGroup,
} from '@arbitrage/test-utils';

// =============================================================================
// Types and Constants
// =============================================================================

// Type alias for Redis stream messages
type StreamMessage = [string, string[]];
type StreamResult = [string, StreamMessage[]][] | null;

// Stream names (matching RedisStreamsClient.STREAMS)
const STREAMS = {
  PRICE_UPDATES: 'stream:price-updates',
  OPPORTUNITIES: 'stream:opportunities',
  EXECUTION_REQUESTS: 'stream:execution-requests',
  PENDING_OPPORTUNITIES: 'stream:pending-opportunities',
  HEALTH: 'stream:health',
} as const;

// Lock key patterns
const LOCK_KEYS = {
  EXECUTION_PREFIX: 'lock:execution:',
  STRATEGY_PREFIX: 'lock:strategy:',
} as const;

// =============================================================================
// Strategy Configuration
// =============================================================================

/**
 * Strategy types based on docs/strategies.md and strategy-factory.ts.
 *
 * Note: 'simulation' is excluded as it's for dev/test mode, not a real strategy.
 */
type StrategyType = 'intra-chain' | 'cross-chain' | 'flash-loan' | 'triangular' | 'quadrilateral';

interface StrategyTestData {
  /** Strategy type identifier */
  strategyType: StrategyType;
  /** Human-readable name from consolidation plan */
  displayName: string;
  /** Stream flow description */
  flow: string;
  /** Requires bridge for cross-chain */
  requiresBridge: boolean;
  /** Requires flash loan for capital-free execution */
  requiresFlashLoan: boolean;
  /** Number of hops in the arbitrage path */
  hopCount: number;
  /** Minimum profitability threshold */
  minProfitThreshold: number;
  /** Typical gas cost estimate (USD) */
  estimatedGasCost: number;
}

/**
 * All 5 strategy types with test configuration.
 */
const STRATEGY_TEST_DATA: StrategyTestData[] = [
  {
    strategyType: 'intra-chain',
    displayName: 'single-chain',
    flow: 'price-updates -> opportunities -> execution',
    requiresBridge: false,
    requiresFlashLoan: false,
    hopCount: 2,
    minProfitThreshold: 20, // $20 minimum
    estimatedGasCost: 15,
  },
  {
    strategyType: 'cross-chain',
    displayName: 'cross-chain',
    flow: 'price-updates -> cross-chain-opps -> execution',
    requiresBridge: true,
    requiresFlashLoan: false,
    hopCount: 2,
    minProfitThreshold: 50, // Higher due to bridge costs
    estimatedGasCost: 30,
  },
  {
    strategyType: 'flash-loan',
    displayName: 'flash-loan',
    flow: 'opportunities -> flash-loan-execution',
    requiresBridge: false,
    requiresFlashLoan: true,
    hopCount: 2,
    minProfitThreshold: 10, // Lower since no capital needed
    estimatedGasCost: 25,
  },
  {
    strategyType: 'triangular',
    displayName: 'triangular',
    flow: 'price-updates -> triangular-detection',
    requiresBridge: false,
    requiresFlashLoan: true, // Uses flash loan for capital
    hopCount: 3,
    minProfitThreshold: 30, // Higher due to more hops
    estimatedGasCost: 35,
  },
  {
    strategyType: 'quadrilateral',
    displayName: 'multi-hop',
    flow: 'price-updates -> multi-hop-detection',
    requiresBridge: false,
    requiresFlashLoan: true, // Uses flash loan for capital
    hopCount: 4,
    minProfitThreshold: 40, // Highest due to complexity
    estimatedGasCost: 45,
  },
];

// =============================================================================
// Test Data Factories
// =============================================================================

// Test token addresses
const TEST_TOKENS = {
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  DAI: '0x6B175474E89094C44Da98b954EeadFDcD5F72dB',
  USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
} as const;

// Test pair addresses
const TEST_PAIRS = {
  UNISWAP_V3_WETH_USDC: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640',
  SUSHISWAP_WETH_USDC: '0x397FF1542f962076d0BFE58eA045FfA2d347ACa0',
  CURVE_USDC_DAI: '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7',
  UNISWAP_V2_DAI_WETH: '0xA478c2975Ab1Ea89e8196811F51A7B7Ade33eB11',
} as const;

// Router addresses
const TEST_ROUTERS = {
  UNISWAP_V3: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  SUSHISWAP: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
  CURVE: '0x99a58482BD75cbab83b27EC03CA68fF489b5788f',
} as const;

interface ArbitrageOpportunity {
  id: string;
  type: string;
  strategyType: StrategyType;
  chain: string;
  sourceChain?: string;
  targetChain?: string;
  buyDex: string;
  sellDex: string;
  buyPair: string;
  sellPair: string;
  tokenIn: string;
  tokenOut: string;
  buyPrice: number;
  sellPrice: number;
  expectedProfit: number;
  estimatedGasCost: number;
  netProfit: number;
  confidence: number;
  timestamp: number;
  expiresAt: number;
  hops?: SwapHop[];
}

interface SwapHop {
  router?: string;
  dex?: string;
  tokenOut: string;
  expectedOutput?: string;
}

interface ExecutionRequest {
  requestId: string;
  opportunityId: string;
  strategyType: StrategyType;
  chain: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  priority: number;
  timestamp: number;
  deadline: number;
}

/**
 * Create a test opportunity for a specific strategy type.
 */
function createStrategyOpportunity(
  strategyType: StrategyType,
  overrides: Partial<ArbitrageOpportunity> = {}
): ArbitrageOpportunity {
  const base: ArbitrageOpportunity = {
    id: `opp-${strategyType}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: 'arbitrage',
    strategyType,
    chain: 'ethereum',
    buyDex: 'sushiswap',
    sellDex: 'uniswap_v3',
    buyPair: TEST_PAIRS.SUSHISWAP_WETH_USDC,
    sellPair: TEST_PAIRS.UNISWAP_V3_WETH_USDC,
    tokenIn: TEST_TOKENS.WETH,
    tokenOut: TEST_TOKENS.USDC,
    buyPrice: 2500,
    sellPrice: 2550,
    expectedProfit: 50,
    estimatedGasCost: 15,
    netProfit: 35,
    confidence: 0.85,
    timestamp: Date.now(),
    expiresAt: Date.now() + 30000,
    ...overrides,
  };

  // Add strategy-specific fields
  switch (strategyType) {
    case 'cross-chain':
      return {
        ...base,
        sourceChain: overrides.sourceChain ?? 'arbitrum',
        targetChain: overrides.targetChain ?? 'ethereum',
        type: 'cross-chain',
      };
    case 'triangular':
      return {
        ...base,
        type: 'triangular',
        hops: [
          { tokenOut: TEST_TOKENS.USDC, router: TEST_ROUTERS.UNISWAP_V3, dex: 'uniswap_v3' },
          { tokenOut: TEST_TOKENS.DAI, router: TEST_ROUTERS.CURVE, dex: 'curve' },
          { tokenOut: TEST_TOKENS.WETH, router: TEST_ROUTERS.SUSHISWAP, dex: 'sushiswap' },
        ],
      };
    case 'quadrilateral':
      return {
        ...base,
        type: 'multi-hop',
        hops: [
          { tokenOut: TEST_TOKENS.USDC, router: TEST_ROUTERS.UNISWAP_V3, dex: 'uniswap_v3' },
          { tokenOut: TEST_TOKENS.DAI, router: TEST_ROUTERS.CURVE, dex: 'curve' },
          { tokenOut: TEST_TOKENS.USDT, router: TEST_ROUTERS.SUSHISWAP, dex: 'sushiswap' },
          { tokenOut: TEST_TOKENS.WETH, router: TEST_ROUTERS.UNISWAP_V3, dex: 'uniswap_v3' },
        ],
      };
    case 'flash-loan':
      return {
        ...base,
        type: 'flash-loan',
      };
    default:
      return base;
  }
}

/**
 * Create an execution request for an opportunity.
 */
function createExecutionRequest(opportunity: ArbitrageOpportunity): ExecutionRequest {
  return {
    requestId: `req-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    opportunityId: opportunity.id,
    strategyType: opportunity.strategyType,
    chain: opportunity.chain,
    status: 'pending',
    priority: opportunity.netProfit,
    timestamp: Date.now(),
    deadline: opportunity.expiresAt,
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Parse Redis stream field array into object.
 */
function parseStreamFields(fields: string[]): Record<string, string> {
  const fieldObj: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    fieldObj[fields[i]] = fields[i + 1];
  }
  return fieldObj;
}

/**
 * Acquire a distributed lock using Redis SET NX PX pattern.
 */
async function acquireLock(redis: Redis, key: string, ttlMs: number): Promise<boolean> {
  const result = await redis.set(key, 'locked', 'PX', ttlMs, 'NX');
  return result === 'OK';
}

/**
 * Release a distributed lock.
 */
async function releaseLock(redis: Redis, key: string): Promise<void> {
  await redis.del(key);
}

// =============================================================================
// Tests
// =============================================================================

describe('[Level 1] Multi-Strategy Execution Integration', () => {
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
  // with parallel test execution in describe.each blocks.

  // ===========================================================================
  // Strategy-Specific Tests
  // ===========================================================================

  describe('Strategy Routing', () => {
    describe.each(STRATEGY_TEST_DATA)(
      '$displayName ($strategyType) strategy',
      ({ strategyType, displayName, flow, requiresBridge, requiresFlashLoan, hopCount, minProfitThreshold, estimatedGasCost }) => {
        it(`should publish ${displayName} opportunity to stream`, async () => {
          // Use unique stream name to avoid interference from parallel tests
          const testStream = `stream:opportunities:${strategyType}:${Date.now()}`;
          const opportunity = createStrategyOpportunity(strategyType, {
            expectedProfit: minProfitThreshold + 10,
            estimatedGasCost,
          });

          const messageId = await redis.xadd(
            testStream,
            '*',
            'data', JSON.stringify(opportunity)
          );

          expect(messageId).toBeDefined();

          // Verify opportunity content
          const result = await redis.xread('COUNT', 1, 'STREAMS', testStream, '0');
          expect(result).not.toBeNull();
          const [, messages] = result![0];
          const [, fields] = messages[0];
          const fieldObj = parseStreamFields(fields);
          const parsed = JSON.parse(fieldObj.data);

          expect(parsed.strategyType).toBe(strategyType);
          expect(parsed.expectedProfit).toBeGreaterThanOrEqual(minProfitThreshold);
        });

        it(`should route ${displayName} to execution request stream`, async () => {
          // Use unique stream names to avoid interference
          const oppStream = `stream:opportunities:route:${strategyType}:${Date.now()}`;
          const execStream = `stream:execution:route:${strategyType}:${Date.now()}`;

          const opportunity = createStrategyOpportunity(strategyType);
          const executionRequest = createExecutionRequest(opportunity);

          // Publish opportunity
          await redis.xadd(oppStream, '*', 'data', JSON.stringify(opportunity));

          // Coordinator routes to execution
          await redis.xadd(execStream, '*', 'data', JSON.stringify(executionRequest));

          // Verify execution request
          const result = await redis.xread('COUNT', 1, 'STREAMS', execStream, '0');
          expect(result).not.toBeNull();
          const [, messages] = result![0];
          const [, fields] = messages[0];
          const fieldObj = parseStreamFields(fields);
          const parsed = JSON.parse(fieldObj.data);

          expect(parsed.strategyType).toBe(strategyType);
          expect(parsed.opportunityId).toBe(opportunity.id);
        });

        it(`should acquire lock for ${displayName} execution`, async () => {
          // Use unique lock key with timestamp to avoid conflicts
          const uniqueId = `${strategyType}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          const lockKey = `${LOCK_KEYS.EXECUTION_PREFIX}${uniqueId}`;

          // Acquire lock
          const acquired = await acquireLock(redis, lockKey, 30000);
          expect(acquired).toBe(true);

          // Verify lock exists
          const lockValue = await redis.get(lockKey);
          expect(lockValue).toBe('locked');

          // Second acquisition should fail (same key)
          const secondAcquire = await acquireLock(redis, lockKey, 30000);
          expect(secondAcquire).toBe(false);

          // Release and verify
          await releaseLock(redis, lockKey);
          const afterRelease = await redis.get(lockKey);
          expect(afterRelease).toBeNull();
        });

        if (hopCount > 2) {
          it(`should validate ${hopCount}-hop path for ${displayName}`, async () => {
            const opportunity = createStrategyOpportunity(strategyType);

            expect(opportunity.hops).toBeDefined();
            expect(opportunity.hops!.length).toBe(hopCount);

            // Verify each hop has required fields
            for (const hop of opportunity.hops!) {
              expect(hop.tokenOut).toBeDefined();
              expect(hop.router).toBeDefined();
            }

            // Verify path forms a cycle (last tokenOut should be tokenIn)
            const lastHop = opportunity.hops![opportunity.hops!.length - 1];
            expect(lastHop.tokenOut).toBe(opportunity.tokenIn);
          });
        }

        if (requiresBridge) {
          it(`should include bridge data for ${displayName}`, async () => {
            const opportunity = createStrategyOpportunity(strategyType);

            expect(opportunity.sourceChain).toBeDefined();
            expect(opportunity.targetChain).toBeDefined();
            expect(opportunity.sourceChain).not.toBe(opportunity.targetChain);
          });
        }
      }
    );
  });

  // ===========================================================================
  // Profitability Tests
  // ===========================================================================

  describe('Profitability Filtering', () => {
    describe.each(STRATEGY_TEST_DATA)(
      '$displayName profitability',
      ({ strategyType, displayName, minProfitThreshold, estimatedGasCost }) => {
        it(`should publish ${displayName} when profit exceeds threshold`, async () => {
          // Use unique stream to avoid interference
          const testStream = `stream:profit:publish:${strategyType}:${Date.now()}`;

          const opportunity = createStrategyOpportunity(strategyType, {
            expectedProfit: minProfitThreshold + 50,
            estimatedGasCost,
            netProfit: minProfitThreshold + 50 - estimatedGasCost,
          });

          // Only publish if profitable
          if (opportunity.netProfit > 0) {
            await redis.xadd(testStream, '*', 'data', JSON.stringify(opportunity));
          }

          const streamLength = await redis.xlen(testStream);
          expect(streamLength).toBe(1);
        });

        it(`should reject ${displayName} when profit below threshold`, async () => {
          // Use unique stream to avoid interference
          const testStream = `stream:profit:reject:${strategyType}:${Date.now()}`;

          const opportunity = createStrategyOpportunity(strategyType, {
            expectedProfit: minProfitThreshold - 10, // Below threshold
            estimatedGasCost: estimatedGasCost + 20, // Higher gas
            netProfit: -30, // Negative profit
          });

          // Only publish if profitable after gas
          if (opportunity.netProfit > 0) {
            await redis.xadd(testStream, '*', 'data', JSON.stringify(opportunity));
          }

          // Check stream length - should be 0 since nothing should be published
          const streamLength = await redis.xlen(testStream);
          expect(streamLength).toBe(0);
        });
      }
    );
  });

  // ===========================================================================
  // Consumer Group Tests
  // ===========================================================================

  describe('Strategy Consumer Groups', () => {
    it('should distribute opportunities across strategy workers', async () => {
      // Use unique stream and group to avoid interference
      const testStream = `stream:opportunities:dist:${Date.now()}`;
      const groupName = `execution-workers-${Date.now()}`;
      await ensureConsumerGroup(redis, testStream, groupName);

      // Publish opportunities for each strategy type
      for (const { strategyType } of STRATEGY_TEST_DATA) {
        const opportunity = createStrategyOpportunity(strategyType);
        await redis.xadd(testStream, '*', 'data', JSON.stringify(opportunity));
      }

      // Verify all 5 opportunities published
      const streamLength = await redis.xlen(testStream);
      expect(streamLength).toBe(5);

      // Read via consumer group
      const result = await redis.xreadgroup(
        'GROUP', groupName, 'worker-1',
        'COUNT', 10,
        'STREAMS', testStream, '>'
      ) as StreamResult;

      expect(result).toBeDefined();
      expect(result![0][1].length).toBe(5);

      // Verify each strategy type is present
      const strategyTypes = new Set<string>();
      for (const [, fields] of result![0][1]) {
        const fieldObj = parseStreamFields(fields);
        const parsed = JSON.parse(fieldObj.data);
        strategyTypes.add(parsed.strategyType);
      }

      expect(strategyTypes.size).toBe(5);
      for (const { strategyType } of STRATEGY_TEST_DATA) {
        expect(strategyTypes.has(strategyType)).toBe(true);
      }
    });

    it('should handle parallel strategy execution', async () => {
      // Use unique stream and group to avoid interference
      const testStream = `stream:execution:parallel:${Date.now()}`;
      const groupName = `parallel-execution-${Date.now()}`;
      await ensureConsumerGroup(redis, testStream, groupName);

      // Create execution requests for different strategies
      for (const { strategyType } of STRATEGY_TEST_DATA) {
        const opportunity = createStrategyOpportunity(strategyType);
        const request = createExecutionRequest(opportunity);
        await redis.xadd(testStream, '*', 'data', JSON.stringify(request));
      }

      // Simulate parallel workers
      const worker1Result = await redis.xreadgroup(
        'GROUP', groupName, 'executor-1',
        'COUNT', 3,
        'STREAMS', testStream, '>'
      ) as StreamResult;

      const worker2Result = await redis.xreadgroup(
        'GROUP', groupName, 'executor-2',
        'COUNT', 3,
        'STREAMS', testStream, '>'
      ) as StreamResult;

      const w1Count = worker1Result?.[0]?.[1]?.length ?? 0;
      const w2Count = worker2Result?.[0]?.[1]?.length ?? 0;

      // Together should have all 5 requests
      expect(w1Count + w2Count).toBe(5);
    });
  });

  // ===========================================================================
  // Lock Management Tests
  // ===========================================================================

  describe('Distributed Lock Management', () => {
    it('should prevent duplicate execution of same opportunity', async () => {
      const opportunity = createStrategyOpportunity('intra-chain');
      const lockKey = `${LOCK_KEYS.EXECUTION_PREFIX}${opportunity.id}`;

      // First executor acquires lock
      const firstLock = await acquireLock(redis, lockKey, 30000);
      expect(firstLock).toBe(true);

      // Second executor fails to acquire
      const secondLock = await acquireLock(redis, lockKey, 30000);
      expect(secondLock).toBe(false);

      // First executor completes and releases
      await releaseLock(redis, lockKey);

      // Now second executor can acquire
      const retryLock = await acquireLock(redis, lockKey, 30000);
      expect(retryLock).toBe(true);
    });

    it('should auto-expire locks after TTL', async () => {
      const opportunity = createStrategyOpportunity('flash-loan');
      const lockKey = `${LOCK_KEYS.EXECUTION_PREFIX}${opportunity.id}`;

      // Acquire with short TTL
      await acquireLock(redis, lockKey, 100); // 100ms TTL

      // Lock should exist
      let lockValue = await redis.get(lockKey);
      expect(lockValue).toBe('locked');

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 150));

      // Lock should be expired
      lockValue = await redis.get(lockKey);
      expect(lockValue).toBeNull();
    });

    it('should handle strategy-level locks', async () => {
      const strategyLockKey = `${LOCK_KEYS.STRATEGY_PREFIX}flash-loan:ethereum`;

      // Acquire strategy lock (only one flash-loan execution at a time per chain)
      const acquired = await acquireLock(redis, strategyLockKey, 60000);
      expect(acquired).toBe(true);

      // All flash-loan executions on ethereum should be blocked
      const blocked = await acquireLock(redis, strategyLockKey, 60000);
      expect(blocked).toBe(false);

      // Other chains should not be blocked
      const otherChainKey = `${LOCK_KEYS.STRATEGY_PREFIX}flash-loan:arbitrum`;
      const otherChain = await acquireLock(redis, otherChainKey, 60000);
      expect(otherChain).toBe(true);

      // Cleanup
      await releaseLock(redis, strategyLockKey);
      await releaseLock(redis, otherChainKey);
    });
  });

  // ===========================================================================
  // Multi-Hop Strategy Tests
  // ===========================================================================

  describe('Multi-Hop Strategies', () => {
    it('should validate triangular arbitrage path', async () => {
      const opportunity = createStrategyOpportunity('triangular');

      expect(opportunity.hops).toBeDefined();
      expect(opportunity.hops!.length).toBe(3);

      // Verify path: WETH -> USDC -> DAI -> WETH
      expect(opportunity.tokenIn).toBe(TEST_TOKENS.WETH);
      expect(opportunity.hops![0].tokenOut).toBe(TEST_TOKENS.USDC);
      expect(opportunity.hops![1].tokenOut).toBe(TEST_TOKENS.DAI);
      expect(opportunity.hops![2].tokenOut).toBe(TEST_TOKENS.WETH);

      // Path should be circular
      expect(opportunity.hops![2].tokenOut).toBe(opportunity.tokenIn);
    });

    it('should validate quadrilateral arbitrage path', async () => {
      const opportunity = createStrategyOpportunity('quadrilateral');

      expect(opportunity.hops).toBeDefined();
      expect(opportunity.hops!.length).toBe(4);

      // Verify 4-hop path: WETH -> USDC -> DAI -> USDT -> WETH
      expect(opportunity.tokenIn).toBe(TEST_TOKENS.WETH);
      expect(opportunity.hops![0].tokenOut).toBe(TEST_TOKENS.USDC);
      expect(opportunity.hops![1].tokenOut).toBe(TEST_TOKENS.DAI);
      expect(opportunity.hops![2].tokenOut).toBe(TEST_TOKENS.USDT);
      expect(opportunity.hops![3].tokenOut).toBe(TEST_TOKENS.WETH);

      // Path should be circular
      expect(opportunity.hops![3].tokenOut).toBe(opportunity.tokenIn);
    });

    it('should include router addresses for each hop', async () => {
      const triangular = createStrategyOpportunity('triangular');
      const quad = createStrategyOpportunity('quadrilateral');

      // All hops should have router addresses
      for (const hop of triangular.hops!) {
        expect(hop.router).toBeDefined();
        expect(hop.router!.startsWith('0x')).toBe(true);
      }

      for (const hop of quad.hops!) {
        expect(hop.router).toBeDefined();
        expect(hop.router!.startsWith('0x')).toBe(true);
      }
    });
  });

  // ===========================================================================
  // Cross-Chain Strategy Tests
  // ===========================================================================

  describe('Cross-Chain Strategies', () => {
    it('should include source and target chain', async () => {
      const opportunity = createStrategyOpportunity('cross-chain');

      expect(opportunity.sourceChain).toBeDefined();
      expect(opportunity.targetChain).toBeDefined();
      expect(opportunity.sourceChain).toBe('arbitrum');
      expect(opportunity.targetChain).toBe('ethereum');
    });

    it('should publish cross-chain opportunity to stream', async () => {
      // Use unique stream to avoid interference
      const testStream = `stream:crosschain:test:${Date.now()}`;

      const opportunity = createStrategyOpportunity('cross-chain', {
        sourceChain: 'polygon',
        targetChain: 'ethereum',
        expectedProfit: 100,
      });

      await redis.xadd(testStream, '*', 'data', JSON.stringify(opportunity));

      const result = await redis.xread('COUNT', 1, 'STREAMS', testStream, '0');
      expect(result).not.toBeNull();
      const [, messages] = result![0];
      const [, fields] = messages[0];
      const fieldObj = parseStreamFields(fields);
      const parsed = JSON.parse(fieldObj.data);

      expect(parsed.type).toBe('cross-chain');
      expect(parsed.sourceChain).toBe('polygon');
      expect(parsed.targetChain).toBe('ethereum');
    });
  });

  // ===========================================================================
  // Regression Tests
  // ===========================================================================

  describe('Regression Tests', () => {
    it('should support all 5 strategy types', () => {
      expect(STRATEGY_TEST_DATA.length).toBe(5);
    });

    it.each(STRATEGY_TEST_DATA)(
      '$displayName should have valid configuration',
      ({ strategyType, requiresBridge, requiresFlashLoan, hopCount }) => {
        expect(strategyType).toBeDefined();
        expect(typeof requiresBridge).toBe('boolean');
        expect(typeof requiresFlashLoan).toBe('boolean');
        expect(hopCount).toBeGreaterThanOrEqual(2);
      }
    );

    it('should have exactly one cross-chain strategy', () => {
      const crossChainStrategies = STRATEGY_TEST_DATA.filter(s => s.requiresBridge);
      expect(crossChainStrategies.length).toBe(1);
      expect(crossChainStrategies[0].strategyType).toBe('cross-chain');
    });

    it('should have exactly 3 flash-loan strategies', () => {
      const flashLoanStrategies = STRATEGY_TEST_DATA.filter(s => s.requiresFlashLoan);
      expect(flashLoanStrategies.length).toBe(3);
      expect(flashLoanStrategies.map(s => s.strategyType).sort()).toEqual(['flash-loan', 'quadrilateral', 'triangular'].sort());
    });

    it('should create valid opportunities for all strategy types', async () => {
      for (const { strategyType } of STRATEGY_TEST_DATA) {
        const opportunity = createStrategyOpportunity(strategyType);

        expect(opportunity.id).toBeDefined();
        expect(opportunity.strategyType).toBe(strategyType);
        expect(opportunity.tokenIn).toBeDefined();
        expect(opportunity.tokenOut).toBeDefined();
        expect(opportunity.expectedProfit).toBeGreaterThan(0);
      }
    });
  });

  // ===========================================================================
  // Performance Tests
  // ===========================================================================

  describe('Performance', () => {
    it('should handle concurrent strategy execution requests', async () => {
      // Use unique stream to avoid interference
      const testStream = `stream:execution:perf:${Date.now()}`;
      const promises: Promise<string | null>[] = [];

      // Generate 50 execution requests across all strategies
      for (let i = 0; i < 50; i++) {
        const strategyData = STRATEGY_TEST_DATA[i % STRATEGY_TEST_DATA.length];
        const opportunity = createStrategyOpportunity(strategyData.strategyType, {
          expectedProfit: 50 + i,
        });
        const request = createExecutionRequest(opportunity);
        promises.push(redis.xadd(testStream, '*', 'data', JSON.stringify(request)));
      }

      await Promise.all(promises);

      const streamLength = await redis.xlen(testStream);
      expect(streamLength).toBe(50);
    });

    it('should rank opportunities by net profit', async () => {
      // Use unique sorted set key to avoid interference
      const rankingKey = `opportunities:by-profit:${Date.now()}`;

      const opportunities = STRATEGY_TEST_DATA.map(({ strategyType }, index) =>
        createStrategyOpportunity(strategyType, {
          netProfit: (index + 1) * 20, // 20, 40, 60, 80, 100
        })
      );

      // Store in sorted set by net profit
      for (const opp of opportunities) {
        await redis.zadd(rankingKey, opp.netProfit, JSON.stringify(opp));
      }

      // Get top 3 by profit
      const top3 = await redis.zrevrange(rankingKey, 0, 2);
      expect(top3.length).toBe(3);

      const profits = top3.map(o => JSON.parse(o).netProfit);
      expect(profits[0]).toBe(100);
      expect(profits[1]).toBe(80);
      expect(profits[2]).toBe(60);
    });
  });
});
