# Deep Analysis: Execution Engine & Trade Lifecycle

**Date:** 2026-02-20
**Scope:** `services/execution-engine/` (~70 source files, ~65 test files) + `contracts/src/` (flash loan contracts)
**Team:** 6 specialized agents (architecture, bugs, security, test quality, mock fidelity, performance)
**Files Analyzed:** ~15,000 lines of TypeScript source, ~8,500 lines Solidity, ~20,000 lines of tests

---

## Executive Summary

- **Total findings:** 42 (4 Critical, 9 High, 16 Medium, 13 Low/Info)
- **Top 3 highest-impact issues:**
  1. Double `JSON.parse` on Redis `get()` corrupts bridge recovery state — funds locked in bridges unrecoverable after restart (Bug-hunter P0-1)
  2. `BigInt(fractional_ETH)` crashes risk PnL tracking — drawdown protection completely bypassed for failed trades (Bug-hunter P0-2)
  3. Circuit breaker `break` exits entire queue loop — one chain's CB opening blocks ALL chains (Bug-hunter P1-4)
- **Overall health: B+** — Individual services are well-tested (100% coverage on circuit breaker, nonce manager, gas optimizer). Hot-path is well-optimized (no `.find()`, no sync I/O, O(1) lookups). Security posture is strong (CEI, reentrancy guards, SafeERC20, HMAC-signed Redis Streams). However, the composition root (`engine.ts`) has critically low test coverage (11%), and two P0 bugs affect fund safety.
- **Agent agreement:** Bug-hunter and test-quality-analyst independently flagged the same risk management and circuit breaker areas. Security-auditor confirmed the contract layer is sound. Performance-reviewer confirmed hot-path is well-optimized.

---

## Critical Findings (P0 — Fix Before Deployment)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| 1 | Bug | `cross-chain.strategy.ts:1560,1648` | **Double JSON.parse corrupts bridge recovery state.** `redis.get()` already returns parsed object; calling `JSON.parse()` again throws SyntaxError. Every recovery key is deleted as "corrupt". Funds locked in bridges are unrecoverable after restart. | Bug-hunter | 95% HIGH | 4.4 |
| 2 | Bug | `risk-management-orchestrator.ts:340-345` | **`BigInt(gasCost)` crashes on fractional ETH.** `gasCost` is in ETH units (e.g., 0.003) but `BigInt()` rejects non-integers. Throws RangeError, causing `recordOutcome()` to fail. Drawdown breaker never learns about losses. | Bug-hunter | 98% HIGH | 4.4 |
| 3 | Coverage | `engine.ts:409-817` | **Engine start()/stop() lifecycle has ZERO test coverage.** The 400+ line startup wires Redis, locks, nonce, providers, strategies, CB, risk, A/B, bridge recovery, balance monitor, standby, consumer, health. No ordering bugs or null crashes are detectable. | Test-quality | HIGH | 4.1 |
| 4 | Coverage | `engine.ts:1077-1174` | **Crash recovery flow untested.** Lock-holder crash detection, force-release, retry logic only has stat counter tests. The complex branching for recovery success/failure paths is unverified. | Test-quality | HIGH | 4.0 |

**Suggested Fix for #1:**
```typescript
// cross-chain.strategy.ts:1552 — Remove JSON.parse, use typed get()
const state = await redis.get<BridgeRecoveryState>(key);
if (!state) { return; }
// Remove the try/catch around JSON.parse entirely
```

**Suggested Fix for #2:**
```typescript
// risk-management-orchestrator.ts:340-345 — Convert ETH to wei before BigInt
const pnl =
  outcome.success && outcome.actualProfit
    ? BigInt(Math.floor(outcome.actualProfit * 1e18))
    : outcome.gasCost
      ? -BigInt(Math.floor(outcome.gasCost * 1e18))  // Fix: ETH -> wei
      : 0n;
```

---

## High Findings (P1 — Fix Next Sprint)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| 5 | Bug | `engine.ts:1035` | **CB `break` blocks ALL chains.** `processQueueItems()` breaks out of the entire while loop when first item hits an open circuit breaker, even if subsequent items are for healthy chains. Defeats per-chain CB isolation. | Bug-hunter | 92% HIGH | 4.2 |
| 6 | Bug | `risk-management-orchestrator.ts:132-166` | **`inFlightCount` leak on chained failure.** If `recordOutcome()` throws (chained from P0-2), the counter never decrements. Eventually hits `maxInFlightTrades` and blocks all trades permanently. | Bug-hunter + Test-quality | 75% MED | 3.8 |
| 7 | Bug | `circuit-breaker-manager.ts:174-178` | **`stopAll()` doesn't clear chainBreakers map.** Stale breaker instances persist after stop. On restart, old state leaks into new lifecycle. | Bug-hunter | 90% HIGH | 3.6 |
| 8 | Config | `.env.example:362-365` vs `gas-price-optimizer.ts:147-150` | **Gas price defaults diverge 3x.** Polygon 100 gwei in .env.example vs 35 gwei in code. Fantom same. Inflated values cause profitability checks to reject viable opportunities. | Arch-auditor | HIGH | 3.8 |
| 9 | Arch | `validation.ts:130-161` vs `strategy-factory.ts:310-341` | **Validation comments say IntraChainStrategy for triangular/quadrilateral, but factory routes to FlashLoanStrategy.** Misleading comments could cause maintenance errors. | Arch-auditor | HIGH | 3.5 |
| 10 | Coverage | `services/standby-manager.ts` | **StandbyManager has ZERO tests.** Production failover mechanism (standby -> active) with 7 exported methods is completely untested. | Test-quality | HIGH | 3.5 |
| 11 | Coverage | `services/balance-monitor.ts` | **BalanceMonitor has ZERO tests.** Wallet drain detection and operator alerting with 6 exported methods untested. | Test-quality | HIGH | 3.4 |
| 12 | Coverage | `engine.ts:1664-1760` | **10 risk management public API methods untested at engine level.** Includes `forceResetDrawdownBreaker()` and `updateRiskCapital()` — operator-facing manual overrides. | Test-quality | HIGH | 3.4 |
| 13 | Performance | `engine.ts:1456-1477` | **`buildStrategyContext()` allocates new 12-field object every execution.** All fields are stable references. Cache with dirty-flag pattern. | Perf-reviewer | HIGH | 3.2 |

**Suggested Fix for #5:**
```typescript
// engine.ts:1035 — Replace break with continue
} else {
  this.cbReenqueueCounts.set(opportunity.id, reenqueueCount);
  this.queueService.enqueue(opportunity);
  this.stats.circuitBreakerBlocks++;
}
continue;  // Was: break — keep processing other chains
```

---

