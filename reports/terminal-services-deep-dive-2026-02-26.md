# Terminal Services Deep Dive Analysis (2026-02-26)

## Scope
Analyzed terminal outputs under `/data/terminal`:
- `output_coordinator.txt` (518 lines)
- `output_cross_chain_service.txt` (181 lines)
- `output_execution_service.txt` (351 lines)
- `output_p1_service.txt` (377 lines)
- `output_p2_service.txt` (428 lines)

Total analyzed lines: **1,855**  
Observed time window: **22:12:37 → 22:18:17** (local log timestamps)

## Methodology and Decision Criteria
I prioritized findings by:
1. Blast radius across services.
2. Likelihood of production or dev-loop instability.
3. Signal quality in logs (repeatability + clear root-cause breadcrumbs).
4. Engineering ROI (impact vs effort vs risk).

The analysis focused on failure propagation, data-plane throughput, connectivity resilience, health/degradation correctness, and startup/runtime overhead.

## Executive Summary
The system is functionally booting, but this run shows **three systemic issues** limiting reliability and throughput:

1. **Coordinator health/degradation logic is noisy and flaps heavily** due to stale heartbeat processing.
   - 22 stale-heartbeat warnings in ~5 minutes.
   - 9 degradation-level transitions in ~5 minutes.

2. **Provider fallback works, but auth-failure handling is inefficient**.
   - Polygon and Scroll websocket failovers repeatedly hit `401` on Ankr fallback before recovering to alternate providers.
   - Recovery completes, but after avoidable retries and data gaps.

3. **Redis outage caused synchronized cross-service failure cascade**.
   - At ~22:18:14 all services hit `EPIPE`, then `ECONNREFUSED`, then stream retries fail.
   - Error storm quality is poor (`error: ""` in multiple logs), reducing diagnostic precision.

Secondary concerns:
- Execution pipeline appears **starved** (0 simulations/executions across all periodic metrics).
- All services emit `MaxListenersExceededWarning` on startup (likely lifecycle/listener leak pattern).
- Cross-chain ML path shows startup-performance warnings (`tfjs` backend + large orthogonal init).

## Cross-Service Timeline

| Time | Event | Impact |
|---|---|---|
| 22:12:37 | Coordinator starts and becomes leader | Baseline orchestration begins |
| 22:12:42 | Coordinator degradation: `FULL_OPERATION -> COMPLETE_OUTAGE` | Health model unstable during startup |
| 22:13:36–22:13:56 | P1 and P2 partitions start healthy | Detection data plane online |
| 22:14:16 | Cross-chain detector starts healthy (ML + stream consumers) | Cross-chain analytics online |
| 22:14:24 | Execution engine starts in simulation mode | Execution plane online but idle |
| 22:14:19–22:16:55 | Scroll/Polygon websocket 401/fallback incidents | Temporary chain blind spots + data gaps |
| 22:18:14–22:18:15 | Redis `EPIPE` then `ECONNREFUSED` across all services | Full control/data-plane destabilization |
| 22:18:15+ | Retry failures, shutdown signals, final health-report failure | Cascading shutdown path |

## Key Findings

### 1) Coordinator Degradation Flapping and Stale-Heartbeat Storm
Evidence:
- Repeated stale warnings: `output_coordinator.txt:182,198,202,...,500` (22 events total).
- Degradation transitions: `output_coordinator.txt:152,164,186,264,296,312,348,360,378` (9 events).
- Staleness ages are high and rising (`ageMs` average ~96,856; max 230,071): `output_coordinator.txt:183-205,223-248,257-263,391-393`.

Interpretation:
- Coordinator is repeatedly evaluating stale health records (likely replay/old-heartbeat effects and/or insufficient stale-entity eviction), causing alert churn and unstable degradation state.

Impact:
- Alert fatigue.
- Poor trust in health state.
- Potential false failover/degradation reactions.

### 2) Redis Failure Cascade Is a Single Point of Systemic Runtime Failure
Evidence:
- Coordinated onset at `22:18:14–22:18:15` across coordinator, partitions, cross-chain, execution.
- `EPIPE` followed by `ECONNREFUSED` and stream retry exhaustion:
  - Coordinator: `output_coordinator.txt:396-465`
  - Cross-chain: `output_cross_chain_service.txt:119-179`
  - Execution: `output_execution_service.txt:277-344`
  - P1: `output_p1_service.txt:330-376`
  - P2: `output_p2_service.txt:358-427`

