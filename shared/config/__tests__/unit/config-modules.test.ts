/**
 * Unit Tests for Configuration Modules
 *
 * Tests for previously untested configuration modules:
 * - cross-chain.ts: Token normalization and cross-chain utilities
 * - service-config.ts: Bridge costs and flash loan providers
 * - thresholds.ts: Profit thresholds and arbitrage config
 * - mev-config.ts: MEV protection settings
 * - system-constants.ts: System-wide constants
 * - detector-config.ts: Chain-specific detector settings
 *
 * @see Analysis report 2025-01-22
 */

import { describe, it, expect, beforeAll } from '@jest/globals';

import {
  // Cross-chain
  CROSS_CHAIN_TOKEN_ALIASES,
  normalizeTokenForCrossChain,
  findCommonTokensBetweenChains,
  preWarmCommonTokensCache,
  getChainSpecificTokenSymbol,
  DEFAULT_QUOTE_TOKENS,
  getDefaultQuoteToken,
  // Service config
  SERVICE_CONFIGS,
  FLASH_LOAN_PROVIDERS,
  supportsFlashLoan,
  BRIDGE_COSTS,
  getBridgeCost,
  getAllBridgeOptions,
  calculateBridgeCostUsd,
  // Thresholds
  PERFORMANCE_THRESHOLDS,
  ARBITRAGE_CONFIG,
  getMinProfitThreshold,
  // MEV config
  MEV_CONFIG,
  // System constants
  SYSTEM_CONSTANTS,
  // Detector config
  DETECTOR_CONFIG,
  // Chains for validation
  CHAINS,
  MAINNET_CHAIN_IDS,
  TESTNET_CHAINS
} from '../../src';

