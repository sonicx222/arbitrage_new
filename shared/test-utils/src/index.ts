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
 *   delay, generateRandomAddress, measurePerformance
 * } from '@arbitrage/test-utils';
 * ```
 *
 * @see docs/TEST_ARCHITECTURE.md
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

// Contract Testing (P3-4: Contract Testing)
export * from './contracts';

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
// Legacy Exports (kept for backward compatibility)
// =============================================================================

import { jest } from '@jest/globals';

// Mock implementations
export class RedisMock {
  private data: Map<string, any> = new Map();
  private pubSubChannels: Map<string, Set<Function>> = new Map();

  async get(key: string): Promise<any> {
    return this.data.get(key) || null;
  }

  async set(key: string, value: any): Promise<void> {
    this.data.set(key, value);
  }

  async setex(key: string, ttl: number, value: any): Promise<void> {
    this.data.set(key, value);
    // In real implementation, would set TTL
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.data.delete(key)) deleted++;
    }
    return deleted;
  }

  async exists(key: string): Promise<boolean> {
    return this.data.has(key);
  }

  async publish(channel: string, message: any): Promise<number> {
    const subscribers = this.pubSubChannels.get(channel);
    if (subscribers) {
      const serializedMessage = typeof message === 'string' ? message : JSON.stringify(message);
      subscribers.forEach(callback => {
        try {
          callback(null, serializedMessage);
        } catch (error) {
          console.error('Mock pub/sub callback error:', error);
        }
      });
      return subscribers.size;
    }
    return 0;
  }

  async subscribe(channel: string, callback: Function): Promise<void> {
    if (!this.pubSubChannels.has(channel)) {
      this.pubSubChannels.set(channel, new Set());
    }
    this.pubSubChannels.get(channel)!.add(callback);
  }

  async unsubscribe(channel: string, callback?: Function): Promise<void> {
    if (callback) {
      this.pubSubChannels.get(channel)?.delete(callback);
    } else {
      this.pubSubChannels.delete(channel);
    }
  }

  async keys(pattern: string): Promise<string[]> {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return Array.from(this.data.keys()).filter(key => regex.test(key));
  }

  async hset(key: string, field: string, value: any): Promise<number> {
    const hash = this.data.get(key) || {};
    const oldValue = hash[field];
    hash[field] = value;
    this.data.set(key, hash);
    return oldValue ? 0 : 1;
  }

  async hget(key: string, field: string): Promise<any> {
    const hash = this.data.get(key);
    return hash ? hash[field] : null;
  }

  async hgetall(key: string): Promise<any> {
    return this.data.get(key) || {};
  }

  async lpush(key: string, value: any): Promise<number> {
    const list = this.data.get(key) || [];
    list.unshift(value);
    this.data.set(key, list);
    return list.length;
  }

  async lrange(key: string, start: number, end: number): Promise<any[]> {
    const list = this.data.get(key) || [];
    return list.slice(start, end + 1);
  }

  async ltrim(key: string, start: number, end: number): Promise<void> {
    const list = this.data.get(key) || [];
    const trimmed = list.slice(start, end + 1);
    this.data.set(key, trimmed);
  }

  async llen(key: string): Promise<number> {
    const list = this.data.get(key) || [];
    return list.length;
  }

  async rpop(key: string): Promise<any> {
    const list = this.data.get(key) || [];
    return list.pop();
  }

  async expire(key: string, ttl: number): Promise<number> {
    // Mock TTL - in real implementation would set expiration
    return 1;
  }

  async ping(): Promise<boolean> {
    return true; // Simplified for mock
  }

  async disconnect(): Promise<void> {
    this.data.clear();
    this.pubSubChannels.clear();
  }

  // Test helpers
  getData(): Map<string, any> {
    return new Map(this.data);
  }

  clear(): void {
    this.data.clear();
    this.pubSubChannels.clear();
  }
}

export class BlockchainMock {
  private blocks: Map<number, any> = new Map();
  private transactions: Map<string, any> = new Map();
  private logs: any[] = [];
  private networkFailure = false;

  // Provider mock
  async getBlockNumber(): Promise<number> {
    if (this.networkFailure) throw new Error('Network failure');
    return Math.floor(Date.now() / 1000);
  }

  async getBlock(blockNumber: number): Promise<any> {
    if (this.networkFailure) throw new Error('Network failure');
    return this.blocks.get(blockNumber) || {
      number: blockNumber,
      timestamp: Date.now(),
      transactions: []
    };
  }

  async getTransaction(hash: string): Promise<any> {
    if (this.networkFailure) throw new Error('Network failure');
    return this.transactions.get(hash) || null;
  }

  async getLogs(filter: any): Promise<any[]> {
    if (this.networkFailure) throw new Error('Network failure');
    return this.logs.filter(log =>
      (!filter.address || log.address === filter.address) &&
      (!filter.fromBlock || log.blockNumber >= filter.fromBlock) &&
      (!filter.toBlock || log.blockNumber <= filter.toBlock)
    );
  }

  // Test helpers
  addBlock(block: any): void {
    this.blocks.set(block.number, block);
  }

  addTransaction(tx: any): void {
    this.transactions.set(tx.hash, tx);
  }

  addLog(log: any): void {
    this.logs.push(log);
  }

  setNetworkFailure(failure: boolean): void {
    this.networkFailure = failure;
  }

  clear(): void {
    this.blocks.clear();
    this.transactions.clear();
    this.logs.length = 0;
    this.networkFailure = false;
  }
}

export class WebSocketMock {
  private listeners: Map<string, Function[]> = new Map();
  private readyState = 1; // OPEN
  private sentMessages: any[] = [];

  constructor(url?: string) {
    // Mock connection
    setTimeout(() => {
      this.emit('open');
    }, 10);
  }

  addEventListener(event: string, listener: Function): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(listener);
  }

  removeEventListener(event: string, listener: Function): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      const index = listeners.indexOf(listener);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    }
  }

  send(message: any): void {
    this.sentMessages.push(message);
  }

  close(): void {
    this.readyState = 3; // CLOSED
    this.emit('close', { code: 1000, reason: 'Normal closure' });
  }

  private emit(event: string, ...args: any[]): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      listeners.forEach(listener => {
        try {
          listener(...args);
        } catch (error) {
          console.error('Mock WebSocket listener error:', error);
        }
      });
    }
  }

  // Test helpers
  getSentMessages(): any[] {
    return [...this.sentMessages];
  }

  simulateMessage(message: any): void {
    this.emit('message', { data: JSON.stringify(message) });
  }

  simulateError(error: any): void {
    this.emit('error', error);
  }

  getReadyState(): number {
    return this.readyState;
  }

  clear(): void {
    this.listeners.clear();
    this.sentMessages.length = 0;
    this.readyState = 1;
  }
}

// Test fixtures
export const mockTokens = {
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
    address: '0xA0b86a33e6fb38c74e6f8f3f8e8b8a2b2b2b2b2b2',
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

export const mockDexes = {
  uniswap: {
    name: 'uniswap_v3',
    chain: 'ethereum',
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    fee: 0.003,
    enabled: true
  },
  pancakeswap: {
    name: 'pancakeswap',
    chain: 'bsc',
    factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
    fee: 0.0025,
    enabled: true
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

export const mockArbitrageOpportunity = {
  id: 'arb_eth_1234567890_abcdef',
  sourceChain: 'ethereum',
  targetChain: 'ethereum',
  sourceDex: 'uniswap_v3',
  targetDex: 'sushiswap',
  tokenAddress: mockTokens.WETH.address,
  amount: 1.0,
  priceDifference: 5.0,
  percentageDifference: 0.28,
  estimatedProfit: 2.5,
  gasCost: 0.01,
  netProfit: 2.49,
  confidence: 0.85,
  timestamp: Date.now(),
  expiresAt: Date.now() + 300000 // 5 minutes
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

// Test helpers
export function createMockPriceUpdate(overrides: Partial<typeof mockPriceUpdate> = {}): any {
  return { ...mockPriceUpdate, ...overrides };
}

export function createMockArbitrageOpportunity(overrides: Partial<typeof mockArbitrageOpportunity> = {}): any {
  return { ...mockArbitrageOpportunity, ...overrides };
}

export function createMockSwapEvent(overrides: Partial<typeof mockSwapEvent> = {}): any {
  return { ...mockSwapEvent, ...overrides };
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function generateRandomAddress(): string {
  return '0x' + Math.random().toString(16).substr(2, 40);
}

export function generateRandomHash(): string {
  return '0x' + Math.random().toString(16).substr(2, 64);
}

// Performance testing helpers
export async function measurePerformance<T>(
  operation: () => Promise<T>,
  iterations: number = 100
): Promise<{
  result: T;
  averageTime: number;
  minTime: number;
  maxTime: number;
  totalTime: number;
}> {
  const times: number[] = [];

  let result: T;
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    result = await operation();
    const end = performance.now();
    times.push(end - start);
  }

  return {
    result: result!,
    averageTime: times.reduce((a, b) => a + b, 0) / times.length,
    minTime: Math.min(...times),
    maxTime: Math.max(...times),
    totalTime: times.reduce((a, b) => a + b, 0)
  };
}

// Memory usage monitoring
export function getMemoryUsage(): NodeJS.MemoryUsage {
  return process.memoryUsage();
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

// Test environment setup
export class TestEnvironment {
  private redis: RedisMock;
  private blockchain: BlockchainMock;
  private services: Map<string, any> = new Map();

  constructor() {
    this.redis = new RedisMock();
    this.blockchain = new BlockchainMock();
  }

  static async create(): Promise<TestEnvironment> {
    const env = new TestEnvironment();
    await env.initialize();
    return env;
  }

  private async initialize(): Promise<void> {
    // Setup mock data
    await this.setupMockData();
  }

  private async setupMockData(): Promise<void> {
    // Setup initial price data
    await this.redis.set('price:WETH/USDC:uniswap', JSON.stringify({
      price: 1800,
      timestamp: Date.now(),
      volume: 1000000
    }));

    await this.redis.set('price:WETH/USDC:sushiswap', JSON.stringify({
      price: 1795,
      timestamp: Date.now(),
      volume: 500000
    }));

    // Setup mock blockchain logs
    this.blockchain.addLog({
      address: '0x1234567890123456789012345678901234567890',
      topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'],
      data: '0x0000000000000000000000000000000000000000000000000de0b6b3a7640000',
      blockNumber: 18500000,
      transactionHash: generateRandomHash()
    });
  }

  async startService(serviceName: string, serviceClass: any, config?: any): Promise<any> {
    const service = new serviceClass(config);
    await service.start();
    this.services.set(serviceName, service);
    return service;
  }

  async stopService(serviceName: string): Promise<void> {
    const service = this.services.get(serviceName);
    if (service && service.stop) {
      await service.stop();
    }
    this.services.delete(serviceName);
  }

  async setupArbitrageOpportunity(): Promise<void> {
    // Setup price difference that creates arbitrage opportunity
    await this.redis.set('price:WETH/USDC:uniswap', JSON.stringify({
      price: 1800,
      timestamp: Date.now(),
      volume: 1000000
    }));

    await this.redis.set('price:WETH/USDC:sushiswap', JSON.stringify({
      price: 1790, // 10 USD difference
      timestamp: Date.now(),
      volume: 500000
    }));
  }

  async waitForOpportunity(timeout: number = 5000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timeout waiting for opportunity'));
      }, timeout);

      // Listen for arbitrage opportunity
      this.redis.subscribe('arbitrage-opportunity', (message: string) => {
        clearTimeout(timer);
        resolve(JSON.parse(message));
      });
    });
  }

  async executeArbitrage(opportunity: any): Promise<any> {
    // Mock arbitrage execution
    return {
      success: Math.random() > 0.1, // 90% success rate
      profit: opportunity.netProfit * (Math.random() * 0.2 + 0.9), // 90-110% of expected
      gasUsed: Math.floor(Math.random() * 200000 + 100000),
      executionTime: Math.floor(Math.random() * 5000 + 2000)
    };
  }

  getRedis(): RedisMock {
    return this.redis;
  }

  getBlockchain(): BlockchainMock {
    return this.blockchain;
  }

  async cleanup(): Promise<void> {
    for (const [name, service] of this.services.entries()) {
      await this.stopService(name);
    }

    this.redis.clear();
    this.blockchain.clear();
  }
}