# Deep Analysis Report — Risk Module Profitability Fixes

**Date:** 2026-03-08
**Scope:** `git diff HEAD` (10 files, +320/-382 lines)
**Model:** Claude Opus 4.6
**Analysis Type:** Full 6-agent deep analysis (all 6 agents reported back)

---

## Executive Summary

| Severity | Count |
|----------|-------|
| **Critical (P0)** | 3 |
| **High (P1)** | 4 |
| **Medium (P2)** | 7 |
| **Low (P3)** | 6 |
| **Total** | 20 |

**Top 3 Highest-Impact Issues:**
1. **P0-1**: Initializer doesn't pass new config fields to components — gas-budget mode, rolling window, and per-chain EV thresholds are **dead features** (configured in RISK_CONFIG but never reach components)
2. **P0-2**: `checkDailyReset()` corrupts rolling window mode — midnight reset zeros rolling PnL and exits CAUTION state
3. **P0-3**: Polygon/Avalanche EV thresholds reject all viable trades (10-20x gas cost margins)

**Overall Health Grade: C+**
The new risk features (rolling drawdown, gas-budget mode, per-chain EV) address real profitability gaps but have a critical wiring gap (config not propagated to components), a state corruption bug (midnight reset vs rolling window), overly conservative chain thresholds, and zero unit tests. The features are architecturally sound at the component level but non-functional end-to-end until the initializer is fixed.

**Agent Agreement Map:** 4 agents independently flagged the rolling window midnight reset bug (bug-hunter, security-auditor, architecture-auditor, team-lead). 3 agents flagged `forceReset()` not clearing `tradeHistory` (bug-hunter, security-auditor, team-lead). 3 agents flagged `clear()` not clearing `gasSpendHistory` (bug-hunter, security-auditor, team-lead).

---

## Diff Summary

| File | Lines Changed | Category |
|------|--------------|----------|
| `shared/core/src/risk/drawdown-circuit-breaker.ts` | +49 | Rolling 24h drawdown window |
| `shared/core/src/risk/ev-calculator.ts` | +62 | Per-chain EV thresholds |
| `shared/core/src/risk/position-sizer.ts` | +142 | Gas-budget position sizing |
| `shared/core/src/risk/types.ts` | +37 | Type definitions for new features |
| `shared/config/src/risk-config.ts` | +40 | Config + env var overrides |
| `services/execution-engine/src/risk/risk-management-orchestrator.ts` | +1/-1 | Configurable maxInFlightTrades |
| `shared/core/src/analytics/index.ts` | -16 | PerformanceAnalyticsEngine export removal |
| `shared/core/src/index.ts` | -11 | PerformanceAnalyticsEngine re-export removal |
| `shared/core/__tests__/unit/risk/ev-calculator.test.ts` | +3 | Test fix for per-chain threshold |
| `docs/reports/PROFITABILITY_AUDIT_2026-02-24.md` | -340 | Old report deletion |

---

## Critical Findings (P0)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| 1 | Architecture | `risk-management-initializer.ts:134-194` | New config fields not passed to components — features are dead | architecture-auditor | HIGH (99%) | 5.0 |
| 2 | Bug | `drawdown-circuit-breaker.ts:471-498` | `checkDailyReset()` corrupts rolling window mode | bug-hunter, security, arch, lead | HIGH (95%) | 4.6 |
| 3 | Parameters | `ev-calculator.ts:75-95` | Polygon/Avalanche/Solana EV thresholds wrong | mock-fidelity | HIGH (90%) | 4.0 |

### P0-1: New config fields not passed to components (DEAD FEATURES)

**Found by:** architecture-auditor
**Evidence:** `risk-management-initializer.ts` builds config objects for each risk component but omits all new fields:

- **EV Calculator** (lines 134-141): Builds `EVConfig` with 6 fields but omits `chainMinEVThresholds`. The per-chain EV thresholds defined in `CHAIN_MIN_EV_THRESHOLDS` (ev-calculator.ts:75-95) are hardcoded in the component, not configurable via RISK_CONFIG. The `chainMinEVThresholds` type field (types.ts:219) is never populated from config.

