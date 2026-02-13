# Deep Analysis Report: `scripts/` and `contracts/scripts/`

**Date**: 2026-02-13
**Scope**: `scripts/` (~40 files), `contracts/scripts/` (~15 files)
**Agents**: 6 parallel specialized agents
**Total Findings**: 28 unique (after deduplication from 44 raw findings)

---

## Executive Summary

- **Critical (P0)**: 0
- **High (P1)**: 3
- **Medium (P2)**: 12
- **Low (P3)**: 13
- **Top 3 highest-impact issues**:
  1. Mempool Detector missing from service definitions — port 3007 conflict with Unified Detector (Architecture)
  2. Zero test coverage for `contracts/scripts/lib/deployment-utils.ts` (1,242 lines of critical deployment logic) and all 17 top-level scripts (Test Coverage)
  3. 6 deployment scripts share ~80% identical code (~1,100 duplicated lines) with systematic `||` vs `??` convention violations (Duplication + Bug)
- **Overall health grade**: **B-**
  - Existing tests are high-quality (B+), but coverage is only 29% of lib files and 0% of scripts
  - Security posture is strong (B+) with proactive protections already in place
  - Architecture is well-structured but has doc/config drift
  - Deployment scripts need significant deduplication

### Agent Agreement Map

| Area | Agents That Flagged It |
|------|----------------------|
| `\|\|` vs `??` in deploy scripts (timestamp) | Architecture, Bug Hunter, Security, Mock Fidelity |
| `\|\|` vs `??` in deploy scripts (hash/gasUsed) | Architecture, Bug Hunter, Mock Fidelity |
| Missing test coverage for deployment-utils.ts | Test Quality, Mock Fidelity |
| `assessImpact()` falsy baseline score | Bug Hunter, Test Quality |
| `port-config.js` `\|\|` vs `??` | Architecture, Mock Fidelity |
| Deployment script duplication | Performance Reviewer (primary) |
| Missing mainnet confirmation prompts | Security (primary) |
| Missing signal handlers in start-local.js | Bug Hunter (primary) |
| Mempool Detector service gap | Architecture (primary) |

---

## High Findings (P1 - Reliability/Coverage Impact)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 1 | Architecture Mismatch | `service-definitions.js`, `port-config.js`, `service-ports.json` | Mempool Detector (documented at port 3007) missing from service definitions. Port 3007 assigned to `unified-detector` in `service-ports.json` but to Mempool in CLAUDE.md and ARCHITECTURE_V2.md. `clean-dist.js:29` confirms the service exists. `npm run dev:all` will never start the mempool detector. | Architecture | HIGH | Reconcile port 3007 assignment. Add mempool-detector to service definitions or document that it shares port with unified-detector. | 3.8 |
| 2 | Test Coverage | `contracts/scripts/lib/deployment-utils.ts` (1,242 lines) | Zero test coverage for critical deployment logic: `validateMinimumProfit()` (mainnet safety guard), `withRegistryLock()` (concurrent file locking), `approveRouters()` (parallel router approval), `verifyContractWithRetry()`, smoke test functions. A logic bug in `validateMinimumProfit()` could allow unprofitable mainnet deployments. | Test Quality, Mock Fidelity | HIGH | Add unit tests mocking `ethers`, `network`, `run`, `fs`/`lockfile`. Priority: `validateMinimumProfit()`, `withRegistryLock()`, `approveRouters()`. | 3.7 |
| 3 | Test Coverage | `scripts/lib/pid-manager.js` | Zero test coverage for file locking, PID management, and symlink attack prevention (`assertNotSymlink`). Race conditions in `acquirePidLock` and stale lock detection are complex logic paths that could fail silently. | Test Quality | HIGH | Add unit tests with mocked `fs` for: lock acquisition/release cycle, stale lock cleanup, `assertNotSymlink`, concurrent `updatePid` calls. | 3.5 |

