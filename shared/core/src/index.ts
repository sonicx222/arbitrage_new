/**
 * @arbitrage/core - Core Library
 *
 * R8: Public API Surface Reduction
 *
 * This module provides the public API for the arbitrage system. Exports are
 * organized into three categories:
 *
 * ## PUBLIC API (Stable)
 * Core services, utilities, and types that are part of the stable public API.
 * These exports follow semantic versioning and won't have breaking changes
 * in minor releases.
 *
 * ## INTERNAL API (Unstable)
 * Implementation details, testing utilities, and low-level APIs. These may
 * change between minor versions. For testing utilities and reset functions,
 * prefer importing from '@arbitrage/core/internal':
 *
 * ```typescript
 * import { resetRedisInstance, RecordingLogger } from '@arbitrage/core/internal';
 * ```
 *
 * ## DEPRECATED API
 * Exports marked for removal in v2.0.0. For migration guidance, import from
 * '@arbitrage/core/deprecated':
 *
 * ```typescript
 * import { calculateIntraChainArbitrage } from '@arbitrage/core/deprecated';
 * ```
 *
 * @module @arbitrage/core
 * @version 1.0.0
 */

// #############################################################################
// #                                                                           #
// #                    SECTION 1: CORE INFRASTRUCTURE                         #
// #                                                                           #
// #############################################################################

// =============================================================================
// 1.1 Redis Core
// =============================================================================

export {
  RedisClient,
  RedisOperationError,
  getRedisClient,
  /** @internal Use '@arbitrage/core/internal' for test cleanup functions */
  resetRedisInstance
} from './redis';
export type { RedisClientDeps, RedisConstructor, RedisCommandStats } from './redis';

export {
  RedisStreamsClient,
  StreamBatcher,
  StreamConsumer,
  getRedisStreamsClient,
  resetRedisStreamsInstance
} from './redis-streams';
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

// =============================================================================
// 1.2 Logging Infrastructure (ADR-015: Pino Logger Migration)
// =============================================================================

// Legacy logger (for backward compatibility)
export { createLogger, PerformanceLogger, getPerformanceLogger, Logger } from './logger';

// Pino-based production logging
export {
  createPinoLogger,
  getLogger,
  getPinoPerformanceLogger,
  PinoPerformanceLogger,
  resetLoggerCache,
  resetPerformanceLoggerCache,
} from './logging';

// Testing utilities (no jest.mock needed)
export {
  RecordingLogger,
  RecordingPerformanceLogger,
  NullLogger,
  createMockLoggerFactory,
} from './logging';

// Logging types
export type {
  ILogger,
  IPerformanceLogger,
  LoggerConfig,
  LogLevel,
  LogMeta,
  LogEntry,
  ServiceLogger,  // P0-FIX: Consolidated logger interface for DI
} from './logging';

// =============================================================================
// 1.3 Async Primitives
// =============================================================================

// P1-3-FIX: Standardized singleton pattern utilities
// P1-FIX: Added createConfigurableSingleton for singletons needing config on first init
export { createAsyncSingleton, createSingleton, createConfigurableSingleton, singleton } from './async/async-singleton';

// R6: Centralized Service Registry for singleton lifecycle management
export {
  ServiceRegistry,
  getServiceRegistry,
  resetServiceRegistry,
  registerService,
  getService
} from './async/service-registry';
export type {
  ServiceRegistration,
  RegisteredServiceHealth,
  RegistryHealth
} from './async/service-registry';

// P2-2 FIX: Reusable AsyncMutex utility
export {
  AsyncMutex,
  namedMutex,
  clearNamedMutex,
  clearAllNamedMutexes
} from './async/async-mutex';
export type { MutexStats } from './async/async-mutex';

// P1-5 FIX: Operation Guard (skip-if-busy pattern with rate limiting)
export {
  OperationGuard,
  tryWithGuard,
  tryWithGuardSync
} from './async/operation-guard';
export type { OperationGuardStats, OperationGuardConfig } from './async/operation-guard';

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
} from './async/async-utils';
export type {
  RetryConfig,
  Deferred
} from './async/async-utils';

// Worker Pool
export { EventProcessingWorkerPool, getWorkerPool, PriorityQueue } from './async/worker-pool';
export type { Task, TaskResult } from './async/worker-pool';

// =============================================================================
// 1.4 Service State & Lifecycle
// =============================================================================

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

// Interval Manager (centralized interval management)
export {
  IntervalManager,
  createIntervalManager
} from './interval-manager';
export type {
  IntervalInfo,
  IntervalManagerStats
} from './interval-manager';

// #############################################################################
// #                                                                           #
// #                       SECTION 2: RESILIENCE                               #
// #                                                                           #
// #############################################################################

// =============================================================================
// 2.1 Circuit Breakers
// =============================================================================

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
} from './resilience/circuit-breaker';

// Simple Circuit Breaker (lightweight failure tracking)
export {
  SimpleCircuitBreaker,
  createSimpleCircuitBreaker
} from './circuit-breaker';
export type {
  SimpleCircuitBreakerOptions,
  SimpleCircuitBreakerStatus
} from './circuit-breaker';

