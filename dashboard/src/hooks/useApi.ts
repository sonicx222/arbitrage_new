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
