/**
 * Unit Tests for FlashLoanProviderFactory
 *
 * Tests the factory's ability to:
 * - Create appropriate providers based on chain configuration
 * - Cache providers for reuse
 * - Handle missing or invalid configurations
 * - Report support status accurately
 *
 * @see provider-factory.ts
 */

import { FlashLoanProviderFactory, createFlashLoanProviderFactory } from '../../../../src/strategies/flash-loan-providers/provider-factory';
import { AaveV3FlashLoanProvider } from '../../../../src/strategies/flash-loan-providers/aave-v3.provider';
import { UnsupportedFlashLoanProvider } from '../../../../src/strategies/flash-loan-providers/unsupported.provider';
import type { FlashLoanProviderConfig } from '../../../../src/strategies/flash-loan-providers/types';
import type { Logger } from '../../../../src/types';

// Mock the config module
jest.mock('@arbitrage/config', () => ({
  FLASH_LOAN_PROVIDERS: {
    ethereum: {
      address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', // Aave V3 Pool
      protocol: 'aave_v3',
      fee: 9, // 0.09%
    },
    arbitrum: {
      address: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', // Aave V3 Pool on Arbitrum
      protocol: 'aave_v3',
      fee: 9,
    },
    bsc: {
      address: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4', // PancakeSwap
      protocol: 'pancakeswap_v3',
      fee: 25,
    },
    fantom: {
      address: '0xF491e7B69E4244ad4002BC14e878a34207E38c29', // SpookySwap
      protocol: 'spookyswap',
      fee: 30,
    },
  },
  // Fix: Add FLASH_LOAN_ARBITRAGE_ABI to mock (required by aave-v3.provider.ts)
  FLASH_LOAN_ARBITRAGE_ABI: [
    'function executeArbitrage(address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath, uint256 minProfit) external',
    'function calculateExpectedProfit(address asset, uint256 amount, tuple(address router, address tokenIn, address tokenOut, uint256 amountOutMin)[] swapPath) external view returns (uint256 expectedProfit, uint256 flashLoanFee)',
  ],
  // Fix: Add other required constants
  AAVE_V3_FEE_BPS: 9,
  getBpsDenominatorBigInt: () => BigInt(10000),
  getAaveV3FeeBpsBigInt: () => BigInt(9),
}));

// =============================================================================
// Test Utilities
// =============================================================================

const createMockLogger = (): Logger => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
});

const createValidConfig = (): FlashLoanProviderConfig => ({
  contractAddresses: {
    ethereum: '0x1234567890123456789012345678901234567890',
    arbitrum: '0x2345678901234567890123456789012345678901',
  },
  approvedRouters: {
    ethereum: ['0xRouter1', '0xRouter2'],
    arbitrum: ['0xRouter3'],
  },
});

// =============================================================================
// FlashLoanProviderFactory Tests
// =============================================================================

