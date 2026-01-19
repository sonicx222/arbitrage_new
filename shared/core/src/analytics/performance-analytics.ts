// Performance Analytics Engine
// Advanced performance tracking with risk-adjusted metrics and statistical analysis

import { createLogger } from './logger';
import { getRedisClient } from './redis';

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

export class PerformanceAnalyticsEngine {
  private redis = getRedisClient();
  private tradeHistory: any[] = [];
  private maxHistorySize = 10000; // Keep last 10k trades

  constructor() {
    this.initializeTradeHistory();
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
    const now = Date.now();
    const periodStart = startDate || this.getPeriodStart(period, now);
    const periodEnd = endDate || now;

    // Get trades for the period
    const trades = await this.getTradesInPeriod(periodStart, periodEnd);

    if (trades.length === 0) {
      return this.createEmptyMetrics(period, periodStart);
    }

    // Calculate basic metrics
    const winningTrades = trades.filter(t => t.netPnL > 0);
    const losingTrades = trades.filter(t => t.netPnL < 0);

    const totalPnL = trades.reduce((sum, t) => sum + t.netPnL, 0);
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
    const winRate = winningTrades.length / trades.length;
    const totalWins = winningTrades.reduce((sum, t) => sum + t.netPnL, 0);
    const totalLosses = Math.abs(losingTrades.reduce((sum, t) => sum + t.netPnL, 0));
    const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? 999 : 0;

    const averageWin = winningTrades.length > 0 ? totalWins / winningTrades.length : 0;
    const averageLoss = losingTrades.length > 0 ? totalLosses / losingTrades.length : 0;
    const largestWin = winningTrades.length > 0 ? Math.max(...winningTrades.map(t => t.netPnL)) : 0;
    const largestLoss = losingTrades.length > 0 ? Math.min(...losingTrades.map(t => t.netPnL)) : 0;

    const totalDuration = trades.reduce((sum, t) => sum + t.duration, 0);
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
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
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
  ): Promise<any> {
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

  private async getTradesInPeriod(startDate: number, endDate: number): Promise<any[]> {
    return this.tradeHistory.filter(trade =>
      trade.exitTime >= startDate && trade.exitTime <= endDate
    );
  }

  private createEmptyMetrics(period: string, timestamp: number): PerformanceMetrics {
    return {
      timestamp,
      period: period as any,
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

  private calculateReturns(trades: any[]): number[] {
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

    const peak = Math.max(...cumulativeReturns);
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

  private calculateBeta(returns: number[]): number {
    // Simplified beta calculation against a market proxy
    // In practice, this would use actual market returns
    const marketReturns = returns.map(() => Math.random() * 0.02 - 0.01); // Simulated market

    const covariance = this.calculateCovariance(returns, marketReturns);
    const marketVariance = this.calculateVariance(marketReturns);

    return marketVariance > 0 ? covariance / marketVariance : 1;
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

  private calculateStrategyPerformance(trades: any[]): { [strategy: string]: StrategyPerformance } {
    const strategyStats: { [strategy: string]: any[] } = {};

    // Group trades by strategy
    for (const trade of trades) {
      if (!strategyStats[trade.strategy]) {
        strategyStats[trade.strategy] = [];
      }
      strategyStats[trade.strategy].push(trade);
    }

    const result: { [strategy: string]: StrategyPerformance } = {};

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
        contribution: pnl / Math.abs(trades.reduce((sum, t) => sum + Math.abs(t.netPnL), 0)) || 1
      };
    }

    return result;
  }

  private calculateAssetPerformance(trades: any[]): { [asset: string]: AssetPerformance } {
    const assetStats: { [asset: string]: any[] } = {};

    // Group trades by asset
    for (const trade of trades) {
      if (!assetStats[trade.asset]) {
        assetStats[trade.asset] = [];
      }
      assetStats[trade.asset].push(trade);
    }

    const result: { [asset: string]: AssetPerformance } = {};

    for (const [asset, assetTrades] of Object.entries(assetStats)) {
      const pnl = assetTrades.reduce((sum, t) => sum + t.netPnL, 0);

      // Calculate exposure (simplified)
      const totalPortfolioValue = trades.reduce((sum, t) => sum + Math.abs(t.quantity * t.entryPrice), 0);
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
        contribution: pnl / Math.abs(trades.reduce((sum, t) => sum + Math.abs(t.netPnL), 0)) || 1
      };
    }

    return result;
  }

  private calculateTimePerformance(trades: any[]): { [hour: number]: TimePerformance } {
    const hourStats: { [hour: number]: any[] } = {};

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

  private getPeriodStart(period: string, endTime: number): number {
    const periods = {
      daily: 24 * 60 * 60 * 1000,
      weekly: 7 * 24 * 60 * 60 * 1000,
      monthly: 30 * 24 * 60 * 60 * 1000,
      quarterly: 90 * 24 * 60 * 60 * 1000,
      yearly: 365 * 24 * 60 * 60 * 1000
    };

    return endTime - periods[period as keyof typeof periods];
  }

  private async cacheMetrics(metrics: PerformanceMetrics, period: string, startDate: number, endDate: number): Promise<void> {
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