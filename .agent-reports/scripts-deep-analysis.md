# Deep Analysis Report: `scripts/`

**Date**: 2026-02-17
**Scope**: `scripts/` folder (~40 files, ~7,900 lines)
**Agents**: 6 specialized agents in parallel (architecture, bugs, security, test quality, mock fidelity, performance/refactoring)
**Grade**: **B+**

---

## Executive Summary

- **Total findings**: 32 unique (after deduplication from 52 raw findings across 6 agents)
- **By severity**: 0 Critical | 3 High | 12 Medium | 13 Low | 4 Dead Code
- **Top 3 issues**:
  1. Reports saved with `overallResult: 'UNKNOWN'` because save runs before result is computed (BUG-009)
  2. `setup-env.js` overwrites `.env` from `.env.local`, contradicting the documented layered env priority model (BUG-012 + ARCH-007)
  3. 71% of `scripts/lib/` modules have zero test coverage, including critical `pid-manager.js` (TEST-006)
- **Agent agreement**: 6 findings independently confirmed by 2+ agents (marked with cross-references below)
- **Security posture**: Good — no critical vulnerabilities, deliberate defenses (symlink checks, env filtering, secret masking)
- **Mock fidelity**: A- — minimal mocking, real module behavior tested, all parameters match real system values

---

## Critical Findings (P0)

None.

---

## High Findings (P1 — Correctness/Reliability)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| 1 | Bug / Logic | `run-professional-quality-tests.js:93` | **Reports saved before result computed.** `saveReports()` runs at line 93 while `overallResult` is still `'UNKNOWN'`. The actual PASSED/FAILED is set at lines 96-100. All saved JSON/HTML reports always contain `overallResult: 'UNKNOWN'`. | Bug Hunter | HIGH | 4.1 |
| 2 | Bug / Logic | `run-professional-quality-tests.js:177-180` | **Dead code in quality score parsing.** `parseTestOutput()` extracts `qualityScore` from stdout via regex, but `calculateQualityScore()` always overwrites it afterward. The regex extraction is never effective. | Bug Hunter | HIGH | 3.8 |
| 3 | Bug / XSS | `quality-report-generator.js:70-79` | **HTML injection in quality reports.** `buildTemplateData()` interpolates `tr.suite`, `tr.result`, and recommendations into HTML strings without `escapeHtml()`, then uses triple-brace `{{{raw}}}` in template. Malicious test names would render as HTML. Low practical risk (local dev report) but violates defense-in-depth. | Bug Hunter + Security | HIGH | 3.5 |

---

