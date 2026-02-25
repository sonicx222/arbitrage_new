# Extended Deep Analysis: contracts/* (Operational Focus)

**Date:** 2026-02-25
**Target:** `contracts/*` (31 Solidity files, 18 scripts, 15 test suites, 6 test helpers)
**Agents:** 6 specialized agents (latency-profiler, failure-mode-analyst, data-integrity-auditor, cross-chain-analyst, observability-auditor, config-drift-detector)
**Model:** Claude Opus 4.6

---

## Executive Summary

- **Total findings:** 3 Critical / 5 High / 10 Medium / 12 Low
- **Top 5 highest-impact issues:**
  1. Linea `APPROVED_ROUTERS` contains Base's Aerodrome router address (copy-paste error) — deployment would approve wrong contract
  2. Base Aerodrome and Optimism Velodrome router version mismatch between `APPROVED_ROUTERS` and `DEXES` config — on-chain approved router won't match execution engine's path building
  3. `recoverCommitment()` has zero test coverage — capital recovery function completely untested
  4. PancakeSwap `FlashLoanContext` uses 3 storage slots for temporary data — ~20k gas waste per execution
  5. Missing reentrancy tests for PancakeSwap and DaiFlashMint contracts
- **Overall health grade: B+**
  - Solidity code quality is excellent (well-structured, consistent patterns, comprehensive NatSpec)
  - Security architecture is solid (reentrancy guards, CEI pattern, access control, defense-in-depth)
  - Configuration management has critical drift issues between `contracts/deployments/addresses.ts` and `shared/config/src/dexes/index.ts`
  - Test coverage is strong overall but has specific gaps in commit-reveal functions and 2 flash loan contracts
- **Agent agreement map:** Agents 2+3 independently confirmed CEI pattern correctness, flash loan repayment accuracy, and reentrancy guard placement. Agents 2+5 independently found the same test coverage gaps (recoverCommitment, cleanupExpiredCommitments, reentrancy tests). Agent 4+6 both flagged chain-specific configuration issues.

---

## Synthesis Quality Gates

| Gate | Status | Notes |
|------|--------|-------|
| Completeness | PASS | 6/6 agents reported |
| Cross-Validation | PASS | Agents 2+3 agree on all overlapping areas (CEI, repayment, reentrancy). No disagreements. |
| Deduplication | PASS | 8 findings merged from multiple agents (noted below) |
| False Positive Sweep | PASS | All P0/P1 findings have exact file:line evidence, checked against known correct patterns |

---

## Critical Findings (P0)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 1 | Config Drift | `addresses.ts:345-347` | Linea `APPROVED_ROUTERS` contains `0x8cFe327CEc66d1C090Dd72bd0FF11d690C33a2Eb` which is **Base's Aerodrome Router**, NOT Lynex Router on Linea. Deploying to Linea would approve a non-existent or unrelated contract. | cross-chain | 95% | Replace with correct Lynex Router address on Linea (verify on-chain) or use SyncSwap `0x80e38291e06339d10AAB483C65695D004dBD5C69` | 4.6 |
| 2 | Config Drift | `addresses.ts:319` vs `dexes/index.ts:181` | Base Aerodrome router in `APPROVED_ROUTERS` (`0x8cFe...`) is V1 Router, but `DEXES` config uses V2 Router (`0xcF77...`). On-chain approved router won't match what execution engine uses for path building — swaps revert with `UnapprovedRouter`. | cross-chain | 90% | Reconcile to same router version in both configs. If V2 is current, update APPROVED_ROUTERS. | 4.4 |
| 3 | Config Drift | `addresses.ts:331` vs `dexes/index.ts:274` | Optimism Velodrome router in `APPROVED_ROUTERS` (`0x4A7b...`) is V1 Router, but `DEXES` config uses V2 Router (`0xa062...`). Same issue as #2 — router version mismatch causes swap failures. | cross-chain | 90% | Reconcile to same router version in both configs. | 4.4 |

---

