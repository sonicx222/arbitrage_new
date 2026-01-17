/**
 * Provider Health Scorer
 *
 * S3.3: Tracks health metrics for RPC providers and enables intelligent
 * fallback selection based on latency, reliability, and data freshness.
 *
 * Features:
 * - Track latency, success rate, and block freshness per provider
 * - Weighted scoring for intelligent provider selection
 * - Rolling windows for metrics to prevent stale data
 * - Singleton pattern for shared access across WebSocket managers
 *
 * @see ADR-003: Partitioned Chain Detectors
 */
/**
 * Health metrics for a single provider
 */
export interface ProviderHealthMetrics {
    /** Provider WebSocket/RPC URL */
    url: string;
    /** Chain identifier */
    chainId: string;
    /** Average latency in ms */
    avgLatencyMs: number;
    /** 95th percentile latency in ms */
    p95LatencyMs: number;
    /** Recent latency samples */
    latencySamples: number[];
    /** Total successful operations */
    successCount: number;
    /** Total failed operations */
    failureCount: number;
    /** Success rate (0-1) */
    successRate: number;
    /** Rate limit events encountered */
    rateLimitCount: number;
    /** Connection drop count */
    connectionDropCount: number;
    /** Timestamp of last successful operation */
    lastSuccessTime: number;
    /** Timestamp of last failure */
    lastFailureTime: number;
    /** Timestamp of last block received */
    lastBlockTime: number;
    /** Last block number seen */
    lastBlockNumber: number;
    /** Estimated blocks behind head */
    blocksBehind: number;
    /** Latency score (lower latency = higher score) */
    latencyScore: number;
    /** Reliability score (higher success rate = higher score) */
    reliabilityScore: number;
    /** Freshness score (more recent blocks = higher score) */
    freshnessScore: number;
    /** Overall weighted score */
    overallScore: number;
}
/**
 * Configuration for the health scorer
 */
export interface ProviderHealthScorerConfig {
    /** Weight for latency in overall score (default: 0.3) */
    latencyWeight?: number;
    /** Weight for reliability in overall score (default: 0.4) */
    reliabilityWeight?: number;
    /** Weight for freshness in overall score (default: 0.3) */
    freshnessWeight?: number;
    /** Maximum acceptable latency in ms (default: 2000) */
    maxAcceptableLatencyMs?: number;
    /** Maximum acceptable block delay in ms (default: 30000) */
    maxAcceptableBlockDelayMs?: number;
    /** Minimum acceptable reliability (default: 0.95 = 95%) */
    minReliabilityPercent?: number;
    /** Number of latency samples to keep (default: 100) */
    latencySampleWindow?: number;
    /** Window for reliability calculation (default: 1000) */
    reliabilityWindow?: number;
    /** How often to decay old metrics in ms (default: 60000) */
    decayIntervalMs?: number;
    /** Decay factor for old counts (default: 0.9) */
    decayFactor?: number;
}
/**
 * Provider Health Scorer - tracks and scores RPC provider health
 */
export declare class ProviderHealthScorer {
    private metrics;
    private config;
    private logger;
    private decayTimer;
    constructor(config?: ProviderHealthScorerConfig);
    /**
     * Get or create metrics for a provider
     */
    private getOrCreateMetrics;
    /**
     * Create empty metrics object
     */
    private createEmptyMetrics;
    /**
     * Make a unique key for provider metrics
     */
    private makeKey;
    /**
     * Record a successful operation with latency
     */
    recordSuccess(url: string, chainId: string, latencyMs: number): void;
    /**
     * Record a failed operation
     */
    recordFailure(url: string, chainId: string, errorType: string): void;
    /**
     * Record a rate limit event
     */
    recordRateLimit(url: string, chainId: string): void;
    /**
     * Record a connection drop
     */
    recordConnectionDrop(url: string, chainId: string): void;
    /**
     * Record a block number received
     */
    recordBlock(url: string, chainId: string, blockNumber: number): void;
    /**
     * Get the best (highest) block number known for a chain
     */
    private getBestBlockForChain;
    /**
     * Update latency statistics from samples
     */
    private updateLatencyStats;
    /**
     * Update all scores for a provider
     */
    private updateScores;
    /**
     * Get health score for a specific provider
     */
    getHealthScore(url: string, chainId: string): number;
    /**
     * Get full metrics for a provider
     */
    getMetrics(url: string, chainId: string): ProviderHealthMetrics | null;
    /**
     * Get all metrics for a chain
     */
    getChainMetrics(chainId: string): ProviderHealthMetrics[];
    /**
     * Select the best provider from a list of candidates
     */
    selectBestProvider(chainId: string, candidates: string[]): string;
    /**
     * Check if a provider meets minimum health requirements
     */
    isProviderHealthy(url: string, chainId: string): boolean;
    /**
     * Get providers sorted by health score (best first)
     */
    getRankedProviders(chainId: string, urls: string[]): string[];
    /**
     * Start periodic decay of old metrics
     */
    private startDecay;
    /**
     * Stop periodic decay
     */
    private stopDecay;
    /**
     * Apply decay to metrics to prevent stale data from dominating
     */
    private decayMetrics;
    /**
     * Clear all metrics (for testing or reset)
     */
    clear(): void;
    /**
     * Shutdown the scorer
     */
    shutdown(): void;
    /**
     * Get summary statistics
     */
    getSummary(): {
        totalProviders: number;
        providersByChain: Record<string, number>;
        avgOverallScore: number;
        unhealthyProviders: number;
    };
}
/**
 * Get the singleton health scorer instance
 */
export declare function getProviderHealthScorer(): ProviderHealthScorer;
/**
 * Reset the singleton instance (for testing)
 */
export declare function resetProviderHealthScorer(): void;
//# sourceMappingURL=provider-health-scorer.d.ts.map