- **Position Sizer** (lines 162-168): Builds `PositionSizerConfig` with 5 fields but omits `useGasBudgetMode`, `maxGasPerTrade`, `dailyGasBudget`. These ARE defined in RISK_CONFIG (risk-config.ts:194-207) but never forwarded. Gas-budget mode defaults to `false` in DEFAULT_CONFIG, so it's permanently disabled.

- **Drawdown Breaker** (lines 184-194): Builds `DrawdownConfig` with 9 fields but omits `useRollingWindow`. This IS defined in RISK_CONFIG (risk-config.ts:109) but never forwarded. Rolling window defaults to `undefined` (falsy), so it's permanently disabled.

**Impact:** All 3 new features are non-functional in production. Setting `RISK_GAS_BUDGET_MODE=true`, `RISK_USE_ROLLING_DRAWDOWN=true`, or any chain EV threshold env vars has zero effect — the values never reach the components.

**Suggested fix:** Add missing fields to all 3 config builders in `risk-management-initializer.ts`:
```typescript
// EV Calculator (line 141):
// Note: chainMinEVThresholds would need to be added to RISK_CONFIG first,
// or the built-in CHAIN_MIN_EV_THRESHOLDS already provide good defaults

// Position Sizer (line 168):
useGasBudgetMode: RISK_CONFIG.positionSizing.useGasBudgetMode,
maxGasPerTrade: RISK_CONFIG.positionSizing.maxGasPerTrade,
dailyGasBudget: RISK_CONFIG.positionSizing.dailyGasBudget,

// Drawdown Breaker (line 194):
useRollingWindow: RISK_CONFIG.drawdown.useRollingWindow,
```

### P0-2: `checkDailyReset()` corrupts rolling window mode

**Found by:** bug-hunter (BUG-3), security-auditor (SEC-R-002), architecture-auditor, team-lead
**Evidence:** When `useRollingWindow=true`, the `checkDailyReset()` method (line 471) is still called on every `isTradingAllowed()` (line 188), `recordTradeResult()` (line 264), and `getState()` (line 404). At UTC midnight, this method:

1. Sets `this.state.dailyPnL = 0n` (line 490) — zeroing the rolling window's computed PnL
2. Transitions `CAUTION -> NORMAL` (line 493-495) — exiting protective state regardless of rolling 24h losses

**Data flow trace:**
```
isTradingAllowed()
  -> checkDailyReset()           // Line 188
    -> this.state.dailyPnL = 0n  // Line 490: ZEROS rolling PnL
    -> transitionTo('NORMAL')    // Line 494: EXITS CAUTION
  -> returns { allowed: true, state: 'NORMAL', sizeMultiplier: 1.0 }
  // ... even though rolling 24h losses still exceed cautionThreshold
```

In `recordTradeResult()`, the rolling recompute on line 282 overwrites the zeroed value, so the corruption is temporary. But in `isTradingAllowed()` and `getState()`, there is NO recompute — the zeroed value persists until the next `recordTradeResult()` call.

**Impact:** At UTC midnight, the circuit breaker silently exits CAUTION state and allows full-size trading even when the rolling 24h PnL is still deep in loss territory.

**Suggested fix:**
```typescript
private checkDailyReset(): void {
  // Skip midnight reset entirely in rolling window mode
  if (this.config.useRollingWindow) {
    return;
  }
  // ... existing midnight reset logic ...
}
```

### P0-3: Polygon/Avalanche EV thresholds reject viable trades; Solana missing

**Found by:** mock-fidelity-validator
**Evidence:**
- **Polygon** (`ev-calculator.ts:90`): `CHAIN_MIN_EV_THRESHOLDS.polygon = 1000000000000000000n` (1.0 MATIC, ~$1.00) but gas cost is only 0.1 MATIC (~$0.10). **10x gas cost ratio** — rejects all trades with $0.10-$0.99 EV.
- **Avalanche** (`ev-calculator.ts:92`): `CHAIN_MIN_EV_THRESHOLDS.avalanche = 20000000000000000n` (0.02 AVAX, ~$0.80) but gas cost is only 0.001 AVAX (~$0.04). **20x gas cost ratio** — rejects most viable trades.
- **Solana**: Missing from both `CHAIN_DEFAULT_GAS_COSTS` and `CHAIN_MIN_EV_THRESHOLDS`. Falls back to `default: 0.001 ETH (~$2.50)` — **5000x** actual Solana gas cost (~$0.0005).

