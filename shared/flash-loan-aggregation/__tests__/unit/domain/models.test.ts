/**
 * Domain Models Tests
 *
 * Tests for value objects following DDD principles.
 * Verifies immutability, validation, and factory methods.
 */

import { describe, it, expect } from '@jest/globals';
import {
  ProviderScore,
  LiquidityCheck,
  ProviderSelection,
  AggregatorConfig,
  ProviderOutcome,
} from '../../../src/domain/models';

describe('ProviderScore', () => {
  describe('constructor', () => {
    it('should create valid score', () => {
      const score = new ProviderScore(0.95, 0.9, 0.85, 0.8, 0.89);

      expect(score.feeScore).toBe(0.95);
      expect(score.liquidityScore).toBe(0.9);
      expect(score.reliabilityScore).toBe(0.85);
      expect(score.latencyScore).toBe(0.8);
      expect(score.totalScore).toBe(0.89);
    });

    it('should be immutable (frozen)', () => {
      const score = new ProviderScore(0.9, 0.8, 0.7, 0.6, 0.75);

      expect(Object.isFrozen(score)).toBe(true);
      expect(() => {
        (score as any).feeScore = 0.5;
      }).toThrow();
    });

    it('should reject scores < 0', () => {
      expect(() => new ProviderScore(-0.1, 0.9, 0.8, 0.7, 0.8)).toThrow(
        'Invalid score value: -0.1'
      );
    });

    it('should reject scores > 1', () => {
      expect(() => new ProviderScore(1.1, 0.9, 0.8, 0.7, 0.8)).toThrow(
        'Invalid score value: 1.1'
      );
    });

    it('should reject non-finite scores', () => {
      expect(() => new ProviderScore(NaN, 0.9, 0.8, 0.7, 0.8)).toThrow(
        'Invalid score value: NaN'
      );

      expect(() => new ProviderScore(Infinity, 0.9, 0.8, 0.7, 0.8)).toThrow(
        'Invalid score value: Infinity'
      );
    });
  });

  describe('fromComponents', () => {
    it('should create score from components with default weights', () => {
      const weights = {
        fees: 0.5,
        liquidity: 0.3,
        reliability: 0.15,
        latency: 0.05,
      };

      const score = ProviderScore.fromComponents(1.0, 1.0, 1.0, 1.0, weights);

      expect(score.feeScore).toBe(1.0);
      expect(score.liquidityScore).toBe(1.0);
      expect(score.reliabilityScore).toBe(1.0);
      expect(score.latencyScore).toBe(1.0);
      expect(score.totalScore).toBe(1.0);
    });

    it('should calculate weighted total score correctly', () => {
      const weights = {
        fees: 0.5,
        liquidity: 0.3,
        reliability: 0.15,
        latency: 0.05,
      };

      const score = ProviderScore.fromComponents(0.9, 0.8, 0.7, 0.6, weights);

      const expectedTotal = 0.9 * 0.5 + 0.8 * 0.3 + 0.7 * 0.15 + 0.6 * 0.05;
      expect(score.totalScore).toBeCloseTo(expectedTotal, 5);
    });

    it('should clamp totalScore to [0, 1] when weights sum > 1.0', () => {
      // Weights that sum > 1.0 could produce totalScore > 1.0 without clamping
      const weights = {
        fees: 0.6,
        liquidity: 0.5,
        reliability: 0.3,
        latency: 0.2,
      };

      const score = ProviderScore.fromComponents(1.0, 1.0, 1.0, 1.0, weights);

      // Without clamp, total would be 1.6; with clamp, should be 1.0
      expect(score.totalScore).toBe(1.0);
    });
  });

  describe('explain', () => {
    it('should explain high scores', () => {
      const score = new ProviderScore(0.95, 0.92, 0.91, 0.93, 0.94);
      const explanation = score.explain();

      expect(explanation).toContain('excellent fees');
      expect(explanation).toContain('high liquidity');
      expect(explanation).toContain('very reliable');
      expect(explanation).toContain('fast');
    });

    it('should show total score for mediocre scores', () => {
      const score = new ProviderScore(0.7, 0.6, 0.5, 0.4, 0.6);
      const explanation = score.explain();

      expect(explanation).toContain('total score: 60%');
    });

    it('should not include categories at exactly 0.9 (boundary)', () => {
      const score = new ProviderScore(0.9, 0.9, 0.9, 0.9, 0.9);
      const explanation = score.explain();

      // Exactly 0.9 should NOT be included (threshold is > 0.9, not >=)
      expect(explanation).toContain('total score: 90%');
    });
  });
});

