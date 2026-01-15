/**
 * Swap Event Test Factory
 *
 * Provides builder pattern and factory functions for creating
 * SwapEvent test data with sensible defaults.
 *
 * @see docs/TEST_ARCHITECTURE.md
 */

// Note: We define the interface here to avoid import cycles
// In production, use: import type { SwapEvent } from '@arbitrage/types';
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

export interface SwapEventOverrides extends Partial<SwapEvent> {}

// Counter for unique IDs
let eventCounter = 0;

/**
 * Generate a deterministic hex address
 */
function generateAddress(prefix: string, id: number): string {
  return `0x${prefix}${id.toString(16).padStart(40 - prefix.length, '0')}`;
}

/**
 * Generate a deterministic transaction hash
 */
function generateTxHash(id: number): string {
  return `0x${id.toString(16).padStart(64, '0')}`;
}

/**
 * Create a SwapEvent with default values and optional overrides
 */
export function createSwapEvent(overrides: SwapEventOverrides = {}): SwapEvent {
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
export function createSwapEvents(count: number, overrides: SwapEventOverrides = {}): SwapEvent[] {
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
export class SwapEventBuilder {
  private overrides: SwapEventOverrides = {};

  /** Set pair address */
  withPair(address: string): this {
    this.overrides.pairAddress = address;
    return this;
  }

  /** Set sender address */
  withSender(address: string): this {
    this.overrides.sender = address;
    return this;
  }

  /** Set recipient address */
  withRecipient(address: string): this {
    this.overrides.recipient = address;
    return this;
  }

  /** Set transaction hash */
  withTxHash(hash: string): this {
    this.overrides.transactionHash = hash;
    return this;
  }

  /** Set USD value */
  withUsdValue(value: number): this {
    this.overrides.usdValue = value;
    return this;
  }

  /** Set chain */
  onChain(chain: string): this {
    this.overrides.chain = chain;
    return this;
  }

  /** Set DEX */
  onDex(dex: string): this {
    this.overrides.dex = dex;
    return this;
  }

  /** Set block number */
  atBlock(blockNumber: number): this {
    this.overrides.blockNumber = blockNumber;
    return this;
  }

  /** Set timestamp */
  atTime(timestamp: number): this {
    this.overrides.timestamp = timestamp;
    return this;
  }

  /** Set amount0In */
  withAmount0In(amount: string): this {
    this.overrides.amount0In = amount;
    return this;
  }

  /** Set amount1In */
  withAmount1In(amount: string): this {
    this.overrides.amount1In = amount;
    return this;
  }

  /** Set amount0Out */
  withAmount0Out(amount: string): this {
    this.overrides.amount0Out = amount;
    return this;
  }

  /** Set amount1Out */
  withAmount1Out(amount: string): this {
    this.overrides.amount1Out = amount;
    return this;
  }

  /**
   * Configure as a whale transaction (>$50K by default)
   */
  asWhale(value = 100000): this {
    this.overrides.usdValue = value;
    return this;
  }

  /**
   * Configure as a dust transaction (<$10 by default)
   */
  asDust(value = 1): this {
    this.overrides.usdValue = value;
    return this;
  }

  /**
   * Configure with zero amounts (will be filtered)
   */
  withZeroAmounts(): this {
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
  withInvalidValue(): this {
    this.overrides.usdValue = -1000;
    return this;
  }

  /**
   * Configure for BSC/PancakeSwap
   */
  onBsc(): this {
    this.overrides.chain = 'bsc';
    this.overrides.dex = 'pancakeswap';
    return this;
  }

  /**
   * Configure for Polygon/QuickSwap
   */
  onPolygon(): this {
    this.overrides.chain = 'polygon';
    this.overrides.dex = 'quickswap';
    return this;
  }

  /**
   * Configure for Arbitrum/SushiSwap
   */
  onArbitrum(): this {
    this.overrides.chain = 'arbitrum';
    this.overrides.dex = 'sushiswap';
    return this;
  }

  /**
   * Configure for Optimism/Velodrome
   */
  onOptimism(): this {
    this.overrides.chain = 'optimism';
    this.overrides.dex = 'velodrome';
    return this;
  }

  /** Build a single SwapEvent */
  build(): SwapEvent {
    return createSwapEvent(this.overrides);
  }

  /** Build multiple SwapEvents with same config but unique IDs */
  buildMany(count: number): SwapEvent[] {
    return Array.from({ length: count }, () => createSwapEvent({ ...this.overrides }));
  }

  /** Build with specific transaction hash (useful for duplicate testing) */
  buildWithHash(hash: string): SwapEvent {
    return createSwapEvent({ ...this.overrides, transactionHash: hash });
  }
}

/**
 * Factory function that returns a builder
 *
 * @example
 * const event = swapEvent().onBsc().asWhale().build();
 */
export function swapEvent(): SwapEventBuilder {
  return new SwapEventBuilder();
}

/**
 * Reset the event counter (call in beforeEach for deterministic tests)
 */
export function resetSwapEventFactory(): void {
  eventCounter = 0;
}

/**
 * Get current counter value (for debugging)
 */
export function getSwapEventCounter(): number {
  return eventCounter;
}

// =========================================================================
// Pre-built Scenarios
// =========================================================================

/** Create a typical Ethereum/Uniswap swap */
export function createEthereumSwap(overrides?: SwapEventOverrides): SwapEvent {
  return swapEvent().onChain('ethereum').onDex('uniswap_v3').build();
}

/** Create a typical BSC/PancakeSwap swap */
export function createBscSwap(overrides?: SwapEventOverrides): SwapEvent {
  return swapEvent().onBsc().build();
}

/** Create a whale transaction */
export function createWhaleSwap(value = 100000): SwapEvent {
  return swapEvent().asWhale(value).build();
}

/** Create a dust transaction */
export function createDustSwap(value = 1): SwapEvent {
  return swapEvent().asDust(value).build();
}

/** Create a zero-amount swap (should be filtered) */
export function createZeroAmountSwap(): SwapEvent {
  return swapEvent().withZeroAmounts().build();
}

/** Create swaps for batch processing tests */
export function createSwapBatch(options: {
  total: number;
  dustPercentage?: number;
  whalePercentage?: number;
}): SwapEvent[] {
  const { total, dustPercentage = 0.1, whalePercentage = 0.01 } = options;
  const events: SwapEvent[] = [];

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
