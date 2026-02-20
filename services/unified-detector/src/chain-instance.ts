/**
 * Chain Detector Instance
 *
 * Individual chain detector running within the UnifiedChainDetector.
 * Handles WebSocket connection, event processing, and price updates
 * for a single blockchain.
 *
 * This is a lightweight wrapper around the BaseDetector pattern,
 * optimized for running multiple chains in a single process.
 *
 * @see ADR-003: Partitioned Chain Detectors
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import {
  createLogger,
  PerformanceLogger,
  RedisStreamsClient,
  WebSocketManager,
  StreamBatcher,
  // P0-1 FIX: Use precision-safe price calculation
  calculatePriceFromBigIntReserves,
  // Simulation mode support
  isSimulationMode,
  // REFACTOR: ChainSimulator imports moved to ./simulation module
  // Triangular/Quadrilateral arbitrage detection
  CrossDexTriangularArbitrage,
  DexPool,
  TriangularOpportunity,
  QuadrilateralOpportunity,
  // Multi-leg path finding
  getMultiLegPathFinder,
  MultiLegPathFinder,
  MultiLegOpportunity,
  // Swap event filtering and whale detection
  SwapEventFilter,
  getSwapEventFilter,
  WhaleAlert,
  // Pair activity tracking for volatility-based prioritization
  PairActivityTracker,
  getPairActivityTracker,
  // Task 2.1.3: Factory subscription service for RPC reduction
  FactorySubscriptionService,
  PairCreatedEvent,
  // P0-FIX: Import factory event signatures for event routing
  FactoryEventSignatures,
  AdditionalEventSignatures,
  // ADR-022: Reserve cache for RPC reduction
  ReserveCache,
  getReserveCache,
  // PHASE2-TASK36: Hierarchical cache with PriceMatrix L1
  HierarchicalCache,
  createHierarchicalCache,
  // FIX (Issue 2.1): Import bpsToDecimal for fee conversion (replaces deprecated dexFeeToPercentage)
  bpsToDecimal,
  disconnectWithTimeout,
  stopAndNullify,
  getErrorMessage,
} from '@arbitrage/core';

import {
  CHAINS,
  CORE_TOKENS,
  EVENT_SIGNATURES,
  DETECTOR_CONFIG,
  TOKEN_METADATA,
  ARBITRAGE_CONFIG,
  getEnabledDexes,
  // FIX (Issue 2.1): Removed deprecated dexFeeToPercentage import
  // Using bpsToDecimal from @arbitrage/core instead
  isEvmChain,
} from '@arbitrage/config';

import {
  Dex,
  Token,
  PriceUpdate,
  ArbitrageOpportunity,
  SwapEvent,
} from '@arbitrage/types';

import type { ChainStats, ExtendedPair } from './types';
import { WhaleAlertPublisher, ExtendedPairInfo } from './publishers';
// R3 Refactor: Use extracted detection modules
import {
  SimpleArbitrageDetector,
  createSimpleArbitrageDetector,
  SnapshotManager,
  createSnapshotManager,
  type PairSnapshot,
  type ExtendedPair as DetectionExtendedPair,
} from './detection';
// REFACTOR: Import simulation initializer for extracted simulation lifecycle
import { SimulationInitializer } from './simulation-initializer';
// R8 Refactor: Use extracted subscription and pair initialization modules
import { createSubscriptionManager } from './subscription';
import type { SubscriptionCallbacks, SubscriptionStats } from './subscription';
import { initializePairs as initializePairsFromModule } from './pair-initializer';
// FIX Config 3.1/3.2: Import utility functions and constants
// P0-2 FIX: Import centralized validateFee (FIX 9.3)
import {
  validateFee,
  parseIntEnvVar,
} from './types';
import {
  // R8 Refactor: UNSTABLE_WEBSOCKET_CHAINS, DEFAULT_WS_CONNECTION_TIMEOUT_MS,
  // EXTENDED_WS_CONNECTION_TIMEOUT_MS moved to subscription-manager.ts
  WS_DISCONNECT_TIMEOUT_MS,
  SNAPSHOT_CACHE_TTL_MS,
  // FIX #33: Use centralized constants instead of duplicated private members
  TRIANGULAR_CHECK_INTERVAL_MS,
  MULTI_LEG_CHECK_INTERVAL_MS,
  // Task 2.1.3: Factory subscription config
  DEFAULT_USE_FACTORY_SUBSCRIPTIONS,
  FACTORY_SUBSCRIPTION_ENABLED_CHAINS,
  DEFAULT_FACTORY_SUBSCRIPTION_ROLLOUT_PERCENT,
  // ADR-022: Reserve cache config
  DEFAULT_USE_RESERVE_CACHE,
  RESERVE_CACHE_ENABLED_CHAINS,
  DEFAULT_RESERVE_CACHE_ROLLOUT_PERCENT,
  RESERVE_CACHE_TTL_MS,
  RESERVE_CACHE_MAX_ENTRIES,
} from './constants';

const MULTI_LEG_TIMEOUT_MS = parseIntEnvVar(
  process.env.MULTI_LEG_TIMEOUT_MS,
  5000,
  1000,
  20000
);

// =============================================================================
// Types
// =============================================================================

/** FIX #28: Typed shape for price data stored in HierarchicalCache */
export interface CachedPriceData {
  price: number;
  reserve0: string;
  reserve1: string;
  timestamp: number;
  blockNumber: number;
}

export interface ChainInstanceConfig {
  chainId: string;
  partitionId: string;
  streamsClient: RedisStreamsClient;
  perfLogger: PerformanceLogger;
  wsUrl?: string;
  rpcUrl?: string;

  // Task 2.1.3: Factory Subscription Configuration
  /**
   * When true, use factory-level subscriptions instead of pair-level.
   * Reduces RPC calls by 40-50x by subscribing to factory PairCreated events.
   * Default: false (legacy mode for backward compatibility)
   */
  useFactorySubscriptions?: boolean;

  /**
   * Specific chains to enable factory subscriptions for (overrides rollout percent).
   * Used for gradual rollout across partitions.
   */
  factorySubscriptionEnabledChains?: string[];

  /**
   * Percentage of chains to enable factory subscriptions for (0-100).
   * Uses deterministic hash for consistent rollout across restarts.
   */
  factorySubscriptionRolloutPercent?: number;

  // ADR-022: Reserve Cache Configuration
  /**
   * When true, cache reserve data from Sync events for RPC reduction.
   * Expected 60-80% reduction in eth_call(getReserves) RPC calls.
   * Default: false (disabled for safe rollout)
   */
  useReserveCache?: boolean;

  /**
   * Specific chains to enable reserve cache for (overrides rollout percent).
   * Used for gradual rollout across partitions.
   */
  reserveCacheEnabledChains?: string[];

  /**
   * Percentage of chains to enable reserve cache for (0-100).
   * Uses deterministic hash for consistent rollout across restarts.
   */
  reserveCacheRolloutPercent?: number;

  // PHASE2-TASK36: Hierarchical Price Cache Configuration
  /**
   * When true, use HierarchicalCache (with PriceMatrix L1) for price caching.
   * Provides L1/L2/L3 tiered caching with sub-microsecond reads.
   * Default: false (disabled for safe rollout)
   */
  usePriceCache?: boolean;
}

// R8 Refactor: ExtendedPair interface moved to ./types.ts for shared use
// by chain-instance.ts and pair-initializer.ts.
// Detection module's ExtendedPair (in snapshot-manager.ts) is imported as DetectionExtendedPair.

// R3 Refactor: PairSnapshot interface moved to detection/simple-arbitrage-detector.ts
// Now imported from './detection' module

// P2 FIX: Proper type for Ethereum RPC log events
interface EthereumLog {
  address: string;
  data: string;
  topics: string[];
  blockNumber: string;  // Hex string
  transactionHash?: string;
}

// P2 FIX: Proper type for Ethereum block header
interface EthereumBlockHeader {
  number: string;  // Hex string
  timestamp?: string;
  hash?: string;
}

// P2 FIX: Proper type for WebSocket subscription messages
interface WebSocketMessage {
  method?: string;
  params?: {
    result?: EthereumLog | EthereumBlockHeader | Record<string, unknown>;
    subscription?: string;
  };
  error?: { code: number; message: string };
}

// P2 FIX: Type for token metadata
interface TokenMetadata {
  weth: string;
  stablecoins: { address: string; symbol: string; decimals: number }[];
  nativeWrapper: string;
}

// =============================================================================
// Chain Detector Instance
// =============================================================================

export class ChainDetectorInstance extends EventEmitter {
  private logger: ReturnType<typeof createLogger>;
  private perfLogger: PerformanceLogger;
  private streamsClient: RedisStreamsClient;

  private chainId: string;
  private partitionId: string;
  private chainConfig: typeof CHAINS[keyof typeof CHAINS];
  private detectorConfig: typeof DETECTOR_CONFIG[keyof typeof DETECTOR_CONFIG];

  private provider: ethers.JsonRpcProvider | null = null;
  private wsManager: WebSocketManager | null = null;

  private dexes: Dex[];
  private tokens: Token[];
  // FIX 10.5: Pre-computed base tokens for triangular/multi-leg detection
  // Caches first 4 token addresses (lowercase) to avoid repeated slice().map() allocations
  // At ~1 call/500ms for triangular, this saves ~2 array allocations per call
  private cachedBaseTokens: string[] = [];
  // PERF-OPT: O(1) token lookup by address (instead of O(N) array.find)
  // Key: lowercase address, Value: Token object
  private tokensByAddress: Map<string, Token> = new Map();
  // P2 FIX: Use TokenMetadata type instead of any
  private tokenMetadata: TokenMetadata | undefined;

