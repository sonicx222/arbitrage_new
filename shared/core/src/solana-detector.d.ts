/**
 * S3.3.1 Solana Detector Base Infrastructure
 *
 * Base class for Solana blockchain detection that provides:
 * - @solana/web3.js integration (different from ethers.js for EVM)
 * - Program account subscriptions (not event logs)
 * - Connection pooling for RPC rate limits
 * - Solana-specific price feed handling
 * - Arbitrage detection between Solana DEXs
 *
 * Key Differences from EVM BaseDetector:
 * - Uses Connection instead of JsonRpcProvider
 * - Uses accountSubscribe/programSubscribe instead of eth_subscribe
 * - Program IDs instead of contract addresses
 * - Instruction parsing instead of event log decoding
 * - Slot instead of block number
 *
 * @see IMPLEMENTATION_PLAN.md S3.3.1
 * @see ADR-003: Partitioned Chain Detectors
 */
import { EventEmitter } from 'events';
import { Connection, Commitment, AccountInfo, Context } from '@solana/web3.js';
import { PerformanceLogger } from './logger';
import { RedisClient } from './redis';
import { RedisStreamsClient, StreamBatcher } from './redis-streams';
import { PriceUpdate, ArbitrageOpportunity, MessageEvent } from '../../types';
/**
 * Logger interface for SolanaDetector.
 * Allows injecting mock loggers for testing.
 */
export interface SolanaDetectorLogger {
    info: (message: string, meta?: object) => void;
    warn: (message: string, meta?: object) => void;
    error: (message: string, meta?: object) => void;
    debug: (message: string, meta?: object) => void;
}
/**
 * Performance logger interface for SolanaDetector.
 * Minimal interface for testing dependency injection.
 */
export interface SolanaDetectorPerfLogger {
    logHealthCheck: (service: string, status: any) => void;
    logEventLatency?: (operation: string, latency: number, metadata?: any) => void;
    logArbitrageOpportunity?: (opportunity: any) => void;
}
/**
 * Redis client interface for dependency injection.
 * Matches the subset of RedisClient methods used by SolanaDetector.
 */
export interface SolanaDetectorRedisClient {
    ping(): Promise<string>;
    disconnect(): Promise<void>;
    updateServiceHealth?(serviceName: string, status: any): Promise<void>;
}
/**
 * Redis streams client interface for dependency injection.
 * Matches the subset of RedisStreamsClient methods used by SolanaDetector.
 */
export interface SolanaDetectorStreamsClient {
    disconnect(): Promise<void>;
    createBatcher(streamName: string, config: any): {
        add(message: any): void;
        destroy(): Promise<void>;
        getStats(): {
            currentQueueSize: number;
            batchesSent: number;
        };
    };
}
/**
 * Dependencies that can be injected into SolanaDetector.
 * Enables proper testing without Jest mock hoisting issues.
 */
export interface SolanaDetectorDeps {
    logger?: SolanaDetectorLogger;
    perfLogger?: SolanaDetectorPerfLogger | PerformanceLogger;
    /** Optional Redis client for dependency injection (used in tests) */
    redisClient?: SolanaDetectorRedisClient;
    /** Optional Redis streams client for dependency injection (used in tests) */
    streamsClient?: SolanaDetectorStreamsClient;
}
/**
 * Configuration for SolanaDetector.
 */
export interface SolanaDetectorConfig {
    /** Solana RPC endpoint URL */
    rpcUrl: string;
    /** Solana WebSocket endpoint URL (optional, derived from rpcUrl if not provided) */
    wsUrl?: string;
    /** Commitment level for transactions (default: 'confirmed') */
    commitment?: Commitment;
    /** Fallback RPC URLs for resilience */
    rpcFallbackUrls?: string[];
    /** Fallback WebSocket URLs for resilience */
    wsFallbackUrls?: string[];
    /** Health check interval in milliseconds (default: 30000) */
    healthCheckIntervalMs?: number;
    /** Number of connections in the pool (default: 3) */
    connectionPoolSize?: number;
    /** Maximum retry attempts for failed operations (default: 3) */
    maxRetries?: number;
    /** Delay between retries in milliseconds (default: 1000) */
    retryDelayMs?: number;
    /** Minimum profit threshold for arbitrage in percent (default: 0.3) */
    minProfitThreshold?: number;
}
/**
 * Connection pool configuration.
 */
