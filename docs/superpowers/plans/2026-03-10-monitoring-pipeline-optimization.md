# Monitoring Pipeline Optimization v4.0 — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the monolithic `.claude/commands/monitoring.md` (4,369 lines, ~194KB) into a modular architecture with auto-generated inventory, compressed checks, and externalized config — reducing context usage from 24% to ~10%, eliminating 35 coupling points, and cutting execution time from ~365s to ~200s.

**Architecture:** Orchestrator hub (~100 lines) loads phase-specific modules on-demand via Read tool. Pre-flight auto-generates `inventory.json` from source code, eliminating hardcoded coupling. All thresholds externalized to `config.json`. Checks compressed using compact flag notation (69% average compression).

**Tech Stack:** Markdown (Claude Code commands), JSON (config/inventory), Bash (pre-flight scripts)

**Spec:** `docs/superpowers/specs/2026-03-10-monitoring-pipeline-optimization-design.md`

---

## File Structure

| Action | File | Purpose | Approx Lines |
|--------|------|---------|-------------|
| Create | `.claude/commands/monitoring/config.json` | Externalized thresholds, go/no-go rules, placeholder metrics | ~80 |
| Create | `.claude/commands/monitoring/00-inventory-generator.md` | Pre-flight: reads source → generates inventory.json | ~80 |
| Create | `.claude/commands/monitoring/01-preflight.md` | Session setup, data mode, dependency checks | ~100 |
| Create | `.claude/commands/monitoring/02-static-analysis.md` | Phase 1: 24 compressed checks (23 original minus 1W, plus 3AL/3AM reclassified in) + incremental mode | ~500 |
| Create | `.claude/commands/monitoring/03-startup.md` | Phase 2: Redis, services, readiness (+ Check 1W reclassified from Phase 1) | ~200 |
| Create | `.claude/commands/monitoring/04-runtime.md` | Phase 3: 42 compressed runtime checks (44 original minus 3AL/3AM reclassified out) + endpoint caching + redis batching | ~800 |
| Create | `.claude/commands/monitoring/05-smoke-test.md` | Phase 4: 12 compressed smoke test steps | ~300 |
| Create | `.claude/commands/monitoring/06-report.md` | Phase 5: shutdown, regression, report template | ~200 |
| Rewrite | `.claude/commands/monitoring.md` | Orchestrator hub: role, rules, severity legend, phase loading | ~100 |

**After migration:** Total ~2,360 lines across all modules (46% reduction from 4,369).

---

## Chunk 1: Foundation (Config + Inventory Generator + Preflight)

### Task 1: Create directory structure and config.json

**Files:**
- Create: `.claude/commands/monitoring/config.json`

- [ ] **Step 1: Create the monitoring subdirectory**

```bash
mkdir -p .claude/commands/monitoring
```

- [ ] **Step 2: Write config.json with all externalized thresholds**

Create `.claude/commands/monitoring/config.json` with these values extracted from the current monitoring.md checks:

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
    "smokeTestTimeoutSec": 60,
    "profitSlippageWarnPct": 25,
    "profitSlippageCritPct": 50,
    "revertRateCritPct": 30,
    "timeoutRateWarnPct": 20,
    "staleRateWarnPct": 20,
    "gasTooHighRateWarnPct": 10,
    "executionSuccessRateCritPct": 30,
    "wsReconnectWarn": 5,
    "wsReconnectCrit": 10,
    "rpcErrorRateWarnPct": 5,
    "rpcErrorRateCritPct": 10
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
  ],
  "perChainStalenessThresholds": {
    "bsc": 6,
    "polygon": 4,
    "avalanche": 4,
    "fantom": 4,
    "arbitrum": 2,
    "optimism": 4,
    "base": 4,
    "scroll": 6,
    "blast": 4,
    "mantle": 4,
    "mode": 4,
    "ethereum": 24,
    "zksync": 4,
    "linea": 6,
    "solana": 2
  }
}
```

- [ ] **Step 3: Verify config.json is valid JSON**

Run: `cd C:/Users/kj2bn8f/arbitrage_new && cat .claude/commands/monitoring/config.json | jq .`
Expected: Pretty-printed JSON output with no errors.

- [ ] **Step 4: Commit**

```bash
git add .claude/commands/monitoring/config.json
git commit -m "feat(monitoring): add externalized config.json with thresholds and go/no-go rules"
```

---

### Task 2: Create inventory auto-generator module

**Files:**
- Create: `.claude/commands/monitoring/00-inventory-generator.md`

The inventory generator reads source files and produces `./monitor-session/config/inventory.json`. This eliminates all 35 hardcoded coupling points in the current monitoring.md.

- [ ] **Step 1: Write 00-inventory-generator.md**

This module instructs the orchestrator to read 6 source files and generate a structured inventory JSON. It replaces the hardcoded System Inventory table (~65 lines in the current monitoring.md).

Source files to read:
- `shared/types/src/events.ts` → `RedisStreams` const (29 stream names)
- `shared/core/src/redis/streams.ts` → `STREAM_MAX_LENGTHS` (29 MAXLEN values, line ~441)
- `shared/constants/service-ports.json` → service ports (read JSON directly)
- `shared/config/src/partitions.ts` → `PARTITIONS` array (line ~227, 4 partitions with chain lists)
- `shared/config/src/feature-flags.ts` → `FEATURE_*` env var patterns (~23 flags)
- Consumer groups: Grep `consumerGroup|createConsumerGroup|XREADGROUP GROUP` in `services/` + `shared/core/`

The module should contain:
1. Instructions to Read each source file
2. Extraction rules for each data type (what patterns to look for, how to parse)
3. The target `inventory.json` schema
4. Validation: stream count >= 29, service count >= 7, partition count = 4
5. Instructions to write the assembled JSON to `./monitor-session/config/inventory.json`

```markdown
# Inventory Generator — Pre-Flight Module
# Reads source code to auto-generate inventory.json
# Eliminates all hardcoded coupling points

