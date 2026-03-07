# Autopilot Command Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create `.claude/commands/autopilot.md` — a fully autonomous optimization loop that starts services, dispatches 12 specialized agents, auto-fixes findings, and iterates until convergence.

**Architecture:** Single command file (~4000 lines) with orchestrator instructions, 12 agent prompt templates, triage logic, convergence tracking, and report generation. Uses TeamCreate for agent teams, filesystem for state management (JSONL findings, JSON manifests), git commits per cycle.

**Tech Stack:** Claude Code command file (markdown), Bash, redis-cli, curl, Glob/Grep/Read, TeamCreate/Task/SendMessage for agent orchestration.

**Design doc:** `docs/plans/2026-03-07-autopilot-design.md`

---

## Task 1: Command Skeleton — Header, Rules, System Inventory

**Files:**
- Create: `.claude/commands/autopilot.md`

**Step 1: Create the command file with header and overview**

Write the file header, orchestrator role description, critical rules, and system inventory. The system inventory is shared reference data used by all agents — reuse the tables from monitoring.md (services, streams, consumer groups, pipeline flow).

```markdown
# Autopilot: Autonomous Optimization Loop
# Version: 1.0
#
# Fully autonomous detect-fix-validate loop.
# Dispatches 12 specialized agents across up to 5 cycles.
# Produces git commits per cycle and a final optimization report.

---

You are the **ORCHESTRATOR** of an autonomous optimization loop. Your job is to
get the arbitrage system production-ready by iterating through analyze-fix-validate
cycles until no fixable findings remain or 5 cycles are exhausted.

**You have access to:** Bash, Glob, Grep, Read, Write, Edit, TeamCreate, Task,
SendMessage, and all standard tools.

**CRITICAL RULES:**
- ALL agents MUST be spawned with `model: "opus"` explicitly
- ALL agent prompts MUST start with the SendMessage report-back instruction
- Agent prompts MUST be under 300 lines — summarize, don't duplicate
- 2-minute stall timeout — if an agent hasn't reported back, self-execute their work
- Do NOT skip phases or cycles. Follow the loop strictly.
- If Phase 0 fails catastrophically (Redis won't start, build fails), skip to PHASE FINAL.
- Track wall-clock time. Exit if elapsed > 110 minutes (TIME_LIMIT).
```

Include the full system inventory tables (copy from monitoring.md lines 59-124):
- Services table (7 services with ports and ready endpoints)
- Redis Streams table (29 streams with MAXLEN, producers, consumer groups)
- Consumer Groups table (7 active groups)
- Pipeline Data Flow diagram

**Step 2: Verify file exists and has correct structure**

Run: `wc -l .claude/commands/autopilot.md`
Expected: ~150 lines (header + inventory)

**Step 3: Commit**

```bash
git add .claude/commands/autopilot.md
git commit -m "feat(autopilot): command skeleton with system inventory"
```

---

## Task 2: Phase 0 — Bootstrap

**Files:**
- Modify: `.claude/commands/autopilot.md`

**Step 1: Add Phase 0 section**

Append the bootstrap phase. This creates the session workspace, builds packages, starts Redis and services, waits for readiness, and captures baseline state.

```markdown
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## PHASE 0 — BOOTSTRAP (~3 minutes)
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

### Step 0A — Create session workspace

mkdir -p ./autopilot-session/{baseline,logs,cycle-1/findings}
SESSION_ID=$(date +%Y%m%d_%H%M%S)
echo $SESSION_ID > ./autopilot-session/SESSION_ID
CURRENT_SHA=$(git rev-parse HEAD)
echo $CURRENT_SHA > ./autopilot-session/current.sha
START_TIME=$(date +%s)
echo $START_TIME > ./autopilot-session/start-time.txt
CYCLE=0

### Step 0B — Build all packages

npm run build
If build fails: npm run build:clean
If still fails: record CRITICAL finding, skip to PHASE FINAL.

### Step 0C — Start Redis

npm run dev:redis:memory &
sleep 3
redis-cli PING
If PING fails: CRITICAL, skip to PHASE FINAL.

### Step 0D — Start services

npm run dev:monitor &
Capture PID to ./autopilot-session/services.pid

### Step 0E — Poll readiness

Poll each service with service-specific timeouts:
- Coordinator (3000): 30s, /api/health/ready
- P1-P4 (3001-3004): 30s, /ready
- Execution Engine (3005): 30s, /ready
- Cross-Chain (3006): 120s, /ready

If any non-cross-chain service fails to start within 30s: CRITICAL.
If cross-chain fails within 120s: HIGH (continue anyway).

### Step 0F — Capture baseline state

For each discovered stream:
  redis-cli XINFO STREAM / XINFO GROUPS / XLEN → baseline/streams.json

For each service:
  curl /health → baseline/service-health.json
  curl /stats → baseline/service-stats.json

Prometheus scrape:
  curl /metrics (all ports) → baseline/metrics-t0.txt

Redis memory:
  redis-cli INFO memory → baseline/redis-memory.txt

Record unit test baseline failure count:
  npm run test:unit 2>&1 | tail -5 → baseline/test-baseline.txt
  (Extract: Tests: X failed, Y passed, Z total)
```

**Step 2: Verify section added**

Run: `grep -c "PHASE 0" .claude/commands/autopilot.md`
Expected: at least 1

**Step 3: Commit**

```bash
git add .claude/commands/autopilot.md
git commit -m "feat(autopilot): Phase 0 bootstrap (build, redis, services, baseline)"
```