// =============================================================================
// 2.2 Retry & Recovery
// =============================================================================

export {
  RetryMechanism,
  RetryPresets,
  withRetry,
  retry,
  retryAdvanced,
  // P1-2 fix: Error classification utilities
  ErrorCategory,
  classifyError,
  isRetryableError,
  // R7 Consolidation: Retry with logging utility
  retryWithLogging
} from './resilience/retry-mechanism';
export type { RetryLogger, RetryWithLoggingConfig } from './resilience/retry-mechanism';

export { GracefulDegradationManager, getGracefulDegradationManager, triggerDegradation, isFeatureEnabled, getCapabilityFallback } from './resilience/graceful-degradation';

export { DeadLetterQueue, getDeadLetterQueue, enqueueFailedOperation } from './resilience/dead-letter-queue';

export { SelfHealingManager, getSelfHealingManager, registerServiceForSelfHealing } from './resilience/self-healing-manager';

export { ExpertSelfHealingManager, getExpertSelfHealingManager, FailureSeverity, RecoveryStrategy } from './resilience/expert-self-healing-manager';

export { ErrorRecoveryOrchestrator, getErrorRecoveryOrchestrator, recoverFromError, withErrorRecovery } from './resilience/error-recovery';

// =============================================================================
// 2.3 Error Handling (REF-3/ARCH-2)
// =============================================================================

// FIX 6.1: Error Class Name Disambiguation (P0-FIX: Updated for consolidation)
// ╔════════════════════════════════════════════════════════════════════════════╗
// ║ ERROR CLASS NAMING GUIDE                                                   ║
// ╠════════════════════════════════════════════════════════════════════════════╣
// ║ CANONICAL (use for new code):                                              ║
// ║   - ArbitrageError: Simple error with string code (from @arbitrage/types)  ║
// ║     Import: import { ArbitrageError } from '@arbitrage/types'              ║
// ║     Usage: new ArbitrageError(msg, code, service, retryable)               ║
// ║   - TimeoutError: Timeout errors (from @arbitrage/types)                   ║
// ║     Import: import { TimeoutError } from '@arbitrage/types'                ║
// ╠════════════════════════════════════════════════════════════════════════════╣
// ║ RICH ERRORS (for detailed error handling):                                 ║
// ║   - BaseArbitrageError: Rich error with ErrorCode enum, severity, context  ║
// ║     Import: import { BaseArbitrageError, ErrorCode } from '@arbitrage/core'║
// ║   - ConnectionError, ValidationError, LifecycleError, ExecutionError       ║
// ║     (Specialized error classes from resilience/error-handling)             ║
// ╠════════════════════════════════════════════════════════════════════════════╣
// ║ DEPRECATED (legacy, will be removed in v2.0):                              ║
// ║   - DomainArbitrageError (from domain-models.ts): Old pattern              ║
// ║     Migration: new ArbitrageError(msg, code, service) from @arbitrage/types║
// ╚════════════════════════════════════════════════════════════════════════════╝

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
  getErrorMessage,  // FIX: Export safe error message extractor
  formatErrorForLog,
  formatErrorForResponse,
  ErrorAggregator
} from './resilience/error-handling';
export type { Result } from './resilience/error-handling';

// #############################################################################
// #                                                                           #
// #                         SECTION 3: CACHING                                #
// #                                                                           #
// #############################################################################

// =============================================================================
// 3.1 Price & Data Caching
// =============================================================================

export {
  PriceMatrix,
  PriceIndexMapper,
  PriceMatrixFullError, // P0-FIX 4.3: Explicit error when capacity is full
  getPriceMatrix,
  resetPriceMatrix
} from './caching/price-matrix';
export type {
  PriceMatrixConfig,
  PriceEntry,
  MemoryUsage,
  PriceMatrixStats,
  BatchUpdate
} from './caching/price-matrix';

export { HierarchicalCache, createHierarchicalCache, getHierarchicalCache } from './caching/hierarchical-cache';
export type { CacheConfig, CacheEntry, PredictiveWarmingConfig } from './caching/hierarchical-cache';

export { SharedMemoryCache, createSharedMemoryCache, getSharedMemoryCache } from './caching/shared-memory-cache';

export { CacheCoherencyManager, createCacheCoherencyManager, getCacheCoherencyManager, resetCacheCoherencyManager } from './caching/cache-coherency-manager';

// =============================================================================
// 3.2 Pair Caching (S2.2.5)
// =============================================================================

export {
  PairCacheService,
  getPairCacheService,
  resetPairCacheService
} from './caching/pair-cache';
export type {
  PairCacheConfig,
  CachedPairData,
  PairCacheStats,
  CacheLookupResult,
  PairCacheServiceDeps
} from './caching/pair-cache';

// =============================================================================
// 3.3 Gas & Reserve Caching
// =============================================================================

// Phase 2: Gas Price Cache (ADR-012, ADR-013)
export {
  GasPriceCache,
  getGasPriceCache,
  resetGasPriceCache,
  GAS_UNITS,
  DEFAULT_TRADE_AMOUNT_USD,
  FALLBACK_GAS_COSTS_ETH,
  FALLBACK_GAS_SCALING_PER_STEP
} from './caching/gas-price-cache';
export type {
  GasPriceData,
  NativeTokenPrice,
  GasCostEstimate,
  GasPriceCacheConfig
} from './caching/gas-price-cache';