describe('FlashLoanProviderFactory', () => {
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = createMockLogger();
  });

  describe('constructor', () => {
    it('should create factory with valid config', () => {
      const config = createValidConfig();
      const factory = new FlashLoanProviderFactory(mockLogger, config);

      expect(factory).toBeDefined();
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should log warning for empty contract addresses', () => {
      const config: FlashLoanProviderConfig = {
        contractAddresses: {},
        approvedRouters: {},
      };
      new FlashLoanProviderFactory(mockLogger, config);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('No FlashLoanArbitrage contract addresses configured')
      );
    });
  });

  describe('getProvider', () => {
    it('should create Aave V3 provider for ethereum', () => {
      const config = createValidConfig();
      const factory = new FlashLoanProviderFactory(mockLogger, config);

      const provider = factory.getProvider('ethereum');

      expect(provider).toBeDefined();
      expect(provider).toBeInstanceOf(AaveV3FlashLoanProvider);
    });

    it('should create Aave V3 provider for arbitrum', () => {
      const config = createValidConfig();
      const factory = new FlashLoanProviderFactory(mockLogger, config);

      const provider = factory.getProvider('arbitrum');

      expect(provider).toBeDefined();
      expect(provider).toBeInstanceOf(AaveV3FlashLoanProvider);
    });

    it('should create UnsupportedFlashLoanProvider for bsc (PancakeSwap)', () => {
      const config = createValidConfig();
      const factory = new FlashLoanProviderFactory(mockLogger, config);

      const provider = factory.getProvider('bsc');

      expect(provider).toBeDefined();
      expect(provider).toBeInstanceOf(UnsupportedFlashLoanProvider);
    });

    it('should create UnsupportedFlashLoanProvider for fantom (SpookySwap)', () => {
      const config = createValidConfig();
      const factory = new FlashLoanProviderFactory(mockLogger, config);

      const provider = factory.getProvider('fantom');

      expect(provider).toBeDefined();
      expect(provider).toBeInstanceOf(UnsupportedFlashLoanProvider);
    });

    it('should return undefined for unconfigured chain', () => {
      const config = createValidConfig();
      const factory = new FlashLoanProviderFactory(mockLogger, config);

      const provider = factory.getProvider('unknown-chain');

      expect(provider).toBeUndefined();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'No flash loan provider configured for chain',
        { chain: 'unknown-chain' }
      );
    });

    it('should cache providers for reuse', () => {
      const config = createValidConfig();
      const factory = new FlashLoanProviderFactory(mockLogger, config);

      const provider1 = factory.getProvider('ethereum');
      const provider2 = factory.getProvider('ethereum');

      expect(provider1).toBe(provider2); // Same instance
    });

    it('should return undefined for Aave V3 chain without contract address', () => {
      const config: FlashLoanProviderConfig = {
        contractAddresses: {}, // No contract addresses
        approvedRouters: {},
      };
      const factory = new FlashLoanProviderFactory(mockLogger, config);

      const provider = factory.getProvider('ethereum');

      expect(provider).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'No FlashLoanArbitrage contract configured for Aave V3 chain',
        expect.objectContaining({ chain: 'ethereum' })
      );
    });

    it('should return undefined for zero contract address', () => {
      const config: FlashLoanProviderConfig = {
        contractAddresses: {
          ethereum: '0x0000000000000000000000000000000000000000',
        },
        approvedRouters: {},
      };
      const factory = new FlashLoanProviderFactory(mockLogger, config);

      const provider = factory.getProvider('ethereum');

      expect(provider).toBeUndefined();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Zero contract address is invalid'),
        expect.objectContaining({ chain: 'ethereum' })
      );
    });
  });

  describe('isFullySupported', () => {
    it('should return true for Aave V3 chains with contract', () => {
      const config = createValidConfig();
      const factory = new FlashLoanProviderFactory(mockLogger, config);

      expect(factory.isFullySupported('ethereum')).toBe(true);
      expect(factory.isFullySupported('arbitrum')).toBe(true);
    });

    it('should return false for unsupported protocols', () => {
      const config = createValidConfig();
      const factory = new FlashLoanProviderFactory(mockLogger, config);

      expect(factory.isFullySupported('bsc')).toBe(false);
      expect(factory.isFullySupported('fantom')).toBe(false);
    });

    it('should return false for unconfigured chains', () => {
      const config = createValidConfig();
      const factory = new FlashLoanProviderFactory(mockLogger, config);

      expect(factory.isFullySupported('unknown')).toBe(false);
    });

    it('should return false for Aave V3 chains without contract', () => {
      const config: FlashLoanProviderConfig = {
        contractAddresses: {}, // No contract addresses
        approvedRouters: {},
      };
      const factory = new FlashLoanProviderFactory(mockLogger, config);

      expect(factory.isFullySupported('ethereum')).toBe(false);
    });
  });

  describe('getProtocol', () => {
    it('should return correct protocol for configured chains', () => {
      const config = createValidConfig();
      const factory = new FlashLoanProviderFactory(mockLogger, config);

      expect(factory.getProtocol('ethereum')).toBe('aave_v3');
      expect(factory.getProtocol('bsc')).toBe('pancakeswap_v3');
      expect(factory.getProtocol('fantom')).toBe('spookyswap');
    });

    it('should return undefined for unconfigured chains', () => {
      const config = createValidConfig();
      const factory = new FlashLoanProviderFactory(mockLogger, config);

      expect(factory.getProtocol('unknown')).toBeUndefined();
    });
  });

  describe('getSupportStatus', () => {
    it('should return fully_supported for Aave V3 with contract', () => {
      const config = createValidConfig();
      const factory = new FlashLoanProviderFactory(mockLogger, config);

      expect(factory.getSupportStatus('ethereum')).toBe('fully_supported');
    });

    it('should return not_implemented for unsupported protocols', () => {
      const config = createValidConfig();
      const factory = new FlashLoanProviderFactory(mockLogger, config);

      expect(factory.getSupportStatus('bsc')).toBe('not_implemented');
      expect(factory.getSupportStatus('fantom')).toBe('not_implemented');
    });

    it('should return not_implemented for unconfigured chains', () => {
      const config = createValidConfig();
      const factory = new FlashLoanProviderFactory(mockLogger, config);

      expect(factory.getSupportStatus('unknown')).toBe('not_implemented');
    });
  });

  describe('getFullySupportedChains', () => {
    it('should return only chains with Aave V3 and valid contract', () => {
      const config = createValidConfig();
      const factory = new FlashLoanProviderFactory(mockLogger, config);

      const supported = factory.getFullySupportedChains();

      expect(supported).toContain('ethereum');
      expect(supported).toContain('arbitrum');
      expect(supported).not.toContain('bsc');
      expect(supported).not.toContain('fantom');
    });

    it('should exclude chains with zero address', () => {
      const config: FlashLoanProviderConfig = {
        contractAddresses: {
          ethereum: '0x1234567890123456789012345678901234567890',
          arbitrum: '0x0000000000000000000000000000000000000000', // Zero address
        },
        approvedRouters: {},
      };
      const factory = new FlashLoanProviderFactory(mockLogger, config);

      const supported = factory.getFullySupportedChains();

      expect(supported).toContain('ethereum');
      expect(supported).not.toContain('arbitrum');
    });
  });

  describe('getAllConfiguredChains', () => {
    it('should return all chains with flash loan config', () => {
      const config = createValidConfig();
      const factory = new FlashLoanProviderFactory(mockLogger, config);

      const allChains = factory.getAllConfiguredChains();

      expect(allChains).toContain('ethereum');
      expect(allChains).toContain('arbitrum');
      expect(allChains).toContain('bsc');
      expect(allChains).toContain('fantom');
    });
  });

  describe('clearCache', () => {
    it('should clear cached providers', () => {
      const config = createValidConfig();
      const factory = new FlashLoanProviderFactory(mockLogger, config);

      // Cache a provider
      const provider1 = factory.getProvider('ethereum');

      // Clear cache
      factory.clearCache();

      // Get provider again - should be new instance
      const provider2 = factory.getProvider('ethereum');

      expect(provider1).not.toBe(provider2);
    });
  });

  describe('getSupportSummary', () => {
    it('should return summary for all configured chains', () => {
      const config = createValidConfig();
      const factory = new FlashLoanProviderFactory(mockLogger, config);

      const summary = factory.getSupportSummary();

      expect(summary.ethereum).toEqual({
        protocol: 'aave_v3',
        status: 'fully_supported',
        hasContract: true,
      });

      expect(summary.bsc).toEqual({
        protocol: 'pancakeswap_v3',
        status: 'not_implemented',
        hasContract: false,
      });
    });

    it('should show partial_support for Aave V3 without contract', () => {
      const config: FlashLoanProviderConfig = {
        contractAddresses: {}, // No contracts
        approvedRouters: {},
      };
      const factory = new FlashLoanProviderFactory(mockLogger, config);

      const summary = factory.getSupportSummary();

      expect(summary.ethereum.status).toBe('partial_support');
      expect(summary.ethereum.hasContract).toBe(false);
    });
  });
});

// =============================================================================
// Factory Function Tests
// =============================================================================

describe('createFlashLoanProviderFactory', () => {
  it('should create a valid factory instance', () => {
    const mockLogger = createMockLogger();
    const config = createValidConfig();

    const factory = createFlashLoanProviderFactory(mockLogger, config);

    expect(factory).toBeInstanceOf(FlashLoanProviderFactory);
  });
});
