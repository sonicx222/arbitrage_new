import { useMemo } from 'react';
import { useMetrics, useServices, useFeed, useDiagnostics } from '../context/SSEContext';
import { KpiCard } from '../components/KpiCard';
import { KpiGrid } from '../components/KpiGrid';
import { EmptyState } from '../components/EmptyState';
import { ServiceCard } from '../components/ServiceCard';
import { LiveFeed } from '../components/LiveFeed';
import { SectionHeader } from '../components/SectionHeader';
import { StatRow } from '../components/StatRow';
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

  if (!metrics) {
    return <div className="text-gray-500 text-xs">Waiting for data...</div>;
  }

  const successRate = calcSuccessRate(metrics.totalExecutions, metrics.successfulExecutions);

  const serviceList = useMemo(() => Object.values(services), [services]);

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

        {/* Pipeline Health */}
        <div className="card">
          <SectionHeader mb="mb-3">Pipeline Health</SectionHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            {/* Backpressure */}
            <div>
              <span className="text-gray-400">Backpressure</span>
              {metrics.backpressure ? (
                <div className="mt-1">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 bg-gray-800 rounded-full h-2">
                      <div
                        className={`h-2 rounded-full ${metrics.backpressure.active ? 'bg-accent-red' : 'bg-accent-green'}`}
                        style={{ width: `${Math.min(metrics.backpressure.executionStreamDepthRatio * 100, 100)}%` }}
                      />
                    </div>
                    <span className="text-gray-500 w-10 text-right">{formatPct(metrics.backpressure.executionStreamDepthRatio * 100)}</span>
                  </div>
                  <span className={`text-[10px] ${metrics.backpressure.active ? 'text-accent-red' : 'text-accent-green'}`}>
                    {metrics.backpressure.active ? 'ACTIVE' : 'INACTIVE'}
                  </span>
                </div>
              ) : <EmptyState message="No data" className="mt-1" />}
            </div>

            {/* Admission */}
            <div>
              <span className="text-gray-400">Admission Control</span>
              {metrics.admissionMetrics ? (
                <div className="mt-1 space-y-0.5">
                  <StatRow label="Admitted" value={formatNumber(metrics.admissionMetrics.admitted)} color="text-accent-green" />
                  <StatRow label="Shed" value={formatNumber(metrics.admissionMetrics.shed)} color="text-accent-red" />
                  <StatRow label="Avg Score (admitted)" value={Number.isFinite(metrics.admissionMetrics.avgScoreAdmitted) ? metrics.admissionMetrics.avgScoreAdmitted.toFixed(2) : '-'} />
                  <StatRow label="Avg Score (shed)" value={Number.isFinite(metrics.admissionMetrics.avgScoreShed) ? metrics.admissionMetrics.avgScoreShed.toFixed(2) : '-'} />
                </div>
              ) : <EmptyState message="No data" className="mt-1" />}
            </div>

            {/* DLQ */}
            <div>
              <span className="text-gray-400">Dead Letter Queue</span>
              {metrics.dlqMetrics ? (
                <div className="mt-1 space-y-0.5">
                  <StatRow label="Total" value={metrics.dlqMetrics.total} />
                  <StatRow label="Expired" value={metrics.dlqMetrics.expired} />
                  <StatRow label="Validation" value={metrics.dlqMetrics.validation} />
                  <StatRow label="Transient" value={metrics.dlqMetrics.transient} />
                  <StatRow label="Unknown" value={metrics.dlqMetrics.unknown} />
                </div>
              ) : <EmptyState message="No data" className="mt-1" />}
            </div>

            {/* Forwarding */}
            <div>
              <span className="text-gray-400">Forwarding Rejections</span>
              {metrics.forwardingMetrics ? (
                <div className="mt-1 space-y-0.5">
                  <StatRow label="Expired" value={metrics.forwardingMetrics.expired} />
                  <StatRow label="Duplicate" value={metrics.forwardingMetrics.duplicate} />
                  <StatRow label="Profit Rejected" value={metrics.forwardingMetrics.profitRejected} />
                  <StatRow label="Chain Rejected" value={metrics.forwardingMetrics.chainRejected} />
                  <StatRow label="Circuit Open" value={metrics.forwardingMetrics.circuitOpen} />
                  <StatRow label="Not Leader" value={metrics.forwardingMetrics.notLeader} />
                </div>
              ) : <EmptyState message="No data" className="mt-1" />}
            </div>
          </div>
        </div>
      </div>

      {/* Right: Live Feed */}
      <LiveFeed items={feed} />
    </div>
  );
}
