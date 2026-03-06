# React Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a React operator dashboard embedded in the coordinator, with SSE real-time data and Tier 2 runtime controls.

**Architecture:** Vite React SPA built to static assets, served by coordinator's Express server. Single SSE endpoint pushes metrics/health/events. 6 tabbed views (Overview, Execution, Chains, Risk, Streams, Admin). Admin actions use existing REST APIs.

**Tech Stack:** React 18, Vite 5, Tailwind CSS 3, Recharts, TanStack Query 5, TypeScript 5

**Design Doc:** `docs/plans/2026-03-06-react-dashboard-design.md`

---

## Task 1: Scaffold Dashboard Project

**Files:**
- Create: `dashboard/package.json`
- Create: `dashboard/tsconfig.json`
- Create: `dashboard/vite.config.ts`
- Create: `dashboard/tailwind.config.ts`
- Create: `dashboard/postcss.config.js`
- Create: `dashboard/index.html`
- Create: `dashboard/src/main.tsx`
- Create: `dashboard/src/App.tsx`
- Create: `dashboard/src/styles/globals.css`
- Modify: `.gitignore` — add `services/coordinator/public/` and `dashboard/dist/`

**Step 1: Create dashboard/package.json**

```json
{
  "name": "arbitrage-dashboard",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "recharts": "^2.12.7",
    "@tanstack/react-query": "^5.51.0"
  },
  "devDependencies": {
    "vite": "^5.4.2",
    "@vitejs/plugin-react": "^4.3.1",
    "tailwindcss": "^3.4.10",
    "postcss": "^8.4.41",
    "autoprefixer": "^10.4.20",
    "typescript": "^5.5.4",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0"
  }
}
```

**Step 2: Create dashboard/vite.config.ts**

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, '../services/coordinator/public'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
      '/stats': 'http://localhost:3000',
      '/metrics': 'http://localhost:3000',
      '/ready': 'http://localhost:3000',
    },
  },
});
```

**Step 3: Create dashboard/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"]
}
```

**Step 4: Create Tailwind config files**

`dashboard/tailwind.config.ts`:
```typescript
import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: { DEFAULT: '#1a1a2e', light: '#16213e', lighter: '#1e2d4a' },
        accent: { green: '#00ff88', red: '#ff4444', yellow: '#ffaa00', blue: '#4da6ff' },
      },
    },
  },
  plugins: [],
} satisfies Config;
```

`dashboard/postcss.config.js`:
```javascript
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

**Step 5: Create dashboard/src/styles/globals.css**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  @apply bg-surface text-gray-100 font-mono text-sm;
}

@layer components {
  .card {
    @apply bg-surface-light rounded-lg p-4 border border-gray-800;
  }
  .status-healthy { @apply text-accent-green; }
  .status-degraded { @apply text-accent-yellow; }
  .status-unhealthy { @apply text-accent-red; }
}
```

**Step 6: Create dashboard/index.html**

```html
<!DOCTYPE html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Arbitrage Dashboard</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

**Step 7: Create dashboard/src/main.tsx**

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './styles/globals.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
```

**Step 8: Create dashboard/src/App.tsx (minimal shell)**

```tsx
import { useState } from 'react';

const TABS = ['Overview', 'Execution', 'Chains', 'Risk', 'Streams', 'Admin'] as const;
type Tab = (typeof TABS)[number];

export default function App() {
  const [tab, setTab] = useState<Tab>('Overview');

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-surface-light border-b border-gray-800 px-4 py-2 flex items-center justify-between">
        <span className="text-accent-green font-bold">ARBITRAGE SYSTEM</span>
        <nav className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                tab === t ? 'bg-accent-green/20 text-accent-green' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {t}
            </button>
          ))}
        </nav>
      </header>
      <main className="flex-1 p-4">
        <div className="text-gray-400">
          {tab} tab — content coming soon
        </div>
      </main>
    </div>
  );
}
```

**Step 9: Update .gitignore**

Append to `.gitignore`:
```
# Dashboard build output
services/coordinator/public/
dashboard/dist/
dashboard/node_modules/
```

**Step 10: Install dependencies and verify**

```bash
cd dashboard && npm install
npm run dev
# Expected: Vite dev server at http://localhost:5173 showing tab shell
```

**Step 11: Verify production build**

```bash
cd dashboard && npm run build
# Expected: Output in services/coordinator/public/ (index.html + assets/)
```

**Step 12: Commit**

```bash
git add dashboard/ .gitignore
git commit -m "feat(dashboard): scaffold Vite + React + Tailwind project"
```

---

## Task 2: SSE Backend Endpoint

**Files:**
- Create: `services/coordinator/src/api/routes/sse.routes.ts`
- Modify: `services/coordinator/src/api/routes/index.ts` — register SSE route
- Modify: `services/coordinator/src/api/routes/dashboard.routes.ts` — serve static files for SPA

**Step 1: Create SSE route**

`services/coordinator/src/api/routes/sse.routes.ts`:

```typescript
/**
 * SSE (Server-Sent Events) Route
 *
 * Pushes real-time system data to the React dashboard.
 * Single endpoint multiplexes metrics, services, alerts, execution results,
 * circuit breaker state, and stream health at different frequencies.
 *
 * @see docs/plans/2026-03-06-react-dashboard-design.md
 */

import { Router, Request, Response, RequestHandler } from 'express';
import crypto from 'crypto';
import { getStreamHealthMonitor } from '@arbitrage/core/monitoring';
import type { CoordinatorStateProvider } from '../types';

export function createSSERoutes(state: CoordinatorStateProvider): Router {
  const router = Router();
  const dashboardAuthToken = process.env.DASHBOARD_AUTH_TOKEN;

  router.get('/events', ((req: Request, res: Response) => {
    // Auth: validate token from query param (EventSource can't set headers)
    if (dashboardAuthToken) {
      const token = req.query.token as string | undefined;
      if (!token) {
        res.status(401).json({ error: 'Token required' });
        return;
      }
      const provided = Buffer.from(token);
      const expected = Buffer.from(dashboardAuthToken);
      if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
        res.status(401).json({ error: 'Invalid token' });
        return;
      }
    }

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Send initial state immediately
    send('metrics', state.getSystemMetrics());
    send('services', Object.fromEntries(state.getServiceHealthMap()));

    // Periodic pushes
    const metricsInterval = setInterval(() => {
      send('metrics', state.getSystemMetrics());
    }, 2000);

    const servicesInterval = setInterval(() => {
      send('services', Object.fromEntries(state.getServiceHealthMap()));
    }, 5000);

    const streamsInterval = setInterval(async () => {
      try {
        const monitor = getStreamHealthMonitor();
        const health = await monitor.getHealth();
        send('streams', health);
      } catch {
        // Stream monitor not available yet — skip
      }
    }, 10000);

    // Keepalive comment every 15s to prevent proxy timeouts
    const keepaliveInterval = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15000);

    // Cleanup on disconnect
    req.on('close', () => {
      clearInterval(metricsInterval);
      clearInterval(servicesInterval);
      clearInterval(streamsInterval);
      clearInterval(keepaliveInterval);
    });
  }) as RequestHandler);

  return router;
}
```

**Step 2: Modify index.ts to register SSE route**

In `services/coordinator/src/api/routes/index.ts`, add:

```typescript
import { createSSERoutes } from './sse.routes';
```

Add to re-exports:
```typescript
export { createSSERoutes } from './sse.routes';
```

In `setupAllRoutes()`, add before the `app.get('/ready', ...)` line:
```typescript
  // SSE route for React dashboard
  app.use('/api', createSSERoutes(state));
```

**Step 3: Modify dashboard.routes.ts to serve static SPA**

Replace the entire `router.get('/', ...)` handler with static file serving. Keep the auth middleware and production check. Add `express.static` for the `public/` directory and a fallback to `index.html` for SPA routing:

```typescript
import path from 'path';
import fs from 'fs';
import express from 'express';

// Inside createDashboardRoutes, after auth middleware:
const publicDir = path.join(__dirname, '../../../../public');
const indexPath = path.join(publicDir, 'index.html');

if (fs.existsSync(indexPath)) {
  // Serve React SPA from built assets
  router.use(express.static(publicDir));
  router.get('*', (_req: Request, res: Response) => {
    res.sendFile(indexPath);
  });
} else {
  // Fallback: original HTML dashboard when React build not present
  // (keep existing HTML template code as-is for dev without frontend build)
  router.get('/', (_req: Request, res: Response) => {
    // ... existing HTML dashboard code ...
  });
}
```

**Step 4: Verify SSE endpoint**

```bash
npm run dev:all
# In another terminal:
curl -N "http://localhost:3000/api/events"
# Expected: streaming SSE events (event: metrics, event: services, etc.)
```

**Step 5: Commit**

```bash
git add services/coordinator/src/api/routes/
git commit -m "feat(coordinator): add SSE endpoint for React dashboard"
```

---

## Task 3: Dashboard Types and Utilities

**Files:**
- Create: `dashboard/src/lib/types.ts`
- Create: `dashboard/src/lib/format.ts`

**Step 1: Create types.ts**

Mirror the backend types needed by the dashboard. Do NOT import from `@arbitrage/types` (separate build, no path aliases).

```typescript
// dashboard/src/lib/types.ts
// Mirrors backend types for dashboard consumption.
// Keep in sync with: services/coordinator/src/api/types.ts
//                    shared/types/src/index.ts
//                    shared/types/src/execution.ts

export type Tab = 'Overview' | 'Execution' | 'Chains' | 'Risk' | 'Streams' | 'Admin';

export interface SystemMetrics {
  totalOpportunities: number;
  totalExecutions: number;
  successfulExecutions: number;
  totalProfit: number;
  averageLatency: number;
  averageMemory: number;
  systemHealth: number;
  activeServices: number;
  lastUpdate: number;
  whaleAlerts: number;
  pendingOpportunities: number;
  totalSwapEvents: number;
  totalVolumeUsd: number;
  volumeAggregatesProcessed: number;
  activePairsTracked: number;
  priceUpdatesReceived: number;
  opportunitiesDropped: number;
  dlqMetrics?: {
    total: number;
    expired: number;
    validation: number;
    transient: number;
    unknown: number;
  };
  forwardingMetrics?: {
    expired: number;
    duplicate: number;
    profitRejected: number;
    chainRejected: number;
    gracePeriodDeferred: number;
    notLeader: number;
    circuitOpen: number;
  };
  backpressure?: {
    executionStreamDepthRatio: number;
    active: boolean;
  };
  admissionMetrics?: {
    admitted: number;
    shed: number;
    avgScoreAdmitted: number;
    avgScoreShed: number;
  };
}

export interface ServiceHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'starting' | 'stopping';
  uptime: number;
  memoryUsage: number;
  cpuUsage: number;
  lastHeartbeat: number;
  latency?: number;
  error?: string;
  consecutiveFailures?: number;
  restartCount?: number;
}

export interface ExecutionResult {
  opportunityId: string;
  success: boolean;
  transactionHash?: string;
  actualProfit?: number;
  gasUsed?: number;
  gasCost?: number;
  error?: string;
  timestamp: number;
  chain: string;
  dex: string;
  latencyMs?: number;
}

export type AlertSeverity = 'low' | 'warning' | 'high' | 'critical';

export interface Alert {
  type: string;
  service?: string;
  message?: string;
  severity?: AlertSeverity;
  data?: Record<string, unknown>;
  timestamp: number;
}

export interface CircuitBreakerStatus {
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  consecutiveFailures: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  totalFailures: number;
  totalSuccesses: number;
  timestamp: number;
}

export interface StreamHealth {
  [streamName: string]: {
    length: number;
    pending: number;
    consumerGroups: number;
    status: 'healthy' | 'warning' | 'critical' | 'unknown';
  };
}

// Unified feed item for LiveFeed component
export type FeedItem =
  | { kind: 'execution'; data: ExecutionResult; id: string }
  | { kind: 'alert'; data: Alert; id: string };
```

