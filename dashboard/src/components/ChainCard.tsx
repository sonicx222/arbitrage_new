import { memo } from 'react';
import { StatusBadge } from './StatusBadge';
import { CHAIN_COLORS } from '../lib/theme';
import { formatTime, thresholdColor } from '../lib/format';

export interface ChainStats {
  total: number;
  successes: number;
  lastExecTime: number;
  totalLatency: number;
  latencyCount: number;
}

interface Props {
  chain: string;
  status?: string;
  partitionName?: string;
  stats?: ChainStats;
}

export const ChainCard = memo(function ChainCard({ chain, status = 'unknown', partitionName, stats }: Props) {
  const color = CHAIN_COLORS[chain.toLowerCase()];
  const successRate = stats && stats.total > 0 ? ((stats.successes / stats.total) * 100).toFixed(0) : null;
  const avgLatency = stats && stats.latencyCount > 0 ? (stats.totalLatency / stats.latencyCount).toFixed(0) : null;

  return (
    <div className="card py-2 px-3" title={partitionName ? `Status from ${partitionName}` : undefined}>
      <div className="flex items-center gap-2">
        <StatusBadge status={status} />
        {color && <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />}
        <span className="text-xs font-medium uppercase">{chain}</span>
      </div>
      {stats && stats.total > 0 && (
        <div className="mt-1.5 grid grid-cols-3 gap-1 text-[10px] text-gray-500">
          <div>
            <span className="block text-gray-600">Rate</span>
            <span className={thresholdColor(Number(successRate), 80, 50)}>
              {successRate}%
            </span>
          </div>
          <div>
            <span className="block text-gray-600">Latency</span>
            <span className="text-gray-400">{avgLatency ? `${avgLatency}ms` : '—'}</span>
          </div>
          <div>
            <span className="block text-gray-600">Last</span>
            <span className="text-gray-400">{formatTime(stats.lastExecTime)}</span>
          </div>
        </div>
      )}
    </div>
  );
});
