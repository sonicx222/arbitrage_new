/**
 * AMM Math Utilities Unit Tests
 *
 * Tests for the shared AMM constant-product formula and dynamic slippage
 * calculation functions. These are pure math utilities with no external
 * dependencies -- no mocking required.
 *
 * @see shared/core/src/utils/amm-math.ts
 */

import { describe, it, expect } from '@jest/globals';
import {
  calculateAmmAmountOut,
  calculateDynamicSlippage,
  PRECISION_MULTIPLIER,
  BASIS_POINTS_DIVISOR,
  ONE_ETH_WEI,
  DEFAULT_SLIPPAGE_CONFIG,
} from '../../../src/utils/amm-math';
import type { DynamicSlippageConfig } from '../../../src/utils/amm-math';

// =============================================================================
// Constants
// =============================================================================

describe('AMM Math Constants', () => {
  it('should export PRECISION_MULTIPLIER as 10n**18n', () => {
    expect(PRECISION_MULTIPLIER).toBe(10n ** 18n);
    expect(PRECISION_MULTIPLIER).toBe(1000000000000000000n);
  });

  it('should export BASIS_POINTS_DIVISOR as 10000n', () => {
    expect(BASIS_POINTS_DIVISOR).toBe(10000n);
  });

  it('should export ONE_ETH_WEI as 10n**18n', () => {
    expect(ONE_ETH_WEI).toBe(10n ** 18n);
    expect(ONE_ETH_WEI).toBe(PRECISION_MULTIPLIER);
  });
});

// =============================================================================
// calculateAmmAmountOut
// =============================================================================

