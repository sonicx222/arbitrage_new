import { useMemo, memo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAckAlert, fetchJson } from '../hooks/useApi';
import { useMutationFeedback } from '../hooks/useMutationFeedback';
import { DataTable } from '../components/DataTable';
import { ExportCsvButton } from '../components/ExportCsvButton';
import { formatTime } from '../lib/format';
import type { Alert } from '../lib/types';

const ALERT_CSV_HEADERS = ['Time', 'Severity', 'Service', 'Type', 'Message'];

export const AlertsTable = memo(function AlertsTable() {
  const ackAlert = useAckAlert();
  const queryClient = useQueryClient();
  const { actionMsg, showError } = useMutationFeedback();

  const { data: alerts = [] } = useQuery<Alert[]>({
    queryKey: ['alerts'],
    queryFn: () => fetchJson('/api/alerts'),
    refetchInterval: 15000,
    staleTime: 10000,
    retry: 1,
  });

  const exportRows = useMemo(
    () => alerts.map((a) => [
      new Date(a.timestamp).toISOString(),
      a.severity ?? 'info',
      a.service ?? '',
      a.type,
      a.message ?? '',
    ]),
    [alerts],
  );

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[10px] text-gray-500 uppercase tracking-wider">
          Alerts ({alerts.length})
          {actionMsg && <span className="text-accent-red ml-2">{actionMsg}</span>}
        </h3>
        <ExportCsvButton
          headers={ALERT_CSV_HEADERS}
          rows={exportRows}
          filenamePrefix="alerts"
          disabled={alerts.length === 0}
          label="Export"
        />
      </div>
      <DataTable<Alert>
        columns={[
          { header: 'Time', render: (alert) => <span className="text-gray-500">{formatTime(alert.timestamp)}</span> },
          { header: 'Severity', render: (alert) => (
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${
              alert.severity === 'critical' ? 'bg-accent-red/20 text-accent-red' :
              alert.severity === 'high' || alert.severity === 'warning' ? 'bg-accent-yellow/20 text-accent-yellow' :
              'bg-gray-700 text-gray-400'
            }`}>{alert.severity ?? 'info'}</span>
          ) },
          { header: 'Service', render: (alert) => <span className="text-gray-300">{alert.service ?? '-'}</span> },
          { header: 'Message', render: (alert) => <span className="text-gray-400 truncate max-w-xs block">{alert.message ?? alert.type}</span> },
          { header: 'Action', align: 'center', render: (alert) => (
            <button
              onClick={() => {
                const cooldownKey = `${alert.type}_${alert.service ?? 'system'}`;
                ackAlert.mutate(cooldownKey, {
                  onSuccess: () => queryClient.invalidateQueries({ queryKey: ['alerts'] }),
                  onError: (err) => { showError(`Ack failed: ${err.message}`); },
                });
              }}
              className="px-2 py-0.5 text-[10px] rounded bg-gray-700 text-gray-400 hover:text-gray-200"
            >
              Ack
            </button>
          ) },
        ]}
        data={alerts}
        keyExtractor={(alert) => `${alert.type}-${alert.timestamp}`}
        maxHeight="12rem"
        emptyMessage="No alerts"
      />
    </div>
  );
});
