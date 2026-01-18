/**
 * System Constants
 *
 * Centralized configuration to eliminate magic numbers across the codebase.
 *
 * @see P2-2-FIX: System constants consolidation
 * @see P4-FIX: Centralized timeout constants
 */

// =============================================================================
// SYSTEM CONSTANTS (P2-2-FIX)
// Centralized configuration to eliminate magic numbers across the codebase
// =============================================================================
export const SYSTEM_CONSTANTS = {
  // Redis configuration
  redis: {
    /** Maximum message size in bytes for Redis pub/sub (1MB) */
    maxMessageSize: 1024 * 1024,
    /** Maximum channel name length */
    maxChannelNameLength: 128,
    /** Default SCAN batch size for iterating keys */
    scanBatchSize: 100,
    /** Default TTL for health data in seconds */
    healthDataTtl: 300,
    /** Default TTL for metrics data in seconds */
    metricsDataTtl: 86400,
    /** Maximum rolling metrics entries */
    maxRollingMetrics: 100,
    /** Disconnect timeout in milliseconds */
    disconnectTimeout: 5000,
  },

  // Cache configuration
  cache: {
    /** Average entry size estimate in bytes for L1 capacity calculation */
    averageEntrySize: 1024,
    /** Default L1 cache size in MB */
    defaultL1SizeMb: 64,
    /** Default L2 TTL in seconds */
    defaultL2TtlSeconds: 300,
    /** Auto-demotion threshold in milliseconds */
    demotionThresholdMs: 5 * 60 * 1000,
    /** Minimum access count before demotion */
    minAccessCountBeforeDemotion: 3,
  },

  // Self-healing configuration
  selfHealing: {
    /** Circuit breaker recovery cooldown in milliseconds */
    circuitBreakerCooldownMs: 60000,
    /** Health check failure threshold before recovery */
    healthCheckFailureThreshold: 3,
    /** Graceful degradation failure threshold */
    gracefulDegradationThreshold: 10,
    /** Maximum restart delay in milliseconds */
    maxRestartDelayMs: 300000,
    /** Simulated restart delay for testing in milliseconds */
    simulatedRestartDelayMs: 2000,
    /** Simulated restart failure rate (0-1) */
    simulatedRestartFailureRate: 0.2,
  },

  // WebSocket configuration
  webSocket: {
    /** Default reconnect delay in milliseconds */
    defaultReconnectDelayMs: 1000,
    /** Maximum reconnect delay in milliseconds */
    maxReconnectDelayMs: 30000,
    /** Reconnect backoff multiplier */
    reconnectBackoffMultiplier: 2,
    /** Maximum reconnect attempts */
    maxReconnectAttempts: 10,
    /** Connection timeout in milliseconds */
    connectionTimeoutMs: 10000,
  },

  // Circuit breaker configuration
  circuitBreaker: {
    /** Default failure threshold */
    defaultFailureThreshold: 3,
    /** Default recovery timeout in milliseconds */
    defaultRecoveryTimeoutMs: 30000,
    /** Default monitoring period in milliseconds */
    defaultMonitoringPeriodMs: 60000,
    /** Default success threshold for closing */
    defaultSuccessThreshold: 2,
  },

  // P4-FIX: Centralized timeout constants
  timeouts: {
    /** HTTP health check timeout in milliseconds */
    httpHealthCheck: 5000,
    /** Redis operation timeout in milliseconds */
    redisOperation: 5000,
    /** Graceful shutdown timeout in milliseconds */
    gracefulShutdown: 30000,
    /** Opportunity deduplication TTL in seconds (Redis SET NX) */
    opportunityDedupTtlSeconds: 30,
    /** Subgraph API request timeout in milliseconds */
    subgraphRequest: 10000,
    /** RPC provider request timeout in milliseconds */
    rpcRequest: 15000,
  },
};
