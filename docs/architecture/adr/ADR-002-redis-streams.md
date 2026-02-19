# ADR-002: Redis Streams over Pub/Sub for Event Backbone

## Status
**Implemented** | 2025-01-10 | Updated 2025-01-11 | Best Practices Updated 2026-01-14 | Blocking Reads 2026-01-15 | Volume Analytics 2026-01-16

## Implementation Status

### Phase 4 Complete: Pub/Sub Removal (2025-01-11)

| Component | Status | Notes |
|-----------|--------|-------|
| `shared/core/src/base-detector.ts` | DONE | Removed `useStreams` flag and Pub/Sub fallback |
| `shared/core/src/advanced-arbitrage-orchestrator.ts` | DEPRECATED | Uses Pub/Sub, deprecated per this ADR |
| `shared/core/src/index.ts` | DONE | Removed orchestrator exports |
| All detector publish methods | DONE | Now fail-fast if Streams unavailable |

### Key Changes

1. **Streams is REQUIRED** - No Pub/Sub fallback:
   ```typescript
   // Error thrown if Streams not initialized
   throw new Error('Price update batcher not initialized - Streams required per ADR-002');
   ```

2. **AdvancedArbitrageOrchestrator Deprecated**:
   ```typescript
   // @deprecated Use coordinator service pattern instead
   // See: services/coordinator/src/coordinator.ts
   ```

3. **StreamBatcher Pattern** - All publish methods use batching:
   - `publishPriceUpdate()` - Uses `priceUpdateBatcher`
   - `publishOpportunity()` - Uses `opportunityBatcher`
   - `publishAlert()` - Uses `alertBatcher`

### Migration Complete

- Phase 1: Add Streams Infrastructure - COMPLETE
- Phase 2: Migrate Critical Channels - COMPLETE
- Phase 3: Migrate Secondary Channels - COMPLETE
- Phase 4: Cleanup (Pub/Sub removal) - COMPLETE

### Phase 5: Blocking Reads Pattern (2026-01-15) [IMPLEMENTED]

**Objective**: Replace `setInterval` polling with blocking reads for improved latency and reduced Redis command usage.

| Component | Before | After | Improvement |
|-----------|--------|-------|-------------|
| Coordinator | 100ms setInterval polling | StreamConsumer with blockMs: 1000 | ~50ms → <1ms latency |
| ExecutionEngine | 50ms setInterval polling | StreamConsumer with blockMs: 1000 | ~25ms → <1ms latency |
| Redis commands (idle) | 10-20/sec | ~0.2/sec | 90% reduction |

**Key Changes**:

1. **StreamConsumer with Blocking Reads**:
   ```typescript
   const consumer = new StreamConsumer(streamsClient, {
     config: consumerGroupConfig,
     handler: async (msg) => handleMessage(msg),
     blockMs: 1000,  // Block up to 1s - immediate delivery when messages arrive
     autoAck: true   // Or false for deferred ACK pattern
   });
   consumer.start();
   ```

2. **Backpressure Coupling** (ExecutionEngine):
   ```typescript
   // Pause consumer when queue is full
   if (queueSize >= highWaterMark) {
     streamConsumer.pause();
   }
   // Resume when queue drains
   if (queueSize <= lowWaterMark) {
     streamConsumer.resume();
   }
   ```

3. **Files Modified**:
   - `shared/core/src/redis-streams.ts` - Added pause/resume to StreamConsumer
   - `services/coordinator/src/coordinator.ts` - Uses StreamConsumer instances
   - `services/execution-engine/src/engine.ts` - StreamConsumer with backpressure coupling

**Benefits**:
- Latency reduced from ~50ms to <1ms (meets <50ms architecture target)
- 90% reduction in Redis commands during idle periods (preserves Upstash free tier)
- Backpressure prevents message waste when queue is saturated

### Phase 6: Swap Events & Volume Aggregates Consumers (2026-01-16) [IMPLEMENTED]

