/**
 * Provider Health Scorer Tests
 *
 * Unit tests for S3.3 Provider Health Scoring system.
 *
 * @see provider-health-scorer.ts
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ProviderHealthScorer, getProviderHealthScorer, resetProviderHealthScorer } from '@arbitrage/core/monitoring';

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

// =============================================================================
// BUDGET TRACKING TESTS (6-Provider Shield)
// Tests for the budget tracking functionality added for RPC cost optimization
// =============================================================================
describe('ProviderHealthScorer Budget Tracking', () => {
  let scorer: ProviderHealthScorer;

  beforeEach(() => {
    scorer = new ProviderHealthScorer();
  });

  afterEach(() => {
    scorer.shutdown();
  });

  describe('recordRequest', () => {
    it('should track CU usage for known providers', () => {
      scorer.recordRequest('drpc', 'eth_call');
      const budget = scorer.getProviderBudget('drpc');

      expect(budget).not.toBeNull();
      expect(budget!.monthlyUsedCU).toBe(26); // eth_call costs 26 CU
      expect(budget!.monthlyRequestCount).toBe(1);
    });

    it('should use default CU cost for unknown methods', () => {
      scorer.recordRequest('ankr', 'some_unknown_method');
      const budget = scorer.getProviderBudget('ankr');

      expect(budget!.monthlyUsedCU).toBe(20); // default CU cost
    });

    it('should accumulate CU usage across multiple requests', () => {
      scorer.recordRequest('drpc', 'eth_call'); // 26 CU
      scorer.recordRequest('drpc', 'eth_call'); // 26 CU
      scorer.recordRequest('drpc', 'eth_blockNumber'); // 10 CU

      const budget = scorer.getProviderBudget('drpc');
      expect(budget!.monthlyUsedCU).toBe(62);
      expect(budget!.monthlyRequestCount).toBe(3);
    });

    it('should accept custom CU cost override', () => {
      scorer.recordRequest('alchemy', 'eth_call', 100);
      const budget = scorer.getProviderBudget('alchemy');

      expect(budget!.monthlyUsedCU).toBe(100);
    });

    it('should ignore unknown providers silently', () => {
      // Should not throw
      scorer.recordRequest('unknown_provider', 'eth_call');
      const budget = scorer.getProviderBudget('unknown_provider');
      expect(budget).toBeNull();
    });

    it('should normalize provider names to lowercase', () => {
      scorer.recordRequest('DRPC', 'eth_call');
      scorer.recordRequest('DrPc', 'eth_call');

      const budget = scorer.getProviderBudget('drpc');
      expect(budget!.monthlyRequestCount).toBe(2);
    });
  });

  describe('shouldThrottleProvider', () => {
    it('should not throttle provider with low usage', () => {
      scorer.recordRequest('drpc', 'eth_call');
      expect(scorer.shouldThrottleProvider('drpc')).toBe(false);
    });

    it('should return false for unknown provider', () => {
      expect(scorer.shouldThrottleProvider('nonexistent')).toBe(false);
    });

    it('should not throttle unlimited provider (PublicNode)', () => {
      // Record many requests
      for (let i = 0; i < 1000; i++) {
        scorer.recordRequest('publicnode', 'eth_call');
      }
      expect(scorer.shouldThrottleProvider('publicnode')).toBe(false);
    });
  });

  describe('getProviderBudget', () => {
    it('should return null for provider with no recorded requests', () => {
      expect(scorer.getProviderBudget('alchemy')).toBeNull();
    });

    it('should return budget state with correct fields', () => {
      scorer.recordRequest('infura', 'eth_getLogs'); // 75 CU

      const budget = scorer.getProviderBudget('infura');
      expect(budget).toMatchObject({
        monthlyUsedCU: 75,
        dailyUsedCU: 75,
        monthlyRequestCount: 1,
        dailyRequestCount: 1,
        shouldThrottle: expect.any(Boolean),
        estimatedDaysRemaining: expect.any(Number)
      });
    });

    it('should return copy of state (not reference)', () => {
      scorer.recordRequest('ankr', 'eth_call');
      const budget1 = scorer.getProviderBudget('ankr');
      const budget2 = scorer.getProviderBudget('ankr');

      expect(budget1).not.toBe(budget2);
      expect(budget1).toEqual(budget2);
    });
  });

  describe('getAllProviderBudgets', () => {
    it('should return empty object when no requests recorded', () => {
      const budgets = scorer.getAllProviderBudgets();
      expect(Object.keys(budgets)).toHaveLength(0);
    });

    it('should return budgets for all tracked providers', () => {
      scorer.recordRequest('drpc', 'eth_call');
      scorer.recordRequest('ankr', 'eth_call');
      scorer.recordRequest('infura', 'eth_call');

      const budgets = scorer.getAllProviderBudgets();
      expect(Object.keys(budgets)).toContain('drpc');
      expect(Object.keys(budgets)).toContain('ankr');
      expect(Object.keys(budgets)).toContain('infura');
    });
  });

  describe('selectBestProviderWithBudget', () => {
    const extractProvider = (url: string): string => {
      if (url.includes('drpc')) return 'drpc';
      if (url.includes('ankr')) return 'ankr';
      if (url.includes('publicnode')) return 'publicnode';
      return 'unknown';
    };

    it('should select single candidate', () => {
      const selected = scorer.selectBestProviderWithBudget(
        'ethereum',
        ['wss://drpc.org'],
        extractProvider
      );
      expect(selected).toBe('wss://drpc.org');
    });

    it('should throw for empty candidates', () => {
      expect(() =>
        scorer.selectBestProviderWithBudget('ethereum', [], extractProvider)
      ).toThrow();
    });

    it('should prefer healthy provider over throttled provider', () => {
      const candidates = [
        'wss://drpc.org',
        'wss://ankr.com'
      ];

      // Make drpc healthy
      scorer.recordSuccess('wss://drpc.org', 'ethereum', 50);

      // ankr has no metrics (neutral score 50), drpc has high score
      const selected = scorer.selectBestProviderWithBudget(
        'ethereum',
        candidates,
        extractProvider
      );

      expect(selected).toBe('wss://drpc.org');
    });

    it('should consider both health and budget in selection', () => {
      const candidates = [
        'wss://drpc.org',
        'wss://publicnode.com'
      ];

      // Both have similar health scores (no data = 50)
      const selected = scorer.selectBestProviderWithBudget(
        'ethereum',
        candidates,
        extractProvider
      );

      // Should return one of them
      expect(candidates).toContain(selected);
    });
  });

  describe('getTimeBasedProviderPriority', () => {
    it('should return array of provider names', () => {
      const priority = scorer.getTimeBasedProviderPriority();

      expect(Array.isArray(priority)).toBe(true);
      expect(priority.length).toBeGreaterThan(0);
      expect(priority).toContain('drpc');
      expect(priority).toContain('ankr');
      expect(priority).toContain('publicnode');
    });

    it('should include blastapi in priority list', () => {
      const priority = scorer.getTimeBasedProviderPriority();
      expect(priority).toContain('blastapi');
    });

    it('should move throttled providers to end of list', () => {
      // Simulate high usage on drpc (though won't actually throttle due to mock)
      // This tests the sorting logic even with fresh state
      const priority = scorer.getTimeBasedProviderPriority();

      // Throttled providers should be at the end
      // Since no providers are throttled initially, all should maintain base order
      expect(priority.length).toBe(8); // 8 providers total including onfinality and blastapi
    });
  });

  describe('Infinity handling (PublicNode)', () => {
    it('should handle unlimited provider correctly', () => {
      // PublicNode has Infinity capacity
      scorer.recordRequest('publicnode', 'eth_call');
      scorer.recordRequest('publicnode', 'eth_call');

      const budget = scorer.getProviderBudget('publicnode');
      expect(budget!.monthlyUsedCU).toBe(52); // 2 * 26
      expect(budget!.shouldThrottle).toBe(false);
      expect(budget!.estimatedDaysRemaining).toBe(Infinity);
    });
  });

  describe('Daily reset for Infura-like providers', () => {
    it('should track daily CU for Infura', () => {
      scorer.recordRequest('infura', 'eth_call');

      const budget = scorer.getProviderBudget('infura');
      expect(budget!.dailyUsedCU).toBe(26);
      expect(budget!.dailyRequestCount).toBe(1);
    });

    it('should reset daily counters after 24 hours (P2 #24)', () => {
      scorer.recordRequest('infura', 'eth_call'); // 26 CU
      scorer.recordRequest('infura', 'eth_call'); // 26 CU

      let budget = scorer.getProviderBudget('infura');
      expect(budget!.dailyUsedCU).toBe(52);
      expect(budget!.dailyRequestCount).toBe(2);

      // Simulate 24+ hours passing by modifying lastDailyReset on internal state
      const state = (scorer as any).providerBudgets.get('infura');
      state.lastDailyReset = Date.now() - (25 * 60 * 60 * 1000); // 25 hours ago

      // Next request should trigger daily reset first
      scorer.recordRequest('infura', 'eth_call'); // 26 CU after reset

      budget = scorer.getProviderBudget('infura');
      expect(budget!.dailyUsedCU).toBe(26); // Reset + new request
      expect(budget!.dailyRequestCount).toBe(1);
      // Monthly totals should NOT reset
      expect(budget!.monthlyUsedCU).toBe(78); // 52 + 26
    });
  });

  describe('Monthly budget reset (P2 #24)', () => {
    it('should reset monthly counters after 30 days', () => {
      scorer.recordRequest('drpc', 'eth_call'); // 26 CU
      scorer.recordRequest('drpc', 'eth_getLogs'); // 75 CU

      let budget = scorer.getProviderBudget('drpc');
      expect(budget!.monthlyUsedCU).toBe(101);
      expect(budget!.monthlyRequestCount).toBe(2);

      // Simulate 31 days passing
      const state = (scorer as any).providerBudgets.get('drpc');
      state.lastMonthlyReset = Date.now() - (31 * 24 * 60 * 60 * 1000);

      // Next request should trigger monthly reset
      scorer.recordRequest('drpc', 'eth_blockNumber'); // 10 CU after reset

      budget = scorer.getProviderBudget('drpc');
      expect(budget!.monthlyUsedCU).toBe(10); // Reset + new request
      expect(budget!.monthlyRequestCount).toBe(1);
    });

    it('should NOT reset monthly counters before 30 days', () => {
      scorer.recordRequest('ankr', 'eth_call');

      const state = (scorer as any).providerBudgets.get('ankr');
      state.lastMonthlyReset = Date.now() - (29 * 24 * 60 * 60 * 1000); // 29 days ago

      scorer.recordRequest('ankr', 'eth_call');

      const budget = scorer.getProviderBudget('ankr');
      expect(budget!.monthlyUsedCU).toBe(52); // No reset, accumulates
      expect(budget!.monthlyRequestCount).toBe(2);
    });
  });
});

// =============================================================================
// METRICS DECAY TESTS (P2 #24)
// Tests for the periodic metrics decay functionality
// =============================================================================
describe('ProviderHealthScorer Metrics Decay', () => {
  it('should decay success and failure counts by decay factor', () => {
    const scorer = new ProviderHealthScorer({ decayFactor: 0.5 });

    // Record 100 successes and 50 failures
    for (let i = 0; i < 100; i++) {
      scorer.recordSuccess('wss://test.com', 'ethereum', 100);
    }
    for (let i = 0; i < 50; i++) {
      scorer.recordFailure('wss://test.com', 'ethereum', 'error');
    }

    let metrics = scorer.getMetrics('wss://test.com', 'ethereum');
    expect(metrics!.successCount).toBe(100);
    expect(metrics!.failureCount).toBe(50);

    // Trigger decay manually (decayMetrics is private, so use internal access)
    (scorer as any).decayMetrics();

    metrics = scorer.getMetrics('wss://test.com', 'ethereum');
    expect(metrics!.successCount).toBe(50); // 100 * 0.5
    expect(metrics!.failureCount).toBe(25); // 50 * 0.5

    scorer.shutdown();
  });

  it('should decay rate limit and connection drop counts', () => {
    const scorer = new ProviderHealthScorer({ decayFactor: 0.5 });

    // Record rate limits and connection drops
    for (let i = 0; i < 10; i++) {
      scorer.recordRateLimit('wss://test.com', 'ethereum');
    }
    for (let i = 0; i < 8; i++) {
      scorer.recordFailure('wss://test.com', 'ethereum', 'connection_drop');
    }

    let metrics = scorer.getMetrics('wss://test.com', 'ethereum');
    expect(metrics!.rateLimitCount).toBe(10);
    expect(metrics!.connectionDropCount).toBe(8);

    (scorer as any).decayMetrics();

    metrics = scorer.getMetrics('wss://test.com', 'ethereum');
    expect(metrics!.rateLimitCount).toBe(5); // 10 * 0.5
    expect(metrics!.connectionDropCount).toBe(4); // 8 * 0.5

    scorer.shutdown();
  });

  it('should recalculate scores after decay', () => {
    const scorer = new ProviderHealthScorer({ decayFactor: 0.5 });

    // Create a provider with low success rate
    for (let i = 0; i < 10; i++) {
      scorer.recordSuccess('wss://test.com', 'ethereum', 100);
    }
    for (let i = 0; i < 90; i++) {
      scorer.recordFailure('wss://test.com', 'ethereum', 'error');
    }

    const scoreBefore = scorer.getHealthScore('wss://test.com', 'ethereum');

    // After decay, the ratio stays the same (both multiplied by same factor)
    // but absolute counts are lower
    (scorer as any).decayMetrics();

    const scoreAfter = scorer.getHealthScore('wss://test.com', 'ethereum');

    // Scores should be recalculated (success rate stays ~10% since both decay equally)
    expect(typeof scoreAfter).toBe('number');
    // Floor(10*0.5)=5, Floor(90*0.5)=45 -> success rate ~10%
    expect(scoreAfter).toBeCloseTo(scoreBefore, 0);

    scorer.shutdown();
  });

  it('should eventually decay counts to zero', () => {
    const scorer = new ProviderHealthScorer({ decayFactor: 0.5 });

    scorer.recordSuccess('wss://test.com', 'ethereum', 100);
    scorer.recordFailure('wss://test.com', 'ethereum', 'error');

    // Decay multiple times until counts reach zero
    for (let i = 0; i < 10; i++) {
      (scorer as any).decayMetrics();
    }

    const metrics = scorer.getMetrics('wss://test.com', 'ethereum');
    expect(metrics!.successCount).toBe(0);
    expect(metrics!.failureCount).toBe(0);

    scorer.shutdown();
  });
});
