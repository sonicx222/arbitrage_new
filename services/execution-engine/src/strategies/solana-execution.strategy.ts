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

  constructor(
    jupiterClient: JupiterSwapClient,
    txBuilder: SolanaTransactionBuilder,
    jitoProvider: ISolanaMevProvider,
    config: Partial<SolanaExecutionConfig> & { walletPublicKey: string },
    logger: Logger,
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
    };
    this.logger = logger;
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

    this.logger.info('Executing Solana arbitrage opportunity', {
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
      // Step 5: Build bundle transaction with Jito tip
      // -----------------------------------------------------------------------
      // Note: We need a Keypair for signing. The transaction builder requires it.
      // In production, the keypair is loaded from env. Here we pass the base64 tx
      // to the Jito provider which handles serialization.
      //
      // For the MVP, we submit the Jupiter swap transaction directly via Jito
      // without re-building (the tip is handled by Jito's sendProtectedTransaction).
      const swapTxBuffer = Buffer.from(swapResult.swapTransaction, 'base64');

      // Create a minimal SolanaTransactionLike for the Jito provider
      const txLike = {
        serialize: () => swapTxBuffer,
      };

      // -----------------------------------------------------------------------
      // Step 6: Submit bundle via Jito provider
      // -----------------------------------------------------------------------
      this.logger.info('Submitting Solana transaction via Jito', {
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
        this.logger.info('Solana arbitrage executed successfully', {
          opportunityId: opportunity.id,
          transactionHash: submissionResult.transactionHash,
          latencyMs,
          netProfitLamports: netProfitLamports.toString(),
          usedFallback: submissionResult.usedFallback,
        });

        return createSuccessResult(
          opportunity.id,
          submissionResult.transactionHash ?? '',
          chain,
          dex,
          {
            actualProfit: Number(netProfitLamports),
            latencyMs,
            usedMevProtection: !submissionResult.usedFallback,
          },
        );
      }

      this.logger.error('Solana arbitrage execution failed', {
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
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.error('Solana execution strategy error', {
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
}
