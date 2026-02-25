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
  MevStrategy,
  MevSubmissionResult,
  MevProviderConfig,
  BundleSimulationResult,
  MEV_DEFAULTS,
} from './types';
import { BaseMevProvider } from './base-provider';
import { getErrorMessage } from '../resilience/error-handling';
// =============================================================================
// Flashbots Provider Implementation
// =============================================================================

/**
 * Flashbots provider for Ethereum mainnet MEV protection
 *
 * Uses Flashbots relay to submit private transaction bundles that are
 * included atomically without being visible in the public mempool.
 */
export class FlashbotsProvider extends BaseMevProvider {
  readonly chain = 'ethereum';
  readonly strategy: MevStrategy = 'flashbots';

  private readonly authSigner: ethers.Wallet | ethers.HDNodeWallet;
  private readonly relayUrl: string;

  /**
   * Cache for auth signatures to avoid blocking signMessageSync calls.
   * Maps body hash -> { signature, timestamp }
   * Cache entries expire after 5 minutes to handle key rotation.
   */
  private readonly signatureCache = new Map<string, { signature: string; timestamp: number }>();
  private readonly SIGNATURE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  private readonly SIGNATURE_CACHE_MAX_SIZE = 1000; // Hard cap to prevent memory leak

  /**
   * Cached chain ID - fetched once from provider if not in config.
   * CONFIG-FIX: Supports testnets (Sepolia=11155111, Holesky=17000) in addition to mainnet.
   */
  private cachedChainId: number | null = null;

  /**
   * Guard flag to prevent concurrent cache cleanup.
   * RACE-FIX: Ensures only one cleanup runs at a time.
   */
  private isCleaningCache = false;

  constructor(config: MevProviderConfig) {
    super(config);

    if (config.chain !== 'ethereum') {
      // DOC-FIX: Error message now reflects testnet support (Sepolia, Holesky)
      throw new Error(
        'FlashbotsProvider is only for Ethereum (mainnet and testnets like Sepolia, Holesky)'
      );
    }

    this.relayUrl = config.flashbotsRelayUrl || MEV_DEFAULTS.flashbotsRelayUrl;

    // Use provided chainId if available
    if (config.chainId !== undefined) {
      this.cachedChainId = config.chainId;
    }

    // Create auth signer for Flashbots reputation
    // If no auth key provided, generate a random one (lower reputation)
    if (config.flashbotsAuthKey) {
      this.authSigner = new ethers.Wallet(config.flashbotsAuthKey);
    } else {
      this.authSigner = ethers.Wallet.createRandom();
    }
  }

  /**
   * Get chain ID, caching after first fetch for performance.
   * Uses config value if provided, otherwise fetches from provider.
   */
  private async getChainId(): Promise<number> {
    if (this.cachedChainId !== null) {
      return this.cachedChainId;
    }

    const network = await this.config.provider.getNetwork();
    this.cachedChainId = Number(network.chainId);
    return this.cachedChainId;
  }

  /**
   * Dispose of provider resources.
   * Clears signature cache and resets metrics.
   */
  override dispose(): void {
    this.signatureCache.clear();
    super.dispose();
  }

