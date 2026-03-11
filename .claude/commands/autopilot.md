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
`CONSTRAINED_MEMORY=true`, `WORKER_POOL_SIZE=1`, `CACHE_L1_SIZE_MB=8`.

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

## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## CYCLE LOOP — Up to 5 iterations
## Each cycle: Analyze → Triage → Fix → Rebuild → Validate → Commit
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Initialize cycle tracking:
```
CYCLE=1
CONSECUTIVE_REVERTS=0
```

### ═══ FOR CYCLE = 1 TO 5 ═══

### Pre-Cycle Checks

Before starting each cycle, verify these conditions:

**1. Time check:**
```bash
CURRENT_TIME=$(date +%s)
START_TIME=$(cat ./autopilot-session/start-time.txt)
ELAPSED_MIN=$(( (CURRENT_TIME - START_TIME) / 60 ))
if [ $ELAPSED_MIN -gt 110 ]; then
  echo "TIME_LIMIT: ${ELAPSED_MIN} minutes elapsed (limit: 110)"
  # → Exit to PHASE FINAL with exit_reason=TIME_LIMIT
fi
```

**2. Consecutive revert check:**
If CONSECUTIVE_REVERTS >= 2 → Exit to PHASE FINAL with exit_reason=STUCK.

**3. Create cycle directory:**
```bash
mkdir -p ./autopilot-session/cycle-${CYCLE}/findings
```

**4. Determine agents to dispatch:**

- **Cycle 1:** Dispatch ALL 10 analysis agents (full scan).
- **Cycles 2-5:** Read `./autopilot-session/cycle-$((CYCLE-1))/dirty-domains.json`.
  Only dispatch agents listed in `dirty_domains` array, plus ALWAYS include `e2e-flow-tracer`.

---

### STEP 1 — ANALYZE (parallel agent dispatch)

Create an agent team for this cycle:
```
TeamCreate: name="autopilot-cycle-${CYCLE}"
```

Dispatch all required agents in a **SINGLE message with parallel Task calls**.
Each agent Task MUST include:
- `team_name`: `"autopilot-cycle-${CYCLE}"`
- `model`: `"opus"` (MANDATORY — never rely on defaults)
- `subagent_type`: `"general-purpose"`
- The agent-specific prompt from the Agent Prompts section below

**Template for each Task call:**
```
Task:
  team_name: "autopilot-cycle-${CYCLE}"
  model: "opus"
  subagent_type: "general-purpose"
  prompt: |
    CRITICAL: When you finish your analysis, you MUST use the SendMessage tool
    to send your findings back to the team lead. Your text output is NOT visible
    to the team lead — only SendMessage delivers your results.

    You are the {AGENT_NAME} in autopilot cycle {CYCLE}.
    Write findings to: ./autopilot-session/cycle-{CYCLE}/findings/{agent-name}.jsonl

    {AGENT-SPECIFIC INSTRUCTIONS — see Agent Prompts section}
```

**Stall handling:**
Wait for all agents to report back via SendMessage. If any agent has not
reported back within **2 minutes**, stop waiting and self-execute that agent's
work directly as the orchestrator. Note in the cycle summary:
"Agent {name} analysis executed by orchestrator (agent unresponsive)".

After all agents complete (or are self-executed), proceed to STEP 2.

---

### STEP 2 — TRIAGE

(See TRIAGE section below)

---

### STEP 3 — FIX

(See FIX IMPLEMENTER section below)

---

### STEP 4 — REBUILD & RESTART

(See REBUILD section below)

---

### STEP 5 — VALIDATE

(See REGRESSION GUARD section below)

---

### STEP 6 — COMMIT & CONVERGE

(See CONVERGENCE section below)

---

### Post-Cycle

After Step 6, check if an exit condition was triggered:
- If exit condition met → Break loop, proceed to PHASE FINAL.
- If no exit condition → Increment CYCLE, reset CONSECUTIVE_REVERTS if this cycle was not reverted, continue loop.

### ═══ END CYCLE LOOP ═══

## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## AGENT PROMPTS — 10 Analysis Agents
## Each agent is dispatched with model: "opus", subagent_type: "general-purpose"
## Agent prompts below are templates — replace {CYCLE} with actual cycle number
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


### Agent 1: static-analyst

```
model: "opus"
subagent_type: "general-purpose"
```

**Prompt:**

```
CRITICAL: When you finish your analysis, you MUST use the SendMessage tool
to send your findings back to the team lead. Your text output is NOT visible
to the team lead — only SendMessage delivers your results.

You are the STATIC-ANALYST in autopilot cycle {CYCLE}.
Write findings as JSONL to: ./autopilot-session/cycle-{CYCLE}/findings/static-analyst.jsonl

Use ONLY Glob, Grep, and Read tools — no Bash, no running services needed.
Finding ID prefix: SA-

Each finding is one JSON line with fields:
  id, agent("static-analyst"), cycle({CYCLE}), severity, category, title,
  file, line, evidence, expected, actual, fixable, fix_hint, domain_tags

CHECKS:

1. STREAM_DECLARATION [HIGH]
   Grep for xadd|xReadGroup|createConsumerGroup in *.ts files under services/ and shared/.
   Exclude node_modules and test files (*test*, *spec*, *__tests__*).
   Flag any hardcoded stream name string (e.g., "stream:price-updates") that is NOT
   referencing a constant from shared/types/src/events.ts or shared/constants/.
   Each hardcoded stream name = one HIGH finding.

2. MAXLEN_BYPASS [CRITICAL]
   Grep for raw this\.xadd\( or redis\.xadd\( or client\.xadd\( calls that are NOT
   inside xaddWithLimit(). Any direct xadd() call bypassing xaddWithLimit() means
   the MAXLEN cap is not enforced → CRITICAL.

3. MISSING_ACK [HIGH]
   Find files that contain xReadGroup but do NOT contain xack in the same file.
   Each such file = one HIGH finding (messages read but never acknowledged).

4. ANTI_PATTERN [LOW]
   Grep for `|| 0[^n]` and `|| 0n` in *.ts files (exclude node_modules).
   Per CLAUDE.md, use ?? instead of || for numeric defaults.
   Each occurrence = LOW finding.

5. SILENT_ERROR [HIGH/LOW]
   Grep for empty catch blocks: `catch\s*\([^)]*\)\s*\{\s*\}` in services/ and shared/
   (exclude test files). If the file is in a hot-path directory (price-matrix, partitioned-
   detector, execution-engine, unified-detector, redis/stream) → HIGH. Otherwise → LOW.

6. STREAM_TYPE_FIDELITY [HIGH]
   Read shared/core/src/redis/stream-serialization.ts (or equivalent).
   Check for .toString() on numeric fields during serialization. Verify that
   deserialization uses parseFloat/parseInt to restore types. If numeric fields
   are serialized as strings but never parsed back → HIGH.

7. ADR_COMPLIANCE [HIGH/MEDIUM]
   a. ADR-022: Grep for spread operator (\.\.\.) inside loops (for/while/map/forEach/reduce)
      in hot-path files (price-matrix.ts, partitioned-detector.ts, execution-engine/,
      unified-detector/). Spread in hot-path loop → HIGH.
   b. ADR-033: Read the stale price threshold config. If hardcoded and != 30000ms → HIGH.
   c. ADR-002: Grep for axios|fetch|http\.request in services/ inter-service calls
      (not external APIs). Inter-service HTTP → HIGH.
   d. ADR-018: Read circuit breaker config. If threshold != 5 → HIGH.
   e. ADR-005: Read price-matrix.ts. If SharedArrayBuffer is not used → HIGH.

After completing all checks, write findings to the JSONL file.
SendMessage findings summary to team lead when done.
```

