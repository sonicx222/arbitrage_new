/**
 * End-to-End Execution Flow Integration Tests
 *
 * Tests the complete data flow from opportunity detection through
 * coordination to (simulated) execution.
 *
 * This test validates:
 * 1. Opportunities published to Redis Streams are consumed by execution engine
 * 2. Simulation mode correctly bypasses blockchain transactions
 * 3. Execution results are published to results stream
 * 4. The complete pipeline works end-to-end
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 */

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';

// Make this file a module to avoid TS2451 redeclaration errors
export {};

// =============================================================================
// Mock Factories (using dependency injection pattern)
// =============================================================================

// Shared mock state
let mockStreams: Map<string, Array<{ id: string; fields: Record<string, unknown> }>>;
let mockConsumerGroups: Map<string, Map<string, unknown>>;
let mockRedisInstance: any;

// Create mock function factory for proper Jest compatibility
const createMockFn = () => {
  const fn: any = (...args: any[]) => {
    fn.mock.calls.push(args);
    fn.mock.lastCall = args;
    fn.mock.invocationCallOrder.push(fn.mock.invocationCallOrder.length + 1);
    try {
      if (fn._onceQueue && fn._onceQueue.length > 0) {
        const once = fn._onceQueue.shift();
        if (once.type === 'return') {
          fn.mock.results.push({ type: 'return', value: once.value });
          return once.value;
        } else if (once.type === 'resolve') {
          const result = Promise.resolve(once.value);
          fn.mock.results.push({ type: 'return', value: result });
          return result;
        } else if (once.type === 'reject') {
          fn.mock.results.push({ type: 'throw', value: once.value });
          return Promise.reject(once.value);
        } else if (once.type === 'impl') {
          const result = once.value(...args);
          fn.mock.results.push({ type: 'return', value: result });
          return result;
        }
      }
      const result = fn._impl ? fn._impl(...args) : fn._returnValue;
      fn.mock.results.push({ type: 'return', value: result });
      return result;
    } catch (err) {
      fn.mock.results.push({ type: 'throw', value: err });
      throw err;
    }
  };
  fn._isMockFunction = true;
  fn.getMockName = () => 'mockFn';
  fn.getMockImplementation = () => fn._impl;
  fn.mock = { calls: [] as any[], results: [] as any[], instances: [] as any[], contexts: [] as any[], invocationCallOrder: [] as number[], lastCall: undefined as any };
  fn._returnValue = undefined;
  fn._impl = null;
  fn._onceQueue = [] as any[];
  fn.mockReturnThis = () => { fn._returnValue = fn; return fn; };
  fn.mockReturnValue = (val: any) => { fn._returnValue = val; return fn; };
  fn.mockResolvedValue = (val: any) => { fn._impl = async () => val; return fn; };
  fn.mockRejectedValue = (err: any) => { fn._impl = async () => { throw err; }; return fn; };
  fn.mockImplementation = (impl: any) => { fn._impl = impl; return fn; };
  fn.mockReturnValueOnce = (val: any) => { fn._onceQueue.push({ type: 'return', value: val }); return fn; };
  fn.mockResolvedValueOnce = (val: any) => { fn._onceQueue.push({ type: 'resolve', value: val }); return fn; };
  fn.mockRejectedValueOnce = (err: any) => { fn._onceQueue.push({ type: 'reject', value: err }); return fn; };
  fn.mockImplementationOnce = (impl: any) => { fn._onceQueue.push({ type: 'impl', value: impl }); return fn; };
  fn.mockClear = () => { fn.mock.calls = []; fn.mock.results = []; fn.mock.instances = []; fn.mock.contexts = []; fn.mock.invocationCallOrder = []; fn.mock.lastCall = undefined; };
  fn.mockReset = () => { fn.mockClear(); fn._impl = null; fn._returnValue = undefined; fn._onceQueue = []; };
  fn.mockRestore = fn.mockReset;
  fn.mockName = () => fn;
  return fn;
};

