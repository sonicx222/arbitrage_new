import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useStreams, useMetrics } from '../context/SSEContext';
import { fetchJson } from '../hooks/useApi';
import { Chart } from '../components/Chart';
import { DataTable, type Column } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { SectionHeader } from '../components/SectionHeader';
import { StatRow } from '../components/StatRow';
import { StatusBadge } from '../components/StatusBadge';
import { formatNumber } from '../lib/format';
import { CHART } from '../lib/theme';
import type { StreamHealth } from '../lib/types';

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
        <SectionHeader>Redis Streams ({streamEntries.length})</SectionHeader>
        <DataTable<[string, StreamHealth[string]]>
          columns={[
            { header: 'Stream', render: ([name]) => <span className="font-mono text-gray-300">{name.replace('stream:', '')}</span> },
            { header: 'Length', align: 'right', render: ([, info]) => <>{formatNumber(info.length)}</> },
            { header: 'Pending', align: 'right', render: ([, info]) => (
              <span className={info.pending > 1000 ? 'text-accent-red' : info.pending > 100 ? 'text-accent-yellow' : ''}>
                {formatNumber(info.pending)}
              </span>
            ) },
            { header: 'Groups', align: 'right', render: ([, info]) => <>{info.consumerGroups}</> },
            { header: 'Status', align: 'center', render: ([, info]) => <StatusBadge status={info.status} /> },
          ]}
          data={streamEntries}
          keyExtractor={([name]) => name}
          maxHeight="18rem"
          emptyMessage="No stream data yet"
        />
      </div>

      {/* Consumer Lag Chart */}
      <div className="card">
        <SectionHeader>Total Pending Messages</SectionHeader>
        <Chart data={lagData} dataKey="pending" height={200} color={CHART.area1} fill
          ariaLabel="Total pending messages across all streams over time" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* DLQ Panel */}
        <div className="card">
          <SectionHeader mb="mb-3">Dead Letter Queue</SectionHeader>
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
            <EmptyState message="No DLQ data" />
          )}
        </div>

        {/* Redis Stats */}
        <div className="card">
          <SectionHeader mb="mb-3">Redis Stats</SectionHeader>
          {redisStats ? (
            <div className="space-y-1.5 text-xs">
              {redisStats.commandsPerMinute != null && (
                <StatRow label="Commands/min" value={redisStats.commandsPerMinute.toFixed(1)} />
              )}
              {redisStats.totalCommands != null && (
                <StatRow label="Total Commands" value={formatNumber(redisStats.totalCommands)} />
              )}
              {redisStats.estimatedDailyUsage != null && (
                <StatRow label="Est. Daily" value={formatNumber(redisStats.estimatedDailyUsage)} />
              )}
              {redisStats.dailyLimitPercent != null && (
                <StatRow
                  label="Daily Limit %"
                  value={`${redisStats.dailyLimitPercent.toFixed(1)}%`}
                  color={redisStats.dailyLimitPercent > 80 ? 'text-accent-red' : redisStats.dailyLimitPercent > 50 ? 'text-accent-yellow' : undefined}
                />
              )}
            </div>
          ) : (
            <EmptyState message="Loading Redis stats..." />
          )}
        </div>
      </div>
    </div>
  );
}