// =============================================================================
// CROSS-CHAIN MODULE TESTS
// =============================================================================
describe('Cross-Chain Module', () => {
  describe('CROSS_CHAIN_TOKEN_ALIASES', () => {
    it('should have all keys in uppercase', () => {
      for (const key of Object.keys(CROSS_CHAIN_TOKEN_ALIASES)) {
        expect(key).toBe(key.toUpperCase());
      }
    });

    it('should normalize Fantom-specific tokens', () => {
      expect(CROSS_CHAIN_TOKEN_ALIASES['FUSDT']).toBe('USDT');
      expect(CROSS_CHAIN_TOKEN_ALIASES['WFTM']).toBe('FTM');
    });

    it('should normalize Avalanche bridged tokens', () => {
      expect(CROSS_CHAIN_TOKEN_ALIASES['WETH.E']).toBe('WETH');
      expect(CROSS_CHAIN_TOKEN_ALIASES['WBTC.E']).toBe('WBTC');
      expect(CROSS_CHAIN_TOKEN_ALIASES['USDC.E']).toBe('USDC');
    });

    it('should normalize BSC-specific tokens', () => {
      expect(CROSS_CHAIN_TOKEN_ALIASES['WBNB']).toBe('BNB');
      expect(CROSS_CHAIN_TOKEN_ALIASES['BTCB']).toBe('WBTC');
      expect(CROSS_CHAIN_TOKEN_ALIASES['ETH']).toBe('WETH');
    });

    it('should normalize Solana LST tokens', () => {
      expect(CROSS_CHAIN_TOKEN_ALIASES['MSOL']).toBe('SOL');
      expect(CROSS_CHAIN_TOKEN_ALIASES['JITOSOL']).toBe('SOL');
      expect(CROSS_CHAIN_TOKEN_ALIASES['BSOL']).toBe('SOL');
    });
  });

  describe('normalizeTokenForCrossChain', () => {
    it('should normalize tokens case-insensitively', () => {
      expect(normalizeTokenForCrossChain('weth.e')).toBe('WETH');
      expect(normalizeTokenForCrossChain('WETH.E')).toBe('WETH');
      expect(normalizeTokenForCrossChain('Weth.E')).toBe('WETH');
    });

    it('should handle trimming whitespace', () => {
      expect(normalizeTokenForCrossChain(' USDC ')).toBe('USDC');
      expect(normalizeTokenForCrossChain('  weth.e  ')).toBe('WETH');
    });

    it('should pass through unknown tokens in uppercase', () => {
      expect(normalizeTokenForCrossChain('UNKNOWN')).toBe('UNKNOWN');
      expect(normalizeTokenForCrossChain('newtoken')).toBe('NEWTOKEN');
    });

    it('should normalize common cross-chain scenarios', () => {
      // Avalanche bridged ETH -> canonical WETH
      expect(normalizeTokenForCrossChain('WETH.e')).toBe('WETH');
      // BSC bridged ETH -> canonical WETH
      expect(normalizeTokenForCrossChain('ETH')).toBe('WETH');
      // Fantom USDT -> canonical USDT
      expect(normalizeTokenForCrossChain('fUSDT')).toBe('USDT');
    });
  });

  describe('findCommonTokensBetweenChains', () => {
    it('should find common tokens between Ethereum and Arbitrum', () => {
      const common = findCommonTokensBetweenChains('ethereum', 'arbitrum');
      expect(common).toContain('WETH');
      expect(common).toContain('USDT');
      expect(common).toContain('WBTC');
    });

    it('should be case-insensitive for chain IDs', () => {
      const common1 = findCommonTokensBetweenChains('ETHEREUM', 'arbitrum');
      const common2 = findCommonTokensBetweenChains('ethereum', 'ARBITRUM');
      expect(common1).toEqual(common2);
    });

    it('should return empty array for unknown chains', () => {
      const common = findCommonTokensBetweenChains('unknown1', 'unknown2');
      expect(common).toEqual([]);
    });

    it('should cache results for repeated calls', () => {
      // First call
      const first = findCommonTokensBetweenChains('bsc', 'polygon');
      // Second call should return same reference (cached)
      const second = findCommonTokensBetweenChains('bsc', 'polygon');
      expect(first).toBe(second); // Same reference = cached
    });

    it('should return same result regardless of chain order', () => {
      const ab = findCommonTokensBetweenChains('arbitrum', 'base');
      const ba = findCommonTokensBetweenChains('base', 'arbitrum');
      expect(ab).toEqual(ba);
    });
  });

  describe('preWarmCommonTokensCache', () => {
    it('should pre-warm cache without errors', () => {
      expect(() => preWarmCommonTokensCache()).not.toThrow();
    });
  });

  describe('getChainSpecificTokenSymbol', () => {
    it('should return chain-specific symbol for canonical token', () => {
      // Arbitrum uses standard WETH
      const arbWeth = getChainSpecificTokenSymbol('arbitrum', 'WETH');
      expect(arbWeth).toBe('WETH');
    });

    it('should return undefined for unknown canonical symbol', () => {
      const unknown = getChainSpecificTokenSymbol('ethereum', 'UNKNOWN_TOKEN');
      expect(unknown).toBeUndefined();
    });

    it('should be case-insensitive for chain ID', () => {
      const result1 = getChainSpecificTokenSymbol('ETHEREUM', 'WETH');
      const result2 = getChainSpecificTokenSymbol('ethereum', 'WETH');
      expect(result1).toBe(result2);
    });
  });

  describe('DEFAULT_QUOTE_TOKENS', () => {
    it('should have quote token for all mainnet chains', () => {
      for (const chainId of MAINNET_CHAIN_IDS) {
        expect(DEFAULT_QUOTE_TOKENS[chainId]).toBeDefined();
      }
    });

    it('should use USDT for BSC (BUSD deprecated)', () => {
      expect(DEFAULT_QUOTE_TOKENS['bsc']).toBe('USDT');
    });

    it('should use bridged USDC for Avalanche', () => {
      expect(DEFAULT_QUOTE_TOKENS['avalanche']).toBe('USDC.e');
    });
  });

  describe('getDefaultQuoteToken', () => {
    it('should return chain-specific quote token', () => {
      expect(getDefaultQuoteToken('ethereum')).toBe('USDC');
      expect(getDefaultQuoteToken('bsc')).toBe('USDT');
    });

    it('should fallback to USDC for unknown chains', () => {
      expect(getDefaultQuoteToken('unknown_chain')).toBe('USDC');
    });

    it('should be case-insensitive', () => {
      expect(getDefaultQuoteToken('ETHEREUM')).toBe('USDC');
      expect(getDefaultQuoteToken('Ethereum')).toBe('USDC');
    });
  });
});

