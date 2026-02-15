# Deep Analysis: `shared/core/src/bridge-router/`

**Date**: 2026-02-14
**Agents**: 6 (architecture-auditor, bug-hunter, security-auditor, test-quality-analyst, mock-fidelity-validator, performance-refactor-reviewer)
**Files analyzed**: 5 source + 1 test + 1 config (~2,500 lines)

---

## Executive Summary

- **Total findings**: 28 unique (after deduplication from 55 raw findings across 6 agents)
- **By severity**: 5 Critical/P0, 9 High/P1, 10 Medium/P2, 4 Low/P3
- **Top 3 highest-impact issues**:
  1. **ETH bridging sends wrong msg.value** -- ETH bridges will revert 100% of the time (Bug, P0)
  2. **USDT approval pattern will revert** on non-zero to non-zero allowance change (Bug+Security, P0)
  3. **execute() success path has zero test coverage** -- the core function of the module is untested (Test, P0)
- **Overall health grade**: **C+**
- **Agent agreement map**: 8 findings independently identified by 2+ agents, highest agreement (4 agents) on BRIDGE_TIMES latency inconsistency

---

## Critical Findings (P0 - Security/Correctness/Financial Impact)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| 1 | Bug | `stargate-router.ts:346-395` | **ETH bridging missing msg.value**: When bridging ETH, `tx.value` only includes the LayerZero gas fee, not the bridge amount. Stargate `swap()` for ETH expects `msg.value = amountIn + nativeFee`. All ETH bridges will revert on-chain. | Bug | HIGH | 4.6 |
| 2 | Bug+Security | `stargate-router.ts:646` | **USDT approve() reverts on non-zero allowance**: Uses `approve(MaxUint256)` instead of `forceApprove` pattern. USDT requires allowance be 0 before setting new non-zero value. After any partial allowance spend, all USDT bridges fail. Violates CLAUDE.md documented convention. | Bug, Security, Arch | HIGH | 4.6 |
| 3 | Bug | `stargate-router.ts:250` | **Mixed-denomination totalFee**: `bridgeFee` (token wei, e.g. USDC 6 decimals) + `gasFee` (ETH wei, 18 decimals) produces meaningless number. Consumed by `cross-chain.strategy.ts:396` for profitability calculations, causing wildly wrong fee estimates. | Bug, Mock, Perf | HIGH | 4.4 |
| 4 | Bug | `stargate-router.ts:511-520,553` | **Timeout-then-complete race loses fund tracking**: `getStatus()` mutates bridge to 'failed' after 15min timeout. `markCompleted()` then rejects late completions. Funds arrive on destination but system thinks they didn't. No recovery within process lifetime. | Bug, Security | HIGH | 4.2 |
| 5 | Test | `bridge-router.test.ts` | **execute() success path entirely untested**: The core function (168 lines: approval, gas estimation, tx building, bridge tracking, eviction) has zero test coverage. Only 3 rejection paths tested. ERC20 approval flow (5 code paths) also completely untested. | Test, Mock | HIGH | 4.0 |

### Suggested Fixes for P0

**Fix #1 (ETH msg.value)**:
```typescript
// stargate-router.ts:391-395
const tx: ethers.TransactionRequest = {
  to: routerAddress,
  data: txData,
  value: quote.token === 'ETH'
    ? BigInt(quote.amountIn) + BigInt(quote.gasFee)  // ETH: bridge amount + LZ fee
    : BigInt(quote.gasFee),                           // ERC20: LZ fee only
};
```

**Fix #2 (USDT forceApprove)**:
```typescript
// stargate-router.ts:646 - replace approve with forceApprove pattern
// First set to 0 (required for USDT), then set to desired amount
const resetTx = await token.approve(spenderAddress, 0n);
await resetTx.wait();
const approveTx = await token.approve(spenderAddress, amount);
```

**Fix #3 (Mixed totalFee)**: Return `bridgeFee` and `gasFee` separately; remove or redefine `totalFee`. Downstream consumers in `cross-chain.strategy.ts` must handle two fee types independently.

**Fix #4 (Timeout race)**: Allow `markCompleted()` to transition from 'failed' -> 'completed' when `failReason === 'timeout'`. Add a `failReason` field to `PendingBridge` to distinguish timeout from actual failures.

**Fix #5 (Test coverage)**: Write execute() success path tests mocking `ethers.Contract`, `wallet.estimateGas`, `wallet.sendTransaction`. Test ERC20 approval: sufficient allowance, insufficient, failure, USDT pattern.

---

