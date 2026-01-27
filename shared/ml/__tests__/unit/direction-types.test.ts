/**
 * Direction Types Tests
 *
 * FIX 8.1: Add missing test coverage for direction-types.ts
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  DirectionMapper,
  getDirectionMapper,
  priceToMarketDirection,
  marketToPriceDirection,
  isPriceDirectionAligned,
  isMarketDirectionAligned,
  type PriceDirection,
  type MarketDirection,
  type OpportunityDirection
} from '../../src/direction-types';

describe('direction-types', () => {
  beforeEach(() => {
    // Reset singleton between tests
    DirectionMapper.reset();
  });

  describe('DirectionMapper', () => {
    describe('getInstance', () => {
      it('should return singleton instance', () => {
        const instance1 = DirectionMapper.getInstance();
        const instance2 = DirectionMapper.getInstance();
        expect(instance1).toBe(instance2);
      });

      it('should create new instance after reset', () => {
        const instance1 = DirectionMapper.getInstance();
        DirectionMapper.reset();
        const instance2 = DirectionMapper.getInstance();
        expect(instance1).not.toBe(instance2);
      });
    });

    describe('priceToMarket', () => {
      it('should map up to bullish', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.priceToMarket('up')).toBe('bullish');
      });

      it('should map down to bearish', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.priceToMarket('down')).toBe('bearish');
      });

      it('should map sideways to neutral', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.priceToMarket('sideways')).toBe('neutral');
      });
    });

    describe('marketToPrice', () => {
      it('should map bullish to up', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.marketToPrice('bullish')).toBe('up');
      });

      it('should map bearish to down', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.marketToPrice('bearish')).toBe('down');
      });

      it('should map neutral to sideways', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.marketToPrice('neutral')).toBe('sideways');
      });
    });

    describe('priceToNumeric', () => {
      it('should convert up to 1', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.priceToNumeric('up')).toBe(1);
      });

      it('should convert down to -1', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.priceToNumeric('down')).toBe(-1);
      });

      it('should convert sideways to 0', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.priceToNumeric('sideways')).toBe(0);
      });
    });

    describe('marketToNumeric', () => {
      it('should convert bullish to 1', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.marketToNumeric('bullish')).toBe(1);
      });

      it('should convert bearish to -1', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.marketToNumeric('bearish')).toBe(-1);
      });

      it('should convert neutral to 0', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.marketToNumeric('neutral')).toBe(0);
      });
    });

    describe('numericToPrice', () => {
      it('should convert positive value to up', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.numericToPrice(0.5)).toBe('up');
        expect(mapper.numericToPrice(1)).toBe('up');
      });

      it('should convert negative value to down', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.numericToPrice(-0.5)).toBe('down');
        expect(mapper.numericToPrice(-1)).toBe('down');
      });

      it('should convert near-zero to sideways', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.numericToPrice(0)).toBe('sideways');
        expect(mapper.numericToPrice(0.05)).toBe('sideways');
        expect(mapper.numericToPrice(-0.05)).toBe('sideways');
      });

      it('should respect custom threshold', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.numericToPrice(0.3, 0.5)).toBe('sideways');
        expect(mapper.numericToPrice(0.6, 0.5)).toBe('up');
      });
    });

    describe('numericToMarket', () => {
      it('should convert positive value to bullish', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.numericToMarket(0.5)).toBe('bullish');
      });

      it('should convert negative value to bearish', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.numericToMarket(-0.5)).toBe('bearish');
      });

      it('should convert near-zero to neutral', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.numericToMarket(0.05)).toBe('neutral');
      });
    });

    describe('isPriceAligned', () => {
      it('should return true for up + buy', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.isPriceAligned('up', 'buy')).toBe(true);
      });

      it('should return false for up + sell', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.isPriceAligned('up', 'sell')).toBe(false);
      });

      it('should return true for down + sell', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.isPriceAligned('down', 'sell')).toBe(true);
      });

      it('should return false for down + buy', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.isPriceAligned('down', 'buy')).toBe(false);
      });

      it('should return true for sideways + any', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.isPriceAligned('sideways', 'buy')).toBe(true);
        expect(mapper.isPriceAligned('sideways', 'sell')).toBe(true);
      });
    });

    describe('isMarketAligned', () => {
      it('should return true for bullish + buy', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.isMarketAligned('bullish', 'buy')).toBe(true);
      });

      it('should return false for bullish + sell', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.isMarketAligned('bullish', 'sell')).toBe(false);
      });

      it('should return true for bearish + sell', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.isMarketAligned('bearish', 'sell')).toBe(true);
      });

      it('should return true for neutral + any', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.isMarketAligned('neutral', 'buy')).toBe(true);
        expect(mapper.isMarketAligned('neutral', 'sell')).toBe(true);
      });
    });

    describe('areDirectionsAligned', () => {
      it('should return true for same-sign directions', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.areDirectionsAligned('up', 'bullish')).toBe(true);
        expect(mapper.areDirectionsAligned('down', 'bearish')).toBe(true);
      });

      it('should return false for opposite-sign directions', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.areDirectionsAligned('up', 'bearish')).toBe(false);
        expect(mapper.areDirectionsAligned('down', 'bullish')).toBe(false);
      });

      it('should return true when either is neutral', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.areDirectionsAligned('sideways', 'bullish')).toBe(true);
        expect(mapper.areDirectionsAligned('up', 'neutral')).toBe(true);
        expect(mapper.areDirectionsAligned('sideways', 'neutral')).toBe(true);
      });
    });

    describe('type guards', () => {
      it('isPriceDirection should identify price directions', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.isPriceDirection('up')).toBe(true);
        expect(mapper.isPriceDirection('down')).toBe(true);
        expect(mapper.isPriceDirection('sideways')).toBe(true);
        expect(mapper.isPriceDirection('bullish')).toBe(false);
        expect(mapper.isPriceDirection('invalid')).toBe(false);
      });

      it('isMarketDirection should identify market directions', () => {
        const mapper = DirectionMapper.getInstance();
        expect(mapper.isMarketDirection('bullish')).toBe(true);
        expect(mapper.isMarketDirection('bearish')).toBe(true);
        expect(mapper.isMarketDirection('neutral')).toBe(true);
        expect(mapper.isMarketDirection('up')).toBe(false);
        expect(mapper.isMarketDirection('invalid')).toBe(false);
      });
    });
  });

  describe('convenience functions', () => {
    it('getDirectionMapper should return singleton', () => {
      const mapper1 = getDirectionMapper();
      const mapper2 = getDirectionMapper();
      expect(mapper1).toBe(mapper2);
    });

    it('priceToMarketDirection should convert correctly', () => {
      expect(priceToMarketDirection('up')).toBe('bullish');
      expect(priceToMarketDirection('down')).toBe('bearish');
      expect(priceToMarketDirection('sideways')).toBe('neutral');
    });

    it('marketToPriceDirection should convert correctly', () => {
      expect(marketToPriceDirection('bullish')).toBe('up');
      expect(marketToPriceDirection('bearish')).toBe('down');
      expect(marketToPriceDirection('neutral')).toBe('sideways');
    });

    it('isPriceDirectionAligned should check alignment', () => {
      expect(isPriceDirectionAligned('up', 'buy')).toBe(true);
      expect(isPriceDirectionAligned('up', 'sell')).toBe(false);
      expect(isPriceDirectionAligned('down', 'sell')).toBe(true);
    });

    it('isMarketDirectionAligned should check alignment', () => {
      expect(isMarketDirectionAligned('bullish', 'buy')).toBe(true);
      expect(isMarketDirectionAligned('bullish', 'sell')).toBe(false);
      expect(isMarketDirectionAligned('bearish', 'sell')).toBe(true);
    });
  });
});