describe('LiquidityCheck', () => {
  describe('constructor', () => {
    it('should create valid check', () => {
      const check = new LiquidityCheck(
        true,
        1000000n,
        900000n,
        true,
        50
      );

      expect(check.hasSufficientLiquidity).toBe(true);
      expect(check.availableLiquidity).toBe(1000000n);
      expect(check.requiredLiquidity).toBe(900000n);
      expect(check.checkPerformed).toBe(true);
      expect(check.checkLatencyMs).toBe(50);
    });

    it('should be immutable (frozen)', () => {
      const check = LiquidityCheck.success(1000n, 900n, 10);

      expect(Object.isFrozen(check)).toBe(true);
    });

    it('should reject negative available liquidity', () => {
      expect(() => new LiquidityCheck(true, -1n, 900n, true, 10)).toThrow(
        'Invalid available liquidity'
      );
    });

    it('should reject negative required liquidity', () => {
      expect(() => new LiquidityCheck(true, 1000n, -1n, true, 10)).toThrow(
        'Invalid required liquidity'
      );
    });

    it('should reject negative latency', () => {
      expect(() => new LiquidityCheck(true, 1000n, 900n, true, -1)).toThrow(
        'Invalid check latency'
      );
    });
  });

  describe('success', () => {
    it('should create successful check with sufficient liquidity', () => {
      const check = LiquidityCheck.success(1000000n, 900000n, 25);

      expect(check.hasSufficientLiquidity).toBe(true);
      expect(check.availableLiquidity).toBe(1000000n);
      expect(check.requiredLiquidity).toBe(900000n);
      expect(check.checkPerformed).toBe(true);
      expect(check.checkLatencyMs).toBe(25);
      expect(check.error).toBeUndefined();
    });

    it('should create check with insufficient liquidity', () => {
      const check = LiquidityCheck.success(800000n, 900000n, 25);

      expect(check.hasSufficientLiquidity).toBe(false);
      expect(check.availableLiquidity).toBe(800000n);
      expect(check.requiredLiquidity).toBe(900000n);
    });

    it('should treat equal amounts as sufficient (boundary)', () => {
      const check = LiquidityCheck.success(1000000n, 1000000n, 10);

      expect(check.hasSufficientLiquidity).toBe(true);
      expect(check.availableLiquidity).toBe(1000000n);
      expect(check.requiredLiquidity).toBe(1000000n);
    });
  });

  describe('failure', () => {
    it('should create failed check with conservative assumptions (I1 fix)', () => {
      const check = LiquidityCheck.failure('RPC timeout', 5000);

      // I1 Fix: Changed from true to false for semantic consistency
      // When check fails, conservatively assume insufficient rather than sufficient
      expect(check.hasSufficientLiquidity).toBe(false); // Conservative: assume insufficient
      expect(check.checkPerformed).toBe(false);
      expect(check.error).toBe('RPC timeout');
      expect(check.checkLatencyMs).toBe(5000);
    });
  });

  describe('skipped', () => {
    it('should create skipped check', () => {
      const check = LiquidityCheck.skipped();

      expect(check.hasSufficientLiquidity).toBe(true); // Assumes sufficient
      expect(check.checkPerformed).toBe(false);
      expect(check.availableLiquidity).toBe(0n);
      expect(check.requiredLiquidity).toBe(0n);
      expect(check.checkLatencyMs).toBe(0);
    });
  });

  describe('getMarginPercent', () => {
    it('should calculate positive margin', () => {
      const check = LiquidityCheck.success(1100000n, 1000000n, 10);
      const margin = check.getMarginPercent();

      expect(margin).toBe(10); // 10% extra
    });

    it('should calculate negative margin', () => {
      const check = LiquidityCheck.success(900000n, 1000000n, 10);
      const margin = check.getMarginPercent();

      expect(margin).toBe(-10); // 10% short
    });

    it('should return 100% for zero required', () => {
      const check = LiquidityCheck.success(1000n, 0n, 10);
      const margin = check.getMarginPercent();

      expect(margin).toBe(100);
    });

    it('should return 0% for exact match', () => {
      const check = LiquidityCheck.success(1000000n, 1000000n, 10);
      const margin = check.getMarginPercent();

      expect(margin).toBe(0);
    });
  });
});

