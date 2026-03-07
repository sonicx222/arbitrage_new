# Extended Deep Analysis — Git Diff (2026-03-07)

**Target**: `git diff` (36 files, 832 added / 2581 deleted)
**Date**: 2026-03-07
**Method**: 6 specialized agents (all 6 reported)
**Grade**: **B+** (1 Critical / 1 High / 3 Medium / 5 Low / 8 Info)

---

## Executive Summary

The git diff contains backend reliability fixes (MAXLEN increase, pipeline timestamp deserialization, HMAC env var rename), a comprehensive dashboard theme overhaul, Fly.io deployment improvements, and documentation cleanup. No latency regression to the <50ms hot-path target.

**One critical finding**: The SM-013 pipelineTimestamps fix is a **NO-OP** — it checks `typeof rawTs === 'string'` but the data arrives as a parsed JS object from `JSON.parse` in `parseStreamResult()`. The stated goal (fixing `opportunity_age_at_execution_ms`) is **NOT achieved**.

**Top 5 Issues:**
1. **C-01**: SM-013 fix is a NO-OP — `typeof string` check never matches the object-type pipelineTimestamps from stream deserialization
2. **H-01**: StreamHealthMonitor `lengthCritical=100K` equals new MAXLEN — alert fires at 100% (data already being trimmed)
3. **M-01**: `.env.local` still references old env var name `LEGACY_HMAC_COMPAT` (should be `STREAM_LEGACY_HMAC_COMPAT`)
4. **M-02**: SM-013 silent catch block in coordinator vs logged WARN in EE — observability asymmetry
5. **M-03**: Coordinator SM-013 timestamp whitelist has 4 fields vs EE's 6 — strips fields on DLQ replay

**Agent Agreement Map:**
- SM-013 NO-OP: data-integrity-auditor (single-source, **verified by team lead** via full data flow trace)
- HMAC env var rename: failure-mode-analyst + config-drift-detector + observability-auditor (3-agent agreement)
- SM-013 silent catch: failure-mode-analyst + observability-auditor (2-agent agreement)
- MAXLEN threshold alignment: failure-mode-analyst (single-source, verified by team lead)

---

## Critical Findings (P0)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| C-01 | Data Integrity / Bug | `opportunity-router.ts:583-596` | **SM-013 fix is a NO-OP.** The code checks `typeof rawTs === 'string'` (line 584), but `pipelineTimestamps` arrives as a **parsed JS object** — NOT a string. The stream deserialization in `parseStreamResult()` (`streams.ts:1494-1495`) does `data[key] = JSON.parse(value)` on the single `'data'` JSON field, reconstructing the full nested object including `pipelineTimestamps`. Therefore `typeof rawTs === 'string'` is always `false`, the JSON.parse block never executes, and `opportunity.pipelineTimestamps` remains `undefined`. The stated fix goal (carrying `detectedAt` forward to enable `opportunity_age_at_execution_ms` in the EE) is **NOT achieved**. | data-integrity-auditor, **team-lead verified** | HIGH (95%) — Full data flow traced: `xadd('data', JSON.stringify(opp))` → `parseStreamResult: JSON.parse(value)` → object, not string | Change line 584 to `if (rawTs && typeof rawTs === 'object')` with `const parsed = rawTs as Record<string, unknown>` (remove JSON.parse). Keep the existing `typeof === 'string'` as a fallback else-if for safety. | 4.8 |

**Detailed trace for C-01:**
```
1. Publisher: xadd(stream, *, 'data', JSON.stringify(opportunity))
   → opportunity.pipelineTimestamps = { wsReceivedAt, publishedAt, detectedAt }  [JS object]
   → Redis stores: data = '{"id":"...","pipelineTimestamps":{"detectedAt":1741234567}}'

2. Consumer: parseStreamResult() at streams.ts:1494
   → data['data'] = JSON.parse('{"id":"...","pipelineTimestamps":{"detectedAt":1741234567}}')
   → data['data'].pipelineTimestamps = { detectedAt: 1741234567 }  [JS object, NOT string]

3. streams.ts:1501: message.data = data.data ?? data  →  fully parsed object

4. coordinator.ts:1376: data = message.data as Record<string, unknown>

5. opportunity-router.ts:583: rawTs = data.pipelineTimestamps  →  { detectedAt: 1741234567 }  [object]
   opportunity-router.ts:584: typeof rawTs === 'string'  →  FALSE  →  block skipped
   opportunity.pipelineTimestamps remains UNDEFINED

6. opportunity-router.ts:944: timestamps = opportunity.pipelineTimestamps ?? {}  →  {}
   timestamps.coordinatorAt = Date.now()
   → pipelineTimestamps = { coordinatorAt: ... }  [detectedAt LOST]

7. serializeOpportunityForStream: JSON.stringify({ coordinatorAt: ... })  [no detectedAt]

8. EE execution-pipeline.ts:478: executionStartedAt - detectedAt → NaN → metric NOT recorded
```

