/**
 * Timeboost Provider Tests (Arbitrum MEV Protection)
 *
 * Tests TimeboostProvider's express lane integration with mocked endpoints.
 * Verifies Batch 5: L2 MEV Protection - Timeboost.
 *
 * @see TimeboostProvider (shared/core/src/mev-protection/timeboost-provider.ts)
 */

import { ethers } from 'ethers';
import { TimeboostProvider } from '../../../src/mev-protection/timeboost-provider';
import {
  createMockEthersProvider,
  createMockWallet,
  createSampleTransaction,
  mockSuccessfulRpcResponse,
  mockRpcErrorResponse,
  mockNetworkError,
  type MockEthersProvider,
  type MockWallet,
} from './test-helpers';

describe('TimeboostProvider (Arbitrum)', () => {
  let mockEthersProvider: MockEthersProvider;
  let wallet: MockWallet;
  const originalEnv = process.env;

  const EXPRESS_LANE_URL = 'https://timeboost-auctioneer.arbitrum.io/api/v1/express_lane';

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };

    mockEthersProvider = createMockEthersProvider() as unknown as MockEthersProvider;

    // Override with Arbitrum-specific values
    (mockEthersProvider.getFeeData as jest.Mock).mockResolvedValue({
      maxFeePerGas: ethers.parseUnits('0.1', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('0.01', 'gwei'),
      gasPrice: ethers.parseUnits('0.1', 'gwei'),
    });
    (mockEthersProvider.estimateGas as jest.Mock).mockResolvedValue(100000n);

    wallet = createMockWallet() as unknown as MockWallet;
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  function createProvider(overrides?: Partial<{ enabled: boolean; timeboostExpressLaneUrl: string }>): TimeboostProvider {
    return new TimeboostProvider({
      chain: 'arbitrum',
      provider: mockEthersProvider as unknown as ethers.JsonRpcProvider,
      wallet: wallet as unknown as ethers.Wallet,
      enabled: overrides?.enabled ?? true,
      timeboostExpressLaneUrl: overrides?.timeboostExpressLaneUrl,
    });
  }

  // ===========================================================================
  // Configuration
  // ===========================================================================

  describe('Configuration', () => {
    it('should configure timeboost strategy for Arbitrum', () => {
      const provider = createProvider();
      expect(provider.chain).toBe('arbitrum');
      expect(provider.strategy).toBe('timeboost');
    });

    it('should throw for non-Arbitrum chains', () => {
      expect(() => {
        new TimeboostProvider({
          chain: 'ethereum',
          provider: mockEthersProvider as unknown as ethers.JsonRpcProvider,
          wallet: wallet as unknown as ethers.Wallet,
          enabled: true,
        });
      }).toThrow('TimeboostProvider is only for Arbitrum');
    });

    it('should use custom express lane URL when provided', () => {
      const customUrl = 'https://custom-timeboost.example.com/api';
      const provider = createProvider({ timeboostExpressLaneUrl: customUrl });
      expect(provider.chain).toBe('arbitrum');
      // Provider should be created without error - URL is used internally
    });
  });

  // ===========================================================================
  // Feature Gate (isEnabled)
  // ===========================================================================

  describe('isEnabled', () => {
    it('should return false when FEATURE_TIMEBOOST is not set', () => {
      delete process.env.FEATURE_TIMEBOOST;
      const provider = createProvider();
      expect(provider.isEnabled()).toBe(false);
    });

    it('should return false when FEATURE_TIMEBOOST is not "true"', () => {
      process.env.FEATURE_TIMEBOOST = 'false';
      const provider = createProvider();
      expect(provider.isEnabled()).toBe(false);
    });

    it('should return true when FEATURE_TIMEBOOST is "true"', () => {
      process.env.FEATURE_TIMEBOOST = 'true';
      const provider = createProvider();
      expect(provider.isEnabled()).toBe(true);
    });

    it('should return false when provider is disabled even if feature flag is set', () => {
      process.env.FEATURE_TIMEBOOST = 'true';
      const provider = createProvider({ enabled: false });
      expect(provider.isEnabled()).toBe(false);
    });
  });

  // ===========================================================================
  // Transaction Submission - Feature Disabled
  // ===========================================================================

  describe('sendProtectedTransaction (feature disabled)', () => {
    it('should fall back to sequencer when FEATURE_TIMEBOOST is not set', async () => {
      delete process.env.FEATURE_TIMEBOOST;
      const provider = createProvider();

      const tx = createSampleTransaction();
      const result = await provider.sendProtectedTransaction(tx);

      // Should succeed via sequencer (wallet.sendTransaction)
      expect(result.success).toBe(true);
      expect(result.strategy).toBe('timeboost');
      expect(result.usedFallback).toBe(false); // Direct sequencer, not a "fallback"
      expect(wallet.sendTransaction).toHaveBeenCalled();
    });

    it('should return failure when provider is disabled', async () => {
      const provider = createProvider({ enabled: false });

      const tx = createSampleTransaction();
      const result = await provider.sendProtectedTransaction(tx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('disabled');
    });
  });

  // ===========================================================================
  // Transaction Submission - Feature Enabled
  // ===========================================================================

  describe('sendProtectedTransaction (feature enabled)', () => {
    beforeEach(() => {
      process.env.FEATURE_TIMEBOOST = 'true';
    });

    it('should submit to express lane when enabled', async () => {
      const mockFetch = mockSuccessfulRpcResponse('0xtimeboosttxhash');
      global.fetch = mockFetch;

      const provider = createProvider();
      const tx = createSampleTransaction();
      const result = await provider.sendProtectedTransaction(tx);

      // Verify fetch was called with express lane URL
      expect(mockFetch).toHaveBeenCalledWith(
        EXPRESS_LANE_URL,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
          body: expect.any(String),
        })
      );

      // Verify JSON-RPC method
      const callArgs = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(callArgs[1].body);
      expect(requestBody.method).toBe('timeboost_sendExpressLaneTransaction');

      expect(result.success).toBe(true);
      expect(result.strategy).toBe('timeboost');
    });

    it('should fall back to sequencer on express lane failure', async () => {
      global.fetch = mockRpcErrorResponse('Express lane auction failed');

      const provider = createProvider();
      const tx = createSampleTransaction();
      const result = await provider.sendProtectedTransaction(tx);

      // Should fall back to sequencer
      expect(result.success).toBe(true);
      expect(result.usedFallback).toBe(true);
      expect(wallet.sendTransaction).toHaveBeenCalled();
    });

    it('should fall back to sequencer on network error', async () => {
      global.fetch = mockNetworkError('Connection refused');

      const provider = createProvider();
      const tx = createSampleTransaction();
      const result = await provider.sendProtectedTransaction(tx);

      // Should fall back to sequencer
      expect(result.success).toBe(true);
      expect(result.usedFallback).toBe(true);
      expect(wallet.sendTransaction).toHaveBeenCalled();
    });

    it('should not fall back when fallbackToPublic is disabled', async () => {
      global.fetch = mockRpcErrorResponse('Express lane error');

      const provider = new TimeboostProvider({
        chain: 'arbitrum',
        provider: mockEthersProvider as unknown as ethers.JsonRpcProvider,
        wallet: wallet as unknown as ethers.Wallet,
        enabled: true,
        fallbackToPublic: false,
      });

      const tx = createSampleTransaction();
      const result = await provider.sendProtectedTransaction(tx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Fallback disabled');
      expect(wallet.sendTransaction).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Simulation
  // ===========================================================================

  describe('Simulation', () => {
    it('should simulate transaction successfully', async () => {
      const provider = createProvider();
      const tx = createSampleTransaction();
      const simResult = await provider.simulateTransaction(tx);

      expect(simResult.success).toBe(true);
      expect(simResult.gasUsed).toBe(100000n);
      expect(mockEthersProvider.estimateGas).toHaveBeenCalled();
    });

    it('should handle simulation failures', async () => {
      (mockEthersProvider.estimateGas as jest.Mock).mockRejectedValue(
        new Error('execution reverted')
      );

      const provider = createProvider();
      const tx = createSampleTransaction();
      const simResult = await provider.simulateTransaction(tx);

      expect(simResult.success).toBe(false);
      expect(simResult.error).toContain('execution reverted');
    });

    it('should prevent submission if simulation fails', async () => {
      delete process.env.FEATURE_TIMEBOOST;
      (mockEthersProvider.estimateGas as jest.Mock).mockRejectedValue(
        new Error('execution reverted')
      );

      const provider = createProvider();
      const tx = createSampleTransaction();
      const result = await provider.sendProtectedTransaction(tx);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Simulation failed');
      expect(wallet.sendTransaction).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Metrics
  // ===========================================================================

  describe('Metrics', () => {
    it('should track successful submissions', async () => {
      delete process.env.FEATURE_TIMEBOOST;
      const provider = createProvider();
      const tx = createSampleTransaction();

      await provider.sendProtectedTransaction(tx);

      const metrics = provider.getMetrics();
      expect(metrics.totalSubmissions).toBe(1);
      expect(metrics.successfulSubmissions).toBe(1);
      expect(metrics.failedSubmissions).toBe(0);
    });

    it('should track latency', async () => {
      delete process.env.FEATURE_TIMEBOOST;
      const provider = createProvider();
      const tx = createSampleTransaction();

      await provider.sendProtectedTransaction(tx);

      const metrics = provider.getMetrics();
      expect(metrics.averageLatencyMs).toBeGreaterThanOrEqual(0);
      expect(metrics.lastUpdated).toBeGreaterThan(0);
    });

    it('should not increment metrics when disabled', async () => {
      const provider = createProvider({ enabled: false });
      const tx = createSampleTransaction();

      await provider.sendProtectedTransaction(tx);

      const metrics = provider.getMetrics();
      expect(metrics.totalSubmissions).toBe(0);
    });
  });

  // ===========================================================================
  // Health Check
  // ===========================================================================

  describe('Health Check', () => {
    it('should report healthy when sequencer is reachable and Timeboost not enabled', async () => {
      delete process.env.FEATURE_TIMEBOOST;
      const provider = createProvider();
      const health = await provider.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.message).toContain('Timeboost not enabled');
    });

    it('should check express lane health when Timeboost is enabled', async () => {
      process.env.FEATURE_TIMEBOOST = 'true';

      // Mock express lane health check (HEAD request)
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
      });

      const provider = createProvider();
      const health = await provider.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.message).toContain('Timeboost healthy');
      expect(health.message).toContain('Express lane reachable');
    });

    it('should report healthy with warning when express lane is unreachable', async () => {
      process.env.FEATURE_TIMEBOOST = 'true';

      global.fetch = mockNetworkError('Connection refused');

      const provider = createProvider();
      const health = await provider.healthCheck();

      // Base provider is healthy, express lane is not
      expect(health.healthy).toBe(true);
      expect(health.message).toContain('express lane unhealthy');
    });

    it('should report unhealthy when sequencer is unreachable', async () => {
      (mockEthersProvider.getBlockNumber as jest.Mock).mockRejectedValue(
        new Error('Connection failed')
      );

      const provider = createProvider();
      const health = await provider.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.message).toContain('Failed to reach Arbitrum sequencer');
    });
  });
});
