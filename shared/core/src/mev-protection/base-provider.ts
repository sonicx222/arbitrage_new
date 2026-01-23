/**
 * Base MEV Provider
 *
 * Abstract base class for EVM MEV protection providers.
 * Consolidates common functionality to reduce code duplication and prevent regression bugs:
 * - Thread-safe metrics handling via MevMetricsManager
 * - Common metric operations (increment, latency update)
 * - Base transaction preparation logic
 *
 * REFACTOR: Metrics logic now delegates to MevMetricsManager to share code
 * with JitoProvider and reduce duplication.
 *
 * @see FlashbotsProvider, L2SequencerProvider, StandardProvider
 */

import { ethers } from 'ethers';
import {
  IMevProvider,
  MevStrategy,
  MevSubmissionResult,
  MevProviderConfig,
  BundleSimulationResult,
  MevMetrics,
} from './types';
import { MevMetricsManager, IncrementableMetricField } from './metrics-manager';

// =============================================================================
// Base MEV Provider
// =============================================================================

/**
 * Abstract base class for EVM MEV protection providers
 *
 * Provides common functionality:
 * - Thread-safe metrics management via MevMetricsManager
 * - Base transaction preparation
 * - Nonce handling compatible with NonceManager
 */
export abstract class BaseMevProvider implements IMevProvider {
  abstract readonly chain: string;
  abstract readonly strategy: MevStrategy;

  protected readonly config: MevProviderConfig;

  /**
   * REFACTOR: Metrics management delegated to MevMetricsManager
   * to share code with JitoProvider and ensure consistent behavior.
   */
  protected readonly metricsManager: MevMetricsManager;

  constructor(config: MevProviderConfig) {
    this.config = config;
    this.metricsManager = new MevMetricsManager();
  }

  // ===========================================================================
  // Abstract Methods (must be implemented by subclasses)
  // ===========================================================================

  /**
   * Check if MEV protection is available and enabled
   */
  abstract isEnabled(): boolean;

  /**
   * Send a transaction with MEV protection
   */
  abstract sendProtectedTransaction(
    tx: ethers.TransactionRequest,
    options?: {
      targetBlock?: number;
      simulate?: boolean;
      priorityFeeGwei?: number;
    }
  ): Promise<MevSubmissionResult>;

  /**
   * Simulate a transaction without submitting
   */
  abstract simulateTransaction(
    tx: ethers.TransactionRequest
  ): Promise<BundleSimulationResult>;

  /**
   * Check connection/health of the MEV provider
   */
  abstract healthCheck(): Promise<{ healthy: boolean; message: string }>;

  // ===========================================================================
  // Metrics Management (Thread-Safe via MevMetricsManager)
  // ===========================================================================

  /**
   * Get current metrics (thread-safe read)
   * Delegates to MevMetricsManager.
   */
  getMetrics(): MevMetrics {
    return this.metricsManager.getMetrics();
  }

  /**
   * Reset metrics (thread-safe)
   * Delegates to MevMetricsManager.
   */
  resetMetrics(): void {
    this.metricsManager.resetMetrics();
  }

  /**
   * Thread-safe metric increment
   * Delegates to MevMetricsManager.
   */
  protected async incrementMetric(field: IncrementableMetricField): Promise<void> {
    await this.metricsManager.increment(field);
  }

  /**
   * Thread-safe latency update
   * Delegates to MevMetricsManager.
   */
  protected async updateLatency(startTime: number): Promise<void> {
    await this.metricsManager.updateLatency(startTime);
  }

  /**
   * Batch update multiple metrics atomically (PERF: single mutex acquisition)
   *
   * Use this on success paths to reduce lock contention:
   * ```typescript
   * // Instead of 4 awaits:
   * // await this.incrementMetric('totalSubmissions');
   * // await this.incrementMetric('successfulSubmissions');
   * // await this.incrementMetric('bundlesIncluded');
   * // await this.updateLatency(startTime);
   *
   * // Use single batch update:
   * await this.batchUpdateMetrics({
   *   successfulSubmissions: 1,
   *   bundlesIncluded: 1,
   * }, startTime);
   * ```
   */
  protected async batchUpdateMetrics(
    updates: Partial<Record<IncrementableMetricField, number>>,
    startTime?: number
  ): Promise<void> {
    await this.metricsManager.batchUpdate(updates, startTime);
  }

  // ===========================================================================
  // Transaction Preparation Helpers
  // ===========================================================================

  /**
   * Get nonce for transaction
   *
   * Nonce Management Architecture:
   * The execution engine's NonceManager allocates nonces atomically to prevent
   * race conditions during concurrent executions. If a nonce is already set in
   * the incoming transaction, we respect it. Only fetch from chain if not set.
   * This ensures compatibility with both engine-managed and standalone usage.
   *
   * @param tx - Transaction request that may have pre-allocated nonce
   * @returns The nonce to use (either from tx or fetched from chain)
   */
  protected async getNonce(tx: ethers.TransactionRequest): Promise<number> {
    if (tx.nonce !== undefined && tx.nonce !== null) {
      return typeof tx.nonce === 'number' ? tx.nonce : Number(tx.nonce);
    }

    return this.config.provider.getTransactionCount(
      this.config.wallet.address,
      'pending'
    );
  }

  /**
   * Get current fee data from provider
   */
  protected async getFeeData(): Promise<ethers.FeeData> {
    return this.config.provider.getFeeData();
  }

  /**
   * Estimate gas with buffer
   *
   * @param tx - Transaction to estimate
   * @param bufferPercent - Buffer percentage (default 20%)
   * @param fallbackGas - Fallback gas limit if estimation fails
   * @returns Estimated gas with buffer applied
   */
  protected async estimateGasWithBuffer(
    tx: ethers.TransactionRequest,
    bufferPercent: number = 20,
    fallbackGas: bigint = 500000n
  ): Promise<bigint> {
    try {
      const gasEstimate = await this.config.provider.estimateGas(tx);
      return (gasEstimate * BigInt(100 + bufferPercent)) / 100n;
    } catch {
      return fallbackGas;
    }
  }

  // ===========================================================================
  // Fallback Handling
  // ===========================================================================

  /**
   * Check if fallback to public mempool is enabled
   */
  protected isFallbackEnabled(): boolean {
    // Default to true if not specified (fail-safe behavior)
    return this.config.fallbackToPublic ?? true;
  }

  /**
   * Create a failure result for when protected submission fails
   *
   * @param reason - Why the submission failed
   * @param startTime - When the submission started (for latency)
   * @param usedFallback - Whether fallback was attempted
   * @param txHash - Optional transaction hash if partially successful
   */
  protected createFailureResult(
    reason: string,
    startTime: number,
    usedFallback: boolean = false,
    txHash?: string
  ): MevSubmissionResult {
    return {
      success: false,
      error: reason,
      transactionHash: txHash,
      strategy: this.strategy,
      latencyMs: Date.now() - startTime,
      usedFallback,
    };
  }

  /**
   * Create a success result
   */
  protected createSuccessResult(
    startTime: number,
    txHash: string,
    blockNumber?: number,
    bundleHash?: string,
    usedFallback: boolean = false
  ): MevSubmissionResult {
    return {
      success: true,
      transactionHash: txHash,
      bundleHash,
      blockNumber,
      strategy: this.strategy,
      latencyMs: Date.now() - startTime,
      usedFallback,
    };
  }
}
