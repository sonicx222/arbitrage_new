// Core utilities exports
export {
  RedisClient,
  RedisOperationError,
  getRedisClient,
  resetRedisInstance
} from './redis';
export type { RedisClientDeps, RedisConstructor } from './redis';

// P1-3-FIX: Standardized singleton pattern utilities
export { createAsyncSingleton, createSingleton, singleton } from './async-singleton';

// P2-2 FIX: Reusable AsyncMutex utility
export {
  AsyncMutex,
  namedMutex,
  clearNamedMutex,
  clearAllNamedMutexes
} from './async-mutex';
export type { MutexStats } from './async-mutex';
export {
  RedisStreamsClient,
  StreamBatcher,
  StreamConsumer,
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
  ServiceStateSnapshot,
  ServiceStateLogger,
  ServiceStateManagerDeps
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
  BatcherStats,
  StreamConsumerConfig,
  StreamConsumerStats,
  RedisStreamsConstructor,
  RedisStreamsClientDeps
} from './redis-streams';
export { createLogger, PerformanceLogger, getPerformanceLogger, Logger } from './logger';
// REMOVED: MatrixPriceCache and PredictiveCacheWarmer (unused modules cleaned up)
export { EventProcessingWorkerPool, getWorkerPool, PriorityQueue } from './worker-pool';
export type { Task, TaskResult } from './worker-pool';
export { EventBatcher, BatchedEvent, createEventBatcher, getDefaultEventBatcher } from './event-batcher';
export {
  WebSocketManager,
  WebSocketConfig,
  WebSocketSubscription,
  WebSocketMessage,
  WebSocketEventHandler,
  ConnectionStateHandler,
  ErrorEventHandler,
  GenericEventHandler
} from './websocket-manager';

// S3.3: Provider Health Scoring for intelligent fallback selection
export {
  ProviderHealthScorer,
  getProviderHealthScorer,
  resetProviderHealthScorer
} from './provider-health-scorer';
export type {
  ProviderHealthMetrics,
  ProviderHealthScorerConfig
} from './provider-health-scorer';

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
export { ExpertSelfHealingManager, getExpertSelfHealingManager, FailureSeverity, RecoveryStrategy } from './expert-self-healing-manager';
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
  StreamAlert,
  StreamHealthMonitorConfig
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

// T3.12: Enhanced Whale Activity Detection
export {
  WhaleActivityTracker,
  getWhaleActivityTracker,
  resetWhaleActivityTracker
} from './whale-activity-tracker';
export type {
  WhaleTrackerConfig,
  TrackedWhaleTransaction,
  WalletProfile,
  WalletPattern,
  WhaleSignal,
  WhaleActivitySummary,
  WhaleTrackerStats
} from './whale-activity-tracker';

// T3.15: Liquidity Depth Analysis
export {
  LiquidityDepthAnalyzer,
  getLiquidityDepthAnalyzer,
  resetLiquidityDepthAnalyzer
} from './liquidity-depth-analyzer';
export type {
  LiquidityDepthConfig,
  PoolLiquidity,
  LiquidityLevel,
  DepthAnalysis,
  SlippageEstimate,
  LiquidityAnalyzerStats
} from './liquidity-depth-analyzer';

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
  CacheLookupResult,
  PairCacheServiceDeps
} from './pair-cache';

// Professional Quality Monitor (AD-PQS scoring)
export {
  ProfessionalQualityMonitor
} from './professional-quality-monitor';
export type {
  ProfessionalQualityScore,
  QualityMetrics,
  QualityMonitorDeps,
  QualityMonitorRedis
} from './professional-quality-monitor';

// DEX Adapters for non-factory DEXes (Balancer V2, GMX, Platypus)
export {
  BalancerV2Adapter,
  GmxAdapter,
  PlatypusAdapter,
  AdapterRegistry,
  getAdapterRegistry,
  resetAdapterRegistry,
  BALANCER_VAULT_ADDRESSES,
  BALANCER_VAULT_ABI,
  GMX_ADDRESSES,
  GMX_VAULT_ABI,
  GMX_READER_ABI,
  PLATYPUS_ADDRESSES,
  PLATYPUS_POOL_ABI,
  SUBGRAPH_URLS,
  success as adapterSuccess,
  failure as adapterFailure
} from './dex-adapters';
export type {
  AdapterConfig,
  AdapterType,
  PoolType,
  DiscoveredPool,
  PoolReserves,
  SwapQuote,
  DexAdapter,
  AdapterKey,
  AdapterFactory,
  AdapterRegistryEntry,
  AdapterResult
} from './dex-adapters';

// REMOVED: Other professional-grade modules (unused, cleaned up):
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
  ArbitragePath,
  // T2.6: Quadrilateral arbitrage
  QuadrilateralOpportunity
} from './cross-dex-triangular-arbitrage';

// T3.11: Multi-Leg Path Finding (5+ tokens)
export {
  MultiLegPathFinder,
  getMultiLegPathFinder,
  resetMultiLegPathFinder
} from './multi-leg-path-finder';
export type {
  MultiLegPathConfig,
  MultiLegOpportunity,
  PathFinderStats
} from './multi-leg-path-finder';

