/**
 * Integration Test Utilities
 *
 * Provides helpers for TRUE integration tests that wire up real components
 * using redis-memory-server for isolated, repeatable tests.
 */

export { IntegrationTestHarness } from './harness';
export type { TestComponent } from './harness';

export {
  createTestRedisClient,
  flushTestRedis,
  waitForStreamMessage,
  publishToStream,
  ensureConsumerGroup,
} from './redis-helpers';

export {
  createTestPriceUpdate,
  createArbitrageScenario,
  createTestOpportunity,
  TEST_TOKENS,
  TEST_PAIRS,
} from './test-data';

export { waitFor, withTimeout, retryAsync } from './async-helpers';

export {
  RedisTestPool,
  IsolatedRedisClient,
  getRedisPool,
  shutdownRedisPool,
  warmupRedisPool,
} from './redis-pool';

export {
  createIsolatedContext,
  withIsolation,
  createParallelContexts,
  cleanupContexts,
} from './test-isolation';
export type { IsolatedTestContext } from './test-isolation';

export {
  waitForMessages,
  assertStreamContains,
  publishBatch,
  publishBatchWithResult,
  StreamCollector,
  createStreamCollector,
} from './stream-utils';
export type { StreamMessage, PublishBatchOptions, PublishBatchResult } from './stream-utils';
