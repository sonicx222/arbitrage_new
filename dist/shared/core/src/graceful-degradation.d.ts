export interface DegradationLevel {
    name: string;
    description: string;
    enabledFeatures: string[];
    disabledFeatures: string[];
    performanceImpact: number;
    recoveryPriority: number;
}
export interface ServiceCapability {
    name: string;
    required: boolean;
    fallback?: any;
    degradationLevel: string;
}
export interface DegradationState {
    serviceName: string;
    currentLevel: DegradationLevel;
    previousLevel?: DegradationLevel;
    triggeredBy: string;
    timestamp: number;
    canRecover: boolean;
    recoveryAttempts: number;
    metrics: {
        performanceImpact: number;
        errorRate: number;
        throughputReduction: number;
    };
}
export declare class GracefulDegradationManager {
    private redis;
    private degradationLevels;
    private serviceCapabilities;
    private serviceStates;
    private recoveryTimers;
    constructor();
    registerDegradationLevels(serviceName: string, levels: DegradationLevel[]): void;
    registerCapabilities(serviceName: string, capabilities: ServiceCapability[]): void;
    triggerDegradation(serviceName: string, failedCapability: string, error?: Error): Promise<boolean>;
    attemptRecovery(serviceName: string): Promise<boolean>;
    getDegradationState(serviceName: string): DegradationState | null;
    getAllDegradationStates(): Record<string, DegradationState>;
    isFeatureEnabled(serviceName: string, featureName: string): boolean;
    getCapabilityFallback(serviceName: string, capabilityName: string): any;
    forceRecovery(serviceName: string): Promise<boolean>;
    private initializeDefaultDegradationLevels;
    private applyDegradation;
    private testRecovery;
    private testCapability;
    private recoverService;
    private scheduleRecovery;
    private notifyDegradation;
}
export declare function getGracefulDegradationManager(): GracefulDegradationManager;
export declare function triggerDegradation(serviceName: string, failedCapability: string, error?: Error): Promise<boolean>;
export declare function isFeatureEnabled(serviceName: string, featureName: string): boolean;
export declare function getCapabilityFallback(serviceName: string, capabilityName: string): any;
//# sourceMappingURL=graceful-degradation.d.ts.map