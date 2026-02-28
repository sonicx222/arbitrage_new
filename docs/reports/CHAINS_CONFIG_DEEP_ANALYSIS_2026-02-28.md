# Deep Analysis: shared/config/src/chains

**Date**: 2026-02-28
**Scope**: `shared/config/src/chains/` (3 source files, ~1600 LOC)
**Tests**: `shared/config/__tests__/unit/provider-config.test.ts`, `shared/config/__tests__/unit/chains/chain-url-builder.test.ts`
**Analysis**: Self-executed by Team Lead (focused scope — 3 files, agent overhead unjustified)

---

## Executive Summary

- **Total findings**: 12 (0 Critical, 2 High, 5 Medium, 5 Low)
- **Top 3 issues**:
  1. QuickNode is a phantom provider — defined in config and time-based ordering but has no URL builder, no chain mappings, and is never used in any fallback chain
  2. 11 stale "6-Provider Shield" comments after the 8-Provider Shield upgrade
  3. `CHAIN_NETWORK_NAMES` is missing 4 emerging L2 chains (blast, scroll, mantle, mode), causing `getProviderUrlsForChain()` to throw for valid chains
- **Overall health**: **B+** — Core chain config (CHAINS object, fallback URLs) is solid and well-tested. Provider utility functions have dead code, stale docs, and completeness gaps.
- **Agent agreement**: N/A (single-analyst execution)

---

## High Findings (P1)

| # | Category | File:Line | Description | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|------------|---------------|-------|
| 1 | Dead Config | provider-config.ts:117-125 | **QuickNode phantom provider**: Defined in `PROVIDER_CONFIGS` and included in all 3 `getTimeBasedProviderOrder()` return arrays, but: no `buildQuickNodeUrl` function exists, not in `CHAIN_NETWORK_NAMES`, not in `getProviderUrlsForChain()`, not in any chain fallback list. `QUICKNODE_API_KEY` is in `.env.example` but can never be used. Creates false impression of 8 real providers when only 7 are functional. | HIGH | Either implement QuickNode URL builder + chain mappings + fallback entries, OR remove from PROVIDER_CONFIGS and getTimeBasedProviderOrder. | 3.6 |
| 2 | Doc-Code Mismatch | provider-config.ts:5 | **Stale capacity total**: File header says "Combined Free Tier: ~540M CU/month" but with OnFinality added (15M/month), the correct total is ~555M CU/month. `index.ts:12` correctly says "~555M". | HIGH | Update provider-config.ts:5 to "~555M CU/month" | 2.8 |

---

## Medium Findings (P2)

| # | Category | File:Line | Description | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|------------|---------------|-------|
| 3 | Doc-Code Mismatch | index.ts (11 locations) | **11 stale "6-Provider" comments**: After adding OnFinality + BlastAPI to make 8 providers, 11 comments still reference "6-Provider Shield". Locations: index.ts lines 88, 141, 196, 224, 247, 313, 340, 466; chain-url-builder.ts lines 234, 385; provider-config.ts line 2. | HIGH | Find/replace "6-Provider" → "8-Provider" in all 11 locations | 3.2 |
| 4 | Completeness | provider-config.ts:139-240 | **CHAIN_NETWORK_NAMES missing 4 emerging L2s**: blast, scroll, mantle, mode are valid chains in `CHAINS` but not in `CHAIN_NETWORK_NAMES`. Calling `getProviderUrlsForChain('blast')` throws `Unknown chain: blast`. Currently no service consumers (services use CHAINS directly), but it's a public API contract violation. | HIGH | Add entries for blast, scroll, mantle, mode to CHAIN_NETWORK_NAMES | 3.0 |
| 5 | Test Bug | provider-config.test.ts:281-287 | **Missing ONFINALITY env cleanup in test**: `getProviderUrlsForChain` test `beforeEach` clears DRPC, ANKR, INFURA, ALCHEMY env vars but NOT `ONFINALITY_API_KEY`. If a previous test or CI env sets ONFINALITY_API_KEY, it leaks into these tests, potentially producing OnFinality URLs in results and breaking assertions. | MEDIUM | Add `delete process.env.ONFINALITY_API_KEY;` to beforeEach | 3.0 |
| 6 | Dead Code | chain-url-builder.ts:399-470 | **`buildChainUrlsOptimized` is never consumed**: Exported but zero callers in services/ or anywhere outside its own module. Contains stale "6-Provider Shield" docstring and uses `createAlchemyConfig` which references per-chain `ALCHEMY_${NETWORK}_KEY` env vars (inconsistent with the global `ALCHEMY_API_KEY` used everywhere else). `getTrafficAllocation` (line 389-396) is also dead code — exported, never consumed. | HIGH | Remove or mark as `@deprecated`. If keeping, fix docstring and align env var pattern. | 2.4 |
| 7 | Inconsistency | chain-url-builder.ts:332 | **`createAlchemyConfig` env var mismatch**: Uses `ALCHEMY_${network.toUpperCase()}_KEY` (per-chain: `ALCHEMY_ETH_KEY`, `ALCHEMY_ARB_KEY` etc.) while all other code uses global `ALCHEMY_API_KEY`. Currently in dead code path (`buildChainUrlsOptimized`), but if someone uses this utility, it silently fails because no one sets per-chain Alchemy keys. | HIGH | Change to `ALCHEMY_API_KEY` for consistency, or document the per-chain pattern in .env.example | 2.0 |