---

### Agent 2: service-health-monitor

```
model: "opus"
subagent_type: "general-purpose"
```

**Prompt:**

```
CRITICAL: When you finish your analysis, you MUST use the SendMessage tool
to send your findings back to the team lead. Your text output is NOT visible
to the team lead — only SendMessage delivers your results.

You are the SERVICE-HEALTH-MONITOR in autopilot cycle {CYCLE}.
Write findings as JSONL to: ./autopilot-session/cycle-{CYCLE}/findings/service-health-monitor.jsonl

Use Bash (curl, redis-cli) and Read tools.
Finding ID prefix: SH-

Each finding is one JSON line with fields:
  id, agent("service-health-monitor"), cycle({CYCLE}), severity, category, title,
  file, line, evidence, expected, actual, fixable, fix_hint, domain_tags

CHECKS:

1. SERVICE_HEALTH [CRITICAL/HIGH]
   curl -sf each service health endpoint with 5s timeout:
     - localhost:3000/api/health (coordinator — note different path)
     - localhost:3001/health through localhost:3006/health
   Parse JSON response. Check "status" field:
     - "unhealthy" → CRITICAL
     - "degraded" → HIGH
     - Connection refused / timeout → CRITICAL (service unreachable)
     - "healthy" → OK (no finding)
   Record response time for each service.

2. LEADER_ELECTION [CRITICAL/HIGH]
   a. curl -sf localhost:3000/api/leader — check isLeader field.
      isLeader=false → CRITICAL (no active leader, system cannot route).
   b. redis-cli GET coordinator:leader:lock — should return a value.
      Empty/nil → CRITICAL (lock missing).
   c. redis-cli TTL coordinator:leader:lock — should be >5.
      TTL < 5 → HIGH (lock about to expire, risk of leadership gap).
      TTL = -1 → HIGH (no expiry set, lock will persist forever).
      TTL = -2 → CRITICAL (key does not exist).

3. HEALTH_SCHEMA [HIGH/MEDIUM]
   For each /health response, validate required fields:
     - "status" (string): must be present → HIGH if missing
     - "uptime" (number): must be present and > 0 → HIGH if missing
   Type checks:
     - "status" must be string → MEDIUM if wrong type
     - "uptime" must be number → MEDIUM if wrong type

4. SERVICE_READY [HIGH]
   a. curl -sf each ready endpoint:
      - localhost:3000/api/health/ready (coordinator — note different path)
      - localhost:3001/ready through localhost:3006/ready
      Non-200 response → HIGH.
   b. curl -sf each metrics endpoint:
      - localhost:3000/api/metrics/prometheus (coordinator — note different path)
      - localhost:3001/metrics through localhost:3006/metrics
      Non-200 response → HIGH.

5. SERVICE_HEALTH (detail) [HIGH/MEDIUM]
   From coordinator /api/health response, extract systemHealth score (0-100).
   Score < 50 → HIGH (system severely degraded).
   Score < 70 → MEDIUM (system health concerning).

After completing all checks, write findings to the JSONL file.
SendMessage findings summary to team lead when done.
```

---

### Agent 3: streams-analyst

```
model: "opus"
subagent_type: "general-purpose"
```

**Prompt:**

```
CRITICAL: When you finish your analysis, you MUST use the SendMessage tool
to send your findings back to the team lead. Your text output is NOT visible
to the team lead — only SendMessage delivers your results.

You are the STREAMS-ANALYST in autopilot cycle {CYCLE}.
Write findings as JSONL to: ./autopilot-session/cycle-{CYCLE}/findings/streams-analyst.jsonl

Use Bash (redis-cli, curl) and Read tools.
Finding ID prefix: ST-

Each finding is one JSON line with fields:
  id, agent("streams-analyst"), cycle({CYCLE}), severity, category, title,
  file, line, evidence, expected, actual, fixable, fix_hint, domain_tags

EXPECTED STREAMS (29 total — see System Inventory in this command for full list).
Active streams (always present): price-updates, swap-events, opportunities,
  execution-requests, execution-results, service-health, service-events,
  coordinator-events, health, health-alerts, dead-letter-queue, forwarding-dlq,
  dlq-alerts, pending-opportunities.
On-demand streams (created when chain-group routing or other features enabled):
  exec-requests-fast, exec-requests-l2, exec-requests-premium, exec-requests-solana,
  pre-simulated, fast-lane, whale-alerts, volume-aggregates, circuit-breaker,
  system-failover, system-commands, system-failures, system-control,
  system-scaling, service-degradation.

CHECKS:

1. STREAM_TOPOLOGY [HIGH/MEDIUM/CRITICAL]
   a. redis-cli --scan --pattern 'stream:*' to discover all streams.
   b. For each discovered stream: XINFO STREAM, XINFO GROUPS, XLEN.
   c. Compare discovered streams against the 29 expected.
      Active stream missing → HIGH.
      On-demand stream missing → MEDIUM (only if feature is enabled).
   d. For each stream with consumer groups:
      Consumer group missing (expected but not present) → HIGH.
      Group has 0 consumers → CRITICAL (created but nobody reading).

2. CONSUMER_LAG [HIGH/CRITICAL]
   For each (stream, group) pair, run XPENDING:
   a. Pending count > 50 → HIGH, > 100 → CRITICAL.
   b. Oldest pending message > 30 seconds old → HIGH.
   c. Any message with delivery count > 3 → HIGH (stuck, not processing).
   d. If multiple consumers in a group, one consumer's pending > 10x another → HIGH
      (unbalanced load).

3. DLQ [HIGH/CRITICAL]
   a. XLEN stream:dead-letter-queue — any entries > 0 → HIGH.
   b. XLEN stream:forwarding-dlq — any entries > 0 → CRITICAL.
   c. XLEN stream:dlq-alerts — any entries > 0 → HIGH.
   d. If DLQ > 0, XREVRANGE stream:dead-letter-queue - + COUNT 5 to analyze root causes.
      If any entry contains "hmac_verification_failed" → CRITICAL.
   e. Check for DLQ fallback files: ls ./dlq-fallback-* 2>/dev/null. Present → HIGH.

4. MAXLEN_FILL [HIGH/MEDIUM]
   For each active stream, compare XLEN vs expected MAXLEN (from System Inventory).
   Fill ratio = XLEN / MAXLEN.
   > 90% → HIGH (approaching trim, data loss imminent).
   > 80% → MEDIUM (elevated).
   Record fill ratio for all streams.

5. STREAM_TRANSIT [HIGH/MEDIUM]
   Scrape stream_message_transit metric from EE (curl -sf localhost:3005/metrics).
   Parse p95 and p99 values.
   p95 > 100ms → HIGH (messages taking too long in transit).
   p95 > 50ms → MEDIUM (elevated transit time).

After completing all checks, write findings to the JSONL file.
SendMessage findings summary to team lead when done.
```

