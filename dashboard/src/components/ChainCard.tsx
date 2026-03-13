import { memo } from 'react';
import { StatusBadge } from './StatusBadge';
import { CHAIN_COLORS } from '../lib/theme';
import { formatTime, formatUsd, thresholdColor } from '../lib/format';

export interface ChainStats {
  total: number;
  successes: number;
  lastExecTime: number;
  totalLatency: number;
  latencyCount: number;
  totalProfit: number;
  totalGasCost: number;
}

interface Props {
  chain: string;
  status?: string;
  partitionName?: string;
  stats?: ChainStats;
}

export const ChainCard = memo(function ChainCard({ chain, status = 'unknown', partitionName, stats }: Props) {
  const color = CHAIN_COLORS[chain.toLowerCase()] ?? '#71717a';
  const successRate = stats && stats.total > 0 ? ((stats.successes / stats.total) * 100).toFixed(0) : null;
  const avgLatency = stats && stats.latencyCount > 0 ? (stats.totalLatency / stats.latencyCount).toFixed(0) : null;

  return (
    <div
      className="card py-2.5 px-3 overflow-hidden"
      style={{
        borderLeftWidth: '3px',
        borderLeftColor: color,
        background: `linear-gradient(135deg, ${color}12 0%, transparent 60%), var(--card-bg)`,
      }}
      title={partitionName ? `Status from ${partitionName}` : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider">{chain}</span>
        <StatusBadge status={status} />
      </div>
      {stats && stats.total > 0 && (
        <>
          <div className="mt-1.5 grid grid-cols-3 gap-1 text-[11px] text-gray-500">
            <div>
              <span className="block text-gray-600">Rate</span>
              <span className={thresholdColor(Number(successRate), 80, 50)}>
                {successRate}%
              </span>
            </div>
            <div>
              <span className="block text-gray-600">Profit</span>
              <span className={stats.totalProfit > 0 ? 'text-accent-green' : stats.totalProfit < 0 ? 'text-accent-red' : 'text-gray-400'}>
                {formatUsd(stats.totalProfit)}
              </span>
            </div>
            <div>
              <span className="block text-gray-600">Gas</span>
              <span className="text-gray-400">{stats.totalGasCost > 0 ? formatUsd(stats.totalGasCost) : '—'}</span>
            </div>
          </div>
          <div className="mt-1 grid grid-cols-3 gap-1 text-[11px] text-gray-500">
            <div>
              <span className="block text-gray-600">Latency</span>
              <span className="text-gray-400">{avgLatency ? `${avgLatency}ms` : '—'}</span>
            </div>
            <div>
              <span className="block text-gray-600">Execs</span>
              <span className="text-gray-400">{stats.total}</span>
            </div>
            <div>
              <span className="block text-gray-600">Last</span>
              <span className="text-gray-400">{formatTime(stats.lastExecTime)}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
});
