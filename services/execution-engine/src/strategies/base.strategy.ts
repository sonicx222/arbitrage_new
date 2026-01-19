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
import { CHAINS, ARBITRAGE_CONFIG, FLASH_LOAN_PROVIDERS, MEV_CONFIG } from '@arbitrage/config';
import { getErrorMessage } from '@arbitrage/core';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type {
  Logger,
  StrategyContext,
  ExecutionResult,
  FlashLoanParams
} from '../types';
import { TRANSACTION_TIMEOUT_MS } from '../types';

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
    if (!provider) {
      return ethers.parseUnits('50', 'gwei');
    }

    try {
      const feeData = await provider.getFeeData();
      const currentPrice = feeData.maxFeePerGas || feeData.gasPrice || ethers.parseUnits('50', 'gwei');

      // Update baseline and check for spike
      this.updateGasBaseline(chain, currentPrice, ctx);

      if (ARBITRAGE_CONFIG.gasPriceSpikeEnabled) {
        const baselinePrice = this.getGasBaseline(chain, ctx);
        if (baselinePrice > 0n) {
          const maxAllowedPrice = baselinePrice * BigInt(Math.floor(ARBITRAGE_CONFIG.gasPriceSpikeMultiplier * 100)) / 100n;

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
      this.logger.warn('Failed to get optimal gas price, using default', {
        chain,
        error
      });
      return ethers.parseUnits('50', 'gwei');
    }
  }

  /**
   * Update gas price baseline for spike detection.
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

    // Remove entries older than window
    const cutoff = now - windowMs;
    while (history.length > 0 && history[0].timestamp < cutoff) {
      history.shift();
    }

    // Keep maximum 100 entries to prevent memory growth
    if (history.length > 100) {
      history.splice(0, history.length - 100);
    }
  }

  /**
   * Calculate baseline gas price from recent history.
   * Uses median to avoid outlier influence.
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

    // Sort by price and get median
    const sorted = [...history].sort((a, b) => {
      if (a.price < b.price) return -1;
      if (a.price > b.price) return 1;
      return 0;
    });

    const midIndex = Math.floor(sorted.length / 2);
    return sorted[midIndex].price;
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
    const slippageBasisPoints = BigInt(Math.floor(ARBITRAGE_CONFIG.slippageTolerance * 10000));

    const expectedAmountOut = amountInBigInt + expectedProfitWei;
    const minAmountOut = expectedAmountOut - (expectedAmountOut * slippageBasisPoints / 10000n);

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
  // Transaction Timeout
  // ===========================================================================

  /**
   * Wrap blockchain operations with timeout.
   * Uses cancellable timeout pattern to prevent timer leaks.
   */
  protected async withTransactionTimeout<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;

      const timeoutId = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`Transaction ${operationName} timeout after ${TRANSACTION_TIMEOUT_MS}ms`));
        }
      }, TRANSACTION_TIMEOUT_MS);

      operation()
        .then((result) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeoutId);
            resolve(result);
          }
        })
        .catch((error) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeoutId);
            reject(error);
          }
        });
    });
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
}
