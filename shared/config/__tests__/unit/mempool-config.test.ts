/**
 * Mempool Config Tests
 *
 * Comprehensive test coverage for mempool-config.ts (Finding #12).
 * Tests all exported functions and constants: chain ID utilities,
 * router lookups, mempool settings, and Curve pool tokens.
 *
 * @see .agent-reports/shared-config-deep-analysis.md Finding #12
 */

import { describe, it, expect } from '@jest/globals';

import {
  // Constants
  MEMPOOL_CONFIG,
  KNOWN_ROUTERS,
  CHAIN_NAME_TO_ID,
  CHAIN_ID_TO_NAME,
  CURVE_POOL_TOKENS,
  // Functions
  resolveChainId,
  getChainName,
  getKnownRouters,
  getRouterInfo,
  isMempoolEnabledForChain,
  getChainMempoolConfig,
  getEnabledMempoolChains,
  getCurvePoolTokens,
} from '../../src';

// =============================================================================
// CHAIN_NAME_TO_ID / CHAIN_ID_TO_NAME CONSTANTS
// =============================================================================

describe('CHAIN_NAME_TO_ID', () => {
  it('should have all 8 primary chains mapped', () => {
    expect(CHAIN_NAME_TO_ID['ethereum']).toBe(1);
    expect(CHAIN_NAME_TO_ID['bsc']).toBe(56);
    expect(CHAIN_NAME_TO_ID['polygon']).toBe(137);
    expect(CHAIN_NAME_TO_ID['arbitrum']).toBe(42161);
    expect(CHAIN_NAME_TO_ID['optimism']).toBe(10);
    expect(CHAIN_NAME_TO_ID['base']).toBe(8453);
    expect(CHAIN_NAME_TO_ID['avalanche']).toBe(43114);
    expect(CHAIN_NAME_TO_ID['fantom']).toBe(250);
  });

  it('should have common aliases mapped', () => {
    expect(CHAIN_NAME_TO_ID['mainnet']).toBe(1);
    expect(CHAIN_NAME_TO_ID['eth']).toBe(1);
    expect(CHAIN_NAME_TO_ID['binance']).toBe(56);
    expect(CHAIN_NAME_TO_ID['matic']).toBe(137);
    expect(CHAIN_NAME_TO_ID['arb']).toBe(42161);
    expect(CHAIN_NAME_TO_ID['op']).toBe(10);
    expect(CHAIN_NAME_TO_ID['avax']).toBe(43114);
  });

  it('should return undefined for unknown chains', () => {
    expect(CHAIN_NAME_TO_ID['nonexistent']).toBeUndefined();
    expect(CHAIN_NAME_TO_ID['']).toBeUndefined();
  });
});

describe('CHAIN_ID_TO_NAME', () => {
  it('should reverse-map all 8 primary chain IDs to names', () => {
    expect(CHAIN_ID_TO_NAME[1]).toBe('ethereum');
    expect(CHAIN_ID_TO_NAME[56]).toBe('bsc');
    expect(CHAIN_ID_TO_NAME[137]).toBe('polygon');
    expect(CHAIN_ID_TO_NAME[42161]).toBe('arbitrum');
    expect(CHAIN_ID_TO_NAME[10]).toBe('optimism');
    expect(CHAIN_ID_TO_NAME[8453]).toBe('base');
    expect(CHAIN_ID_TO_NAME[43114]).toBe('avalanche');
    expect(CHAIN_ID_TO_NAME[250]).toBe('fantom');
  });

  it('should return undefined for unknown chain IDs', () => {
    expect(CHAIN_ID_TO_NAME[999999]).toBeUndefined();
    expect(CHAIN_ID_TO_NAME[0]).toBeUndefined();
  });

  it('should have bidirectional consistency with CHAIN_NAME_TO_ID', () => {
    // For every primary chain in CHAIN_ID_TO_NAME, CHAIN_NAME_TO_ID should reverse it
    for (const [idStr, name] of Object.entries(CHAIN_ID_TO_NAME)) {
      const id = Number(idStr);
      expect(CHAIN_NAME_TO_ID[name]).toBe(id);
    }
  });
});

// =============================================================================
// resolveChainId()
// =============================================================================

