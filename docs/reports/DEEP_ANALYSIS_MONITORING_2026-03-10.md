# Deep Analysis: monitoring.md Pre-Deploy Validation Pipeline

**Date:** 2026-03-10
**Target:** `.claude/commands/monitoring.md` (v3.1, 4128 lines)
**Team:** 6 agents (architecture-auditor, bug-hunter, security-auditor, test-quality-analyst, mock-fidelity-validator, performance-refactor-reviewer) + Team Lead
**Grade:** B

---

## Executive Summary

- **Total findings:** 47 (0 Critical, 11 High, 18 Medium, 18 Low)
  - Category 1 (bugs in existing checks): 11H, 13M, 14L = 38 findings
  - Category 2 (missing coverage gaps): 0H, 5M, 4L = 9 new check suggestions
- **Top 3 highest-impact issues:**
  1. H-01: `stream:opportunities` MAXLEN documented as 500K but code has 200K — every monitoring run validates against wrong threshold (4 agents agreed)
  2. H-02: P2 L2-Turbo chains wrong throughout — smoke test validates wrong chains, misses Mantle/Mode (4 agents agreed)
  3. H-05: Phantom metric `opportunities_detected_total` and missing `_ms` suffix on 3 pipeline latency metrics — Check 3AI will always produce false findings (Bug Hunter)
- **Overall assessment:** The monitoring pipeline is comprehensive and well-structured (18 static checks, 44 runtime checks, 12-step smoke test across 3 data modes). However, documentation drift from recent code changes has introduced stale references in ~15 locations, and 3 runtime checks have incorrect metric/file targets that render them non-functional. Additionally, 5 security-relevant gaps and 4 smoke test blind spots were identified.

### Agent Agreement Map

| Area | Agents That Flagged It |
|------|----------------------|
| MAXLEN 500K→200K | Team Lead, Architecture, Mock Fidelity, Bug Hunter (4) |
| P2 chain assignments | Team Lead, Architecture, Bug Hunter, Test Quality (4) |
| SSE event count 6→7 | Team Lead, Architecture, Performance, Test Quality (4) |
| Report template 43→44 + missing 3AR | Team Lead, Architecture, Performance (3) |
| ADR-033 wrong file | Team Lead, Bug Hunter (2) |
| UD port stale known issue | Team Lead, Mock Fidelity (2) |
| `bc` not on Windows | Bug Hunter, Performance (2) |
| Timeout values stale | Mock Fidelity (unique, 4 values verified) |
| Phantom/wrong metric names | Bug Hunter (unique, verified via grep) |
| Runtime loops skip CC 3006 | Bug Hunter (unique, verified) |
| Security coverage gaps | Security (unique, 9 items) |
| Smoke test blind spots | Test Quality (unique, 4 items) |

---

## High Findings (P1) — 11 items

| # | Category | Location | Description | Agent(s) | Confidence | Score |
|---|----------|----------|-------------|----------|------------|-------|
| H-01 | CONFIG_DRIFT | :88, :21 | `stream:opportunities` MAXLEN says 500K, code has 200K | TL+Arch+MF+BH | HIGH 95% | 4.6 |
| H-02 | CONFIG_DRIFT | :76, :3378, :4072-4082 | P2 chains wrong: lists zkSync/Linea (P3) instead of Mantle/Mode | TL+Arch+BH+TQ | HIGH 95% | 4.6 |
| H-03 | CHECK_ACCURACY | :867-876 | ADR-033 check searches wrong file (price-matrix.ts) for non-existent constant | TL+BH | HIGH 95% | 4.3 |
| H-04 | CHECK_ACCURACY | :2492-2497 | Metric names miss `_ms` suffix; Check 3AI validates phantom name | BH | HIGH 90% | 4.0 |
| H-05 | CHECK_ACCURACY | :2497 | `opportunities_detected_total` metric does not exist anywhere in codebase | BH | HIGH 95% | 4.0 |
| H-06 | CHECK_ACCURACY | :1891, :1928 | Runtime metric loops (3O, 3P) skip Cross-Chain Detector port 3006 | BH | HIGH 90% | 3.7 |
| H-07 | COVERAGE_GAP | Smoke test | ADR-038 chain-grouped streams not in smoke baseline — false CRITICAL if routing enabled | TQ | HIGH 85% | 3.7 |
| H-08 | COVERAGE_GAP | Smoke test | Cross-chain detection not smoke-tested — dead detector invisible | TQ | HIGH 85% | 3.4 |
| H-09 | STALE_CONTENT | :996-1000 | Timeout values wrong: coordinator 10→15s, Redis connectTimeout 10000→3000, partition 5→25s | MF | HIGH 90% | 3.4 |
| H-10 | SECURITY_GAP | Check 1G | HMAC legacy compat bypass (`STREAM_LEGACY_HMAC_COMPAT`) not monitored | SEC | MEDIUM 75% | 3.1 |
| H-11 | COVERAGE_GAP | Phase 3 | CB flapping invisible — placeholder 3F only checks point-in-time state | TQ | MEDIUM 80% | 3.1 |