describe('ProviderSelection', () => {
  describe('constructor', () => {
    it('should create successful selection', () => {
      const score = new ProviderScore(0.9, 0.8, 0.7, 0.6, 0.8);
      const liquidityCheck = LiquidityCheck.success(1000n, 900n, 10);
      const selection = new ProviderSelection(
        'aave_v3',
        score,
        liquidityCheck,
        'Best provider',
        50,
        []
      );

      expect(selection.protocol).toBe('aave_v3');
      expect(selection.score).toBe(score);
      expect(selection.liquidityCheck).toBe(liquidityCheck);
      expect(selection.selectionReason).toBe('Best provider');
      expect(selection.selectionLatencyMs).toBe(50);
    });

    it('should be immutable (frozen)', () => {
      const selection = ProviderSelection.success(
        'aave_v3',
        new ProviderScore(0.9, 0.8, 0.7, 0.6, 0.8),
        null,
        'Selected',
        10
      );

      expect(Object.isFrozen(selection)).toBe(true);
      expect(Object.isFrozen(selection.rankedAlternatives)).toBe(true);
    });

    it('should reject negative latency', () => {
      expect(() =>
        new ProviderSelection('aave_v3', null, null, 'test', -1, [])
      ).toThrow('Invalid selection latency');
    });

    it('should require score if protocol selected', () => {
      expect(() =>
        new ProviderSelection('aave_v3', null, null, 'test', 10, [])
      ).toThrow('Selected protocol must have associated score');
    });
  });

  describe('success', () => {
    it('should create successful selection', () => {
      const score = new ProviderScore(0.9, 0.8, 0.7, 0.6, 0.8);
      const selection = ProviderSelection.success(
        'aave_v3',
        score,
        null,
        'Top ranked',
        25
      );

      expect(selection.protocol).toBe('aave_v3');
      expect(selection.score).toBe(score);
      expect(selection.isSuccess).toBe(true);
    });

    it('should include alternatives', () => {
      const score = new ProviderScore(0.9, 0.8, 0.7, 0.6, 0.8);
      const altScore = new ProviderScore(0.7, 0.6, 0.5, 0.4, 0.6);
      const selection = ProviderSelection.success(
        'aave_v3',
        score,
        null,
        'Top ranked',
        25,
        [{ protocol: 'pancakeswap_v3', score: altScore }]
      );

      expect(selection.rankedAlternatives).toHaveLength(1);
      expect(selection.rankedAlternatives[0].protocol).toBe('pancakeswap_v3');
    });
  });

  describe('failure', () => {
    it('should create failed selection', () => {
      const selection = ProviderSelection.failure('No providers available', 10);

      expect(selection.protocol).toBeNull();
      expect(selection.score).toBeNull();
      expect(selection.isSuccess).toBe(false);
    });

    it('should create failed selection with alternatives', () => {
      const altScore = new ProviderScore(0.7, 0.6, 0.5, 0.4, 0.6);
      const selection = ProviderSelection.failure(
        'All providers failed validation',
        15,
        [{ protocol: 'aave_v3', score: altScore }]
      );

      expect(selection.protocol).toBeNull();
      expect(selection.isSuccess).toBe(false);
      expect(selection.rankedAlternatives).toHaveLength(1);
      expect(selection.rankedAlternatives[0].protocol).toBe('aave_v3');
    });
  });

  describe('getSummary', () => {
    it('should generate summary for successful selection', () => {
      const score = new ProviderScore(0.95, 0.92, 0.91, 0.93, 0.94);
      const check = LiquidityCheck.success(1000n, 900n, 5);
      const selection = ProviderSelection.success(
        'aave_v3',
        score,
        check,
        'Top provider',
        15
      );

      const summary = selection.getSummary();
      expect(summary).toContain('aave_v3');
      expect(summary).toContain('latency: 15ms');
    });

    it('should generate summary for failed selection', () => {
      const selection = ProviderSelection.failure('Insufficient liquidity', 10);

      const summary = selection.getSummary();
      expect(summary).toContain('Selection failed');
      expect(summary).toContain('Insufficient liquidity');
    });
  });
});

