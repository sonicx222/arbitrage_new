# Redis Key Registry

**SA-016 FIX**: Formal registry of all Redis key patterns used in the arbitrage system.
Provides a single reference to prevent namespace collisions, document TTLs, and guide
operational tooling (SCAN patterns, monitoring, cleanup scripts).

---

## How to Use This Document

- **Adding a new key**: Pick a prefix from an existing namespace or create a new one.
  Verify no collisions with the patterns below. Document it here before merging.
- **SCAN safety**: Use `SCAN … MATCH <prefix>*` — never `KEYS`. Every subsystem that
  scans Redis lists its SCAN pattern in the "Access" column.
- **Collision risk**: Prefixes are designed to be hierarchical (`:` delimiter). A SCAN
  for `bridge:recovery:*` will also match `bridge:recovery:corrupt:*` — filter in code
  (see SA-107 FIX in `bridge-recovery-manager.ts`).

---

## 1. Redis Streams (`stream:*`)

Defined in `shared/types/src/events.ts` as `RedisStreams`. MAXLEN limits in
`shared/core/src/redis/streams.ts` `STREAM_MAX_LENGTHS`.

| Stream Key | Status | MAXLEN | Producers | Consumers |
|---|---|---|---|---|
| `stream:price-updates` | ACTIVE | 100,000 | Partition services (P1–P4) | Coordinator, unified-detector |
| `stream:opportunities` | ACTIVE | 500,000 | Partition detectors | Coordinator, execution-engine |
| `stream:fast-lane` | ACTIVE | — | Partition detectors (high-confidence) | Execution-engine (fast lane consumer) |
| `stream:execution-requests` | ACTIVE | 5,000 | Coordinator | Execution-engine |
| `stream:execution-results` | ACTIVE | 5,000 | Execution-engine | Coordinator |
| `stream:health` | ACTIVE | 1,000 | All services (heartbeat) | Enhanced health monitor |
| `stream:health-alerts` | ON-DEMAND | 5,000 | Enhanced health monitor | Alert subscribers |
| `stream:system-commands` | ON-DEMAND | 1,000 | Enhanced health monitor | All services |
| `stream:system-failover` | ON-DEMAND | 1,000 | Cross-region health | Failover consumers |
| `stream:system-failures` | ON-DEMAND | — | Expert self-healing manager | Recovery handlers |
| `stream:system-control` | ON-DEMAND | — | Expert self-healing manager | Service controllers |
| `stream:system-scaling` | ON-DEMAND | — | Expert self-healing manager | Scaling handlers |
| `stream:service-health` | IDLE | 1,000 | Reserved | — |
| `stream:service-events` | IDLE | 5,000 | Reserved | — |
| `stream:coordinator-events` | IDLE | 5,000 | Reserved | — |
| `stream:service-degradation` | ON-DEMAND | — | Graceful-degradation, self-healing-manager | Degradation consumers |
| `stream:dead-letter-queue` | ACTIVE | 10,000 | Stream-consumer (failed messages) | DLQ recovery processor |
| `stream:dlq-alerts` | ON-DEMAND | — | DLQ manager | Alert subscribers |
| `stream:forwarding-dlq` | ON-DEMAND | — | DLQ forwarding failures | Manual recovery |
| `stream:swap-events` | IDLE | 50,000 | Reserved (future DEX ingestion) | — |
| `stream:whale-alerts` | IDLE | 5,000 | Reserved | — |
| `stream:pending-opportunities` | IDLE | 10,000 | Reserved (future mempool-detector) | Orderflow pipeline consumer |
| `stream:volume-aggregates` | IDLE | 10,000 | Reserved | — |
| `stream:circuit-breaker` | IDLE | 5,000 | Reserved | — |

**Note**: ON-DEMAND streams are created on first write, not pre-created at startup.
IDLE streams have consumer groups registered but no active producer in dev mode.

---

## 2. Leader Election

| Key Pattern | Type | TTL | Owner | Notes |
|---|---|---|---|---|
| `coordinator:leader:lock` | String | 60 s (refreshed) | `services/coordinator/src/index.ts` | Configurable via `LEADER_LOCK_KEY` env var. Distributed lock via DistributedLock. |

---

## 3. Health & Service State

| Key Pattern | Type | TTL | Owner | Notes |
|---|---|---|---|---|
| `health:{serviceName}` | JSON | 300 s | `shared/core/src/redis/client.ts`, `shared/core/src/resilience/self-healing-manager.ts` | Per-service health snapshot. |
| `region:health:{regionId}` | JSON | configurable | `shared/core/src/monitoring/cross-region-health.ts` | Cross-region health state. SCAN: `region:health:*` |
| `routing:failed:{regionId}` | JSON | configurable | `shared/core/src/monitoring/cross-region-health.ts` | Failed routing record per region. |

---

