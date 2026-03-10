import { memo } from 'react';
import { statusDot } from '../lib/format';

interface Props {
  status: string;
  label?: string;
}

export const StatusBadge = memo(function StatusBadge({ status, label }: Props) {
  const isActive = status === 'healthy' || status === 'CLOSED';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="relative flex h-2 w-2">
        {isActive && (
          <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-40 ${statusDot(status)}`} />
        )}
        <span className={`relative inline-flex rounded-full h-2 w-2 ${statusDot(status)}`} />
      </span>
      {label && <span className="text-xs font-medium">{label}</span>}
    </span>
  );
});
