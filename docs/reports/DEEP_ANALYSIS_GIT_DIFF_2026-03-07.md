# Deep Analysis: Git Diff (2026-03-07)

**Scope**: All uncommitted changes (`git diff`) — 39 files, +1013/-2585 lines
**Method**: 6-agent team (2 opus general-purpose + 4 haiku Explore) + team lead synthesis
**Agents**: architecture-auditor, bug-hunter, security-auditor, test-quality-analyst, mock-fidelity-validator, performance-reviewer — all reported findings successfully

## Executive Summary

- **Findings**: 0 Critical / 5 High / 8 Medium / 7 Low — **20 total**
- **Overall Grade**: **B** (well-implemented SSE and proxy with good security posture, but significant test coverage gaps, missing production auth guard on SSE, and undocumented endpoints)
- **Top 5 Issues**:
  1. **H-01**: SSE endpoint missing production auth enforcement — silently allows unauthenticated access if `DASHBOARD_AUTH_TOKEN` unset
  2. **H-02**: Zero unit tests for proxyToEE(), SSE system, getCircuitBreakerSnapshot() (~150 lines untested)
  3. **H-03**: SM-013 pipelineTimestamps deserialization untested at coordinator level
  4. **H-04**: New coordinator endpoints undocumented in API.md (SSE, EE proxy, CB proxy)
  5. **H-05**: SSE auth token in URL query string — credential leakage via server/proxy logs
- **Agent agreement map**: Security + Architecture independently confirmed CORS, SSE connection limits, and cleanup are correct. Bug-hunter + Performance independently confirmed `|| undefined` is a convention violation. Test-quality + Mock-fidelity independently confirmed CB mock gaps.

## Key Changes Analyzed