// =============================================================================
// SERVICE CONFIG MODULE TESTS
// =============================================================================
describe('Service Config Module', () => {
  describe('SERVICE_CONFIGS', () => {
    it('should have redis configuration', () => {
      expect(SERVICE_CONFIGS.redis).toBeDefined();
      expect(SERVICE_CONFIGS.redis.url).toBeDefined();
    });

    it('should have monitoring configuration', () => {
      expect(SERVICE_CONFIGS.monitoring).toBeDefined();
      expect(typeof SERVICE_CONFIGS.monitoring.enabled).toBe('boolean');
      expect(typeof SERVICE_CONFIGS.monitoring.interval).toBe('number');
    });
  });

  describe('FLASH_LOAN_PROVIDERS', () => {
    it('should have providers for major chains', () => {
      const majorChains = ['ethereum', 'polygon', 'arbitrum', 'base', 'optimism', 'bsc'];
      for (const chain of majorChains) {
        expect(FLASH_LOAN_PROVIDERS[chain]).toBeDefined();
        expect(FLASH_LOAN_PROVIDERS[chain].address).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(FLASH_LOAN_PROVIDERS[chain].protocol).toBeDefined();
        expect(typeof FLASH_LOAN_PROVIDERS[chain].fee).toBe('number');
      }
    });

    it('should have valid Aave V3 fee (9 basis points)', () => {
      expect(FLASH_LOAN_PROVIDERS['ethereum'].fee).toBe(9);
      expect(FLASH_LOAN_PROVIDERS['arbitrum'].fee).toBe(9);
    });

    it('should have provider for new chains', () => {
      expect(FLASH_LOAN_PROVIDERS['avalanche']).toBeDefined();
      expect(FLASH_LOAN_PROVIDERS['fantom']).toBeDefined();
      expect(FLASH_LOAN_PROVIDERS['zksync']).toBeDefined();
      // Note: Linea flash loan provider is TODO in source
    });

    it('should have explicit Solana entry with Jupiter protocol (different model)', () => {
      // Solana uses Jupiter atomic swaps instead of traditional flash loans
      expect(FLASH_LOAN_PROVIDERS['solana']).toBeDefined();
      expect(FLASH_LOAN_PROVIDERS['solana'].protocol).toBe('jupiter');
      expect(FLASH_LOAN_PROVIDERS['solana'].address).toBe(''); // Empty - uses different mechanism
      expect(FLASH_LOAN_PROVIDERS['solana'].fee).toBe(0); // Jupiter has no flash loan fee
    });

    describe('supportsFlashLoan helper', () => {
      it('should return true for EVM chains with flash loan support', () => {
        expect(supportsFlashLoan('ethereum')).toBe(true);
        expect(supportsFlashLoan('arbitrum')).toBe(true);
        expect(supportsFlashLoan('polygon')).toBe(true);
      });

      it('should return false for Solana (uses Jupiter instead)', () => {
        expect(supportsFlashLoan('solana')).toBe(false);
      });

      it('should return false for unknown chains', () => {
        expect(supportsFlashLoan('unknown-chain')).toBe(false);
      });
    });
  });

  describe('BRIDGE_COSTS', () => {
    it('should have bridge costs defined', () => {
      expect(BRIDGE_COSTS.length).toBeGreaterThan(0);
    });

    it('should have required properties for each bridge cost', () => {
      for (const cost of BRIDGE_COSTS) {
        expect(cost.bridge).toBeDefined();
        expect(cost.sourceChain).toBeDefined();
        expect(cost.targetChain).toBeDefined();
        expect(typeof cost.feeBps).toBe('number');
        expect(typeof cost.minFeeUsd).toBe('number');
        expect(typeof cost.estimatedLatencySeconds).toBe('number');
        expect(typeof cost.reliability).toBe('number');
        expect(cost.reliability).toBeGreaterThanOrEqual(0);
        expect(cost.reliability).toBeLessThanOrEqual(1);
      }
    });

    it('should have Solana bridge routes (Wormhole)', () => {
      const solanaBridges = BRIDGE_COSTS.filter(
        (b: { sourceChain: string; targetChain: string }) => b.sourceChain === 'solana' || b.targetChain === 'solana'
      );
      expect(solanaBridges.length).toBeGreaterThan(0);
      expect(solanaBridges.every((b: { bridge: string }) => b.bridge === 'wormhole')).toBe(true);
    });
  });

  describe('getBridgeCost', () => {
    it('should return bridge cost for valid route', () => {
      const cost = getBridgeCost('ethereum', 'arbitrum');
      expect(cost).toBeDefined();
      expect(cost!.feeBps).toBeGreaterThanOrEqual(0);
    });

    it('should return undefined for invalid route', () => {
      const cost = getBridgeCost('unknown1', 'unknown2');
      expect(cost).toBeUndefined();
    });

    it('should return specific bridge when requested', () => {
      const stargateEthArb = getBridgeCost('ethereum', 'arbitrum', 'stargate');
      const acrossEthArb = getBridgeCost('ethereum', 'arbitrum', 'across');

      expect(stargateEthArb).toBeDefined();
      expect(acrossEthArb).toBeDefined();
      expect(stargateEthArb!.bridge).toBe('stargate');
      expect(acrossEthArb!.bridge).toBe('across');
    });

    it('should return best (lowest fee) bridge by default', () => {
      const best = getBridgeCost('ethereum', 'arbitrum');
      const all = getAllBridgeOptions('ethereum', 'arbitrum');

      if (all.length > 1) {
        const lowestFee = Math.min(...all.map((b: { feeBps: number }) => b.feeBps));
        expect(best!.feeBps).toBe(lowestFee);
      }
    });

    it('should be case-insensitive', () => {
      const cost1 = getBridgeCost('ETHEREUM', 'ARBITRUM');
      const cost2 = getBridgeCost('ethereum', 'arbitrum');
      expect(cost1).toEqual(cost2);
    });
  });

  describe('getAllBridgeOptions', () => {
    it('should return all bridge options for a route', () => {
      const options = getAllBridgeOptions('ethereum', 'arbitrum');
      expect(options.length).toBeGreaterThan(0);
    });

    it('should return empty array for unknown route', () => {
      const options = getAllBridgeOptions('unknown1', 'unknown2');
      expect(options).toEqual([]);
    });
  });

  describe('calculateBridgeCostUsd', () => {
    it('should calculate bridge cost for given amount', () => {
      const result = calculateBridgeCostUsd('ethereum', 'arbitrum', 10000);
      expect(result).toBeDefined();
      expect(result!.fee).toBeGreaterThan(0);
      expect(result!.latency).toBeGreaterThan(0);
      expect(result!.bridge).toBeDefined();
    });

    it('should respect minimum fee', () => {
      const smallAmount = calculateBridgeCostUsd('ethereum', 'arbitrum', 1);
      const cost = getBridgeCost('ethereum', 'arbitrum');
      expect(smallAmount!.fee).toBeGreaterThanOrEqual(cost!.minFeeUsd);
    });

    it('should return undefined for invalid route', () => {
      const result = calculateBridgeCostUsd('unknown1', 'unknown2', 10000);
      expect(result).toBeUndefined();
    });
  });

  // ===========================================================================
  // Phase 3: Dynamic Bridge Selection Tests
  // ===========================================================================
  describe('selectOptimalBridge', () => {
    const { selectOptimalBridge, selectOptimalBridgeFast } = require('../../src/bridge-config');

    it('should return undefined for invalid routes', () => {
      const result = selectOptimalBridge('unknown1', 'unknown2');
      expect(result).toBeUndefined();
    });

    it('should return optimal bridge for valid routes', () => {
      const result = selectOptimalBridge('ethereum', 'arbitrum');
      expect(result).toBeDefined();
      expect(result!.config).toBeDefined();
      expect(result!.score).toBeGreaterThan(0);
      expect(result!.score).toBeLessThanOrEqual(1);
    });

    it('should include normalized scores in result', () => {
      const result = selectOptimalBridge('ethereum', 'arbitrum', 10000);
      expect(result).toBeDefined();
      expect(result!.normalizedLatency).toBeGreaterThanOrEqual(0);
      expect(result!.normalizedLatency).toBeLessThanOrEqual(1);
      expect(result!.normalizedCost).toBeGreaterThanOrEqual(0);
      expect(result!.normalizedCost).toBeLessThanOrEqual(1);
      expect(result!.reliabilityScore).toBeGreaterThanOrEqual(0);
      expect(result!.reliabilityScore).toBeLessThanOrEqual(1);
    });

    it('should respect urgency parameter for scoring', () => {
      // High urgency should favor faster bridges
      const highUrgency = selectOptimalBridge('ethereum', 'arbitrum', 10000, 'high');
      const lowUrgency = selectOptimalBridge('ethereum', 'arbitrum', 10000, 'low');

      // Both should return valid results
      expect(highUrgency).toBeDefined();
      expect(lowUrgency).toBeDefined();

      // Both should have valid scores (may select same bridge)
      expect(highUrgency!.score).toBeGreaterThan(0);
      expect(lowUrgency!.score).toBeGreaterThan(0);
    });

    it('should be case-insensitive', () => {
      const lower = selectOptimalBridge('ethereum', 'arbitrum');
      const upper = selectOptimalBridge('ETHEREUM', 'ARBITRUM');
      expect(lower!.config.bridge).toBe(upper!.config.bridge);
    });

    it('selectOptimalBridgeFast should match selectOptimalBridge for lowercase inputs', () => {
      const slow = selectOptimalBridge('ethereum', 'arbitrum', 10000, 'medium');
      const fast = selectOptimalBridgeFast('ethereum', 'arbitrum', 10000, 'medium');
      expect(fast!.config.bridge).toBe(slow!.config.bridge);
      expect(fast!.score).toBeCloseTo(slow!.score, 5);
    });

    it('should include Hyperlane as a bridge option when available', () => {
      // Phase 3 added Hyperlane routes
      const options = getAllBridgeOptions('ethereum', 'arbitrum');
      const hasHyperlane = options.some(opt => opt.bridge === 'hyperlane');
      expect(hasHyperlane).toBe(true);
    });

    // Regression test for P3-001: normalizedLatency was negative for slow bridges
    it('should return normalized scores in [0,1] range even for slow native bridges', () => {
      // Routes with native bridges have very long latencies (7 days = 604800s)
      // normalizedLatency should still be in [0,1] range, not negative
      const result = selectOptimalBridge('base', 'ethereum', 1000, 'low');
      expect(result).toBeDefined();
      expect(result!.normalizedLatency).toBeGreaterThanOrEqual(0);
      expect(result!.normalizedLatency).toBeLessThanOrEqual(1);
    });
  });
});

