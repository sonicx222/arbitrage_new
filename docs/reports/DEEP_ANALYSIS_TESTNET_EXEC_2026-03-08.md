# Deep Analysis: Testnet Execution Mode (Commit 419b7fee)

**Date**: 2026-03-08
**Scope**: 8 files, +1054/-3 lines
**Agents**: 6 (architecture, bug-hunter, security, test-quality, mock-fidelity, performance)
**Grade**: **B-** (1 Critical, 2 High, 6 Medium, 4 Low)

---

## Executive Summary

- **Total findings**: 13 (1C / 2H / 6M / 4L)
- **Top 3 issues**:
  1. Testnet chain names break ALL downstream lookups — mode is non-functional (C-01)
  2. No production safety guard for TESTNET_EXECUTION_MODE (H-01)
  3. Cross-chain token resolution uses only buyChain for all tokens (H-02)
- **Agent agreement**: 5/6 agents independently flagged the chain name mismatch; 3/6 flagged the production guard gap; 3/6 flagged address duplication
- **Overall**: Well-structured testnet-resolver module with correct address mappings and good unit test coverage. However, the chain name transformation creates a fundamental integration gap — downstream infrastructure (providers, wallets, DEX config, CHAINS config) is keyed by mainnet names, not testnet names. This makes testnet execution mode **non-functional** in its current form and requires an architectural decision on where the mainnet/testnet boundary should be.
- **Address fidelity**: All 17 hardcoded addresses verified 100% matching against canonical source

---

## Critical Findings (P0)

### C-01: Testnet Chain Names Break ALL Downstream Infrastructure Lookups

