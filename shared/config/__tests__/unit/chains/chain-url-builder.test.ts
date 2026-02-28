/**
 * Tests for ChainUrlBuilder
 *
 * @see P2-CONFIG from refactoring-roadmap.md
 */

import {
  buildChainUrls,
  buildChainUrlsWithApiKeys,
  buildSolanaUrls,
  createAlchemyConfig,
  ChainUrlConfig,
} from '../../../src/chains/chain-url-builder';

describe('ChainUrlBuilder', () => {
  // Store original env vars to restore after tests
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset env for each test
    process.env = { ...originalEnv };
    // Clear any chain-specific env vars
    delete process.env.ETHEREUM_RPC_URL;
    delete process.env.ETHEREUM_WS_URL;
    delete process.env.ARBITRUM_RPC_URL;
    delete process.env.ARBITRUM_WS_URL;
    delete process.env.ALCHEMY_OPTIMISM_KEY;
    delete process.env.OPTIMISM_RPC_URL;
    delete process.env.OPTIMISM_WS_URL;
    delete process.env.HELIUS_API_KEY;
    delete process.env.TRITON_API_KEY;
    delete process.env.SOLANA_RPC_URL;
    delete process.env.SOLANA_WS_URL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('buildChainUrls', () => {
    const baseConfig: ChainUrlConfig = {
      chainEnvPrefix: 'ETHEREUM',
      defaultRpcUrl: 'https://eth.llamarpc.com',
      defaultWsUrl: 'wss://eth.llamarpc.com',
      wsFallbackUrls: ['wss://ethereum.publicnode.com'],
      rpcFallbackUrls: ['https://ethereum.publicnode.com'],
    };

    it('should return default URLs when no env vars set', () => {
      const result = buildChainUrls(baseConfig);

      expect(result.rpcUrl).toBe('https://eth.llamarpc.com');
      expect(result.wsUrl).toBe('wss://eth.llamarpc.com');
      expect(result.wsFallbackUrls).toEqual(['wss://ethereum.publicnode.com']);
      expect(result.rpcFallbackUrls).toEqual(['https://ethereum.publicnode.com']);
    });

    it('should use env vars when set', () => {
      process.env.ETHEREUM_RPC_URL = 'https://custom-rpc.example.com';
      process.env.ETHEREUM_WS_URL = 'wss://custom-ws.example.com';

      const result = buildChainUrls(baseConfig);

      expect(result.rpcUrl).toBe('https://custom-rpc.example.com');
      expect(result.wsUrl).toBe('wss://custom-ws.example.com');
    });

    it('should handle case-insensitive chain prefix', () => {
      process.env.ARBITRUM_RPC_URL = 'https://arb-custom.example.com';
      process.env.ARBITRUM_WS_URL = 'wss://arb-custom.example.com';

      const result = buildChainUrls({
        chainEnvPrefix: 'arbitrum', // lowercase
        defaultRpcUrl: 'https://arb1.arbitrum.io/rpc',
        defaultWsUrl: 'wss://arb1.arbitrum.io/feed',
      });

      expect(result.rpcUrl).toBe('https://arb-custom.example.com');
      expect(result.wsUrl).toBe('wss://arb-custom.example.com');
    });

    it('should return empty arrays when fallbacks not provided', () => {
      const result = buildChainUrls({
        chainEnvPrefix: 'TEST',
        defaultRpcUrl: 'https://test.com',
        defaultWsUrl: 'wss://test.com',
      });

      expect(result.wsFallbackUrls).toEqual([]);
      expect(result.rpcFallbackUrls).toEqual([]);
    });
  });

  describe('buildChainUrlsWithApiKeys', () => {
    const baseConfig: ChainUrlConfig = {
      chainEnvPrefix: 'OPTIMISM',
      defaultRpcUrl: 'https://mainnet.optimism.io',
      defaultWsUrl: 'wss://optimism.publicnode.com',
      wsFallbackUrls: ['wss://optimism-mainnet.public.blastapi.io'],
      rpcFallbackUrls: ['https://optimism-mainnet.public.blastapi.io'],
    };

    it('should use explicit env vars over API keys', () => {
      process.env.OPTIMISM_RPC_URL = 'https://explicit.example.com';
      process.env.OPTIMISM_WS_URL = 'wss://explicit.example.com';
      process.env.ALCHEMY_OPTIMISM_KEY = 'test-api-key';

      const result = buildChainUrlsWithApiKeys(baseConfig, [
        createAlchemyConfig('opt'),
      ]);

      expect(result.rpcUrl).toBe('https://explicit.example.com');
      expect(result.wsUrl).toBe('wss://explicit.example.com');
    });

    it('should use API key URL when key is set', () => {
      process.env.ALCHEMY_OPTIMISM_KEY = 'test-api-key';

      const result = buildChainUrlsWithApiKeys(baseConfig, [
        {
          apiKeyEnvVar: 'ALCHEMY_OPTIMISM_KEY',
          rpcUrlTemplate: (key: string) => `https://opt-mainnet.g.alchemy.com/v2/${key}`,
          wsUrlTemplate: (key: string) => `wss://opt-mainnet.g.alchemy.com/v2/${key}`,
        },
      ]);

      expect(result.rpcUrl).toBe('https://opt-mainnet.g.alchemy.com/v2/test-api-key');
      expect(result.wsUrl).toBe('wss://opt-mainnet.g.alchemy.com/v2/test-api-key');
    });

    it('should fall back to defaults when no API key set', () => {
      const result = buildChainUrlsWithApiKeys(baseConfig, [
        createAlchemyConfig('opt'),
      ]);

      expect(result.rpcUrl).toBe('https://mainnet.optimism.io');
      expect(result.wsUrl).toBe('wss://optimism.publicnode.com');
    });

    it('should try API keys in order until one is found', () => {
      process.env.SECONDARY_API_KEY = 'secondary-key';

      const result = buildChainUrlsWithApiKeys(baseConfig, [
        {
          apiKeyEnvVar: 'PRIMARY_API_KEY', // not set
          rpcUrlTemplate: (key: string) => `https://primary/${key}`,
          wsUrlTemplate: (key: string) => `wss://primary/${key}`,
        },
        {
          apiKeyEnvVar: 'SECONDARY_API_KEY', // set
          rpcUrlTemplate: (key: string) => `https://secondary/${key}`,
          wsUrlTemplate: (key: string) => `wss://secondary/${key}`,
        },
      ]);

      expect(result.rpcUrl).toBe('https://secondary/secondary-key');
      expect(result.wsUrl).toBe('wss://secondary/secondary-key');
    });
  });

  describe('buildSolanaUrls', () => {
    describe('mainnet', () => {
      it('should use public RPC when no API keys set', () => {
        const result = buildSolanaUrls('mainnet');

        expect(result.rpcUrl).toBe('https://api.mainnet-beta.solana.com');
        expect(result.wsUrl).toBe('wss://api.mainnet-beta.solana.com');
      });

      it('should prefer Helius when HELIUS_API_KEY is set', () => {
        process.env.HELIUS_API_KEY = 'helius-test-key';

        const result = buildSolanaUrls('mainnet');

        expect(result.rpcUrl).toBe('https://mainnet.helius-rpc.com/?api-key=helius-test-key');
        expect(result.wsUrl).toBe('wss://mainnet.helius-rpc.com/?api-key=helius-test-key');
      });

      it('should use Triton when only TRITON_API_KEY is set', () => {
        process.env.TRITON_API_KEY = 'triton-test-key';

        const result = buildSolanaUrls('mainnet');

        expect(result.rpcUrl).toBe('https://solana-mainnet.triton.one/v1/triton-test-key');
        expect(result.wsUrl).toBe('wss://solana-mainnet.triton.one/v1/triton-test-key');
      });

      it('should add Triton as fallback when both keys are set', () => {
        process.env.HELIUS_API_KEY = 'helius-key';
        process.env.TRITON_API_KEY = 'triton-key';

        const result = buildSolanaUrls('mainnet');

        // Primary should be Helius
        expect(result.rpcUrl).toContain('helius');
        expect(result.wsUrl).toContain('helius');

        // Triton should be in fallbacks
        expect(result.wsFallbackUrls).toContain('wss://solana-mainnet.triton.one/v1/triton-key');
        expect(result.rpcFallbackUrls).toContain('https://solana-mainnet.triton.one/v1/triton-key');
      });

      it('should use explicit env vars over API keys', () => {
        process.env.SOLANA_RPC_URL = 'https://explicit-rpc.example.com';
        process.env.SOLANA_WS_URL = 'wss://explicit-ws.example.com';
        process.env.HELIUS_API_KEY = 'helius-key';

        const result = buildSolanaUrls('mainnet');

        expect(result.rpcUrl).toBe('https://explicit-rpc.example.com');
        expect(result.wsUrl).toBe('wss://explicit-ws.example.com');
      });

      it('should include standard public fallbacks', () => {
        const result = buildSolanaUrls('mainnet');

        expect(result.wsFallbackUrls).toContain('wss://solana.publicnode.com');
        expect(result.rpcFallbackUrls).toContain('https://solana.publicnode.com');
        expect(result.rpcFallbackUrls).toContain('https://api.mainnet-beta.solana.com');
      });
    });

    describe('devnet', () => {
      it('should use devnet URLs', () => {
        const result = buildSolanaUrls('devnet');

        expect(result.rpcUrl).toBe('https://api.devnet.solana.com');
        expect(result.wsUrl).toBe('wss://api.devnet.solana.com');
      });

      it('should use Helius devnet when key is set', () => {
        process.env.HELIUS_API_KEY = 'helius-key';

        const result = buildSolanaUrls('devnet');

        expect(result.rpcUrl).toBe('https://devnet.helius-rpc.com/?api-key=helius-key');
        expect(result.wsUrl).toBe('wss://devnet.helius-rpc.com/?api-key=helius-key');
      });

      it('should include devnet-specific fallbacks', () => {
        const result = buildSolanaUrls('devnet');

        expect(result.wsFallbackUrls).toContain('wss://solana-devnet.publicnode.com');
        expect(result.rpcFallbackUrls).toContain('https://solana-devnet.publicnode.com');
      });
    });
  });

  describe('createAlchemyConfig', () => {
    it('should create correct Alchemy URL templates', () => {
      const config = createAlchemyConfig('eth');

      expect(config.apiKeyEnvVar).toBe('ALCHEMY_API_KEY');
      expect(config.rpcUrlTemplate('test-key')).toBe('https://eth-mainnet.g.alchemy.com/v2/test-key');
      expect(config.wsUrlTemplate('test-key')).toBe('wss://eth-mainnet.g.alchemy.com/v2/test-key');
    });
  });
});
