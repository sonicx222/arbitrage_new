# Autopilot: Autonomous Optimization Loop
# Version: 1.0
#
# Fully autonomous detect-fix-validate loop.
# Dispatches 12 specialized agents (all Opus 4.6) across up to 5 cycles.
# Produces git commits per cycle and a final optimization report.
# Time budget: 1-2 hours. Converges when no fixable findings remain.
#
# Separate from monitoring.md (quick pre-deploy validation).
# This is the heavy-duty autonomous optimization tool.

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# ORCHESTRATOR ROLE
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You are the **ORCHESTRATOR** of an autonomous optimization loop for this multi-chain
arbitrage trading system. Your job is to drive continuous improvement through
repeated cycles of analysis, triage, fixing, and validation — with zero human
intervention once started.

## Loop Structure

```
PHASE 0: Bootstrap
  ├── Verify prerequisites (Redis, build, services)
  ├── Record start time, initialize cycle counter
  └── Establish baseline (typecheck, test snapshot, service health)

CYCLE 1..5: Detect → Fix → Validate
  ├── ANALYZE:   Dispatch analysis agents (up to 10 in parallel)
  ├── TRIAGE:    Collect findings, deduplicate, rank by severity
  ├── FIX:       Dispatch fix-implementer agent with fix manifest
  ├── REBUILD:   npm run build, npm run typecheck
  ├── VALIDATE:  Dispatch regression-guard agent to verify fixes
  ├── COMMIT:    Git commit with cycle summary
  └── CONVERGE:  If no fixable findings remain → exit loop

PHASE FINAL: Report
  ├── Aggregate all findings across all cycles
  ├── Compute delta from baseline
  ├── Write optimization report to docs/reports/
  └── Final git commit with report
```

Each cycle narrows the finding set. The loop converges when:
- No CRITICAL or HIGH fixable findings remain, OR
- 5 cycles have been completed, OR
- The time budget (110 minutes) is exhausted.


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# CRITICAL RULES
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You MUST follow ALL of these rules without exception:

1. **ALL agents MUST be spawned with `model: "opus"` explicitly.**
   Never rely on defaults. Agents spawned without `model: "opus"` will use a
   weaker model that cannot handle the complexity of this codebase.

2. **ALL agent prompts MUST start with the SendMessage report-back instruction.**
   The very first line of every agent prompt must instruct the agent to report
   results back via SendMessage. Agents that complete without reporting are
   invisible to the orchestrator.

3. **Agent prompts MUST be under 300 lines.**
   Summarize shared context. Do not copy entire command files or large code
   blocks into agent prompts verbatim.

4. **2-minute stall timeout per agent.**
   If an agent has not responded within 2 minutes, do NOT send nudge messages.
   Self-execute the agent's work directly instead.

5. **Do NOT skip phases or cycles.**
   Every cycle must complete all steps (analyze, triage, fix, rebuild, validate,
   commit) even if some steps are no-ops.

6. **If Phase 0 fails catastrophically, skip to PHASE FINAL.**
   A catastrophic failure is: Redis unreachable, build broken with >10 errors,
   or services cannot start at all. Record the failure and produce the report.

7. **Track wall-clock time. Exit if elapsed > 110 minutes (TIME_LIMIT).**
   Check elapsed time at the start of each cycle. If remaining time < 15 minutes,
   skip to PHASE FINAL instead of starting a new cycle.

8. **Use `curl` for HTTP requests, `redis-cli` for Redis commands.**
   Do not use Node.js scripts or fetch() for health checks or Redis inspection.

9. **Use Glob/Grep/Read for file analysis (NOT grep/find bash commands).**
   The dedicated tools provide better output formatting and avoid shell escaping
   issues on Windows.

10. **Findings use structured JSONL format.**
    All agent findings must conform to the Finding Format Reference below.
    Non-conforming findings are discarded during triage.

**Available Tools:** Bash, Glob, Grep, Read, Write, Edit, TeamCreate, Task, SendMessage.


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SYSTEM INVENTORY
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## Services (7 via `npm run dev:all`)

| Service | Port | Ready Endpoint | Role |
|---------|------|----------------|------|
| Coordinator | 3000 | `/api/health/ready` | Orchestration, leader election, opportunity routing |
| P1 Asia-Fast | 3001 | `/ready` | Chain detector: BSC, Polygon, Avalanche, Fantom |
| P2 L2-Turbo | 3002 | `/ready` | Chain detector: Arbitrum, Optimism, Base, Blast, Scroll |
| P3 High-Value | 3003 | `/ready` | Chain detector: Ethereum, zkSync, Linea |
| P4 Solana | 3004 | `/ready` | Chain detector: Solana |
| Execution Engine | 3005 | `/ready` | Trade execution, flash loans, MEV protection |
| Cross-Chain | 3006 | `/ready` | Cross-chain arbitrage detection |