**Step 2: Create format.ts**

```typescript
// dashboard/src/lib/format.ts

export function formatUsd(n: number): string {
  return n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(2)}`;
}

export function formatPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
}

export function formatMemory(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

export function formatNumber(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function statusColor(status: string): string {
  switch (status) {
    case 'healthy': case 'CLOSED': return 'text-accent-green';
    case 'degraded': case 'HALF_OPEN': return 'text-accent-yellow';
    case 'unhealthy': case 'OPEN': return 'text-accent-red';
    default: return 'text-gray-400';
  }
}

export function statusDot(status: string): string {
  switch (status) {
    case 'healthy': case 'CLOSED': return 'bg-accent-green';
    case 'degraded': case 'HALF_OPEN': return 'bg-accent-yellow';
    case 'unhealthy': case 'OPEN': return 'bg-accent-red';
    default: return 'bg-gray-500';
  }
}
```

**Step 3: Commit**

```bash
git add dashboard/src/lib/
git commit -m "feat(dashboard): add TypeScript types and formatting utilities"
```

---

## Task 4: SSE Hook and Provider

**Files:**
- Create: `dashboard/src/hooks/useSSE.ts`
- Create: `dashboard/src/context/SSEContext.tsx`
- Modify: `dashboard/src/App.tsx` — wrap with SSEProvider

**Step 1: Create useSSE hook**

`dashboard/src/hooks/useSSE.ts`:

```typescript
import { useEffect, useRef, useCallback, useState } from 'react';

export type SSEStatus = 'connecting' | 'connected' | 'disconnected';

interface UseSSEOptions {
  url: string;
  onEvent: (event: string, data: unknown) => void;
}

export function useSSE({ url, onEvent }: UseSSEOptions) {
  const [status, setStatus] = useState<SSEStatus>('connecting');
  const eventSourceRef = useRef<EventSource | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const connect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onopen = () => setStatus('connected');
    es.onerror = () => {
      setStatus('disconnected');
      // EventSource reconnects automatically
    };

    const eventTypes = ['metrics', 'services', 'execution-result', 'alert', 'circuit-breaker', 'streams'];
    for (const type of eventTypes) {
      es.addEventListener(type, (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          onEventRef.current(type, data);
        } catch {
          // Malformed JSON — skip
        }
      });
    }

    return es;
  }, [url]);

  useEffect(() => {
    const es = connect();
    return () => es.close();
  }, [connect]);

  return { status };
}
```

**Step 2: Create SSEContext**

`dashboard/src/context/SSEContext.tsx`:

```tsx
import { createContext, useContext, useReducer, useCallback, type ReactNode } from 'react';
import { useSSE, type SSEStatus } from '../hooks/useSSE';
import type { SystemMetrics, ServiceHealth, ExecutionResult, Alert, CircuitBreakerStatus, StreamHealth, FeedItem } from '../lib/types';

interface SSEState {
  metrics: SystemMetrics | null;
  services: Record<string, ServiceHealth>;
  circuitBreaker: CircuitBreakerStatus | null;
  streams: StreamHealth | null;
  feed: FeedItem[];
  status: SSEStatus;
}

type SSEAction =
  | { type: 'metrics'; payload: SystemMetrics }
  | { type: 'services'; payload: Record<string, ServiceHealth> }
  | { type: 'execution-result'; payload: ExecutionResult }
  | { type: 'alert'; payload: Alert }
  | { type: 'circuit-breaker'; payload: CircuitBreakerStatus }
  | { type: 'streams'; payload: StreamHealth };

const MAX_FEED = 50;
let feedCounter = 0;

function reducer(state: SSEState, action: SSEAction): SSEState {
  switch (action.type) {
    case 'metrics':
      return { ...state, metrics: action.payload };
    case 'services':
      return { ...state, services: action.payload };
    case 'circuit-breaker':
      return { ...state, circuitBreaker: action.payload };
    case 'streams':
      return { ...state, streams: action.payload };
    case 'execution-result': {
      const item: FeedItem = { kind: 'execution', data: action.payload, id: `e-${++feedCounter}` };
      return { ...state, feed: [item, ...state.feed].slice(0, MAX_FEED) };
    }
    case 'alert': {
      const item: FeedItem = { kind: 'alert', data: action.payload, id: `a-${++feedCounter}` };
      return { ...state, feed: [item, ...state.feed].slice(0, MAX_FEED) };
    }
    default:
      return state;
  }
}

