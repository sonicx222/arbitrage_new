"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCacheCoherencyManager = exports.createCacheCoherencyManager = exports.CacheCoherencyManager = exports.getSharedMemoryCache = exports.createSharedMemoryCache = exports.SharedMemoryCache = exports.getHierarchicalCache = exports.createHierarchicalCache = exports.HierarchicalCache = exports.resetProviderHealthScorer = exports.getProviderHealthScorer = exports.ProviderHealthScorer = exports.WebSocketManager = exports.getDefaultEventBatcher = exports.createEventBatcher = exports.EventBatcher = exports.PriorityQueue = exports.getWorkerPool = exports.EventProcessingWorkerPool = exports.getPerformanceLogger = exports.PerformanceLogger = exports.createLogger = exports.hasDefaultPrice = exports.getDefaultPrice = exports.resetPriceOracle = exports.getPriceOracle = exports.PriceOracle = exports.isServiceState = exports.createServiceState = exports.ServiceState = exports.ServiceStateManager = exports.resetDistributedLockManager = exports.getDistributedLockManager = exports.DistributedLockManager = exports.resetRedisStreamsInstance = exports.getRedisStreamsClient = exports.StreamConsumer = exports.StreamBatcher = exports.RedisStreamsClient = exports.clearAllNamedMutexes = exports.clearNamedMutex = exports.namedMutex = exports.AsyncMutex = exports.singleton = exports.createSingleton = exports.createAsyncSingleton = exports.resetRedisInstance = exports.getRedisClient = exports.RedisOperationError = exports.RedisClient = void 0;
exports.WhaleActivityTracker = exports.resetSwapEventFilter = exports.getSwapEventFilter = exports.SwapEventFilter = exports.resetStreamHealthMonitor = exports.getStreamHealthMonitor = exports.StreamHealthMonitor = exports.getCurrentSystemHealth = exports.recordHealthMetric = exports.getEnhancedHealthMonitor = exports.EnhancedHealthMonitor = exports.withErrorRecovery = exports.recoverFromError = exports.getErrorRecoveryOrchestrator = exports.ErrorRecoveryOrchestrator = exports.RecoveryStrategy = exports.FailureSeverity = exports.getExpertSelfHealingManager = exports.ExpertSelfHealingManager = exports.registerServiceForSelfHealing = exports.getSelfHealingManager = exports.SelfHealingManager = exports.enqueueFailedOperation = exports.getDeadLetterQueue = exports.DeadLetterQueue = exports.DegradationLevel = exports.resetCrossRegionHealthManager = exports.getCrossRegionHealthManager = exports.CrossRegionHealthManager = exports.getCapabilityFallback = exports.isFeatureEnabled = exports.triggerDegradation = exports.getGracefulDegradationManager = exports.GracefulDegradationManager = exports.isRetryableError = exports.classifyError = exports.ErrorCategory = exports.retryAdvanced = exports.retry = exports.withRetry = exports.RetryPresets = exports.RetryMechanism = exports.withCircuitBreaker = exports.getCircuitBreakerRegistry = exports.createCircuitBreaker = exports.CircuitBreakerRegistry = exports.CircuitState = exports.CircuitBreakerError = exports.CircuitBreaker = exports.resetCacheCoherencyManager = void 0;
exports.BaseDetector = exports.createExecutionRepository = exports.createArbitrageRepository = exports.RedisExecutionRepository = exports.RedisArbitrageRepository = exports.resetMLOpportunityScorer = exports.getMLOpportunityScorer = exports.MLOpportunityScorer = exports.resetPriceMomentumTracker = exports.getPriceMomentumTracker = exports.PriceMomentumTracker = exports.ValidationSchemas = exports.ValidationMiddleware = exports.resetMultiLegPathFinder = exports.getMultiLegPathFinder = exports.MultiLegPathFinder = exports.CrossDexTriangularArbitrage = exports.PerformanceAnalyticsEngine = exports.adapterFailure = exports.adapterSuccess = exports.SUBGRAPH_URLS = exports.PLATYPUS_POOL_ABI = exports.PLATYPUS_ADDRESSES = exports.GMX_READER_ABI = exports.GMX_VAULT_ABI = exports.GMX_ADDRESSES = exports.BALANCER_VAULT_ABI = exports.BALANCER_VAULT_ADDRESSES = exports.resetAdapterRegistry = exports.getAdapterRegistry = exports.AdapterRegistry = exports.PlatypusAdapter = exports.GmxAdapter = exports.BalancerV2Adapter = exports.ProfessionalQualityMonitor = exports.resetPairCacheService = exports.getPairCacheService = exports.PairCacheService = exports.resetPairDiscoveryService = exports.getPairDiscoveryService = exports.PairDiscoveryService = exports.resetPriceMatrix = exports.getPriceMatrix = exports.PriceIndexMapper = exports.PriceMatrix = exports.resetLiquidityDepthAnalyzer = exports.getLiquidityDepthAnalyzer = exports.LiquidityDepthAnalyzer = exports.resetWhaleActivityTracker = exports.getWhaleActivityTracker = void 0;
exports.tryCatchSync = exports.tryCatch = exports.failure = exports.success = exports.ErrorSeverity = exports.ErrorCode = exports.ExecutionError = exports.LifecycleError = exports.SharedValidationError = exports.ConnectionError = exports.BaseArbitrageError = exports.createCoordinatorCommand = exports.createWhaleTransaction = exports.createPriceUpdate = exports.validateBatch = exports.validateMessage = exports.validateServiceHealthStatus = exports.validateCoordinatorCommand = exports.validateReserveUpdate = exports.validateSwapEvent = exports.validateWhaleTransaction = exports.validatePriceUpdate = exports.createPairSnapshot = exports.validatePairSnapshot = exports.calculateCrossChainArbitrage = exports.calculateIntraChainArbitrage = exports.getDefaultFee = exports.getMinProfitThreshold = exports.isReverseOrder = exports.isSameTokenPair = exports.calculatePriceDifferencePercent = exports.invertPrice = exports.calculatePriceFromBigIntReserves = exports.calculatePriceFromReserves = exports.safeBigIntDivision = exports.SOLANA_PRICE_FEED_PROGRAMS = exports.ORCA_WHIRLPOOL_LAYOUT = exports.RAYDIUM_CLMM_LAYOUT = exports.RAYDIUM_AMM_LAYOUT = exports.SolanaPriceFeed = exports.DISABLED_DEXES = exports.SWAP_DISCRIMINATORS = exports.PROGRAM_ID_TO_DEX = exports.SOLANA_DEX_PROGRAM_IDS = exports.resetSolanaSwapParser = exports.getSolanaSwapParser = exports.SolanaSwapParser = exports.SOLANA_DEX_PROGRAMS = exports.SolanaDetector = exports.PartitionedDetector = void 0;
exports.FALLBACK_GAS_SCALING_PER_STEP = exports.FALLBACK_GAS_COSTS_ETH = exports.DEFAULT_TRADE_AMOUNT_USD = exports.GAS_UNITS = exports.resetGasPriceCache = exports.getGasPriceCache = exports.GasPriceCache = exports.resetNonceManager = exports.getNonceManagerAsync = exports.getNonceManager = exports.NonceManager = exports.SIMULATION_CONFIG = exports.isSimulationMode = exports.getSimulator = exports.PriceSimulator = exports.PARTITION_SERVICE_NAMES = exports.PARTITION_PORTS = exports.warnIfDeprecated = exports.getMigrationRecommendation = exports.isDeprecatedPattern = exports.createDeprecationWarning = exports.PartitionRouter = exports.SHUTDOWN_TIMEOUT_MS = exports.setupProcessHandlers = exports.setupDetectorEventHandlers = exports.shutdownPartitionService = exports.createPartitionHealthServer = exports.validateAndFilterChains = exports.parsePort = exports.waitWithTimeouts = exports.gracefulShutdown = exports.throttleAsync = exports.debounceAsync = exports.mapSequential = exports.mapConcurrent = exports.createDeferred = exports.sleep = exports.withRetryAsync = exports.withTimeoutSafe = exports.withTimeoutDefault = exports.withTimeout = exports.TimeoutError = exports.ErrorAggregator = exports.formatErrorForResponse = exports.formatErrorForLog = exports.getErrorSeverity = exports.isCriticalError = exports.isRetryableErrorCheck = void 0;
// Core utilities exports
var redis_1 = require("./redis");
Object.defineProperty(exports, "RedisClient", { enumerable: true, get: function () { return redis_1.RedisClient; } });
Object.defineProperty(exports, "RedisOperationError", { enumerable: true, get: function () { return redis_1.RedisOperationError; } });
Object.defineProperty(exports, "getRedisClient", { enumerable: true, get: function () { return redis_1.getRedisClient; } });
Object.defineProperty(exports, "resetRedisInstance", { enumerable: true, get: function () { return redis_1.resetRedisInstance; } });
// P1-3-FIX: Standardized singleton pattern utilities
var async_singleton_1 = require("./async-singleton");
Object.defineProperty(exports, "createAsyncSingleton", { enumerable: true, get: function () { return async_singleton_1.createAsyncSingleton; } });
Object.defineProperty(exports, "createSingleton", { enumerable: true, get: function () { return async_singleton_1.createSingleton; } });
Object.defineProperty(exports, "singleton", { enumerable: true, get: function () { return async_singleton_1.singleton; } });
// P2-2 FIX: Reusable AsyncMutex utility
var async_mutex_1 = require("./async-mutex");
Object.defineProperty(exports, "AsyncMutex", { enumerable: true, get: function () { return async_mutex_1.AsyncMutex; } });
Object.defineProperty(exports, "namedMutex", { enumerable: true, get: function () { return async_mutex_1.namedMutex; } });
Object.defineProperty(exports, "clearNamedMutex", { enumerable: true, get: function () { return async_mutex_1.clearNamedMutex; } });
Object.defineProperty(exports, "clearAllNamedMutexes", { enumerable: true, get: function () { return async_mutex_1.clearAllNamedMutexes; } });
var redis_streams_1 = require("./redis-streams");
Object.defineProperty(exports, "RedisStreamsClient", { enumerable: true, get: function () { return redis_streams_1.RedisStreamsClient; } });
Object.defineProperty(exports, "StreamBatcher", { enumerable: true, get: function () { return redis_streams_1.StreamBatcher; } });
Object.defineProperty(exports, "StreamConsumer", { enumerable: true, get: function () { return redis_streams_1.StreamConsumer; } });
Object.defineProperty(exports, "getRedisStreamsClient", { enumerable: true, get: function () { return redis_streams_1.getRedisStreamsClient; } });
Object.defineProperty(exports, "resetRedisStreamsInstance", { enumerable: true, get: function () { return redis_streams_1.resetRedisStreamsInstance; } });
// Distributed Lock Manager (ADR-007)
var distributed_lock_1 = require("./distributed-lock");
Object.defineProperty(exports, "DistributedLockManager", { enumerable: true, get: function () { return distributed_lock_1.DistributedLockManager; } });
Object.defineProperty(exports, "getDistributedLockManager", { enumerable: true, get: function () { return distributed_lock_1.getDistributedLockManager; } });
Object.defineProperty(exports, "resetDistributedLockManager", { enumerable: true, get: function () { return distributed_lock_1.resetDistributedLockManager; } });
// Service State Machine (lifecycle management)
var service_state_1 = require("./service-state");
Object.defineProperty(exports, "ServiceStateManager", { enumerable: true, get: function () { return service_state_1.ServiceStateManager; } });
Object.defineProperty(exports, "ServiceState", { enumerable: true, get: function () { return service_state_1.ServiceState; } });
Object.defineProperty(exports, "createServiceState", { enumerable: true, get: function () { return service_state_1.createServiceState; } });
Object.defineProperty(exports, "isServiceState", { enumerable: true, get: function () { return service_state_1.isServiceState; } });
// Price Oracle (replaces hardcoded prices)
var price_oracle_1 = require("./price-oracle");
Object.defineProperty(exports, "PriceOracle", { enumerable: true, get: function () { return price_oracle_1.PriceOracle; } });
Object.defineProperty(exports, "getPriceOracle", { enumerable: true, get: function () { return price_oracle_1.getPriceOracle; } });
Object.defineProperty(exports, "resetPriceOracle", { enumerable: true, get: function () { return price_oracle_1.resetPriceOracle; } });
Object.defineProperty(exports, "getDefaultPrice", { enumerable: true, get: function () { return price_oracle_1.getDefaultPrice; } });
Object.defineProperty(exports, "hasDefaultPrice", { enumerable: true, get: function () { return price_oracle_1.hasDefaultPrice; } });
var logger_1 = require("./logger");
Object.defineProperty(exports, "createLogger", { enumerable: true, get: function () { return logger_1.createLogger; } });
Object.defineProperty(exports, "PerformanceLogger", { enumerable: true, get: function () { return logger_1.PerformanceLogger; } });
Object.defineProperty(exports, "getPerformanceLogger", { enumerable: true, get: function () { return logger_1.getPerformanceLogger; } });
// REMOVED: MatrixPriceCache and PredictiveCacheWarmer (unused modules cleaned up)
var worker_pool_1 = require("./worker-pool");
Object.defineProperty(exports, "EventProcessingWorkerPool", { enumerable: true, get: function () { return worker_pool_1.EventProcessingWorkerPool; } });
Object.defineProperty(exports, "getWorkerPool", { enumerable: true, get: function () { return worker_pool_1.getWorkerPool; } });
Object.defineProperty(exports, "PriorityQueue", { enumerable: true, get: function () { return worker_pool_1.PriorityQueue; } });
var event_batcher_1 = require("./event-batcher");
Object.defineProperty(exports, "EventBatcher", { enumerable: true, get: function () { return event_batcher_1.EventBatcher; } });
Object.defineProperty(exports, "createEventBatcher", { enumerable: true, get: function () { return event_batcher_1.createEventBatcher; } });
Object.defineProperty(exports, "getDefaultEventBatcher", { enumerable: true, get: function () { return event_batcher_1.getDefaultEventBatcher; } });
var websocket_manager_1 = require("./websocket-manager");
Object.defineProperty(exports, "WebSocketManager", { enumerable: true, get: function () { return websocket_manager_1.WebSocketManager; } });
// S3.3: Provider Health Scoring for intelligent fallback selection
var provider_health_scorer_1 = require("./provider-health-scorer");
Object.defineProperty(exports, "ProviderHealthScorer", { enumerable: true, get: function () { return provider_health_scorer_1.ProviderHealthScorer; } });
Object.defineProperty(exports, "getProviderHealthScorer", { enumerable: true, get: function () { return provider_health_scorer_1.getProviderHealthScorer; } });
Object.defineProperty(exports, "resetProviderHealthScorer", { enumerable: true, get: function () { return provider_health_scorer_1.resetProviderHealthScorer; } });
var hierarchical_cache_1 = require("./hierarchical-cache");
Object.defineProperty(exports, "HierarchicalCache", { enumerable: true, get: function () { return hierarchical_cache_1.HierarchicalCache; } });
Object.defineProperty(exports, "createHierarchicalCache", { enumerable: true, get: function () { return hierarchical_cache_1.createHierarchicalCache; } });
Object.defineProperty(exports, "getHierarchicalCache", { enumerable: true, get: function () { return hierarchical_cache_1.getHierarchicalCache; } });
var shared_memory_cache_1 = require("./shared-memory-cache");
Object.defineProperty(exports, "SharedMemoryCache", { enumerable: true, get: function () { return shared_memory_cache_1.SharedMemoryCache; } });
Object.defineProperty(exports, "createSharedMemoryCache", { enumerable: true, get: function () { return shared_memory_cache_1.createSharedMemoryCache; } });
Object.defineProperty(exports, "getSharedMemoryCache", { enumerable: true, get: function () { return shared_memory_cache_1.getSharedMemoryCache; } });
var cache_coherency_manager_1 = require("./cache-coherency-manager");
Object.defineProperty(exports, "CacheCoherencyManager", { enumerable: true, get: function () { return cache_coherency_manager_1.CacheCoherencyManager; } });
Object.defineProperty(exports, "createCacheCoherencyManager", { enumerable: true, get: function () { return cache_coherency_manager_1.createCacheCoherencyManager; } });
Object.defineProperty(exports, "getCacheCoherencyManager", { enumerable: true, get: function () { return cache_coherency_manager_1.getCacheCoherencyManager; } });
Object.defineProperty(exports, "resetCacheCoherencyManager", { enumerable: true, get: function () { return cache_coherency_manager_1.resetCacheCoherencyManager; } });
// REMOVED: ABTestingFramework (unused module cleaned up)
var circuit_breaker_1 = require("./circuit-breaker");
Object.defineProperty(exports, "CircuitBreaker", { enumerable: true, get: function () { return circuit_breaker_1.CircuitBreaker; } });
Object.defineProperty(exports, "CircuitBreakerError", { enumerable: true, get: function () { return circuit_breaker_1.CircuitBreakerError; } });
Object.defineProperty(exports, "CircuitState", { enumerable: true, get: function () { return circuit_breaker_1.CircuitState; } });
Object.defineProperty(exports, "CircuitBreakerRegistry", { enumerable: true, get: function () { return circuit_breaker_1.CircuitBreakerRegistry; } });
Object.defineProperty(exports, "createCircuitBreaker", { enumerable: true, get: function () { return circuit_breaker_1.createCircuitBreaker; } });
Object.defineProperty(exports, "getCircuitBreakerRegistry", { enumerable: true, get: function () { return circuit_breaker_1.getCircuitBreakerRegistry; } });
Object.defineProperty(exports, "withCircuitBreaker", { enumerable: true, get: function () { return circuit_breaker_1.withCircuitBreaker; } });
var retry_mechanism_1 = require("./retry-mechanism");
Object.defineProperty(exports, "RetryMechanism", { enumerable: true, get: function () { return retry_mechanism_1.RetryMechanism; } });
Object.defineProperty(exports, "RetryPresets", { enumerable: true, get: function () { return retry_mechanism_1.RetryPresets; } });
Object.defineProperty(exports, "withRetry", { enumerable: true, get: function () { return retry_mechanism_1.withRetry; } });
Object.defineProperty(exports, "retry", { enumerable: true, get: function () { return retry_mechanism_1.retry; } });
Object.defineProperty(exports, "retryAdvanced", { enumerable: true, get: function () { return retry_mechanism_1.retryAdvanced; } });
// P1-2 fix: Error classification utilities
Object.defineProperty(exports, "ErrorCategory", { enumerable: true, get: function () { return retry_mechanism_1.ErrorCategory; } });
Object.defineProperty(exports, "classifyError", { enumerable: true, get: function () { return retry_mechanism_1.classifyError; } });
Object.defineProperty(exports, "isRetryableError", { enumerable: true, get: function () { return retry_mechanism_1.isRetryableError; } });
var graceful_degradation_1 = require("./graceful-degradation");
Object.defineProperty(exports, "GracefulDegradationManager", { enumerable: true, get: function () { return graceful_degradation_1.GracefulDegradationManager; } });
Object.defineProperty(exports, "getGracefulDegradationManager", { enumerable: true, get: function () { return graceful_degradation_1.getGracefulDegradationManager; } });
Object.defineProperty(exports, "triggerDegradation", { enumerable: true, get: function () { return graceful_degradation_1.triggerDegradation; } });
Object.defineProperty(exports, "isFeatureEnabled", { enumerable: true, get: function () { return graceful_degradation_1.isFeatureEnabled; } });
Object.defineProperty(exports, "getCapabilityFallback", { enumerable: true, get: function () { return graceful_degradation_1.getCapabilityFallback; } });
// Cross-Region Health (ADR-007)
var cross_region_health_1 = require("./cross-region-health");
Object.defineProperty(exports, "CrossRegionHealthManager", { enumerable: true, get: function () { return cross_region_health_1.CrossRegionHealthManager; } });
Object.defineProperty(exports, "getCrossRegionHealthManager", { enumerable: true, get: function () { return cross_region_health_1.getCrossRegionHealthManager; } });
Object.defineProperty(exports, "resetCrossRegionHealthManager", { enumerable: true, get: function () { return cross_region_health_1.resetCrossRegionHealthManager; } });
Object.defineProperty(exports, "DegradationLevel", { enumerable: true, get: function () { return cross_region_health_1.DegradationLevel; } });
var dead_letter_queue_1 = require("./dead-letter-queue");
Object.defineProperty(exports, "DeadLetterQueue", { enumerable: true, get: function () { return dead_letter_queue_1.DeadLetterQueue; } });
Object.defineProperty(exports, "getDeadLetterQueue", { enumerable: true, get: function () { return dead_letter_queue_1.getDeadLetterQueue; } });
Object.defineProperty(exports, "enqueueFailedOperation", { enumerable: true, get: function () { return dead_letter_queue_1.enqueueFailedOperation; } });
var self_healing_manager_1 = require("./self-healing-manager");
Object.defineProperty(exports, "SelfHealingManager", { enumerable: true, get: function () { return self_healing_manager_1.SelfHealingManager; } });
Object.defineProperty(exports, "getSelfHealingManager", { enumerable: true, get: function () { return self_healing_manager_1.getSelfHealingManager; } });
Object.defineProperty(exports, "registerServiceForSelfHealing", { enumerable: true, get: function () { return self_healing_manager_1.registerServiceForSelfHealing; } });
var expert_self_healing_manager_1 = require("./expert-self-healing-manager");
Object.defineProperty(exports, "ExpertSelfHealingManager", { enumerable: true, get: function () { return expert_self_healing_manager_1.ExpertSelfHealingManager; } });
Object.defineProperty(exports, "getExpertSelfHealingManager", { enumerable: true, get: function () { return expert_self_healing_manager_1.getExpertSelfHealingManager; } });
Object.defineProperty(exports, "FailureSeverity", { enumerable: true, get: function () { return expert_self_healing_manager_1.FailureSeverity; } });
Object.defineProperty(exports, "RecoveryStrategy", { enumerable: true, get: function () { return expert_self_healing_manager_1.RecoveryStrategy; } });
var error_recovery_1 = require("./error-recovery");
Object.defineProperty(exports, "ErrorRecoveryOrchestrator", { enumerable: true, get: function () { return error_recovery_1.ErrorRecoveryOrchestrator; } });
Object.defineProperty(exports, "getErrorRecoveryOrchestrator", { enumerable: true, get: function () { return error_recovery_1.getErrorRecoveryOrchestrator; } });
Object.defineProperty(exports, "recoverFromError", { enumerable: true, get: function () { return error_recovery_1.recoverFromError; } });
Object.defineProperty(exports, "withErrorRecovery", { enumerable: true, get: function () { return error_recovery_1.withErrorRecovery; } });
var enhanced_health_monitor_1 = require("./enhanced-health-monitor");
Object.defineProperty(exports, "EnhancedHealthMonitor", { enumerable: true, get: function () { return enhanced_health_monitor_1.EnhancedHealthMonitor; } });
Object.defineProperty(exports, "getEnhancedHealthMonitor", { enumerable: true, get: function () { return enhanced_health_monitor_1.getEnhancedHealthMonitor; } });
Object.defineProperty(exports, "recordHealthMetric", { enumerable: true, get: function () { return enhanced_health_monitor_1.recordHealthMetric; } });
Object.defineProperty(exports, "getCurrentSystemHealth", { enumerable: true, get: function () { return enhanced_health_monitor_1.getCurrentSystemHealth; } });
var stream_health_monitor_1 = require("./stream-health-monitor");
Object.defineProperty(exports, "StreamHealthMonitor", { enumerable: true, get: function () { return stream_health_monitor_1.StreamHealthMonitor; } });
Object.defineProperty(exports, "getStreamHealthMonitor", { enumerable: true, get: function () { return stream_health_monitor_1.getStreamHealthMonitor; } });
Object.defineProperty(exports, "resetStreamHealthMonitor", { enumerable: true, get: function () { return stream_health_monitor_1.resetStreamHealthMonitor; } });
var swap_event_filter_1 = require("./swap-event-filter");
Object.defineProperty(exports, "SwapEventFilter", { enumerable: true, get: function () { return swap_event_filter_1.SwapEventFilter; } });
Object.defineProperty(exports, "getSwapEventFilter", { enumerable: true, get: function () { return swap_event_filter_1.getSwapEventFilter; } });
Object.defineProperty(exports, "resetSwapEventFilter", { enumerable: true, get: function () { return swap_event_filter_1.resetSwapEventFilter; } });
// T3.12: Enhanced Whale Activity Detection
var whale_activity_tracker_1 = require("./whale-activity-tracker");
Object.defineProperty(exports, "WhaleActivityTracker", { enumerable: true, get: function () { return whale_activity_tracker_1.WhaleActivityTracker; } });
Object.defineProperty(exports, "getWhaleActivityTracker", { enumerable: true, get: function () { return whale_activity_tracker_1.getWhaleActivityTracker; } });
Object.defineProperty(exports, "resetWhaleActivityTracker", { enumerable: true, get: function () { return whale_activity_tracker_1.resetWhaleActivityTracker; } });
// T3.15: Liquidity Depth Analysis
var liquidity_depth_analyzer_1 = require("./liquidity-depth-analyzer");
Object.defineProperty(exports, "LiquidityDepthAnalyzer", { enumerable: true, get: function () { return liquidity_depth_analyzer_1.LiquidityDepthAnalyzer; } });
Object.defineProperty(exports, "getLiquidityDepthAnalyzer", { enumerable: true, get: function () { return liquidity_depth_analyzer_1.getLiquidityDepthAnalyzer; } });
Object.defineProperty(exports, "resetLiquidityDepthAnalyzer", { enumerable: true, get: function () { return liquidity_depth_analyzer_1.resetLiquidityDepthAnalyzer; } });
var price_matrix_1 = require("./price-matrix");
Object.defineProperty(exports, "PriceMatrix", { enumerable: true, get: function () { return price_matrix_1.PriceMatrix; } });
Object.defineProperty(exports, "PriceIndexMapper", { enumerable: true, get: function () { return price_matrix_1.PriceIndexMapper; } });
Object.defineProperty(exports, "getPriceMatrix", { enumerable: true, get: function () { return price_matrix_1.getPriceMatrix; } });
Object.defineProperty(exports, "resetPriceMatrix", { enumerable: true, get: function () { return price_matrix_1.resetPriceMatrix; } });
// Pair Discovery and Caching (S2.2.5)
var pair_discovery_1 = require("./pair-discovery");
Object.defineProperty(exports, "PairDiscoveryService", { enumerable: true, get: function () { return pair_discovery_1.PairDiscoveryService; } });
Object.defineProperty(exports, "getPairDiscoveryService", { enumerable: true, get: function () { return pair_discovery_1.getPairDiscoveryService; } });
Object.defineProperty(exports, "resetPairDiscoveryService", { enumerable: true, get: function () { return pair_discovery_1.resetPairDiscoveryService; } });
var pair_cache_1 = require("./pair-cache");
Object.defineProperty(exports, "PairCacheService", { enumerable: true, get: function () { return pair_cache_1.PairCacheService; } });
Object.defineProperty(exports, "getPairCacheService", { enumerable: true, get: function () { return pair_cache_1.getPairCacheService; } });
Object.defineProperty(exports, "resetPairCacheService", { enumerable: true, get: function () { return pair_cache_1.resetPairCacheService; } });
// Professional Quality Monitor (AD-PQS scoring)
var professional_quality_monitor_1 = require("./professional-quality-monitor");
Object.defineProperty(exports, "ProfessionalQualityMonitor", { enumerable: true, get: function () { return professional_quality_monitor_1.ProfessionalQualityMonitor; } });
// DEX Adapters for non-factory DEXes (Balancer V2, GMX, Platypus)
var dex_adapters_1 = require("./dex-adapters");
Object.defineProperty(exports, "BalancerV2Adapter", { enumerable: true, get: function () { return dex_adapters_1.BalancerV2Adapter; } });
Object.defineProperty(exports, "GmxAdapter", { enumerable: true, get: function () { return dex_adapters_1.GmxAdapter; } });
Object.defineProperty(exports, "PlatypusAdapter", { enumerable: true, get: function () { return dex_adapters_1.PlatypusAdapter; } });
Object.defineProperty(exports, "AdapterRegistry", { enumerable: true, get: function () { return dex_adapters_1.AdapterRegistry; } });
Object.defineProperty(exports, "getAdapterRegistry", { enumerable: true, get: function () { return dex_adapters_1.getAdapterRegistry; } });
Object.defineProperty(exports, "resetAdapterRegistry", { enumerable: true, get: function () { return dex_adapters_1.resetAdapterRegistry; } });
Object.defineProperty(exports, "BALANCER_VAULT_ADDRESSES", { enumerable: true, get: function () { return dex_adapters_1.BALANCER_VAULT_ADDRESSES; } });
Object.defineProperty(exports, "BALANCER_VAULT_ABI", { enumerable: true, get: function () { return dex_adapters_1.BALANCER_VAULT_ABI; } });
Object.defineProperty(exports, "GMX_ADDRESSES", { enumerable: true, get: function () { return dex_adapters_1.GMX_ADDRESSES; } });
Object.defineProperty(exports, "GMX_VAULT_ABI", { enumerable: true, get: function () { return dex_adapters_1.GMX_VAULT_ABI; } });
Object.defineProperty(exports, "GMX_READER_ABI", { enumerable: true, get: function () { return dex_adapters_1.GMX_READER_ABI; } });
Object.defineProperty(exports, "PLATYPUS_ADDRESSES", { enumerable: true, get: function () { return dex_adapters_1.PLATYPUS_ADDRESSES; } });
Object.defineProperty(exports, "PLATYPUS_POOL_ABI", { enumerable: true, get: function () { return dex_adapters_1.PLATYPUS_POOL_ABI; } });
Object.defineProperty(exports, "SUBGRAPH_URLS", { enumerable: true, get: function () { return dex_adapters_1.SUBGRAPH_URLS; } });
Object.defineProperty(exports, "adapterSuccess", { enumerable: true, get: function () { return dex_adapters_1.success; } });
Object.defineProperty(exports, "adapterFailure", { enumerable: true, get: function () { return dex_adapters_1.failure; } });
// REMOVED: Other professional-grade modules (unused, cleaned up):
// - AdvancedStatisticalArbitrage
// - RiskManagementEngine
// - EnterpriseTestingFramework
// - EnterpriseConfigurationManager
// Keeping PerformanceAnalyticsEngine and CrossDexTriangularArbitrage as they may be needed
var performance_analytics_1 = require("./performance-analytics");
Object.defineProperty(exports, "PerformanceAnalyticsEngine", { enumerable: true, get: function () { return performance_analytics_1.PerformanceAnalyticsEngine; } });
var cross_dex_triangular_arbitrage_1 = require("./cross-dex-triangular-arbitrage");
Object.defineProperty(exports, "CrossDexTriangularArbitrage", { enumerable: true, get: function () { return cross_dex_triangular_arbitrage_1.CrossDexTriangularArbitrage; } });
// T3.11: Multi-Leg Path Finding (5+ tokens)
var multi_leg_path_finder_1 = require("./multi-leg-path-finder");
Object.defineProperty(exports, "MultiLegPathFinder", { enumerable: true, get: function () { return multi_leg_path_finder_1.MultiLegPathFinder; } });
Object.defineProperty(exports, "getMultiLegPathFinder", { enumerable: true, get: function () { return multi_leg_path_finder_1.getMultiLegPathFinder; } });
Object.defineProperty(exports, "resetMultiLegPathFinder", { enumerable: true, get: function () { return multi_leg_path_finder_1.resetMultiLegPathFinder; } });
var validation_1 = require("./validation");
Object.defineProperty(exports, "ValidationMiddleware", { enumerable: true, get: function () { return validation_1.ValidationMiddleware; } });
Object.defineProperty(exports, "ValidationSchemas", { enumerable: true, get: function () { return validation_1.ValidationSchemas; } });
// T2.7: Price Momentum Detection
var price_momentum_1 = require("./price-momentum");
Object.defineProperty(exports, "PriceMomentumTracker", { enumerable: true, get: function () { return price_momentum_1.PriceMomentumTracker; } });
Object.defineProperty(exports, "getPriceMomentumTracker", { enumerable: true, get: function () { return price_momentum_1.getPriceMomentumTracker; } });
Object.defineProperty(exports, "resetPriceMomentumTracker", { enumerable: true, get: function () { return price_momentum_1.resetPriceMomentumTracker; } });
// T2.8: ML Opportunity Scorer
var ml_opportunity_scorer_1 = require("./ml-opportunity-scorer");
Object.defineProperty(exports, "MLOpportunityScorer", { enumerable: true, get: function () { return ml_opportunity_scorer_1.MLOpportunityScorer; } });
Object.defineProperty(exports, "getMLOpportunityScorer", { enumerable: true, get: function () { return ml_opportunity_scorer_1.getMLOpportunityScorer; } });
Object.defineProperty(exports, "resetMLOpportunityScorer", { enumerable: true, get: function () { return ml_opportunity_scorer_1.resetMLOpportunityScorer; } });
// Domain models and core interfaces
__exportStar(require("./domain-models"), exports);
// Repository pattern
var repositories_1 = require("./repositories");
Object.defineProperty(exports, "RedisArbitrageRepository", { enumerable: true, get: function () { return repositories_1.RedisArbitrageRepository; } });
Object.defineProperty(exports, "RedisExecutionRepository", { enumerable: true, get: function () { return repositories_1.RedisExecutionRepository; } });
Object.defineProperty(exports, "createArbitrageRepository", { enumerable: true, get: function () { return repositories_1.createArbitrageRepository; } });
Object.defineProperty(exports, "createExecutionRepository", { enumerable: true, get: function () { return repositories_1.createExecutionRepository; } });
// REMOVED: ArbitrageService and EnterpriseConfigManager (unused, cleaned up)
// DEPRECATED: AdvancedArbitrageOrchestrator removed per ADR-002
// The orchestrator used Pub/Sub which violates ADR-002 (Redis Streams required)
// Use the coordinator service pattern with Redis Streams instead
// See: services/coordinator/src/coordinator.ts
// Base detector for chain-specific implementations
var base_detector_1 = require("./base-detector");
Object.defineProperty(exports, "BaseDetector", { enumerable: true, get: function () { return base_detector_1.BaseDetector; } });
// Partitioned detector for multi-chain management (ADR-003, S3.1)
var partitioned_detector_1 = require("./partitioned-detector");
Object.defineProperty(exports, "PartitionedDetector", { enumerable: true, get: function () { return partitioned_detector_1.PartitionedDetector; } });
// Solana detector for non-EVM chain support (S3.3.1)
var solana_detector_1 = require("./solana-detector");
Object.defineProperty(exports, "SolanaDetector", { enumerable: true, get: function () { return solana_detector_1.SolanaDetector; } });
Object.defineProperty(exports, "SOLANA_DEX_PROGRAMS", { enumerable: true, get: function () { return solana_detector_1.SOLANA_DEX_PROGRAMS; } });
// Solana swap parser for instruction parsing (S3.3.4)
var solana_swap_parser_1 = require("./solana-swap-parser");
Object.defineProperty(exports, "SolanaSwapParser", { enumerable: true, get: function () { return solana_swap_parser_1.SolanaSwapParser; } });
Object.defineProperty(exports, "getSolanaSwapParser", { enumerable: true, get: function () { return solana_swap_parser_1.getSolanaSwapParser; } });
Object.defineProperty(exports, "resetSolanaSwapParser", { enumerable: true, get: function () { return solana_swap_parser_1.resetSolanaSwapParser; } });
Object.defineProperty(exports, "SOLANA_DEX_PROGRAM_IDS", { enumerable: true, get: function () { return solana_swap_parser_1.SOLANA_DEX_PROGRAM_IDS; } });
Object.defineProperty(exports, "PROGRAM_ID_TO_DEX", { enumerable: true, get: function () { return solana_swap_parser_1.PROGRAM_ID_TO_DEX; } });
Object.defineProperty(exports, "SWAP_DISCRIMINATORS", { enumerable: true, get: function () { return solana_swap_parser_1.SWAP_DISCRIMINATORS; } });
Object.defineProperty(exports, "DISABLED_DEXES", { enumerable: true, get: function () { return solana_swap_parser_1.DISABLED_DEXES; } });
// Solana price feed for real-time DEX price updates (S3.3.5)
var solana_price_feed_1 = require("./solana-price-feed");
Object.defineProperty(exports, "SolanaPriceFeed", { enumerable: true, get: function () { return solana_price_feed_1.SolanaPriceFeed; } });
Object.defineProperty(exports, "RAYDIUM_AMM_LAYOUT", { enumerable: true, get: function () { return solana_price_feed_1.RAYDIUM_AMM_LAYOUT; } });
Object.defineProperty(exports, "RAYDIUM_CLMM_LAYOUT", { enumerable: true, get: function () { return solana_price_feed_1.RAYDIUM_CLMM_LAYOUT; } });
Object.defineProperty(exports, "ORCA_WHIRLPOOL_LAYOUT", { enumerable: true, get: function () { return solana_price_feed_1.ORCA_WHIRLPOOL_LAYOUT; } });
Object.defineProperty(exports, "SOLANA_PRICE_FEED_PROGRAMS", { enumerable: true, get: function () { return solana_price_feed_1.SOLANA_DEX_PROGRAMS; } });
// =============================================================================
// REF-1 to REF-4 / ARCH-1 to ARCH-3: Shared Utilities
// =============================================================================
// REF-1/ARCH-1: Shared arbitrage calculation logic
var arbitrage_calculator_1 = require("./arbitrage-calculator");
// P0-1 FIX: Precision-safe BigInt utilities
Object.defineProperty(exports, "safeBigIntDivision", { enumerable: true, get: function () { return arbitrage_calculator_1.safeBigIntDivision; } });
Object.defineProperty(exports, "calculatePriceFromReserves", { enumerable: true, get: function () { return arbitrage_calculator_1.calculatePriceFromReserves; } });
Object.defineProperty(exports, "calculatePriceFromBigIntReserves", { enumerable: true, get: function () { return arbitrage_calculator_1.calculatePriceFromBigIntReserves; } });
Object.defineProperty(exports, "invertPrice", { enumerable: true, get: function () { return arbitrage_calculator_1.invertPrice; } });
Object.defineProperty(exports, "calculatePriceDifferencePercent", { enumerable: true, get: function () { return arbitrage_calculator_1.calculatePriceDifferencePercent; } });
Object.defineProperty(exports, "isSameTokenPair", { enumerable: true, get: function () { return arbitrage_calculator_1.isSameTokenPair; } });
Object.defineProperty(exports, "isReverseOrder", { enumerable: true, get: function () { return arbitrage_calculator_1.isReverseOrder; } });
Object.defineProperty(exports, "getMinProfitThreshold", { enumerable: true, get: function () { return arbitrage_calculator_1.getMinProfitThreshold; } });
Object.defineProperty(exports, "getDefaultFee", { enumerable: true, get: function () { return arbitrage_calculator_1.getDefaultFee; } });
Object.defineProperty(exports, "calculateIntraChainArbitrage", { enumerable: true, get: function () { return arbitrage_calculator_1.calculateIntraChainArbitrage; } });
Object.defineProperty(exports, "calculateCrossChainArbitrage", { enumerable: true, get: function () { return arbitrage_calculator_1.calculateCrossChainArbitrage; } });
Object.defineProperty(exports, "validatePairSnapshot", { enumerable: true, get: function () { return arbitrage_calculator_1.validatePairSnapshot; } });
Object.defineProperty(exports, "createPairSnapshot", { enumerable: true, get: function () { return arbitrage_calculator_1.createPairSnapshot; } });
// REF-2: Shared message validation utilities
var message_validators_1 = require("./message-validators");
Object.defineProperty(exports, "validatePriceUpdate", { enumerable: true, get: function () { return message_validators_1.validatePriceUpdate; } });
Object.defineProperty(exports, "validateWhaleTransaction", { enumerable: true, get: function () { return message_validators_1.validateWhaleTransaction; } });
Object.defineProperty(exports, "validateSwapEvent", { enumerable: true, get: function () { return message_validators_1.validateSwapEvent; } });
Object.defineProperty(exports, "validateReserveUpdate", { enumerable: true, get: function () { return message_validators_1.validateReserveUpdate; } });
Object.defineProperty(exports, "validateCoordinatorCommand", { enumerable: true, get: function () { return message_validators_1.validateCoordinatorCommand; } });
Object.defineProperty(exports, "validateServiceHealthStatus", { enumerable: true, get: function () { return message_validators_1.validateServiceHealthStatus; } });
Object.defineProperty(exports, "validateMessage", { enumerable: true, get: function () { return message_validators_1.validateMessage; } });
Object.defineProperty(exports, "validateBatch", { enumerable: true, get: function () { return message_validators_1.validateBatch; } });
Object.defineProperty(exports, "createPriceUpdate", { enumerable: true, get: function () { return message_validators_1.createPriceUpdate; } });
Object.defineProperty(exports, "createWhaleTransaction", { enumerable: true, get: function () { return message_validators_1.createWhaleTransaction; } });
Object.defineProperty(exports, "createCoordinatorCommand", { enumerable: true, get: function () { return message_validators_1.createCoordinatorCommand; } });
// REF-3/ARCH-2: Standardized error handling
var error_handling_1 = require("./error-handling");
Object.defineProperty(exports, "BaseArbitrageError", { enumerable: true, get: function () { return error_handling_1.ArbitrageError; } });
Object.defineProperty(exports, "ConnectionError", { enumerable: true, get: function () { return error_handling_1.ConnectionError; } });
Object.defineProperty(exports, "SharedValidationError", { enumerable: true, get: function () { return error_handling_1.ValidationError; } });
Object.defineProperty(exports, "LifecycleError", { enumerable: true, get: function () { return error_handling_1.LifecycleError; } });
Object.defineProperty(exports, "ExecutionError", { enumerable: true, get: function () { return error_handling_1.ExecutionError; } });
Object.defineProperty(exports, "ErrorCode", { enumerable: true, get: function () { return error_handling_1.ErrorCode; } });
Object.defineProperty(exports, "ErrorSeverity", { enumerable: true, get: function () { return error_handling_1.ErrorSeverity; } });
Object.defineProperty(exports, "success", { enumerable: true, get: function () { return error_handling_1.success; } });
Object.defineProperty(exports, "failure", { enumerable: true, get: function () { return error_handling_1.failure; } });
Object.defineProperty(exports, "tryCatch", { enumerable: true, get: function () { return error_handling_1.tryCatch; } });
Object.defineProperty(exports, "tryCatchSync", { enumerable: true, get: function () { return error_handling_1.tryCatchSync; } });
Object.defineProperty(exports, "isRetryableErrorCheck", { enumerable: true, get: function () { return error_handling_1.isRetryableError; } });
Object.defineProperty(exports, "isCriticalError", { enumerable: true, get: function () { return error_handling_1.isCriticalError; } });
Object.defineProperty(exports, "getErrorSeverity", { enumerable: true, get: function () { return error_handling_1.getErrorSeverity; } });
Object.defineProperty(exports, "formatErrorForLog", { enumerable: true, get: function () { return error_handling_1.formatErrorForLog; } });
Object.defineProperty(exports, "formatErrorForResponse", { enumerable: true, get: function () { return error_handling_1.formatErrorForResponse; } });
Object.defineProperty(exports, "ErrorAggregator", { enumerable: true, get: function () { return error_handling_1.ErrorAggregator; } });
// REF-4/ARCH-3: Shared async utilities
var async_utils_1 = require("./async-utils");
Object.defineProperty(exports, "TimeoutError", { enumerable: true, get: function () { return async_utils_1.TimeoutError; } });
Object.defineProperty(exports, "withTimeout", { enumerable: true, get: function () { return async_utils_1.withTimeout; } });
Object.defineProperty(exports, "withTimeoutDefault", { enumerable: true, get: function () { return async_utils_1.withTimeoutDefault; } });
Object.defineProperty(exports, "withTimeoutSafe", { enumerable: true, get: function () { return async_utils_1.withTimeoutSafe; } });
Object.defineProperty(exports, "withRetryAsync", { enumerable: true, get: function () { return async_utils_1.withRetry; } });
Object.defineProperty(exports, "sleep", { enumerable: true, get: function () { return async_utils_1.sleep; } });
Object.defineProperty(exports, "createDeferred", { enumerable: true, get: function () { return async_utils_1.createDeferred; } });
Object.defineProperty(exports, "mapConcurrent", { enumerable: true, get: function () { return async_utils_1.mapConcurrent; } });
Object.defineProperty(exports, "mapSequential", { enumerable: true, get: function () { return async_utils_1.mapSequential; } });
Object.defineProperty(exports, "debounceAsync", { enumerable: true, get: function () { return async_utils_1.debounceAsync; } });
Object.defineProperty(exports, "throttleAsync", { enumerable: true, get: function () { return async_utils_1.throttleAsync; } });
Object.defineProperty(exports, "gracefulShutdown", { enumerable: true, get: function () { return async_utils_1.gracefulShutdown; } });
Object.defineProperty(exports, "waitWithTimeouts", { enumerable: true, get: function () { return async_utils_1.waitWithTimeouts; } });
// Partition service utilities (P12-P16 refactor)
var partition_service_utils_1 = require("./partition-service-utils");
Object.defineProperty(exports, "parsePort", { enumerable: true, get: function () { return partition_service_utils_1.parsePort; } });
Object.defineProperty(exports, "validateAndFilterChains", { enumerable: true, get: function () { return partition_service_utils_1.validateAndFilterChains; } });
Object.defineProperty(exports, "createPartitionHealthServer", { enumerable: true, get: function () { return partition_service_utils_1.createPartitionHealthServer; } });
Object.defineProperty(exports, "shutdownPartitionService", { enumerable: true, get: function () { return partition_service_utils_1.shutdownPartitionService; } });
Object.defineProperty(exports, "setupDetectorEventHandlers", { enumerable: true, get: function () { return partition_service_utils_1.setupDetectorEventHandlers; } });
Object.defineProperty(exports, "setupProcessHandlers", { enumerable: true, get: function () { return partition_service_utils_1.setupProcessHandlers; } });
Object.defineProperty(exports, "SHUTDOWN_TIMEOUT_MS", { enumerable: true, get: function () { return partition_service_utils_1.SHUTDOWN_TIMEOUT_MS; } });
// Partition Router (S3.1.7 - Detector Migration)
var partition_router_1 = require("./partition-router");
Object.defineProperty(exports, "PartitionRouter", { enumerable: true, get: function () { return partition_router_1.PartitionRouter; } });
Object.defineProperty(exports, "createDeprecationWarning", { enumerable: true, get: function () { return partition_router_1.createDeprecationWarning; } });
Object.defineProperty(exports, "isDeprecatedPattern", { enumerable: true, get: function () { return partition_router_1.isDeprecatedPattern; } });
Object.defineProperty(exports, "getMigrationRecommendation", { enumerable: true, get: function () { return partition_router_1.getMigrationRecommendation; } });
Object.defineProperty(exports, "warnIfDeprecated", { enumerable: true, get: function () { return partition_router_1.warnIfDeprecated; } });
// P1-1/P1-2-FIX: Export constants as single source of truth
Object.defineProperty(exports, "PARTITION_PORTS", { enumerable: true, get: function () { return partition_router_1.PARTITION_PORTS; } });
Object.defineProperty(exports, "PARTITION_SERVICE_NAMES", { enumerable: true, get: function () { return partition_router_1.PARTITION_SERVICE_NAMES; } });
// Simulation Mode for Local Testing
var simulation_mode_1 = require("./simulation-mode");
Object.defineProperty(exports, "PriceSimulator", { enumerable: true, get: function () { return simulation_mode_1.PriceSimulator; } });
Object.defineProperty(exports, "getSimulator", { enumerable: true, get: function () { return simulation_mode_1.getSimulator; } });
Object.defineProperty(exports, "isSimulationMode", { enumerable: true, get: function () { return simulation_mode_1.isSimulationMode; } });
Object.defineProperty(exports, "SIMULATION_CONFIG", { enumerable: true, get: function () { return simulation_mode_1.SIMULATION_CONFIG; } });
// P0-2 FIX: Nonce Manager for Transaction Sequencing
// CRITICAL-4 FIX: Added getNonceManagerAsync for race-safe initialization
var nonce_manager_1 = require("./nonce-manager");
Object.defineProperty(exports, "NonceManager", { enumerable: true, get: function () { return nonce_manager_1.NonceManager; } });
Object.defineProperty(exports, "getNonceManager", { enumerable: true, get: function () { return nonce_manager_1.getNonceManager; } });
Object.defineProperty(exports, "getNonceManagerAsync", { enumerable: true, get: function () { return nonce_manager_1.getNonceManagerAsync; } });
Object.defineProperty(exports, "resetNonceManager", { enumerable: true, get: function () { return nonce_manager_1.resetNonceManager; } });
// Phase 2: Gas Price Cache (ADR-012, ADR-013)
var gas_price_cache_1 = require("./gas-price-cache");
Object.defineProperty(exports, "GasPriceCache", { enumerable: true, get: function () { return gas_price_cache_1.GasPriceCache; } });
Object.defineProperty(exports, "getGasPriceCache", { enumerable: true, get: function () { return gas_price_cache_1.getGasPriceCache; } });
Object.defineProperty(exports, "resetGasPriceCache", { enumerable: true, get: function () { return gas_price_cache_1.resetGasPriceCache; } });
Object.defineProperty(exports, "GAS_UNITS", { enumerable: true, get: function () { return gas_price_cache_1.GAS_UNITS; } });
Object.defineProperty(exports, "DEFAULT_TRADE_AMOUNT_USD", { enumerable: true, get: function () { return gas_price_cache_1.DEFAULT_TRADE_AMOUNT_USD; } });
Object.defineProperty(exports, "FALLBACK_GAS_COSTS_ETH", { enumerable: true, get: function () { return gas_price_cache_1.FALLBACK_GAS_COSTS_ETH; } });
Object.defineProperty(exports, "FALLBACK_GAS_SCALING_PER_STEP", { enumerable: true, get: function () { return gas_price_cache_1.FALLBACK_GAS_SCALING_PER_STEP; } });
//# sourceMappingURL=index.js.map