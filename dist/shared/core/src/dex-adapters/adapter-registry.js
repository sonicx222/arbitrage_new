"use strict";
/**
 * Adapter Registry
 *
 * Central registry for managing vault-model and pool-model DEX adapters.
 * Provides adapter lookup by DEX name and chain, and integration with
 * the pair discovery system.
 *
 * Usage:
 * ```typescript
 * const registry = getAdapterRegistry();
 * registry.register(new BalancerV2Adapter(config));
 *
 * const adapter = registry.getAdapter('balancer_v2', 'arbitrum');
 * const pools = await adapter.discoverPools(tokenA, tokenB);
 * ```
 *
 * @see ADR-003: Partitioned Detector Strategy
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdapterRegistry = void 0;
exports.getAdapterRegistry = getAdapterRegistry;
exports.resetAdapterRegistry = resetAdapterRegistry;
const logger_1 = require("../logger");
// =============================================================================
// Implementation
// =============================================================================
class AdapterRegistry {
    constructor() {
        this.adapters = new Map();
        this.logger = (0, logger_1.createLogger)('adapter-registry');
    }
    /**
     * Generate a consistent key for adapter lookup
     */
    makeKey(dexName, chain) {
        return `${dexName.toLowerCase()}:${chain.toLowerCase()}`;
    }
    /**
     * Register an adapter
     */
    register(adapter) {
        const key = this.makeKey(adapter.name, adapter.chain);
        // Destroy existing adapter if present
        const existing = this.adapters.get(key);
        if (existing) {
            this.logger.info(`Replacing existing adapter: ${key}`);
            existing.destroy().catch((err) => {
                this.logger.warn('Error destroying replaced adapter', { key, error: err });
            });
        }
        this.adapters.set(key, adapter);
        this.logger.info(`Registered adapter: ${key}`, {
            type: adapter.type,
            address: adapter.primaryAddress,
        });
    }
    /**
     * Get an adapter by DEX name and chain
     */
    getAdapter(dexName, chain) {
        const key = this.makeKey(dexName, chain);
        return this.adapters.get(key) || null;
    }
    /**
     * Get an adapter for a Dex config object
     */
    getAdapterForDex(dex) {
        return this.getAdapter(dex.name, dex.chain);
    }
    /**
     * List all registered adapters
     */
    listAdapters() {
        return Array.from(this.adapters.values());
    }
    /**
     * List adapters for a specific chain
     */
    listAdaptersByChain(chain) {
        const chainLower = chain.toLowerCase();
        return Array.from(this.adapters.values()).filter((adapter) => adapter.chain.toLowerCase() === chainLower);
    }
    /**
     * Unregister an adapter
     */
    unregister(dexName, chain) {
        const key = this.makeKey(dexName, chain);
        const adapter = this.adapters.get(key);
        if (adapter) {
            adapter.destroy().catch((err) => {
                this.logger.warn('Error destroying unregistered adapter', { key, error: err });
            });
            this.adapters.delete(key);
            this.logger.info(`Unregistered adapter: ${key}`);
        }
    }
    /**
     * Destroy all adapters and clear registry
     */
    async destroyAll() {
        this.logger.info('Destroying all adapters');
        const destroyPromises = Array.from(this.adapters.values()).map((adapter) => adapter.destroy().catch((err) => {
            this.logger.warn('Error destroying adapter', {
                name: adapter.name,
                chain: adapter.chain,
                error: err,
            });
        }));
        await Promise.all(destroyPromises);
        this.adapters.clear();
        this.logger.info('All adapters destroyed');
    }
    /**
     * Discover pools for a token pair using the appropriate adapter
     *
     * Integration point for PairDiscoveryService to use vault-model adapters.
     */
    async discoverPair(chain, dex, token0, token1) {
        const adapter = this.getAdapterForDex(dex);
        if (!adapter) {
            this.logger.debug('No adapter for DEX', { dex: dex.name, chain });
            return [];
        }
        try {
            return await adapter.discoverPools(token0.address, token1.address);
        }
        catch (error) {
            this.logger.error('Adapter pool discovery failed', {
                dex: dex.name,
                chain,
                error,
            });
            return [];
        }
    }
    /**
     * Check health of all adapters
     */
    async checkHealth() {
        const results = new Map();
        for (const [key, adapter] of this.adapters) {
            try {
                const healthy = await adapter.isHealthy();
                results.set(key, healthy);
            }
            catch {
                results.set(key, false);
            }
        }
        return results;
    }
}
exports.AdapterRegistry = AdapterRegistry;
// =============================================================================
// Singleton
// =============================================================================
let registryInstance = null;
/**
 * Get the singleton adapter registry instance
 */
function getAdapterRegistry() {
    if (!registryInstance) {
        registryInstance = new AdapterRegistry();
    }
    return registryInstance;
}
/**
 * Reset the singleton (for testing)
 */
async function resetAdapterRegistry() {
    if (registryInstance) {
        await registryInstance.destroyAll();
        registryInstance = null;
    }
}
//# sourceMappingURL=adapter-registry.js.map