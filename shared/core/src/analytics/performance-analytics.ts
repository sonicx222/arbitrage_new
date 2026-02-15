// Performance Analytics Engine
// Advanced performance tracking with risk-adjusted metrics and statistical analysis

import { createLogger } from '../logger';
import { getRedisClient } from '../redis';

const logger = createLogger('performance-analytics');

export interface PerformanceMetrics {
  timestamp: number;
  period: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';

  // Basic metrics
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  totalPnL: number;
  realizedPnL: number;
  unrealizedPnL: number;

  // Risk metrics
  maxDrawdown: number;
  currentDrawdown: number;
  volatility: number;
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
  valueAtRisk: number; // 95% VaR

  // Efficiency metrics
  winRate: number;
  profitFactor: number;
  averageWin: number;
  averageLoss: number;
  largestWin: number;
  largestLoss: number;
  averageTradeDuration: number;

  // Risk-adjusted returns
  alpha: number;
  beta: number;
  informationRatio: number;
  omegaRatio: number;

  // Performance attribution
  byStrategy: { [strategy: string]: StrategyPerformance };
  byAsset: { [asset: string]: AssetPerformance };
  byTimeOfDay: { [hour: number]: TimePerformance };
}

export interface StrategyPerformance {
  trades: number;
  pnl: number;
  winRate: number;
  sharpeRatio: number;
  contribution: number; // Percentage contribution to total P&L
}

export interface AssetPerformance {
  trades: number;
  pnl: number;
  exposure: number; // Percentage of portfolio
  sharpeRatio: number;
  contribution: number;
}

export interface TimePerformance {
  trades: number;
  pnl: number;
  winRate: number;
  averageReturn: number;
}

export interface BenchmarkComparison {
  benchmark: string; // e.g., "S&P 500", "BTC", "ETH"
  strategyReturn: number;
  benchmarkReturn: number;
  excessReturn: number;
  trackingError: number;
  informationRatio: number;
}

export interface AttributionAnalysis {
  totalReturn: number;
  marketContribution: number;
  strategyContribution: number;
  assetAllocationContribution: number;
  securitySelectionContribution: number;
  interactionContribution: number;
}

export interface TradeRecord {
  id: string;
  strategy: string;
  asset: string;
  side: 'buy' | 'sell' | 'long' | 'short';
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  realizedPnL: number;
  fees: number;
  slippage: number;
  executionTime: number;
  netPnL: number;
  duration: number;
  return: number;
  timestamp: number;
}

type PerformancePeriod = PerformanceMetrics['period'];

export interface PerformanceReport {
  generatedAt: string;
  period: PerformancePeriod;
  summary: {
    totalTrades: number;
    totalPnL: number;
    winRate: number;
    sharpeRatio: number;
    maxDrawdown: number;
  };
  riskMetrics: {
    volatility: number;
    valueAtRisk: number;
    sortinoRatio: number;
    calmarRatio: number;
  };
  efficiencyMetrics: {
    profitFactor: number;
    averageWin: number;
    averageLoss: number;
    averageTradeDuration: number;
  };
  alerts: Array<{
    level: 'info' | 'warning' | 'critical';
    message: string;
    metric: string;
    value: number;
    threshold: number;
  }>;
  attribution: AttributionAnalysis;
  benchmarks: BenchmarkComparison[];
  strategyBreakdown: { [strategy: string]: StrategyPerformance };
  assetBreakdown: { [asset: string]: AssetPerformance };
  timeBreakdown: { [hour: number]: TimePerformance };
}

export class PerformanceAnalyticsEngine {
  private redis = getRedisClient();
  private tradeHistory: TradeRecord[] = [];
  private maxHistorySize = 10000; // Keep last 10k trades
  private initialized: Promise<void>;

  constructor() {
    this.initialized = this.initializeTradeHistory();
  }

