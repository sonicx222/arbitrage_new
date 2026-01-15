"use strict";
/**
 * Price Update Test Factory
 *
 * Provides builder pattern and factory functions for creating
 * PriceUpdate test data with sensible defaults.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PriceUpdateBuilder = void 0;
exports.createPriceUpdate = createPriceUpdate;
exports.priceUpdate = priceUpdate;
exports.resetPriceUpdateFactory = resetPriceUpdateFactory;
exports.createEthUsdcPrice = createEthUsdcPrice;
exports.createBnbBusdPrice = createBnbBusdPrice;
exports.createArbitragePricePair = createArbitragePricePair;
let priceCounter = 0;
function generateAddress(prefix, id) {
    return `0x${prefix}${id.toString(16).padStart(40 - prefix.length, '0')}`;
}
/**
 * Create a PriceUpdate with defaults
 */
function createPriceUpdate(overrides = {}) {
    priceCounter++;
    const id = priceCounter;
    return {
        dex: overrides.dex ?? 'uniswap_v3',
        chain: overrides.chain ?? 'ethereum',
        pair: overrides.pair ?? 'WETH/USDC',
        pairAddress: overrides.pairAddress ?? generateAddress('price', id),
        token0: overrides.token0 ?? '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
        token1: overrides.token1 ?? '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
        price0: overrides.price0 ?? 2000, // ETH price in USDC
        price1: overrides.price1 ?? 0.0005, // USDC price in ETH
        timestamp: overrides.timestamp ?? Date.now(),
        blockNumber: overrides.blockNumber ?? 18500000 + id,
        reserve0: overrides.reserve0,
        reserve1: overrides.reserve1
    };
}
/**
 * Builder for PriceUpdate
 */
class PriceUpdateBuilder {
    constructor() {
        this.overrides = {};
    }
    onDex(dex) {
        this.overrides.dex = dex;
        return this;
    }
    onChain(chain) {
        this.overrides.chain = chain;
        return this;
    }
    forPair(pair) {
        this.overrides.pair = pair;
        return this;
    }
    withPrice(price0, price1) {
        this.overrides.price0 = price0;
        this.overrides.price1 = price1 ?? 1 / price0;
        return this;
    }
    atBlock(blockNumber) {
        this.overrides.blockNumber = blockNumber;
        return this;
    }
    withReserves(reserve0, reserve1) {
        this.overrides.reserve0 = reserve0;
        this.overrides.reserve1 = reserve1;
        return this;
    }
    build() {
        return createPriceUpdate(this.overrides);
    }
    buildMany(count) {
        return Array.from({ length: count }, () => createPriceUpdate({ ...this.overrides }));
    }
}
exports.PriceUpdateBuilder = PriceUpdateBuilder;
function priceUpdate() {
    return new PriceUpdateBuilder();
}
function resetPriceUpdateFactory() {
    priceCounter = 0;
}
// Pre-built scenarios
function createEthUsdcPrice(ethPrice = 2000) {
    return priceUpdate()
        .forPair('WETH/USDC')
        .withPrice(ethPrice)
        .build();
}
function createBnbBusdPrice(bnbPrice = 300) {
    return priceUpdate()
        .onChain('bsc')
        .onDex('pancakeswap')
        .forPair('WBNB/BUSD')
        .withPrice(bnbPrice)
        .build();
}
/**
 * Create a price difference for arbitrage testing
 */
function createArbitragePricePair(options) {
    const { basePrice, priceDifferencePercent } = options;
    const priceDiff = basePrice * (priceDifferencePercent / 100);
    return {
        source: priceUpdate()
            .onDex('uniswap_v3')
            .withPrice(basePrice)
            .build(),
        target: priceUpdate()
            .onDex('sushiswap')
            .withPrice(basePrice + priceDiff)
            .build()
    };
}
//# sourceMappingURL=price-update.factory.js.map