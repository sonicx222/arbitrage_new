# ADR-010: WebSocket Connection Resilience

## Status
**Accepted**

## Date
2026-01-15

## Context

The arbitrage system relies on WebSocket connections to 11 blockchain networks for real-time price data. Free RPC providers have limitations:

1. **Rate Limiting**: Providers enforce request limits, leading to connection drops
2. **Single Points of Failure**: Only Optimism had fallback URLs configured
3. **Thundering Herd**: Fixed 5s reconnection interval caused simultaneous reconnects
4. **Silent Failures**: Connections could become stale without explicit errors
5. **Suboptimal Recovery**: Round-robin fallback selection ignores provider health

These issues threatened the 99.9% uptime target required for 24/7 arbitrage monitoring.

## Decision

Implement a comprehensive WebSocket resilience system with three layers:

### Layer 1: Core Resilience
- **Exponential backoff with jitter**: `delay = min(baseDelay * 2^attempt, maxDelay) + random(0, 25%)`
- **Fallback URLs for all chains**: 1-4 fallback URLs per chain from diverse providers
- **Rate limit detection**: Pattern matching for JSON-RPC codes (-32005, -32016), WebSocket codes (1008, 1013), and error messages
- **Provider exclusion**: Exponential cooldown (30s → 5min max) for rate-limited providers

### Layer 2: Health Monitoring
- **Provider Health Scorer**: New module tracking latency, success rate, block freshness
- **Weighted scoring**: 30% latency + 40% reliability + 30% freshness
- **Connection quality metrics**: Track message gaps, uptime, reconnect count
- **Proactive staleness detection**: 30s threshold triggers rotation before failure

### Layer 3: Intelligent Recovery
- **Health-based fallback selection**: Select best provider using health scores
- **Subscription recovery validation**: Confirm each subscription with timeout
- **Data gap detection**: Emit events when blocks are missed during disconnection

## Rationale

### Why Exponential Backoff with Jitter?
- Prevents thundering herd when multiple connections fail simultaneously
- Reduces load on recovering providers
- Industry standard pattern (AWS, Google Cloud recommendations)

### Why Provider Exclusion?
- Repeatedly hitting rate-limited provider extends ban duration
- Better to use available providers while waiting for exclusion to expire
- Exponential exclusion duration handles persistent issues

### Why Health Scoring?
- Round-robin ignores provider performance differences
- Health data accumulates over time, improving selection accuracy
- Singleton pattern shares health data across all WebSocket managers

### Why Proactive Staleness Detection?
- WebSocket connections can silently fail (firewall drops, provider issues)
- 30s threshold balances false positives vs. stale data risk
- Rotation before failure maintains data continuity

> **Note**: This ADR covers **connection-level** staleness — detecting when a WebSocket connection has stopped delivering messages. This is distinct from **price-data** staleness (rejecting outdated price data during opportunity detection), which is covered by [ADR-033: Stale Price Window Protection](./ADR-033-stale-price-window.md) and documented in [STALE_PRICE_WINDOW.md](../../STALE_PRICE_WINDOW.md).

## Consequences

### Positive
- **100% fallback coverage**: All 11 chains have 2+ URLs
- **Zero manual intervention**: Automatic recovery from rate limits
- **Optimal provider selection**: Health-based selection outperforms round-robin
- **Proactive monitoring**: Detect issues before they cause data gaps
- **Better observability**: Quality metrics available for monitoring

### Negative
- **Added complexity**: ~500 lines of new code
- **Memory overhead**: Health metrics stored per provider (~1KB/provider)
- **Potential false positives**: Staleness detection may trigger unnecessary rotations

### Neutral
- **Public RPC dependency**: Fallback URLs use free public RPCs with varying reliability
- **Configuration maintenance**: Fallback URLs may need updates as providers change

## Alternatives Considered

### 1. Single-Provider with Higher Tier
- **Rejected**: Violates $0/month constraint
- **Cost**: $100-500/month for premium RPC services

### 2. Self-Hosted Nodes
- **Rejected**: Resource intensive, complex maintenance
- **Cost**: Significant compute and storage requirements

### 3. Simple Round-Robin Fallback
- **Rejected**: Ignores provider health, may repeatedly select unhealthy providers
- **Simpler but less effective**

### 4. External Health Check Service
- **Rejected**: Adds external dependency, additional latency
- **Better to track health inline with connections**

## Implementation

### Files Created/Modified
- `shared/core/src/websocket-manager.ts` - Core resilience features
- `shared/core/src/provider-health-scorer.ts` - NEW: Health scoring module
- `shared/config/src/index.ts` - Fallback URLs for all chains
- `shared/core/src/index.ts` - Module exports

### Configuration
```typescript
interface WebSocketConfig {
  url: string;
  fallbackUrls?: string[];
  reconnectInterval?: number;     // Default: 1000ms
  backoffMultiplier?: number;     // Default: 2.0
  maxReconnectDelay?: number;     // Default: 60000ms
  jitterPercent?: number;         // Default: 0.25
  chainId?: string;               // For health tracking
}
```

### Fallback URL Configuration

| Chain | Fallback Providers |
|-------|-------------------|
| Arbitrum | publicnode, blastapi, alchemy-demo |
| BSC | publicnode, blastapi, bnbchain |
| Base | publicnode, blastapi |
| Polygon | publicnode, blastapi |
| Ethereum | publicnode, blastapi |
| Avalanche | publicnode, blastapi |
| Fantom | publicnode, blastapi |
| zkSync | drpc, publicnode |
| Linea | drpc |
| Solana | publicnode |
| Optimism | optimism.io, blastapi, publicnode |

### Events Emitted
- `rateLimit`: Provider hit rate limit, being excluded
- `staleConnection`: Connection appears stale, rotating
- `dataGap`: Blocks were missed during disconnection
- `subscriptionRecoveryPartial`: Some subscriptions failed after reconnect

## Testing

- 100 unit tests covering exponential backoff, rate limit detection, provider exclusion
- Integration tests for multi-provider failover scenarios
- Fallback URL validation tests (protocol, uniqueness, diversity)

## Metrics

| Metric | Before | After |
|--------|--------|-------|
| Reconnection storm probability | High | Very Low |
| Fallback coverage | 9% (1/11) | 100% (11/11) |
| Rate limit recovery | Manual | Automatic |
| Provider selection | Round-robin | Health-based |
| Stale detection | None | 30s threshold |

## References

- [DECISION_LOG.md](../DECISION_LOG.md) - Session entry for S3.3
- [ADR-003](./ADR-003-partitioned-detectors.md) - Partitioned architecture context
- [ADR-007](./ADR-007-failover-strategy.md) - Failover strategy context
- AWS Architecture Blog: Exponential Backoff and Jitter

## Confidence Level

95% - High confidence based on:
- Industry-standard patterns (exponential backoff, jitter)
- Comprehensive test coverage (100 tests)
- All identified gaps addressed
- Clear success criteria (99.9% uptime target)

Risk factors:
- Public RPC provider reliability varies
- Health scoring weights may need tuning per chain
- Free tier limits may change over time
