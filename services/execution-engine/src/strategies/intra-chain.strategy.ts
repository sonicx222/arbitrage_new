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
import { COMMIT_REVEAL_CONTRACTS, DEXES, FEATURE_FLAGS, getCommitRevealContract, hasCommitRevealContract } from '@arbitrage/config';
import { getErrorMessage, MevRiskAnalyzer, type TransactionContext } from '@arbitrage/core';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type { StrategyContext, ExecutionResult, Logger } from '../types';
import { createErrorResult, createSuccessResult, ExecutionErrorCode, formatExecutionError } from '../types';
import { BaseExecutionStrategy } from './base.strategy';
import { CommitRevealService, type CommitRevealParams } from '../services/commit-reveal.service';

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
  private readonly mevRiskAnalyzer: MevRiskAnalyzer;
  private readonly commitRevealService: CommitRevealService;

  constructor(
    logger: Logger,
    mevRiskAnalyzer?: MevRiskAnalyzer,
    commitRevealService?: CommitRevealService
  ) {
    super(logger);
    this.mevRiskAnalyzer = mevRiskAnalyzer ?? new MevRiskAnalyzer();
    this.commitRevealService = commitRevealService ?? new CommitRevealService(logger, COMMIT_REVEAL_CONTRACTS);
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

      // ==========================================================================
      // Task 3.1: Check if commit-reveal pattern should be used
      // ==========================================================================
      const commitRevealCheck = this.shouldUseCommitReveal(opportunity, chain, ctx);

      if (commitRevealCheck.shouldUse) {
        this.logger.info('Using commit-reveal pattern for high-risk transaction', {
          opportunityId: opportunity.id,
          riskScore: commitRevealCheck.riskScore,
          chain,
        });
        return this.executeWithCommitReveal(opportunity, chain, ctx);
      } else if (commitRevealCheck.riskScore !== undefined) {
        this.logger.debug('Commit-reveal not used', {
          opportunityId: opportunity.id,
          reason: commitRevealCheck.reason,
          riskScore: commitRevealCheck.riskScore,
        });
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

  // ==========================================================================
  // Task 3.1: Commit-Reveal MEV Protection
  // ==========================================================================

  /**
   * Check if commit-reveal pattern should be used for this opportunity.
   *
   * Commit-reveal is used when ALL of the following conditions are met:
   * 1. FEATURE_COMMIT_REVEAL is enabled (default: true)
   * 2. Contract is deployed on the target chain
   * 3. MEV risk score >= 70 (HIGH or CRITICAL risk)
   * 4. Private mempool (Flashbots/Jito) is unavailable or not enabled
   *
   * @param opportunity - Arbitrage opportunity
   * @param chain - Target chain
   * @param ctx - Strategy context
   * @returns Object with shouldUse flag and risk assessment
   */
  private shouldUseCommitReveal(
    opportunity: ArbitrageOpportunity,
    chain: string,
    ctx: StrategyContext
  ): {
    shouldUse: boolean;
    riskScore?: number;
    reason?: string;
  } {
    // Check 1: Feature flag enabled
    if (!FEATURE_FLAGS.useCommitReveal) {
      return { shouldUse: false, reason: 'Feature disabled (FEATURE_COMMIT_REVEAL=false)' };
    }

    // Check 2: Contract deployed on chain
    if (!hasCommitRevealContract(chain)) {
      return { shouldUse: false, reason: `Contract not deployed on ${chain}` };
    }

    // Check 3: Assess MEV risk
    const txContext: TransactionContext = {
      chain,
      // Estimate trade size from profit (MEV attacks target trade size, not profit)
      // Typical arbitrage: 1% profit margin → multiply by 100 to estimate trade size
      // Example: $100 profit → ~$10,000 trade size estimate
      valueUsd: opportunity.expectedProfit
        ? opportunity.expectedProfit * 100  // Estimate trade size from profit
        : 1000, // Default to $1000 if profit unknown
      tokenSymbol: opportunity.tokenIn,
      dexProtocol: opportunity.buyDex,
      slippageBps: 50, // Default 0.5% slippage
      poolLiquidityUsd: opportunity.poolLiquidity,
      expectedProfitUsd: opportunity.expectedProfit,
    };

    const riskAssessment = this.mevRiskAnalyzer.analyzeMevRisk(txContext);

    // Risk score threshold: 70 = HIGH or CRITICAL risk
    if (riskAssessment.sandwichRiskScore < 70) {
      return {
        shouldUse: false,
        riskScore: riskAssessment.sandwichRiskScore,
        reason: `Low MEV risk (score: ${riskAssessment.sandwichRiskScore})`,
      };
    }

    // Check 4: Private mempool availability
    const eligibility = this.checkMevEligibility(chain, ctx, opportunity.expectedProfit);

    // If private mempool is available and enabled, use it instead of commit-reveal
    if (eligibility.shouldUseMev && eligibility.mevProvider) {
      return {
        shouldUse: false,
        riskScore: riskAssessment.sandwichRiskScore,
        reason: `Private mempool available (${eligibility.mevProvider.constructor.name})`,
      };
    }

    // All checks passed - use commit-reveal
    return {
      shouldUse: true,
      riskScore: riskAssessment.sandwichRiskScore,
    };
  }

  /**
   * Execute opportunity using commit-reveal pattern.
   *
   * Flow:
   * 1. Commit phase: Submit commitment hash on-chain
   * 2. Wait phase: Wait for 1 block confirmation
   * 3. Reveal phase: Reveal parameters and execute swap atomically
   *
   * @param opportunity - Arbitrage opportunity
   * @param chain - Target chain
   * @param ctx - Strategy context
   * @returns Execution result
   */
  private async executeWithCommitReveal(
    opportunity: ArbitrageOpportunity,
    chain: string,
    ctx: StrategyContext
  ): Promise<ExecutionResult> {
    const contractAddress = getCommitRevealContract(chain);
    if (!contractAddress) {
      return createErrorResult(
        opportunity.id,
        formatExecutionError(ExecutionErrorCode.EXECUTION_ERROR, 'Commit-reveal contract address not found'),
        chain,
        opportunity.buyDex || 'unknown'
      );
    }

    const routerAddress = getRouterAddress(chain, opportunity.sellDex);
    if (!routerAddress) {
      return createErrorResult(
        opportunity.id,
        formatExecutionError(ExecutionErrorCode.EXECUTION_ERROR, 'Router address not found'),
        chain,
        opportunity.buyDex || 'unknown'
      );
    }

    try {
      // Prepare commit-reveal parameters
      // Validate and convert amountIn (should be wei string from opportunity)
      if (!opportunity.amountIn || opportunity.amountIn === '0') {
        return createErrorResult(
          opportunity.id,
          formatExecutionError(ExecutionErrorCode.EXECUTION_ERROR, 'Invalid amountIn: must be non-zero'),
          chain,
          opportunity.buyDex || 'unknown'
        );
      }

      let amountIn: bigint;
      try {
        // Convert string to bigint (amountIn is in wei as string)
        amountIn = BigInt(opportunity.amountIn);
      } catch (conversionError) {
        return createErrorResult(
          opportunity.id,
          formatExecutionError(
            ExecutionErrorCode.EXECUTION_ERROR,
            `Invalid amountIn format: ${opportunity.amountIn} - ${getErrorMessage(conversionError)}`
          ),
          chain,
          opportunity.buyDex || 'unknown'
        );
      }

      const minProfit = opportunity.expectedProfit
        ? ethers.parseEther((opportunity.expectedProfit * 0.8).toFixed(18)) // 80% of expected profit (Fix #3)
        : ethers.parseEther('0.001'); // Minimum 0.001 ETH

      const params: CommitRevealParams = {
        tokenIn: opportunity.tokenIn,
        tokenOut: opportunity.tokenOut,
        amountIn,
        minProfit,
        router: routerAddress,
        deadline: Math.floor(Date.now() / 1000) + 300, // 5 minutes from now
        salt: ethers.hexlify(ethers.randomBytes(32)), // Random 32-byte salt
      };

      this.logger.info('Executing with commit-reveal pattern', {
        opportunityId: opportunity.id,
        chain,
        contract: contractAddress,
        riskScore: opportunity.mevRiskScore,
      });

      // Phase 1: Commit
      const commitResult = await this.commitRevealService.commit(
        params,
        chain,
        ctx,
        opportunity.id,
        opportunity.expectedProfit
      );

      if (!commitResult.success) {
        return createErrorResult(
          opportunity.id,
          formatExecutionError(ExecutionErrorCode.EXECUTION_ERROR, `Commit failed: ${commitResult.error}`),
          chain,
          opportunity.buyDex || 'unknown'
        );
      }

      this.logger.debug('Commitment submitted', {
        opportunityId: opportunity.id,
        commitmentHash: commitResult.commitmentHash,
        txHash: commitResult.txHash,
        targetBlock: commitResult.revealBlock,
      });

      // Phase 2: Wait for reveal block
      const provider = ctx.providers.get(chain);
      if (provider) {
        const waitResult = await this.commitRevealService.waitForRevealBlock(
          commitResult.revealBlock,
          chain,
          ctx
        );

        if (!waitResult.success) {
          // Cancel commitment for gas refund
          await this.commitRevealService.cancel(commitResult.commitmentHash, chain, ctx).catch(() => {
            // Ignore cancel errors
          });

          return createErrorResult(
            opportunity.id,
            formatExecutionError(ExecutionErrorCode.EXECUTION_ERROR, `Block wait failed: ${waitResult.error}`),
            chain,
            opportunity.buyDex || 'unknown'
          );
        }
      }

      // Phase 3: Reveal
      const revealResult = await this.commitRevealService.reveal(
        commitResult.commitmentHash,
        chain,
        ctx
      );

      if (!revealResult.success) {
        // Attempt to cancel commitment for gas refund
        await this.commitRevealService.cancel(commitResult.commitmentHash, chain, ctx).catch(() => {
          // Ignore cancel errors
        });

        return createErrorResult(
          opportunity.id,
          formatExecutionError(ExecutionErrorCode.EXECUTION_ERROR, `Reveal failed: ${revealResult.error}`),
          chain,
          opportunity.buyDex || 'unknown'
        );
      }

      this.logger.info('Commit-reveal execution completed', {
        opportunityId: opportunity.id,
        commitTxHash: commitResult.txHash,
        revealTxHash: revealResult.txHash,
        profit: revealResult.profit?.toString(),
        gasUsed: revealResult.gasUsed,
      });

      return createSuccessResult(
        opportunity.id,
        revealResult.txHash || '',
        chain,
        opportunity.buyDex || 'unknown',
        {
          actualProfit: revealResult.profit ? parseFloat(ethers.formatEther(revealResult.profit)) : undefined,
          gasUsed: revealResult.gasUsed,
          commitTxHash: commitResult.txHash,
        }
      );
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      this.logger.error('Commit-reveal execution failed', {
        opportunityId: opportunity.id,
        chain,
        error: errorMessage,
      });

      return createErrorResult(
        opportunity.id,
        formatExecutionError(ExecutionErrorCode.EXECUTION_ERROR, `Commit-reveal error: ${errorMessage}`),
        chain,
        opportunity.buyDex || 'unknown'
      );
    }
  }
}
