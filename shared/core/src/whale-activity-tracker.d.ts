/**
 * T3.12: Enhanced Whale Activity Detection
 *
 * Professional-grade whale tracking with:
 * - Wallet tracking over time (activity history)
 * - Pattern analysis (accumulation/distribution)
 * - Follow-the-whale signals (early warning)
 * - Impact prediction (price movement forecast)
 *
 * @see docs/DETECTOR_OPTIMIZATION_ANALYSIS.md - Finding 4.2
 */
/**
 * Configuration for whale activity tracking.
 */
export interface WhaleTrackerConfig {
    /** USD threshold to qualify as a whale trade (default: $50,000) */
    whaleThresholdUsd: number;
    /** Time window for tracking wallet activity (ms, default: 24 hours) */
    activityWindowMs: number;
    /** Minimum trades to establish wallet pattern (default: 3) */
    minTradesForPattern: number;
    /** Maximum wallets to track (LRU eviction, default: 5000) */
    maxTrackedWallets: number;
    /** Maximum transactions per wallet to store (default: 100) */
    maxTransactionsPerWallet: number;
    /** Super whale threshold multiplier (default: 10x = $500K) */
    superWhaleMultiplier: number;
}
/**
 * A single whale transaction record for tracking.
 * Note: This is separate from WhaleTransaction in message-validators.ts
 * which is used for incoming message validation.
 */
export interface TrackedWhaleTransaction {
    transactionHash: string;
    walletAddress: string;
    chain: string;
    dex: string;
    pairAddress: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: number;
    amountOut: number;
    usdValue: number;
    direction: 'buy' | 'sell';
    timestamp: number;
    /** Estimated price impact percentage */
    priceImpact: number;
}
/**
 * Wallet activity profile.
 */
export interface WalletProfile {
    address: string;
    firstSeen: number;
    lastSeen: number;
    totalTransactions: number;
    totalVolumeUsd: number;
    /** Recent transactions (limited by maxTransactionsPerWallet) */
    recentTransactions: TrackedWhaleTransaction[];
    /** Detected pattern based on recent activity */
    pattern: WalletPattern;
    /** Win rate for follow-the-whale analysis */
    historicalAccuracy: number;
    /** Chains this wallet is active on */
    activeChains: Set<string>;
    /** Tokens this wallet frequently trades */
    frequentTokens: Map<string, number>;
}
/**
 * Detected wallet trading pattern.
 */
export type WalletPattern = 'accumulator' | 'distributor' | 'swing_trader' | 'arbitrageur' | 'unknown';
/**
 * Follow-the-whale signal.
 */
export interface WhaleSignal {
    id: string;
    type: 'follow' | 'front_run' | 'fade';
    walletAddress: string;
    chain: string;
    token: string;
    direction: 'buy' | 'sell';
    confidence: number;
    usdValue: number;
    timestamp: number;
    reasoning: string;
    /** Time window the signal is valid (ms) */
    validForMs: number;
}
/**
 * Aggregated whale activity for a token/pair.
 */
export interface WhaleActivitySummary {
    pairKey: string;
    chain: string;
    windowMs: number;
    buyVolumeUsd: number;
    sellVolumeUsd: number;
    netFlowUsd: number;
    whaleCount: number;
    superWhaleCount: number;
    dominantDirection: 'bullish' | 'bearish' | 'neutral';
    avgPriceImpact: number;
}
/**
 * Tracker statistics.
 */
export interface WhaleTrackerStats {
    totalTransactionsTracked: number;
    totalWalletsTracked: number;
    totalSignalsGenerated: number;
    avgSignalConfidence: number;
    walletEvictions: number;
}
/**
 * T3.12: Enhanced Whale Activity Tracker
 *
 * Tracks whale wallets, detects patterns, and generates follow-the-whale signals.
 */
export declare class WhaleActivityTracker {
    private config;
    private wallets;
    private signalHandlers;
    private stats;
    constructor(config?: Partial<WhaleTrackerConfig>);
    /**
     * Record a whale transaction.
     * This is the main entry point for tracking whale activity.
     */
    recordTransaction(transaction: TrackedWhaleTransaction): void;
    /**
     * Get activity summary for a specific token/pair.
     */
    getActivitySummary(pairKey: string, chain: string, windowMs?: number): WhaleActivitySummary;
    /**
     * Get wallet profile by address.
     */
    getWalletProfile(address: string): WalletProfile | undefined;
    /**
     * Get top whales by volume.
     */
    getTopWhales(limit?: number): WalletProfile[];
    /**
     * Get wallets matching a specific pattern.
     */
    getWalletsByPattern(pattern: WalletPattern): WalletProfile[];
    /**
     * Register a handler for whale signals.
     */
    onSignal(handler: (signal: WhaleSignal) => void): () => void;
    /**
     * Get tracker statistics.
     */
    getStats(): WhaleTrackerStats;
    /**
     * Reset all tracking data.
     */
    reset(): void;
    private createWalletProfile;
    private updateWalletProfile;
    private detectPattern;
    private analyzeForSignal;
    private emitSignal;
    private evictLRUWalletsIfNeeded;
}
/**
 * Get the singleton WhaleActivityTracker instance.
 * Configuration is only applied on first call; subsequent calls return the existing instance.
 *
 * @param config - Optional configuration (only used on first initialization)
 * @returns The singleton WhaleActivityTracker instance
 */
export declare function getWhaleActivityTracker(config?: Partial<WhaleTrackerConfig>): WhaleActivityTracker;
/**
 * Reset the singleton instance.
 * Use for testing or when reconfiguration is needed.
 */
export declare function resetWhaleActivityTracker(): void;
//# sourceMappingURL=whale-activity-tracker.d.ts.map