## Medium Findings (P2 - Maintainability/Performance)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 4 | Bug (Type Coercion) | `deploy.ts:132`, `deploy-balancer.ts:158`, `deploy-commit-reveal.ts:168`, `deploy-multi-path-quoter.ts:124`, `deploy-syncswap.ts:160`, `deploy-pancakeswap.ts:281` | `block?.timestamp \|\| Math.floor(Date.now() / 1000)` uses `\|\|` instead of `??` in all 6 deploy scripts. Cascading issue: when receipt is null, `blockNumber ?? 0` fetches genesis block (timestamp 0), then `\|\|` silently replaces it with `Date.now()`, producing incorrect deployment metadata. | Architecture, Bug Hunter, Security, Mock Fidelity | HIGH | Change all 6 to `block?.timestamp ?? Math.floor(Date.now() / 1000)` | 3.4 |
| 5 | Bug (Type Coercion) | `scripts/lib/quality-scorer.js:46` | `if (!baselineScore)` treats a legitimate baseline score of `0` (all tests failed) as "no baseline", returning `UNKNOWN` instead of detecting improvement. | Bug Hunter, Test Quality | HIGH | Change to `if (baselineScore == null)` | 3.3 |
| 6 | Data Drift | `deploy-pancakeswap.ts:68-132` vs `discover-pancakeswap-pools.ts:50-99` | `COMMON_TOKEN_PAIRS` hardcoded (65 lines of raw addresses) in deploy script vs dynamic import from `@arbitrage/config CORE_TOKENS` in discovery script. Token address changes won't propagate to deploy script. | Performance Reviewer | HIGH | Extract `getCommonTokenPairs()` into shared `pancakeswap-utils.ts` | 3.6 |
| 7 | Duplication | 6 `deploy*.ts` files (~1,911 LOC) | All 6 deployment scripts share ~80% identical structure (13 shared steps). ~1,100 lines could be eliminated with a shared deployment pipeline function. | Performance Reviewer | HIGH | Create `deployContractPipeline()` in `deployment-utils.ts` accepting a config object. Each script becomes ~30-50 lines. | 3.5 |
| 8 | Duplication | `deploy-pancakeswap.ts:177-223`, `discover-pancakeswap-pools.ts:198-275` | Pool discovery logic and `FEE_TIERS` constant duplicated between deploy and discovery scripts. | Performance Reviewer | HIGH | Extract shared PancakeSwap pool discovery utilities into `contracts/scripts/lib/pancakeswap-utils.ts` | 3.3 |
| 9 | Architecture | `scripts/lib/services-config.js:131-137` | Comment says "FIX M5: Validation no longer runs on module import" but code still runs `validateAllServices()` at import time (guarded by `SKIP_SERVICE_VALIDATION` env var). Comment contradicts actual behavior. | Architecture | HIGH | Either remove auto-validation or update comment to match reality. | 3.2 |
| 10 | Process Safety | `contracts/scripts/deploy.ts`, all deploy scripts | No interactive confirmation prompt before mainnet deployments. Accidental `--network ethereum` deploys immediately, consuming real funds. | Security | HIGH | Add confirmation prompt: "Deploying to MAINNET. Type 'DEPLOY' to continue:" for mainnet networks. | 3.1 |
| 11 | Process Safety | `contracts/scripts/toggle-syncswap-pause.ts:91-213` | No confirmation prompt before pause/unpause on mainnet. Accidentally pausing a mainnet contract halts all arbitrage operations. | Security | HIGH | Add `--confirm` flag requirement for mainnet state-changing operations. | 3.0 |
| 12 | Race Condition | `scripts/start-local.js` (main function) | No SIGINT/SIGTERM handlers. If user presses Ctrl+C during service startup, already-started detached processes become orphans. PID file may be incomplete, making `stop-local.js` unable to clean up. | Bug Hunter | HIGH | Add signal handlers that kill already-started services and clean up PID file. | 3.0 |
| 13 | Missing Validation | All deploy scripts | No check for existing deployed contract before re-deploying. Accidental re-deploy creates orphaned contracts on-chain with approved routers but no reference in the registry. | Security | HIGH | Check deployment registry for existing entry on current network before deploying. Prompt if found. | 2.9 |
| 14 | Convention Violation | All `scripts/lib/*.js` (14 files) | All use CommonJS `require()`/`module.exports` despite convention requiring ES modules. The 3 TS scripts correctly use ESM. Likely intentional (no build step needed) but undocumented exception. | Architecture | HIGH | Document the exception in `code_conventions.md` or convert to `.mjs`. | 2.6 |
| 15 | Bug (Type Coercion) | `scripts/lib/quality-report-generator.js:56` | `baselineScore \|\| 'N/A'` treats baseline score of `0` as `'N/A'`. Related to Finding 5 — same root cause in a different file. | Bug Hunter | HIGH | Change to `baselineScore ?? 'N/A'` | 2.5 |

