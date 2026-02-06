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
import {
  ARBITRAGE_CONFIG,
  FLASH_LOAN_PROVIDERS,
  DEXES,
  getNativeTokenPrice,
  getTokenDecimals,
  // Fix 1.1 & 9.2: Import centralized constants and ABI
  AAVE_V3_FEE_BPS_BIGINT,
  BPS_DENOMINATOR_BIGINT,
  FLASH_LOAN_ARBITRAGE_ABI,
  // Task 1.2: Batched quoting imports
  FEATURE_FLAGS,
  hasMultiPathQuoter,
} from '@arbitrage/config';
import { getErrorMessage, isValidPrice } from '@arbitrage/core';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type { StrategyContext, ExecutionResult, Logger, NHopArbitrageOpportunity } from '../types';
import {
  createErrorResult,
  createSuccessResult,
  ExecutionErrorCode,
  formatExecutionError,
  isNHopOpportunity,
} from '../types';
import { BaseExecutionStrategy } from './base.strategy';
// Task 1.2: Import BatchQuoterService for batched quote fetching
import {
  createBatchQuoterForChain,
  type BatchQuoterService,
  type QuoteRequest,
} from '../services/simulation/batch-quoter.service';

// =============================================================================
// Constants
// =============================================================================

// Fix 1.1: Use centralized constants from @arbitrage/config
// These are aliased here for backward compatibility with existing code
const AAVE_V3_FEE_BPS = AAVE_V3_FEE_BPS_BIGINT;
const BPS_DENOMINATOR = BPS_DENOMINATOR_BIGINT;

/**
 * Fix 2.1: Static assertion to ensure Aave V3 fee matches official documentation.
 *
 * Aave V3 flash loan premium (fee):
 * - Default: 0.09% (9 basis points) for regular flash loans
 * - 0% for flash loans taken from FlashLoanSimple with approved borrowers
 *
 * This validates at module load time that the imported constant is 9 bps.
 * If this fails, it indicates a configuration mismatch that needs investigation.
 *
 * @see https://docs.aave.com/developers/guides/flash-loans - Official Aave V3 documentation
 * @see ADR-020 - Flash Loan Integration architectural decision
 */
const EXPECTED_AAVE_V3_FEE_BPS = 9n;
if (AAVE_V3_FEE_BPS !== EXPECTED_AAVE_V3_FEE_BPS) {
  throw new Error(
    `[ERR_CONFIG] Aave V3 fee mismatch: expected ${EXPECTED_AAVE_V3_FEE_BPS} bps (0.09%), ` +
    `got ${AAVE_V3_FEE_BPS} bps. Check @arbitrage/config AAVE_V3_FEE_BPS constant.`
  );
}

/**
 * Default gas estimate for flash loan arbitrage (conservative)
 */
const DEFAULT_GAS_ESTIMATE = 500000n;

/**
 * Inconsistency 6.3 Fix: Removed duplicate DEFAULT_SLIPPAGE_BPS constant.
 * Now using this.slippageBps from BaseExecutionStrategy (Refactor 9.2).
 *
 * For static contexts (outside class methods), use ARBITRAGE_CONFIG.slippageTolerance
 * directly, but prefer the base class constant for consistency.
 */

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
 * Parameters for building swap steps (2-hop)
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
 * Fix 1.2: Parameters for building N-hop swap paths
 * Supports triangular arbitrage and more complex routes
 */