---

## Low Findings (P3)

| # | Category | File:Line | Description | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|------------|---------------|-------|
| 8 | Consistency | provider-config.ts:374-383 | **OnFinality in getTimeBasedProviderOrder for all chains**: OnFinality only supports BSC/Polygon/Avalanche/Fantom (4 of 15 chains) but appears in ALL time-based ordering arrays. Consumers iterating this order to build URLs for non-supported chains would need to handle OnFinality gracefully. `getProviderUrlsForChain` does handle this correctly (checks `networkNames.onfinality`). | MEDIUM | Consider noting in JSDoc that not all providers support all chains, or move OnFinality after ankr/publicnode since it's chain-limited | 1.8 |
| 9 | Test Coverage | N/A | **Missing tests for CHAINS config object**: No tests verify CHAINS has correct chain count (15), required fields (id, name, rpcUrl, wsUrl, blockTime, nativeToken), fallback URL formats (https/wss), or that all chains have non-empty fallback arrays. Also no tests for `BLOCK_TIMES_MS`, `getBlockTimeMs`, `getBlockTimeSec`, `TESTNET_CHAINS`, `getAllChains`, `MAINNET_CHAIN_IDS`. | MEDIUM | Add a "CHAINS config validation" test suite | 1.8 |
| 10 | Aggressive Logic | provider-config.ts:458 | **calculateProviderBudget throttles slightly above linear**: `shouldThrottle = percentUsed > 80 \|\| estimatedDaysRemaining < daysRemaining` — the second condition triggers for ANY usage rate slightly above perfectly linear (e.g., 51% at day 15). This is conservative but may cause premature throttling. | LOW | May be intentional (conservative budget management). Consider documenting the rationale or adjusting to a softer threshold. | 1.4 |
| 11 | Consistency | provider-config.ts:2 | **File header says "6-Provider Shield"**: `provider-config.ts` line 2 still references "6-Provider Shield Architecture" — this is the most prominent stale comment (it's the file's title). Also covered in finding #3 but worth noting separately. | HIGH | Update to "8-Provider Shield Architecture" | 1.6 |
| 12 | Inconsistency | index.ts:466 vs 115 | **Mixed comment styles for OnFinality chains vs non-OnFinality**: BSC/Polygon/Avalanche/Fantom have comments saying "8-Provider Shield" while Arbitrum/Base/Optimism/Ethereum/zkSync/Linea still say "6-Provider Shield". The distinction is that some chains have OnFinality and some don't, but the naming should be consistent. | MEDIUM | Use "8-Provider Shield" everywhere (the architecture has 8 providers regardless of per-chain availability) | 1.4 |

---

## Test Coverage Matrix

