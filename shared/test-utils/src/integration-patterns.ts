/**
 * Integration Testing Patterns
 *
 * Provides utilities for the three-level integration testing strategy.
 * All levels use REAL in-memory Redis (no mocks).
 *
 * **Three Levels**:
 * - Level 1 (Component): Internal component integration with real Redis, mock external APIs
 * - Level 2 (Service): Full service integration with real Redis, minimal mocking
 * - Level 3 (System E2E): Complete end-to-end flows with all real dependencies
 *
 * @see docs/architecture/TEST_ARCHITECTURE.md - Three-Level Integration Testing
 */

import { createIsolatedRedisClient, cleanupTestRedis, IsolatedRedisClient } from './redis-test-helper';

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for Level 1 (Component Integration) tests
 */
export interface Level1TestConfig {
  /** Unique name for this test suite (used for Redis DB isolation) */
  testSuiteName: string;
  /** Optional Redis connection URL (defaults to test server) */
  redisUrl?: string;
}

/**
 * Level 1 test setup result
 */
export interface Level1TestSetup {
  /** Isolated Redis client for this test suite */
  redis: IsolatedRedisClient;
  /** Cleanup function to call in afterAll() */
  cleanup: () => Promise<void>;
}

/**
 * Configuration for Level 2 (Service Integration) tests
 */
export interface Level2TestConfig extends Level1TestConfig {
  /** Services to initialize (beyond Redis) */
  services?: string[];
  /** Additional setup function to run after Redis is ready */
  beforeSetup?: (redis: IsolatedRedisClient) => Promise<void>;
}

/**
 * Level 2 test setup result
 */
export interface Level2TestSetup {
  /** Isolated Redis client */
  redis: IsolatedRedisClient;
  /** Cleanup function to call in afterAll() */
  cleanup: () => Promise<void>;
  /** Service instances if configured */
  services?: Map<string, any>;
}

/**
 * Configuration for Level 3 (System E2E) tests
 */
export interface Level3TestConfig {
  /** Redis mode: 'memory' (in-memory) or 'dedicated' (separate instance) */
  redisMode?: 'memory' | 'dedicated';
  /** Blockchain fork to use (e.g., 'ethereum', 'bsc') */
  fork?: string;
  /** Services to start */
  services?: string[];
  /** Startup timeout in milliseconds */
  startupTimeout?: number;
}

/**
 * Level 3 test environment
 */
export interface Level3TestEnvironment {
  /** Redis client */
  redis: IsolatedRedisClient;
  /** Anvil fork manager (if fork configured) */
  anvil?: any;
  /** Running service instances */
  services: Map<string, any>;
  /** Cleanup function */
  cleanup: () => Promise<void>;
}

// =============================================================================
// Level 1: Component Integration
// =============================================================================

/**
 * Create a Level 1 (Component Integration) test setup.
 *
 * **Purpose**: Test internal component orchestration with real Redis, mock external APIs.
 *
 * **What to Use This For**:
 * - Testing multiple internal classes working together
 * - Business logic spanning multiple components
 * - Redis operations (streams, locks, caching)
 * - Data flow transformations
 *
 * **What to Mock**: External APIs (blockchain RPCs, price feeds, third-party services)
 * **What NOT to Mock**: Redis, internal services
 *
 * **Speed**: <30s per suite
 *
 * @example
 * ```typescript
 * import { createLevel1TestSetup } from '@arbitrage/test-utils';
 *
 * describe('[Level 1] CrossChainDetector Component Integration', () => {
 *   let setup: Level1TestSetup;
 *
 *   beforeAll(async () => {
 *     setup = await createLevel1TestSetup({
 *       testSuiteName: 'cross-chain-detector-component'
 *     });
 *   });
 *
 *   afterAll(async () => {
 *     await setup.cleanup();
 *   });
 *
 *   it('should store opportunity in real Redis', async () => {
 *     await setup.redis.xAdd('stream:opportunities', '*', {
 *       data: JSON.stringify({ token: 'WETH', profit: 100 })
 *     });
 *
 *     const messages = await setup.redis.xRead(
 *       'STREAMS', 'stream:opportunities', '0'
 *     );
 *
 *     expect(messages).toHaveLength(1);
 *   });
 * });
 * ```
 *
 * @param config - Level 1 test configuration
 * @returns Test setup with Redis client and cleanup function
 */
