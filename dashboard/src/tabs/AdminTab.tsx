import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSSEData } from '../context/SSEContext';
import { useCircuitBreakerOpen, useCircuitBreakerClose, useSetLogLevel, useRestartService, useAckAlert, fetchJson } from '../hooks/useApi';
import { ConfirmModal } from '../components/ConfirmModal';
import { StatusBadge } from '../components/StatusBadge';
import { formatTime, formatDuration, statusDot } from '../lib/format';
import type { Alert } from '../lib/types';

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

export function AdminTab() {
  const { services, circuitBreaker, metrics } = useSSEData();
  const cbOpen = useCircuitBreakerOpen();
  const cbClose = useCircuitBreakerClose();
  const setLogLevel = useSetLogLevel();
  const restartService = useRestartService();
  const ackAlert = useAckAlert();
  const queryClient = useQueryClient();

  const [showCBOpen, setShowCBOpen] = useState(false);
  const [showCBClose, setShowCBClose] = useState(false);
  const [cbReason, setCBReason] = useState('');
  const [restartTarget, setRestartTarget] = useState<string | null>(null);
  const [activeLogLevel, setActiveLogLevel] = useState<string>('info');
  const [logLevelMsg, setLogLevelMsg] = useState('');

  // Fetch alerts on tab mount
  const { data: alerts = [] } = useQuery<Alert[]>({
    queryKey: ['alerts'],
    queryFn: () => fetchJson('/api/alerts'),
    refetchInterval: 15000,
    staleTime: 10000,
    retry: 1,
  });

  // Fetch leader status
  const { data: leaderInfo } = useQuery<{ isLeader: boolean; instanceId: string; lockKey: string }>({
    queryKey: ['leader'],
    queryFn: () => fetchJson('/api/leader'),
    refetchInterval: 30000,
    staleTime: 15000,
    retry: 1,
  });

  const isLeader = leaderInfo?.isLeader ?? false;
  const serviceList = Object.values(services);

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
        {/* Circuit Breaker Control */}
        <div className="card">
          <h3 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Circuit Breaker Control</h3>
          <div className="flex items-center gap-3 mb-3">
            <span className={`w-3 h-3 rounded-full ${statusDot(circuitBreaker?.state ?? 'UNKNOWN')}`} />
            <span className="text-sm font-bold">{circuitBreaker?.state ?? 'UNKNOWN'}</span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setShowCBOpen(true)}
              className="px-3 py-1.5 text-xs rounded bg-accent-red/20 text-accent-red hover:bg-accent-red/30"
            >
              Force Open
            </button>
            <button
              onClick={() => setShowCBClose(true)}
              className="px-3 py-1.5 text-xs rounded bg-accent-green/20 text-accent-green hover:bg-accent-green/30"
            >
              Force Close
            </button>
          </div>
        </div>

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
                        ackAlert.mutate(alert.type, {
                          onSuccess: () => queryClient.invalidateQueries({ queryKey: ['alerts'] }),
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
        open={showCBOpen}
        title="Force Open Circuit Breaker"
        danger
        confirmLabel="Open Circuit"
        loading={cbOpen.isPending}
        onConfirm={() => {
          cbOpen.mutate(cbReason || 'Manual dashboard action', {
            onSuccess: () => { setShowCBOpen(false); setCBReason(''); },
          });
        }}
        onCancel={() => { setShowCBOpen(false); setCBReason(''); }}
      >
        <div>
          <p className="mb-2">This will halt all executions.</p>
          <input
            type="text"
            placeholder="Reason (optional)"
            value={cbReason}
            onChange={(e) => setCBReason(e.target.value)}
            className="w-full bg-surface border border-gray-700 rounded px-2 py-1 text-xs"
          />
        </div>
      </ConfirmModal>

      <ConfirmModal
        open={showCBClose}
        title="Force Close Circuit Breaker"
        confirmLabel="Close Circuit"
        loading={cbClose.isPending}
        onConfirm={() => {
          cbClose.mutate(undefined, { onSuccess: () => setShowCBClose(false) });
        }}
        onCancel={() => setShowCBClose(false)}
      >
        This will resume executions.
      </ConfirmModal>

      <ConfirmModal
        open={!!restartTarget}
        title={`Restart ${restartTarget}?`}
        danger
        confirmLabel="Restart"
        loading={restartService.isPending}
        onConfirm={() => {
          if (restartTarget) {
            restartService.mutate(restartTarget, {
              onSuccess: () => setRestartTarget(null),
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
