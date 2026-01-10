// Advanced Arbitrage Orchestrator
// Unifies all arbitrage strategies into a single, optimized execution engine

import { createLogger } from './logger';
import { getRedisClient } from './redis';
import { AdvancedStatisticalArbitrage, StatisticalSignal } from './advanced-statistical-arbitrage';
import { RiskManagementEngine, Position } from './risk-management';
import { CrossDexTriangularArbitrage, TriangularOpportunity } from './cross-dex-triangular-arbitrage';
import { getExpertSelfHealingManager } from './expert-self-healing-manager';

const logger = createLogger('advanced-arbitrage-orchestrator');

export interface ArbitrageExecution {
  id: string;
  strategy: 'statistical' | 'triangular' | 'cross_chain';
  opportunities: Array<StatisticalSignal | TriangularOpportunity>;
  riskAssessment: any;
  executionPlan: ExecutionStep[];
  status: 'pending' | 'executing' | 'completed' | 'failed';
  startTime?: number;
  endTime?: number;
  profit?: number;
  gasCost?: number;
  netProfit?: number;
}

export interface ExecutionStep {
  type: 'swap' | 'bridge' | 'flash_loan' | 'repay';
  dex?: string;
  tokenIn: string;
  tokenOut: string;
  amount: string;
  expectedOut: string;
  slippage: number;
  gasEstimate: number;
}

export class AdvancedArbitrageOrchestrator {
  private redis = getRedisClient();
  private statisticalArb = new AdvancedStatisticalArbitrage();
  private riskManager = new RiskManagementEngine();
  private triangularArb = new CrossDexTriangularArbitrage();
  private selfHealing = getExpertSelfHealingManager();

  private activeExecutions = new Map<string, ArbitrageExecution>();
  private isRunning = false;

  constructor() {
    this.initializeOrchestrator();
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    logger.info('Starting Advanced Arbitrage Orchestrator');

    this.redis = await getRedisClient();
    await this.selfHealing; // Ensure self-healing is initialized

    this.isRunning = true;

    // Subscribe to market data and opportunities
    await this.subscribeToMarketData();
    await this.subscribeToArbitrageSignals();

    logger.info('Advanced Arbitrage Orchestrator started successfully');
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    logger.info('Stopping Advanced Arbitrage Orchestrator');

    this.isRunning = false;

    // Cancel all active executions
    for (const [executionId, execution] of this.activeExecutions) {
      if (execution.status === 'executing') {
        await this.cancelExecution(executionId, 'System shutdown');
      }
    }

    this.activeExecutions.clear();

    logger.info('Advanced Arbitrage Orchestrator stopped');
  }

  // Analyze market conditions and generate arbitrage opportunities
  async analyzeMarketConditions(chain: string): Promise<{
    statisticalSignals: StatisticalSignal[];
    triangularOpportunities: TriangularOpportunity[];
    marketRegime: string;
    riskAssessment: any;
  }> {
    try {
      logger.debug(`Analyzing market conditions for ${chain}`);

      // Get market data
      const marketData = await this.getMarketData(chain);

      // Generate statistical signals
      const statisticalSignals: StatisticalSignal[] = [];
      for (const pair of marketData.pairs) {
        const signal = await this.statisticalArb.generateSignal(
          pair.key,
          pair.currentPrice,
          pair.priceHistory,
          pair.volumeHistory
        );

        if (signal.confidence > 0.7) { // High confidence only
          statisticalSignals.push(signal);
        }
      }

      // Find triangular opportunities
      const triangularOpportunities = await this.triangularArb.findTriangularOpportunities(
        chain,
        marketData.pools
      );

      // Assess risk
      const riskAssessment = await this.assessArbitrageRisk(
        statisticalSignals,
        triangularOpportunities
      );

      // Determine market regime
      const marketRegime = this.determineMarketRegime(statisticalSignals);

      return {
        statisticalSignals,
        triangularOpportunities,
        marketRegime,
        riskAssessment
      };

    } catch (error) {
      logger.error('Market analysis failed', { chain, error });
      await this.selfHealing.reportFailure('arbitrage-orchestrator', 'market_analysis', error as Error);
      throw error;
    }
  }

