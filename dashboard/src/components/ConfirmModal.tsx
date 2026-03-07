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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', animation: 'fadeIn 0.15s ease-out' }}
    >
      <div className="card w-96 shadow-2xl" style={{ animation: 'slideUp 0.2s ease-out' }}>
        <h3 className="font-display font-bold text-sm mb-3">{title}</h3>
        {children && <div className="text-xs text-gray-400 mb-4">{children}</div>}
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-xs rounded-lg font-medium text-gray-400 hover:text-gray-300 transition-colors"
            style={{ background: 'var(--badge-bg)' }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={`px-4 py-2 text-xs rounded-lg font-medium transition-all disabled:opacity-50 active:scale-[0.98] ${
              danger
                ? 'bg-accent-red/15 text-accent-red hover:bg-accent-red/25'
                : 'bg-accent-green/15 text-accent-green hover:bg-accent-green/25'
            }`}
          >
            {loading ? 'Working...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