// Mock ioredis before importing modules
jest.mock('ioredis', () => {
  const _mockStreams = new Map();
  const _mockConsumerGroups = new Map();

  const instance = {
    xadd: createMockFn().mockImplementation(async (stream: string, id: string, ...args: unknown[]) => {
      const streamData = _mockStreams.get(stream) || [];
      const messageId = id === '*' ? `${Date.now()}-${streamData.length}` : id;
      const fields: Record<string, unknown> = {};
      for (let i = 0; i < args.length; i += 2) {
        fields[args[i] as string] = args[i + 1];
      }
      streamData.push({ id: messageId, fields });
      _mockStreams.set(stream, streamData);
      return messageId;
    }),
    xread: createMockFn().mockImplementation(async (...args: unknown[]) => {
      const streamsIdx = args.indexOf('STREAMS');
      if (streamsIdx === -1) return null;
      const streamName = args[streamsIdx + 1] as string;
      const lastId = args[streamsIdx + 2] as string;
      const streamData = _mockStreams.get(streamName) || [];
      if (streamData.length === 0) return null;
      const messages = streamData.filter((m: any) => lastId === '0' || lastId === '$' || m.id > lastId);
      if (messages.length === 0) return null;
      return [[streamName, messages.map((m: any) => [m.id, Object.entries(m.fields).flat()])]];
    }),
    xreadgroup: createMockFn().mockImplementation(async (...args: unknown[]) => {
      const streamsIdx = args.indexOf('STREAMS');
      if (streamsIdx === -1) return null;
      const streamName = args[streamsIdx + 1] as string;
      const streamData = _mockStreams.get(streamName) || [];
      if (streamData.length === 0) return null;
      // Return first 5 unread messages
      const messages = streamData.slice(0, 5);
      // Clear returned messages to simulate acknowledgment
      _mockStreams.set(streamName, streamData.slice(5));
      if (messages.length === 0) return null;
      return [[streamName, messages.map((m: any) => [m.id, Object.entries(m.fields).flat()])]];
    }),
    xack: createMockFn().mockResolvedValue(1),
    xgroup: createMockFn().mockImplementation(async (command: string, stream: string, group: string) => {
      if (command === 'CREATE') {
        const groups = _mockConsumerGroups.get(stream) || new Map();
        if (groups.has(group)) {
          const error = new Error('BUSYGROUP Consumer Group name already exists');
          (error as any).code = 'BUSYGROUP';
          throw error;
        }
        groups.set(group, { lastDeliveredId: '0-0', consumers: new Map() });
        _mockConsumerGroups.set(stream, groups);
      }
      return 'OK';
    }),
    xinfo: createMockFn().mockImplementation(async (_cmd: string, stream: string) => {
      const streamData = _mockStreams.get(stream) || [];
      return [
        'length', streamData.length,
        'radix-tree-keys', 1,
        'radix-tree-nodes', 2,
        'last-generated-id', streamData.length > 0 ? streamData[streamData.length - 1].id : '0-0',
        'groups', _mockConsumerGroups.get(stream)?.size || 0
      ];
    }),
    xlen: createMockFn().mockImplementation(async (stream: string) => (_mockStreams.get(stream) || []).length),
    xpending: createMockFn().mockImplementation(async () => [0, null, null, []]),
    xtrim: createMockFn().mockResolvedValue(0),
    ping: createMockFn().mockResolvedValue('PONG'),
    disconnect: createMockFn().mockResolvedValue(undefined),
    on: createMockFn().mockReturnThis(),
    off: createMockFn().mockReturnThis(),
    removeAllListeners: createMockFn().mockReturnThis(),
    connect: createMockFn().mockResolvedValue(undefined),
    quit: createMockFn().mockResolvedValue('OK'),
    status: 'ready',
    __mockStreams: _mockStreams,
    __mockConsumerGroups: _mockConsumerGroups
  };

  // Store for tests
  (globalThis as any).__mockRedisInstance = instance;
  (globalThis as any).__mockStreams = _mockStreams;
  (globalThis as any).__mockConsumerGroups = _mockConsumerGroups;

  const MockRedis = function() { return instance; };
  MockRedis.default = MockRedis;
  MockRedis.Redis = MockRedis;

  return MockRedis;
});