**Impact:** Polygon and Avalanche chains are effectively blocked from profitable trading. Solana gas estimation is catastrophically wrong.

**Suggested fix:**
```typescript
// Polygon: 10x -> 2x safety margin
polygon: 200000000000000000n,  // 0.2 MATIC (~$0.20)
// Avalanche: 20x -> 5x safety margin
avalanche: 5000000000000000n,  // 0.005 AVAX (~$0.20)
// Add Solana to both maps
solana: 5000000n,  // ~5000 lamports (~$0.0005) for gas costs
// solana EV threshold: 50000000n  // 0.00005 SOL (~$0.01)
```

---

## High Findings (P1)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| 4 | Bug | `drawdown-circuit-breaker.ts:353-376` | `forceReset()` doesn't clear `tradeHistory[]` | bug-hunter, security, lead | HIGH (95%) | 4.0 |
| 5 | Bug | `position-sizer.ts:265-274` | `clear()`/`destroy()` don't clear `gasSpendHistory[]` | bug-hunter, security, lead | HIGH (95%) | 3.7 |
| 6 | Coverage | Multiple files | Zero unit tests for all 3 new features | test-quality, lead | HIGH (100%) | 4.3 |
| 7 | Bug | `position-sizer.ts:427` | Gas budget commits spend before execution (phantom accounting) | bug-hunter | HIGH (95%) | 3.5 |

### P1-4: `forceReset()` doesn't clear `tradeHistory[]`

**Found by:** bug-hunter (EDGE-2), security-auditor (SEC-R-002), team-lead
**Evidence:** `forceReset()` at line 373 calls `createInitialState()` which resets `this.state`, but `tradeHistory` is a separate class field (line 117). After reset, `computeRollingDailyPnL()` still sees pre-reset losses.

**Impact:** Force reset is unreliable when `useRollingWindow=true` — operator force-resets expecting clean slate, but breaker immediately re-enters CAUTION from pre-reset losses.

**Suggested fix:** Add `this.tradeHistory = [];` to `forceReset()`.

### P1-5: `clear()`/`destroy()` don't clear `gasSpendHistory[]`

**Found by:** bug-hunter (BUG-2), security-auditor (SEC-R-001), team-lead
**Evidence:** `clear()` at line 265-274 resets 6 numeric counters but NOT `gasSpendHistory` (line 73) or `rejectedGasBudget` (line 74). Stale gas history persists across `clear()` calls, artificially depleting the daily gas budget.

**Suggested fix:** Add `this.gasSpendHistory = []; this.rejectedGasBudget = 0;` to `clear()`.

### P1-6: Zero unit tests for all 3 new features

**Found by:** test-quality-analyst, team-lead
**Evidence:** Exhaustive grep confirms 0 tests for: `useRollingWindow`, `computeRollingDailyPnL`, `pruneTradeHistory`, `useGasBudgetMode`, `calculateGasBudgetSize`, `computeRollingGasSpend`, `gasSpendHistory`, `CHAIN_MIN_EV_THRESHOLDS` (dedicated), `getChainMinEVThreshold`.

**Test-quality-analyst's gap matrix:**
- Rolling drawdown: 0/12 tests needed (CRITICAL)
- Gas-budget sizing: 0/5 tests needed (CRITICAL)
- Per-chain EV thresholds: PARTIAL (only singleton config fix test)
- Overall new-feature coverage grade: **D**

### P1-7: Gas budget commits spend before trade execution

**Found by:** bug-hunter (BUG-1)
**Evidence:** At `position-sizer.ts:427`, gas spend is pushed to `gasSpendHistory` when the trade is *approved*, not when it *executes*. If the trade fails downstream (execution failure, revert, timeout), the gas is still counted against the budget.

**Data flow:** `assess()` -> `calculateSize()` -> `calculateGasBudgetSize()` -> pushes to `gasSpendHistory` (line 427) -> trade may later fail -> gas spend is never reclaimed.

**Impact:** With 50% downstream rejection rate, effective daily gas budget is halved. Once the phantom-depleted budget is exhausted, ALL subsequent trades are rejected for the remainder of the 24h window.

**Suggested fix:** Remove the push from line 427. Add a `recordGasSpend(gas: bigint)` public method. Have the execution engine call it after confirmed tx submission.

---