### H-01: Opportunities MAXLEN Drift (500K vs 200K)

**Evidence:**
- monitoring.md line 88: `| stream:opportunities | 500,000 |`
- monitoring.md line 21 (changelog): `Fixed MAXLEN drift: opportunities=500K`
- `shared/core/src/redis/streams.ts:444`: `200000, // RT-007→ST-002 FIX: Reduced from 500K to 200K — 500K consumed 348MB (68% of 512MB Redis)`

**Impact:** System Inventory, Check 1C validation, and Check 3N MAXLEN ratio all reference 500K. Since code has 200K, a stream at 180K (90% of 200K = actively trimming) would appear as only 36% of 500K (healthy). Operators could also "fix" code to 500K, re-introducing the memory issue.

**Fix:** Change line 88 from `500,000` to `200,000`. Update changelog line 21.

### H-02: P2 L2-Turbo Chain Assignments Wrong Throughout

**Evidence:**
- monitoring.md line 76 (inventory): "Arbitrum, Optimism, Base, Blast, Scroll" (missing Mantle, Mode)
- monitoring.md line 3378 (smoke): "Arbitrum, Optimism, Base, zkSync, Linea, Blast, Scroll" (zkSync/Linea are P3)
- monitoring.md lines 4072-4082 (template): zkSync and Linea under P2, Mantle/Mode absent
- `shared/config/src/partitions.ts:253`: `['arbitrum', 'optimism', 'base', 'scroll', 'blast', 'mantle', 'mode']`
- Line 3379: "Mantle and Mode are stubs" — wrong; RPC-validated 2026-03-08

**Impact:** Smoke test Step 4F expects wrong chains from P2, creating false positives (zkSync/Linea "missing" from P2) and false negatives (Mantle/Mode not validated).

**Fix:** Update all 3 locations (lines 76, 3378, 4072-4082) to reflect actual P2 chains.

### H-03: ADR-033 Spot-Check — Wrong File and Wrong Constant

**Evidence:**
- Check 1P (lines 867-876): "Read shared/core/src/price-matrix.ts, Search for: STALE_PRICE_THRESHOLD or 30000"
- price-matrix.ts has `getPriceWithFreshnessCheck(key, maxAgeMs = 5000)` — 5s, not 30s
- ADR-033 actual implementation: `maxPriceAgeMs ?? 30000` in cross-chain detector
- `STALE_PRICE_THRESHOLD` does not exist anywhere in the codebase
- `gas-price-cache.ts:377` has `STALE_WARN_INTERVAL_MS = 30_000` — wrong constant (log throttle, not price rejection)

**Fix:** Rewrite to search `services/cross-chain-detector/src/` for `maxPriceAgeMs` with default 30000.

### H-04: Pipeline Latency Metric Names Missing `_ms` Suffix

**Evidence (Bug Hunter):**
- monitoring.md lines 2492-2495: Lists `pipeline_latency_p50`, `pipeline_latency_p95`, `pipeline_latency_p99`
- `shared/core/src/partition/health-server.ts:372-380`: Actual names are `pipeline_latency_p50_ms`, `pipeline_latency_p95_ms`, `pipeline_latency_p99_ms`

**Impact:** Check 3AI metrics completeness validation may work as substring match but operators using the list to query Prometheus directly will get no results.

**Fix:** Add `_ms` suffix to all 3 metric names at lines 2492-2495.

### H-05: Phantom Metric `opportunities_detected_total`

**Evidence (Bug Hunter):**
- monitoring.md line 2497: Listed as "Required metric" for P1-P4
- Zero grep results for `opportunities_detected_total` across entire codebase
- Partition health-server emits `events_processed_total` and `price_updates_total`, not this metric

