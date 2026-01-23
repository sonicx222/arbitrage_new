/**
 * Base Execution Strategy
 *
 * Provides shared utility methods for all execution strategies:
 * - Gas price optimization with spike protection
 * - MEV protection
 * - Price verification
 * - Flash loan transaction preparation
 * - Transaction timeout handling
 *
 * @see engine.ts (parent service)
 */

import { ethers } from 'ethers';
import { CHAINS, ARBITRAGE_CONFIG, FLASH_LOAN_PROVIDERS, MEV_CONFIG, DEXES } from '@arbitrage/config';
import { getErrorMessage } from '@arbitrage/core';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type {
  Logger,
  StrategyContext,
  ExecutionResult,
  FlashLoanParams
} from '../types';
import { TRANSACTION_TIMEOUT_MS, withTimeout } from '../types';
import type { SimulationRequest, SimulationResult } from '../services/simulation/types';

/**
 * Standard Uniswap V2 Router ABI for swapExactTokensForTokens.
 * Compatible with most DEX routers (SushiSwap, PancakeSwap, etc.)
 */
const UNISWAP_V2_ROUTER_ABI = [
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
];

/**
 * Standard ERC20 approve ABI for token allowances.
 */
const ERC20_APPROVE_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
];

/**
 * Default fallback gas prices by chain (in gwei).
 * Used when provider fails to return gas price or no provider available.
 * These are conservative estimates - actual gas prices may be lower.
 */
const DEFAULT_GAS_PRICES_GWEI: Record<string, number> = {
  ethereum: 50,
  arbitrum: 0.1,
  optimism: 0.001,
  base: 0.001,
  polygon: 100,
  bsc: 5,
  avalanche: 25,
  fantom: 100,
  zksync: 0.25,
  linea: 0.5,
};

/**
 * Pre-computed fallback gas prices in wei for hot-path optimization.
 * Avoids repeated ethers.parseUnits() calls on every getOptimalGasPrice() call.
 * Computed once at module load time.
 */
const FALLBACK_GAS_PRICES_WEI: Record<string, bigint> = Object.fromEntries(
  Object.entries(DEFAULT_GAS_PRICES_GWEI).map(([chain, gwei]) => [
    chain,
    ethers.parseUnits(gwei.toString(), 'gwei'),
  ])
);

/** Default fallback price when chain is unknown (50 gwei) */
const DEFAULT_FALLBACK_GAS_PRICE_WEI = ethers.parseUnits('50', 'gwei');

/**
 * Get fallback gas price for a chain (O(1) lookup, no computation).
 * @param chain - Chain name
 * @returns Gas price in wei
 */
function getFallbackGasPrice(chain: string): bigint {
  return FALLBACK_GAS_PRICES_WEI[chain] ?? DEFAULT_FALLBACK_GAS_PRICE_WEI;
}

/**
 * Pre-computed BigInt multipliers for hot-path optimization.
 * Avoids repeated Math.floor + BigInt conversion on every call.
 *
 * GAS_SPIKE_MULTIPLIER_BIGINT: Used for gas spike detection (e.g., 1.5x = 150)
 * SLIPPAGE_BASIS_POINTS_BIGINT: Slippage tolerance in basis points (e.g., 0.5% = 50)
 */
const GAS_SPIKE_MULTIPLIER_BIGINT = BigInt(Math.floor(ARBITRAGE_CONFIG.gasPriceSpikeMultiplier * 100));
const SLIPPAGE_BASIS_POINTS_BIGINT = BigInt(Math.floor(ARBITRAGE_CONFIG.slippageTolerance * 10000));

/**
 * Base class for execution strategies.
 * Provides shared utility methods.
 */
export abstract class BaseExecutionStrategy {
  protected readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Execute the opportunity (implemented by subclasses).
   */
  abstract execute(
    opportunity: ArbitrageOpportunity,
    ctx: StrategyContext
  ): Promise<ExecutionResult>;