  // Record a completed trade
  async recordTrade(trade: {
    id: string;
    strategy: string;
    asset: string;
    side: 'buy' | 'sell' | 'long' | 'short';
    entryTime: number;
    exitTime: number;
    entryPrice: number;
    exitPrice: number;
    quantity: number;
    realizedPnL: number;
    fees: number;
    slippage: number;
    executionTime: number; // in milliseconds
  }): Promise<void> {
    await this.initialized;

    const tradeRecord = {
      ...trade,
      netPnL: trade.realizedPnL - trade.fees - trade.slippage,
      duration: trade.exitTime - trade.entryTime,
      return: (trade.exitPrice - trade.entryPrice) / trade.entryPrice,
      timestamp: Date.now()
    };

    // Add to in-memory history
    this.tradeHistory.push(tradeRecord);

    // Maintain size limit
    if (this.tradeHistory.length > this.maxHistorySize) {
      this.tradeHistory = this.tradeHistory.slice(-this.maxHistorySize);
    }

    const redis = await this.redis;
    // Store in Redis for persistence
    await redis.set(`trade:${trade.id}`, tradeRecord, 2592000); // 30 days TTL
    await redis.lpush('trade_history', JSON.stringify(tradeRecord));

    // Keep only recent trades in Redis list
    await redis.ltrim('trade_history', 0, 9999); // Keep last 10k

    logger.debug('Trade recorded', {
      id: trade.id,
      strategy: trade.strategy,
      pnl: tradeRecord.netPnL.toFixed(4),
      duration: tradeRecord.duration
    });
  }

  // Calculate performance metrics for a time period
  async calculateMetrics(
    period: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly' = 'daily',
    startDate?: number,
    endDate?: number
  ): Promise<PerformanceMetrics> {
    await this.initialized;

    const now = Date.now();
    const periodStart = startDate || this.getPeriodStart(period, now);
    const periodEnd = endDate || now;

    // Get trades for the period
    const trades = await this.getTradesInPeriod(periodStart, periodEnd);

    if (trades.length === 0) {
      return this.createEmptyMetrics(period, periodStart);
    }

    // Single-pass aggregation for basic metrics (replaces 8 separate O(N) passes)
    let totalPnL = 0;
    let totalWins = 0;
    let totalLosses = 0;
    let winCount = 0;
    let loseCount = 0;
    let largestWin = -Infinity;
    let largestLoss = Infinity;
    let totalDuration = 0;

    for (const t of trades) {
      totalPnL += t.netPnL;
      totalDuration += t.duration;
      if (t.netPnL > 0) {
        winCount++;
        totalWins += t.netPnL;
        if (t.netPnL > largestWin) largestWin = t.netPnL;
      } else if (t.netPnL < 0) {
        loseCount++;
        totalLosses += Math.abs(t.netPnL);
        if (t.netPnL < largestLoss) largestLoss = t.netPnL;
      }
    }

    // Fix edge cases for empty winner/loser sets
    if (winCount === 0) largestWin = 0;
    if (loseCount === 0) largestLoss = 0;

    const realizedPnL = totalPnL; // All trades are realized

    // Calculate returns for risk metrics
    const returns = this.calculateReturns(trades);
    const cumulativeReturns = this.calculateCumulativeReturns(returns);

    // Risk metrics
    const volatility = this.calculateVolatility(returns);
    const maxDrawdown = this.calculateMaxDrawdown(cumulativeReturns);
    const currentDrawdown = this.calculateCurrentDrawdown(cumulativeReturns);
    const sharpeRatio = this.calculateSharpeRatio(returns, volatility);
    const sortinoRatio = this.calculateSortinoRatio(returns);
    const calmarRatio = maxDrawdown > 0 ? (totalPnL / Math.abs(maxDrawdown)) : 0;
    const valueAtRisk = this.calculateVaR(returns, 0.95);

    // Efficiency metrics
    const winRate = winCount / trades.length;
    const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? 999 : 0;

    const averageWin = winCount > 0 ? totalWins / winCount : 0;
    const averageLoss = loseCount > 0 ? totalLosses / loseCount : 0;
    const averageTradeDuration = trades.length > 0 ? totalDuration / trades.length : 0;

    // Performance attribution
    const byStrategy = this.calculateStrategyPerformance(trades);
    const byAsset = this.calculateAssetPerformance(trades);
    const byTimeOfDay = this.calculateTimePerformance(trades);

    // Risk-adjusted returns (simplified calculations)
    const benchmarkReturn = await this.getBenchmarkReturn('ETH', periodStart, periodEnd);
    const alpha = totalPnL - benchmarkReturn;
    const beta = this.calculateBeta(returns);
    const informationRatio = volatility > 0 ? alpha / volatility : 0;
    const omegaRatio = this.calculateOmegaRatio(returns);

    const metrics: PerformanceMetrics = {
      timestamp: now,
      period,
      totalTrades: trades.length,
      winningTrades: winCount,
      losingTrades: loseCount,
      totalPnL,
      realizedPnL,
      unrealizedPnL: 0, // No unrealized P&L for completed trades
      maxDrawdown,
      currentDrawdown,
      volatility,
      sharpeRatio,
      sortinoRatio,
      calmarRatio,
      valueAtRisk,
      winRate,
      profitFactor,
      averageWin,
      averageLoss,
      largestWin,
      largestLoss,
      averageTradeDuration,
      alpha,
      beta,
      informationRatio,
      omegaRatio,
      byStrategy,
      byAsset,
      byTimeOfDay
    };

    // Cache metrics for quick access
    await this.cacheMetrics(metrics, period, periodStart, periodEnd);

    return metrics;
  }

