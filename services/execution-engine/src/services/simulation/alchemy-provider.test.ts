/**
 * AlchemySimulationProvider Unit Tests
 *
 * Tests the Alchemy simulation provider implementation following TDD.
 * Tests are written BEFORE implementation.
 */

// @ts-nocheck - Test file with mock objects that don't need strict typing
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { ethers } from 'ethers';
import { AlchemySimulationProvider } from './alchemy-provider';
import type {
  SimulationProviderConfig,
  SimulationRequest,
} from './types';

// =============================================================================
// Mock Factories
// =============================================================================

const createMockProvider = () => ({
  getBlockNumber: jest.fn(() => Promise.resolve(18500000)),
  getNetwork: jest.fn(() => Promise.resolve({ chainId: 1n, name: 'mainnet' })),
  send: jest.fn(),
});

const createValidConfig = (overrides: Partial<SimulationProviderConfig> = {}): SimulationProviderConfig => ({
  type: 'alchemy',
  chain: 'ethereum',
  provider: createMockProvider() as unknown as ethers.JsonRpcProvider,
  enabled: true,
  apiKey: 'test-alchemy-api-key',
  apiUrl: 'https://eth-mainnet.g.alchemy.com',
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

// Helper to create mock Response
const createMockResponse = (options: {
  ok: boolean;
  status?: number;
  statusText?: string;
  json?: () => Promise<unknown>;
}): Partial<Response> => ({
  ok: options.ok,
  status: options.status ?? (options.ok ? 200 : 500),
  statusText: options.statusText ?? (options.ok ? 'OK' : 'Error'),
  json: options.json ?? (() => Promise.resolve({})),
});

describe('AlchemySimulationProvider', () => {
  let provider: AlchemySimulationProvider;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock global fetch
    mockFetch = jest.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
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
      provider = new AlchemySimulationProvider(config);

      expect(provider.type).toBe('alchemy');
      expect(provider.chain).toBe('ethereum');
      expect(provider.isEnabled()).toBe(true);
    });

    test('should throw error if apiKey is missing when enabled', () => {
      const config = createValidConfig({ apiKey: undefined });

      expect(() => new AlchemySimulationProvider(config)).toThrow('Alchemy API key is required');
    });

    test('should allow missing apiKey when disabled', () => {
      const config = createValidConfig({
        enabled: false,
        apiKey: undefined,
      });

      provider = new AlchemySimulationProvider(config);
      expect(provider.isEnabled()).toBe(false);
    });
  });

  // ===========================================================================
  // isEnabled Tests
  // ===========================================================================

  describe('isEnabled', () => {
    test('should return true when enabled in config', () => {
      provider = new AlchemySimulationProvider(createValidConfig({ enabled: true }));
      expect(provider.isEnabled()).toBe(true);
    });

    test('should return false when disabled in config', () => {
      provider = new AlchemySimulationProvider(createValidConfig({ enabled: false }));
      expect(provider.isEnabled()).toBe(false);
    });
  });

  // ===========================================================================
  // simulate Tests
  // ===========================================================================

  describe('simulate', () => {
    test('should return success result for successful transaction', async () => {
      provider = new AlchemySimulationProvider(createValidConfig());

      mockFetch.mockResolvedValueOnce(createMockResponse({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            result: '0x0000000000000000000000000000000000000000000000000000000000000001',
          }),
      }));

      const request = createSimulationRequest();
      const result = await provider.simulate(request);

      expect(result.success).toBe(true);
      expect(result.wouldRevert).toBe(false);
      expect(result.provider).toBe('alchemy');
    });

    test('should return revert result for reverting transaction', async () => {
      provider = new AlchemySimulationProvider(createValidConfig());

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            error: {
              code: 3,
              message: 'execution reverted',
              data: '0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000001a496e73756666696369656e7420746f6b656e2062616c616e6365000000000000',
            },
          }),
      });

      const request = createSimulationRequest();
      const result = await provider.simulate(request);

      expect(result.success).toBe(true); // Simulation succeeded (API worked)
      expect(result.wouldRevert).toBe(true); // But transaction would revert
      expect(result.revertReason).toBeDefined();
      expect(result.provider).toBe('alchemy');
    });

    test('should return error result on API failure', async () => {
      provider = new AlchemySimulationProvider(createValidConfig());

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const request = createSimulationRequest();
      const result = await provider.simulate(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain('500');
      expect(result.provider).toBe('alchemy');
    });

    test('should return error result on network timeout', async () => {
      provider = new AlchemySimulationProvider(createValidConfig({ timeoutMs: 100 }));

      mockFetch.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve({} as Response), 200))
      );

      const request = createSimulationRequest();
      const result = await provider.simulate(request);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.provider).toBe('alchemy');
    });

    test('should use alchemy_simulateExecution for detailed simulation', async () => {
      provider = new AlchemySimulationProvider(createValidConfig());

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            result: {
              calls: [
                {
                  status: '0x1',
                  gasUsed: '0x5208',
                  returnData: '0x01',
                },
              ],
            },
          }),
      });

      const request = createSimulationRequest();
      await provider.simulate(request);

      expect(mockFetch).toHaveBeenCalled();
      const fetchCall = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(fetchCall[1].body as string);
      // Check that it uses either eth_call or alchemy_simulateExecution
      expect(['eth_call', 'alchemy_simulateExecution']).toContain(body.method);
    });

    test('should track latency in result', async () => {
      provider = new AlchemySimulationProvider(createValidConfig());

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            result: '0x01',
          }),
      });

      const request = createSimulationRequest();
      const result = await provider.simulate(request);

      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    test('should handle different chain configurations', async () => {
      provider = new AlchemySimulationProvider(createValidConfig({ chain: 'arbitrum' }));

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            result: '0x01',
          }),
      });

      const request = createSimulationRequest({ chain: 'arbitrum' });
      const result = await provider.simulate(request);

      expect(result.success).toBe(true);
    });
  });

  // ===========================================================================
  // Metrics Tests
  // ===========================================================================

  describe('metrics', () => {
    test('should track successful simulations', async () => {
      provider = new AlchemySimulationProvider(createValidConfig());

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            result: '0x01',
          }),
      });

      await provider.simulate(createSimulationRequest());
      await provider.simulate(createSimulationRequest());

      const metrics = provider.getMetrics();
      expect(metrics.totalSimulations).toBe(2);
      expect(metrics.successfulSimulations).toBe(2);
    });

    test('should track failed simulations', async () => {
      provider = new AlchemySimulationProvider(createValidConfig());

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
      provider = new AlchemySimulationProvider(createValidConfig());

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            error: {
              code: 3,
              message: 'execution reverted',
            },
          }),
      });

      await provider.simulate(createSimulationRequest());

      const metrics = provider.getMetrics();
      expect(metrics.predictedReverts).toBe(1);
    });

    test('should calculate average latency', async () => {
      provider = new AlchemySimulationProvider(createValidConfig());

      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            result: '0x01',
          }),
      });

      await provider.simulate(createSimulationRequest());
      await provider.simulate(createSimulationRequest());

      const metrics = provider.getMetrics();
      expect(metrics.averageLatencyMs).toBeGreaterThanOrEqual(0);
    });

    test('should reset metrics correctly', async () => {
      provider = new AlchemySimulationProvider(createValidConfig());

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            result: '0x01',
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
      provider = new AlchemySimulationProvider(createValidConfig());

      const health = provider.getHealth();
      expect(health.healthy).toBe(true);
      expect(health.consecutiveFailures).toBe(0);
    });

    test('should mark unhealthy after consecutive failures', async () => {
      provider = new AlchemySimulationProvider(createValidConfig());

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
      provider = new AlchemySimulationProvider(createValidConfig());

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
            jsonrpc: '2.0',
            id: 1,
            result: '0x01',
          }),
      });

      await provider.simulate(createSimulationRequest());

      const health = provider.getHealth();
      expect(health.healthy).toBe(true);
      expect(health.consecutiveFailures).toBe(0);
    });

    test('should track success rate', async () => {
      provider = new AlchemySimulationProvider(createValidConfig());

      // 2 successes, 2 failures = 50% success rate
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            result: '0x01',
          }),
      });
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            result: '0x01',
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
      provider = new AlchemySimulationProvider(createValidConfig());

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            result: '0x123',
          }),
      });

      const result = await provider.healthCheck();
      expect(result.healthy).toBe(true);
    });

    test('should return unhealthy when API is not reachable', async () => {
      provider = new AlchemySimulationProvider(createValidConfig());

      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await provider.healthCheck();
      expect(result.healthy).toBe(false);
      expect(result.message).toContain('Network error');
    });

    test('should return unhealthy when API returns error', async () => {
      provider = new AlchemySimulationProvider(createValidConfig());

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

  // ===========================================================================
  // Revert Reason Decoding Tests
  // ===========================================================================

  describe('revert reason decoding', () => {
    test('should decode Error(string) revert reason', async () => {
      provider = new AlchemySimulationProvider(createValidConfig());

      // Encoded "Insufficient balance" error
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            error: {
              code: 3,
              message: 'execution reverted',
              data: '0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000001354696e73756666696369656e742062616c616e636500000000000000000000000',
            },
          }),
      });

      const request = createSimulationRequest();
      const result = await provider.simulate(request);

      expect(result.wouldRevert).toBe(true);
      expect(result.revertReason).toBeDefined();
    });

    test('should handle Panic(uint256) revert', async () => {
      provider = new AlchemySimulationProvider(createValidConfig());

      // Panic code 0x11 (overflow)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            error: {
              code: 3,
              message: 'execution reverted',
              data: '0x4e487b710000000000000000000000000000000000000000000000000000000000000011',
            },
          }),
      });

      const request = createSimulationRequest();
      const result = await provider.simulate(request);

      expect(result.wouldRevert).toBe(true);
      expect(result.revertReason).toContain('Panic');
    });

    test('should handle raw revert data', async () => {
      provider = new AlchemySimulationProvider(createValidConfig());

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            jsonrpc: '2.0',
            id: 1,
            error: {
              code: 3,
              message: 'execution reverted',
              data: '0xdeadbeef',
            },
          }),
      });

      const request = createSimulationRequest();
      const result = await provider.simulate(request);

      expect(result.wouldRevert).toBe(true);
      expect(result.revertReason).toBeDefined();
    });
  });
});
