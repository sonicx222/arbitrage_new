import { useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { useQuery } from '@tanstack/react-query';
import { useStreams, useMetrics } from '../context/SSEContext';
import { fetchJson } from '../hooks/useApi';
import { StatusBadge } from '../components/StatusBadge';
import { formatNumber } from '../lib/format';
import { CHART, TOOLTIP_STYLE } from '../lib/theme';

interface RedisStats {
  byCategory?: Record<string, number>;
  byCommand?: Record<string, number>;
  totalCommands?: number;
  trackingStartedAt?: number;
  lastCommandAt?: number;
  commandsPerMinute?: number;
  estimatedDailyUsage?: number;
  dailyLimitPercent?: number;
}

export function StreamsTab() {
  const { streams, lagData } = useStreams();
  const { metrics } = useMetrics();

  // Redis stats (one-off fetch, refresh every 30s)
  const { data: redisStats } = useQuery<RedisStats>({
    queryKey: ['redis-stats'],
    queryFn: () => fetchJson('/api/redis/stats'),
    refetchInterval: 30000,
    staleTime: 15000,
    retry: 1,
  });

  // Sort streams by pending descending
  const streamEntries = useMemo(
    () => streams
      ? Object.entries(streams).sort(([, a], [, b]) => (b.pending ?? 0) - (a.pending ?? 0))
      : [],
    [streams],
  );

  return (
    <div className="space-y-4 overflow-auto">
      {/* Stream Table */}
      <div className="card">
        <h3 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">
          Redis Streams ({streamEntries.length})
        </h3>
        <div className="overflow-auto max-h-72">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-gray-800">
                <th className="text-left py-1 px-2">Stream</th>
                <th className="text-right py-1 px-2">Length</th>
                <th className="text-right py-1 px-2">Pending</th>
                <th className="text-right py-1 px-2">Groups</th>
                <th className="text-center py-1 px-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {streamEntries.map(([name, info]) => (
                <tr key={name} className="border-b border-gray-800/50 hover:bg-surface-lighter/30">
                  <td className="py-1 px-2 font-mono text-gray-300">
                    {name.replace('stream:', '')}
                  </td>
                  <td className="py-1 px-2 text-right">{formatNumber(info.length)}</td>
                  <td className="py-1 px-2 text-right">
                    <span className={info.pending > 1000 ? 'text-accent-red' : info.pending > 100 ? 'text-accent-yellow' : ''}>
                      {formatNumber(info.pending)}
                    </span>
                  </td>
                  <td className="py-1 px-2 text-right">{info.consumerGroups}</td>
                  <td className="py-1 px-2 text-center">
                    <StatusBadge status={info.status} />
                  </td>
                </tr>
              ))}
              {streamEntries.length === 0 && (
                <tr><td colSpan={5} className="text-center py-4 text-gray-600">No stream data yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Consumer Lag Chart */}
      <div className="card">
        <h3 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Total Pending Messages</h3>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={lagData}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} />
            <XAxis dataKey="time" tick={{ fontSize: 9, fill: CHART.tick }} />
            <YAxis tick={{ fontSize: 9, fill: CHART.tick }} />
            <Tooltip contentStyle={TOOLTIP_STYLE} />
            <Area type="monotone" dataKey="pending" stroke={CHART.area1} fill={CHART.area1} fillOpacity={0.1} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* DLQ Panel */}
        <div className="card">
          <h3 className="text-[10px] text-gray-500 uppercase tracking-wider mb-3">Dead Letter Queue</h3>
          {metrics?.dlqMetrics ? (
            <div className="grid grid-cols-5 gap-2 text-center">
              {Object.entries(metrics.dlqMetrics).map(([key, val]) => (
                <div key={key}>
                  <div className={`text-lg font-bold ${val > 0 ? 'text-accent-yellow' : 'text-gray-400'}`}>{val}</div>
                  <div className="text-[10px] text-gray-500 capitalize">{key}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-gray-600 text-xs">No DLQ data</div>
          )}
        </div>

        {/* Redis Stats */}
        <div className="card">
          <h3 className="text-[10px] text-gray-500 uppercase tracking-wider mb-3">Redis Stats</h3>
          {redisStats ? (
            <div className="space-y-1.5 text-xs">
              {redisStats.commandsPerMinute != null && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Commands/min</span>
                  <span>{redisStats.commandsPerMinute.toFixed(1)}</span>
                </div>
              )}
              {redisStats.totalCommands != null && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Total Commands</span>
                  <span>{formatNumber(redisStats.totalCommands)}</span>
                </div>
              )}
              {redisStats.estimatedDailyUsage != null && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Est. Daily</span>
                  <span>{formatNumber(redisStats.estimatedDailyUsage)}</span>
                </div>
              )}
              {redisStats.dailyLimitPercent != null && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Daily Limit %</span>
                  <span className={redisStats.dailyLimitPercent > 80 ? 'text-accent-red' : redisStats.dailyLimitPercent > 50 ? 'text-accent-yellow' : ''}>
                    {redisStats.dailyLimitPercent.toFixed(1)}%
                  </span>
                </div>
              )}
            </div>
          ) : (
            <div className="text-gray-600 text-xs">Loading Redis stats...</div>
          )}
        </div>
      </div>
    </div>
  );
}