## High Findings (P1)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 4 | Gas Optimization | `PancakeSwapFlashArbitrage.sol:92,189-194,234` | `FlashLoanContext` struct uses 3 storage slots for temporary data (3 SSTORE cold writes + 3 SLOAD reads + 3 delete). Other flash loan contracts pass context via `abi.encode` in the `data` parameter. ~20,000+ gas waste per execution. | latency-profiler | 95% | Encode context in `data` parameter to `poolContract.flash()` and decode in callback, matching FlashLoanArbitrage/BalancerV2 pattern. | 4.0 |
| 5 | Test Coverage | `CommitRevealArbitrage.sol:515-541` | `recoverCommitment()` has **zero test coverage** across all test files. This is a capital recovery function that allows committers to recover funds from expired commitments. Untested paths: happy path, non-committer rejection, non-expired rejection, already-revealed rejection, paused rejection, CEI pattern. | failure-mode, observability, data-integrity | 100% | Add comprehensive test suite covering all 6 paths. Priority: capital at risk. | 3.8 |
| 6 | Test Coverage | `PancakeSwapFlashArbitrage.test.ts`, `DaiFlashMintArbitrage.test.ts` | No reentrancy tests using `MockMaliciousRouter` for PancakeSwap and DaiFlashMint. CLAUDE.md explicitly requires: "Include reentrancy tests using MockMaliciousRouter for all flash loan contracts." FlashLoan, Balancer, SyncSwap, and CommitReveal all have these tests. | observability, failure-mode | 100% | Add reentrancy test using MockMaliciousRouter to both test files, verifying `attackAttempted == true` and `attackSucceeded == false`. | 3.6 |
| 7 | Missing Script | N/A | No `deploy-dai-flash-mint.ts` deployment script exists, but `DaiFlashMintArbitrage.sol` contract exists and `flash-loan-availability.ts` marks `dai_flash_mint: true` for Ethereum. Execution engine code that selects `dai_flash_mint` would look for a non-existent deployment. | cross-chain | 100% | Create `deploy-dai-flash-mint.ts` or remove `dai_flash_mint` from availability matrix until deployment script exists. | 3.4 |
| 8 | Config Drift | `addresses.ts:86-92` vs `hardhat.config.ts:129-138` | `TESTNET_CHAINS` array is missing `bscTestnet` and `polygonAmoy` — both are configured in hardhat.config.ts. Deploying to these testnets causes `isTestnet()` to return false, treating them as mainnet (requires positive minimum profit). | config-drift | 100% | Add `'bscTestnet'` and `'polygonAmoy'` to `TESTNET_CHAINS` and `TestnetChain` type. | 3.4 |

---

## Medium Findings (P2)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 9 | Gas Optimization | `CommitRevealArbitrage.sol:130-138` | 3 separate mappings per commitment (`commitments`, `revealed`, `committers`) use 3 storage slots. Could pack into single struct: `struct Commitment { uint64 blockNumber; address committer; bool revealed; }` (29 bytes, 1 slot). ~40k gas savings per commit. | latency-profiler | 90% | Replace 3 mappings with `mapping(bytes32 => Commitment)` packed struct. | 3.2 |
| 10 | Gas Optimization | `UniswapV3Adapter.sol:230,304,362` | All 3 loops use `i++` instead of `unchecked { ++i }`. Every other contract in the codebase uses the unchecked pattern. ~120 gas per iteration wasted. | latency-profiler | 95% | Change to `unchecked { ++i; }` in all 3 loops. | 2.8 |
| 11 | Test Coverage | `CommitRevealArbitrage.sol:562-587` | `cleanupExpiredCommitments()` has zero test coverage AND emits no events. Operators have no on-chain record of which commitments were cleaned up. | failure-mode, observability | 100% | Add tests for owner-only access, expired-only cleanup, return count. Add event emission. | 3.0 |
| 12 | Test Coverage | `BaseFlashArbitrage.sol:520-525` | `setWithdrawGasLimit()` has zero test coverage. Range validation [2300, 500000], event emission, and owner-only access are all untested. | observability | 100% | Add test covering valid range, out-of-range rejection, event emission, non-owner rejection. | 2.6 |
| 13 | Chain Awareness | `CommitRevealArbitrage.sol:116` | `MAX_COMMIT_AGE_BLOCKS = 10` is a compile-time constant. On Ethereum (12s blocks) this is ~2min. On Arbitrum (0.25s blocks) this is ~2.5s — likely too short for a reveal transaction to be submitted. | config-drift, cross-chain | 85% | Make configurable via constructor param or owner-settable with min/max bounds. | 3.0 |
| 14 | Observability | `BaseFlashArbitrage.sol:153-158` | `ArbitrageExecuted` event lacks `msg.sender` / executor parameter. Operators cannot filter events by who triggered the arbitrage on-chain. | observability | 100% | Add `indexed address executor` parameter. | 2.4 |
| 15 | Mock Fidelity | `MockSyncSwapVault.sol:107`, `MockDssFlash.sol:105` | Mock passes `msg.sender` as `initiator` to `onFlashLoan()`. In tests, this is correct (arbitrage contract == msg.sender). In production, depends on real vault behavior — if initiator differs, the `initiator != address(this)` check would incorrectly revert. | failure-mode, observability, data-integrity | 60% | Verify against real SyncSwap/DssFlash implementations. Document expected initiator behavior. NEEDS VERIFICATION. | 2.2 |
| 16 | Config Drift | `addresses.ts:166-176`, `registry.json` | Registry and addresses.ts require manual synchronization after deployment. `generate-addresses.ts` outputs to `addresses.generated.ts`, not `addresses.ts`. Drift risk on every deployment. | cross-chain | 100% | Auto-generate addresses.ts from registry.json or add CI check for drift. | 2.0 |
| 17 | Config Drift | `addresses.ts:294-301` | Missing testnet routers for `baseSepolia`, `polygonAmoy`, `bscTestnet`, `zksync-testnet`. Deploying to these testnets requires manual post-deployment router approval. | cross-chain | 100% | Add testnet router addresses or document the manual step. | 2.0 |
| 18 | Convention | `deployment-utils.ts:606` | Uses `!minimumProfit || minimumProfit === 0n` pattern — violates ESLint `no-restricted-syntax` rule. Should be `minimumProfit == null || minimumProfit === 0n`. | config-drift | 100% | Refactor to use nullish check. Functionally equivalent. | 1.8 |