// ADR-022: Reserve Cache (Event-Driven Reserve Caching)
export {
  ReserveCache,
  createReserveCache,
  getReserveCache,
  resetReserveCache
} from './caching/reserve-cache';
export type {
  ReserveCacheConfig,
  CachedReserve,
  ReserveCacheStats
} from './caching/reserve-cache';

// #############################################################################
// #                                                                           #
// #                    SECTION 4: MONITORING & HEALTH                         #
// #                                                                           #
// #############################################################################

// =============================================================================
// 4.1 Cross-Region Health (ADR-007)
// =============================================================================

export {
  CrossRegionHealthManager,
  getCrossRegionHealthManager,
  resetCrossRegionHealthManager,
  DegradationLevel
} from './monitoring/cross-region-health';
export type {
  RegionHealth,
  RegionStatus,
  ServiceRegionHealth,
  FailoverEvent,
  CrossRegionHealthConfig,
  GlobalHealthStatus
} from './monitoring/cross-region-health';

// =============================================================================
// 4.2 Stream & System Health
// =============================================================================

export {
  EnhancedHealthMonitor,
  getEnhancedHealthMonitor,
  recordHealthMetric,
  getCurrentSystemHealth,
  // Phase 4: Memory monitoring exports
  detectDeploymentPlatform,
  getMemoryThresholds,
  PLATFORM_MEMORY_THRESHOLDS
} from './monitoring/enhanced-health-monitor';
export type {
  // Phase 4: Memory monitoring types
  DeploymentPlatform,
  MemoryThresholds
} from './monitoring/enhanced-health-monitor';

export {
  StreamHealthMonitor,
  getStreamHealthMonitor,
  resetStreamHealthMonitor
} from './monitoring/stream-health-monitor';
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
} from './monitoring/stream-health-monitor';

// =============================================================================
// 4.3 Provider Health (S3.3)
// =============================================================================

export {
  ProviderHealthScorer,
  getProviderHealthScorer,
  resetProviderHealthScorer
} from './monitoring/provider-health-scorer';
export type {
  ProviderHealthMetrics,
  ProviderHealthScorerConfig
} from './monitoring/provider-health-scorer';

// =============================================================================
// 4.4 Performance Monitoring (Task 2.3)
// =============================================================================

export {
  HotPathMonitor,
  measureHotPath,
  measureHotPathAsync,
  hotPathMonitor,
  resetHotPathMonitor,
} from './performance-monitor';
export type {
  LatencyMetric,
  LatencyStats,
} from './performance-monitor';

// #############################################################################
// #                                                                           #
// #                         SECTION 5: ANALYTICS                              #
// #                                                                           #
// #############################################################################

// =============================================================================
// 5.1 Price Analytics
// =============================================================================

// Price Oracle (replaces hardcoded prices)
export {
  PriceOracle,
  getPriceOracle,
  resetPriceOracle,
  getDefaultPrice,
  hasDefaultPrice
} from './analytics/price-oracle';
export type {
  TokenPrice,
  PriceOracleConfig,
  PriceBatchRequest
} from './analytics/price-oracle';

// T2.7: Price Momentum Detection
export {
  PriceMomentumTracker,
  MomentumSignal,
  MomentumConfig,
  PairStats,
  getPriceMomentumTracker,
  resetPriceMomentumTracker
} from './analytics/price-momentum';

// =============================================================================
// 5.2 Market Analytics
// =============================================================================

// Swap Event Filter
export {
  SwapEventFilter,
  getSwapEventFilter,
  resetSwapEventFilter
} from './analytics/swap-event-filter';
export type {
  SwapEventFilterConfig,
  FilterResult,
  FilterReason,
  VolumeAggregate,
  WhaleAlert,
  FilterStats,
  BatchResult
} from './analytics/swap-event-filter';

// T3.12: Enhanced Whale Activity Detection
export {
  WhaleActivityTracker,
  getWhaleActivityTracker,
  resetWhaleActivityTracker
} from './analytics/whale-activity-tracker';
export type {
  WhaleTrackerConfig,
  TrackedWhaleTransaction,
  WalletProfile,
  WalletPattern,
  WhaleSignal,
  WhaleActivitySummary,
  WhaleTrackerStats
} from './analytics/whale-activity-tracker';

// T3.15: Liquidity Depth Analysis
export {
  LiquidityDepthAnalyzer,
  getLiquidityDepthAnalyzer,
  resetLiquidityDepthAnalyzer
} from './analytics/liquidity-depth-analyzer';
export type {
  LiquidityDepthConfig,
  PoolLiquidity,
  LiquidityLevel,
  DepthAnalysis,
  SlippageEstimate,
  LiquidityAnalyzerStats
} from './analytics/liquidity-depth-analyzer';

