/**
 * Flash Loan Providers Tests
 *
 * Tests for the flash loan provider system:
 * - AaveV3FlashLoanProvider: Aave V3 flash loan provider
 * - BalancerV2FlashLoanProvider: Balancer V2 flash loan provider (0% fee)
 * - UnsupportedFlashLoanProvider: Placeholder for unimplemented protocols
 *
 * @see services/execution-engine/src/strategies/flash-loan-providers/
 */

import { ethers } from 'ethers';
import { AaveV3FlashLoanProvider } from '../../../src/strategies/flash-loan-providers/aave-v3.provider';
import { BalancerV2FlashLoanProvider } from '../../../src/strategies/flash-loan-providers/balancer-v2.provider';
import { UnsupportedFlashLoanProvider } from '../../../src/strategies/flash-loan-providers/unsupported.provider';
import type {
  FlashLoanRequest,
  FlashLoanSwapStep,
} from '../../../src/strategies/flash-loan-providers/types';

// =============================================================================
// Test Constants
// =============================================================================

// Valid Ethereum addresses for testing
const VALID_CONTRACT_ADDRESS = '0x1111111111111111111111111111111111111111';
const VALID_POOL_ADDRESS = '0x2222222222222222222222222222222222222222';
const VALID_ROUTER_ADDRESS = '0x3333333333333333333333333333333333333333';
const VALID_TOKEN_ADDRESS = '0x4444444444444444444444444444444444444444';
const VALID_TOKEN_B_ADDRESS = '0x5555555555555555555555555555555555555555';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const VALID_INITIATOR = '0x6666666666666666666666666666666666666666';

function createValidSwapPath(): FlashLoanSwapStep[] {
  return [
    {
      router: VALID_ROUTER_ADDRESS,
      tokenIn: VALID_TOKEN_ADDRESS,
      tokenOut: VALID_TOKEN_B_ADDRESS,
      amountOutMin: 1000n,
    },
    {
      router: VALID_ROUTER_ADDRESS,
      tokenIn: VALID_TOKEN_B_ADDRESS,
      tokenOut: VALID_TOKEN_ADDRESS,
      amountOutMin: 900n,
    },
  ];
}

function createValidRequest(overrides?: Partial<FlashLoanRequest>): FlashLoanRequest {
  return {
    asset: VALID_TOKEN_ADDRESS,
    amount: 1000000000000000000n, // 1 ETH
    chain: 'ethereum',
    swapPath: createValidSwapPath(),
    minProfit: 100000000000000n, // 0.0001 ETH
    initiator: VALID_INITIATOR,
    ...overrides,
  };
}

// =============================================================================
// AaveV3FlashLoanProvider
// =============================================================================

