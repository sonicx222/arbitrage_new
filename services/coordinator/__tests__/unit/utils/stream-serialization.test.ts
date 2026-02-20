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
import type { TraceContext } from '@arbitrage/core/tracing';

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

  // ===========================================================================
  // M11 FIX: Edge case serialization (special values, large numbers)
  // ===========================================================================

  describe('edge case serialization (M11)', () => {
    it('should serialize very large profit values without precision loss', () => {
      const opp = {
        id: 'test-large',
        profitPercentage: 9999.999999,
        confidence: 0.999999,
        timestamp: Number.MAX_SAFE_INTEGER,
      } as unknown as ArbitrageOpportunity;
      const result = serializeOpportunityForStream(opp, 'inst-1');

      expect(result.profitPercentage).toBe('9999.999999');
      expect(result.confidence).toBe('0.999999');
      expect(result.timestamp).toBe(String(Number.MAX_SAFE_INTEGER));
    });

    it('should handle special characters in string fields', () => {
      const opp = {
        id: 'test-special-chars',
        buyDex: 'uniswap v3 (0x1234)',
        sellDex: 'sushi<swap>',
        tokenIn: '0xABCDEF',
        tokenOut: '0x123456',
      } as unknown as ArbitrageOpportunity;
      const result = serializeOpportunityForStream(opp, 'inst-1');

      expect(result.buyDex).toBe('uniswap v3 (0x1234)');
      expect(result.sellDex).toBe('sushi<swap>');
    });

    it('should handle pipelineTimestamps as JSON string', () => {
      const opp = {
        id: 'test-pipeline',
        pipelineTimestamps: { detected: 1000, published: 1010, received: 1020 },
      } as unknown as ArbitrageOpportunity;
      const result = serializeOpportunityForStream(opp, 'inst-1');

      expect(result.pipelineTimestamps).toBe(
        JSON.stringify({ detected: 1000, published: 1010, received: 1020 }),
      );
    });

    it('should handle negative profit percentage', () => {
      const opp = {
        id: 'test-negative',
        profitPercentage: -0.5,
      } as unknown as ArbitrageOpportunity;
      const result = serializeOpportunityForStream(opp, 'inst-1');

      expect(result.profitPercentage).toBe('-0.5');
    });
  });

  // ===========================================================================
  // OP-3 FIX: Trace context propagation
  // ===========================================================================

  describe('trace context propagation (OP-3)', () => {
    const baseOpp = {
      id: 'trace-test-1',
      type: 'simple',
      chain: 'bsc',
      profitPercentage: 1.0,
      confidence: 0.8,
      timestamp: 1000,
    } as unknown as ArbitrageOpportunity;

    it('should inject _trace_ prefixed fields when traceContext is provided', () => {
      const traceCtx: TraceContext = {
        traceId: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
        spanId: '1234567890abcdef',
        parentSpanId: 'fedcba0987654321',
        serviceName: 'coordinator',
        timestamp: 9999,
      };

      const result = serializeOpportunityForStream(baseOpp, 'inst-1', traceCtx);

      expect(result._trace_traceId).toBe('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4');
      expect(result._trace_spanId).toBe('1234567890abcdef');
      expect(result._trace_parentSpanId).toBe('fedcba0987654321');
      expect(result._trace_serviceName).toBe('coordinator');
      expect(result._trace_timestamp).toBe('9999');
    });

    it('should omit _trace_parentSpanId when parentSpanId is absent', () => {
      const traceCtx: TraceContext = {
        traceId: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
        spanId: '1234567890abcdef',
        serviceName: 'coordinator',
        timestamp: 9999,
      };

      const result = serializeOpportunityForStream(baseOpp, 'inst-1', traceCtx);

      expect(result._trace_traceId).toBe('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4');
      expect(result._trace_spanId).toBe('1234567890abcdef');
      expect(result._trace_parentSpanId).toBeUndefined();
      expect(result._trace_serviceName).toBe('coordinator');
    });

    it('should NOT inject _trace_ fields when traceContext is undefined', () => {
      const result = serializeOpportunityForStream(baseOpp, 'inst-1');

      const traceKeys = Object.keys(result).filter(k => k.startsWith('_trace_'));
      expect(traceKeys).toHaveLength(0);
    });

    it('should NOT inject _trace_ fields when traceContext is explicitly undefined', () => {
      const result = serializeOpportunityForStream(baseOpp, 'inst-1', undefined);

      const traceKeys = Object.keys(result).filter(k => k.startsWith('_trace_'));
      expect(traceKeys).toHaveLength(0);
    });

    it('should return all trace field values as strings', () => {
      const traceCtx: TraceContext = {
        traceId: 'abc123',
        spanId: 'def456',
        serviceName: 'coordinator',
        timestamp: 5555,
      };

      const result = serializeOpportunityForStream(baseOpp, 'inst-1', traceCtx);

      for (const [key, value] of Object.entries(result)) {
        if (key.startsWith('_trace_')) {
          expect(typeof value).toBe('string');
        }
      }
    });
  });
});