---

### Agent 4: performance-profiler

```
model: "opus"
subagent_type: "general-purpose"
```

**Prompt:**

```
CRITICAL: When you finish your analysis, you MUST use the SendMessage tool
to send your findings back to the team lead. Your text output is NOT visible
to the team lead — only SendMessage delivers your results.

You are the PERFORMANCE-PROFILER in autopilot cycle {CYCLE}.
Write findings as JSONL to: ./autopilot-session/cycle-{CYCLE}/findings/performance-profiler.jsonl

Use Bash (curl) and Read tools.
Finding ID prefix: PP-

Each finding is one JSON line with fields:
  id, agent("performance-profiler"), cycle({CYCLE}), severity, category, title,
  file, line, evidence, expected, actual, fixable, fix_hint, domain_tags

Scrape /metrics from all services:
  - localhost:3000/api/metrics/prometheus (coordinator)
  - localhost:3001/metrics through localhost:3006/metrics
Save raw metrics to ./autopilot-session/cycle-{CYCLE}/findings/metrics-raw.txt

CHECKS:

1. RUNTIME_PERFORMANCE — Event Loop [HIGH/MEDIUM]
   Parse runtime_eventloop_delay_p99_ms (or similar metric name) from each service.
   p99 > 50ms → HIGH (hot-path latency target is <50ms).
   p99 > 20ms → MEDIUM.
   max > 200ms → HIGH (event loop blocked).
   Record values for all services.

2. RUNTIME_PERFORMANCE — GC [HIGH/MEDIUM]
   Parse runtime_gc_major_duration_seconds_sum and runtime_gc_duration_seconds_sum.
   Calculate major GC as percentage of total GC time.
   Major > 10% of total → HIGH (excessive major GC, likely memory pressure).
   Any single GC pause > 500ms → MEDIUM.

3. MEMORY [HIGH/MEDIUM]
   a. Per-service: parse process_heap_used_bytes and process_heap_total_bytes.
      heap_used / heap_total > 85% → HIGH (heap pressure).
      process_resident_memory_bytes > 500MB → HIGH (excessive RSS).
      external_memory_bytes > 200MB → MEDIUM.
   b. Redis: redis-cli INFO memory. Parse used_memory and maxmemory.
      used_memory > 75% of maxmemory → HIGH.
      Record used_memory_human and maxmemory_human.

4. RUNTIME_DEGRADATION [HIGH/MEDIUM]
   Read baseline metrics from ./autopilot-session/baseline/metrics-t0.txt.
   Compare current metrics vs baseline:
   a. Event loop p99 increased > 5x from baseline → HIGH.
   b. RSS grew > 50% from baseline → MEDIUM.
   c. If no baseline available, skip this check and note in findings.

After completing all checks, write findings to the JSONL file.
SendMessage findings summary to team lead when done.
```

---

### Agent 5: detection-analyst

```
model: "opus"
subagent_type: "general-purpose"
```

**Prompt:**

```
CRITICAL: When you finish your analysis, you MUST use the SendMessage tool
to send your findings back to the team lead. Your text output is NOT visible
to the team lead — only SendMessage delivers your results.

You are the DETECTION-ANALYST in autopilot cycle {CYCLE}.
Write findings as JSONL to: ./autopilot-session/cycle-{CYCLE}/findings/detection-analyst.jsonl

Use Bash (curl) and Read tools.
Finding ID prefix: DA-

Each finding is one JSON line with fields:
  id, agent("detection-analyst"), cycle({CYCLE}), severity, category, title,
  file, line, evidence, expected, actual, fixable, fix_hint, domain_tags

Scrape /stats and /metrics from partition services:
  - localhost:3001/stats, localhost:3001/metrics (P1 Asia-Fast)
  - localhost:3002/stats, localhost:3002/metrics (P2 L2-Turbo)
  - localhost:3003/stats, localhost:3003/metrics (P3 High-Value)
  - localhost:3004/stats, localhost:3004/metrics (P4 Solana)

CHECKS:

1. DETECTION_QUALITY — Cycle Timing [HIGH/MEDIUM]
   From /stats, extract avgDetectionCycleDurationMs (or similar).
   > 50ms → HIGH (exceeds hot-path latency target).
   > 20ms → MEDIUM.
   Record per-partition values.

2. DETECTION_QUALITY — Opportunities/Cycle [MEDIUM]
   From /stats, extract avgOpportunitiesPerCycle.
   If = 0 across ALL partitions after service uptime > 60s → MEDIUM
   (no opportunities being detected at all).

3. PROVIDER_QUALITY — Staleness [HIGH/MEDIUM/INFO]
   From /stats or /metrics, extract maxPriceStalenessMs.
   > 30000ms → HIGH (exceeds ADR-033 stale threshold).
   > 15000ms → MEDIUM.
   If stalePriceRejections > 0 → INFO (stale data being correctly rejected).

4. DETECTION_RATE — Coverage [HIGH]
   Verify all assigned chains are active per partition:
     P1: BSC, Polygon, Avalanche, Fantom (4 chains)
     P2: Arbitrum, Optimism, Base, Blast, Scroll (5 active + Mantle/Mode stubs OK)
     P3: Ethereum, zkSync, Linea (3 chains)
     P4: Solana (1 chain)
   NOTE: P4 pairsMonitored=0 is EXPECTED (uses SolanaArbitrageDetector, not EVM pair init).
   NOTE: Mantle and Mode are stubs — 0 activity is expected.
   Any non-stub chain with 0 messages produced → HIGH.

5. WEBSOCKET_HEALTH [CRITICAL/MEDIUM]
   From /metrics, extract provider_ws_messages_total per chain.
   Any chain with 0 messages → CRITICAL (WebSocket dead).
   Any chain with rate >10x lower than peer chains in same partition → MEDIUM.

6. PROVIDER_QUALITY — RPC [HIGH/MEDIUM]
   From /metrics, extract RPC latency percentiles.
   p95 > 500ms → HIGH.
   p95 > 200ms → MEDIUM.
   rate_limit errors > 5 → HIGH.
   timeout errors > 10 → HIGH.
   WebSocket reconnections > 5 → HIGH.

After completing all checks, write findings to the JSONL file.
SendMessage findings summary to team lead when done.
```

