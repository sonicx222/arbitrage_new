# Autopilot: Autonomous Optimization Loop

**Date:** 2026-03-07
**Status:** Design approved, pending implementation plan
**Command:** `.claude/commands/autopilot.md` (invoked as `/autopilot`)

---

## Overview

A fully autonomous optimization loop that starts the arbitrage system, dispatches 12 specialized agents to analyze the live running system, automatically applies fixes, rebuilds, restarts, and revalidates in iterative cycles until convergence. Separate from the existing `monitoring.md` (quick pre-deploy validation) — this is the heavy-duty system for reaching production readiness.

**Key design decisions:**
- Fully autonomous (detect, fix, rebuild, revalidate — no human approval per fix)
- Full autonomy scope: code, config, docs, infrastructure files, CLAUDE.md, plus git commits
- Convergence-based exit: stops when no new fixable findings remain OR max 5 cycles
- Time budget: 1-2 hours per invocation
- 12 functional specialist agents, all Opus 4.6

---

## Architecture

### Loop Structure

```
PHASE 0: BOOTSTRAP
  Build all packages -> Start Redis -> Start 7 services
  Wait for readiness -> Capture baseline state

CYCLE N (max 5):
  STEP 1: ANALYZE    - Dispatch analysis agents (all 10 on cycle 1, dirty-domain only on 2-5)
  STEP 2: TRIAGE     - Deduplicate, prioritize, build fix manifest
  STEP 3: FIX        - Fix implementer applies changes guided by manifest
  STEP 4: REBUILD    - npm run build -> restart services -> wait ready
  STEP 5: VALIDATE   - Regression guard re-runs checks on fixed domains
  STEP 6: COMMIT     - git commit with cycle summary, check convergence

PHASE FINAL: REPORT
  Stop services -> Stop Redis -> Generate final report
  Copy report to docs/reports/AUTOPILOT_REPORT_<SESSION_ID>.md
```

### Time Budget Per Cycle

- Cycle 1 (full): ~25 min (10 parallel agents + fix + rebuild + validate)
- Cycles 2-5 (targeted): ~12-15 min (fewer agents + fewer fixes)
- Total worst case (5 cycles): ~85 min
- Typical (convergence at cycle 3): ~55 min

---

## Agent Roster

### Analysis Agents (10 — dispatched in parallel during Step 1)

All agents: `model: "opus"`, `subagent_type: "general-purpose"`

| # | Agent Name | Domain | Key Data Sources |
|---|-----------|--------|-----------------|
| 1 | static-analyst | Code quality: stream declarations, MAXLEN, XACK, nullish coalescing, silent errors, type fidelity, ADR compliance | Glob, Grep, Read on source files |
| 2 | service-health-monitor | Service health: health/ready/stats endpoints, leader election, health schema validation | curl to all 7 service endpoints |
| 3 | streams-analyst | Redis Streams: topology, consumer groups, lag, pending, DLQ, MAXLEN fill ratios | redis-cli XINFO, XPENDING, XLEN |
| 4 | performance-profiler | Runtime performance: event loop delay, GC pressure, memory breakdown, heap usage | /metrics endpoints (Prometheus) |
| 5 | detection-analyst | Detection quality: per-chain coverage, cycle timing vs <50ms, opps/cycle, price staleness | /stats + /metrics on P1-P4 |
| 6 | execution-analyst | Execution pipeline: success rates, outcome distribution, profit slippage, opp age, gas efficiency | /stats + /metrics on EE (port 3005) |
| 7 | security-config-auditor | Security & config: env var drift, HMAC, feature flags, risk config, unsafe parse, Redis parity | Source files + .env.example |
| 8 | infra-auditor | Infrastructure: Docker/Fly.io alignment, port collisions, timeout hierarchy, Dockerfile images | Infra configs + source constants |
| 9 | dashboard-validator | Observability & UI: SPA, SSE events, REST endpoints, type sync, service keys, proxy config | curl to coordinator + dashboard source |
| 10 | e2e-flow-tracer | E2E data flow: trace messages through full pipeline, verify trace context, per-stage latency | Redis stream sampling + /metrics |

