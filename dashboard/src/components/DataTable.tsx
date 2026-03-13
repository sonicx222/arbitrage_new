import { type ReactNode } from 'react';

export interface Column<T> {
  header: string;
  align?: 'left' | 'right' | 'center';
  render: (item: T) => ReactNode;
  onHeaderClick?: () => void;
  headerSuffix?: string;
}

interface Props<T> {
  columns: Column<T>[];
  data: T[];
  keyExtractor: (item: T) => string;
  maxHeight?: string;
  emptyMessage?: string;
}

const ALIGN = { left: 'text-left', right: 'text-right', center: 'text-center' } as const;

export function DataTable<T>({ columns, data, keyExtractor, maxHeight = '16rem', emptyMessage = 'No data' }: Props<T>) {
  return (
    <div className="overflow-auto" style={{ maxHeight }}>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-500 border-b border-gray-800">
            {columns.map((col, i) => (
              <th
                key={i}
                className={`${ALIGN[col.align ?? 'left']} py-1 px-2${col.onHeaderClick ? ' cursor-pointer hover:text-gray-300 select-none focus:outline-none focus:text-gray-200' : ''}`}
                onClick={col.onHeaderClick}
                onKeyDown={col.onHeaderClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); col.onHeaderClick!(); } } : undefined}
                role={col.onHeaderClick ? 'button' : undefined}
                tabIndex={col.onHeaderClick ? 0 : undefined}
                aria-sort={col.headerSuffix?.includes('\u25B2') ? 'ascending' : col.headerSuffix?.includes('\u25BC') ? 'descending' : undefined}
              >
                {col.header}{col.headerSuffix ?? ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((item) => (
            <tr key={keyExtractor(item)} className="border-b border-gray-800/50 hover:bg-surface-lighter/30">
              {columns.map((col, i) => (
                <td key={i} className={`py-1 px-2 ${ALIGN[col.align ?? 'left']}`}>
                  {col.render(item)}
                </td>
              ))}
            </tr>
          ))}
          {data.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="text-center py-4 text-gray-600">{emptyMessage}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