// =============================================================================
// THRESHOLDS MODULE TESTS
// =============================================================================
describe('Thresholds Module', () => {
  describe('PERFORMANCE_THRESHOLDS', () => {
    it('should have valid performance thresholds', () => {
      expect(PERFORMANCE_THRESHOLDS.maxEventLatency).toBeGreaterThan(0);
      expect(PERFORMANCE_THRESHOLDS.minCacheHitRate).toBeGreaterThanOrEqual(0);
      expect(PERFORMANCE_THRESHOLDS.minCacheHitRate).toBeLessThanOrEqual(1);
      expect(PERFORMANCE_THRESHOLDS.maxMemoryUsage).toBeGreaterThan(0);
    });
  });

  describe('ARBITRAGE_CONFIG', () => {
    it('should have valid arbitrage configuration', () => {
      expect(ARBITRAGE_CONFIG.minProfitPercentage).toBeGreaterThan(0);
      expect(ARBITRAGE_CONFIG.minProfitPercentage).toBeLessThan(1); // Should be decimal
      expect(ARBITRAGE_CONFIG.confidenceThreshold).toBeGreaterThanOrEqual(0);
      expect(ARBITRAGE_CONFIG.confidenceThreshold).toBeLessThanOrEqual(1);
    });

    it('should have cross-chain enabled', () => {
      expect(ARBITRAGE_CONFIG.crossChainEnabled).toBe(true);
    });

    it('should have triangular enabled', () => {
      expect(ARBITRAGE_CONFIG.triangularEnabled).toBe(true);
    });
  });

  describe('getMinProfitThreshold', () => {
    it('should return chain-specific threshold', () => {
      const ethThreshold = getMinProfitThreshold('ethereum');
      const arbThreshold = getMinProfitThreshold('arbitrum');

      expect(ethThreshold).toBeGreaterThan(0);
      expect(arbThreshold).toBeGreaterThan(0);
      // Ethereum should have higher threshold (gas costs)
      expect(ethThreshold).toBeGreaterThan(arbThreshold);
    });

    it('should return default threshold for unknown chain', () => {
      const threshold = getMinProfitThreshold('unknown_chain');
      expect(threshold).toBeGreaterThan(0);
    });
  });
});

