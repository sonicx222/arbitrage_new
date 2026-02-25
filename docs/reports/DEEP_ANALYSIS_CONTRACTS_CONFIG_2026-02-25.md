# Deep Analysis Report: `contracts/` and `shared/config/src/`

**Date:** 2026-02-25
**Agents:** 6 specialized (Architecture Auditor, Bug Hunter, Security Auditor, Test Quality Analyst, Mock Fidelity Validator, Performance/Refactor Reviewer)
**Scope:** ~10 Solidity contracts, ~15 test files, ~30 config TypeScript files, cross-referenced against ADRs, architecture docs, and deployment configs

---

## Executive Summary

| Severity | Count |
|----------|-------|
| **Critical** | 1 |
| **High** | 2 |
| **Medium** | 11 |
| **Low** | 14 |
| **Informational** | 5 |
| **Total** | 33 |

**Top 3 highest-impact issues:**
1. **Wrong DAI address** in canonical `shared/config/src/addresses.ts` — would interact with wrong contract on Ethereum mainnet
2. **`recoverCommitment()` allows arbitrary token drain** — expired committer can specify any token/amount held by contract
3. **`arbitrumSepolia` vs `arbitrum-sepolia` naming mismatch** — flash loan availability lookups silently fail for testnet

**Overall Health Grade: B+** — Strong security posture, excellent mock fidelity, 93% test coverage, but critical config errors and some test gaps need attention.

**Agent Agreement Map:** Bug Hunter + Architecture Auditor both found stale "defaults to 0" comment (Finding 12/6). Security Auditor + Test Quality Analyst both flagged unreachable custom errors. Performance Reviewer + Test Quality Analyst both identified setWithdrawGasLimit() gap.

---

## Critical Findings (P0)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 1 | Config Mismatch | `shared/config/src/addresses.ts:416` vs `contracts/scripts/deploy-dai-flash-mint.ts:57` | **Wrong DAI address in canonical config.** `shared/config/src/addresses.ts` has `0x6B175474E89094C44Da98b954EedcdeCB5BAA7D3` (WRONG). Correct: `0x6B175474E89094C44Da98b954EedeAC495271d0F`. Deploy script and execution-engine have the correct address. Any code using `getStablecoin('ethereum', 'DAI')` would interact with wrong contract. | Architecture | HIGH | Fix address in addresses.ts to match Etherscan-verified value | **4.4** |

---

## High Findings (P1)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 2 | Fund Safety | `contracts/src/CommitRevealArbitrage.sol:515-542` | **`recoverCommitment()` allows arbitrary token/amount drain.** Function lets expired committer specify any `asset` and `amount` since contract only stores hash+block, not deposit details. Attacker only needs one expired commitment to drain any ERC20 held by contract. | Security | HIGH | Store deposited asset/amount in commitment mapping, or remove function (owner has `withdrawToken()`) | **3.1** |
| 3 | Config Mismatch | `contracts/deployments/registry.json:8-15` | **DaiFlashMintArbitrage missing from `registry.json`.** Fully implemented contract with deploy script and tests, but absent from main registry. Deployment script writes to separate `dai-flash-mint-registry.json`. `generate-addresses.ts` won't track DAI flash mint deployments. | Architecture | HIGH | Add `DaiFlashMintArbitrage` to registry.json `contractTypes` and network entries | **3.6** |

---

