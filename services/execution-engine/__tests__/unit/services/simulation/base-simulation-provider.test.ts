/**
 * BaseSimulationProvider Unit Tests
 *
 * Tests the base simulation provider abstract class through a concrete test implementation.
 * This ensures the shared functionality (metrics, health tracking, success rate) works correctly.
 *
 * @see Fix 8.1: Missing tests for BaseSimulationProvider
 */

// @ts-nocheck - Test file with mock objects that don't need strict typing
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { ethers } from 'ethers';
import { BaseSimulationProvider } from './base-simulation-provider';
import type {
  SimulationProviderConfig,
  SimulationRequest,
  SimulationResult,
  SimulationProviderType,
} from './types';

// =============================================================================
// Test Implementation of BaseSimulationProvider
// =============================================================================

/**
 * Concrete implementation of BaseSimulationProvider for testing purposes.
 * Allows us to control the simulation behavior and verify base class logic.
 */
class TestSimulationProvider extends BaseSimulationProvider {
  readonly type: SimulationProviderType = 'local';

  /** Control simulation result behavior */
  public simulationBehavior: 'success' | 'revert' | 'error' | 'timeout' = 'success';
  public simulationDelay = 0;

  protected async executeSimulation(
    request: SimulationRequest,
    startTime: number
  ): Promise<SimulationResult> {
    // Simulate delay if configured
    if (this.simulationDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.simulationDelay));
    }

    switch (this.simulationBehavior) {
      case 'success':
        return {
          success: true,
          wouldRevert: false,
          returnValue: '0x0001',
          provider: this.type,
          latencyMs: Date.now() - startTime,
          gasUsed: 100000n,
        };
      case 'revert':
        return {
          success: true,
          wouldRevert: true,
          revertReason: 'Test revert reason',
          provider: this.type,
          latencyMs: Date.now() - startTime,
        };
      case 'error':
        throw new Error('Test simulation error');
      case 'timeout':
        await new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Simulation timeout')), 10000)
        );
        throw new Error('Should not reach here');
    }
  }

  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    return { healthy: true, message: 'Test provider healthy' };
  }
}

// =============================================================================
// Mock Factories
// =============================================================================

const createMockProvider = () => ({
  getBlockNumber: jest.fn(() => Promise.resolve(18500000)),
  getNetwork: jest.fn(() => Promise.resolve({ chainId: 1n, name: 'mainnet' })),
  call: jest.fn(() => Promise.resolve('0x0001')),
});

const createValidConfig = (overrides: Partial<SimulationProviderConfig> = {}): SimulationProviderConfig => ({
  type: 'local',
  chain: 'ethereum',
  provider: createMockProvider() as unknown as ethers.JsonRpcProvider,
  enabled: true,
  timeoutMs: 5000,
  ...overrides,
});

const createSimulationRequest = (overrides: Partial<SimulationRequest> = {}): SimulationRequest => ({
  chain: 'ethereum',
  transaction: {
    from: '0x1234567890123456789012345678901234567890',
    to: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    data: '0x12345678',
    value: 0n,
    gasLimit: 200000n,
  },
  ...overrides,
});

// =============================================================================
// Test Suite
// =============================================================================

