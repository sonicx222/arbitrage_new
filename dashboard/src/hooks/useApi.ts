// dashboard/src/hooks/useApi.ts
// L-08: Bearer token auth provides implicit CSRF protection — browsers do not
// auto-attach Authorization headers on cross-origin requests (unlike cookies).
// If cookie-based auth is ever adopted, add SameSite=Strict + CSRF token.
import { useMutation } from '@tanstack/react-query';
import { getItem } from '../lib/storage';

const API_TIMEOUT_MS = 30_000;

// H-02 FIX: Module-level callback for 401 auto-logout. App.tsx registers the
// actual logout handler via setOnUnauthorized() on mount.
let onUnauthorized: (() => void) | null = null;
export function setOnUnauthorized(fn: (() => void) | null) {
  onUnauthorized = fn;
}

function getToken(): string {
  return getItem('dashboard_token') ?? '';
}

async function apiFetch(url: string, options: RequestInit = {}): Promise<unknown> {
  const token = getToken();
  // M-04 FIX: AbortController with 30s timeout prevents indefinite hangs.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      signal: options.signal ?? controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${API_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }
  clearTimeout(timeoutId);
  if (!res.ok) {
    // H-02 FIX: Detect 401 and trigger auto-logout.
    if (res.status === 401 && onUnauthorized) {
      onUnauthorized();
    }
    // M-05 FIX: Sanitize HTML error bodies — show generic message for non-JSON.
    const contentType = res.headers.get('content-type') ?? '';
    const body = contentType.includes('application/json')
      ? await res.text()
      : `Server error`;
    throw new Error(`${res.status}: ${body}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Circuit breaker actions (proxied through coordinator with auth)
export function useCircuitBreakerOpen() {
  return useMutation({
    mutationFn: (reason?: string) =>
      apiFetch('/circuit-breaker/open', {
        method: 'POST',
        body: JSON.stringify({ reason }),
        headers: {
          // X-API-Key for EE-level auth (forwarded by coordinator proxy)
          'X-API-Key': getItem('cb_api_key') ?? '',
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
          'X-API-Key': getItem('cb_api_key') ?? '',
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
