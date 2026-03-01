# MONITORING.md
# Multi-Agent System Monitoring — Redis Streams + 7 Parallel Services
# Designed for: Claude Code with Opus 4.6 subagents
# Version: 1.0

---

> **HOW TO USE IN CLAUDE CODE**
> Place this file in your project root, then run:
> ```bash
> claude "Run the full multi-agent monitoring session as defined in MONITORING.md"
> ```
> Claude Code will read this file and spawn all subagents automatically.

---

You are the **ORCHESTRATOR agent** (Opus 4.6).

Your job is to coordinate 4 specialist subagents, manage the full monitoring
lifecycle, resolve cross-agent findings, and produce the final report.

You have full bash tool access. All subagents are spawned via the Task tool.
All subagents write findings to structured JSONL files in `./monitor-session/`
which you will merge and synthesize at the end.

---

## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## ORCHESTRATOR — PRE-FLIGHT CHECKLIST
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Execute every step in order. Do not proceed past a step if it fails.

**Step 1 — Create the shared session workspace:**
```bash
mkdir -p ./monitor-session/{logs,findings,streams,config}
SESSION_ID=$(date +%Y%m%d_%H%M%S)
echo $SESSION_ID > ./monitor-session/SESSION_ID
echo "Session workspace initialized: ./monitor-session/ [$SESSION_ID]"
```

**Step 2 — Start Redis with stream support:**
```bash
npm run dev:redis:memory

# Verify Redis is up and streams-capable
redis-cli PING
redis-cli COMMAND INFO XADD XREAD XREADGROUP XPENDING XINFO XACK XLEN XCLAIM
```
If any stream command returns null or errors → **STOP**. Report Redis version
mismatch as [CRITICAL] before proceeding.

**Step 3 — Start all 7 services and capture startup output:**
```bash
npm run dev:all 2>&1 | tee ./monitor-session/logs/startup.log
```
- Wait for all 7 services to emit their ready/listening signal.
- If any service fails to start within 30 seconds → flag as **[CRITICAL]**
  and record which services are missing.
- Identify and record the name of each service from its startup log output.

**Step 4 — Capture baseline Redis stream state BEFORE any load:**
```bash
# Discover all streams
redis-cli --scan --pattern '*' | while read key; do
  type=$(redis-cli TYPE $key)
  if [ "$type" = "stream" ]; then echo $key; fi
done > ./monitor-session/streams/discovered_streams.txt

cat ./monitor-session/streams/discovered_streams.txt
echo "Found $(wc -l < ./monitor-session/streams/discovered_streams.txt) streams"

# Capture full baseline for each stream
for stream in $(cat ./monitor-session/streams/discovered_streams.txt); do
  echo "=== BASELINE: $stream ===" >> ./monitor-session/streams/baseline.json
  redis-cli XINFO STREAM $stream >> ./monitor-session/streams/baseline.json
  redis-cli XINFO GROUPS $stream >> ./monitor-session/streams/baseline.json
  redis-cli XLEN $stream >> ./monitor-session/streams/baseline.json
done

# Capture Redis memory baseline
redis-cli INFO memory >> ./monitor-session/streams/baseline.json
redis-cli INFO stats >> ./monitor-session/streams/baseline.json
```

**Step 5 — Record session timing:**
```bash
echo "START=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> ./monitor-session/session.env
echo "DEADLINE=$(date -u -d '+10 minutes' +%Y-%m-%dT%H:%M:%SZ)" \
  >> ./monitor-session/session.env
cat ./monitor-session/session.env
echo "Monitoring window: 10 minutes from now. Agents launching..."
```

**Step 6 — Spawn all 4 specialist agents simultaneously via the Task tool.**

> ⚠️ **CRITICAL**: Launch ALL 4 agents in parallel. Do not wait for one
> to finish before spawning the next. Use Task() for each agent concurrently.

---

## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## AGENT 1 — LOG WATCHER
## Spawn as: Task("LOG_WATCHER_AGENT", <this section>)
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You are the **LOG WATCHER** agent. Your sole focus is raw process output
from all 7 services. You watch for errors, anomalies, crashes, security
issues, and behavioral inconsistencies. You run for 10 minutes.

**SETUP — attach to all service logs:**
```bash
# Merge all service logs with timestamps and service prefix
tail -f ./monitor-session/logs/*.log 2>/dev/null | \
  awk '{ print strftime("%Y-%m-%dT%H:%M:%S"), $0 }' \
  > ./monitor-session/logs/merged.log &

# Also forward stderr per service if available
# Adapt to your process manager (pm2 logs, nodemon output, etc.)
```

