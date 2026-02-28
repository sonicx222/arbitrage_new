# Deep Analysis: shared/config/src/ (@arbitrage/config)

**Date**: 2026-02-28
**Target**: `shared/config/src/` — 28 source files, ~12,500 LOC
**Test Files**: `shared/config/__tests__/unit/` — 31 test files
**Methodology**: 6 parallel specialized agents + team lead manual review
**Grade**: **B** (solid config package with one P0 data bug and several notable gaps)

---

## Executive Summary

- **Total findings**: 35 (1 Critical, 8 High, 15 Medium, 11 Low)
- **Top 3 highest-impact issues**:
  1. Wrong DAI address in CURVE_POOL_TOKENS — Curve mempool swap decoding returns wrong token for 3pool/sUSD pools (P0-1)
  2. FlashLoanProtocolSchema out of sync with canonical type — schema accepts invalid protocols and rejects valid ones (P1-1)
  3. `getEstimatedGasCostUsd` not re-exported from barrel — consumers forced to use $15 global fallback instead of per-chain values (P1-5)
- **Agent agreement**: Bug Hunter + Team Lead agreed on schema drift; Security + Mock Fidelity agreed on address validation gaps; Performance + Architecture agreed on duplication patterns; Bug Hunter found critical DAI address bug independently verified by Team Lead
- **Overall health**: Well-structured package with proper separation of concerns, comprehensive chain coverage (15 chains), good validation patterns. Key weaknesses are a wrong mainnet address in mempool config, schema drift between types and Zod schemas, incomplete coverage in newer modules (event-config, mempool routers), and some code duplication. Mock fidelity is excellent (Grade A) — all addresses in core modules are real mainnet addresses.

---

## Critical Findings (P0 — Security/Correctness/Financial Impact)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 1 | Data Bug | `mempool-config.ts:592,598` | `CURVE_POOL_TOKENS.ethereum` uses wrong DAI address `0x6B175474E89094C44Da98b954EeadCDeBc5C5e818` (extra `8` before `C5e8`). Correct DAI is `0x6B175474E89094C44Da98b954EedeAC495271d0F` (verified against `addresses.ts:455`). Affects 3pool and sUSD pool token arrays — Curve swap event decoding would map the wrong address for DAI in these pools. | Bug Hunter | HIGH | Replace `0x6B175474E89094C44Da98b954EeadCDeBc5C5e818` with `0x6B175474E89094C44Da98b954EedeAC495271d0F` at lines 592 and 598 | 4.5 |

---

