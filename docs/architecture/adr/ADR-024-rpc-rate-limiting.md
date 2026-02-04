# ADR-024: RPC Rate Limiting Strategy

## Status
**Accepted** | 2026-02-04

## Context

The arbitrage system makes RPC calls to multiple blockchain providers with documented rate limits:
- dRPC: 40-100 RPS, 210M CU/month
- Ankr: 30 RPS, 200M CU/month
- PublicNode: 100-200 RPS, unlimited (no key)
- Fallbacks (Infura, Alchemy, QuickNode): 25 RPS each

### Problem

Without rate limiting, burst traffic during high-activity periods risks:
1. **429 errors** from providers triggering emergency throttling
2. **Account suspension** for exceeding monthly compute unit quotas
3. **Degraded performance** when hitting rate limits unexpectedly
4. **Cascading failures** if primary provider gets throttled

### Constraints

1. **Hot-path latency target: <50ms** - Transaction execution cannot be delayed
2. **Backward compatibility** - Existing code should work without modification
3. **Provider diversity** - Different providers have different limits
4. **Burst handling** - Legitimate traffic bursts should be accommodated

## Decision

Implement a **token bucket rate limiter** with:
1. Per-provider rate limits based on documented quotas
2. Hot-path method exemptions for time-critical operations
3. Opt-in activation for backward compatibility

### Algorithm: Token Bucket

Chosen over alternatives for its burst-handling characteristics:

```
Token Bucket Algorithm:
- Tokens refill at `tokensPerSecond` rate
- Tokens cap at `maxBurst` (prevents unbounded accumulation)
- Each request consumes one token
- If no tokens available, request is throttled
```

**Why Token Bucket?**

| Algorithm | Pros | Cons | Verdict |
|-----------|------|------|---------|
| **Token Bucket** | Allows bursts, smooth rate enforcement | Slight memory overhead | **Selected** |
| **Sliding Window** | Precise rate calculation | No burst accommodation | Rejected |
| **Fixed Window** | Simple implementation | Burst at window boundaries | Rejected |
| **Leaky Bucket** | Smooth output rate | No burst accommodation | Rejected |

### Hot-Path Exemptions

Methods exempt from rate limiting to preserve <50ms latency target:

```typescript
const RATE_LIMIT_EXEMPT_METHODS = new Set([
  'eth_sendRawTransaction', // Trade execution - must not be delayed
  'eth_sendTransaction',    // Trade execution - must not be delayed
]);
```

**Rationale**: These methods are in the critical execution path. A successful arbitrage opportunity must execute within milliseconds. Delaying transaction submission could result in:
- Missed opportunities (price moved)
- Sandwich attacks (front-run by MEV bots)
- Transaction reverts (stale state)

### Per-Provider Rate Limits

| Provider | Tokens/Second | Max Burst | Rationale |
|----------|---------------|-----------|-----------|
| dRPC | 40 | 80 | Conservative (40-100 documented) |
| Ankr | 30 | 60 | Match documented limit |
| PublicNode | 100 | 200 | Match documented limit |
| Infura | 25 | 50 | Conservative for fallback |
| Alchemy | 25 | 50 | Conservative for fallback |
| QuickNode | 25 | 50 | Conservative for fallback |
| Default | 20 | 40 | Safe fallback for unknown providers |

### Activation Strategy

**Opt-in by default** for backward compatibility:

```typescript
// batch-provider.ts
const config = {
  enableRateLimiting: config?.enableRateLimiting ?? false,  // Opt-in
  rateLimitConfig: config?.rateLimitConfig ?? { tokensPerSecond: 20, maxBurst: 40 },
};
```

**Rationale**: Existing deployments should not suddenly experience throttling. Teams can enable rate limiting explicitly after testing.

## Implementation

### File Structure

```
shared/core/src/rpc/
├── rate-limiter.ts          # Token bucket implementation
├── batch-provider.ts        # Integration with batching (enableRateLimiting config)
```

### Key Components

#### TokenBucketRateLimiter (rate-limiter.ts:54-183)

```typescript
class TokenBucketRateLimiter {
  tryAcquire(): boolean;           // Non-blocking check (hot-path safe)
  acquire(timeoutMs): Promise<boolean>;  // Blocking wait (cold-path only)
  getStats(): RateLimiterStats;    // Monitoring
}
```

#### RateLimiterManager (rate-limiter.ts:243-292)

```typescript
class RateLimiterManager {
  getLimiter(chainOrProvider): TokenBucketRateLimiter;
  tryAcquire(chainOrProvider, method): boolean;  // Handles exemptions
  getAllStats(): Map<string, RateLimiterStats>;
}
```

