/**
 * Unified Chain Detector
 *
 * Multi-chain detector service that runs multiple blockchain detectors
 * in a single process based on partition configuration.
 *
 * Implements ADR-003 (Partitioned Chain Detectors) by consolidating
 * multiple chain detectors into configurable partitions.
 *
 * Features:
 * - Multi-chain support in single process
 * - Partition-based configuration
 * - Cross-region health reporting
 * - Graceful degradation support
 * - Resource-aware chain management
 *
 * @see ADR-003: Partitioned Chain Detectors
 * @see ADR-007: Cross-Region Failover Strategy
 */
import { EventEmitter } from 'events';
import { ServiceState } from '../../../shared/core/src';
import { PartitionHealth } from '../../../shared/config/src';
import { ChainDetectorInstance } from './chain-instance';
export interface UnifiedDetectorConfig {
    /** Partition ID to run (from env or explicit) */
    partitionId?: string;
    /** Override chains to monitor (comma-separated or array) */
    chains?: string[];
    /** Instance ID for this detector */
    instanceId?: string;
    /** Region ID for cross-region health */
    regionId?: string;
    /** Whether to enable cross-region health manager */
    enableCrossRegionHealth?: boolean;
    /** Health check port for HTTP endpoint */
    healthCheckPort?: number;
}
export interface UnifiedDetectorStats {
    /** Partition being monitored */
    partitionId: string;
    /** Chains being monitored */
    chains: string[];
    /** Total events processed across all chains */
    totalEventsProcessed: number;
    /** Total opportunities found */
    totalOpportunitiesFound: number;
    /** Uptime in seconds */
    uptimeSeconds: number;
    /** Memory usage in MB */
    memoryUsageMB: number;
    /** Per-chain statistics */
    chainStats: Map<string, ChainStats>;
}
export interface ChainStats {
    chainId: string;
    status: 'connected' | 'connecting' | 'disconnected' | 'error';
    eventsProcessed: number;
    opportunitiesFound: number;
    lastBlockNumber: number;
    avgBlockLatencyMs: number;
    pairsMonitored: number;
}
export declare class UnifiedChainDetector extends EventEmitter {
    private logger;
    private perfLogger;
    private stateManager;
    private redis;
    private streamsClient;
    private crossRegionHealth;
    private degradationManager;
    private config;
    private partition;
    private chainInstances;
    private startTime;
    private healthCheckInterval;
    private metricsInterval;
    constructor(config?: UnifiedDetectorConfig);
    start(): Promise<void>;
    stop(): Promise<void>;
    private startChainInstances;
    private static readonly CHAIN_STOP_TIMEOUT_MS;
    private stopChainInstances;
    private handleChainError;
    private initializeCrossRegionHealth;
    private startHealthMonitoring;
    private publishHealth;
    private startMetricsCollection;
    isRunning(): boolean;
    getState(): ServiceState;
    getPartitionId(): string;
    getChains(): string[];
    getChainInstance(chainId: string): ChainDetectorInstance | undefined;
    getStats(): UnifiedDetectorStats;
    getPartitionHealth(): Promise<PartitionHealth>;
}
//# sourceMappingURL=unified-detector.d.ts.map