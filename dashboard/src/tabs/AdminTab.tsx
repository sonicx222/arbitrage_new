import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useServices, useMetrics } from '../context/SSEContext';
import { useRestartService, fetchJson } from '../hooks/useApi';
import { useMutationFeedback } from '../hooks/useMutationFeedback';
import { ConfirmModal } from '../components/ConfirmModal';
import { CircuitBreakerGrid } from '../components/CircuitBreakerGrid';
import { DataTable, type Column } from '../components/DataTable';
import { LogLevelControl } from '../components/LogLevelControl';
import { AlertsTable } from '../components/AlertsTable';
import { NotificationSettings } from '../components/NotificationSettings';
import { StatusBadge } from '../components/StatusBadge';
import { formatTime, formatDuration } from '../lib/format';
import type { ServiceHealth } from '../lib/types';

export function AdminTab() {
  const { services } = useServices();
  const { metrics } = useMetrics();
  const restartService = useRestartService();

  const [restartTarget, setRestartTarget] = useState<string | null>(null);
  const { actionMsg, showSuccess, showError } = useMutationFeedback();

  const { data: leaderInfo } = useQuery<{ isLeader: boolean; instanceId: string; lockKey: string }>({
    queryKey: ['leader'],
    queryFn: () => fetchJson('/api/leader'),
    refetchInterval: 10000,
    staleTime: 5000,
    retry: 1,
  });

  const isLeader = leaderInfo?.isLeader ?? false;
  const serviceList = useMemo(() => Object.values(services), [services]);

  return (
    <div className="space-y-4 overflow-auto">
      {/* System Info */}
      <div className="card">
        <h3 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">System Info</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
          <div>
            <span className="text-gray-500">Instance</span>
            <div className="font-mono text-gray-300 truncate">{leaderInfo?.instanceId ?? '...'}</div>
          </div>
          <div>
            <span className="text-gray-500">Leader</span>
            <div className={isLeader ? 'text-accent-green font-bold' : 'text-gray-400'}>
              {isLeader ? 'YES' : 'NO'}
            </div>
          </div>
          <div>
            <span className="text-gray-500">Services</span>
            <div>{metrics?.activeServices ?? 0} active</div>
          </div>
          <div>
            <span className="text-gray-500">Last Update</span>
            <div>{metrics?.lastUpdate ? formatTime(metrics.lastUpdate) : '...'}</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <CircuitBreakerGrid />
        <LogLevelControl />
      </div>

      <NotificationSettings />

      {/* Service Management */}
      <div className="card">
        <h3 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">
          Service Management {!isLeader && <span className="text-accent-yellow">(read-only — not leader)</span>}
          {actionMsg && <span className={`ml-2 ${actionMsg.startsWith('Done') ? 'text-accent-green' : 'text-accent-red'}`}>{actionMsg}</span>}
        </h3>
        <DataTable<ServiceHealth>
          columns={[
            { header: 'Service', render: (svc) => <span className="font-mono text-gray-300">{svc.name}</span> },
            { header: 'Status', render: (svc) => <StatusBadge status={svc.status} label={svc.status} /> },
            { header: 'Uptime', align: 'right', render: (svc) => <span className="text-gray-500">{formatDuration(svc.uptime)}</span> },
            { header: 'Failures', align: 'right', render: (svc) => <>{svc.consecutiveFailures ?? 0}</> },
            { header: 'Restarts', align: 'right', render: (svc) => <>{svc.restartCount ?? 0}</> },
            { header: 'Action', align: 'center', render: (svc) => (
              <button
                onClick={() => setRestartTarget(svc.name)}
                disabled={!isLeader}
                className="px-2 py-0.5 text-[10px] rounded bg-accent-yellow/20 text-accent-yellow hover:bg-accent-yellow/30 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Restart
              </button>
            ) },
          ]}
          data={serviceList}
          keyExtractor={(svc) => svc.name}
          emptyMessage="No services"
        />
      </div>

      <AlertsTable />

      {/* Modals */}
      <ConfirmModal
        open={!!restartTarget}
        title={`Restart ${restartTarget}?`}
        danger
        confirmLabel="Restart"
        loading={restartService.isPending}
        onConfirm={() => {
          if (restartTarget) {
            restartService.mutate(restartTarget, {
              onSuccess: () => { setRestartTarget(null); showSuccess(`Done — ${restartTarget} restarting`); },
              onError: (err) => { setRestartTarget(null); showError(`Restart failed: ${err.message}`); },
            });
          }
        }}
        onCancel={() => setRestartTarget(null)}
      >
        This will restart the {restartTarget} service.
      </ConfirmModal>
    </div>
  );
}
