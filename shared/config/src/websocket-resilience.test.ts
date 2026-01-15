/**
 * WebSocket Resilience Configuration Tests
 *
 * Tests to verify all chains have proper WebSocket fallback URL configuration
 * for 24/7 uptime resilience (S3.3).
 *
 * @see ADR-003: Partitioned Chain Detectors
 * @see S3.3: WebSocket Connection Resilience
 */

import { describe, it, expect } from '@jest/globals';
import { CHAINS } from './index';

describe('WebSocket Resilience Configuration (S3.3)', () => {
  describe('Fallback URL Coverage', () => {
    it('should have all 11 chains configured', () => {
      const chainIds = Object.keys(CHAINS);
      expect(chainIds).toHaveLength(11);
      expect(chainIds).toContain('arbitrum');
      expect(chainIds).toContain('bsc');
      expect(chainIds).toContain('base');
      expect(chainIds).toContain('polygon');
      expect(chainIds).toContain('optimism');
      expect(chainIds).toContain('ethereum');
      expect(chainIds).toContain('avalanche');
      expect(chainIds).toContain('fantom');
      expect(chainIds).toContain('zksync');
      expect(chainIds).toContain('linea');
      expect(chainIds).toContain('solana');
    });

    it('should have wsFallbackUrls configured for all chains', () => {
      const chainsWithoutFallbacks: string[] = [];

      for (const [chainId, chain] of Object.entries(CHAINS)) {
        if (!chain.wsFallbackUrls || chain.wsFallbackUrls.length === 0) {
          chainsWithoutFallbacks.push(chainId);
        }
      }

      expect(chainsWithoutFallbacks).toEqual([]);
    });

    it('should have at least 1 WebSocket fallback URL per chain', () => {
      for (const [chainId, chain] of Object.entries(CHAINS)) {
        const fallbackCount = chain.wsFallbackUrls?.length ?? 0;
        if (fallbackCount < 1) {
          throw new Error(`${chainId} should have at least 1 WebSocket fallback URL`);
        }
        expect(fallbackCount).toBeGreaterThanOrEqual(1);
      }
    });

    it('should have rpcFallbackUrls configured for all chains', () => {
      const chainsWithoutFallbacks: string[] = [];

      for (const [chainId, chain] of Object.entries(CHAINS)) {
        if (!chain.rpcFallbackUrls || chain.rpcFallbackUrls.length === 0) {
          chainsWithoutFallbacks.push(chainId);
        }
      }

      expect(chainsWithoutFallbacks).toEqual([]);
    });
  });

  describe('URL Format Validation', () => {
    it('should have valid WebSocket URLs (wss:// protocol)', () => {
      for (const [chainId, chain] of Object.entries(CHAINS)) {
        // Skip env variable URLs in tests (they start with process.env)
        const wsUrl = chain.wsUrl || '';
        if (wsUrl && !wsUrl.includes('process.env')) {
          const isValidProtocol = wsUrl.startsWith('wss://') || wsUrl.startsWith('ws://');
          if (!isValidProtocol) {
            throw new Error(`${chainId} primary wsUrl should use wss:// or ws:// protocol`);
          }
          expect(isValidProtocol).toBe(true);
        }

        for (const fallbackUrl of chain.wsFallbackUrls || []) {
          const isValidProtocol = fallbackUrl.startsWith('wss://') || fallbackUrl.startsWith('ws://');
          if (!isValidProtocol) {
            throw new Error(`${chainId} fallback URL ${fallbackUrl} should use wss:// or ws:// protocol`);
          }
          expect(isValidProtocol).toBe(true);
        }
      }
    });

    it('should have valid RPC URLs (https:// protocol)', () => {
      for (const [chainId, chain] of Object.entries(CHAINS)) {
        for (const fallbackUrl of chain.rpcFallbackUrls || []) {
          const isValidProtocol = fallbackUrl.startsWith('https://') || fallbackUrl.startsWith('http://');
          if (!isValidProtocol) {
            throw new Error(`${chainId} RPC fallback URL ${fallbackUrl} should use https:// or http:// protocol`);
          }
          expect(isValidProtocol).toBe(true);
        }
      }
    });

    it('should have no duplicate fallback URLs per chain', () => {
      for (const [chainId, chain] of Object.entries(CHAINS)) {
        const wsFallbacks = chain.wsFallbackUrls || [];
        const uniqueWsFallbacks = new Set(wsFallbacks);
        if (wsFallbacks.length !== uniqueWsFallbacks.size) {
          throw new Error(`${chainId} should have no duplicate WebSocket fallback URLs`);
        }
        expect(wsFallbacks.length).toBe(uniqueWsFallbacks.size);

        const rpcFallbacks = chain.rpcFallbackUrls || [];
        const uniqueRpcFallbacks = new Set(rpcFallbacks);
        if (rpcFallbacks.length !== uniqueRpcFallbacks.size) {
          throw new Error(`${chainId} should have no duplicate RPC fallback URLs`);
        }
        expect(rpcFallbacks.length).toBe(uniqueRpcFallbacks.size);
      }
    });
  });

  describe('Provider Diversity', () => {
    it('should use diverse providers (not all from same domain)', () => {
      for (const [chainId, chain] of Object.entries(CHAINS)) {
        const wsFallbacks = chain.wsFallbackUrls || [];
        if (wsFallbacks.length < 2) continue;

        const domains = wsFallbacks.map((url) => {
          try {
            const urlObj = new URL(url);
            return urlObj.hostname;
          } catch {
            return url;
          }
        });

        const uniqueDomains = new Set(domains);
        const minExpected = Math.min(2, wsFallbacks.length);
        if (uniqueDomains.size < minExpected) {
          throw new Error(`${chainId} should have fallbacks from different providers`);
        }
        expect(uniqueDomains.size).toBeGreaterThanOrEqual(minExpected);
      }
    });
  });

  describe('Chain-Specific Configuration', () => {
    it('Arbitrum should have 3 WebSocket fallbacks', () => {
      expect(CHAINS.arbitrum.wsFallbackUrls).toHaveLength(3);
    });

    it('Optimism should have 3 WebSocket fallbacks', () => {
      expect(CHAINS.optimism.wsFallbackUrls).toHaveLength(3);
    });

    it('BSC should have 3 WebSocket fallbacks', () => {
      expect(CHAINS.bsc.wsFallbackUrls).toHaveLength(3);
    });

    it('Ethereum should have 2 WebSocket fallbacks', () => {
      expect(CHAINS.ethereum.wsFallbackUrls).toHaveLength(2);
    });

    it('Base should have 2 WebSocket fallbacks', () => {
      expect(CHAINS.base.wsFallbackUrls).toHaveLength(2);
    });

    it('Polygon should have 2 WebSocket fallbacks', () => {
      expect(CHAINS.polygon.wsFallbackUrls).toHaveLength(2);
    });

    it('Avalanche should have 2 WebSocket fallbacks', () => {
      expect(CHAINS.avalanche.wsFallbackUrls).toHaveLength(2);
    });

    it('Fantom should have 2 WebSocket fallbacks', () => {
      expect(CHAINS.fantom.wsFallbackUrls).toHaveLength(2);
    });

    it('zkSync should have 2 WebSocket fallbacks', () => {
      expect(CHAINS.zksync.wsFallbackUrls).toHaveLength(2);
    });

    it('Linea should have at least 1 WebSocket fallback', () => {
      expect(CHAINS.linea.wsFallbackUrls?.length).toBeGreaterThanOrEqual(1);
    });

    it('Solana should have at least 1 WebSocket fallback', () => {
      expect(CHAINS.solana.wsFallbackUrls?.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Total URL Count', () => {
    it('should have at least 2 total WebSocket URLs per chain (primary + fallback)', () => {
      for (const [chainId, chain] of Object.entries(CHAINS)) {
        const primaryCount = chain.wsUrl ? 1 : 0;
        const fallbackCount = chain.wsFallbackUrls?.length || 0;
        const totalUrls = primaryCount + fallbackCount;

        if (totalUrls < 2) {
          throw new Error(`${chainId} should have at least 2 total WebSocket URLs`);
        }
        expect(totalUrls).toBeGreaterThanOrEqual(2);
      }
    });

    it('should have minimum 22 total WebSocket URLs across all chains', () => {
      let totalUrls = 0;
      for (const chain of Object.values(CHAINS)) {
        totalUrls += chain.wsUrl ? 1 : 0;
        totalUrls += chain.wsFallbackUrls?.length || 0;
      }

      // 11 chains × 2 minimum URLs = 22
      expect(totalUrls).toBeGreaterThanOrEqual(22);
    });
  });
});