## High Findings (P1 — Reliability/Coverage Impact)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 1 | Schema Drift | `schemas/index.ts:275-282` | `FlashLoanProtocolSchema` includes `'jupiter'` (not in canonical `FlashLoanProtocol` type from `@arbitrage/types`) but **missing** `'dai_flash_mint'` and `'morpho'` (both in the canonical type). Zod validation would reject valid configs with `dai_flash_mint` protocol. | Bug Hunter, Architecture | HIGH | Update schema to match canonical type: replace `'jupiter'` with `'dai_flash_mint'`, add `'morpho'` | 4.0 |
| 2 | Config Gap | `string-interning.ts:99-106` | `KNOWN_CHAINS` array missing 4 emerging L2 chains: `blast`, `scroll`, `mantle`, `mode`. These chains appear in every other config file (thresholds, mev-config, detector-config, bridge-config, mempool-config) but aren't pre-interned. Causes unnecessary string allocation on first hot-path access. | Performance, Architecture | HIGH | Add `'blast', 'scroll', 'mantle', 'mode'` to `KNOWN_CHAINS` array and corresponding uppercase variants | 3.7 |
| 3 | Data Quality | `mempool-config.ts:343` | GMX router entry in `KNOWN_ROUTERS.arbitrum` uses placeholder address `'0xabc0000000000000000000000000000000000000'`. Comment says "Placeholder" but it's in the production config. If mempool detection is enabled on Arbitrum, any tx to this address would be misclassified as a GMX swap. | Bug Hunter, Mock Fidelity | HIGH | Replace with real GMX router address (`0xaBBc5F99639c9B6bCb58544ddf04EFA6802F4064`) or remove entry until verified | 3.5 |
| 4 | Type Safety | `service-config.ts:475` | `FLASH_LOAN_PROVIDERS.solana.protocol` is `'jupiter'` which does NOT exist in the canonical `FlashLoanProtocol` type (`@arbitrage/types`). The type safety is lost because `FLASH_LOAN_PROVIDERS` uses `Record<string, {protocol: string}>` instead of the union type. | Bug Hunter, Architecture | MEDIUM | Either add `'jupiter'` to `FlashLoanProtocol` type, or mark Solana's protocol differently (it's not a flash loan) | 3.3 |
| 5 | Missing Export | `thresholds.ts` / `index.ts:215` | `getEstimatedGasCostUsd()` and `chainEstimatedGasCostUsd` Map are exported from `thresholds.ts` but NOT re-exported from the barrel `index.ts`. Consumers must import directly from thresholds.ts (breaking the `@arbitrage/config` barrel convention) or fall back to the $15 global `ESTIMATED_GAS_COST_USD`. For chains like Base ($0.05) or Arbitrum ($0.10), using the $15 fallback massively inflates gas cost estimates, potentially filtering out profitable opportunities. | Architecture | HIGH | Add `getEstimatedGasCostUsd` and `chainEstimatedGasCostUsd` to the re-exports in `index.ts` | 3.5 |
| 6 | Config Gap | `addresses.ts:406-427` | `NATIVE_TOKENS` Record missing entries for `mantle` and `mode` chains. `getNativeToken('mantle')` would throw at runtime. Both chains have detector-config, thresholds, mev-config, and bridge-config entries but no native token mapping. | Bug Hunter | HIGH | Add `mantle: { symbol: 'MNT', decimals: 18, wrapped: '0x...' }` and `mode: { symbol: 'ETH', decimals: 18, wrapped: '0x...' }` entries | 3.3 |
| 7 | Test Gap | `worker-pool-config.ts` | **Zero test coverage for entire module.** Platform detection logic (`IS_FLY_IO`, `IS_RAILWAY`, `IS_RENDER`, `IS_CONSTRAINED_HOST`), `resolvePoolSize()`, `resolveMaxQueueSize()`, `resolveTaskTimeout()` — all untested. Env-var-driven pool sizing has branching logic; incorrect defaults silently degrade performance or crash on constrained hosts. | Test Quality | HIGH | Add `worker-pool-config.test.ts` with 15-20 test cases covering env var overrides and platform detection branches | 3.2 |
| 8 | Test Gap | `flash-loan-abi.ts` | **Zero test coverage for critical financial constants.** `AAVE_V3_FEE_BPS`, `BALANCER_V2_FEE_BPS`, `SYNCSWAP_FEE_BPS`, BigInt getter functions, and ABI arrays all untested. Fee constants drive profit calculations — a wrong constant (e.g., `AAVE_V3_FEE_BPS=90` instead of `9`) silently causes 10x fee overestimate. | Test Quality | HIGH | Add `flash-loan-abi.test.ts` with 10-15 test cases verifying fee constants, BigInt conversions, and ABI function signatures | 3.2 |

---

