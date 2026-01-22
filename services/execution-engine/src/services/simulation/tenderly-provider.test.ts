/**
 * TenderlyProvider Unit Tests
 *
 * Tests the Tenderly simulation provider implementation following TDD.
 * Tests are written BEFORE implementation.
 */

// @ts-nocheck - Test file with mock objects that don't need strict typing
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { ethers } from 'ethers';
import { TenderlyProvider } from './tenderly-provider';
import type {
  SimulationProviderConfig,
  SimulationRequest,
  SimulationResult,
} from './types';

// =============================================================================
// Mock Factories
// =============================================================================

const createMockProvider = () => ({
  getBlockNumber: jest.fn(() => Promise.resolve(18500000)),
  getNetwork: jest.fn(() => Promise.resolve({ chainId: 1n, name: 'mainnet' })),
});

const createValidConfig = (overrides: Partial<SimulationProviderConfig> = {}): SimulationProviderConfig => ({
  type: 'tenderly',
  chain: 'ethereum',
  provider: createMockProvider() as unknown as ethers.JsonRpcProvider,
  enabled: true,
  apiKey: 'test-api-key',
  apiSecret: 'test-api-secret',
  accountSlug: 'test-account',
  projectSlug: 'test-project',
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

describe('TenderlyProvider', () => {
  let provider: TenderlyProvider;
  let mockFetch: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock global fetch
    mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
    global.fetch = mockFetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ===========================================================================
  // Constructor Tests
  // ===========================================================================

  describe('constructor', () => {
    test('should initialize with valid config', () => {
      const config = createValidConfig();
      provider = new TenderlyProvider(config);

      expect(provider.type).toBe('tenderly');
      expect(provider.chain).toBe('ethereum');
      expect(provider.isEnabled()).toBe(true);
    });

    test('should throw error if apiKey is missing when enabled', () => {
      const config = createValidConfig({ apiKey: undefined });

      expect(() => new TenderlyProvider(config)).toThrow('Tenderly API key is required');
    });

    test('should throw error if accountSlug is missing when enabled', () => {
      const config = createValidConfig({ accountSlug: undefined });

      expect(() => new TenderlyProvider(config)).toThrow('Tenderly account slug is required');
    });

    test('should throw error if projectSlug is missing when enabled', () => {
      const config = createValidConfig({ projectSlug: undefined });

      expect(() => new TenderlyProvider(config)).toThrow('Tenderly project slug is required');
    });

    test('should allow missing credentials when disabled', () => {
      const config = createValidConfig({
        enabled: false,
        apiKey: undefined,
        accountSlug: undefined,
        projectSlug: undefined,
      });

      provider = new TenderlyProvider(config);
      expect(provider.isEnabled()).toBe(false);
    });
  });

  // ===========================================================================
  // isEnabled Tests
  // ===========================================================================

  describe('isEnabled', () => {
    test('should return true when enabled in config', () => {
      provider = new TenderlyProvider(createValidConfig({ enabled: true }));
      expect(provider.isEnabled()).toBe(true);
    });

    test('should return false when disabled in config', () => {
      provider = new TenderlyProvider(createValidConfig({ enabled: false }));
      expect(provider.isEnabled()).toBe(false);
    });
  });

  // ===========================================================================
  // simulate Tests
  // ===========================================================================

  describe('simulate', () => {
    test('should return success result for successful transaction', async () => {
      provider = new TenderlyProvider(createValidConfig());

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            simulation: {
              status: true,
              gas_used: 150000,
              block_number: 18500000,
            },
            transaction: {
              transaction_info: {
                call_trace: {
                  output: '0x0000000000000000000000000000000000000000000000000000000000000001',
                },
              },
            },
          }),
      });

      const request = createSimulationRequest();
      const result = await provider.simulate(request);

      expect(result.success).toBe(true);
      expect(result.wouldRevert).toBe(false);
      expect(result.gasUsed).toBe(150000n);
      expect(result.provider).toBe('tenderly');
      expect(result.blockNumber).toBe(18500000);
    });

    test('should return revert result for reverting transaction', async () => {
      provider = new TenderlyProvider(createValidConfig());

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            simulation: {
              status: false,
              gas_used: 50000,
              error_message: 'execution reverted: Insufficient balance',
              block_number: 18500000,
            },
            transaction: {
              transaction_info: {
                call_trace: {
                  error: 'execution reverted',
                },
              },
            },
          }),
      });

      const request = createSimulationRequest();
      const result = await provider.simulate(request);

      expect(result.success).toBe(true); // Simulation succeeded (API call worked)
      expect(result.wouldRevert).toBe(true); // But transaction would revert
      expect(result.revertReason).toContain('Insufficient balance');
      expect(result.provider).toBe('tenderly');
    });

    test('should return error result on API failure', async () => {
      provider = new TenderlyProvider(createValidConfig());

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const request = createSimulationRequest();
      const result = await provider.simulate(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain('500');
      expect(result.provider).toBe('tenderly');
    });

    test('should return error result on network timeout', async () => {
      provider = new TenderlyProvider(createValidConfig({ timeoutMs: 100 }));

      mockFetch.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve({} as Response), 200))
      );

      const request = createSimulationRequest();
      const result = await provider.simulate(request);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.provider).toBe('tenderly');
    });

    test('should include state changes when requested', async () => {
      provider = new TenderlyProvider(createValidConfig());

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            simulation: {
              status: true,
              gas_used: 150000,
              block_number: 18500000,
            },
            transaction: {
              transaction_info: {
                state_diff: [
                  {
                    address: '0xdead',
                    original: '0x100',
                    dirty: '0x200',
                  },
                ],
                call_trace: {
                  output: '0x01',
                },
              },
            },
          }),
      });

      const request = createSimulationRequest({ includeStateChanges: true });
      const result = await provider.simulate(request);

      expect(result.success).toBe(true);
      expect(result.stateChanges).toBeDefined();
      expect(result.stateChanges?.length).toBeGreaterThan(0);
    });

    test('should include logs when requested', async () => {
      provider = new TenderlyProvider(createValidConfig());

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            simulation: {
              status: true,
              gas_used: 150000,
              block_number: 18500000,
            },
            transaction: {
              transaction_info: {
                logs: [
                  {
                    address: '0xdead',
                    topics: ['0xabc'],
                    data: '0x123',
                  },
                ],
                call_trace: {
                  output: '0x01',
                },
              },
            },
          }),
      });

      const request = createSimulationRequest({ includeLogs: true });
      const result = await provider.simulate(request);

      expect(result.success).toBe(true);
      expect(result.logs).toBeDefined();
      expect(result.logs?.length).toBeGreaterThan(0);
    });

    test('should track latency in result', async () => {
      provider = new TenderlyProvider(createValidConfig());

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            simulation: {
              status: true,
              gas_used: 150000,
              block_number: 18500000,
            },
            transaction: {
              transaction_info: {
                call_trace: { output: '0x01' },
              },
            },
          }),
      });

      const request = createSimulationRequest();
      const result = await provider.simulate(request);

      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    test('should use correct chain ID in request', async () => {
      provider = new TenderlyProvider(createValidConfig({ chain: 'arbitrum' }));

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            simulation: { status: true, gas_used: 150000 },
            transaction: { transaction_info: { call_trace: { output: '0x01' } } },
          }),
      });

      const request = createSimulationRequest({ chain: 'arbitrum' });
      await provider.simulate(request);

      expect(mockFetch).toHaveBeenCalled();
      const fetchCall = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(fetchCall[1].body as string);
      expect(body.network_id).toBe('42161'); // Arbitrum chain ID
    });
  });

  // ===========================================================================
  // Metrics Tests
  // ===========================================================================

  describe('metrics', () => {
    test('should track successful simulations', async () => {
      provider = new TenderlyProvider(createValidConfig());

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            simulation: { status: true, gas_used: 150000 },
            transaction: { transaction_info: { call_trace: { output: '0x01' } } },
          }),
      });

      await provider.simulate(createSimulationRequest());
      await provider.simulate(createSimulationRequest());

      const metrics = provider.getMetrics();
      expect(metrics.totalSimulations).toBe(2);
      expect(metrics.successfulSimulations).toBe(2);
    });

    test('should track failed simulations', async () => {
      provider = new TenderlyProvider(createValidConfig());

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Error',
      });

      await provider.simulate(createSimulationRequest());

      const metrics = provider.getMetrics();
      expect(metrics.totalSimulations).toBe(1);
      expect(metrics.failedSimulations).toBe(1);
    });

    test('should track predicted reverts', async () => {
      provider = new TenderlyProvider(createValidConfig());

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            simulation: { status: false, gas_used: 50000, error_message: 'revert' },
            transaction: { transaction_info: { call_trace: { error: 'revert' } } },
          }),
      });

      await provider.simulate(createSimulationRequest());

      const metrics = provider.getMetrics();
      expect(metrics.predictedReverts).toBe(1);
    });

    test('should calculate average latency', async () => {
      provider = new TenderlyProvider(createValidConfig());

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            simulation: { status: true, gas_used: 150000 },
            transaction: { transaction_info: { call_trace: { output: '0x01' } } },
          }),
      });

      await provider.simulate(createSimulationRequest());
      await provider.simulate(createSimulationRequest());

      const metrics = provider.getMetrics();
      expect(metrics.averageLatencyMs).toBeGreaterThanOrEqual(0);
    });

    test('should reset metrics correctly', async () => {
      provider = new TenderlyProvider(createValidConfig());

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            simulation: { status: true, gas_used: 150000 },
            transaction: { transaction_info: { call_trace: { output: '0x01' } } },
          }),
      });

      await provider.simulate(createSimulationRequest());
      provider.resetMetrics();

      const metrics = provider.getMetrics();
      expect(metrics.totalSimulations).toBe(0);
      expect(metrics.successfulSimulations).toBe(0);
    });
  });

  // ===========================================================================
  // Health Tests
  // ===========================================================================

  describe('health', () => {
    test('should start with healthy status', () => {
      provider = new TenderlyProvider(createValidConfig());

      const health = provider.getHealth();
      expect(health.healthy).toBe(true);
      expect(health.consecutiveFailures).toBe(0);
    });

    test('should mark unhealthy after consecutive failures', async () => {
      provider = new TenderlyProvider(createValidConfig());

      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Error',
      });

      // Simulate 3 consecutive failures
      await provider.simulate(createSimulationRequest());
      await provider.simulate(createSimulationRequest());
      await provider.simulate(createSimulationRequest());

      const health = provider.getHealth();
      expect(health.healthy).toBe(false);
      expect(health.consecutiveFailures).toBe(3);
    });

    test('should recover after successful simulation', async () => {
      provider = new TenderlyProvider(createValidConfig());

      // First: failures
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      await provider.simulate(createSimulationRequest());
      await provider.simulate(createSimulationRequest());
      await provider.simulate(createSimulationRequest());

      // Then: success
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            simulation: { status: true, gas_used: 150000 },
            transaction: { transaction_info: { call_trace: { output: '0x01' } } },
          }),
      });

      await provider.simulate(createSimulationRequest());

      const health = provider.getHealth();
      expect(health.healthy).toBe(true);
      expect(health.consecutiveFailures).toBe(0);
    });

    test('should track success rate', async () => {
      provider = new TenderlyProvider(createValidConfig());

      // 2 successes, 2 failures = 50% success rate
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            simulation: { status: true, gas_used: 150000 },
            transaction: { transaction_info: { call_trace: { output: '0x01' } } },
          }),
      });
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            simulation: { status: true, gas_used: 150000 },
            transaction: { transaction_info: { call_trace: { output: '0x01' } } },
          }),
      });
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      await provider.simulate(createSimulationRequest());
      await provider.simulate(createSimulationRequest());
      await provider.simulate(createSimulationRequest());
      await provider.simulate(createSimulationRequest());

      const health = provider.getHealth();
      expect(health.successRate).toBeCloseTo(0.5, 1);
    });
  });

  // ===========================================================================
  // healthCheck Tests
  // ===========================================================================

  describe('healthCheck', () => {
    test('should return healthy when API is reachable', async () => {
      provider = new TenderlyProvider(createValidConfig());

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: 'ok' }),
      });

      const result = await provider.healthCheck();
      expect(result.healthy).toBe(true);
    });

    test('should return unhealthy when API is not reachable', async () => {
      provider = new TenderlyProvider(createValidConfig());

      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await provider.healthCheck();
      expect(result.healthy).toBe(false);
      expect(result.message).toContain('Network error');
    });

    test('should return unhealthy when API returns error', async () => {
      provider = new TenderlyProvider(createValidConfig());

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });

      const result = await provider.healthCheck();
      expect(result.healthy).toBe(false);
      expect(result.message).toContain('401');
    });
  });
});
