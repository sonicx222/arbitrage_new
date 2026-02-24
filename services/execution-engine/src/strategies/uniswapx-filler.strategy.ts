/**
 * UniswapX Filler Strategy
 *
 * Fills UniswapX Dutch auction orders as an execution strategy.
 * UniswapX orders are off-chain signed intents that specify a Dutch auction
 * decay curve — the fill price starts high and decays over time, creating
 * a natural MEV-resistant price discovery mechanism.
 *
 * ## How UniswapX Filling Works
 *
 * 1. Users sign off-chain orders specifying:
 *    - Input token and amount
 *    - Output token and minimum amount (at auction end)
 *    - Starting output amount (at auction start, higher than minimum)
 *    - Decay start/end timestamps
 *    - Exclusive filler address (for first N seconds, optional)
 *
 * 2. Fillers monitor the UniswapX order API for profitable orders
 *
 * 3. When an order's current decay price is profitable (considering gas + fees),
 *    the filler calls the UniswapX reactor contract to execute the fill
 *
 * 4. The reactor contract:
 *    - Verifies the order signature
 *    - Calculates the current Dutch auction price
 *    - Transfers tokens from user to filler (via permit2)
 *    - Transfers output tokens from filler to user
 *
 * ## Integration with Arbitrage System
 *
 * This strategy integrates with the existing execution engine by:
 * - Accepting opportunities tagged with a `uniswapxOrder` field
 * - Using the same wallet/provider infrastructure
 * - Reporting results through the standard ExecutionResult interface
 *
 * @see https://docs.uniswap.org/contracts/uniswapx/overview
 * @see Phase 2 Item #22: UniswapX filler integration
 */

import { ethers } from 'ethers';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import { generateTraceId, CircuitBreaker, CircuitBreakerError } from '@arbitrage/core';
import { getNativeTokenPrice, CHAINS } from '@arbitrage/config';
import { BaseExecutionStrategy } from './base.strategy';
import type {
  ExecutionResult,
  StrategyContext,
  Logger,
} from '../types';

// =============================================================================
// Types
// =============================================================================

/**
 * A UniswapX Dutch auction order.
 */
export interface UniswapXOrder {
  /** Encoded order bytes (from the UniswapX API) */
  encodedOrder: string;
  /** Order signature from the swapper */
  signature: string;
  /** Chain ID where the order should be filled */
  chainId: number;
  /** Reactor contract address */
  reactorAddress: string;
  /** Input token address */
  inputToken: string;
  /** Input amount in wei */
  inputAmount: string;
  /** Output token address */
  outputToken: string;
  /** Starting output amount (beginning of Dutch auction) */
  outputStartAmount: string;
  /** Ending output amount (minimum, end of Dutch auction) */
  outputEndAmount: string;
  /** Unix timestamp: auction decay start */
  decayStartTime: number;
  /** Unix timestamp: auction decay end */
  decayEndTime: number;
  /** Exclusive filler address (if any) */
  exclusiveFiller?: string;
  /** Exclusivity override BPS (after exclusivity expires) */
  exclusivityOverrideBps?: number;
  /** Nonce for the order */
  nonce: string;
  /** Deadline (Unix timestamp) after which order expires */
  deadline: number;
  /** The swapper's address */
  swapper: string;
  /** Order hash for identification */
  orderHash: string;
}

/**
 * Configuration for the UniswapX filler strategy.
 */
export interface UniswapXFillerConfig {
  /** Minimum profit in USD to attempt a fill (default: 1.0) */
  minProfitUsd?: number;
  /** Maximum gas price in gwei to attempt fills (default: 50) */
  maxGasPriceGwei?: number;
  /** Whether to use flash loans for filling (default: false) */
  useFlashLoan?: boolean;
  /** Reactor contract ABI override (for testing) */
  reactorAbi?: string[];
}

/** UniswapX Reactor ABI for the execute function */
const REACTOR_ABI = [
  'function execute((bytes order, bytes sig)) external',
  'function executeBatch((bytes order, bytes sig)[]) external',
];

// =============================================================================
// Strategy Implementation
// =============================================================================

/**
 * UniswapX filler execution strategy.
 *
 * Fills UniswapX Dutch auction orders by calling the reactor contract.
 * Calculates current Dutch auction price, verifies profitability,
 * and submits the fill transaction.
 */
