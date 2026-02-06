/**
 * MEV-Share Provider for Ethereum
 *
 * Extends FlashbotsProvider to use MEV-Share endpoint for value capture.
 * MEV-Share enables capturing 50-90% of MEV value as rebates by allowing
 * searchers to backrun transactions while sharing profits.
 *
 * Falls back to standard Flashbots if MEV-Share unavailable.
 *
 * @see ADR-028 MEV-Share Integration
 * @see https://docs.flashbots.net/flashbots-mev-share/overview
 */

import { ethers } from 'ethers';
import { FlashbotsProvider } from './flashbots-provider';
import {
  MevProviderConfig,
  MevShareHints,
  MevShareOptions,
  MevShareSubmissionResult,
  MEV_DEFAULTS,
} from './types';

// =============================================================================
// MEV-Share Provider Implementation
// =============================================================================

/**
 * MEV-Share provider for Ethereum mainnet
 *
 * Extends FlashbotsProvider with MEV-Share endpoint support.
 * Inherits all Flashbots relay communication logic.
 */
export class MevShareProvider extends FlashbotsProvider {
  private readonly mevShareRelayUrl: string;

  constructor(config: MevProviderConfig) {
    super(config);

    // MEV-Share uses different endpoint on same relay
    this.mevShareRelayUrl = `${config.flashbotsRelayUrl || MEV_DEFAULTS.flashbotsRelayUrl}/mev-share`;
  }

  /**
   * Calculate appropriate hints for MEV-Share submission.
   *
   * Strategy: Balance privacy with value capture
   * - Reveal: Contract address, function selector (helps searchers identify opportunities)
   * - Hide: Calldata, logs (protects trade parameters)
   *
   * @param tx - Transaction to generate hints for
   * @param options - Optional hint customization
   * @returns Hint configuration
   */
  calculateHints(
    tx: ethers.TransactionRequest,
    options?: { revealValue?: boolean }
  ): MevShareHints {
    return {
      contractAddress: true,  // Searchers need to know target contract
      functionSelector: true, // Searchers need to know function (e.g., executeArbitrage)
      logs: false,            // Hide event data (profit amounts, swap details)
      calldata: false,        // Hide parameters (amounts, tokens, paths)
      hash: false,            // Hide tx hash (prevents front-running)
      txValue: options?.revealValue || false, // Optionally reveal ETH value
    };
  }

  /**
   * Build MEV-Share bundle payload.
   *
   * @param signedTx - Signed transaction
   * @param targetBlock - Target block number
   * @param options - Optional MEV-Share customization
   * @returns Bundle payload for MEV-Share API
   */
  private buildMevShareBundle(
    signedTx: string,
    targetBlock: number,
    options?: MevShareOptions
  ): Record<string, unknown> {
    const hints = options?.hints || this.calculateHints({});

    return {
      version: 'v0.1',
      inclusion: {
        block: `0x${targetBlock.toString(16)}`,
        maxBlock: options?.maxBlockNumber
          ? `0x${options.maxBlockNumber.toString(16)}`
          : `0x${(targetBlock + 10).toString(16)}`,
      },
      body: [{
        tx: signedTx,
        canRevert: false, // Our arbitrage transactions should not revert
      }],
      privacy: {
        hints,
        builders: ['flashbots'], // Target Flashbots builders
      },
      ...(options?.minRebatePercent !== undefined && {
        refundConfig: [{
          address: this.config.wallet.address,
          percent: options.minRebatePercent,
        }],
      }),
    };
  }

