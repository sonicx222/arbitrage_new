import { useSSEData } from '../context/SSEContext';
import { StatusBadge } from '../components/StatusBadge';
import { ChainCard } from '../components/ChainCard';
import { formatDuration, formatMemory, formatCpu } from '../lib/format';
// D-5 FIX: Import source of truth for compile-time service key verification
import portConfig from '@shared/constants/service-ports.json';

// D-5 FIX: Service keys type-checked against service-ports.json.
// If a service name is renamed in the JSON, TypeScript flags the mismatch here.
type KnownService = keyof typeof portConfig.services;

// RT-3AO-001 FIX: Partition services register health as `unified-detector-${partitionId}`,
// not as `partition-*` from service-ports.json. The `healthKey` maps to the actual key
// in the coordinator's serviceHealth map (sent via SSE 'services' event).
const PARTITIONS: { svcKey: KnownService; healthKey: string; name: string; region: string; chains: string[] }[] = [
  { svcKey: 'partition-asia-fast', healthKey: 'unified-detector-asia-fast', name: 'P1: Asia-Fast', region: 'Singapore', chains: ['bsc', 'polygon', 'avalanche', 'fantom'] },
  { svcKey: 'partition-l2-turbo', healthKey: 'unified-detector-l2-turbo', name: 'P2: L2-Turbo', region: 'Singapore', chains: ['arbitrum', 'optimism', 'base', 'scroll', 'blast', 'mantle', 'mode'] },
  { svcKey: 'partition-high-value', healthKey: 'unified-detector-high-value', name: 'P3: High-Value', region: 'US-East', chains: ['ethereum', 'zksync', 'linea'] },
  { svcKey: 'partition-solana', healthKey: 'unified-detector-solana-native', name: 'P4: Solana', region: 'US-West', chains: ['solana'] },
];

export function ChainsTab() {
  const { services } = useSSEData();

  return (
    <div className="space-y-6 overflow-auto">
      <h2 className="text-sm font-bold text-gray-300">Chain Partitions</h2>
      {PARTITIONS.map((partition) => {
        // RT-3AO-001 FIX: Look up by healthKey (unified-detector-*) not svcKey (partition-*)
        const svc = services[partition.healthKey];
        const partitionStatus = svc?.status ?? 'unknown';

        return (
          <div key={partition.svcKey} className="card">
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
                  <span>CPU: {formatCpu(svc.cpuUsage)}%</span>
                  {svc.latency != null && Number.isFinite(svc.latency) && <span>Latency: {svc.latency.toFixed(0)}ms</span>}
                </div>
              )}
            </div>
            <div className="grid grid-cols-5 gap-2">
              {partition.chains.map((chain) => (
                <ChainCard key={chain} chain={chain} status={partitionStatus} partitionName={partition.name} />
              ))}
            </div>
          </div>
        );
      })}

      {/* Cross-chain detector and execution engine */}
      <div className="grid grid-cols-2 gap-4">
        {(['cross-chain-detector', 'execution-engine'] satisfies KnownService[]).map((name) => {
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
