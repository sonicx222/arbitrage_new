import { memo, useEffect, useRef } from 'react';

const SHORTCUTS: [string, string][] = [
  ['1–7', 'Switch tabs'],
  ['?', 'Toggle this help'],
  ['Esc', 'Close overlay'],
];

interface Props {
  open: boolean;
  onClose: () => void;
}

export const ShortcutsOverlay = memo(function ShortcutsOverlay({ open, onClose }: Props) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
      role="dialog"
      aria-label="Keyboard shortcuts"
    >
      <div className="card w-72 shadow-2xl">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-bold text-gray-300">Keyboard Shortcuts</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-sm focus:outline-none focus:ring-1 focus:ring-gray-500 rounded" aria-label="Close">&times;</button>
        </div>
        <table className="w-full text-xs">
          <tbody>
            {SHORTCUTS.map(([key, desc]) => (
              <tr key={key} className="border-b border-gray-800/50">
                <td className="py-1.5 pr-4">
                  <kbd className="px-1.5 py-0.5 rounded bg-surface-lighter text-gray-300 font-mono text-[11px]">{key}</kbd>
                </td>
                <td className="py-1.5 text-gray-500">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3 text-[11px] text-gray-600">Shortcuts are disabled when typing in inputs.</div>
      </div>
    </div>
  );
});
