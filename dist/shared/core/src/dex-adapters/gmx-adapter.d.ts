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
import { DexAdapter, AdapterConfig, AdapterType, DiscoveredPool, PoolReserves, SwapQuote } from './types';
export declare class GmxAdapter implements DexAdapter {
    readonly name: string;
    readonly chain: string;
    readonly type: AdapterType;
    readonly primaryAddress: string;
    private readonly provider;
    private readonly readerAddress;
    private readonly logger;
    private vaultContract;
    private readerContract;
    private whitelistedTokens;
    private initialized;
    private destroyed;
    constructor(config: AdapterConfig);
    initialize(): Promise<void>;
    private loadWhitelistedTokens;
    discoverPools(tokenA: string, tokenB: string): Promise<DiscoveredPool[]>;
    getPoolReserves(poolId: string): Promise<PoolReserves | null>;
    getSwapQuote(poolId: string, tokenIn: string, tokenOut: string, amountIn: bigint): Promise<SwapQuote | null>;
    private estimateSwapQuote;
    isHealthy(): Promise<boolean>;
    destroy(): Promise<void>;
}
//# sourceMappingURL=gmx-adapter.d.ts.map