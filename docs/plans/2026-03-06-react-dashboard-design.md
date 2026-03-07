# React Dashboard Design

**Date:** 2026-03-06
**Status:** Approved
**Scope:** Operator dashboard for the arbitrage trading system

---

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| User persona | Solo developer/operator | Power-user, max information density |
| Deployment | Embedded in coordinator | Static assets served via `express.static()`, replaces current HTML dashboard |
| Data transport | SSE (Server-Sent Events) | Sub-second push, standard HTTP, automatic reconnection, ~80 lines server-side |
| Controls scope | Tier 2 (basic operations) | Circuit breaker open/close, log level, alert ack, service restart — all existing APIs |
| Layout | Tabbed, 6 views | Each tab = one operational concern, fits one viewport |
| Bundler | Vite | Fast HMR, zero-config React SPA, builds to static assets |
| Framework | React 18 | Hooks + context for SSE distribution |
| Styling | Tailwind CSS | Dark theme built-in, utility-first, tiny production bundle |
| Charts | Recharts | React-native API, ~45KB, covers line/bar/area |
| Data fetching | Custom SSE hook + TanStack Query | SSE for push, TanStack for REST mutations |
| Routing | React state (`useState<Tab>`) | 6 tabs don't need URL routing, zero dependencies |

---

## Architecture

### Build & Embed

```
dashboard/                         # React SPA (Vite)
├── package.json
├── vite.config.ts                 # Builds to services/coordinator/public/
├── tailwind.config.ts
├── index.html
├── src/
│   ├── App.tsx                    # Tab router, SSE provider
│   ├── hooks/
│   │   ├── useSSE.ts              # SSE connection + auto-reconnect
│   │   └── useApi.ts              # REST mutations via TanStack Query
│   ├── tabs/
│   │   ├── OverviewTab.tsx
│   │   ├── ExecutionTab.tsx
│   │   ├── ChainsTab.tsx
│   │   ├── RiskTab.tsx
│   │   ├── StreamsTab.tsx
│   │   └── AdminTab.tsx
│   ├── components/
│   │   ├── KpiCard.tsx
│   │   ├── ServiceCard.tsx
│   │   ├── ChainCard.tsx
│   │   ├── LiveFeed.tsx
│   │   ├── StatusBadge.tsx
│   │   ├── SparklineChart.tsx
│   │   ├── ConfirmModal.tsx
│   │   └── CircuitBreakerGrid.tsx
│   ├── lib/
│   │   ├── types.ts               # Mirrors shared/types interfaces
│   │   └── format.ts              # Number/date formatting utils
│   └── styles/
│       └── globals.css            # Tailwind base + custom utilities
└── tsconfig.json

services/coordinator/
├── public/                        # Vite build output (gitignored)
└── src/api/routes/
    ├── dashboard.routes.ts        # Modified: serves static + SSE
    └── sse.routes.ts              # New: SSE endpoint (~80 lines)
```

### Development Workflow

```bash
# Terminal 1: Backend services
npm run dev:all

# Terminal 2: Dashboard with hot reload (proxies API to localhost:3000)
cd dashboard && npm run dev       # Vite dev server on port 5173
```

### Production Build

```bash
cd dashboard && npm run build     # Output -> services/coordinator/public/
# Coordinator serves via express.static('public')
```

---

## SSE Protocol

**Endpoint:** `GET /api/events?token=<DASHBOARD_AUTH_TOKEN>`

Auth token passed as query param because `EventSource` API does not support custom headers. Coordinator validates via timing-safe comparison (same as current dashboard auth).

### Event Types

| Event | Frequency | Trigger | Payload |
|-------|-----------|---------|---------|
| `metrics` | 2s | Timer | `SystemMetrics` object |
| `services` | 5s | Timer | `Record<string, ServiceHealth>` |
| `execution-result` | Instant | On each result | `ExecutionResult` object |
| `alert` | Instant | On alert fired | `Alert` object |
| `circuit-breaker` | Instant | On state change | CB status object |
| `streams` | 10s | Timer | Stream health map |

