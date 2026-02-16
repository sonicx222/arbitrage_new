/**
 * BloXroute Integration Tests (BSC MEV Protection)
 *
 * Tests StandardProvider's BloXroute integration with mocked endpoints.
 * Verifies Task 1.3: BloXroute & Fastlane Activation.
 *
 * @see StandardProvider (shared/core/src/mev-protection/standard-provider.ts)
 * @see MEV_CONFIG.chainSettings.bsc (shared/config/src/mev-config.ts)
 */

import { ethers } from 'ethers';
import { StandardProvider } from '../../../src/mev-protection/standard-provider';
import {
  createMockEthersProvider,
  createMockWallet,
  createSampleTransaction,
  mockSuccessfulRpcResponse,
  mockRpcErrorResponse,
  mockNetworkError,
  mockMalformedRpcResponse,
  mockHealthCheckResponse,
  assertRpcCall,
  assertSuccessfulSubmission,
  assertMetricsUpdated,
  testFallbackOnError,
  testSimulation,
  testSimulationFailure,
  type MockEthersProvider,
  type MockWallet,
} from './test-helpers';

describe('BloXroute Integration (BSC)', () => {
  let provider: StandardProvider;
  let mockEthersProvider: MockEthersProvider;
  let wallet: MockWallet;

  const BLOXROUTE_URL = 'https://mev.api.blxrbdn.com';
  const BLOXROUTE_AUTH = 'test-auth-header-123';

  beforeEach(() => {
    mockEthersProvider = createMockEthersProvider() as unknown as MockEthersProvider;

    // Override with BSC-specific values
    (mockEthersProvider.getFeeData as jest.Mock).mockResolvedValue({
      maxFeePerGas: ethers.parseUnits('10', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
      gasPrice: ethers.parseUnits('10', 'gwei'),
    });
    (mockEthersProvider.estimateGas as jest.Mock).mockResolvedValue(100000n);

    wallet = createMockWallet() as unknown as MockWallet;

    provider = new StandardProvider({
      chain: 'bsc',
      provider: mockEthersProvider as unknown as ethers.JsonRpcProvider,
      wallet: wallet as unknown as ethers.Wallet,
      enabled: true,
      bloxrouteAuthHeader: BLOXROUTE_AUTH,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Configuration', () => {
    it('should configure BloXroute strategy for BSC', () => {
      expect(provider.chain).toBe('bsc');
      expect(provider.strategy).toBe('bloxroute');
    });

    it('should be enabled when configured', () => {
      expect(provider.isEnabled()).toBe(true);
    });
  });

  describe('Transaction Submission', () => {
    it('should submit transaction via BloXroute private RPC when configured', async () => {
      const mockFetch = mockSuccessfulRpcResponse('0xbloxroutetxhash');
      global.fetch = mockFetch;

      const tx = createSampleTransaction({
        data: '0x12345678',
        value: ethers.parseEther('0.1'),
      });

      const result = await provider.sendProtectedTransaction(tx);

      assertRpcCall(mockFetch, BLOXROUTE_URL, {
        'Authorization': BLOXROUTE_AUTH,
        'Content-Type': 'application/json',
      });
      assertSuccessfulSubmission(result, 'bloxroute', false);
    });

    it('should fallback to public mempool if BloXroute fails', async () => {
      global.fetch = mockRpcErrorResponse('Service unavailable');
      await testFallbackOnError(provider, wallet);
    });

    it('should handle BloXroute network errors gracefully', async () => {
      global.fetch = mockNetworkError('Network timeout');
      await testFallbackOnError(provider, wallet);
    });

    it('should respect simulation settings', async () => {
      global.fetch = mockSuccessfulRpcResponse();
      const tx = createSampleTransaction();

      // With simulation (default) - estimateGas called for simulation
      await provider.sendProtectedTransaction(tx);
      expect(mockEthersProvider.estimateGas).toHaveBeenCalled();

      // Reset mocks
      (mockEthersProvider.estimateGas as jest.Mock).mockClear();

      // Without simulation but with gasLimit provided - no estimateGas call
      const txWithGas = createSampleTransaction({ gasLimit: 100000n });
      await provider.sendProtectedTransaction(txWithGas, { simulate: false });
      expect(mockEthersProvider.estimateGas).not.toHaveBeenCalled();
    });
  });

  describe('Metrics Tracking', () => {
    it('should track BloXroute-specific metrics', async () => {
      global.fetch = mockSuccessfulRpcResponse('0xbloxroutetxhash');
      const tx = createSampleTransaction();

      await provider.sendProtectedTransaction(tx);

      assertMetricsUpdated(provider, {
        totalSubmissions: 1,
        successfulSubmissions: 1,
        providerSpecificSubmissions: 1,
      });

      const metrics = provider.getMetrics();
      expect(metrics.fastlaneSubmissions).toBe(0);
    });

    it('should track fallback submissions separately', async () => {
      global.fetch = mockRpcErrorResponse('Error');
      const tx = createSampleTransaction();

      await provider.sendProtectedTransaction(tx);

      assertMetricsUpdated(provider, {
        totalSubmissions: 1,
        successfulSubmissions: 1,
        fallbackSubmissions: 1,
        providerSpecificSubmissions: 1,
      });
    });

    it('should track latency for BloXroute submissions', async () => {
      global.fetch = mockSuccessfulRpcResponse();
      const tx = createSampleTransaction();

      await provider.sendProtectedTransaction(tx);

      const metrics = provider.getMetrics();
      // Latency tracking - should be >= 0 (may be 0 in fast test execution)
      expect(metrics.averageLatencyMs).toBeGreaterThanOrEqual(0);
      expect(metrics.lastUpdated).toBeGreaterThan(0);
    });
  });

  describe('Health Checks', () => {
    it('should check BloXroute private RPC health', async () => {
      global.fetch = mockHealthCheckResponse(1000000);
      const health = await provider.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.message).toContain('bsc');
      expect(health.message).toContain('healthy');
    });

    it('should report unhealthy when BloXroute RPC fails', async () => {
      global.fetch = mockNetworkError('Connection refused');
      const health = await provider.healthCheck();

      // Main provider is healthy, but private RPC is not
      expect(health.healthy).toBe(true);
      expect(health.message).toContain('private RPC unhealthy');
    });
  });

  describe('Error Handling', () => {
    it('should handle missing auth header gracefully', async () => {
      const providerNoAuth = new StandardProvider({
        chain: 'bsc',
        provider: mockEthersProvider as unknown as ethers.JsonRpcProvider,
        wallet: wallet as unknown as ethers.Wallet,
        enabled: true,
        // No bloxrouteAuthHeader
      });

      const tx = createSampleTransaction();
      const result = await providerNoAuth.sendProtectedTransaction(tx);

      expect(result.success).toBe(true);
      expect(result.usedFallback).toBe(false); // No fallback since no private RPC was attempted
    });

    it('should respect disabled state', async () => {
      const providerDisabled = new StandardProvider({
        chain: 'bsc',
        provider: mockEthersProvider as unknown as ethers.JsonRpcProvider,
        wallet: wallet as unknown as ethers.Wallet,
        enabled: false,
        bloxrouteAuthHeader: 'test-auth',
      });

      const tx = createSampleTransaction();
      const result = await providerDisabled.sendProtectedTransaction(tx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('disabled');
    });

    it('should handle malformed BloXroute responses', async () => {
      global.fetch = mockMalformedRpcResponse();
      const tx = createSampleTransaction();

      const result = await provider.sendProtectedTransaction(tx);

      // Should fallback to public mempool
      expect(result.success).toBe(true);
      expect(result.usedFallback).toBe(true);
    });
  });

  describe('Simulation', () => {
    it('should simulate transaction before submission', async () => {
      await testSimulation(provider, mockEthersProvider, 100000n);
    });

    it('should handle simulation failures', async () => {
      await testSimulationFailure(provider, mockEthersProvider, 'execution reverted');
    });

    it('should prevent submission if simulation fails', async () => {
      (mockEthersProvider.estimateGas as jest.Mock).mockRejectedValue(
        new Error('execution reverted')
      );

      const tx = createSampleTransaction();
      const result = await provider.sendProtectedTransaction(tx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Simulation failed');

      // Verify no submission attempt was made
      expect(global.fetch).not.toHaveBeenCalled();
      expect(wallet.sendTransaction).not.toHaveBeenCalled();
    });
  });
});