## Low Findings (P3 - Style/Minor Improvements)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| 16 | Convention | `deploy.ts:189`, 5 other deploy scripts | `deployTx?.hash \|\| ''` uses `\|\|` instead of `??` for string fallback. | Architecture, Bug Hunter, Mock Fidelity | MEDIUM | Change to `deployTx?.hash ?? ''` | 2.8 |
| 17 | Convention | `deploy-commit-reveal.ts:166`, `deploy-multi-path-quoter.ts:122` | `gasUsed?.toString() \|\| '0'` uses `\|\|` instead of `??`. Functionally correct but violates convention. | Architecture, Bug Hunter, Mock Fidelity | MEDIUM | Change to `receipt?.gasUsed?.toString() ?? '0'` | 2.8 |
| 18 | Convention | `scripts/start-local.js:121` | `LOG_LEVEL: process.env.LOG_LEVEL \|\| 'info'` — empty string env var silently replaced. | Architecture | HIGH | Change to `process.env.LOG_LEVEL ?? 'info'` | 2.8 |
| 19 | Convention | `scripts/lib/port-config.js:35` | `envValue \|\| String(defaultValue)` — empty string env var silently falls through. Using `??` would let the existing `parseInt` NaN check produce a helpful error. | Architecture, Mock Fidelity | HIGH | Change to `envValue ?? String(defaultValue)` | 2.8 |
| 20 | Dead Code | 5 deploy scripts | Backward-compat wrapper functions (`saveBalancerDeployment()`, etc.) are unexported and called once each. No external callers. | Performance Reviewer | HIGH | Replace with direct `saveDeploymentResult()` calls. | 2.8 |
| 21 | Duplication | `scripts/lib/` (6 files) | `ROOT_DIR` defined independently in 6 separate files. Should be in `constants.js`. | Performance Reviewer | HIGH | Centralize in `scripts/lib/constants.js`. | 2.8 |
| 22 | Duplication | `validate-router-config.ts:25-33`, `verify-interface-docs.ts:47-55` | Identical ANSI `colors` object duplicated (also exists in `scripts/lib/logger.js`). | Performance Reviewer | HIGH | Extract to shared module or import from logger.js. | 2.8 |
| 23 | Code Smell | 6 deploy scripts (~233 lines total) | Verbose `console.log` "Next Steps" blocks (20-72 lines each). Could use template-based rendering. | Performance Reviewer | HIGH | Create template system in `deployment-utils.ts`. | 2.9 |
| 24 | Data Clump | 4 deploy scripts | `DeploymentConfig` interface repeated 4 times with minor variations. | Performance Reviewer | HIGH | Create `BaseDeploymentConfig` in `deployment-utils.ts`, extend per-protocol. | 2.8 |
| 25 | Convention | `scripts/verify-router-approval.ts:44,53` | `process.env[envKey] \|\| null` — empty string treated as missing. | Bug Hunter | LOW | Change to `process.env[envKey] ?? null` | 2.5 |
| 26 | Performance | `deployment-utils.ts`, `generate-addresses.ts`, etc. | ~70+ sync file I/O operations. Acceptable for CLI scripts but inconsistent in the shared `deployment-utils.ts` library. | Performance Reviewer | HIGH | Convert `deployment-utils.ts` to `fs.promises`. Lower priority for standalone scripts. | 2.3 |
| 27 | Structural | `scripts/lib/utils.js` | 82-line re-export facade. Comment says "prefer importing directly." Could be deprecated. | Performance Reviewer | HIGH | Migrate consumers to direct imports, then deprecate. | 2.2 |
| 28 | Mock Quality | `scripts/lib/__tests__/process-manager.test.js` | Tests use real `child_process.exec` — platform-dependent, non-deterministic. Weak assertion (`typeof result === 'boolean'`). | Mock Fidelity | HIGH | Mock `child_process.exec` for deterministic testing. | 2.0 |

