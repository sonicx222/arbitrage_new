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
import { DexAdapter, AdapterConfig, AdapterType, DiscoveredPool, PoolReserves, SwapQuote } from './types';
export declare class BalancerV2Adapter implements DexAdapter {
    readonly name: string;
    readonly chain: string;
    readonly type: AdapterType;
    readonly primaryAddress: string;
    private readonly provider;
    private readonly subgraphUrl?;
    private readonly logger;
    private vaultContract;
    private poolCache;
    private initialized;
    private destroyed;
    constructor(config: AdapterConfig);
    initialize(): Promise<void>;
    discoverPools(tokenA: string, tokenB: string): Promise<DiscoveredPool[]>;
    private discoverPoolsViaSubgraph;
    private buildSubgraphQuery;
    private mapSubgraphPool;
    private mapPoolType;
    getPoolReserves(poolId: string): Promise<PoolReserves | null>;
    getSwapQuote(poolId: string, tokenIn: string, tokenOut: string, amountIn: bigint): Promise<SwapQuote | null>;
    isHealthy(): Promise<boolean>;
    destroy(): Promise<void>;
}
//# sourceMappingURL=balancer-v2-adapter.d.ts.map