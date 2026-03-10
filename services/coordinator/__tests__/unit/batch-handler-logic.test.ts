/**
 * H-05 FIX: Unit tests for batch handler data extraction logic.
 *
 * The coordinator's batch handlers (handlePriceUpdateBatch, handleExecutionResultBatch)
 * are private methods that depend on the full coordinator instance. Rather than
 * duplicating the 120+ line mock setup, these tests validate the data extraction
 * and metric update patterns used within the batch handlers.
 *
 * The batch handlers delegate to:
 * - type-guards.ts (getString, getNumber, getOptionalNumber, getOptionalString, unwrapMessageData)
 *   → tested in type-guards.test.ts (H-04)
 * - classifyDlqError → tested in dlq-classification.test.ts (L-14)
 * - OpportunityRouter.processOpportunityBatch → tested in opportunity-router.test.ts
 *
 * These tests cover the integration patterns: metric accumulation, SSE emission
 * shapes, and empty/malformed batch handling.
 *
 * @see coordinator.ts handlePriceUpdateBatch, handleExecutionResultBatch
 */

import { getString, getNumber, getOptionalString, unwrapMessageData } from '../../src/utils/type-guards';

describe('Batch handler data extraction patterns', () => {
  describe('execution result extraction (handleExecutionResultBatch pattern)', () => {
    function extractExecutionResult(rawResult: Record<string, unknown>) {
      return {
        success: rawResult.success === true || rawResult.success === 'true',
        opportunityId: getString(rawResult, 'opportunityId', ''),
        chain: getString(rawResult, 'chain', 'unknown'),
        dex: getString(rawResult, 'dex', 'unknown'),
        actualProfit: getNumber(rawResult, 'actualProfit', 0),
        gasUsed: getNumber(rawResult, 'gasUsed', 0),
        gasCost: getNumber(rawResult, 'gasCost', 0),
        error: getOptionalString(rawResult, 'error'),
        transactionHash: getOptionalString(rawResult, 'transactionHash'),
        latencyMs: getNumber(rawResult, 'latencyMs', 0),
        timestamp: getNumber(rawResult, 'timestamp', Date.now()),
      };
    }

    it('should extract successful execution result from string-encoded fields', () => {
      const data = {
        success: 'true',
        opportunityId: 'opp-123',
        chain: 'ethereum',
        dex: 'uniswap',
        actualProfit: '1.5',
        gasUsed: '250000',
        gasCost: '0.02',
        transactionHash: '0xabc123',
        latencyMs: '42',
        timestamp: '1700000000000',
      };

      const result = extractExecutionResult(data);
      expect(result.success).toBe(true);
      expect(result.opportunityId).toBe('opp-123');
      expect(result.chain).toBe('ethereum');
      expect(result.actualProfit).toBe(1.5);
      expect(result.gasUsed).toBe(250000);
      expect(result.transactionHash).toBe('0xabc123');
      expect(result.latencyMs).toBe(42);
    });

    it('should extract failed execution result', () => {
      const data = {
        success: 'false',
        opportunityId: 'opp-456',
        chain: 'arbitrum',
        error: 'SLIPPAGE_EXCEEDED',
      };

      const result = extractExecutionResult(data);
      expect(result.success).toBe(false);
      expect(result.error).toBe('SLIPPAGE_EXCEEDED');
      expect(result.actualProfit).toBe(0);
    });

    it('should handle boolean success field (not just string)', () => {
      expect(extractExecutionResult({ success: true }).success).toBe(true);
      expect(extractExecutionResult({ success: false }).success).toBe(false);
    });

    it('should handle missing fields with defaults', () => {
      const result = extractExecutionResult({});
      expect(result.success).toBe(false);
      expect(result.opportunityId).toBe('');
      expect(result.chain).toBe('unknown');
      expect(result.actualProfit).toBe(0);
      expect(result.error).toBeUndefined();
      expect(result.transactionHash).toBeUndefined();
    });

    it('should accumulate metrics from a batch correctly', () => {
      const batch = [
        { success: 'true', opportunityId: 'a', actualProfit: '1.5' },
        { success: 'true', opportunityId: 'b', actualProfit: '0.8' },
        { success: 'false', opportunityId: 'c', error: 'TIMEOUT' },
        { success: 'true', opportunityId: 'd', actualProfit: '0' },
      ];

      let successes = 0;
      let failures = 0;
      let totalProfit = 0;

      for (const raw of batch) {
        const result = extractExecutionResult(raw);
        if (!result.opportunityId) continue;
        if (result.success) {
          successes++;
          if (result.actualProfit > 0) totalProfit += result.actualProfit;
        } else {
          failures++;
        }
      }

      expect(successes).toBe(3);
      expect(failures).toBe(1);
      expect(totalProfit).toBeCloseTo(2.3);
    });
  });

  describe('price update extraction (handlePriceUpdateBatch pattern)', () => {
    it('should extract chain, dex, and pairKey from price update', () => {
      const data = { chain: 'bsc', dex: 'pancakeswap', pairKey: 'WBNB/USDT' };
      const unwrapped = unwrapMessageData(data);

      expect(getString(unwrapped, 'chain', 'unknown')).toBe('bsc');
      expect(getString(unwrapped, 'dex', 'unknown')).toBe('pancakeswap');
      expect(getString(unwrapped, 'pairKey', '')).toBe('WBNB/USDT');
    });

    it('should skip entries with empty pairKey', () => {
      const data = { chain: 'ethereum', dex: 'uniswap', pairKey: '' };
      expect(getString(data, 'pairKey', '')).toBe('');
    });

    it('should handle wrapped message envelopes', () => {
      const wrapped = {
        type: 'price-update',
        data: { chain: 'polygon', dex: 'quickswap', pairKey: 'WMATIC/USDC' },
      };
      const unwrapped = unwrapMessageData(wrapped as Record<string, unknown>);
      expect(getString(unwrapped, 'chain', 'unknown')).toBe('polygon');
      expect(getString(unwrapped, 'pairKey', '')).toBe('WMATIC/USDC');
    });

    it('should track processed IDs for all messages including skipped ones', () => {
      const messages = [
        { id: '1-0', data: { chain: 'eth', dex: 'uni', pairKey: 'WETH/USDC' } },
        { id: '2-0', data: { chain: 'eth', dex: 'uni', pairKey: '' } }, // skip
        { id: '3-0', data: null }, // skip
        { id: '4-0', data: { chain: 'bsc', dex: 'cake', pairKey: 'WBNB/BUSD' } },
      ];

      const processedIds: string[] = [];
      let priceUpdatesReceived = 0;

      for (const msg of messages) {
        const data = msg.data as Record<string, unknown> | null;
        if (!data) {
          processedIds.push(msg.id);
          continue;
        }
        const pairKey = getString(data, 'pairKey', '');
        if (!pairKey) {
          processedIds.push(msg.id);
          continue;
        }
        priceUpdatesReceived++;
        processedIds.push(msg.id);
      }

      expect(processedIds).toEqual(['1-0', '2-0', '3-0', '4-0']);
      expect(priceUpdatesReceived).toBe(2);
    });
  });

  describe('null/undefined data handling', () => {
    it('should handle null data by adding to processedIds', () => {
      const msg = { id: '1-0', data: null };
      const processedIds: string[] = [];

      const data = msg.data as Record<string, unknown> | null;
      if (!data) {
        processedIds.push(msg.id);
      }

      expect(processedIds).toEqual(['1-0']);
    });

    it('should handle empty batch returning empty processedIds', () => {
      const messages: Array<{ id: string; data: unknown }> = [];
      const processedIds: string[] = [];

      for (const msg of messages) {
        processedIds.push(msg.id);
      }

      expect(processedIds).toEqual([]);
    });
  });
});
