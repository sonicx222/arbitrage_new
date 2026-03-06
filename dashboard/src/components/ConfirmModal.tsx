// dashboard/src/components/ConfirmModal.tsx
import { type ReactNode } from 'react';

interface Props {
  open: boolean;
  title: string;
  children?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
  confirmLabel?: string;
  danger?: boolean;
}

export function ConfirmModal({ open, title, children, onConfirm, onCancel, loading, confirmLabel = 'Confirm', danger }: Props) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="card w-96 shadow-xl border border-gray-700">
        <h3 className="font-bold text-sm mb-3">{title}</h3>
        {children && <div className="text-xs text-gray-400 mb-4">{children}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-xs rounded bg-gray-700 hover:bg-gray-600">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={`px-3 py-1.5 text-xs rounded font-medium ${
              danger ? 'bg-accent-red/20 text-accent-red hover:bg-accent-red/30' : 'bg-accent-green/20 text-accent-green hover:bg-accent-green/30'
            } disabled:opacity-50`}
          >
            {loading ? 'Working...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
