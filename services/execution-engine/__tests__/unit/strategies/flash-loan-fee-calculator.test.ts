/**
 * FlashLoanFeeCalculator Unit Tests
 *
 * Tests fee calculation and profitability analysis for flash loan execution.
 * Covers: chain-specific fees, custom overrides, profitability recommendations.
 *
 * @see services/execution-engine/src/strategies/flash-loan-fee-calculator.ts
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { ethers } from 'ethers';
import {
  FlashLoanFeeCalculator,
  createFlashLoanFeeCalculator,
  type ProfitabilityParams,
  type ProfitabilityAnalysis,
} from '../../../src/strategies/flash-loan-fee-calculator';

describe('FlashLoanFeeCalculator', () => {
  let calculator: FlashLoanFeeCalculator;

  beforeEach(() => {
    calculator = new FlashLoanFeeCalculator();
  });

  describe('calculateFlashLoanFee', () => {
    it('should calculate default Aave V3 fee (9 bps) for unknown chain', () => {
      const amount = ethers.parseEther('100');
      const fee = calculator.calculateFlashLoanFee(amount, 'unknown_chain');

      // 9 bps = 0.09% of 100 ETH = 0.09 ETH
      const expectedFee = ethers.parseEther('0.09');
      expect(fee).toBe(expectedFee);
    });

    it('should use chain-specific fee from FLASH_LOAN_PROVIDERS config', () => {
      const amount = ethers.parseEther('100');

      // Fee for 'ethereum' comes from FLASH_LOAN_PROVIDERS config
      const fee = calculator.calculateFlashLoanFee(amount, 'ethereum');

      // Should be > 0 (exact value depends on FLASH_LOAN_PROVIDERS config)
      expect(fee).toBeGreaterThan(0n);
    });

    it('should use custom fee override when configured', () => {
      const customCalculator = new FlashLoanFeeCalculator({
        feeOverrides: { 'custom_chain': 50 }, // 50 bps = 0.5%
      });

      const amount = ethers.parseEther('100');
      const fee = customCalculator.calculateFlashLoanFee(amount, 'custom_chain');

      // 50 bps = 0.5% of 100 ETH = 0.5 ETH
      const expectedFee = ethers.parseEther('0.5');
      expect(fee).toBe(expectedFee);
    });

    it('should prioritize fee override over chain config', () => {
      const customCalculator = new FlashLoanFeeCalculator({
        feeOverrides: { 'ethereum': 20 }, // Override Ethereum fee to 20 bps
      });

      const amount = ethers.parseEther('1000');
      const fee = customCalculator.calculateFlashLoanFee(amount, 'ethereum');

      // 20 bps = 0.2% of 1000 ETH = 2 ETH
      const expectedFee = ethers.parseEther('2');
      expect(fee).toBe(expectedFee);
    });

    it('should handle zero amount', () => {
      const fee = calculator.calculateFlashLoanFee(0n, 'ethereum');
      expect(fee).toBe(0n);
    });

    it('should handle very large amounts without overflow', () => {
      // 1 million ETH
      const amount = ethers.parseEther('1000000');
      const fee = calculator.calculateFlashLoanFee(amount, 'ethereum');

      expect(fee).toBeGreaterThan(0n);
      expect(fee).toBeLessThan(amount); // Fee should be less than principal
    });

    it('should handle fee override of 0 (free flash loan)', () => {
      const customCalculator = new FlashLoanFeeCalculator({
        feeOverrides: { 'balancer': 0 }, // Balancer has 0 fee
      });

      const amount = ethers.parseEther('100');
      const fee = customCalculator.calculateFlashLoanFee(amount, 'balancer');

      expect(fee).toBe(0n);
    });
  });

  describe('analyzeProfitability', () => {
    const baseParams: ProfitabilityParams = {
      expectedProfitUsd: 100,
      flashLoanAmountWei: ethers.parseEther('10'),
      estimatedGasUnits: 500000n,
      gasPriceWei: ethers.parseUnits('30', 'gwei'),
      chain: 'ethereum',
      ethPriceUsd: 2000,
    };

    it('should return profitable analysis when profit exceeds costs', () => {
      const analysis = calculator.analyzeProfitability(baseParams);

      expect(analysis.isProfitable).toBe(true);
      expect(analysis.netProfitUsd).toBeGreaterThan(0);
      expect(analysis.recommendation).not.toBe('skip');
    });

    it('should recommend skip when not profitable', () => {
      const unprofitableParams: ProfitabilityParams = {
        ...baseParams,
        expectedProfitUsd: 0.001, // Tiny profit, less than gas + fees
      };

      const analysis = calculator.analyzeProfitability(unprofitableParams);

      expect(analysis.isProfitable).toBe(false);
      expect(analysis.recommendation).toBe('skip');
    });

    it('should recommend direct execution when user has capital and it is more profitable', () => {
      const directParams: ProfitabilityParams = {
        ...baseParams,
        userCapitalWei: ethers.parseEther('100'), // User has enough capital
      };

      const analysis = calculator.analyzeProfitability(directParams);

      // Direct execution saves the flash loan fee, so should be recommended
      // when user has enough capital
      if (analysis.isProfitable) {
        expect(analysis.recommendation).toBe('direct');
        expect(analysis.directExecutionNetProfit).toBeGreaterThan(analysis.flashLoanNetProfit);
      }
    });

    it('should recommend flash-loan when user lacks capital', () => {
      const params: ProfitabilityParams = {
        ...baseParams,
        userCapitalWei: ethers.parseEther('1'), // Not enough capital
      };

      const analysis = calculator.analyzeProfitability(params);

      if (analysis.isProfitable) {
        expect(analysis.recommendation).toBe('flash-loan');
      }
    });

    it('should recommend flash-loan when no user capital specified', () => {
      const analysis = calculator.analyzeProfitability(baseParams);

      if (analysis.isProfitable) {
        expect(analysis.recommendation).toBe('flash-loan');
      }
    });

    it('should calculate breakdown correctly', () => {
      const analysis = calculator.analyzeProfitability(baseParams);

      expect(analysis.breakdown.expectedProfit).toBe(baseParams.expectedProfitUsd);
      expect(analysis.breakdown.flashLoanFee).toBeGreaterThanOrEqual(0);
      expect(analysis.breakdown.gasCost).toBeGreaterThan(0);
      expect(analysis.breakdown.totalCosts).toBe(
        analysis.breakdown.flashLoanFee + analysis.breakdown.gasCost
      );
    });

    it('should calculate gas cost correctly', () => {
      const analysis = calculator.analyzeProfitability(baseParams);

      // Gas cost = estimatedGasUnits * gasPriceWei in ETH * ethPriceUsd
      // 500000 * 30 gwei = 15,000,000 gwei = 0.015 ETH
      // 0.015 ETH * $2000 = $30
      expect(analysis.gasCostUsd).toBeCloseTo(30, 0);
    });

    it('should handle zero expected profit', () => {
      const params: ProfitabilityParams = {
        ...baseParams,
        expectedProfitUsd: 0,
      };

      const analysis = calculator.analyzeProfitability(params);

      expect(analysis.isProfitable).toBe(false);
      expect(analysis.recommendation).toBe('skip');
    });

    it('should handle zero gas price', () => {
      const params: ProfitabilityParams = {
        ...baseParams,
        gasPriceWei: 0n,
      };

      const analysis = calculator.analyzeProfitability(params);

      expect(analysis.gasCostUsd).toBe(0);
    });
  });

  describe('getConfig', () => {
    it('should return a shallow copy of the config', () => {
      const customCalculator = new FlashLoanFeeCalculator({
        feeOverrides: { 'ethereum': 15 },
      });

      const config = customCalculator.getConfig();
      expect(config.feeOverrides).toEqual({ 'ethereum': 15 });

      // getConfig returns a shallow copy - top-level object is new
      const config2 = customCalculator.getConfig();
      expect(config).not.toBe(config2); // Different top-level objects
    });

    it('should return empty config when created with defaults', () => {
      const config = calculator.getConfig();
      expect(config).toEqual({});
    });
  });

  describe('createFlashLoanFeeCalculator factory', () => {
    it('should create calculator with default config', () => {
      const calc = createFlashLoanFeeCalculator();
      expect(calc).toBeInstanceOf(FlashLoanFeeCalculator);
    });

    it('should create calculator with custom config', () => {
      const calc = createFlashLoanFeeCalculator({
        feeOverrides: { 'bsc': 25 },
      });

      const fee = calc.calculateFlashLoanFee(ethers.parseEther('100'), 'bsc');
      // 25 bps = 0.25% of 100 ETH = 0.25 ETH
      expect(fee).toBe(ethers.parseEther('0.25'));
    });
  });
});
