import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../hooks/useApi';
import { KpiCard } from '../components/KpiCard';
import { KpiGrid } from '../components/KpiGrid';
import { DataTable } from '../components/DataTable';
import { ExportCsvButton } from '../components/ExportCsvButton';
import { SectionHeader } from '../components/SectionHeader';
import { Spinner } from '../components/Spinner';
import { StatusBadge } from '../components/StatusBadge';
import { formatTime, formatUsd, formatNumber, formatPct, thresholdColor } from '../lib/format';
import { CHAIN_COLORS } from '../lib/theme';
import type { Opportunity } from '../lib/types';

type SortField = 'timestamp' | 'chain' | 'profit' | 'confidence';

const OPP_CSV_HEADERS = ['Time', 'Chain', 'Type', 'Buy DEX', 'Sell DEX', 'Est. Profit', 'Confidence', 'Status', 'Gas Cost', 'Net Profit'];

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

  const exportRows = useMemo(
    () => filtered.map((o) => [
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
    ]),
    [filtered],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-40">
        <div className="flex items-center gap-3 text-gray-500 text-xs">
          <Spinner />
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
      <KpiGrid>
        <KpiCard label="Total" value={formatNumber(opportunities.length)} sub="last 100" />
        <KpiCard
          label="Est. Profit"
          value={formatUsd(stats.totalProfit)}
          color="text-accent-green"
        />
        <KpiCard
          label="Avg Confidence"
          value={formatPct(stats.avgConfidence * 100)}
          color={thresholdColor(stats.avgConfidence, 0.7, 0.4)}
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
      </KpiGrid>

      {/* Chain Distribution */}
      <div className="card">
        <SectionHeader mb="mb-3">Chain Distribution</SectionHeader>
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
          <ExportCsvButton
            headers={OPP_CSV_HEADERS}
            rows={exportRows}
            filenamePrefix="opportunities"
            disabled={filtered.length === 0}
            label="Export CSV"
          />
        </div>
        <DataTable<Opportunity>
          columns={[
            { header: 'Time', onHeaderClick: () => handleSort('timestamp'), headerSuffix: sortIcon('timestamp'),
              sortDirection: sortField === 'timestamp' ? (sortAsc ? 'ascending' : 'descending') : undefined,
              render: (opp) => <span className="text-gray-500">{formatTime(opp.timestamp)}</span> },
            { header: 'Status', render: (opp) => {
              const statusMap: Record<string, string> = { pending: 'healthy', executing: 'degraded', completed: 'healthy', failed: 'unhealthy', expired: 'unknown' };
              return <StatusBadge status={statusMap[opp.status ?? 'pending'] ?? 'unknown'} label={opp.status ?? 'pending'} />;
            } },
            { header: 'Chain', onHeaderClick: () => handleSort('chain'), headerSuffix: sortIcon('chain'),
              sortDirection: sortField === 'chain' ? (sortAsc ? 'ascending' : 'descending') : undefined,
              render: (opp) => {
                const chainColor = CHAIN_COLORS[(opp.chain ?? '').toLowerCase()];
                return (
                  <span className="flex items-center gap-1.5">
                    {chainColor && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: chainColor }} />}
                    <span className="text-gray-300 uppercase">{opp.chain ?? '-'}</span>
                  </span>
                );
              } },
            { header: 'Type', render: (opp) => (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--badge-bg)] text-gray-400">{opp.type ?? 'simple'}</span>
            ) },
            { header: 'Route', render: (opp) => (
              <span className="text-gray-400">
                {opp.buyDex && opp.sellDex ? <>{opp.buyDex} <span className="text-gray-600">&rarr;</span> {opp.sellDex}</> : '-'}
              </span>
            ) },
            { header: 'Est. Profit', align: 'right', onHeaderClick: () => handleSort('profit'), headerSuffix: sortIcon('profit'),
              sortDirection: sortField === 'profit' ? (sortAsc ? 'ascending' : 'descending') : undefined,
              render: (opp) => {
                const profit = opp.estimatedProfit ?? opp.expectedProfit;
                return profit != null ? <span className="text-accent-green">{formatUsd(profit)}</span> : <>-</>;
              } },
            { header: 'Gas', align: 'right', render: (opp) => (
              <span className="text-gray-500">{opp.gasCost != null ? formatUsd(opp.gasCost) : '-'}</span>
            ) },
            { header: 'Net', align: 'right', render: (opp) => (
              opp.netProfit != null
                ? <span className={opp.netProfit > 0 ? 'text-accent-green' : 'text-accent-red'}>{formatUsd(opp.netProfit)}</span>
                : <>-</>
            ) },
            { header: 'Conf.', align: 'right', onHeaderClick: () => handleSort('confidence'), headerSuffix: sortIcon('confidence'),
              sortDirection: sortField === 'confidence' ? (sortAsc ? 'ascending' : 'descending') : undefined,
              render: (opp) => (
                <span className={`tabular-nums ${
                  thresholdColor(opp.confidence, 0.8, 0.5)
                }`}>
                  {formatPct(opp.confidence * 100)}
                </span>
              ) },
          ]}
          data={filtered}
          keyExtractor={(opp) => opp.id}
          maxHeight="480px"
          emptyMessage={opportunities.length === 0 ? 'No opportunities detected yet' : `No opportunities on ${chainFilter}`}
        />
      </div>
    </div>
  );
}
