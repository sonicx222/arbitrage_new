/**
 * L2 Sequencer MEV Protection Provider
 *
 * Implements MEV protection for L2 chains (Arbitrum, Optimism, Base, etc.)
 * that use a centralized sequencer for transaction ordering.
 *
 * L2s have inherent MEV protection because:
 * 1. Transactions are ordered by the sequencer (FCFS)
 * 2. No public mempool for frontrunning
 * 3. Block times are very fast (sub-second)
 *
 * This provider optimizes for speed by:
 * - Using aggressive gas settings
 * - Minimizing unnecessary checks
 * - Direct submission to sequencer RPC
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
} from './types';
import { AsyncMutex } from '../async/async-mutex';

// =============================================================================
// L2 Chain Configuration
// =============================================================================

/**
 * L2 chain-specific configuration
 */
interface L2ChainConfig {
  chainId: number;
  name: string;
  /** Average block time in ms (for timeout calculation) */
  blockTimeMs: number;
  /** Priority fee multiplier for faster inclusion */
  priorityFeeMultiplier: number;
  /** Whether chain supports EIP-1559 */
  supportsEip1559: boolean;
}

const L2_CHAIN_CONFIGS: Record<string, L2ChainConfig> = {
  arbitrum: {
    chainId: 42161,
    name: 'Arbitrum One',
    blockTimeMs: 250, // ~0.25s block time
    priorityFeeMultiplier: 1.1,
    supportsEip1559: true,
  },
  optimism: {
    chainId: 10,
    name: 'Optimism',
    blockTimeMs: 2000, // ~2s block time
    priorityFeeMultiplier: 1.2,
    supportsEip1559: true,
  },
  base: {
    chainId: 8453,
    name: 'Base',
    blockTimeMs: 2000, // ~2s block time
    priorityFeeMultiplier: 1.2,
    supportsEip1559: true,
  },
  zksync: {
    chainId: 324,
    name: 'zkSync Era',
    blockTimeMs: 1000, // ~1s block time
    priorityFeeMultiplier: 1.0,
    supportsEip1559: false, // Uses custom gas model
  },
  linea: {
    chainId: 59144,
    name: 'Linea',
    blockTimeMs: 2000,
    priorityFeeMultiplier: 1.1,
    supportsEip1559: true,
  },
};

// =============================================================================
// L2 Sequencer Provider Implementation
// =============================================================================

/**
 * L2 Sequencer provider for MEV-protected L2 chains
 *
 * Takes advantage of L2 sequencer ordering to achieve MEV protection
 * while optimizing for minimal latency.
 */
export class L2SequencerProvider implements IMevProvider {
  readonly chain: string;
  readonly strategy: MevStrategy = 'sequencer';

  private readonly config: MevProviderConfig;
  private readonly l2Config: L2ChainConfig;
  private metrics: MevMetrics;
  // Thread-safe metrics updates for concurrent submissions
  private readonly metricsMutex = new AsyncMutex();

  constructor(config: MevProviderConfig) {
    // Validate chain is an L2 with sequencer
    if (CHAIN_MEV_STRATEGIES[config.chain] !== 'sequencer') {
      throw new Error(
        `L2SequencerProvider is only for sequencer-based L2s. ` +
        `Chain "${config.chain}" uses strategy "${CHAIN_MEV_STRATEGIES[config.chain] || 'unknown'}"`
      );
    }

    this.chain = config.chain;
    this.config = config;
    this.l2Config = L2_CHAIN_CONFIGS[config.chain] || {
      chainId: 0,
      name: config.chain,
      blockTimeMs: 2000,
      priorityFeeMultiplier: 1.2,
      supportsEip1559: true,
    };

    this.metrics = this.createEmptyMetrics();
  }