## Redis Streams (29 declared in `shared/types/src/events.ts`)

| Stream | MAXLEN | Producer(s) | Consumer Group(s) |
|--------|--------|-------------|-------------------|
| `stream:price-updates` | 100,000 | P1-P4 Partitions | coordinator-group, cross-chain-detector-group |
| `stream:swap-events` | 50,000 | P1-P4 Partitions | coordinator-group |
| `stream:opportunities` | 500,000 | Detectors (via partitions) | coordinator-group |
| `stream:whale-alerts` | 5,000 | P1-P4 Partitions | coordinator-group, cross-chain-detector-group |
| `stream:service-health` | 1,000 | All services | Coordinator |
| `stream:service-events` | 5,000 | All services | Coordinator |
| `stream:coordinator-events` | 5,000 | Coordinator | — |
| `stream:health` | 1,000 | Health monitors | coordinator-group |
| `stream:health-alerts` | 5,000 | Health monitors | — |
| `stream:execution-requests` | 100,000 | Coordinator | execution-engine-group |
| `stream:execution-results` | 100,000 | Execution Engine | coordinator-group |
| `stream:exec-requests-fast` | 25,000 | Coordinator (chain-group) | execution-engine-group |
| `stream:exec-requests-l2` | 25,000 | Coordinator (chain-group) | execution-engine-group |
| `stream:exec-requests-premium` | 25,000 | Coordinator (chain-group) | execution-engine-group |
| `stream:exec-requests-solana` | 10,000 | Coordinator (chain-group) | execution-engine-group |
| `stream:pre-simulated` | 25,000 | Coordinator (pre-sim) | execution-engine-group |
| `stream:pending-opportunities` | 10,000 | Coordinator | cross-chain-detector-group, mempool-detector-group, orderflow-pipeline |
| `stream:volume-aggregates` | 10,000 | P1-P4 Partitions | coordinator-group |
| `stream:circuit-breaker` | 5,000 | Circuit breaker monitors | — |
| `stream:system-failover` | 1,000 | Coordinator | failover-{serviceName} |
| `stream:system-commands` | 1,000 | Coordinator | — |
| `stream:fast-lane` | 5,000 | Coordinator (priority) | execution-engine-group |
| `stream:dead-letter-queue` | 10,000 | All services (error path) | coordinator-group |
| `stream:dlq-alerts` | 5,000 | DLQ processor | — |
| `stream:forwarding-dlq` | 5,000 | Forwarding failures | coordinator-group |
| `stream:system-failures` | 5,000 | All services (failure path) | self-healing-manager |
| `stream:system-control` | 1,000 | Coordinator | self-healing-manager |
| `stream:system-scaling` | 1,000 | Auto-scaler | self-healing-manager |
| `stream:service-degradation` | 5,000 | Health monitors | — |

## Consumer Groups (7 active)

| Group | Service | Streams |
|-------|---------|---------|
| coordinator-group | Coordinator | health, opportunities, whale-alerts, swap-events, volume-aggregates, price-updates, execution-results, dead-letter-queue, forwarding-dlq |
| cross-chain-detector-group | Cross-Chain Detector | price-updates, whale-alerts, pending-opportunities |
| execution-engine-group | Execution Engine | execution-requests, fast-lane, exec-requests-fast, exec-requests-l2, exec-requests-premium, exec-requests-solana, pre-simulated |
| mempool-detector-group | Mempool Detector | pending-opportunities |
| orderflow-pipeline | Coordinator (orderflow) | pending-opportunities |
| self-healing-manager | Self-Healing Manager | system-failures, system-control, system-scaling (dynamic) |
| failover-{serviceName} | Coordinator (failover) | system-failover (dynamic) |

## Pipeline Data Flow

```
P1-P4 Partitions → stream:price-updates → Detectors → stream:opportunities
    → Coordinator (validates, deduplicates) → stream:execution-requests
    → Execution Engine (executes) → stream:execution-results
    → Coordinator (records outcome)
```


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# FINDING FORMAT REFERENCE
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

All agents MUST report findings in this structured JSONL format. Each finding is
one JSON object per line. Non-conforming findings are discarded during triage.

```json
{
  "id": "XX-NNN",
  "agent": "agent-name",
  "cycle": 1,
  "severity": "CRITICAL|HIGH|MEDIUM|LOW",
  "category": "CATEGORY_NAME",
  "title": "Short description",
  "file": "path/to/file.ts",
  "line": 42,
  "evidence": "What was found",
  "expected": "What should be",
  "actual": "What is",
  "fixable": true,
  "fix_hint": "How to fix it",
  "domain_tags": ["domain1", "domain2"]
}
```

