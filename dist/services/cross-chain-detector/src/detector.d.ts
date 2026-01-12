/**
 * Cross-Chain Arbitrage Detector Service
 *
 * Detects arbitrage opportunities across multiple chains by monitoring
 * price discrepancies and accounting for bridge costs.
 *
 * Uses Redis Streams for event consumption (ADR-002 compliant).
 * Uses ServiceStateManager for lifecycle management.
 *
 * Architecture Note: Intentional Exception to BaseDetector Pattern
 * ----------------------------------------------------------------
 * This service does NOT extend BaseDetector for the following reasons:
 *
 * 1. **Consumer vs Producer**: BaseDetector is designed for single-chain
 *    event producers (subscribe to chain -> publish price updates).
 *    CrossChainDetector is an event consumer (consume price updates from
 *    ALL chains -> detect cross-chain opportunities).
 *
 * 2. **No WebSocket Connection**: BaseDetector manages WebSocket connections
 *    to blockchain nodes. CrossChainDetector has no direct blockchain
 *    connection - it consumes from Redis Streams.
 *
 * 3. **Different Lifecycle**: BaseDetector's lifecycle is tied to chain
 *    availability. CrossChainDetector's lifecycle is tied to Redis Streams.
 *
 * 4. **Multi-Chain by Design**: BaseDetector = 1 chain per instance.
 *    CrossChainDetector = aggregates ALL chains in one instance.
 *
 * This exception is documented in ADR-003.
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see ADR-003: Partitioned Chain Detectors (documents this exception)
 * @see ADR-007: Failover Strategy
 */
import { ServiceState } from '../../../shared/core/src';
export declare class CrossChainDetectorService {
    private redis;
    private streamsClient;
    private priceOracle;
    private logger;
    private perfLogger;
    private stateManager;
    private priceData;
    private opportunitiesCache;
    private bridgePredictor;
    private mlPredictor;
    private readonly consumerGroups;
    private readonly instanceId;
    private opportunityDetectionInterval;
    private healthMonitoringInterval;
    private streamConsumerInterval;
    private cacheCleanupInterval;
    private priceUpdateCounter;
    private readonly CLEANUP_FREQUENCY;
    constructor();
    start(): Promise<void>;
    private static readonly SHUTDOWN_TIMEOUT_MS;
    stop(): Promise<void>;
    private clearAllIntervals;
    private createConsumerGroups;
    private startStreamConsumers;
    private consumePriceUpdatesStream;
    private consumeWhaleAlertsStream;
    private handlePriceUpdate;
    private handleWhaleTransaction;
    /**
     * Validate PriceUpdate message has all required fields
     */
    private validatePriceUpdate;
    /**
     * Validate WhaleTransaction message has all required fields
     */
    private validateWhaleTransaction;
    /**
     * P0-NEW-7 FIX: Clean old price data using snapshot-based iteration
     * Prevents race conditions where priceData is modified during cleanup
     */
    private cleanOldPriceData;
    /**
     * Clean old entries from opportunity cache to prevent memory leak (P0 fix)
     * Keeps cache bounded to prevent unbounded growth
     * P1-NEW-3 FIX: Uses createdAt field instead of parsing from ID
     */
    private cleanOldOpportunityCache;
    /**
     * Create atomic snapshot of priceData for thread-safe detection (P1 fix)
     * Prevents race conditions where priceData is modified during detection
     */
    private createPriceDataSnapshot;
    private initializeMLPredictor;
    private startOpportunityDetection;
    private detectCrossChainOpportunities;
    private getAllTokenPairsFromSnapshot;
    private getPricesForTokenPairFromSnapshot;
    private findArbitrageInPair;
    private extractTokenFromPair;
    private estimateBridgeCost;
    /**
     * P1-5 FIX: Use centralized bridge cost configuration instead of hardcoded multipliers.
     * This provides more accurate cost estimates based on actual bridge fees.
     */
    private fallbackBridgeCost;
    /**
     * P0-4 FIX: Extract token amount for bridge cost estimation
     *
     * Previous implementation was WRONG:
     *   return price > 0 ? 1.0 / price : 1.0  // Returns inverse of price, NOT token amount!
     *
     * This caused bridge cost calculations to be off by ±500% because:
     *   - If ETH price = $3000, it would return 0.000333 tokens
     *   - If ETH price = $0.01, it would return 100 tokens
     *
     * Correct implementation: Return a reasonable default trade size in token terms.
     * For cross-chain arbitrage, we typically trade a fixed USD amount (e.g., $1000)
     * and calculate how many tokens that represents.
     */
    private extractTokenAmount;
    updateBridgeData(bridgeResult: {
        sourceChain: string;
        targetChain: string;
        bridge: string;
        token: string;
        amount: number;
        actualLatency: number;
        actualCost: number;
        success: boolean;
        timestamp: number;
    }): void;
    private calculateConfidence;
    private filterValidOpportunities;
    private analyzeWhaleImpact;
    private publishArbitrageOpportunity;
    private startHealthMonitoring;
    isRunning(): boolean;
    getState(): ServiceState;
    getChainsMonitored(): string[];
    getOpportunitiesCount(): number;
}
//# sourceMappingURL=detector.d.ts.map