export class UniswapXFillerStrategy extends BaseExecutionStrategy {
  /**
   * Fix #45: UniswapX is only deployed on Ethereum, Arbitrum, Base, and Polygon.
   * Fills on other chains will revert (no reactor contract), wasting gas.
   * Fix 10: Added 'polygon' — UniswapX V2 is deployed on Polygon.
   */
  private static readonly SUPPORTED_CHAINS = new Set(['ethereum', 'arbitrum', 'base', 'polygon']);

  /**
   * Fix #11: Whitelist of known UniswapX reactor contract addresses.
   * Prevents execution against untrusted reactor contracts that could drain approvals.
   * Addresses are stored lowercase for case-insensitive comparison.
   */
  private static readonly KNOWN_REACTORS = new Set([
    // Ethereum
    '0x6000da47483062a0d734ba3dc7576ce6a0b645c4', // ExclusiveDutchOrderReactor
    '0x00000011f84b9aa48e5f8aa8b9897600006289be', // V2DutchOrderReactor (CREATE2 — same address on all chains incl. Polygon)
    // Arbitrum
    '0x1bd1aAdc9E230626C44a139d7E70d842749351eb'.toLowerCase(), // ExclusiveDutchOrderReactor
    // Base
    '0xe1Ee7F086FfE9Cc1257A06d548fE26F36f18A5Be'.toLowerCase(), // ExclusiveDutchOrderReactor
    // Fix 16: Polygon uses V2DutchOrderReactor (same CREATE2 address as above).
    // If Polygon deploys a separate ExclusiveDutchOrderReactor, add it here.
  ]);

  private readonly fillerConfig: Required<
    Pick<UniswapXFillerConfig, 'minProfitUsd' | 'maxGasPriceGwei' | 'useFlashLoan'>
  > & UniswapXFillerConfig;

  /** Metrics for monitoring fill performance */
  private metrics = {
    fillsAttempted: 0,
    fillsSucceeded: 0,
    fillsFailed: 0,
    fillsSkipped: 0,
    totalProfitUsd: 0,
  };

  /**
   * Fix #44: Circuit breaker for reactor contract execution.
   * Prevents repeated gas waste when the reactor contract is consistently
   * reverting (e.g., due to stale orders or contract issues).
   */
  private readonly reactorCircuitBreaker: CircuitBreaker;

  constructor(logger: Logger, config?: UniswapXFillerConfig) {
    super(logger);
    // P0 Fix #3: Remove ...config spread which overwrites ?? defaults with undefined.
    // Use explicit ?? per field only.
    this.fillerConfig = {
      minProfitUsd: config?.minProfitUsd ?? 1.0,
      maxGasPriceGwei: config?.maxGasPriceGwei ?? 50,
      useFlashLoan: config?.useFlashLoan ?? false,
      reactorAbi: config?.reactorAbi,
    };

    // Fix #44: Circuit breaker for reactor execution.
    // Fix #22: Align with ADR-018 defaults: failureThreshold=5, recoveryTimeout=300s.
    // Previously used 60s recovery (5x shorter than ADR-018 standard).
    this.reactorCircuitBreaker = new CircuitBreaker({
      name: 'uniswapx-reactor',
      failureThreshold: 5,
      recoveryTimeout: 300_000,
      monitoringPeriod: 300_000,
      successThreshold: 2,
    });
  }

