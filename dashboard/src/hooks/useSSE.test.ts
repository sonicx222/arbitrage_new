import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSSE } from './useSSE';

// ---------------------------------------------------------------------------
// Mock EventSource
// ---------------------------------------------------------------------------
type ESListener = (e: MessageEvent) => void;

class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  url: string;
  readyState = MockEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  private listeners = new Map<string, ESListener[]>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: ESListener) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(cb);
    this.listeners.set(type, arr);
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }

  // --- test helpers ---
  static instances: MockEventSource[] = [];
  static latest(): MockEventSource {
    return MockEventSource.instances[MockEventSource.instances.length - 1];
  }

  simulateOpen() {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.();
  }

  simulateError(readyState: number) {
    this.readyState = readyState;
    this.onerror?.();
  }

  simulateMessage(type: string, data: unknown) {
    const cbs = this.listeners.get(type) ?? [];
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const cb of cbs) cb(event);
  }

  simulateMalformedMessage(type: string) {
    const cbs = this.listeners.get(type) ?? [];
    const event = new MessageEvent(type, { data: 'not-json{{{' });
    for (const cb of cbs) cb(event);
  }
}

// Install mock before each test
beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as Record<string, unknown>).EventSource = MockEventSource;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('useSSE', () => {
  const onEvent = vi.fn();

  beforeEach(() => {
    onEvent.mockClear();
  });

  it('starts with connecting status', () => {
    const { result } = renderHook(() => useSSE({ url: '/api/events', onEvent }));
    expect(result.current.status).toBe('connecting');
  });

  it('creates EventSource with given URL', () => {
    renderHook(() => useSSE({ url: '/api/events?token=abc', onEvent }));
    expect(MockEventSource.latest().url).toBe('/api/events?token=abc');
  });

  it('sets connected on open', () => {
    const { result } = renderHook(() => useSSE({ url: '/api/events', onEvent }));
    act(() => MockEventSource.latest().simulateOpen());
    expect(result.current.status).toBe('connected');
  });

  it('sets disconnected when readyState is CLOSED on error', () => {
    const { result } = renderHook(() => useSSE({ url: '/api/events', onEvent }));
    act(() => MockEventSource.latest().simulateError(MockEventSource.CLOSED));
    expect(result.current.status).toBe('disconnected');
  });

  it('sets connecting when readyState is CONNECTING on error (auto-retry)', () => {
    const { result } = renderHook(() => useSSE({ url: '/api/events', onEvent }));
    act(() => MockEventSource.latest().simulateOpen());
    expect(result.current.status).toBe('connected');

    act(() => MockEventSource.latest().simulateError(MockEventSource.CONNECTING));
    expect(result.current.status).toBe('connecting');
  });

  it('dispatches parsed JSON events to onEvent', () => {
    renderHook(() => useSSE({ url: '/api/events', onEvent }));
    const es = MockEventSource.latest();
    act(() => es.simulateOpen());
    act(() => es.simulateMessage('metrics', { totalExecutions: 10, systemHealth: 95 }));
    expect(onEvent).toHaveBeenCalledWith('metrics', { totalExecutions: 10, systemHealth: 95 });
  });

  it('registers listeners for all event types', () => {
    renderHook(() => useSSE({ url: '/api/events', onEvent }));
    const es = MockEventSource.latest();
    act(() => es.simulateOpen());

    const types = ['metrics', 'services', 'execution-result', 'alert', 'circuit-breaker', 'streams'];
    for (const type of types) {
      onEvent.mockClear();
      act(() => es.simulateMessage(type, { test: true }));
      expect(onEvent).toHaveBeenCalledWith(type, { test: true });
    }
  });

  it('skips malformed JSON without crashing', () => {
    renderHook(() => useSSE({ url: '/api/events', onEvent }));
    const es = MockEventSource.latest();
    act(() => es.simulateOpen());
    act(() => es.simulateMalformedMessage('metrics'));
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('closes EventSource on unmount', () => {
    const { unmount } = renderHook(() => useSSE({ url: '/api/events', onEvent }));
    const es = MockEventSource.latest();
    expect(es.readyState).not.toBe(MockEventSource.CLOSED);
    unmount();
    expect(es.readyState).toBe(MockEventSource.CLOSED);
  });

  it('reconnects when URL changes', () => {
    const { rerender } = renderHook(
      ({ url }) => useSSE({ url, onEvent }),
      { initialProps: { url: '/api/events?token=a' } },
    );
    const firstEs = MockEventSource.latest();
    expect(firstEs.url).toBe('/api/events?token=a');

    rerender({ url: '/api/events?token=b' });
    const secondEs = MockEventSource.latest();
    expect(secondEs.url).toBe('/api/events?token=b');
    expect(firstEs.readyState).toBe(MockEventSource.CLOSED); // old one closed
  });

  it('uses latest onEvent callback via ref (no stale closure)', () => {
    const onEvent1 = vi.fn();
    const onEvent2 = vi.fn();
    const { rerender } = renderHook(
      ({ onEvent: cb }) => useSSE({ url: '/api/events', onEvent: cb }),
      { initialProps: { onEvent: onEvent1 } },
    );
    const es = MockEventSource.latest();
    act(() => es.simulateOpen());

    rerender({ onEvent: onEvent2 });
    act(() => es.simulateMessage('alert', { type: 'test', timestamp: 1 }));

    expect(onEvent1).not.toHaveBeenCalled();
    expect(onEvent2).toHaveBeenCalledWith('alert', { type: 'test', timestamp: 1 });
  });
});