describe('AaveV3FlashLoanProvider', () => {
  let provider: AaveV3FlashLoanProvider;

  beforeEach(() => {
    provider = new AaveV3FlashLoanProvider({
      chain: 'ethereum',
      poolAddress: VALID_POOL_ADDRESS,
      contractAddress: VALID_CONTRACT_ADDRESS,
      approvedRouters: [VALID_ROUTER_ADDRESS],
    });
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('should create an instance with valid config', () => {
      expect(provider).toBeDefined();
      expect(provider.protocol).toBe('aave_v3');
      expect(provider.chain).toBe('ethereum');
      expect(provider.poolAddress).toBe(VALID_POOL_ADDRESS);
    });

    it('should throw on invalid contract address', () => {
      expect(() => new AaveV3FlashLoanProvider({
        chain: 'ethereum',
        poolAddress: VALID_POOL_ADDRESS,
        contractAddress: 'invalid-address',
        approvedRouters: [],
      })).toThrow('[ERR_CONFIG]');
    });

    it('should throw on invalid pool address', () => {
      expect(() => new AaveV3FlashLoanProvider({
        chain: 'ethereum',
        poolAddress: 'not-an-address',
        contractAddress: VALID_CONTRACT_ADDRESS,
        approvedRouters: [],
      })).toThrow('[ERR_CONFIG]');
    });
  });

  // =========================================================================
  // isAvailable
  // =========================================================================

  describe('isAvailable', () => {
    it('should return true for valid contract address', () => {
      expect(provider.isAvailable()).toBe(true);
    });

    it('should return false for zero contract address', () => {
      const zeroProvider = new AaveV3FlashLoanProvider({
        chain: 'ethereum',
        poolAddress: VALID_POOL_ADDRESS,
        contractAddress: ZERO_ADDRESS,
        approvedRouters: [],
      });
      expect(zeroProvider.isAvailable()).toBe(false);
    });
  });

  // =========================================================================
  // getCapabilities
  // =========================================================================

  describe('getCapabilities', () => {
    it('should return fully supported capabilities', () => {
      const caps = provider.getCapabilities();
      expect(caps.status).toBe('fully_supported');
      expect(caps.supportsMultiHop).toBe(true);
      expect(caps.supportsMultiAsset).toBe(false);
    });
  });

  // =========================================================================
  // calculateFee
  // =========================================================================

  describe('calculateFee', () => {
    it('should calculate fee based on basis points', () => {
      const feeInfo = provider.calculateFee(1000000000000000000n); // 1 ETH

      expect(feeInfo.protocol).toBe('aave_v3');
      expect(feeInfo.feeBps).toBeGreaterThan(0);
      expect(feeInfo.feeAmount).toBeGreaterThan(0n);
    });

    it('should return zero fee for zero amount', () => {
      const feeInfo = provider.calculateFee(0n);
      expect(feeInfo.feeAmount).toBe(0n);
    });

    it('should use fee override when provided', () => {
      const overrideProvider = new AaveV3FlashLoanProvider({
        chain: 'ethereum',
        poolAddress: VALID_POOL_ADDRESS,
        contractAddress: VALID_CONTRACT_ADDRESS,
        approvedRouters: [],
        feeOverride: 20, // 0.20%
      });

      const feeInfo = overrideProvider.calculateFee(10000n);
      expect(feeInfo.feeBps).toBe(20);
    });
  });

  // =========================================================================
  // validate
  // =========================================================================

  describe('validate', () => {
    it('should validate a correct request', () => {
      const result = provider.validate(createValidRequest());
      expect(result.valid).toBe(true);
    });

    it('should reject request with wrong chain', () => {
      const result = provider.validate(createValidRequest({ chain: 'bsc' }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('CHAIN_MISMATCH');
    });

    it('should reject request with invalid asset address', () => {
      const result = provider.validate(createValidRequest({ asset: 'not-an-address' }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('INVALID_ASSET');
    });

    it('should reject request with zero amount', () => {
      const result = provider.validate(createValidRequest({ amount: 0n }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('ZERO_AMOUNT');
    });

    it('should reject request with empty swap path', () => {
      const result = provider.validate(createValidRequest({ swapPath: [] }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('EMPTY_PATH');
    });

    it('should reject request with unapproved router', () => {
      const badRouter = '0x9999999999999999999999999999999999999999';
      const result = provider.validate(createValidRequest({
        swapPath: [
          { router: badRouter, tokenIn: VALID_TOKEN_ADDRESS, tokenOut: VALID_TOKEN_B_ADDRESS, amountOutMin: 100n },
          { router: badRouter, tokenIn: VALID_TOKEN_B_ADDRESS, tokenOut: VALID_TOKEN_ADDRESS, amountOutMin: 100n },
        ],
      }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('UNAPPROVED_ROUTER');
    });
  });

  // =========================================================================
  // buildTransaction
  // =========================================================================

  describe('buildTransaction', () => {
    it('should return a transaction request with correct to address', () => {
      const tx = provider.buildTransaction(createValidRequest(), VALID_INITIATOR);
      expect(tx.to).toBe(VALID_CONTRACT_ADDRESS);
      expect(tx.from).toBe(VALID_INITIATOR);
      expect(tx.data).toBeDefined();
      expect(typeof tx.data).toBe('string');
    });
  });
});

// =============================================================================
// BalancerV2FlashLoanProvider
// =============================================================================

describe('BalancerV2FlashLoanProvider', () => {
  let provider: BalancerV2FlashLoanProvider;

  beforeEach(() => {
    provider = new BalancerV2FlashLoanProvider({
      chain: 'ethereum',
      poolAddress: VALID_POOL_ADDRESS,
      contractAddress: VALID_CONTRACT_ADDRESS,
      approvedRouters: [VALID_ROUTER_ADDRESS],
    });
  });

  describe('constructor', () => {
    it('should create an instance with valid config', () => {
      expect(provider.protocol).toBe('balancer_v2');
      expect(provider.chain).toBe('ethereum');
    });

    it('should throw on invalid contract address', () => {
      expect(() => new BalancerV2FlashLoanProvider({
        chain: 'ethereum',
        poolAddress: VALID_POOL_ADDRESS,
        contractAddress: 'bad',
        approvedRouters: [],
      })).toThrow('[ERR_CONFIG]');
    });
  });

  describe('calculateFee', () => {
    it('should return zero fee (Balancer V2 charges 0%)', () => {
      const feeInfo = provider.calculateFee(1000000000000000000n);
      expect(feeInfo.feeBps).toBe(0);
      expect(feeInfo.feeAmount).toBe(0n);
      expect(feeInfo.protocol).toBe('balancer_v2');
    });
  });

  describe('getCapabilities', () => {
    it('should return fully supported capabilities', () => {
      const caps = provider.getCapabilities();
      expect(caps.status).toBe('fully_supported');
      expect(caps.supportsMultiHop).toBe(true);
    });
  });

  describe('validate', () => {
    it('should validate a correct request', () => {
      const result = provider.validate(createValidRequest());
      expect(result.valid).toBe(true);
    });

    it('should reject request with wrong chain', () => {
      const result = provider.validate(createValidRequest({ chain: 'polygon' }));
      expect(result.valid).toBe(false);
    });
  });

  describe('buildTransaction', () => {
    it('should return a transaction request targeting the contract', () => {
      const tx = provider.buildTransaction(createValidRequest(), VALID_INITIATOR);
      expect(tx.to).toBe(VALID_CONTRACT_ADDRESS);
      expect(tx.from).toBe(VALID_INITIATOR);
    });
  });
});

// =============================================================================
// UnsupportedFlashLoanProvider
// =============================================================================

describe('UnsupportedFlashLoanProvider', () => {
  let provider: UnsupportedFlashLoanProvider;

  beforeEach(() => {
    provider = new UnsupportedFlashLoanProvider({
      protocol: 'spookyswap',
      chain: 'fantom',
      poolAddress: VALID_POOL_ADDRESS,
    });
  });

  describe('isAvailable', () => {
    it('should always return false', () => {
      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe('getCapabilities', () => {
    it('should report not_implemented status', () => {
      const caps = provider.getCapabilities();
      expect(caps.status).toBe('not_implemented');
      expect(caps.supportsMultiHop).toBe(false);
    });
  });

  describe('calculateFee', () => {
    it('should still calculate fees for profitability estimation', () => {
      const feeInfo = provider.calculateFee(10000n);
      expect(feeInfo.feeBps).toBeGreaterThan(0);
      expect(feeInfo.feeAmount).toBeGreaterThan(0n);
      expect(feeInfo.protocol).toBe('spookyswap');
    });
  });

  describe('validate', () => {
    it('should always return invalid with unsupported protocol error', () => {
      const result = provider.validate(createValidRequest({ chain: 'fantom' }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('UNSUPPORTED_PROTOCOL');
    });
  });

  describe('buildCalldata', () => {
    it('should throw not implemented error', () => {
      expect(() => provider.buildCalldata(createValidRequest({ chain: 'fantom' }))).toThrow(
        /not yet implemented/,
      );
    });
  });

  describe('buildTransaction', () => {
    it('should throw not implemented error', () => {
      expect(() => provider.buildTransaction(createValidRequest({ chain: 'fantom' }), VALID_INITIATOR)).toThrow(
        /not yet implemented/,
      );
    });
  });

  describe('estimateGas', () => {
    it('should throw not implemented error', async () => {
      const mockProvider = {} as ethers.JsonRpcProvider;
      await expect(
        provider.estimateGas(createValidRequest({ chain: 'fantom' }), mockProvider),
      ).rejects.toThrow(/not yet implemented/);
    });
  });
});
