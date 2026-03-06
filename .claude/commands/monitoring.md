# Pre-Deploy Validation
# Single-Orchestrator Pipeline — Redis Streams + 7 Services
# Version: 3.0
#
# Changelog v3.0 (2026-03-06):
#   - Phase 3 restructured into 8 subsections (35 checks, was 18)
#   - New checks: runtime performance (B1-B6), provider quality (C1-C5),
#     detection quality (D2-D4), business intelligence (A2-A4, F4-F5),
#     stream transit time (F1), placeholder checks for E1-E5/F2-F3/D1/D5
#   - Fixed MAXLEN drift: opportunities=500K, execution-requests=100K, execution-results=25K
#   - Added self-healing-manager consumer group to inventory
#   - Fixed coordinator-group streams (9, was 8 — added forwarding-dlq)
#   - Added all 24 streams to topology check (was 19)
#   - Added fast-lane to smoke test E2E validation
#   - Removed deleted stream-monitor.js references
#   - Updated Prometheus expected metrics with 25+ new metric names
#   - Expanded report template with 4 new sections

---

You are the **ORCHESTRATOR**. Your job is to validate the entire arbitrage system
is deployment-ready by running 5 sequential phases: static analysis, startup,
runtime validation, pipeline smoke test, and shutdown with a go/no-go report.

You have full bash tool access plus Glob, Grep, and Read for file analysis.
All findings are written to `./monitor-session/findings/` as JSONL.
The final report goes to `./monitor-session/REPORT_<SESSION_ID>.md`.