### Wire Format

```
event: metrics
data: {"systemHealth":94.2,"totalOpportunities":1247,...}

event: execution-result
data: {"opportunityId":"uuid-1","success":true,"profit":45.20,...}
```

### Server Implementation (~80 lines)

Express route sets `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`. Pushes events on intervals (metrics@2s, services@5s, streams@10s) and instant triggers (execution results, alerts, CB changes). Coordinator already has all data in memory via `CoordinatorStateProvider`.

---

## Tab Designs

### Tab 1: Overview

The "wall monitor" view. Everything at a glance, no interaction needed.

**Layout:**
- **KPI bar** (top): System health gauge, opportunities/min, execution success rate, total profit, avg latency p95. Each card has a sparkline showing last 5 minutes.
- **Services grid** (middle): 8 cards (coordinator, P1-P4, execution engine, cross-chain, mempool). Each shows status dot (green/yellow/red), memory MB, CPU %. Color-coded by health.
- **Live activity feed** (bottom-left): Auto-scrolling list of last ~50 events. Execution results (checkmark/X + chain + profit), alerts (warning icon + message). Newest on top.
- **Pipeline health** (bottom-right): Backpressure indicator (active/inactive), stream depth ratio bar, DLQ count, consumer lag count, admission rate, shed score threshold. Forwarding breakdown (expired/dupes/rejected/deferred).

**Data sources:**
- KPI bar: `SystemMetrics` from SSE `metrics` event
- Services: `ServiceHealthMap` from SSE `services` event
- Live feed: SSE `execution-result` + `alert` events (client-side ring buffer, last 50)
- Pipeline: `SystemMetrics.backpressure`, `dlqMetrics`, `admissionMetrics`, `forwardingMetrics`

### Tab 2: Execution

Trade-focused view. What's executing, how well, what's failing.

**Layout:**
- **Execution KPIs** (top): Attempts, successes, failures, success rate %, total profit
- **Charts** (middle): Execution latency line chart (5min window, Recharts) + success rate line chart (30min window)
- **Circuit breaker grid** (middle): 13 chain cards in 2 rows. Each shows chain abbreviation, state (CLOSED/OPEN/HALF_OPEN), consecutive failures. Color: green=closed, red=open, yellow=half-open. Two buttons below grid: [Force Open All] and [Force Close All] with confirmation modal.
- **Recent executions table** (bottom): Last 50 executions from SSE. Columns: time, chain, DEX, type, profit/error, latency, gas used. Failed rows highlighted red.

**Data sources:**
- KPIs: EE `/stats` (pushed via SSE or initial REST fetch)
- Charts: Client-side accumulation of SSE `execution-result` events in ring buffers
- CB grid: SSE `circuit-breaker` event
- Controls: `POST /circuit-breaker/open` and `/close` on EE (port 3005)
- Table: SSE `execution-result` events

### Tab 3: Chains

Per-chain and per-partition view.

**Layout:**
- 4 partition sections, each with a header showing partition name, region, memory, chain count, total events
- Within each partition: chain cards showing chain name, status dot, gas price, events processed, opportunities detected, RPC latency
- P4 (Solana) section includes DEX list and slot number

**Data sources:**
- Partition headers + chain cards: Aggregated from partition `/stats` endpoints. Coordinator SSE `services` event includes partition health. For detailed chain stats, initial REST fetch from each partition's `/stats` endpoint, refreshed on tab focus.
- Gas prices: From EE Prometheus metrics or SSE push

### Tab 4: Risk

Capital protection and pipeline quality.

**Layout:**
- **Drawdown state machine** (top): Visual diagram of NORMAL -> CAUTION -> HALT -> RECOVERY with current state highlighted. Stats below: state, position sizing %, daily PnL, max drawdown, consecutive wins/losses, halt cooldown.
- **Admission control panel** (middle-left): Admitted vs shed counts with percentage bar. Average scores for admitted and shed opportunities.
- **Forwarding panel** (middle-right): Rejection reason breakdown (expired, duplicate, profit rejected, chain rejected, grace deferred, circuit open) as a horizontal stacked bar or table.
- **Backpressure panel** (bottom): Stream depth ratio as a wide progress bar (0-100%), active/inactive label, consumer lag count, EE queue size.

