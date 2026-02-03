/**
 * Base Execution Strategy
 *
 * Provides shared utility methods for all execution strategies:
 * - Gas price optimization with spike protection
 * - MEV protection
 * - Price verification
 * - DEX swap transaction preparation
 * - Transaction timeout handling
 *
 * R4 Refactoring: This class now delegates to extracted services:
 * - GasPriceOptimizer: Gas price management and spike detection
 * - NonceAllocationManager: Per-chain nonce locking
 * - MevProtectionService: MEV eligibility and protection
 * - BridgeProfitabilityAnalyzer: Bridge fee analysis
 *
 * Note: For flash loan transactions, use FlashLoanStrategy directly.
 *
 * @see engine.ts (parent service)
 * @see services/gas-price-optimizer.ts
 * @see services/nonce-allocation-manager.ts
 * @see services/mev-protection-service.ts
 * @see services/bridge-profitability-analyzer.ts
 */

import { ethers } from 'ethers';
import { CHAINS, ARBITRAGE_CONFIG, MEV_CONFIG, DEXES } from '@arbitrage/config';
import { getErrorMessage, createPinoLogger, type ILogger } from '@arbitrage/core';
import type { ArbitrageOpportunity } from '@arbitrage/types';
// P3-FIX 4.1 / Phase 5.3: Use auto-generated error selectors instead of hardcoded values
import { CUSTOM_ERROR_SELECTORS } from './error-selectors.generated';

// =============================================================================
// R4: Import Extracted Services
// =============================================================================
import {
  GasPriceOptimizer,
  WEI_PER_GWEI,
  getFallbackGasPrice,
  type GasBaselineEntry,
} from '../services/gas-price-optimizer';
import {
  NonceAllocationManager,
} from '../services/nonce-allocation-manager';
import {
  MevProtectionService,
} from '../services/mev-protection-service';
import {
  BridgeProfitabilityAnalyzer,
} from '../services/bridge-profitability-analyzer';

// Re-export for backward compatibility
export {
  GasPriceOptimizer,
  validateGasPriceConfiguration,
  validateGasPrice,
  getFallbackGasPrice,
  GAS_SPIKE_MULTIPLIER_BIGINT,
  WEI_PER_GWEI,
  MIN_GAS_PRICE_GWEI,
  MAX_GAS_PRICE_GWEI,
  DEFAULT_GAS_PRICES_GWEI,
  FALLBACK_GAS_PRICES_WEI,
  type GasConfigValidationResult,
  type GasBaselineEntry,
} from '../services/gas-price-optimizer';

export {
  NonceAllocationManager,
  acquireChainNonceLock,
  releaseChainNonceLock,
  checkConcurrentNonceAccess,
  clearNonceAllocationTracking,
} from '../services/nonce-allocation-manager';

export {
  MevProtectionService,
  checkMevEligibility,
  type MevEligibilityResult,
} from '../services/mev-protection-service';

export {
  BridgeProfitabilityAnalyzer,
  checkBridgeProfitability,
  type BridgeProfitabilityOptions,
  type BridgeProfitabilityResult,
} from '../services/bridge-profitability-analyzer';

// Lazy-initialized logger for module-level validation
let _moduleLogger: ILogger | null = null;
function getModuleLogger(): ILogger {
  if (!_moduleLogger) {
    _moduleLogger = createPinoLogger('base-strategy');
  }
  return _moduleLogger;
}

import type {
  Logger,
  StrategyContext,
  ExecutionResult,
} from '../types';
import { TRANSACTION_TIMEOUT_MS, withTimeout } from '../types';
import type { SimulationRequest, SimulationResult } from '../services/simulation/types';

/**
 * Phase 2 Enhancement: RBF (Replace-By-Fee) retry configuration.
 * Used for EIP-1559 transaction replacement on transient failures.
 */
interface RbfRetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries: number;
  /** Gas price bump percentage per retry (default: 10 = 10%) */
  gasBumpPercent: number;
  /** Patterns indicating retryable errors */
  retryableErrorPatterns: RegExp[];
}

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
 * Issue 3.3 Fix: Configurable swap deadline in seconds.
 */
const SWAP_DEADLINE_SECONDS = parseInt(process.env.SWAP_DEADLINE_SECONDS || '300', 10);

/**
 * Parse and validate an integer environment variable with bounds checking.
 * Returns defaultValue if env var is missing, NaN, or out of bounds.
 */
function parseValidatedEnvInt(
  envValue: string | undefined,
  defaultValue: number,
  min: number,
  max: number
): number {
  const parsed = parseInt(envValue || String(defaultValue), 10);
  if (Number.isNaN(parsed) || parsed < min || parsed > max) {
    return defaultValue;
  }
  return parsed;
}

