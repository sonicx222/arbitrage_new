/**
 * Unit tests for admission control in OpportunityRouter.processOpportunityBatch()
 *
 * Tests the admission gate that:
 * - Scores opportunities by expectedProfit × confidence × urgency
 * - Limits forwarding to top-K opportunities when under capacity pressure
 * - Explicitly logs shed (dropped) opportunities with scores
 * - Tracks admitted/shed metrics
 *
 * @see services/coordinator/src/opportunities/opportunity-router.ts
 * @see services/coordinator/src/opportunities/opportunity-scoring.ts
 * @see docs/reports/EXECUTION_BOTTLENECK_RESEARCH_2026-03-06.md — Phase 1
 */

import {
  OpportunityRouter,
} from '../../../src/opportunities/opportunity-router';
import { createMockLogger } from '@arbitrage/test-utils';
import type {
  OpportunityStreamsClient,
  CircuitBreaker,
  OpportunityRouterConfig,
} from '../../../src/opportunities/opportunity-router';
import { serializeOpportunityForStream } from '../../../src/utils/stream-serialization';

// =============================================================================
// Mock: serializeOpportunityForStream
// =============================================================================

jest.mock('../../../src/utils/stream-serialization', () => ({
  serializeOpportunityForStream: jest.fn(),
}));

const mockSerialize = serializeOpportunityForStream as jest.MockedFunction<typeof serializeOpportunityForStream>;

// =============================================================================
// Test Helpers
// =============================================================================

function createMockStreamsClient(): jest.Mocked<OpportunityStreamsClient> {
  return {
    xadd: jest.fn().mockResolvedValue('stream-id-1'),
    xaddWithLimit: jest.fn().mockResolvedValue('stream-id-1'),
  };
}

function createMockCircuitBreaker(): jest.Mocked<CircuitBreaker> {
  return {
    isCurrentlyOpen: jest.fn().mockReturnValue(false),
    recordFailure: jest.fn().mockReturnValue(false),
    recordSuccess: jest.fn().mockReturnValue(false),
    getFailures: jest.fn().mockReturnValue(0),
    getStatus: jest.fn().mockReturnValue({ isOpen: false, failures: 0, resetTimeoutMs: 60000 }),
  };
}

/** Creates a batch entry with realistic opportunity data */
function createBatchEntry(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const id = overrides.id ?? `opp-${now}-${Math.random().toString(36).substring(2, 8)}`;
  return {
    streamMessageId: `${now}-${Math.floor(Math.random() * 1000)}`,
    data: {
      id,
      chain: 'ethereum',
      buyDex: 'uniswap',
      sellDex: 'sushiswap',
      profitPercentage: 2.5,
      confidence: 0.85,
      expectedProfit: 0.5,
      timestamp: now,
      expiresAt: now + 30000,
      status: 'pending',
      tokenIn: '0xToken1',
      tokenOut: '0xToken2',
      ...overrides,
    },
  };
}

