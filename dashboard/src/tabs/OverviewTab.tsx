import { useMemo } from 'react';
import { useMetrics, useServices, useFeed } from '../context/SSEContext';
import { KpiCard } from '../components/KpiCard';
import { KpiGrid } from '../components/KpiGrid';
import { EmptyState } from '../components/EmptyState';
import { ServiceCard } from '../components/ServiceCard';
import { LiveFeed } from '../components/LiveFeed';
import { SectionHeader } from '../components/SectionHeader';
import { StatRow } from '../components/StatRow';
import { formatUsd, formatPct, formatNumber, calcSuccessRate } from '../lib/format';

export function OverviewTab() {
  const { metrics } = useMetrics();
  const { services } = useServices();
  const { feed } = useFeed();

  if (!metrics) {
    return <div className="text-gray-500 text-xs">Waiting for data...</div>;
  }

  const successRate = calcSuccessRate(metrics.totalExecutions, metrics.successfulExecutions);

  const healthColor = metrics.systemHealth >= 80 ? 'text-accent-green'
    : metrics.systemHealth >= 50 ? 'text-accent-yellow'
    : 'text-accent-red';

  const serviceList = useMemo(() => Object.values(services), [services]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 h-full">
      {/* Left: KPIs + Services + Pipeline */}
      <div className="space-y-4 overflow-auto">
        {/* KPI Row */}
        <KpiGrid>
          <KpiCard label="System Health" value={formatPct(metrics.systemHealth)} color={healthColor} />
          <KpiCard label="Active Services" value={String(metrics.activeServices)} />
          <KpiCard label="Opportunities" value={formatNumber(metrics.totalOpportunities)} sub={`${formatNumber(metrics.opportunitiesDropped)} dropped`} />
          <KpiCard label="Executions" value={formatNumber(metrics.totalExecutions)} sub={`${formatPct(successRate)} success`} />
          <KpiCard label="Total Profit" value={formatUsd(metrics.totalProfit)} color="text-accent-green" />
        </KpiGrid>

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
