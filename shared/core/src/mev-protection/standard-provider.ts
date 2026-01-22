/**
 * Standard MEV Protection Provider
 *
 * Implements MEV protection for chains without specialized private relay options.
 * Uses gas optimization strategies to minimize MEV exposure:
 *
 * 1. Aggressive gas pricing to get faster inclusion
 * 2. Transaction deadline enforcement
 * 3. Slippage protection in contract calls
 *
 * Also supports BloXroute (BSC) and Fastlane (Polygon) when configured.
 */

import { ethers } from 'ethers';
import {
  IMevProvider,
  MevStrategy,
  MevSubmissionResult,
  MevProviderConfig,
  BundleSimulationResult,
  MevMetrics,
  CHAIN_MEV_STRATEGIES,
  MEV_DEFAULTS,
} from './types';
import { AsyncMutex } from '../async/async-mutex';

// =============================================================================
// Standard Provider Implementation
// =============================================================================

/**
 * Standard MEV provider for chains without specialized protection
 *
 * Uses gas optimization and fast inclusion strategies to minimize MEV risk.
 * Can also integrate with BloXroute (BSC) and Fastlane (Polygon) when available.
 */
export class StandardProvider implements IMevProvider {
  readonly chain: string;
  readonly strategy: MevStrategy;

  private readonly config: MevProviderConfig;
  private metrics: MevMetrics;
  private privateRpcUrl?: string;
  // Thread-safe metrics updates for concurrent submissions
  private readonly metricsMutex = new AsyncMutex();

  constructor(config: MevProviderConfig) {
    this.chain = config.chain;
    this.config = config;

    // Determine strategy based on chain
    this.strategy = CHAIN_MEV_STRATEGIES[config.chain] || 'standard';

    // Set up private RPC if available
    this.setupPrivateRpc();

    this.metrics = this.createEmptyMetrics();
  }

  /**
   * Set up private RPC based on chain and configuration
   */
  private setupPrivateRpc(): void {
    switch (this.strategy) {
      case 'bloxroute':
        // BloXroute for BSC
        if (this.config.bloxrouteAuthHeader) {
          this.privateRpcUrl = MEV_DEFAULTS.bloxrouteUrl;
        }
        break;

      case 'fastlane':
        // Fastlane for Polygon
        this.privateRpcUrl = MEV_DEFAULTS.fastlaneUrl;
        break;

      default:
        // No private RPC for standard chains
        this.privateRpcUrl = undefined;
    }
  }

