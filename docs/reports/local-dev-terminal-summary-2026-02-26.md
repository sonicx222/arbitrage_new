# Local Dev Terminal Run Summary (2026-02-26)

## Scope

Logs analyzed from `data/terminal/`:
- `output_coordinator.txt`
- `output_p1_service.txt` (Partition P1 / asia-fast)
- `output_p2_service.txt` (Partition P2 / l2-turbo)
- `output_cross_chain_service.txt`
- `output_execution_service.txt`

Run window observed: approximately `15:36` to `15:52` (CET) on `2026-02-26`.

## Executive Summary

The run is dominated by two major reliability problems:

1. **Whale alert amplification / likely false positives** from P1 (simulated + mirrored cross-chain patterns) produced high alert noise in coordinator and cross-chain detector.
2. **Redis stream lifecycle and health-state instability** (destroyed batcher writes, stale heartbeat flapping, and final Redis shutdown cascade) created noisy errors and degraded service state transitions.

Execution service stayed healthy but effectively idle (`simulationsPerformed: 0` throughout), indicating no meaningful end-to-end execution pipeline activity despite heavy detector output.

## Key Findings

### 1) Whale alerts show spam-like mirrored behavior (likely false positives)

- Coordinator recorded whale alerts in a repeating chain cycle with identical `usdValue` values:
  - Example pattern: `bsc -> polygon -> avalanche -> fantom` with same amount within seconds.
- Dominant addresses are only two values repeated across all chains:
  - `0x10ed43c718714eb63d5aa57b78b54704e256024e`
  - `0x13f4ea83d0bd40e75c8222255bc855a974568dd4`
- DEX is always `pancakeswap_v2` in coordinator whale logs, even for non-BSC chains.
- In P1, many whale publish events with same values appear across all four chains nearly simultaneously.

Conclusion: alerts are very likely synthetic/propagated artifacts, not independent chain-native whale events.

### 2) P1 Redis batcher lifecycle bug creates severe stream noise

- `output_p1_service.txt` contains **1,612** warnings:
  - `Attempted to add message to destroyed batcher` on `stream:price-updates`.
- This strongly suggests a stream batcher ownership/lifecycle issue for shared stream names.

Code-level signal:
- Destroyed batcher warning emitted in `shared/core/src/redis/streams.ts` (`add()` on destroyed batcher).
- `createBatcher()` replaces existing batcher for the same stream key.
- Multiple chain instances in P1 create/use batchers for `stream:price-updates`.

### 3) Coordinator health/degradation flaps heavily

- Frequent transitions between `READ_ONLY` and `COMPLETE_OUTAGE`.
- `Service heartbeat stale` appears 97 times, with some stale ages coming from very old timestamps (days old).
- Startup also recovers pending/orphaned messages from previous consumers, indicating leftover state.

Impact: noisy alerts and unstable perceived system health not matching current runtime state.

### 4) Cross-chain detector input quality issues

- 53 messages skipped as:
  - `Skipping invalid price update message` in a tight window (`15:43:32` to `15:43:53`).
- Log wording inconsistency:
  - `Super whale detected...` is logged even when `isSuperWhale: false` (because trigger condition includes significant net flow, not only super-whale threshold).

### 5) Provider/auth mismatches on websocket endpoints

- P1 and P2 hit repeated websocket `401` errors on Ankr fallback URLs.
- Services eventually recover via alternate providers, but with reconnect delay and data-gap warnings.

### 6) Execution service receives no actionable flow

- Execution engine starts and remains healthy, but metrics stay at zero:
  - `simulationsPerformed: 0`
  - `simulationsSkipped: 0`
- No evidence in logs of sustained forwarded execution requests in this test window.

## Inconsistencies / Config Mismatches

- **Mixed modes in same test run**:
  - P1 shows a simulation run, then later production restart.
  - Execution service is explicitly in simulation mode.
- **Local security/dev defaults still active**:
  - Coordinator warns API auth not configured.
  - Partitions warn health server bound to `0.0.0.0` without auth token.
- **Global listener warning across services**:
  - `MaxListenersExceededWarning` appears on all services.

## End-of-Run Shared Failure

At ~`15:52:12`, all services show Redis disconnect/refusal patterns (`EPIPE` / `ECONNREFUSED`) followed by `tsx` force-kill behavior. This looks like environment shutdown/cascade rather than an isolated service bug.

## Priority Fixes

1. **Stop whale spam first**
   - Add strict deduplication keyed by `(txHash, chain, token, direction)` with longer suppression window.
   - Gate/suppress simulated whale events from promotion paths.
   - Add cross-chain origin tag to prevent mirrored re-emission being treated as new whales.

2. **Fix stream batcher ownership**
   - Avoid shared stream-key collisions causing active batchers to be destroyed.
   - Use publisher-scoped batchers or a single shared process-level publisher per stream.

3. **Stabilize health/degradation logic**
   - Add hysteresis/debounce for degradation transitions.
   - Ignore/purge stale historical heartbeats on startup.

4. **Improve cross-chain validation observability**
   - Log reason codes for invalid price update rejections.
   - Correct whale log message text to match trigger condition.

5. **Harden provider fallback policy**
   - Down-rank or temporarily quarantine providers after auth (`401`) failures.
   - Verify Ankr websocket credentials/tier before including in rotation.

6. **Verify pipeline wiring**
   - Confirm opportunities are forwarded into `stream:execution-requests` during degraded modes and in local test configuration.

## Bottom Line

This run is not clean enough to evaluate trading quality. Whale-alert volume is dominated by likely false positives, and core runtime stability is affected by stream batcher lifecycle and health flapping. Resolve the above priority items before using this test profile for strategy or execution validation.
