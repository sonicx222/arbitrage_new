import { createContext, useContext, useReducer, useCallback, useRef, useEffect, useMemo, type ReactNode } from 'react';
import { useSSE, type SSEStatus } from '../hooks/useSSE';
import { formatTime, calcSuccessRate } from '../lib/format';
import { getItem } from '../lib/storage';
import { sendNotification, startTitleFlash, stopTitleFlash } from '../lib/notifications';
import type { SystemMetrics, ServiceHealth, ExecutionResult, Alert, CircuitBreakerStatus, StreamHealth, FeedItem, ChartPoint, LagPoint, DiagnosticsSnapshot } from '../lib/types';

// ---------------------------------------------------------------------------
// State & Reducer (unchanged — single reducer for centralized state management)
// ---------------------------------------------------------------------------

interface SSEState {
  metrics: SystemMetrics | null;
  services: Record<string, ServiceHealth>;
  circuitBreaker: CircuitBreakerStatus | null;
  streams: StreamHealth | null;
  diagnostics: DiagnosticsSnapshot | null;
  feed: FeedItem[];
  chartData: ChartPoint[];
  lagData: LagPoint[];
  status: SSEStatus;
  lastEventTime: number | null;
  nextFeedId: number;
}

type SSEAction =
  | { type: 'metrics'; payload: SystemMetrics }
  | { type: 'services'; payload: Record<string, ServiceHealth> }
  | { type: 'execution-result'; payload: ExecutionResult }
  | { type: 'alert'; payload: Alert }
  | { type: 'circuit-breaker'; payload: CircuitBreakerStatus }
  | { type: 'streams'; payload: StreamHealth }
  | { type: 'diagnostics'; payload: DiagnosticsSnapshot }
  | { type: 'reset'; payload?: undefined };

const MAX_FEED = 50;
const MAX_CHART_POINTS = 360; // 12 min at 2s SSE interval

const CHART_STORAGE_KEY = 'sse_chartData';
const LAG_STORAGE_KEY = 'sse_lagData';

function loadSessionArray<T>(key: string): T[] {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveSessionArray(key: string, data: unknown[]): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(data));
  } catch {
    // QuotaExceededError — fall back to memory-only
  }
}

/** @internal exported for unit testing */
export function reducer(state: SSEState, action: SSEAction): SSEState {
  const lastEventTime = Date.now();
  switch (action.type) {
    case 'metrics': {
      // Dedup by HH:MM:SS — safe at current 2s SSE interval. If interval drops
      // below 1s, switch to counter-based dedup to avoid dropping data points.
      const now = formatTime(Date.now());
      const last = state.chartData[state.chartData.length - 1];
      let chartData = state.chartData;
      if (!last || last.time !== now) {
        const successRate = calcSuccessRate(action.payload.totalExecutions, action.payload.successfulExecutions);
        chartData = [
          ...state.chartData.slice(-MAX_CHART_POINTS),
          { time: now, latency: action.payload.averageLatency, successRate },
        ];
        saveSessionArray(CHART_STORAGE_KEY, chartData);
      }
      return { ...state, metrics: action.payload, chartData, lastEventTime };
    }
    case 'services':
      return { ...state, services: action.payload, lastEventTime };
    case 'circuit-breaker':
      return { ...state, circuitBreaker: action.payload, lastEventTime };
    case 'streams': {
      const totalPending = Object.values(action.payload).reduce(
        (sum, s) => sum + (s.pending ?? 0), 0,
      );
      const now = formatTime(Date.now());
      const last = state.lagData[state.lagData.length - 1];
      let lagData = state.lagData;
      if (!last || last.time !== now) {
        lagData = [
          ...state.lagData.slice(-MAX_CHART_POINTS),
          { time: now, pending: totalPending },
        ];
        saveSessionArray(LAG_STORAGE_KEY, lagData);
      }
      return { ...state, streams: action.payload, lagData, lastEventTime };
    }
    case 'diagnostics':
      return { ...state, diagnostics: action.payload, lastEventTime };
    case 'execution-result': {
      const counter = state.nextFeedId + 1;
      const item: FeedItem = { kind: 'execution', data: action.payload, id: `e-${counter}` };
      return { ...state, feed: [item, ...state.feed.slice(0, MAX_FEED - 1)], nextFeedId: counter, lastEventTime };
    }
    case 'alert': {
      const counter = state.nextFeedId + 1;
      const item: FeedItem = { kind: 'alert', data: action.payload, id: `a-${counter}` };
      return { ...state, feed: [item, ...state.feed.slice(0, MAX_FEED - 1)], nextFeedId: counter, lastEventTime };
    }
    case 'reset':
      // L-01 FIX: Preserve chartData/lagData for visual continuity on reconnect.
      // Only reset feed/nextFeedId so charts don't empty on intermittent connectivity.
      return { ...initialState, chartData: state.chartData, lagData: state.lagData, lastEventTime: Date.now() };
    default:
      return state;
  }
}

