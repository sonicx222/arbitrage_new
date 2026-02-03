/**
 * A/B Testing Framework Unit Tests
 *
 * Tests for the A/B testing system including:
 * - Deterministic variant assignment
 * - Metrics collection
 * - Statistical significance calculation
 * - Experiment management
 *
 * @see FINAL_IMPLEMENTATION_PLAN.md Task 3: A/B Testing Framework
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

// =============================================================================
// Mock Redis Client
// =============================================================================

interface MockRedisClient {
  get: Mock<(key: string) => Promise<unknown>>;
  set: Mock<(key: string, value: unknown, ttl?: number) => Promise<string>>;
  del: Mock<(key: string) => Promise<void>>;
  sadd: Mock<(key: string, member: string) => Promise<void>>;
  smembers: Mock<(key: string) => Promise<string[]>>;
}

const createMockRedisClient = (): MockRedisClient => {
  const store = new Map<string, unknown>();
  const sets = new Map<string, Set<string>>();

  return {
    get: jest.fn<(key: string) => Promise<unknown>>().mockImplementation(async (key: string) => {
      return store.get(key) || null;
    }),
    set: jest.fn<(key: string, value: unknown, ttl?: number) => Promise<string>>().mockImplementation(async (key: string, value: unknown) => {
      store.set(key, value);
      return 'OK';
    }),
    del: jest.fn<(key: string) => Promise<void>>().mockImplementation(async (key: string) => {
      store.delete(key);
    }),
    sadd: jest.fn<(key: string, member: string) => Promise<void>>().mockImplementation(async (key: string, member: string) => {
      if (!sets.has(key)) {
        sets.set(key, new Set());
      }
      sets.get(key)!.add(member);
    }),
    smembers: jest.fn<(key: string) => Promise<string[]>>().mockImplementation(async (key: string) => {
      const set = sets.get(key);
      return set ? Array.from(set) : [];
    }),
  };
};

// =============================================================================
// Statistical Analysis Tests
// =============================================================================

import {
  calculateSignificance,
  calculateRequiredSampleSize,
  estimateTimeToSignificance,
  shouldStopEarly,
} from '../../src/ab-testing/statistical-analysis';
import type { ComputedMetrics } from '../../src/ab-testing/types';

describe('Statistical Analysis', () => {
  describe('calculateSignificance', () => {
    it('should detect significant difference when variant is better', () => {
      const controlMetrics: ComputedMetrics = {
        experimentId: 'test-1',
        variant: 'control',
        successCount: 70,
        failureCount: 30,
        totalProfitWei: '1000000000000000000',
        totalGasCostWei: '100000000000000000',
        totalLatencyMs: 5000,
        mevFrontrunCount: 5,
        successRate: 0.7,
        avgProfitWei: '10000000000000000',
        avgGasCostWei: '1000000000000000',
        avgLatencyMs: 50,
        mevFrontrunRate: 0.05,
        sampleSize: 100,
      };

      const variantMetrics: ComputedMetrics = {
        experimentId: 'test-1',
        variant: 'variant',
        successCount: 90,
        failureCount: 10,
        totalProfitWei: '1500000000000000000',
        totalGasCostWei: '90000000000000000',
        totalLatencyMs: 4500,
        mevFrontrunCount: 2,
        successRate: 0.9,
        avgProfitWei: '15000000000000000',
        avgGasCostWei: '900000000000000',
        avgLatencyMs: 45,
        mevFrontrunRate: 0.02,
        sampleSize: 100,
      };

      const result = calculateSignificance(controlMetrics, variantMetrics, 0.05, 100);

      expect(result.significant).toBe(true);
      expect(result.effectSize).toBeCloseTo(0.2, 2); // 90% - 70% = 20%
      expect(result.recommendation).toBe('adopt_variant');
      expect(result.pValue).toBeLessThan(0.05);
    });

    it('should not be significant with insufficient sample size', () => {
      const controlMetrics: ComputedMetrics = {
        experimentId: 'test-1',
        variant: 'control',
        successCount: 7,
        failureCount: 3,
        totalProfitWei: '100000000000000000',
        totalGasCostWei: '10000000000000000',
        totalLatencyMs: 500,
        mevFrontrunCount: 0,
        successRate: 0.7,
        avgProfitWei: '10000000000000000',
        avgGasCostWei: '1000000000000000',
        avgLatencyMs: 50,
        mevFrontrunRate: 0,
        sampleSize: 10, // Below minimum
      };

      const variantMetrics: ComputedMetrics = {
        ...controlMetrics,
        variant: 'variant',
        successCount: 9,
        failureCount: 1,
        successRate: 0.9,
      };

      const result = calculateSignificance(controlMetrics, variantMetrics, 0.05, 100);

      expect(result.significant).toBe(false);
      expect(result.recommendation).toBe('continue_testing');
      expect(result.sampleSizeWarning).toBeDefined();
    });

    it('should recommend keeping control when control is better', () => {
      const controlMetrics: ComputedMetrics = {
        experimentId: 'test-1',
        variant: 'control',
        successCount: 90,
        failureCount: 10,
        totalProfitWei: '1500000000000000000',
        totalGasCostWei: '90000000000000000',
        totalLatencyMs: 4500,
        mevFrontrunCount: 2,
        successRate: 0.9,
        avgProfitWei: '15000000000000000',
        avgGasCostWei: '900000000000000',
        avgLatencyMs: 45,
        mevFrontrunRate: 0.02,
        sampleSize: 100,
      };

      const variantMetrics: ComputedMetrics = {
        ...controlMetrics,
        variant: 'variant',
        successCount: 70,
        failureCount: 30,
        successRate: 0.7,
      };

      const result = calculateSignificance(controlMetrics, variantMetrics, 0.05, 100);

      expect(result.significant).toBe(true);
      expect(result.effectSize).toBeLessThan(0); // Negative effect (variant worse)
      expect(result.recommendation).toBe('keep_control');
    });
  });

  describe('calculateRequiredSampleSize', () => {
    it('should calculate sample size for typical arbitrage scenario', () => {
      // Baseline 80% success rate, want to detect 5% improvement
      const sampleSize = calculateRequiredSampleSize(0.8, 0.05);

      // Should require several hundred samples per group
      expect(sampleSize).toBeGreaterThan(500);
      expect(sampleSize).toBeLessThan(2000);
    });

    it('should require larger sample for smaller effect', () => {
      const smallEffect = calculateRequiredSampleSize(0.8, 0.02);
      const largeEffect = calculateRequiredSampleSize(0.8, 0.1);

      expect(smallEffect).toBeGreaterThan(largeEffect);
    });
  });

  describe('estimateTimeToSignificance', () => {
    it('should estimate hours correctly', () => {
      const hours = estimateTimeToSignificance(50, 200, 10); // 10 samples/hour

      expect(hours).toBe(15); // (200 - 50) / 10 = 15 hours
    });

    it('should return 0 if already have enough data', () => {
      const hours = estimateTimeToSignificance(200, 100, 10);

      expect(hours).toBe(0);
    });

    it('should return Infinity for zero throughput', () => {
      const hours = estimateTimeToSignificance(50, 200, 0);

      expect(hours).toBe(Infinity);
    });
  });

  describe('shouldStopEarly', () => {
    it('should not stop early with insufficient data', () => {
      const result = shouldStopEarly(0.001, 25, 200); // 12.5% of target

      expect(result.shouldStop).toBe(false);
      expect(result.reason).toContain('Insufficient');
    });

    it('should allow early stopping with overwhelming evidence', () => {
      const result = shouldStopEarly(0.0001, 150, 200); // 75% of target, very low p-value

      expect(result.shouldStop).toBe(true);
      expect(result.adjustedAlpha).toBeGreaterThan(0.0001);
    });
  });
});

// =============================================================================
// Deterministic Assignment Tests
// =============================================================================

// FNV-1a hash function (matches implementation in framework.ts)
function fnv1aHash(str: string): number {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

describe('Deterministic Variant Assignment', () => {
  it('should assign same opportunity to same variant consistently', () => {
    // Test the hash-based assignment logic using FNV-1a (matches implementation)
    const deterministicAssign = (
      opportunityHash: string,
      trafficSplit: number
    ): 'control' | 'variant' => {
      const hash = fnv1aHash(opportunityHash);
      const hashValue = hash / 4294967296;
      return hashValue < trafficSplit ? 'variant' : 'control';
    };

    const opportunityHash = 'opp-123-abc';

    // Should always get same result
    const result1 = deterministicAssign(opportunityHash, 0.1);
    const result2 = deterministicAssign(opportunityHash, 0.1);
    const result3 = deterministicAssign(opportunityHash, 0.1);

    expect(result1).toBe(result2);
    expect(result2).toBe(result3);
  });

  it('should respect traffic split ratio', () => {
    const deterministicAssign = (
      opportunityHash: string,
      trafficSplit: number
    ): 'control' | 'variant' => {
      const hash = fnv1aHash(opportunityHash);
      const hashValue = hash / 4294967296;
      return hashValue < trafficSplit ? 'variant' : 'control';
    };

    // Generate 1000 unique opportunity hashes
    let variantCount = 0;
    const totalSamples = 1000;
    const trafficSplit = 0.1; // 10% variant

    for (let i = 0; i < totalSamples; i++) {
      const hash = `opportunity-${i}-${Math.random()}`;
      if (deterministicAssign(hash, trafficSplit) === 'variant') {
        variantCount++;
      }
    }

    // Should be approximately 10% (within statistical tolerance)
    const variantRate = variantCount / totalSamples;
    expect(variantRate).toBeGreaterThan(0.05); // At least 5%
    expect(variantRate).toBeLessThan(0.15); // At most 15%
  });
});

// =============================================================================
// Metrics Collection Tests
// =============================================================================

import { MetricsCollector } from '../../src/ab-testing/metrics-collector';
import { DEFAULT_AB_TESTING_CONFIG } from '../../src/ab-testing/types';
import type { ABTestExecutionResult } from '../../src/ab-testing/types';

describe('MetricsCollector', () => {
  let mockRedis: MockRedisClient;
  let collector: MetricsCollector;

  beforeEach(() => {
    mockRedis = createMockRedisClient();
    collector = new MetricsCollector(mockRedis as any, {
      ...DEFAULT_AB_TESTING_CONFIG,
      enabled: true,
    });
  });

  afterEach(async () => {
    await collector.stop();
  });

  it('should record and aggregate successful results', async () => {
    const result1: ABTestExecutionResult = {
      result: {
        success: true,
        actualProfit: 1000, // Use smaller numbers for testing
        gasCost: 50,
        opportunityId: 'opp-1',
        timestamp: Date.now(),
        chain: 'ethereum',
        dex: 'uniswap',
      },
      experimentId: 'test-exp',
      variant: 'control',
      timestamp: Date.now(),
      latencyMs: 100,
      mevFrontrunDetected: false,
    };

    const result2: ABTestExecutionResult = {
      ...result1,
      result: {
        success: true,
        actualProfit: 2000,
        gasCost: 60,
        opportunityId: 'opp-2',
        timestamp: Date.now(),
        chain: 'ethereum',
        dex: 'uniswap',
      },
      latencyMs: 80,
    };

    await collector.recordResult(result1);
    await collector.recordResult(result2);
    await collector.flush();

    const metrics = await collector.getMetrics('test-exp', 'control');

    expect(metrics).not.toBeNull();
    expect(metrics!.successCount).toBe(2);
    expect(metrics!.failureCount).toBe(0);
    expect(metrics!.sampleSize).toBe(2);
    expect(metrics!.successRate).toBe(1.0);
    expect(metrics!.totalProfitWei).toBe('3000');
    expect(metrics!.avgLatencyMs).toBe(90);
  });

  it('should track both variants separately', async () => {
    const controlResult: ABTestExecutionResult = {
      result: { success: true, actualProfit: 1000, gasCost: 0, opportunityId: 'opp-1', timestamp: Date.now(), chain: 'ethereum', dex: 'uniswap' },
      experimentId: 'test-exp',
      variant: 'control',
      timestamp: Date.now(),
      latencyMs: 100,
      mevFrontrunDetected: false,
    };

    const variantResult: ABTestExecutionResult = {
      ...controlResult,
      variant: 'variant',
      result: { success: false, actualProfit: 0, gasCost: 0, opportunityId: 'opp-2', error: 'EXECUTION_FAILED', timestamp: Date.now(), chain: 'ethereum', dex: 'uniswap' },
    };

    await collector.recordResult(controlResult);
    await collector.recordResult(variantResult);
    await collector.flush();

    const { control, variant } = await collector.getExperimentMetrics('test-exp');

    expect(control?.successCount).toBe(1);
    expect(control?.failureCount).toBe(0);
    expect(variant?.successCount).toBe(0);
    expect(variant?.failureCount).toBe(1);
  });

  it('should track MEV frontrun events', async () => {
    const normalResult: ABTestExecutionResult = {
      result: { success: true, actualProfit: 1000, gasCost: 0, opportunityId: 'opp-1', timestamp: Date.now(), chain: 'ethereum', dex: 'uniswap' },
      experimentId: 'test-exp',
      variant: 'control',
      timestamp: Date.now(),
      latencyMs: 100,
      mevFrontrunDetected: false,
    };

    const frontrunResult: ABTestExecutionResult = {
      ...normalResult,
      mevFrontrunDetected: true,
      result: { success: false, actualProfit: 0, gasCost: 0, opportunityId: 'opp-2', error: 'MEV_FRONTRUN', timestamp: Date.now(), chain: 'ethereum', dex: 'uniswap' },
    };

    await collector.recordResult(normalResult);
    await collector.recordResult(frontrunResult);
    await collector.flush();

    const metrics = await collector.getMetrics('test-exp', 'control');

    expect(metrics?.mevFrontrunCount).toBe(1);
    expect(metrics?.mevFrontrunRate).toBe(0.5);
  });
});

// =============================================================================
// Framework Integration Tests
// =============================================================================

import { ABTestingFramework } from '../../src/ab-testing/framework';

describe('ABTestingFramework', () => {
  let mockRedis: MockRedisClient;
  let framework: ABTestingFramework;

  beforeEach(async () => {
    mockRedis = createMockRedisClient();
    framework = new ABTestingFramework(mockRedis as any, {
      ...DEFAULT_AB_TESTING_CONFIG,
      enabled: true,
    });
    await framework.start();
  });

  afterEach(async () => {
    await framework.stop();
  });

  describe('createExperiment', () => {
    it('should create experiment with default values', async () => {
      const experiment = await framework.createExperiment({
        name: 'Flash Loan Test',
        control: 'direct',
        variant: 'flash-loan',
      });

      expect(experiment.id).toBeDefined();
      expect(experiment.name).toBe('Flash Loan Test');
      expect(experiment.control).toBe('direct');
      expect(experiment.variant).toBe('flash-loan');
      expect(experiment.trafficSplit).toBe(0.1); // Default
      expect(experiment.status).toBe('running');
    });

    it('should create experiment with custom values', async () => {
      const experiment = await framework.createExperiment({
        name: 'MEV Protection Test',
        control: 'mev-none',
        variant: 'mev-flashbots',
        trafficSplit: 0.2,
        minSampleSize: 200,
        chainFilter: 'ethereum',
        startImmediately: false,
      });

      expect(experiment.trafficSplit).toBe(0.2);
      expect(experiment.minSampleSize).toBe(200);
      expect(experiment.chainFilter).toBe('ethereum');
      expect(experiment.status).toBe('draft');
    });
  });

  describe('assignVariant', () => {
    it('should return null for non-existent experiment', () => {
      const variant = framework.assignVariant('non-existent', 'opp-123');

      expect(variant).toBeNull();
    });

    it('should return variant for active experiment', async () => {
      const experiment = await framework.createExperiment({
        name: 'Test',
        control: 'a',
        variant: 'b',
      });

      const variant = framework.assignVariant(experiment.id, 'opp-123');

      expect(variant).toBeDefined();
      expect(['control', 'variant']).toContain(variant);
    });

    it('should be deterministic', async () => {
      const experiment = await framework.createExperiment({
        name: 'Test',
        control: 'a',
        variant: 'b',
      });

      const variant1 = framework.assignVariant(experiment.id, 'opp-same-hash');
      const variant2 = framework.assignVariant(experiment.id, 'opp-same-hash');
      const variant3 = framework.assignVariant(experiment.id, 'opp-same-hash');

      expect(variant1).toBe(variant2);
      expect(variant2).toBe(variant3);
    });
  });

  describe('updateExperimentStatus', () => {
    it('should update status and set end date on completion', async () => {
      const experiment = await framework.createExperiment({
        name: 'Test',
        control: 'a',
        variant: 'b',
      });

      await framework.updateExperimentStatus(experiment.id, 'completed');

      const updated = await framework.getExperiment(experiment.id);

      expect(updated?.status).toBe('completed');
      expect(updated?.endDate).toBeDefined();
    });

    it('should remove from active experiments when paused', async () => {
      const experiment = await framework.createExperiment({
        name: 'Test',
        control: 'a',
        variant: 'b',
      });

      // Should be active initially
      expect(framework.assignVariant(experiment.id, 'opp-1')).not.toBeNull();

      await framework.updateExperimentStatus(experiment.id, 'paused');

      // Should not be active after pause
      expect(framework.assignVariant(experiment.id, 'opp-1')).toBeNull();
    });
  });

  describe('getExperimentSummary', () => {
    it('should return summary with empty metrics for new experiment', async () => {
      const experiment = await framework.createExperiment({
        name: 'Test',
        control: 'a',
        variant: 'b',
      });

      const summary = await framework.getExperimentSummary(experiment.id);

      expect(summary).not.toBeNull();
      expect(summary?.experiment.id).toBe(experiment.id);
      expect(summary?.controlMetrics.sampleSize).toBe(0);
      expect(summary?.variantMetrics.sampleSize).toBe(0);
      expect(summary?.readyForConclusion).toBe(false);
    });

    it('should return null for non-existent experiment', async () => {
      const summary = await framework.getExperimentSummary('non-existent');

      expect(summary).toBeNull();
    });
  });
});