---

## Task 3: Cycle Loop Structure

**Files:**
- Modify: `.claude/commands/autopilot.md`

**Step 1: Add the main cycle loop**

This is the orchestrator's core loop logic. It manages cycle transitions, time checking, and the 6-step cycle.

```markdown
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## CYCLE LOOP — Up to 5 iterations
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

For each cycle (CYCLE = 1 to 5):

### Pre-Cycle Checks

1. Create cycle directory: mkdir -p ./autopilot-session/cycle-$CYCLE/findings
2. Check elapsed time: if > 110 minutes → exit with TIME_LIMIT
3. Check consecutive reverts: if last 2 cycles were reverted → exit with STUCK
4. Determine agents to dispatch:
   - Cycle 1: ALL 10 analysis agents
   - Cycle 2-5: Read ./autopilot-session/cycle-$((CYCLE-1))/dirty-domains.json
     Dispatch only agents listed in dirty_domains + always e2e-flow-tracer

### STEP 1 — ANALYZE (parallel agent dispatch)

Create team: TeamCreate with name "autopilot-cycle-$CYCLE"

Dispatch all required agents in a SINGLE message with parallel Task calls.
Each agent Task must include:
  - team_name: "autopilot-cycle-$CYCLE"
  - model: "opus"
  - subagent_type: "general-purpose"
  - The agent-specific prompt (see Agent Prompt sections below)

Wait for all agents to report back via SendMessage.
Apply 2-minute stall timeout per agent — self-execute if unresponsive.

### STEP 2 — TRIAGE

(See Triage section below)

### STEP 3 — FIX

(See Fix Implementer section below)

### STEP 4 — REBUILD & RESTART

(See Rebuild section below)

### STEP 5 — VALIDATE

(See Regression Guard section below)

### STEP 6 — COMMIT & CONVERGE

(See Convergence section below)

### Post-Cycle

If exit condition met → break to PHASE FINAL
Else → increment CYCLE, continue loop
```

**Step 2: Commit**

```bash
git add .claude/commands/autopilot.md
git commit -m "feat(autopilot): cycle loop structure with 6-step framework"
```

---

## Task 4: Agent Prompts — Static Analyst + Security Config Auditor

**Files:**
- Modify: `.claude/commands/autopilot.md`

**Step 1: Add the static-analyst agent prompt**

These are the two code-analysis agents that use Glob/Grep/Read (no running services needed). They carry over the bulk of monitoring.md Phase 1 checks.

```markdown
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## AGENT PROMPTS — Analysis Agents
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

### Agent 1: "static-analyst" (model: opus, subagent_type: general-purpose)

PROMPT:
---
CRITICAL: When done, use SendMessage to send findings to the team lead.
Your text output is NOT visible — only SendMessage delivers results.

You are the STATIC ANALYST in an autonomous optimization loop.
Analyze code quality and correctness using Glob, Grep, and Read tools only.
Write findings as JSONL to: ./autopilot-session/cycle-{CYCLE}/findings/static-analyst.jsonl

FINDING FORMAT (one JSON object per line):
{"id":"SA-{NNN}","agent":"static-analyst","cycle":{CYCLE},"severity":"CRITICAL|HIGH|MEDIUM|LOW","category":"...","title":"...","file":"...","line":0,"evidence":"...","expected":"...","actual":"...","fixable":true,"fix_hint":"...","domain_tags":["..."]}

RUN THESE CHECKS:

1. STREAM NAME DECLARATIONS (category: STREAM_DECLARATION)
   Read shared/types/src/events.ts for canonical RedisStreams constant.
   Grep for xadd, xReadGroup, createConsumerGroup in .ts files (exclude node_modules, tests).
   Flag hardcoded stream name strings (not using RedisStreams constant). Severity: HIGH.

2. MAXLEN ENFORCEMENT (category: MAXLEN)
   Grep for this.xadd( calls NOT inside xaddWithLimit() — raw xadd bypasses MAXLEN.
   Grep for redis.xadd( or client.xadd( outside RedisStreamsClient. Severity: CRITICAL.

3. XACK AFTER CONSUME (category: MISSING_ACK)
   Grep for xReadGroup/XREADGROUP. For each file, verify xack/XACK also present.
   Severity: HIGH.

4. NULLISH COALESCING (category: ANTI_PATTERN)
   Grep for || 0\b and || 0n\b in .ts files (exclude node_modules). Severity: LOW.

5. SILENT ERROR SWALLOWING (category: SILENT_ERROR)
   Grep for empty catch blocks in services/ and shared/ (exclude tests).
   Hot-path empty catch = HIGH. Utility/cleanup = LOW.

6. STREAM TYPE FIDELITY (category: STREAM_TYPE_FIDELITY)
   Read services/coordinator/src/utils/stream-serialization.ts for .toString() conversions.
   Read services/execution-engine/src/consumers/validation.ts for as unknown as casts.
   Flag numeric fields serialized without corresponding parseFloat on deserialize. Severity: HIGH.

7. ADR COMPLIANCE SPOT-CHECKS (category: ADR_COMPLIANCE)
   - ADR-022: Grep for spread operators in loops on hot-path files. Severity: HIGH.
   - ADR-033: Read shared/core/src/price-matrix.ts, verify stale threshold = 30000ms.
   - ADR-002: Grep for http://localhost:300[0-6] in services/ (exclude tests). Severity: HIGH.
   - ADR-018: Grep for failureThreshold, verify default = 5.
   - ADR-005: Grep for SharedArrayBuffer in price-matrix.ts.

After all checks, SendMessage your findings summary to the team lead.
---
```

