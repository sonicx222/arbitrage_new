import {
  createEvent,
  isEventType,
  EventTypes,
  RedisStreams,
  type BaseEvent,
  type PriceUpdateEvent,
  type ArbitrageDetectedEvent,
} from '../../src/events';

describe('createEvent', () => {
  it('creates event with type, timestamp, and source', () => {
    const event = createEvent<BaseEvent>(
      EventTypes.PRICE_UPDATE,
      'detector-p1',
      {},
    );
    expect(event.type).toBe('price:update');
    expect(event.source).toBe('detector-p1');
    expect(event.timestamp).toBeGreaterThan(0);
    expect(event.correlationId).toBeUndefined();
  });

  it('includes correlationId when provided', () => {
    const event = createEvent<BaseEvent>(
      EventTypes.SERVICE_HEALTHY,
      'coordinator',
      {},
      'corr-123',
    );
    expect(event.correlationId).toBe('corr-123');
  });

  it('creates typed event with data payload', () => {
    const event = createEvent<PriceUpdateEvent>(
      EventTypes.PRICE_UPDATE,
      'detector',
      {
        data: {
          pairKey: 'WETH-USDC',
          chain: 'ethereum',
          dex: 'uniswap',
          price: 1800.5,
          reserve0: '1000000000000000000',
          reserve1: '1800000000',
          blockNumber: 12345678,
        },
      },
    );
    expect(event.type).toBe('price:update');
    expect(event.data.pairKey).toBe('WETH-USDC');
    expect(event.data.price).toBe(1800.5);
  });
});

describe('isEventType', () => {
  it('returns true for matching event type', () => {
    const event: BaseEvent = {
      type: EventTypes.PRICE_UPDATE,
      timestamp: Date.now(),
      source: 'test',
    };
    expect(isEventType<PriceUpdateEvent>(event, EventTypes.PRICE_UPDATE)).toBe(true);
  });

  it('returns false for non-matching event type', () => {
    const event: BaseEvent = {
      type: EventTypes.PRICE_UPDATE,
      timestamp: Date.now(),
      source: 'test',
    };
    expect(isEventType<ArbitrageDetectedEvent>(event, EventTypes.ARBITRAGE_DETECTED)).toBe(false);
  });
});

describe('RedisStreams constants', () => {
  it('has expected core stream names', () => {
    expect(RedisStreams.PRICE_UPDATES).toBe('stream:price-updates');
    expect(RedisStreams.SWAP_EVENTS).toBe('stream:swap-events');
    expect(RedisStreams.OPPORTUNITIES).toBe('stream:opportunities');
    expect(RedisStreams.WHALE_ALERTS).toBe('stream:whale-alerts');
    expect(RedisStreams.EXECUTION_REQUESTS).toBe('stream:execution-requests');
    expect(RedisStreams.EXECUTION_RESULTS).toBe('stream:execution-results');
    expect(RedisStreams.DEAD_LETTER_QUEUE).toBe('stream:dead-letter-queue');
    expect(RedisStreams.DLQ_ALERTS).toBe('stream:dlq-alerts');
  });

  it('has system coordination streams', () => {
    expect(RedisStreams.CIRCUIT_BREAKER).toBe('stream:circuit-breaker');
    expect(RedisStreams.SYSTEM_FAILOVER).toBe('stream:system-failover');
    expect(RedisStreams.SYSTEM_COMMANDS).toBe('stream:system-commands');
    expect(RedisStreams.HEALTH_ALERTS).toBe('stream:health-alerts');
    expect(RedisStreams.PENDING_OPPORTUNITIES).toBe('stream:pending-opportunities');
  });

  it('all values have stream: prefix', () => {
    for (const value of Object.values(RedisStreams)) {
      expect(value).toMatch(/^stream:/);
    }
  });
});

describe('EventTypes constants', () => {
  it('has all expected event categories', () => {
    // Price events
    expect(EventTypes.PRICE_UPDATE).toBe('price:update');
    expect(EventTypes.PRICE_STALE).toBe('price:stale');

    // Arbitrage events
    expect(EventTypes.ARBITRAGE_DETECTED).toBe('arbitrage:detected');
    expect(EventTypes.ARBITRAGE_EXECUTED).toBe('arbitrage:executed');
    expect(EventTypes.ARBITRAGE_FAILED).toBe('arbitrage:failed');

    // Circuit breaker
    expect(EventTypes.CIRCUIT_OPENED).toBe('circuit:opened');
    expect(EventTypes.CIRCUIT_CLOSED).toBe('circuit:closed');
    expect(EventTypes.CIRCUIT_HALF_OPEN).toBe('circuit:half-open');

    // Error events
    expect(EventTypes.ERROR_OCCURRED).toBe('error:occurred');
    expect(EventTypes.ERROR_FATAL).toBe('error:fatal');
  });
});
