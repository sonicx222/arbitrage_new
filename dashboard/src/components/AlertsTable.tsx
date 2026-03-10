import { useState, memo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAckAlert, fetchJson } from '../hooks/useApi';
import { formatTime } from '../lib/format';
import { toCsv, downloadCsv } from '../lib/export';
import type { Alert } from '../lib/types';

export const AlertsTable = memo(function AlertsTable() {
  const ackAlert = useAckAlert();
  const queryClient = useQueryClient();
  const [actionMsg, setActionMsg] = useState('');

  const { data: alerts = [] } = useQuery<Alert[]>({
    queryKey: ['alerts'],
    queryFn: () => fetchJson('/api/alerts'),
    refetchInterval: 15000,
    staleTime: 10000,
    retry: 1,
  });

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[10px] text-gray-500 uppercase tracking-wider">
          Alerts ({alerts.length})
          {actionMsg && <span className="text-accent-red ml-2">{actionMsg}</span>}
        </h3>
        <button
          onClick={() => {
            const headers = ['Time', 'Severity', 'Service', 'Type', 'Message'];
            const rows = alerts.map((a) => [
              new Date(a.timestamp).toISOString(),
              a.severity ?? 'info',
              a.service ?? '',
              a.type,
              a.message ?? '',
            ]);
            const csv = toCsv(headers, rows);
            const date = new Date().toISOString().slice(0, 10);
            downloadCsv(`alerts-${date}.csv`, csv);
          }}
          disabled={alerts.length === 0}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-medium text-gray-400 hover:text-gray-200 bg-[var(--badge-bg)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Export
        </button>
      </div>
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
            {alerts.map((alert) => (
              <tr key={`${alert.type}-${alert.timestamp}`} className="border-b border-gray-800/50">
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
                      const cooldownKey = `${alert.type}_${alert.service ?? 'system'}`;
                      ackAlert.mutate(cooldownKey, {
                        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['alerts'] }),
                        onError: (err) => { setActionMsg(`Ack failed: ${err.message}`); setTimeout(() => setActionMsg(''), 10000); },
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
  );
});