**Step 2: Add the security-config-auditor agent prompt**

```markdown
### Agent 7: "security-config-auditor" (model: opus, subagent_type: general-purpose)

PROMPT:
---
CRITICAL: When done, use SendMessage to send findings to the team lead.

You are the SECURITY & CONFIG AUDITOR. Analyze configuration correctness
and security posture using Glob, Grep, and Read tools.
Write findings to: ./autopilot-session/cycle-{CYCLE}/findings/security-config-auditor.jsonl

CHECKS:

1. ENV VAR DRIFT (category: ENV_VAR)
   Grep for process.env.[A-Z_]+ in services/ and shared/ (exclude tests, node_modules).
   Read .env.example for documented vars (lines matching ^[A-Z_]+= or ^#\s*[A-Z_]+=).
   Undocumented security vars (KEY, SECRET, TOKEN, PASSWORD): CRITICAL.
   Undocumented behavior vars (TIMEOUT, THRESHOLD, MAX_, LIMIT): HIGH.
   Other undocumented: MEDIUM. Orphaned in .env.example: LOW.
   Exclude standard platform vars: NODE_ENV, PORT, CI, JEST_WORKER_ID, HOME, PATH, etc.

2. HMAC SIGNING (category: HMAC_SIGNING)
   Verify STREAM_SIGNING_KEY documented in .env.example.
   Verify signing implementation in shared/core/src/redis/streams.ts.
   Missing enforcement: CRITICAL. Missing docs: HIGH.

3. FEATURE FLAGS (category: FEATURE_FLAG)
   Read shared/config/src/feature-flags.ts for all 23 FEATURE_* flags.
   Verify cross-dependencies (FEATURE_SIGNAL_CACHE_READ requires FEATURE_ML_SIGNAL_SCORING).
   Verify all flags documented in .env.example.
   Cross-dependency violation: HIGH. Undocumented flag: MEDIUM.

4. RISK CONFIG (category: RISK_CONFIG)
   Read shared/config/src/risk-config.ts.
   Verify RISK_TOTAL_CAPITAL documented (required in production). Missing: HIGH.
   Verify cross-validation: defaultWinProbability >= minWinProbability.

5. UNSAFE NUMERIC PARSE (category: UNSAFE_PARSE)
   Grep for parseInt(process.env and parseFloat(process.env in .ts files.
   Check surrounding context for NaN protection.
   Raw parse without NaN guard: HIGH.
   Files using parseEnvIntSafe/parseEnvFloatSafe: INFO.

6. REDIS CLIENT PARITY (category: REDIS_CLIENT_PARITY)
   Read shared/core/src/redis/client.ts and shared/core/src/redis/streams.ts.
   Compare retryStrategy, connectTimeout, maxRetriesPerRequest, lazyConnect.
   Behavior divergence: HIGH.

SendMessage findings summary to team lead when done.
---
```

**Step 2: Commit**

```bash
git add .claude/commands/autopilot.md
git commit -m "feat(autopilot): agent prompts — static-analyst + security-config-auditor"
```

---

## Task 5: Agent Prompts — Service Health + Streams + E2E Flow

**Files:**
- Modify: `.claude/commands/autopilot.md`

**Step 1: Add service-health-monitor, streams-analyst, and e2e-flow-tracer prompts**

These agents interact with the live running system via curl and redis-cli.

```markdown
### Agent 2: "service-health-monitor" (model: opus, subagent_type: general-purpose)

PROMPT:
---
CRITICAL: When done, use SendMessage to send findings to the team lead.

You are the SERVICE HEALTH MONITOR. Check all 7 services for health,
readiness, schema correctness, and leader election.
Write findings to: ./autopilot-session/cycle-{CYCLE}/findings/service-health-monitor.jsonl

CHECKS:

1. SERVICE HEALTH MATRIX (category: SERVICE_HEALTH)
   curl -sf http://localhost:{PORT}/health for ports 3000-3006.
   (Coordinator uses /api/health). Flag: unhealthy=CRITICAL, degraded=HIGH, unreachable=CRITICAL.

2. LEADER ELECTION (category: LEADER_ELECTION)
   curl -sf http://localhost:3000/api/leader
   redis-cli GET coordinator:leader:lock / TTL coordinator:leader:lock
   isLeader=false: CRITICAL. Lock missing: CRITICAL. TTL<5: HIGH.

3. HEALTH SCHEMA VALIDATION (category: HEALTH_SCHEMA)
   Validate each /health response against expected schema:
   - All services: status (string enum), uptime (number > 0)
   - Partitions: eventsProcessed, chains
   - EE: queueSize, activeExecutions, successRate, drawdownState
   - Cross-chain: partitionsConnected
   Missing required field: HIGH. Type mismatch: MEDIUM.

4. READINESS ENDPOINT CONSISTENCY (category: SERVICE_READY)
   Test both /ready and /api/health/ready on all ports.
   Coordinator 404 on /ready: HIGH. Any other service 404 on /ready: CRITICAL.
   Test /metrics on all ports (3001-3006) and /api/metrics/prometheus on 3000.

5. COORDINATOR HEALTH DETAIL (category: SERVICE_HEALTH)
   curl -sf http://localhost:3000/api/health — check systemHealth score,
   services count (should see 6-7 healthy), backpressure state.
   systemHealth < 50: HIGH. < 70: MEDIUM.

SendMessage findings summary to team lead when done.
---
```

