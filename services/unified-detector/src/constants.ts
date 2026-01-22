/**
 * Unified Detector Constants
 *
 * Centralized configuration constants to avoid magic numbers and
 * ensure consistency across modules.
 *
 * FIX Refactor 9.3: Consolidate scattered constants into single location
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
// WebSocket Configuration
// =============================================================================

/**
 * Chains known to have unstable WebSocket connections.
 * These chains get extended connection timeouts.
 *
 * FIX Config 3.2: Moved from hardcoded list in chain-instance.ts
 */
export const UNSTABLE_WEBSOCKET_CHAINS = ['bsc', 'fantom'] as const;

/** Default WebSocket connection timeout (ms) */
export const DEFAULT_WS_CONNECTION_TIMEOUT_MS = 10_000;

/** Extended WebSocket connection timeout for unstable chains (ms) */
export const EXTENDED_WS_CONNECTION_TIMEOUT_MS = 15_000;

/** WebSocket disconnect timeout during shutdown (ms) */
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
