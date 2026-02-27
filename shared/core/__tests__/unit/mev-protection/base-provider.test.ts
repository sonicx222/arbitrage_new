/**
 * Unit Tests for BaseMevProvider
 *
 * H5: Tests the abstract base class via a concrete stub.
 * Validates metrics delegation, nonce handling, gas estimation,
 * fallback configuration, and result factory methods.
 *
 * @see shared/core/src/mev-protection/base-provider.ts
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { ethers } from 'ethers';
import { BaseMevProvider } from '../../../src/mev-protection/base-provider';
import type {
  MevProviderConfig,
  MevSubmissionResult,
  BundleSimulationResult,
  MevStrategy,
} from '../../../src/mev-protection/types';
import { createMockEthersProvider, createMockWallet } from './test-helpers';

// =============================================================================
// Concrete Stub for Abstract Class
// =============================================================================

class StubMevProvider extends BaseMevProvider {
  readonly chain = 'ethereum';
  readonly strategy: MevStrategy = 'flashbots';

  private _enabled = true;

  isEnabled(): boolean {
    return this._enabled;
  }

  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
  }

  async sendProtectedTransaction(): Promise<MevSubmissionResult> {
    return this.createSuccessResult(Date.now(), '0xhash');
  }

  async simulateTransaction(): Promise<BundleSimulationResult> {
    return { success: true, gasUsed: 150000n };
  }

  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    return { healthy: true, message: 'OK' };
  }

  // Expose protected methods for testing
  public async testGetNonce(tx: ethers.TransactionRequest): Promise<number> {
    return this.getNonce(tx);
  }

  public async testGetFeeData(): Promise<ethers.FeeData> {
    return this.getFeeData();
  }

  public async testEstimateGasWithBuffer(
    tx: ethers.TransactionRequest,
    bufferPercent?: number,
    fallbackGas?: bigint
  ): Promise<bigint> {
    return this.estimateGasWithBuffer(tx, bufferPercent, fallbackGas);
  }

  public testIsFallbackEnabled(): boolean {
    return this.isFallbackEnabled();
  }

  public testCreateFailureResult(
    reason: string,
    startTime: number,
    usedFallback?: boolean,
    txHash?: string
  ): MevSubmissionResult {
    return this.createFailureResult(reason, startTime, usedFallback, txHash);
  }

  public testCreateSuccessResult(
    startTime: number,
    txHash: string,
    blockNumber?: number,
    bundleHash?: string,
    usedFallback?: boolean
  ): MevSubmissionResult {
    return this.createSuccessResult(startTime, txHash, blockNumber, bundleHash, usedFallback);
  }

  public async testIncrementMetric(field: 'totalSubmissions' | 'successfulSubmissions' | 'failedSubmissions'): Promise<void> {
    return this.incrementMetric(field);
  }

  public async testBatchUpdateMetrics(
    updates: Record<string, number>,
    startTime?: number
  ): Promise<void> {
    return this.batchUpdateMetrics(updates as any, startTime);
  }
}

// =============================================================================
// Tests
// =============================================================================

describe('BaseMevProvider', () => {
  let provider: StubMevProvider;
  let mockEthersProvider: ethers.JsonRpcProvider;
  let mockWallet: ethers.Wallet;
  let config: MevProviderConfig;

  beforeEach(() => {
    mockEthersProvider = createMockEthersProvider();
    mockWallet = createMockWallet();
    config = {
      chain: 'ethereum',
      provider: mockEthersProvider,
      wallet: mockWallet,
      enabled: true,
    };
    provider = new StubMevProvider(config);
  });

  // ---------------------------------------------------------------------------
  // Metrics
  // ---------------------------------------------------------------------------

  describe('Metrics Management', () => {
    it('should return zeroed metrics initially', () => {
      const metrics = provider.getMetrics();
      expect(metrics.totalSubmissions).toBe(0);
      expect(metrics.successfulSubmissions).toBe(0);
      expect(metrics.failedSubmissions).toBe(0);
      expect(metrics.averageLatencyMs).toBe(0);
    });

    it('should increment metrics via metricsManager', async () => {
      await provider.testIncrementMetric('totalSubmissions');
      await provider.testIncrementMetric('totalSubmissions');
      await provider.testIncrementMetric('successfulSubmissions');

      const metrics = provider.getMetrics();
      expect(metrics.totalSubmissions).toBe(2);
      expect(metrics.successfulSubmissions).toBe(1);
    });

    it('should reset metrics', async () => {
      await provider.testIncrementMetric('totalSubmissions');
      expect(provider.getMetrics().totalSubmissions).toBe(1);

      provider.resetMetrics();
      expect(provider.getMetrics().totalSubmissions).toBe(0);
    });

    it('should batch update metrics atomically', async () => {
      await provider.testBatchUpdateMetrics({
        totalSubmissions: 1,
        successfulSubmissions: 1,
        bundlesIncluded: 1,
      });

      const metrics = provider.getMetrics();
      expect(metrics.totalSubmissions).toBe(1);
      expect(metrics.successfulSubmissions).toBe(1);
      expect(metrics.bundlesIncluded).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Nonce Handling
  // ---------------------------------------------------------------------------

  describe('getNonce', () => {
    it('should return pre-allocated nonce from tx when set', async () => {
      const nonce = await provider.testGetNonce({ nonce: 42 });
      expect(nonce).toBe(42);
    });

    it('should fetch from provider when nonce is not set', async () => {
      const nonce = await provider.testGetNonce({});
      expect(nonce).toBe(5); // mock returns 5
      expect(mockEthersProvider.getTransactionCount).toHaveBeenCalledWith(
        mockWallet.address,
        'pending'
      );
    });

    it('should fetch from provider when nonce is null', async () => {
      const nonce = await provider.testGetNonce({ nonce: null as any });
      expect(nonce).toBe(5);
    });

    it('should convert bigint nonce to number', async () => {
      const nonce = await provider.testGetNonce({ nonce: 7 });
      expect(nonce).toBe(7);
    });
  });

  // ---------------------------------------------------------------------------
  // Gas Estimation
  // ---------------------------------------------------------------------------

  describe('estimateGasWithBuffer', () => {
    it('should add 20% buffer by default', async () => {
      const gas = await provider.testEstimateGasWithBuffer({ to: '0x1' });
      // Mock returns 150000n, +20% = 180000n
      expect(gas).toBe(180000n);
    });

    it('should apply custom buffer percentage', async () => {
      const gas = await provider.testEstimateGasWithBuffer({ to: '0x1' }, 50);
      // 150000n * 150 / 100 = 225000n
      expect(gas).toBe(225000n);
    });

    it('should return fallback gas on estimation failure', async () => {
      (mockEthersProvider.estimateGas as jest.Mock).mockRejectedValue(new Error('estimation failed'));
      const gas = await provider.testEstimateGasWithBuffer({ to: '0x1' });
      expect(gas).toBe(500000n); // default fallback
    });

    it('should use custom fallback gas', async () => {
      (mockEthersProvider.estimateGas as jest.Mock).mockRejectedValue(new Error('fail'));
      const gas = await provider.testEstimateGasWithBuffer({ to: '0x1' }, 20, 300000n);
      expect(gas).toBe(300000n);
    });
  });

  // ---------------------------------------------------------------------------
  // Fallback Configuration
  // ---------------------------------------------------------------------------

  describe('isFallbackEnabled', () => {
    it('should return true by default', () => {
      expect(provider.testIsFallbackEnabled()).toBe(true);
    });

    it('should return false when explicitly disabled', () => {
      const noFallbackProvider = new StubMevProvider({
        ...config,
        fallbackToPublic: false,
      });
      expect(noFallbackProvider.testIsFallbackEnabled()).toBe(false);
    });

    it('should return true when explicitly enabled', () => {
      const fallbackProvider = new StubMevProvider({
        ...config,
        fallbackToPublic: true,
      });
      expect(fallbackProvider.testIsFallbackEnabled()).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Result Factory Methods
  // ---------------------------------------------------------------------------

  describe('createFailureResult', () => {
    it('should create failure result with correct fields', () => {
      const startTime = Date.now() - 100;
      const result = provider.testCreateFailureResult('tx reverted', startTime);

      expect(result.success).toBe(false);
      expect(result.error).toBe('tx reverted');
      expect(result.strategy).toBe('flashbots');
      expect(result.usedFallback).toBe(false);
      expect(result.latencyMs).toBeGreaterThanOrEqual(100);
    });

    it('should include txHash and fallback flag when provided', () => {
      const startTime = Date.now();
      const result = provider.testCreateFailureResult('fail', startTime, true, '0xabc');

      expect(result.usedFallback).toBe(true);
      expect(result.transactionHash).toBe('0xabc');
    });
  });

  describe('createSuccessResult', () => {
    it('should create success result with correct fields', () => {
      const startTime = Date.now() - 50;
      const result = provider.testCreateSuccessResult(startTime, '0xhash', 12345, '0xbundle');

      expect(result.success).toBe(true);
      expect(result.transactionHash).toBe('0xhash');
      expect(result.blockNumber).toBe(12345);
      expect(result.bundleHash).toBe('0xbundle');
      expect(result.strategy).toBe('flashbots');
      expect(result.latencyMs).toBeGreaterThanOrEqual(50);
    });

    it('should handle optional fields', () => {
      const result = provider.testCreateSuccessResult(Date.now(), '0xhash');

      expect(result.success).toBe(true);
      expect(result.blockNumber).toBeUndefined();
      expect(result.bundleHash).toBeUndefined();
      expect(result.usedFallback).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  describe('dispose', () => {
    it('should reset metrics on dispose', async () => {
      await provider.testIncrementMetric('totalSubmissions');
      expect(provider.getMetrics().totalSubmissions).toBe(1);

      provider.dispose();
      expect(provider.getMetrics().totalSubmissions).toBe(0);
    });
  });
});