---

## High Findings (P0)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| H-01 | Failure/Alert | `shared/core/src/monitoring/stream-health-monitor.ts:140` | `lengthCritical: 100000` equals EXECUTION_RESULTS MAXLEN (100K). Alert fires at 100% capacity — by which time approximate MAXLEN trimming is already discarding unread messages. Additionally, `checkStreamLag()` runs for EXECUTION_REQUESTS only (coordinator.ts:2277), NOT for EXECUTION_RESULTS. Lost results cause `totalProfit`/`successfulExecutions` counters to undercount. | failure-mode-analyst | HIGH (90%) | Lower `lengthCritical` to 80000 (80% of MAXLEN) OR add `checkStreamLag(EXECUTION_RESULTS)` to coordinator health loop | 4.1 |

---

## Medium Findings (P1)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| M-01 | Config Drift | `.env.local:632` | `.env.local` still has `# LEGACY_HMAC_COMPAT=false` (old name). Code reads `STREAM_LEGACY_HMAC_COMPAT`. If a developer copies `.env.local` and sets the old name, it will be silently ignored. | config-drift-detector, failure-mode-analyst | HIGH (100%) | Rename to `# STREAM_LEGACY_HMAC_COMPAT=false` in `.env.local` | 3.2 |
| M-02 | Observability | `opportunity-router.ts:593-595` | SM-013 catch block is completely silent — no log, no counter, no metric. The EE's equivalent catch block at `opportunity.consumer.ts:533-535` logs `logger.warn()`. This creates an observability asymmetry: parse failures in the EE are visible but identical failures in the coordinator are dark. | observability-auditor, failure-mode-analyst | HIGH (95%) | Add `this.logger.debug('pipelineTimestamps parse failed', { rawTs: rawTs?.substring?.(0, 100) })` | 3.0 |
| M-03 | Data Integrity | `opportunity-router.ts:588-591` | Coordinator SM-013 deserializes 4 timestamp fields (`wsReceivedAt`, `publishedAt`, `consumedAt`, `detectedAt`). EE (`opportunity.consumer.ts:526-531`) deserializes 6 fields (adds `coordinatorAt`, `executionReceivedAt`). On DLQ replay where a message re-enters the coordinator, `coordinatorAt` and `executionReceivedAt` are stripped — losing forensic data. (Note: this finding is subordinate to C-01 — the whitelist is correct but the code path is never reached.) | cross-chain-analyst | HIGH (95%) | Add `coordinatorAt` and `executionReceivedAt` to coordinator's whitelist (2 lines) — fix as part of C-01 | 3.0 |

---

## Low Findings (P2)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| L-01 | Config Drift | `shared/core/src/redis/streams.ts:1678` | Stale comment: `"Wire LEGACY_HMAC_COMPAT env var"` references old name without `STREAM_` prefix. Code on line 1683 reads the correct `STREAM_LEGACY_HMAC_COMPAT`. | config-drift-detector, failure-mode-analyst | HIGH (100%) | Update comment to reference `STREAM_LEGACY_HMAC_COMPAT` | 2.5 |
| L-02 | Failure Mode | `shared/core/src/redis/streams.ts:1683,1744` | No deprecation warning when old env var `LEGACY_HMAC_COMPAT` is detected. An existing deployment with the old name set would silently ignore it. Low actual risk since default was already flipped to `false` (compat OFF) in prior P1 fix. | failure-mode-analyst | HIGH (90%) | Add: `if (process.env.LEGACY_HMAC_COMPAT !== undefined) logger.warn('LEGACY_HMAC_COMPAT deprecated — use STREAM_LEGACY_HMAC_COMPAT')` | 2.3 |
| L-03 | Observability | `shared/core/src/redis/streams.ts:430` | No explicit metric or alert when EXECUTION_RESULTS approaches MAXLEN and trimming starts. The `stream_length` gauge exists but there's no `stream_capacity_ratio` metric or alert rule for capacity exhaustion. | observability-auditor | MEDIUM (75%) | Add `stream_capacity_ratio = xlen / MAXLEN` metric with alert at >0.9 | 2.2 |
| L-04 | Cross-Chain | `infrastructure/fly/cross-chain-detector.toml:84-92` | Fly.io secrets comment block lists only 7 chain RPC URLs. Missing 6 chains: Avalanche, Fantom, zkSync, Linea, Blast, Scroll. Documentation-only issue — actual secrets can be set regardless. | cross-chain-analyst | HIGH (95%) | Update comment block to list all configured chain RPCs | 1.8 |
| L-05 | Performance | `dashboard/src/styles/globals.css:49,70-72` | `backdrop-filter: blur(12-14px)` on cards and header. Compositing cost is ~1-4ms/frame on low-power devices when background content scrolls. Not a concern for target audience (trading operators on capable hardware). | latency-profiler | MEDIUM (70%) | No action needed. Monitor if performance complaints arise. | 1.5 |

