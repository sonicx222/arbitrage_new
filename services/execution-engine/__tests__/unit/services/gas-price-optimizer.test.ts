/**
 * GasPriceOptimizer Unit Tests
 *
 * Tests gas price management, spike detection, baseline tracking, and EMA optimization.
 * Covers: chain-specific validation, fallback prices, spike detection thresholds,
 * EMA baseline updates, median caching, and pre-submission refresh.
 *
 * @see services/execution-engine/src/services/gas-price-optimizer.ts
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { ethers } from 'ethers';
import { createMockLogger } from '@arbitrage/test-utils';
import {
  GasPriceOptimizer,
  validateGasPrice,
  validateGasPriceConfiguration,
  getFallbackGasPrice,
  MIN_GAS_PRICE_GWEI,
  MAX_GAS_PRICE_GWEI,
  DEFAULT_GAS_PRICES_GWEI,
  WEI_PER_GWEI,
  type GasBaselineEntry,
} from '../../../src/services/gas-price-optimizer';

describe('validateGasPrice', () => {
  it('should return configured price when within valid range', () => {
    expect(validateGasPrice('ethereum', 50)).toBe(50);
    expect(validateGasPrice('arbitrum', 0.05)).toBe(0.05);
  });

  it('should clamp to minimum when below', () => {
    const result = validateGasPrice('ethereum', 0.001);
    expect(result).toBe(MIN_GAS_PRICE_GWEI['ethereum']); // 1 gwei minimum
  });

  it('should clamp to maximum when above', () => {
    const result = validateGasPrice('ethereum', 10000);
    expect(result).toBe(MAX_GAS_PRICE_GWEI['ethereum']); // 500 gwei maximum
  });

  it('should handle NaN by returning minimum', () => {
    const result = validateGasPrice('ethereum', NaN);
    expect(result).toBe(MIN_GAS_PRICE_GWEI['ethereum']);
  });

  it('should use defaults for unknown chains', () => {
    // Unknown chain uses default min=0.0001 and max=1000
    expect(validateGasPrice('unknown', 50)).toBe(50);
    expect(validateGasPrice('unknown', 0.00001)).toBe(0.0001);
  });

  it('should handle L2 chains with lower minimums', () => {
    expect(validateGasPrice('arbitrum', 0.005)).toBe(0.005);
    expect(validateGasPrice('optimism', 0.00005)).toBe(0.0001); // Clamped to min
    expect(validateGasPrice('base', 0.0001)).toBe(0.0001);
  });
});

describe('getFallbackGasPrice', () => {
  it('should return chain-specific fallback price', () => {
    const ethPrice = getFallbackGasPrice('ethereum');
    expect(ethPrice).toBeGreaterThan(0n);
  });

  it('should return default fallback for unknown chain', () => {
    const fallback = getFallbackGasPrice('unknown_chain');
    // Default is 50 gwei
    expect(fallback).toBe(ethers.parseUnits('50', 'gwei'));
  });

  it('should return different prices for different chains', () => {
    const ethPrice = getFallbackGasPrice('ethereum');
    const arbPrice = getFallbackGasPrice('arbitrum');
    // Ethereum and Arbitrum have very different gas prices
    expect(ethPrice).not.toBe(arbPrice);
  });
});

describe('validateGasPriceConfiguration', () => {
  it('should validate all chain configs', () => {
    const mockLogger = createMockLogger();
    const result = validateGasPriceConfiguration(mockLogger as any);

    expect(result.chainConfigs).toBeDefined();
    expect(Object.keys(result.chainConfigs).length).toBeGreaterThan(0);
  });

  it('should log validation summary', () => {
    const mockLogger = createMockLogger();
    validateGasPriceConfiguration(mockLogger as any);

    expect(mockLogger.info).toHaveBeenCalledWith(
      'Gas price configuration validated',
      expect.objectContaining({
        totalChains: expect.any(Number),
      })
    );
  });

  it('should track source (env vs default) for each chain', () => {
    const mockLogger = createMockLogger();
    const result = validateGasPriceConfiguration(mockLogger as any);

    for (const chainConfig of Object.values(result.chainConfigs)) {
      expect(['env', 'default']).toContain(chainConfig.source);
      expect(typeof chainConfig.configuredGwei).toBe('number');
      expect(typeof chainConfig.isMinimum).toBe('boolean');
      expect(typeof chainConfig.isMaximum).toBe('boolean');
    }
  });
});

describe('GasPriceOptimizer', () => {
  let optimizer: GasPriceOptimizer;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let gasBaselines: Map<string, GasBaselineEntry[]>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    optimizer = new GasPriceOptimizer(mockLogger as any);
    gasBaselines = new Map();
  });

  describe('constructor', () => {
    it('should accept custom configuration', () => {
      const customOptimizer = new GasPriceOptimizer(mockLogger as any, {
        maxGasHistory: 50,
        emaSmoothingFactor: 0.5,
      });

      expect(customOptimizer).toBeDefined();
    });

    it('should clamp invalid EMA smoothing factor', () => {
      const customOptimizer = new GasPriceOptimizer(mockLogger as any, {
        emaSmoothingFactor: 5.0, // Invalid - should clamp to 0.99
      });

      expect(customOptimizer).toBeDefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'EMA smoothing factor out of valid range, clamping',
        expect.any(Object)
      );
    });

    it('should handle NaN EMA smoothing factor', () => {
      const customOptimizer = new GasPriceOptimizer(mockLogger as any, {
        emaSmoothingFactor: NaN,
      });

      expect(customOptimizer).toBeDefined();
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('updateGasBaseline', () => {
    it('should initialize baseline array for new chain', () => {
      const price = ethers.parseUnits('50', 'gwei');
      optimizer.updateGasBaseline('ethereum', price, gasBaselines);

      expect(gasBaselines.has('ethereum')).toBe(true);
      expect(gasBaselines.get('ethereum')!.length).toBe(1);
    });

    it('should append price to existing baseline', () => {
      const price1 = ethers.parseUnits('50', 'gwei');
      const price2 = ethers.parseUnits('55', 'gwei');

      optimizer.updateGasBaseline('ethereum', price1, gasBaselines);
      optimizer.updateGasBaseline('ethereum', price2, gasBaselines);

      expect(gasBaselines.get('ethereum')!.length).toBe(2);
    });

    it('should update lastGasPrices map when provided', () => {
      const lastPrices = new Map<string, bigint>();
      const price = ethers.parseUnits('50', 'gwei');

      optimizer.updateGasBaseline('ethereum', price, gasBaselines, lastPrices);

      expect(lastPrices.get('ethereum')).toBe(price);
    });

    it('should update EMA baseline', () => {
      const price = ethers.parseUnits('50', 'gwei');
      optimizer.updateGasBaseline('ethereum', price, gasBaselines);

      const ema = optimizer.getEmaBaseline('ethereum');
      expect(ema).toBeDefined();
      expect(ema).toBe(price); // First price initializes EMA directly
    });

    it('should apply EMA smoothing on subsequent updates', () => {
      const price1 = ethers.parseUnits('50', 'gwei');
      const price2 = ethers.parseUnits('100', 'gwei');

      optimizer.updateGasBaseline('ethereum', price1, gasBaselines);
      optimizer.updateGasBaseline('ethereum', price2, gasBaselines);

      const ema = optimizer.getEmaBaseline('ethereum');
      // EMA should be between price1 and price2
      expect(ema!).toBeGreaterThan(price1);
      expect(ema!).toBeLessThan(price2);
    });

    it('should not update EMA for zero price', () => {
      optimizer.updateGasBaseline('ethereum', 0n, gasBaselines);
      expect(optimizer.getEmaBaseline('ethereum')).toBeUndefined();
    });

    it('should cap history length at maxGasHistory', () => {
      const customOptimizer = new GasPriceOptimizer(mockLogger as any, {
        maxGasHistory: 5,
      });

      for (let i = 0; i < 20; i++) {
        customOptimizer.updateGasBaseline(
          'ethereum',
          ethers.parseUnits(`${50 + i}`, 'gwei'),
          gasBaselines
        );
      }

      expect(gasBaselines.get('ethereum')!.length).toBeLessThanOrEqual(5);
    });
  });

  describe('getGasBaseline', () => {
    it('should return 0n for chain with no history', () => {
      const baseline = optimizer.getGasBaseline('unknown', gasBaselines);
      expect(baseline).toBe(0n);
    });

    it('should return EMA baseline when available', () => {
      const price = ethers.parseUnits('50', 'gwei');
      optimizer.updateGasBaseline('ethereum', price, gasBaselines);

      const baseline = optimizer.getGasBaseline('ethereum', gasBaselines);
      expect(baseline).toBe(price);
    });

    it('should use safety multiplier with fewer than 3 samples (when EMA cleared)', () => {
      const price = ethers.parseUnits('50', 'gwei');
      optimizer.updateGasBaseline('ethereum', price, gasBaselines);
      optimizer.resetEmaBaselines(); // Force fallback to median calculation

      const baseline = optimizer.getGasBaseline('ethereum', gasBaselines);
      // With 1 sample: avg * 5/2 = 2.5x
      expect(baseline).toBe(price * 5n / 2n);
    });

    it('should compute median for 3+ samples (when EMA cleared)', () => {
      const prices = [
        ethers.parseUnits('30', 'gwei'),
        ethers.parseUnits('50', 'gwei'),
        ethers.parseUnits('40', 'gwei'),
      ];

      for (const p of prices) {
        optimizer.updateGasBaseline('ethereum', p, gasBaselines);
      }

      optimizer.resetEmaBaselines();
      optimizer.resetMedianCache();

      const baseline = optimizer.getGasBaseline('ethereum', gasBaselines);
      // Sorted: 30, 40, 50 - median index=1 is 40 (midpoint of sorted array)
      expect(baseline).toBe(ethers.parseUnits('40', 'gwei'));
    });
  });

  describe('getOptimalGasPrice', () => {
    it('should return fallback price when no provider', async () => {
      const price = await optimizer.getOptimalGasPrice('ethereum', undefined, gasBaselines);
      expect(price).toBe(getFallbackGasPrice('ethereum'));
    });

    it('should return provider gas price when available', async () => {
      const expectedPrice = ethers.parseUnits('50', 'gwei');
      const mockProvider = {
        getFeeData: jest.fn<() => Promise<any>>().mockResolvedValue({
          maxFeePerGas: expectedPrice,
          gasPrice: expectedPrice,
        }),
      } as unknown as ethers.JsonRpcProvider;

      const price = await optimizer.getOptimalGasPrice('ethereum', mockProvider, gasBaselines);
      expect(price).toBe(expectedPrice);
    });

    it('should return fallback price on provider error', async () => {
      const mockProvider = {
        getFeeData: jest.fn<() => Promise<any>>().mockRejectedValue(new Error('RPC error')),
      } as unknown as ethers.JsonRpcProvider;

      const price = await optimizer.getOptimalGasPrice('ethereum', mockProvider, gasBaselines);
      expect(price).toBe(getFallbackGasPrice('ethereum'));
    });
  });

  describe('refreshGasPriceForSubmission', () => {
    it('should return previous price when no provider', async () => {
      const prevPrice = ethers.parseUnits('50', 'gwei');
      const result = await optimizer.refreshGasPriceForSubmission('ethereum', undefined, prevPrice);
      expect(result).toBe(prevPrice);
    });

    it('should return current price when no significant increase', async () => {
      const prevPrice = ethers.parseUnits('50', 'gwei');
      const currentPrice = ethers.parseUnits('55', 'gwei'); // 10% increase - OK

      const mockProvider = {
        getFeeData: jest.fn<() => Promise<any>>().mockResolvedValue({
          maxFeePerGas: currentPrice,
          gasPrice: currentPrice,
        }),
      } as unknown as ethers.JsonRpcProvider;

      const result = await optimizer.refreshGasPriceForSubmission('ethereum', mockProvider, prevPrice);
      expect(result).toBe(currentPrice);
    });

    it('should throw on >50% price increase', async () => {
      const prevPrice = ethers.parseUnits('50', 'gwei');
      const spikedPrice = ethers.parseUnits('80', 'gwei'); // 60% increase

      const mockProvider = {
        getFeeData: jest.fn<() => Promise<any>>().mockResolvedValue({
          maxFeePerGas: spikedPrice,
          gasPrice: spikedPrice,
        }),
      } as unknown as ethers.JsonRpcProvider;

      await expect(
        optimizer.refreshGasPriceForSubmission('ethereum', mockProvider, prevPrice)
      ).rejects.toThrow('[ERR_GAS_SPIKE]');
    });

    it('should log warning on >20% price increase', async () => {
      const prevPrice = ethers.parseUnits('50', 'gwei');
      const increasedPrice = ethers.parseUnits('65', 'gwei'); // 30% increase

      const mockProvider = {
        getFeeData: jest.fn<() => Promise<any>>().mockResolvedValue({
          maxFeePerGas: increasedPrice,
          gasPrice: increasedPrice,
        }),
      } as unknown as ethers.JsonRpcProvider;

      await optimizer.refreshGasPriceForSubmission('ethereum', mockProvider, prevPrice);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('[WARN_GAS_INCREASE]'),
        expect.any(Object)
      );
    });

    it('should return previous price on non-spike error', async () => {
      const prevPrice = ethers.parseUnits('50', 'gwei');

      const mockProvider = {
        getFeeData: jest.fn<() => Promise<any>>().mockRejectedValue(new Error('network error')),
      } as unknown as ethers.JsonRpcProvider;

      const result = await optimizer.refreshGasPriceForSubmission('ethereum', mockProvider, prevPrice);
      expect(result).toBe(prevPrice);
    });

    it('should return previous price when provider returns null fee data', async () => {
      const prevPrice = ethers.parseUnits('50', 'gwei');

      const mockProvider = {
        getFeeData: jest.fn<() => Promise<any>>().mockResolvedValue({
          maxFeePerGas: null,
          gasPrice: null,
        }),
      } as unknown as ethers.JsonRpcProvider;

      const result = await optimizer.refreshGasPriceForSubmission('ethereum', mockProvider, prevPrice);
      expect(result).toBe(prevPrice);
    });
  });

  describe('resetMedianCache', () => {
    it('should clear median cache and EMA baselines', () => {
      optimizer.updateGasBaseline('ethereum', ethers.parseUnits('50', 'gwei'), gasBaselines);
      expect(optimizer.getEmaBaseline('ethereum')).toBeDefined();

      optimizer.resetMedianCache();
      expect(optimizer.getEmaBaseline('ethereum')).toBeUndefined();
    });
  });

  describe('resetEmaBaselines', () => {
    it('should clear only EMA baselines', () => {
      optimizer.updateGasBaseline('ethereum', ethers.parseUnits('50', 'gwei'), gasBaselines);

      optimizer.resetEmaBaselines();
      expect(optimizer.getEmaBaseline('ethereum')).toBeUndefined();
      // Gas baselines should still exist
      expect(gasBaselines.get('ethereum')!.length).toBe(1);
    });
  });
});
