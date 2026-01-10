export declare class CoordinatorService {
    private redis;
    private logger;
    private perfLogger;
    private app;
    private server;
    private isRunning;
    private serviceHealth;
    private systemMetrics;
    private alertCooldowns;
    private healthCheckInterval;
    private metricsUpdateInterval;
    constructor();
    start(port?: number): Promise<void>;
    stop(): Promise<void>;
    private initializeMetrics;
    private setupMiddleware;
    private setupRoutes;
    private startHealthMonitoring;
    private subscribeToExecutionResults;
    private updateServiceHealth;
    private handleExecutionResult;
    private updateSystemMetrics;
    private checkForAlerts;
    private sendAlert;
    private getDashboard;
    private getHealth;
    private getMetrics;
    private getServices;
    private getAlerts;
    private restartService;
    private acknowledgeAlert;
    private setupHealthMonitoring;
}
//# sourceMappingURL=coordinator.d.ts.map