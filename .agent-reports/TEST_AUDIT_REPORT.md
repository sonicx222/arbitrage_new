# Test Suite Audit Report

**Scope**: `contracts/` (Hardhat + Chai + ethers v6)
**Date**: 2026-02-27
**Test Files Analyzed**: 13
**Test Cases Analyzed**: ~868 (622 in-file + ~246 from shared admin harness)
**Analysis Team**: 5 specialized agents (test-cataloger, source-coverage-mapper, unit-test-critic, integration-test-validator, test-consolidation-strategist)

## Executive Summary

### Health Score: A-

The contract test suite is **mature, well-organized, and follows best practices consistently**. The shared admin test harness (`shared-admin-tests.ts`) is a standout DRY pattern that eliminates ~246 lines of duplication across 6 contracts. All 8 main contracts have dedicated tests, `loadFixture()` is used universally (13/13), and error assertions are specific (only 1 bare `.to.be.reverted` in the entire suite).

**Highest-impact findings from cross-agent analysis:**
1. **SwapHelpers.sol has ZERO direct unit tests** — tested only indirectly through flash loan execution (CRITICAL gap)
2. **`calculateExpectedProfit` tested ~6x across derived contracts** — ~30 duplicate tests that could be extracted into a shared helper
3. **7 redundancy clusters identified** with ~55-62 removable tests, plus 6 new shared helper opportunities
4. **Fork tests exist only for Aave V3** — 4 other flash loan protocols lack real-protocol validation

| Dimension | Score | Notes |
|-----------|-------|-------|
| Test Necessity | 92% ESSENTIAL or VALUABLE | 1 REDUNDANT file (MockProtocolFidelity could simplify) |
| Test Quality | 85% CLEAN | 4 COULD SIMPLIFY, 1 OVER-ENGINEERED |
| Integration Authenticity | 1 AUTHENTIC fork test | MockProtocolFidelity provides partial protocol validation |
| Coverage | 100% main contracts tested | SwapHelpers.sol = CRITICAL gap (zero direct tests) |
| Placement | 100% correctly placed | All in `contracts/test/` per convention |
| Error Specificity | 99.8% specific assertions | 1 bare `.to.be.reverted` in fork test |
| Best Practices | loadFixture: 13/13 | Zero `.only`, zero `.skip`, zero skipped |

## Test Infrastructure Assessment

### Shared Helpers (EXCELLENT)

The `contracts/test/helpers/` directory contains 7 well-designed helper files:

| Helper | Purpose | Usage |
|--------|---------|-------|
| `shared-admin-tests.ts` | 8 reusable admin test suites (~41 tests each) | 6 test files |
| `common-setup.ts` | Base fixture: tokens, routers, funding, signers | All test files |
| `exchange-rates.ts` | Named rate constants, rate setup functions | All flash loan tests |
| `swap-paths.ts` | Path builder functions (2-hop, 3-hop, cross-router) | All flash loan tests |
| `commit-reveal.ts` | CommitReveal fixture, commitment hash, mineBlocks | 3 CommitReveal files |
| `balancer-v2.ts` | BalancerV2 fixture with 10x funding amounts | 2 Balancer files |
| `index.ts` | Barrel export | All test files |

**Verdict**: The shared admin test harness is a best-in-class pattern. Each derived contract gets ~41 admin tests for just 8 lines of configuration. The path builders (`build2HopPath`, `build3HopPath`) and named rate constants are well-designed but underutilized — many tests still inline their path construction.

### Standout Test: CommitReveal Same-Block MEV Resistance

The `evm_setAutomine`/`evm_mine` test in `CommitRevealArbitrage.test.ts` (lines 489-556) is one of the best timing tests in the codebase — it properly validates MEV resistance at the block level with `try/finally` for automine reset to prevent test pollution.

## P0: False Confidence (fix immediately)

**None found.** No mock theater integration tests, no zombie tests, no tests that give false confidence. All anti-patterns scanned (Mock Theater, Testing Mocks, Fragile Tests, Test Setup Towers, God Tests, Shotgun Tests, Zombie Tests) — none found at severity warranting P0.

## P1: Critical Coverage Gaps