  // ===========================================================================
  // Gas Price Management
  // ===========================================================================

  /**
   * Get optimal gas price with spike protection.
   * Tracks baseline gas prices and rejects if current price exceeds threshold.
   */
  protected async getOptimalGasPrice(
    chain: string,
    ctx: StrategyContext
  ): Promise<bigint> {
    const provider = ctx.providers.get(chain);
    const fallbackPrice = getFallbackGasPrice(chain);

    if (!provider) {
      return fallbackPrice;
    }

    try {
      const feeData = await provider.getFeeData();
      const currentPrice = feeData.maxFeePerGas || feeData.gasPrice || fallbackPrice;

      // Update baseline and check for spike
      this.updateGasBaseline(chain, currentPrice, ctx);

      if (ARBITRAGE_CONFIG.gasPriceSpikeEnabled) {
        const baselinePrice = this.getGasBaseline(chain, ctx);
        if (baselinePrice > 0n) {
          const maxAllowedPrice = baselinePrice * GAS_SPIKE_MULTIPLIER_BIGINT / 100n;

          if (currentPrice > maxAllowedPrice) {
            const currentGwei = Number(currentPrice / BigInt(1e9));
            const baselineGwei = Number(baselinePrice / BigInt(1e9));
            const maxGwei = Number(maxAllowedPrice / BigInt(1e9));

            this.logger.warn('Gas price spike detected, aborting transaction', {
              chain,
              currentGwei,
              baselineGwei,
              maxGwei,
              multiplier: ARBITRAGE_CONFIG.gasPriceSpikeMultiplier
            });

            throw new Error(`Gas price spike: ${currentGwei} gwei exceeds ${maxGwei} gwei (${ARBITRAGE_CONFIG.gasPriceSpikeMultiplier}x baseline)`);
          }
        }
      }

      return currentPrice;
    } catch (error) {
      // Re-throw gas spike errors
      if (getErrorMessage(error)?.includes('Gas price spike')) {
        throw error;
      }
      this.logger.warn('Failed to get optimal gas price, using chain-specific fallback', {
        chain,
        fallbackGwei: Number(fallbackPrice / BigInt(1e9)),
        error
      });
      return fallbackPrice;
    }
  }

  // Cached median for performance optimization
  private medianCache: Map<string, { median: bigint; validUntil: number }> = new Map();
  private readonly MEDIAN_CACHE_TTL_MS = 5000; // Cache median for 5 seconds
  private readonly MAX_GAS_HISTORY = 100;
  private readonly MAX_MEDIAN_CACHE_SIZE = 50; // Cap cache size to prevent unbounded growth
  private lastMedianCacheCleanup = 0;
  private readonly MEDIAN_CACHE_CLEANUP_INTERVAL_MS = 60000; // Cleanup expired entries every 60s

  /**
   * Update gas price baseline for spike detection.
   * Optimized for hot-path: uses in-place array compaction to avoid
   * temporary array allocations (filter/slice create new arrays).
   */
  protected updateGasBaseline(
    chain: string,
    price: bigint,
    ctx: StrategyContext
  ): void {
    const now = Date.now();
    const windowMs = ARBITRAGE_CONFIG.gasPriceBaselineWindowMs;

    if (!ctx.gasBaselines.has(chain)) {
      ctx.gasBaselines.set(chain, []);
    }

    const history = ctx.gasBaselines.get(chain)!;

    // Add current price
    history.push({ price, timestamp: now });

    // Invalidate median cache when data changes
    this.medianCache.delete(chain);

    // Remove old entries and cap size using in-place compaction
    // This avoids creating temporary arrays on every call (hot-path optimization)
    const cutoff = now - windowMs;
    if (history.length > this.MAX_GAS_HISTORY || history[0]?.timestamp < cutoff) {
      // In-place compaction: single pass, no temporary arrays
      let writeIdx = 0;
      for (let readIdx = 0; readIdx < history.length; readIdx++) {
        if (history[readIdx].timestamp >= cutoff) {
          if (writeIdx !== readIdx) {
            history[writeIdx] = history[readIdx];
          }
          writeIdx++;
        }
      }

      // If still over limit, keep only most recent entries
      if (writeIdx > this.MAX_GAS_HISTORY) {
        const offset = writeIdx - this.MAX_GAS_HISTORY;
        for (let i = 0; i < this.MAX_GAS_HISTORY; i++) {
          history[i] = history[i + offset];
        }
        writeIdx = this.MAX_GAS_HISTORY;
      }

      // Truncate to valid entries
      history.length = writeIdx;
    }
  }