### Fix & Validation Agents (2 — dispatched sequentially in Steps 3 & 5)

| # | Agent Name | Role |
|---|-----------|------|
| 11 | fix-implementer | Receives prioritized fix manifest. Edits source, config, docs. Runs typecheck + targeted tests after each change. Hard cap: 15 fixes per cycle. |
| 12 | regression-guard | After rebuild/restart, re-runs checks on fixed domains. Verifies no new CRITICAL/HIGH regressions. Compares before/after metrics. |

### Agent Communication Protocol

- Every agent prompt starts with SendMessage report-back instruction
- Analysis agents write findings to `./autopilot-session/findings/{agent-name}.jsonl`
- Fix implementer reads from `./autopilot-session/cycle-{N}/fix-manifest.json`
- Regression guard reads from `./autopilot-session/cycle-{N}/fixes-applied.json`
- Prompts kept under 300 lines
- 2-minute stall timeout — orchestrator self-executes if agent unresponsive

---

## State Management

### Directory Structure

```
autopilot-session/
  SESSION_ID
  current.sha
  config.json
  baseline/
    streams.json, redis-memory.txt, service-health.json,
    service-stats.json, metrics-t0.txt
  cycle-N/
    findings/{agent-name}.jsonl    (analysis outputs)
    triage.json                    (deduplicated, prioritized)
    fix-manifest.json              (what to fix)
    fixes-applied.json             (what was changed)
    regression-results.json        (validation after fix)
    dirty-domains.json             (domains needing re-analysis)
    cycle-summary.json             (stats)
    commit.sha                     (git SHA)
  convergence.json                 (cross-cycle tracking)
  logs/
    services.log, redis.log
  REPORT.md                        (final report)
```

### Finding Format (JSONL)

```json
{
  "id": "SA-001",
  "agent": "static-analyst",
  "cycle": 1,
  "severity": "HIGH",
  "category": "STREAM_DECLARATION",
  "title": "Hardcoded stream name in execution consumer",
  "file": "services/execution-engine/src/consumers/main.consumer.ts",
  "line": 42,
  "evidence": "xReadGroup('stream:execution-requests', ...)",
  "expected": "Use RedisStreams.EXECUTION_REQUESTS constant",
  "actual": "Hardcoded string literal",
  "fixable": true,
  "fix_hint": "Replace string with imported constant from shared/types/src/events.ts",
  "domain_tags": ["streams", "execution"]
}
```

### Fix Manifest Format

```json
{
  "cycle": 1,
  "total_findings": 28,
  "fixable": 22,
  "deferred": 6,
  "fixes": [
    {
      "priority": 1,
      "finding_id": "EX-003",
      "severity": "CRITICAL",
      "title": "...",
      "fix_hint": "...",
      "affected_files": ["..."],
      "test_command": "npm test -- --testPathPattern=execution"
    }
  ],
  "deferred_items": [
    { "finding_id": "INF-002", "severity": "LOW", "reason": "Cosmetic" }
  ]
}
```

---

## Fix Strategy & Safety Rails

### Fix Prioritization

1. CRITICAL findings (fixable) — always fix
2. HIGH findings (fixable) — fix if time permits
3. MEDIUM findings (fixable) — fix only if CRITICAL and HIGH are clear
4. LOW findings — never auto-fix, deferred to report

### Fix Implementer Rules

**Must do:**
- Read target file before editing
- Run `npm run typecheck` after each file change
- Run targeted tests after each logical fix
- Record every change in fixes-applied.json
- Stop on typecheck/test failure — mark as fix_failed, move to next

**Must not:**
- Refactor beyond what finding requires
- Change public APIs (adding fields OK, removing/renaming not)
- Modify test assertions to make tests pass
- Apply more than 15 fixes per cycle
- Touch files outside fix manifest scope

