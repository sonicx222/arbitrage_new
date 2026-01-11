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
  WebSocketConfig
} from '../../../shared/core/src';

import {
  CHAINS,
  DEXES,
  CORE_TOKENS,
  EVENT_SIGNATURES,
  DETECTOR_CONFIG,
  TOKEN_METADATA
} from '../../../shared/config/src';

import {
  Dex,
  Token,
  PriceUpdate,
  ArbitrageOpportunity,
  SwapEvent,
  Pair
} from '../../../shared/types/src';

import { ChainStats } from './unified-detector';

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
  private tokenMetadata: any;

  private pairs: Map<string, ExtendedPair> = new Map();
  private pairsByAddress: Map<string, ExtendedPair> = new Map();

  private status: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
  private eventsProcessed: number = 0;
  private opportunitiesFound: number = 0;
  private lastBlockNumber: number = 0;
  private lastBlockTimestamp: number = 0;
  private blockLatencies: number[] = [];

  private isRunning: boolean = false;
  private reconnectAttempts: number = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;

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
    this.dexes = DEXES[this.chainId as keyof typeof DEXES] || [];
    this.tokens = CORE_TOKENS[this.chainId as keyof typeof CORE_TOKENS] || [];
    this.tokenMetadata = TOKEN_METADATA[this.chainId as keyof typeof TOKEN_METADATA] || {};

    // Override URLs if provided
    if (config.wsUrl) {
      this.chainConfig = { ...this.chainConfig, wsUrl: config.wsUrl };
    }
    if (config.rpcUrl) {
      this.chainConfig = { ...this.chainConfig, rpcUrl: config.rpcUrl };
    }
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('ChainDetectorInstance already running');
      return;
    }

    this.logger.info('Starting ChainDetectorInstance', {
      chainId: this.chainId,
      partitionId: this.partitionId,
      dexes: this.dexes.length,
      tokens: this.tokens.length
    });

    this.status = 'connecting';
    this.emit('statusChange', this.status);

    try {
      // Initialize RPC provider
      this.provider = new ethers.JsonRpcProvider(this.chainConfig.rpcUrl);

      // Initialize WebSocket manager
      await this.initializeWebSocket();

      // Initialize pairs from DEX factories
      await this.initializePairs();

      // Subscribe to events
      await this.subscribeToEvents();

      this.isRunning = true;
      this.status = 'connected';
      this.reconnectAttempts = 0;
      this.emit('statusChange', this.status);

      this.logger.info('ChainDetectorInstance started', {
        pairsMonitored: this.pairs.size
      });

    } catch (error) {
      this.status = 'error';
      this.emit('statusChange', this.status);
      this.emit('error', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.logger.info('Stopping ChainDetectorInstance', { chainId: this.chainId });

    this.isRunning = false;

    // Disconnect WebSocket (P0-2 fix: remove listeners to prevent memory leak)
    if (this.wsManager) {
      // Remove all event listeners before disconnecting to prevent memory leak
      this.wsManager.removeAllListeners();
      await this.wsManager.disconnect();
      this.wsManager = null;
    }

    // Clean up provider reference
    if (this.provider) {
      this.provider = null;
    }

    // Clear pairs
    this.pairs.clear();
    this.pairsByAddress.clear();

    // Clear latency tracking
    this.blockLatencies = [];

    this.status = 'disconnected';
    this.emit('statusChange', this.status);

    this.logger.info('ChainDetectorInstance stopped');
  }

  // ===========================================================================
  // WebSocket Management
  // ===========================================================================

  private async initializeWebSocket(): Promise<void> {
    const wsConfig: WebSocketConfig = {
      url: this.chainConfig.wsUrl,
      reconnectInterval: 5000,
      maxReconnectAttempts: this.MAX_RECONNECT_ATTEMPTS,
      pingInterval: 30000,
      connectionTimeout: 10000
    };

    this.wsManager = new WebSocketManager(wsConfig);

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

    for (const dex of this.dexes) {
      for (let i = 0; i < this.tokens.length; i++) {
        for (let j = i + 1; j < this.tokens.length; j++) {
          const token0 = this.tokens[i];
          const token1 = this.tokens[j];

          // Generate a deterministic pair address (placeholder)
          const pairAddress = this.generatePairAddress(dex.factoryAddress, token0.address, token1.address);

          const pair: ExtendedPair = {
            address: pairAddress,
            dex: dex.name,
            token0: token0.address,
            token1: token1.address,
            fee: dex.fee,
            reserve0: '0',
            reserve1: '0',
            blockNumber: 0,
            lastUpdate: 0
          };

          const pairKey = `${dex.name}_${token0.symbol}_${token1.symbol}`;
          this.pairs.set(pairKey, pair);
          this.pairsByAddress.set(pairAddress.toLowerCase(), pair);
        }
      }
    }

    this.logger.info(`Initialized ${this.pairs.size} pairs for monitoring`);
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

    // Subscribe to Sync events
    await this.wsManager.subscribe({
      type: 'logs',
      topics: [EVENT_SIGNATURES.SYNC],
      callback: (log) => this.handleSyncEvent(log)
    });

    // Subscribe to Swap events
    await this.wsManager.subscribe({
      type: 'logs',
      topics: [EVENT_SIGNATURES.SWAP_V2],
      callback: (log) => this.handleSwapEvent(log)
    });

    // Subscribe to new blocks for latency tracking
    await this.wsManager.subscribe({
      type: 'newHeads',
      callback: (block) => this.handleNewBlock(block)
    });

    this.logger.info('Subscribed to blockchain events');
  }

  // ===========================================================================
  // Event Handlers
  // ===========================================================================

  private handleWebSocketMessage(message: any): void {
    try {
      // Route message based on type
      if (message.method === 'eth_subscription') {
        const params = message.params;
        if (params?.result?.topics) {
          // Log event
          const topic0 = params.result.topics[0];
          if (topic0 === EVENT_SIGNATURES.SYNC) {
            this.handleSyncEvent(params.result);
          } else if (topic0 === EVENT_SIGNATURES.SWAP_V2) {
            this.handleSwapEvent(params.result);
          }
        } else if (params?.result?.number) {
          // New block
          this.handleNewBlock(params.result);
        }
      }
    } catch (error) {
      this.logger.error('Error handling WebSocket message', { error });
    }
  }

  private handleSyncEvent(log: any): void {
    if (!this.isRunning) return;

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

  private handleSwapEvent(log: any): void {
    if (!this.isRunning) return;

    try {
      const pairAddress = log.address?.toLowerCase();
      const pair = this.pairsByAddress.get(pairAddress);

      if (!pair) return;

      this.eventsProcessed++;

      // Emit swap event for downstream processing
      const swapEvent: Partial<SwapEvent> = {
        chain: this.chainId,
        dex: pair.dex,
        pairAddress: pairAddress,
        blockNumber: parseInt(log.blockNumber, 16),
        transactionHash: log.transactionHash,
        timestamp: Date.now()
      };

      this.emit('swapEvent', swapEvent);
    } catch (error) {
      this.logger.error('Error handling Swap event', { error });
    }
  }

  private handleNewBlock(block: any): void {
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

    // Calculate price (token1/token0)
    const price = Number(reserve1 * 10n ** 18n / reserve0) / 1e18;

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
      blockNumber: pair.blockNumber
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

  private checkArbitrageOpportunity(updatedPair: ExtendedPair): void {
    // Create atomic snapshot of pairs to prevent race conditions during iteration
    // Without this, concurrent Sync events could modify pairs while we're iterating
    const pairsSnapshot = new Map(this.pairs);

    // Find pairs with same tokens but different DEXes
    for (const [key, pair] of pairsSnapshot) {
      if (pair.address === updatedPair.address) continue;

      // Check if same token pair
      if (this.isSameTokenPair(pair, updatedPair)) {
        const opportunity = this.calculateArbitrage(updatedPair, pair);

        if (opportunity && opportunity.expectedProfit > 0) {
          this.opportunitiesFound++;
          this.emitOpportunity(opportunity);
        }
      }
    }
  }

  private isSameTokenPair(pair1: ExtendedPair, pair2: ExtendedPair): boolean {
    return (
      (pair1.token0 === pair2.token0 && pair1.token1 === pair2.token1) ||
      (pair1.token0 === pair2.token1 && pair1.token1 === pair2.token0)
    );
  }

  private calculateArbitrage(
    pair1: ExtendedPair,
    pair2: ExtendedPair
  ): ArbitrageOpportunity | null {
    const reserve1_0 = BigInt(pair1.reserve0);
    const reserve1_1 = BigInt(pair1.reserve1);
    const reserve2_0 = BigInt(pair2.reserve0);
    const reserve2_1 = BigInt(pair2.reserve1);

    if (reserve1_0 === 0n || reserve1_1 === 0n || reserve2_0 === 0n || reserve2_1 === 0n) {
      return null;
    }

    // Calculate prices
    const price1 = Number(reserve1_1) / Number(reserve1_0);
    const price2 = Number(reserve2_1) / Number(reserve2_0);

    const priceDiff = Math.abs(price1 - price2);
    const avgPrice = (price1 + price2) / 2;
    const percentageDiff = priceDiff / avgPrice;

    // Check if profitable (basic check)
    if (percentageDiff < 0.003) { // 0.3% minimum
      return null;
    }

    const opportunity: ArbitrageOpportunity = {
      id: `${this.chainId}-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
      type: 'intra-dex',
      buyDex: price1 < price2 ? pair1.dex : pair2.dex,
      sellDex: price1 < price2 ? pair2.dex : pair1.dex,
      buyChain: this.chainId,
      sellChain: this.chainId,
      tokenIn: pair1.token0,
      tokenOut: pair1.token1,
      amountIn: '1000000000000000000', // 1 token
      expectedProfit: priceDiff,
      profitPercentage: percentageDiff,
      gasEstimate: this.detectorConfig.gasEstimate,
      confidence: this.detectorConfig.confidence,
      timestamp: Date.now(),
      blockNumber: pair1.blockNumber
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
