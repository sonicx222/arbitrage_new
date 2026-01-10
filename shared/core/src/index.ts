// Core utilities exports
export { RedisClient, getRedisClient } from './redis';
export { createLogger, PerformanceLogger, getPerformanceLogger } from './logger';
export { MatrixPriceCache, getMatrixPriceCache } from './matrix-cache';
export { PredictiveCacheWarmer, getPredictiveCacheWarmer } from './predictive-warmer';
export { EventProcessingWorkerPool, getWorkerPool, PriorityQueue } from './worker-pool';
export { EventBatcher, BatchedEvent, createEventBatcher, getDefaultEventBatcher } from './event-batcher';
export {
  WebSocketManager,
  WebSocketConfig,
  WebSocketSubscription,
  WebSocketMessage,
  WebSocketEventHandler,
  ConnectionStateHandler
} from './websocket-manager';
export { HierarchicalCache, createHierarchicalCache, getHierarchicalCache } from './hierarchical-cache';
export { SharedMemoryCache, createSharedMemoryCache, getSharedMemoryCache } from './shared-memory-cache';
export { CacheCoherencyManager, createCacheCoherencyManager, getCacheCoherencyManager } from './cache-coherency-manager';
export { ABTestingFramework, createABTestingFramework, getABTestingFramework, quickExperiment } from './ab-testing';
export {
  CircuitBreaker,
  CircuitBreakerError,
  CircuitBreakerConfig,
  CircuitBreakerStats,
  CircuitState,
  CircuitBreakerRegistry,
  createCircuitBreaker,
  getCircuitBreakerRegistry,
  withCircuitBreaker
} from './circuit-breaker';
export { RetryMechanism, RetryPresets, withRetry, retry, retryAdvanced } from './retry-mechanism';
export { GracefulDegradationManager, getGracefulDegradationManager, triggerDegradation, isFeatureEnabled, getCapabilityFallback } from './graceful-degradation';
export { DeadLetterQueue, getDeadLetterQueue, enqueueFailedOperation } from './dead-letter-queue';
export { SelfHealingManager, getSelfHealingManager, registerServiceForSelfHealing } from './self-healing-manager';
export { ExpertSelfHealingManager, getExpertSelfHealingManager } from './expert-self-healing-manager';
export { ErrorRecoveryOrchestrator, getErrorRecoveryOrchestrator, recoverFromError, withErrorRecovery } from './error-recovery';
export { EnhancedHealthMonitor, getEnhancedHealthMonitor, recordHealthMetric, getCurrentSystemHealth } from './enhanced-health-monitor';

// Professional-grade arbitrage and analytics exports
export {
  AdvancedStatisticalArbitrage,
  MarketRegime,
  StatisticalSignal,
  RegimeTransition,
  AdaptiveThresholds
} from './advanced-statistical-arbitrage';
export {
  RiskManagementEngine,
  Position,
  PositionRisk,
  PortfolioMetrics,
  RiskLimits,
  RiskAlert
} from './risk-management';
export {
  PerformanceAnalyticsEngine,
  StrategyPerformance,
  AssetPerformance,
  TimePerformance,
  BenchmarkComparison,
  AttributionAnalysis
} from './performance-analytics';
export {
  CrossDexTriangularArbitrage,
  DexPool,
  TriangularOpportunity,
  TriangularStep,
  ArbitragePath
} from './cross-dex-triangular-arbitrage';
export {
  EnterpriseTestingFramework,
  TestScenario,
  TestAssertion,
  TestResult,
  TestMetrics,
  AssertionResult,
  ChaosEvent,
  LoadProfile,
  TestSuite,
  TestSuiteResult,
  getEnterpriseTestingFramework
} from './enterprise-testing';
export {
  EnterpriseConfigurationManager,
  ConfigurationSchema,
  ConfigurationLayer,
  ValidationResult,
} from './enterprise-config';
export {
  ValidationMiddleware,
  ValidationSchemas
} from './validation';

// Domain models and core interfaces
export * from './domain-models';

// Repository pattern
export {
  RedisArbitrageRepository,
  RedisExecutionRepository,
  createArbitrageRepository,
  createExecutionRepository
} from './repositories';

// Refactored service layer
export { ArbitrageService } from './arbitrage-service';
export type { ArbitrageServiceConfig } from './arbitrage-service';

export {
  ConfigurationChange,
  getEnterpriseConfigManager,
  DEFAULT_CONFIG_SCHEMA
} from './enterprise-config';
export {
  AdvancedArbitrageOrchestrator,
  ArbitrageExecution,
  ExecutionStep,
  getAdvancedArbitrageOrchestrator
} from './advanced-arbitrage-orchestrator';

// Re-export types for convenience
export type {
  Chain,
  Dex,
  Token,
  Pair,
  PriceUpdate,
  ArbitrageOpportunity,
  SwapEvent,
  WhaleTransaction,
  MessageEvent,
  ServiceHealth,
  PerformanceMetrics,
  PredictionResult,
  MLModelMetrics,
  ServiceConfig,
  DetectorConfig,
  ExecutionConfig,
  ArbitrageError,
  NetworkError,
  ValidationError
} from '../../types';