  /**
   * Check if MEV protection is available and enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Send a transaction with available MEV protection
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
      return {
        success: false,
        error: 'MEV protection disabled',
        strategy: this.strategy,
        latencyMs: Date.now() - startTime,
        usedFallback: false,
      };
    }

    // NONCE-CONSISTENCY-FIX: Prepare transaction once at the top.
    // This ensures consistent nonce across private RPC and fallback paths,
    // preventing nonce gaps in standalone usage.
    let preparedTx: ethers.TransactionRequest | null = null;

    try {
      // Optionally simulate before submission
      if (options?.simulate) {
        const simResult = await this.simulateTransaction(tx);
        if (!simResult.success) {
          await this.incrementMetric('failedSubmissions');
          return {
            success: false,
            error: `Simulation failed: ${simResult.error}`,
            strategy: this.strategy,
            latencyMs: Date.now() - startTime,
            usedFallback: false,
          };
        }
      }

      // Prepare transaction once - will be used for both private and fallback paths
      preparedTx = await this.prepareTransaction(tx, options?.priorityFeeGwei);

      // Try private RPC first if available
      if (this.privateRpcUrl) {
        const result = await this.sendViaPrivateRpc(preparedTx, startTime);
        if (result.success) {
          return result;
        }

        // Fall through to standard submission if private fails
        if (!this.config.fallbackToPublic) {
          await this.incrementMetric('failedSubmissions');
          return {
            ...result,
            error: `Private submission failed: ${result.error}. Fallback disabled.`,
          };
        }
      }

      // Standard submission with gas optimization (use same preparedTx)
      return this.sendWithGasOptimization(preparedTx, startTime);
    } catch (error) {
      await this.incrementMetric('failedSubmissions');
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        strategy: this.strategy,
        latencyMs: Date.now() - startTime,
        usedFallback: false,
      };
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
   * Check health of provider connection
   */
  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    try {
      const blockNumber = await this.config.provider.getBlockNumber();

      // If we have a private RPC, check that too
      if (this.privateRpcUrl) {
        const privateHealthy = await this.checkPrivateRpcHealth();
        if (!privateHealthy.healthy) {
          return {
            healthy: true, // Main provider is healthy
            message: `${this.chain} provider healthy (block ${blockNumber}), but private RPC unhealthy: ${privateHealthy.message}`,
          };
        }
      }

      return {
        healthy: true,
        message: `${this.chain} provider is healthy. Block: ${blockNumber}`,
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Failed to reach ${this.chain} provider: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Send via private RPC (BloXroute/Fastlane)
   *
   * NONCE-CONSISTENCY-FIX: Now accepts already-prepared transaction to ensure
   * consistent nonce across private and fallback paths.
   *
   * LATENCY-FIX: Now accepts startTime from caller for accurate latency tracking
   * across the entire operation (simulation + private RPC + confirmation).
   */
  private async sendViaPrivateRpc(
    preparedTx: ethers.TransactionRequest,
    startTime: number
  ): Promise<MevSubmissionResult> {
    try {
      const signedTx = await this.config.wallet.signTransaction(preparedTx);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      // Add auth header for BloXroute
      if (this.strategy === 'bloxroute' && this.config.bloxrouteAuthHeader) {
        headers['Authorization'] = this.config.bloxrouteAuthHeader;
      }

      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_sendRawTransaction',
        params: [signedTx],
      });

      const response = await fetch(this.privateRpcUrl!, {
        method: 'POST',
        headers,
        body,
      });

      const result = await response.json() as {
        error?: { message?: string };
        result?: string;
      };

      if (result.error) {
        return {
          success: false,
          error: result.error.message || 'Private RPC error',
          strategy: this.strategy,
          latencyMs: Date.now() - startTime,
          usedFallback: false,
        };
      }

      const txHash = result.result;

      if (!txHash) {
        return {
          success: false,
          error: 'No transaction hash returned from private RPC',
          strategy: this.strategy,
          latencyMs: Date.now() - startTime,
          usedFallback: false,
        };
      }

      // Wait for confirmation
      const receipt = await this.waitForTransaction(txHash);

      if (receipt) {
        await this.incrementMetric('successfulSubmissions');
        await this.updateLatencySafe(startTime);

        return {
          success: true,
          transactionHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          strategy: this.strategy,
          latencyMs: Date.now() - startTime,
          usedFallback: false,
        };
      }

      return {
        success: false,
        error: 'Transaction not confirmed',
        transactionHash: txHash,
        strategy: this.strategy,
        latencyMs: Date.now() - startTime,
        usedFallback: false,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        strategy: this.strategy,
        latencyMs: Date.now() - startTime,
        usedFallback: false,
      };
    }
  }

