import { memo } from 'react';
import type { FeedItem } from '../lib/types';
import { formatTime, formatUsd } from '../lib/format';
import { MAX_ERROR_DISPLAY } from '../lib/theme';

interface Props {
  items: FeedItem[];
}

export const LiveFeed = memo(function LiveFeed({ items }: Props) {
  return (
    <div className="card flex flex-col h-full">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-[10px] font-medium text-gray-500 uppercase tracking-wider">Live Activity</h4>
        <span className="text-[10px] font-mono text-gray-600">{items.length} events</span>
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
              <>
                <span className={item.data.success ? 'text-accent-green' : 'text-accent-red'}>
                  {item.data.success ? '\u2713' : '\u2717'}
                </span>
                <span className="text-gray-300 uppercase">{item.data.chain}</span>
                <span className="text-gray-500">{item.data.dex}</span>
                <span className="ml-auto">
                  {item.data.success && item.data.actualProfit != null
                    ? formatUsd(item.data.actualProfit)
                    : item.data.error?.slice(0, MAX_ERROR_DISPLAY)}
                </span>
              </>
            ) : (
              <>
                <span className="text-accent-yellow">{'\u26A0'}</span>
                <span className="text-gray-300">{item.data.service}</span>
                <span className="text-gray-500 truncate">{item.data.message ?? item.data.type}</span>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
});
