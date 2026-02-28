/**
 * Tests for Token Staleness Detection
 *
 * @see tokens/index.ts
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import {
  checkFallbackPriceStaleness,
  getFallbackPriceAgeDays,
  checkNativeTokenPriceStaleness,
  hasKnownDecimals,
  FALLBACK_PRICES_LAST_UPDATED,
  FALLBACK_PRICES_STALENESS_WARNING_DAYS,
} from '../../src/tokens';

describe('Token Staleness Detection', () => {
  describe('getFallbackPriceAgeDays', () => {
    it('should return a non-negative number', () => {
      const ageDays = getFallbackPriceAgeDays();
      expect(typeof ageDays).toBe('number');
      expect(ageDays).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(ageDays)).toBe(true);
    });

    it('should calculate age based on FALLBACK_PRICES_LAST_UPDATED', () => {
      const lastUpdated = new Date(FALLBACK_PRICES_LAST_UPDATED).getTime();
      const now = Date.now();
      const expectedAgeDays = Math.floor((now - lastUpdated) / (1000 * 60 * 60 * 24));

      const ageDays = getFallbackPriceAgeDays();
      expect(ageDays).toBe(expectedAgeDays);
    });
  });

  describe('checkFallbackPriceStaleness', () => {
    let mockLogger: jest.Mock;
    let dateNowSpy: jest.SpyInstance;

    beforeEach(() => {
      mockLogger = jest.fn();
    });

    afterEach(() => {
      dateNowSpy?.mockRestore();
    });

    it('should return false when prices are fresh (within staleness threshold)', () => {
      // Mock Date.now to be 3 days after last update (within 7-day threshold)
      const lastUpdated = new Date(FALLBACK_PRICES_LAST_UPDATED).getTime();
      const mockNow = lastUpdated + (3 * 24 * 60 * 60 * 1000); // 3 days later
      dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(mockNow);

      const isStale = checkFallbackPriceStaleness(mockLogger);

      expect(isStale).toBe(false);
      expect(mockLogger).not.toHaveBeenCalled();
    });

    it('should return true when prices are stale (beyond staleness threshold)', () => {
      // Mock Date.now to be 10 days after last update (beyond 7-day threshold)
      const lastUpdated = new Date(FALLBACK_PRICES_LAST_UPDATED).getTime();
      const mockNow = lastUpdated + (10 * 24 * 60 * 60 * 1000); // 10 days later
      dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(mockNow);

      const isStale = checkFallbackPriceStaleness(mockLogger);

      expect(isStale).toBe(true);
      expect(mockLogger).toHaveBeenCalledTimes(1);
    });

    it('should call logger with warning message when stale', () => {
      // Mock Date.now to be 15 days after last update
      const lastUpdated = new Date(FALLBACK_PRICES_LAST_UPDATED).getTime();
      const mockNow = lastUpdated + (15 * 24 * 60 * 60 * 1000); // 15 days later
      dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(mockNow);

      checkFallbackPriceStaleness(mockLogger);

      expect(mockLogger).toHaveBeenCalledWith(
        expect.stringContaining('[STALE_FALLBACK_PRICES]'),
        expect.objectContaining({
          lastUpdated: FALLBACK_PRICES_LAST_UPDATED,
          ageDays: 15,
          stalenessThresholdDays: FALLBACK_PRICES_STALENESS_WARNING_DAYS
        })
      );
    });

    it('should not call logger when fresh', () => {
      // Mock Date.now to be 1 day after last update
      const lastUpdated = new Date(FALLBACK_PRICES_LAST_UPDATED).getTime();
      const mockNow = lastUpdated + (1 * 24 * 60 * 60 * 1000); // 1 day later
      dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(mockNow);

      checkFallbackPriceStaleness(mockLogger);

      expect(mockLogger).not.toHaveBeenCalled();
    });

    it('should use console.warn by default when no logger provided', () => {
      // Mock Date.now to be 10 days after last update
      const lastUpdated = new Date(FALLBACK_PRICES_LAST_UPDATED).getTime();
      const mockNow = lastUpdated + (10 * 24 * 60 * 60 * 1000); // 10 days later
      dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(mockNow);

      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      checkFallbackPriceStaleness();

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[STALE_FALLBACK_PRICES]'),
        expect.any(Object)
      );

      consoleWarnSpy.mockRestore();
    });

    it('should return true exactly at staleness threshold boundary', () => {
      // Mock Date.now to be exactly FALLBACK_PRICES_STALENESS_WARNING_DAYS + 1 days after last update
      const lastUpdated = new Date(FALLBACK_PRICES_LAST_UPDATED).getTime();
      const mockNow = lastUpdated + ((FALLBACK_PRICES_STALENESS_WARNING_DAYS + 1) * 24 * 60 * 60 * 1000);
      dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(mockNow);

      const isStale = checkFallbackPriceStaleness(mockLogger);

      expect(isStale).toBe(true);
      expect(mockLogger).toHaveBeenCalledTimes(1);
    });

    it('should return false exactly at staleness threshold (not beyond)', () => {
      // Mock Date.now to be exactly FALLBACK_PRICES_STALENESS_WARNING_DAYS days after last update
      const lastUpdated = new Date(FALLBACK_PRICES_LAST_UPDATED).getTime();
      const mockNow = lastUpdated + (FALLBACK_PRICES_STALENESS_WARNING_DAYS * 24 * 60 * 60 * 1000);
      dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(mockNow);

      const isStale = checkFallbackPriceStaleness(mockLogger);

      expect(isStale).toBe(false);
      expect(mockLogger).not.toHaveBeenCalled();
    });
  });

  describe('checkNativeTokenPriceStaleness', () => {
    it('should return an object with required properties', () => {
      const result = checkNativeTokenPriceStaleness();

      expect(result).toHaveProperty('isStale');
      expect(result).toHaveProperty('ageDays');
      expect(result).toHaveProperty('lastUpdated');
      expect(result).toHaveProperty('recommendation');

      expect(typeof result.isStale).toBe('boolean');
      expect(typeof result.ageDays).toBe('number');
      expect(typeof result.lastUpdated).toBe('string');
      expect(typeof result.recommendation).toBe('string');
    });

    it('should return non-negative ageDays', () => {
      const result = checkNativeTokenPriceStaleness();

      expect(result.ageDays).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(result.ageDays)).toBe(true);
    });

    it('should return correct lastUpdated value', () => {
      const result = checkNativeTokenPriceStaleness();

      expect(result.lastUpdated).toBe('2026-02-23');
    });

    it('should return isStale=false when prices are fresh', () => {
      const result = checkNativeTokenPriceStaleness();

      // Since NATIVE_TOKEN_PRICE_METADATA.lastUpdated is '2026-02-23' and test date is 2026-02-28,
      // that's 5 days, which is within the 7-day threshold
      expect(result.isStale).toBe(false);
      expect(result.recommendation).toContain('Prices are current');
    });

    it('should provide appropriate recommendation based on staleness', () => {
      const result = checkNativeTokenPriceStaleness();

      if (result.isStale) {
        expect(result.recommendation).toContain('NATIVE_TOKEN_PRICES are');
        expect(result.recommendation).toContain('days old');
        expect(result.recommendation).toContain('Update prices');
      } else {
        expect(result.recommendation).toContain('Prices are current');
        expect(result.recommendation).toContain('max');
        expect(result.recommendation).toContain('days');
      }
    });
  });

  describe('hasKnownDecimals', () => {
    it('should return true for known WETH on Ethereum', () => {
      // WETH on Ethereum mainnet
      const result = hasKnownDecimals('ethereum', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
      expect(result).toBe(true);
    });

    it('should return true for known token with case-insensitive chain name', () => {
      // Test case insensitivity
      const result = hasKnownDecimals('ETHEREUM', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
      expect(result).toBe(true);
    });

    it('should return true for known token with case-insensitive address', () => {
      // Test case insensitivity for address
      const result = hasKnownDecimals('ethereum', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
      expect(result).toBe(true);
    });

    it('should return false for unknown address on Ethereum', () => {
      const result = hasKnownDecimals('ethereum', '0x0000000000000000000000000000000000000000');
      expect(result).toBe(false);
    });

    it('should return false for unknown chain', () => {
      const result = hasKnownDecimals('unknownchain', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
      expect(result).toBe(false);
    });

    it('should return false for random address', () => {
      const result = hasKnownDecimals('ethereum', '0x1234567890123456789012345678901234567890');
      expect(result).toBe(false);
    });

    it('should return true for known USDC on Ethereum', () => {
      // USDC on Ethereum mainnet
      const result = hasKnownDecimals('ethereum', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
      expect(result).toBe(true);
    });

    it('should return true for known token on BSC', () => {
      // WBNB on BSC
      const result = hasKnownDecimals('bsc', '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c');
      expect(result).toBe(true);
    });

    it('should return true for known token on Polygon', () => {
      // WMATIC on Polygon
      const result = hasKnownDecimals('polygon', '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270');
      expect(result).toBe(true);
    });
  });
});
