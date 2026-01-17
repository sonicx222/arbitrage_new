export interface WebSocketConfig {
    url: string;
    /** Fallback URLs to try if primary URL fails */
    fallbackUrls?: string[];
    /** Base reconnect interval in ms (default: 1000) */
    reconnectInterval?: number;
    maxReconnectAttempts?: number;
    heartbeatInterval?: number;
    connectionTimeout?: number;
    /** Alias for heartbeatInterval for compatibility */
    pingInterval?: number;
    /** Chain ID for health tracking (optional) */
    chainId?: string;
    /** Multiplier for exponential backoff (default: 2.0) */
    backoffMultiplier?: number;
    /** Maximum reconnect delay in ms (default: 60000) */
    maxReconnectDelay?: number;
    /** Jitter percentage to add randomness (default: 0.25 = 25%) */
    jitterPercent?: number;
    /**
     * T1.5: Staleness threshold in ms before rotating to fallback provider.
     * If not specified, uses chain-based defaults:
     * - Fast chains (arbitrum, solana): 5000ms
     * - Medium chains (polygon, bsc, optimism, base, avalanche, fantom): 10000ms
     * - Slow chains (ethereum, zksync, linea): 15000ms
     */
    stalenessThresholdMs?: number;
}
export interface WebSocketSubscription {
    id: number;
    method: string;
    params: any[];
    type?: string;
    topics?: string[];
    callback?: (data: any) => void;
}
export interface WebSocketMessage {
    jsonrpc?: string;
    id?: number;
    method?: string;
    params?: any;
    result?: any;
    error?: any;
}
export type WebSocketEventHandler = (data: WebSocketMessage) => void;
export type ConnectionStateHandler = (connected: boolean) => void;
export type ErrorEventHandler = (error: Error) => void;
export type GenericEventHandler = (...args: any[]) => void;
export declare class WebSocketManager {
    private ws;
    private config;
    private logger;
    private reconnectTimer;
    private heartbeatTimer;
    private connectionTimeoutTimer;
    private reconnectAttempts;
    private isConnecting;
    private isConnected;
    private isReconnecting;
    private isDisconnected;
    private connectMutex;
    private subscriptions;
    private messageHandlers;
    private connectionHandlers;
    private errorHandlers;
    private eventHandlers;
    private nextSubscriptionId;
    /** All available URLs (primary + fallbacks) */
    private allUrls;
    /** Current URL index being used */
    private currentUrlIndex;
    /** Chain ID for health tracking */
    private chainId;
    /**
     * S3.3: Rate limit exclusion tracking
     * Maps URL to exclusion info { until: timestamp, count: consecutive rate limits }
     */
    private excludedProviders;
    /**
     * S3.3: Connection quality metrics for proactive health monitoring
     */
    private qualityMetrics;
    /** Proactive health check interval timer */
    private healthCheckTimer;
    /**
     * T1.5: Staleness threshold in ms - now chain-specific.
     * Previous: Fixed 30 seconds for all chains.
     * New: 5s (fast chains) / 10s (medium) / 15s (slow) based on block times.
     */
    private stalenessThresholdMs;
    /** S3.3: Provider health scorer for intelligent fallback selection */
    private healthScorer;
    /** S3.3: Whether to use intelligent fallback selection (default true) */
    private useIntelligentFallback;
    constructor(config: WebSocketConfig);
    /**
     * Get the current active WebSocket URL
     */
    getCurrentUrl(): string;
    /**
     * S3.3: Select the best available fallback URL using health scoring.
     * Falls back to round-robin if all candidates have similar scores.
     *
     * @returns The best available URL or null if all are excluded
     */
    private selectBestFallbackUrl;
    /**
     * Switch to the next fallback URL, using intelligent selection (S3.3).
     * Returns true if there's another URL to try, false if we've exhausted all options.
     */
    private switchToNextUrl;
    /**
     * S3.3: Enable or disable intelligent fallback selection.
     *
     * @param enabled - Whether to use health scoring for fallback selection
     */
    setIntelligentFallback(enabled: boolean): void;
    connect(): Promise<void>;
    disconnect(): void;
    subscribe(subscription: Omit<WebSocketSubscription, 'id'>): number;
    unsubscribe(subscriptionId: number): void;
    send(message: WebSocketMessage): void;
    onMessage(handler: WebSocketEventHandler): () => void;
    onConnectionChange(handler: ConnectionStateHandler): () => void;
    /**
     * Event emitter-style API for subscribing to WebSocket events.
     * Supports: 'message', 'error', 'connected', 'disconnected'
     */
    on(event: string, handler: GenericEventHandler): () => void;
    /**
     * Emit an event to all registered handlers.
     */
    private emit;
    isWebSocketConnected(): boolean;
    getConnectionStats(): any;
    /**
     * P0-2 fix: Public method to clear all handlers.
     * Call this before stopping to prevent memory leaks from stale handlers.
     */
    removeAllListeners(): void;
    private handleMessage;
    private sendSubscription;
    private resubscribe;
    /**
     * S3.3: Resubscribe with validation - confirms each subscription was accepted.
     * Emits 'subscriptionRecoveryPartial' event if some subscriptions fail.
     *
     * @param timeoutMs - Timeout for each subscription confirmation (default 5000ms)
     * P0-2 FIX (2026-01-16): Added mutex protection to prevent concurrent resubscriptions.
     * Without mutex, concurrent calls could cause duplicate subscriptions and ID collisions
     * in the pendingConfirmations map, leading to orphaned timeout handlers.
     */
    resubscribeWithValidation(timeoutMs?: number): Promise<{
        success: number;
        failed: number;
    }>;
    /**
     * S3.3: Send a subscription and wait for confirmation with timeout.
     *
     * @param subscription - The subscription to send
     * @param timeoutMs - Timeout in milliseconds
     */
    private sendSubscriptionWithTimeout;
    /** S3.3: Pending subscription confirmations */
    private pendingConfirmations;
    /**
     * P0-2 FIX: Mutex for resubscribeWithValidation to prevent concurrent executions.
     * Multiple concurrent calls could cause duplicate subscriptions and ID collisions.
     */
    private resubscribeMutex;
    /**
     * S3.3: Detect data gaps after reconnection.
     * Compares last known block to current block and emits 'dataGap' event if blocks were missed.
     *
     * @returns Information about any detected gap, or null if no gap
     */
    detectDataGaps(): Promise<{
        fromBlock: number;
        toBlock: number;
        missedBlocks: number;
    } | null>;
    /**
     * S3.3: Check for data gaps by comparing received block to last known block.
     * Called internally when processing block notifications.
     *
     * @param newBlockNumber - The new block number received
     */
    private checkForDataGap;
    /**
     * Calculate reconnection delay using exponential backoff with jitter.
     * Formula: min(baseDelay * (multiplier ^ attempt), maxDelay) + random jitter
     *
     * This prevents thundering herd problems where all clients reconnect simultaneously.
     *
     * @param attempt - Current reconnection attempt number (0-based)
     * @returns Delay in milliseconds before next reconnection attempt
     */
    calculateReconnectDelay(attempt: number): number;
    /**
     * S3.3: Check if an error indicates rate limiting by the RPC provider.
     * Detects common rate limit patterns from various providers.
     *
     * @param error - The error to check
     * @returns true if the error indicates rate limiting
     */
    isRateLimitError(error: any): boolean;
    /**
     * S3.3: Check if a provider URL is currently excluded due to rate limiting.
     *
     * @param url - The provider URL to check
     * @returns true if the provider is excluded and should not be used
     */
    isProviderExcluded(url: string): boolean;
    /**
     * S3.3: Handle rate limit detection by excluding the provider temporarily.
     * Uses exponential backoff for exclusion duration (30s, 60s, 120s, 240s, max 5min).
     *
     * @param url - The provider URL that rate limited us
     */
    handleRateLimit(url: string): void;
    /**
     * S3.3: Get the count of currently available (non-excluded) providers.
     *
     * @returns Number of providers available for connection
     */
    getAvailableProviderCount(): number;
    /**
     * S3.3: Get all excluded providers for diagnostics.
     *
     * @returns Map of excluded URLs with their exclusion info
     */
    getExcludedProviders(): Map<string, {
        until: number;
        count: number;
    }>;
    /**
     * S3.3: Clear all provider exclusions (useful for recovery/reset).
     */
    clearProviderExclusions(): void;
    /**
     * S3.3: Get connection quality metrics for health monitoring.
     *
     * @returns Current quality metrics snapshot
     */
    getQualityMetrics(): {
        lastMessageTime: number;
        messageGapMs: number;
        lastBlockNumber: number;
        reconnectCount: number;
        uptime: number;
        messagesReceived: number;
        errorsEncountered: number;
        isStale: boolean;
    };
    /**
     * S3.3: Check if the connection appears stale (no messages for too long).
     *
     * @returns true if connection is stale and should be rotated
     */
    isConnectionStale(): boolean;
    /**
     * S3.3: Set the staleness threshold for proactive rotation.
     *
     * @param thresholdMs - Time in ms with no messages before considering stale
     */
    setStalenessThreshold(thresholdMs: number): void;
    /**
     * S3.3: Start proactive health monitoring.
     * Periodically checks connection quality and triggers rotation if stale.
     *
     * @param intervalMs - Check interval in ms (default 10000)
     */
    startProactiveHealthCheck(intervalMs?: number): void;
    /**
     * S3.3: Stop proactive health monitoring.
     */
    stopProactiveHealthCheck(): void;
    /**
     * S3.3: Record a block number (can be called externally for more accurate tracking).
     *
     * @param blockNumber - The block number received
     */
    recordBlockNumber(blockNumber: number): void;
    private scheduleReconnection;
    private startHeartbeat;
    private stopHeartbeat;
    private clearConnectionTimeout;
    private clearReconnectionTimer;
}
//# sourceMappingURL=websocket-manager.d.ts.map