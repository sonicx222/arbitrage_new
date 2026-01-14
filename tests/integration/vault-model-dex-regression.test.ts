/**
 * Regression Tests: Vault Model DEXs Configuration
 *
 * These tests ensure that DEXs using vault/pool models remain properly configured.
 * Vault model DEXs (Balancer V2, Beethoven X, GMX, Platypus) don't use the
 * standard factory pattern and require custom adapters for pair discovery.
 *
 * CRITICAL: These DEXs MUST remain disabled until custom adapters are implemented.
 * Enabling them without proper adapters will cause pair discovery failures.
 *
 * @see S3.2.1: Avalanche configuration (GMX, Platypus disabled)
 * @see S3.2.2: Fantom configuration (Beethoven X disabled)
 * @see pair-discovery.ts detectFactoryType() function
 */

import { describe, it, expect, beforeAll } from '@jest/globals';

import {
  getEnabledDexes,
  DEXES
} from '../../shared/config/src';

import {
  PairDiscoveryService,
  resetPairDiscoveryService
} from '../../shared/core/src';

// =============================================================================
// Vault Model DEXs Registry
// =============================================================================

/**
 * DEXs that use vault/pool models instead of factory pattern
 * These MUST be disabled until custom adapters are implemented
 */
const VAULT_MODEL_DEXES = [
  { name: 'balancer_v2', chain: 'arbitrum', model: 'Balancer V2 Vault' },
  { name: 'beethoven_x', chain: 'fantom', model: 'Balancer V2 Vault (fork)' },
  { name: 'gmx', chain: 'avalanche', model: 'GMX Vault' },
  { name: 'platypus', chain: 'avalanche', model: 'Pool Model' }
] as const;

/**
 * DEX name patterns that should be detected as unsupported
 */
const UNSUPPORTED_NAME_PATTERNS = [
  'balancer',
  'beethoven',
  'beets',
  'gmx',
  'platypus'
] as const;

// =============================================================================
// REGRESSION: Vault Model DEX Disabled Status
// =============================================================================

describe('REGRESSION: Vault Model DEXs Must Be Disabled', () => {
  describe('All vault model DEXs should be configured but disabled', () => {
    for (const dex of VAULT_MODEL_DEXES) {
      describe(`${dex.name} on ${dex.chain} (${dex.model})`, () => {
        it(`should exist in DEXES config for ${dex.chain}`, () => {
          const chainDexes = DEXES[dex.chain] || [];
          const found = chainDexes.find((d: any) => d.name === dex.name);
          expect(found).toBeDefined();
        });

        it(`should have enabled=false`, () => {
          const chainDexes = DEXES[dex.chain] || [];
          const found = chainDexes.find((d: any) => d.name === dex.name);
          expect(found?.enabled).toBe(false);
        });

        it(`should NOT appear in getEnabledDexes('${dex.chain}')`, () => {
          const enabledDexes = getEnabledDexes(dex.chain);
          const found = enabledDexes.find(d => d.name === dex.name);
          expect(found).toBeUndefined();
        });
      });
    }
  });
});

// =============================================================================
// REGRESSION: Factory Type Detection
// =============================================================================

describe('REGRESSION: Vault Model Factory Type Detection', () => {
  let service: PairDiscoveryService;

  beforeAll(() => {
    resetPairDiscoveryService();
    service = new PairDiscoveryService({
      maxConcurrentQueries: 5,
      batchSize: 10,
      batchDelayMs: 0,
      retryAttempts: 2,
      retryDelayMs: 10,
      circuitBreakerThreshold: 3,
      circuitBreakerResetMs: 100,
      queryTimeoutMs: 1000
    });
  });

  afterAll(() => {
    service.cleanup();
  });

  describe('Vault model DEXs should be detected as unsupported', () => {
    for (const dex of VAULT_MODEL_DEXES) {
      it(`should detect ${dex.name} as 'unsupported' factory type`, () => {
        const factoryType = service.detectFactoryType(dex.name);
        expect(factoryType).toBe('unsupported');
      });
    }
  });

  describe('Name pattern matching for unsupported detection', () => {
    for (const pattern of UNSUPPORTED_NAME_PATTERNS) {
      it(`should detect name containing '${pattern}' as unsupported`, () => {
        const factoryType = service.detectFactoryType(pattern);
        expect(factoryType).toBe('unsupported');
      });

      it(`should detect name with '${pattern}_v2' as unsupported`, () => {
        const factoryType = service.detectFactoryType(`${pattern}_v2`);
        expect(factoryType).toBe('unsupported');
      });
    }
  });
});

