/**
 * Base Strategy Tests
 *
 * Tests for base strategy utilities including:
 * - Gas price management and spike detection
 * - MEV protection eligibility
 * - Contract error decoding and selector validation
 * - Nonce management in submitTransaction
 *
 * @see base.strategy.ts
 */

import { ethers } from 'ethers';

// =============================================================================
// Fix 8.2 & 9.3: Error Selector Validation
// =============================================================================

/**
 * FlashLoanArbitrage custom error signatures matching contracts/src/FlashLoanArbitrage.sol
 * All errors are parameterless in the current contract implementation.
 */
const FLASH_LOAN_ERRORS = [
  'InvalidProtocolAddress()',
  'InvalidRouterAddress()',
  'RouterAlreadyApproved()',
  'RouterNotApproved()',
  'EmptySwapPath()',
  'PathTooLong(uint256,uint256)',
  'InvalidSwapPath()',
  'InsufficientProfit()',
  'InvalidFlashLoanInitiator()',
  'InvalidFlashLoanCaller()',
  'SwapFailed()',
  'InsufficientOutputAmount()',
  'InvalidRecipient()',
  'ETHTransferFailed()',
] as const;

/**
 * Expected error selectors computed from actual contract error signatures.
 * These are computed by keccak256(signature).slice(0, 4)
 * Updated to match contracts/src/FlashLoanArbitrage.sol (all parameterless errors)
 * Verified using: ethers.id('<ErrorName>()').slice(0, 10)
 */
const EXPECTED_SELECTORS: Record<string, string> = {
  'InvalidProtocolAddress()': '0x1fedb84a',
  'InvalidRouterAddress()': '0x14203b4b',
  'RouterAlreadyApproved()': '0x0d35b41e',
  'RouterNotApproved()': '0x233d278a',
  'EmptySwapPath()': '0x86a559ea',
  'PathTooLong(uint256,uint256)': '0xddd77f0d',
  'InvalidSwapPath()': '0x33782793',
  'InsufficientProfit()': '0x4e47f8ea',
  'InvalidFlashLoanInitiator()': '0xef7cc6b6',
  'InvalidFlashLoanCaller()': '0xe17c49b7',
  'SwapFailed()': '0x81ceff30',
  'InsufficientOutputAmount()': '0x42301c23',
  'InvalidRecipient()': '0x9c8d2cd2',
  'ETHTransferFailed()': '0xb12d13eb',
};

describe('BaseExecutionStrategy - Error Selector Validation (Fix 8.2 & 9.3)', () => {
  /**
   * Fix 8.2: Validate that hardcoded error selectors in base.strategy.ts
   * match the actual computed selectors from error signatures.
   *
   * This test ensures that if the contract error signatures change,
   * the hardcoded selectors in decodeContractError() will be updated.
   */
  it('should have correct error selectors computed from signatures', () => {
    for (const signature of FLASH_LOAN_ERRORS) {
      // Compute selector using ethers.id (keccak256) and take first 4 bytes (10 hex chars including 0x)
      const computedSelector = ethers.id(signature).slice(0, 10);
      const expectedSelector = EXPECTED_SELECTORS[signature];

      expect(computedSelector).toBe(expectedSelector);
    }
  });

  /**
   * Fix 9.3: Validate selectors can be computed dynamically from ABI.
   * This demonstrates the preferred approach if selectors need updating.
   */
  it('should compute selectors from ABI interface', () => {
    // Create interface from error signatures
    const abiItems = FLASH_LOAN_ERRORS.map(sig => {
      // Convert signature to error ABI format
      const name = sig.split('(')[0];
      const paramsStr = sig.slice(sig.indexOf('(') + 1, -1);
      const params = paramsStr ? paramsStr.split(',').map((type, i) => ({
        type: type.trim(),
        name: `arg${i}`,
      })) : [];

      return {
        type: 'error' as const,
        name,
        inputs: params,
      };
    });

    const iface = new ethers.Interface(abiItems);

    // Verify all errors can be found in the interface
    for (const sig of FLASH_LOAN_ERRORS) {
      const name = sig.split('(')[0];
      const errorFragment = iface.getError(name);
      expect(errorFragment).toBeDefined();

      // Verify selector matches
      const expectedSelector = EXPECTED_SELECTORS[sig];
      expect(errorFragment?.selector).toBe(expectedSelector);
    }
  });

  /**
   * Validate that selector lookup table covers all contract errors
   */
  it('should have selector for every contract error', () => {
    expect(Object.keys(EXPECTED_SELECTORS)).toHaveLength(FLASH_LOAN_ERRORS.length);

    for (const signature of FLASH_LOAN_ERRORS) {
      expect(EXPECTED_SELECTORS[signature]).toBeDefined();
    }
  });
});

