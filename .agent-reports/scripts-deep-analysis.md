# Deep Analysis Report: `/scripts/*`

**Date**: 2026-02-11
**Model**: Claude Opus 4.6
**Agents**: 6 specialized agents (architecture, bug-hunter, security, test-quality, mock-fidelity, performance-refactor)
**Scope**: All 32 files in `scripts/` — 12 lib modules, 15 root scripts, 3 test files, 1 template, 1 config

---

## Executive Summary

- **Total findings**: 34 (deduplicated across 6 agents)
- **Critical (P0)**: 5
- **High (P1)**: 8
- **Medium (P2)**: 13
- **Low (P3)**: 8
- **Overall grade**: **C+** — Two scripts are completely non-functional (`start-local.js`, `verify-router-approval.ts`), 75% of lib modules lack tests, and the quality test runner always reports failure. Core architecture is sound but significant reliability gaps exist.

### Top 5 Highest-Impact Issues

1. **`start-local.js` is completely broken** — SyntaxError at parse time (`await` in non-async Promise executor). `npm run dev:start`, `dev:all`, `dev:minimal` all fail.
2. **`verify-router-approval.ts` is non-functional** — imports 2 non-existent exports, ABI selection only handles 2 of 9 protocols.
3. **Quality test runner always exits with failure code** — `overallResult` never set to `'PASSED'`; baseline never saved.
4. **11/42 tests fail in `services-config.test.js`** — Error message assertions don't match refactored validator output.
5. **75% of lib modules have zero test coverage** — PID locking, process management, network utils, health checks all untested.

### Agent Agreement Map

| Area | Agents That Flagged | Agreement |
|------|-------------------|-----------|
| start-local.js broken | Bug Hunter, Security, Test Quality, Performance | 4/6 |
| Port inconsistency (3004 vs 3006) | Architecture, Mock Fidelity | 2/6 |
| services-config.js issues | Architecture, Bug Hunter, Performance, Test Quality | 4/6 |
| P4 Solana optional status | Architecture, Mock Fidelity | 2/6 |
| run-professional-quality-tests.js bugs | Bug Hunter, Performance | 2/6 |
| process-manager.js concerns | Security, Test Quality, Performance | 3/6 |

---