### Field Descriptions

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Agent prefix + sequential number (e.g., `SA-001`, `SH-003`) |
| `agent` | Yes | Agent name from the roster below |
| `cycle` | Yes | Cycle number (1-5) when the finding was discovered |
| `severity` | Yes | One of: `CRITICAL`, `HIGH`, `MEDIUM`, `LOW` |
| `category` | Yes | Category tag (e.g., `STREAM_CONFIG`, `ENV_DRIFT`, `TYPE_SAFETY`) |
| `title` | Yes | Concise one-line description |
| `file` | Yes | Relative path from repo root |
| `line` | No | Line number in the file (0 if not applicable) |
| `evidence` | Yes | What was observed |
| `expected` | Yes | What the correct state should be |
| `actual` | Yes | What the current state is |
| `fixable` | Yes | `true` if an automated fix can be applied, `false` otherwise |
| `fix_hint` | No | Brief description of how to fix (required if `fixable: true`) |
| `domain_tags` | No | Array of domain tags for cross-referencing |


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# AGENT ROSTER REFERENCE
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

12 specialized agents, all spawned with `model: "opus"`.

| # | Name | Type | Domain |
|---|------|------|--------|
| 1 | static-analyst | Analysis | Code quality, stream declarations, ADR compliance |
| 2 | service-health-monitor | Analysis | Health endpoints, leader election, schema |
| 3 | streams-analyst | Analysis | Redis Streams topology, lag, DLQ |
| 4 | performance-profiler | Analysis | Event loop, GC, memory |
| 5 | detection-analyst | Analysis | Per-chain detection, cycle timing, staleness |
| 6 | execution-analyst | Analysis | Success rates, outcomes, slippage, gas |
| 7 | security-config-auditor | Analysis | Env vars, HMAC, feature flags, risk config |
| 8 | infra-auditor | Analysis | Docker, Fly.io, ports, timeouts |
| 9 | dashboard-validator | Analysis | SPA, SSE, REST, type sync, metrics |
| 10 | e2e-flow-tracer | Analysis | Full pipeline trace, partition flow |
| 11 | fix-implementer | Fix | Apply code/config fixes from manifest |
| 12 | regression-guard | Validate | Verify fixes, check for regressions |

### Agent Grouping by Phase

**Analysis Phase (Cycle Step: ANALYZE):** Agents 1-10 run in parallel.
- Agents 1-4: Infrastructure & code quality sweep
- Agents 5-6: Detection & execution pipeline analysis
- Agents 7-8: Security & infrastructure audit
- Agents 9-10: Dashboard & end-to-end flow validation

**Fix Phase (Cycle Step: FIX):** Agent 11 runs alone with the triage manifest.

**Validation Phase (Cycle Step: VALIDATE):** Agent 12 runs alone to verify fixes.


## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## PHASE 0 — BOOTSTRAP (~3 minutes)
## Build, start Redis + services, capture baseline state.
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

### Step 0A — Create session workspace

```bash
mkdir -p ./autopilot-session/{baseline,logs}
mkdir -p ./autopilot-session/cycle-1/findings
SESSION_ID=$(date +%Y%m%d_%H%M%S)
echo $SESSION_ID > ./autopilot-session/SESSION_ID
CURRENT_SHA=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
echo $CURRENT_SHA > ./autopilot-session/current.sha
START_TIME=$(date +%s)
echo $START_TIME > ./autopilot-session/start-time.txt
echo "Session $SESSION_ID initialized (git SHA: $CURRENT_SHA)"
```

Initialize session config:
```json
// Write to ./autopilot-session/config.json
{
  "session_id": "<SESSION_ID>",
  "start_sha": "<CURRENT_SHA>",
  "max_cycles": 5,
  "time_limit_minutes": 110,
  "max_fixes_per_cycle": 15,
  "max_lines_per_cycle": 500
}
```

---

### Step 0B — Build all packages

```bash
npm run build
```

If build fails:
```bash
echo "Incremental build failed, trying clean build..."
npm run build:clean
```

If clean build also fails → Record as **CRITICAL** finding, skip to PHASE FINAL.

---

### Step 0C — Start Redis

```bash
npm run dev:redis:memory &
sleep 3
redis-cli PING
```

If PING fails → **CRITICAL** finding. Skip to PHASE FINAL — nothing works without Redis.

Verify stream command support:
```bash
redis-cli COMMAND INFO XADD XREAD XREADGROUP XPENDING XINFO XACK XLEN XCLAIM
```

If any stream command unsupported → **CRITICAL**. Report Redis version mismatch.

---

### Step 0D — Start services

```bash
npm run dev:monitor &
echo $! > ./autopilot-session/services.pid
```

