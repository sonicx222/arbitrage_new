/**
 * Flashbots MEV Protection Provider
 *
 * Implements MEV protection for Ethereum mainnet using Flashbots private bundles.
 * Bundles are sent directly to Flashbots relay, bypassing the public mempool
 * to prevent sandwich attacks and other MEV extraction.
 *
 * @see https://docs.flashbots.net/
 */

import { ethers } from 'ethers';
import {
  IMevProvider,
  MevStrategy,
  MevSubmissionResult,
  MevProviderConfig,
  BundleSimulationResult,
  MevMetrics,
  FlashbotsBundle,
  MEV_DEFAULTS,
} from './types';
import { AsyncMutex } from '../async-mutex';

// =============================================================================
// Flashbots Provider Implementation
// =============================================================================

/**
 * Flashbots provider for Ethereum mainnet MEV protection
 *
 * Uses Flashbots relay to submit private transaction bundles that are
 * included atomically without being visible in the public mempool.
 */
export class FlashbotsProvider implements IMevProvider {
  readonly chain = 'ethereum';
  readonly strategy: MevStrategy = 'flashbots';

  private readonly config: MevProviderConfig;
  private readonly authSigner: ethers.Wallet | ethers.HDNodeWallet;
  private readonly relayUrl: string;
  private metrics: MevMetrics;
  // Thread-safe metrics updates for concurrent submissions
  private readonly metricsMutex = new AsyncMutex();

  constructor(config: MevProviderConfig) {
    if (config.chain !== 'ethereum') {
      throw new Error('FlashbotsProvider is only for Ethereum mainnet');
    }

    this.config = config;
    this.relayUrl = config.flashbotsRelayUrl || MEV_DEFAULTS.flashbotsRelayUrl;

    // Create auth signer for Flashbots reputation
    // If no auth key provided, generate a random one (lower reputation)
    if (config.flashbotsAuthKey) {
      this.authSigner = new ethers.Wallet(config.flashbotsAuthKey);
    } else {
      this.authSigner = ethers.Wallet.createRandom();
    }

    this.metrics = this.createEmptyMetrics();
  }

