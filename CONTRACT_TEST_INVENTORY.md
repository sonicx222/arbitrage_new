# Contract Test Inventory

Generated: 2026-02-27

## Summary

- **Total test files:** 13
- **Total test cases (it/test blocks):** 447
- **Files using loadFixture:** 13/13 ✅
- **Misplaced tests:** 0
- **Suspicious patterns found:** 1

---

## Suspicious Patterns

| File | Pattern | Description | Severity |
|------|---------|-------------|----------|
| FlashLoanArbitrage.fork.test.ts | Line 282: `.to.be.reverted` (bare) | Missing error type specification; should use `.revertedWith()` or `.revertedWithCustomError()` | LOW |

---

## Full Inventory

### 1. MultiPathQuoter.test.ts

| Field | Value |
|-------|-------|
| **FILE** | contracts/test/MultiPathQuoter.test.ts |
| **CATEGORY** | contract (Hardhat/Chai) |
| **CATEGORIZATION BASIS** | Comprehensive coverage for VIEW-ONLY, STATELESS batched quote fetching; tests DOS protection, graceful failure, and gas optimization |
| **TEST COUNT** | 46 |
| **DESCRIBE STRUCTURE** | 1 top-level: `MultiPathQuoter` containing nested suites (Deployment, Successful Quotes, Quote Failures, Chaining, DOS Protection, Edge Cases) |
| **SOURCE CONTRACT TESTED** | `contracts/src/MultiPathQuoter.sol` |
| **MOCK CONTRACTS USED** | MockERC20 (weth, usdc, dai, usdt), MockDexRouter (uniswapRouter, sushiRouter, dexRouter3) |
| **REAL DEPENDENCIES** | None (fully mocked) |
| **SETUP COMPLEXITY** | **HIGH**: 4 mock tokens + 3 mock DEX routers deployed, cross-router configuration |
| **USES LOAD_FIXTURE** | YES (all tests) |
| **PLACEMENT** | CORRECT (contracts/test/) |

**Key patterns:**
- Comprehensive DOS protection testing (MAX_PATHS=10, MAX_PATH_LENGTH=5 limits)
- Graceful failure handling (returns success flags, not reverts)
- Chaining quotes (uses previous output as next input)
- All tests use `loadFixture` for consistent state

---

### 2. UniswapV3Adapter.test.ts

| Field | Value |
|-------|-------|
| **FILE** | contracts/test/UniswapV3Adapter.test.ts |
| **CATEGORY** | contract (Hardhat/Chai) |
| **CATEGORIZATION BASIS** | Validates Uniswap V3 swap execution, routing, and fee tier handling through MockUniswapV3Router |
| **TEST COUNT** | 57 |
| **DESCRIBE STRUCTURE** | 1 top-level: `UniswapV3Adapter` with nested suites (Swap Execution, Token Decimals, Fee Tiers, Multi-hop, Error Cases, Edge Cases) |
| **SOURCE CONTRACT TESTED** | `contracts/src/adapters/UniswapV3Adapter.sol` (implied; test targets adapter behavior) |
| **MOCK CONTRACTS USED** | MockERC20 (weth, usdc, dai, usdt), MockUniswapV3Router |
| **REAL DEPENDENCIES** | None (fully mocked) |
| **SETUP COMPLEXITY** | **MEDIUM**: 4 mock tokens + 1 mock router; fee tier configuration |
| **USES LOAD_FIXTURE** | YES (all tests) |
| **PLACEMENT** | CORRECT (contracts/test/) |

**Key patterns:**
- Comprehensive fee tier testing (100, 500, 2500, 10000 bps)
- Token decimal precision validation (18 vs 6 decimal pairs)
- Multi-hop swap verification
- Edge cases: zero amounts, max uint256

---

### 3. CommitRevealArbitrage.test.ts