**Impact:** Every monitoring run flags all 4 partitions as missing this metric — a permanent false positive.

**Fix:** Remove from required list or replace with actual metric name (`events_processed_total`).

### H-06: Runtime Loops Skip Port 3006

**Evidence (Bug Hunter):**
- Check 3O (line 1891) and 3P (line 1928): Loop `for port in 3001 3002 3003 3004 3005`
- Missing: port 3006 (Cross-Chain Detector)
- System Inventory (line 80) lists Cross-Chain at 3006

**Fix:** Add `3006` to both loops.

### H-07: ADR-038 Streams Not in Smoke Test

**Evidence (Test Quality):**
- Smoke test Step 4A tracks 7 streams: price-updates, opportunities, execution-requests, execution-results, fast-lane, dead-letter-queue, forwarding-dlq
- The 5 ADR-038 streams (`exec-requests-fast/l2/premium/solana`, `pre-simulated`) are NOT tracked
- When `COORDINATOR_CHAIN_GROUP_ROUTING=true`, opportunities flow through `exec-requests-*` instead of `execution-requests` — smoke test reports STALLED even though pipeline works

**Fix:** Add ADR-038 streams to smoke test baseline/growth checks with a conditional note for chain-group routing.

### H-08: Cross-Chain Detection Not Smoke-Tested

**Evidence (Test Quality):**
- Smoke test validates main pipeline (price-updates → opportunities → execution) but does NOT verify cross-chain detector consumes `stream:price-updates` via `cross-chain-detector-group`
- No step checks whether cross-chain opportunities appear in `stream:opportunities`

**Fix:** Add smoke test step verifying cross-chain detector's consumer group has read messages.

### H-09: Stale Timeout Values in Check 1R

**Evidence (Mock Fidelity):**
- Line 996: "Coordinator: SHUTDOWN_TIMEOUT=10000" → Actual: 15000 (`coordinator/src/index.ts:194`)
- Line 999: "Redis client: connectTimeout=10000, commandTimeout=5000" → Actual: connectTimeout=3000 (both clients), commandTimeout does not exist
- Line 998: "Partition services: 5000ms per shutdown step" → Actual: 25000ms (`health-server.ts:561`)
- Line 1000: "closeServerWithTimeout: 5000ms default" → Actual: 1000ms (`health-server.ts:564`)

**Fix:** Update all 4 timeout values to match actual code.

### H-10: HMAC Legacy Compat Bypass Not Monitored

**Evidence (Security):**
- Check 1G verifies `STREAM_SIGNING_KEY` exists but does NOT check `STREAM_LEGACY_HMAC_COMPAT`
- When enabled, HMAC verification skips stream name in hash — weakens cross-stream replay protection
- Code default is `false` (safe), but no monitoring validates this

**Fix:** Add to Check 1G: grep for `STREAM_LEGACY_HMAC_COMPAT=true` in .env files → MEDIUM finding.

### H-11: Circuit Breaker Flapping Invisible

**Evidence (Test Quality):**
- Placeholder Check 3F only provides point-in-time CB state
- A CB rapidly cycling CLOSED→OPEN→HALF_OPEN→CLOSED appears CLOSED at any snapshot
- Each HALF_OPEN window wastes gas on doomed trades

**Fix:** When Check 3F is implemented, track CB transition count over the monitoring window, not just current state.

---

## Medium Findings (P2) — 18 items