#### Integration in BatchProvider (batch-provider.ts:230-234)

```typescript
if (this.config.enableRateLimiting) {
  const rateLimitConfig = config?.rateLimitConfig ?? getRateLimitConfig(this.config.chainOrProvider);
  this.rateLimiter = new TokenBucketRateLimiter(rateLimitConfig);
}
```

### Statistics and Monitoring

Rate limiter tracks:
- `allowedRequests`: Total requests that passed
- `throttledRequests`: Total requests that were rate-limited
- `availableTokens`: Current token count
- `throttleRate`: Percentage of throttled requests

Logged periodically to avoid log spam:
```typescript
// Log every 100th throttle event
if (this.throttledRequests % 100 === 0) {
  logger.debug('Rate limit throttling active', { ... });
}
```

## Rationale

### Why Opt-In?

1. **No breaking changes** - Existing deployments continue working
2. **Gradual rollout** - Teams can enable and test in staging first
3. **Provider trust** - Some teams may prefer provider-side rejection
4. **Cost vs complexity** - Rate limiting adds overhead; some may prefer simplicity

### Why Per-Provider Limits?

1. **Provider diversity** - dRPC (40 RPS) vs PublicNode (200 RPS) have 5x difference
2. **Failover accuracy** - When throttled on one provider, others may still have capacity
3. **Cost optimization** - Can prioritize cheaper/free providers up to their limits

### Why Hot-Path Exemptions?

1. **Latency preservation** - <50ms target must be maintained
2. **Financial impact** - Delayed execution has direct profit impact
3. **MEV protection** - Fast execution reduces front-running window
4. **Low volume** - Transaction sends are infrequent (<1% of RPC calls)

## Consequences

### Positive

- Prevents 429 errors from providers
- Predictable RPC costs
- Graceful degradation under load
- Burst traffic accommodated
- No hot-path latency impact (exempt methods)

### Negative

- Opt-in requires explicit enablement
- Token tracking adds small memory overhead (~100 bytes per provider)
- Non-exempt methods may be delayed under heavy load

### Mitigations

- Document enablement in deployment guides
- Memory overhead is negligible for typical provider counts (6-10)
- Max burst allows legitimate traffic spikes

## Alternatives Considered

### Alternative 1: Provider-Side Rate Limiting Only

- **Description**: Rely entirely on provider 429 responses
- **Rejected because**: Reactive (damage done), poor UX, no burst protection
- **Would reconsider if**: Provider SLAs improve with guaranteed graceful degradation

### Alternative 2: Global Rate Limiter

- **Description**: Single rate limiter shared across all providers
- **Rejected because**: Can't optimize for provider-specific limits
- **Would reconsider if**: Using single provider deployment

### Alternative 3: Request Queue with Backpressure

- **Description**: Queue all requests, release at controlled rate
- **Rejected because**: Adds latency to all requests, complex implementation
- **Would reconsider if**: Need guaranteed delivery over latency

## References

- [RPC_PREDICTION_OPTIMIZATION_RESEARCH.md](../../reports/RPC_PREDICTION_OPTIMIZATION_RESEARCH.md) - Optimization R3
- [ADR-010: WebSocket Resilience](./ADR-010-websocket-resilience.md) - Provider failover strategy
- [Provider Configuration](../../../shared/config/src/chains/provider-config.ts) - Provider limits documentation
- [Token Bucket Algorithm](https://en.wikipedia.org/wiki/Token_bucket)

## Confidence Level

**90%** - High confidence based on:
- Token bucket is industry-standard for rate limiting
- Hot-path exemptions preserve latency requirements
- Implementation is tested and production-ready
- Opt-in activation eliminates breaking change risk

## Enablement Guide

To enable rate limiting in production:

```typescript
// Option 1: Via BatchProvider config
const batchProvider = new BatchProvider(provider, {
  enableRateLimiting: true,
  chainOrProvider: 'bsc-drpc'  // Uses dRPC limits
});

// Option 2: With custom limits
const batchProvider = new BatchProvider(provider, {
  enableRateLimiting: true,
  rateLimitConfig: {
    tokensPerSecond: 50,
    maxBurst: 100,
    identifier: 'custom-provider'
  }
});
```

Monitor throttle rates:
```typescript
const stats = batchProvider.getRateLimiterStats();
console.log(`Throttle rate: ${(stats.throttleRate * 100).toFixed(2)}%`);
```