**Data sources:**
- Drawdown: EE `/health` (riskState, tradingAllowed, positionSizeMultiplier, currentDrawdown, dailyPnLFraction, haltCooldownRemainingMs)
- Admission/forwarding: `SystemMetrics.admissionMetrics` + `forwardingMetrics` from SSE
- Backpressure: `SystemMetrics.backpressure` from SSE

### Tab 5: Streams

Redis infrastructure health.

**Layout:**
- **Stream table** (top): 10+ active streams. Columns: name, length, pending messages, consumer groups, health status dot, MAXLEN capacity. Rows sorted by pending (descending).
- **Consumer lag chart** (middle): Line chart showing pending message count over 15 minutes (client-side accumulation from SSE `streams` events).
- **DLQ analysis** (bottom-left): Error type breakdown (total, expired, validation, transient, unknown) as counts and pie/bar chart.
- **Redis stats** (bottom-right): Memory usage %, total commands, command breakdown (XADD, XREADGROUP, etc.).

**Data sources:**
- Stream table: SSE `streams` event (parsed from StreamHealthMonitor)
- Lag chart: Client-side ring buffer of SSE `streams` snapshots
- DLQ: `SystemMetrics.dlqMetrics` from SSE
- Redis: `GET /api/redis/stats` (REST, refreshed every 30s)

### Tab 6: Admin

Tier 2 operational controls.

**Layout:**
- **Circuit breaker control** (top): Current state label + [Force Open All] and [Force Close All] buttons. Text input for "reason" when opening. Both actions show confirmation modal.
- **Log level selector** (middle-top): 6 buttons (trace/debug/info/warn/error/fatal). Current level highlighted. Click changes level immediately with visual feedback.
- **Service management table** (middle): 8 rows (all services). Columns: service name, status dot, uptime, [Restart] button. Restart shows confirmation modal. Disabled if coordinator is not leader.
- **Alerts table** (middle-bottom): Recent alerts. Columns: severity badge, service, message, timestamp, [Ack] button. Bulk [Ack All] button in header.
- **System info** (bottom): Instance ID, leader status, uptime, Node.js version, Redis memory %.

**Controls and their APIs:**
- Circuit breaker: `POST http://localhost:3005/circuit-breaker/open` and `/close` (requires `CIRCUIT_BREAKER_API_KEY`)
- Log level: `PUT http://localhost:3000/admin/log-level` (requires coordinator auth)
- Service restart: `POST http://localhost:3000/api/services/:service/restart` (requires coordinator auth + leader)
- Alert ack: `POST http://localhost:3000/api/alerts/:alert/acknowledge` (requires coordinator auth)
- All write actions use confirmation modals before executing

---

## Component Hierarchy

```
App
├── TabBar (Overview | Execution | Chains | Risk | Streams | Admin)
├── SSEProvider (single connection, distributes events via React context)
├── ConnectionStatus (green dot = connected, yellow = reconnecting)
└── TabContent
    ├── OverviewTab
    │   ├── KpiBar (5 × KpiCard)
    │   ├── ServiceGrid (8 × ServiceCard)
    │   ├── LiveFeed (ring buffer, last 50 events)
    │   └── PipelineHealth (backpressure + DLQ + admission + forwarding)
    ├── ExecutionTab
    │   ├── ExecutionKpis (5 × KpiCard)
    │   ├── LatencyChart (Recharts LineChart, 5min)
    │   ├── SuccessRateChart (Recharts LineChart, 30min)
    │   ├── CircuitBreakerGrid (13 × ChainCBCard + force buttons)
    │   └── RecentExecutionsTable (last 50 rows)
    ├── ChainsTab
    │   └── PartitionSection ×4 (header + ChainCard[])
    ├── RiskTab
    │   ├── DrawdownStateMachine (visual diagram + stats)
    │   ├── AdmissionPanel (counts + bar)
    │   ├── ForwardingPanel (reason breakdown)
    │   └── BackpressurePanel (depth gauge + queue stats)
    ├── StreamsTab
    │   ├── StreamTable (10+ rows)
    │   ├── ConsumerLagChart (Recharts, 15min)
    │   ├── DlqAnalysis (counts + chart)
    │   └── RedisStats (memory + commands)
    └── AdminTab
        ├── CircuitBreakerControl (buttons + reason input + ConfirmModal)
        ├── LogLevelSelector (6 toggle buttons)
        ├── ServiceManagementTable (8 rows + restart buttons + ConfirmModal)
        ├── AlertsTable (rows + ack buttons)
        └── SystemInfo (text display)
```