| Component | Files | Summary |
|-----------|-------|---------|
| SSE System | coordinator.ts, sse.routes.ts | `sseListeners` Set, `emitSSE()`, `subscribeSSE()`, `getCircuitBreakerSnapshot()` |
| EE Proxy | routes/index.ts | `proxyToEE()` with 1MB limit, 5s timeout, auth on POST |
| Pipeline Timestamps | opportunity-router.ts | SM-013: deserialize `pipelineTimestamps` JSON from stream |
| HMAC Rename | streams.ts, .env.example | `LEGACY_HMAC_COMPAT` → `STREAM_LEGACY_HMAC_COMPAT` |
| MAXLEN Increase | streams.ts | exec-results 25K → 100K |
| Dashboard UI | dashboard/* | Theme overhaul (Obsidian theme, JetBrains Mono/Manrope fonts) |
| Fly.io Config | cross-chain-detector.toml | Added `/ready` healthcheck |
| CORS | middleware/index.ts | Added `X-API-Key` to allowed headers |

---

## High Findings (P1)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix |
|---|----------|-----------|-------------|----------|------------|---------------|
| H-01 | Security | sse.routes.ts:25 | **SSE missing production auth enforcement**: Unlike `dashboard.routes.ts` which throws at startup in production without `DASHBOARD_AUTH_TOKEN`, `sse.routes.ts` silently allows unauthenticated access. If token is unset, ALL SSE data streams without auth: execution results (profit, gas, tx hash), alerts, metrics, service health, stream health, CB state. | security-auditor | HIGH (95%) | Add startup guard: `if (process.env.NODE_ENV === 'production' && !dashboardAuthToken) throw new Error('DASHBOARD_AUTH_TOKEN required for SSE')` |
| H-02 | Test Coverage | routes/index.ts:111-164, coordinator.ts:2708-2760, sse.routes.ts | **Zero unit tests** for proxyToEE() (5 error paths: timeout, unreachable, too large, invalid JSON, connection lost), subscribeSSE(), emitSSE(), getCircuitBreakerSnapshot() (3 states: CLOSED/OPEN/HALF_OPEN), SSE route (auth, connection limit, cleanup). ~150+ lines new code, 0 tests. | test-quality, team-lead | HIGH (100%) | Create `routes/index.routes.test.ts` (mock http.request, 5 error paths), `sse.routes.test.ts` (auth, limits, intervals, cleanup), coordinator SSE tests. |
| H-03 | Test Coverage | opportunity-router.ts:579-596 | **SM-013 pipelineTimestamps deserialization untested at coordinator level**. The EE consumer has tests (`opportunity.consumer.bugfixes.test.ts:1029`) for the same pattern, but the coordinator's path in `processOpportunity` is untested. Missing: valid JSON string, malformed JSON, missing field, non-string type. | test-quality, team-lead | HIGH (100%) | Add 4 test cases in `opportunity-router.test.ts` covering all 4 scenarios. |
| H-04 | Documentation | docs/architecture/API.md | **New coordinator endpoints undocumented**: `/api/events` (SSE with token auth, event types, intervals), `/ee/health` (EE proxy GET), `/circuit-breaker` (CB proxy GET/POST). API.md only documents EE's native endpoints. No ADR for SSE architecture decision. | architecture-auditor, team-lead | HIGH (95%) | Add "Coordinator Proxy Endpoints" and "SSE Events" sections to API.md. Consider ADR-041 for SSE design rationale. |
| H-05 | Security | sse.routes.ts:26 | **SSE auth token in URL query string**: `req.query.token` leaks to server access logs, reverse proxy logs, CDN logs, and browser history. Comment explains "EventSource can't set headers" — this is a real API limitation. | security-auditor | HIGH (90%) | (a) Use a separate lower-privilege SSE-only token, (b) document log scrubbing requirement, or (c) use fetch-based SSE polyfill supporting headers. |

## Medium Findings (P2)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix |
|---|----------|-----------|-------------|----------|------------|---------------|
| M-01 | Bug | coordinator.ts:1985 | **`\|\| undefined` for latencyMs**: `getNumber(rawResult, 'latencyMs', 0) \|\| undefined` converts valid 0ms latency to `undefined`. Violates `??` convention (CLAUDE.md). | bug-hunter, team-lead | HIGH (95%) | Remove `\|\| undefined` (always send latencyMs), or use sentinel: `const lat = getNumber(rawResult, 'latencyMs', -1); latencyMs: lat >= 0 ? lat : undefined`. |
| M-02 | Security | routes/index.ts:167-176 | **Unauthenticated GET /ee/health exposes sensitive data**: Proxied EE `/health` returns `simulationMode`, `riskState`, `currentDrawdown`, `dailyPnLFraction`, `tradingAllowed`, `positionSizeMultiplier`, `queueSize`. An attacker can time actions to system stress. | security-auditor | HIGH (90%) | Gate behind dashboard auth token, or strip sensitive fields (drawdown, P&L, risk state) from proxied response. |
| M-03 | Bug | routes/index.ts:106 | **parseInt without NaN guard**: `parseInt(process.env.EXECUTION_ENGINE_PORT ?? '3005', 10)` — NaN if env var is non-numeric. Codebase uses `safeParseInt` elsewhere. | bug-hunter, team-lead | HIGH (95%) | Use `parseEnvIntSafe` or add NaN check: `if (Number.isNaN(eePort)) throw new Error('Invalid EXECUTION_ENGINE_PORT')`. |
| M-04 | Refactoring | routes/index.ts:33-194 | **setupAllRoutes() is 162 lines** with proxy logic inline. 4x `as unknown as RequestHandler` casts indicate type mismatch. | architecture-auditor, performance, team-lead | HIGH (90%) | Extract to `proxy.routes.ts`, fix `@arbitrage/security` types at source. |
| M-05 | Mock Fidelity | 6 test files | **CB mocks missing `getCooldownRemaining()`** and `getStatus()` returns incomplete object (missing `lastFailure`, `threshold`). NOT breaking yet (no tests call `getCircuitBreakerSnapshot`), but will fail when tests are added per H-02. | mock-fidelity | HIGH (90%) | Add `getCooldownRemaining: jest.fn().mockReturnValue(0)` and complete `getStatus()` return in all 6 mock locations. |
| M-06 | Security | coordinator.ts:2716-2723 | **emitSSE silent error swallowing**: Empty catch means broken listeners waste CPU on every emit (46/s) with no logging or removal. | team-lead | MEDIUM (75%) | Log at debug level: `this.logger.debug('SSE listener error', { event })`. |
| M-07 | Config | .env.example:657 | **Doc says "default: true" but code defaults to false**: Comment `(default: true)` but `=== 'true'` pattern means default is false when unset. Previously flagged as SA-1G-003. | bug-hunter | HIGH (90%) | Change to `# P2-008: Legacy HMAC signature compatibility (default: false, opt-in)` |
| M-08 | Security | dashboard/LoginScreen.tsx:32-33 | **localStorage stores auth tokens**: Both `dashboard_token` and `cb_api_key` in localStorage. XSS could exfiltrate them. Mitigated by CSP `'self'` and security headers. | security-auditor | MEDIUM (75%) | Consider `sessionStorage` (cleared on tab close) or httpOnly cookies. |

## Low Findings (P3)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix |
|---|----------|-----------|-------------|----------|------------|---------------|
| L-01 | Bug | routes/index.ts:133-140 | **Proxy body accumulates after destroy()**: After oversized response triggers `proxyReq.destroy()`, buffered `data` events still append to `body`. | bug-hunter, team-lead | MEDIUM (75%) | Add `if (responded) return;` at top of data handler. |
| L-02 | Security | routes/index.ts:130 | **Plaintext HTTP for internal proxy**: `http.request` (not https) forwards `X-API-Key` in cleartext between coordinator→EE. Risk if on separate hosts. | security-auditor | MEDIUM (70%) | Document co-location requirement, or add `EXECUTION_ENGINE_PROTOCOL` env var. |
| L-03 | Config | sse.routes.ts:16 | **SSE connection limit hardcoded**: `MAX_SSE_CONNECTIONS = 50` not configurable via env var. | architecture-auditor | HIGH (85%) | `parseInt(process.env.MAX_SSE_CONNECTIONS ?? '50', 10)` |
| L-04 | Architecture | sse.routes.ts | **SSE event names are untyped strings**: No discriminated union for event types (`'metrics'`, `'execution-result'`, `'alert'`, etc.). No IDE support for dashboard consumers. | architecture-auditor | HIGH (85%) | Define `type SSEEventType = 'metrics' \| 'services' \| 'circuit-breaker' \| 'streams' \| 'execution-result' \| 'alert'` in shared types. |
| L-05 | Bug | opportunity-router.ts:586-591 | **pipelineTimestamps type narrowing inconsistent**: Uses `typeof === 'number'` but `parseNumericField()` (line 29, same file) handles both string and number. If a future producer encodes as strings, they'd be silently dropped. | bug-hunter | LOW (60%) | Consider reusing `parseNumericField()` for consistency. |
| L-06 | Dashboard | dashboard/index.html:8-10 | **External font loading via Google CDN**: JetBrains Mono + Manrope loaded externally. | team-lead | LOW (60%) | Self-host via `@fontsource/*` npm packages. |
| L-07 | Refactoring | routes/index.ts:178-186 | **4x `as unknown as RequestHandler` double-casts**: Type mismatch between `@arbitrage/security` and Express. | architecture-auditor, team-lead | HIGH (90%) | Fix auth function return types in `@arbitrage/security`. |

---

## Test Coverage Matrix

| Source File | Function/Method | Happy | Error | Edge | Auth | Status |
|-------------|----------------|-------|-------|------|------|--------|
| routes/index.ts | proxyToEE() | MISSING | MISSING (5 paths) | MISSING | MISSING | **H-02** |
| routes/index.ts | GET /ee/health | MISSING | MISSING | - | N/A | **H-02** |
| routes/index.ts | GET /circuit-breaker | MISSING | MISSING | - | N/A | **H-02** |
| routes/index.ts | POST /circuit-breaker/* | MISSING | MISSING | - | MISSING | **H-02** |
| coordinator.ts | subscribeSSE() | MISSING | MISSING | - | N/A | **H-02** |
| coordinator.ts | emitSSE() | MISSING | MISSING | MISSING | N/A | **H-02** |
| coordinator.ts | getCircuitBreakerSnapshot() | MISSING | MISSING | MISSING | N/A | **H-02** |
| sse.routes.ts | GET /api/events | Partial | MISSING | MISSING | MISSING | **H-02** |
| opportunity-router.ts | pipelineTimestamps deser. | MISSING | MISSING | MISSING | N/A | **H-03** |
| streams.ts | MAXLEN change | Covered | - | - | N/A | OK |
| streams.ts | HMAC env rename | **Comprehensive** (20+ tests) | Covered | Covered | N/A | OK |
| middleware/index.ts | CORS X-API-Key | Covered | - | - | N/A | OK |

## Mock Fidelity Matrix

| Mock Location | Real Interface | Gap | Severity |
|---------------|---------------|-----|----------|
| coordinator.test.ts:134 | SimpleCircuitBreaker | Missing `getCooldownRemaining()` | **M-05** |
| opportunity-router.test.ts:73 | SimpleCircuitBreaker | Missing `getCooldownRemaining()`, incomplete `getStatus()` | **M-05** |
| admission-control.test.ts | SimpleCircuitBreaker | Same as above | **M-05** |
| chain-group-routing.test.ts | SimpleCircuitBreaker | Same as above | **M-05** |
| coordinator-routing.test.ts | SimpleCircuitBreaker | Same as above | **M-05** |
| (none) | http.request for proxy | No mock exists — proxy untested | **H-02** |

## Security Assessment

| Area | Status | Agent | Details |
|------|--------|-------|---------|
| SSE Auth (when token set) | **GOOD** | security | `crypto.timingSafeEqual`, query param token |
| SSE Auth (when unset) | **FAIL** | security | Silently allows unauthenticated access (H-01) |
| SSE Token in URL | **CONCERN** | security | Leaks to logs (H-05) |
| SSE Connection Limit | **GOOD** | security, architecture | `MAX_SSE_CONNECTIONS = 50` |
| CORS | **GOOD** | security, team-lead | Origin-validated, case-insensitive per RFC 3986 |
| CB POST Auth | **GOOD** | security | `apiAuth()` + `apiAuthorize('services', 'write')` |
| CB/EE GET Auth | **CONCERN** | security | Exposes riskState, drawdown, P&L unauthenticated (M-02) |
| Proxy Target | **GOOD** | security | Server-side env vars only, not user-controllable |
| Body Limits | **GOOD** | security, performance | Express 1MB + proxy response 1MB |
| HMAC Integrity | **GOOD** | security | Signed before processing, timingSafeEqual verification |
| Rate Limiting | **GOOD** | security | `express-rate-limit` applied globally |
| Internal Proxy TLS | **LOW RISK** | security | Plaintext HTTP between coordinator→EE (L-02) |
| localStorage Tokens | **MITIGATED** | security | CSP `'self'` reduces XSS risk significantly (M-08) |

## Performance Assessment

| Component | Frequency | Latency Impact | Hot Path? | Verdict |
|-----------|-----------|----------------|-----------|---------|
| emitSSE() in exec handler | 46/s | <0.1ms (50 listeners, sync) | Yes | **PASS** — well within 50ms |
| JSON.parse pipelineTimestamps | 100+/s | ~3μs/opp (conditional, 50-byte payload) | Yes | **PASS** — negligible |
| Object allocation per emitSSE | 46/s | ~293 bytes, GC'd between ticks | Yes | **PASS** — acceptable |
| proxyToEE() | <1/s | 5s timeout | No | N/A |
| MAXLEN 100K (from 25K) | N/A | +21MB Redis memory | No | **PASS** — 5.4% of 512MB limit, 36min buffer |

## Cross-Agent Insights

1. **Security + Architecture agreement**: Both independently confirmed SSE auth uses timingSafeEqual, connection limits work correctly, cleanup on disconnect is proper. Security found the auth-bypass gap when token is unset; architecture found the documentation gap.

2. **Bug-hunter + Performance agreement**: Both identified `|| undefined` on latencyMs as a convention violation. Performance confirmed it has zero latency impact; bug-hunter confirmed it corrupts SSE data for sub-millisecond executions.

3. **Test-quality + Mock-fidelity convergence**: Test-quality found zero test coverage for SSE/proxy/CB-snapshot. Mock-fidelity found the CB mocks are incomplete (missing `getCooldownRemaining()`, incomplete `getStatus()`). These must be fixed together — mocks first, then tests.

4. **Security-auditor HMAC correction**: The HMAC env rename risk (originally rated MEDIUM by team-lead) was downgraded by security-auditor — since the old name defaults to disabled (`=== 'true'` opt-in), the rename is actually the safe direction (legacy compat OFF is the desired state). The real risk is the `.env.example` doc saying "default: true" when the code defaults false (M-07).

5. **Architecture + Security overlap**: Both flagged unauthenticated GET /circuit-breaker and /ee/health. Architecture saw it as a documentation issue; security quantified the exposure (riskState, drawdown, P&L).

## Recommended Action Plan

### Phase 1: Immediate (before merge — security + correctness)
- [ ] **H-01**: Add production auth guard to SSE route (1 line, high impact)
- [ ] **M-01**: Fix `|| undefined` → remove or ternary for latencyMs
- [ ] **M-03**: Add NaN guard for EXECUTION_ENGINE_PORT parseInt
- [ ] **M-05**: Update all 6 CB mocks with `getCooldownRemaining()` + complete `getStatus()`
- [ ] **M-07**: Fix .env.example "default: true" → "default: false, opt-in"

### Phase 2: Before merge (test coverage)
- [ ] **H-02**: Add unit tests for proxyToEE (5 error paths), SSE system, getCircuitBreakerSnapshot
- [ ] **H-03**: Add unit tests for SM-013 pipelineTimestamps deserialization (4 scenarios)

### Phase 3: Next Sprint (documentation + security hardening)
- [ ] **H-04**: Document new endpoints in API.md (SSE, EE proxy, CB proxy)
- [ ] **H-05**: Address SSE token-in-URL log leakage (separate token or doc scrubbing)
- [ ] **M-02**: Gate GET /ee/health behind auth or strip sensitive fields
- [ ] **M-04**: Extract proxy to `proxy.routes.ts`, fix `@arbitrage/security` types
- [ ] **M-08**: Consider sessionStorage for dashboard tokens

### Phase 4: Backlog (hardening)
- [ ] **M-06**: Add debug logging for failing SSE listeners
- [ ] **L-01**: Stop body accumulation after proxy destroy
- [ ] **L-02**: Document co-location requirement for coordinator↔EE
- [ ] **L-03**: Make SSE connection limit configurable
- [ ] **L-04**: Define SSE event type union in shared types
- [ ] **L-07**: Fix `as unknown as RequestHandler` casts at source
