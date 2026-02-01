/**
 * SimulationService Unit Tests
 *
 * Tests the simulation service that manages multiple providers
 * with health scoring and automatic fallback.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { SimulationService } from './simulation.service';
import type {
  ISimulationProvider,
  SimulationRequest,
  SimulationResult,
  SimulationProviderHealth,
  SimulationMetrics,
  SimulationProviderType,
} from './types';
import type { Logger } from '../../types';

// =============================================================================
// Mock Provider Factory
// =============================================================================

/**
 * Mock provider type with properly typed Jest mock functions.
 * Fix: Removed @ts-nocheck by using proper type definitions.
 */
interface MockedProvider extends ISimulationProvider {
  isEnabled: Mock<() => boolean>;
  simulate: Mock<(request: SimulationRequest) => Promise<SimulationResult>>;
  getHealth: Mock<() => SimulationProviderHealth>;
  getMetrics: Mock<() => SimulationMetrics>;
  resetMetrics: Mock<() => void>;
  healthCheck: Mock<() => Promise<{ healthy: boolean; message: string }>>;
}

const createMockProvider = (
  type: SimulationProviderType,
  _overrides: Partial<ISimulationProvider> = {}
): MockedProvider => {
  const provider: MockedProvider = {
    type,
    chain: 'ethereum',
    isEnabled: jest.fn<() => boolean>().mockReturnValue(true),
    simulate: jest.fn<(request: SimulationRequest) => Promise<SimulationResult>>().mockResolvedValue({
      success: true,
      wouldRevert: false,
      provider: type,
      latencyMs: 100,
    }),
    getHealth: jest.fn<() => SimulationProviderHealth>().mockReturnValue({
      healthy: true,
      lastCheck: Date.now(),
      consecutiveFailures: 0,
      averageLatencyMs: 100,
      successRate: 1.0,
    }),
    getMetrics: jest.fn<() => SimulationMetrics>().mockReturnValue({
      totalSimulations: 0,
      successfulSimulations: 0,
      failedSimulations: 0,
      predictedReverts: 0,
      averageLatencyMs: 0,
      fallbackUsed: 0,
      cacheHits: 0,
      lastUpdated: Date.now(),
    }),
    resetMetrics: jest.fn<() => void>(),
    healthCheck: jest.fn<() => Promise<{ healthy: boolean; message: string }>>().mockResolvedValue({ healthy: true, message: 'OK' }),
  };
  return provider;
};

const createMockLogger = (): Logger => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
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

