/**
 * Solana Execution Strategy
 *
 * Implements the ExecutionStrategy interface for Solana-native arbitrage.
 * Uses Jupiter V6 for swap routing, Jito for MEV-protected bundle submission.
 *
 * Does NOT extend BaseExecutionStrategy (which is EVM-specific with ethers.js).
 * Instead, implements ExecutionStrategy directly with Solana-native logic.
 *
 * Flow:
 * 1. Get Jupiter quote (inputMint → outputMint)
 * 2. Check price deviation vs detection-time estimate
 * 3. Check minimum profit after Jito tip deduction
 * 4. Get swap transaction from Jupiter
 * 5. Build bundle transaction with Jito tip
 * 6. Submit bundle via Jito provider
 * 7. Return ExecutionResult
 *
 * @see Phase 3 #29: Solana Execution with Jito Bundles
 * @see shared/core/src/mev-protection/jito-provider.ts - Jito bundle submission
 * @see services/execution-engine/src/solana/jupiter-client.ts - Jupiter V6 API
 */

import type { ArbitrageOpportunity } from '@arbitrage/types';
import {
  createSuccessResult,
  createErrorResult,
  createSkippedResult,
} from '@arbitrage/types';
import type { ExecutionStrategy, StrategyContext, Logger } from '../types';
import type { JupiterSwapClient } from '../solana/jupiter-client';
import type { SolanaTransactionBuilder } from '../solana/transaction-builder';
import type { ISolanaMevProvider } from '@arbitrage/core/mev-protection/types';
import { VersionedTransaction } from '@solana/web3.js';
import { generateTraceId } from '@arbitrage/core/tracing/trace-context';
import { getErrorMessage } from '@arbitrage/core/resilience';

// =============================================================================
// Types
// =============================================================================

export interface SolanaExecutionConfig {
  /** Wallet public key (base58 string) */
  walletPublicKey: string;
  /** Jito tip amount in lamports (default: 1_000_000 = 0.001 SOL) */
  tipLamports: number;
  /** Maximum slippage in basis points (default: 100 = 1%) */
  maxSlippageBps: number;
  /** Minimum profit in lamports after tip deduction */
  minProfitLamports: bigint;
  /** Maximum price deviation percentage to abort execution (default: 1%) */
  maxPriceDeviationPct: number;
  /** Timeout for transaction confirmation polling in ms (default: 30000) */
  confirmationTimeoutMs: number;
  /** Poll interval for transaction confirmation in ms (default: 500) */
  confirmationPollIntervalMs: number;
}

/**
 * Minimal interface for Solana transaction confirmation polling.
 *
 * Used by SolanaExecutionStrategy to verify on-chain finality after
 * Jito bundle submission. Without this, submitted transactions may be
 * dropped during slot leader changes, causing phantom profit tracking.
 *
 * @see H1 in Phase 3 Deep Analysis — transaction confirmation polling
 * @see jito-provider.ts SolanaConnection — compatible superset interface
 */
export interface SolanaConfirmationClient {
  getSignatureStatus(signature: string): Promise<{
    value: { confirmationStatus: string; slot?: number } | null;
  }>;
  getBlockHeight(): Promise<number>;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: SolanaExecutionConfig = {
  walletPublicKey: '',
  tipLamports: 1_000_000,
  maxSlippageBps: 100,
  minProfitLamports: 100_000n,
  maxPriceDeviationPct: 1.0,
  confirmationTimeoutMs: 30_000,
  confirmationPollIntervalMs: 500,
};

// =============================================================================
// Solana Execution Strategy
// =============================================================================

/**
 * Execution strategy for Solana-native arbitrage opportunities.
 *
 * Uses Jupiter for swap routing and Jito for MEV-protected bundle submission.
 * Implements pre-execution safety checks (price deviation, min profit).
 */
export class SolanaExecutionStrategy implements ExecutionStrategy {
  private readonly jupiterClient: JupiterSwapClient;
  private readonly txBuilder: SolanaTransactionBuilder;
  private readonly jitoProvider: ISolanaMevProvider;
  private readonly config: SolanaExecutionConfig;
  private readonly logger: Logger;
  private readonly confirmationClient: SolanaConfirmationClient | null;