// Pair Activity Tracker (Volatility-based prioritization)
export {
  PairActivityTracker,
  getPairActivityTracker,
  resetPairActivityTracker
} from './analytics/pair-activity-tracker';
export type {
  ActivityTrackerConfig,
  PairActivityMetrics,
  ActivityTrackerStats
} from './analytics/pair-activity-tracker';

// =============================================================================
// 5.3 ML & Scoring
// =============================================================================

// T2.8: ML Opportunity Scorer
// T4.3.3: Orderflow Integration with Opportunity Scoring
export {
  MLOpportunityScorer,
  getMLOpportunityScorer,
  resetMLOpportunityScorer,
  // T4.3.3: Orderflow conversion helper
  toOrderflowSignal
} from './analytics/ml-opportunity-scorer';
export type {
  MLPrediction,
  MLScorerConfig,
  OpportunityScoreInput,
  OpportunityWithMomentum,
  EnhancedScore,
  ScorerStats,
  // T4.3.3: Orderflow integration types
  OrderflowSignal,
  OpportunityWithOrderflow,
  OpportunityWithAllSignals,
  EnhancedScoreWithOrderflow,
  OrderflowPredictionInput
} from './analytics/ml-opportunity-scorer';

// Professional Quality Monitor (AD-PQS scoring)
export {
  ProfessionalQualityMonitor
} from './analytics/professional-quality-monitor';
export type {
  ProfessionalQualityScore,
  QualityMetrics,
  QualityMonitorDeps,
  QualityMonitorRedis
} from './analytics/professional-quality-monitor';

// Performance Analytics
export {
  PerformanceAnalyticsEngine,
  StrategyPerformance,
  AssetPerformance,
  TimePerformance,
  BenchmarkComparison,
  AttributionAnalysis
} from './analytics/performance-analytics';

// #############################################################################
// #                                                                           #
// #                   SECTION 6: DETECTION & ARBITRAGE                        #
// #                                                                           #
// #############################################################################

// =============================================================================
// 6.1 Base Detectors
// =============================================================================

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

// =============================================================================
// 6.2 Arbitrage Detection Components
// =============================================================================

// ArbitrageDetector - Pure detection logic
// REFACTOR: Replaces calculateIntraChainArbitrage, calculateCrossChainArbitrage
export {
  // Core detection functions
  detectArbitrage,
  detectArbitrageForTokenPair,
  calculateArbitrageProfit,
  calculateCrossChainArbitrage,

  // Token order utilities
  isReverseTokenOrder,
  normalizeTokenOrder,
  adjustPriceForTokenOrder,

  // Validation utilities
  isValidPairSnapshot,
  validateDetectionInput,
} from './components/arbitrage-detector';
export type {
  ArbitrageDetectionInput,
  ArbitrageDetectionResult,
  ArbitrageOpportunityData,
  BatchDetectionOptions,
  ChainPriceData,
  CrossChainOpportunityResult,
} from './components/arbitrage-detector';

// =============================================================================
// 6.3 Multi-Path Arbitrage
// =============================================================================

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

// =============================================================================
// 6.4 Detector Infrastructure
// =============================================================================

// Connection management extracted from base-detector for SRP
export {
  initializeDetectorConnections,
  disconnectDetectorConnections,
  DEFAULT_BATCHER_CONFIG,
  DEFAULT_SWAP_FILTER_CONFIG,
  // Phase 1.5: Pair Initialization Service
  initializePairs,
  resolvePairAddress,
  createTokenPairKey,
  buildFullPairKey,
  // R5: Health Monitor
  DetectorHealthMonitor,
  createDetectorHealthMonitor,
  // R5: Factory Integration
  FactoryIntegrationService,
  createFactoryIntegrationService,
} from './detector';
export type {
  DetectorConnectionConfig,
  DetectorConnectionResources,
  EventFilterHandlers,
  // Phase 1.5: Pair Initialization Service types
  PairInitializationConfig,
  PairInitializationResult,
  DiscoveredPairResult,
  PairAddressResolver,
  // R5: Health Monitor types
  HealthMonitorConfig,
  DetectorHealthStatus,
  HealthMonitorDeps,
  HealthMonitorRedis,
  HealthMonitorPerfLogger,
  // R5: Factory Integration types
  FactoryIntegrationConfig,
  FactoryIntegrationHandlers,
  FactoryIntegrationDeps,
  FactoryIntegrationResult,
} from './detector';

// #############################################################################
// #                                                                           #
// #                         SECTION 7: SOLANA                                 #
// #                                                                           #
// #############################################################################

// =============================================================================
// 7.1 Solana Detector (S3.3.1)
// =============================================================================

export { SolanaDetector, SOLANA_DEX_PROGRAMS } from './solana/solana-detector';
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
} from './solana/solana-detector';

// =============================================================================
// 7.2 Solana Swap Parser (S3.3.4)
// =============================================================================

export {
  SolanaSwapParser,
  getSolanaSwapParser,
  resetSolanaSwapParser,
  SOLANA_DEX_PROGRAM_IDS,
  PROGRAM_ID_TO_DEX,
  SWAP_DISCRIMINATORS,
  DISABLED_DEXES
} from './solana/solana-swap-parser';
export type {
  SolanaInstruction,
  SolanaTransaction,
  InstructionAccount,
  TokenBalance,
  ParsedSolanaSwap,
  SwapParserConfig,
  ParserStats
} from './solana/solana-swap-parser';