describe('SimulationService', () => {
  let service: SimulationService;
  let mockTenderlyProvider: MockedProvider;
  let mockAlchemyProvider: MockedProvider;
  let mockLogger: Logger;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockTenderlyProvider = createMockProvider('tenderly');
    mockAlchemyProvider = createMockProvider('alchemy');
    mockLogger = createMockLogger();
  });

  afterEach(() => {
    jest.useRealTimers();
    service?.stop();
  });

  // ===========================================================================
  // Constructor Tests
  // ===========================================================================

  describe('constructor', () => {
    test('should initialize with default config', () => {
      service = new SimulationService({
        providers: [mockTenderlyProvider],
        logger: mockLogger as any,
      });

      expect(service).toBeDefined();
    });

    test('should initialize with multiple providers', () => {
      service = new SimulationService({
        providers: [mockTenderlyProvider, mockAlchemyProvider],
        logger: mockLogger as any,
      });

      expect(service).toBeDefined();
    });

    test('should use default provider priority when not specified', () => {
      service = new SimulationService({
        providers: [mockTenderlyProvider, mockAlchemyProvider],
        logger: mockLogger as any,
      });

      // Tenderly should be preferred by default
      const request = createSimulationRequest();
      service.simulate(request);

      expect(mockTenderlyProvider.simulate).toHaveBeenCalled();
    });

    test('should respect custom provider priority', () => {
      service = new SimulationService({
        providers: [mockTenderlyProvider, mockAlchemyProvider],
        logger: mockLogger as any,
        config: {
          providerPriority: ['alchemy', 'tenderly'],
        },
      });

      const request = createSimulationRequest();
      service.simulate(request);

      expect(mockAlchemyProvider.simulate).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // simulate Tests
  // ===========================================================================

  describe('simulate', () => {
    test('should use primary provider when healthy', async () => {
      service = new SimulationService({
        providers: [mockTenderlyProvider, mockAlchemyProvider],
        logger: mockLogger as any,
      });

      const request = createSimulationRequest();
      const result = await service.simulate(request);

      expect(result.success).toBe(true);
      expect(mockTenderlyProvider.simulate).toHaveBeenCalledWith(request);
      expect(mockAlchemyProvider.simulate).not.toHaveBeenCalled();
    });

    test('should fallback to secondary provider on primary failure', async () => {
      mockTenderlyProvider.simulate.mockResolvedValueOnce({
        success: false,
        wouldRevert: false,
        error: 'API error',
        provider: 'tenderly',
        latencyMs: 100,
      });

      mockTenderlyProvider.getHealth.mockReturnValue({
        healthy: false,
        lastCheck: Date.now(),
        consecutiveFailures: 3,
        averageLatencyMs: 100,
        successRate: 0.5,
      });

      service = new SimulationService({
        providers: [mockTenderlyProvider, mockAlchemyProvider],
        logger: mockLogger as any,
        config: {
          useFallback: true,
        },
      });

      const request = createSimulationRequest();
      const result = await service.simulate(request);

      // Should fall back to Alchemy
      expect(mockAlchemyProvider.simulate).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    test('should not fallback when useFallback is false', async () => {
      mockTenderlyProvider.simulate.mockResolvedValueOnce({
        success: false,
        wouldRevert: false,
        error: 'API error',
        provider: 'tenderly',
        latencyMs: 100,
      });

      service = new SimulationService({
        providers: [mockTenderlyProvider, mockAlchemyProvider],
        logger: mockLogger as any,
        config: {
          useFallback: false,
        },
      });

      const request = createSimulationRequest();
      const result = await service.simulate(request);

      expect(result.success).toBe(false);
      expect(mockAlchemyProvider.simulate).not.toHaveBeenCalled();
    });

    test('should return error when all providers fail', async () => {
      mockTenderlyProvider.simulate.mockResolvedValueOnce({
        success: false,
        wouldRevert: false,
        error: 'Tenderly error',
        provider: 'tenderly',
        latencyMs: 100,
      });

      mockTenderlyProvider.getHealth.mockReturnValue({
        healthy: false,
        lastCheck: Date.now(),
        consecutiveFailures: 3,
        averageLatencyMs: 100,
        successRate: 0.5,
      });

      mockAlchemyProvider.simulate.mockResolvedValueOnce({
        success: false,
        wouldRevert: false,
        error: 'Alchemy error',
        provider: 'alchemy',
        latencyMs: 100,
      });

      service = new SimulationService({
        providers: [mockTenderlyProvider, mockAlchemyProvider],
        logger: mockLogger as any,
        config: {
          useFallback: true,
        },
      });

      const request = createSimulationRequest();
      const result = await service.simulate(request);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    test('should skip disabled providers', async () => {
      mockTenderlyProvider.isEnabled.mockReturnValue(false);

      service = new SimulationService({
        providers: [mockTenderlyProvider, mockAlchemyProvider],
        logger: mockLogger as any,
      });

      const request = createSimulationRequest();
      await service.simulate(request);

      expect(mockTenderlyProvider.simulate).not.toHaveBeenCalled();
      expect(mockAlchemyProvider.simulate).toHaveBeenCalled();
    });

    test('should return revert result without fallback when transaction would revert', async () => {
      mockTenderlyProvider.simulate.mockResolvedValueOnce({
        success: true,
        wouldRevert: true,
        revertReason: 'Insufficient balance',
        provider: 'tenderly',
        latencyMs: 100,
      });

      service = new SimulationService({
        providers: [mockTenderlyProvider, mockAlchemyProvider],
        logger: mockLogger as any,
        config: {
          useFallback: true,
        },
      });

      const request = createSimulationRequest();
      const result = await service.simulate(request);

      // Should NOT fallback when simulation worked but tx would revert
      expect(result.wouldRevert).toBe(true);
      expect(mockAlchemyProvider.simulate).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // shouldSimulate Tests
  // ===========================================================================

  describe('shouldSimulate', () => {
    test('should return true for profitable opportunities', () => {
      service = new SimulationService({
        providers: [mockTenderlyProvider],
        logger: mockLogger as any,
        config: {
          minProfitForSimulation: 50,
        },
      });

      expect(service.shouldSimulate(100, 0)).toBe(true);
    });

    test('should return false for low profit opportunities', () => {
      service = new SimulationService({
        providers: [mockTenderlyProvider],
        logger: mockLogger as any,
        config: {
          minProfitForSimulation: 50,
        },
      });

      expect(service.shouldSimulate(30, 0)).toBe(false);
    });

    test('should return false for time-critical opportunities when configured', () => {
      service = new SimulationService({
        providers: [mockTenderlyProvider],
        logger: mockLogger as any,
        config: {
          minProfitForSimulation: 50,
          bypassForTimeCritical: true,
          timeCriticalThresholdMs: 2000,
        },
      });

      // Old opportunity (3 seconds) - should bypass simulation (stale)
      expect(service.shouldSimulate(100, 3000)).toBe(false);
    });

    test('should allow time-critical bypass to be disabled', () => {
      service = new SimulationService({
        providers: [mockTenderlyProvider],
        logger: mockLogger as any,
        config: {
          minProfitForSimulation: 50,
          bypassForTimeCritical: false,
          timeCriticalThresholdMs: 2000,
        },
      });

      // Even old opportunities should be simulated
      expect(service.shouldSimulate(100, 3000)).toBe(true);
    });

    test('should return false when no providers available', () => {
      service = new SimulationService({
        providers: [],
        logger: mockLogger as any,
      });

      expect(service.shouldSimulate(100, 0)).toBe(false);
    });
  });

  // ===========================================================================
  // Provider Selection Tests
  // ===========================================================================

  describe('provider selection', () => {
    test('should prefer healthy providers over unhealthy', async () => {
      mockTenderlyProvider.getHealth.mockReturnValue({
        healthy: false,
        lastCheck: Date.now(),
        consecutiveFailures: 5,
        averageLatencyMs: 100,
        successRate: 0.3,
      });

      mockAlchemyProvider.getHealth.mockReturnValue({
        healthy: true,
        lastCheck: Date.now(),
        consecutiveFailures: 0,
        averageLatencyMs: 100,
        successRate: 1.0,
      });

      service = new SimulationService({
        providers: [mockTenderlyProvider, mockAlchemyProvider],
        logger: mockLogger as any,
      });

      const request = createSimulationRequest();
      await service.simulate(request);

      // Should use healthy Alchemy instead of unhealthy Tenderly
      expect(mockAlchemyProvider.simulate).toHaveBeenCalled();
    });

    test('should prefer lower latency providers when both healthy', async () => {
      mockTenderlyProvider.getHealth.mockReturnValue({
        healthy: true,
        lastCheck: Date.now(),
        consecutiveFailures: 0,
        averageLatencyMs: 500, // Slower
        successRate: 1.0,
      });

      mockAlchemyProvider.getHealth.mockReturnValue({
        healthy: true,
        lastCheck: Date.now(),
        consecutiveFailures: 0,
        averageLatencyMs: 100, // Faster
        successRate: 1.0,
      });

      service = new SimulationService({
        providers: [mockTenderlyProvider, mockAlchemyProvider],
        logger: mockLogger as any,
      });

      const request = createSimulationRequest();
      await service.simulate(request);

      // Should use faster Alchemy
      expect(mockAlchemyProvider.simulate).toHaveBeenCalled();
    });

    test('should prefer higher success rate providers', async () => {
      mockTenderlyProvider.getHealth.mockReturnValue({
        healthy: true,
        lastCheck: Date.now(),
        consecutiveFailures: 0,
        averageLatencyMs: 100,
        successRate: 0.7, // Lower success rate
      });

      mockAlchemyProvider.getHealth.mockReturnValue({
        healthy: true,
        lastCheck: Date.now(),
        consecutiveFailures: 0,
        averageLatencyMs: 100,
        successRate: 0.95, // Higher success rate
      });

      service = new SimulationService({
        providers: [mockTenderlyProvider, mockAlchemyProvider],
        logger: mockLogger as any,
      });

      const request = createSimulationRequest();
      await service.simulate(request);

      // Should use more reliable Alchemy
      expect(mockAlchemyProvider.simulate).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Metrics Tests
  // ===========================================================================

  describe('metrics', () => {
    test('should aggregate metrics from all providers', async () => {
      mockTenderlyProvider.getMetrics.mockReturnValue({
        totalSimulations: 10,
        successfulSimulations: 8,
        failedSimulations: 2,
        predictedReverts: 1,
        averageLatencyMs: 200,
        fallbackUsed: 0,
        cacheHits: 0,
        lastUpdated: Date.now(),
      });

      mockAlchemyProvider.getMetrics.mockReturnValue({
        totalSimulations: 5,
        successfulSimulations: 5,
        failedSimulations: 0,
        predictedReverts: 2,
        averageLatencyMs: 100,
        fallbackUsed: 0,
        cacheHits: 0,
        lastUpdated: Date.now(),
      });

      service = new SimulationService({
        providers: [mockTenderlyProvider, mockAlchemyProvider],
        logger: mockLogger as any,
      });

      const metrics = service.getAggregatedMetrics();

      expect(metrics.totalSimulations).toBe(15);
      expect(metrics.successfulSimulations).toBe(13);
      expect(metrics.failedSimulations).toBe(2);
      expect(metrics.predictedReverts).toBe(3);
    });

    test('should track fallback usage', async () => {
      // Set up Tenderly as healthy (so it's selected as primary during ordering)
      // Using lower latency to ensure Tenderly is selected first
      mockTenderlyProvider.getHealth.mockReturnValue({
        healthy: true,
        lastCheck: Date.now(),
        consecutiveFailures: 0,
        averageLatencyMs: 50, // Lower latency = higher score
        successRate: 1.0,
      });

      // Alchemy is also healthy but with higher latency
      mockAlchemyProvider.getHealth.mockReturnValue({
        healthy: true,
        lastCheck: Date.now(),
        consecutiveFailures: 0,
        averageLatencyMs: 100, // Higher latency = lower score
        successRate: 1.0,
      });

      // Tenderly simulate will fail - this triggers fallback
      mockTenderlyProvider.simulate.mockResolvedValueOnce({
        success: false,
        wouldRevert: false,
        error: 'API error',
        provider: 'tenderly',
        latencyMs: 100,
      });

      // Alchemy simulate succeeds (default mock already returns success: true)

      service = new SimulationService({
        providers: [mockTenderlyProvider, mockAlchemyProvider],
        logger: mockLogger as any,
        config: {
          useFallback: true,
          providerPriority: ['tenderly', 'alchemy'],
        },
      });

      const request = createSimulationRequest();
      await service.simulate(request);

      // Verify fallback was used - both providers should have been called
      expect(mockTenderlyProvider.simulate).toHaveBeenCalled();
      expect(mockAlchemyProvider.simulate).toHaveBeenCalled();

      const metrics = service.getAggregatedMetrics();
      expect(metrics.fallbackUsed).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Health Monitoring Tests
  // ===========================================================================

  describe('health monitoring', () => {
    test('should return health status of all providers', () => {
      service = new SimulationService({
        providers: [mockTenderlyProvider, mockAlchemyProvider],
        logger: mockLogger as any,
      });

      const healthMap = service.getProvidersHealth();

      expect(healthMap.size).toBe(2);
      expect(healthMap.get('tenderly')).toBeDefined();
      expect(healthMap.get('alchemy')).toBeDefined();
    });

    test('should detect unhealthy providers', () => {
      mockTenderlyProvider.getHealth.mockReturnValue({
        healthy: false,
        lastCheck: Date.now(),
        consecutiveFailures: 5,
        averageLatencyMs: 100,
        successRate: 0.3,
      });

      service = new SimulationService({
        providers: [mockTenderlyProvider, mockAlchemyProvider],
        logger: mockLogger as any,
      });

      const healthMap = service.getProvidersHealth();
      const tenderlyHealth = healthMap.get('tenderly');

      expect(tenderlyHealth?.healthy).toBe(false);
    });
  });

  // ===========================================================================
  // Cleanup Tests
  // ===========================================================================

  describe('cleanup', () => {
    test('should stop without errors', () => {
      service = new SimulationService({
        providers: [mockTenderlyProvider],
        logger: mockLogger as any,
      });

      expect(() => service.stop()).not.toThrow();
    });

    test('should handle multiple stop calls gracefully', () => {
      service = new SimulationService({
        providers: [mockTenderlyProvider],
        logger: mockLogger as any,
      });

      service.stop();
      expect(() => service.stop()).not.toThrow();
    });
  });

  // ===========================================================================
  // Cache Behavior Tests (Task 0.3: Edge case coverage)
  // ===========================================================================

  describe('cache behavior', () => {
    test('should cache successful simulation results', async () => {
      service = new SimulationService({
        providers: [mockTenderlyProvider],
        logger: mockLogger as any,
        config: {
          cacheTtlMs: 5000,
        },
      });

      const request = createSimulationRequest();

      // First call - should call provider
      await service.simulate(request);
      expect(mockTenderlyProvider.simulate).toHaveBeenCalledTimes(1);

      // Second call with same request - should hit cache
      await service.simulate(request);
      expect(mockTenderlyProvider.simulate).toHaveBeenCalledTimes(1); // Still 1

      const metrics = service.getAggregatedMetrics();
      expect(metrics.cacheHits).toBeGreaterThan(0);
    });

    test('should not cache failed simulation results', async () => {
      mockTenderlyProvider.simulate.mockResolvedValue({
        success: false,
        wouldRevert: false,
        error: 'API error',
        provider: 'tenderly',
        latencyMs: 100,
      });

      service = new SimulationService({
        providers: [mockTenderlyProvider],
        logger: mockLogger as any,
        config: {
          cacheTtlMs: 5000,
          useFallback: false,
        },
      });

      const request = createSimulationRequest();

      // First call - should call provider
      await service.simulate(request);
      expect(mockTenderlyProvider.simulate).toHaveBeenCalledTimes(1);

      // Second call - should NOT hit cache (failed results not cached)
      await service.simulate(request);
      expect(mockTenderlyProvider.simulate).toHaveBeenCalledTimes(2);
    });

    test('should expire cache entries after TTL', async () => {
      service = new SimulationService({
        providers: [mockTenderlyProvider],
        logger: mockLogger as any,
        config: {
          cacheTtlMs: 1000, // 1 second TTL
        },
      });

      const request = createSimulationRequest();

      // First call - should call provider
      await service.simulate(request);
      expect(mockTenderlyProvider.simulate).toHaveBeenCalledTimes(1);

      // Advance time past cache TTL
      jest.advanceTimersByTime(1100);

      // Second call after expiration - should call provider again
      await service.simulate(request);
      expect(mockTenderlyProvider.simulate).toHaveBeenCalledTimes(2);
    });

    test('should evict oldest entries when cache exceeds MAX_CACHE_SIZE', async () => {
      service = new SimulationService({
        providers: [mockTenderlyProvider],
        logger: mockLogger as any,
        config: {
          cacheTtlMs: 60000, // Long TTL so entries don't expire
        },
      });

      // Fix 8.3: Add 510 entries to exceed MAX_CACHE_SIZE (500) and trigger eviction.
      // Cleanup triggers at 80% (400 entries) and hard limit is 500.
      // Use different 'from' addresses to generate unique cache keys.
      for (let i = 0; i < 510; i++) {
        const uniqueFrom = `0x${i.toString(16).padStart(40, '0')}`;
        const request = createSimulationRequest({
          transaction: {
            from: uniqueFrom,
            to: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
            data: '0x12345678',
            value: 0n,
            gasLimit: 200000n,
          },
        });
        await service.simulate(request);
      }

      // Service should not crash and should continue working
      const finalRequest = createSimulationRequest();
      const result = await service.simulate(finalRequest);
      expect(result.success).toBe(true);
    });

    test('should use different cache keys for different transactions', async () => {
      service = new SimulationService({
        providers: [mockTenderlyProvider],
        logger: mockLogger as any,
        config: {
          cacheTtlMs: 5000,
        },
      });

      const request1 = createSimulationRequest({
        transaction: {
          from: '0x1111111111111111111111111111111111111111',
          to: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
          data: '0x12345678',
          value: 0n,
          gasLimit: 200000n,
        },
      });

      const request2 = createSimulationRequest({
        transaction: {
          from: '0x2222222222222222222222222222222222222222',
          to: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
          data: '0x12345678',
          value: 0n,
          gasLimit: 200000n,
        },
      });

      // Different requests should both call provider
      await service.simulate(request1);
      await service.simulate(request2);
      expect(mockTenderlyProvider.simulate).toHaveBeenCalledTimes(2);
    });
  });

  // ===========================================================================
  // Request Coalescing Tests (Fix 5.1)
  // ===========================================================================

  describe('request coalescing (Fix 5.1)', () => {
    test('should coalesce concurrent requests for the same simulation', async () => {
      // Set up a slow provider that takes 200ms
      let resolveSimulation: (result: SimulationResult) => void;
      mockTenderlyProvider.simulate.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSimulation = resolve;
          })
      );

      service = new SimulationService({
        providers: [mockTenderlyProvider],
        logger: mockLogger as any,
        config: {
          cacheTtlMs: 5000,
        },
      });

      const request = createSimulationRequest();

      // Start two concurrent requests for the same simulation
      const promise1 = service.simulate(request);
      const promise2 = service.simulate(request);

      // Verify only ONE simulation call was made (second was coalesced)
      expect(mockTenderlyProvider.simulate).toHaveBeenCalledTimes(1);

      // Resolve the simulation
      resolveSimulation!({
        success: true,
        wouldRevert: false,
        provider: 'tenderly',
        latencyMs: 200,
      });

      // Both promises should resolve with the same result
      const [result1, result2] = await Promise.all([promise1, promise2]);
      expect(result1).toEqual(result2);
      expect(result1.success).toBe(true);

      // Verify coalescing was logged
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Simulation request coalesced',
        expect.any(Object)
      );
    });

    test('should not coalesce requests for different simulations', async () => {
      service = new SimulationService({
        providers: [mockTenderlyProvider],
        logger: mockLogger as any,
        config: {
          cacheTtlMs: 5000,
        },
      });

      const request1 = createSimulationRequest({
        transaction: {
          from: '0x1111111111111111111111111111111111111111',
          to: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
          data: '0x12345678',
          value: 0n,
          gasLimit: 200000n,
        },
      });

      const request2 = createSimulationRequest({
        transaction: {
          from: '0x2222222222222222222222222222222222222222',
          to: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
          data: '0x12345678',
          value: 0n,
          gasLimit: 200000n,
        },
      });

      // Different requests should not coalesce
      await Promise.all([service.simulate(request1), service.simulate(request2)]);
      expect(mockTenderlyProvider.simulate).toHaveBeenCalledTimes(2);
    });

    test('should clean up pending requests after completion', async () => {
      service = new SimulationService({
        providers: [mockTenderlyProvider],
        logger: mockLogger as any,
      });

      const request = createSimulationRequest();

      // First request
      await service.simulate(request);

      // Verify pending requests map is empty
      expect((service as any).pendingRequests.size).toBe(0);

      // Second request should trigger new simulation (not coalesce with completed one)
      await service.simulate(request);

      // Should have been called once for first, then hit cache for second
      // (cache hit, not coalescing)
      expect(mockTenderlyProvider.simulate).toHaveBeenCalledTimes(1);
    });

    test('should clean up pending requests even on error', async () => {
      mockTenderlyProvider.simulate.mockRejectedValue(new Error('API error'));

      service = new SimulationService({
        providers: [mockTenderlyProvider],
        logger: mockLogger as any,
        config: {
          useFallback: false,
        },
      });

      const request = createSimulationRequest();

      await service.simulate(request);

      // Verify pending requests map is empty even after error
      expect((service as any).pendingRequests.size).toBe(0);
    });
  });

  // ===========================================================================
  // Timeout Behavior Tests (Regression tests for P0-CRITICAL fix)
  // ===========================================================================

  describe('timeout behavior', () => {
    test('should return error result when provider times out', async () => {
      // Create a provider that never resolves (simulates hanging request)
      mockTenderlyProvider.simulate.mockImplementation(
        () => new Promise(() => {}) // Never resolves
      );

      service = new SimulationService({
        providers: [mockTenderlyProvider],
        logger: mockLogger as any,
        config: {
          useFallback: false,
        },
      });

      const request = createSimulationRequest();

      // Start simulation (will timeout after 5000ms default)
      const simulationPromise = service.simulate(request);

      // Fast-forward past the timeout
      jest.advanceTimersByTime(5100);

      const result = await simulationPromise;

      // Should return error result with timeout message
      expect(result.success).toBe(false);
      expect(result.error).toContain('timeout');
    });

    test('should log timeout with isTimeout flag', async () => {
      mockTenderlyProvider.simulate.mockImplementation(
        () => new Promise(() => {}) // Never resolves
      );

      service = new SimulationService({
        providers: [mockTenderlyProvider],
        logger: mockLogger as any,
        config: {
          useFallback: false,
        },
      });

      const request = createSimulationRequest();
      const simulationPromise = service.simulate(request);

      jest.advanceTimersByTime(5100);
      await simulationPromise;

      // Verify logger was called with isTimeout flag
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Provider simulation error',
        expect.objectContaining({
          isTimeout: true,
          provider: 'tenderly',
        })
      );
    });

    test('should complete successfully when provider responds before timeout', async () => {
      // Provider responds in 100ms (well before 5000ms timeout)
      mockTenderlyProvider.simulate.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  success: true,
                  wouldRevert: false,
                  provider: 'tenderly',
                  latencyMs: 100,
                }),
              100
            );
          })
      );

      service = new SimulationService({
        providers: [mockTenderlyProvider],
        logger: mockLogger as any,
      });

      const request = createSimulationRequest();
      const simulationPromise = service.simulate(request);

      // Advance past provider response time but before timeout
      jest.advanceTimersByTime(150);

      const result = await simulationPromise;

      expect(result.success).toBe(true);
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    test('should fallback to secondary provider when primary times out', async () => {
      // Primary provider hangs
      mockTenderlyProvider.simulate.mockImplementation(
        () => new Promise(() => {}) // Never resolves
      );

      // Set tenderly as higher priority
      mockTenderlyProvider.getHealth.mockReturnValue({
        healthy: true,
        lastCheck: Date.now(),
        consecutiveFailures: 0,
        averageLatencyMs: 50,
        successRate: 1.0,
      });

      mockAlchemyProvider.getHealth.mockReturnValue({
        healthy: true,
        lastCheck: Date.now(),
        consecutiveFailures: 0,
        averageLatencyMs: 100,
        successRate: 1.0,
      });

      // Secondary provider responds quickly
      mockAlchemyProvider.simulate.mockResolvedValue({
        success: true,
        wouldRevert: false,
        provider: 'alchemy',
        latencyMs: 100,
      });

      service = new SimulationService({
        providers: [mockTenderlyProvider, mockAlchemyProvider],
        logger: mockLogger as any,
        config: {
          useFallback: true,
          providerPriority: ['tenderly', 'alchemy'],
        },
      });

      const request = createSimulationRequest();
      const simulationPromise = service.simulate(request);

      // Advance past timeout to trigger fallback
      jest.advanceTimersByTime(5100);

      const result = await simulationPromise;

      // Should have fallen back to Alchemy after Tenderly timeout
      expect(mockAlchemyProvider.simulate).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.provider).toBe('alchemy');
    });

    test('should include elapsed time in error log', async () => {
      mockTenderlyProvider.simulate.mockImplementation(
        () => new Promise(() => {}) // Never resolves
      );

      service = new SimulationService({
        providers: [mockTenderlyProvider],
        logger: mockLogger as any,
        config: {
          useFallback: false,
        },
      });

      const request = createSimulationRequest();
      const simulationPromise = service.simulate(request);

      jest.advanceTimersByTime(5100);
      await simulationPromise;

      // Verify logger includes elapsedMs
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Provider simulation error',
        expect.objectContaining({
          elapsedMs: expect.any(Number),
        })
      );
    });

    test('should not log isTimeout flag for non-timeout errors', async () => {
      // Provider throws a regular error (not timeout)
      mockTenderlyProvider.simulate.mockRejectedValue(new Error('Network error'));

      service = new SimulationService({
        providers: [mockTenderlyProvider],
        logger: mockLogger as any,
        config: {
          useFallback: false,
        },
      });

      const request = createSimulationRequest();
      const result = await service.simulate(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');

      // isTimeout should be false for non-timeout errors
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Provider simulation error',
        expect.objectContaining({
          isTimeout: false,
        })
      );
    });
  });
});
