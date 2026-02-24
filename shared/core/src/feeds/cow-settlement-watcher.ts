/**
 * CoW Protocol Settlement Watcher
 *
 * Watch-only feed that monitors the GPv2Settlement contract on Ethereum mainnet
 * for batch settlement events. Large CoW Protocol settlements create temporary
 * price displacement on DEX pools, which can be captured via backrun strategies.
 *
 * ## How It Works
 *
 * 1. Polls the GPv2Settlement contract for `Trade` events in recent blocks
 * 2. Groups multiple Trade events from the same transaction into a single settlement
 * 3. Filters by configurable minimum trade count
 * 4. Emits 'settlement' events for downstream consumers (e.g., CowBackrunDetector)
 *
 * ## Design Choices
 *
 * - Uses `queryFilter` polling instead of WebSocket subscription for simplicity
 *   and testability. Polling interval is configurable (default 12s = ~1 Ethereum block).
 * - Groups trades by txHash since a single CoW batch can contain many fills.
 * - Feature-gated via FEATURE_COW_BACKRUN=true.
 *
 * @see shared/core/src/detector/cow-backrun-detector.ts - Consumes settlement events
 * @see services/execution-engine/src/strategies/backrun.strategy.ts - Executes backruns
 * @see Phase 4 Task 22: CoW settlement watcher
 * @module feeds
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { createLogger } from '../logger';

const logger = createLogger('cow-settlement-watcher');

// =============================================================================
// Constants
// =============================================================================

/** GPv2Settlement contract on Ethereum mainnet */
export const GPV2_SETTLEMENT_ADDRESS = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41';

/**
 * GPv2Settlement Trade event ABI (ethers v6 human-readable format).
 * Emitted once per fill in a batch settlement.
 */
const TRADE_EVENT_ABI = [
  'event Trade(address indexed owner, address sellToken, address buyToken, uint256 sellAmount, uint256 buyAmount, uint256 feeAmount, bytes orderUid)',
];

/**
 * GPv2Settlement Settlement event ABI (ethers v6 human-readable format).
 * Emitted once per batch by the solver.
 */
const SETTLEMENT_EVENT_ABI = [
  'event Settlement(address indexed solver)',
];

/**
 * Combined ABI for the GPv2Settlement contract (Trade + Settlement events).
 */
const GPV2_SETTLEMENT_ABI = [...TRADE_EVENT_ABI, ...SETTLEMENT_EVENT_ABI];

// =============================================================================
// Types
// =============================================================================

/**
 * A single trade within a CoW Protocol batch settlement.
 */
export interface CowTrade {
  /** Order owner address */
  owner: string;
  /** Token sold by the owner */
  sellToken: string;
  /** Token bought by the owner */
  buyToken: string;
  /** Amount of sellToken sold (in token wei) */
  sellAmount: bigint;
  /** Amount of buyToken bought (in token wei) */
  buyAmount: bigint;
  /** Fee amount charged (in sellToken wei) */
  feeAmount: bigint;
  /** Unique order identifier */
  orderUid: string;
}

/**
 * An aggregated CoW Protocol batch settlement.
 * Groups all trades from the same transaction.
 */
export interface CowSettlement {
  /** Transaction hash of the settlement */
  txHash: string;
  /** Block number where the settlement was mined */
  blockNumber: number;
  /** Solver address that executed the batch */
  solver: string;
  /** All trades within this settlement batch */
  trades: CowTrade[];
  /** Timestamp when the settlement was detected (ms since epoch) */
  timestamp: number;
}

/**
 * Configuration for the CoW settlement watcher.
 */
export interface CowWatcherConfig {
  /** Minimum number of trades in a settlement to emit (default: 1) */
  minTrades: number;
  /** Polling interval in milliseconds (default: 12000 = ~1 Ethereum block) */
  pollIntervalMs?: number;
  /** Number of blocks to look back per poll (default: 2) */
  lookbackBlocks?: number;
}

// =============================================================================
// CowSettlementWatcher
// =============================================================================

/**
 * Watches the GPv2Settlement contract for batch settlement events.
 *
 * Emits:
 * - 'settlement' (CowSettlement) - Aggregated settlement with all trades
 * - 'error' (Error) - Provider or parsing errors
 *
 * @example
 * ```typescript
 * const watcher = new CowSettlementWatcher({ minTrades: 3 });
 * const provider = new ethers.JsonRpcProvider('https://eth.llamarpc.com');
 * watcher.on('settlement', (settlement) => {
 *   console.log(`Settlement with ${settlement.trades.length} trades`);
 * });
 * await watcher.start(provider);
 * ```
 */
export class CowSettlementWatcher extends EventEmitter {
  private contract: ethers.Contract | null = null;
  private provider: ethers.WebSocketProvider | ethers.JsonRpcProvider | null = null;
  private isRunning = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastProcessedBlock = 0;

  private readonly pollIntervalMs: number;
  private readonly lookbackBlocks: number;

  constructor(private readonly config: CowWatcherConfig = { minTrades: 1 }) {
    super();
    this.pollIntervalMs = config.pollIntervalMs ?? 12000;
    this.lookbackBlocks = config.lookbackBlocks ?? 2;
  }

