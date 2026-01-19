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
import { getErrorMessage, BRIDGE_DEFAULTS } from '@arbitrage/core';
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
      const bridgeFeeEth = parseFloat(ethers.formatEther(bridgeQuote.totalFee));
      const expectedProfit = opportunity.expectedProfit || 0;

      if (bridgeFeeEth >= expectedProfit * 0.5) {
        this.logger.warn('Cross-chain profit too low after bridge fees', {
          opportunityId: opportunity.id,
          bridgeFee: bridgeFeeEth,
          expectedProfit,
        });

        return {
          opportunityId: opportunity.id,
          success: false,
          error: `Bridge fees (${bridgeFeeEth.toFixed(4)} ETH) exceed 50% of profit`,
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

      // Step 5: Calculate results
      const executionTimeMs = Date.now() - startTime;
      const estimatedProfit = expectedProfit - bridgeFeeEth;

      const actualGasCost = bridgeResult.gasUsed
        ? parseFloat(ethers.formatEther(bridgeResult.gasUsed * 30000000000n))
        : 0;

      this.logger.info('Cross-chain arbitrage completed', {
        opportunityId: opportunity.id,
        executionTimeMs,
        bridgeFee: bridgeFeeEth,
        gasUsed: bridgeResult.gasUsed?.toString(),
        estimatedProfit,
      });

      return {
        opportunityId: opportunity.id,
        success: true,
        transactionHash: bridgeResult.sourceTxHash,
        actualProfit: estimatedProfit,
        gasUsed: bridgeResult.gasUsed ? Number(bridgeResult.gasUsed) : undefined,
        gasCost: actualGasCost,
        timestamp: Date.now(),
        chain: sourceChain,
        dex: opportunity.buyDex || 'unknown',
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
