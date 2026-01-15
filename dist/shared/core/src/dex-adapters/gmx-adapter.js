"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.GmxAdapter = void 0;
const ethers_1 = require("ethers");
const logger_1 = require("../logger");
const types_1 = require("./types");
// =============================================================================
// Constants
// =============================================================================
// GMX uses a flat 30 basis points (0.3%) swap fee
const GMX_SWAP_FEE_BASIS_POINTS = 30;
// =============================================================================
// Implementation
// =============================================================================
class GmxAdapter {
    constructor(config) {
        this.type = 'vault';
        this.vaultContract = null;
        this.readerContract = null;
        this.whitelistedTokens = new Set();
        this.initialized = false;
        this.destroyed = false;
        if (!config.provider) {
            throw new Error('GmxAdapter requires a provider');
        }
        this.name = config.name;
        this.chain = config.chain;
        this.primaryAddress = config.primaryAddress;
        this.readerAddress = config.secondaryAddress || '';
        this.provider = config.provider;
        this.logger = (0, logger_1.createLogger)(`${this.name}-adapter`);
    }
    // ===========================================================================
    // Initialization
    // ===========================================================================
    async initialize() {
        if (this.initialized || this.destroyed) {
            return;
        }
        this.logger.info(`Initializing GMX adapter for ${this.chain}`);
        // Verify provider connection
        try {
            await this.provider.getBlockNumber();
        }
        catch (error) {
            this.logger.error('Failed to connect to provider', { error });
            throw error;
        }
        // Create contract instances
        this.vaultContract = new ethers_1.ethers.Contract(this.primaryAddress, types_1.GMX_VAULT_ABI, this.provider);
        if (this.readerAddress) {
            this.readerContract = new ethers_1.ethers.Contract(this.readerAddress, types_1.GMX_READER_ABI, this.provider);
        }
        // Enumerate whitelisted tokens
        await this.loadWhitelistedTokens();
        this.initialized = true;
        this.logger.info(`GMX adapter initialized with ${this.whitelistedTokens.size} whitelisted tokens`);
    }
    async loadWhitelistedTokens() {
        if (!this.vaultContract) {
            return;
        }
        try {
            const count = await this.vaultContract.whitelistedTokenCount();
            const tokenCount = Number(count);
            this.logger.debug(`Loading ${tokenCount} whitelisted tokens`);
            for (let i = 0; i < tokenCount; i++) {
                const token = await this.vaultContract.whitelistedTokens(i);
                this.whitelistedTokens.add(token.toLowerCase());
            }
        }
        catch (error) {
            this.logger.error('Failed to load whitelisted tokens', { error });
            throw error;
        }
    }
    // ===========================================================================
    // Pool Discovery
    // ===========================================================================
    async discoverPools(tokenA, tokenB) {
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
        const pool = {
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
    async getPoolReserves(poolId) {
        if (!this.initialized || this.destroyed || !this.vaultContract) {
            return null;
        }
        // For GMX, poolId should be the vault address
        if (poolId.toLowerCase() !== this.primaryAddress.toLowerCase()) {
            return null;
        }
        try {
            const tokens = Array.from(this.whitelistedTokens);
            const balances = [];
            // Fetch pool amounts for each whitelisted token
            for (const token of tokens) {
                const amount = await this.vaultContract.poolAmounts(token);
                balances.push(BigInt(amount.toString()));
            }
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
        const tokenInNorm = tokenIn.toLowerCase();
        const tokenOutNorm = tokenOut.toLowerCase();
        // Verify tokens are whitelisted
        if (!this.whitelistedTokens.has(tokenInNorm) ||
            !this.whitelistedTokens.has(tokenOutNorm)) {
            return null;
        }
        // Use Reader contract if available
        if (this.readerContract) {
            try {
                const result = await this.readerContract.getAmountOut(this.primaryAddress, tokenIn, tokenOut, amountIn);
                const amountOut = BigInt(result[0].toString());
                const feeAmount = BigInt(result[1].toString());
                // Calculate price impact (simplified)
                const effectivePrice = amountOut > 0n ? Number(amountIn) / Number(amountOut) : 0;
                // GMX has relatively low price impact due to oracle-based pricing
                const priceImpact = 0.001; // 0.1% estimate
                return {
                    amountOut,
                    priceImpact,
                    feeAmount,
                    effectivePrice,
                };
            }
            catch (error) {
                this.logger.debug('Reader getAmountOut failed', { error });
                return null;
            }
        }
        // Fallback: estimate using pool amounts and prices
        return this.estimateSwapQuote(tokenInNorm, tokenOutNorm, amountIn);
    }
    async estimateSwapQuote(tokenIn, tokenOut, amountIn) {
        if (!this.vaultContract) {
            return null;
        }
        try {
            // Get min/max prices
            const [minPriceIn, maxPriceOut] = await Promise.all([
                this.vaultContract.getMinPrice(tokenIn),
                this.vaultContract.getMaxPrice(tokenOut),
            ]);
            // Calculate output (simplified)
            // amountOut = amountIn * priceIn / priceOut * (1 - fee)
            const feeMultiplier = BigInt(10000 - GMX_SWAP_FEE_BASIS_POINTS);
            const valueIn = amountIn * BigInt(minPriceIn.toString());
            const amountOutRaw = valueIn / BigInt(maxPriceOut.toString());
            const amountOut = (amountOutRaw * feeMultiplier) / BigInt(10000);
            const feeAmount = (amountIn * BigInt(GMX_SWAP_FEE_BASIS_POINTS)) / BigInt(10000);
            const effectivePrice = amountOut > 0n ? Number(amountIn) / Number(amountOut) : 0;
            return {
                amountOut,
                priceImpact: 0.001,
                feeAmount,
                effectivePrice,
            };
        }
        catch (error) {
            this.logger.debug('Swap estimation failed', { error });
            return null;
        }
    }
    // ===========================================================================
    // Health Check
    // ===========================================================================
    async isHealthy() {
        if (!this.initialized || this.destroyed) {
            return false;
        }
        try {
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
        this.logger.info('Destroying GMX adapter');
        this.destroyed = true;
        this.initialized = false;
        this.vaultContract = null;
        this.readerContract = null;
        this.whitelistedTokens.clear();
    }
}
exports.GmxAdapter = GmxAdapter;
//# sourceMappingURL=gmx-adapter.js.map