const initialState: SSEState = {
  metrics: null,
  services: {},
  circuitBreaker: null,
  streams: null,
  feed: [],
  status: 'connecting',
};

const SSEContext = createContext<SSEState>(initialState);

export function useSSEData() {
  return useContext(SSEContext);
}

export function SSEProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const token = localStorage.getItem('dashboard_token') ?? '';
  const baseUrl = import.meta.env.DEV ? '' : '';
  const url = `${baseUrl}/api/events${token ? `?token=${encodeURIComponent(token)}` : ''}`;

  const onEvent = useCallback((event: string, data: unknown) => {
    dispatch({ type: event as SSEAction['type'], payload: data as never });
  }, []);

  const { status } = useSSE({ url, onEvent });

  return (
    <SSEContext.Provider value={{ ...state, status }}>
      {children}
    </SSEContext.Provider>
  );
}
```

**Step 3: Update App.tsx with SSEProvider**

Replace `dashboard/src/App.tsx`:

```tsx
import { useState } from 'react';
import { SSEProvider, useSSEData } from './context/SSEContext';
import type { Tab } from './lib/types';

const TABS: Tab[] = ['Overview', 'Execution', 'Chains', 'Risk', 'Streams', 'Admin'];

function ConnectionDot() {
  const { status } = useSSEData();
  const color = status === 'connected' ? 'bg-accent-green' : status === 'connecting' ? 'bg-accent-yellow' : 'bg-accent-red';
  return <span className={`inline-block w-2 h-2 rounded-full ${color}`} title={status} />;
}

function Dashboard() {
  const [tab, setTab] = useState<Tab>('Overview');
  const { metrics } = useSSEData();

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-surface-light border-b border-gray-800 px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-accent-green font-bold text-sm">ARBITRAGE SYSTEM</span>
          <ConnectionDot />
          {metrics && (
            <span className="text-xs text-gray-500">
              Health: {metrics.systemHealth.toFixed(0)}%
            </span>
          )}
        </div>
        <nav className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                tab === t ? 'bg-accent-green/20 text-accent-green' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {t}
            </button>
          ))}
        </nav>
      </header>
      <main className="flex-1 p-4 overflow-auto">
        <div className="text-gray-400 text-xs">
          {tab} tab — content coming in next tasks
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <SSEProvider>
      <Dashboard />
    </SSEProvider>
  );
}
```

**Step 4: Update main.tsx** (no change needed, already wraps with QueryClientProvider)

**Step 5: Verify SSE connection**

```bash
# Terminal 1: Start backend
npm run dev:all

# Terminal 2: Start dashboard
cd dashboard && npm run dev

# Open http://localhost:5173 — check browser DevTools Network tab for SSE connection
# Expected: EventSource connection to /api/events showing streaming data
# Connection dot should turn green when connected
```

**Step 6: Commit**

```bash
git add dashboard/src/hooks/ dashboard/src/context/ dashboard/src/App.tsx
git commit -m "feat(dashboard): SSE hook, context provider, and app shell with connection status"
```

---

## Task 5: REST API Hook for Admin Actions

**Files:**
- Create: `dashboard/src/hooks/useApi.ts`

**Step 1: Create useApi hook**

```typescript
// dashboard/src/hooks/useApi.ts
import { useMutation } from '@tanstack/react-query';

function getToken(): string {
  return localStorage.getItem('dashboard_token') ?? '';
}

async function apiFetch(url: string, options: RequestInit = {}): Promise<unknown> {
  const token = getToken();
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  return res.json();
}

// Circuit breaker actions (hits EE on port 3005 in prod, proxied in dev)
export function useCircuitBreakerOpen() {
  return useMutation({
    mutationFn: (reason?: string) =>
      apiFetch('/circuit-breaker/open', {
        method: 'POST',
        body: JSON.stringify({ reason }),
        headers: {
          'X-API-Key': localStorage.getItem('cb_api_key') ?? '',
        },
      }),
  });
}

export function useCircuitBreakerClose() {
  return useMutation({
    mutationFn: () =>
      apiFetch('/circuit-breaker/close', {
        method: 'POST',
        headers: {
          'X-API-Key': localStorage.getItem('cb_api_key') ?? '',
        },
      }),
  });
}

// Log level (coordinator admin route)
export function useSetLogLevel() {
  return useMutation({
    mutationFn: (level: string) =>
      apiFetch('/api/log-level', { method: 'PUT', body: JSON.stringify({ level }) }),
  });
}

// Service restart (coordinator admin route)
export function useRestartService() {
  return useMutation({
    mutationFn: (service: string) =>
      apiFetch(`/api/services/${service}/restart`, { method: 'POST' }),
  });
}

// Alert acknowledgment
export function useAckAlert() {
  return useMutation({
    mutationFn: (alertId: string) =>
      apiFetch(`/api/alerts/${alertId}/acknowledge`, { method: 'POST' }),
  });
}