// =============================================================================
// 7.3 Solana Price Feed (S3.3.5)
// =============================================================================

export {
  SolanaPriceFeed,
  RAYDIUM_AMM_LAYOUT,
  RAYDIUM_CLMM_LAYOUT,
  ORCA_WHIRLPOOL_LAYOUT,
  SOLANA_DEX_PROGRAMS as SOLANA_PRICE_FEED_PROGRAMS
} from './solana/solana-price-feed';
export type {
  SolanaPriceFeedConfig,
  SolanaPriceFeedDeps,
  SolanaPriceFeedLogger,
  RaydiumAmmPoolState,
  RaydiumClmmPoolState,
  OrcaWhirlpoolState,
  SolanaPriceUpdate as SolanaPriceFeedUpdate,
  PoolSubscription,
  SupportedDex
} from './solana/solana-price-feed';

// #############################################################################
// #                                                                           #
// #                    SECTION 8: PRICE & CALCULATION                         #
// #                                                                           #
// #############################################################################

// =============================================================================
// 8.1 Price Calculator - Pure Functions
// REFACTOR: These are now the PRIMARY exports (replacing deprecated versions)
// =============================================================================

export {
  // Core price calculations - PRIMARY EXPORTS (replace deprecated versions)
  calculatePriceFromReserves,
  calculatePriceFromBigIntReserves,
  safeBigIntDivision,
  safeBigIntDivisionOrNull, // P0-FIX 4.4: Safe version that returns null instead of throwing
  invertPrice,
  calculatePriceDifferencePercent,

  // Spread and profit calculations
  calculateSpread,
  calculateSpreadSafe,
  calculateNetProfit,
  calculateProfitBetweenSources,

  // Fee utilities
  getDefaultFee,
  resolveFee,
  basisPointsToDecimal,
  decimalToBasisPoints,

  // Threshold utilities
  meetsThreshold,
  calculateConfidence,
  getMinProfitThreshold,

  // Validation utilities
  isValidPrice,
  areValidReserves,
  isValidFee,

  // Chain constants
  BLOCK_TIMES_MS,
  getBlockTimeMs,

  // Error class
  PriceCalculationError,
} from './components/price-calculator';

export type {
  ReserveInput,
  SpreadResult,
  PriceSource as PriceSourceInput,
  ProfitCalculationResult,
} from './components/price-calculator';

// =============================================================================
// 8.2 Data Structures - High-Performance for Hot-Path
// =============================================================================

export {
  CircularBuffer,
  createFifoBuffer,
  createRollingWindow,
  // FIX 10.5: MinHeap for O(n log k) partial sorting (consolidated from services)
  MinHeap,
  findKSmallest,
  findKLargest,
  // R1: LRU Cache for bounded memoization
  LRUCache,
  createLRUCache,
  // R1: Numeric Rolling Window with O(1) average
  NumericRollingWindow,
  createNumericRollingWindow,
} from './data-structures';
export type {
  CircularBufferConfig,
  CircularBufferStats,
  // R1: LRU Cache stats
  LRUCacheStats,
  // R1: Numeric Rolling Window stats
  NumericRollingWindowStats,
} from './data-structures';

// =============================================================================
// 8.3 BigInt & Numeric Utilities (FIX 9.3)
// =============================================================================

export {
  // Scale factors
  DEFAULT_SCALE,
  HIGH_PRECISION_SCALE,

  // BigInt <-> Number conversions
  fractionToBigInt,
  bigIntToFraction,
  applyFraction,
  calculateFraction,
  bigIntToNumber,
  numberToBigInt,

  // BigInt arithmetic
  bigIntMin,
  bigIntMax,
  bigIntClamp,
  bigIntAbs,

  // Formatting
  formatWeiAsEth,
} from './utils';

// #############################################################################
// #                                                                           #
// #                      SECTION 9: TOKEN & PAIR                              #
// #                                                                           #
// #############################################################################

// =============================================================================
// 9.1 Token Utilities
// REFACTOR: Replaces isSameTokenPair, isReverseOrder from arbitrage-calculator
// =============================================================================

export {
  // Address normalization
  normalizeAddress,
  addressEquals,
  isValidAddress,
  isSolanaAddress,
  getAddressChainType,

  // Token pair keys (consolidated here - single source of truth)
  getTokenPairKey,
  parseTokenPairKey,
  isSameTokenPair,

  // Token order utilities
  isReverseOrder,
  sortTokens,
  getTokenIndex,

  // Common tokens
  COMMON_TOKENS,
  NATIVE_TOKENS,
  WRAPPED_NATIVE_TOKENS,

  // Token identification
  isStablecoin,
  isWrappedNative,
  getChainFromToken,

  // Checksum utilities
  toChecksumAddress,

  // Address set operations
  createAddressSet,
  addressInSet,
  intersectAddresses,
} from './components/token-utils';

// =============================================================================
// 9.2 Pair Repository & Discovery
// =============================================================================

