import { useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { useMetrics, useFeed } from '../context/SSEContext';
import { KpiCard } from '../components/KpiCard';
import { CircuitBreakerGrid } from '../components/CircuitBreakerGrid';
import { DataTable } from '../components/DataTable';
import { SectionHeader } from '../components/SectionHeader';
import { ExportCsvButton } from '../components/ExportCsvButton';
import { formatUsd, formatPct, formatNumber, formatTime, calcSuccessRate } from '../lib/format';
import { CHART, TOOLTIP_STYLE, AXIS_TICK, GRID_PROPS, MAX_ERROR_DISPLAY } from '../lib/theme';
import type { FeedItem } from '../lib/types';

type ExecutionFeedItem = Extract<FeedItem, { kind: 'execution' }>;

const EXEC_CSV_HEADERS = ['Time', 'Status', 'Chain', 'DEX', 'Profit USD', 'Gas Cost', 'Latency ms', 'Tx Hash', 'MEV Protected', 'Error'];

const EXPLORER_URLS: Record<string, string> = {
  ethereum: 'https://etherscan.io/tx/',
  bsc: 'https://bscscan.com/tx/',
  polygon: 'https://polygonscan.com/tx/',
  arbitrum: 'https://arbiscan.io/tx/',
  optimism: 'https://optimistic.etherscan.io/tx/',
  base: 'https://basescan.org/tx/',
  avalanche: 'https://snowtrace.io/tx/',
  fantom: 'https://ftmscan.com/tx/',
  zksync: 'https://explorer.zksync.io/tx/',
  linea: 'https://lineascan.build/tx/',
  blast: 'https://blastscan.io/tx/',
  scroll: 'https://scrollscan.com/tx/',
  mantle: 'https://mantlescan.xyz/tx/',
  mode: 'https://modescan.io/tx/',
  solana: 'https://solscan.io/tx/',
};

export function ExecutionTab() {
  const { metrics, chartData } = useMetrics();
  const { feed } = useFeed();

  if (!metrics) {
    return <div className="text-gray-500 text-xs">Waiting for execution data...</div>;
  }

  const successRate = calcSuccessRate(metrics.totalExecutions, metrics.successfulExecutions);
  const failedExecutions = metrics.totalExecutions - metrics.successfulExecutions;

  const executions = useMemo(
    () => feed.filter((item): item is ExecutionFeedItem => item.kind === 'execution').slice(0, 50),
    [feed],
  );

  const exportRows = useMemo(
    () => executions.map((item) => {
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
    [executions],
  );

  return (
    <div className="space-y-4 overflow-auto">
      {/* KPI Row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KpiCard label="Attempts" value={formatNumber(metrics.totalExecutions)} />
        <KpiCard label="Successful" value={formatNumber(metrics.successfulExecutions)} color="text-accent-green" />
        <KpiCard label="Failed" value={formatNumber(failedExecutions)} color={failedExecutions > 0 ? 'text-accent-red' : 'text-gray-100'} />
        <KpiCard label="Success Rate" value={formatPct(successRate)} color={successRate >= 80 ? 'text-accent-green' : successRate >= 50 ? 'text-accent-yellow' : 'text-accent-red'} />
        <KpiCard label="Total Profit" value={formatUsd(metrics.totalProfit)} color="text-accent-green" />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card">
          <SectionHeader>Avg Latency (ms)</SectionHeader>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={chartData}>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis dataKey="time" tick={AXIS_TICK} />
              <YAxis tick={AXIS_TICK} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Line type="monotone" dataKey="latency" stroke={CHART.line1} dot={false} strokeWidth={1.5} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="card">
          <SectionHeader>Success Rate (%)</SectionHeader>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={chartData}>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis dataKey="time" tick={AXIS_TICK} />
              <YAxis tick={AXIS_TICK} domain={[0, 100]} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Line type="monotone" dataKey="successRate" stroke={CHART.line2} dot={false} strokeWidth={1.5} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Circuit Breaker */}
      <CircuitBreakerGrid />

      {/* Recent Executions Table */}
      <div className="card">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-[10px] text-gray-500 uppercase tracking-wider">Recent Executions ({executions.length})</h4>
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
