/**
 * LocalSimulationProvider Unit Tests
 *
 * Tests the local simulation provider that uses eth_call for basic simulation.
 *
 * Fix 2.2/8.1: Comprehensive tests for LocalSimulationProvider.
 *
 * @see local-provider.ts
 */

// @ts-nocheck - Test file with mock objects that don't need strict typing
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { ethers } from 'ethers';
import { LocalSimulationProvider, createLocalProvider } from './local-provider';
import type {
  SimulationProviderConfig,
  SimulationRequest,
  SimulationResult,
} from './types';

// =============================================================================
// Mock Factories
// =============================================================================

const createMockProvider = () => ({
  getBlockNumber: jest.fn().mockResolvedValue(18500000),
  getNetwork: jest.fn().mockResolvedValue({ chainId: 1n, name: 'mainnet' }),
  call: jest.fn().mockResolvedValue('0x0001'),
  send: jest.fn().mockResolvedValue('0x0001'),
});

const createValidConfig = (
  overrides: Partial<SimulationProviderConfig> = {}
): SimulationProviderConfig => ({
  type: 'local',
  chain: 'ethereum',
  provider: createMockProvider() as unknown as ethers.JsonRpcProvider,
  enabled: true,
  timeoutMs: 5000,
  ...overrides,
});

