# Extended Deep Analysis: React Monitoring Dashboard

**Date**: 2026-03-07
**Target**: `dashboard/` (23 source files, React 18 + Vite 5 + TailwindCSS + Recharts SPA)
**Method**: 6-agent parallel analysis (latency-profiler, failure-mode-analyst, data-integrity-auditor, cross-chain-analyst, observability-auditor, config-drift-detector)
**Verdict**: **NO-GO** (3 Critical / 6 High / 10 Medium / 9 Low — 28 total findings)
**Grade**: **B-** (good foundation, critical data integrity bugs and operational blind spots)

---

## Executive Summary

- **3 Critical**: SSE streams schema mismatch (Streams tab broken), no React Error Boundary (any NaN crashes app), phantom Mantle/Mode chains shown as healthy
- **6 High**: Monolithic SSEContext global re-renders, invalid auth → infinite 401 loop, silent admin mutation failures, SSE reconnect data loss, RedisStats interface wrong, Solana service key mismatch
- **Top 5 highest-impact issues**:
  1. SSE `streams` event sends `StreamHealthSummary` (aggregates) but dashboard expects per-stream objects — Streams tab displays incorrectly
  2. No React Error Boundary — a single NaN/null from server crashes the entire app to white screen with no recovery
  3. Dashboard shows Mantle and Mode as healthy P3 chains when backend explicitly excludes them from all partitions
  4. Monolithic SSEContext creates new object ref every render, forcing ALL consumers to re-render on every 2s metrics push
  5. Invalid auth token causes infinite 401 reconnect loop with no user feedback
- **Agent agreement**: 4 areas flagged by 2+ agents (chart data not reset on reconnect, NaN guard gaps, SSE delivery gaps, hardcoded partition drift risk)

---

## Critical Findings (P0)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| C-01 | Data Integrity | `sse.routes.ts:69-71` / `types.ts:103-110` | **SSE `streams` event schema mismatch.** Server calls `monitor.getSummary()` returning `StreamHealthSummary` (flat aggregates: `totalStreams`, `healthyStreams`, `totalPending`). Frontend expects `Record<string, {length, pending, consumerGroups, status}>` per-stream objects. `StreamsTab.tsx:30-31` calls `Object.entries(streams)` and accesses `info.pending`, `info.length` — these will be numbers (e.g., `totalStreams=8`), not objects. Stream table renders incorrectly; `SSEContext.tsx:64-65` `totalPending` reducer also breaks. | data-integrity | HIGH (95%) | Change `sse.routes.ts:69` to call `checkStreamHealth()` instead of `getSummary()`, then map `health.streams` Record to match frontend shape (rename `pendingCount` → `pending`, add `consumerGroups` from consumer group count). | 3.8 |
| C-02 | Reliability | `App.tsx:97-121` / `format.ts:3-4` | **No React Error Boundary.** Zero ErrorBoundary components in the entire dashboard. Combined with unguarded `.toFixed()` calls in `format.ts:4,8,26` and direct field access on SSE payloads (`RiskTab.tsx:109`: `admissionMetrics.avgScoreAdmitted.toFixed(3)`), a single `null`/`NaN` from the server crashes the entire app to white screen. No recovery except manual page reload. All SSE state, feed, and chart data lost. | failure-mode, observability | HIGH (95%) | Add `<ErrorBoundary>` wrapping `<Dashboard>` in `App.tsx` with "Reload" button. Add NaN/Infinity guards to all format functions: `if (n == null \|\| !isFinite(n)) return fallback`. | 4.4 |
| C-03 | Cross-Chain | `ChainsTab.tsx:9` vs `partitions.ts:251,269` | **Phantom Mantle/Mode chains.** Dashboard includes `'mantle', 'mode'` in P3 chain list. Backend `partitions.ts:251` explicitly states: "Mantle and Mode remain stubs (unverified factory addresses) — excluded from all partitions". These chains inherit P3 partition health status, showing as "healthy" when they are not monitored at all. Operators get false confidence in chain coverage. | cross-chain | HIGH (95%) | Remove `'mantle', 'mode'` from `ChainsTab.tsx:9`. P3 chains should be `['ethereum', 'zksync', 'linea']`. | 4.0 |

