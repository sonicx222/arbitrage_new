# Arbitrage Bot Codebase Analysis Report

**Date:** 2026-01-17
**Version:** 1.0
**Status:** Review

## 1. Executive Summary

The codebase implements a **Hybrid Microservices + Event-Driven** architecture using Node.js, TypeScript, and Redis Streams, largely aligning with `ARCHITECTURE_V2.md`. The system shows maturity in handling distributed state (locks, streams) and resiliency (circuit breakers, health checks).

However, **critical flaws** exist that undermine its "professional" designation:
1.  **Financial Precision Loss**: Use of javascript `Number` (double-precision float) for calculating arbitrage profits from `BigInt` reserves. This will lead to inaccurate profit estimation and potential losses on high-value/high-precision tokens.
2.  **Performance Bottleneck**: The arbitrage detection logic performs an O(N) full-state snapshot copy on *every* price update. With 600+ pairs (target), this will cause massive GC churn and event loop blocking, violating the <50ms latency target.
3.  **Scalability Limit**: Pair discovery is currently hardcoded (combinatorial generation) rather than dynamic (factory event listening), as noted in `ADR-003` but not implemented.

## 2. Architecture Mismatch

| Component | Design (Docs) | Implementation (Code) | Severity |
|-----------|---------------|-----------------------|----------|
| **Pair Discovery** | Dynamic via Factory Events | Static combinatorial generation (`tokens` x `dexes`) in `ChainDetectorInstance.ts`. Explicit "simplified" comment found. | **High** - Limits scalability to new pairs. |
| **Global Coordinator** | Leader Election, Health | `services/coordinator` exists but `UnifiedChainDetector` manages its own partitions mostly via env vars. | Low - Acceptable for current scale. |
| **Execution** | MEV Protection | Implemented via `Flashbots` (implied by private keys) and `SimulationMode`. | Match. |
| **Event Bus** | Redis Streams | Used consistently (`RedisStreamsClient`). | Match. |

## 3. Bugs & Critical Issues

### 3.1. Precision Loss in Arbitrage Calculation (Critical)
**File:** `services/unified-detector/src/chain-instance.ts`
**Location:** `calculateArbitrage`
**Issue:**
```typescript
const price1 = Number(reserve1_0) / Number(reserve1_1);
// ...
const netProfitPct = priceDiff - totalFees;
```
**Impact:** `Number` has 53 bits of mantissa. Blockchain reserves (`uint256`/`uint112`) can exceed this. Converting large reserves to `Number` causes precision loss. Calculating profit margins of ~0.3% requires high precision. This can result in:
- Missing profitable trades (false negatives).
- Executing unprofitable trades (false positives).
**Fix:** Use `ethers.FixedNumber` or a `BigDecimal` library.

### 3.2. Memory Leak in Execution Engine (High)
**File:** `services/execution-engine/src/engine.ts`
**Location:** `pendingMessages` map
**Issue:**
The `pendingMessages` map tracks messages for deferred ACK. Entries are removed only in `ackMessageAfterExecution`.
- If an execution crashes or the specific logic path that calls ACK is missed (e.g. timeout), the entry stays in the map forever.
- `moveToDeadLetterQueue` handles errors, but if the process itself is killed or restarts, pending messages are lost from memory (Redis handles redelivery, but local memory leak persists if process is long-lived but buggy).
**Fix:** Implement a cleanup interval for `pendingMessages` or ensure `finally` block always ACKs.

### 3.3. Race Condition / Blocking Event Loop (High)
**File:** `services/unified-detector/src/chain-instance.ts`
**Location:** `checkArbitrageOpportunity`
**Issue:**
```typescript
private checkArbitrageOpportunity(updatedPair: ExtendedPair): void {
  // ...
  const pairsSnapshot = this.createPairsSnapshot(); // Iterates ALL pairs
  for (const [key, otherSnapshot] of pairsSnapshot) { ... }
}
```
**Impact:**
- `createPairsSnapshot` creates a new object for *every* pair in the map.
- This runs on **every** `Sync` event.
- If receiving 100 events/sec with 600 monitored pairs: 60,000 object allocations/sec + 60,000 iterations.
- This will block the Node.js event loop, increasing latency far beyond the <50ms target.
**Fix:**
- Use an **Adjacency List** (Graph) to only check pairs that share a token with the updated pair.
- Pre-compute stable pairs vs volatile pairs.

## 4. Race Conditions

1.  **Execution Locking**: `ExecutionEngineService` uses `DistributedLockManager`. However, the check for `activeExecutions` (local Set) happens before the distributed lock acquisition.
    - If two execution engine instances run, local checks pass, both try to acquire Redis lock. One wins. This is correct.
    - But reliance on local state `activeExecutions` is redundant or misleading if multiple instances are deployed.

2.  **Snapshot Consistency**: `ChainDetectorInstance` correctly uses `createPairsSnapshot` to avoid *data* race conditions (in terms of values changing mid-iteration), but the overhead causes *performance* "racing" against the block time.

## 5. Inconsistencies & Code Quality

1.  **TypeScript Strictness**: `tsconfig.json` has `"noImplicitAny": false`. This disables a core benefit of TypeScript. Many methods use implicit `any`, masking type errors.
2.  **Magic Numbers**: Fee defaults (`0.003`) are scattered. Should be in central config.
3.  **File Size**: `ExecutionEngineService` is ~1800 lines. Violation of Single Responsibility Principle.
4.  **Logging**: `emitOpportunity` logs `percentage: (opp.profitPercentage * 100).toFixed(2) + '%'`. `profitPercentage` is already calculated as `netProfitPct * 100`. So it multiplies by 100 *twice* in the log?
    - Code: `profitPercentage: netProfitPct * 100`
    - Log: `percentage: (opp.profitPercentage * 100)...` -> This logs 10000x the value? (e.g. 0.005 profit -> 0.5% -> stored 0.5 -> logged 50%). Review needed.

## 6. Optimization Opportunities

1.  **Graph-Based Detection (Major)**:
    - Instead of O(N) iteration, model the connections as a graph: `Token -> [Pair1, Pair2]`.
    - On update(Pair A: TokenX/TokenY): Only check other pairs containing TokenX or TokenY.
    - Reduces complexity from O(Pairs) to O(Degree of Token).

2.  **Math Optimization**:
    - Use integer math (basis points) for profit stats. `10000` = 100.00%. Avoids floating point slowness and inaccuracies, only convert to float for display.

## 7. Plan of Action

1.  **Immediate**: Fix `tsconfig.json` to strict.
2.  **High Priority**: Refactor `calculateArbitrage` to use `FixedNumber`.
3.  **High Priority**: Implement Adjacency List for `checkArbitrageOpportunity`.
4.  **Medium**: Split `ExecutionEngineService` into `ExecutionManager`, `QueueHandler`, `ProviderManager`.