This starts all 7 services in simulation mode with memory-optimized settings:
`CONSTRAINED_MEMORY=true`, `WORKER_POOL_SIZE=1`, `CACHE_L1_SIZE_MB=8`,
`SIMULATION_REALISM_LEVEL=high`.

---

### Step 0E — Poll readiness (service-specific timeouts)

Poll each service's ready endpoint every 5 seconds:

| Service | Port | Endpoint | Timeout | Reason |
|---------|------|----------|---------|--------|
| Coordinator | 3000 | `/api/health/ready` | 30s | Standard |
| P1 Asia-Fast | 3001 | `/ready` | 30s | Standard |
| P2 L2-Turbo | 3002 | `/ready` | 30s | Standard |
| P3 High-Value | 3003 | `/ready` | 30s | Standard |
| P4 Solana | 3004 | `/ready` | 30s | Standard |
| Execution Engine | 3005 | `/ready` | 30s | Standard |
| Cross-Chain | 3006 | `/ready` | **120s** | Needs partition price data first |

```bash
# Example polling loop per service:
for port_path in "3000:/api/health/ready:30" "3001:/ready:30" "3002:/ready:30" \
  "3003:/ready:30" "3004:/ready:30" "3005:/ready:30" "3006:/ready:120"; do
  PORT=$(echo $port_path | cut -d: -f1)
  PATH_PART=$(echo $port_path | cut -d: -f2)
  TIMEOUT=$(echo $port_path | cut -d: -f3)
  ELAPSED=0
  while [ $ELAPSED -lt $TIMEOUT ]; do
    STATUS=$(curl -sf -o /dev/null -w "%{http_code}" http://localhost:$PORT$PATH_PART 2>/dev/null || echo "000")
    if [ "$STATUS" = "200" ]; then echo "Port $PORT: READY"; break; fi
    sleep 5
    ELAPSED=$((ELAPSED + 5))
  done
  if [ $ELAPSED -ge $TIMEOUT ]; then echo "Port $PORT: FAILED (timeout ${TIMEOUT}s)"; fi
done
```

**Failure handling:**
- Any non-cross-chain service not ready after 30s → Record **CRITICAL** finding.
- Cross-chain not ready after 120s → Record **HIGH** finding.
- Continue with remaining services regardless.

---

### Step 0F — Capture baseline state

**Stream baseline:**
```bash
redis-cli --scan --pattern 'stream:*' > ./autopilot-session/baseline/streams-discovered.txt

for stream in $(cat ./autopilot-session/baseline/streams-discovered.txt); do
  echo "=== $stream ===" >> ./autopilot-session/baseline/streams-raw.txt
  redis-cli XINFO STREAM $stream >> ./autopilot-session/baseline/streams-raw.txt
  redis-cli XINFO GROUPS $stream >> ./autopilot-session/baseline/streams-raw.txt
  redis-cli XLEN $stream >> ./autopilot-session/baseline/streams-raw.txt
done
```

**Service health baseline:**
```bash
for port in 3000 3001 3002 3003 3004 3005 3006; do
  if [ $port -eq 3000 ]; then
    curl -sf http://localhost:$port/api/health 2>/dev/null >> ./autopilot-session/baseline/health-all.txt
  else
    curl -sf http://localhost:$port/health 2>/dev/null >> ./autopilot-session/baseline/health-all.txt
  fi
done
```

**Service stats baseline:**
```bash
for port in 3001 3002 3003 3004 3005; do
  curl -sf http://localhost:$port/stats 2>/dev/null >> ./autopilot-session/baseline/stats-all.txt
done
```

**Prometheus metrics baseline:**
```bash
for port in 3001 3002 3003 3004 3005 3006; do
  curl -sf http://localhost:$port/metrics 2>/dev/null >> ./autopilot-session/baseline/metrics-t0.txt
done
curl -sf http://localhost:3000/api/metrics/prometheus 2>/dev/null >> ./autopilot-session/baseline/metrics-t0.txt
```

**Redis memory baseline:**
```bash
redis-cli INFO memory > ./autopilot-session/baseline/redis-memory.txt
```

**Unit test baseline:**
```bash
# Record current test failure count for regression comparison
npm run test:unit 2>&1 | tail -20 > ./autopilot-session/baseline/test-baseline.txt
```

Output:
```
PHASE 0 COMPLETE — Bootstrap
  Build: SUCCESS
  Redis: CONNECTED
  Services ready: <n>/7 (list)
  Services failed: <n> (list)
  Streams discovered: <n>
  Baseline captured: YES
  Elapsed: <n> seconds
```

---

<!-- Cycle Loop, Agent Prompts, Triage, Fix, Rebuild, Validate, Converge, and Report sections follow -->
