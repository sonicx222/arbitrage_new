# Enhancement Research: `/monitoring` Workflow Optimization

**Date**: 2026-03-02
**Author**: Claude Opus 4.6 (enhancement-research skill)
**Scope**: Detection, data flow, bugs, inconsistencies, config/docu drift, future optimizations

---

## Executive Summary

The `/monitoring` workflow (v2.2) is a 1,421-line single-orchestrator pre-deploy validation pipeline running 5 sequential phases. After deep analysis of the implementation, supporting infrastructure, ADRs, and cross-service code, I've identified **34 enhancement opportunities** across 6 categories. The current workflow already catches critical issues (e.g., RT-003 batch ACK bug, SM-001 pipeline stall), but has significant gaps in detection coverage, data flow validation, and drift detection.

---

## 1. Detection Enhancements

### Current State
The workflow runs 9 static checks (Phase 1), 7 startup checks (Phase 2), 15 runtime checks (Phase 3), and 7 smoke-test checks (Phase 4). Static analysis uses Glob/Grep/Read on source files. Runtime validation uses `curl` + Redis CLI.

### Gaps Found

#### 1A. No `parseInt`/`parseFloat` NaN Check Detection
**Severity: HIGH | Confidence: HIGH**

55 raw `parseInt(process.env.*)` calls lack NaN validation across production code. Critical examples:
- `HEALTH_CHECK_PORT` in execution-engine and cross-chain-detector — NaN = server won't bind
- `CIRCUIT_BREAKER_FAILURE_THRESHOLD` — NaN = circuit breaker never trips
- `SHUTDOWN_DRAIN_TIMEOUT_MS` — NaN = drain loop exits immediately (no drain)

**Enhancement**: Add static check **1J — Unsafe Numeric Parse Detection**:
```
Grep for: parseInt\(process\.env\. and parseFloat\(process\.env\.
Exclude files using parseEnvInt/parseEnvIntSafe/parsePort
Flag any raw parseInt/parseFloat without adjacent NaN check
```
**Effort**: 15 minutes | **Impact**: Catches silent config failures before they reach production

#### 1B. No Empty Catch Block Detection
**Severity: MEDIUM | Confidence: HIGH**

~100 empty `catch {}` blocks in production code. Most are defensible, but 5 are in critical paths:
- `cross-chain.strategy.ts:186` — `estimateUsdValue()` silently returns `undefined`, could allow trade execution without profit validation
- `solana-execution.strategy.ts:490` — block height expiry check failure swallowed
- `unified-detector/src/index.ts:166` — stream lag health check silently ignored

**Enhancement**: Add static check **1K — Silent Error Swallowing Detection**:
```
Grep for: catch\s*\{?\s*\} and catch\s*\(\w+\)\s*\{\s*\}
Exclude files in __tests__/ and node_modules/
Cross-reference with hot-path files list for severity escalation
```
**Effort**: 20 minutes | **Impact**: Identifies masked failures in critical execution paths

#### 1C. No XADD Without MAXLEN Detection (Call-Site Level)
**Severity: HIGH | Confidence: HIGH**

The current check (SA-003) validates that stream *configurations* have MAXLEN. But it doesn't check actual `xadd()` call sites. Found 1 production XADD missing MAXLEN:
- `shared/core/src/redis/streams.ts:876` — HMAC-rejection DLQ path uses raw `xadd()` instead of `xaddWithLimit()`, allowing unbounded stream growth under sustained attack

**Enhancement**: Strengthen check **1C** to also grep for `this.xadd(` and `client.xadd(` calls that don't use `xaddWithLimit`, cross-referencing against the MAXLEN config.
**Effort**: 10 minutes | **Impact**: Catches the one existing gap and prevents future regressions

#### 1D. No Redis Client Configuration Consistency Check
**Severity: HIGH | Confidence: HIGH**

`RedisClient` gives up reconnecting after 15 retries (~4.5 min), but `RedisStreamsClient` retries forever. This creates a split-brain scenario after transient Redis outages where stream consumers work but leader election/locks fail permanently.

**Enhancement**: Add static check **1L — Redis Client Parity Audit**:
```
Read shared/core/src/redis/client.ts and shared/core/src/redis/streams.ts
Compare: retryStrategy, connectTimeout, maxRetriesPerRequest, lazyConnect
Flag divergences between the two Redis client configurations
```
**Effort**: 15 minutes | **Impact**: Prevents split-brain Redis state after outages

