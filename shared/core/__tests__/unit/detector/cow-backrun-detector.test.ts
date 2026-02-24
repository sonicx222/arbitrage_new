/**
 * CowBackrunDetector Tests
 *
 * Tests the detection of backrun opportunities from CoW Protocol
 * batch settlements. Verifies price impact estimation, trade filtering,
 * opportunity generation, and watcher integration.
 *
 * @see shared/core/src/detector/cow-backrun-detector.ts
 * @see Phase 4 Task 23: CoW backrun detector
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { EventEmitter } from 'events';

// =============================================================================
// Mock Setup - Must be before imports that use these modules
// =============================================================================

jest.mock('../../../src/logger');

// =============================================================================
// Imports - After mocks
// =============================================================================

import { CowBackrunDetector } from '../../../src/detector/cow-backrun-detector';
import type { CowBackrunConfig } from '../../../src/detector/cow-backrun-detector';
import type { CowSettlement, CowTrade, CowSettlementWatcher } from '../../../src/feeds/cow-settlement-watcher';
import { GPV2_SETTLEMENT_ADDRESS } from '../../../src/feeds/cow-settlement-watcher';
import type { ArbitrageOpportunity } from '@arbitrage/types';

// =============================================================================
// Helpers
// =============================================================================

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
const UNKNOWN_TOKEN = '0x1234567890abcdef1234567890abcdef12345678';

const DEFAULT_CONFIG: CowBackrunConfig = {
  minProfitUsd: 10,
  maxBlockDelay: 2,
  minTradeSize: 50000,
  poolReserveUsd: 5_000_000,
};

/**
 * Create a CowTrade with sensible defaults.
 */
function createTrade(overrides: Partial<CowTrade> = {}): CowTrade {
  return {
    owner: '0xOwner1',
    sellToken: WETH,
    buyToken: USDC,
    // Default: 100 WETH sell (~$250,000)
    sellAmount: 100000000000000000000n, // 100 WETH (18 decimals)
    // 250000 USDC buy
    buyAmount: 250000000000n, // 250,000 USDC (6 decimals)
    feeAmount: 1000000000000000000n, // 1 WETH
    orderUid: '0xOrderUid1',
    ...overrides,
  };
}

/**
 * Create a CowSettlement with sensible defaults.
 */