**Objective**: Complete the data flow for swap events and volume aggregates streams by implementing consumers in the Coordinator.

| Stream | Producer | Consumer | Status |
|--------|----------|----------|--------|
| `stream:swap-events` | BaseDetector (SwapEventFilter) | Coordinator | ✅ Implemented |
| `stream:volume-aggregates` | BaseDetector (VolumeAggregate flush) | Coordinator | ✅ Implemented |

**Problem Statement**:
The S1.2 Smart Swap Event Filter was publishing filtered swap events and volume aggregates to Redis Streams, but no service was consuming them. This created a data flow gap where:
- Swap events accumulated in Redis until MAXLEN trimmed them
- Volume aggregates were lost without analytics processing
- No visibility into trading volume or active pairs

**Solution**:

1. **Added Consumer Groups** to Coordinator:
   ```typescript
   // coordinator.ts - Consumer groups now include:
   this.consumerGroups = [
     { streamName: STREAMS.HEALTH, ... },
     { streamName: STREAMS.OPPORTUNITIES, ... },
     { streamName: STREAMS.WHALE_ALERTS, ... },
     { streamName: STREAMS.SWAP_EVENTS, ... },      // NEW
     { streamName: STREAMS.VOLUME_AGGREGATES, ... } // NEW
   ];
   ```

2. **Implemented Stream Handlers**:
   - `handleSwapEventMessage()`: Tracks swap activity, updates volume metrics
   - `handleVolumeAggregateMessage()`: Processes 5-second aggregated volume data

3. **Added Analytics Metrics** to SystemMetrics:
   ```typescript
   interface SystemMetrics {
     // ... existing fields
     totalSwapEvents: number;        // Count of processed swap events
     totalVolumeUsd: number;         // Total USD volume observed
     volumeAggregatesProcessed: number;
     activePairsTracked: number;     // Rolling window of active pairs
   }
   ```

4. **Active Pairs Tracking**:
   - Maintains a Map of recently active trading pairs
   - 5-minute TTL for pair inactivity
   - Automatic cleanup via periodic interval

**Data Flow (Complete)**:
```
Chain Detectors → SwapEventFilter → stream:swap-events → Coordinator
                                 ↓
                     stream:volume-aggregates → Coordinator
                                 ↓
                     stream:whale-alerts → Coordinator (existing)
```

**Benefits**:
- Complete visibility into trading activity
- Volume analytics for market monitoring
- Active pairs tracking for dashboard
- No more orphaned stream data

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

## Redis Best Practices (2026-01-14 Update)

During implementation, additional Redis best practices were established:

### Key Enumeration
**Never use `KEYS` command in production** - it blocks Redis on large datasets.

```typescript
// ❌ Bad - blocks Redis
const keys = await redis.keys('health:*');

// ✅ Good - non-blocking SCAN iterator
let cursor = '0';
do {
  const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'health:*', 'COUNT', 100);
  cursor = nextCursor;
  // process keys...
} while (cursor !== '0');
```

### Error Handling
**Throw on Redis errors** to distinguish "key doesn't exist" from "Redis unavailable":

```typescript
// ❌ Bad - caller can't distinguish error from not-found
async exists(key: string): Promise<boolean> {
  try { return (await redis.exists(key)) === 1; }
  catch { return false; }
}

// ✅ Good - throws on error
async exists(key: string): Promise<boolean> {
  try { return (await redis.exists(key)) === 1; }
  catch (error) {
    throw new Error(`Redis exists failed: ${(error as Error).message}`);
  }
}
```

### Singleton Reset
**Await disconnect operations** in singleton reset functions:

```typescript
// ✅ Good - properly awaits disconnect
export async function resetRedisInstance(): Promise<void> {
  if (redisInstancePromise && !redisInstance) {
    try { await redisInstancePromise; } catch {}
  }
  if (redisInstance) {
    try { await redisInstance.disconnect(); } catch {}
  }
  redisInstance = null;
}
```

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
