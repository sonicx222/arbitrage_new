# Extended Deep Analysis: shared/config/src

**Date**: 2026-03-06
**Target**: `shared/config/src/` (55 files, ~13,600 LOC)
**Methodology**: 6-agent parallel analysis (latency-profiler, failure-mode-analyst, data-integrity-auditor, cross-chain-analyst, observability-auditor, config-drift-detector)
**Agent Completion**: 6/6 (100%)

---

## Executive Summary

- **Total findings**: 0 Critical / 3 High / 7 Medium / 6 Low = **16 findings**
- **Overall grade**: **A-** (well-structured config with strong patterns; 3 data correctness issues need fixing)
- **Top 3 highest-impact issues**:
  1. BSC native price pool uses deprecated BUSD stablecoin — live chain, incorrect gas cost estimates
  2. Aave V3 flash loan fee is 9 bps in config but 5 bps on-chain since March 2024 — rejects profitable trades
  3. Mantle USDC address is actually Arbitrum WBTC (copy-paste error) — wrong token for stub chain

### Agent Agreement Map

| Area | Agents Agreeing | Confidence |
|------|----------------|------------|
| Mantle USDC address wrong | cross-chain, failure-mode, data-integrity (3/6) | **HIGH** |
| Flash loan availability drift risk | failure-mode, data-integrity (2/6) | **HIGH** |
| Mode kim_exchange missing verified flag | failure-mode, cross-chain (2/6) | **HIGH** |
| Config module performance is excellent | latency-profiler (confirmed), all others (no perf issues found) | **HIGH** |
| Stale count comments | observability-auditor (primary), cross-chain (corroborated) | **HIGH** |

---

## Critical Findings (P0)

None. No findings affect currently-live production behavior critically.

> **Note**: Mantle USDC address error was flagged CRITICAL by 2 agents but downgraded to HIGH here because Mantle is a stub chain (not partitioned, not monitored, not executing). When Mantle is activated, this becomes P0.

---

## High Findings (P1)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| H1 | Data Correctness | `tokens/native-token-price-pools.ts:55-62` | BSC native price pool uses WBNB/BUSD — BUSD deprecated by Binance in late 2023. Pool TVL declining, manipulation risk. BSC is a live chain. | cross-chain | HIGH (90%) | Change to WBNB/USDT PancakeSwap V2 pair; update `stablecoinSymbol` to 'USDT' | 4.0 |
| H2 | Data Correctness | `flash-loan-providers/aave-v3.ts:14` | Aave V3 fee configured as 9 bps; actual on-chain fee is 5 bps since March 2024 governance vote. Overestimates cost by 4 bps on 7 chains. | data-integrity | HIGH (90%) | Change `feeBps: 9` to `feeBps: 5`; update JSDoc at line 6; update `service-config.ts` FLASH_LOAN_PROVIDERS entries | 4.0 |
| H3 | Data Correctness | `addresses.ts:505` | Mantle USDC address `0x2f2a...0f` is WBTC on Arbitrum (copy-paste error). `tokens/index.ts:228` and `TOKEN_METADATA` use correct address `0x09Bc...A6`. | cross-chain, failure-mode, data-integrity | HIGH (95%) | Replace with `'0x09Bc4E0D10F09B1CdA8b8BB72C1e89F10B53BcA6'`; also verify Mantle USDT at line 506 | 3.6 |

---