---

## Low Findings (P3)

| # | Category | File:Line | Description | Agent(s) | Confidence |
|---|----------|-----------|-------------|----------|------------|
| 19 | Legacy Code | `BaseFlashArbitrage.sol:112,431` | `totalProfits` mixes token denominations (documented as legacy). `tokenProfits[asset]` provides correct per-token tracking. | data-integrity, failure-mode | HIGH |
| 20 | Config | `BaseFlashArbitrage.sol:215` | Default `minimumProfit = 1e14` only suitable for 18-decimal tokens. Owner must configure per deployment. | data-integrity, cross-chain | HIGH |
| 21 | Gas | `BalancerV2FlashArbitrage.sol:85,147,158,179` | `_flashLoanActive` bool uses full storage slot (~25k gas). Intentional defense-in-depth. | latency-profiler | HIGH |
| 22 | Gas | `CommitRevealArbitrage.sol:238` | `nonReentrant` on `commit()` is unnecessary (~5k gas). No external calls in function body. | latency-profiler | MEDIUM |
| 23 | Dead Code | `CommitRevealArbitrage.sol:195` | `InvalidCommitmentHash` error declared but unreachable. Documented in security test. | failure-mode | HIGH |
| 24 | Config | `hardhat.config.ts:192` | `gasPrice: 30` hardcoded in gasReporter. Not L2-aware. Only affects USD estimation in reports, not actual transactions. | cross-chain, config-drift | HIGH |
| 25 | Config | `hardhat.config.ts:199-202` | Sourcify disabled. Chains not supported by Etherscan V2 won't have verification fallback. | cross-chain | HIGH |
| 26 | Convention | `deployment-utils.ts:1579` | Uses `|| []` instead of `?? []`. Functionally identical but violates ESLint convention. | config-drift | HIGH |
| 27 | Config | `.env.example` | Missing `FORK_BLOCK_NUMBER` and `FORK_ENABLED` entries. Documented in hardhat.config comments but absent from template. | config-drift | HIGH |
| 28 | Naming | `PancakeSwapFlashArbitrage.sol:411` | `1e6` inline magic number. Should be named `FEE_DENOMINATOR` for readability. | config-drift | HIGH |
| 29 | Config | `addresses.ts:106-109` | `normalizeChainName` only handles 2 aliases (zksync variants). No aliases for `arbitrum-one`, `polygon-mainnet`, etc. | cross-chain | MEDIUM |
| 30 | Naming | `flash-loan-availability.ts:219` vs `addresses.ts:33` | Chain name format inconsistency: `arbitrum-sepolia` (hyphenated) vs `arbitrumSepolia` (camelCase). No alias handles this. | cross-chain | HIGH |