## Medium Findings (P2)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| 8 | Config | `risk-config.ts:305-380` | `validateRiskConfig()` missing gas-budget validation | bug-hunter, lead | HIGH (95%) | 3.0 |
| 9 | Config | `.env.example` | 5 new env vars undocumented | arch-auditor, lead | HIGH (100%) | 2.7 |
| 10 | Architecture | `drawdown-circuit-breaker.ts:20` | Doc comment stale for rolling window mode | arch-auditor, lead | MEDIUM (80%) | 2.3 |
| 11 | Architecture | `ev-calculator.ts:75-95` | Per-chain thresholds hardcoded, not in RISK_CONFIG | arch-auditor | HIGH (90%) | 3.0 |
| 12 | Architecture | `risk-config.ts` vs component DEFAULT_CONFIGs | Config DRY violation — defaults in 2 places | arch-auditor | MEDIUM (80%) | 2.5 |
| 13 | Security | `position-sizer.ts:375-449` | Gas-budget mode ignores `winProbability` in EV check | security-auditor | MEDIUM (75%) | 2.2 |
| 14 | Security | `drawdown-circuit-breaker.ts:633-636` | MAX_TRADE_HISTORY=10000 may truncate valid losses | security-auditor | MEDIUM (70%) | 2.0 |

### P2-8: `validateRiskConfig()` doesn't validate gas-budget fields

**Found by:** bug-hunter (MINOR-1), team-lead
No checks for `maxGasPerTrade > 0n`, `dailyGasBudget > 0n`, or `maxGasPerTrade <= dailyGasBudget`. Setting `dailyGasBudget=0` blocks all trades silently.

### P2-9: 5 new env vars undocumented in `.env.example`

Missing: `RISK_USE_ROLLING_DRAWDOWN`, `RISK_GAS_BUDGET_MODE`, `RISK_MAX_GAS_PER_TRADE`, `RISK_DAILY_GAS_BUDGET`, `RISK_MAX_IN_FLIGHT_TRADES`.

### P2-10: Doc comment stale for rolling window mode

`drawdown-circuit-breaker.ts:20` states "Any -> NORMAL: New trading day (daily reset at UTC midnight)" — not true when rolling window is enabled.

### P2-11: Per-chain EV thresholds hardcoded, not in RISK_CONFIG

**Found by:** architecture-auditor
`CHAIN_MIN_EV_THRESHOLDS` (ev-calculator.ts:75-95) is hardcoded in the component rather than centralized in RISK_CONFIG. Adjusting thresholds requires a code change + redeploy. The config type (`chainMinEVThresholds?: Record<string, bigint>`) exists but RISK_CONFIG doesn't populate it.

### P2-12: Config DRY violation

**Found by:** architecture-auditor
DEFAULT_CONFIG in each component (ev-calculator.ts:112-119, position-sizer.ts:32-41, drawdown-circuit-breaker.ts:41-54) duplicates defaults from RISK_CONFIG. Comment at ev-calculator.ts:110 says "FIX P2-6: Aligned DEFAULT_CONFIG with RISK_CONFIG values" but alignment is manual — can drift.

### P2-13: Gas-budget mode ignores `winProbability`

**Found by:** security-auditor (SEC-R-004)
Gas-budget mode checks `input.expectedProfit <= gasCost` (raw comparison, line 381) but ignores `winProbability`. A trade with 10% win probability but profit > gas would pass. Mitigated by EVCalculator running first in the pipeline.

### P2-14: MAX_TRADE_HISTORY=10000 may truncate valid losses

**Found by:** security-auditor (SEC-R-005)
At high throughput, the hard cap drops oldest entries even if within the 24h window, understating daily losses and delaying CAUTION/HALT triggers.

---

## Low Findings (P3)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| 15 | Performance | `drawdown-circuit-breaker.ts:631` | `Array.splice(0, n)` is O(n) | perf-reviewer, lead | HIGH (95%) | 1.8 |
| 16 | Performance | `drawdown-circuit-breaker.ts:609-617` | `computeRollingDailyPnL()` O(n) scan every trade | perf-reviewer | HIGH (90%) | 1.6 |
| 17 | Dead Code | `analytics/performance-analytics.ts` | Source + test file remain after export removal | arch-auditor, lead | HIGH (100%) | 1.5 |
| 18 | Consistency | `position-sizer.ts:471` | `.slice()` vs `.splice()` inconsistency | perf-reviewer, lead | MEDIUM (75%) | 1.2 |
| 19 | Security | `risk-config.ts:269` | No upper bound on `maxInFlightTrades` or BigInt configs | security-auditor | LOW (60%) | 1.0 |
| 20 | Docs | `ev-calculator.ts:77` | Ethereum EV threshold below gas cost — undocumented | mock-fidelity | MEDIUM (80%) | 1.3 |

