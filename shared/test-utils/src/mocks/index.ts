/**
 * Mock Exports Index
 *
 * Centralized exports for all test mocks.
 */

export {
  RedisMock,
  createRedisMock,
  createInlineRedisMock,
  createIoredisMockModule,
  setupRedisMock
} from './redis.mock';

export type { RedisMockOptions, RedisOperation } from './redis.mock';

// Partition service mocks (P1-P4)
export {
  createMockLogger,
  createMockStateManager,
  MockUnifiedChainDetector,
  createCoreMocks,
  createConfigMocks,
  createMockPartitionDetector,
  createMockHealthServer,
  createMockPartitionEntry,
} from './partition-service.mock';

export type {
  MockLogger,
  MockStateManager,
  MockDetectorOptions,
  PartitionConfigOptions,
  CoreMocksOptions,
  MockPartitionDetectorOptions,
  MockPartitionDetector,
  MockHealthServer,
  MockPartitionEntryOptions,
  MockPartitionEntry,
} from './partition-service.mock';

// Shared mock factories (PerfLogger, ExecutionStateManager, RedisClient)
export {
  createMockPerfLogger,
  createMockExecutionStateManager,
  createMockRedisClient,
} from './mock-factories';

export type { MockRedisClient } from './mock-factories';

// Provider mocks (ethers.js)
export {
  createMockProvider,
  createMockWallet,
  createEthereumProvider,
  createBscProvider,
  createArbitrumProvider,
  createPolygonProvider,
  createMockContractCallResponse,
  resetMockProvider
} from './provider.mock';

export type {
  MockProviderOptions,
  MockWalletOptions,
  MockProvider
} from './provider.mock';

// Execution engine strategy mocks
export {
  createMockStrategyLogger,
  createMockStrategyProvider,
  createMockStrategyWallet,
  createMockStrategyOpportunity,
} from './execution-engine.mock';

export type { StrategyMockLogger } from './execution-engine.mock';
