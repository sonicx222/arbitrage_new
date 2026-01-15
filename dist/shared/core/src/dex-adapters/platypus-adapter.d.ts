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
import { DexAdapter, AdapterConfig, AdapterType, DiscoveredPool, PoolReserves, SwapQuote } from './types';
export declare class PlatypusAdapter implements DexAdapter {
    readonly name: string;
    readonly chain: string;
    readonly type: AdapterType;
    readonly primaryAddress: string;
    private readonly provider;
    private readonly routerAddress;
    private readonly logger;
    private poolContract;
    private supportedTokens;
    private initialized;
    private destroyed;
    constructor(config: AdapterConfig);
    initialize(): Promise<void>;
    private loadSupportedTokens;
    discoverPools(tokenA: string, tokenB: string): Promise<DiscoveredPool[]>;
    getPoolReserves(poolId: string): Promise<PoolReserves | null>;
    getSwapQuote(poolId: string, tokenIn: string, tokenOut: string, amountIn: bigint): Promise<SwapQuote | null>;
    isHealthy(): Promise<boolean>;
    destroy(): Promise<void>;
}
//# sourceMappingURL=platypus-adapter.d.ts.map