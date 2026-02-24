#!/usr/bin/env tsx
/**
 * Pre-Deployment Validation Script
 *
 * Comprehensive checks to run before deploying the arbitrage system.
 * Validates infrastructure connectivity, configuration correctness,
 * and environment readiness.
 *
 * Usage:
 *   npm run validate:deployment
 *
 * Exit Codes:
 *   0 - All checks passed (warnings are acceptable)
 *   1 - One or more checks failed
 *
 * @see O-11: Pre-deployment validation
 * @see scripts/validate-mev-setup.ts (MEV config validation)
 * @see contracts/scripts/validate-router-config.ts (router validation)
 */

import { createConnection, Socket } from 'net';
import { existsSync } from 'fs';
import { resolve } from 'path';
import './lib/load-env';

// =============================================================================
// Types
// =============================================================================

export interface ValidationResult {
  check: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  details?: Record<string, unknown>;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Chain-to-env-var mapping for RPC URLs.
 * Matches the pattern used in shared/config/src/service-config.ts.
 */
const CHAIN_RPC_ENV_VARS: Record<string, string> = {
  ethereum: 'ETHEREUM_RPC_URL',
  arbitrum: 'ARBITRUM_RPC_URL',
  bsc: 'BSC_RPC_URL',
  base: 'BASE_RPC_URL',
  polygon: 'POLYGON_RPC_URL',
  optimism: 'OPTIMISM_RPC_URL',
  avalanche: 'AVALANCHE_RPC_URL',
  fantom: 'FANTOM_RPC_URL',
  zksync: 'ZKSYNC_RPC_URL',
  linea: 'LINEA_RPC_URL',
  solana: 'SOLANA_RPC_URL',
};

/**
 * L2 chains have lower expected gas prices.
 * L1 chains (ethereum) can have much higher gas.
 */
const L2_CHAINS = new Set([
  'arbitrum',
  'base',
  'optimism',
  'zksync',
  'linea',
]);

/**
 * Gas price warning thresholds in gwei.
 */
const GAS_THRESHOLDS = {
  l1: 100,   // >100 gwei on L1 is high
  l2: 1,     // >1 gwei on L2 is high
  bsc: 10,   // BSC has its own range
} as const;

// =============================================================================
// Validation Check Functions (exported for testing)
// =============================================================================

/**
 * Check Redis connectivity by attempting a TCP connection and sending PING.
 * Also checks Upstash REST URL if configured.
 */
export async function checkRedisConnectivity(): Promise<ValidationResult> {
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;

  // If Upstash is configured, validate its URL format
  if (upstashUrl) {
    if (!upstashUrl.startsWith('https://')) {
      return {
        check: 'Redis Connectivity',
        status: 'fail',
        message: 'UPSTASH_REDIS_REST_URL must use HTTPS',
        details: { provider: 'upstash' },
      };
    }

    const hasToken = !!process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!hasToken) {
      return {
        check: 'Redis Connectivity',
        status: 'fail',
        message: 'UPSTASH_REDIS_REST_TOKEN not set (required for Upstash)',
        details: { provider: 'upstash', url: upstashUrl },
      };
    }

    return {
      check: 'Redis Connectivity',
      status: 'pass',
      message: 'Upstash Redis REST URL and token configured',
      details: { provider: 'upstash' },
    };
  }

  // Parse Redis URL for TCP connection test
  let host = 'localhost';
  let port = 6379;
  try {
    const parsed = new URL(redisUrl);
    host = parsed.hostname || 'localhost';
    port = parseInt(parsed.port, 10) || 6379;
  } catch {
    return {
      check: 'Redis Connectivity',
      status: 'fail',
      message: `Invalid REDIS_URL format: cannot parse URL`,
      details: { url: redisUrl.replace(/\/\/.*@/, '//***@') }, // Mask password
    };
  }