| # | Category | Location | Description | Agent(s) | Confidence |
|---|----------|----------|-------------|----------|------------|
| M-01 | STALE_CONTENT | :644-646 | Redis client parity "known issue" is stale | TL+MF | HIGH 95% |
| M-02 | STALE_CONTENT | :685-688 | UD port 3001 "known issue" is stale (now 3007) | TL+MF | HIGH 95% |
| M-03 | INCONSISTENCY | :3172, :4036 | Dashboard summary "Events /6 types" → should be /7 | TL+Arch+Perf+TQ | HIGH 95% |
| M-04 | MISSING_CHECK | :4024-4036 | Check 3AR missing from report template table | TL+Arch+Perf | HIGH 90% |
| M-05 | INCONSISTENCY | :1304 | Phase 3 header: "8 subsections, 35 checks" → "9, 44" | TL+Perf | HIGH 95% |
| M-06 | INCONSISTENCY | :3936 | Report template: "43 checks" → 44 | TL+Arch+Perf | HIGH 95% |
| M-07 | COMPATIBILITY | :1866 | `bc` command not available on Windows — ratio always "N/A" | BH+Perf | HIGH 95% |
| M-08 | COMPATIBILITY | :2619, :3020 | `timeout` is Windows timeout.exe, not GNU timeout — hangs | Perf | HIGH 90% |
| M-09 | COMPATIBILITY | Pre-flight | No pre-flight check for `jq` — ~60+ locations silently fail | Perf | HIGH 90% |
| M-10 | COMPATIBILITY | Pre-flight | No pre-flight check for `redis-cli` — Phase 3 silently fails | Perf | HIGH 85% |
| M-11 | CHECK_ACCURACY | :334 | Check 1A grep misses camelCase `xAdd` pattern | BH | MEDIUM 70% |
| M-12 | STALE_CONTENT | :1438 | EE health schema lists `consecutiveLosses` — field doesn't exist | Arch | MEDIUM 75% |
| M-13 | CHECK_ACCURACY | :3410 | Step 4G says "same as Check 3I" but should be "Check 3E" | TQ | HIGH 90% |
| M-14 | CONFIG_DRIFT | :82 | MAXLEN source attribution says events.ts but values are in streams.ts | Arch | MEDIUM 75% |
| M-15 | COVERAGE_GAP | Check 3J | Uniform lag thresholds (50/100) — no per-stream differentiation | TQ | MEDIUM 70% |
| M-16 | COVERAGE_GAP | New | No lint verification — ESLint-delegated checks have no fallback | TQ | MEDIUM 75% |
| M-17 | SECURITY_GAP | New | Private key: monitoring says "in .env" (line 1117) — should be .env.local only | SEC | HIGH 85% |
| M-18 | ERROR_HANDLING | All phases | curl calls have no `--max-time` — hung service stalls entire pipeline | Perf | MEDIUM 80% |

### Notable Details

**M-07 (`bc` not on Windows):** The MAXLEN fill ratio calculation uses `echo "... | bc"` which doesn't exist in Git Bash. The `|| echo "N/A"` fallback means ALL streams show "N/A", silently disabling MAXLEN trimming detection. **Fix:** Use `awk "BEGIN{printf \"%.2f\", ...}"`.

**M-08 (`timeout` on Windows):** Git Bash's `timeout` is Windows `timeout.exe` (waits for keypress), not GNU `timeout` (kills after N seconds). SSE capture at line 2619 will hang indefinitely. **Fix:** Use `curl --max-time 15` instead.

**M-17 (Private key docs):** Line 1117-1119 says "Ensure `.env` has... WALLET_PRIVATE_KEY" — this contradicts the security policy of keys only in `.env.local`. **Fix:** Change to `.env.local`.

---

## Low Findings (P3) — 18 items

| # | Category | Location | Description | Agent(s) |
|---|----------|----------|-------------|----------|
| L-01 | STALE_CONTENT | :4121 | Report footer says "v3.0" but file is v3.1 | TL+Perf |
| L-02 | STALE_CONTENT | :3378 | "Mantle and Mode are stubs" — RPC-validated 2026-03-08 | TL |
| L-03 | MISLEADING | :21 | Changelog: "Fixed MAXLEN: opportunities=500K" (fix was to 200K) | TL |
| L-04 | COMPLETENESS | :664-676 | Port table omits coordinator-worker (3009) | TL |
| L-05 | SCHEMA_DRIFT | :1407 | Coordinator health schema lists optional "version" field — doesn't exist | Arch |
| L-06 | SCHEMA_DRIFT | :1398-1408 | Coordinator required fields missing "systemHealth" | Arch |
| L-07 | CHECK_ACCURACY | :844-853 | ADR-022 spread grep matches rest params (false positive risk) | BH |
| L-08 | CHECK_ACCURACY | :703-704 | Check 1M catch regex misses comment-only and return-value patterns | BH |
| L-09 | CHECK_ACCURACY | :2159 | Single 30s staleness threshold for all chains — BSC/Arbitrum need lower | BH |
| L-10 | CHECK_ACCURACY | :1861-1862 | MAXLEN ratio check only covers 4 of 29 streams | BH |
| L-11 | STALE_CONTENT | :1000 | `closeServerWithTimeout` default listed as 5000ms, actual 1000ms | MF |
| L-12 | CONSISTENCY | Finding format | Pre-flight `PF-001` finding ID prefix undocumented | Perf |
| L-13 | COVERAGE_GAP | New | No build order validation (stale `.js` from partial builds) | TQ |
| L-14 | COVERAGE_GAP | New | Testnet mode: no check for mainnet RPC URLs with testnet flag | SEC |
| L-15 | COVERAGE_GAP | New | No CORS configuration monitoring | SEC |
| L-16 | COVERAGE_GAP | New | No contract pause state check (live/testnet only) | SEC |
| L-17 | COVERAGE_GAP | New | No Redis access control (requirepass) check | SEC |
| L-18 | EFFICIENCY | Check 3N | Trace search window (last 5 messages) too small for busy streams | TQ |