/**
 * Phase 2 Enhancement: Default RBF retry configuration.
 * Enables automatic retry with gas bumping for transient failures.
 *
 * Config validation:
 * - maxRetries: 0-10 (prevents infinite or negative retries)
 * - gasBumpPercent: 1-100 (must be positive, capped at 100% per retry)
 */
const DEFAULT_RBF_CONFIG: RbfRetryConfig = {
  maxRetries: parseValidatedEnvInt(process.env.RBF_MAX_RETRIES, 3, 0, 10),
  gasBumpPercent: parseValidatedEnvInt(process.env.RBF_GAS_BUMP_PERCENT, 10, 1, 100),
  retryableErrorPatterns: [
    /replacement transaction underpriced/i,
    /nonce.*too low/i,
    /transaction underpriced/i,
    /already known/i,
    /timeout/i,
    /ETIMEDOUT/i,
    /ECONNRESET/i,
    /network error/i,
  ],
};

// Validate the deadline is reasonable (30 seconds to 30 minutes)
if (Number.isNaN(SWAP_DEADLINE_SECONDS) || SWAP_DEADLINE_SECONDS < 30 || SWAP_DEADLINE_SECONDS > 1800) {
  getModuleLogger().warn('Invalid SWAP_DEADLINE_SECONDS, using default 300', {
    configured: process.env.SWAP_DEADLINE_SECONDS,
    using: 300,
  });
}
const VALIDATED_SWAP_DEADLINE_SECONDS = Number.isNaN(SWAP_DEADLINE_SECONDS) || SWAP_DEADLINE_SECONDS < 30 || SWAP_DEADLINE_SECONDS > 1800
  ? 300
  : SWAP_DEADLINE_SECONDS;

/**
 * Pre-computed BigInt for slippage tolerance.
 */
const SLIPPAGE_BASIS_POINTS_BIGINT = BigInt(Math.floor(ARBITRAGE_CONFIG.slippageTolerance * 10000));

/**
 * Refactor 9.5: Pre-computed DEX lookup by chain and name for O(1) access.
 */
const DEXES_BY_CHAIN_AND_NAME: Map<string, Map<string, typeof DEXES[string][number]>> = new Map(
  Object.entries(DEXES).map(([chain, dexes]) => [
    chain,
    new Map(dexes.map(dex => [dex.name.toLowerCase(), dex]))
  ])
);

/**
 * Refactor 9.5: O(1) DEX lookup by chain and name.
 */
function getDexByName(chain: string, dexName: string): typeof DEXES[string][number] | undefined {
  return DEXES_BY_CHAIN_AND_NAME.get(chain)?.get(dexName.toLowerCase());
}

/**
 * Refactor 9.5: Get first DEX for a chain.
 */
function getFirstDex(chain: string): typeof DEXES[string][number] | undefined {
  return DEXES[chain]?.[0];
}

/**
 * Base class for execution strategies.
 * Provides shared utility methods.
 *
 * R4 Refactoring: This class now delegates to extracted services for:
 * - Gas price management (GasPriceOptimizer)
 * - Nonce allocation (NonceAllocationManager)
 * - MEV protection (MevProtectionService)
 * - Bridge profitability (BridgeProfitabilityAnalyzer)
 */
export abstract class BaseExecutionStrategy {
  protected readonly logger: Logger;

  /**
   * Refactor 9.2: Consolidated slippage tolerance in basis points.
   */
  protected readonly slippageBps: bigint = SLIPPAGE_BASIS_POINTS_BIGINT;

  /**
   * Refactor 9.2: Basis points denominator (10000 = 100%)
   */
  protected readonly BPS_DENOMINATOR = 10000n;

  /**
   * Fix 10.1: Router contract cache for hot-path optimization.
   */
  private readonly routerContractCache = new Map<string, ethers.Contract>();

  /**
   * Fix 10.1: Maximum number of cached router contracts.
   */
  private readonly MAX_ROUTER_CACHE_SIZE = 50;

  /**
   * Perf 10.2: Wallet address cache for hot-path optimization.
   */
  private readonly walletAddressCache = new WeakMap<ethers.Wallet, string>();

  // =============================================================================
  // R4: Extracted Service Instances
  // =============================================================================

  /**
   * R4: Gas price optimizer service instance.
   * Created lazily on first use.
   */
  private _gasPriceOptimizer?: GasPriceOptimizer;

  /**
   * R4: Nonce allocation manager service instance.
   * Created lazily on first use.
   */
  private _nonceAllocationManager?: NonceAllocationManager;

  /**
   * R4: MEV protection service instance.
   * Created lazily on first use.
   */
  private _mevProtectionService?: MevProtectionService;