const createSimulationRequest = (
  overrides: Partial<SimulationRequest> = {}
): SimulationRequest => ({
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

describe('LocalSimulationProvider', () => {
  let provider: LocalSimulationProvider;
  let mockRpcProvider: ReturnType<typeof createMockProvider>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRpcProvider = createMockProvider();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ===========================================================================
  // Constructor Tests
  // ===========================================================================

  describe('constructor', () => {
    test('should initialize with valid config', () => {
      provider = new LocalSimulationProvider(
        createValidConfig({ provider: mockRpcProvider as unknown as ethers.JsonRpcProvider })
      );

      expect(provider.type).toBe('local');
      expect(provider.chain).toBe('ethereum');
      expect(provider.isEnabled()).toBe(true);
    });

    test('should throw error when provider is not provided', () => {
      expect(() => {
        new LocalSimulationProvider(
          createValidConfig({ provider: undefined as unknown as ethers.JsonRpcProvider })
        );
      }).toThrow('LocalSimulationProvider requires a JsonRpcProvider');
    });

    test('should respect enabled flag', () => {
      provider = new LocalSimulationProvider(
        createValidConfig({
          provider: mockRpcProvider as unknown as ethers.JsonRpcProvider,
          enabled: false,
        })
      );

      expect(provider.isEnabled()).toBe(false);
    });
  });

  // ===========================================================================
  // simulate() Tests
  // ===========================================================================

  describe('simulate', () => {
    beforeEach(() => {
      provider = new LocalSimulationProvider(
        createValidConfig({ provider: mockRpcProvider as unknown as ethers.JsonRpcProvider })
      );
    });

    test('should return success result for successful eth_call', async () => {
      mockRpcProvider.call.mockResolvedValueOnce('0x0001');

      const result = await provider.simulate(createSimulationRequest());

      expect(result.success).toBe(true);
      expect(result.wouldRevert).toBe(false);
      expect(result.returnValue).toBe('0x0001');
      expect(result.provider).toBe('local');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    test('should return error result when disabled', async () => {
      const disabledProvider = new LocalSimulationProvider(
        createValidConfig({
          provider: mockRpcProvider as unknown as ethers.JsonRpcProvider,
          enabled: false,
        })
      );

      const result = await disabledProvider.simulate(createSimulationRequest());

      expect(result.success).toBe(false);
      expect(result.error).toContain('disabled');
    });

    test('should return revert result for reverted transaction', async () => {
      mockRpcProvider.call.mockRejectedValueOnce(
        new Error('execution reverted: Insufficient balance')
      );

      const result = await provider.simulate(createSimulationRequest());

      expect(result.success).toBe(true);
      expect(result.wouldRevert).toBe(true);
      expect(result.revertReason).toBeDefined();
    });

    test('should return error result for network errors', async () => {
      mockRpcProvider.call.mockRejectedValueOnce(new Error('network timeout'));

      const result = await provider.simulate(createSimulationRequest());

      expect(result.success).toBe(false);
      expect(result.wouldRevert).toBe(false);
      expect(result.error).toContain('network timeout');
    });

    test('should handle out of gas errors as reverts', async () => {
      mockRpcProvider.call.mockRejectedValueOnce(new Error('out of gas'));

      const result = await provider.simulate(createSimulationRequest());

      expect(result.success).toBe(true);
      expect(result.wouldRevert).toBe(true);
    });

    test('should handle insufficient funds errors as reverts', async () => {
      mockRpcProvider.call.mockRejectedValueOnce(new Error('insufficient funds'));

      const result = await provider.simulate(createSimulationRequest());

      expect(result.success).toBe(true);
      expect(result.wouldRevert).toBe(true);
    });

    test('should include latency in result', async () => {
      mockRpcProvider.call.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve('0x0001'), 50))
      );

      const result = await provider.simulate(createSimulationRequest());

      expect(result.latencyMs).toBeGreaterThanOrEqual(50);
    });

    test('should extract revert reason from error message', async () => {
      mockRpcProvider.call.mockRejectedValueOnce(
        new Error("execution reverted with reason string 'Custom error message'")
      );

      const result = await provider.simulate(createSimulationRequest());

      expect(result.success).toBe(true);
      expect(result.wouldRevert).toBe(true);
      expect(result.revertReason).toBe('Custom error message');
    });
  });

  // ===========================================================================
  // State Override Tests (Fix 7.2)
  // ===========================================================================

  describe('state overrides', () => {
    beforeEach(() => {
      provider = new LocalSimulationProvider(
        createValidConfig({ provider: mockRpcProvider as unknown as ethers.JsonRpcProvider })
      );
    });

    test('should call eth_call with state overrides', async () => {
      mockRpcProvider.send.mockResolvedValueOnce('0x0001');

      const request = createSimulationRequest({
        stateOverrides: {
          '0x1234567890123456789012345678901234567890': {
            balance: 1000000000000000000n,
          },
        },
      });

      const result = await provider.simulate(request);

      expect(mockRpcProvider.send).toHaveBeenCalledWith(
        'eth_call',
        expect.arrayContaining([
          expect.any(Object),
          expect.any(String),
          expect.objectContaining({
            '0x1234567890123456789012345678901234567890': expect.objectContaining({
              balance: expect.any(String),
            }),
          }),
        ])
      );
      expect(result.success).toBe(true);
    });

    test('should handle nonce override', async () => {
      mockRpcProvider.send.mockResolvedValueOnce('0x0001');

      const request = createSimulationRequest({
        stateOverrides: {
          '0x1234567890123456789012345678901234567890': {
            nonce: 100,
          },
        },
      });

      await provider.simulate(request);

      expect(mockRpcProvider.send).toHaveBeenCalledWith(
        'eth_call',
        expect.arrayContaining([
          expect.any(Object),
          expect.any(String),
          expect.objectContaining({
            '0x1234567890123456789012345678901234567890': expect.objectContaining({
              nonce: '0x64', // 100 in hex
            }),
          }),
        ])
      );
    });

    test('should handle code override', async () => {
      mockRpcProvider.send.mockResolvedValueOnce('0x0001');

      const request = createSimulationRequest({
        stateOverrides: {
          '0x1234567890123456789012345678901234567890': {
            code: '0x600160015500',
          },
        },
      });

      await provider.simulate(request);

      expect(mockRpcProvider.send).toHaveBeenCalledWith(
        'eth_call',
        expect.arrayContaining([
          expect.any(Object),
          expect.any(String),
          expect.objectContaining({
            '0x1234567890123456789012345678901234567890': expect.objectContaining({
              code: '0x600160015500',
            }),
          }),
        ])
      );
    });

    test('should not use state overrides when empty', async () => {
      mockRpcProvider.call.mockResolvedValueOnce('0x0001');

      const request = createSimulationRequest({
        stateOverrides: {},
      });

      await provider.simulate(request);

      // Should use provider.call instead of provider.send
      expect(mockRpcProvider.call).toHaveBeenCalled();
      expect(mockRpcProvider.send).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Health Check Tests
  // ===========================================================================

  describe('healthCheck', () => {
    beforeEach(() => {
      provider = new LocalSimulationProvider(
        createValidConfig({ provider: mockRpcProvider as unknown as ethers.JsonRpcProvider })
      );
    });

    test('should return healthy when provider responds', async () => {
      mockRpcProvider.getBlockNumber.mockResolvedValueOnce(18500000);

      const result = await provider.healthCheck();

      expect(result.healthy).toBe(true);
      expect(result.message).toContain('healthy');
      expect(result.message).toContain('18500000');
    });

    test('should return unhealthy when provider fails', async () => {
      mockRpcProvider.getBlockNumber.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await provider.healthCheck();

      expect(result.healthy).toBe(false);
      expect(result.message).toContain('unhealthy');
      expect(result.message).toContain('Connection refused');
    });
  });

  // ===========================================================================
  // Metrics Tests
  // ===========================================================================

  describe('metrics tracking', () => {
    beforeEach(() => {
      provider = new LocalSimulationProvider(
        createValidConfig({ provider: mockRpcProvider as unknown as ethers.JsonRpcProvider })
      );
    });

    test('should track successful simulations', async () => {
      mockRpcProvider.call.mockResolvedValue('0x0001');

      await provider.simulate(createSimulationRequest());
      await provider.simulate(createSimulationRequest());

      const metrics = provider.getMetrics();
      expect(metrics.totalSimulations).toBe(2);
      expect(metrics.successfulSimulations).toBe(2);
      expect(metrics.failedSimulations).toBe(0);
    });

    test('should track failed simulations', async () => {
      mockRpcProvider.call.mockRejectedValue(new Error('network error'));

      await provider.simulate(createSimulationRequest());

      const metrics = provider.getMetrics();
      expect(metrics.totalSimulations).toBe(1);
      expect(metrics.failedSimulations).toBe(1);
      expect(metrics.successfulSimulations).toBe(0);
    });

    test('should track predicted reverts', async () => {
      mockRpcProvider.call.mockRejectedValue(new Error('execution reverted'));

      await provider.simulate(createSimulationRequest());

      const metrics = provider.getMetrics();
      expect(metrics.predictedReverts).toBe(1);
    });

    test('should reset metrics correctly', async () => {
      mockRpcProvider.call.mockResolvedValue('0x0001');

      await provider.simulate(createSimulationRequest());
      provider.resetMetrics();

      const metrics = provider.getMetrics();
      expect(metrics.totalSimulations).toBe(0);
    });
  });

  // ===========================================================================
  // Health Status Tests
  // ===========================================================================

  describe('health status tracking', () => {
    beforeEach(() => {
      provider = new LocalSimulationProvider(
        createValidConfig({ provider: mockRpcProvider as unknown as ethers.JsonRpcProvider })
      );
    });

    test('should start with unknown health status', () => {
      const health = provider.getHealth();
      expect(health.healthy).toBe(false);
      expect(health.successRate).toBe(0);
    });

    test('should become healthy after successful simulation', async () => {
      mockRpcProvider.call.mockResolvedValue('0x0001');

      await provider.simulate(createSimulationRequest());

      const health = provider.getHealth();
      expect(health.healthy).toBe(true);
    });

    test('should track consecutive failures', async () => {
      mockRpcProvider.call.mockRejectedValue(new Error('network error'));

      await provider.simulate(createSimulationRequest());
      await provider.simulate(createSimulationRequest());
      await provider.simulate(createSimulationRequest());

      const health = provider.getHealth();
      expect(health.consecutiveFailures).toBe(3);
    });

    test('should reset consecutive failures on success', async () => {
      mockRpcProvider.call.mockRejectedValue(new Error('network error'));
      await provider.simulate(createSimulationRequest());
      await provider.simulate(createSimulationRequest());

      mockRpcProvider.call.mockResolvedValue('0x0001');
      await provider.simulate(createSimulationRequest());

      const health = provider.getHealth();
      expect(health.consecutiveFailures).toBe(0);
    });
  });

  // ===========================================================================
  // Factory Function Tests
  // ===========================================================================

  describe('createLocalProvider factory', () => {
    test('should create provider with factory function', () => {
      const provider = createLocalProvider(
        createValidConfig({ provider: mockRpcProvider as unknown as ethers.JsonRpcProvider })
      );

      expect(provider).toBeInstanceOf(LocalSimulationProvider);
      expect(provider.type).toBe('local');
    });
  });
});