  /**
   * Send with gas optimization for standard chains
   *
   * NONCE-CONSISTENCY-FIX: Now accepts already-prepared transaction to ensure
   * consistent nonce across private and fallback paths.
   */
  private async sendWithGasOptimization(
    preparedTx: ethers.TransactionRequest,
    startTime: number
  ): Promise<MevSubmissionResult> {
    try {
      const response = await this.config.wallet.sendTransaction(preparedTx);
      const receipt = await response.wait();

      if (receipt) {
        await this.incrementMetric('successfulSubmissions');
        if (this.privateRpcUrl) {
          await this.incrementMetric('fallbackSubmissions');
        }
        await this.updateLatencySafe(startTime);

        return {
          success: true,
          transactionHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          strategy: this.strategy,
          latencyMs: Date.now() - startTime,
          usedFallback: !!this.privateRpcUrl,
        };
      }

      await this.incrementMetric('failedSubmissions');
      return {
        success: false,
        error: 'Transaction not confirmed',
        transactionHash: response.hash,
        strategy: this.strategy,
        latencyMs: Date.now() - startTime,
        usedFallback: !!this.privateRpcUrl,
      };
    } catch (error) {
      await this.incrementMetric('failedSubmissions');
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        strategy: this.strategy,
        latencyMs: Date.now() - startTime,
        usedFallback: !!this.privateRpcUrl,
      };
    }
  }

  /**
   * Prepare transaction with gas optimization
   *
   * NOTE: Nonce Management Architecture
   * The execution engine's NonceManager allocates nonces atomically to prevent
   * race conditions during concurrent executions. If a nonce is already set in
   * the incoming transaction, we respect it. Only fetch from chain if not set.
   * This ensures compatibility with both engine-managed and standalone usage.
   */
  private async prepareTransaction(
    tx: ethers.TransactionRequest,
    priorityFeeGwei?: number,
    aggressive: boolean = false
  ): Promise<ethers.TransactionRequest> {
    // Respect pre-allocated nonce from NonceManager if provided
    // Only fetch from chain if no nonce is set (standalone usage)
    const nonce = tx.nonce !== undefined && tx.nonce !== null
      ? tx.nonce
      : await this.config.provider.getTransactionCount(
          this.config.wallet.address,
          'pending'
        );

    const feeData = await this.config.provider.getFeeData();

    const preparedTx: ethers.TransactionRequest = {
      ...tx,
      from: this.config.wallet.address,
      nonce,
    };

    // Use EIP-1559 if supported
    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      preparedTx.type = 2;

      if (priorityFeeGwei !== undefined) {
        preparedTx.maxPriorityFeePerGas = ethers.parseUnits(
          priorityFeeGwei.toString(),
          'gwei'
        );
      } else {
        // Aggressive gas pricing for MEV protection
        const multiplier = aggressive ? 150n : 120n;
        preparedTx.maxPriorityFeePerGas =
          (feeData.maxPriorityFeePerGas * multiplier) / 100n;
      }

      // Set max fee with buffer
      const baseFee = feeData.maxFeePerGas - feeData.maxPriorityFeePerGas;
      const multiplier = aggressive ? 200n : 150n;
      preparedTx.maxFeePerGas =
        (baseFee * multiplier) / 100n +
        (preparedTx.maxPriorityFeePerGas as bigint);
    } else if (feeData.gasPrice) {
      // Legacy transaction
      preparedTx.type = 0;
      const multiplier = aggressive ? 150n : 120n;
      preparedTx.gasPrice = (feeData.gasPrice * multiplier) / 100n;
    }

    // Estimate gas if not provided
    if (!preparedTx.gasLimit) {
      try {
        const gasEstimate = await this.config.provider.estimateGas(preparedTx);
        preparedTx.gasLimit = (gasEstimate * 120n) / 100n;
      } catch {
        preparedTx.gasLimit = 500000n;
      }
    }

    return preparedTx;
  }

  /**
   * Wait for transaction confirmation
   */
  private async waitForTransaction(
    txHash: string
  ): Promise<ethers.TransactionReceipt | null> {
    const timeout = this.config.submissionTimeoutMs || MEV_DEFAULTS.submissionTimeoutMs;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        const receipt = await this.config.provider.getTransactionReceipt(txHash);
        if (receipt) {
          return receipt;
        }
      } catch {
        // Continue waiting
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    return null;
  }

  /**
   * Check health of private RPC
   */
  private async checkPrivateRpcHealth(): Promise<{ healthy: boolean; message: string }> {
    if (!this.privateRpcUrl) {
      return { healthy: true, message: 'No private RPC configured' };
    }

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.strategy === 'bloxroute' && this.config.bloxrouteAuthHeader) {
        headers['Authorization'] = this.config.bloxrouteAuthHeader;
      }

      const response = await fetch(this.privateRpcUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_blockNumber',
          params: [],
        }),
      });

      if (response.ok) {
        return { healthy: true, message: 'Private RPC is reachable' };
      }

      return {
        healthy: false,
        message: `Private RPC returned status ${response.status}`,
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Failed to reach private RPC: ${error instanceof Error ? error.message : String(error)}`,
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
 * Create a standard MEV provider for a chain
 */
export function createStandardProvider(
  config: MevProviderConfig
): StandardProvider {
  return new StandardProvider(config);
}