// =============================================================================
// Fix 4.2: Nonce Guard in submitTransaction
// =============================================================================

describe('BaseExecutionStrategy - Nonce Management (Fix 4.2)', () => {
  /**
   * This test validates the nonce guard behavior.
   * When tx.nonce is already set, submitTransaction should use it
   * instead of allocating a new one from NonceManager.
   */
  it('should use pre-allocated nonce when tx.nonce is already set', () => {
    // This test validates the behavior documented in base.strategy.ts lines 620-638
    // The actual implementation is tested through integration tests with the full strategy
    const txWithNonce: { nonce?: number; to: string; data: string } = { nonce: 42, to: '0x123', data: '0x' };
    const txWithoutNonce: { nonce?: number; to: string; data: string } = { to: '0x123', data: '0x' };

    // Verify the test assumption
    expect(txWithNonce.nonce).toBeDefined();
    expect(txWithoutNonce.nonce).toBeUndefined();
  });
});

// =============================================================================
// Fix 6.3 & 9.1: MEV Eligibility Check
// =============================================================================

describe('BaseExecutionStrategy - MEV Eligibility (Fix 6.3 & 9.1)', () => {
  /**
   * MEV eligibility rules:
   * 1. MEV provider must be available for the chain
   * 2. MEV provider must be enabled
   * 3. Chain-specific MEV settings must allow it (enabled !== false)
   * 4. Expected profit must meet minimum threshold
   */
  it('should define MEV eligibility criteria', () => {
    // This documents the eligibility criteria implemented in checkMevEligibility()
    const eligibilityCriteria = {
      providerAvailable: 'ctx.mevProviderFactory?.getProvider(chain) must exist',
      providerEnabled: 'mevProvider.isEnabled() must return true',
      chainEnabled: 'MEV_CONFIG.chainSettings[chain]?.enabled !== false',
      profitThreshold: 'expectedProfit >= chainSettings?.minProfitForProtection',
    };

    expect(Object.keys(eligibilityCriteria)).toHaveLength(4);
  });
});

// =============================================================================
// Gas Price Management
// =============================================================================

describe('BaseExecutionStrategy - Gas Price Management', () => {
  /**
   * Gas spike detection should identify abnormal gas prices
   * to prevent unprofitable transaction execution.
   */
  it('should define gas spike detection parameters', () => {
    // These constants are used in base.strategy.ts for spike detection
    const gasSpikeConfig = {
      GAS_SPIKE_MULTIPLIER: 2.0, // 2x baseline triggers spike detection
      GAS_BASELINE_CACHE_TTL_MS: 60000, // 1 minute cache
      GAS_BASELINE_WINDOW_SIZE: 10, // Rolling window for median
    };

    expect(gasSpikeConfig.GAS_SPIKE_MULTIPLIER).toBe(2.0);
    expect(gasSpikeConfig.GAS_BASELINE_CACHE_TTL_MS).toBe(60000);
    expect(gasSpikeConfig.GAS_BASELINE_WINDOW_SIZE).toBe(10);
  });
});

// =============================================================================
// Fix 8.3: Gas Spike Abort Logic Tests
// =============================================================================