  /**
   * Start watching for CoW settlements.
   *
   * Sets up a polling loop that queries recent blocks for Trade events
   * on the GPv2Settlement contract.
   *
   * @param provider - ethers v6 provider (JsonRpcProvider or WebSocketProvider)
   */
  async start(provider: ethers.WebSocketProvider | ethers.JsonRpcProvider): Promise<void> {
    if (this.isRunning) {
      logger.warn('CowSettlementWatcher already running, ignoring start()');
      return;
    }

    this.provider = provider;
    this.contract = new ethers.Contract(
      GPV2_SETTLEMENT_ADDRESS,
      GPV2_SETTLEMENT_ABI,
      provider,
    );

    // Initialize lastProcessedBlock to current block
    try {
      const currentBlock = await provider.getBlockNumber();
      this.lastProcessedBlock = currentBlock;
      logger.info('CowSettlementWatcher started', {
        startBlock: currentBlock,
        pollIntervalMs: this.pollIntervalMs,
        lookbackBlocks: this.lookbackBlocks,
        minTrades: this.config.minTrades,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Failed to get initial block number', { error: err.message });
      this.emit('error', err);
      return;
    }

    this.isRunning = true;

    // Start polling loop
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
  }

  /**
   * Stop watching and clean up resources.
   */
  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.isRunning = false;
    this.contract = null;
    this.provider = null;
    this.lastProcessedBlock = 0;

    logger.info('CowSettlementWatcher stopped');
  }

  /**
   * Check if the watcher is currently active.
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Poll for recent settlements. Called by the interval timer.
   * Also exposed for testing purposes.
   */
  async poll(): Promise<void> {
    if (!this.contract || !this.provider) {
      return;
    }

    try {
      const currentBlock = await this.provider.getBlockNumber();

      // Skip if no new blocks since last poll
      if (currentBlock <= this.lastProcessedBlock) {
        return;
      }

      const fromBlock = this.lastProcessedBlock + 1;
      const toBlock = currentBlock;

      const settlements = await this.pollRecentBlocks(fromBlock, toBlock);

      for (const settlement of settlements) {
        this.emit('settlement', settlement);
      }

      this.lastProcessedBlock = toBlock;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('Poll error', { error: err.message });
      this.emit('error', err);
    }
  }

  /**
   * Query a specific block range for Trade events and aggregate into settlements.
   *
   * @param fromBlock - Start block (inclusive)
   * @param toBlock - End block (inclusive)
   * @returns Array of CowSettlement objects, one per unique transaction
   */
  async pollRecentBlocks(fromBlock: number, toBlock: number): Promise<CowSettlement[]> {
    if (!this.contract) {
      return [];
    }

    logger.debug('Polling blocks for CoW settlements', { fromBlock, toBlock });

    // Query Trade events
    const tradeFilter = this.contract.filters.Trade();
    const tradeEvents = await this.contract.queryFilter(tradeFilter, fromBlock, toBlock);

    if (tradeEvents.length === 0) {
      return [];
    }

    // Group trades by transaction hash
    const tradesByTx = new Map<string, {
      trades: CowTrade[];
      blockNumber: number;
    }>();

    for (const event of tradeEvents) {
      const log = event as ethers.EventLog;
      if (!log.args) {
        continue;
      }

      const txHash = log.transactionHash;
      const trade: CowTrade = {
        owner: log.args[0] as string,
        sellToken: log.args[1] as string,
        buyToken: log.args[2] as string,
        sellAmount: BigInt(log.args[3]),
        buyAmount: BigInt(log.args[4]),
        feeAmount: BigInt(log.args[5]),
        orderUid: log.args[6] as string,
      };

      const existing = tradesByTx.get(txHash);
      if (existing) {
        existing.trades.push(trade);
      } else {
        tradesByTx.set(txHash, {
          trades: [trade],
          blockNumber: log.blockNumber,
        });
      }
    }

    // Query Settlement events to get solver addresses
    const settlementFilter = this.contract.filters.Settlement();
    const settlementEvents = await this.contract.queryFilter(settlementFilter, fromBlock, toBlock);

    // Map solver by txHash
    const solverByTx = new Map<string, string>();
    for (const event of settlementEvents) {
      const log = event as ethers.EventLog;
      if (log.args) {
        solverByTx.set(log.transactionHash, log.args[0] as string);
      }
    }

    // Build settlements, filtering by minTrades
    const settlements: CowSettlement[] = [];
    const now = Date.now();

    for (const [txHash, data] of tradesByTx) {
      if (data.trades.length < this.config.minTrades) {
        continue;
      }

      settlements.push({
        txHash,
        blockNumber: data.blockNumber,
        solver: solverByTx.get(txHash) ?? 'unknown',
        trades: data.trades,
        timestamp: now,
      });
    }

    if (settlements.length > 0) {
      logger.info('Found CoW settlements', {
        count: settlements.length,
        totalTrades: settlements.reduce((sum, s) => sum + s.trades.length, 0),
        fromBlock,
        toBlock,
      });
    }

    return settlements;
  }
}
