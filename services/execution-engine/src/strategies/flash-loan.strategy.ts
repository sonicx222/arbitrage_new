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
  // Task 2.1: PancakeSwap V3 integration
  getPancakeSwapV3Factory,
  hasPancakeSwapV3,
} from '@arbitrage/config';
import {
  getErrorMessage,
  isValidPrice,
  // Clean Architecture: Flash Loan Aggregation (Task 2.3)
  type IFlashLoanAggregator,
  type IAggregatorMetrics,
  type IProviderInfo,
  createFlashLoanAggregator,
  createWeightedRankingStrategy,
  createOnChainLiquidityValidator,
  createInMemoryAggregatorMetrics,
} from '@arbitrage/core';
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

// Task 2.1: Import PancakeSwap V3 provider for pool discovery
import { PancakeSwapV3FlashLoanProvider } from './flash-loan-providers/pancakeswap-v3.provider';

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
 *
 * Task 2.1: Added PancakeSwap V3 support alongside Aave V3.
 * Each protocol requires different callback interfaces and contract implementations:
 * - Aave V3: Uses FlashLoanArbitrage.sol with executeOperation callback
 * - PancakeSwap V3: Uses PancakeSwapFlashArbitrage.sol with pancakeV3FlashCallback
 */
const SUPPORTED_FLASH_LOAN_PROTOCOLS = new Set(['aave_v3', 'pancakeswap_v3']);

/**
 * Chains that support Aave V3 flash loans (pre-computed for O(1) lookup)
 */
const AAVE_V3_SUPPORTED_CHAINS = new Set(
  Object.entries(FLASH_LOAN_PROVIDERS)
    .filter(([_, config]) => config.protocol === 'aave_v3')
    .map(([chain]) => chain)
);

/**
 * Task 2.1: Chains that support PancakeSwap V3 flash loans (pre-computed for O(1) lookup)
 */