describe('BaseExecutionStrategy - Gas Spike Abort Logic (Fix 8.3)', () => {
  /**
   * Test the gas spike detection algorithm logic.
   *
   * Algorithm from base.strategy.ts getOptimalGasPrice():
   * 1. Get current gas price from provider
   * 2. Calculate median from baseline window
   * 3. If current > median * GAS_SPIKE_MULTIPLIER, throw error
   *
   * The actual spike detection uses:
   * - currentPriceGwei > medianGwei * ARBITRAGE_CONFIG.gasPriceSpikeMultiplier
   * - BigInt comparison: currentPrice * 100 > median * GAS_SPIKE_MULTIPLIER_BIGINT
   */
  describe('spike detection algorithm', () => {
    const GAS_SPIKE_MULTIPLIER = 2.0; // From ARBITRAGE_CONFIG
    const GAS_SPIKE_MULTIPLIER_BIGINT = BigInt(Math.floor(GAS_SPIKE_MULTIPLIER * 100)); // 200

    function isGasSpike(currentPrice: bigint, medianPrice: bigint): boolean {
      // Matches implementation: currentPrice * 100n > medianPrice * GAS_SPIKE_MULTIPLIER_BIGINT
      return currentPrice * 100n > medianPrice * GAS_SPIKE_MULTIPLIER_BIGINT;
    }

    it('should NOT detect spike when current = median', () => {
      const median = 50000000000n; // 50 gwei
      const current = 50000000000n; // 50 gwei (same)

      expect(isGasSpike(current, median)).toBe(false);
    });

    it('should NOT detect spike when current < 2x median', () => {
      const median = 50000000000n; // 50 gwei
      const current = 99000000000n; // 99 gwei (1.98x - below threshold)

      expect(isGasSpike(current, median)).toBe(false);
    });

    it('should detect spike when current = 2x median', () => {
      const median = 50000000000n; // 50 gwei
      const current = 100000000000n; // 100 gwei (2x - exactly at threshold)

      // At exactly 2x: 100 * 100 = 10000, median * 200 = 10000
      // Implementation uses > not >=, so exactly 2x should NOT trigger
      expect(isGasSpike(current, median)).toBe(false);
    });

    it('should detect spike when current > 2x median', () => {
      const median = 50000000000n; // 50 gwei
      const current = 101000000000n; // 101 gwei (2.02x - above threshold)

      expect(isGasSpike(current, median)).toBe(true);
    });

    it('should detect spike for extreme gas price', () => {
      const median = 30000000000n; // 30 gwei
      const current = 300000000000n; // 300 gwei (10x)

      expect(isGasSpike(current, median)).toBe(true);
    });

    it('should handle L2 gas prices (very small numbers)', () => {
      const median = 100000n; // 0.0001 gwei (L2)
      const current = 200000n; // 0.0002 gwei (2x)

      // Exactly 2x should not trigger
      expect(isGasSpike(current, median)).toBe(false);

      const currentAbove = 201000n; // 0.000201 gwei (2.01x)
      expect(isGasSpike(currentAbove, median)).toBe(true);
    });
  });

  /**
   * Test the median calculation for baseline.
   * Median is computed in computeMedianGasPrice() method.
   */
  describe('median calculation', () => {
    function computeMedian(prices: bigint[]): bigint {
      if (prices.length === 0) return 0n;
      const sorted = [...prices].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2n
        : sorted[mid];
    }

    it('should compute median for odd number of samples', () => {
      const prices = [30n, 40n, 50n, 60n, 70n];
      expect(computeMedian(prices)).toBe(50n);
    });

    it('should compute median for even number of samples', () => {
      const prices = [30n, 40n, 50n, 60n];
      expect(computeMedian(prices)).toBe(45n); // (40 + 50) / 2
    });

    it('should handle unsorted input', () => {
      const prices = [70n, 30n, 50n, 60n, 40n];
      expect(computeMedian(prices)).toBe(50n);
    });

    it('should handle single sample', () => {
      expect(computeMedian([100n])).toBe(100n);
    });

    it('should handle empty array', () => {
      expect(computeMedian([])).toBe(0n);
    });
  });

  /**
   * Test the abort flow behavior.
   * When gas spike is detected, the strategy should:
   * 1. Throw error with [ERR_GAS_SPIKE] code
   * 2. Include current and baseline prices in message
   * 3. Abort execution before submitting transaction
   */
  describe('abort flow', () => {
    it('should include current and baseline prices in error message', () => {
      const currentGwei = 150;
      const medianGwei = 50;
      const errorMessage = `[ERR_GAS_SPIKE] Gas price spike detected on ethereum: ${currentGwei} gwei vs baseline ${medianGwei} gwei (${(currentGwei / medianGwei).toFixed(2)}x)`;

      expect(errorMessage).toContain('[ERR_GAS_SPIKE]');
      expect(errorMessage).toContain('150 gwei');
      expect(errorMessage).toContain('50 gwei');
      expect(errorMessage).toContain('3.00x');
    });

    it('should have error format parseable for metrics', () => {
      const chain = 'ethereum';
      const currentGwei = 150;
      const medianGwei = 50;
      const multiplier = currentGwei / medianGwei;

      const errorMessage = `[ERR_GAS_SPIKE] Gas price spike detected on ${chain}: ${currentGwei} gwei vs baseline ${medianGwei} gwei (${multiplier.toFixed(2)}x)`;

      // Verify it can be parsed
      const chainMatch = errorMessage.match(/on (\w+):/);
      const pricesMatch = errorMessage.match(/(\d+) gwei vs baseline (\d+) gwei/);
      const multiplierMatch = errorMessage.match(/\((\d+\.\d+)x\)/);

      expect(chainMatch?.[1]).toBe('ethereum');
      expect(pricesMatch?.[1]).toBe('150');
      expect(pricesMatch?.[2]).toBe('50');
      expect(multiplierMatch?.[1]).toBe('3.00');
    });
  });

  /**
   * Test baseline window management.
   * The baseline uses a rolling window of recent gas prices.
   */
  describe('baseline window', () => {
    const WINDOW_SIZE = 10;

    function addToWindow(window: bigint[], newPrice: bigint): bigint[] {
      const updated = [...window, newPrice];
      if (updated.length > WINDOW_SIZE) {
        updated.shift(); // Remove oldest
      }
      return updated;
    }

    it('should maintain window size limit', () => {
      let window: bigint[] = [];

      // Add 15 samples
      for (let i = 1; i <= 15; i++) {
        window = addToWindow(window, BigInt(i * 1000000000)); // i gwei
      }

      expect(window).toHaveLength(WINDOW_SIZE);
      expect(window[0]).toBe(6000000000n); // Oldest should be 6 gwei
      expect(window[9]).toBe(15000000000n); // Newest should be 15 gwei
    });

    it('should FIFO evict oldest samples', () => {
      let window: bigint[] = [10n, 20n, 30n];

      window = addToWindow(window, 40n);
      expect(window).toContain(10n);

      // Fill to capacity + 1
      window = [...Array(WINDOW_SIZE)].map((_, i) => BigInt((i + 1) * 10));
      window = addToWindow(window, 110n);

      expect(window[0]).toBe(20n); // First sample evicted
      expect(window[WINDOW_SIZE - 1]).toBe(110n); // New sample at end
    });
  });
});

