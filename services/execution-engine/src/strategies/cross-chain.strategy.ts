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
import { ARBITRAGE_CONFIG, getNativeTokenPrice, getTokenDecimals } from '@arbitrage/config';
import { getDefaultPrice } from '@arbitrage/core/analytics';
import { getErrorMessage } from '@arbitrage/core/resilience';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type { StrategyContext, ExecutionResult, Logger, BridgeRecoveryState } from '../types';
import {
  createErrorResult,
  createSuccessResult,
  ExecutionErrorCode,
  formatExecutionError,
} from '../types';
import { BaseExecutionStrategy } from './base.strategy';
import { pollBridgeCompletion } from './bridge-poll-manager';
import { BridgeRecoveryService } from './bridge-recovery-service';
// Phase 5.2: Flash loan support for destination chain
import type { FlashLoanProviderFactory } from './flash-loan-providers/provider-factory';
// Fix 7.2: Import FlashLoanStrategy for destination chain flash loan execution
import { FlashLoanStrategy } from './flash-loan.strategy';

/**
 * Fix W2-6: Per-route bridge circuit breaker configuration.
 * Tracks consecutive failures per source->dest->token route and skips
 * routes that have failed repeatedly within a cooldown window.
 */
interface BridgeRouteCircuitBreaker {
  /** Number of consecutive failures */
  failures: number;
  /** Timestamp when the route was cooled down (0 = not cooled) */
  cooledDownAt: number;
}

/** Default thresholds for bridge route circuit breaker */
const BRIDGE_ROUTE_CB_FAILURE_THRESHOLD = 3;
const BRIDGE_ROUTE_CB_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/** D3: Bridge router type derived from StrategyContext to avoid cross-package import issues. */
type CrossChainBridgeRouter = NonNullable<ReturnType<NonNullable<StrategyContext['bridgeRouterFactory']>['findSupportedRouter']>>;
/** D3: Bridge quote type derived from CrossChainBridgeRouter.quote() return. */
type CrossChainBridgeQuote = Awaited<ReturnType<CrossChainBridgeRouter['quote']>>;
/** D3: Bridge execute result type derived from CrossChainBridgeRouter.execute() return. */
type CrossChainBridgeExecResult = Awaited<ReturnType<CrossChainBridgeRouter['execute']>>;

/** CQ-5: Parameter object for executeBridgeAndPollCompletion (11 params → 1). */
interface BridgeExecutionParams {
  opportunity: ArbitrageOpportunity;
  bridgeRouter: CrossChainBridgeRouter;
  bridgeQuote: CrossChainBridgeQuote;
  bridgeToken: string;
  sourceChain: string;
  destChain: string;
  sourceWallet: ethers.Wallet;
  sourceProvider: ethers.JsonRpcProvider;
  bridgeNonce: number | undefined;
  expectedProfit: number;
  ctx: StrategyContext;
}

/** CQ-5: Parameter object for executeDirectDexSell (10 params → 1). */
interface DirectDexSellParams {
  opportunity: ArbitrageOpportunity;
  sellOpportunity: ArbitrageOpportunity;
  bridgeToken: string;
  sellAmount: string;
  destChain: string;
  destWallet: ethers.Wallet;
  destValidation: { valid: true; wallet: ethers.Wallet; provider: ethers.JsonRpcProvider };
  sellNonce: number | undefined;
  bridgeResult: { sourceTxHash?: string; gasUsed?: bigint };
  ctx: StrategyContext;
}

/** CQ-5: Parameter object for calculateCrossChainResults (13 params → 1). */
interface CrossChainResultParams {
  opportunity: ArbitrageOpportunity;
  sourceChain: string;
  destChain: string;
  startTime: number;
  expectedProfit: number;
  bridgeFeeEth: number;
  bridgeFeeUsd: number;
  bridgeResult: { sourceTxHash?: string; gasUsed?: bigint };
  sellReceipt: ethers.TransactionReceipt | null;
  sellTxHash: string | undefined;
  usedDestFlashLoan: boolean;
  usedMevProtection: boolean;
  ctx: StrategyContext;
}

export class CrossChainStrategy extends BaseExecutionStrategy {
  // Phase 5.2: Optional flash loan provider factory for destination chain flash loans
  private readonly flashLoanProviderFactory?: FlashLoanProviderFactory;
  // Fix 7.2: Flash loan strategy instance for destination chain execution
  private readonly flashLoanStrategy?: FlashLoanStrategy;

  // Fix W2-6: Per-route bridge circuit breaker
  private readonly bridgeRouteBreakers = new Map<string, BridgeRouteCircuitBreaker>();

