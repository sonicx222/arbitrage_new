// Core utilities exports
export { RedisClient, getRedisClient, resetRedisInstance } from './redis';

// P1-3-FIX: Standardized singleton pattern utilities
export { createAsyncSingleton, createSingleton, singleton } from './async-singleton';
export {
  RedisStreamsClient,
  StreamBatcher,
  getRedisStreamsClient,
  resetRedisStreamsInstance
} from './redis-streams';

// Distributed Lock Manager (ADR-007)
export {
  DistributedLockManager,
  getDistributedLockManager,
  resetDistributedLockManager
} from './distributed-lock';
export type {
  LockConfig,
  AcquireOptions,
  LockHandle,
  LockStats
} from './distributed-lock';

// Service State Machine (lifecycle management)
export {
  ServiceStateManager,
  ServiceState,
  createServiceState,
  isServiceState
} from './service-state';
export type {
  StateTransitionResult,
  StateChangeEvent,
  ServiceStateConfig,
  ServiceStateSnapshot
} from './service-state';

// Price Oracle (replaces hardcoded prices)
export {
  PriceOracle,
  getPriceOracle,
  resetPriceOracle,
  getDefaultPrice,
  hasDefaultPrice
} from './price-oracle';
export type {
  TokenPrice,
  PriceOracleConfig,
  PriceBatchRequest
} from './price-oracle';
export type {
  StreamMessage,
  ConsumerGroupConfig,
  XReadOptions,
  XReadGroupOptions,
  XTrimOptions,
  XAddOptions,
  StreamInfo,
  PendingInfo,
  BatcherConfig,
  BatcherStats
} from './redis-streams';
export { createLogger, PerformanceLogger, getPerformanceLogger } from './logger';
// REMOVED: MatrixPriceCache and PredictiveCacheWarmer (unused modules cleaned up)
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
export { CacheCoherencyManager, createCacheCoherencyManager, getCacheCoherencyManager, resetCacheCoherencyManager } from './cache-coherency-manager';
// REMOVED: ABTestingFramework (unused module cleaned up)
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
export {
  RetryMechanism,
  RetryPresets,
  withRetry,
  retry,
  retryAdvanced,
  // P1-2 fix: Error classification utilities
  ErrorCategory,
  classifyError,
  isRetryableError
} from './retry-mechanism';
export { GracefulDegradationManager, getGracefulDegradationManager, triggerDegradation, isFeatureEnabled, getCapabilityFallback } from './graceful-degradation';

// Cross-Region Health (ADR-007)
export {
  CrossRegionHealthManager,
  getCrossRegionHealthManager,
  resetCrossRegionHealthManager,
  DegradationLevel
} from './cross-region-health';
export type {
  RegionHealth,
  RegionStatus,
  ServiceRegionHealth,
  FailoverEvent,
  CrossRegionHealthConfig,
  GlobalHealthStatus
} from './cross-region-health';
export { DeadLetterQueue, getDeadLetterQueue, enqueueFailedOperation } from './dead-letter-queue';
export { SelfHealingManager, getSelfHealingManager, registerServiceForSelfHealing } from './self-healing-manager';
export { ExpertSelfHealingManager, getExpertSelfHealingManager } from './expert-self-healing-manager';
export { ErrorRecoveryOrchestrator, getErrorRecoveryOrchestrator, recoverFromError, withErrorRecovery } from './error-recovery';
export { EnhancedHealthMonitor, getEnhancedHealthMonitor, recordHealthMetric, getCurrentSystemHealth } from './enhanced-health-monitor';
export {
  StreamHealthMonitor,
  getStreamHealthMonitor,
  resetStreamHealthMonitor
} from './stream-health-monitor';
export type {
  StreamHealthStatus,
  StreamLagInfo,
  ConsumerLagInfo,
  MonitoredStreamInfo,
  StreamHealth,
  StreamMetrics,
  ConsumerGroupHealth,
  StreamHealthSummary,
  StreamHealthThresholds,
  StreamAlert
} from './stream-health-monitor';
export {
  SwapEventFilter,
  getSwapEventFilter,
  resetSwapEventFilter
} from './swap-event-filter';
export type {
  SwapEventFilterConfig,
  FilterResult,
  FilterReason,
  VolumeAggregate,
  WhaleAlert,
  FilterStats,
  BatchResult
} from './swap-event-filter';
export {
  PriceMatrix,
  PriceIndexMapper,
  getPriceMatrix,
  resetPriceMatrix
} from './price-matrix';
export type {
  PriceMatrixConfig,
  PriceEntry,
  MemoryUsage,
  PriceMatrixStats,
  BatchUpdate
} from './price-matrix';