#### 1E. No Type Coercion Detection in Stream Serialization
**Severity: MEDIUM | Confidence: HIGH**

The coordinator's `serializeOpportunityForStream()` converts all numeric fields to strings (`profitPercentage.toString()`). The execution engine then casts `data as unknown as ArbitrageOpportunity` where these fields are typed as `number`. At runtime, `typeof opportunity.profitPercentage === 'number'` returns `false`.

**Enhancement**: Add static check **1M — Stream Type Fidelity Audit**:
```
Read coordinator/src/utils/stream-serialization.ts
Read execution-engine/src/consumers/validation.ts
Flag .toString() conversions of numeric fields in serialization
Flag `as unknown as` type casts in deserialization
```
**Effort**: 20 minutes | **Impact**: Catches silent type coercion bugs in the hot path

---

## 2. Data Flow Enhancements

### Current State
Phase 4 (smoke test) monitors stream cascade: `price-updates → opportunities → execution-requests → execution-results` over 60 seconds. It captures XLEN deltas and traces one message through the pipeline.

### Gaps Found

#### 2A. No Backpressure Validation
**Severity: HIGH | Confidence: MEDIUM**

The coordinator has a backpressure mechanism (`EXECUTION_STREAM_BACKPRESSURE_RATIO`) that throttles opportunity forwarding when the execution stream is full. The smoke test doesn't validate this works correctly.

**Enhancement**: Add smoke-test check **4H — Backpressure Validation**:
```
1. Read EXECUTION_STREAM_BACKPRESSURE_RATIO from coordinator config
2. Check execution-requests stream XLEN vs MAXLEN ratio
3. If ratio > threshold, verify coordinator health shows backpressure active
4. If backpressure NOT active when ratio > threshold, flag as HIGH
```
**Effort**: 30 minutes | **Impact**: Validates a critical flow-control mechanism

#### 2B. No Consumer Group Lag Per-Service Validation
**Severity: MEDIUM | Confidence: HIGH**

Runtime check RT-003 catches aggregate lag, but doesn't validate per-service. The coordinator consumes from 9 streams, the execution engine from 2, and the cross-chain detector from 3. Each has different consumer groups on shared streams.

**Enhancement**: Enhance runtime check **3F** to iterate all known consumer groups per stream:
```
For each stream in RedisStreams:
  XINFO GROUPS <stream>
  For each group:
    Check pending count against threshold
    Check last-delivered-id vs stream last-entry-id
    Cross-reference group name with expected service
```
**Effort**: 20 minutes | **Impact**: Catches per-service lag that aggregate checks miss

#### 2C. No DLQ Content Analysis
**Severity: MEDIUM | Confidence: HIGH**

Runtime check RT-004 reports DLQ length and rejection rate, but doesn't analyze WHY messages are in the DLQ. The 67% rejection rate found in the last run is alarming but the root cause isn't diagnosed.

**Enhancement**: Add runtime check **3P — DLQ Root Cause Analysis**:
```
XREVRANGE stream:dead-letter-queue + - COUNT 50
Group by: rejection reason, source stream, error type
Report top-3 rejection reasons with counts
Flag if any single reason accounts for >50% of DLQ entries
```
**Effort**: 25 minutes | **Impact**: Turns a symptom (DLQ growth) into an actionable root cause

#### 2D. No Cross-Service Message Delivery Verification
**Severity: MEDIUM | Confidence: MEDIUM**

The smoke test traces one message via `_trace_traceId`, but doesn't verify that ALL services in the pipeline are receiving and processing messages. If one partition silently stops publishing, the aggregate flow might look normal while one chain goes dark.

**Enhancement**: Add smoke-test check **4I — Per-Partition Flow Verification**:
```
For each partition (P1-P4):
  GET /health → extract eventsProcessed, chains
  Compare eventsProcessed delta over 60s
  Flag if any partition has 0 new events while others are active
  Flag if any chain in partition has 0 detections
```
**Effort**: 20 minutes | **Impact**: Catches silent partition failures masked by aggregate metrics

---

## 3. Bug Detection Enhancements

### Current State
Phase 3 catches runtime bugs via health endpoints and Redis state inspection. The RT-003 finding (batch ACK bug) was a major catch that led to ADR-037 remediation.