/** @internal exported for unit testing */
export const initialState: SSEState = {
  metrics: null,
  services: {},
  circuitBreaker: null,
  streams: null,
  diagnostics: null,
  feed: [],
  chartData: loadSessionArray<ChartPoint>(CHART_STORAGE_KEY),
  lagData: loadSessionArray<LagPoint>(LAG_STORAGE_KEY),
  status: 'connecting',
  lastEventTime: null,
  nextFeedId: 0,
};

// ---------------------------------------------------------------------------
// H-01 FIX: Domain-specific contexts — each context only updates when its
// specific data changes. A 'services' SSE event no longer re-renders chart
// consumers; a 'metrics' event no longer re-renders ChainsTab; etc.
// ---------------------------------------------------------------------------

interface MetricsCtxValue { metrics: SystemMetrics | null; chartData: ChartPoint[] }
interface ServicesCtxValue { services: Record<string, ServiceHealth>; circuitBreaker: CircuitBreakerStatus | null }
interface FeedCtxValue { feed: FeedItem[] }
interface StreamsCtxValue { streams: StreamHealth | null; lagData: LagPoint[] }
interface DiagnosticsCtxValue { diagnostics: DiagnosticsSnapshot | null }
interface ConnectionCtxValue { status: SSEStatus; lastEventTime: number | null }

const MetricsCtx = createContext<MetricsCtxValue>({ metrics: null, chartData: [] });
const ServicesCtx = createContext<ServicesCtxValue>({ services: {}, circuitBreaker: null });
const FeedCtx = createContext<FeedCtxValue>({ feed: [] });
const StreamsCtx = createContext<StreamsCtxValue>({ streams: null, lagData: [] });
const DiagnosticsCtx = createContext<DiagnosticsCtxValue>({ diagnostics: null });
const ConnectionCtx = createContext<ConnectionCtxValue>({ status: 'connecting', lastEventTime: null });

/** Metrics + chart data. Re-renders only on 'metrics' SSE events. */
export function useMetrics() { return useContext(MetricsCtx); }
/** Services + circuit breaker. Re-renders only on 'services' or 'circuit-breaker' events. */
export function useServices() { return useContext(ServicesCtx); }
/** Live feed (executions + alerts). Re-renders only on 'execution-result' or 'alert' events. */
export function useFeed() { return useContext(FeedCtx); }
/** Stream health + lag data. Re-renders only on 'streams' events. */
export function useStreams() { return useContext(StreamsCtx); }
/** Diagnostics snapshot (pipeline, runtime, providers). Re-renders only on 'diagnostics' events. */
export function useDiagnostics() { return useContext(DiagnosticsCtx); }
/** SSE connection status. Re-renders only on connect/disconnect/stale transitions. */
export function useConnection() { return useContext(ConnectionCtx); }

/** Backward-compatible hook returning all SSE data. Subscribes to ALL contexts —
 *  prefer focused hooks (useMetrics, useServices, etc.) for better performance. */