Generate `./monitor-session/config/inventory.json` by reading source files.
All downstream modules reference this file instead of hardcoded values.

## Step 1: Stream Names

Read `shared/types/src/events.ts`. Extract all values from the `RedisStreams` const
(object at ~line 19). Each value is a stream name like `stream:price-updates`.

## Step 2: MAXLEN Values

Read `shared/core/src/redis/streams.ts`. Find `STREAM_MAX_LENGTHS` (static readonly
property at ~line 441). Extract the mapping of stream name → MAXLEN number.

## Step 3: Service Ports

Read `shared/constants/service-ports.json`. Parse the `services` object directly.
Each key is a service name, value is the port number.

## Step 4: Partition Config

Read `shared/config/src/partitions.ts`. Extract the `PARTITIONS` array (~line 227).
For each partition, capture: `partitionId`, `chains[]`, port (from service-ports.json
`partitions` object).

## Step 5: Feature Flags

Read `shared/config/src/feature-flags.ts`. Extract all `process.env.FEATURE_*`
patterns. For each, record the env var name and the comparison pattern
(`=== 'true'` vs `!== 'false'`).

## Step 6: Consumer Groups

Use Grep to find consumer group names in `services/` and `shared/core/src/`:
- Pattern: `consumerGroup|groupName|XREADGROUP GROUP`
- Exclude: `node_modules`, test files, `__tests__`

Extract unique group names. Expected groups (7):
`coordinator-group`, `cross-chain-detector-group`, `execution-engine-group`,
`mempool-detector-group`, `orderflow-pipeline`, `self-healing-manager`,
`failover-{serviceName}` (dynamic).

## Step 7: Assemble and Validate

Write `./monitor-session/config/inventory.json`:

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
  "consumerGroups": [
    { "name": "coordinator-group", "streams": ["health", "opportunities", "..."] }
  ],
  "featureFlags": [
    { "envVar": "FEATURE_FLASH_LOAN_AGGREGATOR", "pattern": "=== 'true'" }
  ],
  "counts": {
    "streams": 29,
    "services": 11,
    "partitions": 4,
    "consumerGroups": 7,
    "featureFlags": 23
  }
}
```

**Validation rules:**
- `counts.streams >= 29` (fail if fewer — source file may have changed)
- `counts.services >= 7` (the 7 dev:all services)
- `counts.partitions == 4`
- Every stream in `streams[]` has a non-zero `maxLen`
- Every partition has at least 1 chain

If validation fails, emit a CRITICAL finding to `static-analysis.jsonl` and continue
(downstream checks will use partial inventory with warnings).
```

- [ ] **Step 2: Verify the module is self-contained**

Read the created file and verify:
- All 6 source file paths are correct
- Extraction patterns match actual source code structure
- The output schema covers all data needed by downstream modules
- Validation rules catch missing/incomplete data

- [ ] **Step 3: Commit**

```bash
git add .claude/commands/monitoring/00-inventory-generator.md
git commit -m "feat(monitoring): add inventory auto-generator module (00)"
```

---

### Task 3: Create preflight module

**Files:**
- Create: `.claude/commands/monitoring/01-preflight.md`

This module handles session workspace creation, data mode selection, and dependency checks. Extracted from lines ~158-270 of current monitoring.md.

- [ ] **Step 1: Write 01-preflight.md**

Extract and compress the pre-flight sections from current monitoring.md:
- Dependency checks (`jq`, `redis-cli` — lines 163-165)
- Session workspace creation (lines 167-172)
- Data mode selection (lines 177-270)
- Mode-specific prerequisites (RPC URLs, Windows TLS, testnet checks)
- Mode reference labels (`[SIM-ONLY]`, `[LIVE-ONLY]`, `[ALL-MODES]`)

Compress by:
- Removing explanatory paragraphs (keep only the bash commands and flag rules)
- Using compact flag notation: `condition → SEV:CAT` instead of verbose format
- Combining mode-specific bash blocks where possible

Target: ~100 lines (from ~112 lines currently — modest compression since this section is already fairly dense).

The module content should follow this structure:

