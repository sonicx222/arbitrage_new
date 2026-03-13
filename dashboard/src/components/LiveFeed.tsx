import { memo } from 'react';
import type { FeedItem } from '../lib/types';
import { formatTime, formatUsd } from '../lib/format';

interface Props {
  items: FeedItem[];
}

export const LiveFeed = memo(function LiveFeed({ items }: Props) {
  return (
    <div className="card flex flex-col h-full">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-[11px] font-medium text-gray-500 uppercase tracking-wider">Live Activity</h4>
        <span className="text-[11px] font-mono text-gray-600">{items.length} events</span>
      </div>
      <div className="flex-1 overflow-y-auto space-y-0.5 text-xs font-mono">
        {items.length === 0 && (
          <div className="text-gray-600 flex items-center justify-center h-20">Waiting for events...</div>
        )}
        {items.map((item, i) => (
          <div
            key={item.id}
            className="flex gap-2 py-1.5 px-2 rounded-md border-b border-gray-800/50 hover:bg-surface-lighter/30 transition-colors"
            style={i === 0 ? { animation: 'slideUp 0.3s ease-out' } : undefined}
          >
            <span className="text-gray-600 shrink-0">
              {formatTime(item.data.timestamp)}
            </span>
            {item.kind === 'execution' ? (
              <div className="flex gap-2 min-w-0 flex-1">
                <span className={`shrink-0 ${item.data.success ? 'text-accent-green' : 'text-accent-red'}`}>
                  {item.data.success ? '\u2713' : '\u2717'}
                </span>
                <span className="text-gray-300 uppercase shrink-0">{item.data.chain}</span>
                <span className="text-gray-500 shrink-0">{item.data.dex}</span>
                {item.data.success && item.data.actualProfit != null ? (
                  <span className={`ml-auto shrink-0 ${item.data.actualProfit > 0 ? 'text-accent-green' : item.data.actualProfit < 0 ? 'text-accent-red' : ''}`}>{formatUsd(item.data.actualProfit)}</span>
                ) : item.data.error ? (
                  <span className="ml-auto text-accent-red line-clamp-2 text-right" title={item.data.error}>
                    {item.data.error}
                  </span>
                ) : null}
              </div>
            ) : (
              <div className="flex gap-2 min-w-0 flex-1">
                <span className="text-accent-yellow shrink-0">{'\u26A0'}</span>
                <span className="text-gray-300 shrink-0">{item.data.service}</span>
                <span
                  className="text-gray-500 line-clamp-2 break-words"
                  title={item.data.message ?? item.data.type}
                >
                  {item.data.message ?? item.data.type}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
});