  constructor(
    jupiterClient: JupiterSwapClient,
    txBuilder: SolanaTransactionBuilder,
    jitoProvider: ISolanaMevProvider,
    config: Partial<SolanaExecutionConfig> & { walletPublicKey: string },
    logger: Logger,
    confirmationClient?: SolanaConfirmationClient,
  ) {
    this.jupiterClient = jupiterClient;
    this.txBuilder = txBuilder;
    this.jitoProvider = jitoProvider;
    this.config = {
      walletPublicKey: config.walletPublicKey,
      tipLamports: config.tipLamports ?? DEFAULT_CONFIG.tipLamports,
      maxSlippageBps: config.maxSlippageBps ?? DEFAULT_CONFIG.maxSlippageBps,
      minProfitLamports: config.minProfitLamports ?? DEFAULT_CONFIG.minProfitLamports,
      maxPriceDeviationPct: config.maxPriceDeviationPct ?? DEFAULT_CONFIG.maxPriceDeviationPct,
      confirmationTimeoutMs: config.confirmationTimeoutMs ?? DEFAULT_CONFIG.confirmationTimeoutMs,
      confirmationPollIntervalMs: config.confirmationPollIntervalMs ?? DEFAULT_CONFIG.confirmationPollIntervalMs,
    };
    this.logger = logger;
    this.confirmationClient = confirmationClient ?? null;
  }