---

## Auth Flow

1. User navigates to `http://coordinator:3000/`
2. If `DASHBOARD_AUTH_TOKEN` is set, show login prompt. Token stored in `localStorage`.
3. SSE connection: `GET /api/events?token=<token>` (EventSource doesn't support custom headers)
4. REST mutations: `Authorization: Bearer <token>` header via `fetch()`
5. EE circuit breaker actions: `X-API-Key: <CIRCUIT_BREAKER_API_KEY>` header. This key is separate from the dashboard token — stored in dashboard config or prompted on first use.
6. Coordinator validates all tokens via `crypto.timingSafeEqual()`

---

## Backend Changes Required

### New Files
- `services/coordinator/src/api/routes/sse.routes.ts` — SSE endpoint (~80 lines)

### Modified Files
- `services/coordinator/src/api/routes/dashboard.routes.ts` — Replace HTML template with `express.static('public')` fallback to `index.html` for SPA routing
- `services/coordinator/src/api/routes/index.ts` — Register SSE route

### No Changes Required
- All Tier 2 control APIs already exist and are functional
- No new shared packages needed
- No changes to execution engine, partitions, or other services

---

## Dependencies (dashboard/package.json)

```json
{
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "recharts": "^2.12.0",
    "@tanstack/react-query": "^5.50.0"
  },
  "devDependencies": {
    "vite": "^5.4.0",
    "@vitejs/plugin-react": "^4.3.0",
    "tailwindcss": "^3.4.0",
    "postcss": "^8.4.0",
    "autoprefixer": "^10.4.0",
    "typescript": "^5.5.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0"
  }
}
```

**Total: 4 runtime dependencies, 8 dev dependencies.**

---

## Estimated Effort

| Phase | Effort | Description |
|-------|--------|-------------|
| Scaffolding | 0.5 days | Vite + Tailwind + project structure + build pipeline |
| SSE backend | 0.5 days | SSE route + coordinator integration |
| Core hooks | 0.5 days | useSSE, useApi, SSEProvider context |
| Overview tab | 0.5 days | KPIs, service grid, live feed, pipeline health |
| Execution tab | 1 day | Charts, CB grid, executions table, CB controls |
| Chains tab | 0.5 days | Partition sections, chain cards |
| Risk tab | 0.5 days | Drawdown viz, admission, forwarding, backpressure |
| Streams tab | 0.5 days | Stream table, lag chart, DLQ, Redis stats |
| Admin tab | 0.5 days | Controls with confirmation modals |
| Polish | 0.5 days | Responsive tweaks, loading states, error handling |
| **Total** | **~5-6 days** | |

---

## Success Criteria

- [ ] Dashboard loads in <1s from coordinator
- [ ] SSE connection established with auto-reconnect on coordinator restart
- [ ] All 6 tabs render with real data from running services
- [ ] Circuit breaker open/close works with confirmation
- [ ] Log level change reflects immediately
- [ ] Service restart triggers with leader-only enforcement
- [ ] Alert acknowledgment clears cooldown
- [ ] Live feed shows execution results in <1s of occurrence
- [ ] Production build size <500KB (gzipped)
- [ ] Works on Chrome/Firefox latest (operator's browser)
