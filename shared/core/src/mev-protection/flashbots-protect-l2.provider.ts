/**
 * Flashbots Protect L2 MEV Protection Provider (Base)
 *
 * Implements MEV protection for Base using the Flashbots Protect RPC endpoint.
 * Transactions are submitted privately via the Flashbots Protect relay,
 * preventing frontrunning by hiding them from the public mempool.
 *
 * When the Protect endpoint is unavailable or the feature is disabled,
 * transactions fall back to standard L2 sequencer submission.
 *
 * Feature-gated: Requires FEATURE_FLASHBOTS_PROTECT_L2=true environment variable.
 *
 * @see https://docs.flashbots.net/flashbots-protect/overview
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
import { getErrorMessage } from '../resilience/error-handling';
const logger = createLogger('flashbots-protect-l2-provider');

// =============================================================================
// Constants
// =============================================================================

const FLASHBOTS_PROTECT_L2_DEFAULTS = {
  protectUrl: 'https://rpc.flashbots.net/fast',
  /** Timeout for protect submission in ms */
  submissionTimeoutMs: 5000,
  /** Timeout for health check in ms */
  healthCheckTimeoutMs: 3000,
} as const;

// =============================================================================
// Flashbots Protect L2 Provider Implementation
// =============================================================================

/**
 * Flashbots Protect L2 provider for Base MEV protection
 *
 * Submits transactions via the Flashbots Protect RPC to prevent frontrunning.
 * Falls back to standard sequencer submission when:
 * - FEATURE_FLASHBOTS_PROTECT_L2 is not enabled
 * - Protect endpoint is unavailable
 * - Protect submission fails
 */
export class FlashbotsProtectL2Provider extends BaseMevProvider {
  readonly chain = 'base';
  readonly strategy: MevStrategy = 'flashbots_protect';

  private readonly protectUrl: string;

  constructor(config: MevProviderConfig) {
    super(config);

    if (config.chain !== 'base') {
      throw new Error(
        'FlashbotsProtectL2Provider is only for Base. ' +
        `Chain "${config.chain}" is not supported.`
      );
    }

    this.protectUrl =
      config.flashbotsProtectL2Url ?? FLASHBOTS_PROTECT_L2_DEFAULTS.protectUrl;
  }

  /**
   * Check if Flashbots Protect L2 is available and enabled.
   *
   * Feature-gated: requires FEATURE_FLASHBOTS_PROTECT_L2=true (explicit opt-in).
   * When disabled, sendProtectedTransaction falls back to sequencer.
   */
  isEnabled(): boolean {
    return this.config.enabled && process.env.FEATURE_FLASHBOTS_PROTECT_L2 === 'true';
  }

  /**
   * Send a transaction with Flashbots Protect L2 MEV protection
   *
   * When Flashbots Protect is enabled:
   * 1. Prepares and signs the transaction
   * 2. Submits via Flashbots Protect RPC endpoint
   * 3. Falls back to standard sequencer on failure
   *
   * When Flashbots Protect is disabled:
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

      // If Flashbots Protect feature is not enabled, go directly to sequencer
      if (!this.isEnabled()) {
        logger.debug('Flashbots Protect L2 not enabled, falling back to sequencer submission');
        return this.submitViaSequencer(preparedTx, startTime, false);
      }

      // Sign the transaction for Protect submission
      const signedTx = await this.config.wallet.signTransaction(preparedTx);

      // Try Flashbots Protect submission
      const protectResult = await this.submitToProtect(signedTx, startTime);
      if (protectResult.success) {
        return protectResult;
      }

      // Protect failed, fall back to sequencer
      logger.warn('Flashbots Protect L2 failed, falling back to sequencer', {
        error: protectResult.error,
      });

      if (!this.isFallbackEnabled()) {
        await this.incrementMetric('failedSubmissions');
        return this.createFailureResult(
          `Protect submission failed: ${protectResult.error}. Fallback disabled.`,
          startTime,
          false
        );
      }

      return this.submitViaSequencer(preparedTx, startTime, true);
    } catch (error) {
      await this.incrementMetric('failedSubmissions');
      return this.createFailureResult(
        getErrorMessage(error),
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
        error: getErrorMessage(error),
      };
    }
  }

  /**
   * Check health of the Flashbots Protect L2 endpoint
   *
   * Uses eth_blockNumber JSON-RPC call to verify the endpoint is responding.
   */
  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    // First check the base L2 provider
    try {
      const blockNumber = await this.config.provider.getBlockNumber();

      if (!this.isEnabled()) {
        return {
          healthy: true,
          message: `Base sequencer healthy (block ${blockNumber}). Flashbots Protect L2 not enabled.`,
        };
      }

      // Check Protect endpoint health
      const protectHealthy = await this.checkProtectHealth();
      if (!protectHealthy.healthy) {
        return {
          healthy: true, // Base provider is healthy
          message: `Base sequencer healthy (block ${blockNumber}), but Protect endpoint unhealthy: ${protectHealthy.message}`,
        };
      }

      return {
        healthy: true,
        message: `Base Flashbots Protect healthy (block ${blockNumber}). Protect endpoint reachable.`,
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Failed to reach Base sequencer: ${getErrorMessage(error)}`,
      };
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Prepare transaction with L2-optimized gas settings for Base
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
      chainId: 8453, // Base
    };

    // Set priority fee
    if (priorityFeeGwei !== undefined) {
      preparedTx.maxPriorityFeePerGas = ethers.parseUnits(
        priorityFeeGwei.toString(),
        'gwei'
      );
    } else if (feeData.maxPriorityFeePerGas) {
      // Slight multiplier for faster inclusion (1.2x)
      preparedTx.maxPriorityFeePerGas =
        (feeData.maxPriorityFeePerGas * 120n) / 100n;
    } else {
      // Low default for Base
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
   * Submit signed transaction to Flashbots Protect RPC
   */
  private async submitToProtect(
    signedTx: string,
    startTime: number
  ): Promise<MevSubmissionResult> {
    const controller = new AbortController();
    const timeoutMs = this.config.submissionTimeoutMs ?? FLASHBOTS_PROTECT_L2_DEFAULTS.submissionTimeoutMs;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_sendRawTransaction',
        params: [signedTx],
      });

      const response = await fetch(this.protectUrl, {
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
          result.error.message ?? 'Protect RPC error',
          startTime,
          false
        );
      }

      const txHash = result.result;
      if (!txHash) {
        return this.createFailureResult(
          'No transaction hash returned from Protect RPC',
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
        'Protect transaction not confirmed',
        startTime,
        false,
        txHash
      );
    } catch (error) {
      return this.createFailureResult(
        getErrorMessage(error),
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
        getErrorMessage(error),
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
   * Check health of the Flashbots Protect endpoint
   *
   * Uses eth_blockNumber JSON-RPC call to verify the endpoint is responding.
   */
  private async checkProtectHealth(): Promise<{ healthy: boolean; message: string }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      FLASHBOTS_PROTECT_L2_DEFAULTS.healthCheckTimeoutMs
    );

    try {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_blockNumber',
        params: [],
      });

      const response = await fetch(this.protectUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });

      if (response.ok) {
        return { healthy: true, message: 'Protect endpoint is reachable' };
      }

      return {
        healthy: false,
        message: `Protect endpoint returned status ${response.status}`,
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Failed to reach Protect endpoint: ${getErrorMessage(error)}`,
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
 * Create a Flashbots Protect L2 provider for Base
 */
export function createFlashbotsProtectL2Provider(
  config: MevProviderConfig
): FlashbotsProtectL2Provider {
  return new FlashbotsProtectL2Provider(config);
}
