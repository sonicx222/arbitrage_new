// dashboard/src/components/ServiceCard.tsx
import type { ServiceHealth } from '../lib/types';
import { StatusBadge } from './StatusBadge';
import { formatMemory } from '../lib/format';

interface Props {
  service: ServiceHealth;
}

export function ServiceCard({ service }: Props) {
  return (
    <div className="card flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <StatusBadge status={service.status} label={service.name} />
      </div>
      <div className="flex gap-3 text-[10px] text-gray-500">
        <span>{formatMemory(service.memoryUsage)}</span>
        <span>{Number.isFinite(service.cpuUsage) ? (service.cpuUsage * 100).toFixed(1) : '0.0'}%</span>
      </div>
      {service.error && (
        <div className="text-[10px] text-accent-red truncate" title={service.error}>
          {service.error}
        </div>
      )}
    </div>
  );
}