**CLASSIFY every finding as a JSON object:**
```json
{
  "agentId": "LOG_WATCHER",
  "findingId": "LW-001",
  "category": "BUG|ANOMALY|SECURITY|CRASH|RETRY_STORM|MEMORY_LEAK|TIMEOUT|DOC_DRIFT",
  "severity": "CRITICAL|HIGH|MEDIUM|LOW|INFO",
  "service": "<service name>",
  "timestamp": "<ISO8601>",
  "correlationId": "<if present in log line>",
  "streamId": "<Redis message ID if log references one>",
  "evidence": "<exact log line(s) — preserve verbatim>",
  "pattern": "<one-off or repeating? include frequency if repeating>",
  "hypothesis": "<root cause theory>",
  "recommendation": "<specific fix>"
}
```

**PATTERNS TO WATCH FOR — flag immediately:**

Runtime errors and crashes:
- Any line containing: `ERROR`, `FATAL`, `EXCEPTION`, `UNHANDLED`, `UNCAUGHT`,
  `SIGTERM`, `SIGKILL`, `heap`, `OOM`, `ECONNREFUSED`, `ETIMEDOUT`, `ECONNRESET`
- Full stack traces — capture the **complete trace**, not just the first line
- A service going **silent for >30 seconds** (crash without log output)

Behavioral anomalies:
- Identical log lines repeating within 5 seconds → retry storm / infinite loop
- A service logging startup steps multiple times → crash-restart loop
- Timestamps in logs that are out of order or drift significantly between services
- Message IDs appearing in error context → cross-reference with Stream Analyst

Security signals:
- Any log line containing what appears to be a token, secret, password, API key,
  JWT, or private credential emitted in plaintext
- Overly broad error messages that expose internal paths or stack details to output

Quality signals:
- Inconsistent log formats between services (some structured JSON, some printf)
  → flag as `DOC_DRIFT`
- Services logging expected errors at the wrong severity level
  (e.g., a known validation error logged as `FATAL`)
- Services with no log output at all during active periods → flag as `ANOMALY`

**HEARTBEAT — emit every 2 minutes:**
```json
{
  "type": "heartbeat",
  "agent": "LOG_WATCHER",
  "at": "<ISO8601>",
  "linesProcessed": 0,
  "findingCount": 0,
  "servicesActive": ["<list of services still emitting logs>"],
  "servicesSilent": ["<list of services with no output in last 2min>"]
}
```

**OUTPUT:** Append all findings (one JSON object per line) to:
`./monitor-session/findings/log-watcher.jsonl`

**STOP** when `./monitor-session/STOP` file exists.

---

## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## AGENT 2 — REDIS STREAM ANALYST
## Spawn as: Task("REDIS_STREAM_ANALYST", <this section>)
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You are the **REDIS STREAM ANALYST**. You have the most specialized role.
You monitor the health, topology, and integrity of all Redis Streams across
all 7 services. You are the only agent that sees cross-service event flows.

**SETUP — load discovered streams:**
```bash
STREAMS=$(cat ./monitor-session/streams/discovered_streams.txt)
echo "Monitoring streams: $STREAMS"

# For each stream, discover all consumer groups
for stream in $STREAMS; do
  echo "=== GROUPS for $stream ===" >> ./monitor-session/streams/initial_topology.json
  redis-cli XINFO GROUPS $stream >> ./monitor-session/streams/initial_topology.json
done
```

**POLLING LOOP — run every 15 seconds for 10 minutes:**
```bash
while [ ! -f ./monitor-session/STOP ]; do
  TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  for stream in $(cat ./monitor-session/streams/discovered_streams.txt); do

    # Total messages in stream (growing = producer faster than consumer)
    XLEN_VAL=$(redis-cli XLEN $stream)

    # Consumer group info including lag
    redis-cli XINFO GROUPS $stream | \
      awk -v stream="$stream" -v ts="$TIMESTAMP" \
      'BEGIN{print "stream="stream" ts="ts} {print}' \
      >> ./monitor-session/streams/poll_$(date +%H%M%S).txt

    # Pending messages (delivered but not ACKed — potential stuck messages)
    # Get all consumer groups for this stream and check pending per group
    redis-cli XINFO GROUPS $stream | grep "^name" | awk '{print $2}' | \
    while read group; do
      redis-cli XPENDING $stream $group - + 50 \
        >> ./monitor-session/streams/pending_$(date +%H%M%S).txt
    done

  done

  sleep 15
done
```

**CLASSIFY STREAM FINDINGS:**
```json
{
  "agentId": "REDIS_STREAM_ANALYST",
  "findingId": "RSA-001",
  "category": "CONSUMER_LAG|STUCK_MESSAGE|MISSING_ACK|DEAD_CONSUMER|STREAM_GROWING|
               NO_CONSUMER_GROUP|ORPHANED_STREAM|COMPETING_CONSUMERS|DELIVERY_FAILURE|
               SCHEMA_INCONSISTENCY|UNBOUNDED_STREAM|MISSING_MAXLEN",
  "severity": "CRITICAL|HIGH|MEDIUM|LOW|INFO",
  "stream": "<stream name>",
  "consumerGroup": "<group name if applicable>",
  "consumer": "<consumer name if applicable>",
  "timestamp": "<ISO8601>",
  "messageIds": ["<relevant Redis stream IDs>"],
  "metrics": {
    "streamLen": 0,
    "pendingCount": 0,
    "consumerLagMessages": 0,
    "oldestPendingAgeMs": 0,
    "deliveryCount": 0,
    "messagesPerMinute": 0
  },
  "evidence": "<redis-cli output verbatim>",
  "hypothesis": "<root cause>",
  "recommendation": "<specific fix>"
}
```

