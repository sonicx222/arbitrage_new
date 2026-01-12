export interface ServiceDefinition {
    name: string;
    startCommand: string;
    healthCheckUrl?: string;
    healthCheckInterval: number;
    restartDelay: number;
    maxRestarts: number;
    environment: Record<string, string>;
    dependencies?: string[];
}
export interface ServiceHealth {
    name: string;
    status: 'healthy' | 'unhealthy' | 'starting' | 'stopping';
    lastHealthCheck: number;
    consecutiveFailures: number;
    restartCount: number;
    uptime: number;
    memoryUsage?: number;
    cpuUsage?: number;
    errorMessage?: string;
}
export interface RecoveryStrategy {
    name: string;
    priority: number;
    canHandle: (service: ServiceHealth, error?: Error) => boolean;
    execute: (service: ServiceHealth) => Promise<boolean>;
}
export declare class SelfHealingManager {
    private redis;
    private streamsClient;
    private services;
    private serviceHealth;
    private recoveryStrategies;
    private healthCheckTimers;
    private restartTimers;
    private circuitBreakers;
    private isRunning;
    private healthUpdateLocks;
    private initializationPromise;
    constructor();
    /**
     * P1-2-FIX: Ensure the manager is fully initialized before operations.
     * Call this before performing any operations that require the streams client.
     */
    ensureInitialized(): Promise<void>;
    /**
     * P1-16 FIX: Initialize Redis Streams client for dual-publish pattern.
     */
    private initializeStreamsClient;
    /**
     * P1-16 FIX: Dual-publish helper - publishes to both Redis Streams (primary)
     * and Pub/Sub (secondary/fallback) for backwards compatibility.
     */
    private dualPublish;
    registerService(serviceDef: ServiceDefinition): void;
    start(): Promise<void>;
    stop(): Promise<void>;
    getAllServiceHealth(): Record<string, ServiceHealth>;
    triggerRecovery(serviceName: string, error?: Error): Promise<boolean>;
    addRecoveryStrategy(strategy: RecoveryStrategy): void;
    private initializeRecoveryStrategies;
    private startHealthMonitoring;
    private performHealthCheck;
    private executeRecoveryStrategies;
    private restartService;
    private checkHttpHealth;
    private checkProcessHealth;
    private simulateServiceRestart;
    private subscribeToHealthUpdates;
    private handleHealthUpdate;
    private updateHealthInRedis;
    private notifyServiceDegradation;
}
export declare function getSelfHealingManager(): SelfHealingManager;
export declare function registerServiceForSelfHealing(serviceDef: ServiceDefinition): void;
//# sourceMappingURL=self-healing-manager.d.ts.map