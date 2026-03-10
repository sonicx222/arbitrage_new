# Inventory Generator — Pre-Flight Module

Reads source code to auto-generate `./monitor-session/config/inventory.json`.
All downstream modules reference this file instead of hardcoded values.
Eliminates all coupling points between monitoring checks and source code.

---

## Step 1: Stream Names

Read `shared/types/src/events.ts`. Extract all values from the `RedisStreams` const
(object starting at ~line 19). Each value is a stream name string like `stream:price-updates`.
Collect all key-value pairs into an array.

## Step 2: MAXLEN Values

Read `shared/core/src/redis/streams.ts`. Find `static readonly STREAM_MAX_LENGTHS`
(at ~line 441). Extract the mapping of stream constant reference to MAXLEN number.
Match each entry back to the stream name from Step 1.

## Step 3: Stream Producer & Consumer Mapping

For each stream from Step 1, determine producers and consumer groups:

**Producers** — Grep for each stream's `RedisStreams.CONSTANT_NAME` in `xadd|xaddWithLimit|publish`
calls under `services/` and `shared/` (exclude node_modules, tests).

**Consumer groups** — Use the consumer group data from Step 6 to map groups to streams.

For streams marked `[IDLE]` or `[ON-DEMAND]` in the comments, note the status.

## Step 4: Service Ports

Read `shared/constants/service-ports.json`. Parse the JSON directly:
- `services` object → each key is a service name, value is the port
- `partitions` object → partition ID to port mapping
- The 7 `dev:all` services: coordinator (3000), partition-asia-fast (3001),
  partition-l2-turbo (3002), partition-high-value (3003), partition-solana (3004),
  execution-engine (3005), cross-chain-detector (3006)

Map ready endpoints:
- Coordinator: `/api/health/ready`
- All others: `/ready`

## Step 5: Partition Config

Read `shared/config/src/partitions.ts`. Extract the `PARTITIONS` array (~line 227).
For each partition, capture:
- `partitionId` (e.g., `asia-fast`)
- `chains[]` (e.g., `['bsc', 'polygon', 'avalanche', 'fantom']`)
- Port from `service-ports.json` partitions object

## Step 6: Consumer Groups

Grep for consumer group names in `services/` and `shared/core/src/`:
- Patterns: `consumerGroup|groupName|createConsumerGroup|XREADGROUP GROUP`
- Exclude: `node_modules`, test files, `__tests__`

Extract unique group names and their associated streams. Expected groups (7):

| Group | Service | Discovery Pattern |
|-------|---------|-------------------|
| `coordinator-group` | Coordinator | `groupName: 'coordinator-group'` |
| `cross-chain-detector-group` | Cross-Chain | `groupName: 'cross-chain-detector-group'` |
| `execution-engine-group` | Execution Engine | `groupName: 'execution-engine-group'` |
| `mempool-detector-group` | Mempool Detector | `groupName: 'mempool-detector-group'` |
| `orderflow-pipeline` | Coordinator (orderflow) | `groupName: 'orderflow-pipeline'` |
| `self-healing-manager` | Self-Healing Manager | `groupName: 'self-healing-manager'` |
| `failover-{serviceName}` | Coordinator (failover) | Dynamic: `CrossRegionHealthManager` |

## Step 7: Feature Flags

Read `shared/config/src/feature-flags.ts`. Extract all `process.env.FEATURE_*`
patterns. For each, record:
- The env var name (e.g., `FEATURE_FLASH_LOAN_AGGREGATOR`)
- The comparison pattern (`=== 'true'` for opt-in, `!== 'false'` for opt-out)

## Step 8: Assemble and Validate

Write `./monitor-session/config/inventory.json`:

```json
{
  "generated": "<ISO8601 timestamp>",
  "streams": [
    {
      "name": "stream:price-updates",
      "maxLen": 100000,
      "producers": ["P1-P4"],
      "groups": ["coordinator-group", "cross-chain-detector-group"],
      "status": "ACTIVE"
    }
  ],
  "services": [
    { "name": "coordinator", "port": 3000, "readyEndpoint": "/api/health/ready" },
    { "name": "partition-asia-fast", "port": 3001, "readyEndpoint": "/ready" },
    { "name": "partition-l2-turbo", "port": 3002, "readyEndpoint": "/ready" },
    { "name": "partition-high-value", "port": 3003, "readyEndpoint": "/ready" },
    { "name": "partition-solana", "port": 3004, "readyEndpoint": "/ready" },
    { "name": "execution-engine", "port": 3005, "readyEndpoint": "/ready" },
    { "name": "cross-chain-detector", "port": 3006, "readyEndpoint": "/ready" }
  ],
  "partitions": [
    { "id": "asia-fast", "port": 3001, "chains": ["bsc", "polygon", "avalanche", "fantom"] },
    { "id": "l2-turbo", "port": 3002, "chains": ["arbitrum", "optimism", "base", "scroll", "blast", "mantle", "mode"] },
    { "id": "high-value", "port": 3003, "chains": ["ethereum", "zksync", "linea"] },
    { "id": "solana-native", "port": 3004, "chains": ["solana"] }
  ],
  "consumerGroups": [
    { "name": "coordinator-group", "streams": ["health", "opportunities", "whale-alerts", "swap-events", "volume-aggregates", "price-updates", "execution-results", "dead-letter-queue", "forwarding-dlq"] },
    { "name": "cross-chain-detector-group", "streams": ["price-updates", "whale-alerts", "pending-opportunities"] },
    { "name": "execution-engine-group", "streams": ["execution-requests", "fast-lane", "exec-requests-fast", "exec-requests-l2", "exec-requests-premium", "exec-requests-solana", "pre-simulated"] },
    { "name": "mempool-detector-group", "streams": ["pending-opportunities"] },
    { "name": "orderflow-pipeline", "streams": ["pending-opportunities"] },
    { "name": "self-healing-manager", "streams": ["system-failures", "system-control", "system-scaling"] },
    { "name": "failover-{serviceName}", "streams": ["system-failover"], "dynamic": true }
  ],
  "featureFlags": [
    { "envVar": "FEATURE_FLASH_LOAN_AGGREGATOR", "pattern": "=== 'true'" }
  ],
  "counts": {
    "streams": 29,
    "services": 11,
    "devAllServices": 7,
    "partitions": 4,
    "consumerGroups": 7,
    "featureFlags": 23
  }
}
```

**Validation rules** (fail → CRITICAL finding to `static-analysis.jsonl`, continue with partial inventory):
- `counts.streams >= 29` — fewer means source file structure changed
- `counts.devAllServices == 7` — the 7 services started by `dev:all`
- `counts.partitions == 4`
- Every stream in `streams[]` has a non-zero `maxLen`
- Every partition has at least 1 chain
- All 7 expected consumer groups found

If validation passes, output: `Inventory generated: <n> streams, <n> services, <n> partitions, <n> groups, <n> flags`