describe('calculateAmmAmountOut', () => {
  // Realistic pool: 1000 ETH / 2M USDC
  const RESERVE_ETH = 1000n * 10n ** 18n;
  const RESERVE_USDC = 2_000_000n * 10n ** 6n;
  const FEE_30BPS = 30n; // 0.3% (standard Uniswap V2 fee)

  it('should calculate standard swap output correctly (1 ETH into 1000 ETH / 2M USDC pool at 0.3%)', () => {
    const amountIn = 10n ** 18n; // 1 ETH
    const result = calculateAmmAmountOut(amountIn, RESERVE_ETH, RESERVE_USDC, FEE_30BPS);

    // Expected: ~1992.01 USDC (1992013962 raw with 6 decimals)
    // Manual calculation:
    //   amountInWithFee = 1e18 * 9970 / 10000 = 997000000000000000
    //   numerator = 997000000000000000 * 2000000000000 = 1994000000000000000000000000000
    //   denominator = 1000000000000000000000 + 997000000000000000 = 1000997000000000000000
    //   result = 1994000000000000000000000000000 / 1000997000000000000000 = 1992013962
    expect(result).toBe(1992013962n);
  });

  it('should return full output with zero fee (0n)', () => {
    const amountIn = 10n ** 18n; // 1 ETH
    const result = calculateAmmAmountOut(amountIn, RESERVE_ETH, RESERVE_USDC, 0n);

    // Zero fee means amountInWithFee = amountIn exactly
    // result = (1e18 * 2e12) / (1000e18 + 1e18) = 2e30 / 1001e18 = 1998001998
    expect(result).toBe(1998001998n);

    // Zero-fee output should be strictly greater than 0.3%-fee output
    const resultWithFee = calculateAmmAmountOut(amountIn, RESERVE_ETH, RESERVE_USDC, FEE_30BPS);
    expect(result).toBeGreaterThan(resultWithFee!);
  });

  it('should return 0n when fee is 100% (10000n basis points)', () => {
    const amountIn = 10n ** 18n; // 1 ETH
    const result = calculateAmmAmountOut(amountIn, RESERVE_ETH, RESERVE_USDC, 10000n);

    // Fee = 10000 bps => feeMultiplierNumerator = 0 => amountInWithFee = 0
    // numerator = 0, denominator = reserveIn + 0 = reserveIn (> 0)
    // result = 0 / reserveIn = 0
    expect(result).toBe(0n);
  });

  it('should return null when denominator is zero (empty pool with 100% fee)', () => {
    // reserveIn = 0 and amountInWithFee = 0 (100% fee) => denominator = 0
    const result = calculateAmmAmountOut(10n ** 18n, 0n, RESERVE_USDC, 10000n);
    expect(result).toBeNull();
  });

  it('should return null when both reserves are zero and amountIn is zero', () => {
    const result = calculateAmmAmountOut(0n, 0n, 0n, FEE_30BPS);
    expect(result).toBeNull();
  });

  it('should handle 1 wei input without precision loss', () => {
    const result = calculateAmmAmountOut(1n, RESERVE_ETH, RESERVE_USDC, FEE_30BPS);

    // 1 wei * 9970 / 10000 = 0 (integer division truncation)
    // numerator = 0, denominator = reserveIn + 0 = reserveIn
    // Since amountInWithFee rounds to 0 for 1 wei, output is 0
    expect(result).toBe(0n);
  });

  it('should produce output < input for a symmetric pool due to fee', () => {
    const reserve = 1000n * 10n ** 18n;
    const amountIn = 10n * 10n ** 18n;

    const result = calculateAmmAmountOut(amountIn, reserve, reserve, FEE_30BPS);

    // In a symmetric pool, output must be less than input because of:
    // 1) The fee deduction (0.3%)
    // 2) The constant-product price impact
    expect(result).not.toBeNull();
    expect(result!).toBeLessThan(amountIn);

    // Verify exact value: 9871580343970612988
    expect(result).toBe(9871580343970612988n);
  });

  it('should handle very large reserves without overflow (100K ETH pool)', () => {
    const largeReserveIn = 100_000n * 10n ** 18n;
    const largeReserveOut = 200_000_000n * 10n ** 6n; // 200M USDC
    const amountIn = 100n * 10n ** 18n; // 100 ETH

    const result = calculateAmmAmountOut(amountIn, largeReserveIn, largeReserveOut, FEE_30BPS);

    // Should not overflow and should produce a reasonable value
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(0n);

    // ~199201.40 USDC (199201396207 raw at 6 decimals)
    expect(result).toBe(199201396207n);
  });

  it('should handle zero reserveIn with non-zero amountIn and sub-100% fee', () => {
    // reserveIn = 0, but amountInWithFee > 0 => denominator = amountInWithFee (non-zero)
    // numerator = amountInWithFee * reserveOut
    // result = reserveOut (approximately, since denominator = amountInWithFee)
    const amountIn = 10n ** 18n;
    const reserveOut = 2_000_000n * 10n ** 6n;
    const result = calculateAmmAmountOut(amountIn, 0n, reserveOut, FEE_30BPS);

    // denominator = 0 + amountInWithFee = 997000000000000000
    // numerator = 997000000000000000 * 2000000000000 = 1994000000000000000000000000000
    // result = 1994000000000000000000000000000 / 997000000000000000 = 2000000000000 = reserveOut
    expect(result).not.toBeNull();
    expect(result).toBe(reserveOut);
  });

  it('should return 0n when amountIn is 0', () => {
    const result = calculateAmmAmountOut(0n, RESERVE_ETH, RESERVE_USDC, FEE_30BPS);

    // amountInWithFee = 0, numerator = 0, denominator = reserveIn
    // result = 0 / reserveIn = 0
    expect(result).toBe(0n);
  });

  it('should increase output proportionally with lower fee', () => {
    const amountIn = 10n ** 18n;

    const resultHighFee = calculateAmmAmountOut(amountIn, RESERVE_ETH, RESERVE_USDC, 100n); // 1%
    const resultLowFee = calculateAmmAmountOut(amountIn, RESERVE_ETH, RESERVE_USDC, 10n);  // 0.1%

    expect(resultHighFee).not.toBeNull();
    expect(resultLowFee).not.toBeNull();
    expect(resultLowFee!).toBeGreaterThan(resultHighFee!);
  });
});

// =============================================================================
// calculateDynamicSlippage
// =============================================================================