  /**
   * Execute a UniswapX fill opportunity.
   *
   * The opportunity must include a `uniswapxOrder` in its metadata
   * or the order details must be derivable from the opportunity fields.
   */
  async execute(
    opportunity: ArbitrageOpportunity,
    ctx: StrategyContext
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    const chain = opportunity.chain ?? 'ethereum';

    // Fix #42: Generate traceId for end-to-end correlation
    const traceId = generateTraceId();

    // Fix #64: Downgrade to debug — this fires on every opportunity evaluation, creating log noise
    this.logger.debug('UniswapX filler: evaluating opportunity', {
      opportunityId: opportunity.id,
      chain,
      tokenIn: opportunity.tokenIn,
      tokenOut: opportunity.tokenOut,
      expectedProfit: opportunity.expectedProfit,
      traceId,
    });

    // Fix #45: UniswapX is only deployed on Ethereum, Arbitrum, and Base
    if (!UniswapXFillerStrategy.SUPPORTED_CHAINS.has(chain)) {
      this.logger.debug('UniswapX filler: chain not supported', {
        opportunityId: opportunity.id,
        chain,
        supportedChains: [...UniswapXFillerStrategy.SUPPORTED_CHAINS],
      });
      return this.createFailureResult(
        opportunity,
        startTime,
        `UniswapX not deployed on '${chain}', supported: ${[...UniswapXFillerStrategy.SUPPORTED_CHAINS].join(', ')}`
      );
    }

    // Validate chain support
    this.validateChain(chain, opportunity.id);

    // Validate context
    const contextCheck = this.validateContext(chain, ctx);
    if (!contextCheck.valid) {
      return this.createFailureResult(opportunity, startTime, contextCheck.error);
    }

    const { wallet, provider } = contextCheck;

    this.metrics.fillsAttempted++;

    // Extract order from opportunity metadata
    // The opportunity should carry the order in an extended field
    const order = this.extractOrder(opportunity);
    if (!order) {
      this.metrics.fillsSkipped++;
      this.logger.debug('UniswapX skipped: no order data', { opportunityId: opportunity.id });
      return this.createFailureResult(
        opportunity,
        startTime,
        'No UniswapX order data found in opportunity'
      );
    }

    // Fix #48: Validate order parameters before execution
    // Fix 1: Cross-check order.chainId against execution chain's numeric ID
    const chainConfig = CHAINS[chain];
    const validationError = this.validateOrder(order, chainConfig?.id);
    if (validationError) {
      this.metrics.fillsSkipped++;
      this.logger.debug('UniswapX skipped: invalid order', { opportunityId: opportunity.id, reason: validationError });
      return this.createFailureResult(
        opportunity,
        startTime,
        `Invalid UniswapX order: ${validationError}`
      );
    }

    // Check if the order has expired
    const now = Math.floor(Date.now() / 1000);
    if (now > order.deadline) {
      this.metrics.fillsSkipped++;
      this.logger.debug('UniswapX skipped: order expired', { opportunityId: opportunity.id, deadline: order.deadline, now });
      return this.createFailureResult(
        opportunity,
        startTime,
        `Order expired: deadline ${order.deadline} < now ${now}`
      );
    }

    // Check exclusivity window
    if (order.exclusiveFiller && order.exclusiveFiller !== ethers.ZeroAddress) {
      const walletAddress = await this.getWalletAddress(wallet);
      if (
        order.exclusiveFiller.toLowerCase() !== walletAddress.toLowerCase() &&
        now < order.decayStartTime
      ) {
        this.metrics.fillsSkipped++;
        this.logger.debug('UniswapX skipped: exclusivity window', { opportunityId: opportunity.id, exclusiveFiller: order.exclusiveFiller });
        return this.createFailureResult(
          opportunity,
          startTime,
          `Order is in exclusivity window for ${order.exclusiveFiller}`
        );
      }
    }

    // Calculate current Dutch auction output amount
    const currentOutputAmount = this.calculateCurrentOutputAmount(order, now);

    // Verify profitability
    const expectedProfit = opportunity.expectedProfit ?? 0;

    if (expectedProfit < this.fillerConfig.minProfitUsd) {
      this.metrics.fillsSkipped++;
      this.logger.debug('UniswapX skipped: profit below minimum', { opportunityId: opportunity.id, expectedProfit, minProfitUsd: this.fillerConfig.minProfitUsd });
      return this.createFailureResult(
        opportunity,
        startTime,
        `Profit ${expectedProfit} below minimum ${this.fillerConfig.minProfitUsd}`
      );
    }

    // Check gas price is reasonable
    const gasPrice = await this.getOptimalGasPrice(chain, ctx);
    // Fix #31: Use floating-point division to avoid BigInt truncation.
    // Integer division truncated 50.9 gwei to 50, passing a 50 gwei check.
    const gasPriceGwei = Number(gasPrice) / 1_000_000_000;
    if (gasPriceGwei > this.fillerConfig.maxGasPriceGwei) {
      this.metrics.fillsSkipped++;
      this.logger.debug('UniswapX skipped: gas price too high', { opportunityId: opportunity.id, gasPriceGwei, maxGasPriceGwei: this.fillerConfig.maxGasPriceGwei });
      return this.createFailureResult(
        opportunity,
        startTime,
        `Gas price ${gasPriceGwei} gwei exceeds max ${this.fillerConfig.maxGasPriceGwei} gwei`
      );
    }

    // Fix #11: Validate reactor address against whitelist before interacting
    if (!UniswapXFillerStrategy.KNOWN_REACTORS.has(order.reactorAddress.toLowerCase())) {
      this.metrics.fillsSkipped++;
      this.logger.debug('UniswapX skipped: unknown reactor', { opportunityId: opportunity.id, reactorAddress: order.reactorAddress });
      return this.createFailureResult(
        opportunity,
        startTime,
        `Unknown reactor address ${order.reactorAddress} — not in whitelist`
      );
    }

    // Fix #44: Check reactor circuit breaker before attempting execution
    if (this.reactorCircuitBreaker.getState() === 'OPEN') {
      this.metrics.fillsSkipped++;
      return this.createFailureResult(
        opportunity,
        startTime,
        'Reactor circuit breaker is OPEN — skipping fill'
      );
    }

    try {
      // Fix #44: Wrap reactor execution in circuit breaker
      return await this.reactorCircuitBreaker.execute(async () => {
        // Build the fill transaction
        const reactorContract = new ethers.Contract(
          order.reactorAddress,
          this.fillerConfig.reactorAbi ?? REACTOR_ABI,
          wallet.connect(provider)
        );

        // Encode the execute call with the order and signature
        const fillTx = await reactorContract.execute.populateTransaction({
          order: order.encodedOrder,
          sig: order.signature,
        });

        // Apply MEV protection (fills are MEV-sensitive on Ethereum)
        const protectedTx = await this.applyMEVProtection(fillTx, chain, ctx);

        // Hybrid mode support (for testing)
        if (this.isHybridMode()) {
          const hybridResult = await this.createHybridModeResult(
            protectedTx,
            chain,
            {
              opportunityId: opportunity.id,
              expectedProfit,
              initialGasPrice: gasPrice,
            }
          );

          if (hybridResult.success) {
            this.metrics.fillsSucceeded++;
            // Fix #15: Deduct gas cost from profit metrics.
            // Fix #10: Use centralized getNativeTokenPrice() instead of hardcoded $3000.
            const nativePriceUsd = getNativeTokenPrice(chain);
            const estimatedGasCostUsd = hybridResult.receipt
              ? Number(ethers.formatEther(
                  hybridResult.receipt.gasUsed * (hybridResult.receipt.gasPrice ?? 0n)
                )) * nativePriceUsd
              : 0;
            this.metrics.totalProfitUsd += expectedProfit - estimatedGasCostUsd;
          } else {
            this.metrics.fillsFailed++;
          }

          return this.createResultFromSubmission(
            opportunity,
            startTime,
            hybridResult,
            chain,
            currentOutputAmount
          );
        }

        // Submit the fill transaction
        const submission = await this.submitTransaction(
          protectedTx,
          chain,
          ctx,
          {
            opportunityId: opportunity.id,
            expectedProfit,
            initialGasPrice: gasPrice,
          }
        );

        if (submission.success) {
          this.metrics.fillsSucceeded++;
          // Fix #15: Deduct gas cost from profit metrics.
          // Fix #10: Use centralized getNativeTokenPrice() instead of hardcoded $3000.
          const nativePriceEstimate = getNativeTokenPrice(chain);
          const gasCostUsd = submission.receipt
            ? Number(ethers.formatEther(
                submission.receipt.gasUsed * (submission.receipt.gasPrice ?? 0n)
              )) * nativePriceEstimate
            : 0;
          this.metrics.totalProfitUsd += expectedProfit - gasCostUsd;

          this.logger.info('UniswapX fill succeeded', {
            opportunityId: opportunity.id,
            txHash: submission.txHash,
            outputAmount: currentOutputAmount.toString(),
            profit: expectedProfit,
            traceId,
          });
        } else {
          this.metrics.fillsFailed++;

          this.logger.warn('UniswapX fill failed', {
            opportunityId: opportunity.id,
            error: submission.error,
            traceId,
          });
        }

        return this.createResultFromSubmission(
          opportunity,
          startTime,
          submission,
          chain,
          currentOutputAmount
        );
      });
    } catch (error) {
      // Fix #44: Handle circuit breaker open errors gracefully
      if (error instanceof CircuitBreakerError) {
        this.metrics.fillsSkipped++;
        return this.createFailureResult(
          opportunity,
          startTime,
          `Circuit breaker: ${error.message}`
        );
      }

      this.metrics.fillsFailed++;
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.error('UniswapX fill execution error', {
        opportunityId: opportunity.id,
        error: errorMessage,
        traceId,
      });

      return this.createFailureResult(opportunity, startTime, errorMessage);
    }
  }

