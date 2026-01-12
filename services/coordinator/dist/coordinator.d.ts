import type { ServiceHealth } from '../../../shared/types/src';
interface SystemMetrics {
    totalOpportunities: number;
    totalExecutions: number;
    successfulExecutions: number;
    totalProfit: number;
    averageLatency: number;
    averageMemory: number;
    systemHealth: number;
    activeServices: number;
    lastUpdate: number;
    whaleAlerts: number;
    pendingOpportunities: number;
}
interface LeaderElectionConfig {
    lockKey: string;
    lockTtlMs: number;
    heartbeatIntervalMs: number;
    instanceId: string;
}
interface CoordinatorConfig {
    port: number;
    leaderElection: LeaderElectionConfig;
    consumerGroup: string;
    consumerId: string;
}
export declare class CoordinatorService {
    private redis;
    private streamsClient;
    private logger;
    private perfLogger;
    private stateManager;
    private app;
    private server;
    private isRunning;
    private isLeader;
    private serviceHealth;
    private systemMetrics;
    private alertCooldowns;
    private opportunities;
    private healthCheckInterval;
    private metricsUpdateInterval;
    private leaderHeartbeatInterval;
    private streamConsumerInterval;
    private readonly config;
    private readonly consumerGroups;
    constructor(config?: Partial<CoordinatorConfig>);
    start(port?: number): Promise<void>;
    stop(): Promise<void>;
    private clearAllIntervals;
    private tryAcquireLeadership;
    /**
     * P0-4 fix: Atomic lock renewal using compare-and-set pattern.
     * Returns true if renewal succeeded, false if lock was lost.
     */
    private renewLeaderLock;
    private releaseLeadership;
    private startLeaderHeartbeat;
    private createConsumerGroups;
    private streamConsumerErrors;
    private readonly MAX_STREAM_ERRORS;
    private lastStreamErrorReset;
    private startStreamConsumers;
    private consumeHealthStream;
    private consumeOpportunitiesStream;
    private consumeWhaleAlertsStream;
    private handleHealthMessage;
    private readonly MAX_OPPORTUNITIES;
    private readonly OPPORTUNITY_TTL_MS;
    private handleOpportunityMessage;
    private handleWhaleAlertMessage;
    private forwardToExecutionEngine;
    private initializeMetrics;
    private startHealthMonitoring;
    private reportHealth;
    private updateSystemMetrics;
    private checkForAlerts;
    private sendAlert;
    private setupMiddleware;
    private setupRoutes;
    private getDashboard;
    private getHealth;
    private getMetrics;
    private getServices;
    private getOpportunities;
    private getAlerts;
    private getLeaderStatus;
    private validateServiceRestart;
    private validateAlertAcknowledge;
    private restartService;
    private acknowledgeAlert;
    getIsLeader(): boolean;
    getIsRunning(): boolean;
    getServiceHealthMap(): Map<string, ServiceHealth>;
    getSystemMetrics(): SystemMetrics;
}
export {};
//# sourceMappingURL=coordinator.d.ts.map