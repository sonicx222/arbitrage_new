"use strict";
/**
 * Gas Price Cache
 *
 * Provides dynamic gas price caching with periodic refresh for accurate
 * arbitrage profit calculations. Replaces static gas estimates with
 * real-time data from RPC providers.
 *
 * Features:
 * - Per-chain gas price storage with 60-second refresh
 * - Graceful fallback to static estimates on RPC failure
 * - Native token price integration for USD conversion
 * - Thread-safe singleton pattern
 *
 * @see ADR-012-worker-thread-path-finding.md - Gas optimization phase
 * @see docs/DETECTOR_OPTIMIZATION_ANALYSIS.md - Phase 2 recommendations
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.GasPriceCache = exports.FALLBACK_GAS_SCALING_PER_STEP = exports.FALLBACK_GAS_COSTS_ETH = exports.DEFAULT_TRADE_AMOUNT_USD = exports.GAS_UNITS = void 0;
exports.getGasPriceCache = getGasPriceCache;
exports.resetGasPriceCache = resetGasPriceCache;
const logger_1 = require("./logger");
const config_1 = require("@arbitrage/config");
// =============================================================================
// Default Configuration
// =============================================================================
const DEFAULT_CONFIG = {
    refreshIntervalMs: 60000, // 60 seconds
    staleThresholdMs: 120000, // 2 minutes
    autoRefresh: true
};
/**
 * Static fallback gas prices (in gwei) per chain.
 * Used when RPC fails or before first fetch.
 */
const FALLBACK_GAS_PRICES = {
    ethereum: 30, // ~30 gwei average
    arbitrum: 0.1, // Very low L2 fees
    optimism: 0.01, // Low L2 fees
    base: 0.01, // Low L2 fees
    polygon: 50, // ~50 gwei average
    bsc: 3, // ~3 gwei average
    avalanche: 25, // ~25 nAVAX
    fantom: 50, // ~50 gwei
    zksync: 0.25, // L2 fees
    linea: 0.5 // L2 fees
};
/**
 * Static fallback native token prices (USD) per chain.
 * Used when price oracle is unavailable.
 */
const FALLBACK_NATIVE_PRICES = {
    ethereum: 2500,
    arbitrum: 2500, // ETH
    optimism: 2500, // ETH
    base: 2500, // ETH
    polygon: 0.5, // MATIC
    bsc: 300, // BNB
    avalanche: 25, // AVAX
    fantom: 0.3, // FTM
    zksync: 2500, // ETH
    linea: 2500 // ETH
};
/**
 * Default gas units per operation type.
 */
exports.GAS_UNITS = {
    /** Simple swap (Uniswap V2 style) */
    simpleSwap: 150000,
    /** Complex swap (Uniswap V3, Curve, etc.) */
    complexSwap: 200000,
    /** Triangular arbitrage (3 swaps) */
    triangularArbitrage: 450000,
    /** Quadrilateral arbitrage (4 swaps) */
    quadrilateralArbitrage: 600000,
    /** Multi-leg arbitrage per additional hop */
    multiLegPerHop: 150000,
    /** Base gas for multi-leg (overhead) */
    multiLegBase: 100000
};
/**
 * Default trade amount for gas cost ratio calculations.
 * Used to convert USD gas costs to profit ratios.
 */
exports.DEFAULT_TRADE_AMOUNT_USD = 2000;
/**
 * Static fallback gas costs per chain (in ETH/native token).
 * Used when gas cache is unavailable.
 */
exports.FALLBACK_GAS_COSTS_ETH = {
    ethereum: 0.005, // ~$10 at $2000/ETH
    bsc: 0.0001, // ~$0.03 at $300/BNB
    arbitrum: 0.00005, // Very low L2 fees
    base: 0.00001, // Coinbase L2
    polygon: 0.0001, // Polygon fees
    optimism: 0.00005, // Optimism L2
    avalanche: 0.001, // Avalanche fees
    fantom: 0.0001, // Fantom fees
    zksync: 0.00005, // zkSync L2
    linea: 0.0001 // Linea L2
};
/**
 * Consistent fallback scaling factor per step.
 * Each additional step adds 25% to base gas cost.
 */