```markdown
### Agent 3: "streams-analyst" (model: opus, subagent_type: general-purpose)

PROMPT:
---
CRITICAL: When done, use SendMessage to send findings to the team lead.

You are the STREAMS ANALYST. Inspect Redis Streams topology, consumer groups,
lag, DLQ, and MAXLEN fill ratios.
Write findings to: ./autopilot-session/cycle-{CYCLE}/findings/streams-analyst.jsonl

CHECKS:

1. STREAM TOPOLOGY (category: STREAM_TOPOLOGY)
   redis-cli --scan --pattern 'stream:*' to discover all streams.
   For each: XINFO STREAM, XINFO GROUPS, XLEN.
   Compare against 29 expected streams from system inventory.
   Active stream missing: HIGH. On-demand stream missing: MEDIUM.
   Expected consumer group missing from stream: HIGH.
   Consumer group with 0 consumers: CRITICAL (dead consumer).

2. CONSUMER LAG (category: CONSUMER_LAG)
   For each discovered (stream, group) pair: redis-cli XPENDING.
   Pending > 50: HIGH. Pending > 100: CRITICAL.
   Oldest pending > 30s: HIGH (stuck message).
   Delivery count > 3: HIGH (poison message).
   Group lag >10x peer on shared stream: HIGH.

3. DLQ STATUS (category: DLQ)
   redis-cli XLEN stream:dead-letter-queue / stream:forwarding-dlq / stream:dlq-alerts.
   DLQ > 0: HIGH. Forwarding-DLQ > 0: CRITICAL.
   If DLQ > 0: XREVRANGE stream:dead-letter-queue + - COUNT 50 — analyze root causes.
   Single reason > 50% of DLQ: HIGH (systemic). hmac_verification_failed: CRITICAL.
   Check for fallback files: ls ./data/dlq-fallback-*.jsonl — if today's date: HIGH.

4. MAXLEN FILL RATIOS (category: MAXLEN_FILL)
   For each active stream, compare XLEN against declared MAXLEN.
   > 90%: HIGH (active trimming). > 80%: MEDIUM.
   Key streams to check: price-updates (100K), opportunities (500K),
   execution-requests (100K), execution-results (100K).

5. STREAM TRANSIT TIME (category: STREAM_TRANSIT)
   curl -sf http://localhost:3005/metrics | grep stream_message_transit
   p95 > 100ms: HIGH. > 50ms: MEDIUM. execution-requests > 200ms: HIGH.

SendMessage findings summary to team lead when done.
---
```

```markdown
### Agent 10: "e2e-flow-tracer" (model: opus, subagent_type: general-purpose)

PROMPT:
---
CRITICAL: When done, use SendMessage to send findings to the team lead.

You are the E2E FLOW TRACER. Verify the complete data pipeline is flowing
end-to-end by tracing messages and measuring per-stage throughput.
Write findings to: ./autopilot-session/cycle-{CYCLE}/findings/e2e-flow-tracer.jsonl

CHECKS:

1. PIPELINE FLOW VERIFICATION (category: PIPELINE_FLOW)
   Capture stream lengths at T=0 and T=30s for the 4 critical streams:
   price-updates, opportunities, execution-requests, execution-results.
   Expected cascade: prices grow → opportunities grow → requests grow → results grow.
   Any stage not growing while upstream is: CRITICAL (pipeline broken at that stage).
   Also check stream:fast-lane (may be empty in simulation — INFO).

2. MESSAGE TRACE (category: TRACE_INCOMPLETE)
   redis-cli XREVRANGE stream:execution-results + - COUNT 1
   Extract _trace_traceId from the result message.
   Search for same traceId in stream:opportunities and stream:execution-requests.
   Expected: traceId appears in all 3 streams (full trace).
   Missing from upstream: MEDIUM (trace context not propagated).
   No traceId in any message: MEDIUM (trace system inactive).

3. PER-PARTITION FLOW (category: PARTITION_FLOW)
   curl /health for P1-P4, capture eventsProcessed.
   Wait 30s, capture again. Compute deltas.
   Partition with 0 delta while others active: HIGH (silent failure).
   Partition delta >10x lower than peers: MEDIUM (degraded).
   Expected coverage: P1=4 chains, P2=7 chains, P3=3 chains, P4=1 chain.
   Note: P4 Solana pairsMonitored=0 is expected (uses SolanaArbitrageDetector).

4. BACKPRESSURE CONSISTENCY (category: BACKPRESSURE)
   curl coordinator /api/health — read backpressure state.
   redis-cli XLEN stream:execution-requests — compute fill ratio vs 100K MAXLEN.
   Fill > 80% but backpressure inactive: HIGH (flow control broken).
   Fill < 20% but backpressure active: MEDIUM (stuck on).

5. ADMISSION CONTROL (category: PIPELINE_FLOW)
   curl http://localhost:3005/stats — check shed/admitted counts.
   Shed rate > 50%: MEDIUM (execution engine overloaded).
   Shed rate = 0% AND stream lag high: MEDIUM (admission control may not be active).

SendMessage findings summary to team lead when done.
---
```

**Step 2: Commit**

```bash
git add .claude/commands/autopilot.md
git commit -m "feat(autopilot): agent prompts — health monitor, streams, e2e flow"
```

---

## Task 6: Agent Prompts — Performance, Detection, Execution

**Files:**
- Modify: `.claude/commands/autopilot.md`