**AUTO-FLAG AT THESE THRESHOLDS — do not wait for human review:**

| Condition | Category | Severity |
|---|---|---|
| `streamLen` growing for >2 consecutive polls | `STREAM_GROWING` | HIGH |
| Any message pending for >30 seconds | `STUCK_MESSAGE` | HIGH |
| Any message with `delivery-count` > 3 | `DELIVERY_FAILURE` | HIGH |
| Consumer lag > 100 messages | `CONSUMER_LAG` | CRITICAL |
| Consumer group with 0 active consumers | `DEAD_CONSUMER` | CRITICAL |
| Stream with no consumer groups at all | `NO_CONSUMER_GROUP` | MEDIUM |
| `pendingCount` rising but `streamLen` stable | `MISSING_ACK` | HIGH |
| Stream with no `MAXLEN` in any XADD call | `UNBOUNDED_STREAM` | MEDIUM |
| Multiple consumers in same group on same stream | `COMPETING_CONSUMERS` | INFO (verify intent) |

**STREAM TOPOLOGY MAP — update every minute to:**
`./monitor-session/streams/topology_current.txt`

```
Stream: <name>
  Message Rate: ~<n> msgs/min
  Total Length: <n>
  Has MAXLEN cap: YES/NO
  Producers: [inferred from code scan or flag as UNKNOWN]
  Consumer Groups:
    Group <name>:
      Active Consumers: [list with last-active timestamp]
      Lag: <n messages behind>
      Pending (unacked): <n>
      Oldest Pending Message: <age in seconds>
  Schema Sample: <field names from most recent message>
  Status: HEALTHY / DEGRADED / CRITICAL
```

**NOTE ON STREAM IDs:** Redis Stream message IDs have the format
`<milliseconds>-<sequence>`. The first 13 digits are a Unix ms timestamp.
Use this to calculate message age: `age_ms = now_ms - parseInt(id.split('-')[0])`

**OUTPUT:** Append all findings to:
`./monitor-session/findings/stream-analyst.jsonl`

**STOP** when `./monitor-session/STOP` exists.

---

## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## AGENT 3 — CONFIG & DOC AUDITOR
## Spawn as: Task("CONFIG_AUDITOR", <this section>)
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You are the **CONFIG & DOC AUDITOR**. You run primarily at startup and
shutdown, with one runtime check at the 5-minute mark.

---

### PHASE A — Static Analysis (run immediately, ~first 3 minutes)

**Step 1 — Enumerate all config sources:**
```bash
find . \( -name "*.env*" -o -name "*.config.*" -o -name "*.yaml" \
          -o -name "*.yml" -o -name "docker-compose*" \
          -o -name "*.json" -path "*/config/*" \) \
  | grep -v node_modules | grep -v .git \
  | tee ./monitor-session/config/config_files.txt
```

**Step 2 — For each of the 7 services, extract declarations:**
- Which Redis streams it **declares** it publishes to (config / docs / comments)
- Which Redis streams it **declares** it consumes from
- Which consumer group name it uses
- Its declared log level and format
- Port and host bindings
- Expected environment variables

**Step 3 — Cross-reference declarations against actual code:**
```bash
# Find all files that interact with Redis streams
grep -r "XADD\|xadd\|xReadGroup\|XREADGROUP\|xread\|XREAD\|createConsumerGroup" \
  --include="*.ts" --include="*.js" -l \
  | grep -v node_modules \
  | tee ./monitor-session/config/stream_files.txt

# Extract all stream name strings used in code
grep -r "XADD\|xadd\|xReadGroup\|XREADGROUP" \
  --include="*.ts" --include="*.js" -h \
  | grep -v node_modules \
  | grep -oE '"[a-z:_\-]+"' | sort | uniq \
  | tee ./monitor-session/config/code_stream_names.txt

# Extract stream names from docs/README
grep -ri "stream\|queue\|channel\|topic" docs/ README* 2>/dev/null \
  | grep -v node_modules \
  | tee ./monitor-session/config/doc_stream_names.txt

# Compare: what's in docs vs what's in code
echo "=== Streams in code but NOT in docs ===" \
  >> ./monitor-session/config/drift_analysis.txt
diff ./monitor-session/config/doc_stream_names.txt \
     ./monitor-session/config/code_stream_names.txt \
  >> ./monitor-session/config/drift_analysis.txt
```

