# ADR-018: Execution Circuit Breaker

## Status
**Accepted**

## Date
2026-01-23

## Context

The execution engine had no mechanism to halt execution during systemic failures. This created risks:

1. **Capital drain**: Consecutive failures during network issues could deplete gas
2. **Cascade failures**: One chain's issues could affect others
3. **No automatic recovery**: Manual intervention required to resume
4. **Blind execution**: No visibility into failure patterns

During a network congestion event, the engine could attempt hundreds of failing transactions, each consuming gas and potentially missing the actual opportunity window.

## Decision

Implement a **per-chain** circuit breaker pattern with three states per chain:

```
                    ┌─────────────────────────────┐
                    │                             │
                    ▼                             │
┌──────────┐   N failures    ┌──────────┐   cooldown   ┌────────────┐
│  CLOSED  │ ───────────────►│   OPEN   │ ────────────►│ HALF_OPEN  │
│(normal)  │                 │ (halted) │              │  (testing) │
└──────────┘                 └──────────┘              └────────────┘
     ▲                                                       │
     │                                                       │
     │              success                                  │
     └───────────────────────────────────────────────────────┘
                                  │
                                  │ failure
                                  ▼
                            back to OPEN
```

Each chain maintains its own independent circuit breaker instance, managed by `CircuitBreakerManager`. Breakers are created lazily on first access per chain. This ensures that failures on one chain (e.g., Ethereum congestion) do not block executions on healthy chains (e.g., Arbitrum).

### Configuration

```typescript
interface CircuitBreakerConfig {
  enabled: boolean;           // Default: true
  failureThreshold: number;   // Default: 5 consecutive failures
  cooldownPeriodMs: number;   // Default: 5 minutes (300,000ms)
  halfOpenMaxAttempts: number; // Default: 1
}
```

Configuration is shared across all per-chain breakers. Each chain's breaker tracks its own failure count and state independently.

### State Behavior

| State | Behavior |
|-------|----------|
| CLOSED | Normal operation, executions proceed for this chain |
| OPEN | All executions blocked for this chain, waiting for cooldown |
| HALF_OPEN | Allow limited test executions for this chain |

### Events Published

Circuit breaker state changes are published to Redis Streams:

```typescript
// stream:circuit-breaker
{
  event: 'state_change',
  previousState: 'CLOSED',
  newState: 'OPEN',
  reason: 'Failure threshold exceeded (5 consecutive failures)',
  timestamp: 1706000000000
}
```

## Rationale

### Why Circuit Breaker Pattern?

1. **Proven pattern**: Well-established in distributed systems
2. **Self-healing**: Automatically recovers without intervention
3. **Capital protection**: Prevents gas waste during outages
4. **Observability**: Clear state machine for monitoring

### Why 5 Failures / 5 Minutes?

- **5 failures**: Distinguishes systematic issues from random failures
- **5 minutes**: Long enough for most transient issues to resolve
- Both values are configurable via environment variables

### Why HALF_OPEN State?

- **Gradual recovery**: Don't flood system immediately after cooldown
- **Validation**: Confirm issue is resolved before full resumption
- **Risk mitigation**: Single test failure returns to OPEN

### Per-Chain Architecture

```
CircuitBreakerManager
  ├── ethereum  → CircuitBreaker { state: CLOSED, failures: 0 }
  ├── arbitrum  → CircuitBreaker { state: OPEN,   failures: 5 }
  ├── bsc       → CircuitBreaker { state: CLOSED, failures: 1 }
  └── (lazily created per chain on first access)
```

### Integration Points

```typescript
// In ExecutionEngine.executeOpportunity()
// Per-chain: only block the affected chain
const chain = opportunity.buyChain;
if (this.circuitBreakerManager.isOpen(chain)) {
  this.stats.circuitBreakerBlocks++;
  return; // Skip execution for this chain only
}

const result = await this.strategy.execute(opportunity, ctx);

if (result.success) {
  this.circuitBreakerManager.recordSuccess(chain);
} else {
  this.circuitBreakerManager.recordFailure(chain);
}
```

