/**
 * MEV Protection Unit Tests
 *
 * Tests for Phase 2 MEV protection providers:
 * - FlashbotsProvider (Ethereum)
 * - L2SequencerProvider (Arbitrum, Optimism, Base)
 * - StandardProvider (BSC, Polygon, others)
 * - MevProviderFactory
 */

import { ethers } from 'ethers';
import {
  MevProviderFactory,
  FlashbotsProvider,
  L2SequencerProvider,
  StandardProvider,
  CHAIN_MEV_STRATEGIES,
  MEV_DEFAULTS,
  hasMevProtection,
  getRecommendedPriorityFee,
  isL2SequencerChain,
} from '../../src/mev-protection';
import type {
  MevProviderConfig,
  MevGlobalConfig,
  IMevProvider,
} from '../../src/mev-protection';

// =============================================================================
// Mocks
// =============================================================================

// Mock fetch for Flashbots relay calls
global.fetch = jest.fn();

// Mock provider and wallet
const createMockProvider = (): ethers.JsonRpcProvider => {
  const mockProvider = {
    getBlockNumber: jest.fn().mockResolvedValue(12345678),
    getBlock: jest.fn().mockResolvedValue({
      timestamp: Math.floor(Date.now() / 1000),
      transactions: [],
    }),
    getTransactionCount: jest.fn().mockResolvedValue(10),
    getFeeData: jest.fn().mockResolvedValue({
      maxFeePerGas: ethers.parseUnits('50', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
      gasPrice: ethers.parseUnits('50', 'gwei'),
    }),
    estimateGas: jest.fn().mockResolvedValue(200000n),
    getTransactionReceipt: jest.fn().mockResolvedValue({
      hash: '0x1234567890abcdef',
      blockNumber: 12345679,
      gasUsed: 150000n,
      gasPrice: ethers.parseUnits('50', 'gwei'),
    }),
  } as unknown as ethers.JsonRpcProvider;

  return mockProvider;
};

const createMockWallet = (provider: ethers.JsonRpcProvider): ethers.Wallet => {
  const privateKey = '0x' + '1'.repeat(64);
  const wallet = new ethers.Wallet(privateKey, provider);

  // Mock wallet methods
  jest.spyOn(wallet, 'signTransaction').mockResolvedValue('0xsignedtx');
  jest.spyOn(wallet, 'sendTransaction').mockResolvedValue({
    hash: '0xtxhash',
    wait: jest.fn().mockResolvedValue({
      hash: '0xtxhash',
      blockNumber: 12345679,
      gasUsed: 150000n,
      gasPrice: ethers.parseUnits('50', 'gwei'),
    }),
  } as unknown as ethers.TransactionResponse);

  return wallet;
};

// =============================================================================
// Test Suites
// =============================================================================

describe('MEV Protection', () => {
  let mockProvider: ethers.JsonRpcProvider;
  let mockWallet: ethers.Wallet;

  beforeEach(() => {
    jest.clearAllMocks();
    mockProvider = createMockProvider();
    mockWallet = createMockWallet(mockProvider);
    (global.fetch as jest.Mock).mockClear();
  });

  // ===========================================================================
  // CHAIN_MEV_STRATEGIES Tests
  // ===========================================================================

  describe('CHAIN_MEV_STRATEGIES', () => {
    it('should have flashbots strategy for Ethereum', () => {
      expect(CHAIN_MEV_STRATEGIES.ethereum).toBe('flashbots');
    });

    it('should have bloxroute strategy for BSC', () => {
      expect(CHAIN_MEV_STRATEGIES.bsc).toBe('bloxroute');
    });

    it('should have fastlane strategy for Polygon', () => {
      expect(CHAIN_MEV_STRATEGIES.polygon).toBe('fastlane');
    });

    it('should have sequencer strategy for L2s', () => {
      expect(CHAIN_MEV_STRATEGIES.arbitrum).toBe('sequencer');
      expect(CHAIN_MEV_STRATEGIES.optimism).toBe('sequencer');
      expect(CHAIN_MEV_STRATEGIES.base).toBe('sequencer');
      expect(CHAIN_MEV_STRATEGIES.zksync).toBe('sequencer');
      expect(CHAIN_MEV_STRATEGIES.linea).toBe('sequencer');
    });

    it('should have standard strategy for other chains', () => {
      expect(CHAIN_MEV_STRATEGIES.avalanche).toBe('standard');
      expect(CHAIN_MEV_STRATEGIES.fantom).toBe('standard');
    });
  });

  // ===========================================================================
  // Helper Function Tests
  // ===========================================================================

  describe('Helper Functions', () => {
    describe('hasMevProtection', () => {
      it('should return true for chains with MEV protection', () => {
        expect(hasMevProtection('ethereum')).toBe(true);
        expect(hasMevProtection('arbitrum')).toBe(true);
        expect(hasMevProtection('bsc')).toBe(true);
      });

      it('should return false for standard chains', () => {
        expect(hasMevProtection('avalanche')).toBe(false);
        expect(hasMevProtection('fantom')).toBe(false);
      });

      it('should return false for unknown chains', () => {
        expect(hasMevProtection('unknown')).toBe(false);
      });
    });

    describe('getRecommendedPriorityFee', () => {
      it('should return appropriate priority fee for each chain type', () => {
        expect(getRecommendedPriorityFee('ethereum')).toBe(2.0);
        expect(getRecommendedPriorityFee('bsc')).toBe(3.0);
        expect(getRecommendedPriorityFee('polygon')).toBe(30.0);
        expect(getRecommendedPriorityFee('arbitrum')).toBe(0.01);
      });
    });

    describe('isL2SequencerChain', () => {
      it('should return true for L2 sequencer chains', () => {
        expect(isL2SequencerChain('arbitrum')).toBe(true);
        expect(isL2SequencerChain('optimism')).toBe(true);
        expect(isL2SequencerChain('base')).toBe(true);
      });

      it('should return false for non-L2 chains', () => {
        expect(isL2SequencerChain('ethereum')).toBe(false);
        expect(isL2SequencerChain('bsc')).toBe(false);
      });
    });
  });

  // ===========================================================================
  // FlashbotsProvider Tests
  // ===========================================================================

  describe('FlashbotsProvider', () => {
    let flashbotsConfig: MevProviderConfig;

    beforeEach(() => {
      flashbotsConfig = {
        chain: 'ethereum',
        provider: mockProvider,
        wallet: mockWallet,
        enabled: true,
        flashbotsAuthKey: '0x' + '2'.repeat(64),
        fallbackToPublic: true,
      };
    });

    it('should create FlashbotsProvider for Ethereum', () => {
      const provider = new FlashbotsProvider(flashbotsConfig);
      expect(provider.chain).toBe('ethereum');
      expect(provider.strategy).toBe('flashbots');
    });

    it('should throw error for non-Ethereum chain', () => {
      expect(() => {
        new FlashbotsProvider({ ...flashbotsConfig, chain: 'arbitrum' });
      }).toThrow('FlashbotsProvider is only for Ethereum mainnet');
    });

    it('should report enabled status correctly', () => {
      const provider = new FlashbotsProvider(flashbotsConfig);
      expect(provider.isEnabled()).toBe(true);

      const disabledProvider = new FlashbotsProvider({
        ...flashbotsConfig,
        enabled: false,
      });
      expect(disabledProvider.isEnabled()).toBe(false);
    });

    it('should initialize metrics correctly', () => {
      const provider = new FlashbotsProvider(flashbotsConfig);
      const metrics = provider.getMetrics();

      expect(metrics.totalSubmissions).toBe(0);
      expect(metrics.successfulSubmissions).toBe(0);
      expect(metrics.failedSubmissions).toBe(0);
    });

    it('should reset metrics', () => {
      const provider = new FlashbotsProvider(flashbotsConfig);
      // Modify metrics would happen during submission
      provider.resetMetrics();
      const metrics = provider.getMetrics();
      expect(metrics.totalSubmissions).toBe(0);
    });
  });

  // ===========================================================================
  // L2SequencerProvider Tests
  // ===========================================================================

  describe('L2SequencerProvider', () => {
    it('should create L2SequencerProvider for Arbitrum', () => {
      const config: MevProviderConfig = {
        chain: 'arbitrum',
        provider: mockProvider,
        wallet: mockWallet,
        enabled: true,
      };

      const provider = new L2SequencerProvider(config);
      expect(provider.chain).toBe('arbitrum');
      expect(provider.strategy).toBe('sequencer');
    });

    it('should throw error for non-L2 chain', () => {
      const config: MevProviderConfig = {
        chain: 'ethereum',
        provider: mockProvider,
        wallet: mockWallet,
        enabled: true,
      };

      expect(() => {
        new L2SequencerProvider(config);
      }).toThrow('L2SequencerProvider is only for sequencer-based L2s');
    });

    it('should work with all supported L2 chains', () => {
      const l2Chains = ['arbitrum', 'optimism', 'base', 'zksync', 'linea'];

      for (const chain of l2Chains) {
        const provider = new L2SequencerProvider({
          chain,
          provider: mockProvider,
          wallet: mockWallet,
          enabled: true,
        });
        expect(provider.chain).toBe(chain);
        expect(provider.strategy).toBe('sequencer');
      }
    });

    it('should report health check status', async () => {
      const provider = new L2SequencerProvider({
        chain: 'arbitrum',
        provider: mockProvider,
        wallet: mockWallet,
        enabled: true,
      });

      const health = await provider.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.message).toContain('sequencer is healthy');
    });
  });

  // ===========================================================================
  // StandardProvider Tests
  // ===========================================================================

  describe('StandardProvider', () => {
    it('should create StandardProvider with correct strategy per chain', () => {
      const chains = [
        { chain: 'bsc', expectedStrategy: 'bloxroute' },
        { chain: 'polygon', expectedStrategy: 'fastlane' },
        { chain: 'avalanche', expectedStrategy: 'standard' },
      ];

      for (const { chain, expectedStrategy } of chains) {
        const provider = new StandardProvider({
          chain,
          provider: mockProvider,
          wallet: mockWallet,
          enabled: true,
        });
        expect(provider.strategy).toBe(expectedStrategy);
      }
    });

    it('should handle unknown chains with standard strategy', () => {
      const provider = new StandardProvider({
        chain: 'unknown',
        provider: mockProvider,
        wallet: mockWallet,
        enabled: true,
      });
      expect(provider.strategy).toBe('standard');
    });

    it('should report health correctly', async () => {
      const provider = new StandardProvider({
        chain: 'avalanche',
        provider: mockProvider,
        wallet: mockWallet,
        enabled: true,
      });

      const health = await provider.healthCheck();
      expect(health.healthy).toBe(true);
    });
  });

  // ===========================================================================
  // MevProviderFactory Tests
  // ===========================================================================

  describe('MevProviderFactory', () => {
    let factoryConfig: MevGlobalConfig;
    let factory: MevProviderFactory;

    beforeEach(() => {
      factoryConfig = {
        enabled: true,
        flashbotsAuthKey: '0x' + '3'.repeat(64),
        fallbackToPublic: true,
      };
      factory = new MevProviderFactory(factoryConfig);
    });

    it('should create factory with global config', () => {
      expect(factory.isEnabled()).toBe(true);
    });

    it('should create FlashbotsProvider for Ethereum', () => {
      const provider = factory.createProvider({
        chain: 'ethereum',
        provider: mockProvider,
        wallet: mockWallet,
      });

      expect(provider.chain).toBe('ethereum');
      expect(provider.strategy).toBe('flashbots');
    });

    it('should create L2SequencerProvider for L2 chains', () => {
      const provider = factory.createProvider({
        chain: 'arbitrum',
        provider: mockProvider,
        wallet: mockWallet,
      });

      expect(provider.chain).toBe('arbitrum');
      expect(provider.strategy).toBe('sequencer');
    });

    it('should create StandardProvider for other chains', () => {
      const provider = factory.createProvider({
        chain: 'avalanche',
        provider: mockProvider,
        wallet: mockWallet,
      });

      expect(provider.chain).toBe('avalanche');
      expect(provider.strategy).toBe('standard');
    });

    it('should cache providers', () => {
      const provider1 = factory.createProvider({
        chain: 'ethereum',
        provider: mockProvider,
        wallet: mockWallet,
      });

      const provider2 = factory.createProvider({
        chain: 'ethereum',
        provider: mockProvider,
        wallet: mockWallet,
      });

      expect(provider1).toBe(provider2);
    });

    it('should return cached provider via getProvider', () => {
      factory.createProvider({
        chain: 'arbitrum',
        provider: mockProvider,
        wallet: mockWallet,
      });

      const cached = factory.getProvider('arbitrum');
      expect(cached).toBeDefined();
      expect(cached?.chain).toBe('arbitrum');
    });

    it('should return undefined for non-existent provider', () => {
      const provider = factory.getProvider('nonexistent');
      expect(provider).toBeUndefined();
    });

    it('should clear providers', () => {
      factory.createProvider({
        chain: 'ethereum',
        provider: mockProvider,
        wallet: mockWallet,
      });

      factory.clearProviders();

      expect(factory.getProvider('ethereum')).toBeUndefined();
    });

    it('should aggregate metrics from all providers', () => {
      factory.createProvider({
        chain: 'ethereum',
        provider: mockProvider,
        wallet: mockWallet,
      });

      factory.createProvider({
        chain: 'arbitrum',
        provider: mockProvider,
        wallet: mockWallet,
      });

      const { global, byChain } = factory.getAggregatedMetrics();

      expect(global.totalSubmissions).toBe(0);
      expect(byChain.ethereum).toBeDefined();
      expect(byChain.arbitrum).toBeDefined();
    });

    it('should reset all metrics', () => {
      factory.createProvider({
        chain: 'ethereum',
        provider: mockProvider,
        wallet: mockWallet,
      });

      factory.resetAllMetrics();

      const { global } = factory.getAggregatedMetrics();
      expect(global.totalSubmissions).toBe(0);
    });

    it('should get correct strategy for chain', () => {
      expect(factory.getStrategy('ethereum')).toBe('flashbots');
      expect(factory.getStrategy('arbitrum')).toBe('sequencer');
      expect(factory.getStrategy('unknown')).toBe('standard');
    });

    it('should enable/disable MEV protection', () => {
      expect(factory.isEnabled()).toBe(true);

      factory.setEnabled(false);
      expect(factory.isEnabled()).toBe(false);

      factory.setEnabled(true);
      expect(factory.isEnabled()).toBe(true);
    });

    it('should run health checks on all providers', async () => {
      factory.createProvider({
        chain: 'ethereum',
        provider: mockProvider,
        wallet: mockWallet,
      });

      factory.createProvider({
        chain: 'arbitrum',
        provider: mockProvider,
        wallet: mockWallet,
      });

      const healthResults = await factory.healthCheckAll();

      expect(healthResults.ethereum).toBeDefined();
      expect(healthResults.arbitrum).toBeDefined();
    });
  });

  // ===========================================================================
  // MEV_DEFAULTS Tests
  // ===========================================================================

  describe('MEV_DEFAULTS', () => {
    it('should have correct default values', () => {
      expect(MEV_DEFAULTS.submissionTimeoutMs).toBe(30000);
      expect(MEV_DEFAULTS.maxRetries).toBe(3);
      expect(MEV_DEFAULTS.fallbackToPublic).toBe(true);
      expect(MEV_DEFAULTS.flashbotsRelayUrl).toBe('https://relay.flashbots.net');
      expect(MEV_DEFAULTS.bloxrouteUrl).toBe('https://mev.api.blxrbdn.com');
      expect(MEV_DEFAULTS.fastlaneUrl).toBe('https://fastlane-rpc.polygon.technology');
    });
  });
});