describe('resolveChainId', () => {
  it('should return numeric ID when given a number', () => {
    expect(resolveChainId(1)).toBe(1);
    expect(resolveChainId(56)).toBe(56);
    expect(resolveChainId(42161)).toBe(42161);
  });

  it('should resolve known chain names to numeric IDs', () => {
    expect(resolveChainId('ethereum')).toBe(1);
    expect(resolveChainId('bsc')).toBe(56);
    expect(resolveChainId('polygon')).toBe(137);
    expect(resolveChainId('arbitrum')).toBe(42161);
    expect(resolveChainId('optimism')).toBe(10);
    expect(resolveChainId('base')).toBe(8453);
    expect(resolveChainId('avalanche')).toBe(43114);
    expect(resolveChainId('fantom')).toBe(250);
  });

  it('should resolve aliases', () => {
    expect(resolveChainId('mainnet')).toBe(1);
    expect(resolveChainId('eth')).toBe(1);
    expect(resolveChainId('matic')).toBe(137);
    expect(resolveChainId('arb')).toBe(42161);
    expect(resolveChainId('avax')).toBe(43114);
  });

  it('should be case-insensitive', () => {
    expect(resolveChainId('Ethereum')).toBe(1);
    expect(resolveChainId('BSC')).toBe(56);
    expect(resolveChainId('POLYGON')).toBe(137);
    expect(resolveChainId('Arbitrum')).toBe(42161);
  });

  it('should return default chain ID (1) for unknown string', () => {
    expect(resolveChainId('unknown')).toBe(1);
    expect(resolveChainId('')).toBe(1);
    expect(resolveChainId('not-a-chain')).toBe(1);
  });

  it('should use custom default when provided', () => {
    expect(resolveChainId('unknown', 56)).toBe(56);
    expect(resolveChainId('not-a-chain', 0)).toBe(0);
  });

  it('should pass through arbitrary numeric IDs unchanged', () => {
    expect(resolveChainId(999999)).toBe(999999);
    expect(resolveChainId(0)).toBe(0);
    expect(resolveChainId(-1)).toBe(-1);
  });
});

// =============================================================================
// getChainName()
// =============================================================================

describe('getChainName', () => {
  it('should return chain names for known IDs', () => {
    expect(getChainName(1)).toBe('ethereum');
    expect(getChainName(56)).toBe('bsc');
    expect(getChainName(137)).toBe('polygon');
    expect(getChainName(42161)).toBe('arbitrum');
    expect(getChainName(10)).toBe('optimism');
    expect(getChainName(8453)).toBe('base');
    expect(getChainName(43114)).toBe('avalanche');
    expect(getChainName(250)).toBe('fantom');
  });

  it('should return "unknown" for unrecognized chain IDs', () => {
    expect(getChainName(999999)).toBe('unknown');
    expect(getChainName(0)).toBe('unknown');
    expect(getChainName(-1)).toBe('unknown');
  });
});

// =============================================================================
// KNOWN_ROUTERS constant
// =============================================================================

describe('KNOWN_ROUTERS', () => {
  it('should have router entries for all 7 configured chains', () => {
    expect(Object.keys(KNOWN_ROUTERS)).toEqual(
      expect.arrayContaining(['ethereum', 'bsc', 'polygon', 'arbitrum', 'optimism', 'base', 'avalanche'])
    );
  });

  it('should have Uniswap V2 router on Ethereum', () => {
    const ethRouters = KNOWN_ROUTERS.ethereum;
    const uniV2 = ethRouters['0x7a250d5630b4cf539739df2c5dacb4c659f2488d'];
    expect(uniV2).toBeDefined();
    expect(uniV2.type).toBe('uniswapV2');
    expect(uniV2.name).toBe('Uniswap V2 Router');
  });

  it('should have PancakeSwap V2 router on BSC', () => {
    const bscRouters = KNOWN_ROUTERS.bsc;
    const pancakeV2 = bscRouters['0x10ed43c718714eb63d5aa57b78b54704e256024e'];
    expect(pancakeV2).toBeDefined();
    expect(pancakeV2.type).toBe('uniswapV2');
    expect(pancakeV2.name).toBe('PancakeSwap V2 Router');
  });

  it('should have all router addresses in lowercase', () => {
    for (const [, chainRouters] of Object.entries(KNOWN_ROUTERS)) {
      for (const address of Object.keys(chainRouters)) {
        expect(address).toBe(address.toLowerCase());
      }
    }
  });

  it('should have correct types for each router', () => {
    // Verify valid types exist
    const validTypes = ['uniswapV2', 'uniswapV3', 'sushiswap', '1inch', 'curve'];
    for (const [, chainRouters] of Object.entries(KNOWN_ROUTERS)) {
      for (const [, router] of Object.entries(chainRouters)) {
        expect(validTypes).toContain(router.type);
      }
    }
  });

  it('should have 1inch on multiple chains', () => {
    const oneInchAddress = '0x1111111254eeb25477b68fb85ed929f73a960582';
    expect(KNOWN_ROUTERS.ethereum[oneInchAddress]).toBeDefined();
    expect(KNOWN_ROUTERS.bsc[oneInchAddress]).toBeDefined();
    expect(KNOWN_ROUTERS.polygon[oneInchAddress]).toBeDefined();
    expect(KNOWN_ROUTERS.arbitrum[oneInchAddress]).toBeDefined();
    expect(KNOWN_ROUTERS.avalanche[oneInchAddress]).toBeDefined();
  });
});

