# ADR-039: Async Pipeline Split with SimulationWorker

## Status
Accepted

## Date
2026-03-06

## Context

Live monitoring (session 20260306_133151) after the ADR-038 chain-grouped execution split showed:

- **EE throughput bottleneck persists**: 100 opps/s produced vs 46/s processed
- **Backpressure active at ratio=1.0**: detection faster than execution
- **Execution lag**: 619–714 pending messages on exec-request streams (improved from 4,506 but still high)

The core bottleneck was identified in `docs/reports/EXECUTION_BOTTLENECK_RESEARCH_2026-03-06.md` (Phase 3 analysis):

> Inside each EE worker: 200ms blockMs polling + ~50ms simulation (eth_call) + ~50ms strategy setup = ~300ms per execution slot. With 5 concurrent slots this yields ~16 executions/second — less than the 100/s detection rate.

The 50ms `eth_call` simulation (`performSimulation()` inside strategies) is the most significant variable cost. It:
1. Runs **inside** the execution slot, consuming one of the 5 concurrent slots
2. **Blocks the slot** for its full duration even for unprofitable opportunities
3. Is **redundant** for unprofitable paths — we pay the full cost then discard the result

### Requirements

1. Move the profitability pre-check out of the EE's hot path
2. Filter unprofitable opportunities before they consume execution slots
3. Preserve backward compatibility (must work without the new component)
4. Maintain <50ms execution latency target after pre-filtering
5. Avoid dropping opportunities due to infrastructure failures (fail-open)
6. Handle staleness: pre-simulation results become invalid after market state changes

## Decision

### Async Pipeline Split Architecture

Introduce a `SimulationWorker` that runs as a separate stage between the coordinator and the execution engine:

```
[Coordinator] → [exec-request streams] → [SimulationWorker] → [stream:pre-simulated] → [EE]
```

The SimulationWorker:
1. Consumes from exec-request streams using a **separate consumer group** (`simulation-worker-group`) — does NOT compete with the EE
2. Runs `BatchQuoterService.simulateArbitragePath()` — a single `eth_call` to the on-chain `MultiPathQuoter` contract
3. **Drops unprofitable opportunities** (`expectedProfit <= 0n`) before they reach the EE
4. **Stamps** `preSimulatedAt` (Unix ms timestamp) and `preSimulationScore` (0–1 profitability score) on each forwarded message
5. **Publishes** to `stream:pre-simulated`

The EE (when `ASYNC_PIPELINE_SPLIT=true`) consumes from `stream:pre-simulated` instead of the raw exec-request stream.

### Staleness Filter

Pre-simulation results become invalid once the on-chain state changes — typically within 1–2 block times. The EE adds a staleness filter in `ExecutionPipeline.executeOpportunity()`:

- If `preSimulatedAt` is set and `Date.now() - preSimulatedAt >= 2 × CHAINS[chain].blockTime × 1000`: **drop** the opportunity with a `warn` log
- If `preSimulatedAt` is absent (legacy path, non-async-pipeline): **execute normally**

| Chain | Block time | Staleness window |
|-------|-----------|-----------------|
| BSC | 3s | 6,000ms |
| Polygon | 2s | 4,000ms |
| Arbitrum | 0.25s | 500ms |
| Ethereum | 12s | 24,000ms |
| Base/Optimism | 2s | 4,000ms |

The window uses `>= 2×` (not `> 2×`) so exactly-at-boundary opportunities are **not** stale (boundary is fresh).

### Fail-Open for Quoter Errors

If `BatchQuoterService` throws (RPC timeout, network error, quoter contract not deployed), the SimulationWorker **forwards** the opportunity rather than dropping it. Reasoning:

- RPC failures are transient; dropping profitable opportunities due to infrastructure issues wastes capital
- The EE's full simulation still runs for forwarded-on-error messages
- A missed simulation filter is less harmful than a dropped profitable trade

### Pass-Through Mode

When `batchQuoter = null` (no BatchQuoterService configured, e.g., for chains without a deployed `MultiPathQuoter` contract), the SimulationWorker forwards all messages with `preSimulatedAt` stamped but without profitability filtering. This enables the staleness filter even without full simulation.

### Consumer Group Separation