### Gaps Found

#### 3A. No Readiness Endpoint Consistency Check
**Severity: HIGH | Confidence: HIGH**

The coordinator exposes `/api/health/ready` (nested under `/api/health/`), while all other services expose `/ready` at root. The monitoring command (Phase 2) uses `/api/health/ready` for the coordinator and `/ready` for others, which is correct. But infrastructure tools (Fly.io, Docker, Kubernetes) using a uniform `/ready` path will get 404 from the coordinator.

**Enhancement**: Add startup check **2E — Readiness Endpoint Consistency**:
```
For each service:
  curl /ready (standard path)
  curl /api/health/ready (coordinator path)
  Flag if standard /ready returns 404 on any service
  Cross-reference with infrastructure health check configs (Fly.io toml, Docker compose)
```
**Effort**: 15 minutes | **Impact**: Catches deployment-breaking endpoint mismatches

#### 3B. No Shutdown Behavior Validation
**Severity: MEDIUM | Confidence: MEDIUM**

The cross-chain detector closes its health server BEFORE stopping the detector. During the 5+ second detector shutdown, load balancers see connection refused and may reroute traffic prematurely. The execution engine has the same pattern.

**Enhancement**: Add a **Phase 2.5 — Shutdown Validation** (optional, after startup):
```
Send SIGTERM to one test service
Monitor health endpoint availability during shutdown
Verify: health endpoint stays up until service fully stops
Measure: time between SIGTERM and last successful health response
```
**Effort**: 45 minutes | **Impact**: Validates graceful shutdown works under load balancer expectations
**Note**: This is a heavyweight check. Make it optional/skippable.

#### 3C. No Cross-Chain Detector Readiness Timeout Awareness
**Severity: MEDIUM | Confidence: HIGH**

The last monitoring run flagged ST-007 (cross-chain detector `/ready` non-200 after 60s). The code comments state readiness takes 60-90s in simulation mode because the detector needs to receive price updates from partitions first.

**Enhancement**: Extend Phase 2 timeout for cross-chain detector specifically:
```
Cross-chain detector readiness poll: up to 120s (not 60s)
Add finding note: "Cross-chain detector requires partition data before ready (60-90s expected)"
Escalate to HIGH only if still not ready after 120s
```
**Effort**: 5 minutes | **Impact**: Eliminates false-positive HIGH finding that wastes triage time

---

## 4. Inconsistency Detection Enhancements

### Current State
Phase 1 checks for stream name consistency, consumer group presence, and MAXLEN enforcement. No checks for cross-service configuration consistency.

### Gaps Found

#### 4A. No Redis Key Registry Audit
**Severity: MEDIUM | Confidence: HIGH**

Redis stream names have a centralized `RedisStreams` constant, but regular Redis keys are ad-hoc across services. Key patterns like `lock:`, `bridge:recovery:`, `region:health:`, `ratelimit:`, `price:` are scattered. Collision risk exists between `lock:` (distributed lock prefix) and `lock:execution:` (hardcoded in execution engine).

**Enhancement**: Add static check **1N — Redis Key Pattern Audit**:
```
Grep for: \.set\(|\.get\(|\.hset\(|\.hget\(|\.del\(|\.expire\(
Extract key patterns (first argument)
Compare against documented key prefixes
Flag: undocumented key patterns, potential prefix collisions
```
**Effort**: 30 minutes | **Impact**: Prevents silent key collisions across services

#### 4B. No Port Assignment Collision Check
**Severity: LOW | Confidence: HIGH**

`service-ports.json` is the central port registry, but `unified-detector/src/constants.ts` hardcodes `DEFAULT_HEALTH_CHECK_PORT = 3001` (should be 3007 per the registry). The monolith assigns coordinator to port 3009 which isn't in the registry.

**Enhancement**: Add static check **1O — Port Assignment Consistency**:
```
Read shared/constants/service-ports.json
Grep for DEFAULT_HEALTH_CHECK_PORT across all services
Grep for hardcoded port numbers (3000-3100) in service index.ts files
Flag: any port not matching service-ports.json
```
**Effort**: 15 minutes | **Impact**: Catches port collision bugs before they cause binding failures

#### 4C. No Timeout Consistency Check
**Severity: MEDIUM | Confidence: MEDIUM**