---

## Test Coverage Matrix

### `scripts/lib/` Source Files

| Source File | Functions | Has Test? | Happy | Error | Edge | Notes |
|-------------|-----------|-----------|-------|-------|------|-------|
| `deprecation-checker.js` | 6 exported | YES | All 6 | YES | YES | Excellent |
| `validators.js` | 6 exported | YES | All 6 | YES | YES | Excellent |
| `template-renderer.js` | 3 exported | YES | All 3 | N/A | YES | Excellent (pure functions) |
| `services-config.js` | 16 exported | YES | Most | YES | YES | 5 helpers presence-tested only |
| `process-manager.js` | 8 exported | YES | 4 of 8 | Partial | YES | `findGhostNodeProcesses`, `killTsNodeProcesses`, `parseProcessLines` untested |
| `pid-manager.js` | 10 exported | NO | -- | -- | -- | **HIGH RISK**: File locking, symlink protection |
| `health-checker.js` | 3 exported | NO | -- | -- | -- | HTTP health checks with timeouts |
| `redis-helper.js` | 7 exported | NO | -- | -- | -- | Docker/Redis connectivity |
| `network-utils.js` | 2 exported | NO | -- | -- | -- | TCP/port checking |
| `quality-scorer.js` | 3 exported | NO | -- | -- | -- | Contains `assessImpact` bug (Finding 5) |
| `quality-report-generator.js` | 4 exported | NO | -- | -- | -- | Contains `baselineScore` bug (Finding 15) |
| `port-config.js` | 2 exported | NO (indirect) | Indirect | Indirect | Partial | Tested via services-config.test.js |
| `service-definitions.js` | 4 exported | NO (indirect) | Indirect | -- | -- | Partially validated indirectly |
| `service-validator.js` | 2 exported | NO (indirect) | YES | YES | YES | Tested thoroughly via services-config |
| `constants.js` | 19 constants | NO | N/A | N/A | N/A | Pure constants, no logic |
| `logger.js` | 5 exported | NO | -- | -- | -- | Low risk: console utilities |
| `utils.js` | Re-exports | NO | N/A | N/A | N/A | Facade only |

**Coverage**: 5 of 17 files (29%) have direct tests. 0 of 17 top-level scripts tested. 0 of 15 contracts/scripts tested.

### `contracts/scripts/` Files

| File | LOC | Has Tests? | Risk |
|------|-----|-----------|------|
| `lib/deployment-utils.ts` | 1,242 | NO | **HIGH** — mainnet safety guards, file locking |
| `deploy.ts` | 274 | NO | Medium — mainnet deployment |
| `deploy-balancer.ts` | 308 | NO | Medium |
| `deploy-commit-reveal.ts` | 325 | NO | Medium |
| `deploy-pancakeswap.ts` | 451 | NO | Medium |
| `deploy-syncswap.ts` | 316 | NO | Medium |
| `deploy-multi-path-quoter.ts` | 237 | NO | Medium |
| Other scripts (8) | ~800 | NO | Low-Medium |

