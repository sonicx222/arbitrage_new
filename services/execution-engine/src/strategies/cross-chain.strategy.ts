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
import { getErrorMessage, BRIDGE_DEFAULTS, getDefaultPrice, hmacSign, hmacVerify, getHmacSigningKey, isSignedEnvelope } from '@arbitrage/core';
import type { BridgeStatusResult, SignedEnvelope } from '@arbitrage/core';
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

/**
 * FIX 10.4: Pre-computed bridge polling backoff schedule (performance optimization)
 *
 * Eliminates per-iteration calculations for polling interval.
 * Schedule defines polling intervals based on elapsed time.
 *
 * Format: [afterMs, intervalMs]
 * - afterMs: Apply this interval after X milliseconds have elapsed
 * - intervalMs: Poll every X milliseconds
 *
 * Schedule is checked in order, first match wins.
 */
const BRIDGE_POLL_BACKOFF_SCHEDULE = [
  { afterMs: 120000, intervalMs: 20000 },  // After 2min: poll every 20s
  { afterMs: 60000, intervalMs: 15000 },   // After 1min: poll every 15s
  { afterMs: 30000, intervalMs: 10000 },   // After 30s: poll every 10s
  { afterMs: 0, intervalMs: 5000 },        // First 30s: poll every 5s
] as const;

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

export class CrossChainStrategy extends BaseExecutionStrategy {
  // Phase 5.2: Optional flash loan provider factory for destination chain flash loans
  private readonly flashLoanProviderFactory?: FlashLoanProviderFactory;
  // Fix 7.2: Flash loan strategy instance for destination chain execution
  private readonly flashLoanStrategy?: FlashLoanStrategy;

  // Fix W2-6: Per-route bridge circuit breaker
  private readonly bridgeRouteBreakers = new Map<string, BridgeRouteCircuitBreaker>();

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
      if (priceUsd <= 0) return undefined;

      const decimals = getTokenDecimals(chain, '', tokenSymbol);
      const humanAmount = parseFloat(ethers.formatUnits(amountWei, decimals));

      if (!Number.isFinite(humanAmount) || humanAmount <= 0) return undefined;