// =============================================================================
// MEV CONFIG MODULE TESTS
// =============================================================================
describe('MEV Config Module', () => {
  describe('MEV_CONFIG', () => {
    it('should have enabled property', () => {
      expect(typeof MEV_CONFIG.enabled).toBe('boolean');
    });

    it('should have chain-specific MEV settings', () => {
      expect(MEV_CONFIG.chainSettings).toBeDefined();
    });

    it('should have Flashbots config for Ethereum', () => {
      expect(MEV_CONFIG.chainSettings.ethereum).toBeDefined();
      expect(MEV_CONFIG.chainSettings.ethereum.strategy).toBe('flashbots');
    });

    it('should have all mainnet chains configured', () => {
      const expectedChains = [
        'ethereum', 'arbitrum', 'optimism', 'base', 'polygon',
        'bsc', 'avalanche', 'fantom', 'zksync', 'linea', 'solana'
      ];
      for (const chain of expectedChains) {
        expect(MEV_CONFIG.chainSettings[chain]).toBeDefined();
        expect(MEV_CONFIG.chainSettings[chain].enabled).toBe(true);
      }
    });

    it('should have Jito strategy for Solana', () => {
      expect(MEV_CONFIG.chainSettings.solana.strategy).toBe('jito');
    });
  });
});