| Field | Value |
|-------|-------|
| **FILE** | contracts/test/CommitRevealArbitrage.test.ts |
| **CATEGORY** | contract (Hardhat/Chai) |
| **CATEGORIZATION BASIS** | Core commit-reveal MEV-protection test suite: deployment, commit validation, timing checks, redemption logic |
| **TEST COUNT** | 47 |
| **DESCRIBE STRUCTURE** | 1 top-level: `CommitRevealArbitrage` with nested suites (Deployment, Commit Phase, Reveal Timing, Redemption) |
| **SOURCE CONTRACT TESTED** | `contracts/src/CommitRevealArbitrage.sol` |
| **MOCK CONTRACTS USED** | MockDexRouter (dexRouter1, dexRouter2), MockERC20 (weth, usdc, dai) |
| **REAL DEPENDENCIES** | None (fully mocked) |
| **SETUP COMPLEXITY** | **HIGH**: Shared fixture from helpers; commit-reveal cycle with timing validation; multi-router setup |
| **USES LOAD_FIXTURE** | YES (all tests) |
| **PLACEMENT** | CORRECT (contracts/test/) |

**Key patterns:**
- Commit-reveal phase separation testing
- Block height timing validation (minRevealBlocks, maxRevealWindow)
- Salt-based commitment verification
- Replay prevention (commitment can only be revealed once)

---

### 4. CommitRevealArbitrage.security.test.ts

| Field | Value |
|-------|-------|
| **FILE** | contracts/test/CommitRevealArbitrage.security.test.ts |
| **CATEGORY** | contract (Hardhat/Chai) |
| **CATEGORIZATION BASIS** | Security-focused: reentrancy protection, malicious router attacks, callback validation, state consistency |
| **TEST COUNT** | 12 |
| **DESCRIBE STRUCTURE** | 1 top-level: `CommitRevealArbitrage Security` with nested suites (Reentrancy, Callback Validation, Edge Cases) |
| **SOURCE CONTRACT TESTED** | `contracts/src/CommitRevealArbitrage.sol` |
| **MOCK CONTRACTS USED** | MockDexRouter, MockMaliciousRouter, MockERC20 (weth, usdc) |
| **REAL DEPENDENCIES** | None (fully mocked) |
| **SETUP COMPLEXITY** | **HIGH**: Malicious router + normal router coordination; account impersonation via hardhat_impersonateAccount |
| **USES LOAD_FIXTURE** | YES (all tests) |
| **PLACEMENT** | CORRECT (contracts/test/) |

**Key patterns:**
- MockMaliciousRouter reentrancy attacks (guarded by ReentrancyGuard)
- Callback parameter validation (initiator, token, amount checks)
- Commit deletion after reveal (prevents replay)
- State consistency after failed/successful operations

---

### 5. FlashLoanArbitrage.test.ts

| Field | Value |
|-------|-------|
| **FILE** | contracts/test/FlashLoanArbitrage.test.ts |
| **CATEGORY** | contract (Hardhat/Chai) |
| **CATEGORIZATION BASIS** | Aave V3 flash loan arbitrage: deployment, executeOperation callback, profit verification, router management, admin functions |
| **TEST COUNT** | 38 |
| **DESCRIBE STRUCTURE** | 1 top-level: `FlashLoanArbitrage` with nested suites (Deployment, Admin Functions, Flash Loan Execution, Reentrancy, Profit Calculation, Multi-hop) |
| **SOURCE CONTRACT TESTED** | `contracts/src/FlashLoanArbitrage.sol` |
| **MOCK CONTRACTS USED** | MockAavePool, MockDexRouter (2), MockERC20 (weth, usdc, dai, usdt), MockMaliciousRouter |
| **REAL DEPENDENCIES** | None (fully mocked) |
| **SETUP COMPLEXITY** | **HIGH**: deployBaseFixture() helper + Aave pool funding; helper functions (build2HopPath, build3HopPath) |
| **USES LOAD_FIXTURE** | YES (all tests) |
| **PLACEMENT** | CORRECT (contracts/test/) |

**Key patterns:**
- executeOperation callback validation (Aave pattern)
- Flash loan fee calculation (9 bps premium)
- Profit verification and tracking
- Shared admin harness (router management, minimum profit, pause, withdraw)
- Malicious router reentrancy protection validation

---

### 6. BalancerV2FlashArbitrage.test.ts

