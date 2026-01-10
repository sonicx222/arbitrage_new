// Comprehensive Risk Management System
// Implements portfolio management, drawdown protection, and position sizing for arbitrage trading

import { createLogger } from './logger';
import { getRedisClient } from './redis';

const logger = createLogger('risk-management');

export interface Position {
  id: string;
  pair: string;
  type: 'arbitrage' | 'hedge' | 'speculation';
  size: number; // Position size in base currency
  entryPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  timestamp: number;
  riskMetrics: PositionRisk;
}

export interface PositionRisk {
  volatility: number;
  liquidityRisk: number;
  counterpartyRisk: number;
  slippageRisk: number;
  gasRisk: number;
  impermanentLossRisk: number;
  totalRisk: number;
}

export interface PortfolioMetrics {
  totalValue: number;
  totalPnL: number;
  realizedPnL: number;
  unrealizedPnL: number;
  maxDrawdown: number;
  sharpeRatio: number;
  sortinoRatio: number;
  winRate: number;
  profitFactor: number;
  calmarRatio: number;
  currentDrawdown: number;
  dailyPnL: number[];
  weeklyPnL: number[];
  monthlyPnL: number[];
}

export interface RiskLimits {
  maxDrawdown: number; // Maximum allowed drawdown (e.g., 0.1 for 10%)
  maxPositionSize: number; // Maximum position size as % of portfolio
  maxDailyLoss: number; // Maximum daily loss
  maxConcentration: number; // Maximum concentration in single pair
  maxVolatility: number; // Maximum allowed volatility
  minLiquidity: number; // Minimum required liquidity
  maxLeverage: number; // Maximum leverage allowed
}

export interface RiskAlert {
  id: string;
  type: 'warning' | 'critical' | 'emergency';
  message: string;
  metric: string;
  value: number;
  threshold: number;
  timestamp: number;
  actions: string[];
}

export class RiskManagementEngine {
  private redis = getRedisClient();
  private positions = new Map<string, Position>();
  private portfolioMetrics: PortfolioMetrics;
  private riskLimits: RiskLimits;
  private alerts: RiskAlert[] = [];
  private dailyPnL: number[] = [];
  private isRiskManagementActive = true;

  constructor(riskLimits?: Partial<RiskLimits>) {
    this.portfolioMetrics = this.initializePortfolioMetrics();
    this.riskLimits = {
      maxDrawdown: 0.1, // 10% max drawdown
      maxPositionSize: 0.1, // 10% of portfolio per position
      maxDailyLoss: 0.05, // 5% max daily loss
      maxConcentration: 0.2, // 20% max concentration
      maxVolatility: 0.5, // 50% max volatility
      minLiquidity: 100000, // $100k minimum liquidity
      maxLeverage: 1.0, // No leverage by default
      ...riskLimits
    };
  }

  // Calculate optimal position size using Kelly Criterion
  calculateOptimalPositionSize(
    winProbability: number,
    winLossRatio: number,
    currentPortfolioValue: number
  ): number {
    // Kelly Criterion: f = (bp - q) / b
    // where: b = odds received, p = probability of win, q = probability of loss
    const b = winLossRatio;
    const p = winProbability;
    const q = 1 - p;

    const kellyFraction = (b * p - q) / b;

    // Conservative Kelly (half-Kelly for safety)
    const conservativeKelly = Math.max(0, kellyFraction * 0.5);

    // Apply risk limits
    const maxByDrawdown = this.calculateMaxSizeByDrawdown(currentPortfolioValue);
    const maxByConcentration = this.calculateMaxSizeByConcentration(currentPortfolioValue);

    const optimalSize = Math.min(
      currentPortfolioValue * conservativeKelly,
      maxByDrawdown,
      maxByConcentration
    );

    logger.debug('Calculated optimal position size', {
      winProbability,
      winLossRatio,
      kellyFraction: kellyFraction.toFixed(4),
      conservativeKelly: conservativeKelly.toFixed(4),
      optimalSize: optimalSize.toFixed(2),
      portfolioValue: currentPortfolioValue.toFixed(2)
    });

    return optimalSize;
  }

