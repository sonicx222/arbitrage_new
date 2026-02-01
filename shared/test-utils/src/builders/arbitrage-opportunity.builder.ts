/**
 * Test Data Builder for ArbitrageOpportunity
 */

import type { ArbitrageOpportunity } from '@arbitrage/types';

export class ArbitrageOpportunityBuilder {
  private opportunity: Partial<ArbitrageOpportunity> = {
    id: `test-opp-${Date.now()}`,
    type: 'simple',
    chain: 'arbitrum',
    buyDex: 'uniswap-v2',
    sellDex: 'sushiswap',
    buyPair: '0x0000000000000000000000000000000000000001',
    sellPair: '0x0000000000000000000000000000000000000002',
    token0: '0x1111111111111111111111111111111111111111',
    token1: '0x2222222222222222222222222222222222222222',
    buyPrice: 1.0,
    sellPrice: 1.05,
    profitPercentage: 5.0,
    expectedProfit: 0.05,
    estimatedProfit: 0,
    gasEstimate: '150000',
    confidence: 0.85,
    timestamp: Date.now(),
    expiresAt: Date.now() + 5000,
    blockNumber: 1000000,
    status: 'pending'
  };

  withId(id: string): this {
    this.opportunity.id = id;
    return this;
  }

  withChain(chain: string): this {
    this.opportunity.chain = chain;
    return this;
  }

  withDexes(buyDex: string, sellDex: string): this {
    this.opportunity.buyDex = buyDex;
    this.opportunity.sellDex = sellDex;
    return this;
  }

  withPrices(buyPrice: number, sellPrice: number): this {
    this.opportunity.buyPrice = buyPrice;
    this.opportunity.sellPrice = sellPrice;
    // Auto-calculate profit percentage
    const priceDiff = (sellPrice - buyPrice) / buyPrice;
    this.opportunity.profitPercentage = priceDiff * 100;
    this.opportunity.expectedProfit = priceDiff;
    return this;
  }

  withProfitPercentage(profitPercentage: number): this {
    this.opportunity.profitPercentage = profitPercentage;
    this.opportunity.expectedProfit = profitPercentage / 100;
    return this;
  }

  withConfidence(confidence: number): this {
    this.opportunity.confidence = confidence;
    return this;
  }

  withStatus(status: ArbitrageOpportunity['status']): this {
    this.opportunity.status = status;
    return this;
  }

  build(): ArbitrageOpportunity {
    return this.opportunity as ArbitrageOpportunity;
  }

  buildMany(count: number): ArbitrageOpportunity[] {
    return Array.from({ length: count }, (_, i) => {
      return this.withId(`test-opp-${Date.now()}-${i}`).build();
    });
  }
}

export function opportunity(): ArbitrageOpportunityBuilder {
  return new ArbitrageOpportunityBuilder();
}
