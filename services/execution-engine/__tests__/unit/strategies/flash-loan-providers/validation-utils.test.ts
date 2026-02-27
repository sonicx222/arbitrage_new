/**
 * Unit Tests for Flash Loan Validation Utilities
 *
 * Tests the shared validation logic used by Aave V3, Balancer V2, and SyncSwap
 * flash loan providers. These tests exercise validateFlashLoanRequest() directly,
 * verifying each validation rule independently.
 *
 * @see validation-utils.ts
 * @see aave-v3.provider.ts
 * @see balancer-v2.provider.ts
 * @see syncswap.provider.ts
 */

import { ethers } from 'ethers';
import { validateFlashLoanRequest } from '../../../../src/strategies/flash-loan-providers/validation-utils';
import type {
  FlashLoanRequest,
  FlashLoanSwapStep,
} from '../../../../src/strategies/flash-loan-providers/types';

// =============================================================================
// Test Utilities
// =============================================================================

const TEST_ADDRESSES = {
  WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
  ROUTER_A: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  ROUTER_B: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
  INITIATOR: '0xabcdef0123456789abcdef0123456789abcdef01',
  UNAPPROVED: '0x9999999999999999999999999999999999999999',
};

const PROVIDER_CHAIN = 'ethereum';

/**
 * Pre-computed approved routers set (lowercase)
 */
const APPROVED_ROUTERS = new Set([
  TEST_ADDRESSES.ROUTER_A.toLowerCase(),
  TEST_ADDRESSES.ROUTER_B.toLowerCase(),
]);

const EMPTY_ROUTERS = new Set<string>();

/**
 * Create a valid flash loan request for testing
 */
// W1-19 FIX: Uses realistic amountOutMin values (0.5% slippage) instead of 0n.
const createValidRequest = (overrides?: Partial<FlashLoanRequest>): FlashLoanRequest => ({
  asset: TEST_ADDRESSES.WETH,
  amount: ethers.parseEther('10'),
  chain: PROVIDER_CHAIN,
  swapPath: [
    {
      router: TEST_ADDRESSES.ROUTER_A,
      tokenIn: TEST_ADDRESSES.WETH,
      tokenOut: TEST_ADDRESSES.USDC,
      amountOutMin: ethers.parseUnits('24875', 6), // ~$2500/ETH * 10 * 0.995 (USDC 6 decimals)
    },
    {
      router: TEST_ADDRESSES.ROUTER_A,
      tokenIn: TEST_ADDRESSES.USDC,
      tokenOut: TEST_ADDRESSES.WETH,
      amountOutMin: ethers.parseEther('9.95'), // 10 ETH * 0.995 slippage
    },
  ] as FlashLoanSwapStep[],
  minProfit: ethers.parseEther('0.1'),
  initiator: TEST_ADDRESSES.INITIATOR,
  ...overrides,
});

// =============================================================================
// Tests
// =============================================================================