export interface NHopSwapStepsParams {
  /** Array of swap hops defining the route */
  hops: Array<{
    router: string;
    tokenOut: string;
    /** Expected output amount for slippage calculation (optional) */
    expectedOutput?: bigint;
  }>;
  /** Global slippage tolerance in basis points (applied to all hops) */
  slippageBps?: number;
  /** Chain identifier for token decimals lookup */
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

// P2-8: Import from extracted FlashLoanFeeCalculator
// Note: Types re-exported at end of file for backward compatibility
import {
  FlashLoanFeeCalculator,
  type ProfitabilityParams,
  type ProfitabilityAnalysis,
} from './flash-loan-fee-calculator';

// =============================================================================
// ABI Interface
// =============================================================================

/**
 * Cached ethers.Interface for hot-path optimization.
 * Creating Interface objects is expensive - cache at module level.
 * Issue 10.2 Fix: Avoid repeated instantiation on every calldata build.
 *
 * Fix 9.2: Uses centralized FLASH_LOAN_ARBITRAGE_ABI from @arbitrage/config.
 * See service-config.ts for full documentation of function return values.
 *
 * @see service-config.ts FLASH_LOAN_ARBITRAGE_ABI
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
  private readonly feeCalculator: FlashLoanFeeCalculator;
  // Task 1.2: Cache BatchQuoterService instances per chain
  private readonly batchedQuoters: Map<string, BatchQuoterService>;

  constructor(logger: Logger, config: FlashLoanStrategyConfig) {
    super(logger);
    this.batchedQuoters = new Map();

    // Validate config
    if (Object.keys(config.contractAddresses).length === 0) {
      throw new Error('[ERR_CONFIG] At least one contract address must be configured');
    }

    // Fix 3.2: Validate contract addresses are valid Ethereum addresses
    // Issue 3.1 Fix: Zero address handling is now consistent with provider-factory.ts
    // Zero address should ALWAYS fail fast (in ALL environments) to prevent silent failures at runtime
    for (const [chain, address] of Object.entries(config.contractAddresses)) {
      if (!ethers.isAddress(address)) {
        throw new Error(`[ERR_CONFIG] Invalid contract address for chain '${chain}': ${address}`);
      }
      // Issue 3.1 Fix: Zero address is invalid in ALL environments
      // Rationale: A zero address will cause all transactions to fail silently at execution time.
      // It's better to fail fast during strategy initialization than during a trade attempt.
      if (address === '0x0000000000000000000000000000000000000000') {
        throw new Error(
          `[ERR_ZERO_ADDRESS] Contract address for chain '${chain}' is zero address. ` +
          `This is almost certainly a misconfiguration. Deploy the FlashLoanArbitrage contract ` +
          `and configure the correct address before using this strategy.`
        );
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

    // Issue 3.1 Fix: Warn if contract exists for a chain but no approved routers
    // This will cause getRouterForDex() to fall back to DEXES config, which may
    // not have the router approved in the FlashLoanArbitrage contract
    for (const chain of Object.keys(config.contractAddresses)) {
      const routers = config.approvedRouters[chain];
      if (!routers || routers.length === 0) {
        // Use console.warn since logger isn't available in constructor
        // This is a startup-time validation, not a runtime log
        console.warn(
          `[WARN] FlashLoanStrategy: Chain '${chain}' has contract address but no approved routers. ` +
          `getRouterForDex() will fall back to DEXES config. Ensure those routers are approved ` +
          `in FlashLoanArbitrage contract, otherwise transactions will fail.`
        );
      }
    }

    this.config = config;

    // P2-8: Initialize fee calculator with config's fee overrides
    this.feeCalculator = new FlashLoanFeeCalculator({
      feeOverrides: config.feeOverrides,
    });
  }

  // ===========================================================================
  // Resource Management
  // ===========================================================================

  /**
   * Dispose of strategy resources and cleanup cached services.
   *
   * Clears the BatchQuoterService cache to prevent memory leaks in scenarios
   * where strategy instances are created and destroyed (e.g., dynamic chain
   * configuration, strategy rotation).
   *
   * Call this method when:
   * - Shutting down the execution engine
   * - Switching strategy configurations
   * - Removing support for specific chains
   *
   * @example
   * ```typescript
   * const strategy = new FlashLoanStrategy(logger, config);
   * // ... use strategy ...
   * await strategy.dispose(); // Clean up before destroying
   * ```
   */
  async dispose(): Promise<void> {
    // Clear BatchQuoterService cache
    this.batchedQuoters.clear();
    this.logger.debug('FlashLoanStrategy resources disposed', {
      strategiesCleared: this.batchedQuoters.size,
    });
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
    // Fix 6.1: Use ExecutionErrorCode enum for standardized error codes
    const chain = opportunity.buyChain;
    if (!chain) {
      return createErrorResult(
        opportunity.id,
        ExecutionErrorCode.NO_CHAIN,
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
        formatExecutionError(
          ExecutionErrorCode.UNSUPPORTED_PROTOCOL,
          `Flash loan protocol '${protocol}' on chain '${chain}' is not supported. Only Aave V3 chains are currently implemented.`
        ),
        chain,
        opportunity.buyDex || 'unknown'
      );
    }

    // Fix 6.2 & 9.1: Use validateContext helper to reduce code duplication
    const validation = this.validateContext(chain, ctx);
    if (!validation.valid) {
      return createErrorResult(
        opportunity.id,
        validation.error,
        chain,
        opportunity.buyDex || 'unknown'
      );
    }
    const { wallet, provider } = validation;

    // Validate opportunity fields
    if (!opportunity.tokenIn || !opportunity.amountIn || !opportunity.tokenOut) {
      return createErrorResult(
        opportunity.id,
        formatExecutionError(
          ExecutionErrorCode.INVALID_OPPORTUNITY,
          'Missing required fields (tokenIn, amountIn, tokenOut)'
        ),
        chain,
        opportunity.buyDex || 'unknown'
      );
    }

    // Validate amount is non-zero
    const amountIn = BigInt(opportunity.amountIn);
    if (amountIn === 0n) {
      return createErrorResult(
        opportunity.id,
        formatExecutionError(
          ExecutionErrorCode.INVALID_OPPORTUNITY,
          'amountIn is zero'
        ),
        chain,
        opportunity.buyDex || 'unknown'
      );
    }

    // Bug 4.1 Fix: Validate buyPrice is valid before execution
    // Invalid price would cause division by zero or wildly incorrect calculations
    // in profit conversion (USD -> token units). Abort early instead of using fallback.
    // Refactor 9.2: Use centralized isValidPrice type guard from @arbitrage/core
    if (!isValidPrice(opportunity.buyPrice)) {
      this.logger.error('[ERR_INVALID_PRICE] Cannot execute flash loan with invalid buyPrice', {
        opportunityId: opportunity.id,
        buyPrice: opportunity.buyPrice,
        chain,
      });
      return createErrorResult(
        opportunity.id,
        formatExecutionError(
          ExecutionErrorCode.INVALID_OPPORTUNITY,
          `Invalid buyPrice: ${opportunity.buyPrice}. Cannot calculate profit in token units.`
        ),
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
          formatExecutionError(ExecutionErrorCode.PRICE_VERIFICATION, priceVerification.reason),
          chain,
          opportunity.buyDex || 'unknown'
        );
      }

      // Fix 10.3: Parallelize independent operations for latency reduction
      // prepareFlashLoanContractTransaction and calculateExpectedProfitOnChain are independent
      // Both only need the opportunity, chain, and context - no interdependency
      const [flashLoanTx, onChainProfit] = await Promise.all([
        this.prepareFlashLoanContractTransaction(opportunity, chain, ctx),
        // Task 1.2: Use batched quoting if feature flag enabled, else fall back to sequential
        this.calculateExpectedProfitWithBatching(opportunity, chain, ctx),
      ]);

      // Estimate gas using the prepared transaction (must wait for flashLoanTx)
      const estimatedGas = await this.estimateGasFromTransaction(flashLoanTx, chain, ctx);

      // Issue 6.2 Fix: Use getNativeTokenPrice() for accurate ETH/native token price
      // The previous code incorrectly used opportunity.buyPrice (token price, not ETH)
      const nativeTokenPriceUsd = getNativeTokenPrice(chain, { suppressWarning: true });
      if (onChainProfit) {
        const onChainProfitEth = parseFloat(ethers.formatEther(onChainProfit.expectedProfit));
        const onChainProfitUsd = onChainProfitEth * nativeTokenPriceUsd;

        // If on-chain profit is significantly lower than expected, log warning
        // P3-2 FIX: Use ?? to preserve 0 as a valid profit value
        const offChainProfit = opportunity.expectedProfit ?? 0;
        const profitDivergence = offChainProfit > 0
          ? Math.abs(onChainProfitUsd - offChainProfit) / offChainProfit
          : 0;

        if (profitDivergence > 0.2) { // >20% divergence
          this.logger.warn('On-chain profit diverges from expected', {
            opportunityId: opportunity.id,
            offChainProfitUsd: offChainProfit,
            onChainProfitUsd,
            divergencePercent: (profitDivergence * 100).toFixed(1),
          });
        }

        // Use on-chain profit for profitability analysis if available
        // (it's more accurate than off-chain estimation)
        if (onChainProfitUsd < offChainProfit * 0.5) {
          // On-chain profit is less than 50% of expected - likely unprofitable
          this.logger.warn('On-chain profit significantly lower than expected', {
            opportunityId: opportunity.id,
            offChainProfitUsd: offChainProfit,
            onChainProfitUsd,
          });
        }
      }

      // Analyze profitability (flash loan vs direct, accounting for fees)
      // P3-2 FIX: Use ?? to preserve 0 as a valid profit value
      const profitAnalysis = this.analyzeProfitability({
        expectedProfitUsd: opportunity.expectedProfit ?? 0,
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
          formatExecutionError(
            ExecutionErrorCode.HIGH_FEES,
            `Opportunity unprofitable after fees: net ${profitAnalysis.netProfitUsd.toFixed(2)} USD`
          ),
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
          formatExecutionError(
            ExecutionErrorCode.SIMULATION_REVERT,
            simulationResult.revertReason || 'unknown reason'
          ),
          chain,
          opportunity.buyDex || 'unknown'
        );
      }

      // Phase 2.3: Enhanced profit validation from simulation result
      // If simulation succeeded and returned gas estimates, verify profitability with actual gas
      if (simulationResult?.success && simulationResult.gasUsed) {
        const simulatedGasUnits = BigInt(simulationResult.gasUsed);
        const revalidatedProfit = this.analyzeProfitability({
          expectedProfitUsd: opportunity.expectedProfit ?? 0,
          flashLoanAmountWei: amountIn,
          estimatedGasUnits: simulatedGasUnits,
          gasPriceWei: gasPrice,
          chain,
          ethPriceUsd: nativeTokenPriceUsd,
        });

        if (!revalidatedProfit.isProfitable) {
          ctx.stats.simulationProfitabilityRejections++;
          this.logger.warn('Aborting execution: simulation gas estimate makes trade unprofitable', {
            opportunityId: opportunity.id,
            estimatedGas: estimatedGas.toString(),
            simulatedGas: simulatedGasUnits.toString(),
            netProfitUsd: revalidatedProfit.netProfitUsd,
            breakdown: revalidatedProfit.breakdown,
          });

          return createErrorResult(
            opportunity.id,
            formatExecutionError(
              ExecutionErrorCode.HIGH_FEES,
              `Simulation revealed higher gas (${simulatedGasUnits}), making trade unprofitable: net ${revalidatedProfit.netProfitUsd.toFixed(2)} USD`
            ),
            chain,
            opportunity.buyDex || 'unknown'
          );
        }
      }

      // Apply MEV protection
      const protectedTx = await this.applyMEVProtection(flashLoanTx, chain, ctx);

      // Fix 1.1/7.2: Use submitTransaction() from BaseExecutionStrategy
      // This provides:
      // 1. Provider health check (Race 5.4 fix) - isProviderHealthy() before submission
      // 2. Gas price refresh (Fix 5.1) - refreshGasPriceForSubmission() just before tx
      // 3. Per-chain nonce locking (Fix 3.1) - prevents nonce race conditions
      // 4. Concurrent nonce tracking (Fix 5.1) - checkConcurrentNonceAccess() warning
      // 5. Automatic MEV eligibility check and protected submission
      // 6. Proper nonce lifecycle management (allocation, confirmation, failure)
      //
      // Previous code had its own submission logic that was duplicated and missing
      // these protections. Now all strategies use the same battle-tested submission path.

      const submitResult = await this.submitTransaction(protectedTx, chain, ctx, {
        opportunityId: opportunity.id,
        expectedProfit: opportunity.expectedProfit,
        initialGasPrice: gasPrice,
      });

      // Fix 6.2: Return error result directly instead of throwing
      // This ensures consistent pattern per Doc 4.1 in index.ts:
      // execute() methods should return ExecutionResult, not throw
      if (!submitResult.success) {
        // submitTransaction handles nonce management internally
        return createErrorResult(
          opportunity.id,
          formatExecutionError(
            ExecutionErrorCode.FLASH_LOAN_ERROR,
            submitResult.error || 'Transaction submission failed'
          ),
          chain,
          opportunity.buyDex || 'unknown'
        );
      }

      // Calculate actual profit from receipt
      const actualProfit = submitResult.receipt
        ? await this.calculateActualProfit(submitResult.receipt, opportunity)
        : undefined;

      this.logger.info('Flash loan arbitrage executed successfully', {
        opportunityId: opportunity.id,
        txHash: submitResult.txHash,
        actualProfit,
        gasUsed: submitResult.receipt ? Number(submitResult.receipt.gasUsed) : undefined,
        chain,
        usedMevProtection: submitResult.usedMevProtection,
      });

      return createSuccessResult(
        opportunity.id,
        submitResult.txHash || submitResult.receipt?.hash || '',
        chain,
        opportunity.buyDex || 'unknown',
        {
          actualProfit,
          gasUsed: submitResult.receipt ? Number(submitResult.receipt.gasUsed) : undefined,
          gasCost: submitResult.receipt
            ? parseFloat(ethers.formatEther(
                submitResult.receipt.gasUsed * (submitResult.receipt.gasPrice ?? gasPrice)
              ))
            : undefined,
        }
      );
    } catch (error) {
      const errorMessage = getErrorMessage(error);

      this.logger.error('Flash loan arbitrage execution failed', {
        opportunityId: opportunity.id,
        chain,
        error: errorMessage,
      });

      return createErrorResult(
        opportunity.id,
        formatExecutionError(
          ExecutionErrorCode.FLASH_LOAN_ERROR,
          errorMessage || 'Unknown error during flash loan execution'
        ),
        chain,
        opportunity.buyDex || 'unknown'
      );
    }
  }

  // ===========================================================================
  // Flash Loan Fee Calculation (P2-8: Delegated to FlashLoanFeeCalculator)
  // ===========================================================================

  /**
   * Calculate flash loan fee for a given amount.
   * P2-8: Delegates to FlashLoanFeeCalculator for testability.
   *
   * @param amount - Flash loan amount in wei
   * @param chain - Chain identifier
   * @returns Fee amount in wei
   */
  calculateFlashLoanFee(amount: bigint, chain: string): bigint {
    return this.feeCalculator.calculateFlashLoanFee(amount, chain);
  }

  // ===========================================================================
  // Profitability Analysis (P2-8: Delegated to FlashLoanFeeCalculator)
  // ===========================================================================

  /**
   * Analyze profitability of flash loan vs direct execution.
   * P2-8: Delegates to FlashLoanFeeCalculator for testability.
   *
   * @param params - Profitability parameters
   * @returns Profitability analysis result
   */
  analyzeProfitability(params: ProfitabilityParams): ProfitabilityAnalysis {
    return this.feeCalculator.analyzeProfitability(params);
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
    // Inconsistency 6.3 Fix: Use base class slippageBps instead of duplicate constant
    const slippage = slippageBps !== undefined ? BigInt(slippageBps) : this.slippageBps;

    const amountIn = BigInt(opportunity.amountIn!);
    // P3-2 FIX: Use ?? to preserve 0 as a valid profit value
    const expectedProfitUsd = opportunity.expectedProfit ?? 0;

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

    // Bug 4.1 Fix: Validate buyPrice strictly - throw if invalid
    // This method may be called from execute() which now validates buyPrice,
    // but also from tests or other code paths. Defensive programming requires validation here.
    // Refactor 9.2: Use centralized isValidPrice type guard from @arbitrage/core
    if (!isValidPrice(opportunity.buyPrice)) {
      throw new Error(
        `[ERR_INVALID_PRICE] Cannot build swap steps with invalid buyPrice: ${opportunity.buyPrice}. ` +
        `This would cause incorrect profit calculations.`
      );
    }

    // TypeScript now knows buyPrice is valid, but still needs assertion for type narrowing
    const tokenPriceUsd: number = opportunity.buyPrice!;
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

    // Bug 4.1 Fix: Validate buyPrice strictly - throw if invalid
    // Using a fallback of 1 would produce wildly incorrect intermediate amounts
    // Refactor 9.2: Use centralized isValidPrice type guard from @arbitrage/core
    if (!isValidPrice(opportunity.buyPrice)) {
      throw new Error(
        `[ERR_INVALID_PRICE] Cannot estimate intermediate amount with invalid buyPrice: ${opportunity.buyPrice}`
      );
    }

    // TypeScript now knows buyPrice is valid
    const buyPrice: number = opportunity.buyPrice!;

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

  /**
   * Fix 1.2: Build N-hop swap steps for complex arbitrage paths.
   *
   * Supports triangular arbitrage (3-hop) and more complex routes.
   * The path must start and end with the same asset (the flash-loaned token).
   *
   * DONE (Issue 1.2): N-hop execution integrated into execute() method.
   *
   * Integration status (completed):
   * ✅ NHopArbitrageOpportunity type defined in types.ts with `hops: SwapHop[]`
   * ✅ isNHopOpportunity() type guard implemented
   * ✅ prepareFlashLoanContractTransaction() calls buildNHopSwapSteps() when hops detected
   * ✅ Method tested (see flash-loan.strategy.test.ts)
   *
   * Remaining work (external to execution-engine):
   * - Opportunity detectors need to emit NHopArbitrageOpportunity with populated hops array
   * - See unified-detector service for triangular/quadrilateral path detection
   *
   * @example
   * // 3-hop triangular arbitrage: WETH -> USDC -> DAI -> WETH
   * const steps = strategy.buildNHopSwapSteps(opportunity, {
   *   hops: [
   *     { router: uniswapRouter, tokenOut: USDC },
   *     { router: sushiRouter, tokenOut: DAI },
   *     { router: uniswapRouter, tokenOut: WETH },
   *   ],
   *   slippageBps: 50,
   *   chain: 'ethereum',
   * });
   *
   * @param opportunity - Arbitrage opportunity with tokenIn as the starting asset
   * @param params - N-hop swap parameters
   * @returns Array of swap steps ready for contract execution
   */
  buildNHopSwapSteps(
    opportunity: ArbitrageOpportunity,
    params: NHopSwapStepsParams
  ): SwapStep[] {
    const { hops, slippageBps, chain } = params;
    // Inconsistency 6.3 Fix: Use base class slippageBps instead of duplicate constant
    const slippage = slippageBps !== undefined ? BigInt(slippageBps) : this.slippageBps;

    if (!opportunity.tokenIn) {
      throw new Error('[ERR_INVALID_OPPORTUNITY] tokenIn is required for N-hop path building');
    }

    if (hops.length === 0) {
      throw new Error('[ERR_EMPTY_HOPS] At least one hop is required');
    }

    // Validate the path ends with the starting asset (required for flash loan repayment)
    const lastHop = hops[hops.length - 1];
    if (lastHop.tokenOut.toLowerCase() !== opportunity.tokenIn.toLowerCase()) {
      throw new Error(
        `[ERR_INVALID_PATH] Path must end with starting asset. ` +
        `Expected ${opportunity.tokenIn}, got ${lastHop.tokenOut}`
      );
    }

    const steps: SwapStep[] = [];
    let currentTokenIn = opportunity.tokenIn;

    for (let i = 0; i < hops.length; i++) {
      const hop = hops[i];

      // Calculate amountOutMin with slippage
      let amountOutMin: bigint;

      if (hop.expectedOutput !== undefined) {
        // Use provided expected output with slippage applied
        amountOutMin = hop.expectedOutput - (hop.expectedOutput * slippage / BPS_DENOMINATOR);
      } else {
        // Default to 1 wei as minimum (caller should provide expectedOutput for safety)
        this.logger.warn('[WARN_SLIPPAGE] No expectedOutput provided for hop, using 1 wei minimum', {
          hopIndex: i,
          tokenIn: currentTokenIn,
          tokenOut: hop.tokenOut,
        });
        amountOutMin = 1n;
      }

      steps.push({
        router: hop.router,
        tokenIn: currentTokenIn,
        tokenOut: hop.tokenOut,
        amountOutMin,
      });

      // Update tokenIn for next hop
      currentTokenIn = hop.tokenOut;
    }

    return steps;
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

    // Finding 1.2 Fix: Support N-hop paths when opportunity defines them
    // Check if opportunity has multi-hop path (triangular+ arbitrage)
    // Uses proper type guard instead of type assertion hack
    let swapSteps: SwapStep[];

    if (isNHopOpportunity(opportunity)) {
      // N-hop path detected - use buildNHopSwapSteps
      this.logger.info('Using N-hop swap path', {
        opportunityId: opportunity.id,
        hopCount: opportunity.hops.length,
      });

      const nhopParams: NHopSwapStepsParams = {
        hops: opportunity.hops.map(hop => {
          // Resolve router from dex name if not provided directly
          const router = hop.router || this.getRouterForDex(chain, hop.dex);
          if (!router) {
            throw new Error(`No router found for hop DEX '${hop.dex}' on chain: ${chain}`);
          }
          return {
            router,
            tokenOut: hop.tokenOut,
            expectedOutput: hop.expectedOutput ? BigInt(hop.expectedOutput) : undefined,
          };
        }),
        slippageBps: Number(this.slippageBps),
        chain,
      };

      swapSteps = this.buildNHopSwapSteps(opportunity, nhopParams);
    } else {
      // Default 2-hop path (standard arbitrage)
      // Get router addresses
      const buyRouter = this.getRouterForDex(chain, opportunity.buyDex);
      const sellRouter = this.getRouterForDex(chain, opportunity.sellDex || opportunity.buyDex);

      if (!buyRouter || !sellRouter) {
        throw new Error(`No router found for DEX on chain: ${chain}`);
      }

      // Build swap steps (Fix 7.1: pass chain for decimals lookup)
      swapSteps = this.buildSwapSteps(opportunity, {
        buyRouter,
        sellRouter,
        intermediateToken: opportunity.tokenOut!,
        chain,
      });
    }

    // Bug 4.1 Fix: Convert USD profit to token units with strict validation
    // expectedProfit is in USD, but contract expects minProfit in token units (flash-loaned asset)
    // Formula: profitInTokens = expectedProfitUsd / tokenPriceUsd
    // P3-2 FIX: Use ?? to preserve 0 as a valid profit value
    const expectedProfitUsd = opportunity.expectedProfit ?? 0;

    // Validate buyPrice strictly - throw if invalid
    // Refactor 9.2: Use centralized isValidPrice type guard from @arbitrage/core
    if (!isValidPrice(opportunity.buyPrice)) {
      throw new Error(
        `[ERR_INVALID_PRICE] Cannot prepare flash loan transaction with invalid buyPrice: ${opportunity.buyPrice}`
      );
    }

    const tokenPriceUsd = opportunity.buyPrice!;

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
    // Perf 10.2: Use cached wallet address
    const from = await this.getWalletAddress(wallet);

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

  // ===========================================================================
  // Task 1.2: Batched Quote Fetching Methods
  // @see ADR-029: Batched Quote Fetching
  // ===========================================================================

  /**
   * Calculate expected profit using BatchQuoterService if available and enabled.
   *
   * **Fallback Strategy** (Resilient):
   * Falls back to existing calculateExpectedProfitOnChain() if:
   * - Feature flag is disabled (FEATURE_BATCHED_QUOTER=false)
   * - MultiPathQuoter contract not deployed for this chain
   * - BatchQuoterService call fails
   * - Batched simulation returns allSuccess=false
   *
   * **Performance Impact**:
   * - Batched: ~30-50ms (single RPC call for entire path)
   * - Fallback: ~100-200ms (N sequential RPC calls)
   *
   * @param opportunity - Arbitrage opportunity
   * @param chain - Chain identifier
   * @param ctx - Strategy context
   * @returns Object with expectedProfit and flashLoanFee (both in wei), or null if
   *          both batched and fallback methods fail (e.g., contract unavailable,
   *          RPC errors, invalid opportunity data)
   *
   * @see ADR-029 for architecture and rollout strategy
   */
  private async calculateExpectedProfitWithBatching(
    opportunity: ArbitrageOpportunity,
    chain: string,
    ctx: StrategyContext
  ): Promise<{ expectedProfit: bigint; flashLoanFee: bigint } | null> {
    // Check feature flag - if disabled, use existing sequential path
    if (!FEATURE_FLAGS.useBatchedQuoter) {
      return await this.calculateExpectedProfitOnChain(opportunity, chain, ctx);
    }

    // Get or create BatchQuoterService for this chain
    const batchQuoter = this.getBatchQuoterService(chain, ctx);
    if (!batchQuoter) {
      // Batched quoting not available (contract not deployed or provider missing)
      return await this.calculateExpectedProfitOnChain(opportunity, chain, ctx);
    }

    try {
      // Build quote requests from opportunity
      const requests = this.buildQuoteRequestsFromOpportunity(opportunity, chain);

      // Use batched simulation
      const result = await batchQuoter.simulateArbitragePath(
        requests,
        BigInt(opportunity.amountIn!),
        Number(AAVE_V3_FEE_BPS_BIGINT) // Convert bigint to number for service
      );

      if (!result.allSuccess) {
        this.logger.warn('Batched simulation failed, using fallback', {
          opportunityId: opportunity.id,
          chain,
        });
        return await this.calculateExpectedProfitOnChain(opportunity, chain, ctx);
      }

      // Calculate flash loan fee same way as existing code
      const flashLoanFee = this.calculateFlashLoanFee(BigInt(opportunity.amountIn!), chain);

      this.logger.debug('Batched quote simulation succeeded', {
        opportunityId: opportunity.id,
        chain,
        expectedProfit: result.expectedProfit.toString(),
        latencyMs: result.latencyMs,
      });

      return {
        expectedProfit: result.expectedProfit,
        flashLoanFee,
      };
    } catch (error) {
      this.logger.warn('BatchQuoter error, using fallback', {
        opportunityId: opportunity.id,
        chain,
        error: getErrorMessage(error),
      });
      // Fallback to sequential
      return await this.calculateExpectedProfitOnChain(opportunity, chain, ctx);
    }
  }

  /**
   * Get or create a BatchQuoterService for a specific chain.
   *
   * Uses double-checked pattern to prevent race conditions where multiple
   * concurrent calls could create duplicate quoter instances.
   *
   * Performance notes:
   * - Single Map.get() lookup (not .has() then .get())
   * - Fast path returns immediately if cached
   * - Slow path creates once, subsequent calls use cached instance
   *
   * Returns undefined if:
   * - Provider not available for chain
   * - MultiPathQuoter contract not deployed on chain
   * - Contract deployed but batching disabled
   *
   * @param chain - Chain identifier
   * @param ctx - Strategy context
   * @returns BatchQuoterService instance or undefined
   */
  private getBatchQuoterService(
    chain: string,
    ctx: StrategyContext
  ): BatchQuoterService | undefined {
    // Fast path: Check cache with single lookup (Perf 10.2 optimization)
    // Use .get() instead of .has()/.get() to avoid double hash lookup
    let quoter = this.batchedQuoters.get(chain);
    if (quoter) {
      return quoter;
    }

    // Slow path: Create new quoter (with race condition protection)
    // Node.js is single-threaded for sync code, but async operations can
    // interleave. Double-check after async operations complete.

    // Get provider for chain
    const provider = ctx.providers.get(chain);
    if (!provider) {
      return undefined;
    }

    // Check if MultiPathQuoter deployed for this chain
    if (!hasMultiPathQuoter(chain)) {
      return undefined;
    }

    // Double-check: Another call might have created quoter while we were checking
    quoter = this.batchedQuoters.get(chain);
    if (quoter) {
      return quoter;
    }

    // Create service (will auto-resolve address from registry)
    quoter = createBatchQuoterForChain(
      provider as ethers.JsonRpcProvider,
      chain,
      { logger: this.logger }
    );

    // Only cache if batching is actually enabled (contract deployed and valid)
    if (quoter.isBatchingEnabled()) {
      this.batchedQuoters.set(chain, quoter);
      this.logger.info('Batched quoting enabled for chain', { chain });
      return quoter;
    }

    // Contract exists but batching not enabled (shouldn't happen, but defensive)
    return undefined;
  }

  /**
   * Build quote requests from arbitrage opportunity.
   * Converts opportunity swap path into QuoteRequest[] format for BatchQuoterService.
   *
   * Supports both:
   * - Standard 2-hop paths (buy → sell)
   * - N-hop paths (triangular+ arbitrage) via NHopArbitrageOpportunity
   *
   * @param opportunity - Arbitrage opportunity (standard or N-hop)
   * @param chain - Chain identifier
   * @returns Array of quote requests
   */
  private buildQuoteRequestsFromOpportunity(
    opportunity: ArbitrageOpportunity,
    chain: string
  ): QuoteRequest[] {
    // Check if N-hop opportunity (triangular+ arbitrage)
    if (isNHopOpportunity(opportunity)) {
      // Build requests from hop array
      const requests: QuoteRequest[] = [];
      let currentTokenIn = opportunity.tokenIn!;

      for (let i = 0; i < opportunity.hops.length; i++) {
        const hop = opportunity.hops[i];

        // Resolve router: use hop.router if provided, else resolve from hop.dex
        let router: string | undefined;
        if (hop.router) {
          router = hop.router;
        } else if (hop.dex) {
          router = this.getRouterForDex(chain, hop.dex);
        }

        if (!router) {
          throw new Error(
            `No router found for hop ${i} on chain: ${chain}. ` +
            `Hop dex: ${hop.dex || 'undefined'}, router: ${hop.router || 'undefined'}`
          );
        }

        requests.push({
          router,
          tokenIn: currentTokenIn,
          tokenOut: hop.tokenOut,
          // First hop uses opportunity.amountIn, subsequent hops chain from previous
          amountIn: i === 0 ? BigInt(opportunity.amountIn!) : 0n,
        });

        // Next hop's input is this hop's output
        currentTokenIn = hop.tokenOut;
      }

      // Validate: Path must end with starting token (flash loan requirement)
      const lastToken = requests[requests.length - 1]?.tokenOut;
      if (lastToken?.toLowerCase() !== opportunity.tokenIn!.toLowerCase()) {
        throw new Error(
          `N-hop path must end with starting token. ` +
          `Expected ${opportunity.tokenIn}, got ${lastToken}`
        );
      }

      return requests;
    }

    // Standard 2-hop path (buy → sell)
    const buyRouter = this.getRouterForDex(chain, opportunity.buyDex);
    const sellRouter = this.getRouterForDex(chain, opportunity.sellDex || opportunity.buyDex);

    if (!buyRouter) {
      throw new Error(
        `No router found for buyDex '${opportunity.buyDex}' on chain: ${chain}`
      );
    }

    if (!sellRouter) {
      throw new Error(
        `No router found for sellDex '${opportunity.sellDex || opportunity.buyDex}' on chain: ${chain}`
      );
    }

    // Build 2-hop path: tokenIn → tokenIntermediate → tokenIn
    return [
      {
        router: buyRouter,
        tokenIn: opportunity.tokenIn!,
        tokenOut: opportunity.tokenIntermediate || opportunity.tokenOut!,
        amountIn: BigInt(opportunity.amountIn!),
      },
      {
        router: sellRouter,
        tokenIn: opportunity.tokenIntermediate || opportunity.tokenOut!,
        tokenOut: opportunity.tokenIn!,
        amountIn: 0n, // Chain from previous output
      },
    ];
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

// =============================================================================
// Type Re-exports (P2-8: Backward compatibility for consumers)
// =============================================================================

// Re-export types from FlashLoanFeeCalculator for consumers that import from
// this file. Prefer importing directly from './flash-loan-fee-calculator'.
export type { ProfitabilityParams, ProfitabilityAnalysis } from './flash-loan-fee-calculator';
