import { memo } from 'react';
import { statusDot, statusColor } from '../lib/format';

interface Props {
  status: string;
  label?: string;
}

// P2-18: Non-color status symbol for WCAG 1.4.1 compliance
function statusSymbol(status: string): string {
  switch (status) {
    case 'healthy': case 'CLOSED': return '\u2713';       // ✓
    case 'degraded': case 'warning': case 'HALF_OPEN': return '\u25B2'; // ▲
    case 'unhealthy': case 'critical': case 'OPEN': return '\u2717';    // ✗
    default: return '\u2014'; // —
  }
}

export const StatusBadge = memo(function StatusBadge({ status, label }: Props) {
  const isActive = status === 'healthy' || status === 'warning' || status === 'CLOSED';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="relative flex h-2 w-2">
        {isActive && (
          <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-40 ${statusDot(status)}`} />
        )}
        <span className={`relative inline-flex rounded-full h-2 w-2 ${statusDot(status)}`} />
      </span>
      <span className={`text-[11px] leading-none ${statusColor(status)}`} aria-hidden="true">{statusSymbol(status)}</span>
      {label
        ? <span className="text-xs font-medium">{label}</span>
        : <span className="sr-only">{status}</span>}
    </span>
  );
});