// =============================================================================
// getKnownRouters()
// =============================================================================

describe('getKnownRouters', () => {
  it('should return routers for known chains', () => {
    const ethRouters = getKnownRouters('ethereum');
    expect(Object.keys(ethRouters).length).toBeGreaterThan(0);
    expect(ethRouters['0x7a250d5630b4cf539739df2c5dacb4c659f2488d']).toBeDefined();
  });

  it('should be case-insensitive for chain names', () => {
    const lower = getKnownRouters('ethereum');
    const upper = getKnownRouters('Ethereum');
    const mixed = getKnownRouters('ETHEREUM');
    expect(lower).toEqual(upper);
    expect(lower).toEqual(mixed);
  });

  it('should return empty object for unknown chains', () => {
    const result = getKnownRouters('nonexistent');
    expect(result).toEqual({});
  });

  it('should return empty object for empty string', () => {
    const result = getKnownRouters('');
    expect(result).toEqual({});
  });
});

// =============================================================================
// getRouterInfo()
// =============================================================================

describe('getRouterInfo', () => {
  it('should return router info for known chain + address pair', () => {
    const info = getRouterInfo('ethereum', '0x7a250d5630b4cf539739df2c5dacb4c659f2488d');
    expect(info).toBeDefined();
    expect(info!.type).toBe('uniswapV2');
    expect(info!.name).toBe('Uniswap V2 Router');
  });

  it('should handle mixed-case addresses (normalizes to lowercase)', () => {
    const info = getRouterInfo('ethereum', '0x7A250D5630B4CF539739DF2C5DACB4C659F2488D');
    expect(info).toBeDefined();
    expect(info!.type).toBe('uniswapV2');
  });

  it('should handle mixed-case chain names', () => {
    const info = getRouterInfo('BSC', '0x10ed43c718714eb63d5aa57b78b54704e256024e');
    expect(info).toBeDefined();
    expect(info!.name).toBe('PancakeSwap V2 Router');
  });

  it('should return undefined for unknown router address', () => {
    const info = getRouterInfo('ethereum', '0x0000000000000000000000000000000000000000');
    expect(info).toBeUndefined();
  });

  it('should return undefined for unknown chain', () => {
    const info = getRouterInfo('nonexistent', '0x7a250d5630b4cf539739df2c5dacb4c659f2488d');
    expect(info).toBeUndefined();
  });

  it('should return correct info for routers on different chains', () => {
    // SushiSwap is on multiple chains with same address
    const sushiBsc = getRouterInfo('bsc', '0x1b02da8cb0d097eb8d57a175b88c7d8b47997506');
    const sushiPolygon = getRouterInfo('polygon', '0x1b02da8cb0d097eb8d57a175b88c7d8b47997506');
    expect(sushiBsc).toBeDefined();
    expect(sushiPolygon).toBeDefined();
    expect(sushiBsc!.type).toBe('sushiswap');
    expect(sushiPolygon!.type).toBe('sushiswap');
  });
});

