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
import type { StrategyContext, ExecutionResult, Logger, BridgePollingResult, BridgeRecoveryState } from '../types';
import {
  createErrorResult,
  createSuccessResult,
  ExecutionErrorCode,
  formatExecutionError,
  BRIDGE_RECOVERY_KEY_PREFIX,
  BRIDGE_RECOVERY_MAX_AGE_MS,
} from '../types';
import { BaseExecutionStrategy } from './base.strategy';
// Phase 5.2: Flash loan support for destination chain
import type { FlashLoanProviderFactory } from './flash-loan-providers/provider-factory';
// Fix 7.2: Import FlashLoanStrategy for destination chain flash loan execution
import { FlashLoanStrategy } from './flash-loan.strategy';

export class CrossChainStrategy extends BaseExecutionStrategy {
  // Phase 5.2: Optional flash loan provider factory for destination chain flash loans
  private readonly flashLoanProviderFactory?: FlashLoanProviderFactory;
  // Fix 7.2: Flash loan strategy instance for destination chain execution
  private readonly flashLoanStrategy?: FlashLoanStrategy;

  /**
   * Create a CrossChainStrategy instance.
   *
   * @param logger - Logger instance
   * @param flashLoanProviderFactory - Optional factory for checking flash loan support
   * @param flashLoanStrategy - Optional FlashLoanStrategy for destination chain atomic execution.
   *                            If provided, enables flash loan execution on supported destination chains.
   */
  constructor(
    logger: Logger,
    flashLoanProviderFactory?: FlashLoanProviderFactory,
    flashLoanStrategy?: FlashLoanStrategy
  ) {
    super(logger);
    this.flashLoanProviderFactory = flashLoanProviderFactory;
    this.flashLoanStrategy = flashLoanStrategy;
  }

  /**
   * Fix 7.2: Get the flash loan strategy for destination chain execution.
   * Returns undefined if not configured.
   */
  private getFlashLoanStrategy(): FlashLoanStrategy | undefined {
    return this.flashLoanStrategy;
  }

  /**
   * Phase 5.2: Check if destination chain supports flash loans for the sell transaction.
   * Using flash loans on destination chain provides:
   * - Larger positions without holding capital on dest chain
   * - Atomic execution (revert if unprofitable after bridge)
   * - Reduced capital lockup during bridge waiting period
   * - Protection against price movement during bridge delay
   */
  private isDestinationFlashLoanSupported(destChain: string): boolean {
    if (!this.flashLoanProviderFactory) {
      return false;
    }
    return this.flashLoanProviderFactory.isFullySupported(destChain);
  }

  /**
   * Fix 7.2: Execute destination sell using flash loan for atomic execution.
   *
   * This method delegates to FlashLoanStrategy for the sell transaction on the
   * destination chain. Benefits include:
   * - Atomic execution (reverts if unprofitable after bridge delay)
   * - Protection against price movement during bridge wait time
   * - Can execute larger positions without holding capital on destination chain
   *
   * @param sellOpportunity - The sell opportunity with reversed tokens (bridgeToken -> originalTokenIn)
   * @param destChain - Destination chain identifier
   * @param ctx - Strategy context with providers and wallets
   * @returns ExecutionResult from the flash loan execution
   */
  private async executeDestinationFlashLoan(
    sellOpportunity: ArbitrageOpportunity,
    destChain: string,
    ctx: StrategyContext
  ): Promise<ExecutionResult> {
    const flashLoanStrategy = this.getFlashLoanStrategy();

    // Check if flash loan strategy is available
    if (!flashLoanStrategy) {
      return createErrorResult(
        sellOpportunity.id,
        formatExecutionError(
          ExecutionErrorCode.NO_STRATEGY,
          'FlashLoanStrategy not configured for destination chain execution'
        ),
        destChain,
        sellOpportunity.buyDex || 'unknown'
      );
    }

    // Create a destination-specific context ensuring the correct chain is used
    const destCtx: StrategyContext = {
      ...ctx,
      // The opportunity's buyChain should already be set to destChain
    };

    this.logger.info('Executing destination sell via flash loan', {
      opportunityId: sellOpportunity.id,
      destChain,
      tokenIn: sellOpportunity.tokenIn,
      tokenOut: sellOpportunity.tokenOut,
      amountIn: sellOpportunity.amountIn,
    });

    try {
      const result = await flashLoanStrategy.execute(sellOpportunity, destCtx);

      if (result.success) {
        this.logger.info('Destination flash loan sell succeeded', {
          opportunityId: sellOpportunity.id,
          destChain,
          txHash: result.transactionHash,
          actualProfit: result.actualProfit,
        });
      } else {
        this.logger.warn('Destination flash loan sell failed', {
          opportunityId: sellOpportunity.id,
          destChain,
          error: result.error,
        });
      }

      return result;
    } catch (error) {
      this.logger.error('Destination flash loan execution threw exception', {
        opportunityId: sellOpportunity.id,
        destChain,
        error: getErrorMessage(error),
      });

      return createErrorResult(
        sellOpportunity.id,
        formatExecutionError(
          ExecutionErrorCode.FLASH_LOAN_ERROR,
          `Destination flash loan failed: ${getErrorMessage(error)}`
        ),
        destChain,
        sellOpportunity.buyDex || 'unknown'
      );
    }
  }

