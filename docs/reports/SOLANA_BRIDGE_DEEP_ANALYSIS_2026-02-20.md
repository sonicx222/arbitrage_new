# Deep Analysis: Solana Partition (P4) & Cross-Chain Bridge Recovery

**Date**: 2026-02-20
**Scope**: `services/partition-solana/`, `shared/core/src/solana/`, bridge recovery in `services/execution-engine/`
**Team**: 6 specialized Opus agents (architecture, bug-hunt, security, test-quality, mock-fidelity, performance)
**Files Analyzed**: 50+ source files, 30+ test files, 6 ADRs, architecture docs

---

## Executive Summary

- **Total findings**: 38 unique (after deduplication across 6 agents)
- **By severity**: 0 Critical | 5 High | 14 Medium | 19 Low
- **Top 3 highest-impact issues**:
  1. **Funds stuck on destination chain** after bridge success + sell failure — no recovery state persisted (Security + Test Quality)
  2. **Timer leak in `markConnectionFailed()`** — orphaned timers cause post-shutdown reconnection attempts (Bug Hunter, 2 files)
  3. **Bridge recovery keys not HMAC-signed** — poisoning risk if Redis is compromised (Security)
- **Overall health grade**: **B+** — Strong security posture and test coverage, but bridge recovery has fund-safety gaps and the legacy monolithic SolanaDetector (1525 lines) needs retirement

### Agent Agreement Map

| Area | Agents Agreeing | Finding |
|------|----------------|---------|
| CLAUDE.md stale P4 description | Architecture, Security, Performance | P4 now uses factory (240 lines, not 503) |
| Timer leak in connection pool | Bug Hunter (2 locations) | markConnectionFailed() orphans timers |
| Bridge recovery fund safety | Security, Test Quality | persistBridgeRecoveryState() not called on sell failure |
| Monolithic SolanaDetector retirement | Architecture, Performance, Bug Hunter | 1525 lines duplicating 5 extracted modules |
| Pool parser hot-path allocations | Performance (3 findings) | 19 base58 encodings per update cycle |
| Fly.io port mismatch | Architecture | partition-solana.toml uses 3001 instead of 3004 |

---

## Critical Findings (P0)

None found. No exploitable security vulnerabilities, no data loss bugs, no fund-draining attack paths.

---

## High Findings (P1)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| 1 | Fund Safety | `cross-chain.strategy.ts:770-789` | After bridge completes, if dest chain validation fails (no wallet/provider), funds are stuck with **no recovery state persisted**. `persistBridgeRecoveryState()` not called in this failure path. | Security, Test Quality | HIGH (90%) | 4.2 |
| 2 | Bug / Leak | `solana-connection-pool.ts:159` | `markConnectionFailed()` overwrites timer reference without clearing old timer. Rapid failures orphan timers, causing concurrent reconnection attempts and timer leaks during shutdown. | Bug Hunter | HIGH (95%) | 3.8 |
| 3 | Bug / Leak | `solana-detector.ts:768` | Same timer pattern but **worse**: timer reference not stored at all. Cannot be cancelled during `stop()`/`cleanup()`. Post-shutdown timer fires against disposed RPC. | Bug Hunter | HIGH (92%) | 3.8 |
| 4 | Cross-Chain | `bridge-recovery-manager.ts:420` | Bridge recovery states stored via plain `redis.set()` — **not HMAC-signed** unlike Redis Streams messages. Attacker with Redis access could poison recovery keys. | Security | MEDIUM (70%) | 3.5 |
| 5 | Config | `infrastructure/fly/partition-solana.toml:37,43` | Fly.io config uses port **3001** but canonical port is **3004** (`service-ports.json:21`). Port 3001 is assigned to P1 (partition-asia-fast). | Architecture | HIGH (100%) | 3.4 |

### Suggested Fixes (P1)

**#1 — Add recovery state on all post-bridge failure paths:**
```typescript
// cross-chain.strategy.ts: After bridge success, before any sell attempt
if (bridgeResult.success) {
  await this.persistBridgeRecoveryState(bridgeResult, 'bridge_completed_sell_pending');
}
```

**#2 — Clear existing timer before scheduling:**
```typescript
// solana-connection-pool.ts:159
if (reconnectTimers[index]) {
  clearTimeout(reconnectTimers[index]!);
  reconnectTimers[index] = null;
}
reconnectTimers[index] = setTimeout(() => attemptReconnection(index), config.retryDelayMs);
```

**#3 — Store timer references in monolithic class:**
```typescript
// solana-detector.ts: Add reconnectTimers array, store & clear in cleanup()
private reconnectTimers: (NodeJS.Timeout | null)[] = [];
```

**#4 — Sign recovery state with HMAC + add schema validation:**
```typescript
// bridge-recovery-manager.ts: Sign on write, verify on read
const signed = this.signPayload(JSON.stringify(state));
await this.redis.set(key, signed, { EX: ttlSeconds });
```

**#5 — Fix port in Fly.io config:**
```toml
# infrastructure/fly/partition-solana.toml
HEALTH_CHECK_PORT = "3004"
internal_port = 3004
```

---

## Medium Findings (P2)

