import { useMemo } from 'react';
import { useMetrics, useServices, useFeed } from '../context/SSEContext';
import { KpiCard } from '../components/KpiCard';
import { ServiceCard } from '../components/ServiceCard';
import { LiveFeed } from '../components/LiveFeed';
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
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <KpiCard label="System Health" value={formatPct(metrics.systemHealth)} color={healthColor} />
          <KpiCard label="Active Services" value={String(metrics.activeServices)} />
          <KpiCard label="Opportunities" value={formatNumber(metrics.totalOpportunities)} sub={`${formatNumber(metrics.opportunitiesDropped)} dropped`} />
          <KpiCard label="Executions" value={formatNumber(metrics.totalExecutions)} sub={`${formatPct(successRate)} success`} />
          <KpiCard label="Total Profit" value={formatUsd(metrics.totalProfit)} color="text-accent-green" />
        </div>

        {/* Service Grid */}
        <div>
          <h3 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Services ({serviceList.length})</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {serviceList.map((svc) => (
              <ServiceCard key={svc.name} service={svc} />
            ))}
          </div>
          {serviceList.length === 0 && <div className="text-gray-600 text-xs">No services reporting yet</div>}
        </div>

        {/* Pipeline Health */}
        <div className="card">
          <h3 className="text-[10px] text-gray-500 uppercase tracking-wider mb-3">Pipeline Health</h3>
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
              ) : <div className="text-gray-600 mt-1">No data</div>}
            </div>

            {/* Admission */}
            <div>
              <span className="text-gray-400">Admission Control</span>
              {metrics.admissionMetrics ? (
                <div className="mt-1 space-y-0.5">
                  <div className="flex justify-between"><span className="text-gray-500">Admitted</span><span className="text-accent-green">{formatNumber(metrics.admissionMetrics.admitted)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Shed</span><span className="text-accent-red">{formatNumber(metrics.admissionMetrics.shed)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Avg Score (admitted)</span><span>{Number.isFinite(metrics.admissionMetrics.avgScoreAdmitted) ? metrics.admissionMetrics.avgScoreAdmitted.toFixed(2) : '-'}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Avg Score (shed)</span><span>{Number.isFinite(metrics.admissionMetrics.avgScoreShed) ? metrics.admissionMetrics.avgScoreShed.toFixed(2) : '-'}</span></div>
                </div>
              ) : <div className="text-gray-600 mt-1">No data</div>}
            </div>

            {/* DLQ */}
            <div>
              <span className="text-gray-400">Dead Letter Queue</span>
              {metrics.dlqMetrics ? (
                <div className="mt-1 space-y-0.5">
                  <div className="flex justify-between"><span className="text-gray-500">Total</span><span>{metrics.dlqMetrics.total}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Expired</span><span>{metrics.dlqMetrics.expired}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Validation</span><span>{metrics.dlqMetrics.validation}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Transient</span><span>{metrics.dlqMetrics.transient}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Unknown</span><span>{metrics.dlqMetrics.unknown}</span></div>
                </div>
              ) : <div className="text-gray-600 mt-1">No data</div>}
            </div>

            {/* Forwarding */}
            <div>
              <span className="text-gray-400">Forwarding Rejections</span>
              {metrics.forwardingMetrics ? (
                <div className="mt-1 space-y-0.5">
                  <div className="flex justify-between"><span className="text-gray-500">Expired</span><span>{metrics.forwardingMetrics.expired}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Duplicate</span><span>{metrics.forwardingMetrics.duplicate}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Profit Rejected</span><span>{metrics.forwardingMetrics.profitRejected}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Chain Rejected</span><span>{metrics.forwardingMetrics.chainRejected}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Circuit Open</span><span>{metrics.forwardingMetrics.circuitOpen}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Not Leader</span><span>{metrics.forwardingMetrics.notLeader}</span></div>
                </div>
              ) : <div className="text-gray-600 mt-1">No data</div>}
            </div>
          </div>
        </div>
      </div>

      {/* Right: Live Feed */}
      <LiveFeed items={feed} />
    </div>
  );
}