---

## Mock Fidelity Matrix

| Test File | Source File | Mock Target | Fidelity | Gaps |
|-----------|------------|-------------|----------|------|
| `deprecation-checker.test.js` | `deprecation-checker.js` | `process.env`, `console.warn` | HIGH | None significant |
| `services-config.test.js` | `services-config.js` | `process.env`, `SKIP_SERVICE_VALIDATION` | HIGH | Relies on real filesystem |
| `template-renderer.test.js` | `template-renderer.js` | None (pure functions) | HIGH | N/A |
| `validators.test.js` | `validators.js` | `fs.existsSync` (real) | HIGH | Uses real filesystem |
| `process-manager.test.js` | `process-manager.js` | `child_process.exec` (real) | MEDIUM | Platform-dependent, non-deterministic |

---

## Cross-Agent Insights

1. **`||` vs `??` is systemic**: 4 of 6 agents independently flagged `||` usage in deploy scripts. The bug hunter traced the cascading data flow (`receipt null → blockNumber 0 → getBlock(0) → timestamp 0 → || replaces with Date.now()`), which is more impactful than just a convention violation. **Findings 4, 16, 17, 18, 19 are all the same root cause.**

2. **`assessImpact()` bug found by two independent agents**: Bug Hunter found the `!baselineScore` logic error (Finding 5) and Test Quality Analyst independently identified the same issue while assessing coverage gaps. This cross-verification increases confidence to HIGH.

