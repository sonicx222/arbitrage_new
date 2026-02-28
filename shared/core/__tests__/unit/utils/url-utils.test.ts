/**
 * Tests for maskUrlApiKeys utility
 *
 * @see P1-6 in docs/reports/P1_DATA_FLOW_DEEP_ANALYSIS_2026-02-28.md
 */
import { maskUrlApiKeys } from '../../../src/utils/url-utils';

describe('maskUrlApiKeys', () => {
  describe('path segment masking', () => {
    it('should mask Alchemy-style API keys in URL path', () => {
      const url = 'wss://eth-mainnet.g.alchemy.com/v2/abcdef1234567890abcdef';
      const masked = maskUrlApiKeys(url);
      expect(masked).toContain('/v2/abcde...');
      expect(masked).not.toContain('abcdef1234567890abcdef');
    });

    it('should mask Ankr-style API keys in URL path', () => {
      const url = 'https://rpc.ankr.com/eth/abc123longkey789';
      const masked = maskUrlApiKeys(url);
      expect(masked).toContain('/eth/abc12...');
      expect(masked).not.toContain('abc123longkey789');
    });

    it('should mask Infura-style API keys in URL path', () => {
      const url = 'wss://mainnet.infura.io/v3/1234567890abcdef1234567890abcdef';
      const masked = maskUrlApiKeys(url);
      expect(masked).toContain('/v3/12345...');
      expect(masked).not.toContain('1234567890abcdef1234567890abcdef');
    });

    it('should mask multiple key-like segments', () => {
      const url = 'https://api.provider.com/v1/longapikey12345/data/anotherlongkey98765';
      const masked = maskUrlApiKeys(url);
      expect(masked).not.toContain('longapikey12345');
      expect(masked).not.toContain('anotherlongkey98765');
    });
  });

  describe('query parameter masking', () => {
    it('should mask key query parameter', () => {
      const url = 'https://rpc.provider.com/eth?key=secretapikey123456';
      const masked = maskUrlApiKeys(url);
      expect(masked).toContain('key=***');
      expect(masked).not.toContain('secretapikey123456');
    });

    it('should mask token query parameter', () => {
      const url = 'https://rpc.provider.com/eth?token=mytoken123456';
      const masked = maskUrlApiKeys(url);
      expect(masked).toContain('token=***');
      expect(masked).not.toContain('mytoken123456');
    });

    it('should mask api_key query parameter', () => {
      const url = 'https://rpc.provider.com/eth?api_key=key123';
      const masked = maskUrlApiKeys(url);
      expect(masked).toContain('api_key=***');
      expect(masked).not.toContain('key123');
    });
  });

  describe('URLs without keys (fast path)', () => {
    it('should return short-segment URLs unchanged', () => {
      const url = 'wss://primary.example.com';
      expect(maskUrlApiKeys(url)).toBe(url);
    });

    it('should return URLs with short path segments unchanged', () => {
      const url = 'wss://test.com/v2/short';
      expect(maskUrlApiKeys(url)).toBe(url);
    });

    it('should return PublicNode URLs unchanged (no keys)', () => {
      const url = 'wss://bsc.publicnode.com';
      expect(maskUrlApiKeys(url)).toBe(url);
    });

    it('should return empty string unchanged', () => {
      expect(maskUrlApiKeys('')).toBe('');
    });
  });

  describe('edge cases', () => {
    it('should handle malformed URLs gracefully with regex fallback', () => {
      const malformed = 'not-a-url/v2/abcdef1234567890abcdef';
      const masked = maskUrlApiKeys(malformed);
      expect(masked).not.toContain('abcdef1234567890abcdef');
      expect(masked).toContain('abcde...');
    });

    it('should handle URLs with both path keys and query auth', () => {
      const url = 'https://api.provider.com/v2/longapikey123456?auth=secrettoken';
      const masked = maskUrlApiKeys(url);
      expect(masked).not.toContain('longapikey123456');
      expect(masked).not.toContain('secrettoken');
    });

    it('should preserve non-key path segments', () => {
      const url = 'wss://eth-mainnet.g.alchemy.com/v2/abcdef1234567890abcdef';
      const masked = maskUrlApiKeys(url);
      expect(masked).toContain('eth-mainnet.g.alchemy.com');
      expect(masked).toContain('/v2/');
    });

    it('should not mask path segments shorter than 12 chars', () => {
      // 'test-key' is 8 chars — should NOT be masked
      const url = 'wss://provider.com/v2/test-key';
      expect(maskUrlApiKeys(url)).toBe(url);
    });
  });
});
