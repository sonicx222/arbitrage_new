/**
 * BridgeProfitabilityAnalyzer Unit Tests
 *
 * Tests bridge fee analysis for cross-chain arbitrage profitability decisions.
 * Covers: analyze(), getMinimumProfitRequired(), getDefaultMaxFeePercentage(),
 * and the deprecated checkBridgeProfitability() standalone function.
 *
 * @see services/execution-engine/src/services/bridge-profitability-analyzer.ts
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { ethers } from 'ethers';
import { createMockLogger } from '@arbitrage/test-utils';

import {
  BridgeProfitabilityAnalyzer,
  checkBridgeProfitability,
} from '../../../src/services/bridge-profitability-analyzer';
import type {
  BridgeProfitabilityResult,
} from '../../../src/services/bridge-profitability-analyzer';

describe('BridgeProfitabilityAnalyzer', () => {
  let analyzer: BridgeProfitabilityAnalyzer;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    analyzer = new BridgeProfitabilityAnalyzer(mockLogger);
  });

  // ===========================================================================
  // Constructor & Configuration
  // ===========================================================================

  describe('constructor', () => {
    it('should default to 50% max fee percentage', () => {
      expect(analyzer.getDefaultMaxFeePercentage()).toBe(50);
    });

    it('should accept custom default max fee percentage', () => {
      const custom = new BridgeProfitabilityAnalyzer(mockLogger, {
        defaultMaxFeePercentage: 30,
      });
      expect(custom.getDefaultMaxFeePercentage()).toBe(30);
    });

    it('should use ?? for defaultMaxFeePercentage (preserving 0)', () => {
      const custom = new BridgeProfitabilityAnalyzer(mockLogger, {
        defaultMaxFeePercentage: 0,
      });
      expect(custom.getDefaultMaxFeePercentage()).toBe(0);
    });
  });

  // ===========================================================================
  // analyze()
  // ===========================================================================

  describe('analyze', () => {
    it('should return profitable when fees are below threshold', () => {
      // Bridge fee: 0.01 ETH = $20 at ETH $2000
      // Expected profit: $100
      // Fee percentage: 20% < 50% default
      const bridgeFeeWei = ethers.parseEther('0.01');
      const expectedProfitUsd = 100;
      const ethPriceUsd = 2000;

      const result = analyzer.analyze(bridgeFeeWei, expectedProfitUsd, ethPriceUsd);

      expect(result.isProfitable).toBe(true);
      expect(result.bridgeFeeEth).toBeCloseTo(0.01);
      expect(result.bridgeFeeUsd).toBeCloseTo(20);
      expect(result.profitAfterFees).toBeCloseTo(80);
      expect(result.feePercentageOfProfit).toBeCloseTo(20);
      expect(result.reason).toBeUndefined();
    });

    it('should return not profitable when fees exceed threshold', () => {
      // Bridge fee: 0.05 ETH = $100 at ETH $2000
      // Expected profit: $120
      // Fee percentage: 83.3% > 50% default
      const bridgeFeeWei = ethers.parseEther('0.05');
      const expectedProfitUsd = 120;
      const ethPriceUsd = 2000;

      const result = analyzer.analyze(bridgeFeeWei, expectedProfitUsd, ethPriceUsd);

      expect(result.isProfitable).toBe(false);
      expect(result.bridgeFeeUsd).toBeCloseTo(100);
      expect(result.feePercentageOfProfit).toBeCloseTo(83.33, 1);
      expect(result.reason).toBeDefined();
      expect(result.reason).toContain('exceed');
    });

    it('should use custom maxFeePercentage from options', () => {
      // Bridge fee: 0.01 ETH = $20 at ETH $2000
      // Expected profit: $100
      // Fee percentage: 20% > 10% custom threshold
      const bridgeFeeWei = ethers.parseEther('0.01');
      const expectedProfitUsd = 100;
      const ethPriceUsd = 2000;

      const result = analyzer.analyze(bridgeFeeWei, expectedProfitUsd, ethPriceUsd, {
        maxFeePercentage: 10,
      });

      expect(result.isProfitable).toBe(false);
      expect(result.feePercentageOfProfit).toBeCloseTo(20);
    });

    it('should handle zero expected profit', () => {
      const bridgeFeeWei = ethers.parseEther('0.01');
      const result = analyzer.analyze(bridgeFeeWei, 0, 2000);

      // feePercentageOfProfit should be 100 when expectedProfitUsd is 0
      expect(result.feePercentageOfProfit).toBe(100);
      expect(result.isProfitable).toBe(false);
    });

    it('should handle zero bridge fee', () => {
      const bridgeFeeWei = 0n;
      const result = analyzer.analyze(bridgeFeeWei, 100, 2000);

      expect(result.isProfitable).toBe(true);
      expect(result.bridgeFeeEth).toBe(0);
      expect(result.bridgeFeeUsd).toBe(0);
      expect(result.profitAfterFees).toBe(100);
      expect(result.feePercentageOfProfit).toBe(0);
    });

    it('should handle large bridge fees (wei precision)', () => {
      // 1 ETH bridge fee
      const bridgeFeeWei = ethers.parseEther('1.0');
      const expectedProfitUsd = 5000;
      const ethPriceUsd = 3000;

      const result = analyzer.analyze(bridgeFeeWei, expectedProfitUsd, ethPriceUsd);

      expect(result.bridgeFeeEth).toBeCloseTo(1.0);
      expect(result.bridgeFeeUsd).toBeCloseTo(3000);
      // 3000/5000 * 100 = 60% > 50%
      expect(result.isProfitable).toBe(false);
      expect(result.profitAfterFees).toBeCloseTo(2000);
    });

    it('should include chain in debug log when not profitable', () => {
      const bridgeFeeWei = ethers.parseEther('0.1');
      analyzer.analyze(bridgeFeeWei, 50, 2000, { chain: 'ethereum' });

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Bridge fee profitability check failed',
        expect.objectContaining({ chain: 'ethereum' })
      );
    });

    it('should not log when profitable', () => {
      const bridgeFeeWei = ethers.parseEther('0.001');
      analyzer.analyze(bridgeFeeWei, 1000, 2000);

      expect(mockLogger.debug).not.toHaveBeenCalled();
    });

    it('should calculate correct profitAfterFees', () => {
      // Bridge fee: 0.02 ETH = $40 at ETH $2000
      // Expected profit: $200
      // Profit after fees: $160
      const bridgeFeeWei = ethers.parseEther('0.02');
      const result = analyzer.analyze(bridgeFeeWei, 200, 2000);

      expect(result.profitAfterFees).toBeCloseTo(160);
    });

    it('should return negative profitAfterFees when fees exceed profit', () => {
      // Bridge fee: 0.1 ETH = $200 at ETH $2000
      // Expected profit: $100
      const bridgeFeeWei = ethers.parseEther('0.1');
      const result = analyzer.analyze(bridgeFeeWei, 100, 2000);

      expect(result.profitAfterFees).toBeCloseTo(-100);
      expect(result.isProfitable).toBe(false);
    });

    it('should include reason with fee and profit amounts when not profitable', () => {
      const bridgeFeeWei = ethers.parseEther('0.05');
      const result = analyzer.analyze(bridgeFeeWei, 100, 2000);

      expect(result.reason).toContain('$100.00');
      expect(result.reason).toContain('50%');
    });
  });

  // ===========================================================================
  // getMinimumProfitRequired()
  // ===========================================================================

  describe('getMinimumProfitRequired', () => {
    it('should calculate minimum profit for default threshold', () => {
      // Bridge fee: 0.01 ETH = $20 at ETH $2000
      // At 50% max: minimum profit = 20 / 0.5 = $40
      const bridgeFeeWei = ethers.parseEther('0.01');
      const minProfit = analyzer.getMinimumProfitRequired(bridgeFeeWei, 2000);

      expect(minProfit).toBeCloseTo(40);
    });

    it('should calculate minimum profit for custom threshold', () => {
      // Bridge fee: 0.01 ETH = $20 at ETH $2000
      // At 25% max: minimum profit = 20 / 0.25 = $80
      const bridgeFeeWei = ethers.parseEther('0.01');
      const minProfit = analyzer.getMinimumProfitRequired(bridgeFeeWei, 2000, 25);

      expect(minProfit).toBeCloseTo(80);
    });

    it('should return 0 for zero bridge fee', () => {
      const minProfit = analyzer.getMinimumProfitRequired(0n, 2000);
      expect(minProfit).toBe(0);
    });

    it('should scale with native token price', () => {
      const bridgeFeeWei = ethers.parseEther('0.01');

      const minProfitAt2000 = analyzer.getMinimumProfitRequired(bridgeFeeWei, 2000);
      const minProfitAt4000 = analyzer.getMinimumProfitRequired(bridgeFeeWei, 4000);

      // Should be exactly 2x when ETH price doubles
      expect(minProfitAt4000).toBeCloseTo(minProfitAt2000 * 2);
    });
  });

  // ===========================================================================
  // getDefaultMaxFeePercentage()
  // ===========================================================================

  describe('getDefaultMaxFeePercentage', () => {
    it('should return the configured default', () => {
      expect(analyzer.getDefaultMaxFeePercentage()).toBe(50);
    });

    it('should return custom value when configured', () => {
      const custom = new BridgeProfitabilityAnalyzer(mockLogger, {
        defaultMaxFeePercentage: 75,
      });
      expect(custom.getDefaultMaxFeePercentage()).toBe(75);
    });
  });
});

// =============================================================================
// checkBridgeProfitability() standalone function (deprecated)
// =============================================================================

describe('checkBridgeProfitability (deprecated standalone)', () => {
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
  });

  it('should delegate to BridgeProfitabilityAnalyzer.analyze()', () => {
    const bridgeFeeWei = ethers.parseEther('0.01');
    const result = checkBridgeProfitability(bridgeFeeWei, 100, 2000, mockLogger);

    expect(result.isProfitable).toBe(true);
    expect(result.bridgeFeeEth).toBeCloseTo(0.01);
    expect(result.bridgeFeeUsd).toBeCloseTo(20);
  });

  it('should pass options through', () => {
    const bridgeFeeWei = ethers.parseEther('0.01');
    const result = checkBridgeProfitability(bridgeFeeWei, 100, 2000, mockLogger, {
      maxFeePercentage: 10,
      chain: 'arbitrum',
    });

    // 20% > 10% custom threshold
    expect(result.isProfitable).toBe(false);
  });

  it('should return all expected fields', () => {
    const bridgeFeeWei = ethers.parseEther('0.005');
    const result = checkBridgeProfitability(bridgeFeeWei, 50, 2000, mockLogger);

    expect(result).toHaveProperty('isProfitable');
    expect(result).toHaveProperty('bridgeFeeUsd');
    expect(result).toHaveProperty('bridgeFeeEth');
    expect(result).toHaveProperty('profitAfterFees');
    expect(result).toHaveProperty('feePercentageOfProfit');
  });
});
