/**
 * PancakeSwap V3 Flash Loan Provider
 *
 * Fully implemented provider for PancakeSwap V3 flash swaps.
 * Uses PancakeSwapFlashArbitrage.sol contract for on-chain execution.
 *
 * Supported chains: BSC, Ethereum, Arbitrum, zkSync Era, Base, opBNB, Linea
 * Supported fee tiers: 100 (0.01%), 500 (0.05%), 2500 (0.25%), 10000 (1%)
 *
 * @see contracts/src/PancakeSwapFlashArbitrage.sol
 * @see https://docs.pancakeswap.finance/developers/smart-contracts/pancakeswap-exchange/v3-contracts
 */

import { ethers } from 'ethers';
import {
  getBpsDenominatorBigInt,
} from '@arbitrage/config';
import type {
  IFlashLoanProvider,
  FlashLoanProtocol,
  FlashLoanRequest,
  FlashLoanFeeInfo,
  FlashLoanProviderCapabilities,
} from './types';

/**
 * PancakeSwap V3 supported fee tiers in hundredths of a bip (1e-6)
 * 100 = 0.01%, 500 = 0.05%, 2500 = 0.25%, 10000 = 1%
 */
const FEE_TIERS = [100, 500, 2500, 10000] as const;
type FeeTier = typeof FEE_TIERS[number];

/**
 * Default fee tier (0.25%) - most common for PancakeSwap V3
 */
const DEFAULT_FEE_TIER: FeeTier = 2500;

/**
 * PancakeSwap V3 Pool minimal ABI for flash and fee queries
 */
const PANCAKESWAP_V3_POOL_ABI = [
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function fee() external view returns (uint24)',
  'function flash(address recipient, uint256 amount0, uint256 amount1, bytes calldata data) external',
];

/**
 * PancakeSwap V3 Factory minimal ABI for pool discovery
 */
const PANCAKESWAP_V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
];

/**
 * PancakeSwapFlashArbitrage contract ABI (matching PancakeSwapFlashArbitrage.sol)
 */
const PANCAKESWAP_FLASH_ARBITRAGE_ABI = [
  'function executeArbitrage(address pool, address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath, uint256 minProfit, uint256 deadline) external',
  'function calculateExpectedProfit(address pool, address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath) external view returns (uint256 expectedProfit, uint256 flashLoanFee)',
  'function whitelistPool(address pool) external',
  'function isPoolWhitelisted(address pool) external view returns (bool)',
  'function addApprovedRouter(address router) external',
  'function isApprovedRouter(address router) external view returns (bool)',
  'function getWhitelistedPools() external view returns (address[])',
  'function getApprovedRouters() external view returns (address[])',
];

/**
 * Cached ethers.Interface for hot-path optimization.
 * Creating Interface objects is expensive - cache at module level.
 */
const FACTORY_INTERFACE = new ethers.Interface(PANCAKESWAP_V3_FACTORY_ABI);
const POOL_INTERFACE = new ethers.Interface(PANCAKESWAP_V3_POOL_ABI);
const ARBITRAGE_INTERFACE = new ethers.Interface(PANCAKESWAP_FLASH_ARBITRAGE_ABI);

// Use centralized constant, alias for local readability
const BPS_DENOMINATOR = getBpsDenominatorBigInt();

/**
 * Pool cache entry for fee tier lookups
 */
interface PoolCacheEntry {
  poolAddress: string;
  fee: FeeTier;
  timestamp: number;
}

/**
 * PancakeSwap V3 Flash Loan Provider
 *
 * Fully implemented provider that integrates with the PancakeSwapFlashArbitrage
 * smart contract for trustless on-chain execution using PancakeSwap V3 flash swaps.
 */
export class PancakeSwapV3FlashLoanProvider implements IFlashLoanProvider {
  readonly protocol: FlashLoanProtocol = 'pancakeswap_v3';
  readonly chain: string;
  readonly poolAddress: string; // Note: This is the factory address for PancakeSwap V3

  private readonly contractAddress: string;
  private readonly approvedRouters: string[];
  /**
   * I1 Fix: Pre-computed Set for O(1) router validation (hot-path optimization)
   * Stores lowercase router addresses for case-insensitive lookups
   */
  private readonly approvedRoutersSet: Set<string>;
  private readonly feeOverride?: FeeTier;

  /**
   * Pool cache to avoid repeated factory lookups
   * Key: `${tokenA}-${tokenB}-${feeTier}`
   * TTL: 5 minutes (pools are immutable once created)
   */
  private readonly poolCache: Map<string, PoolCacheEntry> = new Map();
  private readonly POOL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(config: {
    chain: string;
    poolAddress: string; // Factory address for PancakeSwap V3
    contractAddress: string; // PancakeSwapFlashArbitrage contract address
    approvedRouters: string[];
    feeOverride?: FeeTier;
  }) {
    this.chain = config.chain;
    this.poolAddress = config.poolAddress; // Factory address
    this.contractAddress = config.contractAddress;
    this.approvedRouters = config.approvedRouters;
    // I1 Fix: Pre-compute Set for O(1) lookups in hot-path validation
    this.approvedRoutersSet = new Set(config.approvedRouters.map(r => r.toLowerCase()));
    this.feeOverride = config.feeOverride;

    // Validate configuration
    if (!ethers.isAddress(config.contractAddress)) {
      throw new Error(`[ERR_CONFIG] Invalid contract address for PancakeSwap V3 provider on ${config.chain}`);
    }
    if (!ethers.isAddress(config.poolAddress)) {
      throw new Error(`[ERR_CONFIG] Invalid factory address for PancakeSwap V3 provider on ${config.chain}`);
    }
  }

