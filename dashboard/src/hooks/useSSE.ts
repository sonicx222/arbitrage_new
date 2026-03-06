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