### Rollback Strategy

If regression guard finds new CRITICALs from a cycle's fixes:
1. `git revert HEAD --no-edit`
2. Restart services on reverted code
3. Mark cycle as "reverted" in convergence.json
4. Add causing fixes to do-not-auto-fix blocklist
5. Two consecutive reverts triggers STUCK exit condition

### Build & Restart Between Cycles

1. `npm run dev:stop` + wait
2. `npm run build` (incremental via tsbuildinfo cache)
3. `npm run dev:monitor &`
4. Poll readiness (30s per service, 120s for cross-chain)
5. If build fails: `npm run build:clean`, if still fails: revert + rebuild

### Safety Invariants (checked before commit)

1. `npm run typecheck` exits 0
2. `npm run test:unit` exits 0 (or same failure count as baseline)
3. All 7 services reach READY state
4. No new CRITICAL findings from regression guard
5. Total lines changed < 500 per cycle

### Git Commit Convention

```
autopilot(cycle-N): fix <X> findings (<CRIT>C/<HIGH>H/<MED>M)

Findings fixed:
- SA-003: Replace hardcoded stream name in execution consumer
- EX-007: Add break condition in per-chain gating loop

Deferred: INF-002 (needs deployment coordination)

Session: <SESSION_ID>, Cycle: N/5
```

---

## Convergence Logic

### Exit Conditions (any one triggers exit)

| Condition | Label |
|-----------|-------|
| remaining_fixable == 0 | CONVERGED |
| new_findings == 0 AND fixes_applied == 0 | PLATEAU |
| cycle == 5 | MAX_CYCLES |
| elapsed_time > 110 min | TIME_LIMIT |
| Two consecutive reverted cycles | STUCK |

### Dirty-Domain Agent Selection (Cycles 2-5)

```
dirty_from_fixes   = domains mapped from changed files
dirty_from_new     = domains of NEW findings from regression guard
always_recheck     = [e2e-flow-tracer]

agents_to_dispatch = dirty_from_fixes U dirty_from_new U always_recheck
```

### File-to-Domain Mapping

| File Pattern | Dirty Domains |
|-------------|--------------|
| shared/core/src/redis/ | streams-analyst, e2e-flow-tracer |
| services/execution-engine/ | execution-analyst, performance-profiler, e2e-flow-tracer |
| services/coordinator/ | service-health-monitor, e2e-flow-tracer, dashboard-validator |
| shared/config/ | security-config-auditor, infra-auditor |
| infrastructure/ | infra-auditor |
| dashboard/ | dashboard-validator |
| .env.example | security-config-auditor |
| services/*/src/index.ts | service-health-monitor |
| Any *.test.ts | regression-guard |

---

## Final Report

Generated at `autopilot-session/REPORT.md` and copied to `docs/reports/AUTOPILOT_REPORT_<SESSION_ID>.md`.

Contains:
- Summary table (cycles, findings, fixes, git commits, lines changed)
- Severity progression across cycles
- Fixes applied per cycle with file changes
- Remaining items (not auto-fixable) with reasons
- Blocked items (fix caused regression)
- System state at exit (service health, pipeline flow, key metrics)
- Before/after metrics comparison (baseline vs final)
- Git log of all autopilot commits
- Recommendations for manual follow-up

---

## Relationship to Existing Commands

| Command | Purpose | Duration | Agents |
|---------|---------|----------|--------|
| monitoring.md | Quick pre-deploy validation, GO/NO-GO | ~7 min | 0 (single orchestrator) |
| deep-analysis.md | Static code analysis | ~15 min | 6 parallel |
| extended-deep-analysis.md | Operational code analysis | ~15 min | 6 parallel |
| **autopilot.md** | **Autonomous optimization loop** | **55-85 min** | **12 (10 analysis + 2 fix/validate)** |

All four commands coexist independently. Autopilot is the comprehensive tool; monitoring.md remains for quick sanity checks.