**Step 1: Add performance-profiler, detection-analyst, execution-analyst prompts**

These agents focus on Prometheus /metrics data from running services.

```markdown
### Agent 4: "performance-profiler" (model: opus, subagent_type: general-purpose)

PROMPT:
---
CRITICAL: When done, use SendMessage to send findings to the team lead.

You are the PERFORMANCE PROFILER. Analyze runtime performance of all services
using Prometheus metrics from /metrics endpoints.
Write findings to: ./autopilot-session/cycle-{CYCLE}/findings/performance-profiler.jsonl

CHECKS:

1. EVENT LOOP HEALTH (category: RUNTIME_PERFORMANCE)
   Scrape runtime_eventloop_delay_* from all services (/metrics on 3001-3006,
   /api/metrics/prometheus on 3000).
   p99 > 50ms: HIGH (violates hot-path target). p99 > 20ms: MEDIUM.
   max > 200ms: HIGH (severe stall — GC or sync I/O).
   Metrics not present: MEDIUM (RuntimeMonitor may not be started).

2. GC PRESSURE (category: RUNTIME_PERFORMANCE)
   Scrape runtime_gc_* metrics from all services.
   gc_major_count > gc_total * 0.1: HIGH (>10% major GC — heap pressure).
   gc_pause_total_ms > 500: MEDIUM (significant GC time).
   gc_major_count > 10 in session: MEDIUM.

3. MEMORY BREAKDOWN (category: MEMORY)
   Scrape runtime_memory_* from all services.
   heap_used/heap_total > 85%: HIGH (approaching OOM).
   rss_mb > 500: HIGH (OOM kill risk on Fly.io).
   external_mb > 200: MEDIUM (SharedArrayBuffer growth).
   Also: redis-cli INFO memory — used_memory > 75% maxmemory: HIGH.

4. RUNTIME DEGRADATION (category: RUNTIME_DEGRADATION)
   Compare current metrics against baseline (from Phase 0).
   Event loop p99 increased > 5x: HIGH.
   RSS grew > 50%: MEDIUM (possible memory leak under load).

SendMessage findings summary to team lead when done.
---
```

```markdown
### Agent 5: "detection-analyst" (model: opus, subagent_type: general-purpose)

PROMPT:
---
CRITICAL: When done, use SendMessage to send findings to the team lead.

You are the DETECTION ANALYST. Evaluate per-chain detection quality,
cycle timing, and price freshness across all 4 partitions.
Write findings to: ./autopilot-session/cycle-{CYCLE}/findings/detection-analyst.jsonl

CHECKS:

1. DETECTION CYCLE TIMING (category: DETECTION_QUALITY)
   curl /stats on P1-P4 (ports 3001-3004), read avgDetectionCycleDurationMs.
   > 50ms: HIGH (exceeds hot-path target). > 20ms: MEDIUM.

2. OPPORTUNITIES PER CYCLE (category: DETECTION_QUALITY)
   curl /stats, read avgOpportunitiesPerCycle.
   0 across ALL partitions after > 60s uptime: MEDIUM (no detection).

3. PRICE STALENESS (category: PROVIDER_QUALITY)
   curl /stats, read maxPriceStalenessMs and stalePriceRejections.
   maxPriceStalenessMs > 30000: HIGH (ADR-033 violation). > 15000: MEDIUM.
   stalePriceRejections > 0: INFO (filtering working correctly).

4. PER-CHAIN DETECTION COVERAGE (category: DETECTION_RATE)
   curl /stats on each partition. Verify all assigned chains are active:
   P1: BSC, Polygon, Avalanche, Fantom (4). P2: Arbitrum, Optimism, Base,
   Blast, Scroll + zkSync, Linea (7 active, Mantle/Mode are stubs).
   P3: Ethereum, zkSync, Linea (3). P4: Solana (1).
   Non-stub chain with 0 messages: HIGH. Fewer chains than expected: MEDIUM.
   P4 pairsMonitored=0 is expected — do NOT flag.

5. WEBSOCKET MESSAGE RATE (category: WEBSOCKET_HEALTH)
   Scrape provider_ws_messages_total from P1-P4 /metrics.
   Any active chain with 0 messages: CRITICAL (dead WebSocket).
   Chain rate >10x lower than peers: MEDIUM.

6. PROVIDER QUALITY (category: PROVIDER_QUALITY)
   Scrape provider_rpc_call_duration_ms, provider_rpc_errors_total.
   RPC p95 > 500ms: HIGH. > 200ms: MEDIUM.
   error_type=rate_limit > 5: HIGH. error_type=timeout > 10: HIGH.
   Reconnections > 5 in session: HIGH (unstable provider).

SendMessage findings summary to team lead when done.
---
```

