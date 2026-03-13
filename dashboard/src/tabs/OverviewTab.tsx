import { useMemo } from 'react';
import { useMetrics, useServices, useFeed, useDiagnostics } from '../context/SSEContext';
import { KpiCard } from '../components/KpiCard';
import { KpiGrid } from '../components/KpiGrid';
import { EmptyState } from '../components/EmptyState';
import { ServiceCard } from '../components/ServiceCard';
import { LiveFeed } from '../components/LiveFeed';
import { SectionHeader } from '../components/SectionHeader';
import { formatUsd, formatPct, formatNumber, calcSuccessRate, thresholdColor } from '../lib/format';

function fmtMs(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '-';
  return n < 1000 ? `${n.toFixed(1)}ms` : `${(n / 1000).toFixed(2)}s`;
}

export function OverviewTab() {
  const { metrics } = useMetrics();
  const { services } = useServices();
  const { feed } = useFeed();
  const { diagnostics } = useDiagnostics();

  const serviceList = useMemo(() => Object.values(services), [services]);

  if (!metrics) {
    return <div className="text-gray-500 text-xs">Waiting for data...</div>;
  }

  const successRate = calcSuccessRate(metrics.totalExecutions, metrics.successfulExecutions);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 h-full">
      {/* Left: KPIs + Services + Pipeline */}
      <div className="space-y-4 overflow-auto">
        {/* KPI Row */}
        <KpiGrid>
          <KpiCard label="System Health" value={formatPct(metrics.systemHealth)} color={thresholdColor(metrics.systemHealth, 80, 50)} />
          <KpiCard label="Active Services" value={String(metrics.activeServices)} />
          <KpiCard label="Opportunities" value={formatNumber(metrics.totalOpportunities)} sub={`${formatNumber(metrics.opportunitiesDropped)} dropped`} />
          <KpiCard label="Executions" value={formatNumber(metrics.totalExecutions)} sub={`${formatPct(successRate)} success`} />
          <KpiCard label="Total Profit" value={formatUsd(metrics.totalProfit)} color="text-accent-green" />
        </KpiGrid>

        {/* Diagnostics Mini-Panel */}
        {diagnostics && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="card flex flex-col gap-0.5 py-2">
              <span className="text-[10px] text-gray-500">E2E Latency p95</span>
              <span className={`text-sm font-bold font-mono ${diagnostics.pipeline.e2e.p95 >= 50 ? 'text-accent-red' : diagnostics.pipeline.e2e.p95 >= 30 ? 'text-accent-yellow' : 'text-accent-green'}`}>
                {fmtMs(diagnostics.pipeline.e2e.p95)}
              </span>
            </div>
            <div className="card flex flex-col gap-0.5 py-2">
              <span className="text-[10px] text-gray-500">Event Loop p99</span>
              <span className={`text-sm font-bold font-mono ${diagnostics.runtime.eventLoop.p99 >= 100 ? 'text-accent-red' : diagnostics.runtime.eventLoop.p99 >= 20 ? 'text-accent-yellow' : ''}`}>
                {fmtMs(diagnostics.runtime.eventLoop.p99)}
              </span>
            </div>
            <div className="card flex flex-col gap-0.5 py-2">
              <span className="text-[10px] text-gray-500">Heap Used</span>
              <span className="text-sm font-bold font-mono">
                {diagnostics.runtime.memory.heapUsedMB.toFixed(0)}MB
              </span>
            </div>
            <div className="card flex flex-col gap-0.5 py-2">
              <span className="text-[10px] text-gray-500">RPC Errors</span>
              <span className={`text-sm font-bold font-mono ${diagnostics.providers.totalRpcErrors > 0 ? 'text-accent-red' : ''}`}>
                {formatNumber(diagnostics.providers.totalRpcErrors)}
              </span>
            </div>
          </div>
        )}

        {/* Service Grid */}
        <div>
          <SectionHeader>Services ({serviceList.length})</SectionHeader>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {serviceList.map((svc) => (
              <ServiceCard key={svc.name} service={svc} />
            ))}
          </div>
          {serviceList.length === 0 && <EmptyState message="No services reporting yet" />}
        </div>

        {/* Pipeline Health Summary — details in Risk and Streams tabs */}
        <div className="card">
          <SectionHeader mb="mb-3">Pipeline Health</SectionHeader>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div>
              <span className="text-gray-500">Backpressure</span>
              {metrics.backpressure ? (
                <div className={`mt-1 text-sm font-bold ${metrics.backpressure.active ? 'text-accent-red' : 'text-accent-green'}`}>
                  {metrics.backpressure.active ? 'ACTIVE' : 'OK'}
                  <span className="text-gray-500 font-normal text-[10px] ml-1">({formatPct(metrics.backpressure.executionStreamDepthRatio * 100)})</span>
                </div>
              ) : <span className="text-gray-600 mt-1 block">-</span>}
              <a href="#risk" className="text-[10px] text-gray-600 hover:text-gray-400">Risk tab &rarr;</a>
            </div>
            <div>
              <span className="text-gray-500">Admission</span>
              {metrics.admissionMetrics ? (
                <div className="mt-1 text-sm font-bold">
                  <span className="text-accent-green">{formatNumber(metrics.admissionMetrics.admitted)}</span>
                  <span className="text-gray-600 font-normal"> / </span>
                  <span className="text-accent-red">{formatNumber(metrics.admissionMetrics.shed)}</span>
                </div>
              ) : <span className="text-gray-600 mt-1 block">-</span>}
              <a href="#risk" className="text-[10px] text-gray-600 hover:text-gray-400">Risk tab &rarr;</a>
            </div>
            <div>
              <span className="text-gray-500">DLQ Total</span>
              {metrics.dlqMetrics ? (
                <div className={`mt-1 text-sm font-bold ${metrics.dlqMetrics.total > 0 ? 'text-accent-yellow' : 'text-gray-400'}`}>
                  {formatNumber(metrics.dlqMetrics.total)}
                </div>
              ) : <span className="text-gray-600 mt-1 block">-</span>}
              <a href="#streams" className="text-[10px] text-gray-600 hover:text-gray-400">Streams tab &rarr;</a>
            </div>
            <div>
              <span className="text-gray-500">Fwd Rejections</span>
              {metrics.forwardingMetrics ? (
                <div className="mt-1 text-sm font-bold text-gray-400">
                  {formatNumber(Object.values(metrics.forwardingMetrics).reduce((s, v) => s + v, 0))}
                </div>
              ) : <span className="text-gray-600 mt-1 block">-</span>}
              <a href="#risk" className="text-[10px] text-gray-600 hover:text-gray-400">Risk tab &rarr;</a>
            </div>
          </div>
        </div>
      </div>

      {/* Right: Live Feed */}
      <LiveFeed items={feed} />
    </div>
  );
}