export async function createLevel1TestSetup(
  config: Level1TestConfig
): Promise<Level1TestSetup> {
  const redis = await createIsolatedRedisClient(
    config.testSuiteName,
    { url: config.redisUrl }
  );

  return {
    redis,
    cleanup: async () => {
      await cleanupTestRedis(redis);
    }
  };
}

// =============================================================================
// Level 2: Service Integration
// =============================================================================

/**
 * Create a Level 2 (Service Integration) test setup.
 *
 * **Purpose**: Test complete service behavior with real infrastructure, minimal mocking.
 *
 * **What to Use This For**:
 * - Testing full service lifecycle (start, process, stop)
 * - Redis Streams consumption patterns
 * - Distributed locking behavior
 * - State persistence and recovery
 * - Service-to-service communication
 *
 * **What to Mock**: External APIs where necessary (blockchain forks are expensive)
 * **What NOT to Mock**: Redis, internal message passing, state management
 *
 * **Speed**: <2min per suite
 *
 * @example
 * ```typescript
 * import { createLevel2TestSetup } from '@arbitrage/test-utils';
 *
 * describe('[Level 2] Coordinator Service Integration', () => {
 *   let setup: Level2TestSetup;
 *
 *   beforeAll(async () => {
 *     setup = await createLevel2TestSetup({
 *       testSuiteName: 'coordinator-service',
 *       beforeSetup: async (redis) => {
 *         // Initialize test data in Redis before service starts
 *         await redis.set('config:leader-ttl', '30');
 *       }
 *     });
 *   });
 *
 *   afterAll(async () => {
 *     await setup.cleanup();
 *   });
 *
 *   it('should elect leader using real Redis locks', async () => {
 *     const coordinator1 = new CoordinatorService({ redis: setup.redis });
 *     const coordinator2 = new CoordinatorService({ redis: setup.redis });
 *
 *     await Promise.all([coordinator1.start(), coordinator2.start()]);
 *
 *     // Real Redis lock atomicity
 *     expect(coordinator1.isLeader !== coordinator2.isLeader).toBe(true);
 *   });
 * });
 * ```
 *
 * @param config - Level 2 test configuration
 * @returns Test setup with Redis, services, and cleanup function
 */
export async function createLevel2TestSetup(
  config: Level2TestConfig
): Promise<Level2TestSetup> {
  const redis = await createIsolatedRedisClient(
    config.testSuiteName,
    { url: config.redisUrl }
  );

  // Run optional pre-setup
  if (config.beforeSetup) {
    await config.beforeSetup(redis);
  }

  // TODO: Add service initialization if configured
  const services = new Map<string, any>();

  return {
    redis,
    services,
    cleanup: async () => {
      // Cleanup services first
      for (const [name, service] of services.entries()) {
        if (service.stop && typeof service.stop === 'function') {
          try {
            await service.stop();
          } catch (error) {
            console.warn(`Failed to stop service ${name}:`, error);
          }
        }
      }

      // Then cleanup Redis
      await cleanupTestRedis(redis);
    }
  };
}

// =============================================================================
// Level 3: System E2E Integration
// =============================================================================

