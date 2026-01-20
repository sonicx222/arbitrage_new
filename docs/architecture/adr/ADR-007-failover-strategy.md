# ADR-007: Cross-Region Failover Strategy

## Status
**Accepted** | 2025-01-10

## Context

The system targets **99.9% uptime** (8.76 hours downtime/year maximum).

### Current State

- Self-healing manager exists ([self-healing-manager.ts](../../../shared/core/src/self-healing-manager.ts))
- Circuit breakers implemented
- Health monitoring in place
- **Gap**: No geographic redundancy or cross-region failover

### Failure Scenarios

| Scenario | Current Impact | Frequency |
|----------|---------------|-----------|
| Single service crash | 5-10 min downtime | Weekly |
| Provider outage | Hours of downtime | Monthly |
| Region failure | Total outage | Rare |
| Redis unavailable | Complete system halt | Rare |

## Decision

Implement a **Multi-Region Active-Passive Failover** architecture with:

1. **Geographic Redundancy**: Critical services deployed in 2+ regions
2. **Leader Election**: Single active coordinator, standby ready
3. **Graceful Degradation**: Continue operation with reduced capacity
4. **Split-Brain Prevention**: Redis-based distributed locking

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        FAILOVER ARCHITECTURE                                     │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│                         ┌─────────────────────────┐                             │
│                         │    HEALTH AGGREGATOR    │                             │
│                         │    (Upstash Redis)      │                             │
│                         └───────────┬─────────────┘                             │
│                                     │                                           │
│             ┌───────────────────────┼───────────────────────┐                  │
│             │                       │                       │                  │
│             ▼                       ▼                       ▼                  │
│  ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐    │
│  │   ASIA-PACIFIC      │  │     US-EAST         │  │     US-WEST         │    │
│  │   ───────────       │  │     ───────         │  │     ───────         │    │
│  │                     │  │                     │  │                     │    │
│  │ Detector P1 [A]     │  │ Detector P3 [A]     │  │ Executor [A]        │    │
│  │ Detector P2 [A]     │  │ Cross-Chain [A]     │  │ Executor [S]        │    │
│  │                     │  │ Coordinator [A]     │  │   (on Render)       │    │
│  │                     │  │ Coordinator [S]     │  │                     │    │
│  │                     │  │   (on GCP)          │  │                     │    │
│  │                     │  │                     │  │                     │    │
│  │ [A] = Active        │  │                     │  │                     │    │
│  │ [S] = Standby       │  │                     │  │                     │    │
│  └─────────────────────┘  └─────────────────────┘  └─────────────────────┘    │
│                                                                                  │
│  FAILOVER FLOW:                                                                 │
│  1. Health checks every 30s                                                     │
│  2. 3 consecutive failures → trigger failover                                   │
│  3. Standby acquires leader lock                                                │
│  4. Standby becomes active                                                      │
│  5. Alert sent to operators                                                     │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Component Redundancy

| Component | Primary | Standby | Failover Time |
|-----------|---------|---------|---------------|
| Coordinator | Koyeb US-East | GCP US-Central | <60s |
| Executor | Railway US-West | Render US-East | <60s |
| Detector P1 | Oracle SG | (none) | N/A (degraded mode) |
| Detector P2 | Fly.io SG | (none) | N/A (degraded mode) |
| Detector P3 | Oracle US | (none) | N/A (degraded mode) |
| Redis | Upstash Global | Local cache fallback | <10s |

### Implementation

```typescript
// Cross-region health manager
interface CrossRegionHealthManager {
  regions: Map<string, RegionHealth>;

  // Leader election with Redis distributed lock
  async electLeader(): Promise<boolean> {
    const lockKey = 'coordinator:leader:lock';
    const lockValue = `${this.instanceId}:${Date.now()}`;

    // Try to acquire lock (NX = only if not exists, EX = 30s TTL)
    const acquired = await redis.set(lockKey, lockValue, 'NX', 'EX', 30);

    if (acquired) {
      this.isLeader = true;
      this.startLeaderHeartbeat();
      return true;
    }

    return false;
  }

  // Heartbeat to maintain leadership
  // S4.1.2-FIX: Uses atomic Lua script to prevent TOCTOU race conditions
  // The check-and-extend happens in a single atomic Redis operation
  async leaderHeartbeat(): Promise<void> {
    if (!this.isLeader) return;

    const lockKey = 'coordinator:leader:lock';

    // Atomic check-and-extend using Lua script (prevents race condition)
    // Script: IF redis.get(key) == instanceId THEN redis.expire(key, ttl) RETURN 1 ELSE RETURN 0
    const renewed = await redis.renewLockIfOwned(lockKey, this.instanceId, 30);

    if (!renewed) {
      // Lost leadership (another instance took over or lock expired)
      this.isLeader = false;
      this.onLeadershipLost();
    }
  }

  // Failover trigger
  async triggerFailover(failedRegion: string): Promise<void> {
    logger.warn(`Triggering failover for region: ${failedRegion}`);

    // 1. Mark region as failed
    this.regions.get(failedRegion)!.status = 'failed';

    // 2. If this was leader region, elect new leader
    if (this.regions.get(failedRegion)!.isLeader) {
      await this.electLeader();
    }

    // 3. Redirect traffic (if applicable)
    await this.updateRoutingTable(failedRegion);

    // 4. Alert operators
    await this.sendAlert({
      type: 'region_failover',
      region: failedRegion,
      timestamp: Date.now()
    });
  }
}

// Graceful degradation modes
enum DegradationLevel {
  FULL_OPERATION = 0,      // All services healthy
  REDUCED_CHAINS = 1,      // Some chain detectors down
  DETECTION_ONLY = 2,      // Execution disabled
  READ_ONLY = 3,           // Only dashboard/monitoring
  COMPLETE_OUTAGE = 4      // All services down
}

class GracefulDegradationManager {
  private currentLevel: DegradationLevel = DegradationLevel.FULL_OPERATION;

  evaluateDegradation(healthStatus: GlobalHealthStatus): void {
    if (!healthStatus.redis.healthy) {
      this.setLevel(DegradationLevel.COMPLETE_OUTAGE);
      return;
    }

    if (!healthStatus.executor.healthy) {
      this.setLevel(DegradationLevel.DETECTION_ONLY);
      return;
    }

    const healthyDetectors = healthStatus.detectors.filter(d => d.healthy).length;
    const totalDetectors = healthStatus.detectors.length;

    if (healthyDetectors === 0) {
      this.setLevel(DegradationLevel.READ_ONLY);
    } else if (healthyDetectors < totalDetectors) {
      this.setLevel(DegradationLevel.REDUCED_CHAINS);
    } else {
      this.setLevel(DegradationLevel.FULL_OPERATION);
    }
  }

  private setLevel(level: DegradationLevel): void {
    if (level !== this.currentLevel) {
      logger.warn(`Degradation level changed: ${this.currentLevel} → ${level}`);
      this.currentLevel = level;
      this.notifyDegradationChange(level);
    }
  }
}
```