// Generic fetcher for one-off REST reads (e.g., Redis stats)
export async function fetchJson<T>(url: string): Promise<T> {
  return apiFetch(url) as Promise<T>;
}
```

**Step 2: Commit**

```bash
git add dashboard/src/hooks/useApi.ts
git commit -m "feat(dashboard): REST API hooks for admin actions (CB, log level, restart, alerts)"
```

---

## Task 6: Shared Components

**Files:**
- Create: `dashboard/src/components/KpiCard.tsx`
- Create: `dashboard/src/components/StatusBadge.tsx`
- Create: `dashboard/src/components/ServiceCard.tsx`
- Create: `dashboard/src/components/ConfirmModal.tsx`
- Create: `dashboard/src/components/LiveFeed.tsx`

**Step 1: KpiCard** — Displays a single KPI with label, value, and optional sub-text.

```tsx
// dashboard/src/components/KpiCard.tsx
interface Props {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}

export function KpiCard({ label, value, sub, color = 'text-gray-100' }: Props) {
  return (
    <div className="card flex flex-col">
      <span className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</span>
      <span className={`text-xl font-bold ${color}`}>{value}</span>
      {sub && <span className="text-[10px] text-gray-500 mt-0.5">{sub}</span>}
    </div>
  );
}
```

**Step 2: StatusBadge** — Colored dot + label for service/chain status.

```tsx
// dashboard/src/components/StatusBadge.tsx
import { statusDot } from '../lib/format';

interface Props {
  status: string;
  label?: string;
}

export function StatusBadge({ status, label }: Props) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full ${statusDot(status)}`} />
      {label && <span className="text-xs">{label ?? status}</span>}
    </span>
  );
}
```

**Step 3: ServiceCard** — Compact card for a single service.

```tsx
// dashboard/src/components/ServiceCard.tsx
import type { ServiceHealth } from '../lib/types';
import { StatusBadge } from './StatusBadge';
import { formatMemory } from '../lib/format';

interface Props {
  service: ServiceHealth;
}

export function ServiceCard({ service }: Props) {
  return (
    <div className="card flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <StatusBadge status={service.status} label={service.name} />
      </div>
      <div className="flex gap-3 text-[10px] text-gray-500">
        <span>{formatMemory(service.memoryUsage)}</span>
        <span>{(service.cpuUsage * 100).toFixed(1)}%</span>
      </div>
    </div>
  );
}
```

**Step 4: ConfirmModal** — Generic confirmation dialog for destructive actions.

```tsx
// dashboard/src/components/ConfirmModal.tsx
import { type ReactNode } from 'react';

interface Props {
  open: boolean;
  title: string;
  children?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
  confirmLabel?: string;
  danger?: boolean;
}

export function ConfirmModal({ open, title, children, onConfirm, onCancel, loading, confirmLabel = 'Confirm', danger }: Props) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="card w-96 shadow-xl border border-gray-700">
        <h3 className="font-bold text-sm mb-3">{title}</h3>
        {children && <div className="text-xs text-gray-400 mb-4">{children}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-xs rounded bg-gray-700 hover:bg-gray-600">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={`px-3 py-1.5 text-xs rounded font-medium ${
              danger ? 'bg-accent-red/20 text-accent-red hover:bg-accent-red/30' : 'bg-accent-green/20 text-accent-green hover:bg-accent-green/30'
            } disabled:opacity-50`}
          >
            {loading ? 'Working...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
```

**Step 5: LiveFeed** — Auto-scrolling event feed.

```tsx
// dashboard/src/components/LiveFeed.tsx
import type { FeedItem } from '../lib/types';
import { formatTime, formatUsd } from '../lib/format';

interface Props {
  items: FeedItem[];
}

export function LiveFeed({ items }: Props) {
  return (
    <div className="card flex flex-col h-full">
      <h4 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Live Activity</h4>
      <div className="flex-1 overflow-y-auto space-y-1 text-xs">
        {items.length === 0 && <div className="text-gray-600">Waiting for events...</div>}
        {items.map((item) => (
          <div key={item.id} className="flex gap-2 py-0.5 border-b border-gray-800/50">
            <span className="text-gray-500 shrink-0">{formatTime(item.kind === 'execution' ? item.data.timestamp : item.data.timestamp)}</span>
            {item.kind === 'execution' ? (
              <>
                <span className={item.data.success ? 'text-accent-green' : 'text-accent-red'}>
                  {item.data.success ? '\u2713' : '\u2717'}
                </span>
                <span className="text-gray-300 uppercase">{item.data.chain}</span>
                <span className="text-gray-500">{item.data.dex}</span>
                <span className="ml-auto">
                  {item.data.success && item.data.actualProfit != null
                    ? formatUsd(item.data.actualProfit)
                    : item.data.error?.slice(0, 30)}
                </span>
              </>
            ) : (
              <>
                <span className="text-accent-yellow">\u26A0</span>
                <span className="text-gray-300">{item.data.service}</span>
                <span className="text-gray-500 truncate">{item.data.message ?? item.data.type}</span>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
```

**Step 6: Commit**

```bash
git add dashboard/src/components/
git commit -m "feat(dashboard): shared components (KpiCard, StatusBadge, ServiceCard, ConfirmModal, LiveFeed)"
```

---

## Task 7: Overview Tab

**Files:**
- Create: `dashboard/src/tabs/OverviewTab.tsx`
- Modify: `dashboard/src/App.tsx` — wire tab rendering

**Step 1: Build OverviewTab**

This tab consumes `useSSEData()` for metrics, services, feed, and pipeline health. Layout: KPI bar (5 cards) + service grid (8 cards) + live feed + pipeline health panel. Use the design doc Tab 1 section for exact layout.

