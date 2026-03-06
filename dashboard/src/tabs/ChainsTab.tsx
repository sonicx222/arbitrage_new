import { useSSEData } from '../context/SSEContext';
import { StatusBadge } from '../components/StatusBadge';
import { ChainCard } from '../components/ChainCard';
import { formatDuration, formatMemory } from '../lib/format';

const PARTITIONS = [
  { id: 'asia-fast', name: 'P1: Asia-Fast', region: 'Singapore', chains: ['bsc', 'polygon', 'avalanche', 'fantom'] },
  { id: 'l2-turbo', name: 'P2: L2-Turbo', region: 'Singapore', chains: ['arbitrum', 'optimism', 'base', 'scroll', 'blast'] },
  { id: 'high-value', name: 'P3: High-Value', region: 'US-East', chains: ['ethereum', 'zksync', 'linea'] },
  { id: 'solana-native', name: 'P4: Solana', region: 'US-West', chains: ['solana'] },
];

export function ChainsTab() {
  const { services } = useSSEData();

  return (
    <div className="space-y-6 overflow-auto">
      <h2 className="text-sm font-bold text-gray-300">Chain Partitions</h2>
      {PARTITIONS.map((partition) => {
        const svcKey = `partition-${partition.id}`;
        const svc = services[svcKey];
        const partitionStatus = svc?.status ?? 'unknown';

        return (
          <div key={partition.id} className="card">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <StatusBadge status={partitionStatus} label={partition.name} />
                <span className="text-[10px] text-gray-500">{partition.region}</span>
                <span className="text-[10px] text-gray-500">{partition.chains.length} chains</span>
              </div>
              {svc && (
                <div className="flex gap-3 text-[10px] text-gray-500">
                  <span>Uptime: {formatDuration(svc.uptime)}</span>
                  <span>Mem: {formatMemory(svc.memoryUsage)}</span>
                  <span>CPU: {(svc.cpuUsage * 100).toFixed(1)}%</span>
                  {svc.latency != null && <span>Latency: {svc.latency.toFixed(0)}ms</span>}
                </div>
              )}
            </div>
            <div className="grid grid-cols-5 gap-2">
              {partition.chains.map((chain) => (
                <ChainCard key={chain} chain={chain} status={partitionStatus} />
              ))}
            </div>
          </div>
        );
      })}

      {/* Cross-chain detector and execution engine */}
      <div className="grid grid-cols-2 gap-4">
        {['cross-chain-detector', 'execution-engine'].map((name) => {
          const svc = services[name];
          return (
            <div key={name} className="card">
              <div className="flex items-center justify-between">
                <StatusBadge status={svc?.status ?? 'unknown'} label={name} />
                {svc && (
                  <div className="flex gap-3 text-[10px] text-gray-500">
                    <span>{formatDuration(svc.uptime)}</span>
                    <span>{formatMemory(svc.memoryUsage)}</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
