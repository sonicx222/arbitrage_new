# Pre-Flight — Session Setup & Data Mode

## Dependencies

Redis CLI: Use the Node.js replacement at `scripts/monitoring/redis-cli.cjs` (ioredis-based,
cross-platform). Falls back to native `redis-cli` if available. All `redis-cli` commands in
Phases 2-5 should be executed as: `node scripts/monitoring/redis-cli.cjs <command> [args...]`

For `--scan`: `node scripts/monitoring/redis-cli.cjs --scan --pattern "stream:*"`

```bash
if [ -f "./scripts/monitoring/redis-cli.cjs" ]; then
  echo "Redis CLI: Node.js replacement (scripts/monitoring/redis-cli.cjs)"
elif command -v redis-cli >/dev/null 2>&1; then
  echo "Redis CLI: native redis-cli"
else
  echo "WARNING: No Redis CLI available. Install redis-cli or ensure scripts/monitoring/redis-cli.cjs exists."
  echo "Phases 2-5 (which require Redis inspection) may fail."
fi
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

### Clear findings from previous session

Truncate all finding files to prevent stale data accumulation and duplicate entries.

```bash
> ./monitor-session/findings/static-analysis.jsonl
> ./monitor-session/findings/startup.jsonl
> ./monitor-session/findings/runtime.jsonl
> ./monitor-session/findings/smoke-test.jsonl
> ./monitor-session/findings/report.jsonl
echo "Findings files cleared for session $SESSION_ID"
```

### Session history rotation

Keep the 30 most recent session history files and reports to prevent disk growth.

```bash
HISTORY_COUNT=$(ls ./monitor-session/history/*.json 2>/dev/null | wc -l)
if [ "$HISTORY_COUNT" -gt 30 ]; then
  REMOVED=$(( HISTORY_COUNT - 30 ))
  ls -t ./monitor-session/history/*.json | tail -n +31 | xargs rm -f
  ls -t ./monitor-session/REPORT_*.md 2>/dev/null | tail -n +31 | xargs rm -f
  echo "Rotated session history: kept 30, removed $REMOVED old sessions"
fi
```

## Data Mode Selection

Three modes control how services source price data and handle execution:

| Mode | Prices | Execution | npm Script | Use Case |
|------|--------|-----------|------------|----------|
| `simulation` (default) | Synthetic (ChainSimulator) | Mock | `dev:monitor` | Pipeline flow validation |
| `live` | Real RPC (WebSocket) | Mock | `dev:monitor:live` | Provider connectivity validation |
| `testnet` | Real RPC (WebSocket) | Real (testnet) | `dev:monitor:testnet` | End-to-end testnet testing |

```bash
MONITOR_DATA_MODE="${MONITOR_DATA_MODE:-simulation}"
echo "$MONITOR_DATA_MODE" > ./monitor-session/DATA_MODE
echo "Data mode: $MONITOR_DATA_MODE"
```

## Mode Prerequisites

### `live` or `testnet` mode

```bash
if [ "$MONITOR_DATA_MODE" != "simulation" ]; then
  # Check RPC URLs or provider keys
  RPC_COUNT=$(grep -cE "^[A-Z_]+_RPC_URL=" .env .env.local 2>/dev/null | awk -F: '{s+=$NF}END{print s+0}')
  KEY_COUNT=$(grep -cE "^(DRPC|ANKR|INFURA|ALCHEMY)_API_KEY=" .env .env.local 2>/dev/null | awk -F: '{s+=$NF}END{print s+0}')
  echo "RPC URLs found: $RPC_COUNT | Provider keys found: $KEY_COUNT"
  if [ "$RPC_COUNT" -eq 0 ] && [ "$KEY_COUNT" -eq 0 ]; then
    echo '{"phase":"PRE_FLIGHT","findingId":"PF-001","category":"RPC_CONFIG","severity":"CRITICAL","title":"No RPC URLs or provider keys for live mode","evidence":"grep found 0 RPC URLs and 0 provider keys","expected":"At least one RPC URL or provider API key","actual":"None configured","recommendation":"Set *_RPC_URL or *_API_KEY in .env/.env.local"}' >> ./monitor-session/findings/static-analysis.jsonl
    MONITOR_DATA_MODE="simulation"
    echo "$MONITOR_DATA_MODE" > ./monitor-session/DATA_MODE
    echo "Falling back to simulation mode."
  fi

  # Windows TLS check
  if [ "$(uname -o 2>/dev/null)" = "Msys" ] || [ "$OS" = "Windows_NT" ]; then
    TLS_VAR=$(grep -c "NODE_TLS_REJECT_UNAUTHORIZED=0" .env .env.local 2>/dev/null | awk -F: '{s+=$NF}END{print s+0}')
    if [ "$TLS_VAR" -eq 0 ]; then
      echo "WARNING: Windows detected but NODE_TLS_REJECT_UNAUTHORIZED=0 not set."
      echo "  WebSocket connections to RPC providers may fail with TLS certificate errors."
    fi
  fi
fi
```

### `testnet` only

```bash
if [ "$MONITOR_DATA_MODE" = "testnet" ]; then
  TESTNET_FLAG=$(grep -c "TESTNET_EXECUTION_MODE=true" .env .env.local 2>/dev/null | awk -F: '{s+=$NF}END{print s+0}')
  if [ "$TESTNET_FLAG" -eq 0 ]; then
    echo "WARNING: Testnet mode selected but TESTNET_EXECUTION_MODE=true not found in .env/.env.local."
  fi
fi
```

## Mode Labels for Downstream Phases

- **`[SIM-ONLY]`** — applies only in `simulation` mode
- **`[LIVE-ONLY]`** — applies only in `live` or `testnet` modes
- **`[ALL-MODES]`** — applies regardless of mode

When mode affects severity: alternatives listed inline (e.g., `H [SIM] / I [LIVE]`).

Read mode for downstream:
```bash
MONITOR_DATA_MODE=$(cat ./monitor-session/DATA_MODE)
```