| # | Category | File:Line | Description | Agent(s) | Confidence |
|---|----------|-----------|-------------|----------|------------|
| 6 | Race Condition | `bridge-recovery-manager.ts:196-211` | `stop()` doesn't wait for in-progress `recoverPendingBridges()` to complete. Recovery may write to Redis after manager thinks it's stopped. | Bug Hunter | MEDIUM (80%) |
| 7 | Test Gap | `cross-chain.strategy.ts:1509` | `persistBridgeRecoveryState()` has **zero tests**. Funds-at-risk code path. | Test Quality | HIGH (95%) |
| 8 | Test Gap | `cross-chain.strategy.ts:1543` | `updateBridgeRecoveryStatus()` has **zero tests**. | Test Quality | HIGH (95%) |
| 9 | Input Validation | `bridge-recovery-manager.ts:418` | No runtime schema validation on deserialized `BridgeRecoveryState` from Redis. TypeScript generics provide no runtime safety. | Security | MEDIUM (75%) |
| 10 | Resource Leak | `partition-solana/src/index.ts:152` | `solanaArbitrageDetector.on('opportunity', ...)` listener never removed during shutdown. | Bug Hunter | HIGH (90%) |
| 11 | Bug | `orca-whirlpool-parser.ts:176-177` | Returns `token0Decimals: 0, token1Decimals: 0` in parsed state. Current callers use external decimals, but any future caller reading state fields gets wrong values. | Bug Hunter | MEDIUM (80%) |
| 12 | Security | `redis-streams.ts:427` | HMAC signing silently disabled when `STREAM_SIGNING_KEY` is null (non-production). If `NODE_ENV` not set to `production`, all messages pass without verification. | Security | MEDIUM (65%) |
| 13 | Test Singleton | `solana-swap-parser.ts:942` | Module-level singleton leaks across tests if `resetSolanaSwapParser()` not called in `beforeEach`. | Bug Hunter | MEDIUM (80%) |
| 14 | Duplication | `bridge-recovery-manager.ts:408` + `cross-chain.strategy.ts:1618` | Duplicate Redis SCAN logic for `bridge:recovery:*` keys. Changes must be synced in both places. | Architecture | HIGH (90%) |
| 15 | Config | `service-config.ts:84-85` | `CROSS_CHAIN_ENABLED`/`TRIANGULAR_ENABLED` use `!== 'false'` (opt-out). Cross-chain on Solana may warrant opt-in (`=== 'true'`). | Architecture | MEDIUM (75%) |
| 16 | Config | `detection/base.ts:26` | Hardcoded `DEFAULT_SOL_PRICE_USD = 100`. If SOL price diverges significantly and oracle is down, gas estimates are wrong. | Architecture | MEDIUM (70%) |
| 17 | Performance | `solana-detector.ts:1244` + `solana-arbitrage-detector.ts:148` | `Array.from()` + `.filter()` in arbitrage detection hot path. Creates snapshot arrays on every detection cycle (100-1000x/sec). | Performance | MEDIUM |
| 18 | Performance | `raydium-amm-parser.ts:131-164` | 7 `new PublicKey().toBase58()` allocations per account update. ~700 allocations/sec at 100 updates/sec. Should cache per pool address. | Performance | HIGH |
| 19 | Duplication | Architecture | Dual `SolanaArbitrageDetector` implementations: `shared/core` (modular factory) vs `services/partition-solana` (class-based). Different pool types, different profit logic. | Architecture | HIGH (85%) |

---

## Low Findings (P3)