// PairRepository - In-memory storage with O(1) lookups
export {
  PairRepository,
  createPairRepository,
} from './components/pair-repository';
export type {
  PairSnapshot as ComponentPairSnapshot,
  ExtendedPair as ComponentExtendedPair,
  SnapshotOptions,
  RepositoryStats,
  PairChangeCallback,
} from './components/pair-repository';

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

// #############################################################################
// #                                                                           #
// #                       SECTION 10: DEX ADAPTERS                            #
// #                                                                           #
// #############################################################################

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

// #############################################################################
// #                                                                           #
// #                 SECTION 11: BLOCKCHAIN INFRASTRUCTURE                     #
// #                                                                           #
// #############################################################################

// =============================================================================
// 11.1 WebSocket & Event Handling
// =============================================================================

export { EventBatcher, BatchedEvent, createEventBatcher, getDefaultEventBatcher, resetDefaultEventBatcher } from './event-batcher';

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

// Factory Subscription Service (Phase 2.1.2)
// Factory-level event subscriptions for 40-50x RPC reduction
export {
  FactorySubscriptionService,
  createFactorySubscriptionService,
  getFactoryEventSignature,
  parseV2PairCreatedEvent,
  parseV3PoolCreatedEvent,
  parseSolidlyPairCreatedEvent,
  parseAlgebraPoolCreatedEvent,
  parseTraderJoePairCreatedEvent,
  FactoryEventSignatures,
  AdditionalEventSignatures,
} from './factory-subscription';
export type {
  FactorySubscriptionConfig,
  FactorySubscriptionStats,
  FactorySubscriptionLogger,
  FactoryWebSocketManager,
  FactorySubscriptionDeps,
  PairCreatedEvent,
  PairCreatedCallback,
} from './factory-subscription';

// =============================================================================
// 11.2 Transaction Management
// =============================================================================

// P0-2 FIX: Nonce Manager for Transaction Sequencing
// CRITICAL-4 FIX: Added getNonceManagerAsync for race-safe initialization
export {
  NonceManager,
  getNonceManager,
  getNonceManagerAsync,
  resetNonceManager
} from './nonce-manager';
export type { NonceManagerConfig } from './nonce-manager';

// =============================================================================
// 11.3 RPC & Provider Infrastructure
// =============================================================================

// Phase 3: RPC Request Batching
// @see RPC_DATA_OPTIMIZATION_IMPLEMENTATION_PLAN.md Phase 3
export {
  BatchProvider,
  createBatchProvider,
  BATCHABLE_METHODS,
  NON_BATCHABLE_METHODS
} from './rpc';
export type {
  BatchProviderConfig,
  BatchProviderStats,
  JsonRpcRequest,
  JsonRpcResponse
} from './rpc';

// =============================================================================
// 11.4 MEV Protection (Phase 2: ADR-013)
// =============================================================================

export {
  MevProviderFactory,
  FlashbotsProvider,
  L2SequencerProvider,
  StandardProvider,
  createFlashbotsProvider,
  createL2SequencerProvider,
  createStandardProvider,
  createMevProvider,
  hasMevProtection,
  getRecommendedPriorityFee,
  isL2SequencerChain,
  getL2ChainConfig,
  CHAIN_MEV_STRATEGIES,
  MEV_DEFAULTS
} from './mev-protection';
export type {
  IMevProvider,
  MevStrategy,
  MevSubmissionResult,
  MevProviderConfig,
  FlashbotsBundle,
  BundleSimulationResult,
  MevMetrics,
  MevGlobalConfig,
  ChainWalletConfig
} from './mev-protection';

// =============================================================================
// 11.5 Cross-Chain Bridge Router (Phase 3: ADR-014)
// =============================================================================

export {
  StargateRouter,
  createStargateRouter,
  BridgeRouterFactory,
  createBridgeRouterFactory,
  BRIDGE_DEFAULTS,
  STARGATE_CHAIN_IDS,
  STARGATE_POOL_IDS,
  STARGATE_ROUTER_ADDRESSES,
  BRIDGE_TIMES
} from './bridge-router';
export type {
  BridgeProtocol,
  BridgeStatus,
  BridgeChainConfig,
  BridgeTokenConfig,
  BridgeQuoteRequest,
  BridgeQuote,
  BridgeExecuteRequest,
  BridgeExecuteResult,
  BridgeStatusResult,
  IBridgeRouter,
  CrossChainExecutionPlan,
  CrossChainExecutionResult,
  BridgeRouterFactoryConfig
} from './bridge-router';

// #############################################################################
// #                                                                           #
// #                    SECTION 12: PARTITION SERVICES                         #
// #                                                                           #
// #############################################################################

// =============================================================================
// 12.1 Partition Service Utilities (P12-P16 refactor)
// =============================================================================