---

## Informational Findings (P3)

| # | Category | File:Line | Description | Agent(s) |
|---|----------|-----------|-------------|----------|
| I-01 | Latency | `opportunity-router.ts:584-596` | SM-013 JSON.parse block never executes (C-01), so adds zero latency. When fixed to handle object type, per-opp overhead would be ~0.005ms (type checks only, no JSON.parse needed). | latency-profiler, data-integrity-auditor |
| I-02 | Latency | `streams.ts:430` | MAXLEN 25K→100K has zero XADD latency impact (Redis approximate trimming is O(1) amortized). Memory +37.5MB (Redis 49%→57%) | latency-profiler |
| I-03 | Dashboard | `dashboard/index.html:7-9` | Google Fonts with `display=swap` + `preconnect` hints — correct pattern. Fallback `system-ui` stack in tailwind.config.ts handles blocked CDN gracefully | latency-profiler, config-drift-detector |
| I-04 | Deployment | `cross-chain-detector.toml:68-75` | `/ready` health check with 60s grace period is adequate (startup typically 5-15s after P3 fix). Consistent with all 8 Fly.io service configs | cross-chain-analyst |
| I-05 | Cross-Chain | `opportunity-publisher.ts:261` | `detectedAt` for cross-chain opportunities reflects detector wall clock, not slower chain's block time. `opportunity_age_at_execution_ms` underestimates true price staleness by up to slower chain's block time (design limitation, not diff-introduced) | cross-chain-analyst |
| I-06 | Cross-Chain | `cross-chain-detector.toml:53` | 256MB memory may be tight for TF.js LSTM + large stream bootstrap. Service degrades gracefully without ML. Monitor for OOM. | cross-chain-analyst |
| I-07 | Dashboard | `globals.css:75-85`, `StatusBadge.tsx:14` | All CSS animations use GPU-composited properties (opacity, transform). No layout thrashing. Multiple `animate-ping` instances on StreamsTab are trivial | latency-profiler |
| I-08 | Config | `dashboard/` | Theme migration from hardcoded hex to CSS variables is complete. No leftover hardcoded colors. Font names consistent across HTML, CSS vars, and Tailwind config | config-drift-detector |

---

## Latency Budget Table

| Stage | Component | File:Line | Estimated Latency | Hot Path? | Bottleneck? |
|-------|-----------|-----------|-------------------|-----------|-------------|
| Stream Consumption | pipelineTimestamps type checks (after C-01 fix) | `opportunity-router.ts:586` | +0.005ms/opp | YES | NO |
| Stream Write | XADD EXECUTION_RESULTS (MAXLEN 100K) | `streams.ts:430` | ~0 change | YES (EE side) | NO |
| Dashboard Render | Google Fonts CSS load | `index.html:9` | +100-300ms FCP (first load) | N/A (UI) | NO (swap) |
| Dashboard Render | backdrop-filter blur | `globals.css:49,70` | +1-4ms/frame (low-end) | N/A (UI) | Marginal |
| Dashboard Render | CSS animations | `globals.css:75-85` | ~0 (composited) | N/A (UI) | NO |

---

## Failure Mode Map