  // Compare performance against benchmarks
  async compareWithBenchmark(
    strategyMetrics: PerformanceMetrics,
    benchmark: string,
    period: 'daily' | 'weekly' | 'monthly' = 'monthly'
  ): Promise<BenchmarkComparison> {
    const periodStart = this.getPeriodStart(period, strategyMetrics.timestamp);

    // Get benchmark returns (simplified - would integrate with real market data)
    const benchmarkReturn = await this.getBenchmarkReturn(benchmark, periodStart, strategyMetrics.timestamp);

    const comparison: BenchmarkComparison = {
      benchmark,
      strategyReturn: strategyMetrics.totalPnL,
      benchmarkReturn,
      excessReturn: strategyMetrics.totalPnL - benchmarkReturn,
      trackingError: this.calculateTrackingError(strategyMetrics, benchmarkReturn),
      informationRatio: strategyMetrics.volatility > 0 ?
        (strategyMetrics.totalPnL - benchmarkReturn) / strategyMetrics.volatility : 0
    };

    return comparison;
  }

  // Generate attribution analysis
  async generateAttributionAnalysis(
    metrics: PerformanceMetrics,
    benchmark: string
  ): Promise<AttributionAnalysis> {
    // Simplified attribution analysis
    const benchmarkReturn = await this.getBenchmarkReturn(
      benchmark,
      this.getPeriodStart(metrics.period, metrics.timestamp),
      metrics.timestamp
    );

    // Calculate contributions (simplified model)
    const totalReturn = metrics.totalPnL;
    const marketContribution = benchmarkReturn * 0.6; // Assume 60% market contribution
    const strategyContribution = totalReturn * 0.3; // Assume 30% strategy contribution
    const assetAllocationContribution = totalReturn * 0.05; // 5% asset allocation
    const securitySelectionContribution = totalReturn * 0.04; // 4% security selection
    const interactionContribution = totalReturn * 0.01; // 1% interaction

    return {
      totalReturn,
      marketContribution,
      strategyContribution,
      assetAllocationContribution,
      securitySelectionContribution,
      interactionContribution
    };
  }

  getPerformanceAlerts(metrics: PerformanceMetrics): Array<{
    level: 'info' | 'warning' | 'critical';
    message: string;
    metric: string;
    value: number;
    threshold: number;
  }> {
    const alerts: Array<{
      level: 'info' | 'warning' | 'critical';
      message: string;
      metric: string;
      value: number;
      threshold: number;
    }> = [];

    // Drawdown alerts
    if (metrics.currentDrawdown > 0.1) { // 10% drawdown
      alerts.push({
        level: metrics.currentDrawdown > 0.2 ? 'critical' : 'warning',
        message: `High drawdown detected: ${(metrics.currentDrawdown * 100).toFixed(1)}%`,
        metric: 'drawdown',
        value: metrics.currentDrawdown,
        threshold: 0.1
      });
    }

    // Sharpe ratio alerts
    if (metrics.sharpeRatio < 0.5) {
      alerts.push({
        level: 'warning',
        message: `Low Sharpe ratio: ${metrics.sharpeRatio.toFixed(2)}`,
        metric: 'sharpe_ratio',
        value: metrics.sharpeRatio,
        threshold: 0.5
      });
    }

    // Win rate alerts
    if (metrics.winRate < 0.4) {
      alerts.push({
        level: 'warning',
        message: `Low win rate: ${(metrics.winRate * 100).toFixed(1)}%`,
        metric: 'win_rate',
        value: metrics.winRate,
        threshold: 0.4
      });
    }

    // Volatility alerts
    if (metrics.volatility > 0.3) { // 30% annualized volatility
      alerts.push({
        level: 'warning',
        message: `High volatility: ${(metrics.volatility * 100).toFixed(1)}%`,
        metric: 'volatility',
        value: metrics.volatility,
        threshold: 0.3
      });
    }

    return alerts;
  }