```markdown
# Pre-Flight — Session Setup & Data Mode

## Dependencies

```bash
command -v jq >/dev/null 2>&1 || { echo "CRITICAL: jq required"; exit 1; }
command -v redis-cli >/dev/null 2>&1 || { echo "CRITICAL: redis-cli required"; exit 1; }
```

## Session Workspace

```bash
mkdir -p ./monitor-session/{logs,findings,streams,config,history}
SESSION_ID=$(date +%Y%m%d_%H%M%S)
echo $SESSION_ID > ./monitor-session/SESSION_ID
CURRENT_SHA=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
echo $CURRENT_SHA > ./monitor-session/current.sha
echo "Session $SESSION_ID initialized (git SHA: $CURRENT_SHA)"
```

## Data Mode Selection

| Mode | Prices | Execution | npm Script |
|------|--------|-----------|------------|
| `simulation` (default) | Synthetic (ChainSimulator) | Mock | `dev:monitor` |
| `live` | Real RPC (WebSocket) | Mock | `dev:monitor:live` |
| `testnet` | Real RPC (WebSocket) | Real (testnet) | `dev:monitor:testnet` |

```bash
MONITOR_DATA_MODE="${MONITOR_DATA_MODE:-simulation}"
echo "$MONITOR_DATA_MODE" > ./monitor-session/DATA_MODE
```

## Mode Prerequisites

**`live` or `testnet`:**

```bash
if [ "$MONITOR_DATA_MODE" != "simulation" ]; then
  RPC_COUNT=$(grep -cE "^[A-Z_]+_RPC_URL=" .env .env.local 2>/dev/null | awk -F: '{s+=$NF}END{print s+0}')
  KEY_COUNT=$(grep -cE "^(DRPC|ANKR|INFURA|ALCHEMY)_API_KEY=" .env .env.local 2>/dev/null | awk -F: '{s+=$NF}END{print s+0}')
  if [ "$RPC_COUNT" -eq 0 ] && [ "$KEY_COUNT" -eq 0 ]; then
    echo '{"phase":"PRE_FLIGHT","findingId":"PF-001","category":"RPC_CONFIG","severity":"CRITICAL","title":"No RPC URLs or provider keys for live mode"}' >> ./monitor-session/findings/static-analysis.jsonl
    MONITOR_DATA_MODE="simulation"
    echo "$MONITOR_DATA_MODE" > ./monitor-session/DATA_MODE
  fi
  # Windows TLS check
  if [ "$(uname -o 2>/dev/null)" = "Msys" ] || [ "$OS" = "Windows_NT" ]; then
    TLS_VAR=$(grep -c "NODE_TLS_REJECT_UNAUTHORIZED=0" .env .env.local 2>/dev/null | awk -F: '{s+=$NF}END{print s+0}')
    [ "$TLS_VAR" -eq 0 ] && echo "WARNING: Windows detected, NODE_TLS_REJECT_UNAUTHORIZED=0 not set"
  fi
fi
```

**`testnet` only:**

```bash
if [ "$MONITOR_DATA_MODE" = "testnet" ]; then
  TESTNET_FLAG=$(grep -c "TESTNET_EXECUTION_MODE=true" .env .env.local 2>/dev/null | awk -F: '{s+=$NF}END{print s+0}')
  [ "$TESTNET_FLAG" -eq 0 ] && echo "WARNING: TESTNET_EXECUTION_MODE=true not found"
fi
```

## Mode Labels

- `[SIM-ONLY]` — simulation mode only
- `[LIVE-ONLY]` — live or testnet modes
- `[ALL-MODES]` — all modes

Read mode for downstream: `MONITOR_DATA_MODE=$(cat ./monitor-session/DATA_MODE)`
```

- [ ] **Step 2: Commit**

```bash
git add .claude/commands/monitoring/01-preflight.md
git commit -m "feat(monitoring): add preflight module (01) with session setup and data mode"
```

---

## Chunk 2: Phase 1 — Static Analysis (Compressed)

### Task 4: Compress Phase 1 checks into 02-static-analysis.md

**Files:**
- Create: `.claude/commands/monitoring/02-static-analysis.md`

This is the largest compression task. The current Phase 1 spans lines ~274-1182 (~908 lines) with 23 checks. Target: ~500 lines using compact flag notation.

**Check reclassifications per design spec:**
- Move Check 3AL (SSE Coverage) INTO Phase 1 (it only uses Read/Grep)
- Move Check 3AM (Type Sync) INTO Phase 1 (it only uses Read)
- Move Check 1W (Redis Security) OUT to Phase 2 (it needs redis-cli, which needs Redis running)

So Phase 1 gets 23 - 1 (1W out) + 2 (3AL, 3AM in) = 24 checks.

- [ ] **Step 1: Write the incremental mode header and finding format**

Start the file with:
- Phase header and scope
- Incremental mode logic (lines 279-327 compressed)
- Finding format (compact — just the JSON schema, no separate explanation for each field)
- Finding ID prefix: `SA-NNN`

```markdown
# Phase 1 — Static Analysis
# 24 checks. No services needed. Uses Glob, Grep, Read only.
# Reads inventory from `./monitor-session/config/inventory.json`
# Reads thresholds from `.claude/commands/monitoring/config.json`

Record findings to `./monitor-session/findings/static-analysis.jsonl`:
```json
{"phase":"STATIC","findingId":"SA-NNN","category":"...","severity":"...","title":"...","service":"...","evidence":"...","expected":"...","actual":"...","recommendation":"..."}
```

## Incremental Mode

```bash
LAST_SHA=$(cat ./monitor-session/last-run.sha 2>/dev/null || echo "")
CURRENT_SHA=$(cat ./monitor-session/current.sha)
if [ -n "$LAST_SHA" ] && [ "$LAST_SHA" != "unknown" ] && [ "$LAST_SHA" != "$CURRENT_SHA" ]; then
  git diff --name-only "$LAST_SHA".."$CURRENT_SHA" > ./monitor-session/changed-files.txt
  INCREMENTAL=true
else
  INCREMENTAL=false
fi
```

Checks marked **INC** can be narrowed to changed files when `INCREMENTAL=true`.
Checks marked **FULL** always scan the full codebase.
```

- [ ] **Step 2: Compress checks 1A through 1F**

Apply the compact format to each check. Example compression pattern:

**Before (Check 1A, ~25 lines):**
```
### Check 1A — Stream Name Declaration Audit
**Goal:** Every stream name used in code must reference...
**Method:**
1. Read `shared/types/src/events.ts`...
2. Use Grep to find all files containing...
3. In each matching file, check whether...
**Flag:** Any hardcoded stream name → severity: **HIGH**...
**Exceptions:** Test files...
```

