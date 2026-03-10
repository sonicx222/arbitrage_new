import { createContext, useContext, useReducer, useCallback, useRef, useEffect, useMemo, type ReactNode } from 'react';
import { useSSE, type SSEStatus } from '../hooks/useSSE';
import { formatTime, calcSuccessRate } from '../lib/format';
import { getItem } from '../lib/storage';
import type { SystemMetrics, ServiceHealth, ExecutionResult, Alert, CircuitBreakerStatus, StreamHealth, FeedItem, ChartPoint, LagPoint } from '../lib/types';

interface SSEState {
  metrics: SystemMetrics | null;
  services: Record<string, ServiceHealth>;
  circuitBreaker: CircuitBreakerStatus | null;
  streams: StreamHealth | null;
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
  | { type: 'reset'; payload?: undefined };

const MAX_FEED = 50;
const MAX_CHART_POINTS = 90;

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
      }
      return { ...state, streams: action.payload, lagData, lastEventTime };
    }
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
      return { ...initialState, lastEventTime: Date.now() };
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
  feed: [],
  chartData: [],
  lagData: [],
  status: 'connecting',
  lastEventTime: null,
  nextFeedId: 0,
};

const SSEContext = createContext<SSEState>(initialState);

export function useSSEData() {
  return useContext(SSEContext);
}

/** @internal exported for unit testing */
export function isObj(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** @internal exported for unit testing */
export function validatePayload(event: string, data: unknown): boolean {
  if (!isObj(data)) return false;
  switch (event) {
    case 'metrics':
      return typeof data.totalExecutions === 'number' && typeof data.systemHealth === 'number';
    case 'services':
      return Object.values(data).every((v) => isObj(v) && typeof (v as Record<string, unknown>).name === 'string');
    case 'execution-result':
      return typeof data.success === 'boolean' && typeof data.chain === 'string';
    case 'circuit-breaker':
      return typeof data.state === 'string';
    case 'streams':
      return Object.values(data).every((v) => isObj(v) && typeof (v as Record<string, unknown>).length === 'number');
    case 'alert':
      return typeof data.type === 'string' && typeof data.timestamp === 'number';
    default:
      return false;
  }
}

export function SSEProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const token = getItem('dashboard_token') ?? '';
  const url = `/api/events${token ? `?token=${encodeURIComponent(token)}` : ''}`;

  const onEvent = useCallback((event: string, data: unknown) => {
    if (!validatePayload(event, data)) {
      console.warn(`[SSE] Skipping malformed ${event} payload`, data);
      return;
    }
    dispatch({ type: event as SSEAction['type'], payload: data as never });
  }, []);

  const { status } = useSSE({ url, onEvent });

  // M-02: Reset chart/feed data on reconnection to avoid false continuity
  // H-04 FIX: Backfill recent alerts from REST after reconnect
  const prevStatusRef = useRef<SSEStatus>(status);
  useEffect(() => {
    const controller = new AbortController();
    if (prevStatusRef.current !== 'connected' && status === 'connected') {
      dispatch({ type: 'reset' });
      // Backfill recent alerts that were missed during disconnect
      fetch(`/api/alerts${token ? `?token=${encodeURIComponent(token)}` : ''}`, { signal: controller.signal })
        .then(res => res.ok ? res.json() : [])
        .then((alerts: unknown[]) => {
          if (Array.isArray(alerts)) {
            for (const alert of alerts.slice(0, 20)) {
              if (validatePayload('alert', alert)) {
                dispatch({ type: 'alert', payload: alert as never });
              }
            }
          }
        })
        .catch(() => { /* Aborted or network error — alerts will arrive via SSE */ });
    }
    prevStatusRef.current = status;
    return () => controller.abort();
  }, [status, token]);

  // H-01 FIX: Memoize provider value to prevent re-renders from parent renders.
  // New object only created when state or status actually changes.
  const value = useMemo(() => ({ ...state, status }), [state, status]);

  return (
    <SSEContext.Provider value={value}>
      {children}
    </SSEContext.Provider>
  );
}
