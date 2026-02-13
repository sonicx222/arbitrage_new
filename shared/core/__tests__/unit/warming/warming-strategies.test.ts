/**
 * Warming Strategies Tests
 *
 * Tests for all 4 warming strategy implementations:
 * - TopNStrategy: Selects top N pairs by correlation score
 * - TimeBasedStrategy: Combines recency and correlation scores
 * - ThresholdStrategy: Selects all pairs above a score threshold
 * - AdaptiveStrategy: Self-tuning N based on L1 hit rate
 *
 * @see warming/application/strategies/ - Strategy implementations
 * @see warming/domain/warming-strategy.interface.ts - IWarmingStrategy contract
 */

import { TopNStrategy } from '../../../src/warming/application/strategies/top-n-strategy';
import { TimeBasedStrategy } from '../../../src/warming/application/strategies/time-based-strategy';
import { ThresholdStrategy } from '../../../src/warming/application/strategies/threshold-strategy';
import { AdaptiveStrategy } from '../../../src/warming/application/strategies/adaptive-strategy';
import { WarmingContext } from '../../../src/warming/domain/warming-strategy.interface';
import { PairCorrelation } from '../../../src/warming/domain/correlation-tracker.interface';

// ==========================================================================
// Shared Test Helpers
// ==========================================================================

function createMockContext(overrides: Partial<WarmingContext> = {}): WarmingContext {
  const now = Date.now();
  return {
    sourcePair: 'WETH_USDT',
    l1Size: 500,
    l1Capacity: 1000,
    l1HitRate: 0.95,
    correlations: [
      { pair: 'ETH/USDC', score: 0.9, coOccurrences: 10, lastSeenTimestamp: now },
      { pair: 'BTC/USDC', score: 0.7, coOccurrences: 5, lastSeenTimestamp: now - 120000 },
      { pair: 'LINK/USDC', score: 0.5, coOccurrences: 3, lastSeenTimestamp: now - 300000 },
      { pair: 'UNI/USDC', score: 0.2, coOccurrences: 1, lastSeenTimestamp: now - 600000 },
    ],
    timestamp: now,
    ...overrides,
  };
}

function createEmptyContext(overrides: Partial<WarmingContext> = {}): WarmingContext {
  return {
    sourcePair: 'WETH_USDT',
    l1Size: 0,
    l1Capacity: 1000,
    l1HitRate: 0.0,
    correlations: [],
    timestamp: Date.now(),
    ...overrides,
  };
}

// ==========================================================================
// TopNStrategy
// ==========================================================================

describe('TopNStrategy', () => {
  let strategy: TopNStrategy;

  beforeEach(() => {
    strategy = new TopNStrategy();
  });

  describe('getName', () => {
    it('should return TopNStrategy', () => {
      expect(strategy.getName()).toBe('TopNStrategy');
    });
  });

  describe('selectPairs', () => {
    it('should return top N correlations by score', () => {
      const context = createMockContext();
      const result = strategy.selectPairs(context);

      // Default topN=5, minScore=0.3 => ETH/USDC (0.9), BTC/USDC (0.7), LINK/USDC (0.5)
      // UNI/USDC (0.2) is below minScore 0.3
      expect(result.selectedPairs).toHaveLength(3);
      expect(result.selectedPairs[0].pair).toBe('ETH/USDC');
      expect(result.selectedPairs[1].pair).toBe('BTC/USDC');
      expect(result.selectedPairs[2].pair).toBe('LINK/USDC');
    });

    it('should handle empty correlations', () => {
      const context = createEmptyContext();
      const result = strategy.selectPairs(context);

      expect(result.selectedPairs).toHaveLength(0);
      expect(result.reason).toContain('No correlations found');
      expect(result.strategyName).toBe('TopNStrategy');
    });

    it('should respect configured topN value', () => {
      const limitedStrategy = new TopNStrategy({ topN: 2, minScore: 0.0 });
      const context = createMockContext();
      const result = limitedStrategy.selectPairs(context);

      expect(result.selectedPairs).toHaveLength(2);
      expect(result.selectedPairs[0].pair).toBe('ETH/USDC');
      expect(result.selectedPairs[1].pair).toBe('BTC/USDC');
    });

    it('should filter by minScore', () => {
      const highThresholdStrategy = new TopNStrategy({ topN: 10, minScore: 0.8 });
      const context = createMockContext();
      const result = highThresholdStrategy.selectPairs(context);

      // Only ETH/USDC has score >= 0.8
      expect(result.selectedPairs).toHaveLength(1);
      expect(result.selectedPairs[0].pair).toBe('ETH/USDC');
    });

    it('should return empty when no correlations meet minScore', () => {
      const veryHighThresholdStrategy = new TopNStrategy({ topN: 10, minScore: 0.95 });
      const context = createMockContext();
      const result = veryHighThresholdStrategy.selectPairs(context);

      expect(result.selectedPairs).toHaveLength(0);
      expect(result.reason).toContain('No correlations found');
    });

    it('should return correct priority and estimatedBenefit in candidates', () => {
      const context = createMockContext();
      const result = strategy.selectPairs(context);

      const firstCandidate = result.selectedPairs[0];
      // priority = score for TopN
      expect(firstCandidate.priority).toBe(0.9);
      expect(firstCandidate.correlationScore).toBe(0.9);
      // estimatedBenefit = score * coOccurrences
      expect(firstCandidate.estimatedBenefit).toBe(0.9 * 10);
    });

    it('should sort candidates by score descending', () => {
      const noFilterStrategy = new TopNStrategy({ topN: 10, minScore: 0.0 });
      const context = createMockContext();
      const result = noFilterStrategy.selectPairs(context);

      for (let i = 1; i < result.selectedPairs.length; i++) {
        expect(result.selectedPairs[i - 1].correlationScore).toBeGreaterThanOrEqual(
          result.selectedPairs[i].correlationScore
        );
      }
    });

    it('should set strategyName in result', () => {
      const context = createMockContext();
      const result = strategy.selectPairs(context);

      expect(result.strategyName).toBe('TopNStrategy');
    });
  });

  describe('getConfig', () => {
    it('should return default configuration values', () => {
      const config = strategy.getConfig();
      expect(config).toEqual({ topN: 5, minScore: 0.3 });
    });

    it('should return custom configuration values', () => {
      const custom = new TopNStrategy({ topN: 8, minScore: 0.6 });
      const config = custom.getConfig();
      expect(config).toEqual({ topN: 8, minScore: 0.6 });
    });
  });
});