**Step 4 — Consumer group name consistency check:**
```bash
# Extract consumer group names from code
grep -r "createConsumerGroup\|XREADGROUP\|xReadGroup" \
  --include="*.ts" --include="*.js" -h \
  | grep -oE '"[a-z:_\-]+"' | sort | uniq \
  | tee ./monitor-session/config/code_group_names.txt

# Compare against what Redis actually has
redis-cli --scan --pattern '*' | while read key; do
  if [ "$(redis-cli TYPE $key)" = "stream" ]; then
    redis-cli XINFO GROUPS $key | grep "^name" | awk '{print $2}'
  fi
done | sort | uniq > ./monitor-session/config/redis_group_names.txt

diff ./monitor-session/config/code_group_names.txt \
     ./monitor-session/config/redis_group_names.txt
```
→ Any mismatch in group names = **CONFIG_DRIFT CRITICAL**

**Step 5 — Schema documentation check:**
- Does each stream have a documented message schema somewhere?
- Does the actual message payload structure in code match that schema?
- Are schema versions tracked anywhere?

**Step 6 — Environment variable audit:**
```bash
# Find all env var references across services
grep -r "process\.env\." --include="*.ts" --include="*.js" -h \
  | grep -v node_modules \
  | grep -oE 'process\.env\.[A-Z_]+' | sort | uniq \
  > ./monitor-session/config/required_env_vars.txt

# Check which ones are actually set
while read envvar; do
  varname=$(echo $envvar | sed 's/process\.env\.//')
  if [ -z "${!varname}" ]; then
    echo "MISSING: $varname" >> ./monitor-session/config/env_audit.txt
  else
    echo "SET: $varname" >> ./monitor-session/config/env_audit.txt
  fi
done < ./monitor-session/config/required_env_vars.txt
```

---

### PHASE B — Runtime Check (at the 5-minute mark)

```bash
# Wait ~5 minutes, then run
sleep 300

# Check if any new streams appeared since baseline
redis-cli --scan --pattern '*' | while read key; do
  if [ "$(redis-cli TYPE $key)" = "stream" ]; then echo $key; fi
done | sort > ./monitor-session/streams/streams_5min.txt

diff ./monitor-session/streams/discovered_streams.txt \
     ./monitor-session/streams/streams_5min.txt \
  > ./monitor-session/streams/new_streams.diff

if [ -s ./monitor-session/streams/new_streams.diff ]; then
  echo "WARNING: New streams appeared after startup!" \
    >> ./monitor-session/findings/config-auditor.jsonl
fi

# Re-check consumer group names match config
for stream in $(cat ./monitor-session/streams/discovered_streams.txt); do
  redis-cli XINFO GROUPS $stream
done > ./monitor-session/config/runtime_groups.txt
```

**CLASSIFY FINDINGS:**
```json
{
  "agentId": "CONFIG_AUDITOR",
  "findingId": "CA-001",
  "category": "CONFIG_DRIFT|DOC_DRIFT|SCHEMA_DRIFT|NAMING_INCONSISTENCY|
               MISSING_SCHEMA|ENV_MISMATCH|PORT_CONFLICT|VERSION_MISMATCH|
               ROGUE_STREAM|MISSING_ENV_VAR|GROUP_NAME_MISMATCH",
  "severity": "CRITICAL|HIGH|MEDIUM|LOW|INFO",
  "service": "<service name or 'cross-service'>",
  "affectedFiles": ["<file paths>"],
  "expected": "<what config/docs/env declares>",
  "actual": "<what code/runtime does>",
  "evidence": "<file paths, line numbers, CLI output>",
  "recommendation": "<specific fix with file path>"
}
```

**OUTPUT:** Append all findings to:
`./monitor-session/findings/config-auditor.jsonl`

**STOP** when `./monitor-session/STOP` exists.

---

## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## AGENT 4 — ENHANCEMENT SCOUT
## Spawn as: Task("ENHANCEMENT_SCOUT", <this section>)
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You are the **ENHANCEMENT SCOUT**. You do NOT produce bug reports — that is
the Log Watcher's job. You identify architectural anti-patterns, missing
resilience, observability gaps, and performance improvements. High signal
only — no noise.

You run two passes:

---

### PASS 1 — Static Code Analysis (minutes 0–5)

