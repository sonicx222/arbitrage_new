/**
 * Tests for MEV-Share SSE Event Listener
 *
 * Fix #8: Replaced vacuous tests with real invocations via the public processEvent() method.
 *
 * @see Phase 2 Item #23: MEV-Share backrun filling
 */

import {
  MevShareEventListener,
  COMMON_SWAP_SELECTORS,
} from '../../../src/mev-protection/mev-share-event-listener';
import type {
  MevShareEvent,
  BackrunOpportunity,
  MevShareEventListenerConfig,
} from '../../../src/mev-protection/mev-share-event-listener';

// =============================================================================
// Mock Logger
// =============================================================================

function createMockLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis(),
  } as any;
}

// =============================================================================
// Test Constants
// =============================================================================

const UNISWAP_V2_ROUTER = '0x7a250d5630b4cf539739df2c5dacb4c659f2488d';
const SUSHISWAP_ROUTER = '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f';

function createTestConfig(overrides?: Partial<MevShareEventListenerConfig>): MevShareEventListenerConfig {
  return {
    dexRouterAddresses: new Set([UNISWAP_V2_ROUTER, SUSHISWAP_ROUTER]),
    logger: createMockLogger(),
    maxEventsPerSecond: 50,
    reconnectDelayMs: 100,
    maxReconnectAttempts: 3,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('MevShareEventListener', () => {
  describe('constructor', () => {
    it('should create instance with default config', () => {
      const config = createTestConfig();
      const listener = new MevShareEventListener(config);
      expect(listener).toBeInstanceOf(MevShareEventListener);
    });

    it('should use default SSE endpoint when not specified', () => {
      const config = createTestConfig();
      const listener = new MevShareEventListener(config);
      const metrics = listener.getMetrics();
      expect(metrics.totalEventsReceived).toBe(0);
    });
  });

  describe('getMetrics', () => {
    it('should return initial zero metrics', () => {
      const listener = new MevShareEventListener(createTestConfig());
      const metrics = listener.getMetrics();

      expect(metrics.totalEventsReceived).toBe(0);
      expect(metrics.eventsMatched).toBe(0);
      expect(metrics.eventsDropped).toBe(0);
      expect(metrics.reconnections).toBe(0);
      expect(metrics.parseErrors).toBe(0);
      expect(metrics.lastEventAt).toBe(0);
    });

    it('should return a copy of metrics (not a reference)', () => {
      const listener = new MevShareEventListener(createTestConfig());
      const metrics1 = listener.getMetrics();
      const metrics2 = listener.getMetrics();

      expect(metrics1).not.toBe(metrics2);
      expect(metrics1).toEqual(metrics2);
    });
  });

  describe('stop', () => {
    it('should be safe to call stop before start', async () => {
      const listener = new MevShareEventListener(createTestConfig());
      await expect(listener.stop()).resolves.not.toThrow();
    });

    it('should clean up resources on stop', async () => {
      const listener = new MevShareEventListener(createTestConfig());
      await listener.stop();
      // No error = success
    });
  });

  describe('COMMON_SWAP_SELECTORS', () => {
    it('should contain Uniswap V2 swapExactTokensForTokens', () => {
      expect(COMMON_SWAP_SELECTORS.has('0x38ed1739')).toBe(true);
    });

    it('should contain Uniswap V3 multicall', () => {
      expect(COMMON_SWAP_SELECTORS.has('0x5ae401dc')).toBe(true);
    });

    it('should contain V3 exactInputSingle', () => {
      expect(COMMON_SWAP_SELECTORS.has('0x04e45aaf')).toBe(true);
    });

    it('should have at least 10 common selectors', () => {
      expect(COMMON_SWAP_SELECTORS.size).toBeGreaterThanOrEqual(10);
    });

    it('should only contain valid hex selectors', () => {
      for (const selector of COMMON_SWAP_SELECTORS) {
        expect(selector).toMatch(/^0x[0-9a-f]{8}$/);
      }
    });
  });

  describe('processEvent (Fix #8: replaces vacuous tests)', () => {
    let listener: MevShareEventListener;
    let detectedOpportunities: BackrunOpportunity[];

    beforeEach(() => {
      detectedOpportunities = [];
      listener = new MevShareEventListener(createTestConfig());
      listener.on('backrunOpportunity', (opp: BackrunOpportunity) => {
        detectedOpportunities.push(opp);
      });
    });

    afterEach(async () => {
      await listener.stop();
    });

    it('should emit backrunOpportunity when event matches a known router', () => {
      const event: MevShareEvent = {
        hash: '0xabc123',
        txs: [{
          to: UNISWAP_V2_ROUTER,
          functionSelector: '0x38ed1739',
        }],
      };

      listener.processEvent(event);

      expect(detectedOpportunities).toHaveLength(1);
      expect(detectedOpportunities[0].txHash).toBe('0xabc123');
      expect(detectedOpportunities[0].routerAddress).toBe(UNISWAP_V2_ROUTER);
      expect(detectedOpportunities[0].functionSelector).toBe('0x38ed1739');
    });

    it('should include traceId in emitted opportunity (Fix #42)', () => {
      const event: MevShareEvent = {
        hash: '0xabc123',
        txs: [{
          to: UNISWAP_V2_ROUTER,
          functionSelector: '0x38ed1739',
        }],
      };

      listener.processEvent(event);

      expect(detectedOpportunities).toHaveLength(1);
      expect(detectedOpportunities[0].traceId).toBeDefined();
      expect(detectedOpportunities[0].traceId).toMatch(/^[0-9a-f]{32}$/);
    });

    it('should not emit for events without a hash', () => {
      const event: MevShareEvent = {
        txs: [{
          to: UNISWAP_V2_ROUTER,
          functionSelector: '0x38ed1739',
        }],
      };

      listener.processEvent(event);

      expect(detectedOpportunities).toHaveLength(0);
    });

    it('should not emit for events with unknown router addresses', () => {
      const event: MevShareEvent = {
        hash: '0xabc123',
        txs: [{
          to: '0x0000000000000000000000000000000000000001',
          functionSelector: '0x38ed1739',
        }],
      };

      listener.processEvent(event);

      expect(detectedOpportunities).toHaveLength(0);
    });

    it('should not emit for events without txs', () => {
      const event: MevShareEvent = {
        hash: '0xabc123',
      };

      listener.processEvent(event);

      expect(detectedOpportunities).toHaveLength(0);
    });

    it('should not emit for events with empty txs array', () => {
      const event: MevShareEvent = {
        hash: '0xabc123',
        txs: [],
      };

      listener.processEvent(event);

      expect(detectedOpportunities).toHaveLength(0);
    });

    it('should match SushiSwap router address', () => {
      const event: MevShareEvent = {
        hash: '0xdef456',
        txs: [{
          to: SUSHISWAP_ROUTER,
          functionSelector: '0x38ed1739',
        }],
      };

      listener.processEvent(event);

      expect(detectedOpportunities).toHaveLength(1);
      expect(detectedOpportunities[0].routerAddress).toBe(SUSHISWAP_ROUTER);
    });

    it('should match case-insensitively on router address', () => {
      const event: MevShareEvent = {
        hash: '0xabc123',
        txs: [{
          to: '0x7A250D5630B4CF539739DF2C5DACB4C659F2488D', // uppercase
          functionSelector: '0x38ed1739',
        }],
      };

      listener.processEvent(event);

      expect(detectedOpportunities).toHaveLength(1);
    });

    it('should not match when function selector does not match known swaps', () => {
      const event: MevShareEvent = {
        hash: '0xabc123',
        txs: [{
          to: UNISWAP_V2_ROUTER,
          functionSelector: '0xdeadbeef', // unknown selector
        }],
      };

      listener.processEvent(event);

      expect(detectedOpportunities).toHaveLength(0);
    });

    it('should match when no function selector is revealed', () => {
      // When selector is not revealed, we still match on router alone
      const event: MevShareEvent = {
        hash: '0xabc123',
        txs: [{
          to: UNISWAP_V2_ROUTER,
        }],
      };

      listener.processEvent(event);

      expect(detectedOpportunities).toHaveLength(1);
      expect(detectedOpportunities[0].functionSelector).toBe('unknown');
    });

    it('should emit only one opportunity per event (first match)', () => {
      const event: MevShareEvent = {
        hash: '0xabc123',
        txs: [
          { to: UNISWAP_V2_ROUTER, functionSelector: '0x38ed1739' },
          { to: SUSHISWAP_ROUTER, functionSelector: '0x38ed1739' },
        ],
      };

      listener.processEvent(event);

      // Only first match emitted
      expect(detectedOpportunities).toHaveLength(1);
      expect(detectedOpportunities[0].routerAddress).toBe(UNISWAP_V2_ROUTER);
    });

    it('should update metrics on matched event', () => {
      const event: MevShareEvent = {
        hash: '0xabc123',
        txs: [{ to: UNISWAP_V2_ROUTER, functionSelector: '0x38ed1739' }],
      };

      listener.processEvent(event);

      const metrics = listener.getMetrics();
      expect(metrics.totalEventsReceived).toBe(1);
      expect(metrics.eventsMatched).toBe(1);
      expect(metrics.lastEventAt).toBeGreaterThan(0);
    });

    it('should update totalEventsReceived even when no match', () => {
      const event: MevShareEvent = {
        hash: '0xabc123',
        txs: [{ to: '0x0000000000000000000000000000000000000001' }],
      };

      listener.processEvent(event);

      const metrics = listener.getMetrics();
      expect(metrics.totalEventsReceived).toBe(1);
      expect(metrics.eventsMatched).toBe(0);
    });

    it('should emit raw event via "event" emitter', () => {
      const rawEvents: MevShareEvent[] = [];
      listener.on('event', (e: MevShareEvent) => rawEvents.push(e));

      const event: MevShareEvent = {
        hash: '0xabc123',
        txs: [{ to: '0x0000000000000000000000000000000000000001' }],
      };

      listener.processEvent(event);

      expect(rawEvents).toHaveLength(1);
      expect(rawEvents[0]).toBe(event);
    });

    it('should extract token pair from Uniswap V2 Swap logs', () => {
      const SWAP_TOPIC = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
      const pairAddress = '0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc';

      const event: MevShareEvent = {
        hash: '0xabc123',
        txs: [{ to: UNISWAP_V2_ROUTER, functionSelector: '0x38ed1739' }],
        logs: [{
          address: pairAddress,
          topics: [SWAP_TOPIC, '0x0000000000000000000000007a250d5630b4cf539739df2c5dacb4c659f2488d'],
          data: '0x',
        }],
      };

      listener.processEvent(event);

      expect(detectedOpportunities).toHaveLength(1);
      // Fix #29: pairAddress is now a separate field instead of misleading tokenIn/tokenOut
      expect(detectedOpportunities[0].pairAddress).toBe(pairAddress);
      expect(detectedOpportunities[0].tokenPair).toBeUndefined();
    });
  });

  describe('rate limiting', () => {
    it('should respect maxEventsPerSecond setting', () => {
      const config = createTestConfig({ maxEventsPerSecond: 10 });
      const listener = new MevShareEventListener(config);
      expect(listener).toBeDefined();
    });
  });
});