---

## Latency Budget Table (Gas-Focused for Contracts)

| Component | File:Line | Gas Cost | Optimization Potential |
|-----------|-----------|----------|----------------------|
| PancakeSwap FlashLoanContext storage | `PancakeSwapFlashArbitrage.sol:189-194` | ~22,000 gas (3 SSTORE + 3 SLOAD - refunds) | **~20k savings** via calldata encoding |
| CommitReveal 3 mappings per commit | `CommitRevealArbitrage.sol:130-138` | ~60,000 gas (3 cold SSTORE) | **~40k savings** via struct packing |
| UniswapV3Adapter checked loop increment | `UniswapV3Adapter.sol:230,304,362` | ~120 gas/iteration | **~240 savings** per 3-hop swap |
| forceApprove reset-to-zero per hop | `SwapHelpers.sol:145` | ~5,000 gas/hop | Intentional security (no change) |
| Balancer _flashLoanActive bool | `BalancerV2FlashArbitrage.sol:85` | ~25,000 gas lifecycle | Intentional defense-in-depth |
| CommitReveal nonReentrant on commit() | `CommitRevealArbitrage.sol:238` | ~5,000 gas | Defense-in-depth (optional removal) |
| Flash loan callback design | All 5 callbacks | Optimized (calldata decode, no redundant SLOAD) | Already well-optimized |
| Optimizer config (runs:10000, viaIR:true) | `hardhat.config.ts:56-74` | N/A | Appropriate for MEV-competitive execution |

---

## Failure Mode Map

| # | Stage | Failure Mode | Detection | Recovery | Data Loss Risk | File:Line |
|---|-------|-------------|-----------|----------|----------------|-----------|
| 1 | Flash Loan Init | Provider lacks liquidity | Provider reverts | Atomic rollback | None (gas only) | All executeArbitrage |
| 2 | Callback Execution | DEX router reverts/paused | Tx reverts | Atomic rollback | None (gas only) | `SwapHelpers.sol:134` |
| 3 | Callback Execution | Output below amountOutMin | `InsufficientOutputAmount` | Atomic rollback | None (gas only) | `SwapHelpers.sol:155` |
| 4 | Profit Verification | Profit below minimum | `InsufficientProfit` revert | Atomic rollback | None (gas only) | `BaseFlashArbitrage.sol:424` |
| 5 | Repayment | Insufficient balance | SafeERC20 reverts | Atomic rollback | None (gas only) | All repayment paths |
| 6 | Commit-Reveal | Commitment expires | `CommitmentExpired` revert | `recoverCommitment()` | Capital locked until recovery | `CommitRevealArbitrage.sol:337` |
| 7 | Commit-Reveal | Reveal on fast L2 | 10-block window too short | Manual retry/recovery | Capital locked | `CommitRevealArbitrage.sol:116` |
| 8 | Emergency | Contract paused | `whenNotPaused` reverts | Owner `unpause()` | None | All entry points |

