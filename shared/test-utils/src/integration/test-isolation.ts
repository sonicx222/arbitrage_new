/**
 * Test Isolation Utilities
 */

import { getRedisPool, IsolatedRedisClient } from './redis-pool';

export interface IsolatedTestContext {
  redis: IsolatedRedisClient;
  testId: string;
  cleanup: () => Promise<void>;
}

function generateTestId(testName: string): string {
  const sanitized = testName.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 32);
  return `${sanitized}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function createIsolatedContext(testName: string): Promise<IsolatedTestContext> {
  const pool = getRedisPool();
  const testId = generateTestId(testName);
  const redis = await pool.getIsolatedConnection(testId);

  return {
    redis,
    testId,
    cleanup: async () => {
      await redis.cleanup();
    },
  };
}

export function withIsolation(
  testFn: (ctx: IsolatedTestContext) => Promise<void>
): () => Promise<void> {
  return async () => {
    const ctx = await createIsolatedContext('isolated-test');
    try {
      await testFn(ctx);
    } finally {
      await ctx.cleanup();
    }
  };
}

export async function createParallelContexts(
  count: number,
  baseName: string
): Promise<IsolatedTestContext[]> {
  const createPromises = Array.from({ length: count }, (_, i) =>
    createIsolatedContext(`${baseName}_${i}`)
  );
  return Promise.all(createPromises);
}

export async function cleanupContexts(contexts: IsolatedTestContext[]): Promise<void> {
  await Promise.all(contexts.map(ctx => ctx.cleanup()));
}
