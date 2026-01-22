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
      return {
        opportunityId: opportunity.id,
        success: false,
        error: 'Missing source or destination chain',
        timestamp: Date.now(),
        chain: sourceChain || 'unknown',
        dex: opportunity.buyDex || 'unknown',
      };
    }

    if (sourceChain === destChain) {
      return {
        opportunityId: opportunity.id,
        success: false,
        error: 'Cross-chain arbitrage requires different chains',
        timestamp: Date.now(),
        chain: sourceChain,
        dex: opportunity.buyDex || 'unknown',
      };
    }

    // Validate bridge router is available
    if (!ctx.bridgeRouterFactory) {
      return {
        opportunityId: opportunity.id,
        success: false,
        error: 'Bridge router not initialized',
        timestamp: Date.now(),
        chain: sourceChain,
        dex: opportunity.buyDex || 'unknown',
      };
    }

    // Find suitable bridge router
    const bridgeToken = opportunity.tokenOut || 'USDC';
    const bridgeRouter = ctx.bridgeRouterFactory.findBestRouter(sourceChain, destChain, bridgeToken);

    if (!bridgeRouter) {
      return {
        opportunityId: opportunity.id,
        success: false,
        error: `No bridge route available: ${sourceChain} -> ${destChain} for ${bridgeToken}`,
        timestamp: Date.now(),
        chain: sourceChain,
        dex: opportunity.buyDex || 'unknown',
      };
    }

    this.logger.info('Starting cross-chain arbitrage execution', {
      opportunityId: opportunity.id,
      sourceChain,
      destChain,
      bridgeToken,
      bridgeProtocol: bridgeRouter.protocol,
    });

    try {
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
        return {
          opportunityId: opportunity.id,
          success: false,
          error: `Bridge quote failed: ${bridgeQuote.error}`,
          timestamp: Date.now(),
          chain: sourceChain,
          dex: opportunity.buyDex || 'unknown',
        };
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

        return {
          opportunityId: opportunity.id,
          success: false,
          error: `Bridge fees ($${bridgeFeeUsd.toFixed(2)}) exceed 50% of expected profit ($${expectedProfit.toFixed(2)})`,
          timestamp: Date.now(),
          chain: sourceChain,
          dex: opportunity.buyDex || 'unknown',
        };
      }

      // Step 2: Get wallet and provider for source chain
      const sourceWallet = ctx.wallets.get(sourceChain);
      const sourceProvider = ctx.providers.get(sourceChain);

      if (!sourceWallet || !sourceProvider) {
        return {
          opportunityId: opportunity.id,
          success: false,
          error: `No wallet/provider for source chain: ${sourceChain}`,
          timestamp: Date.now(),
          chain: sourceChain,
          dex: opportunity.buyDex || 'unknown',
        };
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

        return {
          opportunityId: opportunity.id,
          success: false,
          error: 'Bridge quote expired before execution',
          timestamp: Date.now(),
          chain: sourceChain,
          dex: opportunity.buyDex || 'unknown',
        };
      }

      // ==========================================================================
      // Phase 1.1: Pre-flight Simulation for Destination Sell Transaction
      // ==========================================================================
      // Note: Bridge transaction simulation is skipped because the bridge router
      // internally builds the transaction during execute(). We simulate the
      // destination sell transaction instead to catch potential issues early.
      const destWalletForSim = ctx.wallets.get(destChain);
      if (destWalletForSim && ctx.providers.get(destChain)) {
        // Prepare sell transaction for simulation
        try {
          const sellSimTx = await this.prepareFlashLoanTransaction(opportunity, destChain, ctx);
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

            return {
              opportunityId: opportunity.id,
              success: false,
              error: `Aborted: destination sell simulation predicted revert - ${simulationResult.revertReason || 'unknown reason'}`,
              timestamp: Date.now(),
              chain: sourceChain,
              dex: opportunity.buyDex || 'unknown',
            };
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

        return {
          opportunityId: opportunity.id,
          success: false,
          error: `Bridge execution failed: ${bridgeResult.error}`,
          timestamp: Date.now(),
          chain: sourceChain,
          dex: opportunity.buyDex || 'unknown',
        };
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
          return {
            opportunityId: opportunity.id,
            success: false,
            error: 'Execution interrupted by shutdown',
            transactionHash: bridgeResult.sourceTxHash,
            timestamp: Date.now(),
            chain: sourceChain,
            dex: opportunity.buyDex || 'unknown',
          };
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
          return {
            opportunityId: opportunity.id,
            success: false,
            error: `Bridge failed: ${bridgeStatus.error || bridgeStatus.status}`,
            transactionHash: bridgeResult.sourceTxHash,
            timestamp: Date.now(),
            chain: sourceChain,
            dex: opportunity.buyDex || 'unknown',
          };
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }

      if (!bridgeCompleted) {
        // Confirm nonce since source tx was submitted
        if (ctx.nonceManager && bridgeNonce !== undefined) {
          ctx.nonceManager.confirmTransaction(
            sourceChain,
            bridgeNonce,
            bridgeResult.sourceTxHash || 'bridge-timeout'
          );
        }

        this.logger.warn('Bridge timeout - funds may still be in transit', {
          opportunityId: opportunity.id,
          bridgeId,
          elapsedMs: Date.now() - bridgeStartTime,
        });

        return {
          opportunityId: opportunity.id,
          success: false,
          error: 'Bridge timeout - transaction may still complete',
          transactionHash: bridgeResult.sourceTxHash,
          timestamp: Date.now(),
          chain: sourceChain,
          dex: opportunity.buyDex || 'unknown',
        };
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

        return {
          opportunityId: opportunity.id,
          success: false,
          error: `No wallet/provider for destination chain: ${destChain}. Funds bridged but sell not executed.`,
          transactionHash: bridgeResult.sourceTxHash,
          timestamp: Date.now(),
          chain: destChain,
          dex: opportunity.sellDex || 'unknown',
        };
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

      // Prepare and execute sell transaction on destination chain
      // TODO: Full implementation requires DEX router integration
      // For now, we prepare a flash loan style transaction that executes the sell
      const sellTx = await this.prepareFlashLoanTransaction(opportunity, destChain, ctx);

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

        return {
          opportunityId: opportunity.id,
          success: false,
          error: `Bridge succeeded but sell failed: ${getErrorMessage(sellError)}`,
          transactionHash: bridgeResult.sourceTxHash,
          timestamp: Date.now(),
          chain: destChain,
          dex: opportunity.sellDex || 'unknown',
        };
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

      return {
        opportunityId: opportunity.id,
        success: false,
        error: `Cross-chain execution error: ${getErrorMessage(error)}`,
        timestamp: Date.now(),
        chain: sourceChain,
        dex: opportunity.buyDex || 'unknown',
      };
    }
  }
}