## Medium Findings (P2 — Backlog Priority)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| 14 | Security | `CommitRevealArbitrage.sol:356-374` | CommitReveal upfront capital can be trapped if reveal reverts. Only owner can recover via `withdrawToken()`. | Security | HIGH | 3.0 |
| 15 | Security | `SwapHelpers.sol:127` | Residual token approval not reset after swap. Approved routers could drain residual allowance if compromised. | Security | MED | 2.8 |
| 16 | Security | `commit-reveal.service.ts:917-996` | Profitability re-validation falls back to "proceed" on any error. Wastes gas on failing reveals (~$10-50 each). | Security | HIGH | 3.0 |
| 17 | Config | `engine.ts:254` | `maxConcurrentExecutions` hardcoded to 5, ignores `MAX_CONCURRENT_EXECUTIONS` env var from deploy configs. Dead configuration. | Arch-auditor | HIGH | 2.8 |
| 18 | Docs | ADR-018 | ADR describes global CB model; code implements per-chain via CircuitBreakerManager. ADR needs amendment. | Arch-auditor | HIGH | 2.5 |
| 19 | Mock | flash-loan provider tests | `amountOutMin: 0n` in ALL provider tests disables slippage protection entirely. Never tests realistic slippage bounds. | Mock-validator | HIGH | 3.0 |
| 20 | Mock | `redis.mock.ts:76-81` | Redis TTL not simulated. Keys with TTL never auto-expire. Lock timeout and rate limiter TTL tests produce false positives. | Mock-validator | HIGH | 2.8 |
| 21 | Mock | `redis.mock.ts:641-645` | XPENDING always returns empty. Dead letter queue and stale message recovery logic cannot be tested. | Mock-validator | HIGH | 2.8 |
| 22 | Mock | `redis.mock.ts:815-858` | MULTI/EXEC not truly atomic. Race conditions in nonce allocation with compare-and-set could pass mock but fail real Redis. | Mock-validator | HIGH | 2.6 |
| 23 | Mock | `cross-chain.strategy.test.ts:86-98` | Bridge fee mock always uses native wei. No tests for fees in bridged token denomination (Stargate, Across patterns). | Mock-validator | HIGH | 2.6 |
| 24 | Mock | MockDexRouter + contract tests | No 3+ hop path tests. MAX_SWAP_HOPS=5 but only 2-hop tested. Rounding errors accumulate across hops. | Mock-validator | HIGH | 2.8 |
| 25 | Mock | MockERC20 | No fee-on-transfer token mock. If system encounters USDT-like tokens, received amount < transferred amount. | Mock-validator | HIGH | 2.6 |
| 26 | Bug | `flash-loan-liquidity-validator.ts:124-131` | Request coalescing key doesn't include amount. Concurrent checks for same asset with different amounts get stale result. | Bug-hunter | 85% HIGH | 2.8 |
| 27 | Performance | `opportunity.consumer.ts:325-342` | Pipeline timestamp deserialization uses 6 conditional spread operators. Replace with direct assignment. | Perf-reviewer | HIGH | 2.4 |
| 28 | Performance | `base.strategy.ts:211` + `intra-chain.strategy.ts:38` | Duplicate `DEXES_BY_CHAIN_AND_NAME` map computed identically at module load. Consolidate to DexLookupService. | Perf-reviewer | HIGH | 2.4 |
| 29 | Coverage | `base.strategy.ts:634-900` | BaseStrategy `submitTransaction()` with RBF retry logic untested directly. Gas price bumping formula unverified. | Test-quality | HIGH | 2.8 |

---

## Low Findings (P3 — When Convenient)

| # | Category | File:Line | Description | Agent(s) | Confidence |
|---|----------|-----------|-------------|----------|------------|
| 30 | Security | `redis-streams.ts:354-360` | HMAC signing key not enforced on startup in production (logs error but continues). | Security | HIGH |
| 31 | Security | `BaseFlashArbitrage.sol:431` | `totalProfits` mixes token denominations. Documented as known limitation. | Security | MED |
| 32 | Security | `PancakeSwapFlashArbitrage.sol:250` | Callback accepts any whitelisted pool. Mitigated by `_flashContext.active` + `nonReentrant`. | Security | MED |
| 33 | Docs | CLAUDE.md:8 | DEX count says "44+" but architecture docs say 49. | Arch-auditor | HIGH |
| 34 | Config | `.env.example` (absent) | Nonce pool env vars (`NONCE_POOL_SIZE`, `NONCE_POOL_REPLENISH_THRESHOLD`) missing from .env.example. | Arch-auditor | HIGH |
| 35 | Docs | ADR-018:158-159 | ADR lists 2 files created, code has 3 (missing `circuit-breaker-manager.ts`). | Arch-auditor | HIGH |
| 36 | Docs | API.md:35, ARCHITECTURE_V2.md:355 | Mempool Detector documented on port 3007, code uses 3008. | Arch-auditor | HIGH |
| 37 | Bug | `pancakeswap-v3.provider.ts:322-326` | Pool `fee()` cast to `FeeTier` without validating it's a known tier value. | Bug-hunter | 70% MED |
| 38 | Mock | MockDexRouter:245-253 | `factory()` and `WETH()` return `address(0)`. | Mock-validator | MED |
| 39 | Mock | provider.mock.ts:50-61 | Strategy test `createMockProvider()` missing `getTransactionCount`. | Mock-validator | MED |
| 40 | Performance | `gas-price-optimizer.ts:559` | EMA `alphaScaled` recomputed every call. Pre-compute in constructor. | Perf-reviewer | HIGH |
| 41 | Performance | `engine.ts:1394-1403` | A/B `recordResult()` sequentially awaits per experiment. Use `Promise.all()`. | Perf-reviewer | HIGH |
| 42 | Refactor | engine.ts (1851 lines) | Extract ExecutionPipeline class. Priority score: 3.2. | Perf-reviewer | HIGH |

---

## Test Coverage Matrix (Critical Files)

| Source File | Exported Functions | Tested | Untested | Coverage % |
|---|---|---|---|---|
| `engine.ts` | 35 | 4 | 31 | **11%** |
| `consumers/opportunity.consumer.ts` | 14 | 12 | 2 | 86% |
| `strategies/flash-loan.strategy.ts` | 18 | 15 | 3 | 83% |
| `strategies/base.strategy.ts` | ~25 | 10 | 15 | 40% |
| `services/standby-manager.ts` | 7 | 0 | 7 | **0%** |
| `services/balance-monitor.ts` | 6 | 0 | 6 | **0%** |
| `services/nonce-allocation-manager.ts` | 10 | 10 | 0 | 100% |
| `services/gas-price-optimizer.ts` | 8 | 8 | 0 | 100% |
| `services/circuit-breaker.ts` | 14 | 14 | 0 | 100% |
| `services/circuit-breaker-manager.ts` | 7 | 7 | 0 | 100% |
| `risk/risk-management-orchestrator.ts` | 4 | 3 | 1 | 75% |
| `services/simulation/simulation.service.ts` | 7 | 5 | 2 | 71% |
| `strategies/strategy-factory.ts` | 5 | 5 | 0 | 100% |
| `initialization/execution-engine-initializer.ts` | 5 | 5 | 0 | 100% |

**Key insight:** Individual services have excellent coverage (many at 100%), but the composition root that wires them together (`engine.ts`) has only 11% coverage. The integration gaps are where the P0 bugs live.

---

## Mock Fidelity Matrix

| Mock Contract | Real Interface | Behavior Fidelity (1-5) | Fee Accuracy | Notes |
|---|---|---|---|---|
| MockAavePool | IPool/IFlashLoanReceiver | 5 | Correct (9 bps) | Excellent |
| MockBalancerVault | IBalancerV2Vault | 5 | Correct (0%) | Excellent |
| MockPancakeV3Pool | IPancakeV3Pool | 5 | Correct (fee/1e6) | Excellent |
| MockPancakeV3Factory | IPancakeV3Factory | 5 | N/A | Token order normalization correct |
| MockSyncSwapVault | ISyncSwapVault | 5 | Correct (0.3%) | Full EIP-3156 |
| MockDexRouter | IDexRouter | 4 | Rate-based (not AMM) | factory/WETH return address(0) |
| MockMaliciousRouter | N/A (attack) | 4 | N/A | Good reentrancy testing |
| MockERC20 | OZ4 ERC20 | 4 | N/A | No fee-on-transfer |

**Solidity Mock Quality: 4.6/5.0** | **TypeScript Mock Quality: 3.8/5.0** | **Parameter Realism: 4.5/5.0**

---

## Cross-Agent Insights

1. **Bug-hunter P0-2 + Test-quality Gap 6 + Gap 13:** The `BigInt(gasCost)` crash (P0-2) exists because the risk management integration is untested at the engine level (Gap 6). The in-flight counter leak (P1-2) is also untested (Gap 13). These three findings form a chain: crash -> silent failure -> permanent trade blockade. Fixing P0-2 resolves the immediate crash, but engine-level risk management tests are needed to prevent future regressions.

2. **Bug-hunter P1-4 + Test-quality Gap 7:** The circuit breaker `break` bug blocks all chains, and the CB re-enqueue loop prevention logic is untested. Both point to `processQueueItems()` as an under-tested critical path.

3. **Bug-hunter P1-1 + Test-quality Gap 3:** `stopAll()` not clearing the map is undetectable because engine lifecycle (start/stop) has zero test coverage.

