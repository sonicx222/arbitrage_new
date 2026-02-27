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
  MevStrategy,
  MevSubmissionResult,
  MevProviderConfig,
  BundleSimulationResult,
  CHAIN_MEV_STRATEGIES,
} from './types';
import { BaseMevProvider } from './base-provider';
import { getErrorMessage } from '../resilience/error-handling';
import { createPinoLogger, type ILogger } from '../logging';

// P2 Fix O-4: Lazy-initialized module logger for transaction wait errors
let _l2Logger: ILogger | null = null;
function getL2Logger(): ILogger {
  if (!_l2Logger) _l2Logger = createPinoLogger('l2-sequencer-provider');
  return _l2Logger;
}
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
export class L2SequencerProvider extends BaseMevProvider {
  readonly chain: string;
  readonly strategy: MevStrategy = 'sequencer';

  private readonly l2Config: L2ChainConfig;

  constructor(config: MevProviderConfig) {
    super(config);

    // Validate chain is an L2 with sequencer support.
    // Check L2_CHAIN_CONFIGS (contains all L2s) rather than CHAIN_MEV_STRATEGIES
    // because some L2s (arbitrum, base) have enhanced primary strategies (timeboost,
    // flashbots_protect) but still support sequencer as a fallback.
    const strategy = CHAIN_MEV_STRATEGIES[config.chain];
    const hasL2Config = config.chain in L2_CHAIN_CONFIGS;

    if (!hasL2Config && strategy !== 'sequencer') {
      throw new Error(
        `L2SequencerProvider is only for sequencer-based L2s. ` +
        `Chain "${config.chain}" uses strategy "${strategy || 'unknown'}"`
      );
    }

    this.chain = config.chain;
    this.l2Config = L2_CHAIN_CONFIGS[config.chain] || {
      chainId: 0,
      name: config.chain,
      blockTimeMs: 2000,
      priorityFeeMultiplier: 1.2,
      supportsEip1559: true,
    };
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
   *
   * Simulation is enabled by default for safety (unified behavior across all providers).
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
        return this.createFailureResult(
          'Transaction confirmation timeout (tx may still be pending)',
          startTime,
          false,
          response.hash
        );
      }

      // PERF: Single mutex acquisition instead of 2 separate awaits
      await this.batchUpdateMetrics({
        successfulSubmissions: 1,
      }, startTime);

      return this.createSuccessResult(
        startTime,
        receipt.hash,
        receipt.blockNumber
      );
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
        error: getErrorMessage(error),
      };
    }
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
        message: `Failed to reach ${this.l2Config.name} sequencer: ${getErrorMessage(error)}`,
      };
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Prepare transaction with optimized gas settings for L2
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

    // chainId 0 is the fallback for unknown chains — let ethers fetch from network.
    // All known L2 configs (arbitrum, optimism, base, zksync, linea) have real IDs.
    const preparedTx: ethers.TransactionRequest = {
      ...tx,
      from: this.config.wallet.address,
      nonce,
      chainId: this.l2Config.chainId || undefined,
    };

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

    // Estimate gas if not provided (10% buffer for L2s - more predictable gas)
    if (!preparedTx.gasLimit) {
      preparedTx.gasLimit = await this.estimateGasWithBuffer(preparedTx, 10, 500000n);
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
      this.config.submissionTimeoutMs ?? 30000
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
        .catch((error) => {
          // P2 Fix O-4: Log transaction wait failure for diagnostics (was silent)
          getL2Logger().warn('Transaction wait failed (reverted/dropped), resolving null', {
            txHash: response.hash,
            error: getErrorMessage(error),
          });
          if (!settled) {
            settled = true;
            clearTimeout(timeoutId);
            resolve(null);
          }
        });
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
 * Check if a chain is an L2 with sequencer-based ordering.
 *
 * Returns true for all L2 chains that have sequencer support, including
 * chains with enhanced primary strategies (e.g., arbitrum with timeboost,
 * base with flashbots_protect) that fall back to sequencer.
 */
export function isL2SequencerChain(chain: string): boolean {
  return chain in L2_CHAIN_CONFIGS;
}

/**
 * Get L2 chain configuration
 */
export function getL2ChainConfig(chain: string): L2ChainConfig | undefined {
  return L2_CHAIN_CONFIGS[chain];
}
