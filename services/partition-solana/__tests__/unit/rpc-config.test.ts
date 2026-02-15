/**
 * Unit Tests for Solana RPC Configuration Module
 *
 * Tests RPC provider selection logic, devnet mode detection,
 * and API key redaction for safe logging.
 *
 * @see services/partition-solana/src/rpc-config.ts
 */

// =============================================================================
// Environment Setup
// =============================================================================

const originalEnv = process.env;

function setupTestEnv(overrides: Record<string, string> = {}): void {
  process.env = {
    ...originalEnv,
    NODE_ENV: 'test',
    ...overrides,
  };
}

function clearRpcEnvVars(): void {
  delete process.env.SOLANA_RPC_URL;
  delete process.env.SOLANA_DEVNET_RPC_URL;
  delete process.env.HELIUS_API_KEY;
  delete process.env.TRITON_API_KEY;
  delete process.env.PARTITION_CHAINS;
}

// =============================================================================
// Tests
// =============================================================================

describe('rpc-config', () => {
  beforeEach(() => {
    jest.resetModules();
    setupTestEnv();
    clearRpcEnvVars();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ---------------------------------------------------------------------------
  // SOLANA_RPC_PROVIDERS constant
  // ---------------------------------------------------------------------------

  describe('SOLANA_RPC_PROVIDERS', () => {
    it('should export mainnet provider URL builders', async () => {
      const { SOLANA_RPC_PROVIDERS } = await import('../../src/rpc-config');

      expect(SOLANA_RPC_PROVIDERS.mainnet).toBeDefined();
      expect(typeof SOLANA_RPC_PROVIDERS.mainnet.helius).toBe('function');
      expect(typeof SOLANA_RPC_PROVIDERS.mainnet.triton).toBe('function');
      expect(typeof SOLANA_RPC_PROVIDERS.mainnet.publicNode).toBe('string');
      expect(typeof SOLANA_RPC_PROVIDERS.mainnet.solanaPublic).toBe('string');
    });

    it('should export devnet provider URL builders', async () => {
      const { SOLANA_RPC_PROVIDERS } = await import('../../src/rpc-config');

      expect(SOLANA_RPC_PROVIDERS.devnet).toBeDefined();
      expect(typeof SOLANA_RPC_PROVIDERS.devnet.helius).toBe('function');
      expect(typeof SOLANA_RPC_PROVIDERS.devnet.triton).toBe('function');
      expect(typeof SOLANA_RPC_PROVIDERS.devnet.publicNode).toBe('string');
      expect(typeof SOLANA_RPC_PROVIDERS.devnet.solanaPublic).toBe('string');
    });

    it('should build correct Helius mainnet URL with API key', async () => {
      const { SOLANA_RPC_PROVIDERS } = await import('../../src/rpc-config');
      const url = SOLANA_RPC_PROVIDERS.mainnet.helius('my-key-123');
      expect(url).toBe('https://mainnet.helius-rpc.com/?api-key=my-key-123');
    });

    it('should build correct Helius devnet URL with API key', async () => {
      const { SOLANA_RPC_PROVIDERS } = await import('../../src/rpc-config');
      const url = SOLANA_RPC_PROVIDERS.devnet.helius('my-key-123');
      expect(url).toBe('https://devnet.helius-rpc.com/?api-key=my-key-123');
    });

    it('should build correct Triton mainnet URL with API key', async () => {
      const { SOLANA_RPC_PROVIDERS } = await import('../../src/rpc-config');
      const url = SOLANA_RPC_PROVIDERS.mainnet.triton('abc123');
      expect(url).toBe('https://solana-mainnet.rpc.extrnode.com/abc123');
    });

    it('should build correct Triton devnet URL with API key', async () => {
      const { SOLANA_RPC_PROVIDERS } = await import('../../src/rpc-config');
      const url = SOLANA_RPC_PROVIDERS.devnet.triton('abc123');
      expect(url).toBe('https://solana-devnet.rpc.extrnode.com/abc123');
    });

    it('should have correct PublicNode mainnet URL', async () => {
      const { SOLANA_RPC_PROVIDERS } = await import('../../src/rpc-config');
      expect(SOLANA_RPC_PROVIDERS.mainnet.publicNode).toBe('https://solana-mainnet.rpc.publicnode.com');
    });

    it('should have correct PublicNode devnet URL', async () => {
      const { SOLANA_RPC_PROVIDERS } = await import('../../src/rpc-config');
      expect(SOLANA_RPC_PROVIDERS.devnet.publicNode).toBe('https://solana-devnet.rpc.publicnode.com');
    });
  });

  // ---------------------------------------------------------------------------
  // isDevnetMode()
  // ---------------------------------------------------------------------------

  describe('isDevnetMode()', () => {
    it('should return false when PARTITION_CHAINS is not set', async () => {
      const { isDevnetMode } = await import('../../src/rpc-config');
      expect(isDevnetMode()).toBe(false);
    });

    it('should return false when PARTITION_CHAINS is empty string', async () => {
      process.env.PARTITION_CHAINS = '';
      const { isDevnetMode } = await import('../../src/rpc-config');
      expect(isDevnetMode()).toBe(false);
    });

    it('should return false when PARTITION_CHAINS contains only mainnet chains', async () => {
      process.env.PARTITION_CHAINS = 'solana';
      const { isDevnetMode } = await import('../../src/rpc-config');
      expect(isDevnetMode()).toBe(false);
    });

    it('should return false for non-solana chains', async () => {
      process.env.PARTITION_CHAINS = 'ethereum,bsc,polygon';
      const { isDevnetMode } = await import('../../src/rpc-config');
      expect(isDevnetMode()).toBe(false);
    });

    it('should return true when PARTITION_CHAINS is solana-devnet', async () => {
      process.env.PARTITION_CHAINS = 'solana-devnet';
      const { isDevnetMode } = await import('../../src/rpc-config');
      expect(isDevnetMode()).toBe(true);
    });

    it('should return true when PARTITION_CHAINS contains solana-devnet among other chains', async () => {
      process.env.PARTITION_CHAINS = 'solana,solana-devnet';
      const { isDevnetMode } = await import('../../src/rpc-config');
      expect(isDevnetMode()).toBe(true);
    });

    it('should handle whitespace around chain names', async () => {
      process.env.PARTITION_CHAINS = ' solana-devnet , solana ';
      const { isDevnetMode } = await import('../../src/rpc-config');
      expect(isDevnetMode()).toBe(true);
    });

    it('should be case-insensitive (uppercase)', async () => {
      process.env.PARTITION_CHAINS = 'SOLANA-DEVNET';
      const { isDevnetMode } = await import('../../src/rpc-config');
      expect(isDevnetMode()).toBe(true);
    });

    it('should be case-insensitive (mixed case)', async () => {
      process.env.PARTITION_CHAINS = 'Solana-Devnet';
      const { isDevnetMode } = await import('../../src/rpc-config');
      expect(isDevnetMode()).toBe(true);
    });

    it('should handle leading/trailing commas gracefully', async () => {
      process.env.PARTITION_CHAINS = ',solana-devnet,';
      const { isDevnetMode } = await import('../../src/rpc-config');
      // The empty strings from split won't match 'solana-devnet'
      // but 'solana-devnet' itself is present
      expect(isDevnetMode()).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // selectSolanaRpcUrl()
  // ---------------------------------------------------------------------------

  describe('selectSolanaRpcUrl()', () => {
    // -------------------------------------------------------------------------
    // Priority 1: Explicit URL
    // -------------------------------------------------------------------------

    describe('Priority 1: Explicit URL', () => {
      it('should select SOLANA_RPC_URL for mainnet when set', async () => {
        process.env.SOLANA_RPC_URL = 'https://custom-rpc.example.com';
        const { selectSolanaRpcUrl } = await import('../../src/rpc-config');

        const result = selectSolanaRpcUrl();

        expect(result.url).toBe('https://custom-rpc.example.com');
        expect(result.provider).toBe('explicit');
        expect(result.isPublicEndpoint).toBe(false);
      });

      it('should select SOLANA_DEVNET_RPC_URL when in devnet mode', async () => {
        process.env.PARTITION_CHAINS = 'solana-devnet';
        process.env.SOLANA_DEVNET_RPC_URL = 'https://devnet-custom.example.com';
        const { selectSolanaRpcUrl } = await import('../../src/rpc-config');

        const result = selectSolanaRpcUrl();

        expect(result.url).toBe('https://devnet-custom.example.com');
        expect(result.provider).toBe('explicit');
        expect(result.isPublicEndpoint).toBe(false);
      });

      it('should ignore SOLANA_RPC_URL when in devnet mode (only SOLANA_DEVNET_RPC_URL matters)', async () => {
        process.env.PARTITION_CHAINS = 'solana-devnet';
        process.env.SOLANA_RPC_URL = 'https://mainnet-url.example.com';
        // No SOLANA_DEVNET_RPC_URL set
        const { selectSolanaRpcUrl } = await import('../../src/rpc-config');

        const result = selectSolanaRpcUrl();

        // Should fall through to lower priority (not explicit)
        expect(result.provider).not.toBe('explicit');
      });

      it('should ignore SOLANA_DEVNET_RPC_URL when in mainnet mode', async () => {
        // No PARTITION_CHAINS set = mainnet mode
        process.env.SOLANA_DEVNET_RPC_URL = 'https://devnet-url.example.com';
        const { selectSolanaRpcUrl } = await import('../../src/rpc-config');

        const result = selectSolanaRpcUrl();

        // Should fall through (mainnet ignores devnet URL)
        expect(result.provider).not.toBe('explicit');
      });
    });

    // -------------------------------------------------------------------------
    // Priority 2: Helius
    // -------------------------------------------------------------------------

    describe('Priority 2: Helius', () => {
      it('should construct Helius mainnet URL from HELIUS_API_KEY', async () => {
        process.env.HELIUS_API_KEY = 'test-helius-key';
        const { selectSolanaRpcUrl } = await import('../../src/rpc-config');

        const result = selectSolanaRpcUrl();

        expect(result.url).toBe('https://mainnet.helius-rpc.com/?api-key=test-helius-key');
        expect(result.provider).toBe('helius');
        expect(result.isPublicEndpoint).toBe(false);
      });

      it('should construct Helius devnet URL when in devnet mode', async () => {
        process.env.HELIUS_API_KEY = 'test-helius-key';
        process.env.PARTITION_CHAINS = 'solana-devnet';
        const { selectSolanaRpcUrl } = await import('../../src/rpc-config');

        const result = selectSolanaRpcUrl();

        expect(result.url).toBe('https://devnet.helius-rpc.com/?api-key=test-helius-key');
        expect(result.provider).toBe('helius');
      });

      it('should not select Helius when HELIUS_API_KEY is empty string', async () => {
        process.env.HELIUS_API_KEY = '';
        const { selectSolanaRpcUrl } = await import('../../src/rpc-config');

        const result = selectSolanaRpcUrl();

        expect(result.provider).not.toBe('helius');
      });
    });

    // -------------------------------------------------------------------------
    // Priority 3: Triton
    // -------------------------------------------------------------------------

    describe('Priority 3: Triton', () => {
      it('should construct Triton mainnet URL from TRITON_API_KEY', async () => {
        process.env.TRITON_API_KEY = 'test-triton-key';
        const { selectSolanaRpcUrl } = await import('../../src/rpc-config');

        const result = selectSolanaRpcUrl();

        expect(result.url).toBe('https://solana-mainnet.rpc.extrnode.com/test-triton-key');
        expect(result.provider).toBe('triton');
        expect(result.isPublicEndpoint).toBe(false);
      });

      it('should construct Triton devnet URL when in devnet mode', async () => {
        process.env.TRITON_API_KEY = 'test-triton-key';
        process.env.PARTITION_CHAINS = 'solana-devnet';
        const { selectSolanaRpcUrl } = await import('../../src/rpc-config');

        const result = selectSolanaRpcUrl();

        expect(result.url).toBe('https://solana-devnet.rpc.extrnode.com/test-triton-key');
        expect(result.provider).toBe('triton');
      });

      it('should not select Triton when TRITON_API_KEY is empty string', async () => {
        process.env.TRITON_API_KEY = '';
        const { selectSolanaRpcUrl } = await import('../../src/rpc-config');

        const result = selectSolanaRpcUrl();

        expect(result.provider).not.toBe('triton');
      });
    });

    // -------------------------------------------------------------------------
    // Priority 4: PublicNode Fallback
    // -------------------------------------------------------------------------

    describe('Priority 4: PublicNode fallback', () => {
      it('should fall back to PublicNode mainnet when no API keys set', async () => {
        const { selectSolanaRpcUrl } = await import('../../src/rpc-config');

        const result = selectSolanaRpcUrl();

        expect(result.url).toBe('https://solana-mainnet.rpc.publicnode.com');
        expect(result.provider).toBe('publicnode');
        expect(result.isPublicEndpoint).toBe(true);
      });

      it('should fall back to PublicNode devnet when in devnet mode with no keys', async () => {
        process.env.PARTITION_CHAINS = 'solana-devnet';
        const { selectSolanaRpcUrl } = await import('../../src/rpc-config');

        const result = selectSolanaRpcUrl();

        expect(result.url).toBe('https://solana-devnet.rpc.publicnode.com');
        expect(result.provider).toBe('publicnode');
        expect(result.isPublicEndpoint).toBe(true);
      });
    });

    // -------------------------------------------------------------------------
    // Priority Ordering
    // -------------------------------------------------------------------------

    describe('Priority ordering', () => {
      it('should prefer explicit URL over Helius', async () => {
        process.env.SOLANA_RPC_URL = 'https://explicit.example.com';
        process.env.HELIUS_API_KEY = 'helius-key';
        const { selectSolanaRpcUrl } = await import('../../src/rpc-config');

        const result = selectSolanaRpcUrl();

        expect(result.provider).toBe('explicit');
        expect(result.url).toBe('https://explicit.example.com');
      });

      it('should prefer explicit URL over Triton', async () => {
        process.env.SOLANA_RPC_URL = 'https://explicit.example.com';
        process.env.TRITON_API_KEY = 'triton-key';
        const { selectSolanaRpcUrl } = await import('../../src/rpc-config');

        const result = selectSolanaRpcUrl();

        expect(result.provider).toBe('explicit');
      });

      it('should prefer Helius over Triton when both API keys set', async () => {
        process.env.HELIUS_API_KEY = 'helius-key';
        process.env.TRITON_API_KEY = 'triton-key';
        const { selectSolanaRpcUrl } = await import('../../src/rpc-config');

        const result = selectSolanaRpcUrl();

        expect(result.provider).toBe('helius');
      });

      it('should prefer explicit URL over all others when all set', async () => {
        process.env.SOLANA_RPC_URL = 'https://explicit.example.com';
        process.env.HELIUS_API_KEY = 'helius-key';
        process.env.TRITON_API_KEY = 'triton-key';
        const { selectSolanaRpcUrl } = await import('../../src/rpc-config');

        const result = selectSolanaRpcUrl();

        expect(result.provider).toBe('explicit');
      });

      it('should fall back to Triton when only Triton key is set', async () => {
        process.env.TRITON_API_KEY = 'triton-only';
        const { selectSolanaRpcUrl } = await import('../../src/rpc-config');

        const result = selectSolanaRpcUrl();

        expect(result.provider).toBe('triton');
      });
    });

    // -------------------------------------------------------------------------
    // RpcSelection interface shape
    // -------------------------------------------------------------------------

    describe('RpcSelection interface', () => {
      it('should return object with url, provider, and isPublicEndpoint fields', async () => {
        const { selectSolanaRpcUrl } = await import('../../src/rpc-config');

        const result = selectSolanaRpcUrl();

        expect(result).toHaveProperty('url');
        expect(result).toHaveProperty('provider');
        expect(result).toHaveProperty('isPublicEndpoint');
        expect(typeof result.url).toBe('string');
        expect(typeof result.provider).toBe('string');
        expect(typeof result.isPublicEndpoint).toBe('boolean');
      });
    });
  });

  // ---------------------------------------------------------------------------
  // redactRpcUrl()
  // ---------------------------------------------------------------------------

  describe('redactRpcUrl()', () => {
    it('should redact Helius-style api-key query parameter', async () => {
      const { redactRpcUrl } = await import('../../src/rpc-config');

      const redacted = redactRpcUrl('https://mainnet.helius-rpc.com/?api-key=my-secret-key-123');

      expect(redacted).toBe('https://mainnet.helius-rpc.com/?api-key=***REDACTED***');
      expect(redacted).not.toContain('my-secret-key-123');
    });

    it('should redact api-key while preserving other query parameters', async () => {
      const { redactRpcUrl } = await import('../../src/rpc-config');

      const redacted = redactRpcUrl('https://rpc.example.com/?api-key=secret123&version=v2&format=json');

      expect(redacted).toContain('api-key=***REDACTED***');
      expect(redacted).toContain('version=v2');
      expect(redacted).toContain('format=json');
      expect(redacted).not.toContain('secret123');
    });

    it('should redact Triton-style path-based API key (long hex segment)', async () => {
      const { redactRpcUrl } = await import('../../src/rpc-config');

      const redacted = redactRpcUrl('https://solana-mainnet.rpc.extrnode.com/abcdef0123456789abcdef0123');

      expect(redacted).toContain('***REDACTED***');
      expect(redacted).not.toContain('abcdef0123456789abcdef0123');
    });

    it('should redact path-based key with trailing slash', async () => {
      const { redactRpcUrl } = await import('../../src/rpc-config');

      const redacted = redactRpcUrl('https://solana-mainnet.rpc.extrnode.com/abcdef0123456789abcdef0123/');

      expect(redacted).toContain('***REDACTED***');
      expect(redacted).not.toContain('abcdef0123456789abcdef0123');
    });

    it('should not modify URLs with no API keys to redact', async () => {
      const { redactRpcUrl } = await import('../../src/rpc-config');

      const url = 'https://solana-mainnet.rpc.publicnode.com';
      const redacted = redactRpcUrl(url);

      expect(redacted).toBe(url);
    });

    it('should not modify URL with short path segments (not API keys)', async () => {
      const { redactRpcUrl } = await import('../../src/rpc-config');

      const url = 'https://my-private-rpc.example.com/v1';
      const redacted = redactRpcUrl(url);

      expect(redacted).toBe(url);
    });

    it('should redact both query param and path-based keys when both present', async () => {
      const { redactRpcUrl } = await import('../../src/rpc-config');

      // Path-based regex matches hex segments ending with / or end-of-string ($),
      // so a hex segment followed by ? (query) won't be redacted by path regex.
      // Test with trailing slash to trigger path redaction:
      const url = 'https://rpc.example.com/abcdef0123456789abcdef0123/?api-key=secret456';
      const redacted = redactRpcUrl(url);

      expect(redacted).toContain('api-key=***REDACTED***');
      expect(redacted).not.toContain('secret456');
      // The path-based key should also be redacted (followed by /)
      expect(redacted).not.toContain('abcdef0123456789abcdef0123');
    });

    it('should handle Helius devnet URL redaction', async () => {
      const { redactRpcUrl } = await import('../../src/rpc-config');

      const redacted = redactRpcUrl('https://devnet.helius-rpc.com/?api-key=devnet-secret-key');

      expect(redacted).toBe('https://devnet.helius-rpc.com/?api-key=***REDACTED***');
      expect(redacted).not.toContain('devnet-secret-key');
    });

    it('should handle empty string input', async () => {
      const { redactRpcUrl } = await import('../../src/rpc-config');

      const redacted = redactRpcUrl('');

      expect(redacted).toBe('');
    });

    it('should not redact hex segments shorter than 20 characters', async () => {
      const { redactRpcUrl } = await import('../../src/rpc-config');

      // 19-char hex string - should not be redacted
      const url = 'https://rpc.example.com/abcdef012345678ab';
      const redacted = redactRpcUrl(url);

      expect(redacted).toBe(url);
    });

    it('should redact hex segments of exactly 20 characters', async () => {
      const { redactRpcUrl } = await import('../../src/rpc-config');

      // 20-char hex string - should be redacted
      const url = 'https://rpc.example.com/abcdef0123456789abcd';
      const redacted = redactRpcUrl(url);

      expect(redacted).toContain('***REDACTED***');
      expect(redacted).not.toContain('abcdef0123456789abcd');
    });
  });
});
