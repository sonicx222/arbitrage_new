// dashboard/src/lib/format.ts

function safe(n: number, fallback: string): string | null {
  if (n == null || !Number.isFinite(n)) return fallback;
  return null;
}

export function formatUsd(n: number): string {
  if (safe(n, '') !== null) return '$0.00';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(1)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

export function formatPct(n: number): string {
  return safe(n, '0.0%') ?? `${n.toFixed(1)}%`;
}

export function formatDuration(seconds: number): string {
  if (safe(seconds, '') !== null || seconds < 0) return '0s';
  if (seconds < 60) return `${Math.floor(seconds)}s`;
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

export function calcSuccessRate(total: number, successful: number): number {
  return total > 0 ? (successful / total) * 100 : 0;
}

export function formatCpu(cpuUsage: number): string {
  return Number.isFinite(cpuUsage) ? (cpuUsage * 100).toFixed(1) : '0.0';
}

/** Format a raw price for display, capping extreme/invalid values. */
export function formatPrice(n: number): string {
  if (!Number.isFinite(n)) return 'N/A';
  if (n === 0) return '0.00';
  if (n > 1e9) return 'INVALID';
  if (n < 0.001 && n > 0) return '<0.001';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Format a spread percentage, capping extreme/invalid values. */
export function formatSpread(pct: number): string {
  if (!Number.isFinite(pct)) return 'N/A';
  if (Math.abs(pct) > 1000) return pct > 0 ? '>999%' : '<-999%';
  return `${pct > 0 ? '+' : ''}${pct.toFixed(3)}%`;
}

/** Returns green/yellow/red text class based on value vs two thresholds (high = green, mid = yellow, below = red). */
export function thresholdColor(value: number, high: number, mid: number): string {
  return value >= high ? 'text-accent-green' : value >= mid ? 'text-accent-yellow' : 'text-accent-red';
}

export function statusColor(status: string): string {
  switch (status) {
    case 'healthy': case 'CLOSED': return 'text-accent-green';
    case 'degraded': case 'warning': case 'HALF_OPEN': return 'text-accent-yellow';
    case 'unhealthy': case 'critical': case 'OPEN': return 'text-accent-red';
    default: return 'text-gray-400';
  }
}

export function statusDot(status: string): string {
  switch (status) {
    case 'healthy': case 'CLOSED': return 'bg-accent-green';
    case 'degraded': case 'warning': case 'HALF_OPEN': return 'bg-accent-yellow';
    case 'unhealthy': case 'critical': case 'OPEN': return 'bg-accent-red';
    default: return 'bg-gray-500';
  }
}
