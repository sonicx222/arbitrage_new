export interface RecoveryContext {
    operation: string;
    service: string;
    component: string;
    error: Error;
    metadata?: any;
    correlationId?: string;
    attemptCount?: number;
}
export interface RecoveryResult {
    success: boolean;
    strategy: string;
    duration?: number;
    nextAction?: string;
    error?: Error;
}
export interface RecoveryStrategy {
    name: string;
    priority: number;
    canHandle: (context: RecoveryContext) => boolean;
    execute: (context: RecoveryContext) => Promise<RecoveryResult>;
}
export declare class ErrorRecoveryOrchestrator {
    private strategies;
    private circuitBreakers;
    private dlq;
    private degradationManager;
    private selfHealingManagerPromise;
    constructor();
    recover(context: RecoveryContext): Promise<RecoveryResult>;
    addStrategy(strategy: RecoveryStrategy): void;
    getRecoveryStats(): Promise<any>;
    private initializeDefaultStrategies;
    private handleFinalFailure;
}
export declare function getErrorRecoveryOrchestrator(): ErrorRecoveryOrchestrator;
export declare function recoverFromError(operation: string, service: string, component: string, error: Error, metadata?: any): Promise<RecoveryResult>;
export declare function withErrorRecovery(options: {
    service: string;
    component: string;
    operation?: string;
}): (target: any, propertyName: string, descriptor: PropertyDescriptor) => PropertyDescriptor;
export declare function checkRecoverySystemHealth(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    components: Record<string, boolean>;
    lastRecoveryAttempt?: number;
}>;
//# sourceMappingURL=error-recovery.d.ts.map