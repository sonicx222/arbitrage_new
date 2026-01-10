export interface TestScenario {
    id: string;
    name: string;
    description: string;
    type: 'unit' | 'integration' | 'load' | 'chaos' | 'performance' | 'security';
    targetService: string;
    duration: number;
    concurrency: number;
    config: any;
    assertions: TestAssertion[];
}
export interface TestAssertion {
    name: string;
    type: 'response_time' | 'error_rate' | 'throughput' | 'memory_usage' | 'cpu_usage' | 'custom';
    operator: 'lt' | 'le' | 'gt' | 'ge' | 'eq' | 'ne';
    value: number;
    metric?: string;
}
export interface TestResult {
    scenarioId: string;
    success: boolean;
    duration: number;
    metrics: TestMetrics;
    assertions: AssertionResult[];
    errors: string[];
    timestamp: number;
}
export interface TestMetrics {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    averageResponseTime: number;
    minResponseTime: number;
    maxResponseTime: number;
    p95ResponseTime: number;
    p99ResponseTime: number;
    throughput: number;
    errorRate: number;
    memoryUsage: number;
    cpuUsage: number;
    networkIO: number;
}
export interface AssertionResult {
    assertion: TestAssertion;
    success: boolean;
    actualValue: number;
    message: string;
}
export interface ChaosEvent {
    id: string;
    type: 'network_delay' | 'service_failure' | 'resource_exhaustion' | 'data_corruption' | 'high_load';
    targetService: string;
    duration: number;
    intensity: number;
    config: any;
}
export interface LoadProfile {
    type: 'constant' | 'ramp_up' | 'spike' | 'random';
    duration: number;
    startRPS: number;
    endRPS: number;
    pattern?: number[];
}
export declare class EnterpriseTestingFramework {
    private redis;
    private circuitBreakers;
    private dlq;
    private selfHealingManager;
    private activeTests;
    private testHistory;
    constructor();
    executeScenario(scenario: TestScenario): Promise<TestResult>;
    runChaosExperiment(baseScenario: TestScenario, chaosEvents: ChaosEvent[]): Promise<TestResult[]>;
    runLoadTest(serviceName: string, loadProfile: LoadProfile, testFunction: () => Promise<any>): Promise<TestResult>;
    runPerformanceRegression(baselineResults: TestResult[], currentResults: TestResult[]): Promise<{
        regressions: Array<{
            metric: string;
            baseline: number;
            current: number;
            change: number;
            significant: boolean;
        }>;
        improvements: Array<{
            metric: string;
            baseline: number;
            current: number;
            change: number;
        }>;
    }>;
    getTestAnalytics(serviceName?: string, timeRange?: number): Promise<{
        totalTests: number;
        successRate: number;
        averageDuration: number;
        performanceTrends: any;
        failurePatterns: any;
        recommendations: string[];
    }>;
    createTestSuite(name: string, scenarios: TestScenario[]): TestSuite;
    private initializeDefaultScenarios;
    private validateAssertions;
    private injectChaos;
    private injectNetworkDelay;
    private injectServiceFailure;
    private injectResourceExhaustion;
    private injectDataCorruption;
    private injectHighLoad;
    private averageMetric;
    private analyzePerformanceTrends;
    private analyzeFailurePatterns;
    private generateTestRecommendations;
    private calculateTrend;
    private storeTestResult;
    private delay;
}
export declare class TestSuite {
    private name;
    private scenarios;
    private framework;
    private results;
    constructor(name: string, scenarios: TestScenario[], framework: EnterpriseTestingFramework);
    run(): Promise<TestSuiteResult>;
    getResults(): TestResult[];
}
export interface TestSuiteResult {
    name: string;
    totalScenarios: number;
    successfulScenarios: number;
    failedScenarios: number;
    successRate: number;
    totalDuration: number;
    averageScenarioDuration: number;
    results: TestResult[];
    timestamp: number;
}
export declare function getEnterpriseTestingFramework(): EnterpriseTestingFramework;
//# sourceMappingURL=enterprise-testing.d.ts.map