## Medium Findings (P2)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 4 | Config Mismatch | `shared/config/src/flash-loan-availability.ts:219` vs `shared/config/src/addresses.ts:61` | **`arbitrumSepolia` vs `arbitrum-sepolia` naming.** camelCase in addresses.ts/hardhat.config/registry, kebab-case in flash-loan-availability. `isProtocolSupported('arbitrumSepolia', 'aave_v3')` returns false incorrectly. | Architecture | HIGH | Standardize to camelCase in flash-loan-availability.ts | **3.6** |
| 5 | Test Coverage | `contracts/src/base/BaseFlashArbitrage.sol:521-526` | **`setWithdrawGasLimit()` has ZERO test coverage.** Admin function controlling ETH withdrawal gas limit. Missing: boundary validation (2300-500000), unauthorized caller, event emission, actual usage in `withdrawETH()`. | Test Quality, Performance | HIGH | Add tests in BalancerV2FlashArbitrage.callback-admin.test.ts | **3.3** |
| 6 | Test Coverage | `contracts/src/CommitRevealArbitrage.sol:591-616` | **`cleanupExpiredCommitments()` has ZERO test coverage.** Owner-only cleanup function. Missing: access control, whenNotPaused, expired vs non-expired, return value. | Test Quality | HIGH | Add tests in CommitRevealArbitrage.execution.test.ts | **3.3** |
| 7 | Architecture | `shared/config/src/addresses.ts:252`, `shared/config/src/flash-loan-availability.ts:52` | **Morpho configured as highest-priority flash loan but no Solidity contract exists.** `getPreferredProtocol('ethereum')` returns `'morpho'` (0% fee) but no MorphoFlashArbitrage.sol in contracts/src/. | Architecture | HIGH | Either implement MorphoFlashArbitrage.sol or demote priority until contract exists | **3.0** |
| 8 | Doc Mismatch | `contracts/src/base/BaseFlashArbitrage.sol:20-26`, `docs/architecture/ARCHITECTURE_V2.md:231` | **NatSpec and ARCHITECTURE_V2.md say "5 contracts" — should be 6.** DaiFlashMintArbitrage omitted from both. | Architecture | HIGH | Update NatSpec count and ARCHITECTURE_V2.md section 10.6 | **3.2** |
| 9 | Doc Mismatch | `docs/architecture/ARCHITECTURE_V2.md:1096` | **PancakeSwap V3 listed as "0% fee" — actually 0.01-1%.** Real fees are pool-dependent (100/500/2500/10000 bps). BSC default is 0.25%. | Architecture | HIGH | Fix to "Pool-dependent: 0.01-1%" | **3.2** |
| 10 | Test Quality | `contracts/test/PancakeSwapFlashArbitrage.test.ts:1146` | **Bare `.to.be.reverted` without reason.** Violates CLAUDE.md rule. Could mask regressions if contract error changes. | Bug Hunter | HIGH | Use `.to.be.revertedWithoutReason()` or identify specific error | **3.2** |
| 11 | Type Safety | 7 deploy scripts | **Pervasive `as any` casts** on `saveDeploymentResult(result as any, ...)` across all deployment scripts. Bypasses TypeScript checking. | Bug Hunter | HIGH | Make pipeline result type compatible with DeploymentResult | **2.8** |
| 12 | Nullish Coalescing | `shared/config/src/partitions.ts:506` | **`\|\| 10` for blockTime fallback.** Would treat `blockTime: 0` as falsy. Convention requires `??`. | Bug Hunter | MEDIUM | Change to `chain?.blockTime ?? 10` | **3.2** |
| 13 | Gas Optimization | `contracts/src/CommitRevealArbitrage.sol:134` | **Redundant `revealed` mapping wastes ~20k gas per reveal.** Commitment is deleted on reveal, so `commitments[hash] == 0` already catches revealed entries. | Performance | MEDIUM | Verify all code paths and remove if confirmed redundant | **2.4** |
| 14 | Slippage | `contracts/src/adapters/UniswapV3Adapter.sol:251` | **`amountOutMinimum: 0` on intermediate hops.** MEV searcher could sandwich intermediate swaps while keeping final output above `amountOutMin`. | Security | HIGH | Document as known trade-off or add per-hop minimums | **2.2** |

---

## Low Findings (P3)

| # | Category | File:Line | Description | Agent(s) | Score |
|---|----------|-----------|-------------|----------|-------|
| 15 | Doc Mismatch | `docs/architecture/ARCHITECTURE_V2.md:1087` | Aave V3 chain list missing Avalanche | Architecture | 2.0 |
| 16 | Doc Mismatch | `docs/architecture/ARCHITECTURE_V2.md:1092` | Balancer V2 chain list missing Optimism, Base, Fantom | Architecture | 2.0 |
| 17 | Config | `shared/config/src/addresses.ts`, `contracts/scripts/deploy-dai-flash-mint.ts:48` | DssFlash address not in canonical addresses.ts | Architecture | 2.0 |
| 18 | Doc Mismatch | `CLAUDE.md:7` vs `docs/architecture/ARCHITECTURE_V2.md:28` | Chain count discrepancy: 11 vs 15 | Architecture | 1.8 |
| 19 | Doc Mismatch | `contracts/src/CommitRevealArbitrage.sol:214` | Stale comment "defaults to 0" — actually 1e14 | Architecture, Bug Hunter | 3.2 |
| 20 | Test Coverage | `contracts/src/CommitRevealArbitrage.sol` batchCommit | No test for >50 commitments BatchTooLarge | Test Quality | 2.4 |
| 21 | Test Coverage | `contracts/test/FlashLoanArbitrage.test.ts` | tokenProfits per-asset not explicitly verified (totalProfits tested) | Test Quality | 2.0 |
| 22 | Dead Code | `BaseFlashArbitrage.sol:203`, `PancakeSwapFlashArbitrage.sol:109` | 5 custom errors declared but unreachable/unused: `InvalidAmountsLength`, `PoolNotFound`, `CommitmentAlreadyRevealed`, `InvalidCommitmentHash`, `BelowMinimumProfit` | Test Quality, Security | 2.2 |
| 23 | Consistency | 3 script files | `require.main === module` in ESM context | Bug Hunter | 1.8 |
| 24 | Consistency | `shared/config/src/addresses.ts:349`, `shared/config/src/partitions.ts:431` | `\|\|` instead of `??` for string/array defaults | Bug Hunter | 1.6 |
| 25 | Config | `contracts/hardhat.config.ts` vs `contracts/deployments/registry.json` | Ethereum mainnet commented out in Hardhat but present in registry | Bug Hunter | 1.4 |
| 26 | Mock | `contracts/src/mocks/MockAavePool.sol:35-36` | Premium not runtime-configurable (always 9 bps) | Mock Fidelity | 1.4 |
| 27 | Refactoring | 6 test files | ~960 LOC of duplicated base contract tests (router mgmt, admin, pause, init) | Performance | 3.7 |
| 28 | Performance | All test files | No gas benchmark tests for critical operations | Performance | 3.1 |

