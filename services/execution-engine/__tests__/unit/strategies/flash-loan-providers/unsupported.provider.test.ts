/**
 * Tests for UnsupportedFlashLoanProvider
 *
 * Fix 8.1: Ensures the unsupported provider behaves correctly:
 * - Fee calculation works (for profitability estimation)
 * - Validation always fails with clear message
 * - Execution methods throw with implementation roadmap
 *
 * @see unsupported.provider.ts
 */

// Mock ethers and @arbitrage/config to prevent deep import chain through service-config.ts
jest.mock('ethers', () => ({
  ethers: {
    Interface: jest.fn().mockImplementation(() => ({
      encodeFunctionData: jest.fn().mockReturnValue('0x1234'),
    })),
    isAddress: jest.fn().mockReturnValue(true),
    ZeroAddress: '0x0000000000000000000000000000000000000000',
  },
}));

jest.mock('@arbitrage/config', () => {
  const BPS_DENOMINATOR = BigInt(10000);
  return {
    __esModule: true,
    getBpsDenominatorBigInt: () => BPS_DENOMINATOR,
  };
});

import { UnsupportedFlashLoanProvider } from '../../../../src/strategies/flash-loan-providers/unsupported.provider';
import type { FlashLoanRequest, FlashLoanSwapStep } from '../../../../src/strategies/flash-loan-providers/types';