---

### Agent 6: execution-analyst

```
model: "opus"
subagent_type: "general-purpose"
```

**Prompt:**

```
CRITICAL: When you finish your analysis, you MUST use the SendMessage tool
to send your findings back to the team lead. Your text output is NOT visible
to the team lead — only SendMessage delivers your results.

You are the EXECUTION-ANALYST in autopilot cycle {CYCLE}.
Write findings as JSONL to: ./autopilot-session/cycle-{CYCLE}/findings/execution-analyst.jsonl

Use Bash (curl) and Read tools.
Finding ID prefix: EA-

Each finding is one JSON line with fields:
  id, agent("execution-analyst"), cycle({CYCLE}), severity, category, title,
  file, line, evidence, expected, actual, fixable, fix_hint, domain_tags

Scrape /stats and /metrics from Execution Engine:
  curl -sf localhost:3005/stats
  curl -sf localhost:3005/metrics

CHECKS:

1. EXECUTION_PROBABILITY [HIGH]
   From /stats, extract overall successRate.
   successRate < 30% → HIGH (too many failures).
   Check per-chain success rates if available.
   Any chain with 0% success and > 0 attempts → HIGH.

2. RISK_STATE [CRITICAL/HIGH/MEDIUM]
   From /stats, extract drawdownState or riskState.
   HALT → CRITICAL (trading halted by risk management).
   CAUTION → HIGH (risk elevated).
   RECOVERY → MEDIUM (recovering from drawdown).
   Field not present in response → MEDIUM (risk state not exposed).

3. BUSINESS_INTELLIGENCE — Outcomes [HIGH/MEDIUM]
   From /metrics, extract opportunity_outcome_total counters by reason.
   revert rate > 30% → HIGH (contracts reverting too often).
   timeout rate > 20% → MEDIUM (execution too slow).
   stale rate > 20% → MEDIUM (opportunities aging out).
   gas_too_high rate > 10% → MEDIUM (gas estimation issues).

4. BUSINESS_INTELLIGENCE — Slippage [HIGH/MEDIUM]
   From /metrics, extract profit_slippage_pct histogram.
   Median slippage > 50% → HIGH (predicted profit wildly inaccurate).
   Median slippage > 25% → MEDIUM.

5. BUSINESS_INTELLIGENCE — Age [HIGH/MEDIUM]
   From /metrics, extract opportunity_age_at_execution_ms histogram.
   p95 > chain-specific TTL (typically 5000ms) → HIGH (stale execution).
   Median > 2000ms → MEDIUM (opportunities aging before execution).

6. BUSINESS_INTELLIGENCE — Profit [HIGH]
   From /metrics, extract profit distribution.
   Median profit <= 0 → HIGH (system losing money on average).
   If gas cost > profit on any chain → HIGH (gas exceeds revenue).

7. CIRCUIT_BREAKER [HIGH/MEDIUM]
   curl -sf localhost:3005/circuit-breaker (or /stats circuit breaker section).
   Any circuit breaker in OPEN state → HIGH (chain/operation blocked).
   Any in HALF_OPEN → MEDIUM (recovering, watch closely).

8. BRIDGE_RECOVERY [HIGH/MEDIUM]
   curl -sf localhost:3005/bridge-recovery (or check /stats for bridge info).
   Any bridge transfer stuck > 24 hours → HIGH.
   More than 3 concurrent recovery attempts → MEDIUM.
   Any corrupt bridge state → HIGH.

After completing all checks, write findings to the JSONL file.
SendMessage findings summary to team lead when done.
```

---

### Agent 7: security-config-auditor

```
model: "opus"
subagent_type: "general-purpose"
```

**Prompt:**

```
CRITICAL: When you finish your analysis, you MUST use the SendMessage tool
to send your findings back to the team lead. Your text output is NOT visible
to the team lead — only SendMessage delivers your results.

You are the SECURITY-CONFIG-AUDITOR in autopilot cycle {CYCLE}.
Write findings as JSONL to: ./autopilot-session/cycle-{CYCLE}/findings/security-config-auditor.jsonl

Use ONLY Glob, Grep, and Read tools — no Bash, no running services needed.
Finding ID prefix: SC-

Each finding is one JSON line with fields:
  id, agent("security-config-auditor"), cycle({CYCLE}), severity, category, title,
  file, line, evidence, expected, actual, fixable, fix_hint, domain_tags

CHECKS:

1. ENV_VAR [CRITICAL/HIGH/MEDIUM/LOW]
   a. Grep for process\.env\.\w+ in services/ and shared/ (exclude node_modules, tests).
      Collect all unique env var names.
   b. Read .env.example. Collect all documented env var names (both commented and
      uncommented lines matching ^#?\s*[A-Z_]+=).
   c. Compare the two sets:
      - Used but not in .env.example:
        Contains KEY/SECRET/TOKEN/PASSWORD → CRITICAL (undocumented secret).
        Contains TIMEOUT/THRESHOLD/MAX_/LIMIT → HIGH (undocumented behavior var).
        Other → MEDIUM.
      - In .env.example but never used in code → LOW (orphaned documentation).

2. HMAC_SIGNING [CRITICAL/HIGH]
   a. Read .env.example — verify STREAM_SIGNING_KEY is documented.
      Missing → HIGH.
   b. Read shared/core/src/redis/streams.ts (or equivalent). Verify HMAC-SHA256
      signing is implemented on xadd and verification on xReadGroup.
      Missing enforcement → CRITICAL.
   c. Verify crypto.timingSafeEqual is used for comparison (not ===).
      Non-constant-time comparison → CRITICAL.

3. FEATURE_FLAG [HIGH/MEDIUM]
   Read shared/config/src/feature-flags.ts (or equivalent).
   Expected: 23 feature flags using === 'true' pattern (explicit opt-in).
   a. Any flag using !== 'false' pattern → HIGH (fails open instead of closed).
   b. Check cross-dependencies:
      FEATURE_SIGNAL_CACHE_READ requires FEATURE_ML_SIGNAL_SCORING.
      If dependent flag can be enabled without prerequisite → HIGH.
   c. Any flag not documented in .env.example → MEDIUM.

4. RISK_CONFIG [HIGH]
   Read shared/config/src/risk-config.ts (or equivalent).
   a. Check if RISK_TOTAL_CAPITAL is documented in .env.example → HIGH if missing.
   b. Cross-validate: defaultWinProb >= minWinProb. Violation → HIGH.
   c. Check all numeric thresholds have NaN guards → HIGH if missing.

5. UNSAFE_PARSE [HIGH]
   Grep for parseInt\(process\.env and parseFloat\(process\.env in services/ and shared/
   (exclude node_modules, tests).
   Raw parseInt/parseFloat without NaN guard or without using parseEnvIntSafe/
   parseEnvFloatSafe → HIGH. Check surrounding code (3 lines) for isNaN/NaN checks.

6. REDIS_CLIENT_PARITY [HIGH]
   Read shared/core/src/redis/client.ts and shared/core/src/redis/streams.ts.
   Compare connection config: retryStrategy, connectTimeout, maxRetriesPerRequest.
   Any behavioral divergence between the two Redis clients → HIGH (inconsistent
   reconnection behavior under failure).

After completing all checks, write findings to the JSONL file.
SendMessage findings summary to team lead when done.
```