**Redis Streams anti-patterns:**
```bash
# 1. Missing MAXLEN — unbounded streams are a memory time bomb
echo "=== XADD without MAXLEN ===" >> ./monitor-session/findings/es-static.txt
grep -rn "XADD\|xadd" --include="*.ts" --include="*.js" \
  | grep -v node_modules | grep -iv "MAXLEN\|maxlen" \
  >> ./monitor-session/findings/es-static.txt

# 2. Using XREAD instead of XREADGROUP — no consumer groups = no ACK, no replay
echo "=== XREAD without consumer group ===" >> ./monitor-session/findings/es-static.txt
grep -rn "xread[^G]\|XREAD[^G]" --include="*.ts" --include="*.js" \
  | grep -v node_modules \
  >> ./monitor-session/findings/es-static.txt

# 3. Missing XACK after processing — messages stay pending forever
echo "=== XREADGROUP without XACK ===" >> ./monitor-session/findings/es-static.txt
grep -rln "xReadGroup\|XREADGROUP" --include="*.ts" --include="*.js" \
  | grep -v node_modules \
  | xargs grep -L "xack\|XACK" \
  >> ./monitor-session/findings/es-static.txt

# 4. Hardcoded stream names — should come from config/env
echo "=== Hardcoded stream names ===" >> ./monitor-session/findings/es-static.txt
grep -rn "XADD\|XREADGROUP\|xadd\|xReadGroup" --include="*.ts" --include="*.js" \
  | grep -v node_modules \
  | grep -v "process\.env\|config\.\|CONFIG\." \
  >> ./monitor-session/findings/es-static.txt

# 5. No dead-letter / max-delivery handling — failed messages loop forever
echo "=== Missing DLQ/max delivery handling ===" >> ./monitor-session/findings/es-static.txt
grep -rln "xReadGroup\|XREADGROUP" --include="*.ts" --include="*.js" \
  | grep -v node_modules \
  | xargs grep -L "delivery\|maxDelivery\|dlq\|dead.letter\|deadLetter" \
  >> ./monitor-session/findings/es-static.txt

# 6. Polling instead of blocking reads — unnecessary CPU burn
echo "=== Polling instead of blocking reads ===" >> ./monitor-session/findings/es-static.txt
grep -rn "XREAD\|xread" --include="*.ts" --include="*.js" \
  | grep -v node_modules \
  | grep -iv "BLOCK\|block" \
  >> ./monitor-session/findings/es-static.txt

# 7. Single-message processing instead of batching
echo "=== Processing COUNT 1 (not batching) ===" >> ./monitor-session/findings/es-static.txt
grep -rn "COUNT 1\b\|count.*:\s*1\b" --include="*.ts" --include="*.js" \
  | grep -v node_modules \
  >> ./monitor-session/findings/es-static.txt
```

**Observability gaps:**
```bash
# 8. Using console.log instead of structured logger
echo "=== console.log usage ===" >> ./monitor-session/findings/es-static.txt
grep -rln "console\.log\|console\.error\|console\.warn" \
  --include="*.ts" --include="*.js" \
  | grep -v node_modules \
  >> ./monitor-session/findings/es-static.txt

# 9. Missing correlation ID in event payloads
echo "=== XADD without correlationId ===" >> ./monitor-session/findings/es-static.txt
grep -rn "XADD\|xadd" --include="*.ts" --include="*.js" \
  | grep -v node_modules \
  | grep -iv "correlationId\|traceId\|requestId\|correlation_id" \
  >> ./monitor-session/findings/es-static.txt

# 10. Silent catch blocks — errors swallowed with no logging
echo "=== Silent catch blocks ===" >> ./monitor-session/findings/es-static.txt
grep -rn "} catch" --include="*.ts" --include="*.js" -A 3 \
  | grep -v node_modules \
  | grep -B1 "^\s*}" \
  >> ./monitor-session/findings/es-static.txt

# 11. KEYS * usage — O(N) scan, blocks Redis in production
echo "=== KEYS * usage (dangerous) ===" >> ./monitor-session/findings/es-static.txt
grep -rn "KEYS \*\|\.keys(\s*['\"]\\*['\"])" \
  --include="*.ts" --include="*.js" \
  | grep -v node_modules \
  >> ./monitor-session/findings/es-static.txt

# 12. No circuit breaker on producers
echo "=== Producers without circuit breaker ===" >> ./monitor-session/findings/es-static.txt
grep -rln "XADD\|xadd" --include="*.ts" --include="*.js" \
  | grep -v node_modules \
  | xargs grep -L "circuit\|breaker\|backoff\|retry.*delay\|exponential" \
  >> ./monitor-session/findings/es-static.txt
```

---

### PASS 2 — Cross-Agent Pattern Analysis (minutes 5–10)

Watch `./monitor-session/findings/` for findings from other agents.
Every 60 seconds, scan for patterns across all finding files:

```bash
while [ ! -f ./monitor-session/STOP ]; do
  sleep 60

  # Look for findings on the same stream from multiple agents
  # A timeout in Log Watcher + consumer lag in Stream Analyst on the same stream
  # = backpressure problem, not a timeout problem
  # Document the root cause synthesis, not just the symptoms
  
  cat ./monitor-session/findings/*.jsonl 2>/dev/null | \
    jq -s 'group_by(.stream // .service) | 
           map(select(length > 1)) | 
           map({entity: .[0].stream // .[0].service, finding_count: length, 
                agents: [.[].agentId] | unique})' \
    > ./monitor-session/findings/cross-agent-clusters.json
done
```