exports.FALLBACK_GAS_SCALING_PER_STEP = 0.25;
// =============================================================================
// GasPriceCache Class
// =============================================================================
/**
 * Singleton cache for gas prices across all chains.
 * Provides real-time gas price data with automatic refresh.
 */
class GasPriceCache {
    constructor(config = {}, deps) {
        this.gasPrices = new Map();
        this.nativePrices = new Map();
        this.refreshTimer = null;
        this.isRunning = false;
        this.isRefreshing = false; // Mutex to prevent concurrent refresh
        this.providers = new Map(); // ethers providers
        this.config = { ...DEFAULT_CONFIG, ...config };
        // DI: Use provided logger or create default
        this.logger = deps?.logger ?? (0, logger_1.createLogger)('gas-price-cache');
        // Initialize with fallback values immediately so cache works without start()
        // This ensures getGasPrice() and getNativeTokenPrice() return valid data
        // even if start() is never called (graceful degradation per ADR-013)
        this.initializeFallbacks();
        this.logger.info('GasPriceCache initialized', {
            refreshIntervalMs: this.config.refreshIntervalMs,
            staleThresholdMs: this.config.staleThresholdMs,
            autoRefresh: this.config.autoRefresh
        });
    }
    /**
     * Start the gas price cache with automatic refresh.
     */
    async start() {
        if (this.isRunning) {
            this.logger.warn('GasPriceCache already running');
            return;
        }
        this.isRunning = true;
        // Fallbacks already initialized in constructor
        // Perform initial fetch to get real gas prices
        await this.refreshAll();
        // Start auto-refresh if enabled
        if (this.config.autoRefresh) {
            this.startRefreshTimer();
        }
        this.logger.info('GasPriceCache started');
    }
    /**
     * Stop the gas price cache and clear timers.
     */
    async stop() {
        if (!this.isRunning)
            return;
        this.isRunning = false;
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
        // Clear providers
        this.providers.clear();
        this.logger.info('GasPriceCache stopped');
    }
    /**
     * Get gas price for a specific chain.
     *
     * @param chain - Chain name (e.g., 'ethereum', 'arbitrum')
     * @returns Gas price data or fallback
     */
    getGasPrice(chain) {
        const cached = this.gasPrices.get(chain.toLowerCase());
        if (cached) {
            // Check if data is stale
            const age = Date.now() - cached.lastUpdated;
            if (age > this.config.staleThresholdMs) {
                this.logger.warn(`Gas price for ${chain} is stale (${age}ms old)`);
                // Return stale data but mark as potentially unreliable
                return { ...cached, isFallback: true };
            }
            return cached;
        }
        // Return fallback
        return this.createFallbackGasPrice(chain);
    }
    /**
     * Get native token price for a chain.
     *
     * @param chain - Chain name
     * @returns Native token price data
     */
    getNativeTokenPrice(chain) {
        const cached = this.nativePrices.get(chain.toLowerCase());
        if (cached) {
            const age = Date.now() - cached.lastUpdated;
            if (age > this.config.staleThresholdMs) {
                return { ...cached, isFallback: true };
            }
            return cached;
        }
        // Return fallback
        return {
            priceUsd: FALLBACK_NATIVE_PRICES[chain.toLowerCase()] || 1000,
            lastUpdated: Date.now(),
            isFallback: true
        };
    }
    /**
     * Estimate gas cost in USD for an operation.
     *
     * @param chain - Chain name
     * @param gasUnits - Number of gas units (use GAS_UNITS constants)
     * @returns Gas cost estimate with metadata
     */
    estimateGasCostUsd(chain, gasUnits) {
        const chainLower = chain.toLowerCase();
        const gasPrice = this.getGasPrice(chainLower);
        const nativePrice = this.getNativeTokenPrice(chainLower);
        // Calculate cost: gasUnits * gasPrice (in ETH) * nativeTokenPrice (USD)
        const gasPriceEth = gasPrice.gasPriceGwei / 1e9; // gwei to ETH
        const costUsd = gasUnits * gasPriceEth * nativePrice.priceUsd;
        return {
            costUsd,
            gasPriceGwei: gasPrice.gasPriceGwei,
            gasUnits,
            nativeTokenPriceUsd: nativePrice.priceUsd,
            usesFallback: gasPrice.isFallback || nativePrice.isFallback,
            chain: chainLower
        };
    }
    /**
     * Estimate gas cost for multi-leg arbitrage.
     *
     * @param chain - Chain name
     * @param numHops - Number of swaps in the path
     * @returns Gas cost in USD
     */
    estimateMultiLegGasCost(chain, numHops) {
        const gasUnits = exports.GAS_UNITS.multiLegBase + (numHops * exports.GAS_UNITS.multiLegPerHop);
        const estimate = this.estimateGasCostUsd(chain, gasUnits);
        return estimate.costUsd;
    }
    /**
     * Estimate gas cost for triangular arbitrage.
     *
     * @param chain - Chain name
     * @returns Gas cost in USD
     */
    estimateTriangularGasCost(chain) {
        const estimate = this.estimateGasCostUsd(chain, exports.GAS_UNITS.triangularArbitrage);
        return estimate.costUsd;
    }
    /**
     * Estimate gas cost as a ratio of trade amount.
     * This is the recommended method for profit calculations as it keeps units consistent.
     *
     * @param chain - Chain name
     * @param operationType - Type of operation ('simple', 'triangular', 'quadrilateral', 'multiLeg')
     * @param numSteps - Number of steps (only used for 'multiLeg')
     * @param tradeAmountUsd - Trade amount in USD (default: DEFAULT_TRADE_AMOUNT_USD)
     * @returns Gas cost as a ratio (e.g., 0.005 = 0.5% of trade amount)
     */
    estimateGasCostRatio(chain, operationType, numSteps = 3, tradeAmountUsd = exports.DEFAULT_TRADE_AMOUNT_USD) {
        // Determine gas units based on operation type
        let gasUnits;
        switch (operationType) {
            case 'simple':
                gasUnits = exports.GAS_UNITS.simpleSwap;
                break;
            case 'triangular':
                gasUnits = exports.GAS_UNITS.triangularArbitrage;
                break;
            case 'quadrilateral':
                gasUnits = exports.GAS_UNITS.quadrilateralArbitrage;
                break;
            case 'multiLeg':
                gasUnits = exports.GAS_UNITS.multiLegBase + (numSteps * exports.GAS_UNITS.multiLegPerHop);
                break;
            default:
                gasUnits = exports.GAS_UNITS.simpleSwap;
        }
        const estimate = this.estimateGasCostUsd(chain, gasUnits);
        return estimate.costUsd / tradeAmountUsd;
    }
    /**
     * Get cache statistics.
     */
    getStats() {
        const now = Date.now();
        let fresh = 0;
        let stale = 0;
        let fallback = 0;
        for (const data of this.gasPrices.values()) {
            if (data.isFallback) {
                fallback++;
            }
            else if (now - data.lastUpdated > this.config.staleThresholdMs) {
                stale++;
            }
            else {
                fresh++;
            }
        }
        return {
            chainsMonitored: this.gasPrices.size,
            freshPrices: fresh,
            stalePrices: stale,
            fallbackPrices: fallback,
            lastRefresh: Math.max(...Array.from(this.gasPrices.values()).map(d => d.lastUpdated), 0)
        };
    }
    /**
     * Manually refresh gas prices for all chains.
     * Protected by mutex to prevent concurrent refresh operations.
     */
    async refreshAll() {
        // Prevent concurrent refresh operations (race condition protection)
        if (this.isRefreshing) {
            this.logger.debug('Refresh already in progress, skipping');
            return;
        }
        this.isRefreshing = true;
        try {
            const chains = this.config.chains || Object.keys(config_1.CHAINS);
            const results = await Promise.allSettled(chains.map(chain => this.refreshChain(chain)));
            const succeeded = results.filter(r => r.status === 'fulfilled').length;
            const failed = results.filter(r => r.status === 'rejected').length;
            this.logger.info('Gas price refresh completed', { succeeded, failed, total: chains.length });
        }
        finally {
            this.isRefreshing = false;
        }
    }
    /**
     * Refresh gas price for a specific chain.
     */
    async refreshChain(chain) {
        const chainLower = chain.toLowerCase();
        try {
            // Try to fetch real gas price via RPC
            const chainConfig = config_1.CHAINS[chainLower];
            if (!chainConfig) {
                this.logger.warn(`Unknown chain: ${chain}`);
                return;
            }
            // Use dynamic import for ethers to avoid issues in worker threads
            const { ethers } = await Promise.resolve().then(() => __importStar(require('ethers')));
            // Get or create provider
            let provider = this.providers.get(chainLower);
            if (!provider) {
                provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);
                this.providers.set(chainLower, provider);
            }
            // Fetch fee data (EIP-1559 compatible)
            const feeData = await provider.getFeeData();
            const gasPriceWei = feeData.gasPrice || BigInt(0);
            const maxFeePerGasWei = feeData.maxFeePerGas || undefined;
            const maxPriorityFeePerGasWei = feeData.maxPriorityFeePerGas || undefined;
            // Convert to gwei for display
            const gasPriceGwei = Number(gasPriceWei) / 1e9;
            this.gasPrices.set(chainLower, {
                gasPriceWei,
                gasPriceGwei,
                maxFeePerGasWei,
                maxPriorityFeePerGasWei,
                lastUpdated: Date.now(),
                isFallback: false
            });
            this.logger.debug(`Gas price updated for ${chain}`, { gasPriceGwei });
        }
        catch (error) {
            this.logger.warn(`Failed to fetch gas price for ${chain}`, { error });
            // Keep existing value if available, otherwise use fallback
            if (!this.gasPrices.has(chainLower)) {
                this.gasPrices.set(chainLower, this.createFallbackGasPrice(chainLower));
            }
            else {
                // Mark existing as potentially stale
                const existing = this.gasPrices.get(chainLower);
                existing.error = String(error);
            }
        }
    }
    /**
     * Update native token price manually.
     * In production, integrate with price oracle.
     */
    setNativeTokenPrice(chain, priceUsd) {
        this.nativePrices.set(chain.toLowerCase(), {
            priceUsd,
            lastUpdated: Date.now(),
            isFallback: false
        });
    }
    // ===========================================================================
    // Private Methods
    // ===========================================================================
    initializeFallbacks() {
        const chains = this.config.chains || Object.keys(config_1.CHAINS);
        for (const chain of chains) {
            const chainLower = chain.toLowerCase();
            // Initialize gas prices with fallbacks
            if (!this.gasPrices.has(chainLower)) {
                this.gasPrices.set(chainLower, this.createFallbackGasPrice(chainLower));
            }
            // Initialize native prices with fallbacks
            if (!this.nativePrices.has(chainLower)) {
                this.nativePrices.set(chainLower, {
                    priceUsd: FALLBACK_NATIVE_PRICES[chainLower] || 1000,
                    lastUpdated: Date.now(),
                    isFallback: true
                });
            }
        }
    }
    createFallbackGasPrice(chain) {
        const fallbackGwei = FALLBACK_GAS_PRICES[chain.toLowerCase()] || 50;
        const gasPriceWei = BigInt(Math.floor(fallbackGwei * 1e9));
        return {
            gasPriceWei,
            gasPriceGwei: fallbackGwei,
            lastUpdated: Date.now(),
            isFallback: true
        };
    }
    startRefreshTimer() {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
        }
        this.refreshTimer = setInterval(async () => {
            if (!this.isRunning) {
                if (this.refreshTimer) {
                    clearInterval(this.refreshTimer);
                    this.refreshTimer = null;
                }
                return;
            }
            try {
                await this.refreshAll();
            }
            catch (error) {
                this.logger.error('Error in gas price refresh timer', { error });
            }
        }, this.config.refreshIntervalMs);
    }
}
exports.GasPriceCache = GasPriceCache;
// =============================================================================
// Singleton Factory
// =============================================================================
let gasPriceCacheInstance = null;
/**
 * Get the singleton GasPriceCache instance.
 *
 * @param config - Optional configuration (only used on first initialization)
 * @returns The singleton GasPriceCache instance
 */
function getGasPriceCache(config) {
    if (!gasPriceCacheInstance) {
        gasPriceCacheInstance = new GasPriceCache(config);
    }
    return gasPriceCacheInstance;
}
/**
 * Reset the singleton instance.
 * Use for testing or when reconfiguration is needed.
 */
async function resetGasPriceCache() {
    if (gasPriceCacheInstance) {
        await gasPriceCacheInstance.stop();
    }
    gasPriceCacheInstance = null;
}
//# sourceMappingURL=gas-price-cache.js.map