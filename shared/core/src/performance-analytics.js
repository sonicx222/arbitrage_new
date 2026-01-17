"use strict";
// Performance Analytics Engine
// Advanced performance tracking with risk-adjusted metrics and statistical analysis
Object.defineProperty(exports, "__esModule", { value: true });
exports.PerformanceAnalyticsEngine = void 0;
const logger_1 = require("./logger");
const redis_1 = require("./redis");
const logger = (0, logger_1.createLogger)('performance-analytics');
class PerformanceAnalyticsEngine {
    constructor() {
        this.redis = (0, redis_1.getRedisClient)();
        this.tradeHistory = [];
        this.maxHistorySize = 10000; // Keep last 10k trades
        this.initializeTradeHistory();
    }
    // Record a completed trade
    async recordTrade(trade) {
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
    async calculateMetrics(period = 'daily', startDate, endDate) {
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
        const metrics = {
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
    async compareWithBenchmark(strategyMetrics, benchmark, period = 'monthly') {
        const periodStart = this.getPeriodStart(period, strategyMetrics.timestamp);
        // Get benchmark returns (simplified - would integrate with real market data)
        const benchmarkReturn = await this.getBenchmarkReturn(benchmark, periodStart, strategyMetrics.timestamp);
        const comparison = {
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
    async generateAttributionAnalysis(metrics, benchmark) {
        // Simplified attribution analysis
        const benchmarkReturn = await this.getBenchmarkReturn(benchmark, this.getPeriodStart(metrics.period, metrics.timestamp), metrics.timestamp);
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
    getPerformanceAlerts(metrics) {
        const alerts = [];
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
    async generateReport(period = 'monthly', includeBenchmarks = ['BTC', 'ETH']) {
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
            benchmarks: await Promise.all(includeBenchmarks.map(benchmark => this.compareWithBenchmark(metrics, benchmark, period))),
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
    async initializeTradeHistory() {
        const redis = await this.redis;
        try {
            // Load recent trades from Redis
            const recentTrades = await redis.lrange('trade_history', 0, 999);
            this.tradeHistory = recentTrades.map((trade) => JSON.parse(trade)).reverse();
        }
        catch (error) {
            logger.warn('Failed to load trade history from Redis', { error });
        }
    }
    async getTradesInPeriod(startDate, endDate) {
        return this.tradeHistory.filter(trade => trade.exitTime >= startDate && trade.exitTime <= endDate);
    }
    createEmptyMetrics(period, timestamp) {
        return {
            timestamp,
            period: period,
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
    calculateReturns(trades) {
        return trades.map(trade => trade.return);
    }
    calculateCumulativeReturns(returns) {
        const cumulative = [];
        let current = 1;
        for (const ret of returns) {
            current *= (1 + ret);
            cumulative.push(current - 1); // Convert to cumulative return
        }
        return cumulative;
    }
    calculateVolatility(returns) {
        if (returns.length < 2)
            return 0;
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((acc, ret) => acc + Math.pow(ret - mean, 2), 0) / returns.length;
        return Math.sqrt(variance * 252); // Annualized volatility (252 trading days)
    }
    calculateMaxDrawdown(cumulativeReturns) {
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
    calculateCurrentDrawdown(cumulativeReturns) {
        if (cumulativeReturns.length === 0)
            return 0;
        const peak = Math.max(...cumulativeReturns);
        const current = cumulativeReturns[cumulativeReturns.length - 1];
        return Math.max(0, peak - current);
    }
    calculateSharpeRatio(returns, volatility, riskFreeRate = 0.02) {
        if (volatility === 0)
            return 0;
        const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
        const annualizedReturn = avgReturn * 252; // Annualized
        return (annualizedReturn - riskFreeRate) / volatility;
    }
    calculateSortinoRatio(returns) {
        const negativeReturns = returns.filter(ret => ret < 0);
        if (negativeReturns.length === 0)
            return 0;
        const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
        const downsideVolatility = Math.sqrt(negativeReturns.reduce((acc, ret) => acc + ret * ret, 0) / negativeReturns.length) * Math.sqrt(252); // Annualized downside volatility
        return downsideVolatility > 0 ? avgReturn * 252 / downsideVolatility : 0;
    }
    calculateVaR(returns, confidence = 0.95) {
        if (returns.length < 10)
            return 0;
        const sortedReturns = [...returns].sort((a, b) => a - b);
        const index = Math.floor((1 - confidence) * returns.length);
        return Math.abs(sortedReturns[index]); // VaR as positive value
    }
    calculateBeta(returns) {
        // Simplified beta calculation against a market proxy
        // In practice, this would use actual market returns
        const marketReturns = returns.map(() => Math.random() * 0.02 - 0.01); // Simulated market
        const covariance = this.calculateCovariance(returns, marketReturns);
        const marketVariance = this.calculateVariance(marketReturns);
        return marketVariance > 0 ? covariance / marketVariance : 1;
    }
    calculateOmegaRatio(returns) {
        if (returns.length === 0)
            return 0;
        const threshold = 0; // Minimum acceptable return
        const gains = returns.filter(ret => ret > threshold).reduce((sum, ret) => sum + ret, 0);
        const losses = Math.abs(returns.filter(ret => ret < threshold).reduce((sum, ret) => sum + ret, 0));
        return losses > 0 ? gains / losses : gains > 0 ? 999 : 0;
    }
    calculateCovariance(series1, series2) {
        if (series1.length !== series2.length || series1.length === 0)
            return 0;
        const mean1 = series1.reduce((a, b) => a + b, 0) / series1.length;
        const mean2 = series2.reduce((a, b) => a + b, 0) / series2.length;
        let covariance = 0;
        for (let i = 0; i < series1.length; i++) {
            covariance += (series1[i] - mean1) * (series2[i] - mean2);
        }
        return covariance / series1.length;
    }
    calculateVariance(values) {
        if (values.length < 2)
            return 0;
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        return values.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / values.length;
    }
    calculateStrategyPerformance(trades) {
        const strategyStats = {};
        // Group trades by strategy
        for (const trade of trades) {
            if (!strategyStats[trade.strategy]) {
                strategyStats[trade.strategy] = [];
            }
            strategyStats[trade.strategy].push(trade);
        }
        const result = {};
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
    calculateAssetPerformance(trades) {
        const assetStats = {};
        // Group trades by asset
        for (const trade of trades) {
            if (!assetStats[trade.asset]) {
                assetStats[trade.asset] = [];
            }
            assetStats[trade.asset].push(trade);
        }
        const result = {};
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
    calculateTimePerformance(trades) {
        const hourStats = {};
        // Group trades by hour of day
        for (const trade of trades) {
            const hour = new Date(trade.entryTime).getHours();
            if (!hourStats[hour]) {
                hourStats[hour] = [];
            }
            hourStats[hour].push(trade);
        }
        const result = {};
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
    getPeriodStart(period, endTime) {
        const periods = {
            daily: 24 * 60 * 60 * 1000,
            weekly: 7 * 24 * 60 * 60 * 1000,
            monthly: 30 * 24 * 60 * 60 * 1000,
            quarterly: 90 * 24 * 60 * 60 * 1000,
            yearly: 365 * 24 * 60 * 60 * 1000
        };
        return endTime - periods[period];
    }
    async cacheMetrics(metrics, period, startDate, endDate) {
        const redis = await this.redis;
        const key = `performance_metrics:${period}:${startDate}:${endDate}`;
        await redis.set(key, metrics, 3600); // 1 hour TTL
    }
    async getBenchmarkReturn(benchmark, startDate, endDate) {
        // Simplified benchmark returns (would integrate with real market data)
        const benchmarkReturns = {
            'BTC': 0.05, // 5% return
            'ETH': 0.08, // 8% return
            'S&P 500': 0.03 // 3% return
        };
        // Scale by time period
        const days = (endDate - startDate) / (24 * 60 * 60 * 1000);
        const baseReturn = benchmarkReturns[benchmark] || 0.03;
        return baseReturn * (days / 365); // Annualized to period
    }
    calculateTrackingError(metrics, benchmarkReturn) {
        // Simplified tracking error calculation
        return Math.abs(metrics.totalPnL - benchmarkReturn) / Math.sqrt(metrics.totalTrades || 1);
    }
}
exports.PerformanceAnalyticsEngine = PerformanceAnalyticsEngine;
//# sourceMappingURL=performance-analytics.js.map