```markdown
### Agent 6: "execution-analyst" (model: opus, subagent_type: general-purpose)

PROMPT:
---
CRITICAL: When done, use SendMessage to send findings to the team lead.

You are the EXECUTION ANALYST. Evaluate execution pipeline health,
success rates, outcome distribution, and profitability.
Write findings to: ./autopilot-session/cycle-{CYCLE}/findings/execution-analyst.jsonl

CHECKS:

1. EXECUTION SUCCESS RATE (category: EXECUTION_PROBABILITY)
   curl /stats and /health on port 3005. Read successRate.
   Overall < 30%: HIGH. Any chain with 0% and > 0 attempts: HIGH.

2. RISK STATE (category: RISK_STATE)
   curl /health on port 3005, read drawdownState/riskState.
   HALT: CRITICAL (alive but not trading). CAUTION: HIGH. RECOVERY: MEDIUM.
   Risk state not available: MEDIUM (blind spot).

3. OUTCOME DISTRIBUTION (category: BUSINESS_INTELLIGENCE)
   Scrape opportunity_outcome_total from /metrics on port 3005.
   Revert rate > 30% on any chain: HIGH. Timeout > 20%: MEDIUM.
   Stale > 20%: MEDIUM. gas_too_high > 10%: MEDIUM.

4. PROFIT SLIPPAGE (category: BUSINESS_INTELLIGENCE)
   Scrape profit_slippage_pct histogram.
   Median > 50%: HIGH (detection overestimates). > 25%: MEDIUM.

5. OPPORTUNITY AGE (category: BUSINESS_INTELLIGENCE)
   Scrape opportunity_age_at_execution_ms.
   p95 > chain TTL (fast chains 2s, medium 5s, slow 12s): HIGH.
   Median > 2000ms on any chain: MEDIUM.

6. GAS & PROFITABILITY (category: BUSINESS_INTELLIGENCE)
   Scrape profit_per_execution, gas_cost_per_execution.
   Median profit <= 0: HIGH (losing money). Gas > profit on any chain: HIGH.

7. CIRCUIT BREAKER STATES (category: CIRCUIT_BREAKER)
   curl /circuit-breaker on port 3005.
   Any chain OPEN: HIGH. HALF_OPEN: MEDIUM.

8. BRIDGE RECOVERY (category: BRIDGE_RECOVERY)
   curl /bridge-recovery on port 3005.
   Stuck > 24h: HIGH. > 3 concurrent pending: MEDIUM. Corrupt entries: HIGH.

SendMessage findings summary to team lead when done.
---
```

**Step 2: Commit**

```bash
git add .claude/commands/autopilot.md
git commit -m "feat(autopilot): agent prompts — performance, detection, execution analysts"
```

---

## Task 7: Agent Prompts — Infra Auditor + Dashboard Validator

**Files:**
- Modify: `.claude/commands/autopilot.md`

**Step 1: Add infra-auditor and dashboard-validator prompts**

```markdown
### Agent 8: "infra-auditor" (model: opus, subagent_type: general-purpose)

PROMPT:
---
CRITICAL: When done, use SendMessage to send findings to the team lead.

You are the INFRASTRUCTURE AUDITOR. Check deployment config alignment,
port assignments, timeout hierarchy, and Dockerfile consistency.
Write findings to: ./autopilot-session/cycle-{CYCLE}/findings/infra-auditor.jsonl

CHECKS:

1. PORT ALIGNMENT (category: PORT_COLLISION)
   Read shared/constants/service-ports.json.
   Grep for DEFAULT_HEALTH_CHECK_PORT in services/.
   Compare all ports. Two services same port: HIGH. Port != registry: MEDIUM.

2. INFRASTRUCTURE CONFIG DRIFT (category: INFRA_DRIFT)
   Read infrastructure/fly/*.toml and infrastructure/docker/docker-compose*.yml.
   Compare internal_port, PORT env vars, health check paths against service-ports.json.
   Port mismatch: HIGH. Health check path mismatch: HIGH.
   Dockerfile using wrong Node version (should be node:22-alpine): MEDIUM.

3. TIMEOUT HIERARCHY (category: TIMEOUT_HIERARCHY)
   Grep for shutdownTimeoutMs, SHUTDOWN.*TIMEOUT, connectTimeout, closeServerWithTimeout.
   Build per-service timeout inventory.
   Validate: shutdown > drain > server-close, shutdown > redis-connect.
   Violation: HIGH. Hardcoded timeout: LOW.

4. DOCKERFILE CONSISTENCY (category: INFRA_DRIFT)
   Glob for **/Dockerfile. Grep for FROM node: in each.
   All should use node:22-alpine.
   Check HEALTHCHECK intervals (should be 15s), EXPOSE ports match app ports.

SendMessage findings summary to team lead when done.
---
```

```markdown
### Agent 9: "dashboard-validator" (model: opus, subagent_type: general-purpose)

PROMPT:
---
CRITICAL: When done, use SendMessage to send findings to the team lead.

You are the DASHBOARD VALIDATOR. Check the monitoring dashboard, SSE events,
REST endpoints, type sync, and metrics completeness.
Write findings to: ./autopilot-session/cycle-{CYCLE}/findings/dashboard-validator.jsonl

CHECKS:

1. SPA AVAILABILITY (category: DASHBOARD_AVAILABILITY)
   Glob: services/coordinator/public/index.html. Missing: HIGH.
   curl http://localhost:3000/ — check for React SPA markers (<div id="root">).
   Legacy fallback served: HIGH.

2. SSE CONNECTIVITY (category: DASHBOARD_SSE)
   timeout 10 curl -sf -N http://localhost:3000/api/events | head -40
   Parse event types: expect metrics, services, circuit-breaker within 10s.
   Validate metrics data shape: systemHealth, totalExecutions, successfulExecutions,
   totalProfit, averageLatency, activeServices, totalOpportunities, lastUpdate.
   Missing required field: HIGH (dashboard crash risk).

3. SSE EVENT COVERAGE (category: DASHBOARD_SSE_COVERAGE)
   Read dashboard/src/hooks/useSSE.ts — extract eventTypes array.
   Grep send( in services/coordinator/src/api/routes/sse.routes.ts.
   Client expects event type not emitted by server: HIGH.

4. TYPE SYNC (category: DASHBOARD_TYPE_SYNC)
   Read dashboard/src/lib/types.ts and services/coordinator/src/api/types.ts.
   Compare SystemMetrics, Alert, CircuitBreakerStatus field-by-field.
   Dashboard field not in backend: HIGH (crash risk). Backend field not in dashboard: LOW.

5. REST ENDPOINTS (category: DASHBOARD_REST)
   curl /api/leader, /api/alerts, /api/redis/stats, /ee/health on port 3000.
   Verify response shapes match dashboard expectations.
   /ee/health returns riskState but dashboard expects drawdownState: HIGH.

6. METRICS COMPLETENESS (category: METRICS_COMPLETENESS)
   Scrape /metrics from all services twice, 15s apart.
   Check required metrics present per service (pipeline_latency_p50/p95/p99,
   price_updates_total, opportunities_detected_total, runtime_eventloop_delay_p99_ms,
   runtime_memory_heap_used_mb, etc.).
   > 50% required metrics missing from a service: HIGH. Any missing: MEDIUM.

SendMessage findings summary to team lead when done.
---
```