| Field | Value |
|-------|-------|
| Category | Bug / Architecture / Integration |
| Files | `services/execution-engine/src/execution-pipeline.ts:490-512`, `services/execution-engine/src/strategies/base.strategy.ts:482-487` |
| Agents | bug-hunter (BUG-1), security (SEC-002), architecture (#3), team-lead (M-03) |
| Confidence | HIGH (95%) |
| Score | 5.0 |

**Description**: After `transformOpportunityForTestnet()` remaps chain names (e.g., `ethereum` → `sepolia`), the transformed names propagate through the entire execution pipeline. But ALL downstream infrastructure is keyed by mainnet chain names:

1. **Providers**: `ctx.providers.get('sepolia')` → `undefined` (providers registered under `'ethereum'`)
2. **Wallets**: `ctx.wallets.get('sepolia')` → `undefined` (wallets registered under `'ethereum'`)
3. **CHAINS config**: `CHAINS['sepolia']` → `undefined` (only mainnet chains in CHAINS)
4. **DEX config**: `DEXES_BY_CHAIN_AND_NAME.get('sepolia')` → `undefined`
5. **Flash loan providers**: `FLASH_LOAN_PROVIDERS['sepolia']` → `undefined`
6. **Execution support**: `isExecutionSupported('sepolia')` → `false`

**Data flow trace**:
```
executeOpportunity(opportunity)
  → transformOpportunityForTestnet: buyChain 'ethereum' → 'sepolia'
  → resolvedBuyChain = 'sepolia'
  → chain = 'sepolia'
  → strategy.execute(opportunity, ctx) where ctx.providers has no 'sepolia' key
  → validateContext(): { valid: false, error: '[ERR_NO_PROVIDER] No provider for chain: sepolia' }
  → OPPORTUNITY FAILS
```

**Impact**: Testnet execution mode is **completely non-functional**. Every opportunity will fail with `[ERR_NO_PROVIDER]` or `[ERR_NO_WALLET]` errors.

**Root cause**: The transform remaps chain names too early — before the infrastructure layer that needs mainnet names. The testnet-resolver correctly maps addresses for on-chain transactions, but the chain name is used for two different purposes:
- **Infrastructure routing** (which provider/wallet/config to use) — needs mainnet name
- **On-chain execution** (which network to transact on) — needs testnet name

**Suggested fix options**:
- **(A) Dual-name approach**: Keep `buyChain`/`chain` as mainnet names for infrastructure lookups. Add `_testnetBuyChain`/`_testnetChain` fields for on-chain resolution. Transform only at the transaction submission boundary.
- **(B) Testnet infrastructure registration**: When `TESTNET_EXECUTION_MODE=true`, register providers/wallets under testnet chain names at startup. Add testnet chains to CHAINS config behind the mode flag.
- **(C) Late-stage transform**: Move `transformOpportunityForTestnet()` from `executeOpportunity()` to just before transaction submission in each strategy, after all config/provider lookups are done.

Option (C) is the simplest change. Option (A) is the cleanest architecturally.

---

## High Findings (P1)

### H-01: No Production Safety Guard for TESTNET_EXECUTION_MODE

| Field | Value |
|-------|-------|
| Category | Security / Defense-in-Depth |
| Files | `services/execution-engine/src/engine.ts`, `services/execution-engine/src/strategies/base.strategy.ts:955` |
| Agents | team-lead (H-01), security (SEC-001), architecture (#4) |
| Confidence | HIGH (95%) |
| Score | 4.0 |

**Description**: `SIMULATION_MODE` has an explicit production safety guard in `engine.ts:308-327` that throws on startup if the flag is set with `NODE_ENV=production` (without an override). `TESTNET_EXECUTION_MODE` has **no equivalent guard**.

If TESTNET_EXECUTION_MODE=true is accidentally set in production:
- Profit/confidence thresholds are **completely bypassed** (base.strategy.ts:955)
- Chain names and token addresses are remapped to testnet equivalents
- The analysis report (task #10) explicitly planned a startup guard but it was not implemented

**Mitigating factor**: Due to C-01, testnet mode currently fails at provider lookup, so no real transactions would occur. But if C-01 is fixed without also adding this guard, the production risk materializes.

**Existing pattern** (engine.ts:308-327):
```typescript
const isProduction = process.env.NODE_ENV === 'production';
if (isProduction && this.isSimulationMode) {
  throw new Error('[CRITICAL] Simulation mode is enabled in production...');
}
```

**Suggested fix**: Add equivalent guard in engine.ts constructor:
```typescript
if (isProduction && process.env.TESTNET_EXECUTION_MODE === 'true') {
  throw new Error(
    '[CRITICAL] TESTNET_EXECUTION_MODE is enabled in production. ' +
    'This bypasses profit thresholds and remaps addresses to testnet.'
  );
}
```

---

### H-02: Cross-Chain Token Resolution Uses Only buyChain for All Tokens

| Field | Value |
|-------|-------|
| Category | Bug / Logic Error |
| File | `services/execution-engine/src/services/testnet-resolver.ts:237-248` |
| Agents | team-lead (H-02), bug-hunter (BUG-2), test-quality (TQ-002) |
| Confidence | MEDIUM (75%) |
| Score | 3.5 |

**Description**: In `transformOpportunityForTestnet()`, all four token fields are resolved using `mainnetChain` (= `buyChain ?? chain`). For cross-chain opportunities, sell-side tokens on a different chain won't be correctly mapped.

**Example**: Cross-chain arb: buy on ethereum, sell on arbitrum. `tokenOut` = Arbitrum USDC (`0xaf88...`). Lookup: `resolveTestnetTokenAddress('ethereum', '0xaf88...')` → returns original address (no match in ethereum map). Should use `resolveTestnetTokenAddress('arbitrum', '0xaf88...')`.

**Impact**: Cross-chain testnet execution would use wrong sell-side token addresses. Same-chain (primary use case) unaffected. Note: Currently moot due to C-01.

**Suggested fix**: Use `mainnetSellChain` for sell-side tokens (exact mapping depends on tokenIn/tokenOut convention in cross-chain opportunities).

---

## Medium Findings (P2)

### M-01: Mode Requirements Documented But Not Enforced

| Field | Value |
|-------|-------|
| Category | Configuration / Robustness |
| Files | `.env.example:267`, `shared/core/src/simulation/mode-utils.ts:92` |
| Agents | team-lead, bug-hunter (BUG-5), security (SEC-006), architecture (#7) |
| Confidence | HIGH (95%) |
| Score | 3.0 |

`.env.example` documents "Requires: SIMULATION_MODE=true, EXECUTION_SIMULATION_MODE=false" but no code validates this. Invalid combinations silently accepted. Additionally, `getSimulationModeSummary()` reports `'testnet-live'` even when `EXECUTION_SIMULATION_MODE=true` (which causes SimulationStrategy to intercept — no real testnet transactions despite the label).

**Fix**: Add startup validation warnings.

---

### M-02: `isTestnetExecutionMode()` Created But Unused

| Field | Value |
|-------|-------|
| Category | Code Quality / Consistency |
| Files | `mode-utils.ts:72`, `execution-pipeline.ts:480`, `base.strategy.ts:955` |
| Agents | team-lead, architecture (#1-2), performance |
| Confidence | HIGH (100%) |
| Score | 2.5 |

Both consumers use raw `process.env.TESTNET_EXECUTION_MODE === 'true'` instead of the centralized utility. Performance reviewer also notes this should be cached at initialization time (like `isSimulationMode` in engine.ts constructor).

**Fix**: Use `isTestnetExecutionMode()` and cache at init.

---

### M-03: `hops[]` Token/Router Addresses Not Transformed

| Field | Value |
|-------|-------|
| Category | Bug / Incomplete Implementation |
| File | `services/execution-engine/src/services/testnet-resolver.ts:230-249` |
| Agents | bug-hunter (BUG-7) |
| Confidence | MEDIUM (70%) |
| Score | 2.5 |

`transformOpportunityForTestnet()` transforms top-level token fields but does NOT transform addresses inside `hops[]` (used by triangular/multi-leg flash loan strategies). The spread `...opportunity` copies hops by reference — each hop's `tokenIn`/`tokenOut`/`router` remain mainnet addresses.

**Impact**: N-hop opportunities would submit mainnet addresses to testnet chains, causing reverts.

**Fix**: Add hop transformation:
```typescript
hops: opportunity.hops?.map(hop => ({
  ...hop,
  tokenIn: hop.tokenIn ? resolveTestnetTokenAddress(mainnetChain, hop.tokenIn) : hop.tokenIn,
  tokenOut: hop.tokenOut ? resolveTestnetTokenAddress(mainnetChain, hop.tokenOut) : hop.tokenOut,
})),
```

---

### M-04: Router/Flash-Loan Resolution Functions Are Dead Code

| Field | Value |
|-------|-------|
| Category | Incomplete Implementation |
| File | `services/execution-engine/src/services/testnet-resolver.ts:159-188` |
| Agents | security (SEC-005) |
| Confidence | HIGH (100%) |
| Score | 2.5 |

`getTestnetRouter()`, `getTestnetRouters()`, and `getTestnetFlashLoanContract()` are exported, tested (7 tests), but **never called** by any execution code. The opportunity transformation doesn't include router addresses, and strategies resolve routers from config rather than from the opportunity object. These are well-implemented dead code that suggests incomplete integration.

**Fix**: Either wire into strategy execution or document as "available for future use" in JSDoc.

---

### M-05: Missing Tests for Pipeline Integration and Mode Interactions

| Field | Value |
|-------|-------|
| Category | Test Coverage |
| Agents | team-lead, test-quality (TQ-001 through TQ-006) |
| Confidence | HIGH (100%) |
| Score | 2.5 |

The 34 unit tests cover testnet-resolver.ts functions well. Key gaps:
- `isTestnetExecutionMode()` and `getSimulationModeSummary()` — zero test coverage
- `executeOpportunity()` testnet transform hook — untested
- `verifyOpportunityPrices()` testnet bypass — untested
- Cross-chain test doesn't verify token resolution, only chain names
- Undefined tokenIn/tokenOut branch untested

---

### M-06: Addresses Duplicated Between testnet-resolver.ts and addresses.ts

| Field | Value |
|-------|-------|
| Category | DRY / Maintainability |
| Files | `testnet-resolver.ts`, `contracts/deployments/addresses.ts` |
| Agents | team-lead, architecture (#4-5), mock-fidelity |
| Confidence | HIGH (100%) |
| Score | 2.0 |

Token/router/flash-loan addresses are hardcoded in testnet-resolver.ts rather than imported from addresses.ts. All currently match (verified by mock-fidelity agent), but creates maintenance burden. Architecture agent suggests module should live in `shared/core/src/simulation/` rather than `services/execution-engine/src/services/` to enable sharing across services.

---

## Low Findings (P3)

### L-01: No ADR Document for Testnet Execution Mode

Architecture agent notes all major execution modes have ADRs (ADR-016, ADR-037-039). This new mode should have one.

### L-02: USDT→USDC Mapping May Cause Confusion

USDT mapped to USDC testnet addresses on ethereum/arbitrum (documented inline). USDT-USDC arb opportunities resolve to same-token swaps on testnet. Mock-fidelity agent confirmed pattern is correct but undocumented at architecture level.

### L-03: Pre-existing `||` vs `??` for opportunityTimeoutMs

Bug-hunter found `base.strategy.ts:928`: `ARBITRAGE_CONFIG.opportunityTimeoutMs || 30000` should use `??` per project convention. Pre-existing issue, not introduced by this commit.

### L-04: Test Could Use test.each for Parameterized Chains

Performance and test-quality agents both noted tests repeat patterns for multiple chains.

---

## Cross-Agent Agreement Map

| Area | Agents Flagging | Finding |
|------|----------------|---------|
| Chain name breaks downstream | bug-hunter, security, architecture, performance, team-lead | C-01 |
| Production safety guard | team-lead, security, architecture | H-01 |
| Cross-chain token resolution | team-lead, bug-hunter, test-quality | H-02 |
| process.env vs utility function | team-lead, architecture, performance | M-02 |
| Address duplication | team-lead, architecture, mock-fidelity | M-06 |
| Mode requirement enforcement | team-lead, bug-hunter, security, architecture | M-01 |
| Missing integration tests | team-lead, test-quality | M-05 |

**Zero cross-agent disagreements.**

---

## Address Fidelity Matrix

All 17 addresses verified 100% matching between testnet-resolver.ts and addresses.ts by mock-fidelity agent:

| Category | Chains Verified | Status |
|----------|----------------|--------|
| Token addresses | ethereum, arbitrum, base, zksync (11 entries) | All match |
| Router addresses | sepolia, arbitrumSepolia, baseSepolia, zksync-testnet (5 entries) | All match |
| Flash loan contracts | sepolia, arbitrumSepolia, baseSepolia (3 entries) | All match |

Missing but intentionally omitted: polygonAmoy, bscTestnet (no testnet deployments).

---

## Performance Assessment

| Aspect | Assessment |
|--------|------------|
| Hot-path impact (production) | **Negligible** — Single string comparison per opportunity (~ns) |
| Hot-path impact (testnet) | **Low** — ~30-50μs per transform (spread + 4 toLowerCase + lookups) |
| Memory | **Good** — Module-level constants, no per-call allocations except spread |
| Code quality | **Good** — Clean separation, O(1) lookups, Readonly types, DRY patterns |

---

## Recommended Action Plan

### Phase 1: Immediate (before testnet deployment)
- [ ] **C-01**: Fix chain name propagation — either late-stage transform (option C) or dual-name approach (option A)
- [ ] **H-01**: Add production safety guard for TESTNET_EXECUTION_MODE in engine.ts
- [ ] **H-02**: Fix cross-chain token resolution (use sellChain for sell-side tokens)

### Phase 2: Before production
- [ ] **M-01**: Add startup validation for mode flag requirements
- [ ] **M-02**: Replace raw process.env with isTestnetExecutionMode(), cache at init
- [ ] **M-03**: Transform hops[] addresses in transformOpportunityForTestnet()
- [ ] **M-04**: Wire router/flash-loan resolution or document as future-use
- [ ] **M-05**: Add integration tests for pipeline, strategy bypass, mode-utils

### Phase 3: Backlog
- [ ] **M-06**: Import from addresses.ts instead of duplicating; consider moving module to shared/core
- [ ] **L-01**: Create ADR document
- [ ] **L-02**: Add USDT→USDC substitution logging
- [ ] **L-03**: Fix pre-existing `||` → `??` for opportunityTimeoutMs
- [ ] **L-04**: Refactor tests to test.each