Interpretation:
- Redis dependency behavior is expected, but resilience ergonomics are weak: repetitive logs, partial empty error payloads, and no graceful degradation mode preserving minimum observability.

Impact:
- Full control-plane impairment.
- Hard debugging during outage windows.

### 3) Provider Rotation Recovers but Wastes Time on Deterministic 401 Failures
Evidence:
- P1 Polygon:
  - Disconnect: `output_p1_service.txt:217-223`
  - Fallback to Ankr then `401`: `output_p1_service.txt:224-258`
  - Switch to dRPC and recover: `output_p1_service.txt:290-303`
  - Data gap after recovery: `output_p1_service.txt:304-308`
- P2 Scroll:
  - Disconnect + Ankr fallback + `401`: `output_p2_service.txt:218-259`
  - dRPC recovery: `output_p2_service.txt:291-303`
  - Another disconnect, then PublicNode fallback: `output_p2_service.txt:314-334`
  - Data gaps: `output_p2_service.txt:304-307`, `339-343`

Measured outage windows from disconnect→reconnect:
- Polygon: ~12s
- Scroll: ~12s then ~6s

Interpretation:
- Auth failures (`401`) should be treated as hard endpoint/key incompatibility, not transient transport failures.

Impact:
- Extra blind intervals.
- Avoidable reconnect churn.

### 4) Execution Plane Is Running but Starved
Evidence:
- Stream consumer up: `output_execution_service.txt:76-83`
- Repeated periodic metrics all zero:
  - `simulationsPerformed: 0`
  - `transactionsSkippedBySimulation: 0`
  - `providerHealthy: {}`
  - `output_execution_service.txt:128-267`
- No opportunity/execution events observed in this window.

Interpretation:
- Either upstream opportunity publication is low/absent for this run, or there is a routing/stream-path gap between detectors/coordinator/execution.

Impact:
- No realized value despite services being nominally healthy.

### 5) Startup and Runtime Overhead Indicators
Evidence:
- Every service logs `MaxListenersExceededWarning` at startup:
  - coordinator/cross-chain/execution/p1/p2 line 6 in each file.
- Cross-chain ML warnings:
  - `tfjs` node backend warning: `output_cross_chain_service.txt:12-14`
  - Large orthogonal initializer warnings: `output_cross_chain_service.txt:15,73`
- Large shared memory config in partitions:
  - `SharedKeyRegistry bufferSize: 590557956` in P1/P2:
    - `output_p1_service.txt:183-187`
    - `output_p2_service.txt:188-192`

Interpretation:
- There are probable listener lifecycle leaks/duplication.
- ML stack in Node is not optimized for this environment.
- Partition memory provisioning appears over-allocated for local/dev scale.

Impact:
- Elevated baseline memory.
- Noisy startup diagnostics.
- Potential instability under extended uptime.

### 6) Security and Dev-Safety Gaps in Exposed Interfaces
Evidence:
- Coordinator API unprotected warning: `output_coordinator.txt:32`.
- Health servers bound to `0.0.0.0` without auth token in partitions:
  - `output_p1_service.txt:16-18`
  - `output_p2_service.txt:17-19`

Interpretation:
- Explicitly logged as non-production caveat, but still risky in shared/local-network environments.

Impact:
- Unnecessary attack surface in dev environments.

## Per-Service Snapshot

### Coordinator
- Strong startup completeness (consumer groups, leadership, HTTP) but high health/degradation noise.
- Most unstable component in this run from alert perspective.

### Cross-Chain Detector
- Stable health checks.
- ML initialized with performance warnings.
- No meaningful downstream opportunity activity visible in logs.

### Execution Engine
- Starts cleanly in simulation mode.
- No workload observed (all execution/simulation counters zero).
- Duplicate health check statuses (`not_configured` then `healthy`) add ambiguity/noise.

### P1 (Asia-Fast)
- Healthy baseline, active pair discovery.
- Polygon websocket auth-failure incident and recovery via fallback.
- One post-recovery data-gap warning.

