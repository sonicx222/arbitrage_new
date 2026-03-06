import { StatusBadge } from './StatusBadge';

interface Props {
  chain: string;
  status?: string;
}

export function ChainCard({ chain, status = 'unknown' }: Props) {
  return (
    <div className="card flex items-center gap-2 py-2">
      <StatusBadge status={status} />
      <span className="text-xs font-medium uppercase">{chain}</span>
    </div>
  );
}
