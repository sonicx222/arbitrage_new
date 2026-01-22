/**
 * SimulationService Unit Tests
 *
 * Tests the simulation service that manages multiple providers
 * with health scoring and automatic fallback.
 */

// @ts-nocheck - Test file with mock objects that don't need strict typing
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { ethers } from 'ethers';
import { SimulationService } from './simulation.service';
import type {
  ISimulationProvider,
  SimulationRequest,
  SimulationResult,
  SimulationProviderHealth,
  SimulationMetrics,
  SimulationServiceConfig,
  SimulationProviderType,
} from './types';

// =============================================================================
// Mock Provider Factory
// =============================================================================

type MockedProvider = {
  type: SimulationProviderType;
  chain: string;
  isEnabled: jest.Mock;
  simulate: jest.Mock;
  getHealth: jest.Mock;
  getMetrics: jest.Mock;
  resetMetrics: jest.Mock;
  healthCheck: jest.Mock;
};

const createMockProvider = (
  type: SimulationProviderType,
  _overrides: Partial<ISimulationProvider> = {}
): MockedProvider => ({
  type,
  chain: 'ethereum',
  isEnabled: jest.fn().mockReturnValue(true),
  simulate: jest.fn().mockResolvedValue({
    success: true,
    wouldRevert: false,
    provider: type,
    latencyMs: 100,
  } as SimulationResult),
  getHealth: jest.fn().mockReturnValue({
    healthy: true,
    lastCheck: Date.now(),
    consecutiveFailures: 0,
    averageLatencyMs: 100,
    successRate: 1.0,
  } as SimulationProviderHealth),
  getMetrics: jest.fn().mockReturnValue({
    totalSimulations: 0,
    successfulSimulations: 0,
    failedSimulations: 0,
    predictedReverts: 0,
    averageLatencyMs: 0,
    fallbackUsed: 0,
    cacheHits: 0,
    lastUpdated: Date.now(),
  } as SimulationMetrics),
  resetMetrics: jest.fn(),
  healthCheck: jest.fn().mockResolvedValue({ healthy: true, message: 'OK' }),
});

const createMockLogger = () => ({
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
  let mockLogger: ReturnType<typeof createMockLogger>;

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
});
