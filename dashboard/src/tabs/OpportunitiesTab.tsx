import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../hooks/useApi';
import { KpiCard } from '../components/KpiCard';
import { StatusBadge } from '../components/StatusBadge';
import { formatTime, formatUsd, formatNumber, formatPct } from '../lib/format';
import { CHAIN_COLORS } from '../lib/theme';
import { toCsv, downloadCsv } from '../lib/export';
import type { Opportunity } from '../lib/types';

type SortField = 'timestamp' | 'chain' | 'profit' | 'confidence';

export function OpportunitiesTab() {
  const [sortField, setSortField] = useState<SortField>('timestamp');
  const [sortAsc, setSortAsc] = useState(false);
  const [chainFilter, setChainFilter] = useState<string>('all');

  const { data: opportunities = [], isLoading, isError } = useQuery<Opportunity[]>({
    queryKey: ['opportunities'],
    queryFn: () => fetchJson('/api/opportunities'),
    refetchInterval: 10000,
    staleTime: 5000,
    retry: 1,
  });

  const chains = useMemo(() => {
    const set = new Set<string>();
    for (const opp of opportunities) {
      if (opp.chain) set.add(opp.chain);
    }
    return Array.from(set).sort();
  }, [opportunities]);

  const filtered = useMemo(() => {
    let list = chainFilter === 'all' ? opportunities : opportunities.filter((o) => o.chain === chainFilter);
    list = [...list].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'timestamp': cmp = a.timestamp - b.timestamp; break;
        case 'chain': cmp = (a.chain ?? '').localeCompare(b.chain ?? ''); break;
        case 'profit': cmp = (a.estimatedProfit ?? a.expectedProfit ?? 0) - (b.estimatedProfit ?? b.expectedProfit ?? 0); break;
        case 'confidence': cmp = a.confidence - b.confidence; break;
      }
      return sortAsc ? cmp : -cmp;
    });
    return list;
  }, [opportunities, chainFilter, sortField, sortAsc]);

  const stats = useMemo(() => {
    const byChain: Record<string, number> = {};
    const byType: Record<string, number> = {};
    let totalProfit = 0;
    let pending = 0;
    let expired = 0;
    let avgConfidence = 0;

    for (const opp of opportunities) {
      const chain = opp.chain ?? 'unknown';
      byChain[chain] = (byChain[chain] ?? 0) + 1;
      const type = opp.type ?? 'simple';
      byType[type] = (byType[type] ?? 0) + 1;
      totalProfit += opp.estimatedProfit ?? opp.expectedProfit ?? 0;
      avgConfidence += opp.confidence;
      if (opp.status === 'pending') pending++;
      if (opp.status === 'expired') expired++;
    }
    if (opportunities.length > 0) avgConfidence /= opportunities.length;

    // Top chain by count
    const topChain = Object.entries(byChain).sort(([, a], [, b]) => b - a)[0];
    // Top type by count
    const topType = Object.entries(byType).sort(([, a], [, b]) => b - a)[0];

    return { byChain, byType, totalProfit, pending, expired, avgConfidence, topChain, topType };
  }, [opportunities]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(false);
    }
  };

  const sortIcon = (field: SortField) => {
    if (sortField !== field) return '';
    return sortAsc ? ' \u25B2' : ' \u25BC';
  };

  const handleExport = () => {
    const headers = ['Time', 'Chain', 'Type', 'Buy DEX', 'Sell DEX', 'Est. Profit', 'Confidence', 'Status', 'Gas Cost', 'Net Profit'];
    const rows = filtered.map((o) => [
      new Date(o.timestamp).toISOString(),
      o.chain ?? '',
      o.type ?? '',
      o.buyDex ?? '',
      o.sellDex ?? '',
      o.estimatedProfit ?? o.expectedProfit ?? '',
      o.confidence,
      o.status ?? '',
      o.gasCost ?? '',
      o.netProfit ?? '',
    ]);
    const csv = toCsv(headers, rows);
    const date = new Date().toISOString().slice(0, 10);
    downloadCsv(`opportunities-${date}.csv`, csv);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-40">
        <div className="flex items-center gap-3 text-gray-500 text-xs">
          <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Loading opportunities...
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="card max-w-md mx-auto mt-12 text-center space-y-2">
        <div className="text-accent-red text-xs font-medium">Failed to load opportunities</div>
        <p className="text-gray-500 text-[10px]">Check that the coordinator is running and the API is reachable.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 overflow-auto">
      {/* KPI Row */}
      <div className="grid grid-cols-5 gap-3">
        <KpiCard label="Total" value={formatNumber(opportunities.length)} sub="last 100" />
        <KpiCard
          label="Est. Profit"
          value={formatUsd(stats.totalProfit)}
          color="text-accent-green"
        />
        <KpiCard
          label="Avg Confidence"
          value={formatPct(stats.avgConfidence * 100)}
          color={stats.avgConfidence >= 0.7 ? 'text-accent-green' : stats.avgConfidence >= 0.4 ? 'text-accent-yellow' : 'text-accent-red'}
        />
        <KpiCard
          label="Top Chain"
          value={stats.topChain ? stats.topChain[0].toUpperCase() : '-'}
          sub={stats.topChain ? `${stats.topChain[1]} opps` : undefined}
        />
        <KpiCard
          label="Top Type"
          value={stats.topType ? stats.topType[0] : '-'}
          sub={stats.topType ? `${stats.topType[1]} opps` : undefined}
        />
      </div>

      {/* Chain Distribution */}
      <div className="card">
        <h3 className="text-[10px] text-gray-500 uppercase tracking-wider mb-3">Chain Distribution</h3>
        <div className="flex gap-1.5 flex-wrap">
          {Object.entries(stats.byChain)
            .sort(([, a], [, b]) => b - a)
            .map(([chain, count]) => {
              const color = CHAIN_COLORS[chain.toLowerCase()];
              const pct = opportunities.length > 0 ? (count / opportunities.length) * 100 : 0;
              return (
                <button
                  key={chain}
                  onClick={() => setChainFilter(chainFilter === chain ? 'all' : chain)}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] font-medium transition-all ${
                    chainFilter === chain
                      ? 'bg-accent-green/15 text-accent-green ring-1 ring-accent-green/30'
                      : 'bg-[var(--badge-bg)] text-gray-400 hover:text-gray-200'
                  }`}
                >
                  {color && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} />}
                  <span className="uppercase">{chain}</span>
                  <span className="text-gray-600">{count}</span>
                  <span className="text-gray-600">({pct.toFixed(0)}%)</span>
                </button>
              );
            })}
          {chainFilter !== 'all' && (
            <button
              onClick={() => setChainFilter('all')}
              className="px-2.5 py-1.5 rounded-lg text-[10px] font-medium text-gray-500 hover:text-gray-300 bg-[var(--badge-bg)]"
            >
              Clear filter
            </button>
          )}
        </div>
      </div>

      {/* Opportunities Table */}
      <div className="card">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-[10px] text-gray-500 uppercase tracking-wider">
            Opportunities ({filtered.length}{chainFilter !== 'all' ? ` on ${chainFilter}` : ''})
          </h3>
          <button
            onClick={handleExport}
            disabled={filtered.length === 0}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-medium text-gray-400 hover:text-gray-200 bg-[var(--badge-bg)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Export CSV
          </button>
        </div>
        <div className="overflow-auto max-h-[480px]">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-gray-800">
                <th className="text-left py-1 px-2 cursor-pointer hover:text-gray-300 select-none" onClick={() => handleSort('timestamp')}>
                  Time{sortIcon('timestamp')}
                </th>
                <th className="text-left py-1 px-2">Status</th>
                <th className="text-left py-1 px-2 cursor-pointer hover:text-gray-300 select-none" onClick={() => handleSort('chain')}>
                  Chain{sortIcon('chain')}
                </th>
                <th className="text-left py-1 px-2">Type</th>
                <th className="text-left py-1 px-2">Route</th>
                <th className="text-right py-1 px-2 cursor-pointer hover:text-gray-300 select-none" onClick={() => handleSort('profit')}>
                  Est. Profit{sortIcon('profit')}
                </th>
                <th className="text-right py-1 px-2">Gas</th>
                <th className="text-right py-1 px-2">Net</th>
                <th className="text-right py-1 px-2 cursor-pointer hover:text-gray-300 select-none" onClick={() => handleSort('confidence')}>
                  Conf.{sortIcon('confidence')}
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((opp) => {
                const profit = opp.estimatedProfit ?? opp.expectedProfit;
                const statusMap: Record<string, string> = {
                  pending: 'healthy',
                  executing: 'degraded',
                  completed: 'healthy',
                  failed: 'unhealthy',
                  expired: 'unknown',
                };
                const chainColor = CHAIN_COLORS[(opp.chain ?? '').toLowerCase()];
                return (
                  <tr key={opp.id} className="border-b border-gray-800/50 hover:bg-surface-lighter/30">
                    <td className="py-1 px-2 text-gray-500">{formatTime(opp.timestamp)}</td>
                    <td className="py-1 px-2">
                      <StatusBadge status={statusMap[opp.status ?? 'pending'] ?? 'unknown'} label={opp.status ?? 'pending'} />
                    </td>
                    <td className="py-1 px-2">
                      <span className="flex items-center gap-1.5">
                        {chainColor && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: chainColor }} />}
                        <span className="text-gray-300 uppercase">{opp.chain ?? '-'}</span>
                      </span>
                    </td>
                    <td className="py-1 px-2">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--badge-bg)] text-gray-400">
                        {opp.type ?? 'simple'}
                      </span>
                    </td>
                    <td className="py-1 px-2 text-gray-400">
                      {opp.buyDex && opp.sellDex ? (
                        <span>{opp.buyDex} <span className="text-gray-600">&rarr;</span> {opp.sellDex}</span>
                      ) : '-'}
                    </td>
                    <td className="py-1 px-2 text-right">
                      {profit != null ? (
                        <span className="text-accent-green">{formatUsd(profit)}</span>
                      ) : '-'}
                    </td>
                    <td className="py-1 px-2 text-right text-gray-500">
                      {opp.gasCost != null ? formatUsd(opp.gasCost) : '-'}
                    </td>
                    <td className="py-1 px-2 text-right">
                      {opp.netProfit != null ? (
                        <span className={opp.netProfit > 0 ? 'text-accent-green' : 'text-accent-red'}>
                          {formatUsd(opp.netProfit)}
                        </span>
                      ) : '-'}
                    </td>
                    <td className="py-1 px-2 text-right">
                      <span className={`tabular-nums ${
                        opp.confidence >= 0.8 ? 'text-accent-green' : opp.confidence >= 0.5 ? 'text-accent-yellow' : 'text-accent-red'
                      }`}>
                        {formatPct(opp.confidence * 100)}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={9} className="text-center py-8 text-gray-600">
                    {opportunities.length === 0 ? 'No opportunities detected yet' : `No opportunities on ${chainFilter}`}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