describe('UnsupportedFlashLoanProvider', () => {
  // Test fixtures
  const pancakeSwapConfig = {
    protocol: 'pancakeswap_v3' as const,
    chain: 'bsc',
    poolAddress: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4',
  };

  const spookySwapConfig = {
    protocol: 'spookyswap' as const,
    chain: 'fantom',
    poolAddress: '0xF491e7B69E4244ad4002BC14e878a34207E38c29',
  };

  const syncSwapConfig = {
    protocol: 'syncswap' as const,
    chain: 'zksync',
    poolAddress: '0x2da10A1e27bF85cEdD8FFb1AbBe97e53391C0295',
  };

  const createTestRequest = (chain: string): FlashLoanRequest => ({
    asset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    amount: 1000000000000000000n, // 1 ETH
    chain,
    swapPath: [
      {
        router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
        tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        amountOutMin: 0n,
      },
    ] as FlashLoanSwapStep[],
    minProfit: 0n,
    initiator: '0x1234567890123456789012345678901234567890',
  });

  describe('isAvailable', () => {
    it('should always return false for PancakeSwap V3', () => {
      const provider = new UnsupportedFlashLoanProvider(pancakeSwapConfig);
      expect(provider.isAvailable()).toBe(false);
    });

    it('should always return false for SpookySwap', () => {
      const provider = new UnsupportedFlashLoanProvider(spookySwapConfig);
      expect(provider.isAvailable()).toBe(false);
    });

    it('should always return false for SyncSwap', () => {
      const provider = new UnsupportedFlashLoanProvider(syncSwapConfig);
      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe('getCapabilities', () => {
    it('should return not_implemented status', () => {
      const provider = new UnsupportedFlashLoanProvider(pancakeSwapConfig);
      const capabilities = provider.getCapabilities();

      expect(capabilities.status).toBe('not_implemented');
      expect(capabilities.supportsMultiHop).toBe(false);
      expect(capabilities.supportsMultiAsset).toBe(false);
      expect(capabilities.maxLoanAmount).toBe(0n);
      expect(capabilities.supportedTokens).toEqual([]);
    });
  });

  describe('calculateFee', () => {
    it('should calculate correct fee for PancakeSwap V3 (0.25%)', () => {
      const provider = new UnsupportedFlashLoanProvider(pancakeSwapConfig);
      const amount = 1000000000000000000n; // 1 ETH

      const feeInfo = provider.calculateFee(amount);

      expect(feeInfo.feeBps).toBe(25); // 0.25%
      expect(feeInfo.feeAmount).toBe(2500000000000000n); // 0.0025 ETH
      expect(feeInfo.protocol).toBe('pancakeswap_v3');
    });

    it('should calculate correct fee for SpookySwap (0.30%)', () => {
      const provider = new UnsupportedFlashLoanProvider(spookySwapConfig);
      const amount = 1000000000000000000n; // 1 ETH

      const feeInfo = provider.calculateFee(amount);

      expect(feeInfo.feeBps).toBe(30); // 0.30%
      expect(feeInfo.feeAmount).toBe(3000000000000000n); // 0.003 ETH
      expect(feeInfo.protocol).toBe('spookyswap');
    });

    it('should calculate correct fee for SyncSwap (0.30%)', () => {
      const provider = new UnsupportedFlashLoanProvider(syncSwapConfig);
      const amount = 1000000000000000000n; // 1 ETH

      const feeInfo = provider.calculateFee(amount);

      expect(feeInfo.feeBps).toBe(30); // 0.30%
      expect(feeInfo.feeAmount).toBe(3000000000000000n); // 0.003 ETH
      expect(feeInfo.protocol).toBe('syncswap');
    });

    it('should allow custom fee override', () => {
      const provider = new UnsupportedFlashLoanProvider({
        ...pancakeSwapConfig,
        feeBps: 50, // 0.50%
      });
      const amount = 1000000000000000000n;

      const feeInfo = provider.calculateFee(amount);

      expect(feeInfo.feeBps).toBe(50);
      expect(feeInfo.feeAmount).toBe(5000000000000000n); // 0.005 ETH
    });

    it('should handle large amounts without overflow', () => {
      const provider = new UnsupportedFlashLoanProvider(pancakeSwapConfig);
      const largeAmount = 1000000000000000000000000n; // 1 million ETH

      const feeInfo = provider.calculateFee(largeAmount);

      expect(feeInfo.feeAmount).toBe(2500000000000000000000n); // 2500 ETH (0.25%)
    });
  });

  describe('validate', () => {
    it('should always return invalid with ERR_UNSUPPORTED_PROTOCOL', () => {
      const provider = new UnsupportedFlashLoanProvider(pancakeSwapConfig);
      const request = createTestRequest('bsc');

      const result = provider.validate(request);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('[ERR_UNSUPPORTED_PROTOCOL]');
      expect(result.error).toContain("pancakeswap_v3");
      expect(result.error).toContain('bsc');
    });

    it('should include protocol name in error message', () => {
      const provider = new UnsupportedFlashLoanProvider(spookySwapConfig);
      const request = createTestRequest('fantom');

      const result = provider.validate(request);

      expect(result.error).toContain('spookyswap');
      expect(result.error).toContain('fantom');
    });
  });

  describe('buildCalldata', () => {
    it('should throw with detailed implementation roadmap for PancakeSwap', () => {
      const provider = new UnsupportedFlashLoanProvider(pancakeSwapConfig);
      const request = createTestRequest('bsc');

      expect(() => provider.buildCalldata(request)).toThrow();

      try {
        provider.buildCalldata(request);
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain('pancakeswap_v3');
        expect(message).toContain('PancakeSwapFlashArbitrage');
        expect(message).toContain('IPancakeV3FlashCallback');
        expect(message).toContain('Currently supported: Aave V3');
      }
    });

    it('should throw with SpookySwap-specific requirements', () => {
      const provider = new UnsupportedFlashLoanProvider(spookySwapConfig);
      const request = createTestRequest('fantom');

      try {
        provider.buildCalldata(request);
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain('SpookySwapFlashArbitrage');
        expect(message).toContain('IUniswapV2Callee');
        expect(message).toContain('Fantom');
      }
    });

    it('should throw with SyncSwap-specific requirements', () => {
      const provider = new UnsupportedFlashLoanProvider(syncSwapConfig);
      const request = createTestRequest('zksync');

      try {
        provider.buildCalldata(request);
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain('SyncSwapFlashArbitrage');
        expect(message).toContain('ISyncSwapCallback');
        expect(message).toContain('zkSync Era');
      }
    });
  });

  describe('buildTransaction', () => {
    it('should throw with implementation roadmap', () => {
      const provider = new UnsupportedFlashLoanProvider(pancakeSwapConfig);
      const request = createTestRequest('bsc');

      expect(() =>
        provider.buildTransaction(request, '0x1234567890123456789012345678901234567890')
      ).toThrow('not yet implemented');
    });
  });

  describe('estimateGas', () => {
    it('should throw with implementation roadmap', async () => {
      const provider = new UnsupportedFlashLoanProvider(pancakeSwapConfig);
      const request = createTestRequest('bsc');
      const mockProvider = {} as any;

      await expect(provider.estimateGas(request, mockProvider)).rejects.toThrow(
        'not yet implemented'
      );
    });
  });

  describe('protocol and chain properties', () => {
    it('should expose protocol correctly', () => {
      const provider = new UnsupportedFlashLoanProvider(pancakeSwapConfig);
      expect(provider.protocol).toBe('pancakeswap_v3');
    });

    it('should expose chain correctly', () => {
      const provider = new UnsupportedFlashLoanProvider(syncSwapConfig);
      expect(provider.chain).toBe('zksync');
    });

    it('should expose poolAddress correctly', () => {
      const provider = new UnsupportedFlashLoanProvider(spookySwapConfig);
      expect(provider.poolAddress).toBe('0xF491e7B69E4244ad4002BC14e878a34207E38c29');
    });
  });
});
