/**
 * Flash Loan Strategy
 *
 * Executes arbitrage opportunities using flash loans via the FlashLoanArbitrage
 * smart contract deployed in Task 3.1.1.
 *
 * Features:
 * - Integration with FlashLoanArbitrage.sol contract
 * - Flash loan fee calculation (Aave V3: 0.09%)
 * - Profitability analysis (flash loan vs direct execution)
 * - Multi-hop swap path building
 * - Pre-flight simulation support
 * - MEV protection integration
 *
 * ## Architecture Note (Finding 9.1)
 *
 * Flash loan logic intentionally exists in TWO locations:
 *
 * 1. **FlashLoanArbitrage.sol** (on-chain contract):
 *    - Receives Aave V3 flash loan callback (`executeOperation`)
 *    - Executes swap path on-chain
 *    - Validates profit and repays loan
 *    - Contains immutable, audited execution logic
 *
 * 2. **flash-loan.strategy.ts** (this file, off-chain strategy):
 *    - Builds transaction calldata for contract
 *    - Performs pre-execution profitability analysis
 *    - Estimates gas costs
 *    - Applies MEV protection
 *    - Handles wallet/nonce management
 *    - Provides simulation support
 *
 * This separation follows the Strategy Pattern where on-chain and off-chain
 * concerns are cleanly divided. The contract handles trustless execution,
 * while the strategy handles optimization and user-facing logic.
 *
 * @see implementation_plan_v2.md Task 3.1.2
 * @see contracts/src/FlashLoanArbitrage.sol
 */

import { ethers } from 'ethers';
import { ARBITRAGE_CONFIG, FLASH_LOAN_PROVIDERS, MEV_CONFIG, DEXES, getNativeTokenPrice, getTokenDecimals } from '@arbitrage/config';
import { getErrorMessage } from '@arbitrage/core';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type { StrategyContext, ExecutionResult, Logger } from '../types';
import { createErrorResult, createSuccessResult } from '../types';
import { BaseExecutionStrategy } from './base.strategy';

// =============================================================================
// Constants
// =============================================================================

/**
 * Aave V3 flash loan fee in basis points (0.09% = 9 bps)
 */
const AAVE_V3_FEE_BPS = 9n;

/**
 * Basis points denominator (10000 = 100%)
 */
const BPS_DENOMINATOR = 10000n;

/**
 * Default gas estimate for flash loan arbitrage (conservative)
 */
const DEFAULT_GAS_ESTIMATE = 500000n;

/**
 * Pre-computed slippage multiplier for minAmountOut calculation
 */
const DEFAULT_SLIPPAGE_BPS = BigInt(Math.floor(ARBITRAGE_CONFIG.slippageTolerance * 10000));

/**
 * Supported flash loan protocols by this strategy.
 * Only Aave V3 is currently implemented. Other protocols require different
 * callback interfaces and contract implementations.
 */
const SUPPORTED_FLASH_LOAN_PROTOCOLS = new Set(['aave_v3']);

/**
 * Chains that support Aave V3 flash loans (pre-computed for O(1) lookup)
 */
const AAVE_V3_SUPPORTED_CHAINS = new Set(
  Object.entries(FLASH_LOAN_PROVIDERS)
    .filter(([_, config]) => config.protocol === 'aave_v3')
    .map(([chain]) => chain)
);

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for FlashLoanStrategy
 *
 * Note: Aave Pool addresses are read from FLASH_LOAN_PROVIDERS[@arbitrage/config].
 * No need to specify them here - they are auto-discovered per chain.
 */
export interface FlashLoanStrategyConfig {
  /** FlashLoanArbitrage contract addresses per chain */
  contractAddresses: Record<string, string>;
  /** Approved DEX routers per chain */
  approvedRouters: Record<string, string[]>;
  /** Custom flash loan fee overrides (basis points) */
  feeOverrides?: Record<string, number>;
}

/**
 * Swap step structure matching FlashLoanArbitrage.SwapStep
 */
export interface SwapStep {
  router: string;
  tokenIn: string;
  tokenOut: string;
  amountOutMin: bigint;
}

/**
 * Parameters for building swap steps
 */
export interface SwapStepsParams {
  buyRouter: string;
  sellRouter: string;
  intermediateToken: string;
  slippageBps?: number;
  /** Chain identifier for token decimals lookup (required for precision) */
  chain: string;
}

/**
 * Parameters for executeArbitrage calldata
 */
export interface ExecuteArbitrageParams {
  asset: string;
  amount: bigint;
  swapPath: SwapStep[];
  minProfit: bigint;
}

/**
 * Parameters for profitability analysis
 */
export interface ProfitabilityParams {
  expectedProfitUsd: number;
  flashLoanAmountWei: bigint;
  estimatedGasUnits: bigint;
  gasPriceWei: bigint;
  chain: string;
  ethPriceUsd: number;
  userCapitalWei?: bigint;
}