| Field | Value |
|-------|-------|
| **FILE** | contracts/test/BalancerV2FlashArbitrage.test.ts |
| **CATEGORY** | contract (Hardhat/Chai) |
| **CATEGORIZATION BASIS** | Balancer V2 flash loan arbitrage: receiveFlashLoan callback, array validation, multi-token flash loans, admin functions |
| **TEST COUNT** | 30 |
| **DESCRIBE STRUCTURE** | 1 top-level: `BalancerV2FlashArbitrage` with nested suites (Deployment, Admin Functions, Flash Loan Execution, Multi-token Loans, Reentrancy, Profit Calculation) |
| **SOURCE CONTRACT TESTED** | `contracts/src/BalancerV2FlashArbitrage.sol` |
| **MOCK CONTRACTS USED** | MockBalancerVault, MockDexRouter (2), MockERC20 (weth, usdc, dai), MockMaliciousRouter |
| **REAL DEPENDENCIES** | None (fully mocked) |
| **SETUP COMPLEXITY** | **HIGH**: deployBaseFixture() + Balancer vault setup; multi-token flash loan coordination |
| **USES LOAD_FIXTURE** | YES (all tests) |
| **PLACEMENT** | CORRECT (contracts/test/) |

**Key patterns:**
- receiveFlashLoan callback validation (Balancer pattern, different from Aave)
- Array length validation (tokens vs amounts)
- Multi-token simultaneous flash loans
- Zero flash loan fee (Balancer V2 characteristic)
- Shared admin harness

---

### 7. BalancerV2FlashArbitrage.callback-admin.test.ts

| Field | Value |
|-------|-------|
| **FILE** | contracts/test/BalancerV2FlashArbitrage.callback-admin.test.ts |
| **CATEGORY** | contract (Hardhat/Chai) |
| **CATEGORIZATION BASIS** | Split test: callback parameter validation and admin function authorization checks (prevents duplication with main test) |
| **TEST COUNT** | 24 |
| **DESCRIBE STRUCTURE** | 1 top-level: `BalancerV2FlashArbitrage Callback & Admin` with nested suites (Callback Parameter Validation, Admin Authorization) |
| **SOURCE CONTRACT TESTED** | `contracts/src/BalancerV2FlashArbitrage.sol` |
| **MOCK CONTRACTS USED** | MockBalancerVault, MockDexRouter, MockERC20 (weth, usdc, dai) |
| **REAL DEPENDENCIES** | None (fully mocked) |
| **SETUP COMPLEXITY** | **HIGH**: Callback parameter impersonation via hardhat_impersonateAccount |
| **USES LOAD_FIXTURE** | YES (all tests) |
| **PLACEMENT** | CORRECT (contracts/test/) |

**Key patterns:**
- Vault address validation in callback
- Initiator address validation
- Admin function authorization (onlyOwner checks)
- Account impersonation for callback caller spoofing

---

### 8. FlashLoanArbitrage.fork.test.ts

| Field | Value |
|-------|-------|
| **FILE** | contracts/test/FlashLoanArbitrage.fork.test.ts |
| **CATEGORY** | contract (Hardhat/Chai, fork-based) |
| **CATEGORIZATION BASIS** | Fork tests: simulates real on-chain conditions (Mainnet fork); tests against real Aave V3 pool, WETH, USDC; validates actual flash loan mechanics |
| **TEST COUNT** | 15 |
| **DESCRIBE STRUCTURE** | 1 top-level: `FlashLoanArbitrage (Mainnet Fork)` with nested suites (Real Pool Interaction, Real Token Handling, Gas Estimates) |
| **SOURCE CONTRACT TESTED** | `contracts/src/FlashLoanArbitrage.sol` (against real Aave V3) |
| **MOCK CONTRACTS USED** | MockDexRouter (2), MockERC20 (dai) — REAL: Aave V3 pool (0x7d2768...), WETH (0xc02a...), USDC (0xa0b8...) from fork |
| **REAL DEPENDENCIES** | **YES**: Mainnet fork via `hardhat_reset` + `blockTag: 'latest'`; real Aave V3 pool, WETH, USDC |
| **SETUP COMPLEXITY** | **HIGH**: Fork initialization, real token impersonation, real pool interaction simulation |
| **USES_LOAD_FIXTURE** | YES (all tests) |
| **PLACEMENT** | CORRECT (contracts/test/) |

