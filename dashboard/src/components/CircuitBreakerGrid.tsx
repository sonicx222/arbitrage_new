import { useState } from 'react';
import { useServices } from '../context/SSEContext';
import { useCircuitBreakerOpen, useCircuitBreakerClose } from '../hooks/useApi';
import { ConfirmModal } from './ConfirmModal';
import { statusColor, statusDot } from '../lib/format';

export function CircuitBreakerGrid() {
  const { circuitBreaker } = useServices();
  const openMutation = useCircuitBreakerOpen();
  const closeMutation = useCircuitBreakerClose();
  const [showOpen, setShowOpen] = useState(false);
  const [showClose, setShowClose] = useState(false);
  const [reason, setReason] = useState('');

  const [errorMsg, setErrorMsg] = useState('');
  const state = circuitBreaker?.state ?? 'UNKNOWN';
  const failures = circuitBreaker?.consecutiveFailures ?? 0;

  return (
    <div className="card">
      <h3 className="text-[10px] text-gray-500 uppercase tracking-wider mb-3">Circuit Breaker</h3>
      <div className="flex items-center gap-4 mb-3">
        <div className="flex items-center gap-2">
          <span className={`w-3 h-3 rounded-full ${statusDot(state)}`} />
          <span className={`font-bold ${statusColor(state)}`}>{state}</span>
        </div>
        <span className="text-xs text-gray-500">Failures: {failures}</span>
        {circuitBreaker && circuitBreaker.cooldownRemainingMs > 0 && (
          <span className="text-xs text-gray-500">
            Cooldown: {Math.ceil(circuitBreaker.cooldownRemainingMs / 1000)}s
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => setShowOpen(true)}
          className="px-3 py-1.5 text-xs rounded bg-accent-red/20 text-accent-red hover:bg-accent-red/30"
        >
          Force Open
        </button>
        <button
          onClick={() => setShowClose(true)}
          className="px-3 py-1.5 text-xs rounded bg-accent-green/20 text-accent-green hover:bg-accent-green/30"
        >
          Force Close
        </button>
        {errorMsg && <span className={`text-[10px] ml-2 ${errorMsg.startsWith('Done') ? 'text-accent-green' : 'text-accent-red'}`}>{errorMsg}</span>}
      </div>

      <ConfirmModal
        open={showOpen}
        title="Force Open Circuit Breaker"
        danger
        confirmLabel="Open Circuit"
        loading={openMutation.isPending}
        onConfirm={() => {
          openMutation.mutate(reason || 'Manual dashboard action', {
            onSuccess: () => { setShowOpen(false); setReason(''); setErrorMsg('Done — circuit breaker opened'); setTimeout(() => setErrorMsg(''), 3000); },
            onError: (err) => { setShowOpen(false); setErrorMsg(`CB open failed: ${err.message}`); setTimeout(() => setErrorMsg(''), 10000); },
          });
        }}
        onCancel={() => { setShowOpen(false); setReason(''); }}
      >
        <div>
          <p className="mb-2">This will halt all executions. Are you sure?</p>
          <input
            type="text"
            placeholder="Reason (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full bg-surface border border-gray-700 rounded px-2 py-1 text-xs"
          />
        </div>
      </ConfirmModal>

      <ConfirmModal
        open={showClose}
        title="Force Close Circuit Breaker"
        confirmLabel="Close Circuit"
        loading={closeMutation.isPending}
        onConfirm={() => {
          closeMutation.mutate(undefined, {
            onSuccess: () => { setShowClose(false); setErrorMsg('Done — circuit breaker closed'); setTimeout(() => setErrorMsg(''), 3000); },
            onError: (err) => { setShowClose(false); setErrorMsg(`CB close failed: ${err.message}`); setTimeout(() => setErrorMsg(''), 10000); },
          });
        }}
        onCancel={() => setShowClose(false)}
      >
        This will resume executions. Are you sure?
      </ConfirmModal>
    </div>
  );
}