| # | Category | File:Line | Description | Agent(s) |
|---|----------|-----------|-------------|----------|
| 20 | Arch | `shared/core/__tests__/unit/solana/s3.3.6...test.ts:33` | Layer violation: shared/core test imports from services/partition-solana | Architecture |
| 21 | Doc | `CLAUDE.md` | Stale: says P4 is "manual 503-line index.ts" but it's now 240 lines using factory | Architecture, Security, Performance |
| 22 | Bug | `solana-subscription-manager.ts:209-220` | Iterates Map while deleting via delegation. JS spec handles it but pattern is fragile. | Bug Hunter |
| 23 | Bug | `solana-detector.ts:557-563` | Same Map iteration-during-delete pattern (duplicate of #22 in different file). | Bug Hunter |
| 24 | Code Smell | `cross-chain.strategy.ts:639,705,761` | Unnecessary `!` non-null assertions after already validating non-null. | Bug Hunter |
| 25 | Memory | `versioned-pool-store.ts:109-120` | LRU eviction doesn't clean up empty pair Sets. `poolsByPair` accumulates empty Sets over time. | Bug Hunter |
| 26 | Perf | `solana-connection-pool.ts:219,239` | `healthStatus.filter(h => h).length` creates temp array. Use counter instead. | Bug Hunter, Performance |
| 27 | Memory | `arbitrage-detector.ts:318-338` | `stop()` clears tokenCache and poolUpdateTimestamps but not poolStore. | Bug Hunter |
| 28 | Inconsistency | `arbitrage-detector.ts:431-439` | In-place pool mutation vs shared/core's immutable spread pattern. JS single-threaded, so safe, but inconsistent. | Bug Hunter |
| 29 | Config | `detection/base.ts:80-91` | `EVM_GAS_COSTS_USD` hardcoded per-chain ($15 Ethereum, $0.10 Arbitrum). No config override. | Architecture |
| 30 | Config | `detection/base.ts:65` | `CROSS_CHAIN_EXPIRY_MULTIPLIER = 10` magic number, not configurable. | Architecture |
| 31 | Duplication | `solana-detector.ts:60-64` vs `solana-types.ts:31-35` | Duplicate `SolanaDetectorPerfLogger` with `any` vs `Record<string, unknown>`. | Architecture |
| 32 | Closure | `partition-solana/src/index.ts:130-137` | Closure captures variables declared after factory call. Works but fragile. | Architecture |
| 33 | Perf | `solana-detector.ts:1299` | `thresholdDecimal` recomputed per call (already pre-computed in extracted module). | Performance |
| 34 | Perf | `solana-detector.ts:1312` | `Math.random().toString(36).slice(2,11)` for ID generation. Use counter instead. | Performance |
| 35 | Perf | `versioned-pool-store.ts:201-203` | `getPairKeys()` allocates new array each call. Expose iterator or cache. | Performance |
| 36 | Perf | `orca-whirlpool-parser.ts:118-121` | Debug logging creates Buffer slice + hex string even when debug disabled. | Performance |
| 37 | Perf | `detection/base.ts:190` | `Date.now()` called per-pool in `isPriceStale()`. Pass timestamp from outer loop. | Performance |
| 38 | Performance | `solana-detector.ts:1465` | `indexOf` for O(n) RPC URL lookup. Track index as field instead. | Bug Hunter |

---

## Test Coverage Matrix (Key Source Files)

| Source File | Happy Path | Error Path | Edge Cases | Overall |
|-------------|------------|------------|------------|---------|
| `arbitrage-detector.ts` | ✅ Excellent | ✅ Good | ✅ Good | **High** |
| `detection/intra-solana-detector.ts` | ✅ Excellent | ✅ Good | ✅ Good | **High** |
| `detection/triangular-detector.ts` | ✅ Excellent | ✅ Good | ⚠️ Missing overflow | **High** |
| `detection/cross-chain-detector.ts` | ✅ Excellent | ✅ Good | ✅ Good | **High** |
| `pool/versioned-pool-store.ts` | ✅ Excellent | ✅ Good | ✅ Good | **High** |
| `bridge-recovery-manager.ts` | ✅ Excellent | ✅ Good | ✅ Good | **High** |
| `cross-chain.strategy.ts` | ✅ Good | ✅ Good | ❌ **2 untested methods** | **Medium** |
| `solana-connection-pool.ts` | ✅ Good | ✅ Good | ✅ Good | **High** |
| `solana-subscription-manager.ts` | ✅ Good | ✅ Good | ✅ Good | **High** |
| All 3 pool parsers | ✅ Good | ✅ Good | ✅ Good | **High** |
| All 3 bridge routers | ✅ Excellent | ✅ Excellent | ✅ Excellent | **Very High** |

**98 functions mapped**: 62 fully covered (63%), 29 partially (30%), 7 uncovered (7%)

---

## Mock Fidelity Matrix

| Mock Category | Count | High Fidelity | Medium | Low |
|---------------|-------|---------------|--------|-----|
| Solana RPC mocks | 5 | 4 | 1 | 0 |
| Pool parser mocks | 3 | 3 | 0 | 0 |
| Bridge router mocks | 4 | 4 | 0 | 0 |
| Redis/infra mocks | 4 | 3 | 1 | 0 |
| Type/interface mocks | 8 | 8 | 0 | 0 |
| **Total** | **24** | **22 (92%)** | **2 (8%)** | **0** |

Key mock gaps: No rate limiting simulation, no partial bridge completion, no base64 account data parsing integration.

---

## Cross-Agent Insights

1. **Finding #1 (fund safety) + Finding #7 (test gap)**: Security identified that funds get stuck post-bridge if sell fails. Test Quality independently confirmed `persistBridgeRecoveryState()` has zero tests. These compound: the untested code is also the code with the bug.

2. **Finding #2-3 (timer leak) + Finding #17-18 (hot-path alloc)**: Bug Hunter found timer leaks in connection pool; Performance found allocation issues in the same Solana infrastructure layer. Both point to the monolithic `SolanaDetector` needing retirement — the extracted modules have partially addressed some patterns but the legacy class still has the original bugs.

3. **Finding #4 (HMAC) + Finding #9 (schema validation)**: Security found bridge recovery keys aren't signed; Test Quality's coverage matrix confirms the persistence methods are untested. Together these represent the highest-risk area in the codebase for fund safety.

4. **Finding #21 (CLAUDE.md stale)**: 3 of 6 agents independently noted the documentation says P4 is a manual 503-line entry but it's now 240 lines using the factory. This was the most-agreed-upon finding across agents.

---

## Recommended Action Plan

### Phase 1: Immediate (P1 — fund safety + correctness)

- [ ] **Fix #1**: Add `persistBridgeRecoveryState()` on all failure paths after successful bridge in `cross-chain.strategy.ts`
- [ ] **Fix #2**: Clear existing timer in `markConnectionFailed()` before scheduling new one (`solana-connection-pool.ts:159`)
- [ ] **Fix #3**: Store timer references in `SolanaDetector.markConnectionFailed()` and clear in cleanup
- [ ] **Fix #5**: Change port from 3001 to 3004 in `infrastructure/fly/partition-solana.toml`
- [ ] **Test #7-8**: Add tests for `persistBridgeRecoveryState()` and `updateBridgeRecoveryStatus()`

### Phase 2: Next Sprint (P2 — reliability + coverage)

- [ ] **Fix #4**: Add HMAC signing to bridge recovery state Redis keys
- [ ] **Fix #6**: Add wait-for-in-progress guard to `BridgeRecoveryManager.stop()`
- [ ] **Fix #9**: Add runtime schema validation for `BridgeRecoveryState` on Redis read
- [ ] **Fix #10**: Remove event listener on `solanaArbitrageDetector` during shutdown
- [ ] **Fix #11**: Fix Orca whirlpool parser `token0Decimals: 0` return values
- [ ] **Fix #14**: Consolidate duplicate bridge recovery SCAN logic
- [ ] **Fix #25**: Clean up empty pair Sets in `VersionedPoolStore.deleteInternal()`
- [ ] **Test**: Add `pollBridgeCompletion()` backoff schedule and deadline tests

### Phase 3: Backlog (P3 — performance, refactoring, maintenance)

- [ ] **Refactor**: Retire monolithic `SolanaDetector` class (1525 lines → 50-line facade)
- [ ] **Perf #18**: Add two-tier pool parsing (full parse on first encounter, price-only on updates)
- [ ] **Perf #17**: Replace `Array.from()` + `.filter()` with iterator-based detection
- [ ] **Perf #35**: Add `pairKeysIterator()` to `VersionedPoolStore`
- [ ] **Doc #21**: Update CLAUDE.md to reflect P4 factory migration
- [ ] **Refactor**: Consolidate duplicate DEX program ID constants to single source
- [ ] **Refactor**: Remove deprecated parser delegations in `SolanaPriceFeed`
- [ ] **Fix #20**: Move layer-violating test from shared/core to services/partition-solana

---
---

# Wave 2: Extended Deep Analysis (Operational Focus)

**Date**: 2026-02-20
**Scope**: Full pipeline operational analysis — latency profiling, failure modes, data integrity, cross-chain edge cases, observability, configuration drift
**Team**: 6 specialized Opus agents (latency-profiler, failure-mode-analyst, data-integrity-auditor, cross-chain-analyst, observability-auditor, config-drift-detector)
**Files Analyzed**: 40+ source files across all services, 6 Fly.io deployment configs, .env.example, 4 ADRs

> This analysis complements Wave 1 (code quality: architecture, bugs, security, test quality, mock fidelity, performance). Wave 2 focuses on operational health: how the system behaves under failure, latency characteristics, data integrity guarantees, cross-chain correctness, observability gaps, and configuration drift.

---

## Executive Summary

- **Total findings**: 48 unique (after deduplication across 6 agents)
- **By severity**: 0 Critical | 7 High | 17 Medium | 24 Low/Informational
- **Top 5 highest-impact issues**:
  1. **Trace context severed at origin** — unified-detector never injects trace context; all traces start fresh at coordinator (Observability)
  2. **BridgeRecoveryManager may not execute sell recovery** — funds potentially stranded on destination chain (Failure Mode, NEEDS VERIFICATION)
  3. **Commit-reveal cancel failures completely swallowed** — `.catch(() => {})` hides on-chain commitment failures (Observability)
  4. **Port mismatch across ALL partition Fly.io configs** — copy-paste of port 3001 instead of per-partition ports (Config Drift)
  5. **GasPriceCache uses EVM model for Solana** — silently falls back to meaningless 50 gwei (Cross-Chain)
- **Overall operational health grade**: **B** — Strong failure handling fundamentals (deferred ACK, PEL recovery, circuit breakers), but observability is critically undermined by broken trace propagation, bridge recovery completeness is uncertain, and deployment configs have systematic copy-paste errors

### Agent Agreement Map (Wave 2)

| Area | Agents Agreeing | Finding |
|------|----------------|---------|
| Stream trimming risks | Failure-Mode, Data-Integrity | Approximate MAXLEN on execution-requests could trim unread messages |
| Deferred ACK correctness | Failure-Mode, Data-Integrity | Both independently confirmed PEL-based recovery works correctly |
| HMAC chain correctness | Data-Integrity, Latency-Profiler | Constant-time comparison, production enforcement, correct field coverage |
| Seqlock correctness | Data-Integrity, Latency-Profiler | Textbook implementation with proper Atomics semantics |
| Bridge recovery fund safety | Failure-Mode + Wave 1 Security | Both waves flag bridge recovery as highest-risk area |
| Port mismatch (all partitions) | Config-Drift + Wave 1 Architecture | Expanded from P4-only (Wave 1) to ALL partitions |

### Cross-Validation Results (Agents 2 + 3 Overlap)

The failure-mode-analyst (Agent 2) and data-integrity-auditor (Agent 3) independently analyzed Redis Streams, shutdown behavior, and data loss risks.

**Agreement (HIGH confidence)**: Deferred ACK pattern, PEL recovery via XCLAIM, backpressure coupling, StreamBatcher mutex correctness, HMAC chain, DLQ write failure handling.

**Conflict resolved**: Agent 2 said "No explicit MAXLEN on EXECUTION_REQUESTS stream observed in consumer code" (NEEDS VERIFICATION). Agent 3 found exact MAXLEN of 5,000 with approximate trimming at `opportunity-router.ts:100`. **Resolution**: Agent 3's evidence is stronger — used Agent 3's finding (DI-8).

**Conflict resolved**: Agent 2 said "DLQ stream has no observed MAXLEN". Agent 3 found DLQ MAXLEN is 10,000 at `redis-streams.ts:356`. **Resolution**: Agent 3 read the STREAM_MAX_LENGTHS map directly — used Agent 3's finding (DI-9).

---

## High Findings (P1)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| W2-1 | Observability | `opportunity.publisher.ts` (entire file) | Unified-detector **never injects trace context**. Zero imports from tracing module in `services/unified-detector/src/`. All traces start fresh at coordinator — no end-to-end correlation from WebSocket through execution. | Observability, Data-Integrity | HIGH (100%) | 4.4 |
| W2-2 | Observability | `opportunity.consumer.ts:496-497` + `engine.ts` (entire) | Execution engine attaches `_traceId`/`_spanId` to opportunity but **never references them in any log statement**. Grep for `_traceId|_spanId|traceId|spanId` in `engine.ts` returns zero matches. | Observability | HIGH (100%) | 4.4 |
| W2-3 | Observability | `intra-chain.strategy.ts:580,602` | Commit-reveal cancel failures **completely swallowed** via `.catch(() => {})`. Failed cancels leave on-chain commitments potentially locking funds. No log, no metric, no alert. | Observability | HIGH (95%) | 4.4 |
| W2-4 | Fund Safety | `bridge-recovery-manager.ts:324-375` | `attemptSellRecovery` checks bridge status but may **not execute the actual sell**. Comment says "handled by CrossChainStrategy.recoverSingleBridge()" but this delegation is not confirmed. Funds could be stranded on destination chain. | Failure-Mode | NEEDS VERIFICATION (80%) | 3.5 |
| W2-5 | Config | `infrastructure/fly/partition-*.toml` | ALL partition Fly.io configs use port **3001** (copy-paste). P2 should be 3002, P3 should be 3003, P4 should be 3004. Execution engine uses 8080 vs code's 3005. | Config-Drift, Wave 1 Arch | HIGH (95%) | 3.5 |
| W2-6 | Resilience | Cross-chain strategy (no file) | **No circuit breaker for bridge route failures**. Repeated failures on a source→dest route each cost gas without any protective cooldown mechanism. | Failure-Mode | MEDIUM (75%) | 3.7 |
| W2-7 | Config | `unified-detector/src/index.ts:59` | `enableCrossRegionHealth` uses `=== 'true'` (opt-in, defaults OFF) while ALL other locations use `!== 'false'` (opt-out, defaults ON). Standalone unified-detector silently disables cross-region health. | Config-Drift | HIGH (92%) | 4.0 |

### Suggested Fixes (P1)

**W2-1 — Inject trace context at unified-detector:**
```typescript
// opportunity.publisher.ts: Import and create trace context
import { createTraceContext } from '@arbitrage/core/tracing';
const traceCtx = createTraceContext();
// Include _trace_traceId, _trace_spanId in published message fields
```

**W2-2 — Use traceId in execution engine logs:**
```typescript
// engine.ts: At start of each execution
const childLogger = this.logger.child({ traceId: opportunity._traceId });
// Use childLogger for all downstream logging
```

**W2-3 — Log cancel failures instead of swallowing:**
```typescript
// intra-chain.strategy.ts:580,602
.catch(err => this.logger.warn('Commit-reveal cancel failed', { error: err.message, commitId }))
```

**W2-4 — Verify and fix bridge sell recovery (NEEDS VERIFICATION first):**
- Confirm whether `processSingleBridge()` delegates to `CrossChainStrategy.recoverSingleBridge()` for sell execution
- If not: implement sell execution delegation or expose manual trigger endpoint

**W2-5 — Fix all Fly.io port configs:**
```toml
# partition-l2-fast.toml → 3002
# partition-high-value.toml → 3003
# partition-solana.toml → 3004
```

**W2-6 — Add per-route circuit breaker for bridges:**
```typescript
// Track failure count per route triple (source, dest, token)
// After N consecutive failures, cool down the route for configurable period
```

**W2-7 — Fix enableCrossRegionHealth pattern:**
```typescript
// unified-detector/src/index.ts:59
enableCrossRegionHealth: process.env.ENABLE_CROSS_REGION_HEALTH !== 'false', // opt-out, default ON
```

---

## Medium Findings (P2)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| W2-8 | Data Integrity | `redis-streams.ts:463`, `opportunity-router.ts:100` | Approximate MAXLEN (~5000) on execution-requests stream. Under burst load, unread messages could be trimmed before execution engine processes them. Most financially critical stream. | Data-Integrity, Failure-Mode | MEDIUM (70%) | 3.5 |
| W2-9 | Data Integrity | `publishing-service.ts:243-248` | Publisher dedup **fails OPEN** on Redis error — publishes opportunity anyway with warning log. During Redis instability, duplicates reach the pipeline. Downstream layers provide defense-in-depth. | Data-Integrity | HIGH (90%) | 3.1 |
| W2-10 | Data Integrity | `chain-instance.ts:1388-1389` | No `NaN`/`Infinity` validation on price **before** StreamBatcher publish. `calculatePriceFromBigIntReserves()` could produce non-finite values from extremely large reserves. PriceMatrix writer validates, but stream consumers receive invalid prices. | Data-Integrity | MEDIUM (70%) | 3.4 |
| W2-11 | Data Integrity | `redis-streams.ts:163-171` | StreamBatcher `maxQueueSize` exceeded → message **silently dropped** with only warning log. No counter metric, no error thrown. Under sustained backpressure, this is silent data loss for price updates. | Data-Integrity | HIGH (90%) | 3.4 |
| W2-12 | Cross-Chain | `gas-price-cache.ts:573-578` | GasPriceCache uses `ethers.JsonRpcProvider` for **ALL chains including Solana**. Solana RPC is not Ethereum-compatible — silently fails and falls back to meaningless 50 gwei. | Cross-Chain | HIGH (95%) | 3.6 |
| W2-13 | Cross-Chain | `gas-price-cache.ts:149-160,246-257,660` | No `FALLBACK_GAS_PRICES` or `FALLBACK_GAS_COSTS_ETH` entries for Solana. `estimateGasCostUsd('solana', ...)` computes using EVM gas model (gwei × native price) — wrong for Solana's compute unit model. | Cross-Chain | HIGH (98%) | 3.6 |
| W2-14 | Cross-Chain | `bridge-router/types.ts:410-425` vs cross-chain-detector | Stargate doesn't support zkSync or Linea, but cross-chain detector can detect opportunities for these chains. No validation that detected opportunities are actually bridgeable. | Cross-Chain | HIGH (95%) | 3.4 |
| W2-15 | Cross-Chain | `risk-management-orchestrator.ts:218,331,335,346-348` | Hardcodes `1e18` for profit/gasCost conversion. Wrong for Solana (1e9 lamports). Currently mitigated because Solana is detection-only, but will break if Solana execution is enabled. | Cross-Chain | MEDIUM (75%) | 2.7 |
| W2-16 | Observability | `trade-logger.ts:36-70` | `TradeLogEntry` lacks `traceId`, `swapRoute`/`path`, `slippage`, `retryCount`, `detectionTimestamp`, `gasPrice`, `blockNumber`. Cannot reconstruct full lifecycle of failed trades from logs alone. | Observability | HIGH (95%) | 3.4 |
| W2-17 | Resilience | `partition-solana/src/index.ts:164-181` | Redis XADD failure in P4 **silently drops detected opportunities**. No retry, no local buffer. Opportunity is logged but permanently lost from execution pipeline. | Failure-Mode | HIGH (95%) | 3.7 |
| W2-18 | Observability | Health endpoints (coordinator, execution, partitions) | Health/ready endpoints do **NOT check Redis connectivity**. If Redis is down, health reports "healthy" until stale heartbeat detection kicks in (~30s). | Observability | HIGH (90%) | 3.2 |
| W2-19 | Observability | `interval-manager.ts:131` | Interval callback errors logged at **debug** level. In production (default log level info), operational errors in interval callbacks are invisible. Should be **warn**. | Observability | HIGH (95%) | 3.6 |
| W2-20 | Config | `.env.example` | ~27 env vars used in source code are **undocumented** in `.env.example`. 6 are trading-critical: `SLIPPAGE_BASE`, `SLIPPAGE_MAX`, `TRIANGULAR_MIN_PROFIT`, `SWAP_DEADLINE_SECONDS`, `GAS_FALLBACK_SAFETY_FACTOR`, `BALANCE_MONITOR_LOW_THRESHOLD_ETH`. | Config-Drift | HIGH (90%) | 3.3 |
| W2-21 | Performance | `shared-key-registry.ts:190,194-227` | SharedKeyRegistry `lookup()` allocates `Buffer.from(key, 'utf8')` on **every** cold-cache lookup, then does O(n) linear scan through SharedArrayBuffer with byte-by-byte comparison. At 1000 keys with 50% cache miss on multi-leg tasks: ~25-50ms CPU per task across 4 workers. | Latency-Profiler | HIGH (90%) | 3.5 |
| W2-22 | Resilience | `partition-solana/src/rpc-config.ts` | Solana RPC provider selection is **startup-only** (Helius > Triton > PublicNode). No runtime failover if selected provider degrades. | Failure-Mode | MEDIUM (75%) | 2.7 |
| W2-23 | Observability | `detector.ts:797` | Cross-chain price refresh schedule errors **silently swallowed** via `.catch(() => {})`. Stale prices could persist without any log. | Observability | MEDIUM (80%) | 3.6 |
| W2-24 | Observability | Prometheus infrastructure | `PrometheusExporter` class exists with full text/JSON/OTLP export, but is **NOT wired** to any service endpoint. No `/metrics` scrape endpoint on any service. Infrastructure built, never connected. | Observability | HIGH (90%) | 2.8 |

---

## Low Findings (P3)

| # | Category | File:Line | Description | Agent(s) |
|---|----------|-----------|-------------|----------|
| W2-25 | Data Integrity | All PEL recovery code | No XAUTOCLAIM usage. All orphan recovery is manual via XPENDING + XCLAIM at startup only. | Data-Integrity |
| W2-26 | Data Integrity | `opportunity-router.ts:233` | Coordinator dedup window (5s) may miss slow-path duplicates after PEL recovery. Mitigated by distributed lock. | Data-Integrity |
| W2-27 | Data Integrity | `opportunity.consumer.ts:652-662` | Execution consumer dedup is per-instance only (`processingOppIds` Set). Cross-instance duplicates pass local check. Mitigated by distributed lock. | Data-Integrity |
| W2-28 | Data Integrity | `redis-streams.ts:356` | DLQ stream uses approximate MAXLEN (10,000). DLQ is audit safety net — data loss defeats purpose. | Data-Integrity |
| W2-29 | Data Integrity | `redis-streams.ts:446-447` | HMAC covers `data` field only, not batch envelope metadata. Mitigated: `data` field contains all business-critical information. | Data-Integrity |
| W2-30 | Data Integrity | `redis-streams.ts:364` | No HMAC key rotation mechanism. Key set at construction, never changes. Rotation requires restart. Acceptable for Redis-internal signing. | Data-Integrity |
| W2-31 | Data Integrity | `stream-serialization.ts:~40-60` | Trace context uses `_trace_` string prefix convention. If any service changes prefix, correlation breaks silently. | Data-Integrity |
| W2-32 | Data Integrity | `coordinator.ts:296` vs `opportunity-router.ts:97` | Two separate DLQ streams (`stream:dlq` vs `stream:forwarding-dlq`) with different schemas. Complicates monitoring and replay. | Data-Integrity |
| W2-33 | Data Integrity | `redis-streams.ts:977-1036` | No schema validation on deserialized stream messages. `parseStreamResult()` returns raw `Record<string, unknown>`. Acceptable for internal HMAC-signed system. | Data-Integrity |
| W2-34 | Cross-Chain | `gas-price-cache.ts:177-183` | L2 data fee estimates are static hardcoded USD values (e.g., Arbitrum $0.50), not queried from rollup fee oracles. Can vary 10-50x. | Cross-Chain |
| W2-35 | Cross-Chain | `detection/base.ts:26` | `DEFAULT_SOL_PRICE_USD = 100` — stale fallback. Config has $200. Used only as last-resort when `getDefaultPrice('SOL')` fails. | Cross-Chain |
| W2-36 | Cross-Chain | `shared/config/src/tokens/index.ts:660` | `getTokenDecimals()` defaults to 18 for unknown tokens. For unregistered Solana SPL tokens, default should be 9. | Cross-Chain |
| W2-37 | Cross-Chain | `bridge-router/types.ts:402` | Uniform bridge timeout (15 min) for ALL chains. Arbitrum canonical bridge has 7-day withdrawal. Mitigated: system uses Stargate/Across which are fast. | Cross-Chain |
| W2-38 | Cross-Chain | `cross-chain.strategy.ts:1331` | `pollBridgeCompletion()` uses global `maxBridgeWaitMs` instead of bridge-router-specific `getEstimatedTime()`. Method exists but isn't used. | Cross-Chain |
| W2-39 | Cross-Chain | `detection/base.ts:130` | Bridge fee hardcoded at flat 0.1%. Real fees vary (Stargate ~0.06%, Across varies by route/utilization). | Cross-Chain |
| W2-40 | Resilience | `engine.ts:780-783` | Queue contents cleared on shutdown. Items dequeued but in queue are lost. Mitigated: deferred ACK means messages remain in PEL for XCLAIM on restart. | Failure-Mode |
| W2-41 | Resilience | `partition-solana/src/index.ts:130-137` | P4 `additionalCleanup` uses fire-and-forget `stop()` (no await). Shutdown may complete before detector fully stops. Low risk: cleanup is idempotent. | Failure-Mode |
| W2-42 | Resilience | `service-bootstrap.ts:172-174` | `unhandledRejection` logged but does NOT trigger shutdown. Could leave process running with degraded state. | Failure-Mode |
| W2-43 | Config | `detection/base.ts:80-91` | `EVM_GAS_COSTS_USD` hardcoded per-chain. Same constants exist in 3 places (gas-price-cache, gas-price-optimizer, detection/base). Could drift. | Config-Drift |
| W2-44 | Config | `detection/base.ts` | Multiple detection tuning constants not configurable: `MAX_COMPARISONS_PER_PAIR=500`, `MAX_PATHS_PER_LEVEL=100`, `MAX_MEMO_CACHE_SIZE=10000`, `priceStalenessMs=5000`. | Config-Drift |
| W2-45 | Performance | `chain-instance.ts:1391-1412` | PriceUpdate object (14 fields) allocated on every Sync event (~1000/sec per chain). Object pooling would eliminate short-lived allocations. | Latency-Profiler |
| W2-46 | Performance | `chain-instance.ts:1522,1548` | Single-pair snapshots not cached (unlike full N-pair snapshots). Allocated fresh per comparison, O(k) per Sync event. | Latency-Profiler |
| W2-47 | Performance | `redis-streams.ts:256` | Error re-queue uses `[...batch, ...this.queue]` spread, creating O(n) allocation on flush error. Error path only. | Latency-Profiler |
| W2-48 | Resilience | Execution engine DLQ | DLQ consumer exists (`dlq-consumer.ts`) with read/count, but no automated retry mechanism. Append-only, no TTL/MAXLEN management beyond stream-level MAXLEN. | Failure-Mode |

---

## Latency Budget Table

| Stage | Component | File:Line | Estimated Latency | Bottleneck? |
|-------|-----------|-----------|-------------------|-------------|
| WS parse | Topic0 routing, O(1) Set lookup | `chain-instance.ts:1131-1177` | <0.1ms | No |
| Sync decode | 2× BigInt hex parse + parseInt | `chain-instance.ts:1191-1249` | ~0.2ms | No |
| Price calc | `calculatePriceFromBigIntReserves()` | `chain-instance.ts:1378-1412` | ~0.1ms | No |
| L1 cache write | Atomics + DataView (seqlock) | `price-matrix.ts:513-594` | <0.01ms | No |
| L2 cache write | Redis SET (fire-and-forget) | `chain-instance.ts:1432-1444` | async | No |
| Batcher add | O(1) queue push | `redis-streams.ts:156-197` | <0.01ms | No |
| **Batcher flush** | **10ms timer + XADD** | **`redis-streams.ts:191-270`** | **1-15ms** | **YES — largest contributor** |
| Arbitrage detection | O(k) pair matching (k=2-5) | `chain-instance.ts:1517-1589` | ~0.1-0.5ms | No |
| Opportunity publish | Redis SETNX + XADD | `publishing-service.ts:231-269` | ~1-3ms | No |
| Coordinator consume | XREADGROUP BLOCK 1000 | `coordinator.ts:917` | +0.5-2ms (network) | No |
| Coordinator route | unwrap + route + forward | `coordinator.ts:1376-1410` | ~0.1-0.5ms | No |
| Coordinator forward | XADD to execution-requests | coordinator.ts | ~1-3ms | No |
| Execution consume | XREADGROUP BLOCK 1000 | `opportunity.consumer.ts:282-289` | +0.5-2ms (network) | No |
| Execution dequeue | Event-driven + 1s fallback | `engine.ts:968-996` | ~0ms | No |
| **End-to-end** | **WebSocket → Execution dispatch** | — | **~5-24ms typical** | **Within <50ms target** |

**Verdict**: The pipeline meets the <50ms latency target. Worst case with unfavorable batcher timer alignment: ~30ms, still within budget. The 10ms StreamBatcher flush timer is the largest single-stage contributor and is already near-optimal for the Redis command reduction tradeoff.

---

## Failure Mode Map

| # | Stage | Failure Mode | Detection | Recovery | Data Loss Risk | File:Line |
|---|-------|-------------|-----------|----------|----------------|-----------|
| FM-1 | WebSocket (P4) | Disconnection mid-message | Logged via try-catch | Exponential backoff reconnection | Price data during disconnect | `partition-solana/src/index.ts:152-181` |
| FM-2 | RPC (Solana) | Rate limit / provider failure | Startup priority selection | No runtime hot-swap | Opportunities missed | `partition-solana/src/rpc-config.ts` |
| FM-3 | Redis XADD (P4) | Publish failure | Caught, logged | No retry — opportunity dropped | **Detected opportunity permanently lost** | `partition-solana/src/index.ts:164-181` |
| FM-4 | Redis Client Init | Failed to get client | Non-fatal warning | Continues without publishing | **All future opportunities lost silently** | `partition-solana/src/index.ts:96-104` |
| FM-5 | Stream Consumer | Redis failure during poll | Exponential backoff (100ms-30s) | Auto-retry | No loss (messages in stream) | `redis-streams.ts:1299-1312` |
| FM-6 | Handler Throw | Exception in message handler | Stats counter, logged | Message in PEL for retry | No loss | `redis-streams.ts:1289-1297` |
| FM-7 | Consumer Validation | Malformed message | Warn log | ACKed + DLQ | Preserved in DLQ | `opportunity.consumer.ts:550-587` |
| FM-8 | Queue Backpressure | Queue full | Returns 'backpressure' | Consumer paused, NOT ACKed | No loss (PEL redelivery) | `opportunity.consumer.ts:665-675` |
| FM-9 | Bridge Timeout | Exceeds maxBridgeWaitMs | Time + iteration limits | BridgeRecoveryManager on restart | Funds in transit; recovery keys in Redis | `cross-chain.strategy.ts:1345-1493` |
| FM-10 | Bridge OK, Sell Fail | Destination sell reverts | Try-catch, nonce notified | Recovery state in Redis | **Funds stranded until recovery** | `cross-chain.strategy.ts:1136-1161` |
| FM-11 | Engine Crash | Process dies mid-execution | PEL un-ACKed | XCLAIM on restart | In-flight recovered via PEL | `opportunity.consumer.ts:204-276` |
| FM-12 | DLQ Write Fail | XADD to DLQ fails | Caught, logged | Swallowed; original still ACKed | DLQ entry lost (forensic only) | `opportunity.consumer.ts:790-795` |

---

## Chain-Specific Edge Cases

| # | Chain(s) | Issue | Impact | Severity | File:Line |
|---|----------|-------|--------|----------|-----------|
| CC-1 | Solana | GasPriceCache creates ethers.JsonRpcProvider for Solana (not EVM) | Silently fails → 50 gwei fallback (meaningless) | MEDIUM | `gas-price-cache.ts:573-578` |
| CC-2 | Solana | No FALLBACK_GAS_PRICES entry for Solana | Defaults to 50 gwei | MEDIUM | `gas-price-cache.ts:149-160,660` |
| CC-3 | Solana | No FALLBACK_GAS_COSTS_ETH for Solana | `estimateGasCostUsd('solana')` uses EVM math | MEDIUM | `gas-price-cache.ts:246-257` |
| CC-4 | All L2s | L1 data fees hardcoded (Arbitrum $0.50, OP $0.40, etc.) | Can vary 10-50x from actual | LOW | `gas-price-cache.ts:177-183` |
| CC-5 | Solana | Risk orchestrator hardcodes 1e18 for conversions | Wrong for SOL (1e9 lamports). Mitigated: Solana detection-only | MEDIUM | `risk-management-orchestrator.ts:218,331,346` |
| CC-6 | zkSync, Linea | Stargate has no chain IDs for zkSync/Linea | Detected opportunities unbridgeable | MEDIUM | `bridge-router/types.ts:410-425` |
| CC-7 | Solana | DEFAULT_SOL_PRICE_USD = $100 (stale, config has $200) | Gas estimates wrong as last-resort fallback | LOW | `detection/base.ts:26` |
| CC-8 | All | Bridge fee flat 0.1% vs real rates (Stargate ~0.06%, Across varies) | Over/under-estimates cross-chain costs | LOW | `detection/base.ts:130` |

---

## Observability Assessment

### Trace Propagation Map

```
WebSocket → chain-instance ──────── NO trace context
  → Detection ─────────────────── NO trace context
    → opportunity.publisher ───── NO trace context injected
      → Redis OPPORTUNITIES ──── NO _trace_* fields
        → Coordinator consume ── Creates NEW root (always)
          → forward to exec ─── YES _trace_* injected
            → Execution Engine ─ Attaches but NEVER logs
              → Trade Logger ─── Missing traceId field
```

**Critical gap**: End-to-end tracing is broken at the origin. Every trace starts fresh at the coordinator, making it impossible to correlate a trade failure back to the specific WebSocket message that triggered detection.

### Blind Spot Inventory

| ID | File:Line | Pattern | Severity |
|----|-----------|---------|----------|
| B-1 | `intra-chain.strategy.ts:580,602` | `.catch(() => {})` on commit-reveal cancel | **HIGH** |
| B-3 | `interval-manager.ts:140` | Errors logged at debug (invisible in prod) | MEDIUM |
| B-8 | `detector.ts:797` | `.catch(() => {})` on cross-chain refresh | MEDIUM |
| B-9 | `shared/core/interval-manager.ts:95` | Same as B-3 in shared module | MEDIUM |
| B-2 | `engine.ts:1531` | Double-guarded trade logger catch | LOW (acceptable) |
| B-4 | `otel-transport.ts:187,232,251` | Logging transport flush catch | LOW (by design) |
| B-5 | `partition-service-utils.ts:962,981` | Shutdown handler catch | LOW (acceptable) |

### Metrics Gaps

- **PrometheusExporter exists** (`shared/core/src/metrics/infrastructure/`) with full text/JSON/OTLP — but is NOT wired to any service endpoint
- **No `/metrics` scrape endpoint** on coordinator, execution engine, or partitions
- **Missing operational metrics**: detection false positive rate, consumer lag (XPENDING depth), WebSocket health per chain as scrapeable metrics

### Health Check Gaps

- Coordinator `/api/health/ready`: No direct Redis check
- Execution engine `/health`: No Redis check
- Partitions `/health`: P4 doesn't check Solana RPC connectivity

---

## Configuration Health

### Feature Flag Audit: PASS

All `FEATURE_*` flags consistently use `=== 'true'` (experimental, opt-in). All safety flags use `!== 'false'` (opt-out, default ON). **One exception**: `enableCrossRegionHealth` in unified-detector uses `=== 'true'` while all others use `!== 'false'` (W2-7).

### || vs ?? Violations: PASS

Only 1 instance of `|| 0` in source code (`circuit-breaker-manager.ts:288` after `parseInt()`), which is correct — `NaN || 0` works where `NaN ?? 0` would not.

### Port Configuration Drift

| Service | service-ports.json | Fly.io TOML | Status |
|---------|-------------------|-------------|--------|
| Coordinator | 3000 | 3000 | OK |
| partition-asia-fast | 3001 | 3001 | OK |
| partition-l2-fast | 3002 | **3001** | **MISMATCH** |
| partition-high-value | 3003 | **3001** | **MISMATCH** |
| partition-solana | 3004 | **3001** | **MISMATCH** |
| execution-engine | 3005 | **8080** | Intentional (Docker convention) but inconsistent |

### Env Var Documentation Coverage

- ~27 env vars used in source but missing from `.env.example`
- 6 are trading-critical: `SLIPPAGE_BASE`, `SLIPPAGE_MAX`, `TRIANGULAR_MIN_PROFIT`, `SWAP_DEADLINE_SECONDS`, `GAS_FALLBACK_SAFETY_FACTOR`, `BALANCE_MONITOR_LOW_THRESHOLD_ETH`

---

## Cross-Agent Insights (Wave 2)

1. **W2-4 (fund safety) + Wave 1 #1 (fund safety)**: Wave 1 found `persistBridgeRecoveryState()` not called on sell failure path. Wave 2's failure-mode-analyst found the BridgeRecoveryManager may not execute the actual sell even when recovery state exists. These are **two layers of the same problem** — bridge recovery has gaps in both state capture (Wave 1) and state utilization (Wave 2).

2. **W2-1 (trace gap) + W2-2 (trace unused) + W2-16 (trade logger missing fields)**: Three observability findings form a complete chain — trace context is not injected at origin (W2-1), not used in logs at execution (W2-2), and not persisted in trade logs (W2-16). Fixing all three creates end-to-end observability.

3. **W2-12/W2-13 (Solana gas model) + Wave 1 #16 (SOL price stale)**: The shared GasPriceCache is fundamentally wrong for Solana, and the fallback SOL price is stale. P4's own `estimateGasCost()` using compute units is correct, but any shared infrastructure querying Solana gas will get wrong results.

4. **W2-5 (port mismatch ALL) + Wave 1 #5 (port mismatch P4)**: Wave 1 found the P4 port mismatch. Wave 2's config-drift-detector expanded this to ALL partitions — it's a systematic copy-paste issue, not a P4-specific mistake.

5. **W2-8 (stream trimming) + W2-17 (XADD silent drop)**: Data-integrity and failure-mode independently found data loss vectors at different pipeline stages — trimming at the stream level and silent drops at the publish level. Together, they define the system's actual durability guarantees.

6. **W2-21 (SharedKeyRegistry) + Wave 1 #17 (Array.from in hot path)**: Both waves identify allocation overhead in the detection/path-finding hot path. SharedKeyRegistry's linear scan + Buffer.from allocation is the worker-side bottleneck, while Array.from is the main-thread bottleneck.

---

## Conflict Resolutions

### Conflict 1: MAXLEN on EXECUTION_REQUESTS stream
- **Failure-Mode-Analyst**: "NEEDS VERIFICATION: No explicit MAXLEN on EXECUTION_REQUESTS stream observed in consumer code"
- **Data-Integrity-Auditor**: Found exact MAXLEN of 5,000 with approximate trimming at `opportunity-router.ts:100` and `redis-streams.ts:463`
- **Resolution**: Evidence disagreement — Agent 3 (data-integrity) has stronger evidence, having read the STREAM_MAX_LENGTHS map at `redis-streams.ts:339-360` and the producer code. **Adopted Agent 3's finding (DI-8)**. Agent 2's observation was correct that the consumer code doesn't set MAXLEN (it's set by the producer).

