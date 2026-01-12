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
    private streamsClient;
    private degradationLevels;
    private serviceCapabilities;
    private serviceStates;
    private recoveryTimers;
    constructor();
    /**
     * P1-15 FIX: Initialize Redis Streams client for dual-publish pattern.
     * Streams is the primary transport (ADR-002), Pub/Sub is fallback.
     */
    private initializeStreamsClient;
    /**
     * P1-15 FIX: Dual-publish helper - publishes to both Redis Streams (primary)
     * and Pub/Sub (secondary/fallback) for backwards compatibility.
     *
     * This follows the migration pattern from ADR-002 where we transition
     * from Pub/Sub to Streams while maintaining backwards compatibility.
     */
    private dualPublish;
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