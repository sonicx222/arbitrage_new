/**
 * Arbitrage Execution Engine with MEV Protection
 *
 * Executes arbitrage opportunities detected by the system.
 * Uses distributed locking to prevent duplicate executions.
 *
 * Fixes applied:
 * - Redis Streams for event consumption (ADR-002 compliant)
 * - DistributedLockManager for atomic execution locking
 * - ServiceStateManager for lifecycle management
 * - Queue size limits with backpressure
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see ADR-007: Failover Strategy
 */
import { ServiceState } from '@arbitrage/core';
interface QueueConfig {
    maxSize: number;
    highWaterMark: number;
    lowWaterMark: number;
}
interface ExecutionStats {
    opportunitiesReceived: number;
    opportunitiesExecuted: number;
    opportunitiesRejected: number;
    successfulExecutions: number;
    failedExecutions: number;
    queueRejects: number;
    lockConflicts: number;
    executionTimeouts: number;
    messageProcessingErrors: number;
    providerReconnections: number;
    providerHealthCheckFailures: number;
}
interface ProviderHealth {
    healthy: boolean;
    lastCheck: number;
    consecutiveFailures: number;
    lastError?: string;
}
export declare class ExecutionEngineService {
    private redis;
    private streamsClient;
    private lockManager;
    private nonceManager;
    private logger;
    private perfLogger;
    private stateManager;
    private wallets;
    private providers;
    private providerHealth;
    private gasBaselines;
    private executionQueue;
    private activeExecutions;
    private readonly consumerGroups;
    private readonly instanceId;
    private readonly queueConfig;
    private queuePaused;
    private stats;
    private pendingMessages;
    private executionProcessingInterval;
    private healthMonitoringInterval;
    private streamConsumerInterval;
    private providerHealthCheckInterval;
    constructor(queueConfig?: Partial<QueueConfig>);
    start(): Promise<void>;
    private static readonly SHUTDOWN_TIMEOUT_MS;
    stop(): Promise<void>;
    private clearAllIntervals;
    /**
     * P1-2 FIX: Initialize providers with health tracking
     */
    private initializeProviders;
    /**
     * P1-2 FIX: Validate provider connectivity before starting
     * Ensures RPC endpoints are actually reachable
     */
    private validateProviderConnectivity;
    /**
     * P1-3 FIX: Start periodic provider health checks for reconnection
     * P1-NEW-5 FIX: Added state check inside loop to abort early if stopping
     */
    private startProviderHealthChecks;
    /**
     * P1-3 FIX: Check provider health and attempt reconnection if needed
     */
    private checkAndReconnectProvider;
    /**
     * P1-3 FIX: Attempt to reconnect a failed provider
     */
    private attemptProviderReconnection;
    private initializeWallets;
    private createConsumerGroups;
    private startStreamConsumers;
    /**
     * P0-1 FIX: Deferred ACK - messages are ACKed only after successful execution
     * P0-12 FIX: Exception handling - wrap individual message handling in try/catch
     */
    private consumeOpportunitiesStream;
    /**
     * P0-1 FIX: ACK message after successful execution
     */
    private ackMessageAfterExecution;
    /**
     * P0-12 FIX: Move failed messages to Dead Letter Queue
     */
    private moveToDeadLetterQueue;
    private handleArbitrageOpportunity;
    /**
     * P1-2 fix: Consolidated backpressure logic to prevent race conditions.
     * This is the ONLY method that modifies queuePaused state.
     * Returns whether new items can be enqueued.
     */
    private updateAndCheckBackpressure;
    private canEnqueue;
    private updateQueueStatus;
    private validateOpportunity;
    private startExecutionProcessing;
    /**
     * Execute opportunity with distributed lock to prevent duplicate executions.
     * This fixes the TOCTOU race condition.
     *
     * P0-2 FIX: Lock TTL now matches execution timeout
     * P0-3 FIX: Execution is wrapped with timeout to prevent indefinite hangs
     */
    private executeOpportunityWithLock;
    /**
     * P0-3 FIX: Execute with timeout to prevent indefinite hangs
     */
    private executeWithTimeout;
    private executeOpportunity;
    private executeIntraChainArbitrage;
    /**
     * P0-3 FIX: Wrap blockchain operations with timeout
     */
    private withTransactionTimeout;
    private executeCrossChainArbitrage;
    /**
     * CRITICAL-2 FIX: Prepare flash loan transaction with proper slippage protection.
     * Includes minAmountOut calculation to prevent partial fills from causing losses.
     */
    private prepareFlashLoanTransaction;
    private buildSwapPath;
    private getFlashLoanContract;
    /**
     * HIGH-3 FIX: Verify opportunity prices are still valid before execution.
     *
     * This prevents executing stale opportunities where prices have moved
     * between detection and execution. Critical for fast chains where
     * block times are < 1 second.
     *
     * @param opportunity - The opportunity to verify
     * @param chain - Target chain
     * @returns Verification result with validity and reason
     */
    private verifyOpportunityPrices;
    /**
     * CRITICAL-1 FIX: Apply MEV protection to prevent sandwich attacks.
     *
     * Strategies applied:
     * 1. Use private transaction pools (Flashbots on supported chains)
     * 2. Set strict maxPriorityFeePerGas to avoid overpaying
     * 3. Use EIP-1559 transactions where supported for predictable fees
     * 4. Add deadline parameter to prevent stale transactions
     *
     * @param tx - Transaction to protect
     * @param chain - Target chain
     * @returns Protected transaction request
     */
    private applyMEVProtection;
    /**
     * P1-5 FIX: Get optimal gas price with spike protection.
     * Tracks baseline gas prices and rejects if current price exceeds threshold.
     * @throws Error if gas price spike detected and protection is enabled
     */
    private getOptimalGasPrice;
    /**
     * P1-5 FIX: Update gas price baseline for spike detection
     */
    private updateGasBaseline;
    /**
     * P1-5 FIX: Calculate baseline gas price from recent history
     * Uses median to avoid outlier influence
     *
     * HIGH-2 FIX: When not enough history exists, use the average of available
     * samples multiplied by a safety factor, rather than returning 0n which
     * disables spike protection entirely during the warmup period.
     */
    private getGasBaseline;
    private calculateActualProfit;
    private publishExecutionResult;
    private startHealthMonitoring;
    isRunning(): boolean;
    getState(): ServiceState;
    getQueueSize(): number;
    isQueuePaused(): boolean;
    getStats(): ExecutionStats;
    getActiveExecutionsCount(): number;
    /**
     * P1-2/P1-3 FIX: Get provider health status for monitoring
     */
    getProviderHealth(): Map<string, ProviderHealth>;
    /**
     * P1-2/P1-3 FIX: Get healthy providers count
     */
    getHealthyProvidersCount(): number;
}
export {};
//# sourceMappingURL=engine.d.ts.map