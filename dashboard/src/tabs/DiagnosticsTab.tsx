import { useMemo, useState } from 'react';
import { useDiagnostics, useCexSpread } from '../context/SSEContext';
import { DataTable } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { SectionHeader } from '../components/SectionHeader';
import { StatRow } from '../components/StatRow';
import { StatusBadge } from '../components/StatusBadge';
import { formatNumber, formatDuration } from '../lib/format';
import type { CompactPercentiles, DiagnosticsSnapshot, CexSpreadData } from '../lib/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtMs(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '-';
  return n < 1 ? `${(n * 1000).toFixed(0)}us` : n < 1000 ? `${n.toFixed(1)}ms` : `${(n / 1000).toFixed(2)}s`;
}

function latencyColor(ms: number, warn: number, crit: number): string {
  if (ms >= crit) return 'text-accent-red';
  if (ms >= warn) return 'text-accent-yellow';
  return '';
}

function pctBar(value: number, max: number, color: string): JSX.Element {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div className="bg-gray-800 rounded-full h-1.5 w-full min-w-[3rem]">
      <div className={`${color} h-1.5 rounded-full`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PipelineSection({ pipeline }: { pipeline: DiagnosticsSnapshot['pipeline'] }) {
  const stages = useMemo(() => {
    return Object.entries(pipeline.stages)
      .sort(([, a], [, b]) => b.p95 - a.p95);
  }, [pipeline.stages]);

  return (
    <div className="card">
      <SectionHeader mb="mb-3">Pipeline Latency</SectionHeader>
      {/* E2E summary */}
      <div className="grid grid-cols-3 gap-3 mb-3">
        <div>
          <div className="text-[10px] text-gray-500">E2E p50</div>
          <div className={`text-lg font-bold font-mono ${latencyColor(pipeline.e2e.p50, 30, 50)}`}>
            {fmtMs(pipeline.e2e.p50)}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500">E2E p95</div>
          <div className={`text-lg font-bold font-mono ${latencyColor(pipeline.e2e.p95, 50, 100)}`}>
            {fmtMs(pipeline.e2e.p95)}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500">E2E p99</div>
          <div className={`text-lg font-bold font-mono ${latencyColor(pipeline.e2e.p99, 100, 200)}`}>
            {fmtMs(pipeline.e2e.p99)}
          </div>
        </div>
      </div>
      {/* Composite metrics */}
      <div className="grid grid-cols-2 gap-2 mb-3 text-xs">
        <StatRow label="WS -> Detector p95" value={<span className={`font-mono ${latencyColor(pipeline.wsToDetector.p95, 20, 40)}`}>{fmtMs(pipeline.wsToDetector.p95)}</span>} />
        <StatRow label="Detector -> Publish p95" value={<span className={`font-mono ${latencyColor(pipeline.detectorToPublish.p95, 15, 30)}`}>{fmtMs(pipeline.detectorToPublish.p95)}</span>} />
      </div>
      {/* Per-stage breakdown */}
      <DataTable<[string, CompactPercentiles]>
        columns={[
          { header: 'Stage', render: ([name]) => <span className="font-mono text-gray-300">{name}</span> },
          { header: 'p50', align: 'right', render: ([, s]) => <span className="font-mono">{fmtMs(s.p50)}</span> },
          { header: 'p95', align: 'right', render: ([, s]) => <span className={`font-mono ${latencyColor(s.p95, 20, 50)}`}>{fmtMs(s.p95)}</span> },
          { header: 'p99', align: 'right', render: ([, s]) => <span className={`font-mono ${latencyColor(s.p99, 50, 100)}`}>{fmtMs(s.p99)}</span> },
          { header: 'Samples', align: 'right', render: ([, s]) => <>{formatNumber(s.count)}</> },
        ]}
        data={stages}
        keyExtractor={([name]) => name}
        maxHeight="14rem"
        emptyMessage="No stage data"
      />
    </div>
  );
}

function RuntimeSection({ runtime }: { runtime: DiagnosticsSnapshot['runtime'] }) {
  const memPct = runtime.memory.heapTotalMB > 0
    ? (runtime.memory.heapUsedMB / runtime.memory.heapTotalMB) * 100
    : 0;
  const memColor = memPct > 90 ? 'bg-accent-red' : memPct > 70 ? 'bg-accent-yellow' : 'bg-accent-green';

  return (
    <div className="card">
      <SectionHeader mb="mb-3">Runtime Health</SectionHeader>
      <div className="space-y-3">
        {/* Event Loop */}
        <div>
          <div className="text-[10px] text-gray-500 mb-1">Event Loop Delay</div>
          <div className="grid grid-cols-4 gap-2 text-xs">
            <StatRow label="Min" value={<span className="font-mono">{fmtMs(runtime.eventLoop.min)}</span>} />
            <StatRow label="Mean" value={<span className="font-mono">{fmtMs(runtime.eventLoop.mean)}</span>} />
            <StatRow label="Max" value={<span className={`font-mono ${latencyColor(runtime.eventLoop.max, 50, 200)}`}>{fmtMs(runtime.eventLoop.max)}</span>} />
            <StatRow label="p99" value={<span className={`font-mono ${latencyColor(runtime.eventLoop.p99, 20, 100)}`}>{fmtMs(runtime.eventLoop.p99)}</span>} />
          </div>
        </div>
        {/* Memory */}
        <div>
          <div className="flex justify-between text-[10px] text-gray-500 mb-1">
            <span>Heap Memory</span>
            <span>{runtime.memory.heapUsedMB.toFixed(0)}MB / {runtime.memory.heapTotalMB.toFixed(0)}MB ({memPct.toFixed(0)}%)</span>
          </div>
          {pctBar(runtime.memory.heapUsedMB, runtime.memory.heapTotalMB, memColor)}
          <div className="grid grid-cols-2 gap-2 text-xs mt-1.5">
            <StatRow label="RSS" value={`${runtime.memory.rssMB.toFixed(0)}MB`} />
            <StatRow label="External" value={`${runtime.memory.externalMB.toFixed(1)}MB`} />
          </div>
        </div>
        {/* GC */}
        <div>
          <div className="text-[10px] text-gray-500 mb-1">Garbage Collection</div>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <StatRow label="Total Pause" value={<span className="font-mono">{fmtMs(runtime.gc.totalPauseMs)}</span>} />
            <StatRow label="Events" value={formatNumber(runtime.gc.count)} />
            <StatRow label="Major GC" value={<span className={runtime.gc.majorCount > 10 ? 'text-accent-yellow' : ''}>{runtime.gc.majorCount}</span>} />
          </div>
        </div>
        {/* Uptime */}
        <StatRow label="Uptime" value={formatDuration(runtime.uptimeSeconds)} />
      </div>
    </div>
  );
}

function ProvidersSection({ providers }: { providers: DiagnosticsSnapshot['providers'] }) {
  const chainEntries = useMemo(() => {
    return Object.entries(providers.rpcByChain)
      .sort(([, a], [, b]) => b.p95 - a.p95);
  }, [providers.rpcByChain]);

  const methodEntries = useMemo(() => {
    return Object.entries(providers.rpcByMethod)
      .sort(([, a], [, b]) => b.totalCalls - a.totalCalls);
  }, [providers.rpcByMethod]);

  const wsEntries = useMemo(() => {
    return Object.entries(providers.wsMessages)
      .sort(([, a], [, b]) => b - a);
  }, [providers.wsMessages]);

  return (
    <div className="card">
      <SectionHeader mb="mb-3">RPC Provider Quality</SectionHeader>
      {/* Summary */}
      <div className="flex gap-4 mb-3">
        <div>
          <div className="text-[10px] text-gray-500">Total RPC Errors</div>
          <div className={`text-lg font-bold ${providers.totalRpcErrors > 0 ? 'text-accent-red' : 'text-gray-400'}`}>
            {formatNumber(providers.totalRpcErrors)}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500">Chains Tracked</div>
          <div className="text-lg font-bold">{chainEntries.length}</div>
        </div>
        {Object.keys(providers.reconnections).length > 0 && (
          <div>
            <div className="text-[10px] text-gray-500">Reconnections</div>
            <div className="text-lg font-bold text-accent-yellow">
              {Object.values(providers.reconnections).reduce((s, r) => s + r.count, 0)}
            </div>
          </div>
        )}
      </div>
      {/* Per-chain table */}
      <DataTable<[string, { p50: number; p95: number; errors: number; totalCalls: number }]>
        columns={[
          { header: 'Chain', render: ([name]) => <span className="font-mono text-gray-300">{name}</span> },
          { header: 'p50', align: 'right', render: ([, s]) => <span className="font-mono">{fmtMs(s.p50)}</span> },
          { header: 'p95', align: 'right', render: ([, s]) => <span className={`font-mono ${latencyColor(s.p95, 100, 500)}`}>{fmtMs(s.p95)}</span> },
          { header: 'Errors', align: 'right', render: ([, s]) => <span className={s.errors > 0 ? 'text-accent-red' : ''}>{formatNumber(s.errors)}</span> },
          { header: 'Calls', align: 'right', render: ([, s]) => <>{formatNumber(s.totalCalls)}</> },
        ]}
        data={chainEntries}
        keyExtractor={([name]) => name}
        maxHeight="14rem"
        emptyMessage="No RPC data yet"
      />
      {/* Per-method table (collapsed) */}
      {methodEntries.length > 0 && (
        <div className="mt-3">
          <div className="text-[10px] text-gray-500 mb-1">By Method</div>
          <DataTable<[string, { p50: number; p95: number; totalCalls: number }]>
            columns={[
              { header: 'Method', render: ([name]) => <span className="font-mono text-gray-300">{name}</span> },
              { header: 'p50', align: 'right', render: ([, s]) => <span className="font-mono">{fmtMs(s.p50)}</span> },
              { header: 'p95', align: 'right', render: ([, s]) => <span className="font-mono">{fmtMs(s.p95)}</span> },
              { header: 'Calls', align: 'right', render: ([, s]) => <>{formatNumber(s.totalCalls)}</> },
            ]}
            data={methodEntries}
            keyExtractor={([name]) => name}
            maxHeight="10rem"
            emptyMessage="No method data"
          />
        </div>
      )}
      {/* WebSocket message throughput */}
      {wsEntries.length > 0 && (
        <div className="mt-3">
          <div className="text-[10px] text-gray-500 mb-1">WebSocket Messages (cumulative)</div>
          <DataTable<[string, number]>
            columns={[
              { header: 'Chain:Event', render: ([key]) => <span className="font-mono text-gray-300">{key}</span> },
              { header: 'Count', align: 'right', render: ([, count]) => <span className="font-mono">{formatNumber(count)}</span> },
            ]}
            data={wsEntries}
            keyExtractor={([key]) => key}
            maxHeight="10rem"
            emptyMessage="No WS data"
          />
        </div>
      )}
    </div>
  );
}

function StreamDiagSection({ streams }: { streams: NonNullable<DiagnosticsSnapshot['streams']> }) {
  const entries = useMemo(() => {
    return Object.entries(streams.streams)
      .sort(([, a], [, b]) => b.pending - a.pending);
  }, [streams.streams]);

  return (
    <div className="card">
      <SectionHeader mb="mb-3">Stream Diagnostics</SectionHeader>
      <div className="flex items-center gap-2 mb-2">
        <StatusBadge status={streams.overall} label={streams.overall} />
      </div>
      <DataTable<[string, { length: number; pending: number; consumerGroups: number; status: string }]>
        columns={[
          { header: 'Stream', render: ([name]) => <span className="font-mono text-gray-300">{name.replace('stream:', '')}</span> },
          { header: 'Length', align: 'right', render: ([, s]) => <>{formatNumber(s.length)}</> },
          { header: 'Pending', align: 'right', render: ([, s]) => (
            <span className={s.pending > 1000 ? 'text-accent-red' : s.pending > 100 ? 'text-accent-yellow' : ''}>
              {formatNumber(s.pending)}
            </span>
          ) },
          { header: 'Groups', align: 'right', render: ([, s]) => <>{s.consumerGroups}</> },
          { header: 'Status', align: 'center', render: ([, s]) => <StatusBadge status={s.status} /> },
        ]}
        data={entries}
        keyExtractor={([name]) => name}
        maxHeight="14rem"
        emptyMessage="No streams"
      />
    </div>
  );
}

function CexSpreadSection({ data }: { data: CexSpreadData }) {
  const alerts = useMemo(() => {
    return [...data.alerts].sort((a, b) => Math.abs(b.spreadPct) - Math.abs(a.spreadPct));
  }, [data.alerts]);

  return (
    <div className="card">
      <SectionHeader mb="mb-3">CEX-DEX Spread (ADR-036)</SectionHeader>
      {/* Stats summary */}
      <div className="grid grid-cols-4 gap-3 mb-3 text-xs">
        <StatRow label="Status" value={
          <>
            <StatusBadge
              status={
                data.healthSnapshot?.isDegraded ? 'error' :
                data.stats.running ? (data.stats.wsConnected ? 'healthy' : 'warning') : 'unknown'
              }
              label={
                data.healthSnapshot?.isDegraded
                  ? `Degraded ${data.healthSnapshot.disconnectedSince
                      ? `(${Math.round((Date.now() - data.healthSnapshot.disconnectedSince) / 60000)}m)`
                      : ''}`
                  : data.stats.running
                    ? (data.stats.simulationMode ? 'Simulation' : data.stats.wsConnected ? 'Connected' : 'Disconnected')
                    : 'Stopped'
              }
            />
            {data.healthSnapshot?.isDegraded && (
              <p className="text-xs text-red-400 mt-1">
                CEX validation inactive. Scoring uses neutral alignment (1.0).
                Check Binance WS connectivity or NODE_TLS_REJECT_UNAUTHORIZED setting.
              </p>
            )}
          </>
        } />
        <StatRow label="CEX Updates" value={<span className="font-mono">{formatNumber(data.stats.cexPriceUpdatesTotal)}</span>} />
        <StatRow label="DEX Updates" value={<span className="font-mono">{formatNumber(data.stats.dexPriceUpdatesTotal)}</span>} />
        <StatRow label="Spread Alerts" value={
          <span className={`font-mono ${data.stats.spreadAlertsTotal > 0 ? 'text-accent-yellow' : ''}`}>
            {formatNumber(data.stats.spreadAlertsTotal)}
          </span>
        } />
      </div>
      <div className="grid grid-cols-2 gap-3 mb-3 text-xs">
        <StatRow label="WS Reconnections" value={
          <span className={`font-mono ${data.stats.wsReconnectionsTotal > 5 ? 'text-accent-yellow' : ''}`}>
            {data.stats.wsReconnectionsTotal}
          </span>
        } />
        <StatRow label="Active Alerts" value={
          <span className={`font-mono ${data.stats.activeAlertCount > 0 ? 'text-accent-green font-bold' : ''}`}>
            {data.stats.activeAlertCount}
          </span>
        } />
      </div>
      {/* Active spread alerts table */}
      {alerts.length > 0 && (
        <DataTable<CexSpreadData['alerts'][number]>
          columns={[
            { header: 'Token', render: (a) => <span className="font-mono text-gray-300">{a.tokenId}</span> },
            { header: 'Chain', render: (a) => <span className="text-gray-400">{a.chain}</span> },
            { header: 'CEX $', align: 'right', render: (a) => <span className="font-mono">{a.cexPrice.toFixed(2)}</span> },
            { header: 'DEX $', align: 'right', render: (a) => <span className="font-mono">{a.dexPrice.toFixed(2)}</span> },
            { header: 'Spread', align: 'right', render: (a) => (
              <span className={`font-mono font-bold ${a.spreadPct > 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                {a.spreadPct > 0 ? '+' : ''}{a.spreadPct.toFixed(3)}%
              </span>
            ) },
          ]}
          data={alerts}
          keyExtractor={(a) => `${a.tokenId}-${a.chain}`}
          maxHeight="14rem"
          emptyMessage="No active spread alerts"
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Tab
// ---------------------------------------------------------------------------

type DiagSection = 'all' | 'pipeline' | 'runtime' | 'providers' | 'cex' | 'streams';

const DIAG_SECTIONS: { id: DiagSection; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'providers', label: 'Providers' },
  { id: 'cex', label: 'CEX-DEX' },
  { id: 'streams', label: 'Streams' },
];

export function DiagnosticsTab() {
  const { diagnostics } = useDiagnostics();
  const { cexSpread } = useCexSpread();
  const [section, setSection] = useState<DiagSection>('all');

  if (!diagnostics) {
    return (
      <div className="flex items-center justify-center h-64">
        <EmptyState message="Waiting for diagnostics data..." className="text-sm" />
      </div>
    );
  }

  const showAll = section === 'all';

  return (
    <div className="space-y-4 overflow-auto">
      {/* Timestamp header + section nav */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1">
          {DIAG_SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`px-2.5 py-1 rounded text-[10px] font-medium transition-colors ${
                section === s.id ? 'bg-accent-green/15 text-accent-green' : 'text-gray-500 hover:text-gray-300 bg-[var(--badge-bg)]'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="text-[10px] text-gray-500">
          <span>Last: {new Date(diagnostics.timestamp).toLocaleTimeString()}</span>
          <span className="ml-2">Refresh: 10s</span>
        </div>
      </div>

      {/* Pipeline + Runtime side by side on large screens */}
      {(showAll || section === 'pipeline' || section === 'runtime') && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {(showAll || section === 'pipeline') && <PipelineSection pipeline={diagnostics.pipeline} />}
          {(showAll || section === 'runtime') && <RuntimeSection runtime={diagnostics.runtime} />}
        </div>
      )}

      {/* Providers full width */}
      {(showAll || section === 'providers') && <ProvidersSection providers={diagnostics.providers} />}

      {/* CEX-DEX Spread (only shown when data available) */}
      {(showAll || section === 'cex') && cexSpread && <CexSpreadSection data={cexSpread} />}

      {/* Stream diagnostics */}
      {(showAll || section === 'streams') && diagnostics.streams && <StreamDiagSection streams={diagnostics.streams} />}
    </div>
  );
}