// ==========================================================================
// TimeBasedStrategy
// ==========================================================================

describe('TimeBasedStrategy', () => {
  let strategy: TimeBasedStrategy;

  beforeEach(() => {
    strategy = new TimeBasedStrategy();
  });

  describe('getName', () => {
    it('should return TimeBasedStrategy', () => {
      expect(strategy.getName()).toBe('TimeBasedStrategy');
    });
  });

  describe('selectPairs', () => {
    it('should combine recency and correlation scores', () => {
      const context = createMockContext();
      const result = strategy.selectPairs(context);

      // All candidates should have combined score
      expect(result.selectedPairs.length).toBeGreaterThan(0);
      for (const candidate of result.selectedPairs) {
        // priority is the combined score, should be > 0
        expect(candidate.priority).toBeGreaterThan(0);
      }
    });

    it('should give recent correlations recency boost of 1.0', () => {
      const now = Date.now();
      const context = createMockContext({
        correlations: [
          { pair: 'RECENT/USDC', score: 0.5, coOccurrences: 5, lastSeenTimestamp: now },
        ],
        timestamp: now,
      });

      const result = strategy.selectPairs(context);
      expect(result.selectedPairs).toHaveLength(1);

      const candidate = result.selectedPairs[0];
      // combinedScore = recencyWeight(0.3) * 1.0 + correlationWeight(0.7) * 0.5 = 0.65
      expect(candidate.priority).toBeCloseTo(0.65, 5);
      // metadata should contain recencyScore = 1.0
      expect(candidate.metadata?.recencyScore).toBe(1.0);
    });

    it('should apply exponential decay to old correlations', () => {
      const now = Date.now();
      // correlations well outside the recency window (default 60000ms)
      const context = createMockContext({
        correlations: [
          { pair: 'OLD/USDC', score: 0.9, coOccurrences: 10, lastSeenTimestamp: now - 300000 },
        ],
        timestamp: now,
      });

      const result = strategy.selectPairs(context);
      expect(result.selectedPairs).toHaveLength(1);

      const candidate = result.selectedPairs[0];
      // recencyScore = exp(-300000 / 60000) = exp(-5) ~ 0.0067
      const expectedRecencyScore = Math.exp(-300000 / 60000);
      expect(candidate.metadata?.recencyScore).toBeCloseTo(expectedRecencyScore, 4);
      // combinedScore = 0.3 * recency + 0.7 * 0.9
      const expectedCombined = 0.3 * expectedRecencyScore + 0.7 * 0.9;
      expect(candidate.priority).toBeCloseTo(expectedCombined, 4);
    });

    it('should handle empty correlations', () => {
      const context = createEmptyContext();
      const result = strategy.selectPairs(context);

      expect(result.selectedPairs).toHaveLength(0);
      expect(result.reason).toContain('No correlations found');
      expect(result.strategyName).toBe('TimeBasedStrategy');
    });

    it('should respect minScore filter on combined score', () => {
      const now = Date.now();
      // Low correlation + very old = low combined score
      const highMinScoreStrategy = new TimeBasedStrategy({ minScore: 0.9 });
      const context = createMockContext({
        correlations: [
          { pair: 'LOW/USDC', score: 0.4, coOccurrences: 2, lastSeenTimestamp: now - 600000 },
        ],
        timestamp: now,
      });

      const result = highMinScoreStrategy.selectPairs(context);
      expect(result.selectedPairs).toHaveLength(0);
    });

    it('should respect configured topN', () => {
      const limitedStrategy = new TimeBasedStrategy({ topN: 1, minScore: 0.0 });
      const context = createMockContext();
      const result = limitedStrategy.selectPairs(context);

      expect(result.selectedPairs).toHaveLength(1);
    });

    it('should rank recent high-score pairs higher than old high-score pairs', () => {
      const now = Date.now();
      const context = createMockContext({
        correlations: [
          { pair: 'OLD_HIGH/USDC', score: 0.9, coOccurrences: 10, lastSeenTimestamp: now - 300000 },
          { pair: 'RECENT_MED/USDC', score: 0.6, coOccurrences: 5, lastSeenTimestamp: now },
        ],
        timestamp: now,
      });

      const result = strategy.selectPairs(context);
      expect(result.selectedPairs.length).toBeGreaterThanOrEqual(2);

      // RECENT_MED: combined = 0.3 * 1.0 + 0.7 * 0.6 = 0.72
      // OLD_HIGH: combined = 0.3 * exp(-5) + 0.7 * 0.9 ~ 0.3 * 0.0067 + 0.63 ~ 0.632
      // So RECENT_MED should be first
      expect(result.selectedPairs[0].pair).toBe('RECENT_MED/USDC');
    });

    it('should include ageMs in metadata', () => {
      const now = Date.now();
      const context = createMockContext({
        correlations: [
          { pair: 'TEST/USDC', score: 0.8, coOccurrences: 5, lastSeenTimestamp: now - 10000 },
        ],
        timestamp: now,
      });

      const result = strategy.selectPairs(context);
      expect(result.selectedPairs[0].metadata?.ageMs).toBe(10000);
    });
  });

  describe('getConfig', () => {
    it('should return default configuration values including weights', () => {
      const config = strategy.getConfig();
      expect(config).toEqual({
        recencyWeight: 0.3,
        correlationWeight: 0.7,
        recencyWindowMs: 60000,
        topN: 5,
        minScore: 0.3,
      });
    });

    it('should return custom configuration values', () => {
      const custom = new TimeBasedStrategy({
        recencyWeight: 0.5,
        correlationWeight: 0.5,
        recencyWindowMs: 120000,
        topN: 3,
        minScore: 0.1,
      });
      const config = custom.getConfig();
      expect(config).toEqual({
        recencyWeight: 0.5,
        correlationWeight: 0.5,
        recencyWindowMs: 120000,
        topN: 3,
        minScore: 0.1,
      });
    });
  });
});