| # | Gap | Risk | What to Test | Effort |
|---|-----|------|-------------|--------|
| 1 | **SwapHelpers.sol has ZERO direct tests** | CRITICAL | Approval reset to 0 after swap, token continuity check in isolation, output verification vs amountOutMin, forceApprove failure on non-standard tokens. Create thin wrapper contract exposing `executeSingleSwap()`. | 2-3 hrs |
| 2 | **`_simulateSwapPath` cycle detection tested in only 1 file** | HIGH | Cycle detection logic (A→B→A→B rejected, A→B→C→A accepted) is tested only in BalancerV2 callback-admin. If that file is refactored, coverage is lost. Add to shared `testCalculateExpectedProfit` helper. | 1 hr |
| 3 | **CommitRevealArbitrage.execution.test.ts missing `testSwapDeadlineConfig`** | MEDIUM | CommitReveal inherits `setSwapDeadline()` from BaseFlashArbitrage but doesn't test it. One-line fix: add import and invocation. | 5 min |
| 4 | **Fork tests only for Aave V3** | MEDIUM | 4 other flash loan protocols (BalancerV2, SyncSwap, PancakeSwap, DaiFlashMint) have no real-protocol fork tests. MockProtocolFidelity partially compensates. | 4-8 hrs each |

## P2: Consolidation Opportunities (7 Redundancy Clusters)

Cross-agent analysis identified 7 redundancy clusters with **~120 duplicated tests** and **~55-62 removable** via shared helper extraction.

### RC-1: Deployment/Initialization Tests (HIGH redundancy — 6 files, ~18-20 removable)

Each derived contract duplicates near-identical deployment checks: owner set, minimumProfit default (1e14), swapDeadline default (60), MAX_SWAP_HOPS (5), BPS_DENOMINATOR (10000), zero-address constructor rejection.

**Recommendation**: Extract `testDeploymentDefaults(config)` into shared helpers. Each file keeps ONLY protocol-specific deployment tests (e.g., DaiFlashMint: DAI address validation; PancakeSwap: poolFactory; CommitReveal: maxCommitAgeBlocks default).

### RC-2: executeArbitrage Input Validation (HIGH redundancy — 5 files, ~15-18 removable)

`_validateArbitrageParams` logic (zero amount, expired deadline, empty path, path too long, asset mismatch, unapproved router, zero slippage) tested through each derived contract's entry point in near-identical form.

**Recommendation**: Extract `testExecuteArbitrageValidation(config)` with a `triggerFunction` parameter. Each file provides its own callback trigger.

### RC-3: Profit Validation (MEDIUM — 4 files, ~6-8 removable)

InsufficientProfit revert tests (below minProfit param, below minimumProfit setting, max-of-both enforcement) duplicated across FlashLoan, BalancerV2, SyncSwap, CommitReveal execution.

### RC-4: calculateExpectedProfit Edge Cases (MEDIUM — 4 files, ~10-12 removable)

Identical edge case tests (empty path, wrong start/end token, unprofitable path) across 4 derived contracts. The cycle detection test in BalancerV2 callback-admin is the ONLY place testing this — should be promoted to shared helper.

### RC-5: Reentrancy via MockMaliciousRouter (MEDIUM — 5 files, ~4 removable)

Nearly identical reentrancy test pattern in 5 flash loan contracts. CommitReveal's cross-function reentrancy test is unique and should be kept.

### RC-6: Gas Benchmarks (LOW — 4 files, DRY improvement only)

2-hop gas budget tests are intentionally per-contract (different callback overhead). Extract setup/assertion into shared helper to reduce boilerplate. No test reduction needed.

### RC-7: Multi-Hop Triangular Execution (LOW — 4 files, helper enforcement only)

3-hop triangular arbitrage tests use similar setup. Verify all files use `setupTriangularRates()` from exchange-rates helper. No test reduction needed.

## P3: Simplification Opportunities