| # | Stage | Failure Mode | Detection | Recovery | Data Loss Risk | File:Line |
|---|-------|-------------|-----------|----------|----------------|-----------|
| 1 | Coordinator timestamps | **SM-013 NO-OP**: `detectedAt` lost at coordinator due to type mismatch | **None** — `opportunity_age_at_execution_ms` silently absent from metrics | Fix code to handle object type | **MEDIUM** — pipeline timing metrics permanently broken | `opportunity-router.ts:583-596`, `streams.ts:1494-1501` |
| 2 | Coordinator→EE results | MAXLEN trim on EXECUTION_RESULTS | `lengthCritical=100K` (fires at 100%) | Coordinator resumes from `>` (new only) | **MEDIUM** — trimmed results permanently lost | `streams.ts:430`, `stream-health-monitor.ts:140` |
| 3 | HMAC verification | Old env var silently ignored | **None** — no warning logged | Manual env var rename | **LOW** — only during mixed-version deploy | `streams.ts:1683,1744` |
| 4 | Coordinator timestamps | Malformed JSON swallowed silently | **None** — no log/counter | Self-heals when producers update | **LOW** — metrics degrade, no financial loss | `opportunity-router.ts:593-595` |
| 5 | Cross-chain /ready | Service startup >60s | Fly.io health check failure | Auto-restart; old stays during rolling deploy | **NONE** | `cross-chain-detector.toml:68-75` |

---

## Chain-Specific Edge Cases

| # | Chain(s) | Issue | Impact | Severity | File:Line |
|---|----------|-------|--------|----------|-----------|
| 1 | All cross-chain | `detectedAt` doesn't capture slower chain's block staleness | `opportunity_age_at_execution_ms` underestimates by up to 12s (Ethereum) | INFO | `opportunity-publisher.ts:261` |
| 2 | All (deployment) | 6 chain RPC URLs missing from Fly.io secrets comment | Documentation gap only | LOW | `cross-chain-detector.toml:84-92` |
| 3 | All (ML) | 256MB may be tight for TF.js LSTM warmup | Graceful degradation to no-ML mode | INFO | `cross-chain-detector.toml:53` |

---

## Observability Assessment

**Trace Propagation**: **BROKEN** at coordinator stage. Due to C-01, `pipelineTimestamps` (including `detectedAt`) is NOT carried forward from the detection stream to the execution stream. The `opportunity_age_at_execution_ms` metric in the EE is always absent. Once C-01 is fixed, propagation will be complete: detector → coordinator → EE → execution-pipeline metrics.

**Log Coverage**:
| Code Change | Log Level | Coverage |
|---|---|---|
| SM-013 coordinator catch | SILENT | **GAP** (also: code path is never reached per C-01) |
| SM-013 EE catch | WARN | OK |
| HMAC compat startup | INFO | OK |
| /ready health check | DEBUG | Partial |

**Metrics Coverage**: Stream length and consumer lag monitored. Missing: MAXLEN capacity ratio alert, parse failure counter.

**Blind Spots**: (1) `opportunity_age_at_execution_ms` broken silently (C-01), (2) MAXLEN trimming events dark, (3) No alert before capacity exhaustion.

---

## Configuration Health

**Env Var Drift**: `.env.local:632` has old `LEGACY_HMAC_COMPAT` name. `.env.example:660` correctly updated. Code references correct new name at 2 locations.

**MAXLEN Consistency**: PASS — 100K documented correctly in monitoring.md and streams.ts.

**Dashboard Theme**: PASS — Full CSS variable migration complete. No leftover hardcoded colors. Font names consistent across HTML, CSS, Tailwind.

**Fly.io Deployment**: PASS — `/ready` checks consistent across all 8 services. Ports correct. Grace periods aligned.

**Feature Flags**: No new feature flags introduced in this diff. Existing `=== 'true'` pattern maintained.

---

## Cross-Agent Insights

### Information Separation Results (Failure-Mode vs Data-Integrity)
- **Both agents reported.** The data-integrity-auditor's late-arriving report contained the **most critical finding** (C-01) — validating the importance of the 6-agent approach.
- Failure-mode-analyst focused on failure recovery and detection gaps (MAXLEN thresholds, env var rename).
- Data-integrity-auditor traced the **full message serialization lifecycle** and discovered the SM-013 fix operates on the wrong type.
- **Agreement**: Both agents flagged the `.env.local` drift (FM as risk, DI as confirmed finding).
- **Unique DI finding**: C-01 was discovered ONLY by data-integrity-auditor (no other agent traced the `parseStreamResult` deserialization path).

### Multi-Agent Agreement
- **3 agents** flagged the HMAC env var rename (FM, CD, OA) — HIGH confidence
- **2 agents** flagged the silent SM-013 catch block (FM, OA) — HIGH confidence
- **2 agents** confirmed dashboard theme consistency (LP, CD) — no drift found