**Overall assessment:** The atomic flash loan model makes the system highly resilient. 5 of 6 failure modes result in automatic rollback with no fund loss. Only the commit-reveal model has capital lockup risk, mitigated by `recoverCommitment()` (which needs test coverage — Finding #5).

---

## Chain-Specific Edge Cases

| # | Chain(s) | Issue | Impact | Severity | File:Line |
|---|----------|-------|--------|----------|-----------|
| 1 | Linea | Wrong router address in APPROVED_ROUTERS | Swaps fail or funds sent to wrong contract | CRITICAL | `addresses.ts:345-347` |
| 2 | Base | Aerodrome V1/V2 router mismatch | Execution engine paths rejected by contract | CRITICAL | `addresses.ts:319` |
| 3 | Optimism | Velodrome V1/V2 router mismatch | Execution engine paths rejected by contract | CRITICAL | `addresses.ts:331` |
| 4 | BSC, Avalanche, Fantom, Linea | Only 1 flash loan protocol available | No fallback if protocol has issues | HIGH | Protocol matrix |
| 5 | Fast L2s (Arbitrum, Base, Optimism) | MAX_COMMIT_AGE_BLOCKS=10 is ~2.5s on 0.25s block chains | Commitments expire before reveal possible | MEDIUM | `CommitRevealArbitrage.sol:116` |
| 6 | zkSync | DISABLE_VIA_IR not auto-enforced in deploy script | Developer must remember to set env var | LOW | `hardhat.config.ts:71` |
| 7 | BSC | USDT has 18 decimals (vs 6 elsewhere) | minimumProfit must be set correctly per chain | LOW | `BaseFlashArbitrage.sol:215` |

---

## Observability Assessment

**Event Coverage:** A- — All state-changing functions emit events. Two minor gaps: `ArbitrageExecuted` lacks executor parameter, `cleanupExpiredCommitments()` emits no event.

**Error Architecture:** A — Clean separation: custom errors for contract logic, string `require()` for OZ4/mocks. No selector collisions.

**NatSpec Documentation:** A — Comprehensive `@notice`, `@param`, `@return`, `@dev`, `@custom:version`, `@custom:security` across all 10 source contracts. Version tags consistent with CLAUDE.md.

**Test Assertion Quality:** A — Zero bare `.to.be.reverted` assertions found. All use specific error matchers (`revertedWithCustomError` or `revertedWith`). `loadFixture` used consistently (595 occurrences).

**Mock Fidelity:** A — All 7 mocks accurately simulate protocol behavior. Minor concern: SyncSwap/DssFlash initiator parameter needs production verification (Finding #15).

**Blind Spots:** `recoverCommitment()`, `cleanupExpiredCommitments()`, `setWithdrawGasLimit()` — 3 functions with zero test coverage.

---

## Configuration Health

### Feature Flag Audit
| Flag | Pattern | Correct? |
|------|---------|----------|
| `DISABLE_VIA_IR` | `!== 'true'` (opt-out) | YES — intentional, viaIR ON by default |
| `FORK_ENABLED` | `=== 'true'` (opt-in) | YES |
| `REPORT_GAS` | `=== 'true'` (opt-in) | YES |
| `CI` | `=== 'true'` (opt-in) | YES |
| `SKIP_CONFIRMATION` | `=== 'true'` (opt-in) | YES |

### `||` vs `??` Violations
| File:Line | Pattern | Fix |
|-----------|---------|-----|
| `deployment-utils.ts:606` | `!minimumProfit \|\| minimumProfit === 0n` | `minimumProfit == null \|\| minimumProfit === 0n` |
| `deployment-utils.ts:1579` | `APPROVED_ROUTERS[networkName] \|\| []` | `?? []` |

**Only 2 violations found** in all contracts/ TypeScript files. Zero violations in Solidity.

### Env Var Coverage
- **Well-covered:** All RPC URLs, DEPLOYER_PRIVATE_KEY, ETHERSCAN_API_KEY, REPORT_GAS
- **Missing from .env.example:** `FORK_BLOCK_NUMBER`, `FORK_ENABLED`, `DISABLE_VIA_IR`, V3 adapter vars

### Deployment Config Drift
- **Testnet chains:** `bscTestnet` and `polygonAmoy` in hardhat.config but missing from `TESTNET_CHAINS` type
- **Router addresses:** Critical V1/V2 mismatches on Base and Optimism between contracts and shared config
- **Registry sync:** Manual process — drift risk on every deployment

---

## Cross-Agent Insights

### Information Separation Results (Agent 2 vs Agent 3)

Agents 2 (failure-mode-analyst) and 3 (data-integrity-auditor) independently analyzed flash loan callbacks, reentrancy, and profit tracking. Results:

| Area | Agent 2 | Agent 3 | Agreement |
|------|---------|---------|-----------|
| CEI pattern compliance | CORRECT | CORRECT | FULL AGREEMENT (HIGH confidence) |
| Flash loan repayment accuracy | CORRECT (all 5) | CORRECT (all 5) | FULL AGREEMENT |
| Reentrancy guard placement | VERIFIED SAFE | N/A (not primary focus) | No conflict |
| `totalProfits` denomination mixing | LOW (documented) | LOW (documented) | FULL AGREEMENT |
| `recoverCommitment()` issues | No test coverage (HIGH) | No on-chain binding (LOW) | Complementary perspectives |
| SyncSwap/DssFlash initiator | MEDIUM (NEEDS VERIFICATION) | CORRECT in test context | Complementary (both valid) |

**No disagreements.** The overlap zone produced consistent findings from different analytical perspectives, confirming high confidence in the flash loan accounting and security model.

### Multi-Agent Finding Convergence
- **recoverCommitment():** Found by 3 agents (failure-mode: untested, observability: untested, data-integrity: design concern) — highest multi-agent agreement
- **cleanupExpiredCommitments():** Found by 2 agents (failure-mode + observability)
- **PancakeSwap/DaiFlashMint reentrancy tests:** Found by 2 agents (observability + failure-mode)
- **minimumProfit decimal awareness:** Found by 3 agents (data-integrity, cross-chain, config-drift)

---

## Conflict Resolutions

No conflicts between agents. All overlapping findings were complementary (different perspectives on same issue) rather than contradictory.

---

## Recommended Action Plan

### Phase 1: Immediate (P0 — fix before deployment)

- [ ] Fix #1: Replace Linea APPROVED_ROUTERS with correct Lynex/SyncSwap router address (`addresses.ts:345-347`) — cross-chain, Score: 4.6
- [ ] Fix #2: Reconcile Base Aerodrome router to same version in APPROVED_ROUTERS and DEXES config — cross-chain, Score: 4.4
- [ ] Fix #3: Reconcile Optimism Velodrome router to same version in APPROVED_ROUTERS and DEXES config — cross-chain, Score: 4.4

### Phase 2: Next Sprint (P1 — reliability and coverage)

- [ ] Fix #4: Refactor PancakeSwap FlashLoanContext to use calldata encoding instead of storage — latency-profiler, Score: 4.0
- [ ] Fix #5: Add comprehensive tests for `recoverCommitment()` (6 test paths) — failure-mode + observability, Score: 3.8
- [ ] Fix #6: Add reentrancy tests for PancakeSwap and DaiFlashMint using MockMaliciousRouter — observability, Score: 3.6
- [ ] Fix #7: Create `deploy-dai-flash-mint.ts` or remove from availability matrix — cross-chain, Score: 3.4
- [ ] Fix #8: Add `bscTestnet` and `polygonAmoy` to `TESTNET_CHAINS` type and array — config-drift, Score: 3.4

### Phase 3: Backlog (P2/P3 — hardening and optimization)

- [ ] Fix #9: Pack CommitReveal 3 mappings into single struct — latency-profiler, Score: 3.2
- [ ] Fix #10: Change UniswapV3Adapter loop increment to unchecked — latency-profiler, Score: 2.8
- [ ] Fix #11: Add tests + event for `cleanupExpiredCommitments()` — failure-mode + observability, Score: 3.0
- [ ] Fix #12: Add tests for `setWithdrawGasLimit()` — observability, Score: 2.6
- [ ] Fix #13: Make MAX_COMMIT_AGE_BLOCKS configurable per chain — config-drift, Score: 3.0
- [ ] Fix #14: Add executor parameter to ArbitrageExecuted event — observability, Score: 2.4
- [ ] Fix #15: Verify SyncSwap/DssFlash initiator behavior against production — failure-mode, Score: 2.2
- [ ] Fix #16: Auto-generate addresses.ts from registry.json — cross-chain, Score: 2.0
- [ ] Fix #17: Add testnet router addresses — cross-chain, Score: 2.0
- [ ] Fix #18: Fix 2 `||` vs `??` violations in deployment-utils.ts — config-drift, Score: 1.8

---

## Protocol Availability Matrix

| Chain | Aave V3 | Balancer V2 | PancakeSwap V3 | SyncSwap | DAI Flash | Total |
|-------|---------|-------------|----------------|----------|-----------|-------|
| Ethereum | Yes | Yes | Yes | - | Yes | 4 |
| Polygon | Yes | Yes | - | - | - | 2 |
| Arbitrum | Yes | Yes | Yes | - | - | 3 |
| Base | Yes | Yes | Yes | - | - | 3 |
| Optimism | Yes | Yes | - | - | - | 2 |
| BSC | - | - | Yes | - | - | **1** |
| Avalanche | Yes | - | - | - | - | **1** |
| Fantom | - | Yes* | - | - | - | **1** |
| zkSync | - | - | Yes | Yes | - | 2 |
| Linea | - | - | Yes | - | - | **1** |

*Beethoven X fork — interface compatibility should be verified (Finding #15 extended scope)

**Risk:** BSC, Avalanche, Fantom, and Linea each have only 1 flash loan protocol. No fallback.