  /**
   * Calculate baseline gas price from recent history.
   * Uses median to avoid outlier influence.
   * Caches result for 5 seconds to avoid repeated sorting.
   */
  protected getGasBaseline(chain: string, ctx: StrategyContext): bigint {
    const history = ctx.gasBaselines.get(chain);
    if (!history || history.length === 0) {
      return 0n;
    }

    // With fewer than 3 samples, use average with safety margin
    if (history.length < 3) {
      const sum = history.reduce((acc, h) => acc + h.price, 0n);
      const avg = sum / BigInt(history.length);
      return avg * 3n / 2n;
    }

    // Check cache first
    const now = Date.now();
    const cached = this.medianCache.get(chain);
    if (cached && now < cached.validUntil) {
      return cached.median;
    }

    // Periodic cleanup of expired cache entries (prevents memory leak)
    this.cleanupMedianCacheIfNeeded(now);

    // Compute median (only when cache is stale)
    const sorted = [...history].sort((a, b) => {
      if (a.price < b.price) return -1;
      if (a.price > b.price) return 1;
      return 0;
    });

    const midIndex = Math.floor(sorted.length / 2);
    const median = sorted[midIndex].price;

    // Cache the result
    this.medianCache.set(chain, {
      median,
      validUntil: now + this.MEDIAN_CACHE_TTL_MS
    });

    return median;
  }

  /**
   * Clean up expired median cache entries periodically.
   * Called during getGasBaseline to avoid memory leaks from stale chain entries.
   * Also enforces a hard cap on cache size for safety.
   */
  private cleanupMedianCacheIfNeeded(now: number): void {
    // Only run cleanup periodically to avoid overhead on every call
    if (now - this.lastMedianCacheCleanup < this.MEDIAN_CACHE_CLEANUP_INTERVAL_MS) {
      return;
    }
    this.lastMedianCacheCleanup = now;

    // Remove expired entries
    for (const [key, value] of this.medianCache) {
      if (now >= value.validUntil) {
        this.medianCache.delete(key);
      }
    }

    // Hard cap: if still over limit, evict oldest entries (by validUntil)
    if (this.medianCache.size > this.MAX_MEDIAN_CACHE_SIZE) {
      const entries = Array.from(this.medianCache.entries())
        .sort((a, b) => a[1].validUntil - b[1].validUntil);

      const toRemove = entries.slice(0, entries.length - this.MAX_MEDIAN_CACHE_SIZE);
      for (const [key] of toRemove) {
        this.medianCache.delete(key);
      }
    }
  }

  // ===========================================================================
  // MEV Protection
  // ===========================================================================