### Conflict 2: DLQ stream MAXLEN
- **Failure-Mode-Analyst**: "DLQ stream also has no observed MAXLEN"
- **Data-Integrity-Auditor**: Found DLQ MAXLEN is 10,000 at `redis-streams.ts:356` in the STREAM_MAX_LENGTHS map
- **Resolution**: Same pattern — Agent 3 read the centralized config. **Adopted Agent 3's finding (DI-9)**.

No other inter-agent conflicts identified. All agents agreed on the fundamental correctness of the deferred ACK, seqlock, HMAC, and backpressure mechanisms.

---

## Recommended Action Plan (Wave 2)

### Phase 1: Immediate (P1 — observability + fund safety + config)

- [ ] **W2-1**: Inject trace context at unified-detector `opportunity.publisher.ts`
- [ ] **W2-2**: Include `_traceId` in all execution engine log calls via child logger
- [ ] **W2-3**: Replace `.catch(() => {})` with error logging in `intra-chain.strategy.ts:580,602`
- [ ] **W2-4**: **VERIFY** whether `BridgeRecoveryManager.processSingleBridge()` delegates sell execution to strategy. Fix if not.
- [ ] **W2-5**: Fix ALL Fly.io partition TOML files to use canonical ports from `service-ports.json`
- [ ] **W2-6**: Add per-route circuit breaker for bridge operations
- [ ] **W2-7**: Change `unified-detector/src/index.ts:59` to `!== 'false'` pattern