  // Attempt TCP connection and PING
  const startTime = Date.now();
  try {
    const latencyMs = await tcpPing(host, port, 5000);
    return {
      check: 'Redis Connectivity',
      status: latencyMs > 100 ? 'warn' : 'pass',
      message: latencyMs > 100
        ? `Redis reachable but latency is high (${latencyMs}ms)`
        : `Redis reachable at ${host}:${port} (${latencyMs}ms)`,
      details: { host, port, latencyMs, provider: 'standard' },
    };
  } catch (error) {
    return {
      check: 'Redis Connectivity',
      status: 'fail',
      message: `Cannot connect to Redis at ${host}:${port}: ${error instanceof Error ? error.message : String(error)}`,
      details: { host, port, elapsedMs: Date.now() - startTime },
    };
  }
}

/**
 * Check RPC endpoint latency for each configured chain.
 * Sends eth_blockNumber and measures round-trip time.
 * Solana uses getSlot instead.
 */
export async function checkRpcEndpoints(): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  for (const [chain, envVar] of Object.entries(CHAIN_RPC_ENV_VARS)) {
    const rpcUrl = process.env[envVar];

    if (!rpcUrl) {
      // Skip unconfigured chains silently (not every chain needs to be configured)
      continue;
    }

    // Validate URL format
    if (!rpcUrl.startsWith('http://') && !rpcUrl.startsWith('https://')) {
      results.push({
        check: `RPC Endpoint: ${chain}`,
        status: 'fail',
        message: `${envVar} has invalid URL format (must start with http:// or https://)`,
        details: { chain, envVar },
      });
      continue;
    }

    const startTime = Date.now();
    try {
      const isSolana = chain === 'solana';
      const payload = isSolana
        ? { jsonrpc: '2.0', id: 1, method: 'getSlot' }
        : { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] };

      const response = await fetchWithTimeout(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, 10000);

      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        results.push({
          check: `RPC Endpoint: ${chain}`,
          status: 'fail',
          message: `RPC returned HTTP ${response.status} (${latencyMs}ms)`,
          details: { chain, envVar, latencyMs, httpStatus: response.status },
        });
        continue;
      }

      const data = await response.json() as { result?: unknown; error?: { message: string } };

      if (data.error) {
        results.push({
          check: `RPC Endpoint: ${chain}`,
          status: 'fail',
          message: `RPC error: ${data.error.message} (${latencyMs}ms)`,
          details: { chain, envVar, latencyMs, error: data.error.message },
        });
        continue;
      }

      results.push({
        check: `RPC Endpoint: ${chain}`,
        status: latencyMs > 500 ? 'warn' : 'pass',
        message: latencyMs > 500
          ? `${chain} RPC slow: ${latencyMs}ms (threshold: 500ms)`
          : `${chain} RPC OK (${latencyMs}ms)`,
        details: { chain, envVar, latencyMs, blockNumber: data.result },
      });
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      results.push({
        check: `RPC Endpoint: ${chain}`,
        status: 'fail',
        message: `${chain} RPC unreachable: ${error instanceof Error ? error.message : String(error)} (${latencyMs}ms)`,
        details: { chain, envVar, latencyMs },
      });
    }
  }

  // Warn if no RPC endpoints are configured at all
  if (results.length === 0) {
    results.push({
      check: 'RPC Endpoints',
      status: 'warn',
      message: 'No chain-specific RPC URLs configured. Set {CHAIN}_RPC_URL env vars.',
      details: { configuredChains: 0 },
    });
  }

  return results;
}

/**
 * Validate contract addresses from deployment addresses file.
 * Checks format (0x-prefixed, 40 hex chars) and non-zero.
 * Does NOT make on-chain calls.
 */