export interface ConnectionPoolConfig {
    size: number;
    connections: Connection[];
    currentIndex: number;
    healthStatus: boolean[];
    latencies: number[];
    failedRequests: number[];
    /** Track which connection index each subscription was created on */
    subscriptionConnections: Map<string, number>;
    /** Mutex flags for reconnection attempts (prevents concurrent reconnects) */
    reconnecting: boolean[];
    /** Track reconnection attempts for exponential backoff */
    reconnectAttempts: number[];
}
/**
 * Program subscription tracking.
 */
export interface ProgramSubscription {
    programId: string;
    subscriptionId: number;
    callback?: (accountInfo: AccountInfo<Buffer>, context: Context, accountId: string) => void;
}
/**
 * Solana token information in a pool.
 */
export interface SolanaTokenInfo {
    mint: string;
    symbol: string;
    decimals: number;
}
/**
 * Solana DEX pool information.
 */
export interface SolanaPool {
    address: string;
    programId: string;
    dex: string;
    token0: SolanaTokenInfo;
    token1: SolanaTokenInfo;
    fee: number;
    reserve0?: string;
    reserve1?: string;
    price?: number;
    lastSlot?: number;
    sqrtPriceX64?: string;
    liquidity?: string;
    tickCurrentIndex?: number;
}
/**
 * Solana-specific price update.
 */
export interface SolanaPriceUpdate {
    poolAddress: string;
    dex: string;
    token0: string;
    token1: string;
    price: number;
    reserve0: string;
    reserve1: string;
    slot: number;
    timestamp: number;
    sqrtPriceX64?: string;
    liquidity?: string;
    tickCurrentIndex?: number;
}
/**
 * Connection metrics for monitoring.
 */
export interface ConnectionMetrics {
    totalConnections: number;
    healthyConnections: number;
    failedRequests: number;
    avgLatencyMs: number;
}
/**
 * Health status for the detector.
 */
export interface SolanaDetectorHealth {
    service: string;
    status: 'healthy' | 'degraded' | 'unhealthy';
    uptime: number;
    memoryUsage: number;
    lastHeartbeat: number;
    connections: ConnectionMetrics;
    subscriptions: number;
    pools: number;
    slot: number;
}
export declare const SOLANA_DEX_PROGRAMS: {
    readonly JUPITER: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
    readonly RAYDIUM_AMM: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
    readonly RAYDIUM_CLMM: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
    readonly ORCA_WHIRLPOOL: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
    readonly METEORA_DLMM: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
    readonly PHOENIX: "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY";
    readonly LIFINITY: "2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c";
};
/**
 * Base class for Solana blockchain detection.
 * Provides connection pooling, program subscriptions, and arbitrage detection.
 */