For each cluster of related findings from different agents, write a synthesis
finding that identifies the **underlying architectural pattern**, not just the
individual symptoms.

**Example of good synthesis:**
> Log Watcher found 3 timeout errors on service-payments at T+2:14.
> Stream Analyst found CONSUMER_LAG of 340 messages on `payments-stream` at T+2:00.
> Root cause: the consumer is overloaded — timeouts are a symptom, not the cause.
> The fix is producer-side backpressure or horizontal scaling of the consumer,
> not increasing the timeout value.

**CLASSIFY FINDINGS:**
```json
{
  "agentId": "ENHANCEMENT_SCOUT",
  "findingId": "ES-001",
  "category": "STREAM_ANTI_PATTERN|OBSERVABILITY_GAP|PERFORMANCE|RESILIENCE|
               ARCHITECTURE|DX_IMPROVEMENT|CROSS_AGENT_SYNTHESIS",
  "priority": "P0_CRITICAL|P1_HIGH|P2_MEDIUM|P3_LOW",
  "effort": "HOURS_2_4|HOURS_4_8|DAYS_1_2|SPRINT",
  "impact": "HIGH|MEDIUM|LOW",
  "affectedServices": ["<service names>"],
  "affectedStreams": ["<stream names>"],
  "relatedFindings": ["<LW-001>", "<RSA-002>"],
  "pattern": "<name of the anti-pattern or enhancement>",
  "evidence": "<code location(s) or runtime observation>",
  "recommendation": "<specific, actionable change>",
  "codeSnippetBefore": "<problematic pattern if applicable>",
  "codeSnippetAfter": "<corrected pattern if applicable>"
}
```

**OUTPUT:** Append all findings to:
`./monitor-session/findings/enhancement-scout.jsonl`

**STOP** when `./monitor-session/STOP` exists.

---

## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## ORCHESTRATOR — ACTIVE MONITORING (minutes 0–10)
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

While the 4 agents run, you maintain the session and watch for emergencies.

**Every 2 minutes, run these health checks:**

```bash
# 1. Verify all 4 agents are still writing (should have modified files < 3min ago)
echo "=== Agent health check ===" 
find ./monitor-session/findings/ -name "*.jsonl" \
  -printf "%T@ %f\n" | sort -n | while read ts file; do
  age=$(( $(date +%s) - ${ts%.*} ))
  if [ $age -gt 180 ]; then
    echo "WARNING: $file has not been updated in ${age}s — agent may be stuck"
  else
    echo "OK: $file (${age}s ago)"
  fi
done

# 2. Check for CRITICAL findings requiring immediate awareness
CRITICALS=$(grep -c '"severity":"CRITICAL"' \
  ./monitor-session/findings/*.jsonl 2>/dev/null || echo 0)
echo "Current CRITICAL finding count: $CRITICALS"

# 3. Check Redis is still responsive
redis-cli PING || echo "ALERT: Redis not responding!"

# 4. Verify all 7 service processes are still alive
NODECOUNT=$(ps aux | grep node | grep -v grep | wc -l)
echo "Node processes running: $NODECOUNT"

# 5. Spot-check consumer lag on all streams
for stream in $(cat ./monitor-session/streams/discovered_streams.txt 2>/dev/null); do
  LEN=$(redis-cli XLEN $stream)
  echo "Stream $stream: $LEN messages"
done
```

**If an agent stops writing for >3 minutes:** Restart it with its original
prompt. Log the restart event to `./monitor-session/agent-restarts.log`.

**If a CRITICAL finding appears:** Log it to
`./monitor-session/critical-alerts.log` but **do NOT stop monitoring early**.
All agents must complete the full 10-minute window to capture the full picture.

---

## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## ORCHESTRATOR — SHUTDOWN SEQUENCE (at exactly 10 minutes)
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Step 1 — Signal all agents to stop:**
```bash
touch ./monitor-session/STOP
echo "STOP signal sent at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
sleep 10  # give agents time to flush final findings
```

**Step 2 — Capture final Redis stream state:**
```bash
for stream in $(cat ./monitor-session/streams/discovered_streams.txt); do
  echo "=== FINAL STATE: $stream ===" \
    >> ./monitor-session/streams/final_state.json
  redis-cli XINFO STREAM $stream >> ./monitor-session/streams/final_state.json
  redis-cli XINFO GROUPS $stream >> ./monitor-session/streams/final_state.json

  # Get all remaining pending messages
  redis-cli XINFO GROUPS $stream | grep "^name" | awk '{print $2}' | \
  while read group; do
    PENDING=$(redis-cli XPENDING $stream $group - + 100)
    echo "  Pending in $group: $PENDING" \
      >> ./monitor-session/streams/final_state.json
  done
done

# Compare final vs baseline to measure stream growth during session
diff ./monitor-session/streams/baseline.json \
     ./monitor-session/streams/final_state.json \
  > ./monitor-session/streams/session_drift.diff

echo "Unresolved pending messages at shutdown:"
grep -i "pending" ./monitor-session/streams/final_state.json | grep -v "^0"
```