describe('AggregatorConfig', () => {
  describe('constructor', () => {
    it('should create valid config', () => {
      const config = new AggregatorConfig(
        100000,
        30000,
        300000,
        { fees: 0.5, liquidity: 0.3, reliability: 0.15, latency: 0.05 },
        5
      );

      expect(config.liquidityCheckThresholdUsd).toBe(100000);
      expect(config.rankingCacheTtlMs).toBe(30000);
      expect(config.liquidityCacheTtlMs).toBe(300000);
      expect(config.weights.fees).toBe(0.5);
      expect(config.maxProvidersToRank).toBe(5);
    });

    it('should be immutable (frozen)', () => {
      const config = AggregatorConfig.default();

      expect(Object.isFrozen(config)).toBe(true);
      expect(Object.isFrozen(config.weights)).toBe(true);
    });

    it('should reject negative liquidity threshold', () => {
      expect(() =>
        new AggregatorConfig(
          -1,
          30000,
          300000,
          { fees: 0.5, liquidity: 0.3, reliability: 0.15, latency: 0.05 },
          5
        )
      ).toThrow('Invalid liquidity threshold');
    });

    it('should reject non-positive ranking cache TTL', () => {
      expect(() =>
        new AggregatorConfig(
          100000,
          0,
          300000,
          { fees: 0.5, liquidity: 0.3, reliability: 0.15, latency: 0.05 },
          5
        )
      ).toThrow('Invalid ranking cache TTL');
    });

    it('should reject weights that do not sum to 1.0', () => {
      expect(() =>
        new AggregatorConfig(
          100000,
          30000,
          300000,
          { fees: 0.6, liquidity: 0.3, reliability: 0.15, latency: 0.05 }, // Sum = 1.1
          5
        )
      ).toThrow('Weights must sum to 1.0');
    });

    it('should accept weights with small tolerance', () => {
      // Sum = 1.005 (within 0.01 tolerance)
      const config = new AggregatorConfig(
        100000,
        30000,
        300000,
        { fees: 0.505, liquidity: 0.3, reliability: 0.15, latency: 0.05 },
        5
      );

      expect(config.weights.fees).toBe(0.505);
    });
  });

  describe('default', () => {
    it('should create default configuration', () => {
      const config = AggregatorConfig.default();

      expect(config.liquidityCheckThresholdUsd).toBe(100000);
      expect(config.rankingCacheTtlMs).toBe(30000);
      expect(config.liquidityCacheTtlMs).toBe(300000);
      expect(config.weights.fees).toBe(0.5);
      expect(config.weights.liquidity).toBe(0.3);
      expect(config.weights.reliability).toBe(0.15);
      expect(config.weights.latency).toBe(0.05);
      expect(config.maxProvidersToRank).toBe(3);
    });
  });

  describe('create', () => {
    it('should create config with partial overrides', () => {
      const config = AggregatorConfig.create({
        liquidityCheckThresholdUsd: 50000,
        weights: { fees: 0.6, liquidity: 0.25, reliability: 0.1, latency: 0.05 },
      });

      expect(config.liquidityCheckThresholdUsd).toBe(50000);
      expect(config.weights.fees).toBe(0.6);
      // Other values use defaults
      expect(config.rankingCacheTtlMs).toBe(30000);
      expect(config.maxProvidersToRank).toBe(3);
    });

    it('should use all defaults if no overrides', () => {
      const config = AggregatorConfig.create({});
      const defaultConfig = AggregatorConfig.default();

      expect(config.liquidityCheckThresholdUsd).toBe(defaultConfig.liquidityCheckThresholdUsd);
      expect(config.weights.fees).toBe(defaultConfig.weights.fees);
    });

    it('should reject partial weight specification (M2 fix)', () => {
      expect(() => AggregatorConfig.create({
        weights: { fees: 0.8 } as any,
      })).toThrow('ERR_PARTIAL_WEIGHTS');
    });

    it('should reject 2 of 4 weights', () => {
      expect(() => AggregatorConfig.create({
        weights: { fees: 0.6, liquidity: 0.4 } as any,
      })).toThrow('ERR_PARTIAL_WEIGHTS');
    });

    it('should reject 3 of 4 weights', () => {
      expect(() => AggregatorConfig.create({
        weights: { fees: 0.5, liquidity: 0.3, reliability: 0.2 } as any,
      })).toThrow('ERR_PARTIAL_WEIGHTS');
    });
  });

  describe('constructor error paths', () => {
    it('should reject non-positive liquidity cache TTL', () => {
      expect(() => new AggregatorConfig(100000, 30000, 0,
        { fees: 0.5, liquidity: 0.3, reliability: 0.15, latency: 0.05 }, 5)
      ).toThrow('Invalid liquidity cache TTL');
    });

    it('should reject maxProvidersToRank less than 1', () => {
      expect(() => new AggregatorConfig(100000, 30000, 300000,
        { fees: 0.5, liquidity: 0.3, reliability: 0.15, latency: 0.05 }, 0)
      ).toThrow('Invalid max providers');
    });

    it('should reject NaN weight value', () => {
      expect(() => new AggregatorConfig(100000, 30000, 300000,
        { fees: NaN, liquidity: 0.3, reliability: 0.15, latency: 0.05 }, 5)
      ).toThrow('Invalid weight value');
    });

    it('should reject negative weight value', () => {
      expect(() => new AggregatorConfig(100000, 30000, 300000,
        { fees: -0.1, liquidity: 0.3, reliability: 0.15, latency: 0.05 }, 5)
      ).toThrow('Invalid weight value');
    });

    it('should reject weight value greater than 1', () => {
      expect(() => new AggregatorConfig(100000, 30000, 300000,
        { fees: 1.5, liquidity: 0.3, reliability: 0.15, latency: 0.05 }, 5)
      ).toThrow('Invalid weight value');
    });
  });
});

