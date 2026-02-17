/**
 * Test Environment Setup
 *
 * Provides isolated environment variable management for tests.
 * Prevents environment leakage between test files.
 *
 * @see ADR-009: Test Architecture
 */

// Store original environment
const originalEnv: NodeJS.ProcessEnv = { ...process.env };

/**
 * Test environment configuration
 */
export interface TestEnvironment {
  // Redis
  REDIS_URL: string;
  REDIS_HOST: string;
  REDIS_PORT: string;

  // Node
  NODE_ENV: string;
  LOG_LEVEL: string;

  // RPC URLs - Ethereum ecosystem
  ETHEREUM_RPC_URL: string;
  ETHEREUM_WS_URL: string;
  ARBITRUM_RPC_URL: string;
  ARBITRUM_WS_URL: string;
  OPTIMISM_RPC_URL: string;
  OPTIMISM_WS_URL: string;
  BASE_RPC_URL: string;
  BASE_WS_URL: string;

  // RPC URLs - Other chains
  BSC_RPC_URL: string;
  BSC_WS_URL: string;
  POLYGON_RPC_URL: string;
  POLYGON_WS_URL: string;
  AVALANCHE_RPC_URL: string;
  AVALANCHE_WS_URL: string;
  FANTOM_RPC_URL: string;
  FANTOM_WS_URL: string;
  ZKSYNC_RPC_URL: string;
  ZKSYNC_WS_URL: string;
  LINEA_RPC_URL: string;
  LINEA_WS_URL: string;
  SOLANA_RPC_URL: string;
  SOLANA_WS_URL: string;

  // Allow additional keys
  [key: string]: string;
}

/**
 * Default test environment values
 */
const defaultTestEnv: TestEnvironment = {
  // Redis - uses memory server by default
  REDIS_URL: 'redis://localhost:6379',
  REDIS_HOST: 'localhost',
  REDIS_PORT: '6379',

  // Node
  NODE_ENV: 'test',
  LOG_LEVEL: 'error', // Minimize logging in tests

  // Ethereum ecosystem (use test URLs)
  ETHEREUM_RPC_URL: 'https://eth-mainnet.test/v3/test',
  ETHEREUM_WS_URL: 'wss://eth-mainnet.test/ws/v3/test',
  ARBITRUM_RPC_URL: 'https://arb-mainnet.test/rpc',
  ARBITRUM_WS_URL: 'wss://arb-mainnet.test/feed',
  OPTIMISM_RPC_URL: 'https://optimism-mainnet.test/rpc',
  OPTIMISM_WS_URL: 'wss://optimism-mainnet.test/feed',
  BASE_RPC_URL: 'https://base-mainnet.test/rpc',
  BASE_WS_URL: 'wss://base-mainnet.test/feed',

  // Other chains
  BSC_RPC_URL: 'https://bsc-dataseed.test',
  BSC_WS_URL: 'wss://bsc-ws.test',
  POLYGON_RPC_URL: 'https://polygon-rpc.test',
  POLYGON_WS_URL: 'wss://polygon-ws.test',
  AVALANCHE_RPC_URL: 'https://avalanche-c.test/rpc',
  AVALANCHE_WS_URL: 'wss://avalanche-c.test/ws',
  FANTOM_RPC_URL: 'https://fantom-rpc.test',
  FANTOM_WS_URL: 'wss://fantom-ws.test',
  ZKSYNC_RPC_URL: 'https://zksync-mainnet.test',
  ZKSYNC_WS_URL: 'wss://zksync-mainnet.test/ws',
  LINEA_RPC_URL: 'https://linea-mainnet.test',
  LINEA_WS_URL: 'wss://linea-mainnet.test/ws',
  SOLANA_RPC_URL: 'https://solana-mainnet.test',
  SOLANA_WS_URL: 'wss://solana-mainnet.test/ws'
};

/**
 * Setup test environment with default values and optional overrides
 */
export function setupTestEnv(overrides: Partial<TestEnvironment> = {}): void {
  const env = { ...defaultTestEnv, ...overrides };

  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
}

/**
 * Restore original environment (call in afterAll)
 */
export function restoreEnv(): void {
  // Clear test env vars
  for (const key of Object.keys(defaultTestEnv)) {
    delete process.env[key];
  }

  // Restore original values
  Object.assign(process.env, originalEnv);
}

/**
 * Get a test environment variable
 */
export function getTestEnv(key: keyof TestEnvironment): string {
  return process.env[key] ?? defaultTestEnv[key] ?? '';
}

/**
 * Execute a function with temporary environment changes
 */
export async function withEnv<T>(
  envOverrides: Partial<TestEnvironment>,
  fn: () => T | Promise<T>
): Promise<T> {
  const backup: Partial<NodeJS.ProcessEnv> = {};

  // Backup current values
  for (const key of Object.keys(envOverrides)) {
    backup[key] = process.env[key];
  }

  // Apply overrides
  for (const [key, value] of Object.entries(envOverrides)) {
    process.env[key] = value;
  }

  try {
    const result = fn();
    return result instanceof Promise ? await result : result;
  } finally {
    // Restore backup
    for (const [key, value] of Object.entries(backup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/**
 * Update Redis connection from config file (used by global setup)
 */
export function updateRedisEnvFromConfig(config: {
  host: string;
  port: number;
  url: string;
}): void {
  process.env.REDIS_HOST = config.host;
  process.env.REDIS_PORT = String(config.port);
  process.env.REDIS_URL = config.url;
}

/**
 * Check if running in CI environment
 */
export function isCI(): boolean {
  return process.env.CI === 'true' || !!process.env.GITHUB_ACTIONS;
}

/**
 * Check if debug mode is enabled
 */
export function isDebugMode(): boolean {
  return process.env.DEBUG_TESTS === 'true';
}
