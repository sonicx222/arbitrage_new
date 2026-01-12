import winston from 'winston';
export declare function createLogger(serviceName: string): winston.Logger;
export declare class PerformanceLogger {
    private logger;
    private metrics;
    constructor(serviceName: string);
    startTimer(operation: string): void;
    endTimer(operation: string, metadata?: any): number;
    logEventLatency(operation: string, latency: number, metadata?: any): void;
    logArbitrageOpportunity(opportunity: any): void;
    logExecutionResult(result: any): void;
    logError(error: Error, context?: any): void;
    logHealthCheck(service: string, status: any): void;
    logMetrics(metrics: any): void;
}
export declare function getPerformanceLogger(serviceName: string): PerformanceLogger;
//# sourceMappingURL=logger.d.ts.map