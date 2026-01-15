"use strict";
/**
 * Swap Event Test Factory
 *
 * Provides builder pattern and factory functions for creating
 * SwapEvent test data with sensible defaults.
 *
 * @see docs/TEST_ARCHITECTURE.md
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SwapEventBuilder = void 0;
exports.createSwapEvent = createSwapEvent;
exports.createSwapEvents = createSwapEvents;
exports.swapEvent = swapEvent;
exports.resetSwapEventFactory = resetSwapEventFactory;
exports.getSwapEventCounter = getSwapEventCounter;
exports.createEthereumSwap = createEthereumSwap;
exports.createBscSwap = createBscSwap;
exports.createWhaleSwap = createWhaleSwap;
exports.createDustSwap = createDustSwap;
exports.createZeroAmountSwap = createZeroAmountSwap;
exports.createSwapBatch = createSwapBatch;
// Counter for unique IDs
let eventCounter = 0;
/**
 * Generate a deterministic hex address
 */
function generateAddress(prefix, id) {
    return `0x${prefix}${id.toString(16).padStart(40 - prefix.length, '0')}`;
}
/**
 * Generate a deterministic transaction hash
 */
function generateTxHash(id) {
    return `0x${id.toString(16).padStart(64, '0')}`;
}
/**
 * Create a SwapEvent with default values and optional overrides
 */
function createSwapEvent(overrides = {}) {
    eventCounter++;
    const timestamp = overrides.timestamp ?? Date.now();
    const id = eventCounter;
    return {
        pairAddress: overrides.pairAddress ?? generateAddress('pair', id),
        sender: overrides.sender ?? generateAddress('sender', id),
        recipient: overrides.recipient ?? generateAddress('recipient', id),
        amount0In: overrides.amount0In ?? '1000000000000000000', // 1e18 (1 token)
        amount1In: overrides.amount1In ?? '0',
        amount0Out: overrides.amount0Out ?? '0',
        amount1Out: overrides.amount1Out ?? '2000000000', // 2000 USDC (6 decimals)
        to: overrides.to ?? generateAddress('to', id),
        blockNumber: overrides.blockNumber ?? 12345678 + id,
        transactionHash: overrides.transactionHash ?? generateTxHash(id),
        timestamp,
        dex: overrides.dex ?? 'uniswap_v3',
        chain: overrides.chain ?? 'ethereum',
        usdValue: overrides.usdValue ?? 2000
    };
}
/**
 * Create multiple SwapEvents
 */