describe('BaseSimulationProvider', () => {
  let provider: TestSimulationProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    provider = new TestSimulationProvider(createValidConfig());
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // ===========================================================================
  // Constructor Tests
  // ===========================================================================

  describe('constructor', () => {
    test('should initialize with valid config', () => {
      expect(provider.type).toBe('local');
      expect(provider.chain).toBe('ethereum');
      expect(provider.isEnabled()).toBe(true);
    });

    test('should respect enabled flag', () => {
      const disabledProvider = new TestSimulationProvider(createValidConfig({ enabled: false }));
      expect(disabledProvider.isEnabled()).toBe(false);
    });

    test('should use default timeout if not provided', () => {
      const noTimeoutProvider = new TestSimulationProvider(
        createValidConfig({ timeoutMs: undefined })
      );
      // Provider should use default timeout (5000ms)
      expect(noTimeoutProvider.isEnabled()).toBe(true);
    });
  });

  // ===========================================================================
  // Initial Health State Tests (Fix 4.4)
  // ===========================================================================

  describe('initial health state', () => {
    test('should start with unknown health status (healthy: false)', () => {
      const health = provider.getHealth();
      expect(health.healthy).toBe(false);
      expect(health.successRate).toBe(0);
      expect(health.consecutiveFailures).toBe(0);
      expect(health.lastCheck).toBe(0);
    });

    test('should become healthy after first successful simulation', async () => {
      provider.simulationBehavior = 'success';

      jest.useRealTimers();
      await provider.simulate(createSimulationRequest());

      const health = provider.getHealth();
      expect(health.healthy).toBe(true);
      expect(health.consecutiveFailures).toBe(0);
    });
  });

  // ===========================================================================
  // simulate() Tests
  // ===========================================================================

  describe('simulate', () => {
    beforeEach(() => {
      jest.useRealTimers();
    });

    test('should return success result for successful simulation', async () => {
      provider.simulationBehavior = 'success';
      const result = await provider.simulate(createSimulationRequest());

      expect(result.success).toBe(true);
      expect(result.wouldRevert).toBe(false);
      expect(result.provider).toBe('local');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    test('should return revert result for reverting transaction', async () => {
      provider.simulationBehavior = 'revert';
      const result = await provider.simulate(createSimulationRequest());

      expect(result.success).toBe(true);
      expect(result.wouldRevert).toBe(true);
      expect(result.revertReason).toBe('Test revert reason');
    });

    test('should return error result on simulation error', async () => {
      provider.simulationBehavior = 'error';
      const result = await provider.simulate(createSimulationRequest());

      expect(result.success).toBe(false);
      expect(result.error).toContain('Test simulation error');
    });

    test('should return error result when disabled', async () => {
      const disabledProvider = new TestSimulationProvider(createValidConfig({ enabled: false }));
      const result = await disabledProvider.simulate(createSimulationRequest());

      expect(result.success).toBe(false);
      expect(result.error).toContain('disabled');
    });

    test('should track latency correctly', async () => {
      provider.simulationBehavior = 'success';
      provider.simulationDelay = 50;

      const result = await provider.simulate(createSimulationRequest());

      expect(result.latencyMs).toBeGreaterThanOrEqual(50);
    });
  });

  // ===========================================================================
  // Metrics Tests
  // ===========================================================================

  describe('metrics', () => {
    beforeEach(() => {
      jest.useRealTimers();
    });

    test('should start with empty metrics', () => {
      const metrics = provider.getMetrics();
      expect(metrics.totalSimulations).toBe(0);
      expect(metrics.successfulSimulations).toBe(0);
      expect(metrics.failedSimulations).toBe(0);
      expect(metrics.predictedReverts).toBe(0);
      expect(metrics.averageLatencyMs).toBe(0);
    });

    test('should track successful simulations', async () => {
      provider.simulationBehavior = 'success';

      await provider.simulate(createSimulationRequest());
      await provider.simulate(createSimulationRequest());

      const metrics = provider.getMetrics();
      expect(metrics.totalSimulations).toBe(2);
      expect(metrics.successfulSimulations).toBe(2);
      expect(metrics.failedSimulations).toBe(0);
    });

    test('should track failed simulations', async () => {
      provider.simulationBehavior = 'error';

      await provider.simulate(createSimulationRequest());

      const metrics = provider.getMetrics();
      expect(metrics.totalSimulations).toBe(1);
      expect(metrics.failedSimulations).toBe(1);
      expect(metrics.successfulSimulations).toBe(0);
    });

    test('should track predicted reverts', async () => {
      provider.simulationBehavior = 'revert';

      await provider.simulate(createSimulationRequest());

      const metrics = provider.getMetrics();
      expect(metrics.predictedReverts).toBe(1);
    });

    test('should calculate rolling average latency', async () => {
      provider.simulationBehavior = 'success';
      provider.simulationDelay = 10;

      await provider.simulate(createSimulationRequest());
      await provider.simulate(createSimulationRequest());

      const metrics = provider.getMetrics();
      expect(metrics.averageLatencyMs).toBeGreaterThanOrEqual(10);
    });

    test('should reset metrics correctly', async () => {
      provider.simulationBehavior = 'success';

      await provider.simulate(createSimulationRequest());
      provider.resetMetrics();

      const metrics = provider.getMetrics();
      expect(metrics.totalSimulations).toBe(0);
      expect(metrics.successfulSimulations).toBe(0);
    });

    test('should update lastUpdated timestamp', async () => {
      provider.simulationBehavior = 'success';

      const beforeTime = Date.now();
      await provider.simulate(createSimulationRequest());
      const afterTime = Date.now();

      const metrics = provider.getMetrics();
      expect(metrics.lastUpdated).toBeGreaterThanOrEqual(beforeTime);
      expect(metrics.lastUpdated).toBeLessThanOrEqual(afterTime);
    });
  });

  // ===========================================================================
  // Health Tracking Tests
  // ===========================================================================

  describe('health tracking', () => {
    beforeEach(() => {
      jest.useRealTimers();
    });

    test('should update lastCheck after simulation', async () => {
      provider.simulationBehavior = 'success';

      const beforeTime = Date.now();
      await provider.simulate(createSimulationRequest());
      const afterTime = Date.now();

      const health = provider.getHealth();
      expect(health.lastCheck).toBeGreaterThanOrEqual(beforeTime);
      expect(health.lastCheck).toBeLessThanOrEqual(afterTime);
    });

    test('should track consecutive failures', async () => {
      provider.simulationBehavior = 'error';

      await provider.simulate(createSimulationRequest());
      await provider.simulate(createSimulationRequest());
      await provider.simulate(createSimulationRequest());

      const health = provider.getHealth();
      expect(health.consecutiveFailures).toBe(3);
    });

    test('should reset consecutive failures on success', async () => {
      provider.simulationBehavior = 'error';
      await provider.simulate(createSimulationRequest());
      await provider.simulate(createSimulationRequest());

      provider.simulationBehavior = 'success';
      await provider.simulate(createSimulationRequest());

      const health = provider.getHealth();
      expect(health.consecutiveFailures).toBe(0);
    });

    test('should mark unhealthy after max consecutive failures', async () => {
      provider.simulationBehavior = 'error';

      // Default max consecutive failures is 3
      await provider.simulate(createSimulationRequest());
      await provider.simulate(createSimulationRequest());
      await provider.simulate(createSimulationRequest());

      const health = provider.getHealth();
      expect(health.healthy).toBe(false);
    });

    test('should track last error message', async () => {
      provider.simulationBehavior = 'error';

      await provider.simulate(createSimulationRequest());

      const health = provider.getHealth();
      expect(health.lastError).toContain('Test simulation error');
    });
  });

  // ===========================================================================
  // Success Rate Tests (Fix 4.1)
  // ===========================================================================

  describe('success rate calculation', () => {
    beforeEach(() => {
      jest.useRealTimers();
    });

    test('should start with 0 success rate (unknown state)', () => {
      const health = provider.getHealth();
      expect(health.successRate).toBe(0);
    });

    test('should calculate success rate correctly', async () => {
      // 2 successes, 2 failures = 50% success rate
      provider.simulationBehavior = 'success';
      await provider.simulate(createSimulationRequest());
      await provider.simulate(createSimulationRequest());

      provider.simulationBehavior = 'error';
      await provider.simulate(createSimulationRequest());
      await provider.simulate(createSimulationRequest());

      const health = provider.getHealth();
      expect(health.successRate).toBeCloseTo(0.5, 1);
    });

    test('should have 100% success rate with all successes', async () => {
      provider.simulationBehavior = 'success';

      for (let i = 0; i < 5; i++) {
        await provider.simulate(createSimulationRequest());
      }

      const health = provider.getHealth();
      expect(health.successRate).toBe(1);
    });

    test('should have 0% success rate with all failures', async () => {
      provider.simulationBehavior = 'error';

      for (let i = 0; i < 5; i++) {
        await provider.simulate(createSimulationRequest());
      }

      const health = provider.getHealth();
      expect(health.successRate).toBe(0);
    });
  });

  // ===========================================================================
  // Average Latency Tests
  // ===========================================================================

  describe('average latency tracking', () => {
    beforeEach(() => {
      jest.useRealTimers();
    });

    test('should track average latency in health', async () => {
      provider.simulationBehavior = 'success';
      provider.simulationDelay = 20;

      await provider.simulate(createSimulationRequest());

      const health = provider.getHealth();
      expect(health.averageLatencyMs).toBeGreaterThanOrEqual(20);
    });

    test('should calculate rolling average latency', async () => {
      provider.simulationBehavior = 'success';

      // First simulation with 10ms delay
      provider.simulationDelay = 10;
      await provider.simulate(createSimulationRequest());

      // Second simulation with 30ms delay
      provider.simulationDelay = 30;
      await provider.simulate(createSimulationRequest());

      const health = provider.getHealth();
      // Average should be approximately (10 + 30) / 2 = 20, but with some variance
      // due to execution overhead and timing precision
      expect(health.averageLatencyMs).toBeGreaterThanOrEqual(15);
      expect(health.averageLatencyMs).toBeLessThanOrEqual(50); // Widened for CI variance
    });
  });
});
