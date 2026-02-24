/**
 * CexDexSpreadCalculator Tests
 *
 * Tests for CEX-DEX spread calculation, alert emission, and history tracking.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// =============================================================================
// Mock Setup
// =============================================================================

jest.mock('../../../src/logger');

// =============================================================================
// Imports
// =============================================================================

import { CexDexSpreadCalculator, SpreadAlert } from '../../../src/analytics/cex-dex-spread';

// =============================================================================
// Tests
// =============================================================================

describe('CexDexSpreadCalculator', () => {
  let calculator: CexDexSpreadCalculator;
  const now = 1708992000000;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(now);
    calculator = new CexDexSpreadCalculator({
      alertThresholdPct: 0.3,
      historyWindowMs: 300_000, // 5 minutes
      maxTokens: 50,
    });
  });

  // ===========================================================================
  // Spread Calculation
  // ===========================================================================

  describe('spread calculation', () => {
    it('should calculate correct positive spread (DEX overpriced)', () => {
      // CEX: $43000, DEX: $43200 -> spread = (43200 - 43000) / 43000 * 100 = 0.4651%
      calculator.updateDexPrice('WBTC', 'ethereum', 43200, now);
      calculator.updateCexPrice('WBTC', 43000, now);

      const spread = calculator.getSpread('WBTC', 'ethereum');
      expect(spread).toBeDefined();
      expect(spread).toBeCloseTo(0.4651, 3);
    });

    it('should calculate correct negative spread (DEX underpriced)', () => {
      // CEX: $43000, DEX: $42800 -> spread = (42800 - 43000) / 43000 * 100 = -0.4651%
      calculator.updateDexPrice('WBTC', 'ethereum', 42800, now);
      calculator.updateCexPrice('WBTC', 43000, now);

      const spread = calculator.getSpread('WBTC', 'ethereum');
      expect(spread).toBeDefined();
      expect(spread).toBeCloseTo(-0.4651, 3);
    });

    it('should calculate zero spread for equal prices', () => {
      calculator.updateDexPrice('WETH', 'arbitrum', 2850, now);
      calculator.updateCexPrice('WETH', 2850, now);

      const spread = calculator.getSpread('WETH', 'arbitrum');
      expect(spread).toBe(0);
    });

    it('should return undefined when CEX price is missing', () => {
      calculator.updateDexPrice('WBTC', 'ethereum', 43000, now);

      const spread = calculator.getSpread('WBTC', 'ethereum');
      expect(spread).toBeUndefined();
    });

    it('should return undefined when DEX price is missing', () => {
      // CEX update with no DEX entry does not create a state entry
      calculator.updateCexPrice('WBTC', 43000, now);

      const spread = calculator.getSpread('WBTC', 'ethereum');
      expect(spread).toBeUndefined();
    });

    it('should return undefined for unknown token-chain pair', () => {
      const spread = calculator.getSpread('UNKNOWN', 'ethereum');
      expect(spread).toBeUndefined();
    });

    it('should handle zero CEX price gracefully', () => {
      calculator.updateDexPrice('WBTC', 'ethereum', 43000, now);
      calculator.updateCexPrice('WBTC', 0, now);

      const spread = calculator.getSpread('WBTC', 'ethereum');
      expect(spread).toBe(0); // Division by zero guarded
    });
  });

  // ===========================================================================
  // Alert Emission
  // ===========================================================================

  describe('spread alerts', () => {
    it('should emit alert when spread exceeds threshold', () => {
      const alertHandler = jest.fn<(alert: SpreadAlert) => void>();
      calculator.on('spread_alert', alertHandler);

      // 0.5% spread > 0.3% threshold
      calculator.updateDexPrice('WBTC', 'ethereum', 43215, now);
      calculator.updateCexPrice('WBTC', 43000, now);

      expect(alertHandler).toHaveBeenCalledTimes(1);
      const alert = alertHandler.mock.calls[0][0];
      expect(alert.tokenId).toBe('WBTC');
      expect(alert.chain).toBe('ethereum');
      expect(alert.cexPrice).toBe(43000);
      expect(alert.dexPrice).toBe(43215);
      expect(alert.spreadPct).toBeCloseTo(0.5, 1);
    });

    it('should NOT emit alert when spread is within threshold', () => {
      const alertHandler = jest.fn();
      calculator.on('spread_alert', alertHandler);

      // 0.1% spread < 0.3% threshold
      calculator.updateDexPrice('WBTC', 'ethereum', 43043, now);
      calculator.updateCexPrice('WBTC', 43000, now);

      expect(alertHandler).not.toHaveBeenCalled();
    });

    it('should emit alert for negative spread exceeding threshold', () => {
      const alertHandler = jest.fn<(alert: SpreadAlert) => void>();
      calculator.on('spread_alert', alertHandler);

      // -0.5% spread, |spread| > 0.3%
      calculator.updateDexPrice('WBTC', 'ethereum', 42785, now);
      calculator.updateCexPrice('WBTC', 43000, now);

      expect(alertHandler).toHaveBeenCalledTimes(1);
      expect(alertHandler.mock.calls[0][0].spreadPct).toBeLessThan(0);
    });

    it('should emit alert when CEX price update triggers threshold crossing', () => {
      const alertHandler = jest.fn<(alert: SpreadAlert) => void>();
      calculator.on('spread_alert', alertHandler);

      // Set up DEX price first
      calculator.updateDexPrice('WETH', 'ethereum', 2860, now);

      // CEX price that creates > 0.3% spread
      calculator.updateCexPrice('WETH', 2850, now);

      expect(alertHandler).toHaveBeenCalledTimes(1);
      expect(alertHandler.mock.calls[0][0].tokenId).toBe('WETH');
    });

    it('should emit alert when DEX price update triggers threshold crossing', () => {
      const alertHandler = jest.fn<(alert: SpreadAlert) => void>();
      calculator.on('spread_alert', alertHandler);

      // Set up CEX price first (no alert since no DEX)
      calculator.updateDexPrice('WETH', 'ethereum', 2850, now);
      calculator.updateCexPrice('WETH', 2850, now);

      // Now update DEX to trigger spread
      calculator.updateDexPrice('WETH', 'ethereum', 2860, now + 1000);

      // First call was the CEX update (spread = 0, no alert)
      // Second call is the DEX update triggering alert
      expect(alertHandler).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // Multiple Chains
  // ===========================================================================

  describe('multiple chains', () => {
    it('should track chains independently for the same token', () => {
      calculator.updateDexPrice('WETH', 'ethereum', 2855, now);
      calculator.updateDexPrice('WETH', 'arbitrum', 2860, now);
      calculator.updateCexPrice('WETH', 2850, now);

      const ethSpread = calculator.getSpread('WETH', 'ethereum');
      const arbSpread = calculator.getSpread('WETH', 'arbitrum');

      expect(ethSpread).toBeDefined();
      expect(arbSpread).toBeDefined();
      // Different DEX prices should produce different spreads
      expect(ethSpread).not.toBe(arbSpread);
    });

    it('should update CEX price across all chains for a token', () => {
      calculator.updateDexPrice('WETH', 'ethereum', 2860, now);
      calculator.updateDexPrice('WETH', 'arbitrum', 2860, now);

      // Single CEX update should affect both chains
      calculator.updateCexPrice('WETH', 2850, now);

      const ethSpread = calculator.getSpread('WETH', 'ethereum');
      const arbSpread = calculator.getSpread('WETH', 'arbitrum');

      // Same CEX + same DEX = same spread
      expect(ethSpread).toBe(arbSpread);
    });

    it('should not affect other tokens when updating one token', () => {
      calculator.updateDexPrice('WBTC', 'ethereum', 43200, now);
      calculator.updateDexPrice('WETH', 'ethereum', 2860, now);
      calculator.updateCexPrice('WBTC', 43000, now);

      // WETH should still have no CEX price since updateCexPrice for WBTC
      // only updates WBTC entries
      const ethSpread = calculator.getSpread('WETH', 'ethereum');
      expect(ethSpread).toBeUndefined();
    });
  });

  // ===========================================================================
  // Spread History
  // ===========================================================================

  describe('spread history', () => {
    it('should record spread history on price updates', () => {
      calculator.updateDexPrice('WBTC', 'ethereum', 43200, now);
      calculator.updateCexPrice('WBTC', 43000, now);

      const history = calculator.getSpreadHistory('WBTC', 'ethereum');
      expect(history.length).toBeGreaterThan(0);
      expect(history[0].spreadPct).toBeCloseTo(0.4651, 3);
    });

    it('should respect time window for history', () => {
      // Add old entry
      (Date.now as jest.Mock).mockReturnValue(now - 400_000); // 6.67 min ago
      calculator.updateDexPrice('WBTC', 'ethereum', 43100, now - 400_000);
      calculator.updateCexPrice('WBTC', 43000, now - 400_000);

      // Add recent entry
      (Date.now as jest.Mock).mockReturnValue(now);
      calculator.updateCexPrice('WBTC', 43050, now);

      const history = calculator.getSpreadHistory('WBTC', 'ethereum');

      // Old entry (6.67 min ago) should be outside 5-minute window
      // Recent entry should be included
      const recentEntries = history.filter(h => h.timestamp >= now - 300_000);
      expect(recentEntries.length).toBe(1);
    });

    it('should return empty array for unknown pairs', () => {
      const history = calculator.getSpreadHistory('UNKNOWN', 'ethereum');
      expect(history).toEqual([]);
    });
  });

  // ===========================================================================
  // getActiveAlerts()
  // ===========================================================================

  describe('getActiveAlerts()', () => {
    it('should return all above-threshold spreads', () => {
      // Set up two tokens with above-threshold spreads
      calculator.updateDexPrice('WBTC', 'ethereum', 43215, now);
      calculator.updateDexPrice('WETH', 'arbitrum', 2860, now);
      calculator.updateCexPrice('WBTC', 43000, now);
      calculator.updateCexPrice('WETH', 2850, now);

      const alerts = calculator.getActiveAlerts();
      expect(alerts.length).toBe(2);

      const btcAlert = alerts.find(a => a.tokenId === 'WBTC');
      const ethAlert = alerts.find(a => a.tokenId === 'WETH');

      expect(btcAlert).toBeDefined();
      expect(ethAlert).toBeDefined();
      expect(btcAlert!.chain).toBe('ethereum');
      expect(ethAlert!.chain).toBe('arbitrum');
    });

    it('should exclude below-threshold spreads', () => {
      // Below threshold
      calculator.updateDexPrice('WBTC', 'ethereum', 43010, now);
      calculator.updateCexPrice('WBTC', 43000, now);

      // Above threshold
      calculator.updateDexPrice('WETH', 'arbitrum', 2860, now);
      calculator.updateCexPrice('WETH', 2850, now);

      const alerts = calculator.getActiveAlerts();
      expect(alerts.length).toBe(1);
      expect(alerts[0].tokenId).toBe('WETH');
    });

    it('should return empty array when no spreads exceed threshold', () => {
      calculator.updateDexPrice('WBTC', 'ethereum', 43001, now);
      calculator.updateCexPrice('WBTC', 43000, now);

      const alerts = calculator.getActiveAlerts();
      expect(alerts).toEqual([]);
    });

    it('should return empty array when no data exists', () => {
      const alerts = calculator.getActiveAlerts();
      expect(alerts).toEqual([]);
    });
  });

  // ===========================================================================
  // reset()
  // ===========================================================================

  describe('reset()', () => {
    it('should clear all tracked data', () => {
      calculator.updateDexPrice('WBTC', 'ethereum', 43200, now);
      calculator.updateCexPrice('WBTC', 43000, now);

      expect(calculator.getSpread('WBTC', 'ethereum')).toBeDefined();

      calculator.reset();

      expect(calculator.getSpread('WBTC', 'ethereum')).toBeUndefined();
      expect(calculator.getActiveAlerts()).toEqual([]);
      expect(calculator.getSpreadHistory('WBTC', 'ethereum')).toEqual([]);
    });
  });

  // ===========================================================================
  // Max Tokens
  // ===========================================================================

  describe('max tokens limit', () => {
    it('should enforce maxTokens limit', () => {
      const smallCalc = new CexDexSpreadCalculator({
        maxTokens: 2,
      });

      smallCalc.updateDexPrice('WBTC', 'ethereum', 43000, now);
      smallCalc.updateDexPrice('WETH', 'ethereum', 2850, now);
      smallCalc.updateDexPrice('SOL', 'solana', 100, now); // Should be rejected

      smallCalc.updateCexPrice('SOL', 100, now);
      expect(smallCalc.getSpread('SOL', 'solana')).toBeUndefined();
    });
  });

  // ===========================================================================
  // Custom Config
  // ===========================================================================

  describe('custom configuration', () => {
    it('should use custom alert threshold', () => {
      const strictCalc = new CexDexSpreadCalculator({
        alertThresholdPct: 0.1, // 0.1% threshold
      });

      const alertHandler = jest.fn();
      strictCalc.on('spread_alert', alertHandler);

      // 0.15% spread > 0.1% threshold -> should alert
      strictCalc.updateDexPrice('WBTC', 'ethereum', 43065, now);
      strictCalc.updateCexPrice('WBTC', 43000, now);

      expect(alertHandler).toHaveBeenCalledTimes(1);
    });

    it('should use default config when none provided', () => {
      const defaultCalc = new CexDexSpreadCalculator();

      // Default threshold is 0.3%
      const alertHandler = jest.fn();
      defaultCalc.on('spread_alert', alertHandler);

      // 0.2% spread < 0.3% threshold -> should NOT alert
      defaultCalc.updateDexPrice('WBTC', 'ethereum', 43086, now);
      defaultCalc.updateCexPrice('WBTC', 43000, now);

      expect(alertHandler).not.toHaveBeenCalled();
    });
  });
});