function createSwapEvents(count, overrides = {}) {
    return Array.from({ length: count }, () => createSwapEvent(overrides));
}
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
class SwapEventBuilder {
    constructor() {
        this.overrides = {};
    }
    /** Set pair address */
    withPair(address) {
        this.overrides.pairAddress = address;
        return this;
    }
    /** Set sender address */
    withSender(address) {
        this.overrides.sender = address;
        return this;
    }
    /** Set recipient address */
    withRecipient(address) {
        this.overrides.recipient = address;
        return this;
    }
    /** Set transaction hash */
    withTxHash(hash) {
        this.overrides.transactionHash = hash;
        return this;
    }
    /** Set USD value */
    withUsdValue(value) {
        this.overrides.usdValue = value;
        return this;
    }
    /** Set chain */
    onChain(chain) {
        this.overrides.chain = chain;
        return this;
    }
    /** Set DEX */
    onDex(dex) {
        this.overrides.dex = dex;
        return this;
    }
    /** Set block number */
    atBlock(blockNumber) {
        this.overrides.blockNumber = blockNumber;
        return this;
    }
    /** Set timestamp */
    atTime(timestamp) {
        this.overrides.timestamp = timestamp;
        return this;
    }
    /** Set amount0In */
    withAmount0In(amount) {
        this.overrides.amount0In = amount;
        return this;
    }
    /** Set amount1In */
    withAmount1In(amount) {
        this.overrides.amount1In = amount;
        return this;
    }
    /** Set amount0Out */
    withAmount0Out(amount) {
        this.overrides.amount0Out = amount;
        return this;
    }
    /** Set amount1Out */
    withAmount1Out(amount) {
        this.overrides.amount1Out = amount;
        return this;
    }
    /**
     * Configure as a whale transaction (>$50K by default)
     */
    asWhale(value = 100000) {
        this.overrides.usdValue = value;
        return this;
    }
    /**
     * Configure as a dust transaction (<$10 by default)
     */
    asDust(value = 1) {
        this.overrides.usdValue = value;
        return this;
    }
    /**
     * Configure with zero amounts (will be filtered)
     */
    withZeroAmounts() {
        this.overrides.amount0In = '0';
        this.overrides.amount1In = '0';
        this.overrides.amount0Out = '0';
        this.overrides.amount1Out = '0';
        this.overrides.usdValue = 0;
        return this;
    }
    /**
     * Configure with invalid/negative USD value
     */
    withInvalidValue() {
        this.overrides.usdValue = -1000;
        return this;
    }
    /**
     * Configure for BSC/PancakeSwap
     */
    onBsc() {
        this.overrides.chain = 'bsc';
        this.overrides.dex = 'pancakeswap';
        return this;
    }
    /**
     * Configure for Polygon/QuickSwap
     */
    onPolygon() {
        this.overrides.chain = 'polygon';
        this.overrides.dex = 'quickswap';
        return this;
    }
    /**
     * Configure for Arbitrum/SushiSwap
     */
    onArbitrum() {
        this.overrides.chain = 'arbitrum';
        this.overrides.dex = 'sushiswap';
        return this;
    }
    /**
     * Configure for Optimism/Velodrome
     */
    onOptimism() {
        this.overrides.chain = 'optimism';
        this.overrides.dex = 'velodrome';
        return this;
    }
    /** Build a single SwapEvent */
    build() {
        return createSwapEvent(this.overrides);
    }
    /** Build multiple SwapEvents with same config but unique IDs */
    buildMany(count) {
        return Array.from({ length: count }, () => createSwapEvent({ ...this.overrides }));
    }
    /** Build with specific transaction hash (useful for duplicate testing) */
    buildWithHash(hash) {
        return createSwapEvent({ ...this.overrides, transactionHash: hash });
    }
}
exports.SwapEventBuilder = SwapEventBuilder;
/**
 * Factory function that returns a builder
 *
 * @example
 * const event = swapEvent().onBsc().asWhale().build();
 */
function swapEvent() {
    return new SwapEventBuilder();
}
/**
 * Reset the event counter (call in beforeEach for deterministic tests)
 */
function resetSwapEventFactory() {
    eventCounter = 0;
}
/**
 * Get current counter value (for debugging)
 */
function getSwapEventCounter() {
    return eventCounter;
}
// =========================================================================
// Pre-built Scenarios
// =========================================================================
/** Create a typical Ethereum/Uniswap swap */
function createEthereumSwap(overrides) {
    return swapEvent().onChain('ethereum').onDex('uniswap_v3').build();
}
/** Create a typical BSC/PancakeSwap swap */
function createBscSwap(overrides) {
    return swapEvent().onBsc().build();
}
/** Create a whale transaction */
function createWhaleSwap(value = 100000) {
    return swapEvent().asWhale(value).build();
}
/** Create a dust transaction */
function createDustSwap(value = 1) {
    return swapEvent().asDust(value).build();
}
/** Create a zero-amount swap (should be filtered) */
function createZeroAmountSwap() {
    return swapEvent().withZeroAmounts().build();
}
/** Create swaps for batch processing tests */
function createSwapBatch(options) {
    const { total, dustPercentage = 0.1, whalePercentage = 0.01 } = options;
    const events = [];
    const dustCount = Math.floor(total * dustPercentage);
    const whaleCount = Math.floor(total * whalePercentage);
    const normalCount = total - dustCount - whaleCount;
    // Add dust transactions
    for (let i = 0; i < dustCount; i++) {
        events.push(swapEvent().asDust(Math.random() * 9).build());
    }
    // Add normal transactions
    for (let i = 0; i < normalCount; i++) {
        events.push(swapEvent().withUsdValue(100 + Math.random() * 49900).build());
    }
    // Add whale transactions
    for (let i = 0; i < whaleCount; i++) {
        events.push(swapEvent().asWhale(50000 + Math.random() * 950000).build());
    }
    // Shuffle for realistic ordering
    return events.sort(() => Math.random() - 0.5);
}
//# sourceMappingURL=swap-event.factory.js.map