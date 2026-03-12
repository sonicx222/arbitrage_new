/**
 * CexPriceFeedService Tests
 *
 * Tests for the CEX Price Feed Service orchestrator.
 *
 * @see ADR-036: CEX Price Signals
 * @see docs/plans/2026-03-11-cex-price-signal-integration.md — Batch 1
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// =============================================================================
// Mock Setup
// =============================================================================

jest.mock('../../../src/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

// Mock BinanceWebSocketClient to avoid real WS connections.
// Uses applyMock() pattern to survive jest.resetAllMocks() in global afterEach.
const mockConnect = jest.fn<() => Promise<void>>();
const mockDisconnect = jest.fn<() => Promise<void>>();
const mockIsConnected = jest.fn<() => boolean>();
const mockRemoveAllListeners = jest.fn();

jest.mock('../../../src/feeds/binance-ws-client', () => ({
  BinanceWebSocketClient: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { BinanceWebSocketClient: MockBinanceWsClient } = require('../../../src/feeds/binance-ws-client');

/** Re-apply mock defaults after resetAllMocks clears them */
function applyMocks(): void {
  mockConnect.mockResolvedValue(undefined);
  mockDisconnect.mockResolvedValue(undefined);
  mockIsConnected.mockReturnValue(false);

  const { EventEmitter } = require('events');
  (MockBinanceWsClient as jest.Mock).mockImplementation(() => {
    const emitter = new EventEmitter();
    emitter.connect = mockConnect;
    emitter.disconnect = mockDisconnect;
    emitter.isConnected = mockIsConnected;
    emitter.removeAllListeners = mockRemoveAllListeners;
    emitter.setMaxListeners = jest.fn();
    return emitter;
  });
}

// =============================================================================
// Imports (after mocks)
// =============================================================================

import {
  CexPriceFeedService,
  getCexPriceFeedService,
  resetCexPriceFeedService,
} from '../../../src/feeds/cex-price-feed-service';
import type { CexPriceFeedConfig } from '../../../src/feeds/cex-price-feed-service';
import type { SpreadAlert } from '../../../src/analytics/cex-dex-spread';
import { CexFeedHealthStatus } from '../../../src/feeds/cex-feed-health';

// =============================================================================
// Tests
// =============================================================================

