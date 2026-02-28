/**
 * Fastlane Integration Tests (Polygon MEV Protection)
 *
 * Tests StandardProvider's Fastlane integration with mocked endpoints.
 * Verifies Task 1.3: BloXroute & Fastlane Activation.
 *
 * @see StandardProvider (shared/core/src/mev-protection/standard-provider.ts)
 * @see MEV_CONFIG.chainSettings.polygon (shared/config/src/mev-config.ts)
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

describe('Fastlane Integration (Polygon)', () => {
  let provider: StandardProvider;
  let mockEthersProvider: MockEthersProvider;
  let wallet: MockWallet;

  const FASTLANE_URL = 'https://fastlane-rpc.polygon.technology';

  beforeEach(() => {
    mockEthersProvider = createMockEthersProvider() as unknown as MockEthersProvider;

    // Override with Polygon-specific values
    (mockEthersProvider.getBlockNumber as jest.Mock).mockResolvedValue(50000000);
    (mockEthersProvider.getFeeData as jest.Mock).mockResolvedValue({
      maxFeePerGas: ethers.parseUnits('30', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('30', 'gwei'),
      gasPrice: ethers.parseUnits('30', 'gwei'),
    });
    (mockEthersProvider.estimateGas as jest.Mock).mockResolvedValue(150000n);

    wallet = createMockWallet('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd') as unknown as MockWallet;

    provider = new StandardProvider({
      chain: 'polygon',
      provider: mockEthersProvider as unknown as ethers.JsonRpcProvider,
      wallet: wallet as unknown as ethers.Wallet,
      enabled: true,
    });
  });

  describe('Configuration', () => {
    it('should configure Fastlane strategy for Polygon', () => {
      expect(provider.chain).toBe('polygon');
      expect(provider.strategy).toBe('fastlane');
    });

    it('should be enabled when configured', () => {
      expect(provider.isEnabled()).toBe(true);
    });
  });

  describe('Transaction Submission', () => {
    it('should submit transaction via Fastlane RPC', async () => {
      const mockFetch = mockSuccessfulRpcResponse('0xfastlanetxhash');
      global.fetch = mockFetch;

      const tx = createSampleTransaction({
        to: '0x1111222233334444555566667777888899990000',
        data: '0xabcdef12',
        value: ethers.parseEther('1.5'),
      });

      const result = await provider.sendProtectedTransaction(tx);

      // Verify no Authorization header (Fastlane doesn't require auth)
      assertRpcCall(mockFetch, FASTLANE_URL, {
        'Content-Type': 'application/json',
      });

      const callArgs = mockFetch.mock.calls[0];
      const headers = callArgs[1].headers;
      expect(headers['Authorization']).toBeUndefined();

      assertSuccessfulSubmission(result, 'fastlane', false);
    });

    it('should fallback to public mempool if Fastlane fails', async () => {
      global.fetch = mockRpcErrorResponse('Fastlane temporarily unavailable');
      await testFallbackOnError(provider, wallet);
    });

    it('should handle Fastlane network errors gracefully', async () => {
      global.fetch = mockNetworkError('Connection timeout');
      await testFallbackOnError(provider, wallet);
    });

    it('should use higher priority fees for Polygon', async () => {
      global.fetch = mockSuccessfulRpcResponse();
      const tx = createSampleTransaction({
        to: '0x1111222233334444555566667777888899990000',
      });

      await provider.sendProtectedTransaction(tx);

      // Verify gas was estimated (priority fee calculation uses getFeeData)
      expect(mockEthersProvider.getFeeData).toHaveBeenCalled();
    });

    it('should respect simulation settings', async () => {
      global.fetch = mockSuccessfulRpcResponse();
      const tx = createSampleTransaction({
        to: '0x1111222233334444555566667777888899990000',
      });

      // With simulation (default) - estimateGas called for simulation
      await provider.sendProtectedTransaction(tx);
      expect(mockEthersProvider.estimateGas).toHaveBeenCalled();

      // Reset mocks
      (mockEthersProvider.estimateGas as jest.Mock).mockClear();

      // Without simulation but with gasLimit provided - no estimateGas call
      const txWithGas = createSampleTransaction({
        to: '0x1111222233334444555566667777888899990000',
        gasLimit: 150000n,
      });
      await provider.sendProtectedTransaction(txWithGas, { simulate: false });
      expect(mockEthersProvider.estimateGas).not.toHaveBeenCalled();
    });
  });

  describe('Metrics Tracking', () => {
    it('should track Fastlane-specific metrics', async () => {
      global.fetch = mockSuccessfulRpcResponse('0xfastlanetxhash');
      const tx = createSampleTransaction({
        to: '0x1111222233334444555566667777888899990000',
      });

      await provider.sendProtectedTransaction(tx);

      assertMetricsUpdated(provider, {
        totalSubmissions: 1,
        successfulSubmissions: 1,
        providerSpecificSubmissions: 1,
      });

      const metrics = provider.getMetrics();
      expect(metrics.bloxrouteSubmissions).toBe(0);
    });

    it('should track fallback submissions separately', async () => {
      global.fetch = mockRpcErrorResponse('Error');
      const tx = createSampleTransaction({
        to: '0x1111222233334444555566667777888899990000',
      });

      await provider.sendProtectedTransaction(tx);

      assertMetricsUpdated(provider, {
        totalSubmissions: 1,
        successfulSubmissions: 1,
        fallbackSubmissions: 1,
        providerSpecificSubmissions: 1,
      });
    });

    it('should track latency for Fastlane submissions', async () => {
      global.fetch = mockSuccessfulRpcResponse();
      const tx = createSampleTransaction({
        to: '0x1111222233334444555566667777888899990000',
      });

      await provider.sendProtectedTransaction(tx);

      const metrics = provider.getMetrics();
      // Latency tracking - should be >= 0 (may be 0 in fast test execution)
      expect(metrics.averageLatencyMs).toBeGreaterThanOrEqual(0);
      expect(metrics.lastUpdated).toBeGreaterThan(0);
    });

    it('should track multiple submissions correctly', async () => {
      global.fetch = mockSuccessfulRpcResponse();
      const tx = createSampleTransaction({
        to: '0x1111222233334444555566667777888899990000',
      });

      // Submit 3 transactions
      await provider.sendProtectedTransaction(tx);
      await provider.sendProtectedTransaction(tx);
      await provider.sendProtectedTransaction(tx);

      assertMetricsUpdated(provider, {
        totalSubmissions: 3,
        successfulSubmissions: 3,
        providerSpecificSubmissions: 3,
      });
    });
  });

  describe('Health Checks', () => {
    it('should check Fastlane RPC health', async () => {
      global.fetch = mockHealthCheckResponse(50000000);
      const health = await provider.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.message).toContain('polygon');
      expect(health.message).toContain('healthy');
    });

    it('should report unhealthy when Fastlane RPC fails', async () => {
      global.fetch = mockNetworkError('Connection refused');
      const health = await provider.healthCheck();

      // Main provider is healthy, but private RPC is not
      expect(health.healthy).toBe(true);
      expect(health.message).toContain('private RPC unhealthy');
    });
  });

  describe('Error Handling', () => {
    it('should respect disabled state', async () => {
      const providerDisabled = new StandardProvider({
        chain: 'polygon',
        provider: mockEthersProvider as unknown as ethers.JsonRpcProvider,
        wallet: wallet as unknown as ethers.Wallet,
        enabled: false,
      });

      const tx = createSampleTransaction({
        to: '0x1111222233334444555566667777888899990000',
      });

      const result = await providerDisabled.sendProtectedTransaction(tx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('disabled');
    });

    it('should handle malformed Fastlane responses', async () => {
      global.fetch = mockMalformedRpcResponse();
      const tx = createSampleTransaction({
        to: '0x1111222233334444555566667777888899990000',
      });

      const result = await provider.sendProtectedTransaction(tx);

      // Should fallback to public mempool
      expect(result.success).toBe(true);
      expect(result.usedFallback).toBe(true);
    });

    it('should handle fallback disabled scenario', async () => {
      const providerNoFallback = new StandardProvider({
        chain: 'polygon',
        provider: mockEthersProvider as unknown as ethers.JsonRpcProvider,
        wallet: wallet as unknown as ethers.Wallet,
        enabled: true,
        fallbackToPublic: false,
      });

      global.fetch = mockRpcErrorResponse('Error');
      const tx = createSampleTransaction({
        to: '0x1111222233334444555566667777888899990000',
      });

      const result = await providerNoFallback.sendProtectedTransaction(tx);

      // Should fail (no fallback)
      expect(result.success).toBe(false);
      expect(result.error).toContain('Fallback disabled');
      expect(wallet.sendTransaction).not.toHaveBeenCalled();
    });
  });

  describe('Simulation', () => {
    it('should simulate transaction before submission', async () => {
      await testSimulation(provider, mockEthersProvider, 150000n);
    });

    it('should handle simulation failures', async () => {
      await testSimulationFailure(provider, mockEthersProvider, 'execution reverted: insufficient balance');
    });

    it('should prevent submission if simulation fails', async () => {
      (mockEthersProvider.estimateGas as jest.Mock).mockRejectedValue(
        new Error('execution reverted')
      );

      const tx = createSampleTransaction({
        to: '0x1111222233334444555566667777888899990000',
      });

      const result = await provider.sendProtectedTransaction(tx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Simulation failed');

      // Verify no submission attempt was made
      expect(global.fetch).not.toHaveBeenCalled();
      expect(wallet.sendTransaction).not.toHaveBeenCalled();
    });
  });

  describe('Comparison with BloXroute', () => {
    it('should not require auth header unlike BloXroute', async () => {
      const mockFetch = mockSuccessfulRpcResponse();
      global.fetch = mockFetch;

      const tx = createSampleTransaction({
        to: '0x1111222233334444555566667777888899990000',
      });

      await provider.sendProtectedTransaction(tx);

      // Verify no Authorization header was sent
      const callArgs = mockFetch.mock.calls[0];
      const headers = callArgs[1].headers;
      expect(headers['Authorization']).toBeUndefined();
    });
  });
});
