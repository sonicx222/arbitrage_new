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
import { DEXES } from '@arbitrage/config';
import { getErrorMessage } from '@arbitrage/core';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type { StrategyContext, ExecutionResult, Logger } from '../types';
import { createErrorResult, createSuccessResult, ExecutionErrorCode, formatExecutionError } from '../types';
import { BaseExecutionStrategy } from './base.strategy';

/**
 * Phase 2 Enhancement: Pre-computed DEX lookup for O(1) router address access.
 * Enables parallel pre-checks by determining router address early.
 *
 * BUG FIX: Aligned with base.strategy.ts logic - only uses sellDex for selection,
 * falls back to first DEX if sellDex is undefined (ignores buyDex for router selection).
 */
const DEXES_BY_CHAIN_AND_NAME: Map<string, Map<string, typeof DEXES[string][number]>> = new Map(
  Object.entries(DEXES).map(([chain, dexes]) => [
    chain,
    new Map(dexes.map(dex => [dex.name.toLowerCase(), dex]))
  ])
);

/**
 * Get router address using same logic as base.strategy.ts prepareDexSwapTransaction.
 * IMPORTANT: Only uses sellDex for selection, falls back to first DEX if undefined.
 * This matches the behavior in base.strategy.ts:913-915.
 */
function getRouterAddress(chain: string, sellDex?: string): string | undefined {
  // Match base.strategy.ts logic: only use sellDex, fall back to first DEX
  if (sellDex) {
    return DEXES_BY_CHAIN_AND_NAME.get(chain)?.get(sellDex.toLowerCase())?.routerAddress;
  }
  // Fall back to first DEX (same as getFirstDex in base.strategy.ts)
  return DEXES[chain]?.[0]?.routerAddress;
}

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
        // Issue 6.1 Fix: Use formatExecutionError for consistent error formatting
        formatExecutionError(ExecutionErrorCode.NO_CHAIN, 'buyChain is required'),
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
      // Phase 2 Enhancement: Expanded parallel pre-checks for latency reduction (~20-30ms savings)
      // Determine router address early to enable parallel allowance check
      // BUG FIX: Only use sellDex for router lookup (matches base.strategy.ts logic)
      const routerAddress = getRouterAddress(chain, opportunity.sellDex);
      const amountIn = BigInt(opportunity.amountIn);

      // Run 3 independent operations in parallel:
      // 1. getOptimalGasPrice - fetch current gas prices
      // 2. verifyOpportunityPrices - validate opportunity is still profitable
      // 3. checkTokenAllowanceStatus - check if approval is needed (read-only)
      const [gasPrice, priceVerification, allowanceStatus] = await Promise.all([
        this.getOptimalGasPrice(chain, ctx),
        this.verifyOpportunityPrices(opportunity, chain),
        routerAddress
          ? this.checkTokenAllowanceStatus(opportunity.tokenIn, routerAddress, amountIn, chain, ctx)
          : Promise.resolve({ sufficient: false, currentAllowance: 0n }),
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
          formatExecutionError(ExecutionErrorCode.PRICE_VERIFICATION, priceVerification.reason),
          chain,
          opportunity.buyDex || 'unknown'
        );
      }

      // Prepare DEX swap transaction (uses the base strategy's prepareDexSwapTransaction)
      const swapTx = await this.prepareDexSwapTransaction(opportunity, chain, ctx);

      // Only call ensureTokenAllowance if pre-check showed insufficient allowance
      if (swapTx.to && !allowanceStatus.sufficient) {
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
            formatExecutionError(ExecutionErrorCode.APPROVAL_FAILED, getErrorMessage(approvalError)),
            chain,
            opportunity.buyDex || 'unknown'
          );
        }
      } else if (allowanceStatus.sufficient) {
        this.logger.debug('Token allowance pre-check passed, skipping approval', {
          opportunityId: opportunity.id,
          token: opportunity.tokenIn,
          router: routerAddress,
          currentAllowance: allowanceStatus.currentAllowance.toString(),
          required: amountIn.toString(),
        });
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
      let protectedTx = await this.applyMEVProtection(swapTx, chain, ctx);

      // Phase 2 Enhancement: Apply dynamic gas limit from simulation (3-5% gas cost savings)
      // Uses gasLimit = simulatedGas * 1.15 (15% safety margin)
      protectedTx = this.applyDynamicGasLimit(protectedTx, simulationResult);

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
          // Fix 6.1: Use formatExecutionError for consistent error formatting
          formatExecutionError(ExecutionErrorCode.EXECUTION_ERROR, submitResult.error || 'Transaction submission failed'),
          chain,
          opportunity.buyDex || 'unknown'
        );
      }

      // Calculate actual profit
      const actualProfit = submitResult.receipt
        ? await this.calculateActualProfit(submitResult.receipt, opportunity)
        : undefined;

      // Calculate gas cost with sanity check for abnormal values
      let gasCost: number | undefined;
      if (submitResult.receipt) {
        const effectiveGasPrice = submitResult.receipt.gasPrice ?? gasPrice;
        // Sanity check: gasPrice should be < 10000 gwei (10^13 wei) under normal conditions
        // This catches data corruption without blocking execution
        const MAX_SANE_GAS_PRICE = 10n ** 13n; // 10000 gwei
        if (effectiveGasPrice > MAX_SANE_GAS_PRICE) {
          this.logger.warn('Abnormally high gas price detected in receipt', {
            opportunityId: opportunity.id,
            gasPrice: effectiveGasPrice.toString(),
            maxSane: MAX_SANE_GAS_PRICE.toString(),
          });
        }
        gasCost = parseFloat(ethers.formatEther(submitResult.receipt.gasUsed * effectiveGasPrice));
      }

      return createSuccessResult(
        opportunity.id,
        submitResult.txHash || submitResult.receipt?.hash || '',
        chain,
        opportunity.buyDex || 'unknown',
        {
          actualProfit,
          gasUsed: submitResult.receipt ? Number(submitResult.receipt.gasUsed) : undefined,
          gasCost,
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
        // Fix 6.1: Use formatExecutionError for consistent error formatting
        formatExecutionError(ExecutionErrorCode.EXECUTION_ERROR, errorMessage || 'Unknown error during execution'),
        chain,
        opportunity.buyDex || 'unknown'
      );
    }
  }
}
