/**
 * Test Setup Exports Index
 *
 * Centralized exports for all test setup utilities.
 */

export {
  setupTestEnv,
  restoreEnv,
  getTestEnv,
  withEnv,
  updateRedisEnvFromConfig,
  isCI,
  isDebugMode
} from './env-setup';

export type { TestEnvironment } from './env-setup';

export {
  registerSingletonReset,
  unregisterSingletonReset,
  resetAllSingletons,
  getRegisteredSingletons,
  clearRegisteredSingletons,
  initializeSingletonResets,
  createSingletonResetter
} from './singleton-reset';

// Note: jest-setup.ts is not exported as it's meant to be used via setupFilesAfterEnv