// =============================================================================
// MEMPOOL_CONFIG constant
// =============================================================================

describe('MEMPOOL_CONFIG', () => {
  it('should have the expected top-level structure', () => {
    expect(MEMPOOL_CONFIG).toHaveProperty('enabled');
    expect(MEMPOOL_CONFIG).toHaveProperty('bloxroute');
    expect(MEMPOOL_CONFIG).toHaveProperty('service');
    expect(MEMPOOL_CONFIG).toHaveProperty('filters');
    expect(MEMPOOL_CONFIG).toHaveProperty('streams');
    expect(MEMPOOL_CONFIG).toHaveProperty('chainSettings');
  });

  it('should have bloxroute config with default values', () => {
    expect(MEMPOOL_CONFIG.bloxroute.wsEndpoint).toBe('wss://eth.blxrbdn.com/ws');
    expect(MEMPOOL_CONFIG.bloxroute.bscWsEndpoint).toBe('wss://bsc.blxrbdn.com/ws');
    expect(MEMPOOL_CONFIG.bloxroute.connectionTimeout).toBe(10000);
    expect(MEMPOOL_CONFIG.bloxroute.heartbeatInterval).toBe(30000);
  });

  it('should have bloxroute reconnect settings with defaults', () => {
    const reconnect = MEMPOOL_CONFIG.bloxroute.reconnect;
    expect(reconnect.interval).toBe(1000);
    expect(reconnect.maxAttempts).toBe(10);
    expect(reconnect.backoffMultiplier).toBe(2.0);
    expect(reconnect.maxDelay).toBe(60000);
  });

  it('should have service config with default port 3007', () => {
    expect(MEMPOOL_CONFIG.service.port).toBe(3007);
    expect(MEMPOOL_CONFIG.service.maxBufferSize).toBe(10000);
    expect(MEMPOOL_CONFIG.service.batchSize).toBe(100);
    expect(MEMPOOL_CONFIG.service.batchTimeoutMs).toBe(50);
  });

  it('should have filter defaults', () => {
    expect(MEMPOOL_CONFIG.filters.minSwapSizeUsd).toBe(1000);
    expect(MEMPOOL_CONFIG.filters.includeTraders).toEqual([]);
    expect(MEMPOOL_CONFIG.filters.includeRouters).toEqual([]);
  });

  it('should have stream config defaults', () => {
    expect(MEMPOOL_CONFIG.streams.pendingOpportunities).toBe('stream:pending-opportunities');
    expect(MEMPOOL_CONFIG.streams.consumerGroup).toBe('mempool-detector-group');
    expect(MEMPOOL_CONFIG.streams.maxStreamLength).toBe(100000);
  });

  it('should have chain settings for ethereum and bsc as enabled by default', () => {
    expect(MEMPOOL_CONFIG.chainSettings['ethereum'].enabled).toBe(true);
    expect(MEMPOOL_CONFIG.chainSettings['ethereum'].feedType).toBe('bloxroute');
    expect(MEMPOOL_CONFIG.chainSettings['bsc'].enabled).toBe(true);
    expect(MEMPOOL_CONFIG.chainSettings['bsc'].feedType).toBe('bloxroute');
  });

  it('should have L2 chains disabled by default', () => {
    expect(MEMPOOL_CONFIG.chainSettings['polygon'].enabled).toBe(false);
    expect(MEMPOOL_CONFIG.chainSettings['arbitrum'].enabled).toBe(false);
    expect(MEMPOOL_CONFIG.chainSettings['optimism'].enabled).toBe(false);
    expect(MEMPOOL_CONFIG.chainSettings['base'].enabled).toBe(false);
  });

  it('should have valid numeric defaults (no NaN)', () => {
    expect(Number.isNaN(MEMPOOL_CONFIG.bloxroute.connectionTimeout)).toBe(false);
    expect(Number.isNaN(MEMPOOL_CONFIG.bloxroute.heartbeatInterval)).toBe(false);
    expect(Number.isNaN(MEMPOOL_CONFIG.bloxroute.reconnect.interval)).toBe(false);
    expect(Number.isNaN(MEMPOOL_CONFIG.bloxroute.reconnect.maxAttempts)).toBe(false);
    expect(Number.isNaN(MEMPOOL_CONFIG.bloxroute.reconnect.backoffMultiplier)).toBe(false);
    expect(Number.isNaN(MEMPOOL_CONFIG.bloxroute.reconnect.maxDelay)).toBe(false);
    expect(Number.isNaN(MEMPOOL_CONFIG.service.port)).toBe(false);
    expect(Number.isNaN(MEMPOOL_CONFIG.service.maxBufferSize)).toBe(false);
    expect(Number.isNaN(MEMPOOL_CONFIG.service.batchSize)).toBe(false);
    expect(Number.isNaN(MEMPOOL_CONFIG.service.batchTimeoutMs)).toBe(false);
    expect(Number.isNaN(MEMPOOL_CONFIG.filters.minSwapSizeUsd)).toBe(false);
    expect(Number.isNaN(MEMPOOL_CONFIG.streams.maxStreamLength)).toBe(false);
  });
});