function createSettlement(overrides: Partial<CowSettlement> & { trades?: CowTrade[] } = {}): CowSettlement {
  return {
    txHash: '0xSettlementTx1',
    blockNumber: 19000000,
    solver: '0xSolver1',
    trades: [createTrade()],
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Create a mock CowSettlementWatcher (EventEmitter with settlement event).
 */
function createMockWatcher(): CowSettlementWatcher {
  return new EventEmitter() as unknown as CowSettlementWatcher;
}

// =============================================================================
// Tests
// =============================================================================

describe('CowBackrunDetector', () => {
  let detector: CowBackrunDetector;

  beforeEach(() => {
    detector = new CowBackrunDetector(DEFAULT_CONFIG);
  });

  // ===========================================================================
  // processSettlement — Opportunity Generation
  // ===========================================================================

  describe('processSettlement()', () => {
    it('should generate opportunity for large settlement trade', () => {
      // 100 WETH trade (~$250,000) — well above minTradeSize of $50,000
      const settlement = createSettlement();

      const opportunities = detector.processSettlement(settlement);

      expect(opportunities).toHaveLength(1);
      expect(opportunities[0].id).toBe('cow-backrun-0xSettlementTx1-0');
      expect(opportunities[0].type).toBe('backrun');
      expect(opportunities[0].chain).toBe('ethereum');
      expect(opportunities[0].confidence).toBe(0.6);
      expect(opportunities[0].expectedProfit).toBeGreaterThan(0);
      expect(opportunities[0].blockNumber).toBe(19000000);
    });

    it('should filter out small trades below minTradeSize', () => {
      // 1 WETH trade (~$2,500) — below minTradeSize of $50,000
      const smallTrade = createTrade({
        sellAmount: 1000000000000000000n, // 1 WETH
        buyAmount: 2500000000n, // 2,500 USDC
      });
      const settlement = createSettlement({ trades: [smallTrade] });

      const opportunities = detector.processSettlement(settlement);

      expect(opportunities).toHaveLength(0);
    });

    it('should filter out low-profit opportunities below minProfitUsd', () => {
      // Use a very large pool reserve to make all profits negligible
      const conservativeDetector = new CowBackrunDetector({
        ...DEFAULT_CONFIG,
        minProfitUsd: 100000, // absurdly high min profit
      });

      const settlement = createSettlement();
      const opportunities = conservativeDetector.processSettlement(settlement);

      expect(opportunities).toHaveLength(0);
    });

    it('should set correct backrunTarget fields', () => {
      const settlement = createSettlement({
        txHash: '0xMySettlementHash',
      });

      const opportunities = detector.processSettlement(settlement);

      expect(opportunities).toHaveLength(1);
      const target = opportunities[0].backrunTarget;
      expect(target).toBeDefined();
      expect(target!.txHash).toBe('0xMySettlementHash');
      expect(target!.routerAddress).toBe(GPV2_SETTLEMENT_ADDRESS);
      expect(target!.swapDirection).toBe('sell');
      expect(target!.source).toBe('cow_protocol');
      expect(target!.estimatedSwapSize).toBeDefined();
      expect(parseFloat(target!.estimatedSwapSize!)).toBeGreaterThan(0);
    });

    it('should reverse token direction for backrun', () => {
      // Settlement trades WETH (sell) -> USDC (buy)
      // Backrun should be: tokenIn = USDC (buy what was sold), tokenOut = WETH (sell what was bought)
      const trade = createTrade({
        sellToken: WETH,
        buyToken: USDC,
      });
      const settlement = createSettlement({ trades: [trade] });

      const opportunities = detector.processSettlement(settlement);

      expect(opportunities).toHaveLength(1);
      // Backrun reverses: tokenIn is the settlement's buyToken
      expect(opportunities[0].tokenIn).toBe(USDC);
      // Backrun reverses: tokenOut is the settlement's sellToken
      expect(opportunities[0].tokenOut).toBe(WETH);
    });

    it('should handle empty settlements', () => {
      const settlement = createSettlement({ trades: [] });

      const opportunities = detector.processSettlement(settlement);

      expect(opportunities).toHaveLength(0);
    });

    it('should handle multiple trades in one settlement', () => {
      // Use low thresholds so both trades pass
      const multiDetector = new CowBackrunDetector({
        minProfitUsd: 1,
        maxBlockDelay: 2,
        minTradeSize: 1000,
        poolReserveUsd: 5_000_000,
      });

      const trades = [
        createTrade({
          owner: '0xAlice',
          sellToken: WETH,
          buyToken: USDC,
          sellAmount: 40000000000000000000n, // 40 WETH (~$100,000)
          buyAmount: 100000000000n,
          orderUid: '0xOrder1',
        }),
        createTrade({
          owner: '0xBob',
          sellToken: WETH,
          buyToken: DAI,
          sellAmount: 80000000000000000000n, // 80 WETH (~$200,000)
          buyAmount: 200000000000000000000000n, // 200,000 DAI (18 decimals)
          orderUid: '0xOrder2',
        }),
      ];

      const settlement = createSettlement({
        txHash: '0xMultiTrade',
        trades,
      });

      const opportunities = multiDetector.processSettlement(settlement);

      expect(opportunities).toHaveLength(2);
      expect(opportunities[0].id).toBe('cow-backrun-0xMultiTrade-0');
      expect(opportunities[1].id).toBe('cow-backrun-0xMultiTrade-1');
    });

    it('should generate unique IDs for each opportunity', () => {
      const multiDetector = new CowBackrunDetector({
        minProfitUsd: 0.01,
        maxBlockDelay: 2,
        minTradeSize: 100,
        poolReserveUsd: 5_000_000,
      });

      const trades = [
        createTrade({ orderUid: '0xOrder1' }),
        createTrade({ orderUid: '0xOrder2' }),
      ];

      const settlement = createSettlement({
        txHash: '0xUnique',
        trades,
      });

      const opportunities = multiDetector.processSettlement(settlement);
      const ids = new Set(opportunities.map(o => o.id));
      expect(ids.size).toBe(opportunities.length);
    });
  });

  // ===========================================================================
  // Price Impact Estimation
  // ===========================================================================

  describe('estimatePriceImpact()', () => {
    it('should estimate price impact for WETH sell', () => {
      // 100 WETH (~$250,000) into a $5M pool
      const trade = createTrade({
        sellToken: WETH,
        buyToken: USDC,
        sellAmount: 100000000000000000000n, // 100 WETH
      });

      const result = detector.estimatePriceImpact(trade);

      // Impact = 250000 / (2 * 5000000) * 100 = 2.5%
      expect(result.impactPct).toBeCloseTo(2.5, 1);
      // Profit = 250000^2 / (4 * 5000000) = 3125
      expect(result.estimatedProfitUsd).toBeCloseTo(3125, 0);
    });

    it('should estimate price impact for stablecoin sell', () => {
      // 500,000 USDC sell
      const trade = createTrade({
        sellToken: USDC,
        buyToken: WETH,
        sellAmount: 500000000000n, // 500,000 USDC (6 decimals)
        buyAmount: 200000000000000000000n, // 200 WETH
      });

      const result = detector.estimatePriceImpact(trade);

      // Impact = 500000 / (2 * 5000000) * 100 = 5%
      expect(result.impactPct).toBeCloseTo(5.0, 1);
      expect(result.estimatedProfitUsd).toBeGreaterThan(0);
    });

    it('should handle DAI (18 decimal stablecoin)', () => {
      // 100,000 DAI sell
      const trade = createTrade({
        sellToken: DAI,
        buyToken: WETH,
        sellAmount: 100000000000000000000000n, // 100,000 DAI (18 decimals)
        buyAmount: 40000000000000000000n, // 40 WETH
      });

      const result = detector.estimatePriceImpact(trade);

      // Impact = 100000 / (2 * 5000000) * 100 = 1%
      expect(result.impactPct).toBeCloseTo(1.0, 1);
    });

    it('should return low impact for small trades', () => {
      // 0.1 WETH (~$250)
      const trade = createTrade({
        sellAmount: 100000000000000000n, // 0.1 WETH
        buyAmount: 250000000n, // 250 USDC
      });

      const result = detector.estimatePriceImpact(trade);

      expect(result.impactPct).toBeLessThan(0.01);
      expect(result.estimatedProfitUsd).toBeLessThan(1);
    });

    it('should handle unknown tokens with fallback estimation', () => {
      const trade = createTrade({
        sellToken: UNKNOWN_TOKEN,
        buyToken: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        sellAmount: 1000000000000000000000n, // 1000 * 10^18
      });

      const result = detector.estimatePriceImpact(trade);

      // Should still return a number, even if estimated roughly
      expect(typeof result.impactPct).toBe('number');
      expect(typeof result.estimatedProfitUsd).toBe('number');
      expect(result.impactPct).toBeGreaterThanOrEqual(0);
    });
  });

  // ===========================================================================
  // Watcher Integration
  // ===========================================================================

  describe('attachToWatcher()', () => {
    it('should subscribe to settlement events', () => {
      const watcher = createMockWatcher();
      detector.attachToWatcher(watcher);

      expect(watcher.listenerCount('settlement')).toBe(1);
    });

    it('should emit opportunities when watcher emits settlements', () => {
      const watcher = createMockWatcher();
      detector.attachToWatcher(watcher);

      const opportunityHandler = jest.fn<(opp: ArbitrageOpportunity) => void>();
      detector.on('opportunity', opportunityHandler);

      // Emit a settlement with a large trade
      const settlement = createSettlement();
      watcher.emit('settlement', settlement);

      expect(opportunityHandler).toHaveBeenCalledTimes(1);
      expect(opportunityHandler.mock.calls[0][0].type).toBe('backrun');
    });

    it('should not duplicate subscriptions on repeated attach', () => {
      const watcher = createMockWatcher();

      detector.attachToWatcher(watcher);
      detector.attachToWatcher(watcher); // duplicate

      expect(watcher.listenerCount('settlement')).toBe(1);
    });
  });

  describe('detachFromWatcher()', () => {
    it('should remove settlement subscription', () => {
      const watcher = createMockWatcher();
      detector.attachToWatcher(watcher);
      expect(watcher.listenerCount('settlement')).toBe(1);

      detector.detachFromWatcher(watcher);
      expect(watcher.listenerCount('settlement')).toBe(0);
    });

    it('should not emit opportunities after detach', () => {
      const watcher = createMockWatcher();
      detector.attachToWatcher(watcher);

      const opportunityHandler = jest.fn();
      detector.on('opportunity', opportunityHandler);

      detector.detachFromWatcher(watcher);

      // Emit settlement after detach
      watcher.emit('settlement', createSettlement());

      expect(opportunityHandler).not.toHaveBeenCalled();
    });

    it('should handle detach when not attached', () => {
      const watcher = createMockWatcher();

      // Should not throw
      expect(() => detector.detachFromWatcher(watcher)).not.toThrow();
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle zero sellAmount gracefully', () => {
      const trade = createTrade({
        sellAmount: 0n,
        buyAmount: 0n,
      });
      const settlement = createSettlement({ trades: [trade] });

      const opportunities = detector.processSettlement(settlement);

      // Zero-size trade should not generate opportunity (below minTradeSize)
      expect(opportunities).toHaveLength(0);
    });

    it('should handle very large trade amounts', () => {
      // 10,000 WETH (~$25M) — whale trade
      const trade = createTrade({
        sellAmount: 10000000000000000000000n, // 10,000 WETH
        buyAmount: 25000000000000n, // 25M USDC
      });
      const settlement = createSettlement({ trades: [trade] });

      const opportunities = detector.processSettlement(settlement);

      expect(opportunities).toHaveLength(1);
      expect(opportunities[0].expectedProfit).toBeGreaterThan(1000);
    });

    it('should use custom pool reserve when configured', () => {
      // Smaller pool = more price impact
      const shallowPoolDetector = new CowBackrunDetector({
        ...DEFAULT_CONFIG,
        poolReserveUsd: 100_000, // shallow pool
      });

      const trade = createTrade();
      const result = shallowPoolDetector.estimatePriceImpact(trade);
      const defaultResult = detector.estimatePriceImpact(trade);

      // Smaller pool = higher impact
      expect(result.impactPct).toBeGreaterThan(defaultResult.impactPct);
      expect(result.estimatedProfitUsd).toBeGreaterThan(defaultResult.estimatedProfitUsd);
    });
  });
});