**Key patterns:**
- Fork-based testing (not sandboxed like other tests)
- Real Aave V3 pool integration
- Actual flash loan fee calculation against real protocol
- Gas estimation for mainnet deployment
- **SUSPICIOUS**: Line 282 uses bare `.to.be.reverted` (should specify error type)

---

### 9. SyncSwapFlashArbitrage.test.ts

| Field | Value |
|-------|-------|
| **FILE** | contracts/test/SyncSwapFlashArbitrage.test.ts |
| **CATEGORY** | contract (Hardhat/Chai) |
| **CATEGORIZATION BASIS** | SyncSwap (zkSync) flash loan arbitrage: EIP-3156 compliance, 0.3% fee, onFlashLoan callback, admin functions |
| **TEST COUNT** | 43 |
| **DESCRIBE STRUCTURE** | 1 top-level: `SyncSwapFlashArbitrage` with nested suites (Deployment, Admin Functions, Flash Loan Execution, EIP-3156 Compliance, Reentrancy, Profit Calculation, Multi-hop) |
| **SOURCE CONTRACT TESTED** | `contracts/src/SyncSwapFlashArbitrage.sol` |
| **MOCK CONTRACTS USED** | MockSyncSwapVault, MockDexRouter (2), MockERC20 (weth, usdc, dai), MockMaliciousRouter |
| **REAL DEPENDENCIES** | None (fully mocked) |
| **SETUP COMPLEXITY** | **HIGH**: deployBaseFixture() + SyncSwap vault setup; EIP-3156 compliant callback validation |
| **USES_LOAD_FIXTURE** | YES (all tests) |
| **PLACEMENT** | CORRECT (contracts/test/) |

**Key patterns:**
- EIP-3156 flashFee interface validation
- 0.3% SyncSwap fee calculation (different from Aave 9 bps)
- onFlashLoan callback pattern (vs Aave executeOperation)
- zkSync-specific contract addresses
- Shared admin harness

---

### 10. PancakeSwapFlashArbitrage.test.ts

| Field | Value |
|-------|-------|
| **FILE** | contracts/test/PancakeSwapFlashArbitrage.test.ts |
| **CATEGORY** | contract (Hardhat/Chai) |
| **CATEGORIZATION BASIS** | PancakeSwap V3 flash loan arbitrage: pancakeV3FlashCallback, dual-token flash loans, fee tiers (100, 500, 2500, 10000 bps) |
| **TEST COUNT** | 34 |
| **DESCRIBE STRUCTURE** | 1 top-level: `PancakeSwapFlashArbitrage` with nested suites (Deployment, Admin Functions, Flash Loan Execution, Dual-Token Loans, Fee Tiers, Reentrancy, Profit Calculation) |
| **SOURCE CONTRACT TESTED** | `contracts/src/PancakeSwapFlashArbitrage.sol` |
| **MOCK CONTRACTS USED** | MockPancakeV3Factory, MockPancakeV3Pool, MockDexRouter (2), MockERC20 (weth, usdc, dai, usdt), MockMaliciousRouter |
| **REAL DEPENDENCIES** | None (fully mocked) |
| **SETUP COMPLEXITY** | **HIGH**: PancakeSwap V3 factory + pool deployment; fee tier configuration; dual-token flash loans |
| **USES_LOAD_FIXTURE** | YES (all tests) |
| **PLACEMENT** | CORRECT (contracts/test/) |

**Key patterns:**
- pancakeV3FlashCallback pattern (vs Aave/SyncSwap/Balancer)
- Dual-token flash loans (amount0, amount1)
- Fee tier array: [100, 500, 2500, 10000] bps
- Factory pool discovery (getPool)
- Shared admin harness

---

### 11. DaiFlashMintArbitrage.test.ts