// =============================================================================
// SYSTEM CONSTANTS MODULE TESTS
// =============================================================================
describe('System Constants Module', () => {
  describe('SYSTEM_CONSTANTS', () => {
    it('should have Redis configuration', () => {
      expect(SYSTEM_CONSTANTS.redis).toBeDefined();
      expect(SYSTEM_CONSTANTS.redis.maxMessageSize).toBeGreaterThan(0);
      expect(SYSTEM_CONSTANTS.redis.healthDataTtl).toBeGreaterThan(0);
    });

    it('should have cache configuration', () => {
      expect(SYSTEM_CONSTANTS.cache).toBeDefined();
      expect(SYSTEM_CONSTANTS.cache.defaultL1SizeMb).toBeGreaterThan(0);
      expect(SYSTEM_CONSTANTS.cache.defaultL2TtlSeconds).toBeGreaterThan(0);
    });

    it('should have WebSocket configuration', () => {
      expect(SYSTEM_CONSTANTS.webSocket).toBeDefined();
      expect(SYSTEM_CONSTANTS.webSocket.defaultReconnectDelayMs).toBeGreaterThan(0);
      expect(SYSTEM_CONSTANTS.webSocket.maxReconnectDelayMs).toBeGreaterThan(0);
    });

    it('should have circuit breaker configuration', () => {
      expect(SYSTEM_CONSTANTS.circuitBreaker).toBeDefined();
      expect(SYSTEM_CONSTANTS.circuitBreaker.defaultFailureThreshold).toBeGreaterThan(0);
    });

    it('should have timeout configuration', () => {
      expect(SYSTEM_CONSTANTS.timeouts).toBeDefined();
      expect(SYSTEM_CONSTANTS.timeouts.httpHealthCheck).toBeGreaterThan(0);
      expect(SYSTEM_CONSTANTS.timeouts.rpcRequest).toBeGreaterThan(0);
    });
  });
});

