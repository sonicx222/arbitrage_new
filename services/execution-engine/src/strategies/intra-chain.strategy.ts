/**
 * Intra-Chain Execution Strategy
 *
 * Executes arbitrage opportunities within a single chain using:
 * - Pre-flight simulation to detect reverts (Phase 1.1)
 * - Flash loans from Aave/Uniswap
 * - MEV protection via Flashbots (on supported chains)
 * - Atomic nonce management
 *
 * @see engine.ts (parent service)
 */

import { ethers } from 'ethers';
import { MEV_CONFIG } from '@arbitrage/config';
import { getErrorMessage } from '@arbitrage/core';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type { StrategyContext, ExecutionResult, Logger } from '../types';
import { createErrorResult } from '../types';
import { BaseExecutionStrategy } from './base.strategy';

export class IntraChainStrategy extends BaseExecutionStrategy {
  constructor(logger: Logger) {
    super(logger);
  }

  async execute(
    opportunity: ArbitrageOpportunity,
    ctx: StrategyContext
  ): Promise<ExecutionResult> {
    const chain = opportunity.buyChain;
    if (!chain) {
      throw new Error('No chain specified for opportunity');
    }

    // Verify wallet exists early and store reference (avoids repeated lookups)
    const wallet = ctx.wallets.get(chain);
    if (!wallet) {
      throw new Error(`No wallet available for chain: ${chain}`);
    }

    // Store provider reference for later use (MEV receipt fetch)
    const provider = ctx.providers.get(chain);

    // Get optimal gas price
    const gasPrice = await this.getOptimalGasPrice(chain, ctx);

    // Re-verify prices before execution
    const priceVerification = await this.verifyOpportunityPrices(opportunity, chain);
    if (!priceVerification.valid) {
      this.logger.warn('Price re-verification failed, aborting execution', {
        opportunityId: opportunity.id,
        reason: priceVerification.reason,
        originalProfit: opportunity.expectedProfit,
        currentProfit: priceVerification.currentProfit
      });

      return createErrorResult(
        opportunity.id,
        `Price verification failed: ${priceVerification.reason}`,
        chain,
        opportunity.buyDex || 'unknown'
      );
    }

    // Prepare flash loan transaction
    const flashLoanTx = await this.prepareFlashLoanTransaction(opportunity, chain, ctx);

    // ==========================================================================
    // Phase 1.1: Pre-flight Simulation
    // ==========================================================================
    const simulationResult = await this.performSimulation(opportunity, flashLoanTx, chain, ctx);

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
        `Aborted: simulation predicted revert - ${simulationResult.revertReason || 'unknown reason'}`,
        chain,
        opportunity.buyDex || 'unknown'
      );
    }

    // Apply MEV protection
    const protectedTx = await this.applyMEVProtection(flashLoanTx, chain, ctx);

    // Get nonce from NonceManager for atomic allocation
    let nonce: number | undefined;
    if (ctx.nonceManager) {
      try {
        nonce = await ctx.nonceManager.getNextNonce(chain);
        protectedTx.nonce = nonce;
        this.logger.debug('Nonce allocated from NonceManager', { chain, nonce });
      } catch (error) {
        this.logger.error('Failed to get nonce from NonceManager', {
          chain,
          error: getErrorMessage(error)
        });
        throw error;
      }
    }

    try {
      // Check if MEV protection should be used
      const mevProvider = ctx.mevProviderFactory?.getProvider(chain);
      const chainSettings = MEV_CONFIG.chainSettings[chain];
      const shouldUseMevProtection = mevProvider?.isEnabled() &&
        chainSettings?.enabled !== false &&
        (opportunity.expectedProfit || 0) >= (chainSettings?.minProfitForProtection || 0);

      let receipt: ethers.TransactionReceipt | null = null;
      let txHash: string | undefined;

      if (shouldUseMevProtection && mevProvider) {
        // Use MEV provider for protected transaction submission
        this.logger.info('Using MEV protected submission', {
          chain,
          strategy: mevProvider.strategy,
          opportunityId: opportunity.id,
        });

        const mevResult = await this.withTransactionTimeout(
          () => mevProvider.sendProtectedTransaction(protectedTx, {
            simulate: MEV_CONFIG.simulateBeforeSubmit,
            priorityFeeGwei: chainSettings?.priorityFeeGwei,
          }),
          'mevProtectedSubmission'
        );

        if (!mevResult.success) {
          throw new Error(`MEV protected submission failed: ${mevResult.error}`);
        }

        txHash = mevResult.transactionHash;

        // Get receipt if we have a transaction hash
        if (txHash && provider) {
          receipt = await this.withTransactionTimeout(
            () => provider.getTransactionReceipt(txHash!),
            'getReceipt'
          );
        }

        this.logger.info('MEV protected transaction successful', {
          chain,
          strategy: mevResult.strategy,
          txHash,
          usedFallback: mevResult.usedFallback,
          latencyMs: mevResult.latencyMs,
        });
      } else {
        // Standard transaction submission (no MEV protection)
        // Note: wallet was already verified and stored at function entry
        const txResponse = await this.withTransactionTimeout(
          () => wallet.sendTransaction(protectedTx),
          'sendTransaction'
        );

        txHash = txResponse.hash;

        receipt = await this.withTransactionTimeout(
          () => txResponse.wait(),
          'waitForReceipt'
        );
      }

      if (!receipt) {
        if (ctx.nonceManager && nonce !== undefined) {
          ctx.nonceManager.failTransaction(chain, nonce, 'No receipt received');
        }
        throw new Error('Transaction receipt not received');
      }

      // Confirm transaction with NonceManager
      if (ctx.nonceManager && nonce !== undefined) {
        ctx.nonceManager.confirmTransaction(chain, nonce, receipt.hash);
      }

      // Calculate actual profit
      const actualProfit = await this.calculateActualProfit(receipt, opportunity);

      return {
        opportunityId: opportunity.id,
        success: true,
        transactionHash: receipt.hash,
        actualProfit,
        gasUsed: Number(receipt.gasUsed),
        gasCost: parseFloat(ethers.formatEther(receipt.gasUsed * (receipt.gasPrice || gasPrice))),
        timestamp: Date.now(),
        chain,
        dex: opportunity.buyDex || 'unknown'
      };
    } catch (error) {
      // Mark transaction as failed in NonceManager
      if (ctx.nonceManager && nonce !== undefined) {
        ctx.nonceManager.failTransaction(chain, nonce, getErrorMessage(error));
      }
      throw error;
    }
  }
}
