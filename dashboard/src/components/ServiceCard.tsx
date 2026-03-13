// dashboard/src/components/ServiceCard.tsx
import { memo } from 'react';
import type { ServiceHealth } from '../lib/types';
import { StatusBadge } from './StatusBadge';
import { formatMemory, formatCpu } from '../lib/format';

interface Props {
  service: ServiceHealth;
}

export const ServiceCard = memo(function ServiceCard({ service }: Props) {
  return (
    <div className="card flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <StatusBadge status={service.status} label={service.name} />
      </div>
      <div className="flex gap-3 text-[11px] text-gray-500">
        <span>{formatMemory(service.memoryUsage)}</span>
        <span>{formatCpu(service.cpuUsage)}%</span>
      </div>
      {service.error && (
        <div className="text-[11px] text-accent-red truncate" title={service.error}>
          {service.error}
        </div>
      )}
    </div>
  );
});
