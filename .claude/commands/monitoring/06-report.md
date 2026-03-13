# Phase 5 — Shutdown & Report
# 6 steps, ~30 seconds. Captures final state, generates report, persists history.
# Reads thresholds from `.claude/commands/monitoring/config.json`

```
[PHASE 5/5] Shutdown & Report — starting (6 steps)
```

**Redis CLI:** All Redis commands use the Node.js replacement script:
```bash
REDIS_CLI="node scripts/monitoring/redis-cli.cjs"
```

Record findings to `./monitor-session/findings/report.jsonl` (if any new findings).

---

## Step 5A — Capture final stream state

```bash
for stream in $(cat ./monitor-session/streams/discovered.txt 2>/dev/null); do
  echo "=== FINAL: $stream ===" >> ./monitor-session/streams/final-state.txt
  $REDIS_CLI XINFO STREAM $stream >> ./monitor-session/streams/final-state.txt
  $REDIS_CLI XINFO GROUPS $stream >> ./monitor-session/streams/final-state.txt
  $REDIS_CLI XLEN $stream >> ./monitor-session/streams/final-state.txt
done

$REDIS_CLI INFO memory > ./monitor-session/streams/redis-memory-final.txt
```

---

## Step 5B — Stop services

```bash
npm run dev:stop
sleep 5
# Verify clean shutdown
tasklist | grep -i node | grep -v grep || echo "Clean shutdown — no node processes"
```

---

## Step 5C — Stop Redis

```bash
$REDIS_CLI SHUTDOWN NOSAVE 2>/dev/null || echo "Redis already stopped"
```

---

## Step 5D — GO/NO-GO decision

Read ALL finding files:
- `./monitor-session/findings/static-analysis.jsonl`
- `./monitor-session/findings/startup.jsonl`
- `./monitor-session/findings/runtime.jsonl` (if not quick mode)
- `./monitor-session/findings/smoke-test.jsonl` (if not quick mode)

### Severity counting rules

**Aggregation-aware counting:** When a finding has `"aggregatedInto": "RT-A<nn>"`, do NOT count
it individually — count only the aggregate finding. This prevents per-service breakdowns from
inflating the severity totals. Raw JSONL preserves all individual findings for audit.

**Severity override accounting:** Findings with `"originalSeverity"` have been downgraded by
the mode-conditional severity override system. Count them at their **overridden** (lower) severity,
not the original. Include an "Overrides Applied" count in the report.

### GO/NO-GO rules

Apply rules from `config.json`.goNoGo:

`[ALL]` Base rules:
- Any CRITICAL → **NO-GO**
- More than `config.json`.goNoGo.maxHighForGo HIGH findings → **NO-GO**
- All else → **GO** (with warnings)

`[QUICK]` Quick mode rules:
- Only Phase 1 findings are present — annotate decision as `[QUICK-STATIC-ONLY]`
- Same severity thresholds apply but result is advisory (no runtime validation)

`[LIVE/TESTNET]` Adjustments:
- Exclude `[LIVE-EXPECTED]` annotations from HIGH count
- Provider quality findings (3R-3V) have higher weight
- Include per-chain WebSocket data flow summary

`[TESTNET]` Additional:
- Note real testnet transactions from `stream:execution-results`
- Flag unexpected gas expenditure as HIGH

---

## Step 5E — Regression tracking

Compare current findings against previous session:

```bash
LAST_HISTORY=$(ls -t ./monitor-session/history/*.json 2>/dev/null | head -1)
echo "Previous session: ${LAST_HISTORY:-none}"
```

If previous history exists, build finding keys `{phase}:{category}:{title_normalized}` and classify:
- **NEW**: Current keys not in previous
- **RESOLVED**: Previous keys not in current
- **REGRESSED**: Same key, severity worsened
- **IMPROVED**: Same key, severity lessened
- **UNCHANGED**: Same key, same severity

If no previous history: "First run — no baseline for comparison."

---

## Step 5F — Persist session history

Write to `./monitor-session/history/<SESSION_ID>.json`:
```json
{
  "sessionId": "<SESSION_ID>",
  "timestamp": "<ISO8601>",
  "gitSha": "<CURRENT_SHA>",
  "dataMode": "simulation|live|testnet",
  "decision": "GO|NO-GO",
  "summary": { "critical": 0, "high": 0, "medium": 0, "low": 0, "info": 0, "total": 0 },
  "findings": [{ "findingId": "SA-001", "phase": "STATIC", "category": "...", "severity": "...", "title": "..." }]
}
```

Update incremental mode SHA:
```bash
cp ./monitor-session/current.sha ./monitor-session/last-run.sha
```

---

## Step 5G — CI summary output

If `MONITOR_CI_MODE=true`, write machine-readable summary for CI pipeline consumption:

```bash
MONITOR_CI_MODE="${MONITOR_CI_MODE:-false}"
if [ "$MONITOR_CI_MODE" = "true" ]; then
  # Write summary.json (path from config.json.ci.summaryFile)
  # Fields: decision, severity counts (after overrides), duration, mode
  echo "CI summary written to ./monitor-session/summary.json"
fi
```