  /**
   * Check if MEV protection is available and enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Send a transaction with Flashbots MEV protection
   *
   * Simulation is enabled by default for safety. Set options.simulate = false
   * to skip simulation (not recommended for production).
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
    // When disabled, return failure directly (consistent with L2SequencerProvider, StandardProvider, JitoProvider).
    // Don't attempt fallback - disabled means the user doesn't want any submission via this provider.
    if (!this.isEnabled()) {
      return this.createFailureResult('MEV protection disabled', startTime, false);
    }

    await this.incrementMetric('totalSubmissions');

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

      // Simulate before submission (enabled by default for safety)
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
        // PERF: Single mutex acquisition instead of 3 separate awaits
        await this.batchUpdateMetrics({
          successfulSubmissions: 1,
          bundlesIncluded: 1,
        }, startTime);

        return this.createSuccessResult(
          startTime,
          bundleResult.transactionHash!,
          targetBlock,
          bundleResult.bundleHash
        );
      }

      // Bundle submission failed, try fallback if enabled
      return this.fallbackToPublic(
        preparedTx, // Use prepared tx with nonce
        startTime,
        bundleResult.error || 'Bundle submission failed'
      );
    } catch (error) {
      // METRICS-FIX: Don't increment failedSubmissions here - fallbackToPublic handles it.
      // This prevents double-counting when fallback is disabled or when fallback also fails.
      // Matches JitoProvider pattern for consistent metrics across all providers.
      const errorMessage = getErrorMessage(error);
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
        error: getErrorMessage(error),
      };
    }
  }

  /**
   * Check health of Flashbots relay connection
   *
   * Uses eth_blockNumber JSON-RPC call to verify relay is responding.
   * This is more reliable than GET requests which may not be supported.
   */
  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    try {
      // Use JSON-RPC call to check relay health (Flashbots relay expects POST)
      const body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_blockNumber',
        params: [],
      };

      const response = await this.sendRelayRequest(body, 5000); // 5s timeout for health check

      // Check if we got a valid response (even an error response means relay is reachable)
      if (response.result || response.error) {
        return { healthy: true, message: 'Flashbots relay is reachable and responding' };
      }