## Medium Findings (P2 — Maintainability/Performance)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 5 | Duplication | `risk-config.ts:35-108` | Local `parseEnvFloat()`, `parseEnvInt()`, `parseEnvBigInt()` duplicate logic from `utils/env-parsing.ts` (same package). Comment says "Cannot import from @arbitrage/core" — true, but `utils/env-parsing.ts` IS in the config package. Risk-config versions add bounds checking (valuable), but the base parsing is duplicated. | Performance, Architecture | HIGH | Extract bounds-checked variants to `utils/env-parsing.ts` (e.g., `safeParseFloatBounded`), import in risk-config | 3.2 |
| 6 | Coverage Gap | `mempool-config.ts` | `KNOWN_ROUTERS` only covers 7 of 15 chains (ethereum, bsc, polygon, arbitrum, optimism, base, avalanche). Missing: fantom, zksync, linea, blast, scroll, mantle, mode, solana. Mempool transaction decoding silently fails for unlisted chains. | Test Quality, Mock Fidelity | HIGH | Add router entries for fantom (SpookySwap), zksync (SyncSwap, Mute), linea (SyncSwap, PancakeSwap). Stub chains (mantle, mode) can be empty. Solana uses different tx model. | 3.0 |
| 7 | Data Quality | `event-config.ts` | Only 3 event signatures: Sync (V2), Swap V2, Swap V3. Missing critical DEX event signatures: Algebra `Swap` (different from V3), Solidly/Velodrome `Swap`, Balancer `Swap`, Curve `TokenExchange`, `TokenExchangeUnderlying`. These DEXs are configured in `dex-factories.ts` but their events aren't in `EVENT_CONFIG`. | Architecture, Mock Fidelity | HIGH | Add missing event signatures. Note: check if these are already defined elsewhere (they may be in the unified-detector service directly). | 2.8 |
| 8 | Logic | `bridge-config.ts:267-271` | `BEST_BRIDGE_BY_ROUTE` selects bridge by lowest `feeBps` only, ignoring `minFeeUsd`. For small trades (e.g., $100), a bridge with higher bps but lower minimum USD fee could be cheaper. `getBridgeCost()` returns the bps-optimal bridge which IS correct for the common (large) trade case. **NEEDS VERIFICATION** for edge cases where bps order ≠ actual cost order at the default trade size. | Bug Hunter | MEDIUM | Consider documenting that `getBridgeCost()` is bps-optimal (not cost-optimal for all trade sizes). For cost-optimal selection, consumers should use `selectOptimalBridge()`. | 2.5 |
| 9 | Security | `feature-flags.ts:745-764` | `DISABLE_CONFIG_VALIDATION=true` env var disables ALL feature flag validation including the deferred `setTimeout` check. In production, an attacker or misconfigured deploy could set this to bypass safety validation. Mitigated by: (1) production services should not set this, (2) the check at line 745 also skips in test via `JEST_WORKER_ID`. | Security | MEDIUM | Consider renaming to `DISABLE_CONFIG_VALIDATION_DEV_ONLY` and adding a `NODE_ENV !== 'production'` guard. | 2.5 |
| 10 | Security | `chains/index.ts`, `chains/provider-config.ts` | API keys (DRPC, ANKR, INFURA, ALCHEMY, etc.) are interpolated into RPC URL strings at module load time and stored in the `CHAINS` config object. If the CHAINS object is ever logged, serialized, or exposed in error messages, API keys would leak. The keys themselves come from env vars (correct), but they're baked into string URLs at import time rather than constructed on demand. | Security | MEDIUM | Consider lazy URL construction (build URLs only when needed) or redact API keys in any toString/toJSON/logging paths. Document that CHAINS should never be logged. | 2.5 |
| 11 | Security | `service-config.ts:642-650` | `R2_CONFIG` exports `secretAccessKey` directly from `process.env.R2_SECRET_ACCESS_KEY`. While this is necessary for the R2 client, the secret is stored as a plain property on an exported object. Any accidental logging of `R2_CONFIG` would expose the secret. | Security | MEDIUM | Consider wrapping in a getter function `getR2Config()` that constructs the object on demand, or use a class with a redacted `toString()`/`toJSON()`. | 2.3 |
| 12 | Duplication | `feature-flags.ts` | Contains ~22 `console.warn()` calls with emoji prefixes and similar formatting patterns. Each validation check has its own warn/error logging. Could use a shared validation logging utility (~66 lines saveable). | Performance | MEDIUM | Extract `configWarn(message, details?)` and `configError(message, details?)` helpers. Low priority since it's startup-only code. | 2.2 |
| 13 | Schema Gap | `schemas/index.ts` | `TokenSchema.decimals` has `max(18)` but some ERC20 tokens have up to 24 decimals (e.g., YAM). Separately, `BasisPointsSchema` has `.int()` constraint but `bridge-config.ts` and `mev-config.ts` use non-integer bps values (e.g., floating-point priority fees in gwei). These are different units but share similar naming. | Bug Hunter, Architecture | MEDIUM | Keep max(18) since all CORE_TOKENS use ≤18 decimals. Document that `BasisPointsSchema` is for fees only, not for gwei values. | 2.0 |
| 14 | Documentation | `mev-config.ts:257-273` | `MEV_PRIORITY_FEE_SUMMARY` is a static const that can drift from the actual `chainSettings` values after env var overrides are applied (lines 225-234). If `MEV_PRIORITY_FEE_ETHEREUM_GWEI=5.0` is set, `chainSettings.ethereum.priorityFeeGwei` becomes 5.0 but `MEV_PRIORITY_FEE_SUMMARY.ethereum` remains 2.0. | Architecture | MEDIUM | Either compute `MEV_PRIORITY_FEE_SUMMARY` dynamically from `chainSettings` after overrides, or add a JSDoc warning that it's pre-override values only. | 2.0 |
| 15 | Duplication | `feature-flags.ts:690`, `service-config.ts:20`, `config-manager.ts:229` | `isProduction` detection is triplicated with inconsistencies: `feature-flags.ts` checks only `NODE_ENV === 'production'`; `service-config.ts` also checks `FLY_APP_NAME`, `RAILWAY_SERVICE_ID`, `KOYEB_SERVICE_NAME`; `config-manager.ts` has its own variant. Different definitions could disagree in edge cases (e.g., running on Fly.io without NODE_ENV=production). | Performance, Architecture | HIGH | Extract a single `isProduction()` to `service-config.ts` or a new `utils/environment.ts` and import everywhere. | 3.6 |
| 16 | Consistency | `feature-flags.ts` | Several feature flags use `!== 'false'` pattern (opt-out / default-on) but this is undocumented. The project convention in CLAUDE.md documents `=== 'true'` for opt-in flags. The `!== 'false'` pattern means these flags are ON unless explicitly set to `'false'`, which may surprise developers. | Bug Hunter | MEDIUM | Document the two patterns clearly: `=== 'true'` for experimental opt-in, `!== 'false'` for safety-critical opt-out. Add inline comments at each `!== 'false'` usage. | 2.0 |
| 17 | Config Drift | `partitions.ts:229-282` | All 4 partition configs specify `provider: 'fly'`, but ARCHITECTURE_V2.md and ADR-003 specify P1 (Asia-Fast) and P3 (High-Value) should use Oracle ARM instances. The config doesn't reflect the documented provider differentiation. | Architecture | MEDIUM | Either update partition configs to match docs (P1/P3: 'oracle-arm') or update docs to reflect current all-Fly deployment. | 2.0 |
| 18 | Test Gap | `thresholds.ts` | 4 of 6 exported chain-specific lookup functions are completely untested: `getOpportunityTimeoutMs()`, `getGasSpikeMultiplier()`, `getConfidenceMaxAgeMs()`, `getEstimatedGasCostUsd()`. These have lowercase normalization + default fallback logic. Only `getMinProfitThreshold()` and two constants are tested. | Test Quality | MEDIUM | Add 12-16 test cases for the 4 untested lookup functions with known chain, unknown chain, and case-insensitive variants | 2.5 |
| 19 | Test Gap | `tokens/index.ts` | Price staleness detection functions completely untested: `checkFallbackPriceStaleness()`, `getFallbackPriceAgeDays()`, `checkNativeTokenPriceStaleness()`, `hasKnownDecimals()`. `checkFallbackPriceStaleness()` compares current date against `FALLBACK_PRICES_LAST_UPDATED` — a date comparison bug means stale prices are silently used. | Test Quality | MEDIUM | Add 8-12 test cases covering staleness detection, edge cases around date boundaries | 2.3 |
| 20 | Test Gap | `index.ts`, `service-config.ts` | `validateChainEnvironment()` (main entry point validation with partition-aware branching) and `isLocalhostUrl()` (production Redis safety check) are untested. A bug in `isLocalhostUrl()` silently allows localhost Redis in production. | Test Quality | MEDIUM | Add 8-10 test cases covering partition-aware validation and localhost URL detection | 2.2 |
| 21 | Test Gap | `chains/chain-url-builder.ts` | 4 of 5 API key config builders untested: `createInfuraConfig()`, `createDrpcConfig()`, `createOnFinalityConfig()`, `createAnkrConfig()`. Only `createAlchemyConfig()` is tested. Provider-specific URL patterns vary and are critical for RPC connectivity. | Test Quality | MEDIUM | Add tests for remaining 4 config builders, verifying URL pattern construction and API key interpolation | 2.0 |

