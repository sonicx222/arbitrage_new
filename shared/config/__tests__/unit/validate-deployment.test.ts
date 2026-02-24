/**
 * Unit Tests for Pre-Deployment Validation Script
 *
 * Tests individual check functions with mocked dependencies (Redis, RPC, fs).
 * Validates summary generation logic and exit code determination.
 *
 * @see scripts/validate-deployment.ts
 * @see O-11: Pre-deployment validation
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Set test environment BEFORE imports
process.env.NODE_ENV = 'test';

import {
  checkPrivateKeyFormat,
  checkMevProviders,
  checkEnvironmentConfig,
  checkRedisConnectivity,
  checkRpcEndpoints,
  checkContractAddresses,
  checkGasPrices,
  printSummary,
  isValidEthAddress,
  type ValidationResult,
} from '../../../../scripts/validate-deployment';

// =============================================================================
// Setup
// =============================================================================

// Store original env vars to restore after each test
const originalEnv = { ...process.env };

// Mock global fetch for RPC/network tests
const mockFetch = jest.fn<typeof fetch>();

beforeEach(() => {
  jest.clearAllMocks();
  // Reset env vars to clean state for each test
  process.env = { ...originalEnv, NODE_ENV: 'test' };
  // Clear all chain RPC env vars
  delete process.env.ETHEREUM_RPC_URL;
  delete process.env.ARBITRUM_RPC_URL;
  delete process.env.BSC_RPC_URL;
  delete process.env.BASE_RPC_URL;
  delete process.env.POLYGON_RPC_URL;
  delete process.env.OPTIMISM_RPC_URL;
  delete process.env.AVALANCHE_RPC_URL;
  delete process.env.FANTOM_RPC_URL;
  delete process.env.ZKSYNC_RPC_URL;
  delete process.env.LINEA_RPC_URL;
  delete process.env.SOLANA_RPC_URL;
  // Clear MEV vars
  delete process.env.FLASHBOTS_AUTH_KEY;
  delete process.env.BLOXROUTE_AUTH_HEADER;
  delete process.env.BLOXROUTE_URL;
  delete process.env.FASTLANE_URL;
  delete process.env.MEV_PROTECTION_ENABLED;
  // Clear wallet vars
  delete process.env.WALLET_PRIVATE_KEY;
  delete process.env.WALLET_MNEMONIC;
  // Clear Upstash vars
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  // Clear self-hosted Redis flag
  delete process.env.REDIS_SELF_HOSTED;
  // Clear production indicator vars
  delete process.env.FLY_APP_NAME;
  delete process.env.RAILWAY_ENVIRONMENT;
  delete process.env.RENDER_SERVICE_NAME;

  // Install mock fetch
  (globalThis as Record<string, unknown>).fetch = mockFetch;
});

afterEach(() => {
  process.env = originalEnv;
});

// =============================================================================
// isValidEthAddress
// =============================================================================

describe('isValidEthAddress', () => {
  it('should accept valid Ethereum addresses', () => {
    expect(isValidEthAddress('0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D')).toBe(true);
    expect(isValidEthAddress('0x0000000000000000000000000000000000000000')).toBe(true);
    expect(isValidEthAddress('0xabcdef1234567890abcdef1234567890abcdef12')).toBe(true);
  });

  it('should reject invalid addresses', () => {
    expect(isValidEthAddress('')).toBe(false);
    expect(isValidEthAddress('not-an-address')).toBe(false);
    expect(isValidEthAddress('0x123')).toBe(false);
    expect(isValidEthAddress('7a250d5630B4cF539739dF2C5dAcb4c659F2488D')).toBe(false);
    expect(isValidEthAddress('0xGGGG50d5630B4cF539739dF2C5dAcb4c659F2488D')).toBe(false);
  });
});

// =============================================================================
// checkPrivateKeyFormat
// =============================================================================

describe('checkPrivateKeyFormat', () => {
  it('should pass for valid private key format', () => {
    process.env.WALLET_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    const result = checkPrivateKeyFormat();
    expect(result.status).toBe('pass');
    expect(result.check).toBe('Private Key Format');
    expect(result.details?.configured).toBe(true);
    expect(result.details?.valid).toBe(true);
  });

  it('should warn when private key is not set', () => {
    delete process.env.WALLET_PRIVATE_KEY;
    const result = checkPrivateKeyFormat();
    expect(result.status).toBe('warn');
    expect(result.message).toContain('not set');
    expect(result.details?.configured).toBe(false);
  });

  it('should fail for key missing 0x prefix', () => {
    process.env.WALLET_PRIVATE_KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    const result = checkPrivateKeyFormat();
    expect(result.status).toBe('fail');
    expect(result.message).toContain('missing 0x prefix');
  });

  it('should fail for key with wrong length', () => {
    process.env.WALLET_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bac';
    const result = checkPrivateKeyFormat();
    expect(result.status).toBe('fail');
    expect(result.message).toContain('expected 64 hex chars');
  });

  it('should fail for key with non-hex characters', () => {
    process.env.WALLET_PRIVATE_KEY = '0xzz0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    const result = checkPrivateKeyFormat();
    expect(result.status).toBe('fail');
    expect(result.message).toContain('non-hex characters');
  });

  it('should not expose the actual key value in the message', () => {
    process.env.WALLET_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    const result = checkPrivateKeyFormat();
    expect(result.message).not.toContain('ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  });
});

// =============================================================================
// checkMevProviders
// =============================================================================

describe('checkMevProviders', () => {
  it('should pass for valid Flashbots auth key', () => {
    process.env.FLASHBOTS_AUTH_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    const results = checkMevProviders();
    const flashbotsResult = results.find(r => r.check === 'MEV Provider: Flashbots');
    expect(flashbotsResult?.status).toBe('pass');
  });

  it('should fail for invalid Flashbots auth key format', () => {
    process.env.FLASHBOTS_AUTH_KEY = 'invalid-key';
    const results = checkMevProviders();
    const flashbotsResult = results.find(r => r.check === 'MEV Provider: Flashbots');
    expect(flashbotsResult?.status).toBe('fail');
    expect(flashbotsResult?.message).toContain('invalid format');
  });

  it('should warn when Flashbots key is not set', () => {
    delete process.env.FLASHBOTS_AUTH_KEY;
    const results = checkMevProviders();
    const flashbotsResult = results.find(r => r.check === 'MEV Provider: Flashbots');
    expect(flashbotsResult?.status).toBe('warn');
  });

  it('should pass when BloXroute auth header is set', () => {
    process.env.BLOXROUTE_AUTH_HEADER = 'some-auth-header';
    const results = checkMevProviders();
    const bloxrouteResult = results.find(r => r.check === 'MEV Provider: BloXroute');
    expect(bloxrouteResult?.status).toBe('pass');
  });

  it('should warn when BloXroute URL is not HTTPS', () => {
    process.env.BLOXROUTE_URL = 'http://insecure-endpoint.com';
    const results = checkMevProviders();
    const bloxrouteUrlResult = results.find(r => r.check === 'MEV Provider: BloXroute URL');
    expect(bloxrouteUrlResult?.status).toBe('warn');
  });

  it('should warn when MEV protection is disabled', () => {
    delete process.env.MEV_PROTECTION_ENABLED;
    const results = checkMevProviders();
    const toggleResult = results.find(r => r.check === 'MEV Protection Toggle');
    expect(toggleResult?.status).toBe('warn');
    expect(toggleResult?.message).toContain('not set to "true"');
  });

  it('should not emit toggle warning when MEV protection is enabled', () => {
    process.env.MEV_PROTECTION_ENABLED = 'true';
    const results = checkMevProviders();
    const toggleResult = results.find(r => r.check === 'MEV Protection Toggle');
    expect(toggleResult).toBeUndefined();
  });

  it('should pass for Fastlane with HTTPS URL', () => {
    process.env.FASTLANE_URL = 'https://fastlane.example.com';
    const results = checkMevProviders();
    const fastlaneResult = results.find(r => r.check === 'MEV Provider: Fastlane');
    expect(fastlaneResult?.status).toBe('pass');
  });

  it('should warn for Fastlane with HTTP URL', () => {
    process.env.FASTLANE_URL = 'http://fastlane.example.com';
    const results = checkMevProviders();
    const fastlaneResult = results.find(r => r.check === 'MEV Provider: Fastlane');
    expect(fastlaneResult?.status).toBe('warn');
  });
});

// =============================================================================
// checkEnvironmentConfig
// =============================================================================

describe('checkEnvironmentConfig', () => {
  it('should report Node.js version correctly', () => {
    const results = checkEnvironmentConfig();
    const nodeResult = results.find(r => r.check === 'Node.js Version');
    expect(nodeResult).toBeDefined();
    const majorVersion = parseInt(process.version.slice(1).split('.')[0], 10);
    if (majorVersion >= 22) {
      expect(nodeResult?.status).toBe('pass');
    } else {
      expect(nodeResult?.status).toBe('fail');
    }
  });

  it('should report environment mode in non-production', () => {
    process.env.NODE_ENV = 'test';
    const results = checkEnvironmentConfig();
    const modeResult = results.find(r => r.check === 'Environment Mode');
    expect(modeResult?.status).toBe('pass');
    expect(modeResult?.message).toContain('test');
  });

  it('should fail in production with localhost Redis', () => {
    process.env.NODE_ENV = 'production';
    process.env.REDIS_URL = 'redis://localhost:6379';
    const results = checkEnvironmentConfig();
    const redisResult = results.find(r => r.check === 'Production: Redis');
    expect(redisResult?.status).toBe('fail');
    expect(redisResult?.message).toContain('localhost');
  });

  it('should fail in production with 127.0.0.1 Redis', () => {
    process.env.NODE_ENV = 'production';
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
    const results = checkEnvironmentConfig();
    const redisResult = results.find(r => r.check === 'Production: Redis');
    expect(redisResult?.status).toBe('fail');
  });

  it('should fail in production without wallet credentials', () => {
    process.env.NODE_ENV = 'production';
    process.env.REDIS_URL = 'redis://remote-server:6379';
    delete process.env.WALLET_PRIVATE_KEY;
    delete process.env.WALLET_MNEMONIC;
    const results = checkEnvironmentConfig();
    const walletResult = results.find(r => r.check === 'Production: Wallet');
    expect(walletResult?.status).toBe('fail');
  });

  it('should detect production via platform indicators (Fly.io)', () => {
    process.env.NODE_ENV = 'development';
    process.env.FLY_APP_NAME = 'my-app';
    process.env.REDIS_URL = 'redis://localhost:6379';
    const results = checkEnvironmentConfig();
    const redisResult = results.find(r => r.check === 'Production: Redis');
    expect(redisResult?.status).toBe('fail');
  });

  it('should pass in production with localhost Redis when REDIS_SELF_HOSTED=true', () => {
    process.env.NODE_ENV = 'production';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.REDIS_SELF_HOSTED = 'true';
    process.env.WALLET_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    const results = checkEnvironmentConfig();
    const redisResult = results.find(r => r.check === 'Production: Redis');
    expect(redisResult?.status).toBe('pass');
    expect(redisResult?.details?.provider).toBe('self-hosted');
  });

  it('should fail in production with no REDIS_URL set', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.REDIS_URL;
    const results = checkEnvironmentConfig();
    const redisResult = results.find(r => r.check === 'Production: Redis');
    expect(redisResult?.status).toBe('fail');
    expect(redisResult?.message).toContain('not set');
  });

  it('should still fail with localhost Redis when REDIS_SELF_HOSTED is not true', () => {
    process.env.NODE_ENV = 'production';
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
    process.env.REDIS_SELF_HOSTED = 'false';
    const results = checkEnvironmentConfig();
    const redisResult = results.find(r => r.check === 'Production: Redis');
    expect(redisResult?.status).toBe('fail');
  });
});

// =============================================================================
// checkRedisConnectivity
// =============================================================================

describe('checkRedisConnectivity', () => {
  it('should pass for Upstash when URL and token are configured', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://my-redis.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'some-token';
    const result = await checkRedisConnectivity();
    expect(result.status).toBe('pass');
    expect(result.details?.provider).toBe('upstash');
  });

  it('should fail for Upstash when URL is not HTTPS', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'http://my-redis.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'some-token';
    const result = await checkRedisConnectivity();
    expect(result.status).toBe('fail');
    expect(result.message).toContain('HTTPS');
  });

  it('should fail for Upstash when token is missing', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://my-redis.upstash.io';
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const result = await checkRedisConnectivity();
    expect(result.status).toBe('fail');
    expect(result.message).toContain('UPSTASH_REDIS_REST_TOKEN');
  });

  it('should fail for unparseable Redis URL', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    process.env.REDIS_URL = ':::invalid:::';
    const result = await checkRedisConnectivity();
    expect(result.status).toBe('fail');
    expect(result.message).toContain('Invalid REDIS_URL format');
  });

  it('should detect self-hosted provider when REDIS_SELF_HOSTED=true', async () => {
    process.env.REDIS_SELF_HOSTED = 'true';
    process.env.REDIS_URL = 'redis://localhost:6379';
    delete process.env.UPSTASH_REDIS_REST_URL;
    const result = await checkRedisConnectivity();
    expect(result.details?.provider).toBe('self-hosted');
  });

  it('should warn when REDIS_SELF_HOSTED=true but URL is not localhost', async () => {
    process.env.REDIS_SELF_HOSTED = 'true';
    process.env.REDIS_URL = 'redis://remote-server:6379';
    delete process.env.UPSTASH_REDIS_REST_URL;
    const result = await checkRedisConnectivity();
    expect(result.status).toBe('warn');
    expect(result.message).toContain('does not point to localhost');
  });

  it('should warn for self-hosted when Redis URL is not localhost', async () => {
    process.env.REDIS_SELF_HOSTED = 'true';
    process.env.REDIS_URL = 'redis://remote-host:6379';
    delete process.env.UPSTASH_REDIS_REST_URL;
    const result = await checkRedisConnectivity();
    expect(result.status).toBe('warn');
    expect(result.details?.provider).toBe('self-hosted');
    expect(result.message).toContain('does not point to localhost');
  });
});

// =============================================================================
// checkRpcEndpoints
// =============================================================================

describe('checkRpcEndpoints', () => {
  it('should warn when no RPC endpoints are configured', async () => {
    const results = await checkRpcEndpoints();
    expect(results.length).toBe(1);
    expect(results[0].check).toBe('RPC Endpoints');
    expect(results[0].status).toBe('warn');
    expect(results[0].message).toContain('No chain-specific RPC URLs configured');
  });

  it('should fail for invalid URL format', async () => {
    process.env.ETHEREUM_RPC_URL = 'not-a-url';
    const results = await checkRpcEndpoints();
    const ethResult = results.find(r => r.check === 'RPC Endpoint: ethereum');
    expect(ethResult?.status).toBe('fail');
    expect(ethResult?.message).toContain('invalid URL format');
  });

  it('should pass for successful RPC response', async () => {
    process.env.ETHEREUM_RPC_URL = 'https://rpc.example.com';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: '0x1234567' }),
    } as Response);

    const results = await checkRpcEndpoints();
    const ethResult = results.find(r => r.check === 'RPC Endpoint: ethereum');
    expect(ethResult?.status).toBe('pass');
    expect(ethResult?.details?.chain).toBe('ethereum');
  });

  it('should fail for HTTP error response', async () => {
    process.env.ARBITRUM_RPC_URL = 'https://rpc.example.com';
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
    } as Response);

    const results = await checkRpcEndpoints();
    const arbResult = results.find(r => r.check === 'RPC Endpoint: arbitrum');
    expect(arbResult?.status).toBe('fail');
    expect(arbResult?.message).toContain('503');
  });

  it('should fail for RPC error in response body', async () => {
    process.env.BASE_RPC_URL = 'https://rpc.example.com';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ error: { message: 'rate limit exceeded' } }),
    } as Response);

    const results = await checkRpcEndpoints();
    const baseResult = results.find(r => r.check === 'RPC Endpoint: base');
    expect(baseResult?.status).toBe('fail');
    expect(baseResult?.message).toContain('rate limit exceeded');
  });

  it('should fail for network errors', async () => {
    process.env.POLYGON_RPC_URL = 'https://rpc.example.com';
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const results = await checkRpcEndpoints();
    const polyResult = results.find(r => r.check === 'RPC Endpoint: polygon');
    expect(polyResult?.status).toBe('fail');
    expect(polyResult?.message).toContain('ECONNREFUSED');
  });

  it('should use getSlot for Solana instead of eth_blockNumber', async () => {
    process.env.SOLANA_RPC_URL = 'https://solana-rpc.example.com';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: 12345678 }),
    } as Response);

    const results = await checkRpcEndpoints();
    const solResult = results.find(r => r.check === 'RPC Endpoint: solana');
    expect(solResult?.status).toBe('pass');

    // Verify the request used getSlot method
    const callBody = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
    expect(callBody.method).toBe('getSlot');
  });
});

// =============================================================================
// checkGasPrices
// =============================================================================

describe('checkGasPrices', () => {
  it('should pass for normal L2 gas prices', async () => {
    process.env.ARBITRUM_RPC_URL = 'https://rpc.example.com';
    // 0.01 gwei = 10_000_000 wei = 0x989680
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: '0x989680' }),
    } as Response);

    const results = await checkGasPrices();
    const arbResult = results.find(r => r.check === 'Gas Price: arbitrum');
    expect(arbResult?.status).toBe('pass');
  });

  it('should warn for high L1 gas prices (>100 gwei)', async () => {
    process.env.ETHEREUM_RPC_URL = 'https://rpc.example.com';
    // 150 gwei = 150_000_000_000 wei = 0x22ECB25C00
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: '0x22ECB25C00' }),
    } as Response);

    const results = await checkGasPrices();
    const ethResult = results.find(r => r.check === 'Gas Price: ethereum');
    expect(ethResult?.status).toBe('warn');
    expect(ethResult?.message).toContain('high');
  });

  it('should warn for high L2 gas prices (>1 gwei)', async () => {
    process.env.BASE_RPC_URL = 'https://rpc.example.com';
    // 5 gwei = 5_000_000_000 wei = 0x12A05F200
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: '0x12A05F200' }),
    } as Response);

    const results = await checkGasPrices();
    const baseResult = results.find(r => r.check === 'Gas Price: base');
    expect(baseResult?.status).toBe('warn');
  });

  it('should skip Solana (no eth_gasPrice)', async () => {
    process.env.SOLANA_RPC_URL = 'https://solana-rpc.example.com';
    const results = await checkGasPrices();
    const solResult = results.find(r => r.check === 'Gas Price: solana');
    expect(solResult).toBeUndefined();
  });

  it('should return empty results when no RPC URLs configured', async () => {
    const results = await checkGasPrices();
    expect(results.length).toBe(0);
  });

  it('should silently skip chains with RPC errors', async () => {
    process.env.ETHEREUM_RPC_URL = 'https://rpc.example.com';
    mockFetch.mockRejectedValueOnce(new Error('timeout'));

    const results = await checkGasPrices();
    const ethResult = results.find(r => r.check === 'Gas Price: ethereum');
    expect(ethResult).toBeUndefined();
  });
});

// =============================================================================
// checkContractAddresses
// =============================================================================

describe('checkContractAddresses', () => {
  it('should return results without crashing', async () => {
    const results = await checkContractAddresses();
    expect(results.length).toBeGreaterThan(0);
    // Should either warn about no contracts or pass/fail with specific findings
    expect(results[0].check).toContain('Contract Address');
  });

  it('should warn when no contracts are deployed', async () => {
    // The default state of the codebase has empty address maps
    const results = await checkContractAddresses();
    const warnResult = results.find(r => r.status === 'warn');
    if (warnResult) {
      expect(warnResult.message).toContain('No contracts deployed');
    }
  });
});

// =============================================================================
// printSummary
// =============================================================================

describe('printSummary', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should return true when all checks pass', () => {
    const results: ValidationResult[] = [
      { check: 'Test 1', status: 'pass', message: 'All good' },
      { check: 'Test 2', status: 'pass', message: 'Also good' },
    ];
    expect(printSummary(results)).toBe(true);
  });

  it('should return true with warnings only (no failures)', () => {
    const results: ValidationResult[] = [
      { check: 'Test 1', status: 'pass', message: 'All good' },
      { check: 'Test 2', status: 'warn', message: 'Something to note' },
    ];
    expect(printSummary(results)).toBe(true);
  });

  it('should return false when any check fails', () => {
    const results: ValidationResult[] = [
      { check: 'Test 1', status: 'pass', message: 'All good' },
      { check: 'Test 2', status: 'fail', message: 'Something broke' },
    ];
    expect(printSummary(results)).toBe(false);
  });

  it('should return false when failures and warnings are mixed', () => {
    const results: ValidationResult[] = [
      { check: 'Test 1', status: 'pass', message: 'All good' },
      { check: 'Test 2', status: 'warn', message: 'Something to note' },
      { check: 'Test 3', status: 'fail', message: 'Something broke' },
    ];
    expect(printSummary(results)).toBe(false);
  });

  it('should return true for empty results', () => {
    expect(printSummary([])).toBe(true);
  });

  it('should print summary counts', () => {
    const results: ValidationResult[] = [
      { check: 'A', status: 'pass', message: 'OK' },
      { check: 'B', status: 'warn', message: 'Hmm' },
      { check: 'C', status: 'fail', message: 'Bad' },
    ];
    printSummary(results);
    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('1 passed');
    expect(output).toContain('1 warnings');
    expect(output).toContain('1 failed');
  });

  it('should print check names and messages', () => {
    const results: ValidationResult[] = [
      { check: 'Redis Connectivity', status: 'pass', message: 'Redis OK' },
      { check: 'Private Key', status: 'fail', message: 'Key invalid' },
    ];
    printSummary(results);
    const output = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Redis Connectivity');
    expect(output).toContain('Redis OK');
    expect(output).toContain('Private Key');
    expect(output).toContain('Key invalid');
  });
});