**Step 3 — Gracefully stop all services:**
```bash
npm run dev:stop 2>&1 | tee ./monitor-session/logs/shutdown.log
sleep 15  # allow services to drain in-flight messages

# Verify clean shutdown
echo "=== Remaining Redis connections after shutdown ==="
redis-cli CLIENT LIST
```

**Step 4 — Stop Redis:**
```bash
redis-cli BGSAVE  # flush data for inspection if needed
npm run dev:redis:stop
```

**Step 5 — Verify no zombie processes:**
```bash
ZOMBIES=$(ps aux | grep node | grep -v grep | wc -l)
if [ "$ZOMBIES" -gt 0 ]; then
  echo "WARNING: $ZOMBIES node processes still running after shutdown"
  ps aux | grep node | grep -v grep
else
  echo "Clean shutdown confirmed — no zombie processes"
fi

# Verify Redis port is free
lsof -i :6379 && echo "WARNING: Redis port still in use" || echo "Port 6379 free"
```

---

## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## ORCHESTRATOR — FINAL REPORT SYNTHESIS
## ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Merge and sort all agent findings:**
```bash
SESSION_ID=$(cat ./monitor-session/SESSION_ID)

# Merge all JSONL files into one sorted JSON array
cat ./monitor-session/findings/*.jsonl 2>/dev/null | \
  jq -s 'sort_by(.severity, .timestamp)' \
  > ./monitor-session/all-findings.json

# Summary counts
echo "=== FINDING COUNTS BY SEVERITY ==="
cat ./monitor-session/all-findings.json | \
  jq 'group_by(.severity) | 
      map({severity: .[0].severity, count: length}) | 
      sort_by(.severity)'

echo "=== FINDING COUNTS BY CATEGORY ==="
cat ./monitor-session/all-findings.json | \
  jq 'group_by(.category) | 
      map({category: .[0].category, count: length}) | 
      sort_by(-.count)'

echo "=== FINDING COUNTS BY SERVICE ==="
cat ./monitor-session/all-findings.json | \
  jq 'group_by(.service // "unknown") | 
      map({service: .[0].service, count: length}) | 
      sort_by(-.count)'
```

**Write the final report to:**
`./monitor-session/REPORT_<SESSION_ID>.md`

---

The report must contain all of the following sections:

### 1. Executive Dashboard

| Metric | Value |
|---|---|
| Session ID | `<SESSION_ID>` |
| Session duration | 10 minutes |
| Services monitored | 7 |
| Streams discovered | `<n>` |
| Total findings | `<n>` |
| CRITICAL findings | `<n>` |
| HIGH findings | `<n>` |
| MEDIUM findings | `<n>` |
| Unacked messages at shutdown | `<n>` |
| Streams with consumer lag | `<n>` |
| Config/Doc drifts found | `<n>` |
| Overall system health | 🔴 CRITICAL / 🟡 DEGRADED / 🟢 HEALTHY |

---

### 2. Critical Findings (immediate action required)

For every CRITICAL finding — provide full detail from the JSON, then add your
Orchestrator-level cross-agent analysis:

- Does this finding connect to findings from other agents?
- If Log Watcher LW-xx and Stream Analyst RSA-xx describe the same root cause
  from different angles → explain the full causal chain
- What is the blast radius if this is not fixed?

---

### 3. Redis Streams Health Map

For every stream discovered, produce a final health table:

| Stream | Length | Pending | Lag | Oldest Pending | Status | Verdict |
|---|---|---|---|---|---|---|
| `stream-name` | 0 | 0 | 0 | 0s | HEALTHY | ✅ |

Flag any stream that **degraded** during the session compared to the baseline
snapshot taken at startup.

---

### 4. Cross-Service Event Flow Reconstruction

Using correlation IDs found in logs + stream message IDs from Stream Analyst,
reconstruct the event flows that occurred during the session.

For each traceable flow:
```
[T+0:00] service-A published → stream:payments (msg: 1234567890123-0)
[T+0:01] service-B consumed  → stream:payments (correlationId: abc-123, lag: 1s)
[T+0:02] service-B published → stream:notifications (correlationId: abc-123)
[T+0:02] service-C consumed  → stream:notifications ✅ ACKed
```

Flag any flow where:
- A message was published but no consumption was logged
- A consumption was logged but no ACK followed
- A correlationId appears in a producer but never in any consumer log

---

### 5. Config & Documentation Drift Registry

Full table of all drifts found by Config Auditor:

| Type | Service | Expected | Actual | Source of Truth | Risk |
|---|---|---|---|---|---|
| CONFIG_DRIFT | service-x | group: `payments-v2` | group: `payments` | config.yml L14 | HIGH |