// Pair Discovery and Caching (S2.2.5)
export {
  PairDiscoveryService,
  getPairDiscoveryService,
  resetPairDiscoveryService
} from './pair-discovery';
export type {
  PairDiscoveryConfig,
  DiscoveredPair,
  PairDiscoveryStats
} from './pair-discovery';
export {
  PairCacheService,
  getPairCacheService,
  resetPairCacheService
} from './pair-cache';
export type {
  PairCacheConfig,
  CachedPairData,
  PairCacheStats,
  CacheLookupResult
} from './pair-cache';

// REMOVED: Professional-grade modules (unused, cleaned up):
// - AdvancedStatisticalArbitrage
// - RiskManagementEngine
// - EnterpriseTestingFramework
// - EnterpriseConfigurationManager

// Keeping PerformanceAnalyticsEngine and CrossDexTriangularArbitrage as they may be needed
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

// REMOVED: ArbitrageService and EnterpriseConfigManager (unused, cleaned up)
// DEPRECATED: AdvancedArbitrageOrchestrator removed per ADR-002
// The orchestrator used Pub/Sub which violates ADR-002 (Redis Streams required)
// Use the coordinator service pattern with Redis Streams instead
// See: services/coordinator/src/coordinator.ts

// Base detector for chain-specific implementations
export { BaseDetector } from './base-detector';
export type { DetectorConfig as BaseDetectorConfig, PairSnapshot } from './base-detector';

// =============================================================================
// REF-1 to REF-4 / ARCH-1 to ARCH-3: Shared Utilities
// =============================================================================

// REF-1/ARCH-1: Shared arbitrage calculation logic
export {
  calculatePriceFromReserves,
  invertPrice,
  calculatePriceDifferencePercent,
  isSameTokenPair,
  isReverseOrder,
  getMinProfitThreshold,
  getDefaultFee,
  calculateIntraChainArbitrage,
  calculateCrossChainArbitrage,
  validatePairSnapshot,
  createPairSnapshot
} from './arbitrage-calculator';
export type {
  PairSnapshot as ArbitragePairSnapshot,
  ChainPriceData,
  PriceComparisonResult,
  ArbitrageCalcConfig,
  CrossChainOpportunityResult
} from './arbitrage-calculator';

// REF-2: Shared message validation utilities
export {
  validatePriceUpdate,
  validateWhaleTransaction,
  validateSwapEvent,
  validateReserveUpdate,
  validateCoordinatorCommand,
  validateServiceHealthStatus,
  validateMessage,
  validateBatch,
  createPriceUpdate,
  createWhaleTransaction,
  createCoordinatorCommand
} from './message-validators';
export type {
  PriceUpdate as ValidatedPriceUpdate,
  WhaleTransaction as ValidatedWhaleTransaction,
  SwapEvent as ValidatedSwapEvent,
  ReserveUpdate,
  CoordinatorCommand,
  ServiceHealthStatus,
  ValidationResult
} from './message-validators';

// REF-3/ARCH-2: Standardized error handling
export {
  ArbitrageError as BaseArbitrageError,
  ConnectionError,
  ValidationError as SharedValidationError,
  LifecycleError,
  ExecutionError,
  ErrorCode,
  ErrorSeverity,
  success,
  failure,
  tryCatch,
  tryCatchSync,
  isRetryableError as isRetryableErrorCheck,
  isCriticalError,
  getErrorSeverity,
  formatErrorForLog,
  formatErrorForResponse,
  ErrorAggregator
} from './error-handling';
export type { Result } from './error-handling';

// REF-4/ARCH-3: Shared async utilities
export {
  TimeoutError,
  withTimeout,
  withTimeoutDefault,
  withTimeoutSafe,
  withRetry as withRetryAsync,
  sleep,
  createDeferred,
  mapConcurrent,
  mapSequential,
  debounceAsync,
  throttleAsync,
  gracefulShutdown,
  waitWithTimeouts
} from './async-utils';
export type {
  RetryConfig,
  Deferred
} from './async-utils';

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