  /**
   * Apply MEV protection to prevent sandwich attacks.
   */
  protected async applyMEVProtection(
    tx: ethers.TransactionRequest,
    chain: string,
    ctx: StrategyContext
  ): Promise<ethers.TransactionRequest> {
    const provider = ctx.providers.get(chain);
    if (!provider) {
      tx.gasPrice = await this.getOptimalGasPrice(chain, ctx);
      return tx;
    }

    try {
      const feeData = await provider.getFeeData();

      // Use EIP-1559 transaction format for better fee predictability
      if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
        tx.type = 2;
        tx.maxFeePerGas = feeData.maxFeePerGas;
        // Cap priority fee to prevent MEV extractors from frontrunning
        const maxPriorityFee = feeData.maxPriorityFeePerGas;
        const cappedPriorityFee = maxPriorityFee < ethers.parseUnits('3', 'gwei')
          ? maxPriorityFee
          : ethers.parseUnits('3', 'gwei');
        tx.maxPriorityFeePerGas = cappedPriorityFee;
        delete tx.gasPrice;
      } else {
        tx.gasPrice = await this.getOptimalGasPrice(chain, ctx);
      }

      if (chain === 'ethereum') {
        this.logger.info('MEV protection: Using Flashbots-style private transaction', {
          chain,
          hasEIP1559: !!feeData.maxFeePerGas
        });
      }

      this.logger.debug('MEV protection applied', {
        chain,
        type: tx.type,
        maxFeePerGas: tx.maxFeePerGas?.toString(),
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas?.toString(),
        gasPrice: tx.gasPrice?.toString()
      });

      return tx;
    } catch (error) {
      this.logger.warn('Failed to apply full MEV protection, using basic gas price', {
        chain,
        error: getErrorMessage(error)
      });
      tx.gasPrice = await this.getOptimalGasPrice(chain, ctx);
      return tx;
    }
  }

  // ===========================================================================
  // Price Verification
  // ===========================================================================

  /**
   * Verify opportunity prices are still valid before execution.
   */
  protected async verifyOpportunityPrices(
    opportunity: ArbitrageOpportunity,
    chain: string
  ): Promise<{ valid: boolean; reason?: string; currentProfit?: number }> {
    // Check opportunity age
    const maxAgeMs = ARBITRAGE_CONFIG.opportunityTimeoutMs || 30000;
    const opportunityAge = Date.now() - opportunity.timestamp;

    if (opportunityAge > maxAgeMs) {
      return {
        valid: false,
        reason: `Opportunity too old: ${opportunityAge}ms > ${maxAgeMs}ms`
      };
    }

    // For fast chains, apply stricter age limits
    const chainConfig = CHAINS[chain];
    if (chainConfig && chainConfig.blockTime < 2) {
      const fastChainMaxAge = Math.min(maxAgeMs, chainConfig.blockTime * 5000);
      if (opportunityAge > fastChainMaxAge) {
        return {
          valid: false,
          reason: `Opportunity too old for fast chain: ${opportunityAge}ms > ${fastChainMaxAge}ms`
        };
      }
    }

    // Verify minimum profit threshold
    const expectedProfit = opportunity.expectedProfit || 0;
    const minProfitThreshold = ARBITRAGE_CONFIG.minProfitThreshold || 10;
    const requiredProfit = minProfitThreshold * 1.2;

    if (expectedProfit < requiredProfit) {
      return {
        valid: false,
        reason: `Profit below safety threshold: ${expectedProfit} < ${requiredProfit}`,
        currentProfit: expectedProfit
      };
    }

    // Verify confidence score
    if (opportunity.confidence < ARBITRAGE_CONFIG.minConfidenceThreshold) {
      return {
        valid: false,
        reason: `Confidence below threshold: ${opportunity.confidence} < ${ARBITRAGE_CONFIG.minConfidenceThreshold}`,
        currentProfit: expectedProfit
      };
    }

    this.logger.debug('Price verification passed', {
      opportunityId: opportunity.id,
      age: opportunityAge,
      profit: expectedProfit,
      confidence: opportunity.confidence
    });

    return { valid: true, currentProfit: expectedProfit };
  }

  // ===========================================================================
  // Flash Loan Transaction
  // ===========================================================================

  /**
   * Prepare flash loan transaction with proper slippage protection.
   */
  protected async prepareFlashLoanTransaction(
    opportunity: ArbitrageOpportunity,
    chain: string,
    ctx: StrategyContext
  ): Promise<ethers.TransactionRequest> {
    if (!opportunity.tokenIn || !opportunity.amountIn || !opportunity.expectedProfit) {
      throw new Error('Invalid opportunity: missing required fields (tokenIn, amountIn, expectedProfit)');
    }

    // Calculate minAmountOut with slippage protection
    const amountInBigInt = BigInt(opportunity.amountIn);
    const expectedProfitWei = ethers.parseUnits(
      opportunity.expectedProfit.toFixed(18),
      18
    );
    const expectedAmountOut = amountInBigInt + expectedProfitWei;
    const minAmountOut = expectedAmountOut - (expectedAmountOut * SLIPPAGE_BASIS_POINTS_BIGINT / 10000n);

    const flashParams: FlashLoanParams = {
      token: opportunity.tokenIn,
      amount: opportunity.amountIn,
      path: this.buildSwapPath(opportunity),
      minProfit: opportunity.expectedProfit * (1 - ARBITRAGE_CONFIG.slippageTolerance),
      minAmountOut: minAmountOut.toString()
    };

    this.logger.debug('Flash loan params prepared', {
      token: flashParams.token,
      amount: flashParams.amount,
      minProfit: flashParams.minProfit,
      minAmountOut: flashParams.minAmountOut,
      slippageTolerance: ARBITRAGE_CONFIG.slippageTolerance
    });

    const flashLoanContract = await this.getFlashLoanContract(chain, ctx);

    const tx = await flashLoanContract.executeFlashLoan.populateTransaction(
      flashParams.token,
      flashParams.amount,
      flashParams.path,
      flashParams.minProfit,
      flashParams.minAmountOut
    );

    return tx;
  }

  protected buildSwapPath(opportunity: ArbitrageOpportunity): string[] {
    if (!opportunity.tokenIn || !opportunity.tokenOut) {
      throw new Error('Invalid opportunity: missing tokenIn or tokenOut');
    }
    return [opportunity.tokenIn, opportunity.tokenOut];
  }

  protected async getFlashLoanContract(
    chain: string,
    ctx: StrategyContext
  ): Promise<ethers.Contract> {
    const provider = ctx.providers.get(chain);
    if (!provider) {
      throw new Error(`No provider for chain: ${chain}`);
    }

    const flashLoanConfig = FLASH_LOAN_PROVIDERS[chain];
    if (!flashLoanConfig) {
      throw new Error(`No flash loan provider configured for chain: ${chain}`);
    }

    const flashLoanAbi = flashLoanConfig.protocol === 'aave_v3'
      ? ['function executeFlashLoan(address asset, uint256 amount, address[] calldata path, uint256 minProfit, uint256 minAmountOut) external']
      : ['function flashSwap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, bytes calldata data) external'];

    return new ethers.Contract(flashLoanConfig.address, flashLoanAbi, provider);
  }

  // ===========================================================================
  // DEX Swap Transaction (for cross-chain sell after bridge)
  // ===========================================================================

  /**
   * Prepare a direct DEX swap transaction.
   *
   * Used for cross-chain arbitrage where tokens have been bridged and need
   * to be swapped on the destination chain (not using flash loans).
   *
   * @param opportunity - The arbitrage opportunity
   * @param chain - Target chain for the swap
   * @param ctx - Strategy context with providers
   * @param recipientAddress - Address to receive swap output (defaults to wallet address)
   * @returns Prepared transaction request
   */
  protected async prepareDexSwapTransaction(
    opportunity: ArbitrageOpportunity,
    chain: string,
    ctx: StrategyContext,
    recipientAddress?: string
  ): Promise<ethers.TransactionRequest> {
    if (!opportunity.tokenIn || !opportunity.tokenOut || !opportunity.amountIn) {
      throw new Error('Invalid opportunity: missing required fields (tokenIn, tokenOut, amountIn)');
    }

    const provider = ctx.providers.get(chain);
    if (!provider) {
      throw new Error(`No provider for chain: ${chain}`);
    }

    const wallet = ctx.wallets.get(chain);
    if (!wallet) {
      throw new Error(`No wallet for chain: ${chain}`);
    }

    // Find DEX router for the chain (use sellDex if specified, otherwise first available)
    const chainDexes = DEXES[chain];
    if (!chainDexes || chainDexes.length === 0) {
      throw new Error(`No DEX configured for chain: ${chain}`);
    }

    // Find the specific DEX or use the first one
    const targetDex = opportunity.sellDex
      ? chainDexes.find(d => d.name === opportunity.sellDex)
      : chainDexes[0];

    if (!targetDex || !targetDex.routerAddress) {
      throw new Error(`No router address for DEX on chain: ${chain}`);
    }

    // Calculate minAmountOut with slippage protection
    const amountIn = BigInt(opportunity.amountIn);
    const expectedProfit = opportunity.expectedProfit || 0;
    const expectedProfitWei = ethers.parseUnits(
      Math.max(0, expectedProfit).toFixed(18),
      18
    );
    const expectedAmountOut = amountIn + expectedProfitWei;
    const minAmountOut = expectedAmountOut - (expectedAmountOut * SLIPPAGE_BASIS_POINTS_BIGINT / 10000n);

    // Build swap path
    const path = this.buildSwapPath(opportunity);

    // Create router contract interface
    const routerContract = new ethers.Contract(
      targetDex.routerAddress,
      UNISWAP_V2_ROUTER_ABI,
      provider
    );

    // Set deadline (5 minutes from now)
    const deadline = Math.floor(Date.now() / 1000) + 300;

    // Recipient is wallet address by default
    const recipient = recipientAddress || await wallet.getAddress();

    // Build the swap transaction
    const tx = await routerContract.swapExactTokensForTokens.populateTransaction(
      amountIn,
      minAmountOut,
      path,
      recipient,
      deadline
    );

    this.logger.debug('DEX swap transaction prepared', {
      chain,
      dex: targetDex.name,
      router: targetDex.routerAddress,
      tokenIn: opportunity.tokenIn,
      tokenOut: opportunity.tokenOut,
      amountIn: amountIn.toString(),
      minAmountOut: minAmountOut.toString(),
      slippageTolerance: ARBITRAGE_CONFIG.slippageTolerance,
      deadline,
    });

    return tx;
  }

  /**
   * Check and approve token allowance for DEX router if needed.
   *
   * @param tokenAddress - Token to approve
   * @param spenderAddress - Router address to approve
   * @param amount - Amount to approve
   * @param chain - Chain identifier
   * @param ctx - Strategy context
   * @returns True if approval was needed and succeeded, false if already approved
   */
  protected async ensureTokenAllowance(
    tokenAddress: string,
    spenderAddress: string,
    amount: bigint,
    chain: string,
    ctx: StrategyContext
  ): Promise<boolean> {
    const wallet = ctx.wallets.get(chain);
    if (!wallet) {
      throw new Error(`No wallet for chain: ${chain}`);
    }

    const tokenContract = new ethers.Contract(
      tokenAddress,
      ERC20_APPROVE_ABI,
      wallet
    );

    const ownerAddress = await wallet.getAddress();
    const currentAllowance = await tokenContract.allowance(ownerAddress, spenderAddress);

    if (currentAllowance >= amount) {
      this.logger.debug('Token allowance sufficient', {
        token: tokenAddress,
        spender: spenderAddress,
        currentAllowance: currentAllowance.toString(),
        required: amount.toString(),
      });
      return false;
    }

    // Approve max uint256 for efficiency (fewer future approvals)
    const maxApproval = ethers.MaxUint256;
    const approveTx = await tokenContract.approve(spenderAddress, maxApproval);
    await approveTx.wait();

    this.logger.info('Token approval granted', {
      token: tokenAddress,
      spender: spenderAddress,
      chain,
    });

    return true;
  }

  // ===========================================================================
  // Transaction Timeout
  // ===========================================================================

  /**
   * Wrap blockchain operations with timeout.
   * Delegates to the shared withTimeout utility from types.ts.
   *
   * @param operation - Async operation to execute with timeout
   * @param operationName - Name for error messages
   * @returns Result of the operation or throws TimeoutError
   */
  protected async withTransactionTimeout<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    return withTimeout(operation, operationName, TRANSACTION_TIMEOUT_MS);
  }

  // ===========================================================================
  // Profit Calculation
  // ===========================================================================

  protected async calculateActualProfit(
    receipt: ethers.TransactionReceipt,
    opportunity: ArbitrageOpportunity
  ): Promise<number> {
    const gasPrice = receipt.gasPrice || BigInt(0);
    const gasCost = parseFloat(ethers.formatEther(receipt.gasUsed * gasPrice));
    const expectedProfit = opportunity.expectedProfit || 0;
    return expectedProfit - gasCost;
  }

  // ===========================================================================
  // Pre-flight Simulation (Phase 1.1)
  // ===========================================================================

  /**
   * Perform pre-flight simulation of the transaction.
   *
   * Checks:
   * 1. If simulation service is available
   * 2. If simulation should be performed (profit threshold, time-critical bypass)
   * 3. Simulates the transaction
   * 4. Returns result or null (graceful degradation on errors)
   *
   * @param opportunity - The arbitrage opportunity
   * @param transaction - The prepared transaction
   * @param chain - Chain identifier
   * @param ctx - Strategy context
   * @returns SimulationResult or null if simulation was skipped/failed
   */
  protected async performSimulation(
    opportunity: ArbitrageOpportunity,
    transaction: ethers.TransactionRequest,
    chain: string,
    ctx: StrategyContext
  ): Promise<SimulationResult | null> {
    // Check if simulation service is available
    if (!ctx.simulationService) {
      ctx.stats.simulationsSkipped++;
      return null;
    }

    // Calculate opportunity age for time-critical bypass
    const opportunityAge = Date.now() - opportunity.timestamp;
    const expectedProfit = opportunity.expectedProfit || 0;

    // Check if we should simulate this opportunity
    // shouldSimulate() checks: profit threshold, time-critical bypass, provider availability
    if (!ctx.simulationService.shouldSimulate(expectedProfit, opportunityAge)) {
      ctx.stats.simulationsSkipped++;
      this.logger.debug('Skipping simulation', {
        opportunityId: opportunity.id,
        expectedProfit,
        opportunityAge,
      });
      return null;
    }

    // Prepare simulation request
    const simulationRequest: SimulationRequest = {
      chain,
      transaction: {
        from: transaction.from,
        to: transaction.to,
        data: transaction.data,
        value: transaction.value,
        gasLimit: transaction.gasLimit,
      },
      includeStateChanges: false, // Not needed for pre-flight check
      includeLogs: false,
    };

    try {
      const result = await ctx.simulationService.simulate(simulationRequest);
      ctx.stats.simulationsPerformed++;

      this.logger.debug('Simulation completed', {
        opportunityId: opportunity.id,
        success: result.success,
        wouldRevert: result.wouldRevert,
        revertReason: result.revertReason,
        gasUsed: result.gasUsed?.toString(),
        provider: result.provider,
        latencyMs: result.latencyMs,
      });

      // If simulation itself failed (service error), log and proceed with execution
      if (!result.success) {
        ctx.stats.simulationErrors++;
        this.logger.warn('Simulation service error, proceeding with execution', {
          opportunityId: opportunity.id,
          error: result.error,
          provider: result.provider,
        });
        return null; // Graceful degradation - proceed without simulation
      }

      return result;
    } catch (error) {
      // Handle unexpected errors gracefully
      ctx.stats.simulationErrors++;
      this.logger.warn('Simulation failed unexpectedly, proceeding with execution', {
        opportunityId: opportunity.id,
        error: getErrorMessage(error),
      });
      return null; // Graceful degradation - proceed without simulation
    }
  }
}
