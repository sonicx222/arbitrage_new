/**
 * Test Data Builder for Pair (Pair Snapshot)
 *
 * Provides fluent API for creating test Pair objects with sensible defaults.
 *
 * @example
 * const pair = pairSnapshot()
 *   .withDex('uniswap-v2')
 *   .withPrice(1.05)
 *   .build();
 */

import type { Pair } from '@arbitrage/types';

export class PairSnapshotBuilder {
  private snapshot: Partial<Pair> = {
    address: '0x0000000000000000000000000000000000000000',
    dex: 'uniswap-v2',
    token0: '0x1111111111111111111111111111111111111111',
    token1: '0x2222222222222222222222222222222222222222',
    reserve0: '1000000000000000000', // 1 token
    reserve1: '2000000000000000000', // 2 tokens (price = 0.5)
    fee: 0.003, // 0.3%
    blockNumber: 1000000
  };

  /**
   * Set pair contract address
   */
  withAddress(address: string): this {
    this.snapshot.address = address;
    return this;
  }

  /**
   * Set DEX name
   */
  withDex(dex: string): this {
    this.snapshot.dex = dex;
    return this;
  }

  /**
   * Set token addresses
   */
  withTokens(token0: string, token1: string): this {
    this.snapshot.token0 = token0;
    this.snapshot.token1 = token1;
    return this;
  }

  /**
   * Set reserves explicitly
   */
  withReserves(reserve0: string, reserve1: string): this {
    this.snapshot.reserve0 = reserve0;
    this.snapshot.reserve1 = reserve1;
    return this;
  }

  /**
   * Set reserves based on desired price (reserve0 / reserve1)
   * Uses 1 ETH as base amount for reserve0
   */
  withPrice(price: number): this {
    const reserve0 = '1000000000000000000'; // 1 ETH
    const reserve1 = String(BigInt(reserve0) * BigInt(Math.floor(price * 1e18)) / BigInt(1e18));
    this.snapshot.reserve0 = reserve0;
    this.snapshot.reserve1 = reserve1;
    return this;
  }

  /**
   * Set fee (as decimal, e.g., 0.003 for 0.3%)
   */
  withFee(fee: number): this {
    this.snapshot.fee = fee;
    return this;
  }

  /**
   * Set block number
   */
  withBlockNumber(blockNumber: number): this {
    this.snapshot.blockNumber = blockNumber;
    return this;
  }

  /**
   * Build the Pair object
   * @throws Error if required fields missing
   */
  build(): Pair {
    if (!this.isValid()) {
      throw new Error(
        'Invalid Pair: missing required fields. ' +
          `Got: ${JSON.stringify(this.snapshot, null, 2)}`
      );
    }
    return this.snapshot as Pair;
  }

  /**
   * Build multiple pairs with sequential addresses
   * Useful for creating test datasets
   */
  buildMany(count: number): Pair[] {
    return Array.from({ length: count }, (_, i) => {
      const address = `0x${i.toString(16).padStart(40, '0')}`;
      return this.withAddress(address).build();
    });
  }

  /**
   * Reset builder to defaults (for reuse)
   */
  reset(): this {
    this.snapshot = {
      address: '0x0000000000000000000000000000000000000000',
      dex: 'uniswap-v2',
      token0: '0x1111111111111111111111111111111111111111',
      token1: '0x2222222222222222222222222222222222222222',
      reserve0: '1000000000000000000',
      reserve1: '2000000000000000000',
      fee: 0.003,
      blockNumber: 1000000
    };
    return this;
  }

  private isValid(): boolean {
    return !!(
      this.snapshot.address &&
      this.snapshot.dex &&
      this.snapshot.token0 &&
      this.snapshot.token1 &&
      this.snapshot.reserve0 &&
      this.snapshot.reserve1 &&
      typeof this.snapshot.fee === 'number' &&
      typeof this.snapshot.blockNumber === 'number'
    );
  }
}

// Convenience factory function
export function pairSnapshot(): PairSnapshotBuilder {
  return new PairSnapshotBuilder();
}