  /**
   * Check if MEV protection is available and enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Send a transaction with L2 sequencer MEV protection
   *
   * For L2s, this is essentially direct submission with optimized gas settings.
   * The sequencer provides MEV protection by:
   * 1. Not having a public mempool
   * 2. FCFS ordering
   * 3. Fast block times preventing sandwich attacks
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
        strategy: 'sequencer',
        latencyMs: Date.now() - startTime,
        usedFallback: false,
      };
    }

    try {
      // Optionally simulate before submission
      if (options?.simulate) {
        const simResult = await this.simulateTransaction(tx);
        if (!simResult.success) {
          await this.incrementMetric('failedSubmissions');
          return {
            success: false,
            error: `Simulation failed: ${simResult.error}`,
            strategy: 'sequencer',
            latencyMs: Date.now() - startTime,
            usedFallback: false,
          };
        }
      }

      // Prepare transaction with optimized gas settings
      const preparedTx = await this.prepareTransaction(tx, options?.priorityFeeGwei);

      // Submit directly to sequencer (the L2 RPC endpoint)
      const response = await this.config.wallet.sendTransaction(preparedTx);

      // Wait for confirmation with appropriate timeout
      // Use cancellable timeout to prevent orphaned promises
      const timeout = this.getConfirmationTimeout();
      const receipt = await this.waitWithCancellableTimeout(response, timeout);

      if (!receipt) {
        // Timeout occurred - but tx may still be pending on-chain
        // This is a timeout, NOT a tx failure - the tx may still land
        await this.incrementMetric('failedSubmissions');
        return {
          success: false,
          error: 'Transaction confirmation timeout (tx may still be pending)',
          transactionHash: response.hash,
          strategy: 'sequencer',
          latencyMs: Date.now() - startTime,
          usedFallback: false,
        };
      }

      await this.incrementMetric('successfulSubmissions');
      await this.updateLatencySafe(startTime);

      return {
        success: true,
        transactionHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        strategy: 'sequencer',
        latencyMs: Date.now() - startTime,
        usedFallback: false,
      };
    } catch (error) {
      await this.incrementMetric('failedSubmissions');
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        strategy: 'sequencer',
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
      // Use eth_call for simulation
      const preparedTx = await this.prepareTransaction(tx);

      // Estimate gas to check if transaction will succeed
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
   * Check health of L2 sequencer connection
   */
  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    try {
      // Check if we can get the latest block
      const blockNumber = await this.config.provider.getBlockNumber();

      // Check if block is recent (within last 5 minutes for L2)
      const block = await this.config.provider.getBlock(blockNumber);
      if (block) {
        const age = Date.now() / 1000 - block.timestamp;
        if (age > 300) {
          return {
            healthy: false,
            message: `L2 sequencer appears stale. Latest block is ${age.toFixed(0)}s old`,
          };
        }
      }

      return {
        healthy: true,
        message: `${this.l2Config.name} sequencer is healthy. Block: ${blockNumber}`,
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Failed to reach ${this.l2Config.name} sequencer: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Prepare transaction with optimized gas settings for L2
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

    // CONSISTENCY-FIX: Use explicit undefined check instead of || to be consistent
    // with the nonce handling pattern above. Avoids treating chainId 0 as undefined.
    const preparedTx: ethers.TransactionRequest = {
      ...tx,
      from: this.config.wallet.address,
      nonce,
      chainId: this.l2Config.chainId != null ? this.l2Config.chainId : undefined,
    };

    // Get fee data
    const feeData = await this.config.provider.getFeeData();

    if (this.l2Config.supportsEip1559) {
      preparedTx.type = 2;

      // Set priority fee (with multiplier for faster inclusion)
      if (priorityFeeGwei !== undefined) {
        preparedTx.maxPriorityFeePerGas = ethers.parseUnits(
          priorityFeeGwei.toString(),
          'gwei'
        );
      } else if (feeData.maxPriorityFeePerGas) {
        // Apply chain-specific multiplier
        const basePriority = feeData.maxPriorityFeePerGas;
        const multiplier = BigInt(
          Math.floor(this.l2Config.priorityFeeMultiplier * 100)
        );
        preparedTx.maxPriorityFeePerGas = (basePriority * multiplier) / 100n;
      } else {
        // Low default for L2s (they're cheap)
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
    } else {
      // Legacy transaction (zkSync)
      preparedTx.type = 0;
      if (feeData.gasPrice) {
        preparedTx.gasPrice = feeData.gasPrice;
      }
    }

    // Estimate gas if not provided
    if (!preparedTx.gasLimit) {
      try {
        const gasEstimate = await this.config.provider.estimateGas(preparedTx);
        // Add 10% buffer (L2s have more predictable gas)
        preparedTx.gasLimit = (gasEstimate * 110n) / 100n;
      } catch {
        // Use reasonable default
        preparedTx.gasLimit = 500000n;
      }
    }

    return preparedTx;
  }

  /**
   * Get appropriate confirmation timeout based on L2 block time
   */
  private getConfirmationTimeout(): number {
    // Wait for ~10 blocks worth of time, minimum 10 seconds
    const timeout = Math.max(this.l2Config.blockTimeMs * 10, 10000);
    return Math.min(
      timeout,
      this.config.submissionTimeoutMs || 30000
    );
  }

  /**
   * Wait for transaction with cancellable timeout
   * Prevents orphaned promises by using a single promise that handles both cases
   */
  private async waitWithCancellableTimeout(
    response: ethers.TransactionResponse,
    timeoutMs: number
  ): Promise<ethers.TransactionReceipt | null> {
    return new Promise<ethers.TransactionReceipt | null>((resolve) => {
      let settled = false;

      // Set up timeout
      const timeoutId = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      }, timeoutMs);

      // Wait for receipt
      response.wait()
        .then((receipt) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeoutId);
            resolve(receipt);
          }
        })
        .catch(() => {
          // Transaction failed (reverted, dropped, etc.)
          if (!settled) {
            settled = true;
            clearTimeout(timeoutId);
            resolve(null);
          }
        });
    });
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
 * Create an L2 sequencer provider for a specific chain
 */
export function createL2SequencerProvider(
  config: MevProviderConfig
): L2SequencerProvider {
  return new L2SequencerProvider(config);
}

/**
 * Check if a chain uses L2 sequencer MEV protection
 */
export function isL2SequencerChain(chain: string): boolean {
  return CHAIN_MEV_STRATEGIES[chain] === 'sequencer';
}

/**
 * Get L2 chain configuration
 */
export function getL2ChainConfig(chain: string): L2ChainConfig | undefined {
  return L2_CHAIN_CONFIGS[chain];
}