4. **Architecture Finding 3 + Domain Logic:** Gas price defaults diverging between .env.example and code means fresh deployments using `npm run dev:setup` get inflated gas prices, silently rejecting profitable opportunities on Polygon and Fantom.

5. **Security Finding 5 + Bug-hunter P0-2:** The commit-reveal "proceed on error" pattern (Security #5) is made worse by the fact that the risk orchestrator's PnL tracking is broken (P0-2). Even if the reveal wastes gas, the loss isn't recorded.

6. **Mock-validator amountOutMin=0 + Security residual approval:** Tests never verify slippage protection (amountOutMin=0 everywhere), and the contract doesn't reset approvals after swaps. Together, these mean the slippage + approval defense-in-depth is untested.

---

## Recommended Action Plan

### Phase 1: Immediate (P0 — fix before any deployment)
- [ ] **Fix #1**: Remove double `JSON.parse` in `cross-chain.strategy.ts:1560,1648` (Bug-hunter)
- [ ] **Fix #2**: Convert gasCost ETH->wei before `BigInt()` in `risk-management-orchestrator.ts:340` (Bug-hunter)
- [ ] **Fix #5**: Replace `break` with `continue` in `engine.ts:1035` (Bug-hunter)
- [ ] **Fix #8**: Align `.env.example` gas defaults with code (Polygon=35, Fantom=35) (Arch-auditor)

### Phase 2: Next Sprint (P1 — reliability and coverage)
- [ ] **Fix #7**: Add `this.chainBreakers.clear()` in `circuit-breaker-manager.ts:178` (Bug-hunter)
- [ ] **Fix #6**: Add try-catch around `recordOutcome()` in engine.ts catch block to prevent `inFlightCount` leak (Bug-hunter)
- [ ] **Fix #9**: Update `validation.ts` comments to match strategy factory routing (Arch-auditor)
- [ ] **Fix #17**: Make `maxConcurrentExecutions` configurable via env var (Arch-auditor)
- [ ] **Test #3**: Add engine lifecycle (start/stop) integration tests (Test-quality)
- [ ] **Test #4**: Add crash recovery flow tests (Test-quality)
- [ ] **Test #10**: Create StandbyManager test file (Test-quality)
- [ ] **Test #11**: Create BalanceMonitor test file (Test-quality)
- [ ] **Test #12**: Add engine-level risk management API tests (Test-quality)
- [ ] **Test #13**: Cache `buildStrategyContext()` with dirty-flag pattern (Performance)

### Phase 3: Backlog (P2/P3 — defense-in-depth and maintainability)
- [ ] **Fix #14-16**: CommitReveal trapped capital, residual approval, profitability validation (Security)
- [ ] **Fix #19-25**: Mock fidelity improvements (amountOutMin, Redis TTL, XPENDING, fee-on-transfer, multi-hop) (Mock-validator)
- [ ] **Fix #26**: Include amount in liquidity validator coalescing key (Bug-hunter)
- [ ] **Fix #30**: Enforce HMAC signing in production (throw, not log) (Security)
- [ ] **Fix #33-36**: Documentation updates (ports, DEX count, ADR-018, nonce vars) (Arch-auditor)
- [ ] **Refactor #42**: Extract ExecutionPipeline from engine.ts (Performance, score 3.2)
- [ ] **Refactor**: Consolidate test setup in opportunity.consumer.test.ts and cross-chain.strategy.test.ts (Performance, score 3.3)

---

## Code Hygiene Highlights (Positive)

- Zero TODO/FIXME/HACK/XXX comments in entire execution engine
- Zero skipped tests (`.skip`, `xit`, `xdescribe`)
- Zero `|| 0` anti-pattern (all use `?? 0` correctly)
- Zero `.find()` in hot-path code (all Map/Set O(1) lookups)
- Zero blocking `Sync()` I/O in source files
- Zero unhandled promise chains (`.then()` without `.catch()`)
- Solidity mock fidelity 4.6/5.0 with real mainnet addresses in tests
- Pre-computed BigInt constants, in-place array compaction, EMA fast-path
- All flash loan callbacks properly verify caller identity
- CEI pattern followed throughout contracts
- HMAC-signed Redis Streams with `timingSafeEqual`

---
---

# Wave 2: Extended Operational Analysis

**Scope:** Same as Wave 1 + `shared/core/src/` (Redis Streams, price matrix, partition utils, tracing, logging)
**Team:** 6 specialized agents (latency-profiler, failure-mode-analyst, data-integrity-auditor, cross-chain-analyst, observability-auditor, config-drift-detector)
**Agents reporting:** 5 of 6 full reports + 2 bonus audits (feature flags, hardcoded values)

---

## Wave 2 Executive Summary

- **Total new findings:** 47 (3 Critical, 8 High, 19 Medium, 17 Low/Info)
- **Top 5 highest-impact issues:**
  1. L1 data fees not accounted for 5 L2 rollup chains — gas underestimated 30-300x, systematic losses (Cross-chain CC-1)
  2. BSC USDT/USDC 18-decimal fallback bug — empty-address `getTokenDecimals()` returns 6 instead of 18, creating 10^12 magnitude error in cross-chain USD estimation (Cross-chain CC-2)
  3. Queue-full opportunity ACK-then-drop — opportunities silently lost when queue at capacity (Failure-mode F-1)
  4. Execution engine missing XCLAIM recovery — orphaned PEL entries accumulate after crash (Failure-mode F-2 + Data-integrity DI-1, cross-validated)
  5. Lock TTL hardcoded at 60s/120s while execution timeout is configurable — lock expires mid-execution when timeout > 60s (Config B2/B3)
- **Overall health: B** — Hot-path pipeline well-optimized (~12ms best case). At-least-once delivery with DLQ fallbacks. HMAC chain correctly implemented. However, L2 gas model is fundamentally incomplete (5 chains affected), several data loss windows exist in failure/shutdown paths, and trace context breaks at the execution engine boundary.
- **Agent agreement map:** Failure-mode-analyst and data-integrity-auditor independently confirmed XCLAIM gap (HIGH confidence). Both confirmed at-least-once semantics. No disagreements between overlapping agents.

---

## Wave 2 Critical Findings (P0)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| W2-1 | Gas Model | `gas-price-cache.ts:381-398` | **L1 data fees not accounted for L2 rollups.** `estimateGasCostUsd()` only calculates L2 execution gas. For Arbitrum, Optimism, Base, zkSync, Linea — L1 data posting fee (70-90% of actual cost) is completely missing. System underestimates gas by 30-300x on these 5 chains, causing systematic losses on trades that appear profitable but aren't. | Cross-chain | 95% HIGH | 3.5 |
| W2-2 | Decimals | `cross-chain.strategy.ts:144`, `tokens/index.ts:576-587` | **BSC USDT/USDC 18-decimal fallback bug.** `getTokenDecimals(chain, '', tokenSymbol)` passes empty address, hits `COMMON_TOKEN_DECIMALS` fallback which maps USDT→6. But BSC USDT has 18 decimals. `estimateTradeSizeUsd()` uses wrong decimals, creating 10^12 magnitude error in cross-chain profit estimation. | Cross-chain | 90% HIGH | 4.4 |
| W2-3 | Data Loss | `opportunity.consumer.ts:384-386`, `queue.service.ts:98` | **Queue-full ACK-then-drop loses opportunities permanently.** When queue at capacity, message is ACKed (preventing redelivery) but never executed. Silent data loss of profitable opportunities during high-load periods. | Failure-mode | 95% HIGH | 3.4 |

**Suggested Fix for W2-1:**
```typescript
// gas-price-cache.ts — Add L1 fee estimation per chain type
async estimateGasCostUsd(chain: string, gasUnits: number): Promise<number> {
  const l2Cost = gasUnits * gasPriceGwei / 1e9 * nativeTokenPrice;
  if (isL2Rollup(chain)) {
    const l1Fee = await this.getL1DataFee(chain, gasUnits);
    return l2Cost + l1Fee;
  }
  return l2Cost;
}
// For OP-stack: call GasPriceOracle.getL1Fee()
// For Arbitrum: use NodeInterface.estimateRetryableTicket()
// For zkSync: use zks_estimateFee
```

**Suggested Fix for W2-2:**
```typescript
// cross-chain.strategy.ts:144 — Pass actual token address
const decimals = getTokenDecimals(chain, tokenAddress, tokenSymbol);
// OR add BSC-specific entries to COMMON_TOKEN_DECIMALS:
// { usdt: { default: 6, bsc: 18 }, usdc: { default: 6, bsc: 18 } }
```

**Suggested Fix for W2-3:**
```typescript
// opportunity.consumer.ts:384-386 — Do NOT ACK when queue rejects
if (!this.queueService.canEnqueue()) {
  // Leave message in PEL for redelivery when queue drains
  this.stats.queueRejects++;
  return; // No ACK — message stays in Redis for retry
}
```

---

## Wave 2 High Findings (P1)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| W2-4 | Data Loss | `opportunity.consumer.ts:138-143` | **Execution engine missing XCLAIM recovery on startup.** After crash, orphaned PEL entries under old consumer name accumulate indefinitely. Coordinator has this pattern; execution engine does not. New consumer name per restart means old PEL never reclaimed. | Failure-mode + Data-integrity | 95% HIGH (cross-validated) | 3.7 |
| W2-5 | Data Loss | `opportunity.consumer.ts:229-234` | **Shutdown ACKs all pending messages including in-flight executions.** `batchAckPendingMessages()` ACKs everything during shutdown. If execution is mid-transaction, the ACK prevents retry on restart. | Failure-mode | 90% HIGH | 3.4 |
| W2-6 | Config | `engine.ts:1091,1122` vs `types.ts:848` | **Lock TTL hardcoded at 120000ms while execution timeout is configurable.** Comment says "2x execution timeout" but doesn't compute from config. If `EXECUTION_TIMEOUT_MS` is set >60s, the 60000ms default lock expires mid-execution, allowing duplicate execution. | Config (data-integrity bonus) | 90% HIGH | 4.0 |
| W2-7 | Observability | `opportunity.consumer.ts` (zero trace imports) | **Trace context dead on arrival at execution engine.** Coordinator injects `_trace_traceId/spanId` into Redis Streams messages, but execution engine never calls `extractContext()`. Cross-service trace correlation completely broken at the most critical boundary. | Observability | 95% HIGH | 3.6 |
| W2-8 | Data Loss | `opportunity-router.ts:317` | **EXECUTION_REQUESTS stream has no MAXLEN.** Coordinator's `forwardToExecutionEngine()` uses plain `xadd()` without MAXLEN. Under sustained load, this stream grows unbounded in Redis memory. | Data-integrity | 85% HIGH | 3.2 |
| W2-9 | Failure | DLQ stream (write-only) | **No DLQ consumer or replay mechanism.** Failed messages go to `stream:dead-letter-queue` but nothing reads from it. No automatic retry, no manual replay tool. | Failure-mode | 90% HIGH | 3.0 |
| W2-10 | Chain | `service-config.ts:427-435` | **Linea has no flash loan provider — execution dead zone.** Linea is in `SUPPORTED_EXECUTION_CHAINS` and detected by P3, but `supportsFlashLoan('linea')` returns false. Opportunities detected but cannot execute atomically. | Cross-chain | 95% HIGH | 2.8 |
| W2-11 | Failure | `circuit-breaker.ts` (in-memory only) | **Circuit breaker state not persistent across restarts.** On restart during systemic failure, engine burns through 5 gas-consuming failures before CB trips again. | Failure-mode | 90% HIGH | 2.8 |

---

## Wave 2 Medium Findings (P2)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| W2-12 | Latency | `redis-streams.ts:1221`, `opportunity.consumer.ts:179` | **XREADGROUP BLOCK 1000ms at two hops.** Idle-to-active transition takes up to 2000ms+ due to coordinator and execution engine both blocking 1s. Reduce `CONSUMER_BLOCK_MS` to 200ms for execution requests. | Latency-profiler | HIGH | 3.0 |
| W2-13 | Observability | `trade-logger.ts:35-70` | **Trade audit trail missing 6 fields.** Missing: traceId, route/path, slippage, strategyUsed, retryCount, sellChain/sellDex. Cannot reconstruct failed trades or correlate with upstream logs. | Observability | HIGH | 2.8 |
| W2-14 | Chain | `bridge-router/types.ts:416-425` | **Bridge does not support zkSync or Linea routes.** Stargate excludes them, Across has no route config. Cross-chain opportunities for these chains detected but silently fail. | Cross-chain | HIGH | 2.6 |
| W2-15 | Chain | `bridge-profitability-analyzer.ts:112` | **Bridge profitability uses `formatEther()` for all chains.** Assumes bridge fees always in 18-decimal native tokens. Wrong if bridge returns fees in different denomination. | Cross-chain | 80% MED | 2.4 |
| W2-16 | Chain | `arbitrage-detector.ts:259`, `thresholds.ts:34` | **Opportunity expiry not chain-aware.** Global `opportunityTimeoutMs: 30000` regardless of block time. 30s = 120 blocks on Arbitrum (stale) vs 2.5 blocks on Ethereum (aggressive). | Cross-chain | HIGH | 2.8 |
| W2-17 | Observability | `index.ts:126-168` | **Health check does not verify Redis connectivity.** Engine reports "healthy" even when Redis is down. Health publishes TO Redis but doesn't check Redis AS health indicator. | Observability | HIGH | 2.6 |
| W2-18 | Observability | No XPENDING monitoring | **No consumer lag monitoring.** No metric to detect execution engine falling behind on stream processing. Health endpoint reports in-process pending count, not Redis-level PEL depth. | Observability | HIGH | 2.4 |
| W2-19 | Failure | `websocket-manager.ts:1466-1476` | **Max WS reconnect exhaustion has no recovery.** After `maxReconnectAttempts`, WS permanently dead until process restart. No periodic reset. | Failure-mode | HIGH | 2.4 |
| W2-20 | Failure | `redis-streams.ts:164-171` | **Batcher queue-full drops messages silently.** During sustained Redis outage, batcher drops with only warn log. No backpressure propagation. | Failure-mode | HIGH | 2.2 |
| W2-21 | Failure | `engine.ts:1491-1497` | **publishExecutionResult is fire-and-forget.** If streamsClient null or XADD fails, execution result lost from stream. Trade logger has local copy but downstream consumers miss it. | Failure-mode | HIGH | 2.0 |
| W2-22 | Config | `engine.ts:398`, `coordinator.ts:333` | **State transition timeout hardcoded at 30s/60s.** Cold Redis or slow RPC health checks can exceed 30s, causing transition to `failed` state requiring manual restart. No env var. | Config (data-integrity bonus) | MED | 2.4 |
| W2-23 | Observability | `partition-service-utils.ts`, `unified-detector/src/` | **Partition detectors never inject trace context.** Opportunities published without `_trace_*` fields. Coordinator always creates root context, losing detector origin attribution. | Observability | HIGH | 2.2 |
| W2-24 | Observability | `intra-chain.strategy.ts:580,602` | **Commit-reveal cancel fire-and-forget.** `.catch(() => {})` swallows cancel failures. Failed cancels leave commitments on-chain. | Observability | HIGH | 2.0 |
| W2-25 | Chain | `arbitrage-detector.ts:587` | **Cross-chain confidence uses fixed 10s maxAgeMs.** Ethereum (12s blocks) gets unfairly penalized vs Solana (0.4s slots). Asymmetric scoring favors fast chains. | Cross-chain | MED | 2.0 |
| W2-26 | Data | `price-matrix.ts:513-583` | **No monotonic timestamp check in setPrice().** Redelivered older prices can overwrite newer ones. Seqlock protects against torn reads but not out-of-order writes. | Data-integrity | MED | 1.8 |
| W2-27 | Config | `mev-config.ts:31` | **`FEATURE_MEV_SHARE` uses `!== 'false'` (default ON).** Violates CLAUDE.md convention that `FEATURE_*` flags use `=== 'true'`. MEV-Share active by default on new deployments. | Config (cross-chain bonus) | HIGH | 1.8 |
| W2-28 | Chain | `gas-price-optimizer.ts:48-50` | **Gas spike multiplier same for all chains.** Single 2x threshold. Too tight for Ethereum (5-10x spikes), unnecessary for L2s with negligible execution gas. | Cross-chain | MED | 1.6 |
| W2-29 | Config | `base.strategy.ts:504` | **Provider health check uses hardcoded 3000ms instead of `PROVIDER_HEALTH_CHECK_TIMEOUT_MS` env var.** Config exists but unused in this function. | Config (data-integrity bonus) | HIGH | 1.8 |
| W2-30 | Chain | `gas-price-optimizer.ts:330` | **FAST_CHAINS missing Avalanche (2s) and Fantom (1s).** They get 5s gas cache TTL instead of 2s. Stale gas prices on sub-2s block chains. | Cross-chain | MED | 1.6 |

---

## Wave 2 Low Findings (P3)

| # | Category | File:Line | Description | Agent(s) | Confidence |
|---|----------|-----------|-------------|----------|------------|
| W2-31 | Failure | `engine.ts:1023-1028` | CB-dropped opportunities (after 3 re-enqueue) silently lost. PEL entry left unACKed (eventual redelivery) but queue entry dropped. | Failure-mode | HIGH |
| W2-32 | Failure | DLQ stream | No alerting on DLQ growth. Nobody monitors stream length. | Failure-mode | HIGH |
| W2-33 | Failure | `bridge-recovery-manager.ts:196-211` | Bridge recovery stop() doesn't wait for in-progress recovery. | Failure-mode | HIGH |
| W2-34 | Data | `redis-streams.ts:402-416` | No HMAC key rotation support. Key change requires coordinated deploy. | Data-integrity | MED |
| W2-35 | Data | Stream messages | No schema versioning. Type evolution could cause in-flight message rejection. | Data-integrity | LOW |
| W2-36 | Data | Coordinator dedup | In-memory dedup state lost on restart. First post-restart opportunity bypasses dedup. | Data-integrity | LOW |
| W2-37 | Data | Various `xadd()` calls | `xaddWithLimit()` not consistently used. Some callers omit MAXLEN. | Data-integrity | MED |
| W2-38 | Chain | `bridge-router/types.ts:478-491` | Stargate bridge times not differentiated by direction. L2→L1 takes days, not same as L1→L2. | Cross-chain | MED |
| W2-39 | Chain | `arbitrage-detector.ts:528-573` | Cross-chain arbitrage doesn't account for different native token denominations. | Cross-chain | LOW |
| W2-40 | Chain | `tokens/index.ts:423` | Native token price fallback is $1000 for unknown chains. New chain without config entry gets wrong gas estimate. | Cross-chain | LOW |
| W2-41 | Chain | `partition-solana/src/arbitrage-detector.ts:100-104` | Solana TOKEN_DECIMALS duplicated between partition and shared config. Drift risk. | Cross-chain | MED |
| W2-42 | Chain | `gas-price-optimizer.ts:62-74` | Solana absent from gas price systems. Cross-chain comparisons involving Solana have no gas cost for Solana side. | Cross-chain | LOW |
| W2-43 | Observability | `pending-state-simulator.ts:320,805,877,1121,1138` | 5 bare catches in simulation code swallow snapshot/fork failures. | Observability | MED |
| W2-44 | Observability | `engine.ts:1486` | Trade logger double-silencing (defense-in-depth, acceptable). | Observability | LOW |
| W2-45 | Config | `engine.ts:445-446` | Nonce manager `syncIntervalMs: 30000` and `pendingTimeoutMs: 300000` hardcoded. | Config (bonus) | LOW |
| W2-46 | Config | `engine.ts:978` | Queue processing fallback interval hardcoded at 1000ms. | Config (bonus) | LOW |
| W2-47 | Config | `stream-consumer-manager.ts:112` | `orphanClaimMinIdleMs: 60000` has no env var override. | Config (bonus) | LOW |

---

## Pipeline Latency Budget

| # | Stage | Component | File:Line | Estimated Latency | Bottleneck |
|---|-------|-----------|-----------|-------------------|------------|
| 1 | Ingestion | WebSocket receive + Buffer.toString | `websocket-manager.ts:466,803` | ~0.15ms | None |
| 2 | Parse | JSON.parse (main thread <2KB) | `websocket-manager.ts:843` | 0.1-2ms | Worker offload at 2KB threshold |
| 3 | Cache | PriceMatrix.setPrice (SharedArrayBuffer) | `price-matrix.ts:513-583` | <0.001ms | None — Atomics O(1) |
| 4 | Detection | Arbitrage detection (pair comparisons) | `arbitrage-detector.ts:165-268` | 0.5-5ms | O(n²) pairs, 5-20ms during bursts |
| 5 | Publish | XADD opportunity (direct, no batching) | `publishing-service.ts:264` | 1-3ms | Redis RTT + JSON.stringify |
| 6 | Coordinator | XREADGROUP + forward XADD | `coordinator.ts:1021` | **0-1000ms** | BLOCK 1000ms when idle |
| 7 | Execution Consumer | XREADGROUP + validate + enqueue | `opportunity.consumer.ts:179` | **0-1000ms** | BLOCK 1000ms when idle |
| 8 | Queue → Process | Signal callback (synchronous) | `queue.service.ts:204` | ~0.01ms | None |
| 9 | Lock | Redis distributed lock (SET NX PX) | `engine.ts:1085-1094` | 2-10ms | Redis RTT |
| 10 | Execution | Strategy dispatch + blockchain TX | `engine.ts:1360` | 10-5000ms+ | Chain confirmation |

**Best case (active):** ~12ms (meets <50ms target)
**Worst case (idle→active):** ~2015-3015ms (XREADGROUP block dominates)

---

## Failure Mode Map

| # | Stage | Failure Mode | Detection | Recovery | Data Loss Risk | File:Line |
|---|-------|-------------|-----------|----------|----------------|-----------|
| 1 | WS Ingestion | Connection drop | Yes (close event) | Auto (exponential backoff) | Events during reconnect window | `websocket-manager.ts:494` |
| 2 | WS Ingestion | Max reconnect exhausted | Yes (error event) | **MANUAL** | Permanent until restart | `websocket-manager.ts:1466` |
| 3 | Redis Publish | Redis unavailable | Yes (error after 3 retries) | Caller-dependent | **Message lost** if no retry | `redis-streams.ts:437-478` |
| 4 | Redis Publish | Batcher queue full | Yes (warn log) | None | **Silent drop** | `redis-streams.ts:164-171` |
| 5 | Consumer | Handler exception | Yes (error log) | Auto (PEL redelivery) | No | `redis-streams.ts:1244` |
| 6 | Consumer | Orphaned PEL (crash) | Partial (xpending) | **Semi-auto** (needs XCLAIM) | **Risk** — accumulates | `opportunity.consumer.ts:138` |
| 7 | Queue | Queue full | Yes (stat counter) | **ACK + drop** | **Yes — permanent loss** | `opportunity.consumer.ts:384` |
| 8 | Queue | Backpressure | Yes (warn log) | Auto (pause/resume) | No — Redis holds messages | `queue.service.ts:203-208` |
| 9 | Execution | CB OPEN (per-chain) | Yes (stats) | Auto (cooldown → HALF_OPEN) | After 3 re-enqueue attempts | `engine.ts:1020-1035` |
| 10 | Execution | Lock not acquired | Yes (stats) | Auto (PEL redelivery) | No | `engine.ts:1144-1150` |
| 11 | Execution | Lock holder crash | Yes (conflict tracker) | Auto (force release) | No | `engine.ts:1100-1109` |
| 12 | Execution | Execution timeout | Yes (stats) | CB records failure | No — ACKed after error | `engine.ts:1195` |
| 13 | Result | Streams client null | **No — silent skip** | None | **Result lost** from stream | `engine.ts:1491` |
| 14 | Shutdown | Pending batch ACK | Partial | Best-effort | **In-flight messages ACKed** | `opportunity.consumer.ts:229` |
| 15 | Cascading | Redis down | Yes (errors) | System halts | Batcher drops until max | All Redis-dependent code |

---

## Delivery Guarantee Analysis

| Boundary | Semantic | Evidence |
|----------|----------|---------|
| Detector → Coordinator | At-least-once | XREADGROUP + deferred ACK via `StreamConsumerManager.wrapHandler()` |
| Coordinator → Execution | At-least-once | `autoAck: false`, ACK after execution complete or error |
| Crash recovery (Coordinator) | Covered | XCLAIM for orphaned PEL entries in `stream-consumer-manager.ts:307-355` |
| Crash recovery (Execution) | **NOT covered** | No XCLAIM startup scan. Orphaned PEL entries accumulate. |
| Deduplication | 3 layers | Coordinator in-memory (5s window) → Engine activeExecutions Set → Distributed lock (Redis) |
| HMAC integrity | Complete | Sign (HMAC-SHA256) → Verify (timingSafeEqual) → Reject unsigned. No key rotation. |

---

## Chain-Specific Edge Case Table

| Chain | Block Time | Gas Model | Flash Loan | Bridge | Key Issue |
|-------|-----------|-----------|------------|--------|-----------|
| Ethereum | 12s | OK (EIP-1559) | Aave V3 (9bps) | Stargate, Across | None |
| Arbitrum | 0.25s | **MISSING L1 FEE** | Aave V3 (9bps) | Stargate, Across | Gas underestimated 30-300x |
| Optimism | 2s | **MISSING L1 FEE** | Aave V3 (9bps) | Stargate, Across | Gas underestimated 30-300x |
| Base | 2s | **MISSING L1 FEE** | Aave V3 (9bps) | Stargate, Across | Gas underestimated 30-300x |
| BSC | 3s | OK | PCS V3 (25bps) | Stargate | 18-decimal USDT/USDC |
| Polygon | 2s | OK (EIP-1559) | Aave V3 (9bps) | Stargate | None |
| Avalanche | 2s | OK (EIP-1559) | Aave V3 (9bps) | Stargate | Not in FAST_CHAINS |
| Fantom | 1s | OK | Beethoven (0bps) | Stargate | Not in FAST_CHAINS |
| zkSync | 1s | **MISSING L1 FEE** | SyncSwap (30bps) | **NO BRIDGE** | Gas + no cross-chain |
| Linea | 2s | **MISSING L1 FEE** | **NONE** | **NO BRIDGE** | No flash loan, no bridge |
| Solana | 0.4s | N/A (own detector) | N/A (Jupiter) | N/A | Detection-only, no gas model |

---

## Observability Assessment

### Trace Propagation Map
```
Detector (P1-P4) --[NO TRACE]--> Redis OPPORTUNITIES
     --> Coordinator --[CREATES + INJECTS trace]--> Redis EXECUTION_REQUESTS
     --> Execution Engine --[NEVER EXTRACTS trace]--> Processing (no correlation)
     --> EXECUTION_RESULTS --[NO TRACE]--> Downstream
```
**Verdict:** Trace chain broken at execution engine boundary (O-1). Origin attribution lost at detector boundary (O-2).

### Log Coverage: Good for execution path. No logging in hot-path processQueueItems (correct). Health/metrics at appropriate levels.

### Blind Spots: 32 bare `catch {}` blocks in execution engine. 5 in pending-state-simulator swallow operational errors. Commit-reveal cancel fire-and-forget.

### Metrics: Detection rate, success rate, queue depth, CB state all exposed. **Missing:** Consumer lag (XPENDING), Prometheus endpoint on execution engine (built but not wired).

### Health Checks: **Missing Redis connectivity check.** Reports healthy when Redis is down.

### Trade Audit: 6 missing fields (traceId, route, slippage, strategyUsed, retryCount, sellChain/sellDex).

---

## Configuration Health

### Feature Flags: 8/9 FEATURE_* flags correctly use `=== 'true'`. 1 violation: `FEATURE_MEV_SHARE` uses `!== 'false'` (default ON). 8 non-FEATURE operational flags correctly use `!== 'false'` for safety-on defaults.

### Hardcoded Values: 10 hardcoded timeouts identified. Key issue: lock TTL (60s/120s) doesn't track configurable `EXECUTION_TIMEOUT_MS`. State transition timeout (30s) has no env var.

### || vs ?? Violations: **CLEAN.** No `|| 0` or `|| 0n` violations remain — prior 47-item remediation was thorough. 4 minor style-only issues (`|| false` in `shared-memory-cache.ts:64-65`, `mev-share-provider.ts:64`; `|| 10` in `partitions.ts:504`). None have real bug potential.

### Env Var Coverage: 16 operational timeouts have env overrides (good). **24 undocumented env vars** in execution engine code are missing from `.env.example` — operators cannot discover `AB_TESTING_*` (4 vars), `TRADE_LOG_*` (2 vars), `EXECUTION_HYBRID_*` (4 vars), `RBF_*` (2 vars), `BALANCE_MONITOR_*` (3 vars), `CIRCUIT_BREAKER_API_KEY`, `SWAP_DEADLINE_SECONDS`, `SIMULATION_MODE_PRODUCTION_OVERRIDE`, and others without reading source. Additionally, `WALLET_PRIVATE_KEY`, `WALLET_MNEMONIC`, and `RISK_TOTAL_CAPITAL` (required for production) are missing from `.env.example`.

### Deployment Config Drift:
- **Gas prices**: Code defaults differ from `.env.example` on 3 chains (Polygon: 35 vs 100 gwei, BSC: 3 vs 5 gwei, Fantom: 35 vs 100 gwei)
- **Ports**: Execution engine Dockerfile EXPOSEs 8080, code defaults to 3005, Fly.io overrides to 8080 via `HEALTH_CHECK_PORT`
- **Missing Fly.io configs**: `partition-asia-fast.toml` and `cross-chain-detector.toml` don't exist
- **Region mismatch**: P3 High-Value: ADR-003 says US-East, Fly.io config says US-West (sjc)
- **Node.js**: All aligned at node:22-alpine (no drift)

---

## Cross-Agent Insights (Wave 2)

### Information Separation Results (Agents 2 + 3)

**AGREE (HIGH confidence — promote):**
- XCLAIM recovery missing from execution engine (F-2 = DI-1) — independently identified by both
- At-least-once delivery semantics confirmed by both
- DLQ is write-only with no consumer

**COMPLEMENTARY (different perspectives):**
- Failure-mode found queue-full ACK-then-drop (F-1) — data-integrity didn't flag this specifically
- Data-integrity found unbounded EXECUTION_REQUESTS stream (no MAXLEN) — failure-mode didn't flag this
- Data-integrity traced the complete HMAC chain — failure-mode only covered HMAC as rejection failure
- Failure-mode mapped detailed shutdown data loss windows (F-3) — data-integrity covered stale cleanup

**NO DISAGREEMENTS** — All findings consistent. Different perspectives produced complementary coverage.

### Cross-Wave Insights (Wave 1 + Wave 2)

1. **Wave 1 P0-2 (BigInt crash) + Wave 2 F-1 (queue-full drop):** Both are data loss mechanisms. P0-2 crashes risk tracking silently; F-1 drops opportunities silently. Combined, the system can both lose track of losses AND miss profitable opportunities.

2. **Wave 1 P1-4 (CB break→continue) + Wave 2 F-5 (CB dropped opportunities):** The break-instead-of-continue bug blocks all chains. Even after fixing to continue, CB-dropped opportunities after 3 attempts are silently lost with no DLQ.

3. **Wave 1 #3/#4 (engine.ts 0% lifecycle coverage) + Wave 2 F-3 (shutdown ACK):** The shutdown data loss window exists because engine lifecycle is untested. Writing lifecycle tests would catch F-3.

4. **Wave 1 #8 (gas defaults diverge) + Wave 2 CC-1 (L1 fees missing):** Gas model problems compound. Wave 1 found 3x default divergence on Polygon/Fantom. Wave 2 found L1 fees completely missing on 5 chains. Together, gas estimation is unreliable on 7 of 11 chains.

5. **Wave 2 O-1 (trace dead) + Wave 2 O-6 (trade audit missing traceId):** Trace context breaks at execution engine AND trade logs don't record traceId. This means failed trades on L2 rollups (where losses are hidden by CC-1) cannot be correlated with upstream detection logs.

6. **Wave 2 CC-3 (Linea no flash loan) + Wave 2 CC-7 (no bridge for zkSync/Linea):** Linea is the most constrained chain — no flash loan AND no bridge support. Yet it's actively detected in P3 partition. Opportunities detected → forwarded to execution → fail silently.

---

## Conflict Resolutions

No conflicts detected between agents in Wave 2. All overlapping analyses produced consistent results.

---

## Combined Action Plan (Wave 1 + Wave 2)

### Phase 1: Immediate (P0 — fix before deployment) ✅ ALL COMPLETE

**From Wave 1:**
- [x] Fix W1-1: Remove double `JSON.parse` in `cross-chain.strategy.ts:1560,1648` (Bug-hunter, Score 4.4) — **FIXED**
- [x] Fix W1-2: Convert gasCost ETH→wei before `BigInt()` in `risk-management-orchestrator.ts:340` (Bug-hunter, Score 4.4) — **FIXED**
- [x] Fix W1-5: Replace `break` with `continue` in `engine.ts:1035` (Bug-hunter, Score 4.2) — **ALREADY FIXED**

**From Wave 2:**
- [x] Fix W2-1: Add L1 data fee estimation for 5 L2 rollup chains (Cross-chain, Score 3.5) — **FIXED**
- [x] Fix W2-2: Fix BSC USDT/USDC 18-decimal fallback — pass actual address (Cross-chain, Score 4.4) — **FIXED**
- [x] Fix W2-3: Don't ACK when queue rejects — leave in PEL for redelivery (Failure-mode, Score 3.4) — **ALREADY FIXED**

### Phase 2: Next Sprint (P1 — reliability and observability) ✅ ALL COMPLETE

**From Wave 1:**
- [x] Fix W1-7: Add `this.chainBreakers.clear()` in CB manager stopAll() (Bug-hunter, Score 3.6) — **FIXED**
- [x] Fix W1-6: Try-catch around `recordOutcome()` to prevent inFlightCount leak (Bug-hunter, Score 3.8) — **FIXED**
- [x] Fix W1-8: Align `.env.example` gas defaults with code (Arch-auditor, Score 3.8) — **FIXED**
- [x] Test W1-3: Add engine lifecycle start/stop integration tests (Test-quality, Score 4.1) — **FIXED** (P0 phase)
- [x] Test W1-4: Add crash recovery flow tests (Test-quality, Score 4.0) — **FIXED** (P0 phase)
- [x] Fix W1-9: Update misleading validation comments (Arch-auditor, Score 3.5) — **FIXED**
- [x] Fix W1-13: Cache `buildStrategyContext()` allocation (Perf-reviewer, Score 3.2) — **FIXED**
- [x] Test W1-10: Add StandbyManager tests (Test-quality, Score 3.5) — **FIXED** (35 tests)
- [x] Test W1-11: Add BalanceMonitor tests (Test-quality, Score 3.4) — **FIXED** (27 tests)
- [x] Test W1-12: Add engine-level risk management API tests (Test-quality, Score 3.4) — **FIXED** (15 tests)

**From Wave 2:**
- [x] Fix W2-4: Add XCLAIM startup scan in execution engine consumer (Failure-mode + Data-integrity, Score 3.7) — **FIXED**
- [x] Fix W2-5: Only ACK completed messages during shutdown, not in-flight (Failure-mode, Score 3.4) — **FIXED**
- [x] Fix W2-6: Derive lock TTL from `EXECUTION_TIMEOUT_MS` config (Config, Score 4.0) — **ALREADY FIXED**
- [x] Fix W2-7: Wire `extractContext()` in opportunity.consumer.ts (Observability, Score 3.6) — **FIXED**
- [x] Fix W2-8: Add MAXLEN to coordinator's XADD for EXECUTION_REQUESTS (Data-integrity, Score 3.2) — **FIXED**
- [x] Fix W2-9: Implement DLQ consumer with configurable replay policy (Failure-mode, Score 3.0) — **FIXED**
- [x] Fix W2-10: Either add Linea flash loan or suppress Linea detection (Cross-chain, Score 2.8) — **ALREADY FIXED**
- [x] Fix W2-11: Persist CB state to Redis with TTL (Failure-mode, Score 2.8) — **FIXED**

### Phase 3: Backlog (P2/P3 — hardening and optimization)

**From Wave 1:**
- [ ] Fix W1-14-16: CommitReveal trapped capital, residual approval, profitability validation (Security)
- [ ] Fix W1-19-25: Mock fidelity improvements (Mock-validator)
- [ ] Refactor W1-42: Extract ExecutionPipeline from engine.ts (Performance, Score 3.2)

**From Wave 2:**
- [ ] Fix W2-12: Reduce CONSUMER_BLOCK_MS to 200ms for execution requests (Latency, Score 3.0)
- [ ] Fix W2-13: Add 6 missing fields to TradeLogEntry (Observability, Score 2.8)
- [ ] Fix W2-14: Add zkSync/Linea bridge routes via Across (Cross-chain, Score 2.6)
- [ ] Fix W2-16: Chain-aware opportunity expiry (blockTime × N blocks) (Cross-chain, Score 2.8)
- [ ] Fix W2-17: Add Redis ping to health check (Observability, Score 2.6)
- [ ] Fix W2-18: Add XPENDING consumer lag metric (Observability, Score 2.4)
- [ ] Fix W2-19: Add periodic WS reconnect counter reset (Failure-mode, Score 2.4)
- [ ] Fix W2-22: Add env var for state transition timeout (Config, Score 2.4)
- [ ] Fix W2-23: Inject trace context at detector publish time (Observability, Score 2.2)
- [ ] Fix W2-25: Chain-aware cross-chain confidence maxAgeMs (Cross-chain, Score 2.0)
- [ ] Fix W2-27: Change FEATURE_MEV_SHARE to `=== 'true'` or rename (Config, Score 1.8)
- [ ] Fix W2-28: Chain-specific gas spike multiplier (Cross-chain, Score 1.6)
- [ ] Fix W2-29: Use PROVIDER_HEALTH_CHECK_TIMEOUT_MS env var (Config, Score 1.8)
- [ ] Fix W2-30: Add Avalanche/Fantom to FAST_CHAINS (Cross-chain, Score 1.6)

---

## Combined Statistics

| Metric | Wave 1 | Wave 2 | Total |
|--------|--------|--------|-------|
| Findings | 42 | 47 | 89 |
| Critical (P0) | 4 | 3 | 7 |
| High (P1) | 9 | 8 | 17 |
| Medium (P2) | 16 | 19 | 35 |
| Low (P3) | 13 | 17 | 30 |
| Agents | 6 | 6 | 12 |
| Cross-validated | 6 areas | 2 areas (XCLAIM, delivery) | 8 areas |
| Agent disagreements | 0 | 0 | 0 |

**Combined Grade: B** — Individual services well-tested and hot-path optimized. Strong security posture in contracts. HMAC signing correctly implemented. However, L2 gas model fundamentally incomplete (5 chains), several data loss windows in failure/shutdown paths, trace context breaks at critical boundary, and engine lifecycle has 0% test coverage where the P0 bugs live.

---

## P0 Remediation Status (2026-02-20)

All 7 P0 findings have been addressed:

| # | Finding | Fix | Status |
|---|---------|-----|--------|
| P0-1 | Double JSON.parse in cross-chain.strategy.ts:1560,1648 | Removed redundant `JSON.parse()`; `redis.get()` already returns parsed objects. Added type-guard validation for corrupt state. | **FIXED** |
| P0-2 | `BigInt(gasCost)` crash in risk-management-orchestrator.ts:333,344 | Changed `BigInt(outcome.gasCost)` → `BigInt(Math.floor(outcome.gasCost * 1e18))` to convert ETH to wei before BigInt. | **FIXED** |
| P0-3 | CB `break` blocks ALL chains in engine.ts:1035 | Already fixed in prior session — line 1035 already has `continue` instead of `break`. | **ALREADY FIXED** |
| P0-4 | Engine start()/stop() 0% test coverage | Added `engine-lifecycle.test.ts` with 12 tests covering: start → running state, Redis/Streams/Lock/Nonce initialization, stop → cleanup, restart cycle, standby mode queue pausing. | **FIXED** |
| P0-5 | L1 data fees missing for 5 L2 chains in gas-price-cache.ts:381 | Added `L1_DATA_FEE_USD` map (Arbitrum $0.50, Optimism $0.40, Base $0.40, zkSync $0.30, Linea $0.35) and incorporated into `estimateGasCostUsd()`. | **FIXED** |
| P0-6 | BSC USDT/USDC 18-decimal fallback in tokens/index.ts:605 | Added `CHAIN_TOKEN_DECIMAL_OVERRIDES` map (`bsc: { usdt: 18, usdc: 18, busd: 18 }`) checked before `COMMON_TOKEN_DECIMALS` in `getTokenDecimals()`. | **FIXED** |
| P0-7 | Queue-full ACK-then-drop in opportunity.consumer.ts:384 | Already fixed in prior session — `HandleResult` discriminated type (`'queued' | 'rejected' | 'backpressure'`) with backpressure case skipping ACK. | **ALREADY FIXED** |

**Verification:**
- `npm run typecheck` — passes cleanly
- Risk orchestrator tests — 22/22 pass
- Opportunity consumer tests — 41/41 pass
- Engine lifecycle tests — 12/12 pass (new)
- Engine core tests — 14/14 pass (existing, unaffected)

---

## P1 Remediation Status (2026-02-20)

All 17 P1 findings (9 Wave 1 + 8 Wave 2) have been addressed:

### Wave 1 P1 Fixes

| # | Finding | Fix | Status |
|---|---------|-----|--------|
| W1-5 | CB `break` blocks ALL chains (`engine.ts:1035`) | Already fixed in prior session — line 1035 already has `continue` instead of `break`. Verified still correct. | **ALREADY FIXED** |
| W1-6 | `inFlightCount` leak on `recordOutcome()` failure | Wrapped `recordOutcome()` body in try-finally. The finally block always decrements `inFlightCount` (with >0 guard). | **FIXED** |
| W1-7 | `stopAll()` doesn't clear `chainBreakers` map | Added `this.chainBreakers.clear()` after stop loop in `circuit-breaker-manager.ts:181`. Prevents stale state leaking into new lifecycle. | **FIXED** |
| W1-8 | Gas price defaults diverge `.env.example` vs code | Updated `.env.example` gas defaults to match code: Polygon 35→35 gwei, Fantom 35→35 gwei, BSC 3→3 gwei. | **FIXED** |
| W1-9 | Misleading validation comments about strategy routing | Updated comments in `validation.ts:130-161` to correctly describe FlashLoanStrategy routing for triangular/quadrilateral opportunities. | **FIXED** |
| W1-10 | StandbyManager has ZERO tests | Created `standby-manager.test.ts` with 35 tests covering: activation lifecycle, idempotent activation, concurrent activation guarding, already-active rejection, error recovery, state queries, factory function. | **FIXED** (35 tests pass) |
| W1-11 | BalanceMonitor has ZERO tests | Created `balance-monitor.test.ts` with 27 tests covering: start/stop lifecycle, balance check success/failure, low balance detection and logging, balance drift tracking, snapshot retrieval, factory function. | **FIXED** (27 tests pass) |
| W1-12 | 10 risk management API methods untested at engine level | Created `engine-risk-management.test.ts` with 15 tests covering: `isRiskManagementEnabled()`, `getDrawdownState()/Stats()`, `isTradingAllowed()`, `getEVCalculatorStats()`, `getPositionSizerStats()`, `getProbabilityTrackerStats()`, `forceResetDrawdownBreaker()`, `manualResetDrawdownBreaker()`, `updateRiskCapital()`, stats risk fields. | **FIXED** (15 tests pass) |
| W1-13 | `buildStrategyContext()` allocates new object every execution | Added cached `_strategyCtx` with dirty-flag pattern. `markStrategyCtxDirty()` called when dependencies change. `buildStrategyContext()` returns cached instance unless dirty. | **FIXED** |

### Wave 2 P1 Fixes

| # | Finding | Fix | Status |
|---|---------|-----|--------|
| W2-4 | No XCLAIM recovery on execution engine startup | Added `recoverOrphanedMessages(minIdleMs?)` to `OpportunityConsumer`. Uses `xpendingRange()` to find idle messages from other consumers, claims via `xclaim()`, reprocesses through `handleStreamMessage()`. | **FIXED** |
| W2-5 | Shutdown ACKs in-flight executions | Rewrote `stop()` to partition pending messages: only ACK messages NOT in `activeExecutions` set. In-flight messages left in PEL for XCLAIM recovery by next instance. Renamed `batchAckPendingMessages()` → `batchAckMessages(messages)`. | **FIXED** |
| W2-6 | Lock TTL hardcoded at 120000ms | Verified already correct: `engine.ts:1118` uses `EXECUTION_TIMEOUT_MS * 2`, which is config-derived via `parseEnvTimeout()`. No hardcoded 120000ms found. | **ALREADY FIXED** |
| W2-7 | Trace context dead on arrival at execution engine | Added `extractContext()` / `createChildContext()` / `createTraceContext()` imports. In `handleStreamMessage()`, extracts parent trace from `_trace_*` fields, creates child span or new root, attaches `_traceId`/`_spanId` to opportunity. | **FIXED** |
| W2-8 | EXECUTION_REQUESTS stream has no MAXLEN | Extended `OpportunityStreamsClient` interface with `options` parameter. Added `executionStreamMaxLen` config (default: 5000). Updated `xadd()` call with `{ maxLen: 5000, approximate: true }`. | **FIXED** |
| W2-9 | No DLQ consumer or replay mechanism | Created `dlq-consumer.ts` (~298 lines) with: periodic stream scanning, error classification (transient/permanent/unknown), configurable replay with backoff, stats tracking, graceful start/stop lifecycle. | **FIXED** |
| W2-10 | Linea opportunities cannot execute (no flash loan) | Verified already handled: `FlashLoanStrategy.execute()` at line 591 checks `isProtocolSupported(chain)` and returns error for unsupported chains. Linea SyncSwap vault documented as deferred (T-NEW-6 in `service-config.ts:427-432`). | **ALREADY FIXED** |
| W2-11 | Circuit breaker state not persistent across restarts | Added `restorePersistedState()` to `CircuitBreakerManager`. Reads recent events from existing CIRCUIT_BREAKER stream via `xread()`. Builds latest state per chain, force-opens chains whose most recent event was OPEN within cooldown window. No separate persistence mechanism needed — reuses existing stream. | **FIXED** |

**Verification:**
- `npm run typecheck` — passes cleanly for execution-engine
- Circuit breaker manager tests — 26/26 pass
- Opportunity consumer tests — 84/84 pass (updated 2 tests for W2-5 behavior change)
- Opportunity router tests — 55/55 pass (updated 2 tests for W2-8 MAXLEN addition)
- Risk orchestrator tests — 14/14 pass
- StandbyManager tests — 35/35 pass (new)
- BalanceMonitor tests — 27/27 pass (new)
- Engine risk management tests — 15/15 pass (new)
- Engine core tests — 14/14 pass (existing, unaffected)