| # | File | Necessity | Engineering | Issue | Recommendation | Effort |
|---|------|-----------|-------------|-------|----------------|--------|
| 1 | `MockProtocolFidelity.test.ts` | VALUABLE | COULD SIMPLIFY | Tests mock contracts in isolation; some tests verify basic arithmetic (fee = amount × 9 / 10000). Implicitly covered by flash loan tests. Serves as regression guard for mock updates. | Trim from 51 to ~25-30 tests. Remove pure-arithmetic tests and PancakeSwap fee-tier-storage tests. Keep fee formulas, callback parameter passing, repayment verification. | LOW |
| 2 | `BalancerV2FlashArbitrage.callback-admin.test.ts` | ESSENTIAL | COULD SIMPLIFY | `calculateExpectedProfit` section (8 tests) overlaps significantly with FlashLoan/SyncSwap equivalents. Cycle detection test is unique and valuable. | Extract to shared helper, keep cycle detection. | MEDIUM |
| 3 | `SyncSwapFlashArbitrage.test.ts` | ESSENTIAL | COULD SIMPLIFY | View function tests for `calculateExpectedProfit` (6 tests) near-identical to other files. | Extract to shared helper. | MEDIUM |
| 4 | `PancakeSwapFlashArbitrage.test.ts` | ESSENTIAL | COULD SIMPLIFY | `calculateExpectedProfit` tests (3 tests) duplicate pattern. Legacy comment markers. | Extract tests to shared helper, remove dead comments. | LOW |
| 5 | `MultiPathQuoter.test.ts` | VALUABLE | CLEAN | Does NOT use shared helpers (130+ lines of fixture setup). | Extract shared token/router deployment to use `deployBaseFixture()`. | MEDIUM |
| 6 | `FlashLoanArbitrage.test.ts` | ESSENTIAL | CLEAN | Legacy `// Note: ... now covered by shared admin harness` comments. | Remove dead comments. | LOW |

## P4: Minor Improvements

| # | File | Issue | Effort |
|---|------|-------|--------|
| 1 | `FlashLoanArbitrage.fork.test.ts:282` | Bare `.to.be.reverted` — violates project's CLAUDE.md rule. Should use `.to.be.revertedWithCustomError(flashLoanArbitrage, 'InsufficientProfit')` or try/catch for multiple error types. | 5 min |
| 2 | `SyncSwapFlashArbitrage.test.ts` | "9. Integration Tests" section should be renamed "9. End-to-End Flow Tests" — all deps are mocked. | 2 min |
| 3 | `FlashLoanArbitrage.fork.test.ts` | `console.log` statements in tests add noise. | 5 min |

## Integration Test Authenticity Matrix

| Test File | Type | Real Dependencies | Verdict |
|-----------|------|-------------------|---------|
| `FlashLoanArbitrage.fork.test.ts` | Fork integration | Real Aave V3 Pool (0x8787…), Uniswap V2 (0x7a25…), SushiSwap (0xd9e1…), canonical WETH/USDC/DAI | **AUTHENTIC** — properly gated with `FORK_ENABLED`, 120s timeout, real `FLASHLOAN_PREMIUM_TOTAL()` verification |
| `MockProtocolFidelity.test.ts` | Mock validation | Mock contracts with protocol-accurate behavior | **PARTIAL** — validates mock-vs-spec, not mock-vs-real |
| `UniswapV3Adapter.test.ts` §Integration | Cross-contract | Two non-mock production contracts (UniswapV3Adapter + FlashLoanArbitrage) interact through actual interfaces | **TRUE CROSS-CONTRACT** — strongest cross-contract test in suite |
| `SyncSwapFlashArbitrage.test.ts` §9 | "Integration Tests" | All mock contracts | **ENHANCED UNIT TEST** — mislabeled |
| All other test files | Contract unit tests | Mock protocols | **LOCAL-ONLY** (expected for Hardhat unit tests) |

### Cross-Contract Interaction Coverage

| Contract Pair | Tested? | Evidence | Gap |
|---------------|---------|----------|-----|
| FlashLoanArbitrage + Aave V3 (real) | YES | Fork test with real pool | Only verifies revert, not successful execution |
| FlashLoanArbitrage + UniswapV3Adapter | YES | UniswapV3Adapter integration section | None |
| Each flash loan contract + its mock protocol | YES | Full callback cycle per contract | None |
| Each contract + MockMaliciousRouter | YES (5/6) | Reentrancy tests | DaiFlashMint reentrancy verified |
| BalancerV2 + Real Balancer Vault | **NO** | No fork test | **GAP** |
| SyncSwap + Real SyncSwap Vault | **NO** | No fork test | **GAP** |
| PancakeSwap + Real PancakeSwap Pool | **NO** | No fork test | **GAP** |
| DaiFlashMint + Real MakerDAO DssFlash | **NO** | No fork test | **GAP** |

### MockProtocolFidelity Assessment (Agents Disagree — Resolved)

