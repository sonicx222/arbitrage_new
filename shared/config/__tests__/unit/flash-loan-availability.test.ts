/**
 * Tests for Flash Loan Availability Matrix
 *
 * Validates protocol availability lookups, validation, and preference ordering.
 *
 * @see shared/config/src/flash-loan-availability.ts
 */

import { describe, it, expect } from '@jest/globals';
import {
  FLASH_LOAN_AVAILABILITY,
  FLASH_LOAN_STATS,
  FlashLoanNotSupportedError,
  getSupportedProtocols,
  getPreferredProtocol,
  isProtocolSupported,
  validateFlashLoanSupport,
} from '../../src/flash-loan-availability';

describe('flash-loan-availability', () => {
  // ===========================================================================
  // getSupportedProtocols
  // ===========================================================================

  describe('getSupportedProtocols', () => {
    it('returns aave_v3, balancer_v2, pancakeswap_v3 for ethereum', () => {
      const protocols = getSupportedProtocols('ethereum');
      expect(protocols).toContain('aave_v3');
      expect(protocols).toContain('balancer_v2');
      expect(protocols).toContain('pancakeswap_v3');
      expect(protocols).toContain('dai_flash_mint');
      expect(protocols).not.toContain('syncswap');
      expect(protocols).toHaveLength(4);
    });

    it('returns only pancakeswap_v3 for bsc', () => {
      const protocols = getSupportedProtocols('bsc');
      expect(protocols).toEqual(['pancakeswap_v3']);
    });

    it('returns empty array for solana (no EVM flash loans)', () => {
      const protocols = getSupportedProtocols('solana');
      expect(protocols).toEqual([]);
    });

    it('returns empty array for unknown chain', () => {
      const protocols = getSupportedProtocols('unknown-chain');
      expect(protocols).toEqual([]);
    });

    it('returns pancakeswap_v3 and syncswap for zksync', () => {
      const protocols = getSupportedProtocols('zksync');
      expect(protocols).toContain('pancakeswap_v3');
      expect(protocols).toContain('syncswap');
      expect(protocols).toHaveLength(2);
    });
  });

  // ===========================================================================
  // isProtocolSupported
  // ===========================================================================

  describe('isProtocolSupported', () => {
    it('returns true for valid chain-protocol pair', () => {
      expect(isProtocolSupported('ethereum', 'aave_v3')).toBe(true);
      expect(isProtocolSupported('bsc', 'pancakeswap_v3')).toBe(true);
      expect(isProtocolSupported('zksync', 'syncswap')).toBe(true);
    });

    it('returns false for invalid chain-protocol pair', () => {
      expect(isProtocolSupported('bsc', 'aave_v3')).toBe(false);
      expect(isProtocolSupported('solana', 'aave_v3')).toBe(false);
      expect(isProtocolSupported('ethereum', 'syncswap')).toBe(false);
    });

    it('returns false for unknown chain', () => {
      expect(isProtocolSupported('unknown-chain', 'aave_v3')).toBe(false);
    });
  });

  // ===========================================================================
  // validateFlashLoanSupport
  // ===========================================================================

  describe('validateFlashLoanSupport', () => {
    it('does not throw for valid chain-protocol pair', () => {
      expect(() => validateFlashLoanSupport('ethereum', 'aave_v3')).not.toThrow();
      expect(() => validateFlashLoanSupport('bsc', 'pancakeswap_v3')).not.toThrow();
    });

    it('throws FlashLoanNotSupportedError for unsupported protocol on known chain', () => {
      expect(() => validateFlashLoanSupport('bsc', 'aave_v3')).toThrow(FlashLoanNotSupportedError);
    });

    it('throws FlashLoanNotSupportedError for unknown chain', () => {
      expect(() => validateFlashLoanSupport('unknown-chain', 'aave_v3')).toThrow(FlashLoanNotSupportedError);
    });

    it('error message includes chain and supported protocols for known chain', () => {
      try {
        validateFlashLoanSupport('bsc', 'aave_v3');
        fail('Expected FlashLoanNotSupportedError');
      } catch (error) {
        expect(error).toBeInstanceOf(FlashLoanNotSupportedError);
        const e = error as FlashLoanNotSupportedError;
        expect(e.message).toContain('aave_v3');
        expect(e.message).toContain('bsc');
        expect(e.message).toContain('pancakeswap_v3');
      }
    });

    it('error message includes "Unknown chain" for unknown chain', () => {
      try {
        validateFlashLoanSupport('fake-chain', 'aave_v3');
        fail('Expected FlashLoanNotSupportedError');
      } catch (error) {
        expect(error).toBeInstanceOf(FlashLoanNotSupportedError);
        expect((error as Error).message).toContain('Unknown chain');
      }
    });
  });

  // ===========================================================================
  // getPreferredProtocol
  // ===========================================================================

  describe('getPreferredProtocol', () => {
    it('returns balancer_v2 for ethereum (lowest fee)', () => {
      expect(getPreferredProtocol('ethereum')).toBe('balancer_v2');
    });

    it('returns pancakeswap_v3 for bsc (only option)', () => {
      expect(getPreferredProtocol('bsc')).toBe('pancakeswap_v3');
    });

    it('returns null for solana (no EVM flash loans)', () => {
      expect(getPreferredProtocol('solana')).toBeNull();
    });

    it('returns null for unknown chain', () => {
      expect(getPreferredProtocol('unknown-chain')).toBeNull();
    });

    it('returns aave_v3 for avalanche (only aave available)', () => {
      expect(getPreferredProtocol('avalanche')).toBe('aave_v3');
    });

    it('returns balancer_v2 for fantom (balancer preferred over others)', () => {
      expect(getPreferredProtocol('fantom')).toBe('balancer_v2');
    });
  });

  // ===========================================================================
  // FlashLoanNotSupportedError
  // ===========================================================================

  describe('FlashLoanNotSupportedError', () => {
    it('has correct name property', () => {
      const error = new FlashLoanNotSupportedError('bsc', 'aave_v3', 'test message');
      expect(error.name).toBe('FlashLoanNotSupportedError');
    });

    it('has correct chain and protocol properties', () => {
      const error = new FlashLoanNotSupportedError('bsc', 'aave_v3', 'test message');
      expect(error.chain).toBe('bsc');
      expect(error.protocol).toBe('aave_v3');
    });

    it('message includes ERR_FLASH_LOAN_NOT_SUPPORTED prefix', () => {
      const error = new FlashLoanNotSupportedError('bsc', 'aave_v3', 'test message');
      expect(error.message).toContain('[ERR_FLASH_LOAN_NOT_SUPPORTED]');
      expect(error.message).toContain('test message');
    });

    it('is instance of Error', () => {
      const error = new FlashLoanNotSupportedError('bsc', 'aave_v3', 'test');
      expect(error).toBeInstanceOf(Error);
    });
  });

  // ===========================================================================
  // FLASH_LOAN_AVAILABILITY constant
  // ===========================================================================

  describe('FLASH_LOAN_AVAILABILITY', () => {
    it('ethereum has aave_v3, balancer_v2, pancakeswap_v3 enabled', () => {
      expect(FLASH_LOAN_AVAILABILITY['ethereum']).toEqual({
        aave_v3: true,
        balancer_v2: true,
        pancakeswap_v3: true,
        spookyswap: false,
        syncswap: false,
        dai_flash_mint: true,
      });
    });

    it('zksync has pancakeswap_v3 and syncswap enabled', () => {
      expect(FLASH_LOAN_AVAILABILITY['zksync']?.pancakeswap_v3).toBe(true);
      expect(FLASH_LOAN_AVAILABILITY['zksync']?.syncswap).toBe(true);
      expect(FLASH_LOAN_AVAILABILITY['zksync']?.aave_v3).toBe(false);
    });

    it('solana has all protocols disabled', () => {
      const solana = FLASH_LOAN_AVAILABILITY['solana'];
      expect(solana?.aave_v3).toBe(false);
      expect(solana?.balancer_v2).toBe(false);
      expect(solana?.pancakeswap_v3).toBe(false);
      expect(solana?.spookyswap).toBe(false);
      expect(solana?.syncswap).toBe(false);
    });
  });

  // ===========================================================================
  // FLASH_LOAN_STATS
  // ===========================================================================

  describe('FLASH_LOAN_STATS', () => {
    it('has correct total chain count', () => {
      expect(FLASH_LOAN_STATS.totalChains).toBe(Object.keys(FLASH_LOAN_AVAILABILITY).length);
    });

    it('has protocol coverage values computed from availability data', () => {
      // FIX #17: Values are now dynamically computed — verify against actual availability
      const allChains = Object.keys(FLASH_LOAN_AVAILABILITY);

      // Verify each protocol count matches reality
      const actualAaveCount = allChains.filter(c => FLASH_LOAN_AVAILABILITY[c]?.aave_v3).length;
      const actualBalancerCount = allChains.filter(c => FLASH_LOAN_AVAILABILITY[c]?.balancer_v2).length;
      const actualSyncswapCount = allChains.filter(c => FLASH_LOAN_AVAILABILITY[c]?.syncswap).length;

      expect(FLASH_LOAN_STATS.protocolCoverage.aave_v3).toBe(actualAaveCount);
      expect(FLASH_LOAN_STATS.protocolCoverage.balancer_v2).toBe(actualBalancerCount);
      expect(FLASH_LOAN_STATS.protocolCoverage.syncswap).toBe(actualSyncswapCount);

      // Sanity: Aave V3 has broadest coverage
      expect(FLASH_LOAN_STATS.protocolCoverage.aave_v3).toBeGreaterThanOrEqual(8);
      // Balancer on at least 6 chains
      expect(FLASH_LOAN_STATS.protocolCoverage.balancer_v2).toBeGreaterThanOrEqual(6);
      // SyncSwap on at least 1 chain
      expect(FLASH_LOAN_STATS.protocolCoverage.syncswap).toBeGreaterThanOrEqual(1);
    });
  });
});
