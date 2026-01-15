/**
 * Platypus Adapter
 *
 * Pool-model DEX adapter for Platypus stablecoin swaps.
 * Platypus uses a single-sided liquidity model optimized for
 * stablecoin-to-stablecoin swaps with minimal slippage.
 *
 * Supported chains:
 * - Avalanche
 *
 * Architecture:
 * - Single Main Pool holds multiple stablecoin assets
 * - Each token has an associated Asset contract
 * - Uses coverage ratio model for pricing
 * - Very low fees (typically 1-4 basis points)
 *
 * @see ADR-003: Partitioned Detector Strategy
 */

import { ethers } from 'ethers';
import { createLogger, Logger } from '../logger';
import {
  DexAdapter,
  AdapterConfig,
  AdapterType,
  DiscoveredPool,
  PoolReserves,
  SwapQuote,
  PLATYPUS_POOL_ABI,
} from './types';

// =============================================================================
// Constants
// =============================================================================

// Platypus uses very low fees for stablecoin swaps
const PLATYPUS_SWAP_FEE_BASIS_POINTS = 4; // 0.04%

// =============================================================================
// Implementation
// =============================================================================

export class PlatypusAdapter implements DexAdapter {
  readonly name: string;
  readonly chain: string;
  readonly type: AdapterType = 'pool';
  readonly primaryAddress: string;

  private readonly provider: ethers.JsonRpcProvider;
  private readonly routerAddress: string;
  private readonly logger: Logger;

  private poolContract: ethers.Contract | null = null;
  private supportedTokens: Set<string> = new Set();
  private initialized = false;
  private destroyed = false;

  constructor(config: AdapterConfig) {
    if (!config.provider) {
      throw new Error('PlatypusAdapter requires a provider');
    }

    this.name = config.name;
    this.chain = config.chain;
    this.primaryAddress = config.primaryAddress;
    this.routerAddress = config.secondaryAddress || '';
    this.provider = config.provider;

    this.logger = createLogger(`${this.name}-adapter`);
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  async initialize(): Promise<void> {
    if (this.initialized || this.destroyed) {
      return;
    }

    this.logger.info(`Initializing Platypus adapter for ${this.chain}`);

    // Verify provider connection
    try {
      await this.provider.getBlockNumber();
    } catch (error) {
      this.logger.error('Failed to connect to provider', { error });
      throw error;
    }

    // Create pool contract instance
    this.poolContract = new ethers.Contract(
      this.primaryAddress,
      PLATYPUS_POOL_ABI,
      this.provider
    );

    // Load supported tokens
    await this.loadSupportedTokens();

    this.initialized = true;
    this.logger.info(
      `Platypus adapter initialized with ${this.supportedTokens.size} tokens`
    );
  }

  private async loadSupportedTokens(): Promise<void> {
    if (!this.poolContract) {
      return;
    }

    try {
      const tokens = await this.poolContract.getTokenAddresses();
      for (const token of tokens) {
        this.supportedTokens.add(token.toLowerCase());
      }
      this.logger.debug(`Loaded ${this.supportedTokens.size} supported tokens`);
    } catch (error) {
      this.logger.error('Failed to load supported tokens', { error });
      throw error;
    }
  }

  // ===========================================================================
  // Pool Discovery
  // ===========================================================================

  async discoverPools(tokenA: string, tokenB: string): Promise<DiscoveredPool[]> {
    if (this.destroyed || !this.initialized) {
      return [];
    }

    const token0 = tokenA.toLowerCase();
    const token1 = tokenB.toLowerCase();

    // Check if both tokens are supported
    if (!this.supportedTokens.has(token0) || !this.supportedTokens.has(token1)) {
      this.logger.debug('Token not supported', {
        token0,
        token1,
        supportedToken0: this.supportedTokens.has(token0),
        supportedToken1: this.supportedTokens.has(token1),
      });
      return [];
    }

    // Platypus uses a single pool for all stablecoin swaps
    const pool: DiscoveredPool = {
      poolId: this.primaryAddress,
      address: this.primaryAddress,
      tokens: [token0, token1],
      balances: [0n, 0n], // Filled lazily via getPoolReserves
      swapFee: PLATYPUS_SWAP_FEE_BASIS_POINTS,
      poolType: 'stable',
      dex: this.name,
      chain: this.chain,
      discoveredAt: Date.now(),
    };

    return [pool];
  }

  // ===========================================================================
  // Pool Reserves
  // ===========================================================================

  async getPoolReserves(poolId: string): Promise<PoolReserves | null> {
    if (!this.initialized || this.destroyed || !this.poolContract) {
      return null;
    }

    // For Platypus, poolId should be the main pool address
    if (poolId.toLowerCase() !== this.primaryAddress.toLowerCase()) {
      return null;
    }

    try {
      const tokens = Array.from(this.supportedTokens);
      const balances: bigint[] = [];

      // Fetch cash (available liquidity) for each token
      for (const token of tokens) {
        const cash = await this.poolContract.getCash(token);
        balances.push(BigInt(cash.toString()));
      }

      const blockNumber = await this.provider.getBlockNumber();

      return {
        poolId,
        tokens,
        balances,
        blockNumber,
        timestamp: Date.now(),
      };
    } catch (error) {
      this.logger.debug('Failed to get pool reserves', { poolId, error });
      return null;
    }
  }

  // ===========================================================================
  // Swap Quotes
  // ===========================================================================

  async getSwapQuote(
    poolId: string,
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint
  ): Promise<SwapQuote | null> {
    if (!this.initialized || this.destroyed || !this.poolContract) {
      return null;
    }

    const tokenInNorm = tokenIn.toLowerCase();
    const tokenOutNorm = tokenOut.toLowerCase();

    // Verify tokens are supported
    if (
      !this.supportedTokens.has(tokenInNorm) ||
      !this.supportedTokens.has(tokenOutNorm)
    ) {
      return null;
    }

    try {
      // Use quotePotentialSwap for accurate quote
      const result = await this.poolContract.quotePotentialSwap(
        tokenIn,
        tokenOut,
        amountIn
      );

      const amountOut = BigInt(result[0].toString()); // potentialOutcome
      const feeAmount = BigInt(result[1].toString()); // haircut (fee)

      // Calculate price impact
      // For stablecoins, price impact is typically very low
      const expectedOut = amountIn; // 1:1 for stables
      const priceImpact =
        expectedOut > 0n
          ? Math.abs(Number(expectedOut - amountOut)) / Number(expectedOut)
          : 0;

      const effectivePrice =
        amountOut > 0n ? Number(amountIn) / Number(amountOut) : 0;

      return {
        amountOut,
        priceImpact,
        feeAmount,
        effectivePrice,
      };
    } catch (error) {
      this.logger.debug('quotePotentialSwap failed', { error });
      return null;
    }
  }

  // ===========================================================================
  // Health Check
  // ===========================================================================

  async isHealthy(): Promise<boolean> {
    if (!this.initialized || this.destroyed) {
      return false;
    }

    try {
      await this.provider.getBlockNumber();
      return true;
    } catch {
      return false;
    }
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  async destroy(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    this.logger.info('Destroying Platypus adapter');

    this.destroyed = true;
    this.initialized = false;
    this.poolContract = null;
    this.supportedTokens.clear();
  }
}
