import { memo } from 'react';
import { StatusBadge } from './StatusBadge';

interface Props {
  chain: string;
  status?: string;
  partitionName?: string;
}

export const ChainCard = memo(function ChainCard({ chain, status = 'unknown', partitionName }: Props) {
  return (
    <div className="card flex items-center gap-2 py-2" title={partitionName ? `Status from ${partitionName}` : undefined}>
      <StatusBadge status={status} />
      <span className="text-xs font-medium uppercase">{chain}</span>
    </div>
  );
});