// =============================================================================
// DETECTOR CONFIG MODULE TESTS
// =============================================================================
describe('Detector Config Module', () => {
  describe('DETECTOR_CONFIG', () => {
    it('should have config for mainnet chains', () => {
      const chains = ['ethereum', 'arbitrum', 'bsc', 'polygon', 'base', 'optimism'];
      for (const chain of chains) {
        if (DETECTOR_CONFIG[chain]) {
          expect(DETECTOR_CONFIG[chain].batchSize).toBeGreaterThan(0);
          expect(DETECTOR_CONFIG[chain].batchTimeout).toBeGreaterThan(0);
        }
      }
    });

    it('should have valid batch sizes', () => {
      for (const [, config] of Object.entries(DETECTOR_CONFIG) as [string, { batchSize: number }][]) {
        expect(config.batchSize).toBeGreaterThan(0);
        expect(config.batchSize).toBeLessThanOrEqual(1000); // Reasonable upper limit
      }
    });

    it('should have all mainnet chains configured', () => {
      const expectedChains = [
        'ethereum', 'arbitrum', 'optimism', 'base', 'polygon',
        'bsc', 'avalanche', 'fantom', 'zksync', 'linea', 'solana'
      ];
      for (const chain of expectedChains) {
        expect(DETECTOR_CONFIG[chain]).toBeDefined();
      }
    });
  });
});

// =============================================================================
// CHAINS MODULE TESTS (New exports)
// =============================================================================
describe('Chains Module', () => {
  describe('MAINNET_CHAIN_IDS', () => {
    it('should have exactly 11 mainnet chains', () => {
      expect(MAINNET_CHAIN_IDS.length).toBe(11);
    });

    it('should include all expected mainnet chains', () => {
      const expected = [
        'arbitrum', 'bsc', 'base', 'polygon', 'optimism',
        'ethereum', 'avalanche', 'fantom', 'zksync', 'linea', 'solana'
      ];
      for (const chain of expected) {
        expect(MAINNET_CHAIN_IDS).toContain(chain);
      }
    });

    it('should NOT include devnet/testnet', () => {
      expect(MAINNET_CHAIN_IDS).not.toContain('solana-devnet');
    });
  });

  describe('CHAINS', () => {
    it('should have exactly 11 chains (no devnet)', () => {
      expect(Object.keys(CHAINS).length).toBe(11);
    });

    it('should NOT include solana-devnet', () => {
      expect(CHAINS['solana-devnet']).toBeUndefined();
    });

    it('should include mainnet Solana', () => {
      expect(CHAINS['solana']).toBeDefined();
      expect(CHAINS['solana'].id).toBe(101);
      expect(CHAINS['solana'].isEVM).toBe(false);
    });
  });

  describe('TESTNET_CHAINS', () => {
    it('should include solana-devnet', () => {
      expect(TESTNET_CHAINS['solana-devnet']).toBeDefined();
      expect(TESTNET_CHAINS['solana-devnet'].id).toBe(102);
    });
  });

  describe('getAllChains', () => {
    // Import getAllChains for this test
    let getAllChains: () => Record<string, import('../../../types').Chain>;

    beforeAll(async () => {
      const module = await import('../../src/chains');
      getAllChains = module.getAllChains;
    });

    it('should return combined mainnet and testnet chains', () => {
      const allChains = getAllChains();
      // Should have 11 mainnet + 1 testnet = 12 total
      expect(Object.keys(allChains).length).toBe(12);
    });

    it('should include both mainnet Solana and devnet', () => {
      const allChains = getAllChains();
      expect(allChains['solana']).toBeDefined();
      expect(allChains['solana-devnet']).toBeDefined();
    });

    it('should return new object (not mutate original)', () => {
      const allChains1 = getAllChains();
      const allChains2 = getAllChains();
      expect(allChains1).not.toBe(allChains2); // Different references
      expect(allChains1).toEqual(allChains2);  // Same content
    });

    it('should include all expected chain properties', () => {
      const allChains = getAllChains();
      for (const [, chain] of Object.entries(allChains)) {
        expect(chain.id).toBeDefined();
        expect(chain.name).toBeDefined();
        expect(chain.rpcUrl).toBeDefined();
        expect(chain.blockTime).toBeDefined();
        expect(chain.nativeToken).toBeDefined();
      }
    });
  });
});