| Field | Value |
|-------|-------|
| **FILE** | contracts/test/DaiFlashMintArbitrage.test.ts |
| **CATEGORY** | contract (Hardhat/Chai) |
| **CATEGORIZATION BASIS** | MakerDAO DssFlash DAI flash mint arbitrage: EIP-3156 compliance, 1 bps fee, onFlashLoan callback, DAI-specific asset |
| **TEST COUNT** | 32 |
| **DESCRIBE STRUCTURE** | 1 top-level: `DaiFlashMintArbitrage` with nested suites (Deployment, Router Management, Flash Loan Execution, Callback Validation, Reentrancy, Calculate Expected Profit, Multi-hop) |
| **SOURCE CONTRACT TESTED** | `contracts/src/DaiFlashMintArbitrage.sol` |
| **MOCK CONTRACTS USED** | MockDssFlash, MockDexRouter (2), MockERC20 (weth, usdc, dai, usdt), MockMaliciousRouter |
| **REAL DEPENDENCIES** | None (fully mocked) |
| **SETUP COMPLEXITY** | **HIGH**: deployBaseFixture() + DssFlash setup; DAI-specific constraints (flash mint always DAI) |
| **USES_LOAD_FIXTURE** | YES (all tests) |
| **PLACEMENT** | CORRECT (contracts/test/) |

**Key patterns:**
- EIP-3156 onFlashLoan callback pattern (DAI-specific implementation)
- 1 bps flash mint fee (lowest among all protocols)
- DAI-only asset enforcement (no external asset parameter in executeArbitrage)
- DssFlash caller + initiator validation
- Shared admin harness

---

### 12. MockProtocolFidelity.test.ts

| Field | Value |
|-------|-------|
| **FILE** | contracts/test/MockProtocolFidelity.test.ts |
| **CATEGORY** | contract (Hardhat/Chai) |
| **CATEGORIZATION BASIS** | Meta-test: validates mock contract behavior matches real protocol specifications (fee calculations, callbacks, array validation, repayment) |
| **TEST COUNT** | 51 |
| **DESCRIBE STRUCTURE** | 1 top-level: `Mock Protocol Fidelity` with nested suites (Aave V3, SyncSwap, Balancer V2, PancakeSwap V3) |
| **SOURCE CONTRACT TESTED** | N/A (tests mock contracts, not arbitrage contracts) |
| **MOCK CONTRACTS USED** | MockAavePool, MockSyncSwapVault, MockBalancerVault, MockPancakeV3Factory, MockPancakeV3Pool, MockERC20, MockFlashLoanRecipient |
| **REAL DEPENDENCIES** | None (validation of mock behavior) |
| **SETUP COMPLEXITY** | **HIGH**: 4 separate fixture types for different protocol mocks; fee calculation edge cases |
| **USES_LOAD_FIXTURE** | YES (all tests) |
| **PLACEMENT** | CORRECT (contracts/test/) |

**Key patterns:**
- **Aave V3**: 9 bps premium, executeOperation return validation, fee rounding
- **SyncSwap**: 0.3% fee (3000 bps), EIP-3156 compliance, flashFee interface
- **Balancer V2**: Zero fee, array length validation, multi-token flash loans
- **PancakeSwap V3**: Fee tier array [100, 500, 2500, 10000], dual-token support, pool discovery
- Critical for ensuring mock contracts accurately reproduce protocol behavior

---

### 13. CommitRevealArbitrage.execution.test.ts

| Field | Value |
|-------|-------|
| **FILE** | contracts/test/CommitRevealArbitrage.execution.test.ts |
| **CATEGORY** | contract (Hardhat/Chai) |
| **CATEGORIZATION BASIS** | Execution-focused: reveal phase swap execution, profit validation, admin functions (split from main test for maintainability) |
| **TEST COUNT** | 18 |
| **DESCRIBE STRUCTURE** | 1 top-level: `CommitRevealArbitrage Execution` with nested suites (Reveal Phase Swap Execution, Profit Validation, Admin Functions, View Functions, Mixed Valid/Invalid Reveals) |
| **SOURCE CONTRACT TESTED** | `contracts/src/CommitRevealArbitrage.sol` |
| **MOCK CONTRACTS USED** | MockDexRouter (2), MockERC20 (weth, usdc, dai, usdt, busd) |
| **REAL DEPENDENCIES** | None (fully mocked) |
| **SETUP COMPLEXITY** | **HIGH**: Shared deployCommitRevealFixture helper; multi-token setup for 5-hop testing |
| **USES_LOAD_FIXTURE** | YES (all tests) |
| **PLACEMENT** | CORRECT (contracts/test/) |