  // Calculate position size based on volatility-adjusted risk
  calculateVolatilityAdjustedPositionSize(
    volatility: number,
    stopLoss: number,
    portfolioValue: number,
    riskPerTrade: number = 0.01 // 1% risk per trade
  ): number {
    // Risk = Position Size * Volatility * Stop Loss
    // Position Size = Risk / (Volatility * Stop Loss)
    const riskAmount = portfolioValue * riskPerTrade;

    if (volatility <= 0 || stopLoss <= 0) {
      return 0;
    }

    const positionSize = riskAmount / (volatility * stopLoss);

    // Apply risk limits
    const maxSize = Math.min(
      portfolioValue * this.riskLimits.maxPositionSize,
      this.calculateMaxSizeByDrawdown(portfolioValue)
    );

    return Math.min(positionSize, maxSize);
  }

  // Add position to portfolio
  async addPosition(position: Omit<Position, 'unrealizedPnL' | 'riskMetrics'>): Promise<boolean> {
    // Risk checks before adding position
    if (!this.canAddPosition(position)) {
      logger.warn('Position rejected by risk management', {
        pair: position.pair,
        size: position.size,
        reason: 'Risk limits exceeded'
      });
      return false;
    }

    const fullPosition: Position = {
      ...position,
      unrealizedPnL: 0,
      riskMetrics: await this.calculatePositionRisk(position)
    };

    this.positions.set(position.id, fullPosition);
    await this.updatePortfolioMetrics();

    logger.info('Position added to portfolio', {
      id: position.id,
      pair: position.pair,
      size: position.size,
      type: position.type
    });

    return true;
  }

  // Update position with current market data
  async updatePosition(positionId: string, currentPrice: number): Promise<void> {
    const position = this.positions.get(positionId);
    if (!position) return;

    // Calculate unrealized P&L
    const priceChange = currentPrice - position.entryPrice;
    position.unrealizedPnL = priceChange * position.size;
    position.currentPrice = currentPrice;

    // Recalculate risk metrics
    position.riskMetrics = await this.calculatePositionRisk(position);

    // Check for risk limit breaches
    await this.checkPositionRiskLimits(position);

    // Update portfolio metrics
    await this.updatePortfolioMetrics();
  }

  // Close position and realize P&L
  async closePosition(positionId: string, exitPrice: number): Promise<number> {
    const position = this.positions.get(positionId);
    if (!position) return 0;

    // Calculate realized P&L
    const priceChange = exitPrice - position.entryPrice;
    const realizedPnL = priceChange * position.size;

    // Update portfolio metrics
    this.portfolioMetrics.realizedPnL += realizedPnL;
    this.portfolioMetrics.totalPnL = this.portfolioMetrics.realizedPnL + this.portfolioMetrics.unrealizedPnL;

    // Remove position
    this.positions.delete(positionId);

    // Update daily P&L tracking
    await this.updateDailyPnL(realizedPnL);

    logger.info('Position closed', {
      id: positionId,
      pair: position.pair,
      realizedPnL: realizedPnL.toFixed(2),
      exitPrice: exitPrice.toFixed(4)
    });

    return realizedPnL;
  }

  // Check if adding position would breach risk limits
  public async canAddPosition(newPosition: Omit<Position, 'unrealizedPnL' | 'riskMetrics'>): Promise<boolean> {
    // Check position size limit
    const positionSizePercent = newPosition.size / this.portfolioMetrics.totalValue;
    if (positionSizePercent > this.riskLimits.maxPositionSize) {
      return false;
    }

    // Check concentration limit
    const pairPositions = Array.from(this.positions.values())
      .filter(p => p.pair === newPosition.pair);
    const pairTotalSize = pairPositions.reduce((sum, p) => sum + p.size, 0) + newPosition.size;
    const pairConcentration = pairTotalSize / this.portfolioMetrics.totalValue;

    if (pairConcentration > this.riskLimits.maxConcentration) {
      return false;
    }

    // Check drawdown limit
    if (this.portfolioMetrics.currentDrawdown > this.riskLimits.maxDrawdown) {
      return false;
    }

    // Check daily loss limit
    const todayPnL = this.dailyPnL.reduce((sum, pnl) => sum + pnl, 0);
    if (todayPnL < -this.portfolioMetrics.totalValue * this.riskLimits.maxDailyLoss) {
      return false;
    }

    return true;
  }

