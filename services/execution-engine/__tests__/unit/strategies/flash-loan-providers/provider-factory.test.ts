/**
 * Unit Tests for FlashLoanProviderFactory
 *
 * Tests the factory's ability to:
 * - Create appropriate providers based on chain configuration
 * - Cache providers for reuse
 * - Handle missing or invalid configurations
 * - Report support status accurately
 *
 * Strategy: Mock all provider modules and @arbitrage/config to isolate
 * factory logic from deep import chains.
 *
 * @see provider-factory.ts
 */

// ---------------------------------------------------------------------------
// Mocks — must be before any imports that touch these modules
// ---------------------------------------------------------------------------

// Mock ethers (prevents module-level Interface construction in providers)
// Must use __esModule: true and plain functions (not jest.fn) for moduleNameMapper compatibility
jest.mock('ethers', () => ({
  __esModule: true,
  ethers: {
    Interface: jest.fn().mockImplementation(() => ({
      encodeFunctionData: jest.fn().mockReturnValue('0x1234'),
      decodeFunctionResult: jest.fn().mockReturnValue([]),
    })),
    isAddress: (addr: string) => typeof addr === 'string' && addr.startsWith('0x') && addr.length === 42,
    ZeroAddress: '0x0000000000000000000000000000000000000000',
  },
}));

