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
  WebSocketConfig,
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
  // P0-FIX: Import interface for type-safe wsManager cast
  FactoryWebSocketManager
} from '@arbitrage/core';

import {
  CHAINS,
  CORE_TOKENS,
  EVENT_SIGNATURES,
  DETECTOR_CONFIG,
  TOKEN_METADATA,
  ARBITRAGE_CONFIG,
  getEnabledDexes,
  dexFeeToPercentage,
  isEvmChain,
  // Task 2.1.3: Factory addresses for subscription
  getAllFactoryAddresses
} from '@arbitrage/config';

import {
  Dex,
  Token,
  PriceUpdate,
  ArbitrageOpportunity,
  SwapEvent,
  Pair
} from '@arbitrage/types';

import { ChainStats } from './unified-detector';
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
// REFACTOR: Import simulation handler for modular simulation logic
import {
  ChainSimulationHandler,
  PairForSimulation,
  SimulationCallbacks
} from './simulation';
// FIX Config 3.1/3.2: Import utility functions and constants
// P0-2 FIX: Import centralized validateFee (FIX 9.3)
import {
  parseIntEnvVar,
  parseFloatEnvVar,
  toWebSocketUrl,
  isUnstableChain,
  validateFee,
} from './types';
import {
  DEFAULT_SIMULATION_UPDATE_INTERVAL_MS,
  MIN_SIMULATION_UPDATE_INTERVAL_MS,
  MAX_SIMULATION_UPDATE_INTERVAL_MS,
  DEFAULT_SIMULATION_VOLATILITY,
  MIN_SIMULATION_VOLATILITY,
  MAX_SIMULATION_VOLATILITY,
  UNSTABLE_WEBSOCKET_CHAINS,
  DEFAULT_WS_CONNECTION_TIMEOUT_MS,
  EXTENDED_WS_CONNECTION_TIMEOUT_MS,
  WS_DISCONNECT_TIMEOUT_MS,
  SNAPSHOT_CACHE_TTL_MS,
  // Task 2.1.3: Factory subscription config
  DEFAULT_USE_FACTORY_SUBSCRIPTIONS,
  FACTORY_SUBSCRIPTION_ENABLED_CHAINS,
  DEFAULT_FACTORY_SUBSCRIPTION_ROLLOUT_PERCENT,
} from './constants';

// =============================================================================
// Types
// =============================================================================

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
}

