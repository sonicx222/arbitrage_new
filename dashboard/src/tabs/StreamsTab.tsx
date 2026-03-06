import { useRef } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { useQuery } from '@tanstack/react-query';
import { useSSEData } from '../context/SSEContext';
import { fetchJson } from '../hooks/useApi';
import { StatusBadge } from '../components/StatusBadge';
import { formatNumber, formatTime } from '../lib/format';

interface LagPoint {
  time: string;
  pending: number;
}

interface RedisStats {
  totalCommands?: number;
  commandsPerSecond?: number;
  memoryUsed?: number;
  memoryLimit?: number;
  connectedClients?: number;
  uptimeSeconds?: number;
}

export function StreamsTab() {
  const { streams, metrics } = useSSEData();
  const lagDataRef = useRef<LagPoint[]>([]);

  // Accumulate lag data from SSE stream snapshots
  if (streams) {
    const totalPending = Object.values(streams).reduce((sum, s) => sum + (s.pending ?? 0), 0);
    const now = formatTime(Date.now());
    const last = lagDataRef.current[lagDataRef.current.length - 1];
    if (!last || last.time !== now) {
      lagDataRef.current = [
        ...lagDataRef.current.slice(-90),
        { time: now, pending: totalPending },
      ];
    }
  }

  // Redis stats (one-off fetch, refresh every 30s)
  const { data: redisStats } = useQuery<RedisStats>({
    queryKey: ['redis-stats'],
    queryFn: () => fetchJson('/api/redis/stats'),
    refetchInterval: 30000,
    staleTime: 15000,
    retry: 1,
  });

  // Sort streams by pending descending
  const streamEntries = streams
    ? Object.entries(streams).sort(([, a], [, b]) => (b.pending ?? 0) - (a.pending ?? 0))
    : [];

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
          <AreaChart data={lagDataRef.current}>
            <CartesianGrid strokeDasharray="3 3" stroke="#333" />
            <XAxis dataKey="time" tick={{ fontSize: 9, fill: '#666' }} />
            <YAxis tick={{ fontSize: 9, fill: '#666' }} />
            <Tooltip contentStyle={{ background: '#16213e', border: '1px solid #333', fontSize: 11 }} />
            <Area type="monotone" dataKey="pending" stroke="#ffaa00" fill="#ffaa00" fillOpacity={0.1} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="grid grid-cols-2 gap-4">
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
              {redisStats.totalCommands != null && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Total Commands</span>
                  <span>{formatNumber(redisStats.totalCommands)}</span>
                </div>
              )}
              {redisStats.commandsPerSecond != null && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Commands/sec</span>
                  <span>{redisStats.commandsPerSecond.toFixed(1)}</span>
                </div>
              )}
              {redisStats.connectedClients != null && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Clients</span>
                  <span>{redisStats.connectedClients}</span>
                </div>
              )}
              {redisStats.memoryUsed != null && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Memory</span>
                  <span>{Math.round(redisStats.memoryUsed / 1024 / 1024)}MB</span>
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