**After (Check 1A, ~10 lines):**
```
### 1A — Stream Name Declaration [FULL]

Verify all stream names in code use `RedisStreams` const from inventory, not hardcoded strings.

1. Get canonical stream names from `inventory.json`.streams[].name
2. Grep for `xadd|XADD|xReadGroup|XREADGROUP|createConsumerGroup` in `.ts` files (exclude node_modules)
3. In matches, check stream name args use RedisStreams const vs hardcoded `'stream:...'`

Flags:
- Hardcoded stream name string → H:STREAM_DECLARATION
- Exception: test files may use hardcoded strings
```

Compress all 6 checks (1A-1F) following this pattern. Key rules:
- Remove "Goal:" prefix — just state what the check does in one line
- Remove "Method:" prefix — just list the numbered steps
- Use compact flags: `condition → SEV:CAT` (e.g., `→ H:STREAM_DECLARATION`)
- Severity codes: C=CRITICAL, H=HIGH, M=MEDIUM, L=LOW, I=INFO
- Keep bash code blocks when they provide exact commands
- Remove rationale paragraphs (the "why") — keep only the "what" and "how"

- [ ] **Step 3: Compress checks 1G through 1N**

Source location: Find each check by searching for `### Check 1G`, `### Check 1H`, etc. in current `monitoring.md`. Approximate ranges:
- 1G HMAC (~line 519), 1H Feature Flags (~line 570), 1I Risk Config (~line 635), 1J Unsafe Parse (~line 685)
- 1K Redis Parity (~line 730), 1L Port Collision (~line 795), 1M Silent Errors (~line 850), 1N Type Fidelity (~line 910)

Key compression targets:
- Check 1G (HMAC) — keep the file list but remove signing explanation
- Check 1M (Silent Errors) — keep regex patterns, remove explanations

