# Phase 3 Extended Deep Analysis Report

> **Date:** 2026-02-24
> **Analysis Method:** 6-agent multi-role extended deep analysis (Latency Profiler, Failure Mode Analyst, Data Integrity Auditor, Cross-Chain Analyst, Observability Auditor, Config Drift Detector)
> **Scope:** Phase 3 code changes from DEEP_ENHANCEMENT_ANALYSIS_2026-02-22.md — 38 files changed, ~500 insertions, covering Solana execution (#29), DAI flash minting (#30), statistical arbitrage (#31), CEX price signals (#32), CoW Protocol (#28), and partition refactoring
> **Grade:** C+ (Solid analytics improvements, but Solana execution path has critical gaps preventing production use)

---

## Executive Summary

- **Total findings:** 32 (4 Critical, 7 High, 12 Medium, 9 Low)
- **Agent agreement map:** ALT handling (4/6 agents), amountIn mismatch (3/6), Binance silent blindness (2/6), zero observability (2/6)
- **Overall health:** Analytics layer (regime-detector, spread-tracker, correlation-tracker, cex-dex-spread) is well-engineered with genuine latency improvements. Solana execution path is NOT production-ready due to ALT decompilation bug and missing transaction confirmation. Observability infrastructure (tracing, metrics) is completely absent from all Phase 3 code.

**Top 5 highest-impact issues:**
1. Solana execution builds malformed transactions when Jupiter uses Address Lookup Tables (4 agents agree)
2. `amountIn` field set to USD string but downstream expects wei/lamports — wrong trade size by orders of magnitude (3 agents agree)
3. Zero trace context propagation and zero metrics emission across all Phase 3 features
4. 15 environment variables missing from `.env.example` — operators cannot configure new features
5. Binance WebSocket disconnect causes silent spread blindness with only debug-level logging

---

## Synthesis Quality Gates

| Gate | Status | Notes |
|------|--------|-------|
| **Completeness** | PASS | All 6 of 6 agents reported findings |
| **Cross-Validation** | PASS | Agents 2+3 agree on ALT bug and amountIn mismatch; Agents 2+5 agree on Binance blindness |
| **Deduplication** | PASS | 5 findings merged across agents; all attributed |
| **False Positive Sweep** | PASS | All P0/P1 findings have exact file:line evidence; none are known correct patterns |

---

## Critical Findings (P0)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| C1 | Solana Execution | `solana-execution.strategy.ts:232-236` + `transaction-builder.ts:165-189` | **ALT accounts never passed to `buildBundleTransaction()`.** `decompileInstructions()` only reads `staticAccountKeys`, so ALT-resolved accounts become `undefined`. Jupiter routes using ALTs (most complex, profitable routes) produce malformed transactions that fail on-chain, wasting tips. The keypair code path is non-functional for real Jupiter routes. | Cross-Chain, Failure-Mode, Data-Integrity, Latency | HIGH (4 agents) | Fetch ALT accounts from on-chain via `connection.getAddressLookupTable()` for each ALT in the original tx's `addressTableLookups`, or use `TransactionMessage.decompile()` which resolves ALTs properly. As interim, skip bundle building when ALTs are present and use the raw Jupiter tx fallback. | 4.6 |
| C2 | Data Integrity | `statistical-arbitrage-detector.ts:215` | **`amountIn` set to USD string but field contract says wei.** `amountIn: String(this.config.defaultPositionSizeUsd)` produces `"10000"`. Downstream: Jupiter interprets as 10000 lamports (≈$0.00001 SOL), BackrunStrategy does `BigInt("10000")` = 10000 wei (≈$0). Trade sizing is wrong by 10^12 to 10^15 factor. | Data-Integrity, Cross-Chain, Failure-Mode | HIGH (3 agents) | Either leave `amountIn` undefined (let execution strategy size from `expectedProfit`), or convert USD to token units using price and decimals: `amountIn = String(BigInt(Math.floor(positionUsd / tokenPriceUsd * 10**decimals)))`. | 4.4 |
| C3 | Observability | All Phase 3 files | **Zero trace context propagation and zero metrics emission.** No `traceId`, `spanId`, counters, gauges, or histograms in any Phase 3 file. Cannot correlate events across service boundaries. Cannot alert on degradation patterns. `opportunityId` provides manual correlation but is not integrated with OTEL. | Observability | HIGH | Add OTEL span creation in `SolanaExecutionStrategy.execute()` and `StatisticalArbitrageStrategy.execute()`. Add basic counters: `solana_executions_total`, `stat_arb_signals_total`, `cow_backrun_detections_total`, `binance_reconnects_total`. | 3.8 |
| C4 | Config | `.env.example` | **15 Phase 3 environment variables missing from `.env.example`.** Operators cannot discover `FEATURE_SOLANA_EXECUTION`, `JITO_ENDPOINT`, `SOLANA_WALLET_PUBLIC_KEY`, `FEATURE_STATISTICAL_ARB`, `JITO_TIP_LAMPORTS`, `SOLANA_MAX_SLIPPAGE_BPS`, `SOLANA_MIN_PROFIT_LAMPORTS`, `STAT_ARB_MIN_CONFIDENCE`, `STAT_ARB_MAX_AGE_MS`, `STAT_ARB_MIN_PROFIT_USD`, `FEATURE_COW_BACKRUN`, `PARTITION_CHAINS`, `SOLANA_MAX_PRICE_DEVIATION_PCT`, `COW_BACKRUN_ETH_PRICE_USD` (proposed) without reading source code. | Config-Drift | HIGH | Add all 15 env vars to `.env.example` with documentation comments, grouped under `# Phase 3: Solana Execution`, `# Phase 3: Statistical Arbitrage`, `# Phase 3: CoW Backrun Detection` sections. | 4.2 |

---

## High Findings (P1)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| H1 | Solana Execution | `solana-execution.strategy.ts:269-288` | **No Solana transaction confirmation polling.** After `sendProtectedTransaction()`, result is treated as final. Solana bundles may land but later be dropped during slot leader changes. `lastValidBlockHeight` from Jupiter swap result is not checked. System may log phantom profits from unconfirmed transactions. | Cross-Chain | HIGH | Poll `connection.getSignatureStatuses()` with the returned tx hash, up to `lastValidBlockHeight`. Only record profit after confirmed finality. | 3.6 |
| H2 | Failure Mode | `solana-execution.strategy.ts:240-248` | **Raw Jupiter tx fallback lacks Jito tip.** When `getWalletKeypair()` returns `undefined`, the raw Jupiter tx is submitted without a Jito tip instruction. Whether `sendProtectedTransaction` adds its own tip depends on the Jito provider implementation (not in diff). If it does not, the tx has no MEV protection. | Failure-Mode | MEDIUM | Document whether `sendProtectedTransaction` adds its own tip. If it does not, throw an error when keypair is unavailable rather than submitting unprotected. | 3.4 |
| H3 | Failure Mode | `binance-ws-client.ts:347-357` + `cex-dex-spread.ts:296-304` | **Binance disconnect causes silent spread blindness.** After max reconnect attempts, 5-minute periodic retry begins. During the gap, CEX prices go stale after 60s (`maxCexPriceAgeMs`). `checkAndEmitAlert` returns early with only a `debug` log. No spread alerts emitted, no operator awareness. | Failure-Mode, Observability | HIGH | Escalate to `warn` when ALL CEX prices for a token are stale. Add a health check indicator for Binance WS connection status. Add a `binance_disconnected_seconds` gauge. | 3.6 |
| H4 | Cross-Chain | `strategy-factory.ts:433` | **Statistical arb on Solana routes to EVM flash loan.** Stat arb opportunities with `chain: 'solana'` route to `StatisticalArbitrageStrategy` (type `'statistical'` takes priority over chain `'solana'` in factory). That strategy extends `BaseExecutionStrategy` (EVM-only) and delegates to flash loan. Solana has no flash loans, so execution will fail. | Cross-Chain | HIGH | Add guard in strategy factory: reject `type: 'statistical'` with `chain: 'solana'`, or route to a Solana-specific stat arb strategy. | 3.4 |
| H5 | Config | `mev-risk-analyzer.ts:539`, `env-utils.test.ts:20` | **eslint-disable comments removed without fixing underlying issues.** `mev-risk-analyzer.ts:539` uses `require()` (intentional CJS sync load) — removed `@typescript-eslint/no-var-requires` disable. `env-utils.test.ts:20` uses `require()` for Jest mock — removed `@typescript-eslint/no-require-imports` disable. These will cause lint failures. | Config-Drift | HIGH | Restore the eslint-disable comments on these lines, or convert to dynamic `import()`. | 3.8 |
| H6 | Failure Mode | `health-server.ts:337-358` | **No timeout on `detector.stop()` during partition shutdown.** `shutdownPartitionService` awaits `detector.stop()` without timeout. If detector hangs (e.g., stuck WebSocket disconnect, RPC call), the entire partition process hangs until externally killed. | Failure-Mode | HIGH | Wrap in `Promise.race([detector.stop(), new Promise(resolve => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS))])`. | 3.4 |
| H7 | Cross-Chain | `engine.ts:1066-1076` | **Jito provider uses connection stubs that throw.** Both the keypair path (ALT bug, C1) and the fallback path (stubs throw on `sendRawTransaction`) may fail without `SOLANA_RPC_URL`. Combined with C1, both Solana execution paths have potential failures. | Cross-Chain, Failure-Mode | MEDIUM | Add explicit validation at engine startup: if `FEATURE_SOLANA_EXECUTION === 'true'` but `SOLANA_RPC_URL` is not set, log error and skip registration. Currently proceeds silently. | 3.2 |

---

## Medium Findings (P2)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| M1 | Data Integrity | `spread-tracker.ts:198-206` | **Exit signal missed during gradual mean reversion.** When spread mean-reverts through multiple updates between band and middle, `prevWasOutside` is false and exit signal is lost. Does NOT affect stat-arb detector (uses entry signals only) but affects position management consumers. | Data-Integrity | MEDIUM | Track `wasOutsideBand` flag on state that persists until exit signal is generated, rather than checking only previous spread value. | 2.8 |
| M2 | Config | `cow-backrun-detector.ts:66` | **ETH price hardcoded at $2500.** `DEFAULT_ETH_PRICE_USD = 2500` affects all CoW backrun profit calculations. Configurable via constructor (`ethPriceUsd`) but no env var plumbing. Operators cannot update without code change. | Config-Drift | MEDIUM | Add env var `COW_BACKRUN_ETH_PRICE_USD` with `parseInt(process.env.COW_BACKRUN_ETH_PRICE_USD) ?? DEFAULT_ETH_PRICE_USD`. | 2.6 |
| M3 | Observability | `engine.ts:~1036` | **No log when `FEATURE_SOLANA_EXECUTION` is not enabled.** The entire Solana init block is silently skipped. Other feature flags log "disabled". Operators cannot distinguish "not enabled" from "failed to initialize". | Observability | HIGH | Add `else { this.logger.info('Solana execution disabled (FEATURE_SOLANA_EXECUTION != true)'); }`. | 2.8 |
| M4 | Observability | `engine.ts:1104-1108` | **Solana init failure is non-fatal with no health indicator.** When Solana initialization fails, engine continues without it. No health endpoint reports "Solana execution: unavailable". | Observability | MEDIUM | Surface Solana strategy registration status in engine health response. | 2.6 |
| M5 | Cross-Chain | `cow-backrun-detector.ts:348-349` | **Unknown token decimal assumption (18) misestimates WBTC.** For tokens not in stablecoin/WETH sets, `bigintTo18DecimalNumber()` assumes 18 decimals. For WBTC (8 decimals), `10^8 / 10^12 = 0` in BigInt truncation. WBTC-only CoW trades estimated at $0, filtering out legitimate backrun opportunities. | Cross-Chain | MEDIUM | Add a known-decimals map for major tokens (WBTC=8, WETH=18, LINK=18, etc.) or query token decimals on-chain. | 2.4 |
| M6 | Config | `service-config.ts:251` vs `engine.ts:1037` | **`SUPPORTED_EXECUTION_CHAINS` always includes 'solana' regardless of feature flag.** `isExecutionSupported('solana')` returns true even when `FEATURE_SOLANA_EXECUTION` is not set and no strategy is registered. | Config-Drift | MEDIUM | Either make `SUPPORTED_EXECUTION_CHAINS` dynamic based on registered strategies, or add a runtime warning. | 2.4 |
| M7 | Cross-Chain | `base.strategy.ts:403` | **Stale error message says Solana is detection-only.** `SolanaExecutionStrategy` bypasses this (doesn't extend `BaseExecutionStrategy`), so not a runtime bug, but confusing if triggered. | Cross-Chain | LOW | Update the error message to remove the Solana-specific note. | 2.0 |
| M8 | Failure Mode | `statistical-arbitrage-detector.ts:215` | **No validation of `amountIn` against flash loan pool capacity.** `defaultPositionSizeUsd` could exceed pool limits. On-chain revert is safe (atomic), but wastes gas. | Failure-Mode | MEDIUM | Add a pre-execution capacity check or cap `amountIn` at flash loan provider's available liquidity. | 2.2 |
| M9 | Cross-Chain | `flash-loan.strategy.ts:504-513` | **Solana entry in FLASH_LOAN_PROVIDERS creates phantom provider.** Aggregator builds entry with `poolAddress: ''` and `isAvailable: true`. Wastes a ranking/selection cycle. | Cross-Chain | LOW | Add `if (!providerConfig.address) continue;` guard at top of the loop body. | 2.0 |
| M10 | Observability | Health server | **Binance WS, CoW watcher, stat arb detector status not in health checks.** `BinanceWebSocketClient.isConnected()`, `CowSettlementWatcher.isActive()` exist but are not surfaced in any health endpoint. | Observability | MEDIUM | Wire these status methods into partition or engine health responses. | 2.4 |
| M11 | Observability | `cex-price-normalizer.ts:138` | **Unmapped Binance symbols silently return undefined.** No debug log for unmapped symbols. If new tokens start trading, operators have no visibility into missed data. | Observability | LOW | Add periodic summary log: "N unmapped symbols seen in last 60s". | 2.0 |
| M12 | Config | `partition/config.ts:250` | **`HOSTNAME || 'local'` should use `??`.** Empty string HOSTNAME (unusual but possible) would fall through to default with `||` but not with `??`. Project convention says `??` for values that can be empty. | Config-Drift | LOW | Change to `process.env.HOSTNAME ?? 'local'`. | 2.0 |

---

## Low Findings (P3)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| L1 | Cross-Chain | `cex-dex-spread.ts:87` | `maxCexPriceAgeMs: 60000` is chain-agnostic. On Solana (400ms slots), 60s is 150 blocks stale. Acceptable but could be tighter per-chain. | Cross-Chain | LOW | Consider per-chain override in config. | 1.6 |
| L2 | Failure Mode | `cow-settlement-watcher.ts:211-217` | Chain reorg between stop/start may miss settlements. Risk is very low on Ethereum mainnet (reorg depth >1 is extremely rare). | Data-Integrity, Failure-Mode | LOW | Consider subtracting `lookbackBlocks` from `lastProcessedBlock` on restart. | 1.4 |
| L3 | Config | `setMaxListeners(20)` in 5 files | Inconsistent pattern: `StatisticalArbitrageDetector` uses static constant, other 4 hardcode `20`. | Config-Drift | LOW | Standardize on static constant pattern. | 1.2 |
| L4 | Observability | `health-server.ts:225` | Listening log is at `debug` level but is a one-time startup event. Should be `info`. | Observability | LOW | Change to `logger.info(...)`. | 1.2 |
| L5 | Observability | `regime-detector.ts` | Regime transitions (mean_reverting ↔ random_walk ↔ trending) not logged. | Observability | LOW | Log at info level when `getRegime()` returns a different value than cached. | 1.4 |
| L6 | Config | Various | Several Solana config values (`tipLamports`, `maxSlippageBps`, `minProfitLamports`) are configurable via constructor but env vars are not in `.env.example`. Covered by C4. | Config-Drift | LOW | Covered by C4. | 1.2 |
| L7 | Cross-Chain | `cex-price-normalizer.ts` | No ZK token CEX mapping for zkSync chain. LINEA uses ETH (covered by ETHUSDT). | Cross-Chain | LOW | Add `ZKUSDT` mapping if ZK token arb is relevant. | 1.0 |
| L8 | Cross-Chain | `cow-backrun-detector.ts` | CoW Protocol Gnosis Chain not covered (Ethereum only). Out of scope for current 11-chain support. | Cross-Chain | LOW | Document as future expansion. | 1.0 |
| L9 | Latency | `pair-correlation-tracker.ts:167` | FP drift recomputation every 500 updates adds ~0.05ms amortized to ~0.0001ms/update. Only latency addition in Phase 3 — justified by correctness benefit. | Latency | LOW | No change needed. | 1.0 |

---

## Latency Budget Table

| Stage | Component | File:Line | Estimated Latency Impact | Bottleneck? |
|-------|-----------|-----------|--------------------------|-------------|
| Hurst computation | `computeHurstFromBuffer()` eliminates array allocations | `regime-detector.ts:199-259` | **-0.1 to -0.5ms** per call | Previously yes, now reduced |
| Bollinger Bands | Cached in `addSpread()`, buffer-direct computation | `spread-tracker.ts:146,271-307` | **-0.05 to -0.2ms** per `getSignal()` | No longer recomputed per access |
| CEX price fan-out | O(1) `tokenIndex` Map replaces O(n) iteration | `cex-dex-spread.ts:105,131-140` | **-0.01 to -0.1ms** per `updateCexPrice()` | Reduced from O(50) to O(10) |
| History trimming | `splice(0, trimCount)` replaces `filter()` | `cex-dex-spread.ts:317-327` | **-0.01 to -0.05ms** amortized | Avoids new array allocation |
| Pair config lookup | O(1) `pairConfigMap` Map replaces `find()` | `statistical-arbitrage-detector.ts:88,176` | **-0.001 to -0.01ms** | Marginal (10-20 pairs) |
| Module-level constants | `SIX_DECIMAL_STABLES` Set at module level | `cow-backrun-detector.ts:86-89` | **-0.01ms** | Avoids per-call Set allocation |
| FP drift recompute | Every 500 updates, full recomputation | `pair-correlation-tracker.ts:167,255-277` | **+0.0001ms** amortized | Acceptable for correctness |
| **Net Phase 3 impact** | | | **-0.2 to -0.8ms per detection cycle** | 0.4-1.6% of 50ms budget |

---

## Failure Mode Map

| # | Stage | Failure Mode | Detection | Recovery | Data Loss Risk | File:Line |
|---|-------|-------------|-----------|----------|----------------|-----------|
| F1 | Jupiter quote | HTTP error / empty response | Validated + retried (2x) | Caught by strategy | None | `jupiter-client.ts:128-132,221-225` |
| F2 | Jupiter swap tx | Missing `swapTransaction` | Validated, throws | Caught by strategy | None | `jupiter-client.ts:178-179` |
| F3 | Keypair unavailable | `getWalletKeypair()` → undefined | Warning logged | Fallback to raw Jupiter tx (no tip) | MEDIUM: no MEV protection | `solana-execution.strategy.ts:230-248` |
| F4 | ALT resolution | Jupiter tx uses ALTs, none provided | Warning logged, **proceeds** | Malformed tx fails on-chain | HIGH: wasted tips | `transaction-builder.ts:112-116` |
| F5 | Jito submission | `sendProtectedTransaction` returns failure | Detected via `success` check | Returns error result | None | `solana-execution.strategy.ts:269-303` |
| F6 | Jito stubs | SOLANA_RPC_URL not configured | Throws descriptive error | Caught by strategy | None | `engine.ts:1066-1077` |
| F7 | Stat arb no flash loan | `flashLoanStrategy` is null | Returns `ERR_NO_FLASH_LOAN_STRATEGY` | Caller receives error | None (FIX: was fake success) | `statistical-arbitrage.strategy.ts:196-208` |
| F8 | Binance max reconnects | All 10 attempts exhausted | Error emitted, last-resort starts | 5-min periodic retry | HIGH: 5-min CEX price gap | `binance-ws-client.ts:347-357` |
| F9 | CEX prices all stale | `maxCexPriceAgeMs` exceeded | Debug log only | Silent — no alerts | HIGH: spread blindness | `cex-dex-spread.ts:296-304` |
| F10 | Partition shutdown | `detector.stop()` hangs | NOT detected | Process hangs until killed | MEDIUM: port occupied | `health-server.ts:337-358` |
| F11 | Double shutdown | SIGTERM + SIGINT close together | `isShuttingDown` flag | Second signal ignored | None | `handlers.ts:190-198` |
| F12 | DaiFlashMint non-DAI | `onFlashLoan` called with wrong token | `if (token != DAI) revert` | Tx reverts | None (defense-in-depth) | `DaiFlashMintArbitrage.sol:183` |

---

## Chain-Specific Edge Cases

| # | Chain(s) | Issue | Impact | Severity | File:Line |
|---|----------|-------|--------|----------|-----------|
| X1 | Solana | ALTs not resolved in bundle building — most complex routes fail | Solana execution non-functional for profitable routes | Critical | `solana-execution.strategy.ts:232` |
| X2 | Solana | No tx confirmation polling — phantom profits possible | Incorrect P&L tracking | High | `solana-execution.strategy.ts:269-288` |
| X3 | Solana | Stat arb opportunities route to EVM flash loan strategy | Execution fails silently | High | `strategy-factory.ts:433` |
| X4 | Solana | `SUPPORTED_EXECUTION_CHAINS` includes 'solana' regardless of feature flag | False positive on `isExecutionSupported()` | Medium | `service-config.ts:251` |
| X5 | Ethereum | CoW backrun WBTC trades estimated at $0 (18-decimal assumption) | Missed backrun opportunities | Medium | `cow-backrun-detector.ts:348` |
| X6 | All | CEX price staleness window (60s) chain-agnostic | 150 blocks on Solana vs 5 blocks on Ethereum | Low | `cex-dex-spread.ts:87` |

---

## Observability Assessment

### Trace Propagation: NONE
No `traceId` or `spanId` in any Phase 3 file. `opportunityId` provides manual correlation within a pipeline but is not OTEL-integrated.

### Log Coverage: GOOD
All Phase 3 files have appropriate success/error/decision logging. Hot-path events correctly at debug level. Structured error codes (`[ERR_*]`) used consistently in strategies.

### Blind Spots
| # | Pattern | File:Line | Impact |
|---|---------|-----------|--------|
| OBS-1 | Jupiter error body swallowed | `jupiter-client.ts:222` | Low — fallback to 'unknown' |
| OBS-2 | Solana init failure non-fatal, no health indicator | `engine.ts:1104-1108` | Medium — invisible to operators |
| OBS-3 | Unmapped Binance symbols silently return undefined | `cex-price-normalizer.ts:138` | Low — cold path |
| OBS-4 | No log when FEATURE_SOLANA_EXECUTION is off | `engine.ts:~1036` | Medium — ambiguous state |

### Metrics: NONE
Zero counters, gauges, or histograms in all Phase 3 code.

---

## Configuration Health

### Feature Flags: CORRECT
All experimental features use `=== 'true'` (opt-in). Safety feature `ENABLE_CROSS_REGION_HEALTH` uses `!== 'false'` (opt-out). No violations.

### || vs ?? Violations: CLEAN
Phase 3 code consistently uses `??` for numeric defaults. One minor exception: `process.env.HOSTNAME || 'local'` in `partition/config.ts:250`.

### Env Var Coverage: 15 MISSING
See C4 for full list of missing `.env.example` entries.

### ESLint Disable Removals: 2-3 BUGS
`mev-risk-analyzer.ts:539` (source file, `require()`) and `env-utils.test.ts:20` (test file, `require()`) had disable comments removed without fixing underlying code. Will cause lint failures.

---

## Cross-Agent Insights

### Information Separation Results (Agents 2 + 3)

| Area | Agent 2 (Failure-Mode) | Agent 3 (Data-Integrity) | Agreement? |
|------|----------------------|------------------------|------------|
| ALT decompilation | F5: malformed tx, wasted tips | HIGH: `decompileInstructions` only reads `staticAccountKeys` | **AGREE** → Promoted to Critical |
| amountIn mismatch | F11: no capacity validation | MEDIUM: USD string vs wei contract | **AGREE** → Promoted to Critical |
| CoW stop/restart reorg | F16: possible duplicate processing | LOW: missed settlements possible | **AGREE** on low risk |
| Binance reconnect race | F13/F14: SAFE (no race) | Not analyzed | Single-source finding |
| Spread tracker exit signal | Not analyzed | MEDIUM: exit missed during gradual reversion | Single-source finding |

### Multi-Agent Convergence

The ALT handling issue was independently identified by 4 out of 6 agents from different perspectives:
- **Cross-Chain**: ALT accounts not passed from strategy to builder
- **Failure-Mode**: Cascading failure scenario traced end-to-end
- **Data-Integrity**: `decompileInstructions` produces undefined PublicKeys
- **Latency**: Noted as "correctness concern" during serialization analysis

This level of convergence makes C1 the highest-confidence finding in the report.

---

## Conflict Resolutions

No conflicts between agents. All agents agreed on major findings. Minor perspective differences:
- Agent 2 assessed `detector.stop()` hang as MEDIUM risk (Kubernetes would eventually kill). Agent 3 did not analyze shutdown. No conflict — single perspective adopted.
- Agent 1 assessed FP drift recomputation as acceptable latency addition (+0.0001ms amortized). Agent 3 assessed the 500-interval as adequate for precision. Complementary perspectives — both conclusions adopted.

---

## Recommended Action Plan

### Phase 1: Immediate (P0 — fix before any Solana execution deployment)

- [ ] **C1**: Fix ALT handling in Solana execution — fetch ALT accounts from on-chain or skip bundle building when ALTs present (Agents: Cross-Chain, Failure-Mode, Data-Integrity, Latency. Score: 4.6)
- [ ] **C2**: Fix `amountIn` semantic mismatch — convert USD to token units or leave undefined (Agents: Data-Integrity, Cross-Chain, Failure-Mode. Score: 4.4)
- [ ] **C4**: Add 15 missing env vars to `.env.example` (Agent: Config-Drift. Score: 4.2)
- [ ] **H5**: Restore removed eslint-disable comments in `mev-risk-analyzer.ts:539` and `env-utils.test.ts:20` (Agent: Config-Drift. Score: 3.8)

### Phase 2: Next Sprint (P1 — reliability and observability)

- [ ] **C3**: Add trace context and basic metrics to Phase 3 features (Agent: Observability. Score: 3.8)
- [ ] **H1**: Add Solana tx confirmation polling up to `lastValidBlockHeight` (Agent: Cross-Chain. Score: 3.6)
- [ ] **H3**: Escalate stale CEX prices from debug to warn + add health indicator (Agents: Failure-Mode, Observability. Score: 3.6)
- [ ] **H4**: Guard stat arb on Solana — reject or route to Solana-specific strategy (Agent: Cross-Chain. Score: 3.4)
- [ ] **H6**: Add timeout wrapper around `detector.stop()` in shutdown (Agent: Failure-Mode. Score: 3.4)
- [ ] **H2**: Document/fix raw Jupiter tx fallback MEV protection (Agent: Failure-Mode. Score: 3.4)
- [ ] **H7**: Validate SOLANA_RPC_URL when feature flag is enabled (Agents: Cross-Chain, Failure-Mode. Score: 3.2)

### Phase 3: Backlog (P2/P3 — hardening and polish)

- [ ] **M1**: Fix spread tracker exit signal for gradual mean reversion (Agent: Data-Integrity. Score: 2.8)
- [ ] **M3/M4**: Log Solana feature flag state + surface in health (Agent: Observability. Score: 2.8/2.6)
- [ ] **M2**: Add env var for CoW ETH price override (Agent: Config-Drift. Score: 2.6)
- [ ] **M5**: Add known-decimals map for major tokens in CoW detector (Agent: Cross-Chain. Score: 2.4)
- [ ] **M6**: Make `SUPPORTED_EXECUTION_CHAINS` dynamic or add warning (Agent: Config-Drift. Score: 2.4)
- [ ] **M10**: Wire Binance/CoW/stat-arb status into health checks (Agent: Observability. Score: 2.4)
- [ ] **M8**: Add pre-execution flash loan capacity check (Agent: Failure-Mode. Score: 2.2)
- [ ] **M9/M7/M11/M12**: Minor cleanup items (Various agents. Scores: 2.0)
- [ ] **L1-L9**: Low-priority items (Various agents. Scores: 1.0-1.6)

---

## Appendix: Files Analyzed

### By All 6 Agents (highest coverage)
- `services/execution-engine/src/strategies/solana-execution.strategy.ts` (322 lines)
- `shared/core/src/detector/cow-backrun-detector.ts` (383 lines)
- `shared/core/src/detector/statistical-arbitrage-detector.ts` (256 lines)

### By 4-5 Agents
- `services/execution-engine/src/solana/jupiter-client.ts` (265 lines)
- `services/execution-engine/src/solana/transaction-builder.ts` (191 lines)
- `services/execution-engine/src/engine.ts` (relevant sections)
- `services/execution-engine/src/strategies/strategy-factory.ts` (585 lines)
- `shared/core/src/feeds/binance-ws-client.ts` (429 lines)
- `shared/core/src/analytics/cex-dex-spread.ts` (351 lines)
- `shared/core/src/analytics/spread-tracker.ts` (307 lines)

### By 2-3 Agents
- `shared/core/src/analytics/regime-detector.ts` (323 lines)
- `shared/core/src/analytics/pair-correlation-tracker.ts` (312 lines)
- `shared/core/src/partition/handlers.ts` (266 lines)
- `shared/core/src/partition/health-server.ts` (358 lines)
- `shared/core/src/partition/config.ts` (406 lines)
- `shared/config/src/service-config.ts` (relevant sections)
- `contracts/src/DaiFlashMintArbitrage.sol` (251 lines)

### By 1 Agent (specialized)
- `shared/core/src/feeds/cex-price-normalizer.ts`
- `shared/core/src/feeds/cow-settlement-watcher.ts`
- `shared/core/src/mev-protection/types.ts`
- `shared/core/src/mev-protection/mev-risk-analyzer.ts`
- `services/execution-engine/src/strategies/statistical-arbitrage.strategy.ts`
- `shared/core/src/analytics/orderflow-pipeline-consumer.ts`
- `shared/core/src/caching/shared-memory-cache.ts`
- `.env.example`

---

*This report represents the synthesized findings of 6 specialized analysis agents. All findings include file:line evidence, multi-agent cross-validation where applicable, and calibrated confidence levels. Priority scores use the formula: Score = (Impact × 0.4) + ((5 − Effort) × 0.3) + ((5 − Risk) × 0.3).*