  /**
   * Check if provider is available for use
   */
  isAvailable(): boolean {
    // Check for zero address which indicates misconfiguration
    if (this.contractAddress === '0x0000000000000000000000000000000000000000') {
      return false;
    }
    if (this.poolAddress === '0x0000000000000000000000000000000000000000') {
      return false;
    }
    return true;
  }

  /**
   * Get provider capabilities
   */
  getCapabilities(): FlashLoanProviderCapabilities {
    return {
      supportsMultiHop: true,
      supportsMultiAsset: false, // PancakeSwap V3 flash only supports single asset per call
      maxLoanAmount: 0n, // Depends on pool liquidity
      supportedTokens: [], // All tokens supported in PancakeSwap pools
      status: 'fully_supported',
    };
  }

  /**
   * Calculate flash loan fee for an amount
   *
   * @param amount - Loan amount in wei
   * @param feeTier - Optional fee tier (100, 500, 2500, 10000). Defaults to 2500 (0.25%)
   * @returns Fee information
   */
  calculateFee(amount: bigint, feeTier?: FeeTier): FlashLoanFeeInfo {
    const effectiveFeeTier = this.feeOverride ?? feeTier ?? DEFAULT_FEE_TIER;

    // PancakeSwap V3 fee calculation: amount * feeTier / 1e6
    // feeTier is in hundredths of a bip (e.g., 2500 = 0.25%)
    const feeAmount = (amount * BigInt(effectiveFeeTier)) / 1_000_000n;

    // Convert to basis points for consistency with other providers
    // feeTier / 10000 = bps (e.g., 2500 / 100 = 25 bps)
    const feeBps = effectiveFeeTier / 100;

    return {
      feeBps,
      feeAmount,
      protocol: this.protocol,
    };
  }

  /**
   * Find the best pool for a given token pair
   *
   * @param tokenA - First token address
   * @param tokenB - Second token address
   * @param provider - JSON-RPC provider for pool queries
   * @returns Pool address and fee tier, or null if no pool found
   */
  async findBestPool(
    tokenA: string,
    tokenB: string,
    provider: ethers.JsonRpcProvider
  ): Promise<{ pool: string; feeTier: FeeTier } | null> {
    const cacheKey = `${tokenA}-${tokenB}-best`;
    const cached = this.poolCache.get(cacheKey);

    // Return cached result if still valid
    if (cached && Date.now() - cached.timestamp < this.POOL_CACHE_TTL) {
      return { pool: cached.poolAddress, feeTier: cached.fee };
    }

    // Query factory for all fee tiers
    const factory = new ethers.Contract(
      this.poolAddress,
      FACTORY_INTERFACE,
      provider
    );

    // Try fee tiers in order of preference: 2500 (most common), 500, 10000, 100
    const preferredOrder: FeeTier[] = [2500, 500, 10000, 100];

    for (const feeTier of preferredOrder) {
      try {
        const poolAddress = await factory.getPool(tokenA, tokenB, feeTier);

        if (poolAddress && poolAddress !== ethers.ZeroAddress) {
          // Cache the result
          this.poolCache.set(cacheKey, {
            poolAddress,
            fee: feeTier,
            timestamp: Date.now(),
          });

          return { pool: poolAddress, feeTier };
        }
      } catch {
        // Continue to next fee tier if this one fails
        continue;
      }
    }

    return null;
  }

  /**
   * Get pool fee tier dynamically
   *
   * @param poolAddress - Pool address
   * @param provider - JSON-RPC provider for fee query
   * @returns Fee tier (100, 500, 2500, or 10000)
   */
  async getPoolFee(
    poolAddress: string,
    provider: ethers.JsonRpcProvider
  ): Promise<FeeTier> {
    const cacheKey = `fee-${poolAddress}`;
    const cached = this.poolCache.get(cacheKey);

    // Return cached result if still valid
    if (cached && Date.now() - cached.timestamp < this.POOL_CACHE_TTL) {
      return cached.fee;
    }

    // Query pool for fee
    const pool = new ethers.Contract(poolAddress, POOL_INTERFACE, provider);
    const fee = await pool.fee();

    // Cache the result
    this.poolCache.set(cacheKey, {
      poolAddress,
      fee: Number(fee) as FeeTier,
      timestamp: Date.now(),
    });

    return Number(fee) as FeeTier;
  }