  /**
   * R4: Bridge profitability analyzer instance.
   * Created lazily on first use.
   */
  private _bridgeProfitabilityAnalyzer?: BridgeProfitabilityAnalyzer;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * R4: Get or create the gas price optimizer.
   */
  protected get gasPriceOptimizer(): GasPriceOptimizer {
    if (!this._gasPriceOptimizer) {
      this._gasPriceOptimizer = new GasPriceOptimizer(this.logger);
    }
    return this._gasPriceOptimizer;
  }

  /**
   * R4: Get or create the nonce allocation manager.
   */
  protected get nonceAllocationManager(): NonceAllocationManager {
    if (!this._nonceAllocationManager) {
      this._nonceAllocationManager = new NonceAllocationManager(this.logger);
    }
    return this._nonceAllocationManager;
  }

  /**
   * R4: Get or create the MEV protection service.
   */
  protected get mevProtectionService(): MevProtectionService {
    if (!this._mevProtectionService) {
      this._mevProtectionService = new MevProtectionService(this.logger, this.gasPriceOptimizer);
    }
    return this._mevProtectionService;
  }

  /**
   * R4: Get or create the bridge profitability analyzer.
   */
  protected get bridgeProfitabilityAnalyzer(): BridgeProfitabilityAnalyzer {
    if (!this._bridgeProfitabilityAnalyzer) {
      this._bridgeProfitabilityAnalyzer = new BridgeProfitabilityAnalyzer(this.logger);
    }
    return this._bridgeProfitabilityAnalyzer;
  }

  // ===========================================================================
  // Perf 10.2: Wallet Address Caching
  // ===========================================================================

  /**
   * Perf 10.2: Get wallet address with caching.
   */
  protected async getWalletAddress(wallet: ethers.Wallet): Promise<string> {
    const cached = this.walletAddressCache.get(wallet);
    if (cached) {
      return cached;
    }
    const address = await wallet.getAddress();
    this.walletAddressCache.set(wallet, address);
    return address;
  }

  /**
   * Fix 10.1: Get or create a cached router contract instance.
   */
  protected getRouterContract(
    routerAddress: string,
    provider: ethers.JsonRpcProvider,
    chain: string
  ): ethers.Contract {
    const cacheKey = `${chain}:${routerAddress}`;
    let router = this.routerContractCache.get(cacheKey);

    if (!router) {
      if (this.routerContractCache.size >= this.MAX_ROUTER_CACHE_SIZE) {
        const firstKey = this.routerContractCache.keys().next().value;
        if (firstKey) {
          this.routerContractCache.delete(firstKey);
        }
      }

      router = new ethers.Contract(routerAddress, UNISWAP_V2_ROUTER_ABI, provider);
      this.routerContractCache.set(cacheKey, router);

      this.logger.debug('Router contract cached', { chain, routerAddress });
    }

    return router;
  }

  /**
   * Execute the opportunity (implemented by subclasses).
   */
  abstract execute(
    opportunity: ArbitrageOpportunity,
    ctx: StrategyContext
  ): Promise<ExecutionResult>;

  // ===========================================================================
  // Context Validation
  // ===========================================================================

  /**
   * Validate that required context dependencies are available for a chain.
   */
  protected validateContext(
    chain: string,
    ctx: StrategyContext,
    options?: {
      requireNonceManager?: boolean;
      requireMevProvider?: boolean;
      requireBridgeRouter?: boolean;
    }
  ): { valid: true; wallet: ethers.Wallet; provider: ethers.JsonRpcProvider } | { valid: false; error: string } {
    const provider = ctx.providers.get(chain);
    if (!provider) {
      return { valid: false, error: `[ERR_NO_PROVIDER] No provider available for chain: ${chain}` };
    }

    const wallet = ctx.wallets.get(chain);
    if (!wallet) {
      return { valid: false, error: `[ERR_NO_WALLET] No wallet available for chain: ${chain}` };
    }

    if (options?.requireNonceManager && !ctx.nonceManager) {
      return { valid: false, error: '[ERR_NO_NONCE_MANAGER] NonceManager not initialized' };
    }

    if (options?.requireMevProvider && !ctx.mevProviderFactory) {
      return { valid: false, error: '[ERR_NO_MEV_PROVIDER] MevProviderFactory not initialized' };
    }

    if (options?.requireBridgeRouter && !ctx.bridgeRouterFactory) {
      return { valid: false, error: '[ERR_NO_BRIDGE] BridgeRouterFactory not initialized' };
    }

    return { valid: true, wallet, provider };
  }