---

## Informational Findings

| # | Category | File:Line | Description | Agent(s) |
|---|----------|-----------|-------------|----------|
| 29 | Security | `contracts/src/BalancerV2FlashArbitrage.sol:169-213` | Balancer V2 callback lacks initiator verification (mitigated by `_flashLoanActive` guard) | Security |
| 30 | Integer Safety | `contracts/src/base/BaseFlashArbitrage.sol:431` | `totalProfits` accumulator can theoretically overflow uint256 (physically impossible) | Security |
| 31 | Dead Code | `contracts/src/CommitRevealArbitrage.sol:195` | `InvalidCommitmentHash` declared but unreachable (documented in tests) | Security |
| 32 | Mock | `contracts/src/mocks/MockDexRouter.sol:91` | Deadline parameter ignored (tested at higher level, intentional) | Mock Fidelity |
| 33 | Mock | `contracts/src/mocks/MockMaliciousRouter.sol` | No formal IDexRouter inheritance (ABI-compatible, acceptable for attack sim) | Mock Fidelity |

---

## Test Coverage Matrix (Key Functions)

| Source File | Function | Happy | Error | Edge | Access | Security |
|-------------|----------|-------|-------|------|--------|----------|
| BaseFlashArbitrage | executeArbitrage flow | Y | Y | Y | Y | Y |
| BaseFlashArbitrage | addApprovedRouter | Y | Y | Y | Y | — |
| BaseFlashArbitrage | removeApprovedRouter | Y | Y | — | Y | — |
| BaseFlashArbitrage | setMinimumProfit | Y | Y | — | Y | — |
| BaseFlashArbitrage | setSwapDeadline | Y | Y | Y | Y | — |
| BaseFlashArbitrage | **setWithdrawGasLimit** | **N** | **N** | **N** | **N** | **N** |
| BaseFlashArbitrage | pause/unpause | Y | — | — | Y | — |
| BaseFlashArbitrage | withdrawToken | Y | Y | — | Y | — |
| BaseFlashArbitrage | withdrawETH | Y | Y | Y | Y | — |
| FlashLoanArbitrage | executeOperation (callback) | Y | Y | — | Y | Y |
| FlashLoanArbitrage | tokenProfits tracking | Partial | Y | Y | Y | Y |
| BalancerV2FlashArbitrage | receiveFlashLoan (callback) | Y | Y | — | Y | Y |
| PancakeSwapFlashArbitrage | pancakeV3FlashCallback | Y | Y | — | Y | Y |
| PancakeSwapFlashArbitrage | whitelistPool/batch | Y | Y | Y | Y | — |
| SyncSwapFlashArbitrage | onFlashLoan (callback) | Y | Y | — | Y | Y |
| DaiFlashMintArbitrage | onFlashLoan (callback) | Y | Y | — | Y | Y |
| CommitRevealArbitrage | commit/batchCommit | Y | Partial | — | Y | Y |
| CommitRevealArbitrage | reveal | Y | Y | Y | Y | Y |
| CommitRevealArbitrage | cancelCommit | Y | Y | — | Y | — |
| CommitRevealArbitrage | recoverCommitment | Y | Y | — | Y | — |
| CommitRevealArbitrage | **cleanupExpiredCommitments** | **N** | **N** | **N** | **N** | **N** |
| MultiPathQuoter | getBatchedQuotes | Y | Y | Y | — | — |
| MultiPathQuoter | simulateArbitragePath | Y | Y | Y | — | — |
| MultiPathQuoter | compareArbitragePaths | Y | Y | Y | — | — |
| UniswapV3Adapter | swapExactTokensForTokens | Y | Y | Y | Y | — |
| UniswapV3Adapter | setPairFee/setDefaultFee | Y | Y | — | Y | — |