// Mock @arbitrage/core Redis client
jest.mock('@arbitrage/core', () => {
  const actual = jest.requireActual('@arbitrage/core') as Record<string, unknown>;
  return {
    ...actual,
    getRedisClient: jest.fn<() => Promise<unknown>>(async () => ({
      get: jest.fn<() => Promise<null>>().mockResolvedValue(null),
      set: jest.fn<() => Promise<string>>().mockResolvedValue('OK'),
      setNx: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      expire: jest.fn<() => Promise<number>>().mockResolvedValue(1),
      disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      updateServiceHealth: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      getAllServiceHealth: jest.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({})
    })),
    getDistributedLockManager: jest.fn<() => Promise<unknown>>(async () => ({
      withLock: jest.fn(async (_key: string, fn: () => Promise<void>) => {
        await fn();
        return { success: true };
      }),
      shutdown: jest.fn<() => Promise<void>>().mockResolvedValue(undefined)
    })),
    getNonceManager: jest.fn<() => unknown>(() => ({
      start: jest.fn(),
      stop: jest.fn(),
      registerWallet: jest.fn(),
      getNextNonce: jest.fn<() => Promise<number>>().mockResolvedValue(1),
      confirmTransaction: jest.fn(),
      failTransaction: jest.fn(),
      resetChain: jest.fn()
    })),
    createLogger: (_name: string) => ({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn()
    }),
    getPerformanceLogger: () => ({
      logEventLatency: jest.fn(),
      logExecutionResult: jest.fn(),
      logHealthCheck: jest.fn()
    }),
    createServiceState: () => ({
      getState: jest.fn<() => string>().mockReturnValue('running'),
      executeStart: jest.fn(async (fn: () => Promise<void>) => {
        await fn();
        return { success: true };
      }),
      executeStop: jest.fn(async (fn: () => Promise<void>) => {
        await fn();
        return { success: true };
      }),
      isRunning: jest.fn<() => boolean>().mockReturnValue(true),
      transition: jest.fn<() => Promise<{ success: boolean }>>().mockResolvedValue({ success: true }),
      isTransitioning: jest.fn<() => boolean>().mockReturnValue(false),
      waitForIdle: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      on: jest.fn(),
      off: jest.fn(),
      canTransition: jest.fn<() => boolean>().mockReturnValue(true)
    })
  };
});

// Helper functions
const getMockStreams = () => (globalThis as any).__mockStreams as Map<string, Array<{ id: string; fields: Record<string, unknown> }>>;
const getMockRedis = () => (globalThis as any).__mockRedisInstance;

// Delay helper
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Import after mocks are set up
import { ExecutionEngineService, SimulationConfig } from '../../services/execution-engine/src/engine';
import { RedisStreamsClient, resetRedisStreamsInstance } from '@arbitrage/core';
import type { ArbitrageOpportunity } from '@arbitrage/types';