interface ExtendedPair extends Pair {
  reserve0: string;
  reserve1: string;
  blockNumber: number;
  lastUpdate: number;
}

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

  private status: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
  private eventsProcessed: number = 0;
  private opportunitiesFound: number = 0;
  private lastBlockNumber: number = 0;
  private lastBlockTimestamp: number = 0;
  private blockLatencies: number[] = [];

  private isRunning: boolean = false;
  private isStopping: boolean = false;
  private reconnectAttempts: number = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;

  // P0-NEW-3/P0-NEW-4 FIX: Lifecycle promises to prevent race conditions
  // These ensure concurrent start/stop calls are handled correctly
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  // Simulation mode support
  private readonly simulationMode: boolean;
  // REFACTOR: Use ChainSimulationHandler instead of inline simulation code
  private simulationHandler: ChainSimulationHandler | null = null;

  // Triangular/Quadrilateral arbitrage detection
  private triangularDetector: CrossDexTriangularArbitrage;
  private lastTriangularCheck: number = 0;
  private readonly TRIANGULAR_CHECK_INTERVAL_MS = 500;

  // R3: Extracted detection modules
  private simpleArbitrageDetector: SimpleArbitrageDetector;
  private snapshotManager: SnapshotManager;

  // Multi-leg path finding (5-7 token paths)
  private multiLegPathFinder: MultiLegPathFinder | null = null;
  private lastMultiLegCheck: number = 0;
  private readonly MULTI_LEG_CHECK_INTERVAL_MS = 2000;

  // Swap event filtering and whale detection
  private swapEventFilter: SwapEventFilter | null = null;
  private whaleAlertUnsubscribe: (() => void) | null = null;

  // PHASE-3.3: Extracted whale alert publisher for cleaner separation
  private whaleAlertPublisher: WhaleAlertPublisher | null = null;

  // Pair activity tracking for volatility-based prioritization
  // Hot pairs (high update frequency) bypass time-based throttling
  private activityTracker: PairActivityTracker;

  // PERF-OPT: Snapshot caching to avoid O(N) iteration on every check
  // When multiple pairs update within a short window, reuse the cached snapshot
  private snapshotCache: Map<string, PairSnapshot> | null = null;
  // PERF 10.3: Cache DexPool[] array to avoid O(N) conversion on every triangular check
  private dexPoolCache: DexPool[] | null = null;
  private snapshotCacheTimestamp: number = 0;
  // FIX Perf 10.3: Version-based cache invalidation for accurate DexPool caching
  // Incremented when any pair is updated, used to detect stale DexPool cache
  private snapshotVersion: number = 0;
  private dexPoolCacheVersion: number = -1;

  // Task 2.1.3: Factory Subscription Configuration
  // Factory-level subscriptions for 40-50x RPC reduction
  private factorySubscriptionService: FactorySubscriptionService | null = null;
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
      this.logger.info('Running in SIMULATION MODE - no real blockchain connections', {
        chainId: this.chainId
      });
    }

    // Initialize triangular/quadrilateral arbitrage detector
    this.triangularDetector = new CrossDexTriangularArbitrage({
      minProfitThreshold: ARBITRAGE_CONFIG.minProfitPercentage || 0.003,
      maxSlippage: ARBITRAGE_CONFIG.slippageTolerance || 0.10
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

    // P0-FIX 1.1: Eagerly initialize factory event signature set to prevent race condition
    // Previously this was lazily initialized in isFactoryEventSignature(), which could cause
    // race conditions when multiple WebSocket messages arrive simultaneously during startup.
    // Set construction is fast (microseconds), so eager initialization has no performance impact.
    this.factoryEventSignatureSet = new Set([
      ...Object.values(FactoryEventSignatures),
      ...Object.values(AdditionalEventSignatures),
    ].map(s => s.toLowerCase()));
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

    this.logger.info('Starting ChainDetectorInstance', {
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
      // REFACTOR: Start non-EVM simulation via extracted handler
      await this.initializeNonEvmSimulationViaHandler();
      return;
    }

    this.status = 'connecting';
    this.emit('statusChange', this.status);

    try {
      // Initialize pairs first (needed for both real and simulated modes)
      await this.initializePairs();

      // Initialize multi-leg path finder for 5-7 token arbitrage
      this.multiLegPathFinder = getMultiLegPathFinder({
        minProfitThreshold: ARBITRAGE_CONFIG.minProfitPercentage || 0.005,
        maxPathLength: 7,
        minPathLength: 5,
        timeoutMs: 3000
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
        // REFACTOR: SIMULATION MODE via extracted handler
        await this.initializeEvmSimulationViaHandler();
      } else {
        // PRODUCTION MODE: Use real WebSocket and RPC connections
        // Initialize RPC provider
        this.provider = new ethers.JsonRpcProvider(this.chainConfig.rpcUrl);

        // Initialize WebSocket manager
        await this.initializeWebSocket();

        // Subscribe to events
        await this.subscribeToEvents();
      }

      this.isRunning = true;
      this.status = 'connected';
      this.reconnectAttempts = 0;
      this.emit('statusChange', this.status);

      this.logger.info('ChainDetectorInstance started', {
        pairsMonitored: this.pairs.size,
        mode: this.simulationMode ? 'SIMULATION' : 'PRODUCTION'
      });

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

    // REFACTOR: Stop simulation via extracted handler (handles both EVM and non-EVM)
    // FIX Inconsistency 6.1: Await async stop for consistency
    if (this.simulationHandler) {
      await this.simulationHandler.stop();
      this.simulationHandler = null;
    }

    // Task 2.1.3: Stop factory subscription service
    // P0-FIX 1.5: Await async stop to ensure cleanup completes before clearing pairs
    // Without await, factory events could arrive after pairsByAddress.clear() causing null dereference
    if (this.factorySubscriptionService) {
      await this.factorySubscriptionService.stop();
      this.factorySubscriptionService = null;
    }

    // P0-NEW-6 FIX: Disconnect WebSocket with timeout to prevent indefinite hangs
    if (this.wsManager) {
      // Remove all event listeners before disconnecting to prevent memory leak
      this.wsManager.removeAllListeners();
      try {
        await Promise.race([
          this.wsManager.disconnect(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('WebSocket disconnect timeout')), WS_DISCONNECT_TIMEOUT_MS)
          )
        ]);
      } catch (error) {
        this.logger.warn('WebSocket disconnect timeout or error', { error: (error as Error).message });
      }
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
    // R3 Refactor: Clear SnapshotManager caches
    this.snapshotManager.clear();
    // PERF-OPT: Clear local snapshot cache to free memory (legacy - kept for safety)
    this.snapshotCache = null;
    this.snapshotCacheTimestamp = 0;
    // FIX Perf 10.3: Reset version counters for clean restart
    this.snapshotVersion = 0;
    this.dexPoolCacheVersion = -1;
    this.dexPoolCache = null;
    // P0-FIX 1.1: factoryEventSignatureSet is now readonly and initialized in constructor
    // It will be garbage collected when the instance is destroyed, no need to clear

    // Clear latency tracking (P0-NEW-1 FIX: ensure cleanup)
    this.blockLatencies = [];

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

    this.status = 'disconnected';
    this.isStopping = false; // Reset for potential restart
    this.emit('statusChange', this.status);

    this.logger.info('ChainDetectorInstance stopped');
  }

  // ===========================================================================
  // Simulation Mode (REFACTORED to use ChainSimulationHandler)
  // ===========================================================================

  /**
   * Initialize non-EVM simulation via the extracted ChainSimulationHandler.
   * Replaces inline initializeNonEvmSimulation() for cleaner separation.
   */
  private async initializeNonEvmSimulationViaHandler(): Promise<void> {
    // Create handler instance
    this.simulationHandler = new ChainSimulationHandler(this.chainId, this.logger);

    // Get configured DEXes and tokens
    const dexNames = this.dexes.map(d => d.name);
    const tokenSymbols = this.tokens.map(t => t.symbol);

    // FIX Config 3.1: Validate simulation env vars to prevent unsafe values (e.g., interval=1ms causing CPU overload)
    const updateIntervalMs = parseIntEnvVar(
      process.env.SIMULATION_UPDATE_INTERVAL_MS,
      DEFAULT_SIMULATION_UPDATE_INTERVAL_MS,
      MIN_SIMULATION_UPDATE_INTERVAL_MS,
      MAX_SIMULATION_UPDATE_INTERVAL_MS
    );
    const volatility = parseFloatEnvVar(
      process.env.SIMULATION_VOLATILITY,
      DEFAULT_SIMULATION_VOLATILITY,
      MIN_SIMULATION_VOLATILITY,
      MAX_SIMULATION_VOLATILITY
    );

    // Initialize via handler with callbacks
    await this.simulationHandler.initializeNonEvmSimulation(
      {
        chainId: this.chainId,
        dexes: dexNames,
        tokens: tokenSymbols,
        updateIntervalMs,
        volatility,
        logger: this.logger
      },
      this.createSimulationCallbacks()
    );
  }

  /**
   * Initialize EVM simulation via the extracted ChainSimulationHandler.
   * Replaces inline initializeSimulation() for cleaner separation.
   */
  private async initializeEvmSimulationViaHandler(): Promise<void> {
    // Create handler instance
    this.simulationHandler = new ChainSimulationHandler(this.chainId, this.logger);

    // Build pairs for simulation from initialized pairs
    const pairsForSimulation = this.buildPairsForSimulation();

    if (pairsForSimulation.length === 0) {
      this.logger.warn('No pairs available for simulation', { chainId: this.chainId });
      return;
    }

    // Initialize via handler with callbacks
    await this.simulationHandler.initializeEvmSimulation(
      pairsForSimulation,
      this.createSimulationCallbacks()
    );
  }

  /**
   * Build PairForSimulation array from initialized pairs.
   * Used by EVM simulation to configure the ChainSimulator.
   */
  private buildPairsForSimulation(): PairForSimulation[] {
    const pairsForSimulation: PairForSimulation[] = [];

    for (const [pairKey, pair] of this.pairs) {
      // Extract token symbols from pair key (format: dex_TOKEN0_TOKEN1)
      const parts = pairKey.split('_');
      if (parts.length < 3) continue;

      const token0Symbol = parts[1];
      const token1Symbol = parts[2];

      // PERF-OPT: Use O(1) Map lookup instead of O(N) array.find()
      const token0 = this.tokensByAddress.get(pair.token0.toLowerCase());
      const token1 = this.tokensByAddress.get(pair.token1.toLowerCase());

      pairsForSimulation.push({
        key: pairKey,
        address: pair.address,
        dex: pair.dex,
        token0Symbol,
        token1Symbol,
        token0Decimals: token0?.decimals ?? 18,
        token1Decimals: token1?.decimals ?? 18,
        fee: pair.fee ?? 0.003  // Default 0.3% fee
      });
    }

    return pairsForSimulation;
  }

  /**
   * Create simulation callbacks that update instance state.
   * These callbacks bridge the ChainSimulationHandler to this instance's state.
   */
  private createSimulationCallbacks(): SimulationCallbacks {
    return {
      onPriceUpdate: (update: PriceUpdate) => {
        this.emit('priceUpdate', update);
      },

      onOpportunity: (opportunity: ArbitrageOpportunity) => {
        this.opportunitiesFound++;
        this.emit('opportunity', opportunity);
        this.logger.debug('Simulated opportunity detected', {
          id: opportunity.id,
          profit: `${(opportunity.profitPercentage ?? 0).toFixed(2)}%`
        });
      },

      onBlockUpdate: (blockNumber: number) => {
        this.lastBlockNumber = blockNumber;
        this.lastBlockTimestamp = Date.now();
      },

      onEventProcessed: () => {
        this.eventsProcessed++;
      },

      // EVM simulation: Handle sync events through pair state management
      onSyncEvent: (event) => {
        this.handleSimulatedSyncEvent(event);
      }
    };
  }

  /**
   * Handle simulated Sync events from the ChainSimulationHandler.
   * Updates pair state and emits price updates (same as real Sync events).
   */
  private handleSimulatedSyncEvent(event: { address: string; reserve0: string; reserve1: string; blockNumber: number }): void {
    const pairAddress = event.address.toLowerCase();
    const pair = this.pairsByAddress.get(pairAddress);

    if (!pair) {
      return; // Unknown pair, skip
    }

    try {
      const { reserve0, reserve1, blockNumber } = event;

      // Update pair reserves (using Object.assign for atomicity)
      Object.assign(pair, {
        reserve0,
        reserve1,
        blockNumber,
        lastUpdate: Date.now()
      });

      // FIX Bug 4.2 & Race 5.1: Atomic snapshot cache invalidation (same as handleSyncEvent)
      // R3 Refactor: Delegate cache invalidation to SnapshotManager
      this.snapshotManager.invalidateCache();
      this.snapshotVersion++;
      this.snapshotCache = null;
      this.dexPoolCache = null;

      // Calculate price and emit price update
      const price = calculatePriceFromBigIntReserves(
        BigInt(reserve0),
        BigInt(reserve1)
      );

      // Skip if price calculation failed
      if (price === null) {
        return;
      }

      const priceUpdate: PriceUpdate = {
        chain: this.chainId,
        dex: pair.dex,
        pairKey: `${pair.dex}_${pair.token0}_${pair.token1}`,
        token0: pair.token0,
        token1: pair.token1,
        price,
        reserve0,
        reserve1,
        blockNumber,
        timestamp: Date.now(),
        latency: 0  // Simulated events have zero latency
      };

      this.emit('priceUpdate', priceUpdate);

    } catch (error) {
      this.logger.error('Error processing simulated sync event', { error, pairAddress });
    }
  }

  // ===========================================================================
  // WebSocket Management
  // ===========================================================================

  private async initializeWebSocket(): Promise<void> {
    // FIX Refactor 9.1: Use extracted utility for WebSocket URL validation
    let primaryWsUrl: string;

    if (this.chainConfig.wsUrl) {
      // Validate existing WebSocket URL
      const result = toWebSocketUrl(this.chainConfig.wsUrl);
      primaryWsUrl = result.url;
    } else {
      // Try to convert RPC URL to WebSocket
      try {
        const result = toWebSocketUrl(this.chainConfig.rpcUrl);
        primaryWsUrl = result.url;
        if (result.converted) {
          this.logger.warn('Converting RPC URL to WebSocket URL', {
            original: result.originalUrl,
            converted: result.url
          });
        }
      } catch (error) {
        throw new Error(`No valid WebSocket URL available for chain ${this.chainId}. wsUrl: ${this.chainConfig.wsUrl}, rpcUrl: ${this.chainConfig.rpcUrl}`);
      }
    }

    // FIX Config 3.2: Use centralized UNSTABLE_WEBSOCKET_CHAINS constant
    const connectionTimeout = isUnstableChain(this.chainId, UNSTABLE_WEBSOCKET_CHAINS)
      ? EXTENDED_WS_CONNECTION_TIMEOUT_MS
      : DEFAULT_WS_CONNECTION_TIMEOUT_MS;

    const wsConfig: WebSocketConfig = {
      url: primaryWsUrl,
      fallbackUrls: this.chainConfig.wsFallbackUrls,
      reconnectInterval: 5000,
      maxReconnectAttempts: this.MAX_RECONNECT_ATTEMPTS,
      pingInterval: 30000,
      connectionTimeout,
      chainId: this.chainId  // FIX: Enable chain-specific staleness detection
    };

    this.wsManager = new WebSocketManager(wsConfig);
    this.logger.info(`WebSocket configured with ${1 + (this.chainConfig.wsFallbackUrls?.length || 0)} URL(s)`);

    // Set up WebSocket event handlers
    this.wsManager.on('message', (message) => {
      this.handleWebSocketMessage(message);
    });

    this.wsManager.on('error', (error) => {
      this.logger.error('WebSocket error', { error });
      this.handleConnectionError(error);
    });

    this.wsManager.on('disconnected', () => {
      this.logger.warn('WebSocket disconnected');
      if (this.isRunning) {
        this.status = 'connecting';
        this.emit('statusChange', this.status);
      }
    });

    this.wsManager.on('connected', () => {
      this.logger.info('WebSocket connected');
      this.status = 'connected';
      this.reconnectAttempts = 0;
      this.emit('statusChange', this.status);
    });

    await this.wsManager.connect();
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

  private async initializePairs(): Promise<void> {
    // This is a simplified version - in production would query DEX factories
    // For now, create pairs from token combinations
    // Note: this.dexes is already filtered by getEnabledDexes() in constructor

    for (const dex of this.dexes) {
      for (let i = 0; i < this.tokens.length; i++) {
        for (let j = i + 1; j < this.tokens.length; j++) {
          const token0 = this.tokens[i];
          const token1 = this.tokens[j];

          // Generate a deterministic pair address (placeholder)
          const pairAddress = this.generatePairAddress(dex.factoryAddress, token0.address, token1.address);

          // Convert fee from basis points to percentage for pair storage
          // Config stores fees in basis points (30 = 0.30%), Pair uses percentage (0.003)
          // S2.2.3 FIX: Use ?? instead of ternary to correctly handle fee: 0
          // Validate fee at source to catch config errors early
          const feePercentage = validateFee(dexFeeToPercentage(dex.fee ?? 30));

          const pair: ExtendedPair = {
            address: pairAddress,
            dex: dex.name,
            token0: token0.address,
            token1: token1.address,
            fee: feePercentage,
            reserve0: '0',
            reserve1: '0',
            blockNumber: 0,
            lastUpdate: 0
          };

          const pairKey = `${dex.name}_${token0.symbol}_${token1.symbol}`;
          this.pairs.set(pairKey, pair);
          this.pairsByAddress.set(pairAddress.toLowerCase(), pair);

          // P0-PERF FIX: Add to token-indexed lookup for O(1) arbitrage detection
          const tokenKey = this.getTokenPairKey(token0.address, token1.address);
          let pairsForTokens = this.pairsByTokens.get(tokenKey);
          if (!pairsForTokens) {
            pairsForTokens = [];
            this.pairsByTokens.set(tokenKey, pairsForTokens);
          }
          pairsForTokens.push(pair);
        }
      }
    }

    // P2-FIX 3.3: Build cached pair addresses array once after loading all pairs
    // This avoids repeated Array.from() calls in subscription methods
    this.pairAddressesCache = Array.from(this.pairsByAddress.keys());

    this.logger.info(`Initialized ${this.pairs.size} pairs for monitoring`, {
      tokenPairGroups: this.pairsByTokens.size
    });
  }

  private generatePairAddress(factory: string, token0: string, token1: string): string {
    // Generate deterministic address based on factory and tokens
    // This is a simplified version - real implementation would use CREATE2
    const hash = ethers.keccak256(
      ethers.solidityPacked(
        ['address', 'address', 'address'],
        [factory, token0, token1]
      )
    );
    return '0x' + hash.slice(26);
  }

  // ===========================================================================
  // Event Subscription (Task 2.1.3: Factory Subscription Migration)
  // ===========================================================================

  /**
   * Task 2.1.3: Determine if factory subscriptions should be used for this chain.
   * Supports gradual rollout via explicit chain list or percentage-based rollout.
   */
  private shouldUseFactorySubscriptions(): boolean {
    // Check if explicitly disabled via config flag
    if (!this.subscriptionConfig.useFactorySubscriptions) {
      return false;
    }

    // If explicit chain list is provided, only enable for those chains
    const enabledChains = this.subscriptionConfig.factorySubscriptionEnabledChains;
    if (enabledChains && enabledChains.length > 0) {
      return enabledChains.includes(this.chainId);
    }

    // Check rollout percentage
    const rolloutPercent = this.subscriptionConfig.factorySubscriptionRolloutPercent;
    if (rolloutPercent !== undefined && rolloutPercent < 100) {
      // Use deterministic hash of chain name for consistent rollout
      const chainHash = this.hashChainName(this.chainId);
      return (chainHash % 100) < rolloutPercent;
    }

    // Default: if flag is true but no specific config, enable for all
    return this.subscriptionConfig.useFactorySubscriptions;
  }

  /**
   * Task 2.1.3: Deterministic hash for chain name (for rollout percentage).
   */
  private hashChainName(chain: string): number {
    let hash = 0;
    for (let i = 0; i < chain.length; i++) {
      hash = ((hash << 5) - hash + chain.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  }

  private async subscribeToEvents(): Promise<void> {
    if (!this.wsManager) return;

    // Task 2.1.3: Choose subscription mode based on config
    if (this.shouldUseFactorySubscriptions()) {
      await this.subscribeViaFactoryMode();
    } else {
      await this.subscribeViaLegacyMode();
    }
  }

  /**
   * Task 2.1.3: Factory-level subscription mode.
   * Subscribes to factory PairCreated events for dynamic pair discovery.
   * Achieves 40-50x RPC reduction compared to legacy pair-level subscriptions.
   */
  private async subscribeViaFactoryMode(): Promise<void> {
    if (!this.wsManager) return;

    const factoryAddresses = getAllFactoryAddresses(this.chainId);

    if (factoryAddresses.length === 0) {
      this.logger.warn('No factory addresses found, falling back to legacy mode', {
        chainId: this.chainId
      });
      await this.subscribeViaLegacyMode();
      return;
    }

    // Create factory subscription service
    this.factorySubscriptionService = new FactorySubscriptionService(
      {
        chain: this.chainId,
        enabled: true,
        customFactories: factoryAddresses
      },
      {
        logger: this.logger,
        // P0-FIX: Type assertion required because WebSocketManager.isConnected is private
        // and the public method is isWebSocketConnected(). The subscribe signature is compatible.
        wsManager: this.wsManager as unknown as FactoryWebSocketManager | undefined
      }
    );

    // Register callback for new pairs discovered via factory events
    this.factorySubscriptionService.onPairCreated((event: PairCreatedEvent) => {
      this.handlePairCreatedEvent(event);
    });

    // Subscribe to factories
    await this.factorySubscriptionService.subscribeToFactories();

    // Still subscribe to Sync/Swap events for existing pairs
    // These use the pair addresses we already have
    // P2-FIX 3.3: Use cached array instead of repeated Array.from()
    const pairAddresses = this.pairAddressesCache;

    if (pairAddresses.length > 0) {
      // Subscribe to Sync events for existing pairs
      await this.wsManager.subscribe({
        method: 'eth_subscribe',
        params: ['logs', { topics: [EVENT_SIGNATURES.SYNC], address: pairAddresses }],
        type: 'logs',
        topics: [EVENT_SIGNATURES.SYNC],
        callback: (log) => this.handleSyncEvent(log)
      });

      // Subscribe to Swap events for existing pairs
      await this.wsManager.subscribe({
        method: 'eth_subscribe',
        params: ['logs', { topics: [EVENT_SIGNATURES.SWAP_V2], address: pairAddresses }],
        type: 'logs',
        topics: [EVENT_SIGNATURES.SWAP_V2],
        callback: (log) => this.handleSwapEvent(log)
      });
    }

    // Subscribe to new blocks for latency tracking
    await this.wsManager.subscribe({
      method: 'eth_subscribe',
      params: ['newHeads'],
      type: 'newHeads',
      callback: (block) => this.handleNewBlock(block)
    });

    // Update subscription stats
    this.subscriptionStats = {
      mode: 'factory',
      legacySubscriptionCount: pairAddresses.length > 0 ? 3 : 1, // Sync, Swap, newHeads or just newHeads
      factorySubscriptionCount: this.factorySubscriptionService.getSubscriptionCount(),
      monitoredPairs: pairAddresses.length,
      rpcReductionRatio: pairAddresses.length / Math.max(factoryAddresses.length, 1)
    };

    this.logger.info('Subscribed via factory mode', {
      chainId: this.chainId,
      factories: factoryAddresses.length,
      existingPairs: pairAddresses.length,
      rpcReduction: `${this.subscriptionStats.rpcReductionRatio.toFixed(1)}x`
    });
  }

  /**
   * Task 2.1.3: Legacy pair-level subscription mode (backward compatible).
   * Subscribes to Sync/Swap events for all known pair addresses.
   */
  private async subscribeViaLegacyMode(): Promise<void> {
    if (!this.wsManager) return;

    // Get monitored pair addresses for filtering
    // P2-FIX 3.3: Use cached array instead of repeated Array.from()
    const pairAddresses = this.pairAddressesCache;

    // Subscribe to Sync events
    await this.wsManager.subscribe({
      method: 'eth_subscribe',
      params: ['logs', { topics: [EVENT_SIGNATURES.SYNC], address: pairAddresses }],
      type: 'logs',
      topics: [EVENT_SIGNATURES.SYNC],
      callback: (log) => this.handleSyncEvent(log)
    });

    // Subscribe to Swap events
    await this.wsManager.subscribe({
      method: 'eth_subscribe',
      params: ['logs', { topics: [EVENT_SIGNATURES.SWAP_V2], address: pairAddresses }],
      type: 'logs',
      topics: [EVENT_SIGNATURES.SWAP_V2],
      callback: (log) => this.handleSwapEvent(log)
    });

    // Subscribe to new blocks for latency tracking
    await this.wsManager.subscribe({
      method: 'eth_subscribe',
      params: ['newHeads'],
      type: 'newHeads',
      callback: (block) => this.handleNewBlock(block)
    });

    // Update subscription stats
    this.subscriptionStats = {
      mode: 'legacy',
      legacySubscriptionCount: 3, // Sync, Swap, newHeads
      factorySubscriptionCount: 0,
      monitoredPairs: pairAddresses.length,
      rpcReductionRatio: 1 // No reduction in legacy mode
    };

    this.logger.info('Subscribed via legacy mode', {
      chainId: this.chainId,
      pairs: pairAddresses.length
    });
  }

  /**
   * Task 2.1.3: Handle PairCreated events from factory subscriptions.
   * Dynamically adds new pairs to monitoring without restart.
   */
  private handlePairCreatedEvent(event: PairCreatedEvent): void {
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
    const pairKey = `${event.dexName}_${token0Symbol}_${token1Symbol}`;
    const pairName = `${token0Symbol}/${token1Symbol}`;

    const newPair: ExtendedPair = {
      name: pairName,
      dex: event.dexName,
      token0: event.token0.toLowerCase(),
      token1: event.token1.toLowerCase(),
      address: pairAddressLower,
      fee: event.fee ? dexFeeToPercentage(event.fee) : 0.003, // Convert basis points to percentage
      reserve0: '0',
      reserve1: '0',
      blockNumber: event.blockNumber,
      lastUpdate: Date.now()
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
  // Event Handlers
  // ===========================================================================

  // P2 FIX: Use WebSocketMessage type instead of any
  private handleWebSocketMessage(message: WebSocketMessage): void {
    // P0-FIX 1.4: Guard against processing during shutdown
    // This prevents race conditions where WebSocket messages arrive after stop() is called
    // but before the WebSocket connection is fully disconnected
    if (this.isStopping || !this.isRunning) return;

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
          } else if (this.factorySubscriptionService && this.shouldUseFactorySubscriptions()) {
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
        const reserve0 = BigInt('0x' + data.slice(2, 66)).toString();
        const reserve1 = BigInt('0x' + data.slice(66, 130)).toString();

        // Record activity AFTER successful parsing (race condition fix)
        // Use chain:address format to avoid cross-chain address collisions in shared tracker
        this.activityTracker.recordUpdate(`${this.chainId}:${pairAddress}`);

        // P1-9 FIX: Use Object.assign for atomic pair updates
        // This prevents partial updates if concurrent access occurs during
        // initialization or other event handling
        Object.assign(pair, {
          reserve0,
          reserve1,
          blockNumber: parseInt(log.blockNumber, 16),
          lastUpdate: Date.now()
        });

        // FIX Bug 4.2 & Race 5.1: Atomic snapshot cache invalidation
        // Increment version FIRST, then invalidate cache
        // This ensures any concurrent reader sees the new version before cache is cleared
        // The reader will either: (a) see old version + old cache (valid), or
        // (b) see new version + null cache (will rebuild)
        // Never: (c) see old version + null cache (which would cause stale rebuild)
        // R3 Refactor: Delegate cache invalidation to SnapshotManager
        this.snapshotManager.invalidateCache();
        this.snapshotVersion++;
        this.snapshotCache = null;
        this.dexPoolCache = null; // Also invalidate DexPool cache

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

      // Build complete SwapEvent with decoded amounts
      const amount0In = log.data ? BigInt('0x' + log.data.slice(2, 66)).toString() : '0';
      const amount1In = log.data ? BigInt('0x' + log.data.slice(66, 130)).toString() : '0';
      const amount0Out = log.data ? BigInt('0x' + log.data.slice(130, 194)).toString() : '0';
      const amount1Out = log.data ? BigInt('0x' + log.data.slice(194, 258)).toString() : '0';

      // PHASE-3.3: Create pair info for USD value estimation
      const pairInfo: ExtendedPairInfo = {
        address: pair.address,
        dex: pair.dex,
        token0: pair.token0,
        token1: pair.token1,
        reserve0: pair.reserve0,
        reserve1: pair.reserve1
      };

      // FIX Bug 4.2: Ensure USD value estimation is available for whale detection
      // If whaleAlertPublisher is null but swapEventFilter is not, whale detection won't work properly
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
      this.blockLatencies.push(latency);

      // Keep only last 100 latencies
      if (this.blockLatencies.length > 100) {
        this.blockLatencies.shift();
      }
    }

    this.lastBlockNumber = blockNumber;
    this.lastBlockTimestamp = now;
  }

  // ===========================================================================
  // Price Update & Arbitrage Detection
  // ===========================================================================

  private emitPriceUpdate(pair: ExtendedPair): void {
    const reserve0 = BigInt(pair.reserve0);
    const reserve1 = BigInt(pair.reserve1);

    if (reserve0 === 0n || reserve1 === 0n) return;

    // P0-1 FIX: Use precision-safe price calculation to prevent precision loss
    // for large BigInt values (reserves can be > 2^53)
    const price = calculatePriceFromBigIntReserves(reserve0, reserve1);
    if (price === null) return;

    const priceUpdate: PriceUpdate = {
      chain: this.chainId,
      dex: pair.dex,
      pairKey: this.getPairKey(pair),
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
      fee: pair.fee
    };

    // Publish to Redis Streams
    this.publishPriceUpdate(priceUpdate);

    this.emit('priceUpdate', priceUpdate);
  }

  private async publishPriceUpdate(update: PriceUpdate): Promise<void> {
    try {
      await this.streamsClient.xadd(
        RedisStreamsClient.STREAMS.PRICE_UPDATES,
        update
      );
    } catch (error) {
      this.logger.error('Failed to publish price update', { error });
    }
  }

  /**
   * Create a deep snapshot of a single pair for thread-safe arbitrage detection.
   *
   * R3 Refactor: Delegates to extracted SnapshotManager.
   */
  private createPairSnapshot(pair: ExtendedPair): PairSnapshot | null {
    // R3: Delegate to snapshot manager with fee validation
    const snapshot = this.snapshotManager.createPairSnapshot(pair);
    if (snapshot) {
      // Apply local fee validation
      snapshot.fee = validateFee(pair.fee);
    }
    return snapshot;
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
    const matchingPairs = this.pairsByTokens.get(tokenKey) || [];

    // Iterate only matching pairs (O(k) where k is typically 2-5)
    for (const otherPair of matchingPairs) {
      // Skip same pair (same address)
      if (otherPair.address.toLowerCase() === currentSnapshot.address.toLowerCase()) continue;

      // Skip same DEX - arbitrage requires different DEXes
      if (otherPair.dex === currentSnapshot.dex) continue;

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
    const now = Date.now();

    // VOLATILITY-OPT: Hot pairs (high activity) bypass time-based throttling
    // This ensures we catch arbitrage opportunities on rapidly-updating pairs
    // Use chain:address format to match recordUpdate format
    const isHotPair = this.activityTracker.isHotPair(`${this.chainId}:${updatedPair.address}`);

    // Time-based throttle OR hot pair override
    const shouldCheckTriangular = isHotPair || (now - this.lastTriangularCheck >= this.TRIANGULAR_CHECK_INTERVAL_MS);
    const shouldCheckMultiLeg = isHotPair || (now - this.lastMultiLegCheck >= this.MULTI_LEG_CHECK_INTERVAL_MS);

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
   * Check if two pairs represent the same token pair (in either order).
   * Returns { sameOrder: boolean, reverseOrder: boolean }
   */
  private isSameTokenPair(pair1: PairSnapshot, pair2: PairSnapshot): boolean {
    const token1_0 = pair1.token0.toLowerCase();
    const token1_1 = pair1.token1.toLowerCase();
    const token2_0 = pair2.token0.toLowerCase();
    const token2_1 = pair2.token1.toLowerCase();

    return (
      (token1_0 === token2_0 && token1_1 === token2_1) ||
      (token1_0 === token2_1 && token1_1 === token2_0)
    );
  }

  /**
   * Check if token order is reversed between two pairs.
   */
  private isReverseOrder(pair1: PairSnapshot, pair2: PairSnapshot): boolean {
    const token1_0 = pair1.token0.toLowerCase();
    const token1_1 = pair1.token1.toLowerCase();
    const token2_0 = pair2.token0.toLowerCase();
    const token2_1 = pair2.token1.toLowerCase();

    return token1_0 === token2_1 && token1_1 === token2_0;
  }

  /**
   * P0-PERF FIX: Generate normalized key for token pair lookup.
   * Orders addresses alphabetically for consistent matching regardless of token order.
   * This enables O(1) lookup of all pairs containing the same token pair.
   */
  private getTokenPairKey(token0: string, token1: string): string {
    const t0 = token0.toLowerCase();
    const t1 = token1.toLowerCase();
    return t0 < t1 ? `${t0}_${t1}` : `${t1}_${t0}`;
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

  private async emitOpportunity(opportunity: ArbitrageOpportunity): Promise<void> {
    try {
      await this.streamsClient.xadd(
        RedisStreamsClient.STREAMS.OPPORTUNITIES,
        opportunity
      );

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
    if (!forceCheck && now - this.lastTriangularCheck < this.TRIANGULAR_CHECK_INTERVAL_MS) {
      return;
    }
    this.lastTriangularCheck = now;

    if (pairsSnapshot.size < 3) return;

    // R3 Refactor: Delegate DexPool caching to SnapshotManager
    // SnapshotManager handles version-based cache invalidation (Race 5.1, Perf 10.3)
    const pools = this.snapshotManager.getDexPools(pairsSnapshot);

    // BUG-1 FIX: Use token addresses instead of symbols
    // DexPool.token0/token1 contain addresses, so baseTokens must also be addresses
    // for the findReachableTokens() token matching to work correctly
    const baseTokens = this.tokens.slice(0, 4).map(t => t.address.toLowerCase());

    try {
      // Find triangular opportunities (3-token cycles)
      const triangularOpps = await this.triangularDetector.findTriangularOpportunities(
        this.chainId, pools, baseTokens
      );

      for (const opp of triangularOpps) {
        await this.emitTriangularOpportunity(opp, 'triangular');
      }

      // Find quadrilateral opportunities (4-token cycles) if enough pools
      if (pools.length >= 4) {
        const quadOpps = await this.triangularDetector.findQuadrilateralOpportunities(
          this.chainId, pools, baseTokens
        );
        for (const opp of quadOpps) {
          await this.emitTriangularOpportunity(opp, 'quadrilateral');
        }
      }
    } catch (error) {
      this.logger.error('Triangular/quadrilateral detection failed', { error });
    }
  }

  /**
   * Emit a triangular or quadrilateral arbitrage opportunity.
   */
  private async emitTriangularOpportunity(
    opp: TriangularOpportunity | QuadrilateralOpportunity,
    type: 'triangular' | 'quadrilateral'
  ): Promise<void> {
    // CRITICAL FIX: Extract tokenIn, tokenOut, amountIn from steps for execution engine
    // For cycles: tokenIn = tokenOut = starting token (we end up with same token)
    const firstStep = opp.steps[0];
    const tokenIn = firstStep?.fromToken || opp.path[0];
    const tokenOut = opp.path[opp.path.length - 1] || opp.path[0]; // Should be same as path[0] for cycles
    const amountIn = firstStep?.amountIn || 0;

    const opportunity: ArbitrageOpportunity = {
      id: opp.id,
      type,
      chain: this.chainId,
      buyDex: opp.steps[0]?.dex || '',
      sellDex: opp.steps[opp.steps.length - 1]?.dex || '',
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
    await this.emitOpportunity(opportunity);

    this.logger.debug(`${type} opportunity detected`, {
      id: opp.id,
      profit: `${opp.profitPercentage.toFixed(2)}%`,
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
    if (!forceCheck && now - this.lastMultiLegCheck < this.MULTI_LEG_CHECK_INTERVAL_MS) {
      return;
    }

    if (pairsSnapshot.size < 5 || !this.multiLegPathFinder) return;
    this.lastMultiLegCheck = now;

    // R3 Refactor: Delegate DexPool caching to SnapshotManager
    // SnapshotManager handles version-based cache invalidation (Race 5.1, Perf 10.3)
    const pools = this.snapshotManager.getDexPools(pairsSnapshot);

    // BUG-1 FIX: Use token addresses instead of symbols (same fix as triangular)
    const baseTokens = this.tokens.slice(0, 4).map(t => t.address.toLowerCase());

    try {
      // Use async version to offload to worker thread
      const opportunities = await this.multiLegPathFinder.findMultiLegOpportunitiesAsync(
        this.chainId, pools, baseTokens, 5
      );

      for (const opp of opportunities) {
        await this.emitMultiLegOpportunity(opp);
      }
    } catch (error) {
      this.logger.error('Multi-leg path finding failed', { error });
    }
  }

  /**
   * Emit a multi-leg arbitrage opportunity.
   */
  private async emitMultiLegOpportunity(opp: MultiLegOpportunity): Promise<void> {
    // CRITICAL FIX: Extract tokenIn, tokenOut, amountIn from steps for execution engine
    // For cycles: tokenIn = tokenOut = starting token (we end up with same token)
    const firstStep = opp.steps[0];
    const tokenIn = firstStep?.fromToken || opp.path[0];
    const tokenOut = opp.path[opp.path.length - 1] || opp.path[0]; // Should be same as path[0] for cycles
    const amountIn = firstStep?.amountIn || 0;

    const opportunity: ArbitrageOpportunity = {
      id: opp.id,
      type: 'multi-leg',
      chain: this.chainId,
      buyDex: opp.steps[0]?.dex || '',
      sellDex: opp.steps[opp.steps.length - 1]?.dex || '',
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
    await this.emitOpportunity(opportunity);

    this.logger.debug('Multi-leg opportunity detected', {
      id: opp.id,
      profit: `${opp.profitPercentage.toFixed(2)}%`,
      pathLength: opp.path.length,
      path: opp.path.join(' → ')
    });
  }

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
    const avgLatency = this.blockLatencies.length > 0
      ? this.blockLatencies.reduce((a, b) => a + b, 0) / this.blockLatencies.length
      : 0;

    // FIX 10.4: Include hot pairs count for monitoring volatility-based prioritization
    const activityStats = this.activityTracker.getStats();

    return {
      chainId: this.chainId,
      status: this.status,
      eventsProcessed: this.eventsProcessed,
      opportunitiesFound: this.opportunitiesFound,
      lastBlockNumber: this.lastBlockNumber,
      avgBlockLatencyMs: avgLatency,
      pairsMonitored: this.pairs.size,
      hotPairsCount: activityStats.hotPairs
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