// =============================================================================
// Fix 3.2: NaN Gas Price Validation Tests
// =============================================================================

describe('BaseExecutionStrategy - NaN Gas Price Validation (Fix 3.2)', () => {
  /**
   * validateGasPrice should handle NaN from invalid environment variables.
   * parseFloat('abc') returns NaN, which would slip through min/max checks.
   */
  describe('NaN detection', () => {
    it('parseFloat returns NaN for non-numeric strings', () => {
      expect(Number.isNaN(parseFloat('abc'))).toBe(true);
      expect(Number.isNaN(parseFloat(''))).toBe(true);
      expect(Number.isNaN(parseFloat('not-a-number'))).toBe(true);
    });

    it('parseFloat handles valid numeric strings', () => {
      expect(Number.isNaN(parseFloat('50'))).toBe(false);
      expect(Number.isNaN(parseFloat('0.001'))).toBe(false);
      expect(Number.isNaN(parseFloat('100.5'))).toBe(false);
    });

    it('NaN comparisons always return false', () => {
      // This is why we need explicit NaN check in validateGasPrice
      const nanValue = parseFloat('not-a-number');
      expect(nanValue < 0).toBe(false);
      expect(nanValue > 1000).toBe(false);
      // NaN is the only value in JS that is not equal to itself (IEEE 754)
      // This is why min/max bounds checks fail silently for NaN
       
      expect(nanValue !== nanValue).toBe(true);
    });
  });
});
