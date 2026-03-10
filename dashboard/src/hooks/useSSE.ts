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
      // EventSource.CLOSED means the browser gave up reconnecting (e.g., server
      // returned a non-retryable response). CONNECTING means it will auto-retry.
      if (es.readyState === EventSource.CLOSED) {
        setStatus('disconnected');
      } else {
        setStatus('connecting');
      }
    };

    const eventTypes = ['metrics', 'services', 'execution-result', 'alert', 'circuit-breaker', 'streams'];
    const debugSSE = typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function' && localStorage.getItem('debug_sse') === 'true';

    for (const type of eventTypes) {
      es.addEventListener(type, (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          if (debugSSE) console.debug('[SSE]', type, data);
          onEventRef.current(type, data);
        } catch (err) {
          console.warn('[SSE] Failed to parse JSON for', type, ':', (e.data as string)?.slice?.(0, 200));
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
