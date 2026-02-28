/**
 * Unit tests for OpportunityRouter
 *
 * Comprehensive coverage for:
 * - Opportunity processing (storage, duplicate detection, validation)
 * - Forwarding to execution engine via Redis Streams
 * - Circuit breaker integration
 * - Retry logic with exponential backoff
 * - Dead letter queue for permanent failures
 * - Expiry cleanup and size limit enforcement
 * - Shutdown behavior
 * - Stats and monitoring counters
 *
 * @see services/coordinator/src/opportunities/opportunity-router.ts
 */

import {
  OpportunityRouter,
} from '../../../src/opportunities/opportunity-router';
import { createMockLogger } from '@arbitrage/test-utils';
import type {
  OpportunityStreamsClient,
  CircuitBreaker,
  OpportunityAlert,
  OpportunityRouterConfig,
} from '../../../src/opportunities/opportunity-router';
import { serializeOpportunityForStream } from '../../../src/utils/stream-serialization';
import type { ArbitrageOpportunity } from '@arbitrage/types';

// =============================================================================
// Mock: serializeOpportunityForStream
// =============================================================================

jest.mock('../../../src/utils/stream-serialization', () => ({
  serializeOpportunityForStream: jest.fn(),
}));

const mockSerialize = serializeOpportunityForStream as jest.MockedFunction<typeof serializeOpportunityForStream>;

/** Default serialized output returned by the mock */
const MOCK_SERIALIZED_DATA: Record<string, string> = {
  id: 'mock-serialized',
  forwardedBy: 'coordinator',
};

// =============================================================================
// Test Helpers
// =============================================================================

// M12 FIX: Logger mock now uses shared createMockLogger from @arbitrage/test-utils
// for consistency across test files (coordinator-routing, opportunity-router, etc.)

/**
 * Creates a mock Redis Streams client.
 */
function createMockStreamsClient(): jest.Mocked<OpportunityStreamsClient> {
  return {
    xadd: jest.fn().mockResolvedValue('stream-id-1'),
  };
}

/**
 * Creates a mock circuit breaker in closed state by default.
 */
// M13 FIX: Standardized circuit breaker mock (matches coordinator-routing.test.ts)
function createMockCircuitBreaker(overrides?: Partial<jest.Mocked<CircuitBreaker>>): jest.Mocked<CircuitBreaker> {
  return {
    isCurrentlyOpen: jest.fn().mockReturnValue(false),
    recordFailure: jest.fn().mockReturnValue(false),
    recordSuccess: jest.fn().mockReturnValue(false),
    getFailures: jest.fn().mockReturnValue(0),
    getStatus: jest.fn().mockReturnValue({ isOpen: false, failures: 0, resetTimeoutMs: 60000 }),
    ...overrides,
  };
}

/**
 * Creates a raw opportunity data record suitable for processOpportunity().
 */