export {
  ValidationMiddleware,
  ValidationSchemas
} from './validation';
// T2.7: Price Momentum Detection
export {
  PriceMomentumTracker,
  MomentumSignal,
  MomentumConfig,
  PairStats,
  getPriceMomentumTracker,
  resetPriceMomentumTracker
} from './price-momentum';

// T2.8: ML Opportunity Scorer
export {
  MLOpportunityScorer,
  getMLOpportunityScorer,
  resetMLOpportunityScorer
} from './ml-opportunity-scorer';
export type {
  MLPrediction,
  MLScorerConfig,
  OpportunityScoreInput,
  OpportunityWithMomentum,
  EnhancedScore,
  ScorerStats
} from './ml-opportunity-scorer';

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
export type {
  DetectorConfig as BaseDetectorConfig,
  PairSnapshot,
  ExtendedPair,
  BaseDetectorDeps,
  BaseDetectorLogger
} from './base-detector';

// Partitioned detector for multi-chain management (ADR-003, S3.1)
export { PartitionedDetector } from './partitioned-detector';
export type {
  PartitionedDetectorConfig,
  PartitionedDetectorDeps,
  PartitionedDetectorLogger,
  TokenNormalizeFn,
  ChainHealth as PartitionChainHealth,
  ChainHealth,
  PartitionHealth,
  ChainStats as PartitionChainStats,
  PricePoint,
  CrossChainDiscrepancy
} from './partitioned-detector';

// Solana detector for non-EVM chain support (S3.3.1)
export { SolanaDetector, SOLANA_DEX_PROGRAMS } from './solana-detector';
export type {
  SolanaDetectorConfig,
  SolanaDetectorDeps,
  SolanaDetectorLogger,
  SolanaDetectorPerfLogger,
  SolanaDetectorRedisClient,
  SolanaDetectorStreamsClient,
  SolanaPool,
  SolanaPriceUpdate,
  SolanaTokenInfo,
  SolanaDetectorHealth,
  ConnectionPoolConfig,
  ConnectionMetrics,
  ProgramSubscription
} from './solana-detector';

// Solana swap parser for instruction parsing (S3.3.4)
export {
  SolanaSwapParser,
  getSolanaSwapParser,
  resetSolanaSwapParser,
  SOLANA_DEX_PROGRAM_IDS,
  PROGRAM_ID_TO_DEX,
  SWAP_DISCRIMINATORS,
  DISABLED_DEXES
} from './solana-swap-parser';
export type {
  SolanaInstruction,
  SolanaTransaction,
  InstructionAccount,
  TokenBalance,
  ParsedSolanaSwap,
  SwapParserConfig,
  ParserStats
} from './solana-swap-parser';

// =============================================================================
// REF-1 to REF-4 / ARCH-1 to ARCH-3: Shared Utilities
// =============================================================================

// REF-1/ARCH-1: Shared arbitrage calculation logic
export {
  // P0-1 FIX: Precision-safe BigInt utilities
  safeBigIntDivision,
  calculatePriceFromReserves,
  calculatePriceFromBigIntReserves,
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

// Partition service utilities (P12-P16 refactor)
export {
  parsePort,
  validateAndFilterChains,
  createPartitionHealthServer,
  shutdownPartitionService,
  setupDetectorEventHandlers,
  setupProcessHandlers,
  SHUTDOWN_TIMEOUT_MS
} from './partition-service-utils';
export type {
  PartitionServiceConfig,
  HealthServerOptions,
  PartitionDetectorInterface,
  ProcessHandlerCleanup
} from './partition-service-utils';

// Partition Router (S3.1.7 - Detector Migration)
export {
  PartitionRouter,
  createDeprecationWarning,
  isDeprecatedPattern,
  getMigrationRecommendation,
  warnIfDeprecated,
  // P1-1/P1-2-FIX: Export constants as single source of truth
  PARTITION_PORTS,
  PARTITION_SERVICE_NAMES
} from './partition-router';
export type { PartitionEndpoint } from './partition-router';

// Simulation Mode for Local Testing
export {
  PriceSimulator,
  getSimulator,
  isSimulationMode,
  SIMULATION_CONFIG
} from './simulation-mode';
export type {
  SimulatedPriceUpdate,
  SimulationConfig
} from './simulation-mode';

// P0-2 FIX: Nonce Manager for Transaction Sequencing
// CRITICAL-4 FIX: Added getNonceManagerAsync for race-safe initialization
export {
  NonceManager,
  getNonceManager,
  getNonceManagerAsync,
  resetNonceManager
} from './nonce-manager';
export type { NonceManagerConfig } from './nonce-manager';

// Phase 2: Gas Price Cache (ADR-012, ADR-013)
export {
  GasPriceCache,
  getGasPriceCache,
  resetGasPriceCache,
  GAS_UNITS,
  DEFAULT_TRADE_AMOUNT_USD,
  FALLBACK_GAS_COSTS_ETH,
  FALLBACK_GAS_SCALING_PER_STEP
} from './gas-price-cache';
export type {
  GasPriceData,
  NativeTokenPrice,
  GasCostEstimate,
  GasPriceCacheConfig
} from './gas-price-cache';