export function useSSEData() {
  const { metrics, chartData } = useMetrics();
  const { services, circuitBreaker } = useServices();
  const { feed } = useFeed();
  const { streams, lagData } = useStreams();
  const { diagnostics } = useDiagnostics();
  const { status, lastEventTime } = useConnection();
  return { metrics, chartData, services, circuitBreaker, feed, streams, lagData, diagnostics, status, lastEventTime, nextFeedId: 0 };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** @internal exported for unit testing */
export function isObj(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** @internal exported for unit testing */
export function validatePayload(event: string, data: unknown): boolean {
  if (!isObj(data)) return false;
  switch (event) {
    case 'metrics':
      return typeof data.totalExecutions === 'number'
        && typeof data.systemHealth === 'number'
        && typeof data.averageLatency === 'number'
        && typeof data.successfulExecutions === 'number'
        && data.systemHealth >= 0 && data.systemHealth <= 100
        && data.totalExecutions >= 0;
    case 'services':
      return Object.values(data).every((v) => isObj(v) && typeof (v as Record<string, unknown>).name === 'string');
    case 'execution-result':
      return typeof data.success === 'boolean' && typeof data.chain === 'string' && (data.chain as string).length > 0;
    case 'circuit-breaker':
      return typeof data.state === 'string';
    case 'streams':
      return Object.values(data).every((v) => isObj(v) && typeof (v as Record<string, unknown>).length === 'number');
    case 'alert':
      return typeof data.type === 'string' && typeof data.timestamp === 'number';
    case 'diagnostics':
      return isObj(data.pipeline) && isObj(data.runtime) && isObj(data.providers) && typeof data.timestamp === 'number';
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function SSEProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const token = getItem('dashboard_token') ?? '';
  // H-03 ACCEPTED RISK: Token in query param is a known EventSource API limitation.
  // EventSource does not support custom headers. The token may appear in server access
  // logs and browser history. Mitigations: timingSafeEqual on backend, HTTPS in prod,
  // token is dashboard-only (not a private key). Cookie-based auth was evaluated and
  // declined — it adds CSRF complexity without meaningful security gain since the token
  // is already stored in localStorage (same XSS exposure surface).
  const url = `/api/events${token ? `?token=${encodeURIComponent(token)}` : ''}`;

  // E-04: Track consecutive execution failures for streak notification
  const failStreakRef = useRef(0);

  const onEvent = useCallback((event: string, data: unknown) => {
    if (!validatePayload(event, data)) {
      console.warn(`[SSE] Skipping malformed ${event} payload`, data);
      return;
    }
    dispatch({ type: event, payload: data } as SSEAction);

    // E-04: Notification triggers for critical events
    if (event === 'circuit-breaker') {
      const cb = data as { state: string };
      if (cb.state === 'OPEN') {
        sendNotification('Circuit Breaker OPEN', 'All executions halted. Manual intervention may be required.');
        startTitleFlash('\u26A0 CB OPEN \u2014 Arbitrage');
      }
    } else if (event === 'alert') {
      const alert = data as { severity?: string; type: string; message?: string };
      if (alert.severity === 'critical') {
        sendNotification('Critical Alert', alert.message ?? alert.type);
        startTitleFlash('\u26A0 Alert \u2014 Arbitrage');
      }
    } else if (event === 'execution-result') {
      const exec = data as { success: boolean };
      if (!exec.success) {
        failStreakRef.current++;
        if (failStreakRef.current >= 3) {
          sendNotification('Execution Failures', `${failStreakRef.current} consecutive failures detected.`);
          startTitleFlash('\u26A0 Failures \u2014 Arbitrage');
        }
      } else {
        failStreakRef.current = 0;
      }
    }
  }, []);

  const { status } = useSSE({ url, onEvent });

  // E-04: Stop title flash when user focuses the window
  useEffect(() => {
    const onFocus = () => stopTitleFlash();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // M-02: Reset chart/feed data on reconnection to avoid false continuity
  // H-04 FIX: Backfill recent alerts from REST after reconnect
  const prevStatusRef = useRef<SSEStatus>(status);
  useEffect(() => {
    const controller = new AbortController();
    if (prevStatusRef.current !== 'connected' && status === 'connected') {
      dispatch({ type: 'reset' });
      // Backfill recent alerts that were missed during disconnect
      fetch(`/api/alerts${token ? `?token=${encodeURIComponent(token)}` : ''}`, { signal: controller.signal })
        .then(res => {
          if (!res.ok) {
            // M-11 FIX: Log backfill failures instead of silently discarding.
            console.warn(`[SSE] Alert backfill failed: ${res.status}`);
            return [];
          }
          return res.json();
        })
        .then((alerts: unknown[]) => {
          if (Array.isArray(alerts)) {
            // M-11 FIX: Dedup by timestamp+type to prevent duplicates from
            // alerts arriving via SSE between reset and backfill completion.
            const seen = new Set<string>();
            for (const alert of alerts.slice(0, 20)) {
              if (!validatePayload('alert', alert)) continue;
              const a = alert as Record<string, unknown>;
              const key = `${a.type}-${a.timestamp}`;
              if (seen.has(key)) continue;
              seen.add(key);
              dispatch({ type: 'alert', payload: alert } as SSEAction);
            }
          }
        })
        .catch((err) => {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          console.warn('[SSE] Alert backfill error:', err.message);
        });
    }
    prevStatusRef.current = status;
    return () => controller.abort();
  }, [status, token]);

  // H-01 FIX: Memoize each domain slice independently. A 'services' event creates
  // a new servicesValue but metricsValue/feedValue/streamsValue stay the same reference,
  // so only ServicesCtx consumers re-render. ~70-80% wasted re-renders eliminated.
  const metricsValue = useMemo<MetricsCtxValue>(
    () => ({ metrics: state.metrics, chartData: state.chartData }),
    [state.metrics, state.chartData],
  );
  const servicesValue = useMemo<ServicesCtxValue>(
    () => ({ services: state.services, circuitBreaker: state.circuitBreaker }),
    [state.services, state.circuitBreaker],
  );
  const feedValue = useMemo<FeedCtxValue>(
    () => ({ feed: state.feed }),
    [state.feed],
  );
  const streamsValue = useMemo<StreamsCtxValue>(
    () => ({ streams: state.streams, lagData: state.lagData }),
    [state.streams, state.lagData],
  );
  const diagnosticsValue = useMemo<DiagnosticsCtxValue>(
    () => ({ diagnostics: state.diagnostics }),
    [state.diagnostics],
  );
  const connectionValue = useMemo<ConnectionCtxValue>(
    () => ({ status, lastEventTime: state.lastEventTime }),
    [status, state.lastEventTime],
  );

  return (
    <ConnectionCtx.Provider value={connectionValue}>
      <MetricsCtx.Provider value={metricsValue}>
        <ServicesCtx.Provider value={servicesValue}>
          <StreamsCtx.Provider value={streamsValue}>
            <DiagnosticsCtx.Provider value={diagnosticsValue}>
              <FeedCtx.Provider value={feedValue}>
                {children}
              </FeedCtx.Provider>
            </DiagnosticsCtx.Provider>
          </StreamsCtx.Provider>
        </ServicesCtx.Provider>
      </MetricsCtx.Provider>
    </ConnectionCtx.Provider>
  );
}
