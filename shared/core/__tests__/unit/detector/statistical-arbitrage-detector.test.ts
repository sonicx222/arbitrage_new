/**
 * StatisticalArbitrageDetector Tests
 *
 * Tests the orchestration of correlation, spread, and regime detection
 * for statistical arbitrage opportunity generation.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.mock('../../../src/logger');

import { StatisticalArbitrageDetector } from '../../../src/detector/statistical-arbitrage-detector';
import type { PairCorrelationTracker } from '../../../src/analytics/pair-correlation-tracker';
import type { SpreadTracker, SpreadSignal, BollingerBands } from '../../../src/analytics/spread-tracker';
import type { RegimeDetector, Regime } from '../../../src/analytics/regime-detector';
import type { ArbitrageOpportunity } from '@arbitrage/types';

// =============================================================================
// Mock Factories
// =============================================================================

function createMockCorrelationTracker(overrides?: Partial<PairCorrelationTracker>): PairCorrelationTracker {
  return {
    addSample: jest.fn(),
    getCorrelation: jest.fn<() => number | undefined>().mockReturnValue(0.9),
    isEligible: jest.fn<() => boolean>().mockReturnValue(true),
    getEligiblePairs: jest.fn<() => string[]>().mockReturnValue([]),
    getSampleCount: jest.fn<() => number>().mockReturnValue(60),
    reset: jest.fn(),
    ...overrides,
  } as unknown as PairCorrelationTracker;
}

function createMockSpreadTracker(overrides?: Partial<SpreadTracker>): SpreadTracker {
  return {
    addSpread: jest.fn(),
    getSignal: jest.fn<() => SpreadSignal>().mockReturnValue('entry_long'),
    getBollingerBands: jest.fn<() => BollingerBands | undefined>().mockReturnValue({
      upper: 0.8,
      middle: 0.5,
      lower: 0.2,
      currentSpread: 0.1,
    }),
    getSpreadHistory: jest.fn<() => number[]>().mockReturnValue([]),
    reset: jest.fn(),
    ...overrides,
  } as unknown as SpreadTracker;
}

function createMockRegimeDetector(overrides?: Partial<RegimeDetector>): RegimeDetector {
  return {
    addSample: jest.fn(),
    getRegime: jest.fn<() => Regime>().mockReturnValue('mean_reverting'),
    getHurstExponent: jest.fn<() => number | undefined>().mockReturnValue(0.3),
    isFavorable: jest.fn<() => boolean>().mockReturnValue(true),
    reset: jest.fn(),
    ...overrides,
  } as unknown as RegimeDetector;
}

const DEFAULT_PAIRS = [
  {
    id: 'WETH-DAI',
    tokenA: '0xWETH',
    tokenB: '0xDAI',
    chains: ['ethereum'],
  },
  {
    id: 'WBTC-USDC',
    tokenA: '0xWBTC',
    tokenB: '0xUSDC',
    chains: ['arbitrum'],
  },
];

const DEFAULT_CONFIG = {
  pairs: DEFAULT_PAIRS,
  minCorrelation: 0.7,
  bollingerStdDev: 2.0,
  regimeWindowSize: 100,
};

describe('StatisticalArbitrageDetector', () => {
  let correlationTracker: PairCorrelationTracker;
  let spreadTracker: SpreadTracker;
  let regimeDetector: RegimeDetector;
  let detector: StatisticalArbitrageDetector;

  beforeEach(() => {
    correlationTracker = createMockCorrelationTracker();
    spreadTracker = createMockSpreadTracker();
    regimeDetector = createMockRegimeDetector();

    detector = new StatisticalArbitrageDetector(
      correlationTracker,
      spreadTracker,
      regimeDetector,
      DEFAULT_CONFIG,
    );
    detector.start();
  });

  // ===========================================================================
  // Emits Opportunity When All 3 Conditions Met
  // ===========================================================================

  describe('all conditions met', () => {
    it('should emit opportunity when spread signal + regime + correlation all pass', (done) => {
      detector.on('opportunity', (opp: ArbitrageOpportunity) => {
        expect(opp.type).toBe('statistical');
        expect(opp.chain).toBe('ethereum');
        expect(opp.confidence).toBeGreaterThan(0);
        expect(opp.id).toContain('stat-arb-WETH-DAI');
        done();
      });

      detector.onPriceUpdate('WETH-DAI', 2000, 1, Date.now());
    });

    it('should emit entry_long with correct token direction (buy A, sell B)', (done) => {
      // entry_long means A is cheap relative to B -> buy A (tokenOut), sell B (tokenIn)
      (spreadTracker.getSignal as jest.Mock).mockReturnValue('entry_long');

      detector.on('opportunity', (opp: ArbitrageOpportunity) => {
        expect(opp.tokenIn).toBe('0xDAI'); // Sell B
        expect(opp.tokenOut).toBe('0xWETH'); // Buy A
        done();
      });

      detector.onPriceUpdate('WETH-DAI', 2000, 1, Date.now());
    });

    it('should emit entry_short with correct token direction (sell A, buy B)', (done) => {
      (spreadTracker.getSignal as jest.Mock).mockReturnValue('entry_short');

      detector.on('opportunity', (opp: ArbitrageOpportunity) => {
        expect(opp.tokenIn).toBe('0xWETH'); // Sell A
        expect(opp.tokenOut).toBe('0xDAI'); // Buy B
        done();
      });

      detector.onPriceUpdate('WETH-DAI', 2000, 1, Date.now());
    });
  });

  // ===========================================================================
  // Does NOT Emit When Regime Is Trending
  // ===========================================================================

  describe('regime is trending', () => {
    it('should NOT emit opportunity when regime is trending', () => {
      (regimeDetector.isFavorable as jest.Mock).mockReturnValue(false);
      (regimeDetector.getRegime as jest.Mock).mockReturnValue('trending');

      const opportunityHandler = jest.fn();
      detector.on('opportunity', opportunityHandler);

      detector.onPriceUpdate('WETH-DAI', 2000, 1, Date.now());

      expect(opportunityHandler).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Does NOT Emit When Correlation Below Threshold
  // ===========================================================================

  describe('correlation below threshold', () => {
    it('should NOT emit opportunity when correlation is below threshold', () => {
      (correlationTracker.isEligible as jest.Mock).mockReturnValue(false);
      (correlationTracker.getCorrelation as jest.Mock).mockReturnValue(0.3);

      const opportunityHandler = jest.fn();
      detector.on('opportunity', opportunityHandler);

      detector.onPriceUpdate('WETH-DAI', 2000, 1, Date.now());

      expect(opportunityHandler).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Does NOT Emit When Spread Within Bands
  // ===========================================================================

  describe('spread within bands', () => {
    it('should NOT emit opportunity when spread signal is none', () => {
      (spreadTracker.getSignal as jest.Mock).mockReturnValue('none');

      const opportunityHandler = jest.fn();
      detector.on('opportunity', opportunityHandler);

      detector.onPriceUpdate('WETH-DAI', 2000, 1, Date.now());

      expect(opportunityHandler).not.toHaveBeenCalled();
    });

    it('should NOT emit opportunity when spread signal is exit', () => {
      (spreadTracker.getSignal as jest.Mock).mockReturnValue('exit');

      const opportunityHandler = jest.fn();
      detector.on('opportunity', opportunityHandler);

      detector.onPriceUpdate('WETH-DAI', 2000, 1, Date.now());

      expect(opportunityHandler).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Multiple Pairs Tracked Independently
  // ===========================================================================

  describe('multiple pairs tracked independently', () => {
    it('should only emit for the pair with the signal', () => {
      // Configure: WETH-DAI has signal, WBTC-USDC does not
      (spreadTracker.getSignal as jest.Mock).mockImplementation((...args: unknown[]) => {
        const pairId = args[0] as string;
        if (pairId === 'WETH-DAI') return 'entry_long';
        return 'none';
      });

      const opportunities: ArbitrageOpportunity[] = [];
      detector.on('opportunity', (opp: ArbitrageOpportunity) => {
        opportunities.push(opp);
      });

      detector.onPriceUpdate('WETH-DAI', 2000, 1, Date.now());
      detector.onPriceUpdate('WBTC-USDC', 40000, 1, Date.now());

      expect(opportunities).toHaveLength(1);
      expect(opportunities[0].id).toContain('WETH-DAI');
    });
  });

  // ===========================================================================
  // Feeds Data to All Components
  // ===========================================================================

  describe('data feeding', () => {
    it('should feed prices to correlation tracker', () => {
      const ts = Date.now();
      detector.onPriceUpdate('WETH-DAI', 2000, 1, ts);

      expect(correlationTracker.addSample).toHaveBeenCalledWith('WETH-DAI', 2000, 1, ts);
    });

    it('should feed prices to spread tracker', () => {
      detector.onPriceUpdate('WETH-DAI', 2000, 1, Date.now());

      expect(spreadTracker.addSpread).toHaveBeenCalledWith('WETH-DAI', 2000, 1);
    });

    it('should feed log-spread to regime detector', () => {
      detector.onPriceUpdate('WETH-DAI', 2000, 1, Date.now());

      expect(regimeDetector.addSample).toHaveBeenCalledWith(
        'WETH-DAI',
        expect.closeTo(Math.log(2000 / 1), 10),
      );
    });
  });

  // ===========================================================================
  // Start / Stop
  // ===========================================================================

  describe('start/stop', () => {
    it('should not process updates when stopped', () => {
      detector.stop();

      const opportunityHandler = jest.fn();
      detector.on('opportunity', opportunityHandler);

      detector.onPriceUpdate('WETH-DAI', 2000, 1, Date.now());

      expect(opportunityHandler).not.toHaveBeenCalled();
      expect(correlationTracker.addSample).not.toHaveBeenCalled();
    });

    it('should resume processing after start', (done) => {
      detector.stop();
      detector.start();

      detector.on('opportunity', () => {
        done();
      });

      detector.onPriceUpdate('WETH-DAI', 2000, 1, Date.now());
    });
  });

  // ===========================================================================
  // Active Signals
  // ===========================================================================

  describe('getActiveSignals', () => {
    it('should return current signals for monitored pairs', () => {
      (spreadTracker.getSignal as jest.Mock)
        .mockReturnValueOnce('entry_long')
        .mockReturnValueOnce('none');

      detector.onPriceUpdate('WETH-DAI', 2000, 1, Date.now());
      detector.onPriceUpdate('WBTC-USDC', 40000, 1, Date.now());

      const signals = detector.getActiveSignals();
      expect(signals.get('WETH-DAI')).toBe('entry_long');
      expect(signals.get('WBTC-USDC')).toBe('none');
    });

    it('should be cleared on stop', () => {
      detector.onPriceUpdate('WETH-DAI', 2000, 1, Date.now());
      detector.stop();

      const signals = detector.getActiveSignals();
      expect(signals.size).toBe(0);
    });
  });

  // ===========================================================================
  // Unconfigured Pair
  // ===========================================================================

  describe('unconfigured pair', () => {
    it('should not emit for pairs not in config', () => {
      const opportunityHandler = jest.fn();
      detector.on('opportunity', opportunityHandler);

      detector.onPriceUpdate('UNKNOWN-PAIR', 100, 50, Date.now());

      expect(opportunityHandler).not.toHaveBeenCalled();
    });
  });
});