  // Generate performance report
  async generateReport(
    period: 'daily' | 'weekly' | 'monthly' = 'monthly',
    includeBenchmarks: string[] = ['BTC', 'ETH']
  ): Promise<PerformanceReport> {
    const metrics = await this.calculateMetrics(period);
    const alerts = this.getPerformanceAlerts(metrics);

    const report = {
      generatedAt: new Date().toISOString(),
      period,
      summary: {
        totalTrades: metrics.totalTrades,
        totalPnL: metrics.totalPnL,
        winRate: metrics.winRate,
        sharpeRatio: metrics.sharpeRatio,
        maxDrawdown: metrics.maxDrawdown
      },
      riskMetrics: {
        volatility: metrics.volatility,
        valueAtRisk: metrics.valueAtRisk,
        sortinoRatio: metrics.sortinoRatio,
        calmarRatio: metrics.calmarRatio
      },
      efficiencyMetrics: {
        profitFactor: metrics.profitFactor,
        averageWin: metrics.averageWin,
        averageLoss: metrics.averageLoss,
        averageTradeDuration: metrics.averageTradeDuration
      },
      alerts,
      attribution: await this.generateAttributionAnalysis(metrics, includeBenchmarks[0]),
      benchmarks: await Promise.all(
        includeBenchmarks.map(benchmark =>
          this.compareWithBenchmark(metrics, benchmark, period)
        )
      ),
      strategyBreakdown: metrics.byStrategy,
      assetBreakdown: metrics.byAsset,
      timeBreakdown: metrics.byTimeOfDay
    };

    const redis = await this.redis;
    // Cache report
    await redis.set(`performance_report:${period}`, report, 3600); // 1 hour TTL

    return report;
  }

  // Private helper methods
  private async initializeTradeHistory(): Promise<void> {
    const redis = await this.redis;
    try {
      // Load recent trades from Redis
      const recentTrades = await redis.lrange('trade_history', 0, 999);
      this.tradeHistory = recentTrades.map((trade: string) => JSON.parse(trade)).reverse();
    } catch (error) {
      logger.warn('Failed to load trade history from Redis', { error });
    }
  }

  private async getTradesInPeriod(startDate: number, endDate: number): Promise<TradeRecord[]> {
    return this.tradeHistory.filter(trade =>
      trade.exitTime >= startDate && trade.exitTime <= endDate
    );
  }

  private createEmptyMetrics(period: PerformancePeriod, timestamp: number): PerformanceMetrics {
    return {
      timestamp,
      period,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      totalPnL: 0,
      realizedPnL: 0,
      unrealizedPnL: 0,
      maxDrawdown: 0,
      currentDrawdown: 0,
      volatility: 0,
      sharpeRatio: 0,
      sortinoRatio: 0,
      calmarRatio: 0,
      valueAtRisk: 0,
      winRate: 0,
      profitFactor: 0,
      averageWin: 0,
      averageLoss: 0,
      largestWin: 0,
      largestLoss: 0,
      averageTradeDuration: 0,
      alpha: 0,
      beta: 0,
      informationRatio: 0,
      omegaRatio: 0,
      byStrategy: {},
      byAsset: {},
      byTimeOfDay: {}
    };
  }

  private calculateReturns(trades: TradeRecord[]): number[] {
    return trades.map(trade => trade.return);
  }

  private calculateCumulativeReturns(returns: number[]): number[] {
    const cumulative: number[] = [];
    let current = 1;

    for (const ret of returns) {
      current *= (1 + ret);
      cumulative.push(current - 1); // Convert to cumulative return
    }

    return cumulative;
  }

  private calculateVolatility(returns: number[]): number {
    if (returns.length < 2) return 0;

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((acc, ret) => acc + Math.pow(ret - mean, 2), 0) / returns.length;

    return Math.sqrt(variance * 252); // Annualized volatility (252 trading days)
  }