Summary JSON schema:
```json
{
  "decision": "GO|NO-GO",
  "critical": 0, "high": 0, "medium": 0, "low": 0, "info": 0, "total": 0,
  "overridesApplied": 0,
  "aggregates": 0,
  "retryExhausted": 0,
  "duration": "<seconds>",
  "mode": "FULL|QUICK|INCREMENTAL",
  "dataMode": "simulation|live|testnet",
  "sessionId": "<SESSION_ID>",
  "gitSha": "<CURRENT_SHA>"
}
```

The CI system should check `decision` field and use exit codes from `config.json`.ci:
- `exitCodeGo` (0) when decision is GO
- `exitCodeNoGo` (1) when decision is NO-GO

```
[PHASE 5/5] Shutdown & Report — complete (decision: GO|NO-GO)
```

---

## Report Template

Write to `./monitor-session/REPORT_<SESSION_ID>.md`:

```markdown
# Pre-Deploy Validation Report

**Session:** <SESSION_ID> | **Date:** <ISO8601> | **Duration:** <elapsed>
**Git SHA:** <CURRENT_SHA> | **Mode:** FULL / INCREMENTAL / QUICK | **Data Mode:** SIM / LIVE / TESTNET
**Config:** v4.2 | **Overrides applied:** <n> findings downgraded | **Aggregates:** <n> groups | **Retries exhausted:** <n>

## Decision: GO / NO-GO <[QUICK-STATIC-ONLY] if quick mode>

| Severity | Raw Count | After Aggregation | After Overrides |
|----------|-----------|-------------------|-----------------|
| CRITICAL | <n> | <n> | <n> |
| HIGH     | <n> | <n> | <n> |
| MEDIUM   | <n> | <n> | <n> |
| LOW      | <n> | <n> | <n> |
| INFO     | <n> | <n> | <n> |

**GO/NO-GO uses "After Overrides" column** for severity threshold evaluation.

**Reason:** <if NO-GO, list blocking findings>

### Data Mode Summary

<SIM:> Synthetic prices (Markov regime). All stages validated. Provider checks are `[SIM]`.
<LIVE:> Real WS RPC, mock execution. Active chains: <list>. Silent: <list>. `[LIVE-EXPECTED]` excluded: <n>.
<TESTNET:> Real WS RPC, real testnet execution. Transactions: <n>. Gas spent: <amount>.

### Regression Analysis

<If previous session:>
| Change | Count | Details |
|--------|-------|---------|
| NEW | <n> | Appeared since last run |
| RESOLVED | <n> | Fixed |
| REGRESSED | <n> | Got worse |
| IMPROVED | <n> | Got better |
| UNCHANGED | <n> | Same |

<If REGRESSED:> List each: `<id>: <title> — was <old>, now <new>`
<If first run:> *No baseline for comparison.*

---

## Phase 1: Static Analysis (24 checks)

| Check | Status | Findings |
|-------|--------|----------|
| 1A-1Y | PASS/FAIL | <count> |

(List each check from 02-static-analysis.md by ID and name)

## Phase 2: Service Readiness

| Service | Port | Status | Startup Time |
|---------|------|--------|-------------|
| (from inventory.json services) | | READY/FAILED | <ms> |

Streams: <n>/29 discovered. Missing: <list>

## Phase 3: Runtime Validation (42 checks)

Report by subsection (from 04-runtime.md):

| Subsection | Checks | Pass | Fail | Findings |
|------------|--------|------|------|----------|
| 3.1 Service Health | 3A-3C | <n> | <n> | <n> |
| 3.2 Risk & CB | 3D-3G | <n> | <n> | <n> |
| 3.3 Data Flow & DLQ | 3H-3N | <n> | <n> | <n> |
| 3.4 Runtime Perf | 3O-3Q | <n> | <n> | <n> |
| 3.5 Provider Quality | 3R-3V | <n> | <n> | <n> |
| 3.6 Detection Quality | 3W-3Y | <n> | <n> | <n> |
| 3.7 Execution & BI | 3Z-3AG | <n> | <n> | <n> |
| 3.8 Observability | 3AH-3AI | <n> | <n> | <n> |
| 3.9 Dashboard | 3AJ-3AR | <n> | <n> | <n> |

## Phase 4: Pipeline Smoke Test

| Stream | Baseline | Final | Growth | Status |
|--------|----------|-------|--------|--------|
| stream:price-updates | <n> | <n> | +<n> | FLOWING/STALLED |
| stream:opportunities | <n> | <n> | +<n> | FLOWING/STALLED |
| stream:execution-requests | <n> | <n> | +<n> | FLOWING/STALLED |
| stream:execution-results | <n> | <n> | +<n> | FLOWING/STALLED |
| stream:fast-lane | <n> | <n> | +<n> | FLOWING/EMPTY |

Pipeline: FLOWING / STALLED AT <stage>
Trace: YES / NO / PARTIAL | DLQ growth: <n>
Detection: <n>/<total> chains active | Risk: NORMAL/CAUTION/HALT
Backpressure: INACTIVE/ACTIVE (<n>%) | Partitions: <n>/4 active
BI: RECORDING/NOT/N/A | Runtime: STABLE/DEGRADED

## All Findings (sorted by severity)

<For each finding, format as readable block with all JSON fields>

---

*Report generated by monitoring v4.2*
*Session: <SESSION_ID> | Completed: <ISO8601>*
```