## Rationale

### Why Active-Passive (Not Active-Active)?

| Factor | Active-Active | Active-Passive |
|--------|---------------|----------------|
| Complexity | HIGH (conflict resolution) | LOW |
| Resource cost | 2x (both always running) | 1.5x (standby minimal) |
| Consistency | Eventually consistent | Strongly consistent |
| Failover time | ~0s | ~60s |
| Free tier fit | Exceeds limits | Fits within limits |

Active-Passive fits free tier constraints while providing adequate failover time.

### Why Redis-Based Leader Election?

| Approach | Pros | Cons |
|----------|------|------|
| Redis SET NX | Simple, battle-tested | Single point (Redis) |
| etcd/Consul | Purpose-built | Additional service |
| Database | Already have MongoDB | Higher latency |
| In-memory | No external dependency | Split-brain risk |

Redis is already in the stack; adding SET NX for locking is minimal overhead.

### Failover Time Budget

| Phase | Target | Strategy |
|-------|--------|----------|
| Detection | <30s | Health checks every 10s, 3 failures |
| Leader election | <10s | Redis SET NX with TTL |
| Standby activation | <20s | Pre-warmed standby, just reconnect |
| **Total** | **<60s** | |

60s failover meets 99.9% uptime target (requires <52 minutes/month downtime).

## Consequences

### Positive
- 99.9% uptime achievable
- Automatic recovery from region failures
- Graceful degradation preserves partial functionality
- Split-brain prevented via distributed locking

### Negative
- Standby services consume resources
- 60s failover window (not instant)
- Redis becomes critical dependency
- More complex monitoring requirements

### Mitigations

1. **Standby resources**: Use minimal instances, scale on activation
2. **60s window**: Acceptable for arbitrage (opportunities persist)
3. **Redis dependency**: Local cache fallback for degraded operation
4. **Monitoring**: Centralized dashboard with alerts

## Recovery Procedures

### Scenario: Executor Primary Failure

```
1. Health check fails (0s)
2. Second check fails (10s)
3. Third check fails - trigger failover (20s)
4. Update routing to Executor Backup (25s)
5. Executor Backup handles new opportunities (30s)
6. Alert sent to operators (30s)
7. Investigate primary failure (manual)
8. Restore primary when ready (manual)
9. Failback to primary (60s after restore)
```

### Scenario: Redis Unavailable

```
1. Redis connection fails (0s)
2. Retry with backoff (0-10s)
3. Switch to local cache mode (10s)
4. Degradation level: DETECTION_ONLY (10s)
5. Continue price detection (local only)
6. Alert: Redis down, execution paused
7. Monitor for Redis recovery
8. On recovery: sync local cache to Redis
9. Resume full operation
```

## Alternatives Considered

### Alternative 1: No Failover (Single Region)
- **Rejected because**: Cannot meet 99.9% uptime
- **Would reconsider if**: Uptime requirement relaxed to 99%

### Alternative 2: Active-Active Multi-Region
- **Rejected because**: Exceeds free tier resources, complex consistency
- **Would reconsider if**: Paid infrastructure acceptable

### Alternative 3: Kubernetes with Auto-Scaling
- **Rejected because**: No free Kubernetes with sufficient resources
- **Would reconsider if**: Cloud credits available

## References

- [Self-healing manager](../../../shared/core/src/self-healing-manager.ts)
- [Circuit breaker](../../../shared/core/src/circuit-breaker.ts)
- [Redis distributed locks](https://redis.io/topics/distlock)

## Confidence Level

**90%** - High confidence based on:
- Industry-standard patterns (leader election, graceful degradation)
- Redis SET NX is well-proven for locking
- 60s failover time is acceptable for use case
- Fits within free tier constraints