      return humanAmount * priceUsd;
    } catch {
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
    this.logger.info(`[CROSS_CHAIN_AUDIT] ${phase}`, {
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

    // Fix W2-6: Check per-route circuit breaker before attempting bridge
    if (this.isBridgeRouteCooledDown(sourceChain, destChain, bridgeToken)) {
      this.logger.debug('Bridge route is in cooldown, skipping', {
        opportunityId: opportunity.id,
        route: this.bridgeRouteKey(sourceChain, destChain, bridgeToken),
      });
      return createErrorResult(
        opportunity.id,
        formatExecutionError(ExecutionErrorCode.BRIDGE_EXEC, 'Bridge route is in cooldown after consecutive failures'),
        sourceChain,
        opportunity.buyDex || 'unknown'
      );
    }

    // Estimate trade size in USD for bridge scoring (falls back to default $1000 if unavailable)
    const tradeSizeUsd = this.estimateTradeSizeUsd(opportunity.amountIn, opportunity.tokenIn, sourceChain);
    const bridgeRouter = ctx.bridgeRouterFactory.findSupportedRouter(sourceChain, destChain, bridgeToken, tradeSizeUsd);

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

      // Step 1: Validate bridge amount and get bridge quote
      if (!opportunity.amountIn || opportunity.amountIn === '0') {
        return createErrorResult(
          opportunity.id,
          formatExecutionError(ExecutionErrorCode.EXECUTION_ERROR, 'Invalid amountIn: must be non-zero for bridge quote'),
          sourceChain,
          opportunity.buyDex || 'unknown'
        );
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
        return createErrorResult(
          opportunity.id,
          formatExecutionError(ExecutionErrorCode.BRIDGE_QUOTE, `Invalid bridge gasFee format: ${bridgeQuote.gasFee}`),
          sourceChain,
          opportunity.buyDex || 'unknown'
        );
      }

      const bridgeProfitability = this.checkBridgeProfitability(
        gasFeeWei,
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

      // Task 4.2: Audit log — capture source chain balance BEFORE bridge
      const sourceBalanceBefore = await this.queryNativeBalance(sourceChain!, ctx);
      this.logCrossChainAudit('PRE_BRIDGE', opportunity.id, {
        sourceChain,
        destChain,
        sourceBalanceBefore,
        bridgeToken,
        bridgeAmount,
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

      // Task 4.2: Audit log — capture source chain balance AFTER bridge submission
      const sourceBalanceAfter = await this.queryNativeBalance(sourceChain!, ctx);
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
      const pollingResult = await this.pollBridgeCompletion(
        bridgeRouter,
        bridgeId,
        opportunity.id,
        sourceChain,
        bridgeResult.sourceTxHash || '',
        ctx
      );

      if (!pollingResult.completed) {
        // Fix W2-6: Record bridge failure for route circuit breaker
        this.recordBridgeRouteFailure(sourceChain, destChain, bridgeToken);

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

      // Task 4.2: Audit log — capture destination chain balance AFTER bridge completion
      const destBalanceAfterBridge = await this.queryNativeBalance(destChain!, ctx);
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
        await this.persistBridgeRecoveryState({
          bridgeId,
          opportunityId: opportunity.id,
          sourceChain,
          destChain: destChain!,
          bridgeToken,
          bridgeAmount: String(bridgeAmount),
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

      // Step 5: Validate destination chain context using helper (Fix 6.2 & 9.1)
      const destValidation = this.validateContext(destChain, ctx);
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

          // Fix W2-6: Record bridge route success
          this.recordBridgeRouteSuccess(sourceChain, destChain, bridgeToken);

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

      // CQ3: Standard DEX swap path delegated to private method
      const dexSellResult = await this.executeDirectDexSell(
        opportunity, sellOpportunity, bridgeToken, sellAmount,
        destChain, destWallet, destValidation, sellNonce, bridgeResult, ctx
      );

      if (dexSellResult.errorResult) {
        return dexSellResult.errorResult;
      }

      sellReceipt = dexSellResult.sellReceipt;
      sellTxHash = dexSellResult.sellTxHash;
      usedMevProtection = dexSellResult.usedMevProtection;

      // CQ3: Final profit calculation delegated to private method
      return await this.calculateCrossChainResults(
        opportunity, sourceChain, destChain, startTime, expectedProfit,
        bridgeFeeEth, bridgeFeeUsd, bridgeResult, sellReceipt, sellTxHash,
        usedDestFlashLoan, usedMevProtection, ctx
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
  private async executeDirectDexSell(
    opportunity: ArbitrageOpportunity,
    sellOpportunity: ArbitrageOpportunity,
    bridgeToken: string,
    sellAmount: string,
    destChain: string,
    destWallet: ethers.Wallet,
    destValidation: { valid: true; wallet: ethers.Wallet; provider: ethers.JsonRpcProvider },
    sellNonce: number | undefined,
    bridgeResult: { sourceTxHash?: string; gasUsed?: bigint },
    ctx: StrategyContext,
  ): Promise<{
    sellReceipt: ethers.TransactionReceipt | null;
    sellTxHash: string | undefined;
    usedMevProtection: boolean;
    errorResult?: ExecutionResult;
  }> {
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
  private async calculateCrossChainResults(
    opportunity: ArbitrageOpportunity,
    sourceChain: string,
    destChain: string,
    startTime: number,
    expectedProfit: number,
    bridgeFeeEth: number,
    bridgeFeeUsd: number,
    bridgeResult: { sourceTxHash?: string; gasUsed?: bigint },
    sellReceipt: ethers.TransactionReceipt | null,
    sellTxHash: string | undefined,
    usedDestFlashLoan: boolean,
    usedMevProtection: boolean,
    ctx: StrategyContext,
  ): Promise<ExecutionResult> {
    const executionTimeMs = Date.now() - startTime;

    const sourceGasPrice = await this.getOptimalGasPrice(sourceChain, ctx);
    const destGasPrice = await this.getOptimalGasPrice(destChain, ctx);

    let sourceNativeTokenPriceUsd = getNativeTokenPrice(sourceChain, { suppressWarning: true });
    let destNativeTokenPriceUsd = getNativeTokenPrice(destChain, { suppressWarning: true });

    const DEFAULT_NATIVE_TOKEN_PRICE_USD = 2000;
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

    const bridgeGasCostNative = bridgeResult.gasUsed
      ? parseFloat(ethers.formatEther(bridgeResult.gasUsed * sourceGasPrice))
      : 0;
    const bridgeGasCostUsd = bridgeGasCostNative * sourceNativeTokenPriceUsd;

    const sellGasCostNative = sellReceipt
      ? parseFloat(ethers.formatEther(sellReceipt.gasUsed * (sellReceipt.gasPrice || destGasPrice)))
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

      // FIX 10.4: Use pre-computed backoff schedule (eliminates per-iteration calculations)
      const elapsedMs = nowAfterFetch - bridgeStartTime;
      let dynamicPollInterval = pollInterval; // Default fallback

      // Find matching schedule entry (pre-computed, no calculations needed)
      for (const { afterMs, intervalMs } of BRIDGE_POLL_BACKOFF_SCHEDULE) {
        if (elapsedMs >= afterMs) {
          dynamicPollInterval = intervalMs;
          break;
        }
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
      // Fix #4: HMAC-sign recovery state to prevent tampering
      const signedEnvelope = hmacSign(state, getHmacSigningKey());
      await redis.set(key, signedEnvelope, ttlSeconds);
      this.logger.debug('Persisted bridge recovery state', {
        bridgeId: state.bridgeId,
        opportunityId: state.opportunityId,
        sourceChain: state.sourceChain,
        destChain: state.destChain,
        signed: !!signedEnvelope.sig,
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
      // Fix #4: Read and verify HMAC-signed envelope
      const signingKey = getHmacSigningKey();
      const raw = await redis.get(key);
      if (!raw || typeof raw !== 'object') {
        if (raw !== null) {
          this.logger.warn('Corrupt bridge recovery state, deleting key', {
            bridgeId,
            key,
          });
          await redis.del(key);
        }
        return;
      }

      // Handle both signed envelopes and legacy unsigned data
      let state: BridgeRecoveryState;
      if (isSignedEnvelope(raw)) {
        const verified = hmacVerify<BridgeRecoveryState>(raw as SignedEnvelope<BridgeRecoveryState>, signingKey);
        if (!verified) {
          this.logger.error('Bridge recovery state HMAC verification failed - possible tampering', {
            bridgeId,
            key,
          });
          return;
        }
        state = verified;
      } else {
        // Legacy unsigned data — accept but log warning
        state = raw as BridgeRecoveryState;
        if (signingKey) {
          this.logger.warn('Unsigned bridge recovery state found with signing enabled', {
            bridgeId,
          });
        }
      }

      state.status = status;
      state.lastCheckAt = Date.now();
      if (errorMessage) {
        state.errorMessage = errorMessage;
      }

      // Fix #4: Re-sign updated state
      const signedEnvelope = hmacSign(state, signingKey);

      // Keep same TTL for tracking purposes
      const ttlSeconds = Math.floor(BRIDGE_RECOVERY_MAX_AGE_MS / 1000);
      await redis.set(key, signedEnvelope, ttlSeconds);

      // If recovered or failed, we can delete the key (cleanup)
      if (status === 'recovered' || status === 'failed') {
        // Short TTL for post-processing analysis, then auto-cleanup
        await redis.set(key, signedEnvelope, 3600); // 1 hour
      }

      this.logger.debug('Updated bridge recovery status', {
        bridgeId,
        status,
        errorMessage,
        signed: !!signedEnvelope.sig,
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
          // FIX P0-1: redis.get() already returns parsed object — no JSON.parse needed
          // @see FIX P0-1 in docs/reports/EXECUTION_ENGINE_DEEP_ANALYSIS_2026-02-20.md
          const state = await redis.get(key) as BridgeRecoveryState | null;
          if (!state) continue;

          if (typeof state !== 'object') {
            // Corrupt data in Redis - clean up and continue
            this.logger.warn('Corrupt bridge recovery state during scan, deleting key', {
              key,
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

    // Estimate trade size from bridge amount (bridgeAmount is in bridgeToken units)
    const recoveryTradeSizeUsd = this.estimateTradeSizeUsd(
      state.bridgeAmount, state.bridgeToken, state.sourceChain
    );
    const bridgeRouter = ctx.bridgeRouterFactory.findSupportedRouter(
      state.sourceChain,
      state.destChain,
      state.bridgeToken,
      recoveryTradeSizeUsd
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

        const feeData = await destProvider.getFeeData();
        const gasOverrides: Record<string, bigint> = {};
        if (feeData.maxFeePerGas != null && feeData.maxPriorityFeePerGas != null) {
          gasOverrides.maxFeePerGas = feeData.maxFeePerGas;
          gasOverrides.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
        } else if (feeData.gasPrice != null) {
          gasOverrides.gasPrice = feeData.gasPrice;
        }

        const signedTx = await destWallet.sendTransaction({
          ...sellTx,
          ...gasOverrides,
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