## Medium Findings (P2)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| M1 | Validation Gap | `flash-loan-availability.ts` + `flash-loan-providers/` | Two independent representations of flash loan support with NO cross-validation. Availability matrix says `fantom.balancer_v2 = true` but `BALANCER_V2_PROVIDER.status = 'deferred'`. Can drift silently. | failure-mode, data-integrity | HIGH (90%) | Add load-time cross-validation between availability matrix and provider descriptors | 2.7 |
| M2 | Validation Gap | `schemas/index.ts:461-506` | Zod validators exist for chains, tokens, providers, bridge costs but only `DEX_FACTORY_REGISTRY` auto-validates at load. Others require explicit opt-in and skip in test env (`skipInTest=true`). | failure-mode | HIGH (85%) | Call `validateChainRegistry()`, `validateFlashLoanProviders()`, `validateBridgeCosts()` at load time; consider CI-specific mode that doesn't skip | 2.4 |
| M3 | Data Correctness | `dexes/chains/mode.ts:10-16` | `kim_exchange` missing `verified: false` field. Filter `dex.verified !== false` treats it as verified. Inconsistent with other Mode/Mantle DEXes and `deferred-items.ts` tracking. | failure-mode, cross-chain | HIGH (90%) | Add `verified: false` to `kim_exchange` entry | 3.8 |
| M4 | Data Correctness | `addresses.ts:506` | Mantle USDT in STABLECOINS (`0x9274...6901`) differs from CORE_TOKENS (`0x201E...56aE`). No cross-validation exists between these registries. | failure-mode, data-integrity | MEDIUM (75%) | Verify correct Mantle USDT address via RPC; align STABLECOINS with CORE_TOKENS | 3.2 |
| M5 | Documentation | `tokens/index.ts:9,19,23,112` + `index.ts:9` | Token count comments say "128 tokens" — actual count is 135 (LST/LRT expansion). Per-chain counts also stale (Arbitrum: 12->13, Ethereum: 8->13). | observability | HIGH (90%) | Update all count comments | 2.8 |
| M6 | Documentation | `flash-loan-availability.ts:31,34,36,278` | Protocol coverage comments stale: Aave V3 on 7 chains (says 6), SyncSwap on 2 chains (says 1). `getSupportedProtocols` example missing `dai_flash_mint`. | observability | HIGH (90%) | Update comments and example | 2.8 |
| M7 | Config Drift | `service-config.ts:80` | `REDIS_URL` uses `\|\|` not `??` — empty env var `REDIS_URL=` silently falls to localhost instead of being treated as explicit empty. | config-drift | MEDIUM (70%) | Change to `?? 'redis://localhost:6379'` or add explicit empty-string check | 3.2 |

---

## Low Findings (P3)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| L1 | Data Correctness | `flash-loan-providers/dai-flash-mint.ts:14` | Fee configured as 1 bps; MakerDAO Endgame may have changed to 0. Needs on-chain verification. | data-integrity | LOW (55%) | Verify via `eth_call` to DssFlash.toll(); update if 0 | 2.4 |
| L2 | Documentation | `addresses.ts:7,200` | Broken `@see` references: `docs/refactoring-roadmap.md` and `docs/syncswap_api_dpcu.md` — both deleted. | observability | HIGH (95%) | Remove or replace with existing docs | 2.8 |
| L3 | Data Correctness | `dexes/chains/blast.ts:25-35` | BladeSwap and Fenix Finance have factoryAddress === routerAddress. Unusual for Solidly-fork DEXes. File header says "RPC-verified 2026-02-26" so may be intentional single-contract model. | cross-chain | LOW (55%) | Re-verify via RPC; add comment if intentionally single-contract | 2.0 |
| L4 | Documentation | `partitions.ts:251,657-686` | Comment says Mantle/Mode "keep in high-value until verified" but they're actually unassigned. PHASE_METRICS Phase 1 targets (11/49/112) exceeded by actual (15/78/135). | cross-chain, observability | HIGH (90%) | Update comments to reflect reality | 2.4 |
| L5 | Config Drift | `mempool-config.ts:24`, `risk-config.ts:229` | `BLOXROUTE_AUTH_HEADER` and `RISK_REDIS_KEY_PREFIX` use `\|\|` instead of `??` for string defaults. Minor pattern inconsistency. | config-drift | MEDIUM (70%) | Change to `??` for consistency | 2.8 |
| L6 | Config Drift | Various | ~15 env vars missing from `.env.example`: `FLASH_LOAN_AGGREGATOR_*` (6), `FAST_LANE_*` (2), `EXECUTION_CHAIN_GROUP`, `COORDINATOR_CHAIN_GROUP_ROUTING`, `ADAPTIVE_*` (6). All have code defaults. | config-drift | HIGH (90%) | Add to `.env.example` with descriptions | 2.4 |

---

## Performance Assessment

**Grade: A** — No hot-path performance issues.