---

## High Findings (P1)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| H-01 | Performance | `SSEContext.tsx:126` / all tabs | **Monolithic SSEContext forces global re-renders.** `<SSEContext.Provider value={{ ...state, status }}>` creates a new object ref on every render. All 6 tab components call `useSSEData()` subscribing to ENTIRE state. A metrics update (every 2s) re-renders the active tab + header even if only `metrics` changed and the tab only reads `services`. Zero `React.memo` or `useMemo` in the entire codebase. Recharts SVG trees reconstructed every 2s. | latency-profiler | HIGH (95%) | Split into 3-4 contexts (Metrics, Services, Streams, Feed) or use `use-context-selector`. At minimum, memoize Provider value and add `React.memo` to expensive leaf components (`LiveFeed`, `ServiceCard`, `KpiCard`, `ChainCard`). | 3.1 |
| H-02 | Failure Mode | `useSSE.ts:25-28` | **Invalid auth token → infinite 401 reconnect loop.** EventSource cannot inspect HTTP status codes. Server returns 401, EventSource fires `onerror`, browser auto-reconnects, creating infinite cycle. Status stays `'connecting'` forever with no distinction between auth failure and network error. User sees yellow dot and stale data indefinitely. | failure-mode | HIGH (90%) | Add pre-flight token validation: `fetch('/api/events?token=...', {method: 'HEAD'})` before opening EventSource. If 401, redirect to LoginScreen with "Invalid token" message. Or add `/api/auth/validate` endpoint. | 3.7 |
| H-03 | Failure Mode | `AdminTab.tsx:233-275`, `useApi.ts:26-49` | **Silent admin mutation failures.** Circuit breaker open/close, service restart, and alert ack mutations have NO `onError` handlers — errors are silently swallowed. Only `setLogLevel` (AdminTab:110) has error feedback. User may believe CB was opened/closed or service was restarted when it wasn't. These are the highest-risk admin actions (halt/resume all trading). | failure-mode, observability | HIGH (95%) | Add `onError` callbacks to all mutations matching the `setLogLevel` pattern. Show red error banner for 5s on failure. | 4.0 |
| H-04 | Data Loss | `useSSE.ts:25-28` / `sse.routes.ts:48-51` | **SSE reconnect loses execution results and alerts permanently.** Server sends initial state on connect (metrics, services, CB) but NOT execution-result history or alert history. No SSE message IDs (`id:` field), no `Last-Event-Id` support. During disconnect, all execution results and alerts are permanently lost. Chart data shows false continuity (no gap indicator). | failure-mode, data-integrity | HIGH (90%) | (a) Add `id: ${counter}\n` to SSE messages for `Last-Event-Id`. (b) On reconnect, backfill recent executions/alerts via REST fetch. (c) Add `reset` action to reducer on reconnection to clear stale chart/feed data. | 2.7 |
| H-05 | Data Integrity | `StreamsTab.tsx:8-15` | **RedisStats interface completely wrong.** Frontend `RedisStats` expects `commandsPerSecond`, `memoryUsed`, `memoryLimit`, `connectedClients`, `uptimeSeconds`. Backend `RedisCommandStats` has `commandsPerMinute`, `byCategory`, `byCommand`, `estimatedDailyUsage` — only `totalCommands` matches. All other fields are `undefined`, so Redis Stats panel shows just "Total Commands" and hides 4 other fields. | data-integrity | HIGH (90%) | Rewrite `RedisStats` interface to match `RedisCommandStats` from `shared/core/src/redis/client.ts:124-141`. Map `commandsPerMinute / 60` for `commandsPerSecond`. For memory/clients, either add a separate `/api/redis/info` endpoint returning `INFO` stats, or remove those fields. | 3.3 |
| H-06 | Cross-Chain | `ChainsTab.tsx:10,20` vs `service-ports.json:30` | **Solana service key mismatch.** Dashboard computes P4 service key as `partition-${partition.id}` = `partition-solana-native` (id='solana-native' at line 10). Backend registers P4 as `partition-solana` (confirmed in `service-ports.json:30`: `"solana-native": "partition-solana"`). Lookup `services['partition-solana-native']` always returns `undefined`. P4 always shows "unknown" status, missing uptime/memory/CPU/latency. | cross-chain | HIGH (90%) | Change `ChainsTab.tsx:10` id from `'solana-native'` to `'solana'` so `partition-solana` matches backend. Or add `serviceKey` override to PARTITIONS array. | 3.6 |