// =============================================================================
// isMempoolEnabledForChain()
// =============================================================================

describe('isMempoolEnabledForChain', () => {
  // Note: MEMPOOL_CONFIG.enabled defaults to false in test env
  // (MEMPOOL_DETECTION_ENABLED env var not set)

  it('should return false when global mempool detection is disabled', () => {
    // With MEMPOOL_DETECTION_ENABLED not set, global enabled = false
    expect(isMempoolEnabledForChain('ethereum')).toBe(false);
    expect(isMempoolEnabledForChain('bsc')).toBe(false);
  });

  it('should return false for chains that are disabled per-chain', () => {
    expect(isMempoolEnabledForChain('polygon')).toBe(false);
    expect(isMempoolEnabledForChain('arbitrum')).toBe(false);
    expect(isMempoolEnabledForChain('optimism')).toBe(false);
    expect(isMempoolEnabledForChain('base')).toBe(false);
  });

  it('should return false for unknown chains', () => {
    expect(isMempoolEnabledForChain('nonexistent')).toBe(false);
  });

  it('should be case-insensitive', () => {
    expect(isMempoolEnabledForChain('Ethereum')).toBe(false);
    expect(isMempoolEnabledForChain('BSC')).toBe(false);
  });
});

// =============================================================================
// getChainMempoolConfig()
// =============================================================================

describe('getChainMempoolConfig', () => {
  it('should return config for configured chains', () => {
    const ethConfig = getChainMempoolConfig('ethereum');
    expect(ethConfig).toBeDefined();
    expect(ethConfig!.enabled).toBe(true);
    expect(ethConfig!.feedType).toBe('bloxroute');
    expect(ethConfig!.pollIntervalMs).toBe(100);
    expect(ethConfig!.expectedLatencyMs).toBe(10);
  });

  it('should return BSC config with correct values', () => {
    const bscConfig = getChainMempoolConfig('bsc');
    expect(bscConfig).toBeDefined();
    expect(bscConfig!.enabled).toBe(true);
    expect(bscConfig!.feedType).toBe('bloxroute');
    expect(bscConfig!.pollIntervalMs).toBe(50);
    expect(bscConfig!.expectedLatencyMs).toBe(10);
  });

  it('should return disabled config for L2 chains', () => {
    const polygonConfig = getChainMempoolConfig('polygon');
    expect(polygonConfig).toBeDefined();
    expect(polygonConfig!.enabled).toBe(false);
    expect(polygonConfig!.feedType).toBe('rpc');
  });

  it('should be case-insensitive', () => {
    const config = getChainMempoolConfig('Ethereum');
    expect(config).toBeDefined();
    expect(config!.feedType).toBe('bloxroute');
  });

  it('should return undefined for unknown chains', () => {
    const config = getChainMempoolConfig('nonexistent');
    expect(config).toBeUndefined();
  });

  it('should return undefined for empty string', () => {
    const config = getChainMempoolConfig('');
    expect(config).toBeUndefined();
  });
});

// =============================================================================
// getEnabledMempoolChains()
// =============================================================================

describe('getEnabledMempoolChains', () => {
  // Note: MEMPOOL_CONFIG.enabled defaults to false in test env

  it('should return empty array when global mempool detection is disabled', () => {
    // MEMPOOL_DETECTION_ENABLED not set in test env
    const chains = getEnabledMempoolChains();
    expect(chains).toEqual([]);
  });
});