**unit-test-critic** rated this file REDUNDANT/OVER-ENGINEERED. **integration-test-validator** rated it VALUABLE.

**Resolution**: **VALUABLE but COULD SIMPLIFY**. The file serves as a regression guard for mock behavior changes — without it, mock parameter drift could silently break flash loan tests. However, ~15-20 of its 51 tests verify basic arithmetic (fee = amount × rate) that adds little risk reduction. **Recommend trimming to ~25-30 focused tests** covering: fee formulas, callback parameter passing, repayment verification, array validation. Cut: pure-arithmetic tests, PancakeSwap fee-tier-storage-only tests.

**Gap**: Tests verify mock internal consistency but have no mechanism to compare against real on-chain behavior. Missing SyncSwap callback flow test (only fee calculation tested, not the `flashLoan()` → `onFlashLoan()` callback chain).

## Contract Test Quality Matrix

| Test File | Tests | Necessity | Engineering | Standout | Top Issue |
|-----------|-------|-----------|-------------|----------|-----------|
| CommitRevealArbitrage.test.ts | 114 | ESSENTIAL | CLEAN | Same-block MEV test (evm_setAutomine) | None significant |
| CommitRevealArbitrage.security.test.ts | 27 | ESSENTIAL | CLEAN | Per-parameter hash mismatch tests | Reference-quality security file |
| CommitRevealArbitrage.execution.test.ts | ~84 | ESSENTIAL | CLEAN | Mixed valid/invalid batch reveals | Missing testSwapDeadlineConfig |
| FlashLoanArbitrage.test.ts | ~90 | ESSENTIAL | CLEAN | Comprehensive validation suite | Legacy dead comments |
| FlashLoanArbitrage.fork.test.ts | 17 | VALUABLE | CLEAN | Real protocol validation | 1 bare `.to.be.reverted` |
| BalancerV2FlashArbitrage.test.ts | 32 | ESSENTIAL | CLEAN | Break-even trade revert (Fix 4a) | None |
| BalancerV2FlashArbitrage.callback-admin.test.ts | ~77 | ESSENTIAL | COULD SIMPLIFY | `_flashLoanActive` guard via storage manipulation | calculateExpectedProfit overlap |
| SyncSwapFlashArbitrage.test.ts | ~101 | ESSENTIAL | COULD SIMPLIFY | Flash loan context guard test | Mislabeled "Integration Tests" |
| PancakeSwapFlashArbitrage.test.ts | ~85 | ESSENTIAL | COULD SIMPLIFY | Pool factory discovery tests | calculateExpectedProfit overlap |
| DaiFlashMintArbitrage.test.ts | ~78 | ESSENTIAL | CLEAN | DAI-only constraint tests | No gas benchmarks |
| MultiPathQuoter.test.ts | 46 | VALUABLE | CLEAN | DOS protection (MAX_PATHS) | Standalone fixture (no shared helpers) |
| UniswapV3Adapter.test.ts | 60 | VALUABLE | CLEAN | `getAmountsIn` limitation docs test | None |
| MockProtocolFidelity.test.ts | 51 | VALUABLE | COULD SIMPLIFY | Mock accuracy regression guard | ~15-20 tests verify basic arithmetic |

## Cross-File Split Analysis

| Contract | Files | Split Quality | Assessment |
|----------|-------|---------------|------------|
| CommitRevealArbitrage | 3 files (test, security, execution) | **GOOD** | Clean boundaries: test=commit/cancel/timing, security=reveal security + reentrancy, execution=swap execution + profit + admin |
| BalancerV2FlashArbitrage | 2 files (test, callback-admin) | **GOOD** | Clean: test=outside view (calling executeArbitrage), callback-admin=inside view (callback behavior + admin) |
| FlashLoanArbitrage | 2 files (test, fork) | **GOOD** | Clean: mock-based unit tests vs. real-protocol fork tests |

**Note**: File split inconsistency — CommitReveal has 3 files, BalancerV2 has 2, but FlashLoan/SyncSwap/PancakeSwap/DaiFlashMint are single files. Not wrong, but standardizing would improve navigability.

## Shared Behavior Extraction Opportunities (6 New Helpers)