---

## Medium Findings (P2)

| # | Category | File:Line | Description | Agent(s) | Confidence | Suggested Fix | Score |
|---|----------|-----------|-------------|----------|------------|---------------|-------|
| M-01 | Data Integrity | `SSEContext.tsx:120` / `useSSE.ts:33-34` | **Unsafe SSE type cast + no runtime payload validation.** `dispatch({ type: event as SSEAction['type'], payload: data as never })` — `as never` suppresses all type checking. Malformed metrics payload (e.g., `totalExecutions: undefined`) → `NaN` propagation in successRate calc → "$NaN" in KPI cards, "NaN%" in charts. | data-integrity, failure-mode | HIGH (90%) | Add lightweight runtime validation: check `typeof data.totalExecutions === 'number'` before dispatch. Log + skip malformed payloads. | 2.6 |
| M-02 | Data Staleness | `SSEContext.tsx:41-91` | **Chart data not reset on SSE reconnection.** Reducer has no `reset` action. After a 5-minute disconnect, `chartData` and `lagData` retain pre-disconnect points creating false continuity. `feed` mixes pre/post-disconnect items. Server only sends initial metrics/services/CB on reconnect — no streams until 10s interval fires. | failure-mode, data-integrity | HIGH (90%) | Add `reset` action dispatched when SSE transitions from `connecting` → `connected`. Clear chartData, lagData, feed. | 2.5 |
| M-03 | Observability | `RiskTab.tsx:36-43` | **EE crash → silent "UNKNOWN" state.** If `/ee/health` returns 404 or timeout, `eeHealth` is `undefined`, defaulting to "UNKNOWN". No distinction between "EE never responded" (crashed) and "EE says UNKNOWN" (transient). Operator doesn't know to restart EE. | observability | MEDIUM (80%) | Add error state to EE health query. Distinguish: "EE responding (UNKNOWN)" vs "EE unreachable" with red indicator after 30s timeout. | 2.4 |
| M-04 | Observability | `AdminTab.tsx:25` | **Log level local state not fetched from server.** `activeLogLevel` initialized to `'info'` (local state). Never fetched from backend. If another operator changed log level, or if server rejected the change, this tab shows wrong state. | observability | HIGH (90%) | Fetch current log level from backend on tab mount. Disable buttons during mutation. Show server-side error if rejected. | 2.8 |
| M-05 | Cross-Chain | `ChainCard.tsx:9-15` / `sse.routes.ts:64` | **No per-chain health visibility.** All chains in a partition show partition-level status. If BSC has RPC issues but Polygon is healthy, all 4 P1 chains show same status. Backend has per-chain `ChainHealth` data but SSE doesn't expose it. | cross-chain, observability | HIGH (90%) | Add new SSE event type `chain-health` that publishes per-chain status from partition's `chainHealth` map. Update ChainCard to show individual chain status. | 2.1 |
| M-06 | Security | `SSEContext.tsx:117` / `LoginScreen.tsx:12-15` | **Auth token in SSE URL query string.** Token visible in server access logs, proxy logs, browser history. EventSource API limitation (cannot set headers). `LoginScreen` stores any non-empty string without validation — wrong token causes FM-02 (infinite 401 loop). | failure-mode, config-drift | MEDIUM (85%) | (a) Pre-validate token before storing. (b) Consider short-lived tokens or cookie-based auth for SSE. (c) Add token expiry/rotation mechanism. | 2.0 |
| M-07 | Cross-Chain | `ExecutionTab.tsx:85-99` / `types.ts:71` | **No transaction hash links.** `transactionHash` field exists in `ExecutionResult` type but is never rendered. Operators cannot verify transactions on-chain. No chain-specific colors or visual differentiation. | cross-chain | HIGH (85%) | Map chain → block explorer URL (etherscan, bscscan, arbiscan, etc.). Render `transactionHash` as clickable link. | 2.3 |
| M-08 | Data Integrity | `format.ts:3-4,8,11,21,26` | **Format functions lack NaN/Infinity/null guards.** `formatUsd(NaN)` → `"$NaN"`, `formatUsd(Infinity)` → `"$Infinityk"`, `formatPct(NaN)` → `"NaN%"`. Combined with C-02 (no error boundary), these crash the app. | failure-mode, data-integrity | HIGH (95%) | Add `if (n == null \|\| !isFinite(n)) return fallback` to all format functions. | 3.2 |
| M-09 | Performance | `ExecutionTab.tsx:19-21`, `OverviewTab.tsx:22`, `StreamsTab.tsx:30-31` | **Derived data recomputed on every render.** `feed.filter()`, `Object.values(services)`, `Object.entries(streams).sort()` all run on every re-render (every 2s due to H-01). No `useMemo` anywhere. | latency-profiler | HIGH (90%) | Wrap in `useMemo` with appropriate dependency arrays. | 2.4 |
| M-10 | Failure Mode | `AdminTab.tsx:38-44,156` | **Leader check 30s stale for admin actions.** Service restart disabled based on `isLeader` from a 30s-stale react-query. In leader failover, stale `isLeader=true` allows restart attempts that server rejects (403) — but client has no `onError` handler (H-03). CB open/close has NO leader check at all. | failure-mode | MEDIUM (80%) | Add server-side leader validation to CB proxy routes. Reduce leader refetch to 10s. Add `onError` handlers. | 2.0 |

