"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.BalancerV2Adapter = void 0;
const ethers_1 = require("ethers");
const logger_1 = require("../logger");
const types_1 = require("./types");
// =============================================================================
// Constants
// =============================================================================
const CACHE_TTL_MS = 60000; // 1 minute cache for pool metadata
const SUBGRAPH_TIMEOUT_MS = 10000;
// Pool type mapping from Subgraph to internal types
const POOL_TYPE_MAP = {
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
class BalancerV2Adapter {
    constructor(config) {
        this.type = 'vault';
        this.vaultContract = null;
        this.poolCache = new Map();
        this.initialized = false;
        this.destroyed = false;
        if (!config.provider) {
            throw new Error('BalancerV2Adapter requires a provider');
        }
        this.name = config.name;
        this.chain = config.chain;
        this.primaryAddress = config.primaryAddress;
        this.provider = config.provider;
        this.subgraphUrl = config.subgraphUrl;
        this.logger = (0, logger_1.createLogger)(`${this.name}-adapter`);
    }
    // ===========================================================================
    // Initialization
    // ===========================================================================
    async initialize() {
        if (this.initialized || this.destroyed) {
            return;
        }
        this.logger.info(`Initializing ${this.name} adapter for ${this.chain}`);
        // Verify provider connection
        try {
            await this.provider.getBlockNumber();
        }
        catch (error) {
            this.logger.error('Failed to connect to provider', { error });
            throw error;
        }
        // Create vault contract instance
        this.vaultContract = new ethers_1.ethers.Contract(this.primaryAddress, types_1.BALANCER_VAULT_ABI, this.provider);
        this.initialized = true;
        this.logger.info(`${this.name} adapter initialized successfully`);
    }
    // ===========================================================================
    // Pool Discovery
    // ===========================================================================
    async discoverPools(tokenA, tokenB) {
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
            }
            catch (error) {
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
    async discoverPoolsViaSubgraph(token0, token1) {
        const query = this.buildSubgraphQuery(token0, token1);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), SUBGRAPH_TIMEOUT_MS);
        try {
            const response = await fetch(this.subgraphUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query }),
                signal: controller.signal,
            });
            if (!response.ok) {
                throw new Error(`Subgraph returned ${response.status}`);
            }
            const data = (await response.json());
            const pools = data?.data?.pools || [];
            // Filter pools that contain both tokens
            const matchingPools = pools.filter((pool) => {
                const poolTokens = pool.tokens.map((t) => t.address.toLowerCase());
                return poolTokens.includes(token0) && poolTokens.includes(token1);
            });
            return matchingPools.map((pool) => this.mapSubgraphPool(pool));
        }
        finally {
            clearTimeout(timeout);
        }
    }
    buildSubgraphQuery(token0, token1) {
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
            weight
          }
        }
      }
    `;
    }
    mapSubgraphPool(pool) {
        const poolType = this.mapPoolType(pool.poolType);
        const swapFee = Math.round(parseFloat(pool.swapFee) * 10000); // Convert to basis points
        const discovered = {
            poolId: pool.id,
            address: pool.address,
            tokens: pool.tokens.map((t) => t.address.toLowerCase()),
            balances: pool.tokens.map((t) => BigInt(Math.floor(parseFloat(t.balance) * 1e18))),
            swapFee,
            poolType,
            dex: this.name,
            chain: this.chain,
            discoveredAt: Date.now(),
        };
        // Cache pool with weights for swap calculations
        const weights = pool.tokens.map((t) => t.weight ? parseFloat(t.weight) : 0.5);
        this.poolCache.set(pool.id, {
            pool: discovered,
            weights,
            lastFetch: Date.now(),
        });
        return discovered;
    }
    mapPoolType(subgraphType) {
        return POOL_TYPE_MAP[subgraphType] || 'weighted';
    }
    // ===========================================================================
    // Pool Reserves
    // ===========================================================================
    async getPoolReserves(poolId) {
        if (!this.initialized || this.destroyed || !this.vaultContract) {
            return null;
        }
        try {
            // Call vault.getPoolTokens(poolId)
            const result = await this.vaultContract.getPoolTokens(poolId);
            const tokens = result[0].map((t) => t.toLowerCase());
            const balances = result[1].map((b) => b);
            const blockNumber = await this.provider.getBlockNumber();
            return {
                poolId,
                tokens,
                balances,
                blockNumber,
                timestamp: Date.now(),
            };
        }
        catch (error) {
            this.logger.debug('Failed to get pool reserves', { poolId, error });
            return null;
        }
    }
    // ===========================================================================
    // Swap Quotes
    // ===========================================================================
    async getSwapQuote(poolId, tokenIn, tokenOut, amountIn) {
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
        let amountOut;
        let priceImpact;
        if (pool.poolType === 'weighted' && weights) {
            // Weighted pool math: out = balanceOut * (1 - (balanceIn / (balanceIn + amountIn * (1 - fee)))^(wIn/wOut))
            const weightIn = weights[indexIn] || 0.5;
            const weightOut = weights[indexOut] || 0.5;
            const amountInAfterFee = (amountIn * BigInt(Math.floor((1 - fee) * 1e18))) / BigInt(1e18);
            const ratio = Number(balanceIn) / (Number(balanceIn) + Number(amountInAfterFee));
            const power = weightIn / weightOut;
            const outRatio = 1 - Math.pow(ratio, power);
            amountOut = BigInt(Math.floor(Number(balanceOut) * outRatio));
            // Price impact calculation
            const spotPrice = (Number(balanceIn) / weightIn) / (Number(balanceOut) / weightOut);
            const executionPrice = Number(amountIn) / Number(amountOut);
            priceImpact = Math.abs(executionPrice - spotPrice) / spotPrice;
        }
        else {
            // Stable pool - simplified constant sum approximation
            const amountInAfterFee = (amountIn * BigInt(Math.floor((1 - fee) * 1e18))) / BigInt(1e18);
            // For stable pools, approximate 1:1 ratio with small slippage
            amountOut = amountInAfterFee;
            priceImpact = fee; // Minimal price impact for stables
        }
        const feeAmount = (amountIn * BigInt(pool.swapFee)) / BigInt(10000);
        const effectivePrice = amountOut > 0n ? Number(amountIn) / Number(amountOut) : 0;
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
    async isHealthy() {
        if (!this.initialized || this.destroyed) {
            return false;
        }
        try {
            // Simple health check - verify provider is responsive
            await this.provider.getBlockNumber();
            return true;
        }
        catch {
            return false;
        }
    }
    // ===========================================================================
    // Cleanup
    // ===========================================================================
    async destroy() {
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
exports.BalancerV2Adapter = BalancerV2Adapter;
//# sourceMappingURL=balancer-v2-adapter.js.map