export {
  parsePort,
  validateAndFilterChains,
  createPartitionHealthServer,
  shutdownPartitionService,
  setupDetectorEventHandlers,
  setupProcessHandlers,
  exitWithConfigError,
  closeServerWithTimeout,
  SHUTDOWN_TIMEOUT_MS,
  HEALTH_SERVER_CLOSE_TIMEOUT_MS,
  // Typed environment config utilities (standardized across P1-P4)
  parsePartitionEnvironmentConfig,
  validatePartitionEnvironmentConfig,
  generateInstanceId,
  // R9: Partition Service Runner Factory
  createPartitionServiceRunner,
  runPartitionService
} from './partition-service-utils';
export type {
  PartitionServiceConfig,
  HealthServerOptions,
  PartitionDetectorInterface,
  ProcessHandlerCleanup,
  // Typed environment config type
  PartitionEnvironmentConfig,
  // R9: Partition Service Runner types
  ServiceLifecycleState,
  PartitionServiceRunnerOptions,
  PartitionServiceRunner
} from './partition-service-utils';

// =============================================================================
// 12.2 Partition Router (S3.1.7 - Detector Migration)
// =============================================================================

export {
  PartitionRouter,
  createDeprecationWarning,
  isDeprecatedPattern,
  getMigrationRecommendation,
  warnIfDeprecated,
  // P1-1/P1-2-FIX: Export constants as single source of truth
  PARTITION_PORTS,
  PARTITION_SERVICE_NAMES,
  // P3-FIX: All service ports centralized
  SERVICE_PORTS
} from './partition-router';
export type { PartitionEndpoint } from './partition-router';

// Publishing Service (centralized message publishing)
export {
  PublishingService,
  createPublishingService,
  STANDARD_BATCHER_CONFIGS
} from './publishing';
export type {
  PublishableMessageType,
  PublishingBatcherConfig,
  PublishingServiceDeps,
  PublishingBatchers
} from './publishing';

// #############################################################################
// #                                                                           #
// #                      SECTION 13: RISK MANAGEMENT                          #
// #                    (Phase 3: Capital & Risk Controls)                     #
// #                                                                           #
// #############################################################################

// Task 3.4.1: Execution Probability Tracker
export {
  ExecutionProbabilityTracker,
  getExecutionProbabilityTracker,
  resetExecutionProbabilityTracker,
} from './risk';

// Task 3.4.2: EV Calculator
export {
  EVCalculator,
  getEVCalculator,
  resetEVCalculator,
} from './risk';

// Task 3.4.3: Position Sizer (Kelly Criterion)
export {
  KellyPositionSizer,
  getKellyPositionSizer,
  resetKellyPositionSizer,
} from './risk';

// Task 3.4.4: Drawdown Circuit Breaker
export {
  DrawdownCircuitBreaker,
  getDrawdownCircuitBreaker,
  resetDrawdownCircuitBreaker,
} from './risk';

export type {
  // Execution Probability Tracker (Task 3.4.1)
  ExecutionProbabilityConfig,
  ExecutionOutcome,
  SerializedOutcome,
  ProbabilityQueryParams,
  ProfitQueryParams,
  GasCostQueryParams,
  ProbabilityResult,
  ProfitResult,
  GasCostResult,
  ExecutionTrackerStats,
  HourlyStats,

  // EV Calculator (Task 3.4.2)
  EVConfig,
  EVInput,
  EVCalculation,
  EVCalculatorStats,

  // Position Sizer (Task 3.4.3)
  PositionSizerConfig,
  PositionSize,
  PositionSizeInput,
  PositionSizerStats,

  // Drawdown Circuit Breaker (Task 3.4.4)
  DrawdownConfig,
  DrawdownState,
  DrawdownStateType,
  DrawdownStats,
  TradingAllowedResult,
  TradeResult,
} from './risk';

// #############################################################################
// #                                                                           #
// #                        SECTION 14: UTILITIES                              #
// #                                                                           #
// #############################################################################

// =============================================================================
// 14.1 Common Validators (Lightweight validation utilities)
// =============================================================================

export {
  // Type guards
  isDefined,
  isNonEmptyString,
  isPositiveNumber,
  isNonNegativeNumber,
  isFiniteNumber,
  isInteger,
  isPositiveInteger,
  isNonEmptyArray,
  isPlainObject,
  hasKey,
  // Validation functions (throw on failure)
  validateNonEmptyString,
  validatePositiveNumber,
  validateNonNegativeNumber,
  validatePositiveInteger,
  validateInRange,
  // Safe parsing functions
  parseNumberSafe,
  parseIntegerSafe,
  parseBooleanSafe,
  // Address validators (lightweight)
  looksLikeEthereumAddress,
  looksLikeSolanaAddress,
  // Assertion helpers
  assert,
  assertDefined,
} from './utils/common-validators';

// =============================================================================
// 14.2 Performance Utilities
// =============================================================================

export {
  // WeakMap-based object cache
  createObjectCache,
  // Memoization
  memoize,
  memoizeAsync,
  // Batch processing
  processBatches,
  processWithRateLimit,
  // Fast lookup structures
  createFastLookupSet,
  createFastLookupMap,
  // Object pooling
  createObjectPool,
  // Lazy initialization
  lazy,
  lazyAsync,
} from './utils/performance-utils';

// =============================================================================
// 14.3 Validation Middleware
// =============================================================================

export {
  ValidationMiddleware,
  ValidationSchemas
} from './validation';

// =============================================================================
// 14.4 Simulation Mode (Local Testing)
// =============================================================================

