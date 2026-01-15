/**
 * Provider Health Scorer Tests
 *
 * Unit tests for S3.3 Provider Health Scoring system.
 *
 * @see provider-health-scorer.ts
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  ProviderHealthScorer,
  getProviderHealthScorer,
  resetProviderHealthScorer
} from '@arbitrage/core';

describe('ProviderHealthScorer', () => {
  let scorer: ProviderHealthScorer;

  beforeEach(() => {
    scorer = new ProviderHealthScorer();
  });

  afterEach(() => {
    scorer.shutdown();
  });

  describe('Basic Operations', () => {
    it('should create empty metrics for new provider', () => {
      const metrics = scorer.getMetrics('wss://test.com', 'ethereum');
      expect(metrics).toBeNull();
    });

    it('should record success and create metrics', () => {
      scorer.recordSuccess('wss://test.com', 'ethereum', 100);

      const metrics = scorer.getMetrics('wss://test.com', 'ethereum');
      expect(metrics).not.toBeNull();
      expect(metrics!.successCount).toBe(1);
      expect(metrics!.avgLatencyMs).toBe(100);
    });

    it('should record multiple successes with latency tracking', () => {
      scorer.recordSuccess('wss://test.com', 'ethereum', 100);
      scorer.recordSuccess('wss://test.com', 'ethereum', 200);
      scorer.recordSuccess('wss://test.com', 'ethereum', 150);

      const metrics = scorer.getMetrics('wss://test.com', 'ethereum');
      expect(metrics!.successCount).toBe(3);
      expect(metrics!.avgLatencyMs).toBe(150); // (100+200+150)/3
    });

    it('should record failures', () => {
      scorer.recordSuccess('wss://test.com', 'ethereum', 100);
      scorer.recordFailure('wss://test.com', 'ethereum', 'connection_drop');

      const metrics = scorer.getMetrics('wss://test.com', 'ethereum');
      expect(metrics!.successCount).toBe(1);
      expect(metrics!.failureCount).toBe(1);
      expect(metrics!.connectionDropCount).toBe(1);
      expect(metrics!.successRate).toBe(0.5);
    });

    it('should record rate limits', () => {
      scorer.recordRateLimit('wss://test.com', 'ethereum');

      const metrics = scorer.getMetrics('wss://test.com', 'ethereum');
      expect(metrics!.rateLimitCount).toBe(1);
      expect(metrics!.failureCount).toBe(1);
    });

    it('should record block numbers', () => {
      scorer.recordBlock('wss://test.com', 'ethereum', 12345);

      const metrics = scorer.getMetrics('wss://test.com', 'ethereum');
      expect(metrics!.lastBlockNumber).toBe(12345);
      expect(metrics!.lastBlockTime).toBeGreaterThan(0);
    });
  });

  describe('Health Scoring', () => {
    it('should return default score for unknown provider', () => {
      const score = scorer.getHealthScore('wss://unknown.com', 'ethereum');
      expect(score).toBe(50);
    });

    it('should return high score for healthy provider', () => {
      // Record all successes with low latency
      for (let i = 0; i < 10; i++) {
        scorer.recordSuccess('wss://test.com', 'ethereum', 50);
      }
      // Record a recent block for freshness score
      scorer.recordBlock('wss://test.com', 'ethereum', 12345678);

      const score = scorer.getHealthScore('wss://test.com', 'ethereum');
      expect(score).toBeGreaterThan(80);
    });

    it('should return lower score for provider with failures', () => {
      scorer.recordSuccess('wss://test.com', 'ethereum', 100);
      scorer.recordFailure('wss://test.com', 'ethereum', 'error');
      scorer.recordFailure('wss://test.com', 'ethereum', 'error');

      const score = scorer.getHealthScore('wss://test.com', 'ethereum');
      // 1 success, 2 failures = 33% success rate
      expect(score).toBeLessThan(60);
    });

    it('should penalize high latency', () => {
      // Low latency provider
      scorer.recordSuccess('wss://fast.com', 'ethereum', 100);
      const fastScore = scorer.getHealthScore('wss://fast.com', 'ethereum');

      // High latency provider
      scorer.recordSuccess('wss://slow.com', 'ethereum', 1500);
      const slowScore = scorer.getHealthScore('wss://slow.com', 'ethereum');

      expect(fastScore).toBeGreaterThan(slowScore);
    });
  });

  describe('Provider Selection', () => {
    it('should select the only candidate when there is one', () => {
      const selected = scorer.selectBestProvider('ethereum', ['wss://only.com']);
      expect(selected).toBe('wss://only.com');
    });

    it('should select provider with best score', () => {
      // Make test1 healthy
      for (let i = 0; i < 10; i++) {
        scorer.recordSuccess('wss://test1.com', 'ethereum', 50);
      }

      // Make test2 have failures
      scorer.recordSuccess('wss://test2.com', 'ethereum', 100);
      scorer.recordFailure('wss://test2.com', 'ethereum', 'error');
      scorer.recordFailure('wss://test2.com', 'ethereum', 'error');

      const selected = scorer.selectBestProvider('ethereum', [
        'wss://test1.com',
        'wss://test2.com'
      ]);

      expect(selected).toBe('wss://test1.com');
    });

    it('should throw error for empty candidates', () => {
      expect(() => scorer.selectBestProvider('ethereum', [])).toThrow();
    });

    it('should rank providers correctly', () => {
      scorer.recordSuccess('wss://best.com', 'ethereum', 50);
      scorer.recordSuccess('wss://best.com', 'ethereum', 50);

      scorer.recordSuccess('wss://mid.com', 'ethereum', 500);

      scorer.recordSuccess('wss://worst.com', 'ethereum', 100);
      scorer.recordFailure('wss://worst.com', 'ethereum', 'error');

      const ranked = scorer.getRankedProviders('ethereum', [
        'wss://worst.com',
        'wss://mid.com',
        'wss://best.com'
      ]);

      expect(ranked[0]).toBe('wss://best.com');
    });
  });

  describe('Health Check', () => {
    it('should report healthy for unknown provider', () => {
      expect(scorer.isProviderHealthy('wss://unknown.com', 'ethereum')).toBe(true);
    });

    it('should report healthy for good provider', () => {
      for (let i = 0; i < 100; i++) {
        scorer.recordSuccess('wss://test.com', 'ethereum', 100);
      }

      expect(scorer.isProviderHealthy('wss://test.com', 'ethereum')).toBe(true);
    });

    it('should report unhealthy for provider with low success rate', () => {
      // 90 failures, 10 successes = 10% success rate
      for (let i = 0; i < 10; i++) {
        scorer.recordSuccess('wss://test.com', 'ethereum', 100);
      }
      for (let i = 0; i < 90; i++) {
        scorer.recordFailure('wss://test.com', 'ethereum', 'error');
      }

      expect(scorer.isProviderHealthy('wss://test.com', 'ethereum')).toBe(false);
    });
  });

  describe('Chain Metrics', () => {
    it('should return empty array for chain with no providers', () => {
      const metrics = scorer.getChainMetrics('unknown');
      expect(metrics).toHaveLength(0);
    });

    it('should return all providers for a chain', () => {
      scorer.recordSuccess('wss://test1.com', 'ethereum', 100);
      scorer.recordSuccess('wss://test2.com', 'ethereum', 100);
      scorer.recordSuccess('wss://test3.com', 'bsc', 100);

      const ethereumMetrics = scorer.getChainMetrics('ethereum');
      expect(ethereumMetrics).toHaveLength(2);

      const bscMetrics = scorer.getChainMetrics('bsc');
      expect(bscMetrics).toHaveLength(1);
    });

    it('should sort chain metrics by score (best first)', () => {
      scorer.recordSuccess('wss://test1.com', 'ethereum', 500);
      scorer.recordSuccess('wss://test2.com', 'ethereum', 50);

      const metrics = scorer.getChainMetrics('ethereum');
      expect(metrics[0].url).toBe('wss://test2.com'); // Lower latency = higher score
    });
  });

  describe('Block Tracking', () => {
    it('should track blocks behind', () => {
      // Provider 1 has latest block
      scorer.recordBlock('wss://test1.com', 'ethereum', 100);

      // Provider 2 is behind
      scorer.recordBlock('wss://test2.com', 'ethereum', 95);

      const metrics2 = scorer.getMetrics('wss://test2.com', 'ethereum');
      expect(metrics2!.blocksBehind).toBe(5);
    });
  });

  describe('Summary', () => {
    it('should return correct summary', () => {
      scorer.recordSuccess('wss://test1.com', 'ethereum', 100);
      scorer.recordSuccess('wss://test2.com', 'ethereum', 100);
      scorer.recordSuccess('wss://test3.com', 'bsc', 100);

      const summary = scorer.getSummary();
      expect(summary.totalProviders).toBe(3);
      expect(summary.providersByChain['ethereum']).toBe(2);
      expect(summary.providersByChain['bsc']).toBe(1);
    });
  });

  describe('Clear and Shutdown', () => {
    it('should clear all metrics', () => {
      scorer.recordSuccess('wss://test.com', 'ethereum', 100);
      expect(scorer.getMetrics('wss://test.com', 'ethereum')).not.toBeNull();

      scorer.clear();
      expect(scorer.getMetrics('wss://test.com', 'ethereum')).toBeNull();
    });
  });
});

describe('ProviderHealthScorer Singleton', () => {
  afterEach(() => {
    resetProviderHealthScorer();
  });

  it('should return same instance', () => {
    const instance1 = getProviderHealthScorer();
    const instance2 = getProviderHealthScorer();
    expect(instance1).toBe(instance2);
  });

  it('should reset instance', () => {
    const instance1 = getProviderHealthScorer();
    instance1.recordSuccess('wss://test.com', 'ethereum', 100);

    resetProviderHealthScorer();

    const instance2 = getProviderHealthScorer();
    expect(instance2).not.toBe(instance1);
    expect(instance2.getMetrics('wss://test.com', 'ethereum')).toBeNull();
  });
});