/**
 * Create a Level 3 (System E2E) test setup.
 *
 * **Purpose**: Test complete user journeys with all real dependencies.
 *
 * **What to Use This For**:
 * - Critical end-to-end workflows
 * - Deployment validation
 * - Production readiness verification
 * - Cross-service integration flows
 *
 * **What to Mock**: Minimize mocking - use Anvil forks for blockchain
 * **What NOT to Mock**: Redis, internal services, core infrastructure
 *
 * **Speed**: <5min per suite
 *
 * @example
 * ```typescript
 * import { createLevel3TestSetup } from '@arbitrage/test-utils';
 *
 * describe('[Level 3] Arbitrage Execution Flow E2E', () => {
 *   let env: Level3TestEnvironment;
 *
 *   beforeAll(async () => {
 *     env = await createLevel3TestSetup({
 *       redisMode: 'memory',
 *       fork: 'ethereum',
 *       services: ['coordinator', 'detector', 'execution-engine'],
 *       startupTimeout: 60000
 *     });
 *   }, 60000);
 *
 *   afterAll(async () => {
 *     await env.cleanup();
 *   });
 *
 *   it('should execute arbitrage end-to-end', async () => {
 *     // Set up price discrepancy
 *     await env.anvil.setPrice('UNISWAP_WETH_USDC', 2500);
 *     await env.anvil.setPrice('SUSHISWAP_WETH_USDC', 2550);
 *
 *     // Wait for detection
 *     const detector = env.services.get('detector');
 *     const opportunity = await detector.waitForOpportunity({ timeout: 30000 });
 *
 *     expect(opportunity.profitPercentage).toBeGreaterThan(1);
 *   });
 * });
 * ```
 *
 * @param config - Level 3 test configuration
 * @returns Test environment with Redis, Anvil, services, and cleanup
 */
export async function createLevel3TestSetup(
  config: Level3TestConfig = {}
): Promise<Level3TestEnvironment> {
  // Start Redis
  const redis = await createIsolatedRedisClient('level3-e2e-test');

  // TODO: Start Anvil fork if configured
  const anvil: any = undefined;
  if (config.fork) {
    // anvil = await startAnvilFork(config.fork);
  }

  // TODO: Start services if configured
  const services = new Map<string, any>();

  return {
    redis,
    anvil,
    services,
    cleanup: async () => {
      // Stop services
      for (const [name, service] of services.entries()) {
        if (service.stop && typeof service.stop === 'function') {
          try {
            await service.stop();
          } catch (error) {
            console.warn(`Failed to stop service ${name}:`, error);
          }
        }
      }

      // Stop Anvil
      if (anvil?.stop) {
        try {
          await anvil.stop();
        } catch (error) {
          console.warn('Failed to stop Anvil:', error);
        }
      }

      // Cleanup Redis
      await cleanupTestRedis(redis);
    }
  };
}

// =============================================================================
// Helper Utilities
// =============================================================================

/**
 * Wait for a condition to be true with timeout.
 *
 * Useful for waiting for async operations in integration tests.
 *
 * @example
 * ```typescript
 * await waitFor(() => coordinator.getProcessedCount() > 0, 5000);
 * ```
 *
 * @param condition - Function that returns true when condition is met
 * @param timeoutMs - Maximum time to wait in milliseconds
 * @param intervalMs - Check interval in milliseconds
 * @throws Error if timeout is reached
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number = 5000,
  intervalMs: number = 100
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const result = await condition();
    if (result) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timeout waiting for condition after ${timeoutMs}ms`);
}

/**
 * Assert that Redis client is connected.
 *
 * Useful for debugging test setup issues.
 *
 * @param redis - Redis client to check
 * @throws Error if Redis is not connected
 */
export function assertRedisConnected(redis: IsolatedRedisClient): void {
  if (!redis.isOpen) {
    throw new Error(
      'Redis client is not connected. ' +
      'Ensure createIsolatedRedisClient was called in beforeAll()'
    );
  }
}

// =============================================================================
// Deprecation Helpers (for migration from mocks)
// =============================================================================

/**
 * @deprecated Use createLevel1TestSetup() instead of MockRedisClient.
 *
 * This function exists to help identify tests that still use mocks.
 * Replace with:
 *
 * ```typescript
 * const setup = await createLevel1TestSetup({ testSuiteName: 'my-test' });
 * // Use setup.redis instead of mockRedis
 * ```
 */
export function createMockRedis(): never {
  throw new Error(
    'MockRedisClient is deprecated. Use createLevel1TestSetup() with real Redis instead. ' +
    'See docs/architecture/TEST_ARCHITECTURE.md - Three-Level Integration Testing'
  );
}