3. **Test coverage gaps explain mock fidelity gaps**: Mock Fidelity Validator found no mocking issues in existing tests (they're well-written) but the real problem is that 71% of files have no tests at all. The coverage gap (Finding 2, 3) is more impactful than any individual mock issue.

4. **Security + Architecture alignment on mainnet safety**: Security auditor flagged missing mainnet confirmation (Finding 10) while Architecture auditor independently identified the related duplicate-deployment risk. Both point to the same operational safety gap in deployment workflows.

5. **Duplication enables convention violations**: The 80% duplication across deploy scripts (Finding 7) is the root cause of the systematic `||` vs `??` violations — fixing code in one place propagates; with 6 copies, fixes must be applied 6 times (and were missed).

---

## Recommended Action Plan

**Last updated**: 2026-02-13 (post Phase 3/P3 fix-issues session — all actionable fixes complete)

### Phase 1: Immediate (P1 — reliability and correctness)
- [ ] Fix #1: Reconcile Mempool Detector port 3007 assignment and service definitions *(deferred — requires architectural decision)*
- [ ] Fix #2: Add unit tests for `deployment-utils.ts` (`validateMinimumProfit`, `withRegistryLock`, `approveRouters`) *(deferred — dedicated test session needed)*
- [ ] Fix #3: Add unit tests for `pid-manager.js` (file locking, symlink protection) *(deferred — dedicated test session needed)*

### Phase 2: Next Sprint (P2 — bugs, safety, maintainability)
- [x] Fix #4: Replace `||` with `??` for timestamp, hash, gasUsed in all 6 deploy scripts (18 occurrences)
- [x] Fix #5: Fix `assessImpact()` falsy check: `!baselineScore` → `baselineScore == null`
- [x] Fix #6: Extract `COMMON_TOKEN_PAIRS` to shared `getCommonTokenPairs()` in `pancakeswap-utils.ts` (dynamic from `CORE_TOKENS`)
- [x] Fix #7: Create shared `deployContractPipeline()` — refactored all 6 deploy scripts to thin wrappers (~1,800 → ~867 lines)
- [x] Fix #8: Extract shared PancakeSwap pool discovery utilities into `contracts/scripts/lib/pancakeswap-utils.ts` (221 lines)
- [x] Fix #9: Fix comment/code mismatch in services-config.js:131
- [x] Fix #10: Add mainnet confirmation prompt to all deploy scripts (via shared `confirmMainnetDeployment()` in deployment-utils.ts)
- [x] Fix #11: Add confirmation for toggle-syncswap-pause.ts on mainnet
- [x] Fix #12: Add SIGINT/SIGTERM handlers to start-local.js (with PID tracking and cleanup)
- [x] Fix #13: Add `checkExistingDeployment()` to `deployment-utils.ts` — all deploy scripts check registry before deploying
- [x] Fix #14: Document CommonJS exception in code_conventions.md
- [x] Fix #15: Fix `baselineScore || 'N/A'` → `baselineScore ?? 'N/A'` in quality-report-generator.js (2 locations)

### Phase 3: Backlog (P3 — cleanup and consistency)
- [x] Fix #16: Replace `deployTx?.hash || ''` with `??` in all deploy scripts *(done as part of Fix #4)*
- [x] Fix #17: Replace `gasUsed?.toString() || '0'` with `??` in deploy scripts *(done as part of Fix #4)*
- [x] Fix #18: Replace `LOG_LEVEL || 'info'` with `??` in start-local.js
- [x] Fix #19: Replace `envValue || String(defaultValue)` with `??` in port-config.js
- [x] Fix #20: Remove backward-compat wrapper functions *(resolved by Fix #7 pipeline refactoring — wrappers eliminated)*
- [x] Fix #21: Centralize `ROOT_DIR` in `constants.js` — all 5 files now import from constants
- [x] Fix #22: Extract shared ANSI colors into `contracts/scripts/lib/colors.ts` — 2 TS files updated
- [ ] Fix #23: Template-based "Next Steps" rendering *(deferred — post-refactoring, per-contract steps serve as documentation)*
- [x] Fix #24: Create `DeploymentPipelineConfig` interface *(resolved by Fix #7 — unified config type in deployment-utils.ts)*
- [x] Fix #25: Replace `process.env[envKey] || null` with `??` in verify-router-approval.ts (2 occurrences)
- [ ] Fix #26: Convert sync I/O to `fs.promises` in deployment-utils.ts *(deferred — large scope, CLI scripts work fine with sync I/O)*
- [ ] Fix #27: Deprecate `utils.js` re-export facade *(deferred — 5 consumers, churn exceeds benefit, comment already guides new code)*
- [x] Fix #28: Improve weak test assertions in process-manager.test.js

### Progress Summary
- **Applied**: 22 of 28 fixes (Fix #4-#22, #24, #25, #28 — excluding #1-3, #23, #26, #27)
- **Deferred (P1)**: 3 fixes require dedicated sessions or architectural decisions (#1, #2, #3)
- **Deferred (P3)**: 3 fixes — #23 (template rendering, not worth complexity), #26 (sync→async I/O, too large), #27 (utils.js deprecation, too much churn)
- **Verification**: 126/126 scripts tests passing, contracts compile clean, 466 contract tests passing
- **Completion**: 79% of all findings resolved (22/28)

---

## Positive Security Findings (Already Well-Implemented)

| Practice | Location | Assessment |
|----------|----------|-----------|
| Environment variable filtering before child process spawning | `start-local.js:108-116` | Strong — prevents secret leakage |
| PID integer validation before shell interpolation | `process-manager.js:62-68` | Strong — prevents command injection |
| Symlink attack prevention on PID files | `pid-manager.js:42-59` | Strong — but untested |
| Comprehensive .gitignore for secrets | `.gitignore:8-25` | Strong — covers all common patterns |
| Zero hardcoded secrets across all scripts | All files | Verified clean via grep |
| Production config guards (minimum profit) | `deployment-utils.ts` | Strong — prevents zero-profit mainnet deploys |
| Error selector collision detection | `generate-error-selectors.ts` | Strong — prevents ABI ambiguity |