// Mock @arbitrage/config — the factory reads FLASH_LOAN_PROVIDERS at module level
const MOCK_FLASH_LOAN_PROVIDERS: Record<string, { address: string; protocol: string; fee: number }> = {
  ethereum: { address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', protocol: 'aave_v3', fee: 9 },
  arbitrum: { address: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', protocol: 'aave_v3', fee: 9 },
  polygon: { address: '0xBA12222222228d8Ba445958a75a0704d566BF2C8', protocol: 'balancer_v2', fee: 0 },
  bsc: { address: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4', protocol: 'pancakeswap_v3', fee: 25 },
  zksync: { address: '0x621425a1Ef6abE91058E9712575dcc4258F8d091', protocol: 'syncswap', fee: 30 },
  fantom: { address: '0xF491e7B69E4244ad4002BC14e878a34207E38c29', protocol: 'spookyswap', fee: 30 },
};

jest.mock('@arbitrage/config', () => {
  // BigInt must be inside factory to avoid Jest serialization error
  const BPS_DENOMINATOR = BigInt(10000);
  return {
    __esModule: true,
    FLASH_LOAN_PROVIDERS: MOCK_FLASH_LOAN_PROVIDERS,
    isValidContractAddress: (addr: string | undefined): boolean => {
      if (!addr) return false;
      if (addr === '0x0000000000000000000000000000000000000000') return false;
      return typeof addr === 'string' && addr.startsWith('0x') && addr.length === 42;
    },
    FLASH_LOAN_ARBITRAGE_ABI: ['function executeArbitrage(address,uint256) external'],
    BALANCER_V2_FLASH_ARBITRAGE_ABI: ['function receiveFlashLoan(address[],uint256[]) external'],
    PANCAKESWAP_V3_FLASH_ARBITRAGE_ABI: ['function pancakeV3FlashCallback(uint256,uint256,bytes) external'],
    SYNCSWAP_FLASH_ARBITRAGE_ABI: ['function onFlashLoan(address,address,uint256,uint256,bytes) external'],
    AAVE_V3_FEE_BPS: 9,
    BALANCER_V2_FEE_BPS: 0,
    SYNCSWAP_FEE_BPS: 30,
    getBpsDenominatorBigInt: () => BPS_DENOMINATOR,
    getAaveV3FeeBpsBigInt: () => BigInt(9),
  };
});

// Mock @arbitrage/core to prevent deep import chain
jest.mock('@arbitrage/core', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are set up)
// ---------------------------------------------------------------------------

import {
  FlashLoanProviderFactory,
  createFlashLoanProviderFactory,
} from '../../../../src/strategies/flash-loan-providers/provider-factory';
import { AaveV3FlashLoanProvider } from '../../../../src/strategies/flash-loan-providers/aave-v3.provider';
import { BalancerV2FlashLoanProvider } from '../../../../src/strategies/flash-loan-providers/balancer-v2.provider';
import { PancakeSwapV3FlashLoanProvider } from '../../../../src/strategies/flash-loan-providers/pancakeswap-v3.provider';
import { SyncSwapFlashLoanProvider } from '../../../../src/strategies/flash-loan-providers/syncswap.provider';
import { UnsupportedFlashLoanProvider } from '../../../../src/strategies/flash-loan-providers/unsupported.provider';
import type { FlashLoanProviderConfig } from '../../../../src/strategies/flash-loan-providers/types';

// =============================================================================
// Test Utilities
// =============================================================================

interface MockLogger {
  info: jest.Mock;
  error: jest.Mock;
  warn: jest.Mock;
  debug: jest.Mock;
}

const createMockLogger = (): MockLogger => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
});

/** Config with valid contract addresses for all chains that have supported protocols */
const createFullConfig = (): FlashLoanProviderConfig => ({
  contractAddresses: {
    ethereum: '0x1234567890123456789012345678901234567890',
    arbitrum: '0x2345678901234567890123456789012345678901',
    polygon: '0x3456789012345678901234567890123456789012',
    bsc: '0x4567890123456789012345678901234567890123',
    zksync: '0x5678901234567890123456789012345678901234',
  },
  approvedRouters: {
    ethereum: ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    arbitrum: ['0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    polygon: ['0xcccccccccccccccccccccccccccccccccccccccc'],
    bsc: ['0xdddddddddddddddddddddddddddddddddddddd'],
    zksync: ['0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'],
  },
});

/** Minimal config — only ethereum */
const createMinimalConfig = (): FlashLoanProviderConfig => ({
  contractAddresses: {
    ethereum: '0x1234567890123456789012345678901234567890',
  },
  approvedRouters: {
    ethereum: ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
  },
});

// =============================================================================
// FlashLoanProviderFactory Tests
// =============================================================================

describe('FlashLoanProviderFactory', () => {
  let mockLogger: MockLogger;

  beforeEach(() => {
    mockLogger = createMockLogger();
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('should create factory with valid config', () => {
      const factory = new FlashLoanProviderFactory(mockLogger as any, createFullConfig());
      expect(factory).toBeDefined();
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should log warning for empty contract addresses', () => {
      const config: FlashLoanProviderConfig = {
        contractAddresses: {},
        approvedRouters: {},
      };
      new FlashLoanProviderFactory(mockLogger as any, config);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('No FlashLoanArbitrage contract addresses configured'),
      );
    });
  });

  // =========================================================================
  // getProvider
  // =========================================================================

  describe('getProvider', () => {
    it('should create AaveV3FlashLoanProvider for ethereum', () => {
      const factory = new FlashLoanProviderFactory(mockLogger as any, createFullConfig());
      const provider = factory.getProvider('ethereum');

      expect(provider).toBeDefined();
      expect(provider).toBeInstanceOf(AaveV3FlashLoanProvider);
    });

    it('should create BalancerV2FlashLoanProvider for polygon', () => {
      const factory = new FlashLoanProviderFactory(mockLogger as any, createFullConfig());
      const provider = factory.getProvider('polygon');

      expect(provider).toBeDefined();
      expect(provider).toBeInstanceOf(BalancerV2FlashLoanProvider);
    });

    it('should create PancakeSwapV3FlashLoanProvider for bsc', () => {
      const factory = new FlashLoanProviderFactory(mockLogger as any, createFullConfig());
      const provider = factory.getProvider('bsc');

      expect(provider).toBeDefined();
      expect(provider).toBeInstanceOf(PancakeSwapV3FlashLoanProvider);
    });

    it('should create SyncSwapFlashLoanProvider for zksync', () => {
      const factory = new FlashLoanProviderFactory(mockLogger as any, createFullConfig());
      const provider = factory.getProvider('zksync');

      expect(provider).toBeDefined();
      expect(provider).toBeInstanceOf(SyncSwapFlashLoanProvider);
    });

    it('should create UnsupportedFlashLoanProvider for fantom (spookyswap)', () => {
      const factory = new FlashLoanProviderFactory(mockLogger as any, createFullConfig());
      const provider = factory.getProvider('fantom');

      expect(provider).toBeDefined();
      expect(provider).toBeInstanceOf(UnsupportedFlashLoanProvider);
    });

    it('should return undefined for unconfigured chain', () => {
      const factory = new FlashLoanProviderFactory(mockLogger as any, createFullConfig());
      const provider = factory.getProvider('unknown-chain');

      expect(provider).toBeUndefined();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('No flash loan provider configured'),
        expect.objectContaining({ chain: 'unknown-chain' }),
      );
    });

    it('should return undefined when contract address missing for supported protocol', () => {
      const config: FlashLoanProviderConfig = {
        contractAddresses: {}, // no contracts
        approvedRouters: {},
      };
      const factory = new FlashLoanProviderFactory(mockLogger as any, config);

      // Ethereum has aave_v3 in FLASH_LOAN_PROVIDERS, but no contract address
      const provider = factory.getProvider('ethereum');
      expect(provider).toBeUndefined();
    });

    it('should cache providers for reuse', () => {
      const factory = new FlashLoanProviderFactory(mockLogger as any, createFullConfig());

      const provider1 = factory.getProvider('ethereum');
      const provider2 = factory.getProvider('ethereum');

      expect(provider1).toBe(provider2); // Same reference
    });
  });

  // =========================================================================
  // isFullySupported
  // =========================================================================

  describe('isFullySupported', () => {
    it('should return true for Aave V3 chains with contract', () => {
      const factory = new FlashLoanProviderFactory(mockLogger as any, createFullConfig());
      expect(factory.isFullySupported('ethereum')).toBe(true);
    });

    it('should return true for Balancer V2 chains with contract', () => {
      const factory = new FlashLoanProviderFactory(mockLogger as any, createFullConfig());
      expect(factory.isFullySupported('polygon')).toBe(true);
    });

    it('should return false for unsupported protocols (spookyswap)', () => {
      const factory = new FlashLoanProviderFactory(mockLogger as any, createFullConfig());
      expect(factory.isFullySupported('fantom')).toBe(false);
    });

    it('should return false for unconfigured chains', () => {
      const factory = new FlashLoanProviderFactory(mockLogger as any, createFullConfig());
      expect(factory.isFullySupported('unknown')).toBe(false);
    });

    it('should return false when no contract address configured', () => {
      const config: FlashLoanProviderConfig = {
        contractAddresses: {},
        approvedRouters: {},
      };
      const factory = new FlashLoanProviderFactory(mockLogger as any, config);
      expect(factory.isFullySupported('ethereum')).toBe(false);
    });
  });

  // =========================================================================
  // getProtocol
  // =========================================================================

  describe('getProtocol', () => {
    it('should return correct protocol for configured chains', () => {
      const factory = new FlashLoanProviderFactory(mockLogger as any, createFullConfig());

      expect(factory.getProtocol('ethereum')).toBe('aave_v3');
      expect(factory.getProtocol('polygon')).toBe('balancer_v2');
      expect(factory.getProtocol('bsc')).toBe('pancakeswap_v3');
      expect(factory.getProtocol('zksync')).toBe('syncswap');
      expect(factory.getProtocol('fantom')).toBe('spookyswap');
    });

    it('should return undefined for unconfigured chains', () => {
      const factory = new FlashLoanProviderFactory(mockLogger as any, createFullConfig());
      expect(factory.getProtocol('unknown')).toBeUndefined();
    });
  });

  // =========================================================================
  // getAllConfiguredChains
  // =========================================================================

  describe('getAllConfiguredChains', () => {
    it('should return all chains with flash loan config', () => {
      const factory = new FlashLoanProviderFactory(mockLogger as any, createFullConfig());
      const allChains = factory.getAllConfiguredChains();

      expect(allChains).toEqual(
        expect.arrayContaining(['ethereum', 'arbitrum', 'polygon', 'bsc', 'zksync', 'fantom']),
      );
      expect(allChains).toHaveLength(Object.keys(MOCK_FLASH_LOAN_PROVIDERS).length);
    });
  });

  // =========================================================================
  // clearCache
  // =========================================================================

  describe('clearCache', () => {
    it('should clear cached providers so new instances are created', () => {
      const factory = new FlashLoanProviderFactory(mockLogger as any, createFullConfig());

      const provider1 = factory.getProvider('ethereum');
      expect(provider1).toBeDefined();

      factory.clearCache();
      const provider2 = factory.getProvider('ethereum');
      expect(provider2).toBeDefined();

      // After clearing, a new instance should have been created
      expect(provider1).not.toBe(provider2);
    });
  });

  // =========================================================================
  // getSupportSummary
  // =========================================================================

  describe('getSupportSummary', () => {
    it('should return summary for all configured chains', () => {
      const factory = new FlashLoanProviderFactory(mockLogger as any, createFullConfig());
      const summary = factory.getSupportSummary();

      expect(summary.ethereum).toBeDefined();
      expect(summary.ethereum.protocol).toBe('aave_v3');
      expect(summary.ethereum.status).toBe('fully_supported');
      expect(summary.ethereum.hasContract).toBe(true);

      expect(summary.fantom).toBeDefined();
      expect(summary.fantom.protocol).toBe('spookyswap');
      expect(summary.fantom.status).toBe('not_implemented');
    });

    it('should show partial_support when no contract deployed for supported protocol', () => {
      const config: FlashLoanProviderConfig = {
        contractAddresses: {},
        approvedRouters: {},
      };
      const factory = new FlashLoanProviderFactory(mockLogger as any, config);
      const summary = factory.getSupportSummary();

      // ethereum has aave_v3 (supported protocol) but no contract
      expect(summary.ethereum.status).toBe('partial_support');
      expect(summary.ethereum.hasContract).toBe(false);
    });
  });

  // =========================================================================
  // getFullySupportedChains
  // =========================================================================

  describe('getFullySupportedChains', () => {
    it('should return chains with supported protocols and valid contracts', () => {
      const factory = new FlashLoanProviderFactory(mockLogger as any, createFullConfig());
      const chains = factory.getFullySupportedChains();

      // ethereum, arbitrum (aave_v3), polygon (balancer_v2), bsc (pancakeswap_v3), zksync (syncswap)
      expect(chains).toContain('ethereum');
      expect(chains).toContain('arbitrum');
      expect(chains).toContain('polygon');
      expect(chains).toContain('bsc');
      expect(chains).toContain('zksync');
      // fantom has unsupported protocol
      expect(chains).not.toContain('fantom');
    });

    it('should exclude chains without contract addresses', () => {
      const factory = new FlashLoanProviderFactory(mockLogger as any, createMinimalConfig());
      const chains = factory.getFullySupportedChains();

      expect(chains).toContain('ethereum');
      expect(chains).not.toContain('arbitrum'); // No contract configured
    });
  });

  // =========================================================================
  // getSupportStatus
  // =========================================================================

  describe('getSupportStatus', () => {
    it('should return fully_supported for deployed supported protocols', () => {
      const factory = new FlashLoanProviderFactory(mockLogger as any, createFullConfig());
      expect(factory.getSupportStatus('ethereum')).toBe('fully_supported');
    });

    it('should return not_implemented for unsupported protocols', () => {
      const factory = new FlashLoanProviderFactory(mockLogger as any, createFullConfig());
      expect(factory.getSupportStatus('fantom')).toBe('not_implemented');
    });

    it('should return not_implemented for unconfigured chains', () => {
      const factory = new FlashLoanProviderFactory(mockLogger as any, createFullConfig());
      expect(factory.getSupportStatus('unknown')).toBe('not_implemented');
    });
  });
});

// =============================================================================
// Factory Function Tests
// =============================================================================

describe('createFlashLoanProviderFactory', () => {
  it('should create a valid factory instance', () => {
    const mockLogger = createMockLogger();
    const factory = createFlashLoanProviderFactory(mockLogger as any, createFullConfig());

    expect(factory).toBeInstanceOf(FlashLoanProviderFactory);
  });
});