function createOpportunityData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `opp-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
    chain: 'ethereum',
    buyDex: 'uniswap',
    sellDex: 'sushiswap',
    profitPercentage: 2.5,
    confidence: 0.85,
    timestamp: Date.now(),
    status: 'pending',
    ...overrides,
  };
}

/**
 * Creates an ArbitrageOpportunity object for direct forwarding tests.
 */
function createOpportunity(overrides: Partial<ArbitrageOpportunity> = {}): ArbitrageOpportunity {
  return {
    id: `opp-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
    chain: 'ethereum',
    buyDex: 'uniswap',
    sellDex: 'sushiswap',
    profitPercentage: 2.5,
    confidence: 0.85,
    timestamp: Date.now(),
    status: 'pending',
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('OpportunityRouter', () => {
  let logger: ReturnType<typeof createMockLogger>;
  let streamsClient: jest.Mocked<OpportunityStreamsClient>;
  let circuitBreaker: jest.Mocked<CircuitBreaker>;
  let router: OpportunityRouter;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSerialize.mockReturnValue(MOCK_SERIALIZED_DATA);
    logger = createMockLogger();
    streamsClient = createMockStreamsClient();
    circuitBreaker = createMockCircuitBreaker();
    router = new OpportunityRouter(logger, circuitBreaker, streamsClient, {
      maxOpportunities: 100,
      opportunityTtlMs: 60000,
      duplicateWindowMs: 5000,
      instanceId: 'test-coordinator',
      maxRetries: 3,
      retryBaseDelayMs: 1, // Use 1ms for fast tests
    });
  });

  afterEach(() => {
    router.reset();
  });

  // ===========================================================================
  // Core Processing Logic
  // ===========================================================================

  describe('processOpportunity', () => {
    it('should accept and store a valid opportunity, returning true', async () => {
      const data = createOpportunityData({ id: 'opp-valid-1' });

      const result = await router.processOpportunity(data, false);

      expect(result).toBe(true);
      expect(router.getPendingCount()).toBe(1);
      expect(router.getTotalOpportunities()).toBe(1);

      const stored = router.getOpportunities();
      expect(stored.has('opp-valid-1')).toBe(true);
      const opp = stored.get('opp-valid-1')!;
      expect(opp.chain).toBe('ethereum');
      expect(opp.buyDex).toBe('uniswap');
      expect(opp.sellDex).toBe('sushiswap');
      expect(opp.profitPercentage).toBe(2.5);
      expect(opp.confidence).toBe(0.85);
    });

    it('should reject data without an id, returning false', async () => {
      const data = createOpportunityData();
      delete data.id;

      const result = await router.processOpportunity(data, false);

      expect(result).toBe(false);
      expect(router.getPendingCount()).toBe(0);
      expect(router.getTotalOpportunities()).toBe(0);
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('missing or invalid id'),
      );
    });

    it('should reject data with a non-string id', async () => {
      const data = createOpportunityData({ id: 12345 });

      const result = await router.processOpportunity(data, false);

      expect(result).toBe(false);
      expect(router.getPendingCount()).toBe(0);
    });

    it('should reject duplicate opportunities within the duplicate window', async () => {
      const now = Date.now();
      const data1 = createOpportunityData({ id: 'opp-dup', timestamp: now });
      const data2 = createOpportunityData({ id: 'opp-dup', timestamp: now + 1000 });

      const result1 = await router.processOpportunity(data1, false);
      const result2 = await router.processOpportunity(data2, false);

      expect(result1).toBe(true);
      expect(result2).toBe(false);
      expect(router.getTotalOpportunities()).toBe(1);
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Duplicate opportunity'),
        expect.objectContaining({ id: 'opp-dup' }),
      );
    });

    it('should accept the same id again if timestamps differ beyond the duplicate window', async () => {
      const now = Date.now();
      const data1 = createOpportunityData({ id: 'opp-reuse', timestamp: now });
      const data2 = createOpportunityData({ id: 'opp-reuse', timestamp: now + 10000 });

      const result1 = await router.processOpportunity(data1, false);
      const result2 = await router.processOpportunity(data2, false);

      expect(result1).toBe(true);
      expect(result2).toBe(true);
      expect(router.getTotalOpportunities()).toBe(2);
    });

    it('should reject opportunities with profit percentage below minimum', async () => {
      const data = createOpportunityData({
        id: 'opp-low-profit',
        profitPercentage: -200,
      });

      const result = await router.processOpportunity(data, false);

      expect(result).toBe(false);
      expect(router.getPendingCount()).toBe(0);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Invalid profit percentage'),
        expect.objectContaining({ reason: 'below_minimum' }),
      );
    });

    it('should reject opportunities with profit percentage above maximum', async () => {
      const data = createOpportunityData({
        id: 'opp-high-profit',
        profitPercentage: 50000,
      });

      const result = await router.processOpportunity(data, false);

      expect(result).toBe(false);
      expect(router.getPendingCount()).toBe(0);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Invalid profit percentage'),
        expect.objectContaining({ reason: 'above_maximum' }),
      );
    });

    // =========================================================================
    // H2: Chain whitelist validation
    // =========================================================================

    it('should accept opportunities with canonical chain names', async () => {
      const validChains = ['ethereum', 'bsc', 'arbitrum', 'polygon', 'optimism', 'base', 'avalanche', 'fantom', 'zksync', 'linea', 'solana'];
      for (const chain of validChains) {
        router.reset();
        const data = createOpportunityData({ id: `opp-${chain}`, chain });
        const result = await router.processOpportunity(data, false);
        expect(result).toBe(true);
      }
    });

    it('should reject opportunities with unrecognized chain names', async () => {
      const data = createOpportunityData({
        id: 'opp-bad-chain',
        chain: 'fake-chain-does-not-exist',
      });

      const result = await router.processOpportunity(data, false);

      expect(result).toBe(false);
      expect(router.getPendingCount()).toBe(0);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Unknown chain'),
        expect.objectContaining({ chain: 'fake-chain-does-not-exist' }),
      );
    });

    it('should normalize chain aliases before validation', async () => {
      // 'eth' is a common alias for 'ethereum' — normalizeChainId handles this
      const data = createOpportunityData({
        id: 'opp-alias-chain',
        chain: 'eth',
      });

      const result = await router.processOpportunity(data, false);

      // 'eth' normalizes to 'ethereum' which is canonical
      expect(result).toBe(true);
    });

    it('should accept opportunities without a chain field (optional)', async () => {
      const data = createOpportunityData({ id: 'opp-no-chain' });
      delete data.chain;

      const result = await router.processOpportunity(data, false);

      expect(result).toBe(true);
      expect(router.getPendingCount()).toBe(1);
    });

    it('should skip chain validation when chain is not a string', async () => {
      const data = createOpportunityData({ id: 'opp-num-chain', chain: 12345 });

      const result = await router.processOpportunity(data, false);

      // Non-string chain is treated as missing (rawChain is undefined)
      expect(result).toBe(true);
    });

    it('should accept opportunities without a profitPercentage field (undefined passes validation)', async () => {
      const data = createOpportunityData({ id: 'opp-no-profit' });
      delete data.profitPercentage;

      const result = await router.processOpportunity(data, false);

      expect(result).toBe(true);
      expect(router.getPendingCount()).toBe(1);
    });

    it('should default timestamp to Date.now() when not a number', async () => {
      const before = Date.now();
      const data = createOpportunityData({
        id: 'opp-no-ts',
        timestamp: 'not-a-number',
      });

      const result = await router.processOpportunity(data, false);
      const after = Date.now();

      expect(result).toBe(true);
      const opp = router.getOpportunities().get('opp-no-ts')!;
      expect(opp.timestamp).toBeGreaterThanOrEqual(before);
      expect(opp.timestamp).toBeLessThanOrEqual(after);
    });

    it('should default confidence to 0 when not a number', async () => {
      const data = createOpportunityData({ id: 'opp-no-conf', confidence: undefined });

      await router.processOpportunity(data, false);

      const opp = router.getOpportunities().get('opp-no-conf')!;
      expect(opp.confidence).toBe(0);
    });

    it('should handle missing optional string fields gracefully', async () => {
      const data: Record<string, unknown> = {
        id: 'opp-minimal',
        timestamp: Date.now(),
        confidence: 0.5,
      };

      const result = await router.processOpportunity(data, false);

      expect(result).toBe(true);
      const opp = router.getOpportunities().get('opp-minimal')!;
      expect(opp.chain).toBeUndefined();
      expect(opp.buyDex).toBeUndefined();
      expect(opp.sellDex).toBeUndefined();
    });

    it('should forward to execution engine when isLeader is true and status is pending', async () => {
      const data = createOpportunityData({ id: 'opp-leader', status: 'pending' });

      await router.processOpportunity(data, true);

      expect(streamsClient.xadd).toHaveBeenCalledTimes(1);
      expect(router.getTotalExecutions()).toBe(1);
    });

    it('should forward to execution engine when isLeader is true and status is undefined', async () => {
      const data = createOpportunityData({ id: 'opp-leader-undefined' });
      delete data.status;

      await router.processOpportunity(data, true);

      expect(streamsClient.xadd).toHaveBeenCalledTimes(1);
      expect(router.getTotalExecutions()).toBe(1);
    });

    it('should NOT forward when isLeader is false', async () => {
      const data = createOpportunityData({ id: 'opp-not-leader', status: 'pending' });

      await router.processOpportunity(data, false);

      expect(streamsClient.xadd).not.toHaveBeenCalled();
      expect(router.getTotalExecutions()).toBe(0);
    });

    it('should NOT forward when status is not pending (e.g. executing)', async () => {
      const data = createOpportunityData({ id: 'opp-executing', status: 'executing' });

      await router.processOpportunity(data, true);

      expect(streamsClient.xadd).not.toHaveBeenCalled();
    });

    // =========================================================================
    // Forwarding observability
    // =========================================================================

    describe('forwarding observability', () => {
      it('should log reason when opportunity is not forwarded due to non-leader status', async () => {
        const data = createOpportunityData({ id: 'opp-not-leader-obs', status: 'pending' });

        await router.processOpportunity(data, false);

        expect(logger.debug).toHaveBeenCalledWith(
          'Opportunity stored but not forwarded',
          expect.objectContaining({
            id: 'opp-not-leader-obs',
            reason: 'not_leader',
            isLeader: false,
            status: 'pending',
          }),
        );
        expect(streamsClient.xadd).not.toHaveBeenCalled();
      });

      it('should log reason when opportunity is not forwarded due to non-pending status', async () => {
        const data = createOpportunityData({ id: 'opp-status-obs', status: 'executed' });

        await router.processOpportunity(data, true);

        expect(logger.debug).toHaveBeenCalledWith(
          'Opportunity stored but not forwarded',
          expect.objectContaining({
            id: 'opp-status-obs',
            reason: 'status_not_pending',
            isLeader: true,
            status: 'executed',
          }),
        );
        expect(streamsClient.xadd).not.toHaveBeenCalled();
      });
    });

    it('should log opportunity detection with metadata', async () => {
      const data = createOpportunityData({
        id: 'opp-log',
        chain: 'bsc',
        profitPercentage: 3.0,
        buyDex: 'pancakeswap',
        sellDex: 'biswap',
      });

      await router.processOpportunity(data, false);

      expect(logger.info).toHaveBeenCalledWith(
        'Opportunity detected',
        expect.objectContaining({
          id: 'opp-log',
          chain: 'bsc',
          profitPercentage: 3.0,
          buyDex: 'pancakeswap',
          sellDex: 'biswap',
        }),
      );
    });
  });

  // ===========================================================================
  // Forwarding to Execution Engine
  // ===========================================================================

  describe('forwardToExecutionEngine', () => {
    it('should forward via xadd with serialized data and record success', async () => {
      const opp = createOpportunity({ id: 'opp-fwd-1' });

      await router.forwardToExecutionEngine(opp);

      // OP-3: Third argument is optional trace context (undefined when not provided)
      expect(mockSerialize).toHaveBeenCalledWith(opp, 'test-coordinator', undefined);
      // FIX W2-8: xadd now includes MAXLEN options
      expect(streamsClient.xadd).toHaveBeenCalledWith(
        'stream:execution-requests',
        expect.objectContaining({ id: 'mock-serialized' }),
        '*',
        expect.objectContaining({ maxLen: 5000, approximate: true }),
      );
      expect(circuitBreaker.recordSuccess).toHaveBeenCalled();
      expect(router.getTotalExecutions()).toBe(1);
    });

    it('should stamp pipelineTimestamps.coordinatorAt before serialization', async () => {
      const opp = createOpportunity({ id: 'opp-pipeline' });
      const before = Date.now();

      await router.forwardToExecutionEngine(opp);

      expect(opp.pipelineTimestamps).toMatchObject({ coordinatorAt: expect.any(Number) });
      expect(opp.pipelineTimestamps!.coordinatorAt).toBeGreaterThanOrEqual(before);
      expect(opp.pipelineTimestamps!.coordinatorAt).toBeLessThanOrEqual(Date.now());
    });

    it('should warn and return early when streams client is null', async () => {
      const routerNoClient = new OpportunityRouter(logger, circuitBreaker, null);
      const opp = createOpportunity({ id: 'opp-no-client' });

      await routerNoClient.forwardToExecutionEngine(opp);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('streams client not initialized'),
        expect.objectContaining({ id: 'opp-no-client' }),
      );
      expect(streamsClient.xadd).not.toHaveBeenCalled();
      expect(routerNoClient.getTotalExecutions()).toBe(0);
    });

    it('should skip forwarding when circuit breaker is open but write to DLQ', async () => {
      circuitBreaker.isCurrentlyOpen.mockReturnValue(true);
      circuitBreaker.getFailures.mockReturnValue(5);
      const opp = createOpportunity({ id: 'opp-circuit-open' });

      await router.forwardToExecutionEngine(opp);

      // OP-2 FIX: xadd is NOT called for the execution stream, but IS called for DLQ
      expect(streamsClient.xadd).toHaveBeenCalledTimes(1);
      expect(streamsClient.xadd).toHaveBeenCalledWith(
        'stream:forwarding-dlq',
        expect.objectContaining({
          opportunityId: 'opp-circuit-open',
          error: 'Circuit breaker open',
          service: 'opportunity-router',
        }),
      );
      expect(router.getTotalExecutions()).toBe(0);
      expect(router.getOpportunitiesDropped()).toBe(1);
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('circuit open'),
        expect.objectContaining({ id: 'opp-circuit-open', failures: 5 }),
      );
    });

    it('should log recovery message when circuit breaker records a recovery', async () => {
      circuitBreaker.recordSuccess.mockReturnValue(true);
      const opp = createOpportunity({ id: 'opp-recovery' });

      await router.forwardToExecutionEngine(opp);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('circuit breaker closed - recovered'),
      );
    });

    // M13 FIX: Explicit half-open scenario test
    it('should forward successfully in half-open state and record recovery', async () => {
      // Simulate half-open: circuit was previously open but timer expired,
      // allowing one test request through
      circuitBreaker.isCurrentlyOpen.mockReturnValue(false); // half-open allows requests
      circuitBreaker.getFailures.mockReturnValue(3); // previous failures still recorded
      circuitBreaker.recordSuccess.mockReturnValue(true); // success → circuit closes (recovery)

      const opp = createOpportunity({ id: 'opp-halfopen', chain: 'ethereum', profitPercentage: 1.2 });
      await router.forwardToExecutionEngine(opp);

      // Verify the request went through
      expect(streamsClient.xadd).toHaveBeenCalled();
      expect(circuitBreaker.recordSuccess).toHaveBeenCalled();
      // Verify recovery was logged
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('circuit breaker closed - recovered'),
      );
    });

    it('should log forwarding success with attempt count', async () => {
      const opp = createOpportunity({ id: 'opp-success-log', chain: 'bsc', profitPercentage: 1.5 });

      await router.forwardToExecutionEngine(opp);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Forwarded opportunity'),
        expect.objectContaining({
          id: 'opp-success-log',
          chain: 'bsc',
          profitPercentage: 1.5,
          attempt: 1,
        }),
      );
    });
  });

  // ===========================================================================
  // Retry Logic
  // ===========================================================================

  describe('retry logic', () => {
    it('should retry on first failure and succeed on second attempt', async () => {
      streamsClient.xadd
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockResolvedValueOnce('stream-id-2');

      const opp = createOpportunity({ id: 'opp-retry-ok' });

      await router.forwardToExecutionEngine(opp);

      expect(streamsClient.xadd).toHaveBeenCalledTimes(2);
      expect(circuitBreaker.recordFailure).toHaveBeenCalledTimes(1);
      expect(circuitBreaker.recordSuccess).toHaveBeenCalledTimes(1);
      expect(router.getTotalExecutions()).toBe(1);
      expect(router.getOpportunitiesDropped()).toBe(0);
    });

    it('should exhaust all retries and drop the opportunity when all fail', async () => {
      streamsClient.xadd.mockRejectedValue(new Error('Persistent failure'));

      const opp = createOpportunity({ id: 'opp-retry-exhaust' });

      await router.forwardToExecutionEngine(opp);

      // 3 execution attempts + 1 DLQ attempt (also rejected) = 4 total xadd calls
      const executionCalls = streamsClient.xadd.mock.calls.filter(
        c => c[0] === 'stream:execution-requests',
      );
      expect(executionCalls).toHaveLength(3); // maxRetries = 3
      expect(router.getTotalExecutions()).toBe(0);
      expect(router.getOpportunitiesDropped()).toBe(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to forward opportunity after all retries'),
        expect.objectContaining({
          id: 'opp-retry-exhaust',
          attempts: 3,
        }),
      );
    });

    it('should stop retrying when circuit breaker opens during retry loop', async () => {
      // Execution xadd fails, but DLQ xadd succeeds
      streamsClient.xadd.mockImplementation(async (stream: string) => {
        if (stream === 'stream:execution-requests') {
          throw new Error('Timeout');
        }
        return 'dlq-id';
      });
      // recordFailure returns true on the first failure (circuit just opened)
      circuitBreaker.recordFailure.mockReturnValueOnce(true);
      circuitBreaker.getStatus.mockReturnValue({
        isOpen: true,
        failures: 5,
        resetTimeoutMs: 30000,
      });

      const alertCallback = jest.fn();
      const routerWithAlert = new OpportunityRouter(
        logger, circuitBreaker, streamsClient,
        { maxRetries: 3, retryBaseDelayMs: 1, instanceId: 'test-coordinator' },
        alertCallback,
      );

      const opp = createOpportunity({ id: 'opp-circuit-break' });
      await routerWithAlert.forwardToExecutionEngine(opp);

      // 1 execution attempt (broke out of loop) + 1 DLQ write = 2 total
      const executionCalls = streamsClient.xadd.mock.calls.filter(
        c => c[0] === 'stream:execution-requests',
      );
      expect(executionCalls).toHaveLength(1);
      expect(alertCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'EXECUTION_CIRCUIT_OPEN',
          severity: 'high',
        }),
      );
    });

    it('should stop retrying when circuit breaker is already open after a failure', async () => {
      // Execution xadd fails, but DLQ xadd succeeds
      streamsClient.xadd.mockImplementation(async (stream: string) => {
        if (stream === 'stream:execution-requests') {
          throw new Error('Timeout');
        }
        return 'dlq-id';
      });
      // First failure: circuit doesn't open (returns false)
      circuitBreaker.recordFailure.mockReturnValueOnce(false);
      // But circuit is now open when checked after failure
      circuitBreaker.isCurrentlyOpen
        .mockReturnValueOnce(false) // Initial check before retry loop
        .mockReturnValueOnce(true); // Check after first failure

      const opp = createOpportunity({ id: 'opp-already-open' });
      await router.forwardToExecutionEngine(opp);

      // 1 execution attempt (circuit found open after failure) + 1 DLQ write
      const executionCalls = streamsClient.xadd.mock.calls.filter(
        c => c[0] === 'stream:execution-requests',
      );
      expect(executionCalls).toHaveLength(1);
      expect(router.getOpportunitiesDropped()).toBe(1);
    });
  });

  // ===========================================================================
  // Dead Letter Queue
  // ===========================================================================

  describe('dead letter queue', () => {
    it('should move to DLQ after all retries are exhausted', async () => {
      streamsClient.xadd.mockRejectedValue(new Error('Network error'));

      const opp = createOpportunity({ id: 'opp-dlq-1' });
      await router.forwardToExecutionEngine(opp);

      // The last xadd call should be to the DLQ stream
      const dlqCall = streamsClient.xadd.mock.calls.find(
        call => call[0] === 'stream:forwarding-dlq',
      );
      expect(dlqCall).not.toBeUndefined();
      expect(dlqCall![1]).toEqual(
        expect.objectContaining({
          opportunityId: 'opp-dlq-1',
          error: 'Network error',
          service: 'opportunity-router',
          instanceId: 'test-coordinator',
          targetStream: 'stream:execution-requests',
        }),
      );
    });

    it('should include serialized opportunity data in DLQ entry', async () => {
      // Make execution xadd fail, but DLQ xadd succeed
      streamsClient.xadd.mockImplementation(async (stream: string) => {
        if (stream === 'stream:execution-requests') {
          throw new Error('Write failed');
        }
        return 'dlq-id-1';
      });

      const opp = createOpportunity({ id: 'opp-dlq-data', chain: 'polygon' });
      await router.forwardToExecutionEngine(opp);

      const dlqCall = streamsClient.xadd.mock.calls.find(
        call => call[0] === 'stream:forwarding-dlq',
      );
      expect(dlqCall).not.toBeUndefined();
      const dlqData = dlqCall![1] as Record<string, unknown>;
      const parsedOriginal = JSON.parse(dlqData.originalData as string);
      expect(parsedOriginal.id).toBe('opp-dlq-data');
      expect(parsedOriginal.chain).toBe('polygon');
    });

    it('should log error but not throw when DLQ write fails', async () => {
      // Both execution and DLQ writes fail
      streamsClient.xadd.mockRejectedValue(new Error('Total failure'));

      const opp = createOpportunity({ id: 'opp-dlq-fail' });

      // Should not throw
      await expect(
        router.forwardToExecutionEngine(opp),
      ).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to move opportunity to DLQ'),
        expect.objectContaining({ opportunityId: 'opp-dlq-fail' }),
      );
    });

    it('should send EXECUTION_FORWARD_FAILED alert when retries exhausted and circuit is not open', async () => {
      streamsClient.xadd.mockImplementation(async (stream: string) => {
        if (stream === 'stream:execution-requests') {
          throw new Error('Transient error');
        }
        return 'dlq-id';
      });
      circuitBreaker.getStatus.mockReturnValue({
        isOpen: false,
        failures: 2,
        resetTimeoutMs: 30000,
      });

      const alertCallback = jest.fn();
      const routerWithAlert = new OpportunityRouter(
        logger, circuitBreaker, streamsClient,
        { maxRetries: 3, retryBaseDelayMs: 1, instanceId: 'test-coordinator' },
        alertCallback,
      );

      const opp = createOpportunity({ id: 'opp-alert' });
      await routerWithAlert.forwardToExecutionEngine(opp);

      expect(alertCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'EXECUTION_FORWARD_FAILED',
          severity: 'high',
          data: expect.objectContaining({
            opportunityId: 'opp-alert',
            attempts: 3,
          }),
        }),
      );
    });

    it('should NOT send EXECUTION_FORWARD_FAILED alert when circuit is already open', async () => {
      streamsClient.xadd.mockRejectedValue(new Error('fail'));
      circuitBreaker.getStatus.mockReturnValue({
        isOpen: true,
        failures: 5,
        resetTimeoutMs: 30000,
      });

      const alertCallback = jest.fn();
      const routerWithAlert = new OpportunityRouter(
        logger, circuitBreaker, streamsClient,
        { maxRetries: 3, retryBaseDelayMs: 1, instanceId: 'test-coordinator' },
        alertCallback,
      );

      const opp = createOpportunity({ id: 'opp-no-alert' });
      await routerWithAlert.forwardToExecutionEngine(opp);

      // No EXECUTION_FORWARD_FAILED alert because circuit is open
      const forwardFailedAlerts = alertCallback.mock.calls.filter(
        call => call[0].type === 'EXECUTION_FORWARD_FAILED',
      );
      expect(forwardFailedAlerts).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Expiry Cleanup
  // ===========================================================================

  describe('cleanupExpiredOpportunities', () => {
    it('should remove opportunities that have explicitly expired (expiresAt < now)', async () => {
      const now = Date.now();
      await router.processOpportunity(
        createOpportunityData({ id: 'opp-expired', expiresAt: now - 1000, timestamp: now }),
        false,
      );
      await router.processOpportunity(
        createOpportunityData({ id: 'opp-fresh', expiresAt: now + 60000, timestamp: now }),
        false,
      );

      expect(router.getPendingCount()).toBe(2);

      const removed = router.cleanupExpiredOpportunities();

      expect(removed).toBe(1);
      expect(router.getPendingCount()).toBe(1);
      expect(router.getOpportunities().has('opp-expired')).toBe(false);
      expect(router.getOpportunities().has('opp-fresh')).toBe(true);
    });

    it('should remove opportunities older than TTL even without expiresAt', async () => {
      const now = Date.now();
      const oldTimestamp = now - 120000; // 120s ago, TTL is 60s

      await router.processOpportunity(
        createOpportunityData({ id: 'opp-old', timestamp: oldTimestamp }),
        false,
      );
      await router.processOpportunity(
        createOpportunityData({ id: 'opp-new', timestamp: now }),
        false,
      );

      const removed = router.cleanupExpiredOpportunities();

      expect(removed).toBe(1);
      expect(router.getOpportunities().has('opp-old')).toBe(false);
      expect(router.getOpportunities().has('opp-new')).toBe(true);
    });

    it('should return 0 when no opportunities have expired', async () => {
      const now = Date.now();
      await router.processOpportunity(
        createOpportunityData({ id: 'opp-ok', timestamp: now }),
        false,
      );

      const removed = router.cleanupExpiredOpportunities();

      expect(removed).toBe(0);
      expect(router.getPendingCount()).toBe(1);
    });

    it('should return 0 when there are no opportunities at all', () => {
      const removed = router.cleanupExpiredOpportunities();
      expect(removed).toBe(0);
    });

    it('should enforce maxOpportunities by removing oldest entries', async () => {
      const smallRouter = new OpportunityRouter(logger, circuitBreaker, streamsClient, {
        maxOpportunities: 3,
        opportunityTtlMs: 600000, // 10 min - won't expire during test
        duplicateWindowMs: 5000,
        retryBaseDelayMs: 1,
      });

      const now = Date.now();
      // Add 5 opportunities with distinct timestamps
      for (let i = 0; i < 5; i++) {
        await smallRouter.processOpportunity(
          createOpportunityData({
            id: `opp-size-${i}`,
            timestamp: now + i * 1000, // Increasing timestamps
          }),
          false,
        );
      }

      expect(smallRouter.getPendingCount()).toBe(5);

      const removed = smallRouter.cleanupExpiredOpportunities();

      expect(removed).toBe(2); // 5 - 3 = 2 oldest removed
      expect(smallRouter.getPendingCount()).toBe(3);

      // The 2 oldest (opp-size-0, opp-size-1) should be gone
      const remaining = smallRouter.getOpportunities();
      expect(remaining.has('opp-size-0')).toBe(false);
      expect(remaining.has('opp-size-1')).toBe(false);
      // The 3 newest should remain
      expect(remaining.has('opp-size-2')).toBe(true);
      expect(remaining.has('opp-size-3')).toBe(true);
      expect(remaining.has('opp-size-4')).toBe(true);
    });

    it('should log cleanup when opportunities were removed', async () => {
      const now = Date.now();
      await router.processOpportunity(
        createOpportunityData({ id: 'opp-to-clean', timestamp: now - 120000 }),
        false,
      );

      router.cleanupExpiredOpportunities();

      expect(logger.debug).toHaveBeenCalledWith(
        'Opportunity cleanup completed',
        expect.objectContaining({
          removed: 1,
          remaining: 0,
        }),
      );
    });
  });

  // ===========================================================================
  // Shutdown
  // ===========================================================================

  describe('shutdown', () => {
    it('should abort retry loop when shutdown is called', async () => {
      // Make xadd fail and use longer delays to ensure shutdown interrupts
      streamsClient.xadd.mockRejectedValue(new Error('Fail'));

      const slowRouter = new OpportunityRouter(logger, circuitBreaker, streamsClient, {
        maxRetries: 5,
        retryBaseDelayMs: 100,
        instanceId: 'test-coordinator',
      });

      // Start forwarding in background
      const opp = createOpportunity({ id: 'opp-shutdown' });
      const forwardPromise = slowRouter.forwardToExecutionEngine(opp);

      // Yield to let forwarding start, then signal shutdown
      await Promise.resolve();
      await Promise.resolve();
      slowRouter.shutdown();

      await forwardPromise;

      // Should have been stopped early (fewer than maxRetries attempts)
      expect(streamsClient.xadd.mock.calls.filter(
        c => c[0] === 'stream:execution-requests',
      ).length).toBeLessThan(5);
    });
  });

  // ===========================================================================
  // Stats and Monitoring
  // ===========================================================================

  describe('stats and monitoring', () => {
    it('should track total opportunities count', async () => {
      expect(router.getTotalOpportunities()).toBe(0);

      await router.processOpportunity(createOpportunityData({ id: 'opp-s1' }), false);
      await router.processOpportunity(createOpportunityData({ id: 'opp-s2' }), false);
      await router.processOpportunity(createOpportunityData({ id: 'opp-s3' }), false);

      expect(router.getTotalOpportunities()).toBe(3);
    });

    it('should track total executions count', async () => {
      expect(router.getTotalExecutions()).toBe(0);

      await router.processOpportunity(
        createOpportunityData({ id: 'opp-e1', status: 'pending' }),
        true,
      );
      await router.processOpportunity(
        createOpportunityData({ id: 'opp-e2', status: 'pending' }),
        true,
      );

      expect(router.getTotalExecutions()).toBe(2);
    });

    it('should track dropped opportunities count', async () => {
      circuitBreaker.isCurrentlyOpen.mockReturnValue(true);
      circuitBreaker.getFailures.mockReturnValue(3);

      expect(router.getOpportunitiesDropped()).toBe(0);

      const opp1 = createOpportunity({ id: 'opp-d1' });
      const opp2 = createOpportunity({ id: 'opp-d2' });

      await router.forwardToExecutionEngine(opp1);
      await router.forwardToExecutionEngine(opp2);

      expect(router.getOpportunitiesDropped()).toBe(2);
    });

    it('should return a copy of opportunities map (not a mutable reference)', async () => {
      await router.processOpportunity(
        createOpportunityData({ id: 'opp-copy' }),
        false,
      );

      const snapshot = router.getOpportunities();

      // ReadonlyMap — callers cannot mutate the internal map
      expect(snapshot.has('opp-copy')).toBe(true);
      expect(snapshot.size).toBe(1);
      expect(router.getPendingCount()).toBe(1);
    });
  });

  // ===========================================================================
  // Reset
  // ===========================================================================

  describe('reset', () => {
    it('should clear all state and counters', async () => {
      // Build up some state
      await router.processOpportunity(
        createOpportunityData({ id: 'opp-r1', status: 'pending' }),
        true,
      );
      circuitBreaker.isCurrentlyOpen.mockReturnValue(true);
      circuitBreaker.getFailures.mockReturnValue(1);
      await router.forwardToExecutionEngine(createOpportunity({ id: 'opp-dropped' }));

      expect(router.getPendingCount()).toBeGreaterThan(0);
      expect(router.getTotalOpportunities()).toBeGreaterThan(0);
      expect(router.getTotalExecutions()).toBeGreaterThan(0);
      expect(router.getOpportunitiesDropped()).toBeGreaterThan(0);

      router.reset();

      expect(router.getPendingCount()).toBe(0);
      expect(router.getTotalOpportunities()).toBe(0);
      expect(router.getTotalExecutions()).toBe(0);
      expect(router.getOpportunitiesDropped()).toBe(0);
      expect(router.getOpportunities().size).toBe(0);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle concurrent add operations without data corruption', async () => {
      const promises: Promise<boolean>[] = [];
      for (let i = 0; i < 50; i++) {
        promises.push(
          router.processOpportunity(
            createOpportunityData({ id: `opp-concurrent-${i}`, status: 'pending' }),
            false,
          ),
        );
      }

      const results = await Promise.all(promises);

      const acceptedCount = results.filter(r => r).length;
      expect(acceptedCount).toBe(50);
      expect(router.getPendingCount()).toBe(50);
      expect(router.getTotalOpportunities()).toBe(50);
    });

    it('should construct with default config when no config is provided', () => {
      const defaultRouter = new OpportunityRouter(logger, circuitBreaker);

      // Should not throw and should have sensible defaults
      expect(defaultRouter.getPendingCount()).toBe(0);
      expect(defaultRouter.getTotalOpportunities()).toBe(0);
    });

    it('should construct without streams client (undefined)', async () => {
      const noStreamRouter = new OpportunityRouter(logger, circuitBreaker);
      const opp = createOpportunity({ id: 'opp-no-stream' });

      await noStreamRouter.forwardToExecutionEngine(opp);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('streams client not initialized'),
        expect.any(Object),
      );
      expect(noStreamRouter.getTotalExecutions()).toBe(0);
    });

    it('should handle a profit percentage of exactly zero (valid)', async () => {
      const data = createOpportunityData({
        id: 'opp-zero-profit',
        profitPercentage: 0,
      });

      const result = await router.processOpportunity(data, false);

      expect(result).toBe(true);
      const opp = router.getOpportunities().get('opp-zero-profit')!;
      expect(opp.profitPercentage).toBe(0);
    });

    it('should handle profit percentage at exact boundaries', async () => {
      const dataMin = createOpportunityData({
        id: 'opp-min-boundary',
        profitPercentage: -100,
      });
      const dataMax = createOpportunityData({
        id: 'opp-max-boundary',
        profitPercentage: 10000,
      });

      expect(await router.processOpportunity(dataMin, false)).toBe(true);
      expect(await router.processOpportunity(dataMax, false)).toBe(true);
    });

    // M10 FIX: Test with realistic production profit ranges (typical DEX arb: -0.5% to 15%)
    it('should accept opportunities with realistic production profit values', async () => {
      const realisticProfits = [0.3, 0.5, 1.2, 2.5, 5.0, 8.0, 12.0, 15.0];
      for (let i = 0; i < realisticProfits.length; i++) {
        const data = createOpportunityData({
          id: `opp-realistic-${i}`,
          profitPercentage: realisticProfits[i],
        });
        const result = await router.processOpportunity(data, false);
        expect(result).toBe(true);
      }
      expect(router.getTotalOpportunities()).toBe(realisticProfits.length);
    });

    it('should use custom executionRequestsStream when configured', async () => {
      const customRouter = new OpportunityRouter(
        logger, circuitBreaker, streamsClient,
        { executionRequestsStream: 'stream:custom-exec', retryBaseDelayMs: 1 },
      );

      const opp = createOpportunity({ id: 'opp-custom-stream' });
      await customRouter.forwardToExecutionEngine(opp);

      // FIX W2-8: xadd now includes id and MAXLEN options
      expect(streamsClient.xadd).toHaveBeenCalledWith(
        'stream:custom-exec',
        expect.any(Object),
        '*',
        expect.objectContaining({ maxLen: 5000 }),
      );
    });

    it('should use custom dlqStream when configured', async () => {
      streamsClient.xadd.mockImplementation(async (stream: string) => {
        if (stream !== 'stream:custom-dlq') {
          throw new Error('fail');
        }
        return 'dlq-ok';
      });

      const customRouter = new OpportunityRouter(
        logger, circuitBreaker, streamsClient,
        { dlqStream: 'stream:custom-dlq', maxRetries: 1, retryBaseDelayMs: 1 },
      );

      const opp = createOpportunity({ id: 'opp-custom-dlq' });
      await customRouter.forwardToExecutionEngine(opp);

      expect(streamsClient.xadd).toHaveBeenCalledWith(
        'stream:custom-dlq',
        expect.objectContaining({ opportunityId: 'opp-custom-dlq' }),
      );
    });
  });
});
