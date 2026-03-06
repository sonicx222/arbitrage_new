/**
 * Tests for execution chain group utilities (Phase 2: Chain-Grouped EE)
 *
 * Verifies that every chain maps to the correct execution group and stream,
 * that group→chain lookups are correct, and that the env var parser handles
 * all valid and invalid inputs.
 *
 * @see shared/config/src/execution-chain-groups.ts
 * @see docs/reports/EXECUTION_BOTTLENECK_RESEARCH_2026-03-06.md — Phase 2
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  getExecutionGroupForChain,
  getStreamForChain,
  getChainsForExecutionGroup,
  getExecutionGroupFromEnv,
  EXECUTION_GROUP_STREAMS,
  EXECUTION_CHAIN_GROUPS,
  type ExecutionChainGroup,
} from '../../src/execution-chain-groups';

describe('execution-chain-groups', () => {
  // ==========================================================================
  // getExecutionGroupForChain
  // ==========================================================================

  describe('getExecutionGroupForChain', () => {
    it('should return fast for bsc', () => {
      expect(getExecutionGroupForChain('bsc')).toBe('fast');
    });

    it('should return fast for polygon', () => {
      expect(getExecutionGroupForChain('polygon')).toBe('fast');
    });

    it('should return fast for avalanche', () => {
      expect(getExecutionGroupForChain('avalanche')).toBe('fast');
    });

    it('should return fast for fantom', () => {
      expect(getExecutionGroupForChain('fantom')).toBe('fast');
    });

    it('should return l2 for arbitrum', () => {
      expect(getExecutionGroupForChain('arbitrum')).toBe('l2');
    });

    it('should return l2 for optimism', () => {
      expect(getExecutionGroupForChain('optimism')).toBe('l2');
    });

    it('should return l2 for base', () => {
      expect(getExecutionGroupForChain('base')).toBe('l2');
    });

    it('should return l2 for scroll', () => {
      expect(getExecutionGroupForChain('scroll')).toBe('l2');
    });

    it('should return l2 for blast', () => {
      expect(getExecutionGroupForChain('blast')).toBe('l2');
    });

    it('should return premium for ethereum', () => {
      expect(getExecutionGroupForChain('ethereum')).toBe('premium');
    });

    it('should return premium for zksync', () => {
      expect(getExecutionGroupForChain('zksync')).toBe('premium');
    });

    it('should return premium for linea', () => {
      expect(getExecutionGroupForChain('linea')).toBe('premium');
    });

    it('should return solana for solana', () => {
      expect(getExecutionGroupForChain('solana')).toBe('solana');
    });

    it('should return null for an unknown chain', () => {
      expect(getExecutionGroupForChain('unknown-chain-xyz')).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(getExecutionGroupForChain('')).toBeNull();
    });
  });

  // ==========================================================================
  // getStreamForChain
  // ==========================================================================

  describe('getStreamForChain', () => {
    it('should return fast stream for bsc', () => {
      expect(getStreamForChain('bsc')).toBe('stream:exec-requests-fast');
    });

    it('should return fast stream for polygon', () => {
      expect(getStreamForChain('polygon')).toBe('stream:exec-requests-fast');
    });

    it('should return l2 stream for arbitrum', () => {
      expect(getStreamForChain('arbitrum')).toBe('stream:exec-requests-l2');
    });

    it('should return l2 stream for base', () => {
      expect(getStreamForChain('base')).toBe('stream:exec-requests-l2');
    });

    it('should return premium stream for ethereum', () => {
      expect(getStreamForChain('ethereum')).toBe('stream:exec-requests-premium');
    });

    it('should return premium stream for zksync', () => {
      expect(getStreamForChain('zksync')).toBe('stream:exec-requests-premium');
    });

    it('should return solana stream for solana', () => {
      expect(getStreamForChain('solana')).toBe('stream:exec-requests-solana');
    });

    it('should return fallback EXECUTION_REQUESTS stream for unknown chain', () => {
      expect(getStreamForChain('unknown-chain')).toBe('stream:execution-requests');
    });
  });

  // ==========================================================================
  // getChainsForExecutionGroup
  // ==========================================================================

  describe('getChainsForExecutionGroup', () => {
    it('should return the 4 fast chains', () => {
      const chains = getChainsForExecutionGroup('fast');
      expect(chains).toEqual(expect.arrayContaining(['bsc', 'polygon', 'avalanche', 'fantom']));
      expect(chains).toHaveLength(4);
    });

    it('should return the l2 chains', () => {
      const chains = getChainsForExecutionGroup('l2');
      expect(chains).toEqual(expect.arrayContaining(['arbitrum', 'optimism', 'base', 'scroll', 'blast']));
    });

    it('should return the premium chains', () => {
      const chains = getChainsForExecutionGroup('premium');
      expect(chains).toEqual(expect.arrayContaining(['ethereum', 'zksync', 'linea']));
    });

    it('should return solana chains', () => {
      const chains = getChainsForExecutionGroup('solana');
      expect(chains).toContain('solana');
    });

    it('should return a copy (mutation-safe)', () => {
      const chains = getChainsForExecutionGroup('fast');
      chains.push('injected');
      expect(getChainsForExecutionGroup('fast')).not.toContain('injected');
    });
  });

  // ==========================================================================
  // EXECUTION_GROUP_STREAMS constant
  // ==========================================================================

  describe('EXECUTION_GROUP_STREAMS', () => {
    it('should map fast to stream:exec-requests-fast', () => {
      expect(EXECUTION_GROUP_STREAMS.fast).toBe('stream:exec-requests-fast');
    });

    it('should map l2 to stream:exec-requests-l2', () => {
      expect(EXECUTION_GROUP_STREAMS.l2).toBe('stream:exec-requests-l2');
    });

    it('should map premium to stream:exec-requests-premium', () => {
      expect(EXECUTION_GROUP_STREAMS.premium).toBe('stream:exec-requests-premium');
    });

    it('should map solana to stream:exec-requests-solana', () => {
      expect(EXECUTION_GROUP_STREAMS.solana).toBe('stream:exec-requests-solana');
    });
  });

  // ==========================================================================
  // EXECUTION_CHAIN_GROUPS constant
  // ==========================================================================

  describe('EXECUTION_CHAIN_GROUPS', () => {
    it('should define all 4 groups', () => {
      expect(EXECUTION_CHAIN_GROUPS).toEqual(
        expect.arrayContaining(['fast', 'l2', 'premium', 'solana'])
      );
    });
  });

  // ==========================================================================
  // getExecutionGroupFromEnv
  // ==========================================================================

  describe('getExecutionGroupFromEnv', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      delete process.env.EXECUTION_CHAIN_GROUP;
    });

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('should return null when EXECUTION_CHAIN_GROUP is not set', () => {
      expect(getExecutionGroupFromEnv()).toBeNull();
    });

    it('should return fast for EXECUTION_CHAIN_GROUP=fast', () => {
      process.env.EXECUTION_CHAIN_GROUP = 'fast';
      expect(getExecutionGroupFromEnv()).toBe('fast');
    });

    it('should return l2 for EXECUTION_CHAIN_GROUP=l2', () => {
      process.env.EXECUTION_CHAIN_GROUP = 'l2';
      expect(getExecutionGroupFromEnv()).toBe('l2');
    });

    it('should return premium for EXECUTION_CHAIN_GROUP=premium', () => {
      process.env.EXECUTION_CHAIN_GROUP = 'premium';
      expect(getExecutionGroupFromEnv()).toBe('premium');
    });

    it('should return solana for EXECUTION_CHAIN_GROUP=solana', () => {
      process.env.EXECUTION_CHAIN_GROUP = 'solana';
      expect(getExecutionGroupFromEnv()).toBe('solana');
    });

    it('should return null for an invalid value', () => {
      process.env.EXECUTION_CHAIN_GROUP = 'invalid-group';
      expect(getExecutionGroupFromEnv()).toBeNull();
    });

    it('should return null for empty string', () => {
      process.env.EXECUTION_CHAIN_GROUP = '';
      expect(getExecutionGroupFromEnv()).toBeNull();
    });
  });

  // ==========================================================================
  // Coverage: all chains mapped, no chain in two groups
  // ==========================================================================

  describe('completeness', () => {
    const ALL_EXPECTED_CHAINS = [
      'bsc', 'polygon', 'avalanche', 'fantom',           // fast
      'arbitrum', 'optimism', 'base', 'scroll', 'blast', // l2
      'ethereum', 'zksync', 'linea',                      // premium
      'solana',                                            // solana
    ];

    it('should map every expected chain to a group', () => {
      for (const chain of ALL_EXPECTED_CHAINS) {
        expect(getExecutionGroupForChain(chain)).not.toBeNull();
      }
    });

    it('should not map any chain to multiple groups', () => {
      const seen = new Set<string>();
      for (const group of ['fast', 'l2', 'premium', 'solana'] as ExecutionChainGroup[]) {
        for (const chain of getChainsForExecutionGroup(group)) {
          expect(seen.has(chain)).toBe(false);
          seen.add(chain);
        }
      }
    });
  });
});
