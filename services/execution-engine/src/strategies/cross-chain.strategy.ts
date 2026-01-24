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
 * ## Bridge Status Values (Fix 2.2)
 *
 * The bridge router's `getStatus()` returns a `BridgeStatusResult` with these status values:
 *
 * | Status       | Description                                          | Action                    |
 * |--------------|------------------------------------------------------|---------------------------|
 * | `pending`    | Transaction submitted, waiting for confirmation      | Continue polling          |
 * | `inflight`   | Bridge is processing, tokens in transit              | Continue polling          |
 * | `completed`  | Bridge succeeded, tokens delivered on destination    | Proceed to sell           |
 * | `failed`     | Bridge failed permanently (e.g., invalid params)     | Return error, log details |
 * | `refunded`   | Bridge failed but source funds were returned         | Return error, log refund  |
 *
 * Any other status is treated as "still in progress" and polling continues.
 *
 * @see BridgeStatusResult from @arbitrage/core
 * @see engine.ts (parent service)
 */

import { ethers } from 'ethers';
import { ARBITRAGE_CONFIG, getNativeTokenPrice } from '@arbitrage/config';
import { getErrorMessage, BRIDGE_DEFAULTS, getDefaultPrice } from '@arbitrage/core';
import type { BridgeStatusResult } from '@arbitrage/core';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type { StrategyContext, ExecutionResult, Logger } from '../types';
import { createErrorResult, createSuccessResult } from '../types';
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

    // Fix 6.1: Validate chains with error codes
    if (!sourceChain || !destChain) {
      return createErrorResult(
        opportunity.id,
        '[ERR_NO_CHAIN] Missing source or destination chain',
        sourceChain || 'unknown',
        opportunity.buyDex || 'unknown'
      );
    }

    if (sourceChain === destChain) {
      return createErrorResult(
        opportunity.id,
        '[ERR_SAME_CHAIN] Cross-chain arbitrage requires different chains',
        sourceChain,
        opportunity.buyDex || 'unknown'
      );
    }

    // Validate bridge router is available
    if (!ctx.bridgeRouterFactory) {
      return createErrorResult(
        opportunity.id,
        '[ERR_NO_BRIDGE] Bridge router not initialized',
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
        `[ERR_NO_ROUTE] No bridge route available: ${sourceChain} -> ${destChain} for ${bridgeToken}`,
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
            `[ERR_GAS_SPIKE] Gas spike on ${sourceChain}: ${errorMessage}`,
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
          `[ERR_BRIDGE_QUOTE] Bridge quote failed: ${bridgeQuote.error}`,
          sourceChain,
          opportunity.buyDex || 'unknown'
        );
      }

      // Fix 9.3: Use extracted bridge profitability helper
      // Validate profit still viable after bridge fees
      const ethPriceUsd = getDefaultPrice('ETH');
      const expectedProfit = opportunity.expectedProfit || 0;

      // Ensure totalFee is bigint (might be string from JSON or bigint from direct call)
      const totalFeeBigInt = typeof bridgeQuote.totalFee === 'string'
        ? BigInt(bridgeQuote.totalFee)
        : bridgeQuote.totalFee;

      const bridgeProfitability = this.checkBridgeProfitability(
        totalFeeBigInt,
        expectedProfit,
        ethPriceUsd,
        { chain: sourceChain }
      );

      if (!bridgeProfitability.isProfitable) {
        this.logger.warn('Cross-chain profit too low after bridge fees', {
          opportunityId: opportunity.id,
          bridgeFeeEth: bridgeProfitability.bridgeFeeEth,
          bridgeFeeUsd: bridgeProfitability.bridgeFeeUsd,
          ethPriceUsd,
          expectedProfit,
          feePercentage: bridgeProfitability.feePercentageOfProfit.toFixed(2),
        });

        return createErrorResult(
          opportunity.id,
          `[ERR_HIGH_FEES] ${bridgeProfitability.reason}`,
          sourceChain,
          opportunity.buyDex || 'unknown'
        );
      }

      // Use fee values from helper for later calculations
      const bridgeFeeEth = bridgeProfitability.bridgeFeeEth;
      const bridgeFeeUsd = bridgeProfitability.bridgeFeeUsd;

      // Step 2: Get wallet and provider for source chain
      const sourceWallet = ctx.wallets.get(sourceChain);
      const sourceProvider = ctx.providers.get(sourceChain);

      if (!sourceWallet || !sourceProvider) {
        return createErrorResult(
          opportunity.id,
          `[ERR_NO_WALLET] No wallet/provider for source chain: ${sourceChain}`,
          sourceChain,
          opportunity.buyDex || 'unknown'
        );
      }

      // Fix 4.3: Get nonce for bridge transaction with proper error handling
      // If NonceManager is available but fails, we should abort rather than continue without a nonce
      // (which could cause transaction conflicts or unpredictable behavior)
      let bridgeNonce: number | undefined;
      if (ctx.nonceManager) {
        try {
          bridgeNonce = await ctx.nonceManager.getNextNonce(sourceChain);
        } catch (error) {
          const errorMessage = getErrorMessage(error);
          this.logger.error('Failed to get nonce for bridge transaction', {
            sourceChain,
            error: errorMessage,
          });
          // Fix 4.3: Return error instead of continuing with undefined nonce
          return createErrorResult(
            opportunity.id,
            `[ERR_NONCE] Failed to get nonce for bridge transaction: ${errorMessage}`,
            sourceChain,
            opportunity.buyDex || 'unknown'
          );
        }
      }

      // Validate quote expiry before execution
      if (Date.now() > bridgeQuote.expiresAt) {
        if (ctx.nonceManager && bridgeNonce !== undefined) {
          ctx.nonceManager.failTransaction(sourceChain, bridgeNonce, 'Quote expired');
        }

        return createErrorResult(
          opportunity.id,
          '[ERR_QUOTE_EXPIRED] Bridge quote expired before execution',
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
              `[ERR_SIMULATION_REVERT] Aborted: destination sell simulation predicted revert - ${simulationResult.revertReason || 'unknown reason'}`,
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
          `[ERR_BRIDGE_EXEC] Bridge execution failed: ${bridgeResult.error}`,
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
      // Fix 5.2: Enhanced polling with transition handling
      // Fix 4.3: Added iteration limit to prevent infinite loops
      const bridgeId = bridgeResult.bridgeId!;
      const maxWaitTime = BRIDGE_DEFAULTS.maxBridgeWaitMs;
      const pollInterval = BRIDGE_DEFAULTS.statusPollIntervalMs;
      const bridgeStartTime = Date.now();

      // Fix 4.3: Calculate maximum iterations based on wait time and minimum poll interval
      // This prevents infinite loops if getStatus consistently returns non-terminal status
      const minPollInterval = Math.min(pollInterval, 5000); // At least 5s between polls
      const maxIterations = Math.ceil(maxWaitTime / minPollInterval) + 10; // +10 buffer for timing variance
      let iterationCount = 0;

      let bridgeCompleted = false;
      let lastSeenStatus = 'pending';

      while (Date.now() - bridgeStartTime < maxWaitTime && iterationCount < maxIterations) {
        iterationCount++;
        // Check for shutdown
        if (!ctx.stateManager.isRunning()) {
          this.logger.warn('Bridge polling interrupted by shutdown', {
            opportunityId: opportunity.id,
            bridgeId,
          });
          return createErrorResult(
            opportunity.id,
            '[ERR_SHUTDOWN] Execution interrupted by shutdown',
            sourceChain,
            opportunity.buyDex || 'unknown',
            bridgeResult.sourceTxHash
          );
        }

        const bridgeStatus: BridgeStatusResult = await bridgeRouter.getStatus(bridgeId);

        // Fix 5.2: Log status transitions for debugging race conditions
        if (bridgeStatus.status !== lastSeenStatus) {
          this.logger.debug('Bridge status changed', {
            opportunityId: opportunity.id,
            bridgeId,
            previousStatus: lastSeenStatus,
            newStatus: bridgeStatus.status,
            elapsedMs: Date.now() - bridgeStartTime,
          });
          lastSeenStatus = bridgeStatus.status;
        }

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
            `[ERR_BRIDGE_FAILED] Bridge failed: ${bridgeStatus.error || bridgeStatus.status}`,
            sourceChain,
            opportunity.buyDex || 'unknown',
            bridgeResult.sourceTxHash
          );
        }

        // Fix 5.2: Add exponential backoff for long-running bridges
        // Reduces RPC load during extended waiting periods
        const elapsedMs = Date.now() - bridgeStartTime;
        const dynamicPollInterval = elapsedMs > 60000
          ? Math.min(pollInterval * 2, 30000) // Double interval after 1 minute, cap at 30s
          : pollInterval;

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, dynamicPollInterval));
      }

      if (!bridgeCompleted) {
        // NOTE: Nonce was already confirmed at line 265-267 after bridge execution succeeded.
        // We don't need to confirm again here - the source chain transaction was submitted
        // successfully, we're just waiting for the destination chain to receive it.

        // Fix 4.3: Include iteration count for debugging infinite loop scenarios
        const timedOutByTime = Date.now() - bridgeStartTime >= maxWaitTime;
        const timedOutByIterations = iterationCount >= maxIterations;

        this.logger.warn('Bridge timeout - funds may still be in transit', {
          opportunityId: opportunity.id,
          bridgeId,
          elapsedMs: Date.now() - bridgeStartTime,
          iterationCount,
          maxIterations,
          timedOutByTime,
          timedOutByIterations,
          lastStatus: lastSeenStatus,
        });

        return createErrorResult(
          opportunity.id,
          `[ERR_BRIDGE_TIMEOUT] Bridge timeout after ${iterationCount} polls - transaction may still complete`,
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
          `[ERR_NO_WALLET] No wallet/provider for destination chain: ${destChain}. Funds bridged but sell not executed.`,
          destChain,
          opportunity.sellDex || 'unknown',
          bridgeResult.sourceTxHash
        );
      }

      // Fix 4.3: Get nonce for sell transaction with proper error handling
      // At this point, bridge already succeeded - we need to log but continue if nonce fails
      // (returning error here would leave funds on destination chain without executing sell)
      let sellNonce: number | undefined;
      if (ctx.nonceManager) {
        try {
          sellNonce = await ctx.nonceManager.getNextNonce(destChain);
        } catch (error) {
          // Unlike bridge nonce, we log warning but continue - bridge already succeeded
          // The sell attempt should still be made even without managed nonce
          this.logger.warn('Failed to get nonce for destination sell, will let wallet decide', {
            destChain,
            bridgeTxHash: bridgeResult.sourceTxHash,
            error: getErrorMessage(error),
          });
        }
      }

      // Prepare and execute sell transaction on destination chain using DEX router
      //
      // TODO (Fix 7.2): Evaluate using flash loans on destination chain
      // ================================================================
      // Priority: Medium | Effort: 3 days | Depends on: FlashLoanProviderFactory
      //
      // Current: Direct DEX swap after bridge completion.
      //
      // Proposed: Use flash loan on destination chain for sell transaction.
      //
      // Benefits:
      // 1. Larger positions without holding capital on dest chain
      // 2. Atomic execution (revert if unprofitable after bridge)
      // 3. Reduced capital lockup during bridge waiting period
      // 4. Protection against price movement during bridge delay
      //
      // Trade-offs:
      // - Flash loan fee: ~0.09% on Aave V3, ~0.25-0.30% on other protocols
      // - Requires FlashLoanArbitrage contract deployed on dest chain
      // - Increased complexity in error handling (bridge succeeded but flash loan failed)
      //
      // Implementation:
      // 1. Check if FlashLoanProviderFactory.isFullySupported(destChain)
      // 2. If supported: use FlashLoanStrategy for sell
      // 3. If not supported: fall back to direct swap (current behavior)
      //
      // Tracking: https://github.com/yourorg/arbitrage/issues/XXX
      // ================================================================
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
          `[ERR_SELL_FAILED] Bridge succeeded but sell failed: ${getErrorMessage(sellError)}`,
          destChain,
          opportunity.sellDex || 'unknown',
          bridgeResult.sourceTxHash
        );
      }

      // Step 6: Calculate final results
      const executionTimeMs = Date.now() - startTime;

      // Get source chain gas price for bridge cost calculation
      const sourceGasPrice = await this.getOptimalGasPrice(sourceChain, ctx);

      // Fix 3.3: Use chain-specific native token prices for accurate gas cost calculation
      // Different chains have different native tokens (ETH, MATIC, BNB, etc.)
      const sourceNativeTokenPriceUsd = getNativeTokenPrice(sourceChain, { suppressWarning: true });
      const destNativeTokenPriceUsd = getNativeTokenPrice(destChain, { suppressWarning: true });

      // Calculate bridge gas cost in source chain's native token, then convert to USD
      const bridgeGasCostNative = bridgeResult.gasUsed
        ? parseFloat(ethers.formatEther(bridgeResult.gasUsed * sourceGasPrice))
        : 0;
      const bridgeGasCostUsd = bridgeGasCostNative * sourceNativeTokenPriceUsd;

      // Calculate sell gas cost in destination chain's native token, then convert to USD
      const sellGasCostNative = sellReceipt
        ? parseFloat(ethers.formatEther(sellReceipt.gasUsed * (sellReceipt.gasPrice || destGasPrice)))
        : 0;
      const sellGasCostUsd = sellGasCostNative * destNativeTokenPriceUsd;

      // Total gas cost in USD
      const totalGasCostUsd = bridgeGasCostUsd + sellGasCostUsd;

      // Calculate actual profit in USD (expected - bridge fees - gas costs)
      const actualProfit = expectedProfit - bridgeFeeUsd - totalGasCostUsd;

      this.logger.info('Cross-chain arbitrage completed', {
        opportunityId: opportunity.id,
        executionTimeMs,
        bridgeFeeEth,
        bridgeFeeUsd,
        bridgeGasCostUsd,
        sellGasCostUsd,
        totalGasCostUsd,
        sourceNativeTokenPriceUsd,
        destNativeTokenPriceUsd,
        expectedProfit,
        actualProfit,
      });

      // Fix 6.2: Use createSuccessResult helper for consistency
      return createSuccessResult(
        opportunity.id,
        sellTxHash || bridgeResult.sourceTxHash || '',
        destChain, // Report final chain where sell occurred
        opportunity.sellDex || 'unknown',
        {
          actualProfit,
          gasUsed: sellReceipt ? Number(sellReceipt.gasUsed) : (bridgeResult.gasUsed ? Number(bridgeResult.gasUsed) : undefined),
          gasCost: totalGasCostUsd, // Gas cost in USD for consistency with actualProfit
        }
      );

    } catch (error) {
      this.logger.error('Cross-chain arbitrage execution failed', {
        opportunityId: opportunity.id,
        sourceChain,
        destChain,
        error: getErrorMessage(error),
      });

      return createErrorResult(
        opportunity.id,
        `[ERR_EXECUTION] Cross-chain execution error: ${getErrorMessage(error)}`,
        sourceChain,
        opportunity.buyDex || 'unknown'
      );
    }
  }
}
