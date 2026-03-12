/**
 * CEX Price Feed Service
 *
 * Orchestrator that composes BinanceWebSocketClient, CexPriceNormalizer,
 * and CexDexSpreadCalculator into a single service for CEX-DEX spread analysis.
 *
 * In live mode, connects to Binance public trade streams (no API key needed).
 * In simulation mode, skips the external connection — DEX prices are fed
 * externally via updateDexPrice(), and synthetic CEX prices can be injected
 * via updateCexPrice() for testing.
 *
 * @see ADR-036: CEX Price Signals
 * @see docs/plans/2026-03-11-cex-price-signal-integration.md — Batch 1
 * @module feeds
 */

import { EventEmitter } from 'events';
import { createLogger } from '../logger';
import { getErrorMessage } from '../resilience/error-handling';
import { BinanceWebSocketClient } from './binance-ws-client';
import type { BinanceTradeEvent } from './binance-ws-client';
import { CexFeedHealthTracker, CexFeedHealthStatus } from './cex-feed-health';
import type { CexFeedHealthSnapshot } from './cex-feed-health';
import { CexPriceNormalizer } from './cex-price-normalizer';
import type { CexNormalizerConfig } from './cex-price-normalizer';
import { CexDexSpreadCalculator } from '../analytics/cex-dex-spread';
import type { CexDexSpreadConfig, SpreadAlert } from '../analytics/cex-dex-spread';

const logger = createLogger('cex-price-feed');

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for the CEX Price Feed Service.
 */
export interface CexPriceFeedConfig {
  /** Spread calculator config overrides */
  alertThresholdPct?: number;
  maxCexPriceAgeMs?: number;
  /** Normalizer config overrides */
  normalizerConfig?: CexNormalizerConfig;
  /** Skip Binance WS connection (for simulation mode or testing) */
  skipExternalConnection?: boolean;
  /**
   * When true, auto-generate synthetic CEX prices from DEX price updates.
   * Used in simulation mode to create realistic CEX-DEX spreads without
   * a real Binance WS connection. Each DEX price update generates a CEX
   * price with small random noise (±0.1-0.3%), simulating the natural
   * CEX-DEX divergence seen in production.
   * @default false
   */
  simulateCexPrices?: boolean;
  /** Override max reconnect attempts (default: 10) */
  maxReconnectAttempts?: number;
  /** Override last-resort reconnect interval in ms (default: 300000 = 5min, 0 = disable) */
  lastResortIntervalMs?: number;
}

// =============================================================================
// Stats (Batch 5 — Task 5.1: Observability)
// =============================================================================

/** Internal counters for observability. Exposed via getStats(). */
export interface CexFeedStats {
  /** Total CEX price updates received from Binance trade stream */
  cexPriceUpdatesTotal: number;
  /** Total DEX price updates fed into the spread calculator */
  dexPriceUpdatesTotal: number;
  /** Total spread alerts emitted (|spread| > threshold) */
  spreadAlertsTotal: number;
  /** Total Binance WS reconnections */
  wsReconnectionsTotal: number;
  /** Whether Binance WS is currently connected */
  wsConnected: boolean;
  /** Whether the service is running */
  running: boolean;
  /** Whether simulation mode is active */
  simulationMode: boolean;
  /** Number of active spread alerts exceeding threshold */
  activeAlertCount: number;
  /** Health status of the CEX feed connection */
  healthStatus: CexFeedHealthStatus;
}

// =============================================================================
// CexPriceFeedService
// =============================================================================

/**
 * Orchestrates CEX price feed components into a unified service.
 *
 * Emits:
 * - 'spread_alert' (SpreadAlert) — When |CEX-DEX spread| exceeds threshold
 * - 'connected' () — Binance WS connected (live mode only)
 * - 'disconnected' () — Binance WS disconnected (live mode only)
 * - 'trade' (BinanceTradeEvent) — Raw trade event forwarded from Binance
 */
export class CexPriceFeedService extends EventEmitter {
  private wsClient: BinanceWebSocketClient | null = null;
  private normalizer: CexPriceNormalizer;
  private spreadCalculator: CexDexSpreadCalculator;
  private config: CexPriceFeedConfig;
  private running = false;

