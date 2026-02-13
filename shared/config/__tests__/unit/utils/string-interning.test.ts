/**
 * Tests for String Interning Utilities
 *
 * Validates string pool creation, interning, eviction, and global pool functions.
 *
 * @see shared/config/src/utils/string-interning.ts
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  createStringPool,
  internChainName,
  internChainNameLower,
  internTokenSymbol,
  internTokenSymbolUpper,
  internDexName,
  getChainPoolStats,
  resetChainPool,
} from '../../../src/utils/string-interning';

describe('string-interning', () => {
  // ===========================================================================
  // createStringPool
  // ===========================================================================

  describe('createStringPool', () => {
    it('intern returns same reference for same string', () => {
      const pool = createStringPool();
      const first = pool.intern('test');
      const second = pool.intern('test');
      expect(first).toBe(second); // identity check
      expect(first === second).toBe(true);
    });

    it('intern returns different references for different strings', () => {
      const pool = createStringPool();
      const a = pool.intern('hello');
      const b = pool.intern('world');
      expect(a).not.toBe(b);
    });

    it('internLower lowercases before interning', () => {
      const pool = createStringPool();
      const lower = pool.internLower('ETHEREUM');
      expect(lower).toBe('ethereum');
      // Should be same reference as interning the lowercase directly
      const direct = pool.intern('ethereum');
      expect(lower === direct).toBe(true);
    });

    it('has returns true for interned strings', () => {
      const pool = createStringPool();
      pool.intern('present');
      expect(pool.has('present')).toBe(true);
    });

    it('has returns false for non-interned strings', () => {
      const pool = createStringPool();
      expect(pool.has('absent')).toBe(false);
    });

    it('stats returns correct size', () => {
      const pool = createStringPool();
      pool.intern('a');
      pool.intern('b');
      pool.intern('c');
      expect(pool.stats().size).toBe(3);
    });

    it('stats returns configured maxSize', () => {
      const pool = createStringPool(50);
      expect(pool.stats().maxSize).toBe(50);
    });

    it('clear empties the pool', () => {
      const pool = createStringPool();
      pool.intern('one');
      pool.intern('two');
      pool.clear();
      expect(pool.stats().size).toBe(0);
      expect(pool.has('one')).toBe(false);
      expect(pool.has('two')).toBe(false);
    });

    it('evicts oldest entry when at maxSize', () => {
      const pool = createStringPool(3);
      pool.intern('first');
      pool.intern('second');
      pool.intern('third');

      expect(pool.has('first')).toBe(true);
      expect(pool.stats().size).toBe(3);

      // Adding a 4th should evict 'first'
      pool.intern('fourth');
      expect(pool.has('first')).toBe(false);
      expect(pool.has('second')).toBe(true);
      expect(pool.has('fourth')).toBe(true);
      expect(pool.stats().size).toBe(3);
    });

    it('re-interning same string does not cause eviction', () => {
      const pool = createStringPool(3);
      pool.intern('a');
      pool.intern('b');
      pool.intern('c');
      // Re-intern 'a' — should not evict anything
      pool.intern('a');
      expect(pool.stats().size).toBe(3);
      expect(pool.has('a')).toBe(true);
      expect(pool.has('b')).toBe(true);
      expect(pool.has('c')).toBe(true);
    });
  });

  // ===========================================================================
  // Global chain name pool
  // ===========================================================================

  describe('internChainName', () => {
    it('returns interned string for known chain', () => {
      const first = internChainName('ethereum');
      const second = internChainName('ethereum');
      expect(first === second).toBe(true);
    });

    it('pre-populated with known chains', () => {
      // Known chains should already be interned from module initialization
      const result = internChainName('bsc');
      expect(result).toBe('bsc');
    });
  });

  describe('internChainNameLower', () => {
    it('lowercases and interns', () => {
      const result = internChainNameLower('ETHEREUM');
      expect(result).toBe('ethereum');
    });

    it('returns same reference for equivalent inputs', () => {
      const a = internChainNameLower('POLYGON');
      const b = internChainNameLower('polygon');
      expect(a === b).toBe(true);
    });
  });

  describe('getChainPoolStats', () => {
    it('returns stats with size > 0 (pre-populated)', () => {
      const stats = getChainPoolStats();
      expect(stats.size).toBeGreaterThan(0);
      expect(stats.maxSize).toBe(100);
    });
  });

  describe('resetChainPool', () => {
    it('re-interns known chains after reset', () => {
      resetChainPool();
      const stats = getChainPoolStats();
      expect(stats.size).toBeGreaterThan(0);
      // Known chains should still be interned
      const result = internChainName('ethereum');
      expect(result).toBe('ethereum');
    });
  });

  // ===========================================================================
  // Token symbol pool
  // ===========================================================================

  describe('internTokenSymbol', () => {
    it('returns interned string', () => {
      const first = internTokenSymbol('WETH');
      const second = internTokenSymbol('WETH');
      expect(first === second).toBe(true);
    });

    it('works with non-pre-populated symbols', () => {
      const symbol = internTokenSymbol('CUSTOM_TOKEN_XYZ');
      expect(symbol).toBe('CUSTOM_TOKEN_XYZ');
    });
  });

  describe('internTokenSymbolUpper', () => {
    it('uppercases before interning', () => {
      const result = internTokenSymbolUpper('weth');
      expect(result).toBe('WETH');
    });

    it('returns same reference as direct intern of uppercase', () => {
      const upper = internTokenSymbolUpper('dai');
      const direct = internTokenSymbol('DAI');
      expect(upper === direct).toBe(true);
    });
  });

  // ===========================================================================
  // DEX name pool
  // ===========================================================================

  describe('internDexName', () => {
    it('returns interned string for known DEX', () => {
      const first = internDexName('uniswap_v2');
      const second = internDexName('uniswap_v2');
      expect(first === second).toBe(true);
    });

    it('works with non-pre-populated DEX names', () => {
      const name = internDexName('custom_dex_xyz');
      expect(name).toBe('custom_dex_xyz');
    });
  });
});
