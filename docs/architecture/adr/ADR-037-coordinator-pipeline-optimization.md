# ADR-037: Coordinator Pipeline Optimization

## Status
Accepted

## Date
2026-03-02

## Context

The pre-deploy validation report (session 20260302_133446) identified a **HIGH** severity coordinator throughput bottleneck:

- **28,448 pending messages** on `stream:opportunities` (consumer overwhelmed)
- **94.7% opportunity expiration rate** — only 5.3% of detected opportunities reached execution
- **1.75 opps/s forwarded** from 181 opps/s input during high-realism simulation

### Root Cause Analysis

The coordinator's theoretical throughput (~2,500 msg/s read rate) should easily handle 181 opps/s. The bottleneck is in **implementation, not architecture**:

1. **Sequential XACK (71% of cycle time):** After processing a batch of 200 messages, the `StreamConsumer` ACKs each message ID in a sequential `for...of await` loop — 200 individual Redis round-trips (~20-40ms) instead of 1 pipelined call (~0.5ms).

2. **Sequential forwarding (18% of cycle time):** Within `processOpportunityBatch()`, each qualifying opportunity is forwarded to `stream:execution-requests` via a sequential `for...of await` loop, serializing Redis XADD calls that could run concurrently.

3. **TCP socket contention:** 8 stream consumers share a single ioredis connection, serializing all XREADGROUP/XACK commands at the TCP level. The opportunities consumer (highest throughput) competes with 7 lower-priority consumers.

4. **Hot-path logging:** Two `logger.info()` calls per forwarded opportunity (~0.2-1ms each) in the forwarding path.

### Per-Batch Timing (Before)

| Step | Time | Round-trips |
|------|------|-------------|
| XREADGROUP (200 msgs) | ~0.5ms | 1 |
| Batch processing (parse, dedup, filter, sort) | ~5ms | 0 |
| Forward each (serialize + HMAC + XADD) | ~10ms | ~10 sequential |
| Sequential XACK (all processed IDs) | ~20-40ms | 200 |
| Inter-poll delay | 10ms | — |
| **Total** | **~45-55ms** | **~211** |

## Decision

Implement three complementary optimizations that reduce per-cycle round-trips from ~211 to ~3 without changing the coordinator's architectural role or safety guarantees:

### A. Redis Pipelined Batch XACK

Added `batchXack()` method to `RedisStreamsClient` that uses `ioredis.pipeline()` to batch N XACK commands into a single network round-trip.

Updated `StreamConsumer`'s batch handler path to use `batchXack()` instead of the sequential loop.

**Impact:** XACK time drops from ~20-40ms to ~0.5ms per batch.

### B. Parallel Opportunity Forwarding

Replaced the sequential `for...of await processOpportunity()` loop in `processOpportunityBatch()` with `Promise.all()` to forward qualifying opportunities concurrently.

Downgraded hot-path `logger.info()` calls (opportunity detected, forwarded) to `logger.debug()`.

**Safety:** Validation (dedup, profit, chain, expiry) is CPU-only with no shared mutable state between opportunities. The in-memory dedup Map is safe because Node.js is single-threaded — `Promise.all` interleaves at `await` boundaries, not within synchronous code. Each `xaddWithLimit` is an independent Redis write.

**Impact:** Forwarding time drops from ~10ms (sequential) to ~1.5ms (concurrent).

### C. Dedicated Redis Connection for Opportunities Consumer

Created `createRedisStreamsClient()` factory function that returns a non-singleton `RedisStreamsClient` instance. The coordinator uses this to give the opportunities `StreamConsumer` its own TCP socket.

Added cleanup in `CoordinatorService.stop()`.

**Impact:** Eliminates TCP-level serialization between the opportunities consumer and 7 other consumers.

### Per-Batch Timing (After)

| Step | Time | Round-trips |
|------|------|-------------|
| XREADGROUP (200 msgs) | ~0.5ms | 1 |
| Batch processing (parse, dedup, filter, sort) | ~5ms | 0 |
| Forward all (parallel XADD) | ~1.5ms | ~10 concurrent |
| Pipelined XACK (all processed IDs) | ~0.5ms | 1 |
| Inter-poll delay | 10ms | — |
| **Total** | **~17ms** | **~3** |

## Consequences

### Positive
- **3-4x throughput increase:** ~12,000-15,000 msg/s effective throughput vs ~3,600 msg/s before
- **66x headroom over production rate:** 12,000+ msg/s capacity vs 181 opps/s peak observed
- **No architectural change:** Coordinator pattern, leader election, and safety guarantees unchanged
- **Hot-path latency improvement:** Reduced per-batch cycle from ~55ms to ~17ms
- **Backward compatible:** `batchXack` and `createRedisStreamsClient` are additive; no API breakage

### Negative
- **+1 Redis connection:** The dedicated client adds one more TCP connection to Redis (negligible — Redis supports 10K+ connections)
- **Parallel forwarding changes error semantics:** If one `Promise.all` forward fails, all others still complete (this is intentional — each forward has independent retry logic with circuit breaker)

### Neutral
- `batchXack` falls back to variadic `xack` for batches ≤5 messages (avoids pipeline overhead for small batches)
- Hot-path log level changes require `LOG_LEVEL=debug` to see per-opportunity logging (operators should use metrics instead)

## Alternatives Considered

### Worker Thread for Forwarding
Offloading XADD/HMAC to a worker thread would free the main event loop entirely but adds serialization overhead (structured clone), startup latency (~50ms), and complexity. With A+B+C achieving 4x improvement, worker threads are unnecessary.

### Remove Coordinator from Forwarding Path
Having partitions publish directly to `stream:execution-requests` eliminates the bottleneck entirely but requires redesigning the dedup mechanism to be distributed (Redis-based instead of in-memory) and loses the centralized circuit breaker gate. HIGH risk for marginal benefit given A+B+C.

### Expand Fast-Lane Bypass
Lowering the fast-lane confidence threshold from 90% to 50% would route most opportunities directly to the execution engine. This is a valid complementary optimization but doesn't address the coordinator's throughput for non-fast-lane opportunities. Can be implemented independently.

## Related

- ADR-002: Redis Streams over Pub/Sub
- ADR-007: Failover Strategy (leader election)
- Pre-Deploy Validation Report: `monitor-session/REPORT_20260302_133446.md`
- Finding RT-001: 28,448 pending messages on stream:opportunities
- Finding RT-002: DLQ growing at 2.6/s
- Finding SM-005: +310 DLQ entries during 120s smoke test

## Files Changed

| File | Change |
|------|--------|
| `shared/core/src/redis/streams.ts` | Added `batchXack()` method, `createRedisStreamsClient()` factory |
| `shared/core/src/redis/stream-consumer.ts` | Replaced sequential XACK loop with `batchXack()` in batch handler path |
| `services/coordinator/src/opportunities/opportunity-router.ts` | Replaced sequential forwarding with `Promise.all`, downgraded hot-path logging |
| `services/coordinator/src/coordinator.ts` | Added dedicated `opportunityStreamsClient`, wired to opportunities consumer, cleanup in stop() |
