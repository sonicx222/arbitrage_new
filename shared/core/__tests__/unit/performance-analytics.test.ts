/**
 * Performance Analytics Engine Unit Tests
 *
 * Tests for trade recording, metrics calculation, risk metrics,
 * strategy attribution, alerts, and benchmark comparison.
 *
 * @see shared/core/src/analytics/performance-analytics.ts
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Make this file a module to avoid TS2451 redeclaration errors
export {};

// Create mock Redis BEFORE jest.mock to ensure they're captured
const mockRedisInstance = {
  set: jest.fn<any>(() => Promise.resolve('OK')),
  get: jest.fn<any>(() => Promise.resolve(null)),
  lpush: jest.fn<any>(() => Promise.resolve(1)),
  ltrim: jest.fn<any>(() => Promise.resolve('OK')),
  lrange: jest.fn<any>(() => Promise.resolve([]))
};

const mockLogger = {
  info: jest.fn<any>(),
  warn: jest.fn<any>(),
  error: jest.fn<any>(),
  debug: jest.fn<any>()
};

// Mock logger - hoisted above imports
jest.mock('../../src/logger', () => ({
  createLogger: () => mockLogger
}));

// Mock redis module - hoisted above imports
jest.mock('../../src/redis', () => ({
  getRedisClient: () => Promise.resolve(mockRedisInstance)
}));

import { PerformanceAnalyticsEngine } from '../../src/analytics/performance-analytics';
import type { PerformanceMetrics } from '../../src/analytics/performance-analytics';

// =============================================================================
// Test Helpers
// =============================================================================

function createTrade(overrides: Record<string, unknown> = {}) {
  return {
    id: `trade_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    strategy: 'cross-dex',
    asset: 'ETH',
    side: 'buy' as const,
    entryTime: Date.now() - 60000,
    exitTime: Date.now(),
    entryPrice: 2000,
    exitPrice: 2050,
    quantity: 1,
    realizedPnL: 50,
    fees: 5,
    slippage: 2,
    executionTime: 150,
    ...overrides
  };
}

describe('PerformanceAnalyticsEngine', () => {
  let engine: PerformanceAnalyticsEngine;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisInstance.lrange.mockImplementation(() => Promise.resolve([]));
    mockRedisInstance.set.mockImplementation(() => Promise.resolve('OK'));
    mockRedisInstance.get.mockImplementation(() => Promise.resolve(null));
    mockRedisInstance.lpush.mockImplementation(() => Promise.resolve(1));
    mockRedisInstance.ltrim.mockImplementation(() => Promise.resolve('OK'));
    engine = new PerformanceAnalyticsEngine();
  });

  // ===========================================================================
  // recordTrade
  // ===========================================================================

  describe('recordTrade', () => {
    it('should record a trade with calculated fields', async () => {
      const trade = createTrade({
        realizedPnL: 50,
        fees: 5,
        slippage: 2
      });

      await engine.recordTrade(trade);

      // Should store in Redis
      expect(mockRedisInstance.set).toHaveBeenCalled();
      expect(mockRedisInstance.lpush).toHaveBeenCalledWith(
        'trade_history',
        expect.any(String)
      );
    });

    it('should calculate net PnL correctly (realized - fees - slippage)', async () => {
      const trade = createTrade({
        realizedPnL: 100,
        fees: 10,
        slippage: 5
      });

      await engine.recordTrade(trade);

      // Verify the stored trade JSON has correct netPnL
      const storedJson = (mockRedisInstance.lpush as jest.Mock).mock.calls[0][1] as string;
      const storedTrade = JSON.parse(storedJson);
      expect(storedTrade.netPnL).toBe(85); // 100 - 10 - 5
    });

    it('should calculate return correctly', async () => {
      const trade = createTrade({
        entryPrice: 2000,
        exitPrice: 2100
      });

      await engine.recordTrade(trade);

      const storedJson = (mockRedisInstance.lpush as jest.Mock).mock.calls[0][1] as string;
      const storedTrade = JSON.parse(storedJson);
      expect(storedTrade.return).toBeCloseTo(0.05, 4); // (2100 - 2000) / 2000 = 0.05
    });

    it('should maintain history size limit', async () => {
      // Record trades beyond the in-memory limit
      for (let i = 0; i < 5; i++) {
        await engine.recordTrade(createTrade({ id: `trade_${i}` }));
      }

      // Redis ltrim should be called to keep list bounded
      expect(mockRedisInstance.ltrim).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // calculateMetrics
  // ===========================================================================

  describe('calculateMetrics', () => {
    it('should return empty metrics when no trades', async () => {
      const metrics = await engine.calculateMetrics('daily');

      expect(metrics.totalTrades).toBe(0);
      expect(metrics.totalPnL).toBe(0);
      expect(metrics.winRate).toBe(0);
    });

    it('should calculate basic metrics for winning trades', async () => {
      const now = Date.now();
      // Record winning trades
      await engine.recordTrade(createTrade({
        entryTime: now - 30000,
        exitTime: now - 20000,
        entryPrice: 2000,
        exitPrice: 2100,
        realizedPnL: 100,
        fees: 5,
        slippage: 2,
        strategy: 'arb'
      }));
      await engine.recordTrade(createTrade({
        entryTime: now - 10000,
        exitTime: now - 5000,
        entryPrice: 2000,
        exitPrice: 2050,
        realizedPnL: 50,
        fees: 3,
        slippage: 1,
        strategy: 'arb'
      }));

      const metrics = await engine.calculateMetrics('daily');

      expect(metrics.totalTrades).toBe(2);
      expect(metrics.winningTrades).toBe(2);
      expect(metrics.losingTrades).toBe(0);
      expect(metrics.totalPnL).toBeGreaterThan(0);
      expect(metrics.winRate).toBe(1);
    });

    it('should calculate win rate with mixed trades', async () => {
      const now = Date.now();
      // Winning trade
      await engine.recordTrade(createTrade({
        entryTime: now - 30000,
        exitTime: now - 20000,
        realizedPnL: 100,
        fees: 5,
        slippage: 2
      }));
      // Losing trade
      await engine.recordTrade(createTrade({
        entryTime: now - 10000,
        exitTime: now - 5000,
        realizedPnL: -50,
        fees: 5,
        slippage: 2
      }));

      const metrics = await engine.calculateMetrics('daily');

      expect(metrics.totalTrades).toBe(2);
      expect(metrics.winRate).toBe(0.5);
    });

    it('should calculate volatility', async () => {
      const now = Date.now();
      // Add several trades with varying returns
      const returns = [0.05, -0.02, 0.03, -0.01, 0.04, -0.03, 0.02];
      for (let i = 0; i < returns.length; i++) {
        const price = 2000;
        const exitPrice = price * (1 + returns[i]);
        await engine.recordTrade(createTrade({
          entryTime: now - (returns.length - i) * 10000,
          exitTime: now - (returns.length - i) * 10000 + 5000,
          entryPrice: price,
          exitPrice,
          realizedPnL: (exitPrice - price) * 1,
          fees: 1,
          slippage: 0.5
        }));
      }

      const metrics = await engine.calculateMetrics('daily');
      expect(metrics.volatility).toBeGreaterThan(0);
    });

    it('should calculate Sharpe ratio', async () => {
      const now = Date.now();
      // Add consistently positive trades for positive Sharpe
      for (let i = 0; i < 10; i++) {
        await engine.recordTrade(createTrade({
          entryTime: now - (10 - i) * 10000,
          exitTime: now - (10 - i) * 10000 + 5000,
          entryPrice: 2000,
          exitPrice: 2020 + i * 5,
          realizedPnL: 20 + i * 5,
          fees: 2,
          slippage: 1
        }));
      }

      const metrics = await engine.calculateMetrics('daily');
      // With consistently positive returns, Sharpe should be positive
      expect(typeof metrics.sharpeRatio).toBe('number');
      expect(metrics.sharpeRatio).not.toBeNaN();
    });

    it('should calculate profit factor', async () => {
      const now = Date.now();
      // Add winning trade
      await engine.recordTrade(createTrade({
        entryTime: now - 20000,
        exitTime: now - 15000,
        realizedPnL: 100,
        fees: 0,
        slippage: 0
      }));
      // Add losing trade
      await engine.recordTrade(createTrade({
        entryTime: now - 10000,
        exitTime: now - 5000,
        realizedPnL: -40,
        fees: 0,
        slippage: 0
      }));

      const metrics = await engine.calculateMetrics('daily');
      // Profit factor = total wins / total losses = 100 / 40 = 2.5
      expect(metrics.profitFactor).toBeGreaterThan(1);
    });

    it('should calculate max drawdown', async () => {
      const now = Date.now();
      // Sequence: win, win, loss, loss, win
      const pnls = [50, 30, -80, -20, 40];
      for (let i = 0; i < pnls.length; i++) {
        const pnl = pnls[i];
        const entryPrice = 2000;
        const exitPrice = entryPrice + pnl;
        await engine.recordTrade(createTrade({
          entryTime: now - (pnls.length - i) * 10000,
          exitTime: now - (pnls.length - i) * 10000 + 5000,
          entryPrice,
          exitPrice,
          realizedPnL: pnl,
          fees: 0,
          slippage: 0
        }));
      }

      const metrics = await engine.calculateMetrics('daily');
      expect(metrics.maxDrawdown).toBeGreaterThan(0);
    });

    it('should handle strategy attribution', async () => {
      const now = Date.now();
      await engine.recordTrade(createTrade({
        strategy: 'cross-dex',
        entryTime: now - 20000,
        exitTime: now - 15000,
        realizedPnL: 100,
        fees: 5,
        slippage: 2
      }));
      await engine.recordTrade(createTrade({
        strategy: 'flash-loan',
        entryTime: now - 10000,
        exitTime: now - 5000,
        realizedPnL: 50,
        fees: 3,
        slippage: 1
      }));

      const metrics = await engine.calculateMetrics('daily');
      expect(typeof metrics.byStrategy['cross-dex']).toBe('object');
      expect(typeof metrics.byStrategy['flash-loan']).toBe('object');
      expect(metrics.byStrategy['cross-dex'].trades).toBe(1);
    });

    it('should handle asset attribution', async () => {
      const now = Date.now();
      await engine.recordTrade(createTrade({
        asset: 'ETH',
        entryTime: now - 20000,
        exitTime: now - 15000,
        realizedPnL: 100,
        fees: 5,
        slippage: 2
      }));
      await engine.recordTrade(createTrade({
        asset: 'BTC',
        entryTime: now - 10000,
        exitTime: now - 5000,
        realizedPnL: 50,
        fees: 3,
        slippage: 1
      }));

      const metrics = await engine.calculateMetrics('daily');
      expect(typeof metrics.byAsset['ETH']).toBe('object');
      expect(typeof metrics.byAsset['BTC']).toBe('object');
    });

    it('should handle time-of-day attribution', async () => {
      const now = Date.now();
      await engine.recordTrade(createTrade({
        entryTime: now - 20000,
        exitTime: now - 15000,
        realizedPnL: 100,
        fees: 5,
        slippage: 2
      }));

      const metrics = await engine.calculateMetrics('daily');
      expect(Object.keys(metrics.byTimeOfDay).length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Performance Alerts
  // ===========================================================================

  describe('getPerformanceAlerts', () => {
    it('should generate drawdown alert above 10%', () => {
      const metrics = {
        currentDrawdown: 0.15,
        sharpeRatio: 1.0,
        winRate: 0.6,
        volatility: 0.1
      } as PerformanceMetrics;

      const alerts = engine.getPerformanceAlerts(metrics);
      const drawdownAlert = alerts.find(a => a.metric === 'drawdown');
      expect(drawdownAlert).not.toBeUndefined();
      expect(drawdownAlert!.level).toBe('warning');
    });

    it('should generate critical alert for drawdown above 20%', () => {
      const metrics = {
        currentDrawdown: 0.25,
        sharpeRatio: 1.0,
        winRate: 0.6,
        volatility: 0.1
      } as PerformanceMetrics;

      const alerts = engine.getPerformanceAlerts(metrics);
      const drawdownAlert = alerts.find(a => a.metric === 'drawdown');
      expect(drawdownAlert!.level).toBe('critical');
    });

    it('should generate low Sharpe ratio alert', () => {
      const metrics = {
        currentDrawdown: 0,
        sharpeRatio: 0.3,
        winRate: 0.6,
        volatility: 0.1
      } as PerformanceMetrics;

      const alerts = engine.getPerformanceAlerts(metrics);
      const sharpeAlert = alerts.find(a => a.metric === 'sharpe_ratio');
      expect(sharpeAlert).toEqual(expect.objectContaining({ metric: 'sharpe_ratio' }));
    });

    it('should generate low win rate alert', () => {
      const metrics = {
        currentDrawdown: 0,
        sharpeRatio: 1.0,
        winRate: 0.3,
        volatility: 0.1
      } as PerformanceMetrics;

      const alerts = engine.getPerformanceAlerts(metrics);
      const winRateAlert = alerts.find(a => a.metric === 'win_rate');
      expect(winRateAlert).toEqual(expect.objectContaining({ metric: 'win_rate' }));
    });

    it('should generate high volatility alert', () => {
      const metrics = {
        currentDrawdown: 0,
        sharpeRatio: 1.0,
        winRate: 0.6,
        volatility: 0.4
      } as PerformanceMetrics;

      const alerts = engine.getPerformanceAlerts(metrics);
      const volAlert = alerts.find(a => a.metric === 'volatility');
      expect(volAlert).toEqual(expect.objectContaining({ metric: 'volatility' }));
    });

    it('should return no alerts for healthy metrics', () => {
      const metrics = {
        currentDrawdown: 0.02,
        sharpeRatio: 2.0,
        winRate: 0.7,
        volatility: 0.1
      } as PerformanceMetrics;

      const alerts = engine.getPerformanceAlerts(metrics);
      expect(alerts.length).toBe(0);
    });
  });

  // ===========================================================================
  // Benchmark comparison
  // ===========================================================================

  describe('compareWithBenchmark', () => {
    it('should calculate excess return vs benchmark', async () => {
      const metrics = {
        totalPnL: 0.1,
        volatility: 0.15,
        totalTrades: 10,
        timestamp: Date.now(),
        period: 'monthly' as const
      } as PerformanceMetrics;

      const comparison = await engine.compareWithBenchmark(metrics, 'ETH', 'monthly');
      expect(comparison.benchmark).toBe('ETH');
      expect(typeof comparison.excessReturn).toBe('number');
      expect(comparison.excessReturn).not.toBeNaN();
      expect(comparison.strategyReturn).toBe(0.1);
    });
  });

  // ===========================================================================
  // Attribution analysis
  // ===========================================================================

  describe('generateAttributionAnalysis', () => {
    it('should generate attribution breakdown', async () => {
      const metrics = {
        totalPnL: 1000,
        period: 'monthly' as const,
        timestamp: Date.now()
      } as PerformanceMetrics;

      const attribution = await engine.generateAttributionAnalysis(metrics, 'ETH');
      expect(attribution.totalReturn).toBe(1000);
      expect(typeof attribution.marketContribution).toBe('number');
      expect(attribution.marketContribution).not.toBeNaN();
      expect(typeof attribution.strategyContribution).toBe('number');
      expect(attribution.strategyContribution).not.toBeNaN();
    });
  });

  // ===========================================================================
  // Report generation
  // ===========================================================================

  describe('generateReport', () => {
    it('should generate a complete report', async () => {
      const report = await engine.generateReport('daily');

      expect(typeof report.generatedAt).toBe('string');
      expect(report.period).toBe('daily');
      expect(typeof report.summary).toBe('object');
      expect(typeof report.riskMetrics).toBe('object');
      expect(typeof report.efficiencyMetrics).toBe('object');
      expect(Array.isArray(report.alerts)).toBe(true);

      // Should cache report in Redis
      expect(mockRedisInstance.set).toHaveBeenCalled();
    });

    // Regression test for Fix #20: PerformanceReport interface shape
    it('should return a report matching PerformanceReport interface shape', async () => {
      const report = await engine.generateReport('daily');

      // Verify all top-level keys exist with correct types
      expect(typeof report.generatedAt).toBe('string');
      expect(report.period).toBe('daily');
      expect(report.summary).toEqual(expect.objectContaining({
        totalTrades: expect.any(Number),
        totalPnL: expect.any(Number),
        winRate: expect.any(Number),
        sharpeRatio: expect.any(Number),
        maxDrawdown: expect.any(Number)
      }));
      expect(report.riskMetrics).toEqual(expect.objectContaining({
        volatility: expect.any(Number),
        valueAtRisk: expect.any(Number),
        sortinoRatio: expect.any(Number),
        calmarRatio: expect.any(Number)
      }));
      expect(report.efficiencyMetrics).toEqual(expect.objectContaining({
        profitFactor: expect.any(Number),
        averageWin: expect.any(Number),
        averageLoss: expect.any(Number),
        averageTradeDuration: expect.any(Number)
      }));
      expect(Array.isArray(report.alerts)).toBe(true);
      expect(typeof report.attribution).toBe('object');
      expect(Array.isArray(report.benchmarks)).toBe(true);
      expect(typeof report.strategyBreakdown).toBe('object');
      expect(typeof report.assetBreakdown).toBe('object');
      expect(typeof report.timeBreakdown).toBe('object');
    });
  });

  // ===========================================================================
  // Regression: Fix #13 - Single-pass metrics (replaces 8 separate O(N) passes)
  // ===========================================================================

  describe('single-pass metrics regression (Fix #13)', () => {
    it('should compute correct values for all-winning trades', async () => {
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        await engine.recordTrade(createTrade({
          entryTime: now - (5 - i) * 10000,
          exitTime: now - (5 - i) * 10000 + 5000,
          entryPrice: 2000,
          exitPrice: 2050,
          realizedPnL: 50,
          fees: 2,
          slippage: 1
        }));
      }

      const metrics = await engine.calculateMetrics('daily');
      expect(metrics.winningTrades).toBe(5);
      expect(metrics.losingTrades).toBe(0);
      expect(metrics.largestWin).toBe(47); // 50 - 2 - 1 = 47 netPnL
      expect(metrics.largestLoss).toBe(0); // No losses, so edge-case fix sets to 0
      expect(metrics.winRate).toBe(1);
      expect(metrics.averageLoss).toBe(0);
      expect(metrics.averageWin).toBeCloseTo(47, 0);
    });

    it('should compute correct values for all-losing trades', async () => {
      const now = Date.now();
      for (let i = 0; i < 3; i++) {
        await engine.recordTrade(createTrade({
          entryTime: now - (3 - i) * 10000,
          exitTime: now - (3 - i) * 10000 + 5000,
          entryPrice: 2000,
          exitPrice: 1950,
          realizedPnL: -50,
          fees: 2,
          slippage: 1
        }));
      }

      const metrics = await engine.calculateMetrics('daily');
      expect(metrics.winningTrades).toBe(0);
      expect(metrics.losingTrades).toBe(3);
      expect(metrics.largestWin).toBe(0); // No wins, edge-case fix sets to 0
      expect(metrics.largestLoss).toBe(-53); // -50 - 2 - 1 = -53 netPnL (most negative)
      expect(metrics.winRate).toBe(0);
      expect(metrics.averageWin).toBe(0);
      expect(metrics.averageLoss).toBeCloseTo(53, 0);
    });

    it('should compute correct values for mixed win/loss with zero-PnL trade', async () => {
      const now = Date.now();
      // Win: netPnL = 100 - 5 - 2 = 93
      await engine.recordTrade(createTrade({
        entryTime: now - 30000,
        exitTime: now - 25000,
        entryPrice: 2000,
        exitPrice: 2100,
        realizedPnL: 100,
        fees: 5,
        slippage: 2
      }));
      // Zero PnL trade: netPnL = 7 - 5 - 2 = 0
      await engine.recordTrade(createTrade({
        entryTime: now - 20000,
        exitTime: now - 15000,
        entryPrice: 2000,
        exitPrice: 2007,
        realizedPnL: 7,
        fees: 5,
        slippage: 2
      }));
      // Loss: netPnL = -60 - 5 - 2 = -67
      await engine.recordTrade(createTrade({
        entryTime: now - 10000,
        exitTime: now - 5000,
        entryPrice: 2000,
        exitPrice: 1940,
        realizedPnL: -60,
        fees: 5,
        slippage: 2
      }));

      const metrics = await engine.calculateMetrics('daily');
      expect(metrics.totalTrades).toBe(3);
      expect(metrics.winningTrades).toBe(1); // Only netPnL > 0 counts
      expect(metrics.losingTrades).toBe(1); // Only netPnL < 0 counts
      // Zero PnL trade doesn't count as win OR loss
      expect(metrics.winningTrades + metrics.losingTrades).toBe(2);
      expect(metrics.largestWin).toBe(93);
      expect(metrics.largestLoss).toBe(-67);
    });
  });

  // ===========================================================================
  // Regression: Fix #4 - deterministic beta
  // ===========================================================================

  describe('calculateBeta determinism (regression for Fix #4)', () => {
    it('should return beta of 1.0 (deterministic, no Math.random)', async () => {
      const now = Date.now();
      // Add trades so calculateMetrics has data
      for (let i = 0; i < 5; i++) {
        await engine.recordTrade(createTrade({
          entryTime: now - (5 - i) * 10000,
          exitTime: now - (5 - i) * 10000 + 5000,
          entryPrice: 2000,
          exitPrice: 2000 + (i % 2 === 0 ? 20 : -10),
          realizedPnL: i % 2 === 0 ? 20 : -10,
          fees: 1,
          slippage: 0.5
        }));
      }

      const metrics = await engine.calculateMetrics('daily');
      expect(metrics.beta).toBe(1.0);
    });

    it('should return identical beta across multiple calls', async () => {
      const now = Date.now();
      for (let i = 0; i < 3; i++) {
        await engine.recordTrade(createTrade({
          entryTime: now - (3 - i) * 10000,
          exitTime: now - (3 - i) * 10000 + 5000,
          entryPrice: 2000,
          exitPrice: 2050,
          realizedPnL: 50,
          fees: 2,
          slippage: 1
        }));
      }

      const metrics1 = await engine.calculateMetrics('daily');
      const metrics2 = await engine.calculateMetrics('daily');
      expect(metrics1.beta).toBe(metrics2.beta);
      expect(metrics1.beta).toBe(1.0);
    });
  });
});
