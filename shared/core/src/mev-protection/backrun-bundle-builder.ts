/**
 * Backrun Bundle Builder for MEV-Share
 *
 * Constructs backrun bundles that reference a target transaction from the
 * MEV-Share event stream. The bundle is structured so our transaction
 * executes immediately after the target swap, capturing the price impact.
 *
 * ## Bundle Structure
 *
 * A backrun bundle contains:
 * 1. The target transaction hash (reference only — not included in our bundle)
 * 2. Our backrun transaction (the arbitrage trade)
 *
 * The bundle is submitted via mev_sendBundle with the target tx hash in the
 * `body` array as a `{hash: "0x..."}` entry, followed by our signed tx.
 *
 * ## Profit Sharing
 *
 * MEV-Share requires profit sharing with the original user. The `refundPercent`
 * config specifies the percentage the searcher retains (default: 90%). The
 * remaining percentage is refunded to the original transaction sender.
 *
 * @see https://docs.flashbots.net/flashbots-mev-share/searchers/sending-bundles
 * @see Phase 2 Item #23: MEV-Share backrun filling
 */

import { ethers } from 'ethers';
import type { Logger } from '../logger';
import { CircuitBreaker, CircuitBreakerError } from '../resilience/circuit-breaker';
import type { BackrunOpportunity } from './mev-share-event-listener';

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for building backrun bundles.
 */
export interface BackrunBundleBuilderConfig {
  /** Wallet for signing backrun transactions */
  wallet: ethers.Wallet;
  /** JSON RPC provider for gas estimation and block info */
  provider: ethers.JsonRpcProvider;
  /** Flashbots auth signing key for relay authentication */
  flashbotsAuthKey?: string;
  /** MEV-Share relay URL (default: https://relay.flashbots.net) */
  relayUrl?: string;
  /**
   * Fix #40: Alternative relay URLs for fallback submission.
   * Tried in order after the primary relayUrl fails.
   */
  relayUrls?: string[];
  /**
   * Percentage of bundle profit retained by the searcher (0-100, default: 90).
   * The remaining percentage (100 - refundPercent) is refunded to the original
   * transaction sender via MEV-Share's refundConfig mechanism.
   *
   * @see https://docs.flashbots.net/flashbots-mev-share/searchers/sending-bundles
   */
  refundPercent?: number;
  /** Maximum blocks to include bundle (default: 10) */
  maxBlockRange?: number;
  /** Fix #63: Fallback max fee in gwei when feeData is null (default: 50) */
  fallbackMaxFeeGwei?: number;
  /** Fix #63: Fallback priority fee in gwei when feeData is null (default: 2) */
  fallbackPriorityFeeGwei?: number;
  /** Logger instance */
  logger: Logger;
}

/**
 * A constructed backrun bundle ready for submission.
 */
export interface BackrunBundle {
  /** Target transaction hash to backrun */
  targetTxHash: string;
  /** Signed backrun transaction */
  signedBackrunTx: string;
  /** Target block number */
  targetBlock: number;
  /** Maximum block for inclusion */
  maxBlock: number;
  /** The full bundle payload for mev_sendBundle */
  payload: Record<string, unknown>;
}

/**
 * Result of submitting a backrun bundle.
 */
export interface BackrunSubmissionResult {
  /** Whether submission was successful */
  success: boolean;
  /** Bundle hash from relay */
  bundleHash?: string;
  /** Error message if failed */
  error?: string;
  /** Target tx hash that was backrun */
  targetTxHash: string;
  /** Latency of submission in ms */
  latencyMs: number;
}

// =============================================================================
// Bundle Builder Implementation
// =============================================================================

/**
 * Builds and submits backrun bundles for MEV-Share opportunities.
 *
 * @example
 * ```typescript
 * const builder = new BackrunBundleBuilder({
 *   wallet,
 *   provider,
 *   flashbotsAuthKey: process.env.FLASHBOTS_AUTH_KEY,
 *   logger,
 * });
 *
 * // When a backrun opportunity is detected:
 * const bundle = await builder.buildBackrunBundle(opportunity, backrunTx);
 * const result = await builder.submitBundle(bundle);
 * ```
 */
export class BackrunBundleBuilder {
  private readonly config: Required<
    Pick<BackrunBundleBuilderConfig, 'relayUrl' | 'refundPercent' | 'maxBlockRange' | 'fallbackMaxFeeGwei' | 'fallbackPriorityFeeGwei'>
  > & BackrunBundleBuilderConfig;

  private readonly logger: Logger;
  private readonly authSigner: ethers.Wallet | ethers.HDNodeWallet;

