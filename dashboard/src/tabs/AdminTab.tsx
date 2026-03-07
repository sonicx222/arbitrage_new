import { useState, useMemo, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSSEData } from '../context/SSEContext';
import { useSetLogLevel, useRestartService, useAckAlert, fetchJson } from '../hooks/useApi';
import { ConfirmModal } from '../components/ConfirmModal';
import { CircuitBreakerGrid } from '../components/CircuitBreakerGrid';
import { StatusBadge } from '../components/StatusBadge';
import { formatTime, formatDuration } from '../lib/format';
import type { Alert } from '../lib/types';

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

export function AdminTab() {
  const { services, metrics } = useSSEData();
  const setLogLevel = useSetLogLevel();
  const restartService = useRestartService();
  const ackAlert = useAckAlert();
  const queryClient = useQueryClient();

  const [restartTarget, setRestartTarget] = useState<string | null>(null);
  const [activeLogLevel, setActiveLogLevel] = useState<string>('info');
  const [logLevelMsg, setLogLevelMsg] = useState('');
  const [actionMsg, setActionMsg] = useState('');

  // M-04 FIX: Fetch current log level from server on mount (not hardcoded)
  const { data: logLevelData } = useQuery<{ level: string }>({
    queryKey: ['log-level'],
    queryFn: () => fetchJson('/api/log-level'),
    staleTime: 30000,
    retry: 1,
  });
  // Sync server-reported level into local state once on initial fetch
  const logLevelSynced = useRef(false);
  useEffect(() => {
    if (logLevelData?.level && !logLevelSynced.current) {
      logLevelSynced.current = true;
      setActiveLogLevel(logLevelData.level);
    }
  }, [logLevelData?.level]);

  // Fetch alerts on tab mount
  const { data: alerts = [] } = useQuery<Alert[]>({
    queryKey: ['alerts'],
    queryFn: () => fetchJson('/api/alerts'),
    refetchInterval: 15000,
    staleTime: 10000,
    retry: 1,
  });

  // Fetch leader status (10s to reduce stale window for admin actions)
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
        {/* Circuit Breaker Control — shared component (also in ExecutionTab) */}
        <CircuitBreakerGrid />

        {/* Log Level */}
        <div className="card">
          <h3 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Log Level</h3>
          <div className="flex gap-1 mb-2">
            {LOG_LEVELS.map((level) => (
              <button
                key={level}
                onClick={() => {
                  setLogLevel.mutate(level, {
                    onSuccess: () => { setActiveLogLevel(level); setLogLevelMsg(`Set to ${level}`); setTimeout(() => setLogLevelMsg(''), 3000); },
                    onError: (err) => { setLogLevelMsg(`Error: ${err.message}`); setTimeout(() => setLogLevelMsg(''), 5000); },
                  });
                }}
                disabled={setLogLevel.isPending}
                className={`px-2 py-1 text-xs rounded ${
                  activeLogLevel === level
                    ? 'bg-accent-blue/20 text-accent-blue border border-accent-blue/50'
                    : 'bg-gray-700 text-gray-400 hover:text-gray-200'
                }`}
              >
                {level}
              </button>
            ))}
          </div>
          {logLevelMsg && <div className="text-[10px] text-accent-blue">{logLevelMsg}</div>}
        </div>
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

      {/* Alerts */}
      <div className="card">
        <h3 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">
          Alerts ({alerts.length})
        </h3>
        <div className="overflow-auto max-h-48">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-gray-800">
                <th className="text-left py-1 px-2">Time</th>
                <th className="text-left py-1 px-2">Severity</th>
                <th className="text-left py-1 px-2">Service</th>
                <th className="text-left py-1 px-2">Message</th>
                <th className="text-center py-1 px-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((alert, i) => (
                <tr key={`${alert.type}-${alert.timestamp}-${i}`} className="border-b border-gray-800/50">
                  <td className="py-1 px-2 text-gray-500">{formatTime(alert.timestamp)}</td>
                  <td className="py-1 px-2">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                      alert.severity === 'critical' ? 'bg-accent-red/20 text-accent-red' :
                      alert.severity === 'high' ? 'bg-accent-yellow/20 text-accent-yellow' :
                      alert.severity === 'warning' ? 'bg-accent-yellow/20 text-accent-yellow' :
                      'bg-gray-700 text-gray-400'
                    }`}>{alert.severity ?? 'info'}</span>
                  </td>
                  <td className="py-1 px-2 text-gray-300">{alert.service ?? '-'}</td>
                  <td className="py-1 px-2 text-gray-400 truncate max-w-xs">{alert.message ?? alert.type}</td>
                  <td className="py-1 px-2 text-center">
                    <button
                      onClick={() => {
                        // Cooldown key format: ${type}_${service || 'system'}
                        const cooldownKey = `${alert.type}_${alert.service ?? 'system'}`;
                        ackAlert.mutate(cooldownKey, {
                          onSuccess: () => queryClient.invalidateQueries({ queryKey: ['alerts'] }),
                          onError: (err) => { setActionMsg(`Ack failed: ${err.message}`); setTimeout(() => setActionMsg(''), 5000); },
                        });
                      }}
                      className="px-2 py-0.5 text-[10px] rounded bg-gray-700 text-gray-400 hover:text-gray-200"
                    >
                      Ack
                    </button>
                  </td>
                </tr>
              ))}
              {alerts.length === 0 && (
                <tr><td colSpan={5} className="text-center py-4 text-gray-600">No alerts</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

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
