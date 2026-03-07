// dashboard/src/components/StatusBadge.tsx
import { statusDot } from '../lib/format';

interface Props {
  status: string;
  label?: string;
}

export function StatusBadge({ status, label }: Props) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full ${statusDot(status)}`} />
      {label && <span className="text-xs">{label}</span>}
    </span>
  );
}