---

### 6. Enhancement Roadmap

Organized by priority from Enhancement Scout:

**P0 — Fix before next deploy:**
(list with evidence, effort, and code snippet if available)

**P1 — Fix this sprint:**
(list with justification and impact)

**P2 — Backlog (prioritized):**
(list with effort estimates)

---

### 7. Logging & Observability Gap Analysis

Based on what you *couldn't* see during this session, document every gap
that reduced monitoring fidelity. For each gap:

- **What was invisible:** e.g., no way to trace a message from service-A to service-C
- **Why it matters:** e.g., when service-C fails, there's no way to know which upstream event caused it
- **Exact code change required:** provide file path and the specific instrumentation to add

**Priority instrumentation to add before the next monitoring session:**

**A. Correlation & Trace IDs (P0 — eliminates biggest blind spot)**

Every Redis Stream event payload must carry:
```json
{
  "correlationId": "<UUID generated at the request/event boundary>",
  "traceId": "<distributed trace ID>",
  "spanId": "<current span>",
  "originService": "<name of publishing service>",
  "publishedAt": "<ISO8601 timestamp>",
  "schemaVersion": "1.0"
}
```

Implement a shared `createEventEnvelope(channel, payload, ctx)` utility that
enforces this schema and prevents bare `XADD` calls without trace context.

**B. Structured JSON Logging (P1 — makes logs machine-parseable)**

All services must emit logs in this format:
```json
{
  "level": "info|warn|error",
  "timestamp": "<ISO8601 with milliseconds>",
  "service": "<service name>",
  "correlationId": "<from context>",
  "traceId": "<from context>",
  "event": "<machine-readable event name>",
  "message": "<human-readable description>",
  "durationMs": 0,
  "error": null
}
```

Identify which services currently use `console.log` or unstructured logging
and list the exact files that need updating.

**C. Redis Stream Lifecycle Events (P1 — full event audit trail)**

Add a shared Redis wrapper that auto-instruments every operation:

On publish → log:
```json
{ "event": "redis.publish", "stream": "<name>", "correlationId": "<id>",
  "messageId": "<returned stream ID>", "payloadFields": ["<field names>"],
  "publishedAt": "<ISO8601>" }
```

On consume → log:
```json
{ "event": "redis.consume", "stream": "<name>", "correlationId": "<id>",
  "messageId": "<stream ID>", "consumer": "<service name>",
  "receivedAt": "<ISO8601>", "lagMs": "<receivedAt - publishedAt>" }
```

On ACK → log:
```json
{ "event": "redis.ack", "stream": "<name>", "correlationId": "<id>",
  "messageId": "<stream ID>", "processingDurationMs": 0 }
```

On failure → log:
```json
{ "event": "redis.failed", "stream": "<name>", "correlationId": "<id>",
  "messageId": "<stream ID>", "error": "<message>",
  "deliveryCount": 0, "willRetry": true }
```

**D. Consumer Lag Health Reporting (P2 — backpressure early warning)**

Each consumer service should emit a health log every 60 seconds:
```json
{ "event": "redis.channelHealth", "stream": "<name>",
  "consumerGroup": "<name>", "messagesConsumedLastMinute": 0,
  "avgLagMs": 0, "maxLagMs": 0, "pendingCount": 0,
  "errorsLastMinute": 0 }
```

Alert threshold: lag consistently >500ms → investigate consumer capacity.

**E. Startup & Shutdown Events (P2 — clean operational baseline)**

Every service must emit on start:
```json
{ "event": "service.started", "service": "<name>", "port": 0,
  "subscribedStreams": ["<stream names>"], "publishedStreams": ["<stream names>"],
  "consumerGroups": ["<group names>"], "timestamp": "<ISO8601>" }
```

Every service must emit on graceful shutdown:
```json
{ "event": "service.shutdown", "service": "<name>",
  "reason": "SIGTERM|manual|error", "pendingMessages": 0,
  "timestamp": "<ISO8601>" }
```

**F. Cross-Service Timeline Reconstruction Recipe**

Once A–E are implemented, use this to reconstruct any event trace:

```bash
# Reconstruct full trace for a correlationId across all service logs
CORRELATION_ID="your-id-here"

cat ./monitor-session/logs/*.log | \
  jq -R 'try fromjson' | \
  jq -s --arg id "$CORRELATION_ID" \
    '[.[] | select(.correlationId == $id)] | sort_by(.timestamp)' | \
  jq '.[] | "\(.timestamp) [\(.service)] \(.event): \(.message)"' -r
```

---

### 8. Next Session Improvements

Before running this monitoring session again, implement these changes
(in priority order) to get higher fidelity findings next time:

List each improvement with: what gap it closes, which agent benefits most,
and estimated implementation time.

---

*Report generated by MONITORING.md v1.0*
*Session: `<SESSION_ID>`*
*Completed: `<ISO8601 timestamp>`*
