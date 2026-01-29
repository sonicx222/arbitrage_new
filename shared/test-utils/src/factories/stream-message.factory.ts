/**
 * Stream Message Test Factory
 *
 * Provides factory functions for creating Redis Streams message test fixtures.
 * Reduces duplication in redis-streams, coordinator, and detector tests.
 *
 * @example
 * ```typescript
 * import { createStreamMessage, StreamMessageBuilder } from '@arbitrage/test-utils';
 *
 * // Simple creation with defaults
 * const msg = createStreamMessage();
 *
 * // With specific type and data
 * const priceMsg = createStreamMessage({
 *   type: 'price-update',
 *   data: { chain: 'bsc', price: 300 },
 * });
 *
 * // Using builder pattern
 * const builtMsg = new StreamMessageBuilder()
 *   .ofType('swap-event')
 *   .withData({ amount: '1000' })
 *   .fromSource('bsc-detector')
 *   .build();
 * ```
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Standard message event format for Redis Streams.
 */
export interface StreamMessage {
  /** Message type identifier */
  type: string;
  /** Message payload */
  data: Record<string, unknown>;
  /** Timestamp when message was created */
  timestamp: number;
  /** Source service identifier */
  source: string;
}

/**
 * Raw stream message format as returned by Redis XREAD.
 */
export interface RawStreamMessage {
  /** Stream message ID (e.g., '1234567890-0') */
  id: string;
  /** Field-value pairs */
  fields: Record<string, string>;
}

export interface StreamMessageOverrides extends Partial<StreamMessage> {}

// =============================================================================
// Factory State
// =============================================================================

let messageCounter = 0;
let idCounter = 0;

/**
 * Reset the factory counters (for test isolation).
 */
export function resetStreamMessageFactory(): void {
  messageCounter = 0;
  idCounter = 0;
}

/**
 * Get the current counter value (for debugging).
 */