## 4. Metrics

| Key Pattern | Type | TTL | Owner | Notes |
|---|---|---|---|---|
| `metrics:{serviceName}:{timeBucket}` | Hash | auto-expire | `shared/core/src/redis/client.ts` | Time-bucketed metrics per service. |
| `metrics:{serviceName}:recent` | JSON | auto-expire | `shared/core/src/redis/client.ts` | Rolling recent metrics for the service. |

---

## 5. Caching

| Key Pattern | Type | TTL | Owner | Notes |
|---|---|---|---|---|
| `pair:{normalizedPairId}` | JSON | configurable | `shared/core/src/caching/hierarchical-cache.ts` | L2 Redis cache for token pair data. SCAN: `pair:*` |
| `opp:dedup:{opportunityId}` | String | short (dedup window) | `shared/core/src/publishing/publishing-service.ts` | Deduplication key for published opportunities. |

---

## 6. Bridge Recovery

| Key Pattern | Type | TTL | Owner | Notes |
|---|---|---|---|---|
| `bridge:recovery:{bridgeId}` | JSON (HMAC-signed) | configurable | `services/execution-engine/src/services/bridge-recovery-manager.ts`, `services/execution-engine/src/strategies/cross-chain.strategy.ts` | Cross-chain bridge recovery state. SCAN: `bridge:recovery:*` |
| `bridge:recovery:corrupt:{originalKey}` | JSON | configurable | `services/execution-engine/src/services/bridge-recovery-manager.ts` | Dead-letter for unparse-able bridge recovery keys (SA-107 FIX). SCAN: **exclude from main scan** — filter in code with `!key.includes(':corrupt:')` |

**SA-016 Collision Risk**: `bridge:recovery:*` matches both normal and corrupt keys.
The recovery manager explicitly filters out `:corrupt:` suffixes (line 431 of bridge-recovery-manager.ts).
Do not add new key patterns inside the `bridge:recovery:` namespace without updating that filter.

---

## 7. Commit-Reveal (MEV Protection)

| Key Pattern | Type | TTL | Owner | Notes |
|---|---|---|---|---|
| `commit-reveal:{chain}:{commitmentHash}` | JSON | ~300 s (reveal window) | `services/execution-engine/src/services/commit-reveal.service.ts` | Stores in-flight commit state for MEV-protected trades. Only written when `FEATURE_COMMIT_REVEAL_REDIS=true`. |

---

## 8. Dead Letter Queue (Key-Based, not Stream-Based)

The key-based DLQ (`shared/core/src/resilience/dead-letter-queue.ts`) is **separate**
from `stream:dead-letter-queue`. It uses configurable `keyPrefix` (default: `dlq`).

| Key Pattern | Type | TTL | Notes |
|---|---|---|---|
| `{prefix}:{operationId}` | JSON | `retentionPeriod` (config) | Individual failed operation. |
| `{prefix}:priority:{priority}` | Sorted Set | — | Index by priority (critical/high/medium/low). |
| `{prefix}:service:{serviceName}` | Sorted Set | — | Index by originating service. |
| `{prefix}:tag:{tag}` | Sorted Set | — | Index by tag. |

Default prefix: `dlq`. SCAN: `dlq:*`. Override with `config.keyPrefix` in constructor.

---

## 9. Rate Limiting

| Key Pattern | Type | TTL | Owner | Notes |
|---|---|---|---|---|
| `ratelimit:{identifier}` | Sorted Set (timestamps) | `windowMs + 60 s` | `shared/security/src/rate-limiter.ts` | Sliding-window rate limit. Identifier is IP, user ID, or `api_key:{sha256hash}`. Default prefix `ratelimit`; configurable via `keyPrefix` in constructor. |

**Security**: API key values are never stored raw in Redis. The identifier uses
`sha256(apiKey)` as suffix (see `rate-limiter.ts:270`).

---

## 10. Authentication

| Key Pattern | Type | TTL | Owner | Notes |
|---|---|---|---|---|
| `auth:blacklist:{token}` | String | JWT remaining TTL | `shared/security/src/auth.ts` | Revoked JWT tokens. |
| `auth:lockout:{username}` | String | lockout duration | `shared/security/src/auth.ts` | Account lockout after repeated failures. |
| `auth:attempts:{username}` | String | configurable | `shared/security/src/auth.ts` | Failed login attempt counter. |

---

## 11. Resilience & Degradation

| Key Pattern | Type | TTL | Owner | Notes |
|---|---|---|---|---|
| `service-config:{serviceName}:degradation` | JSON | until recovery | `shared/core/src/resilience/graceful-degradation.ts` | Active degradation config for a service. Deleted on recovery. |
| `service:{serviceName}:control` | Pub/Sub channel | — | `shared/core/src/resilience/expert-self-healing-manager.ts` | Control channel for service management commands (restart, scale, pause). |