## High Findings (P1 - Reliability/Coverage Impact)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| 6 | Security | `stargate-router.ts:415,647` | **wait() has no timeout**: `txResponse.wait()` and `approveTx.wait()` block indefinitely if tx stuck in mempool. Outer `withTransactionTimeout()` exists in caller but abandoned promises may leak connections. | Bug, Security | HIGH | 3.8 |
| 7 | Security | `stargate-router.ts:646` | **MaxUint256 infinite approval**: Grants unlimited token spending to Stargate router. If V1 contract is compromised/deprecated, entire token balance at risk. Use exact-amount approval instead. | Security | HIGH | 3.6 |
| 8 | Config | `types.ts:392-405` vs `bridge-config.ts:54-71` | **BRIDGE_TIMES inflated 3.3x vs bridge-config**: ethereum-arbitrum: 600s vs 180s. StargateRouter uses inflated times for quotes/timeouts. Bridge-config has accurate Stargate times. Dual source of truth with no cross-reference. | Arch, Bug, Mock, Perf | HIGH | 3.6 |
| 9 | Test | `bridge-router.test.ts` | **State transition guards untested**: `markCompleted`/`markFailed` reject invalid transitions (completed->failed, failed->completed) but these guards are never verified by tests. | Test | HIGH | 3.4 |
| 10 | Test | `bridge-router.test.ts` | **getStatus() timeout detection untested**: Bridge timeout (elapsedMs > maxBridgeWaitMs) that transitions to 'failed' is never tested. Safety-critical feature with zero coverage. | Test | HIGH | 3.4 |
| 11 | Bug | `stargate-router.ts:365` | **execute() ignores quote.recipient**: Always sends to `wallet.address` even when `BridgeQuoteRequest.recipient` was set. API contract violated. Benign for current self-bridging but would misdirect funds if recipient feature used. | Bug | HIGH | 3.2 |
| 12 | Security | `stargate-router.ts:46-65` | **Missing USDC token address for Fantom**: `STARGATE_TOKEN_ADDRESSES` missing USDC/fantom. `isRouteSupported()` returns true (pool IDs exist) but `execute()` silently skips approval -> tx reverts on-chain wasting gas. | Security | HIGH | 3.2 |
| 13 | Bug | `stargate-router.ts:618` | **ensureApproval() has no mutex**: Two concurrent execute() calls for same token can both see insufficient allowance and both submit approvals. Wastes gas; for USDT, second call reverts. | Bug | MEDIUM | 3.0 |
| 14 | Bug | `index.ts:66-78` | **BridgeRouterFactory never disposes StargateRouter**: Factory has no `dispose()`. Engine nulls factory on shutdown without stopping cleanup timer. Timer uses `.unref()` (mitigated) but leaks in tests. | Bug | HIGH | 3.0 |

---

## Medium Findings (P2 - Maintainability/Configuration)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| 15 | Docs | `types.ts:11` | **ADR-014 reference wrong**: Points to "Cross-Chain Execution Design" but ADR-014 is actually "Modular Detector Components". No ADR exists for bridge-router architecture decisions. | Arch | HIGH | 3.2 |
| 16 | Docs | `ARCHITECTURE_V2.md` | **Architecture doc missing bridge-router**: Zero mentions of Stargate, StargateRouter, BridgeRouterFactory, IBridgeRouter, or `shared/core/src/bridge-router/`. Module undiscoverable by new developers. | Arch | HIGH | 3.0 |
| 17 | Config | `types.ts:333-342` | **zkSync/Linea missing from Stargate Router**: System monitors 11 chains but bridge-router only supports 8. Cross-chain opportunities involving zkSync/Linea detected but cannot be executed. | Arch | HIGH | 2.8 |
| 18 | Config | `types.ts:378-387` | **Stargate V1 addresses may be deprecated**: All addresses are V1 (launched pre-2024). V2 launched with new architecture. V1 liquidity may be declining. No update mechanism without code changes. | Arch, Security | MEDIUM | 2.8 |
| 19 | Security | `stargate-router.ts:304-472` | **No balance check before execution**: Never checks token or native balance before sending. Failed tx wastes gas. `estimateGas` may catch some cases but error messages are opaque. | Security | HIGH | 2.6 |
| 20 | Test | `bridge-router.test.ts:432-481` | **MAX_PENDING_BRIDGES test replicates eviction logic**: Test manually implements the eviction algorithm instead of testing through `execute()`. Proves concept works but NOT that source code's eviction works. False confidence. | Test, Mock | HIGH | 2.6 |
| 21 | Config | `types.ts:23` vs `bridge-config.ts:52-147` | **BridgeProtocol type and config protocol list diverged**: types.ts has {stargate, native, hop, across, celer}. bridge-config.ts has {stargate, across, native, wormhole, connext, hyperlane}. `selectOptimalBridge()` can return protocols that BridgeRouterFactory cannot instantiate. | Arch | HIGH | 2.4 |
| 22 | Arch | `bridge-config.ts` vs `bridge-router/types.ts` | **No integration between two bridge config sources**: bridge-config.ts (shared/config) and types.ts (shared/core) define independent bridge data with no cross-references. Dual source of truth causing Finding #8. | Arch, Perf | HIGH | 2.4 |
| 23 | Test | `bridge-router.test.ts:100-116` | **createTestQuote() has incorrect totalFee**: `totalFee: '10000600000'` should be `'10000000000600000'`. Dormant - no test asserts on it, but will corrupt any future test that does. Same bug in `test-helpers.ts:72`. | Mock, Perf | HIGH | 2.2 |
| 24 | Security | `types.ts:133` | **BridgeExecuteRequest.deadline never enforced**: Caller passes deadline but `execute()` ignores it. Quote expiry provides similar protection but deadline semantics are different. | Security | HIGH | 2.0 |

