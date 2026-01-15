/**
 * Price Update Test Factory
 *
 * Provides builder pattern and factory functions for creating
 * PriceUpdate test data with sensible defaults.
 */
export interface PriceUpdate {
    dex: string;
    chain: string;
    pair: string;
    pairAddress: string;
    token0: string;
    token1: string;
    price0: number;
    price1: number;
    timestamp: number;
    blockNumber: number;
    reserve0?: string;
    reserve1?: string;
}
export interface PriceUpdateOverrides extends Partial<PriceUpdate> {
}
/**
 * Create a PriceUpdate with defaults
 */
export declare function createPriceUpdate(overrides?: PriceUpdateOverrides): PriceUpdate;
/**
 * Builder for PriceUpdate
 */
export declare class PriceUpdateBuilder {
    private overrides;
    onDex(dex: string): this;
    onChain(chain: string): this;
    forPair(pair: string): this;
    withPrice(price0: number, price1?: number): this;
    atBlock(blockNumber: number): this;
    withReserves(reserve0: string, reserve1: string): this;
    build(): PriceUpdate;
    buildMany(count: number): PriceUpdate[];
}
export declare function priceUpdate(): PriceUpdateBuilder;
export declare function resetPriceUpdateFactory(): void;
export declare function createEthUsdcPrice(ethPrice?: number): PriceUpdate;
export declare function createBnbBusdPrice(bnbPrice?: number): PriceUpdate;
/**
 * Create a price difference for arbitrage testing
 */
export declare function createArbitragePricePair(options: {
    basePrice: number;
    priceDifferencePercent: number;
}): {
    source: PriceUpdate;
    target: PriceUpdate;
};
//# sourceMappingURL=price-update.factory.d.ts.map