  // Execute arbitrage opportunities
  async executeArbitrageOpportunity(
    opportunity: StatisticalSignal | TriangularOpportunity,
    strategy: 'statistical' | 'triangular'
  ): Promise<ArbitrageExecution> {
    const executionId = `arb_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      logger.info('Starting arbitrage execution', { executionId, strategy });

      // Create execution plan
      const executionPlan = await this.createExecutionPlan(opportunity, strategy);

      // Assess risk
      const riskAssessment = await this.riskManager.calculatePositionRisk({
        id: executionId,
        pair: 'arbitrage_position',
        type: 'arbitrage',
        size: 1,
        entryPrice: 1,
        currentPrice: 1,
        unrealizedPnL: 0,
        timestamp: Date.now(),
        riskMetrics: {
          volatility: 0.1,
          liquidityRisk: 0.05,
          counterpartyRisk: 0.02,
          slippageRisk: 0.03,
          gasRisk: 0.02,
          impermanentLossRisk: 0,
          totalRisk: 0.22
        }
      });

      const execution: ArbitrageExecution = {
        id: executionId,
        strategy,
        opportunities: [opportunity],
        riskAssessment,
        executionPlan,
        status: 'pending'
      };

      this.activeExecutions.set(executionId, execution);

      // Validate execution
      const validation = await this.validateExecution(execution);
      if (!validation.valid) {
        throw new Error(`Execution validation failed: ${validation.reason}`);
      }

      // Execute
      execution.status = 'executing';
      execution.startTime = Date.now();

      const result = await this.performExecution(execution);

      execution.status = 'completed';
      execution.endTime = Date.now();
      execution.profit = result.profit;
      execution.gasCost = result.gasCost;
      execution.netProfit = result.netProfit;

      logger.info('Arbitrage execution completed', {
        executionId,
        netProfit: execution.netProfit,
        duration: execution.endTime - execution.startTime!
      });

      return execution;

    } catch (error) {
      logger.error('Arbitrage execution failed', { executionId, error });

      const execution = this.activeExecutions.get(executionId);
      if (execution) {
        execution.status = 'failed';
        execution.endTime = Date.now();
      }

      await this.selfHealing.reportFailure(
        'arbitrage-orchestrator',
        'execution',
        error as Error,
        { executionId, strategy }
      );

      throw error;
    } finally {
      // Clean up
      this.activeExecutions.delete(executionId);
    }
  }

  // Batch execute multiple opportunities
  async executeBatchArbitrage(
    opportunities: Array<{opportunity: StatisticalSignal | TriangularOpportunity, strategy: 'statistical' | 'triangular'}>
  ): Promise<ArbitrageExecution[]> {
    const executions: ArbitrageExecution[] = [];

    // Execute in parallel with concurrency control
    const concurrencyLimit = 3;
    const batches = this.chunkArray(opportunities, concurrencyLimit);

    for (const batch of batches) {
      const batchPromises = batch.map(({opportunity, strategy}) =>
        this.executeArbitrageOpportunity(opportunity, strategy)
      );

      const batchResults = await Promise.allSettled(batchPromises);

      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          executions.push(result.value);
        } else {
          logger.error('Batch execution failed', { error: result.reason });
        }
      }
    }

    return executions;
  }

  // Get execution statistics
  getExecutionStats(timeframe: number = 3600000): {
    totalExecutions: number;
    successfulExecutions: number;
    failedExecutions: number;
    totalProfit: number;
    averageProfit: number;
    winRate: number;
    averageExecutionTime: number;
  } {
    const cutoff = Date.now() - timeframe;
    const recentExecutions = Array.from(this.activeExecutions.values())
      .concat([]) // Would load from storage in production
      .filter(exec => exec.endTime && exec.endTime > cutoff);

    const completed = recentExecutions.filter(exec => exec.status === 'completed');
    const successful = completed.filter(exec => (exec.netProfit || 0) > 0);

    const totalProfit = completed.reduce((sum, exec) => sum + (exec.netProfit || 0), 0);
    const totalExecutionTime = completed.reduce((sum, exec) =>
      sum + ((exec.endTime || 0) - (exec.startTime || 0)), 0);

    return {
      totalExecutions: completed.length,
      successfulExecutions: successful.length,
      failedExecutions: recentExecutions.filter(exec => exec.status === 'failed').length,
      totalProfit,
      averageProfit: completed.length > 0 ? totalProfit / completed.length : 0,
      winRate: completed.length > 0 ? successful.length / completed.length : 0,
      averageExecutionTime: completed.length > 0 ? totalExecutionTime / completed.length : 0
    };
  }

  // Private methods
  private async initializeOrchestrator(): Promise<void> {
    // Initialize components
    await this.triangularArb.updateConfig({
      minProfitThreshold: 0.003, // 0.3% minimum
      maxSlippage: 0.015, // 1.5% max slippage
      maxExecutionTime: 4000 // 4 seconds max
    });
  }

  private async subscribeToMarketData(): Promise<void> {
    // Subscribe to price updates from detectors
    await this.redis.subscribe('price-updates', (message) => {
      this.handlePriceUpdate(message);
    });

    // Subscribe to arbitrage opportunities
    await this.redis.subscribe('arbitrage-opportunities', (message) => {
      this.handleArbitrageOpportunity(message);
    });
  }

  private async subscribeToArbitrageSignals(): Promise<void> {
    // Subscribe to statistical signals
    await this.redis.subscribe('statistical-signals', (message) => {
      this.handleStatisticalSignal(message);
    });

    // Subscribe to triangular opportunities
    await this.redis.subscribe('triangular-opportunities', (message) => {
      this.handleTriangularOpportunity(message);
    });
  }

  private async getMarketData(chain: string): Promise<{
    pairs: Array<{
      key: string;
      currentPrice: number;
      priceHistory: number[];
      volumeHistory?: number[];
    }>;
    pools: any[];
  }> {
    // Get recent price data from Redis
    const priceData = await this.redis.get(`market_data:${chain}`) || {};

    const pairs = Object.entries(priceData).map(([key, data]: [string, any]) => ({
      key,
      currentPrice: data.currentPrice || 0,
      priceHistory: data.priceHistory || [],
      volumeHistory: data.volumeHistory
    }));

    // Get pool data
    const pools = await this.redis.get(`pools:${chain}`) || [];

    return { pairs, pools };
  }

  private async assessArbitrageRisk(
    statisticalSignals: StatisticalSignal[],
    triangularOpportunities: TriangularOpportunity[]
  ): Promise<any> {
    // Assess combined risk of all opportunities
    const totalValue = statisticalSignals.length + triangularOpportunities.length;
    const highRiskCount = [
      ...statisticalSignals.filter(s => s.confidence < 0.6),
      ...triangularOpportunities.filter(t => t.confidence < 0.6)
    ].length;

    return {
      totalOpportunities: totalValue,
      highRiskOpportunities: highRiskCount,
      riskLevel: highRiskCount > totalValue * 0.3 ? 'high' : 'medium',
      recommendedPositionSize: Math.max(0.1, 1 - (highRiskCount / totalValue))
    };
  }

  private determineMarketRegime(signals: StatisticalSignal[]): string {
    if (signals.length === 0) return 'unknown';

    const regimes = signals.map(s => s.regime);
    const regimeCounts = regimes.reduce((acc, regime) => {
      acc[regime] = (acc[regime] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const dominantRegime = Object.entries(regimeCounts)
      .sort(([,a], [,b]) => b - a)[0][0];

    return dominantRegime;
  }

  private async createExecutionPlan(
    opportunity: StatisticalSignal | TriangularOpportunity,
    strategy: string
  ): Promise<ExecutionStep[]> {
    if (strategy === 'statistical') {
      // Create plan for statistical arbitrage
      const signal = opportunity as StatisticalSignal;
      return [{
        type: 'swap',
        dex: 'optimal',
        tokenIn: signal.pair.split('/')[0],
        tokenOut: signal.pair.split('/')[1],
        amount: '1000000000000000000', // 1 ETH
        expectedOut: '1000000000000000000',
        slippage: 0.005,
        gasEstimate: 150000
      }];
    } else {
      // Create plan for triangular arbitrage
      const triangular = opportunity as TriangularOpportunity;
      return triangular.steps.map(step => ({
        type: 'swap',
        dex: step.dex,
        tokenIn: step.fromToken,
        tokenOut: step.toToken,
        amount: step.amountIn.toString(),
        expectedOut: step.amountOut.toString(),
        slippage: step.slippage,
        gasEstimate: 100000
      }));
    }
  }

  private async validateExecution(execution: ArbitrageExecution): Promise<{
    valid: boolean;
    reason?: string;
  }> {
    // Check if we can add position to risk manager
    const canAdd = await this.riskManager.canAddPosition({
      id: execution.id,
      pair: 'arbitrage_bundle',
      type: 'arbitrage',
      size: 1,
      entryPrice: 1,
      currentPrice: 1,
      timestamp: Date.now()
    });

    if (!canAdd) {
      return { valid: false, reason: 'Risk limits exceeded' };
    }

    // Check execution plan validity
    for (const step of execution.executionPlan) {
      if (step.slippage > 0.02) { // 2% max slippage
        return { valid: false, reason: `Excessive slippage in step: ${step.slippage}` };
      }
    }

    return { valid: true };
  }

  private async performExecution(execution: ArbitrageExecution): Promise<{
    profit: number;
    gasCost: number;
    netProfit: number;
  }> {
    // Simulate execution (would integrate with actual DEX contracts)
    const gasCost = execution.executionPlan.reduce((sum, step) => sum + step.gasEstimate, 0) * 0.00000002; // Rough gas cost
    const grossProfit = Math.random() * 0.01; // Simulated profit
    const netProfit = grossProfit - gasCost;

    // Record in risk manager
    await this.riskManager.addPosition({
      id: execution.id,
      pair: 'arbitrage_position',
      type: 'arbitrage',
      size: 1,
      entryPrice: 1,
      currentPrice: 1 + netProfit,
      timestamp: Date.now()
    });

    return { profit: grossProfit, gasCost, netProfit };
  }

  private async cancelExecution(executionId: string, reason: string): Promise<void> {
    const execution = this.activeExecutions.get(executionId);
    if (execution) {
      execution.status = 'failed';
      execution.endTime = Date.now();

      logger.info('Execution cancelled', { executionId, reason });
    }
  }

  // Event handlers
  private async handlePriceUpdate(message: any): Promise<void> {
    try {
      // Update market data cache
      const { chain, pair, price } = message.data;
      await this.redis.hset(`market_data:${chain}`, pair, { currentPrice: price, timestamp: Date.now() });
    } catch (error) {
      logger.error('Failed to handle price update', { error });
    }
  }

  private async handleArbitrageOpportunity(message: any): Promise<void> {
    try {
      // Analyze and potentially execute opportunity
      const opportunity = message.data;

      if (opportunity.confidence > 0.8) { // High confidence only
        await this.executeArbitrageOpportunity(opportunity, opportunity.type === 'triangular' ? 'triangular' : 'statistical');
      }
    } catch (error) {
      logger.error('Failed to handle arbitrage opportunity', { error });
    }
  }

  private async handleStatisticalSignal(message: any): Promise<void> {
    // Forward to opportunity handler
    await this.handleArbitrageOpportunity(message);
  }

  private async handleTriangularOpportunity(message: any): Promise<void> {
    // Forward to opportunity handler
    await this.handleArbitrageOpportunity(message);
  }

  // Utility methods
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}

// Singleton instance
let arbitrageOrchestrator: AdvancedArbitrageOrchestrator | null = null;

export async function getAdvancedArbitrageOrchestrator(): Promise<AdvancedArbitrageOrchestrator> {
  if (!arbitrageOrchestrator) {
    arbitrageOrchestrator = new AdvancedArbitrageOrchestrator();
    await arbitrageOrchestrator.start();
  }
  return arbitrageOrchestrator;
}