---

## Low Findings (P3 — Style/Minor Improvements)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 22 | Coverage Gap | `CURVE_POOL_TOKENS` in mempool-config.ts | Only covers 3 chains (ethereum, arbitrum, polygon) with ~8 pools total. Missing: avalanche, fantom, optimism, base Curve/StableSwap deployments. | Mock Fidelity | MEDIUM | Add pool configs for chains with active Curve deployments. Low priority since Curve swaps may be detected via factory events. | 1.8 |
| 23 | Consistency | `cross-chain.ts:353` | `getDefaultQuoteToken()` uses `||` for default instead of `??`. Since the return type is string from a const object, `||` works correctly here (empty string would be falsy, and we'd want to fallback). Inconsistent with the project's `??` convention. | Bug Hunter | LOW | Change to `?? 'USDC'` for consistency. Not a correctness issue. | 1.8 |
| 24 | Consistency | `string-interning.ts:197-206` | `COMMON_DEXES` array is incomplete — missing several DEXs configured in `dex-factories.ts` (e.g., `spookyswap`, `spiritswap`, `syncswap`, `mute_switch`, `baseswap`, `thena`). | Performance | LOW | Add missing DEX names. Minor since the pool auto-interns on first use. | 1.5 |
| 25 | Consistency | `worker-pool-config.ts:32` | `IS_CONSTRAINED_HOST` doesn't check `KOYEB_SERVICE_NAME` but `service-config.ts:24` does check it for `isProduction`. Different detection logic for the same hosting platforms. | Architecture | LOW | Add `process.env.KOYEB_SERVICE_NAME !== undefined` to `IS_CONSTRAINED_HOST`. | 1.5 |
| 26 | Documentation | `bridge-config.ts:60-219` | Large `BRIDGE_ROUTE_DATA` array (219 lines) has no mechanism to validate route symmetry (if A→B exists, B→A should too) or detect stale data. Routes added for Scroll/Blast but no automated check for completeness. | Architecture | LOW | Add a startup validation that checks route symmetry and logs warnings for one-directional routes. | 1.3 |
| 27 | Code Smell | `dex-factories.ts` | File is 1,061+ lines — one of the largest in the package. Contains factory configs for all 15 chains plus validation logic. Could be split into per-chain files or a data file + validation module. | Performance | LOW | Consider splitting into `dex-factories/data.ts` and `dex-factories/validation.ts`. Low priority — current structure works. | 1.2 |
| 28 | Consistency | `cross-chain.ts:88-90` | `NORMALIZED_ALIASES` Map is created from `CROSS_CHAIN_TOKEN_ALIASES` but doesn't add any value over the original object for the same-case lookups. The Map is used for O(1) lookup, but `Object` property access is already O(1) in V8. | Performance | LOW | Minor — Map is marginally faster for hot-path lookups due to fewer prototype chain checks. Keep as-is. | 1.0 |
| 29 | Documentation | `mev-config.ts` | `PHASE_METRICS` constant references phase timing thresholds but values may be stale relative to actual production latency targets. Static const can drift from operational reality. | Architecture | LOW | Add a comment noting when values were last calibrated, or compute from live metrics config. | 1.0 |
| 30 | Consistency | `addresses.ts` | Address registry has ~150 lines of boilerplate per chain (factory addresses, token addresses, router addresses). Pattern is consistent but verbose — could use a data-driven approach. | Performance | LOW | Low priority — current structure is readable and grep-friendly. Only refactor if adding many more chains. | 1.0 |
| 31 | Documentation | `flash-loan-availability.ts` | Aave V3 fee comment says "0.05%" but actual Aave V3 premium is configurable and currently 0.09% (9 bps) on most markets. The code correctly uses `feeBps: 5` (0.05%) suggesting a specific premium was negotiated or this is the minimum. Potential confusion for developers. | Mock Fidelity | LOW | Add a JSDoc comment clarifying whether 5 bps is a minimum, negotiated rate, or needs updating to 9 bps. | 1.0 |

---

## Test Coverage Assessment

**Overall test quality grade: B** — Good breadth (31 test files for 28 source files) but inconsistent depth. Several functional modules have zero test coverage, and financial constants lack rigorous assertion testing.

### Source Files Without Dedicated Test Files
| Source File | Has Test? | Tested Elsewhere? | Severity of Gap |
|---|---|---|---|
| `worker-pool-config.ts` | **NO** | **NO — zero test references** | **P1-HIGH** — platform detection logic and pool sizing untested |
| `flash-loan-abi.ts` | **NO** | **NO — zero test references** | **P1-HIGH** — critical financial constants untested |
| `event-config.ts` | No | Covered in config-modules.test.ts | Medium — event signatures are critical for detection |
| `bridge-config.ts` | No dedicated file | Well-covered in config-modules.test.ts, emerging-l2s.test.ts | OK |
| `detector-config.ts` | No | Covered in config-modules.test.ts, emerging-l2s.test.ts | Low — pure data |
| `system-constants.ts` | No | Partially in config-modules.test.ts | Low — pure constants |
| `partition-ids.ts` | No | Covered transitively via partitions.ts tests | OK |

### Untested Exported Functions (by module)

| Source File | Untested Exports | Impact |
|---|---|---|
| `worker-pool-config.ts` | `resolvePoolSize()`, `resolveMaxQueueSize()`, `resolveTaskTimeout()`, `IS_FLY_IO`, `IS_RAILWAY`, `IS_RENDER`, `IS_CONSTRAINED_HOST`, `PLATFORM_NAME` | Silent performance degradation on constrained hosts |
| `flash-loan-abi.ts` | `AAVE_V3_FEE_BPS`, `BALANCER_V2_FEE_BPS`, `SYNCSWAP_FEE_BPS`, BigInt getters, ABI arrays | Wrong fee constants → 10x profit miscalculation |
| `thresholds.ts` | `getOpportunityTimeoutMs()`, `getGasSpikeMultiplier()`, `getConfidenceMaxAgeMs()`, `getEstimatedGasCostUsd()` | Stale opportunities processed, wrong gas estimates |
| `tokens/index.ts` | `checkFallbackPriceStaleness()`, `getFallbackPriceAgeDays()`, `checkNativeTokenPriceStaleness()`, `hasKnownDecimals()` | Stale prices silently used |
| `service-config.ts` | `isLocalhostUrl()`, `FAST_LANE_CONFIG`, `R2_CONFIG`, `MORPHO_FLASH_LOAN_PROVIDERS` | Localhost Redis in production |
| `index.ts` | `validateChainEnvironment()` | Invalid env configs silently accepted |
| `addresses.ts` | `getCommitRevealContract()`, `hasCommitRevealContract()`, `getMorphoBluePool()`, `hasMorphoBlue()`, `getDssFlash()`, `hasDssFlash()` | Throw-on-missing semantics untested |
| `chains/chain-url-builder.ts` | `createInfuraConfig()`, `createDrpcConfig()`, `createOnFinalityConfig()`, `createAnkrConfig()` | Provider-specific URL patterns vary |

### TODOs in Source (5)
| Location | TODO | Status |
|---|---|---|
| `service-config.ts:399` | "Task 2.2 TODO: Balancer V2 Configuration for Additional Chains" | Open |
| `service-config.ts:546` | "TODO: Update these addresses after deploying MultiPathQuoter contract" | Open |
| `dexes/index.ts:491` | "TODO: Verify on-chain addresses before mainnet" (Mantle DEXs) | Open |
| `dexes/index.ts:556` | "TODO: Verify on-chain addresses before mainnet" (Mode DEXs) | Open |
| `dexes/index.ts:581` | "TODO: Verify on-chain addresses before mainnet" (Mode DEXs) | Open |

### Skipped Tests (1)
| Location | Description | Assessment |
|---|---|---|
| `p0-p1-regression.test.ts:227` | `describe.skip('Fix 6: Linea flash loan provider')` | **Still relevant.** Blocked on SyncSwap Vault deployment to Linea mainnet. Should remain skipped until SyncSwap deploys. |

### Well-Tested Modules
- `config-manager.ts` — comprehensive test coverage (singleton, validation, production modes)
- `feature-flags.ts` — validate-feature-flags.test.ts (flag interaction warnings)
- `chains/` — 3 test files covering URL building, provider config, chain validation
- `schemas/index.ts` — schemas.test.ts (Zod validation well-tested)
- `risk-config.ts` — risk-config.test.ts
- `cross-chain.ts` — cross-chain.test.ts
- `addresses.ts` — addresses.test.ts + address-checksum-validation.test.ts
- `flash-loan-availability.ts` — flash-loan-availability.test.ts (complete coverage with edge cases)
- `thresholds.ts` — thresholds.test.ts (partial — only `getMinProfitThreshold()` + 2 constants)
- `string-interning.ts` — string-interning.test.ts (thorough pool mechanics including eviction)

### Weak Test Areas
- `config-modules.test.ts` — catch-all with shallow "it exists" style tests (`toBeDefined()`, `toBeGreaterThan(0)`)
- `DETECTOR_CONFIG` tests — check existence/type but never validate config value relationships (e.g., `batchTimeout < expiryMs`)
- Financial constants (`AAVE_V3_FEE_BPS`, `SYNCSWAP_FEE_BPS`) — zero assertion testing despite driving profit calculations

---

## Mock Fidelity Assessment

**Overall Grade: A** — The config package uses real mainnet addresses, realistic parameters, and accurate protocol data throughout.

| Area | Fidelity | Notes |
|---|---|---|
| Token Addresses | Excellent | All addresses in `addresses.ts`, `cross-chain.ts`, `mempool-config.ts` are real mainnet (except P0-1 DAI typo and P1-3 GMX placeholder) |
| DEX Factory Addresses | Excellent | All 72+ DEX factory addresses verified as real deployments |
| Bridge Route Data | Good | Fee bps, latency, and reliability scores are realistic. Route coverage is comprehensive for 15 chains |
| Flash Loan Protocols | Good | Protocol availability matrix matches real chain deployments. Fee comment on Aave V3 may need updating (P3-27) |
| Chain Parameters | Excellent | Block times, gas estimates, whale thresholds all calibrated per-chain |
| Detector Config | Excellent | Batch sizes, timeouts, confidence scores tuned per chain (e.g., Arbitrum 250ms blocks → 30 batch size) |

---

## Cross-Agent Insights

1. **Schema ↔ Type Drift (P1-1 + P1-4)**: The `FlashLoanProtocolSchema` in schemas/index.ts and the `FLASH_LOAN_PROVIDERS` Record in service-config.ts both use protocol names that don't match the canonical `FlashLoanProtocol` type in `@arbitrage/types`. This is a systemic issue — the schema was likely created before `dai_flash_mint` and `morpho` were added to the type, and `jupiter` was added to the schema for Solana without updating the type.

2. **Emerging L2 Chain Coverage Gap (P1-2 + P1-6 + P2-6 + P2-7)**: Blast, Scroll, Mantle, and Mode are configured in thresholds, detector-config, mev-config, bridge-config, and mempool-config — but are missing from string-interning pre-warming, KNOWN_ROUTERS, event-config, and NATIVE_TOKENS. This suggests the chains were added incrementally across files without a checklist. The missing NATIVE_TOKENS for mantle/mode (P1-6) could cause runtime errors.

3. **Env Parsing Duplication (P2-5)**: risk-config.ts defines its own `parseEnvFloat/Int/BigInt` with bounds checking. The same package has `safeParseFloat/safeParseInt` in `utils/env-parsing.ts` without bounds. Natural result of incremental development but should be consolidated.

4. **isProduction Inconsistency (P2-15 + P3-21)**: Three different modules define `isProduction` with different criteria. `feature-flags.ts` uses the narrowest definition (NODE_ENV only), while `service-config.ts` includes platform detection (Fly, Railway, Koyeb). This means feature flag validation could behave differently from service config in platform deployments.

5. **Secret Exposure Pattern (P2-10 + P2-11)**: Both API keys in chain URLs and R2 secrets are stored as plain strings on exported objects. While env var sourcing is correct, the exported objects could leak secrets if ever logged, serialized, or included in error messages. A consistent pattern for sensitive config values would prevent this class of issues.

6. **Address Data Quality (P0-1 + P1-3 + P3-18)**: Three address-related issues found across mempool-config: wrong DAI address, placeholder GMX router, and incomplete Curve pool coverage. Suggests address data needs a dedicated validation pass — perhaps a startup check that verifies all configured addresses against a known-good registry.

7. **Barrel Export Completeness (P1-5)**: The missing `getEstimatedGasCostUsd` barrel export means consumers silently fall back to a $15 global estimate instead of per-chain values (e.g., $0.05 for Base). This is a pattern where barrel incompleteness degrades quality invisibly — no error is thrown, but gas estimates are 300x too high for L2 chains.

8. **Financial Constants Without Test Coverage (P1-7 + P1-8 + P2-18)**: `flash-loan-abi.ts` fee constants (`AAVE_V3_FEE_BPS`, `SYNCSWAP_FEE_BPS`) and `thresholds.ts` lookup functions both lack test coverage. These drive profit calculations and opportunity filtering — a wrong constant or broken lookup silently produces incorrect results. Combined with the P0 DAI address bug, this shows that data-centric modules need more rigorous assertion testing than "it exists" checks.

9. **Platform Detection Fragmentation (P2-15 + P1-7 + P3-25)**: `isProduction`, `IS_CONSTRAINED_HOST`, and `worker-pool-config` platform detection all exist independently with different criteria. `worker-pool-config.ts` has zero test coverage (P1-7), while the other two disagree on which platform env vars to check (P2-15, P3-25). A single `utils/environment.ts` module could consolidate all platform detection logic.

---

## Recommended Action Plan

### Phase 1: Immediate (P0-P1 — data bugs and type mismatches, fix before deployment)
- [ ] Fix P0-1: Replace wrong DAI address in `mempool-config.ts:592,598` with `0x6B175474E89094C44Da98b954EedeAC495271d0F`
- [ ] Fix P1-1: Update `FlashLoanProtocolSchema` to match canonical `FlashLoanProtocol` type (add `dai_flash_mint`, `morpho`; remove `jupiter`)
- [ ] Fix P1-3: Replace placeholder GMX router address or remove entry
- [ ] Fix P1-4: Either add `'jupiter'` to `FlashLoanProtocol` type, or mark Solana's protocol differently
- [ ] Fix P1-5: Add `getEstimatedGasCostUsd` and `chainEstimatedGasCostUsd` to `index.ts` barrel exports
- [ ] Fix P1-6: Add `mantle` and `mode` entries to `NATIVE_TOKENS` in addresses.ts

### Phase 2: Next Sprint (P1-P2 — coverage, security, and consistency)
- [ ] Fix P1-2: Add emerging L2 chains to `KNOWN_CHAINS` in string-interning.ts
- [ ] Fix P1-7: Add `worker-pool-config.test.ts` (15-20 test cases: platform detection, env var overrides, pool sizing)
- [ ] Fix P1-8: Add `flash-loan-abi.test.ts` (10-15 test cases: fee constants, BigInt conversions, ABI signatures)
- [ ] Fix P2-5: Consolidate env parsing utilities in utils/env-parsing.ts
- [ ] Fix P2-6: Add KNOWN_ROUTERS entries for missing chains (fantom, zksync, linea)
- [ ] Fix P2-9: Add NODE_ENV guard to `DISABLE_CONFIG_VALIDATION`
- [ ] Fix P2-10: Document or mitigate API key exposure in chain URL objects
- [ ] Fix P2-11: Wrap R2_CONFIG in a getter or add redacted toString/toJSON
- [ ] Fix P2-14: Make `MEV_PRIORITY_FEE_SUMMARY` dynamic or document it's pre-override
- [ ] Fix P2-15: Consolidate `isProduction` into a single canonical definition
- [ ] Fix P2-16: Document the `!== 'false'` opt-out pattern for safety-critical flags
- [ ] Fix P2-17: Align partition provider config with architecture docs (or vice versa)
- [ ] Fix P2-18: Add tests for thresholds.ts lookup functions (12-16 test cases)
- [ ] Fix P2-19: Add tests for token staleness functions (8-12 test cases)
- [ ] Fix P2-20: Add tests for `validateChainEnvironment()` and `isLocalhostUrl()` (8-10 test cases)
- [ ] Fix P2-21: Add tests for remaining 4 chain-url-builder config factories

### Phase 3: Backlog (P2-P3 — improvements and polish)
- [ ] Fix P2-7: Add missing event signatures to event-config.ts (if not in services)
- [ ] Fix P2-12: Extract shared config validation logging utility
- [ ] Fix P3-22: Expand CURVE_POOL_TOKENS to more chains
- [ ] Fix P3-24: Add missing DEX names to COMMON_DEXES interning pool
- [ ] Fix P3-25: Align IS_CONSTRAINED_HOST with isProduction platform detection
- [ ] Fix P3-26: Add bridge route symmetry validation
- [ ] Fix P3-27: Consider splitting dex-factories.ts (~1K lines)
- [ ] Fix P3-31: Clarify Aave V3 fee comment (5 bps vs 9 bps)
- [ ] Resolve 5 open TODOs in source (Balancer V2 config, MultiPathQuoter addresses, 3x Mantle/Mode DEX verification)

---

## Methodology Notes

- **6 agents spawned**: architecture-auditor, bug-hunter, security-auditor, test-quality-analyst, mock-fidelity-validator, performance-refactor-reviewer
- **Agent delivery**: 6 of 6 agents delivered comprehensive reports via SendMessage (test-quality-analyst delivered late but complete)
- **Agent stall rate**: 0% (all 6 agents reported — test-quality-analyst was delayed but ultimately delivered)
- **Team lead self-execution**: Team lead read all 28 source files directly and independently identified initial findings before agent reports arrived.
- **Verification protocol**: All findings verified against actual source code with file:line references. P0 DAI address bug cross-verified against `addresses.ts:455` canonical DAI address.
- **Agent specialization value**: Bug Hunter found the P0 DAI address bug that team lead's initial review missed. Security Auditor identified API key and secret exposure patterns not in initial report. Architecture Auditor found the critical barrel export gap (P1-5). Performance Reviewer quantified logger duplication savings. Mock Fidelity Validator confirmed Grade A address accuracy across core modules.
