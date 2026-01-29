/**
 * Mock Exports Index
 *
 * Centralized exports for all test mocks.
 */

export {
  RedisMock,
  createRedisMock,
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
  createUnifiedDetectorMocks,
  createMockHttpServer,
  setupPartitionTestEnv,
  cleanupPartitionTestEnv,
} from './partition-service.mock';

export type {
  MockLogger,
  MockStateManager,
  MockDetectorOptions,
  PartitionConfigOptions,
  MockHttpServer,
} from './partition-service.mock';

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
