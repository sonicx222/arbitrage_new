import { useDeferredValue, useMemo, useState } from 'react';
import { useMetrics, useFeed } from '../context/SSEContext';
import { KpiCard } from '../components/KpiCard';
import { KpiGrid } from '../components/KpiGrid';
import { Chart } from '../components/Chart';
import { CircuitBreakerGrid } from '../components/CircuitBreakerGrid';
import { DataTable } from '../components/DataTable';
import { SectionHeader } from '../components/SectionHeader';
import { ExportCsvButton } from '../components/ExportCsvButton';
import { formatUsd, formatPct, formatNumber, formatTime, calcSuccessRate, thresholdColor } from '../lib/format';
import { CHART, MAX_ERROR_DISPLAY, EXPLORER_URLS, CHAIN_COLORS } from '../lib/theme';
import type { FeedItem } from '../lib/types';

type ExecutionFeedItem = Extract<FeedItem, { kind: 'execution' }>;

const EXEC_CSV_HEADERS = ['Time', 'Status', 'Chain', 'DEX', 'Profit USD', 'Gas Cost', 'Latency ms', 'Tx Hash', 'Simulated', 'Error'];

const CHART_RANGES = [
  { label: '5m', points: 150 },
  { label: '15m', points: 450 },
  { label: '30m', points: 900 },
  { label: '1h', points: 1800 },
] as const;