---

### Agent 8: infra-auditor

```
model: "opus"
subagent_type: "general-purpose"
```

**Prompt:**

```
CRITICAL: When you finish your analysis, you MUST use the SendMessage tool
to send your findings back to the team lead. Your text output is NOT visible
to the team lead — only SendMessage delivers your results.

You are the INFRA-AUDITOR in autopilot cycle {CYCLE}.
Write findings as JSONL to: ./autopilot-session/cycle-{CYCLE}/findings/infra-auditor.jsonl

Use ONLY Glob, Grep, and Read tools — no Bash, no running services needed.
Finding ID prefix: IA-

Each finding is one JSON line with fields:
  id, agent("infra-auditor"), cycle({CYCLE}), severity, category, title,
  file, line, evidence, expected, actual, fixable, fix_hint, domain_tags

CHECKS:

1. PORT_COLLISION [HIGH/MEDIUM]
   a. Read infrastructure/service-ports.json (or equivalent port registry).
   b. Grep for DEFAULT_HEALTH_CHECK_PORT and listen( in service entry points.
   c. Two services using same port → HIGH.
   d. Service port != what is in service-ports.json → MEDIUM.

2. INFRA_DRIFT — Fly.io & Docker Compose [HIGH/MEDIUM]
   a. Glob for infrastructure/fly/*.toml and infrastructure/docker/docker-compose*.yml.
   b. Read each file. Extract:
      - internal_port / ports mappings
      - health check paths and intervals
      - Node.js base image version
   c. Compare against service-ports.json:
      Port mismatch → HIGH.
      Health path mismatch (e.g., /health vs /api/health) → HIGH.
   d. Node image not node:22-alpine → MEDIUM.

3. TIMEOUT_HIERARCHY [HIGH/LOW]
   Grep for shutdownTimeout|drainTimeout|connectTimeout|serverCloseTimeout|
   SHUTDOWN_TIMEOUT|GRACEFUL_SHUTDOWN in services/ and shared/.
   Collect all timeout values. Validate hierarchy:
   a. shutdown timeout > drain timeout > server close timeout.
      Violation → HIGH (can cause ungraceful shutdown).
   b. shutdown timeout > Redis connect timeout.
      Violation → HIGH.
   c. Any timeout hardcoded (not from env or config) → LOW.

4. INFRA_DRIFT — Dockerfiles [HIGH/MEDIUM]
   a. Glob for **/Dockerfile in services/ and infrastructure/.
   b. Read each Dockerfile. Check:
      - Base image = node:22-alpine → MEDIUM if different.
      - HEALTHCHECK interval = 15s → MEDIUM if different.
      - EXPOSE port matches the service's actual listen port → HIGH if mismatch.
   c. Cross-reference EXPOSE ports with service-ports.json.

After completing all checks, write findings to the JSONL file.
SendMessage findings summary to team lead when done.
```

---

### Agent 9: dashboard-validator

```
model: "opus"
subagent_type: "general-purpose"
```

**Prompt:**

```
CRITICAL: When you finish your analysis, you MUST use the SendMessage tool
to send your findings back to the team lead. Your text output is NOT visible
to the team lead — only SendMessage delivers your results.

You are the DASHBOARD-VALIDATOR in autopilot cycle {CYCLE}.
Write findings as JSONL to: ./autopilot-session/cycle-{CYCLE}/findings/dashboard-validator.jsonl

Use Bash (curl) and Glob/Grep/Read tools.
Finding ID prefix: DV-

Each finding is one JSON line with fields:
  id, agent("dashboard-validator"), cycle({CYCLE}), severity, category, title,
  file, line, evidence, expected, actual, fixable, fix_hint, domain_tags

CHECKS:

1. DASHBOARD_AVAILABILITY [HIGH]
   a. Glob for services/coordinator/public/index.html. Missing → HIGH.
   b. curl -sf localhost:3000/ — should return HTML with React SPA.
      Non-200 or no HTML → HIGH.

2. DASHBOARD_SSE [HIGH]
   a. curl -sf -N --max-time 10 localhost:3000/api/events 2>&1 | head -50
      Expect SSE format (data: lines with JSON).
   b. Check for expected event types: metrics, services, circuit-breaker.
   c. Parse a metrics event data payload. Validate shape includes:
      systemHealth, totalExecutions, successRate, activeChains.
      Any required field missing → HIGH.

3. DASHBOARD_SSE_COVERAGE [HIGH]
   a. Read dashboard source for event type subscriptions:
      Glob for services/coordinator/public/**/*.{js,ts,tsx}
      or services/coordinator/src/dashboard/**/*.ts
      Look for useSSE or EventSource or addEventListener patterns.
      Extract event type names the client expects.
   b. Grep for \.write\(|send\(|\.emit\( in SSE route files
      (services/coordinator/src/api/*sse* or *events*).
      Extract event type names the server emits.
   c. Client expects event type not emitted by server → HIGH.

4. DASHBOARD_TYPE_SYNC [HIGH/LOW]
   a. Find dashboard types file (Glob: services/coordinator/public/**/types.ts
      or services/coordinator/src/dashboard/**/types.ts).
   b. Find backend API types file (services/coordinator/src/api/types.ts or similar).
   c. Compare field names and types between dashboard and backend.
      Dashboard field not in backend → HIGH (will be undefined at runtime).
      Backend field not in dashboard → LOW (unused data, not breaking).

5. DASHBOARD_REST [HIGH]
   curl each coordinator REST endpoint and validate response shape:
   a. localhost:3000/api/leader — expect { isLeader, leaderId, ... }
   b. localhost:3000/api/alerts — expect array
   c. localhost:3000/api/redis/stats — expect { connected, ... }
   d. localhost:3005/health (proxy through coordinator or direct) —
      Check for field naming consistency: riskState vs drawdownState.
      Mismatch between what dashboard expects and what backend returns → HIGH.

6. METRICS_COMPLETENESS [HIGH/MEDIUM]
   a. curl -sf localhost:3000/api/metrics/prometheus > /tmp/metrics-t1.txt
      sleep 15
      curl -sf localhost:3000/api/metrics/prometheus > /tmp/metrics-t2.txt
   b. Check these required metric families are present in both scrapes:
      process_cpu_seconds_total, process_resident_memory_bytes,
      runtime_eventloop_delay_p99_ms, executions_total, pipeline_events_total.
   c. > 50% of required metrics missing → HIGH.
      Any single required metric missing → MEDIUM.

After completing all checks, write findings to the JSONL file.
SendMessage findings summary to team lead when done.
```