  /**
   * Build the transaction calldata for flash loan execution
   *
   * @param request - Flash loan request parameters (must include poolAddress)
   * @returns Encoded calldata for the transaction
   * @throws Error if poolAddress is not provided in request
   */
  buildCalldata(request: FlashLoanRequest): string {
    if (!request.poolAddress) {
      throw new Error('[ERR_MISSING_POOL] PancakeSwap V3 requires poolAddress in request. Call findBestPool() first.');
    }

    // Convert SwapStep[] to tuple array format for ABI encoding
    const swapPathTuples = request.swapPath.map(step => [
      step.router,
      step.tokenIn,
      step.tokenOut,
      step.amountOutMin,
    ]);

    // Default deadline: 5 minutes from now
    const deadline = Math.floor(Date.now() / 1000) + 300;

    return ARBITRAGE_INTERFACE.encodeFunctionData('executeArbitrage', [
      request.poolAddress,
      request.asset,
      request.amount,
      swapPathTuples,
      request.minProfit,
      deadline,
    ]);
  }

  /**
   * Build the complete transaction request
   *
   * @param request - Flash loan request parameters (must include poolAddress)
   * @param from - Sender address
   * @returns Transaction request ready for signing
   * @throws Error if poolAddress is not provided in request
   */
  buildTransaction(
    request: FlashLoanRequest,
    from: string
  ): ethers.TransactionRequest {
    return {
      to: this.contractAddress,
      data: this.buildCalldata(request),
      from,
    };
  }

  /**
   * Estimate gas for flash loan execution
   *
   * @param request - Flash loan request parameters (must include poolAddress)
   * @param provider - JSON-RPC provider for estimation
   * @returns Estimated gas units
   * @throws Error if poolAddress is not provided in request
   */
  async estimateGas(
    request: FlashLoanRequest,
    provider: ethers.JsonRpcProvider
  ): Promise<bigint> {
    const tx = this.buildTransaction(request, request.initiator);

    try {
      return await provider.estimateGas(tx);
    } catch {
      // Default gas estimate for PancakeSwap V3 flash loan arbitrage
      // Slightly higher than Aave due to pool whitelist checks
      return 550000n;
    }
  }

  /**
   * Validate a flash loan request before execution
   *
   * @param request - Flash loan request to validate
   * @returns Validation result with error message if invalid
   */
  validate(request: FlashLoanRequest): { valid: boolean; error?: string } {
    // Check chain matches
    if (request.chain !== this.chain) {
      return {
        valid: false,
        error: `[ERR_CHAIN_MISMATCH] Request chain '${request.chain}' does not match provider chain '${this.chain}'`,
      };
    }

    // Check asset is valid address
    if (!ethers.isAddress(request.asset)) {
      return {
        valid: false,
        error: '[ERR_INVALID_ASSET] Invalid asset address',
      };
    }

    // Check amount is non-zero
    if (request.amount === 0n) {
      return {
        valid: false,
        error: '[ERR_ZERO_AMOUNT] Flash loan amount cannot be zero',
      };
    }

    // Check swap path is not empty
    if (request.swapPath.length === 0) {
      return {
        valid: false,
        error: '[ERR_EMPTY_PATH] Swap path cannot be empty',
      };
    }

    // Check all routers in path are approved
    // Security: Empty router list is a misconfiguration - require explicit approval
    if (this.approvedRouters.length === 0) {
      return {
        valid: false,
        error: '[ERR_CONFIG] No approved routers configured for PancakeSwap V3 provider',
      };
    }

    for (const step of request.swapPath) {
      if (!ethers.isAddress(step.router)) {
        return {
          valid: false,
          error: `[ERR_INVALID_ROUTER] Invalid router address: ${step.router}`,
        };
      }

      // I1 Fix: Use Set for O(1) lookup instead of O(n) array.some()
      // Hot-path optimization: For 10 routers × 3 hops, this saves 30 comparisons → 3 lookups
      if (!this.approvedRoutersSet.has(step.router.toLowerCase())) {
        return {
          valid: false,
          error: `[ERR_UNAPPROVED_ROUTER] Router not approved: ${step.router}`,
        };
      }
    }

    // Check swap path forms a valid cycle (ends with same token as starts)
    const firstToken = request.swapPath[0].tokenIn;
    const lastToken = request.swapPath[request.swapPath.length - 1].tokenOut;
    if (firstToken.toLowerCase() !== lastToken.toLowerCase()) {
      return {
        valid: false,
        error: '[ERR_INVALID_CYCLE] Swap path must end with the same token it starts with',
      };
    }

    // Check first token matches asset
    if (firstToken.toLowerCase() !== request.asset.toLowerCase()) {
      return {
        valid: false,
        error: '[ERR_ASSET_MISMATCH] First swap token must match flash loan asset',
      };
    }

    return { valid: true };
  }

  /**
   * Get the contract address for this provider
   */
  getContractAddress(): string {
    return this.contractAddress;
  }

  /**
   * Get the factory address for this provider
   */
  getFactoryAddress(): string {
    return this.poolAddress;
  }

  /**
   * Get the list of approved routers
   */
  getApprovedRouters(): string[] {
    return [...this.approvedRouters];
  }

  /**
   * Clear the pool cache (useful for testing or after network issues)
   */
  clearCache(): void {
    this.poolCache.clear();
  }
}
