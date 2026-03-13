import { toCsv, downloadCsv } from '../lib/export';

interface Props {
  headers: string[];
  rows: unknown[][];
  filenamePrefix: string;
  disabled?: boolean;
  label?: string;
}

export function ExportCsvButton({ headers, rows, filenamePrefix, disabled, label = 'Export CSV' }: Props) {
  return (
    <button
      onClick={() => {
        const csv = toCsv(headers, rows);
        downloadCsv(`${filenamePrefix}-${new Date().toISOString().slice(0, 10)}.csv`, csv);
      }}
      disabled={disabled}
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium text-gray-400 hover:text-gray-200 bg-[var(--badge-bg)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
    >
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
      </svg>
      {label}
    </button>
  );
}