  // CQ-8: Extracted bridge recovery logic
  private readonly bridgeRecovery: BridgeRecoveryService;

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
    this.bridgeRecovery = new BridgeRecoveryService(logger, {
      prepareDexSwapTransaction: (opp, chain, ctx) => this.prepareDexSwapTransaction(opp, chain, ctx),
      estimateTradeSizeUsd: (amount, token, chain) => this.estimateTradeSizeUsd(amount, token, chain),
    });
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
   * Estimate trade size in USD from a token amount (in wei) and token identity.
   *
   * Used for bridge route scoring instead of the default $1000 estimate.
   * getDefaultPrice provides a static fallback price (no async needed),
   * and getTokenDecimals resolves decimals by chain + symbol.
   *
   * Returns undefined when estimation isn't possible (unknown token, missing
   * data), letting the caller fall back to the default.
   *
   * @param amountWei - Token amount in wei (string)
   * @param tokenSymbol - Token symbol for price/decimal lookup (e.g., 'USDC', 'WETH')
   * @param chain - Chain name for decimal resolution
   */
  private estimateTradeSizeUsd(
    amountWei: string | undefined,
    tokenSymbol: string | undefined,
    chain: string,
  ): number | undefined {
    if (!amountWei || !tokenSymbol) return undefined;

    try {
      const priceUsd = getDefaultPrice(tokenSymbol);
      if (priceUsd <= 0) {
        // L-005 FIX: Log when token has no default price — helps identify
        // tokens that need pricing data for accurate bridge cost estimation.
        this.logger.debug('No default price for token — falling back to default trade size estimate', {
          tokenSymbol, chain,
        });
        return undefined;
      }

      const decimals = getTokenDecimals(chain, '', tokenSymbol);
      const humanAmount = parseFloat(ethers.formatUnits(amountWei, decimals));

      if (!Number.isFinite(humanAmount) || humanAmount <= 0) return undefined;

      return humanAmount * priceUsd;
    } catch (error) {
      this.logger.debug('estimateTradeSizeUsd: price estimation failed', { error, tokenSymbol, chain });
      return undefined;
    }
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
      return BaseExecutionStrategy.createOpportunityError(
        sellOpportunity,
        formatExecutionError(
          ExecutionErrorCode.NO_STRATEGY,
          'FlashLoanStrategy not configured for destination chain execution'
        ),
        destChain
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

      return BaseExecutionStrategy.createOpportunityError(
        sellOpportunity,
        formatExecutionError(
          ExecutionErrorCode.FLASH_LOAN_ERROR,
          `Destination flash loan failed: ${getErrorMessage(error)}`
        ),
        destChain
      );
    }
  }

  // =========================================================================
  // Task 4.2: Cross-Chain Execution Audit Logging
  // =========================================================================

  /**
   * Query native token balance for a wallet on a given chain.
   * Returns balance as a human-readable ETH string, or 'unavailable' on failure.
   * Non-blocking: errors are swallowed to avoid disrupting execution flow.
   */
  private async queryNativeBalance(
    chain: string,
    ctx: StrategyContext,
  ): Promise<string> {
    try {
      const provider = ctx.providers.get(chain);
      const wallet = ctx.wallets.get(chain);
      if (!provider || !wallet) return 'unavailable';
      const address = await wallet.getAddress();
      const balance = await provider.getBalance(address);
      return ethers.formatEther(balance);
    } catch {
      return 'unavailable';
    }
  }

  /**
   * Emit a structured audit log entry for cross-chain execution phases.
   * All audit entries use the same prefix for easy grep/filtering.
   */
  // ===========================================================================
  // Fix W2-6: Bridge Route Circuit Breaker
  // ===========================================================================

  /**
   * Build a route key for circuit breaker tracking.
   */
  private bridgeRouteKey(source: string, dest: string, token: string): string {
    return `${source}->${dest}:${token}`;
  }

  /**
   * Check if a bridge route is currently cooled down.
   * Returns true if the route should be skipped.
   */
  private isBridgeRouteCooledDown(source: string, dest: string, token: string): boolean {
    const key = this.bridgeRouteKey(source, dest, token);
    const breaker = this.bridgeRouteBreakers.get(key);
    if (!breaker || breaker.cooledDownAt === 0) return false;

    const elapsed = Date.now() - breaker.cooledDownAt;
    if (elapsed >= BRIDGE_ROUTE_CB_COOLDOWN_MS) {
      // Cooldown expired — reset breaker
      this.bridgeRouteBreakers.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Record a bridge failure for circuit breaker tracking.
   * If consecutive failures reach the threshold, the route enters cooldown.
   */
  private recordBridgeRouteFailure(source: string, dest: string, token: string): void {
    const key = this.bridgeRouteKey(source, dest, token);
    const breaker = this.bridgeRouteBreakers.get(key) ?? { failures: 0, cooledDownAt: 0 };

    breaker.failures++;

    if (breaker.failures >= BRIDGE_ROUTE_CB_FAILURE_THRESHOLD) {
      breaker.cooledDownAt = Date.now();
      this.logger.warn('Bridge route circuit breaker triggered — cooling down', {
        route: key,
        failures: breaker.failures,
        cooldownMs: BRIDGE_ROUTE_CB_COOLDOWN_MS,
      });
    }

    this.bridgeRouteBreakers.set(key, breaker);
  }

  /**
   * Record a bridge success, resetting the failure counter.
   */
  private recordBridgeRouteSuccess(source: string, dest: string, token: string): void {
    const key = this.bridgeRouteKey(source, dest, token);
    if (this.bridgeRouteBreakers.has(key)) {
      this.bridgeRouteBreakers.delete(key);
    }
  }

  private logCrossChainAudit(
    phase: string,
    opportunityId: string,
    data: Record<string, unknown>,
  ): void {
    this.logger.info('cross_chain_audit', {
      phase,
      opportunityId,
      ...data,
    });
  }

  async execute(
    opportunity: ArbitrageOpportunity,
    ctx: StrategyContext
  ): Promise<ExecutionResult> {
    const sourceChain = opportunity.buyChain;
    const destChain = opportunity.sellChain;
    const startTime = Date.now();

    // D3: Input validation + bridge router lookup
    const inputResult = this.validateCrossChainInputs(opportunity, sourceChain, destChain, ctx);
    if (inputResult.error) {
      return inputResult.error;
    }
    const { bridgeToken, bridgeRouter } = inputResult;

    this.logger.info('Starting cross-chain arbitrage execution', {
      opportunityId: opportunity.id,
      sourceChain,
      destChain,
      bridgeToken,
      bridgeProtocol: bridgeRouter.protocol,
      tokenIn: opportunity.tokenIn,
      tokenOut: opportunity.tokenOut,
    });

    // Declare outside try so outer catch can release on unexpected failure
    let bridgeNonce: number | undefined;

    try {
      // D3: Check for gas spike on source chain BEFORE getting bridge quote
      const gasSpikeError = await this.checkSourceChainGasSpike(opportunity, sourceChain!, ctx);
      if (gasSpikeError) {
        return gasSpikeError;
      }

      // D3: Pre-flight simulation for source chain buy transaction
      const sourceSimError = await this.simulateSwapStep(opportunity, sourceChain!, 'source buy', sourceChain!, ctx);
      if (sourceSimError) {
        return sourceSimError;
      }

      // D3: Get bridge quote, parse fees, validate profitability
      const quoteResult = await this.getBridgeQuoteAndValidateProfitability(
        opportunity, bridgeRouter, bridgeToken, sourceChain!, destChain!, ctx
      );
      if (quoteResult.error) {
        return quoteResult.error;
      }
      const { bridgeQuote, expectedProfit, bridgeFeeEth, bridgeFeeUsd } = quoteResult;

      // Step 2: Validate source chain context using helper (Fix 6.2 & 9.1)
      const sourceValidation = this.validateContext(sourceChain!, ctx);
      if (!sourceValidation.valid) {
        return BaseExecutionStrategy.createOpportunityError(
          opportunity,
          formatExecutionError(ExecutionErrorCode.NO_WALLET, sourceValidation.error),
          sourceChain!
        );
      }
      const { wallet: sourceWallet, provider: sourceProvider } = sourceValidation;

      // Fix 4.3: Get nonce for bridge transaction with proper error handling
      // If NonceManager is available but fails, we should abort rather than continue without a nonce
      // (which could cause transaction conflicts or unpredictable behavior)
      if (ctx.nonceManager) {
        try {
          bridgeNonce = await ctx.nonceManager.getNextNonce(sourceChain!);
        } catch (error) {
          const errorMessage = getErrorMessage(error);
          this.logger.error('Failed to get nonce for bridge transaction', {
            sourceChain,
            error: errorMessage,
          });
          // Fix 4.3: Return error instead of continuing with undefined nonce
          return BaseExecutionStrategy.createOpportunityError(
            opportunity,
            formatExecutionError(ExecutionErrorCode.NONCE_ERROR, `Failed to get nonce for bridge transaction: ${errorMessage}`),
            sourceChain!
          );
        }
      }

      // Validate quote expiry before execution
      if (Date.now() > bridgeQuote.expiresAt) {
        if (ctx.nonceManager && bridgeNonce !== undefined) {
          ctx.nonceManager.failTransaction(sourceChain!, bridgeNonce, 'Quote expired');
        }

        return BaseExecutionStrategy.createOpportunityError(
          opportunity,
          formatExecutionError(ExecutionErrorCode.QUOTE_EXPIRED, 'Bridge quote expired before execution'),
          sourceChain!
        );
      }

      // D3: Pre-flight simulation for destination sell transaction
      const destSimError = await this.simulateSwapStep(
        opportunity, destChain!, 'destination sell', sourceChain!, ctx,
        () => {
          if (ctx.nonceManager && bridgeNonce !== undefined) {
            ctx.nonceManager.failTransaction(sourceChain!, bridgeNonce, 'Simulation predicted revert on destination');
          }
        },
      );
      if (destSimError) {
        return destSimError;
      }

      // D3: Execute bridge, poll completion, persist recovery state
      const bridgeExecResult = await this.executeBridgeAndPollCompletion({
        opportunity, bridgeRouter, bridgeQuote, bridgeToken,
        sourceChain: sourceChain!, destChain: destChain!,
        sourceWallet, sourceProvider,
        bridgeNonce, expectedProfit, ctx,
      });
      if (bridgeExecResult.error) {
        return bridgeExecResult.error;
      }
      const { bridgeResult, bridgedAmountReceived } = bridgeExecResult;

      // Step 5: Validate destination chain context using helper (Fix 6.2 & 9.1)
      const destValidation = this.validateContext(destChain!, ctx);
      if (!destValidation.valid) {
        // Bridge succeeded but can't execute sell - funds are on dest chain
        // Recovery state already persisted above — BridgeRecoveryManager will handle
        this.logger.error('Cannot execute sell - no wallet/provider for destination chain', {
          opportunityId: opportunity.id,
          destChain,
          bridgeTxHash: bridgeResult.sourceTxHash,
          validationError: destValidation.error,
        });

        return createErrorResult(
          opportunity.id,
          formatExecutionError(ExecutionErrorCode.NO_WALLET, `${destValidation.error}. Funds bridged but sell not executed.`),
          destChain!,
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
          sellNonce = await ctx.nonceManager.getNextNonce(destChain!);
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

      // Execute sell transaction on destination chain
      // FE-001: Supports flash loan execution (atomic, capital-efficient) with fallback to direct DEX swap
      // @see docs/research/FUTURE_ENHANCEMENTS.md#FE-001

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
      const useDestFlashLoan = this.isDestinationFlashLoanSupported(destChain!);

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
        const flashLoanResult = await this.executeDestinationFlashLoan(sellOpportunity, destChain!, ctx);

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
          const sourceGasPrice = await this.getOptimalGasPrice(sourceChain!, ctx);
          const sourceNativeTokenPriceUsd = this.getValidatedNativeTokenPrice(sourceChain!);
          const bridgeGasCostNative = bridgeResult.gasUsed
            ? parseFloat(ethers.formatEther(bridgeResult.gasUsed * sourceGasPrice))
            : 0;
          const bridgeGasCostUsd = bridgeGasCostNative * sourceNativeTokenPriceUsd;

          // Combine bridge cost with flash loan result's gas cost
          const totalGasCostUsd = bridgeGasCostUsd + (flashLoanResult.gasCost ?? 0);

          // Flash loan result already includes profit calculation
          const actualProfitUsd = (flashLoanResult.actualProfit ?? 0) - bridgeGasCostUsd;

          // Fix W2-6: Record bridge route success
          this.recordBridgeRouteSuccess(sourceChain!, destChain!, bridgeToken);

          // Fix 7.2: Return success using correct createSuccessResult signature
          return createSuccessResult(
            opportunity.id,
            sellTxHash || bridgeResult.sourceTxHash || '',
            destChain!, // Report final chain where sell occurred
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

      // CQ3: Standard DEX swap path delegated to private method
      const dexSellResult = await this.executeDirectDexSell({
        opportunity, sellOpportunity, bridgeToken, sellAmount,
        destChain: destChain!, destWallet, destValidation, sellNonce, bridgeResult, ctx,
      });

      if (dexSellResult.errorResult) {
        return dexSellResult.errorResult;
      }

      sellReceipt = dexSellResult.sellReceipt;
      sellTxHash = dexSellResult.sellTxHash;
      usedMevProtection = dexSellResult.usedMevProtection;

      // CQ3: Final profit calculation delegated to private method
      return await this.calculateCrossChainResults({
        opportunity, sourceChain: sourceChain!, destChain: destChain!,
        startTime, expectedProfit, bridgeFeeEth, bridgeFeeUsd,
        bridgeResult, sellReceipt, sellTxHash,
        usedDestFlashLoan, usedMevProtection, ctx,
      });

    } catch (error) {
      // Release bridge nonce on unexpected failure to prevent nonce leaks
      if (ctx.nonceManager && bridgeNonce !== undefined) {
        ctx.nonceManager.failTransaction(sourceChain!, bridgeNonce, `Unexpected error: ${getErrorMessage(error)}`);
      }

      this.logger.error('Cross-chain arbitrage execution failed', {
        opportunityId: opportunity.id,
        sourceChain,
        destChain,
        error: getErrorMessage(error),
      });

      return BaseExecutionStrategy.createOpportunityError(
        opportunity,
        formatExecutionError(ExecutionErrorCode.EXECUTION_ERROR, `Cross-chain execution error: ${getErrorMessage(error)}`),
        sourceChain || 'unknown'
      );
    }
  }

  // ===========================================================================
  // D3: Extracted Sub-Methods for execute() Orchestrator
  // ===========================================================================

  /**
   * D3: Validate cross-chain inputs and resolve bridge router.
   *
   * Checks: source/dest chains present and distinct, bridge router factory available,
   * bridge token resolution, per-route circuit breaker, bridge router lookup.
   *
   * Returns the bridge router and token on success, or an error result.
   * No async operations — pure validation.
   */
  private validateCrossChainInputs(
    opportunity: ArbitrageOpportunity,
    sourceChain: string | undefined,
    destChain: string | undefined,
    ctx: StrategyContext,
  ): { bridgeToken: string; bridgeRouter: CrossChainBridgeRouter; error?: undefined } | { error: ExecutionResult; bridgeToken?: undefined; bridgeRouter?: undefined } {
    // FIX-6.1: Use ExecutionErrorCode enum for standardized error codes
    if (!sourceChain || !destChain) {
      return {
        error: BaseExecutionStrategy.createOpportunityError(
          opportunity,
          formatExecutionError(ExecutionErrorCode.NO_CHAIN, 'Missing source or destination chain'),
          sourceChain || 'unknown'
        ),
      };
    }

    if (sourceChain === destChain) {
      return {
        error: BaseExecutionStrategy.createOpportunityError(
          opportunity,
          formatExecutionError(ExecutionErrorCode.SAME_CHAIN, 'Cross-chain requires different chains'),
          sourceChain
        ),
      };
    }

    // Validate bridge router is available
    if (!ctx.bridgeRouterFactory) {
      return {
        error: BaseExecutionStrategy.createOpportunityError(
          opportunity,
          formatExecutionError(ExecutionErrorCode.NO_BRIDGE, 'Bridge router factory not initialized'),
          sourceChain
        ),
      };
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

    // Fix W2-6: Check per-route circuit breaker before attempting bridge
    if (this.isBridgeRouteCooledDown(sourceChain, destChain, bridgeToken)) {
      this.logger.debug('Bridge route is in cooldown, skipping', {
        opportunityId: opportunity.id,
        route: this.bridgeRouteKey(sourceChain, destChain, bridgeToken),
      });
      return {
        error: BaseExecutionStrategy.createOpportunityError(
          opportunity,
          formatExecutionError(ExecutionErrorCode.BRIDGE_EXEC, 'Bridge route is in cooldown after consecutive failures'),
          sourceChain
        ),
      };
    }

    // Estimate trade size in USD for bridge scoring (falls back to default $1000 if unavailable)
    const tradeSizeUsd = this.estimateTradeSizeUsd(opportunity.amountIn, opportunity.tokenIn, sourceChain);
    const bridgeRouter = ctx.bridgeRouterFactory.findSupportedRouter(sourceChain, destChain, bridgeToken, tradeSizeUsd);

    if (!bridgeRouter) {
      return {
        error: BaseExecutionStrategy.createOpportunityError(
          opportunity,
          formatExecutionError(
            ExecutionErrorCode.NO_ROUTE,
            `${sourceChain} -> ${destChain} for ${bridgeToken}`
          ),
          sourceChain
        ),
      };
    }

    return { bridgeToken, bridgeRouter };
  }

  /**
   * D3: Check for gas spike on source chain before getting bridge quote.
   *
   * Returns an error result if a gas price spike is detected, null otherwise.
   * Non-spike gas errors are logged and swallowed (fallback gas price will be used).
   */
  private async checkSourceChainGasSpike(
    opportunity: ArbitrageOpportunity,
    sourceChain: string,
    ctx: StrategyContext,
  ): Promise<ExecutionResult | null> {
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
        return BaseExecutionStrategy.createOpportunityError(
          opportunity,
          formatExecutionError(ExecutionErrorCode.GAS_SPIKE, `on ${sourceChain}: ${errorMessage}`),
          sourceChain
        );
      }
      // Non-spike error - log and continue (fallback gas price will be used)
      this.logger.debug('Gas price check failed, will use fallback', {
        error: errorMessage,
      });
    }
    return null;
  }

  /**
   * D3: Pre-flight simulation for a single swap step (source buy or destination sell).
   *
   * Simulates the transaction to catch issues early, preventing wasted bridge
   * API quota on opportunities that would fail.
   *
   * @param stepLabel - Human-readable label for logs ("source buy" or "destination sell")
   * @param errorChain - Chain reported in the error result
   * @param onRevert - Optional callback invoked when simulation predicts revert (e.g. nonce cleanup)
   * @returns Error result if simulation predicts revert, null otherwise.
   */
  private async simulateSwapStep(
    opportunity: ArbitrageOpportunity,
    chain: string,
    stepLabel: string,
    errorChain: string,
    ctx: StrategyContext,
    onRevert?: () => void,
  ): Promise<ExecutionResult | null> {
    const wallet = ctx.wallets.get(chain);
    if (wallet && ctx.providers.get(chain)) {
      try {
        const simTx = await this.prepareDexSwapTransaction(opportunity, chain, ctx);
        simTx.from = await wallet.getAddress();

        const simResult = await this.performSimulation(opportunity, simTx, chain, ctx);

        if (simResult?.wouldRevert) {
          ctx.stats.simulationPredictedReverts++;
          onRevert?.();

          this.logger.warn(`Aborting cross-chain execution: ${stepLabel} simulation predicted revert`, {
            opportunityId: opportunity.id,
            revertReason: simResult.revertReason,
            simulationLatencyMs: simResult.latencyMs,
            provider: simResult.provider,
            chain,
          });

          return BaseExecutionStrategy.createOpportunityError(
            opportunity,
            formatExecutionError(ExecutionErrorCode.SIMULATION_REVERT, `${stepLabel} simulation predicted revert - ${simResult.revertReason || 'unknown reason'}`),
            errorChain,
          );
        }
      } catch (simError) {
        this.logger.debug(`Could not prepare ${stepLabel} for simulation, proceeding`, {
          opportunityId: opportunity.id,
          error: getErrorMessage(simError),
        });
      }
    }
    return null;
  }

  /**
   * D3: Get bridge quote, parse gas fee, and validate profitability.
   *
   * Validates amountIn, requests a bridge quote, parses the gasFee into bigint,
   * and checks that the opportunity is still profitable after bridge fees.
   *
   * Returns the quote data on success, or an error result.
   */
  private async getBridgeQuoteAndValidateProfitability(
    opportunity: ArbitrageOpportunity,
    bridgeRouter: CrossChainBridgeRouter,
    bridgeToken: string,
    sourceChain: string,
    destChain: string,
    ctx: StrategyContext,
  ): Promise<
    | { bridgeQuote: CrossChainBridgeQuote; expectedProfit: number; bridgeFeeEth: number; bridgeFeeUsd: number; error?: undefined }
    | { error: ExecutionResult; bridgeQuote?: undefined; expectedProfit?: undefined; bridgeFeeEth?: undefined; bridgeFeeUsd?: undefined }
  > {
    // Step 1: Validate bridge amount and get bridge quote
    if (!opportunity.amountIn || opportunity.amountIn === '0') {
      return {
        error: BaseExecutionStrategy.createOpportunityError(
          opportunity,
          formatExecutionError(ExecutionErrorCode.EXECUTION_ERROR, 'Invalid amountIn: must be non-zero for bridge quote'),
          sourceChain
        ),
      };
    }
    const bridgeAmount = opportunity.amountIn;
    const bridgeQuote = await bridgeRouter.quote({
      sourceChain,
      destChain,
      token: bridgeToken,
      amount: bridgeAmount,
      slippage: ARBITRAGE_CONFIG.slippageTolerance,
    });

    if (!bridgeQuote.valid) {
      return {
        error: BaseExecutionStrategy.createOpportunityError(
          opportunity,
          formatExecutionError(ExecutionErrorCode.BRIDGE_QUOTE, bridgeQuote.error),
          sourceChain
        ),
      };
    }

    // Fix 9.3: Use extracted bridge profitability helper
    // Validate profit still viable after bridge fees
    // P1-002 FIX: Use chain-native token price, not ETH price for all chains.
    const nativeTokenPriceUsd = this.getValidatedNativeTokenPrice(sourceChain);
    // P0-001 FIX: Use ?? to preserve 0 as valid profit (|| treats 0 as falsy)
    const expectedProfit = opportunity.expectedProfit ?? 0;

    // Use gasFee for profitability check. gasFee is cleanly native-token denominated (wei).
    // totalFee === gasFee after the mixed-denomination fix (bridgeFee is already
    // deducted from amountOut and is in the bridged token's decimals).
    let gasFeeWei: bigint;
    try {
      const rawGasFee = bridgeQuote.gasFee;

      if (typeof rawGasFee === 'bigint') {
        gasFeeWei = rawGasFee;
      } else if (typeof rawGasFee === 'string') {
        if (rawGasFee.includes('.')) {
          const floatValue = parseFloat(rawGasFee);
          if (!Number.isFinite(floatValue)) {
            throw new Error(`Non-finite float value: ${rawGasFee}`);
          }
          gasFeeWei = BigInt(Math.floor(floatValue));
          this.logger.warn('[WARN_BRIDGE_FEE_FORMAT] Bridge gasFee was float string, truncated to integer', {
            opportunityId: opportunity.id,
            original: rawGasFee,
            converted: gasFeeWei.toString(),
          });
        } else {
          gasFeeWei = BigInt(rawGasFee);
        }
      } else if (typeof rawGasFee === 'number') {
        if (!Number.isFinite(rawGasFee)) {
          throw new Error(`Non-finite number value: ${rawGasFee}`);
        }
        gasFeeWei = BigInt(Math.floor(rawGasFee));
      } else {
        gasFeeWei = 0n;
      }
    } catch (error) {
      this.logger.error('Invalid bridge gasFee format', {
        opportunityId: opportunity.id,
        gasFee: bridgeQuote.gasFee,
        gasFeeType: typeof bridgeQuote.gasFee,
        error: getErrorMessage(error),
      });
      return {
        error: BaseExecutionStrategy.createOpportunityError(
          opportunity,
          formatExecutionError(ExecutionErrorCode.BRIDGE_QUOTE, `Invalid bridge gasFee format: ${bridgeQuote.gasFee}`),
          sourceChain
        ),
      };
    }

    const bridgeProfitability = this.checkBridgeProfitability(
      gasFeeWei,
      expectedProfit,
      nativeTokenPriceUsd,
      { chain: sourceChain }
    );

    if (!bridgeProfitability.isProfitable) {
      this.logger.warn('Cross-chain profit too low after bridge fees', {
        opportunityId: opportunity.id,
        bridgeFeeEth: bridgeProfitability.bridgeFeeEth,
        bridgeFeeUsd: bridgeProfitability.bridgeFeeUsd,
        nativeTokenPriceUsd,
        expectedProfit,
        feePercentage: bridgeProfitability.feePercentageOfProfit.toFixed(2),
      });

      return {
        error: BaseExecutionStrategy.createOpportunityError(
          opportunity,
          formatExecutionError(ExecutionErrorCode.HIGH_FEES, bridgeProfitability.reason),
          sourceChain
        ),
      };
    }

    return {
      bridgeQuote,
      expectedProfit,
      bridgeFeeEth: bridgeProfitability.bridgeFeeEth,
      bridgeFeeUsd: bridgeProfitability.bridgeFeeUsd,
    };
  }

  /**
   * D3: Execute bridge transaction, poll for completion, and persist recovery state.
   *
   * Handles: bridge execution with timeout, nonce confirmation/failure,
   * audit logging, bridge polling, amount received validation, and
   * recovery state persistence.
   *
   * Returns the bridge result and received amount on success, or an error result.
   */
  private async executeBridgeAndPollCompletion(params: BridgeExecutionParams): Promise<
    | { bridgeResult: CrossChainBridgeExecResult; bridgedAmountReceived: string; error?: undefined }
    | { error: ExecutionResult; bridgeResult?: undefined; bridgedAmountReceived?: undefined }
  > {
    const {
      opportunity, bridgeRouter, bridgeQuote, bridgeToken,
      sourceChain, destChain, sourceWallet, sourceProvider,
      bridgeNonce, expectedProfit, ctx,
    } = params;
    // Task 4.2: Audit log — capture source chain balance BEFORE bridge
    const sourceBalanceBefore = await this.queryNativeBalance(sourceChain, ctx);
    this.logCrossChainAudit('PRE_BRIDGE', opportunity.id, {
      sourceChain,
      destChain,
      sourceBalanceBefore,
      bridgeToken,
      bridgeAmount: opportunity.amountIn,
      bridgeProtocol: bridgeRouter.protocol,
      expectedProfit,
    });

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
      }),
      'bridgeExecution'
    );

    if (!bridgeResult.success) {
      if (ctx.nonceManager && bridgeNonce !== undefined) {
        ctx.nonceManager.failTransaction(sourceChain, bridgeNonce, bridgeResult.error || 'Bridge failed');
      }

      // Fix W2-6: Record bridge failure for route circuit breaker
      this.recordBridgeRouteFailure(sourceChain, destChain, bridgeToken);

      return {
        error: BaseExecutionStrategy.createOpportunityError(
          opportunity,
          formatExecutionError(ExecutionErrorCode.BRIDGE_EXEC, bridgeResult.error),
          sourceChain
        ),
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

    // Task 4.2: Audit log — capture source chain balance AFTER bridge submission
    const sourceBalanceAfter = await this.queryNativeBalance(sourceChain, ctx);
    this.logCrossChainAudit('POST_BRIDGE_SUBMIT', opportunity.id, {
      sourceChain,
      sourceTxHash: bridgeResult.sourceTxHash,
      bridgeId: bridgeResult.bridgeId,
      sourceBalanceBefore,
      sourceBalanceAfter,
      gasUsed: bridgeResult.gasUsed?.toString(),
    });

    // Step 4: Wait for bridge completion
    // Refactor 9.3: Extracted polling logic to separate method for readability
    const bridgeId = bridgeResult.bridgeId!;
    const pollingResult = await pollBridgeCompletion(
      bridgeRouter,
      bridgeId,
      opportunity.id,
      sourceChain,
      bridgeResult.sourceTxHash || '',
      ctx,
      this.logger,
    );

    if (!pollingResult.completed) {
      // Fix W2-6: Record bridge failure for route circuit breaker
      this.recordBridgeRouteFailure(sourceChain, destChain, bridgeToken);

      // Bridge failed or timed out — use optional chaining since type allows error?: undefined
      const errorCode = pollingResult.error?.code ?? ExecutionErrorCode.BRIDGE_FAILED;
      const errorMessage = pollingResult.error?.message ?? 'Bridge polling failed with no error details';
      const errorSourceTxHash = pollingResult.error?.sourceTxHash;

      return {
        error: BaseExecutionStrategy.createOpportunityError(
          opportunity,
          formatExecutionError(errorCode, errorMessage),
          sourceChain,
          errorSourceTxHash
        ),
      };
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
      return {
        error: BaseExecutionStrategy.createOpportunityError(
          opportunity,
          formatExecutionError(
            ExecutionErrorCode.BRIDGE_EXEC,
            'Bridge completed but amountReceived not reported - cannot proceed with sell'
          ),
          sourceChain,
          bridgeResult.sourceTxHash
        ),
      };
    }

    // Task 4.2: Audit log — capture destination chain balance AFTER bridge completion
    const destBalanceAfterBridge = await this.queryNativeBalance(destChain, ctx);
    this.logCrossChainAudit('BRIDGE_COMPLETED', opportunity.id, {
      sourceChain,
      destChain,
      sourceTxHash: bridgeResult.sourceTxHash,
      destTxHash: pollingResult.destTxHash,
      bridgedAmountReceived,
      destBalanceAfterBridge,
    });

    // Fix W2-6: Record bridge success — resets consecutive failure counter
    this.recordBridgeRouteSuccess(sourceChain, destChain, bridgeToken);

    // Fix #1: Persist bridge recovery state BEFORE sell attempt
    // If any subsequent step fails (dest validation, sell execution, etc.),
    // the BridgeRecoveryManager can detect and attempt recovery on restart.
    // @see docs/reports/SOLANA_BRIDGE_DEEP_ANALYSIS_2026-02-20.md P1 #1
    if (ctx.redis) {
      await this.bridgeRecovery.persistState({
        bridgeId,
        opportunityId: opportunity.id,
        sourceChain,
        destChain,
        bridgeToken,
        bridgeAmount: String(opportunity.amountIn),
        sourceTxHash: bridgeResult.sourceTxHash || '',
        sellDex: opportunity.sellDex || opportunity.buyDex || '',
        expectedProfit,
        tokenIn: opportunity.tokenIn || '',
        tokenOut: opportunity.tokenOut || '',
        initiatedAt: Date.now(),
        bridgeProtocol: bridgeRouter.protocol,
        status: 'bridge_completed_sell_pending',
        lastCheckAt: Date.now(),
      }, ctx.redis);
    }

    return { bridgeResult, bridgedAmountReceived };
  }

  // ===========================================================================
  // CQ3: Extracted Sub-Methods for execute() Readability
  // ===========================================================================

  /**
   * CQ3: Execute destination sell via standard DEX swap (non-flash-loan path).
   *
   * Handles: token approval, gas settings, provider health check, MEV protection,
   * transaction submission, and nonce management.
   *
   * No new try-catch blocks are added here; the caller's try-catch handles errors.
   * The sell transaction's try-catch is preserved as it was (for nonce cleanup).
   */
  private async executeDirectDexSell(params: DirectDexSellParams): Promise<{
    sellReceipt: ethers.TransactionReceipt | null;
    sellTxHash: string | undefined;
    usedMevProtection: boolean;
    errorResult?: ExecutionResult;
  }> {
    const {
      opportunity, sellOpportunity, bridgeToken, sellAmount,
      destChain, destWallet, destValidation, sellNonce, bridgeResult, ctx,
    } = params;
    let sellReceipt: ethers.TransactionReceipt | null = null;
    let sellTxHash: string | undefined;
    let usedMevProtection = false;

    const sellTx = await this.prepareDexSwapTransaction(sellOpportunity, destChain, ctx);

    // Ensure token approval for DEX router before swap
    if (bridgeToken && sellTx.to) {
      try {
        const amountToApprove = BigInt(sellAmount);
        const approvalNeeded = await this.ensureTokenAllowance(
          bridgeToken,
          sellTx.to as string,
          amountToApprove,
          destChain,
          ctx
        );
        if (approvalNeeded) {
          this.logger.info('Token approval granted for destination sell', {
            opportunityId: opportunity.id,
            token: bridgeToken,
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
      }
    }

    // Apply gas settings for destination chain
    const destGasPrice = await this.getOptimalGasPrice(destChain, ctx);
    if (sellNonce !== undefined) {
      sellTx.nonce = sellNonce;
    }

    // Verify destination provider health before sending sell transaction
    const destProvider = ctx.providers.get(destChain);
    if (destProvider) {
      const isDestProviderHealthy = await this.isProviderHealthy(destProvider, destChain, ctx);
      if (!isDestProviderHealthy) {
        if (ctx.nonceManager && sellNonce !== undefined) {
          ctx.nonceManager.failTransaction(destChain, sellNonce, 'Provider unhealthy');
        }

        this.logger.error('Destination provider unhealthy after bridge - sell not attempted', {
          opportunityId: opportunity.id,
          destChain,
          bridgeTxHash: bridgeResult.sourceTxHash,
        });

        return {
          sellReceipt: null,
          sellTxHash: undefined,
          usedMevProtection: false,
          errorResult: createErrorResult(
            opportunity.id,
            formatExecutionError(
              ExecutionErrorCode.NO_PROVIDER,
              `Destination provider (${destChain}) unhealthy after bridge. Funds bridged but sell not executed.`
            ),
            destChain,
            opportunity.sellDex || 'unknown',
            bridgeResult.sourceTxHash
          ),
        };
      }
    }

    // Apply MEV protection to destination sell transaction
    const protectedSellTx = await this.applyMEVProtection(sellTx, destChain, ctx);

    try {
      const { shouldUseMev, mevProvider, chainSettings } = this.checkMevEligibility(
        destChain,
        ctx,
        opportunity.expectedProfit
      );

      if (shouldUseMev && mevProvider) {
        this.logger.info('Using MEV protection for destination sell', {
          opportunityId: opportunity.id,
          destChain,
          strategy: mevProvider.strategy,
        });

        const mevResult = await this.withTransactionTimeout(
          () => mevProvider.sendProtectedTransaction(protectedSellTx, {
            simulate: false,
            priorityFeeGwei: chainSettings?.priorityFeeGwei,
          }),
          'mevProtectedDestinationSell'
        );

        if (!mevResult.success) {
          throw new Error(`MEV protected submission failed: ${mevResult.error}`);
        }

        sellTxHash = mevResult.transactionHash;
        usedMevProtection = true;

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

      // Task 4.2: Audit log — destination balance AFTER sell execution
      const destBalanceAfterSell = await this.queryNativeBalance(destChain, ctx);
      this.logCrossChainAudit('POST_SELL', opportunity.id, {
        destChain,
        sellTxHash,
        destBalanceAfterSell,
        sellGasUsed: sellReceipt?.gasUsed?.toString(),
        usedMevProtection,
      });
    } catch (sellError) {
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

      return {
        sellReceipt: null,
        sellTxHash: undefined,
        usedMevProtection,
        errorResult: createErrorResult(
          opportunity.id,
          formatExecutionError(ExecutionErrorCode.SELL_FAILED, `Bridge succeeded but sell failed: ${getErrorMessage(sellError)}`),
          destChain,
          opportunity.sellDex || 'unknown',
          bridgeResult.sourceTxHash
        ),
      };
    }

    return { sellReceipt, sellTxHash, usedMevProtection };
  }

  /**
   * CQ3: Calculate final cross-chain arbitrage results (gas costs, profit).
   *
   * Extracted from execute() to reduce method length.
   * No new try-catch — caller's catch block handles errors.
   */
  private async calculateCrossChainResults(params: CrossChainResultParams): Promise<ExecutionResult> {
    const {
      opportunity, sourceChain, destChain, startTime, expectedProfit,
      bridgeFeeEth, bridgeFeeUsd, bridgeResult, sellReceipt, sellTxHash,
      usedDestFlashLoan, usedMevProtection, ctx,
    } = params;
    const executionTimeMs = Date.now() - startTime;

    const sourceGasPrice = await this.getOptimalGasPrice(sourceChain, ctx);
    const destGasPrice = await this.getOptimalGasPrice(destChain, ctx);

    const sourceNativeTokenPriceUsd = this.getValidatedNativeTokenPrice(sourceChain, { opportunityId: opportunity.id, label: 'source' });
    const destNativeTokenPriceUsd = this.getValidatedNativeTokenPrice(destChain, { opportunityId: opportunity.id, label: 'dest' });

    const bridgeGasCostNative = bridgeResult.gasUsed
      ? parseFloat(ethers.formatEther(bridgeResult.gasUsed * sourceGasPrice))
      : 0;
    const bridgeGasCostUsd = bridgeGasCostNative * sourceNativeTokenPriceUsd;

    const sellGasCostNative = sellReceipt
      ? parseFloat(ethers.formatEther(sellReceipt.gasUsed * (sellReceipt.gasPrice ?? destGasPrice)))
      : 0;
    const sellGasCostUsd = sellGasCostNative * destNativeTokenPriceUsd;

    const totalGasCostUsd = bridgeGasCostUsd + sellGasCostUsd;
    const actualProfit = expectedProfit - bridgeFeeUsd - totalGasCostUsd;

    // Task 4.2: Audit log — final execution summary with profit breakdown
    this.logCrossChainAudit('EXECUTION_COMPLETE', opportunity.id, {
      sourceChain,
      destChain,
      sourceTxHash: bridgeResult.sourceTxHash,
      sellTxHash,
      bridgeFeeEth,
      bridgeFeeUsd,
      bridgeGasCostUsd,
      sellGasCostUsd,
      totalGasCostUsd,
      expectedProfit,
      actualProfit,
      executionTimeMs,
      sellExecutionMethod: usedDestFlashLoan ? 'flash_loan' : 'direct_swap',
      usedMevProtection,
    });

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
      usedDestFlashLoan,
      usedMevProtection,
      sellExecutionMethod: usedDestFlashLoan ? 'flash_loan' : 'direct_swap',
    });

    // Fix W2-6: Record bridge route success
    this.recordBridgeRouteSuccess(sourceChain, destChain, opportunity.tokenOut || 'USDC');

    return createSuccessResult(
      opportunity.id,
      sellTxHash || bridgeResult.sourceTxHash || '',
      destChain,
      opportunity.sellDex || 'unknown',
      {
        actualProfit,
        gasUsed: sellReceipt ? Number(sellReceipt.gasUsed) : (bridgeResult.gasUsed ? Number(bridgeResult.gasUsed) : undefined),
        gasCost: totalGasCostUsd,
      }
    );
  }

  // ===========================================================================
  // CQ-8: Bridge Recovery & Polling — delegated to extracted modules
  // @see bridge-poll-manager.ts, bridge-recovery-service.ts
  // ===========================================================================

  /** Public API preserved for tests and BridgeRecoveryManager. */
  async persistBridgeRecoveryState(
    state: BridgeRecoveryState,
    redis: import('@arbitrage/core').RedisClient,
  ): Promise<void> {
    return this.bridgeRecovery.persistState(state, redis);
  }

  /** Public API preserved for tests and BridgeRecoveryManager. */
  async updateBridgeRecoveryStatus(
    bridgeId: string,
    status: BridgeRecoveryState['status'],
    redis: import('@arbitrage/core').RedisClient,
    errorMessage?: string,
  ): Promise<void> {
    return this.bridgeRecovery.updateStatus(bridgeId, status, redis, errorMessage);
  }

  /** Public API preserved for tests and BridgeRecoveryManager. */
  async recoverPendingBridges(
    ctx: StrategyContext,
    redis: import('@arbitrage/core').RedisClient,
  ): Promise<number> {
    return this.bridgeRecovery.recoverPendingBridges(ctx, redis);
  }

}