Example compressed Check 1M (~8 lines from ~40 lines):
```
### 1M — Silent Error Swallowing [INC]

Find empty catch blocks that silently swallow errors.

1. Grep for `catch\s*\(` in `.ts` files (exclude node_modules, tests)
2. For each match, check if the catch block is empty or only has a comment
3. Exclude: catch blocks with `return` values, re-throw patterns, comment-only catches for expected errors

Flags:
- Empty catch block in service code → M:SILENT_ERROR
- Empty catch in shared/core hot path → H:SILENT_ERROR
- All catches have handling → I:SILENT_ERROR
```

Where checks reference inventory data (stream names, ports, etc.), replace hardcoded values with `inventory.json` references.

- [ ] **Step 4: Compress checks 1O through 1R**

Source location: `### Check 1O` (~line 955), `### Check 1P` (~line 990), `### Check 1Q` (~line 1010), `### Check 1R` (~line 1035).

Compress checks 1O (Redis Key Registry), 1P (ADR Compliance), 1Q (Infra Config), 1R (Timeout Hierarchy). Each should be ~10-15 lines compressed.

- [ ] **Step 5: Compress checks 1S through 1V and add reclassified 3AL, 3AM**

Source location: `### Check 1S` (~line 1058), `### Check 1T` (~line 1082), `### Check 1U` (~line 1105), `### Check 1V` (~line 1125).
Reclassified: `### Check 3AL` — search for `3AL` in monitoring.md (~line 3150). `### Check 3AM` — search for `3AM` (~line 3210).

Compress the new v3.2 checks (1S Build Staleness, 1T Testnet URL Safety, 1U CORS Config, 1V Contract Pause).

Then add the two checks reclassified from Phase 3:
- **1X (was 3AL) — SSE Event Coverage**: Uses only Read/Grep to check client vs server event types. No services needed.
- **1Y (was 3AM) — Type Sync Audit**: Uses only Read to compare TypeScript types. No services needed.

(Skip 1W — it moves to Phase 2 since it needs `redis-cli`.)

- [ ] **Step 6: Add Phase 1 summary block**

```markdown
## Phase 1 Summary

After all 24 checks:
```
PHASE 1 COMPLETE — Static Analysis (24 checks)
  CRITICAL: <n>  HIGH: <n>  MEDIUM: <n>  LOW: <n>  INFO: <n>
  Total findings: <n>
```

Continue to Phase 2 even if CRITICAL findings exist.
```

- [ ] **Step 7: Verify line count and coverage**

Read the file and verify:
- All 24 checks are present (1A-1V minus 1W, plus 1X/1Y from reclassification)
- Total line count is ~500 (allow ±50)
- All inventory references use `inventory.json` not hardcoded values
- All threshold references use `config.json` not inline numbers
- Compact flag notation used consistently

- [ ] **Step 8: Commit**

```bash
git add .claude/commands/monitoring/02-static-analysis.md
git commit -m "feat(monitoring): add compressed static analysis module (02) — 24 checks"
```

---

## Chunk 3: Phase 2 & 3 (Startup + Runtime)

### Task 5: Create Phase 2 startup module

**Files:**
- Create: `.claude/commands/monitoring/03-startup.md`

Extract from lines ~1185-1458 of current monitoring.md. Phase 2 handles Redis startup, service startup, readiness polling, and stream discovery. Add Check 1W (Redis Security) reclassified from Phase 1.

- [ ] **Step 1: Write 03-startup.md**

Structure:
1. **Step 2A — Start Redis** (compact, ~10 lines)
   - `npm run dev:redis:memory &`, sleep 3, PING check
   - PING fail → C:REDIS_START, skip to Phase 5
2. **Step 2A.5 — Redis Security (was 1W)** (~10 lines)
   - `redis-cli CONFIG GET requirepass`, `CONFIG GET bind`
   - requirepass empty AND bind not 127.0.0.1 → H:REDIS_SECURITY
3. **Step 2B — Start services** (mode-conditional, ~30 lines)
   - Simulation/live/testnet mode table (3 rows)
   - `npm run dev:monitor &` (or variant)
   - Memory optimization notes (CONSTRAINED_MEMORY, CACHE_L1_SIZE_MB=8)
4. **Step 2C — Readiness polling** (~30 lines)
   - Poll `inventory.json`.services for ready endpoints
   - Use timeouts from `config.json`.readinessTimeouts
   - Coordinator: `/api/health/ready`, partitions+EE+CC: `/ready`
5. **Step 2D — Stream discovery** (~20 lines)
   - `redis-cli SCAN 0 MATCH stream:* COUNT 100`
   - Compare discovered vs `inventory.json`.streams
   - Missing stream → M:STREAM_TOPOLOGY, unexpected → L:STREAM_TOPOLOGY
6. **Step 2E — Endpoint verification** (~20 lines)
   - Test /ready, /metrics, /api/metrics/prometheus
   - Cross-check with infra health configs
7. **Phase 2 summary** (~10 lines)

Target: ~200 lines total.

All port numbers, stream names, and service names reference `inventory.json`.
Readiness timeouts reference `config.json`.

- [ ] **Step 2: Commit**

```bash
git add .claude/commands/monitoring/03-startup.md
git commit -m "feat(monitoring): add startup module (03) with Check 1W reclassified"
```

---

### Task 6: Create Phase 3 runtime module with endpoint caching and redis batching

**Files:**
- Create: `.claude/commands/monitoring/04-runtime.md`

This is the largest module. Current Phase 3 spans lines ~1462-3505 (~2,043 lines) with 44 checks across 9 subsections. Target: ~800 lines.

Two major optimizations integrated:
1. **Endpoint caching (O-01):** Fetch all endpoints once at Phase 3 start
2. **Redis command batching:** Replace ~130 individual redis-cli calls with ~10 batched heredocs

After reclassifying 3AL and 3AM to Phase 1, Phase 3 has 42 checks.

- [ ] **Step 1: Write the endpoint caching preamble**

Start the file with the cache-all-endpoints block from the design spec:

```markdown
# Phase 3 — Runtime Validation
# 42 checks, 9 subsections. All services running.
# Reads inventory from `./monitor-session/config/inventory.json`
# Reads thresholds from `.claude/commands/monitoring/config.json`

Record findings to `./monitor-session/findings/runtime.jsonl`.

## Endpoint Cache (O-01)

Fetch all endpoints once. Subsequent checks read from cache files.

```bash
mkdir -p ./monitor-session/config/cache
for port in $(jq -r '.services[] | select(.port >= 3000 and .port <= 3006) | .port' ./monitor-session/config/inventory.json); do
  curl -sf --max-time 10 http://localhost:$port/health > ./monitor-session/config/cache/health_$port.json 2>/dev/null &
  curl -sf --max-time 10 http://localhost:$port/stats > ./monitor-session/config/cache/stats_$port.json 2>/dev/null &
  curl -sf --max-time 10 http://localhost:$port/metrics > ./monitor-session/config/cache/metrics_$port.txt 2>/dev/null &
done
curl -sf --max-time 10 http://localhost:3000/api/metrics/prometheus > ./monitor-session/config/cache/prom_3000.txt 2>/dev/null &
curl -sf --max-time 10 http://localhost:3000/api/diagnostics > ./monitor-session/config/cache/diagnostics.json 2>/dev/null &
curl -sf --max-time 10 http://localhost:3000/api/leader > ./monitor-session/config/cache/leader.json 2>/dev/null &
wait
```

Note: The spec hardcodes `for port in 3000 3001 3002 3003 3004 3005 3006`. We use dynamic
inventory-driven ports instead — architecturally better. The `select(.port >= 3000 and .port <= 3006)`
filter excludes optional services (3008 mempool, 3009 coordinator-worker, 3100 monolith).

Cache stale after 30s. Re-fetch only for Phase 4 post-smoke comparisons.

## Redis Batch (O-02)

Batch all stream inventory commands into one heredoc:

```bash
redis-cli << 'BATCH' > ./monitor-session/config/cache/stream-inventory.txt
$(for stream in $(jq -r '.streams[].name' ./monitor-session/config/inventory.json); do
  echo "XINFO STREAM $stream"
  echo "XINFO GROUPS $stream"
  echo "XLEN $stream"
done)
BATCH
```
```

- [ ] **Step 2: Compress Section 3.1 — Service Health & Schema (3A-3C)**

Source: search for `Section 3.1` in monitoring.md (~line 1498). 3 checks: 3A (~line 1500), 3B (~line 1560), 3C (~line 1620).

Compress each to ~15 lines using cached endpoint data.

Example compressed Check 3A:
```markdown
### 3A — Service Health Matrix

Read cached `health_<port>.json` for all 7 services from inventory. Parse status fields.

Flags:
- Service not in health response → C:SERVICE_HEALTH
- Service status != "healthy" → H:SERVICE_HEALTH
- uptime < 30s → M:SERVICE_HEALTH (just started, may be unstable)
- All healthy → I:SERVICE_HEALTH
```

- [ ] **Step 3: Compress Section 3.2 — Risk & Circuit Breakers (3D-3G)**

Source: search for `Section 3.2` (~line 1660). 4 checks: 3D (~line 1662), 3E (~line 1690), 3F (~line 1700), 3G (~line 1730).

3F and 3G are placeholder checks for not-yet-implemented metrics.
For placeholders, check `config.json`.placeholderMetrics — if the metric is listed, emit INFO directly (skip curl/grep).

Example compressed Check 3F (~8 lines from ~35 lines):
```markdown
### 3F — CB Transition History (Placeholder: E1-E2)

Check cached `metrics_3005.txt` for `circuit_breaker_transitions_total`.

If in `config.json`.placeholderMetrics → I:CB_TRANSITIONS ("not yet implemented")
If metric exists:
- >5 transitions in session → M:CB_TRANSITIONS (flapping)
- CLOSED→OPEN >3 for same chain → H:CB_TRANSITIONS (chain repeatedly failing)
Also: `redis-cli XREVRANGE stream:circuit-breaker + - COUNT 20` — >5 alternating states in 60s → H:CB_FLAPPING
```

- [ ] **Step 4: Compress Section 3.3 — Data Flow & DLQ (3H-3N)**

Source: search for `Section 3.3` (~line 1755). 7 checks: 3H (~line 1757), 3I (~line 1777), 3J (~line 1820), 3K (~line 1870), 3L (~line 1910), 3M (~line 1950), 3N (~line 1980).

The stream topology check (3I) and consumer lag check (3J) are the biggest beneficiaries of redis batching — they currently loop over 29 streams individually. Replace with references to the batched `stream-inventory.txt` output.

Check 3N (MAXLEN Trim Detection) references MAXLEN values — use `inventory.json`.streams[].maxLen instead of hardcoded values. This fixes the known drift bug (Check 3N had `exec-requests-fast: 50000` but source has `25000`).

- [ ] **Step 5: Compress Section 3.4 — Runtime Performance (3O-3Q)**

Source: search for `Section 3.4` (~line 2020). 3 checks: 3O (~line 2022), 3P (~line 2080), 3Q (~line 2120).

3 checks using cached `metrics_<port>.txt` responses. Reference thresholds from `config.json` (eventLoopP99WarnMs, gcMajorWarn, rssMbCrit, heapRatioWarn).

Use the spec's compression pattern (see spec lines 139-186 for the 3AK before/after example). Target ~15 lines per check.

- [ ] **Step 6: Compress Section 3.5 — Provider Quality (3R-3V)**

Source: search for `Section 3.5` (~line 2170). 5 checks: 3R (~line 2172), 3S (~line 2220), 3T (~line 2260), 3U (~line 2300), 3V (~line 2340).

5 checks. 3V (Price Staleness) uses per-chain thresholds from `config.json`.perChainStalenessThresholds instead of hardcoded block-time values.

- [ ] **Step 7: Compress Section 3.6 — Detection Quality (3W-3Y)**

Source: search for `Section 3.6` (~line 2400). 3 checks: 3W (~line 2402), 3X (~line 2430), 3Y (~line 2460).

3 checks. 3Y is a placeholder check (pair_cache_hit_total) — fast-path via `config.json`.placeholderMetrics.

- [ ] **Step 8: Compress Section 3.7 — Execution & BI (3Z-3AG)**

Source: search for `Section 3.7` (~line 2480). 8 checks: 3Z (~line 2482), 3AA (~line 2495), 3AB (~line 2507), 3AC (~line 2524), 3AD (~line 2539), 3AE (~line 2570), 3AF (~line 2595), 3AG (~line 2620).

8 checks using cached stats/metrics. Reference thresholds from `config.json` (profitSlippageWarnPct, revertRateCritPct, etc.).

- [ ] **Step 9: Compress Section 3.8 — Observability (3AH-3AI)**

Source: search for `Section 3.8` (~line 2660). 2 checks: 3AH (~line 2662), 3AI (~line 2710).

2 checks using cached Prometheus metrics (`prom_3000.txt`, `metrics_<port>.txt`).

- [ ] **Step 10: Compress Section 3.9 — Dashboard Validation (3AJ-3AR)**

Source: search for `Section 3.9` (~line 2800). Original 9 checks: 3AJ (~line 2802), 3AK (~line 2830), 3AL (~line 3150), 3AM (~line 3210), 3AN (~line 3280), 3AO (~line 3320), 3AP (~line 3360), 3AQ (~line 3400), 3AR (~line 3440).

After removing 3AL and 3AM (reclassified to Phase 1), 7 checks remain.

Note: 3AK (SSE Connectivity) requires a live curl to the SSE endpoint (not cacheable) — keep the original curl command. See the spec's before/after example for 3AK (spec lines 139-186) as the compression template for dashboard checks.

- [ ] **Step 11: Add Phase 3 summary**

- [ ] **Step 12: Verify line count and coverage**

Read the file and verify:
- 42 checks present across 9 subsections
- All checks reference cached endpoint data (not raw curl calls) except SSE
- All stream/port/threshold values reference inventory.json or config.json
- Redis batching used for stream topology/lag/MAXLEN checks
- Target ~800 lines (allow ±80)

- [ ] **Step 13: Commit**

```bash
git add .claude/commands/monitoring/04-runtime.md
git commit -m "feat(monitoring): add compressed runtime module (04) — 42 checks with endpoint caching"
```

---

## Chunk 4: Phase 4 & 5 (Smoke Test + Report)

### Task 7: Create Phase 4 smoke test module

**Files:**
- Create: `.claude/commands/monitoring/05-smoke-test.md`

Current Phase 4 spans lines ~3505-3866 (~361 lines) with 12 steps. Target: ~300 lines.

- [ ] **Step 1: Write 05-smoke-test.md**

Structure (12 steps compressed):
1. **4A — Baseline Snapshot** (~15 lines): XLEN all critical streams, save to baseline
2. **4B — Stream Growth Poll** (~25 lines): Poll every `config.json`.smokeTestPollIntervalSec until timeout. Early exit if all 4 critical streams growing.
3. **4C — Pipeline Cascade Verification** (~20 lines): Compare baseline vs current for price-updates → opportunities → execution-requests → execution-results
4. **4D — Message Trace** (~20 lines): Find a message ID in price-updates, trace through to execution-results using `XRANGE ... COUNT 50`
5. **4E — DLQ Growth Check** (~10 lines): Compare DLQ lengths pre/post smoke
6. **4F — Per-Chain Detection Coverage** (~20 lines): Parse stream messages for chain fields across all partitions
7. **4G — Risk State Post-Smoke** (~15 lines): Re-check drawdown/risk from coordinator
8. **4H — Backpressure Check** (~15 lines): XLEN/MAXLEN ratio for execution streams
9. **4I — Partition Flow Verification** (~15 lines): Per-partition message deltas
10. **4J — Cross-Chain Smoke** (~15 lines): Check `stream:opportunities` for cross-chain entries
11. **4K — BI Metrics Recording** (~15 lines): Re-scrape metrics, compare pre/post
12. **4L — Runtime Performance Delta** (~15 lines): Compare event loop/memory pre/post

Steps 4C-4L can run after 4B completes (parallelizable).

All stream names from `inventory.json`. Thresholds from `config.json`.

Flags use compact notation. The smoke test finding file: `./monitor-session/findings/smoke-test.jsonl`. Finding ID prefix: `SM-NNN`.

- [ ] **Step 2: Add Phase 4 summary**

- [ ] **Step 3: Commit**

```bash
git add .claude/commands/monitoring/05-smoke-test.md
git commit -m "feat(monitoring): add compressed smoke test module (05) — 12 steps"
```

---

### Task 8: Create Phase 5 report module

**Files:**
- Create: `.claude/commands/monitoring/06-report.md`

Current Phase 5 spans lines ~3870-4369 (~499 lines). Target: ~200 lines by compressing the report template (currently ~280 lines of markdown template).

- [ ] **Step 1: Write 06-report.md**

Structure:
1. **5A — Capture final stream state** (~10 lines)
2. **5B — Stop services** (~5 lines)
3. **5C — Stop Redis** (~3 lines)
4. **5D — GO/NO-GO decision** (~15 lines): Rules from `config.json`.goNoGo + mode adjustments
5. **5E — Regression analysis** (~25 lines): Compare vs previous session history
6. **5F — Persist session history** (~15 lines): Write `history/<SESSION_ID>.json`
7. **Report template** (~120 lines): Compressed from ~280 lines

Report template compression targets:
- Merge Phase 1 and Phase 3 check tables into single-row-per-check format
- Remove the detailed "Per-Chain Detection Coverage" table skeleton (generate dynamically from inventory.json partitions)
- Remove the duplicate "Readiness Endpoint Consistency" table (already in Phase 2 output)
- Keep the key sections: Decision, Data Mode Summary, Regression Analysis, Phase summaries, All Findings

GO/NO-GO rules reference `config.json`:
```
Read config.json. if anyCritical → NO-GO. if HIGH count > maxHighForGo → NO-GO. else → GO.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/commands/monitoring/06-report.md
git commit -m "feat(monitoring): add report module (06) with compressed template"
```

---

## Chunk 5: Orchestrator Hub + Migration

### Task 9: Build orchestrator hub (replace monitoring.md)

**Files:**
- Rewrite: `.claude/commands/monitoring.md`

The orchestrator hub is the new entry point. ~100 lines replacing the 4,369-line monolith.

- [ ] **Step 1: Read the current monitoring.md to confirm we have captured everything**

Verify all content is accounted for in the modules:
- Lines 1-43 (header/changelog) → drop changelog, keep version
- Lines 44-76 (role + critical rules) → hub
- Lines 79-155 (System Inventory) → replaced by 00-inventory-generator
- Lines 158-270 (pre-flight) → 01-preflight.md
- Lines 274-1182 (Phase 1) → 02-static-analysis.md
- Lines 1185-1458 (Phase 2) → 03-startup.md
- Lines 1462-3505 (Phase 3) → 04-runtime.md
- Lines 3505-3866 (Phase 4) → 05-smoke-test.md
- Lines 3870-4369 (Phase 5) → 06-report.md

- [ ] **Step 2: Write the new monitoring.md orchestrator hub**

```markdown
# Pre-Deploy Validation — Orchestrator Hub
# Version: 4.0

You are the **ORCHESTRATOR**. Validate the entire arbitrage system is deployment-ready
by running 5 sequential phases: static analysis, startup, runtime validation,
pipeline smoke test, and shutdown with a go/no-go report.

## Critical Rules

- Run phases in order. Phases 1 & 2 may overlap (Phase 1 uses only file analysis;
  start Redis + services at Phase 2A/2B, then run Phase 1, then resume Phase 2C).
- Do NOT spawn sub-agents. Handle everything directly.
- Use `curl` for HTTP (Windows-compatible). Use `redis-cli` for Redis.
- Use Glob/Grep/Read for file analysis (NOT grep/find bash commands).
- If a phase fails catastrophically, record CRITICAL finding and skip to Phase 5.

## Severity Legend

| Code | Severity | Meaning |
|------|----------|---------|
| C | CRITICAL | Blocks deployment, system broken |
| H | HIGH | Significant issue, must fix before deploy |
| M | MEDIUM | Should fix, not blocking if <4 total |
| L | LOW | Minor, improve when convenient |
| I | INFO | Informational, no action needed |

Compact flag format: `condition → SEV:CATEGORY`
Example: `Service unreachable → C:SERVICE_HEALTH`

## Finding Format (all phases)

```json
{"phase":"<PHASE>","findingId":"<PREFIX>-NNN","category":"<CAT>","severity":"<SEV>","service":"<svc>","title":"<desc>","evidence":"<data>","expected":"<exp>","actual":"<act>","recommendation":"<fix>"}
```

Prefixes: `PF` (pre-flight), `SA` (static), `RT` (runtime), `SM` (smoke test).

## Session Variables

These persist across phases via files in `./monitor-session/`:
- `SESSION_ID` — session timestamp identifier
- `DATA_MODE` — simulation/live/testnet
- `current.sha` — git SHA at session start
- `config/inventory.json` — auto-generated system inventory
- `findings/*.jsonl` — per-phase findings

## Execution Order

### Phase 0: Pre-Flight
Read `.claude/commands/monitoring/00-inventory-generator.md` — execute to generate inventory.json.
Read `.claude/commands/monitoring/01-preflight.md` — execute session setup and data mode.

### Phase 1+2 Overlap (saves ~60s)
1. Start Redis (Step 2A from Phase 2 module)
2. Start services in background (Step 2B from Phase 2 module)
3. Read `.claude/commands/monitoring/02-static-analysis.md` — execute all 24 checks
4. Resume Phase 2 at Step 2C (readiness polling)

Read `.claude/commands/monitoring/03-startup.md` — for Steps 2A-2E.

### Phase 3: Runtime
Read `.claude/commands/monitoring/04-runtime.md` — execute all 42 checks.

### Phase 4: Smoke Test
Read `.claude/commands/monitoring/05-smoke-test.md` — execute all 12 steps.

### Phase 5: Report
Read `.claude/commands/monitoring/06-report.md` — shutdown, regression, final report.

## Config Reference

Thresholds and go/no-go rules: `.claude/commands/monitoring/config.json`
Auto-generated inventory: `./monitor-session/config/inventory.json`

---

*Orchestrator hub v4.0 — modules loaded on-demand via Read tool.*
```

- [ ] **Step 3: Verify hub is ~100 lines and self-contained**

The hub must contain everything Claude needs to start the pipeline without reading any module:
- Role definition
- Critical rules
- Severity legend (so compact flags in modules make sense)
- Finding format (defined once)
- Phase execution order with Read instructions
- Session variable locations

- [ ] **Step 4: Commit**

```bash
git add .claude/commands/monitoring.md
git commit -m "feat(monitoring): replace monolith with orchestrator hub v4.0 (~100 lines)"
```

---

### Task 10: Validate the complete pipeline

- [ ] **Step 1: Verify all module files exist**

```bash
ls -la .claude/commands/monitoring/
```

Expected: config.json, 00-inventory-generator.md, 01-preflight.md, 02-static-analysis.md, 03-startup.md, 04-runtime.md, 05-smoke-test.md, 06-report.md (8 files).

- [ ] **Step 2: Verify config.json is valid**

```bash
cat .claude/commands/monitoring/config.json | jq .
```

- [ ] **Step 3: Count total lines across all modules**

```bash
wc -l .claude/commands/monitoring.md .claude/commands/monitoring/*.md .claude/commands/monitoring/*.json
```

Expected: Total <2,500 lines (target 2,360).

- [ ] **Step 4: Verify check coverage — all 79 original checks accounted for**

Cross-reference:
- Phase 1 (02-static-analysis.md): 24 checks (1A-1V minus 1W, plus 1X/1Y)
- Phase 2 (03-startup.md): 5 steps (2A-2E) + Check 1W
- Phase 3 (04-runtime.md): 42 checks (3A-3AR minus 3AL, 3AM)
- Phase 4 (05-smoke-test.md): 12 steps (4A-4L)
- Phase 5 (06-report.md): 6 steps (5A-5F)

Total checks: 24 + 42 = 66 checks + 1W = 67 phase checks + 12 smoke steps + 5 startup steps + 6 report steps = 90 discrete steps. All 79 original checks must map to one of these.

- [ ] **Step 5: Verify orchestrator hub size (confirms monolith replaced)**

```bash
wc -l .claude/commands/monitoring.md
```

Expected: ≤120 lines. If >150 lines, the rewrite failed — old monolith content was not replaced.

- [ ] **Step 6: Verify no hardcoded stream names, ports, or MAXLENs in phase modules**

Search for hardcoded values in the phase modules (02-06). The inventory generator (00) legitimately references source file patterns as extraction targets.

```bash
grep -rn "stream:price-updates\|stream:opportunities\|MAXLEN.*100000\|port.*3001" .claude/commands/monitoring/0[2-6]*.md
```

Review any matches manually — some may be legitimate (e.g., in comments explaining the compression pattern). Flag any that should reference `inventory.json` instead.

- [ ] **Step 7: Verify inventory.json references are consistent**

Grep all modules for `inventory.json` references and verify they use the correct JSON paths.

- [ ] **Step 8: Commit final validation results**

If any issues found in Steps 1-6, fix them first. Then:

```bash
git add -A .claude/commands/monitoring/ .claude/commands/monitoring.md
git commit -m "feat(monitoring): complete v4.0 modular migration — validated all 79 checks"
```

---

### Task 11: Clean up and document

- [ ] **Step 1: Update the design spec status**

Edit `docs/superpowers/specs/2026-03-10-monitoring-pipeline-optimization-design.md`:
Change `**Status:** Approved` to `**Status:** Implemented`.

- [ ] **Step 2: Update MEMORY.md**

Add entry documenting the completed migration:
- New file structure
- Check count by module
- Key changes (reclassifications, inventory auto-gen)

- [ ] **Step 3: Final commit**

```bash
git add docs/superpowers/specs/2026-03-10-monitoring-pipeline-optimization-design.md
git commit -m "docs: mark monitoring pipeline optimization v4.0 as implemented"
```
