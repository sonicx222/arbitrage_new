/**
 * Cross-Chain Simulator
 *
 * Maintains price state across multiple chains and detects arbitrage
 * opportunities when price differentials exceed bridge costs.
 *
 * @module simulation
 * @see docs/reports/SIMULATION_MODE_ENHANCEMENT_RESEARCH.md - Solution S2
 */

import { EventEmitter } from 'events';
import { createLogger } from '../logger';
import { clearIntervalSafe } from '../async/lifecycle-utils';
import type {
  CrossChainSimulatorConfig,
  SimulatedOpportunity,
  SimulatedBridgeProtocol,
} from './types';
import { DEFAULT_CONFIG, DEXES, BASE_PRICES, getTokenPrice, DEFAULT_BRIDGE_COSTS } from './constants';

// =============================================================================
// CrossChainSimulator
// =============================================================================

/**
 * Cross-chain price differential simulator.
 *
 * Events emitted:
 * - 'opportunity': SimulatedOpportunity - Cross-chain arbitrage opportunity
 * - 'priceUpdate': { chain, token, price } - Price change notification
 */
export class CrossChainSimulator extends EventEmitter {
  private config: CrossChainSimulatorConfig;
  private running = false;
  private interval: NodeJS.Timeout | null = null;
  private logger = createLogger('cross-chain-simulator');
  private opportunityId = 0;

  /**
   * Price state per chain per token.
   * Map<chain, Map<token, priceUsd>>
   */
  private chainPrices: Map<string, Map<string, number>> = new Map();

  /**
   * Bridge costs between chain pairs.
   * Map<'sourceChain-destChain', BridgeCostConfig>
   */
  private bridgeCosts: Map<string, { fixedCost: number; percentageFee: number; estimatedTimeSeconds: number }>;

  constructor(config: CrossChainSimulatorConfig) {
    super();
    this.config = {
      ...config,
      minProfitThreshold: config.minProfitThreshold ?? 0.002,
    };
    this.bridgeCosts = new Map(
      Object.entries(config.bridgeCosts ?? DEFAULT_BRIDGE_COSTS)
    );
    this.initializePrices();
  }