Key sub-components within the file:
- `PipelineHealth` — shows backpressure, DLQ, admission, forwarding metrics from `SystemMetrics`
- Uses `KpiCard`, `ServiceCard`, `LiveFeed` from shared components

**Step 2: Wire tab rendering in App.tsx**

Add lazy imports and a switch statement in the Dashboard component:

```tsx
import { OverviewTab } from './tabs/OverviewTab';
// ... future tab imports

// In Dashboard render:
<main className="flex-1 p-4 overflow-auto">
  {tab === 'Overview' && <OverviewTab />}
  {/* other tabs render placeholder for now */}
  {tab !== 'Overview' && <div className="text-gray-500 text-xs">{tab} — coming soon</div>}
</main>
```

**Step 3: Verify with running backend**

```bash
npm run dev:all   # Terminal 1
cd dashboard && npm run dev  # Terminal 2
# Open http://localhost:5173 — Overview tab should show real-time KPIs, services, live feed
```

**Step 4: Commit**

```bash
git add dashboard/src/tabs/OverviewTab.tsx dashboard/src/App.tsx
git commit -m "feat(dashboard): Overview tab with KPIs, service grid, live feed, pipeline health"
```

---

## Task 8: Execution Tab

**Files:**
- Create: `dashboard/src/tabs/ExecutionTab.tsx`
- Create: `dashboard/src/components/CircuitBreakerGrid.tsx`
- Modify: `dashboard/src/App.tsx` — wire tab

**Step 1: Build CircuitBreakerGrid component**

Shows 13 chain cards with CB state, plus Force Open/Close buttons that trigger the `useCircuitBreakerOpen/Close` mutations with `ConfirmModal`.

Chains: `['ethereum', 'bsc', 'arbitrum', 'polygon', 'base', 'optimism', 'avalanche', 'fantom', 'zksync', 'linea', 'blast', 'scroll', 'solana']`

Each card shows: chain abbreviation, state badge (CLOSED=green, OPEN=red, HALF_OPEN=yellow), consecutive failures count.

**Step 2: Build ExecutionTab**

Layout sections:
1. KPI row (5 cards: attempts, successes, failures, rate, profit) from `metrics`
2. Two Recharts `LineChart` components: latency (5min) and success rate (30min). Data accumulated client-side from SSE execution-result events using a `useRef` ring buffer.
3. `CircuitBreakerGrid` component
4. Recent executions table (last 50 from `feed` filtered to executions)

**Step 3: Wire in App.tsx**

```tsx
import { ExecutionTab } from './tabs/ExecutionTab';
// In switch: {tab === 'Execution' && <ExecutionTab />}
```

**Step 4: Commit**

```bash
git add dashboard/src/tabs/ExecutionTab.tsx dashboard/src/components/CircuitBreakerGrid.tsx dashboard/src/App.tsx
git commit -m "feat(dashboard): Execution tab with charts, CB grid, and trade table"
```

---

## Task 9: Chains Tab

**Files:**
- Create: `dashboard/src/tabs/ChainsTab.tsx`
- Create: `dashboard/src/components/ChainCard.tsx`

**Step 1: Build ChainCard** — Shows chain name, status dot, gas price, events, opps, RPC latency.

**Step 2: Build ChainsTab**

4 `PartitionSection` blocks (inline component), each with:
- Header: partition name, region, resource profile, chain count
- Grid of `ChainCard` components

Partition data:
```typescript
const PARTITIONS = [
  { id: 'asia-fast', name: 'P1: Asia-Fast', region: 'Singapore', chains: ['bsc', 'polygon', 'avalanche', 'fantom'] },
  { id: 'l2-turbo', name: 'P2: L2-Turbo', region: 'Singapore', chains: ['arbitrum', 'optimism', 'base', 'scroll', 'blast'] },
  { id: 'high-value', name: 'P3: High-Value', region: 'US-East', chains: ['ethereum', 'zksync', 'linea'] },
  { id: 'solana-native', name: 'P4: Solana', region: 'US-West', chains: ['solana'] },
];
```

Service health from SSE `services` event maps to partition names (`partition-asia-fast`, etc.).

**Step 3: Wire in App.tsx and commit**

```bash
git add dashboard/src/tabs/ChainsTab.tsx dashboard/src/components/ChainCard.tsx dashboard/src/App.tsx
git commit -m "feat(dashboard): Chains tab with partition sections and chain cards"
```

---

## Task 10: Risk Tab

**Files:**
- Create: `dashboard/src/tabs/RiskTab.tsx`

**Step 1: Build RiskTab**

