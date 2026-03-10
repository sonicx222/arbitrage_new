import { memo } from 'react';
import { StatusBadge } from './StatusBadge';
import { CHAIN_COLORS } from '../lib/theme';

interface Props {
  chain: string;
  status?: string;
  partitionName?: string;
}

export const ChainCard = memo(function ChainCard({ chain, status = 'unknown', partitionName }: Props) {
  const color = CHAIN_COLORS[chain.toLowerCase()];
  return (
    <div className="card flex items-center gap-2 py-2" title={partitionName ? `Status from ${partitionName}` : undefined}>
      <StatusBadge status={status} />
      {color && <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />}
      <span className="text-xs font-medium uppercase">{chain}</span>
    </div>
  );
});