  private healthTracker = new CexFeedHealthTracker();

  // Task 5.1: Internal counters
  private _cexPriceUpdates = 0;
  private _dexPriceUpdates = 0;
  private _spreadAlerts = 0;
  private _wsReconnections = 0;

  constructor(config?: CexPriceFeedConfig) {
    super();
    this.setMaxListeners(20);
    this.config = config ?? {};

    this.normalizer = new CexPriceNormalizer(config?.normalizerConfig);

    const spreadConfig: Partial<CexDexSpreadConfig> = {};
    if (config?.alertThresholdPct !== undefined) {
      spreadConfig.alertThresholdPct = config.alertThresholdPct;
    }
    if (config?.maxCexPriceAgeMs !== undefined) {
      spreadConfig.maxCexPriceAgeMs = config.maxCexPriceAgeMs;
    }
    this.spreadCalculator = new CexDexSpreadCalculator(spreadConfig);

    // Forward spread alerts + count
    this.spreadCalculator.on('spread_alert', (alert: SpreadAlert) => {
      this._spreadAlerts++;
      this.emit('spread_alert', alert);
    });

    logger.info('CexPriceFeedService initialized', {
      symbols: this.normalizer.getSupportedSymbols(),
      skipExternalConnection: this.config.skipExternalConnection ?? false,
    });
  }

  /**
   * Start the CEX price feed.
   *
   * In live mode, connects to Binance WS and begins streaming trade events.
   * In simulation/skip mode, does nothing — prices are fed externally.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('CexPriceFeedService already running');
      return;
    }
    this.running = true;

    if (this.config.skipExternalConnection) {
      this.healthTracker.setPassiveMode();
      logger.info('CexPriceFeedService started in passive mode (no external connection)');
      return;
    }

    // Build stream names from normalizer's supported symbols
    const symbols = this.normalizer.getSupportedSymbols();
    const streams = symbols.map(s => `${s.toLowerCase()}@trade`);

    this.wsClient = new BinanceWebSocketClient({
      streams,
      ...(this.config.maxReconnectAttempts !== undefined && { maxReconnectAttempts: this.config.maxReconnectAttempts }),
    });

    // Wire trade events through normalizer into spread calculator
    this.wsClient.on('trade', (trade: BinanceTradeEvent) => {
      this._cexPriceUpdates++;
      this.emit('trade', trade);
      const normalized = this.normalizer.normalize(trade);
      if (normalized) {
        this.spreadCalculator.updateCexPrice(
          normalized.tokenId,
          normalized.price,
          normalized.timestamp,
        );
      }
    });

    // Forward connection events + track reconnections + health state
    this.wsClient.on('connected', () => {
      this.healthTracker.onConnected();
      logger.info('Binance WS connected');
      this.emit('connected');
    });
    this.wsClient.on('disconnected', () => {
      this.healthTracker.onDisconnected();
      logger.warn('Binance WS disconnected');
      this.emit('disconnected');
    });
    // NOTE: 'reconnecting' is not emitted by BinanceWebSocketClient — this handler
    // exists but never fires. Kept for forward-compat if emit is added later.
    this.wsClient.on('reconnecting', () => {
      this._wsReconnections++;
      logger.info('Binance WS reconnecting', { reconnections: this._wsReconnections });
    });
    this.wsClient.on('maxReconnectFailed', (attempts: number) => {
      this.healthTracker.onMaxReconnectFailed();
      logger.error('Binance WS exhausted all reconnect attempts, running degraded', { attempts });
      this.emit('maxReconnectFailed', attempts);
    });

    try {
      await this.wsClient.connect();
      logger.info('CexPriceFeedService started (Binance WS connected)', {
        streams: streams.length,
      });
    } catch (error) {
      logger.error('Failed to connect Binance WS, service running in degraded mode', {
        error: getErrorMessage(error),
      });
      // Don't throw — the WS client has auto-reconnect built in
    }
  }

  /**
   * Stop the CEX price feed and disconnect from Binance.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.wsClient) {
      await this.wsClient.disconnect();
      this.wsClient.removeAllListeners();
      this.wsClient = null;
    }

    this.spreadCalculator.reset();
    logger.info('CexPriceFeedService stopped');
  }

  /**
   * O(1) spread lookup for hot-path scoring.
   *
   * @param tokenId - Internal token ID (e.g., 'WETH')
   * @param chain - Chain name (e.g., 'ethereum')
   * @returns Spread percentage, or undefined if no data available
   */
  getSpread(tokenId: string, chain: string): number | undefined {
    return this.spreadCalculator.getSpread(tokenId, chain);
  }