## Consequences

### Positive

- **Capital protection**: No more gas drain during network issues
- **Automatic recovery**: Self-healing without manual intervention
- **Visibility**: Clear metrics on circuit breaker activity
- **Manual override**: API endpoints for force close/open

### Negative

- **Missed opportunities**: Some valid opportunities blocked during OPEN state on affected chain
- **Configuration complexity**: Thresholds need tuning per environment
- **State synchronization**: In multi-instance setup, each instance has own per-chain breakers
- **Memory per chain**: Each active chain holds a separate breaker instance (lightweight)

### Neutral

- **Testing**: Need to test failure cascade scenarios
- **Monitoring**: Need to alert on circuit breaker trips

## Alternatives Considered

### 1. Rate Limiting Only
**Rejected** because:
- Doesn't respond to failure patterns
- Still allows failing transactions
- No automatic recovery mechanism

### 2. Manual Kill Switch
**Rejected** because:
- Requires human intervention
- Slower response time
- Not 24/7 coverage

### 3. Shared Circuit Breaker (Redis-backed)
**Rejected** because:
- Added complexity
- Redis dependency for critical path
- Local per-chain state is simpler and faster

### 4. Global (Single) Circuit Breaker
**Rejected** in favor of per-chain model because:
- One chain's failure (e.g., Ethereum congestion) would block healthy chains (e.g., Arbitrum)
- Per-chain isolation prevents cascade across chains while maintaining protection within each chain

## Implementation Details

### Files Created
- `services/execution-engine/src/services/circuit-breaker.ts` — Single-chain circuit breaker implementation
- `services/execution-engine/src/services/circuit-breaker-manager.ts` — Per-chain circuit breaker lifecycle manager
- `services/execution-engine/src/api/circuit-breaker-api.ts` — REST API for manual control

### API Endpoints

```
GET  /circuit-breaker         - Get current status
POST /circuit-breaker/close   - Force close (requires API key)
POST /circuit-breaker/open    - Force open (requires API key)
```

### Test Coverage

| Test Category | Count |
|--------------|-------|
| Unit tests (circuit-breaker.ts) | 38 |
| Integration tests (engine.ts) | 13 |
| API tests | 19 |
| **Total** | 70 |

### Usage Example

```typescript
// CircuitBreakerManager creates per-chain breakers lazily
const cbManager = new CircuitBreakerManager({
  config: {
    enabled: true,
    failureThreshold: 5,
    cooldownPeriodMs: 5 * 60 * 1000,
    halfOpenMaxAttempts: 1,
  },
  logger,
  onStateChange: (chain, prev, next, reason) => {
    logger.warn(`Circuit breaker [${chain}]: ${prev} → ${next}`, { reason });
    // Publish to Redis Stream
  },
});

// Per-chain usage
cbManager.recordFailure('ethereum'); // Only affects Ethereum breaker
cbManager.isOpen('arbitrum');         // Arbitrum breaker is independent
```

## Success Criteria

- ✅ Circuit breaker trips after 5 consecutive failures
- ✅ Cooldown period prevents immediate retry (5 minutes)
- ✅ HALF_OPEN state allows limited test executions
- ✅ Manual override available via API
- ✅ Events published to Redis Stream for monitoring
- ✅ Stats track trips and blocked executions

## References

- [Circuit Breaker Pattern - Martin Fowler](https://martinfowler.com/bliki/CircuitBreaker.html)
- [Netflix Hystrix](https://github.com/Netflix/Hystrix/wiki)
- [Implementation Plan v2.0](../../reports/implementation_plan_v2.md) Task 1.3

## Confidence Level
95% - Very high confidence based on:
- Well-established pattern
- Comprehensive test coverage (70 tests)
- Clear state machine behavior
- Successful integration testing