/**
 * Result of profitability analysis
 */
export interface ProfitabilityAnalysis {
  isProfitable: boolean;
  netProfitUsd: number;
  flashLoanFeeUsd: number;
  gasCostUsd: number;
  flashLoanNetProfit: number;
  directExecutionNetProfit: number;
  recommendation: 'flash-loan' | 'direct' | 'skip';
  breakdown: {
    expectedProfit: number;
    flashLoanFee: number;
    gasCost: number;
    totalCosts: number;
  };
}

// =============================================================================
// ABI
// =============================================================================

/**
 * FlashLoanArbitrage contract ABI (minimal for execution)
 *
 * ## Return Value Documentation (Fix 2.2)
 *
 * ### calculateExpectedProfit
 * Returns `(uint256 expectedProfit, uint256 flashLoanFee)`:
 * - `expectedProfit`: The expected profit in the flash-loaned asset's units (wei).
 *   Returns 0 if the swap path is invalid, the router call fails, or the
 *   final token doesn't match the starting asset.
 * - `flashLoanFee`: The flash loan fee (Aave V3: 0.09% of loan amount).
 *
 * When `expectedProfit` is 0, check these common causes:
 * 1. Invalid swap path (tokenIn/tokenOut mismatch)
 * 2. Router's getAmountsOut() call failed (pair doesn't exist, low liquidity)
 * 3. Final token doesn't match the starting asset (path doesn't loop back)
 * 4. Expected output is less than loan repayment amount (unprofitable)
 *
 * @see FlashLoanArbitrage.sol calculateExpectedProfit()
 */
const FLASH_LOAN_ARBITRAGE_ABI = [
  'function executeArbitrage(address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath, uint256 minProfit) external',
  'function calculateExpectedProfit(address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath) external view returns (uint256 expectedProfit, uint256 flashLoanFee)',
  'function isApprovedRouter(address router) external view returns (bool)',
  'function POOL() external view returns (address)',
];

/**
 * Cached ethers.Interface for hot-path optimization.
 * Creating Interface objects is expensive - cache at module level.
 * Issue 10.2 Fix: Avoid repeated instantiation on every calldata build.
 */
const FLASH_LOAN_INTERFACE = new ethers.Interface(FLASH_LOAN_ARBITRAGE_ABI);

// =============================================================================
// FlashLoanStrategy
// =============================================================================

/**
 * Strategy for executing arbitrage via flash loans.
 *
 * Uses the FlashLoanArbitrage smart contract to:
 * 1. Borrow tokens via Aave V3 flash loan
 * 2. Execute multi-hop swaps across DEXes
 * 3. Verify profit and repay flash loan
 *
 * @see contracts/src/FlashLoanArbitrage.sol
 */
export class FlashLoanStrategy extends BaseExecutionStrategy {
  private readonly config: FlashLoanStrategyConfig;

  constructor(logger: Logger, config: FlashLoanStrategyConfig) {
    super(logger);

    // Validate config
    if (Object.keys(config.contractAddresses).length === 0) {
      throw new Error('[ERR_CONFIG] At least one contract address must be configured');
    }

    // Fix 3.2: Validate contract addresses are valid Ethereum addresses
    for (const [chain, address] of Object.entries(config.contractAddresses)) {
      if (!ethers.isAddress(address)) {
        throw new Error(`[ERR_CONFIG] Invalid contract address for chain '${chain}': ${address}`);
      }
      // Warn if address looks like a placeholder or test address
      if (address === '0x0000000000000000000000000000000000000000') {
        logger.warn('[WARN_CONFIG] Contract address is zero address - likely misconfigured', { chain });
      }
    }

    // Validate approved routers are valid addresses
    for (const [chain, routers] of Object.entries(config.approvedRouters)) {
      for (const router of routers) {
        if (!ethers.isAddress(router)) {
          throw new Error(`[ERR_CONFIG] Invalid router address for chain '${chain}': ${router}`);
        }
      }
    }

    this.config = config;
  }

  // ===========================================================================
  // Main Execution
  // ===========================================================================