  /**
   * Check if MEV protection is available and enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Send a transaction with Flashbots MEV protection
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
    await this.incrementMetric('totalSubmissions');

    if (!this.isEnabled()) {
      return this.fallbackToPublic(tx, startTime, 'MEV protection disabled');
    }

    // NONCE-CONSISTENCY-FIX: Track prepared transaction for fallback.
    // Use preparedTx (with nonce) for fallback instead of original tx.
    // This ensures fallback uses the same nonce allocated during preparation,
    // preventing nonce gaps in standalone usage.
    let preparedTx: ethers.TransactionRequest | null = null;

    try {
      // Get current block number for targeting
      const currentBlock = await this.config.provider.getBlockNumber();
      const targetBlock = options?.targetBlock || currentBlock + 1;

      // Prepare transaction with proper gas settings
      preparedTx = await this.prepareTransaction(tx, options?.priorityFeeGwei);

      // Sign the transaction
      const signedTx = await this.config.wallet.signTransaction(preparedTx);

      // Optionally simulate before submission
      if (options?.simulate !== false) {
        const simResult = await this.simulateBundle([signedTx], targetBlock);
        if (!simResult.success) {
          await this.incrementMetric('bundlesReverted');
          return this.fallbackToPublic(
            preparedTx, // Use prepared tx with nonce
            startTime,
            `Simulation failed: ${simResult.error}`
          );
        }
      }

      // Submit bundle to Flashbots relay
      const bundleResult = await this.submitBundle([signedTx], targetBlock);

      if (bundleResult.success) {
        await this.incrementMetric('successfulSubmissions');
        await this.incrementMetric('bundlesIncluded');
        await this.updateLatencySafe(startTime);

        return {
          success: true,
          transactionHash: bundleResult.transactionHash,
          bundleHash: bundleResult.bundleHash,
          blockNumber: targetBlock,
          strategy: 'flashbots',
          latencyMs: Date.now() - startTime,
          usedFallback: false,
        };
      }

      // Bundle submission failed, try fallback if enabled
      return this.fallbackToPublic(
        preparedTx, // Use prepared tx with nonce
        startTime,
        bundleResult.error || 'Bundle submission failed'
      );
    } catch (error) {
      await this.incrementMetric('failedSubmissions');
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Use preparedTx if available (preserves nonce), otherwise fall back to original tx
      return this.fallbackToPublic(preparedTx || tx, startTime, errorMessage);
    }
  }

  /**
   * Simulate a transaction without submitting
   */
  async simulateTransaction(
    tx: ethers.TransactionRequest
  ): Promise<BundleSimulationResult> {
    try {
      const currentBlock = await this.config.provider.getBlockNumber();
      const preparedTx = await this.prepareTransaction(tx);
      const signedTx = await this.config.wallet.signTransaction(preparedTx);

      return this.simulateBundle([signedTx], currentBlock + 1);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get current metrics
   */
  getMetrics(): MevMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset metrics
   */
  resetMetrics(): void {
    this.metrics = this.createEmptyMetrics();
  }

  /**
   * Check health of Flashbots relay connection
   */
  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    try {
      // Try to get relay status
      const response = await fetch(`${this.relayUrl}/`, {
        method: 'GET',
        headers: this.getAuthHeaders(''),
      });

      if (response.ok) {
        return { healthy: true, message: 'Flashbots relay is reachable' };
      }

      return {
        healthy: false,
        message: `Flashbots relay returned status ${response.status}`,
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Failed to reach Flashbots relay: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Prepare transaction with proper gas settings for Flashbots
   *
   * NOTE: Nonce Management Architecture
   * The execution engine's NonceManager allocates nonces atomically to prevent
   * race conditions during concurrent executions. If a nonce is already set in
   * the incoming transaction, we respect it. Only fetch from chain if not set.
   * This ensures compatibility with both engine-managed and standalone usage.
   */
  private async prepareTransaction(
    tx: ethers.TransactionRequest,
    priorityFeeGwei?: number
  ): Promise<ethers.TransactionRequest> {
    // Respect pre-allocated nonce from NonceManager if provided
    // Only fetch from chain if no nonce is set (standalone usage)
    const nonce = tx.nonce !== undefined && tx.nonce !== null
      ? tx.nonce
      : await this.config.provider.getTransactionCount(
          this.config.wallet.address,
          'pending'
        );

    // Get current fee data
    const feeData = await this.config.provider.getFeeData();

    // Use EIP-1559 transaction format
    const preparedTx: ethers.TransactionRequest = {
      ...tx,
      from: this.config.wallet.address,
      nonce,
      type: 2, // EIP-1559
      chainId: 1, // Ethereum mainnet
    };

    // Set gas fees
    if (priorityFeeGwei !== undefined) {
      preparedTx.maxPriorityFeePerGas = ethers.parseUnits(
        priorityFeeGwei.toString(),
        'gwei'
      );
    } else if (feeData.maxPriorityFeePerGas) {
      preparedTx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
    } else {
      preparedTx.maxPriorityFeePerGas = ethers.parseUnits('2', 'gwei');
    }

    if (feeData.maxFeePerGas) {
      preparedTx.maxFeePerGas = feeData.maxFeePerGas;
    } else {
      // Fallback: priority fee + 100 gwei base
      preparedTx.maxFeePerGas =
        (preparedTx.maxPriorityFeePerGas as bigint) +
        ethers.parseUnits('100', 'gwei');
    }

    // Estimate gas if not provided
    if (!preparedTx.gasLimit) {
      try {
        const gasEstimate = await this.config.provider.estimateGas(preparedTx);
        // Add 20% buffer for safety
        preparedTx.gasLimit = (gasEstimate * 120n) / 100n;
      } catch {
        // Use reasonable default for swap transactions
        preparedTx.gasLimit = 500000n;
      }
    }

    return preparedTx;
  }

  /**
   * Simulate bundle using eth_callBundle
   */
  private async simulateBundle(
    signedTransactions: string[],
    blockNumber: number
  ): Promise<BundleSimulationResult> {
    try {
      const body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_callBundle',
        params: [
          {
            txs: signedTransactions,
            blockNumber: `0x${blockNumber.toString(16)}`,
            stateBlockNumber: 'latest',
          },
        ],
      };

      const response = await this.sendRelayRequest(body);

      if (response.error) {
        return {
          success: false,
          error: response.error.message || 'Simulation failed',
        };
      }

      const result = response.result;

      // Check if any transaction reverted
      if (result.results) {
        for (const txResult of result.results) {
          if (txResult.error || txResult.revert) {
            return {
              success: false,
              error: txResult.revert || txResult.error || 'Transaction reverted',
              results: result.results.map((r: any) => ({
                txHash: r.txHash || '',
                gasUsed: BigInt(r.gasUsed || 0),
                success: !r.error && !r.revert,
                revertReason: r.revert,
              })),
            };
          }
        }
      }

      return {
        success: true,
        profit: result.coinbaseDiff ? BigInt(result.coinbaseDiff) : undefined,
        gasUsed: result.totalGasUsed ? BigInt(result.totalGasUsed) : undefined,
        effectiveGasPrice: result.gasFees
          ? BigInt(result.gasFees) / BigInt(result.totalGasUsed || 1)
          : undefined,
        coinbaseDiff: result.coinbaseDiff ? BigInt(result.coinbaseDiff) : undefined,
        results: result.results?.map((r: any) => ({
          txHash: r.txHash || '',
          gasUsed: BigInt(r.gasUsed || 0),
          success: !r.error && !r.revert,
          revertReason: r.revert,
        })),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Submit bundle to Flashbots relay using eth_sendBundle
   */
  private async submitBundle(
    signedTransactions: string[],
    blockNumber: number
  ): Promise<{
    success: boolean;
    transactionHash?: string;
    bundleHash?: string;
    error?: string;
  }> {
    const maxRetries = this.config.maxRetries || MEV_DEFAULTS.maxRetries;
    const timeout = this.config.submissionTimeoutMs || MEV_DEFAULTS.submissionTimeoutMs;

    // Try multiple blocks for inclusion
    const blocksToTry = [blockNumber, blockNumber + 1, blockNumber + 2];
    let lastError: string | undefined;
    let totalAttempts = 0;

    for (const targetBlock of blocksToTry) {
      for (let retry = 0; retry < maxRetries; retry++) {
        totalAttempts++;
        try {
          const body = {
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_sendBundle',
            params: [
              {
                txs: signedTransactions,
                blockNumber: `0x${targetBlock.toString(16)}`,
              },
            ],
          };

          const response = await this.sendRelayRequest(body, timeout);

          if (response.error) {
            // Track error for debugging
            lastError = `Block ${targetBlock}, retry ${retry}: ${response.error.message || 'Relay error'}`;
            continue;
          }

          const bundleHash = response.result?.bundleHash;

          // Validate bundleHash exists before waiting for inclusion
          if (!bundleHash) {
            lastError = `Block ${targetBlock}, retry ${retry}: No bundle hash in response`;
            continue;
          }

          // Wait for bundle to be included
          const inclusion = await this.waitForInclusion(
            bundleHash,
            targetBlock,
            timeout
          );

          if (inclusion.included) {
            return {
              success: true,
              transactionHash: inclusion.transactionHash,
              bundleHash,
            };
          }

          lastError = `Block ${targetBlock}, retry ${retry}: Bundle not included`;
        } catch (error) {
          // Track error for debugging
          lastError = `Block ${targetBlock}, retry ${retry}: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }

    return {
      success: false,
      error: `Bundle not included after ${totalAttempts} attempts. Last error: ${lastError || 'Unknown'}`,
    };
  }

  /**
   * Wait for bundle inclusion in a block
   */
  private async waitForInclusion(
    bundleHash: string,
    targetBlock: number,
    timeoutMs: number
  ): Promise<{ included: boolean; transactionHash?: string }> {
    const startTime = Date.now();
    const pollInterval = 1000; // 1 second

    while (Date.now() - startTime < timeoutMs) {
      try {
        const body = {
          jsonrpc: '2.0',
          id: 1,
          method: 'flashbots_getBundleStatsV2',
          params: [{ bundleHash, blockNumber: `0x${targetBlock.toString(16)}` }],
        };

        const response = await this.sendRelayRequest(body);

        if (response.result?.isSimulated && response.result?.isHighPriority !== false) {
          // Bundle was processed
          if (response.result?.receivedAt) {
            // Check if transaction is in the block
            const block = await this.config.provider.getBlock(targetBlock, true);
            if (block && block.transactions) {
              // Bundle was included if block exists and has our transactions
              return {
                included: true,
                transactionHash: response.result?.transactions?.[0]?.hash,
              };
            }
          }
        }

        // Wait before next poll
        await new Promise((resolve) => setTimeout(resolve, pollInterval));

        // Check if target block has passed
        const currentBlock = await this.config.provider.getBlockNumber();
        if (currentBlock > targetBlock) {
          return { included: false };
        }
      } catch {
        // Continue polling
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }
    }

    return { included: false };
  }

  /**
   * Send request to Flashbots relay with authentication
   */
  private async sendRelayRequest(
    body: object,
    timeoutMs?: number
  ): Promise<any> {
    const bodyString = JSON.stringify(body);
    const headers = this.getAuthHeaders(bodyString);

    const controller = new AbortController();
    const timeout = timeoutMs || MEV_DEFAULTS.submissionTimeoutMs;
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(this.relayUrl, {
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
   * Get authentication headers for Flashbots relay
   */
  private getAuthHeaders(body: string): Record<string, string> {
    const signature = this.authSigner.signMessageSync(
      ethers.id(body)
    );

    return {
      'Content-Type': 'application/json',
      'X-Flashbots-Signature': `${this.authSigner.address}:${signature}`,
    };
  }

  /**
   * Fallback to public mempool submission
   */
  private async fallbackToPublic(
    tx: ethers.TransactionRequest,
    startTime: number,
    reason: string
  ): Promise<MevSubmissionResult> {
    if (!this.config.fallbackToPublic) {
      await this.incrementMetric('failedSubmissions');
      return {
        success: false,
        error: `Protected submission failed: ${reason}. Fallback disabled.`,
        strategy: 'flashbots',
        latencyMs: Date.now() - startTime,
        usedFallback: false,
      };
    }

    try {
      await this.incrementMetric('fallbackSubmissions');

      // Submit to public mempool
      const response = await this.config.wallet.sendTransaction(tx);
      const receipt = await response.wait();

      await this.incrementMetric('successfulSubmissions');
      await this.updateLatencySafe(startTime);

      return {
        success: true,
        transactionHash: receipt?.hash,
        blockNumber: receipt?.blockNumber,
        strategy: 'flashbots',
        latencyMs: Date.now() - startTime,
        usedFallback: true,
      };
    } catch (error) {
      await this.incrementMetric('failedSubmissions');
      return {
        success: false,
        error: `Protected and fallback both failed. Original: ${reason}. Fallback: ${error instanceof Error ? error.message : String(error)}`,
        strategy: 'flashbots',
        latencyMs: Date.now() - startTime,
        usedFallback: true,
      };
    }
  }

  /**
   * Create empty metrics object
   */
  private createEmptyMetrics(): MevMetrics {
    return {
      totalSubmissions: 0,
      successfulSubmissions: 0,
      failedSubmissions: 0,
      fallbackSubmissions: 0,
      averageLatencyMs: 0,
      bundlesIncluded: 0,
      bundlesReverted: 0,
      lastUpdated: Date.now(),
    };
  }

  // ===========================================================================
  // Thread-Safe Metrics Helpers
  // ===========================================================================

  /**
   * Thread-safe metric increment
   * Uses mutex to prevent race conditions during concurrent submissions
   */
  private async incrementMetric(
    field: 'totalSubmissions' | 'successfulSubmissions' | 'failedSubmissions' |
           'fallbackSubmissions' | 'bundlesIncluded' | 'bundlesReverted'
  ): Promise<void> {
    await this.metricsMutex.runExclusive(async () => {
      this.metrics[field]++;
    });
  }

  /**
   * Thread-safe latency update
   * Must complete atomically since it reads and writes multiple metrics fields
   */
  private async updateLatencySafe(startTime: number): Promise<void> {
    await this.metricsMutex.runExclusive(async () => {
      const latency = Date.now() - startTime;
      const total = this.metrics.successfulSubmissions;

      if (total === 1) {
        this.metrics.averageLatencyMs = latency;
      } else if (total > 1) {
        // Running average based on successful submissions only
        this.metrics.averageLatencyMs =
          (this.metrics.averageLatencyMs * (total - 1) + latency) / total;
      }

      this.metrics.lastUpdated = Date.now();
    });
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a Flashbots provider for Ethereum mainnet
 */
export function createFlashbotsProvider(
  config: MevProviderConfig
): FlashbotsProvider {
  return new FlashbotsProvider(config);
}
