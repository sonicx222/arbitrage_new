/**
 * Redis Test Helper for Test Isolation
 *
 * Provides isolated Redis database instances for test suites to prevent
 * key collisions and test interference.
 *
 * ## Usage
 *
 * ```typescript
 * import { createIsolatedRedisClient, cleanupTestRedis } from '@arbitrage/test-utils';
 *
 * describe('MyTest', () => {
 *   let redis;
 *
 *   beforeAll(async () => {
 *     redis = await createIsolatedRedisClient('MyTest');
 *   });
 *
 *   afterAll(async () => {
 *     await cleanupTestRedis(redis);
 *   });
 *
 *   it('should work with isolated Redis', async () => {
 *     await redis.set('key', 'value');
 *     // This key won't collide with other test suites
 *   });
 * });
 * ```
 *
 * @see Task 2.2: Test Isolation Improvements
 * @see ADR-009: Test Architecture
 */

import Redis from 'ioredis';

// =============================================================================
// Types
// =============================================================================

/**
 * Extended Redis client type with database information.
 * Uses ioredis (consolidating from dual redis/ioredis dependency).
 */
export interface IsolatedRedisClient extends Redis {
  /** The isolated database number */
  __testDatabase?: number;
  /** The test suite name */
  __testSuiteName?: string;
  /**
   * Compatibility property: returns true if the client is connected.
   * Mirrors the node-redis v4 `isOpen` property for backward compatibility
   * with code that checks `redis.isOpen`.
   */
  isOpen?: boolean;
}

// =============================================================================
// State Management
// =============================================================================

/**
 * Mapping of test suite names to their assigned database numbers.
 */
const testSuiteDatabases = new Map<string, number>();

/**
 * Counter for assigning unique database numbers.
 * Starts at 1 to avoid using database 0 (default).
 */
let nextDatabase = 1;

/**
 * Maximum Redis database number (default Redis config supports 0-15).
 */
const MAX_DATABASE = 15;

// =============================================================================
// Public API
// =============================================================================

/**
 * Get an isolated Redis database number for a test suite.
 *
 * Each test suite gets its own database number to prevent key collisions.
 * The same suite always gets the same database number within a test run.
 *
 * @param testSuite - Unique identifier for the test suite (e.g., class name)
 * @returns Database number (1-15)
 *
 * @example
 * const db = getIsolatedRedisDatabase('MyTestSuite');
 * // db = 1 (first test suite)
 */
export function getIsolatedRedisDatabase(testSuite: string): number {
  // Return existing assignment if already allocated
  if (testSuiteDatabases.has(testSuite)) {
    return testSuiteDatabases.get(testSuite)!;
  }

  // Allocate new database
  const database = nextDatabase;

  // Wrap around if we exceed max databases
  // This is a safety measure; in practice, we shouldn't exceed 15 concurrent test suites
  if (nextDatabase >= MAX_DATABASE) {
    console.warn(
      `[RedisTestHelper] Database limit reached (${MAX_DATABASE}). ` +
      `Wrapping around - some test suites may share databases.`
    );
    nextDatabase = 1;
  } else {
    nextDatabase++;
  }

  testSuiteDatabases.set(testSuite, database);

  return database;
}

/**
 * Parse a Redis URL into host, port, and optional password.
 */
function parseRedisUrl(url: string): { host: string; port: number; password?: string } {
  const urlObj = new URL(url);
  return {
    host: urlObj.hostname || 'localhost',
    port: parseInt(urlObj.port, 10) || 6379,
    password: urlObj.password || undefined,
  };
}

/**
 * Create an isolated Redis client for a test suite.
 *
 * The client connects to a dedicated Redis database to prevent
 * key collisions with other test suites.
 *
 * @param testSuite - Unique identifier for the test suite
 * @param options - Additional Redis client options
 * @returns Connected Redis client with isolated database
 *
 * @example
 * const redis = await createIsolatedRedisClient('MyTestSuite');
 * await redis.set('key', 'value'); // In isolated database
 * await cleanupTestRedis(redis);
 */
export async function createIsolatedRedisClient(
  testSuite: string,
  options: {
    url?: string;
    connectTimeout?: number;
  } = {}
): Promise<IsolatedRedisClient> {
  const database = getIsolatedRedisDatabase(testSuite);
  const url = options.url || process.env.REDIS_URL || 'redis://localhost:6379';
  const { host, port, password } = parseRedisUrl(url);

  const client = new Redis({
    host,
    port,
    password,
    db: database,
    connectTimeout: options.connectTimeout ?? 5000,
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      if (times > 3) {
        return null; // Stop retrying
      }
      return Math.min(times * 100, 500);
    },
    lazyConnect: true, // We'll connect explicitly below
  }) as IsolatedRedisClient;

  // Store metadata on client
  client.__testDatabase = database;
  client.__testSuiteName = testSuite;

  // Connect explicitly
  await client.connect();

  // Define isOpen as a getter for backward compatibility
  Object.defineProperty(client, 'isOpen', {
    get() {
      return client.status === 'ready';
    },
    configurable: true,
  });

  // Flush the database to ensure clean state
  await client.flushdb();

  return client;
}

/**
 * Clean up an isolated Redis client after tests.
 *
 * Flushes the database to clean up test data, then disconnects.
 *
 * @param client - The Redis client to clean up
 *
 * @example
 * afterAll(async () => {
 *   await cleanupTestRedis(redis);
 * });
 */
export async function cleanupTestRedis(client: IsolatedRedisClient): Promise<void> {
  if (!client) return;

  try {
    // Check if client is connected (ioredis status check)
    if (client.status === 'ready') {
      // Flush the test database
      await client.flushdb();
      // Disconnect
      await client.quit();
    }
  } catch (error) {
    // Log but don't throw - cleanup should be best-effort
    console.warn('[RedisTestHelper] Cleanup error:', error);
  }
}

/**
 * Reset the database counter and clear all suite mappings.
 *
 * Call this at the start of a test run to ensure clean state.
 * Typically used in global setup.
 */
export function resetDatabaseCounter(): void {
  testSuiteDatabases.clear();
  nextDatabase = 1;
}

/**
 * Get current database assignments (for debugging).
 */
export function getDatabaseAssignments(): Map<string, number> {
  return new Map(testSuiteDatabases);
}

// =============================================================================
// Jest Integration Helpers
// =============================================================================

/**
 * Create a Jest setup/teardown pair for isolated Redis.
 *
 * @param testSuiteName - Name of the test suite
 * @returns Object with setup and teardown functions
 *
 * @example
 * const { redis, setup, teardown } = createRedisTestSetup('MyTests');
 * beforeAll(setup);
 * afterAll(teardown);
 */
export function createRedisTestSetup(testSuiteName: string) {
  let client: IsolatedRedisClient | null = null;

  return {
    get redis(): IsolatedRedisClient | null {
      return client;
    },
    async setup(): Promise<IsolatedRedisClient> {
      client = await createIsolatedRedisClient(testSuiteName);
      return client;
    },
    async teardown(): Promise<void> {
      if (client) {
        await cleanupTestRedis(client);
        client = null;
      }
    }
  };
}
