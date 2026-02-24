/**
 * Timeboost MEV Protection Provider (Arbitrum)
 *
 * Implements MEV protection for Arbitrum using the Timeboost express lane auction.
 * Timeboost allows transactions to be submitted via the express lane for priority
 * inclusion, bypassing the standard sequencer queue.
 *
 * When the express lane is unavailable or the feature is disabled, transactions
 * fall back to standard L2 sequencer submission.
 *
 * Feature-gated: Requires FEATURE_TIMEBOOST=true environment variable.
 *
 * @see https://docs.arbitrum.io/timeboost
 */

import { ethers } from 'ethers';
import {
  MevStrategy,
  MevSubmissionResult,
  MevProviderConfig,
  BundleSimulationResult,
  MEV_DEFAULTS,
} from './types';
import { BaseMevProvider } from './base-provider';
import { createLogger } from '../logger';

const logger = createLogger('timeboost-provider');

// =============================================================================
// Constants
// =============================================================================

const TIMEBOOST_DEFAULTS = {
  expressLaneUrl: 'https://timeboost-auctioneer.arbitrum.io/api/v1/express_lane',
  /** Timeout for express lane submission in ms */
  submissionTimeoutMs: 5000,
  /** Timeout for health check in ms */
  healthCheckTimeoutMs: 3000,
} as const;

// =============================================================================
// Timeboost Provider Implementation
// =============================================================================

/**
 * Timeboost provider for Arbitrum MEV protection
 *
 * Uses Arbitrum's Timeboost express lane auction to submit transactions with
 * priority ordering. Falls back to standard sequencer submission when:
 * - FEATURE_TIMEBOOST is not enabled
 * - Express lane endpoint is unavailable
 * - Express lane submission fails
 */
export class TimeboostProvider extends BaseMevProvider {
  readonly chain = 'arbitrum';
  readonly strategy: MevStrategy = 'timeboost';

  private readonly expressLaneUrl: string;

  constructor(config: MevProviderConfig) {
    super(config);

    if (config.chain !== 'arbitrum') {
      throw new Error(
        'TimeboostProvider is only for Arbitrum. ' +
        `Chain "${config.chain}" is not supported.`
      );
    }

    this.expressLaneUrl =
      config.timeboostExpressLaneUrl ?? TIMEBOOST_DEFAULTS.expressLaneUrl;
  }

  /**
   * Check if Timeboost express lane is available and enabled.
   *
   * Feature-gated: requires FEATURE_TIMEBOOST=true (explicit opt-in).
   * When disabled, sendProtectedTransaction falls back to sequencer.
   */
  isEnabled(): boolean {
    return this.config.enabled && process.env.FEATURE_TIMEBOOST === 'true';
  }

  /**
   * Send a transaction with Timeboost MEV protection
   *
   * When Timeboost is enabled:
   * 1. Prepares and signs the transaction
   * 2. Submits to Timeboost express lane endpoint
   * 3. Falls back to standard sequencer on failure
   *
   * When Timeboost is disabled:
   * - Submits directly to L2 sequencer (standard path)
   */
  async sendProtectedTransaction(
    tx: ethers.TransactionRequest,
    options?: {
      targetBlock?: number;
      simulate?: boolean;
      priorityFeeGwei?: number;
    }
  ): Promise<MevSubmissionResult> {
    const startTime = Date.now();

    if (!this.config.enabled) {
      return this.createFailureResult('MEV protection disabled', startTime, false);
    }

    await this.incrementMetric('totalSubmissions');

    try {
      // Simulate before submission (enabled by default for safety)
      if (options?.simulate !== false) {
        const simResult = await this.simulateTransaction(tx);
        if (!simResult.success) {
          await this.incrementMetric('failedSubmissions');
          return this.createFailureResult(
            `Simulation failed: ${simResult.error}`,
            startTime,
            false
          );
        }
      }

      // Prepare transaction with gas settings
      const preparedTx = await this.prepareTransaction(tx, options?.priorityFeeGwei);

      // If Timeboost feature is not enabled, go directly to sequencer
      if (!this.isEnabled()) {
        logger.debug('Timeboost not enabled, falling back to sequencer submission');
        return this.submitViaSequencer(preparedTx, startTime, false);
      }

      // Sign the transaction for express lane submission
      const signedTx = await this.config.wallet.signTransaction(preparedTx);

      // Try express lane submission
      const expressResult = await this.submitToExpressLane(signedTx, startTime);
      if (expressResult.success) {
        return expressResult;
      }

      // Express lane failed, fall back to sequencer
      logger.warn('Timeboost express lane failed, falling back to sequencer', {
        error: expressResult.error,
      });

      if (!this.isFallbackEnabled()) {
        await this.incrementMetric('failedSubmissions');
        return this.createFailureResult(
          `Express lane failed: ${expressResult.error}. Fallback disabled.`,
          startTime,
          false
        );
      }

      return this.submitViaSequencer(preparedTx, startTime, true);
    } catch (error) {
      await this.incrementMetric('failedSubmissions');
      return this.createFailureResult(
        error instanceof Error ? error.message : String(error),
        startTime,
        false
      );
    }
  }