  async execute(
    opportunity: ArbitrageOpportunity,
    ctx: StrategyContext
  ): Promise<ExecutionResult> {
    const sourceChain = opportunity.buyChain;
    const destChain = opportunity.sellChain;
    const startTime = Date.now();

    // FIX-6.1: Use ExecutionErrorCode enum for standardized error codes
    if (!sourceChain || !destChain) {
      return createErrorResult(
        opportunity.id,
        formatExecutionError(ExecutionErrorCode.NO_CHAIN, 'Missing source or destination chain'),
        sourceChain || 'unknown',
        opportunity.buyDex || 'unknown'
      );
    }

    if (sourceChain === destChain) {
      return createErrorResult(
        opportunity.id,
        // Issue 6.1 Fix: Use formatExecutionError for consistent error formatting
        formatExecutionError(ExecutionErrorCode.SAME_CHAIN, 'Cross-chain requires different chains'),
        sourceChain,
        opportunity.buyDex || 'unknown'
      );
    }

    // Validate bridge router is available
    if (!ctx.bridgeRouterFactory) {
      return createErrorResult(
        opportunity.id,
        // Issue 6.1 Fix: Use formatExecutionError for consistent error formatting
        formatExecutionError(ExecutionErrorCode.NO_BRIDGE, 'Bridge router factory not initialized'),
        sourceChain,
        opportunity.buyDex || 'unknown'
      );
    }

    // Find suitable bridge router
    // Fix 4.1: Validate bridge token matches opportunity tokenOut
    // The bridge token must be what we receive from the buy side (tokenOut)
    const bridgeToken = opportunity.tokenOut || 'USDC';

    // Fix 4.1: Log warning if tokenOut is missing but we're defaulting to USDC
    // This could lead to bridge/swap mismatches if the actual tokenOut is different
    if (!opportunity.tokenOut) {
      this.logger.warn('Cross-chain: Missing tokenOut, defaulting to USDC bridge token', {
        opportunityId: opportunity.id,
        sourceChain,
        destChain,
        defaultBridgeToken: 'USDC',
        tokenIn: opportunity.tokenIn,
      });
    }

    const bridgeRouter = ctx.bridgeRouterFactory.findBestRouter(sourceChain, destChain, bridgeToken);

    if (!bridgeRouter) {
      return createErrorResult(
        opportunity.id,
        formatExecutionError(
          ExecutionErrorCode.NO_ROUTE,
          `${sourceChain} -> ${destChain} for ${bridgeToken}`
        ),
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
      tokenIn: opportunity.tokenIn,
      tokenOut: opportunity.tokenOut,
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
            // Fix 6.1: Use formatExecutionError for consistent error formatting
            formatExecutionError(ExecutionErrorCode.GAS_SPIKE, `on ${sourceChain}: ${errorMessage}`),
            sourceChain,
            opportunity.buyDex || 'unknown'
          );
        }
        // Non-spike error - log and continue (fallback gas price will be used)
        this.logger.debug('Gas price check failed, will use fallback', {
          error: errorMessage,
        });
      }