**Key patterns:**
- Single-hop, multi-hop (3-hop), max-hop (5-hop) execution
- Profit threshold validation (params.minProfit vs contract minimumProfit)
- Path validation (asset mismatch, continuity errors, length bounds)
- View function: calculateExpectedProfit (returns profit or 0 for invalid paths)
- GAP-001: Mixed valid/invalid sequential reveals (independent execution)

---

## Quality Gates

- [x] ALL 13 test files cataloged with full extraction
- [x] Every test has SOURCE CONTRACT TESTED identified
- [x] Every test has MOCK CONTRACTS USED listed
- [x] loadFixture usage checked for every file (13/13 use it)
- [x] Suspicious patterns section completed (1 found: bare `.to.be.reverted` in fork test)
- [x] TEST COUNT verified by counting actual `it()/test()` calls

## Test Count Totals

| File | Tests |
|------|-------|
| MultiPathQuoter.test.ts | 46 |
| UniswapV3Adapter.test.ts | 57 |
| CommitRevealArbitrage.test.ts | 47 |
| CommitRevealArbitrage.security.test.ts | 12 |
| FlashLoanArbitrage.test.ts | 38 |
| BalancerV2FlashArbitrage.test.ts | 30 |
| BalancerV2FlashArbitrage.callback-admin.test.ts | 24 |
| FlashLoanArbitrage.fork.test.ts | 15 |
| SyncSwapFlashArbitrage.test.ts | 43 |
| PancakeSwapFlashArbitrage.test.ts | 34 |
| DaiFlashMintArbitrage.test.ts | 32 |
| MockProtocolFidelity.test.ts | 51 |
| CommitRevealArbitrage.execution.test.ts | 18 |
| **TOTAL** | **447** |

## Architecture Notes

### Flash Loan Contract Pattern
- **Base**: `BaseFlashArbitrage` (abstract, 1135 lines)
- **Derived**: 6 concrete implementations (Aave, Balancer, PancakeSwap, SyncSwap, DaiFlashMint, CommitReveal)
- **Callback Pattern Variance**:
  - Aave: `executeOperation(asset, amount, premium, initiator, data)` → returns bool
  - Balancer: `receiveFlashLoan(tokens[], amounts[], feeAmounts[], userData)` → returns (bool, bytes)
  - PancakeSwap: `pancakeV3FlashCallback(fee0, fee1, data)` → returns true
  - SyncSwap/Dai: `onFlashLoan(initiator, token, amount, fee, data)` → returns bool (EIP-3156)

### Test Organization
- **Main test suite per contract** tests deployment, execution, admin functions, view functions
- **Security-focused splits**: CommitRevealArbitrage.security.test.ts, BalancerV2FlashArbitrage.callback-admin.test.ts
- **Execution-focused split**: CommitRevealArbitrage.execution.test.ts (separate reveal phase tests)
- **Fork test**: FlashLoanArbitrage.fork.test.ts (Mainnet fork for real protocol validation)
- **Protocol validation**: MockProtocolFidelity.test.ts (meta-test ensuring mocks are faithful)

### Helper Functions Pattern
- Shared test helpers in `contracts/test/helpers/` (imported in test files)
- Reusable admin harness functions: `testRouterManagement()`, `testMinimumProfitConfig()`, `testPauseUnpause()`, etc.
- Path builder helpers: `build2HopPath()`, `build3HopPath()`, `build2HopCrossRouterPath()`
- Commitment helpers: `createCommitmentHash()`, `mineBlocks()`, `getDeadline()`

### Fixture Strategy
- **deployBaseFixture()**: Core tokens + routers (reused across many tests)
- **Protocol-specific fixtures**: deployAavePoolFixture, deploySyncSwapVaultFixture, etc.
- **All fixtures use loadFixture()** for snapshot/restore efficiency

---

## Recommendations

1. **Fix fork test**: Line 282 in `FlashLoanArbitrage.fork.test.ts` should specify error type instead of bare `.to.be.reverted`
2. **Test coverage**: No tests for contract upgradeable patterns (if planned, consider adding proxy tests)
3. **Gas metering**: Fork test has gas estimates but no assertions; consider adding gas benchmarks
4. **Error message consistency**: OZ4 uses string-based `require()` messages; all test assertions correctly use `.revertedWith()` for these
