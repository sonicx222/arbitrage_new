// dashboard/src/components/LiveFeed.tsx
import type { FeedItem } from '../lib/types';
import { formatTime, formatUsd } from '../lib/format';

interface Props {
  items: FeedItem[];
}

export function LiveFeed({ items }: Props) {
  return (
    <div className="card flex flex-col h-full">
      <h4 className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Live Activity</h4>
      <div className="flex-1 overflow-y-auto space-y-1 text-xs">
        {items.length === 0 && <div className="text-gray-600">Waiting for events...</div>}
        {items.map((item) => (
          <div key={item.id} className="flex gap-2 py-0.5 border-b border-gray-800/50">
            <span className="text-gray-500 shrink-0">{formatTime(item.kind === 'execution' ? item.data.timestamp : item.data.timestamp)}</span>
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
                    : item.data.error?.slice(0, 30)}
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
}