  /**
   * Race 5.4 Fix: Check provider health before critical operations.
   */
  protected async isProviderHealthy(
    provider: ethers.JsonRpcProvider,
    chain: string,
    ctx: StrategyContext
  ): Promise<boolean> {
    try {
      await Promise.race([
        provider.getNetwork(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Provider health check timeout')), 3000)
        ),
      ]);
      return true;
    } catch (error) {
      const providerHealth = ctx.providerHealth.get(chain);
      if (providerHealth) {
        providerHealth.healthy = false;
        providerHealth.lastError = getErrorMessage(error);
        providerHealth.lastCheck = Date.now();
        providerHealth.consecutiveFailures++;
      }
      ctx.stats.providerHealthCheckFailures++;

      this.logger.warn('[WARN_PROVIDER_UNHEALTHY] Provider health check failed before transaction', {
        chain,
        error: getErrorMessage(error),
      });
      return false;
    }
  }

  // ===========================================================================
  // Gas Price Management (R4: Delegates to GasPriceOptimizer)
  // ===========================================================================

  /**
   * Get optimal gas price with spike protection.
   * R4: Delegates to GasPriceOptimizer.getOptimalGasPrice()
   */
  protected async getOptimalGasPrice(
    chain: string,
    ctx: StrategyContext
  ): Promise<bigint> {
    const provider = ctx.providers.get(chain);
    return this.gasPriceOptimizer.getOptimalGasPrice(
      chain,
      provider,
      ctx.gasBaselines,
      ctx.lastGasPrices
    );
  }

  /**
   * Refresh gas price immediately before transaction submission.
   * R4: Delegates to GasPriceOptimizer.refreshGasPriceForSubmission()
   */
  protected async refreshGasPriceForSubmission(
    chain: string,
    ctx: StrategyContext,
    previousGasPrice: bigint
  ): Promise<bigint> {
    const provider = ctx.providers.get(chain);
    return this.gasPriceOptimizer.refreshGasPriceForSubmission(
      chain,
      provider,
      previousGasPrice
    );
  }

  /**
   * Update gas price baseline for spike detection.
   * R4: Delegates to GasPriceOptimizer.updateGasBaseline()
   */
  protected updateGasBaseline(
    chain: string,
    price: bigint,
    ctx: StrategyContext
  ): void {
    this.gasPriceOptimizer.updateGasBaseline(
      chain,
      price,
      ctx.gasBaselines,
      ctx.lastGasPrices
    );
  }

  /**
   * Calculate baseline gas price from recent history.
   * R4: Delegates to GasPriceOptimizer.getGasBaseline()
   */
  protected getGasBaseline(chain: string, ctx: StrategyContext): bigint {
    return this.gasPriceOptimizer.getGasBaseline(chain, ctx.gasBaselines);
  }

  // ===========================================================================
  // MEV Protection (R4: Delegates to MevProtectionService)
  // ===========================================================================

  /**
   * Apply MEV protection to prevent sandwich attacks.
   * R4: Delegates to MevProtectionService.applyProtection()
   */
  protected async applyMEVProtection(
    tx: ethers.TransactionRequest,
    chain: string,
    ctx: StrategyContext
  ): Promise<ethers.TransactionRequest> {
    return this.mevProtectionService.applyProtection(
      tx,
      chain,
      ctx,
      ctx.gasBaselines,
      ctx.lastGasPrices
    );
  }

  /**
   * Check if MEV protection should be used for a transaction.
   * R4: Delegates to MevProtectionService.checkEligibility()
   */
  protected checkMevEligibility(
    chain: string,
    ctx: StrategyContext,
    expectedProfit?: number
  ): {
    shouldUseMev: boolean;
    mevProvider?: ReturnType<NonNullable<StrategyContext['mevProviderFactory']>['getProvider']>;
    chainSettings?: typeof MEV_CONFIG.chainSettings[string];
  } {
    return this.mevProtectionService.checkEligibility(chain, ctx, expectedProfit);
  }

  // ===========================================================================
  // Transaction Submission (uses NonceAllocationManager internally)
  // ===========================================================================