  // Calculate comprehensive risk metrics for a position
  public async calculatePositionRisk(position: Omit<Position, 'unrealizedPnL' | 'riskMetrics'>): Promise<PositionRisk> {
    const risk: PositionRisk = {
      volatility: 0,
      liquidityRisk: 0,
      counterpartyRisk: 0,
      slippageRisk: 0,
      gasRisk: 0,
      impermanentLossRisk: 0,
      totalRisk: 0
    };

    // Calculate volatility risk
    risk.volatility = await this.calculateVolatilityRisk(position.pair);

    // Calculate liquidity risk
    risk.liquidityRisk = await this.calculateLiquidityRisk(position.pair, position.size);

    // Calculate slippage risk
    risk.slippageRisk = await this.calculateSlippageRisk(position.pair, position.size);

    // Calculate gas risk (for blockchain transactions)
    risk.gasRisk = await this.calculateGasRisk(position.pair);

    // Calculate impermanent loss risk (for LP positions)
    if (position.type === 'hedge') {
      risk.impermanentLossRisk = await this.calculateImpermanentLossRisk(position.pair);
    }

    // Calculate counterparty risk
    risk.counterpartyRisk = this.calculateCounterpartyRisk(position);

    // Calculate total risk as weighted sum
    risk.totalRisk = (
      risk.volatility * 0.3 +
      risk.liquidityRisk * 0.2 +
      risk.slippageRisk * 0.2 +
      risk.gasRisk * 0.15 +
      risk.impermanentLossRisk * 0.1 +
      risk.counterpartyRisk * 0.05
    );

    return risk;
  }

  // Calculate volatility risk for a pair
  private async calculateVolatilityRisk(pair: string): Promise<number> {
    const redis = await this.redis;
    // Get recent price data from cache
    const priceData = await redis.get<number[]>(`price_history:${pair}`);
    if (!priceData) return 0.5; // Default medium risk

    const prices = Array.isArray(priceData) ? priceData : [];
    if (prices.length < 10) return 0.5;

    // Calculate price volatility (standard deviation of returns)
    const returns = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
    }

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((acc, ret) => acc + Math.pow(ret - mean, 2), 0) / returns.length;
    const volatility = Math.sqrt(variance);