Shutdown timeout hierarchy is misaligned:
- Coordinator: 10s default (but initializes multiple Redis clients, HTTP server, leader election)
- Execution engine: 45s (30s drain + 15s buffer)
- Partition services: 5s per step

The coordinator's 10s may be insufficient for complex cleanup under slow Redis conditions.

**Enhancement**: Add static check **1P — Timeout Hierarchy Audit**:
```
Grep for: shutdownTimeoutMs|SHUTDOWN.*TIMEOUT|connectTimeout|drainTimeout
Map service → timeout values
Flag: services with complex cleanup but low timeout
Flag: timeout values that don't account for downstream dependencies
```
**Effort**: 20 minutes | **Impact**: Prevents incomplete shutdown cascades

---

## 5. Config/Documentation Drift Enhancements

### Current State
Phase 1 check SA-005 catches `|| 0` anti-patterns and SA-007 validates feature flag documentation. No systematic drift detection between code, docs, and configs.

### Gaps Found

#### 5A. No Environment Variable Documentation Drift Check
**Severity: HIGH | Confidence: HIGH**

**99 environment variables** are used in production code but NOT documented in `.env.example`. Critical undocumented vars include:
- `WALLET_PRIVATE_KEY` — valid alternative to `WALLET_MNEMONIC`
- `SHUTDOWN_DRAIN_TIMEOUT_MS` — controls execution engine drain
- `MAX_CONCURRENT_EXECUTIONS` — caps parallel executions
- 10 mempool vars, 7 BloXroute vars, 10 multi-leg per-chain timeout vars, 4 A/B testing vars

**Enhancement**: Replace the current rudimentary env var check (1E) with **1E-v2 — Comprehensive Env Var Drift Detection**:
```
1. Grep for process\.env\.\w+ across all .ts files (excluding tests, node_modules)
2. Extract unique env var names
3. Read .env.example, extract documented env var names
4. Diff: code_vars - documented_vars = undocumented
5. Diff: documented_vars - code_vars = orphaned documentation
6. Categorize undocumented vars by service and risk level
7. Flag CRITICAL for any secret-like vars (KEY, SECRET, TOKEN, PASSWORD)
```
**Effort**: 30 minutes | **Impact**: Catches the 99 undocumented vars and prevents future drift

#### 5B. No ADR Compliance Drift Check
**Severity: MEDIUM | Confidence: MEDIUM**

37 ADRs exist with specific architectural decisions, but no automated check verifies code still complies. For example:
- ADR-022 (hot-path memory) mandates no spread operators in loops — is this still true?
- ADR-033 (stale price window) mandates 30s hard rejection — is the threshold still 30s?
- ADR-002 (Redis Streams) mandates all inter-service communication via streams — any direct HTTP calls between services?

**Enhancement**: Add static check **1Q — ADR Compliance Spot-Check**:
```
ADR-022: Grep for spread operator (...) in hot-path files
ADR-033: Read price-matrix.ts, verify STALE_PRICE_THRESHOLD_MS = 30000
ADR-002: Grep for http://localhost:300 in service files (direct service calls)
ADR-018: Verify circuit breaker default threshold = 5
Report: per-ADR compliance status
```
**Effort**: 45 minutes | **Impact**: Catches architectural drift before it compounds

#### 5C. No Infrastructure Config Drift Check
**Severity: MEDIUM | Confidence: HIGH**

Fly.io configs, Docker Compose files, and Terraform configs reference ports, env vars, and service names. These can drift from the source code.

**Enhancement**: Add static check **1R — Infrastructure Config Alignment**:
```
Read infrastructure/fly/*.toml → extract ports, health check paths
Read infrastructure/docker/docker-compose*.yml → extract port mappings, env vars
Compare against: service-ports.json, health endpoint paths, .env.example
Flag: mismatched ports, wrong health check paths, missing env vars
```
**Effort**: 30 minutes | **Impact**: Catches deployment config drift that causes production failures

#### 5D. No Consumer Group Documentation Drift
**Severity: LOW | Confidence: HIGH**