describe('validateFlashLoanRequest', () => {
  describe('valid requests', () => {
    it('should pass validation for a correct request', () => {
      const request = createValidRequest();

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should pass validation for multi-hop path', () => {
      const request = createValidRequest({
        swapPath: [
          {
            router: TEST_ADDRESSES.ROUTER_A,
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: ethers.parseUnits('24875', 6),
          },
          {
            router: TEST_ADDRESSES.ROUTER_B,
            tokenIn: TEST_ADDRESSES.USDC,
            tokenOut: TEST_ADDRESSES.DAI,
            amountOutMin: ethers.parseEther('24875'),
          },
          {
            router: TEST_ADDRESSES.ROUTER_A,
            tokenIn: TEST_ADDRESSES.DAI,
            tokenOut: TEST_ADDRESSES.WETH,
            amountOutMin: ethers.parseEther('9.95'),
          },
        ] as FlashLoanSwapStep[],
      });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(true);
    });

    it('should fail-closed when approved routers set is empty (misconfiguration)', () => {
      const request = createValidRequest({
        swapPath: [
          {
            router: TEST_ADDRESSES.UNAPPROVED,
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: ethers.parseUnits('24875', 6),
          },
          {
            router: TEST_ADDRESSES.UNAPPROVED,
            tokenIn: TEST_ADDRESSES.USDC,
            tokenOut: TEST_ADDRESSES.WETH,
            amountOutMin: ethers.parseEther('9.95'),
          },
        ] as FlashLoanSwapStep[],
      });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, EMPTY_ROUTERS);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_NO_APPROVED_ROUTERS]');
    });

    it('should pass validation with case-insensitive router matching', () => {
      const request = createValidRequest({
        swapPath: [
          {
            router: '0x' + TEST_ADDRESSES.ROUTER_A.slice(2).toUpperCase(),
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: ethers.parseUnits('24875', 6),
          },
          {
            router: TEST_ADDRESSES.ROUTER_B.toLowerCase(),
            tokenIn: TEST_ADDRESSES.USDC,
            tokenOut: TEST_ADDRESSES.WETH,
            amountOutMin: ethers.parseEther('9.95'),
          },
        ] as FlashLoanSwapStep[],
      });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(true);
    });

    it('should pass validation with case-insensitive asset and token matching', () => {
      const request = createValidRequest({
        asset: TEST_ADDRESSES.WETH.toLowerCase(),
        swapPath: [
          {
            router: TEST_ADDRESSES.ROUTER_A,
            tokenIn: '0x' + TEST_ADDRESSES.WETH.slice(2).toUpperCase(),
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: ethers.parseUnits('24875', 6),
          },
          {
            router: TEST_ADDRESSES.ROUTER_A,
            tokenIn: TEST_ADDRESSES.USDC,
            tokenOut: TEST_ADDRESSES.WETH.toLowerCase(),
            amountOutMin: ethers.parseEther('9.95'),
          },
        ] as FlashLoanSwapStep[],
      });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(true);
    });
  });

  describe('chain mismatch', () => {
    it('should reject when request chain does not match provider chain', () => {
      const request = createValidRequest({ chain: 'polygon' });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_CHAIN_MISMATCH]');
      expect(result.error).toContain('polygon');
      expect(result.error).toContain('ethereum');
    });

    it('should reject with detailed error message', () => {
      const request = createValidRequest({ chain: 'zksync' });

      const result = validateFlashLoanRequest(request, 'arbitrum', APPROVED_ROUTERS);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('zksync');
      expect(result.error).toContain('arbitrum');
    });
  });

  describe('invalid asset', () => {
    it('should reject invalid asset address', () => {
      const request = createValidRequest({ asset: 'not-an-address' });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_INVALID_ASSET]');
    });

    it('should reject empty asset address', () => {
      const request = createValidRequest({ asset: '' });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_INVALID_ASSET]');
    });

    it('should reject short hex string', () => {
      const request = createValidRequest({ asset: '0x123' });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_INVALID_ASSET]');
    });
  });

  describe('zero amount', () => {
    it('should reject zero loan amount', () => {
      const request = createValidRequest({ amount: 0n });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_ZERO_AMOUNT]');
    });

    it('should accept non-zero amount', () => {
      const request = createValidRequest({ amount: 1n });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(true);
    });
  });

  describe('empty swap path', () => {
    it('should reject empty swap path', () => {
      const request = createValidRequest({ swapPath: [] });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_EMPTY_PATH]');
    });
  });

  describe('invalid router addresses', () => {
    it('should reject swap step with invalid router address', () => {
      const request = createValidRequest({
        swapPath: [
          {
            router: 'invalid-router',
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: 1n,
          },
          {
            router: TEST_ADDRESSES.ROUTER_A,
            tokenIn: TEST_ADDRESSES.USDC,
            tokenOut: TEST_ADDRESSES.WETH,
            amountOutMin: ethers.parseEther('9.95'),
          },
        ] as FlashLoanSwapStep[],
      });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_INVALID_ROUTER]');
      expect(result.error).toContain('invalid-router');
    });

    it('should detect invalid router in second step', () => {
      const request = createValidRequest({
        swapPath: [
          {
            router: TEST_ADDRESSES.ROUTER_A,
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: ethers.parseUnits('24875', 6),
          },
          {
            router: 'bad-address',
            tokenIn: TEST_ADDRESSES.USDC,
            tokenOut: TEST_ADDRESSES.WETH,
            amountOutMin: 1n,
          },
        ] as FlashLoanSwapStep[],
      });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_INVALID_ROUTER]');
      expect(result.error).toContain('bad-address');
    });
  });

  describe('unapproved routers', () => {
    it('should reject unapproved router when approval list is non-empty', () => {
      const request = createValidRequest({
        swapPath: [
          {
            router: TEST_ADDRESSES.UNAPPROVED,
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: 1n,
          },
          {
            router: TEST_ADDRESSES.ROUTER_A,
            tokenIn: TEST_ADDRESSES.USDC,
            tokenOut: TEST_ADDRESSES.WETH,
            amountOutMin: ethers.parseEther('9.95'),
          },
        ] as FlashLoanSwapStep[],
      });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_UNAPPROVED_ROUTER]');
      expect(result.error).toContain(TEST_ADDRESSES.UNAPPROVED);
    });

    it('should fail-closed when approval list is empty', () => {
      const request = createValidRequest({
        swapPath: [
          {
            router: TEST_ADDRESSES.UNAPPROVED,
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: ethers.parseUnits('24875', 6),
          },
          {
            router: TEST_ADDRESSES.UNAPPROVED,
            tokenIn: TEST_ADDRESSES.USDC,
            tokenOut: TEST_ADDRESSES.WETH,
            amountOutMin: ethers.parseEther('9.95'),
          },
        ] as FlashLoanSwapStep[],
      });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, EMPTY_ROUTERS);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_NO_APPROVED_ROUTERS]');
    });
  });

  describe('invalid cycle', () => {
    it('should reject path that does not form a cycle', () => {
      const request = createValidRequest({
        swapPath: [
          {
            router: TEST_ADDRESSES.ROUTER_A,
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: ethers.parseUnits('24875', 6),
          },
          {
            router: TEST_ADDRESSES.ROUTER_A,
            tokenIn: TEST_ADDRESSES.USDC,
            tokenOut: TEST_ADDRESSES.DAI, // Ends with DAI, not WETH
            amountOutMin: ethers.parseEther('24875'),
          },
        ] as FlashLoanSwapStep[],
      });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_INVALID_CYCLE]');
    });

    it('should accept valid cycle (same start and end token)', () => {
      const request = createValidRequest({
        swapPath: [
          {
            router: TEST_ADDRESSES.ROUTER_A,
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: ethers.parseUnits('24875', 6),
          },
          {
            router: TEST_ADDRESSES.ROUTER_A,
            tokenIn: TEST_ADDRESSES.USDC,
            tokenOut: TEST_ADDRESSES.WETH,
            amountOutMin: ethers.parseEther('9.95'),
          },
        ] as FlashLoanSwapStep[],
      });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(true);
    });

    it('should accept cycle with case-insensitive comparison', () => {
      const request = createValidRequest({
        swapPath: [
          {
            router: TEST_ADDRESSES.ROUTER_A,
            tokenIn: TEST_ADDRESSES.WETH.toLowerCase(),
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: ethers.parseUnits('24875', 6),
          },
          {
            router: TEST_ADDRESSES.ROUTER_A,
            tokenIn: TEST_ADDRESSES.USDC,
            tokenOut: '0x' + TEST_ADDRESSES.WETH.slice(2).toUpperCase(),
            amountOutMin: ethers.parseEther('9.95'),
          },
        ] as FlashLoanSwapStep[],
      });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(true);
    });
  });

  describe('asset mismatch', () => {
    it('should reject when first swap token does not match flash loan asset', () => {
      const request = createValidRequest({
        asset: TEST_ADDRESSES.WETH,
        swapPath: [
          {
            router: TEST_ADDRESSES.ROUTER_A,
            tokenIn: TEST_ADDRESSES.USDC, // Starts with USDC, not WETH
            tokenOut: TEST_ADDRESSES.DAI,
            amountOutMin: 1n,
          },
          {
            router: TEST_ADDRESSES.ROUTER_A,
            tokenIn: TEST_ADDRESSES.DAI,
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: 1n,
          },
        ] as FlashLoanSwapStep[],
      });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_ASSET_MISMATCH]');
    });

    it('should accept when asset matches first token (case-insensitive)', () => {
      const request = createValidRequest({
        asset: TEST_ADDRESSES.WETH.toLowerCase(),
        swapPath: [
          {
            router: TEST_ADDRESSES.ROUTER_A,
            tokenIn: '0x' + TEST_ADDRESSES.WETH.slice(2).toUpperCase(),
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: ethers.parseUnits('24875', 6),
          },
          {
            router: TEST_ADDRESSES.ROUTER_A,
            tokenIn: TEST_ADDRESSES.USDC,
            tokenOut: TEST_ADDRESSES.WETH,
            amountOutMin: ethers.parseEther('9.95'),
          },
        ] as FlashLoanSwapStep[],
      });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(true);
    });
  });

  describe('validation priority (first error wins)', () => {
    it('should check chain first', () => {
      const request = createValidRequest({
        chain: 'wrong-chain',
        asset: 'invalid',
        amount: 0n,
        swapPath: [],
      });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_CHAIN_MISMATCH]');
    });

    it('should check asset after chain', () => {
      const request = createValidRequest({
        asset: 'invalid',
        amount: 0n,
        swapPath: [],
      });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_INVALID_ASSET]');
    });

    it('should check amount after asset', () => {
      const request = createValidRequest({
        amount: 0n,
        swapPath: [],
      });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_ZERO_AMOUNT]');
    });

    it('should check empty path after amount', () => {
      const request = createValidRequest({
        swapPath: [],
      });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_EMPTY_PATH]');
    });
  });

  describe('single-step paths', () => {
    it('should validate single-step same-token path (direct arbitrage)', () => {
      const request = createValidRequest({
        swapPath: [
          {
            router: TEST_ADDRESSES.ROUTER_A,
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.WETH,
            amountOutMin: ethers.parseEther('9.95'),
          },
        ] as FlashLoanSwapStep[],
      });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(true);
    });

    it('should reject single-step path where tokenOut does not match tokenIn', () => {
      const request = createValidRequest({
        swapPath: [
          {
            router: TEST_ADDRESSES.ROUTER_A,
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.USDC, // Not a cycle
            amountOutMin: ethers.parseUnits('24875', 6),
          },
        ] as FlashLoanSwapStep[],
      });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_INVALID_CYCLE]');
    });
  });

  describe('large amounts', () => {
    it('should accept very large loan amount', () => {
      const request = createValidRequest({
        amount: 2n ** 128n, // Very large but valid bigint
      });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(true);
    });

    it('should accept 1 wei as loan amount', () => {
      const request = createValidRequest({ amount: 1n });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(true);
    });
  });

  describe('error message format', () => {
    it('should include both chain names in chain mismatch error', () => {
      const request = createValidRequest({ chain: 'avalanche' });

      const result = validateFlashLoanRequest(request, 'polygon', APPROVED_ROUTERS);

      expect(result.valid).toBe(false);
      expect(result.error).toBe(
        "[ERR_CHAIN_MISMATCH] Request chain 'avalanche' does not match provider chain 'polygon'"
      );
    });

    it('should include exact router address in unapproved router error', () => {
      const request = createValidRequest({
        swapPath: [
          {
            router: TEST_ADDRESSES.UNAPPROVED,
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: 1n,
          },
          {
            router: TEST_ADDRESSES.ROUTER_A,
            tokenIn: TEST_ADDRESSES.USDC,
            tokenOut: TEST_ADDRESSES.WETH,
            amountOutMin: ethers.parseEther('9.95'),
          },
        ] as FlashLoanSwapStep[],
      });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(false);
      expect(result.error).toBe(
        `[ERR_UNAPPROVED_ROUTER] Router not approved: ${TEST_ADDRESSES.UNAPPROVED}`
      );
    });

    it('should include exact router address in invalid router error', () => {
      const request = createValidRequest({
        swapPath: [
          {
            router: '0xBAD',
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: 1n,
          },
          {
            router: TEST_ADDRESSES.ROUTER_A,
            tokenIn: TEST_ADDRESSES.USDC,
            tokenOut: TEST_ADDRESSES.WETH,
            amountOutMin: ethers.parseEther('9.95'),
          },
        ] as FlashLoanSwapStep[],
      });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('[ERR_INVALID_ROUTER] Invalid router address: 0xBAD');
    });
  });

  describe('mixed case router sets', () => {
    it('should match routers case-insensitively against a mixed-case approved set', () => {
      const mixedCaseSet = new Set([
        TEST_ADDRESSES.ROUTER_A.toLowerCase(),
        TEST_ADDRESSES.ROUTER_B.toLowerCase(),
      ]);

      const request = createValidRequest({
        swapPath: [
          {
            router: TEST_ADDRESSES.ROUTER_A.toUpperCase().replace('0X', '0x'),
            tokenIn: TEST_ADDRESSES.WETH,
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: ethers.parseUnits('24875', 6),
          },
          {
            router: TEST_ADDRESSES.ROUTER_B,
            tokenIn: TEST_ADDRESSES.USDC,
            tokenOut: TEST_ADDRESSES.WETH,
            amountOutMin: ethers.parseEther('9.95'),
          },
        ] as FlashLoanSwapStep[],
      });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, mixedCaseSet);

      expect(result.valid).toBe(true);
    });
  });

  describe('zero address handling', () => {
    it('should accept zero address as valid asset (ethers considers it valid)', () => {
      const zeroAddress = '0x0000000000000000000000000000000000000000';
      const request = createValidRequest({
        asset: zeroAddress,
        swapPath: [
          {
            router: TEST_ADDRESSES.ROUTER_A,
            tokenIn: zeroAddress,
            tokenOut: TEST_ADDRESSES.USDC,
            amountOutMin: 1n,
          },
          {
            router: TEST_ADDRESSES.ROUTER_A,
            tokenIn: TEST_ADDRESSES.USDC,
            tokenOut: zeroAddress,
            amountOutMin: 1n,
          },
        ] as FlashLoanSwapStep[],
      });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      // Zero address passes ethers.isAddress() check
      expect(result.valid).toBe(true);
    });
  });

  describe('return type correctness', () => {
    it('should return valid: true with no error property for valid requests', () => {
      const request = createValidRequest();

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result).toEqual({ valid: true });
      expect(Object.keys(result)).toEqual(['valid']);
    });

    it('should return valid: false with error string for invalid requests', () => {
      const request = createValidRequest({ amount: 0n });

      const result = validateFlashLoanRequest(request, PROVIDER_CHAIN, APPROVED_ROUTERS);

      expect(result.valid).toBe(false);
      expect(typeof result.error).toBe('string');
      expect(result.error!.length).toBeGreaterThan(0);
    });
  });
});
