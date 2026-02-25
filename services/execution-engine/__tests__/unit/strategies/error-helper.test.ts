/**
 * Tests for BaseExecutionStrategy.createOpportunityError
 *
 * Validates that the static helper correctly extracts opportunity fields
 * and delegates to createErrorResult.
 */

import type { ArbitrageOpportunity } from '@arbitrage/types';
import { BaseExecutionStrategy } from '../../../src/strategies/base.strategy';

describe('BaseExecutionStrategy.createOpportunityError', () => {
  const baseOpportunity: ArbitrageOpportunity = {
    id: 'opp-123',
    type: 'simple' as const,
    buyChain: 'ethereum',
    sellChain: 'ethereum',
    buyDex: 'uniswap_v3',
    sellDex: 'sushiswap',
    tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    tokenOut: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    amountIn: '1000000000000000000',
    expectedProfit: 0.05,
    buyPrice: 1800.50,
    sellPrice: 1802.00,
    timestamp: Date.now(),
    confidence: 0.85,
  };

  it('creates error result with opportunity id and buyDex', () => {
    const result = BaseExecutionStrategy.createOpportunityError(
      baseOpportunity,
      'test error',
      'ethereum'
    );

    expect(result.success).toBe(false);
    expect(result.opportunityId).toBe('opp-123');
    expect(result.error).toBe('test error');
    expect(result.chain).toBe('ethereum');
    expect(result.dex).toBe('uniswap_v3');
    expect(result.transactionHash).toBeUndefined();
  });

  it('uses "unknown" when buyDex is undefined', () => {
    const oppNoDex: ArbitrageOpportunity = {
      ...baseOpportunity,
      buyDex: undefined,
    };

    const result = BaseExecutionStrategy.createOpportunityError(
      oppNoDex,
      'no dex error',
      'bsc'
    );

    expect(result.dex).toBe('unknown');
    expect(result.chain).toBe('bsc');
  });

  it('passes transactionHash when provided', () => {
    const txHash = '0xabc123def456';
    const result = BaseExecutionStrategy.createOpportunityError(
      baseOpportunity,
      'tx failed',
      'arbitrum',
      txHash
    );

    expect(result.transactionHash).toBe(txHash);
    expect(result.chain).toBe('arbitrum');
  });

  it('sets timestamp to a recent value', () => {
    const before = Date.now();
    const result = BaseExecutionStrategy.createOpportunityError(
      baseOpportunity,
      'timing test',
      'ethereum'
    );
    const after = Date.now();

    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(after);
  });

  it('preserves exact error message', () => {
    const complexError = '[EXEC_ERROR] Gas spike on ethereum: 500 gwei exceeds limit';
    const result = BaseExecutionStrategy.createOpportunityError(
      baseOpportunity,
      complexError,
      'ethereum'
    );

    expect(result.error).toBe(complexError);
  });
});
