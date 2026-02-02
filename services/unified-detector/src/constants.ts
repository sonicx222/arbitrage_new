/**
 * Unified Detector Constants
 *
 * Centralized configuration constants to avoid magic numbers and
 * ensure consistency across modules.
 *
 * FIX Refactor 9.3: Consolidate scattered constants into single location
 *
 * =============================================================================
 * PARTITION ARCHITECTURE (FIX 2.1: Documentation alignment with ADR-003)
 * =============================================================================
 *
 * The unified-detector runs in partitions, each monitoring multiple chains:
 *
 * | Partition ID  | Chains                              | Region    | Block Time |
 * |---------------|-------------------------------------|-----------|------------|
 * | asia-fast     | BSC, Polygon, Avalanche, Fantom     | Singapore | 2-3s       |
 * | l2-fast       | Arbitrum, Optimism, Base            | Singapore | <1s        |
 * | high-value    | Ethereum, zkSync, Linea             | US-East   | >5s        |
 * | solana-native | Solana (non-EVM)                    | US-West   | 400ms      |
 *
 * Configuration:
 * - PARTITION_ID env var selects which partition to run
 * - PARTITION_CHAINS env var can override chains within a partition
 *
 * @see ADR-003: Partitioned Chain Detectors
 * @see @arbitrage/config for partition definitions
 */

// =============================================================================
// Health & Metrics
// =============================================================================

/** Default port for health check HTTP endpoint */
export const DEFAULT_HEALTH_CHECK_PORT = 3001;

/** Default interval for metrics collection (60 seconds) */
export const DEFAULT_METRICS_INTERVAL_MS = 60_000;

/** Default interval for health checks (30 seconds) */
export const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 30_000;

// =============================================================================
// Chain Management
// =============================================================================

/** Timeout for stopping individual chain instances (30 seconds) */
export const CHAIN_STOP_TIMEOUT_MS = 30_000;

/** Default timeout for service state transitions (60 seconds) */
export const STATE_TRANSITION_TIMEOUT_MS = 60_000;

// =============================================================================
// Caching
// =============================================================================

/** TTL for pair snapshot cache (100ms - balance between freshness and performance) */
export const SNAPSHOT_CACHE_TTL_MS = 100;

/** TTL for DexPool cache (same as snapshot for consistency) */
export const DEX_POOL_CACHE_TTL_MS = 100;

// =============================================================================
// Arbitrage Detection
// =============================================================================

/** Interval for triangular arbitrage checks (500ms) */
export const TRIANGULAR_CHECK_INTERVAL_MS = 500;

/** Interval for multi-leg arbitrage checks (2000ms) */
export const MULTI_LEG_CHECK_INTERVAL_MS = 2_000;

/** Default opportunity expiry time (5 seconds) */
export const DEFAULT_OPPORTUNITY_EXPIRY_MS = 5_000;

// =============================================================================
// Simulation
// =============================================================================

/** Default update interval for simulation mode */
export const DEFAULT_SIMULATION_UPDATE_INTERVAL_MS = 1_000;

/** Minimum allowed simulation update interval (prevents CPU overload) */
export const MIN_SIMULATION_UPDATE_INTERVAL_MS = 100;

/** Maximum allowed simulation update interval */
export const MAX_SIMULATION_UPDATE_INTERVAL_MS = 60_000;

/** Default volatility for simulation mode */
export const DEFAULT_SIMULATION_VOLATILITY = 0.02;

/** Minimum allowed simulation volatility */
export const MIN_SIMULATION_VOLATILITY = 0;

/** Maximum allowed simulation volatility (100% = price can double or halve) */
export const MAX_SIMULATION_VOLATILITY = 1.0;

// =============================================================================
// WebSocket Configuration (FIX 2.3: Added documentation for timeout values)
// =============================================================================

/**
 * Chains known to have unstable WebSocket connections.
 * These chains get extended connection timeouts.
 *
 * Why these chains are unstable:
 * - BSC: High block rate (3s) with frequent reorganizations
 * - Fantom: Known for intermittent RPC endpoint issues
 *
 * FIX Config 3.2: Moved from hardcoded list in chain-instance.ts
 */
export const UNSTABLE_WEBSOCKET_CHAINS = ['bsc', 'fantom'] as const;

/**
 * Default WebSocket connection timeout.
 * Most chains (Ethereum, Polygon, Arbitrum, etc.) connect within 5-8 seconds.
 * 10s provides buffer for network latency while failing fast on dead endpoints.
 */
export const DEFAULT_WS_CONNECTION_TIMEOUT_MS = 10_000;

/**
 * Extended WebSocket connection timeout for unstable chains.
 * BSC and Fantom may take longer due to RPC endpoint load balancing.
 * 15s allows for retry cycles on these chains while still failing reasonably fast.
 */