---

## Low Findings (P3 - Style/Minor Improvements)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| 25 | Smell | `index.ts:101` | **findBestRouter() misleading name**: Returns first matching router, not best. Should be `findSupportedRouter()` or integrate with `selectOptimalBridge()`. | Arch, Perf | HIGH | 3.3 |
| 26 | Dup | `stargate-router.ts:188-294` | **Triplicated invalid quote pattern**: Same 13-line error quote object repeated 3 times in `quote()`. Extract `createInvalidQuote()` helper. ~21 lines saved. | Perf | HIGH | 3.6 |
| 27 | Smell | `stargate-router.ts:248,404` | **Magic numbers**: Hardcoded `6n/10000n` (fee) and `120n/100n` (gas buffer). Extract to named constants. | Perf | HIGH | 3.2 |
| 28 | Test | `bridge-router.test.ts:330+` | **Pervasive `(router as any)` private access**: 6+ test blocks access internals via type casting. Fragile to refactoring. Consider test helper methods. | Perf | HIGH | 2.3 |

---

## Test Coverage Matrix

| Source File | Method | Happy Path | Error Path | Edge Cases | Notes |
|---|---|---|---|---|---|
| StargateRouter | `constructor()` | YES | - | YES (no providers) | Via factory |
| StargateRouter | `dispose()` | YES | - | - | In afterEach only |
| StargateRouter | `registerProvider()` | YES | - | - | Single test |
| StargateRouter | `quote()` | YES | YES (3) | - | Missing: custom slippage |
| StargateRouter | **`execute()`** | **NO** | YES (3) | **NO** | **CRITICAL GAP - 168 lines uncovered** |
| StargateRouter | `getStatus()` | Partial | YES (unknown) | **NO** (timeout) | Missing timeout detection |
| StargateRouter | `markCompleted()` | YES | **NO** (not-found) | **NO** (state guards) | Missing invalid transitions |
| StargateRouter | `markFailed()` | YES | **NO** (not-found) | **NO** (state guards) | Missing invalid transitions |
| StargateRouter | `isRouteSupported()` | YES | YES | YES | **Good coverage** |
| StargateRouter | `getEstimatedTime()` | YES | - | YES | **Good coverage** |
| StargateRouter | `healthCheck()` | YES | YES | YES | **Good coverage** |
| StargateRouter | `cleanup()` | YES | - | NO (empty map) | Missing edge case |
| StargateRouter | `ensureApproval()` | **NO** | **NO** | **NO** | **CRITICAL GAP - 5 code paths** |
| BridgeRouterFactory | All methods | YES* | **NO** (getRouter err) | - | *Only in cross-chain-execution.test.ts |
| Factory functions | `createStargateRouter()` | YES | - | YES | Good |
| Factory functions | `createBridgeRouterFactory()` | **NO** | - | - | Never tested |

**Coverage estimate**: ~45% of code paths

---

## Mock Fidelity Matrix

| Mock | Real Interface | Methods Covered | Behavior Fidelity | Issues |
|---|---|---|---|---|
| `createMockProvider()` | ethers.Provider | 17 methods | Good | Adequate for all source usage |
| `createMockWallet()` | ethers.Wallet | 8 methods | Partial | `estimateGas`/`sendTransaction` never exercised |
| Stargate Contract Mock | ethers.Contract | `quoteLayerZeroFee` only | Correct returns | Missing `swap()` - execute untested |
| Logger Mock | createLogger() | 4 methods | Adequate | No issues |
| AsyncMutex | Real implementation | Full | **Correct** | Good choice (not mocked) |
| ERC20 Mock | ethers.Contract | **None** | **None** | `allowance`/`approve` never mocked |

**Mock fidelity grade**: B-

---