  /**
   * Execute a Solana arbitrage opportunity.
   *
   * @param opportunity - Detected arbitrage opportunity
   * @param _ctx - Strategy context (unused for Solana; included for interface compliance)
   * @returns Execution result with transaction details
   */
  async execute(
    opportunity: ArbitrageOpportunity,
    _ctx: StrategyContext,
  ): Promise<ReturnType<typeof createSuccessResult>> {
    const startTime = Date.now();
    const chain = opportunity.chain ?? 'solana';
    const dex = opportunity.buyDex ?? 'jupiter';
    // C3: Trace context for cross-service correlation
    const traceId = generateTraceId();

    this.logger.info('Executing Solana arbitrage opportunity', {
      traceId,
      opportunityId: opportunity.id,
      tokenIn: opportunity.tokenIn,
      tokenOut: opportunity.tokenOut,
      amountIn: opportunity.amountIn,
      estimatedProfit: opportunity.estimatedProfit,
    });

    try {
      // -----------------------------------------------------------------------
      // Step 1: Get Jupiter quote
      // -----------------------------------------------------------------------
      const inputMint = opportunity.tokenIn;
      const outputMint = opportunity.tokenOut;
      const amountIn = opportunity.amountIn;

      if (!inputMint || !outputMint || !amountIn) {
        return createErrorResult(
          opportunity.id,
          '[ERR_INVALID_OPPORTUNITY] Missing tokenIn, tokenOut, or amountIn for Solana execution',
          chain,
          dex,
        );
      }

      const quote = await this.jupiterClient.getQuote(
        inputMint,
        outputMint,
        amountIn,
        this.config.maxSlippageBps,
      );

      // -----------------------------------------------------------------------
      // Step 2: Check price deviation vs detection-time estimate
      // -----------------------------------------------------------------------
      if (opportunity.estimatedProfit !== undefined && opportunity.estimatedProfit > 0) {
        const quotedOutput = BigInt(quote.outAmount);
        const inputAmount = BigInt(quote.inAmount);

        // For a round-trip arb (tokenIn -> tokenOut -> tokenIn), the quote outAmount
        // represents the first leg. We compare the total expected output vs detection estimate.
        const detectionEstimate = opportunity.estimatedProfit;
        const quotedProfitEstimate = Number(quotedOutput - inputAmount);

        if (detectionEstimate > 0) {
          const deviationPct = Math.abs(
            ((quotedProfitEstimate - detectionEstimate) / detectionEstimate) * 100,
          );

          if (deviationPct > this.config.maxPriceDeviationPct) {
            this.logger.warn('Price deviation exceeds threshold, aborting', {
              traceId,
              opportunityId: opportunity.id,
              deviationPct,
              maxDeviationPct: this.config.maxPriceDeviationPct,
              detectionEstimate,
              quotedProfitEstimate,
            });

            return createSkippedResult(
              opportunity.id,
              `[ERR_PRICE_DEVIATION] Price deviation ${deviationPct.toFixed(2)}% exceeds max ${this.config.maxPriceDeviationPct}%`,
              chain,
              dex,
            );
          }
        }
      }

      // -----------------------------------------------------------------------
      // Step 3: Check minimum profit after tip deduction
      // -----------------------------------------------------------------------
      const quotedOutput = BigInt(quote.outAmount);
      const inputAmount = BigInt(quote.inAmount);
      const grossProfitLamports = quotedOutput - inputAmount;
      const netProfitLamports = grossProfitLamports - BigInt(this.config.tipLamports);

      if (netProfitLamports < this.config.minProfitLamports) {
        this.logger.warn('Net profit below minimum after tip, aborting', {
          traceId,
          opportunityId: opportunity.id,
          grossProfitLamports: grossProfitLamports.toString(),
          tipLamports: this.config.tipLamports,
          netProfitLamports: netProfitLamports.toString(),
          minProfitLamports: this.config.minProfitLamports.toString(),
        });

        return createSkippedResult(
          opportunity.id,
          `[ERR_LOW_PROFIT] Net profit ${netProfitLamports.toString()} lamports below minimum ${this.config.minProfitLamports.toString()}`,
          chain,
          dex,
        );
      }

      // -----------------------------------------------------------------------
      // Step 4: Get swap transaction from Jupiter
      // -----------------------------------------------------------------------
      const swapResult = await this.jupiterClient.getSwapTransaction(
        quote,
        this.config.walletPublicKey,
      );

      // -----------------------------------------------------------------------
      // Step 5: Build bundle transaction with Jito tip via SolanaTransactionBuilder
      // -----------------------------------------------------------------------
      // The txBuilder deserializes the Jupiter swap tx, appends a Jito tip
      // instruction, and re-signs with the wallet keypair. This ensures the
      // transaction has a valid signature (Jupiter txs require user signature).
      //
      // Note: buildBundleTransaction requires a Keypair. The Jito provider's
      // getWalletKeypair() provides it when available. If no keypair is available,
      // fall back to submitting the raw Jupiter tx via sendProtectedTransaction
      // (which handles signing internally for simple cases).
      //
      // ALT guard: When the Jupiter transaction uses Address Lookup Tables,
      // decompileInstructions() only reads staticAccountKeys and ALT-resolved
      // accounts become undefined, producing malformed transactions. Skip the
      // bundle building path and use the raw Jupiter tx in this case.
      let txLike: { serialize: () => Uint8Array };

      // Check if Jupiter tx uses Address Lookup Tables (ALTs)
      const swapTxBuffer = Buffer.from(swapResult.swapTransaction, 'base64');
      const deserializedTx = VersionedTransaction.deserialize(swapTxBuffer);
      const hasALTs = (deserializedTx.message.addressTableLookups?.length ?? 0) > 0;

      const keypair = this.jitoProvider.getWalletKeypair?.();
      if (keypair && !hasALTs) {
        const bundleTx = await this.txBuilder.buildBundleTransaction(
          swapResult.swapTransaction,
          keypair,
          this.config.tipLamports,
        );
        txLike = {
          serialize: () => bundleTx.serialize(),
        };
      } else if (hasALTs) {
        // Fallback: ALT transactions cannot be decompiled for bundle building.
        // Submit raw Jupiter tx — Jito provider handles tip internally.
        this.logger.warn('Jupiter tx uses Address Lookup Tables, skipping bundle building to avoid malformed instructions', {
          traceId,
          opportunityId: opportunity.id,
          altCount: deserializedTx.message.addressTableLookups.length,
        });
        txLike = {
          serialize: () => swapTxBuffer,
        };
      } else {
        // H2: No keypair available and no ALTs — cannot build Jito bundle or add tip.
        // Submitting without MEV protection risks sandwich attacks.
        return createErrorResult(
          opportunity.id,
          '[ERR_NO_KEYPAIR] Wallet keypair unavailable — cannot build Jito bundle or guarantee MEV protection',
          chain,
          dex,
        );
      }

      // -----------------------------------------------------------------------
      // Step 6: Submit bundle via Jito provider
      // -----------------------------------------------------------------------
      this.logger.info('Submitting Solana transaction via Jito', {
        traceId,
        opportunityId: opportunity.id,
        tipLamports: this.config.tipLamports,
      });

      const submissionResult = await this.jitoProvider.sendProtectedTransaction(txLike, {
        tipLamports: this.config.tipLamports,
        simulate: true,
      });

      // -----------------------------------------------------------------------
      // Step 7: Return ExecutionResult
      // -----------------------------------------------------------------------
      const latencyMs = Date.now() - startTime;

      if (submissionResult.success) {
        const txHash = submissionResult.transactionHash ?? '';

        // H1: Confirm transaction on-chain before recording profit.
        // Solana transactions may be dropped during slot leader changes.
        // Poll getSignatureStatus() up to lastValidBlockHeight for finality.
        if (this.confirmationClient && txHash) {
          const confirmation = await this.confirmTransaction(
            txHash,
            swapResult.lastValidBlockHeight,
            traceId,
            opportunity.id,
          );

          if (!confirmation.confirmed) {
            this.logger.error('Solana transaction not confirmed on-chain', {
              traceId,
              opportunityId: opportunity.id,
              transactionHash: txHash,
              reason: confirmation.reason,
              lastValidBlockHeight: swapResult.lastValidBlockHeight,
              latencyMs: Date.now() - startTime,
            });

            return createErrorResult(
              opportunity.id,
              `[${confirmation.errorCode}] ${confirmation.reason}`,
              chain,
              dex,
              txHash,
            );
          }

          this.logger.info('Solana arbitrage confirmed on-chain', {
            traceId,
            opportunityId: opportunity.id,
            transactionHash: txHash,
            confirmationSlot: confirmation.slot,
            latencyMs: Date.now() - startTime,
            netProfitLamports: netProfitLamports.toString(),
            usedFallback: submissionResult.usedFallback,
          });
        } else {
          // No confirmation client — log as unconfirmed (backward compatible)
          this.logger.info('Solana arbitrage submitted (confirmation polling unavailable)', {
            traceId,
            opportunityId: opportunity.id,
            transactionHash: txHash,
            latencyMs,
            netProfitLamports: netProfitLamports.toString(),
            usedFallback: submissionResult.usedFallback,
            lastValidBlockHeight: swapResult.lastValidBlockHeight,
            confirmationStatus: 'unconfirmed',
          });
        }

        return createSuccessResult(
          opportunity.id,
          txHash,
          chain,
          dex,
          {
            actualProfit: Number(netProfitLamports),
            latencyMs: Date.now() - startTime,
            usedMevProtection: !submissionResult.usedFallback,
          },
        );
      }

      this.logger.error('Solana arbitrage execution failed', {
        traceId,
        opportunityId: opportunity.id,
        error: submissionResult.error,
        latencyMs,
        usedFallback: submissionResult.usedFallback,
      });

      return createErrorResult(
        opportunity.id,
        `[ERR_JITO_SUBMISSION] ${submissionResult.error ?? 'Bundle submission failed'}`,
        chain,
        dex,
      );
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      const errorMessage = getErrorMessage(error);

      this.logger.error('Solana execution strategy error', {
        traceId,
        opportunityId: opportunity.id,
        error: errorMessage,
        latencyMs,
      });

      return createErrorResult(
        opportunity.id,
        `[ERR_SOLANA_EXECUTION] ${errorMessage}`,
        chain,
        dex,
      );
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Poll for Solana transaction confirmation up to lastValidBlockHeight.
   *
   * Solana transactions include a recent blockhash with a finite validity window.
   * If the block height exceeds lastValidBlockHeight and the transaction hasn't
   * been confirmed, it is guaranteed to have expired and will never land.
   *
   * @see H1 in Phase 3 Deep Analysis — prevents phantom profit tracking
   */
  private async confirmTransaction(
    signature: string,
    lastValidBlockHeight: number,
    traceId: string,
    opportunityId: string,
  ): Promise<{
    confirmed: boolean;
    slot?: number;
    reason?: string;
    errorCode?: string;
  }> {
    const startTime = Date.now();
    const { confirmationTimeoutMs, confirmationPollIntervalMs } = this.config;

    while (Date.now() - startTime < confirmationTimeoutMs) {
      try {
        // Check if transaction has been confirmed
        const status = await this.confirmationClient!.getSignatureStatus(signature);

        if (status.value) {
          const { confirmationStatus, slot } = status.value;

          if (confirmationStatus === 'confirmed' || confirmationStatus === 'finalized') {
            return { confirmed: true, slot };
          }
          // 'processed' means included but not yet confirmed — keep polling
        }
      } catch (error) {
        this.logger.debug('Confirmation polling error (will retry)', {
          traceId,
          opportunityId,
          signature,
          error: getErrorMessage(error),
        });
        // Continue polling — transient RPC errors shouldn't abort confirmation
      }

      // Check if block height has exceeded lastValidBlockHeight (tx expired)
      try {
        const currentBlockHeight = await this.confirmationClient!.getBlockHeight();
        if (currentBlockHeight > lastValidBlockHeight) {
          return {
            confirmed: false,
            reason: `Transaction expired: block height ${currentBlockHeight} exceeds lastValidBlockHeight ${lastValidBlockHeight}`,
            errorCode: 'ERR_TX_EXPIRED',
          };
        }
      } catch {
        // Block height check failed — don't abort, rely on timeout
      }

      await this.sleep(confirmationPollIntervalMs);
    }

    return {
      confirmed: false,
      reason: `Transaction not confirmed within ${confirmationTimeoutMs}ms timeout`,
      errorCode: 'ERR_TX_UNCONFIRMED',
    };
  }

  /**
   * Sleep helper for confirmation polling.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
