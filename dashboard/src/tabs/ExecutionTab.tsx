import { useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { useMetrics, useFeed } from '../context/SSEContext';
import { KpiCard } from '../components/KpiCard';
import { CircuitBreakerGrid } from '../components/CircuitBreakerGrid';
import { formatUsd, formatPct, formatNumber, formatTime, calcSuccessRate } from '../lib/format';
import { CHART } from '../lib/theme';

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
    () => feed.filter((item) => item.kind === 'execution').slice(0, 50),
    [feed],
  );

  return (
    <div className="space-y-4 overflow-auto">
      {/* KPI Row */}
      <div className="grid grid-cols-5 gap-3">
        <KpiCard label="Attempts" value={formatNumber(metrics.totalExecutions)} />
        <KpiCard label="Successful" value={formatNumber(metrics.successfulExecutions)} color="text-accent-green" />
        <KpiCard label="Failed" value={formatNumber(failedExecutions)} color={failedExecutions > 0 ? 'text-accent-red' : 'text-gray-100'} />
        <KpiCard label="Success Rate" value={formatPct(successRate)} color={successRate >= 80 ? 'text-accent-green' : successRate >= 50 ? 'text-accent-yellow' : 'text-accent-red'} />
        <KpiCard label="Total Profit" value={formatUsd(metrics.totalProfit)} color="text-accent-green" />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-2 gap-4">
        <div className="card">
          <h4 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Avg Latency (ms)</h4>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} />
              <XAxis dataKey="time" tick={{ fontSize: 9, fill: CHART.tick }} />
              <YAxis tick={{ fontSize: 9, fill: CHART.tick }} />
              <Tooltip contentStyle={{ background: CHART.tooltipBg, border: `1px solid ${CHART.tooltipBorder}`, fontSize: 11, color: CHART.tooltipText }} />
              <Line type="monotone" dataKey="latency" stroke={CHART.line1} dot={false} strokeWidth={1.5} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="card">
          <h4 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Success Rate (%)</h4>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} />
              <XAxis dataKey="time" tick={{ fontSize: 9, fill: CHART.tick }} />
              <YAxis tick={{ fontSize: 9, fill: CHART.tick }} domain={[0, 100]} />
              <Tooltip contentStyle={{ background: CHART.tooltipBg, border: `1px solid ${CHART.tooltipBorder}`, fontSize: 11, color: CHART.tooltipText }} />
              <Line type="monotone" dataKey="successRate" stroke={CHART.line2} dot={false} strokeWidth={1.5} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Circuit Breaker */}
      <CircuitBreakerGrid />

      {/* Recent Executions Table */}
      <div className="card">
        <h4 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Recent Executions ({executions.length})</h4>
        <div className="overflow-auto max-h-64">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-gray-800">
                <th className="text-left py-1 px-2">Time</th>
                <th className="text-left py-1 px-2">Status</th>
                <th className="text-left py-1 px-2">Chain</th>
                <th className="text-left py-1 px-2">DEX</th>
                <th className="text-right py-1 px-2">Profit</th>
                <th className="text-right py-1 px-2">Latency</th>
                <th className="text-left py-1 px-2">Tx</th>
              </tr>
            </thead>
            <tbody>
              {executions.map((item) => {
                if (item.kind !== 'execution') return null;
                const exec = item.data;
                return (
                  <tr key={item.id} className="border-b border-gray-800/50 hover:bg-surface-lighter/30">
                    <td className="py-1 px-2 text-gray-500">{formatTime(exec.timestamp)}</td>
                    <td className="py-1 px-2">
                      <span className={exec.success ? 'text-accent-green' : 'text-accent-red'}>
                        {exec.success ? '\u2713' : '\u2717'}
                      </span>
                    </td>
                    <td className="py-1 px-2 text-gray-300 uppercase">{exec.chain}</td>
                    <td className="py-1 px-2 text-gray-400">{exec.dex}</td>
                    <td className="py-1 px-2 text-right">
                      {exec.success && exec.actualProfit != null ? formatUsd(exec.actualProfit) : exec.error?.slice(0, 20) ?? '-'}
                    </td>
                    <td className="py-1 px-2 text-right text-gray-500">{exec.latencyMs != null ? `${exec.latencyMs}ms` : '-'}</td>
                    <td className="py-1 px-2">
                      {exec.transactionHash ? (
                        <a
                          href={`${EXPLORER_URLS[exec.chain.toLowerCase()] ?? ''}${exec.transactionHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-accent-blue hover:underline font-mono"
                          title={exec.transactionHash}
                        >
                          {exec.transactionHash.slice(0, 8)}...
                        </a>
                      ) : <span className="text-gray-600">-</span>}
                    </td>
                  </tr>
                );
              })}
              {executions.length === 0 && (
                <tr><td colSpan={7} className="text-center py-4 text-gray-600">No executions yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
