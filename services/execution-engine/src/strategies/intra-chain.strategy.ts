/**
 * Intra-Chain Execution Strategy
 *
 * Executes arbitrage opportunities within a single chain using:
 * - Pre-flight simulation to detect reverts (Phase 1.1)
 * - Direct DEX swap execution (for users with capital)
 * - MEV protection via Flashbots (on supported chains)
 * - Atomic nonce management
 *
 * NOTE: For flash loan execution (capital-free), use FlashLoanStrategy instead.
 * This strategy is for direct DEX arbitrage where user has sufficient capital.
 *
 * Architecture Decision:
 * - IntraChainStrategy: Direct swaps with user's own capital
 * - FlashLoanStrategy: Flash loan-based execution (no capital required)
 * - StrategyFactory routes based on opportunity.type or opportunity.useFlashLoan
 *
 * @see engine.ts (parent service)
 * @see flash-loan.strategy.ts (for flash loan execution)
 */

import { ethers } from 'ethers';
import { MEV_CONFIG } from '@arbitrage/config';
import { getErrorMessage } from '@arbitrage/core';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type { StrategyContext, ExecutionResult, Logger } from '../types';
import { createErrorResult, createSuccessResult, ExecutionErrorCode, formatExecutionError } from '../types';
import { BaseExecutionStrategy } from './base.strategy';

export class IntraChainStrategy extends BaseExecutionStrategy {
  constructor(logger: Logger) {
    super(logger);
  }