  /**
   * Initialize price state for all chains and tokens.
   */
  private initializePrices(): void {
    for (const chain of this.config.chains) {
      const chainPriceMap = new Map<string, number>();

      for (const token of this.config.tokens) {
        const basePrice = getTokenPrice(token);
        if (basePrice === 1 && !BASE_PRICES[token.toUpperCase()]) {
          continue;
        }

        const variation = 1 + (Math.random() - 0.5) * 0.01;
        chainPriceMap.set(token, basePrice * variation);
      }

      this.chainPrices.set(chain, chainPriceMap);
    }

    this.logger.info('Cross-chain simulator prices initialized', {
      chains: this.config.chains.length,
      tokens: this.config.tokens.length,
      bridgeRoutes: this.bridgeCosts.size,
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.logger.info('Starting cross-chain simulator', {
      chains: this.config.chains,
      updateInterval: this.config.updateIntervalMs,
      minProfitThreshold: `${this.config.minProfitThreshold * 100}%`,
    });

    this.interval = setInterval(() => {
      this.simulateTick();
    }, this.config.updateIntervalMs);

    this.detectAllCrossChainOpportunities();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.interval = clearIntervalSafe(this.interval);
    this.logger.info('Cross-chain simulator stopped');
  }

  /**
   * Simulate price updates across all chains.
   */
  private simulateTick(): void {
    for (const chain of this.config.chains) {
      const chainPrices = this.chainPrices.get(chain);
      if (!chainPrices) continue;

      for (const token of this.config.tokens) {
        const currentPrice = chainPrices.get(token);
        if (!currentPrice) continue;

        const change = (Math.random() - 0.5) * 2 * this.config.volatility;
        const newPrice = currentPrice * (1 + change);
        chainPrices.set(token, newPrice);

        this.emit('priceUpdate', { chain, token, price: newPrice });
      }
    }

    this.detectAllCrossChainOpportunities();
  }

  /**
   * Check all chain pairs for cross-chain arbitrage opportunities.
   */
  private detectAllCrossChainOpportunities(): void {
    for (let i = 0; i < this.config.chains.length; i++) {
      for (let j = 0; j < this.config.chains.length; j++) {
        if (i === j) continue;

        const sourceChain = this.config.chains[i];
        const destChain = this.config.chains[j];

        for (const token of this.config.tokens) {
          const opportunity = this.detectCrossChainOpportunity(
            token, sourceChain, destChain
          );

          if (opportunity) {
            this.emit('opportunity', opportunity);
            this.logger.debug('Simulated cross-chain opportunity', {
              id: opportunity.id,
              token,
              buyChain: opportunity.buyChain,
              sellChain: opportunity.sellChain,
              profit: `${opportunity.profitPercentage.toFixed(2)}%`,
            });
          }
        }
      }
    }
  }

  /**
   * Detect cross-chain opportunity for a specific token between two chains.
   */
  private detectCrossChainOpportunity(
    token: string,
    sourceChain: string,
    destChain: string
  ): SimulatedOpportunity | null {
    const sourcePrice = this.chainPrices.get(sourceChain)?.get(token);
    const destPrice = this.chainPrices.get(destChain)?.get(token);

    if (!sourcePrice || !destPrice) return null;
    if (destPrice <= sourcePrice) return null;

    const bridgeKey = `${sourceChain}-${destChain}`;
    const bridgeCost = this.bridgeCosts.get(bridgeKey);
    if (!bridgeCost) return null;

    if (bridgeCost.percentageFee > 1.0) {
      this.logger.warn('Bridge percentage fee appears to be in basis points, not decimal', {
        route: bridgeKey,
        percentageFee: bridgeCost.percentageFee,
        expectedRange: '0.0001 to 0.1 (0.01% to 10%)',
      });
    }

    const grossProfitUsd = destPrice - sourcePrice;
    const positionSize = 10000;
    const grossProfitTotal = (grossProfitUsd / sourcePrice) * positionSize;

    const percentageFeeUsd = positionSize * bridgeCost.percentageFee;
    const bridgeFeeUsd = Math.round((bridgeCost.fixedCost + percentageFeeUsd) * 100) / 100;

    const netProfitUsd = Math.round((grossProfitTotal - bridgeFeeUsd) * 100) / 100;
    const netProfitPercentage = netProfitUsd / positionSize;

    if (netProfitPercentage < this.config.minProfitThreshold) {
      return null;
    }

    const bridgeProtocol: SimulatedBridgeProtocol =
      sourceChain === 'ethereum' || destChain === 'ethereum'
        ? 'stargate'
        : 'across';

    const estimatedGasCost = this.estimateGasCost(sourceChain, destChain);

    return {
      id: `sim-xchain-${++this.opportunityId}`,
      type: 'cross-chain',
      chain: sourceChain,
      buyChain: sourceChain,
      sellChain: destChain,
      buyDex: DEXES[sourceChain]?.[0] || 'dex',
      sellDex: DEXES[destChain]?.[0] || 'dex',
      tokenPair: `${token}/USDC`,
      buyPrice: sourcePrice,
      sellPrice: destPrice,
      profitPercentage: netProfitPercentage * 100,
      estimatedProfitUsd: netProfitUsd,
      confidence: 0.7 + Math.random() * 0.15,
      timestamp: Date.now(),
      expiresAt: Date.now() + bridgeCost.estimatedTimeSeconds * 1000,
      isSimulated: true,
      useFlashLoan: false,
      bridgeProtocol,
      bridgeFee: bridgeFeeUsd,
      expectedGasCost: estimatedGasCost,
      expectedProfit: netProfitUsd - estimatedGasCost,
    };
  }

  /**
   * Estimate gas cost for cross-chain execution.
   */
  private estimateGasCost(sourceChain: string, destChain: string): number {
    const chainGasCosts: Record<string, number> = {
      ethereum: 25,
      arbitrum: 1.5,
      optimism: 1.0,
      base: 0.5,
      polygon: 0.3,
      bsc: 0.5,
      avalanche: 2.0,
      fantom: 0.2,
      zksync: 1.0,
      linea: 0.8,
      blast: 0.5,
      scroll: 0.5,
      mantle: 0.2,
      mode: 0.5,
      solana: 0.01,
    };

    const sourceGas = chainGasCosts[sourceChain] ?? 5;
    const destGas = chainGasCosts[destChain] ?? 5;
    return sourceGas + destGas + 2;
  }

  getPrice(chain: string, token: string): number | undefined {
    return this.chainPrices.get(chain)?.get(token);
  }

  getAllPricesForToken(token: string): Map<string, number> {
    const prices = new Map<string, number>();
    for (const [chain, chainPrices] of this.chainPrices) {
      const price = chainPrices.get(token);
      if (price) {
        prices.set(chain, price);
      }
    }
    return prices;
  }

  isRunning(): boolean {
    return this.running;
  }
}

// =============================================================================
// Cross-Chain Simulator Factory
// =============================================================================

let crossChainSimulatorInstance: CrossChainSimulator | null = null;

/**
 * Get or create the cross-chain simulator singleton.
 */
export function getCrossChainSimulator(
  config?: Partial<CrossChainSimulatorConfig>
): CrossChainSimulator {
  if (!crossChainSimulatorInstance) {
    const defaultConfig: CrossChainSimulatorConfig = {
      chains: ['ethereum', 'arbitrum', 'optimism', 'base', 'polygon', 'bsc', 'avalanche', 'fantom', 'zksync', 'linea', 'blast', 'scroll', 'mantle', 'mode', 'solana'],
      // W2-M2 FIX: Use DEFAULT_CONFIG values instead of divergent inline defaults
      updateIntervalMs: DEFAULT_CONFIG.updateIntervalMs,
      volatility: DEFAULT_CONFIG.volatility,
      minProfitThreshold: 0.002,
      tokens: ['WETH', 'WBTC', 'USDC', 'USDT', 'LINK', 'UNI', 'AAVE'],
    };

    crossChainSimulatorInstance = new CrossChainSimulator({
      ...defaultConfig,
      ...config,
    });
  }

  return crossChainSimulatorInstance;
}

/**
 * Stop and reset the cross-chain simulator.
 */
export function stopCrossChainSimulator(): void {
  if (crossChainSimulatorInstance) {
    crossChainSimulatorInstance.stop();
    crossChainSimulatorInstance = null;
  }
}