function createRouter(
  logger: ReturnType<typeof createMockLogger>,
  streamsClient: jest.Mocked<OpportunityStreamsClient>,
  circuitBreaker: jest.Mocked<CircuitBreaker>,
  configOverrides: Partial<OpportunityRouterConfig> = {},
) {
  return new OpportunityRouter(logger, circuitBreaker, streamsClient, {
    maxOpportunities: 100,
    opportunityTtlMs: 60000,
    duplicateWindowMs: 5000,
    instanceId: 'test-coordinator',
    maxRetries: 3,
    retryBaseDelayMs: 1,
    startupGracePeriodMs: 0,
    ...configOverrides,
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('OpportunityRouter - Admission Control', () => {
  let logger: ReturnType<typeof createMockLogger>;
  let streamsClient: jest.Mocked<OpportunityStreamsClient>;
  let circuitBreaker: jest.Mocked<CircuitBreaker>;
  let router: OpportunityRouter;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSerialize.mockReturnValue({ id: 'mock-serialized', forwardedBy: 'coordinator' });
    logger = createMockLogger();
    streamsClient = createMockStreamsClient();
    circuitBreaker = createMockCircuitBreaker();
  });

  afterEach(() => {
    router?.reset();
  });

  describe('with maxForwardPerBatch configured', () => {
    beforeEach(() => {
      router = createRouter(logger, streamsClient, circuitBreaker, {
        maxForwardPerBatch: 2,  // Only forward top 2 per batch
      });
    });

    it('should forward only the top-K highest-scored opportunities', async () => {
      const batch = [
        createBatchEntry({ id: 'low-profit', expectedProfit: 0.1, confidence: 0.5 }),
        createBatchEntry({ id: 'high-profit', expectedProfit: 5.0, confidence: 0.95 }),
        createBatchEntry({ id: 'med-profit', expectedProfit: 1.0, confidence: 0.8 }),
      ];

      // Each has different pair key to avoid dedup
      batch[0].data.buyDex = 'dex-a';
      batch[1].data.buyDex = 'dex-b';
      batch[2].data.buyDex = 'dex-c';

      const processedIds = await router.processOpportunityBatch(batch, true);

      // All stream messages should be ACKed (even shed ones)
      expect(processedIds).toHaveLength(3);

      // Only 2 should be forwarded (xaddWithLimit called)
      expect(streamsClient.xaddWithLimit).toHaveBeenCalledTimes(2);
    });

    it('should forward all when batch size <= maxForwardPerBatch', async () => {
      const batch = [
        createBatchEntry({ id: 'opp-1', buyDex: 'dex-a' }),
        createBatchEntry({ id: 'opp-2', buyDex: 'dex-b' }),
      ];

      await router.processOpportunityBatch(batch, true);

      // Both should be forwarded (2 <= maxForwardPerBatch of 2)
      expect(streamsClient.xaddWithLimit).toHaveBeenCalledTimes(2);
    });

    it('should track shed count in admission metrics', async () => {
      const batch = [
        createBatchEntry({ id: 'opp-a', expectedProfit: 0.1, buyDex: 'dex-a' }),
        createBatchEntry({ id: 'opp-b', expectedProfit: 5.0, buyDex: 'dex-b' }),
        createBatchEntry({ id: 'opp-c', expectedProfit: 1.0, buyDex: 'dex-c' }),
        createBatchEntry({ id: 'opp-d', expectedProfit: 0.05, buyDex: 'dex-d' }),
      ];

      await router.processOpportunityBatch(batch, true);

      const metrics = router.getAdmissionMetrics();
      // 4 opps deduped (all unique) → 4 candidates, maxForward=2, so 2 shed
      expect(metrics.admitted).toBe(2);
      expect(metrics.shed).toBe(2);
    });

    it('should log shed opportunities', async () => {
      const batch = [
        createBatchEntry({ id: 'keep', expectedProfit: 5.0, buyDex: 'dex-a' }),
        createBatchEntry({ id: 'shed-1', expectedProfit: 0.01, buyDex: 'dex-b' }),
        createBatchEntry({ id: 'shed-2', expectedProfit: 0.02, buyDex: 'dex-c' }),
      ];

      await router.processOpportunityBatch(batch, true);

      // Should log admission control info
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Admission control'),
        expect.objectContaining({
          admitted: expect.any(Number),
          shed: expect.any(Number),
        }),
      );
    });
  });

  describe('without maxForwardPerBatch (default: unlimited)', () => {
    beforeEach(() => {
      router = createRouter(logger, streamsClient, circuitBreaker);
    });

    it('should forward all opportunities when maxForwardPerBatch is 0 (disabled)', async () => {
      const batch = [
        createBatchEntry({ id: 'opp-1', buyDex: 'dex-a' }),
        createBatchEntry({ id: 'opp-2', buyDex: 'dex-b' }),
        createBatchEntry({ id: 'opp-3', buyDex: 'dex-c' }),
      ];

      await router.processOpportunityBatch(batch, true);

      expect(streamsClient.xaddWithLimit).toHaveBeenCalledTimes(3);
    });

    it('should not log admission control when all are forwarded', async () => {
      const batch = [
        createBatchEntry({ id: 'opp-1', buyDex: 'dex-a' }),
      ];

      await router.processOpportunityBatch(batch, true);

      // No admission control log (nothing shed)
      const admissionLogs = (logger.info as jest.Mock).mock.calls.filter(
        ([msg]: [string]) => typeof msg === 'string' && msg.includes('Admission control'),
      );
      expect(admissionLogs).toHaveLength(0);
    });
  });

  describe('dynamic admission budget via setExecutionStreamDepthRatio', () => {
    beforeEach(() => {
      router = createRouter(logger, streamsClient, circuitBreaker, {
        maxForwardPerBatch: 0,  // Start with unlimited
      });
    });

    it('should reduce forwarding when stream depth ratio is high', async () => {
      // Simulate stream at 60% capacity
      router.setExecutionStreamDepthRatio(0.6);

      const batch = Array.from({ length: 10 }, (_, i) =>
        createBatchEntry({
          id: `opp-${i}`,
          expectedProfit: (i + 1) * 0.1,
          buyDex: `dex-${i}`,
        }),
      );

      await router.processOpportunityBatch(batch, true);

      // With stream at 60%, should forward fewer than all 10
      // Exact number depends on budget calculation, but < 10
      expect(streamsClient.xaddWithLimit.mock.calls.length).toBeLessThan(10);
      expect(streamsClient.xaddWithLimit.mock.calls.length).toBeGreaterThan(0);
    });

    it('should forward all when stream depth ratio is low', async () => {
      router.setExecutionStreamDepthRatio(0.1);  // 10% full

      const batch = Array.from({ length: 5 }, (_, i) =>
        createBatchEntry({
          id: `opp-${i}`,
          buyDex: `dex-${i}`,
        }),
      );

      await router.processOpportunityBatch(batch, true);

      expect(streamsClient.xaddWithLimit).toHaveBeenCalledTimes(5);
    });

    it('should forward none when stream depth exceeds backpressure threshold', async () => {
      router.setExecutionStreamDepthRatio(0.95);  // Nearly full

      // Use 2+ entries so processOpportunityBatch takes the batch path
      // (batch.length === 1 takes a fast path that bypasses admission control)
      const batch = [
        createBatchEntry({ id: 'opp-1', buyDex: 'dex-a', expectedProfit: 100 }),
        createBatchEntry({ id: 'opp-2', buyDex: 'dex-b', expectedProfit: 50 }),
      ];

      await router.processOpportunityBatch(batch, true);

      // P2-003 FIX: Verify the opportunities were actually shed (not just non-negative)
      const metrics = router.getAdmissionMetrics();
      expect(metrics.shed).toBe(2);
      expect(metrics.admitted).toBe(0);
      // No forwarding should have occurred
      expect(streamsClient.xaddWithLimit).not.toHaveBeenCalled();
    });
  });

  describe('dynamic admission budget boundary values', () => {
    beforeEach(() => {
      router = createRouter(logger, streamsClient, circuitBreaker, {
        maxForwardPerBatch: 0,  // Dynamic budget mode
      });
    });

    it('should forward all at depth exactly 0.3 (upper bound of unlimited tier)', async () => {
      router.setExecutionStreamDepthRatio(0.3);

      const batch = Array.from({ length: 8 }, (_, i) =>
        createBatchEntry({ id: `opp-${i}`, expectedProfit: (i + 1) * 0.1, buyDex: `dex-${i}` }),
      );

      await router.processOpportunityBatch(batch, true);

      // depth <= 0.3 → unlimited (forward all)
      expect(streamsClient.xaddWithLimit).toHaveBeenCalledTimes(8);
    });

    it('should forward 75% at depth exactly 0.5 (upper bound of 75% tier)', async () => {
      router.setExecutionStreamDepthRatio(0.5);

      const batch = Array.from({ length: 8 }, (_, i) =>
        createBatchEntry({ id: `opp-${i}`, expectedProfit: (i + 1) * 0.1, buyDex: `dex-${i}` }),
      );

      await router.processOpportunityBatch(batch, true);

      // depth <= 0.5 → ceil(8 * 0.75) = 6
      expect(streamsClient.xaddWithLimit).toHaveBeenCalledTimes(6);
    });

    it('should forward 25% at depth exactly 0.7 (upper bound of 25% tier)', async () => {
      router.setExecutionStreamDepthRatio(0.7);

      const batch = Array.from({ length: 8 }, (_, i) =>
        createBatchEntry({ id: `opp-${i}`, expectedProfit: (i + 1) * 0.1, buyDex: `dex-${i}` }),
      );

      await router.processOpportunityBatch(batch, true);

      // depth <= 0.7 → ceil(8 * 0.25) = 2
      expect(streamsClient.xaddWithLimit).toHaveBeenCalledTimes(2);
    });

    it('should forward none at depth just above 0.7 (full backpressure)', async () => {
      router.setExecutionStreamDepthRatio(0.70001);

      const batch = Array.from({ length: 4 }, (_, i) =>
        createBatchEntry({ id: `opp-${i}`, expectedProfit: (i + 1) * 0.1, buyDex: `dex-${i}` }),
      );

      await router.processOpportunityBatch(batch, true);

      // depth > 0.7 → 0 (full backpressure)
      expect(streamsClient.xaddWithLimit).not.toHaveBeenCalled();
      const metrics = router.getAdmissionMetrics();
      expect(metrics.shed).toBe(4);
      expect(metrics.admitted).toBe(0);
    });
  });

  describe('scoring integration', () => {
    beforeEach(() => {
      router = createRouter(logger, streamsClient, circuitBreaker, {
        maxForwardPerBatch: 1,  // Only forward best opportunity
      });
    });

    it('should forward the highest-scored opportunity when limited to 1', async () => {
      const now = Date.now();
      const batch = [
        createBatchEntry({
          id: 'low', expectedProfit: 0.01, confidence: 0.3,
          buyDex: 'dex-a', expiresAt: now + 30000,
        }),
        createBatchEntry({
          id: 'high', expectedProfit: 10.0, confidence: 0.95,
          buyDex: 'dex-b', expiresAt: now + 5000,
        }),
        createBatchEntry({
          id: 'medium', expectedProfit: 1.0, confidence: 0.7,
          buyDex: 'dex-c', expiresAt: now + 15000,
        }),
      ];

      await router.processOpportunityBatch(batch, true);

      // Only 1 forwarded
      expect(streamsClient.xaddWithLimit).toHaveBeenCalledTimes(1);

      // The forwarded opp should be 'high' (highest score)
      // It was stored and forwarded — check it exists in the opportunities map
      expect(router.getOpportunities().has('high')).toBe(true);
    });

    it('should prefer urgent high-profit over slow low-profit', async () => {
      const now = Date.now();
      const batch = [
        createBatchEntry({
          id: 'slow-lowprofit', expectedProfit: 0.1, confidence: 0.5,
          buyDex: 'dex-a', expiresAt: now + 60000,
        }),
        createBatchEntry({
          id: 'urgent-highprofit', expectedProfit: 5.0, confidence: 0.9,
          buyDex: 'dex-b', expiresAt: now + 2000,
        }),
      ];

      await router.processOpportunityBatch(batch, true);

      expect(streamsClient.xaddWithLimit).toHaveBeenCalledTimes(1);
      // The urgent high-profit should be the one forwarded
      expect(router.getOpportunities().has('urgent-highprofit')).toBe(true);
    });
  });

  describe('admission metrics', () => {
    it('should accumulate admitted and shed counts across multiple batches', async () => {
      router = createRouter(logger, streamsClient, circuitBreaker, {
        maxForwardPerBatch: 1,
      });

      // Batch 1: 3 opps, 1 admitted, 2 shed
      const batch1 = [
        createBatchEntry({ id: 'b1-a', buyDex: 'dex-a', expectedProfit: 1 }),
        createBatchEntry({ id: 'b1-b', buyDex: 'dex-b', expectedProfit: 2 }),
        createBatchEntry({ id: 'b1-c', buyDex: 'dex-c', expectedProfit: 3 }),
      ];
      await router.processOpportunityBatch(batch1, true);

      // Batch 2: 2 opps, 1 admitted, 1 shed
      const batch2 = [
        createBatchEntry({ id: 'b2-a', buyDex: 'dex-d', expectedProfit: 4 }),
        createBatchEntry({ id: 'b2-b', buyDex: 'dex-e', expectedProfit: 5 }),
      ];
      await router.processOpportunityBatch(batch2, true);

      const metrics = router.getAdmissionMetrics();
      expect(metrics.admitted).toBe(2);  // 1 + 1
      expect(metrics.shed).toBe(3);  // 2 + 1
    });

    it('should track average scores for admitted and shed opportunities', async () => {
      router = createRouter(logger, streamsClient, circuitBreaker, {
        maxForwardPerBatch: 1,
      });

      const now = Date.now();
      const batch = [
        createBatchEntry({
          id: 'high', expectedProfit: 10.0, confidence: 0.9,
          buyDex: 'dex-a', expiresAt: now + 10000,
        }),
        createBatchEntry({
          id: 'low', expectedProfit: 0.1, confidence: 0.5,
          buyDex: 'dex-b', expiresAt: now + 10000,
        }),
      ];

      await router.processOpportunityBatch(batch, true);

      const metrics = router.getAdmissionMetrics();
      expect(metrics.avgScoreAdmitted).toBeGreaterThan(metrics.avgScoreShed);
      expect(metrics.avgScoreAdmitted).toBeGreaterThan(0);
      expect(metrics.avgScoreShed).toBeGreaterThanOrEqual(0);
    });

    it('should reset admission metrics when reset() is called', async () => {
      router = createRouter(logger, streamsClient, circuitBreaker, {
        maxForwardPerBatch: 1,
      });

      // Process a batch to accumulate metrics
      const batch = [
        createBatchEntry({ id: 'a', buyDex: 'dex-a', expectedProfit: 5 }),
        createBatchEntry({ id: 'b', buyDex: 'dex-b', expectedProfit: 1 }),
      ];
      await router.processOpportunityBatch(batch, true);

      const before = router.getAdmissionMetrics();
      expect(before.admitted).toBe(1);
      expect(before.shed).toBe(1);

      router.reset();

      const after = router.getAdmissionMetrics();
      expect(after.admitted).toBe(0);
      expect(after.shed).toBe(0);
      expect(after.avgScoreAdmitted).toBe(0);
      expect(after.avgScoreShed).toBe(0);
    });
  });

  describe('single-message batch backpressure', () => {
    it('should shed single-message batch when at full backpressure', async () => {
      router = createRouter(logger, streamsClient, circuitBreaker, {
        maxForwardPerBatch: 0,
      });
      router.setExecutionStreamDepthRatio(0.95);  // Full backpressure

      const batch = [
        createBatchEntry({ id: 'single-opp', buyDex: 'dex-a', expectedProfit: 100 }),
      ];

      const processedIds = await router.processOpportunityBatch(batch, true);

      // Message should still be ACKed (no PEL growth)
      expect(processedIds).toHaveLength(1);
      // But no forwarding should have occurred
      expect(streamsClient.xaddWithLimit).not.toHaveBeenCalled();
      // And shed should be tracked
      const metrics = router.getAdmissionMetrics();
      expect(metrics.shed).toBe(1);
      expect(metrics.admitted).toBe(0);
    });

    it('should forward single-message batch when below backpressure threshold', async () => {
      router = createRouter(logger, streamsClient, circuitBreaker, {
        maxForwardPerBatch: 0,
      });
      router.setExecutionStreamDepthRatio(0.1);  // Low depth

      const batch = [
        createBatchEntry({ id: 'single-opp', buyDex: 'dex-a' }),
      ];

      await router.processOpportunityBatch(batch, true);

      // Should be forwarded normally via processOpportunity
      expect(streamsClient.xaddWithLimit).toHaveBeenCalledTimes(1);
    });
  });

  describe('depth ratio edge cases', () => {
    beforeEach(() => {
      router = createRouter(logger, streamsClient, circuitBreaker, {
        maxForwardPerBatch: 0,
      });
    });

    it('should treat NaN depth as full backpressure (safe default)', async () => {
      router.setExecutionStreamDepthRatio(NaN);

      const batch = [
        createBatchEntry({ id: 'opp-1', buyDex: 'dex-a' }),
        createBatchEntry({ id: 'opp-2', buyDex: 'dex-b' }),
      ];

      await router.processOpportunityBatch(batch, true);

      // NaN fails all <= comparisons, so computeAdmissionBudget returns 0
      expect(streamsClient.xaddWithLimit).not.toHaveBeenCalled();
    });

    it('should treat negative depth as unlimited (no backpressure)', async () => {
      router.setExecutionStreamDepthRatio(-0.5);

      const batch = [
        createBatchEntry({ id: 'opp-1', buyDex: 'dex-a' }),
        createBatchEntry({ id: 'opp-2', buyDex: 'dex-b' }),
      ];

      await router.processOpportunityBatch(batch, true);

      // Negative passes depth <= 0.3, so all forwarded
      expect(streamsClient.xaddWithLimit).toHaveBeenCalledTimes(2);
    });
  });
});