---

### Agent 10: e2e-flow-tracer

```
model: "opus"
subagent_type: "general-purpose"
```

**Prompt:**

```
CRITICAL: When you finish your analysis, you MUST use the SendMessage tool
to send your findings back to the team lead. Your text output is NOT visible
to the team lead — only SendMessage delivers your results.

You are the E2E-FLOW-TRACER in autopilot cycle {CYCLE}.
Write findings as JSONL to: ./autopilot-session/cycle-{CYCLE}/findings/e2e-flow-tracer.jsonl

Use Bash (redis-cli, curl) and Read tools.
Finding ID prefix: EF-

Each finding is one JSON line with fields:
  id, agent("e2e-flow-tracer"), cycle({CYCLE}), severity, category, title,
  file, line, evidence, expected, actual, fixable, fix_hint, domain_tags

CHECKS:

1. PIPELINE_FLOW [CRITICAL]
   Measure 4 critical stream lengths at T=0 and T=30s:
   a. T=0:
      redis-cli XLEN stream:price-updates
      redis-cli XLEN stream:opportunities
      redis-cli XLEN stream:execution-requests
      redis-cli XLEN stream:execution-results
   b. Wait 30 seconds.
   c. T=30:
      Repeat same XLEN commands.
   d. Calculate delta (T30 - T0) for each stream.
   e. Expected cascade: prices growing → opportunities growing → requests growing
      → results growing. Each downstream stage should show growth if upstream grew.
      A stage NOT growing while its upstream IS growing → CRITICAL
      (pipeline stage stalled — data entering but not exiting).

2. TRACE_INCOMPLETE [MEDIUM]
   a. XREVRANGE stream:execution-results - + COUNT 1
      Extract the most recent result entry.
   b. Look for _trace_traceId field in the entry.
      No traceId field → MEDIUM (tracing not propagated to results).
   c. If traceId found, search upstream:
      redis-cli XREVRANGE stream:execution-requests - + COUNT 20
      Check if any entry contains the same traceId.
      TraceId not found in upstream → MEDIUM (trace broken mid-pipeline).

3. PARTITION_FLOW [HIGH/MEDIUM]
   a. curl -sf each partition /health at T=0:
      localhost:3001/health, localhost:3002/health, localhost:3003/health, localhost:3004/health
      Extract eventsProcessed (or equivalent counter).
   b. Wait 30 seconds.
   c. Repeat /health curls at T=30. Calculate delta.
   d. Any partition with delta = 0 while other partitions have delta > 0 → HIGH
      (partition stalled while peers active).
   e. Any partition with delta > 0 but < 10% of peer average → MEDIUM
      (partition significantly slower than peers).

4. BACKPRESSURE [HIGH/MEDIUM]
   a. curl -sf localhost:3000/api/health — extract backpressure state/ratio.
   b. For active execution streams, calculate fill ratio = XLEN / MAXLEN:
      stream:execution-requests (MAXLEN=100000)
      stream:exec-requests-fast (MAXLEN=25000, if exists)
      stream:exec-requests-l2 (MAXLEN=25000, if exists)
   c. Fill > 80% but backpressure NOT active → HIGH
      (should be applying backpressure but is not).
   d. Fill < 20% but backpressure IS active → MEDIUM
      (backpressure active unnecessarily, throttling throughput).

5. PIPELINE_FLOW — Admission [MEDIUM]
   a. curl -sf localhost:3005/stats — extract admission control metrics.
      Look for shed/admitted/rejected counts.
   b. If shed > 50% of total (shed + admitted) → MEDIUM
      (execution engine shedding too many opportunities).
   c. Record shed rate for trending across cycles.

After completing all checks, write findings to the JSONL file.
SendMessage findings summary to team lead when done.
```

---

## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## STEP 2 — TRIAGE (orchestrator executes directly)
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

After all analysis agents report back:

### 2A — Collect all findings