**Note**: `service-config:*` is a key (String/JSON). `service:*:control` is a Pub/Sub
channel, not a persisted key.

---

## 12. Pub/Sub Channels

| Channel Pattern | Owner | Purpose |
|---|---|---|
| `service-degradation:{serviceName}` | `shared/core/src/resilience/graceful-degradation.ts` | Notify subscribers of degradation events. |
| `service-recovery:{serviceName}` | `shared/core/src/resilience/graceful-degradation.ts` | Notify subscribers of recovery events. |
| `gossip:{nodeId}` | `shared/core/src/caching/cache-coherency-manager.ts` | Cache gossip/invalidation between nodes. |

---

## 13. Analytics & Quality Monitoring

| Key Pattern | Type | TTL | Owner | Notes |
|---|---|---|---|---|
| `trade:{tradeId}` | JSON | 30 days | `shared/core/src/analytics/performance-analytics.ts` | Trade record for analytics. |
| `quality:detection:{operationId}` | JSON | configurable | `shared/core/src/analytics/professional-quality-monitor.ts` | Per-detection quality snapshot. |
| `quality:system:{timestamp}` | JSON | configurable | `shared/core/src/analytics/professional-quality-monitor.ts` | System-wide quality snapshot. |
| `quality:operational:{timestamp}` | JSON | configurable | `shared/core/src/analytics/professional-quality-monitor.ts` | Operational quality snapshot. |

---

## 14. MEV Protection — Adaptive Threshold

| Key Pattern | Type | TTL | Owner | Notes |
|---|---|---|---|---|
| `adaptive:sandwich_attacks` | JSON/List | configurable | `shared/core/src/mev-protection/adaptive-threshold.service.ts` | Historical sandwich attack events for threshold tuning. |
| `adaptive:threshold_adjustments` | JSON/List | configurable | `shared/core/src/mev-protection/adaptive-threshold.service.ts` | Historical threshold adjustment records. |

---

## 15. A/B Testing

| Key Pattern | Type | TTL | Owner | Notes |
|---|---|---|---|---|
| `ab-test:{experimentId}:*` | JSON | configurable | `services/execution-engine/src/ab-testing/framework.ts` | A/B test state and metrics. Default prefix `ab-test:` (configurable via `redisKeyPrefix`). |

---

## Namespace Summary

| Prefix | Subsystem | Notes |
|---|---|---|
| `stream:` | Redis Streams | All streams; see §1 |
| `coordinator:leader:` | Leader election | Single key |
| `health:` | Service health | Per-service snapshot |
| `region:health:` | Cross-region health | Per-region snapshot |
| `routing:failed:` | Cross-region failover | Per-region routing failures |
| `metrics:` | Service metrics | Time-bucketed + rolling |
| `pair:` | Pair cache (L2) | Token pair price cache |
| `opp:dedup:` | Opportunity dedup | Short-TTL dedup guard |
| `bridge:recovery:` | Bridge recovery | Cross-chain state (HMAC-signed) |
| `bridge:recovery:corrupt:` | Bridge dead-letter | Unparse-able recovery keys |
| `commit-reveal:` | MEV protection | In-flight commit state |
| `dlq:` | Key-based DLQ | Failed operation retry queue |
| `ratelimit:` | Rate limiting | Sliding-window counters |
| `auth:blacklist:` | Auth | Revoked JWTs |
| `auth:lockout:` | Auth | Account lockout |
| `auth:attempts:` | Auth | Login attempt counter |
| `service-config:` | Graceful degradation | Active degradation configs |
| `trade:` | Analytics | Trade records |
| `quality:` | Quality monitor | Detection/system quality |
| `adaptive:` | MEV threshold | Sandwich attack history |
| `ab-test:` | A/B testing | Experiment state |

---

## Operational Notes

### SCAN Safety
Never use `KEYS` — it blocks Redis. All SCAN-based subsystems use cursor iteration:
- `BridgeRecoveryManager`: `SCAN 0 MATCH bridge:recovery:* COUNT 100`
- `GracefulDegradation`: `SCAN 0 MATCH service-config:*:degradation`
- `DeadLetterQueue`: `SCAN 0 MATCH dlq:priority:*` (and service/tag indexes)

### TTL Enforcement
Keys without explicit TTL (`bridge:recovery:*`, `dlq:*`) rely on the owning service
to delete them on resolution. If a service crashes mid-operation, these keys may persist
indefinitely. The bridge recovery manager and DLQ manager both run startup scans to
reprocess or clean up stale keys.

### HMAC Signing
`bridge:recovery:*` keys are HMAC-SHA256 signed when `STREAM_SIGNING_KEY` is set
(see `shared/core/src/redis/streams.ts`). The HMAC context binds to the Redis key path
to prevent cross-key replay attacks (P3-27 FIX).