### Phase 2: Next Sprint (P2 — data integrity + cross-chain + observability)

- [ ] **W2-8**: Use exact MAXLEN for `execution-requests` stream (or increase to 10,000)
- [ ] **W2-10**: Add `!Number.isFinite(price)` check in `chain-instance.ts:1389`
- [ ] **W2-11**: Add counter metric for StreamBatcher dropped messages
- [ ] **W2-12/W2-13**: Skip Solana in GasPriceCache refresh (`isEVM !== false` check)
- [ ] **W2-14**: Validate bridgeability before emitting cross-chain opportunities
- [ ] **W2-16**: Add `traceId`, `blockNumber`, `detectionTimestamp`, `retryCount` to `TradeLogEntry`
- [ ] **W2-17**: Add retry with backoff for Redis XADD in P4 `index.ts:164-181`
- [ ] **W2-18**: Add Redis ping to coordinator and execution engine health/ready endpoints
- [ ] **W2-19**: Elevate `interval-manager.ts:131` errors from debug to warn
- [ ] **W2-20**: Document 6 trading-critical env vars in `.env.example`
- [ ] **W2-21**: Pre-warm worker key cache OR replace SharedKeyRegistry linear scan with hash-based lookup
- [ ] **W2-24**: Wire `PrometheusExporter` to `/metrics` endpoint on coordinator

### Phase 3: Backlog (P3 — hardening + optimization)

- [ ] **W2-9**: Consider failing dedup CLOSED when Redis unavailable (skip publish)
- [ ] **W2-15**: Make profit conversion chain-aware (SOL 1e9 vs ETH 1e18) before enabling Solana execution
- [ ] **W2-22**: Add runtime RPC failover for Solana
- [ ] **W2-23**: Log cross-chain refresh errors in `detector.ts:797`
- [ ] **W2-25**: Add periodic XCLAIM sweep (every 30s) for long-running services
- [ ] **W2-28**: Use exact MAXLEN for DLQ stream or increase to 50,000
- [ ] **W2-34**: Add dynamic L1 data fee querying from rollup fee oracles
- [ ] **W2-35**: Update `DEFAULT_SOL_PRICE_USD` from $100 to $200
- [ ] **W2-45-47**: Object pooling for PriceUpdate, pair snapshot caching, spread elimination
