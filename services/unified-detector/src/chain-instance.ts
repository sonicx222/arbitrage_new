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
  ChainSimulator,
  getChainSimulator,
  stopChainSimulator,
  SimulatedPairConfig,
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
  WhaleAlert
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
  isEvmChain
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
}

interface ExtendedPair extends Pair {
  reserve0: string;
  reserve1: string;
  blockNumber: number;
  lastUpdate: number;
}

/**
 * Snapshot of pair data for thread-safe arbitrage detection.
 * Captures reserve values at a point in time to avoid race conditions
 * when reserves are updated by concurrent Sync events.
 */
interface PairSnapshot {
  address: string;
  dex: string;
  token0: string;
  token1: string;
  reserve0: string;
  reserve1: string;
  fee: number;
  blockNumber: number;
}

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
  // P2 FIX: Use TokenMetadata type instead of any
  private tokenMetadata: TokenMetadata | undefined;

  private pairs: Map<string, ExtendedPair> = new Map();
  private pairsByAddress: Map<string, ExtendedPair> = new Map();
  // P0-PERF FIX: Token-indexed lookup for O(1) arbitrage pair matching
  // Key: normalized "token0_token1" where addresses are lowercase and alphabetically ordered
  private pairsByTokens: Map<string, ExtendedPair[]> = new Map();

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
  private chainSimulator: ChainSimulator | null = null;

  // Triangular/Quadrilateral arbitrage detection
  private triangularDetector: CrossDexTriangularArbitrage;
  private lastTriangularCheck: number = 0;
  private readonly TRIANGULAR_CHECK_INTERVAL_MS = 500;

  // Multi-leg path finding (5-7 token paths)
  private multiLegPathFinder: MultiLegPathFinder | null = null;
  private lastMultiLegCheck: number = 0;
  private readonly MULTI_LEG_CHECK_INTERVAL_MS = 2000;

  // Swap event filtering and whale detection
  private swapEventFilter: SwapEventFilter | null = null;
  private whaleAlertUnsubscribe: (() => void) | null = null;

  // PHASE-3.3: Extracted whale alert publisher for cleaner separation
  private whaleAlertPublisher: WhaleAlertPublisher | null = null;

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
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  async start(): Promise<void> {
    // P0-NEW-3 FIX: Return existing promise if start is already in progress
    if (this.startPromise) {
      return this.startPromise;
    }

    // P0-NEW-4 FIX: Wait for any pending stop operation to complete
    if (this.stopPromise) {
      await this.stopPromise;
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

    // P0-NEW-3 FIX: Create and store the start promise for concurrent callers
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
      // Start simplified non-EVM simulation (generates periodic price updates)
      await this.initializeNonEvmSimulation();
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
      this.whaleAlertUnsubscribe = this.swapEventFilter.onWhaleAlert((alert: WhaleAlert) => {
        this.whaleAlertPublisher?.publishWhaleAlert(alert).catch(error => {
          this.logger.error('Failed to publish whale alert', { error: (error as Error).message });
        });
      });

      if (this.simulationMode) {
        // SIMULATION MODE: Use ChainSimulator instead of real connections
        await this.initializeSimulation();
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
    // P0-NEW-4 FIX: Return existing promise if stop is already in progress
    // This allows concurrent callers to await the same stop operation
    if (this.stopPromise) {
      return this.stopPromise;
    }

    // Guard: Can't stop if not running and not stopping
    if (!this.isRunning && !this.isStopping) {
      return;
    }

    // P0-NEW-4 FIX: Create and store the stop promise for concurrent callers
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

    // Stop non-EVM simulation interval if running
    if (this.nonEvmSimulationInterval) {
      clearInterval(this.nonEvmSimulationInterval);
      this.nonEvmSimulationInterval = null;
    }

    // Stop chain simulator if running
    if (this.chainSimulator) {
      this.chainSimulator.removeAllListeners();
      this.chainSimulator.stop();
      this.chainSimulator = null;
      // Also cleanup the global simulator for this chain
      stopChainSimulator(this.chainId);
    }

    // P0-NEW-6 FIX: Disconnect WebSocket with timeout to prevent indefinite hangs
    if (this.wsManager) {
      // Remove all event listeners before disconnecting to prevent memory leak
      this.wsManager.removeAllListeners();
      try {
        await Promise.race([
          this.wsManager.disconnect(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('WebSocket disconnect timeout')), 5000)
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

    // Clear pairs
    this.pairs.clear();
    this.pairsByAddress.clear();
    this.pairsByTokens.clear();

    // Clear latency tracking (P0-NEW-1 FIX: ensure cleanup)
    this.blockLatencies = [];

    // Reset stats for clean restart
    this.eventsProcessed = 0;
    this.opportunitiesFound = 0;
    this.lastBlockNumber = 0;
    this.lastBlockTimestamp = 0;
    this.reconnectAttempts = 0;

    this.status = 'disconnected';
    this.isStopping = false; // Reset for potential restart
    this.emit('statusChange', this.status);

    this.logger.info('ChainDetectorInstance stopped');
  }

  // ===========================================================================
  // Simulation Mode
  // ===========================================================================

  // Non-EVM simulation interval reference for cleanup
  private nonEvmSimulationInterval: NodeJS.Timeout | null = null;

  /**
   * Initialize simplified simulation for non-EVM chains (like Solana).
   * Generates periodic price updates without using EVM-specific Sync events.
   * This allows simulation mode to work across all chain types.
   */
  private async initializeNonEvmSimulation(): Promise<void> {
    this.logger.info('Initializing non-EVM simulation mode', {
      chainId: this.chainId
    });

    // Get configured DEXes and tokens for this non-EVM chain
    const dexNames = this.dexes.map(d => d.name);
    const tokenSymbols = this.tokens.map(t => t.symbol);

    // If no tokens configured, use default Solana tokens
    const effectiveTokens = tokenSymbols.length > 0 ? tokenSymbols : ['SOL', 'USDC', 'RAY', 'JUP'];
    const effectiveDexes = dexNames.length > 0 ? dexNames : ['raydium', 'orca'];

    // Start periodic simulation updates
    const updateIntervalMs = parseInt(process.env.SIMULATION_UPDATE_INTERVAL_MS || '1000', 10);
    let slotNumber = 250000000; // Starting slot for Solana-like chains

    this.nonEvmSimulationInterval = setInterval(() => {
      if (this.isStopping || !this.isRunning) {
        return;
      }

      slotNumber++;
      this.lastBlockNumber = slotNumber;
      this.lastBlockTimestamp = Date.now();

      // Generate synthetic price updates for token pairs across DEXes
      for (let i = 0; i < effectiveTokens.length; i++) {
        for (let j = i + 1; j < effectiveTokens.length; j++) {
          const token0 = effectiveTokens[i];
          const token1 = effectiveTokens[j];

          // Generate price with some volatility
          const basePrice = this.getBaseTokenPrice(token0) / this.getBaseTokenPrice(token1);
          const volatility = parseFloat(process.env.SIMULATION_VOLATILITY || '0.02');
          const priceVariation = 1 + (Math.random() * 2 - 1) * volatility;
          const price = basePrice * priceVariation;

          // Emit price update for each DEX
          for (const dex of effectiveDexes) {
            const dexPriceVariation = 1 + (Math.random() * 2 - 1) * 0.005; // Small DEX-to-DEX variation
            const dexPrice = price * dexPriceVariation;

            const priceUpdate: PriceUpdate = {
              chain: this.chainId,
              dex,
              pairKey: `${dex}_${token0}_${token1}`,
              token0,
              token1,
              price: dexPrice,
              reserve0: '0',  // Non-EVM chains may not have reserve-based AMMs
              reserve1: '0',
              blockNumber: slotNumber,
              timestamp: Date.now(),
              latency: 0
            };

            this.emit('priceUpdate', priceUpdate);
            this.eventsProcessed++;
          }

          // Occasionally detect arbitrage opportunity
          if (effectiveDexes.length >= 2 && Math.random() < 0.03) { // 3% chance
            const dex1 = effectiveDexes[0];
            const dex2 = effectiveDexes[1];
            const priceDiff = 0.003 + Math.random() * 0.007; // 0.3% to 1% profit

            const opportunity: ArbitrageOpportunity = {
              id: `${this.chainId}-sim-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
              type: 'simple',
              chain: this.chainId,
              buyDex: dex1,
              sellDex: dex2,
              buyPair: `${dex1}_${token0}_${token1}`,
              sellPair: `${dex2}_${token0}_${token1}`,
              token0,
              token1,
              buyPrice: price * (1 - priceDiff / 2),
              sellPrice: price * (1 + priceDiff / 2),
              profitPercentage: priceDiff * 100,
              expectedProfit: priceDiff,
              confidence: 0.85,
              timestamp: Date.now(),
              expiresAt: Date.now() + 1000, // Fast expiry for Solana
              status: 'pending'
            };

            this.opportunitiesFound++;
            this.emit('opportunity', opportunity);
          }
        }
      }
    }, updateIntervalMs);

    this.logger.info('Non-EVM simulation initialized', {
      chainId: this.chainId,
      dexes: effectiveDexes,
      tokens: effectiveTokens,
      updateIntervalMs
    });
  }

  /**
   * Get base token price for simulation (in USD).
   * Note: Keep in sync with BASE_PRICES in shared/core/src/simulation-mode.ts
   */
  private getBaseTokenPrice(symbol: string): number {
    const basePrices: Record<string, number> = {
      // Solana-specific tokens
      SOL: 175, USDC: 1, USDT: 1, RAY: 4.5, JUP: 0.85, ORCA: 3.2,
      BONK: 0.000025, WIF: 2.5, mSOL: 185, JitoSOL: 180,
      // Common cross-chain tokens (for non-EVM chains that may support bridged assets)
      WETH: 3200, WBTC: 65000, LINK: 15, ARB: 1.15, OP: 2.5
    };
    return basePrices[symbol.toUpperCase()] ?? 1;
  }

  /**
   * Initialize the chain simulator for simulation mode.
   * Creates simulated pairs from the initialized pairs and starts generating
   * fake Sync events that mimic real blockchain events.
   */
  private async initializeSimulation(): Promise<void> {
    this.logger.info('Initializing simulation mode', {
      chainId: this.chainId,
      pairs: this.pairs.size
    });

    // Build simulated pair configs from our initialized pairs
    const simulatedPairs: SimulatedPairConfig[] = [];

    for (const [pairKey, pair] of this.pairs) {
      // Extract token symbols from pair key (format: dex_TOKEN0_TOKEN1)
      const parts = pairKey.split('_');
      if (parts.length < 3) continue;

      const token0Symbol = parts[1];
      const token1Symbol = parts[2];

      // Get token decimals from config (default to 18 for most tokens)
      const token0 = this.tokens.find(t => t.symbol === token0Symbol);
      const token1 = this.tokens.find(t => t.symbol === token1Symbol);

      simulatedPairs.push({
        address: pair.address,
        token0Symbol,
        token1Symbol,
        token0Decimals: token0?.decimals ?? 18,
        token1Decimals: token1?.decimals ?? 18,
        dex: pair.dex,
        fee: pair.fee ?? 0.003  // Default 0.3% fee
      });
    }

    if (simulatedPairs.length === 0) {
      this.logger.warn('No pairs available for simulation', { chainId: this.chainId });
      return;
    }

    // Get or create the chain simulator
    this.chainSimulator = getChainSimulator(this.chainId, simulatedPairs);

    // Set up event handlers for simulated events
    this.chainSimulator.on('syncEvent', (event) => {
      this.handleSimulatedSyncEvent(event);
    });

    this.chainSimulator.on('blockUpdate', (data) => {
      this.lastBlockNumber = data.blockNumber;
      this.lastBlockTimestamp = Date.now();
    });

    this.chainSimulator.on('opportunity', (opportunity) => {
      this.opportunitiesFound++;
      this.emit('opportunity', opportunity);
      this.logger.debug('Simulated opportunity detected', {
        id: opportunity.id,
        profit: `${opportunity.profitPercentage.toFixed(2)}%`
      });
    });

    // Start the simulator
    this.chainSimulator.start();

    this.logger.info('Simulation mode initialized', {
      chainId: this.chainId,
      simulatedPairs: simulatedPairs.length
    });
  }

  /**
   * Handle simulated Sync events from the ChainSimulator.
   * Processes them the same way as real Sync events from WebSocket.
   */
  private handleSimulatedSyncEvent(event: { address: string; data: string; blockNumber: string }): void {
    const pairAddress = event.address.toLowerCase();
    const pair = this.pairsByAddress.get(pairAddress);

    if (!pair) {
      return; // Unknown pair, skip
    }

    try {
      // Decode reserves from the simulated data
      // Data format: 0x + 64 hex chars for reserve0 + 64 hex chars for reserve1
      const data = event.data.slice(2); // Remove '0x'
      const reserve0Hex = data.slice(0, 64);
      const reserve1Hex = data.slice(64, 128);

      const reserve0 = BigInt('0x' + reserve0Hex).toString();
      const reserve1 = BigInt('0x' + reserve1Hex).toString();
      const blockNumber = parseInt(event.blockNumber, 16);

      // Update pair reserves (using Object.assign for atomicity)
      Object.assign(pair, {
        reserve0,
        reserve1,
        blockNumber,
        lastUpdate: Date.now()
      });

      this.lastBlockNumber = blockNumber;
      this.lastBlockTimestamp = Date.now();
      this.eventsProcessed++;

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
        reserve0,  // Already a string
        reserve1,  // Already a string
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
    // Use wsUrl, fallback to rpcUrl if not available
    const primaryWsUrl = this.chainConfig.wsUrl || this.chainConfig.rpcUrl;

    // FIX: Pass chainId for proper staleness thresholds and health tracking
    // Use extended timeout for known unstable chains (BSC, Fantom)
    const unstableChains = ['bsc', 'fantom'];
    const connectionTimeout = unstableChains.includes(this.chainId.toLowerCase()) ? 15000 : 10000;

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
          const feePercentage = dexFeeToPercentage(dex.fee ?? 30);

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
  // Event Subscription
  // ===========================================================================

  private async subscribeToEvents(): Promise<void> {
    if (!this.wsManager) return;

    // Get monitored pair addresses for filtering
    const pairAddresses = Array.from(this.pairsByAddress.keys());

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

    this.logger.info('Subscribed to blockchain events');
  }

  // ===========================================================================
  // Event Handlers
  // ===========================================================================

  // P2 FIX: Use WebSocketMessage type instead of any
  private handleWebSocketMessage(message: WebSocketMessage): void {
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
        const reserve0 = BigInt('0x' + data.slice(2, 66)).toString();
        const reserve1 = BigInt('0x' + data.slice(66, 130)).toString();

        // P1-9 FIX: Use Object.assign for atomic pair updates
        // This prevents partial updates if concurrent access occurs during
        // initialization or other event handling
        Object.assign(pair, {
          reserve0,
          reserve1,
          blockNumber: parseInt(log.blockNumber, 16),
          lastUpdate: Date.now()
        });

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
        // BUG-3 FIX: Calculate USD value for accurate whale detection
        // PHASE-3.3: Use extracted publisher's estimation method
        usdValue: this.whaleAlertPublisher?.estimateSwapUsdValue(pairInfo, amount0In, amount1In, amount0Out, amount1Out) ?? 0
      };

      // Process through filter (handles whale detection via registered handler)
      if (this.swapEventFilter) {
        const result = this.swapEventFilter.processEvent(swapEvent);
        if (!result.passed) return;
      }

      // PHASE-3.3: Publish to Redis Streams using extracted publisher
      this.whaleAlertPublisher?.publishSwapEvent(swapEvent);

      // Local emit for any listeners
      this.emit('swapEvent', swapEvent);
    } catch (error) {
      this.logger.error('Error handling Swap event', { error });
    }
  }

  // P2 FIX: Use EthereumBlockHeader type instead of any
  private handleNewBlock(block: EthereumBlockHeader): void {
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
   * Captures all mutable values at a point in time.
   */
  private createPairSnapshot(pair: ExtendedPair): PairSnapshot | null {
    // Skip pairs without initialized reserves
    if (!pair.reserve0 || !pair.reserve1 || pair.reserve0 === '0' || pair.reserve1 === '0') {
      return null;
    }

    return {
      address: pair.address,
      dex: pair.dex,
      token0: pair.token0,
      token1: pair.token1,
      reserve0: pair.reserve0,
      reserve1: pair.reserve1,
      fee: pair.fee ?? 0.003, // Default 0.3% fee if undefined
      blockNumber: pair.blockNumber
    };
  }

  /**
   * Create deep snapshots of all pairs for thread-safe iteration.
   * This prevents race conditions where concurrent Sync events could
   * modify pair reserves while we're iterating for arbitrage detection.
   */
  private createPairsSnapshot(): Map<string, PairSnapshot> {
    const snapshots = new Map<string, PairSnapshot>();

    for (const [key, pair] of this.pairs.entries()) {
      const snapshot = this.createPairSnapshot(pair);
      if (snapshot) {
        snapshots.set(key, snapshot);
      }
    }

    return snapshots;
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
    const shouldCheckTriangular = now - this.lastTriangularCheck >= this.TRIANGULAR_CHECK_INTERVAL_MS;
    const shouldCheckMultiLeg = now - this.lastMultiLegCheck >= this.MULTI_LEG_CHECK_INTERVAL_MS;

    // Only create snapshot if at least one check will run
    if (shouldCheckTriangular || shouldCheckMultiLeg) {
      const pairsSnapshot = this.createPairsSnapshot();

      if (shouldCheckTriangular) {
        this.checkTriangularOpportunities(pairsSnapshot).catch(error => {
          this.logger.error('Triangular detection error', { error: (error as Error).message });
        });
      }

      if (shouldCheckMultiLeg) {
        this.checkMultiLegOpportunities(pairsSnapshot).catch(error => {
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

  private calculateArbitrage(
    pair1: PairSnapshot,
    pair2: PairSnapshot
  ): ArbitrageOpportunity | null {
    const reserve1_0 = BigInt(pair1.reserve0);
    const reserve1_1 = BigInt(pair1.reserve1);
    const reserve2_0 = BigInt(pair2.reserve0);
    const reserve2_1 = BigInt(pair2.reserve1);

    if (reserve1_0 === 0n || reserve1_1 === 0n || reserve2_0 === 0n || reserve2_1 === 0n) {
      return null;
    }

    // P0-1 FIX: Use precision-safe price calculation to prevent precision loss
    // for large BigInt values (reserves can be > 2^53)
    const price1 = calculatePriceFromBigIntReserves(reserve1_0, reserve1_1);
    const price2Raw = calculatePriceFromBigIntReserves(reserve2_0, reserve2_1);

    // Handle null returns (shouldn't happen since we checked for zero reserves above)
    if (price1 === null || price2Raw === null) {
      return null;
    }

    // BUG FIX: Adjust price for reverse order pairs
    // If tokens are in reverse order, invert the price for accurate comparison
    const isReversed = this.isReverseOrder(pair1, pair2);
    let price2 = isReversed && price2Raw !== 0 ? 1 / price2Raw : price2Raw;

    // Calculate price difference as a percentage of the lower price
    const priceDiff = Math.abs(price1 - price2) / Math.min(price1, price2);

    // Use config-based profit threshold (not hardcoded)
    const minProfitThreshold = this.getMinProfitThreshold();

    // Calculate fee-adjusted profit
    // Fees are stored as decimals (e.g., 0.003 for 0.3%)
    // Use ?? instead of || to correctly handle fee: 0 (if a DEX ever has 0% fee)
    const totalFees = (pair1.fee ?? 0.003) + (pair2.fee ?? 0.003);
    const netProfitPct = priceDiff - totalFees;

    // Check if profitable after fees
    if (netProfitPct < minProfitThreshold) {
      return null;
    }

    // Determine buy/sell sides based on prices
    const buyFromPair1 = price1 < price2;
    const buyPair = buyFromPair1 ? pair1 : pair2;
    const sellPair = buyFromPair1 ? pair2 : pair1;

    // CRITICAL FIX: Calculate tokenIn, tokenOut, and amountIn for execution engine
    // For simple arbitrage: buy token1 on cheaper DEX, sell on expensive DEX
    // tokenIn = the token we're buying (token1), tokenOut = the token we're selling (token0)
    const tokenIn = buyPair.token1;  // We buy token1 with token0
    const tokenOut = buyPair.token0; // We end up with token0 after selling token1

    // CRITICAL FIX: Calculate optimal amountIn based on reserves
    // Use a conservative percentage of the smaller reserve to limit price impact
    // The buy pair's reserve1 represents available token1 liquidity
    const buyReserve1 = buyFromPair1 ? reserve1_1 : reserve2_1;
    const sellReserve1 = buyFromPair1 ? reserve2_1 : reserve1_1;

    // Use 1% of the smaller liquidity pool to minimize slippage
    // This is conservative but safe for production
    const maxTradePercent = 0.01; // 1% of pool
    const smallerReserve = buyReserve1 < sellReserve1 ? buyReserve1 : sellReserve1;
    const amountIn = (smallerReserve * BigInt(Math.floor(maxTradePercent * 10000))) / 10000n;

    // Skip if calculated amount is too small (dust)
    if (amountIn < 1000n) {
      return null;
    }

    // CRITICAL FIX: Calculate expectedProfit as ABSOLUTE value (not percentage)
    // The execution engine treats expectedProfit as wei value to convert via: BigInt(Math.floor(opportunity.expectedProfit * 1e18))
    // So we need to provide profit in the base unit (e.g., 0.005 ETH = 0.005)
    // expectedProfit = amountIn * netProfitPct (in token units)
    const expectedProfitAbsolute = Number(amountIn) * netProfitPct;

    const opportunity: ArbitrageOpportunity = {
      id: `${this.chainId}-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
      type: 'simple', // Standardized with base-detector.ts
      chain: this.chainId,
      buyDex: buyPair.dex,
      sellDex: sellPair.dex,
      buyPair: buyPair.address,
      sellPair: sellPair.address,
      token0: pair1.token0,
      token1: pair1.token1,
      // CRITICAL FIX: Add tokenIn/tokenOut/amountIn required by execution engine
      tokenIn,
      tokenOut,
      amountIn: amountIn.toString(),
      buyPrice: Math.min(price1, price2),
      sellPrice: Math.max(price1, price2),
      profitPercentage: netProfitPct * 100, // Convert to percentage for display
      // CRITICAL FIX: expectedProfit is now ABSOLUTE value (required by engine.ts:1380)
      expectedProfit: expectedProfitAbsolute,
      estimatedProfit: 0, // To be calculated by execution engine
      gasEstimate: String(this.detectorConfig.gasEstimate),
      confidence: this.detectorConfig.confidence,
      timestamp: Date.now(),
      expiresAt: Date.now() + this.detectorConfig.expiryMs,
      blockNumber: pair1.blockNumber,
      status: 'pending'
    };

    return opportunity;
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

  /**
   * Convert PairSnapshot to DexPool format required by CrossDexTriangularArbitrage.
   */
  private convertPairSnapshotToDexPool(snapshot: PairSnapshot): DexPool {
    const reserve0 = BigInt(snapshot.reserve0);
    const reserve1 = BigInt(snapshot.reserve1);

    // P0-1 FIX: Use precision-safe price calculation (consistent with calculateArbitrage)
    const price = calculatePriceFromBigIntReserves(reserve1, reserve0) ?? 0;

    // Estimate liquidity from reserves (simplified USD estimation)
    const liquidity = Number(reserve0) * price * 2;

    return {
      dex: snapshot.dex,
      token0: snapshot.token0,
      token1: snapshot.token1,
      reserve0: snapshot.reserve0,
      reserve1: snapshot.reserve1,
      fee: Math.round((snapshot.fee ?? 0.003) * 10000), // Convert to basis points
      liquidity,
      price
    };
  }

  /**
   * Check for triangular and quadrilateral arbitrage opportunities.
   * Throttled to 500ms to prevent excessive CPU usage.
   */
  private async checkTriangularOpportunities(pairsSnapshot: Map<string, PairSnapshot>): Promise<void> {
    const now = Date.now();
    if (now - this.lastTriangularCheck < this.TRIANGULAR_CHECK_INTERVAL_MS) {
      return;
    }
    this.lastTriangularCheck = now;

    if (pairsSnapshot.size < 3) return;

    const pools: DexPool[] = Array.from(pairsSnapshot.values())
      .map(snapshot => this.convertPairSnapshotToDexPool(snapshot));

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
   */
  private async checkMultiLegOpportunities(pairsSnapshot: Map<string, PairSnapshot>): Promise<void> {
    const now = Date.now();
    if (now - this.lastMultiLegCheck < this.MULTI_LEG_CHECK_INTERVAL_MS) {
      return;
    }

    if (pairsSnapshot.size < 5 || !this.multiLegPathFinder) return;
    this.lastMultiLegCheck = now;

    const pools: DexPool[] = Array.from(pairsSnapshot.values())
      .map(snapshot => this.convertPairSnapshotToDexPool(snapshot));

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
    const token = this.tokens.find(t => t.address.toLowerCase() === address.toLowerCase());
    return token?.symbol || address.slice(0, 8);
  }

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

    return {
      chainId: this.chainId,
      status: this.status,
      eventsProcessed: this.eventsProcessed,
      opportunitiesFound: this.opportunitiesFound,
      lastBlockNumber: this.lastBlockNumber,
      avgBlockLatencyMs: avgLatency,
      pairsMonitored: this.pairs.size
    };
  }
}