export declare class SolanaDetector extends EventEmitter {
    protected config: Required<SolanaDetectorConfig>;
    protected logger: SolanaDetectorLogger;
    protected perfLogger: SolanaDetectorPerfLogger;
    protected connectionPool: ConnectionPoolConfig;
    protected currentRpcUrl: string;
    protected allRpcUrls: string[];
    protected redis: RedisClient | null;
    protected streamsClient: RedisStreamsClient | null;
    protected priceUpdateBatcher: StreamBatcher<MessageEvent> | null;
    protected injectedRedisClient?: SolanaDetectorRedisClient;
    protected injectedStreamsClient?: SolanaDetectorStreamsClient;
    protected subscriptions: Map<string, ProgramSubscription>;
    protected pools: Map<string, SolanaPool>;
    protected poolsByDex: Map<string, Set<string>>;
    protected poolsByTokenPair: Map<string, Set<string>>;
    protected running: boolean;
    protected stopping: boolean;
    protected startTime: number;
    protected currentSlot: number;
    protected healthCheckInterval: NodeJS.Timeout | null;
    private startPromise;
    private stopPromise;
    protected recentLatencies: number[];
    protected static readonly MAX_LATENCY_SAMPLES = 100;
    protected static readonly MAX_LATENCY_VALUE_MS = 30000;
    protected static readonly SLOT_UPDATE_TIMEOUT_MS = 10000;
    private slotUpdateMutex;
    private poolUpdateMutex;
    constructor(config: SolanaDetectorConfig, deps?: SolanaDetectorDeps);
    getChain(): string;
    isEVM(): boolean;
    getRpcUrl(): string;
    getWsUrl(): string;
    getCommitment(): Commitment;
    getFallbackUrls(): {
        rpc: string[];
        ws: string[];
    };
    getCurrentRpcUrl(): string;
    start(): Promise<void>;
    private performStart;
    stop(): Promise<void>;
    private performStop;
    isRunning(): boolean;
    private cleanup;
    private initializeRedis;
    private initializeConnectionPool;
    getConnectionPoolSize(): number;
    getActiveConnections(): number;
    getHealthyConnectionCount(): number;
    /**
     * Get a connection from the pool using round-robin.
     * Prefers healthy connections when available.
     * Returns the connection and the actual index used.
     */
    getConnection(): Connection;
    /**
     * Get a connection from the pool along with its index.
     * This is critical for subscription tracking - subscriptions must be
     * unsubscribed from the same connection that created them.
     * @internal
     */
    protected getConnectionWithIndex(): {
        connection: Connection;
        index: number;
    };
    /**
     * Get a connection by index (for subscription tracking).
     * @internal
     */
    private getConnectionByIndex;
    /**
     * Get the current connection index (for subscription tracking).
     * @internal
     */
    private getCurrentConnectionIndex;
    /**
     * Mark a connection as failed.
     */
    markConnectionFailed(index: number): Promise<void>;
    private attemptReconnection;
    getConnectionMetrics(): ConnectionMetrics;
    subscribeToProgramAccounts(programId: string): Promise<void>;
    unsubscribeFromProgram(programId: string): Promise<void>;
    isSubscribedToProgram(programId: string): boolean;
    getSubscriptionCount(): number;
    private handleProgramAccountUpdate;
    /**
     * Simulate an account update (for testing).
     */
    simulateAccountUpdate(programId: string, data: any): void;
    addPool(pool: SolanaPool): void;
    removePool(address: string): void;
    getPool(address: string): SolanaPool | undefined;
    getPoolCount(): number;
    getPoolsByDex(dex: string): SolanaPool[];
    getPoolsByTokenPair(token0: string, token1: string): SolanaPool[];
    updatePoolPrice(poolAddress: string, update: {
        price: number;
        reserve0: string;
        reserve1: string;
        slot: number;
    }): Promise<void>;
    private getTokenPairKey;
    publishPriceUpdate(update: SolanaPriceUpdate): Promise<void>;
    /**
     * Convert Solana-specific price update to standard format.
     */
    toStandardPriceUpdate(update: SolanaPriceUpdate): PriceUpdate;
    getPendingUpdates(): number;
    getBatcherStats(): {
        pending: number;
        flushed: number;
    };
    checkArbitrage(): Promise<ArbitrageOpportunity[]>;
    private calculateArbitrageOpportunity;
    getHealth(): Promise<SolanaDetectorHealth>;
    private startHealthMonitoring;
    private updateCurrentSlot;
    handleRpcError(error: Error): Promise<void>;
    handleRpcFailure(failedUrl: string): Promise<void>;
    withRetry<T>(operation: () => Promise<T>): Promise<T>;
    emitError(error: Error): void;
    private deriveWsUrl;
    private isValidSolanaAddress;
    private sleep;
}
export default SolanaDetector;
//# sourceMappingURL=solana-detector.d.ts.map