/**
 * Regression tests for shared stream serialization utility.
 *
 * Verifies that serializeOpportunityForStream produces the exact field set
 * expected by the execution engine's Redis Stream consumer.
 *
 * @see services/coordinator/src/utils/stream-serialization.ts
 * @see Fix #12 in .agent-reports/services-deep-analysis.md
 */
import { serializeOpportunityForStream } from '../../../src/utils/stream-serialization';
import type { ArbitrageOpportunity } from '@arbitrage/types';

describe('serializeOpportunityForStream', () => {
  const EXPECTED_FIELDS = [
    'id', 'type', 'chain', 'buyDex', 'sellDex',
    'profitPercentage', 'confidence', 'timestamp', 'expiresAt',
    'tokenIn', 'tokenOut', 'amountIn', 'forwardedBy', 'forwardedAt',
  ];

  it('should produce all 14 required fields', () => {
    const opp = {
      id: 'test-1',
      type: 'simple',
      chain: 'ethereum',
      buyDex: 'uniswap',
      sellDex: 'sushiswap',
      profitPercentage: 1.5,
      confidence: 0.9,
      timestamp: 1000,
      expiresAt: 2000,
      tokenIn: '0xabc',
      tokenOut: '0xdef',
      amountIn: '100',
    } as unknown as ArbitrageOpportunity;

    const result = serializeOpportunityForStream(opp, 'inst-1');

    expect(Object.keys(result).sort()).toEqual(EXPECTED_FIELDS.sort());
    expect(result.forwardedBy).toBe('inst-1');
    expect(result.profitPercentage).toBe('1.5');
    expect(result.confidence).toBe('0.9');
    expect(result.id).toBe('test-1');
  });

  it('should use defaults for missing optional fields', () => {
    const opp = { id: 'test-2' } as unknown as ArbitrageOpportunity;
    const result = serializeOpportunityForStream(opp, 'inst-1');

    expect(result.type).toBe('simple');
    expect(result.chain).toBe('unknown');
    expect(result.buyDex).toBe('');
    expect(result.sellDex).toBe('');
    expect(result.profitPercentage).toBe('0');
    expect(result.confidence).toBe('0');
    expect(result.tokenIn).toBe('');
    expect(result.tokenOut).toBe('');
    expect(result.amountIn).toBe('');
  });

  it('should use || for type and chain (empty string triggers default)', () => {
    const opp = {
      id: 'test-3',
      type: '',
      chain: '',
    } as unknown as ArbitrageOpportunity;
    const result = serializeOpportunityForStream(opp, 'inst-1');

    expect(result.type).toBe('simple');
    expect(result.chain).toBe('unknown');
  });

  it('should preserve zero profit and confidence values', () => {
    const opp = {
      id: 'test-4',
      profitPercentage: 0,
      confidence: 0,
    } as unknown as ArbitrageOpportunity;
    const result = serializeOpportunityForStream(opp, 'inst-1');

    expect(result.profitPercentage).toBe('0');
    expect(result.confidence).toBe('0');
  });

  it('should use ?? for buyDex/sellDex (empty string preserved)', () => {
    const opp = {
      id: 'test-5',
      buyDex: '',
      sellDex: '',
    } as unknown as ArbitrageOpportunity;
    const result = serializeOpportunityForStream(opp, 'inst-1');

    // ?? preserves empty string (unlike || which would replace it)
    expect(result.buyDex).toBe('');
    expect(result.sellDex).toBe('');
  });

  it('should generate forwardedAt as a numeric timestamp string', () => {
    const before = Date.now();
    const opp = { id: 'test-6' } as unknown as ArbitrageOpportunity;
    const result = serializeOpportunityForStream(opp, 'inst-1');
    const after = Date.now();

    const forwardedAt = parseInt(result.forwardedAt, 10);
    expect(forwardedAt).toBeGreaterThanOrEqual(before);
    expect(forwardedAt).toBeLessThanOrEqual(after);
  });

  it('should fall back to Date.now for missing timestamp', () => {
    const before = Date.now();
    const opp = { id: 'test-7' } as unknown as ArbitrageOpportunity;
    const result = serializeOpportunityForStream(opp, 'inst-1');
    const after = Date.now();

    const timestamp = parseInt(result.timestamp, 10);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  it('should return all values as strings', () => {
    const opp = {
      id: 'test-8',
      type: 'flash',
      chain: 'bsc',
      profitPercentage: 2.5,
      confidence: 0.85,
      timestamp: 1234567890,
    } as unknown as ArbitrageOpportunity;
    const result = serializeOpportunityForStream(opp, 'inst-1');

    for (const [key, value] of Object.entries(result)) {
      expect(typeof value).toBe('string');
    }
  });
});