// =============================================================================
// EVENT CONFIG MODULE TESTS
// =============================================================================
describe('Event Config Module', () => {
  // Import event config
  let EVENT_CONFIG: typeof import('../../src/event-config').EVENT_CONFIG;
  let EVENT_SIGNATURES: typeof import('../../src/event-config').EVENT_SIGNATURES;

  beforeAll(async () => {
    const module = await import('../../src/event-config');
    EVENT_CONFIG = module.EVENT_CONFIG;
    EVENT_SIGNATURES = module.EVENT_SIGNATURES;
  });

  describe('EVENT_CONFIG', () => {
    it('should have syncEvents configuration', () => {
      expect(EVENT_CONFIG.syncEvents).toBeDefined();
      expect(typeof EVENT_CONFIG.syncEvents.enabled).toBe('boolean');
      expect(EVENT_CONFIG.syncEvents.priority).toBeDefined();
    });

    it('should have swapEvents configuration', () => {
      expect(EVENT_CONFIG.swapEvents).toBeDefined();
      expect(typeof EVENT_CONFIG.swapEvents.enabled).toBe('boolean');
      expect(typeof EVENT_CONFIG.swapEvents.minAmountUSD).toBe('number');
      expect(typeof EVENT_CONFIG.swapEvents.whaleThreshold).toBe('number');
      expect(typeof EVENT_CONFIG.swapEvents.samplingRate).toBe('number');
    });

    it('should have valid sampling rate (0-1)', () => {
      expect(EVENT_CONFIG.swapEvents.samplingRate).toBeGreaterThanOrEqual(0);
      expect(EVENT_CONFIG.swapEvents.samplingRate).toBeLessThanOrEqual(1);
    });

    it('should have whale threshold greater than min amount', () => {
      expect(EVENT_CONFIG.swapEvents.whaleThreshold).toBeGreaterThan(
        EVENT_CONFIG.swapEvents.minAmountUSD
      );
    });

    it('should have sync events enabled by default', () => {
      expect(EVENT_CONFIG.syncEvents.enabled).toBe(true);
    });

    it('should have swap events enabled by default', () => {
      expect(EVENT_CONFIG.swapEvents.enabled).toBe(true);
    });
  });

  describe('EVENT_SIGNATURES', () => {
    it('should have SYNC event signature', () => {
      expect(EVENT_SIGNATURES.SYNC).toBeDefined();
      expect(EVENT_SIGNATURES.SYNC).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    it('should have SWAP_V2 event signature', () => {
      expect(EVENT_SIGNATURES.SWAP_V2).toBeDefined();
      expect(EVENT_SIGNATURES.SWAP_V2).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    it('should have SWAP_V3 event signature', () => {
      expect(EVENT_SIGNATURES.SWAP_V3).toBeDefined();
      expect(EVENT_SIGNATURES.SWAP_V3).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    it('should have correct Uniswap V2 Sync signature', () => {
      // keccak256("Sync(uint112,uint112)")
      expect(EVENT_SIGNATURES.SYNC).toBe(
        '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1'
      );
    });

    it('should have correct Uniswap V2 Swap signature', () => {
      // keccak256("Swap(address,uint256,uint256,uint256,uint256,address)")
      expect(EVENT_SIGNATURES.SWAP_V2).toBe(
        '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'
      );
    });

    it('should have correct Uniswap V3 Swap signature', () => {
      // keccak256("Swap(address,address,int256,int256,uint160,uint128,int24)")
      expect(EVENT_SIGNATURES.SWAP_V3).toBe(
        '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
      );
    });

    it('should have unique signatures', () => {
      const signatures = Object.values(EVENT_SIGNATURES);
      const uniqueSignatures = new Set(signatures);
      expect(uniqueSignatures.size).toBe(signatures.length);
    });
  });
});