## Medium Findings (P2 — Reliability/Documentation/Coverage)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| 4 | Bug / UX | `setup-env.js:21-53` | **Overwrites `.env` from `.env.local`** without confirmation, contradicting the documented layered override model. Makes both files identical, eliminating layering benefit. | Bug Hunter + Architecture | HIGH | 4.0 |
| 5 | Doc Mismatch | `docs/local-development.md:179-199` | **Env priority documentation is wrong.** Docs say system env vars have "highest priority if set." Actually `.env.local` with `override: true` wins over system env vars. Real priority: `.env.local` > system env > `.env` > defaults. | Architecture | HIGH | 3.8 |
| 6 | Test Coverage | All `scripts/lib/` | **71% of lib modules untested.** 12 of 17 source files have zero test coverage. `pid-manager.js` (file locking, symlink checks, atomic PID ops) is the highest-risk gap. | Test Quality + Mock Fidelity | HIGH | 3.7 |
| 7 | Race Condition | `start-redis-memory.js:107-123` | **Double-cleanup race.** `cleanupAndExit` registered for both SIGINT and SIGTERM with no `if (shuttingDown) return;` guard. Dual signals cause `redisServer.stop()` called twice. | Bug Hunter | HIGH | 3.7 |
| 8 | Race Condition | `start-local.js:331-398` | **Async cleanup with no timeout.** `cleanupOnInterrupt()` awaits multiple async ops (killProcess, killAllPids, findProcessesByPort). If any hang (e.g., `tasklist` on Windows), the process never exits. No safety timeout. | Bug Hunter | MEDIUM | 3.5 |
| 9 | Bug / Logic | `security-audit.js:254-256` | **Return values ignored.** `checkLockfile()` and `checkOverrides()` return success/failure booleans, but callers discard them. Insecure HTTP registries found by `checkLockfile()` don't affect exit code. | Bug Hunter | HIGH | 3.5 |
| 10 | Test Quality | `services-config.test.js:127-136` | **Helper functions only type-checked.** `getServiceByName`, `getServiceByPort`, `getStatusServices`, `getStartupServices`, `getCleanupPorts` are checked as `typeof === 'function'` but never called with args. A bug in lookup logic would pass all tests. | Test Quality + Mock Fidelity | HIGH | 3.5 |
| 11 | Doc Mismatch | Multiple sources | **Service count disagreement.** CURRENT_STATE.md says 9, CLAUDE.md says 8, service-definitions.js has 7 (6 core + 1 optional). Mempool Detector vs Unified Detector naming conflict at port 3007. | Architecture | HIGH | 3.4 |
| 12 | Architecture | `service-definitions.js:55-115` | **P4 Solana missing from CORE_SERVICES.** `dev:all` starts P4 via npm, but `start-local.js` (via `getStartupServices()`) does not. `dev:start` and `dev:all` start different service sets without documentation. | Architecture | HIGH | 3.4 |
| 13 | Doc Mismatch | `package.json:91` | **dev:all starts 7 services, docs say 6.** P4 Solana was added to `dev:all` concurrently command but docs/CLAUDE.md still say "6 core services." | Architecture | HIGH | 3.3 |
| 14 | Security | `redis-helper.js:36` | **Docker container name injection potential.** `exec(\`docker ps --filter "name=${containerName}"\`)` interpolates param into shell string. Currently hardcoded callers only, but exported function accepts arbitrary strings. | Bug Hunter + Security | MEDIUM | 3.2 |
| 15 | Bug / Edge | `pid-manager.js:148-151` | **No cleanup on rename failure.** `savePids()` writes temp file then `renameSync()`. If rename fails (permissions, antivirus), temp file is orphaned and PID file not updated. No try/catch around rename. | Bug Hunter | MEDIUM | 3.0 |

---

## Low Findings (P3 — Minor Improvements)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| 16 | Bug / Info Leak | `generate-error-selectors.ts:133` | **Absolute path in generated file.** `Source: ${ABI_PATH}` includes developer's username and directory structure in committed file. Use `path.relative()` instead. | Bug Hunter | HIGH | 3.5 |
| 17 | Security | `preinstall-check.js:131-137` | **SKIP_PREINSTALL_CHECK bypass.** Env var `=true` disables all supply chain protection. Consider requiring a more specific value or audit-logging the bypass. | Security | MEDIUM | 3.2 |
| 18 | Race Condition | `redis-helper.js:111-115` | **TOCTOU in deleteRedisMemoryConfig.** `existsSync()` then `unlinkSync()` — file could be deleted between check and delete. Use try/catch + ignore ENOENT. | Bug Hunter | HIGH | 3.0 |
| 19 | Test Quality | `service-validator.js:131-144` | **`validateAllServices()` untested.** Calls `process.exit(1)` on failure; this behavior is never verified in tests. | Test Quality | HIGH | 3.0 |
| 20 | Inconsistency | `stop-redis.js:110` vs `run-docker-compose.js:55` | **Docker Compose command order reversed.** stop-redis tries `docker-compose` first; run-docker-compose tries `docker compose` first. | Architecture | HIGH | 2.8 |
| 21 | Doc Mismatch | `CLAUDE.md:76-77` | **Non-existent npm script.** CLAUDE.md lists `verify:router-approval`; actual script is `validate:routers`. | Architecture | HIGH | 2.8 |
| 22 | Refactoring | `clean-dist.js:13-31` | **19 hardcoded dist paths.** Adding a service requires updating this list. Could dynamically scan `*/dist` directories. | Performance/Refactor | HIGH | 3.4 |
| 23 | Refactoring | `preinstall-check.js:69-71`, `security-audit.js:76-78` | **Duplicate `log()` function.** Both define identical `log(message, color)` instead of importing from logger.js. | Performance/Refactor | HIGH | 3.9 |
| 24 | Consistency | `setup-env.js:16`, `validate-build.js:23`, `clean-dist.js:10` | **ROOT_DIR defined 3 times** instead of importing from constants.js. All resolve to project root but via different `__dirname` traversals. | Architecture + Performance/Refactor | HIGH | 3.5 |
| 25 | Consistency | `start-redis-memory.js` | **Legacy `log()` throughout.** 15+ calls to `log(msg, 'color')` instead of `logger.*()` semantic methods used in other scripts. | Performance/Refactor | HIGH | 3.2 |
| 26 | Code Smell | `generate-error-selectors.ts:170` | **Fragile `in` operator.** `isKnownErrorSelector()` uses `in` to check map keys; works only because ethers v6 `keccak256` returns lowercase. Inconsistent with `getErrorName()` which uses bracket access. | Bug Hunter | MEDIUM | 2.8 |
| 27 | Architecture | `clean-dist.js:29` | **Orphaned mempool-detector** referenced in dist cleanup but absent from service-definitions. | Architecture + Performance/Refactor | HIGH | 2.5 |
| 28 | Architecture | `generate-error-selectors.ts:25-28` | **Only reads FlashLoanArbitrage ABI**, not all 5 derived contracts. Custom errors in derived contracts would be missed. | Architecture | MEDIUM | 2.5 |

