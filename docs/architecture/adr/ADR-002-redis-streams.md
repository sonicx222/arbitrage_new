# ADR-002: Redis Streams over Pub/Sub for Event Backbone

## Status
**Accepted** | 2025-01-10

## Context

The system currently uses Redis Pub/Sub for inter-service communication:

```typescript
// Current implementation (shared/core/src/redis.ts)
await this.pubClient.publish(channel, serializedMessage);
await this.subClient.subscribe(channel, callback);
```

This approach has limitations that become critical at scale:
1. Messages are fire-and-forget (no persistence)
2. If a subscriber is offline, messages are lost
3. No backpressure mechanism
4. No consumer groups for load balancing
5. Cannot replay historical events

## Decision

Migrate from **Redis Pub/Sub** to **Redis Streams** for all critical event channels.

### Implementation Change

```typescript
// New implementation using Streams
// Publishing
await redis.xadd('stream:price-updates', '*', {
  chain: update.chain,
  dex: update.dex,
  pair: update.pairKey,
  price: update.price.toString(),
  timestamp: Date.now().toString()
});

// Consuming with consumer groups
await redis.xreadgroup(
  'GROUP', 'cross-chain-detector',
  'consumer-1',
  'STREAMS', 'stream:price-updates', '>'
);

// Acknowledging processed messages
await redis.xack('stream:price-updates', 'cross-chain-detector', messageId);
```

## Rationale

### Pub/Sub vs Streams Comparison

| Feature | Pub/Sub | Streams | Impact |
|---------|---------|---------|--------|
| **Persistence** | None | Configurable | Can recover from crashes |
| **Delivery guarantee** | At-most-once | At-least-once | No lost opportunities |
| **Consumer groups** | No | Yes | Load balancing |
| **Backpressure** | No | Via blocking reads | Prevents overload |
| **Replay** | No | Yes | Debugging, recovery |
| **Message ordering** | Per-channel | Per-stream | Guaranteed order |
| **Upstash support** | Yes | Yes | Compatible |

### Critical Benefits for Arbitrage

1. **No Lost Opportunities**
   - Pub/Sub: If cross-chain detector restarts, all in-flight price updates are lost
   - Streams: Pending messages survive restart, processed on recovery

2. **Backpressure Handling**
   - Pub/Sub: Fast producer can overwhelm slow consumer
   - Streams: Consumer controls read rate, producer never blocked

3. **Horizontal Scaling**
   - Pub/Sub: Adding consumers duplicates messages
   - Streams: Consumer groups distribute messages automatically

4. **Debugging & Recovery**
   - Pub/Sub: Cannot see historical messages
   - Streams: Can replay last N messages for debugging

### Upstash Compatibility

Upstash Redis supports Streams with the same rate limits:
- XADD counts as 1 command
- XREADGROUP counts as 1 command
- No additional cost vs Pub/Sub

### Rate Limit Impact

| Operation | Pub/Sub Commands | Streams Commands | Savings |
|-----------|------------------|------------------|---------|
| 100 price updates | 100 PUBLISH | 2 XADD (batched) | 98% |
| 100 reads | 100 callbacks | 2 XREADGROUP | 98% |

Streams enable **batching** that Pub/Sub cannot support.

## Consequences

### Positive
- Message persistence (survives restarts)
- At-least-once delivery guarantee
- Consumer groups for scaling
- Better rate limit efficiency through batching
- Replay capability for debugging

### Negative
- Slightly higher latency (~1-2ms) vs Pub/Sub
- Need to manage consumer groups
- Need to acknowledge messages explicitly
- Stream trimming required to prevent unbounded growth

### Mitigations

1. **Latency**: 1-2ms is acceptable given overall 50ms budget
2. **Consumer group management**: Automated in service startup
3. **Acknowledgment**: Wrapped in helper functions
4. **Trimming**: Automatic MAXLEN on XADD

```typescript
// Auto-trim to last 10,000 messages
await redis.xadd('stream:price-updates', 'MAXLEN', '~', 10000, '*', data);
```

## Migration Path

### Phase 1: Add Streams Infrastructure (Week 1)
- Add stream helper functions to RedisClient
- Create consumer group management utilities
- Keep Pub/Sub as fallback

### Phase 2: Migrate Critical Channels (Week 2)
- `price-updates` → `stream:price-updates`
- `arbitrage-opportunities` → `stream:opportunities`
- Update all producers and consumers

### Phase 3: Migrate Secondary Channels (Week 3)
- `whale-transactions` → `stream:whale-alerts`
- `service-health-updates` → `stream:health`
- Remove Pub/Sub code

### Phase 4: Cleanup (Week 4)
- Remove Pub/Sub methods from RedisClient
- Update documentation
- Performance validation

## Alternatives Considered

### Alternative 1: Kafka (via Upstash Kafka)
- **Rejected because**: Separate service, additional rate limits
- **Would reconsider if**: Event volume exceeds Redis capacity

### Alternative 2: Keep Pub/Sub with Application-Level Persistence
- **Rejected because**: Complex, error-prone, reinventing streams
- **Would reconsider if**: Streams had compatibility issues

### Alternative 3: PostgreSQL NOTIFY/LISTEN
- **Rejected because**: Would need PostgreSQL hosting, different programming model
- **Would reconsider if**: Already using PostgreSQL for other data

## References

- [Redis Streams Documentation](https://redis.io/docs/data-types/streams/)
- [Upstash Redis Streams](https://docs.upstash.com/redis/features/streams)
- [Current Redis implementation](../../../shared/core/src/redis.ts)

## Confidence Level

**88%** - High confidence based on:
- Redis Streams is battle-tested technology
- Upstash fully supports Streams
- Clear benefits for reliability and scalability
- Migration path is incremental and reversible
