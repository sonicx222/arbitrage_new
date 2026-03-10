import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAckAlert, fetchJson } from '../hooks/useApi';
import { formatTime } from '../lib/format';
import type { Alert } from '../lib/types';

export function AlertsTable() {
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
      <h3 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">
        Alerts ({alerts.length})
        {actionMsg && <span className="text-accent-red ml-2">{actionMsg}</span>}
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
  );
}
