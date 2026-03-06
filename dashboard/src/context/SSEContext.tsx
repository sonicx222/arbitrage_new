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
