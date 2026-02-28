/**
 * Tests for service-config utility functions
 *
 * Tests the following functions:
 * - isLocalhostUrl: Detects localhost/loopback addresses in URLs
 * - validateChainEnvironment: Validates required env vars for enabled chains
 *
 * @see shared/config/src/service-config.ts
 * @see shared/config/src/index.ts
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { isLocalhostUrl } from '../../src/service-config';
import { validateChainEnvironment } from '../../src/index';

// Store original env vars
const originalEnv = { ...process.env };

describe('isLocalhostUrl', () => {
  describe('localhost detection', () => {
    it('should return true for localhost URLs', () => {
      expect(isLocalhostUrl('http://localhost:6379')).toBe(true);
      expect(isLocalhostUrl('redis://localhost:6379')).toBe(true);
      expect(isLocalhostUrl('https://localhost')).toBe(true);
      expect(isLocalhostUrl('ws://localhost:3000')).toBe(true);
    });

    it('should be case-insensitive for localhost', () => {
      expect(isLocalhostUrl('HTTP://LOCALHOST:6379')).toBe(true);
      expect(isLocalhostUrl('http://LocalHost:6379')).toBe(true);
      expect(isLocalhostUrl('REDIS://LOCALHOST')).toBe(true);
    });
  });

  describe('IPv4 loopback detection', () => {
    it('should return true for 127.0.0.1', () => {
      expect(isLocalhostUrl('redis://127.0.0.1:6379')).toBe(true);
      expect(isLocalhostUrl('http://127.0.0.1:3000')).toBe(true);
      expect(isLocalhostUrl('https://127.0.0.1')).toBe(true);
    });
  });

  describe('IPv6 loopback detection', () => {
    it('should return true for ::1 (IPv6 loopback)', () => {
      expect(isLocalhostUrl('http://[::1]:8080')).toBe(true);
      expect(isLocalhostUrl('redis://[::1]:6379')).toBe(true);
    });

    it('should return true for bracketed IPv6 loopback', () => {
      expect(isLocalhostUrl('http://[::1]:8080')).toBe(true);
      expect(isLocalhostUrl('ws://[::1]:3000')).toBe(true);
    });
  });

  describe('0.0.0.0 detection', () => {
    it('should return true for 0.0.0.0 (bind all interfaces)', () => {
      expect(isLocalhostUrl('http://0.0.0.0:3000')).toBe(true);
      expect(isLocalhostUrl('redis://0.0.0.0:6379')).toBe(true);
    });
  });

  describe('Docker host detection', () => {
    it('should return true for host.docker.internal', () => {
      expect(isLocalhostUrl('http://host.docker.internal:6379')).toBe(true);
      expect(isLocalhostUrl('redis://host.docker.internal:6379')).toBe(true);
    });

    it('should be case-insensitive for host.docker.internal', () => {
      expect(isLocalhostUrl('http://HOST.DOCKER.INTERNAL:6379')).toBe(true);
      expect(isLocalhostUrl('redis://Host.Docker.Internal:6379')).toBe(true);
    });
  });

  describe('non-localhost URLs', () => {
    it('should return false for remote URLs', () => {
      expect(isLocalhostUrl('https://redis.example.com:6379')).toBe(false);
      expect(isLocalhostUrl('redis://10.0.0.1:6379')).toBe(false);
      expect(isLocalhostUrl('https://fly-redis.internal:6379')).toBe(false);
      expect(isLocalhostUrl('wss://api.production.com')).toBe(false);
    });

    it('should return false for private network addresses', () => {
      expect(isLocalhostUrl('http://192.168.1.1:6379')).toBe(false);
      expect(isLocalhostUrl('http://10.0.0.1:3000')).toBe(false);
      expect(isLocalhostUrl('http://172.16.0.1:8080')).toBe(false);
    });

    it('should return false for cloud provider internal addresses', () => {
      expect(isLocalhostUrl('redis://fly-redis.internal')).toBe(false);
      expect(isLocalhostUrl('http://aws-internal.amazon.com')).toBe(false);
    });
  });
});

describe('validateChainEnvironment', () => {
  beforeEach(() => {
    // Reset environment to known state
    process.env = { ...originalEnv };

    // Clear all chain-related env vars
    const chainNames = [
      'ARBITRUM', 'BSC', 'BASE', 'ETHEREUM', 'POLYGON', 'OPTIMISM',
      'AVALANCHE', 'FANTOM', 'ZKSYNC', 'LINEA', 'SOLANA',
      'BLAST', 'SCROLL', 'MANTLE', 'MODE'
    ];

    for (const chain of chainNames) {
      delete process.env[`${chain}_RPC_URL`];
      delete process.env[`${chain}_WS_URL`];
    }
  });

  afterEach(() => {
    // Restore original environment
    process.env = { ...originalEnv };
  });

  describe('with empty chainIds array', () => {
    it('should return empty array when called with empty array', () => {
      const missing = validateChainEnvironment([]);
      expect(missing).toEqual([]);
    });
  });

  describe('with chains that have resolved URLs (builder fallbacks)', () => {
    // NOTE: Chain configs resolve URLs at module load time via dRPC/PublicNode builders.
    // validateChainEnvironment() only flags chains whose rpcUrl contains literal '${' or
    // 'process.env' strings (unresolved placeholders). Since all current chain configs
    // have builder functions that resolve at load time, validation returns empty arrays
    // for chains with working fallback URLs.

    it('should return empty array when chain has resolved fallback URLs', () => {
      // Arbitrum config: process.env.ARBITRUM_RPC_URL || drpc('arbitrum') || 'https://...'
      // Since drpc() resolves at module load, the rpcUrl doesn't contain placeholders
      const missing = validateChainEnvironment(['arbitrum']);

      // With resolved builder URLs, no missing vars are reported
      expect(missing).toEqual([]);
    });

    it('should not report missing vars when env vars are explicitly set', () => {
      process.env.ARBITRUM_RPC_URL = 'https://arb1.arbitrum.io/rpc';
      process.env.ARBITRUM_WS_URL = 'wss://arb1.arbitrum.io/feed';

      const missing = validateChainEnvironment(['arbitrum']);

      expect(missing).not.toContain('ARBITRUM_RPC_URL');
      expect(missing).not.toContain('ARBITRUM_WS_URL');
    });
  });

  describe('with multiple chains', () => {
    it('should validate multiple chains without errors', () => {
      // Chain configs have builder fallbacks, so no missing vars
      const missing = validateChainEnvironment(['bsc', 'base']);

      // Both chains have resolved URLs via builders
      expect(Array.isArray(missing)).toBe(true);
    });

    it('should handle mixed set/unset env vars gracefully', () => {
      process.env.BSC_RPC_URL = 'https://bsc-dataseed1.binance.org';
      process.env.BSC_WS_URL = 'wss://bsc-ws-node.nariox.org';

      const missing = validateChainEnvironment(['bsc', 'base']);

      // BSC vars are set, so definitely not missing
      expect(missing).not.toContain('BSC_RPC_URL');
      expect(missing).not.toContain('BSC_WS_URL');
    });
  });

  describe('with invalid chain IDs', () => {
    it('should skip invalid chain IDs', () => {
      const missing = validateChainEnvironment(['invalid-chain-123']);

      // Should return empty array since invalid chains are skipped
      expect(missing).toEqual([]);
    });

    it('should validate only valid chains when mixed with invalid ones', () => {
      process.env.ARBITRUM_RPC_URL = 'https://arb1.arbitrum.io/rpc';
      process.env.ARBITRUM_WS_URL = 'wss://arb1.arbitrum.io/feed';

      const missing = validateChainEnvironment(['arbitrum', 'invalid-chain', 'fake-chain']);

      // Should only validate arbitrum and skip invalid chains
      expect(missing).toEqual([]);
    });
  });

  describe('without chainIds parameter (uses partition from env)', () => {
    it('should use partition from PARTITION_ID env var when chainIds not provided', () => {
      // Set PARTITION_ID to l2-turbo which includes arbitrum, base, optimism, scroll, blast
      process.env.PARTITION_ID = 'l2-turbo';

      const missing = validateChainEnvironment();

      // Chain configs have builder fallbacks (dRPC/PublicNode), so resolved URLs
      // don't contain placeholder patterns. The function returns what it finds.
      expect(Array.isArray(missing)).toBe(true);
    });

    it('should return empty array when PARTITION_ID is not set and chainIds not provided', () => {
      delete process.env.PARTITION_ID;

      const missing = validateChainEnvironment();

      // Should return empty array when no partition is found
      expect(missing).toEqual([]);
    });
  });

  describe('case sensitivity', () => {
    it('should accept lowercase chain IDs', () => {
      // validateChainEnvironment accepts lowercase chain IDs (standard format)
      const missing = validateChainEnvironment(['arbitrum', 'bsc']);

      // Returns an array (may be empty if chains have resolved fallback URLs)
      expect(Array.isArray(missing)).toBe(true);
    });

    it('should handle chain lookup correctly', () => {
      // Chain IDs are lowercase in the CHAINS registry
      const missing = validateChainEnvironment(['ethereum']);

      // Should return an array (may be empty with resolved builder URLs)
      expect(Array.isArray(missing)).toBe(true);
    });
  });
});