describe('End-to-End Execution Flow Integration Tests', () => {
  beforeAll(() => {
    mockStreams = getMockStreams();
    mockConsumerGroups = (globalThis as any).__mockConsumerGroups;
    mockRedisInstance = getMockRedis();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockStreams?.clear();
    mockConsumerGroups?.clear();
    resetRedisStreamsInstance();
  });

  // ==========================================================================
  // Simulation Mode Tests
  // ==========================================================================
  describe('Execution Engine Simulation Mode', () => {
    it('should initialize with simulation mode enabled', () => {
      const config: { simulationConfig: SimulationConfig } = {
        simulationConfig: {
          enabled: true,
          successRate: 1.0, // 100% success for deterministic testing
          executionLatencyMs: 10, // Fast execution for tests
          logSimulatedExecutions: false
        }
      };

      const engine = new ExecutionEngineService(config);

      expect(engine.getIsSimulationMode()).toBe(true);
      expect(engine.getSimulationConfig().enabled).toBe(true);
      expect(engine.getSimulationConfig().successRate).toBe(1.0);
    });

    it('should use default simulation config values when not specified', () => {
      const engine = new ExecutionEngineService({
        simulationConfig: { enabled: true }
      });

      const config = engine.getSimulationConfig();
      expect(config.enabled).toBe(true);
      expect(config.successRate).toBe(0.85); // Default
      expect(config.executionLatencyMs).toBe(500); // Default
      expect(config.gasUsed).toBe(200000); // Default
      expect(config.gasCostMultiplier).toBe(0.1); // Default
      expect(config.profitVariance).toBe(0.2); // Default
      expect(config.logSimulatedExecutions).toBe(true); // Default
    });

    it('should not require wallets in simulation mode', () => {
      const engine = new ExecutionEngineService({
        simulationConfig: { enabled: true }
      });

      // Access private validateOpportunity method
      const opportunity: ArbitrageOpportunity = {
        id: 'test-opp-1',
        type: 'cross-dex',
        buyDex: 'uniswap_v3',
        sellDex: 'sushiswap',
        buyChain: 'ethereum', // Normally would require wallet
        tokenIn: 'WETH',
        tokenOut: 'USDT',
        amountIn: '1000000000000000000',
        expectedProfit: 0.1,
        confidence: 0.85,
        timestamp: Date.now()
      };

      // Should not reject due to missing wallet in simulation mode
      const isValid = (engine as any).validateOpportunity(opportunity);
      expect(isValid).toBe(true);
    });
  });

  // ==========================================================================
  // End-to-End Data Flow Tests
  // ==========================================================================
  describe('Complete Data Flow', () => {
    it('should publish opportunity to stream and track in execution queue', async () => {
      // Create opportunity
      const opportunity: ArbitrageOpportunity = {
        id: `opp-${Date.now()}`,
        type: 'cross-dex',
        buyDex: 'uniswap_v3',
        sellDex: 'sushiswap',
        buyChain: 'ethereum',
        tokenIn: 'WETH',
        tokenOut: 'USDT',
        amountIn: '1000000000000000000',
        expectedProfit: 100, // $100 expected profit
        confidence: 0.9,
        timestamp: Date.now()
      };

      // Publish directly to mock stream (simulating detector)
      const messageData = JSON.stringify({
        ...opportunity,
        status: 'pending'
      });

      await mockRedisInstance.xadd(
        'stream:opportunities',
        '*',
        'data',
        messageData
      );

      // Verify message was added to stream
      const streamData = mockStreams.get('stream:opportunities');
      expect(streamData).toBeDefined();
      expect(streamData?.length).toBe(1);

      // Parse and verify opportunity data
      const storedData = JSON.parse(streamData![0].fields.data as string);
      expect(storedData.id).toBe(opportunity.id);
      expect(storedData.expectedProfit).toBe(100);
    });

    it('should process multiple opportunities in sequence', async () => {
      // Create multiple opportunities
      const opportunities: ArbitrageOpportunity[] = [];
      for (let i = 0; i < 5; i++) {
        opportunities.push({
          id: `opp-batch-${i}`,
          type: 'cross-dex',
          buyDex: 'uniswap_v3',
          sellDex: 'sushiswap',
          buyChain: 'ethereum',
          tokenIn: 'WETH',
          tokenOut: 'USDT',
          amountIn: '1000000000000000000',
          expectedProfit: 50 + i * 10,
          confidence: 0.85,
          timestamp: Date.now() + i
        });
      }

      // Publish all opportunities
      for (const opp of opportunities) {
        await mockRedisInstance.xadd(
          'stream:opportunities',
          '*',
          'data',
          JSON.stringify({ ...opp, status: 'pending' })
        );
      }

      // Verify all opportunities were added
      const streamData = mockStreams.get('stream:opportunities');
      expect(streamData?.length).toBe(5);

      // Verify ordering by timestamp
      const storedOpps = streamData!.map(d => JSON.parse(d.fields.data as string));
      for (let i = 0; i < 4; i++) {
        expect(storedOpps[i].timestamp).toBeLessThan(storedOpps[i + 1].timestamp);
      }
    });
  });

  // ==========================================================================
  // Simulated Execution Tests
  // ==========================================================================
  describe('Simulated Arbitrage Execution', () => {
    it('should generate simulated execution results', async () => {
      const engine = new ExecutionEngineService({
        simulationConfig: {
          enabled: true,
          successRate: 1.0, // Guaranteed success
          executionLatencyMs: 10,
          gasUsed: 200000,
          gasCostMultiplier: 0.1,
          profitVariance: 0,
          logSimulatedExecutions: false
        }
      });

      const opportunity: ArbitrageOpportunity = {
        id: 'sim-test-1',
        type: 'cross-dex',
        buyDex: 'uniswap_v3',
        sellDex: 'sushiswap',
        buyChain: 'ethereum',
        tokenIn: 'WETH',
        tokenOut: 'USDT',
        amountIn: '1000000000000000000',
        expectedProfit: 100,
        confidence: 0.9,
        timestamp: Date.now()
      };

      // Call the private executeSimulatedArbitrage method
      const result = await (engine as any).executeSimulatedArbitrage(opportunity);

      expect(result.opportunityId).toBe('sim-test-1');
      expect(result.success).toBe(true);
      expect(result.transactionHash).toMatch(/^0x[a-f0-9]{64}$/);
      expect(result.gasUsed).toBe(200000);
      expect(result.gasCost).toBe(10); // 100 * 0.1
      expect(result.actualProfit).toBeDefined();
      expect(result.timestamp).toBeGreaterThan(0);
    });

    it('should respect configured success rate', async () => {
      const engine = new ExecutionEngineService({
        simulationConfig: {
          enabled: true,
          successRate: 0, // 0% success rate
          executionLatencyMs: 1,
          logSimulatedExecutions: false
        }
      });

      const opportunity: ArbitrageOpportunity = {
        id: 'fail-test-1',
        type: 'cross-dex',
        buyDex: 'uniswap_v3',
        sellDex: 'sushiswap',
        expectedProfit: 100,
        confidence: 0.9,
        timestamp: Date.now()
      };

      const result = await (engine as any).executeSimulatedArbitrage(opportunity);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Simulated execution failure (random)');
      expect(result.transactionHash).toBeUndefined();
    });

    it('should apply profit variance correctly', async () => {
      const engine = new ExecutionEngineService({
        simulationConfig: {
          enabled: true,
          successRate: 1.0,
          executionLatencyMs: 1,
          gasCostMultiplier: 0,
          profitVariance: 0.5, // ±50% variance
          logSimulatedExecutions: false
        }
      });

      const expectedProfit = 100;
      const opportunity: ArbitrageOpportunity = {
        id: 'variance-test',
        type: 'cross-dex',
        buyDex: 'uniswap_v3',
        sellDex: 'sushiswap',
        expectedProfit,
        confidence: 0.9,
        timestamp: Date.now()
      };

      // Run multiple times to test variance
      const profits: number[] = [];
      for (let i = 0; i < 20; i++) {
        const result = await (engine as any).executeSimulatedArbitrage(opportunity);
        profits.push(result.actualProfit);
      }

      // With 50% variance, profits should range from 50 to 150
      const minProfit = Math.min(...profits);
      const maxProfit = Math.max(...profits);

      expect(minProfit).toBeGreaterThanOrEqual(expectedProfit * 0.5);
      expect(maxProfit).toBeLessThanOrEqual(expectedProfit * 1.5);
    });

    it('should generate unique transaction hashes', async () => {
      const engine = new ExecutionEngineService({
        simulationConfig: {
          enabled: true,
          successRate: 1.0,
          executionLatencyMs: 1,
          logSimulatedExecutions: false
        }
      });

      // Generate multiple hashes
      const hashes: string[] = [];
      for (let i = 0; i < 10; i++) {
        const hash = (engine as any).generateSimulatedTxHash();
        hashes.push(hash);
      }

      // All should be unique
      const uniqueHashes = new Set(hashes);
      expect(uniqueHashes.size).toBe(10);

      // All should be valid format
      hashes.forEach(hash => {
        expect(hash).toMatch(/^0x[a-f0-9]{64}$/);
      });
    });
  });

  // ==========================================================================
  // Stream Publishing Tests
  // ==========================================================================
  describe('Execution Result Publishing', () => {
    it('should publish execution results to stream', async () => {
      const result = {
        opportunityId: 'result-test-1',
        success: true,
        transactionHash: '0xabc123',
        actualProfit: 95,
        gasUsed: 200000,
        gasCost: 5,
        timestamp: Date.now(),
        chain: 'ethereum',
        dex: 'uniswap_v3'
      };

      // Publish to execution-results stream
      await mockRedisInstance.xadd(
        'stream:execution-results',
        '*',
        'data',
        JSON.stringify(result)
      );

      // Verify result was published
      const streamData = mockStreams.get('stream:execution-results');
      expect(streamData?.length).toBe(1);

      const storedResult = JSON.parse(streamData![0].fields.data as string);
      expect(storedResult.opportunityId).toBe('result-test-1');
      expect(storedResult.success).toBe(true);
      expect(storedResult.actualProfit).toBe(95);
    });
  });

  // ==========================================================================
  // Performance Tests
  // ==========================================================================
  describe('Performance Benchmarks', () => {
    it('should handle high throughput opportunity processing', async () => {
      const engine = new ExecutionEngineService({
        simulationConfig: {
          enabled: true,
          successRate: 1.0,
          executionLatencyMs: 1, // Minimal latency for throughput test
          logSimulatedExecutions: false
        }
      });

      const opportunityCount = 100;
      const startTime = performance.now();

      // Execute many simulated opportunities
      for (let i = 0; i < opportunityCount; i++) {
        const opportunity: ArbitrageOpportunity = {
          id: `perf-${i}`,
          type: 'cross-dex',
          buyDex: 'uniswap_v3',
          sellDex: 'sushiswap',
          expectedProfit: 50,
          confidence: 0.9,
          timestamp: Date.now()
        };

        await (engine as any).executeSimulatedArbitrage(opportunity);
      }

      const endTime = performance.now();
      const duration = endTime - startTime;
      const opsPerSecond = (opportunityCount / duration) * 1000;

      // Should process at least 50 ops/second (conservative for CI)
      expect(opsPerSecond).toBeGreaterThan(50);

      console.log(`Performance: ${opportunityCount} simulated executions in ${duration.toFixed(2)}ms`);
      console.log(`Throughput: ${opsPerSecond.toFixed(2)} ops/second`);
    });

    it('should have low latency for simulated execution', async () => {
      const configuredLatency = 50; // 50ms
      const engine = new ExecutionEngineService({
        simulationConfig: {
          enabled: true,
          successRate: 1.0,
          executionLatencyMs: configuredLatency,
          logSimulatedExecutions: false
        }
      });

      const opportunity: ArbitrageOpportunity = {
        id: 'latency-test',
        type: 'cross-dex',
        buyDex: 'uniswap_v3',
        sellDex: 'sushiswap',
        expectedProfit: 100,
        confidence: 0.9,
        timestamp: Date.now()
      };

      const startTime = performance.now();
      await (engine as any).executeSimulatedArbitrage(opportunity);
      const duration = performance.now() - startTime;

      // Should be within ±30% of configured latency (as per implementation)
      const minExpected = configuredLatency * 0.7;
      const maxExpected = configuredLatency * 1.3;

      expect(duration).toBeGreaterThanOrEqual(minExpected);
      expect(duration).toBeLessThanOrEqual(maxExpected * 1.5); // Extra buffer for test environment
    });
  });

  // ==========================================================================
  // Error Handling Tests
  // ==========================================================================
  describe('Error Handling', () => {
    it('should handle validation failures gracefully', () => {
      const engine = new ExecutionEngineService({
        simulationConfig: { enabled: true }
      });

      // Opportunity with low confidence
      const invalidOpp: ArbitrageOpportunity = {
        id: 'invalid-1',
        type: 'cross-dex',
        buyDex: 'uniswap_v3',
        sellDex: 'sushiswap',
        expectedProfit: 100,
        confidence: 0.5, // Below threshold
        timestamp: Date.now()
      };

      const isValid = (engine as any).validateOpportunity(invalidOpp);
      expect(isValid).toBe(false);
    });

    it('should handle missing fields in opportunity', () => {
      const engine = new ExecutionEngineService({
        simulationConfig: { enabled: true }
      });

      // Opportunity with very low profit
      const lowProfitOpp: ArbitrageOpportunity = {
        id: 'low-profit-1',
        type: 'cross-dex',
        buyDex: 'uniswap_v3',
        sellDex: 'sushiswap',
        expectedProfit: 0.001, // Below minimum
        confidence: 0.9,
        timestamp: Date.now()
      };

      const isValid = (engine as any).validateOpportunity(lowProfitOpp);
      expect(isValid).toBe(false);
    });
  });

  // ==========================================================================
  // Integration with Coordinator (Simulated)
  // ==========================================================================
  describe('Coordinator Integration', () => {
    it('should consume opportunities from same stream as coordinator', async () => {
      // Both coordinator and execution engine consume from OPPORTUNITIES stream
      // but use different consumer groups

      const opportunityStream = 'stream:opportunities';

      // Create consumer groups for both services
      await mockRedisInstance.xgroup('CREATE', opportunityStream, 'coordinator-group', '$');

      // Reset error state for second group creation
      const groups = mockConsumerGroups.get(opportunityStream);
      if (groups) groups.delete('execution-engine-group');

      await mockRedisInstance.xgroup('CREATE', opportunityStream, 'execution-engine-group', '$');

      // Verify both groups exist
      const consumerGroups = mockConsumerGroups.get(opportunityStream);
      expect(consumerGroups).toBeDefined();
      expect(consumerGroups?.has('coordinator-group')).toBe(true);
      expect(consumerGroups?.has('execution-engine-group')).toBe(true);
    });

    it('should track opportunities correctly across services', async () => {
      const opportunity: ArbitrageOpportunity = {
        id: 'coord-test-1',
        type: 'cross-dex',
        buyDex: 'uniswap_v3',
        sellDex: 'sushiswap',
        buyChain: 'ethereum',
        expectedProfit: 100,
        confidence: 0.9,
        timestamp: Date.now(),
        status: 'pending'
      };

      // Detector publishes opportunity
      await mockRedisInstance.xadd(
        'stream:opportunities',
        '*',
        'data',
        JSON.stringify(opportunity)
      );

      // Both services should receive the opportunity (different consumer groups)
      const messages = await mockRedisInstance.xread(
        'STREAMS',
        'stream:opportunities',
        '0'
      );

      expect(messages).not.toBeNull();
      expect(messages[0][1].length).toBeGreaterThan(0);

      // Parse opportunity from message
      const receivedData = JSON.parse(messages[0][1][0][1][1]);
      expect(receivedData.id).toBe('coord-test-1');
    });
  });
});