### P3-15 & P3-16: O(n) operations in rolling window

**Found by:** performance-reviewer
`pruneTradeHistory()` uses O(n) splice; `computeRollingDailyPnL()` iterates all entries. At MAX_TRADE_HISTORY=10000, ~5-15ms per prune. Not hot-path (confirmed), but performance-reviewer recommends a running accumulator for O(1) rolling PnL.

### P3-17: Dead code after export removal

Source file `analytics/performance-analytics.ts` and test file still exist after exports removed.

### P3-20: Ethereum EV threshold below gas cost

`CHAIN_MIN_EV_THRESHOLDS.ethereum = 0.005 ETH` but `CHAIN_DEFAULT_GAS_COSTS.ethereum = 0.01 ETH`. This is intentional (positive EV possible at >50% win probability) but undocumented — needs a code comment.

---

## Test Coverage Matrix

| Source File | Feature | Happy Path | Error Path | Edge Cases | Regression |
|-------------|---------|------------|------------|------------|------------|
| `drawdown-circuit-breaker.ts` | Rolling 24h window | MISSING | MISSING | MISSING | MISSING |
| `drawdown-circuit-breaker.ts` | Rolling + midnight interaction | MISSING | MISSING | MISSING | MISSING |
| `drawdown-circuit-breaker.ts` | `forceReset()` + tradeHistory | MISSING | MISSING | MISSING | MISSING |
| `drawdown-circuit-breaker.ts` | MAX_TRADE_HISTORY cap | MISSING | MISSING | MISSING | MISSING |
| `position-sizer.ts` | Gas-budget mode (approve) | MISSING | MISSING | MISSING | MISSING |
| `position-sizer.ts` | Gas-budget mode (reject: gas > profit) | MISSING | MISSING | MISSING | MISSING |
| `position-sizer.ts` | Gas-budget mode (reject: per-trade cap) | MISSING | MISSING | MISSING | MISSING |
| `position-sizer.ts` | Gas-budget mode (reject: daily budget) | MISSING | MISSING | MISSING | MISSING |
| `position-sizer.ts` | Rolling gas spend | MISSING | MISSING | MISSING | MISSING |
| `position-sizer.ts` | `clear()` + gasSpendHistory | MISSING | MISSING | MISSING | MISSING |
| `ev-calculator.ts` | Per-chain EV thresholds | PARTIAL* | MISSING | MISSING | MISSING |
| `ev-calculator.ts` | `getChainMinEVThreshold()` fallback | MISSING | MISSING | MISSING | MISSING |
| `ev-calculator.ts` | Config override for chain thresholds | PARTIAL* | MISSING | MISSING | MISSING |
| `ev-calculator.ts` | L2 approved vs L1 rejected | MISSING | MISSING | MISSING | MISSING |
| `risk-config.ts` | Gas-budget config validation | MISSING | MISSING | MISSING | MISSING |
| `risk-management-initializer.ts` | New fields forwarded | MISSING | MISSING | MISSING | MISSING |
| `risk-management-orchestrator.ts` | Configurable maxInFlightTrades | EXISTING | EXISTING | MISSING | EXISTING |

*PARTIAL: Only incidental coverage via the singleton config test fix (`ev-calculator.test.ts:725`).

---

## Cross-Agent Insights

1. **P0-1 (dead features) amplifies all other findings**: The initializer wiring gap means P0-2 (midnight corruption), P0-3 (wrong thresholds), P1-4 (forceReset), P1-5 (clear), and P1-7 (phantom gas) are all latent bugs — they can't trigger in production until P0-1 is fixed. However, they'll all activate simultaneously once the initializer is fixed.

2. **4-agent agreement on P0-2**: Bug-hunter, security-auditor, architecture-auditor, and team-lead all independently identified the rolling window midnight reset conflict. This is the highest-confidence finding in the report.