### P2 (L2-Turbo)
- Healthy baseline, active pair discovery.
- Scroll websocket auth-failure incident and repeated reconnect events.
- Multiple data-gap warnings.

## Optimization and Enhancement Plan

## Priority P0 (Immediate)

1. **Harden coordinator stale-heartbeat handling**
- Ignore heartbeat events older than a strict freshness window on consume.
- Evict stale service records after configurable TTL without re-alerting every cycle.
- Add service identifier to stale-heartbeat warning payload.
- Add startup warm-up gate to suppress degradation transitions until fresh heartbeat quorum.

Expected impact: major reduction in false degradation transitions and alert noise.

2. **Treat websocket `401` as hard-auth failure**
- On first `401`, quarantine endpoint/provider+key combo for TTL (do not retry immediately).
- Skip exponential retries on same unauthorized endpoint.
- Emit one high-signal auth warning with provider/key context (masked).

Expected impact: faster recovery, fewer data gaps, lower reconnect churn.

3. **Improve Redis outage behavior and log signal quality**
- Normalize Redis error logging to include `code`, `errno`, and operation context consistently.
- Collapse repetitive identical errors into sampled/rate-limited summaries.
- Add coordinated “Redis unavailable mode” state and explicit transition logs.

Expected impact: clearer incident diagnosis and lower log noise during outages.

## Priority P1 (Near-Term)

4. **Add end-to-end throughput guardrails**
- Metrics chain: `price_updates -> opportunities -> execution_requests -> execution_results`.
- Alert when detectors are healthy but `execution_requests == 0` for N minutes.
- Track stream lag/depth for `stream:opportunities` and `stream:execution-requests`.

Expected impact: catches starvation/path regressions early.

5. **Fix global `MaxListenersExceededWarning` root cause**
- Trace listener registration path (`--trace-warnings` in dev CI run).
- Ensure singleton lifecycle and teardown for shutdown hooks and redis listeners.

Expected impact: prevents latent memory leak and event duplication risks.

6. **Gate optional subsystems by feature flags before initialization**
- Avoid initializing disabled subsystems (orderflow pipeline, commit-reveal contract clients).
- Reduce startup overhead and warning noise.

Expected impact: lower baseline memory and clearer logs.

7. **ML startup optimization for cross-chain detector**
- Use `@tensorflow/tfjs-node` backend or optional ML-disable mode for local dev.
- Persist and reload warmed model where possible.

Expected impact: lower startup latency and CPU overhead.

## Priority P2 (Medium-Term)

8. **Dev profile memory right-sizing**
- Dynamic `SharedKeyRegistry`/`PriceMatrix` sizing by active chain/pair targets.
- Introduce `LOCAL_DEV_MEMORY_PROFILE` with tighter caps.

Expected impact: significant memory savings in local multi-service runs.

9. **Security-by-default in dev scripts**
- Default health bind to `127.0.0.1`; require explicit opt-out for `0.0.0.0`.
- Add explicit env guard for unprotected coordinator routes in non-local environments.

Expected impact: reduced accidental exposure.

10. **Connectivity chaos tests in CI/dev smoke**
- Automated test for provider `401` fallback behavior.
- Redis interruption test to validate graceful degradation and recovery logs.

Expected impact: regression prevention for the exact failure patterns observed.

## Suggested KPI Dashboard Additions
- `coordinator.degradation_transitions_per_minute`
- `coordinator.stale_heartbeat_alerts_per_minute`
- `provider.auth_401_count{chain,provider}`
- `websocket.recovery_time_seconds{chain}`
- `redis.error_rate{service,code}`
- `pipeline.opportunities_to_execution_ratio`
- `execution.idle_minutes_while_detectors_healthy`

## Concrete Next Steps (Execution Order)
1. Ship coordinator stale-heartbeat and degradation-hysteresis fixes.
2. Ship provider `401` hard-fail + cooldown logic.
3. Ship Redis error normalization and outage-mode transitions.
4. Add pipeline starvation metrics and alerts.
5. Root-cause and eliminate `MaxListenersExceededWarning`.

## Notes on Existing Improvements
Recent local fixes already align with this analysis:
- Consumer-group offset reset behavior for coordinator helps avoid replaying stale stream backlog.
- New dev Redis clean command supports deterministic local reset.