---

## Dead Code

| # | File:Line | What | Why Dead | Agent(s) |
|---|-----------|------|----------|----------|
| D1 | `process-manager.js:211-222` | `parsePowerShellProcessJson()` | Not exported, not called. Likely remnant from before pipe-delimited format. | Test Quality + Performance/Refactor |
| D2 | `deprecation-checker.js:115-119` | `checkAndWarn()` | Exported but never imported. `services-config.js` has its own `checkAndPrintDeprecations()`. | Test Quality + Mock Fidelity + Performance/Refactor |
| D3 | `validators.js:78-98` | `parseAndValidatePort()` | Only used in its own test file. `port-config.js` uses its own `parsePort()`. | Performance/Refactor |
| D4 | `validators.js:206-222` | `validateFileExists()` | Only used in its own test file. `service-validator.js` does inline `fs.existsSync()`. | Performance/Refactor |

---

## Test Coverage Matrix

| Source File | Lines | Test File | Est. Coverage | Risk |
|-------------|-------|-----------|---------------|------|
| services-config.js | 168 | services-config.test.js (503 lines) | ~90% | Low |
| deprecation-checker.js | 128 | deprecation-checker.test.js (337 lines) | ~85% | Low |
| process-manager.js | 331 | process-manager.test.js (235 lines) | ~80% | Low |
| template-renderer.js | 64 | template-renderer.test.js (156 lines) | ~95% | Low |
| validators.js | 242 | validators.test.js (153 lines) | ~90% | Low |
| **pid-manager.js** | **245** | **None** | **0%** | **Critical** |
| **redis-helper.js** | **134** | **None** | **0%** | **High** |
| **health-checker.js** | **112** | **None** | **0%** | **High** |
| **network-utils.js** | **102** | **None** | **0%** | **High** |
| service-definitions.js | 226 | None (indirect via services-config) | ~30% | Medium |
| port-config.js | 90 | None (indirect via services-config) | ~40% | Medium |
| service-validator.js | 149 | None (indirect via services-config) | ~50% | Medium |
| logger.js | 291 | None | 0% | Low |
| constants.js | 226 | None | 0% (pure data) | Low |
| utils.js | 77 | None (re-exports) | N/A | Low |
| quality-scorer.js | 103 | None | 0% | Low |
| quality-report-generator.js | 172 | None | 0% | Low |

**File coverage**: 5/17 (29%) with direct tests | **Overall assessment**: Existing tests are high quality (A-) but coverage is thin.

---

## Mock Fidelity Matrix

| Test File | Source File | What's Mocked | Fidelity | Issues |
|-----------|------------|---------------|----------|--------|
| services-config.test.js | services-config.js | console.warn, process.env | 5/5 | Helper functions only type-checked |
| deprecation-checker.test.js | deprecation-checker.js | process.env only | 5/5 | checkAndWarn() not tested |
| process-manager.test.js | process-manager.js | Nothing | 5/5 | Kill phase logic untested |
| template-renderer.test.js | template-renderer.js | Nothing | 5/5 | None |
| validators.test.js | validators.js | Nothing | 5/5 | None |

