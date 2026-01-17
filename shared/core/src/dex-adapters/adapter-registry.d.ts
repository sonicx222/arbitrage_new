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
import { DexAdapter, AdapterKey, DiscoveredPool } from './types';
interface Dex {
    name: string;
    chain: string;
    factoryAddress: string;
    routerAddress: string;
    fee: number;
    enabled?: boolean;
}
interface Token {
    address: string;
    symbol: string;
    decimals: number;
    chainId: number;
}
export declare class AdapterRegistry {
    private adapters;
    private readonly logger;
    constructor();
    /**
     * Generate a consistent key for adapter lookup
     */
    private makeKey;
    /**
     * Register an adapter
     */
    register(adapter: DexAdapter): void;
    /**
     * Get an adapter by DEX name and chain
     */
    getAdapter(dexName: string, chain: string): DexAdapter | null;
    /**
     * Get an adapter for a Dex config object
     */
    getAdapterForDex(dex: Dex): DexAdapter | null;
    /**
     * List all registered adapters
     */
    listAdapters(): DexAdapter[];
    /**
     * List adapters for a specific chain
     */
    listAdaptersByChain(chain: string): DexAdapter[];
    /**
     * Unregister an adapter
     */
    unregister(dexName: string, chain: string): void;
    /**
     * Destroy all adapters and clear registry
     */
    destroyAll(): Promise<void>;
    /**
     * Discover pools for a token pair using the appropriate adapter
     *
     * Integration point for PairDiscoveryService to use vault-model adapters.
     */
    discoverPair(chain: string, dex: Dex, token0: Token, token1: Token): Promise<DiscoveredPool[]>;
    /**
     * Check health of all adapters
     */
    checkHealth(): Promise<Map<AdapterKey, boolean>>;
}
/**
 * Get the singleton adapter registry instance
 */
export declare function getAdapterRegistry(): AdapterRegistry;
/**
 * Reset the singleton (for testing)
 */
export declare function resetAdapterRegistry(): Promise<void>;
export {};
//# sourceMappingURL=adapter-registry.d.ts.map