---

## Cross-Agent Insights

1. **ADR-033 is fundamentally broken in monitoring** — Bug Hunter's H-03 finding (wrong file + non-existent constant) combined with L-09 (single threshold for all chains) means the entire stale price validation in the monitoring is a no-op. The check will never find what it's looking for, and even if fixed, it uses a blanket 30s threshold when BSC needs ~5-10s.

2. **P2 chain drift is systemic** — 4 agents independently flagged different manifestations: inventory table (M-03 area of H-02), smoke test chain list (H-02), report template table (H-02), and "stubs" note (L-02). All stem from the same root cause: Mantle/Mode were re-added to P2 on 2026-03-10 but monitoring.md wasn't updated.

3. **Windows compatibility is a cluster** — Performance found `bc` (M-07), `timeout` (M-08), `jq` (M-09), and `redis-cli` (M-10) issues. Bug Hunter independently found `bc` (same finding). Together, these mean Phase 3's MAXLEN detection, SSE capture, and all jq-dependent checks silently fail on this Windows development machine.

4. **Check 3AI (Metrics Completeness) has 2 independent bugs** — Bug Hunter found both a phantom metric (H-05: `opportunities_detected_total`) and wrong metric names (H-04: missing `_ms` suffix). These together mean every monitoring run produces ≥5 false findings from this single check.

5. **Security findings explain Test Quality gaps** — Security's H-10 (HMAC compat) explains why Test Quality's smoke test doesn't verify stream authentication. Security's M-17 (private key in docs) relates to Test Quality's testnet safety gap.

6. **Mock Fidelity's timeout audit revealed the deepest drift** — All 4 timeout values in Check 1R are wrong (H-09). Combined with Performance's curl timeout finding (M-18), the monitoring's timeout hierarchy validation is checking fiction against fiction.

---

## Optimization Opportunities (from Performance Agent)

| # | Opportunity | Impact | Effort |
|---|-----------|--------|--------|
| O-01 | Cache HTTP responses at Phase 3 start — eliminates ~120 redundant curl calls | ~50% faster Phase 3 | Medium |
| O-02 | Auto-generate System Inventory from code — eliminates all inventory drift | Prevents H-01, H-02 class issues | Large |
| O-03 | Consolidate provider quality checks 3R-3V into one matrix check | Saves 16 curl calls | Medium |
| O-04 | Reuse Check 3AH t1 scrape as Phase 3 cache — eliminates explicit `sleep 15` | Saves 15s | Trivial |

---

## Verified Correct (No Issues Found)

Cross-verified by multiple agents:

| Claim | Verified By |
|-------|------------|
| 29 Redis Streams (all names match) | TL, Arch, MF |
| 23 feature flags (all names match) | TL, MF |
| 7 SSE event types in Check 3AL body | TL, TQ |
| Consumer groups (7 = 5 static + 2 dynamic) | TL, MF |
| Service port assignments match service-ports.json | TL, Arch, MF |
| Circuit breaker default threshold = 5 | TL |
| SharedArrayBuffer in price-matrix.ts (ADR-005) | TL |
| P1 chains: BSC, Polygon, Avalanche, Fantom | TL, Arch |
| P3 chains: Ethereum, zkSync, Linea | TL, Arch |
| P4 chains: Solana | TL, Arch |
| `useDynamicL1Fees` opt-out pattern | TL |
| All 29 stream MAXLEN values (except opportunities) | MF |
| Coordinator endpoints (9 verified) | Arch |
| Partition endpoints (4 verified) | Arch |
| EE endpoints (7 verified) | Arch |
| EE shutdown 45s total (drain 30s + buffer 15s) | MF |