---

## Low Findings (P3)

| # | Category | File:Line | Description | Agent(s) | Confidence | Score |
|---|----------|-----------|-------------|----------|------------|-------|
| L-01 | Performance | `SSEContext.tsx:52-55,81,86` | Array spread+slice in reducer creates new arrays on every event (~46 copies/s for execution results under production load). Capped at 50/90 items, so not a leak. | latency-profiler | HIGH | 1.8 |
| L-02 | Testing | `dashboard/` (no test files) | Zero test infrastructure — no vitest, jest, or testing-library. No way to catch type regressions or logic bugs in UI code. | config-drift | HIGH | 1.5 |
| L-03 | Config Drift | `ChainsTab.tsx:6-11` | Partition chains/IDs hardcoded. If backend partition config changes, dashboard silently shows wrong data. No automated sync mechanism. | config-drift, cross-chain | MEDIUM | 1.8 |
| L-04 | Observability | `ServiceCard.tsx:10-21` | ServiceCard doesn't render `error` field — service errors only visible in AdminTab. Operator misses failures in Overview. | observability | HIGH | 1.6 |
| L-05 | Observability | (missing feature) | No per-chain metrics: opportunities/chain, profit/chain, gas breakdown (L1 vs L2). Can't identify which chains are profitable. | cross-chain, observability | MEDIUM | 1.2 |
| L-06 | UX | `CircuitBreakerGrid.tsx:34-46` / `AdminTab.tsx:84-97` | Duplicate CB controls in ExecutionTab and AdminTab. Independent state management — no sync between them. | failure-mode | HIGH | 1.0 |
| L-07 | Reliability | `App.tsx:98` / `SSEContext.tsx:115` / `useApi.ts:5` | No try/catch around `localStorage` access. Throws in restrictive browser modes (private browsing, storage quota exceeded). | failure-mode | MEDIUM | 1.4 |
| L-08 | Data Integrity | `SSEContext.tsx:45-48` | Chart dedup key uses `formatTime` (HH:MM:SS) — sub-second updates dropped. Safe at current 2s/10s intervals but fragile if intervals change. | data-integrity | HIGH | 0.8 |
| L-09 | Code Quality | `SSEContext.tsx:116` | Dead code: `const baseUrl = import.meta.env.DEV ? '' : ''` — ternary always returns `''`. | failure-mode | HIGH | 0.5 |

