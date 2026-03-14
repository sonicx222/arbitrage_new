# ADR-038: Chain-Grouped Execution Engines

## Status
Accepted

## Date
2026-03-06

## Context

The execution engine was a single-instance bottleneck processing all chains sequentially. Live monitoring (session 20260306_113901) showed:

- **4,506–6,862 pending messages** on `stream:execution-requests` (CRITICAL lag)
- **100 opps/s produced** vs **46 opps/s processed** — EE throughput < detection throughput
- **MAXLEN 25K cap reached** with active trimming — silent data loss of untrimmed opportunities

The coordinator pipeline optimization (ADR-037) improved forwarding throughput, but the single EE instance remained the bottleneck. Horizontal scaling of identical EE instances would cause duplicate execution (two EEs both executing the same opportunity = double gas spend).

### Requirements

1. Scale execution throughput beyond single-instance limits
2. Prevent duplicate execution across EE instances
3. Preserve <50ms hot-path latency target
4. Maintain backward compatibility with single-EE deployments
5. Align with existing detector partition topology (ADR-003)

## Decision

### Chain-Group Partitioning

Split the single `stream:execution-requests` into four per-group streams, mirroring the detector partitions (ADR-003):

| Group | Chains | Stream | MAXLEN |
|-------|--------|--------|--------|
| `fast` | bsc, polygon, avalanche, fantom | `stream:exec-requests-fast` | 25,000 |
| `l2` | arbitrum, optimism, base, scroll, blast, mantle, mode | `stream:exec-requests-l2` | 25,000 |
| `premium` | ethereum, zksync, linea | `stream:exec-requests-premium` | 25,000 |
| `solana` | solana | `stream:exec-requests-solana` | 10,000 |

Total MAXLEN capacity: 85,000 (vs 100,000 legacy single stream). Solana uses 10K because it has fewer DEX pairs and lower opportunity volume.

### Routing Logic

The coordinator resolves the target stream per opportunity:

1. **Intra-chain**: Use `opportunity.chain` → `getStreamForChain(chain)` → group stream
2. **Cross-chain**: Use `opportunity.buyChain` → `getStreamForChain(buyChain)` → group stream (buy-side determines execution group)
3. **Unknown chain / no resolver**: Fall back to legacy `stream:execution-requests`

The chain → group mapping is pre-computed at module load into a `Map<string, ExecutionChainGroup>` for O(1) hot-path access (~0.5–1μs per lookup).

### Environment Variables

| Variable | Service | Values | Default |
|----------|---------|--------|---------|
| `COORDINATOR_CHAIN_GROUP_ROUTING` | Coordinator | `true` to enable | disabled (legacy mode) |
| `EXECUTION_CHAIN_GROUP` | Execution Engine | `fast`, `l2`, `premium`, `solana` | unset (legacy mode) |

Both must be set for chain-grouped routing. If either is unset, the system operates in legacy single-stream mode.

### Consumer Group Pre-Creation

When `COORDINATOR_CHAIN_GROUP_ROUTING=true`, the coordinator pre-creates:
1. Each group stream via `xaddWithLimit` (dummy init message)
2. Consumer group `execution-engine-group` on each stream via `createConsumerGroup` with MKSTREAM flag

This prevents NOGROUP errors when EE instances start after the coordinator. The `startId: '$'` ensures only new messages are consumed — stale opportunities are dangerous for trading systems.

### Backward Compatibility

- **No env vars set**: System operates identically to pre-ADR-038 (single stream, single EE)
- **Only coordinator env set**: Opportunities are routed to group streams but no EE consumes them — they accumulate until EEs are configured (safe; MAXLEN prevents unbounded growth)
- **Only EE env set**: EE subscribes to its group stream but coordinator doesn't route there — EE sees no messages (safe; falls back gracefully)

### Chain ID Validation

Both `chain` and `buyChain`/`sellChain` fields are validated against the canonical chain ID whitelist (`isCanonicalChainId`) before routing. Unrecognized chains are rejected with a warning log. This prevents:
- Forged chain IDs from bypassing the resolver to the legacy stream
- Typos in chain configuration from causing silent misrouting

### HMAC Signing

All four group streams are covered by the existing HMAC-SHA256 signing infrastructure. `xaddWithLimit` signs automatically with stream-name binding, preventing cross-stream replay attacks.

## Consequences

### Positive
- **Linear throughput scaling**: 4 EE instances process ~4× the volume of 1
- **Chain-affinity caching**: Each EE only needs RPC connections and gas price caches for its chain group
- **Fault isolation**: A failing BSC RPC only affects the `fast` group, not premium/l2/solana
- **Zero-downtime migration**: Enable per-group, one at a time, with legacy fallback

### Negative
- **Operational complexity**: 4 EE instances to deploy/monitor instead of 1
- **Configuration coupling**: Coordinator and EE env vars must be aligned
- **Uneven load**: `fast` group (4 chains, high volume) may need horizontal scaling before `solana` (1 chain)

### Risks
- **Chain addition**: Adding a new chain requires updating `PARTITIONS` in `shared/config/src/partitions.ts` — the execution chain group mapping derives from it automatically
- **Group rebalancing**: Moving a chain between groups requires restarting both coordinator and affected EE instances

## References

- ADR-003: Partitioned Detectors — defines the 4 partition topology this mirrors
- ADR-037: Coordinator Pipeline Optimization — resolved coordinator-side throughput
- `shared/config/src/execution-chain-groups.ts` — chain → group mapping and public API
- `shared/config/src/partitions.ts` — source of truth for chain assignments
- `docs/reports/EXECUTION_BOTTLENECK_RESEARCH_2026-03-06.md` — research that motivated this ADR
