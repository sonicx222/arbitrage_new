# Pre-Deploy Validation
# Single-Orchestrator Pipeline — Redis Streams + 7 Services
# Version: 2.2

---

You are the **ORCHESTRATOR**. Your job is to validate the entire arbitrage system
is deployment-ready by running 5 sequential phases: static analysis, startup,
runtime validation, pipeline smoke test, and shutdown with a go/no-go report.

You have full bash tool access plus Glob, Grep, and Read for file analysis.
All findings are written to `./monitor-session/findings/` as JSONL.
The final report goes to `./monitor-session/REPORT_<SESSION_ID>.md`.

**CRITICAL RULES:**
- Run all 5 phases sequentially. Do NOT skip phases.
- Do NOT spawn sub-agents. You handle everything directly.
- Use `curl` for HTTP requests (Windows-compatible).
- Use `redis-cli` for Redis commands.
- Use Glob/Grep/Read for file analysis (NOT grep/find bash commands).
- If a phase fails catastrophically (Redis won't start, no services come up),
  record the failure as a CRITICAL finding and skip to Phase 5 (report).

---

## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## SYSTEM INVENTORY — Reference for all phases
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

### Services (7 via `npm run dev:all`)

| Service | Port | Ready Endpoint | Role |
|---------|------|----------------|------|
| Coordinator | 3000 | `/api/health/ready` | Orchestration, leader election, opportunity routing |
| P1 Asia-Fast | 3001 | `/ready` | Chain detector: BSC, Polygon, Avalanche, Fantom |
| P2 L2-Turbo | 3002 | `/ready` | Chain detector: Arbitrum, Optimism, Base, zkSync, Linea, Blast, Scroll, Mantle, Mode |
| P3 High-Value | 3003 | `/ready` | Chain detector: Ethereum, zkSync, Linea |
| P4 Solana | 3004 | `/ready` | Chain detector: Solana |
| Execution Engine | 3005 | `/ready` | Trade execution, flash loans, MEV protection |
| Cross-Chain | 3006 | `/ready` | Cross-chain arbitrage detection |

### Redis Streams (19 declared in `shared/types/src/events.ts`)

| Stream | MAXLEN | Producer(s) | Consumer Group(s) |
|--------|--------|-------------|-------------------|
| `stream:price-updates` | 100,000 | P1-P4 partitions | coordinator-group, cross-chain-detector-group |
| `stream:swap-events` | 50,000 | P1-P4 partitions | coordinator-group |
| `stream:opportunities` | 10,000 | P1-P4, cross-chain detector | coordinator-group |
| `stream:whale-alerts` | 5,000 | P1-P4 partitions | coordinator-group, cross-chain-detector-group |
| `stream:service-health` | 1,000 | All services | — |
| `stream:service-events` | 5,000 | All services | — |
| `stream:coordinator-events` | 5,000 | Coordinator | — |
| `stream:health` | 1,000 | All services | coordinator-group |
| `stream:health-alerts` | 5,000 | Health monitor | — |
| `stream:execution-requests` | 5,000 | Coordinator | execution-engine-group |
| `stream:execution-results` | 5,000 | Execution engine | coordinator-group |
| `stream:pending-opportunities` | 10,000 | Mempool detector | cross-chain-detector-group |
| `stream:volume-aggregates` | 10,000 | Volume aggregator | coordinator-group |
| `stream:circuit-breaker` | 5,000 | Execution engine | — |
| `stream:system-failover` | 1,000 | Coordinator | — |
| `stream:system-commands` | 1,000 | Coordinator | — |
| `stream:fast-lane` | — | Fast lane (feature-gated) | execution-engine |
| `stream:dead-letter-queue` | 10,000 | Any service | coordinator-group |
| `stream:forwarding-dlq` | — | Coordinator | — |

### Consumer Groups (5 active)

| Group | Service | Streams |
|-------|---------|---------|
| `coordinator-group` | Coordinator | health, opportunities, whale-alerts, swap-events, volume-aggregates, price-updates, execution-results, dead-letter-queue |
| `cross-chain-detector-group` | Cross-Chain Detector | price-updates, whale-alerts, pending-opportunities |
| `execution-engine-group` | Execution Engine | execution-requests |
| `execution-engine` | Execution Engine (fast lane) | fast-lane |
| `mempool-detector-group` | Mempool Detector | pending-opportunities |

### Pipeline Data Flow (Critical Path)

```
P1-P4 Partitions → stream:price-updates → Detectors → stream:opportunities
    → Coordinator (validates, deduplicates) → stream:execution-requests
    → Execution Engine (executes) → stream:execution-results
    → Coordinator (records outcome)
```

---

## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## PRE-FLIGHT — Create session workspace
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

```bash
mkdir -p ./monitor-session/{logs,findings,streams,config}
SESSION_ID=$(date +%Y%m%d_%H%M%S)
echo $SESSION_ID > ./monitor-session/SESSION_ID
echo "Session $SESSION_ID initialized"
```

---

## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## PHASE 1 — STATIC ANALYSIS (~60 seconds)
## No services need to be running. Uses Glob, Grep, Read only.
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Run ALL of these checks. Record each finding as a JSON object appended to
`./monitor-session/findings/static-analysis.jsonl`.

### Finding format:
```json
{
  "phase": "STATIC",
  "findingId": "SA-001",
  "category": "STREAM_DECLARATION|CONSUMER_GROUP|MAXLEN|MISSING_ACK|ENV_VAR|ANTI_PATTERN|CONFIG_DRIFT|HMAC_SIGNING|FEATURE_FLAG|RISK_CONFIG",
  "severity": "CRITICAL|HIGH|MEDIUM|LOW|INFO",
  "title": "<short description>",
  "service": "<service name or 'cross-service'>",
  "evidence": "<file path, line number, and code snippet>",
  "expected": "<what should be>",
  "actual": "<what is>",
  "recommendation": "<specific fix>"
}
```

---

### Check 1A — Stream Name Declaration Audit

**Goal:** Every stream name used in code must reference the canonical `RedisStreams`
constant from `shared/types/src/events.ts`, not hardcoded strings.

**Method:**
1. Read `shared/types/src/events.ts` to get the canonical stream name list.
2. Use Grep to find all files containing `xadd`, `XADD`, `xReadGroup`, `XREADGROUP`,
   `createConsumerGroup` patterns in `.ts` and `.js` files (exclude `node_modules`).
3. In each matching file, check whether stream name arguments use the `RedisStreams`
   constant or a variable derived from it, vs. hardcoded string literals like
   `'stream:opportunities'`.

**Flag:** Any hardcoded stream name string → severity: **HIGH**, category: `STREAM_DECLARATION`.
**Exceptions:** Test files (`__tests__`, `.test.ts`, `.spec.ts`) may use hardcoded strings.

---

### Check 1B — Consumer Group Consistency

**Goal:** Consumer group names in code must match the 5 expected groups listed in
the System Inventory above.

**Method:**
1. Use Grep to find all occurrences of consumer group name strings in service code.
   Search for patterns like `group:`, `Group:`, `consumerGroup`, `GROUP` in `.ts` files
   under `services/` and `shared/`.
2. Extract group name string literals.
3. Compare against expected: `coordinator-group`, `cross-chain-detector-group`,
   `execution-engine-group`, `execution-engine`, `mempool-detector-group`.

**Flag:** Any group name NOT in the expected list → severity: **CRITICAL**,
category: `CONSUMER_GROUP`.
**Flag:** Any expected group NOT found in code → severity: **HIGH**,
category: `CONSUMER_GROUP`.

---

### Check 1C — MAXLEN Enforcement

**Goal:** Every XADD call must include MAXLEN trimming to prevent unbounded
stream growth (memory time bomb).

**Method:**
1. Use Grep to find all `xadd` / `XADD` calls in `.ts` files (exclude `node_modules`,
   exclude test files).
2. For each call site, check if MAXLEN is specified (either directly or via
   `STREAM_MAX_LENGTHS` constant or `StreamBatcher` config).

**Flag:** Any XADD without MAXLEN → severity: **HIGH**, category: `MAXLEN`.
**Note:** The `StreamBatcher` and `RedisStreamsClient.xadd()` may apply MAXLEN
internally via config. Read those implementations to understand if MAXLEN is
applied automatically before flagging individual call sites.

---

### Check 1D — XACK After Consume

**Goal:** Every file that reads from a consumer group must also acknowledge
messages. Missing ACK = messages stay pending forever.

**Method:**
1. Use Grep to find all files with `xReadGroup` / `XREADGROUP` patterns.
2. For each file, check if it also contains `xack` / `XACK` (directly or via
   a handler that calls ACK).

**Flag:** File with consume but no acknowledge → severity: **HIGH**,
category: `MISSING_ACK`.
**Note:** The `StreamConsumer` class in `shared/core/src/redis/` may handle ACK
internally. If all consumers use this abstraction, this check may pass cleanly.
Read the abstraction to verify.

---

### Check 1E — Environment Variable Audit

**Goal:** Every `process.env.*` reference in service code should be documented
in `.env.example`.

**Method:**
1. Use Grep to find all `process\.env\.[A-Z_]+` patterns in `.ts` files under
   `services/` and `shared/` (exclude `node_modules`, exclude test files).
2. Read `.env.example` to get the documented variable list.
3. Compare: env vars used in code but missing from `.env.example`.

**Flag:** Missing from `.env.example` → severity: **MEDIUM**, category: `ENV_VAR`.
**Note:** Some env vars like `NODE_ENV`, `PORT` are standard and don't need
documentation. Only flag non-obvious custom env vars.

---

### Check 1F — Nullish Coalescing Anti-Pattern

**Goal:** Numeric defaults must use `?? 0` / `?? 0n`, not `|| 0` / `|| 0n`.
The `||` operator treats `0` as falsy, silently replacing legitimate zero values.

**Method:**
1. Use Grep to find `\|\| 0\b` and `\|\| 0n\b` patterns in `.ts` files
   (exclude `node_modules`).

**Flag:** Each occurrence → severity: **LOW**, category: `ANTI_PATTERN`.

---

### Check 1G — HMAC Signing Configuration

**Goal:** Redis Streams message signing must be configured for production.
Without `STREAM_SIGNING_KEY`, all Redis messages are accepted without
verification — an attacker with Redis access could inject fake opportunities.

**Method:**
1. Read `.env.example` and check if `STREAM_SIGNING_KEY` is documented.
2. Use Grep to find `STREAM_SIGNING_KEY` references in code. Verify the
   signing implementation exists in `shared/core/src/redis/streams.ts`.
3. Check if `STREAM_PREVIOUS_SIGNING_KEY` (key rotation support) is documented.
4. Verify the fail-closed behavior: in production, missing HMAC should reject
   messages (check for the enforcement code).

**Flag:** `STREAM_SIGNING_KEY` not in `.env.example` → severity: **HIGH**,
category: `HMAC_SIGNING`.
**Flag:** No HMAC enforcement code in production path → severity: **CRITICAL**,
category: `HMAC_SIGNING`.
**Info:** Key rotation support (`STREAM_PREVIOUS_SIGNING_KEY`) not documented →
severity: **LOW**, category: `HMAC_SIGNING`.

---

### Check 1H — Feature Flag Validation

**Goal:** Feature flags must be consistent — no cross-dependency violations,
and profit-impacting features should be explicitly documented.

**Method:**
1. Read `shared/config/src/feature-flags.ts` to get all 16 `FEATURE_*` flags.
2. List each flag with its pattern (opt-in `=== 'true'` or opt-out `!== 'false'`).
3. Verify cross-dependencies:
   - `FEATURE_SIGNAL_CACHE_READ` requires `FEATURE_ML_SIGNAL_SCORING`
   - `FEATURE_COMMIT_REVEAL_REDIS` requires `REDIS_URL`
4. Check `.env.example` documents all feature flags with descriptions.

**Expected flags (16 total):**
`FEATURE_BATCHED_QUOTER`, `FEATURE_FLASH_LOAN_AGGREGATOR`, `FEATURE_COMMIT_REVEAL`,
`FEATURE_COMMIT_REVEAL_REDIS`, `FEATURE_DEST_CHAIN_FLASH_LOAN`,
`FEATURE_MOMENTUM_TRACKING`, `FEATURE_ML_SIGNAL_SCORING`,
`FEATURE_SIGNAL_CACHE_READ`, `FEATURE_LIQUIDITY_DEPTH_SIZING`,
`FEATURE_DYNAMIC_L1_FEES` (opt-out — ON by default),
`FEATURE_ORDERFLOW_PIPELINE`, `FEATURE_KMS_SIGNING`, `FEATURE_FAST_LANE`,
`FEATURE_BACKRUN_STRATEGY`, `FEATURE_UNISWAPX_FILLER`, `FEATURE_MEV_SHARE_BACKRUN`

**Flag:** Cross-dependency violation in code → severity: **HIGH**,
category: `FEATURE_FLAG`.
**Flag:** Feature flag not documented in `.env.example` → severity: **MEDIUM**,
category: `FEATURE_FLAG`.
**Flag:** `FEATURE_DYNAMIC_L1_FEES` explicitly disabled in config → severity: **HIGH**,
category: `FEATURE_FLAG` (required for accurate L2 cost estimation).

---

### Check 1I — Risk Configuration Audit

**Goal:** Risk management parameters must be documented and consistent.
Misconfigured risk params can silently halt trading (drawdown breaker) or
allow oversized positions (Kelly criterion).

**Method:**
1. Read `shared/config/src/risk-config.ts` to get all risk env vars.
2. Verify these are documented in `.env.example`:
   - `RISK_TOTAL_CAPITAL` (REQUIRED in production)
   - `RISK_KELLY_MULTIPLIER` (default 0.5)
   - `RISK_MAX_SINGLE_TRADE` (default 0.02 = 2%)
   - `RISK_MIN_EV_THRESHOLD` (default 0.005 ETH)
   - `RISK_MIN_WIN_PROBABILITY` (default 0.3)
   - `RISK_MAX_LOSS_PER_TRADE` (default 0.1 ETH)
3. Verify cross-validation: `defaultWinProbability` >= `minWinProbability`
   (prevents all trades being rejected after restart).

**Flag:** `RISK_TOTAL_CAPITAL` not documented → severity: **HIGH**,
category: `RISK_CONFIG` (system won't function in production without it).
**Flag:** Cross-validation missing → severity: **MEDIUM**,
category: `RISK_CONFIG`.

---

### Phase 1 Summary

After all checks, read `./monitor-session/findings/static-analysis.jsonl` and
output a summary:
```
PHASE 1 COMPLETE — Static Analysis
  CRITICAL: <n>  HIGH: <n>  MEDIUM: <n>  LOW: <n>  INFO: <n>
  Total findings: <n>
```

If any CRITICAL findings exist, note them but **continue to Phase 2** (we want
the full picture).

---

## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## PHASE 2 — STARTUP & READINESS (~60 seconds)
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

### Step 2A — Start Redis

```bash
npm run dev:redis:memory &
sleep 3
redis-cli PING
```

If PING fails → **CRITICAL** finding. Skip to Phase 5 (report) — nothing works
without Redis.

Verify stream command support:
```bash
redis-cli COMMAND INFO XADD XREAD XREADGROUP XPENDING XINFO XACK XLEN XCLAIM
```

If any stream command is unsupported → **CRITICAL**. Report Redis version mismatch.

---

### Step 2B — Start all services with simulation

Use the memory-optimized monitoring script. This uses `tsx` (no file watchers),
sets `CONSTRAINED_MEMORY=true` (smaller worker pools), `WORKER_POOL_SIZE=1`
(1 worker thread per service instead of 4), and `CACHE_L1_SIZE_MB=8` (8MB L1
cache instead of 64MB). These reduce peak RAM from ~1.5GB to ~600MB.

Both scripts default to `SIMULATION_REALISM_LEVEL=high` (block-driven multi-swap
engine with Markov regime model). Override with a `cross-env` prefix to use a
different level:

| Level | Behavior | Use Case |
|-------|----------|----------|
| `low` | Legacy `setInterval`, flat rate | Fast deterministic tests |
| `medium` | Block-driven, Poisson swaps, gas model, no regime | Steady-state validation |
| `high` | Medium + Markov regime (quiet/normal/burst) | Production-realistic load |

```bash
npm run dev:monitor &
```

To override the realism level (e.g., medium for steady-state validation):

```bash
cross-env SIMULATION_REALISM_LEVEL=medium npm run dev:monitor &
```

If only the critical pipeline path needs validation (Coordinator + P1 + Execution),
use the minimal variant to save further (~350MB total):

```bash
npm run dev:monitor:minimal &
```

Capture PID for later cleanup.

---

### Step 2C — Poll readiness

Poll each service's `/ready` endpoint every 5 seconds, up to 30 seconds per service.
Run these checks in sequence (services may have startup dependencies).

```bash
# Coordinator
curl -sf http://localhost:3000/api/health/ready || echo "NOT READY"

# Partitions
curl -sf http://localhost:3001/ready || echo "NOT READY"
curl -sf http://localhost:3002/ready || echo "NOT READY"
curl -sf http://localhost:3003/ready || echo "NOT READY"
curl -sf http://localhost:3004/ready || echo "NOT READY"

# Execution Engine
curl -sf http://localhost:3005/ready || echo "NOT READY"

# Cross-Chain Detector
curl -sf http://localhost:3006/ready || echo "NOT READY"
```

**For each service:**
- Poll every 5 seconds for up to 30 seconds.
- If ready within 30s → record startup time.
- If NOT ready after 30s → **CRITICAL** finding. Record which service failed.
  Continue with remaining services.

Record findings to `./monitor-session/findings/startup.jsonl`:
```json
{
  "phase": "STARTUP",
  "findingId": "ST-001",
  "category": "SERVICE_READY|SERVICE_FAILED|REDIS_FAILED",
  "severity": "CRITICAL|HIGH|INFO",
  "service": "<service name>",
  "port": 3000,
  "startupTimeMs": 0,
  "evidence": "<curl output or error>"
}
```

---

### Step 2D — Capture baseline Redis stream state

After all services are ready (or timed out), capture the baseline state of
every stream that exists in Redis:

```bash
# Discover what streams actually exist
redis-cli --scan --pattern 'stream:*' > ./monitor-session/streams/discovered.txt

# For each discovered stream:
for stream in $(cat ./monitor-session/streams/discovered.txt); do
  echo "=== $stream ===" >> ./monitor-session/streams/baseline.txt
  redis-cli XINFO STREAM $stream >> ./monitor-session/streams/baseline.txt
  redis-cli XINFO GROUPS $stream >> ./monitor-session/streams/baseline.txt
  redis-cli XLEN $stream >> ./monitor-session/streams/baseline.txt
done

# Memory baseline
redis-cli INFO memory > ./monitor-session/streams/redis-memory-baseline.txt
```

Compare discovered streams against the 19 expected streams from the System
Inventory. Any expected stream that does NOT exist → **MEDIUM** finding.
Any unexpected stream that DOES exist → **INFO** finding (may be legitimate).

Output:
```
PHASE 2 COMPLETE — Startup
  Services ready: <n>/7 (list names)
  Services failed: <n> (list names)
  Streams discovered: <n>/19
  Missing streams: <list>
  Unexpected streams: <list>
```

---

## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## PHASE 3 — RUNTIME VALIDATION (~90 seconds)
## All services should be running. Uses curl + redis-cli.
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Record all findings to `./monitor-session/findings/runtime.jsonl`:
```json
{
  "phase": "RUNTIME",
  "findingId": "RT-001",
  "category": "SERVICE_HEALTH|LEADER_ELECTION|CIRCUIT_BREAKER|DLQ|STREAM_TOPOLOGY|CONSUMER_LAG|STUCK_MESSAGE|DEAD_CONSUMER|METRICS|WEBSOCKET_HEALTH|PROVIDER_HEALTH|RISK_STATE|LATENCY|GAS_SPIKE|SIMULATION|EXECUTION_PROBABILITY|BRIDGE_RECOVERY|MEMORY",
  "severity": "CRITICAL|HIGH|MEDIUM|LOW|INFO",
  "service": "<service name>",
  "stream": "<stream name if applicable>",
  "consumerGroup": "<group name if applicable>",
  "evidence": "<endpoint response or redis-cli output>",
  "expected": "<what should be>",
  "actual": "<what is>",
  "recommendation": "<specific fix>"
}
```

---

### Check 3A — Service Health Matrix

Hit every service's `/health` endpoint and collect status:

```bash
# Coordinator (returns JSON with status field)
curl -sf http://localhost:3000/api/health | jq .

# Partitions (return JSON with status field)
curl -sf http://localhost:3001/health | jq .
curl -sf http://localhost:3002/health | jq .
curl -sf http://localhost:3003/health | jq .
curl -sf http://localhost:3004/health | jq .

# Execution Engine
curl -sf http://localhost:3005/health | jq .

# Cross-Chain Detector
curl -sf http://localhost:3006/health | jq .
```

**Flag:** Any service with status `unhealthy` → **CRITICAL**.
**Flag:** Any service with status `degraded` → **HIGH**.
**Flag:** Any service unreachable → **CRITICAL**.

Also hit `/stats` on services that expose it:
```bash
curl -sf http://localhost:3001/stats  # P1 detailed stats
curl -sf http://localhost:3002/stats  # P2 detailed stats
curl -sf http://localhost:3003/stats  # P3 detailed stats
curl -sf http://localhost:3004/stats  # P4 detailed stats
curl -sf http://localhost:3005/stats  # Execution engine stats
```

Record the stats output for the report — no findings needed unless values are
anomalous (e.g., 0 chains active on a partition that should have chains).

---

### Check 3B — Leader Election

```bash
curl -sf http://localhost:3000/api/leader | jq .
```

**Flag:** `isLeader` is `false` → **CRITICAL** (no leader = no opportunity routing).
**Flag:** Endpoint unreachable → **CRITICAL**.

Also verify the Redis leader lock:
```bash
redis-cli GET coordinator:leader:lock
redis-cli TTL coordinator:leader:lock
```

**Flag:** Lock doesn't exist → **CRITICAL** (leader election not working).
**Flag:** TTL < 5 seconds → **HIGH** (lock about to expire, heartbeat may be failing).

---

### Check 3C — Circuit Breaker States

```bash
curl -sf http://localhost:3005/circuit-breaker | jq .
```

**Flag:** Any chain in `OPEN` state → **HIGH** (chain is blocked from execution).
**Flag:** Any chain in `HALF_OPEN` state → **MEDIUM** (chain recovering).
**Flag:** Endpoint unreachable → **HIGH**.

---

### Check 3D — Dead Letter Queue Status

```bash
redis-cli XLEN stream:dead-letter-queue
redis-cli XLEN stream:forwarding-dlq
redis-cli XLEN stream:dlq-alerts
```

**Flag:** `stream:dead-letter-queue` length > 0 → **HIGH** (messages failing on startup).
**Flag:** `stream:forwarding-dlq` length > 0 → **CRITICAL** (coordinator can't reach
execution engine — the critical pipeline path is broken).

If DLQ has entries, read the most recent messages to understand what's failing:
```bash
redis-cli XREVRANGE stream:dead-letter-queue + - COUNT 5
redis-cli XREVRANGE stream:forwarding-dlq + - COUNT 5
```

---

### Check 3E — Redis Stream Topology Validation

For each of the 19 expected streams, verify the stream exists and has the
correct consumer groups attached:

```bash
for stream in stream:price-updates stream:swap-events stream:opportunities \
  stream:whale-alerts stream:service-health stream:service-events \
  stream:coordinator-events stream:health stream:health-alerts \
  stream:execution-requests stream:execution-results \
  stream:pending-opportunities stream:volume-aggregates \
  stream:circuit-breaker stream:system-failover stream:system-commands \
  stream:fast-lane stream:dead-letter-queue stream:forwarding-dlq; do

  echo "=== $stream ==="
  redis-cli XINFO STREAM $stream 2>&1
  redis-cli XINFO GROUPS $stream 2>&1
done
```

For each stream, verify:
1. **Exists** — `XINFO STREAM` succeeds. Missing → **MEDIUM**.
2. **Has expected consumer groups** — compare `XINFO GROUPS` output against the
   System Inventory table. Missing group → **HIGH**.
3. **Consumer groups have active consumers** — `consumers` field > 0 for each
   group. Zero consumers → **CRITICAL** (dead consumer group).
4. **Stream length is reasonable** — not 0 (for active streams like `price-updates`)
   and not at MAXLEN cap (indicates producer outpacing consumer trim).

---

### Check 3F — Consumer Lag & Pending Messages

For each active consumer group, check pending messages:

```bash
redis-cli XPENDING stream:price-updates coordinator-group
redis-cli XPENDING stream:price-updates cross-chain-detector-group
redis-cli XPENDING stream:opportunities coordinator-group
redis-cli XPENDING stream:whale-alerts coordinator-group
redis-cli XPENDING stream:whale-alerts cross-chain-detector-group
redis-cli XPENDING stream:execution-requests execution-engine-group
redis-cli XPENDING stream:execution-results coordinator-group
redis-cli XPENDING stream:health coordinator-group
redis-cli XPENDING stream:dead-letter-queue coordinator-group
```

**Thresholds:**
- Pending count > 50 → **HIGH** (consumer falling behind).
- Pending count > 100 → **CRITICAL** (consumer overwhelmed).
- Any message pending for > 30 seconds (check oldest pending entry) → **HIGH**
  (stuck message — consumer may have crashed without ACKing).
- Any message with delivery count > 3 → **HIGH** (message being retried
  repeatedly — likely a poison message).

---

### Check 3G — Prometheus Metrics Validation

Scrape metrics from all services twice, 15 seconds apart:

```bash
# First scrape
curl -sf http://localhost:3001/metrics > ./monitor-session/metrics_t0.txt
curl -sf http://localhost:3005/metrics >> ./monitor-session/metrics_t0.txt
curl -sf http://localhost:3006/metrics >> ./monitor-session/metrics_t0.txt

sleep 15

# Second scrape
curl -sf http://localhost:3001/metrics > ./monitor-session/metrics_t1.txt
curl -sf http://localhost:3005/metrics >> ./monitor-session/metrics_t1.txt
curl -sf http://localhost:3006/metrics >> ./monitor-session/metrics_t1.txt
```

**Flag:** Counters NOT incrementing between scrapes → **MEDIUM** (metrics may be
stale or service is idle — in simulation mode, counters should be incrementing).
**Flag:** Metrics endpoint returns empty/error → **MEDIUM**.

---

### Check 3H — WebSocket & Provider Health Per Chain

**Goal:** Verify RPC WebSocket connections are alive and receiving data for
every active chain. A dead WebSocket means zero detection on that chain.

The system uses a "6-Provider Shield" per chain (`shared/core/src/websocket-manager.ts`)
with chain-specific staleness thresholds:
- **Fast chains** (Arbitrum, Solana): 5s
- **Medium chains** (Polygon, BSC, Optimism, Base, Avalanche, Fantom): 10s
- **Slow chains** (Ethereum, zkSync, Linea): 15s

**Method:**
1. Hit each partition's `/stats` endpoint and parse the per-chain stats:
```bash
curl -sf http://localhost:3001/stats | jq .  # P1: BSC, Polygon, AVAX, FTM
curl -sf http://localhost:3002/stats | jq .  # P2: Arb, OP, Base, zkSync, Linea, Blast, Scroll
curl -sf http://localhost:3003/stats | jq .  # P3: ETH, zkSync, Linea
curl -sf http://localhost:3004/stats | jq .  # P4: Solana
```

2. For each chain, check:
   - `lastMessageTimestamp` (or equivalent) — is it recent?
   - `reconnectCount` — high count indicates unstable provider
   - `activeSubscriptions` — should be >0 for each chain
   - `messagesReceived` — should be >0 (chains producing data)

**Flag:** Any chain with no messages received → **CRITICAL**, category: `WEBSOCKET_HEALTH`
(dead WebSocket = zero detection on that chain).
**Flag:** Any chain with `lastMessage` older than its staleness threshold →
**HIGH**, category: `WEBSOCKET_HEALTH`.
**Flag:** Any chain with reconnectCount > 5 → **HIGH**, category: `PROVIDER_HEALTH`
(unstable provider — frequent reconnections cause data gaps).
**Flag:** Any chain with 0 active subscriptions → **CRITICAL**,
category: `WEBSOCKET_HEALTH`.

---

### Check 3I — Risk Management State (Drawdown Circuit Breaker)

**Goal:** Verify the drawdown circuit breaker is in NORMAL state. The system
can pass all health checks while producing zero profit because the drawdown
breaker is in HALT state — the #1 profitability blind spot.

States: NORMAL (100% sizing) → CAUTION (75%) → HALT (0% — trading stopped)
→ RECOVERY (50%)

**Method:**
```bash
# Execution engine health includes risk state information
curl -sf http://localhost:3005/health | jq .
curl -sf http://localhost:3005/stats | jq .
```

Parse the response for drawdown/risk state fields. Look for:
- `drawdownState` or `riskState` or similar field
- `consecutiveLosses` — 5 consecutive losses triggers HALT
- `dailyPnl` — daily loss >5% triggers HALT

**Flag:** Drawdown state is `HALT` → **CRITICAL**, category: `RISK_STATE`
(system is alive but not trading — invisible failure).
**Flag:** Drawdown state is `CAUTION` → **HIGH**, category: `RISK_STATE`
(trading at reduced capacity — 75% sizing).
**Flag:** Drawdown state is `RECOVERY` → **MEDIUM**, category: `RISK_STATE`
(recovering — 50% sizing).
**Flag:** Risk state information not available in endpoint → **MEDIUM**,
category: `RISK_STATE` (blind spot — can't verify trading status).

---

### Check 3J — Pipeline Latency vs <50ms Target

**Goal:** Verify hot-path latency is within the <50ms target (ADR-022).
Exceeding this target means opportunities expire before execution,
especially on fast chains (Arbitrum 2s TTL, Solana 1s TTL).

The `LatencyTracker` tracks 4 pipeline stages with Float64Array ring buffers:
`ws_receive`, `batcher_flush`, `detector_process`, `opportunity_publish`.

**Method:**
```bash
# Partition metrics expose pipeline latency percentiles
curl -sf http://localhost:3001/metrics  # Parse pipeline_latency_p50, p95, p99
curl -sf http://localhost:3002/metrics
curl -sf http://localhost:3003/metrics
curl -sf http://localhost:3004/metrics
```

Parse Prometheus metrics for:
- `pipeline_latency_p95` — should be <50ms
- `pipeline_latency_p99` — should be <100ms (some headroom)
- `pipeline_latency_p50` — should be <20ms (median)

**Flag:** Any partition with `pipeline_latency_p95` > 50ms → **HIGH**,
category: `LATENCY` (exceeding hot-path target).
**Flag:** Any partition with `pipeline_latency_p99` > 100ms → **HIGH**,
category: `LATENCY` (tail latency too high).
**Flag:** Latency metrics not present → **MEDIUM**, category: `LATENCY`
(observability gap — can't verify performance target).

---

### Check 3K — Gas Price & Spike Detection

**Goal:** Verify gas prices are sane and no active gas spikes are blocking
execution on any chain.

The `GasPriceOptimizer` uses EMA-based spike detection with chain-specific
thresholds and pre-submission refresh.

**Method:**
```bash
# Execution engine stats include gas information
curl -sf http://localhost:3005/stats | jq .
curl -sf http://localhost:3005/health | jq .
```

Parse for gas-related fields per chain. Also check Prometheus metrics:
```bash
curl -sf http://localhost:3005/metrics
# Parse: arbitrage_gas_price_gwei{chain="<name>"}
```

**Flag:** Any chain with gas price = 0 → **HIGH**, category: `GAS_SPIKE`
(gas price not being fetched — execution will fail or use stale values).
**Flag:** Any chain with active gas spike detected → **MEDIUM**,
category: `GAS_SPIKE` (execution temporarily blocked on that chain).
**Flag:** Gas price above chain max threshold → **HIGH**, category: `GAS_SPIKE`
(chain thresholds: Ethereum max 500 gwei, Arbitrum max 10 gwei).

---

### Check 3L — Simulation Provider Health

**Goal:** Verify transaction simulation providers are available. Without
simulation, trades either skip validation (risky) or fail.

The `SimulationService` supports: Tenderly, Alchemy, Local (eth_call), Helius (Solana).

**Method:**
```bash
curl -sf http://localhost:3005/stats | jq .
```

Parse for simulation provider status fields. Check:
- Which providers are configured and healthy
- Simulation success rate
- Whether simulation is being used (vs skipped)

**Flag:** All simulation providers unhealthy → **HIGH**, category: `SIMULATION`
(all trades will skip simulation or fail).
**Flag:** Simulation success rate <50% → **MEDIUM**, category: `SIMULATION`.
**Flag:** No simulation providers configured → **MEDIUM**, category: `SIMULATION`.

---

### Check 3M — Execution Probability & Success Rate

**Goal:** Verify execution success rates are healthy. Low success rates
mean capital is being wasted on gas for failed transactions.

The `ExecutionProbabilityTracker` persists per-chain/DEX success rates to Redis.

**Method:**
```bash
curl -sf http://localhost:3005/probability-tracker | jq .
```

Parse for:
- Overall execution success rate
- Per-chain success rates
- Recent profitable execution rate

**Flag:** Overall success rate <30% → **HIGH**, category: `EXECUTION_PROBABILITY`
(most executions failing — gas wasted).
**Flag:** Any chain with 0% success rate and >0 attempts → **HIGH**,
category: `EXECUTION_PROBABILITY` (chain execution completely broken).
**Flag:** Endpoint returns empty/error → **MEDIUM**, category: `EXECUTION_PROBABILITY`
(blind spot — can't verify execution health).

---

### Check 3N — Bridge Recovery Status

**Goal:** Verify no bridge transactions are stuck. Stuck bridges mean
capital is locked and unavailable for trading.

The `BridgeRecoveryManager` tracks: pending, bridging, bridge_completed_sell_pending,
recovered, failed.

**Method:**
```bash
curl -sf http://localhost:3005/bridge-recovery | jq .
```

Parse for:
- Total pending bridge transactions
- Any transactions stuck >24 hours
- Any transactions in `failed` state

**Flag:** Any bridge stuck >24 hours → **HIGH**, category: `BRIDGE_RECOVERY`
(capital locked).
**Flag:** >3 concurrent pending bridges → **MEDIUM**, category: `BRIDGE_RECOVERY`
(approaching concurrency limit of 3).
**Flag:** Any corrupt bridge entries → **HIGH**, category: `BRIDGE_RECOVERY`
(data integrity issue).

---

### Check 3O — Memory Health Per Service

**Goal:** Verify memory usage is within platform-aware thresholds. The
`EnhancedHealthMonitor` uses different thresholds per platform:
- Fly.io: warning 60%, critical 78%
- Oracle Cloud: warning 80%, critical 95%
- Local dev: warning 80%, critical 95%

**Method:**
Parse memory information from each service's `/health` response (collected
in Check 3A). Look for RSS memory, heap used, heap total fields.

```bash
# Also check Redis memory
redis-cli INFO memory
# Parse: used_memory_human, used_memory_peak_human, maxmemory
```

**Flag:** Any service using >80% of its memory allocation → **HIGH**,
category: `MEMORY` (approaching OOM).
**Flag:** Redis memory >75% of maxmemory → **HIGH**, category: `MEMORY`
(Redis eviction risk).
**Flag:** Memory info not available in health response → **LOW**,
category: `MEMORY`.

---

Output:
```
PHASE 3 COMPLETE — Runtime Validation
  Services healthy: <n>/7
  Leader elected: YES/NO
  Circuit breakers: all CLOSED / <list open chains>
  DLQ entries: <n>
  Stream topology: <n>/19 streams correct
  Consumer groups: <n>/5 healthy
  Pending messages: <total across all groups>
  WebSocket health: <n>/<total> chains receiving data
  Drawdown state: NORMAL / CAUTION / HALT / RECOVERY
  Pipeline latency p95: <n>ms (target: <50ms)
  Gas spikes active: <n> chains
  Simulation providers: <n> healthy
  Execution success rate: <n>%
  Bridge recoveries pending: <n>
  Memory: all OK / <services above threshold>
  CRITICAL: <n>  HIGH: <n>  MEDIUM: <n>  LOW: <n>
```

---

## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## PHASE 4 — PIPELINE SMOKE TEST (~90 seconds)
## Validates the full data flow end-to-end in simulation mode.
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Record findings to `./monitor-session/findings/smoke-test.jsonl`:
```json
{
  "phase": "SMOKE_TEST",
  "findingId": "SM-001",
  "category": "PIPELINE_FLOW|PIPELINE_STALL|TRACE_INCOMPLETE|DLQ_GROWTH|DETECTION_RATE|RISK_STATE",
  "severity": "CRITICAL|HIGH|MEDIUM|INFO",
  "stream": "<stream name>",
  "evidence": "<XLEN values, endpoint data, trace details>",
  "expected": "<what should happen>",
  "actual": "<what happened>",
  "recommendation": "<fix>"
}
```

---

### Step 4A — Capture initial stream lengths

```bash
echo "=== SMOKE TEST BASELINE ===" > ./monitor-session/streams/smoke-baseline.txt
for stream in stream:price-updates stream:opportunities \
  stream:execution-requests stream:execution-results \
  stream:dead-letter-queue stream:forwarding-dlq; do
  LEN=$(redis-cli XLEN $stream)
  echo "$stream: $LEN" >> ./monitor-session/streams/smoke-baseline.txt
  echo "$stream: $LEN"
done
```

---

### Step 4B — Wait for pipeline flow (60s timeout, poll every 10s)

In simulation mode, the partitions automatically generate simulated price data
which feeds into the detection → execution pipeline. At `high` realism, the
Markov regime model produces bursty activity — expect uneven stream growth
(quiet periods with few events, then bursts). At `medium`, growth is steadier.

Poll the 4 critical streams every 10 seconds for up to 60 seconds:

```bash
# Poll loop (adapt to bash tool constraints — may need to run as individual checks)
for i in 1 2 3 4 5 6; do
  sleep 10
  echo "=== Poll $i ($(($i * 10))s) ==="
  redis-cli XLEN stream:price-updates
  redis-cli XLEN stream:opportunities
  redis-cli XLEN stream:execution-requests
  redis-cli XLEN stream:execution-results
done
```

**Expected cascade:**
1. `stream:price-updates` length grows first (partitions publishing prices)
2. `stream:opportunities` length grows next (detectors finding arbitrage)
3. `stream:execution-requests` length grows (coordinator forwarding)
4. `stream:execution-results` length grows (execution engine completing)

**Flag:** `stream:price-updates` not growing after 30s → **CRITICAL**
(partitions not publishing — simulation mode may not be working).
**Flag:** `stream:opportunities` not growing after 45s → **HIGH**
(detectors not finding opportunities — may be expected if simulation
doesn't produce viable arb, but worth flagging).
**Flag:** `stream:execution-requests` not growing but `stream:opportunities` is →
**CRITICAL** (coordinator is not forwarding — pipeline broken).
**Flag:** `stream:execution-results` not growing but `stream:execution-requests` is →
**CRITICAL** (execution engine not processing — pipeline broken).

---

### Step 4C — Verify endpoint data matches stream flow

```bash
# Coordinator should show recent opportunities
curl -sf http://localhost:3000/api/opportunities 2>/dev/null | jq '.length // 0'

# Execution engine should show execution attempts
curl -sf http://localhost:3005/stats 2>/dev/null | jq .

# Execution engine health should show success metrics
curl -sf http://localhost:3005/health 2>/dev/null | jq '{queueSize, activeExecutions, successRate}'
```

**Flag:** Coordinator `/api/opportunities` returns empty but `stream:opportunities`
has entries → **HIGH** (coordinator consuming but not tracking).
**Flag:** Execution engine stats show 0 attempts but `stream:execution-requests`
has entries → **HIGH** (consumer not processing queue).

Note: These endpoints may require authentication. If they return 401/403,
record as **INFO** (auth is working correctly in simulation mode) and skip
the data validation.

---

### Step 4D — Trace one message through the pipeline

If `stream:execution-results` has entries, trace one message back through
the pipeline:

```bash
# Get the latest execution result
redis-cli XREVRANGE stream:execution-results + - COUNT 1
```

From the result message, extract the `_trace_traceId` field (set by the
trace context propagation system in `shared/core/src/tracing/`).

If a traceId is found:
```bash
# Search for the same traceId in upstream streams (COUNT 5 is sufficient —
# we only need one matching message per stream for trace verification)
redis-cli XREVRANGE stream:opportunities + - COUNT 5
# (Search the output for matching _trace_traceId)

redis-cli XREVRANGE stream:execution-requests + - COUNT 5
# (Search the output for matching _trace_traceId)
```

**Expected trace:**
```
stream:opportunities (traceId: X) → stream:execution-requests (traceId: X) → stream:execution-results (traceId: X)
```

**Flag:** traceId present in result but missing from upstream → **MEDIUM**
(trace context not propagated correctly across services).
**Flag:** No traceId in any message → **MEDIUM** (trace context system not active).

---

### Step 4E — DLQ growth check

```bash
redis-cli XLEN stream:dead-letter-queue
redis-cli XLEN stream:forwarding-dlq
```

Compare against the baseline captured in Step 4A.

**Flag:** DLQ grew during smoke test → **HIGH** (messages are failing in the
normal pipeline flow — read the new DLQ entries for details).
**Flag:** Forwarding DLQ grew → **CRITICAL** (coordinator forwarding is broken).

---

### Step 4F — Per-Chain Detection Granularity

**Goal:** Verify every partition is detecting on ALL its assigned chains,
not just some. A partition reporting "healthy" with only 1 of 3 chains
active is a silent detection gap.

**Method:**
Re-check partition `/stats` endpoints (from Check 3H) and compare per-chain
message counts against the beginning of the smoke test.

```bash
curl -sf http://localhost:3001/stats | jq .  # P1: expect BSC + Polygon + AVAX + FTM active
curl -sf http://localhost:3002/stats | jq .  # P2: expect Arb + OP + Base + ... active
curl -sf http://localhost:3003/stats | jq .  # P3: expect ETH + zkSync + Linea active
curl -sf http://localhost:3004/stats | jq .  # P4: expect Solana active
```

For each partition, verify every assigned chain shows:
- Message count increased during smoke test
- Price update rate >0 (chain is actively producing data)

**Expected chain coverage:**
- P1: BSC, Polygon, Avalanche, Fantom (4 chains)
- P2: Arbitrum, Optimism, Base, zkSync, Linea, Blast, Scroll (7 active chains;
  Mantle and Mode are stubs — acceptable if missing)
- P3: Ethereum, zkSync, Linea (3 chains)
- P4: Solana (1 chain)

**Flag:** Any non-stub chain with 0 messages during smoke test → **HIGH**,
category: `DETECTION_RATE` (chain is configured but not producing data).
**Flag:** Partition reporting fewer chains than expected → **MEDIUM**,
category: `DETECTION_RATE`.

---

### Step 4G — Risk State Verification Post-Smoke

**Goal:** Verify the drawdown circuit breaker is still in NORMAL state
after the smoke test. In simulation mode with `EXECUTION_SIMULATION_MODE=true`,
simulated executions should not trigger the drawdown breaker.

**Method:**
```bash
curl -sf http://localhost:3005/health | jq .
curl -sf http://localhost:3005/stats | jq .
```

Re-check the risk management state fields (same as Check 3I).

**Flag:** Drawdown state changed from NORMAL to CAUTION/HALT during smoke test →
**HIGH**, category: `RISK_STATE` (simulated execution is triggering risk controls
— the simulation mock may be reporting losses).
**Flag:** Consecutive loss count >0 during simulated execution → **MEDIUM**,
category: `RISK_STATE` (simulation configuration may need adjustment).

---

Output:
```
PHASE 4 COMPLETE — Pipeline Smoke Test
  Price updates published: <n>
  Opportunities detected: <n>
  Execution requests forwarded: <n>
  Execution results received: <n>
  Pipeline: FLOWING / STALLED at <stage>
  Trace complete: YES / NO / PARTIAL
  DLQ growth: <n> new entries
  Per-chain detection: <n>/<total> chains active across all partitions
  Risk state post-smoke: NORMAL / CAUTION / HALT / RECOVERY
  CRITICAL: <n>  HIGH: <n>  MEDIUM: <n>
```

---

## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## PHASE 5 — SHUTDOWN & REPORT (~30 seconds)
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

### Step 5A — Capture final stream state

```bash
for stream in $(cat ./monitor-session/streams/discovered.txt 2>/dev/null); do
  echo "=== FINAL: $stream ===" >> ./monitor-session/streams/final-state.txt
  redis-cli XINFO STREAM $stream >> ./monitor-session/streams/final-state.txt
  redis-cli XINFO GROUPS $stream >> ./monitor-session/streams/final-state.txt
  redis-cli XLEN $stream >> ./monitor-session/streams/final-state.txt
done

redis-cli INFO memory > ./monitor-session/streams/redis-memory-final.txt
```

---

### Step 5B — Stop services

```bash
npm run dev:stop
sleep 5
```

Verify clean shutdown:
```bash
# Check no node processes remain
tasklist | grep -i node | grep -v grep || echo "Clean shutdown — no node processes"
```

---

### Step 5C — Stop Redis

```bash
redis-cli SHUTDOWN NOSAVE 2>/dev/null || echo "Redis already stopped"
```

---

### Step 5D — Generate the report

Read ALL finding files:
- `./monitor-session/findings/static-analysis.jsonl`
- `./monitor-session/findings/startup.jsonl`
- `./monitor-session/findings/runtime.jsonl`
- `./monitor-session/findings/smoke-test.jsonl`

Count findings by severity across all phases.

**GO/NO-GO DECISION RULES:**
- Any **CRITICAL** finding → **NO-GO**
- More than 3 **HIGH** findings → **NO-GO**
- All else → **GO** (with warnings listed)

Write the final report to `./monitor-session/REPORT_<SESSION_ID>.md` using
this template:

---

```markdown
# Pre-Deploy Validation Report

**Session:** <SESSION_ID>
**Date:** <ISO8601>
**Duration:** <total elapsed time>

---

## Decision: GO / NO-GO

| Severity | Count |
|----------|-------|
| CRITICAL | <n> |
| HIGH | <n> |
| MEDIUM | <n> |
| LOW | <n> |
| INFO | <n> |
| **Total** | **<n>** |

**Reason:** <if NO-GO, list the blocking findings>

---

## Phase 1: Static Analysis

| Check | Status | Findings |
|-------|--------|----------|
| Stream Declarations | PASS/FAIL | <count> |
| Consumer Groups | PASS/FAIL | <count> |
| MAXLEN Enforcement | PASS/FAIL | <count> |
| XACK After Consume | PASS/FAIL | <count> |
| Environment Variables | PASS/FAIL | <count> |
| Nullish Coalescing | PASS/FAIL | <count> |
| HMAC Signing | PASS/FAIL | <count> |
| Feature Flags | PASS/FAIL | <count> |
| Risk Configuration | PASS/FAIL | <count> |

<detailed findings here if any>

---

## Phase 2: Service Readiness

| Service | Port | Status | Startup Time |
|---------|------|--------|-------------|
| Coordinator | 3000 | READY/FAILED | <ms> |
| P1 Asia-Fast | 3001 | READY/FAILED | <ms> |
| P2 L2-Turbo | 3002 | READY/FAILED | <ms> |
| P3 High-Value | 3003 | READY/FAILED | <ms> |
| P4 Solana | 3004 | READY/FAILED | <ms> |
| Execution Engine | 3005 | READY/FAILED | <ms> |
| Cross-Chain | 3006 | READY/FAILED | <ms> |

Streams discovered: <n>/19
Missing: <list>

---

## Phase 3: Runtime Validation

### Service Health
| Service | Status | Details |
|---------|--------|---------|
| ... | healthy/degraded/unhealthy | ... |

### Leader Election
- Leader: <instance ID>
- Lock TTL: <seconds>

### Circuit Breakers
| Chain | State |
|-------|-------|
| ... | CLOSED/OPEN/HALF_OPEN |

### DLQ Status
| Queue | Length |
|-------|--------|
| dead-letter-queue | <n> |
| forwarding-dlq | <n> |

### WebSocket & Provider Health
| Chain | Partition | Messages | Last Update | Reconnects | Status |
|-------|-----------|----------|-------------|------------|--------|
| BSC | P1 | <n> | <age> | <n> | HEALTHY/STALE/DEAD |
| Polygon | P1 | <n> | <age> | <n> | HEALTHY/STALE/DEAD |
| ... | ... | ... | ... | ... | ... |

### Risk Management State
- Drawdown state: NORMAL / CAUTION / HALT / RECOVERY
- Consecutive losses: <n>
- Daily PnL: <value>
- Position sizing factor: 100% / 75% / 50% / 0%

### Pipeline Latency
| Partition | p50 | p95 | p99 | Status |
|-----------|-----|-----|-----|--------|
| P1 Asia-Fast | <n>ms | <n>ms | <n>ms | OK / OVER TARGET |
| P2 L2-Turbo | <n>ms | <n>ms | <n>ms | OK / OVER TARGET |
| P3 High-Value | <n>ms | <n>ms | <n>ms | OK / OVER TARGET |
| P4 Solana | <n>ms | <n>ms | <n>ms | OK / OVER TARGET |

### Gas & Simulation
| Chain | Gas (gwei) | Spike Active | Sim Provider | Sim Success Rate |
|-------|------------|-------------|--------------|-----------------|
| ... | <n> | YES/NO | <provider> | <n>% |

### Execution Probability
- Overall success rate: <n>%
- Profitable execution rate: <n>%
- Per-chain breakdown: <table if available>

### Bridge Recovery
| Status | Count |
|--------|-------|
| Pending | <n> |
| Stuck >24h | <n> |
| Failed | <n> |

### Memory Health
| Service | RSS | Heap Used | Threshold | Status |
|---------|-----|-----------|-----------|--------|
| ... | <n>MB | <n>MB | <n>% | OK / WARNING / CRITICAL |

Redis memory: <used> / <max>

### Redis Stream Health Map

| Stream | Exists | Length | Groups | Consumers | Pending | Oldest Pending | Status |
|--------|--------|--------|--------|-----------|---------|----------------|--------|
| stream:price-updates | YES | <n> | 2 | <n> | <n> | <age> | HEALTHY |
| stream:opportunities | YES | <n> | 1 | <n> | <n> | <age> | HEALTHY |
| ... | ... | ... | ... | ... | ... | ... | ... |

---

## Phase 4: Pipeline Smoke Test

### Stream Flow Cascade
| Stream | Baseline | Final | Growth | Status |
|--------|----------|-------|--------|--------|
| stream:price-updates | <n> | <n> | +<n> | FLOWING/STALLED |
| stream:opportunities | <n> | <n> | +<n> | FLOWING/STALLED |
| stream:execution-requests | <n> | <n> | +<n> | FLOWING/STALLED |
| stream:execution-results | <n> | <n> | +<n> | FLOWING/STALLED |

### Pipeline Verdict: FLOWING / STALLED AT <stage>

### Message Trace
<traced message details if available>

### DLQ Growth: <n> new entries

### Per-Chain Detection Coverage
| Partition | Chain | Messages During Smoke | Status |
|-----------|-------|-----------------------|--------|
| P1 | BSC | <n> | ACTIVE / SILENT |
| P1 | Polygon | <n> | ACTIVE / SILENT |
| P1 | Avalanche | <n> | ACTIVE / SILENT |
| P1 | Fantom | <n> | ACTIVE / SILENT |
| P2 | Arbitrum | <n> | ACTIVE / SILENT |
| P2 | Optimism | <n> | ACTIVE / SILENT |
| P2 | Base | <n> | ACTIVE / SILENT |
| P2 | zkSync | <n> | ACTIVE / SILENT |
| P2 | Linea | <n> | ACTIVE / SILENT |
| P2 | Blast | <n> | ACTIVE / SILENT |
| P2 | Scroll | <n> | ACTIVE / SILENT |
| P3 | Ethereum | <n> | ACTIVE / SILENT |
| P3 | zkSync | <n> | ACTIVE / SILENT |
| P3 | Linea | <n> | ACTIVE / SILENT |
| P4 | Solana | <n> | ACTIVE / SILENT |

### Risk State Post-Smoke
- Drawdown state: NORMAL / changed to <state>
- Consecutive losses during smoke: <n>

---

## All Findings (sorted by severity)

<for each finding, include all JSON fields formatted as a readable block>

---

*Report generated by monitoring.md v2.1*
*Session: <SESSION_ID>*
*Completed: <ISO8601>*
```

---

*End of orchestrator instructions.*