  private pairs: Map<string, ExtendedPair> = new Map();
  private pairsByAddress: Map<string, ExtendedPair> = new Map();
  // P0-PERF FIX: Token-indexed lookup for O(1) arbitrage pair matching
  // Key: normalized "token0_token1" where addresses are lowercase and alphabetically ordered
  private pairsByTokens: Map<string, ExtendedPair[]> = new Map();
  // P2-FIX 3.3: Cached array of pair addresses to avoid repeated Array.from() calls
  private pairAddressesCache: string[] = [];
  // FIX 10.1: LRU-style cache for token pair keys to avoid string allocation in hot path
  // Key: "token0|token1", Value: normalized key "token0_token1" (alphabetically ordered)
  // At 1000 events/sec, this eliminates ~3000 string allocations/sec
  private tokenPairKeyCache: Map<string, string> = new Map();
  private readonly TOKEN_PAIR_KEY_CACHE_MAX = 10000;

  private status: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
  private eventsProcessed: number = 0;
  private opportunitiesFound: number = 0;
  private lastBlockNumber: number = 0;
  private lastBlockTimestamp: number = 0;
  // FIX 10.4: Ring buffer for block latencies (O(1) insertion instead of O(n) shift)
  // Pre-allocated Float64Array eliminates GC pressure from dynamic array growth
  private static readonly BLOCK_LATENCY_BUFFER_SIZE = 100;
  private blockLatencyBuffer = new Float64Array(ChainDetectorInstance.BLOCK_LATENCY_BUFFER_SIZE);
  private blockLatencyIndex: number = 0;  // Next write position
  private blockLatencyCount: number = 0;  // Number of valid entries (max = BUFFER_SIZE)
  // FIX 10.3: Static empty array for fallback (avoids creating new [] on every cache miss)
  private static readonly EMPTY_PAIRS: readonly ExtendedPair[] = [];

  private isRunning: boolean = false;
  private isStopping: boolean = false;
  /** Phase 0 instrumentation: timestamp of last WebSocket message received */
  private lastWsReceivedAt: number = 0;
  private reconnectAttempts: number = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;

  // P0-NEW-3/P0-NEW-4 FIX: Lifecycle promises to prevent race conditions
  // These ensure concurrent start/stop calls are handled correctly
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  // Simulation mode support
  private readonly simulationMode: boolean;
  // REFACTOR: Use SimulationInitializer for extracted simulation lifecycle
  private simulationInitializer: SimulationInitializer | null = null;

  // Triangular/Quadrilateral arbitrage detection
  private triangularDetector: CrossDexTriangularArbitrage;
  private lastTriangularCheck: number = 0;

  // R3: Extracted detection modules
  private simpleArbitrageDetector: SimpleArbitrageDetector;
  private snapshotManager: SnapshotManager;

  // Multi-leg path finding (5-7 token paths)
  private multiLegPathFinder: MultiLegPathFinder | null = null;
  private lastMultiLegCheck: number = 0;

  // P1-FIX: Maximum staleness for pair data in arbitrage detection.
  // Pairs not updated within this window are skipped to prevent false opportunities
  // from stale reserves. 30s aligns with typical block times across supported chains.
  private readonly MAX_STALENESS_MS = 30_000;

  // Swap event filtering and whale detection
  private swapEventFilter: SwapEventFilter | null = null;
  private whaleAlertUnsubscribe: (() => void) | null = null;

  // PHASE-3.3: Extracted whale alert publisher for cleaner separation
  private whaleAlertPublisher: WhaleAlertPublisher | null = null;

  // Pair activity tracking for volatility-based prioritization
  // Hot pairs (high update frequency) bypass time-based throttling
  private activityTracker: PairActivityTracker;

  // NOTE: Snapshot caching is now handled by SnapshotManager (R3 refactor)
  // The manager handles time-based TTL and version-based invalidation internally

  // Task 2.1.3: Factory Subscription Configuration
  // Factory-level subscriptions for 40-50x RPC reduction
  private factorySubscriptionService: FactorySubscriptionService | null = null;
  // R8 Refactor: Cached boolean for hot-path access (set by SubscriptionManager)
  // Replaces shouldUseFactorySubscriptions() method call in handleWebSocketMessage()
  private useFactoryMode: boolean = false;
  private subscriptionConfig: {
    useFactorySubscriptions: boolean;
    factorySubscriptionEnabledChains: string[];
    factorySubscriptionRolloutPercent: number;
  };

  // Task 2.1.3: Subscription statistics for monitoring
  private subscriptionStats: {
    mode: 'factory' | 'legacy' | 'none';
    legacySubscriptionCount: number;
    factorySubscriptionCount: number;
    monitoredPairs: number;
    rpcReductionRatio: number;
  } = {
    mode: 'none',
    legacySubscriptionCount: 0,
    factorySubscriptionCount: 0,
    monitoredPairs: 0,
    rpcReductionRatio: 1
  };

  // ADR-022: Reserve cache for RPC reduction
  private reserveCache: ReserveCache | null = null;
  private reserveCacheConfig: {
    useReserveCache: boolean;
    reserveCacheEnabledChains: string[];
    reserveCacheRolloutPercent: number;
  };

  // PHASE2-TASK36: Hierarchical price cache with PriceMatrix L1
  // Optional enhancement for persistent caching and monitoring
  // Does NOT replace hot-path pairsByAddress Map (still O(1) at ~50ns)
  private priceCache: HierarchicalCache | null = null;
  private usePriceCache: boolean = false;

  // ADR-002: StreamBatcher for price updates — reduces Redis commands ~50x
  // batcher.add() is O(1) synchronous, flush happens asynchronously
  private priceUpdateBatcher: StreamBatcher<PriceUpdate> | null = null;