**Step 2: Commit**

```bash
git add .claude/commands/autopilot.md
git commit -m "feat(autopilot): agent prompts — infra auditor + dashboard validator"
```

---

## Task 8: Triage Step — Dedup, Prioritize, Build Fix Manifest

**Files:**
- Modify: `.claude/commands/autopilot.md`

**Step 1: Add the triage logic section**

```markdown
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

Write ./autopilot-session/cycle-{CYCLE}/fix-manifest.json:
{
  "cycle": N,
  "total_findings": X,
  "fixable": Y,
  "deferred": Z,
  "fixes": [sorted array of fixable findings with priority rank],
  "deferred_items": [LOW + unfixable findings with reasons]
}

### 2F — Check if fixes needed

If fixable == 0:
  Write empty fixes-applied.json. Skip to STEP 6 (convergence check).
```

**Step 2: Commit**

```bash
git add .claude/commands/autopilot.md
git commit -m "feat(autopilot): Step 2 triage — dedup, prioritize, fix manifest"
```

---

## Task 9: Fix Implementer Agent Prompt + Fix Step

**Files:**
- Modify: `.claude/commands/autopilot.md`

**Step 1: Add the fix-implementer agent prompt and Step 3 logic**

```markdown
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## STEP 3 — FIX (fix-implementer agent)
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Dispatch the fix-implementer agent with the fix manifest.

### Agent 11: "fix-implementer" (model: opus, subagent_type: general-purpose)

PROMPT:
---
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

SendMessage your summary to the team lead when done: how many applied, how many failed, which files changed.
---

After fix-implementer completes, the orchestrator:
1. Read fixes-applied.json
2. Count total lines changed (sum lines_added + lines_removed across all applied fixes)
3. If total lines > 500: REVERT all changes (git checkout -- .), mark cycle as "exceeded_line_cap"
4. Run `npm run typecheck` as a final safety check
5. If typecheck fails: REVERT, mark cycle as "typecheck_failed"
```

**Step 2: Commit**

```bash
git add .claude/commands/autopilot.md
git commit -m "feat(autopilot): Step 3 fix — implementer agent prompt + safety checks"
```

---

## Task 10: Rebuild/Restart Step

**Files:**
- Modify: `.claude/commands/autopilot.md`

**Step 1: Add Step 4 — rebuild and restart logic**

```markdown
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
```

**Step 2: Commit**

```bash
git add .claude/commands/autopilot.md
git commit -m "feat(autopilot): Step 4 rebuild and restart with failure recovery"
```

---

## Task 11: Regression Guard Agent + Validate Step

**Files:**
- Modify: `.claude/commands/autopilot.md`

**Step 1: Add Step 5 — regression guard agent prompt and validation logic**

```markdown
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## STEP 5 — VALIDATE (regression-guard agent)
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Dispatch regression-guard agent to verify fixes didn't break anything.

### Agent 12: "regression-guard" (model: opus, subagent_type: general-purpose)

PROMPT:
---
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
{
  "cycle": N,
  "verdict": "PASS" | "FAIL",
  "regressions": [
    {
      "type": "typecheck|test|health|domain|pipeline",
      "severity": "CRITICAL|HIGH",
      "description": "..."
    }
  ],
  "new_findings": [findings discovered during domain re-checks],
  "metrics_comparison": {
    "baseline_success_rate": X,
    "current_success_rate": Y,
    "baseline_event_loop_p99": X,
    "current_event_loop_p99": Y
  }
}

If verdict is FAIL with any CRITICAL regression: the orchestrator will REVERT this cycle.

SendMessage your verdict and regression details to the team lead.
---

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
```

**Step 2: Commit**

```bash
git add .claude/commands/autopilot.md
git commit -m "feat(autopilot): Step 5 regression guard agent + validation logic"
```

---

## Task 12: Commit & Converge Step + Dirty-Domain Tracking

**Files:**
- Modify: `.claude/commands/autopilot.md`

**Step 1: Add Step 6 — commit, convergence check, dirty-domain computation**

```markdown
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
{
  "changed_files": ["path/to/file.ts", ...],
  "dirty_domains": ["streams-analyst", "execution-analyst", "e2e-flow-tracer"],
  "reason": {
    "streams-analyst": "shared/core/src/redis/streams.ts modified",
    "execution-analyst": "services/execution-engine/src/consumer.ts modified",
    "e2e-flow-tracer": "always included"
  }
}

### 6C — Write cycle summary

Write ./autopilot-session/cycle-{CYCLE}/cycle-summary.json:
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
```