| Aspect | Assessment | Evidence |
|--------|-----------|----------|
| Module-load overhead | ~2-3ms total | All derivation is O(n) with small n; no O(n^2) patterns |
| Hot-path accessors | All O(1) cached | Map.get / Record lookup; pre-computed at load time |
| Memory footprint | ~300-400KB | Negligible vs 400MB threshold |
| Allocation in accessors | None on hot paths | Filter-based functions only used in tests/startup |

### Key O(1) Access Patterns (Confirmed Working)
- `getEnabledDexes(chain)` — pre-computed `ENABLED_DEXES_CACHE`
- `getTokenDecimals(chain, addr, sym)` — `TOKEN_DECIMALS_LOOKUP` Map
- `getBridgeCostFast(src, dst)` — 3 pre-computed Maps
- `getMinProfitThreshold(chain)` — direct Record lookup
- `PROVIDER_BY_PROTOCOL` — Map from 7 providers
- `CHAIN_TO_GROUP` — Map from `execution-chain-groups.ts`

---

## Chain Coverage Matrix

| Chain | DEXes | Verified | Tokens | Flash Loan | Native Price Pool | Partition | Status |
|-------|-------|----------|--------|------------|-------------------|-----------|--------|
| ethereum | 5 | 5 | 13 | aave_v3, balancer_v2, pancakeswap_v3, dai_flash_mint | Uniswap V2 WETH/USDC | P3 | Live |
| bsc | 8 | 8 | 10 | pancakeswap_v3 | PancakeSwap WBNB/**BUSD** (H1) | P1 | Live |
| arbitrum | 10 | 10 | 13 | aave_v3, balancer_v2 | Camelot WETH/USDC | P2 | Live |
| base | 8 | 8 | 10 | aave_v3 | Aerodrome WETH/USDC | P2 | Live |
| polygon | 4 | 4 | 10 | aave_v3, balancer_v2 | QuickSwap WMATIC/USDC | P1 | Live |
| optimism | 5 | 5 | 10 | aave_v3, balancer_v2 | Velodrome WETH/USDC | P2 | Live |
| avalanche | 6 | 6 | 15 | aave_v3 | TraderJoe WAVAX/USDC | P1 | Live |
| fantom | 4 | 4 | 10 | balancer_v2, spookyswap | SpookySwap WFTM/USDC | P1 | Live |
| zksync | 4 | 4 | 6 | syncswap | SyncSwap WETH/USDC | P3 | Live |
| linea | 3 | 3 | 6 | None (deferred) | Lynex WETH/USDC | P3 | Live |
| blast | 4 | 4 | 5 | None (deferred) | ETH fallback | P2 | Live |
| scroll | 4 | 4 | 7 | aave_v3, syncswap | ETH fallback | P2 | Live |
| mantle | 3 | 0 | 3 | None | Merchant Moe WMNT/USDC | None | Stub |
| mode | 3 | 1 (M3) | 2 | None | ETH fallback | None | Stub |
| solana | 7 | 7 | 15 | N/A | N/A (non-EVM) | P4 | Live |

---

## Configuration Health

### Feature Flags: EXCELLENT
- 26 feature flags, all following correct patterns
- `=== 'true'` for opt-in features (22 flags)
- `!== 'false'` for safety features (4 flags: dynamic L1 fees, risk mgmt, simulation)
- Cross-dependency validation exists (e.g., `useMevShareBackrun` requires `useMevShare`)
- Production fail-fast for misconfigured flags

### `||` vs `??` Violations: MINIMAL
- **Zero** `|| 0` or `|| 0n` violations (previous migration complete)
- 2 medium-risk `||` for strings (REDIS_URL, BLOXROUTE_AUTH_HEADER)
- 22 `|| []` instances — all safe (array fallbacks for undefined lookups)

### Env Var Coverage: GOOD (~90%)
- ~120 unique env vars referenced; ~105 documented in `.env.example`
- ~15 missing: mostly flash loan aggregator tuning and ADR-038 chain group vars

### Risk Config: SOUND
- All risk parameters have bounds validation
- Production-critical vars (`WALLET_PRIVATE_KEY`, `RISK_TOTAL_CAPITAL`) validated on startup
- Default values are conservative (half-Kelly, 5% max daily loss, 2% max single trade)

---

## Cross-Agent Insights

### Information Separation Results (Agents 2 + 3)
The failure-mode-analyst and data-integrity-auditor independently analyzed overlapping areas:

| Area | Agent 2 (failure-mode) | Agent 3 (data-integrity) | Agreement |
|------|----------------------|-------------------------|-----------|
| Mantle USDC address | Found (F1) — wrong address | Found (C1) — confirmed Arbitrum WBTC | **AGREE** |
| Flash loan availability drift | Found (F3) — no cross-validation | Found — confirmed inconsistency | **AGREE** |
| Schema validation gaps | Found (F5) — skipInTest default | Not covered | Single-source |
| Aave V3 fee stale | Not covered | Found (H1) — 9->5 bps | Single-source |
| Mode kim_exchange | Found (F8) — missing verified flag | Not covered (different scope) | Single-source |
| Token address triple-source | Found (F7, D1) — 3 independent registries | Found — confirmed STABLECOINS/CORE_TOKENS/TOKEN_METADATA divergence | **AGREE** |

No disagreements between overlapping agents. All shared findings promote to HIGH confidence.

---

## Conflict Resolutions

No conflicts between agents. All agents' findings are complementary, not contradictory.

---

## Positive Findings (Strengths)

1. **ADR-041 refactoring is complete** — All 7 tasks verified: flash loan descriptors, per-chain DEX files, address dedup, chain type unification, verified metadata, deferred tracking, barrel cleanup
2. **Zero `as any` casts** across the entire config package
3. **All hot-path accessors are O(1)** with pre-computed caches
4. **BSC 18-decimal USDT/USDC correctly handled** via `CHAIN_TOKEN_DECIMAL_OVERRIDES`
5. **Deferred items well-tracked** — 7 items with IDs, descriptions, blockers, and file references
6. **Bridge routes comprehensive** — All 13 operational chains have 3-6 bridge options
7. **Gas spike multipliers chain-appropriate** — Ethereum 5x, alt-L1s 3x, L2s 2x, Solana 1.5x
8. **Per-chain thresholds comprehensive** — All 15 chains have entries for min profit, gas cost, timeout, confidence age, spike multiplier

---

## Recommended Action Plan

### Phase 1: Immediate (P1 — fix before next deployment)
- [ ] **H1**: Change BSC native price pool from BUSD to USDT pair (`native-token-price-pools.ts:55-62`)
- [ ] **H2**: Update Aave V3 fee from 9 to 5 bps (`aave-v3.ts:14` + `service-config.ts` FLASH_LOAN_PROVIDERS)
- [ ] **H3**: Fix Mantle USDC address in `addresses.ts:505` to `0x09Bc4E0D10F09B1CdA8b8BB72C1e89F10B53BcA6`
- [ ] **M3**: Add `verified: false` to Mode `kim_exchange` (`dexes/chains/mode.ts:10`)
- [ ] **M4**: Verify and fix Mantle USDT address in `addresses.ts:506`

### Phase 2: Next Sprint (P2 — validation and documentation)
- [ ] **M1**: Add cross-validation between `FLASH_LOAN_AVAILABILITY` and provider descriptors at load time
- [ ] **M2**: Enable Zod validators at load time for CHAINS, tokens, flash loan providers (not just factories)
- [ ] **M5**: Update token count comments (128->135, per-chain counts)
- [ ] **M6**: Update flash-loan-availability.ts comments (Aave 6->7, SyncSwap 1->2, example)
- [ ] **M7**: Change `REDIS_URL` from `||` to `??` in `service-config.ts:80`

### Phase 3: Backlog (P3 — hardening)
- [ ] **L1**: Verify DAI Flash Mint fee on-chain (may be 0)
- [ ] **L2**: Remove broken `@see` references in `addresses.ts`
- [ ] **L3**: Re-verify Blast DEX addresses (factory===router)
- [ ] **L4**: Update partition comments (Mantle/Mode "in high-value" -> "unassigned")
- [ ] **L5**: Change remaining `||` to `??` for string defaults
- [ ] **L6**: Add ~15 missing env vars to `.env.example`
