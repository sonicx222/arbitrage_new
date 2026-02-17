/**
 * Test Utilities for Arbitrage System
 *
 * Provides mocks, fixtures, factories, and helpers for comprehensive testing.
 *
 * ## Usage
 *
 * ```typescript
 * import {
 *   // Mocks
 *   RedisMock, createRedisMock,
 *
 *   // Factories (new, preferred)
 *   swapEvent, createSwapEvent, createSwapBatch,
 *   priceUpdate, createPriceUpdate,
 *
 *   // Setup utilities
 *   setupTestEnv, resetAllSingletons,
 *
 *   // Legacy helpers (still supported)
 *   delay, createMockPriceUpdate, createMockSwapEvent
 * } from '@arbitrage/test-utils';
 * ```
 *
 * @see ADR-009: Test Architecture
 */

import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// Environment Setup (runs at import time for backward compatibility)
// =============================================================================

// Load Redis test server config if available (from jest.globalSetup.ts)
const REDIS_CONFIG_FILE = path.join(__dirname, '../../../.redis-test-config.json');
if (fs.existsSync(REDIS_CONFIG_FILE)) {
  try {
    const config = JSON.parse(fs.readFileSync(REDIS_CONFIG_FILE, 'utf8'));
    process.env.REDIS_HOST = config.host;
    process.env.REDIS_PORT = String(config.port);
    process.env.REDIS_URL = config.url;
    if (process.env.DEBUG_TESTS === 'true') {
      console.log(`[Test Setup] Using Redis test server at ${config.url}`);
    }
  } catch (error) {
    if (process.env.DEBUG_TESTS === 'true') {
      console.warn('[Test Setup] Failed to load Redis config file:', error);
    }
  }
}

// Set required environment variables before any imports
// These are needed by shared/config/src/index.ts which validates at module load time
process.env.ETHEREUM_RPC_URL = process.env.ETHEREUM_RPC_URL || 'https://mainnet.infura.io/v3/test';
process.env.ETHEREUM_WS_URL = process.env.ETHEREUM_WS_URL || 'wss://mainnet.infura.io/ws/v3/test';
process.env.ARBITRUM_RPC_URL = process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc';
process.env.ARBITRUM_WS_URL = process.env.ARBITRUM_WS_URL || 'wss://arb1.arbitrum.io/feed';
process.env.BSC_RPC_URL = process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org';
process.env.BSC_WS_URL = process.env.BSC_WS_URL || 'wss://bsc-ws-node.nariox.org:443';
process.env.POLYGON_RPC_URL = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
process.env.POLYGON_WS_URL = process.env.POLYGON_WS_URL || 'wss://polygon-rpc.com';
process.env.OPTIMISM_RPC_URL = process.env.OPTIMISM_RPC_URL || 'https://mainnet.optimism.io';
process.env.OPTIMISM_WS_URL = process.env.OPTIMISM_WS_URL || 'wss://mainnet.optimism.io';
process.env.BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
process.env.BASE_WS_URL = process.env.BASE_WS_URL || 'wss://mainnet.base.org';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// =============================================================================
// Re-exports from New Modular Structure
// =============================================================================

// Mocks
export * from './mocks';

// Factories (new, preferred API)
export * from './factories';

// Setup utilities
export * from './setup';

// Redis Test Helper (Task 2.2: Test Isolation)
export * from './redis-test-helper';

// Integration Testing Patterns (Three-Level Strategy)
export * from './integration-patterns';

// Timer Helpers (P2-TEST: Standardize timer management)
export * from './helpers';

// Partition Test Factory (parameterized test generation for P1-P4)
export * from './partition-test-factory';

// Price Data Generators (Phase 3, Task 3.1)
export * from './generators';

// Cache & Worker Testing Infrastructure (Phase 1: Foundation)
// Fixtures for test data generation
// Note: Selective export to avoid PriceUpdate conflict with factories
export { CacheStateConfig, CacheFixtures } from './fixtures/cache-fixtures';
export * from './fixtures/worker-fixtures';
export * from './fixtures/performance-fixtures';