  async execute(
    opportunity: ArbitrageOpportunity,
    ctx: StrategyContext
  ): Promise<ExecutionResult> {
    // FIX-6.1: Use ExecutionErrorCode enum for standardized error codes
    const chain = opportunity.buyChain;
    if (!chain) {
      return createErrorResult(
        opportunity.id,
        ExecutionErrorCode.NO_CHAIN,
        'unknown',
        opportunity.buyDex || 'unknown'
      );
    }

    // Validate this is actually an intra-chain opportunity
    // sellChain should either be undefined (same as buyChain) or equal to buyChain
    if (opportunity.sellChain && opportunity.sellChain !== chain) {
      return createErrorResult(
        opportunity.id,
        // Issue 6.1 Fix: Use formatExecutionError for consistent error formatting
        formatExecutionError(
          ExecutionErrorCode.CROSS_CHAIN_MISMATCH,
          `buy: ${chain}, sell: ${opportunity.sellChain}. Use CrossChainStrategy instead.`
        ),
        chain,
        opportunity.buyDex || 'unknown'
      );
    }

    // Validate required fields for DEX swap
    if (!opportunity.tokenIn || !opportunity.tokenOut || !opportunity.amountIn) {
      return createErrorResult(
        opportunity.id,
        // Issue 6.1 Fix: Use formatExecutionError for consistent error formatting
        formatExecutionError(
          ExecutionErrorCode.INVALID_OPPORTUNITY,
          'Missing required fields (tokenIn, tokenOut, amountIn)'
        ),
        chain,
        opportunity.buyDex || 'unknown'
      );
    }

    // Fix 6.2 & 9.1: Use validateContext helper to reduce code duplication
    // This consolidates the common wallet/provider check pattern
    const validation = this.validateContext(chain, ctx);
    if (!validation.valid) {
      return createErrorResult(
        opportunity.id,
        validation.error,
        chain,
        opportunity.buyDex || 'unknown'
      );
    }
    // Fix Bug 4.3: No need to destructure wallet/provider - they are accessed via ctx
    // in prepareDexSwapTransaction, ensureTokenAllowance, and submitTransaction.
    // The validation ensures both exist before proceeding.

    try {
      // Fix 8.4: Parallelize independent operations for latency reduction (~10-20ms savings)
      // getOptimalGasPrice and verifyOpportunityPrices don't depend on each other
      // and can run concurrently. This optimization matches FlashLoanStrategy.
      const [gasPrice, priceVerification] = await Promise.all([
        this.getOptimalGasPrice(chain, ctx),
        this.verifyOpportunityPrices(opportunity, chain),
      ]);

      if (!priceVerification.valid) {
        this.logger.warn('Price re-verification failed, aborting execution', {
          opportunityId: opportunity.id,
          reason: priceVerification.reason,
          originalProfit: opportunity.expectedProfit,
          currentProfit: priceVerification.currentProfit
        });

        return createErrorResult(
          opportunity.id,
          // Issue 6.1 Fix: Use formatExecutionError for consistent error formatting
          formatExecutionError(ExecutionErrorCode.PRICE_VERIFICATION, priceVerification.reason),
          chain,
          opportunity.buyDex || 'unknown'
        );
      }

      // Prepare DEX swap transaction (uses the base strategy's prepareDexSwapTransaction)
      const swapTx = await this.prepareDexSwapTransaction(opportunity, chain, ctx);

      // Ensure token allowance for the DEX router
      if (swapTx.to) {
        const amountIn = BigInt(opportunity.amountIn);
        try {
          await this.ensureTokenAllowance(
            opportunity.tokenIn,
            swapTx.to as string,
            amountIn,
            chain,
            ctx
          );
        } catch (approvalError) {
          return createErrorResult(
            opportunity.id,
            // Issue 6.1 Fix: Use formatExecutionError for consistent error formatting
            formatExecutionError(ExecutionErrorCode.APPROVAL_FAILED, getErrorMessage(approvalError)),
            chain,
            opportunity.buyDex || 'unknown'
          );
        }
      }

      // ==========================================================================
      // Phase 1.1: Pre-flight Simulation
      // ==========================================================================
      const simulationResult = await this.performSimulation(opportunity, swapTx, chain, ctx);

      if (simulationResult?.wouldRevert) {
        ctx.stats.simulationPredictedReverts++;
        this.logger.warn('Aborting execution: simulation predicted revert', {
          opportunityId: opportunity.id,
          revertReason: simulationResult.revertReason,
          simulationLatencyMs: simulationResult.latencyMs,
          provider: simulationResult.provider,
        });

        return createErrorResult(
          opportunity.id,
          // Issue 6.1 Fix: Use formatExecutionError for consistent error formatting
          formatExecutionError(ExecutionErrorCode.SIMULATION_REVERT, simulationResult.revertReason || 'unknown reason'),
          chain,
          opportunity.buyDex || 'unknown'
        );
      }

      // Apply MEV protection
      const protectedTx = await this.applyMEVProtection(swapTx, chain, ctx);

      // Fix 4.1: Removed manual nonce allocation - submitTransaction handles it
      // The previous code allocated nonce here AND in submitTransaction, which was
      // redundant. submitTransaction already:
      // 1. Checks if tx.nonce is set (uses it if so)
      // 2. Allocates from NonceManager if not set
      // 3. Handles nonce confirmation/failure
      // Letting submitTransaction handle all nonce management reduces code duplication
      // and ensures consistent nonce lifecycle management.

      // Submit transaction using base class method (handles nonce internally)
      const submitResult = await this.submitTransaction(protectedTx, chain, ctx, {
        opportunityId: opportunity.id,
        expectedProfit: opportunity.expectedProfit,
        initialGasPrice: gasPrice,
      });

      if (!submitResult.success) {
        return createErrorResult(
          opportunity.id,
          submitResult.error || 'Transaction submission failed',
          chain,
          opportunity.buyDex || 'unknown'
        );
      }

      // Calculate actual profit
      const actualProfit = submitResult.receipt
        ? await this.calculateActualProfit(submitResult.receipt, opportunity)
        : undefined;

      return createSuccessResult(
        opportunity.id,
        submitResult.txHash || submitResult.receipt?.hash || '',
        chain,
        opportunity.buyDex || 'unknown',
        {
          actualProfit,
          gasUsed: submitResult.receipt ? Number(submitResult.receipt.gasUsed) : undefined,
          gasCost: submitResult.receipt
            ? parseFloat(ethers.formatEther(submitResult.receipt.gasUsed * (submitResult.receipt.gasPrice || gasPrice)))
            : undefined,
        }
      );
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      this.logger.error('Intra-chain arbitrage execution failed', {
        opportunityId: opportunity.id,
        chain,
        error: errorMessage,
      });

      return createErrorResult(
        opportunity.id,
        errorMessage || 'Unknown error during execution',
        chain,
        opportunity.buyDex || 'unknown'
      );
    }
  }
}
