# Monitoring Pipeline Optimization v4.0 — Design Spec

**Date:** 2026-03-10
**Status:** Approved
**Scope:** `.claude/commands/monitoring.md` (4,369 lines, ~194KB) → modular split with auto-generated config

## Problem Statement

The monitoring pipeline command file has grown to 4,369 lines (~194KB, ~48,500 tokens), causing:

1. **Context window pressure:** Consumes 24% of Claude's context before any work begins. By Phase 3-4, context compression loses earlier findings.
2. **35 coupling points** to 8+ source files. Active drift found: Check 3N MAXLEN values wrong for exec-requests streams.
3. **~120 redundant curl calls** and **~130 unbatched redis-cli calls**, wasting 120-240s of execution time.
4. **Instruction density of 35%** — 65% of the file is documentation, formatting, and templates not needed during execution.
5. **Execution time ~365s (6.1 min)** with significant parallelism unexploited.

## Design

### Architecture: Modular Split + Auto-Generated Inventory + Compressed Checks

Split the monolith into a thin orchestrator hub (~100 lines) that loads phase-specific modules on-demand, with runtime-generated inventory from source code and externalized thresholds in config.json.

### File Layout

```
.claude/commands/
  monitoring.md                              (~100 lines)  Orchestrator hub
  monitoring/
    config.json                              (~80 lines)   Thresholds, go/no-go rules
    00-inventory-generator.md                (~80 lines)   Pre-flight: auto-gen from source
    01-preflight.md                          (~100 lines)  Session setup, data mode
    02-static-analysis.md                    (~500 lines)  Phase 1: 23 checks (compressed)
    03-startup.md                            (~200 lines)  Phase 2: Redis, services, readiness
    04-runtime.md                            (~800 lines)  Phase 3: 44 checks (compressed)
    05-smoke-test.md                         (~300 lines)  Phase 4: 12 steps (compressed)
    06-report.md                             (~200 lines)  Phase 5: shutdown, regression, template
                                            ─────────────
                                   Total:    ~2,360 lines (46% reduction)
```

### Component Details

#### 1. Orchestrator Hub (`monitoring.md`, ~100 lines)

The entry point loaded on `/monitoring`. Contains:
- Role definition and critical rules (no sub-agents, tool preferences)
- Severity legend for compact flag notation
- Finding format JSON schema (defined once, not per-phase)
- Phase execution order with Read instructions for each module
- Cross-phase references (session variables, finding file paths)

Does NOT contain: check definitions, System Inventory, report template, rationale.

#### 2. Auto-Generated Inventory (`00-inventory-generator.md`, ~80 lines)

Instructions for pre-flight to read source files and generate `./monitor-session/config/inventory.json`:

| Data | Source File | Extraction Method |
|------|------------|-------------------|
| Stream names (29) | `shared/types/src/events.ts` | Read, extract `RedisStreams` const |
| MAXLEN values (29) | `shared/core/src/redis/streams.ts` | Read, extract `STREAM_MAX_LENGTHS` |
| Service ports (11) | `shared/constants/service-ports.json` | Read JSON directly |
| Chain-to-partition (15 chains) | `shared/config/src/partitions.ts` | Read, extract `PARTITIONS` array |
| Feature flags (23) | `shared/config/src/feature-flags.ts` | Grep `FEATURE_` patterns |
| Consumer groups (7) | `services/` + `shared/core/` | Grep `consumerGroup` patterns |

Generated `inventory.json` structure:
```json
{
  "generated": "<ISO8601>",
  "streams": [
    { "name": "stream:price-updates", "maxLen": 100000, "producers": ["P1-P4"], "groups": ["coordinator-group", "cross-chain-detector-group"] }
  ],
  "services": [
    { "name": "coordinator", "port": 3000, "readyEndpoint": "/api/health/ready" }
  ],
  "partitions": [
    { "id": "asia-fast", "port": 3001, "chains": ["bsc", "polygon", "avalanche", "fantom"] }
  ],
  "consumerGroups": [...],
  "featureFlags": [...]
}
```

All downstream modules reference `inventory.json` instead of hardcoded values. Eliminates all 35 coupling points.

#### 3. Config (`config.json`, ~80 lines)

Externalized thresholds and decision rules:

```json
{
  "version": "4.0",
  "thresholds": {
    "eventLoopP99WarnMs": 20,
    "eventLoopP99CritMs": 50,
    "gcMajorWarn": 10,
    "rssMbCrit": 500,
    "heapRatioWarn": 0.85,
    "consumerLagWarn": 50,
    "consumerLagCrit": 100,
    "stuckMsgAgeSec": 30,
    "rpcP95WarnMs": 200,
    "rpcP95CritMs": 500,
    "transitP95WarnMs": 50,
    "transitP95CritMs": 100,
    "maxlenFillRatioWarn": 0.8,
    "maxlenFillRatioCrit": 0.9,
    "dlqGrowthRateHighPerSec": 1,
    "cbFlappingThreshold": 5,
    "smokeTestPollIntervalSec": 10,
    "smokeTestTimeoutSec": 60
  },
  "goNoGo": {
    "anyCritical": "NO-GO",
    "maxHighForGo": 3
  },
  "readinessTimeouts": {
    "default": 30,
    "partitionsLive": 60,
    "crossChain": 120,
    "crossChainLive": 180
  },
  "placeholderMetrics": [
    "circuit_breaker_transitions_total",
    "backpressure_episodes_total",
    "stream_ack_delay_ms",
    "stream_trimmed_messages_total",
    "pair_cache_hit_total"
  ]
}
```

Placeholder metrics list enables fast-path: skip curl/grep, emit INFO finding directly.

#### 4. Phase Modules (compressed check format)

Each check compressed using this pattern:

**Before (113 lines for Check 3AK):**
```
### Check 3AK — SSE Event Stream Connectivity & Data Shape

**Goal:** Verify the SSE endpoint is accessible and emitting data with correct
event types and data shapes. The dashboard depends entirely on SSE for real-time
data — if SSE is broken, all 8 tabs show "Waiting for data...".

**Method:**
1. Connect to the SSE endpoint and capture the first events...
[100 more lines of method, field listings, flag rules with long explanations]
```

**After (35 lines):**
```
### 3AK — SSE Connectivity & Data Shape

Connect to SSE, validate event types and field presence.

\```bash
TOKEN="${DASHBOARD_AUTH_TOKEN:-}"; URL="http://localhost:3000/api/events"
[ -n "$TOKEN" ] && URL="$URL?token=$TOKEN"
curl -sf -N --max-time 15 "$URL" 2>/dev/null | head -60 > ./monitor-session/findings/sse-capture.txt
\```

Validate events and required fields:

| Event | Timing | Required Fields |
|-------|--------|-----------------|
| `metrics` | immediate | systemHealth, totalExecutions, successfulExecutions, totalProfit, averageLatency, activeServices, totalOpportunities, opportunitiesDropped, lastUpdate |
| `services` | immediate | name, status, uptime, memoryUsage, cpuUsage (per entry) |
| `circuit-breaker` | immediate | state (CLOSED/OPEN/HALF_OPEN), consecutiveFailures, totalFailures, totalSuccesses, timestamp |
| `diagnostics` | 10s periodic | timestamp, pipeline.e2e{p50,p95,p99}, runtime.eventLoop{p50,p95,p99}, runtime.memory{heapUsedMB,rssMB}, providers.totalRpcErrors |

Flags:
- SSE non-200 or timeout → C:DASHBOARD_SSE
- SSE 401 → H:DASHBOARD_SSE
- metrics missing required field → H:DASHBOARD_SSE
- services missing name/status → H:DASHBOARD_SSE
- circuit-breaker missing state → H:DASHBOARD_SSE
- diagnostics missing pipeline/runtime/providers → H:DASHBOARD_SSE
- No metrics within 10s → H:DASHBOARD_SSE
- No diagnostics within 15s → M:DASHBOARD_SSE
- All correct → I:DASHBOARD_SSE
```

**Compression ratio: 69%.** Applied across all 79 checks.

#### 5. Endpoint Caching (O-01)

Phase 3 start fetches all endpoints once:

