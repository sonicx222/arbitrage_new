/**
 * Price Update Test Factory
 *
 * Provides builder pattern and factory functions for creating
 * PriceUpdate test data with sensible defaults.
 *
 * Uses the canonical PriceUpdate type from @arbitrage/types.
 */

import type { PriceUpdate } from '@arbitrage/types';

export type { PriceUpdate };

export interface PriceUpdateOverrides extends Partial<PriceUpdate> {}

let priceCounter = 0;

function generateAddress(prefix: string, id: number): string {
  return `0x${prefix}${id.toString(16).padStart(40 - prefix.length, '0')}`;
}

/**
 * Create a PriceUpdate with defaults matching the canonical type.
 */
export function createPriceUpdate(overrides: PriceUpdateOverrides = {}): PriceUpdate {
  priceCounter++;
  const id = priceCounter;

  const price = overrides.price ?? 2000; // ETH price in USDC

  return {
    dex: overrides.dex ?? 'uniswap_v3',
    chain: overrides.chain ?? 'ethereum',
    pairKey: overrides.pairKey ?? 'WETH/USDC',
    pairAddress: overrides.pairAddress ?? generateAddress('price', id),
    token0: overrides.token0 ?? '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    token1: overrides.token1 ?? '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
    price: price,
    reserve0: overrides.reserve0 ?? '1000000000000000000000', // 1000 ETH
    reserve1: overrides.reserve1 ?? '2000000000000', // 2,000,000 USDC (6 decimals)
    timestamp: overrides.timestamp ?? Date.now(),
    blockNumber: overrides.blockNumber ?? 18500000 + id,
    latency: overrides.latency ?? 50,
    feeDecimal: overrides.feeDecimal,
    fee: overrides.fee,
  };
}

/**
 * Builder for PriceUpdate
 */
export class PriceUpdateBuilder {
  private overrides: PriceUpdateOverrides = {};

  onDex(dex: string): this {
    this.overrides.dex = dex;
    return this;
  }

  onChain(chain: string): this {
    this.overrides.chain = chain;
    return this;
  }

  forPair(pairKey: string): this {
    this.overrides.pairKey = pairKey;
    return this;
  }

  withPrice(price: number): this {
    this.overrides.price = price;
    return this;
  }

  atBlock(blockNumber: number): this {
    this.overrides.blockNumber = blockNumber;
    return this;
  }

  withReserves(reserve0: string, reserve1: string): this {
    this.overrides.reserve0 = reserve0;
    this.overrides.reserve1 = reserve1;
    return this;
  }

  withLatency(latency: number): this {
    this.overrides.latency = latency;
    return this;
  }

  withFeeDecimal(feeDecimal: number): this {
    this.overrides.feeDecimal = feeDecimal as PriceUpdate['feeDecimal'];
    return this;
  }

  build(): PriceUpdate {
    return createPriceUpdate(this.overrides);
  }

  buildMany(count: number): PriceUpdate[] {
    return Array.from({ length: count }, () => createPriceUpdate({ ...this.overrides }));
  }
}

export function priceUpdate(): PriceUpdateBuilder {
  return new PriceUpdateBuilder();
}

export function resetPriceUpdateFactory(): void {
  priceCounter = 0;
}

// Pre-built scenarios
export function createEthUsdcPrice(ethPrice = 2000): PriceUpdate {
  return priceUpdate()
    .forPair('WETH/USDC')
    .withPrice(ethPrice)
    .build();
}

export function createBnbBusdPrice(bnbPrice = 300): PriceUpdate {
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
export function createArbitragePricePair(options: {
  basePrice: number;
  priceDifferencePercent: number;
}): { source: PriceUpdate; target: PriceUpdate } {
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
