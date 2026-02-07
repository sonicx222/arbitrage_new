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
  MevStrategy,
  MevSubmissionResult,
  MevProviderConfig,
  BundleSimulationResult,
  CHAIN_MEV_STRATEGIES,
  MEV_DEFAULTS,
} from './types';
import { BaseMevProvider } from './base-provider';

// =============================================================================
// Standard Provider Implementation
// =============================================================================

/**
 * Standard MEV provider for chains without specialized protection
 *
 * Uses gas optimization and fast inclusion strategies to minimize MEV risk.
 * Can also integrate with BloXroute (BSC) and Fastlane (Polygon) when available.
 */
export class StandardProvider extends BaseMevProvider {
  readonly chain: string;
  readonly strategy: MevStrategy;

  private privateRpcUrl?: string;

  constructor(config: MevProviderConfig) {
    super(config);

    this.chain = config.chain;

    // Determine strategy based on chain
    this.strategy = CHAIN_MEV_STRATEGIES[config.chain] || 'standard';

    // Set up private RPC if available
    this.setupPrivateRpc();
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
   *
   * Simulation is enabled by default for safety (unified with FlashbotsProvider).
   * Set options.simulate = false to skip simulation.
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

    // METRICS-FIX: Check enabled BEFORE incrementing totalSubmissions.
    // When disabled, return immediately without affecting metrics.
    if (!this.isEnabled()) {
      return this.createFailureResult(
        'MEV protection disabled',
        startTime,
        false
      );
    }

    await this.incrementMetric('totalSubmissions');

    // Task 1.3: Track provider-specific metrics for observability
    if (this.strategy === 'bloxroute' && this.privateRpcUrl) {
      await this.incrementMetric('bloxrouteSubmissions');
    } else if (this.strategy === 'fastlane' && this.privateRpcUrl) {
      await this.incrementMetric('fastlaneSubmissions');
    }

    // NONCE-CONSISTENCY-FIX: Prepare transaction once at the top.
    // This ensures consistent nonce across private RPC and fallback paths,
    // preventing nonce gaps in standalone usage.
    let preparedTx: ethers.TransactionRequest | null = null;

    try {
      // Simulate before submission (enabled by default for safety - unified behavior)
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

      // Prepare transaction once - will be used for both private and fallback paths
      preparedTx = await this.prepareTransaction(tx, options?.priorityFeeGwei);

      // Try private RPC first if available
      if (this.privateRpcUrl) {
        const result = await this.sendViaPrivateRpc(preparedTx, startTime);
        if (result.success) {
          return result;
        }

        // Fall through to standard submission if private fails
        if (!this.isFallbackEnabled()) {
          await this.incrementMetric('failedSubmissions');
          return this.createFailureResult(
            `Private submission failed: ${result.error}. Fallback disabled.`,
            startTime,
            false
          );
        }
      }

      // Standard submission with gas optimization (use same preparedTx)
      return this.sendWithGasOptimization(preparedTx, startTime);
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
        return this.createFailureResult(
          result.error.message || 'Private RPC error',
          startTime,
          false
        );
      }

      const txHash = result.result;

      if (!txHash) {
        return this.createFailureResult(
          'No transaction hash returned from private RPC',
          startTime,
          false
        );
      }

      // Wait for confirmation
      const receipt = await this.waitForTransaction(txHash);

      if (receipt) {
        // PERF: Single mutex acquisition instead of 2 separate awaits
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
        'Transaction not confirmed',
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
        // PERF: Single mutex acquisition instead of up to 3 separate awaits
        const updates: Partial<Record<'successfulSubmissions' | 'fallbackSubmissions', number>> = {
          successfulSubmissions: 1,
        };
        if (this.privateRpcUrl) {
          updates.fallbackSubmissions = 1;
        }
        await this.batchUpdateMetrics(updates, startTime);

        return this.createSuccessResult(
          startTime,
          receipt.hash,
          receipt.blockNumber,
          undefined,
          !!this.privateRpcUrl // usedFallback = true if private RPC was configured but we fell back
        );
      }

      await this.incrementMetric('failedSubmissions');
      return this.createFailureResult(
        'Transaction not confirmed',
        startTime,
        !!this.privateRpcUrl,
        response.hash
      );
    } catch (error) {
      await this.incrementMetric('failedSubmissions');
      return this.createFailureResult(
        error instanceof Error ? error.message : String(error),
        startTime,
        !!this.privateRpcUrl
      );
    }
  }

  /**
   * Prepare transaction with gas optimization
   *
   * Uses aggressive gas pricing (120% of current) to improve inclusion speed
   * and reduce MEV exposure window.
   *
   * PERFORMANCE-FIX: Uses Promise.all for parallel nonce/fee fetches.
   * This reduces latency on the hot path by ~50% for transaction preparation.
   */
  private async prepareTransaction(
    tx: ethers.TransactionRequest,
    priorityFeeGwei?: number
  ): Promise<ethers.TransactionRequest> {
    // PERFORMANCE-FIX: Parallel fetch of nonce and fee data
    const [nonce, feeData] = await Promise.all([
      this.getNonce(tx),
      this.getFeeData(),
    ]);

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
        // Aggressive gas pricing (120%) for faster inclusion and MEV protection
        preparedTx.maxPriorityFeePerGas =
          (feeData.maxPriorityFeePerGas * 120n) / 100n;
      }

      // Set max fee with buffer (150% of base + priority)
      const baseFee = feeData.maxFeePerGas - feeData.maxPriorityFeePerGas;
      preparedTx.maxFeePerGas =
        (baseFee * 150n) / 100n +
        (preparedTx.maxPriorityFeePerGas as bigint);
    } else if (feeData.gasPrice) {
      // Legacy transaction
      preparedTx.type = 0;
      preparedTx.gasPrice = (feeData.gasPrice * 120n) / 100n;
    }

    // Estimate gas if not provided
    if (!preparedTx.gasLimit) {
      preparedTx.gasLimit = await this.estimateGasWithBuffer(preparedTx, 20, 500000n);
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
