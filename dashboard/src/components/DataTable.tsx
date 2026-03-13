import { useRef, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export interface Column<T> {
  header: string;
  align?: 'left' | 'right' | 'center';
  render: (item: T) => ReactNode;
  onHeaderClick?: () => void;
  headerSuffix?: string;
  sortDirection?: 'ascending' | 'descending';
}

interface Props<T> {
  columns: Column<T>[];
  data: T[];
  keyExtractor: (item: T) => string;
  maxHeight?: string;
  emptyMessage?: string;
}

const ALIGN = { left: 'text-left', right: 'text-right', center: 'text-center' } as const;

// Virtualize when row count exceeds this threshold
const VIRTUALIZE_THRESHOLD = 30;
const ROW_HEIGHT = 28; // px — matches py-1 (4px top + 4px bottom) + text-xs line-height (~20px)

export function DataTable<T>({ columns, data, keyExtractor, maxHeight = '16rem', emptyMessage = 'No data' }: Props<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldVirtualize = data.length > VIRTUALIZE_THRESHOLD;

  const virtualizer = useVirtualizer({
    count: data.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    enabled: shouldVirtualize,
  });

  const headerRow = (
    <tr className="text-gray-500 border-b border-gray-800">
      {columns.map((col, i) => (
        <th
          key={i}
          scope="col"
          className={`${ALIGN[col.align ?? 'left']} py-1 px-2`}
          aria-sort={col.sortDirection}
        >
          {col.onHeaderClick ? (
            <button
              type="button"
              className="w-full text-inherit cursor-pointer hover:text-gray-300 select-none focus:outline-none focus:text-gray-200 bg-transparent border-none p-0 font-inherit text-left"
              onClick={col.onHeaderClick}
              onKeyDown={(e) => { if (e.key === ' ') { e.preventDefault(); col.onHeaderClick!(); } }}
            >
              {col.header}{col.headerSuffix || (!col.sortDirection ? ' \u21C5' : '')}
            </button>
          ) : (
            <>{col.header}{col.headerSuffix ?? ''}</>
          )}
        </th>
      ))}
    </tr>
  );

  if (!shouldVirtualize) {
    return (
      <div ref={scrollRef} className="overflow-auto focus:outline-none focus:ring-1 focus:ring-gray-700 rounded" style={{ maxHeight }} tabIndex={0} role="region" aria-label="Scrollable data table">
        <table className="w-full text-xs">
          <thead>{headerRow}</thead>
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

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div ref={scrollRef} className="overflow-auto focus:outline-none focus:ring-1 focus:ring-gray-700 rounded" style={{ maxHeight }} tabIndex={0} role="region" aria-label="Scrollable data table">
      <table className="w-full text-xs">
        <thead className="sticky top-0 z-10 bg-surface">{headerRow}</thead>
        <tbody>
          {data.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="text-center py-4 text-gray-600">{emptyMessage}</td>
            </tr>
          ) : (
            <>
              {virtualItems[0]?.start > 0 && (
                <tr aria-hidden="true"><td colSpan={columns.length} style={{ height: virtualItems[0].start, padding: 0 }} /></tr>
              )}
              {virtualItems.map((virtualRow) => {
                const item = data[virtualRow.index];
                return (
                  <tr key={keyExtractor(item)} className="border-b border-gray-800/50 hover:bg-surface-lighter/30">
                    {columns.map((col, i) => (
                      <td key={i} className={`py-1 px-2 ${ALIGN[col.align ?? 'left']}`}>
                        {col.render(item)}
                      </td>
                    ))}
                  </tr>
                );
              })}
              {virtualItems[virtualItems.length - 1]?.end < virtualizer.getTotalSize() && (
                <tr aria-hidden="true">
                  <td colSpan={columns.length} style={{ height: virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end, padding: 0 }} />
                </tr>
              )}
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}