  /**
   * Get all current spreads exceeding the alert threshold.
   */
  getActiveAlerts(): SpreadAlert[] {
    return this.spreadCalculator.getActiveAlerts();
  }

  /**
   * Feed a DEX price update into the spread calculator.
   * Called by the coordinator when processing price updates from partitions.
   *
   * When `simulateCexPrices` is enabled (simulation mode), also injects a
   * synthetic CEX price with small random noise (±0.15%), creating realistic
   * CEX-DEX spreads without a real Binance connection.
   *
   * @param tokenId - Internal token ID (e.g., 'WETH')
   * @param chain - Chain name (e.g., 'ethereum')
   * @param price - DEX price in USD
   */
  updateDexPrice(tokenId: string, chain: string, price: number): void {
    this._dexPriceUpdates++;
    const now = Date.now();
    this.spreadCalculator.updateDexPrice(tokenId, chain, price, now);

    // Simulation mode: generate synthetic CEX price from DEX price.
    // Small random spread (±0.15%) simulates natural CEX-DEX divergence.
    if (this.config.simulateCexPrices) {
      const noise = 1 + (Math.random() - 0.5) * 0.003; // ±0.15%
      this.spreadCalculator.updateCexPrice(tokenId, price * noise, now);
    }
  }

  /**
   * Inject a CEX price directly (for simulation mode or testing).
   *
   * @param tokenId - Internal token ID (e.g., 'WETH')
   * @param price - CEX price in USD
   */
  updateCexPrice(tokenId: string, price: number): void {
    this.spreadCalculator.updateCexPrice(tokenId, price, Date.now());
  }

  /** Whether the Binance WS is currently connected. */
  isConnected(): boolean {
    return this.wsClient?.isConnected() ?? false;
  }

  /** Whether the service is running (started and not stopped). */
  isRunning(): boolean {
    return this.running;
  }

  /** Get the underlying spread calculator (for advanced queries like history). */
  getSpreadCalculator(): CexDexSpreadCalculator {
    return this.spreadCalculator;
  }

  /** Get observability stats for monitoring and dashboard (Task 5.1). */
  getStats(): CexFeedStats {
    return {
      cexPriceUpdatesTotal: this._cexPriceUpdates,
      dexPriceUpdatesTotal: this._dexPriceUpdates,
      spreadAlertsTotal: this._spreadAlerts,
      wsReconnectionsTotal: this._wsReconnections,
      wsConnected: this.isConnected(),
      running: this.running,
      simulationMode: this.config.simulateCexPrices ?? false,
      activeAlertCount: this.spreadCalculator.getActiveAlerts().length,
      healthStatus: this.healthTracker.getStatus(),
    };
  }

  /** Get health snapshot for monitoring integration. */
  getHealthSnapshot(): CexFeedHealthSnapshot {
    return this.healthTracker.getSnapshot();
  }
}

// =============================================================================
// Singleton
// =============================================================================

let instance: CexPriceFeedService | null = null;

/**
 * Get or create the singleton CexPriceFeedService instance.
 * Config is only used on first call (when instance is created).
 */
export function getCexPriceFeedService(config?: CexPriceFeedConfig): CexPriceFeedService {
  if (!instance) {
    instance = new CexPriceFeedService(config);
  }
  return instance;
}

/**
 * Stop and reset the singleton instance.
 * Used in tests and during service shutdown.
 */
export async function resetCexPriceFeedService(): Promise<void> {
  if (instance) {
    // BUG-P1-3 FIX: Remove all event listeners before stopping to prevent
    // stale callbacks (e.g., coordinator's degradation/recovery handlers)
    // from firing during or after shutdown.
    instance.removeAllListeners();
    await instance.stop();
    instance = null;
  }
}