---

## Cross-Agent Insights

### Information Separation Results (Agent 2 vs Agent 3 — Redis Streams / Data Flow)

| Area | Agent 2 (failure-mode) | Agent 3 (data-integrity) | Agreement | Resolution |
|------|----------------------|-------------------------|-----------|------------|
| Chart data on reconnect | FM-3: "never resets, creates false continuity" | M3: "never resets, gap filled by interpolation" | **AGREE** → HIGH confidence | Merged as M-02 |
| SSE delivery gaps | FM-2: "execution results permanently lost" | L5: "no message IDs or catch-up mechanism" | **AGREE** → HIGH confidence | Merged as H-04 |
| NaN crash risk | FM-14: "formatUsd crashes on NaN" + FM-5: "no error boundary = fatal" | L1: "formatUsd(NaN) → $NaN" | **AGREE** → HIGH confidence | Merged as C-02 + M-08 |
| SSE payload validation | FM-14/15: "NaN propagation from malformed payloads" | M1/M2: "unsafe cast, no runtime validation" | **AGREE** → HIGH confidence | Merged as M-01 |

No disagreements between Agents 2 and 3 — all overlapping findings were complementary.

### Multi-Agent Convergence

- **NaN/crash chain** (Agents 1, 2, 3, 5): Latency-profiler noted unguarded computations → failure-mode-analyst traced crash path → data-integrity-auditor confirmed format function gaps → observability-auditor flagged missing error feedback. All 4 agents independently contributed to the C-02 + M-08 finding.
- **Hardcoded partitions** (Agents 4, 6): Cross-chain-analyst verified exact chain mismatch → config-drift-detector flagged sync risk. Combined into C-03 + L-03.
- **SSE reconnect behavior** (Agents 1, 2, 3): All three independently traced the reconnect data flow and found no catch-up mechanism.

---

## Conflict Resolutions

### Config-Drift D-02: EE Proxy Path Rewrite (FALSE POSITIVE)

**Claim**: Config-drift-detector rated "CRITICAL — Dashboard `/ee/*` calls fail 404 in production" because coordinator doesn't rewrite paths like Vite does.

**Verification**: `routes/index.ts:145-147` explicitly maps `/ee/health` → `proxyToEE('/health', req, res)`. The coordinator uses explicit per-route mapping (not regex rewrite like Vite), achieving the same effect. All 3 EE proxy routes (`/ee/health`, `/circuit-breaker`, `/circuit-breaker/open`, `/circuit-breaker/close`) correctly map to EE paths.

**Resolution**: FALSE POSITIVE — removed from findings. The coordinator handles path rewriting correctly via explicit route handlers.

---

## Failure Mode Map