describe('ProviderOutcome', () => {
  describe('constructor', () => {
    it('should create successful outcome', () => {
      const outcome = new ProviderOutcome('aave_v3', true, 150);

      expect(outcome.protocol).toBe('aave_v3');
      expect(outcome.success).toBe(true);
      expect(outcome.executionLatencyMs).toBe(150);
      expect(outcome.error).toBeUndefined();
      expect(outcome.errorType).toBeUndefined();
    });

    it('should create failed outcome with error', () => {
      const outcome = new ProviderOutcome(
        'pancakeswap_v3',
        false,
        200,
        'Insufficient liquidity',
        'insufficient_liquidity'
      );

      expect(outcome.protocol).toBe('pancakeswap_v3');
      expect(outcome.success).toBe(false);
      expect(outcome.error).toBe('Insufficient liquidity');
      expect(outcome.errorType).toBe('insufficient_liquidity');
    });

    it('should be immutable (frozen)', () => {
      const outcome = ProviderOutcome.success('aave_v3', 100);

      expect(Object.isFrozen(outcome)).toBe(true);
    });

    it('should reject negative latency', () => {
      expect(() => new ProviderOutcome('aave_v3', true, -1)).toThrow(
        'Invalid execution latency'
      );
    });
  });

  describe('success', () => {
    it('should create successful outcome', () => {
      const outcome = ProviderOutcome.success('aave_v3', 120);

      expect(outcome.protocol).toBe('aave_v3');
      expect(outcome.success).toBe(true);
      expect(outcome.executionLatencyMs).toBe(120);
      expect(outcome.error).toBeUndefined();
    });
  });

  describe('failure', () => {
    it('should create failed outcome', () => {
      const outcome = ProviderOutcome.failure(
        'pancakeswap_v3',
        180,
        'Transaction reverted',
        'transient'
      );

      expect(outcome.protocol).toBe('pancakeswap_v3');
      expect(outcome.success).toBe(false);
      expect(outcome.executionLatencyMs).toBe(180);
      expect(outcome.error).toBe('Transaction reverted');
      expect(outcome.errorType).toBe('transient');
    });

    it('should default errorType to unknown', () => {
      const outcome = ProviderOutcome.failure(
        'aave_v3',
        100,
        'Some error'
      );

      expect(outcome.errorType).toBe('unknown');
    });
  });
});