      return {
        healthy: false,
        message: 'Flashbots relay returned unexpected response',
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Failed to reach Flashbots relay: ${getErrorMessage(error)}`,
      };
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Prepare transaction with proper gas settings for Flashbots
   *
   * CONFIG-FIX: Now uses dynamic chainId instead of hardcoded 1.
   * Supports Ethereum mainnet (1), Sepolia (11155111), Holesky (17000).
   */
  protected async prepareTransaction(
    tx: ethers.TransactionRequest,
    priorityFeeGwei?: number
  ): Promise<ethers.TransactionRequest> {
    const [nonce, feeData, chainId] = await Promise.all([
      this.getNonce(tx),
      this.getFeeData(),
      this.getChainId(),
    ]);

    // Use EIP-1559 transaction format
    const preparedTx: ethers.TransactionRequest = {
      ...tx,
      from: this.config.wallet.address,
      nonce,
      type: 2, // EIP-1559
      chainId, // Dynamic: supports mainnet and testnets
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
      preparedTx.gasLimit = await this.estimateGasWithBuffer(preparedTx, 20, 500000n);
    }

    return preparedTx;
  }

  /**
   * Simulate bundle using eth_callBundle
   */
  protected async simulateBundle(
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
                gasUsed: BigInt(r.gasUsed ?? 0),
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
          ? BigInt(result.gasFees) / BigInt(result.totalGasUsed ?? 1)
          : undefined,
        coinbaseDiff: result.coinbaseDiff ? BigInt(result.coinbaseDiff) : undefined,
        results: result.results?.map((r: any) => ({
          txHash: r.txHash || '',
          gasUsed: BigInt(r.gasUsed ?? 0),
          success: !r.error && !r.revert,
          revertReason: r.revert,
        })),
      };
    } catch (error) {
      return {
        success: false,
        error: getErrorMessage(error),
      };
    }
  }

  /**
   * Submit bundle to Flashbots relay using eth_sendBundle
   *
   * Protected to allow MevShareProvider to submit directly via Flashbots
   * relay when MEV-Share fails, without going through sendProtectedTransaction
   * (which would double-count totalSubmissions metrics).
   */
  protected async submitBundle(
    signedTransactions: string[],
    blockNumber: number
  ): Promise<{
    success: boolean;
    transactionHash?: string;
    bundleHash?: string;
    error?: string;
  }> {
    const maxRetries = this.config.maxRetries ?? MEV_DEFAULTS.maxRetries;
    const timeout = this.config.submissionTimeoutMs ?? MEV_DEFAULTS.submissionTimeoutMs;

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
            signedTransactions,
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
          lastError = `Block ${targetBlock}, retry ${retry}: ${getErrorMessage(error)}`;
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
   *
   * FIX: Now properly verifies the transaction is actually in the block
   * by computing tx hash from signed transaction and checking block contents.
   *
   * PERF-FIX: Removed redundant receipt fetches - single fetch checks both
   * target block and target+1 with one RPC call.
   *
   * PERF: Uses exponential backoff starting at 500ms, doubling up to 4s max.
   * This reduces RPC load while maintaining responsiveness for fast blocks.
   */
  protected async waitForInclusion(
    bundleHash: string,
    signedTransactions: string[],
    targetBlock: number,
    timeoutMs: number
  ): Promise<{ included: boolean; transactionHash?: string }> {
    const startTime = Date.now();

    // PERF: Exponential backoff - start aggressive (500ms), back off over time
    const basePollInterval = 500;
    const maxPollInterval = 4000; // Cap at 4 seconds
    let currentInterval = basePollInterval;

    // Pre-compute expected transaction hash from the first signed tx
    // This is more reliable than waiting for the API to return it
    const expectedTxHash = ethers.keccak256(signedTransactions[0]);

    while (Date.now() - startTime < timeoutMs) {
      try {
        // First check if our transaction is already in the target block
        const currentBlock = await this.config.provider.getBlockNumber();

        if (currentBlock >= targetBlock) {
          // Block has been mined, check if our tx is in it
          // PERF-FIX: Single receipt fetch - reuse for both target and target+1 check
          const receipt = await this.config.provider.getTransactionReceipt(expectedTxHash);

          if (receipt) {
            // Accept if in target block or target+1 (timing tolerance)
            if (receipt.blockNumber <= targetBlock + 1) {
              return {
                included: true,
                transactionHash: expectedTxHash,
              };
            }
          }

          // Check if target block has passed without our tx
          if (currentBlock > targetBlock + 1) {
            return { included: false };
          }
        }

        // Also poll Flashbots API for bundle status as backup
        const body = {
          jsonrpc: '2.0',
          id: 1,
          method: 'flashbots_getBundleStatsV2',
          params: [{ bundleHash, blockNumber: `0x${targetBlock.toString(16)}` }],
        };

        const response = await this.sendRelayRequest(body);

        // Check if bundle was marked as included by Flashbots
        if (response.result?.isSimulated) {
          const bundleStatus = response.result;

          // If Flashbots says it's included, verify on-chain
          if (bundleStatus.consideredByBuildersAt && bundleStatus.consideredByBuildersAt.length > 0) {
            const receipt = await this.config.provider.getTransactionReceipt(expectedTxHash);
            if (receipt) {
              return {
                included: true,
                transactionHash: expectedTxHash,
              };
            }
          }
        }

        // Wait before next poll with exponential backoff
        await new Promise((resolve) => setTimeout(resolve, currentInterval));
        currentInterval = Math.min(currentInterval * 2, maxPollInterval);
      } catch {
        // Continue polling on errors with backoff
        await new Promise((resolve) => setTimeout(resolve, currentInterval));
        currentInterval = Math.min(currentInterval * 2, maxPollInterval);
      }
    }

    return { included: false };
  }

  /**
   * Send request to Flashbots relay with authentication
   *
   * PERFORMANCE-FIX: Uses async signature with caching to avoid
   * blocking the event loop on the hot path.
   *
   * @param body - JSON-RPC request body
   * @param timeoutMs - Optional timeout override
   * @param url - Optional URL override (used by MevShareProvider for MEV-Share endpoint)
   */
  protected async sendRelayRequest(
    body: object,
    timeoutMs?: number,
    url?: string
  ): Promise<any> {
    const bodyString = JSON.stringify(body);
    const headers = await this.getAuthHeaders(bodyString);

    const controller = new AbortController();
    const timeout = timeoutMs ?? MEV_DEFAULTS.submissionTimeoutMs;
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url ?? this.relayUrl, {
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
   *
   * PERFORMANCE-FIX: Uses async signMessage with caching instead of
   * blocking signMessageSync. Signatures are cached for 5 minutes
   * to avoid repeated signing of the same payload.
   *
   * Changed to protected to allow MevShareProvider to reuse authentication.
   */
  protected async getAuthHeaders(body: string): Promise<Record<string, string>> {
    const bodyHash = ethers.id(body);

    // Check cache first
    const cached = this.signatureCache.get(bodyHash);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < this.SIGNATURE_CACHE_TTL_MS) {
      return {
        'Content-Type': 'application/json',
        'X-Flashbots-Signature': `${this.authSigner.address}:${cached.signature}`,
      };
    }

    // Sign asynchronously (non-blocking)
    const signature = await this.authSigner.signMessage(bodyHash);

    // Cache the signature
    this.signatureCache.set(bodyHash, { signature, timestamp: now });

    // PERF-FIX: Schedule cleanup asynchronously to not block hot path.
    // RACE-FIX: Check guard flag BEFORE size to prevent unnecessary calls.
    // MEMORY-FIX: Trigger cleanup at soft limit (100) or if hard cap exceeded.
    if (!this.isCleaningCache && (this.signatureCache.size > 100 || this.signatureCache.size >= this.SIGNATURE_CACHE_MAX_SIZE)) {
      this.scheduleSignatureCacheCleanup();
    }

    return {
      'Content-Type': 'application/json',
      'X-Flashbots-Signature': `${this.authSigner.address}:${signature}`,
    };
  }

  /**
   * Schedule signature cache cleanup on next tick (non-blocking)
   *
   * PERF-FIX: Uses setImmediate to defer cleanup off the hot path.
   * RACE-FIX: Guard flag prevents concurrent cleanups and is set before
   * yielding to event loop.
   * MEMORY-FIX: Enforces hard cap by evicting oldest entries.
   */
  private scheduleSignatureCacheCleanup(): void {
    // Set guard flag synchronously before yielding
    this.isCleaningCache = true;

    setImmediate(() => {
      try {
        const now = Date.now();

        // First pass: remove expired entries
        for (const [key, value] of this.signatureCache.entries()) {
          if (now - value.timestamp >= this.SIGNATURE_CACHE_TTL_MS) {
            this.signatureCache.delete(key);
          }
        }

        // Second pass: if still over hard cap, evict oldest entries
        if (this.signatureCache.size >= this.SIGNATURE_CACHE_MAX_SIZE) {
          // Convert to array, sort by timestamp, and evict oldest until under 80% of cap
          const entries = Array.from(this.signatureCache.entries())
            .sort((a, b) => a[1].timestamp - b[1].timestamp);

          const targetSize = Math.floor(this.SIGNATURE_CACHE_MAX_SIZE * 0.8);
          const entriesToRemove = entries.length - targetSize;

          for (let i = 0; i < entriesToRemove && i < entries.length; i++) {
            this.signatureCache.delete(entries[i][0]);
          }
        }
      } finally {
        this.isCleaningCache = false;
      }
    });
  }

  /**
   * Fallback to public mempool submission
   *
   * Changed to protected to allow MevShareProvider to use fallback logic.
   */
  protected async fallbackToPublic(
    tx: ethers.TransactionRequest,
    startTime: number,
    reason: string
  ): Promise<MevSubmissionResult> {
    if (!this.isFallbackEnabled()) {
      await this.incrementMetric('failedSubmissions');
      return this.createFailureResult(
        `Protected submission failed: ${reason}. Fallback disabled.`,
        startTime,
        false
      );
    }

    try {
      // Submit to public mempool
      const response = await this.config.wallet.sendTransaction(tx);
      const receipt = await response.wait();

      // PERF: Single mutex acquisition for all metric updates
      await this.batchUpdateMetrics({
        fallbackSubmissions: 1,
        successfulSubmissions: 1,
      }, startTime);

      return this.createSuccessResult(
        startTime,
        receipt?.hash || response.hash,
        receipt?.blockNumber,
        undefined,
        true // usedFallback
      );
    } catch (error) {
      await this.incrementMetric('failedSubmissions');
      return this.createFailureResult(
        `Protected and fallback both failed. Original: ${reason}. Fallback: ${getErrorMessage(error)}`,
        startTime,
        true
      );
    }
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