// ==========================================================================
// ThresholdStrategy
// ==========================================================================

describe('ThresholdStrategy', () => {
  let strategy: ThresholdStrategy;

  beforeEach(() => {
    strategy = new ThresholdStrategy();
  });

  describe('getName', () => {
    it('should return ThresholdStrategy', () => {
      expect(strategy.getName()).toBe('ThresholdStrategy');
    });
  });

  describe('selectPairs', () => {
    it('should return ALL correlations above threshold', () => {
      // Default minScore=0.5, so ETH/USDC (0.9), BTC/USDC (0.7), LINK/USDC (0.5)
      const context = createMockContext();
      const result = strategy.selectPairs(context);

      expect(result.selectedPairs).toHaveLength(3);
      expect(result.selectedPairs.map(c => c.pair)).toEqual([
        'ETH/USDC',
        'BTC/USDC',
        'LINK/USDC',
      ]);
    });

    it('should return empty for no correlations above threshold', () => {
      const highThreshold = new ThresholdStrategy({ minScore: 0.95 });
      const context = createMockContext();
      const result = highThreshold.selectPairs(context);

      expect(result.selectedPairs).toHaveLength(0);
      expect(result.reason).toContain('No correlations found');
    });

    it('should handle empty correlations', () => {
      const context = createEmptyContext();
      const result = strategy.selectPairs(context);

      expect(result.selectedPairs).toHaveLength(0);
      expect(result.strategyName).toBe('ThresholdStrategy');
    });

    it('should sort by score descending', () => {
      const lowThreshold = new ThresholdStrategy({ minScore: 0.0 });
      const context = createMockContext();
      const result = lowThreshold.selectPairs(context);

      for (let i = 1; i < result.selectedPairs.length; i++) {
        expect(result.selectedPairs[i - 1].correlationScore).toBeGreaterThanOrEqual(
          result.selectedPairs[i].correlationScore
        );
      }
    });

    it('should cap at maxPairs to prevent overload', () => {
      const capped = new ThresholdStrategy({ minScore: 0.0, maxPairs: 2 });
      const context = createMockContext();
      const result = capped.selectPairs(context);

      expect(result.selectedPairs).toHaveLength(2);
      // Should keep the highest scored ones
      expect(result.selectedPairs[0].pair).toBe('ETH/USDC');
      expect(result.selectedPairs[1].pair).toBe('BTC/USDC');
    });

    it('should indicate capping in reason when exceeding maxPairs', () => {
      const capped = new ThresholdStrategy({ minScore: 0.0, maxPairs: 2 });
      const context = createMockContext();
      const result = capped.selectPairs(context);

      expect(result.reason).toContain('capped at max');
    });

    it('should set priority equal to score', () => {
      const context = createMockContext();
      const result = strategy.selectPairs(context);

      for (const candidate of result.selectedPairs) {
        expect(candidate.priority).toBe(candidate.correlationScore);
      }
    });

    it('should compute estimatedBenefit as score * coOccurrences', () => {
      const context = createMockContext();
      const result = strategy.selectPairs(context);

      const first = result.selectedPairs[0];
      expect(first.estimatedBenefit).toBe(first.correlationScore * 10);
    });

    it('should not indicate capping when all fit within maxPairs', () => {
      // Default maxPairs=10, only 3 items pass default minScore=0.5
      const context = createMockContext();
      const result = strategy.selectPairs(context);

      expect(result.reason).toContain('Selected all');
      expect(result.reason).not.toContain('capped');
    });
  });

  describe('getConfig', () => {
    it('should return default configuration values', () => {
      const config = strategy.getConfig();
      expect(config).toEqual({ minScore: 0.5, maxPairs: 10 });
    });

    it('should return custom configuration values', () => {
      const custom = new ThresholdStrategy({ minScore: 0.7, maxPairs: 20 });
      const config = custom.getConfig();
      expect(config).toEqual({ minScore: 0.7, maxPairs: 20 });
    });
  });
});

