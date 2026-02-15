/**
 * Shared test helpers for Solana detector module tests.
 *
 * Provides reusable mock factories and test data builders
 * for all module test files.
 */

import type { SolanaPool, SolanaTokenInfo, SolanaPriceUpdate } from '../../../src/solana/solana-types';

// =============================================================================
// Logger Mocks
// =============================================================================

export const createMockLogger = () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
});

export const createMockPerfLogger = () => ({
  logHealthCheck: jest.fn(),
  logEventLatency: jest.fn(),
  logArbitrageOpportunity: jest.fn()
});

// =============================================================================
// Redis Mocks
// =============================================================================

export const createMockRedisClient = () => ({
  ping: jest.fn().mockResolvedValue('PONG'),
  disconnect: jest.fn().mockResolvedValue(undefined),
  updateServiceHealth: jest.fn().mockResolvedValue(undefined)
});

export const createMockStreamsClient = () => ({
  disconnect: jest.fn().mockResolvedValue(undefined),
  createBatcher: jest.fn().mockReturnValue(createMockBatcher())
});

// =============================================================================
// Batcher Mock
// =============================================================================

export const createMockBatcher = () => ({
  add: jest.fn(),
  destroy: jest.fn().mockResolvedValue(undefined),
  getStats: jest.fn().mockReturnValue({ currentQueueSize: 0, batchesSent: 0 })
});

// =============================================================================
// Connection Mock
// =============================================================================

export const createMockConnection = (overrides?: {
  getSlotValue?: number;
  shouldFail?: boolean;
}) => ({
  getSlot: overrides?.shouldFail
    ? jest.fn().mockRejectedValue(new Error('RPC error'))
    : jest.fn().mockResolvedValue(overrides?.getSlotValue ?? 200000000),
  onProgramAccountChange: jest.fn().mockReturnValue(1),
  removeProgramAccountChangeListener: jest.fn().mockResolvedValue(undefined),
  rpcEndpoint: 'https://api.mainnet-beta.solana.com',
});

// =============================================================================
// Pool Test Data
// =============================================================================

const DEFAULT_TOKEN0: SolanaTokenInfo = {
  mint: 'So11111111111111111111111111111111111111112',
  symbol: 'SOL',
  decimals: 9
};

const DEFAULT_TOKEN1: SolanaTokenInfo = {
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  symbol: 'USDC',
  decimals: 6
};

export const createTestPool = (overrides?: Partial<SolanaPool>): SolanaPool => ({
  address: 'TestPoolAddr111111111111111111111111111111111',
  programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  dex: 'raydium',
  token0: DEFAULT_TOKEN0,
  token1: DEFAULT_TOKEN1,
  fee: 25,
  ...overrides
});

export const createTestPriceUpdate = (overrides?: Partial<SolanaPriceUpdate>): SolanaPriceUpdate => ({
  poolAddress: 'TestPoolAddr111111111111111111111111111111111',
  dex: 'raydium',
  token0: DEFAULT_TOKEN0.mint,
  token1: DEFAULT_TOKEN1.mint,
  price: 103.45,
  reserve0: '1000000000',
  reserve1: '100000000',
  slot: 200000001,
  timestamp: Date.now(),
  ...overrides
});

// =============================================================================
// Lifecycle Mock
// =============================================================================

export const createMockLifecycle = () => ({
  isRunning: jest.fn().mockReturnValue(true),
  isStopping: jest.fn().mockReturnValue(false)
});