| # | Helper | Priority | Affects | Removable Tests | Notes |
|---|--------|----------|---------|----------------|-------|
| SB-1 | `testDeploymentDefaults(config)` | HIGH | 6 files | ~18-20 | Tests owner, minimumProfit default, swapDeadline, constants, zero-address rejection |
| SB-2 | `testExecuteArbitrageValidation(config)` | HIGH | 5 files | ~15-18 | Tests zero amount, expired deadline, empty path, path too long, asset mismatch, unapproved router |
| SB-3 | `testCalculateExpectedProfit(config)` | MEDIUM | 4 files | ~10-12 | Tests profitable path, empty path, wrong tokens, cycle detection |
| SB-4 | `testProfitValidation(config)` | MEDIUM | 4 files | ~6-8 | Tests InsufficientProfit below minProfit, below minimumProfit, max-of-both enforcement |
| SB-5 | `testReentrancyProtection(config)` | LOW | 5 files | ~4 | Deploys MockMaliciousRouter, triggers flash loan, verifies ReentrancyGuardReentrantCall |
| SB-6 | `testGasBenchmark(config)` | LOW | 4 files | 0 (DRY only) | Standardizes gas measurement setup and assertion pattern |

**Combined with existing 8 admin helpers**: Expanding `shared-admin-tests.ts` (or creating `shared-base-tests.ts`) to include all 14 shared test functions would provide ~130+ reusable tests. Each derived contract file would focus exclusively on protocol-specific behavior.

## Consolidation Roadmap (ordered execution plan)

### Phase 1: Quick Wins (< 30 minutes total)

| # | Action | Effort | Impact |
|---|--------|--------|--------|
| 1 | Add `testSwapDeadlineConfig` import to CommitRevealArbitrage.execution.test.ts | 5 min | Closes coverage gap G-3 |
| 2 | Remove legacy `// Note: ... now covered by shared admin harness` comments in FlashLoan + PancakeSwap | 5 min | Code hygiene |
| 3 | Rename SyncSwap "9. Integration Tests" → "9. End-to-End Flow Tests" | 2 min | Corrects misleading label |
| 4 | Fix bare `.to.be.reverted` at FlashLoanArbitrage.fork.test.ts:282 | 5 min | Fixes rule violation |

### Phase 2: Shared Helper Extraction (4-8 hours)

| # | Action | Effort | Tests Removed |
|---|--------|--------|---------------|
| 5 | Create `testDeploymentDefaults(config)` shared helper (SB-1) | 1-2 hrs | ~18-20 |
| 6 | Create `testExecuteArbitrageValidation(config)` shared helper (SB-2) | 1-2 hrs | ~15-18 |
| 7 | Create `testCalculateExpectedProfit(config)` + migrate cycle detection (SB-3/G-2) | 1 hr | ~10-12 |
| 8 | Create `testProfitValidation(config)` (SB-4) | 1 hr | ~6-8 |
| 9 | Create `testReentrancyProtection(config)` (SB-5) | 30 min | ~4 |
| 10 | Trim MockProtocolFidelity.test.ts from 51 to ~25-30 tests | 1 hr | ~21-26 |

### Phase 3: Coverage Enhancements (8-20 hours)

| # | Action | Effort | Tests Added |
|---|--------|--------|-------------|
| 11 | Create `SwapHelpers.test.ts` with wrapper contract (G-1 CRITICAL) | 2-3 hrs | ~15-20 |
| 12 | Add fork tests: BalancerV2 > PancakeSwap > SyncSwap > DaiFlashMint | 4-8 hrs each | ~17 each |
| 13 | Add gas benchmarks to DaiFlashMint, CommitReveal, UniswapV3Adapter | 1-2 hrs each | ~5 each |
| 14 | Refactor MultiPathQuoter.test.ts to use `deployBaseFixture()` | 1-2 hrs | 0 (DRY) |

### Net Effect

| Metric | Before | After |
|--------|--------|-------|
| Total tests | ~868 | ~835-870 |
| Redundant tests | ~55-62 | 0 |
| Shared test functions | 8 | 14 |
| Critical coverage gaps | 1 (SwapHelpers) | 0 |
| Medium coverage gaps | 3 | 0 |
| Fork-tested protocols | 1/5 | Up to 5/5 |

## Hardhat Best Practice Compliance

