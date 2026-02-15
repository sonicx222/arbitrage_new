/**
 * GMX Adapter
 *
 * Vault-model DEX adapter for GMX spot trading.
 * GMX uses a single vault model where all whitelisted tokens
 * can be swapped against each other through the vault.
 *
 * Supported chains:
 * - Avalanche
 * - Arbitrum
 *
 * Architecture:
 * - Single Vault holds all token liquidity
 * - Reader contract provides swap quotes
 * - Tokens must be whitelisted to trade
 * - Pool is the Vault address itself
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
  GMX_VAULT_ABI,
  GMX_READER_ABI,
  withRpcTimeout,
} from './types';

// =============================================================================
// Constants
// =============================================================================

// GMX uses a flat 30 basis points (0.3%) swap fee
const GMX_SWAP_FEE_BASIS_POINTS = 30;

// =============================================================================
// Implementation
// =============================================================================

export class GmxAdapter implements DexAdapter {
  readonly name: string;
  readonly chain: string;
  readonly type: AdapterType = 'vault';
  readonly primaryAddress: string;

  private readonly provider: ethers.JsonRpcProvider;
  private readonly readerAddress: string;
  private readonly logger: Logger;

  private vaultContract: ethers.Contract | null = null;
  private readerContract: ethers.Contract | null = null;
  private whitelistedTokens: Set<string> = new Set();
  private initialized = false;
  private destroyed = false;

  constructor(config: AdapterConfig) {
    if (!config.provider) {
      throw new Error('GmxAdapter requires a provider');
    }

    this.name = config.name;
    this.chain = config.chain;
    this.primaryAddress = config.primaryAddress;
    this.readerAddress = config.secondaryAddress || '';
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

    this.logger.info(`Initializing GMX adapter for ${this.chain}`);

    // Verify provider connection
    try {
      await this.provider.getBlockNumber();
    } catch (error) {
      this.logger.error('Failed to connect to provider', { error });
      throw error;
    }

    // Create contract instances
    this.vaultContract = new ethers.Contract(
      this.primaryAddress,
      GMX_VAULT_ABI,
      this.provider
    );

    if (this.readerAddress) {
      this.readerContract = new ethers.Contract(
        this.readerAddress,
        GMX_READER_ABI,
        this.provider
      );
    }

    // Enumerate whitelisted tokens
    await this.loadWhitelistedTokens();

    this.initialized = true;
    this.logger.info(
      `GMX adapter initialized with ${this.whitelistedTokens.size} whitelisted tokens`
    );
  }

  private async loadWhitelistedTokens(): Promise<void> {
    if (!this.vaultContract) {
      return;
    }

    try {
      const count = await withRpcTimeout(this.vaultContract.whitelistedTokenCount());
      const tokenCount = Number(count);

      this.logger.debug(`Loading ${tokenCount} whitelisted tokens`);

      // FIX P1-6: Fetch all tokens in parallel instead of sequential RPC calls
      const tokenPromises = Array.from({ length: tokenCount }, (_, i) =>
        withRpcTimeout(this.vaultContract!.whitelistedTokens(i))
      );
      const tokens = await Promise.all(tokenPromises);
      for (const token of tokens) {
        this.whitelistedTokens.add((token as string).toLowerCase());
      }
    } catch (error) {
      this.logger.error('Failed to load whitelisted tokens', { error });
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

    // Check if both tokens are whitelisted
    if (!this.whitelistedTokens.has(token0) || !this.whitelistedTokens.has(token1)) {
      this.logger.debug('Token not whitelisted', {
        token0,
        token1,
        whitelistedToken0: this.whitelistedTokens.has(token0),
        whitelistedToken1: this.whitelistedTokens.has(token1),
      });
      return [];
    }

    // GMX uses a single vault as the "pool" for all tokens
    const pool: DiscoveredPool = {
      poolId: this.primaryAddress,
      address: this.primaryAddress,
      tokens: [token0, token1],
      balances: [0n, 0n], // Filled lazily via getPoolReserves
      swapFee: GMX_SWAP_FEE_BASIS_POINTS,
      poolType: 'gmx_spot',
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
    if (!this.initialized || this.destroyed || !this.vaultContract) {
      return null;
    }

    // For GMX, poolId should be the vault address
    if (poolId.toLowerCase() !== this.primaryAddress.toLowerCase()) {
      return null;
    }

    try {
      const tokens = Array.from(this.whitelistedTokens);

      // FIX P1-6: Fetch all pool amounts in parallel instead of sequential RPC calls
      const amountPromises = tokens.map((token) =>
        withRpcTimeout(this.vaultContract!.poolAmounts(token))
      );
      const amounts = await Promise.all(amountPromises);
      const balances: bigint[] = amounts.map((amount) => BigInt(amount.toString()));

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
    if (!this.initialized || this.destroyed) {
      return null;
    }

    const tokenInNorm = tokenIn.toLowerCase();
    const tokenOutNorm = tokenOut.toLowerCase();

    // Verify tokens are whitelisted
    if (
      !this.whitelistedTokens.has(tokenInNorm) ||
      !this.whitelistedTokens.has(tokenOutNorm)
    ) {
      return null;
    }

    // Use Reader contract if available
    if (this.readerContract) {
      try {
        const result = await withRpcTimeout(this.readerContract.getAmountOut(
          this.primaryAddress,
          tokenIn,
          tokenOut,
          amountIn
        ));

        const amountOut = BigInt(result[0].toString());
        const feeAmount = BigInt(result[1].toString());

        const effectivePrice =
          amountOut > 0n ? Number(amountIn) / Number(amountOut) : 0;

        // GMX uses oracle-based pricing so there's no AMM curve impact.
        // Price impact is effectively the fee ratio: fee / grossOutput.
        const grossOutput = amountOut + feeAmount;
        const priceImpact = grossOutput > 0n
          ? Number(feeAmount) / Number(grossOutput)
          : 0;

        return {
          amountOut,
          priceImpact,
          feeAmount,
          effectivePrice,
        };
      } catch (error) {
        this.logger.debug('Reader getAmountOut failed', { error });
        return null;
      }
    }

    // Fallback: estimate using pool amounts and prices
    return this.estimateSwapQuote(tokenInNorm, tokenOutNorm, amountIn);
  }

  private async estimateSwapQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint
  ): Promise<SwapQuote | null> {
    if (!this.vaultContract) {
      return null;
    }

    try {
      // Get min/max prices
      const [minPriceIn, maxPriceOut] = await Promise.all([
        withRpcTimeout(this.vaultContract.getMinPrice(tokenIn)),
        withRpcTimeout(this.vaultContract.getMaxPrice(tokenOut)),
      ]);

      // FIX P1-3: Guard against division by zero when maxPriceOut is 0
      // This can happen if the token is not priced or there's an oracle failure.
      const maxPriceOutBn = BigInt(maxPriceOut.toString());
      if (maxPriceOutBn === 0n) {
        this.logger.warn('maxPriceOut is zero, cannot estimate swap', { tokenOut });
        return null;
      }

      // Calculate output (simplified)
      // amountOut = amountIn * priceIn / priceOut * (1 - fee)
      const feeMultiplier = BigInt(10000 - GMX_SWAP_FEE_BASIS_POINTS);
      const valueIn = amountIn * BigInt(minPriceIn.toString());
      const amountOutRaw = valueIn / maxPriceOutBn;
      const amountOut = (amountOutRaw * feeMultiplier) / BigInt(10000);

      const feeAmount = (amountIn * BigInt(GMX_SWAP_FEE_BASIS_POINTS)) / BigInt(10000);
      const effectivePrice =
        amountOut > 0n ? Number(amountIn) / Number(amountOut) : 0;

      // Price impact in the fallback path is the fee rate since GMX uses oracle pricing
      const grossOutputEst = amountOut + feeAmount;
      const priceImpactEst = grossOutputEst > 0n
        ? Number(feeAmount) / Number(grossOutputEst)
        : 0;

      return {
        amountOut,
        priceImpact: priceImpactEst,
        feeAmount,
        effectivePrice,
      };
    } catch (error) {
      this.logger.debug('Swap estimation failed', { error });
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

    this.logger.info('Destroying GMX adapter');

    this.destroyed = true;
    this.initialized = false;
    this.vaultContract = null;
    this.readerContract = null;
    this.whitelistedTokens.clear();
  }
}