| Source File | Function/Method | Happy Path | Error Path | Edge Cases | Notes |
|-------------|-----------------|:----------:|:----------:|:----------:|-------|
| provider-config.ts | `PROVIDER_CONFIGS` | ✅ | N/A | ✅ (Infinity) | Thorough |
| provider-config.ts | `CHAIN_NETWORK_NAMES` | ✅ | N/A | Partial | Missing test for onfinality presence in BSC/Polygon/Avalanche/Fantom |
| provider-config.ts | `buildDrpcUrl` | ✅ | N/A | N/A | HTTP + WS |
| provider-config.ts | `buildAnkrUrl` | ✅ | N/A | N/A | HTTP + WS |
| provider-config.ts | `buildOnFinalityUrl` | ✅ | N/A | N/A | HTTP + WS |
| provider-config.ts | `buildPublicNodeUrl` | ✅ | N/A | N/A | HTTP + WS |
| provider-config.ts | `buildInfuraUrl` | ✅ | N/A | N/A | HTTP + WS |
| provider-config.ts | `buildAlchemyUrl` | ✅ | N/A | N/A | HTTP + WS |
| provider-config.ts | `buildBlastApiUrl` | ✅ | N/A | N/A | HTTP + WS |
| provider-config.ts | `getProviderUrlsForChain` | ✅ | ✅ | Partial | Missing: OnFinality env, BSC-specific test |
| provider-config.ts | `getTimeBasedProviderOrder` | ✅ | N/A | ✅ | 3 time windows + provider count |
| provider-config.ts | `getTrafficAllocation` | ❌ | N/A | N/A | Dead code, no tests |
| provider-config.ts | `calculateProviderBudget` | ✅ | ✅ | ✅ | Thorough |
| chain-url-builder.ts | `buildChainUrls` | ✅ | N/A | ✅ | Empty fallbacks |
| chain-url-builder.ts | `buildChainUrlsWithApiKeys` | ✅ | N/A | ✅ | Multi-key priority |
| chain-url-builder.ts | `buildChainUrlsOptimized` | ❌ | ❌ | ❌ | Dead code, no tests |
| chain-url-builder.ts | `buildSolanaUrls` | ✅ | N/A | ✅ | Both networks, key combos |
| chain-url-builder.ts | `createAlchemyConfig` | ✅ | N/A | N/A | |
| chain-url-builder.ts | Other create*Config | ❌ | N/A | N/A | createDrpc/Ankr/Infura/OnFinality untested |
| index.ts | `CHAINS` | ❌ | N/A | N/A | No structural validation tests |
| index.ts | `BLOCK_TIMES_MS` | ❌ | N/A | N/A | Untested |
| index.ts | `getBlockTimeMs` | ❌ | N/A | N/A | Untested (cache behavior, case-insensitive) |
| index.ts | `getBlockTimeSec` | ❌ | N/A | N/A | Untested |
| index.ts | `TESTNET_CHAINS` | ❌ | N/A | N/A | Untested |
| index.ts | `getAllChains` | ❌ | N/A | N/A | Untested |
| index.ts | `MAINNET_CHAIN_IDS` | ❌ | N/A | N/A | Untested |

---

## Recommended Action Plan

### Phase 1: Immediate (P1 — fix before next release)

- [ ] Fix #1: Decide on QuickNode — either implement fully or remove phantom config
- [ ] Fix #2: Update provider-config.ts:5 capacity total from "~540M" to "~555M"
- [ ] Fix #5: Add `delete process.env.ONFINALITY_API_KEY` to getProviderUrlsForChain test beforeEach

### Phase 2: Next Sprint (P2 — completeness and consistency)

- [ ] Fix #3: Replace all 11 "6-Provider" → "8-Provider" references
- [ ] Fix #4: Add blast, scroll, mantle, mode to CHAIN_NETWORK_NAMES
- [ ] Fix #6: Remove or deprecate dead code (buildChainUrlsOptimized, getTrafficAllocation)
- [ ] Fix #7: Align createAlchemyConfig to use ALCHEMY_API_KEY (if keeping the function)

### Phase 3: Backlog (P3 — test coverage and polish)

- [ ] Fix #9: Add CHAINS structural validation tests
- [ ] Fix #9: Add getBlockTimeMs/getBlockTimeSec tests
- [ ] Fix #8: Document OnFinality's chain-limited availability in getTimeBasedProviderOrder JSDoc
- [ ] Fix #10: Consider adjusting calculateProviderBudget throttle threshold
- [ ] Fix #11-12: Ensure all comments use consistent "8-Provider Shield" naming