export {
  PriceSimulator,
  getSimulator,
  isSimulationMode,
  SIMULATION_CONFIG,
  // Chain-specific simulators for detector integration
  ChainSimulator,
  getChainSimulator,
  stopChainSimulator,
  stopAllChainSimulators,
  resetSimulatorInstance
} from './simulation-mode';
export type {
  SimulatedPriceUpdate,
  SimulationConfig,
  // Chain simulator types
  SimulatedSyncEvent,
  SimulatedOpportunity,
  ChainSimulatorConfig,
  SimulatedPairConfig
} from './simulation-mode';

// #############################################################################
// #                                                                           #
// #                    SECTION 15: DOMAIN MODELS & TYPES                      #
// #                                                                           #
// #############################################################################

// =============================================================================
// 15.1 Domain Models
// =============================================================================

export * from './domain-models';

// =============================================================================
// 15.2 Repositories
// =============================================================================

export {
  RedisArbitrageRepository,
  RedisExecutionRepository,
  createArbitrageRepository,
  createExecutionRepository
} from './repositories';

// =============================================================================
// 15.3 Message Validators (REF-2)
// =============================================================================

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

// =============================================================================
// 15.4 Re-exported Types (from @arbitrage/types)
// =============================================================================

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

// #############################################################################
// #                                                                           #
// #             SECTION 16: DEPRECATED & INTERNAL API RE-EXPORTS              #
// #                                                                           #
// #############################################################################

// =============================================================================
// REF-1/ARCH-1: DEPRECATED arbitrage-calculator.ts exports
// REFACTOR: Most functions have been migrated to components/price-calculator
// and components/arbitrage-detector. Only keeping legacy exports that don't
// have direct replacements yet.
//
// MIGRATION GUIDE:
// - calculatePriceFromReserves → components/price-calculator (DONE)
// - calculatePriceFromBigIntReserves → components/price-calculator (DONE)
// - safeBigIntDivision → components/price-calculator (DONE)
// - invertPrice → components/price-calculator (DONE)
// - calculatePriceDifferencePercent → components/price-calculator (DONE)
// - getDefaultFee → components/price-calculator (DONE)
// - getMinProfitThreshold → components/price-calculator (DONE)
// - isSameTokenPair → components/token-utils (DONE)
// - isReverseOrder → components/token-utils (DONE)
// - calculateCrossChainArbitrage → components/arbitrage-detector (DONE)
// - validatePairSnapshot → components/arbitrage-detector as isValidPairSnapshot
// - createPairSnapshot → components/pair-repository as PairRepository.createSnapshot()
// - calculateIntraChainArbitrage → components/arbitrage-detector as detectArbitrage
// =============================================================================
// REMOVED: Deprecated exports from arbitrage-calculator.ts
// The following have been migrated to components/:
// - calculateIntraChainArbitrage → Use SimpleArbitrageDetector from unified-detector
// - validatePairSnapshot → Use local validation in SnapshotManager
// - createPairSnapshot → Use SnapshotManager.createPairSnapshot()
// - PairSnapshot type → Use PairSnapshot from simple-arbitrage-detector
// - PriceComparisonResult type → Use SpreadResult from price-calculator
// - ArbitrageCalcConfig type → Use detection config in services
// =============================================================================

// REMOVED: ArbitrageService and EnterpriseConfigManager (unused, cleaned up)
// DEPRECATED: AdvancedArbitrageOrchestrator removed per ADR-002
// The orchestrator used Pub/Sub which violates ADR-002 (Redis Streams required)
// Use the coordinator service pattern with Redis Streams instead
// See: services/coordinator/src/coordinator.ts

// REMOVED: MatrixPriceCache and PredictiveCacheWarmer (unused modules cleaned up)
// REMOVED: ABTestingFramework (unused module cleaned up)
// REMOVED: Other professional-grade modules (unused, cleaned up):
// - AdvancedStatisticalArbitrage
// - RiskManagementEngine
// - EnterpriseTestingFramework
// - EnterpriseConfigurationManager

/**
 * Internal API Re-exports
 *
 * These exports are provided for backward compatibility. For new code, prefer
 * importing directly from '@arbitrage/core/internal' to make the internal
 * nature explicit:
 *
 * ```typescript
 * // Preferred: explicit internal import
 * import { resetRedisInstance, RecordingLogger } from '@arbitrage/core/internal';
 *
 * // Backward compatible: still works
 * import { resetRedisInstance, RecordingLogger } from '@arbitrage/core';
 * ```
 *
 * @see internal/index.ts for the full list of internal exports
 */
export * from './internal';

/**
 * Deprecated API Re-exports
 *
 * These exports are provided for backward compatibility. They will be removed
 * in v2.0.0. Import from '@arbitrage/core/deprecated' for migration guidance:
 *
 * ```typescript
 * // Explicit deprecated import (recommended during migration)
 * import { calculateIntraChainArbitrage } from '@arbitrage/core/deprecated';
 * ```
 *
 * @see deprecated/index.ts for migration documentation
 * @deprecated Will be removed in v2.0.0
 */
export * from './deprecated';