export function ExecutionTab() {
  const { metrics, chartData } = useMetrics();
  const { feed } = useFeed();
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [chartRange, setChartRange] = useState(3); // default: 1h (all data)
  // D-3: Multi-select chain filter for executions
  const [selectedChains, setSelectedChains] = useState<Set<string>>(new Set());

  const allExecutions = useMemo(
    () => feed.filter((item): item is ExecutionFeedItem => item.kind === 'execution').slice(0, 50),
    [feed],
  );

  // P2-23: Gas cost analysis derived from recent executions
  const gasStats = useMemo(() => {
    let totalGas = 0;
    let gasCount = 0;
    let totalProfit = 0;
    const byChain: Record<string, { gas: number; count: number }> = {};
    for (const item of allExecutions) {
      const { gasCost, actualProfit, chain } = item.data;
      if (gasCost != null && Number.isFinite(gasCost) && gasCost < 10_000) {
        totalGas += gasCost;
        gasCount++;
        const key = chain.toLowerCase();
        const entry = byChain[key] ?? (byChain[key] = { gas: 0, count: 0 });
        entry.gas += gasCost;
        entry.count++;
      }
      if (actualProfit != null && Number.isFinite(actualProfit) && Math.abs(actualProfit) < 100_000) totalProfit += actualProfit;
    }
    const avgGas = gasCount > 0 ? totalGas / gasCount : 0;
    const gasRatio = totalProfit > 0 ? (totalGas / totalProfit) * 100 : 0;
    return { totalGas, avgGas, gasRatio, gasCount, byChain };
  }, [allExecutions]);

  // P2-25: Date range filter for chart data
  const visibleChartData = useMemo(
    () => chartData.slice(-CHART_RANGES[chartRange].points),
    [chartData, chartRange],
  );

  // P2-24: CB trip history from alert feed
  type AlertFeedItem = Extract<FeedItem, { kind: 'alert' }>;
  const cbHistory = useMemo(
    () => feed
      .filter((item): item is AlertFeedItem => item.kind === 'alert' && (
        item.data.type === 'circuit_breaker_open' || item.data.type === 'circuit_breaker_closed'
        || item.data.type === 'circuit_breaker_half_open'
        || (item.data.message?.toLowerCase().includes('circuit breaker') ?? false)
      ))
      .slice(0, 10),
    [feed],
  );

  // D-3: Unique chains from executions for filter buttons
  const execChains = useMemo(() => {
    const set = new Set<string>();
    for (const item of allExecutions) set.add(item.data.chain.toLowerCase());
    return Array.from(set).sort();
  }, [allExecutions]);

  const executions = useMemo(() => {
    let list = allExecutions;
    if (selectedChains.size > 0) {
      list = list.filter((item) => selectedChains.has(item.data.chain.toLowerCase()));
    }
    if (deferredSearch) {
      const q = deferredSearch.toLowerCase();
      list = list.filter((item) => {
        const d = item.data;
        return d.chain.toLowerCase().includes(q)
          || d.dex.toLowerCase().includes(q)
          || (d.success ? 'success' : 'failed').includes(q)
          || (d.transactionHash?.toLowerCase().includes(q));
      });
    }
    return list;
  }, [allExecutions, selectedChains, deferredSearch]);

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
        e.isSimulated ? 'yes' : 'no',
        e.error ?? '',
      ];
    }),
    [allExecutions],
  );

  if (!metrics) {
    return <div className="text-gray-500 text-xs" role="status">Waiting for execution data...</div>;
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

      {/* Chart Range Selector */}
      <div className="flex items-center gap-1">
        <span className="text-[11px] text-gray-500 mr-1">Range:</span>
        {CHART_RANGES.map((r, i) => (
          <button
            key={r.label}
            onClick={() => setChartRange(i)}
            className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
              chartRange === i ? 'bg-accent-green/15 text-accent-green' : 'text-gray-500 hover:text-gray-300 bg-[var(--badge-bg)]'
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      {/* P&L Chart */}
      <div className="card">
        <SectionHeader>Cumulative P&L ($)</SectionHeader>
        <Chart data={visibleChartData} dataKey="profit" height={200} color={CHART.line2} fill
          ariaLabel="Cumulative profit and loss over time" formatValue={(v) => `$${v.toFixed(2)}`} />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card">
          <SectionHeader>Avg Latency (ms)</SectionHeader>
          <Chart data={visibleChartData} dataKey="latency" height={180} color={CHART.line1}
            ariaLabel="Average execution latency over time" formatValue={(v) => `${v.toFixed(0)}ms`} />
        </div>
        <div className="card">
          <SectionHeader>Success Rate (%)</SectionHeader>
          <Chart data={visibleChartData} dataKey="successRate" height={180} color={CHART.line2} dashed
            yDomain={[0, 100]} ariaLabel="Execution success rate over time" formatValue={(v) => `${v.toFixed(1)}%`} />
        </div>
      </div>

      {/* Gas Cost Analysis */}
      {gasStats.gasCount > 0 && (
        <div className="card">
          <SectionHeader mb="mb-3">Gas Cost Analysis</SectionHeader>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
            <div>
              <span className="text-[11px] text-gray-500 block">Total Gas</span>
              <span className="text-sm font-bold font-mono">{formatUsd(gasStats.totalGas)}</span>
            </div>
            <div>
              <span className="text-[11px] text-gray-500 block">Avg / Exec</span>
              <span className="text-sm font-bold font-mono">{formatUsd(gasStats.avgGas)}</span>
            </div>
            <div>
              <span className="text-[11px] text-gray-500 block">Gas / Profit</span>
              <span className={`text-sm font-bold font-mono ${gasStats.gasRatio > 50 ? 'text-accent-red' : gasStats.gasRatio > 25 ? 'text-accent-yellow' : 'text-accent-green'}`}>
                {formatPct(gasStats.gasRatio)}
              </span>
            </div>
            <div>
              <span className="text-[11px] text-gray-500 block">Executions</span>
              <span className="text-sm font-bold font-mono">{gasStats.gasCount}</span>
            </div>
          </div>
          {Object.keys(gasStats.byChain).length > 1 && (
            <div>
              <span className="text-[11px] text-gray-500 block mb-1">Per-Chain Gas</span>
              <div className="flex flex-wrap gap-2">
                {Object.entries(gasStats.byChain)
                  .sort(([, a], [, b]) => b.gas - a.gas)
                  .map(([chain, data]) => (
                    <span key={chain} className="text-[11px] px-2 py-1 rounded bg-[var(--badge-bg)] text-gray-400">
                      <span className="uppercase text-gray-300">{chain}</span>{' '}
                      {formatUsd(data.gas)} ({data.count})
                    </span>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Circuit Breaker */}
      <CircuitBreakerGrid />

      {/* CB Trip History */}
      {cbHistory.length > 0 && (
        <div className="card">
          <SectionHeader mb="mb-2">Circuit Breaker History</SectionHeader>
          <div className="space-y-1 text-xs font-mono">
            {cbHistory.map((item) => (
              <div key={item.id} className="flex gap-2 py-1 border-b border-gray-800/50">
                <span className="text-gray-600 shrink-0">{formatTime(item.data.timestamp)}</span>
                <span className="text-accent-yellow">{'\u26A0'}</span>
                <span className="text-gray-400">{item.data.message ?? item.data.type}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* D-3: Chain filter for executions */}
      {execChains.length > 1 && (
        <div className="flex gap-1 flex-wrap items-center">
          <span className="text-[11px] text-gray-500 mr-1">Chains:</span>
          {execChains.map((chain) => {
            const color = CHAIN_COLORS[chain];
            return (
              <button
                key={chain}
                onClick={() => setSelectedChains((prev) => {
                  const next = new Set(prev);
                  if (next.has(chain)) next.delete(chain); else next.add(chain);
                  return next;
                })}
                className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                  selectedChains.has(chain)
                    ? 'bg-accent-green/15 text-accent-green ring-1 ring-accent-green/30'
                    : 'text-gray-500 hover:text-gray-300 bg-[var(--badge-bg)]'
                }`}
                aria-pressed={selectedChains.has(chain)}
              >
                {color && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} />}
                <span className="uppercase">{chain}</span>
              </button>
            );
          })}
          {selectedChains.size > 0 && (
            <button
              onClick={() => setSelectedChains(new Set())}
              className="px-2 py-0.5 rounded text-[11px] text-gray-500 hover:text-gray-300 bg-[var(--badge-bg)]"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* Recent Executions Table */}
      <div className="card">
        <div className="flex items-center justify-between mb-2 gap-2">
          <h4 className="text-[11px] text-gray-500 uppercase tracking-wider shrink-0">Recent Executions ({executions.length})</h4>
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
                item.data.isSimulated ? (
                  <span className="font-mono text-gray-500" title={item.data.transactionHash}>
                    {item.data.transactionHash.slice(0, 8)}...
                    <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-accent-yellow/15 text-accent-yellow">SIM</span>
                  </span>
                ) : (
                  <a
                    href={`${EXPLORER_URLS[item.data.chain.toLowerCase()] ?? ''}${item.data.transactionHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent-blue hover:underline font-mono"
                    title={item.data.transactionHash}
                  >
                    {item.data.transactionHash.slice(0, 8)}...
                  </a>
                )
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