| Practice | Status | Details |
|----------|--------|---------|
| Uses `loadFixture()` | **PASS** (13/13) | Every test uses fresh fixture snapshots |
| Specifies exact error types | **PASS** (12/13) | 1 violation in fork test (bare `.to.be.reverted` at line 282) |
| Tests authorized + unauthorized callers | **PASS** | All admin functions tested via shared harness |
| Matches token decimals | **PASS** | WETH=18, USDC=6, DAI=18 consistently handled |
| Uses OZ 4.9.6 patterns | **PASS** | String-based `require` messages for `Ownable: caller is not the owner`, `Pausable: paused`, `ERC20: transfer amount exceeds balance` |
| No `.only` or `.skip` committed | **PASS** | Zero instances |

## Anti-Pattern Scan

| Anti-Pattern | Found? | Details |
|--------------|--------|---------|
| Mock Theater | No | All integration-labeled tests acknowledged as enhanced unit tests |
| Testing Mocks | Mild | MockProtocolFidelity tests mock arithmetic; PancakeSwap fee-tier-storage tests |
| Fragile Tests | No | Tests survive refactoring |
| Test Setup Towers | No | Fixtures well-decomposed via shared helpers |
| God Tests | No | Tests properly scoped |
| Shotgun Tests | No | No behavior tested in 5+ places without consolidation |
| Zombie Tests | No | All tests exercise meaningful code paths |

## Statistics

| Metric | Count |
|--------|-------|
| Total test files | 13 |
| Total test cases (approx) | ~868 |
| Helper files | 7 |
| Contract tests (Hardhat/Chai) | 13 files |
| Integration tests (fork) | 1 file (17 tests) |
| Mock validation tests | 1 file (51 tests) |
| Tests: ESSENTIAL | 9 files |
| Tests: VALUABLE | 3 files (fork, MultiPathQuoter, MockProtocolFidelity) |
| Tests: REDUNDANT | 1 file (MockProtocolFidelity — partial, recommend simplification) |
| Tests: CLEAN | 8 files |
| Tests: COULD SIMPLIFY | 4 files (BalancerV2 cb-admin, SyncSwap, PancakeSwap, MockProtocolFidelity) |
| Tests: OVER-ENGINEERED | 0 |
| Integration: AUTHENTIC | 1 file (fork) |
| Integration: TRUE CROSS-CONTRACT | 1 section (UniswapV3Adapter) |
| Integration: ENHANCED UNIT TEST | 1 section (SyncSwap §9, mislabeled) |
| Integration: LOCAL-ONLY | 11 files (expected) |
| Bare `.to.be.reverted` | 1 (fork test) |
| Skipped tests (`.skip`) | 0 |
| Focused tests (`.only`) | 0 |
| Misplaced tests | 0 |
| Redundancy clusters | 7 (~55-62 removable tests) |
| Shared helper opportunities | 6 new helpers |
| Critical gaps | 1 (SwapHelpers.sol) |
| Medium gaps | 3 (cycle detection, testSwapDeadlineConfig, fork tests) |

## Appendix: File Size Distribution

| File | Size | it() in file | + shared admin | Total |
|------|------|-------------|----------------|-------|
| FlashLoanArbitrage.test.ts | 55 KB | 49 | ~41 | ~90 |
| MultiPathQuoter.test.ts | 54 KB | 46 | 0 | 46 |
| SyncSwapFlashArbitrage.test.ts | 49 KB | 60 | ~41 | ~101 |
| CommitRevealArbitrage.test.ts | 41 KB | 114 | 0 | 114 |
| PancakeSwapFlashArbitrage.test.ts | 39 KB | 44 | ~41 | ~85 |
| CommitRevealArbitrage.execution.test.ts | 38 KB | 49 | ~35 | ~84 |
| BalancerV2FlashArbitrage.callback-admin.test.ts | 38 KB | 36 | ~41 | ~77 |
| MockProtocolFidelity.test.ts | 37 KB | 51 | 0 | 51 |
| UniswapV3Adapter.test.ts | 37 KB | 60 | 0 | 60 |
| DaiFlashMintArbitrage.test.ts | 32 KB | 37 | ~41 | ~78 |
| BalancerV2FlashArbitrage.test.ts | 29 KB | 32 | 0 | 32 |
| CommitRevealArbitrage.security.test.ts | 24 KB | 27 | 0 | 27 |
| FlashLoanArbitrage.fork.test.ts | 19 KB | 17 | 0 | 17 |
