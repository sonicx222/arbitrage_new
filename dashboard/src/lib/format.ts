// dashboard/src/lib/format.ts

function safe(n: number, fallback: string): string | null {
  if (n == null || !Number.isFinite(n)) return fallback;
  return null;
}

export function formatUsd(n: number): string {
  return safe(n, '$0.00') ?? (n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(2)}`);
}

export function formatPct(n: number): string {
  return safe(n, '0.0%') ?? `${n.toFixed(1)}%`;
}

export function formatDuration(seconds: number): string {
  if (safe(seconds, '') !== null || seconds < 0) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
}

export function formatMemory(bytes: number): string {
  return safe(bytes, '0MB') ?? `${Math.round(bytes / 1024 / 1024)}MB`;
}

export function formatNumber(n: number): string {
  return safe(n, '0') ?? (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
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
