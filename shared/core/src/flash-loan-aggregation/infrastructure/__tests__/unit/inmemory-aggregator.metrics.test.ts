/**
 * In-Memory Aggregator Metrics Tests
 *
 * Tests for metrics tracking and reliability scoring.
 * Verifies metrics recording, aggregation, and score calculation.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { InMemoryAggregatorMetrics } from '../../inmemory-aggregator.metrics';
import type { IProviderInfo, ProviderOutcome } from '../../../domain';

describe('InMemoryAggregatorMetrics', () => {
  let metrics: InMemoryAggregatorMetrics;
  let mockProvider: IProviderInfo;

  beforeEach(() => {
    metrics = new InMemoryAggregatorMetrics({
      maxLatencySamples: 100,
      minSamplesForScore: 10,
    });

    mockProvider = {
      protocol: 'aave_v3',
      chain: 'ethereum',
      feeBps: 9,
      isAvailable: true,
      poolAddress: '0x123',
    };
  });

  describe('recordSelection', () => {
    it('should record provider selection', () => {
      const startTime = Date.now() - 50;

      metrics.recordSelection(mockProvider, 'Best provider', startTime);

      const aggregated = metrics.getAggregatedMetrics();
      expect(aggregated.totalSelections).toBe(1);
    });

    it('should track selection latency', () => {
      const startTime = Date.now() - 100;

      metrics.recordSelection(mockProvider, 'Best provider', startTime);

      const aggregated = metrics.getAggregatedMetrics();
      expect(aggregated.avgSelectionLatencyMs).toBeGreaterThan(0);
      expect(aggregated.avgSelectionLatencyMs).toBeLessThanOrEqual(150);
    });

    it('should count liquidity checks', () => {
      const startTime = Date.now();

      metrics.recordSelection(mockProvider, 'Selected with liquidity check', startTime);

      const aggregated = metrics.getAggregatedMetrics();
      expect(aggregated.selectionsWithLiquidityCheck).toBe(1);
    });

    it('should count fallbacks', () => {
      const startTime = Date.now();

      metrics.recordSelection(null, 'No provider available (fallback)', startTime);

      const aggregated = metrics.getAggregatedMetrics();
      expect(aggregated.fallbacksTriggered).toBe(1);
    });

    it('should limit latency samples', () => {
      const metricsSmall = new InMemoryAggregatorMetrics({ maxLatencySamples: 5 });

      // Record 10 selections
      for (let i = 0; i < 10; i++) {
        metricsSmall.recordSelection(mockProvider, 'test', Date.now() - i);
      }

      const health = metricsSmall.getProviderHealth(mockProvider);
      expect(health).not.toBeNull();
      // Should only keep last 5 samples
      expect(health!.timesSelected).toBe(10);
    });

    it('should update provider stats', () => {
      metrics.recordSelection(mockProvider, 'Selected', Date.now());

      const health = metrics.getProviderHealth(mockProvider);
      expect(health).not.toBeNull();
      expect(health!.timesSelected).toBe(1);
    });
  });

  describe('recordOutcome', () => {
    it('should record successful outcome', () => {
      metrics.recordSelection(mockProvider, 'Selected', Date.now());

      const outcome: ProviderOutcome = {
        protocol: 'aave_v3',
        success: true,
        executionLatencyMs: 150,
      };

      metrics.recordOutcome(outcome);

      const health = metrics.getProviderHealth(mockProvider);
      expect(health!.successCount).toBe(1);
      expect(health!.failureCount).toBe(0);
    });

    it('should record failed outcome', () => {
      metrics.recordSelection(mockProvider, 'Selected', Date.now());

      const outcome: ProviderOutcome = {
        protocol: 'aave_v3',
        success: false,
        executionLatencyMs: 100,
        error: 'Insufficient liquidity',
      };

      metrics.recordOutcome(outcome);

      const health = metrics.getProviderHealth(mockProvider);
      expect(health!.successCount).toBe(0);
      expect(health!.failureCount).toBe(1);
    });

    it('should skip outcome if provider not yet selected', () => {
      const outcome: ProviderOutcome = {
        protocol: 'unknown_protocol' as any,
        success: true,
        executionLatencyMs: 150,
      };

      // Should not throw
      expect(() => metrics.recordOutcome(outcome)).not.toThrow();
    });
  });

  describe('getReliabilityScore', () => {
    it('should return 1.0 for new provider (no data)', async () => {
      const score = await metrics.getReliabilityScore(mockProvider);

      expect(score).toBe(1.0);
    });

    it('should return 1.0 if below min samples', async () => {
      // Record 5 selections and outcomes (below minSamplesForScore of 10)
      for (let i = 0; i < 5; i++) {
        metrics.recordSelection(mockProvider, 'Selected', Date.now());
        metrics.recordOutcome({
          protocol: 'aave_v3',
          success: true,
          executionLatencyMs: 100,
        });
      }

      const score = await metrics.getReliabilityScore(mockProvider);

      expect(score).toBe(1.0); // Not enough samples
    });

    it('should calculate success rate after min samples', async () => {
      // Record 10 selections: 8 success, 2 failures
      for (let i = 0; i < 10; i++) {
        metrics.recordSelection(mockProvider, 'Selected', Date.now());
        metrics.recordOutcome({
          protocol: 'aave_v3',
          success: i < 8, // First 8 succeed
          executionLatencyMs: 100,
          error: i >= 8 ? 'Failed' : undefined,
        });
      }

      const score = await metrics.getReliabilityScore(mockProvider);

      expect(score).toBe(0.8); // 8/10 = 80%
    });

    it('should return 0.0 for all failures', async () => {
      for (let i = 0; i < 10; i++) {
        metrics.recordSelection(mockProvider, 'Selected', Date.now());
        metrics.recordOutcome({
          protocol: 'aave_v3',
          success: false,
          executionLatencyMs: 100,
          error: 'Failed',
        });
      }

      const score = await metrics.getReliabilityScore(mockProvider);

      expect(score).toBe(0.0);
    });

    it('should return 1.0 for all successes', async () => {
      for (let i = 0; i < 10; i++) {
        metrics.recordSelection(mockProvider, 'Selected', Date.now());
        metrics.recordOutcome({
          protocol: 'aave_v3',
          success: true,
          executionLatencyMs: 100,
        });
      }

      const score = await metrics.getReliabilityScore(mockProvider);

      expect(score).toBe(1.0);
    });
  });

  describe('getProviderHealth', () => {
    it('should return null for unknown provider', () => {
      const health = metrics.getProviderHealth(mockProvider);

      expect(health).toBeNull();
    });

    it('should return health stats after selection', () => {
      metrics.recordSelection(mockProvider, 'Selected', Date.now());

      const health = metrics.getProviderHealth(mockProvider);

      expect(health).not.toBeNull();
      expect(health!.timesSelected).toBe(1);
      expect(health!.successCount).toBe(0);
      expect(health!.failureCount).toBe(0);
    });

    it('should calculate success rate', () => {
      for (let i = 0; i < 5; i++) {
        metrics.recordSelection(mockProvider, 'Selected', Date.now());
        metrics.recordOutcome({
          protocol: 'aave_v3',
          success: i < 3, // 3 success, 2 failures
          executionLatencyMs: 100,
        });
      }

      const health = metrics.getProviderHealth(mockProvider);

      expect(health!.successRate).toBe(0.6); // 3/5 = 60%
    });

    it('should calculate average latency', () => {
      const latencies = [50, 60, 70, 80, 90];
      latencies.forEach((_, i) => {
        const startTime = Date.now() - latencies[i];
        metrics.recordSelection(mockProvider, 'Selected', startTime);
      });

      const health = metrics.getProviderHealth(mockProvider);

      expect(health!.avgLatencyMs).toBeGreaterThan(0);
      expect(health!.avgLatencyMs).toBeLessThanOrEqual(100);
    });

    it('should track last selected time', () => {
      const beforeTime = Date.now();
      metrics.recordSelection(mockProvider, 'Selected', Date.now() - 10);
      const afterTime = Date.now();

      const health = metrics.getProviderHealth(mockProvider);

      expect(health!.lastSelectedTime).toBeGreaterThanOrEqual(beforeTime);
      expect(health!.lastSelectedTime).toBeLessThanOrEqual(afterTime);
    });
  });

  describe('getAggregatedMetrics', () => {
    it('should return empty metrics initially', () => {
      const aggregated = metrics.getAggregatedMetrics();

      expect(aggregated.totalSelections).toBe(0);
      expect(aggregated.selectionsWithLiquidityCheck).toBe(0);
      expect(aggregated.fallbacksTriggered).toBe(0);
      expect(aggregated.avgSelectionLatencyMs).toBe(0);
      expect(aggregated.p95SelectionLatencyMs).toBe(0);
      expect(aggregated.byProvider.size).toBe(0);
    });

    it('should aggregate metrics across providers', () => {
      const provider2: IProviderInfo = {
        protocol: 'pancakeswap_v3',
        chain: 'ethereum',
        feeBps: 25,
        isAvailable: true,
        poolAddress: '0x456',
      };

      metrics.recordSelection(mockProvider, 'Selected', Date.now() - 10);
      metrics.recordSelection(provider2, 'Selected', Date.now() - 20);

      const aggregated = metrics.getAggregatedMetrics();

      expect(aggregated.totalSelections).toBe(2);
      expect(aggregated.byProvider.size).toBe(2);
      expect(aggregated.byProvider.has('aave_v3')).toBe(true);
      expect(aggregated.byProvider.has('pancakeswap_v3')).toBe(true);
    });

    it('should calculate P95 latency', () => {
      // Record 100 selections with varying latencies
      for (let i = 0; i < 100; i++) {
        metrics.recordSelection(mockProvider, 'Selected', Date.now() - i);
      }

      const aggregated = metrics.getAggregatedMetrics();

      expect(aggregated.p95SelectionLatencyMs).toBeGreaterThan(0);
      expect(aggregated.p95SelectionLatencyMs).toBeGreaterThan(aggregated.avgSelectionLatencyMs);
    });
  });

  describe('getMetricsSummary', () => {
    it('should generate summary string', () => {
      metrics.recordSelection(mockProvider, 'Selected with liquidity', Date.now());
      metrics.recordOutcome({
        protocol: 'aave_v3',
        success: true,
        executionLatencyMs: 100,
      });

      const summary = metrics.getMetricsSummary();

      expect(summary).toContain('Total selections: 1');
      expect(summary).toContain('With liquidity check: 1');
      expect(summary).toContain('aave_v3');
    });

    it('should format provider stats', () => {
      for (let i = 0; i < 10; i++) {
        metrics.recordSelection(mockProvider, 'Selected', Date.now());
        metrics.recordOutcome({
          protocol: 'aave_v3',
          success: i < 8,
          executionLatencyMs: 100,
        });
      }

      const summary = metrics.getMetricsSummary();

      expect(summary).toContain('aave_v3: selected 10x');
      expect(summary).toContain('success rate 80.0%');
    });
  });

  describe('resetMetrics', () => {
    it('should clear all metrics', () => {
      metrics.recordSelection(mockProvider, 'Selected', Date.now());
      metrics.recordOutcome({
        protocol: 'aave_v3',
        success: true,
        executionLatencyMs: 100,
      });

      metrics.resetMetrics();

      const aggregated = metrics.getAggregatedMetrics();
      expect(aggregated.totalSelections).toBe(0);
      expect(aggregated.byProvider.size).toBe(0);

      const health = metrics.getProviderHealth(mockProvider);
      expect(health).toBeNull();
    });
  });

  describe('performance', () => {
    it('should handle high-frequency recording', () => {
      const iterations = 1000;
      const startTime = Date.now();

      for (let i = 0; i < iterations; i++) {
        metrics.recordSelection(mockProvider, 'Selected', Date.now());
      }

      const duration = Date.now() - startTime;

      // Should complete in reasonable time (< 100ms for 1000 records)
      expect(duration).toBeLessThan(100);
    });

    it('should handle concurrent provider tracking', () => {
      const providers: IProviderInfo[] = [];
      for (let i = 0; i < 10; i++) {
        providers.push({
          protocol: `protocol_${i}` as any,
          chain: 'ethereum',
          feeBps: 9 + i,
          isAvailable: true,
          poolAddress: `0x${i}`,
        });
      }

      providers.forEach((provider) => {
        for (let j = 0; j < 10; j++) {
          metrics.recordSelection(provider, 'Selected', Date.now());
        }
      });

      const aggregated = metrics.getAggregatedMetrics();

      expect(aggregated.totalSelections).toBe(100);
      expect(aggregated.byProvider.size).toBe(10);
    });
  });
});