  constructor(config: ChainInstanceConfig) {
    super();

    this.chainId = config.chainId;
    this.partitionId = config.partitionId;
    this.streamsClient = config.streamsClient;
    this.perfLogger = config.perfLogger;

    this.logger = createLogger(`chain:${config.chainId}`);

    // Load chain configuration
    this.chainConfig = CHAINS[this.chainId as keyof typeof CHAINS];
    if (!this.chainConfig) {
      throw new Error(`Chain configuration not found: ${this.chainId}`);
    }

    this.detectorConfig = DETECTOR_CONFIG[this.chainId as keyof typeof DETECTOR_CONFIG] || DETECTOR_CONFIG.ethereum;
    this.dexes = getEnabledDexes(this.chainId);
    this.tokens = CORE_TOKENS[this.chainId as keyof typeof CORE_TOKENS] || [];
    this.tokenMetadata = TOKEN_METADATA[this.chainId as keyof typeof TOKEN_METADATA] || {};

    // PERF-OPT: Build O(1) token lookup map at construction time
    // This avoids O(N) array.find() on every getTokenSymbol() call in hot path
    for (const token of this.tokens) {
      this.tokensByAddress.set(token.address.toLowerCase(), token);
    }

    // FIX 10.5: Pre-compute base tokens for triangular/multi-leg detection
    // Avoids creating new arrays on every detection cycle (500ms/2000ms intervals)
    this.cachedBaseTokens = this.tokens.slice(0, 4).map(t => t.address.toLowerCase());

    // Override URLs if provided
    if (config.wsUrl) {
      this.chainConfig = { ...this.chainConfig, wsUrl: config.wsUrl };
    }
    if (config.rpcUrl) {
      this.chainConfig = { ...this.chainConfig, rpcUrl: config.rpcUrl };
    }

    // Check for simulation mode
    this.simulationMode = isSimulationMode();
    if (this.simulationMode) {
      this.logger.debug('Running in SIMULATION MODE - no real blockchain connections', {
        chainId: this.chainId
      });
    }

    // Initialize triangular/quadrilateral arbitrage detector
    // P1-1 FIX: Use ?? instead of || to allow 0 as a valid threshold value
    this.triangularDetector = new CrossDexTriangularArbitrage({
      minProfitThreshold: ARBITRAGE_CONFIG.minProfitPercentage ?? 0.003,
      maxSlippage: ARBITRAGE_CONFIG.slippageTolerance ?? 0.10
    });

    // R3: Initialize extracted detection modules
    this.simpleArbitrageDetector = createSimpleArbitrageDetector(this.chainId, this.detectorConfig);
    this.snapshotManager = createSnapshotManager({ cacheTtlMs: SNAPSHOT_CACHE_TTL_MS });

    // Initialize pair activity tracker for volatility-based prioritization
    // Uses singleton to share state across chain instances (useful for cross-chain hot pairs)
    this.activityTracker = getPairActivityTracker({
      windowMs: 10000,                    // 10 second window
      hotThresholdUpdatesPerSecond: 2,    // 2+ updates/sec = hot pair
      maxPairs: 5000                      // Max pairs to track
    });

    // Task 2.1.3: Initialize subscription config from constructor config or defaults
    this.subscriptionConfig = {
      useFactorySubscriptions: config.useFactorySubscriptions ?? DEFAULT_USE_FACTORY_SUBSCRIPTIONS,
      factorySubscriptionEnabledChains: config.factorySubscriptionEnabledChains ?? [...FACTORY_SUBSCRIPTION_ENABLED_CHAINS],
      factorySubscriptionRolloutPercent: config.factorySubscriptionRolloutPercent ?? DEFAULT_FACTORY_SUBSCRIPTION_ROLLOUT_PERCENT
    };

    // ADR-022: Initialize reserve cache config from constructor config or defaults
    this.reserveCacheConfig = {
      useReserveCache: config.useReserveCache ?? DEFAULT_USE_RESERVE_CACHE,
      reserveCacheEnabledChains: config.reserveCacheEnabledChains ?? [...RESERVE_CACHE_ENABLED_CHAINS],
      reserveCacheRolloutPercent: config.reserveCacheRolloutPercent ?? DEFAULT_RESERVE_CACHE_ROLLOUT_PERCENT
    };

    // Initialize reserve cache if enabled for this chain
    if (this.shouldUseReserveCache()) {
      this.reserveCache = getReserveCache({
        maxEntries: RESERVE_CACHE_MAX_ENTRIES,
        ttlMs: RESERVE_CACHE_TTL_MS,
        enableMetrics: true,
      });
      this.logger.debug('Reserve cache enabled for chain', {
        chainId: this.chainId,
        maxEntries: RESERVE_CACHE_MAX_ENTRIES,
        ttlMs: RESERVE_CACHE_TTL_MS,
      });
    }

    // P0-FIX 1.1: Eagerly initialize factory event signature set to prevent race condition
    // Previously this was lazily initialized in isFactoryEventSignature(), which could cause
    // race conditions when multiple WebSocket messages arrive simultaneously during startup.
    // Set construction is fast (microseconds), so eager initialization has no performance impact.
    this.factoryEventSignatureSet = new Set([
      ...Object.values(FactoryEventSignatures),
      ...Object.values(AdditionalEventSignatures),
    ].map(s => s.toLowerCase()));

    // PHASE2-TASK36: Initialize HierarchicalCache if enabled
    this.usePriceCache = config.usePriceCache ?? false;
    if (this.usePriceCache) {
      this.priceCache = createHierarchicalCache({
        l1Enabled: true,
        l1Size: 64, // 64MB L1 cache
        l2Enabled: true,
        l2Ttl: 300, // 5 minutes
        l3Enabled: false, // Disable L3 for now
        enablePromotion: true,
        enableDemotion: false,
        usePriceMatrix: true, // Use PriceMatrix for L1
        enableTimingMetrics: false // Disable in production
      });
      this.logger.debug('Hierarchical price cache enabled', {
        chainId: this.chainId,
        l1Size: 64,
        usePriceMatrix: true
      });
    }
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  async start(): Promise<void> {
    // FIX Race 5.1: Use synchronous mutex pattern to prevent race conditions
    // The check and assignment must happen atomically (no awaits between)

    // If already starting, return existing promise
    if (this.startPromise) {
      return this.startPromise;
    }

    // If stop is in progress, wait for it first, then re-enter
    if (this.stopPromise) {
      const pendingStop = this.stopPromise;
      await pendingStop;
      // Re-enter start() to get proper mutex handling after stop completes
      return this.start();
    }

    // Guard against starting while stopping or already running
    if (this.isStopping) {
      this.logger.warn('Cannot start: ChainDetectorInstance is stopping');
      return;
    }

    if (this.isRunning) {
      this.logger.warn('ChainDetectorInstance already running');
      return;
    }

    // CRITICAL: Create and store the start promise SYNCHRONOUSLY (no awaits above this point after checks)
    // This ensures no other caller can slip through between check and assignment
    this.startPromise = this.performStart();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  /**
   * P0-NEW-3 FIX: Internal start implementation separated for promise tracking
   */
  private async performStart(): Promise<void> {
    // Check if this is a non-EVM chain in simulation mode
    const isNonEvmChain = !isEvmChain(this.chainId);

    this.logger.debug('Starting ChainDetectorInstance', {
      chainId: this.chainId,
      partitionId: this.partitionId,
      dexes: this.dexes.length,
      tokens: this.tokens.length,
      simulationMode: this.simulationMode,
      isEvmChain: !isNonEvmChain
    });

    // S3.3.1 FIX: Non-EVM chains (like Solana) need special handling in simulation mode
    // The EVM-based ChainSimulator generates Sync events which don't apply to Solana
    if (this.simulationMode && isNonEvmChain) {
      this.logger.warn('Non-EVM chain in simulation mode - using simplified simulation', {
        chainId: this.chainId,
        note: 'Solana simulation generates synthetic price updates without real DEX events'
      });
      // Set status to connected and start a simplified simulation
      this.status = 'connected';
      this.isRunning = true;
      this.emit('statusChange', this.status);
      // REFACTOR: Start non-EVM simulation via extracted initializer
      this.simulationInitializer = this.createSimulationInitializer();
      await this.simulationInitializer.initializeNonEvmSimulation();
      return;
    }

    this.status = 'connecting';
    this.emit('statusChange', this.status);

    try {
      // Initialize pairs first (needed for both real and simulated modes)
      await this.initializePairs();

      // Initialize multi-leg path finder for 5-7 token arbitrage
      // P1-1 FIX: Use ?? instead of || to allow 0 as a valid threshold value
      this.multiLegPathFinder = getMultiLegPathFinder({
        minProfitThreshold: ARBITRAGE_CONFIG.minProfitPercentage ?? 0.005,
        maxPathLength: 7,
        minPathLength: 5,
        timeoutMs: MULTI_LEG_TIMEOUT_MS
      });

      // Initialize swap event filter for whale detection
      this.swapEventFilter = getSwapEventFilter({
        minUsdValue: 10,
        whaleThreshold: 50000,
        dedupWindowMs: 5000
      });

      // PHASE-3.3: Initialize whale alert publisher (extracted module)
      this.whaleAlertPublisher = new WhaleAlertPublisher({
        chainId: this.chainId,
        logger: this.logger,
        streamsClient: this.streamsClient,
        tokens: this.tokens
      });

      // Register whale alert handler to publish to Redis Streams
      // Store unsubscribe function for cleanup in performStop()
      // FIX Race 4.1: Guard against publishing during shutdown with atomic reference capture
      this.whaleAlertUnsubscribe = this.swapEventFilter.onWhaleAlert((alert: WhaleAlert) => {
        // Guard: Don't publish if stopping or not running (resources may be null)
        if (this.isStopping || !this.isRunning) return;

        // FIX Race 4.2: Capture publisher reference BEFORE async call to prevent
        // race condition where publisher is nullified during shutdown while
        // publish is in progress. Optional chaining handles null, but we also
        // need to ensure the reference stays valid through the async operation.
        const publisher = this.whaleAlertPublisher;
        if (!publisher) return;

        publisher.publishWhaleAlert(alert).catch(error => {
          // FIX: Only log if still running to avoid noise during shutdown
          if (!this.isStopping) {
            this.logger.error('Failed to publish whale alert', { error: (error as Error).message });
          }
        });
      });

      if (this.simulationMode) {
        // REFACTOR: SIMULATION MODE via extracted initializer
        this.simulationInitializer = this.createSimulationInitializer();
        await this.simulationInitializer.initializeEvmSimulation();
      } else {
        // PRODUCTION MODE: Use real WebSocket and RPC connections
        // Initialize RPC provider
        this.provider = new ethers.JsonRpcProvider(this.chainConfig.rpcUrl);

        // R8 Refactor: Initialize WebSocket and subscribe in a single call
        await this.initializeWebSocketAndSubscribe();
      }

      // ADR-002: Create StreamBatcher for price updates (~50x Redis command reduction)
      // batcher.add() is O(1) synchronous — FASTER than previous async xaddWithLimit
      this.priceUpdateBatcher = this.streamsClient.createBatcher<PriceUpdate>(
        RedisStreamsClient.STREAMS.PRICE_UPDATES,
        { maxBatchSize: 50, maxWaitMs: 10 }
      );

      this.isRunning = true;
      this.status = 'connected';
      this.reconnectAttempts = 0;
      this.emit('statusChange', this.status);

      this.logger.info(`Chain ${this.chainId} started (${this.pairs.size} pairs, ${this.simulationMode ? 'simulation' : 'production'})`);

    } catch (error) {
      this.status = 'error';
      this.emit('statusChange', this.status);
      this.emit('error', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    // FIX Race 5.1: Use synchronous mutex pattern to prevent race conditions

    // If already stopping, return existing promise
    if (this.stopPromise) {
      return this.stopPromise;
    }

    // If start is in progress, wait for it first, then re-enter
    if (this.startPromise) {
      const pendingStart = this.startPromise;
      await pendingStart;
      // Re-enter stop() to get proper mutex handling after start completes
      return this.stop();
    }

    // Guard: Can't stop if not running and not stopping
    if (!this.isRunning && !this.isStopping) {
      return;
    }

    // CRITICAL: Create and store the stop promise SYNCHRONOUSLY (no awaits above this point after checks)
    this.stopPromise = this.performStop();

    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  /**
   * P0-NEW-4 FIX: Internal stop implementation separated for promise tracking
   */
  private async performStop(): Promise<void> {
    this.logger.info('Stopping ChainDetectorInstance', { chainId: this.chainId });

    // Set stopping flag FIRST to prevent new event processing
    this.isStopping = true;
    this.isRunning = false;

    // ADR-002: Flush and destroy batcher EARLY to ensure pending price updates
    // are published before pairs/caches are cleared in subsequent cleanup steps
    if (this.priceUpdateBatcher) {
      await this.priceUpdateBatcher.destroy();
      this.priceUpdateBatcher = null;
    }

    // REFACTOR: Stop simulation via extracted initializer (handles both EVM and non-EVM)
    if (this.simulationInitializer) {
      await this.simulationInitializer.stop();
      this.simulationInitializer = null;
    }

    // Task 2.1.3: Stop factory subscription service
    // P0-FIX 1.5: Await async stop to ensure cleanup completes before clearing pairs
    // Without await, factory events could arrive after pairsByAddress.clear() causing null dereference
    this.factorySubscriptionService = await stopAndNullify(this.factorySubscriptionService);

    // P0-NEW-6 FIX: Disconnect WebSocket with timeout to prevent indefinite hangs
    if (this.wsManager) {
      // Remove all event listeners before disconnecting to prevent memory leak
      this.wsManager.removeAllListeners();
      await disconnectWithTimeout(this.wsManager, 'WebSocket', WS_DISCONNECT_TIMEOUT_MS, this.logger);
      this.wsManager = null;
    }

    // Clean up provider reference
    if (this.provider) {
      this.provider = null;
    }

    // BUG-2 FIX: Unsubscribe whale alert handler to prevent duplicate alerts
    // and memory leaks when restarting or running multiple chain instances
    if (this.whaleAlertUnsubscribe) {
      this.whaleAlertUnsubscribe();
      this.whaleAlertUnsubscribe = null;
    }

    // Clear singleton references (they will be re-acquired on restart)
    this.swapEventFilter = null;
    this.multiLegPathFinder = null;
    // PHASE-3.3: Clean up extracted publisher
    this.whaleAlertPublisher = null;

    // Clear pairs and caches
    this.pairs.clear();
    this.pairsByAddress.clear();
    this.pairsByTokens.clear();
    // P2-FIX 3.3: Clear cached pair addresses array
    this.pairAddressesCache = [];
    // FIX 10.1: Clear token pair key cache to prevent memory leak on restart
    this.tokenPairKeyCache.clear();
    // R3 Refactor: Clear SnapshotManager caches (handles all snapshot/DexPool caching)
    this.snapshotManager.clear();

    // Clear latency tracking (P0-NEW-1 FIX: ensure cleanup)
    // FIX 10.4: Reset ring buffer counters (buffer itself is pre-allocated, just reset state)
    this.blockLatencyIndex = 0;
    this.blockLatencyCount = 0;

    // Reset stats for clean restart
    this.eventsProcessed = 0;
    this.opportunitiesFound = 0;
    this.lastBlockNumber = 0;
    this.lastBlockTimestamp = 0;
    this.reconnectAttempts = 0;

    // Task 2.1.3: Reset subscription stats
    this.subscriptionStats = {
      mode: 'none',
      legacySubscriptionCount: 0,
      factorySubscriptionCount: 0,
      monitoredPairs: 0,
      rpcReductionRatio: 1
    };
    // R8 Refactor: Reset cached factory mode flag
    this.useFactoryMode = false;

    this.status = 'disconnected';
    this.isStopping = false; // Reset for potential restart
    this.emit('statusChange', this.status);

    this.logger.info('ChainDetectorInstance stopped');
  }

  // ===========================================================================
  // Simulation Mode (REFACTORED — delegated to SimulationInitializer)
  // ===========================================================================

  /**
   * Create a SimulationInitializer with all necessary dependencies.
   * Called lazily when simulation mode is active (COLD path).
   */
  private createSimulationInitializer(): SimulationInitializer {
    return new SimulationInitializer({
      chainId: this.chainId,
      logger: this.logger,
      dexes: this.dexes,
      tokens: this.tokens,
      pairs: this.pairs,
      tokensByAddress: this.tokensByAddress,
      pairsByAddress: this.pairsByAddress,
      activityTracker: this.activityTracker,
      snapshotManager: this.snapshotManager,
      getReserveCache: () => this.reserveCache,
      emit: (event, data) => this.emit(event, data),
      emitPriceUpdate: (pair) => this.emitPriceUpdate(pair),
      checkArbitrageOpportunity: (pair) => this.checkArbitrageOpportunity(pair),
      onOpportunityFound: () => { this.opportunitiesFound++; },
      onEventProcessed: () => { this.eventsProcessed++; },
      onBlockUpdate: (blockNumber) => {
        this.lastBlockNumber = blockNumber;
        this.lastBlockTimestamp = Date.now();
      },
    });
  }

  // ===========================================================================
  // WebSocket Management
  // ===========================================================================

  /**
   * R8 Refactor: Delegates to extracted SubscriptionManager module.
   * Initializes WebSocket and subscribes to events in a single call.
   * Sets this.wsManager, this.factorySubscriptionService, this.useFactoryMode,
   * and this.subscriptionStats from the returned result.
   */
  private async initializeWebSocketAndSubscribe(): Promise<void> {
    const subscriptionManager = createSubscriptionManager({
      chainId: this.chainId,
      chainConfig: {
        wsUrl: this.chainConfig.wsUrl,
        rpcUrl: this.chainConfig.rpcUrl,
        wsFallbackUrls: this.chainConfig.wsFallbackUrls,
      },
      subscriptionConfig: this.subscriptionConfig,
      maxReconnectAttempts: this.MAX_RECONNECT_ATTEMPTS,
      logger: this.logger,
    });

    const callbacks: SubscriptionCallbacks = {
      onMessage: (message) => this.handleWebSocketMessage(message as WebSocketMessage),
      onError: (error) => this.handleConnectionError(error),
      onDisconnected: () => {
        if (this.isRunning) {
          this.status = 'connecting';
          this.emit('statusChange', this.status);
        }
      },
      onConnected: () => {
        this.status = 'connected';
        this.reconnectAttempts = 0;
        this.emit('statusChange', this.status);
      },
      onSyncEvent: (log) => this.handleSyncEvent(log as EthereumLog),
      onSwapEvent: (log) => this.handleSwapEvent(log as EthereumLog),
      onNewBlock: (block) => this.handleNewBlock(block as EthereumBlockHeader),
      onPairCreated: (event) => this.handlePairCreatedEvent(event),
    };

    const result = await subscriptionManager.initialize(callbacks, this.pairAddressesCache);

    this.wsManager = result.wsManager;
    this.factorySubscriptionService = result.factorySubscriptionService;
    this.subscriptionStats = result.subscriptionStats;
    this.useFactoryMode = result.useFactoryMode;
  }

  private handleConnectionError(error: Error): void {
    this.reconnectAttempts++;

    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      this.status = 'error';
      this.emit('statusChange', this.status);
      this.emit('error', new Error(`Max reconnect attempts reached for ${this.chainId}`));
    }
  }

  // ===========================================================================
  // Pair Initialization
  // ===========================================================================

  /**
   * R8 Refactor: Delegates to extracted pair-initializer module.
   * Populates this.pairs, this.pairsByAddress, this.pairsByTokens, this.pairAddressesCache.
   */
  private async initializePairs(): Promise<void> {
    const result = initializePairsFromModule(
      { chainId: this.chainId, dexes: this.dexes, tokens: this.tokens },
      (t0, t1) => this.getTokenPairKey(t0, t1)
    );

    this.pairs = result.pairs;
    this.pairsByAddress = result.pairsByAddress;
    this.pairsByTokens = result.pairsByTokens;
    this.pairAddressesCache = result.pairAddressesCache;

    this.logger.debug(`Initialized ${this.pairs.size} pairs for monitoring`, {
      tokenPairGroups: this.pairsByTokens.size
    });
  }

  // ===========================================================================
  // Event Subscription (R8 Refactor: Moved to subscription/subscription-manager.ts)
  // ===========================================================================
  // shouldUseFactorySubscriptions(), hashChainName(), subscribeToEvents(),
  // subscribeViaFactoryMode(), subscribeViaLegacyMode() are now in SubscriptionManager.
  // initializeWebSocket() is merged into initializeWebSocketAndSubscribe().

  /**
   * Deterministic hash for chain name (for rollout percentage).
   * Used by shouldUseReserveCache() for consistent rollout.
   * Duplicated from SubscriptionManager since it's a pure utility (6 lines).
   */
  private static hashChainName(chain: string): number {
    let hash = 0;
    for (let i = 0; i < chain.length; i++) {
      hash = ((hash << 5) - hash + chain.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  }

  /**
   * ADR-022: Determine if reserve caching should be used for this chain.
   * Supports gradual rollout via explicit chain list or percentage-based rollout.
   */
  private shouldUseReserveCache(): boolean {
    // Check if explicitly disabled via config flag
    if (!this.reserveCacheConfig.useReserveCache) {
      return false;
    }

    // If explicit chain list is provided, only enable for those chains
    const enabledChains = this.reserveCacheConfig.reserveCacheEnabledChains;
    if (enabledChains && enabledChains.length > 0) {
      return enabledChains.includes(this.chainId);
    }

    // Check rollout percentage
    const rolloutPercent = this.reserveCacheConfig.reserveCacheRolloutPercent;
    if (rolloutPercent !== undefined && rolloutPercent < 100) {
      // Use deterministic hash of chain name for consistent rollout
      const chainHash = ChainDetectorInstance.hashChainName(this.chainId);
      return (chainHash % 100) < rolloutPercent;
    }

    // Default: if flag is true but no specific config, enable for all
    return this.reserveCacheConfig.useReserveCache;
  }

  // R8 Refactor: subscribeToEvents(), subscribeViaFactoryMode(), subscribeViaLegacyMode()
  // moved to subscription/subscription-manager.ts

  /**
   * Task 2.1.3: Handle PairCreated events from factory subscriptions.
   * Dynamically adds new pairs to monitoring without restart.
   */
  /** Maximum pairs tracked per chain to prevent unbounded memory growth from factory events */
  private static readonly MAX_PAIRS_PER_CHAIN = 10_000;

  private handlePairCreatedEvent(event: PairCreatedEvent): void {
    // FIX #14: Guard against unbounded pair growth from factory events
    if (this.pairs.size >= ChainDetectorInstance.MAX_PAIRS_PER_CHAIN) {
      this.logger.warn('Max pairs per chain reached, ignoring new pair', {
        chain: this.chainId,
        maxPairs: ChainDetectorInstance.MAX_PAIRS_PER_CHAIN,
        pair: event.pairAddress?.slice(0, 10),
      });
      return;
    }

    // Skip if tokens are not available (e.g., Balancer pools awaiting token lookup)
    if (!event.token0 || !event.token1 || event.token0 === '0x0000000000000000000000000000000000000000') {
      this.logger.debug('Skipping pair with incomplete token info', {
        pair: event.pairAddress,
        dex: event.dexName
      });
      return;
    }

    const pairAddressLower = event.pairAddress.toLowerCase();

    // Check if pair already exists
    if (this.pairsByAddress.has(pairAddressLower)) {
      return;
    }

    // Create new pair from factory event
    const token0Symbol = this.getTokenSymbol(event.token0);
    const token1Symbol = this.getTokenSymbol(event.token1);

    // Only add pairs where we know both tokens
    if (!token0Symbol || !token1Symbol) {
      this.logger.debug('Skipping pair with unknown tokens', {
        pair: event.pairAddress,
        token0: event.token0.slice(0, 10),
        token1: event.token1.slice(0, 10)
      });
      return;
    }

    // Create pair key in the same format as initializePairs()
    // HOT-PATH OPT: Pre-compute pairKey for O(0) access in emitPriceUpdate()
    const pairKey = `${event.dexName}_${token0Symbol}_${token1Symbol}`;
    const pairName = `${token0Symbol}/${token1Symbol}`;
    // FIX Perf 10.2: Pre-compute chainPairKey for activity tracking
    const chainPairKey = `${this.chainId}:${pairAddressLower}`;

    // Validate fee at source - downstream consumers trust this value
    // FIX (Issue 2.1): Use bpsToDecimal instead of deprecated dexFeeToPercentage
    const validatedFee = validateFee(event.fee ? bpsToDecimal(event.fee) : undefined);

    const newPair: ExtendedPair = {
      name: pairName,
      dex: event.dexName,
      token0: event.token0.toLowerCase(),
      token1: event.token1.toLowerCase(),
      address: pairAddressLower,
      fee: validatedFee,
      reserve0: '0',
      reserve1: '0',
      blockNumber: event.blockNumber,
      lastUpdate: Date.now(),
      pairKey,  // Cache for O(0) access in hot path
      chainPairKey,  // FIX Perf 10.2: Cache for O(0) activity tracking
    };

    // Add to tracking maps
    this.pairs.set(pairKey, newPair);
    this.pairsByAddress.set(pairAddressLower, newPair);
    // P2-FIX 3.3: Also add to cached addresses array
    this.pairAddressesCache.push(pairAddressLower);

    // P0-PERF FIX: Add to token-indexed lookup for O(1) arbitrage detection
    const tokenKey = this.getTokenPairKey(newPair.token0, newPair.token1);
    let pairsForTokens = this.pairsByTokens.get(tokenKey);
    if (!pairsForTokens) {
      pairsForTokens = [];
      this.pairsByTokens.set(tokenKey, pairsForTokens);
    }
    pairsForTokens.push(newPair);

    this.logger.info('New pair discovered via factory event', {
      pair: pairName,
      dex: event.dexName,
      address: pairAddressLower.slice(0, 10) + '...'
    });

    // Subscribe to events for this new pair if in legacy mode
    // (Factory mode will receive events via factory subscription)
    if (this.subscriptionStats.mode === 'legacy' && this.wsManager) {
      // Note: WebSocket subscriptions can't be updated dynamically in most providers
      // This would require re-subscribing with the updated address list
      // For now, new pairs in legacy mode will be picked up on next restart
    }

    // Emit event for external listeners
    this.emit('pairDiscovered', newPair);
  }

  // ===========================================================================
  // HOT PATH - EVENT HANDLERS
  // ===========================================================================
  //
  // ⚠️  PERFORMANCE CRITICAL - DO NOT REFACTOR WITHOUT BENCHMARKING  ⚠️
  //
  // The following event handlers are in the HOT PATH:
  // - handleWebSocketMessage() → routes all WebSocket events
  // - handleSyncEvent()        → processes reserve updates (100-1000/sec)
  // - handleSwapEvent()        → processes swap events (10-100/sec)
  // - handleNewBlock()         → processes new blocks (1/sec avg)
  //
  // These handlers are INTENTIONALLY kept inline for performance reasons:
  //
  // 1. DIRECT MAP ACCESS: pairsByAddress.get() is O(1), ~50ns
  //    - Extracting to a class would add function call overhead (~30-50ns each)
  //    - At 1000 events/sec, this adds 30-50μs latency per second
  //
  // 2. INLINE BigInt PARSING: Reserve decoding is inlined
  //    - Avoids function call overhead on every Sync event
  //    - BigInt parsing is CPU-bound, keep it simple
  //
  // 3. ATOMIC UPDATES: Object.assign() for pair updates
  //    - Prevents race conditions from concurrent access
  //    - Faster than spread operator in tight loops
  //
  // 4. VERSION-BASED CACHE INVALIDATION: snapshotManager.invalidateCache()
  //    - SnapshotManager handles version tracking internally (single method call)
  //    - Prevents stale cache reads without locks
  //
  // Performance Budget: <10ms per event (to handle 100+ events/second)
  // Current measured: ~0.5-2ms per Sync event (well within budget)
  //
  // DO NOT:
  // - Extract these handlers to separate classes
  // - Add abstraction layers or interfaces
  // - Use immutable patterns (spread operators) in loops
  // - Add async operations in the synchronous path
  //
  // If you MUST modify this code:
  // 1. Measure baseline latency with performance.now()
  // 2. Make your change
  // 3. Re-measure and ensure <10% regression
  // 4. Document your measurements in the PR
  //
  // @see Hot-Path Analysis in refactoring analysis report
  // ===========================================================================

  // P2 FIX: Use WebSocketMessage type instead of any
  private handleWebSocketMessage(message: WebSocketMessage): void {
    // P0-FIX 1.4: Guard against processing during shutdown
    // This prevents race conditions where WebSocket messages arrive after stop() is called
    // but before the WebSocket connection is fully disconnected
    if (this.isStopping || !this.isRunning) return;

    // Phase 0 instrumentation: capture WebSocket receive timestamp
    this.lastWsReceivedAt = Date.now();

    try {
      // Route message based on type
      if (message.method === 'eth_subscription') {
        const params = message.params;
        const result = params?.result as EthereumLog | EthereumBlockHeader | undefined;
        if (result && 'topics' in result && result.topics) {
          // Log event
          const topic0 = result.topics[0];
          if (topic0 === EVENT_SIGNATURES.SYNC) {
            this.handleSyncEvent(result);
          } else if (topic0 === EVENT_SIGNATURES.SWAP_V2) {
            this.handleSwapEvent(result);
          } else if (this.factorySubscriptionService && this.useFactoryMode) {
            // P0-FIX: Route potential factory events to factory subscription service
            // Check if this is a factory event (PairCreated, PoolCreated, etc.)
            if (this.isFactoryEventSignature(topic0)) {
              // FIX Bug 4.4: Wrap factory event handling in try-catch
              // If handleFactoryEvent throws, don't crash the entire message handler
              try {
                this.factorySubscriptionService.handleFactoryEvent(result);
              } catch (factoryError) {
                this.logger.error('Factory event handling failed', {
                  error: (factoryError as Error).message,
                  topic0,
                  address: result.address
                });
              }
            }
          }
        } else if (result && 'number' in result && result.number) {
          // New block
          this.handleNewBlock(result as EthereumBlockHeader);
        }
      }
    } catch (error) {
      this.logger.error('Error handling WebSocket message', { error });
    }
  }

  /**
   * P0-FIX 1.1: Factory event signature set for O(1) lookups.
   * Eagerly initialized in constructor to prevent race conditions.
   * All signatures are pre-lowercased for fast comparison.
   */
  private readonly factoryEventSignatureSet: Set<string>;

  private isFactoryEventSignature(topic0: string): boolean {
    return this.factoryEventSignatureSet.has(topic0.toLowerCase());
  }

  // P2 FIX: Use EthereumLog type instead of any
  private handleSyncEvent(log: EthereumLog): void {
    // Guard against processing during shutdown (consistent with base-detector.ts)
    if (this.isStopping || !this.isRunning) return;

    try {
      const pairAddress = log.address?.toLowerCase();
      const pair = this.pairsByAddress.get(pairAddress);

      if (!pair) return; // Not a monitored pair

      // Decode reserves from log data
      const data = log.data;
      if (data && data.length >= 130) {
        // CRITICAL FIX: Parse reserves BEFORE recording activity to prevent
        // inflating activity scores for malformed events (if BigInt throws)
        // FIX Perf 10.2: Keep BigInt values to avoid re-parsing in emitPriceUpdate()
        const reserve0BigInt = BigInt('0x' + data.slice(2, 66));
        const reserve1BigInt = BigInt('0x' + data.slice(66, 130));
        const reserve0 = reserve0BigInt.toString();
        const reserve1 = reserve1BigInt.toString();
        const blockNumber = parseInt(log.blockNumber, 16);

        // ADR-022: Update reserve cache (event-driven invalidation)
        // This is the primary update path - reserves from Sync events are always fresh
        if (this.reserveCache) {
          this.reserveCache.onSyncEvent(this.chainId, pairAddress, reserve0, reserve1, blockNumber);
        }

        // Record activity AFTER successful parsing (race condition fix)
        // FIX Perf 10.2: Use cached chainPairKey to avoid string allocation on every Sync event
        // Falls back to template literal if chainPairKey wasn't pre-computed (e.g., newly added pairs)
        this.activityTracker.recordUpdate(pair.chainPairKey ?? `${this.chainId}:${pairAddress}`);

        // HOT-PATH OPT (Perf-2): Direct property assignment instead of Object.assign.
        // Object.assign creates a temporary object; in single-threaded JS there is
        // no atomicity benefit. Direct writes avoid the allocation overhead.
        pair.reserve0 = reserve0;
        pair.reserve1 = reserve1;
        pair.reserve0BigInt = reserve0BigInt;
        pair.reserve1BigInt = reserve1BigInt;
        pair.blockNumber = blockNumber;
        pair.lastUpdate = Date.now();

        // R3 Refactor: Delegate cache invalidation to SnapshotManager
        // SnapshotManager handles version-based cache coherency and TTL internally
        this.snapshotManager.invalidateCache();

        this.eventsProcessed++;

        // Calculate and emit price update
        this.emitPriceUpdate(pair);

        // Check for arbitrage opportunities
        this.checkArbitrageOpportunity(pair);
      }
    } catch (error) {
      this.logger.error('Error handling Sync event', { error });
    }
  }

  // P2 FIX: Use EthereumLog type instead of any
  private handleSwapEvent(log: EthereumLog): void {
    // Guard against processing during shutdown (consistent with base-detector.ts)
    if (this.isStopping || !this.isRunning) return;

    try {
      const pairAddress = log.address?.toLowerCase();
      const pair = this.pairsByAddress.get(pairAddress);

      if (!pair) return;

      this.eventsProcessed++;

      // HOT-PATH OPT (Perf-1): Early exit if no swap event consumers configured.
      // Avoids 4 BigInt conversions, pairInfo construction, and SwapEvent allocation
      // for the majority case where whale detection is not enabled.
      if (!this.whaleAlertPublisher) return;

      // FIX #13: Validate data length before slicing (consistent with handleSyncEvent)
      // Swap events encode 4 uint256 values: 0x prefix (2) + 4 * 64 hex chars = 258
      if (!log.data || log.data.length < 258) return;

      // Build complete SwapEvent with decoded amounts
      const amount0In = BigInt('0x' + log.data.slice(2, 66)).toString();
      const amount1In = BigInt('0x' + log.data.slice(66, 130)).toString();
      const amount0Out = BigInt('0x' + log.data.slice(130, 194)).toString();
      const amount1Out = BigInt('0x' + log.data.slice(194, 258)).toString();

      // PHASE-3.3: Create pair info for USD value estimation
      const pairInfo: ExtendedPairInfo = {
        address: pair.address,
        dex: pair.dex,
        token0: pair.token0,
        token1: pair.token1,
        reserve0: pair.reserve0,
        reserve1: pair.reserve1
      };

      // Estimate USD value for whale detection (if publisher available)
      // When publisher is null, usdValue = 0 which is safe because:
      // 1. Whale detection is guarded by whaleAlertPublisher != null check below
      // 2. Local emit consumers should not assume usdValue is always accurate
      const usdValue = this.whaleAlertPublisher
        ? this.whaleAlertPublisher.estimateSwapUsdValue(pairInfo, amount0In, amount1In, amount0Out, amount1Out)
        : 0;

      const swapEvent: SwapEvent = {
        chain: this.chainId,
        dex: pair.dex,
        pairAddress: pairAddress,
        blockNumber: parseInt(log.blockNumber, 16),
        transactionHash: log.transactionHash || '',
        timestamp: Date.now(),
        sender: log.topics?.[1] ? '0x' + log.topics[1].slice(26) : '',
        recipient: log.topics?.[2] ? '0x' + log.topics[2].slice(26) : '',
        amount0In,
        amount1In,
        amount0Out,
        amount1Out,
        to: '',
        usdValue
      };

      // FIX Bug 4.2: Skip whale detection if publisher is not available (usdValue will always be 0)
      // Process through filter (handles whale detection via registered handler)
      if (this.swapEventFilter && this.whaleAlertPublisher) {
        const result = this.swapEventFilter.processEvent(swapEvent);
        if (!result.passed) return;
      }

      // Publish to Redis Streams using extracted publisher (if available)
      if (this.whaleAlertPublisher) {
        this.whaleAlertPublisher.publishSwapEvent(swapEvent);
      }

      // Local emit for any listeners
      this.emit('swapEvent', swapEvent);
    } catch (error) {
      this.logger.error('Error handling Swap event', { error });
    }
  }

  // P2 FIX: Use EthereumBlockHeader type instead of any
  private handleNewBlock(block: EthereumBlockHeader): void {
    // FIX Race 4.2: Guard against processing during shutdown (consistent with handleSyncEvent/handleSwapEvent)
    if (this.isStopping || !this.isRunning) return;

    const blockNumber = parseInt(block.number, 16);
    const now = Date.now();

    if (this.lastBlockNumber > 0) {
      const latency = now - this.lastBlockTimestamp;
      // FIX 10.4: O(1) ring buffer insertion instead of O(n) shift()
      // Write to current position and advance index (wraps at BUFFER_SIZE)
      this.blockLatencyBuffer[this.blockLatencyIndex] = latency;
      this.blockLatencyIndex = (this.blockLatencyIndex + 1) % ChainDetectorInstance.BLOCK_LATENCY_BUFFER_SIZE;
      // Track count up to buffer size (for accurate average before buffer is full)
      if (this.blockLatencyCount < ChainDetectorInstance.BLOCK_LATENCY_BUFFER_SIZE) {
        this.blockLatencyCount++;
      }
    }

    this.lastBlockNumber = blockNumber;
    this.lastBlockTimestamp = now;
  }

  // ===========================================================================
  // HOT PATH - PRICE UPDATE & ARBITRAGE DETECTION
  // ===========================================================================
  //
  // ⚠️  PERFORMANCE CRITICAL - Called on EVERY Sync event  ⚠️
  //
  // emitPriceUpdate() and checkArbitrageOpportunity() are called after every
  // Sync event (~100-1000 times per second during high activity).
  //
  // Key optimizations:
  // - Pre-cached BigInt values in PairSnapshot (avoids string→BigInt conversion)
  // - Version-based snapshot caching (avoids O(N) iteration on every check)
  // - O(1) Map lookups via pairsByTokens index
  // - Throttled triangular/multi-leg checks (500ms/2000ms intervals)
  //
  // The simple arbitrage check runs inline on every Sync event.
  // The throttled checks (triangular, multi-leg) run on intervals.
  //
  // @see Hot-Path Analysis in refactoring analysis report
  // ===========================================================================

  private emitPriceUpdate(pair: ExtendedPair): void {
    // FIX Perf 10.2: Use cached BigInt values to avoid re-parsing (~2000 parses/sec saved)
    // Falls back to parsing if BigInt cache is missing (e.g., pairs from older code paths)
    const reserve0 = pair.reserve0BigInt ?? BigInt(pair.reserve0);
    const reserve1 = pair.reserve1BigInt ?? BigInt(pair.reserve1);

    if (reserve0 === 0n || reserve1 === 0n) return;

    // P0-1 FIX: Use precision-safe price calculation to prevent precision loss
    // for large BigInt values (reserves can be > 2^53)
    const price = calculatePriceFromBigIntReserves(reserve0, reserve1);
    if (price === null) return;

    const priceUpdate: PriceUpdate = {
      chain: this.chainId,
      dex: pair.dex,
      // HOT-PATH OPT: Use cached pairKey, fall back to computed for backward compatibility
      pairKey: pair.pairKey ?? this.getPairKey(pair),
      pairAddress: pair.address,
      token0: pair.token0,
      token1: pair.token1,
      price,
      reserve0: pair.reserve0,
      reserve1: pair.reserve1,
      timestamp: Date.now(),
      blockNumber: pair.blockNumber,
      latency: 0, // Calculated by downstream consumers if needed
      // Include DEX-specific fee for accurate arbitrage calculations (S2.2.2 fix)
      fee: pair.fee,
      // Phase 0 instrumentation: pipeline latency tracking
      pipelineTimestamps: {
        wsReceivedAt: this.lastWsReceivedAt,
        publishedAt: Date.now(),
      },
    };

    // Publish to Redis Streams
    this.publishPriceUpdate(priceUpdate);

    // Cache price data asynchronously (fire-and-forget).
    // Non-blocking to preserve hot-path latency (<50ms target per ADR-022).
    //
    // Transformation: PriceUpdate → CachedPriceData (normalized subset)
    //   - Extracts: price, reserve0, reserve1, timestamp, blockNumber
    //   - Cache key format: "price:{chainId}:{pairAddress}"
    //
    // This cache (L2 HierarchicalCache / Redis) provides:
    //   1. Cross-instance price sharing between partitions
    //   2. Recovery data for restart scenarios
    //   3. NOT used in hot-path detection (which uses pairsByAddress Map)
    //
    // Failures silently logged — cache is optimization, not critical path.
    // @see ADR-005: L2 cache for distributed sharing
    // @see ADR-022: Hot-path memory optimization
    if (this.usePriceCache && this.priceCache) {
      const cacheKey = `price:${this.chainId}:${pair.address.toLowerCase()}`;
      // Fire-and-forget write to avoid blocking hot path
      const cacheData: CachedPriceData = {
        price: priceUpdate.price,
        reserve0: priceUpdate.reserve0,
        reserve1: priceUpdate.reserve1,
        timestamp: priceUpdate.timestamp,
        blockNumber: priceUpdate.blockNumber,
      };
      this.priceCache.set(cacheKey, cacheData).catch(error => {
        this.logger.warn('Failed to write to price cache', { error, cacheKey });
      });
    }

    this.emit('priceUpdate', priceUpdate);
  }

  private publishPriceUpdate(update: PriceUpdate): void {
    // ADR-002: Use StreamBatcher to reduce Redis commands ~50x
    // batcher.add() is O(1) synchronous queue push — faster than async xaddWithLimit
    // Flush happens asynchronously in background (maxBatchSize: 50, maxWaitMs: 10ms)
    if (this.priceUpdateBatcher) {
      this.priceUpdateBatcher.add(update);
    } else {
      // Fallback: direct publish if batcher not yet initialized (startup race)
      this.streamsClient.xaddWithLimit(
        RedisStreamsClient.STREAMS.PRICE_UPDATES,
        update
      ).catch(error => {
        this.logger.error('Failed to publish price update', { error });
      });
    }
  }

  /**
   * PHASE2-TASK38: Get cached price data for a pair.
   * Useful for recovery scenarios or cross-instance coordination.
   * Does NOT replace hot-path pairsByAddress lookup.
   *
   * FIX #28: Typed return instead of Promise<any>. The upstream
   * HierarchicalCache.get() returns any, so we cast at the boundary.
   *
   * @param pairAddress The pair address to lookup
   * @returns Cached price data or null if not cached
   */
  async getCachedPrice(pairAddress: string): Promise<CachedPriceData | null> {
    if (!this.usePriceCache || !this.priceCache) {
      return null;
    }

    const cacheKey = `price:${this.chainId}:${pairAddress.toLowerCase()}`;
    try {
      return await this.priceCache.get(cacheKey);
    } catch (error) {
      this.logger.warn('Failed to read from price cache', { error, cacheKey });
      return null;
    }
  }

  /**
   * Create a deep snapshot of a single pair for thread-safe arbitrage detection.
   *
   * R3 Refactor: Delegates to extracted SnapshotManager.
   * NOTE: Fee is already validated at pair creation time (initializePairs/handlePairCreatedEvent).
   * SnapshotManager.createPairSnapshot validates as a safety net.
   */
  private createPairSnapshot(pair: ExtendedPair): PairSnapshot | null {
    return this.snapshotManager.createPairSnapshot(pair);
  }

  /**
   * Create deep snapshots of all pairs for thread-safe iteration.
   * This prevents race conditions where concurrent Sync events could
   * modify pair reserves while we're iterating for arbitrage detection.
   *
   * PERF-OPT: Uses time-based caching to avoid O(N) iteration when
   * multiple pairs update within a short window (100ms). This significantly
   * reduces CPU overhead for high-frequency update scenarios.
   */
  private createPairsSnapshot(): Map<string, PairSnapshot> {
    // R3 Refactor: Delegate to SnapshotManager for caching logic
    return this.snapshotManager.createPairsSnapshot(this.pairs as Map<string, DetectionExtendedPair>);
  }

  private checkArbitrageOpportunity(updatedPair: ExtendedPair): void {
    // Guard against processing during shutdown (consistent with base-detector.ts)
    if (this.isStopping || !this.isRunning) return;

    // Create snapshot of the updated pair first
    const currentSnapshot = this.createPairSnapshot(updatedPair);
    if (!currentSnapshot) return;

    // P0-PERF FIX: O(1) lookup instead of O(N) iteration
    // Get only pairs with the same token pair (typically 2-5 pairs across DEXes)
    const tokenKey = this.getTokenPairKey(currentSnapshot.token0, currentSnapshot.token1);
    // FIX 10.3: Use static empty array instead of creating new [] on every cache miss
    const matchingPairs = this.pairsByTokens.get(tokenKey) ?? ChainDetectorInstance.EMPTY_PAIRS;

    // HOT-PATH OPT: Capture timestamp once for staleness checks and throttle logic
    const now = Date.now();

    // Iterate only matching pairs (O(k) where k is typically 2-5)
    for (const otherPair of matchingPairs) {
      // Skip same pair (same address)
      // HOT-PATH OPT: Both addresses are already lowercase (normalized at creation)
      if (otherPair.address === currentSnapshot.address) continue;

      // Skip same DEX - arbitrage requires different DEXes
      if (otherPair.dex === currentSnapshot.dex) continue;

      // P1-FIX: Skip stale pairs to prevent false arbitrage from outdated reserves.
      // lastUpdate is 0 at initialization (correctly filtered as stale).
      if (now - otherPair.lastUpdate > this.MAX_STALENESS_MS) continue;

      // Create snapshot only for pairs we'll actually compare
      const otherSnapshot = this.createPairSnapshot(otherPair);
      if (!otherSnapshot) continue;

      const opportunity = this.calculateArbitrage(currentSnapshot, otherSnapshot);

      if (opportunity && (opportunity.expectedProfit ?? 0) > 0) {
        this.opportunitiesFound++;
        this.emitOpportunity(opportunity);
      }
    }

    // P0-PERF FIX: Check throttle BEFORE creating expensive snapshots
    // This prevents O(N) snapshot creation when throttled

    // VOLATILITY-OPT: Hot pairs (high activity) bypass time-based throttling
    // This ensures we catch arbitrage opportunities on rapidly-updating pairs
    // Use chain:address format to match recordUpdate format
    const isHotPair = this.activityTracker.isHotPair(`${this.chainId}:${updatedPair.address}`);

    // Time-based throttle OR hot pair override
    const shouldCheckTriangular = isHotPair || (now - this.lastTriangularCheck >= TRIANGULAR_CHECK_INTERVAL_MS);
    const shouldCheckMultiLeg = isHotPair || (now - this.lastMultiLegCheck >= MULTI_LEG_CHECK_INTERVAL_MS);

    // Only create snapshot if at least one check will run
    if (shouldCheckTriangular || shouldCheckMultiLeg) {
      const pairsSnapshot = this.createPairsSnapshot();

      if (shouldCheckTriangular) {
        // Pass isHotPair as forceCheck to bypass internal throttle for hot pairs
        this.checkTriangularOpportunities(pairsSnapshot, isHotPair).catch(error => {
          this.logger.error('Triangular detection error', { error: (error as Error).message });
        });
      }

      if (shouldCheckMultiLeg) {
        // Pass isHotPair as forceCheck to bypass internal throttle for hot pairs
        this.checkMultiLegOpportunities(pairsSnapshot, isHotPair).catch(error => {
          this.logger.error('Multi-leg detection error', { error: (error as Error).message });
        });
      }
    }
  }

  /**
   * P0-PERF FIX: Generate normalized key for token pair lookup.
   * Orders addresses alphabetically for consistent matching regardless of token order.
   * This enables O(1) lookup of all pairs containing the same token pair.
   * HOT-PATH: Called during arbitrage detection.
   *
   * FIX 10.1: Uses LRU-style cache to avoid string allocations in hot path.
   * Cache hit rate is expected to be >99% since pairs are relatively static.
   */
  private getTokenPairKey(token0: string, token1: string): string {
    // FIX 10.1: Check cache first to avoid string allocation
    const cacheKey = `${token0}|${token1}`;
    let result = this.tokenPairKeyCache.get(cacheKey);
    if (result !== undefined) {
      return result;
    }

    // Cache miss - compute the key (allocates strings)
    // Safety: Defensive toLowerCase() in case inputs aren't pre-normalized
    const t0 = token0.toLowerCase();
    const t1 = token1.toLowerCase();
    result = t0 < t1 ? `${t0}_${t1}` : `${t1}_${t0}`;

    // FIX 10.1: Amortized O(1) eviction - delete oldest entries incrementally
    // Previous implementation used O(n) spread+slice which caused latency spikes.
    // Now we delete entries one at a time using Map's insertion-order iteration.
    if (this.tokenPairKeyCache.size >= this.TOKEN_PAIR_KEY_CACHE_MAX) {
      // Delete oldest 10% of entries (amortized across many calls)
      const deleteCount = Math.ceil(this.TOKEN_PAIR_KEY_CACHE_MAX * 0.1);
      let deleted = 0;
      for (const key of this.tokenPairKeyCache.keys()) {
        if (deleted >= deleteCount) break;
        this.tokenPairKeyCache.delete(key);
        deleted++;
      }
    }

    // Cache both directions for symmetric lookup
    this.tokenPairKeyCache.set(cacheKey, result);
    this.tokenPairKeyCache.set(`${token1}|${token0}`, result);

    return result;
  }

  /**
   * Get minimum profit threshold for this chain from config.
   * Uses ARBITRAGE_CONFIG.chainMinProfits for consistency with base-detector.ts.
   */
  private getMinProfitThreshold(): number {
    const chainMinProfits = ARBITRAGE_CONFIG.chainMinProfits as Record<string, number>;
    // S2.2.3 FIX: Use ?? instead of || to correctly handle 0 min profit (if any chain allows it)
    return chainMinProfits[this.chainId] ?? 0.003; // Default 0.3%
  }

  /**
   * R3 Refactor: Delegates to extracted SimpleArbitrageDetector.
   */
  private calculateArbitrage(
    pair1: PairSnapshot,
    pair2: PairSnapshot
  ): ArbitrageOpportunity | null {
    // R3: Delegate to extracted detector
    return this.simpleArbitrageDetector.calculateArbitrage(pair1, pair2);
  }

  private emitOpportunity(opportunity: ArbitrageOpportunity): void {
    try {
      // P0-FIX: Removed direct xaddWithLimit call to prevent duplicate publishing.
      // The EventEmitter path propagates through chain-instance-manager -> unified-detector -> index.ts
      // where OpportunityPublisher.publish() is the canonical publisher (adds _source, _publishedAt metadata).
      this.emit('opportunity', opportunity);

      this.perfLogger.logArbitrageOpportunity(opportunity);
    } catch (error) {
      this.logger.error('Failed to publish opportunity', { error });
    }
  }

  // ===========================================================================
  // Triangular/Quadrilateral Arbitrage Detection
  // ===========================================================================
  // R3 Refactor: convertPairSnapshotToDexPool moved to SnapshotManager

  /**
   * Check for triangular and quadrilateral arbitrage opportunities.
   * Throttled to 500ms to prevent excessive CPU usage.
   *
   * @param pairsSnapshot - Snapshot of pairs for thread-safe detection
   * @param forceCheck - If true, bypass throttle check (used for hot pairs)
   */
  private async checkTriangularOpportunities(
    pairsSnapshot: Map<string, PairSnapshot>,
    forceCheck: boolean = false
  ): Promise<void> {
    const now = Date.now();

    // VOLATILITY-OPT: Skip throttle check when forceCheck is true (hot pair bypass)
    if (!forceCheck && now - this.lastTriangularCheck < TRIANGULAR_CHECK_INTERVAL_MS) {
      return;
    }
    this.lastTriangularCheck = now;

    if (pairsSnapshot.size < 3) return;

    // R3 Refactor: Delegate DexPool caching to SnapshotManager
    // SnapshotManager handles version-based cache invalidation (Race 5.1, Perf 10.3)
    const pools = this.snapshotManager.getDexPools(pairsSnapshot);

    // FIX 10.5: Use pre-computed baseTokens instead of creating new arrays every cycle
    // BUG-1 FIX: Use token addresses instead of symbols
    // DexPool.token0/token1 contain addresses, so baseTokens must also be addresses
    // for the findReachableTokens() token matching to work correctly
    const baseTokens = this.cachedBaseTokens;

    try {
      // Find triangular opportunities (3-token cycles)
      const triangularOpps = await this.triangularDetector.findTriangularOpportunities(
        this.chainId, pools, baseTokens
      );

      for (const opp of triangularOpps) {
        await this.emitPathOpportunity(opp, 'triangular');
      }

      // Find quadrilateral opportunities (4-token cycles) if enough pools
      if (pools.length >= 4) {
        const quadOpps = await this.triangularDetector.findQuadrilateralOpportunities(
          this.chainId, pools, baseTokens
        );
        for (const opp of quadOpps) {
          await this.emitPathOpportunity(opp, 'quadrilateral');
        }
      }
    } catch (error) {
      this.logger.error('Triangular/quadrilateral detection failed', { error });
    }
  }

  /**
   * Emit a path-based arbitrage opportunity (triangular, quadrilateral, or multi-leg).
   * FIX #17: Merged emitTriangularOpportunity + emitMultiLegOpportunity (~90% identical code).
   */
  private async emitPathOpportunity(
    opp: TriangularOpportunity | QuadrilateralOpportunity | MultiLegOpportunity,
    type: 'triangular' | 'quadrilateral' | 'multi-leg'
  ): Promise<void> {
    // CRITICAL FIX: Extract tokenIn, tokenOut, amountIn from steps for execution engine
    // For cycles: tokenIn = tokenOut = starting token (we end up with same token)
    const firstStep = opp.steps[0];
    const tokenIn = firstStep?.fromToken || opp.path[0];
    const tokenOut = opp.path[opp.path.length - 1] || opp.path[0]; // Should be same as path[0] for cycles
    // P1 FIX: Use ?? instead of || for numeric values (0 is valid, not missing)
    const amountIn = firstStep?.amountIn ?? 0;
    const buyDex = opp.steps[0]?.dex || '';
    const sellDex = opp.steps[opp.steps.length - 1]?.dex || '';

    // Drop same-entry/exit DEX cycles in local detector output to reduce simulation noise.
    if (!buyDex || !sellDex || buyDex === sellDex) {
      return;
    }

    const opportunity: ArbitrageOpportunity = {
      id: opp.id,
      type,
      chain: this.chainId,
      buyDex,
      sellDex,
      token0: opp.path[0],
      token1: opp.path[1],
      // CRITICAL FIX: Add tokenIn/tokenOut/amountIn required by execution engine
      tokenIn,
      tokenOut,
      amountIn: String(Math.floor(amountIn)),
      buyPrice: 0,
      sellPrice: 0,
      profitPercentage: opp.profitPercentage,
      // CRITICAL FIX: expectedProfit is already an absolute value from the detector
      expectedProfit: opp.netProfit,
      gasEstimate: String(this.detectorConfig.gasEstimate * opp.steps.length),
      confidence: opp.confidence,
      timestamp: opp.timestamp,
      expiresAt: Date.now() + this.detectorConfig.expiryMs,
      blockNumber: this.lastBlockNumber,
      status: 'pending'
    };

    this.opportunitiesFound++;
    this.emitOpportunity(opportunity);

    this.logger.debug(`${type} opportunity detected`, {
      id: opp.id,
      profit: `${opp.profitPercentage.toFixed(2)}%`,
      pathLength: opp.path.length,
      path: opp.path.join(' → ')
    });
  }

  // ===========================================================================
  // Multi-Leg Arbitrage Detection
  // ===========================================================================

  /**
   * Check for multi-leg arbitrage opportunities (5-7 token paths).
   * Throttled to 2000ms and uses worker thread for expensive computation.
   *
   * @param pairsSnapshot - Snapshot of pairs for thread-safe detection
   * @param forceCheck - If true, bypass throttle check (used for hot pairs)
   */
  private async checkMultiLegOpportunities(
    pairsSnapshot: Map<string, PairSnapshot>,
    forceCheck: boolean = false
  ): Promise<void> {
    const now = Date.now();

    // VOLATILITY-OPT: Skip throttle check when forceCheck is true (hot pair bypass)
    if (!forceCheck && now - this.lastMultiLegCheck < MULTI_LEG_CHECK_INTERVAL_MS) {
      return;
    }

    if (pairsSnapshot.size < 5 || !this.multiLegPathFinder) return;
    this.lastMultiLegCheck = now;

    // R3 Refactor: Delegate DexPool caching to SnapshotManager
    // SnapshotManager handles version-based cache invalidation (Race 5.1, Perf 10.3)
    const pools = this.snapshotManager.getDexPools(pairsSnapshot);

    // FIX 10.5: Use pre-computed baseTokens instead of creating new arrays every cycle
    // BUG-1 FIX: Use token addresses instead of symbols (same fix as triangular)
    const baseTokens = this.cachedBaseTokens;

    try {
      // Use async version to offload to worker thread
      const opportunities = await this.multiLegPathFinder.findMultiLegOpportunitiesAsync(
        this.chainId, pools, baseTokens, 5
      );

      for (const opp of opportunities) {
        await this.emitPathOpportunity(opp, 'multi-leg');
      }
    } catch (error) {
      this.logger.error('Multi-leg path finding failed', {
        chainId: this.chainId,
        error: getErrorMessage(error)
      });
    }
  }

  // FIX #17: emitMultiLegOpportunity removed — merged into emitPathOpportunity above

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private getPairKey(pair: ExtendedPair): string {
    // Get token symbols from addresses (simplified)
    const token0Symbol = this.getTokenSymbol(pair.token0);
    const token1Symbol = this.getTokenSymbol(pair.token1);
    return `${pair.dex}_${token0Symbol}_${token1Symbol}`;
  }

  private getTokenSymbol(address: string): string {
    // PERF-OPT: O(1) lookup instead of O(N) array.find()
    const token = this.tokensByAddress.get(address.toLowerCase());
    return token?.symbol || address.slice(0, 8);
  }

  // P0-2 FIX: Removed private validateFee() - now uses centralized version from ./types
  // See: FIX 9.3 in ./types.ts for the canonical implementation

  // ===========================================================================
  // Public Getters
  // ===========================================================================

  isConnected(): boolean {
    return this.status === 'connected';
  }

  getChainId(): string {
    return this.chainId;
  }

  getStatus(): string {
    return this.status;
  }

  getStats(): ChainStats {
    // FIX 10.4: Calculate average from ring buffer (O(n) but only 100 elements)
    let avgLatency = 0;
    if (this.blockLatencyCount > 0) {
      let sum = 0;
      for (let i = 0; i < this.blockLatencyCount; i++) {
        sum += this.blockLatencyBuffer[i];
      }
      avgLatency = sum / this.blockLatencyCount;
    }

    // FIX 10.4: Include hot pairs count for monitoring volatility-based prioritization
    const activityStats = this.activityTracker.getStats();

    // PHASE2-TASK39: Include price cache stats if enabled
    const cacheStats = (this.usePriceCache && this.priceCache)
      ? this.priceCache.getStats()
      : undefined;

    return {
      chainId: this.chainId,
      status: this.status,
      eventsProcessed: this.eventsProcessed,
      opportunitiesFound: this.opportunitiesFound,
      lastBlockNumber: this.lastBlockNumber,
      avgBlockLatencyMs: avgLatency,
      pairsMonitored: this.pairs.size,
      hotPairsCount: activityStats.hotPairs,
      // PHASE2-TASK39: Optional cache statistics
      ...(cacheStats && { priceCache: cacheStats })
    };
  }

  /**
   * Task 2.1.3: Get subscription statistics for monitoring.
   * Returns information about the subscription mode and RPC reduction.
   */
  getSubscriptionStats(): {
    mode: 'factory' | 'legacy' | 'none';
    legacySubscriptionCount: number;
    factorySubscriptionCount: number;
    monitoredPairs: number;
    rpcReductionRatio: number;
  } {
    return { ...this.subscriptionStats };
  }
}