    // Normalize to 0-1 scale (assuming 10% daily volatility is max)
    return Math.min(1, volatility / 0.1);
  }

  // Calculate liquidity risk
  private async calculateLiquidityRisk(pair: string, positionSize: number): Promise<number> {
    const redis = await this.redis;
    // Get liquidity data
    const liquidityData = await redis.get(`liquidity:${pair}`);
    if (!liquidityData || typeof liquidityData !== 'object') return 1.0; // High risk if no data

    const { poolSize, dailyVolume } = liquidityData as any;

    // Risk increases if position size is large relative to liquidity
    const sizeToLiquidityRatio = positionSize / (poolSize || 1);
    const sizeToVolumeRatio = positionSize / (dailyVolume || 1);

    // Combine ratios with higher weight on volume
    const liquidityRisk = Math.min(1, (sizeToLiquidityRatio * 0.3 + sizeToVolumeRatio * 0.7));

    return liquidityRisk;
  }

  // Calculate slippage risk
  private async calculateSlippageRisk(pair: string, positionSize: number): Promise<number> {
    // Estimate slippage based on position size and liquidity
    const liquidityRisk = await this.calculateLiquidityRisk(pair, positionSize);

    // Higher liquidity risk = higher slippage risk
    return Math.min(1, liquidityRisk * 1.2);
  }

  // Calculate gas risk for blockchain operations
  private async calculateGasRisk(pair: string): Promise<number> {
    // Extract chain from pair (assuming format like "ETH/USDT:bsc")
    const chain = pair.split(':').pop() || 'ethereum';

    const redis = await this.redis;
    // Get gas price data
    const gasData = await redis.get(`gas:${chain}`);
    if (!gasData || typeof gasData !== 'object') return 0.5;

    const { gasPrice, gasLimit } = gasData as any;
    const estimatedGasCost = (gasPrice || 20000000000) * (gasLimit || 150000); // 20 gwei * 150k gas

    // Risk based on gas cost relative to typical arbitrage profit
    const typicalProfit = 100; // $100 typical arbitrage profit
    const gasCostUSD = estimatedGasCost * 0.000000001 * 2000; // Rough ETH to USD conversion

    return Math.min(1, gasCostUSD / typicalProfit);
  }

  // Calculate impermanent loss risk for LP positions
  private async calculateImpermanentLossRisk(pair: string): Promise<number> {
    const redis = await this.redis;
    // Get price correlation data
    const correlationData = await redis.get(`correlation:${pair}`);
    if (!correlationData || typeof correlationData !== 'number') return 0.3; // Medium risk default

    const correlation = correlationData as number;

    // Lower correlation = higher IL risk
    return Math.max(0, Math.min(1, (1 - Math.abs(correlation)) * 0.8));
  }

  // Calculate counterparty risk
  private calculateCounterpartyRisk(position: Omit<Position, 'unrealizedPnL' | 'riskMetrics'>): number {
    // Risk based on DEX/protocol used
    const dexRisk: { [key: string]: number } = {
      'uniswap_v3': 0.1, // Very low risk
      'pancakeswap': 0.2,
      'sushiswap': 0.3,
      'curve': 0.15,
      '1inch': 0.25,
      'unknown': 0.8 // High risk for unknown DEXes
    };

    // Extract DEX from pair (simplified logic)
    const dex = position.pair.split('_')[0] || 'unknown';
    return dexRisk[dex] || dexRisk.unknown;
  }

  // Check position-specific risk limits
  private async checkPositionRiskLimits(position: Position): Promise<void> {
    const risk = position.riskMetrics;

    // Check volatility limit
    if (risk.volatility > this.riskLimits.maxVolatility) {
      await this.createRiskAlert(
        'high_volatility',
        `High volatility risk for ${position.pair}`,
        'volatility',
        risk.volatility,
        this.riskLimits.maxVolatility,
        ['reduce_position', 'monitor_closely']
      );
    }

    // Check total risk limit
    if (risk.totalRisk > 0.8) { // 80% risk threshold
      await this.createRiskAlert(
        'high_total_risk',
        `High total risk for position ${position.id}`,
        'total_risk',
        risk.totalRisk,
        0.8,
        ['close_position', 'hedge_position']
      );
    }
  }

  // Update portfolio metrics
  private async updatePortfolioMetrics(): Promise<void> {
    const positions = Array.from(this.positions.values());

    // Calculate total value and P&L
    this.portfolioMetrics.totalValue = positions.reduce((sum, pos) =>
      sum + (pos.currentPrice * pos.size), 0);

    this.portfolioMetrics.unrealizedPnL = positions.reduce((sum, pos) =>
      sum + pos.unrealizedPnL, 0);

    this.portfolioMetrics.totalPnL = this.portfolioMetrics.realizedPnL + this.portfolioMetrics.unrealizedPnL;

    // Calculate drawdown
    await this.calculateDrawdown();

    // Calculate risk-adjusted metrics
    this.calculateRiskAdjustedMetrics();

    const redis = await this.redis;
    // Store in Redis for monitoring
    await redis.set('portfolio:metrics', this.portfolioMetrics, 60); // 1 minute TTL
  }

  // Calculate drawdown metrics
  private async calculateDrawdown(): Promise<void> {
    const redis = await this.redis;
    // Get historical portfolio values (simplified)
    const historicalValues = await redis.get<number[]>('portfolio:history') || [];
    const currentValue = this.portfolioMetrics.totalValue;

    if (Array.isArray(historicalValues) && historicalValues.length > 0) {
      const peakValue = Math.max(...historicalValues, currentValue);
      this.portfolioMetrics.currentDrawdown = (peakValue - currentValue) / peakValue;
      this.portfolioMetrics.maxDrawdown = Math.max(
        this.portfolioMetrics.maxDrawdown,
        this.portfolioMetrics.currentDrawdown
      );
    }
  }

  // Calculate risk-adjusted performance metrics
  private calculateRiskAdjustedMetrics(): void {
    const dailyReturns = this.dailyPnL.map(pnl => pnl / this.portfolioMetrics.totalValue);

    if (dailyReturns.length > 0) {
      // Sharpe Ratio (assuming 0% risk-free rate)
      const avgReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
      const volatility = Math.sqrt(
        dailyReturns.reduce((acc, ret) => acc + Math.pow(ret - avgReturn, 2), 0) / dailyReturns.length
      );

      this.portfolioMetrics.sharpeRatio = volatility > 0 ? avgReturn / volatility : 0;

      // Sortino Ratio (downside deviation only)
      const negativeReturns = dailyReturns.filter(ret => ret < 0);
      const downsideVolatility = negativeReturns.length > 0 ?
        Math.sqrt(negativeReturns.reduce((acc, ret) => acc + ret * ret, 0) / negativeReturns.length) : 0;

      this.portfolioMetrics.sortinoRatio = downsideVolatility > 0 ? avgReturn / downsideVolatility : 0;

      // Calmar Ratio
      this.portfolioMetrics.calmarRatio = this.portfolioMetrics.maxDrawdown > 0 ?
        avgReturn / this.portfolioMetrics.maxDrawdown : 0;
    }

    // Win rate and profit factor
    const winningTrades = this.dailyPnL.filter(pnl => pnl > 0).length;
    this.portfolioMetrics.winRate = this.dailyPnL.length > 0 ? winningTrades / this.dailyPnL.length : 0;

    const totalWins = this.dailyPnL.filter(pnl => pnl > 0).reduce((a, b) => a + b, 0);
    const totalLosses = Math.abs(this.dailyPnL.filter(pnl => pnl < 0).reduce((a, b) => a + b, 0));

    this.portfolioMetrics.profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? 999 : 0;
  }

  // Update daily P&L tracking
  private async updateDailyPnL(pnl: number): Promise<void> {
    this.dailyPnL.push(pnl);

    // Keep only last 30 days
    if (this.dailyPnL.length > 30) {
      this.dailyPnL = this.dailyPnL.slice(-30);
    }

    const redis = await this.redis;
    await redis.set('portfolio:daily_pnl', this.dailyPnL, 86400); // 24 hours TTL
  }

  // Create risk alert
  private async createRiskAlert(
    alertType: string,
    message: string,
    metric: string,
    value: number,
    threshold: number,
    actions: string[]
  ): Promise<void> {
    const alert: RiskAlert = {
      id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: value > threshold * 1.5 ? 'emergency' : 'warning',
      message,
      metric,
      value,
      threshold,
      timestamp: Date.now(),
      actions
    };

    this.alerts.push(alert);

    // Keep only recent alerts
    if (this.alerts.length > 100) {
      this.alerts = this.alerts.slice(-100);
    }

    const redis = await this.redis;
    // Publish alert
    await redis.publish('risk:alerts', {
      type: 'risk_alert',
      data: alert,
      timestamp: Date.now(),
      source: 'risk-management'
    });

    logger.warn('Risk alert created', {
      type: alert.type,
      message: alert.message,
      metric: alert.metric,
      value: value.toFixed(4),
      threshold: threshold.toFixed(4)
    });
  }

  // Get current portfolio metrics
  getPortfolioMetrics(): PortfolioMetrics {
    return { ...this.portfolioMetrics };
  }

  // Get active alerts
  getActiveAlerts(): RiskAlert[] {
    const oneHourAgo = Date.now() - 3600000;
    return this.alerts.filter(alert => alert.timestamp > oneHourAgo);
  }

  // Calculate maximum position size by drawdown limit
  private calculateMaxSizeByDrawdown(portfolioValue: number): number {
    const remainingDrawdownCapacity = this.riskLimits.maxDrawdown - this.portfolioMetrics.currentDrawdown;
    return Math.max(0, portfolioValue * remainingDrawdownCapacity);
  }

  // Calculate maximum position size by concentration limit
  private calculateMaxSizeByConcentration(portfolioValue: number): number {
    // Simplified: assume we can use the full concentration limit
    return portfolioValue * this.riskLimits.maxConcentration;
  }

  // Initialize portfolio metrics
  private initializePortfolioMetrics(): PortfolioMetrics {
    return {
      totalValue: 10000, // Starting with $10k
      totalPnL: 0,
      realizedPnL: 0,
      unrealizedPnL: 0,
      maxDrawdown: 0,
      sharpeRatio: 0,
      sortinoRatio: 0,
      winRate: 0,
      profitFactor: 0,
      calmarRatio: 0,
      currentDrawdown: 0,
      dailyPnL: [],
      weeklyPnL: [],
      monthlyPnL: []
    };
  }

  // Emergency stop - close all positions
  async emergencyStop(): Promise<void> {
    logger.warn('Emergency stop triggered - closing all positions');

    const positionIds = Array.from(this.positions.keys());
    for (const positionId of positionIds) {
      const position = this.positions.get(positionId);
      if (position) {
        await this.closePosition(positionId, position.currentPrice);
      }
    }

    this.isRiskManagementActive = false;

    await this.createRiskAlert(
      'emergency_stop',
      'Emergency stop activated - all positions closed',
      'emergency_stop',
      1,
      0,
      ['manual_review_required']
    );
  }

  // Resume risk management
  resume(): void {
    this.isRiskManagementActive = true;
    logger.info('Risk management resumed');
  }
}