  /** Fix #40: All relay URLs to try (primary + alternatives) */
  private readonly allRelayUrls: string[];

  /**
   * Fix #44: Circuit breaker around relay submissions.
   * Prevents repeated submission attempts when the relay is persistently down,
   * saving latency and reducing log noise.
   */
  private readonly relayCircuitBreaker: CircuitBreaker;

  /** Submission metrics */
  private metrics = {
    bundlesBuilt: 0,
    bundlesSubmitted: 0,
    bundlesFailed: 0,
    totalLatencyMs: 0,
  };

  constructor(config: BackrunBundleBuilderConfig) {
    // P0 Fix #3: Remove ...config spread which overwrites ?? defaults with undefined.
    // Use explicit ?? per field only. Required fields passed directly from config.
    const primaryRelay = config.relayUrl ?? 'https://relay.flashbots.net';
    this.config = {
      wallet: config.wallet,
      provider: config.provider,
      flashbotsAuthKey: config.flashbotsAuthKey,
      relayUrls: config.relayUrls,
      logger: config.logger,
      relayUrl: primaryRelay,
      // FIX 15: Clamp refundPercent to 0-100 range to prevent invalid bundle payloads
      refundPercent: Math.max(0, Math.min(100, config.refundPercent ?? 90)),
      maxBlockRange: config.maxBlockRange ?? 10,
      fallbackMaxFeeGwei: config.fallbackMaxFeeGwei ?? 50,
      fallbackPriorityFeeGwei: config.fallbackPriorityFeeGwei ?? 2,
    };

    this.logger = config.logger;

    // Fix #40: Build relay URL list (primary first, then alternatives)
    this.allRelayUrls = [primaryRelay];
    if (config.relayUrls) {
      for (const url of config.relayUrls) {
        if (url !== primaryRelay) {
          this.allRelayUrls.push(url);
        }
      }
    }

    // Fix #44: Circuit breaker for relay submissions (5 failures in 60s → open for 30s)
    this.relayCircuitBreaker = new CircuitBreaker({
      name: 'backrun-relay',
      failureThreshold: 5,
      recoveryTimeout: 30_000,
      monitoringPeriod: 60_000,
      successThreshold: 2,
    });

    // Auth signer for Flashbots relay
    if (config.flashbotsAuthKey) {
      this.authSigner = new ethers.Wallet(config.flashbotsAuthKey);
    } else {
      this.authSigner = ethers.Wallet.createRandom();
      // Fix #20: Warn about poor searcher reputation when using a random auth signer.
      // A new identity each startup means zero reputation with Flashbots, lowering bundle inclusion rate.
      this.logger.warn('Using random Flashbots auth signer — poor searcher reputation. Set FLASHBOTS_AUTH_KEY for better inclusion.', {
        authAddress: this.authSigner.address,
      });
    }
  }