## Critical Findings (P0 — Security/Correctness/Financial Impact)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| C1 | Bug | [start-local.js:120](scripts/start-local.js#L120) | **SyntaxError: `await` in non-async Promise executor.** The FIX P1-2 patch added `await updatePid()` and `await killProcess()` inside a `new Promise((resolve, reject) => {` callback, which is not async. Node.js throws SyntaxError at **parse time** — `npm run dev:start` / `dev:all` / `dev:minimal` are **completely non-functional**. Verified by running `node -e "require('./scripts/start-local.js')"`. | Bug Hunter, Security, Test Quality | HIGH (verified) | Refactor: move PID logic outside Promise constructor. Make executor `async` is discouraged but functional. Best: resolve child from Promise, then `await updatePid()` in outer async function. | 3.8 |
| C2 | Interface | [verify-router-approval.ts:29,31](scripts/verify-router-approval.ts#L29) | **Missing exports: `getFlashLoanContractAddress` and `PANCAKESWAP_FLASH_ARBITRAGE_ABI`** are imported from `@arbitrage/config` but neither exists. Grep confirms 0 definitions outside this file. Script crashes on import. | Mock Fidelity | HIGH (verified) | Create `getFlashLoanContractAddress()` in `shared/config/src/addresses.ts` as a protocol-aware dispatcher. Add `PANCAKESWAP_FLASH_ARBITRAGE_ABI` to `shared/config/src/service-config.ts`. | 3.5 |
| C3 | Logic | [verify-router-approval.ts:86-90](scripts/verify-router-approval.ts#L86) | **ABI selection only handles 2 of 9 protocols.** Binary `if/else` maps `aave_v3` correctly but sends all other protocols (including Balancer V2, SyncSwap, CommitReveal, Jupiter) through PancakeSwap ABI, causing `getApprovedRouters()` calls to fail on Fantom, zkSync, and Solana. | Mock Fidelity | HIGH | Replace with switch/case covering all 9 protocol types from `FLASH_LOAN_PROVIDERS`. | 3.5 |
| C4 | Bug | [run-professional-quality-tests.js:23,78,93](scripts/run-professional-quality-tests.js#L23) | **`overallResult` never set to `'PASSED'`**. Initialized as `'UNKNOWN'` at line 23. Only assignment is `= 'FAILED'` in catch block (line 84). Lines 78, 93, 298, 378 all check for `'PASSED'` but no code path sets it. Result: script **always exits code 1**, baseline never saved, HTML report always shows `'failed'` class. | Bug Hunter | HIGH (verified) | Add `this.results.overallResult = this.results.summary.failedTests === 0 ? 'PASSED' : 'FAILED';` after `calculateFinalQualityScore()` at line 77. | 4.0 |
| C5 | Interface | [error-selectors.generated.ts:34](services/execution-engine/src/strategies/error-selectors.generated.ts#L34) | **Ghost `SwapFailed` error in generated selectors.** Selector `0x81ceff30` mapped to `SwapFailed` but this error does NOT exist in FlashLoanArbitrage.json ABI or any contract source. Execution engine will misidentify revert reasons. File header shows prior manual edits. | Mock Fidelity | HIGH (verified) | Regenerate from ABI: `npm run generate:error-selectors`. Then verify no manual edits needed. | 4.0 |

---

## High Findings (P1 — Reliability/Coverage Impact)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| H1 | Bug | [services-config.test.js](scripts/lib/__tests__/services-config.test.js) (11 tests) | **11/42 tests fail.** Test assertions use old error message format (`'"name" is required'`) but validators.js now produces `'Invalid Service name: expected string, got undefined'`. Confirmed: `npx jest` shows 11 failed, 31 passed. | Bug Hunter, Test Quality | HIGH (verified) | Update all 11 `.toThrow()` substrings to match current validator error format. | 3.3 |
| H2 | Config | [service-ports.json:10](shared/constants/service-ports.json#L10), [docker-compose.partitions.yml:171](infrastructure/docker/docker-compose.partition.yml#L171) | **Port inconsistency: Solana is 3004 in config, 3006 in docker-compose.** Cross-chain detector shows inverse: 3006 in config, 3004 in docker-compose. Comment in cross-chain-detector says "changed from 3004 to 3006" but the change is incomplete. | Architecture, Mock Fidelity | HIGH | Decide canonical ports. Recommended: Solana=3004, Cross-Chain=3006 (match `service-ports.json`). Update `docker-compose.partition.yml` lines 171 and 194 accordingly. | 3.1 |
| H3 | Coverage | scripts/lib/ (9 modules) | **75% of lib modules have zero test coverage.** Untested: `pid-manager.js` (file locking, race conditions), `process-manager.js` (cross-platform kill/find), `network-utils.js` (TCP checks), `health-checker.js` (HTTP health), `redis-helper.js`, `validators.js`, `constants.js`, `logger.js`, and `utils.js`. All FIX P1-1/P1-2/P1-3/P2-1/P3-1 changes are untested. 0/15 root scripts have tests. | Test Quality | HIGH | Priority test files: (1) pid-manager.test.js, (2) network-utils.test.js, (3) process-manager.test.js, (4) health-checker.test.js. ~800 lines of test code needed. | 3.1 |
| H4 | Security | [start-local.js:85-90](scripts/start-local.js#L85) | **`process.env` passthrough exposes all secrets to every service.** `{...process.env, ...service.env}` passes ALL env vars (private keys for 6+ chains, API keys for 7+ providers, auth headers) to every spawned service, violating least-privilege. A single compromised service dependency could exfiltrate all credentials. | Security | MEDIUM | Filter `process.env` to an allowlist per service type. At minimum, strip `*_PRIVATE_KEY` vars from detector services that don't need them. | 3.1 |
| H5 | Config | [services-config.js:328-338](scripts/lib/services-config.js#L328), [CURRENT_STATE.md](docs/architecture/CURRENT_STATE.md) | **Unified Detector: marked active in docs but `enabled: false` in code.** CURRENT_STATE.md lists it as active with port 3007, but services-config has it in `OPTIONAL_SERVICES` with `enabled: false`. Also P4 Solana is optional but documented as core. | Architecture, Mock Fidelity | HIGH | Update CURRENT_STATE.md to categorize services: Core (6), Optional (P4 Solana, Unified Detector), Infrastructure (Redis). Document why each is optional. | 2.8 |
| H6 | Bug | [run-professional-quality-tests.js:314](scripts/run-professional-quality-tests.js#L314) | **Division by zero yields "Infinity"/"NaN" in HTML report.** `totalTests / (executionTime / 1000)` has no guard when `executionTime` is 0. Adjacent `passedPercent` at line 300 has a guard but this line doesn't. | Bug Hunter | HIGH | Add guard: `r.summary.executionTime > 0 ? (...).toFixed(1) : '0.0'`. | 3.7 |
| H7 | Bug | [clean-dist.js:13-29](scripts/clean-dist.js#L13) | **Missing `services/partition-solana/dist` and `services/mempool-detector/dist` from clean list.** Stale build artifacts survive `npm run build:clean`, causing type errors per CLAUDE.md "Common Gotchas". | Bug Hunter | HIGH (verified) | Add both missing entries to `dirsToClean` array. | 3.7 |
| H8 | Config | [CURRENT_STATE.md:21-29](docs/architecture/CURRENT_STATE.md#L21) | **Production port scheme (3011-3016) vs local dev (3001-3007) not documented.** Docs show 3011-3016 as THE ports, but local dev and docker-compose use 3001-3007. HEALTH_CHECK_PORT is always 3001 (internal) regardless of external port. No documentation explains this split. | Architecture | HIGH | Add "Port Mapping Strategies" section to CURRENT_STATE.md explaining local vs production schemes. Document HEALTH_CHECK_PORT=3001 internal convention. | 2.8 |

---

## Medium Findings (P2 — Maintainability/Performance)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| M1 | Security | [start-local.js:98](scripts/start-local.js#L98) | Shell-mode spawn on Windows interpolates `service.script` into command string with `shell: true`. Hardcoded values prevent real exploitation, but use array args with shell for defense-in-depth. | Security | LOW | Use `spawn('npx', [...args, service.script], {shell: true})` even on Windows. | 2.9 |
| M2 | Security | [start-redis-memory.js:70-90](scripts/start-redis-memory.js#L70) | Redis in-memory server starts without authentication. Any local process can read/write operational data. | Security | MEDIUM | Add `requirepass` option to redis-memory-server config. | 2.6 |
| M3 | Refactor | [services-config.js](scripts/lib/services-config.js) (526 lines) | **God Module** — mixes port config, service definitions, validation, deprecation checking, and helper functions. 5 separate concerns in one file. | Performance, Architecture | HIGH | Extract into: `port-config.js`, `service-definitions.js`, `service-validator.js`, keeping `services-config.js` as slim orchestrator. | 2.6 |
| M4 | Bug | [run-professional-quality-tests.js:320-322](scripts/run-professional-quality-tests.js#L320) | `\|\| 0` instead of `?? 0` for numeric values per code conventions. No behavioral difference here but violates codebase standard. | Bug Hunter | HIGH | Change to `?? 0`. | 3.7 |
| M5 | Config | [services-config.js:493-497](scripts/lib/services-config.js#L493) | Module-load validation prevents importing ANY utility if one service has bad config. Tests must set `SKIP_SERVICE_VALIDATION=true`. | Architecture | MEDIUM | Move validation to explicit `validateAllServices()` call in startup scripts, not at module load. | 2.6 |
| M6 | Coverage | [error-selectors.generated.ts](services/execution-engine/src/strategies/error-selectors.generated.ts) | Duplicate `InvalidSwapPath` error in ABI (defined in both BaseFlashArbitrage and SwapHelpers). Also `InvalidOwnerAddress` defined in base contract but missing from ABI/selectors. 90% selector coverage (18/20). | Mock Fidelity | MEDIUM | Define shared errors in interface. Verify `InvalidOwnerAddress` reachability. Regenerate selectors. | 2.5 |
| M7 | Config | [service-config.ts:443](shared/config/src/service-config.ts#L443) | `FLASH_LOAN_PROVIDERS` type lacks `approvedRouters` field. `verify-router-approval.ts:95` falls back to `[]`, making config-vs-contract comparison useless. | Mock Fidelity | MEDIUM | Add `approvedRouters?: string[]` to provider config type. Populate per chain. | 2.5 |
| M8 | Refactor | [process-manager.js](scripts/lib/process-manager.js) | 7 `exec()` callbacks repeat identical error handling pattern. Extract `execWithFallback()` wrapper. ~80 lines reducible to ~20. | Performance | HIGH | Extract shared wrapper function. | 2.7 |
| M9 | Config | [constants.js:52-56](scripts/lib/constants.js#L52) | Deprecated `SERVICE_STARTUP_TIMEOUT_SEC` still exported. Migration complete (all callers use `SERVICE_STARTUP_MAX_ATTEMPTS`). | Architecture, Test Quality | HIGH | Verify no callers remain, then remove. | 3.1 |
| M10 | Bug | [start-redis-memory.js:150](scripts/start-redis-memory.js#L150) | Missing `.catch()` on async `main()`. Inconsistent with `stop-local.js`, `status-local.js`, `cleanup-services.js` which all have `.catch()`. | Bug Hunter | MEDIUM | Add `.catch(error => { log(error.message, 'red'); process.exit(1); })`. | 3.1 |
| M11 | Refactor | [run-professional-quality-tests.js](scripts/run-professional-quality-tests.js) (401 lines) | Three nearly identical test runner methods (unit/integration/performance). Large HTML template generation. Could be split into test-runner, quality-scorer, report-generator modules. | Performance | HIGH | Extract utilities. 401 -> ~180 lines in main file. | 2.5 |
| M12 | Security | [process-manager.js:36-46,56-80](scripts/lib/process-manager.js#L36) | PID and port values interpolated into `exec()` shell commands without point-of-use integer validation. Current callers pass validated values, but defense-in-depth recommends `parseInt` guards. | Security | LOW | Add `pid = parseInt(pid, 10); if (isNaN(pid) || pid <= 0) return false;` at top of `killProcess`/`processExists`. | 2.3 |
| M13 | Config | package.json, services-config.js | Docker-compose vs npm scripts use inconsistent service naming: `partition-asia-fast` vs `asia` vs `P1_ASIA_FAST` vs `P1 Asia-Fast Detector`. Not documented. | Architecture | HIGH | Document naming conventions in a clear table. | 2.2 |

---

## Low Findings (P3 — Style/Minor Improvements)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| L1 | Security | [preinstall-check.js:131](scripts/preinstall-check.js#L131) | `SKIP_PREINSTALL_CHECK=true` bypasses all supply chain detection. Log prominent warning when skipped. | Security | LOW | Log warning, consider more specific bypass value. | 2.0 |
| L2 | Security | [template-renderer.js:28-33](scripts/lib/template-renderer.js#L28) | Template interpolation lacks HTML entity encoding. Stored XSS if test output contains `<script>` tags in HTML report. | Security | LOW | Add `escapeHtml()` for non-HTML placeholder values. | 1.8 |
| L3 | Security | [pid-manager.js:27-28](scripts/lib/pid-manager.js#L27) | PID/lock files at predictable paths. Theoretical symlink attack on shared systems. Mitigated by atomic write pattern. | Security | LOW | Check `fs.lstatSync()` for symlinks before writing. Very low priority. | 1.5 |
| L4 | Refactor | [start-local.js:142-158](scripts/start-local.js#L142) | Duplicated stdout/stderr stream processing. Extract `processStreamLines()` utility. | Performance | HIGH | Extract to `lib/stream-utils.js`. | 2.5 |
| L5 | Refactor | [pid-manager.js:126-176](scripts/lib/pid-manager.js#L126) | `updatePid` and `removePid` duplicate lock-acquire/try/finally/release. Extract `withPidLock(operation)` wrapper. | Performance | HIGH | DRY improvement, ~35% reduction. | 2.3 |
| L6 | Config | [generate-error-selectors.ts:14](scripts/generate-error-selectors.ts#L14) | Hard-coded line reference `base.strategy.ts:1934` may be outdated. Use function name reference instead. | Architecture | MEDIUM | Change to `@see parseRevertReason() in base-strategy.ts`. | 2.0 |
| L7 | Style | scripts/ (multiple files) | Emoji usage inconsistent. TS scripts use emoji (`🔧`, `❌`), JS scripts use ANSI colors. Logging mixes modern semantic interface with legacy color-based interface. | Architecture, Performance | HIGH | Standardize on one approach. Document in style guide. | 1.8 |
| L8 | Config | [docker-compose.partition.yml](infrastructure/docker/docker-compose.partition.yml) | `platform: linux/arm64` limits to Apple Silicon. Intentional but not documented for other platforms. | Architecture | HIGH | Document that this is Apple Silicon-specific. | 1.5 |

---

## Test Coverage Matrix

| Source Module | Total Exports | Tested | Untested | Coverage | Priority |
|---------------|--------------|--------|----------|----------|----------|
| [constants.js](scripts/lib/constants.js) | 18 | 0 | 18 | 0% | Low (simple values) |
| [logger.js](scripts/lib/logger.js) | 8 | 0 | 8 | 0% | Low (I/O utility) |
| [network-utils.js](scripts/lib/network-utils.js) | 2 | 0 | 2 | 0% | **Critical** |
| [process-manager.js](scripts/lib/process-manager.js) | 6 | 0 | 6 | 0% | **Critical** |
| [pid-manager.js](scripts/lib/pid-manager.js) | 5 | 0 | 5 | 0% | **Critical** |
| [health-checker.js](scripts/lib/health-checker.js) | 3 | 0 | 3 | 0% | **High** |
| [redis-helper.js](scripts/lib/redis-helper.js) | 6 | 0 | 6 | 0% | Medium |
| [validators.js](scripts/lib/validators.js) | 6 | 0 | 6 | 0% | Medium |
| [deprecation-checker.js](scripts/lib/deprecation-checker.js) | 4 | 4 | 0 | ~95% | Done |
| [services-config.js](scripts/lib/services-config.js) | ~8 | ~3 | ~5 | ~40% | Medium (11 tests broken) |
| [template-renderer.js](scripts/lib/template-renderer.js) | 2 | 2 | 0 | ~90% | Done |
| [utils.js](scripts/lib/utils.js) | re-export | — | — | N/A | N/A |
| **Root scripts (15)** | — | 0 | 15 | **0%** | Low (integration) |

---

## Cross-Agent Insights

1. **C1 + H3 + M1**: Bug Hunter found `start-local.js` is broken (SyntaxError), Security found the same code has shell injection risk on Windows, Test Quality confirmed 0% test coverage, and Performance flagged the stream processing duplication — all in the same file. The FIX P1-2 patch that introduced the SyntaxError was never tested because the module has no tests.

2. **C2 + C3 + M7**: Mock Fidelity found `verify-router-approval.ts` imports 2 non-existent exports AND has broken ABI selection. These are compounding — even if the missing exports were added, the protocol selection logic would still fail for 7 of 9 chains. The missing `approvedRouters` config field means the script can't compare config vs on-chain state even when working.

3. **H1 + M5**: Bug Hunter found 11 tests fail due to error message mismatches. Architecture Auditor found the module-load validation forces `SKIP_SERVICE_VALIDATION=true` in tests, which masks the actual validation. Both stem from the P2-1 validators extraction that changed error message formats without updating test assertions.

4. **H2 + H5 + H8**: Architecture found port inconsistencies (3004/3006), service status contradictions (Unified Detector active in docs, disabled in code), and undocumented port scheme split. These are all documentation drift from architecture evolution — the system grew but docs and configs weren't synchronized.

5. **C4 + H6 + M4 + M11**: Bug Hunter found 3 separate bugs in `run-professional-quality-tests.js` (overallResult, division by zero, `||` vs `??`). Performance flagged it as oversized (401 lines) with duplicated test runner methods. The file needs both bug fixes and structural cleanup.

6. **C5 + M6**: Mock Fidelity found the ghost `SwapFailed` error in generated selectors AND the missing `InvalidOwnerAddress` error — resulting in only 90% error selector coverage. The generated file has manual edits (per its header comment), suggesting the generation script needs improvement to handle all contracts.

---

## Recommended Action Plan

### Phase 1: Immediate (P0 — Fix before any development work)

- [ ] **C1**: Fix `start-local.js:120` — refactor `await` out of Promise executor. This blocks ALL local development.
- [ ] **C4**: Fix `run-professional-quality-tests.js:77` — add `overallResult = failedTests === 0 ? 'PASSED' : 'FAILED'`.
- [ ] **H1**: Fix 11 test assertions in `services-config.test.js` to match current validator error format.
- [ ] **C5**: Regenerate error selectors (`npm run generate:error-selectors`) to remove ghost `SwapFailed`.
- [ ] **H7**: Add `services/partition-solana/dist` and `services/mempool-detector/dist` to `clean-dist.js`.

### Phase 2: Next Sprint (P1 — Reliability & correctness)

- [ ] **C2**: Create `getFlashLoanContractAddress()` in `shared/config/src/addresses.ts`.
- [ ] **C2**: Add `PANCAKESWAP_FLASH_ARBITRAGE_ABI` to `shared/config/src/service-config.ts`.
- [ ] **C3**: Fix ABI selection in `verify-router-approval.ts` to handle all 9 protocols.
- [ ] **H2**: Resolve port inconsistency — align `docker-compose.partition.yml` with `service-ports.json` (Solana=3004, Cross-Chain=3006).
- [ ] **H4**: Filter `process.env` in `start-local.js` — strip `*_PRIVATE_KEY` from non-execution services.
- [ ] **H6**: Add division-by-zero guard in `run-professional-quality-tests.js:314`.
- [ ] **H8**: Document port mapping strategies in CURRENT_STATE.md.
- [ ] **H5**: Update CURRENT_STATE.md to reflect Core vs Optional service categories.

### Phase 3: Backlog (P2/P3 — Coverage, refactoring, hardening)

- [ ] **H3**: Write test files: `pid-manager.test.js`, `network-utils.test.js`, `process-manager.test.js`, `health-checker.test.js` (~800 LOC).
- [ ] **M3**: Modularize `services-config.js` (526 lines → 3-4 focused modules).
- [ ] **M5**: Move module-load validation to explicit call.
- [ ] **M6**: Fix duplicate `InvalidSwapPath` error, verify `InvalidOwnerAddress` coverage.
- [ ] **M7**: Add `approvedRouters` field to `FLASH_LOAN_PROVIDERS` config.
- [ ] **M8**: Extract `execWithFallback()` wrapper in `process-manager.js`.
- [ ] **M9**: Remove deprecated `SERVICE_STARTUP_TIMEOUT_SEC`.
- [ ] **M10**: Add `.catch()` to `start-redis-memory.js` main().
- [ ] **M11**: Split `run-professional-quality-tests.js` into focused modules.
- [ ] **M12**: Add `parseInt` guards to `killProcess`/`processExists`.

---

## Confidence Calibration Notes

- **C1 (start-local.js SyntaxError)**: Verified by running `node -e "require('./scripts/start-local.js')"` — confirmed parse error.
- **C4 (overallResult)**: Verified via grep — only assignment is `= 'FAILED'` in catch block. No PASSED path exists.
- **H1 (11 test failures)**: Verified via `npx jest` — 11 failed, 31 passed, 42 total.
- **C2 (missing exports)**: Verified via grep — `getFlashLoanContractAddress` and `PANCAKESWAP_FLASH_ARBITRAGE_ABI` not defined in `shared/config/`.
- **C5 (SwapFailed ghost)**: Verified via grep — exists in generated file and test, NOT in any contract source or ABI.
- **Security findings (M1, M2, M12)**: Marked LOW-MEDIUM confidence because current defenses (hardcoded values, parseInt validation) prevent real exploitation. Recommended as defense-in-depth.
- **Architecture findings (H2, H5, H8)**: HIGH confidence — verified against actual config files and documentation.

---

*Report generated by 6-agent deep analysis team. Total analysis: ~460K tokens across agents.*
