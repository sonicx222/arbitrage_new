# Phase 5 — Shutdown & Report
# 6 steps, ~30 seconds. Captures final state, generates report, persists history.
# Reads thresholds from `.claude/commands/monitoring/config.json`

Record findings to `./monitor-session/findings/report.jsonl` (if any new findings).

---

## Step 5A — Capture final stream state

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
redis-cli SHUTDOWN NOSAVE 2>/dev/null || echo "Redis already stopped"
```

---

## Step 5D — GO/NO-GO decision

Read ALL finding files:
- `./monitor-session/findings/static-analysis.jsonl`
- `./monitor-session/findings/startup.jsonl`
- `./monitor-session/findings/runtime.jsonl`
- `./monitor-session/findings/smoke-test.jsonl`

Count findings by severity. Apply rules from `config.json`.goNoGo:

`[ALL]` Base rules:
- Any CRITICAL → **NO-GO**
- More than `config.json`.goNoGo.maxHighForGo HIGH findings → **NO-GO**
- All else → **GO** (with warnings)

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

## Report Template

Write to `./monitor-session/REPORT_<SESSION_ID>.md`:

```markdown
# Pre-Deploy Validation Report

**Session:** <SESSION_ID> | **Date:** <ISO8601> | **Duration:** <elapsed>
**Git SHA:** <CURRENT_SHA> | **Mode:** FULL / INCREMENTAL | **Data Mode:** SIM / LIVE / TESTNET

## Decision: GO / NO-GO

| Severity | Count |
|----------|-------|
| CRITICAL | <n> |
| HIGH     | <n> |
| MEDIUM   | <n> |
| LOW      | <n> |
| INFO     | <n> |

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

*Report generated by monitoring v4.0*
*Session: <SESSION_ID> | Completed: <ISO8601>*
```