---

## Recommended Action Plan

### Phase 1: Immediate (fix before next monitoring run) — 11 items ✅ COMPLETE (commit `1a77ea37`)

- [x] **H-01**: Update MAXLEN for opportunities from 500K to 200K (lines 88, 21)
- [x] **H-02**: Fix P2 chains in inventory (line 76), smoke test (line 3378), and template (lines 4072-4082)
- [x] **H-03**: Fix ADR-033 check to search cross-chain-detector for `maxPriceAgeMs` (lines 867-876)
- [x] **H-04**: Add `_ms` suffix to 3 pipeline latency metric names (lines 2492-2495)
- [x] **H-05**: Remove phantom `opportunities_detected_total` from required metrics (line 2497)
- [x] **H-06**: Add port 3006 to runtime metric loops (lines 1891, 1928)
- [x] **H-09**: Update all 4 timeout values in Check 1R (lines 996-1000)
- [x] **M-07**: Replace `bc` with `awk` for MAXLEN ratio (line 1866)
- [x] **M-08**: Replace `timeout 15 curl` with `curl --max-time 15` (lines 2619, 3020)
- [x] **M-09**: Add pre-flight check for `jq` dependency
- [x] **M-10**: Add pre-flight check for `redis-cli` dependency

### Phase 2: Next Sprint (documentation accuracy + coverage) — 14 items ✅ COMPLETE (commit `44819d18`)

- [x] **H-07**: Add ADR-038 streams to smoke test baseline
- [x] **H-08**: Add cross-chain detector smoke test step (Step 4F-2)
- [x] **M-01**: Update stale Redis client parity "known issue" (both clients now aligned)
- [x] **M-02**: Update stale UD port "known issue" (now correctly 3007)
- [x] **M-03**: Fix SSE event count /6→/7 (2 locations)
- [x] **M-04**: Add 3AR to report template section 3.9 table
- [x] **M-05**: Fix Phase 3 header to "9 subsections, 44 checks"
- [x] **M-06**: Fix report template Phase 3 count from 43 to 44
- [x] **M-13**: Fix Step 4G cross-reference from "Check 3I" to "Check 3E"
- [x] **M-17**: Fix testnet docs: use `.env.local` for WALLET_PRIVATE_KEY
- [x] **M-18**: Add `--max-time 10` to all ~90 curl calls
- [x] **H-10**: Add HMAC legacy compat check to Check 1G
- [x] **H-11**: Document CB flapping detection limitation + manual workaround in Check 3F
- [x] **L-01**: Fix report footer version v3.0→v3.1

### Phase 3: Backlog (polish + new checks) — remaining items

- [ ] L-02 through L-18: Minor fixes and new check suggestions
- [ ] O-01 through O-04: Performance optimizations

---

## Security Positive Findings

The Security agent confirmed these defenses are correctly implemented:

1. HMAC enforcement is fail-closed in production (constructor throws without signing key)
2. Auth bypass is NODE_ENV-whitelisted (only test/development)
3. Rate limiter defaults to fail-closed (Redis down = deny)
4. CORS throws in production without ALLOWED_ORIGINS
5. SSE token uses timing-safe comparison
6. DLQ root cause check correctly looks for `hmac_verification_failed`
7. DASHBOARD_AUTH_TOKEN required in production

---

## Analysis Methodology

**Team:** 6 specialized agents spawned in parallel. All 5 surviving agents reported back via SendMessage (architecture-auditor, bug-hunter, security-auditor, test-quality-analyst, mock-fidelity-validator, performance-refactor-reviewer). Team Lead performed initial verification during agent execution, then synthesized all findings.

**Deduplication:** 7 findings were identified by 2+ agents (see Agent Agreement Map). These were merged and given higher confidence scores.

**Files verified:** 20+ source files cross-referenced against monitoring.md claims, including redis/streams.ts, partitions.ts, events.ts, service-ports.json, feature-flags.ts, price-matrix.ts, health-server.ts, sse.routes.ts, useSSE.ts, ADR-033, and all service index files.

---

*Report generated by deep-analysis skill*
*Session: 2026-03-10*