describe('calculateDynamicSlippage', () => {
  it('should return baseSlippage when tradeSize is 0', () => {
    const result = calculateDynamicSlippage(0, 1000);

    // tradeSize=0 => priceImpact = 0/(1000+0) * 5 = 0
    // No liquidity penalty (liquidityUsd defaults to 0, fails > 0 check)
    // slippage = baseSlippage = 0.003
    expect(result).toBeCloseTo(0.003, 6);
  });

  it('should return near-baseSlippage for a small trade relative to reserves', () => {
    const result = calculateDynamicSlippage(1, 100_000);

    // priceImpact = 1/(100000+1) * 5 = ~0.00005
    // total = 0.003 + 0.00005 = ~0.00305
    expect(result).toBeCloseTo(0.00305, 4);
    // Should be very close to baseSlippage
    expect(result).toBeGreaterThan(DEFAULT_SLIPPAGE_CONFIG.baseSlippage);
    expect(result).toBeLessThan(DEFAULT_SLIPPAGE_CONFIG.baseSlippage + 0.001);
  });

  it('should produce higher slippage for large trades (price impact dominates)', () => {
    const result = calculateDynamicSlippage(10_000, 1_000);

    // priceImpact = 10000/(1000+10000) * 5 = 0.9091 * 5 = 4.5454
    // total = 0.003 + 4.5454 = 4.5484 => capped at maxSlippage = 0.10
    expect(result).toBeCloseTo(0.10, 6);
  });

  it('should compute priceImpact = 0.5 * priceImpactScale when trade equals reserves', () => {
    const reserveIn = 1000;
    const result = calculateDynamicSlippage(reserveIn, reserveIn);

    // priceImpact = 1000/(1000+1000) * 5 = 0.5 * 5 = 2.5
    // total = 0.003 + 2.5 = 2.503 => capped at 0.10
    expect(result).toBeCloseTo(0.10, 6);
  });

  it('should cap at maxSlippage when price impact would exceed it', () => {
    const result = calculateDynamicSlippage(100_000, 100);

    // priceImpact = 100000/(100+100000) * 5 = 0.999 * 5 = 4.995
    // total = 0.003 + 4.995 = 4.998 => capped at 0.10
    expect(result).toBe(DEFAULT_SLIPPAGE_CONFIG.maxSlippage);
  });

  it('should add liquidity penalty when liquidityUsd < minLiquidityUsd', () => {
    const result = calculateDynamicSlippage(100, 10_000, 50_000);

    // priceImpact = 100/(10000+100) * 5 = 0.0099 * 5 = 0.04950
    // liquidityRatio = 50000/100000 = 0.5
    // penalty = (1 - 0.5) * 2.0 * 0.01 = 0.5 * 0.02 = 0.01
    // total = 0.003 + 0.04950 + 0.01 = 0.06250
    expect(result).toBeCloseTo(0.06250, 4);
  });

  it('should not add penalty when liquidityUsd >= minLiquidityUsd', () => {
    const resultHighLiq = calculateDynamicSlippage(100, 10_000, 200_000);
    const resultExactMin = calculateDynamicSlippage(100, 10_000, 100_000);

    // priceImpact = 100/(10000+100) * 5 = ~0.04950
    // No liquidity penalty (>= minLiquidityUsd)
    const expectedBase = 0.003 + 100 / (10_000 + 100) * 5.0;

    expect(resultHighLiq).toBeCloseTo(expectedBase, 6);
    expect(resultExactMin).toBeCloseTo(expectedBase, 6);
  });

  it('should not add penalty when liquidityUsd is 0 (default parameter)', () => {
    const resultNoLiq = calculateDynamicSlippage(100, 10_000);
    const resultZeroLiq = calculateDynamicSlippage(100, 10_000, 0);

    // liquidityUsd = 0 => fails the > 0 check => no penalty
    const expectedBase = 0.003 + 100 / (10_000 + 100) * 5.0;
    expect(resultNoLiq).toBeCloseTo(expectedBase, 6);
    expect(resultZeroLiq).toBeCloseTo(expectedBase, 6);
    expect(resultNoLiq).toBeCloseTo(resultZeroLiq, 6);
  });

  it('should not include priceImpact when reserveIn is 0', () => {
    // reserveIn = 0 => skips price impact block
    // With liquidity penalty
    const result = calculateDynamicSlippage(1000, 0, 50_000);

    // priceImpact = 0 (skipped)
    // liquidityRatio = 50000/100000 = 0.5
    // penalty = (1 - 0.5) * 2.0 * 0.01 = 0.01
    // total = 0.003 + 0.01 = 0.013
    expect(result).toBeCloseTo(0.013, 6);
  });

  it('should use custom config values when provided', () => {
    const customConfig: DynamicSlippageConfig = {
      baseSlippage: 0.01,
      priceImpactScale: 2.0,
      maxSlippage: 0.05,
      minLiquidityUsd: 50_000,
      liquidityPenaltyScale: 3.0,
    };

    // With a moderate trade
    const result = calculateDynamicSlippage(500, 10_000, 25_000, customConfig);

    // priceImpact = 500/(10000+500) * 2.0 = 0.04762 * 2 = 0.09524
    // liquidityRatio = 25000/50000 = 0.5
    // penalty = (1 - 0.5) * 3.0 * 0.01 = 0.015
    // total = 0.01 + 0.09524 + 0.015 = 0.12024 => capped at 0.05
    expect(result).toBeCloseTo(0.05, 6);
  });

  it('should return baseSlippage when both reserveIn and tradeSize are 0', () => {
    const result = calculateDynamicSlippage(0, 0);

    // reserveIn = 0 => no price impact
    // tradeSize = 0 => even if reserveIn > 0, impact = 0
    // No liquidity penalty (liquidityUsd = 0 default)
    expect(result).toBeCloseTo(0.003, 6);
  });

  it('should scale penalty linearly with liquidity deficit', () => {
    // Low liquidity: 10K USD
    const resultLow = calculateDynamicSlippage(0, 0, 10_000);
    // Medium liquidity: 50K USD
    const resultMed = calculateDynamicSlippage(0, 0, 50_000);
    // Higher liquidity: 90K USD (still below 100K threshold)
    const resultHigh = calculateDynamicSlippage(0, 0, 90_000);

    // All should have only base + penalty (no price impact since reserveIn = 0)
    // Penalty decreases as liquidityUsd approaches minLiquidityUsd
    expect(resultLow).toBeGreaterThan(resultMed);
    expect(resultMed).toBeGreaterThan(resultHigh);

    // Verify specific penalty for 10K:
    // liquidityRatio = 10000/100000 = 0.1
    // penalty = (1-0.1) * 2.0 * 0.01 = 0.018
    // total = 0.003 + 0.018 = 0.021
    expect(resultLow).toBeCloseTo(0.021, 6);
  });
});