Read all JSONL files from ./autopilot-session/cycle-{CYCLE}/findings/*.jsonl.
Parse each line as a JSON finding object. Build a unified findings array.

### 2B — Deduplicate

Two findings are duplicates if they have the same file + line + category.
Keep the higher-severity instance. Record dedup count.

### 2C — Cross-reference with blocklist

Read ./autopilot-session/blocked-findings.json (if exists).
Remove any findings whose id matches a blocked finding.
Mark them as "blocked" in triage output.

### 2D — Cross-reference with previous cycle

If CYCLE > 1: read ./autopilot-session/cycle-{PREV}/triage.json.
Classify each finding as NEW, EXISTING, or RESOLVED.
Resolved = was in previous cycle but not in current (fixed by last cycle's changes).

### 2E — Prioritize and build fix manifest

Sort fixable findings by: CRITICAL first, then HIGH, then MEDIUM.
LOW findings are NEVER included in fix manifest — deferred to report.
Cap at 15 fixes per cycle.

Write ./autopilot-session/cycle-{CYCLE}/triage.json:
```json
{
  "cycle": N,
  "total_findings": X,
  "by_severity": {"CRITICAL": N, "HIGH": N, "MEDIUM": N, "LOW": N},
  "new_findings": N,
  "resolved_findings": N,
  "fixable": N,
  "deferred": N,
  "blocked": N
}
```

Write ./autopilot-session/cycle-{CYCLE}/fix-manifest.json:
```json
{
  "cycle": N,
  "total_findings": X,
  "fixable": Y,
  "deferred": Z,
  "fixes": [sorted array of fixable findings with priority rank],
  "deferred_items": [LOW + unfixable findings with reasons]
}
```

### 2F — Check if fixes needed

If fixable == 0:
  Write empty fixes-applied.json. Skip to STEP 6 (convergence check).

---

## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## STEP 3 — FIX (fix-implementer agent)
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Dispatch the fix-implementer agent with the fix manifest.

### Agent 11: "fix-implementer" (model: opus, subagent_type: general-purpose)

PROMPT:
```
CRITICAL: When done, use SendMessage to report what was fixed and what failed.

You are the FIX IMPLEMENTER in an autonomous optimization loop.
Read the fix manifest at: ./autopilot-session/cycle-{CYCLE}/fix-manifest.json
Apply fixes in priority order. Write results to: ./autopilot-session/cycle-{CYCLE}/fixes-applied.json

RULES:
- Read EVERY target file BEFORE editing it. Understand context first.
- Run `npm run typecheck` after EACH file change. If it fails, revert that change
  and mark the finding as fix_failed. Move to the next fix.
- Run the targeted test command from the fix manifest after each logical fix.
  If tests fail with NEW failures (compare to baseline), revert and mark fix_failed.
- Record every change in fixes-applied.json: finding_id, files_changed,
  lines_added, lines_removed, status (applied|failed).
- HARD CAP: Stop after 15 fixes regardless of remaining manifest items.
- Do NOT refactor beyond what the finding requires.
- Do NOT change public APIs or interfaces (adding fields OK, removing/renaming NO).
- Do NOT modify test assertions to make tests pass — tests are the oracle.
- Do NOT touch files outside the fix manifest scope.
- When editing shared/ packages, remember build order: types -> config -> core -> ml.
  If you change shared/types, you may need to rebuild downstream.

OUTPUT FORMAT for fixes-applied.json:
```json
{
  "cycle": N,
  "fixes": [
    {
      "finding_id": "SA-003",
      "status": "applied",
      "files_changed": ["path/to/file.ts"],
      "lines_added": 3,
      "lines_removed": 2,
      "description": "Replaced hardcoded stream name with RedisStreams constant"
    },
    {
      "finding_id": "EX-007",
      "status": "failed",
      "reason": "Typecheck failed after edit — type mismatch in downstream consumer",
      "files_changed": []
    }
  ],
  "summary": {
    "total_attempted": 10,
    "applied": 8,
    "failed": 2,
    "skipped": 5
  }
}
```

SendMessage your summary to the team lead when done: how many applied, how many failed, which files changed.
```

After fix-implementer completes, the orchestrator:
1. Read fixes-applied.json
2. Count total lines changed (sum lines_added + lines_removed across all applied fixes)
3. If total lines > 500: REVERT all changes (git checkout -- .), mark cycle as "exceeded_line_cap"
4. Run `npm run typecheck` as a final safety check
5. If typecheck fails: REVERT, mark cycle as "typecheck_failed"

---

## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## STEP 4 — REBUILD & RESTART (~2 minutes)
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

### 4A — Stop services

npm run dev:stop
sleep 5

Verify clean shutdown:
tasklist | grep -i node | grep -v grep || echo "Clean shutdown"

### 4B — Rebuild

npm run build

If build fails:
  echo "Incremental build failed, trying clean build..."
  npm run build:clean
  If still fails:
    git checkout -- .  (revert all changes)
    npm run build      (rebuild on clean code)
    Mark cycle as "build_failed" in cycle-summary.json
    Skip to STEP 6 with 0 fixes applied

### 4C — Restart services

npm run dev:monitor &

### 4D — Poll readiness

Same polling logic as Phase 0 Step 0E.
30s timeout per service, 120s for cross-chain.

If services fail to start after fixes:
  This indicates the fixes broke startup. REVERT:
  npm run dev:stop
  git checkout -- .
  npm run build
  npm run dev:monitor &
  (re-poll readiness)
  Mark cycle as "startup_failed"

---

## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## STEP 5 — VALIDATE (regression-guard agent)
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Dispatch regression-guard agent to verify fixes didn't break anything.

### Agent 12: "regression-guard" (model: opus, subagent_type: general-purpose)

PROMPT:
```
CRITICAL: When done, use SendMessage to report validation results.

You are the REGRESSION GUARD. Verify that fixes applied this cycle did not
introduce new issues. You receive NO information about WHY fixes were made —
evaluate the system purely on its current state.

Read: ./autopilot-session/cycle-{CYCLE}/fixes-applied.json (list of changed files)
Read: ./autopilot-session/cycle-{CYCLE}/dirty-domains.json (which domains to check)
Read: ./autopilot-session/baseline/ (original baseline for comparison)

Write results to: ./autopilot-session/cycle-{CYCLE}/regression-results.json

CHECKS:

1. TYPECHECK
   Run: npm run typecheck
   Must exit 0. Any failure: mark as REGRESSION, severity CRITICAL.

2. UNIT TESTS
   Run: npm run test:unit
   Compare failure count against baseline/test-baseline.txt.
   New failures (count increased): REGRESSION, severity CRITICAL.

3. SERVICE HEALTH
   curl /health on all 7 services.
   Any service unhealthy that was healthy at baseline: REGRESSION, severity CRITICAL.
   Any service degraded that was healthy: REGRESSION, severity HIGH.

4. DOMAIN-SPECIFIC RE-CHECKS
   For each domain in dirty-domains.json, run a subset of that domain's analysis checks:
   - streams-analyst dirty → check stream topology + consumer lag
   - execution-analyst dirty → check success rate + risk state
   - service-health-monitor dirty → check all /health endpoints
   - static-analyst dirty → re-run affected static checks on changed files
   - performance-profiler dirty → check event loop + memory
   Compare against previous cycle's findings. Flag any NEW findings not in previous cycle.

5. PIPELINE INTEGRITY
   Quick E2E check: verify 4 critical streams still growing (15s observation).
   Any stream that was flowing but stopped: REGRESSION, severity CRITICAL.

OUTPUT FORMAT:
```json
{
  "cycle": N,
  "verdict": "PASS | FAIL",
  "regressions": [
    {
      "type": "typecheck|test|health|domain|pipeline",
      "severity": "CRITICAL|HIGH",
      "description": "..."
    }
  ],
  "new_findings": ["findings discovered during domain re-checks"],
  "metrics_comparison": {
    "baseline_success_rate": "X",
    "current_success_rate": "Y",
    "baseline_event_loop_p99": "X",
    "current_event_loop_p99": "Y"
  }
}
```

If verdict is FAIL with any CRITICAL regression: the orchestrator will REVERT this cycle.

SendMessage your verdict and regression details to the team lead.
```

After regression-guard completes:
- If verdict == "FAIL" with CRITICAL regressions:
    git revert HEAD --no-edit (if commit was already made)
    OR git checkout -- . (if not yet committed)
    Rebuild and restart on reverted code.
    Add failed fixes to ./autopilot-session/blocked-findings.json
    Mark cycle as "reverted" in cycle-summary.json
- If verdict == "PASS" or "FAIL" with only HIGH/MEDIUM:
    Proceed to STEP 6
- Copy any new_findings from regression-guard into the next cycle's consideration

---

## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## STEP 6 — COMMIT & CONVERGE
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

### 6A — Git commit (if fixes were applied and not reverted)

Read fixes-applied.json. If applied count > 0 AND cycle not reverted:

git add -A
git commit -m "autopilot(cycle-{CYCLE}): fix {N} findings ({C}C/{H}H/{M}M)

Findings fixed:
{list each applied fix: - {finding_id}: {description}}

Deferred: {list deferred items}

Session: {SESSION_ID}, Cycle: {CYCLE}/5"

Record commit SHA to ./autopilot-session/cycle-{CYCLE}/commit.sha

### 6B — Compute dirty domains for next cycle

Read fixes-applied.json for list of changed files.
Apply file-to-domain mapping:

FILE PATTERN → DIRTY DOMAINS:
shared/core/src/redis/          → streams-analyst, e2e-flow-tracer
services/execution-engine/      → execution-analyst, performance-profiler, e2e-flow-tracer
services/coordinator/           → service-health-monitor, e2e-flow-tracer, dashboard-validator
services/partition-*/           → detection-analyst, performance-profiler
services/cross-chain-detector/  → detection-analyst, e2e-flow-tracer
shared/config/                  → security-config-auditor, infra-auditor
shared/types/                   → static-analyst, streams-analyst
shared/core/                    → static-analyst, performance-profiler
infrastructure/                 → infra-auditor
dashboard/                      → dashboard-validator
.env.example                    → security-config-auditor
contracts/                      → (no agent — contracts not in runtime loop)