  /**
   * Build a backrun bundle for an MEV-Share opportunity.
   *
   * @param opportunity - The detected backrun opportunity from the SSE stream
   * @param backrunTx - The prepared (unsigned) arbitrage transaction to execute after the target
   * @returns Constructed bundle ready for submission
   */
  async buildBackrunBundle(
    opportunity: BackrunOpportunity,
    backrunTx: ethers.TransactionRequest
  ): Promise<BackrunBundle> {
    // Set transaction parameters
    const preparedTx: ethers.TransactionRequest = {
      ...backrunTx,
      from: this.config.wallet.address,
      type: 2, // EIP-1559
      chainId: 1, // Ethereum mainnet (MEV-Share is Ethereum-only)
    };

    // Fix #22: Parallelize independent RPC calls (getBlockNumber, getTransactionCount, getFeeData)
    // These 3 calls are independent and can run in parallel, saving 100-300ms.
    const needsNonce = !preparedTx.nonce;
    const needsFeeData = !preparedTx.maxFeePerGas || !preparedTx.maxPriorityFeePerGas;

    const [currentBlock, nonce, feeData] = await Promise.all([
      this.config.provider.getBlockNumber(),
      needsNonce
        ? this.config.provider.getTransactionCount(this.config.wallet.address, 'pending')
        : Promise.resolve(undefined),
      needsFeeData
        ? this.config.provider.getFeeData()
        : Promise.resolve(undefined),
    ]);

    const targetBlock = currentBlock + 1;
    const maxBlock = targetBlock + this.config.maxBlockRange;

    if (needsNonce && nonce !== undefined) {
      preparedTx.nonce = nonce;
    }

    if (needsFeeData && feeData) {
      // Fix #63: Use configurable fallback gas fees instead of hardcoded values
      preparedTx.maxFeePerGas = feeData.maxFeePerGas ?? ethers.parseUnits(String(this.config.fallbackMaxFeeGwei), 'gwei');
      preparedTx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? ethers.parseUnits(String(this.config.fallbackPriorityFeeGwei), 'gwei');
    }

    // estimateGas depends on nonce and fee data, must stay sequential
    if (!preparedTx.gasLimit) {
      try {
        const estimated = await this.config.provider.estimateGas(preparedTx);
        // 20% buffer
        preparedTx.gasLimit = estimated + (estimated * 20n / 100n);
      } catch (error) {
        // Fix #57: Log gas estimation fallback instead of silently swallowing
        this.logger.debug('Gas estimation failed, using fallback gas limit', {
          fallbackGasLimit: 300000,
          error: error instanceof Error ? error.message : String(error),
        });
        preparedTx.gasLimit = 300000n;
      }
    }

    // Sign the backrun transaction
    const signedBackrunTx = await this.config.wallet.signTransaction(preparedTx);

    // Build MEV-Share bundle payload
    const payload: Record<string, unknown> = {
      version: 'v0.1',
      inclusion: {
        block: `0x${targetBlock.toString(16)}`,
        maxBlock: `0x${maxBlock.toString(16)}`,
      },
      body: [
        // Reference the target transaction (not included, just referenced)
        { hash: opportunity.txHash },
        // Our backrun transaction
        { tx: signedBackrunTx, canRevert: false },
      ],
      privacy: {
        // Fix #10: Flashbots MEV-Share spec requires hints as an array of strings,
        // not an object with boolean values.
        // @see https://docs.flashbots.net/flashbots-mev-share/searchers/sending-bundles
        hints: ['contract_address', 'function_selector'],
        builders: ['flashbots'],
      },
      // Profit sharing: searcher retains refundPercent% of bundle profit.
      // Remaining (100 - refundPercent)% is refunded to the original tx sender.
      refundConfig: [{
        address: this.config.wallet.address,
        percent: this.config.refundPercent,
      }],
    };

    this.metrics.bundlesBuilt++;

    this.logger.debug('Built backrun bundle', {
      targetTxHash: opportunity.txHash,
      targetBlock,
      maxBlock,
      refundPercent: this.config.refundPercent,
      router: opportunity.routerAddress,
      traceId: opportunity.traceId,
    });

    return {
      targetTxHash: opportunity.txHash,
      signedBackrunTx,
      targetBlock,
      maxBlock,
      payload,
    };
  }