```bash
mkdir -p ./monitor-session/config/cache
for port in 3000 3001 3002 3003 3004 3005 3006; do
  curl -sf --max-time 10 http://localhost:$port/health > ./monitor-session/config/cache/health_$port.json 2>/dev/null &
  curl -sf --max-time 10 http://localhost:$port/stats > ./monitor-session/config/cache/stats_$port.json 2>/dev/null &
  curl -sf --max-time 10 http://localhost:$port/metrics > ./monitor-session/config/cache/metrics_$port.txt 2>/dev/null &
done
curl -sf --max-time 10 http://localhost:3000/api/metrics/prometheus > ./monitor-session/config/cache/prom_3000.txt 2>/dev/null &
curl -sf --max-time 10 http://localhost:3000/api/diagnostics > ./monitor-session/config/cache/diagnostics.json 2>/dev/null &
curl -sf --max-time 10 http://localhost:3000/api/leader > ./monitor-session/config/cache/leader.json 2>/dev/null &
wait
```

All subsequent checks read from `./monitor-session/config/cache/` files. Cache is stale after 30s — re-fetch only for Phase 4 post-smoke comparisons.

Savings: ~95 curl calls eliminated.

#### 6. Redis Command Batching

Replace ~130 individual `redis-cli` calls with piped batches:

```bash
# Stream inventory batch (replaces Check 3I's 29x2 loop + 3N's 12 XLENs)
redis-cli << 'BATCH'
XINFO STREAM stream:price-updates
XINFO GROUPS stream:price-updates
XLEN stream:price-updates
... (for all streams from inventory.json)
BATCH
```

Reduces agent round-trips from ~130 to ~10.

#### 7. Check Reclassifications

| Check | Current Phase | Move To | Reason |
|-------|-------------|---------|--------|
| 1W (Redis Access) | Phase 1 (static) | Phase 2 (after Redis start) | Needs redis-cli |
| 3AL (SSE Coverage) | Phase 3 (runtime) | Phase 1 (static) | Only uses Read/Grep |
| 3AM (Type Sync) | Phase 3 (runtime) | Phase 1 (static) | Only uses Read |

#### 8. Execution Optimizations

| Optimization | Time Saved |
|-------------|-----------|
| Phase 1 parallel tool batching (5 rounds of ~5 parallel calls) | 35s |
| Phase 1/2 overlap (already documented) | 30s |
| 3AH first scrape at Phase 2D baseline; 15s sleep eliminated | 15s |
| O-01 endpoint caching (95 fewer curl calls) | 19s |
| Redis batching (130→10 agent round-trips) | 60s+ |
| Placeholder metrics fast-path (5 checks skip curl/grep) | 20s |
| Phase 4B early exit (all streams growing → stop polling) | 30s |
| Phase 4 steps 4C-4L parallelized after 4B | 15s |

### Context Window Budget

| Scenario | Tokens | % of 200K |
|----------|--------|-----------|
| Current: monolith | ~48,500 | 24% |
| Proposed: hub only | ~2,500 | 1.3% |
| Proposed: hub + current phase module | ~12,000-22,000 | 6-11% |
| Context freed for tool results | ~26,500+ | 13%+ |

### Expected Outcomes

| Metric | Current | Target |
|--------|---------|--------|
| Total lines | 4,369 | <2,400 (across all modules) |
| Context tokens (peak) | ~48,500 | <22,000 |
| Execution time | ~365s | <200s |
| Coupling points | 35 | 0 |
| Instruction density | 35% | >60% |
| Inventory drift bugs | Active (Check 3N) | Impossible (auto-generated) |

### Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Claude loses context between phase reads | LOW | MED | Cross-phase data (finding format, severity legend, session vars) stays in hub |
| Auto-generated inventory misses edge cases | LOW | LOW | Validate counts against config.json expected minimums |
| Compressed checks miss nuance | LOW | LOW | Keep critical notes inline; move rationale to git-tracked reference file |
| Module file not found during execution | VERY LOW | HIGH | Pre-flight validates all module files exist |

### Migration Path

1. Create config.json and module directory structure
2. Build inventory auto-generator (pre-flight reads source files)
3. Compress Phase 1 checks into 02-static-analysis.md
4. Compress Phase 3 checks into 04-runtime.md with cached endpoint references
5. Compress Phase 4 into 05-smoke-test.md with batched redis
6. Compress Phase 5 into 06-report.md
7. Build orchestrator hub with severity legend and phase loading
8. Validate: run full pipeline on the new modular structure
9. Delete old monolithic monitoring.md

### Out of Scope

- Changing what the pipeline checks (no new checks, no removed checks)
- Modifying service code or endpoints
- Changing the JSONL finding format or report structure
- Automation of config.json threshold tuning