describe('CexPriceFeedService', () => {
  let service: CexPriceFeedService;

  beforeEach(() => {
    applyMocks();
    service = new CexPriceFeedService({ skipExternalConnection: true });
  });

  afterEach(async () => {
    await service.stop();
    await resetCexPriceFeedService();
  });

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  describe('lifecycle', () => {
    it('should start in passive mode without connecting to Binance', async () => {
      await service.start();

      expect(service.isRunning()).toBe(true);
      expect(service.isConnected()).toBe(false);
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it('should connect to Binance WS when skipExternalConnection is false', async () => {
      const liveService = new CexPriceFeedService();
      mockConnect.mockResolvedValueOnce(undefined);

      await liveService.start();

      expect(liveService.isRunning()).toBe(true);
      expect(mockConnect).toHaveBeenCalledTimes(1);

      await liveService.stop();
    });

    it('should handle Binance WS connection failure gracefully', async () => {
      const liveService = new CexPriceFeedService();
      mockConnect.mockRejectedValueOnce(new Error('Connection refused'));

      // Should not throw — auto-reconnect handles it
      await liveService.start();

      expect(liveService.isRunning()).toBe(true);
      await liveService.stop();
    });

    it('should stop cleanly', async () => {
      await service.start();
      await service.stop();

      expect(service.isRunning()).toBe(false);
    });

    it('should ignore duplicate start calls', async () => {
      await service.start();
      await service.start(); // Should not throw or double-init

      expect(service.isRunning()).toBe(true);
    });

    it('should ignore stop when not running', async () => {
      await service.stop(); // Should not throw
      expect(service.isRunning()).toBe(false);
    });
  });

  // ===========================================================================
  // DEX Price Updates
  // ===========================================================================

  describe('updateDexPrice', () => {
    it('should accept DEX price updates', () => {
      // Should not throw
      service.updateDexPrice('WETH', 'ethereum', 3500);
      service.updateDexPrice('WBTC', 'arbitrum', 65000);
    });

    it('should return undefined spread when no CEX price exists', () => {
      service.updateDexPrice('WETH', 'ethereum', 3500);

      const spread = service.getSpread('WETH', 'ethereum');
      expect(spread).toBeUndefined();
    });
  });

  // ===========================================================================
  // CEX Price Updates (simulation/test mode)
  // ===========================================================================

  describe('updateCexPrice', () => {
    it('should accept CEX price updates directly', () => {
      service.updateDexPrice('WETH', 'ethereum', 3500);
      service.updateCexPrice('WETH', 3510);

      const spread = service.getSpread('WETH', 'ethereum');
      expect(spread).toBeDefined();
    });
  });

  // ===========================================================================
  // Spread Calculation
  // ===========================================================================

  describe('spread calculation', () => {
    it('should compute correct spread from CEX and DEX prices', () => {
      // DEX price must be set first (creates the state entry)
      service.updateDexPrice('WETH', 'ethereum', 3510);
      service.updateCexPrice('WETH', 3500);

      const spread = service.getSpread('WETH', 'ethereum');
      expect(spread).toBeDefined();
      // spread = ((3510 - 3500) / 3500) * 100 = 0.2857%
      expect(spread).toBeCloseTo(0.2857, 2);
    });

    it('should compute negative spread when DEX is cheaper', () => {
      service.updateDexPrice('WETH', 'ethereum', 3490);
      service.updateCexPrice('WETH', 3500);

      const spread = service.getSpread('WETH', 'ethereum');
      expect(spread).toBeDefined();
      // spread = ((3490 - 3500) / 3500) * 100 = -0.2857%
      expect(spread).toBeLessThan(0);
    });

    it('should track spreads across multiple chains', () => {
      service.updateDexPrice('WETH', 'ethereum', 3510);
      service.updateDexPrice('WETH', 'arbitrum', 3505);
      service.updateCexPrice('WETH', 3500);

      const ethSpread = service.getSpread('WETH', 'ethereum');
      const arbSpread = service.getSpread('WETH', 'arbitrum');

      expect(ethSpread).toBeDefined();
      expect(arbSpread).toBeDefined();
      expect(ethSpread!).toBeGreaterThan(arbSpread!);
    });

    it('should track spreads for multiple tokens', () => {
      service.updateDexPrice('WETH', 'ethereum', 3510);
      service.updateDexPrice('WBTC', 'ethereum', 65100);
      service.updateCexPrice('WETH', 3500);
      service.updateCexPrice('WBTC', 65000);

      expect(service.getSpread('WETH', 'ethereum')).toBeDefined();
      expect(service.getSpread('WBTC', 'ethereum')).toBeDefined();
    });
  });

  // ===========================================================================
  // Spread Alerts
  // ===========================================================================

  describe('spread alerts', () => {
    it('should emit spread_alert when spread exceeds threshold', (done) => {
      const lowThresholdService = new CexPriceFeedService({
        skipExternalConnection: true,
        alertThresholdPct: 0.1, // 0.1% threshold
      });

      lowThresholdService.on('spread_alert', (alert: SpreadAlert) => {
        expect(alert.tokenId).toBe('WETH');
        expect(alert.chain).toBe('ethereum');
        expect(alert.cexPrice).toBe(3500);
        expect(alert.dexPrice).toBe(3520);
        expect(Math.abs(alert.spreadPct)).toBeGreaterThan(0.1);
        lowThresholdService.stop().then(() => done());
      });

      // 3520 vs 3500 = 0.57% spread, above 0.1% threshold
      lowThresholdService.updateDexPrice('WETH', 'ethereum', 3520);
      lowThresholdService.updateCexPrice('WETH', 3500);
    });

    it('should not emit alert when spread is within threshold', async () => {
      const alertSpy = jest.fn();
      service.on('spread_alert', alertSpy);

      // Default threshold is 0.3%. 0.1% spread should not trigger.
      service.updateDexPrice('WETH', 'ethereum', 3503.5);
      service.updateCexPrice('WETH', 3500);

      // Give event loop a tick
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(alertSpy).not.toHaveBeenCalled();
    });

    it('should return active alerts via getActiveAlerts', () => {
      const lowThresholdService = new CexPriceFeedService({
        skipExternalConnection: true,
        alertThresholdPct: 0.1,
      });

      lowThresholdService.updateDexPrice('WETH', 'ethereum', 3520);
      lowThresholdService.updateCexPrice('WETH', 3500);

      const alerts = lowThresholdService.getActiveAlerts();
      expect(alerts.length).toBeGreaterThanOrEqual(1);
      expect(alerts[0].tokenId).toBe('WETH');
    });
  });

  // ===========================================================================
  // Singleton
  // ===========================================================================

  describe('singleton', () => {
    it('should return the same instance on repeated calls', () => {
      const a = getCexPriceFeedService({ skipExternalConnection: true });
      const b = getCexPriceFeedService();

      expect(a).toBe(b);
    });

    it('should reset singleton on resetCexPriceFeedService', async () => {
      const a = getCexPriceFeedService({ skipExternalConnection: true });
      await resetCexPriceFeedService();
      const b = getCexPriceFeedService({ skipExternalConnection: true });

      expect(a).not.toBe(b);
    });
  });

  // ===========================================================================
  // Accessor
  // ===========================================================================

  describe('getSpreadCalculator', () => {
    it('should expose the underlying spread calculator', () => {
      const calc = service.getSpreadCalculator();
      expect(calc).toBeDefined();
      expect(typeof calc.getSpread).toBe('function');
    });
  });

  // ===========================================================================
  // Config
  // ===========================================================================

  describe('configuration', () => {
    it('should accept custom alert threshold', () => {
      const customService = new CexPriceFeedService({
        skipExternalConnection: true,
        alertThresholdPct: 1.5,
      });

      // With 1.5% threshold, a 0.5% spread should NOT be an active alert
      customService.updateDexPrice('WETH', 'ethereum', 3517.5);
      customService.updateCexPrice('WETH', 3500);

      const alerts = customService.getActiveAlerts();
      expect(alerts.length).toBe(0);
    });

    it('should accept custom max CEX price age', () => {
      const customService = new CexPriceFeedService({
        skipExternalConnection: true,
        maxCexPriceAgeMs: 5000,
      });

      expect(customService).toBeDefined();
    });
  });

  // ===========================================================================
  // Simulation Mode
  // ===========================================================================

  describe('simulation mode (simulateCexPrices)', () => {
    it('should auto-generate CEX prices from DEX updates when enabled', () => {
      const simService = new CexPriceFeedService({
        skipExternalConnection: true,
        simulateCexPrices: true,
      });

      // Feed a DEX price — should auto-generate a synthetic CEX price
      simService.updateDexPrice('WETH', 'ethereum', 3500);

      // Spread should now be defined (synthetic CEX price was generated)
      const spread = simService.getSpread('WETH', 'ethereum');
      expect(spread).toBeDefined();
      // Synthetic CEX price is ±0.15% of DEX price, so spread should be small
      expect(Math.abs(spread!)).toBeLessThan(0.5);
    });

    it('should not auto-generate CEX prices when simulation disabled', () => {
      const liveService = new CexPriceFeedService({
        skipExternalConnection: true,
        simulateCexPrices: false,
      });

      liveService.updateDexPrice('WETH', 'ethereum', 3500);

      // No CEX price → no spread
      const spread = liveService.getSpread('WETH', 'ethereum');
      expect(spread).toBeUndefined();
    });

    it('should produce realistic spread values in simulation mode', () => {
      const simService = new CexPriceFeedService({
        skipExternalConnection: true,
        simulateCexPrices: true,
      });

      // Feed multiple DEX prices to test spread distribution
      const spreads: number[] = [];
      for (let i = 0; i < 20; i++) {
        simService.updateDexPrice('WETH', 'ethereum', 3500 + i * 0.01);
        const spread = simService.getSpread('WETH', 'ethereum');
        if (spread !== undefined) spreads.push(spread);
      }

      expect(spreads.length).toBeGreaterThan(0);
      // All spreads should be within ±0.3% (the noise range is ±0.15%)
      for (const s of spreads) {
        expect(Math.abs(s)).toBeLessThan(0.3);
      }
    });
  });

  // ===========================================================================
  // Health Tracking
  // ===========================================================================

  describe('health tracking', () => {
    /** Helper to get the most recently created mock WS instance */
    function getLatestMockWsInstance(): ReturnType<typeof MockBinanceWsClient> {
      const results = (MockBinanceWsClient as jest.Mock).mock.results;
      return results[results.length - 1].value;
    }

    it('should report PASSIVE status when skipExternalConnection is true', async () => {
      await service.start();
      const snap = service.getHealthSnapshot();
      expect(snap.status).toBe(CexFeedHealthStatus.PASSIVE);
      expect(snap.isDegraded).toBe(false);
    });

    it('should include health status in getStats()', async () => {
      await service.start();
      const stats = service.getStats();
      expect(stats.healthStatus).toBe(CexFeedHealthStatus.PASSIVE);
    });

    it('should report CONNECTED when live WS connects', async () => {
      const liveService = new CexPriceFeedService();
      mockConnect.mockResolvedValueOnce(undefined);
      mockIsConnected.mockReturnValue(true);
      await liveService.start();

      // Simulate the 'connected' event from wsClient
      const wsInstance = getLatestMockWsInstance();
      wsInstance.emit('connected');

      const snap = liveService.getHealthSnapshot();
      expect(snap.status).toBe(CexFeedHealthStatus.CONNECTED);
      await liveService.stop();
    });

    it('should report RECONNECTING after WS disconnects', async () => {
      const liveService = new CexPriceFeedService();
      mockConnect.mockResolvedValueOnce(undefined);
      await liveService.start();

      const wsInstance = getLatestMockWsInstance();
      wsInstance.emit('connected');
      wsInstance.emit('disconnected');

      const snap = liveService.getHealthSnapshot();
      expect(snap.status).toBe(CexFeedHealthStatus.RECONNECTING);
      await liveService.stop();
    });

    it('should report DEGRADED after maxReconnectFailed', async () => {
      const liveService = new CexPriceFeedService();
      mockConnect.mockResolvedValueOnce(undefined);
      await liveService.start();

      const wsInstance = getLatestMockWsInstance();
      wsInstance.emit('connected');
      wsInstance.emit('disconnected');
      wsInstance.emit('maxReconnectFailed', 10);

      const snap = liveService.getHealthSnapshot();
      expect(snap.status).toBe(CexFeedHealthStatus.DEGRADED);
      expect(snap.isDegraded).toBe(true);
      expect(snap.disconnectedSince).not.toBeNull();
      await liveService.stop();
    });
  });
});