  /**
   * Submit a backrun bundle to the MEV-Share relay.
   *
   * Fix #40: Retries on transient errors and falls back to alternative relays.
   */
  async submitBundle(bundle: BackrunBundle): Promise<BackrunSubmissionResult> {
    const startTime = Date.now();

    // Fix #44: Short-circuit when relay circuit breaker is open
    if (this.relayCircuitBreaker.getState() === 'OPEN') {
      this.metrics.bundlesFailed++;
      return {
        success: false,
        error: 'Relay circuit breaker is OPEN — skipping submission',
        targetTxHash: bundle.targetTxHash,
        latencyMs: Date.now() - startTime,
      };
    }

    // Try each relay URL; for the primary relay, retry once on transient errors
    for (let i = 0; i < this.allRelayUrls.length; i++) {
      const relayUrl = this.allRelayUrls[i];
      const isPrimary = i === 0;

      // Fix #44: Wrap relay submission in circuit breaker
      let result: BackrunSubmissionResult;
      try {
        result = await this.relayCircuitBreaker.execute(async () => {
          const r = await this.trySubmitToRelay(bundle, relayUrl, startTime);
          // Treat relay-level errors as failures for the circuit breaker
          if (!r.success && this.isRetryableError(r.error)) {
            throw new Error(r.error ?? 'Relay submission failed');
          }
          return r;
        });
      } catch (error) {
        if (error instanceof CircuitBreakerError) {
          this.metrics.bundlesFailed++;
          return {
            success: false,
            error: `Circuit breaker open: ${error.message}`,
            targetTxHash: bundle.targetTxHash,
            latencyMs: Date.now() - startTime,
          };
        }
        // FIX 7: Do NOT call trySubmitToRelay() again here. The error was already
        // thrown from inside the circuit breaker's execute(). Calling trySubmitToRelay()
        // again would bypass the circuit breaker AND cause triple submission when combined
        // with the primary retry logic below. Instead, create a failure result from the error.
        result = {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          targetTxHash: bundle.targetTxHash,
          latencyMs: Date.now() - startTime,
        };
      }

      if (result.success) {
        return result;
      }

      // Retry primary relay once on transient errors
      if (isPrimary && this.isRetryableError(result.error)) {
        this.logger.warn('Bundle submission failed on primary relay, retrying', {
          error: result.error,
          relayUrl,
          targetTxHash: bundle.targetTxHash,
        });
        // Fix: Wrap retry in circuit breaker to keep failure count accurate.
        // Previously called trySubmitToRelay() directly, bypassing the CB.
        try {
          const retryResult = await this.relayCircuitBreaker.execute(async () => {
            const r = await this.trySubmitToRelay(bundle, relayUrl, startTime);
            if (!r.success && this.isRetryableError(r.error)) {
              throw new Error(r.error ?? 'Relay retry failed');
            }
            return r;
          });
          if (retryResult.success) {
            return retryResult;
          }
        } catch (retryError) {
          // CB open or retry failed — continue to fallback relays
          this.logger.warn('Primary relay retry failed', {
            error: retryError instanceof Error ? retryError.message : String(retryError),
            relayUrl,
            targetTxHash: bundle.targetTxHash,
          });
        }
      }

      // Log failure and try next relay
      if (i < this.allRelayUrls.length - 1) {
        this.logger.warn('Bundle submission failed, trying alternative relay', {
          error: result.error,
          failedRelay: relayUrl,
          nextRelay: this.allRelayUrls[i + 1],
          targetTxHash: bundle.targetTxHash,
        });
      }
    }

    // All relays failed
    const latencyMs = Date.now() - startTime;
    this.metrics.bundlesFailed++;

    this.logger.error('Bundle submission failed on all relays', {
      targetTxHash: bundle.targetTxHash,
      relayCount: this.allRelayUrls.length,
      latencyMs,
    });

    return {
      success: false,
      error: 'Bundle submission failed on all relays',
      targetTxHash: bundle.targetTxHash,
      latencyMs,
    };
  }

  /**
   * Attempt to submit a bundle to a single relay URL.
   */
  private async trySubmitToRelay(
    bundle: BackrunBundle,
    relayUrl: string,
    overallStartTime: number,
  ): Promise<BackrunSubmissionResult> {
    try {
      const body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'mev_sendBundle',
        params: [bundle.payload],
      };

      const bodyString = JSON.stringify(body);
      const signature = await this.authSigner.signMessage(ethers.id(bodyString));

      const response = await fetch(relayUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Flashbots-Signature': `${this.authSigner.address}:${signature}`,
        },
        body: bodyString,
      });

      const result = await response.json() as {
        error?: { message?: string };
        result?: { bundleHash?: string };
      };

      const latencyMs = Date.now() - overallStartTime;
      this.metrics.totalLatencyMs += latencyMs;

      // FIX 8: Only count successful submissions, not relay errors
      if (result.error) {
        return {
          success: false,
          error: result.error.message ?? 'Bundle submission failed',
          targetTxHash: bundle.targetTxHash,
          latencyMs,
        };
      }

      this.metrics.bundlesSubmitted++;
      const bundleHash = result.result?.bundleHash;

      this.logger.info('Backrun bundle submitted', {
        bundleHash,
        targetTxHash: bundle.targetTxHash,
        relayUrl,
        latencyMs,
      });

      return {
        success: true,
        bundleHash,
        targetTxHash: bundle.targetTxHash,
        latencyMs,
      };
    } catch (error) {
      const latencyMs = Date.now() - overallStartTime;

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        targetTxHash: bundle.targetTxHash,
        latencyMs,
      };
    }
  }

  /**
   * Check if an error is transient and worth retrying.
   */
  private isRetryableError(error?: string): boolean {
    if (!error) return false;
    const retryablePatterns = [
      'timeout', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED',
      'network', 'fetch failed', '502', '503', '504',
    ];
    const lowerError = error.toLowerCase();
    return retryablePatterns.some(p => lowerError.includes(p.toLowerCase()));
  }

  /**
   * Get submission metrics.
   */
  getMetrics(): typeof this.metrics {
    return { ...this.metrics };
  }

  /**
   * Fix #44: Get relay circuit breaker for monitoring or testing.
   */
  getRelayCircuitBreaker(): CircuitBreaker {
    return this.relayCircuitBreaker;
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a backrun bundle builder.
 */
export function createBackrunBundleBuilder(
  config: BackrunBundleBuilderConfig
): BackrunBundleBuilder {
  return new BackrunBundleBuilder(config);
}