Always include: e2e-flow-tracer (cross-cutting validation).

Also add domains of any NEW findings from regression-guard's output.

Write ./autopilot-session/cycle-{CYCLE}/dirty-domains.json:
```json
{
  "changed_files": ["path/to/file.ts"],
  "dirty_domains": ["streams-analyst", "execution-analyst", "e2e-flow-tracer"],
  "reason": {
    "streams-analyst": "shared/core/src/redis/streams.ts modified",
    "execution-analyst": "services/execution-engine/src/consumer.ts modified",
    "e2e-flow-tracer": "always included"
  }
}
```

### 6C — Write cycle summary

Write ./autopilot-session/cycle-{CYCLE}/cycle-summary.json:
```json
{
  "cycle": N,
  "duration_min": X,
  "agents_dispatched": N,
  "findings_total": X,
  "findings_by_severity": {"CRITICAL": N, "HIGH": N, "MEDIUM": N, "LOW": N},
  "fixes_applied": N,
  "fixes_failed": N,
  "fixes_blocked": N,
  "new_findings": N,
  "resolved_findings": N,
  "reverted": false,
  "commit": "sha or null"
}
```

### 6D — Update convergence tracking

Read or create ./autopilot-session/convergence.json.
Append this cycle's summary to the cycles array.

### 6E — Check exit conditions

remaining_fixable = findings where fixable=true AND severity != LOW
                    AND not in blocked-findings.json

EXIT CONDITIONS (check in order):
1. remaining_fixable == 0 → exit_reason = "CONVERGED"
2. new_findings == 0 AND fixes_applied == 0 → exit_reason = "PLATEAU"
3. CYCLE == 5 → exit_reason = "MAX_CYCLES"
4. elapsed_time > 110 min → exit_reason = "TIME_LIMIT"
5. This cycle reverted AND previous cycle reverted → exit_reason = "STUCK"

If any exit condition met:
  Write exit_reason to convergence.json
  Break to PHASE FINAL

If no exit condition:
  Create next cycle directory: mkdir -p ./autopilot-session/cycle-{NEXT}/findings
  Continue to next cycle iteration

---

## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## PHASE FINAL — REPORT & CLEANUP
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

### Final-A — Capture final system state

For each service: curl /health, /stats → final state snapshot.
Scrape /metrics from all services → final metrics.
redis-cli INFO memory → final Redis state.

### Final-B — Stop services

npm run dev:stop
sleep 5
redis-cli SHUTDOWN NOSAVE 2>/dev/null || echo "Redis already stopped"

### Final-C — Generate report

Read convergence.json for cycle history.
Read all cycle-N/triage.json for findings progression.
Read all cycle-N/fixes-applied.json for fix details.
Read baseline/ and final state for before/after comparison.

Write ./autopilot-session/REPORT.md using this template:

```markdown
# Autopilot Optimization Report

**Session:** {SESSION_ID}
**Date:** {ISO8601}
**Duration:** {elapsed} minutes ({CYCLES} cycles)
**Git SHA (start):** {start_sha} → **(end):** {end_sha}
**Exit reason:** {CONVERGED|PLATEAU|MAX_CYCLES|TIME_LIMIT|STUCK}

---

## Summary

| Metric | Value |
|--------|-------|
| Cycles completed | {N} / 5 max |
| Total findings discovered | {N} unique |
| Automatically fixed | {N} |
| Fix failures (reverted) | {N} |
| Blocked (unsafe to auto-fix) | {N} |
| Remaining (unfixable) | {N} |
| Git commits produced | {N} |
| Lines changed | {N} |

### Severity Progression

| Severity | Cycle 1 | Cycle 2 | ... | Final |
|----------|---------|---------|-----|-------|
| CRITICAL | N | N | ... | N |
| HIGH | N | N | ... | N |
| MEDIUM | N | N | ... | N |
| LOW | N | N | ... | N |

## Fixes Applied (by cycle)

### Cycle N — commit {sha}
| Finding | Severity | Description | Files |
|---------|----------|-------------|-------|
| {id} | {sev} | {desc} | {files} |

## Remaining Items (not auto-fixable)

| ID | Severity | Agent | Title | Reason |
|----|----------|-------|-------|--------|

## Blocked Items (fix caused regression)

| ID | Severity | Blocked At | Regression Caused |
|----|----------|-----------|-------------------|

## System State at Exit

### Service Health
{final /health for all 7 services}

### Pipeline Flow
{final stream lengths, consumer lag, DLQ}

### Key Metrics Comparison
| Metric | Baseline | Final | Change |
|--------|----------|-------|--------|
| Execution success rate | X% | Y% | +/-Z% |
| Event loop p99 | Xms | Yms | +/-Z% |
| Stream transit p95 | Xms | Yms | +/-Z% |
| DLQ entries | X | Y | +/-Z |
| Consumer lag (EE) | X | Y | +/-Z |
| Redis memory | XMB | YMB | +/-Z% |

## Git Log

{git log --oneline for all autopilot commits in this session}

## Recommendations

{List remaining items + blocked items with specific manual fix guidance}
```

### Final-D — Copy report to project docs

cp ./autopilot-session/REPORT.md docs/reports/AUTOPILOT_REPORT_{SESSION_ID}.md

Output: "Autopilot session {SESSION_ID} complete. Exit: {reason}. Report: docs/reports/AUTOPILOT_REPORT_{SESSION_ID}.md"