**Overall mock fidelity: A-**. Tests avoid mocking in favor of real module behavior. All test parameters match real system values from `shared/constants/`.

---

## Cross-Agent Insights

1. **BUG-012 + ARCH-007**: Bug Hunter found that `setup-env.js` overwrites `.env` from `.env.local`. Architecture Auditor independently found the docs describe a different priority model. Root cause: the setup script was written to "copy" rather than "layer" env files.

2. **BUG-002 + SEC-001**: Both Bug Hunter and Security Auditor flagged Docker container name injection in `redis-helper.js:36`. Agreement that current callers are safe (hardcoded), but the exported function API is dangerous.

3. **BUG-003 + SEC-006**: Both agents flagged XSS in `quality-report-generator.js`. The template renderer has proper escaping infrastructure, but the data preparation step bypasses it entirely.

4. **TEST-001 + MOCK-005**: Both Test Quality and Mock Fidelity agents found that `services-config.test.js` helper functions are only existence-tested. This is the most impactful test quality gap — a bug in service lookup logic would go undetected.

5. **Dead code triple-confirmation**: `parsePowerShellProcessJson` was flagged by Test Quality (dead code), Performance/Refactor (dead code), and implicitly by Bug Hunter (not in scope since it's unreachable). Three independent agents confirmed it's dead.

6. **ARCH-003 + ARCH-002**: P4 Solana's absence from `CORE_SERVICES` (Architecture) explains why docs say "6 services" — the scripts definition and the docs are consistent with each other but inconsistent with `dev:all` which actually starts 7.

---

## Recommended Action Plan

### Phase 1: Immediate (P1 — bugs with user-visible impact)

- [ ] **Fix #1**: Move `saveReports()` after `overallResult` is set in `run-professional-quality-tests.js:93-100`
- [ ] **Fix #2**: Remove dead regex extraction in `run-professional-quality-tests.js:177-180`
- [ ] **Fix #3**: Apply `escapeHtml()` to interpolated values in `quality-report-generator.js:70-79`
- [ ] **Fix #4**: Add double-invocation guard to `start-redis-memory.js:cleanupAndExit`
- [ ] **Fix #16**: Use `path.relative()` in `generate-error-selectors.ts:133` to avoid absolute path leak

### Phase 2: Next Sprint (P2 — reliability and documentation)

- [ ] **Fix #4**: Rewrite `setup-env.js` to only copy `.env.example` -> `.env` (not `.env.local` -> `.env`)
- [ ] **Fix #5**: Correct env priority documentation in `docs/local-development.md:179-199`
- [ ] **Fix #8**: Add `setTimeout(() => process.exit(130), 10000)` safety net to `start-local.js:cleanupOnInterrupt`
- [ ] **Fix #9**: Incorporate `checkLockfile()`/`checkOverrides()` results into exit code in `security-audit.js`
- [ ] **Fix #11/13**: Reconcile service counts across CURRENT_STATE.md, CLAUDE.md, and service-definitions.js
- [ ] **Fix #12**: Add P4 Solana to CORE_SERVICES or document the `dev:start` vs `dev:all` difference
- [ ] **Fix #14**: Validate `containerName` against `/^[a-zA-Z0-9_.-]+$/` in `redis-helper.js:36`
- [ ] **Fix #15**: Add try/catch around `renameSync` in `pid-manager.js:148-151`
- [ ] **Fix #21**: Update CLAUDE.md npm script name from `verify:router-approval` to `validate:routers`

### Phase 3: Backlog (P3 — tests, refactoring, cleanup)

- [ ] **Tests**: Add test files for pid-manager.js, redis-helper.js, health-checker.js, network-utils.js
- [ ] **Tests**: Add behavior assertions for helper functions in services-config.test.js (#10)
- [ ] **Tests**: Test `validateAllServices()` process.exit behavior (#19)
- [ ] **Dead code**: Remove D1-D4 (parsePowerShellProcessJson, checkAndWarn, parseAndValidatePort, validateFileExists)
- [ ] **Refactoring**: Centralize ROOT_DIR imports (#24), remove duplicate log() (#23)
- [ ] **Refactoring**: Make clean-dist.js dist paths dynamic (#22)
- [ ] **Consistency**: Unify Docker Compose command order (#20)
- [ ] **Consistency**: Migrate start-redis-memory.js to logger semantic methods (#25)