| # | Stage | Failure Mode | Detection | Recovery | Data Loss Risk | File:Line |
|---|-------|-------------|-----------|----------|----------------|-----------|
| 1 | SSE Auth | Invalid token → infinite 401 loop | None (stays "connecting") | Manual logout + re-login | Dashboard stuck on stale data | useSSE.ts:25-28 |
| 2 | SSE Transport | Connection drops | Yellow dot after 10s | Auto-reconnect | Execution results + alerts lost during gap | useSSE.ts:25-28 |
| 3 | SSE Dispatch | Malformed JSON payload | None (silent catch) | Skip event | Single event lost | useSSE.ts:36-38 |
| 4 | SSE Dispatch | Wrong payload shape | None (unsafe cast) | NaN propagation → crash (no boundary) | **App crash — all state lost** | SSEContext.tsx:120 |
| 5 | REST API | Admin mutation fails | None (no onError) | Manual retry (blind) | Admin action not applied | useApi.ts:26-49 |
| 6 | Rendering | NaN/null in format fn | White screen crash | Manual reload | All state lost | format.ts:3-4 |
| 7 | Rendering | Component exception | White screen crash | Manual reload | All state lost | App.tsx (no ErrorBoundary) |

---

## Chain-Specific Edge Cases

| # | Chain(s) | Issue | Impact | Severity | File:Line |
|---|----------|-------|--------|----------|-----------|
| 1 | Mantle, Mode | Shown as healthy P3 chains despite being stubs excluded from all partitions | False coverage confidence | CRITICAL | ChainsTab.tsx:9 |
| 2 | Solana | Service key `partition-solana-native` doesn't match backend `partition-solana` — P4 always shows "unknown" | P4 status invisible | HIGH | ChainsTab.tsx:10,20 |
| 3 | All | Per-chain health hidden — all chains inherit partition status | Single-chain failures masked | MEDIUM | ChainCard.tsx:9-15 |
| 4 | All | No block explorer links for transaction hashes | Can't verify on-chain | MEDIUM | ExecutionTab.tsx:85-99 |
| 5 | OP Stack (Optimism, Base, Scroll, Blast) | Gas cost shown as single number, no L1/L2 split | Operators can't see L1 data cost | LOW | types.ts:74 |
| 6 | Solana | 1 chain in 5-column grid, no Solana-specific metrics | Sparse display | LOW | ChainsTab.tsx:41 |

---

## Observability Assessment

### Data Freshness

| Data Source | Update Frequency | Indicator | Adequate? |
|------------|-----------------|-----------|-----------|
| Metrics | 2s SSE push | 10s stale dot | Marginal (5x interval) |
| Services | 5s SSE push | 10s stale dot | No (beyond threshold) |
| Streams | 10s SSE push | None | No |
| Circuit Breaker | 5s SSE push | None | No |
| Execution Results | Real-time SSE | None | No |
| Redis Stats | 30s REST poll | "Loading" only | No |
| EE Health | 10s REST poll | "UNKNOWN" fallback | No (hides EE crash) |

### Blind Spots

1. **EE crash shows "UNKNOWN"** — no distinction from normal transient state
2. **Service errors hidden** — `ServiceHealth.error` not rendered in ServiceCard
3. **Stream throughput invisible** — no msgs/sec, no MAXLEN utilization %
4. **Memory trends missing** — snapshot only, can't detect Redis memory leaks
5. **Per-chain metrics absent** — can't detect single-chain stalls or unprofitable chains

---

## Configuration Health

### Constant Sync Status

| Constant | Dashboard | Backend | Status |
|----------|-----------|---------|--------|
| SSE event types | 6 types (useSSE.ts:30) | 6 events (sse.routes.ts) | MATCH |
| P1 chains | bsc,polygon,avalanche,fantom | Same (partitions.ts) | MATCH |
| P2 chains | arbitrum,optimism,base,scroll,blast | Same | MATCH |
| P3 chains | ethereum,zksync,linea,**mantle,mode** | ethereum,zksync,linea | **MISMATCH (C-03)** |
| P4 service key | partition-solana-native | partition-solana | **MISMATCH (H-06)** |
| RedisStats fields | 6 fields | Different fields | **MISMATCH (H-05)** |
| StreamHealth shape | per-stream objects | aggregate summary | **MISMATCH (C-01)** |
| API endpoint paths | All verified | All verified | MATCH |
| || vs ?? patterns | No violations found | N/A | OK |