      // ==========================================================================
      // Phase 2.1: Pre-flight Simulation for Source Chain Buy Transaction
      // ==========================================================================
      // Simulate the source chain buy transaction BEFORE bridge quote to catch issues early.
      // This prevents wasting bridge API quota on opportunities that would fail anyway.
      const sourceWalletForSim = ctx.wallets.get(sourceChain);
      if (sourceWalletForSim && ctx.providers.get(sourceChain)) {
        try {
          // Prepare buy transaction for simulation
          const buySimTx = await this.prepareDexSwapTransaction(opportunity, sourceChain, ctx);
          buySimTx.from = await sourceWalletForSim.getAddress();

          const buySimResult = await this.performSimulation(opportunity, buySimTx, sourceChain, ctx);

          if (buySimResult?.wouldRevert) {
            ctx.stats.simulationPredictedReverts++;

            this.logger.warn('Aborting cross-chain execution: source buy simulation predicted revert', {
              opportunityId: opportunity.id,
              revertReason: buySimResult.revertReason,
              simulationLatencyMs: buySimResult.latencyMs,
              provider: buySimResult.provider,
              sourceChain,
            });

            return createErrorResult(
              opportunity.id,
              formatExecutionError(ExecutionErrorCode.SIMULATION_REVERT, `source buy simulation predicted revert - ${buySimResult.revertReason || 'unknown reason'}`),
              sourceChain,
              opportunity.buyDex || 'unknown'
            );
          }
        } catch (simError) {
          // Log but continue - simulation preparation failure shouldn't block execution
          this.logger.debug('Could not prepare source buy for simulation, proceeding', {
            opportunityId: opportunity.id,
            error: getErrorMessage(simError),
          });
        }
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
          formatExecutionError(ExecutionErrorCode.BRIDGE_QUOTE, bridgeQuote.error),
          sourceChain,
          opportunity.buyDex || 'unknown'
        );
      }

      // Fix 9.3: Use extracted bridge profitability helper
      // Validate profit still viable after bridge fees
      const ethPriceUsd = getDefaultPrice('ETH');
      // P0-001 FIX: Use ?? to preserve 0 as valid profit (|| treats 0 as falsy)
      const expectedProfit = opportunity.expectedProfit ?? 0;

      // Fix 2.2: Ensure totalFee is bigint with proper handling of all formats
      // The bridge quote may return:
      // - bigint: Direct BigInt value
      // - string: Integer string like "123456" (from JSON serialization)
      // - string: Float string like "123.45" (INVALID for BigInt, but some APIs return this)
      // - number: JavaScript number
      // - undefined/null: Missing value
      let totalFeeBigInt: bigint;
      try {
        const rawFee = bridgeQuote.totalFee;

        if (typeof rawFee === 'bigint') {
          totalFeeBigInt = rawFee;
        } else if (typeof rawFee === 'string') {
          // Fix 2.2: Handle float strings by truncating to integer
          // BigInt("123.45") throws SyntaxError, so we need to handle this case
          if (rawFee.includes('.')) {
            // Float string - truncate to integer (wei values shouldn't have decimals)
            const floatValue = parseFloat(rawFee);
            if (!Number.isFinite(floatValue)) {
              throw new Error(`Non-finite float value: ${rawFee}`);
            }
            totalFeeBigInt = BigInt(Math.floor(floatValue));
            this.logger.warn('[WARN_BRIDGE_FEE_FORMAT] Bridge fee was float string, truncated to integer', {
              opportunityId: opportunity.id,
              original: rawFee,
              converted: totalFeeBigInt.toString(),
            });
          } else {
            // Integer string - direct conversion
            totalFeeBigInt = BigInt(rawFee);
          }
        } else if (typeof rawFee === 'number') {
          // JavaScript number - convert to BigInt (truncate if float)
          if (!Number.isFinite(rawFee)) {
            throw new Error(`Non-finite number value: ${rawFee}`);
          }
          totalFeeBigInt = BigInt(Math.floor(rawFee));
        } else {
          // undefined, null, or other - default to 0
          totalFeeBigInt = 0n;
        }
      } catch (error) {
        this.logger.error('Invalid bridge fee format', {
          opportunityId: opportunity.id,
          totalFee: bridgeQuote.totalFee,
          totalFeeType: typeof bridgeQuote.totalFee,
          error: getErrorMessage(error),
        });
        return createErrorResult(
          opportunity.id,
          formatExecutionError(ExecutionErrorCode.BRIDGE_QUOTE, `Invalid bridge fee format: ${bridgeQuote.totalFee}`),
          sourceChain,
          opportunity.buyDex || 'unknown'
        );
      }

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
          formatExecutionError(ExecutionErrorCode.HIGH_FEES, bridgeProfitability.reason),
          sourceChain,
          opportunity.buyDex || 'unknown'
        );
      }

      // Use fee values from helper for later calculations
      const bridgeFeeEth = bridgeProfitability.bridgeFeeEth;
      const bridgeFeeUsd = bridgeProfitability.bridgeFeeUsd;

      // Step 2: Validate source chain context using helper (Fix 6.2 & 9.1)
      const sourceValidation = this.validateContext(sourceChain, ctx);
      if (!sourceValidation.valid) {
        return createErrorResult(
          opportunity.id,
          formatExecutionError(ExecutionErrorCode.NO_WALLET, sourceValidation.error),
          sourceChain,
          opportunity.buyDex || 'unknown'
        );
      }
      const { wallet: sourceWallet, provider: sourceProvider } = sourceValidation;

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
            formatExecutionError(ExecutionErrorCode.NONCE_ERROR, `Failed to get nonce for bridge transaction: ${errorMessage}`),
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
          // Fix 6.1: formatExecutionError already returns the full error message for enum values
          // but using the helper ensures consistent pattern across the codebase
          formatExecutionError(ExecutionErrorCode.QUOTE_EXPIRED, 'Bridge quote expired before execution'),
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
              formatExecutionError(ExecutionErrorCode.SIMULATION_REVERT, `destination sell simulation predicted revert - ${simulationResult.revertReason || 'unknown reason'}`),
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
      //
      // Note (Issue 4.3): MEV protection is NOT applied to bridge transactions.
      // ===========================================================================
      // The bridgeRouter.execute() method handles transaction submission internally.
      // To add MEV protection would require:
      // 1. Modifying BridgeRouter interface to return a prepared transaction
      // 2. Applying MEV protection externally before sending
      // 3. Then confirming the transaction with the bridge router
      //
      // Current mitigation:
      // - Bridge transactions are typically not as MEV-vulnerable as DEX swaps
      //   because they don't reveal profitable arbitrage paths directly
      // - The bridge protocols (Stargate, LayerZero) often have their own
      //   mempool protection mechanisms
      // - Most MEV extraction happens on the destination chain sell (which IS protected)
      //
      // Future improvement: Add MEV protection to BridgeRouter interface if needed.
      // Tracking: https://github.com/arbitrage-system/arbitrage/issues/157
      // ===========================================================================
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
          formatExecutionError(ExecutionErrorCode.BRIDGE_EXEC, bridgeResult.error),
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
      // Refactor 9.3: Extracted polling logic to separate method for readability
      const bridgeId = bridgeResult.bridgeId!;
      const pollingResult = await this.pollBridgeCompletion(
        bridgeRouter,
        bridgeId,
        opportunity.id,
        sourceChain,
        bridgeResult.sourceTxHash || '',
        ctx
      );

      if (!pollingResult.completed) {
        // Bridge failed or timed out
        return createErrorResult(
          opportunity.id,
          formatExecutionError(pollingResult.error!.code, pollingResult.error!.message),
          sourceChain,
          opportunity.buyDex || 'unknown',
          pollingResult.error!.sourceTxHash
        );
      }

      // Bug 4.1 Fix: Validate bridgedAmountReceived is present after successful poll
      // If poll completed successfully but amountReceived is missing, this indicates
      // a bug in the bridge router or protocol - treat as execution error
      const bridgedAmountReceived = pollingResult.amountReceived;
      if (!bridgedAmountReceived) {
        this.logger.error('Bridge completed but amountReceived is missing', {
          opportunityId: opportunity.id,
          bridgeId,
          destTxHash: pollingResult.destTxHash,
        });
        return createErrorResult(
          opportunity.id,
          formatExecutionError(
            ExecutionErrorCode.BRIDGE_EXEC,
            'Bridge completed but amountReceived not reported - cannot proceed with sell'
          ),
          sourceChain,
          opportunity.buyDex || 'unknown',
          bridgeResult.sourceTxHash
        );
      }

      // Step 5: Validate destination chain context using helper (Fix 6.2 & 9.1)
      const destValidation = this.validateContext(destChain, ctx);
      if (!destValidation.valid) {
        // Bridge succeeded but can't execute sell - funds are on dest chain
        this.logger.error('Cannot execute sell - no wallet/provider for destination chain', {
          opportunityId: opportunity.id,
          destChain,
          bridgeTxHash: bridgeResult.sourceTxHash,
          validationError: destValidation.error,
        });

        return createErrorResult(
          opportunity.id,
          formatExecutionError(ExecutionErrorCode.NO_WALLET, `${destValidation.error}. Funds bridged but sell not executed.`),
          destChain,
          opportunity.sellDex || 'unknown',
          bridgeResult.sourceTxHash
        );
      }
      const { wallet: destWallet } = destValidation;

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
      // Tracking: https://github.com/arbitrage-system/arbitrage/issues/142
      // ================================================================

      // BUG-4.2-FIX: Create a "sell opportunity" with reversed tokens for destination swap
      // After bridging, we have bridgeToken (= tokenOut) on destination chain
      // We want to SELL bridgeToken -> tokenIn (reverse of the buy direction)
      // Bug 4.1 Fix: bridgedAmountReceived is now guaranteed to be defined (validated above)
      const sellAmount = bridgedAmountReceived;
      const sellOpportunity: ArbitrageOpportunity = {
        ...opportunity,
        // Fix 4.2: Reverse the token direction for the sell on destination chain
        // Original buy: tokenIn (e.g., WETH) -> tokenOut (e.g., USDC), then bridge tokenOut
        // Destination sell: bridgeToken (= tokenOut, e.g., USDC) -> original tokenIn (e.g., WETH)
        tokenIn: bridgeToken,                    // We're selling the bridged token (was original tokenOut)
        tokenOut: opportunity.tokenIn || 'USDT', // We're receiving the original buy token (was original tokenIn)
        amountIn: sellAmount,                    // Amount we received from bridge
        // Keep sell DEX reference
        buyDex: opportunity.sellDex || opportunity.buyDex,
        // Phase 5.2: Set chain for sell opportunity
        buyChain: destChain,
      };

      // Phase 5.2: Check if destination chain supports flash loans
      // Using flash loans provides atomic execution and protection against price movement
      const useDestFlashLoan = this.isDestinationFlashLoanSupported(destChain);

      // Fix 7.2: Variables for sell transaction result (shared between flash loan and DEX swap paths)
      let sellReceipt: ethers.TransactionReceipt | null = null;
      let sellTxHash: string | undefined;
      let usedMevProtection = false;
      let usedDestFlashLoan = false;

      // Fix 7.2: Try flash loan execution if supported
      if (useDestFlashLoan) {
        this.logger.info('Destination chain supports flash loans - attempting atomic sell', {
          opportunityId: opportunity.id,
          destChain,
          sellAmount,
          bridgeToken,
        });

        // Mark the sell opportunity to use flash loan execution
        sellOpportunity.useFlashLoan = true;

        // Execute via FlashLoanStrategy
        const flashLoanResult = await this.executeDestinationFlashLoan(sellOpportunity, destChain, ctx);

        if (flashLoanResult.success) {
          // Flash loan succeeded - use its result
          sellTxHash = flashLoanResult.transactionHash;
          usedDestFlashLoan = true;

          this.logger.info('Destination flash loan sell completed successfully', {
            opportunityId: opportunity.id,
            destChain,
            sellTxHash,
            actualProfit: flashLoanResult.actualProfit,
          });

          // Skip to final calculations (Step 6)
          // We still need to calculate final profit including bridge costs
          const sourceGasPrice = await this.getOptimalGasPrice(sourceChain, ctx);
          let sourceNativeTokenPriceUsd = getNativeTokenPrice(sourceChain, { suppressWarning: true });
          const DEFAULT_NATIVE_TOKEN_PRICE_USD = 2000;
          if (!Number.isFinite(sourceNativeTokenPriceUsd) || sourceNativeTokenPriceUsd <= 0) {
            sourceNativeTokenPriceUsd = DEFAULT_NATIVE_TOKEN_PRICE_USD;
          }
          const bridgeGasCostNative = bridgeResult.gasUsed
            ? parseFloat(ethers.formatEther(bridgeResult.gasUsed * sourceGasPrice))
            : 0;
          const bridgeGasCostUsd = bridgeGasCostNative * sourceNativeTokenPriceUsd;

          // Combine bridge cost with flash loan result's gas cost
          const totalGasCostUsd = bridgeGasCostUsd + (flashLoanResult.gasCost ?? 0);

          // Flash loan result already includes profit calculation
          const actualProfitUsd = (flashLoanResult.actualProfit ?? 0) - bridgeGasCostUsd;

          // Fix 7.2: Return success using correct createSuccessResult signature
          return createSuccessResult(
            opportunity.id,
            sellTxHash || bridgeResult.sourceTxHash || '',
            destChain, // Report final chain where sell occurred
            opportunity.sellDex || 'unknown',
            {
              actualProfit: actualProfitUsd,
              gasCost: totalGasCostUsd,
              latencyMs: Date.now() - startTime,
              usedMevProtection: false, // Flash loan handles its own MEV protection
            }
          );
        } else {
          // Flash loan failed - fall back to standard DEX swap
          this.logger.warn('Destination flash loan failed, falling back to direct DEX swap', {
            opportunityId: opportunity.id,
            destChain,
            flashLoanError: flashLoanResult.error,
          });
          // Continue with standard DEX swap below
        }
      }

      // Standard DEX swap path (used when flash loans not supported or flash loan failed)
      const sellTx = await this.prepareDexSwapTransaction(sellOpportunity, destChain, ctx);

      // Ensure token approval for DEX router before swap
      // BUG-4.2-FIX: Use the bridged token (bridgeToken) for approval, not tokenIn
      // The bridged token is what we're selling on the destination chain
      if (bridgeToken && sellTx.to) {
        try {
          const amountToApprove = BigInt(sellAmount);
          const approvalNeeded = await this.ensureTokenAllowance(
            bridgeToken,               // BUG-4.2-FIX: Approve the token we're selling
            sellTx.to as string,
            amountToApprove,           // BUG-4.2-FIX: Use bridged amount, not original amountIn
            destChain,
            ctx
          );
          if (approvalNeeded) {
            this.logger.info('Token approval granted for destination sell', {
              opportunityId: opportunity.id,
              token: bridgeToken,       // BUG-4.2-FIX: Log the correct token
              amount: sellAmount,
              router: sellTx.to,
              destChain,
            });
          }
        } catch (approvalError) {
          this.logger.warn('Token approval failed, proceeding with sell attempt', {
            opportunityId: opportunity.id,
            token: bridgeToken,
            error: getErrorMessage(approvalError),
          });
          // Continue anyway - approval might already exist or swap might still work
        }
      }

      // Apply gas settings for destination chain
      const destGasPrice = await this.getOptimalGasPrice(destChain, ctx);
      if (sellNonce !== undefined) {
        sellTx.nonce = sellNonce;
      }

      // Bug 4.2 Fix: Verify destination provider health before sending sell transaction
      // After bridge wait (potentially minutes), provider could have disconnected
      const destProvider = ctx.providers.get(destChain);
      if (destProvider) {
        const isDestProviderHealthy = await this.isProviderHealthy(destProvider, destChain, ctx);
        if (!isDestProviderHealthy) {
          // Mark sell nonce as failed since we won't attempt the transaction
          if (ctx.nonceManager && sellNonce !== undefined) {
            ctx.nonceManager.failTransaction(destChain, sellNonce, 'Provider unhealthy');
          }

          this.logger.error('Destination provider unhealthy after bridge - sell not attempted', {
            opportunityId: opportunity.id,
            destChain,
            bridgeTxHash: bridgeResult.sourceTxHash,
          });

          return createErrorResult(
            opportunity.id,
            formatExecutionError(
              ExecutionErrorCode.NO_PROVIDER,
              `Destination provider (${destChain}) unhealthy after bridge. Funds bridged but sell not executed.`
            ),
            destChain,
            opportunity.sellDex || 'unknown',
            bridgeResult.sourceTxHash
          );
        }
      }

      // Fix 9.3: Apply MEV protection to destination sell transaction
      // This was previously missing, leaving sell transactions vulnerable to MEV attacks
      const protectedSellTx = await this.applyMEVProtection(sellTx, destChain, ctx);

      // Note: sellReceipt, sellTxHash, usedMevProtection declared above (Fix 7.2)

      try {
        // Fix 9.3: Check MEV eligibility for destination chain and use protected submission if available
        const { shouldUseMev, mevProvider, chainSettings } = this.checkMevEligibility(
          destChain,
          ctx,
          opportunity.expectedProfit
        );

        if (shouldUseMev && mevProvider) {
          // Use MEV protected submission
          this.logger.info('Using MEV protection for destination sell', {
            opportunityId: opportunity.id,
            destChain,
            strategy: mevProvider.strategy,
          });

          const mevResult = await this.withTransactionTimeout(
            () => mevProvider.sendProtectedTransaction(protectedSellTx, {
              simulate: false, // Already validated via simulation earlier
              priorityFeeGwei: chainSettings?.priorityFeeGwei,
            }),
            'mevProtectedDestinationSell'
          );

          if (!mevResult.success) {
            throw new Error(`MEV protected submission failed: ${mevResult.error}`);
          }

          sellTxHash = mevResult.transactionHash;
          usedMevProtection = true;

          // Get receipt if available
          if (sellTxHash && destValidation.provider) {
            sellReceipt = await this.withTransactionTimeout(
              () => destValidation.provider.getTransactionReceipt(sellTxHash!),
              'getMevSellReceipt'
            );
          }

          this.logger.info('MEV protected destination sell completed', {
            opportunityId: opportunity.id,
            destChain,
            sellTxHash,
            strategy: mevResult.strategy,
            usedFallback: mevResult.usedFallback,
          });
        } else {
          // Standard transaction submission (no MEV protection available/needed)
          const sellTxResponse = await this.withTransactionTimeout(
            () => destWallet.sendTransaction(protectedSellTx),
            'destinationSell'
          );

          sellTxHash = sellTxResponse.hash;

          sellReceipt = await this.withTransactionTimeout(
            () => sellTxResponse.wait(),
            'waitForSellReceipt'
          );

          this.logger.info('Destination sell executed (standard)', {
            opportunityId: opportunity.id,
            destChain,
            sellTxHash,
            gasUsed: sellReceipt?.gasUsed?.toString(),
          });
        }

        // Confirm sell nonce
        if (ctx.nonceManager && sellNonce !== undefined && sellTxHash) {
          ctx.nonceManager.confirmTransaction(destChain, sellNonce, sellTxHash);
        }
      } catch (sellError) {
        // Sell failed - bridge succeeded but profit not captured
        if (ctx.nonceManager && sellNonce !== undefined) {
          ctx.nonceManager.failTransaction(destChain, sellNonce, getErrorMessage(sellError));
        }

        this.logger.error('Destination sell failed', {
          opportunityId: opportunity.id,
          destChain,
          bridgeTxHash: bridgeResult.sourceTxHash,
          usedMevProtection,
          error: getErrorMessage(sellError),
        });

        return createErrorResult(
          opportunity.id,
          formatExecutionError(ExecutionErrorCode.SELL_FAILED, `Bridge succeeded but sell failed: ${getErrorMessage(sellError)}`),
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
      let sourceNativeTokenPriceUsd = getNativeTokenPrice(sourceChain, { suppressWarning: true });
      let destNativeTokenPriceUsd = getNativeTokenPrice(destChain, { suppressWarning: true });

      // Bug 4.1 Fix: Validate native token prices are not zero or invalid
      // If getNativeTokenPrice returns 0 (unsupported chain with suppressWarning),
      // calculations would produce incorrect results (zero gas costs, inflated profits)
      const DEFAULT_NATIVE_TOKEN_PRICE_USD = 2000; // Conservative ETH estimate as fallback
      if (!Number.isFinite(sourceNativeTokenPriceUsd) || sourceNativeTokenPriceUsd <= 0) {
        this.logger.warn('Invalid source chain native token price, using fallback', {
          opportunityId: opportunity.id,
          sourceChain,
          originalPrice: sourceNativeTokenPriceUsd,
          fallbackPrice: DEFAULT_NATIVE_TOKEN_PRICE_USD,
        });
        sourceNativeTokenPriceUsd = DEFAULT_NATIVE_TOKEN_PRICE_USD;
      }
      if (!Number.isFinite(destNativeTokenPriceUsd) || destNativeTokenPriceUsd <= 0) {
        this.logger.warn('Invalid dest chain native token price, using fallback', {
          opportunityId: opportunity.id,
          destChain,
          originalPrice: destNativeTokenPriceUsd,
          fallbackPrice: DEFAULT_NATIVE_TOKEN_PRICE_USD,
        });
        destNativeTokenPriceUsd = DEFAULT_NATIVE_TOKEN_PRICE_USD;
      }

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
        formatExecutionError(ExecutionErrorCode.EXECUTION_ERROR, `Cross-chain execution error: ${getErrorMessage(error)}`),
        sourceChain,
        opportunity.buyDex || 'unknown'
      );
    }
  }

  // ===========================================================================
  // Bridge Polling (Refactor 9.3)
  // ===========================================================================

  /**
   * Refactor 9.3: Poll bridge for completion status.
   *
   * Extracted from execute() to improve readability and testability.
   * This method handles the polling loop with:
   * - Timeout detection (time-based and iteration-based)
   * - Status transition logging
   * - Exponential backoff for long-running bridges
   * - Shutdown detection
   *
   * ## Fix 5.1: Bridge Recovery Considerations
   *
   * **IMPORTANT**: If shutdown occurs during bridge polling, funds may be stuck:
   * - Source chain: Transaction already confirmed (funds sent to bridge)
   * - Bridge: Tokens in transit (processing)
   * - Destination: No action taken yet
   *
   * To recover interrupted bridges, on restart the engine should:
   * 1. Query Redis for pending bridge transactions (stored in BridgeRecoveryState)
   * 2. Check bridge status via bridgeRouter.getStatus(bridgeId)
   * 3. If completed: Execute the sell side using stored opportunity data
   * 4. If failed/refunded: Log and mark as resolved
   * 5. If still pending: Resume polling
   *
   * The following state should be persisted before bridge execution:
   * - opportunityId, bridgeId, sourceTxHash, sourceChain, destChain
   * - bridgeToken, bridgeAmount, sellDex, expectedProfit
   * - timestamp when bridge was initiated
   *
   * FIX 3.1: Bridge recovery implemented.
   * - Store BridgeRecoveryState in Redis before bridge initiation
   * - On engine restart, query pending bridges and resume polling
   * - Implemented timeout handling for bridges that exceed max wait time
   * @see persistBridgeRecoveryState, recoverPendingBridges, BridgeRecoveryState
   *
   * @param bridgeRouter - Bridge router instance
   * @param bridgeId - Bridge transaction ID
   * @param opportunityId - Opportunity ID for logging
   * @param sourceChain - Source chain for error results
   * @param sourceTxHash - Source transaction hash
   * @param ctx - Strategy context (for shutdown detection)
   * @returns Polling result with completion status or error
   */
  protected async pollBridgeCompletion(
    bridgeRouter: NonNullable<ReturnType<NonNullable<StrategyContext['bridgeRouterFactory']>['getRouter']>>,
    bridgeId: string,
    opportunityId: string,
    sourceChain: string,
    sourceTxHash: string,
    ctx: StrategyContext
  ): Promise<BridgePollingResult> {
    const maxWaitTime = BRIDGE_DEFAULTS.maxBridgeWaitMs;
    const pollInterval = BRIDGE_DEFAULTS.statusPollIntervalMs;
    const bridgeStartTime = Date.now();

    // Fix 4.3: Calculate maximum iterations based on wait time and minimum poll interval
    const minPollInterval = Math.min(pollInterval, 5000);
    const maxIterations = Math.ceil(maxWaitTime / minPollInterval) + 10;
    let iterationCount = 0;

    let lastSeenStatus = 'pending';

    // Race 5.3 Fix: Pre-compute deadline
    const pollDeadline = bridgeStartTime + maxWaitTime;

    while (iterationCount < maxIterations) {
      iterationCount++;

      // Race 5.3 Fix: Check time FIRST
      const now = Date.now();
      if (now >= pollDeadline) {
        break;
      }

      // Check for shutdown
      if (!ctx.stateManager.isRunning()) {
        this.logger.warn('Bridge polling interrupted by shutdown', {
          opportunityId,
          bridgeId,
        });
        return {
          completed: false,
          error: {
            code: ExecutionErrorCode.SHUTDOWN,
            message: 'Polling interrupted by shutdown',
            sourceTxHash,
          },
        };
      }

      // Bug 4.2 Fix: Wrap getStatus() in try/catch to handle RPC/network errors
      // Without this, an exception would cause the entire cross-chain execution to fail
      // without proper error handling or nonce cleanup
      let bridgeStatus: BridgeStatusResult;
      try {
        bridgeStatus = await bridgeRouter.getStatus(bridgeId);
      } catch (statusError) {
        // Log the error and continue polling - transient network errors shouldn't abort
        this.logger.warn('Bridge status check failed, will retry', {
          opportunityId,
          bridgeId,
          iterationCount,
          error: getErrorMessage(statusError),
        });
        // Wait before retry to avoid hammering the API
        await new Promise(resolve => setTimeout(resolve, Math.min(pollInterval, 5000)));
        continue;
      }

      // Fix 3.2: Check for shutdown AFTER async operation completes
      // The shutdown may have occurred during the getStatus() network call.
      // Without this check, we would continue processing a stale result
      // while the service is partially torn down.
      if (!ctx.stateManager.isRunning()) {
        this.logger.warn('Bridge polling interrupted by shutdown after status fetch', {
          opportunityId,
          bridgeId,
          lastStatus: bridgeStatus.status,
        });
        return {
          completed: false,
          error: {
            code: ExecutionErrorCode.SHUTDOWN,
            message: 'Polling interrupted by shutdown after status fetch',
            sourceTxHash,
          },
        };
      }

      // Log status transitions
      if (bridgeStatus.status !== lastSeenStatus) {
        this.logger.debug('Bridge status changed', {
          opportunityId,
          bridgeId,
          previousStatus: lastSeenStatus,
          newStatus: bridgeStatus.status,
          elapsedMs: Date.now() - bridgeStartTime,
        });
        lastSeenStatus = bridgeStatus.status;
      }

      if (bridgeStatus.status === 'completed') {
        this.logger.info('Bridge completed', {
          opportunityId,
          bridgeId,
          destTxHash: bridgeStatus.destTxHash,
          amountReceived: bridgeStatus.amountReceived,
        });
        return {
          completed: true,
          amountReceived: bridgeStatus.amountReceived,
          destTxHash: bridgeStatus.destTxHash,
        };
      }

      if (bridgeStatus.status === 'failed' || bridgeStatus.status === 'refunded') {
        return {
          completed: false,
          error: {
            code: ExecutionErrorCode.BRIDGE_FAILED,
            message: bridgeStatus.error || bridgeStatus.status,
            sourceTxHash,
          },
        };
      }

      // Race 5.3 Fix: Check time again AFTER status fetch
      const nowAfterFetch = Date.now();
      if (nowAfterFetch >= pollDeadline) {
        break;
      }

      // Perf 10.3 Fix: More aggressive exponential backoff
      // Start backoff earlier (30s instead of 60s) and cap at 20s instead of 30s
      // This reduces API load while maintaining reasonable responsiveness
      const elapsedMs = nowAfterFetch - bridgeStartTime;
      let dynamicPollInterval: number;
      if (elapsedMs > 120000) {
        // After 2 minutes: maximum backoff (20s)
        dynamicPollInterval = 20000;
      } else if (elapsedMs > 60000) {
        // After 1 minute: double the interval (cap at 15s)
        dynamicPollInterval = Math.min(pollInterval * 2, 15000);
      } else if (elapsedMs > 30000) {
        // After 30 seconds: 1.5x the interval
        dynamicPollInterval = Math.min(Math.floor(pollInterval * 1.5), 10000);
      } else {
        // First 30 seconds: use configured interval
        dynamicPollInterval = pollInterval;
      }

      // Don't wait longer than remaining time
      const remainingTime = pollDeadline - nowAfterFetch;
      const effectivePollInterval = Math.min(dynamicPollInterval, remainingTime);

      await new Promise(resolve => setTimeout(resolve, effectivePollInterval));
    }

    // Timeout
    const timedOutByTime = Date.now() - bridgeStartTime >= maxWaitTime;
    const timedOutByIterations = iterationCount >= maxIterations;

    this.logger.warn('Bridge timeout - funds may still be in transit', {
      opportunityId,
      bridgeId,
      elapsedMs: Date.now() - bridgeStartTime,
      iterationCount,
      maxIterations,
      timedOutByTime,
      timedOutByIterations,
      lastStatus: lastSeenStatus,
    });

    return {
      completed: false,
      error: {
        code: ExecutionErrorCode.BRIDGE_TIMEOUT,
        message: `timeout after ${iterationCount} polls - transaction may still complete`,
        sourceTxHash,
      },
    };
  }

  // ==========================================================================
  // FIX 3.1: Bridge Recovery Implementation
  // ==========================================================================

  /**
   * Persist bridge recovery state to Redis before bridge execution.
   *
   * This enables recovery if shutdown occurs during bridge polling.
   * The state is stored in Redis with a TTL matching BRIDGE_RECOVERY_MAX_AGE_MS.
   *
   * @param state - Bridge recovery state to persist
   * @param redis - Redis client for persistence
   */
  async persistBridgeRecoveryState(
    state: BridgeRecoveryState,
    redis: import('@arbitrage/core').RedisClient
  ): Promise<void> {
    const key = `${BRIDGE_RECOVERY_KEY_PREFIX}${state.bridgeId}`;
    const ttlSeconds = Math.floor(BRIDGE_RECOVERY_MAX_AGE_MS / 1000);

    try {
      await redis.set(key, state, ttlSeconds);
      this.logger.debug('Persisted bridge recovery state', {
        bridgeId: state.bridgeId,
        opportunityId: state.opportunityId,
        sourceChain: state.sourceChain,
        destChain: state.destChain,
      });
    } catch (error) {
      // Log but don't fail - recovery is best-effort
      this.logger.warn('Failed to persist bridge recovery state', {
        bridgeId: state.bridgeId,
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Update bridge recovery status in Redis.
   *
   * Called when bridge completes (to mark as recovered) or fails (to mark as failed).
   *
   * @param bridgeId - Bridge transaction ID
   * @param status - New status
   * @param redis - Redis client
   * @param errorMessage - Optional error message for failed status
   */
  async updateBridgeRecoveryStatus(
    bridgeId: string,
    status: BridgeRecoveryState['status'],
    redis: import('@arbitrage/core').RedisClient,
    errorMessage?: string
  ): Promise<void> {
    const key = `${BRIDGE_RECOVERY_KEY_PREFIX}${bridgeId}`;

    try {
      const existing = await redis.get(key);
      if (!existing) {
        // State already expired or wasn't persisted - OK
        return;
      }

      let state: BridgeRecoveryState;
      try {
        state = JSON.parse(existing);
      } catch (parseError) {
        // Corrupt data in Redis - clean up and return
        this.logger.warn('Corrupt bridge recovery state, deleting key', {
          bridgeId,
          key,
          error: getErrorMessage(parseError),
        });
        await redis.del(key);
        return;
      }
      state.status = status;
      state.lastCheckAt = Date.now();
      if (errorMessage) {
        state.errorMessage = errorMessage;
      }

      // Keep same TTL for tracking purposes
      const ttlSeconds = Math.floor(BRIDGE_RECOVERY_MAX_AGE_MS / 1000);
      await redis.set(key, state, ttlSeconds);

      // If recovered or failed, we can delete the key (cleanup)
      if (status === 'recovered' || status === 'failed') {
        // Short TTL for post-processing analysis, then auto-cleanup
        await redis.set(key, state, 3600); // 1 hour
      }

      this.logger.debug('Updated bridge recovery status', {
        bridgeId,
        status,
        errorMessage,
      });
    } catch (error) {
      this.logger.warn('Failed to update bridge recovery status', {
        bridgeId,
        status,
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Recover pending bridges on engine restart.
   *
   * Scans Redis for pending bridge states and resumes polling/execution.
   * This is called from ExecutionEngineService.start() to handle
   * bridges that were interrupted by shutdown.
   *
   * @param ctx - Strategy context with bridge router factory and other deps
   * @param redis - Redis client for state retrieval
   * @returns Number of bridges recovered
   */
  async recoverPendingBridges(
    ctx: StrategyContext,
    redis: import('@arbitrage/core').RedisClient
  ): Promise<number> {
    let recoveredCount = 0;

    try {
      // Scan for pending bridge recovery keys using iterative scan
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [nextCursor, foundKeys] = await redis.scan(
          cursor,
          'MATCH',
          `${BRIDGE_RECOVERY_KEY_PREFIX}*`,
          'COUNT',
          100
        );
        cursor = nextCursor;
        keys.push(...foundKeys);
      } while (cursor !== '0');

      if (keys.length === 0) {
        this.logger.debug('No pending bridges to recover');
        return 0;
      }

      this.logger.info('Found pending bridges for recovery', { count: keys.length });

      for (const key of keys) {
        try {
          const stateJson = await redis.get(key);
          if (!stateJson) continue;

          let state: BridgeRecoveryState;
          try {
            state = JSON.parse(stateJson);
          } catch (parseError) {
            // Corrupt data in Redis - clean up and continue
            this.logger.warn('Corrupt bridge recovery state during scan, deleting key', {
              key,
              error: getErrorMessage(parseError),
            });
            await redis.del(key);
            continue;
          }

          // Skip already recovered/failed bridges
          if (state.status === 'recovered' || state.status === 'failed') {
            continue;
          }

          // Check if bridge is too old
          if (Date.now() - state.initiatedAt > BRIDGE_RECOVERY_MAX_AGE_MS) {
            this.logger.warn('Bridge recovery state expired', {
              bridgeId: state.bridgeId,
              initiatedAt: state.initiatedAt,
              ageMs: Date.now() - state.initiatedAt,
            });
            await this.updateBridgeRecoveryStatus(state.bridgeId, 'failed', redis, 'Recovery state expired');
            continue;
          }

          // Attempt recovery
          const recovered = await this.recoverSingleBridge(state, ctx, redis);
          if (recovered) {
            recoveredCount++;
          }
        } catch (error) {
          this.logger.error('Error recovering bridge', {
            key,
            error: getErrorMessage(error),
          });
        }
      }

      this.logger.info('Bridge recovery completed', {
        total: keys.length,
        recovered: recoveredCount,
      });

      return recoveredCount;
    } catch (error) {
      this.logger.error('Bridge recovery scan failed', {
        error: getErrorMessage(error),
      });
      return recoveredCount;
    }
  }

  /**
   * Recover a single pending bridge.
   *
   * Checks bridge status and completes the sell if needed.
   */
  private async recoverSingleBridge(
    state: BridgeRecoveryState,
    ctx: StrategyContext,
    redis: import('@arbitrage/core').RedisClient
  ): Promise<boolean> {
    this.logger.info('Attempting bridge recovery', {
      bridgeId: state.bridgeId,
      opportunityId: state.opportunityId,
      sourceChain: state.sourceChain,
      destChain: state.destChain,
      initiatedAt: state.initiatedAt,
    });

    // Get bridge router
    if (!ctx.bridgeRouterFactory) {
      this.logger.warn('Cannot recover bridge - no bridge router factory');
      await this.updateBridgeRecoveryStatus(state.bridgeId, 'failed', redis, 'No bridge router factory');
      return false;
    }

    const bridgeRouter = ctx.bridgeRouterFactory.findBestRouter(
      state.sourceChain,
      state.destChain,
      state.bridgeToken
    );

    if (!bridgeRouter) {
      this.logger.warn('Cannot recover bridge - no suitable router', {
        bridgeId: state.bridgeId,
      });
      await this.updateBridgeRecoveryStatus(state.bridgeId, 'failed', redis, 'No suitable bridge router');
      return false;
    }

    try {
      // Check current bridge status
      const bridgeStatus: BridgeStatusResult = await bridgeRouter.getStatus(state.bridgeId);

      if (bridgeStatus.status === 'completed') {
        // Bridge completed - execute sell
        this.logger.info('Recovered bridge is completed, executing sell', {
          bridgeId: state.bridgeId,
          amountReceived: bridgeStatus.amountReceived,
        });

        // Reconstruct opportunity for sell execution
        const sellOpportunity: ArbitrageOpportunity = {
          id: `${state.opportunityId}-recovery`,
          type: 'cross-chain',
          tokenIn: state.bridgeToken,
          tokenOut: state.tokenIn, // Reverse for sell
          amountIn: bridgeStatus.amountReceived || state.bridgeAmount,
          expectedProfit: state.expectedProfit,
          confidence: 0.5, // Lower confidence for recovery
          timestamp: Date.now(),
          buyChain: state.destChain,
          sellChain: state.destChain,
          buyDex: state.sellDex,
          sellDex: state.sellDex,
          expiresAt: Date.now() + 60000, // 1 minute to execute
        };

        // Execute sell on destination chain
        const destWallet = ctx.wallets.get(state.destChain);
        const destProvider = ctx.providers.get(state.destChain);

        if (!destWallet || !destProvider) {
          this.logger.warn('Cannot execute recovered sell - no wallet/provider', {
            bridgeId: state.bridgeId,
            destChain: state.destChain,
          });
          await this.updateBridgeRecoveryStatus(state.bridgeId, 'failed', redis, 'No wallet/provider for destination');
          return false;
        }

        // Prepare and execute sell transaction
        const sellTx = await this.prepareDexSwapTransaction(sellOpportunity, state.destChain, ctx);

        const signedTx = await destWallet.sendTransaction({
          ...sellTx,
          gasPrice: await destProvider.getFeeData().then(fd => fd.gasPrice),
        });

        const receipt = await signedTx.wait();

        if (receipt && receipt.status === 1) {
          this.logger.info('Recovery sell succeeded', {
            bridgeId: state.bridgeId,
            sellTxHash: receipt.hash,
          });
          await this.updateBridgeRecoveryStatus(state.bridgeId, 'recovered', redis);
          return true;
        } else {
          this.logger.error('Recovery sell failed', {
            bridgeId: state.bridgeId,
            sellTxHash: receipt?.hash,
          });
          await this.updateBridgeRecoveryStatus(state.bridgeId, 'failed', redis, 'Sell transaction reverted');
          return false;
        }
      } else if (bridgeStatus.status === 'failed' || bridgeStatus.status === 'refunded') {
        this.logger.info('Recovered bridge failed/refunded', {
          bridgeId: state.bridgeId,
          status: bridgeStatus.status,
          error: bridgeStatus.error,
        });
        await this.updateBridgeRecoveryStatus(state.bridgeId, 'failed', redis, bridgeStatus.error || bridgeStatus.status);
        return false;
      } else {
        // Still pending/bridging - update status and leave for next recovery attempt
        this.logger.info('Recovered bridge still in progress', {
          bridgeId: state.bridgeId,
          status: bridgeStatus.status,
        });
        await this.updateBridgeRecoveryStatus(
          state.bridgeId,
          bridgeStatus.status === 'bridging' ? 'bridging' : 'pending',
          redis
        );
        return false; // Will be retried on next recovery cycle
      }
    } catch (error) {
      this.logger.error('Bridge recovery failed', {
        bridgeId: state.bridgeId,
        error: getErrorMessage(error),
      });
      await this.updateBridgeRecoveryStatus(state.bridgeId, 'failed', redis, getErrorMessage(error));
      return false;
    }
  }
}

// Refactor 9.3: BridgePollingResult moved to ../types.ts for reusability
