import { useMemo, useState } from 'react';
import { useMetrics, useFeed } from '../context/SSEContext';
import { KpiCard } from '../components/KpiCard';
import { KpiGrid } from '../components/KpiGrid';
import { Chart } from '../components/Chart';
import { CircuitBreakerGrid } from '../components/CircuitBreakerGrid';
import { DataTable } from '../components/DataTable';
import { SectionHeader } from '../components/SectionHeader';
import { ExportCsvButton } from '../components/ExportCsvButton';
import { formatUsd, formatPct, formatNumber, formatTime, calcSuccessRate, thresholdColor } from '../lib/format';
import { CHART, MAX_ERROR_DISPLAY, EXPLORER_URLS } from '../lib/theme';
import type { FeedItem } from '../lib/types';

type ExecutionFeedItem = Extract<FeedItem, { kind: 'execution' }>;

const EXEC_CSV_HEADERS = ['Time', 'Status', 'Chain', 'DEX', 'Profit USD', 'Gas Cost', 'Latency ms', 'Tx Hash', 'MEV Protected', 'Error'];

export function ExecutionTab() {
  const { metrics, chartData } = useMetrics();
  const { feed } = useFeed();
  const [search, setSearch] = useState('');

  const allExecutions = useMemo(
    () => feed.filter((item): item is ExecutionFeedItem => item.kind === 'execution').slice(0, 50),
    [feed],
  );

  const executions = useMemo(() => {
    if (!search) return allExecutions;
    const q = search.toLowerCase();
    return allExecutions.filter((item) => {
      const d = item.data;
      return d.chain.toLowerCase().includes(q)
        || d.dex.toLowerCase().includes(q)
        || (d.success ? 'success' : 'failed').includes(q)
        || (d.transactionHash?.toLowerCase().includes(q));
    });
  }, [allExecutions, search]);

  const exportRows = useMemo(
    () => allExecutions.map((item) => {
      const e = item.data;
      return [
        new Date(e.timestamp).toISOString(),
        e.success ? 'success' : 'failed',
        e.chain,
        e.dex,
        e.actualProfit ?? '',
        e.gasCost ?? '',
        e.latencyMs ?? '',
        e.transactionHash ?? '',
        e.usedMevProtection ? 'yes' : 'no',
        e.error ?? '',
      ];
    }),
    [allExecutions],
  );

  if (!metrics) {
    return <div className="text-gray-500 text-xs">Waiting for execution data...</div>;
  }

  const successRate = calcSuccessRate(metrics.totalExecutions, metrics.successfulExecutions);
  const failedExecutions = metrics.totalExecutions - metrics.successfulExecutions;

  return (
    <div className="space-y-4 overflow-auto">
      {/* KPI Row */}
      <KpiGrid>
        <KpiCard label="Attempts" value={formatNumber(metrics.totalExecutions)} />
        <KpiCard label="Successful" value={formatNumber(metrics.successfulExecutions)} color="text-accent-green" />
        <KpiCard label="Failed" value={formatNumber(failedExecutions)} color={failedExecutions > 0 ? 'text-accent-red' : 'text-gray-100'} />
        <KpiCard label="Success Rate" value={formatPct(successRate)} color={thresholdColor(successRate, 80, 50)} />
        <KpiCard label="Total Profit" value={formatUsd(metrics.totalProfit)} color="text-accent-green" />
      </KpiGrid>

      {/* P&L Chart */}
      <div className="card">
        <SectionHeader>Cumulative P&L ($)</SectionHeader>
        <Chart data={chartData} dataKey="profit" height={200} color={CHART.line2} fill
          ariaLabel="Cumulative profit and loss over time" formatValue={(v) => `$${v.toFixed(2)}`} />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card">
          <SectionHeader>Avg Latency (ms)</SectionHeader>
          <Chart data={chartData} dataKey="latency" height={180} color={CHART.line1}
            ariaLabel="Average execution latency over time" formatValue={(v) => `${v.toFixed(0)}ms`} />
        </div>
        <div className="card">
          <SectionHeader>Success Rate (%)</SectionHeader>
          <Chart data={chartData} dataKey="successRate" height={180} color={CHART.line2}
            yDomain={[0, 100]} ariaLabel="Execution success rate over time" formatValue={(v) => `${v.toFixed(1)}%`} />
        </div>
      </div>

      {/* Circuit Breaker */}
      <CircuitBreakerGrid />

      {/* Recent Executions Table */}
      <div className="card">
        <div className="flex items-center justify-between mb-2 gap-2">
          <h4 className="text-[10px] text-gray-500 uppercase tracking-wider shrink-0">Recent Executions ({executions.length})</h4>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by chain, dex, status..."
            className="flex-1 max-w-[200px] px-2 py-1 rounded bg-surface-lighter border border-gray-800 text-xs text-gray-300 placeholder:text-gray-600 focus:outline-none focus:border-gray-600"
          />
          <ExportCsvButton
            headers={EXEC_CSV_HEADERS}
            rows={exportRows}
            filenamePrefix="executions"
            disabled={executions.length === 0}
            label="Export CSV"
          />
        </div>
        <DataTable<ExecutionFeedItem>
          columns={[
            { header: 'Time', render: (item) => <span className="text-gray-500">{formatTime(item.data.timestamp)}</span> },
            { header: 'Status', render: (item) => (
              <span className={item.data.success ? 'text-accent-green' : 'text-accent-red'}>
                {item.data.success ? '\u2713' : '\u2717'}
              </span>
            ) },
            { header: 'Chain', render: (item) => <span className="text-gray-300 uppercase">{item.data.chain}</span> },
            { header: 'DEX', render: (item) => <span className="text-gray-400">{item.data.dex}</span> },
            { header: 'Profit (USD)', align: 'right', render: (item) => (
              <>{item.data.success && item.data.actualProfit != null ? formatUsd(item.data.actualProfit) : item.data.error?.slice(0, MAX_ERROR_DISPLAY) ?? '-'}</>
            ) },
            { header: 'Gas', align: 'right', render: (item) => <span className="text-gray-500">{item.data.gasCost != null ? formatUsd(item.data.gasCost) : '-'}</span> },
            { header: 'Latency', align: 'right', render: (item) => <span className="text-gray-500">{item.data.latencyMs != null ? `${item.data.latencyMs}ms` : '-'}</span> },
            { header: 'Tx', render: (item) => (
              item.data.transactionHash ? (
                <a
                  href={`${EXPLORER_URLS[item.data.chain.toLowerCase()] ?? ''}${item.data.transactionHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent-blue hover:underline font-mono"
                  title={item.data.transactionHash}
                >
                  {item.data.transactionHash.slice(0, 8)}...
                </a>
              ) : <span className="text-gray-600">-</span>
            ) },
          ]}
          data={executions}
          keyExtractor={(item) => item.id}
          maxHeight="16rem"
          emptyMessage="No executions yet"
        />
      </div>
    </div>
  );
}
