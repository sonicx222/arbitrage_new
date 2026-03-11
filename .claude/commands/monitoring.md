# Pre-Deploy Validation — Orchestrator Hub
# Version: 4.1
# Modular pipeline: this hub dispatches 5 phases via on-demand module loading.
# Total checks: 24 static + 42 runtime + 12 smoke test steps = 78 validation points.
#
# Quick mode: set MONITOR_QUICK_MODE=true to run only Pre-Flight + Phase 1.
# No services needed. ~60 seconds. Useful for pre-commit validation.

## Architecture

```
monitoring.md (this file, ~100 lines)
monitoring/config.json          — Externalized thresholds, go/no-go rules
monitoring/00-inventory-generator.md — Auto-generates inventory.json from source
monitoring/01-preflight.md      — Session setup, data mode selection
monitoring/02-static-analysis.md — Phase 1: 24 static checks (1A-1Y)
monitoring/03-startup.md        — Phase 2: Redis + services + readiness
monitoring/04-runtime.md        — Phase 3: 42 runtime checks (3A-3AR)
monitoring/05-smoke-test.md     — Phase 4: 12 smoke test steps (4A-4L)
monitoring/06-report.md         — Phase 5: shutdown, report, regression
```

## Finding Format

All phases emit JSONL findings to `./monitor-session/findings/<phase>.jsonl`:
```json
{"phase":"<PHASE>","findingId":"<PREFIX>-NNN","category":"...","severity":"CRITICAL|HIGH|MEDIUM|LOW|INFO","evidence":"..."}
```

Severity codes: C=CRITICAL, H=HIGH, M=MEDIUM, L=LOW, I=INFO.
Compact notation: `condition → SEV:CATEGORY` (e.g., `→ H:STREAM_DECLARATION`).

## Execution Flow

### Pre-Flight (no services needed)

1. Read and execute `monitoring/00-inventory-generator.md`
   - Reads 6 source files, generates `./monitor-session/config/inventory.json`
   - All downstream phases reference inventory.json (zero hardcoded values)

2. Read and execute `monitoring/01-preflight.md`
   - Creates session workspace under `./monitor-session/`
   - Selects data mode: `simulation` (default) | `live` | `testnet`
   - Validates mode prerequisites (RPC URLs, TLS, testnet flags)

### Phase 1 — Static Analysis (~60 seconds)

3. Read and execute `monitoring/02-static-analysis.md`
   - 24 checks (1A-1Y) against source code (no running services needed)
   - Supports incremental mode: skip checks on unchanged files
   - Findings → `./monitor-session/findings/static-analysis.jsonl`

### Quick Mode Exit Point

```bash
MONITOR_QUICK_MODE="${MONITOR_QUICK_MODE:-false}"
if [ "$MONITOR_QUICK_MODE" = "true" ]; then
  echo "QUICK MODE: Skipping Phases 2-4. Generating static-only report."
  # Jump directly to Phase 5 (report) with static-analysis data only
fi
```

If `MONITOR_QUICK_MODE=true`, skip steps 4-6 and jump to step 7 (Phase 5 — Report).
The report will contain only Phase 1 findings with a `[QUICK]` annotation.

### Phase 2 — Startup & Readiness (~60 seconds)

4. Read and execute `monitoring/03-startup.md`
   - Starts Redis, starts services (mode-conditional npm script)
   - Polls readiness endpoints with mode-specific timeouts from config.json
   - Captures baseline stream state, checks endpoint consistency
   - Findings → `./monitor-session/findings/startup.jsonl`

### Phase 3 — Runtime Validation (~120 seconds)

5. Read and execute `monitoring/04-runtime.md`
   - 42 checks across 9 subsections (3A-3AR)
   - Uses endpoint cache (O-01) and Redis batching (O-02) for performance
   - Placeholder metrics get fast-path INFO (no curl needed)
   - Findings → `./monitor-session/findings/runtime.jsonl`

### Phase 4 — Pipeline Smoke Test (~90 seconds)

6. Read and execute `monitoring/05-smoke-test.md`
   - 12 steps (4A-4L): stream flow, trace propagation, DLQ, detection, risk
   - Mode-conditional expectations (SIM: all streams must grow; LIVE: price-updates only)
   - Findings → `./monitor-session/findings/smoke-test.jsonl`

### Phase 5 — Shutdown & Report (~30 seconds)

7. Read and execute `monitoring/06-report.md`
   - Captures final state, stops services and Redis
   - GO/NO-GO decision per config.json rules
   - Regression tracking against previous session
   - Generates `./monitor-session/REPORT_<SESSION_ID>.md`

## Quick Reference

| Phase | Module | Checks | Time | Key Output |
|-------|--------|--------|------|------------|
| Pre-flight | 00 + 01 | — | 10s | inventory.json, DATA_MODE |
| 1. Static | 02 | 24 | 60s | static-analysis.jsonl |
| *Quick exit* | — | — | — | *If MONITOR_QUICK_MODE=true, skip to Phase 5* |
| 2. Startup | 03 | 5 steps | 60s | startup.jsonl |
| 3. Runtime | 04 | 42 | 120s | runtime.jsonl |
| 4. Smoke | 05 | 12 steps | 90s | smoke-test.jsonl |
| 5. Report | 06 | 6 steps | 30s | REPORT_<id>.md |

## Dependencies

- `redis-cli` must be on PATH (checked in preflight)
- `node` for JSON parsing (replaces `jq` — not available on all platforms)
- No `bc` or GNU `timeout` required (Windows Git Bash compatible)

## Configuration

All thresholds in `monitoring/config.json` (v4.1). Key settings:
- `goNoGo.anyCritical: "NO-GO"` — any CRITICAL finding blocks deployment
- `goNoGo.maxHighForGo: 3` — more than 3 HIGH findings blocks deployment
- `severityOverrides` — per-mode severity downgrades for known structural findings
- `readinessTimeouts` — mode-specific service startup timeouts
- `perChainStalenessThresholds` — per-chain price update freshness (seconds)
- `placeholderMetrics` — metrics not yet implemented (skip curl, emit INFO)
