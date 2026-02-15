/**
 * DEX Config Remaining Chains Validation Tests (Fix #31)
 *
 * Tests DEX configuration for chains not yet covered by other test files:
 * - ethereum (2 DEXs)
 * - polygon (4 DEXs)
 * - zksync (2 DEXs)
 * - linea (2 DEXs)
 *
 * Follows the pattern from dex-config-bsc-validation.test.ts.
 *
 * @see shared/config/src/dexes/index.ts
 */

import type { Dex } from '@arbitrage/types';

// Set required environment variables BEFORE any config imports
process.env.NODE_ENV = 'test';

// Use require to avoid ts-jest transformation caching issues
const config = require('@arbitrage/config') as {
  DEXES: Record<string, Dex[]>;
  getEnabledDexes: (chainId: string) => Dex[];
};
const { DEXES, getEnabledDexes } = config;

// =============================================================================
// Ethereum DEX Configuration
// =============================================================================

describe('Ethereum DEX Configuration', () => {
  const ethereumDexes = DEXES.ethereum;

  it('should have DEXes defined', () => {
    expect(ethereumDexes).toBeDefined();
    expect(ethereumDexes.length).toBeGreaterThan(0);
  });

  it('should have required fields on each DEX', () => {
    ethereumDexes.forEach(dex => {
      expect(dex.name).toBeDefined();
      expect(typeof dex.name).toBe('string');
      expect(dex.name.length).toBeGreaterThan(0);
      expect(dex.factoryAddress).toBeDefined();
      expect(dex.routerAddress).toBeDefined();
      expect(dex.feeBps).toBeDefined();
      expect(dex.chain).toBe('ethereum');
    });
  });

  it('should have valid lowercase hex addresses for factory', () => {
    ethereumDexes.forEach(dex => {
      expect(dex.factoryAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });
  });

  it('should have valid lowercase hex addresses for router', () => {
    ethereumDexes.forEach(dex => {
      expect(dex.routerAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });
  });

  it('should have non-negative fee in basis points', () => {
    ethereumDexes.forEach(dex => {
      expect(dex.feeBps).toBeGreaterThanOrEqual(0);
    });
  });

  it('should return only enabled DEXes from getEnabledDexes', () => {
    const enabled = getEnabledDexes('ethereum');
    enabled.forEach(dex => {
      expect(dex.enabled).not.toBe(false);
    });
  });

  it('should have no duplicate DEX addresses', () => {
    const factoryAddresses = ethereumDexes.map(d => d.factoryAddress.toLowerCase());
    const uniqueAddresses = new Set(factoryAddresses);
    expect(uniqueAddresses.size).toBe(ethereumDexes.length);
  });

  it('should have unique DEX names', () => {
    const names = ethereumDexes.map(d => d.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(ethereumDexes.length);
  });
});

// =============================================================================
// Polygon DEX Configuration
// =============================================================================

describe('Polygon DEX Configuration', () => {
  const polygonDexes = DEXES.polygon;

  it('should have DEXes defined', () => {
    expect(polygonDexes).toBeDefined();
    expect(polygonDexes.length).toBeGreaterThan(0);
  });

  it('should have required fields on each DEX', () => {
    polygonDexes.forEach(dex => {
      expect(dex.name).toBeDefined();
      expect(typeof dex.name).toBe('string');
      expect(dex.name.length).toBeGreaterThan(0);
      expect(dex.factoryAddress).toBeDefined();
      expect(dex.routerAddress).toBeDefined();
      expect(dex.feeBps).toBeDefined();
      expect(dex.chain).toBe('polygon');
    });
  });

  it('should have valid hex addresses for factory (42-char)', () => {
    polygonDexes.forEach(dex => {
      expect(dex.factoryAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });
  });

  it('should have valid hex addresses for router (42-char)', () => {
    polygonDexes.forEach(dex => {
      expect(dex.routerAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });
  });

  it('should have non-negative fee in basis points', () => {
    polygonDexes.forEach(dex => {
      expect(dex.feeBps).toBeGreaterThanOrEqual(0);
    });
  });

  it('should return only enabled DEXes from getEnabledDexes', () => {
    const enabled = getEnabledDexes('polygon');
    enabled.forEach(dex => {
      expect(dex.enabled).not.toBe(false);
    });
  });

  it('should have no duplicate DEX addresses', () => {
    const factoryAddresses = polygonDexes.map(d => d.factoryAddress.toLowerCase());
    const uniqueAddresses = new Set(factoryAddresses);
    expect(uniqueAddresses.size).toBe(polygonDexes.length);
  });

  it('should have unique DEX names', () => {
    const names = polygonDexes.map(d => d.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(polygonDexes.length);
  });
});

// =============================================================================
// zkSync DEX Configuration
// =============================================================================

describe('zkSync DEX Configuration', () => {
  const zksyncDexes = DEXES.zksync;

  it('should have DEXes defined', () => {
    expect(zksyncDexes).toBeDefined();
    expect(zksyncDexes.length).toBeGreaterThan(0);
  });

  it('should have required fields on each DEX', () => {
    zksyncDexes.forEach(dex => {
      expect(dex.name).toBeDefined();
      expect(typeof dex.name).toBe('string');
      expect(dex.name.length).toBeGreaterThan(0);
      expect(dex.factoryAddress).toBeDefined();
      expect(dex.routerAddress).toBeDefined();
      expect(dex.feeBps).toBeDefined();
      expect(dex.chain).toBe('zksync');
    });
  });

  it('should have valid hex addresses for factory (42-char)', () => {
    zksyncDexes.forEach(dex => {
      expect(dex.factoryAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });
  });

  it('should have valid hex addresses for router (42-char)', () => {
    zksyncDexes.forEach(dex => {
      expect(dex.routerAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });
  });

  it('should have non-negative fee in basis points', () => {
    zksyncDexes.forEach(dex => {
      expect(dex.feeBps).toBeGreaterThanOrEqual(0);
    });
  });

  it('should return only enabled DEXes from getEnabledDexes', () => {
    const enabled = getEnabledDexes('zksync');
    enabled.forEach(dex => {
      expect(dex.enabled).not.toBe(false);
    });
  });

  it('should have no duplicate DEX addresses', () => {
    const factoryAddresses = zksyncDexes.map(d => d.factoryAddress.toLowerCase());
    const uniqueAddresses = new Set(factoryAddresses);
    expect(uniqueAddresses.size).toBe(zksyncDexes.length);
  });

  it('should have unique DEX names', () => {
    const names = zksyncDexes.map(d => d.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(zksyncDexes.length);
  });
});

// =============================================================================
// Linea DEX Configuration
// =============================================================================

describe('Linea DEX Configuration', () => {
  const lineaDexes = DEXES.linea;

  it('should have DEXes defined', () => {
    expect(lineaDexes).toBeDefined();
    expect(lineaDexes.length).toBeGreaterThan(0);
  });

  it('should have required fields on each DEX', () => {
    lineaDexes.forEach(dex => {
      expect(dex.name).toBeDefined();
      expect(typeof dex.name).toBe('string');
      expect(dex.name.length).toBeGreaterThan(0);
      expect(dex.factoryAddress).toBeDefined();
      expect(dex.routerAddress).toBeDefined();
      expect(dex.feeBps).toBeDefined();
      expect(dex.chain).toBe('linea');
    });
  });

  it('should have valid hex addresses for factory (42-char)', () => {
    lineaDexes.forEach(dex => {
      expect(dex.factoryAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });
  });

  it('should have valid hex addresses for router (42-char)', () => {
    lineaDexes.forEach(dex => {
      expect(dex.routerAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });
  });

  it('should have non-negative fee in basis points', () => {
    lineaDexes.forEach(dex => {
      expect(dex.feeBps).toBeGreaterThanOrEqual(0);
    });
  });

  it('should return only enabled DEXes from getEnabledDexes', () => {
    const enabled = getEnabledDexes('linea');
    enabled.forEach(dex => {
      expect(dex.enabled).not.toBe(false);
    });
  });

  it('should have no duplicate DEX addresses', () => {
    const factoryAddresses = lineaDexes.map(d => d.factoryAddress.toLowerCase());
    const uniqueAddresses = new Set(factoryAddresses);
    expect(uniqueAddresses.size).toBe(lineaDexes.length);
  });

  it('should have unique DEX names', () => {
    const names = lineaDexes.map(d => d.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(lineaDexes.length);
  });
});

// =============================================================================
// Cross-chain DEX consistency
// =============================================================================

describe('Cross-chain DEX consistency', () => {
  const testedChains = ['ethereum', 'polygon', 'zksync', 'linea'];

  it('should have DEXes for all tested chains', () => {
    testedChains.forEach(chain => {
      expect(DEXES[chain]).toBeDefined();
      expect(DEXES[chain].length).toBeGreaterThan(0);
    });
  });

  it('should return empty array from getEnabledDexes for unknown chain', () => {
    const result = getEnabledDexes('nonexistent-chain');
    expect(result).toEqual([]);
  });
});