  /**
   * Calculate the current Dutch auction output amount based on time decay.
   *
   * Linear interpolation between startAmount and endAmount:
   *   current = start - (start - end) * elapsed / duration
   *
   * Before decay start: returns startAmount
   * After decay end: returns endAmount
   */
  calculateCurrentOutputAmount(order: UniswapXOrder, nowSeconds: number): bigint {
    const startAmount = BigInt(order.outputStartAmount);
    const endAmount = BigInt(order.outputEndAmount);

    if (nowSeconds <= order.decayStartTime) {
      return startAmount;
    }

    if (nowSeconds >= order.decayEndTime) {
      return endAmount;
    }

    const elapsed = BigInt(nowSeconds - order.decayStartTime);
    const duration = BigInt(order.decayEndTime - order.decayStartTime);

    // Linear decay: start - (start - end) * elapsed / duration
    const decay = (startAmount - endAmount) * elapsed / duration;
    return startAmount - decay;
  }

  /**
   * Extract UniswapX order from an opportunity.
   *
   * The order can be embedded in the opportunity via an extended field.
   * Returns null if no order data is found.
   */
  private extractOrder(opportunity: ArbitrageOpportunity): UniswapXOrder | null {
    // Fix 14: Return opportunity.uniswapxOrder directly — the inline type in
    // ArbitrageOpportunity (shared/types) is structurally identical to UniswapXOrder.
    if (opportunity.uniswapxOrder) {
      return opportunity.uniswapxOrder;
    }

    return null;
  }