  /**
   * Execute flash loan arbitrage opportunity.
   */
  async execute(
    opportunity: ArbitrageOpportunity,
    ctx: StrategyContext
  ): Promise<ExecutionResult> {
    const chain = opportunity.buyChain;
    if (!chain) {
      return createErrorResult(
        opportunity.id,
        '[ERR_NO_CHAIN] No chain specified for opportunity',
        'unknown',
        opportunity.buyDex || 'unknown'
      );
    }

    // Issue 4.1 Fix: Validate protocol support before execution
    // Only Aave V3 chains are currently supported
    if (!this.isProtocolSupported(chain)) {
      const flashLoanConfig = FLASH_LOAN_PROVIDERS[chain];
      const protocol = flashLoanConfig?.protocol || 'unknown';
      this.logger.warn('Unsupported flash loan protocol for chain', {
        chain,
        protocol,
        supportedProtocols: Array.from(SUPPORTED_FLASH_LOAN_PROTOCOLS),
      });
      return createErrorResult(
        opportunity.id,
        `[ERR_UNSUPPORTED_PROTOCOL] Flash loan protocol '${protocol}' on chain '${chain}' is not supported. Only Aave V3 chains are currently implemented.`,
        chain,
        opportunity.buyDex || 'unknown'
      );
    }

    // Verify wallet exists
    const wallet = ctx.wallets.get(chain);
    if (!wallet) {
      return createErrorResult(
        opportunity.id,
        `[ERR_NO_WALLET] No wallet available for chain: ${chain}`,
        chain,
        opportunity.buyDex || 'unknown'
      );
    }

    // Verify provider exists
    const provider = ctx.providers.get(chain);
    if (!provider) {
      return createErrorResult(
        opportunity.id,
        `[ERR_NO_PROVIDER] No provider available for chain: ${chain}`,
        chain,
        opportunity.buyDex || 'unknown'
      );
    }

    // Validate opportunity fields
    if (!opportunity.tokenIn || !opportunity.amountIn || !opportunity.tokenOut) {
      return createErrorResult(
        opportunity.id,
        '[ERR_INVALID_OPPORTUNITY] Invalid opportunity: missing required fields (tokenIn, amountIn, tokenOut)',
        chain,
        opportunity.buyDex || 'unknown'
      );
    }

    // Validate amount is non-zero
    const amountIn = BigInt(opportunity.amountIn);
    if (amountIn === 0n) {
      return createErrorResult(
        opportunity.id,
        '[ERR_ZERO_AMOUNT] Invalid opportunity: amountIn is zero',
        chain,
        opportunity.buyDex || 'unknown'
      );
    }

    try {
      // Finding 10.3 Fix: Parallelize independent operations for latency reduction
      // getOptimalGasPrice and verifyOpportunityPrices don't depend on each other
      const [gasPrice, priceVerification] = await Promise.all([
        this.getOptimalGasPrice(chain, ctx),
        this.verifyOpportunityPrices(opportunity, chain),
      ]);

      if (!priceVerification.valid) {
        this.logger.warn('Price verification failed, aborting execution', {
          opportunityId: opportunity.id,
          reason: priceVerification.reason,
        });

        return createErrorResult(
          opportunity.id,
          `[ERR_PRICE_VERIFICATION] Price verification failed: ${priceVerification.reason}`,
          chain,
          opportunity.buyDex || 'unknown'
        );
      }

      // Issue 10.3 Fix: Prepare transaction once and reuse for gas estimation
      // This eliminates the double transaction preparation
      const flashLoanTx = await this.prepareFlashLoanContractTransaction(
        opportunity,
        chain,
        ctx
      );

      // Estimate gas using the prepared transaction
      const estimatedGas = await this.estimateGasFromTransaction(flashLoanTx, chain, ctx);

      // Issue 6.2 Fix: Use getNativeTokenPrice() for accurate ETH/native token price
      // The previous code incorrectly used opportunity.buyPrice (token price, not ETH)
      const nativeTokenPriceUsd = getNativeTokenPrice(chain, { suppressWarning: true });

      // Analyze profitability (flash loan vs direct, accounting for fees)
      const profitAnalysis = this.analyzeProfitability({
        expectedProfitUsd: opportunity.expectedProfit || 0,
        flashLoanAmountWei: amountIn,
        estimatedGasUnits: estimatedGas,
        gasPriceWei: gasPrice,
        chain,
        ethPriceUsd: nativeTokenPriceUsd,
      });

      if (!profitAnalysis.isProfitable) {
        this.logger.warn('Opportunity unprofitable after fee calculation', {
          opportunityId: opportunity.id,
          netProfitUsd: profitAnalysis.netProfitUsd,
          breakdown: profitAnalysis.breakdown,
        });

        return createErrorResult(
          opportunity.id,
          `[ERR_UNPROFITABLE] Opportunity unprofitable after fees: net ${profitAnalysis.netProfitUsd.toFixed(2)} USD`,
          chain,
          opportunity.buyDex || 'unknown'
        );
      }

      // Transaction already prepared above (Issue 10.3 fix)

      // Pre-flight simulation
      const simulationResult = await this.performSimulation(
        opportunity,
        flashLoanTx,
        chain,
        ctx
      );

      if (simulationResult?.wouldRevert) {
        ctx.stats.simulationPredictedReverts++;
        this.logger.warn('Aborting execution: simulation predicted revert', {
          opportunityId: opportunity.id,
          revertReason: simulationResult.revertReason,
          simulationLatencyMs: simulationResult.latencyMs,
        });

        return createErrorResult(
          opportunity.id,
          `[ERR_SIMULATION_REVERT] Aborted: simulation predicted revert - ${simulationResult.revertReason || 'unknown reason'}`,
          chain,
          opportunity.buyDex || 'unknown'
        );
      }

      // Apply MEV protection
      const protectedTx = await this.applyMEVProtection(flashLoanTx, chain, ctx);

      // Get nonce from NonceManager
      let nonce: number | undefined;
      if (ctx.nonceManager) {
        try {
          nonce = await ctx.nonceManager.getNextNonce(chain);
          protectedTx.nonce = nonce;
          this.logger.debug('Nonce allocated from NonceManager', { chain, nonce });
        } catch (error) {
          this.logger.error('Failed to get nonce from NonceManager', {
            chain,
            error: getErrorMessage(error),
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
          // Use MEV provider for protected submission
          this.logger.info('Using MEV protected submission for flash loan', {
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

          // Get receipt
          if (txHash && provider) {
            receipt = await this.withTransactionTimeout(
              () => provider.getTransactionReceipt(txHash!),
              'getReceipt'
            );
          }

          this.logger.info('Flash loan MEV transaction successful', {
            chain,
            strategy: mevResult.strategy,
            txHash,
            usedFallback: mevResult.usedFallback,
            latencyMs: mevResult.latencyMs,
          });
        } else {
          // Standard transaction submission
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

        // Confirm nonce
        if (ctx.nonceManager && nonce !== undefined) {
          ctx.nonceManager.confirmTransaction(chain, nonce, receipt.hash);
        }

        // Calculate actual profit
        const actualProfit = await this.calculateActualProfit(receipt, opportunity);

        this.logger.info('Flash loan arbitrage executed successfully', {
          opportunityId: opportunity.id,
          txHash: receipt.hash,
          actualProfit,
          gasUsed: Number(receipt.gasUsed),
          chain,
        });

        return createSuccessResult(
          opportunity.id,
          receipt.hash,
          chain,
          opportunity.buyDex || 'unknown',
          {
            actualProfit,
            gasUsed: Number(receipt.gasUsed),
            gasCost: parseFloat(ethers.formatEther(receipt.gasUsed * (receipt.gasPrice || gasPrice))),
          }
        );
      } catch (error) {
        // Mark transaction as failed in NonceManager
        if (ctx.nonceManager && nonce !== undefined) {
          ctx.nonceManager.failTransaction(chain, nonce, getErrorMessage(error));
        }
        throw error;
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);

      this.logger.error('Flash loan arbitrage execution failed', {
        opportunityId: opportunity.id,
        chain,
        error: errorMessage,
      });

      return createErrorResult(
        opportunity.id,
        errorMessage || 'Unknown error during flash loan execution',
        chain,
        opportunity.buyDex || 'unknown'
      );
    }
  }

  // ===========================================================================
  // Flash Loan Fee Calculation
  // ===========================================================================

  /**
   * Calculate flash loan fee for a given amount.
   *
   * @param amount - Flash loan amount in wei
   * @param chain - Chain identifier
   * @returns Fee amount in wei
   */
  calculateFlashLoanFee(amount: bigint, chain: string): bigint {
    // Check for custom fee override
    const feeOverride = this.config.feeOverrides?.[chain];
    if (feeOverride !== undefined) {
      return (amount * BigInt(feeOverride)) / BPS_DENOMINATOR;
    }

    // Use chain-specific fee from FLASH_LOAN_PROVIDERS config
    const flashLoanConfig = FLASH_LOAN_PROVIDERS[chain];
    if (flashLoanConfig) {
      return (amount * BigInt(flashLoanConfig.fee)) / BPS_DENOMINATOR;
    }

    // Default to Aave V3 fee (0.09%)
    return (amount * AAVE_V3_FEE_BPS) / BPS_DENOMINATOR;
  }

  // ===========================================================================
  // Profitability Analysis
  // ===========================================================================

  /**
   * Analyze profitability of flash loan vs direct execution.
   *
   * @param params - Profitability parameters
   * @returns Profitability analysis result
   */
  analyzeProfitability(params: ProfitabilityParams): ProfitabilityAnalysis {
    const {
      expectedProfitUsd,
      flashLoanAmountWei,
      estimatedGasUnits,
      gasPriceWei,
      chain,
      ethPriceUsd,
      userCapitalWei,
    } = params;

    // Calculate flash loan fee in wei, then USD
    const flashLoanFeeWei = this.calculateFlashLoanFee(flashLoanAmountWei, chain);
    const flashLoanFeeEth = parseFloat(ethers.formatEther(flashLoanFeeWei));
    const flashLoanFeeUsd = flashLoanFeeEth * ethPriceUsd;

    // Calculate gas cost in USD
    const gasCostWei = estimatedGasUnits * gasPriceWei;
    const gasCostEth = parseFloat(ethers.formatEther(gasCostWei));
    const gasCostUsd = gasCostEth * ethPriceUsd;

    // Total costs for flash loan execution
    const totalCosts = flashLoanFeeUsd + gasCostUsd;

    // Net profit calculations
    const flashLoanNetProfit = expectedProfitUsd - totalCosts;
    const directExecutionNetProfit = expectedProfitUsd - gasCostUsd;

    // Determine profitability
    const isProfitable = flashLoanNetProfit > 0;
    const netProfitUsd = flashLoanNetProfit;

    // Determine recommendation
    let recommendation: 'flash-loan' | 'direct' | 'skip';

    if (!isProfitable) {
      recommendation = 'skip';
    } else if (userCapitalWei !== undefined && userCapitalWei >= flashLoanAmountWei) {
      // User has capital for direct execution
      if (directExecutionNetProfit > flashLoanNetProfit) {
        recommendation = 'direct';
      } else {
        recommendation = 'flash-loan';
      }
    } else {
      // User doesn't have capital, must use flash loan
      recommendation = 'flash-loan';
    }

    return {
      isProfitable,
      netProfitUsd,
      flashLoanFeeUsd,
      gasCostUsd,
      flashLoanNetProfit,
      directExecutionNetProfit,
      recommendation,
      breakdown: {
        expectedProfit: expectedProfitUsd,
        flashLoanFee: flashLoanFeeUsd,
        gasCost: gasCostUsd,
        totalCosts,
      },
    };
  }

  // ===========================================================================
  // Swap Path Building
  // ===========================================================================

  /**
   * Build swap steps for the arbitrage path.
   *
   * Creates a 2-hop path: tokenIn -> intermediate -> tokenIn
   * (e.g., WETH -> USDC on DEX1, USDC -> WETH on DEX2)
   *
   * Fix 7.1: Now uses actual token decimals instead of assuming 18.
   * This is critical for tokens like USDC (6), USDT (6), WBTC (8).
   *
   * @param opportunity - Arbitrage opportunity
   * @param params - Swap step parameters (must include chain for decimal lookup)
   * @returns Array of swap steps
   */
  buildSwapSteps(
    opportunity: ArbitrageOpportunity,
    params: SwapStepsParams
  ): SwapStep[] {
    const { buyRouter, sellRouter, intermediateToken, slippageBps, chain } = params;
    const slippage = slippageBps !== undefined ? BigInt(slippageBps) : DEFAULT_SLIPPAGE_BPS;

    const amountIn = BigInt(opportunity.amountIn!);
    const expectedProfitUsd = opportunity.expectedProfit || 0;

    // Fix 7.1: Get actual token decimals for both tokens
    const tokenInDecimals = getTokenDecimals(chain, opportunity.tokenIn!);
    const intermediateDecimals = getTokenDecimals(chain, intermediateToken);

    // Calculate expected amounts with slippage
    // For first swap: estimate intermediate amount based on prices
    const expectedIntermediateAmount = this.estimateIntermediateAmount(
      opportunity,
      tokenInDecimals,
      intermediateDecimals
    );
    const minIntermediateOut = expectedIntermediateAmount - (expectedIntermediateAmount * slippage / BPS_DENOMINATOR);

    // Fix 4.2: Convert USD profit to token units correctly
    // profitInTokens = profitUsd / tokenPriceUsd
    const tokenPriceUsd = opportunity.buyPrice || 1;
    const profitInTokenUnits = expectedProfitUsd / tokenPriceUsd;

    // Fix 7.1: Use actual token decimals for profit calculation
    // Cap the precision at the token's actual decimals to avoid precision issues
    const profitPrecision = Math.min(tokenInDecimals, 18);
    const profitWei = ethers.parseUnits(
      Math.max(0, profitInTokenUnits).toFixed(profitPrecision),
      tokenInDecimals
    );

    // For second swap: we expect to get back amountIn + profit (both in token units)
    const expectedFinalAmount = amountIn + profitWei;
    const minFinalOut = expectedFinalAmount - (expectedFinalAmount * slippage / BPS_DENOMINATOR);

    return [
      {
        router: buyRouter,
        tokenIn: opportunity.tokenIn!,
        tokenOut: intermediateToken,
        amountOutMin: minIntermediateOut,
      },
      {
        router: sellRouter,
        tokenIn: intermediateToken,
        tokenOut: opportunity.tokenIn!,
        amountOutMin: minFinalOut,
      },
    ];
  }

  /**
   * Estimate intermediate token amount based on opportunity prices.
   *
   * Fix 4.1: Uses 1e18 precision to avoid loss for very small prices.
   * Fix 7.1: Now handles decimal conversion between tokens.
   *
   * @param opportunity - Arbitrage opportunity with price and amount data
   * @param tokenInDecimals - Decimals of the input token
   * @param intermediateDecimals - Decimals of the intermediate token
   * @returns Estimated intermediate amount in intermediate token units
   */
  private estimateIntermediateAmount(
    opportunity: ArbitrageOpportunity,
    tokenInDecimals: number,
    intermediateDecimals: number
  ): bigint {
    const amountIn = BigInt(opportunity.amountIn!);
    const buyPrice = opportunity.buyPrice || 1;

    // Fix 4.1: Use 1e18 precision to handle very small prices
    const PRECISION = 1e18;
    const priceScaled = BigInt(Math.round(buyPrice * PRECISION));

    // Calculate the decimal adjustment factor
    // If tokenIn has 18 decimals and intermediate has 6, we need to divide by 10^12
    const decimalDiff = tokenInDecimals - intermediateDecimals;
    const decimalAdjustment = BigInt(10) ** BigInt(Math.abs(decimalDiff));

    // amountIn * priceScaled / PRECISION, then adjust for decimals
    let intermediateAmount = (amountIn * priceScaled) / BigInt(PRECISION);

    if (decimalDiff > 0) {
      // tokenIn has more decimals, divide to get intermediate amount
      intermediateAmount = intermediateAmount / decimalAdjustment;
    } else if (decimalDiff < 0) {
      // intermediate has more decimals, multiply
      intermediateAmount = intermediateAmount * decimalAdjustment;
    }

    return intermediateAmount;
  }

  // ===========================================================================
  // Calldata Building
  // ===========================================================================

  /**
   * Build calldata for executeArbitrage function.
   *
   * @param params - Execute arbitrage parameters
   * @returns Encoded calldata
   */
  buildExecuteArbitrageCalldata(params: ExecuteArbitrageParams): string {
    const { asset, amount, swapPath, minProfit } = params;

    // Issue 10.2 Fix: Use cached interface instead of creating new one
    // Convert SwapStep[] to tuple array format for ABI encoding
    const swapPathTuples = swapPath.map(step => [
      step.router,
      step.tokenIn,
      step.tokenOut,
      step.amountOutMin,
    ]);

    return FLASH_LOAN_INTERFACE.encodeFunctionData('executeArbitrage', [
      asset,
      amount,
      swapPathTuples,
      minProfit,
    ]);
  }

  // ===========================================================================
  // Transaction Preparation
  // ===========================================================================

  /**
   * Prepare flash loan contract transaction.
   *
   * @param opportunity - Arbitrage opportunity
   * @param chain - Chain identifier
   * @param ctx - Strategy context
   * @returns Prepared transaction request
   */
  async prepareFlashLoanContractTransaction(
    opportunity: ArbitrageOpportunity,
    chain: string,
    ctx: StrategyContext
  ): Promise<ethers.TransactionRequest> {
    // Validate opportunity fields
    if (!opportunity.tokenIn || !opportunity.amountIn || !opportunity.tokenOut) {
      throw new Error('Invalid opportunity: missing required fields (tokenIn, amountIn, tokenOut)');
    }

    // Get contract address for chain
    const contractAddress = this.config.contractAddresses[chain];
    if (!contractAddress) {
      throw new Error(`No FlashLoanArbitrage contract configured for chain: ${chain}`);
    }

    // Get router addresses
    const buyRouter = this.getRouterForDex(chain, opportunity.buyDex);
    const sellRouter = this.getRouterForDex(chain, opportunity.sellDex || opportunity.buyDex);

    if (!buyRouter || !sellRouter) {
      throw new Error(`No router found for DEX on chain: ${chain}`);
    }

    // Build swap steps (Fix 7.1: pass chain for decimals lookup)
    const swapSteps = this.buildSwapSteps(opportunity, {
      buyRouter,
      sellRouter,
      intermediateToken: opportunity.tokenOut!,
      chain,
    });

    // Issue 4.2 Fix: Convert USD profit to token units
    // expectedProfit is in USD, but contract expects minProfit in token units (flash-loaned asset)
    // Formula: profitInTokens = expectedProfitUsd / tokenPriceUsd
    const expectedProfitUsd = opportunity.expectedProfit || 0;
    const tokenPriceUsd = opportunity.buyPrice || 1; // Fallback to $1 to avoid division by zero

    // Finding 7.1 Fix: Get actual token decimals from config instead of assuming 18
    // This is critical for tokens like USDC (6), USDT (6), WBTC (8)
    const tokenDecimals = getTokenDecimals(chain, opportunity.tokenIn);

    // Convert USD to token amount, then apply slippage tolerance
    const profitInTokens = expectedProfitUsd / tokenPriceUsd;
    const minProfitInTokens = Math.max(0, profitInTokens * (1 - ARBITRAGE_CONFIG.slippageTolerance));
    const minProfitWei = ethers.parseUnits(
      minProfitInTokens.toFixed(tokenDecimals),
      tokenDecimals
    );

    // Build calldata
    const calldata = this.buildExecuteArbitrageCalldata({
      asset: opportunity.tokenIn,
      amount: BigInt(opportunity.amountIn),
      swapPath: swapSteps,
      minProfit: minProfitWei,
    });

    // Prepare transaction
    const wallet = ctx.wallets.get(chain)!;
    const from = await wallet.getAddress();

    return {
      to: contractAddress,
      data: calldata,
      from,
    };
  }

  /**
   * Find router address for a DEX by name (case-insensitive, partial match).
   * Finding 9.2: Extracted to avoid code duplication.
   *
   * @param chainDexes - Array of DEXes for the chain
   * @param dexName - DEX name to search for
   * @returns Router address or undefined if not found
   */
  private findRouterByDexName(chainDexes: typeof DEXES[string], dexName: string): string | undefined {
    const normalizedName = dexName.toLowerCase();
    const dex = chainDexes.find(d => {
      const dexNameLower = d.name.toLowerCase();
      return dexNameLower === normalizedName || dexNameLower.includes(normalizedName);
    });
    return dex?.routerAddress;
  }

  /**
   * Get router address for a DEX on a specific chain.
   * Finding 9.2: Simplified using extracted helper method.
   *
   * Resolution order:
   * 1. If dexName provided and matches approved router -> use that router
   * 2. If approved routers configured -> use first approved router
   * 3. If dexName provided and matches DEXES config -> use that router
   * 4. Fallback to first DEX router from DEXES config
   *
   * @param chain - Chain identifier
   * @param dexName - Optional DEX name to match
   * @returns Router address or undefined
   */
  private getRouterForDex(chain: string, dexName?: string): string | undefined {
    const chainDexes = DEXES[chain];
    const approvedRouters = this.config.approvedRouters[chain];

    // Try to find router by DEX name if provided
    if (dexName && chainDexes) {
      const matchedRouter = this.findRouterByDexName(chainDexes, dexName);

      // If we have approved routers, only return if it's approved
      if (approvedRouters?.length) {
        if (matchedRouter && approvedRouters.includes(matchedRouter)) {
          return matchedRouter;
        }
        // Fall through to return first approved router
      } else if (matchedRouter) {
        // No approved routers configured, return matched router
        return matchedRouter;
      }
    }

    // Return first approved router if configured
    if (approvedRouters?.length) {
      return approvedRouters[0];
    }

    // Fallback to first DEX router
    return chainDexes?.[0]?.routerAddress;
  }

  // ===========================================================================
  // Gas Estimation
  // ===========================================================================

  /**
   * Estimate gas for flash loan transaction.
   *
   * @param opportunity - Arbitrage opportunity
   * @param chain - Chain identifier
   * @param ctx - Strategy context
   * @returns Estimated gas units
   */
  async estimateGas(
    opportunity: ArbitrageOpportunity,
    chain: string,
    ctx: StrategyContext
  ): Promise<bigint> {
    const provider = ctx.providers.get(chain);
    if (!provider) {
      return DEFAULT_GAS_ESTIMATE;
    }

    try {
      const tx = await this.prepareFlashLoanContractTransaction(opportunity, chain, ctx);
      const estimated = await provider.estimateGas(tx);
      return estimated;
    } catch (error) {
      this.logger.warn('Gas estimation failed, using default', {
        chain,
        error: getErrorMessage(error),
      });
      return DEFAULT_GAS_ESTIMATE;
    }
  }

  // ===========================================================================
  // Router Validation
  // ===========================================================================

  /**
   * Check if a router is approved for a chain.
   *
   * @param chain - Chain identifier
   * @param router - Router address
   * @returns True if approved
   */
  isRouterApproved(chain: string, router: string): boolean {
    const approvedRouters = this.config.approvedRouters[chain];
    if (!approvedRouters) {
      return false;
    }
    return approvedRouters.some(r => r.toLowerCase() === router.toLowerCase());
  }

  // ===========================================================================
  // Chain Support
  // ===========================================================================

  /**
   * Get list of supported chains.
   *
   * @returns Array of supported chain identifiers
   */
  getSupportedChains(): string[] {
    return Object.keys(this.config.contractAddresses);
  }

  /**
   * Check if a chain is supported.
   *
   * @param chain - Chain identifier
   * @returns True if supported
   */
  isChainSupported(chain: string): boolean {
    return chain in this.config.contractAddresses;
  }

  // ===========================================================================
  // Protocol Support (Issue 4.1 Fix)
  // ===========================================================================

  /**
   * Check if the flash loan protocol on a chain is supported by this strategy.
   *
   * Currently only Aave V3 is supported. Other protocols (PancakeSwap, SpookySwap,
   * SyncSwap) require different callback interfaces and contract implementations.
   *
   * @param chain - Chain identifier
   * @returns True if the protocol is supported
   */
  isProtocolSupported(chain: string): boolean {
    // Use pre-computed set for O(1) lookup
    return AAVE_V3_SUPPORTED_CHAINS.has(chain);
  }

  /**
   * Get the flash loan protocol for a chain.
   *
   * @param chain - Chain identifier
   * @returns Protocol name or undefined if chain not configured
   */
  getProtocolForChain(chain: string): string | undefined {
    return FLASH_LOAN_PROVIDERS[chain]?.protocol;
  }

  /**
   * Get list of chains with supported flash loan protocols.
   *
   * @returns Array of chain identifiers that support Aave V3
   */
  getSupportedProtocolChains(): string[] {
    return Array.from(AAVE_V3_SUPPORTED_CHAINS);
  }

  // ===========================================================================
  // Contract View Methods (Finding 8.2)
  // ===========================================================================

  /**
   * Calculate expected profit by calling the contract's calculateExpectedProfit view function.
   *
   * This method queries the on-chain contract to get accurate profit estimation
   * including actual flash loan fees and swap outputs based on current pool state.
   *
   * @param opportunity - Arbitrage opportunity
   * @param chain - Chain identifier
   * @param ctx - Strategy context
   * @returns Object with expectedProfit and flashLoanFee (both in wei), or null on error
   */
  async calculateExpectedProfitOnChain(
    opportunity: ArbitrageOpportunity,
    chain: string,
    ctx: StrategyContext
  ): Promise<{ expectedProfit: bigint; flashLoanFee: bigint } | null> {
    // Validate required fields
    if (!opportunity.tokenIn || !opportunity.amountIn || !opportunity.tokenOut) {
      this.logger.warn('Cannot calculate on-chain profit: missing required fields');
      return null;
    }

    const provider = ctx.providers.get(chain);
    if (!provider) {
      this.logger.warn('Cannot calculate on-chain profit: no provider for chain', { chain });
      return null;
    }

    const contractAddress = this.config.contractAddresses[chain];
    if (!contractAddress) {
      this.logger.warn('Cannot calculate on-chain profit: no contract for chain', { chain });
      return null;
    }

    try {
      // Get router addresses
      const buyRouter = this.getRouterForDex(chain, opportunity.buyDex);
      const sellRouter = this.getRouterForDex(chain, opportunity.sellDex || opportunity.buyDex);

      if (!buyRouter || !sellRouter) {
        this.logger.warn('Cannot calculate on-chain profit: no router found', { chain });
        return null;
      }

      // Build swap steps (Fix 7.1: pass chain for decimals lookup)
      const swapSteps = this.buildSwapSteps(opportunity, {
        buyRouter,
        sellRouter,
        intermediateToken: opportunity.tokenOut!,
        chain,
      });

      // Convert SwapStep[] to tuple array format for ABI encoding
      const swapPathTuples = swapSteps.map(step => [
        step.router,
        step.tokenIn,
        step.tokenOut,
        step.amountOutMin,
      ]);

      // Encode call data for calculateExpectedProfit
      const callData = FLASH_LOAN_INTERFACE.encodeFunctionData('calculateExpectedProfit', [
        opportunity.tokenIn,
        BigInt(opportunity.amountIn),
        swapPathTuples,
      ]);

      // Call the contract
      const result = await provider.call({
        to: contractAddress,
        data: callData,
      });

      // Decode the result
      const decoded = FLASH_LOAN_INTERFACE.decodeFunctionResult('calculateExpectedProfit', result);

      return {
        expectedProfit: decoded[0],
        flashLoanFee: decoded[1],
      };
    } catch (error) {
      this.logger.warn('Failed to calculate on-chain profit', {
        chain,
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  // ===========================================================================
  // Gas Estimation (Issue 10.3 Fix - Optimized)
  // ===========================================================================

  /**
   * Estimate gas from an already-prepared transaction.
   *
   * This method is used when the transaction has already been prepared,
   * avoiding duplicate transaction preparation (Issue 10.3 fix).
   *
   * @param tx - Prepared transaction request
   * @param chain - Chain identifier
   * @param ctx - Strategy context
   * @returns Estimated gas units
   */
  async estimateGasFromTransaction(
    tx: ethers.TransactionRequest,
    chain: string,
    ctx: StrategyContext
  ): Promise<bigint> {
    const provider = ctx.providers.get(chain);
    if (!provider) {
      return DEFAULT_GAS_ESTIMATE;
    }

    try {
      const estimated = await provider.estimateGas(tx);
      return estimated;
    } catch (error) {
      this.logger.warn('Gas estimation from transaction failed, using default', {
        chain,
        error: getErrorMessage(error),
      });
      return DEFAULT_GAS_ESTIMATE;
    }
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a FlashLoanStrategy instance.
 *
 * @param logger - Logger instance
 * @param config - Strategy configuration
 * @returns FlashLoanStrategy instance
 */
export function createFlashLoanStrategy(
  logger: Logger,
  config: FlashLoanStrategyConfig
): FlashLoanStrategy {
  return new FlashLoanStrategy(logger, config);
}