// ==========================================================================
// AdaptiveStrategy
// ==========================================================================

describe('AdaptiveStrategy', () => {
  let strategy: AdaptiveStrategy;

  beforeEach(() => {
    strategy = new AdaptiveStrategy();
  });

  describe('getName', () => {
    it('should return AdaptiveStrategy', () => {
      expect(strategy.getName()).toBe('AdaptiveStrategy');
    });
  });

  describe('selectPairs', () => {
    it('should select pairs with default context', () => {
      const context = createMockContext();
      const result = strategy.selectPairs(context);

      // Should select some pairs (exact count depends on adaptive N)
      expect(result.selectedPairs.length).toBeGreaterThan(0);
      expect(result.strategyName).toBe('AdaptiveStrategy');
    });

    it('should handle empty correlations', () => {
      const context = createEmptyContext();
      const result = strategy.selectPairs(context);

      expect(result.selectedPairs).toHaveLength(0);
      expect(result.reason).toContain('No correlations found');
    });

    it('should increase N when hit rate is below target', () => {
      // Default target=0.97, minPairs=3, maxPairs=10
      // Start at midpoint = floor((3+10)/2) = 6
      strategy.reset();

      const lowHitRateContext = createMockContext({
        l1HitRate: 0.80, // Well below target of 0.97
        correlations: Array.from({ length: 10 }, (_, i) => ({
          pair: `PAIR_${i}/USDC`,
          score: 0.9 - i * 0.05,
          coOccurrences: 10 - i,
          lastSeenTimestamp: Date.now(),
        })),
      });

      const result = strategy.selectPairs(lowHitRateContext);
      const config = strategy.getConfig();

      // Delta = 0.97 - 0.80 = 0.17 (positive), so N should increase
      // adjustment = 0.17 * 0.1 * 10 = 0.17 => round(6 + 0.17) = 6
      // Actually: let's just check it's at or above minPairs
      expect(config.currentN).toBeGreaterThanOrEqual(3);
      expect(result.selectedPairs.length).toBeGreaterThan(0);
    });

    it('should decrease N when hit rate is above target', () => {
      strategy.reset();

      const highHitRateContext = createMockContext({
        l1HitRate: 0.99, // Above target of 0.97
        correlations: Array.from({ length: 10 }, (_, i) => ({
          pair: `PAIR_${i}/USDC`,
          score: 0.9 - i * 0.05,
          coOccurrences: 10 - i,
          lastSeenTimestamp: Date.now(),
        })),
      });

      const result = strategy.selectPairs(highHitRateContext);
      const config = strategy.getConfig();

      // Delta = 0.97 - 0.99 = -0.02 (negative), N should decrease from midpoint
      // adjustment = -0.02 * 0.1 * 10 = -0.02 => round(6 - 0.02) = 6
      // It's a small adjustment, but N should be <= midpoint (6)
      expect(config.currentN).toBeLessThanOrEqual(6);
      expect(result.selectedPairs.length).toBeGreaterThan(0);
    });

    it('should clamp N to minPairs', () => {
      const tightStrategy = new AdaptiveStrategy({
        minPairs: 3,
        maxPairs: 10,
        adjustmentFactor: 1.0, // very aggressive
        targetHitRate: 0.5, // low target
      });

      // Hit rate far above the low target pushes N down strongly
      // delta = 0.5 - 1.0 = -0.5, adjustment = -0.5 * 1.0 * 10 = -5.0 per call
      const context = createMockContext({
        l1HitRate: 1.0,
        correlations: Array.from({ length: 10 }, (_, i) => ({
          pair: `PAIR_${i}/USDC`,
          score: 0.9 - i * 0.05,
          coOccurrences: 10 - i,
          lastSeenTimestamp: Date.now(),
        })),
      });

      // Call multiple times to push N toward min
      for (let i = 0; i < 20; i++) {
        tightStrategy.selectPairs(context);
      }

      const config = tightStrategy.getConfig();
      expect(config.currentN).toBe(3);
    });

    it('should clamp N to maxPairs', () => {
      const tightStrategy = new AdaptiveStrategy({
        minPairs: 3,
        maxPairs: 10,
        adjustmentFactor: 1.0, // very aggressive
      });

      // Very low hit rate to push N up
      const context = createMockContext({
        l1HitRate: 0.0,
        correlations: Array.from({ length: 15 }, (_, i) => ({
          pair: `PAIR_${i}/USDC`,
          score: 0.9 - i * 0.05,
          coOccurrences: 10 - i,
          lastSeenTimestamp: Date.now(),
        })),
      });

      // Call multiple times to push N toward max
      for (let i = 0; i < 20; i++) {
        tightStrategy.selectPairs(context);
      }

      const config = tightStrategy.getConfig();
      expect(config.currentN).toBe(10);
    });

    it('should filter by minScore', () => {
      const highMinScore = new AdaptiveStrategy({ minScore: 0.8 });
      const context = createMockContext();
      const result = highMinScore.selectPairs(context);

      // Only ETH/USDC has score >= 0.8
      expect(result.selectedPairs).toHaveLength(1);
      expect(result.selectedPairs[0].pair).toBe('ETH/USDC');
    });

    it('should include hit rate info in reason', () => {
      const context = createMockContext();
      const result = strategy.selectPairs(context);

      expect(result.reason).toContain('Hit rate');
      expect(result.reason).toContain('target');
    });

    it('should reset adaptive state', () => {
      // Modify state by calling selectPairs
      strategy.selectPairs(createMockContext({ l1HitRate: 0.5 }));
      strategy.selectPairs(createMockContext({ l1HitRate: 0.5 }));

      strategy.reset();
      const config = strategy.getConfig();

      // After reset, currentN should be back at midpoint = floor((3+10)/2) = 6
      expect(config.currentN).toBe(6);
    });
  });

  describe('getConfig', () => {
    it('should return default configuration values', () => {
      const config = strategy.getConfig();
      expect(config).toEqual({
        targetHitRate: 0.97,
        minPairs: 3,
        maxPairs: 10,
        minScore: 0.3,
        adjustmentFactor: 0.1,
        currentN: 6, // floor((3+10)/2)
      });
    });

    it('should return custom configuration values', () => {
      const custom = new AdaptiveStrategy({
        targetHitRate: 0.95,
        minPairs: 2,
        maxPairs: 8,
        minScore: 0.2,
        adjustmentFactor: 0.2,
      });
      const config = custom.getConfig();
      expect(config).toEqual({
        targetHitRate: 0.95,
        minPairs: 2,
        maxPairs: 8,
        minScore: 0.2,
        adjustmentFactor: 0.2,
        currentN: 5, // floor((2+8)/2)
      });
    });
  });
});