const PANCAKESWAP_V3_SUPPORTED_CHAINS = new Set(
  Object.entries(FLASH_LOAN_PROVIDERS)
    .filter(([_, config]) => config.protocol === 'pancakeswap_v3')
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
 *
 * Task 2.3: Flash Loan Protocol Aggregation (Clean Architecture)
 * - Enable dynamic provider selection via aggregator
 * - Fallback to hardcoded Aave V3 if disabled
 */
export interface FlashLoanStrategyConfig {
  /** FlashLoanArbitrage contract addresses per chain */
  contractAddresses: Record<string, string>;
  /** Approved DEX routers per chain */
  approvedRouters: Record<string, string[]>;
  /** Custom flash loan fee overrides (basis points) */
  feeOverrides?: Record<string, number>;

  /**
   * Task 2.3: Enable flash loan protocol aggregation
   *
   * When enabled:
   * - Dynamically selects best provider via weighted ranking
   * - Validates liquidity with on-chain checks (5-min cache)
   * - Tracks provider metrics (success rate, latency)
   * - Supports fallback on provider failures
   *
   * When disabled:
   * - Uses hardcoded Aave V3 (backward compatible)
   *
   * @default false
   */
  enableAggregator?: boolean;

  /**
   * Aggregator weights (Task 2.3)
   *
   * @default { fees: 0.5, liquidity: 0.3, reliability: 0.15, latency: 0.05 }
   */
  aggregatorWeights?: {
    fees: number;
    liquidity: number;
    reliability: number;
    latency: number;
  };

  /**
   * Maximum providers to rank (Task 2.3)
   *
   * @default 3
   */
  maxProvidersToRank?: number;

  /**
   * Enable liquidity validation (Task 2.3)
   *
   * When enabled, validates provider liquidity on-chain before execution.
   *
   * @default true (if aggregator enabled)
   */
  enableLiquidityValidation?: boolean;
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
 *
 * Task 2.1: Added optional pool parameter for PancakeSwap V3.
 * - Aave V3: pool is undefined (uses FlashLoanArbitrage contract)
 * - PancakeSwap V3: pool is required (uses PancakeSwapFlashArbitrage contract)
 */
export interface ExecuteArbitrageParams {
  asset: string;
  amount: bigint;
  swapPath: SwapStep[];
  minProfit: bigint;
  /** Task 2.1: PancakeSwap V3 pool address (required for PancakeSwap V3, unused for Aave V3) */
  pool?: string;
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

/**
 * Task 2.1: PancakeSwap V3 Flash Arbitrage ABI (cached for hot-path optimization)
 *
 * PancakeSwap V3 requires a different contract interface than Aave V3:
 * - executeArbitrage takes `pool` parameter (first arg)
 * - Contract uses PancakeSwap V3 flash swap mechanism
 * - Different callback interface (pancakeV3FlashCallback)
 *
 * @see contracts/src/PancakeSwapFlashArbitrage.sol
 */
const PANCAKESWAP_FLASH_ARBITRAGE_ABI = [
  'function executeArbitrage(address pool, address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath, uint256 minProfit, uint256 deadline) external',
];
const PANCAKESWAP_FLASH_INTERFACE = new ethers.Interface(PANCAKESWAP_FLASH_ARBITRAGE_ABI);

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
  // Task 2.3: Flash Loan Protocol Aggregation (Clean Architecture)
  private readonly aggregator?: IFlashLoanAggregator;
  private readonly aggregatorMetrics?: IAggregatorMetrics;


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
    // This will cause router lookup to fall back to DEXES config, which may
    // not have the router approved in the FlashLoanArbitrage contract
    //
    // C3 Fix Enhancement: CRITICAL SYNCHRONIZATION REQUIREMENT
    // Routers MUST be approved in TWO locations for execution to succeed:
    // 1. Strategy config (approvedRouters) - validated here (off-chain)
    // 2. Smart contract (addApprovedRouter) - validated on-chain during execution
    //
    // Mismatch causes: Transaction passes off-chain validation but reverts on-chain with
    // [ERR_UNAPPROVED_ROUTER], wasting gas and time.
    //
    // Verification: Use deployment validation script (see ADR-030:586-623)
    //   npx hardhat run scripts/verify-router-approval.ts --network <chain>
    //
    // @see docs/architecture/adr/ADR-030-pancakeswap-v3-flash-loans.md (I4 Router Sync)
    for (const chain of Object.keys(config.contractAddresses)) {
      const routers = config.approvedRouters[chain];
      if (!routers || routers.length === 0) {
        // Use console.warn since logger isn't available in constructor
        // This is a startup-time validation, not a runtime log
        console.warn(
          `[CRITICAL] FlashLoanStrategy: Chain '${chain}' has contract address but no approved routers. ` +
          `Router lookup will fall back to DEXES config. ` +
          `MUST ensure those routers are approved in FlashLoanArbitrage contract via addApprovedRouter(), ` +
          `otherwise ALL transactions will fail with ERR_UNAPPROVED_ROUTER. ` +
          `Verify with: scripts/verify-router-approval.ts`
        );
      }
    }

    // I3 Fix: Validate PancakeSwap V3 configuration consistency
    // For each chain configured with PancakeSwap V3 protocol, ensure factory address exists
    for (const [chain, providerConfig] of Object.entries(FLASH_LOAN_PROVIDERS)) {
      if (providerConfig.protocol === 'pancakeswap_v3') {
        // Check if factory address is configured
        if (!hasPancakeSwapV3(chain)) {
          throw new Error(
            `[ERR_CONFIG] PancakeSwap V3 protocol configured for chain '${chain}' ` +
            `but factory address is missing. Add factory address to PANCAKESWAP_V3_FACTORIES ` +
            `in shared/config/src/addresses.ts`
          );
        }

        // Validate factory address is not zero
        const factoryAddress = getPancakeSwapV3Factory(chain);
        if (factoryAddress === '0x0000000000000000000000000000000000000000') {
          throw new Error(
            `[ERR_ZERO_ADDRESS] PancakeSwap V3 factory address for chain '${chain}' is zero address. ` +
            `This is a misconfiguration in PANCAKESWAP_V3_FACTORIES.`
          );
        }

        // Validate factory address format
        if (!ethers.isAddress(factoryAddress)) {
          throw new Error(
            `[ERR_CONFIG] Invalid PancakeSwap V3 factory address for chain '${chain}': ${factoryAddress}`
          );
        }
      }
    }

    this.config = config;

    // P2-8: Initialize fee calculator with config's fee overrides
    this.feeCalculator = new FlashLoanFeeCalculator({
      feeOverrides: config.feeOverrides,
    });

    // Task 2.3: Initialize flash loan aggregator (Clean Architecture)
    if (config.enableAggregator) {
      this.logger.info('Initializing Flash Loan Protocol Aggregator (Clean Architecture)');

      // Create metrics tracker
      this.aggregatorMetrics = createInMemoryAggregatorMetrics({
        maxLatencySamples: 100,
        minSamplesForScore: 10,
      });

      // Create aggregator config from strategy config
      const aggregatorConfig = {
        liquidityCheckThresholdUsd: 100000, // $100K
        rankingCacheTtlMs: 30000, // 30s
        liquidityCacheTtlMs: 300000, // 5min
        weights: config.aggregatorWeights ?? {
          fees: 0.5,
          liquidity: 0.3,
          reliability: 0.15,
          latency: 0.05,
        },
        maxProvidersToRank: config.maxProvidersToRank ?? 3,
      };

      // Create ranking strategy
      const ranker = createWeightedRankingStrategy(aggregatorConfig);

      // Create liquidity validator (only if enabled)
      const validator = config.enableLiquidityValidation !== false
        ? createOnChainLiquidityValidator({
            cacheTtlMs: 300000, // 5 minutes
            safetyMargin: 1.1, // 10% buffer
            rpcTimeoutMs: 5000,
            maxCacheSize: 500,
          })
        : null;

      // Build available providers map from FLASH_LOAN_PROVIDERS config
      const availableProviders = new Map<string, IProviderInfo[]>();
      for (const [chain, providerConfig] of Object.entries(FLASH_LOAN_PROVIDERS)) {
        const providers: IProviderInfo[] = [{
          protocol: providerConfig.protocol as any,
          chain,
          poolAddress: providerConfig.address,
          feeBps: providerConfig.fee,
          isAvailable: true,
        }];
        availableProviders.set(chain, providers);
      }

      // Create aggregator
      this.aggregator = createFlashLoanAggregator(
        aggregatorConfig,
        ranker,
        validator,
        this.aggregatorMetrics,
        availableProviders
      );

      this.logger.info('Flash Loan Aggregator initialized', {
        weights: aggregatorConfig.weights,
        maxProvidersToRank: aggregatorConfig.maxProvidersToRank,
        enableLiquidityValidation: validator !== null,
      });
    } else {
      this.logger.info('Flash Loan Aggregator disabled - using hardcoded Aave V3 provider');
    }
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

    // Task 2.3: Declare selectedProvider at function scope for metrics tracking
    let selectedProvider: IProviderInfo | null = null;

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

      // Task 2.3: Dynamic flash loan provider selection via aggregator
      if (this.aggregator && opportunity.tokenIn) {
        const selectionStartTime = Date.now();
        try {
          const providerSelection = await this.aggregator.selectProvider(opportunity, {
            chain,
            rpcProviders: ctx.providers,
            estimatedValueUsd: opportunity.expectedProfit ?? 0,
          });

          // Check if selection was successful (protocol !== null)
          if (!providerSelection.isSuccess) {
            this.logger.warn('Aggregator rejected all providers, aborting execution', {
              opportunityId: opportunity.id,
              reason: providerSelection.selectionReason,
            });

            return createErrorResult(
              opportunity.id,
              formatExecutionError(
                ExecutionErrorCode.UNSUPPORTED_PROTOCOL,
                `No suitable flash loan provider: ${providerSelection.selectionReason}`
              ),
              chain,
              opportunity.buyDex || 'unknown'
            );
          }

          // Extract selected protocol
          const selectedProtocol = providerSelection.protocol!;

          // C5 Fix: Validate provider config exists (fail fast if misconfigured)
          const flashLoanConfig = FLASH_LOAN_PROVIDERS[chain];
          if (!flashLoanConfig) {
            this.logger.error('[ERR_CONFIG] Flash loan provider not configured for chain', {
              chain,
              selectedProtocol,
            });
            return createErrorResult(
              opportunity.id,
              formatExecutionError(
                ExecutionErrorCode.UNSUPPORTED_PROTOCOL,
                `Flash loan provider not configured for chain: ${chain}`
              ),
              chain,
              opportunity.buyDex || 'unknown'
            );
          }

          // Store provider info (validated IProviderInfo for metrics)
          selectedProvider = {
            protocol: selectedProtocol,
            chain,
            poolAddress: flashLoanConfig.address,
            feeBps: flashLoanConfig.fee,
            isAvailable: true,
          };

          this.logger.info('Flash loan provider selected via aggregator', {
            opportunityId: opportunity.id,
            protocol: selectedProtocol,
            score: providerSelection.score?.totalScore.toFixed(3),
            reason: providerSelection.selectionReason,
            latencyMs: providerSelection.selectionLatencyMs,
          });

          // Validate selected protocol is supported by this strategy
          if (!SUPPORTED_FLASH_LOAN_PROTOCOLS.has(selectedProtocol)) {
            this.logger.warn('Aggregator selected unsupported protocol', {
              opportunityId: opportunity.id,
              selectedProtocol,
              supportedProtocols: Array.from(SUPPORTED_FLASH_LOAN_PROTOCOLS),
            });

            return createErrorResult(
              opportunity.id,
              formatExecutionError(
                ExecutionErrorCode.UNSUPPORTED_PROTOCOL,
                `Selected protocol '${selectedProtocol}' not supported by this strategy`
              ),
              chain,
              opportunity.buyDex || 'unknown'
            );
          }
        } catch (error) {
          this.logger.error('Flash loan provider selection failed', {
            opportunityId: opportunity.id,
            error: getErrorMessage(error),
          });

          return createErrorResult(
            opportunity.id,
            formatExecutionError(
              ExecutionErrorCode.FLASH_LOAN_ERROR,
              `Provider selection failed: ${getErrorMessage(error)}`
            ),
            chain,
            opportunity.buyDex || 'unknown'
          );
        }
      } else {
        // Aggregator disabled - use hardcoded Aave V3 (backward compatible)
        this.logger.debug('Using hardcoded Aave V3 provider (aggregator disabled)', {
          opportunityId: opportunity.id,
        });
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
        // Task 2.3: Record failed execution in aggregator metrics
        if (this.aggregatorMetrics && selectedProvider) {
          this.aggregatorMetrics.recordOutcome({
            protocol: selectedProvider.protocol,
            success: false,
            executionLatencyMs: 0,
            error: submitResult.error || 'Transaction submission failed',
          });
        }

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

      // Task 2.3: Record successful execution in aggregator metrics
      if (this.aggregatorMetrics && selectedProvider) {
        this.aggregatorMetrics.recordOutcome({
          protocol: selectedProvider.protocol,
          success: true,
          executionLatencyMs: 0, // Not tracking execution time here
        });
      }

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

      // Task 2.3: Record failed execution in aggregator metrics
      if (this.aggregatorMetrics && selectedProvider) {
        this.aggregatorMetrics.recordOutcome({
          protocol: selectedProvider.protocol,
          success: false,
          executionLatencyMs: 0,
          error: errorMessage || 'Unknown error during flash loan execution',
        });
      }

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
    return this.swapBuilder.buildSwapSteps(opportunity, params);
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
   * Task 2.1: Updated to support both Aave V3 and PancakeSwap V3 contracts.
   * - Aave V3: FlashLoanArbitrage.executeArbitrage(asset, amount, swapPath, minProfit)
   * - PancakeSwap V3: PancakeSwapFlashArbitrage.executeArbitrage(pool, asset, amount, swapPath, minProfit, deadline)
   *
   * @param params - Execute arbitrage parameters
   * @returns Encoded calldata
   */
  buildExecuteArbitrageCalldata(params: ExecuteArbitrageParams): string {
    const { asset, amount, swapPath, minProfit, pool } = params;

    // Issue 10.2 Fix: Use cached interface instead of creating new one
    // Convert SwapStep[] to tuple array format for ABI encoding
    const swapPathTuples = swapPath.map(step => [
      step.router,
      step.tokenIn,
      step.tokenOut,
      step.amountOutMin,
    ]);

    // Task 2.1: Use different interface based on protocol
    if (pool) {
      // PancakeSwap V3: Requires pool address and deadline
      const deadline = Math.floor(Date.now() / 1000) + 300; // 5 minutes from now

      return PANCAKESWAP_FLASH_INTERFACE.encodeFunctionData('executeArbitrage', [
        pool,
        asset,
        amount,
        swapPathTuples,
        minProfit,
        deadline,
      ]);
    } else {
      // Aave V3: Standard flash loan
      return FLASH_LOAN_INTERFACE.encodeFunctionData('executeArbitrage', [
        asset,
        amount,
        swapPathTuples,
        minProfit,
      ]);
    }
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
          const router = hop.router || (hop.dex ? this.dexLookup.getRouterAddress(chain, hop.dex) : undefined);
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
      const dexForSell = opportunity.sellDex || opportunity.buyDex;
      const buyRouter = opportunity.buyDex ? this.dexLookup.getRouterAddress(chain, opportunity.buyDex) : undefined;
      const sellRouter = dexForSell ? this.dexLookup.getRouterAddress(chain, dexForSell) : undefined;

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
    // FIX 4.2: Extract to local variable for proper type narrowing
    const buyPrice = opportunity.buyPrice;
    if (!isValidPrice(buyPrice)) {
      throw new Error(
        `[ERR_INVALID_PRICE] Cannot prepare flash loan transaction with invalid buyPrice: ${buyPrice}`
      );
    }

    const tokenPriceUsd = buyPrice; // TypeScript properly narrows to number

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

    // Task 2.1: Discover PancakeSwap V3 pool if needed
    let poolAddress: string | undefined;
    const protocol = FLASH_LOAN_PROVIDERS[chain]?.protocol;
    if (protocol === 'pancakeswap_v3') {
      // Get provider for pool discovery
      const provider = ctx.providers.get(chain);
      if (!provider) {
        throw new Error(`No provider available for chain: ${chain}`);
      }

      // Discover pool for token pair
      const poolInfo = await this.discoverPancakeSwapV3Pool(
        opportunity.tokenIn,
        swapSteps[0]?.tokenOut || opportunity.tokenOut!, // First swap's output token
        chain,
        provider as ethers.JsonRpcProvider
      );

      if (!poolInfo) {
        throw new Error(
          `[ERR_NO_POOL] No PancakeSwap V3 pool found for token pair: ${opportunity.tokenIn} <-> ${opportunity.tokenOut}`
        );
      }

      poolAddress = poolInfo.pool;
      this.logger.debug('Using PancakeSwap V3 pool for flash loan', {
        opportunityId: opportunity.id,
        pool: poolAddress,
        feeTier: poolInfo.feeTier,
      });
    }

    // Build calldata
    const calldata = this.buildExecuteArbitrageCalldata({
      asset: opportunity.tokenIn,
      amount: BigInt(opportunity.amountIn),
      swapPath: swapSteps,
      minProfit: minProfitWei,
      pool: poolAddress, // Task 2.1: Include pool for PancakeSwap V3
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


  // ===========================================================================
  // PancakeSwap V3 Pool Discovery (Task 2.1)
  // ===========================================================================

  /**
   * Discover the best PancakeSwap V3 pool for a token pair.
   *
   * Task 2.1: Pool discovery for PancakeSwap V3 flash loans.
   * PancakeSwap V3 has multiple pools per token pair (different fee tiers).
   * This method queries the factory to find the best available pool.
   *
   * Fee tier preference order: 2500 (0.25%), 500 (0.05%), 10000 (1%), 100 (0.01%)
   *
   * @param tokenA - First token address
   * @param tokenB - Second token address
   * @param chain - Chain identifier
   * @param provider - RPC provider for on-chain queries
   * @returns Pool address and fee tier, or null if no pool found
   */
  private async discoverPancakeSwapV3Pool(
    tokenA: string,
    tokenB: string,
    chain: string,
    provider: ethers.JsonRpcProvider
  ): Promise<{ pool: string; feeTier: number } | null> {
    try {
      // Get factory address for chain
      const factoryAddress = getPancakeSwapV3Factory(chain);

      // Create temporary provider instance for pool discovery
      // Note: We don't need the full contract address or approved routers for discovery
      const tempProvider = new PancakeSwapV3FlashLoanProvider({
        chain,
        poolAddress: factoryAddress, // Factory address
        contractAddress: '0x0000000000000000000000000000000000000000', // Not needed for discovery
        approvedRouters: [], // Not needed for discovery
      });

      // Discover best pool
      const poolInfo = await tempProvider.findBestPool(tokenA, tokenB, provider);

      if (!poolInfo) {
        this.logger.warn('No PancakeSwap V3 pool found for token pair', {
          tokenA,
          tokenB,
          chain,
        });
        return null;
      }

      this.logger.info('Discovered PancakeSwap V3 pool', {
        tokenA,
        tokenB,
        chain,
        pool: poolInfo.pool,
        feeTier: poolInfo.feeTier,
      });

      return poolInfo;
    } catch (error) {
      this.logger.error('Failed to discover PancakeSwap V3 pool', {
        tokenA,
        tokenB,
        chain,
        error: getErrorMessage(error),
      });
      return null;
    }
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
   * Task 2.1: Updated to support both Aave V3 and PancakeSwap V3.
   * Each protocol requires different callback interfaces and contract implementations.
   *
   * @param chain - Chain identifier
   * @returns True if the protocol is supported
   */
  isProtocolSupported(chain: string): boolean {
    // Use pre-computed sets for O(1) lookup
    return AAVE_V3_SUPPORTED_CHAINS.has(chain) || PANCAKESWAP_V3_SUPPORTED_CHAINS.has(chain);
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
   * Task 2.1: Returns chains that support either Aave V3 or PancakeSwap V3.
   *
   * @returns Array of chain identifiers that support any implemented protocol
   */
  getSupportedProtocolChains(): string[] {
    return Array.from(new Set([...AAVE_V3_SUPPORTED_CHAINS, ...PANCAKESWAP_V3_SUPPORTED_CHAINS]));
  }

  // ===========================================================================
  // Task 2.3: Flash Loan Aggregator Metrics
  // ===========================================================================

  /**
   * Check if flash loan aggregator is enabled.
   *
   * @returns True if aggregator is enabled and initialized
   */
  isAggregatorEnabled(): boolean {
    return !!this.aggregator;
  }

  /**
   * Get flash loan aggregator metrics.
   *
   * Returns metrics summary if aggregator is enabled, null otherwise.
   *
   * @returns Aggregator metrics or null
   */
  getAggregatorMetrics(): string | null {
    if (!this.aggregatorMetrics) {
      return null;
    }

    return this.aggregatorMetrics.getMetricsSummary();
  }

  /**
   * Get aggregated metrics as structured data.
   *
   * @returns Aggregated metrics or null if aggregator disabled
   */
  getAggregatedMetricsData(): ReturnType<IAggregatorMetrics['getAggregatedMetrics']> | null {
    if (!this.aggregatorMetrics) {
      return null;
    }

    return this.aggregatorMetrics.getAggregatedMetrics();
  }

  /**
   * Clear aggregator caches (rankings and liquidity).
   *
   * Useful for testing or when market conditions change dramatically.
   */
  clearAggregatorCaches(): void {
    if (this.aggregator) {
      this.aggregator.clearCaches();
      this.logger.info('Aggregator caches cleared');
    }
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
      const dexForSell = opportunity.sellDex || opportunity.buyDex;
      const buyRouter = opportunity.buyDex ? this.dexLookup.getRouterAddress(chain, opportunity.buyDex) : undefined;
      const sellRouter = dexForSell ? this.dexLookup.getRouterAddress(chain, dexForSell) : undefined;

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
          router = this.dexLookup.getRouterAddress(chain, hop.dex);
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
    const dexForSell = opportunity.sellDex || opportunity.buyDex;
    const buyRouter = opportunity.buyDex ? this.dexLookup.getRouterAddress(chain, opportunity.buyDex) : undefined;
    const sellRouter = dexForSell ? this.dexLookup.getRouterAddress(chain, dexForSell) : undefined;

    if (!buyRouter) {
      throw new Error(
        `No router found for buyDex '${opportunity.buyDex}' on chain: ${chain}`
      );
    }

    if (!sellRouter) {
      throw new Error(
        `No router found for sellDex '${dexForSell}' on chain: ${chain}`
      );
    }

    // Build 2-hop path: tokenIn → tokenOut → tokenIn
    return [
      {
        router: buyRouter,
        tokenIn: opportunity.tokenIn!,
        tokenOut: opportunity.tokenOut!,
        amountIn: BigInt(opportunity.amountIn!),
      },
      {
        router: sellRouter,
        tokenIn: opportunity.tokenOut!,
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