**93% function coverage (70/75 public functions tested)**

---

## Mock Fidelity Matrix

| Mock Contract | Real Interface | Score | Notes |
|---------------|---------------|-------|-------|
| MockAavePool | IPool/IFlashLoanReceiver | **HIGH** | Minor: fee not runtime-configurable |
| MockBalancerVault | IBalancerV2Vault | **HIGH** | Faithful, zero fee correct |
| MockDexRouter | IDexRouter | **HIGH** | Full interface, deadline ignored (OK) |
| MockDssFlash | IERC3156FlashLender | **HIGH** | All 3 functions, fee configurable |
| MockPancakeV3Pool/Factory | IPancakeV3 | **HIGH** | Fee calc correct, bidirectional lookup |
| MockSyncSwapVault | ISyncSwapVault | **HIGH** | 0.3% fee correct, EIP-3156 hash verified |
| MockMaliciousRouter | (attack sim) | **HIGH** | Proper reentrancy simulation |
| MockCommitAttackRouter | (attack sim) | **HIGH** | Cross-function reentrancy sim |
| MockERC20 | ERC20 (OZ4) | **HIGH** | Configurable decimals |
| MockUniswapV3Router | ISwapRouterV3 | **HIGH** | Tracks params for assertions |
| MockFlashLoanRecipient | Multi-protocol | **HIGH** | Configurable failure modes |
| MockCommitAttackRouter | (attack sim) | **HIGH** | Cross-function reentrancy via commit() |

**Overall Mock Fidelity: HIGH — No remediation needed**

---

## Custom Error Coverage Audit

### Summary

| Metric | Value |
|--------|-------|
| Total custom errors declared | 53 |
| Custom errors tested | 45 (85%) |
| Custom errors untested but reachable | 2 (`InvalidGasLimit`, `BatchTooLarge` for CommitReveal) |
| Custom errors unreachable (dead code) | 5 (`InvalidAmountsLength`, `PoolNotFound`, `CommitmentAlreadyRevealed`, `InvalidCommitmentHash`, `BelowMinimumProfit`) |
| Unused mocks | 1 (`MockFeeOnTransferERC20`) |

### Dead/Unreachable Errors

1. **`InvalidAmountsLength`** (`BaseFlashArbitrage.sol:203`) — Declared, never used in any `revert` statement. Pure dead code.
2. **`PoolNotFound`** (`PancakeSwapFlashArbitrage.sol:109`) — Declared, never used in any `revert` statement. Pure dead code.
3. **`CommitmentAlreadyRevealed`** (`CommitRevealArbitrage.sol:212`) — Used in 3 `revert` statements BUT unreachable because blockNumber is zeroed during reveal, so `CommitmentNotFound` always fires first.
4. **`InvalidCommitmentHash`** (`CommitRevealArbitrage.sol:215`) — Used but unreachable due to hash-based lookup producing different key.
5. **`BelowMinimumProfit`** (`CommitRevealArbitrage.sol:218`) — Used but unreachable; base contract's `InsufficientProfit` fires instead.

---

## Refactoring Opportunities (by Priority Score)

| # | Finding | Priority | LOC Saved | Files |
|---|---------|----------|-----------|-------|
| R1 | Router Management test duplication | **3.7** | ~340 | 3 |
| R2 | Admin function test duplication | **3.7** | ~300 | 4 |
| R3 | Pause test duplication | **3.6** | ~200 | 5-6 |
| R4 | Initialization test duplication | **3.3** | ~120 | 3 |
| R5 | Inline paths not using existing helpers | **3.2** | ~100 | 2+ |
| R6 | Redundant fee tier individual tests | **3.2** | ~45 | 1 |
| R7 | Repeated MockFlashLoanRecipient deploy | **3.2** | ~90 | 1 |
| R8 | MultiPathQuoter fixture not using helper | **2.9** | ~60 | 1 |
| R9 | Long it() blocks in commit-reveal tests | **2.7** | varies | 1 |
| R10 | Duplicated profit calc in MultiPathQuoter.sol | **2.6** | ~15 | 1 |
| R11 | Duplicated ERC3156_CALLBACK_SUCCESS constant | **2.5** | ~2 | 2 |
| R12 | Repeated `await *.getAddress()` calls | **2.3** | varies | 16 |
| R13 | Eager config loading (no lazy loading) | **1.7** | 0 | 5 |

