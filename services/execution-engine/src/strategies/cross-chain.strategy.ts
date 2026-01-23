/**
 * Cross-Chain Execution Strategy
 *
 * Executes arbitrage opportunities across chains using:
 * - Bridge router (Stargate/LayerZero)
 * - Multi-step execution with timeout handling
 * - Partial execution recovery
 *
 * Execution flow:
 * 1. Execute buy side on source chain
 * 2. Bridge tokens to destination chain
 * 3. Wait for bridge completion
 * 4. Execute sell side on destination chain
 *
 * @see engine.ts (parent service)
 */

import { ethers } from 'ethers';
import { ARBITRAGE_CONFIG } from '@arbitrage/config';
import { getErrorMessage, BRIDGE_DEFAULTS, getDefaultPrice } from '@arbitrage/core';
import type { BridgeStatusResult } from '@arbitrage/core';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type { StrategyContext, ExecutionResult, Logger } from '../types';
import { createErrorResult } from '../types';
import { BaseExecutionStrategy } from './base.strategy';

export class CrossChainStrategy extends BaseExecutionStrategy {
  constructor(logger: Logger) {
    super(logger);
  }

  async execute(
    opportunity: ArbitrageOpportunity,
    ctx: StrategyContext
  ): Promise<ExecutionResult> {
    const sourceChain = opportunity.buyChain;
    const destChain = opportunity.sellChain;
    const startTime = Date.now();

    // Validate chains
    if (!sourceChain || !destChain) {
      return createErrorResult(
        opportunity.id,
        'Missing source or destination chain',
        sourceChain || 'unknown',
        opportunity.buyDex || 'unknown'
      );
    }

    if (sourceChain === destChain) {
      return createErrorResult(
        opportunity.id,
        'Cross-chain arbitrage requires different chains',
        sourceChain,
        opportunity.buyDex || 'unknown'
      );
    }

    // Validate bridge router is available
    if (!ctx.bridgeRouterFactory) {
      return createErrorResult(
        opportunity.id,
        'Bridge router not initialized',
        sourceChain,
        opportunity.buyDex || 'unknown'
      );
    }

    // Find suitable bridge router
    const bridgeToken = opportunity.tokenOut || 'USDC';
    const bridgeRouter = ctx.bridgeRouterFactory.findBestRouter(sourceChain, destChain, bridgeToken);

    if (!bridgeRouter) {
      return createErrorResult(
        opportunity.id,
        `No bridge route available: ${sourceChain} -> ${destChain} for ${bridgeToken}`,
        sourceChain,
        opportunity.buyDex || 'unknown'
      );
    }

    this.logger.info('Starting cross-chain arbitrage execution', {
      opportunityId: opportunity.id,
      sourceChain,
      destChain,
      bridgeToken,
      bridgeProtocol: bridgeRouter.protocol,
    });

    try {
      // Step 0: Check for gas spike on source chain BEFORE getting bridge quote
      // This avoids wasting bridge API calls if gas is too expensive
      try {
        await this.getOptimalGasPrice(sourceChain, ctx);
      } catch (gasSpikeError) {
        // Gas spike detected - abort early
        const errorMessage = getErrorMessage(gasSpikeError);
        if (errorMessage?.includes('Gas price spike')) {
          this.logger.warn('Cross-chain execution aborted due to gas spike', {
            opportunityId: opportunity.id,
            sourceChain,
            error: errorMessage,
          });
          return createErrorResult(
            opportunity.id,
            `Gas spike on ${sourceChain}: ${errorMessage}`,
            sourceChain,
            opportunity.buyDex || 'unknown'
          );
        }
        // Non-spike error - log and continue (fallback gas price will be used)
        this.logger.debug('Gas price check failed, will use fallback', {
          error: errorMessage,
        });
      }

      // Step 1: Get bridge quote
      const bridgeAmount = opportunity.amountIn || '0';
      const bridgeQuote = await bridgeRouter.quote({
        sourceChain,
        destChain,
        token: bridgeToken,
        amount: bridgeAmount,
        slippage: ARBITRAGE_CONFIG.slippageTolerance,
      });

      if (!bridgeQuote.valid) {
        return createErrorResult(
          opportunity.id,
          `Bridge quote failed: ${bridgeQuote.error}`,
          sourceChain,
          opportunity.buyDex || 'unknown'
        );
      }

      // Validate profit still viable after bridge fees
      // Convert bridge fee from ETH to USD for consistent comparison
      // (expectedProfit is in USD, bridgeQuote.totalFee is in wei)
      const bridgeFeeEth = parseFloat(ethers.formatEther(bridgeQuote.totalFee));
      const ethPriceUsd = getDefaultPrice('ETH');
      const bridgeFeeUsd = bridgeFeeEth * ethPriceUsd;
      const expectedProfit = opportunity.expectedProfit || 0;

      if (bridgeFeeUsd >= expectedProfit * 0.5) {
        this.logger.warn('Cross-chain profit too low after bridge fees', {
          opportunityId: opportunity.id,
          bridgeFeeEth,
          bridgeFeeUsd,
          ethPriceUsd,
          expectedProfit,
        });

        return createErrorResult(
          opportunity.id,
          `Bridge fees ($${bridgeFeeUsd.toFixed(2)}) exceed 50% of expected profit ($${expectedProfit.toFixed(2)})`,
          sourceChain,
          opportunity.buyDex || 'unknown'
        );
      }

      // Step 2: Get wallet and provider for source chain
      const sourceWallet = ctx.wallets.get(sourceChain);
      const sourceProvider = ctx.providers.get(sourceChain);

      if (!sourceWallet || !sourceProvider) {
        return createErrorResult(
          opportunity.id,
          `No wallet/provider for source chain: ${sourceChain}`,
          sourceChain,
          opportunity.buyDex || 'unknown'
        );
      }

      // Get nonce for bridge transaction
      let bridgeNonce: number | undefined;
      if (ctx.nonceManager) {
        try {
          bridgeNonce = await ctx.nonceManager.getNextNonce(sourceChain);
        } catch (error) {
          this.logger.error('Failed to get nonce for bridge', {
            error: getErrorMessage(error),
          });
        }
      }

      // Validate quote expiry before execution
      if (Date.now() > bridgeQuote.expiresAt) {
        if (ctx.nonceManager && bridgeNonce !== undefined) {
          ctx.nonceManager.failTransaction(sourceChain, bridgeNonce, 'Quote expired');
        }

        return createErrorResult(
          opportunity.id,
          'Bridge quote expired before execution',
          sourceChain,
          opportunity.buyDex || 'unknown'
        );
      }

      // ==========================================================================
      // Phase 1.1: Pre-flight Simulation for Destination Sell Transaction
      // ==========================================================================
      // Note: Bridge transaction simulation is skipped because the bridge router
      // internally builds the transaction during execute(). We simulate the
      // destination sell transaction instead to catch potential issues early.
      const destWalletForSim = ctx.wallets.get(destChain);
      if (destWalletForSim && ctx.providers.get(destChain)) {
        // Prepare sell transaction for simulation (using proper DEX swap, not flash loan)
        try {
          const sellSimTx = await this.prepareDexSwapTransaction(opportunity, destChain, ctx);
          sellSimTx.from = await destWalletForSim.getAddress();

          const simulationResult = await this.performSimulation(opportunity, sellSimTx, destChain, ctx);

          if (simulationResult?.wouldRevert) {
            ctx.stats.simulationPredictedReverts++;

            if (ctx.nonceManager && bridgeNonce !== undefined) {
              ctx.nonceManager.failTransaction(sourceChain, bridgeNonce, 'Simulation predicted revert on destination');
            }

            this.logger.warn('Aborting cross-chain execution: destination sell simulation predicted revert', {
              opportunityId: opportunity.id,
              revertReason: simulationResult.revertReason,
              simulationLatencyMs: simulationResult.latencyMs,
              provider: simulationResult.provider,
              destChain,
            });

            return createErrorResult(
              opportunity.id,
              `Aborted: destination sell simulation predicted revert - ${simulationResult.revertReason || 'unknown reason'}`,
              sourceChain,
              opportunity.buyDex || 'unknown'
            );
          }
        } catch (simError) {
          // Log but continue - simulation preparation failure shouldn't block execution
          this.logger.debug('Could not prepare destination sell for simulation, proceeding', {
            opportunityId: opportunity.id,
            error: getErrorMessage(simError),
          });
        }
      }

      // Step 3: Execute bridge
      const bridgeResult = await this.withTransactionTimeout(
        () => bridgeRouter.execute({
          quote: bridgeQuote,
          wallet: sourceWallet,
          provider: sourceProvider,
          nonce: bridgeNonce,
          deadline: Date.now() + BRIDGE_DEFAULTS.quoteValidityMs,
        }),
        'bridgeExecution'
      );

      if (!bridgeResult.success) {
        if (ctx.nonceManager && bridgeNonce !== undefined) {
          ctx.nonceManager.failTransaction(sourceChain, bridgeNonce, bridgeResult.error || 'Bridge failed');
        }

        return createErrorResult(
          opportunity.id,
          `Bridge execution failed: ${bridgeResult.error}`,
          sourceChain,
          opportunity.buyDex || 'unknown'
        );
      }

      // Confirm nonce usage
      if (ctx.nonceManager && bridgeNonce !== undefined) {
        ctx.nonceManager.confirmTransaction(sourceChain, bridgeNonce, bridgeResult.sourceTxHash || '');
      }

      this.logger.info('Bridge transaction submitted', {
        opportunityId: opportunity.id,
        bridgeId: bridgeResult.bridgeId,
        sourceTxHash: bridgeResult.sourceTxHash,
      });

      // Step 4: Wait for bridge completion
      const bridgeId = bridgeResult.bridgeId!;
      const maxWaitTime = BRIDGE_DEFAULTS.maxBridgeWaitMs;
      const pollInterval = BRIDGE_DEFAULTS.statusPollIntervalMs;
      const bridgeStartTime = Date.now();

      let bridgeCompleted = false;

      while (Date.now() - bridgeStartTime < maxWaitTime) {
        // Check for shutdown
        if (!ctx.stateManager.isRunning()) {
          this.logger.warn('Bridge polling interrupted by shutdown', {
            opportunityId: opportunity.id,
            bridgeId,
          });
          return createErrorResult(
            opportunity.id,
            'Execution interrupted by shutdown',
            sourceChain,
            opportunity.buyDex || 'unknown',
            bridgeResult.sourceTxHash
          );
        }

        const bridgeStatus: BridgeStatusResult = await bridgeRouter.getStatus(bridgeId);

        if (bridgeStatus.status === 'completed') {
          bridgeCompleted = true;
          this.logger.info('Bridge completed', {
            opportunityId: opportunity.id,
            bridgeId,
            destTxHash: bridgeStatus.destTxHash,
            amountReceived: bridgeStatus.amountReceived,
          });
          break;
        }

        if (bridgeStatus.status === 'failed' || bridgeStatus.status === 'refunded') {
          return createErrorResult(
            opportunity.id,
            `Bridge failed: ${bridgeStatus.error || bridgeStatus.status}`,
            sourceChain,
            opportunity.buyDex || 'unknown',
            bridgeResult.sourceTxHash
          );
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }

      if (!bridgeCompleted) {
        // NOTE: Nonce was already confirmed at line 265-267 after bridge execution succeeded.
        // We don't need to confirm again here - the source chain transaction was submitted
        // successfully, we're just waiting for the destination chain to receive it.

        this.logger.warn('Bridge timeout - funds may still be in transit', {
          opportunityId: opportunity.id,
          bridgeId,
          elapsedMs: Date.now() - bridgeStartTime,
        });

        return createErrorResult(
          opportunity.id,
          'Bridge timeout - transaction may still complete',
          sourceChain,
          opportunity.buyDex || 'unknown',
          bridgeResult.sourceTxHash
        );
      }

      // Step 5: Execute sell on destination chain
      const destWallet = ctx.wallets.get(destChain);
      const destProvider = ctx.providers.get(destChain);

      if (!destWallet || !destProvider) {
        // Bridge succeeded but can't execute sell - funds are on dest chain
        this.logger.error('Cannot execute sell - no wallet/provider for destination chain', {
          opportunityId: opportunity.id,
          destChain,
          bridgeTxHash: bridgeResult.sourceTxHash,
        });

        return createErrorResult(
          opportunity.id,
          `No wallet/provider for destination chain: ${destChain}. Funds bridged but sell not executed.`,
          destChain,
          opportunity.sellDex || 'unknown',
          bridgeResult.sourceTxHash
        );
      }

      // Get nonce for sell transaction on destination chain
      let sellNonce: number | undefined;
      if (ctx.nonceManager) {
        try {
          sellNonce = await ctx.nonceManager.getNextNonce(destChain);
        } catch (error) {
          this.logger.error('Failed to get nonce for destination sell', {
            error: getErrorMessage(error),
          });
        }
      }

      // Prepare and execute sell transaction on destination chain using DEX router
      const sellTx = await this.prepareDexSwapTransaction(opportunity, destChain, ctx);

      // Ensure token approval for DEX router before swap
      // This is critical for cross-chain swaps where tokens were just bridged
      if (opportunity.tokenIn && sellTx.to) {
        try {
          const amountIn = BigInt(opportunity.amountIn || '0');
          const approvalNeeded = await this.ensureTokenAllowance(
            opportunity.tokenIn,
            sellTx.to as string,
            amountIn,
            destChain,
            ctx
          );
          if (approvalNeeded) {
            this.logger.info('Token approval granted for destination sell', {
              opportunityId: opportunity.id,
              token: opportunity.tokenIn,
              router: sellTx.to,
              destChain,
            });
          }
        } catch (approvalError) {
          this.logger.warn('Token approval failed, proceeding with sell attempt', {
            opportunityId: opportunity.id,
            error: getErrorMessage(approvalError),
          });
          // Continue anyway - approval might already exist or swap might still work
        }
      }

      // Apply gas settings for destination chain
      const destGasPrice = await this.getOptimalGasPrice(destChain, ctx);
      sellTx.gasPrice = destGasPrice;
      if (sellNonce !== undefined) {
        sellTx.nonce = sellNonce;
      }

      let sellReceipt: ethers.TransactionReceipt | null = null;
      let sellTxHash: string | undefined;

      try {
        const sellTxResponse = await this.withTransactionTimeout(
          () => destWallet.sendTransaction(sellTx),
          'destinationSell'
        );

        sellTxHash = sellTxResponse.hash;

        sellReceipt = await this.withTransactionTimeout(
          () => sellTxResponse.wait(),
          'waitForSellReceipt'
        );

        // Confirm sell nonce
        if (ctx.nonceManager && sellNonce !== undefined) {
          ctx.nonceManager.confirmTransaction(destChain, sellNonce, sellTxHash);
        }

        this.logger.info('Destination sell executed', {
          opportunityId: opportunity.id,
          destChain,
          sellTxHash,
          gasUsed: sellReceipt?.gasUsed?.toString(),
        });
      } catch (sellError) {
        // Sell failed - bridge succeeded but profit not captured
        if (ctx.nonceManager && sellNonce !== undefined) {
          ctx.nonceManager.failTransaction(destChain, sellNonce, getErrorMessage(sellError));
        }

        this.logger.error('Destination sell failed', {
          opportunityId: opportunity.id,
          destChain,
          bridgeTxHash: bridgeResult.sourceTxHash,
          error: getErrorMessage(sellError),
        });

        return createErrorResult(
          opportunity.id,
          `Bridge succeeded but sell failed: ${getErrorMessage(sellError)}`,
          destChain,
          opportunity.sellDex || 'unknown',
          bridgeResult.sourceTxHash
        );
      }

      // Step 6: Calculate final results
      const executionTimeMs = Date.now() - startTime;

      // Get source chain gas price for bridge cost calculation
      const sourceGasPrice = await this.getOptimalGasPrice(sourceChain, ctx);

      // Calculate total gas costs in ETH (bridge + sell)
      const bridgeGasCostEth = bridgeResult.gasUsed
        ? parseFloat(ethers.formatEther(bridgeResult.gasUsed * sourceGasPrice))
        : 0;
      const sellGasCostEth = sellReceipt
        ? parseFloat(ethers.formatEther(sellReceipt.gasUsed * (sellReceipt.gasPrice || destGasPrice)))
        : 0;
      const totalGasCostEth = bridgeGasCostEth + sellGasCostEth;

      // Convert all costs to USD for consistent profit calculation
      // (expectedProfit is already in USD)
      const totalGasCostUsd = totalGasCostEth * ethPriceUsd;

      // Calculate actual profit in USD (expected - bridge fees - gas costs)
      const actualProfit = expectedProfit - bridgeFeeUsd - totalGasCostUsd;

      this.logger.info('Cross-chain arbitrage completed', {
        opportunityId: opportunity.id,
        executionTimeMs,
        bridgeFeeEth,
        bridgeFeeUsd,
        bridgeGasCostEth,
        sellGasCostEth,
        totalGasCostUsd,
        expectedProfit,
        actualProfit,
        ethPriceUsd,
      });

      return {
        opportunityId: opportunity.id,
        success: true,
        transactionHash: sellTxHash || bridgeResult.sourceTxHash,
        actualProfit,
        gasUsed: sellReceipt ? Number(sellReceipt.gasUsed) : (bridgeResult.gasUsed ? Number(bridgeResult.gasUsed) : undefined),
        gasCost: totalGasCostUsd, // Gas cost in USD for consistency with actualProfit
        timestamp: Date.now(),
        chain: destChain, // Report final chain where sell occurred
        dex: opportunity.sellDex || 'unknown',
      };

    } catch (error) {
      this.logger.error('Cross-chain arbitrage execution failed', {
        opportunityId: opportunity.id,
        sourceChain,
        destChain,
        error: getErrorMessage(error),
      });

      return createErrorResult(
        opportunity.id,
        `Cross-chain execution error: ${getErrorMessage(error)}`,
        sourceChain,
        opportunity.buyDex || 'unknown'
      );
    }
  }
}
