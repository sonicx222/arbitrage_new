/**
 * Provider Config Tests (Fix #13)
 *
 * Tests for the RPC provider configuration module including:
 * - PROVIDER_CONFIGS structure and values
 * - CHAIN_NETWORK_NAMES completeness
 * - URL builder functions for all providers
 * - getProviderUrlsForChain with env var variations
 * - getTimeBasedProviderOrder time windows
 * - calculateProviderBudget capacity tracking
 *
 * @see shared/config/src/chains/provider-config.ts
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  PROVIDER_CONFIGS,
  CHAIN_NETWORK_NAMES,
  ProviderTier,
  buildDrpcUrl,
  buildAnkrUrl,
  buildPublicNodeUrl,
  buildOnFinalityUrl,
  buildInfuraUrl,
  buildAlchemyUrl,
  buildBlastApiUrl,
  getProviderUrlsForChain,
  getTimeBasedProviderOrder,
  calculateProviderBudget,
} from '../../src/chains/provider-config';

// =============================================================================
// PROVIDER_CONFIGS
// =============================================================================

describe('PROVIDER_CONFIGS', () => {
  const providerNames = Object.keys(PROVIDER_CONFIGS);

  it('should have 8 providers defined', () => {
    expect(providerNames).toHaveLength(8);
    expect(providerNames).toEqual(
      expect.arrayContaining(['drpc', 'onfinality', 'ankr', 'publicnode', 'infura', 'alchemy', 'quicknode', 'blastapi'])
    );
  });

  it('should have valid tier values for each provider', () => {
    const validTiers = [ProviderTier.PRIMARY, ProviderTier.SECONDARY, ProviderTier.TERTIARY, ProviderTier.LAST_RESORT];
    for (const config of Object.values(PROVIDER_CONFIGS)) {
      expect(validTiers).toContain(config.tier);
    }
  });

  it('should have drpc as PRIMARY tier', () => {
    expect(PROVIDER_CONFIGS.drpc.tier).toBe(ProviderTier.PRIMARY);
  });

  it('should have onfinality, ankr, and publicnode as SECONDARY tier', () => {
    expect(PROVIDER_CONFIGS.onfinality.tier).toBe(ProviderTier.SECONDARY);
    expect(PROVIDER_CONFIGS.ankr.tier).toBe(ProviderTier.SECONDARY);
    expect(PROVIDER_CONFIGS.publicnode.tier).toBe(ProviderTier.SECONDARY);
  });

  it('should have infura and alchemy as TERTIARY tier', () => {
    expect(PROVIDER_CONFIGS.infura.tier).toBe(ProviderTier.TERTIARY);
    expect(PROVIDER_CONFIGS.alchemy.tier).toBe(ProviderTier.TERTIARY);
  });

  it('should have quicknode and blastapi as LAST_RESORT tier', () => {
    expect(PROVIDER_CONFIGS.quicknode.tier).toBe(ProviderTier.LAST_RESORT);
    expect(PROVIDER_CONFIGS.blastapi.tier).toBe(ProviderTier.LAST_RESORT);
  });

  it('should have Infinity monthlyCapacityCU for publicnode', () => {
    expect(PROVIDER_CONFIGS.publicnode.monthlyCapacityCU).toBe(Infinity);
  });

  it('should have finite monthlyCapacityCU for all other providers', () => {
    for (const [name, config] of Object.entries(PROVIDER_CONFIGS)) {
      if (name !== 'publicnode') {
        expect(Number.isFinite(config.monthlyCapacityCU)).toBe(true);
        expect(config.monthlyCapacityCU).toBeGreaterThan(0);
      }
    }
  });

  it('should have positive rpsLimit for each provider', () => {
    for (const config of Object.values(PROVIDER_CONFIGS)) {
      expect(config.rpsLimit).toBeGreaterThan(0);
    }
  });

  it('should require API keys for drpc and ankr', () => {
    expect(PROVIDER_CONFIGS.drpc.requiresApiKey).toBe(true);
    expect(PROVIDER_CONFIGS.ankr.requiresApiKey).toBe(true);
  });

  it('should not require API keys for publicnode and blastapi', () => {
    expect(PROVIDER_CONFIGS.publicnode.requiresApiKey).toBe(false);
    expect(PROVIDER_CONFIGS.blastapi.requiresApiKey).toBe(false);
  });

  it('should have supportsWebSocket for all providers', () => {
    for (const config of Object.values(PROVIDER_CONFIGS)) {
      expect(config.supportsWebSocket).toBe(true);
    }
  });

  it('should have apiKeyEnvVar set for providers that require API keys', () => {
    for (const config of Object.values(PROVIDER_CONFIGS)) {
      if (config.requiresApiKey) {
        expect(config.apiKeyEnvVar).toBeDefined();
        expect(config.apiKeyEnvVar!.length).toBeGreaterThan(0);
      }
    }
  });

  it('should have name property set for each provider', () => {
    for (const config of Object.values(PROVIDER_CONFIGS)) {
      expect(config.name).toBeDefined();
      expect(config.name.length).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// CHAIN_NETWORK_NAMES
// =============================================================================

describe('CHAIN_NETWORK_NAMES', () => {
  const expectedChains = [
    'ethereum', 'arbitrum', 'bsc', 'base', 'polygon',
    'optimism', 'avalanche', 'fantom', 'zksync', 'linea', 'solana'
  ];

  it('should have entries for all 11 chains', () => {
    const chainNames = Object.keys(CHAIN_NETWORK_NAMES);
    expect(chainNames).toHaveLength(11);
    for (const chain of expectedChains) {
      expect(CHAIN_NETWORK_NAMES[chain]).toBeDefined();
    }
  });

  it('should have drpc, ankr, publicnode, and blastapi names for every chain', () => {
    for (const chain of expectedChains) {
      const names = CHAIN_NETWORK_NAMES[chain];
      expect(names.drpc).toBeDefined();
      expect(names.ankr).toBeDefined();
      expect(names.publicnode).toBeDefined();
      expect(names.blastapi).toBeDefined();
    }
  });

  it('should have infura name for ethereum', () => {
    expect(CHAIN_NETWORK_NAMES.ethereum.infura).toBe('mainnet');
  });

  it('should have alchemy name for ethereum', () => {
    expect(CHAIN_NETWORK_NAMES.ethereum.alchemy).toBe('eth');
  });

  it('should not have infura for bsc', () => {
    expect(CHAIN_NETWORK_NAMES.bsc.infura).toBeUndefined();
  });

  it('should not have alchemy for bsc', () => {
    expect(CHAIN_NETWORK_NAMES.bsc.alchemy).toBeUndefined();
  });
});

// =============================================================================
// URL Builder Functions
// =============================================================================

describe('URL builder functions', () => {
  describe('buildDrpcUrl', () => {
    it('should build HTTPS URL by default', () => {
      expect(buildDrpcUrl('ethereum', 'key123')).toBe(
        'https://lb.drpc.org/ogrpc?network=ethereum&dkey=key123'
      );
    });

    it('should build WSS URL when isWebSocket is true', () => {
      expect(buildDrpcUrl('ethereum', 'key123', true)).toBe(
        'wss://lb.drpc.org/ogws?network=ethereum&dkey=key123'
      );
    });
  });

  describe('buildAnkrUrl', () => {
    it('should build HTTPS URL by default', () => {
      expect(buildAnkrUrl('eth', 'key123')).toBe(
        'https://rpc.ankr.com/eth/key123'
      );
    });

    it('should build WSS URL when isWebSocket is true', () => {
      expect(buildAnkrUrl('eth', 'key123', true)).toBe(
        'wss://rpc.ankr.com/eth/key123'
      );
    });
  });

  describe('buildOnFinalityUrl', () => {
    it('should build HTTPS URL by default', () => {
      expect(buildOnFinalityUrl('bsc', 'key123')).toBe(
        'https://bsc.api.onfinality.io/rpc?apikey=key123'
      );
    });

    it('should build WSS URL when isWebSocket is true', () => {
      expect(buildOnFinalityUrl('bsc', 'key123', true)).toBe(
        'wss://bsc.api.onfinality.io/ws?apikey=key123'
      );
    });
  });

  describe('buildPublicNodeUrl', () => {
    it('should build HTTPS URL by default', () => {
      expect(buildPublicNodeUrl('ethereum-rpc')).toBe(
        'https://ethereum-rpc.publicnode.com'
      );
    });

    it('should build WSS URL when isWebSocket is true', () => {
      expect(buildPublicNodeUrl('ethereum-rpc', true)).toBe(
        'wss://ethereum-rpc.publicnode.com'
      );
    });
  });

  describe('buildInfuraUrl', () => {
    it('should build HTTPS URL by default', () => {
      expect(buildInfuraUrl('mainnet', 'key123')).toBe(
        'https://mainnet.infura.io/v3/key123'
      );
    });

    it('should build WSS URL when isWebSocket is true', () => {
      expect(buildInfuraUrl('mainnet', 'key123', true)).toBe(
        'wss://mainnet.infura.io/ws/v3/key123'
      );
    });
  });

  describe('buildAlchemyUrl', () => {
    it('should build HTTPS URL by default', () => {
      expect(buildAlchemyUrl('eth', 'key123')).toBe(
        'https://eth-mainnet.g.alchemy.com/v2/key123'
      );
    });

    it('should build WSS URL when isWebSocket is true', () => {
      expect(buildAlchemyUrl('eth', 'key123', true)).toBe(
        'wss://eth-mainnet.g.alchemy.com/v2/key123'
      );
    });
  });

  describe('buildBlastApiUrl', () => {
    it('should build HTTPS URL by default', () => {
      expect(buildBlastApiUrl('eth')).toBe(
        'https://eth-mainnet.public.blastapi.io'
      );
    });

    it('should build WSS URL when isWebSocket is true', () => {
      expect(buildBlastApiUrl('eth', true)).toBe(
        'wss://eth-mainnet.public.blastapi.io'
      );
    });
  });
});

// =============================================================================
// getProviderUrlsForChain
// =============================================================================

describe('getProviderUrlsForChain', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    delete process.env.DRPC_API_KEY;
    delete process.env.ANKR_API_KEY;
    delete process.env.INFURA_API_KEY;
    delete process.env.ALCHEMY_API_KEY;
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('should return primary as drpc when all API keys are set', () => {
    process.env.DRPC_API_KEY = 'drpc-test';
    process.env.ANKR_API_KEY = 'ankr-test';
    process.env.INFURA_API_KEY = 'infura-test';
    process.env.ALCHEMY_API_KEY = 'alchemy-test';

    const result = getProviderUrlsForChain('ethereum');
    expect(result.primary).toContain('drpc.org');
    expect(result.fallbacks.length).toBeGreaterThanOrEqual(4);
  });

  it('should include ankr, publicnode, infura, alchemy, blastapi as fallbacks when all keys set', () => {
    process.env.DRPC_API_KEY = 'drpc-test';
    process.env.ANKR_API_KEY = 'ankr-test';
    process.env.INFURA_API_KEY = 'infura-test';
    process.env.ALCHEMY_API_KEY = 'alchemy-test';

    const result = getProviderUrlsForChain('ethereum');
    const allUrls = [result.primary, ...result.fallbacks].join(' ');
    expect(allUrls).toContain('ankr.com');
    expect(allUrls).toContain('publicnode.com');
    expect(allUrls).toContain('infura.io');
    expect(allUrls).toContain('alchemy.com');
    expect(allUrls).toContain('blastapi.io');
  });

  it('should return publicnode as primary when no API keys are set', () => {
    const result = getProviderUrlsForChain('ethereum');
    expect(result.primary).toContain('publicnode.com');
  });

  it('should include blastapi as fallback when no API keys are set', () => {
    const result = getProviderUrlsForChain('ethereum');
    const allUrls = [result.primary, ...result.fallbacks].join(' ');
    expect(allUrls).toContain('blastapi.io');
  });

  it('should throw for unknown chain', () => {
    expect(() => getProviderUrlsForChain('unknown-chain')).toThrow('Unknown chain');
  });

  it('should handle case-insensitive chain ID', () => {
    const result = getProviderUrlsForChain('ETHEREUM');
    expect(result.primary).toBeDefined();
  });

  it('should return websocket URLs when isWebSocket is true', () => {
    const result = getProviderUrlsForChain('ethereum', true);
    expect(result.primary).toMatch(/^wss:\/\//);
  });
});

// =============================================================================
// getTimeBasedProviderOrder
// =============================================================================

describe('getTimeBasedProviderOrder', () => {
  let savedDate: typeof Date;

  beforeEach(() => {
    savedDate = global.Date;
  });

  afterEach(() => {
    global.Date = savedDate;
  });

  function mockUTCHour(hour: number): void {
    const MockDate = class extends savedDate {
      getUTCHours(): number {
        return hour;
      }
    } as unknown as DateConstructor;
    global.Date = MockDate;
  }

  it('should return infura first during hours 0-7 (early UTC)', () => {
    mockUTCHour(0);
    const order = getTimeBasedProviderOrder();
    expect(order[0]).toBe('infura');
  });

  it('should return infura first at hour 5', () => {
    mockUTCHour(5);
    const order = getTimeBasedProviderOrder();
    expect(order[0]).toBe('infura');
  });

  it('should return drpc first during hours 8-19 (mid-day UTC)', () => {
    mockUTCHour(8);
    const order = getTimeBasedProviderOrder();
    expect(order[0]).toBe('drpc');
  });

  it('should return drpc first at hour 15', () => {
    mockUTCHour(15);
    const order = getTimeBasedProviderOrder();
    expect(order[0]).toBe('drpc');
  });

  it('should return ankr first during hours 20-23 (late UTC)', () => {
    mockUTCHour(20);
    const order = getTimeBasedProviderOrder();
    expect(order[0]).toBe('ankr');
  });

  it('should return ankr first at hour 23', () => {
    mockUTCHour(23);
    const order = getTimeBasedProviderOrder();
    expect(order[0]).toBe('ankr');
  });

  it('should always return 8 providers in the order', () => {
    for (const hour of [0, 8, 20]) {
      mockUTCHour(hour);
      const order = getTimeBasedProviderOrder();
      expect(order).toHaveLength(8);
    }
  });

  it('should include all provider names in every time window', () => {
    const allProviders = ['drpc', 'onfinality', 'ankr', 'publicnode', 'infura', 'alchemy', 'quicknode', 'blastapi'];
    for (const hour of [0, 8, 20]) {
      mockUTCHour(hour);
      const order = getTimeBasedProviderOrder();
      expect(order.sort()).toEqual(allProviders.sort());
    }
  });
});

// =============================================================================
// calculateProviderBudget
// =============================================================================

describe('calculateProviderBudget', () => {
  it('should calculate budget for normal usage (50% used at day 15)', () => {
    const drpcCapacity = PROVIDER_CONFIGS.drpc.monthlyCapacityCU;
    const usedCU = drpcCapacity * 0.5;
    const budget = calculateProviderBudget('drpc', usedCU, 15);

    expect(budget.provider).toBe('dRPC');
    expect(budget.monthlyLimit).toBe(drpcCapacity);
    expect(budget.used).toBe(usedCU);
    expect(budget.remaining).toBe(drpcCapacity - usedCU);
    expect(budget.percentUsed).toBeCloseTo(50, 0);
    expect(budget.shouldThrottle).toBe(false);
  });

  it('should throttle when over 80% used', () => {
    const drpcCapacity = PROVIDER_CONFIGS.drpc.monthlyCapacityCU;
    const usedCU = drpcCapacity * 0.85;
    const budget = calculateProviderBudget('drpc', usedCU, 15);

    expect(budget.percentUsed).toBeCloseTo(85, 0);
    expect(budget.shouldThrottle).toBe(true);
  });

  it('should never throttle publicnode (unlimited capacity)', () => {
    const budget = calculateProviderBudget('publicnode', 999_999_999, 15);

    expect(budget.monthlyLimit).toBe(Infinity);
    expect(budget.remaining).toBe(Infinity);
    expect(budget.percentUsed).toBe(0);
    expect(budget.shouldThrottle).toBe(false);
  });

  it('should throw for unknown provider', () => {
    expect(() => calculateProviderBudget('nonexistent', 100, 15)).toThrow('Unknown provider');
  });

  it('should handle case-insensitive provider name', () => {
    const budget = calculateProviderBudget('DRPC', 100, 15);
    expect(budget.provider).toBe('dRPC');
  });

  it('should return positive estimatedDaysRemaining for normal usage', () => {
    const budget = calculateProviderBudget('ankr', 50_000_000, 10);
    expect(budget.estimatedDaysRemaining).toBeGreaterThan(0);
  });
});