**Step 2: Commit**

```bash
git add .claude/commands/autopilot.md
git commit -m "feat(autopilot): Step 6 commit, convergence, dirty-domain tracking"
```

---

## Task 13: Phase Final — Report + Cleanup

**Files:**
- Modify: `.claude/commands/autopilot.md`

**Step 1: Add the final phase — stop services, generate report**

```markdown
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

### Final-D — Copy report to project docs

cp ./autopilot-session/REPORT.md docs/reports/AUTOPILOT_REPORT_{SESSION_ID}.md

Output: "Autopilot session {SESSION_ID} complete. Exit: {reason}. Report: docs/reports/AUTOPILOT_REPORT_{SESSION_ID}.md"
```

**Step 2: Commit**

```bash
git add .claude/commands/autopilot.md
git commit -m "feat(autopilot): Phase Final — report generation + cleanup"
```

---

## Task 14: Review, Polish, and Verify

**Files:**
- Modify: `.claude/commands/autopilot.md`

**Step 1: Full file review**

Read the complete autopilot.md file from top to bottom. Verify:
- [ ] Header and critical rules are clear
- [ ] System inventory matches monitoring.md (29 streams, 7 services, 7 consumer groups)
- [ ] Phase 0 bootstrap covers build, redis, services, baseline
- [ ] Cycle loop structure is correct (6 steps in order)
- [ ] All 10 analysis agent prompts are present and complete
- [ ] Each agent prompt starts with SendMessage instruction
- [ ] Each agent prompt specifies findings output path with {CYCLE} placeholder
- [ ] Triage step includes dedup, blocklist check, prioritization
- [ ] Fix implementer prompt includes all safety rules (15 cap, typecheck, no API changes)
- [ ] Rebuild step has failure recovery (clean build, revert)
- [ ] Regression guard prompt includes typecheck, tests, health, pipeline checks
- [ ] Convergence logic covers all 5 exit conditions
- [ ] Dirty-domain mapping table is complete
- [ ] Report template includes all sections from design doc
- [ ] No references to monitoring.md internals (this command is independent)

**Step 2: Fix any issues found during review**

Address gaps, fix inconsistencies, ensure all {CYCLE} and {SESSION_ID} placeholders are used consistently.

**Step 3: Verify file structure**

Run: `wc -l .claude/commands/autopilot.md`
Expected: 3000-5000 lines

Run: `grep -c "### Agent" .claude/commands/autopilot.md`
Expected: 12 (10 analysis + 2 fix/validation agents)

Run: `grep -c "STEP [0-9]" .claude/commands/autopilot.md`
Expected: 6 (steps 1-6)

Run: `grep -c "PHASE" .claude/commands/autopilot.md`
Expected: at least 3 (Phase 0, cycle phases, Phase Final)

**Step 4: Final commit**

```bash
git add .claude/commands/autopilot.md
git commit -m "feat(autopilot): review polish + verification complete"
```

---

## Task 15: Smoke Test — Dry Run Invocation

**Step 1: Invoke the command**

Run `/autopilot` in Claude Code. Observe:
- Does it start Phase 0 correctly?
- Does it build and start Redis?
- Does it start services?
- Does it create the autopilot-session directory?
- Does it dispatch agents for Cycle 1?

**Step 2: Verify agent dispatch**

Check that all 10 analysis agents are spawned with:
- model: opus explicitly set
- SendMessage instruction at top of prompt
- Correct output file paths

**Step 3: Observe one full cycle**

Let Cycle 1 complete. Verify:
- Findings appear in autopilot-session/cycle-1/findings/
- Triage produces fix-manifest.json
- Fix implementer applies changes
- Rebuild succeeds
- Regression guard validates
- Git commit is created (if fixes applied)
- Convergence check runs

**Step 4: Document any issues**

If the command fails or behaves unexpectedly, note the issue and fix it.
This is the final integration test — iterate until one cycle completes cleanly.

---

## Summary

| Task | Description | Commit |
|------|-------------|--------|
| 1 | Command skeleton + system inventory | `feat(autopilot): command skeleton with system inventory` |
| 2 | Phase 0 bootstrap | `feat(autopilot): Phase 0 bootstrap` |
| 3 | Cycle loop structure | `feat(autopilot): cycle loop structure` |
| 4 | Agent prompts: static-analyst + security-config-auditor | `feat(autopilot): agents — static + security` |
| 5 | Agent prompts: health + streams + e2e flow | `feat(autopilot): agents — health, streams, e2e` |
| 6 | Agent prompts: performance + detection + execution | `feat(autopilot): agents — perf, detection, exec` |
| 7 | Agent prompts: infra + dashboard | `feat(autopilot): agents — infra + dashboard` |
| 8 | Step 2 triage logic | `feat(autopilot): triage step` |
| 9 | Step 3 fix implementer | `feat(autopilot): fix implementer` |
| 10 | Step 4 rebuild/restart | `feat(autopilot): rebuild/restart` |
| 11 | Step 5 regression guard | `feat(autopilot): regression guard` |
| 12 | Step 6 commit + convergence | `feat(autopilot): convergence logic` |
| 13 | Phase Final report | `feat(autopilot): report generation` |
| 14 | Review + polish | `feat(autopilot): review polish` |
| 15 | Smoke test dry run | (iteration, no fixed commit) |