export function getStreamMessageCounter(): number {
  return messageCounter;
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a stream message with sensible defaults.
 */
export function createStreamMessage(overrides: StreamMessageOverrides = {}): StreamMessage {
  messageCounter++;

  return {
    type: 'price-update',
    data: {
      chain: 'bsc',
      dex: 'pancakeswap',
      pair: 'WBNB/USDT',
      price: 300,
    },
    timestamp: Date.now(),
    source: 'bsc-detector',
    ...overrides,
  };
}

/**
 * Create multiple stream messages.
 */
export function createStreamMessages(
  count: number,
  overrides: StreamMessageOverrides = {}
): StreamMessage[] {
  return Array.from({ length: count }, (_, i) =>
    createStreamMessage({
      ...overrides,
      timestamp: Date.now() + i, // Ensure unique timestamps
    })
  );
}

/**
 * Create a raw stream message as returned by Redis XREAD.
 */
export function createRawStreamMessage(
  message?: Partial<StreamMessage>
): RawStreamMessage {
  idCounter++;
  const msg = createStreamMessage(message);

  return {
    id: `${Date.now()}-${idCounter}`,
    fields: {
      type: msg.type,
      data: JSON.stringify(msg.data),
      timestamp: String(msg.timestamp),
      source: msg.source,
    },
  };
}

/**
 * Create multiple raw stream messages.
 */
export function createRawStreamMessages(
  count: number,
  overrides: StreamMessageOverrides = {}
): RawStreamMessage[] {
  return Array.from({ length: count }, () => createRawStreamMessage(overrides));
}

// =============================================================================
// Builder Pattern
// =============================================================================

/**
 * Fluent builder for creating StreamMessage test fixtures.
 */
export class StreamMessageBuilder {
  private message: StreamMessage;

  constructor() {
    this.message = createStreamMessage();
  }

  ofType(type: string): this {
    this.message.type = type;
    return this;
  }

  withData(data: Record<string, unknown>): this {
    this.message.data = data;
    return this;
  }

  mergeData(data: Record<string, unknown>): this {
    this.message.data = { ...this.message.data, ...data };
    return this;
  }

  fromSource(source: string): this {
    this.message.source = source;
    return this;
  }

  atTime(timestamp: number): this {
    this.message.timestamp = timestamp;
    return this;
  }

  // Message type helpers
  asPriceUpdate(): this {
    return this.ofType('price-update');
  }

  asSwapEvent(): this {
    return this.ofType('swap-event');
  }

  asArbitrageOpportunity(): this {
    return this.ofType('arbitrage-opportunity');
  }

  asWhaleAlert(): this {
    return this.ofType('whale-alert');
  }

  asHealthUpdate(): this {
    return this.ofType('health-update');
  }

  asVolumeAggregate(): this {
    return this.ofType('volume-aggregate');
  }

  // Chain helpers
  forChain(chain: string): this {
    this.message.data.chain = chain;
    this.message.source = `${chain}-detector`;
    return this;
  }

  forBsc(): this {
    return this.forChain('bsc');
  }

  forEthereum(): this {
    return this.forChain('ethereum');
  }

  forArbitrum(): this {
    return this.forChain('arbitrum');
  }

  forPolygon(): this {
    return this.forChain('polygon');
  }

  build(): StreamMessage {
    return { ...this.message };
  }

  buildRaw(): RawStreamMessage {
    return createRawStreamMessage(this.message);
  }
}

// =============================================================================
// Convenience Factory Instance
// =============================================================================

/**
 * Convenience factory instance for quick message creation.
 */
export const streamMessage = {
  create: createStreamMessage,
  createMany: createStreamMessages,
  createRaw: createRawStreamMessage,
  createManyRaw: createRawStreamMessages,
  builder: () => new StreamMessageBuilder(),
  reset: resetStreamMessageFactory,
};

// =============================================================================
// Common Message Scenarios
// =============================================================================

/**
 * Create a price update message.
 */
export function createPriceUpdateMessage(
  chain = 'bsc',
  dex = 'pancakeswap',
  pair = 'WBNB/USDT',
  price = 300
): StreamMessage {
  return new StreamMessageBuilder()
    .asPriceUpdate()
    .forChain(chain)
    .withData({
      chain,
      dex,
      pair,
      pairAddress: `0x${chain}${dex}${pair}`.toLowerCase().slice(0, 42),
      price,
      reserve0: '1000000000000000000000',
      reserve1: '300000000000000000000000',
      blockNumber: 12345678,
    })
    .build();
}

/**
 * Create a swap event message.
 */
export function createSwapEventMessage(
  chain = 'bsc',
  dex = 'pancakeswap',
  pair = 'WBNB/USDT'
): StreamMessage {
  return new StreamMessageBuilder()
    .asSwapEvent()
    .forChain(chain)
    .withData({
      chain,
      dex,
      pair,
      pairAddress: `0x${chain}${dex}${pair}`.toLowerCase().slice(0, 42),
      transactionHash: `0x${'a'.repeat(64)}`,
      sender: `0x${'b'.repeat(40)}`,
      amount0In: '1000000000000000000',
      amount1In: '0',
      amount0Out: '0',
      amount1Out: '300000000000000000000',
      blockNumber: 12345678,
    })
    .build();
}

/**
 * Create an arbitrage opportunity message.
 */
export function createArbitrageOpportunityMessage(
  profit = '100000000000000000'
): StreamMessage {
  return new StreamMessageBuilder()
    .asArbitrageOpportunity()
    .withData({
      id: `arb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sourceChain: 'bsc',
      targetChain: 'bsc',
      sourceDex: 'pancakeswap',
      targetDex: 'biswap',
      tokenAddress: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
      profit,
      profitPercent: 0.5,
      confidence: 0.85,
      expiresAt: Date.now() + 30000,
    })
    .fromSource('bsc-detector')
    .build();
}

/**
 * Create a whale alert message.
 */
export function createWhaleAlertMessage(
  usdValue = 100000,
  direction: 'buy' | 'sell' = 'buy'
): StreamMessage {
  return new StreamMessageBuilder()
    .asWhaleAlert()
    .forBsc()
    .withData({
      chain: 'bsc',
      pair: 'WBNB/USDT',
      pairAddress: '0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE',
      usdValue,
      direction,
      transactionHash: `0x${'c'.repeat(64)}`,
      timestamp: Date.now(),
    })
    .build();
}

/**
 * Create a health update message.
 */
export function createHealthUpdateMessage(
  service = 'bsc-detector',
  status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy'
): StreamMessage {
  return new StreamMessageBuilder()
    .asHealthUpdate()
    .fromSource(service)
    .withData({
      name: service,
      status,
      uptime: 3600,
      memoryUsage: 150 * 1024 * 1024,
      eventsProcessed: 10000,
      lastHeartbeat: Date.now(),
    })
    .build();
}

/**
 * Create a batch of messages simulating a busy stream.
 */
export function createMessageBatch(
  count: number,
  type = 'price-update'
): StreamMessage[] {
  return Array.from({ length: count }, (_, i) =>
    createStreamMessage({
      type,
      timestamp: Date.now() + i,
      data: {
        chain: ['bsc', 'ethereum', 'arbitrum', 'polygon'][i % 4],
        index: i,
      },
    })
  );
}
