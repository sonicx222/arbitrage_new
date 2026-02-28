/**
 * Chaos Testing Utilities Unit Tests
 *
 * Tests for ChaosController, NetworkPartitionSimulator, and waitForChaosCondition
 * utility classes. These are pure in-memory utility tests with no external dependencies.
 *
 * Extracted from fault-injection.integration.test.ts — the Redis-backed recovery
 * and degradation tests remain as integration tests.
 *
 * @see shared/test-utils/src/helpers/chaos-testing.ts
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  createChaosController,
  NetworkPartitionSimulator,
  waitForChaosCondition,
} from '@arbitrage/test-utils';

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ChaosController', () => {
  let testId: string;

  beforeEach(() => {
    testId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  it('should detect Redis connection failure via chaos controller', async () => {
    const chaos = createChaosController(`redis-test-${testId}`);

    // Start with chaos disabled
    expect(chaos.shouldApply()).toBe(false);

    // Enable chaos - 100% failure rate
    chaos.start({ mode: 'fail', failureProbability: 1 });

    expect(chaos.shouldApply()).toBe(true);

    // Stop chaos
    chaos.stop();
    expect(chaos.shouldApply()).toBe(false);
  });

  it('should track chaos injection statistics', async () => {
    const chaos = createChaosController(`stats-test-${testId}`);

    chaos.start({ mode: 'fail', failureProbability: 1 });

    // Simulate multiple failure checks
    for (let i = 0; i < 5; i++) {
      if (chaos.shouldApply()) {
        chaos.recordFailure();
      }
    }

    // Small delay to ensure elapsed time is measurable
    await sleep(10);

    const stats = chaos.getStats();

    expect(stats.injectedFailures).toBe(5);
    expect(stats.isActive).toBe(true);
    expect(stats.elapsedMs).toBeGreaterThanOrEqual(10);

    chaos.stop();
  });

  it('should support intermittent failure mode', async () => {
    const chaos = createChaosController(`intermittent-${testId}`);

    // 50% failure probability
    chaos.start({ mode: 'intermittent', failureProbability: 0.5 });

    let failures = 0;
    let successes = 0;

    // Run 100 checks
    for (let i = 0; i < 100; i++) {
      if (chaos.shouldApply()) {
        failures++;
      } else {
        successes++;
      }
    }

    // Should have roughly 50/50 distribution (with some variance)
    expect(failures).toBeGreaterThan(20);
    expect(successes).toBeGreaterThan(20);

    chaos.stop();
  });

  it('should honor duration limit', async () => {
    const chaos = createChaosController(`duration-${testId}`);

    // Start chaos with 100ms duration
    chaos.start({ mode: 'fail', durationMs: 100 });

    expect(chaos.shouldApply()).toBe(true);

    // Wait for duration to expire
    await sleep(150);

    // Should auto-disable after duration
    expect(chaos.shouldApply()).toBe(false);
  });

  it('should inject latency in slow mode', async () => {
    const chaos = createChaosController(`latency-${testId}`);

    chaos.start({ mode: 'slow', latencyMs: 100 });

    const latency = chaos.getLatency();

    expect(latency).toBe(100);
    expect(chaos.shouldApply()).toBe(true);

    chaos.stop();
  });

  it('should not inject latency in fail mode', async () => {
    const chaos = createChaosController(`no-latency-${testId}`);

    chaos.start({ mode: 'fail', latencyMs: 100 });

    const latency = chaos.getLatency();

    // Fail mode doesn't inject latency (it fails immediately)
    expect(latency).toBe(0);

    chaos.stop();
  });
});

describe('NetworkPartitionSimulator', () => {
  it('should simulate partition between services', () => {
    const simulator = new NetworkPartitionSimulator();

    // Initially, all services can communicate
    expect(simulator.canCommunicate('detector', 'coordinator')).toBe(true);
    expect(simulator.canCommunicate('coordinator', 'execution')).toBe(true);

    // Create partition
    simulator.partition('detector', 'coordinator');

    // Detector and coordinator can't communicate
    expect(simulator.canCommunicate('detector', 'coordinator')).toBe(false);
    expect(simulator.canCommunicate('coordinator', 'detector')).toBe(false);

    // Other pairs still can
    expect(simulator.canCommunicate('coordinator', 'execution')).toBe(true);
  });

  it('should heal partitions', () => {
    const simulator = new NetworkPartitionSimulator();

    // Create partition
    simulator.partition('detector', 'coordinator');
    expect(simulator.canCommunicate('detector', 'coordinator')).toBe(false);

    // Heal partition
    simulator.heal('detector', 'coordinator');
    expect(simulator.canCommunicate('detector', 'coordinator')).toBe(true);
  });

  it('should heal all partitions at once', () => {
    const simulator = new NetworkPartitionSimulator();

    // Create multiple partitions
    simulator.partition('detector', 'coordinator');
    simulator.partition('coordinator', 'execution');
    simulator.partition('detector', 'execution');

    // Verify partitions exist
    expect(simulator.canCommunicate('detector', 'coordinator')).toBe(false);
    expect(simulator.canCommunicate('coordinator', 'execution')).toBe(false);

    // Heal all
    simulator.healAll();

    // All should communicate
    expect(simulator.canCommunicate('detector', 'coordinator')).toBe(true);
    expect(simulator.canCommunicate('coordinator', 'execution')).toBe(true);
    expect(simulator.canCommunicate('detector', 'execution')).toBe(true);
  });

  it('should report partition status', () => {
    const simulator = new NetworkPartitionSimulator();

    simulator.partition('detector', 'coordinator');

    const status = simulator.getStatus();

    expect(status.isActive).toBe(true);
    expect(status.partitions.length).toBeGreaterThan(0);

    // Check that detector is blocked from coordinator
    const detectorStatus = status.partitions.find((p) => p.service === 'detector');
    expect(detectorStatus?.blockedFrom).toContain('coordinator');
  });
});

describe('waitForChaosCondition', () => {
  it('should use waitForCondition for recovery verification', async () => {
    let recoveryCount = 0;

    // Simulate gradual recovery
    const checkRecovery = () => {
      recoveryCount++;
      return recoveryCount >= 3; // Recovered after 3 checks
    };

    const recovered = await waitForChaosCondition(checkRecovery, {
      timeout: 1000,
      interval: 50,
    });

    expect(recovered).toBe(true);
    expect(recoveryCount).toBe(3);
  });

  it('should timeout if recovery takes too long', async () => {
    const neverRecovers = () => false;

    const recovered = await waitForChaosCondition(neverRecovers, {
      timeout: 200,
      interval: 50,
    });

    expect(recovered).toBe(false);
  });
});
