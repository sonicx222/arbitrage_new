import { useQuery } from '@tanstack/react-query';
import { useMetrics } from '../context/SSEContext';
import { fetchJson } from '../hooks/useApi';
import { EmptyState } from '../components/EmptyState';
import { Skeleton } from '../components/Skeleton';
import { SectionHeader } from '../components/SectionHeader';
import { StatRow } from '../components/StatRow';
import { formatPct, formatNumber } from '../lib/format';

const RISK_STATES = ['NORMAL', 'CAUTION', 'HALT', 'RECOVERY'] as const;

const stateColors: Record<string, string> = {
  NORMAL: 'border-accent-green text-accent-green',
  CAUTION: 'border-accent-yellow text-accent-yellow',
  HALT: 'border-accent-red text-accent-red',
  RECOVERY: 'border-accent-blue text-accent-blue',
};

const stateColorsMuted: Record<string, string> = {
  NORMAL: 'border-gray-700 text-gray-600',
  CAUTION: 'border-gray-700 text-gray-600',
  HALT: 'border-gray-700 text-gray-600',
  RECOVERY: 'border-gray-700 text-gray-600',
};

interface EEHealthResponse {
  riskState?: string;
  simulationMode?: boolean;
  healthyProviders?: number;
  queueSize?: number;
  activeExecutions?: number;
  successRate?: string;
}

export function RiskTab() {
  const { metrics } = useMetrics();

  // Fetch EE health on tab mount for risk state
  // In dev, Vite proxies /ee/* to EE port 3005. In prod, coordinator proxies.
  const { data: eeHealth, isLoading: eeLoading, isError: eeUnreachable } = useQuery<EEHealthResponse>({
    queryKey: ['ee-health'],
    queryFn: () => fetchJson('/ee/health'),
    refetchInterval: 10000,
    staleTime: 5000,
    retry: 1,
  });

  const currentRiskState = eeUnreachable ? 'UNREACHABLE' : (eeHealth?.riskState ?? 'UNKNOWN');

  return (
    <div className="space-y-4 overflow-auto">
      {/* Risk State Machine */}
      <div className="card">
        <SectionHeader mb="mb-3">Risk Circuit Breaker</SectionHeader>
        {eeLoading && (
          <div className="flex gap-2 mb-3">
            {RISK_STATES.map((s) => <Skeleton key={s} className="h-10 w-24" />)}
          </div>
        )}
        {eeUnreachable && (
          <div className="mb-2 px-2 py-1 bg-accent-red/10 border border-accent-red/30 rounded text-[10px] text-accent-red">
            Execution Engine unreachable — check if the service is running
          </div>
        )}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          {RISK_STATES.map((state, i) => (
            <div key={state} className="flex items-center gap-2">
              <div className={`px-4 py-2 rounded border-2 text-xs font-bold ${
                currentRiskState === state ? stateColors[state] : stateColorsMuted[state]
              } ${currentRiskState === state ? 'bg-surface-lighter' : ''}`}>
                {state}
              </div>
              {i < RISK_STATES.length - 1 && (
                <span className="text-gray-600">&rarr;</span>
              )}
            </div>
          ))}
        </div>
        {eeHealth && (
          <div className="flex gap-4 text-[10px] text-gray-500">
            <span>Simulation: {eeHealth.simulationMode ? 'ON' : 'OFF'}</span>
            <span>Providers: {eeHealth.healthyProviders ?? '?'}</span>
            <span>Queue: {eeHealth.queueSize ?? 0}</span>
            <span>Active: {eeHealth.activeExecutions ?? 0}</span>
            {eeHealth.successRate && <span>Success: {eeHealth.successRate}</span>}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Admission Control */}
        <div className="card">
          <SectionHeader mb="mb-3">Admission Control</SectionHeader>
          {metrics?.admissionMetrics ? (
            <div className="space-y-3">
              <div className="flex gap-4">
                <div className="flex-1">
                  <div className="text-[10px] text-gray-500">Admitted</div>
                  <div className="text-lg font-bold text-accent-green">{formatNumber(metrics.admissionMetrics.admitted)}</div>
                </div>
                <div className="flex-1">
                  <div className="text-[10px] text-gray-500">Shed</div>
                  <div className="text-lg font-bold text-accent-red">{formatNumber(metrics.admissionMetrics.shed)}</div>
                </div>
              </div>
              {/* Admission ratio bar */}
              {(metrics.admissionMetrics.admitted + metrics.admissionMetrics.shed) > 0 && (
                <div>
                  <div className="flex justify-between text-[10px] text-gray-500 mb-1">
                    <span>Admission Rate</span>
                    <span>{formatPct(metrics.admissionMetrics.admitted / (metrics.admissionMetrics.admitted + metrics.admissionMetrics.shed) * 100)}</span>
                  </div>
                  <div className="bg-gray-800 rounded-full h-2">
                    <div
                      className="bg-accent-green h-2 rounded-full"
                      style={{ width: `${(metrics.admissionMetrics.admitted / (metrics.admissionMetrics.admitted + metrics.admissionMetrics.shed)) * 100}%` }}
                    />
                  </div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2 text-xs">
                <StatRow label="Avg Score (admitted)" value={Number.isFinite(metrics.admissionMetrics.avgScoreAdmitted) ? metrics.admissionMetrics.avgScoreAdmitted.toFixed(3) : '-'} />
                <StatRow label="Avg Score (shed)" value={Number.isFinite(metrics.admissionMetrics.avgScoreShed) ? metrics.admissionMetrics.avgScoreShed.toFixed(3) : '-'} />
              </div>
            </div>
          ) : (
            <EmptyState message="Admission control not active" />
          )}
        </div>

        {/* Forwarding Rejections */}
        <div className="card">
          <SectionHeader mb="mb-3">Forwarding Rejections</SectionHeader>
          {metrics?.forwardingMetrics ? (
            <div className="space-y-1.5 text-xs">
              {Object.entries(metrics.forwardingMetrics).map(([key, val]) => (
                <div key={key} className="flex justify-between">
                  <span className="text-gray-500 capitalize">{key.replace(/([A-Z])/g, ' $1').trim()}</span>
                  <span className={val > 0 ? 'text-accent-yellow' : 'text-gray-600'}>{val}</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState message="No forwarding data" />
          )}
        </div>
      </div>

      {/* Backpressure */}
      <div className="card">
        <SectionHeader mb="mb-3">Backpressure</SectionHeader>
        {metrics?.backpressure ? (
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-gray-400">Execution Stream Depth</span>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold">
                  {formatPct(metrics.backpressure.executionStreamDepthRatio * 100)}
                </span>
                <span className={`text-[10px] px-2 py-0.5 rounded ${
                  metrics.backpressure.active
                    ? 'bg-accent-red/20 text-accent-red'
                    : 'bg-accent-green/20 text-accent-green'
                }`}>
                  {metrics.backpressure.active ? 'ACTIVE' : 'INACTIVE'}
                </span>
              </div>
            </div>
            <div className="bg-gray-800 rounded-full h-4">
              <div
                className={`h-4 rounded-full transition-all ${
                  metrics.backpressure.active ? 'bg-accent-red' : metrics.backpressure.executionStreamDepthRatio > 0.7 ? 'bg-accent-yellow' : 'bg-accent-green'
                }`}
                style={{ width: `${Math.min(metrics.backpressure.executionStreamDepthRatio * 100, 100)}%` }}
              />
            </div>
          </div>
        ) : (
          <EmptyState message="No backpressure data" />
        )}
      </div>
    </div>
  );
}
