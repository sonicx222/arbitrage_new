export declare enum FailureSeverity {
    LOW = "low",// Temporary glitch, self-correcting
    MEDIUM = "medium",// Service degradation, requires intervention
    HIGH = "high",// Service failure, immediate recovery needed
    CRITICAL = "critical"
}
export declare enum RecoveryStrategy {
    RESTART_SERVICE = "restart_service",
    FAILOVER_TO_BACKUP = "failover_to_backup",
    SCALE_UP_RESOURCES = "scale_up_resources",
    ROLLBACK_DEPLOYMENT = "rollback_deployment",
    CIRCUIT_BREAKER_TRIP = "circuit_breaker_trip",
    LOAD_SHEDDING = "load_shedding",
    DATA_REPAIR = "data_repair",
    NETWORK_RESET = "network_reset",
    MEMORY_COMPACTION = "memory_compaction",
    CONFIGURATION_RESET = "configuration_reset"
}
export interface FailureEvent {
    id: string;
    serviceName: string;
    component: string;
    error: Error;
    severity: FailureSeverity;
    context: any;
    timestamp: number;
    recoveryAttempts: number;
    lastRecoveryAttempt?: number;
}
export interface RecoveryAction {
    id: string;
    failureId: string;
    strategy: RecoveryStrategy;
    status: 'pending' | 'executing' | 'completed' | 'failed';
    startTime: number;
    endTime?: number;
    success?: boolean;
    error?: string;
    rollbackRequired?: boolean;
}
export interface ServiceHealthState {
    serviceName: string;
    healthScore: number;
    lastHealthyCheck: number;
    consecutiveFailures: number;
    recoveryCooldown: number;
    activeRecoveryActions: RecoveryAction[];
}
export declare class ExpertSelfHealingManager {
    private redis;
    private streamsClient;
    private circuitBreakers;
    private dlq;
    private healthMonitor;
    private errorRecovery;
    private serviceHealthStates;
    private activeRecoveryActions;
    private failureHistory;
    private recoveryCooldowns;
    private isRunning;
    private monitoringInterval;
    constructor();
    /**
     * P0-10 FIX: Initialize streams client for ADR-002 compliant message delivery
     */
    private initializeStreamsClient;
    /**
     * P0-10 FIX: Publish to both Redis Streams (for guaranteed delivery) and Pub/Sub (for backward compatibility)
     * This ensures messages are not lost even if the target service is temporarily unavailable.
     */
    private publishControlMessage;
    start(): Promise<void>;
    stop(): Promise<void>;
    reportFailure(serviceName: string, component: string, error: Error, context?: any): Promise<void>;
    private assessFailureSeverity;
    private updateServiceHealthState;
    private analyzeAndRecover;
    private determineRecoveryStrategy;
    private executeRecoveryAction;
    private performRecoveryAction;
    private restartService;
    private resetNetworkConnection;
    private performMemoryCompaction;
    private tripCircuitBreaker;
    private repairDataIntegrity;
    private resetConfiguration;
    private failoverToBackup;
    private scaleUpResources;
    private waitForServiceHealth;
    private cancelRecoveryAction;
    private startHealthMonitoring;
    private startFailureDetection;
    private startRecoveryOrchestration;
    private subscribeToFailureEvents;
    private performHealthCheck;
    private initializeDefaultStates;
    getSystemHealthOverview(): Promise<any>;
    getFailureStatistics(timeframe?: number): Promise<any>;
}
export declare function getExpertSelfHealingManager(): Promise<ExpertSelfHealingManager>;
//# sourceMappingURL=expert-self-healing-manager.d.ts.map