## Cross-Agent Insights

Findings independently identified by multiple agents, validating accuracy:

| Finding | Agents | Significance |
|---------|--------|-------------|
| USDT approve() pattern (#2) | Bug, Security, Architecture | 3/6 agents - highest agreement on a correctness bug |
| BRIDGE_TIMES inconsistency (#8) | Architecture, Bug, Mock, Performance | 4/6 agents - most widely noticed config issue |
| Mixed totalFee (#3) | Bug, Mock, Performance | 3/6 agents - cross-validates the math is wrong |
| wait() no timeout (#6) | Bug, Security | 2/6 agents - confirms operational risk |
| Stargate V1 deprecated (#18) | Architecture, Security | 2/6 agents - confirms protocol staleness |
| Timeout-complete race (#4) | Bug, Security | 2/6 agents - confirms fund tracking risk |
| findBestRouter misleading (#25) | Architecture, Performance | 2/6 agents - confirms naming issue |
| Execute untested (#5) | Test, Mock | 2/6 agents - confirms critical coverage gap |

**Key cross-agent insight**: The Bug Hunter found that `totalFee` mixes denominations (Finding #3). The Mock Fidelity agent independently found that `createTestQuote()` has the wrong `totalFee` value. The Performance agent found the same. All three converge: the source calculates a meaningless value, AND the test uses a different meaningless value, AND no test validates the field - meaning this bug has been invisible in three independent ways.

---

## Recommended Action Plan

### Phase 1: Immediate (P0 -- fix before any production bridge execution)

- [ ] **Fix #1**: Add ETH `msg.value = amountIn + gasFee` in execute() (Bug Hunter)
- [ ] **Fix #2**: Replace `approve(MaxUint256)` with forceApprove pattern for USDT safety (Bug+Security+Arch, 3 agents)
- [ ] **Fix #3**: Split `totalFee` into separate `bridgeFee`/`gasFee` in BridgeQuote; update cross-chain.strategy.ts consumer (Bug+Mock+Perf, 3 agents)
- [ ] **Fix #4**: Allow `markCompleted()` for timeout-failed bridges with `failReason` field (Bug+Security, 2 agents)
- [ ] **Fix #5**: Write execute() success path + ensureApproval() tests (Test+Mock, 2 agents)

### Phase 2: Next Sprint (P1 -- reliability and coverage)

- [ ] **Fix #6**: Add timeout wrapper to `txResponse.wait()` and `approveTx.wait()` (Bug+Security)
- [ ] **Fix #7**: Use exact-amount approval instead of MaxUint256 (Security)
- [ ] **Fix #8**: Consolidate BRIDGE_TIMES into single source (bridge-config.ts), inject via constructor (Arch+Bug+Mock+Perf, 4 agents)
- [ ] **Fix #9**: Test state transition guards for markCompleted/markFailed (Test)
- [ ] **Fix #10**: Test getStatus() timeout detection (Test)
- [ ] **Fix #11**: Use `quote.recipient` in execute(), fallback to wallet.address (Bug)
- [ ] **Fix #12**: Add missing USDC/Fantom address; validate token address exists in execute() (Security)
- [ ] **Fix #13**: Add per-token mutex for ensureApproval() (Bug)
- [ ] **Fix #14**: Add dispose() to BridgeRouterFactory (Bug)

### Phase 3: Backlog (P2/P3 -- config, docs, refactoring)

- [ ] **Fix #15**: Correct ADR-014 reference; consider writing ADR for bridge-router (Arch)
- [ ] **Fix #16**: Document bridge-router in ARCHITECTURE_V2.md (Arch)
- [ ] **Fix #17**: Add zkSync/Linea support or document exclusion (Arch)
- [ ] **Fix #18**: Evaluate Stargate V2 migration (Arch+Security)
- [ ] **Fix #19**: Add pre-flight balance checks (Security)
- [ ] **Fix #20**: Rewrite MAX_PENDING_BRIDGES test to use execute() path (Test+Mock)
- [ ] **Fix #21**: Align BridgeProtocol type with bridge-config protocol list (Arch)
- [ ] **Fix #22**: Integrate bridge-config.ts with bridge-router constants (Arch+Perf)
- [ ] **Fix #23**: Fix createTestQuote() totalFee value (Mock+Perf)
- [ ] **Fix #24**: Enforce or remove deadline field (Security)
- [ ] **Fix #25**: Rename findBestRouter -> findSupportedRouter (Arch+Perf)
- [ ] **Fix #26**: Extract createInvalidQuote() helper (Perf)
- [ ] **Fix #27**: Extract magic numbers to named constants (Perf)
- [ ] **Fix #28**: Reduce `as any` test access with test helpers (Perf)