  /**
   * Submit transaction via MEV-Share.
   * Falls back to standard Flashbots if MEV-Share fails.
   *
   * @param tx - Transaction to submit
   * @param options - Optional submission parameters
   * @returns Submission result with rebate information
   */
  async sendProtectedTransaction(
    tx: ethers.TransactionRequest,
    options?: {
      targetBlock?: number;
      simulate?: boolean;
      priorityFeeGwei?: number;
      mevShareOptions?: MevShareOptions;
    }
  ): Promise<MevShareSubmissionResult> {
    const startTime = Date.now();

    if (!this.isEnabled()) {
      return this.createFailureResultWithRebate(
        'MEV protection disabled',
        startTime,
        false
      );
    }

    await this.incrementMetric('totalSubmissions');

    let preparedTx: ethers.TransactionRequest | null = null;

    try {
      // Get current block number
      const currentBlock = await this.config.provider.getBlockNumber();
      const targetBlock = options?.targetBlock || currentBlock + 1;

      // Prepare transaction with proper gas settings
      preparedTx = await this.prepareTransaction(tx, options?.priorityFeeGwei);

      // Sign the transaction
      const signedTx = await this.config.wallet.signTransaction(preparedTx);

      // Simulate before submission (enabled by default for safety)
      if (options?.simulate !== false) {
        const simResult = await this.simulateBundle([signedTx], targetBlock);
        if (!simResult.success) {
          await this.incrementMetric('bundlesReverted');
          return this.fallbackToPublicWithRebate(
            preparedTx,
            startTime,
            `Simulation failed: ${simResult.error}`
          );
        }
      }

      // Try MEV-Share first
      try {
        const mevShareResult = await this.submitMevShareBundle(
          signedTx,
          targetBlock,
          options?.mevShareOptions
        );

        if (mevShareResult.success) {
          // Wait for inclusion
          const inclusion = await this.waitForInclusion(
            mevShareResult.bundleHash!,
            [signedTx],
            targetBlock,
            this.config.submissionTimeoutMs || MEV_DEFAULTS.submissionTimeoutMs
          );

          if (inclusion.included) {
            // Update metrics
            await this.batchUpdateMetrics({
              successfulSubmissions: 1,
              bundlesIncluded: 1,
            }, startTime);

            // Record rebate if received
            if (mevShareResult.rebateAmount && mevShareResult.rebateAmount > 0n) {
              await this.metricsManager.recordRebate(
                mevShareResult.rebateAmount,
                preparedTx.value ? BigInt(preparedTx.value) : undefined
              );
            }

            // Return success with MEV-Share metadata
            return {
              ...this.createSuccessResult(
                startTime,
                inclusion.transactionHash!,
                targetBlock,
                mevShareResult.bundleHash,
                false
              ),
              usedMevShare: true,
              bundleId: mevShareResult.bundleId,
              rebateAmount: mevShareResult.rebateAmount,
              rebatePercent: mevShareResult.rebatePercent,
            };
          }
        }

        // MEV-Share didn't get included, fall through to standard Flashbots
      } catch (mevShareError) {
        // MEV-Share failed, fall through to standard Flashbots
      }

      // Fallback to standard Flashbots submission (parent class)
      const flashbotsResult = await super.sendProtectedTransaction(tx, options);

      // Return standard Flashbots result with MEV-Share metadata
      return {
        ...flashbotsResult,
        usedMevShare: false, // Standard Flashbots was used
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return this.fallbackToPublicWithRebate(preparedTx || tx, startTime, errorMessage);
    }
  }

  /**
   * Submit bundle to MEV-Share endpoint.
   *
   * @param signedTx - Signed transaction
   * @param targetBlock - Target block number
   * @param options - Optional MEV-Share options
   * @returns Submission result with rebate info
   */
  private async submitMevShareBundle(
    signedTx: string,
    targetBlock: number,
    options?: MevShareOptions
  ): Promise<{
    success: boolean;
    bundleHash?: string;
    bundleId?: string;
    error?: string;
    rebateAmount?: bigint;
    rebatePercent?: number;
  }> {
    try {
      const bundle = this.buildMevShareBundle(signedTx, targetBlock, options);

      const body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'mev_sendBundle',
        params: [bundle],
      };

      // Send to MEV-Share endpoint (uses same auth as standard Flashbots)
      const response = await this.sendMevShareRequest(body);

      if (response.error) {
        return {
          success: false,
          error: response.error.message || 'MEV-Share submission failed',
        };
      }

      const bundleHash = response.result?.bundleHash;
      if (!bundleHash) {
        return {
          success: false,
          error: 'No bundle hash in MEV-Share response',
        };
      }

      return {
        success: true,
        bundleHash,
        bundleId: response.result?.bundleId,
        // Note: Rebate info comes later via mev_getBundleStats
        rebateAmount: response.result?.rebateAmount
          ? BigInt(response.result.rebateAmount)
          : undefined,
        rebatePercent: response.result?.rebatePercent,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Send request to MEV-Share endpoint with authentication.
   * Uses parent's sendRelayRequest but with MEV-Share URL.
   *
   * @param body - Request body
   * @param timeoutMs - Optional timeout
   * @returns Response from MEV-Share endpoint
   */
  private async sendMevShareRequest(
    body: object,
    timeoutMs?: number
  ): Promise<any> {
    const bodyString = JSON.stringify(body);
    const headers = await this.getAuthHeaders(bodyString);

    const controller = new AbortController();
    const timeout = timeoutMs || MEV_DEFAULTS.submissionTimeoutMs;
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(this.mevShareRelayUrl, {
        method: 'POST',
        headers,
        body: bodyString,
        signal: controller.signal,
      });

      return await response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Create failure result with MEV-Share metadata.
   */
  private createFailureResultWithRebate(
    reason: string,
    startTime: number,
    usedFallback: boolean = false
  ): MevShareSubmissionResult {
    return {
      ...this.createFailureResult(reason, startTime, usedFallback),
      usedMevShare: false,
    };
  }

  /**
   * Fallback to public mempool with MEV-Share metadata.
   */
  private async fallbackToPublicWithRebate(
    tx: ethers.TransactionRequest,
    startTime: number,
    reason: string
  ): Promise<MevShareSubmissionResult> {
    const result = await this.fallbackToPublic(tx, startTime, reason);
    return {
      ...result,
      usedMevShare: false,
    };
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a MEV-Share provider for Ethereum mainnet
 */
export function createMevShareProvider(
  config: MevProviderConfig
): MevShareProvider {
  return new MevShareProvider(config);
}