4 panel sections:
1. **DrawdownStateMachine** — Visual row of 4 state boxes (NORMAL, CAUTION, HALT, RECOVERY) with arrows. Current state highlighted with bright border. Stats below from EE `/health` response (fetched via REST on tab focus, since this data isn't in the SSE stream yet).
2. **AdmissionPanel** — Admitted/shed counts from `metrics.admissionMetrics`. Progress bar showing admitted %.
3. **ForwardingPanel** — Table of rejection reasons from `metrics.forwardingMetrics`.
4. **BackpressurePanel** — Wide bar showing `executionStreamDepthRatio` 0-100%. Active/inactive badge.

All data from `useSSEData().metrics` except drawdown state which uses a one-off REST fetch.

**Step 2: Wire and commit**

```bash
git add dashboard/src/tabs/RiskTab.tsx dashboard/src/App.tsx
git commit -m "feat(dashboard): Risk tab with drawdown state machine, admission, forwarding, backpressure"
```

---

## Task 11: Streams Tab

**Files:**
- Create: `dashboard/src/tabs/StreamsTab.tsx`

**Step 1: Build StreamsTab**

Sections:
1. **StreamTable** — from `useSSEData().streams`. Columns: name (shortened, e.g., `price-updates`), length, pending, status dot. Sorted by pending descending.
2. **ConsumerLagChart** — Recharts `AreaChart` showing total pending messages over time. Client-side accumulation from `streams` SSE events in a `useRef` array (keep last 90 snapshots = 15min at 10s intervals).
3. **DLQ panel** — From `metrics.dlqMetrics`. Shows total, expired, validation, transient, unknown as a simple stat row.
4. **Redis stats** — One-off REST fetch to `/api/redis/stats` on tab focus, refreshed every 30s via TanStack Query. Shows total commands, memory usage.

**Step 2: Wire and commit**

```bash
git add dashboard/src/tabs/StreamsTab.tsx dashboard/src/App.tsx
git commit -m "feat(dashboard): Streams tab with stream table, lag chart, DLQ, Redis stats"
```

---

## Task 12: Admin Tab

**Files:**
- Create: `dashboard/src/tabs/AdminTab.tsx`

**Step 1: Build AdminTab**

5 sections using the mutation hooks from `useApi.ts`:

1. **CircuitBreakerControl** — Two buttons: [Force Open All] (danger, red) and [Force Close All] (green). Open shows text input for reason. Both use `ConfirmModal`. Uses `useCircuitBreakerOpen()` and `useCircuitBreakerClose()` mutations. Shows current state from SSE.

2. **LogLevelSelector** — Row of 6 buttons (trace, debug, info, warn, error, fatal). Current level highlighted (fetch current from `/stats` on mount). Click triggers `useSetLogLevel()` mutation. Shows success/error toast inline.

3. **ServiceManagementTable** — Table of services from `useSSEData().services`. Each row: status dot, name, uptime, [Restart] button. Restart uses `useRestartService()` with `ConfirmModal`. Disable restart buttons if not leader (check `metrics` or fetch `/api/leader`).

4. **AlertsTable** — Fetch alerts via REST `/api/alerts` on tab focus. Table with severity badge, service, message, time, [Ack] button. Bulk [Ack All]. Uses `useAckAlert()` mutation.

5. **SystemInfo** — Instance ID, leader status, uptime, active services from SSE metrics.

**Step 2: Wire and commit**

```bash
git add dashboard/src/tabs/AdminTab.tsx dashboard/src/App.tsx
git commit -m "feat(dashboard): Admin tab with CB control, log level, service restart, alerts, system info"
```

---

## Task 13: Build Pipeline and Coordinator Embedding

**Files:**
- Modify: `services/coordinator/src/api/routes/dashboard.routes.ts` — full rewrite for SPA serving
- Modify: `package.json` (root) — add `build:dashboard` script
- Modify: `.gitignore` — verify `services/coordinator/public/` is ignored

**Step 1: Rewrite dashboard.routes.ts**

Replace the entire file to serve the React SPA when built assets exist, fallback to old HTML dashboard when they don't:

```typescript
import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import express from 'express';
import path from 'path';
import fs from 'fs';
import type { CoordinatorStateProvider } from '../types';

export function createDashboardRoutes(state: CoordinatorStateProvider): Router {
  if (process.env.NODE_ENV === 'production' && !process.env.DASHBOARD_AUTH_TOKEN) {
    throw new Error(
      'DASHBOARD_AUTH_TOKEN is required in production. '
      + 'Set DASHBOARD_AUTH_TOKEN environment variable to enable dashboard authentication.'
    );
  }

  const router = Router();
  const dashboardAuthToken = process.env.DASHBOARD_AUTH_TOKEN;

  // Auth middleware (same as before)
  if (dashboardAuthToken) {
    router.use((_req: Request, res: Response, next: NextFunction) => {
      const authHeader = _req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).send('Unauthorized');
        return;
      }
      const provided = Buffer.from(authHeader.slice(7));
      const expected = Buffer.from(dashboardAuthToken);
      if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
        res.status(401).send('Unauthorized');
        return;
      }
      next();
    });
  }

  // Try to serve React SPA
  const publicDir = path.join(__dirname, '../../../../public');
  const indexPath = path.join(publicDir, 'index.html');

  if (fs.existsSync(indexPath)) {
    router.use(express.static(publicDir));
    router.get('*', (_req: Request, res: Response) => {
      res.sendFile(indexPath);
    });
  } else {
    // Fallback: legacy HTML dashboard (for dev without frontend build)
    router.get('/', (_req: Request, res: Response) => {
      const metrics = state.getSystemMetrics();
      const serviceHealth = state.getServiceHealthMap();
      res.send(`<!DOCTYPE html><html><head><title>Arbitrage Dashboard</title>
        <style>body{font-family:monospace;background:#1a1a2e;color:#eee;padding:20px}</style></head>
        <body><h2>Arbitrage System (legacy view)</h2>
        <p>Health: ${metrics.systemHealth.toFixed(1)}% | Services: ${serviceHealth.size} | Executions: ${metrics.totalExecutions}</p>
        <p><small>Build the React dashboard with: cd dashboard && npm run build</small></p>
        <script>setTimeout(()=>location.reload(),10000)</script></body></html>`);
    });
  }

  return router;
}
```

**Step 2: Add root build script**

In root `package.json`, add to scripts:
```json
"build:dashboard": "cd dashboard && npm run build"
```

**Step 3: Verify full pipeline**

```bash
# Build dashboard
npm run build:dashboard

# Start coordinator
npm run dev:all

# Open http://localhost:3000 — should serve React SPA
# Verify SSE connection, all tabs render, admin actions work
```

**Step 4: Commit**

```bash
git add services/coordinator/src/api/routes/dashboard.routes.ts package.json .gitignore
git commit -m "feat(coordinator): embed React dashboard SPA, add build:dashboard script"
```

---

## Task 14: Auth Login Screen

**Files:**
- Create: `dashboard/src/components/LoginScreen.tsx`
- Modify: `dashboard/src/App.tsx` — show login when token needed

**Step 1: Build LoginScreen**

Simple form: token input + optional CB API key input. Stores in `localStorage`. Shows when `DASHBOARD_AUTH_TOKEN` is configured (detected by SSE returning 401).

```tsx
// dashboard/src/components/LoginScreen.tsx
import { useState } from 'react';

interface Props {
  onLogin: () => void;
}

export function LoginScreen({ onLogin }: Props) {
  const [token, setToken] = useState('');
  const [cbKey, setCbKey] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (token) localStorage.setItem('dashboard_token', token);
    if (cbKey) localStorage.setItem('cb_api_key', cbKey);
    onLogin();
  };

  return (
    <div className="min-h-screen flex items-center justify-center">
      <form onSubmit={handleSubmit} className="card w-80 space-y-4">
        <h2 className="text-accent-green font-bold">Arbitrage Dashboard</h2>
        <div>
          <label className="text-xs text-gray-400 block mb-1">Dashboard Token</label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="w-full bg-surface border border-gray-700 rounded px-2 py-1.5 text-sm"
            required
          />
        </div>
        <div>
          <label className="text-xs text-gray-400 block mb-1">Circuit Breaker API Key (optional)</label>
          <input
            type="password"
            value={cbKey}
            onChange={(e) => setCbKey(e.target.value)}
            className="w-full bg-surface border border-gray-700 rounded px-2 py-1.5 text-sm"
          />
        </div>
        <button type="submit" className="w-full bg-accent-green/20 text-accent-green py-1.5 rounded text-sm font-medium hover:bg-accent-green/30">
          Connect
        </button>
      </form>
    </div>
  );
}
```

**Step 2: Wire into App.tsx**

Add auth state that checks `localStorage` for existing token. If SSE returns 401, show login screen. After login, reconnect SSE.

**Step 3: Commit**

```bash
git add dashboard/src/components/LoginScreen.tsx dashboard/src/App.tsx
git commit -m "feat(dashboard): login screen for token auth"
```

---

## Task 15: Polish and Final Verification

**Files:**
- All dashboard files — loading states, error handling, responsive tweaks

**Step 1: Add loading skeleton**

When `metrics` is `null` (SSE not yet connected), show a pulsing skeleton grid instead of empty content. Add to each tab.

**Step 2: Add error boundary**

Wrap `<Dashboard />` in a React error boundary that shows a "Something went wrong" card with retry button.

**Step 3: Verify all success criteria**

Run full verification against the design doc success criteria:

```bash
# 1. Build dashboard
npm run build:dashboard

# 2. Start all services
npm run dev:all

# 3. Open http://localhost:3000
# Check:
# - [ ] Dashboard loads in <1s
# - [ ] SSE connection green dot
# - [ ] Overview tab: KPIs, services, live feed, pipeline
# - [ ] Execution tab: charts, CB grid, trade table
# - [ ] Chains tab: 4 partition sections
# - [ ] Risk tab: drawdown, admission, forwarding, backpressure
# - [ ] Streams tab: stream table, lag, DLQ, Redis
# - [ ] Admin tab: CB control, log level, restart, alerts
# - [ ] Circuit breaker open/close works
# - [ ] Log level change works
# - [ ] Service restart triggers
# - [ ] Alert ack works
# - [ ] Build size < 500KB gzipped
```

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat(dashboard): polish — loading states, error boundary, responsive tweaks"
```

---

## Task Summary

| # | Task | Files | Depends On |
|---|------|-------|------------|
| 1 | Scaffold dashboard project | 10 files | None |
| 2 | SSE backend endpoint | 3 files | None |
| 3 | Types and utilities | 2 files | None |
| 4 | SSE hook and provider | 3 files | Task 3 |
| 5 | REST API hooks | 1 file | Task 1 |
| 6 | Shared components | 5 files | Tasks 3, 4 |
| 7 | Overview tab | 1 file | Tasks 4, 6 |
| 8 | Execution tab | 2 files | Tasks 4, 5, 6 |
| 9 | Chains tab | 2 files | Tasks 4, 6 |
| 10 | Risk tab | 1 file | Tasks 4, 6 |
| 11 | Streams tab | 1 file | Tasks 4, 5, 6 |
| 12 | Admin tab | 1 file | Tasks 4, 5, 6 |
| 13 | Build pipeline embedding | 2 files | Tasks 1, 2 |
| 14 | Auth login screen | 2 files | Task 4 |
| 15 | Polish and verification | All | All |

**Parallelizable groups:**
- Tasks 1, 2, 3 can run in parallel (no dependencies)
- Tasks 7-12 (all tabs) can run in parallel after Tasks 4-6
- Task 13 can run after Tasks 1 + 2
- Task 14 after Task 4
- Task 15 is final