// =============================================================================
// CURVE_POOL_TOKENS constant
// =============================================================================

describe('CURVE_POOL_TOKENS', () => {
  it('should have pools configured for Ethereum (chainId 1)', () => {
    const ethPools = CURVE_POOL_TOKENS[1];
    expect(ethPools).toBeDefined();
    expect(Object.keys(ethPools).length).toBeGreaterThan(0);
  });

  it('should have 3pool on Ethereum with DAI, USDC, USDT', () => {
    const threePool = CURVE_POOL_TOKENS[1]['0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7'];
    expect(threePool).toBeDefined();
    expect(threePool).toHaveLength(3);
    // DAI
    expect(threePool[0]).toBe('0x6B175474E89094C44Da98b954EeadCDeBc5C5e818');
    // USDC
    expect(threePool[1]).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
    // USDT
    expect(threePool[2]).toBe('0xdAC17F958D2ee523a2206206994597C13D831ec7');
  });

  it('should have stETH pool on Ethereum', () => {
    const stethPool = CURVE_POOL_TOKENS[1]['0xdc24316b9ae028f1497c275eb9192a3ea0f67022'];
    expect(stethPool).toBeDefined();
    expect(stethPool).toHaveLength(2);
    // ETH sentinel
    expect(stethPool[0]).toBe('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE');
  });

  it('should have pools on Arbitrum (chainId 42161)', () => {
    const arbPools = CURVE_POOL_TOKENS[42161];
    expect(arbPools).toBeDefined();
    expect(Object.keys(arbPools).length).toBeGreaterThan(0);
  });

  it('should have pools on Polygon (chainId 137)', () => {
    const polyPools = CURVE_POOL_TOKENS[137];
    expect(polyPools).toBeDefined();
    expect(Object.keys(polyPools).length).toBeGreaterThan(0);
  });

  it('should return undefined for chains without Curve pools', () => {
    expect(CURVE_POOL_TOKENS[56]).toBeUndefined(); // BSC
    expect(CURVE_POOL_TOKENS[10]).toBeUndefined(); // Optimism
    expect(CURVE_POOL_TOKENS[8453]).toBeUndefined(); // Base
  });

  it('should have all pool addresses in lowercase', () => {
    for (const [, pools] of Object.entries(CURVE_POOL_TOKENS)) {
      for (const address of Object.keys(pools)) {
        expect(address).toBe(address.toLowerCase());
      }
    }
  });
});

// =============================================================================
// getCurvePoolTokens()
// =============================================================================

describe('getCurvePoolTokens', () => {
  it('should return token addresses for known pool', () => {
    const tokens = getCurvePoolTokens(1, '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7');
    expect(tokens).toBeDefined();
    expect(tokens!).toHaveLength(3);
  });

  it('should normalize pool address to lowercase', () => {
    // Use mixed-case version of 3pool address
    const tokens = getCurvePoolTokens(1, '0xBEBC44782C7DB0A1A60CB6FE97D0B483032FF1C7');
    expect(tokens).toBeDefined();
    expect(tokens!).toHaveLength(3);
  });

  it('should return undefined for unknown chain ID', () => {
    const tokens = getCurvePoolTokens(999, '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7');
    expect(tokens).toBeUndefined();
  });

  it('should return undefined for unknown pool address', () => {
    const tokens = getCurvePoolTokens(1, '0x0000000000000000000000000000000000000000');
    expect(tokens).toBeUndefined();
  });

  it('should return tokens for Arbitrum 2pool', () => {
    const tokens = getCurvePoolTokens(42161, '0x7f90122bf0700f9e7e1f688fe926940e8839f353');
    expect(tokens).toBeDefined();
    expect(tokens!).toHaveLength(2);
  });

  it('should return tokens for Polygon aave pool', () => {
    const tokens = getCurvePoolTokens(137, '0x445fe580ef8d70ff569ab36e80c647af338db351');
    expect(tokens).toBeDefined();
    expect(tokens!).toHaveLength(3);
  });

  it('should return undefined for chain 0', () => {
    const tokens = getCurvePoolTokens(0, '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7');
    expect(tokens).toBeUndefined();
  });
});