export async function checkContractAddresses(): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  try {
    // Dynamic import to handle potential module resolution issues
    const addresses = await import('../contracts/deployments/addresses');

    const addressMaps: Record<string, Record<string, string>> = {
      'FlashLoanArbitrage': addresses.FLASH_LOAN_CONTRACT_ADDRESSES ?? {},
      'MultiPathQuoter': addresses.MULTI_PATH_QUOTER_ADDRESSES ?? {},
      'PancakeSwapFlashArbitrage': addresses.PANCAKESWAP_FLASH_ARBITRAGE_ADDRESSES ?? {},
      'BalancerV2FlashArbitrage': addresses.BALANCER_V2_FLASH_ARBITRAGE_ADDRESSES ?? {},
      'SyncSwapFlashArbitrage': addresses.SYNCSWAP_FLASH_ARBITRAGE_ADDRESSES ?? {},
      'CommitRevealArbitrage': addresses.COMMIT_REVEAL_ARBITRAGE_ADDRESSES ?? {},
    };

    let totalContracts = 0;
    let validContracts = 0;
    let emptyMaps = 0;

    for (const [contractName, addressMap] of Object.entries(addressMaps)) {
      const entries = Object.entries(addressMap).filter(([_, addr]) => addr !== '');

      if (entries.length === 0) {
        emptyMaps++;
        continue;
      }

      for (const [chain, address] of entries) {
        totalContracts++;

        if (!isValidEthAddress(address)) {
          results.push({
            check: `Contract Address: ${contractName}`,
            status: 'fail',
            message: `Invalid address format for ${contractName}.${chain}: ${address}`,
            details: { contractName, chain, address },
          });
          continue;
        }

        if (address === '0x0000000000000000000000000000000000000000') {
          results.push({
            check: `Contract Address: ${contractName}`,
            status: 'fail',
            message: `Zero address for ${contractName}.${chain} (placeholder, not deployed)`,
            details: { contractName, chain },
          });
          continue;
        }

        validContracts++;
      }
    }

    if (totalContracts === 0) {
      results.push({
        check: 'Contract Addresses',
        status: 'warn',
        message: `No contracts deployed yet (${emptyMaps} address maps empty). Deploy contracts before production use.`,
        details: { totalContracts: 0, emptyMaps },
      });
    } else if (validContracts === totalContracts) {
      results.push({
        check: 'Contract Addresses',
        status: 'pass',
        message: `All ${validContracts} deployed contract addresses are valid`,
        details: { totalContracts, validContracts },
      });
    }
  } catch (error) {
    results.push({
      check: 'Contract Addresses',
      status: 'fail',
      message: `Failed to load contract addresses: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return results;
}

/**
 * Validate private key format without logging its value.
 */
export function checkPrivateKeyFormat(): ValidationResult {
  const privateKey = process.env.WALLET_PRIVATE_KEY;

  if (!privateKey) {
    return {
      check: 'Private Key Format',
      status: 'warn',
      message: 'WALLET_PRIVATE_KEY not set. Required for transaction execution.',
      details: { configured: false },
    };
  }

  // Validate format: 0x-prefixed, 64 hex chars
  const isValid = /^0x[0-9a-fA-F]{64}$/.test(privateKey);

  if (!isValid) {
    // Check common mistakes
    const issues: string[] = [];
    if (!privateKey.startsWith('0x')) {
      issues.push('missing 0x prefix');
    }
    const hexPart = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
    if (hexPart.length !== 64) {
      issues.push(`expected 64 hex chars after 0x, got ${hexPart.length}`);
    }
    if (!/^[0-9a-fA-F]*$/.test(hexPart)) {
      issues.push('contains non-hex characters');
    }

    return {
      check: 'Private Key Format',
      status: 'fail',
      message: `WALLET_PRIVATE_KEY has invalid format: ${issues.join(', ')}`,
      details: { configured: true, valid: false, issues },
    };
  }

  return {
    check: 'Private Key Format',
    status: 'pass',
    message: 'WALLET_PRIVATE_KEY format is valid (0x + 64 hex chars)',
    details: { configured: true, valid: true },
  };
}

/**
 * Validate mnemonic format (BIP-39: 12 or 24 words).
 * Phase 0 Item 4: Per-chain HD wallets support.
 */
export function checkMnemonicFormat(): ValidationResult {
  const mnemonic = process.env.WALLET_MNEMONIC;

  if (!mnemonic) {
    return {
      check: 'Mnemonic Format',
      status: 'warn',
      message: 'WALLET_MNEMONIC not set. Per-chain private keys will be used instead.',
      details: { configured: false },
    };
  }

  const words = mnemonic.trim().split(/\s+/);
  if (words.length !== 12 && words.length !== 24) {
    return {
      check: 'Mnemonic Format',
      status: 'fail',
      message: `WALLET_MNEMONIC has ${words.length} words (expected 12 or 24).`,
      details: { configured: true, valid: false, wordCount: words.length },
    };
  }

  return {
    check: 'Mnemonic Format',
    status: 'pass',
    message: `WALLET_MNEMONIC format valid (${words.length} words). HD wallets will be derived per-chain.`,
    details: { configured: true, valid: true, wordCount: words.length },
  };
}

/**
 * Check MEV provider configuration.
 * Validates Flashbots auth key, BloXroute header, and Fastlane URL.
 */
export function checkMevProviders(): ValidationResult[] {
  const results: ValidationResult[] = [];

  // Flashbots Auth Key
  const flashbotsKey = process.env.FLASHBOTS_AUTH_KEY;
  if (flashbotsKey) {
    const isValid = /^0x[0-9a-fA-F]{64}$/.test(flashbotsKey);
    results.push({
      check: 'MEV Provider: Flashbots',
      status: isValid ? 'pass' : 'fail',
      message: isValid
        ? 'FLASHBOTS_AUTH_KEY configured and valid format'
        : 'FLASHBOTS_AUTH_KEY has invalid format (expected 0x + 64 hex chars)',
      details: { configured: true, valid: isValid },
    });
  } else {
    results.push({
      check: 'MEV Provider: Flashbots',
      status: 'warn',
      message: 'FLASHBOTS_AUTH_KEY not set. Ethereum MEV protection will be limited.',
      details: { configured: false },
    });
  }

  // BloXroute Auth Header
  const bloxrouteHeader = process.env.BLOXROUTE_AUTH_HEADER;
  if (bloxrouteHeader) {
    results.push({
      check: 'MEV Provider: BloXroute',
      status: 'pass',
      message: 'BLOXROUTE_AUTH_HEADER configured',
      details: { configured: true },
    });
  } else {
    results.push({
      check: 'MEV Provider: BloXroute',
      status: 'warn',
      message: 'BLOXROUTE_AUTH_HEADER not set. BloXroute MEV protection unavailable.',
      details: { configured: false },
    });
  }

  // BloXroute URL
  const bloxrouteUrl = process.env.BLOXROUTE_URL;
  if (bloxrouteUrl) {
    if (!bloxrouteUrl.startsWith('https://')) {
      results.push({
        check: 'MEV Provider: BloXroute URL',
        status: 'warn',
        message: 'BLOXROUTE_URL should use HTTPS for production',
        details: { configured: true, isHttps: false },
      });
    }
  }

  // Fastlane URL
  const fastlaneUrl = process.env.FASTLANE_URL;
  if (fastlaneUrl) {
    const isHttps = fastlaneUrl.startsWith('https://');
    results.push({
      check: 'MEV Provider: Fastlane',
      status: isHttps ? 'pass' : 'warn',
      message: isHttps
        ? 'FASTLANE_URL configured with HTTPS'
        : 'FASTLANE_URL should use HTTPS for production',
      details: { configured: true, isHttps },
    });
  }

  // Global MEV toggle
  const mevEnabled = process.env.MEV_PROTECTION_ENABLED === 'true';
  if (!mevEnabled) {
    results.push({
      check: 'MEV Protection Toggle',
      status: 'warn',
      message: 'MEV_PROTECTION_ENABLED is not set to "true". All transactions use public mempool.',
      details: { enabled: false },
    });
  }

  return results;
}

/**
 * Check gas prices for chains with configured RPC endpoints.
 * Warns if gas price is unusually high.
 */
export async function checkGasPrices(): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  for (const [chain, envVar] of Object.entries(CHAIN_RPC_ENV_VARS)) {
    const rpcUrl = process.env[envVar];

    if (!rpcUrl || chain === 'solana') {
      // Skip unconfigured chains and Solana (no eth_gasPrice)
      continue;
    }

    try {
      const response = await fetchWithTimeout(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_gasPrice',
          params: [],
        }),
      }, 10000);

      if (!response.ok) continue;

      const data = await response.json() as { result?: string; error?: { message: string } };
      if (data.error || !data.result) continue;

      const gasPriceWei = BigInt(data.result);
      const gasPriceGwei = Number(gasPriceWei) / 1e9;

      let threshold: number;
      if (chain === 'ethereum') {
        threshold = GAS_THRESHOLDS.l1;
      } else if (chain === 'bsc') {
        threshold = GAS_THRESHOLDS.bsc;
      } else if (L2_CHAINS.has(chain)) {
        threshold = GAS_THRESHOLDS.l2;
      } else {
        threshold = GAS_THRESHOLDS.l1;
      }

      const isHigh = gasPriceGwei > threshold;
      results.push({
        check: `Gas Price: ${chain}`,
        status: isHigh ? 'warn' : 'pass',
        message: isHigh
          ? `${chain} gas price is high: ${gasPriceGwei.toFixed(2)} gwei (threshold: ${threshold} gwei)`
          : `${chain} gas price OK: ${gasPriceGwei.toFixed(2)} gwei`,
        details: { chain, gasPriceGwei: parseFloat(gasPriceGwei.toFixed(4)), threshold },
      });
    } catch {
      // Don't fail on gas price check - it's informational
      // The RPC endpoint check already covers connectivity
    }
  }

  return results;
}

/**
 * Check environment configuration files and production readiness.
 */
export function checkEnvironmentConfig(): ValidationResult[] {
  const results: ValidationResult[] = [];
  const projectRoot = resolve(__dirname, '..');

  // Check for .env or .env.local
  const hasEnv = existsSync(resolve(projectRoot, '.env'));
  const hasEnvLocal = existsSync(resolve(projectRoot, '.env.local'));

  if (!hasEnv && !hasEnvLocal) {
    results.push({
      check: 'Environment File',
      status: 'warn',
      message: 'Neither .env nor .env.local found. Run: npm run dev:setup',
      details: { hasEnv, hasEnvLocal },
    });
  } else {
    results.push({
      check: 'Environment File',
      status: 'pass',
      message: hasEnvLocal
        ? '.env.local found (takes priority over .env)'
        : '.env found',
      details: { hasEnv, hasEnvLocal },
    });
  }

  // Production warnings
  const nodeEnv = process.env.NODE_ENV;
  const isProduction = nodeEnv === 'production' ||
    process.env.FLY_APP_NAME !== undefined ||
    process.env.RAILWAY_ENVIRONMENT !== undefined ||
    process.env.RENDER_SERVICE_NAME !== undefined;

  if (isProduction) {
    // In production, check for critical env vars
    const redisUrl = process.env.REDIS_URL ?? '';
    const isLocalRedis = redisUrl.includes('localhost') || redisUrl.includes('127.0.0.1');

    if (isLocalRedis || !redisUrl) {
      results.push({
        check: 'Production: Redis',
        status: 'fail',
        message: 'Using localhost Redis in production environment. Set REDIS_URL to a production instance.',
        details: { nodeEnv, redisUrl: redisUrl ? 'localhost' : 'not set' },
      });
    }

    if (!process.env.WALLET_PRIVATE_KEY && !process.env.WALLET_MNEMONIC) {
      results.push({
        check: 'Production: Wallet',
        status: 'fail',
        message: 'No wallet credentials configured in production. Set WALLET_PRIVATE_KEY or WALLET_MNEMONIC.',
        details: { nodeEnv },
      });
    }
  } else {
    results.push({
      check: 'Environment Mode',
      status: 'pass',
      message: `Running in ${nodeEnv ?? 'development'} mode`,
      details: { nodeEnv: nodeEnv ?? 'development', isProduction },
    });
  }

  // Check Node.js version
  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0], 10);
  if (majorVersion < 22) {
    results.push({
      check: 'Node.js Version',
      status: 'fail',
      message: `Node.js ${nodeVersion} detected. Minimum required: >=22.0.0`,
      details: { nodeVersion, required: '>=22.0.0' },
    });
  } else {
    results.push({
      check: 'Node.js Version',
      status: 'pass',
      message: `Node.js ${nodeVersion} (meets >=22.0.0 requirement)`,
      details: { nodeVersion },
    });
  }

  return results;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * TCP ping to check host:port reachability.
 * Returns round-trip time in milliseconds.
 */
export function tcpPing(host: string, port: number, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const socket: Socket = createConnection({ host, port }, () => {
      const latency = Date.now() - startTime;
      socket.destroy();
      resolve(latency);
    });

    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`Connection timed out after ${timeoutMs}ms`));
    });
    socket.on('error', (err) => {
      socket.destroy();
      reject(err);
    });
  });
}

/**
 * Fetch with timeout support.
 * Uses AbortController for clean cancellation.
 */
export function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, { ...options, signal: controller.signal }).finally(() => {
    clearTimeout(timeoutId);
  });
}

/**
 * Validate Ethereum address format (0x + 40 hex chars).
 */
export function isValidEthAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

// =============================================================================
// Summary Generation
// =============================================================================

/**
 * Generate and print a summary table from all results.
 * Returns true if all checks passed (no failures).
 */
export function printSummary(results: ValidationResult[]): boolean {
  const passes = results.filter(r => r.status === 'pass');
  const warnings = results.filter(r => r.status === 'warn');
  const failures = results.filter(r => r.status === 'fail');

  console.log('\n' + '='.repeat(75));
  console.log('Pre-Deployment Validation Results');
  console.log('='.repeat(75) + '\n');

  // Group by status for cleaner output
  if (passes.length > 0) {
    console.log('[PASS] Checks Passed:\n');
    for (const result of passes) {
      console.log(`  [PASS] ${result.check}`);
      console.log(`         ${result.message}`);
    }
    console.log();
  }

  if (warnings.length > 0) {
    console.log('[WARN] Warnings:\n');
    for (const result of warnings) {
      console.log(`  [WARN] ${result.check}`);
      console.log(`         ${result.message}`);
    }
    console.log();
  }

  if (failures.length > 0) {
    console.log('[FAIL] Failures:\n');
    for (const result of failures) {
      console.log(`  [FAIL] ${result.check}`);
      console.log(`         ${result.message}`);
    }
    console.log();
  }

  // Summary line
  console.log('='.repeat(75));
  console.log(
    `Summary: ${passes.length} passed | ${warnings.length} warnings | ${failures.length} failed`
  );
  console.log('='.repeat(75));

  if (failures.length > 0) {
    console.log('\n[FAIL] Validation FAILED. Fix failures above before deploying.\n');
    return false;
  }

  if (warnings.length > 0) {
    console.log('\n[WARN] Validation PASSED with warnings. Review before deploying.\n');
    return true;
  }

  console.log('\n[PASS] All validation checks passed!\n');
  return true;
}

// =============================================================================
// Main Execution
// =============================================================================

/**
 * Run all validation checks and return collected results.
 * Exported for testing.
 */
export async function runAllChecks(): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  // 1. Environment configuration (sync, fast)
  results.push(...checkEnvironmentConfig());

  // 2. Private key format (sync, fast)
  results.push(checkPrivateKeyFormat());

  // 3. Mnemonic format (sync, fast)
  results.push(checkMnemonicFormat());

  // 4. MEV providers (sync, fast)
  results.push(...checkMevProviders());

  // 5. Redis connectivity (async, may timeout)
  results.push(await checkRedisConnectivity());

  // 6. Contract addresses (async import)
  results.push(...await checkContractAddresses());

  // 7. RPC endpoint latency (async, network calls)
  results.push(...await checkRpcEndpoints());

  // 8. Gas price sanity (async, network calls)
  results.push(...await checkGasPrices());

  return results;
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  try {
    console.log('Running pre-deployment validation checks...\n');

    const results = await runAllChecks();
    const allPassed = printSummary(results);

    process.exit(allPassed ? 0 : 1);
  } catch (error) {
    console.error('\n[FAIL] Error running validation script:');
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Run if executed directly (not when imported for testing)
if (require.main === module) {
  main();
}