  /**
   * Submit a transaction with MEV protection, nonce management, and gas price refresh.
   */
  protected async submitTransaction(
    tx: ethers.TransactionRequest,
    chain: string,
    ctx: StrategyContext,
    options: {
      opportunityId: string;
      expectedProfit?: number;
      initialGasPrice: bigint;
    }
  ): Promise<{
    success: boolean;
    receipt?: ethers.TransactionReceipt;
    txHash?: string;
    error?: string;
    nonce?: number;
    usedMevProtection?: boolean;
  }> {
    const wallet = ctx.wallets.get(chain);
    const provider = ctx.providers.get(chain);

    if (!wallet) {
      return { success: false, error: `No wallet for chain: ${chain}` };
    }

    // Race 5.4 Fix: Verify provider health before transaction submission
    if (provider) {
      const isHealthy = await this.isProviderHealthy(provider, chain, ctx);
      if (!isHealthy) {
        return {
          success: false,
          error: `[ERR_PROVIDER_UNHEALTHY] Provider for ${chain} failed health check before transaction`,
        };
      }
    }

    // Refresh gas price just before submission
    const finalGasPrice = await this.refreshGasPriceForSubmission(
      chain,
      ctx,
      options.initialGasPrice
    );

    // Get nonce from NonceManager if not already set
    let nonce: number | undefined;
    const needsNonceAllocation = tx.nonce === undefined && ctx.nonceManager;

    if (tx.nonce !== undefined) {
      nonce = Number(tx.nonce);
      this.logger.debug('Using pre-allocated nonce', { chain, nonce });
    } else if (ctx.nonceManager) {
      // R4: Acquire per-chain lock before nonce allocation
      try {
        await this.nonceAllocationManager.acquireLock(chain, options.opportunityId);
      } catch (lockError) {
        return {
          success: false,
          error: getErrorMessage(lockError) || '[ERR_NONCE_LOCK] Failed to acquire nonce lock',
        };
      }

      try {
        // Track nonce allocation to detect any remaining concurrent access
        this.nonceAllocationManager.checkConcurrentAccess(chain, options.opportunityId);

        nonce = await ctx.nonceManager.getNextNonce(chain);
        tx.nonce = nonce;
      } catch (error) {
        return {
          success: false,
          error: `[ERR_NONCE] Failed to get nonce: ${getErrorMessage(error)}`,
        };
      } finally {
        // Release lock after nonce allocation
        this.nonceAllocationManager.releaseLock(chain, options.opportunityId);
        if (needsNonceAllocation) {
          this.nonceAllocationManager.clearTracking(chain, options.opportunityId);
        }
      }
    }

    try {
      // Use shared MEV eligibility check helper
      const { shouldUseMev, mevProvider, chainSettings } = this.checkMevEligibility(
        chain,
        ctx,
        options.expectedProfit
      );

      let receipt: ethers.TransactionReceipt | null = null;
      let txHash: string | undefined;

      if (shouldUseMev && mevProvider) {
        // MEV protected submission
        const mevResult = await this.withTransactionTimeout(
          () => mevProvider.sendProtectedTransaction(tx, {
            simulate: MEV_CONFIG.simulateBeforeSubmit,
            priorityFeeGwei: chainSettings?.priorityFeeGwei,
          }),
          'mevProtectedSubmission'
        );

        if (!mevResult.success) {
          if (ctx.nonceManager && nonce !== undefined) {
            ctx.nonceManager.failTransaction(chain, nonce, mevResult.error || 'MEV submission failed');
          }
          return {
            success: false,
            error: `MEV protected submission failed: ${mevResult.error}`,
            nonce,
          };
        }

        txHash = mevResult.transactionHash;

        if (txHash && provider) {
          receipt = await this.withTransactionTimeout(
            () => provider.getTransactionReceipt(txHash!),
            'getReceipt'
          );
        }

        this.logger.info('MEV protected transaction submitted', {
          chain,
          strategy: mevResult.strategy,
          txHash,
          usedFallback: mevResult.usedFallback,
        });

        if (ctx.nonceManager && nonce !== undefined && receipt) {
          ctx.nonceManager.confirmTransaction(chain, nonce, receipt.hash);
        }

        return {
          success: true,
          receipt: receipt || undefined,
          txHash,
          nonce,
          usedMevProtection: true,
        };
      } else {
        // Standard transaction submission with RBF retry logic
        // Phase 2 Enhancement: Retry with gas bump on transient failures
        let currentGasPrice = finalGasPrice;
        let lastError: string | undefined;

        for (let attempt = 0; attempt <= DEFAULT_RBF_CONFIG.maxRetries; attempt++) {
          try {
            // Set gas price based on transaction type
            if (tx.type === 2) {
              tx.maxFeePerGas = currentGasPrice;
              // Also bump maxPriorityFeePerGas proportionally if set
              if (tx.maxPriorityFeePerGas && attempt > 0) {
                const priorityFee = BigInt(tx.maxPriorityFeePerGas);
                tx.maxPriorityFeePerGas = priorityFee + (priorityFee * BigInt(DEFAULT_RBF_CONFIG.gasBumpPercent) / 100n);
              }
            } else {
              tx.gasPrice = currentGasPrice;
            }

            if (attempt > 0) {
              this.logger.info('RBF retry: resubmitting with bumped gas', {
                chain,
                attempt,
                previousError: lastError,
                nonce,
                newGasPriceGwei: Number(currentGasPrice / WEI_PER_GWEI),
              });
            }

            const txResponse = await this.withTransactionTimeout(
              () => wallet.sendTransaction(tx),
              'sendTransaction'
            );

            txHash = txResponse.hash;

            receipt = await this.withTransactionTimeout(
              () => txResponse.wait(),
              'waitForReceipt'
            );

            if (!receipt) {
              // Transaction was submitted but no receipt - this is unusual
              // Don't retry as the tx might have been mined
              if (ctx.nonceManager && nonce !== undefined) {
                ctx.nonceManager.failTransaction(chain, nonce, 'No receipt received');
              }
              return {
                success: false,
                error: 'Transaction receipt not received',
                txHash,
                nonce,
              };
            }

            // Success - confirm nonce and return
            if (ctx.nonceManager && nonce !== undefined) {
              ctx.nonceManager.confirmTransaction(chain, nonce, receipt.hash);
            }

            if (attempt > 0) {
              this.logger.info('RBF retry succeeded', {
                chain,
                totalAttempts: attempt + 1,
                txHash: receipt.hash,
              });
            }

            return {
              success: true,
              receipt,
              txHash: receipt.hash,
              nonce,
              usedMevProtection: false,
            };
          } catch (submitError) {
            lastError = getErrorMessage(submitError);

            // Check if this error is retryable
            const isRetryable = DEFAULT_RBF_CONFIG.retryableErrorPatterns.some(
              pattern => pattern.test(lastError || '')
            );

            if (!isRetryable || attempt >= DEFAULT_RBF_CONFIG.maxRetries) {
              // Non-retryable error or max retries reached
              this.logger.warn('Transaction submission failed (not retryable or max retries reached)', {
                chain,
                attempt,
                maxRetries: DEFAULT_RBF_CONFIG.maxRetries,
                error: lastError,
                isRetryable,
              });
              throw submitError;
            }

            // Bump gas price for next attempt (10% increase)
            const bumpAmount = currentGasPrice * BigInt(DEFAULT_RBF_CONFIG.gasBumpPercent) / 100n;
            currentGasPrice = currentGasPrice + bumpAmount;

            this.logger.debug('Transaction failed with retryable error, will retry', {
              chain,
              attempt,
              error: lastError,
              nextGasPriceGwei: Number(currentGasPrice / WEI_PER_GWEI),
            });
          }
        }

        // Should not reach here, but handle gracefully
        throw new Error(lastError || 'Transaction failed after all retry attempts');
      }
    } catch (error) {
      if (ctx.nonceManager && nonce !== undefined) {
        ctx.nonceManager.failTransaction(chain, nonce, getErrorMessage(error));
      }
      return {
        success: false,
        error: getErrorMessage(error) || 'Unknown submission error',
        nonce,
      };
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
    const maxAgeMs = ARBITRAGE_CONFIG.opportunityTimeoutMs || 30000;
    const opportunityAge = Date.now() - opportunity.timestamp;

    if (opportunityAge > maxAgeMs) {
      return {
        valid: false,
        reason: `Opportunity too old: ${opportunityAge}ms > ${maxAgeMs}ms`
      };
    }

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
  // Swap Path Building
  // ===========================================================================

  /**
   * Build swap path for DEX router.
   */
  protected buildSwapPath(opportunity: ArbitrageOpportunity): string[] {
    if (!opportunity.tokenIn || !opportunity.tokenOut) {
      throw new Error('Invalid opportunity: missing tokenIn or tokenOut');
    }
    return [opportunity.tokenIn, opportunity.tokenOut];
  }

  // ===========================================================================
  // DEX Swap Transaction
  // ===========================================================================

  /**
   * Prepare a direct DEX swap transaction.
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

    // Refactor 9.5: Use O(1) DEX lookup
    const targetDex = opportunity.sellDex
      ? getDexByName(chain, opportunity.sellDex)
      : getFirstDex(chain);

    if (!targetDex) {
      throw new Error(`No DEX configured for chain: ${chain}${opportunity.sellDex ? ` (requested: ${opportunity.sellDex})` : ''}`);
    }

    if (!targetDex.routerAddress) {
      throw new Error(`No router address for DEX '${targetDex.name}' on chain: ${chain}`);
    }

    const amountIn = BigInt(opportunity.amountIn);
    const expectedProfit = opportunity.expectedProfit || 0;
    const expectedProfitWei = ethers.parseUnits(
      Math.max(0, expectedProfit).toFixed(18),
      18
    );
    const expectedAmountOut = amountIn + expectedProfitWei;
    const minAmountOut = expectedAmountOut - (expectedAmountOut * SLIPPAGE_BASIS_POINTS_BIGINT / 10000n);

    const path = this.buildSwapPath(opportunity);
    const routerContract = this.getRouterContract(targetDex.routerAddress, provider, chain);
    const deadline = Math.floor(Date.now() / 1000) + VALIDATED_SWAP_DEADLINE_SECONDS;
    const recipient = recipientAddress || await this.getWalletAddress(wallet);

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
   * Phase 2 Enhancement: Check token allowance status without modifying state.
   * This read-only operation can be parallelized with other pre-checks.
   *
   * @returns Object with allowance status and current allowance amount
   */
  protected async checkTokenAllowanceStatus(
    tokenAddress: string,
    spenderAddress: string,
    requiredAmount: bigint,
    chain: string,
    ctx: StrategyContext
  ): Promise<{ sufficient: boolean; currentAllowance: bigint }> {
    const wallet = ctx.wallets.get(chain);
    if (!wallet) {
      // If no wallet, we can't check - return insufficient to trigger approval flow
      return { sufficient: false, currentAllowance: 0n };
    }

    const provider = ctx.providers.get(chain);
    if (!provider) {
      return { sufficient: false, currentAllowance: 0n };
    }

    try {
      // Use provider for read-only call (not wallet to avoid any signing)
      const tokenContract = new ethers.Contract(
        tokenAddress,
        ERC20_APPROVE_ABI,
        provider
      );

      const ownerAddress = await this.getWalletAddress(wallet);
      const currentAllowance = await tokenContract.allowance(ownerAddress, spenderAddress);

      return {
        sufficient: currentAllowance >= requiredAmount,
        currentAllowance: BigInt(currentAllowance.toString()),
      };
    } catch (error) {
      this.logger.debug('Failed to check token allowance', {
        token: tokenAddress,
        spender: spenderAddress,
        chain,
        error: getErrorMessage(error),
      });
      // On error, assume insufficient to trigger approval flow
      return { sufficient: false, currentAllowance: 0n };
    }
  }

  /**
   * Check and approve token allowance for DEX router if needed.
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

    const ownerAddress = await this.getWalletAddress(wallet);
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
  // Bridge Fee Validation (R4: Delegates to BridgeProfitabilityAnalyzer)
  // ===========================================================================

  /**
   * Check if bridge fees make the opportunity unprofitable.
   * R4: Delegates to BridgeProfitabilityAnalyzer.analyze()
   */
  protected checkBridgeProfitability(
    bridgeFeeWei: bigint,
    expectedProfitUsd: number,
    nativeTokenPriceUsd: number,
    options: {
      maxFeePercentage?: number;
      chain?: string;
    } = {}
  ): {
    isProfitable: boolean;
    bridgeFeeUsd: number;
    bridgeFeeEth: number;
    profitAfterFees: number;
    feePercentageOfProfit: number;
    reason?: string;
  } {
    return this.bridgeProfitabilityAnalyzer.analyze(
      bridgeFeeWei,
      expectedProfitUsd,
      nativeTokenPriceUsd,
      options
    );
  }

  // ===========================================================================
  // Transaction Timeout
  // ===========================================================================

  /**
   * Wrap blockchain operations with timeout.
   */
  protected async withTransactionTimeout<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    return withTimeout(operation, operationName, TRANSACTION_TIMEOUT_MS);
  }

  // ===========================================================================
  // Dynamic Gas Limit (Phase 2 Enhancement)
  // ===========================================================================

  /**
   * Phase 2 Enhancement: Apply dynamic gas limit from simulation result.
   * Uses `gasLimit = simulatedGas * 1.15` (15% safety margin) for gas efficiency.
   *
   * @param tx - Transaction request to modify
   * @param simulationResult - Result from performSimulation
   * @returns Modified transaction with optimized gas limit
   */
  protected applyDynamicGasLimit(
    tx: ethers.TransactionRequest,
    simulationResult: SimulationResult | null
  ): ethers.TransactionRequest {
    // Only apply if simulation succeeded and returned valid gasUsed
    if (!simulationResult?.success || !simulationResult.gasUsed) {
      return tx;
    }

    // Apply 15% safety margin: gasLimit = simulatedGas * 1.15
    const simulatedGas = BigInt(simulationResult.gasUsed.toString());
    const safetyMargin = simulatedGas * 15n / 100n;
    const dynamicGasLimit = simulatedGas + safetyMargin;

    // Ensure minimum gas limit (protect against too-low simulations)
    // NOTE: 21000 is only the base ETH transfer cost. DEX swaps require significantly more:
    // - Simple Uniswap V2 swap: ~120k-150k gas
    // - Multi-hop swaps: ~200k-400k gas
    // Using 100k as floor to protect against anomalous simulation results
    const MIN_SWAP_GAS_LIMIT = 100000n;
    const finalGasLimit = dynamicGasLimit > MIN_SWAP_GAS_LIMIT ? dynamicGasLimit : MIN_SWAP_GAS_LIMIT;

    // Only update if we're actually reducing from default or if no limit was set
    if (tx.gasLimit === undefined || tx.gasLimit === null || BigInt(tx.gasLimit.toString()) > finalGasLimit) {
      tx.gasLimit = finalGasLimit;

      this.logger.debug('Applied dynamic gas limit from simulation', {
        simulatedGas: simulatedGas.toString(),
        dynamicGasLimit: finalGasLimit.toString(),
        safetyMarginPercent: 15,
        provider: simulationResult.provider,
      });
    }

    return tx;
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
  // Contract Error Decoding
  // ===========================================================================

  /**
   * Decode contract custom errors for better debugging.
   */
  protected decodeContractError(
    error: unknown,
    contractInterface?: ethers.Interface
  ): string {
    const errorMessage = getErrorMessage(error);

    if (
      error &&
      typeof error === 'object' &&
      'data' in error &&
      typeof (error as { data: unknown }).data === 'string'
    ) {
      const revertData = (error as { data: string }).data;

      const CUSTOM_ERRORS = CUSTOM_ERROR_SELECTORS;
      const selector = revertData.slice(0, 10);
      const knownError = CUSTOM_ERRORS[selector];

      if (knownError) {
        if (contractInterface) {
          try {
            const decoded = contractInterface.parseError(revertData);
            if (decoded) {
              const args = decoded.args.map((arg) =>
                typeof arg === 'bigint' ? arg.toString() : String(arg)
              ).join(', ');
              return `${decoded.name}(${args})`;
            }
          } catch {
            // Fall through to basic error name
          }
        }
        return `Contract error: ${knownError}`;
      }

      if (revertData.startsWith('0x08c379a0')) {
        try {
          const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
            ['string'],
            '0x' + revertData.slice(10)
          );
          return `Revert: ${decoded[0]}`;
        } catch {
          // Fall through
        }
      } else if (revertData.startsWith('0x4e487b71')) {
        try {
          const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
            ['uint256'],
            '0x' + revertData.slice(10)
          );
          const panicCode = Number(decoded[0]);
          const panicMessages: Record<number, string> = {
            0x01: 'Assertion failed',
            0x11: 'Arithmetic overflow/underflow',
            0x12: 'Division by zero',
            0x21: 'Invalid enum value',
            0x22: 'Storage byte array encoding error',
            0x31: 'Pop on empty array',
            0x32: 'Array index out of bounds',
            0x41: 'Memory allocation overflow',
            0x51: 'Zero initialized function pointer',
          };
          return `Panic: ${panicMessages[panicCode] || `code ${panicCode}`}`;
        } catch {
          // Fall through
        }
      }
    }

    return errorMessage || 'Unknown contract error';
  }

