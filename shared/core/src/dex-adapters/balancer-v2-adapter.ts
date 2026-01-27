/**
 * Balancer V2 / Beethoven X Adapter
 *
 * Vault-model DEX adapter for:
 * - Balancer V2 (Arbitrum, Ethereum, Polygon, Optimism, Base)
 * - Beethoven X (Fantom) - uses same vault interface
 *
 * Architecture:
 * - Single Vault contract holds all pool liquidity
 * - Pools identified by bytes32 poolId (not pair addresses)
 * - Pool discovery via Subgraph API
 * - Reserves fetched via Vault.getPoolTokens()
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
  PoolType,
  BALANCER_VAULT_ABI,
} from './types';

// =============================================================================
// Types
// =============================================================================

interface SubgraphPool {
  id: string;
  address: string;
  poolType: string;
  swapFee: string;
  tokens: Array<{
    address: string;
    balance: string;
    decimals: number;
    weight?: string;
  }>;
}

interface PoolCache {
  pool: DiscoveredPool;
  weights?: number[];
  lastFetch: number;
}

// =============================================================================
// Constants
// =============================================================================

const CACHE_TTL_MS = 60_000; // 1 minute cache for pool metadata
const SUBGRAPH_TIMEOUT_MS = 10_000;

// Pool type mapping from Subgraph to internal types
const POOL_TYPE_MAP: Record<string, PoolType> = {
  Weighted: 'weighted',
  Stable: 'stable',
  ComposableStable: 'composable_stable',
  MetaStable: 'stable',
  LiquidityBootstrapping: 'weighted',
  Linear: 'linear',
  // Defaults to 'weighted' for unknown types
};

// =============================================================================
// Implementation
// =============================================================================

export class BalancerV2Adapter implements DexAdapter {
  readonly name: string;
  readonly chain: string;
  readonly type: AdapterType = 'vault';
  readonly primaryAddress: string;

  private readonly provider: ethers.JsonRpcProvider;
  private readonly subgraphUrl?: string;
  private readonly logger: Logger;

  private vaultContract: ethers.Contract | null = null;
  private poolCache: Map<string, PoolCache> = new Map();
  private initialized = false;
  private destroyed = false;

  constructor(config: AdapterConfig) {
    if (!config.provider) {
      throw new Error('BalancerV2Adapter requires a provider');
    }

    this.name = config.name;
    this.chain = config.chain;
    this.primaryAddress = config.primaryAddress;
    this.provider = config.provider;
    this.subgraphUrl = config.subgraphUrl;

    this.logger = createLogger(`${this.name}-adapter`);
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  async initialize(): Promise<void> {
    if (this.initialized || this.destroyed) {
      return;
    }

    this.logger.info(`Initializing ${this.name} adapter for ${this.chain}`);

    // Verify provider connection
    try {
      await this.provider.getBlockNumber();
    } catch (error) {
      this.logger.error('Failed to connect to provider', { error });
      throw error;
    }

    // Create vault contract instance
    this.vaultContract = new ethers.Contract(
      this.primaryAddress,
      BALANCER_VAULT_ABI,
      this.provider
    );

    this.initialized = true;
    this.logger.info(`${this.name} adapter initialized successfully`);
  }

  // ===========================================================================
  // Pool Discovery
  // ===========================================================================

  async discoverPools(tokenA: string, tokenB: string): Promise<DiscoveredPool[]> {
    if (this.destroyed) {
      return [];
    }

    // Normalize addresses
    const token0 = tokenA.toLowerCase();
    const token1 = tokenB.toLowerCase();

    // Try subgraph first
    if (this.subgraphUrl) {
      try {
        return await this.discoverPoolsViaSubgraph(token0, token1);
      } catch (error) {
        this.logger.warn('Subgraph query failed, returning empty result', {
          error,
        });
        return [];
      }
    }

    // No subgraph available
    this.logger.warn('No subgraph URL configured for pool discovery');
    return [];
  }

  private async discoverPoolsViaSubgraph(
    token0: string,
    token1: string
  ): Promise<DiscoveredPool[]> {
    const query = this.buildSubgraphQuery(token0, token1);

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      SUBGRAPH_TIMEOUT_MS
    );

    try {
      const response = await fetch(this.subgraphUrl!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Subgraph returned ${response.status}`);
      }

      const data = (await response.json()) as { data?: { pools?: SubgraphPool[] } };
      const pools: SubgraphPool[] = data?.data?.pools || [];

      // Filter pools that contain both tokens
      const matchingPools = pools.filter((pool) => {
        const poolTokens = pool.tokens.map((t) => t.address.toLowerCase());
        return poolTokens.includes(token0) && poolTokens.includes(token1);
      });

      return matchingPools.map((pool) => this.mapSubgraphPool(pool));
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildSubgraphQuery(token0: string, token1: string): string {
    // Query pools that contain both tokens
    // The subgraph uses tokensList which is an array of token addresses
    return `
      {
        pools(
          first: 100,
          where: {
            tokensList_contains: ["${token0}", "${token1}"],
            totalLiquidity_gt: "1000"
          }
        ) {
          id
          address
          poolType
          swapFee
          tokens {
            address
            balance
            decimals
            weight
          }
        }
      }
    `;
  }

  private mapSubgraphPool(pool: SubgraphPool): DiscoveredPool {
    const poolType = this.mapPoolType(pool.poolType);
    const swapFee = Math.round(parseFloat(pool.swapFee) * 10000); // Convert to basis points

    const discovered: DiscoveredPool = {
      poolId: pool.id,
      address: pool.address,
      tokens: pool.tokens.map((t) => t.address.toLowerCase()),
      // FIX: Use actual token decimals from subgraph (not hardcoded 18)
      // Tokens like USDC/USDT have 6 decimals, WBTC has 8, etc.
      // Balancer subgraph returns balance as human-readable string for each token
      balances: pool.tokens.map((t) =>
        ethers.parseUnits(t.balance || '0', t.decimals || 18)
      ),
      swapFee,
      poolType,
      dex: this.name,
      chain: this.chain,
      discoveredAt: Date.now(),
    };

    // Cache pool with weights for swap calculations
    const weights = pool.tokens.map((t) =>
      t.weight ? parseFloat(t.weight) : 0.5
    );
    this.poolCache.set(pool.id, {
      pool: discovered,
      weights,
      lastFetch: Date.now(),
    });

    return discovered;
  }

  private mapPoolType(subgraphType: string): PoolType {
    return POOL_TYPE_MAP[subgraphType] || 'weighted';
  }

  // ===========================================================================
  // Pool Reserves
  // ===========================================================================

  async getPoolReserves(poolId: string): Promise<PoolReserves | null> {
    if (!this.initialized || this.destroyed || !this.vaultContract) {
      return null;
    }

    try {
      // Call vault.getPoolTokens(poolId)
      const result = await this.vaultContract.getPoolTokens(poolId);

      const tokens: string[] = result[0].map((t: string) => t.toLowerCase());
      const balances: bigint[] = result[1].map((b: bigint) => b);
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

    // Get cached pool info
    const cached = this.poolCache.get(poolId);
    if (!cached) {
      return null;
    }

    const { pool, weights } = cached;

    // Get current reserves
    const reserves = await this.getPoolReserves(poolId);
    if (!reserves) {
      return null;
    }

    // Find token indices
    const tokenInNorm = tokenIn.toLowerCase();
    const tokenOutNorm = tokenOut.toLowerCase();
    const indexIn = reserves.tokens.indexOf(tokenInNorm);
    const indexOut = reserves.tokens.indexOf(tokenOutNorm);

    if (indexIn === -1 || indexOut === -1) {
      return null;
    }

    // Calculate swap output based on pool type
    const balanceIn = reserves.balances[indexIn];
    const balanceOut = reserves.balances[indexOut];
    const fee = pool.swapFee / 10000; // Convert basis points to decimal

    let amountOut: bigint;
    let priceImpact: number;

    // PRECISION-FIX: Calculate fee multiplier in basis points for better precision
    // fee is already in decimal (0.01 = 1%), convert to basis points complement: (10000 - swapFee)
    const feeMultiplierBps = BigInt(10000 - pool.swapFee); // e.g., 9900 for 1% fee

    if (pool.poolType === 'weighted' && weights) {
      // Weighted pool math: out = balanceOut * (1 - (balanceIn / (balanceIn + amountIn * (1 - fee)))^(wIn/wOut))
      const weightIn = weights[indexIn] || 0.5;
      const weightOut = weights[indexOut] || 0.5;

      // PRECISION-FIX: Use basis points for fee calculation
      const amountInAfterFee = (amountIn * feeMultiplierBps) / 10000n;

      // NOTE: The following calculations require float math for Math.pow with fractional exponents.
      // This is an unavoidable limitation without a BigNumber library supporting fractional powers.
      // Precision loss is acceptable here as it's bounded by the ratio/power calculation.
      const ratio =
        Number(balanceIn) / (Number(balanceIn) + Number(amountInAfterFee));
      const power = weightIn / weightOut;
      const outRatio = 1 - Math.pow(ratio, power);

      // PRECISION-NOTE: Converting BigInt to Number for weighted pool math
      // Large balances (>2^53) will lose precision, but this is inherent to the algorithm
      amountOut = BigInt(Math.floor(Number(balanceOut) * outRatio));

      // Price impact calculation
      const spotPrice =
        (Number(balanceIn) / weightIn) / (Number(balanceOut) / weightOut);
      const executionPrice = Number(amountIn) / Number(amountOut);
      priceImpact = Math.abs(executionPrice - spotPrice) / spotPrice;
    } else {
      // Stable pool - simplified constant sum approximation
      // PRECISION-FIX: Use basis points for fee calculation
      const amountInAfterFee = (amountIn * feeMultiplierBps) / 10000n;

      // For stable pools, approximate 1:1 ratio with small slippage
      amountOut = amountInAfterFee;
      priceImpact = fee; // Minimal price impact for stables
    }

    const feeAmount = (amountIn * BigInt(pool.swapFee)) / BigInt(10000);
    const effectivePrice =
      amountOut > 0n ? Number(amountIn) / Number(amountOut) : 0;

    return {
      amountOut,
      priceImpact,
      feeAmount,
      effectivePrice,
    };
  }

  // ===========================================================================
  // Health Check
  // ===========================================================================

  async isHealthy(): Promise<boolean> {
    if (!this.initialized || this.destroyed) {
      return false;
    }

    try {
      // Simple health check - verify provider is responsive
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

    this.logger.info(`Destroying ${this.name} adapter`);

    this.destroyed = true;
    this.initialized = false;
    this.vaultContract = null;
    this.poolCache.clear();
  }
}