```
stream:exec-requests-fast
├── Consumer group: execution-engine-group  ← EE (ASYNC_PIPELINE_SPLIT=false)
└── Consumer group: simulation-worker-group ← SimulationWorker
```

When `ASYNC_PIPELINE_SPLIT=true`:
```
stream:exec-requests-fast
└── Consumer group: simulation-worker-group ← SimulationWorker → stream:pre-simulated

stream:pre-simulated
└── Consumer group: execution-engine-group  ← EE
```

This ensures the SimulationWorker receives ALL messages, not a subset interleaved with EE messages.

### Environment Variables

| Variable | Service | Values | Default |
|----------|---------|--------|---------|
| `ASYNC_PIPELINE_SPLIT` | Execution Engine | `true` to enable | `false` (legacy inline mode) |

### Stream Configuration

| Stream | MAXLEN | Notes |
|--------|--------|-------|
| `stream:pre-simulated` | 25,000 | Smaller than exec-request streams — SimulationWorker filters ~30–50% of opps before publishing |

### Implementation Files

| File | Purpose |
|------|---------|
| `services/execution-engine/src/workers/simulation-worker.ts` | `SimulationWorker` class |
| `services/execution-engine/src/execution-pipeline.ts` | Staleness filter in `executeOpportunity()` |
| `services/execution-engine/src/engine.ts` | Wiring: starts SimulationWorker, routes OpportunityConsumer |
| `services/execution-engine/src/index.ts` | Parses `ASYNC_PIPELINE_SPLIT` env var |
| `services/execution-engine/src/types.ts` | `asyncPipelineSplit?: boolean` in `ExecutionEngineConfig` |
| `shared/types/src/index.ts` | `preSimulatedAt?: number`, `preSimulationScore?: number` on `ArbitrageOpportunity` |
| `shared/types/src/events.ts` | `PRE_SIMULATED` in `RedisStreams` constant |
| `shared/core/src/redis/streams.ts` | MAXLEN entry for `stream:pre-simulated` |

## Consequences

### Positive

- **Increased EE throughput**: Unprofitable opportunities filtered before consuming execution slots
- **Reduced slot latency**: EE executes only pre-validated opportunities; no wasted `eth_call` slots on losing paths
- **Staleness protection**: Pre-simulation results older than 2× block time are dropped, preventing execution of stale market data
- **Backward compatible**: System operates identically without `ASYNC_PIPELINE_SPLIT=true`
- **Fail-safe**: Quoter failures don't discard opportunities — fail-open ensures no silent capital loss

### Negative

- **Additional component**: SimulationWorker requires its own consumer group and process slot
- **Increased latency budget**: An extra Redis publish/consume hop adds ~1–5ms to the pre-execution path
- **Two-phase deployment**: SimulationWorker must be running before enabling `ASYNC_PIPELINE_SPLIT` on the EE
- **BatchQuoter dependency**: Full simulation filtering requires a deployed `MultiPathQuoter` contract per chain

### Risks

- **Staleness window calibration**: Using `2× blockTime` may be too conservative for fast chains (Arbitrum 0.25s → 500ms window) or too aggressive for slow chains. Operators can tune by adjusting the multiplier if needed.
- **Score inflation**: `preSimulationScore` is computed from self-reported `expectedProfit × confidence` in pass-through mode — these fields can be any value from detectors. The score is advisory only; the EE does not use it for admission control.
- **Consumer group lag**: If SimulationWorker falls behind, `stream:pre-simulated` depth grows; `stream:exec-request` consumer group `simulation-worker-group` accumulates PEL. Both are bounded by MAXLEN.

## References

- ADR-038: Chain-Grouped Execution Engines — defines exec-request stream topology
- ADR-002: Redis Streams over Pub/Sub — stream architecture foundation
- ADR-016: Transaction Simulation — BatchQuoterService/MultiPathQuoter contract
- `docs/reports/EXECUTION_BOTTLENECK_RESEARCH_2026-03-06.md` — Phase 3 research motivating this ADR
- `services/execution-engine/src/workers/simulation-worker.ts` — implementation
- `services/execution-engine/__tests__/unit/workers/simulation-worker.test.ts` — unit tests
- `services/execution-engine/__tests__/unit/workers/staleness-filter.test.ts` — staleness filter tests