  // ===========================================================================
  // Pre-flight Simulation
  // ===========================================================================

  /**
   * Perform pre-flight simulation of the transaction.
   */
  protected async performSimulation(
    opportunity: ArbitrageOpportunity,
    transaction: ethers.TransactionRequest,
    chain: string,
    ctx: StrategyContext
  ): Promise<SimulationResult | null> {
    if (!ctx.simulationService) {
      ctx.stats.simulationsSkipped++;
      return null;
    }

    const opportunityAge = Date.now() - opportunity.timestamp;
    const expectedProfit = opportunity.expectedProfit || 0;

    if (!ctx.simulationService.shouldSimulate(expectedProfit, opportunityAge)) {
      ctx.stats.simulationsSkipped++;
      this.logger.debug('Skipping simulation', {
        opportunityId: opportunity.id,
        expectedProfit,
        opportunityAge,
      });
      return null;
    }

    const simulationRequest: SimulationRequest = {
      chain,
      transaction: {
        from: transaction.from,
        to: transaction.to,
        data: transaction.data,
        value: transaction.value,
        gasLimit: transaction.gasLimit,
      },
      includeStateChanges: false,
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

      if (!result.success) {
        ctx.stats.simulationErrors++;
        this.logger.warn('Simulation service error, proceeding with execution', {
          opportunityId: opportunity.id,
          error: result.error,
          provider: result.provider,
        });
        return null;
      }

      return result;
    } catch (error) {
      ctx.stats.simulationErrors++;
      this.logger.warn('Simulation failed unexpectedly, proceeding with execution', {
        opportunityId: opportunity.id,
        error: getErrorMessage(error),
      });
      return null;
    }
  }
}