  /**
   * Simulate a transaction without submitting
   */
  async simulateTransaction(
    tx: ethers.TransactionRequest
  ): Promise<BundleSimulationResult> {
    try {
      const preparedTx = await this.prepareTransaction(tx);
      const gasEstimate = await this.config.provider.estimateGas(preparedTx);

      return {
        success: true,
        gasUsed: gasEstimate,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check health of the Timeboost express lane endpoint
   *
   * Uses a HEAD request to the express lane URL with timeout.
   */
  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    // First check the base L2 provider
    try {
      const blockNumber = await this.config.provider.getBlockNumber();

      if (!this.isEnabled()) {
        return {
          healthy: true,
          message: `Arbitrum sequencer healthy (block ${blockNumber}). Timeboost not enabled.`,
        };
      }

      // Check express lane health
      const expressLaneHealthy = await this.checkExpressLaneHealth();
      if (!expressLaneHealthy.healthy) {
        return {
          healthy: true, // Base provider is healthy
          message: `Arbitrum sequencer healthy (block ${blockNumber}), but express lane unhealthy: ${expressLaneHealthy.message}`,
        };
      }

      return {
        healthy: true,
        message: `Arbitrum Timeboost healthy (block ${blockNumber}). Express lane reachable.`,
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Failed to reach Arbitrum sequencer: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Prepare transaction with L2-optimized gas settings for Arbitrum
   */
  private async prepareTransaction(
    tx: ethers.TransactionRequest,
    priorityFeeGwei?: number
  ): Promise<ethers.TransactionRequest> {
    const [nonce, feeData] = await Promise.all([
      this.getNonce(tx),
      this.getFeeData(),
    ]);

    const preparedTx: ethers.TransactionRequest = {
      ...tx,
      from: this.config.wallet.address,
      nonce,
      type: 2, // EIP-1559
      chainId: 42161, // Arbitrum One
    };

    // Set priority fee
    if (priorityFeeGwei !== undefined) {
      preparedTx.maxPriorityFeePerGas = ethers.parseUnits(
        priorityFeeGwei.toString(),
        'gwei'
      );
    } else if (feeData.maxPriorityFeePerGas) {
      // Slight multiplier for faster inclusion (1.1x)
      preparedTx.maxPriorityFeePerGas =
        (feeData.maxPriorityFeePerGas * 110n) / 100n;
    } else {
      // Low default for Arbitrum
      preparedTx.maxPriorityFeePerGas = ethers.parseUnits('0.01', 'gwei');
    }

    // Set max fee
    if (feeData.maxFeePerGas) {
      preparedTx.maxFeePerGas = feeData.maxFeePerGas;
    } else {
      preparedTx.maxFeePerGas =
        (preparedTx.maxPriorityFeePerGas as bigint) +
        ethers.parseUnits('0.1', 'gwei');
    }

    // Estimate gas if not provided (10% buffer for L2s)
    if (!preparedTx.gasLimit) {
      preparedTx.gasLimit = await this.estimateGasWithBuffer(preparedTx, 10, 500000n);
    }

    return preparedTx;
  }

  /**
   * Submit signed transaction to Timeboost express lane
   */
  private async submitToExpressLane(
    signedTx: string,
    startTime: number
  ): Promise<MevSubmissionResult> {
    const controller = new AbortController();
    const timeoutMs = this.config.submissionTimeoutMs ?? TIMEBOOST_DEFAULTS.submissionTimeoutMs;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'timeboost_sendExpressLaneTransaction',
        params: [signedTx],
      });

      const response = await fetch(this.expressLaneUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });

      const result = await response.json() as {
        error?: { message?: string };
        result?: string;
      };

      if (result.error) {
        return this.createFailureResult(
          result.error.message ?? 'Express lane error',
          startTime,
          false
        );
      }

      const txHash = result.result;
      if (!txHash) {
        return this.createFailureResult(
          'No transaction hash returned from express lane',
          startTime,
          false
        );
      }

      // Wait for confirmation
      const receipt = await this.waitForTransaction(txHash);
      if (receipt) {
        await this.batchUpdateMetrics({
          successfulSubmissions: 1,
        }, startTime);

        return this.createSuccessResult(
          startTime,
          receipt.hash,
          receipt.blockNumber
        );
      }

      return this.createFailureResult(
        'Express lane transaction not confirmed',
        startTime,
        false,
        txHash
      );
    } catch (error) {
      return this.createFailureResult(
        error instanceof Error ? error.message : String(error),
        startTime,
        false
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Submit transaction via standard L2 sequencer (fallback path)
   */
  private async submitViaSequencer(
    preparedTx: ethers.TransactionRequest,
    startTime: number,
    usedFallback: boolean
  ): Promise<MevSubmissionResult> {
    try {
      const response = await this.config.wallet.sendTransaction(preparedTx);
      const receipt = await response.wait();

      if (receipt) {
        const updates: Partial<Record<'successfulSubmissions' | 'fallbackSubmissions', number>> = {
          successfulSubmissions: 1,
        };
        if (usedFallback) {
          updates.fallbackSubmissions = 1;
        }
        await this.batchUpdateMetrics(updates, startTime);

        return this.createSuccessResult(
          startTime,
          receipt.hash,
          receipt.blockNumber,
          undefined,
          usedFallback
        );
      }

      await this.incrementMetric('failedSubmissions');
      return this.createFailureResult(
        'Sequencer transaction not confirmed',
        startTime,
        usedFallback,
        response.hash
      );
    } catch (error) {
      await this.incrementMetric('failedSubmissions');
      return this.createFailureResult(
        error instanceof Error ? error.message : String(error),
        startTime,
        usedFallback
      );
    }
  }

  /**
   * Wait for transaction confirmation
   */
  private async waitForTransaction(
    txHash: string
  ): Promise<ethers.TransactionReceipt | null> {
    const timeout = this.config.submissionTimeoutMs ?? MEV_DEFAULTS.submissionTimeoutMs;
    const waitStart = Date.now();

    while (Date.now() - waitStart < timeout) {
      try {
        const receipt = await this.config.provider.getTransactionReceipt(txHash);
        if (receipt) {
          return receipt;
        }
      } catch {
        // Continue waiting
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return null;
  }

  /**
   * Check health of the express lane endpoint
   */
  private async checkExpressLaneHealth(): Promise<{ healthy: boolean; message: string }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      TIMEBOOST_DEFAULTS.healthCheckTimeoutMs
    );

    try {
      const response = await fetch(this.expressLaneUrl, {
        method: 'HEAD',
        signal: controller.signal,
      });

      // Any response (even 4xx) means endpoint is reachable
      return {
        healthy: response.ok || response.status < 500,
        message: response.ok
          ? 'Express lane endpoint is reachable'
          : `Express lane returned status ${response.status}`,
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Failed to reach express lane: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a Timeboost provider for Arbitrum
 */
export function createTimeboostProvider(
  config: MevProviderConfig
): TimeboostProvider {
  return new TimeboostProvider(config);
}