  /**
   * Fix #48: Validate UniswapX order parameters before execution.
   * Returns null if valid, or an error string describing the issue.
   *
   * @param order - The order to validate
   * @param expectedChainId - Numeric chain ID of the execution chain (from CHAINS config)
   */
  private validateOrder(order: UniswapXOrder, expectedChainId?: number): string | null {
    if (!order.encodedOrder || !order.signature) {
      return 'Missing encodedOrder or signature';
    }
    if (!order.reactorAddress) {
      return 'Missing reactor address';
    }
    // Fix 1: Validate order chain ID matches the execution chain
    if (expectedChainId !== undefined && order.chainId !== expectedChainId) {
      return `Chain ID mismatch: order has ${order.chainId}, expected ${expectedChainId}`;
    }
    if (order.decayStartTime >= order.decayEndTime) {
      return `Invalid decay range: start ${order.decayStartTime} >= end ${order.decayEndTime}`;
    }
    if (!order.inputToken || !order.outputToken) {
      return 'Missing input or output token address';
    }
    return null; // valid
  }

  /**
   * Fix #29: Delegate to base class createBaseResultFromSubmission.
   * UniswapX uses fixed 'uniswapx' dex label and no profit multiplier
   * (no MEV-Share refund deduction — UniswapX fills earn full spread).
   */
  private createResultFromSubmission(
    opportunity: ArbitrageOpportunity,
    startTime: number,
    submission: {
      success: boolean;
      receipt?: ethers.TransactionReceipt;
      txHash?: string;
      error?: string;
      nonce?: number;
      usedMevProtection?: boolean;
    },
    chain: string,
    _outputAmount: bigint
  ): ExecutionResult {
    return this.createBaseResultFromSubmission(
      opportunity,
      startTime,
      submission,
      chain,
      { dex: 'uniswapx' }
    );
  }

  /**
   * Fix #29: Delegate to base class createBaseFailureResult with 'uniswapx' dex label.
   */
  private createFailureResult(
    opportunity: ArbitrageOpportunity,
    startTime: number,
    error: string
  ): ExecutionResult {
    return this.createBaseFailureResult(opportunity, startTime, error, 'uniswapx');
  }

  /**
   * Get filler strategy metrics.
   */
  getFillerMetrics(): typeof this.metrics {
    return { ...this.metrics };
  }

  /**
   * Fix #44: Get reactor circuit breaker for monitoring or testing.
   */
  getReactorCircuitBreaker(): CircuitBreaker {
    return this.reactorCircuitBreaker;
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a UniswapX filler strategy.
 */
export function createUniswapXFillerStrategy(
  logger: Logger,
  config?: UniswapXFillerConfig
): UniswapXFillerStrategy {
  return new UniswapXFillerStrategy(logger, config);
}
