/**
 * PartitionedDetector Base Class
 *
 * Base class for partition-specific detectors that manage multiple chains.
 * Implements ADR-003 (Partitioned Chain Detectors) for efficient multi-chain
 * monitoring within free-tier resource limits.
 *
 * Features:
 * - Multi-chain WebSocket connection management
 * - Aggregated health reporting across chains
 * - Cross-chain price tracking for arbitrage detection
 * - Graceful degradation when individual chains fail
 * - Dynamic chain addition/removal at runtime
 *
 * Design Goals:
 * - Enable 15+ chains within free tier limits
 * - Isolate failures to individual chains
 * - Provide unified health reporting per partition
 *
 * @see ADR-003: Partitioned Chain Detectors
 * @see S3.1.1: Create PartitionedDetector base class
 */
import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { createLogger, PerformanceLogger } from './logger';
import { RedisClient } from './redis';
import { RedisStreamsClient } from './redis-streams';
import { WebSocketManager, WebSocketMessage } from './websocket-manager';
import { CHAINS } from '../../config/src';
export interface PartitionedDetectorConfig {
    /** Unique partition identifier */
    partitionId: string;
    /** Array of chain IDs to monitor (accepts readonly arrays from PartitionConfig) */
    chains: readonly string[] | string[];
    /** Deployment region */
    region: string;
    /** Health check interval in ms (default: 15000) */
    healthCheckIntervalMs?: number;
    /** Failover timeout in ms (default: 60000) */
    failoverTimeoutMs?: number;
    /** Maximum reconnect attempts per chain (default: 5) */
    maxReconnectAttempts?: number;
}
/** Internal config type with mutable chains array for runtime modifications */
interface InternalDetectorConfig extends Omit<Required<PartitionedDetectorConfig>, 'chains'> {
    chains: string[];
}
export interface ChainHealth {
    chainId: string;
    status: 'healthy' | 'degraded' | 'unhealthy';
    wsConnected: boolean;
    blocksBehind: number;
    lastBlockTime: number;
    eventsPerSecond: number;
    errorCount: number;
}
export interface PartitionHealth {
    partitionId: string;
    status: 'healthy' | 'degraded' | 'unhealthy';
    chainHealth: Map<string, ChainHealth>;
    totalEventsProcessed: number;
    avgEventLatencyMs: number;
    memoryUsage: number;
    cpuUsage: number;
    uptimeSeconds: number;
    lastHealthCheck: number;
    activeOpportunities: number;
}
export interface ChainStats {
    eventsProcessed: number;
    lastBlockNumber: number;
    lastBlockTimestamp: number;
}
export interface PricePoint {
    price: number;
    timestamp: number;
}
export interface CrossChainDiscrepancy {
    pairKey: string;
    chains: string[];
    prices: Map<string, number>;
    maxDifference: number;
    timestamp: number;
}
interface EthereumLog {
    address: string;
    data: string;
    topics: string[];
    blockNumber: string;
    transactionHash?: string;
}
interface EthereumBlockHeader {
    number: string;
    timestamp?: string;
    hash?: string;
}
export declare class PartitionedDetector extends EventEmitter {
    protected config: InternalDetectorConfig;
    protected logger: ReturnType<typeof createLogger>;
    protected perfLogger: PerformanceLogger;
    protected redis: RedisClient | null;
    protected streamsClient: RedisStreamsClient | null;
    protected chainManagers: Map<string, WebSocketManager>;
    protected chainProviders: Map<string, ethers.JsonRpcProvider>;
    protected chainHealth: Map<string, ChainHealth>;
    protected chainStats: Map<string, ChainStats>;
    protected chainConfigs: Map<string, typeof CHAINS[keyof typeof CHAINS]>;
    protected chainPrices: Map<string, Map<string, PricePoint>>;
    private static readonly MAX_LATENCY_SAMPLES;
    protected eventLatencies: number[];
    protected healthMonitoringInterval: NodeJS.Timeout | null;
    protected startTime: number;
    private running;
    private stopping;
    private startPromise;
    private stopPromise;
    constructor(config: PartitionedDetectorConfig);
    start(): Promise<void>;
    private performStart;
    stop(): Promise<void>;
    private performStop;
    private cleanup;
    private initializeRedis;
    private initializeChainConnections;
    private connectChain;
    private disconnectChain;
    private setupChainEventHandlers;
    addChain(chainId: string): Promise<void>;
    removeChain(chainId: string): Promise<void>;
    private initializeChainHealth;
    private updateChainHealth;
    private startHealthMonitoring;
    getPartitionHealth(): PartitionHealth;
    getHealthyChains(): string[];
    /**
     * P6-FIX: Record event latency with bounded array to prevent memory leak.
     * Keeps only the most recent MAX_LATENCY_SAMPLES entries.
     * Subclasses should use this method to record latencies safely.
     */
    protected recordEventLatency(latencyMs: number): void;
    protected handleChainMessage(chainId: string, message: WebSocketMessage): void;
    protected handleLogEvent(chainId: string, log: EthereumLog): void;
    protected handleSyncEvent(chainId: string, log: EthereumLog): void;
    protected handleSwapEvent(chainId: string, log: EthereumLog): void;
    protected handleNewBlock(chainId: string, block: EthereumBlockHeader): void;
    updatePrice(chainId: string, pairKey: string, price: number): void;
    getCrossChainPrices(pairKey: string): Map<string, PricePoint>;
    findCrossChainDiscrepancies(minDifferencePercent: number): CrossChainDiscrepancy[];
    isRunning(): boolean;
    getPartitionId(): string;
    getChains(): string[];
    getRegion(): string;
    getChainManagers(): Map<string, WebSocketManager>;
    getChainHealth(chainId: string): ChainHealth | undefined;
}
export default PartitionedDetector;
//# sourceMappingURL=partitioned-detector.d.ts.map