The monitoring command checks for 6 expected consumer groups, but `failover-coordinator` was flagged as absent from code (SA-002), then corrected at runtime (RT-009 showed it's created dynamically). The expected groups list in the monitoring command may drift as services evolve.

**Enhancement**: Make the expected consumer group list dynamic:
```
1. Grep for createConsumerGroup|xgroupCreate across all .ts files
2. Extract consumer group names from code
3. Compare against the monitoring command's hardcoded list
4. Update the command's reference list programmatically
```
**Effort**: 15 minutes | **Impact**: Eliminates false-positive findings like SA-002

---

## 6. Future Optimization Opportunities

### 6A. Parallel Phase Execution
**Confidence: MEDIUM | Effort: 2-3 hours**

Phases 1 (static) and 2 (startup) are currently sequential, but Phase 1 doesn't need services running. They could run in parallel: start Redis + services while performing static analysis.

**Expected Impact**: Reduce total validation time from ~5.5 min to ~4 min (Phase 1's 60s overlaps with Phase 2's 60s).

**Risk**: Findings from Phase 1 might inform Phase 2 approach. Mitigate by running Phase 1 first with a 30s head start.

### 6B. Incremental Static Analysis
**Confidence: MEDIUM | Effort: 3-4 hours**

Currently, all 9 static checks run on the full codebase every time. For repeat runs, only files changed since the last session should be analyzed.

**Enhancement**:
```
1. Store git SHA in monitor-session/last-run.sha
2. On next run: git diff --name-only <last-sha>..HEAD
3. Run static checks only on changed files (with full-scan fallback for structural checks)
```
**Expected Impact**: Reduce Phase 1 from 60s to ~15s for typical change sets.

### 6C. Automated Finding Regression Tracking
**Confidence: HIGH | Effort: 2 hours**

Currently, findings are written fresh each session with no comparison to previous sessions. Known-good findings (INFO/PASS) are re-verified every run without tracking improvements or regressions.

**Enhancement**:
```
1. After Phase 5, store findings summary in monitor-session/history/<SESSION_ID>.json
2. On next run, compare current findings against last session
3. Report: NEW findings (didn't exist before), RESOLVED findings (fixed), REGRESSED findings (was INFO, now HIGH)
4. Highlight regressions prominently in the GO/NO-GO report
```
**Expected Impact**: Faster triage — operators immediately see what changed, not just what is.

### 6D. Stream Monitor Integration
**Confidence: HIGH | Effort: 1 hour**

`stream-monitor.js` (452 lines) runs as a separate process writing to `findings/stream-analyst.jsonl`, but Phase 5 only aggregates the 4 main JSONL files. Stream monitor findings are lost from the final report.

**Enhancement**: In Phase 3 or Phase 4, start `stream-monitor.js` as a background process. In Phase 5, include `stream-analyst.jsonl` findings in the aggregation and GO/NO-GO calculation.

### 6E. Health Endpoint Response Schema Validation
**Confidence: MEDIUM | Effort: 2 hours**

Currently, runtime checks hit `/health` and check for `status: 'healthy'`. They don't validate the full response schema. If a service changes its health response format (drops a field, changes a type), the monitoring command won't catch it.

**Enhancement**: Define expected health response schemas per service and validate fields, types, and required properties during Phase 3.

### 6F. Prometheus Metrics Completeness Check
**Confidence: MEDIUM | Effort: 1.5 hours**

Phase 3 check 3G scrapes Prometheus twice 15s apart to verify counters increment. It doesn't check that all expected metrics exist or that metric names match documentation.

**Enhancement**: Maintain a list of expected metrics per service. Validate each metric exists in the Prometheus scrape response. Flag missing metrics as MEDIUM findings.

---

## Implementation Priority Matrix

| # | Enhancement | Severity | Effort | Phase | Category |
|---|-----------|----------|--------|-------|----------|
| **5A** | Env var documentation drift | HIGH | 30 min | 1 | Config drift |
| **1A** | Unsafe numeric parse detection | HIGH | 15 min | 1 | Detection |
| **1C** | XADD without MAXLEN (call-site) | HIGH | 10 min | 1 | Detection |
| **1D** | Redis client parity audit | HIGH | 15 min | 1 | Detection |
| **3A** | Readiness endpoint consistency | HIGH | 15 min | 2 | Bug |
| **2A** | Backpressure validation | HIGH | 30 min | 4 | Data flow |
| **3C** | Cross-chain detector timeout | MEDIUM | 5 min | 2 | Bug |
| **2B** | Per-service consumer lag | MEDIUM | 20 min | 3 | Data flow |
| **2C** | DLQ root cause analysis | MEDIUM | 25 min | 3 | Data flow |
| **1B** | Empty catch block detection | MEDIUM | 20 min | 1 | Detection |
| **1E** | Stream type fidelity audit | MEDIUM | 20 min | 1 | Detection |
| **4A** | Redis key registry audit | MEDIUM | 30 min | 1 | Inconsistency |
| **5B** | ADR compliance spot-check | MEDIUM | 45 min | 1 | Config drift |
| **5C** | Infrastructure config alignment | MEDIUM | 30 min | 1 | Config drift |
| **4C** | Timeout hierarchy audit | MEDIUM | 20 min | 1 | Inconsistency |
| **2D** | Per-partition flow verification | MEDIUM | 20 min | 4 | Data flow |
| **6D** | Stream monitor integration | MEDIUM | 1 hr | 3-4 | Optimization |
| **6C** | Finding regression tracking | MEDIUM | 2 hr | 5 | Optimization |
| **6A** | Parallel phase execution | LOW | 2-3 hr | 1-2 | Optimization |
| **5D** | Dynamic consumer group list | LOW | 15 min | 1 | Config drift |
| **4B** | Port assignment collision | LOW | 15 min | 1 | Inconsistency |
| **3B** | Shutdown behavior validation | LOW | 45 min | 2.5 | Bug |
| **6B** | Incremental static analysis | LOW | 3-4 hr | 1 | Optimization |
| **6E** | Health schema validation | LOW | 2 hr | 3 | Optimization |
| **6F** | Prometheus completeness | LOW | 1.5 hr | 3 | Optimization |

---

## Recommended Implementation Batches

### Batch 1: Quick Wins (< 2 hours total)
Enhancements **1A, 1C, 1D, 3A, 3C, 5D, 4B** — All under 15 min each, high detection value. These are new static checks and minor timeout adjustments that slot directly into existing Phase 1/2 structure.

### Batch 2: Detection Depth (< 2.5 hours)
Enhancements **5A, 2B, 2C, 1B, 1E, 4A** — Medium-effort checks that significantly deepen coverage. The env var drift check alone catches 99 undocumented variables.

### Batch 3: Structural Improvements (< 4 hours)
Enhancements **2A, 5B, 5C, 4C, 2D, 6D** — Cross-cutting checks requiring multi-file analysis. ADR compliance and infrastructure drift checks add a new dimension of validation.

### Batch 4: Optimization (future)
Enhancements **6A, 6B, 6C, 6E, 6F** — Workflow efficiency improvements. Regression tracking (6C) has the highest ROI.

---

## Actual Bugs Found During This Research

These aren't just monitoring enhancements — the research uncovered real issues:

| # | Bug | File | Severity |
|---|-----|------|----------|
| 1 | HMAC-rejection DLQ XADD missing MAXLEN (unbounded growth) | `shared/core/src/redis/streams.ts:876` | HIGH |
| 2 | Coordinator missing standard `/ready` endpoint | `services/coordinator/src/api/routes/` | HIGH |
| 3 | RedisClient gives up after 15 retries vs streams client infinite retry | `shared/core/src/redis/client.ts:221` | HIGH |
| 4 | RedisClient has no `connectTimeout` (can hang indefinitely) | `shared/core/src/redis/client.ts:211` | HIGH |
| 5 | Numeric fields become strings after coordinator serialization | `services/coordinator/src/utils/stream-serialization.ts` | MEDIUM |
| 6 | unified-detector DEFAULT_HEALTH_CHECK_PORT=3001 (should be 3007) | `services/unified-detector/src/constants.ts:69` | MEDIUM |
| 7 | Health server closed before service drain completes | Multiple `index.ts` files | LOW |

These should be addressed via `/fix-issues` independently of the monitoring enhancements.

---

## Success Metrics

If all enhancements are implemented:

- **Detection coverage**: 9 static checks → 18 static checks (+100%)
- **Data flow checks**: 7 smoke-test checks → 11 checks (+57%)
- **Env var documentation**: 99 undocumented vars → 0 (tracked and enforced)
- **False-positive rate**: Eliminate ST-007 false positive via service-specific timeouts
- **Regression visibility**: New → full diff-based finding regression tracking
- **Config drift surface**: 0 infrastructure checks → 3 (Fly.io, Docker, ADR compliance)