  private calculateMaxDrawdown(cumulativeReturns: number[]): number {
    let peak = -Infinity;
    let maxDrawdown = 0;

    for (const ret of cumulativeReturns) {
      if (ret > peak) {
        peak = ret;
      }

      const drawdown = peak - ret;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    return maxDrawdown;
  }

  private calculateCurrentDrawdown(cumulativeReturns: number[]): number {
    if (cumulativeReturns.length === 0) return 0;

    const peak = cumulativeReturns.reduce((a, b) => a > b ? a : b, cumulativeReturns[0]);
    const current = cumulativeReturns[cumulativeReturns.length - 1];

    return Math.max(0, peak - current);
  }

  private calculateSharpeRatio(returns: number[], volatility: number, riskFreeRate: number = 0.02): number {
    if (volatility === 0) return 0;

    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const annualizedReturn = avgReturn * 252; // Annualized

    return (annualizedReturn - riskFreeRate) / volatility;
  }

  private calculateSortinoRatio(returns: number[]): number {
    const negativeReturns = returns.filter(ret => ret < 0);
    if (negativeReturns.length === 0) return 0;

    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const downsideVolatility = Math.sqrt(
      negativeReturns.reduce((acc, ret) => acc + ret * ret, 0) / negativeReturns.length
    ) * Math.sqrt(252); // Annualized downside volatility

    return downsideVolatility > 0 ? avgReturn * 252 / downsideVolatility : 0;
  }

  private calculateVaR(returns: number[], confidence: number = 0.95): number {
    if (returns.length < 10) return 0;

    const sortedReturns = [...returns].sort((a, b) => a - b);
    const index = Math.floor((1 - confidence) * returns.length);

    return Math.abs(sortedReturns[index]); // VaR as positive value
  }

  /**
   * Calculate beta (systematic risk) against a market benchmark.
   *
   * @known-limitation Returns a deterministic default of 1.0 (market-neutral)
   * because real market benchmark data is not yet integrated. The Math.random()
   * simulation that was here before produced non-deterministic, meaningless results.
   * When real market data feeds are available, use calculateCovariance/calculateVariance
   * with actual benchmark returns to compute a proper beta.
   */
  private calculateBeta(_returns: number[]): number {
    return 1.0;
  }

  private calculateOmegaRatio(returns: number[]): number {
    if (returns.length === 0) return 0;

    const threshold = 0; // Minimum acceptable return
    const gains = returns.filter(ret => ret > threshold).reduce((sum, ret) => sum + ret, 0);
    const losses = Math.abs(returns.filter(ret => ret < threshold).reduce((sum, ret) => sum + ret, 0));

    return losses > 0 ? gains / losses : gains > 0 ? 999 : 0;
  }

  private calculateCovariance(series1: number[], series2: number[]): number {
    if (series1.length !== series2.length || series1.length === 0) return 0;

    const mean1 = series1.reduce((a, b) => a + b, 0) / series1.length;
    const mean2 = series2.reduce((a, b) => a + b, 0) / series2.length;

    let covariance = 0;
    for (let i = 0; i < series1.length; i++) {
      covariance += (series1[i] - mean1) * (series2[i] - mean2);
    }

    return covariance / series1.length;
  }

  private calculateVariance(values: number[]): number {
    if (values.length < 2) return 0;

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return values.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / values.length;
  }

  private calculateStrategyPerformance(trades: TradeRecord[]): { [strategy: string]: StrategyPerformance } {
    const strategyStats: { [strategy: string]: TradeRecord[] } = {};

    // Group trades by strategy
    for (const trade of trades) {
      if (!strategyStats[trade.strategy]) {
        strategyStats[trade.strategy] = [];
      }
      strategyStats[trade.strategy].push(trade);
    }

    const result: { [strategy: string]: StrategyPerformance } = {};
    const totalAbsPnL = trades.reduce((sum, t) => sum + Math.abs(t.netPnL), 0);

    for (const [strategy, strategyTrades] of Object.entries(strategyStats)) {
      const pnl = strategyTrades.reduce((sum, t) => sum + t.netPnL, 0);
      const winningTrades = strategyTrades.filter(t => t.netPnL > 0);
      const winRate = winningTrades.length / strategyTrades.length;

      // Calculate Sharpe ratio for strategy
      const returns = strategyTrades.map(t => t.return);
      const volatility = this.calculateVolatility(returns);
      const sharpeRatio = this.calculateSharpeRatio(returns, volatility);

      result[strategy] = {
        trades: strategyTrades.length,
        pnl,
        winRate,
        sharpeRatio,
        contribution: totalAbsPnL > 0 ? pnl / totalAbsPnL : 0
      };
    }

    return result;
  }

  private calculateAssetPerformance(trades: TradeRecord[]): { [asset: string]: AssetPerformance } {
    const assetStats: { [asset: string]: TradeRecord[] } = {};

    // Group trades by asset
    for (const trade of trades) {
      if (!assetStats[trade.asset]) {
        assetStats[trade.asset] = [];
      }
      assetStats[trade.asset].push(trade);
    }

    const result: { [asset: string]: AssetPerformance } = {};
    const totalAbsPnL = trades.reduce((sum, t) => sum + Math.abs(t.netPnL), 0);
    const totalPortfolioValue = trades.reduce((sum, t) => sum + Math.abs(t.quantity * t.entryPrice), 0);

    for (const [asset, assetTrades] of Object.entries(assetStats)) {
      const pnl = assetTrades.reduce((sum, t) => sum + t.netPnL, 0);

      // Calculate exposure (simplified)
      const assetValue = assetTrades.reduce((sum, t) => sum + Math.abs(t.quantity * t.entryPrice), 0);
      const exposure = totalPortfolioValue > 0 ? assetValue / totalPortfolioValue : 0;

      const returns = assetTrades.map(t => t.return);
      const volatility = this.calculateVolatility(returns);
      const sharpeRatio = this.calculateSharpeRatio(returns, volatility);

      result[asset] = {
        trades: assetTrades.length,
        pnl,
        exposure,
        sharpeRatio,
        contribution: totalAbsPnL > 0 ? pnl / totalAbsPnL : 0
      };
    }

    return result;
  }

  private calculateTimePerformance(trades: TradeRecord[]): { [hour: number]: TimePerformance } {
    const hourStats: { [hour: number]: TradeRecord[] } = {};

    // Group trades by hour of day
    for (const trade of trades) {
      const hour = new Date(trade.entryTime).getHours();
      if (!hourStats[hour]) {
        hourStats[hour] = [];
      }
      hourStats[hour].push(trade);
    }

    const result: { [hour: number]: TimePerformance } = {};

    for (const [hour, hourTrades] of Object.entries(hourStats)) {
      const pnl = hourTrades.reduce((sum, t) => sum + t.netPnL, 0);
      const winningTrades = hourTrades.filter(t => t.netPnL > 0);
      const winRate = winningTrades.length / hourTrades.length;
      const averageReturn = pnl / hourTrades.length;

      result[parseInt(hour)] = {
        trades: hourTrades.length,
        pnl,
        winRate,
        averageReturn
      };
    }

    return result;
  }

  private getPeriodStart(period: PerformancePeriod, endTime: number): number {
    const periods: Record<PerformancePeriod, number> = {
      daily: 24 * 60 * 60 * 1000,
      weekly: 7 * 24 * 60 * 60 * 1000,
      monthly: 30 * 24 * 60 * 60 * 1000,
      quarterly: 90 * 24 * 60 * 60 * 1000,
      yearly: 365 * 24 * 60 * 60 * 1000
    };

    return endTime - periods[period];
  }

  private async cacheMetrics(metrics: PerformanceMetrics, period: PerformancePeriod, startDate: number, endDate: number): Promise<void> {
    const redis = await this.redis;
    const key = `performance_metrics:${period}:${startDate}:${endDate}`;
    await redis.set(key, metrics, 3600); // 1 hour TTL
  }

  private async getBenchmarkReturn(benchmark: string, startDate: number, endDate: number): Promise<number> {
    // Simplified benchmark returns (would integrate with real market data)
    const benchmarkReturns: { [key: string]: number } = {
      'BTC': 0.05,    // 5% return
      'ETH': 0.08,    // 8% return
      'S&P 500': 0.03 // 3% return
    };

    // Scale by time period
    const days = (endDate - startDate) / (24 * 60 * 60 * 1000);
    const baseReturn = benchmarkReturns[benchmark] || 0.03;

    return baseReturn * (days / 365); // Annualized to period
  }

  private calculateTrackingError(metrics: PerformanceMetrics, benchmarkReturn: number): number {
    // Simplified tracking error calculation
    return Math.abs(metrics.totalPnL - benchmarkReturn) / Math.sqrt(metrics.totalTrades || 1);
  }
}