3. **Bug-hunter + security-auditor both flagged P1-4 and P1-5** (forceReset + clear not clearing new arrays). Same root pattern: when adding stateful arrays to existing classes, lifecycle methods must be updated.

4. **Mock-fidelity-validator caught what code analysis missed**: The Polygon/Avalanche threshold issue (P0-3) is a domain-logic error, not a code bug. Code-focused agents (bug-hunter, security-auditor) don't evaluate whether numerical constants are realistic for the domain.

5. **Performance-reviewer confirmed non-hot-path**: All 5 performance concerns are in code called once per opportunity (~0.1 calls/sec), NOT in the price-update -> detection hot path. Current O(n) patterns are acceptable but could be optimized with a running accumulator for `computeRollingDailyPnL()`.

6. **Test-quality-analyst's coverage matrix aligns with team-lead's**: Both independently identified 0% coverage for rolling window (12 tests needed), gas-budget mode (5 tests needed), and chain EV thresholds (partial). Combined recommendation: ~35-40 new tests before deployment.

---

## Recommended Action Plan

### Phase 1: Immediate (P0 + P1 — fix before any deployment)

- [ ] **Fix P0-1**: Add missing config fields to `risk-management-initializer.ts` (3 config builders: EV, Position, Drawdown)
- [ ] **Fix P0-2**: Guard `checkDailyReset()` with `if (this.config.useRollingWindow) return;`
- [ ] **Fix P0-3**: Adjust Polygon (1.0 -> 0.2 MATIC), Avalanche (0.02 -> 0.005 AVAX), add Solana to both maps
- [ ] **Fix P1-4**: Add `this.tradeHistory = [];` to `forceReset()`
- [ ] **Fix P1-5**: Add `this.gasSpendHistory = []; this.rejectedGasBudget = 0;` to `clear()`
- [ ] **Fix P1-6**: Write ~35 unit tests (12 rolling window, 5 gas-budget, 5 per-chain EV, 5 clear/reset lifecycle, 5 initializer forwarding, 3 integration)
- [ ] **Fix P1-7**: Move gas spend tracking from approval-time to post-execution (add `recordGasSpend()` method)

### Phase 2: Next Sprint (P2)

- [x] **Fix P2-8**: Add gas-budget validation to `validateRiskConfig()` — DONE (maxGasPerTrade>0, dailyGasBudget>0, maxGas<=dailyBudget)
- [x] **Fix P2-9**: Document 5 new env vars in `.env.example` — DONE (RISK_USE_ROLLING_DRAWDOWN, RISK_GAS_BUDGET_MODE, RISK_MAX_GAS_PER_TRADE, RISK_DAILY_GAS_BUDGET, RISK_MAX_IN_FLIGHT_TRADES, RISK_CHAIN_EV_THRESHOLDS)
- [x] **Fix P2-10**: Update drawdown-circuit-breaker.ts header doc for rolling window — DONE
- [x] **Fix P2-11**: Move `CHAIN_MIN_EV_THRESHOLDS` to RISK_CONFIG — DONE (JSON env var RISK_CHAIN_EV_THRESHOLDS, wired through initializer)
- [x] **Fix P2-12**: DRY violation addressed — cross-reference comments added noting RISK_CONFIG as source of truth
- [x] **Document P2-13**: Add comment noting EVCalculator is the authoritative EV gate — DONE
- [x] **Fix P2-14**: Increase MAX_TRADE_HISTORY to 50K + truncation warning log — DONE

### Phase 3: Backlog (P3)

- [x] **P3-15/16**: Running accumulator for O(1) rolling PnL — DONE (removed `computeRollingDailyPnL()`, added `rollingPnLAccumulator` maintained incrementally in `recordTradeResult()`/`pruneTradeHistory()`/`forceReset()`)
- [x] **P3-17**: Delete dead `performance-analytics.ts` source + test file — DONE (no external consumers found)
- [x] **P3-18**: Standardize array pruning pattern — DONE (position-sizer `.slice()` → `.splice()` for consistency with other risk modules)
- [x] **P3-19**: Add upper bounds to `maxInFlightTrades` — DONE (max 50 validation in `validateRiskConfig()`)
- [x] **P3-20**: Add code comment for Ethereum EV-below-gas-cost design rationale — DONE (explains EV threshold gates NET expected value, not gross profit)
