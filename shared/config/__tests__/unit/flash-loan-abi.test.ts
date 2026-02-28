/**
 * Tests for Flash Loan ABI Constants
 *
 * Covers:
 * - Fee constants (AAVE_V3_FEE_BPS, BALANCER_V2_FEE_BPS, SYNCSWAP_FEE_BPS)
 * - BPS_DENOMINATOR
 * - BigInt getter functions
 * - ABI arrays structure and function signatures
 *
 * @see shared/config/src/flash-loan-abi.ts
 */

import { describe, it, expect } from '@jest/globals';
import {
  AAVE_V3_FEE_BPS,
  BPS_DENOMINATOR,
  getAaveV3FeeBpsBigInt,
  getBpsDenominatorBigInt,
  BALANCER_V2_FEE_BPS,
  SYNCSWAP_FEE_BPS,
  getSyncSwapFeeBpsBigInt,
  FLASH_LOAN_ARBITRAGE_ABI,
  BALANCER_V2_FLASH_ARBITRAGE_ABI,
  SYNCSWAP_FLASH_ARBITRAGE_ABI,
  PANCAKESWAP_FLASH_ARBITRAGE_ABI,
} from '../../src/flash-loan-abi';

describe('Flash Loan ABI Constants', () => {
  // ===========================================================================
  // Fee Constants
  // ===========================================================================

  describe('fee constants', () => {
    it('AAVE_V3_FEE_BPS should be 9 (0.09%)', () => {
      expect(AAVE_V3_FEE_BPS).toBe(9);
    });

    it('BALANCER_V2_FEE_BPS should be 0 (0%)', () => {
      expect(BALANCER_V2_FEE_BPS).toBe(0);
    });

    it('SYNCSWAP_FEE_BPS should be 30 (0.3%)', () => {
      expect(SYNCSWAP_FEE_BPS).toBe(30);
    });

    it('BPS_DENOMINATOR should be 10000', () => {
      expect(BPS_DENOMINATOR).toBe(10000);
    });

    it('all fee constants should be non-negative integers', () => {
      expect(Number.isInteger(AAVE_V3_FEE_BPS)).toBe(true);
      expect(Number.isInteger(BALANCER_V2_FEE_BPS)).toBe(true);
      expect(Number.isInteger(SYNCSWAP_FEE_BPS)).toBe(true);
      expect(AAVE_V3_FEE_BPS).toBeGreaterThanOrEqual(0);
      expect(BALANCER_V2_FEE_BPS).toBeGreaterThanOrEqual(0);
      expect(SYNCSWAP_FEE_BPS).toBeGreaterThanOrEqual(0);
    });

    it('all fee constants should be less than BPS_DENOMINATOR', () => {
      expect(AAVE_V3_FEE_BPS).toBeLessThan(BPS_DENOMINATOR);
      expect(BALANCER_V2_FEE_BPS).toBeLessThan(BPS_DENOMINATOR);
      expect(SYNCSWAP_FEE_BPS).toBeLessThan(BPS_DENOMINATOR);
    });

    it('fee ordering should be Balancer (0) < Aave (9) < SyncSwap (30)', () => {
      expect(BALANCER_V2_FEE_BPS).toBeLessThan(AAVE_V3_FEE_BPS);
      expect(AAVE_V3_FEE_BPS).toBeLessThan(SYNCSWAP_FEE_BPS);
    });
  });

  // ===========================================================================
  // BigInt Getter Functions
  // ===========================================================================

  describe('BigInt getters', () => {
    it('getAaveV3FeeBpsBigInt should return BigInt(9)', () => {
      const result = getAaveV3FeeBpsBigInt();
      expect(typeof result).toBe('bigint');
      expect(result).toBe(BigInt(AAVE_V3_FEE_BPS));
      expect(result).toBe(9n);
    });

    it('getBpsDenominatorBigInt should return BigInt(10000)', () => {
      const result = getBpsDenominatorBigInt();
      expect(typeof result).toBe('bigint');
      expect(result).toBe(BigInt(BPS_DENOMINATOR));
      expect(result).toBe(10000n);
    });

    it('getSyncSwapFeeBpsBigInt should return BigInt(30)', () => {
      const result = getSyncSwapFeeBpsBigInt();
      expect(typeof result).toBe('bigint');
      expect(result).toBe(BigInt(SYNCSWAP_FEE_BPS));
      expect(result).toBe(30n);
    });

    it('BigInt fee calculation should produce correct results', () => {
      // Verify: 1 ETH loan amount * 9 bps / 10000 = 0.0009 ETH fee
      const loanAmount = BigInt('1000000000000000000'); // 1 ETH in wei
      const fee = (loanAmount * getAaveV3FeeBpsBigInt()) / getBpsDenominatorBigInt();
      expect(fee).toBe(BigInt('900000000000000')); // 0.0009 ETH
    });
  });

  // ===========================================================================
  // ABI Arrays - Structure
  // ===========================================================================

  describe('ABI arrays', () => {
    it('FLASH_LOAN_ARBITRAGE_ABI should contain core functions', () => {
      expect(FLASH_LOAN_ARBITRAGE_ABI.length).toBeGreaterThan(0);
      const joined = FLASH_LOAN_ARBITRAGE_ABI.join('\n');
      expect(joined).toContain('executeArbitrage');
      expect(joined).toContain('calculateExpectedProfit');
      expect(joined).toContain('isApprovedRouter');
      expect(joined).toContain('POOL');
    });

    it('BALANCER_V2_FLASH_ARBITRAGE_ABI should use VAULT instead of POOL', () => {
      const joined = BALANCER_V2_FLASH_ARBITRAGE_ABI.join('\n');
      expect(joined).toContain('executeArbitrage');
      expect(joined).toContain('calculateExpectedProfit');
      expect(joined).toContain('VAULT');
      expect(joined).not.toContain('POOL');
    });

    it('SYNCSWAP_FLASH_ARBITRAGE_ABI should use VAULT', () => {
      const joined = SYNCSWAP_FLASH_ARBITRAGE_ABI.join('\n');
      expect(joined).toContain('executeArbitrage');
      expect(joined).toContain('calculateExpectedProfit');
      expect(joined).toContain('VAULT');
    });

    it('PANCAKESWAP_FLASH_ARBITRAGE_ABI should have pool parameter in executeArbitrage', () => {
      const execFn = PANCAKESWAP_FLASH_ARBITRAGE_ABI.find(fn => fn.includes('executeArbitrage'));
      expect(execFn).toBeDefined();
      // PancakeSwap takes an extra pool address parameter
      expect(execFn).toContain('address pool');
    });

    it('PANCAKESWAP_FLASH_ARBITRAGE_ABI should include pool management functions', () => {
      const joined = PANCAKESWAP_FLASH_ARBITRAGE_ABI.join('\n');
      expect(joined).toContain('whitelistPool');
      expect(joined).toContain('isPoolWhitelisted');
      expect(joined).toContain('getWhitelistedPools');
      expect(joined).toContain('getApprovedRouters');
    });

    it('all ABIs should have string[] type', () => {
      expect(Array.isArray(FLASH_LOAN_ARBITRAGE_ABI)).toBe(true);
      expect(Array.isArray(BALANCER_V2_FLASH_ARBITRAGE_ABI)).toBe(true);
      expect(Array.isArray(SYNCSWAP_FLASH_ARBITRAGE_ABI)).toBe(true);
      expect(Array.isArray(PANCAKESWAP_FLASH_ARBITRAGE_ABI)).toBe(true);
      for (const abi of [FLASH_LOAN_ARBITRAGE_ABI, BALANCER_V2_FLASH_ARBITRAGE_ABI, SYNCSWAP_FLASH_ARBITRAGE_ABI, PANCAKESWAP_FLASH_ARBITRAGE_ABI]) {
        for (const entry of abi) {
          expect(typeof entry).toBe('string');
        }
      }
    });
  });

  // ===========================================================================
  // ABI Function Signatures - Detailed Validation
  // ===========================================================================

  describe('ABI function signatures', () => {
    it('executeArbitrage should accept swapPath tuple array', () => {
      const aaveExec = FLASH_LOAN_ARBITRAGE_ABI.find(fn => fn.includes('executeArbitrage'));
      expect(aaveExec).toContain('tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[]');
      expect(aaveExec).toContain('uint256 minProfit');
      expect(aaveExec).toContain('uint256 deadline');
    });

    it('calculateExpectedProfit should return (uint256, uint256)', () => {
      const calcFn = FLASH_LOAN_ARBITRAGE_ABI.find(fn => fn.includes('calculateExpectedProfit'));
      expect(calcFn).toContain('returns (uint256 expectedProfit, uint256 flashLoanFee)');
    });

    it('isApprovedRouter should return bool', () => {
      const routerFn = FLASH_LOAN_ARBITRAGE_ABI.find(fn => fn.includes('isApprovedRouter'));
      expect(routerFn).toContain('returns (bool)');
    });
  });
});