### Unique Single-Agent Findings
- **Data-integrity-auditor** uniquely identified C-01 (SM-013 NO-OP) — **verified by team lead via independent trace**
- Cross-chain-analyst uniquely identified M-03 (timestamp whitelist mismatch) — verified by team lead
- Failure-mode-analyst uniquely identified H-01 (StreamHealthMonitor threshold alignment) — verified by team lead
- Latency-profiler confirmed **zero hot-path regression** — no other agent disagreed

---

## Conflict Resolutions

### C-01 vs I-01 (Latency Assessment)
The latency-profiler assessed SM-013's JSON.parse at +0.01ms per opportunity. The data-integrity-auditor proved the code never executes. **Resolution**: I-01 updated to reflect that SM-013 adds zero latency currently, and the corrected fix (object type check) would add ~0.005ms (type guards only, no JSON.parse needed). Both perspectives are correct — no real conflict.

### M-03 (Whitelist Mismatch) vs C-01 (NO-OP)
Cross-chain-analyst flagged the coordinator's 4-field whitelist vs EE's 6-field whitelist as a data loss risk on DLQ replay. Data-integrity-auditor showed the whitelist code is never reached. **Resolution**: M-03 is subordinate to C-01 — the whitelist should be fixed as part of the C-01 remedy, but the immediate issue is the type check, not the field list.

---

## Recommended Action Plan

### Phase 1: Immediate (P0 — fix before deployment)
- [ ] **C-01**: Fix SM-013 pipelineTimestamps deserialization to handle object type:
  ```typescript
  const rawTs = data.pipelineTimestamps;
  if (rawTs && typeof rawTs === 'object') {
    const parsed = rawTs as Record<string, unknown>;
    const pts: PipelineTimestamps = {};
    if (typeof parsed.wsReceivedAt === 'number') pts.wsReceivedAt = parsed.wsReceivedAt;
    if (typeof parsed.publishedAt === 'number') pts.publishedAt = parsed.publishedAt;
    if (typeof parsed.consumedAt === 'number') pts.consumedAt = parsed.consumedAt;
    if (typeof parsed.detectedAt === 'number') pts.detectedAt = parsed.detectedAt;
    if (typeof parsed.coordinatorAt === 'number') pts.coordinatorAt = parsed.coordinatorAt;      // M-03 fix
    if (typeof parsed.executionReceivedAt === 'number') pts.executionReceivedAt = parsed.executionReceivedAt;  // M-03 fix
    opportunity.pipelineTimestamps = pts;
  } else if (typeof rawTs === 'string') {
    // Fallback for flat-field serialization paths (future-proofing)
    try { /* existing JSON.parse logic */ } catch { this.logger.debug('pipelineTimestamps parse failed'); }
  }
  ```
  (`opportunity-router.ts:583-596` — fixes C-01, M-02, M-03 simultaneously)

- [ ] **H-01**: Lower StreamHealthMonitor `lengthCritical` from 100K to 80K, OR add `checkStreamLag(EXECUTION_RESULTS)` to coordinator health loop (`stream-health-monitor.ts:140`, `coordinator.ts:2277`)

### Phase 2: Next Sprint (P1 — reliability and coverage)
- [ ] **M-01**: Rename `LEGACY_HMAC_COMPAT` to `STREAM_LEGACY_HMAC_COMPAT` in `.env.local:632`

### Phase 3: Backlog (P2/P3 — hardening and observability)
- [ ] **L-01**: Update stale comment at `streams.ts:1678` to reference `STREAM_LEGACY_HMAC_COMPAT`
- [ ] **L-02**: Add deprecation warning for old `LEGACY_HMAC_COMPAT` env var at startup
- [ ] **L-03**: Add `stream_capacity_ratio` metric or lower `lengthCritical` to percentage-of-MAXLEN
- [ ] **L-04**: Update Fly.io secrets comment block with all 15 chain RPC URLs
- [ ] Run `npm run build:clean` to purge stale `dist/` artifacts referencing old env var name

---

## Analysis Metadata

| Metric | Value |
|--------|-------|
| Agents spawned | 6 |
| Agents reported | 6 (data-integrity-auditor reported late but delivered critical finding) |
| Total findings | 18 (1C / 1H / 3M / 5L / 8I) |
| False positives | 0 |
| Inter-agent conflicts | 2 resolved (latency vs NO-OP, whitelist vs NO-OP) |
| Cross-agent agreement areas | 3 |
| Verification checks by team lead | 5 (C-01 full data flow trace, HMAC env var, StreamHealthMonitor, timestamp whitelist, stale comment) |