---

## Recommended Action Plan

### Phase 1: Immediate (P0 — fix before deployment)

- [ ] **C-01**: Fix SSE streams event — call `checkStreamHealth()` not `getSummary()`, map `pendingCount` → `pending` (`sse.routes.ts:69`)
- [ ] **C-02**: Add React ErrorBoundary wrapping `<Dashboard>` + NaN guards in all format functions (`App.tsx`, `format.ts`)
- [ ] **C-03**: Remove `'mantle', 'mode'` from P3 chain list (`ChainsTab.tsx:9`)
- [ ] **H-06**: Fix Solana service key: change id from `'solana-native'` to `'solana'` (`ChainsTab.tsx:10`)
- [ ] **H-03**: Add `onError` handlers to all admin mutations matching `setLogLevel` pattern (`AdminTab.tsx:233-275`)
- [ ] **M-08**: Add NaN/Infinity guards to all format functions (`format.ts:3-26`)

### Phase 2: Next Sprint (P1 — reliability and UX)

- [ ] **H-01**: Split SSEContext into multiple contexts or add `React.memo`/`useMemo` throughout (`SSEContext.tsx`, all tabs)
- [ ] **H-02**: Add pre-flight token validation before EventSource connection (`useSSE.ts`)
- [ ] **H-04**: Add SSE message IDs + reconnect backfill for executions/alerts (`sse.routes.ts`, `SSEContext.tsx`)
- [ ] **H-05**: Fix RedisStats interface to match backend `RedisCommandStats` (`StreamsTab.tsx:8-15`)
- [ ] **M-01**: Add lightweight runtime validation for SSE payloads (`SSEContext.tsx:119-121`)
- [ ] **M-02**: Add `reset` action to reducer on SSE reconnection (`SSEContext.tsx`)
- [ ] **M-03**: Add EE connection status indicator distinguishing "unreachable" from "UNKNOWN" (`RiskTab.tsx`)
- [ ] **M-04**: Fetch current log level from backend on mount (`AdminTab.tsx:25`)
- [ ] **M-09**: Add `useMemo` for derived data in tab components (`ExecutionTab`, `OverviewTab`, `StreamsTab`)

### Phase 3: Backlog (P2/P3 — hardening and observability)

- [ ] **M-05**: Expose per-chain health via new SSE event type (requires backend changes)
- [ ] **M-07**: Add block explorer links for transaction hashes per chain (`ExecutionTab.tsx`)
- [ ] **M-10**: Add server-side leader validation to CB proxy routes
- [ ] **L-02**: Add Vitest + React Testing Library — start with reducer logic and format function tests
- [ ] **L-04**: Render `ServiceHealth.error` in ServiceCard with error indicator
- [ ] **L-07**: Wrap localStorage access in try/catch utility
- [ ] Remaining LOW items as capacity allows

---

## Appendix: Agent Assignments

| Agent | Type | Findings | Key Discovery |
|-------|------|----------|---------------|
| latency-profiler | general-purpose | 12 (2H, 4M, 6L) | Monolithic SSEContext = root cause of all re-renders |
| failure-mode-analyst | general-purpose | 21 (4H, 6M, 10L, 1I) | No Error Boundary + silent mutations = highest risk |
| data-integrity-auditor | general-purpose | 11 (1H, 5M, 5L) | SSE streams schema mismatch + RedisStats interface wrong |
| cross-chain-analyst | general-purpose | 9 (1H, 3M, 5L) | Phantom Mantle/Mode chains + Solana key mismatch |
| observability-auditor | Explore | 8 blind spots | EE crash invisible + service errors hidden + log level bug |
| config-drift-detector | Explore | 10 drift issues | 1 false positive (EE proxy), token security, no tests |