// Builders for fluent test object construction
export * from './builders/cache-state.builder';

// Test harnesses for integration testing
export * from './harnesses/cache-test.harness';
export * from './harnesses/worker-test.harness';
export * from './harnesses/load-test.harness';

// Cache testing types
export * from './types/cache-types';

// Integration Test Utilities (Phase 1: Test Infrastructure Setup)
// Note: Using selective exports to avoid naming conflicts with existing modules
export {
  // Harness
  IntegrationTestHarness,
  // Redis helpers
  createTestRedisClient,
  flushTestRedis,
  waitForStreamMessage,
  publishToStream,
  ensureConsumerGroup,
  // Test data
  createTestPriceUpdate,
  createArbitrageScenario,
  createTestOpportunity,
  TEST_TOKENS,
  TEST_PAIRS,
  // Async helpers (renamed to avoid conflict with integration-patterns)
  withTimeout,
  retryAsync,
  // Redis pool
  RedisTestPool,
  getRedisPool,
  shutdownRedisPool,
  warmupRedisPool,
  // Test isolation (renamed to avoid conflict with redis-test-helper)
  createIsolatedContext,
  withIsolation,
  createParallelContexts,
  cleanupContexts,
  // Stream utils
  waitForMessages,
  assertStreamContains,
  publishBatch,
  publishBatchWithResult,
  StreamCollector,
  createStreamCollector,
} from './integration';
export type {
  TestComponent,
  IsolatedTestContext,
} from './integration';
// Re-export with different names to avoid conflicts
export { waitFor as waitForIntegration } from './integration';
export { IsolatedRedisClient as IntegrationRedisClient } from './integration';
export type { StreamMessage as IntegrationStreamMessage } from './integration';

// =============================================================================
// Legacy Exports (kept for backward compatibility — used by integration tests)
// =============================================================================

const mockTokens = {
  WETH: {
    name: 'Wrapped Ether',
    symbol: 'WETH',
    address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    decimals: 18,
    chain: 'ethereum'
  },
  USDC: {
    name: 'USD Coin',
    symbol: 'USDC',
    address: '0xA0b86a33e6fb38c74e6f8f3f8e8b8a2b2b2b2b2',
    decimals: 6,
    chain: 'ethereum'
  },
  WBNB: {
    name: 'Wrapped BNB',
    symbol: 'WBNB',
    address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    decimals: 18,
    chain: 'bsc'
  },
  BUSD: {
    name: 'Binance USD',
    symbol: 'BUSD',
    address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
    decimals: 18,
    chain: 'bsc'
  }
};

export const mockPriceUpdate = {
  dex: 'uniswap_v3',
  chain: 'ethereum',
  pair: 'WETH/USDC',
  pairAddress: '0x1234567890123456789012345678901234567890',
  token0: mockTokens.WETH.address,
  token1: mockTokens.USDC.address,
  price0: 1800.0, // WETH price in USDC
  price1: 0.000555, // USDC price in WETH
  timestamp: Date.now(),
  blockNumber: 18500000
};

export const mockSwapEvent = {
  dex: 'uniswap_v3',
  chain: 'ethereum',
  pair: 'WETH/USDC',
  pairAddress: '0x1234567890123456789012345678901234567890',
  sender: '0xabcdef1234567890abcdef1234567890abcdef12',
  to: '0x1234567890abcdef1234567890abcdef12345678',
  amount0In: 1.0,
  amount1In: 0.0,
  amount0Out: 0.0,
  amount1Out: 1800.0,
  timestamp: Date.now(),
  blockNumber: 18500000
};

export function createMockPriceUpdate(overrides: Partial<typeof mockPriceUpdate> = {}): any {
  return { ...mockPriceUpdate, ...overrides };
}

export function createMockSwapEvent(overrides: Partial<typeof mockSwapEvent> = {}): any {
  return { ...mockSwapEvent, ...overrides };
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