**CRITICAL RULES:**
- Run phases in order. Phases 1 & 2 may overlap (see below). Do NOT skip phases.
- Do NOT spawn sub-agents. You handle everything directly.
- Use `curl` for HTTP requests (Windows-compatible).
- Use `redis-cli` for Redis commands.
- Use Glob/Grep/Read for file analysis (NOT grep/find bash commands).
- If a phase fails catastrophically (Redis won't start, no services come up),
  record the failure as a CRITICAL finding and skip to Phase 5 (report).

**OPTIMIZATION — Phase 1/2 Overlap:**
Phase 1 (static analysis) uses only Glob/Grep/Read — it does NOT need services
running. Phase 2 (startup) starts Redis and services, which takes 30-60s of
idle wait time. To reduce total validation time from ~5.5min to ~4min:

1. Start Redis (Step 2A) FIRST — it takes 3 seconds and is needed for Phase 3.
2. Start services (Step 2B) in the background immediately after Redis is up.
3. Run Phase 1 static analysis while services are starting up.
4. After Phase 1 completes, resume Phase 2 at Step 2C (readiness polling).

This saves ~60s by overlapping Phase 1's static checks with the service
startup wait. If you cannot overlap (e.g., tool limitations), run them
sequentially — correctness is more important than speed.

---

## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## SYSTEM INVENTORY — Reference for all phases
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

### Services (7 via `npm run dev:all`)

| Service | Port | Ready Endpoint | Role |
|---------|------|----------------|------|
| Coordinator | 3000 | `/api/health/ready` | Orchestration, leader election, opportunity routing |
| P1 Asia-Fast | 3001 | `/ready` | Chain detector: BSC, Polygon, Avalanche, Fantom |
| P2 L2-Turbo | 3002 | `/ready` | Chain detector: Arbitrum, Optimism, Base, Blast, Scroll |
| P3 High-Value | 3003 | `/ready` | Chain detector: Ethereum, zkSync, Linea |
| P4 Solana | 3004 | `/ready` | Chain detector: Solana |
| Execution Engine | 3005 | `/ready` | Trade execution, flash loans, MEV protection |
| Cross-Chain | 3006 | `/ready` | Cross-chain arbitrage detection |

### Redis Streams (24 declared in `shared/types/src/events.ts`)

| Stream | MAXLEN | Producer(s) | Consumer Group(s) |
|--------|--------|-------------|-------------------|
| `stream:price-updates` | 100,000 | P1-P4 partitions | coordinator-group, cross-chain-detector-group |
| `stream:swap-events` | 50,000 | P1-P4 partitions | coordinator-group |
| `stream:opportunities` | 500,000 | P1-P4, cross-chain detector | coordinator-group |
| `stream:whale-alerts` | 5,000 | P1-P4 partitions | coordinator-group, cross-chain-detector-group |
| `stream:service-health` | 1,000 | All services | — |
| `stream:service-events` | 5,000 | All services | — |
| `stream:coordinator-events` | 5,000 | Coordinator | — |
| `stream:health` | 1,000 | All services | coordinator-group |
| `stream:health-alerts` | 5,000 | Health monitor | — |
| `stream:execution-requests` | 100,000 | Coordinator | execution-engine-group |
| `stream:execution-results` | 25,000 | Execution engine | coordinator-group |
| `stream:pending-opportunities` | 10,000 | Mempool detector | cross-chain-detector-group |
| `stream:volume-aggregates` | 10,000 | Volume aggregator | coordinator-group |
| `stream:circuit-breaker` | 5,000 | Execution engine | — |
| `stream:system-failover` | 1,000 | Coordinator | — |
| `stream:system-commands` | 1,000 | Coordinator | — |
| `stream:fast-lane` | 5,000 | Fast lane (feature-gated) | execution-engine-group |
| `stream:dead-letter-queue` | 10,000 | Any service | coordinator-group |
| `stream:dlq-alerts` | 5,000 | DLQ manager (on-demand) | — |
| `stream:forwarding-dlq` | 5,000 | Coordinator | coordinator-group |
| `stream:system-failures` | 5,000 | Self-healing (on-demand) | self-healing-manager |
| `stream:system-control` | 1,000 | Self-healing (on-demand) | self-healing-manager |
| `stream:system-scaling` | 1,000 | Self-healing (on-demand) | self-healing-manager |
| `stream:service-degradation` | 5,000 | Degradation monitor (on-demand) | — |

### Consumer Groups (7 active)

| Group | Service | Streams |
|-------|---------|---------|
| `coordinator-group` | Coordinator | health, opportunities, whale-alerts, swap-events, volume-aggregates, price-updates, execution-results, dead-letter-queue, forwarding-dlq |
| `cross-chain-detector-group` | Cross-Chain Detector | price-updates, whale-alerts, pending-opportunities |
| `execution-engine-group` | Execution Engine | execution-requests, fast-lane |
| `mempool-detector-group` | Mempool Detector | pending-opportunities |
| `orderflow-pipeline` | Coordinator (orderflow) | pending-opportunities |
| `self-healing-manager` | Expert Self-Healing Manager | system-failures, system-control, system-scaling | (dynamic: created on first use) |
| `failover-{serviceName}` | Coordinator (failover) | system-failover | (dynamic: created by CrossRegionHealthManager at runtime) |

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
mkdir -p ./monitor-session/{logs,findings,streams,config,history}
SESSION_ID=$(date +%Y%m%d_%H%M%S)
echo $SESSION_ID > ./monitor-session/SESSION_ID
CURRENT_SHA=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
echo $CURRENT_SHA > ./monitor-session/current.sha
echo "Session $SESSION_ID initialized (git SHA: $CURRENT_SHA)"
```

---

## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## PHASE 1 — STATIC ANALYSIS (~60 seconds)
## No services need to be running. Uses Glob, Grep, Read only.
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

### Incremental Mode (Optimization)

Before running checks, determine if incremental analysis is possible:

```bash
LAST_SHA=$(cat ./monitor-session/last-run.sha 2>/dev/null || echo "")
CURRENT_SHA=$(cat ./monitor-session/current.sha)

if [ -n "$LAST_SHA" ] && [ "$LAST_SHA" != "unknown" ] && [ "$LAST_SHA" != "$CURRENT_SHA" ]; then
  git diff --name-only "$LAST_SHA".."$CURRENT_SHA" > ./monitor-session/changed-files.txt
  CHANGED_COUNT=$(wc -l < ./monitor-session/changed-files.txt)
  echo "INCREMENTAL MODE: $CHANGED_COUNT files changed since last run ($LAST_SHA)"
  INCREMENTAL=true
else
  echo "FULL SCAN MODE: No previous run SHA or first run"
  INCREMENTAL=false
fi
```

**When `INCREMENTAL=true`**, the following checks can be narrowed to only
changed files for faster execution. Structural checks (1A, 1B, 1E, 1P, 1Q)
must always run on the full codebase because they verify global invariants.

| Check | Incremental? | Reason |
|-------|-------------|--------|
| 1A Stream Names | FULL | Global: all stream refs must be canonical |
| 1B Consumer Groups | FULL | Global: all group refs must exist |
| 1C MAXLEN | **Incremental** | Only check changed files for XADD calls |
| 1D XACK | **Incremental** | Only check changed files for consume-without-ACK |
| 1E Env Var Drift | FULL | Global: code ↔ docs bidirectional diff |
| 1F Nullish Coalescing | **Incremental** | Only check changed files for `|| 0` |
| 1G HMAC | **Incremental** | Only check changed files for stream ops |
| 1H Feature Flags | **Incremental** | Only check changed files for flag usage |
| 1I Risk Config | **Incremental** | Only if risk config files changed |
| 1J Unsafe Parse | **Incremental** | Only check changed files for parseInt |
| 1K Redis Parity | **Incremental** | Only if Redis client files changed |
| 1L Port Collision | FULL | Global: all ports must be unique |
| 1M Silent Errors | **Incremental** | Only check changed files for empty catch |
| 1N Type Fidelity | **Incremental** | Only if stream serialization files changed |
| 1O Redis Key Registry | FULL | Global: all key prefixes must be unique |
| 1P ADR Compliance | FULL | Global: architectural invariants |
| 1Q Infra Config | FULL | Global: infra ↔ code alignment |
| 1R Timeout Hierarchy | **Incremental** | Only if timeout-related files changed |

For incremental checks, filter Grep/Glob results to only files in
`./monitor-session/changed-files.txt`. If no relevant files changed for a
check, skip it with an **INFO** finding noting "No changes since last run."

**When `INCREMENTAL=false`**, run all checks on the full codebase (default behavior).

Run ALL of these checks. Record each finding as a JSON object appended to
`./monitor-session/findings/static-analysis.jsonl`.

### Finding format:
```json
{
  "phase": "STATIC",
  "findingId": "SA-001",
  "category": "STREAM_DECLARATION|CONSUMER_GROUP|MAXLEN|MISSING_ACK|ENV_VAR|ANTI_PATTERN|CONFIG_DRIFT|HMAC_SIGNING|FEATURE_FLAG|RISK_CONFIG|UNSAFE_PARSE|REDIS_CLIENT_PARITY|PORT_COLLISION|SILENT_ERROR|STREAM_TYPE_FIDELITY|REDIS_KEY_REGISTRY|ADR_COMPLIANCE|INFRA_DRIFT|TIMEOUT_HIERARCHY",
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

### Check 1B — Consumer Group Consistency (Dynamic Discovery)

**Goal:** Consumer group names in code must match the expected groups. Instead of
hardcoding the expected list, derive it from code to prevent documentation drift.

**Method:**
1. **Discover groups from code**: Use Grep to find all consumer group name string
   literals in `.ts` files under `services/` and `shared/` (exclude `node_modules`,
   exclude test files). Search for patterns:
   - `consumerGroup:` or `consumerGroup =` assignments
   - `createConsumerGroup` call arguments
   - `XREADGROUP GROUP` arguments
   - String literals matching `*-group` or `*-pipeline` patterns
2. Extract the unique set of consumer group names found in code.
3. Compare code-discovered groups against the System Inventory table above.
4. **Flag drift in both directions:**
   - Group in code but NOT in inventory → the inventory is stale (update it)
   - Group in inventory but NOT in code → the inventory references a removed group

**Flag:** Any group in code NOT in the System Inventory → severity: **MEDIUM**,
category: `CONSUMER_GROUP` (inventory drift — update the monitoring command).
**Flag:** Any group in inventory NOT found in code AND NOT created dynamically at
runtime (e.g., `failover-*` groups are created on first use) → severity: **HIGH**,
category: `CONSUMER_GROUP`.
**Flag:** Any unknown group name not matching the `<service>-group` convention →
severity: **CRITICAL**, category: `CONSUMER_GROUP` (may indicate a rogue consumer).

**Note:** The `failover-coordinator` group is created dynamically at runtime by
`CrossRegionHealthManager`. It may not appear in static code search — verify by
checking `shared/core/src/monitoring/cross-region-health.ts` for dynamic group
creation patterns. Do NOT flag dynamically-created groups as missing.

---

### Check 1C — MAXLEN Enforcement (Config + Call-Site)

**Goal:** Every XADD call must include MAXLEN trimming to prevent unbounded
stream growth (memory time bomb). This check validates BOTH config-level MAXLEN
declarations AND individual call sites.

**Method — Part 1 (Config-level, existing):**
1. Use Grep to find all stream names in `STREAM_MAX_LENGTHS` in
   `shared/types/src/events.ts` or `shared/core/src/redis/streams.ts`.
2. Verify all 24 declared streams have a MAXLEN value.

**Method — Part 2 (Call-site level, NEW):**
3. Use Grep to find all `this.xadd(` and `this.xaddWithLimit(` calls in `.ts` files
   under `shared/` and `services/` (exclude `node_modules`, test files).
4. For each `this.xadd(` call that is NOT `this.xaddWithLimit(`:
   - Check if the call passes a `maxLen` option in its arguments.
   - Check if the call is inside `xaddWithLimit()` itself (the wrapper — not a violation).
   - Any other raw `this.xadd()` call without MAXLEN → finding.
5. Also search for direct `redis.xadd(` or `client.xadd(` calls outside the
   `RedisStreamsClient` abstraction.

**Flag:** Stream missing from `STREAM_MAX_LENGTHS` → severity: **HIGH**, category: `MAXLEN`.
**Flag:** Raw `this.xadd()` call in production code not using `xaddWithLimit()` →
severity: **HIGH**, category: `MAXLEN`.
File to watch: `shared/core/src/redis/streams.ts` — the HMAC rejection DLQ path
at approximately line 876 uses raw `xadd()` without MAXLEN.
**Flag:** Direct `redis.xadd()` bypassing the `RedisStreamsClient` abstraction →
severity: **CRITICAL**, category: `MAXLEN`.

**Note:** The `StreamBatcher` and `RedisStreamsClient.xaddWithLimit()` apply MAXLEN
internally via `STREAM_MAX_LENGTHS` config. Only `xaddWithLimit()` is safe — raw
`xadd()` calls bypass the MAXLEN enforcement entirely.

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

### Check 1E — Environment Variable Drift Detection (Comprehensive)

**Goal:** Detect bidirectional drift between env vars used in code and those
documented in `.env.example`. Undocumented env vars are invisible configuration
surfaces — operators cannot configure what they don't know exists.

**Method:**
1. **Discover code env vars**: Use Grep to find all `process\.env\.[A-Z_]+`
   patterns in `.ts` files under `services/` and `shared/` (exclude `node_modules`,
   exclude test files, exclude `__tests__/`). Extract unique env var names.
2. **Read documentation**: Read `.env.example` and extract all documented env var names
   (lines matching `^[A-Z_]+=` or `^#\s*[A-Z_]+=`).
3. **Compute bidirectional diff**:
   - **Undocumented**: vars in code but NOT in `.env.example`
   - **Orphaned**: vars in `.env.example` but NOT referenced in code (stale docs)
4. **Filter standard vars**: Exclude these platform/runtime vars from undocumented
   findings (they don't need documentation):
   `NODE_ENV`, `PORT`, `CI`, `JEST_WORKER_ID`, `HOME`, `PATH`, `HOSTNAME`,
   `FLY_APP_NAME`, `FLY_REGION`, `FLY_ALLOC_ID`, `RENDER_SERVICE_NAME`,
   `RAILWAY_SERVICE_NAME`, `KOYEB_SERVICE_NAME`, `GITHUB_ACTIONS`, `npm_*`
5. **Categorize undocumented vars by risk level**:
   - **CRITICAL**: Vars containing `KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `MNEMONIC`,
     `PRIVATE` in their name (security-sensitive)
   - **HIGH**: Vars controlling execution behavior (`*_TIMEOUT*`, `*_THRESHOLD*`,
     `MAX_*`, `MIN_*`, `*_LIMIT*`, `*_SIZE*`, `*_ENABLED`)
   - **MEDIUM**: All other undocumented custom vars
6. **Group by service**: For each undocumented var, note which service file(s) reference it.

**Flag:** Undocumented security-sensitive env var → severity: **CRITICAL**,
category: `ENV_VAR`.
**Flag:** Undocumented behavior-controlling env var → severity: **HIGH**,
category: `ENV_VAR`.
**Flag:** Other undocumented custom env var → severity: **MEDIUM**,
category: `ENV_VAR`.
**Flag:** Orphaned env var in `.env.example` (not referenced in code) →
severity: **LOW**, category: `ENV_VAR` (stale documentation).
**Info:** Report total counts: `<n> undocumented (X critical, Y high, Z medium),
<n> orphaned` → severity: **INFO**, category: `ENV_VAR`.

**Known high-count areas (as of v2.4):** Mempool config (~10 vars), BloXroute
config (~7 vars), multi-leg per-chain timeouts (~10 vars), A/B testing (~4 vars)
are commonly undocumented. These should be added to `.env.example` with comments.

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
1. Read `shared/config/src/feature-flags.ts` to get all 23 `FEATURE_*` flags.
2. List each flag with its pattern (opt-in `=== 'true'` or opt-out `!== 'false'`).
3. Verify cross-dependencies:
   - `FEATURE_SIGNAL_CACHE_READ` requires `FEATURE_ML_SIGNAL_SCORING`
   - `FEATURE_COMMIT_REVEAL_REDIS` requires `REDIS_URL`
   - `FEATURE_SOLANA_EXECUTION` requires `SOLANA_RPC_URL`
4. Check `.env.example` documents all feature flags with descriptions.

**Expected flags (23 total):**
`FEATURE_BATCHED_QUOTER`, `FEATURE_FLASH_LOAN_AGGREGATOR`, `FEATURE_COMMIT_REVEAL`,
`FEATURE_COMMIT_REVEAL_REDIS`, `FEATURE_DEST_CHAIN_FLASH_LOAN`,
`FEATURE_MOMENTUM_TRACKING`, `FEATURE_ML_SIGNAL_SCORING`,
`FEATURE_SIGNAL_CACHE_READ`, `FEATURE_LIQUIDITY_DEPTH_SIZING`,
`FEATURE_DYNAMIC_L1_FEES` (opt-out — ON by default),
`FEATURE_ORDERFLOW_PIPELINE`, `FEATURE_KMS_SIGNING`, `FEATURE_FAST_LANE`,
`FEATURE_BACKRUN_STRATEGY`, `FEATURE_UNISWAPX_FILLER`, `FEATURE_MEV_SHARE_BACKRUN`,
`FEATURE_SOLANA_EXECUTION`, `FEATURE_STATISTICAL_ARB`, `FEATURE_MEV_SHARE`,
`FEATURE_ADAPTIVE_RISK_SCORING`, `FEATURE_TIMEBOOST`, `FEATURE_FLASHBOTS_PROTECT_L2`,
`FEATURE_COW_BACKRUN`

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

### Check 1J — Unsafe Numeric Parse Detection

**Goal:** Every `parseInt(process.env.*)` and `parseFloat(process.env.*)` call must
have NaN protection. A raw `parseInt` on an undefined or malformed env var returns
`NaN`, which silently breaks numeric comparisons, causes servers to bind to invalid
ports, and makes circuit breakers fail to trip.

**Method:**
1. Use Grep to find all `parseInt(process.env` and `parseFloat(process.env` patterns
   in `.ts` files under `services/` and `shared/` (exclude `node_modules`, test files).
2. For each match, check the surrounding context (5 lines before/after) for NaN
   protection. Safe patterns include:
   - `Number.isNaN(...)` check after the parse
   - `parseEnvInt(...)` or `parseEnvIntSafe(...)` utility (from `shared/core/src/utils/env-utils.ts`)
   - `parsePort(...)` utility (from `shared/core/src/partition/config.ts`)
   - Inline `|| <default>` or `?? <default>` immediately after the parseInt call
     (note: `|| 0` is itself an anti-pattern for zero-valid values — flag separately)
3. Flag raw parseInt/parseFloat calls WITHOUT any NaN protection.

**Critical env vars to watch (NaN here causes silent system failures):**
- `HEALTH_CHECK_PORT` — NaN port = server won't bind
- `CIRCUIT_BREAKER_FAILURE_THRESHOLD` — NaN = circuit breaker never trips
- `CIRCUIT_BREAKER_COOLDOWN_MS` — NaN = immediate cooldown expiry
- `SHUTDOWN_DRAIN_TIMEOUT_MS` — NaN = drain loop exits immediately
- `MAX_CONCURRENT_EXECUTIONS` — NaN = execution limiter broken
- `BCRYPT_ROUNDS` — NaN = auth system broken

**Flag:** Raw `parseInt(process.env.*)` without NaN protection → severity: **HIGH**,
category: `UNSAFE_PARSE`.
**Flag:** Raw `parseFloat(process.env.*)` without NaN protection → severity: **HIGH**,
category: `UNSAFE_PARSE`.
**Info:** File uses safe `parseEnvInt()` / `parseEnvIntSafe()` utility → severity: **INFO**,
category: `UNSAFE_PARSE` (good pattern — acknowledge it).

**Recommendation for findings:** Replace raw `parseInt(process.env.X, 10)` with
`parseEnvInt('X', <defaultValue>)` from `shared/core/src/utils/env-utils.ts`.

---

### Check 1K — Redis Client Parity Audit

**Goal:** The `RedisClient` (key-value operations) and `RedisStreamsClient` (stream
operations) must have aligned reconnection and timeout behavior. Misaligned configs
create a split-brain scenario where one client recovers from outages but the other
gives up permanently.

**Method:**
1. Read `shared/core/src/redis/client.ts` — find the `retryStrategy` function,
   `connectTimeout`, `maxRetriesPerRequest`, and `lazyConnect` settings.
2. Read `shared/core/src/redis/streams.ts` — find the same settings.
3. Compare the following dimensions:

| Dimension | Must Align | Why |
|-----------|-----------|-----|
| `retryStrategy` return value | Both should retry forever OR both should give up | If streams retries forever but client gives up, leader election dies while stream consuming continues |
| `connectTimeout` | Both should have the same timeout | If client has no timeout but streams has 5000ms, client can hang indefinitely on first connection |
| `maxRetriesPerRequest` | Both should have same value or null | Affects per-command retry behavior |
| `lazyConnect` | Both should match | Affects when connection errors surface |

4. Flag any divergences with specific values from each file.

**Flag:** `retryStrategy` behavior diverges (one gives up, other retries forever) →
severity: **HIGH**, category: `REDIS_CLIENT_PARITY`.
**Flag:** `connectTimeout` missing from one client but present in the other →
severity: **HIGH**, category: `REDIS_CLIENT_PARITY`.
**Flag:** `maxRetriesPerRequest` values differ → severity: **MEDIUM**,
category: `REDIS_CLIENT_PARITY`.
**Info:** All settings aligned → severity: **INFO**,
category: `REDIS_CLIENT_PARITY` (good — both clients will behave identically
during outages).

**Known issue (as of v2.3):** `RedisClient` returns `null` after 15 retries
(permanently stops reconnecting), while `RedisStreamsClient` never returns `null`
(retries forever with capped backoff). This is a confirmed split-brain risk.

---

### Check 1L — Port Assignment Collision Detection

**Goal:** All services must use ports assigned in the central registry
(`shared/constants/service-ports.json`). Hardcoded ports that don't match the
registry can cause silent binding failures or port collisions in deployment.

**Method:**
1. Read `shared/constants/service-ports.json` to get the canonical port→service map.
2. Use Grep to find `DEFAULT_HEALTH_CHECK_PORT` assignments in all `.ts` files
   under `services/` (exclude `node_modules`, test files).
3. For each service, compare its hardcoded default port against the registry value.
4. Also search for hardcoded port numbers (3000-3100) in service `index.ts` and
   `constants.ts` files that don't reference the registry.

**Expected port assignments (from `service-ports.json`):**
| Service | Port |
|---------|------|
| coordinator | 3000 |
| partition-asia-fast | 3001 |
| partition-l2-turbo | 3002 |
| partition-high-value | 3003 |
| partition-solana | 3004 |
| execution-engine | 3005 |
| cross-chain-detector | 3006 |
| unified-detector | 3007 |
| mempool-detector | 3008 |
| monolith | 3100 |

**Flag:** Service default port ≠ registry port → severity: **MEDIUM**,
category: `PORT_COLLISION`.
**Flag:** Two services with the same default port → severity: **HIGH**,
category: `PORT_COLLISION` (binding collision at startup).
**Flag:** Hardcoded port number not in registry → severity: **LOW**,
category: `PORT_COLLISION` (undocumented port usage).

**Known issue (as of v2.3):** `unified-detector/src/constants.ts` defines
`DEFAULT_HEALTH_CHECK_PORT = 3001` which conflicts with `partition-asia-fast`.
The unified-detector is a library (not standalone), so the collision only manifests
if it's started standalone without `HEALTH_CHECK_PORT` override.

---

### Check 1M — Silent Error Swallowing Detection

**Goal:** Identify empty or silent `catch` blocks in production code that swallow
errors without logging, re-throwing, or returning a meaningful fallback. Silent
error swallowing in critical paths (execution, detection, stream processing) can
mask system failures for hours or days.

**Method:**
1. Use Grep to find empty catch blocks in `.ts` files under `services/` and `shared/`
   (exclude `node_modules`, exclude `__tests__/`, exclude `.test.ts`, `.spec.ts`).
   Search for these patterns:
   - `catch\s*\{\s*\}` — completely empty catch block
   - `catch\s*\([^)]*\)\s*\{\s*\}` — catch with parameter but empty body
   - `catch\s*\{[^}]*return\s+(undefined|null|false)\s*;?\s*\}` — catch that silently
     returns a falsy value without logging
2. For each match, read the surrounding context to determine:
   - **File location**: Is this in a hot-path file? (`price-matrix.ts`, `partitioned-detector.ts`,
     `execution-engine/`, `unified-detector/`)
   - **Function context**: Is this in a critical function? (execution, detection, stream
     processing, health checks)
   - **Has comment**: Does the catch block have a comment explaining why it's empty?
     (e.g., `// Best effort cleanup` — this is acceptable)
3. Classify each finding:
   - **Hot-path empty catch** → severity based on function criticality
   - **Empty catch with comment** → demote one severity level (documented decision)
   - **Empty catch in utility/cleanup code** → lower severity

**Flag:** Empty catch in hot-path or execution code → severity: **HIGH**,
category: `SILENT_ERROR`.
**Flag:** Empty catch in stream processing or health check code → severity: **MEDIUM**,
category: `SILENT_ERROR`.
**Flag:** Empty catch in utility/cleanup code without comment → severity: **LOW**,
category: `SILENT_ERROR`.
**Info:** Report total count of silent catches → severity: **INFO**,
category: `SILENT_ERROR`.

**Critical files to watch:**
- `services/execution-engine/src/strategies/cross-chain.strategy.ts` — `estimateUsdValue()`
  silently returns `undefined` on price estimation failure
- `services/execution-engine/src/strategies/solana-execution.strategy.ts` — block
  height expiry check failure swallowed
- `services/unified-detector/src/index.ts` — stream lag health check silently ignored

---

### Check 1N — Stream Serialization Type Fidelity Audit

**Goal:** Detect type coercion bugs in the Redis Streams data pipeline. When the
coordinator serializes opportunities for forwarding, numeric fields are converted
to strings via `.toString()`. The execution engine then casts the deserialized data
back using `as unknown as ArbitrageOpportunity`, but the numeric fields are still
strings at runtime. This causes subtle bugs where `typeof field === 'number'`
returns `false` and type guard functions reject valid data.

**Method:**
1. Read the stream serialization code:
   - `services/coordinator/src/utils/stream-serialization.ts` — find all
     `.toString()` conversions on numeric fields
   - List each field that gets converted: `profitPercentage`, `confidence`,
     `expectedProfit`, `estimatedProfit`, etc.
2. Read the stream deserialization code:
   - `services/execution-engine/src/consumers/validation.ts` — find `as unknown as`
     or `as ArbitrageOpportunity` casts
   - `shared/core/src/redis/streams.ts` — find `parseStreamResult` and check if
     it does any type restoration (JSON.parse, parseFloat, etc.)
3. Check for type guard functions that would break:
   - `services/coordinator/src/utils/type-guards.ts` — `getOptionalNumber()` and
     similar guards that check `typeof x === 'number'`
4. Verify if there's a deserialization step that converts strings back to numbers.

**Flag:** Numeric field serialized with `.toString()` but no corresponding
`parseFloat()` / `Number()` on deserialization → severity: **HIGH**,
category: `STREAM_TYPE_FIDELITY` (runtime type mismatch — TypeScript says `number`
but runtime has `string`).
**Flag:** `as unknown as <Type>` cast on stream data without type validation →
severity: **MEDIUM**, category: `STREAM_TYPE_FIDELITY` (unsafe cast bypasses type checking).
**Info:** All serialized fields properly restored on deserialization → severity: **INFO**,
category: `STREAM_TYPE_FIDELITY`.

**Impact of this bug:** JavaScript's loose comparison (`>`, `<`, `==`) still works
with string numbers (`"5.2" > 0.5` is `true`), so most comparisons won't break.
But strict equality (`===`), `typeof` checks, and type guard functions will fail
silently. The `getOptionalNumber()` type guard returns `undefined` for string values,
which can cause valid opportunities to be rejected.

---

### Check 1O — Redis Key Pattern Registry Audit

**Goal:** Detect potential Redis key collisions and undocumented key patterns.
Redis stream names have a centralized `RedisStreams` constant, but regular Redis
keys (SET/GET/HSET) are scattered across services with ad-hoc naming. Without a
registry, two services can accidentally use the same key prefix for different
purposes, causing silent data corruption.

**Method:**
1. Use Grep to find all Redis key patterns in production code. Search for:
   - `\.set\(` / `\.get\(` / `\.hset\(` / `\.hget\(` / `\.del\(` / `\.expire\(`
     calls in `.ts` files under `services/` and `shared/`
   - Extract the first argument (key pattern) from each call
   - Also search for string literals used as Redis key prefixes: patterns like
     `'lock:'`, `'bridge:'`, `'region:'`, `'pair:'`, `'price:'`, `'ratelimit:'`,
     `'risk:'`, `'commit-reveal:'`
2. Build a key prefix inventory:

| Prefix | Service | File | Purpose |
|--------|---------|------|---------|
| (populated from grep results) | | | |

3. Check for collisions:
   - Two services using the same prefix for different purposes → **HIGH**
   - A prefix that is a substring of another prefix (e.g., `lock:` vs `lock:execution:`)
     → **MEDIUM** (SCAN pattern `lock:*` would match both)
   - An undocumented prefix → **LOW** (should be added to key registry)

4. Compare against any existing key documentation (check `docs/` for Redis key docs).

**Flag:** Two services using the same key prefix → severity: **HIGH**,
category: `REDIS_KEY_REGISTRY` (collision risk).
**Flag:** Key prefix is substring of another prefix → severity: **MEDIUM**,
category: `REDIS_KEY_REGISTRY` (SCAN overlap risk).
**Flag:** Key prefix not documented → severity: **LOW**,
category: `REDIS_KEY_REGISTRY`.
**Info:** Report total unique key prefixes discovered → severity: **INFO**,
category: `REDIS_KEY_REGISTRY`.

**Known key prefixes (as of v2.4):**
`coordinator:leader:lock`, `lock:execution:`, `lock:` (distributed lock default),
`bridge:recovery:`, `bridge:recovery:corrupt:`, `commit-reveal:`, `region:health:`,
`pair:`, `risk:probabilities:`, `ratelimit:`, `api:`, `arbitrage:`, `auth:`,
`critical:`, `dlq:`, `price:`

---

### Check 1P — ADR Compliance Spot-Check

**Goal:** Verify code still complies with key architectural decisions documented
in ADRs. Architectural drift is insidious — code changes gradually violate
decisions that were made for important reasons (performance, security, reliability).

**Method:**
Check a curated set of high-impact ADR rules. These are spot-checks, not exhaustive
audits — they target the rules most likely to drift silently.

**ADR-022 (Hot-Path Memory):** No spread operators in tight loops on hot-path files.
```
Grep for: \.\.\.\w+ in these files only:
  shared/core/src/price-matrix.ts
  shared/core/src/partitioned-detector.ts
  shared/core/src/monitoring/provider-latency-tracker.ts  (ring buffer, zero-alloc recording)
  shared/core/src/monitoring/runtime-monitor.ts           (perf_hooks, GC observer)
  services/execution-engine/src/
  services/unified-detector/src/
Exclude: test files, comments, function signatures (rest params)
Only flag spread inside loops (for/while/forEach/map/reduce/filter)
```
**Flag:** Spread operator in loop on hot-path file → severity: **HIGH**,
category: `ADR_COMPLIANCE` (ADR-022 violation — allocation in hot path).

**ADR-022 (Ring Buffer Pattern):** Verify monitoring ring buffers use Float64Array.
```
Read shared/core/src/monitoring/provider-latency-tracker.ts
Confirm: RingBuffer class uses Float64Array (not regular Array)
Confirm: record() method is O(1) (no sort, no push, index wrapping only)
```
**Flag:** Ring buffer uses Array instead of Float64Array → severity: **MEDIUM**,
category: `ADR_COMPLIANCE` (ADR-022 violation — typed arrays required for zero-alloc).

**ADR-033 (Stale Price Window):** The stale price rejection threshold must be 30s.
```
Read shared/core/src/price-matrix.ts
Search for: STALE_PRICE_THRESHOLD or stalePriceThreshold or 30000 or 30_000
Verify the value is 30000 (30 seconds)
```
**Flag:** Stale price threshold ≠ 30000ms → severity: **HIGH**,
category: `ADR_COMPLIANCE` (ADR-033 violation — stale price window changed).
**Info:** Threshold confirmed at 30000ms → severity: **INFO**,
category: `ADR_COMPLIANCE`.

**ADR-002 (Redis Streams Only):** No direct HTTP calls between services.
```
Grep for: http://localhost:300[0-6] in .ts files under services/
Exclude: test files, health check polling in monitoring scripts, config comments
```
**Flag:** Direct HTTP call from one service to another → severity: **HIGH**,
category: `ADR_COMPLIANCE` (ADR-002 violation — bypass Redis Streams).
**Info:** No direct inter-service HTTP calls found → severity: **INFO**,
category: `ADR_COMPLIANCE`.

**ADR-018 (Circuit Breaker):** Default failure threshold must be 5.
```
Grep for: failureThreshold|CIRCUIT_BREAKER_FAILURE_THRESHOLD in shared/ and services/
Verify default value is 5
```
**Flag:** Circuit breaker default threshold ≠ 5 → severity: **MEDIUM**,
category: `ADR_COMPLIANCE` (ADR-018 parameter drift).
**Info:** Circuit breaker threshold confirmed at 5 → severity: **INFO**,
category: `ADR_COMPLIANCE`.

**ADR-005 (Hierarchical Cache):** Price matrix must use SharedArrayBuffer for L1.
```
Grep for: SharedArrayBuffer in shared/core/src/price-matrix.ts
Verify it's used for the primary price storage (not just imported)
```
**Flag:** SharedArrayBuffer not used in price-matrix.ts → severity: **CRITICAL**,
category: `ADR_COMPLIANCE` (ADR-005 violation — L1 cache architecture changed).
**Info:** SharedArrayBuffer confirmed in L1 cache → severity: **INFO**,
category: `ADR_COMPLIANCE`.

---

### Check 1Q — Infrastructure Config Alignment

**Goal:** Detect drift between infrastructure deployment configs (Fly.io, Docker)
and the source-of-truth values in code. Infrastructure config drift causes
production failures that are invisible in development.

**Method:**

1. **Port alignment:** Read all Fly.io TOML configs and Docker Compose files:
```
Glob: infrastructure/fly/*.toml
Glob: infrastructure/docker/docker-compose*.yml
```
Extract `internal_port`, `PORT` env vars, and port mappings from each config.
Compare against `shared/constants/service-ports.json` and the System Inventory
table at the top of this document.

2. **Health check path alignment:** Extract health check paths from:
   - Fly.io: `[http_service.checks]` or `[services.http_checks]` sections
   - Docker: `healthcheck` sections
   Compare against the service readiness endpoints in the System Inventory table.
   Pay special attention to coordinator (`/api/health/ready` vs `/ready`).

3. **Docker base image alignment:** Check all Dockerfiles reference `node:22-alpine`:
```
Glob: **/Dockerfile
Grep for: FROM node: in each Dockerfile
Verify all use node:22-alpine (matching engines: ">=22.0.0")
```

4. **Environment variable alignment:** Extract env vars from Docker Compose
   `environment:` sections and Fly.io `[env]` sections. Cross-reference against
   `.env.example` to flag any infrastructure-only env vars not in `.env.example`.

**Flag:** Port mismatch between infra config and service-ports.json → severity: **HIGH**,
category: `INFRA_DRIFT`.
**Flag:** Health check path mismatch → severity: **HIGH**,
category: `INFRA_DRIFT` (will cause failed health checks in production).
**Flag:** Dockerfile using wrong Node.js version → severity: **MEDIUM**,
category: `INFRA_DRIFT`.
**Flag:** Infrastructure env var not in .env.example → severity: **LOW**,
category: `INFRA_DRIFT`.
**Info:** All infrastructure configs aligned → severity: **INFO**,
category: `INFRA_DRIFT`.

---

### Check 1R — Timeout Hierarchy Audit

**Goal:** Detect misaligned shutdown and operation timeout hierarchies across
services. A service with a 10s shutdown timeout that depends on a Redis client
with a 30s connection timeout will force-kill before cleanup completes.

**Method:**
1. Grep for timeout configuration values across all services:
```
Grep for: shutdownTimeoutMs|SHUTDOWN.*TIMEOUT|DRAIN.*TIMEOUT|connectTimeout|
          socketTimeout|commandTimeout|closeServerWithTimeout
in: services/ and shared/
```

2. Build a timeout inventory per service:

| Service | Shutdown Timeout | Drain Timeout | Redis Connect | Redis Command | Server Close |
|---------|-----------------|---------------|---------------|---------------|-------------|
| (populated from grep results) | | | | | |

3. Validate the timeout hierarchy rule:
   **shutdown > drain > server-close** (so cleanup completes before force-kill)
   **shutdown > redis-connect** (so Redis reconnection doesn't outlast shutdown)

4. Check for hardcoded vs configurable timeouts:
   - Hardcoded timeouts in production code (not configurable via env) are **MEDIUM**
   - Timeouts using `parseInt(process.env.*)` without fallback are **HIGH** (covered
     by Check 1J, but flag the dependency here)

**Flag:** Service shutdown timeout < drain timeout → severity: **HIGH**,
category: `TIMEOUT_HIERARCHY` (drain will be force-killed).
**Flag:** Service shutdown timeout < Redis connect timeout → severity: **MEDIUM**,
category: `TIMEOUT_HIERARCHY` (Redis reconnect can outlast shutdown).
**Flag:** Hardcoded timeout in production code → severity: **LOW**,
category: `TIMEOUT_HIERARCHY` (not configurable for different environments).
**Info:** Timeout hierarchy consistent for service → severity: **INFO**,
category: `TIMEOUT_HIERARCHY`.

**Known timeout values (as of v2.5):**
- Coordinator: `SHUTDOWN_TIMEOUT=10000` (may be insufficient for multi-client cleanup)
- Execution engine: `SHUTDOWN_DRAIN_TIMEOUT_MS=30000` + 15s buffer = 45s total
- Partition services: 5000ms per shutdown step
- Redis client: `connectTimeout=10000`, `commandTimeout=5000` (defaults in redis client)
- `closeServerWithTimeout`: 5000ms default

---

### Phase 1 Summary

After all 18 checks, read `./monitor-session/findings/static-analysis.jsonl` and
output a summary:
```
PHASE 1 COMPLETE — Static Analysis (18 checks)
  CRITICAL: <n>  HIGH: <n>  MEDIUM: <n>  LOW: <n>  INFO: <n>
  Total findings: <n>
  Checks: 1A Stream Names, 1B Consumer Groups, 1C MAXLEN, 1D XACK,
          1E Env Var Drift, 1F Nullish Coalescing, 1G HMAC, 1H Feature Flags,
          1I Risk Config, 1J Unsafe Parse, 1K Redis Parity, 1L Port Collision,
          1M Silent Errors, 1N Type Fidelity, 1O Redis Key Registry,
          1P ADR Compliance, 1Q Infra Config, 1R Timeout Hierarchy
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

### Step 2C — Poll readiness (service-specific timeouts)

Poll each service's `/ready` endpoint every 5 seconds. Use **service-specific
timeouts** because different services have different startup characteristics.

| Service | Timeout | Reason |
|---------|---------|--------|
| Coordinator | 30s | Standard — Redis + leader election |
| P1-P4 Partitions | 30s | Standard — Redis + chain init |
| Execution Engine | 30s | Standard — Redis + consumer groups |
| Cross-Chain Detector | **120s** | Requires partition price data before ready (60-90s in simulation) |

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

# Cross-Chain Detector (extended timeout — needs partition data first)
curl -sf http://localhost:3006/ready || echo "NOT READY"
```

**For each service:**
- Poll every 5 seconds for up to the service-specific timeout.
- If ready within timeout → record startup time as **INFO**.
- If NOT ready after timeout → severity depends on service:
  - Cross-chain detector not ready after 120s → **HIGH** (extended timeout exceeded).
  - Any other service not ready after 30s → **CRITICAL**.
  Continue with remaining services.

**Note on Cross-Chain Detector readiness:** The cross-chain detector's `/ready`
endpoint requires `chainsMonitored > 0`, which means it needs at least one price
update from the partitions before reporting ready. In simulation mode this takes
60-90s (partitions must start, generate simulated data, and publish to streams).
Do NOT treat this expected delay as a failure — only flag if it exceeds 120s.

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

---

### Step 2E — Readiness Endpoint Consistency Check

**Goal:** Verify all services respond on a consistent `/ready` path. The
coordinator uses `/api/health/ready` while all other services use `/ready`.
Infrastructure tools (Fly.io, Docker, Kubernetes) expecting a uniform `/ready`
path will get 404 from the coordinator, causing deployment failures.

**Method:**
1. For each running service, test BOTH endpoint patterns:

```bash
# Test standard /ready on all services
for port in 3000 3001 3002 3003 3004 3005 3006; do
  STATUS=$(curl -sf -o /dev/null -w "%{http_code}" http://localhost:$port/ready 2>/dev/null || echo "000")
  echo "Port $port /ready: $STATUS"
done

# Test coordinator-specific /api/health/ready
STATUS=$(curl -sf -o /dev/null -w "%{http_code}" http://localhost:3000/api/health/ready 2>/dev/null || echo "000")
echo "Port 3000 /api/health/ready: $STATUS"
```

2. Test Prometheus metrics endpoints (Phase 3 requires these):

```bash
# Partitions, Execution Engine, Cross-Chain expose /metrics
for port in 3001 3002 3003 3004 3005 3006; do
  STATUS=$(curl -sf -o /dev/null -w "%{http_code}" http://localhost:$port/metrics 2>/dev/null || echo "000")
  echo "Port $port /metrics: $STATUS"
done

# Coordinator exposes /api/metrics/prometheus (different path)
STATUS=$(curl -sf -o /dev/null -w "%{http_code}" http://localhost:3000/api/metrics/prometheus 2>/dev/null || echo "000")
echo "Port 3000 /api/metrics/prometheus: $STATUS"
```

3. Also read infrastructure health check configs to verify they use the correct paths:

```bash
# Check Fly.io configs for health check paths
```
Use Grep to search `infrastructure/fly/*.toml` for `path =` in health check sections.
Use Grep to search `infrastructure/docker/docker-compose*.yml` for health check paths.

4. Compare infrastructure health check paths against the actual service endpoints.

**Flag:** Coordinator returns 404 on `/ready` (standard path) → severity: **HIGH**,
category: `SERVICE_READY` (infrastructure tools using uniform path will fail).
**Flag:** Any non-coordinator service returns 404 on `/ready` → severity: **CRITICAL**,
category: `SERVICE_READY` (service missing readiness endpoint).
**Flag:** Infrastructure config uses a path that returns 404 on the target service →
severity: **HIGH**, category: `CONFIG_DRIFT` (deployment health check will fail).
**Flag:** Any service `/metrics` endpoint returns non-200 → severity: **MEDIUM**,
category: `METRICS_ENDPOINT` (Phase 3 enhanced monitoring checks will fail).
**Flag:** Coordinator `/api/metrics/prometheus` returns non-200 → severity: **MEDIUM**,
category: `METRICS_ENDPOINT` (coordinator metrics scraping will fail).
**Info:** All services respond on their documented paths → severity: **INFO**,
category: `SERVICE_READY`.

---

Output:
```
PHASE 2 COMPLETE — Startup
  Services ready: <n>/7 (list names)
  Services failed: <n> (list names)
  Streams discovered: <n>/24
  Missing streams: <list>
  Unexpected streams: <list>
  Readiness endpoints: <n>/7 consistent
```

---


## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## PHASE 3 — RUNTIME VALIDATION (~120 seconds)
## All services should be running. Uses curl + redis-cli.
## 8 subsections, 35 checks. Enhanced monitoring metrics integrated.
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Record all findings to `./monitor-session/findings/runtime.jsonl`:
```json
{
  "phase": "RUNTIME",
  "findingId": "RT-001",
  "category": "SERVICE_HEALTH|LEADER_ELECTION|CIRCUIT_BREAKER|CB_TRANSITIONS|BACKPRESSURE|DLQ|DLQ_ROOT_CAUSE|STREAM_TOPOLOGY|CONSUMER_LAG|STUCK_MESSAGE|DEAD_CONSUMER|STREAM_TRANSIT|METRICS|METRICS_COMPLETENESS|RUNTIME_PERFORMANCE|PROVIDER_QUALITY|DETECTION_QUALITY|BUSINESS_INTELLIGENCE|WEBSOCKET_HEALTH|PROVIDER_HEALTH|RISK_STATE|LATENCY|GAS_SPIKE|SIMULATION|EXECUTION_PROBABILITY|BRIDGE_RECOVERY|MEMORY|HEALTH_SCHEMA",
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

## ── Section 3.1: Service Health & Schema ──

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

### Check 3C — Health Endpoint Response Schema Validation

**Goal:** Verify that each service's `/health` response contains the expected
fields with correct types. Schema drift breaks downstream monitoring tools.

Use the `/health` responses already collected in Check 3A. For each service,
validate the response against its expected schema.

**Expected schemas per service:**

**Coordinator** (`/api/health`):
```
Required fields:
  status: string ("healthy" | "degraded" | "unhealthy")
  uptime: number (seconds)
  isLeader: boolean
Optional fields:
  services: object (partition health summaries)
  streams: object (stream health summaries)
  backpressure: object | boolean
  version: string
```

**Partitions P1-P4** (`/health`):
```
Required fields:
  status: string ("healthy" | "degraded" | "unhealthy")
  uptime: number (seconds)
  eventsProcessed: number
  chains: array<string> | number (active chain count)
Optional fields (v3.0 — enhanced monitoring):
  pairsMonitored: number
  lastPriceUpdate: string (ISO8601) | number (timestamp)
  memoryUsage: object { rss, heapUsed, heapTotal }
  stalePriceRejections: number (D2 metric)
  wsMessageCounts: Record<string, number> (C2 metric)
  maxPriceStalenessMs: number (C5 metric)
  avgDetectionCycleDurationMs: number (D3 metric)
  avgOpportunitiesPerCycle: number (D4 metric)
```

**Execution Engine** (`/health`):
```
Required fields:
  status: string ("healthy" | "degraded" | "unhealthy")
  uptime: number (seconds)
Optional fields:
  queueSize: number
  activeExecutions: number
  successRate: number
  drawdownState: string (NORMAL|CAUTION|HALT|RECOVERY)
  consecutiveLosses: number
  memoryUsage: object
```

**Cross-Chain Detector** (`/health`):
```
Required fields:
  status: string ("healthy" | "degraded" | "unhealthy")
  uptime: number (seconds)
Optional fields:
  partitionsConnected: number
  crossChainPairsMonitored: number
  lastDetection: string | number
  memoryUsage: object
```

**Validation rules:**
1. All required fields must be present (not null/undefined)
2. Field types must match expected types (string is string, number is number)
3. `status` must be one of the valid enum values
4. `uptime` must be > 0 (service has been running)
5. Numeric fields must not be NaN

**Flag:** Required field missing from health response → severity: **HIGH**,
category: `HEALTH_SCHEMA` (schema drift — downstream tools may break).
**Flag:** Field type mismatch (e.g., string where number expected) → severity: **MEDIUM**,
category: `HEALTH_SCHEMA`.
**Flag:** `status` field contains unexpected value → severity: **HIGH**,
category: `HEALTH_SCHEMA` (enum drift).
**Flag:** `uptime` is 0 or NaN → severity: **MEDIUM**,
category: `HEALTH_SCHEMA`.
**Info:** All health schemas valid → severity: **INFO**,
category: `HEALTH_SCHEMA`.

---

## ── Section 3.2: Risk & Circuit Breakers ──

### Check 3D — Circuit Breaker States

```bash
curl -sf http://localhost:3005/circuit-breaker | jq .
```

**Flag:** Any chain in `OPEN` state → **HIGH** (chain is blocked from execution).
**Flag:** Any chain in `HALF_OPEN` state → **MEDIUM** (chain recovering).
**Flag:** Endpoint unreachable → **HIGH**.

---

### Check 3E — Risk Management State (Drawdown Circuit Breaker)

**Goal:** Verify the drawdown circuit breaker is in NORMAL state. The system
can pass all health checks while producing zero profit because the drawdown
breaker is in HALT state — the #1 profitability blind spot.

States: NORMAL (100% sizing) → CAUTION (75%) → HALT (0% — trading stopped)
→ RECOVERY (50%)

**Method:**
```bash
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

### Check 3F — Circuit Breaker Transition History (Placeholder: E1-E2)

**Goal:** Verify circuit breaker transition history is available and no
flapping is occurring. This check validates metrics from research GAP-7
(state machine observability).

**Method:**
```bash
# Check for circuit breaker transition metrics
curl -sf http://localhost:3005/metrics 2>/dev/null | grep -i circuit_breaker_transition
```

**If metric `circuit_breaker_transitions_total` exists:**
- Parse transitions by `from_state` and `to_state` labels
- **Flag:** >5 transitions in session → **MEDIUM**, category: `CB_TRANSITIONS`
  (circuit breaker flapping — thresholds may be miscalibrated)
- **Flag:** CLOSED→OPEN transitions for same chain >3 → **HIGH**,
  category: `CB_TRANSITIONS` (chain is repeatedly failing)

**If metric does NOT exist:**
- Record as **INFO**, category: `CB_TRANSITIONS`:
  "Circuit breaker transition history not yet implemented (research E1-E2).
  Current state-only check in 3D is the fallback."

---

### Check 3G — Backpressure Episode Tracking (Placeholder: E4-E5)

**Goal:** Verify backpressure episode metrics are available and consistent
with current backpressure state.

**Method:**
```bash
curl -sf http://localhost:3000/api/health | jq '{backpressure}'
curl -sf http://localhost:3005/metrics 2>/dev/null | grep -i backpressure_episodes
```

**If metric `backpressure_episodes_total` exists:**
- Compare episode count with current backpressure state from coordinator health
- **Flag:** Episodes >0 but backpressure currently inactive and stream fill <20% →
  **INFO** (backpressure activated and resolved — healthy behavior)
- **Flag:** Episodes >10 in session → **MEDIUM**, category: `BACKPRESSURE`
  (frequent backpressure — execution engine too slow or detection too fast)

**If metric does NOT exist:**
- Record as **INFO**, category: `BACKPRESSURE`:
  "Backpressure episode tracking not yet implemented (research E4-E5).
  Manual check via coordinator health + stream fill ratio is the fallback."

---

## ── Section 3.3: Data Flow & DLQ ──

### Check 3H — Dead Letter Queue Status

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

### Check 3I — Redis Stream Topology Validation

For ALL 24 declared streams, verify the stream exists and has the
correct consumer groups attached:

```bash
for stream in stream:price-updates stream:swap-events stream:opportunities \
  stream:whale-alerts stream:service-health stream:service-events \
  stream:coordinator-events stream:health stream:health-alerts \
  stream:execution-requests stream:execution-results \
  stream:pending-opportunities stream:volume-aggregates \
  stream:circuit-breaker stream:system-failover stream:system-commands \
  stream:fast-lane stream:dead-letter-queue stream:forwarding-dlq \
  stream:dlq-alerts stream:system-failures stream:system-control \
  stream:system-scaling stream:service-degradation; do

  echo "=== $stream ==="
  redis-cli XINFO STREAM $stream 2>&1
  redis-cli XINFO GROUPS $stream 2>&1
done
```

For each stream, verify:
1. **Exists** — `XINFO STREAM` succeeds. Missing → **MEDIUM** for on-demand
   streams (system-failures, system-control, system-scaling, service-degradation,
   dlq-alerts — only created when triggered). Missing → **HIGH** for active streams.
2. **Has expected consumer groups** — compare `XINFO GROUPS` output against the
   System Inventory table. Missing group → **HIGH**.
3. **Consumer groups have active consumers** — `consumers` field > 0 for each
   group. Zero consumers → **CRITICAL** (dead consumer group).
4. **Stream length is reasonable** — not 0 (for active streams like `price-updates`)
   and not at MAXLEN cap (indicates producer outpacing consumer trim).

**Note on on-demand streams:** The 5 on-demand streams (`system-failures`,
`system-control`, `system-scaling`, `service-degradation`, `dlq-alerts`) may
not exist in Redis during normal operation. Their absence is **MEDIUM** (not
CRITICAL) since they're created on first use. Their consumer groups
(`self-healing-manager` for the first 3) are also created dynamically.

---

### Check 3J — Consumer Lag & Pending Messages (Per-Service Discovery)

**Goal:** Check pending messages for EVERY consumer group on EVERY active stream,
not just hardcoded stream/group pairs. Services may create consumer groups
dynamically (e.g., `failover-coordinator`, `self-healing-manager`), and the
hardcoded list can drift.

**Method — Part 1 (Dynamic discovery):**
For each stream discovered in Step 2D, query all consumer groups:

```bash
for stream in $(cat ./monitor-session/streams/discovered.txt); do
  echo "=== $stream ==="
  redis-cli XINFO GROUPS $stream 2>&1
done
```

Parse the output to build a complete map:
```
stream → [group1, group2, ...] → per-group pending count
```

**Method — Part 2 (Per-group pending check):**
For each (stream, group) pair discovered above:

```bash
redis-cli XPENDING <stream> <group>
```

This returns: total pending, min-id, max-id, consumer list with per-consumer pending.

**Method — Part 3 (Cross-reference with expected owners):**
For each consumer group, verify it belongs to the expected service:

| Group Pattern | Expected Owner |
|---------------|---------------|
| `coordinator-group` | Coordinator (port 3000) |
| `cross-chain-detector-group` | Cross-Chain Detector (port 3006) |
| `execution-engine-group` | Execution Engine (port 3005) |
| `mempool-detector-group` | Mempool Detector (port 3008) |
| `orderflow-pipeline` | Coordinator (orderflow subsystem) |
| `self-healing-manager` | Expert Self-Healing Manager (dynamic) |
| `failover-*` | Cross-Region Health Manager (dynamic) |

Flag any group not matching a known pattern.

**Also check ALL known critical pairs (comprehensive list):**
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
redis-cli XPENDING stream:forwarding-dlq coordinator-group
redis-cli XPENDING stream:fast-lane execution-engine-group
redis-cli XPENDING stream:swap-events coordinator-group
redis-cli XPENDING stream:volume-aggregates coordinator-group
redis-cli XPENDING stream:pending-opportunities cross-chain-detector-group
redis-cli XPENDING stream:pending-opportunities orderflow-pipeline
```

**Thresholds (per group):**
- Pending count > 50 → **HIGH** (consumer falling behind).
- Pending count > 100 → **CRITICAL** (consumer overwhelmed).
- Any message pending for > 30 seconds (check oldest pending entry) → **HIGH**
  (stuck message — consumer may have crashed without ACKing).
- Any message with delivery count > 3 → **HIGH** (message being retried
  repeatedly — likely a poison message).

**Additional per-service checks:**
- **Lag delta**: For shared streams (e.g., `stream:price-updates` consumed by both
  `coordinator-group` and `cross-chain-detector-group`), compare pending counts
  between groups. If one group has >10x the pending count of the other →
  severity: **HIGH**, category: `CONSUMER_LAG` (one consumer is significantly
  slower than its peer on the same stream).
- **Unknown group**: Consumer group not matching any expected pattern →
  severity: **MEDIUM**, category: `CONSUMER_LAG` (rogue or undocumented consumer).

---

### Check 3K — DLQ Root Cause Analysis

**Goal:** When the DLQ has entries (detected in Check 3H), analyze WHY messages
are failing instead of just reporting the count.

**Prerequisite:** Only run this check if Check 3H found DLQ length > 0.

**Method:**
1. Read the most recent 50 DLQ entries to build a root cause profile:

```bash
redis-cli XREVRANGE stream:dead-letter-queue + - COUNT 50
```

2. For each entry, extract these fields:
   - `reason` or `error` — why the message was rejected
   - `originalStream` — which stream the message came from
   - `originalId` — the original message ID
   - `service` — which service rejected it (if available)
   - `timestamp` — when the rejection happened

3. Group findings by rejection reason:

| Reason | Count (of 50 sampled) | % of Sample | Source Stream |
|--------|----------------------|-------------|---------------|
| (from data) | | | |

4. Identify the top-3 rejection reasons.

5. Also check the forwarding DLQ (coordinator → execution engine failures):
```bash
redis-cli XREVRANGE stream:forwarding-dlq + - COUNT 20
```

6. Check DLQ growth rate: compare current XLEN against the baseline from Step 2D.
   Calculate entries per minute.

7. **NEW: Check DLQ local fallback files** — If Redis DLQ write fails, the system
   writes to local JSONL files. Check for recent fallback activity:
```bash
ls -la ./data/dlq-fallback-*.jsonl 2>/dev/null
ls -la ./data/dlq-forwarding-fallback-*.jsonl 2>/dev/null
```
   **Flag:** Fallback files exist with today's date → severity: **HIGH**,
   category: `DLQ_ROOT_CAUSE` (Redis DLQ write is failing — messages going to disk).

**Flag:** Single rejection reason accounts for >50% of DLQ entries →
severity: **HIGH**, category: `DLQ_ROOT_CAUSE` (systemic failure).
**Flag:** DLQ growing at >1 entry/second → severity: **HIGH**,
category: `DLQ_ROOT_CAUSE` (active failure — system is actively producing failures).
**Flag:** DLQ entries show `hmac_verification_failed` reason → severity: **CRITICAL**,
category: `DLQ_ROOT_CAUSE` (HMAC signing key mismatch).
**Flag:** Forwarding DLQ has entries → severity: **CRITICAL**,
category: `DLQ_ROOT_CAUSE` (coordinator cannot reach execution engine).
**Info:** DLQ entries analyzed with root cause distribution → severity: **INFO**,
category: `DLQ_ROOT_CAUSE`.

---

### Check 3L — Stream Transit Time (F1)

**Goal:** Validate cross-service message transit time. The `stream_message_transit_ms`
metric measures the time a message spends in Redis between publish and consume.
This is the research GAP-6 metric — critical for verifying the pipeline is actually
fast, not just appearing fast.

**Method:**
```bash
curl -sf http://localhost:3005/metrics 2>/dev/null | grep stream_message_transit
```

Parse the `stream_message_transit_ms` histogram. Look for per-stream breakdowns.

**Flag:** p95 transit time > 100ms on any stream → severity: **HIGH**,
category: `STREAM_TRANSIT` (messages spending too long in Redis — consumers lagging
or Redis under pressure).
**Flag:** p95 transit time > 50ms → severity: **MEDIUM**, category: `STREAM_TRANSIT`.
**Flag:** Metric not present → severity: **MEDIUM**, category: `STREAM_TRANSIT`
(observability gap — cross-service latency invisible).
**Flag:** Transit time on `stream:execution-requests` > 200ms → severity: **HIGH**,
category: `STREAM_TRANSIT` (critical path — opportunities going stale between
coordinator and execution engine).
**Info:** All stream transit times < 50ms → severity: **INFO**,
category: `STREAM_TRANSIT`.

**Context:** In simulation mode with all services on localhost, transit times should
be <10ms. In production with network hops, 20-50ms is acceptable. >100ms indicates
a real bottleneck.

---

### Check 3M — Stream ACK Delay (Placeholder: F2)

**Goal:** Measure time between message read (xreadgroup) and acknowledgment (xack).

**Method:**
```bash
curl -sf http://localhost:3005/metrics 2>/dev/null | grep stream_ack_delay
```

**If metric `stream_ack_delay_ms` exists:**
- Parse per-stream/consumer-group breakdown
- **Flag:** p95 ack delay > 500ms → **MEDIUM** (slow processing)
- **Flag:** p95 ack delay > 2000ms → **HIGH** (very slow — risk of redelivery)

**If metric does NOT exist:**
- Record as **INFO**, category: `STREAM_TRANSIT`:
  "Stream ACK delay tracking not yet implemented (research F2). Check 3J
  pending message age is the fallback for detecting slow consumers."

---

### Check 3N — MAXLEN Trim Detection (Placeholder: F3)

**Goal:** Detect when MAXLEN trimming causes silent data loss — messages
trimmed before any consumer reads them.

**Method:**
```bash
# Check for trim counter metric
curl -sf http://localhost:3005/metrics 2>/dev/null | grep stream_trimmed
curl -sf http://localhost:3001/metrics 2>/dev/null | grep stream_trimmed
```

**If metric `stream_trimmed_messages_total` exists:**
- **Flag:** Any non-zero trim count on `stream:execution-requests` or
  `stream:fast-lane` → **HIGH** (critical path data loss)
- **Flag:** Non-zero trim count on `stream:price-updates` → **MEDIUM**
  (price data lost before consumption)

**If metric does NOT exist (expected currently):**
- Perform a manual approximation: For each active stream, compare XLEN against
  MAXLEN. If XLEN >= 90% of MAXLEN, trimming is actively occurring:

```bash
# Check streams at risk of MAXLEN trimming
for stream_info in "stream:price-updates:100000" "stream:opportunities:500000" \
  "stream:execution-requests:100000" "stream:fast-lane:5000"; do
  STREAM=$(echo $stream_info | cut -d: -f1-2)
  MAXLEN=$(echo $stream_info | cut -d: -f3)
  XLEN=$(redis-cli XLEN $STREAM)
  RATIO=$(echo "scale=2; $XLEN * 100 / $MAXLEN" | bc 2>/dev/null || echo "N/A")
  echo "$STREAM: $XLEN / $MAXLEN ($RATIO%)"
done
```

- **Flag:** Any stream at >90% of MAXLEN → severity: **HIGH**, category: `STREAM_TRANSIT`
  (active trimming — consumers may be losing messages).
- **Flag:** Any stream at >80% of MAXLEN → severity: **MEDIUM** (approaching trim).
- Record as **INFO**: "MAXLEN trim counter not yet implemented (research F3).
  Manual XLEN-vs-MAXLEN check used as approximation."

---

## ── Section 3.4: Runtime Performance ──

### Check 3O — Event Loop Health (B1)

**Goal:** Verify event loop delay is within the <50ms hot-path target (ADR-022).
Event loop lag is the #1 hidden cause of latency spikes — GC pauses, blocking
I/O, or CPU saturation all manifest as event loop delay.

**Method:**
Scrape `runtime_eventloop_delay_*` metrics from all services:

```bash
for port in 3001 3002 3003 3004 3005; do
  echo "=== Port $port ==="
  curl -sf http://localhost:$port/metrics 2>/dev/null | grep runtime_eventloop_delay
done
# Coordinator uses /api/metrics/prometheus
curl -sf http://localhost:3000/api/metrics/prometheus 2>/dev/null | grep runtime_eventloop_delay
```

Parse: `runtime_eventloop_delay_p99_ms`, `runtime_eventloop_delay_p50_ms`,
`runtime_eventloop_delay_mean_ms`, `runtime_eventloop_delay_max_ms`.

**Flag:** Any service with `runtime_eventloop_delay_p99_ms` > 50ms → severity: **HIGH**,
category: `RUNTIME_PERFORMANCE` (event loop blocking — violates hot-path target).
**Flag:** Any service with `runtime_eventloop_delay_p99_ms` > 20ms → severity: **MEDIUM**,
category: `RUNTIME_PERFORMANCE` (event loop starting to lag).
**Flag:** `runtime_eventloop_delay_max_ms` > 200ms → severity: **HIGH**,
category: `RUNTIME_PERFORMANCE` (severe event loop stall — likely GC or sync I/O).
**Flag:** Metrics not present → severity: **MEDIUM**, category: `RUNTIME_PERFORMANCE`
(RuntimeMonitor may not be started — check service index.ts for `getRuntimeMonitor().start()`).
**Info:** All services p99 < 20ms → severity: **INFO**, category: `RUNTIME_PERFORMANCE`.

---

### Check 3P — GC Pressure (B2)

**Goal:** Verify GC is not causing latency spikes. Major GC (mark-sweep-compact)
events cause stop-the-world pauses that block the event loop.

**Method:**
```bash
for port in 3001 3002 3003 3004 3005; do
  echo "=== Port $port ==="
  curl -sf http://localhost:$port/metrics 2>/dev/null | grep runtime_gc
done
curl -sf http://localhost:3000/api/metrics/prometheus 2>/dev/null | grep runtime_gc
```

Parse: `runtime_gc_pause_total_ms`, `runtime_gc_count_total`, `runtime_gc_major_count_total`.

**Flag:** `runtime_gc_major_count_total` > 10 in session → severity: **MEDIUM**,
category: `RUNTIME_PERFORMANCE` (frequent major GC — heap may be too small or
leaking. ADR-022 ring buffers should minimize allocations).
**Flag:** `runtime_gc_pause_total_ms` > 500ms cumulative → severity: **MEDIUM**,
category: `RUNTIME_PERFORMANCE` (significant time spent in GC).
**Flag:** Major GC count > total GC count * 0.1 → severity: **HIGH**,
category: `RUNTIME_PERFORMANCE` (>10% of GCs are major — heap pressure).
**Info:** Report GC metrics per service for the report.

---

### Check 3Q — Memory Breakdown (B3-B6, replaces old 3O)

**Goal:** Verify memory usage is within thresholds using detailed breakdown
from RuntimeMonitor, not just RSS.

**Method:**
```bash
for port in 3001 3002 3003 3004 3005; do
  echo "=== Port $port ==="
  curl -sf http://localhost:$port/metrics 2>/dev/null | grep runtime_memory
done
curl -sf http://localhost:3000/api/metrics/prometheus 2>/dev/null | grep runtime_memory
```

Parse: `runtime_memory_heap_used_mb`, `runtime_memory_heap_total_mb`,
`runtime_memory_rss_mb`, `runtime_memory_external_mb`, `runtime_memory_array_buffers_mb`.

**Flag:** Any service with `heap_used / heap_total` > 85% → severity: **HIGH**,
category: `MEMORY` (heap pressure — approaching OOM).
**Flag:** Any service with `rss_mb` > 500 → severity: **HIGH**, category: `MEMORY`
(high RSS — may cause OOM kill on constrained platforms like Fly.io).
**Flag:** `external_mb` > 200 → severity: **MEDIUM**, category: `MEMORY`
(SharedArrayBuffer/external memory growth — check L1 price matrix).
**Flag:** Memory metrics not present → severity: **LOW**, category: `MEMORY`
(fall back to /health memoryUsage field).

Also check Redis memory:
```bash
redis-cli INFO memory
# Parse: used_memory_human, used_memory_peak_human, maxmemory
```

**Flag:** Redis memory >75% of maxmemory → **HIGH**, category: `MEMORY`
(Redis eviction risk).

---

## ── Section 3.5: Provider Quality ──

### Check 3R — Provider Latency & Connectivity (Enhanced, C1)

**Goal:** Verify RPC providers are responsive with per-chain latency visibility.
Goes beyond binary connected/disconnected to show actual response times.

**Method — Part 1 (Connection status from /stats):**
```bash
curl -sf http://localhost:3001/stats | jq .  # P1: BSC, Polygon, AVAX, FTM
curl -sf http://localhost:3002/stats | jq .  # P2: Arb, OP, Base, Blast, Scroll
curl -sf http://localhost:3003/stats | jq .  # P3: ETH, zkSync, Linea
curl -sf http://localhost:3004/stats | jq .  # P4: Solana
```

For each chain, check connection status, messagesReceived, activeSubscriptions.

**Method — Part 2 (RPC latency from /metrics):**
```bash
for port in 3001 3002 3003 3004; do
  echo "=== Port $port ==="
  curl -sf http://localhost:$port/metrics 2>/dev/null | grep provider_rpc_call_duration
done
```

Parse `provider_rpc_call_duration_ms{chain="...",quantile="0.95"}` for each chain.

**Flag:** Any chain with 0 messages received → **CRITICAL**, category: `WEBSOCKET_HEALTH`
(dead WebSocket = zero detection on that chain).
**Flag:** Any chain with 0 active subscriptions → **CRITICAL**,
category: `WEBSOCKET_HEALTH`.
**Flag:** Any chain with RPC p95 > 500ms → **HIGH**, category: `PROVIDER_QUALITY`
(degraded provider — may cause stale prices).
**Flag:** Any chain with RPC p95 > 200ms → **MEDIUM**, category: `PROVIDER_QUALITY`.
**Flag:** RPC latency metrics not present → **INFO** (provider latency tracker
may not be wired into providers yet — connection status check is the fallback).

---

### Check 3S — RPC Error Rate (C4)

**Goal:** Detect elevated RPC error rates that indicate degraded or failing providers.

**Method:**
```bash
for port in 3001 3002 3003 3004; do
  curl -sf http://localhost:$port/metrics 2>/dev/null | grep provider_rpc_errors_total
done
```

Parse `provider_rpc_errors_total{chain="...",error_type="..."}`.

**Flag:** Any chain with total errors > 10 in session → severity: **MEDIUM**,
category: `PROVIDER_QUALITY` (elevated error rate).
**Flag:** Any chain where `error_type="rate_limit"` count > 5 → severity: **HIGH**,
category: `PROVIDER_QUALITY` (rate limited — provider is throttling us).
**Flag:** Any chain where `error_type="timeout"` count > 10 → severity: **HIGH**,
category: `PROVIDER_QUALITY` (provider timeouts — may need fallback provider).
**Info:** Zero errors across all chains → severity: **INFO**, category: `PROVIDER_QUALITY`.

---

### Check 3T — Reconnection Frequency (C3)

**Goal:** Detect unstable WebSocket connections. Frequent reconnections cause
data gaps during the reconnection window.

**Method:**
```bash
for port in 3001 3002 3003 3004; do
  curl -sf http://localhost:$port/metrics 2>/dev/null | grep provider_ws_reconnection
done
```

Parse `provider_ws_reconnection_duration_ms{chain="...",quantile="0.95"}`.

**Flag:** Any chain with > 5 reconnections in session → severity: **HIGH**,
category: `PROVIDER_QUALITY` (unstable provider — frequent reconnections cause
data gaps that lead to stale prices).
**Flag:** Reconnection p95 > 10s → severity: **MEDIUM**, category: `PROVIDER_QUALITY`
(slow recovery — long data gaps during reconnection).
**Info:** No reconnections or very few → severity: **INFO**, category: `PROVIDER_QUALITY`.

Also cross-reference with `/stats` reconnection counts from Check 3R.

---

### Check 3U — WebSocket Message Rate (C2)

**Goal:** Verify all chains are receiving WebSocket messages at expected rates.
A chain with zero messages means zero detection.

**Method:**
```bash
for port in 3001 3002 3003 3004; do
  curl -sf http://localhost:$port/metrics 2>/dev/null | grep provider_ws_messages_total
done
```

Parse `provider_ws_messages_total{chain="...",event_type="..."}`.

**Flag:** Any active chain with 0 messages total → severity: **CRITICAL**,
category: `WEBSOCKET_HEALTH` (dead WebSocket — no events being received).
**Flag:** Any chain with message rate >10x lower than peer chains → severity: **MEDIUM**,
category: `WEBSOCKET_HEALTH` (degraded — significantly fewer events than expected).
**Info:** All chains receiving messages → severity: **INFO**, category: `WEBSOCKET_HEALTH`.

---

### Check 3V — Price Staleness (C5, D2)

**Goal:** Verify prices are fresh and stale price rejection is working correctly.
Stale prices are the #1 cause of failed trades.

**Method:**
```bash
curl -sf http://localhost:3001/stats | jq '{maxPriceStalenessMs, stalePriceRejections}'
curl -sf http://localhost:3002/stats | jq '{maxPriceStalenessMs, stalePriceRejections}'
curl -sf http://localhost:3003/stats | jq '{maxPriceStalenessMs, stalePriceRejections}'
curl -sf http://localhost:3004/stats | jq '{maxPriceStalenessMs, stalePriceRejections}'
```

**Flag:** `maxPriceStalenessMs` > 30000 (30s) on any partition → severity: **HIGH**,
category: `PROVIDER_QUALITY` (ADR-033 stale price threshold violated — detection
is working with outdated prices).
**Flag:** `maxPriceStalenessMs` > 15000 → severity: **MEDIUM**, category: `PROVIDER_QUALITY`.
**Flag:** `stalePriceRejections` > 0 → severity: **INFO** (stale price filtering
is working correctly — report the count per partition).
**Flag:** Fields not present in /stats → severity: **INFO** (enhanced detection
metrics not yet exposed — upgrade chain-instance.ts).

---

## ── Section 3.6: Detection Quality ──

### Check 3W — Detection Cycle Timing (D3)

**Goal:** Verify detection cycles complete within the <50ms hot-path budget.
A slow detection cycle means opportunities are found late and may be stale
by the time they reach execution.

**Method:**
```bash
curl -sf http://localhost:3001/stats | jq '{avgDetectionCycleDurationMs}'
curl -sf http://localhost:3002/stats | jq '{avgDetectionCycleDurationMs}'
curl -sf http://localhost:3003/stats | jq '{avgDetectionCycleDurationMs}'
curl -sf http://localhost:3004/stats | jq '{avgDetectionCycleDurationMs}'
```

**Flag:** `avgDetectionCycleDurationMs` > 50 on any partition → severity: **HIGH**,
category: `DETECTION_QUALITY` (exceeds hot-path target — opportunities will be stale).
**Flag:** `avgDetectionCycleDurationMs` > 20 → severity: **MEDIUM**,
category: `DETECTION_QUALITY` (approaching target).
**Flag:** Field not present → severity: **INFO** (metric not yet exposed).
**Info:** All partitions < 20ms → severity: **INFO**, category: `DETECTION_QUALITY`.

---

### Check 3X — Opportunities Per Cycle (D4)

**Goal:** Verify detection is finding opportunities. Zero opportunities across
all partitions after 60s of uptime indicates detection logic issues.

**Method:**
```bash
curl -sf http://localhost:3001/stats | jq '{avgOpportunitiesPerCycle}'
curl -sf http://localhost:3002/stats | jq '{avgOpportunitiesPerCycle}'
curl -sf http://localhost:3003/stats | jq '{avgOpportunitiesPerCycle}'
curl -sf http://localhost:3004/stats | jq '{avgOpportunitiesPerCycle}'
```

**Flag:** `avgOpportunitiesPerCycle` is 0 across ALL partitions after > 60s uptime
→ severity: **MEDIUM**, category: `DETECTION_QUALITY` (no opportunities being
detected — may be expected in low-realism simulation).
**Info:** Report per-partition breakdown for the report.

---

### Check 3Y — Cache Effectiveness (Placeholder: D1, D5)

**Goal:** Verify pair cache and price snapshot cache are effective. High eviction
rates or low hit rates indicate cache thrashing.

**Method:**
```bash
for port in 3001 3002 3003 3004; do
  curl -sf http://localhost:$port/metrics 2>/dev/null | grep pair_cache
done
```

**If metrics `pair_cache_hit_total` and `pair_cache_miss_total` exist:**
- Calculate hit rate: `hits / (hits + misses) * 100`
- **Flag:** Hit rate < 50% → severity: **MEDIUM**, category: `DETECTION_QUALITY`
  (cache thrashing — increase cache size or reduce pair space)
- **Flag:** Hit rate < 20% → severity: **HIGH** (cache is ineffective)

**If metrics do NOT exist:**
- Record as **INFO**, category: `DETECTION_QUALITY`:
  "Pair cache hit/miss counters not yet implemented (research D1/D5).
  Cache size from partition stats is the only visibility."

---

## ── Section 3.7: Execution & Business Intelligence ──

### Check 3Z — Gas & Spike Detection

**Goal:** Verify gas prices are sane and no active gas spikes are blocking execution.

**Method:**
```bash
curl -sf http://localhost:3005/stats | jq .
curl -sf http://localhost:3005/health | jq .
curl -sf http://localhost:3005/metrics 2>/dev/null | grep arbitrage_gas_price_gwei
```

**Flag:** Any chain with gas price = 0 → **HIGH**, category: `GAS_SPIKE`
(gas price not being fetched — execution will fail or use stale values).
**Flag:** Any chain with active gas spike detected → **MEDIUM**, category: `GAS_SPIKE`.
**Flag:** Gas price above chain max threshold → **HIGH**, category: `GAS_SPIKE`
(chain thresholds: Ethereum max 500 gwei, Arbitrum max 10 gwei).

---

### Check 3AA — Simulation Provider Health

**Goal:** Verify transaction simulation providers are available.

**Method:**
```bash
curl -sf http://localhost:3005/stats | jq .
```

Parse for simulation provider status fields. Check:
- Which providers are configured and healthy
- Simulation success rate
- Whether simulation is being used (vs skipped)

**Flag:** All simulation providers unhealthy → **HIGH**, category: `SIMULATION`.
**Flag:** Simulation success rate <50% → **MEDIUM**, category: `SIMULATION`.
**Flag:** No simulation providers configured → **MEDIUM**, category: `SIMULATION`.

---

### Check 3AB — Execution Probability & Success Rate

**Goal:** Verify execution success rates are healthy. Low success rates
mean capital is being wasted on gas for failed transactions.

**Method:**
```bash
curl -sf http://localhost:3005/probability-tracker | jq .
```

**Flag:** Overall success rate <30% → **HIGH**, category: `EXECUTION_PROBABILITY`.
**Flag:** Any chain with 0% success rate and >0 attempts → **HIGH**,
category: `EXECUTION_PROBABILITY`.
**Flag:** Endpoint returns empty/error → **MEDIUM**, category: `EXECUTION_PROBABILITY`.

---

### Check 3AC — Bridge Recovery Status

**Goal:** Verify no bridge transactions are stuck (capital locked).

**Method:**
```bash
curl -sf http://localhost:3005/bridge-recovery | jq .
```

**Flag:** Any bridge stuck >24 hours → **HIGH**, category: `BRIDGE_RECOVERY`.
**Flag:** >3 concurrent pending bridges → **MEDIUM**, category: `BRIDGE_RECOVERY`.
**Flag:** Any corrupt bridge entries → **HIGH**, category: `BRIDGE_RECOVERY`.

---

### Check 3AD — Opportunity Outcome Distribution (A2)

**Goal:** Understand WHY executions succeed or fail by analyzing the outcome
distribution. This is the research GAP-1 metric that transforms debugging
from "84% success rate" to "8% revert, 5% timeout, 3% stale on BSC".

**Method:**
```bash
curl -sf http://localhost:3005/metrics 2>/dev/null | grep opportunity_outcome_total
```

Parse `opportunity_outcome_total{chain="...",outcome="..."}`. Expected outcomes:
`success`, `revert`, `timeout`, `stale`, `gas_too_high`, `nonce_error`, `error`.

Calculate outcome percentages per chain and overall:
- success rate = success / total * 100
- revert rate = revert / total * 100
- timeout rate = timeout / total * 100

**Flag:** Revert rate > 30% on any chain → severity: **HIGH**,
category: `BUSINESS_INTELLIGENCE` (contract reverts — check simulation or price accuracy).
**Flag:** Timeout rate > 20% on any chain → severity: **MEDIUM**,
category: `BUSINESS_INTELLIGENCE` (execution too slow for chain block time).
**Flag:** Stale rate > 20% → severity: **MEDIUM**, category: `BUSINESS_INTELLIGENCE`
(opportunities expiring before execution — pipeline too slow or detection too late).
**Flag:** `gas_too_high` rate > 10% → severity: **MEDIUM**, category: `BUSINESS_INTELLIGENCE`
(gas spike causing rejections — check gas spike thresholds).
**Info:** Report full outcome distribution table for the report.

---

### Check 3AE — Profit Slippage (A3)

**Goal:** Measure the gap between expected profit (from detection) and actual
profit (from execution). Large slippage means the detection algorithm is
overestimating opportunities.

**Method:**
```bash
curl -sf http://localhost:3005/metrics 2>/dev/null | grep profit_slippage_pct
```

Parse `profit_slippage_pct` histogram. Positive slippage = expected > actual
(overestimate). Negative = actual > expected (underestimate).

**Flag:** Median slippage > 50% → severity: **HIGH**, category: `BUSINESS_INTELLIGENCE`
(detection consistently overestimates profit — most trades will be less profitable
than expected, or unprofitable).
**Flag:** Median slippage > 25% → severity: **MEDIUM**, category: `BUSINESS_INTELLIGENCE`.
**Info:** Report per-chain/strategy slippage breakdown.

**Note:** In simulation mode, slippage patterns may not reflect production behavior
since simulated execution uses mock prices.

---

### Check 3AF — Opportunity Age at Execution (A4)

**Goal:** Measure how stale opportunities are when they reach the execution engine.
Stale opportunities have already moved in price — executing them wastes gas.

**Method:**
```bash
curl -sf http://localhost:3005/metrics 2>/dev/null | grep opportunity_age_at_execution
```

Parse `opportunity_age_at_execution_ms{chain="..."}` histogram.

**Chain-specific TTL thresholds:**
- Fast chains (Arbitrum, Solana): opportunity TTL ~2s / ~1s
- Medium chains (BSC, Polygon, Base, Optimism): TTL ~5s
- Slow chains (Ethereum): TTL ~12s

**Flag:** p95 age > chain-specific TTL → severity: **HIGH**,
category: `BUSINESS_INTELLIGENCE` (executing stale opportunities — the pipeline
is too slow for this chain's block time).
**Flag:** p95 age > 5000ms on any fast chain → severity: **HIGH**,
category: `BUSINESS_INTELLIGENCE`.
**Flag:** Median age > 2000ms on any chain → severity: **MEDIUM**,
category: `BUSINESS_INTELLIGENCE`.
**Info:** Report per-chain age distribution.

---

### Check 3AG — Profit & Gas Efficiency (F4, F5, placeholder F6)

**Goal:** Evaluate per-execution profitability and gas efficiency.
This answers: "Are we making money, and how much is gas eating?"

**Method:**
```bash
curl -sf http://localhost:3005/metrics 2>/dev/null | grep profit_per_execution
curl -sf http://localhost:3005/metrics 2>/dev/null | grep gas_cost_per_execution
```

Parse `profit_per_execution{chain="...",strategy="..."}` and
`gas_cost_per_execution{chain="..."}` histograms.

**Flag:** Median profit ≤ 0 across all chains → severity: **HIGH**,
category: `BUSINESS_INTELLIGENCE` (system is losing money on average).
**Flag:** Any chain where median gas cost > median profit → severity: **HIGH**,
category: `BUSINESS_INTELLIGENCE` (gas is eating all the profit on this chain).
**Flag:** Metrics not present → severity: **MEDIUM**, category: `BUSINESS_INTELLIGENCE`
(no profitability visibility — Phase 3 metrics may not be wired).
**Info:** Report per-chain profit and gas tables.

**Placeholder (F6):** When `profit_to_gas_ratio` gauge is implemented, add check:
ratio < 1.5 → MEDIUM (thin margins), ratio < 1.0 → HIGH (unprofitable after gas).

---

## ── Section 3.8: Observability ──

### Check 3AH — Prometheus Metrics Validation

Scrape metrics from all services twice, 15 seconds apart:

```bash
# First scrape (partitions + execution + cross-chain)
for port in 3001 3002 3003 3004 3005 3006; do
  curl -sf http://localhost:$port/metrics >> ./monitor-session/metrics_t0.txt
done
# Coordinator (different endpoint)
curl -sf http://localhost:3000/api/metrics/prometheus >> ./monitor-session/metrics_t0.txt

sleep 15

# Second scrape
for port in 3001 3002 3003 3004 3005 3006; do
  curl -sf http://localhost:$port/metrics >> ./monitor-session/metrics_t1.txt
done
curl -sf http://localhost:3000/api/metrics/prometheus >> ./monitor-session/metrics_t1.txt
```

**Flag:** Counters NOT incrementing between scrapes → **MEDIUM** (metrics may be
stale or service is idle — in simulation mode, counters should be incrementing).
**Flag:** Metrics endpoint returns empty/error → **MEDIUM**.

**Note:** Cross-chain detector (port 3006) `/metrics` may return empty during the
first ~30s of startup. Prometheus counters only appear after their first increment.

---

### Check 3AI — Metrics Completeness

**Goal:** Verify that all expected metrics exist in each service's Prometheus
scrape output.

Use the metrics from `./monitor-session/metrics_t1.txt` (second scrape, more
likely to have all metrics).

**Expected metrics per service:**

**Partitions P1-P4** (port 3001-3004 `/metrics`):
```
Required metrics:
  pipeline_latency_p50
  pipeline_latency_p95
  pipeline_latency_p99
  price_updates_total (counter)
  opportunities_detected_total (counter)
  events_processed_total (counter)
Required (v3.0 — runtime monitor):
  runtime_eventloop_delay_p50_ms
  runtime_eventloop_delay_p99_ms
  runtime_memory_heap_used_mb
  runtime_memory_rss_mb
  runtime_gc_pause_total_ms
  runtime_gc_count_total
Required (v3.0 — provider quality):
  provider_rpc_call_duration_ms (per-chain)
  provider_rpc_errors_total (per-chain)
  provider_ws_messages_total (per-chain)
  websocket_connections_active (per-chain)
Optional metrics:
  websocket_reconnections_total
  pairs_monitored (gauge)
  provider_ws_reconnection_duration_ms
  provider_rpc_method_duration_ms
```

**Execution Engine** (port 3005 `/metrics`):
```
Required metrics:
  arbitrage_executions_total (counter)
  arbitrage_execution_success_total (counter)
  arbitrage_gas_price_gwei (gauge, per-chain)
Required (v3.0 — business intelligence):
  opportunity_outcome_total (counter, per-chain/outcome)
  profit_slippage_pct (histogram)
  opportunity_age_at_execution_ms (histogram)
  profit_per_execution (histogram)
  gas_cost_per_execution (histogram)
  stream_message_transit_ms (histogram)
Optional metrics:
  arbitrage_profit_total (counter)
  arbitrage_simulation_success_rate (gauge)
  execution_queue_depth (gauge)
```

**Coordinator** (`/api/metrics/prometheus`):
```
Required metrics:
  arbitrage_opportunities_total (counter)
  arbitrage_executions_total (counter)
  arbitrage_executions_successful_total (counter)
Required (v3.0 — runtime):
  runtime_eventloop_delay_p99_ms
  runtime_memory_heap_used_mb
Optional metrics:
  arbitrage_opportunities_dropped_total (counter)
```

**Cross-Chain Detector** (port 3006 `/metrics`):
```
Required metrics:
  cross_chain_opportunities_total (counter)
Optional metrics:
  cross_chain_detection_latency (histogram)
  partitions_connected (gauge)
```

**Flag:** Required metric missing from service → severity: **MEDIUM**,
category: `METRICS_COMPLETENESS` (observability gap).
**Flag:** More than 50% of required metrics missing → severity: **HIGH**,
category: `METRICS_COMPLETENESS` (service metrics system may be broken).
**Info:** All required metrics present → severity: **INFO**,
category: `METRICS_COMPLETENESS`.

---

### Phase 3 Summary

After all 35 checks across 8 subsections, read `./monitor-session/findings/runtime.jsonl`
and output a summary:
```
PHASE 3 COMPLETE — Runtime Validation (35 checks, 8 subsections)
  3.1 Service Health & Schema: 3A health, 3B leader, 3C schema
  3.2 Risk & Circuit Breakers: 3D CB states, 3E drawdown, 3F CB history*, 3G backpressure*
  3.3 Data Flow & DLQ: 3H DLQ, 3I topology, 3J lag, 3K root cause, 3L transit, 3M ack*, 3N trim*
  3.4 Runtime Performance: 3O event loop, 3P GC, 3Q memory
  3.5 Provider Quality: 3R latency, 3S errors, 3T reconnect, 3U WS rate, 3V staleness
  3.6 Detection Quality: 3W cycle timing, 3X opps/cycle, 3Y cache*
  3.7 Execution & BI: 3Z gas, 3AA sim, 3AB probability, 3AC bridge, 3AD outcomes, 3AE slippage, 3AF age, 3AG profit
  3.8 Observability: 3AH prometheus, 3AI completeness
  (* = placeholder for not-yet-implemented metrics)
  Services healthy: <n>/7
  Leader elected: YES/NO
  Circuit breakers: all CLOSED / <list open chains>
  DLQ entries: <n> | Top reason: <reason> (<n>%)
  Stream topology: <n>/24 streams correct
  Consumer groups: <n> discovered, <n> healthy
  Pending messages: <total across all groups>
  Stream transit p95: <n>ms
  Event loop p99: <n>ms (target: <50ms)
  GC major events: <n>
  Memory: all OK / <services above threshold>
  Provider quality: <n>/<total> chains healthy RPC
  Detection cycle avg: <n>ms (target: <50ms)
  Drawdown state: NORMAL / CAUTION / HALT / RECOVERY
  Execution outcomes: <n>% success, <n>% revert, <n>% timeout
  Profit slippage median: <n>%
  Opp age p95: <n>ms
  Pipeline latency p95: <n>ms
  Gas spikes: <n> chains
  Simulation providers: <n> healthy
  Execution success rate: <n>%
  Bridge recoveries pending: <n>
  Health schemas: <n>/7 valid
  Metrics completeness: <n>/<total> required metrics present
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
  "category": "PIPELINE_FLOW|PIPELINE_STALL|TRACE_INCOMPLETE|DLQ_GROWTH|DETECTION_RATE|RISK_STATE|BACKPRESSURE|PARTITION_FLOW",
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
  stream:fast-lane stream:dead-letter-queue stream:forwarding-dlq; do
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

**Note on P4 Solana `pairsMonitored=0`:** This is expected. Solana uses
`SolanaArbitrageDetector` (program-account-based detection) rather than the
EVM-style pair-initializer. The pair-initializer uses `ethers.solidityPacked`
which requires EVM hex addresses, not Solana base58 addresses. Solana
opportunities come from the separate arbitrage detector, so `pairsMonitored=0`
with active opportunity detection is normal. Do NOT flag this as a finding.

**Flag:** Any non-stub chain with 0 messages during smoke test → **HIGH**,
category: `DETECTION_RATE` (chain is configured but not producing data).
**Exception:** P4 Solana `pairsMonitored=0` is expected (see note above).
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

### Step 4H — Backpressure Validation

**Goal:** Verify the coordinator's backpressure mechanism works correctly.
The coordinator has an `EXECUTION_STREAM_BACKPRESSURE_RATIO` config that
throttles opportunity forwarding when the execution-requests stream approaches
its MAXLEN. If backpressure doesn't activate when it should, the coordinator
will silently drop messages by XADD overwriting the oldest entries.

**Method:**

1. Read the backpressure configuration:
```bash
# Check coordinator health for backpressure state
curl -sf http://localhost:3000/api/health | jq '{backpressure, executionQueueDepth}'
curl -sf http://localhost:3000/api/health/ready | jq .
```

2. Check the execution-requests stream fill ratio:
```bash
EXEC_LEN=$(redis-cli XLEN stream:execution-requests)
echo "execution-requests length: $EXEC_LEN"
# The MAXLEN for execution-requests is declared in the System Inventory (100,000)
# Backpressure ratio threshold is typically 0.8 (80%)
```

3. Evaluate backpressure state consistency:
   - If `EXEC_LEN / MAXLEN > 0.8` AND coordinator health does NOT show
     backpressure active → backpressure mechanism is broken
   - If `EXEC_LEN / MAXLEN < 0.2` AND coordinator health shows backpressure
     active → false positive (backpressure stuck on)
   - In simulation mode with light load, backpressure should NOT be active
     (stream fill ratio should be well below threshold)

4. Grep for the backpressure implementation to verify it exists:
```
Grep for: backpressure|BACKPRESSURE_RATIO in services/coordinator/
Verify: the mechanism reads XLEN and compares against threshold
```

**Flag:** Stream fill ratio > threshold but backpressure not active → severity: **HIGH**,
category: `BACKPRESSURE` (flow control mechanism not working).
**Flag:** Backpressure active but stream fill ratio < 20% → severity: **MEDIUM**,
category: `BACKPRESSURE` (backpressure stuck on — throttling unnecessarily).
**Flag:** No backpressure implementation found in coordinator → severity: **HIGH**,
category: `BACKPRESSURE` (critical flow control mechanism missing).
**Info:** Backpressure state consistent with stream fill ratio → severity: **INFO**,
category: `BACKPRESSURE`.

---

### Step 4I — Per-Partition Flow Verification

**Goal:** Verify that ALL partitions (P1-P4) are actively processing events
during the smoke test. A partition can report "healthy" while producing zero
events — its health endpoint might succeed while WebSocket connections are
silently disconnected.

**Method:**

1. Capture per-partition event counts at the start and end of the smoke test
   (use the /health or /stats endpoints polled during Step 4B):

```bash
# Capture initial state (pair with Step 4A baseline)
P1_START=$(curl -sf http://localhost:3001/health | jq '.eventsProcessed // 0')
P2_START=$(curl -sf http://localhost:3002/health | jq '.eventsProcessed // 0')
P3_START=$(curl -sf http://localhost:3003/health | jq '.eventsProcessed // 0')
P4_START=$(curl -sf http://localhost:3004/health | jq '.eventsProcessed // 0')
echo "Partition baselines: P1=$P1_START P2=$P2_START P3=$P3_START P4=$P4_START"
```

2. After the 60-second smoke test window (Step 4B), capture final counts:

```bash
P1_END=$(curl -sf http://localhost:3001/health | jq '.eventsProcessed // 0')
P2_END=$(curl -sf http://localhost:3002/health | jq '.eventsProcessed // 0')
P3_END=$(curl -sf http://localhost:3003/health | jq '.eventsProcessed // 0')
P4_END=$(curl -sf http://localhost:3004/health | jq '.eventsProcessed // 0')
echo "Partition finals: P1=$P1_END P2=$P2_END P3=$P3_END P4=$P4_END"
```

3. Compute deltas and flag anomalies:
   - Zero delta on any partition while others are active → **HIGH** (silent failure)
   - Delta significantly lower than peers (>10x difference) → **MEDIUM** (degraded)
   - All partitions show positive delta → **INFO** (all healthy)

**Note:** If `/health` doesn't expose `eventsProcessed`, fall back to `/stats`
and look for per-chain message counts or stream publish counts. The exact field
name varies per partition implementation.

**Flag:** Partition with 0 new events while other partitions are active → severity: **HIGH**,
category: `PARTITION_FLOW` (partition silently stopped processing).
**Flag:** Partition event rate >10x lower than peers → severity: **MEDIUM**,
category: `PARTITION_FLOW` (partition degraded but not dead).
**Info:** All partitions actively processing → severity: **INFO**,
category: `PARTITION_FLOW`.

---

### Step 4J — Fast-Lane Stream Validation

**Goal:** Verify the `stream:fast-lane` is functional if fast-lane execution is
configured. The fast-lane consumer (`fast-lane.consumer.ts`) reads from this stream
and executes high-confidence opportunities with reduced validation overhead.

**Method:**

```bash
# Check if fast-lane stream exists and has data
FAST_LEN=$(redis-cli XLEN stream:fast-lane 2>/dev/null || echo "0")
echo "stream:fast-lane length: $FAST_LEN"

# Check if fast-lane consumer group exists
redis-cli XINFO GROUPS stream:fast-lane 2>/dev/null
```

If fast-lane XLEN grew during the smoke test (compare to baseline from 4A):
- Verify execution engine `/stats` shows fast-lane processing
- Check for pending entries in the consumer group

**Flag:** Fast-lane stream exists but consumer group missing → severity: **HIGH**,
category: `PIPELINE_FLOW` (fast-lane messages will accumulate unprocessed).
**Flag:** Fast-lane consumer group exists but PEL growing (not ACKing) → severity: **MEDIUM**,
category: `PIPELINE_FLOW` (fast-lane consumer may be stalled).
**Info:** Fast-lane stream empty → severity: **INFO**,
category: `PIPELINE_FLOW` (no high-confidence opportunities during smoke — expected with simulation).

---

### Step 4K — Business Intelligence Smoke Check

**Goal:** Verify the Phase 3 business intelligence metrics (A2-A4, F4-F5)
are actually recording data during the smoke test. These metrics were added
recently and may not be wired into all code paths.

**Method:**

```bash
# Scrape execution engine metrics for BI counters
curl -sf http://localhost:3005/metrics 2>/dev/null | grep -E "opportunity_outcome_total|profit_slippage_pct|opportunity_age_at_execution|profit_per_execution|gas_cost_per_execution"
```

Compare against the metrics scraped at the beginning of the smoke test.

**Expected:** If execution attempts occurred during the smoke test
(`stream:execution-results` grew), then:
- `opportunity_outcome_total` should have non-zero values
- `opportunity_age_at_execution_ms` should have recorded samples

If no execution attempts occurred, these metrics being zero is expected.

**Flag:** Executions occurred but `opportunity_outcome_total` is 0 → severity: **MEDIUM**,
category: `BUSINESS_INTELLIGENCE` (outcome tracking not wired).
**Flag:** Executions occurred but `opportunity_age_at_execution_ms` is 0 → severity: **MEDIUM**,
category: `BUSINESS_INTELLIGENCE` (age tracking not wired).
**Info:** No executions during smoke → skip BI check (expected in low-activity simulation).

---

### Step 4L — Runtime Performance Delta

**Goal:** Compare runtime performance metrics from Phase 3 (event loop,
GC, memory) against values at the end of the smoke test to detect resource
degradation under load.

**Method:**

```bash
# Scrape event loop delay after smoke test
for port in 3001 3002 3003 3004 3005 3006; do
  echo "=== Port $port ==="
  curl -sf http://localhost:$port/metrics 2>/dev/null | grep runtime_eventloop_delay_p99_ms
  curl -sf http://localhost:$port/metrics 2>/dev/null | grep runtime_memory_rss_mb
done
curl -sf http://localhost:3000/api/metrics/prometheus 2>/dev/null | grep -E "runtime_eventloop_delay_p99_ms|runtime_memory_rss_mb"
```

Compare against Phase 3 values (Check 3O, 3Q).

**Flag:** Event loop p99 increased >5x during smoke → severity: **HIGH**,
category: `RUNTIME_DEGRADATION` (event loop blocking under load).
**Flag:** RSS grew >50% during smoke → severity: **MEDIUM**,
category: `RUNTIME_DEGRADATION` (possible memory leak under load).
**Info:** Runtime metrics stable → severity: **INFO**,
category: `RUNTIME_DEGRADATION`.

---

Output:
```
PHASE 4 COMPLETE — Pipeline Smoke Test (12 steps)
  Price updates published: <n>
  Opportunities detected: <n>
  Execution requests forwarded: <n>
  Execution results received: <n>
  Fast-lane processed: <n>
  Pipeline: FLOWING / STALLED at <stage>
  Trace complete: YES / NO / PARTIAL
  DLQ growth: <n> new entries
  Per-chain detection: <n>/<total> chains active across all partitions
  Risk state post-smoke: NORMAL / CAUTION / HALT / RECOVERY
  Backpressure: INACTIVE / ACTIVE (ratio: <n>%)
  Partition flow: <n>/4 partitions actively processing
  BI metrics recording: YES / NO / N/A (no executions)
  Runtime stability: STABLE / DEGRADED
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

**Before writing the report**, run regression analysis (Step 5E) and persist
the session data (Step 5F).

---

### Step 5E — Finding Regression Tracking

**Goal:** Compare current findings against the previous session's findings to
identify NEW issues (appeared since last run), RESOLVED issues (fixed since
last run), and REGRESSED issues (severity worsened since last run). This turns
the report from a snapshot ("what is") into a delta ("what changed") — much
faster to triage.

**Method:**

1. Check for a previous session's history file:
```bash
LAST_HISTORY=$(ls -t ./monitor-session/history/*.json 2>/dev/null | head -1)
echo "Previous session: ${LAST_HISTORY:-none}"
```

2. If a previous history file exists, load it and compare:
   - Build a finding key for each current finding: `{phase}:{category}:{title_normalized}`
     (normalize title by lowercasing and removing variable values like counts/timestamps)
   - Build the same keys for the previous session's findings
   - **NEW**: Current keys not in previous → these are new issues
   - **RESOLVED**: Previous keys not in current → these were fixed
   - **REGRESSED**: Key exists in both but severity worsened (e.g., MEDIUM → HIGH)
   - **IMPROVED**: Key exists in both but severity lessened (e.g., HIGH → MEDIUM)
   - **UNCHANGED**: Key exists in both with same severity

3. Generate a regression summary:
```
REGRESSION ANALYSIS (vs session <previous_session_id>):
  NEW findings: <n> (issues that appeared since last run)
  RESOLVED findings: <n> (issues that were fixed)
  REGRESSED findings: <n> (issues that got worse)
  IMPROVED findings: <n> (issues that got better)
  UNCHANGED findings: <n>
```

4. If there are REGRESSED findings, list them prominently — these are the
   highest-priority items (something broke since the last validation).

**Note:** If no previous history exists (first run), skip regression analysis
and note "First run — no baseline for comparison" in the report.

---

### Step 5F — Persist Session History

**Goal:** Save current session findings for future regression comparison.

```bash
# Save the finding summary as JSON for regression tracking
# (This is done programmatically — read all findings, build a JSON array of
# {findingId, phase, category, severity, title} objects, write to history file)
```

Write to `./monitor-session/history/<SESSION_ID>.json`:
```json
{
  "sessionId": "<SESSION_ID>",
  "timestamp": "<ISO8601>",
  "gitSha": "<CURRENT_SHA>",
  "decision": "GO|NO-GO",
  "summary": {
    "critical": <n>,
    "high": <n>,
    "medium": <n>,
    "low": <n>,
    "info": <n>,
    "total": <n>
  },
  "findings": [
    {
      "findingId": "SA-001",
      "phase": "STATIC",
      "category": "STREAM_DECLARATION",
      "severity": "HIGH",
      "title": "<normalized title>"
    }
  ]
}
```

Also update the last-run SHA for incremental mode:
```bash
cp ./monitor-session/current.sha ./monitor-session/last-run.sha
echo "Session history saved to ./monitor-session/history/$SESSION_ID.json"
```

---

Write the final report to `./monitor-session/REPORT_<SESSION_ID>.md` using
this template:

---

```markdown
# Pre-Deploy Validation Report

**Session:** <SESSION_ID>
**Date:** <ISO8601>
**Duration:** <total elapsed time>
**Git SHA:** <CURRENT_SHA>
**Mode:** FULL SCAN / INCREMENTAL (<n> files changed)

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

### Regression Analysis (vs previous session)

<If previous session exists:>

| Change | Count | Details |
|--------|-------|---------|
| NEW | <n> | Issues that appeared since last run |
| RESOLVED | <n> | Issues that were fixed |
| REGRESSED | <n> | Issues that got worse |
| IMPROVED | <n> | Issues that got better |
| UNCHANGED | <n> | Same as last run |

**Previous session:** <previous_session_id> (<previous_date>)

<If REGRESSED findings exist:>
**REGRESSIONS (requires attention):**
- <finding_id>: <title> — was <old_severity>, now <new_severity>
- ...

<If no previous session:>
*First run — no baseline for comparison.*

---

## Phase 1: Static Analysis (18 checks)

| Check | Status | Findings |
|-------|--------|----------|
| 1A Stream Declarations | PASS/FAIL | <count> |
| 1B Consumer Groups (Dynamic) | PASS/FAIL | <count> |
| 1C MAXLEN (Config + Call-Site) | PASS/FAIL | <count> |
| 1D XACK After Consume | PASS/FAIL | <count> |
| 1E Env Var Drift (Comprehensive) | PASS/FAIL | <count> |
| 1F Nullish Coalescing | PASS/FAIL | <count> |
| 1G HMAC Signing | PASS/FAIL | <count> |
| 1H Feature Flags | PASS/FAIL | <count> |
| 1I Risk Configuration | PASS/FAIL | <count> |
| 1J Unsafe Numeric Parse | PASS/FAIL | <count> |
| 1K Redis Client Parity | PASS/FAIL | <count> |
| 1L Port Assignment Collision | PASS/FAIL | <count> |
| 1M Silent Error Swallowing | PASS/FAIL | <count> |
| 1N Stream Type Fidelity | PASS/FAIL | <count> |
| 1O Redis Key Registry | PASS/FAIL | <count> |
| 1P ADR Compliance Spot-Check | PASS/FAIL | <count> |
| 1Q Infrastructure Config Alignment | PASS/FAIL | <count> |
| 1R Timeout Hierarchy Audit | PASS/FAIL | <count> |

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

Streams discovered: <n>/24
Missing: <list>

### Readiness Endpoint Consistency
| Service | Port | `/ready` | Service-Specific Path | Status |
|---------|------|----------|-----------------------|--------|
| Coordinator | 3000 | <status code> | `/api/health/ready`: <status code> | CONSISTENT / INCONSISTENT |
| P1 Asia-Fast | 3001 | <status code> | — | OK |
| P2 L2-Turbo | 3002 | <status code> | — | OK |
| P3 High-Value | 3003 | <status code> | — | OK |
| P4 Solana | 3004 | <status code> | — | OK |
| Execution Engine | 3005 | <status code> | — | OK |
| Cross-Chain | 3006 | <status code> | — | OK |

---

## Phase 3: Runtime Validation (35 checks, 8 subsections)

### 3.1 Service Health & Schema
| Check | Status | Findings |
|-------|--------|----------|
| 3A Service Health Matrix | PASS/FAIL | <count> |
| 3B Leader Election | PASS/FAIL | <count> |
| 3C Health Schema Validation | PASS/FAIL | <count> |

### 3.2 Risk & Circuit Breakers
| Check | Status | Findings |
|-------|--------|----------|
| 3D Circuit Breaker States | PASS/FAIL | <count> |
| 3E Drawdown & Risk | PASS/FAIL | <count> |
| 3F CB Transition History* | PASS/FAIL | <count> |
| 3G Backpressure Episodes* | PASS/FAIL | <count> |

### 3.3 Data Flow & DLQ
| Check | Status | Findings |
|-------|--------|----------|
| 3H DLQ Analysis | PASS/FAIL | <count> |
| 3I Stream Topology | PASS/FAIL | <count> |
| 3J Consumer Lag | PASS/FAIL | <count> |
| 3K Root Cause Analysis | PASS/FAIL | <count> |
| 3L Stream Transit Time | PASS/FAIL | <count> |
| 3M ACK Delay* | PASS/FAIL | <count> |
| 3N MAXLEN Trim Detection* | PASS/FAIL | <count> |

### 3.4 Runtime Performance (Enhanced Monitoring)
| Service | Event Loop p99 | GC Major | RSS MB | Status |
|---------|---------------|----------|--------|--------|
| ... | <ms> | <count> | <MB> | OK / WARN |

| Check | Status | Findings |
|-------|--------|----------|
| 3O Event Loop Health | PASS/FAIL | <count> |
| 3P GC Pressure | PASS/FAIL | <count> |
| 3Q Memory Breakdown | PASS/FAIL | <count> |

### 3.5 Provider Quality (Enhanced Monitoring)
| Chain | RPC p95 | Errors | Reconnects | WS msgs | Status |
|-------|---------|--------|------------|---------|--------|
| ... | <ms> | <count> | <count> | <count> | OK / DEGRADED |

| Check | Status | Findings |
|-------|--------|----------|
| 3R Provider Latency | PASS/FAIL | <count> |
| 3S RPC Error Rate | PASS/FAIL | <count> |
| 3T Reconnection Frequency | PASS/FAIL | <count> |
| 3U WebSocket Message Rate | PASS/FAIL | <count> |
| 3V Price Staleness | PASS/FAIL | <count> |

### 3.6 Detection Quality
| Check | Status | Findings |
|-------|--------|----------|
| 3W Detection Cycle Timing | PASS/FAIL | <count> |
| 3X Opportunities Per Cycle | PASS/FAIL | <count> |
| 3Y Cache Effectiveness* | PASS/FAIL | <count> |

### 3.7 Execution & Business Intelligence
| Check | Status | Findings |
|-------|--------|----------|
| 3Z Gas Spike | PASS/FAIL | <count> |
| 3AA Simulation Providers | PASS/FAIL | <count> |
| 3AB Execution Probability | PASS/FAIL | <count> |
| 3AC Bridge Recovery | PASS/FAIL | <count> |
| 3AD Opportunity Outcomes | PASS/FAIL | <count> |
| 3AE Profit Slippage | PASS/FAIL | <count> |
| 3AF Opportunity Age | PASS/FAIL | <count> |
| 3AG Profit & Gas Efficiency | PASS/FAIL | <count> |

### 3.8 Observability
| Service | Expected | Found | Missing | Status |
|---------|----------|-------|---------|--------|
| Partitions P1-P4 | <n> | <n> | <list> | COMPLETE / GAPS |
| Execution Engine | <n> | <n> | <list> | COMPLETE / GAPS |
| Coordinator | <n> | <n> | <list> | COMPLETE / GAPS |
| Cross-Chain | <n> | <n> | <list> | COMPLETE / GAPS |

| Check | Status | Findings |
|-------|--------|----------|
| 3AH Prometheus Scrape | PASS/FAIL | <count> |
| 3AI Metrics Completeness | PASS/FAIL | <count> |

_* = placeholder check for not-yet-implemented metrics_

<detailed findings here if any>

---

## Phase 4: Pipeline Smoke Test

### Stream Flow Cascade
| Stream | Baseline | Final | Growth | Status |
|--------|----------|-------|--------|--------|
| stream:price-updates | <n> | <n> | +<n> | FLOWING/STALLED |
| stream:opportunities | <n> | <n> | +<n> | FLOWING/STALLED |
| stream:execution-requests | <n> | <n> | +<n> | FLOWING/STALLED |
| stream:execution-results | <n> | <n> | +<n> | FLOWING/STALLED |
| stream:fast-lane | <n> | <n> | +<n> | FLOWING/STALLED/EMPTY |

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

### Backpressure Status
- Execution stream fill ratio: <n>% (XLEN / MAXLEN)
- Backpressure state: INACTIVE / ACTIVE
- Consistency: OK / MISMATCH (ratio vs state)

### Partition Flow
| Partition | Events Start | Events End | Delta | Status |
|-----------|-------------|------------|-------|--------|
| P1 Asia-Fast | <n> | <n> | +<n> | ACTIVE / SILENT |
| P2 L2-Turbo | <n> | <n> | +<n> | ACTIVE / SILENT |
| P3 High-Value | <n> | <n> | +<n> | ACTIVE / SILENT |
| P4 Solana | <n> | <n> | +<n> | ACTIVE / SILENT |

### Business Intelligence
| Metric | Value | Status |
|--------|-------|--------|
| opportunity_outcome_total | <n> | RECORDING / NOT_RECORDING / N/A |
| profit_slippage_pct samples | <n> | RECORDING / NOT_RECORDING / N/A |
| opportunity_age_at_execution_ms | <n> | RECORDING / NOT_RECORDING / N/A |

### Runtime Stability Post-Smoke
| Service | EL p99 (Phase 3) | EL p99 (Post-Smoke) | RSS (Phase 3) | RSS (Post-Smoke) | Status |
|---------|-------------------|---------------------|----------------|-------------------|--------|
| ... | <ms> | <ms> | <MB> | <MB> | STABLE / DEGRADED |

---

## All Findings (sorted by severity)

<for each finding, include all JSON fields formatted as a readable block>

---

*Report generated by monitoring.md v3.0*
*Session: <SESSION_ID>*
*Completed: <ISO8601>*
```

---

*End of orchestrator instructions.*