// =============================================================================
// REGRESSION: Enabled DEX Counts
// =============================================================================

describe('REGRESSION: Enabled DEX Counts After Vault Model Exclusion', () => {
  it('should have 4 enabled DEXs on Avalanche (excluding GMX, Platypus)', () => {
    const enabledDexes = getEnabledDexes('avalanche');
    expect(enabledDexes.length).toBe(4);

    // Verify specific enabled DEXs
    const enabledNames = enabledDexes.map(d => d.name);
    expect(enabledNames).toContain('trader_joe_v2');
    expect(enabledNames).toContain('pangolin');
    expect(enabledNames).toContain('sushiswap');
    expect(enabledNames).toContain('kyberswap');

    // Verify vault model DEXs are NOT included
    expect(enabledNames).not.toContain('gmx');
    expect(enabledNames).not.toContain('platypus');
  });

  it('should have 3 enabled DEXs on Fantom (excluding Beethoven X)', () => {
    const enabledDexes = getEnabledDexes('fantom');
    expect(enabledDexes.length).toBe(3);

    // Verify specific enabled DEXs
    const enabledNames = enabledDexes.map(d => d.name);
    expect(enabledNames).toContain('spookyswap');
    expect(enabledNames).toContain('spiritswap');
    expect(enabledNames).toContain('equalizer');

    // Verify vault model DEX is NOT included
    expect(enabledNames).not.toContain('beethoven_x');
  });

  it('should have correct DEX count on Arbitrum (excluding Balancer V2)', () => {
    const enabledDexes = getEnabledDexes('arbitrum');

    // Verify Balancer V2 is NOT included
    const enabledNames = enabledDexes.map(d => d.name);
    expect(enabledNames).not.toContain('balancer_v2');

    // Should have other DEXs enabled
    expect(enabledDexes.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// REGRESSION: Configuration Consistency
// =============================================================================

describe('REGRESSION: Vault Model DEX Configuration Consistency', () => {
  it('should have all vault model DEXs with valid factory addresses', () => {
    const addressRegex = /^0x[a-fA-F0-9]{40}$/;

    for (const dex of VAULT_MODEL_DEXES) {
      const chainDexes = DEXES[dex.chain] || [];
      const found = chainDexes.find((d: any) => d.name === dex.name);

      expect(found).toBeDefined();
      expect(found?.factoryAddress).toMatch(addressRegex);
      expect(found?.routerAddress).toMatch(addressRegex);
    }
  });

  it('should have all vault model DEXs with correct chain assignment', () => {
    for (const dex of VAULT_MODEL_DEXES) {
      const chainDexes = DEXES[dex.chain] || [];
      const found = chainDexes.find((d: any) => d.name === dex.name);

      expect(found?.chain).toBe(dex.chain);
    }
  });

  it('should have all vault model DEXs with valid fee configuration', () => {
    for (const dex of VAULT_MODEL_DEXES) {
      const chainDexes = DEXES[dex.chain] || [];
      const found = chainDexes.find((d: any) => d.name === dex.name);

      expect(found?.fee).toBeGreaterThanOrEqual(0);
      expect(found?.fee).toBeLessThanOrEqual(300); // Max 3% fee
    }
  });
});

// =============================================================================
// CRITICAL: Prevent Accidental Re-enabling
// =============================================================================

describe('CRITICAL: Prevent Accidental Re-enabling of Vault Model DEXs', () => {
  it('should fail if any vault model DEX is accidentally enabled', () => {
    for (const dex of VAULT_MODEL_DEXES) {
      const chainDexes = DEXES[dex.chain] || [];
      const found = chainDexes.find((d: any) => d.name === dex.name);

      // CRITICAL: This test will fail if someone removes or sets enabled=true
      expect(found?.enabled).toBe(false);
    }
  });

  it('should document why each vault model DEX is disabled', () => {
    // This test serves as documentation for future developers
    const disabledReasons: Record<string, string> = {
      balancer_v2: 'Uses Balancer V2 Vault model - pools are managed through a single vault contract, not individual factory-created pairs',
      beethoven_x: 'Balancer V2 fork - uses same vault model as Balancer, requires custom adapter for pool queries',
      gmx: 'Uses GMX Vault model - liquidity is pooled in GLP tokens, not traditional LP pairs',
      platypus: 'Uses single-sided liquidity pool model - tokens are deposited individually, not as pairs'
    };

    for (const dex of VAULT_MODEL_DEXES) {
      expect(disabledReasons[dex.name]).toBeDefined();
    }
  });
});