// =============================================================================
// DEFAULT_SLIPPAGE_CONFIG
// =============================================================================

describe('DEFAULT_SLIPPAGE_CONFIG', () => {
  it('should have the expected default values', () => {
    // These defaults may be overridden by env vars, but in a test environment
    // without those env vars set, they should match the hardcoded fallbacks
    expect(DEFAULT_SLIPPAGE_CONFIG.baseSlippage).toBeCloseTo(0.003, 6);
    expect(DEFAULT_SLIPPAGE_CONFIG.priceImpactScale).toBe(5.0);
    expect(DEFAULT_SLIPPAGE_CONFIG.maxSlippage).toBeCloseTo(0.10, 6);
    expect(DEFAULT_SLIPPAGE_CONFIG.minLiquidityUsd).toBe(100_000);
    expect(DEFAULT_SLIPPAGE_CONFIG.liquidityPenaltyScale).toBe(2.0);
  });

  it('should have all required DynamicSlippageConfig fields', () => {
    expect(DEFAULT_SLIPPAGE_CONFIG).toHaveProperty('baseSlippage');
    expect(DEFAULT_SLIPPAGE_CONFIG).toHaveProperty('priceImpactScale');
    expect(DEFAULT_SLIPPAGE_CONFIG).toHaveProperty('maxSlippage');
    expect(DEFAULT_SLIPPAGE_CONFIG).toHaveProperty('minLiquidityUsd');
    expect(DEFAULT_SLIPPAGE_CONFIG).toHaveProperty('liquidityPenaltyScale');
  });
});
