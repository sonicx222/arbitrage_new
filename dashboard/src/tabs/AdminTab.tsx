import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSSEData } from '../context/SSEContext';
import { useRestartService, fetchJson } from '../hooks/useApi';
import { ConfirmModal } from '../components/ConfirmModal';
import { CircuitBreakerGrid } from '../components/CircuitBreakerGrid';
import { LogLevelControl } from '../components/LogLevelControl';
import { AlertsTable } from '../components/AlertsTable';
import { StatusBadge } from '../components/StatusBadge';
import { formatTime, formatDuration } from '../lib/format';

export function AdminTab() {
  const { services, metrics } = useSSEData();
  const restartService = useRestartService();

  const [restartTarget, setRestartTarget] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState('');

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
        <div className="grid grid-cols-4 gap-4 text-xs">
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

      <div className="grid grid-cols-2 gap-4">
        <CircuitBreakerGrid />
        <LogLevelControl />
      </div>

      {/* Service Management */}
      <div className="card">
        <h3 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">
          Service Management {!isLeader && <span className="text-accent-yellow">(read-only — not leader)</span>}
          {actionMsg && <span className="text-accent-red ml-2">{actionMsg}</span>}
        </h3>
        <div className="overflow-auto max-h-64">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-gray-800">
                <th className="text-left py-1 px-2">Service</th>
                <th className="text-left py-1 px-2">Status</th>
                <th className="text-right py-1 px-2">Uptime</th>
                <th className="text-right py-1 px-2">Failures</th>
                <th className="text-right py-1 px-2">Restarts</th>
                <th className="text-center py-1 px-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {serviceList.map((svc) => (
                <tr key={svc.name} className="border-b border-gray-800/50 hover:bg-surface-lighter/30">
                  <td className="py-1 px-2 font-mono text-gray-300">{svc.name}</td>
                  <td className="py-1 px-2"><StatusBadge status={svc.status} label={svc.status} /></td>
                  <td className="py-1 px-2 text-right text-gray-500">{formatDuration(svc.uptime)}</td>
                  <td className="py-1 px-2 text-right">{svc.consecutiveFailures ?? 0}</td>
                  <td className="py-1 px-2 text-right">{svc.restartCount ?? 0}</td>
                  <td className="py-1 px-2 text-center">
                    <button
                      onClick={() => setRestartTarget(svc.name)}
                      disabled={!isLeader}
                      className="px-2 py-0.5 text-[10px] rounded bg-accent-yellow/20 text-accent-yellow hover:bg-accent-yellow/30 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      Restart
                    </button>
                  </td>
                </tr>
              ))}
              {serviceList.length === 0 && (
                <tr><td colSpan={6} className="text-center py-4 text-gray-600">No services</td></tr>
              )}
            </tbody>
          </table>
        </div>
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
              onSuccess: () => { setRestartTarget(null); setActionMsg(''); },
              onError: (err) => { setRestartTarget(null); setActionMsg(`Restart failed: ${err.message}`); setTimeout(() => setActionMsg(''), 5000); },
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