export const EXTENDED_WS_CONNECTION_TIMEOUT_MS = 15_000;

/**
 * WebSocket disconnect timeout during graceful shutdown.
 * Allows 5s for clean WebSocket close handshake.
 * Longer timeouts could delay shutdown; shorter may leave connections dangling.
 */
export const WS_DISCONNECT_TIMEOUT_MS = 5_000;

// =============================================================================
// Whale Detection
// =============================================================================

/** List of recognized stablecoin symbols */
export const STABLECOIN_SYMBOLS = [
  'USDT', 'USDC', 'DAI', 'BUSD', 'FRAX', 'TUSD', 'USDP', 'UST', 'MIM'
] as const;

/** Default token decimals when token info is not available */
export const DEFAULT_TOKEN_DECIMALS = 18;

// =============================================================================
// Factory Subscription Configuration (Task 2.1.3)
// =============================================================================

/**
 * Default value for useFactorySubscriptions config flag.
 * FIX 1.3: Enabled by default to realize the documented 40-50x RPC reduction.
 * Can be disabled per-chain via FACTORY_SUBSCRIPTION_ENABLED_CHAINS or env vars.
 *
 * @see Task 2.1.3: Migrate Existing Subscriptions
 */
export const DEFAULT_USE_FACTORY_SUBSCRIPTIONS = true;

/**
 * Chains enabled for factory subscriptions.
 * FIX 1.1: Expanded to all supported chains to realize documented 40-50x RPC reduction.
 * Previously only 3 chains were enabled, creating architecture/documentation mismatch.
 *
 * All EVM chains benefit from factory subscriptions:
 * - L2 chains (arbitrum, optimism, base): Fast blocks, high RPC reduction benefit
 * - Main chains (ethereum, polygon, avalanche): High volume, significant cost savings
 * - BSC/Fantom: Despite WebSocket instability, factory subscriptions still help
 *
 * Non-EVM chains (solana) are automatically excluded by isEvmChain() check.
 *
 * @see Task 2.1.3: Factory subscription migration
 * @see ADR-003: Partitioned Chain Detectors
 */
export const FACTORY_SUBSCRIPTION_ENABLED_CHAINS: readonly string[] = [
  // L2 chains (fastest blocks, highest benefit)
  'arbitrum',
  'optimism',
  'base',
  // Main chains
  'ethereum',
  'polygon',
  'avalanche',
  // Other EVM chains
  'bsc',
  'fantom',
  'zksync',
  'linea',
];

/**
 * Rollout percentage for factory subscriptions (0-100).
 * FIX 1.3: Set to 100% for chains not in FACTORY_SUBSCRIPTION_ENABLED_CHAINS.
 * This means all chains get factory subscriptions unless explicitly disabled.
 *
 * @see Task 2.1.3: Gradual rollout strategy
 */
export const DEFAULT_FACTORY_SUBSCRIPTION_ROLLOUT_PERCENT = 100;

// =============================================================================
// Reserve Cache Configuration (ADR-022)
// =============================================================================

/**
 * Default value for useReserveCache config flag.
 * Disabled by default for safe rollout.
 *
 * When enabled:
 * - Sync events update an in-memory cache of reserve data
 * - Reserve lookups check cache first (cache-first with RPC fallback)
 * - Expected 60-80% reduction in eth_call(getReserves) RPC calls
 *
 * @see ADR-022: Reserve Data Caching with Event-Driven Invalidation
 * @see docs/reports/RPC_DATA_OPTIMIZATION_RESEARCH.md
 */
export const DEFAULT_USE_RESERVE_CACHE = false;

/**
 * Chains enabled for reserve caching.
 * Start with L2 chains for initial rollout (fastest blocks, highest benefit).
 *
 * Rollout plan:
 * - Week 1: L2 chains (arbitrum, optimism, base)
 * - Week 2: Add main chains (polygon, avalanche)
 * - Week 3: Full rollout (all EVM chains)
 */
export const RESERVE_CACHE_ENABLED_CHAINS: readonly string[] = [];

/**
 * Rollout percentage for reserve cache (0-100).
 * Uses deterministic hash for consistent rollout across restarts.
 * Set to 0% by default for safe rollout.
 */
export const DEFAULT_RESERVE_CACHE_ROLLOUT_PERCENT = 0;

/**
 * TTL for reserve cache entries in milliseconds.
 * Short TTL (5s) acts as safety net for missed Sync events.
 * Event-driven invalidation is the primary freshness mechanism.
 */
export const RESERVE_CACHE_TTL_MS = 5_000;

/**
 * Maximum entries in reserve cache.
 * 5000 pairs × ~100 bytes ≈ 500KB memory.
 * LRU eviction when exceeded.
 */
export const RESERVE_CACHE_MAX_ENTRIES = 5_000;
