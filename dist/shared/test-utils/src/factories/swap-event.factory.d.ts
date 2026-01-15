/**
 * Swap Event Test Factory
 *
 * Provides builder pattern and factory functions for creating
 * SwapEvent test data with sensible defaults.
 *
 * @see docs/TEST_ARCHITECTURE.md
 */
export interface SwapEvent {
    pairAddress: string;
    sender: string;
    recipient: string;
    amount0In: string;
    amount1In: string;
    amount0Out: string;
    amount1Out: string;
    to: string;
    blockNumber: number;
    transactionHash: string;
    timestamp: number;
    dex: string;
    chain: string;
    usdValue?: number;
}
export interface SwapEventOverrides extends Partial<SwapEvent> {
}
/**
 * Create a SwapEvent with default values and optional overrides
 */
export declare function createSwapEvent(overrides?: SwapEventOverrides): SwapEvent;
/**
 * Create multiple SwapEvents
 */
export declare function createSwapEvents(count: number, overrides?: SwapEventOverrides): SwapEvent[];
/**
 * Builder class for creating SwapEvents with fluent API
 *
 * @example
 * const event = swapEvent()
 *   .onChain('bsc')
 *   .onDex('pancakeswap')
 *   .withUsdValue(50000)
 *   .asWhale()
 *   .build();
 */
export declare class SwapEventBuilder {
    private overrides;
    /** Set pair address */
    withPair(address: string): this;
    /** Set sender address */
    withSender(address: string): this;
    /** Set recipient address */
    withRecipient(address: string): this;
    /** Set transaction hash */
    withTxHash(hash: string): this;
    /** Set USD value */
    withUsdValue(value: number): this;
    /** Set chain */
    onChain(chain: string): this;
    /** Set DEX */
    onDex(dex: string): this;
    /** Set block number */
    atBlock(blockNumber: number): this;
    /** Set timestamp */
    atTime(timestamp: number): this;
    /** Set amount0In */
    withAmount0In(amount: string): this;
    /** Set amount1In */
    withAmount1In(amount: string): this;
    /** Set amount0Out */
    withAmount0Out(amount: string): this;
    /** Set amount1Out */
    withAmount1Out(amount: string): this;
    /**
     * Configure as a whale transaction (>$50K by default)
     */
    asWhale(value?: number): this;
    /**
     * Configure as a dust transaction (<$10 by default)
     */
    asDust(value?: number): this;
    /**
     * Configure with zero amounts (will be filtered)
     */
    withZeroAmounts(): this;
    /**
     * Configure with invalid/negative USD value
     */
    withInvalidValue(): this;
    /**
     * Configure for BSC/PancakeSwap
     */
    onBsc(): this;
    /**
     * Configure for Polygon/QuickSwap
     */
    onPolygon(): this;
    /**
     * Configure for Arbitrum/SushiSwap
     */
    onArbitrum(): this;
    /**
     * Configure for Optimism/Velodrome
     */
    onOptimism(): this;
    /** Build a single SwapEvent */
    build(): SwapEvent;
    /** Build multiple SwapEvents with same config but unique IDs */
    buildMany(count: number): SwapEvent[];
    /** Build with specific transaction hash (useful for duplicate testing) */
    buildWithHash(hash: string): SwapEvent;
}
/**
 * Factory function that returns a builder
 *
 * @example
 * const event = swapEvent().onBsc().asWhale().build();
 */
export declare function swapEvent(): SwapEventBuilder;
/**
 * Reset the event counter (call in beforeEach for deterministic tests)
 */
export declare function resetSwapEventFactory(): void;
/**
 * Get current counter value (for debugging)
 */
export declare function getSwapEventCounter(): number;
/** Create a typical Ethereum/Uniswap swap */
export declare function createEthereumSwap(overrides?: SwapEventOverrides): SwapEvent;
/** Create a typical BSC/PancakeSwap swap */
export declare function createBscSwap(overrides?: SwapEventOverrides): SwapEvent;
/** Create a whale transaction */
export declare function createWhaleSwap(value?: number): SwapEvent;
/** Create a dust transaction */
export declare function createDustSwap(value?: number): SwapEvent;
/** Create a zero-amount swap (should be filtered) */
export declare function createZeroAmountSwap(): SwapEvent;
/** Create swaps for batch processing tests */
export declare function createSwapBatch(options: {
    total: number;
    dustPercentage?: number;
    whalePercentage?: number;
}): SwapEvent[];
//# sourceMappingURL=swap-event.factory.d.ts.map