**Total estimated LOC savings: ~1,300+ lines**

---

## Cross-Agent Insights

- **DaiFlashMintArbitrage is systematically orphaned:** Architecture found it missing from registry (F3), NatSpec (F8), ARCHITECTURE_V2.md (F8), and uses a wrong DAI address (F1). This contract needs integration attention across config, docs, and registry.
- **CommitRevealArbitrage has the most issues:** Security found the recoverCommitment drain (F2), Test Quality found 2 untested functions (F5, F6) and 3 unreachable errors, Performance found redundant `revealed` mapping (F13), Bug Hunter + Architecture found stale comments (F19).
- **Test duplication is the largest maintenance debt:** ~960 LOC of duplicated base contract tests across 6 files. This doesn't affect correctness but significantly impacts maintenance.
- **Security posture is strong:** All external functions have `nonReentrant`. All flash loan callbacks verify caller. CEI pattern followed. No dangerous patterns (delegatecall, selfdestruct, tx.origin). Open access on `executeArbitrage()`/`reveal()` is correctly designed.

---

## Security Posture Summary

The contract suite demonstrates professional-grade security practices:

1. **Reentrancy:** All external state-changing functions use `nonReentrant`. Both same-function and cross-function reentrancy are tested with MockMaliciousRouter and MockCommitAttackRouter.
2. **Flash Loan Callbacks:** All 5 flash loan contracts verify the callback caller is the expected protocol contract. Aave, SyncSwap, and DaiFlashMint also verify `initiator == address(this)`.
3. **Access Control:** All admin functions properly use `onlyOwner` via Ownable2Step. Open access on `executeArbitrage()`/`reveal()` is safe due to atomic flash loan model.
4. **CEI Pattern:** Profit tracking follows Checks-Effects-Interactions. State updates happen before external interactions.
5. **Router Security:** Per-step router validation against EnumerableSet (no caching bypass).
6. **No Dangerous Patterns:** Zero instances of delegatecall, selfdestruct, or tx.origin.
7. **Config Security:** Feature flags use strict `=== 'true'` for opt-in. Contract addresses are typed readonly records.

---

## Recommended Action Plan

### Phase 1: Immediate (P0/P1 — fix before any deployment)
- [ ] **Fix #1**: Correct DAI address in `shared/config/src/addresses.ts` (Score: 4.4)
- [ ] **Fix #2**: Add token/amount tracking to `recoverCommitment()` or remove it (Score: 3.1)
- [ ] **Fix #3**: Add DaiFlashMintArbitrage to `registry.json` (Score: 3.6)
- [ ] **Fix #4**: Standardize `arbitrumSepolia` naming in `flash-loan-availability.ts` (Score: 3.6)

### Phase 2: Next Sprint (P2 — coverage gaps and reliability)
- [ ] **Fix #5**: Add tests for `setWithdrawGasLimit()` (Score: 3.3)
- [ ] **Fix #6**: Add tests for `cleanupExpiredCommitments()` (Score: 3.3)
- [ ] **Fix #8-9**: Update NatSpec and ARCHITECTURE_V2.md for 6 contracts, fix PancakeSwap fee docs (Score: 3.2)
- [ ] **Fix #10**: Replace bare `.to.be.reverted` in PancakeSwap test (Score: 3.2)
- [ ] **Fix #12**: Change `|| 10` to `?? 10` in partitions.ts (Score: 3.2)
- [ ] **Fix #7**: Implement MorphoFlashArbitrage.sol or demote priority (Score: 3.0)
- [ ] **Fix #11**: Remove `as any` casts in deploy scripts (Score: 2.8)
- [ ] **Fix #13**: Investigate removing redundant `revealed` mapping (Score: 2.4)
- [ ] **Fix #14**: Document or mitigate intermediate hop slippage (Score: 2.2)

### Phase 3: Backlog (P3 — refactoring, docs, maintenance)
- [ ] **Fix #27 (R1-R4)**: Extract shared test helpers for base contract tests (~960 LOC savings) (Score: 3.7)
- [ ] **Fix #28**: Add gas benchmark tests for critical operations (Score: 3.1)
- [ ] **Fix #19**: Fix stale "defaults to 0" comment in CommitRevealArbitrage (Score: 3.2)
- [ ] **Fix #22**: Remove 5 dead/unreachable custom errors (Score: 2.2)
- [ ] **Fix #15-18**: Update remaining doc chain lists and counts
- [ ] **Fix #17**: Add DssFlash address to canonical addresses.ts
- [ ] **Fix #23-25**: Minor consistency fixes (require.main, fallback patterns)
