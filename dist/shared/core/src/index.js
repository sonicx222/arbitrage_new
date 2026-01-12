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
exports.RetryMechanism = exports.withCircuitBreaker = exports.getCircuitBreakerRegistry = exports.createCircuitBreaker = exports.CircuitBreakerRegistry = exports.CircuitState = exports.CircuitBreakerError = exports.CircuitBreaker = exports.resetCacheCoherencyManager = exports.getCacheCoherencyManager = exports.createCacheCoherencyManager = exports.CacheCoherencyManager = exports.getSharedMemoryCache = exports.createSharedMemoryCache = exports.SharedMemoryCache = exports.getHierarchicalCache = exports.createHierarchicalCache = exports.HierarchicalCache = exports.WebSocketManager = exports.getDefaultEventBatcher = exports.createEventBatcher = exports.EventBatcher = exports.PriorityQueue = exports.getWorkerPool = exports.EventProcessingWorkerPool = exports.getPerformanceLogger = exports.PerformanceLogger = exports.createLogger = exports.hasDefaultPrice = exports.getDefaultPrice = exports.resetPriceOracle = exports.getPriceOracle = exports.PriceOracle = exports.isServiceState = exports.createServiceState = exports.ServiceState = exports.ServiceStateManager = exports.resetDistributedLockManager = exports.getDistributedLockManager = exports.DistributedLockManager = exports.resetRedisStreamsInstance = exports.getRedisStreamsClient = exports.StreamBatcher = exports.RedisStreamsClient = exports.singleton = exports.createSingleton = exports.createAsyncSingleton = exports.resetRedisInstance = exports.getRedisClient = exports.RedisClient = void 0;
exports.CrossDexTriangularArbitrage = exports.PerformanceAnalyticsEngine = exports.resetPairCacheService = exports.getPairCacheService = exports.PairCacheService = exports.resetPairDiscoveryService = exports.getPairDiscoveryService = exports.PairDiscoveryService = exports.resetPriceMatrix = exports.getPriceMatrix = exports.PriceIndexMapper = exports.PriceMatrix = exports.resetSwapEventFilter = exports.getSwapEventFilter = exports.SwapEventFilter = exports.resetStreamHealthMonitor = exports.getStreamHealthMonitor = exports.StreamHealthMonitor = exports.getCurrentSystemHealth = exports.recordHealthMetric = exports.getEnhancedHealthMonitor = exports.EnhancedHealthMonitor = exports.withErrorRecovery = exports.recoverFromError = exports.getErrorRecoveryOrchestrator = exports.ErrorRecoveryOrchestrator = exports.getExpertSelfHealingManager = exports.ExpertSelfHealingManager = exports.registerServiceForSelfHealing = exports.getSelfHealingManager = exports.SelfHealingManager = exports.enqueueFailedOperation = exports.getDeadLetterQueue = exports.DeadLetterQueue = exports.DegradationLevel = exports.resetCrossRegionHealthManager = exports.getCrossRegionHealthManager = exports.CrossRegionHealthManager = exports.getCapabilityFallback = exports.isFeatureEnabled = exports.triggerDegradation = exports.getGracefulDegradationManager = exports.GracefulDegradationManager = exports.isRetryableError = exports.classifyError = exports.ErrorCategory = exports.retryAdvanced = exports.retry = exports.withRetry = exports.RetryPresets = void 0;
exports.BaseDetector = exports.createExecutionRepository = exports.createArbitrageRepository = exports.RedisExecutionRepository = exports.RedisArbitrageRepository = exports.ValidationSchemas = exports.ValidationMiddleware = void 0;
// Core utilities exports
var redis_1 = require("./redis");
Object.defineProperty(exports, "RedisClient", { enumerable: true, get: function () { return redis_1.RedisClient; } });
Object.defineProperty(exports, "getRedisClient", { enumerable: true, get: function () { return redis_1.getRedisClient; } });
Object.defineProperty(exports, "resetRedisInstance", { enumerable: true, get: function () { return redis_1.resetRedisInstance; } });
// P1-3-FIX: Standardized singleton pattern utilities
var async_singleton_1 = require("./async-singleton");
Object.defineProperty(exports, "createAsyncSingleton", { enumerable: true, get: function () { return async_singleton_1.createAsyncSingleton; } });
Object.defineProperty(exports, "createSingleton", { enumerable: true, get: function () { return async_singleton_1.createSingleton; } });
Object.defineProperty(exports, "singleton", { enumerable: true, get: function () { return async_singleton_1.singleton; } });
var redis_streams_1 = require("./redis-streams");
Object.defineProperty(exports, "RedisStreamsClient", { enumerable: true, get: function () { return redis_streams_1.RedisStreamsClient; } });
Object.defineProperty(exports, "StreamBatcher", { enumerable: true, get: function () { return redis_streams_1.StreamBatcher; } });
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
// REMOVED: Professional-grade modules (unused, cleaned up):
// - AdvancedStatisticalArbitrage
// - RiskManagementEngine
// - EnterpriseTestingFramework
// - EnterpriseConfigurationManager
// Keeping PerformanceAnalyticsEngine and CrossDexTriangularArbitrage as they may be needed
var performance_analytics_1 = require("./performance-analytics");
Object.defineProperty(exports, "PerformanceAnalyticsEngine", { enumerable: true, get: function () { return performance_analytics_1.PerformanceAnalyticsEngine; } });
var cross_dex_triangular_arbitrage_1 = require("./cross-dex-triangular-arbitrage");
Object.defineProperty(exports, "CrossDexTriangularArbitrage", { enumerable: true, get: function () { return cross_dex_triangular_arbitrage_1.CrossDexTriangularArbitrage; } });
var validation_1 = require("./validation");
Object.defineProperty(exports, "ValidationMiddleware", { enumerable: true, get: function () { return validation_1.ValidationMiddleware; } });
Object.defineProperty(exports, "ValidationSchemas", { enumerable: true, get: function () { return validation_1.ValidationSchemas; } });
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
//# sourceMappingURL=index.js.map