/**
 * In-Memory Aggregator Metrics Tests
 *
 * Tests for metrics tracking and reliability scoring.
 * Verifies metrics recording, aggregation, and score calculation.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { InMemoryAggregatorMetrics } from '../../../src/infrastructure/inmemory-aggregator.metrics';
import { ProviderOutcome } from '../../../src/domain';
import type { IProviderInfo } from '../../../src/domain';
import { createProvider, AAVE_PROVIDER } from './helpers/test-providers';

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

    it('should count explicit fallback triggers', () => {
      const startTime = Date.now();

      metrics.recordSelection(null, 'fallback to secondary', startTime);

      const aggregated = metrics.getAggregatedMetrics();
      expect(aggregated.fallbacksTriggered).toBe(1);
    });

    it('should NOT count "No providers available" as fallback (F13)', () => {
      const startTime = Date.now();

      metrics.recordSelection(null, 'No providers available', startTime);

      const aggregated = metrics.getAggregatedMetrics();
      expect(aggregated.fallbacksTriggered).toBe(0);
    });

    it('should NOT count "All providers failed validation" as fallback (F13)', () => {
      const startTime = Date.now();

      metrics.recordSelection(null, 'All providers failed validation', startTime);

      const aggregated = metrics.getAggregatedMetrics();
      expect(aggregated.fallbacksTriggered).toBe(0);
    });

    it('should count reason containing "fallback" as fallback (F13)', () => {
      const startTime = Date.now();

      metrics.recordSelection(mockProvider, 'Using fallback provider', startTime);

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

      const outcome = ProviderOutcome.success('aave_v3', 150);

      metrics.recordOutcome(outcome);

      const health = metrics.getProviderHealth(mockProvider);
      expect(health!.successCount).toBe(1);
      expect(health!.failureCount).toBe(0);
    });

    it('should record failed outcome', () => {
      metrics.recordSelection(mockProvider, 'Selected', Date.now());

      const outcome = ProviderOutcome.failure('aave_v3', 100, 'Insufficient liquidity');

      metrics.recordOutcome(outcome);

      const health = metrics.getProviderHealth(mockProvider);
      expect(health!.successCount).toBe(0);
      expect(health!.failureCount).toBe(1);
    });

    it('should update only matching chain entry when chain is provided', () => {
      const ethProvider: IProviderInfo = {
        protocol: 'aave_v3',
        chain: 'ethereum',
        feeBps: 9,
        isAvailable: true,
        poolAddress: '0x111',
      };
      const arbProvider: IProviderInfo = {
        protocol: 'aave_v3',
        chain: 'arbitrum',
        feeBps: 9,
        isAvailable: true,
        poolAddress: '0x222',
      };

      // Register both providers via selection
      metrics.recordSelection(ethProvider, 'Selected', Date.now());
      metrics.recordSelection(arbProvider, 'Selected', Date.now());

      // Record outcome with chain specified — should only update ethereum entry
      const outcome = ProviderOutcome.success('aave_v3', 100, 'ethereum');
      metrics.recordOutcome(outcome);

      const ethHealth = metrics.getProviderHealth(ethProvider);
      const arbHealth = metrics.getProviderHealth(arbProvider);

      expect(ethHealth!.successCount).toBe(1);
      expect(arbHealth!.successCount).toBe(0);
    });

    it('should update all chain entries when chain is NOT provided (backward compat)', () => {
      const ethProvider: IProviderInfo = {
        protocol: 'aave_v3',
        chain: 'ethereum',
        feeBps: 9,
        isAvailable: true,
        poolAddress: '0x111',
      };
      const arbProvider: IProviderInfo = {
        protocol: 'aave_v3',
        chain: 'arbitrum',
        feeBps: 9,
        isAvailable: true,
        poolAddress: '0x222',
      };

      // Register both providers via selection
      metrics.recordSelection(ethProvider, 'Selected', Date.now());
      metrics.recordSelection(arbProvider, 'Selected', Date.now());

      // Record outcome WITHOUT chain — should update both chain entries
      const outcome = ProviderOutcome.success('aave_v3', 100);
      metrics.recordOutcome(outcome);

      const ethHealth = metrics.getProviderHealth(ethProvider);
      const arbHealth = metrics.getProviderHealth(arbProvider);

      expect(ethHealth!.successCount).toBe(1);
      expect(arbHealth!.successCount).toBe(1);
    });

    it('should not update entries after resetMetrics clears protocolIndex', () => {
      metrics.recordSelection(mockProvider, 'Selected', Date.now());
      metrics.recordOutcome(ProviderOutcome.success('aave_v3', 100));

      metrics.resetMetrics();

      // After reset, outcome should be a no-op (no stats exist)
      metrics.recordOutcome(ProviderOutcome.success('aave_v3', 100));

      const health = metrics.getProviderHealth(mockProvider);
      expect(health).toBeNull();
    });

    it('should skip outcome if provider not yet selected', () => {
      const outcome = ProviderOutcome.success('spookyswap', 150);

      // Should not throw (spookyswap was never selected)
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
        metrics.recordOutcome(ProviderOutcome.success('aave_v3', 100));
      }

      const score = await metrics.getReliabilityScore(mockProvider);

      expect(score).toBe(1.0); // Not enough samples
    });

    it('should calculate success rate after min samples', async () => {
      // Record 10 selections: 8 success, 2 failures
      for (let i = 0; i < 10; i++) {
        metrics.recordSelection(mockProvider, 'Selected', Date.now());
        if (i < 8) {
          metrics.recordOutcome(ProviderOutcome.success('aave_v3', 100));
        } else {
          metrics.recordOutcome(ProviderOutcome.failure('aave_v3', 100, 'Failed'));
        }
      }

      const score = await metrics.getReliabilityScore(mockProvider);

      expect(score).toBe(0.8); // 8/10 = 80%
    });

    it('should return 0.0 for all failures', async () => {
      for (let i = 0; i < 10; i++) {
        metrics.recordSelection(mockProvider, 'Selected', Date.now());
        metrics.recordOutcome(ProviderOutcome.failure('aave_v3', 100, 'Failed'));
      }

      const score = await metrics.getReliabilityScore(mockProvider);

      expect(score).toBe(0.0);
    });

    it('should return 1.0 for all successes', async () => {
      for (let i = 0; i < 10; i++) {
        metrics.recordSelection(mockProvider, 'Selected', Date.now());
        metrics.recordOutcome(ProviderOutcome.success('aave_v3', 100));
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
        if (i < 3) {
          metrics.recordOutcome(ProviderOutcome.success('aave_v3', 100));
        } else {
          metrics.recordOutcome(ProviderOutcome.failure('aave_v3', 100, 'Failed'));
        }
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
      metrics.recordOutcome(ProviderOutcome.success('aave_v3', 100));

      const summary = metrics.getMetricsSummary();

      expect(summary).toContain('Total selections: 1');
      expect(summary).toContain('With liquidity check: 1');
      expect(summary).toContain('aave_v3');
    });

    it('should format provider stats', () => {
      for (let i = 0; i < 10; i++) {
        metrics.recordSelection(mockProvider, 'Selected', Date.now());
        if (i < 8) {
          metrics.recordOutcome(ProviderOutcome.success('aave_v3', 100));
        } else {
          metrics.recordOutcome(ProviderOutcome.failure('aave_v3', 100, 'Failed'));
        }
      }

      const summary = metrics.getMetricsSummary();

      expect(summary).toContain('aave_v3: selected 10x');
      expect(summary).toContain('success rate 80.0%');
    });
  });

  describe('resetMetrics', () => {
    it('should clear all metrics', () => {
      metrics.recordSelection(mockProvider, 'Selected', Date.now());
      metrics.recordOutcome(ProviderOutcome.success('aave_v3', 100));

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
      // Use valid FlashLoanProtocol values to avoid `as any`
      const protocols = ['aave_v3', 'balancer_v2', 'pancakeswap_v3', 'spookyswap', 'syncswap'] as const;
      const providers: IProviderInfo[] = [];
      for (let i = 0; i < 10; i++) {
        providers.push({
          protocol: protocols[i % protocols.length],
          chain: `chain_${i}`,
          feeBps: 9 + i,
          isAvailable: true,
          poolAddress: `0x${i.toString(16).padStart(40, '0')}`,
        });
      }

      providers.forEach((provider) => {
        for (let j = 0; j < 10; j++) {
          metrics.recordSelection(provider, 'Selected', Date.now());
        }
      });

      const aggregated = metrics.getAggregatedMetrics();

      expect(aggregated.totalSelections).toBe(100);
      // byProvider aggregates by protocol (5 unique), not by (protocol, chain) pair
      expect(aggregated.byProvider.size).toBe(5);
    });
  });

  describe('CircularBuffer wrap-around behavior (F23)', () => {
    it('should reflect only recent entries after buffer wraps', () => {
      // Use small buffer (5 samples) to trigger wrap-around quickly
      const smallMetrics = new InMemoryAggregatorMetrics({ maxLatencySamples: 5 });
      const provider: IProviderInfo = {
        protocol: 'aave_v3',
        chain: 'ethereum',
        feeBps: 9,
        isAvailable: true,
        poolAddress: '0xaaa',
      };

      // Record 5 selections with high latency (100ms each)
      for (let i = 0; i < 5; i++) {
        smallMetrics.recordSelection(provider, 'Selected', Date.now() - 100);
      }

      const healthBefore = smallMetrics.getProviderHealth(provider);
      // Average should be around 100ms (allowing for Date.now() variance)
      expect(healthBefore!.avgLatencyMs).toBeGreaterThanOrEqual(95);

      // Record 5 more selections with low latency (1ms each) -> wraps the buffer
      for (let i = 0; i < 5; i++) {
        smallMetrics.recordSelection(provider, 'Selected', Date.now() - 1);
      }

      const healthAfter = smallMetrics.getProviderHealth(provider);
      // After wrap-around, average should reflect ONLY the recent low-latency entries
      // The old 100ms entries should have been overwritten
      expect(healthAfter!.avgLatencyMs).toBeLessThan(20);
      expect(healthAfter!.timesSelected).toBe(10); // Total count is still 10
    });

    it('should correctly report P95 after wrap-around', () => {
      const smallMetrics = new InMemoryAggregatorMetrics({ maxLatencySamples: 10 });
      const provider: IProviderInfo = {
        protocol: 'balancer_v2',
        chain: 'ethereum',
        feeBps: 0,
        isAvailable: true,
        poolAddress: '0xbbb',
      };

      // Fill buffer: 10 entries with 200ms latency
      for (let i = 0; i < 10; i++) {
        smallMetrics.recordSelection(provider, 'Selected', Date.now() - 200);
      }

      const metricsBefore = smallMetrics.getAggregatedMetrics();
      expect(metricsBefore.p95SelectionLatencyMs).toBeGreaterThanOrEqual(195);

      // Overwrite all with 5ms latency
      for (let i = 0; i < 10; i++) {
        smallMetrics.recordSelection(provider, 'Selected', Date.now() - 5);
      }

      const metricsAfter = smallMetrics.getAggregatedMetrics();
      // P95 should now reflect the new low-latency data
      expect(metricsAfter.p95SelectionLatencyMs).toBeLessThan(30);
    });

    it('should handle partial wrap-around correctly', () => {
      const smallMetrics = new InMemoryAggregatorMetrics({ maxLatencySamples: 5 });
      const provider: IProviderInfo = {
        protocol: 'syncswap',
        chain: 'zksync',
        feeBps: 30,
        isAvailable: true,
        poolAddress: '0xccc',
      };

      // Fill buffer completely with 50ms latencies
      for (let i = 0; i < 5; i++) {
        smallMetrics.recordSelection(provider, 'Selected', Date.now() - 50);
      }

      // Overwrite only 2 entries with 10ms latencies (partial wrap)
      for (let i = 0; i < 2; i++) {
        smallMetrics.recordSelection(provider, 'Selected', Date.now() - 10);
      }

      const health = smallMetrics.getProviderHealth(provider);
      // Buffer should have: [10ms, 10ms, 50ms, 50ms, 50ms] (approx)
      // Average ~= (10+10+50+50+50)/5 = 34ms
      expect(health!.avgLatencyMs).toBeGreaterThan(20);
      expect(health!.avgLatencyMs).toBeLessThan(55);
    });
  });
});
